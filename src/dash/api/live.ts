// The Live board on Home: every running and queued unit of the pipeline's work (jobs, model calls and build tasks of their own, open
// integration batches) on one time axis, with the model calls and build steps inside it and how long the same work took before. Jobs that
// ended in the last minutes stay on it, faded. Repos the reader cannot see are left out as on the Now page (src/dash/api/now.ts); account
// labels are for operators only.
import type { DatabaseSync } from "node:sqlite";
import type { ItemRef, ItemShown, LiveBoard, LiveEstimate, LiveLane, LiveOp, LiveOpKind } from "../../../web/src/api/types.ts";
import { PRIVATE_STEPS_SQL } from "../../build/tasks.ts";
import { touchesHidden } from "../../agents/runs.ts";
import { filtered, hiddenTest, type HiddenRepos } from "../../hidden-sql.ts";
import type { Req } from "../types.ts";
import { QUIET_STEPS } from "./now.ts";
import { shownLookup } from "./shown.ts";
import { canSeeInternals } from "./staff.ts";
import { stepTitle } from "./trace.ts";
import { blankIfHidden, hiddenRepos } from "./visible.ts";

/** Ended jobs stay on the board this long. */
const RECENT_MS = 20 * 60_000;
const RECENT_MAX = 8;
const QUEUED_MAX = 6;
/** Earlier runs an estimate is read from. */
const SAMPLES = 60;
/** Fewer earlier runs than this give no estimate. */
const MIN_SAMPLES = 3;

type Args = (string | number)[];
const all = <T>(db: DatabaseSync, sql: string, ...args: Args): T[] => db.prepare(sql).all(...args) as T[];
const notHidden = (col: string, hidden: HiddenRepos, nullOk = false): string =>
  filtered(hidden) ? ` AND (${nullOk ? `${col} IS NULL OR ` : ""}NOT (${hiddenTest(col, hidden).sql}))` : "";
const hideArgs = (hidden: HiddenRepos): string[] => (filtered(hidden) ? hiddenTest("x", hidden).args : []);

/** Median and 90th percentile of durations in ms; null with too few. */
function estimateOf(ms: number[]): LiveEstimate | null {
  const xs = ms.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (xs.length < MIN_SAMPLES) return null;
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  return { median: at(0.5), p90: at(0.9), samples: xs.length };
}

/** A build step's kind from its name, as the timeline colours it. */
export function buildKind(name: string): LiveOpKind {
  const n = name.toLowerCase();
  if (/test|spec|jest|vitest|pytest/.test(n)) return "tests";
  if (/lint|clippy|eslint|fmt|format|check|typecheck|tsc/.test(n)) return "lint";
  if (/build|compile|bundle|package|make/.test(n)) return "build";
  if (/install|setup|fetch|checkout|clone|deps|restore|cache|prepare|\bci\b/.test(n)) return "setup";
  return "other";
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function live(db: DatabaseSync, req: Req): Promise<LiveBoard> {
  const hidden = await hiddenRepos(db, req);
  const staff = canSeeInternals(req);
  const nowMs = Date.now();
  const shown = shownLookup(db);
  const item = (repo: string, number: number): ItemRef & ItemShown => ({ repo, number, ...shown(repo, number) });

  // Estimates, read once per key.
  const memo = new Map<string, LiveEstimate | null>();
  const memoized = (key: string, read: () => number[]) => (memo.has(key) ? memo.get(key)! : memo.set(key, estimateOf(read())).get(key)!);
  const jobEstimate = (step: string) => memoized(`job:${step}`, () =>
    all<{ ms: number }>(db, `SELECT (julianday(ended_at) - julianday(started_at)) * 86400000 AS ms FROM jobs WHERE step = ? AND state = 'done' AND started_at IS NOT NULL AND ended_at IS NOT NULL ORDER BY id DESC LIMIT ?`, step, SAMPLES).map((r) => r.ms));
  const callEstimate = (step: string, model: string) => memoized(`call:${step}:${model}`, () =>
    all<{ ms: number }>(db, `SELECT (julianday(ended_at) - julianday(started_at)) * 86400000 AS ms FROM agent_runs WHERE step = ? AND model = ? AND state = 'done' AND ended_at IS NOT NULL ORDER BY id DESC LIMIT ?`, step, model, SAMPLES).map((r) => r.ms));
  const taskEstimate = (repo: string, step: string) => memoized(`task:${repo}:${step}`, () =>
    all<{ ms: number }>(db, `SELECT (julianday(ended_at) - julianday(started_at)) * 86400000 AS ms FROM build_tasks WHERE repo = ? AND step = ? AND state = 'done' AND started_at IS NOT NULL AND ended_at IS NOT NULL ORDER BY id DESC LIMIT ?`, repo, step, SAMPLES).map((r) => r.ms));

  const hiddenRuns = filtered(hidden) ? ` AND ${touchesHidden(hidden).sql}` : "";
  type Call = { id: number; job_id: number | null; step: string; model: string; provider: string; label: string | null; started_at: string; ended_at: string | null; state: string; progress: string | null };
  const callOp = (c: Call): LiveOp => ({
    kind: "model", label: c.provider === "jev" ? "Jev" : c.model, detail: c.provider === "compatible" ? `${stepTitle(c.step)} on the compatible provider` : c.provider === "decisions" ? `${stepTitle(c.step)} on the decisions endpoint` : c.provider !== "jev" && req.user.role === "operator" ? `${stepTitle(c.step)} on ${c.label ?? "an unknown account"}` : stepTitle(c.step),
    start: c.started_at, end: c.ended_at, estimate: c.state === "running" ? callEstimate(c.step, c.model) : null, ...(c.state === "failed" ? { failed: true } : {}),
  });
  type Task = { id: number; job_id: number | null; step: string; repo: string; number: number | null; state: string; queued_at: string; started_at: string | null; ended_at: string | null; results: string; summary: string | null; current: string | null };
  /** A finished task as one op per step (from its recorded durations); a running one as one op named by the step its log is on. */
  const taskOps = (t: Task): LiveOp[] => {
    if (!t.started_at) return [];
    const start = Date.parse(t.started_at);
    if (t.ended_at) {
      let results: { step: string; durationMs: number; exitCode: number | null }[] = [];
      try { results = JSON.parse(t.results) as typeof results; } catch { /* none */ }
      if (!results.length) return [{ kind: "build", label: "Build task", detail: stepTitle(t.step), start: t.started_at, end: t.ended_at, estimate: null, ...(t.state !== "done" ? { failed: true } : {}) }];
      let at = start;
      return results.map((r) => {
        const op: LiveOp = { kind: buildKind(r.step), label: r.step, detail: stepTitle(t.step), start: iso(at), end: iso(at + r.durationMs), estimate: null, ...(r.exitCode !== 0 ? { failed: true } : {}) };
        at += r.durationMs;
        return op;
      });
    }
    return [{ kind: t.current ? buildKind(t.current) : "build", label: t.current ?? "Build task", detail: stepTitle(t.step), start: t.started_at, end: null, estimate: taskEstimate(t.repo, t.step) }];
  };
  const taskCols = `t.id, t.job_id, t.step, t.repo, t.number, t.state, t.queued_at, t.started_at, t.ended_at, t.results, t.summary,
    (SELECT l.step FROM build_task_logs l WHERE l.task_id = t.id ORDER BY l.seq DESC LIMIT 1) AS current`;
  const privateTasks = staff ? "" : ` AND t.step NOT IN (${PRIVATE_STEPS_SQL})`;

  // Jobs: running, then queued (the next few), then the ones that ended lately.
  type Job = { id: number; step: string; state: string; requested_at: string; started_at: string | null; ended_at: string | null; progress: string | null; summary: string | null; error: string | null; repo: string | null };
  const cols = "id, step, state, requested_at, started_at, ended_at, progress, summary, error, repo";
  const since = iso(nowMs - RECENT_MS);
  // Housekeeping steps show only when they fail; left out before any LIMIT, so they never take a slot.
  const quiet = [...QUIET_STEPS];
  const loud = ` AND (state = 'failed' OR step NOT IN (${quiet.map(() => "?").join(", ")}))`;
  const jobs = [
    ...all<Job>(db, `SELECT ${cols} FROM jobs WHERE state = 'running'${loud}${notHidden("repo", hidden, true)} ORDER BY id`, ...quiet, ...hideArgs(hidden)),
    ...all<Job>(db, `SELECT ${cols} FROM jobs WHERE state = 'queued'${loud}${notHidden("repo", hidden, true)} ORDER BY id LIMIT ?`, ...quiet, ...hideArgs(hidden), QUEUED_MAX),
    ...all<Job>(db, `SELECT ${cols} FROM jobs WHERE state IN ('done', 'failed') AND ended_at > ? AND started_at IS NOT NULL${loud}${notHidden("repo", hidden, true)} ORDER BY ended_at DESC LIMIT ?`, since, ...quiet, ...hideArgs(hidden), RECENT_MAX * 3),
  ];

  const lanes: LiveLane[] = [];
  let recent = 0;
  for (const j of jobs) {
    const ended = j.state === "done" || j.state === "failed";
    const its = all<{ repo: string; number: number }>(db, `SELECT repo, number FROM job_items WHERE job_id = ?${notHidden("repo", hidden)} ORDER BY id`, j.id, ...hideArgs(hidden));
    if (ended && its.length === 0 && j.state !== "failed") continue;
    if (ended && ++recent > RECENT_MAX) continue;
    const calls = all<Call>(db, `SELECT r.id, r.job_id, r.step, r.model, r.provider, COALESCE(a.label, r.account_id) AS label, r.started_at, r.ended_at, r.state, r.progress
      FROM agent_runs r LEFT JOIN claude_accounts a ON a.id = r.account_id WHERE r.job_id = ?${hiddenRuns} ORDER BY r.id`, j.id, ...hideArgs(hidden));
    const tasks = all<Task>(db, `SELECT ${taskCols} FROM build_tasks t WHERE t.job_id = ?${notHidden("t.repo", hidden)}${privateTasks} ORDER BY t.id`, j.id, ...hideArgs(hidden));
    const line = j.state === "running" ? blankIfHidden(j.progress, hidden) : j.state === "failed" ? (staff && j.error ? blankIfHidden(j.error, hidden) : "Failed") : j.state === "done" ? blankIfHidden(j.summary, hidden) : null;
    lanes.push({
      key: `job:${j.id}`, title: stepTitle(j.step), state: j.state === "running" ? "running" : j.state === "queued" ? "queued" : j.state === "failed" ? "failed" : "done",
      start: j.started_at ?? j.requested_at, end: j.ended_at, line: line || null,
      item: its[0] ? item(its[0].repo, its[0].number) : null, itemCount: its.length, repo: j.repo, detail: `/pipeline/${j.id}`,
      estimate: j.state === "running" ? jobEstimate(j.step) : null,
      ops: [...calls.map(callOp), ...tasks.flatMap(taskOps)].sort((a, b) => a.start.localeCompare(b.start)),
    });
  }

  // Calls and build tasks that run without a job.
  for (const c of all<Call>(db, `SELECT r.id, r.job_id, r.step, r.model, r.provider, COALESCE(a.label, r.account_id) AS label, r.started_at, r.ended_at, r.state, r.progress
      FROM agent_runs r LEFT JOIN claude_accounts a ON a.id = r.account_id WHERE r.state = 'running' AND r.job_id IS NULL${hiddenRuns} ORDER BY r.id`, ...hideArgs(hidden))) {
    const it = all<{ repo: string; number: number }>(db, "SELECT repo, number FROM agent_run_items WHERE run_id = ? ORDER BY repo, number LIMIT 1", c.id)[0];
    const op = callOp(c);
    lanes.push({ key: `run:${c.id}`, title: stepTitle(c.step), state: "running", start: c.started_at, end: null, line: blankIfHidden(c.progress, hidden) || null, item: it ? item(it.repo, it.number) : null, itemCount: it ? 1 : 0, repo: it?.repo ?? null, detail: `/agents/${c.id}`, estimate: op.estimate, ops: [op] });
  }
  // Open integration batches, with the build task of their combined tree; that task gets no lane of its own.
  type Batch = { id: number; repo: string; state: string; created_at: string; summary: string | null; task_id: number | null; pr_number: number | null };
  const batches = all<Batch>(db, `SELECT id, repo, state, created_at, summary, task_id, pr_number FROM merge_batches WHERE state IN ('checking', 'open')${notHidden("repo", hidden)} ORDER BY id`, ...hideArgs(hidden));
  const batchTasks = new Set(batches.map((b) => b.task_id).filter((id): id is number => id !== null));
  for (const b of batches) {
    const prs = all<{ number: number }>(db, "SELECT number FROM merge_batch_prs WHERE batch_id = ? ORDER BY position", b.id);
    const tasks = b.task_id === null ? [] : all<Task>(db, `SELECT ${taskCols} FROM build_tasks t WHERE t.id = ?${privateTasks}`, b.task_id);
    const ops = tasks.flatMap(taskOps);
    lanes.push({
      key: `batch:${b.id}`, title: "Integration batch", state: "running", start: b.created_at, end: null,
      line: blankIfHidden(b.summary, hidden) || (b.state === "checking" ? "Checking the combined tree" : b.pr_number !== null ? `Batch pull request #${b.pr_number} is open` : null),
      item: prs[0] ? item(b.repo, prs[0].number) : null, itemCount: prs.length, repo: b.repo, detail: `/batches/${b.id}`, estimate: null, ops,
    });
  }
  for (const t of all<Task>(db, `SELECT ${taskCols} FROM build_tasks t WHERE t.state IN ('queued', 'claimed', 'running') AND t.job_id IS NULL${notHidden("t.repo", hidden)}${privateTasks} ORDER BY t.id`, ...hideArgs(hidden))) {
    if (batchTasks.has(t.id)) continue;
    const ops = taskOps(t);
    lanes.push({
      key: `task:${t.id}`, title: `Build task, ${stepTitle(t.step)}`, state: t.state === "queued" ? "queued" : "running", start: t.started_at ?? t.queued_at, end: null, line: t.summary,
      item: t.number === null ? null : item(t.repo, t.number), itemCount: t.number === null ? 0 : 1, repo: t.repo, detail: `/envs/${t.id}`, estimate: ops[0]?.estimate ?? null, ops,
    });
  }
  return { lanes };
}
