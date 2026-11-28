// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { registerKeySource } from "../keys.ts";
import { approvedOf } from "./sql.ts";

const one = (eb: kx.AnyEb) => eb.lit(1).as("one");
const ENDED = ["done", "failed", "cancelled"];

/** A job (in any of `o.states`, of `o.steps`) names the item in its params. */
export function jobsOfItems(db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, o: { states?: string[]; steps?: string[] } = {}): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb);
  return eb.exists(t.selectFrom("main.jobs as jj").select(one(eb))
    .$if(!!o.states, (b) => b.where("jj.state", "in", o.states!)).$if(!!o.steps, (b) => b.where("jj.step", "in", o.steps!))
    .where((e) => e.and([e(kx.jsonText(db, "jj.params", "$.repo"), "=", kx.exprOf(eb, repo)), e(kx.jsonNum(db, "jj.params", "$.number"), "=", kx.exprOf(eb, number))])));
}

/** A queued or running job names the item in its params. */
export const activeJobOfItem = (db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, steps?: string[]): AliasableExpression<SqlBool> =>
  jobsOfItems(db, eb, repo, number, { states: ["queued", "running"], steps });

/** A queued or running job of one of `steps` works on the finding `repoRef#numberRef` (the `NOT EXISTS (jobs ...)` guards of the security steps). */
export const liveJobOfFinding = (db: Db, eb: kx.AnyEb, steps: string[], repoRef: kx.Ex, numberRef: kx.Ex): AliasableExpression<SqlBool> =>
  jobsOfItems(db, eb, repoRef, numberRef, { states: ["queued", "running"], steps });

/** The job in `jobIdRef` has ended (done, failed or cancelled). */
export const jobEnded = (eb: kx.AnyEb, jobIdRef: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.jobs as je").select(one(eb)).where("je.id", "=", kx.exprOf(eb, jobIdRef)).where("je.state", "in", ENDED));

/** The job in `jobIdRef` is of the approved lane: a person started or approved the PR it works on (src/runner/concurrency.ts). */
export const approvedLaneJob = (db: Db, eb: kx.AnyEb, jobIdRef: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.jobs as ja").select(one(eb)).where("ja.id", "=", kx.exprOf(eb, jobIdRef)).where((e) => approvedOf(db, e, "ja.params")));

/** The repo of the job in `jobIdRef`. */
export const jobRepoOf = (eb: kx.AnyEb, jobIdRef: kx.Ex): Expression<string | null> =>
  kx.schemaEb(eb).selectFrom("main.jobs as jr").select("jr.repo").where("jr.id", "=", kx.exprOf(eb, jobIdRef)) as unknown as Expression<string | null>;

/** Scalar: the state of the job in `jobIdRef` (null when there is none). */
export const jobStateOf = (eb: kx.AnyEb, jobIdRef: kx.Ex): AliasableExpression<string | null> =>
  kx.schemaEb(eb).selectFrom("main.jobs as jsx").select("jsx.state").where("jsx.id", "=", kx.exprOf(eb, jobIdRef)) as unknown as AliasableExpression<string | null>;

/** Ids of jobs waiting in the queue to resume. */
export const resumingJobs = (db: Db) => queryDb(db).k.selectFrom("main.jobs").select("id").where("state", "=", "queued").where("resumes", ">", 0);

/** A `remote_calls` row (unaliased in the enclosing statement) of an earlier run of a resumed job that has not ended: it waits for adoption, with no caller polling it. */
export const earlierRunCall = (_db: Db, eb: kx.AnyEb): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.jobs as j").select(one(eb)).where("j.id", "=", kx.ref<number>("remote_calls.job_id")).where("j.resumes", ">", 0)
    .where((e) => e.or([e("j.state", "=", "queued"), e.and([e("j.state", "=", "running"),
      e(kx.ref<number>("remote_calls.since"), "<", e(e.parens(e.fn<number>("julianday", [e.ref("j.started_at")]), "-", e.lit(2440587.5)), "*", e.lit(86400000)))])])));

/** Sum of `items` of jobs of `step` started at or after `sinceRef`, as a scalar (0 when none). */
export const itemsSumSince = (eb: kx.AnyEb, step: string, sinceRef: kx.Ex): Expression<number> =>
  kx.schemaEb(eb).selectFrom("main.jobs as js").select((e) => e.fn.coalesce(e.fn.sum<number>("js.items"), e.lit(0)).as("n")).where("js.step", "=", step).where("js.started_at", ">=", kx.exprOf(eb, sinceRef)) as unknown as Expression<number>;

/** Error text of jobs a runner stop or restart ended without resuming them; the planner does not count them as failures. */
export const RUNNER_STOPPED = "The runner stopped while this job ran; start it again if needed.";
/** Error text of a job whose model call no Task Runner took within the queue's wait limit (src/remote/calls.ts). */
export const CALL_WAIT_LIMIT = "no user-local helper took the call in time";
/** Errors of AutoCraft's services that say nothing about the work: an HTTP 5xx answer, a network error. */
export const INFRA_ERROR = /\bHTTP\/?[\d.]* ?5\d\d\b|\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error)\b|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|ENOTFOUND|EAI_AGAIN/i;
/**
 * A failed model call's error that says nothing about the model's work: its Task Runner went quiet or never started it (the lease
 * expiries of src/data/runners), the runner stopped, the call row went away, or a service error. A call past its time limit is the model's.
 */
export const lostCallError = (error: string): boolean =>
  /^lease expired: (?:no heartbeat|still preparing)|^The runner stopped during this call\.$|^the call is gone$/.test(error) || INFRA_ERROR.test(error);

/** The items one job handled: `{ jobId }`, for `mirror.loadShown` in the same statement as the job's items. */
registerKeySource<{ jobId: number }>("jobs.itemsOfJob", (db, a) => queryDb(db).k.selectFrom("job_items").select(["repo", "number"]).where("job_id", "=", a.jobId));
/** The items of several jobs. */
registerKeySource<{ jobIds: number[] }>("jobs.itemsOfJobs", (db, a) => queryDb(db).k.selectFrom("job_items").select(["repo", "number"]).where(kx.inList(db, "job_id", a.jobIds, "bigint")));
