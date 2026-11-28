// Runs the classifiers: Jev (one `jev ask` per item) and Haiku (batches through `claude -p`).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ItemRef } from "../../web/src/api/types.ts";
import { loadLiveConfig } from "../data/control/index.ts";
import { askJevCloudflare, jevCloudflareConfig } from "../agents/jev-cloudflare.ts";
import { JEV_UNREADABLE_SUMMARY, jevAvailable, jevEnv, jevFailure, markJevUnavailable, markJevUnreadable, markJevWorking, jevStatus } from "../agents/jev.ts";
import { allocation, itemRepos, NoTakerError, poolRoom, repoBatches, runAsUnit, type PoolRoom, type PoolUnit, startJevRun, isHalt } from "../agents/call.ts";
import { type KeptSession, type SessionAsk } from "../prepush/resume.ts";
import { finishRun } from "../agents/runs.ts";
import { fixTurnMessage, mergeFixFields, needsFixTurn, type Lint, type LintProblem } from "../replylint.ts";
import { scrubError } from "../agents/text.ts";
import { hasFixedCredential, scrub } from "../runner/scrub.ts";
import { itemTools } from "../itemtools/index.ts";
import { CHECK_SERVER } from "../checktool/bridge.ts";
import type { CheckTool } from "../checktool/index.ts";
import { CHECK_MAX_WALL_MS } from "../core/rules.ts";
import { agentsDefinition, MCP_PATH } from "../sandbox/agents.ts";
import { callLevel } from "../remote/level.ts";
import { tierOfModel } from "../remote/mode.ts";
import { awaitCall, enqueueCall, REFUSED_PREFIX, type Outcome } from "../remote/calls.ts";
import { bundleMounts, checkoutCommit, REFERENCE_SERVER } from "../remote/bundle.ts";
import { repoDocsFor, repoOfCheckout } from "../sandbox/repo-docs.ts";
import { defaultWorkspace } from "../sandbox/workspace.ts";
import { runModelStep } from "../agents/step.ts";
import { CLASSIFY_HAIKU, CLASSIFY_JEV, type ClassifyAnswer, type JevImpact } from "../agents/steps.ts";
import type { AreaAnswer } from "../areas/parse.ts";
import { CLAUDE_PROMPTS, GUIDANCE_PROMPTS, JEV_ARGS, JEV_USD_PER_INPUT_TOKEN, JEV_PROMPTS, claudeArgs, claudeParts, jevVersionOf, renderAreaJev, renderJev, resolvedTemplate, withoutTaskBudget, type ClassifyExtras, type ClaudeInput, type ClaudePromptId, type JevPromptId } from "../prompts/index.ts";
import { stripMarks } from "../prompts/harness.ts";
import type { DupeAsk, DupePair } from "../dupes/pair.ts";
import { flagsOf, parseRef, refOf, type Item, type Verdict } from "./parse.ts";
import { wholeReplyJson } from "../core/reply-json.ts";
import { findSeq } from "../async-seq.ts";
import { NO_TAKER_SKIP, skipItem, unitRan } from "../runner/leases.ts";
import type { Db } from "../db/index.ts";
import { loadItems as loadMirrorItems, loadRepos } from "../data/mirror/index.ts";
import { keepEarlierUsage, loadRunsById, recordUsage, type UsageRow } from "../data/inference/index.ts";
import { saveJevChunk, saveVerdicts as saveVerdictRows, type JevFailed, type VerdictInput } from "../data/triage/index.ts";
import { ensurePrompts, guidanceOf } from "../data/prompts/index.ts";
import { loadCallPrompt } from "../data/runners/index.ts";
import { effect } from "../db/effects.ts";

export function loadRefs(file: string): { repo: string; number: number }[] {
  const out: { repo: string; number: number }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const r = parseRef(line);
    if (!r) throw new Error(`bad item line: ${line}`);
    out.push(r);
  }
  return out;
}

/** The items of `refs` as classify prompts see them, in the order of `refs`; throws for a ref that is not in the database. */
export async function loadItems(db: Db, refs: { repo: string; number: number }[]): Promise<Item[]> {
  const rows = await loadMirrorItems(db, refs, "text");
  return refs.map((r) => {
    const row = rows.get(`${r.repo}#${r.number}`);
    if (!row) throw new Error(`${refOf(r)} is not in the database`);
    return { repo: row.repo, number: row.number, kind: row.kind as Item["kind"], title: row.title ?? "", body: row.body ?? "",
      lines_changed: row.additions === null || row.deletions === null ? null : row.additions + row.deletions, files_changed: row.changed_files, author_association: row.author_association };
  });
}

type Proc = { code: number | null; stdout: string; stderr: string };
/** `env` is added to the process environment of the child, or with `exactEnv` is the child's whole environment. `onLine` gets each complete line of stdout as it arrives (the whole stdout is still returned). */
export type Runner = (cmd: string, args: string[], input: string, cwd?: string, timeoutMs?: number, env?: Record<string, string>, onLine?: (line: string) => Promise<void>, exactEnv?: boolean) => Promise<Proc>;

export function exec(cmd: string, args: string[], input: string, cwd?: string, timeoutMs = 600_000, env?: Record<string, string>, onLine?: (line: string) => void, exactEnv = false): Promise<Proc> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, windowsHide: true, ...(env && { env: exactEnv ? env : { ...process.env, ...env } }) });
    let stdout = "", stderr = "";
    let partial = "";
    p.stdout.on("data", (d) => {
      stdout += d;
      if (!onLine) return;
      partial += d;
      const lines = partial.split("\n");
      partial = lines.pop()!;
      for (const l of lines) try { onLine(l); } catch { /* progress is best effort */ }
    });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

export const POOL_POLL_MS = 500;

/** Most items the pushing and verifying steps run at once, whatever the model queue has free. */
export const POOL_MAX = { fixup: 3, cifix: 3, mainfix: 2, verify: 4, verifyCollect: 4 } as const;

export type PoolOptions = {
  /** Run the first job alone and the rest after it returns, so the rest read the prompt cache the first one wrote. */
  first?: boolean;
  /** How long to wait before asking `width` again when nothing finished (default POOL_POLL_MS); for a PoolRoom, how often to read whether the room changed (PoolRoom.changed; default allocation.pollMs). */
  pollMs?: number;
  /** Upper bound on running jobs, also when `width` is a function. */
  max?: number;
  /** Told the index of each job a PoolRoom left unstarted (no Task Runner may take it) when the pool ends, and of each job whose model call was withdrawn for lack of a taker (NoTakerError). */
  skipped?: (i: number) => void;
  /** Where the skip of a job a PoolRoom left unstarted is logged (default console.log, the job's log). */
  log?: (line: string) => void;
};

/**
 * Runs the jobs with at most `width` at once. A function instead of a number is asked before each start how many more jobs
 * may start now, given the index of the job that would start next; it is asked again whenever a job ends or after the poll
 * time. When none of the pool's jobs is running, one starts regardless, so the call itself waits for a slot or reports that no
 * account is enabled.
 *
 * A PoolRoom (poolRoom: the model queue's room for each job's repos) starts the first job in order that has room, so a job
 * whose repos have no room does not hold back later ones. It reads the room when a job ends or the room may have changed
 * (PoolRoom.changed), so a pool whose calls wait long for a Task Runner reads the room only when the queue or the Task Runners
 * change. A reading does not yet count the calls of jobs still preparing theirs (running, no call queued: PoolUnit), and the
 * jobs started after it: both are taken off it, so a room of N starts N jobs. The jobs counted are taken off the room of every
 * repo: the Task Runner a call will take is not known, and the runners of one repo may serve others (the runner's startJobs
 * counts its starts the same way); a fresh reading counts queued calls by their takers again. A PoolRoom whose units may
 * finish without a model call (`mayNotCall`) starts jobs up to `max` whatever the room: a call one of them makes waits in the
 * model queue. When none has room and none runs, the first job whose repos have a
 * Task Runner that may take them starts regardless; jobs no Task Runner may take never start, and once only they are left the
 * pool ends without them. Each is recorded as a skip for want of a taker (skipItem, NO_TAKER_SKIP), like a withdrawn call, so a
 * step job that only left such units counts as idle until the Task Runners change (src/runner/autopilot.ts unchangedSinceIdle).
 * With `first`, the first job that has such a Task Runner runs alone first.
 * A job whose model call was withdrawn because no Task Runner could take it (NoTakerError) is skipped the same way; the others go on.
 *
 * The first failure is thrown once the running jobs have ended.
 */
export async function pool<T>(jobs: (() => Promise<T>)[], width: number | ((next: number) => Promise<number>) | PoolRoom, opts: PoolOptions = {}): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  const running = new Set<Promise<void>>();
  // Indices of the jobs not started yet, in order; a PoolRoom may start them out of order.
  const pending = jobs.map((_, i) => i);
  let failed: { e: unknown } | null = null;
  // The running jobs' units, and the room the last reading left: its value minus the jobs started or preparing since.
  const units = new Set<PoolUnit>();
  let fresh = true, used = 0;
  const launch = (i: number): Promise<void> => {
    pending.splice(pending.indexOf(i), 1);
    const u: PoolUnit = { called: false };
    units.add(u);
    const p: Promise<void> = runAsUnit(u, jobs[i]!).then((r) => { results[i] = r; unitRan(); }, (e) => { if (e instanceof NoTakerError) opts.skipped?.(i); else { unitRan(); failed ??= { e }; } }).finally(() => { running.delete(p); units.delete(u); });
    running.add(p);
    return p;
  };
  const roomy = typeof width === "object" ? width : null;
  // The jobs left unstarted once the pool ends: only those no Task Runner may take (a failure throws first).
  const leftUntaken = (): void => {
    for (const x of pending) {
      if (roomy?.untaken) {
        const what = roomy.untaken(x) || `unit ${x + 1}`;
        skipItem(`${NO_TAKER_SKIP}${what}`, opts.log ?? console.log, "no Task Runner takes it", what);
      }
      opts.skipped?.(x);
    }
  };
  const takenBy = async (i: number): Promise<boolean> => !roomy || await roomy.taker(i);
  if (opts.first && jobs.length > 1) {
    roomy?.round();
    const i = await findSeq(pending, takenBy);
    if (i === undefined) { leftUntaken(); return results; }
    await launch(i);
  }
  while (pending.length && !failed) {
    const free = (opts.max ?? Infinity) - running.size;
    if (typeof width === "object") {
      if (fresh) {
        width.round();
        fresh = false;
        used = [...units].filter((u) => !u.called).length;
      }
      const i = free <= 0 ? undefined : width.mayNotCall ? pending[0] : await findSeq(pending, async (x) => await width.room(x) - used > 0);
      if (i !== undefined) { used++; launch(i); continue; }
      if (!running.size) {
        const any = await findSeq(pending, takenBy);
        if (any === undefined) break;
        used++;
        launch(any);
        continue;
      }
    } else {
      const room = typeof width === "number" ? width - running.size : Math.min(await width(pending[0]!), free);
      if (room > 0 || !running.size) {
        launch(pending[0]!);
        continue;
      }
    }
    if (roomy) {
      // With `max` jobs running only an end can start another; the room is not read then, so there is no reading to wait on.
      const full = running.size >= (opts.max ?? Infinity);
      const stop = new AbortController();
      try {
        await Promise.race(!full ? [...running, roomy.changed(opts.pollMs ?? allocation.pollMs, stop.signal)] : [...running]);
      } finally {
        stop.abort();
        fresh = true;
      }
    } else await Promise.race([...running, new Promise((r) => setTimeout(r, opts.pollMs ?? POOL_POLL_MS))]);
  }
  await Promise.all(running);
  if (failed) throw (failed as { e: unknown }).e;
  leftUntaken();
  return results;
}

const now = () => new Date().toISOString();

export type Usage = {
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null;
  /** Subagent use on other models (the explorer), one entry per model; the fields above count the called model only. */
  extra?: { model: string; usage: Usage }[];
};

const family = (m: string): string => /haiku/i.test(m) ? "haiku" : /sonnet/i.test(m) ? "sonnet" : /opus/i.test(m) ? "opus" : m;

type ModelUsage = Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;

/**
 * Usage of one `claude -p` result. With `modelUsage` (per model, subagents included) the called model's
 * tokens and cost go in the main fields and every other model in `extra`; without it, `usage` and
 * `total_cost_usd` are the called model's. `all` sums the tokens of every model, for the agent run.
 */
export function resultUsage(j: { usage?: Record<string, number>; total_cost_usd?: number; modelUsage?: ModelUsage }, model: string): { usage: Usage; all: { input: number; output: number; cacheRead: number; cacheWrite: number } } {
  const u = j.usage ?? {};
  const plain: Usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cost: j.total_cost_usd ?? null };
  const entries = Object.entries(j.modelUsage ?? {});
  if (!entries.length) return { usage: plain, all: { input: plain.input, output: plain.output, cacheRead: plain.cacheRead, cacheWrite: plain.cacheWrite } };
  const by = new Map<string, Usage>();
  for (const [m, x] of entries) {
    const f = family(m), cur = by.get(f) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    by.set(f, { input: cur.input + (x.inputTokens ?? 0), output: cur.output + (x.outputTokens ?? 0), cacheRead: cur.cacheRead + (x.cacheReadInputTokens ?? 0), cacheWrite: cur.cacheWrite + (x.cacheCreationInputTokens ?? 0), cost: (cur.cost ?? 0) + (x.costUSD ?? 0) });
  }
  const mine = family(model);
  const main = by.get(mine) ?? plain;
  by.delete(mine);
  const extra = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([m, usage]) => ({ model: m, usage }));
  const sum = (k: "input" | "output" | "cacheRead" | "cacheWrite") => main[k] + extra.reduce((a, e) => a + e.usage[k], 0);
  return { usage: { ...main, ...(extra.length > 0 && { extra }) }, all: { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") } };
}

/** Stores the verdicts of one chunk (`hash` is written as the row's input_hash); returns the refs stored. See triage.saveVerdicts. */
export async function saveVerdicts(db: Db, classifier: string, runId: string, list: readonly { v: Verdict; hash?: string }[]): Promise<Set<string>> {
  return await saveVerdictRows(db, verdictRows(classifier, runId, list));
}

function verdictRows(classifier: string, runId: string, list: readonly { v: Verdict; hash?: string }[]): VerdictInput[] {
  const at = now();
  return list.map(({ v, hash }) => {
    const [repo, num] = v.ref.split("#");
    return { repo: repo!, number: Number(num), classifier, run_id: runId, at, type_label: v.type_label ?? null, flags: flagsOf(v), reason: v.reason ?? null, probs: v.probs ?? null, input_hash: hash ?? null };
  });
}

export type { UsageRow };

export async function saveUsage(db: Db, runId: string, agent: string, stage: string, model: string, items: number, u: Usage, start: string, end: string): Promise<void> {
  await recordUsage(db, [{ runId, agent, stage, model, items, u, start, end }]);
}

export const saveUsages = recordUsage;

let runner: Runner = exec;

/** Tests swap the process runner for a fake; returns a function that restores the real one. */
export function setRunner(r: Runner): () => void {
  runner = r;
  return () => { runner = exec; };
}

/**
 * A short hash of the prompt text as it runs now (the code default or the active stored revision, src/prompts), so runs show
 * which wording they used. A Claude call with repository guidance records its own version (claudeParts).
 */
export function promptVersion(id: ClaudePromptId | JevPromptId): string {
  return id in CLAUDE_PROMPTS ? resolvedTemplate(id as ClaudePromptId).version : jevVersionOf(id as JevPromptId);
}

/** The repository whose guidance a call of a guidance prompt gets: its first item's, or a main-fix call's `repo@sha` ref. */
function guidanceRepo(input: readonly unknown[]): string | undefined {
  const r = refsOf(input)[0]?.repo;
  if (r) return r;
  const ref = (input[0] as { ref?: unknown } | undefined)?.ref;
  return typeof ref === "string" ? /^([A-Za-z0-9._-]+)@[0-9a-f]{7,40}$/.exec(ref)?.[1] : undefined;
}

/** Item refs of a prompt's input: items carry repo and number, review PRs a `repo#number` ref. A run without refs is shown to operators only. */
function refsOf(input: readonly unknown[]): ItemRef[] {
  const out: ItemRef[] = [];
  for (const x of input as { repo?: string; number?: number; ref?: string; a?: { number: number }; b?: { number: number }; items?: unknown[] }[]) {
    // A duplicate request: the item and each of its candidates.
    if (typeof x.repo === "string" && (x as { item?: { number: number } }).item && Array.isArray((x as { candidates?: unknown }).candidates)) {
      const ask = x as unknown as DupeAsk;
      out.push({ repo: ask.repo, number: ask.item.number }, ...ask.candidates.map((c) => ({ repo: ask.repo, number: c.other.number })));
    } else if (typeof x.repo === "string" && typeof x.number === "number") out.push({ repo: x.repo, number: x.number });
    // An area batch: one repo's list and its items.
    else if (typeof x.repo === "string" && Array.isArray((x as { items?: unknown }).items)) out.push(...refsOf((x as { items: unknown[] }).items));
    // A duplicate pair: both items.
    else if (typeof x.repo === "string" && x.a && x.b) out.push({ repo: x.repo, number: x.a.number }, { repo: x.repo, number: x.b.number });
    else if (typeof x.ref === "string") {
      const r = parseRef(x.ref);
      // A group of one repo's items, `repo#12+13` (duplicate comparisons): each of them.
      const group = r ? null : /^([A-Za-z0-9._-]+)#(\d+(?:\+\d+)+)$/.exec(x.ref.trim());
      if (r) out.push(r);
      else if (group) out.push(...group[2]!.split("+").map((n) => ({ repo: group[1]!, number: Number(n) })));
    }
  }
  return out;
}

/** One line for the Agents page: how many answers came back and, where the answers carry one, their verdicts. */
function replySummary(text: string, asked: number): string {
  const arr = wholeReplyJson(text);
  if (!Array.isArray(arr)) return "answer is not a JSON list";
  const tally = new Map<string, number>();
  for (const x of arr as ({ verdict?: unknown; type_label?: unknown } | null)[]) {
    const k = x?.verdict ?? x?.type_label;
    if (typeof k === "string") tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  const parts = [...tally].map(([k, n]) => `${n} ${k}`);
  return `${arr.length} of ${asked} answered${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

const exitClass = (code: number | null): string => (code === null ? "timed out or killed" : code === -1 ? "could not start" : `exit code ${code}`);

/**
 * `onProgress`: called with a short plain line for each tool call of a sandboxed call, as it happens; the latest line is also kept on the agent run.
 * `checkout`: host directory of a read-only checkout; with it, a prompt that registers a sandbox runs with its tools inside bubblewrap (src/sandbox).
 * `reference`: host directory of the repo's reference documentation; a sandboxed call mounts it read-only at /reference and its prompt says so (src/reference.ts).
 * Prompts with `sandbox.docs` also get the default branch's AGENTS.md (as AGENTS.txt) and ROADMAP.md of the checkout's repository read-only at /repo-docs when the repo has them.
 * `shared`: for a prompt with the workspace, replaces the default workspace (every tracked repository's default branch, src/sandbox/workspace.ts).
 * `itemTools`: the item tools' read-only mounts and MCP servers (`mcpServers` as in an MCP config), for the call and its explorer; null means none, absent means `itemTools()` (src/itemtools).
 * `check`: the build tool of a patch call (src/checktool); a sandboxed call of a prompt whose sandbox allows it gets the `check` tool, and the call may run that much longer.
 * `maxWaitMs`: the longest wait for a free account slot; past it the call throws a WaitLimitError (src/agents/call.ts). Absent: wait as long as it takes.
 * `session`: a sandboxed call keeps its session store and reports it in `session.kept` (the caller removes it). With `session.resume` the call continues that session with the message on its account, or returns undefined from `askOnce` when it cannot.
 * `lint`: checks the parsed reply (src/replylint.ts). With problems, and for a sandboxed call of a prompt that registers `lint`, one follow-up message goes to the same session and its reply is linted too.
 */
export type AskOptions = {
  check?: CheckTool; lint?: Lint; onProgress?: (line: string) => void; checkout?: string; reference?: string; maxWaitMs?: number; shared?: { name: string; dir: string }[]; session?: SessionAsk; itemTools?: { mounts: { host: string; path: string }[]; mcpServers: Record<string, unknown> } | null;
  /** The call runs only on this user's own Task Runners (src/remote/calls.ts NewCall.forLogin), never on the server's accounts. */
  forLogin?: string;
  /** User-local mode: the longest wait of the first call alone in the queue (WaitLimitError past it); follow-ups on its session wait as `maxWaitMs` says. */
  firstWaitMs?: number;
  /** User-local mode: the call failed because the model's safety filter declined it, after its retry elsewhere (src/remote/calls.ts); the ask returns null. */
  onRefused?: (error: string) => void;
};

/** The repo-docs directory for the item's repository, or undefined (no docs, or a checkout that is not one of ours). */
async function docsOf(db: Db, checkout: string): Promise<string | undefined> {
  const repo = repoOfCheckout(checkout);
  if (!repo) return undefined;
  const branch = (await loadRepos(db, { names: [repo] })).get(repo)?.default_branch ?? "main";
  return (await repoDocsFor(repo, branch)) ?? undefined;
}

type WorkspaceFn = (db: Db) => Promise<{ name: string; dir: string }[]>;
let workspaceOf: WorkspaceFn = defaultWorkspace;
/** Tests swap the workspace lookup; returns a function that restores the real one. */
export function setWorkspace(f: WorkspaceFn): () => void {
  workspaceOf = f;
  return () => { workspaceOf = defaultWorkspace; };
}

/**
 * Sends a registered prompt (src/prompts) to `claude -p`. Callers pass a prompt
 * id and the prompt's input, never prompt text: that keeps every prompt on the
 * Prompts page. A new stage registers its prompt there first.
 *
 * Every call is an agent run: it waits for an enabled account with a free slot
 * and headroom, runs with that account's CLAUDE_CONFIG_DIR, and is recorded from
 * start to end (src/agents).
 */
/** `model`: the model id that ran, as the helper's harness reported it; set only for user-local calls (a server call ran the model it asked for). */
export type Reply = { text: string; usage: Usage; turns?: number; model?: string };
/**
 * The turns of a fix turn. Its message says not to use tools, but a model sometimes calls one anyway; the call is denied,
 * and the spare turns let it answer after the denial instead of ending at the turn limit.
 */
export const FIX_TURN_MAX_TURNS = 3;

/** The arguments of a fix turn: FIX_TURN_MAX_TURNS turns and no permission for any tool. The tool list itself stays, so the resumed session's prompt cache still matches. */
export function noToolArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allowedTools") { i++; continue; }
    out.push(args[i]!);
    if (args[i] === "--max-turns") { out.push(String(FIX_TURN_MAX_TURNS)); i++; }
  }
  return out;
}

/** `problems` are what the lint still found in `text` (absent when there was no lint or the reply could not be linted); `fixTurn` is true when a follow-up message was sent. */
export type LintedReply = Reply & { problems?: LintProblem[]; fixTurn?: boolean };

/** The follow-up message for a patch call whose model answered without running clippy. */
export const CHECK_REMINDER = "You have not run the check tool with command clippy on your final diff. Before you answer you must: call check with command fmt and then command clippy, passing your complete final diff as patch; fix what they report; and reply with the final diff that passed, as the diff only.";

/** Whether a reply with a diff of Rust files came from a call that never got a clippy result from the check tool. */
export function needsClippy(tool: Pick<CheckTool, "ran">, reply: string): boolean {
  return /^\+\+\+ (?:b\/)?\S+\.rs\s*$/m.test(reply) && !tool.ran.has("clippy");
}

/**
 * Backstop: nothing that looks like a token or key leaves a model call. The stored copy is scrubbed. A reply that carries
 * code is parsed as written, since rewriting it would push the rewrite; one that holds a credential of a fixed shape is
 * refused as unreadable, so neither the credential nor a placeholder is ever pushed.
 */
function screenReply(id: ClaudePromptId, raw: string): { text: string; stored: string; refused: boolean } {
  const stored = scrub(raw);
  const code = CLAUDE_PROMPTS[id].codeReply === true;
  return { text: code ? raw : stored, stored, refused: code && hasFixedCredential(raw) };
}

type Turned = Reply & { sessionId?: string };

/**
 * Lints the reply and, when the problems need it and the call kept its session (`canFix`), sends one fix turn on that
 * session (`fixTurn`: its reply, null when it ran and failed, "skipped" when it could not start) and merges its fields.
 */
async function lintTail(reply: Reply, lint: Lint, canFix: boolean, fixTurn: (message: string) => Promise<Turned | null | "skipped">): Promise<LintedReply> {
  let problems: LintProblem[] | null = null;
  try { problems = await lint(reply.text, "first"); } catch (e) { if (isHalt(e)) throw e; console.log(`lint failed: ${(e as Error).message}`); }
  if (problems === null) return reply;
  if (!problems.length) return { ...reply, problems };
  // The first lint may put off its slow checks to the fix reply's lint; every exit that uses the first reply runs them on it.
  const firstProblems = problems;
  const full = async (): Promise<LintProblem[]> => {
    try { return (await lint(reply.text, "fix")) ?? firstProblems; } catch (e) { if (isHalt(e)) throw e; console.log(`lint failed: ${(e as Error).message}`); return firstProblems; }
  };
  if (!canFix) return { ...reply, problems: await full() };
  // Problems only in text nobody sees are recorded; a model turn for them would cost more than they matter.
  if (!needsFixTurn(problems)) return { ...reply, problems: await full() };
  const fix = await fixTurn(fixTurnMessage(problems));
  if (fix === "skipped") return { ...reply, problems: await full() };
  if (!fix) return { ...reply, problems: await full(), fixTurn: true };
  const total = add(reply.usage, fix.usage);
  // The fix reply holds only the corrected fields; they are put into the first reply, which stays as it was otherwise.
  const merged = mergeFixFields(reply.text, fix.text, problems);
  if (merged === null) return { text: reply.text, usage: total, ...(reply.turns !== undefined && { turns: reply.turns }), ...(reply.model && { model: reply.model }), problems: await full(), fixTurn: true };
  let after: LintProblem[] | null = null;
  try { after = await lint(merged, "fix"); } catch (e) { if (isHalt(e)) throw e; console.log(`lint failed: ${(e as Error).message}`); }
  // A merged reply the lint cannot read is not used; the first reply stands.
  if (after === null) return { text: reply.text, usage: total, ...(reply.turns !== undefined && { turns: reply.turns }), ...(reply.model && { model: reply.model }), problems: await full(), fixTurn: true };
  return { text: merged, usage: total, ...(reply.turns !== undefined && { turns: reply.turns }), ...(reply.model && { model: reply.model }), problems: after, fixTurn: true };
}

export async function askClaude<K extends ClaudePromptId>(id: K, model: string, input: ClaudeInput[K], db: Db, opts: AskOptions = {}): Promise<LintedReply | null> {
  effect("model-call", id);
  const ses = opts.session;
  if (ses?.resume) {
    const r = await askRemote(id, model, input, db, opts);
    if (r) return r;
    // No resume was possible or the resumed turn failed: a new call, whose input carries the earlier patch and the findings.
    const fresh: SessionAsk = {};
    const again = await askRemote(id, model, input, db, { ...opts, session: fresh });
    ses.kept = fresh.kept;
    delete ses.resume;
    return again ?? null;
  }
  return (await askRemote(id, model, input, db, opts)) ?? null;
}

/** The account of a kept session of the user-local mode: the session lives with the helper of the call that `dir` names. */
export const REMOTE_ACCOUNT = "user-local";
const remoteSessionDir = (callId: number): string => `remote-call:${callId}`;
const remoteParent = (k: KeptSession): number | null => {
  const m = k.account === REMOTE_ACCOUNT ? /^remote-call:(\d+)$/.exec(k.dir) : null;
  return m ? Number(m[1]) : null;
};

/** Tokens of a remote reply in the shape of a local result: the asked model's in the main fields, other models (the explorer) as extras. The helper reports at most the whole call's cost, so the main fields carry it only when there are no extras. */
function remoteUsage(o: Extract<Outcome, { state: "done" }>, model: string): ReturnType<typeof resultUsage> {
  const modelUsage = o.byModel ? Object.fromEntries(Object.entries(o.byModel).map(([m, u]) => [m, { inputTokens: u.input, outputTokens: u.output, cacheReadInputTokens: u.cacheRead, cacheCreationInputTokens: u.cacheWrite }])) : undefined;
  const r = resultUsage({ usage: { input_tokens: o.usage.input, output_tokens: o.usage.output, cache_read_input_tokens: o.usage.cacheRead, cache_creation_input_tokens: o.usage.cacheWrite }, ...(modelUsage && { modelUsage }) }, model);
  return { ...r, usage: { ...r.usage, cost: r.usage.extra ? null : o.costUsd, ...(r.usage.extra && { extra: r.usage.extra.map((e) => ({ model: e.model, usage: { ...e.usage, cost: null } })) }) } };
}

/**
 * askOnce in the user-local mode: each turn is a remote call (src/remote/calls.ts) that a maintainer's helper runs. The
 * bundle carries what the sandboxed call would get here: the checkouts as mounts, the repo docs inline, and MCP servers
 * served per lease (items when a snapshot exists, the check tool, reference documentation instead of a /reference mount).
 * Follow-up turns (check reminder, lint fix, a resume of a kept session) go to the helper that holds the session; when it
 * does not take one in time, the turn is skipped or, for a resume, the caller asks anew. No account is used.
 */
async function askRemote<K extends ClaudePromptId>(id: K, model: string, input: ClaudeInput[K], db: Db, opts: AskOptions): Promise<LintedReply | null | undefined> {
  const p = CLAUDE_PROMPTS[id];
  const ses = opts.session;
  const at = opts.checkout !== undefined && p.sandbox !== undefined ? checkoutCommit(opts.checkout) : null;
  const sandboxed = at !== null;
  const docs = sandboxed && p.sandbox?.docs ? await docsOf(db, opts.checkout!) : undefined;
  if (docs) input = input.map((x) => ({ ...x, repo_docs: true })) as ClaudeInput[K];
  const reference = sandboxed && p.sandbox?.reference === true && opts.reference !== undefined;
  if (reference) input = input.map((x) => ({ ...x, reference: true })) as ClaudeInput[K];
  await ensurePrompts(db);
  const gRepo = (GUIDANCE_PROMPTS as readonly string[]).includes(id) ? guidanceRepo(input) : undefined;
  const guidance = gRepo ? guidanceOf(gRepo) : "";
  if (guidance) input = input.map((x) => ({ ...x, repo_guidance: guidance })) as ClaudeInput[K];
  const parts = claudeParts(id, input, sandboxed, true);
  const items = refsOf(input);
  const resume = ses?.resume;
  const parent = resume ? remoteParent(resume.session) : null;
  if (resume && (!sandboxed || parent === null || resume.session.checkout !== opts.checkout)) return undefined;
  // A resumed session goes on with the prompt it started with: its turns record that call's version.
  const version = resume ? (await loadCallPrompt(db, parent!))?.promptVersion ?? parts.version : parts.version;
  const checkTool = sandboxed && opts.check !== undefined && p.sandbox?.check === true ? opts.check : undefined;
  try {
    const workspace = sandboxed && p.sandbox?.workspace === true;
    const shared = workspace ? opts.shared ?? await workspaceOf(db) : undefined;
    const it = workspace ? opts.itemTools === undefined ? itemTools() : opts.itemTools : null;
    const servers = [...Object.keys(it?.mcpServers ?? {}), ...(checkTool ? [CHECK_SERVER] : []), ...(reference ? [REFERENCE_SERVER] : [])].sort();
    const persist = sandboxed && ((opts.lint !== undefined && p.lint === true) || checkTool !== undefined || ses !== undefined);
    const args = claudeArgs(id, model, sandboxed, servers.length ? { config: MCP_PATH, servers } : undefined, parts.system, false, persist, docs !== undefined);
    const agents = workspace ? JSON.stringify(agentsDefinition(Object.keys(it?.mcpServers ?? {}).sort())) : undefined;
    const mounts = at ? await bundleMounts(db, at, items, shared, docs) : [];
    const timeoutSeconds = p.limits.timeoutSeconds + (checkTool ? CHECK_MAX_WALL_MS / 1000 : 0);
    const tier = tierOfModel(model);
    const level = await callLevel(db, items[0]);

    /** One remote turn: the first message, or with `after` a follow-up on the session of that call. The reference folder is named after its repo (referenceDir). */
    const turn = async (stdin: string, after: number | null, lean = false, first = false): Promise<{ reply: Turned; callId: number } | "failed" | "unclaimed"> => {
      const maxWaitMs = first && opts.firstWaitMs !== undefined ? Math.min(opts.firstWaitMs, opts.maxWaitMs ?? Infinity) : opts.maxWaitMs;
      const callId = await enqueueCall(db, {
        promptId: id, promptVersion: version, tier, effort: p.effort, askedModel: model, items, level, maxAttempts: p.limits.attempts, ...(after !== null && { parentId: after }), ...(reference && { referenceRepo: basename(opts.reference!) }), ...(opts.forLogin !== undefined && { forLogin: opts.forLogin }),
        bundle: {
          promptId: id, promptVersion: version, tier, effort: p.effort, timeoutSeconds, maxTurns: sandboxed ? (lean ? FIX_TURN_MAX_TURNS : p.sandbox!.maxTurns) : null,
          stdin: stdin === parts.stdin ? stdin : stripMarks(stdin), system: parts.system, mounts, mcpServers: servers, keepSession: persist, ...(after !== null && { resume: { parentCallId: after } }),
          // The task budget is added when a Task Runner takes the call, for a Claude Code that takes the flag (forHarness).
          hints: { claude: { args: withoutTaskBudget(lean ? noToolArgs(args) : args), ...(agents && { agents }) } },
        },
      });
      const o = await awaitCall(db, callId, { ...(opts.onProgress && { onProgress: opts.onProgress }), ...(maxWaitMs !== undefined && { maxWaitMs }), ...(checkTool && { check: checkTool }) });
      if (o.state === "unclaimed") return "unclaimed";
      if (o.state === "failed") {
        if (o.runId !== null) await finishRun(db, o.runId, { state: "failed", ...(o.tokens && { tokens: o.tokens }), error: scrubError(o.error), summary: "failed" });
        if (o.error.startsWith(REFUSED_PREFIX)) opts.onRefused?.(o.error);
        return "failed";
      }
      const { usage, all: tokens } = remoteUsage(o, model);
      const { text, stored, refused } = screenReply(id, o.text);
      if (refused) {
        if (o.runId !== null) await finishRun(db, o.runId, { state: "failed", tokens, error: "the reply holds a credential; refused", summary: "unreadable output", output: stored });
        return "failed";
      }
      const turns = sandboxed && o.turns !== null ? o.turns : undefined;
      if (o.runId !== null) await finishRun(db, o.runId, { state: "done", tokens, costUsd: o.costUsd, summary: (after !== null ? "fix turn answered" : turns === undefined ? replySummary(stored, items.length) : `answered in ${turns} turns`) + (after === null && checkTool && checkTool.calls ? `, ${checkTool.calls} checks (${Math.round(checkTool.usedMs / 1000)} s)` : ""), output: stored });
      const ran = o.runId !== null ? (await loadRunsById(db, [o.runId])).get(o.runId)?.reportedModel ?? null : null;
      return { reply: { text, usage, ...(turns !== undefined && { turns }), ...(ran && { model: ran }), ...(o.sessionId && { sessionId: o.sessionId }) }, callId };
    };

    const first = await turn(resume ? resume.message : parts.stdin, parent, false, true);
    // A resume nobody took: the caller asks anew, as when a local session cannot be resumed.
    if (first === "unclaimed") return undefined;
    if (first === "failed") return null;
    let { sessionId, ...reply } = first.reply;
    let last = first.callId;
    // The prompt tells the model to run clippy on its final diff, and a model may skip it: one follow-up message on the same session asks for it.
    if (checkTool && persist && sessionId && needsClippy(checkTool, reply.text)) {
      const again = await turn(CHECK_REMINDER, last);
      if (typeof again === "object") {
        reply = { text: again.reply.text, usage: add(reply.usage, again.reply.usage), ...(reply.turns !== undefined && { turns: reply.turns }), ...((again.reply.model ?? reply.model) && { model: again.reply.model ?? reply.model }) };
        sessionId = again.reply.sessionId ?? sessionId;
        last = again.callId;
      } else if (again === "unclaimed") console.log("check reminder skipped: the helper holding the session did not take it");
    }
    const keep = (): void => { if (ses && persist && sessionId) ses.kept = { id: sessionId, dir: remoteSessionDir(last), account: REMOTE_ACCOUNT, checkout: opts.checkout! }; };
    keep();
    if (!opts.lint) return reply;
    return await lintTail(reply, opts.lint, persist && sessionId !== undefined, async (message) => {
      const fix = await turn(message, last, true);
      if (fix === "unclaimed") {
        console.log("fix turn skipped: the helper holding the session did not take it");
        return "skipped";
      }
      if (fix === "failed") return null;
      last = fix.callId;
      keep();
      return fix.reply;
    });
  } finally {
    // Check tasks still open when the call ends are cancelled.
    await opts.check?.close();
  }
}

/**
 * Sends a registered Jev request (src/prompts) for one item to `jev ask`; the same rule as `askClaude`. Recorded as an agent run without an account.
 * `given`: a body the caller rendered, with the prompt version it was rendered at; without, the request is rendered here.
 */
export async function askJev(id: JevPromptId, item: Item | DupePair | DupeAsk | { ref: string }, db: Db, given?: { body: string; version: string }, perCallUsage = true): Promise<Proc> {
  effect("model-call", id);
  if (!given) await ensurePrompts(db);
  const body = given?.body ?? renderJev(id, item as Item | DupeAsk), version = given?.version ?? promptVersion(id);
  const runId = await startJevRun(db, { promptId: id, promptVersion: version, provider: "jev", model: "jev", items: refsOf([item]), prompt: body });
  const start = now();
  try {
    const cf = jevCloudflareConfig();
    const timeoutMs = JEV_PROMPTS[id].limits.timeoutSeconds * 1000;
    const r = cf ? await askJevCloudflare(cf, body, timeoutMs) : await runner("jev", JEV_ARGS, body, undefined, timeoutMs, jevEnv(), undefined, true);
    let tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
    try {
      const j = JSON.parse(r.stdout) as { usage?: { input_tokens?: number; output_tokens?: number } };
      if (j.usage) tokens = { input: j.usage.input_tokens ?? 0, output: j.usage.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0 };
    } catch { /* the caller reports an unreadable answer */ }
    // A step that sums its retries into one row (usage option of runModelStep) saves nothing here.
    if (tokens && perCallUsage) await saveUsage(db, String(runId), "jev", id.split(".")[0]!, JEV_PROMPTS[id].models[0]!, 1, { ...tokens, cost: tokens.input * JEV_USD_PER_INPUT_TOKEN }, start, now());
    const outage = jevFailure(r);
    if (outage) await markJevUnavailable(db, outage.kind, outage.reason);
    else if (r.code === 0 && tokens) await markJevWorking(db, Date.parse(start));
    if (r.code === 0 && tokens) await finishRun(db, runId, { state: "done", tokens, costUsd: tokens.input * JEV_USD_PER_INPUT_TOKEN, summary: "answered", output: r.stdout });
    else await finishRun(db, runId, { state: "failed", error: scrubError(`${exitClass(r.code)} ${r.stderr}`), summary: r.code === 0 ? JEV_UNREADABLE_SUMMARY : exitClass(r.code), output: r.stdout });
    if (r.code === 0 && !tokens) await markJevUnreadable(db);
    return r;
  } catch (e) {
    await finishRun(db, runId, { state: "failed", error: scrubError(String((e as Error).message ?? e)), summary: "failed before the call" });
    throw e;
  }
}

export const add = (a: Usage, b: Usage): Usage => {
  const extra = new Map<string, Usage>();
  for (const e of [...(a.extra ?? []), ...(b.extra ?? [])]) extra.set(e.model, add(extra.get(e.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, e.usage));
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0), ...(extra.size > 0 && { extra: [...extra].map(([model, usage]) => ({ model, usage })) }) };
};

const HAIKU = CLAUDE_PROMPTS["classify.haiku"];

/** The Haiku batches of `items` (repoBatches: one repo's items each in the user-local mode). */
export const haikuBatches = async (db: Db, items: readonly Item[], batchSize: number = HAIKU.limits.perCall): Promise<Item[][]> => await repoBatches(db, items, batchSize, (i) => i.repo, (i) => [i]);

/** Classifies the items in Haiku batches; returns how many items were in batches that ran (a batch no Task Runner may take does not). */
export async function runHaiku(db: Db, runId: string, items: Item[], batchSize = HAIKU.limits.perCall, model = HAIKU.models[0]!, opts: { cold?: boolean } = {}): Promise<number> {
  const batches = await haikuBatches(db, items, batchSize);
  let skipped = 0;
  await pool(batches.map((batch, n) => async () => {
    const r = await runModelStep(db, CLASSIFY_HAIKU, batch, { model, usage: { run: runId, agent: `haiku-${String(n).padStart(2, "0")}`, stage: "classify" } });
    if (r.ok) await saveVerdicts(db, "haiku", runId, r.values.flat().map((v) => ({ v })));
    const left = r.ok ? r.rest ?? [] : batch;
    if (left.length) console.error(`haiku batch ${n}: no valid answer for ${left.map(refOf).join(", ")}`);
  }), poolRoom(db, (i) => itemRepos(batches[i]!), (i) => batches[i]!, { promptId: CLASSIFY_HAIKU.id }), { first: opts.cold, skipped: (i) => void (skipped += batches[i]!.length) });
  return items.length - skipped;
}

/**
 * Asks Jev for each item (`width` calls at once). The usage rows and verdicts of the chunk are saved together when the calls
 * have ended (also after a failure), in one write each. `hashes` (by ref) are stored as the verdicts' input_hash. Returns the
 * refs whose verdict was saved.
 */
/** Answers of the extra questions a chunk's classify requests carried (renderClassifyJev), by ref; only valid ones. */
export type JevExtraAnswers = { impact: Map<string, JevImpact>; area: Map<string, AreaAnswer> };
/** `statuses`: the API statuses of the chunk's calls that were not OK, with their counts. */
export type JevRun = { saved: Set<string>; statuses: Map<string, number> } & JevExtraAnswers;

/**
 * The usage row of a classify request split into one row per step it asked for, each step's share in proportion to the length of
 * the request it would have sent alone; the classify row keeps the rounding remainder and the cache counts, so the rows add up to the call. A share's
 * items count is 1 when that step's answer was valid.
 */
function splitUsage(row: UsageRow, item: Item, extra: ClassifyExtras, a: ClassifyAnswer | null): UsageRow[] {
  const ref = refOf(item);
  const parts = [
    { agent: `jev-${ref}`, stage: row.stage, items: row.items, len: renderJev("classify.jev", item).length },
    ...(extra.impact ? [{ agent: `priority-jev-${ref}`, stage: "priority", items: a?.impact ? 1 : 0, len: renderJev("priority.jev", item).length }] : []),
    ...(extra.areas ? [{ agent: `areas-jev-${ref}`, stage: "areas", items: a?.area ? 1 : 0, len: renderAreaJev(item, extra.areas).length }] : []),
  ];
  if (parts.length === 1) return [row];
  const total = parts.reduce((n, x) => n + x.len, 0);
  const share = (n: number, len: number) => Math.floor((n * len) / total);
  const rows = parts.map((x) => {
    const u: Usage = { input: share(row.u.input, x.len), output: share(row.u.output, x.len), cacheRead: 0, cacheWrite: 0, cost: null };
    return { ...row, agent: x.agent, stage: x.stage, items: x.items, u };
  });
  const first = rows[0]!;
  // Cache counts and any per-model extras stay whole on the classify row.
  first.u = { ...row.u, input: row.u.input - rows.slice(1).reduce((n, r) => n + r.u.input, 0), output: row.u.output - rows.slice(1).reduce((n, r) => n + r.u.output, 0) };
  for (const r of rows) r.u = { ...r.u, cost: r.u.input * JEV_USD_PER_INPUT_TOKEN };
  return rows;
}

/**
 * Jev classifies `items`, one request per item. `extras`: the questions of priority.jev and areas.jev due for an item, asked in
 * the same request; their valid answers are returned for the caller to settle and store, and the request's usage is split over
 * the steps (splitUsage). `keepEarlier`: usage rows of an earlier pass under the same names are renamed, so their cost stays on
 * record. The chunk's usage and verdicts are stored in one transaction.
 */
export async function runJev(db: Db, runId: string, items: Item[], width?: number, hashes?: ReadonlyMap<string, string>, extras?: ReadonlyMap<string, ClassifyExtras>, o: { keepEarlier?: boolean } = {}): Promise<JevRun> {
  if (width === undefined) width = (await loadLiveConfig(db)).jevParallel;
  // Read once per chunk; a failed call reads it again, since a call that fails is how an outage shows.
  let up = await jevAvailable(db);
  const sinkUsage: UsageRow[] = [], verdicts: { v: Verdict; hash?: string }[] = [], failed: JevFailed[] = [];
  const out: JevRun = { saved: new Set(), impact: new Map(), area: new Map(), statuses: new Map() };
  try {
    await pool(items.map((item) => async () => {
      // Once a call shows Jev is unavailable, the items still waiting are left for Haiku.
      if (!up) return;
      const ref = refOf(item), extra = extras?.get(ref) ?? {};
      const mine: UsageRow[] = [];
      const r = await runModelStep(db, CLASSIFY_JEV, { item, ...extra }, { onJevProc: (p) => { const s = jevStatus(p.stderr); if (s !== null) out.statuses.set(s, (out.statuses.get(s) ?? 0) + 1); }, available: async () => up, usage: { run: runId, agent: `jev-${ref}`, stage: "classify", sink: mine, items: (ok) => (ok ? 1 : 0), withoutUsage: true, skipWhen: async (x) => !x.ok && !(up = await jevAvailable(db)) } });
      for (const row of mine) sinkUsage.push(...splitUsage(row, item, extra, r.ok ? r.value : null));
      if (r.ok) {
        verdicts.push({ v: r.value.verdict, ...(hashes?.has(ref) && { hash: hashes.get(ref)! }) });
        if (r.value.impact) out.impact.set(ref, r.value.impact);
        if (r.value.area) out.area.set(ref, r.value.area);
      } else if (up = await jevAvailable(db)) {
        console.error(`jev: no valid answer for ${ref}`);
        if (hashes?.has(ref)) failed.push({ repo: item.repo, number: item.number, hash: hashes.get(ref)! });
      }
    }), width);
  } finally {
    // The Plan stops holding the prioritize step for the failed items until their input changes (src/core/decide-item.ts).
    const kept = await db.write(async () => {
      if (o.keepEarlier) await keepEarlierUsage(db, runId, sinkUsage.map((r) => r.agent));
      await recordUsage(db, sinkUsage);
      return await saveJevChunk(db, { verdicts: verdictRows("jev", runId, verdicts), failed });
    });
    out.saved = kept.stored;
    // Thrown after the commit, so one verdict that cannot be stored costs neither the others nor the usage of calls already paid for.
    if (kept.error !== undefined) throw kept.error;
  }
  return out;
}
