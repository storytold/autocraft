// The jobs table: requests from the dashboard, the CLI and the autopilot, state written by the runner. Shared by the API,
// the runner and the CLI. Reads and writes go through src/data/jobs; how a job ends, resumes or is cancelled is in lifecycle.ts.
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import type { Job, JobDetail, JobFilter, JobList, JobParams, JobState, JobUsage } from "../../web/src/api/types.ts";
import type { HiddenRepos } from "../data/control/index.ts";
import { enqueueJobs, listJobs as loadJobPage, loadJobDetail, loadJobs, loadPrunable, removeJobs, type JobRow } from "../data/jobs/index.ts";
import { trackedNames } from "../repos.ts";
import { knownStep, loadSteps, modelsOf, ParamError, validateParams, type StepDef } from "./steps.ts";
import { untakenTest, type UntakenTest } from "./concurrency.ts";
import { cancelJob, JobError } from "./lifecycle.ts";
import { scrub } from "./scrub.ts";
import { storedLogTail } from "./job-log.ts";
import { blankIfHidden } from "../dash/api/visible.ts";
import type { Db } from "../db/index.ts";

export { DEADLINE_ERROR, endJob, JobError, now, resumeJob, RUNNER_STOPPED } from "./lifecycle.ts";
export { scrub };
export type { JobRow };

export const JOB_STATES: JobState[] = ["queued", "running", "done", "failed", "cancelled"];
/** Requester of a job that a command line queues for the runner to run (`workspace try`), as opposed to a command-line run (`cli`). */
export const CLI_QUEUE_BY = "cli-queue";

function parseJson<T>(s: string | null, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** `waiting`: why the queued job does not start (see `toJobs` for a page of jobs). `accounts` is empty: server accounts are retired. */
export function toJob(r: JobRow, waiting: string | null = null): Job {
  const params = parseJson<JobParams>(r.params, {});
  return {
    id: r.id, step: r.step, params, requestedBy: r.requested_by, requestedAt: r.requested_at,
    state: r.state, startedAt: r.started_at, endedAt: r.ended_at, progress: r.progress, summary: r.summary, error: r.error,
    cancelRequested: r.cancel_requested_at !== null, usage: parseJson<JobUsage | null>(r.usage, null),
    models: modelsOf(knownStep(r.step), params), waiting,
  };
}

/** Jobs, and for a queued job that no Task Runner may take, the reason (the Task Runners are read once, at the first queued job). */
export async function toJobs(db: Db, rows: JobRow[]): Promise<Job[]> {
  let untaken: UntakenTest | undefined;
  const out: Job[] = [];
  for (const r of rows) out.push(toJob(r, r.state === "queued" ? await (untaken ??= await untakenTest(db))(r) : null));
  return out;
}

export async function jobRow(db: Db, id: number): Promise<JobRow | undefined> {
  return (await loadJobs(db, [id])).get(id);
}

export async function getJob(db: Db, id: number): Promise<Job> {
  const r = await jobRow(db, id);
  if (!r) throw new JobError(404, `no job ${id}`);
  return (await toJobs(db, [r]))[0]!;
}

export async function listJobs(db: Db, f: JobFilter = {}, hidden: HiddenRepos = []): Promise<JobList> {
  const { rows, total } = await loadJobPage(db, { step: f.step, state: f.state, limit: f.limit ?? 50, offset: f.offset ?? 0, hidden });
  return { jobs: await toJobs(db, rows), total };
}

async function stepOf(name: unknown): Promise<StepDef> {
  const step = typeof name === "string" ? (await loadSteps()).get(name) : undefined;
  if (!step) throw new JobError(400, "no such step");
  return step;
}

/** Validated params for a step, or a 400. `names`: the tracked repos, when the caller read them. */
export async function checkRequest(db: Db, stepName: unknown, rawParams: unknown, names?: string[]): Promise<{ step: StepDef; params: JobParams }> {
  const step = await stepOf(stepName);
  let params: JobParams;
  try {
    params = validateParams(step, rawParams, names ?? await trackedNames(db));
  } catch (e) {
    if (e instanceof ParamError) throw new JobError(400, e.message);
    throw e;
  }
  // A lane job works the one item it names.
  if (params.lane !== undefined && params.lane !== "" && typeof params.number !== "number") throw new JobError(400, "a job with a lane needs its item (number)");
  const why = step.available?.() ?? null;
  if (why) throw new JobError(409, why);
  const refused = step.check ? await step.check(db, params) : null;
  if (refused) throw new JobError(409, refused);
  return { step, params };
}

/**
 * Queues a job. The same step with the same params already waiting is refused.
 */
export async function enqueue(db: Db, stepName: unknown, rawParams: unknown, by: string): Promise<Job> {
  const { step, params } = await checkRequest(db, stepName, rawParams);
  const repo = typeof params.repo === "string" ? params.repo : null;
  const { queued } = await enqueueJobs(db, [{ step: step.name, params, repo, by }]);
  const id = queued.get(0);
  if (id === undefined) throw new JobError(409, `${step.name} with these settings is already queued`);
  return await getJob(db, id);
}

/** A queued job is cancelled at once; a running one is marked and the runner stops it. */
export async function requestCancel(db: Db, id: number, by: string): Promise<Job> {
  await cancelJob(db, id, by);
  return await getJob(db, id);
}

/** Finished jobs and their log files are kept this long; audit and token_usage are kept for good. */
export const JOB_KEEP_MS = 3650 * 24 * 3600_000;

/** Deletes finished jobs that ended more than JOB_KEEP_MS ago, with their log files. Returns the number of jobs. */
export async function pruneJobs(db: Db, nowMs: number = Date.now()): Promise<number> {
  const before = new Date(nowMs - JOB_KEEP_MS).toISOString();
  let n = 0;
  for (;;) {
    const rows = await loadPrunable(db, before, 1000);
    if (!rows.length) return n;
    for (const r of rows) {
      if (r.log_path) {
        try {
          unlinkSync(r.log_path);
        } catch {
          // already gone
        }
      }
    }
    n += await removeJobs(db, rows.map((r) => r.id));
  }
}

// ---- logs ----------------------------------------------------------------------

export const LOG_TAIL_BYTES = 48 * 1024;

/** The end of a job's log: from its log file when this process can read it (it shares the runner's disk), else as the runner stored it. */
export async function jobLogTail(db: Db, id: number, path: string | null, bytes = LOG_TAIL_BYTES): Promise<{ log: string; logTruncated: boolean }> {
  const local = logTail(path, bytes);
  if (local) return local;
  const stored = await storedLogTail(db, id, bytes);
  return stored ? { log: scrub(stored.log), logTruncated: stored.logTruncated } : { log: "", logTruncated: false };
}

/** The end of a log file; null when there is none to read here. */
export function logTail(path: string | null, bytes = LOG_TAIL_BYTES): { log: string; logTruncated: boolean } | null {
  if (!path) return null;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { log: scrub(text), logTruncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * `hidden`: the repos the viewer may not see. A job of such a repo is not found.
 * `logs` false (viewers) leaves the log out: its lines can name hidden items and carry command output. For other readers the lines
 * that name a hidden repo are left out (a job without a repo, or a step that reads other repos, logs items of every repo it worked).
 */
export async function jobDetail(db: Db, id: number, view: { hidden?: HiddenRepos; logs?: boolean } = {}): Promise<JobDetail> {
  const hidden = view.hidden ?? [];
  const d = await loadJobDetail(db, id, { hidden, logs: view.logs !== false });
  if (!d) throw new JobError(404, `no job ${id}`);
  const items = d.items.map((i) => ({ repo: i.repo, number: i.number, ...(d.shown.get(`${i.repo}#${i.number}`) ?? { kind: null, state: null, title: null }), outcome: i.outcome }));
  const job = (await toJobs(db, [d.row]))[0]!;
  if (view.logs === false) return { ...job, items, log: null, logTruncated: false, canCancel: false };
  const tail = await jobLogTail(db, id, d.row.log_path);
  return { ...job, items, canCancel: false, ...tail, log: tail.log && hidden.length ? tail.log.split("\n").filter((l) => !l || blankIfHidden(l, hidden)).join("\n") : tail.log };
}
