// Part 2 of the Verify stage: result collection from finished tasks, the failure summary, the retry of
// an infrastructure error and the cancel of tasks whose PR moved on. Part 1 (index.ts) only plans and queues.
// Pass or fail comes from the tasks' exit codes, never from a model; Haiku only describes a failure.
import { setAsideAnswerBeforeFailure } from "../merge/verify-override.ts";
import { leaseItem } from "../runner/leases.ts";
import type { BuildTask, TaskResult, TaskStep } from "../../web/src/api/types.ts";
import { BuildError } from "../build/envs.ts";
import { TERMINAL, cancelTask, getTask } from "../build/tasks.ts";
import { add, askClaude, POOL_MAX, pool, saveUsage, type Usage } from "../classify/run.ts";
import { poolRoom } from "../agents/call.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { scrub } from "../runner/scrub.ts";
import { cloneTask } from "./tasks.ts";
import { MAX_SUMMARY_WORDS, SUMMARY_LOG_BYTES, type VerifySummaryInput } from "./types.ts";
import { pilotExprFor } from "../pilot.ts";
import { backlogHeldExpr } from "../dupes/held.ts";
import { jobItem } from "../runner/job-items.ts";
import { collectScreenshots, movedRun, screenshotsDue, type ScreenshotDeps } from "./screenshots.ts";
import { mapSeq } from "../async-seq.ts";
import type { AliasableExpression } from "kysely";
import type { Db } from "../db/index.ts";
import { cols, rowArray, type Eb } from "../db/kx.ts";

const PROMPT = CLAUDE_PROMPTS["verify.summary"];
const ACTOR = "verify";
/** The step whose failure says nothing about the change: it only downloads dependencies. */
const FETCH = "fetch deps";
/** An automatic retry per head: the new tasks run once more, then an error stays. */
export const MAX_RETRIES = 1;
export const NOT_FAILING_REASON = "regression test passes on base";
/** The PR's current head, as src/review/candidates.ts headOf picks it: the checks table's when fetched after the mirror last saw the PR change. */
/** The PR's current head as an expression on `i` (items) and `c` (pr_checks, left joined). */
export const currentHeadExpr = (eb: Eb): AliasableExpression<string | null> => eb.case()
  .when(eb.and([eb("c.head_oid", "is not", null), eb("c.fetched_at", "is not", null), eb.or([eb("i.updated_at", "is", null), eb("c.fetched_at", ">", eb.ref("i.updated_at"))])]))
  .then(eb.ref("c.head_oid")).else(eb.fn.coalesce("i.head_oid", "c.head_oid")).end();
const ERROR_LIMIT = 200;

export const VERIFICATION_STATES = ["planned", "running", "passed", "failed", "error", "ci-enough", "stale", "unavailable"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

// ---- reading -----------------------------------------------------------------

export type VerificationTask = { id: number; role: "head" | "base"; state: BuildTask["state"]; results: TaskResult[]; summary: string | null; endedAt: string | null };
export type VerificationView = {
  repo: string; number: number; headSha: string; baseSha: string | null;
  kind: string; reason: string; plan: unknown; model: string | null;
  state: VerificationState;
  /** Why it failed or errored; for a failure written by Haiku. Null otherwise. */
  summary: string | null;
  /** On a pass: what the result does not show, such as a regression test that also passes on the base. */
  note: string | null;
  createdAt: string; finishedAt: string | null;
  /** Head task first, then the base task of a regression. After a retry these are the newest tasks. */
  tasks: VerificationTask[];
};

type Row = {
  repo: string; number: number; head_sha: string; base_sha: string | null; kind: string; reason: string; plan: string | null; model: string | null;
  head_task_id: number | null; base_task_id: number | null; state: VerificationState; summary: string | null; note: string | null;
  created_at: string; finished_at: string | null;
};

async function viewOf(db: Db, r: Row): Promise<VerificationView> {
  const tasks: VerificationTask[] = [];
  for (const [role, id] of [["head", r.head_task_id], ["base", r.base_task_id]] as const) {
    const t = id === null ? null : await getTask(db, id);
    if (t) tasks.push({ id: t.id, role, state: t.state, results: t.results, summary: t.summary, endedAt: t.endedAt });
  }
  let plan: unknown = null;
  try { plan = r.plan === null ? null : JSON.parse(r.plan); } catch { /* stored by our own code; keep null */ }
  return {
    repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha, kind: r.kind, reason: r.reason, plan, model: r.model, state: r.state,
    summary: r.summary, note: r.note, createdAt: r.created_at, finishedAt: r.finished_at, tasks,
  };
}

/** The verification of one PR head, or null. */
export async function verificationOf(db: Db, repo: string, number: number, headSha: string): Promise<VerificationView | null> {
  const r = await db.get(db.k.selectFrom("verifications").select(cols("verifications")).$narrowType<{ state: VerificationState }>()
    .where("repo", "=", repo).where("number", "=", number).where("head_sha", "=", headSha));
  return r ? await viewOf(db, r) : null;
}

/** Verifications in the given states (all when none), newest first. */
export async function listVerifications(db: Db, o: { states?: VerificationState[]; repo?: string; limit?: number } = {}): Promise<VerificationView[]> {
  const rows = await db.all(db.k.selectFrom("verifications").select(cols("verifications")).$narrowType<{ state: VerificationState }>()
    .$if(!!o.states?.length, (q) => q.where("state", "in", o.states!))
    .$if(!!o.repo, (q) => q.where("repo", "=", o.repo!))
    .orderBy("created_at", "desc").orderBy("number", "desc").limit(Math.min(o.limit ?? 100, 1000)));
  return await mapSeq(rows, async (r) => await viewOf(db, r));
}

// ---- when to run -------------------------------------------------------------

/**
 * Whether a collection run has work: a pending verification whose PR head moved or closed, whose tasks are all
 * finished, or that is still `planned` while a task has started. One query on the state index.
 */
export async function collectDue(db: Db): Promise<boolean> {
  const due = db.k.selectFrom("verifications as v")
    .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "v.repo").onRef("i.number", "=", "v.number"))
    .leftJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "v.repo").onRef("c.number", "=", "v.number"))
    .leftJoin("build_tasks as h", "h.id", "v.head_task_id")
    .leftJoin("build_tasks as b", "b.id", "v.base_task_id")
    .select((eb) => eb.lit(1).as("one"))
    .where("v.state", "in", ["planned", "running"])
    .where((eb) => pilotExprFor(db, eb, "v.repo", "v.number"))
    .where((eb) => eb.not(backlogHeldExpr(db, eb, "v")))
    .where((eb) => eb.or([
      eb("i.state", "is distinct from", "OPEN"),
      eb(currentHeadExpr(eb), "is distinct from", eb.ref("v.head_sha")),
      eb.and([eb("h.state", "in", TERMINAL), eb.or([eb("b.id", "is", null), eb("b.state", "in", TERMINAL)])]),
      eb.and([eb("v.state", "=", "planned"), eb.or([eb("h.state", "in", ["claimed", "running"]), eb("b.state", "in", ["claimed", "running"])])]),
    ]))
    .limit(1);
  // Read with the screenshot runs' own check in one statement.
  const r = (await db.get(db.k.selectNoFrom([rowArray(db, due).as("verification"), rowArray(db, movedRun(db)).as("screenshots")])))!;
  return r.verification !== null || await screenshotsDue(db, r.screenshots !== null);
}

// ---- judging tasks -----------------------------------------------------------

export type Outcome =
  | { kind: "pass" }
  | { kind: "fail"; step: string; exitCode: number | null; timedOut: boolean }
  | { kind: "error"; reason: string };

export const oneLine = (s: string): string => scrub(s).replace(/\s+/g, " ").trim().slice(0, ERROR_LIMIT);
const ok = (r: TaskResult): boolean => r.exitCode === 0 && !r.timedOut;

/** What a finished task says, from its state and exit codes. Callers pass only terminal tasks. */
export function outcomeOf(t: BuildTask): Outcome {
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
  if (base.step === "test" && !base.timedOut) return { state: "passed" };
  const limitation = base.step === "test" ? "the base test timed out" : "the base did not build with the test";
  return { state: "passed", note: `Head passed; regression comparison inconclusive: ${limitation}.` };
}

// ---- the run -----------------------------------------------------------------

export type CollectDeps = {
  model: string;
  /** The head commit of a repo's default branch, or null; used to cancel queued warm builds of a branch that moved on. */
  mainHead?: (repo: string, branch: string) => Promise<string | null>;
  /** The screenshot comparison, replaceable in tests. */
  screenshots?: ScreenshotDeps;
};

export type CollectSummary = {
  runId: string; looked: number; passed: number; failed: number; errors: number; retried: number; stale: number; running: number;
  warmCancelled: number; /** Screenshot runs that left planned/running. */ shots: number; /** Verifications that left planned/running, plus warm builds cancelled. */ changed: number;
};

const now = (): string => new Date().toISOString();
const cut = (s: string): string => s.trim().split(/\s+/).slice(0, MAX_SUMMARY_WORDS).join(" ");

async function stageRow(db: Db, v: Row, stage: string, at: string, note: string): Promise<void> {
  await db.run(db.k.insertInto("main.stages").values({ repo: v.repo, number: v.number, stage, at, actor: ACTOR, note: note.slice(0, 300) }));
  if (stage !== "hold") await jobItem(db, v.repo, v.number, note, () => {});   // the caller logs the outcome itself
}

/** The last bytes of the log chunks one step wrote. */
async function stepLog(db: Db, id: number, step: string): Promise<string> {
  const parts: string[] = [];
  let size = 0;
  const rows = await db.all(db.k.selectFrom("build_task_logs").select("chunk").where("task_id", "=", id).where("step", "=", step).orderBy("seq", "desc"));
  for (const c of rows) {
    parts.push(c.chunk);
    size += Buffer.byteLength(c.chunk);
    if (size >= SUMMARY_LOG_BYTES) break;
  }
  const all = Buffer.from(parts.reverse().join(""));
  return all.subarray(-SUMMARY_LOG_BYTES).toString("utf8");
}

const fallbackSummary = (f: NonNullable<Verdict["failed"]>): string =>
  `${f.step} ${f.timedOut ? "timed out" : `failed with exit code ${f.exitCode ?? "none"}`}`;

/** Haiku's account of a failed step, or null. The log and the command are untrusted and scrubbed before they leave and before the reply is stored. */
export async function summariseFailure(db: Db, v: { repo: string; number: number }, taskId: number, f: NonNullable<Verdict["failed"]>, deps: CollectDeps, runId: string): Promise<string> {
  const task = await getTask(db, taskId);
  const step = task?.plan.find((s: TaskStep) => s.name === f.step);
  const input: VerifySummaryInput = {
    ref: `${v.repo}#${v.number}`, step: f.step, command: scrub((step?.cmd ?? []).join(" ")), log: scrub(await stepLog(db, taskId, f.step)),
  };
  const start = now();
  const reply = await askClaude("verify.summary", deps.model, [input], db);
  await saveUsage(db, runId, `verify-collect-${v.number}`, "verify", deps.model, reply ? 1 : 0, reply?.usage ?? ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as Usage), start, now());
  const text = reply ? scrub(cut(reply.text)) : "";
  return text || fallbackSummary(f);
}

/** Cancels the tasks of a verification that are not finished. */
export async function cancelOpen(db: Db, ids: (number | null)[]): Promise<void> {
  for (const id of ids) {
    const t = id === null ? null : await getTask(db, id);
    if (t && !TERMINAL.includes(t.state)) await cancelTask(db, t.id, ACTOR);
  }
}

/** Head tasks created for this head: the first plus one per retry. */
const retriesOf = async (db: Db, v: Row): Promise<number> =>
  (await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("step", "=", "verify").where("repo", "=", v.repo).where("number", "=", v.number).where("head_sha", "=", v.head_sha).where("warm_role", "=", "use")))!.n - 1;

export async function runCollect(db: Db, params: { dryRun?: boolean; /** True when no new item should start (cancel, deadline, pipeline off). */ stopping?: () => Promise<boolean> } = {}, log: (line: string) => void = console.log, deps?: CollectDeps): Promise<CollectSummary> {
  const d: CollectDeps = deps ?? { model: PROMPT.models[0]!, mainHead: (await import("./index.ts")).defaultDeps().mainHead };
  const runId = `verify-collect-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  const s: CollectSummary = { runId, looked: 0, passed: 0, failed: 0, errors: 0, retried: 0, stale: 0, running: 0, warmCancelled: 0, shots: 0, changed: 0 };
  const rows = await db.all(db.k.selectFrom("verifications as v")
    .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "v.repo").onRef("i.number", "=", "v.number"))
    .leftJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "v.repo").onRef("c.number", "=", "v.number"))
    .select((eb) => [...cols("verifications", "v"), "i.state as item_state", currentHeadExpr(eb).as("item_head")])
    .$narrowType<{ state: VerificationState }>()
    .where("v.state", "in", ["planned", "running"])
    .where((eb) => pilotExprFor(db, eb, "v.repo", "v.number"))
    .where((eb) => eb.not(backlogHeldExpr(db, eb, "v")))
    .orderBy("v.created_at").orderBy("v.number"));
  s.looked = rows.length;
  if (params.dryRun) { log(`verify-collect: ${rows.length} pending; dry run`); return s; }

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
      const finish = async (state: string, summary: string | null, note: string | null): Promise<boolean> => {
        const r = await db.run(db.k.updateTable("verifications").set({ state, summary, note, finished_at: now() })
          .where("repo", "=", v.repo).where("number", "=", v.number).where("head_sha", "=", v.head_sha).where("state", "in", ["planned", "running"]));
        const changed = Number(r.changes) > 0;
        if (changed && (state === "failed" || state === "error")) await setAsideAnswerBeforeFailure(db, v.repo, v.number, v.head_sha, now());
        return changed;
      };

      if (v.item_state !== "OPEN" || v.item_head !== v.head_sha) {
        await cancelOpen(db, [v.head_task_id, v.base_task_id]);
        if (await finish("stale", v.summary, v.note)) { s.stale++; s.changed++; await jobItem(db, v.repo, v.number, `stale (${v.item_state === "OPEN" ? "head moved" : "no longer open"})`, log); }
        return;
      }

      const head = v.head_task_id === null ? null : await getTask(db, v.head_task_id);
      const base = v.base_task_id === null ? null : await getTask(db, v.base_task_id);
      const tasks = [head, base].filter((t): t is BuildTask => t !== null);
      if (!head) {
        if (await finish("error", "the build task is gone", null)) { s.errors++; s.changed++; await stageRow(db, v, "verify-error", now(), `${v.kind} at ${v.head_sha.slice(0, 7)}: the build task is gone`); }
        return;
      }
      if (tasks.some((t) => !TERMINAL.includes(t.state))) {
        if (v.state === "planned" && tasks.some((t) => t.state === "claimed" || t.state === "running")) {
          await db.run(db.k.updateTable("verifications").set({ state: "running" })
            .where("repo", "=", v.repo).where("number", "=", v.number).where("head_sha", "=", v.head_sha).where("state", "=", "planned"));
          s.running++; s.changed++;
        }
        return;
      }

      const verdict = verdictOf(outcomeOf(head), base ? outcomeOf(base) : null);
      const at = now();
      const sha7 = v.head_sha.slice(0, 7);

      if (verdict.state === "error" && await retriesOf(db, v) < MAX_RETRIES) {
        try {
          const ids = await mapSeq([v.head_task_id, v.base_task_id], async (id) => (id === null ? null : await cloneTask(db, id)));
          await db.run(db.k.updateTable("verifications").set({ head_task_id: ids[0] ?? null, base_task_id: ids[1] ?? null, state: "planned" })
            .where("repo", "=", v.repo).where("number", "=", v.number).where("head_sha", "=", v.head_sha));
          s.retried++; s.changed++;
          await jobItem(db, v.repo, v.number, `${verdict.reason}; queued the tasks again`, log);
          return;
        } catch (e) {
          if (!(e instanceof BuildError)) throw e;
          verdict.reason = `${verdict.reason}; tasks not queued again: ${e.message}`;
        }
      }

      if (verdict.state === "passed") {
        if (await finish("passed", null, verdict.note ?? null)) {
          s.passed++; s.changed++;
          await stageRow(db, v, "verified", at, `${v.kind} at ${sha7} passed${verdict.note ? `: ${verdict.note}` : ""}`);
        }
      } else if (verdict.state === "error") {
        const why = oneLine(verdict.reason ?? "error");
        if (await finish("error", why, null)) { s.errors++; s.changed++; await stageRow(db, v, "verify-error", at, `${v.kind} at ${sha7}: ${why}`); }
      } else {
        const summary = verdict.failed ? await summariseFailure(db, v, v.head_task_id!, verdict.failed, d, runId) : oneLine(verdict.reason ?? "failed");
        if (await finish("failed", summary, null)) {
          s.failed++; s.changed++;
          await stageRow(db, v, "verify-failed", at, `${v.kind} at ${sha7}: ${summary}`);
          await stageRow(db, v, "hold", at, `verify failed: ${summary}`);
        }
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
  s.warmCancelled = await cancelMovedWarmBuilds(db, d, log);
  s.changed += s.warmCancelled;
  log(`verify-collect: ${s.looked} pending: ${s.passed} passed, ${s.failed} failed, ${s.errors} errors, ${s.retried} retried, ${s.stale} stale, ${s.running} running; ${s.warmCancelled} warm builds cancelled`);
  return s;
}

/** Cancels queued warm builds whose branch head is no longer the commit they would build. */
async function cancelMovedWarmBuilds(db: Db, d: CollectDeps, log: (line: string) => void): Promise<number> {
  if (!d.mainHead) return 0;
  const queued = await db.all(db.k.selectFrom("build_tasks as t").leftJoin("repos as r", "r.name", "t.repo")
    .select(["t.id", "t.repo", "t.head_sha", "r.default_branch"]).where("t.warm_role", "=", "build").where("t.state", "=", "queued").orderBy("t.id"));
  let n = 0;
  for (const t of queued) {
    const main = await d.mainHead(t.repo, t.default_branch ?? "main");
    if (main && main !== t.head_sha) { await cancelTask(db, t.id, ACTOR); n++; log(`  warm build ${t.id} of ${t.repo}: ${t.default_branch ?? "main"} moved on; cancelled`); }
  }
  return n;
}
