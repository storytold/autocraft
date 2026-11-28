// Part 2 of the Verify stage: result collection from finished tasks, the failure summary, the retry of
// an infrastructure error and the cancel of tasks whose PR moved on. Part 1 (index.ts) only plans and queues.
// Pass or fail comes from the tasks' exit codes, never from a model; Haiku only describes a failure.
import { leaseItem } from "../runner/leases.ts";
import type { TaskResult, TaskStep } from "../../web/src/api/types.ts";
import { BuildError } from "../build/envs.ts";
import { cloneTasks } from "../build/tasks.ts";
import { cancelTasks, loadLogTails, loadQueuedWarmBuilds, loadRetriesOf, loadTasks, TERMINAL, type TaskRecord } from "../data/build/index.ts";
import { addStageEvents } from "../data/planner/index.ts";
import { loadLatestMainHeads } from "../data/mirror/index.ts";
import { listVerifications as listMergeVerifications, loadPendingVerifications, loadVerifications, loadVerifyDue, restartVerifications, settleVerifications, type StageRow, type VerificationState, type VerificationView } from "../data/merge/index.ts";
import { askClaude, POOL_MAX, pool, saveUsage, type Usage } from "../classify/run.ts";
import { poolRoom } from "../agents/call.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { scrub } from "../runner/scrub.ts";
import { noFocusedTests, NO_FOCUSED_TESTS_SUMMARY } from "./tasks.ts";
import { MAX_SUMMARY_WORDS, SUMMARY_LOG_BYTES, type VerifySummaryInput } from "./types.ts";
import { jobItem } from "../runner/job-items.ts";
import { collectScreenshots, type ScreenshotDeps } from "./screenshots.ts";
import { featureOn } from "../build/features.ts";
import { someSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

const PROMPT = CLAUDE_PROMPTS["verify.summary"];
const ACTOR = "verify";
/** The step whose failure says nothing about the change: it only downloads dependencies. */
const FETCH = "fetch deps";
/** An automatic retry per head: the new tasks run once more, then an error stays. */
export const MAX_RETRIES = 1;
export const NOT_FAILING_REASON = "regression test passes on base";
const ERROR_LIMIT = 200;

export { VERIFICATION_STATES, type VerificationState, type VerificationTask, type VerificationView } from "../data/merge/index.ts";

/** A task as `outcomeOf` reads it: any task record, or the task of a verification view. */
export type FinishedTask = Pick<TaskRecord, "state" | "plan" | "results" | "summary">;

// ---- reading -----------------------------------------------------------------

/** The verification of one PR head, or null. */
export async function verificationOf(db: Db, repo: string, number: number, headSha: string): Promise<VerificationView | null> {
  return (await loadVerifications(db, [{ repo, number }])).get(headKey(repo, number, headSha)) ?? null;
}

/** Verifications in the given states (all when none), newest first. */
export async function listVerifications(db: Db, o: { states?: VerificationState[]; repo?: string; limit?: number } = {}): Promise<VerificationView[]> {
  return await listMergeVerifications(db, o);
}

const headKey = (repo: string, number: number, head: string): string => `${repo}#${number}@${head}`;

// ---- when to run -------------------------------------------------------------

/**
 * Whether a collection run has work: a pending verification, in scope or not, whose PR head moved or closed, whose tasks are all
 * finished, or that is still `planned` while a task has started; the same for screenshot runs, which also stop when
 * their repo's switch went off. One statement, plus one switch read per repo with a run in flight.
 */
export async function collectDue(db: Db): Promise<boolean> {
  const due = await loadVerifyDue(db);
  if (due.verifications || due.screenshots) return true;
  return await someSeq(due.shotRepos, async (repo) => !await featureOn(db, "screenshots", repo));
}

// ---- judging tasks -----------------------------------------------------------

export type Outcome =
  | { kind: "pass" }
  | { kind: "fail"; step: string; exitCode: number | null; timedOut: boolean }
  | { kind: "error"; reason: string };

export const oneLine = (s: string): string => scrub(s).replace(/\s+/g, " ").trim().slice(0, ERROR_LIMIT);
const ok = (r: TaskResult): boolean => r.exitCode === 0 && !r.timedOut;

/** What a finished task says, from its state and exit codes. Callers pass only terminal tasks. */
export function outcomeOf(t: FinishedTask): Outcome {
  if (t.state === "cancelled") return { kind: "error", reason: "the build task was cancelled" };
  if (t.state === "done") {
    return t.results.length === t.plan.length && t.results.every(ok) ? { kind: "pass" } : { kind: "error", reason: "the build task finished without a result for every step" };
  }
  // Lost, or failed. No step result means the task never got to run one: a lost worker, a malformed task, a patch that does not apply.
  const bad = t.results.find((r) => !ok(r));
  if (!bad) return { kind: "error", reason: oneLine(t.summary ?? "the build task failed before running a step") };
  const fetchStep = t.plan.find((s) => s.network === "fetch")?.name ?? FETCH;
  if (bad.step === fetchStep) return { kind: "error", reason: `${bad.step} ${bad.timedOut ? "timed out" : `failed (exit ${bad.exitCode ?? "none"})`}` };
  if (bad.exitCode === null && !bad.timedOut) return { kind: "error", reason: `${bad.step}: the build environment could not run it` };
  return { kind: "fail", step: bad.step, exitCode: bad.exitCode, timedOut: bad.timedOut };
}

export type Verdict = { state: "passed" | "failed" | "error"; note?: string; failed?: { role: "head" | "base"; step: string; exitCode: number | null; timedOut: boolean }; reason?: string };

/** Combines the head task's outcome and, for a regression, the base task's. */
export function verdictOf(head: Outcome, base: Outcome | null): Verdict {
  if (head.kind === "fail") return { state: "failed", failed: { role: "head", step: head.step, exitCode: head.exitCode, timedOut: head.timedOut } };
  if (head.kind === "error") return { state: "error", reason: head.reason };
  if (!base) return { state: "passed" };
  if (base.kind === "error") return { state: "error", reason: `base commit: ${base.reason}` };
  if (base.kind === "pass") return { state: "failed", reason: NOT_FAILING_REASON };
  if (base.step === "test") return base.timedOut ? { state: "passed", note: "regression test timed out on the base commit" } : { state: "passed" };
  return { state: "passed", note: "base commit did not build with the regression test, so the test was not shown to fail there" };
}

// ---- the run -----------------------------------------------------------------

export type CollectDeps = {
  model: string;
  /** The screenshot comparison, replaceable in tests. */
  screenshots?: ScreenshotDeps;
};

export type CollectSummary = {
  runId: string; looked: number; passed: number; failed: number; errors: number; retried: number; stale: number; running: number;
  warmCancelled: number; /** Screenshot runs that left planned/running. */ shots: number; /** Verifications that left planned/running, plus warm builds cancelled. */ changed: number;
};

const now = (): string => new Date().toISOString();
const cut = (s: string): string => s.trim().split(/\s+/).slice(0, MAX_SUMMARY_WORDS).join(" ");

const fallbackSummary = (f: NonNullable<Verdict["failed"]>): string =>
  `${f.step} ${f.timedOut ? "timed out" : `failed with exit code ${f.exitCode ?? "none"}`}`;

/** Haiku's account of a failed step, or null. The log and the command are untrusted and scrubbed before they leave and before the reply is stored. */
export async function summariseFailure(db: Db, v: { repo: string; number: number }, taskId: number, f: NonNullable<Verdict["failed"]>, deps: CollectDeps, runId: string): Promise<string> {
  const [tasks, tails] = await db.together(() => Promise.all([loadTasks(db, [taskId]), loadLogTails(db, [{ id: taskId, step: f.step }], { maxBytes: SUMMARY_LOG_BYTES })]));
  const step = tasks.get(taskId)?.plan.find((s: TaskStep) => s.name === f.step);
  if (noFocusedTests(step?.cmd, f.exitCode)) return NO_FOCUSED_TESTS_SUMMARY;
  const input: VerifySummaryInput = {
    ref: `${v.repo}#${v.number}`, step: f.step, command: scrub((step?.cmd ?? []).join(" ")), log: scrub(tails.get(taskId)?.text ?? ""),
  };
  const start = now();
  const reply = await askClaude("verify.summary", deps.model, [input], db);
  await saveUsage(db, runId, `verify-collect-${v.number}`, "verify", deps.model, reply ? 1 : 0, reply?.usage ?? ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as Usage), start, now());
  const text = reply ? scrub(cut(reply.text)) : "";
  return text || fallbackSummary(f);
}

/** Cancels the tasks of a verification that are not finished. */
export async function cancelOpen(db: Db, ids: (number | null)[]): Promise<void> {
  await cancelTasks(db, { ids: ids.filter((id): id is number => id !== null) }, ACTOR);
}

export async function runCollect(db: Db, params: { dryRun?: boolean; /** True when no new item should start (cancel, deadline, pipeline off). */ stopping?: () => Promise<boolean> } = {}, log: (line: string) => void = console.log, deps?: CollectDeps): Promise<CollectSummary> {
  const d: CollectDeps = deps ?? { model: PROMPT.models[0]! };
  const runId = `verify-collect-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  const s: CollectSummary = { runId, looked: 0, passed: 0, failed: 0, errors: 0, retried: 0, stale: 0, running: 0, warmCancelled: 0, shots: 0, changed: 0 };
  const rows = await loadPendingVerifications(db);
  s.looked = rows.length;
  if (params.dryRun) { log(`verify-collect: ${rows.length} pending; dry run`); return s; }
  const retries = await loadRetriesOf(db, rows.map((v) => ({ step: "verify", repo: v.repo, number: v.number, headSha: v.headSha })));

  let stoppedLogged = false;
  const stopped = async (): Promise<boolean> => {
    if (!await params.stopping?.()) return false;
    if (!stoppedLogged) log("verify-collect: stopping, no new PRs started");
    stoppedLogged = true;
    return true;
  };
  const one = async (v: (typeof rows)[number]): Promise<void> => {
    if (await stopped()) return;
    const release = await leaseItem(db, `pr:${v.repo}#${v.number}`, log);
    if (!release) return;
    try {
      if (await stopped()) return;
      const ref = `${v.repo}#${v.number}`;
      const key = headKey(v.repo, v.number, v.headSha);
      const sha7 = v.headSha.slice(0, 7);
      const stageOf = (stage: string, at: string, note: string): StageRow => ({ repo: v.repo, number: v.number, stage, at, actor: ACTOR, note: note.slice(0, 300) });
      /** Settles the row while it is still planned or running; the stage events are written with it. `hold` follows a failure. */
      const finish = async (state: VerificationState, summary: string | null, note: string | null, stage?: StageRow, hold?: StageRow): Promise<boolean> =>
        await db.write(async () => {
          const changed = (await settleVerifications(db, [{ key, from: ["planned", "running"], set: { state, summary, note, finishedAt: now() }, ...(stage ? { stage } : {}) }])).has(key);
          if (changed && hold) await addStageEvents(db, [{ ...hold, stage: "hold" }]);
          return changed;
        });
      const noted = async (stage: StageRow): Promise<void> => await jobItem(db, v.repo, v.number, stage.note ?? "", () => {});   // the caller logs the outcome itself

      if (v.itemState !== "OPEN" || v.currentHead !== v.headSha) {
        await cancelOpen(db, [v.headTask, v.baseTask]);
        if (await finish("stale", v.summary, v.note)) { s.stale++; s.changed++; await jobItem(db, v.repo, v.number, `stale (${v.itemState === "OPEN" ? "head moved" : "no longer open"})`, log); }
        return;
      }

      const head = v.tasks.find((t) => t.role === "head");
      const base = v.tasks.find((t) => t.role === "base");
      if (!head) {
        const st = stageOf("verify-error", now(), `${v.kind} at ${sha7}: the build task is gone`);
        if (await finish("error", "the build task is gone", null, st)) { s.errors++; s.changed++; await noted(st); }
        return;
      }
      if (v.tasks.some((t) => !TERMINAL.includes(t.state))) {
        if (v.state === "planned" && v.tasks.some((t) => t.state === "claimed" || t.state === "running")) {
          await settleVerifications(db, [{ key, from: ["planned"], set: { state: "running" } }]);
          s.running++; s.changed++;
        }
        return;
      }

      const verdict = verdictOf(outcomeOf(head), base ? outcomeOf(base) : null);
      const at = now();

      if (verdict.state === "error" && (retries.get(`verify|${ref}|${v.headSha}`) ?? 1) - 1 < MAX_RETRIES) {
        try {
          await db.write(async () => {
            const cloned = await cloneTasks(db, [v.headTask, v.baseTask].filter((id): id is number => id !== null));
            await restartVerifications(db, [{ key, headTask: v.headTask === null ? null : cloned.get(v.headTask) ?? null, baseTask: v.baseTask === null ? null : cloned.get(v.baseTask) ?? null }]);
          });
          s.retried++; s.changed++;
          await jobItem(db, v.repo, v.number, `${verdict.reason}; queued the tasks again`, log);
          return;
        } catch (e) {
          if (!(e instanceof BuildError)) throw e;
          verdict.reason = `${verdict.reason}; tasks not queued again: ${e.message}`;
        }
      }

      if (verdict.state === "passed") {
        const st = stageOf("verified", at, `${v.kind} at ${sha7} passed${verdict.note ? `: ${verdict.note}` : ""}`);
        if (await finish("passed", null, verdict.note ?? null, st)) { s.passed++; s.changed++; await noted(st); }
      } else if (verdict.state === "error") {
        const why = oneLine(verdict.reason ?? "error");
        const st = stageOf("verify-error", at, `${v.kind} at ${sha7}: ${why}`);
        if (await finish("error", why, null, st)) { s.errors++; s.changed++; await noted(st); }
      } else {
        // No model call for an item the pipeline does not work.
        const summary = verdict.failed ? !v.inScope ? fallbackSummary(verdict.failed) : await summariseFailure(db, v, v.headTask!, verdict.failed, d, runId) : oneLine(verdict.reason ?? "failed");
        const st = stageOf("verify-failed", at, `${v.kind} at ${sha7}: ${summary}`);
        if (await finish("failed", summary, null, st, stageOf("hold", at, `verify failed: ${summary}`))) { s.failed++; s.changed++; await noted(st); }
      }
      log(`  ${ref}: ${verdict.state}`);
    } finally { await release(); }
  };
  // Rows of one PR (an older head still pending) run one after the other; PRs run side by side.
  const byPr = new Map<string, typeof rows>();
  for (const v of rows) byPr.set(`${v.repo}#${v.number}`, [...(byPr.get(`${v.repo}#${v.number}`) ?? []), v]);
  const groups = [...byPr.values()];
  await pool(groups.map((group) => async (): Promise<void> => { for (const v of group) await one(v); }), poolRoom(db, (i) => [groups[i]![0]!.repo], (i) => [groups[i]![0]!], { mayNotCall: true }), { max: POOL_MAX.verifyCollect });

  // Screenshot runs: one read of an empty table while the Screenshots feature has never run.
  s.shots = await collectScreenshots(db, d, log, runId, params.stopping);
  s.changed += s.shots;
  s.warmCancelled = await cancelMovedWarmBuilds(db, log);
  s.changed += s.warmCancelled;
  log(`verify-collect: ${s.looked} pending: ${s.passed} passed, ${s.failed} failed, ${s.errors} errors, ${s.retried} retried, ${s.stale} stale, ${s.running} running; ${s.warmCancelled} warm builds cancelled`);
  return s;
}

/**
 * Cancels queued warm builds whose branch head is no longer the commit they would build: only on a main-CI reading made after the
 * build was queued, since Verify queues it at the head GitHub gave it, which an earlier poll had not seen.
 */
async function cancelMovedWarmBuilds(db: Db, log: (line: string) => void): Promise<number> {
  const queued = await loadQueuedWarmBuilds(db);
  const heads = await loadLatestMainHeads(db, [...new Set(queued.map((t) => t.repo))]);
  const ids = queued.filter((t) => { const main = heads.get(t.repo); return !!main && main.head_sha !== t.headSha && main.updated_at > t.queuedAt; }).map((t) => t.id);
  const out = await cancelTasks(db, { ids }, ACTOR);
  const n = out.filter((o) => o.result === "cancelled").length;
  for (const o of out) if (o.result === "cancelled") log(`  warm build ${o.id} of ${o.repo}: the branch moved on; cancelled`);
  return n;
}
