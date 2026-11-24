// Builds an operator or maintainer starts from their own agent (MCP tools build_base, start_build, list_builds, build_status,
// cancel_build): their command lines run as a build task on the registered build environments, the same queue the
// pipeline's builds use. The source is a default-branch commit AutoCraft has seen (so the CI gate it reads is upstream's)
// plus an optional patch that turns it into the caller's working tree. The task counts as untrusted code: no confidential
// environment and no warm-snapshot signer takes it, and it only reads the repo's warm build cache.
import type { BuildTask, TaskResult, TaskStep } from "../../web/src/api/types.ts";
import { artifactText } from "../prepush/index.ts";
import { patchProblem } from "../worker/patch.ts";
import { FETCH_SCRIPT } from "../worker/rust.ts";
import { BuildError } from "./envs.ts";
import { mainCiRepos } from "../mainci/index.ts";
import { audit } from "../dash/audit.ts";
import { cancelTask, createTask, getTask, logTail, MAX_PATCH_BYTES, MCP_BUILD_STEP, TERMINAL, warmKeyOf } from "./tasks.ts";
import type { Db } from "../db/index.ts";

export { MCP_BUILD_STEP };
/** Command lines one build may run (the plan's 20 steps less the dependency fetch). */
export const MAX_LINES = 19;
const MAX_LINE = 4000;
/** Open (queued or running) builds from the MCP tools at once, over all users. */
export const MAX_OPEN = 8;
export const DEFAULT_STEP_MIN = 60;
const MAX_STEP_MIN = 120;
const LOG_LINES = { default: 120, max: 400 };
export const MAX_LOG_LINES = LOG_LINES.max;
export const MAX_LIST = 50;
const SHA_RE = /^[0-9a-f]{40}$/;
const OPEN_STATES = ["queued", "claimed", "running"] as const;
const FETCH = "fetch deps";

export type StartInput = { repo: string; base: string; patch?: string; steps: string[]; stepMinutes: number; display: boolean; artifacts: string[] };
/** Globs under /out a build may return (the last line's step also returns its exit code). */
export const MAX_ARTIFACT_GLOBS = 19;
const GLOB_RE = /^[A-Za-z0-9._*?/{},-]{1,200}$/;
/** Exit-code artifacts are the tools' own bookkeeping, not the caller's files. */
export const isExitArtifact = (name: string): boolean => /^step-\d{1,2}\.exit$/.test(name);

/** The tool's arguments, or a BuildError(400) that says what is wrong. `repo` is already checked by the caller. */
export function parseStart(repo: string, raw: Record<string, unknown>): StartInput {
  for (const k of Object.keys(raw)) if (!["repo", "base", "patch", "steps", "step_minutes", "display", "artifacts", "format"].includes(k)) throw new BuildError(400, `unknown argument "${k}"`);
  if (typeof raw.base !== "string" || !SHA_RE.test(raw.base)) throw new BuildError(400, "base must be a full lowercase commit id (build_base gives the current one)");
  const steps = raw.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_LINES) throw new BuildError(400, `steps must list 1 to ${MAX_LINES} command lines`);
  for (const s of steps) {
    if (typeof s !== "string" || !s.trim() || s.length > MAX_LINE || /[\0\n\r]/.test(s)) throw new BuildError(400, `each step must be one non-empty command line of at most ${MAX_LINE} characters`);
  }
  let patch: string | undefined;
  if (raw.patch !== undefined && raw.patch !== null && raw.patch !== "") {
    if (typeof raw.patch !== "string" || raw.patch.includes("\0")) throw new BuildError(400, "patch must be the text of a unified diff");
    if (Buffer.byteLength(raw.patch) > MAX_PATCH_BYTES) throw new BuildError(400, "patch is larger than 1 MiB; build a pushed default-branch commit closer to your tree");
    // The worker refuses these when it applies the patch; refusing them here saves a trip through the queue.
    const problem = patchProblem(raw.patch);
    if (problem) throw new BuildError(400, `${problem} (binary files, symlinks and paths outside the tree cannot be sent)`);
    patch = raw.patch.endsWith("\n") ? raw.patch : `${raw.patch}\n`;
  }
  let stepMinutes = DEFAULT_STEP_MIN;
  if (raw.step_minutes !== undefined && raw.step_minutes !== null) {
    if (!Number.isInteger(raw.step_minutes) || (raw.step_minutes as number) < 1 || (raw.step_minutes as number) > MAX_STEP_MIN) throw new BuildError(400, `step_minutes must be a whole number from 1 to ${MAX_STEP_MIN}`);
    stepMinutes = raw.step_minutes as number;
  }
  if (raw.display !== undefined && raw.display !== null && typeof raw.display !== "boolean") throw new BuildError(400, "display must be true or false");
  const artifacts = raw.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACT_GLOBS) throw new BuildError(400, `artifacts must list up to ${MAX_ARTIFACT_GLOBS} globs under /out`);
  for (const g of artifacts) {
    if (typeof g !== "string" || !GLOB_RE.test(g) || g.startsWith("/") || g.split("/").includes("..")) throw new BuildError(400, "each artifact must be a glob relative to /out, such as \"shots/*.png\"");
  }
  return { repo, base: raw.base, ...(patch !== undefined && { patch }), steps: steps as string[], stepMinutes, display: raw.display === true, artifacts: artifacts as string[] };
}

const exitName = (i: number): string => `step-${i + 1}.exit`;

/**
 * The task's plan: the dependency fetch (the only step with network), then one offline step per line. Each line runs in
 * `sh` with cargo offline; its exit code is kept as an artifact and the step itself always succeeds, so every line runs
 * even after one fails. A line that runs out of time still ends the task. The caller's artifact globs are collected once,
 * after the last line (a worker collects a step's artifacts after it; collecting them after every line would return a
 * file once per line).
 */
export function buildPlan(steps: string[], stepMinutes: number, artifacts: string[] = []): TaskStep[] {
  return [
    { name: FETCH, cmd: ["sh", "-c", FETCH_SCRIPT], network: "fetch", timeoutSec: 900 },
    ...steps.map((line, i): TaskStep => ({
      name: `step ${i + 1}`,
      // The marker is the step's first output, so its log rows (and build_status's "running") start with the line, even one that prints nothing.
      cmd: ["sh", "-c", `echo "### line ${i + 1}"; CARGO_NET_OFFLINE=true sh -c "$1"; echo $? > /out/${exitName(i)}; true`, `step-${i + 1}`, line],
      network: "none", timeoutSec: stepMinutes * 60, artifacts: [exitName(i), ...(i === steps.length - 1 ? artifacts : [])],
    })),
  ];
}

export type Base = { sha: string; branch: string; state: string };

/** The current default-branch head of a tracked repo, as the Main CI page shows it. */
export async function currentBase(db: Db, repo: string): Promise<Base | null> {
  const r = (await mainCiRepos(db)).find((x) => x.repo === repo);
  return r ? { sha: r.headSha, branch: r.branch, state: r.state } : null;
}

/** Whether `sha` is a default-branch commit of `repo` that AutoCraft recorded (main_ci keeps the recent heads). */
export async function knownBase(db: Db, repo: string, sha: string): Promise<boolean> {
  return !!await db.prepare("SELECT 1 FROM main_ci WHERE repo = ? AND head_sha = ? LIMIT 1").get(repo, sha);
}

/** Queues the build for `by`; returns its task id. The open-build count, the insert and the audit row are one write, so the cap holds under parallel calls and no build is queued without its audit row. */
export async function startBuild(db: Db, i: StartInput, by: string): Promise<number> {
  const head = await currentBase(db, i.repo);
  if (!head) throw new BuildError(409, `AutoCraft has recorded no default-branch commit of ${i.repo} yet`);
  if (i.base !== head.sha && !await knownBase(db, i.repo, i.base)) throw new BuildError(400, `base must be a default-branch commit AutoCraft has seen; the current one is ${head.sha} (${head.branch}). Make the patch against it.`);
  return await db.write(async () => {
    const open = (await db.prepare(`SELECT COUNT(*) AS n FROM build_tasks WHERE step = ? AND state IN (${OPEN_STATES.map(() => "?").join(", ")})`).get(MCP_BUILD_STEP, ...OPEN_STATES) as { n: number }).n;
    if (open >= MAX_OPEN) throw new BuildError(429, `${MAX_OPEN} builds from agents are already queued or running; wait for one to end`);
    const id = await createTask(db, {
      step: MCP_BUILD_STEP, repo: i.repo, headSha: i.base, baseSha: i.base, requires: { os: "linux", toolchains: ["rust-stable"], ...(i.display && { display: true }) },
      plan: buildPlan(i.steps, i.stepMinutes, i.artifacts), ...(i.patch !== undefined && { patch: i.patch }), warm: { key: warmKeyOf(i.repo), role: "use" },
    });
    await db.prepare("UPDATE build_tasks SET started_by = ? WHERE id = ?").run(by, id);
    await audit(db, by, "mcp-build", `${i.repo}@${i.base}`, { task: id, steps: i.steps.length, patchBytes: i.patch ? Buffer.byteLength(i.patch) : 0, display: i.display, via: "mcp" });
    return id;
  });
}

/** A build from these tools by id; 404 for any other task, so these tools reach nothing else. */
export async function ownBuild(db: Db, id: unknown): Promise<BuildTask> {
  const n = typeof id === "number" ? id : typeof id === "string" && /^\d{1,12}$/.test(id) ? Number(id) : NaN;
  const t = Number.isInteger(n) ? await getTask(db, n) : null;
  if (!t || t.step !== MCP_BUILD_STEP) throw new BuildError(404, `no build ${String(id).slice(0, 40)}`);
  return t;
}

/** `ended`: the line ran, and its exit code comes with the task's end (a build pod reports exit codes then). */
export type LineState = "ok" | "failed" | "timed out" | "running" | "ended" | "waiting" | "not run";
export type LineResult = { line: number; command: string; state: LineState; exitCode: number | null; seconds: number | null };
/** What a build is doing and did, as the tools return it (also as JSON). */
export type BuildView = {
  id: number; repo: string; base: string; patchBytes: number | null; startedBy: string | null;
  state: BuildTask["state"]; environment: string | null;
  /** While open: "queued", "source" (fetching and patching), "fetch deps", "line N" or "finishing"; the end state once over. */
  phase: string;
  /** 1 = the next queued task any environment takes; only while queued. */
  queuePosition: number | null;
  /** null while open; true when the fetch and every line passed. */
  ok: boolean | null;
  queuedAt: string; startedAt: string | null; endedAt: string | null;
  /** Seconds since it started (to its end once over); null before it starts. */
  elapsedSec: number | null;
  linesDone: number; lines: LineResult[];
  /** Whether it renders with the software GPU (requires a worker with a display). */
  display: boolean;
  /** The files it returned (build_artifact reads one), without the exit codes. */
  artifacts: { name: string; bytes: number; contentType: string }[];
  summary: string | null;
};

const exitOf = async (db: Db, id: number, i: number): Promise<number | null> => {
  const text = (await artifactText(db, id, exitName(i)))?.trim();
  return text !== undefined && /^\d{1,3}$/.test(text) ? Number(text) : null;
};

/** The plan step the task's newest log chunk belongs to (the step running now), or null. */
async function loggingStep(db: Db, id: number): Promise<string | null> {
  const r = await db.prepare("SELECT step FROM build_task_logs WHERE task_id = ? ORDER BY seq DESC LIMIT 1").get(id) as { step: string } | undefined;
  return r?.step ?? null;
}

/**
 * Each line's state. Results come with the task's end; a line's exit code comes earlier, as its artifact, from a worker
 * that uploads artifacts after each step (a build pod uploads them at the end). Until then the line the newest log
 * output belongs to is running, the lines before it ended and the lines after it wait.
 */
async function linesOf(db: Db, t: BuildTask, done: boolean, current: string | null): Promise<LineResult[]> {
  const results = new Map<string, TaskResult>(t.results.map((r) => [r.step, r]));
  const steps = t.plan.slice(1);
  const at = steps.findIndex((s) => s.name === current);
  const out: LineResult[] = [];
  for (const [i, step] of steps.entries()) {
    const r = results.get(step.name);
    const exitCode = await exitOf(db, t.id, i);
    const seconds = r ? Math.round(r.durationMs / 1000) : null;
    let state: LineState;
    if (r?.timedOut) state = "timed out";
    else if (r || exitCode !== null) state = exitCode === 0 ? "ok" : "failed";
    else if (done) state = "not run";
    else state = at < 0 || i > at ? "waiting" : i === at ? "running" : "ended";
    out.push({ line: i + 1, command: step.cmd[4] ?? "", state, exitCode, seconds });
  }
  return out;
}

async function queuePosition(db: Db, t: BuildTask): Promise<number | null> {
  if (t.state !== "queued") return null;
  const r = await db.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE state = 'queued' AND (priority > ? OR (priority = ? AND id < ?))").get(t.priority, t.priority, t.id) as { n: number };
  return r.n + 1;
}

/** The view of one build. */
export async function viewOf(db: Db, t: BuildTask, nowMs: number = Date.now()): Promise<BuildView> {
  const done = TERMINAL.includes(t.state);
  const current = done ? null : await loggingStep(db, t.id);
  const lines = await linesOf(db, t, done, current);
  const fetch = t.results.find((r) => r.step === FETCH);
  const running = lines.find((l) => l.state === "running");
  const phase = done ? t.state : t.state === "queued" ? "queued" : t.state === "claimed" ? "starting"
    : running ? `line ${running.line}` : current === FETCH ? FETCH : lines.some((l) => l.state !== "waiting") ? "finishing" : "source";
  const started = t.startedAt ?? t.claimedAt;
  const end = t.endedAt ? Date.parse(t.endedAt) : nowMs;
  const row = await db.prepare("SELECT started_by FROM build_tasks WHERE id = ?").get(t.id) as { started_by: string | null } | undefined;
  return {
    id: t.id, repo: t.repo, base: t.headSha, patchBytes: t.patchBytes, startedBy: row?.started_by ?? null,
    state: t.state, environment: t.envLabel ?? t.envId, phase, queuePosition: await queuePosition(db, t),
    ok: !done ? null : t.state === "done" && !!fetch && fetch.exitCode === 0 && lines.every((l) => l.state === "ok"),
    queuedAt: t.queuedAt, startedAt: started, endedAt: t.endedAt,
    elapsedSec: started ? Math.max(0, Math.round((end - Date.parse(started)) / 1000)) : null,
    linesDone: lines.filter((l) => l.state !== "running" && l.state !== "waiting" && l.state !== "not run").length, lines,
    display: t.requires.display === true,
    artifacts: t.artifacts.filter((a) => !isExitArtifact(a.name)).map((a) => ({ name: a.name, bytes: a.bytes, contentType: a.contentType })),
    summary: t.summary,
  };
}

/** The end of a build's log, at most `n` lines. */
export async function logEnd(db: Db, id: number, n: number = LOG_LINES.default): Promise<{ text: string; truncated: boolean }> {
  const tail = await logTail(db, id);
  const keep = Math.min(Math.max(1, Math.trunc(n) || LOG_LINES.default), LOG_LINES.max);
  const all = tail.text.replace(/\s+$/, "").split("\n");
  return { text: tail.text.trim() ? all.slice(-keep).join("\n") : "", truncated: tail.truncated || all.length > keep };
}

export type ListFilter = { repos: string[]; open: boolean; startedBy?: string; limit: number };

/** Builds from these tools in `repos`, newest first: the open ones, or all. */
export async function listBuilds(db: Db, f: ListFilter): Promise<BuildView[]> {
  if (!f.repos.length) return [];
  const where = [`step = ?`, `repo IN (${f.repos.map(() => "?").join(", ")})`];
  const params: (string | number)[] = [MCP_BUILD_STEP, ...f.repos];
  if (f.open) { where.push(`state IN (${OPEN_STATES.map(() => "?").join(", ")})`); params.push(...OPEN_STATES); }
  if (f.startedBy) { where.push("started_by = ?"); params.push(f.startedBy); }
  const ids = await db.prepare(`SELECT id FROM build_tasks WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...params, Math.min(Math.max(1, f.limit), MAX_LIST)) as { id: number }[];
  const out: BuildView[] = [];
  for (const { id } of ids) {
    const t = await getTask(db, id);
    if (t) out.push(await viewOf(db, t));
  }
  return out;
}

/** Cancels an open build from these tools. */
export async function cancelBuild(db: Db, t: BuildTask, by: string): Promise<BuildTask> {
  if (TERMINAL.includes(t.state)) throw new BuildError(409, `build ${t.id} already ended (${t.state})`);
  return await cancelTask(db, t.id, by);
}
