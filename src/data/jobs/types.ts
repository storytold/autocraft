import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { HiddenRepos } from "../control/types.ts";
import type { RefKey } from "../mirror/types.ts";

export type { HiddenRepos, RefKey };

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";
/** A `jobs` row with `state` typed. */
export type JobRow = Omit<Selectable<DB["jobs"]>, "state"> & { state: JobState };
export type NewJob = { step: string; params: Record<string, unknown>; repo: string | null; by: string };
export type LiveJob = { id: number; step: string; state: JobState; repo: string | null; number: number | null; params: string; items: number | null; requested_by: string; resumes: number; cancel_requested_at: string | null; started_at: string | null; pid: number | null };
export type QueuedJob = { id: number; step: string; repo: string | null; params: string; limit: number | null; requested_by: string; resumes: number };
export type RunningState = { id: number; cancel_requested_at: string | null; error: string | null; started_at: string | null; queued: boolean; lastLeaseAt: number | null };
export type LogCursor = { lastSeq: number; lastNextStart: number; bytes: number[] };
export type JobPatch = { progress?: string | null; items?: number; acted?: number };
/** What `openJobPulse` needs of the claimed row: a resumed job's counts add to those of its earlier runs. */
export type PulseRow = Pick<JobRow, "id"> & Partial<Pick<JobRow, "items" | "acted" | "resumes" | "started_at">>;
export type JobFlags = { cancel_requested_at: string | null; error: string | null; started_at: string | null };
export type JobResult = { usage?: string | null; summary?: string | null; error?: string | null; leaseSkips?: number; leaseSkipKeys?: string[]; /** What the pulse had not written yet (`JobPulse.end`). */ patch?: JobPatch; stats?: { statements: number; roundTrips: number; ms: number; effects: number } };

/** Buffered progress writer of one running job (replaces `ctx.progress`, `handled`, `acted`, `cancelled`, `timeUp`). */
export interface JobPulse {
  progress(text: string): void;
  handled(n: number): void;
  acted(n: number): void;
  cancelled(): Promise<boolean>;
  timeUp(sliceMs: number): Promise<boolean>;
  /** Writes the buffered job items and waits for a pulse under way; the progress and counts not written yet, for the final write. */
  end(): Promise<JobPatch>;
}

export type JobItemRow = { id: number; job_id: number; repo: string; number: number; outcome: string | null; at: string };
export type NewJobItem = { job_id: number; repo: string; number: number; outcome: string; at: string };
export type ItemJobRow = { /** The `job_items` row. */ id: number; job_id: number; step: string; state: JobState; outcome: string | null; at: string; ended_at: string | null; error: string | null };
export type JobLeaseOwner = { id: number; step: string };
export type LogChunkRow = Selectable<DB["job_log_chunks"]>;
export type LogDrop = { job: number; upTo: number };
export type LogTail = { log: string; logTruncated: boolean };

export type JobDetail = { row: JobRow; items: JobItemRow[]; shown: Map<RefKey, import("../mirror/types.ts").ItemShown>; logTail: LogTail | null };
/** A job taken by `claimCliJob`: the row id and the log file the command writes. */
export type CliJob = { id: number; logPath: string };
export type LiveBoard = { running: JobRow[]; queued: JobRow[]; recent: JobRow[]; items: Map<number, JobItemRow[]> };
export type StageState = "running" | "queued" | "ok" | "failed" | "idle";
export type ActiveJob = { id: number; step: string; state: JobState; requested_by: string; started_at: string | null };
export type FailedJob = { id: number; step: string; error: string | null; ended_at: string | null };
export type JobStamp = { count: number; newestId: number | null; states: string; positions: Map<number, number> };
export type StepRun = { id: number; step: string; repo: string | null; state: JobState; error: string | null; ended_at: string | null };
export type DeadlineStop = { step: string; jobId: number; error: string; endedAt: string | null; count: number };
export type ItemsByBucket = { step: string; bucket: string; items: number };

/** `lane_number`: the PR of a job of a per-item lane (approved or item), null for every other job. */
export type EndedJob = { step: string; repo: string | null; requested_by: string; id: number; state: JobState; error: string | null; ended_at: string | null; items: number | null; acted: number | null; lease_skips: number | null; lease_skip_keys: string | null; lane_number: number | null };
export type StreakRow = { step: string; repo: string | null; id: number; state: JobState; error: string | null; ended_at: string | null; lane_number: number | null };
export type FpRecord = { job: number | null; fp: string };
/** A live workflow whose check, or the write of what it found, failed several passes in a row: since when, and the latest error (operators only). */
export type WorkflowFailure = { id: number; ref: string; since: string; error: string };
export type LaneInputs = {
  live: LiveJob[];
  usedToday: Map<string, number>;
  ends: EndedJob[];
  streaks: StreakRow[];
  fps: Map<string, FpRecord>;
  resets: Map<string, string>;
  heldLeaseKeys: Set<string>;
  marks: Map<string, string>;
};
export type LaneStateKind = "fp" | "reset" | "cursor" | "mark";
export type LaneStateRow = { kind: LaneStateKind; step: string; repo: string; value: string; job_id: number | null; at: string };
export type LaneStatePut = { kind: LaneStateKind; step: string; repo?: string; value: string; job_id?: number | null };
/** `items` are the planner's lane items, stored as JSON. */
export type StoredLane = { lane: string; total: number; items: unknown[]; at: string };
export type StoredLaneItems = Map<string, StoredLane>;

export type StatRow = { scope: string; minute: string; statements: number; round_trips: number; ms: number; calls: number };
export type StepQueryStat = { step: string; items: number; effects: number; statements: number; round_trips: number; ms: number; started_at: string };
