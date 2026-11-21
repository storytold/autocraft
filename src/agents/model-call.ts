// One model call on the compatible provider (src/agents/compatible.ts): the prompt text, then as many turns as the
// model needs with the read-only file tools, until it answers. A call without a checkout gets no tools: one request,
// one answer, exactly as a plain `claude -p` call.
//
// The loop is ours, not a harness's, so everything it does is in this file: which tools exist, how many turns, how
// long it may take, and what the model sees when it asks for something the provider does not offer (the workspace
// explorer, the item tools, images).
import { throwIfHalted } from "./call.ts";
import { CompatibleError, chat, type ChatMessage, type ChatUsage, type CompatibleConfig } from "./compatible.ts";
import { globFiles, grepFiles, readText, toolDefs, ToolError, type ToolRoot } from "./filetools.ts";

/** The system message of a sandboxed call: the Claude CLI supplies tool guidance, this replaces it. Fixed text, so a
 * provider that caches prefixes can cache it. */
export const TOOL_SYSTEM = `You are an autonomous software engineer working on one repository. You read files with the tools and cannot write files, run commands, ask questions or reach the network. Check every claim against the files before you answer. When you have the answer, reply exactly in the format the message asks for, with nothing else.`;

export type CheckCall = (input: unknown) => Promise<{ text: string; isError?: boolean }>;

export type CompatibleCall = {
  cfg: CompatibleConfig;
  /** The provider's model id (already mapped from the prompt's tier). */
  model: string;
  /** The fixed system text; null for a sandboxed call, which gets TOOL_SYSTEM. */
  system: string | null;
  /** What Claude would read on stdin. */
  stdin: string;
  /** The turn limit of a sandboxed call; null for a call without tools. */
  maxTurns: number | null;
  roots: ToolRoot[];
  /** The build tool, when the stage gives one to this call (src/checktool). */
  check?: CheckCall;
  /** The whole call's time limit, in ms (the prompt's, plus the build tool's when it has one). */
  timeoutMs: number;
  onProgress?: (line: string) => void;
  /** For tests and a second base URL; every other caller uses the configured one. */
  base?: string;
};

export type CompatibleReply = { text: string; usage: ChatUsage; turns: number; model: string };

const zero = (): ChatUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const add = (a: ChatUsage, b: ChatUsage): ChatUsage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

/** One line for the run's progress: the tool and what it was asked for, cut short. */
function progressLine(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as { file_path?: unknown; pattern?: unknown; command?: unknown };
  const what = typeof a.file_path === "string" ? a.file_path : typeof a.pattern === "string" ? a.pattern : typeof a.command === "string" ? a.command : "";
  const text = `${name}${what ? ` ${what}` : ""}`;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/**
 * Runs one tool call. A tool the provider does not offer answers with what to use instead, never with a crash: the
 * workspace explorer and the item tools are Claude-sandbox features, and the model must be able to carry on without them.
 */
async function runTool(name: string, raw: string, roots: ToolRoot[], check: CheckCall | undefined): Promise<{ text: string; isError: boolean }> {
  let args: unknown;
  try { args = raw.trim() ? JSON.parse(raw) : {}; } catch { return { text: `${name}: the arguments are not JSON`, isError: true }; }
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "Read": return { text: readText(roots, a), isError: false };
      case "Grep": return { text: await grepFiles(roots, a), isError: false };
      case "Glob": return { text: globFiles(roots, a), isError: false };
      case "Agent": return { text: "The Agent tool is not available with this provider: search the files with Grep (a narrow pattern and a path) and list them with Glob.", isError: true };
      case "mcp__build__check":
        if (!check) return { text: "The check tool is not available on this call.", isError: true };
        {
          const out = await check(a);
          return { text: out.text, isError: out.isError === true };
        }
      default: return { text: `There is no tool named ${name}. The tools are Read, Grep, Glob${check ? " and mcp__build__check" : ""}.`, isError: true };
    }
  } catch (e) {
    // A tool error, and a file system error the model can act on (a file that vanished, a permission): the model reads the
    // reason and carries on. Anything else is a bug here and fails the call.
    if (e instanceof ToolError || typeof (e as { code?: unknown }).code === "string") return { text: (e as Error).message, isError: true };
    throw e;
  }
}

/**
 * One call: a plain prompt is one request; a sandboxed prompt may take several turns of tool calls. Throws a
 * CompatibleError (the key or account is `account`, everything else is one failed call) or the cancellation of a halt.
 */
export async function runCompatibleCall(o: CompatibleCall): Promise<CompatibleReply> {
  const deadline = Date.now() + o.timeoutMs;
  const tools = o.maxTurns === null ? [] : toolDefs({ check: o.check !== undefined });
  const system = o.system?.trim() ? o.system : o.maxTurns === null ? null : TOOL_SYSTEM;
  const messages: ChatMessage[] = [...(system === null ? [] : [{ role: "system" as const, content: system }]), { role: "user", content: o.stdin }];
  let usage = zero(), model = o.model;
  const turns = o.maxTurns ?? 1;
  /** A failed call that still reports the tokens its earlier turns spent. */
  const fail: (message: string) => never = (message) => { throw withUsage(new CompatibleError("call", message), usage); };
  for (let turn = 1; turn <= turns; turn++) {
    throwIfHalted("waiting for the model");
    const left = deadline - Date.now();
    if (left <= 0) fail(`the call ran past its ${Math.round(o.timeoutMs / 1000)} s limit`);
    let r: Awaited<ReturnType<typeof chat>>;
    try { r = await chat(o.cfg, { model: o.model, messages, timeoutMs: left, ...(tools.length && { tools }) }, o.base); } catch (e) {
      if (e instanceof CompatibleError) withUsage(e, usage);
      throw e;
    }
    usage = add(usage, r.usage);
    model = r.model;
    if (!r.toolCalls.length) {
      if (r.content === null || !r.content.trim()) fail("the reply is empty");
      return { text: r.content, usage, turns: turn, model };
    }
    if (turn === turns) fail(`the call used all ${turns} turns without an answer`);
    messages.push({ role: "assistant", content: r.content, toolCalls: r.toolCalls });
    for (const c of r.toolCalls) {
      o.onProgress?.(progressLine(c.name, safeJson(c.arguments)));
      const out = await runTool(c.name, c.arguments, o.roots, o.check);
      messages.push({ role: "tool", toolCallId: c.id, content: out.isError ? `Error: ${out.text}` : out.text });
    }
  }
  throw withUsage(new CompatibleError("call", "the model gave no answer"), usage);
}

/** The error, carrying what the call had spent so far. */
function withUsage(e: CompatibleError, usage: ChatUsage): CompatibleError {
  if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite) e.usage = usage;
  return e;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
