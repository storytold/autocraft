import type { Insertable, Selectable, SelectQueryBuilder } from "kysely";
import type {
  BuildEnv, BuildSummary, BuildTask, BuildTaskDetail, CacheReport, EnvTask, ItemShown, Requires, SandboxEnv, TaskFilter, TaskPage, TaskResult, TaskStep, WorkspacePage,
} from "../../../web/src/api/types.ts";
import type { DB } from "../../db/types.ts";
import type { TrackedRepo } from "../control/types.ts";
import type { KeySource } from "../keys.ts";
import type { BatchByTask } from "../merge/types.ts";

export type { BuildEnv, BuildSummary, BuildTask, BuildTaskDetail, CacheReport, EnvTask, ItemShown, Requires, SandboxEnv, TaskFilter, TaskPage, TaskResult, TaskStep, WorkspacePage };
import type { RefKey } from "../mirror/types.ts";

export type Ref = RefKey;
export type HiddenRepos = string[] & { visible?: string[] };
/** Which rows a viewer may see: hidden repos are filtered out, and only staff read logs and patches. */
export type ViewScope = { hiddenRepos: HiddenRepos; staff: boolean };
/** A list of ids, or an id subquery from a module's `fragments.ts`. */
export type IdSource = number[] | SelectQueryBuilder<any, any, { id: number }>;
export type RefSource = KeySource;

export const TERMINAL: readonly TaskState[] = ["done", "failed", "cancelled", "lost"];
export const LOST_AFTER_MS = 2 * 60_000;
/** A task is claimed at most this often: the first time and one requeue after a lost worker. */
export const MAX_ATTEMPTS = 2;
export const MAX_QUEUED = 500;
export const KEEP_MS = 3650 * 24 * 3600_000;
export const ARTIFACT_KEEP_MS = 30 * 24 * 3600_000;
export const MAX_LOG_BYTES = 20 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const LOG_TAIL_BYTES = 64 * 1024;
export const WARM_STEP = "warm";
/** An environment is online when it called within this long. */
export const ONLINE_MS = 60_000;
/** A private task's wait while no confidential environment can take it. */
export const CONFIDENTIAL_WAIT = "Waiting for a confidential build environment.";
export const PRIVATE_STEPS: readonly string[] = ["fix-check", "scan-test"];
export const WORKSPACE_STATES = ["requested", "starting", "seeding", "ready", "parked", "ended", "failed"] as const;
export type WorkspaceStateName = (typeof WORKSPACE_STATES)[number];
export const LIVE_STATES: WorkspaceStateName[] = ["requested", "starting", "seeding", "ready", "parked"];
export const POD_STATES: WorkspaceStateName[] = ["starting", "seeding", "ready"];
/**
 * The owner prefix of the workspaces of security fix sessions (`<prefix> <session id>`). Such a workspace holds a private fix: the
 * dashboard lists it under its repo's security pseudo repo, so only those who may read the repo's security findings see it.
 */
export const SECURITY_WORKSPACE_OWNER = "security fix session";
export const isSecurityWorkspace = (w: { owner: string | null }): boolean => w.owner?.startsWith(`${SECURITY_WORKSPACE_OWNER} `) === true;
/** The owner prefix of the workspaces of PR fix sessions (`<prefix> <session id>`). */
export const FIX_SESSION_WORKSPACE_OWNER = "fix session";
/** A fix session's workspace, PR or security: the work its steps keep is stored with them, so its volume is only a warm cache. */
export const isFixSessionWorkspace = (w: { owner: string | null }): boolean => isSecurityWorkspace(w) || w.owner?.startsWith(`${FIX_SESSION_WORKSPACE_OWNER} `) === true;

export type TaskState = "queued" | "claimed" | "running" | "done" | "failed" | "cancelled" | "lost";
export type Warm = { key: string; role: "use" | "build" };
export type TaskRecord = {
  id: number; jobId: number | null; step: string; repo: string; number: number | null; headSha: string; baseSha: string | null; requires: Requires;
  priority: number; plan: TaskStep[]; state: TaskState; envId: string | null; attempts: number; queuedAt: string; claimedAt: string | null;
  startedAt: string | null; endedAt: string | null; heartbeatAt: string | null; cancelRequestedAt: string | null; results: TaskResult[]; summary: string | null;
  logBytes: number; artifactBytes: number; hasPatch: boolean; warmKey: string | null; warmRole: "use" | "build" | null; warmImage: string | null;
  warmVersion: string | null; warmRev: number | null; sandbox: SandboxEnv | null;
  /** The stored diff; set only by loads that ask for it. */
  patch?: string | null;
};
export type TaskLite = Pick<TaskRecord, "id" | "step" | "repo" | "number" | "headSha" | "state" | "envId" | "queuedAt" | "startedAt" | "endedAt" | "summary" | "jobId">;
export type TaskBrief = TaskLite & { logStep: string | null };
export type TaskStateRow = { state: TaskState; step: string; endedAt: string | null };
export type NewTask = {
  jobId?: number | null; step: string; repo: string; number?: number | null; headSha: string; baseSha?: string | null; requires?: Requires; priority?: number;
  plan: TaskStep[];
  /** Unified git diff applied to the checkout before the plan runs. */
  patch?: string;
  warm?: Warm; warmImage?: string; warmVersion?: string; warmRev?: number;
};
export type CancelOutcome = { id: number; repo: string; was: TaskState; result: "cancelled" | "already" | "missing" };
export type PodRun = Selectable<DB["build_pod_runs"]>;
export type NewPodRun = Omit<PodRun, "id">;
export type PodRunPatch = Partial<Omit<PodRun, "task_id">>;
/** A workspace row; `checkpoint` is present only when it was asked for. */
export type WorkspaceRow = Omit<Selectable<DB["workspaces"]>, "checkpoint"> & { checkpoint?: Uint8Array | null };
export type SessionRow = Selectable<DB["workspace_sessions"]>;
export type WorkspaceCallRow = Selectable<DB["workspace_calls"]>;
export type NewSession = Insertable<DB["workspace_sessions"]>;
export type ArtifactRow = { taskId: number; name: string; bytes: number; contentType: string; file: string };

export type TaskCard = {
  id: number; jobId: number | null; step: string; state: TaskState; repo: string; number: number | null; queuedAt: string; startedAt: string | null; endedAt: string | null;
  results: TaskResult[]; summary: string | null; logStep: string | null;
};
export type TaskEvent = { id: number; jobId: number | null; headSha: string; step: string; state: TaskState; queuedAt: string; startedAt: string | null; endedAt: string | null; summary: string | null; envId: string | null };
export type TaskHistoryStat = { n: number; newestId: number; ended: boolean; states: string };
export type MemRow = { repo: string; step: string; steps: number; medianBytes: number; maxBytes: number; oom: number };
export type EnvTasks = { runs: PodRun[]; tasks: TaskRecord[] };
/** The queue is full: `queued` tasks wait and the set would pass `limit`. */
export class QueueFullError extends Error {
  queued: number;
  limit: number;
  constructor(queued: number, limit: number) {
    super(`${limit} tasks are already queued`);
    this.queued = queued;
    this.limit = limit;
  }
}
/** A refusal the caller maps to an HTTP status (400 bad input, 404 missing, 409 conflict). */
export class StatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
/** A worker call named a task that is missing (404) or not running on its environment (409). */
export class TaskAccessError extends Error {
  status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}
/** `settings` is the stored JSON, parsed, for the caller's `settingsOf`; `slots` is the smaller of the operator's and the reported count. */
export type EnvRecord = Omit<BuildEnv, "settings"> & {
  keyHash: string; settings: unknown; health: EnvHealth | null; confidentialOnlineAt: string | null; operatorSlots: number; reportedSlots: number | null;
  confidentialSince: string | null; updatedBy: string | null; updatedAt: string | null; createdAt: string;
};
export type EnvHealth = { state: string; text: string; since: string };
export type HealthPatch = { state: string; text: string };
export type EnvPatch = { id: string; label?: string; kind?: string; enabled?: boolean; confidential?: boolean; settings?: unknown; keyHash?: string; slots?: number };
export type ClaimPick = { id: number; head?: string; base?: string; plan?: TaskStep[] };
export type ClaimFit = (task: TaskRecord) => boolean;
export type ClaimInputs = {
  env: EnvRecord | null; running: number; candidates: TaskRecord[]; otherEnvs: EnvRecord[]; sizings: Map<string, RepoSizing>; warm: Map<string, WarmFacts>;
  startedRefs: Set<Ref>; batches: Map<number, BatchByTask>; tracked: Map<string, TrackedRepo>;
  pendingUpdate: UpdateSpec | null;
};
export type EnvPassState = { envs: EnvRecord[]; tasks: Map<string, EnvTasks>; reservations: { node: string; cpuM: number; memBytes: number }[] };
export type LogTail = { text: string; bytes: number; truncated: boolean };

export type StepMemory = { requestBytes: number; limitBytes: number };
export type WarmTarget = "none" | "tmpfs" | "pvc";
export type MemorySource = "operator" | "history" | "oom" | "environment";
export type WarmSource = "operator" | "auto";
export type RepoSizing = {
  repo: string; memory: StepMemory | null; memorySource: MemorySource;
  /** The history size, also when another source wins; null below the minimum of measured builds. */
  history: (StepMemory & { builds: number }) | null;
  warmTarget: WarmTarget; warmSource: WarmSource; autoWarmTarget: WarmTarget; warmBytes: number | null; updatedAt: string | null; reason: string | null;
};
/** One kind of change per row: `memory` (`memorySource` "oom" is a floor and is not audited), `warmTarget` (null: automatic), `reset` (memory back to automatic) or `clear` (the row removed). */
export type SizePatch = { repo: string; memory?: StepMemory; memorySource?: "operator" | "oom"; warmTarget?: WarmTarget | null; reset?: boolean; clear?: boolean; reason?: string };
/** What the warm gates read per repo: the default-branch head, whether a finished warm build at it counts, open warm tasks (queued, claimed or running), those claimed or running, the newest warm claim, and the task a forced rebuild queued. */
export type WarmFacts = { head: string | null; attempted: boolean; open: number; active: number; newestClaimedAt: string | null; forcedTask: number | null };
/** A warm build to queue: the plan is the producer's (it depends on the writer environment), `version` and `rev` are the AutoCraft version and producer revision it is queued under. */
export type WarmQueueRow = { repo: string; head: string; image: string; plan: TaskStep[]; version: string; rev: number; force: boolean; jobId: number | null };
export type StoredCaches = { version: 1; readAt: number | null; nodes: unknown[]; placement: unknown; placementNote: string | null; mirror: { allowlist: string[] | null; error: string | null; readAt: number } | null };
export type UpdateSpec = { sha: string; ssh: string; keyFile: string; gitDir: string };
export type WorkerUpdate = { pending: UpdateSpec | null; failures: { count: number; error: string } | null };
/** `ip` and `port`: what the EndpointSlice should name. `slice`: the addresses it named at the last read, null when it could not be read. `wrongSince`: when it was first seen naming anything else, null while it names the leader. */
export type EndpointStatus = { ip: string; port: number; slice: string[] | null; wrongSince: string | null; at: string; error?: string };
/** How a workspace started its build dir: the stored `warm` JSON and the warm commit (null for a cold start). */
export type WarmNote = { warm: string | null; warmCommit: string | null };

/** `ciCheckout`: the repository works at the CI paths when it has a warm target (the caller knows whether it has a CI checkout path). */
export type WorkspaceRequest = { repo: string; baseSha: string; envId: string; app?: string | null; limits?: { deadlineSec?: number }; owner: string | null; ciCheckout: boolean };
export type WorkspaceMove = { id: number; from: WorkspaceStateName[]; to: WorkspaceStateName; set?: Partial<Omit<WorkspaceRow, "id">> };
export type WorkspaceSource = { ids: number[] } | { env: string; states: WorkspaceStateName[] } | { remoteCallIds: number[] } | { idsFrom: SelectQueryBuilder<any, any, { id: number }> };
/** `running`: calls in `running` state within their deadline. `background`: the done shell, shell_status and shell_kill calls since the pod was created, with the bookkeeping of `result.acct`. */
export type CallActivity = {
  running: { id: number; tool: string; deadlineAt: string }[];
  background: { id: number; tool: string; startedAt: string | null; bg: number | null; limit: number | null; ref: number | null; ended: number | null }[];
};
export type WorkspacePass = { rows: WorkspaceRow[]; calls: Map<number, CallActivity>; bound: Map<number, "queued" | "leased"> };
export type NewWorkspaceCall = Omit<WorkspaceCallRow, "id">;
export type ToolCallQuery = { tool?: string; n?: number; id?: number; ids?: number[] };
/** A tool call's bookkeeping: its `acct` numbers (from the result) and the background flag and time limit of its arguments. */
export type CallAccounting = {
  id: number; n: number | null; tool: string; state: string; started_at: string | null; ms: number | null; bytes: number | null; bg: number | null; lim: number | null; ref: number | null;
  ended: number | null; images: number | null; background: 0 | 1; timeout: number | null;
};
export type CallListRow = {
  id: number; n: number | null; tool: string; args: string; state: string; created_at: string; started_at: string | null; finished_at: string | null;
  has_result: number; is_error: number | null; images: number | null; image_data: string | null; image_bytes: number | null; image_sha: string | null; image_note: string | null;
};
/** `more`: older calls exist (the default and `before` pages only). */
export type CallPage = { rows: CallListRow[]; more: boolean };
export type SessionSource = { ids: number[] } | { workspaceIds: number[] } | { remoteCallId: number } | { jobId: number };
export type SweptSession = { id: number; workspaceId: number | null; keep: boolean; jobId: number | null; jobState: string | null; error: string | null };
export type WorkspaceQuery = { state: "live" | "all"; cursor?: string; limit: number };
export type WorkspaceListRow = { id: number; repo: string; base_sha: string; app: string | null; state: string; state_at: string; node: string | null; warm: string | null; owner: string | null; created_at: string; ended_at: string | null };
export type WorkspaceListPage = { rows: WorkspaceListRow[]; next: string | null };
export type CacheTaskRow = { id: number; repo: string; state: string; summary: string | null; head_sha: string; ended_at: string | null; sandbox_env: string | null; warm_image: string | null };
/** The database half of the Caches page (the caller adds coverage and builds the node view). `bytes` is keyed by warm key, the rest by repo. */
export type CacheReportInputs = {
  stored: StoredCaches | null; taskRepos: string[]; last: Map<string, CacheTaskRow>; done: Map<string, CacheTaskRow>; bytes: Map<string, number>;
  warmTargets: Map<string, string>; heads: Map<string, string>; kubeEnvs: { id: string; settings: string | null }[];
};
