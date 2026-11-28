import type { RefKey } from "../mirror/types.ts";
import type { HiddenRepos } from "../control/types.ts";
import type { BuildTask, TaskResult, TaskStep } from "../../../web/src/api/types.ts";
import type { ArtifactRow, Warm } from "../build/types.ts";

export type { RefKey };
/** `repo#number@head`. */
// `repo#number@head`; mirror/types.ts has no HeadRef.
export type HeadRef = string;

export const BATCH_STATES = ["checking", "open", "merged", "failed", "split", "superseded"] as const;
export type BatchState = (typeof BATCH_STATES)[number];
/** States of a batch that is still being worked on. */
export const ACTIVE_BATCH: BatchState[] = ["checking", "open"];
/** Summary of a batch whose PR a person closed. */
export const CLOSED_BY_PERSON = "the batch PR was closed by a person";
/** Summary of a batch that failed because a maintainer requested changes on its PR. */
export const BLOCKED_BY_REVIEW = "a maintainer requested changes on the batch PR";
/** Summary prefix of a batch whose branch could not be pushed or PR opened: its PRs go back to the queue. */
export const PUBLISH_FAILED = "could not open the batch PR";
export const MAX_BATCH = 50;
/** A repo's batch size until its batches pass or fail. */
export const START_BATCH = 20;
export const VERIFICATION_STATES = ["planned", "running", "passed", "failed", "error", "ci-enough", "stale", "unavailable"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export type BatchMember = { number: number; head_oid: string };
export type BatchRow = {
  id: number; repo: string; branch: string; state: BatchState; base_sha: string; commit_sha: string; parent_id: number | null;
  task_id: number | null; retries: number; pr_number: number | null; pr_url: string | null; summary: string | null; created_at: string; updated_at: string;
  /** `<owner>/<repo>` the branch was pushed to; null before the push. */
  fork: string | null;
  build_state?: "pending" | "passed" | "failed" | "skipped" | null;
  build_tries?: number;
  merge_sha?: string | null;
  ci_reruns?: number;
  ci_rerun_at?: string | null;
  /** When the first batch PR of its lineage opened: upstream CI started then. A rebuild carries its parent's. */
  opened_at?: string | null;
  /** 1: built by a top-up or a rebuild of one; a lineage is topped up at most once. */
  topped_up?: number;
};
export type BatchView = BatchRow & { members: BatchMember[] };
export type BatchRun = { active: BatchView[]; size: number };
export type BatchPatch = Partial<Pick<BatchRow, "state" | "commit_sha" | "task_id" | "retries" | "pr_number" | "pr_url" | "summary" | "fork" | "merge_sha" | "build_state" | "build_tries" | "ci_reruns" | "ci_rerun_at" | "base_sha" | "opened_at">>;
export type NewBatch = {
  repo: string; baseSha: string; commitSha: string; parentId: number | null; taskId: number | null; members: BatchMember[]; at: string;
  build: "pending" | "skipped" | null; runId: string; prs: number[];
  /** The batch is a top-up, or a rebuild of one. */
  toppedUp?: boolean;
  /** When the first batch PR of its lineage opened (a rebuild carries its parent's). */
  openedAt?: string;
};
export type StageRow = { repo: string; number: number; stage: string; at: string; actor: string | null; note: string | null };
/** An audit row a caller hands a writer: `target` is `repo#number`, `repo:branch` or null. */
export type AuditRow = { at: string; actor: string; action: string; target: string | null; details?: unknown };

export type MergeAttempt = { outcome: "merged" | "refused"; reason: string | null; ci: string | null; mergeable: string | null; at: string; refusals: number; path: string; method: string | null };
export type MergedInfo = { firstAt: string; lastAt: string; lastHead: string; method: string | null; viaBatch: boolean; last: { outcome: string; reason: string | null } };
export type MergeRow = { rowid: number; repo: string; number: number; head: string; runId: string; at: string; path: string; method: string | null; outcome: string; reason: string | null; ci: string | null; mergeable: string | null };
export type AttemptInput = {
  repo: string; number: number; head: string; runId: string; at: string; path: "rule" | "maintainer"; method: string | null;
  outcome: "merged" | "refused"; reason: string | null; ci: string | null; mergeable: string | null; note?: string; markReread?: boolean; batch?: string;
};
export type WaitingRun = { id: number; name: string; event: string };
export type RunApproval = { head: string; runs: WaitingRun[]; approved: number[]; reread: boolean; failed: Record<string, number>; crossRepo: boolean; checkedAt: string; approvedAt: string | null };
/** `errors`: the runs at the head made over an errored verification (src/core/rules.ts verifyRetryAt). */
export type VerificationFact = { head: string; state: VerificationState; kind: string; summary: string | null; note: string | null; finishedAt: string | null; errors: number };
export type UnknownState = { head: string; since: string; reads: number; rereads: number; stuck: boolean };
/** `membersReviewed`: every member has a final take or take-fix review at its batched head, the head of its newest verdict review, or is approved for merge and handed over at that head with a clean pre-merge review. */
export type BatchOfPr = { id: number; repo: string; branch: string; state: BatchState; commitSha: string; prNumber: number | null; members: BatchMember[]; membersReviewed: boolean };
export type MergeFacts = {
  /** Newest attempt per ref and head, with the count of refused attempts at that head. */
  attempts: Map<HeadRef, MergeAttempt>;
  merged: Map<RefKey, MergedInfo>;
  verifications: Map<HeadRef, VerificationFact>;
  /** One row per PR; the key carries its head. */
  runs: Map<HeadRef, RunApproval>;
  unknown: Map<RefKey, UnknownState>;
  batchStates: Map<HeadRef, "batch-checking" | "in-batch" | "batch-failed">;
  /** When the batch of each `batch-failed` head failed. */
  batchFailedAt: Map<HeadRef, string>;
  /** Heads whose screenshots show a clear regression, and when that was found. */
  regressions: Map<HeadRef, { summary: string | null; at: string }>;
  /** Members of a checking or open batch. */
  activeBatched: Set<RefKey>;
  /** The active batch each of its integration PRs belongs to, members in order. */
  integration: Map<RefKey, BatchOfPr>;
  /** Refs that are, or were, the PR of some batch. */
  batchPrs: Set<RefKey>;
};
export type BatchMembership = { batchId: number; state: string; branch: string; prNumber: number | null };
export type BatchPageView = { batch: BatchView; parent: BatchState | null; children: { id: number; createdAt: string }[] };
export type BatchListRow = BatchView & { areas: string[] };
export type { HiddenRepos };
export type BatchByTask = { id: number; repo: string; branch: string; commitSha: string; baseSha: string; fork: string | null; members: number[] };
export type BatchDue = { repo: string; id: number; memberRefs: RefKey[] };
export type BatchEnd = { id: number; state: "superseded" | "merged" | "failed"; summary: string | null; stage?: StageRow[]; audit?: AuditRow[] };
export type BatchUpdate = { id: number; at: string; set: BatchPatch; onlyIf?: BatchState[]; size?: "grow" | "shrink" };
export type BatchLanded = { batchId: number; runId: string; at: string; mergeSha: string; members: { number: number; head: string; path: string; ci: string | null; mergeable: string | null }[]; by: string };

export type VerificationTask = { id: number; role: "head" | "base"; state: BuildTask["state"]; plan: TaskStep[]; results: TaskResult[]; summary: string | null; endedAt: string | null };
export type VerificationView = {
  repo: string; number: number; headSha: string; baseSha: string | null; kind: string; reason: string; plan: unknown; model: string | null;
  state: VerificationState; summary: string | null; note: string | null; createdAt: string; finishedAt: string | null; tasks: VerificationTask[];
};
export type PendingVerification = VerificationView & { itemState: "OPEN" | "CLOSED"; currentHead: string | null; inScope: boolean; headTask: number | null; baseTask: number | null };
export type SavedVerification = {
  repo: string; number: number; headSha: string; baseSha: string | null; kind: string; reason: string; plan: unknown; model: string | null;
  headTaskId: number | null; baseTaskId: number | null; state: VerificationState; summary: string | null; note: string | null; at: string; finishedAt: string | null; stage?: StageRow;
};
export type VerificationSettle = { key: HeadRef; from: VerificationState[]; set: { state: VerificationState; summary?: string | null; note?: string | null; finishedAt?: string | null }; stage?: StageRow };
/** `screenshots` is true when a run in flight moved or its tasks ended; `shotRepos` are the repos with a run in flight, for the caller to check their switches. */
export type VerifyDue = { verifications: boolean; screenshots: boolean; shotRepos: string[] };

export type PrBuildView = {
  repo: string; number: number; headSha: string; baseSha: string | null; scope: string; taskId: number | null; retried: number; state: string;
  summary: string | null; ciOverall: string | null; disagree: boolean; createdAt: string; finishedAt: string | null; taskState: string | null;
};
export type PendingBuild = PrBuildView & { itemState: "OPEN" | "CLOSED"; currentHead: string | null };
export type NewPrBuild = { repo: string; number: number; head: string; base: string | null; scope: "outside" | "all"; plan: TaskStep[]; warm: Warm | null; /** The job that queues the build. */ jobId: number | null };
export type PrBuildSettle = { key: HeadRef; from?: "queued" | "failed"; set: { state: string; summary?: string | null; ciOverall?: string | null; disagree?: boolean; finishedAt?: string } };
export type LateDisagreement = { repo: string; number: number; head: string; summary: string | null };

/** As stored; the screenshot config's parser validates it on every read. */
export type CommandSpec = { doc: string; params: Record<string, unknown>; argv?: string[]; line?: Record<string, string | number | boolean>; capture?: boolean };
export type ScreenshotConfig = {
  package: string; example: string; driver: string; commands: Record<string, CommandSpec>; ui_paths: string[]; size?: string;
  repo: string; updatedBy: string; updatedAt: string;
};
export type ScreenshotRun = {
  repo: string; number: number; headSha: string; baseSha: string | null; state: string; reason: string | null; plan: unknown;
  headTaskId: number | null; baseTaskId: number | null; verdict: string | null; clear: boolean | null; comparison: unknown; model: string | null;
  held: boolean; createdAt: string; finishedAt: string | null;
};
export type NewScreenshotRun = Pick<ScreenshotRun, "repo" | "number" | "headSha" | "baseSha" | "state" | "reason" | "plan" | "headTaskId" | "baseTaskId" | "createdAt">;
/** `itemState` is `OPEN` or `CLOSED`. The tasks carry their plans and results; the artifacts are those the two tasks stored. Title and body come from `mirror.loadItems`. */
export type PendingShotRun = ScreenshotRun & {
  itemState: "OPEN" | "CLOSED"; currentHead: string | null; headTask: VerificationTask | null; baseTask: VerificationTask | null;
  headArtifacts: ArtifactRow[]; baseArtifacts: ArtifactRow[];
};
/** What `saveScreenshotConfig` stores; the caller validated it. */
export type ScreenshotConfigInput = Omit<ScreenshotConfig, "repo" | "updatedBy" | "updatedAt">;
export type ScreenshotSettle = { key: HeadRef; from: string[]; set: Partial<Pick<ScreenshotRun, "state" | "reason" | "verdict" | "clear" | "comparison" | "model" | "held" | "finishedAt" | "headTaskId" | "baseTaskId" | "plan">> };

export type Suite = { id: number; name: string; event: string; status: string; conclusion: string | null };
export type RunsInput = { repo: string; number: number; head_oid: string; state: string; cross_repo?: boolean; suites?: Suite[] };
export type RunResult = { key: HeadRef; runs: WaitingRun[]; approved: number[]; failed: Record<string, number>; approvedNow: boolean };
/** The row `noteMergeable` takes from the checks step: one open PR's head and mergeable state. */
export type PrChecks = { repo: string; number: number; head_oid: string; mergeable: string | null; state: string; overall: string | null };
