// Jobs that a runner stop or restart interrupted go back to the queue under the same id (resumeJob in lifecycle.ts) and run
// again from the start. Their remote calls stay: the resumed run adopts the call it makes again with the same bundle
// (enqueueCall), and a reply a Task Runner sent meanwhile is read from the row. Their successful GitHub writes are not
// made again (src/github/write.ts). Local model calls and local steps simply run again.
import type { Db } from "../db/index.ts";
import { loadJobs } from "../data/jobs/index.ts";

/** A job may resume this many times after an unclean stop (a crash or a kill without the stop signal), which a job that takes the runner down repeatedly causes; a stop past that fails it with RUNNER_STOPPED. */
export const MAX_RESUMES = 2;
/** A job may resume this many times in all, graceful restarts (deploys) included: a backstop against an endless loop. A graceful resume of a job that only waits for a Task Runner to take a queued call (no call leased) is not limited: waiting costs nothing and the resumed run adopts the call again. */
export const MAX_TOTAL_RESUMES = 12;

/** For a job that resumed: when its current run started (work recorded before that belongs to an earlier run). Null for a job that never resumed. */
export async function resumedRun(db: Db, jobId: number): Promise<{ resumes: number; startedAt: string } | null> {
  const r = (await loadJobs(db, [jobId])).get(jobId);
  return r && Number(r.resumes) > 0 && r.started_at ? { resumes: Number(r.resumes), startedAt: r.started_at } : null;
}

/**
 * A token_usage run id that is one job's own: each resumed run gets its own, so the rows of an earlier run (keyed by run
 * id and agent, which restart with the run) are kept beside the later run's.
 */
export const jobRunId = (prefix: string, job: { id: number; resumes: number }): string => (job.resumes ? `${prefix}-${job.id}-r${job.resumes}` : `${prefix}-${job.id}`);
