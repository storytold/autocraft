// Harness wording for the user-local inference mode. A remote call's prompt is rendered when it is queued, before
// anyone has claimed it, so the phrases that name one harness's tools, and the fixed sandbox paths, are carried as marked
// spans and filled in when a helper claims the call and its harness and path root are known (src/remote/calls.ts
// `forHarness`). For `claude` without a root the filled text is exactly the server's text. No Node imports:
// src/prompts/index.ts uses this.
import type { HarnessId } from "../remote/protocol.ts";

/** Marks a span. Untrusted text has the character removed (`stripMarks`) before it joins a prompt, so data cannot hold a marker. */
const MARK = "\u0001";

/** Text with every marker character removed. */
export const stripMarks = (text: string): string => text.replaceAll(MARK, "");

/**
 * Codex runs with its shell turned off: its sandbox would let commands read the login, so it reads through the helper's
 * read-only file tools on the same paths (worker/autocraft.mjs, `files` MCP server).
 */
const FILES = "the file tools mcp__files__read_file, mcp__files__grep and mcp__files__glob";

/** Each phrase of the Claude prompts that names a Claude tool, with what the other harnesses read instead. */
const PHRASES: { id: string; claude: string; codex: string }[] = [
  { id: "use", claude: "use Read, Grep and Glob", codex: `use ${FILES}` },
  { id: "Use", claude: "Use Grep, Glob and Read", codex: `Use ${FILES}` },
  { id: "list", claude: "(Grep, Glob, Read)", codex: "(mcp__files__grep, mcp__files__glob, mcp__files__read_file)" },
  { id: "with-read", claude: "with Read and Grep", codex: "with mcp__files__read_file and mcp__files__grep" },
  { id: "with-grep", claude: "with Grep and Glob", codex: "with mcp__files__grep and mcp__files__glob" },
  { id: "read-it", claude: "Read it with Read", codex: "Read it with mcp__files__read_file" },
  { id: "image", claude: "open each one with Read", codex: "open each one with the view_image tool" },
  { id: "list-files", claude: "list files with Glob", codex: "list files with mcp__files__glob" },
  { id: "list-them", claude: "list them with Glob", codex: "list them with mcp__files__glob" },
  // The explorer subagent exists only in Claude Code; the main call searches the workspace itself.
  { id: "explorer", claude: " For a broad search across them, use the Agent tool with subagent_type workspace-search: it is cheaper than reading many files yourself and reports file paths.", codex: " For a broad search across them, use mcp__files__grep with a narrow pattern and path, and read only the files it names." },
];

/** MCP tool names as each harness shows them to the model (Codex: codex-rs/codex-mcp/src/tools.rs). */
const MCP_NAME: Record<HarnessId, (server: string, tool: string) => string> = {
  claude: (server, tool) => `mcp__${server}__${tool}`,
  codex: (server, tool) => `mcp__${server}__${tool}`,
};

const MCP_TOOL = /mcp__([a-z][a-z0-9-]*)__([a-z][a-z0-9_]*)/g;

/**
 * The fixed sandbox paths a prompt names (src/sandbox/command.ts, agents.ts), each by its marker id. A helper whose sandbox
 * cannot place them at the filesystem root (macOS) claims with a path root, and they are filled in below it. Not the
 * reference folder: the user-local mode has none, and the rule never to name it keeps its usual wording.
 */
const SANDBOX_PATHS: Record<string, string> = { "repo-docs": "/repo-docs", repos: "/repos", repo: "/repo", agents: "/agents.json", mcp: "/mcp.json" };
/** A fixed path as a whole path or the start of one: not part of a longer name, a URL, a relative path or a closing tag (`</repo>`). */
const SANDBOX_PATH = /(?<![\w./<-])\/(repo-docs|repos|repo|agents\.json|mcp\.json)(?![\w-])/g;
const PATH_ID: Record<string, string> = Object.fromEntries(Object.entries(SANDBOX_PATHS).map(([id, p]) => [p.slice(1), id]));

/** Trusted prompt text with every harness phrase, MCP tool name and fixed sandbox path replaced by its marker. */
export function markHarness(text: string): string {
  let out = text;
  for (const p of PHRASES) out = out.split(p.claude).join(`${MARK}${p.id}${MARK}`);
  out = out.replace(MCP_TOOL, (_, server: string, tool: string) => `${MARK}mcp:${server}:${tool}${MARK}`);
  return out.replace(SANDBOX_PATH, (_, name: string) => `${MARK}path:${PATH_ID[name]}${MARK}`);
}

/**
 * The ranges [from, to) of trusted prompt text that markHarness replaces (harness phrases, MCP tool names, fixed sandbox
 * paths), in order, overlapping ones joined. A prompt keeps them in locked blocks, so an edit cannot change their wording.
 */
export function harnessSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const p of PHRASES) for (let i = text.indexOf(p.claude); i >= 0; i = text.indexOf(p.claude, i + p.claude.length)) spans.push([i, i + p.claude.length]);
  for (const re of [MCP_TOOL, SANDBOX_PATH]) for (const m of text.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  spans.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && s[0] < last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/**
 * The text a harness reads: every marker replaced by that harness's wording, and each marked sandbox path by the same path
 * below `root` (or the path itself without one); anything else between marks is left alone.
 */
export function fillHarness(text: string, harness: HarnessId, root = ""): string {
  if (!text.includes(MARK)) return text;
  return text.replace(/\u0001([\w:-]+)\u0001/g, (whole, id: string) => {
    const path = /^path:([\w-]+)$/.exec(id);
    if (path) return SANDBOX_PATHS[path[1]!] !== undefined ? `${root}${SANDBOX_PATHS[path[1]!]}` : whole;
    const mcp = /^mcp:([a-z][a-z0-9-]*):([a-z][a-z0-9_]*)$/.exec(id);
    if (mcp) return MCP_NAME[harness](mcp[1]!, mcp[2]!);
    const p = PHRASES.find((x) => x.id === id);
    return p ? p[harness] : whole;
  });
}

/** A path root a helper may claim with: absolute, plain characters, no `.` or `..` component, no trailing slash. */
export const ROOT_PATH = /^(?:\/[A-Za-z0-9._+@-]+){1,30}$/;
export const validRoot = (root: string): boolean => root.length <= 200 && ROOT_PATH.test(root) && !root.split("/").some((c) => c === "." || c === "..");

/**
 * `claude` arguments for a helper's path root: the values of --add-dir, --agents and --mcp-config, and the Read rules of
 * --allowedTools, when they are fixed sandbox paths. Exact tokens only: every other argument, the system prompt included
 * (its paths are marked), stays as it is.
 */
export function rootArgs(args: string[], root: string): string[] {
  if (!root) return args;
  const fixed = new Set([...Object.values(SANDBOX_PATHS), "/reference"]);
  const under = (p: string): string | null => {
    const top = `/${p.split("/")[1] ?? ""}`;
    return fixed.has(top) && !p.split("/").some((c) => c === "..") ? `${root}${p}` : null;
  };
  return args.map((a, i) => {
    const prev = args[i - 1];
    if (prev === "--add-dir" || prev === "--agents" || prev === "--mcp-config") return under(a) ?? a;
    if (prev === "--allowedTools") return a.split(",").map((t) => { const m = /^Read\(\/(\/[^()]*)\/\*\*\)$/.exec(t); const r = m ? under(m[1]!) : null; return r ? `Read(/${r}/**)` : t; }).join(",");
    return a;
  });
}
