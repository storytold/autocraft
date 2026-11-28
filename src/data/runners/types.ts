import type { ItemRef } from "../../../web/src/api/types.ts";
import type { HelperStatus, Machine, Readiness, Reserve, TaskBundle, Tier } from "../../remote/protocol.ts";

export type { HelperStatus, Machine, Readiness, Reserve, TaskBundle, Tier };
import type { RefKey } from "../mirror/types.ts";
import type { ToolRow } from "../inference/types.ts";

export type Ref = RefKey;
export type LowerLogin = string;
export type Role = "operator" | "maintainer" | "viewer";

export type CallState = "queued" | "leased" | "done" | "failed";
export type NewCall = {
  promptId: string; promptVersion: string; tier: Tier; effort: string; askedModel: string; bundle: Omit<TaskBundle, "callId">;
  items: ItemRef[]; level: number; maxAttempts: number;
  /** Where the call belongs: the job and step it runs in (`stepOf`) and its queue class and repo (`callQueue`), decided by the caller. */
  job: { jobId: number | null; step: string; stage: number; cls: number; repo: string | null };
  /** A follow-up turn on the session of this call. */
  parentId?: number;
  referenceRepo?: string;
  /** Only this user's own Task Runners take the call. */
  forLogin?: string;
  boundSlot?: boolean;
};
export type CallSummary = {
  id: number; state: CallState; error: string | null; promptId: string; items: ItemRef[]; userLogin: string | null; ownLane: boolean;
  runId: number | null; since: number; consumedAt: number | null; jobId: number | null;
};
/** A queued call as claims read it: items parsed, the repos it names and its authors, plus the fields the queue view shows. */
export type QueuedCall = {
  id: number; promptId: string; promptVersion: string; tier: Tier; step: string; parentId: number | null; stickyLogin: string | null; seenAt: number;
  timeoutMs: number; refs: ItemRef[]; repos: string[]; authors: ReadonlySet<string>; releasedBy: string | null; releasedAt: number | null; releaseWaitMs: number | null;
  forLogin: string | null; boundSlot: boolean; refusedToken: number | null; pickedBy: string | null; pickedAt: number | null; pickUntil: number | null;
  askedModel: string; queuedMs: number; queuedSince: number | null; error: string | null; level: number; jobId: number | null; since: number;
  /** Queue class and the call's repo: the inputs of the pure queue order. */
  cls: number; repo: string | null;
};
/** `calls` holds the follow-ups first (oldest first), then the other calls oldest first; the pure `sortQueue` of feature code puts them in claim order. */
export type QueueSnapshot = { signature: string; calls: QueuedCall[]; running: { repoN: Map<string, number>; stepN: Map<string, number> } };
export type PollRow = {
  id: number; state: CallState; reply: string | null; error: string | null; progress: string | null; runId: number | null; leasedAt: number | null; attempt: number;
  consumedAt: number | null; usage: string | null; turns: number | null; sessionId: string | null;
};
/** `parentLive`: for a queued follow-up, the helper that ran its parent holds a lease that heartbeats. */
/** The waits' fields of a queued call; `repos` are the repos of its items and its own repo, as in QueuedCall. */
export type QueuedWait = { parentId: number | null; queuedMs: number; queuedSince: number | null; since: number; promptId: string; tier: Tier; repos: string[] };
export type CallPoll = { call: PollRow | null; liveness: { alive: boolean; since: number }; lost: boolean; gone: boolean; parentLive: boolean; queued: QueuedWait | null };

export type UserSettings = {
  reserve: Reserve; repos: string[]; maxCalls: number | null; interactiveSlots: number | null; manualOnly: boolean;
  skipTasks: string[]; taskItems: "all" | "started" | "mine"; runnerPrivate: boolean;
};
export type RunnerRow = {
  tokenId: number; login: string; role: Role | null; label: string | null; machine: Machine | null; helperVersion: string | null; createdAt: string; expiresAt: string;
  canAgent: boolean; canAnswer: boolean; readiness: Readiness | null; until: string | null; reason: string | null; harness: string | null;
  models: Partial<Record<Tier, string>>; reserve: Reserve | null; usage: unknown; reportedAt: number | null; slots: number | null; busy: number | null;
  lastError: string | null; idleClaimAt: number | null; idleTiers: Tier[] | null; idleRepos: string[] | null;
  /** When the runner's harness login renews, while its claims leave calls for want of that login's room (remote_helpers.login_renews_at). */
  loginRenewsAt?: number | null;
  /** Leases outside the own lane. */
  leased: number; ownLaneLeased: number; beatAt: number | null;
};
/** Rows of the workflow module's started-work load: live workflows and the PR each implement workflow works on. */
export type StartedWork = {
  /** `taken_by`: the lowercase logins whose Task Runners were taken onto the workflow (src/data/workflow/item-runners.ts). */
  live: { repo: string; number: number; entry: string; state: string; started_by: string; approved_by: string | null; taken_by?: string[] }[];
  prs: { repo: string; prNumber: number; started_by: string; approved_by: string | null; taken_by?: string[] }[];
  /** Merged PRs whose workflow ended done through the merge lately: only their post-merge review calls are its work (src/remote/started.ts). */
  merged: { repo: string; prNumber: number; started_by: string; approved_by: string | null }[];
  /** Repos approved for Fix red main and who approved each: the main-fix step's calls in the repo are that person's work (src/remote/started.ts). */
  mainfix: { repo: string; by: string }[];
};
export type RunnerSnapshot = {
  at: number; runners: RunnerRow[]; settings: Map<LowerLogin, UserSettings>; cooled: Map<LowerLogin, { until: string; reason: string }>;
  denied: ReadonlySet<string>; leasedByLogin: Map<LowerLogin, { leased: number; interactive: number }>; started: StartedWork;
};
export type LiveLease = {
  id: number; jobId: number | null; runId: number | null; login: string; promptId: string; items: ItemRef[]; repo: string | null; root: string | null;
  secretHash: string; tokenId: number | null; tier: Tier; model: string | null; askedModel: string; step: string; attempt: number; maxAttempts: number;
  leasedAt: number | null; parentId: number | null; forLogin: string | null; refusals: number; setupRetries: number;
  /** The lease's own time limit when it was cut below the call's (LeaseRequest.timeoutMs), and when its run started. */
  leaseTimeoutMs: number | null; startedAt: number | null;
};
export type HelperInfo = {
  tokenId: number; label: string | null; readiness: Readiness | null; until: string | null; reason: string | null; fresh: boolean; lastSeen: string | null;
  harness: string | null; models: Partial<Record<Tier, string>>; reserve: Reserve | null; usage: unknown; slots: number | null; machine: Machine | null;
  helperVersion: string | null; createdAt: string; expiresAt: string; canAgent: boolean; canAnswer: boolean; cooledUntil: string | null; cooledReason: string | null;
  /** Calls running now and the last error, as the helper last reported them. */
  busy: number | null; lastError: { text: string; at: string } | null;
};

export type ClaimCaller = { tokenId: number; login: string; role: Role; claimId?: string };
export type ClaimFacts = {
  role: Role | null; idle: boolean; cooled: { until: number; reason: string } | null; settings: UserSettings; leased: number; interactive: number;
  signature: string; orphan: { id: number; runId: number | null; leaseSecretHash: string | null } | null; liveness: { alive: boolean; since: number };
  lost: number[]; gone: number[];
};
export type LeaseSource = {
  bundle: string; baseStdin: string | null; jobId: number | null; step: string; stage: number; promptId: string; promptVersion: string; askedModel: string; items: ItemRef[];
};
/** What a lease records of the claim. */
export type LeaseClaim = { harness: string; harnessVersion: string; root?: string | null; requestId?: string | null; ownLane?: boolean };
export type LeaseRequest = {
  id: number; caller: ClaimCaller; claim: LeaseClaim; model: string; now: number;
  /** Leases the login may hold outside the own lane (null: no limit), and its interactive-lane leases. A lane lease counts toward no limit but its own. */
  caps: { perLogin: number | null; interactive: number | null };
  /** The call is for work the caller started or approved: checked in the lease statement; else the Manual only rules apply. */
  started: boolean;
  /** With `started`, or for a call bound to another person: the runner credentials whose reported model serves the call's tier, for the taker rule (cross.ts readyWithRoomExpr). */
  tierTokens?: readonly number[];
  clearIdle: boolean; source: LeaseSource;
  /** The lease's time limit when it is shorter than the call's own (the room left on the claim's harness login); null or absent: the call's own. */
  timeoutMs?: number | null;
  /** The run's stored prompt: `inference.packPrompt` of the harness-worded bundle, scrubbed by the caller. */
  prompt: Uint8Array;
  /** A bundle whose text was rewritten for this lease (a workspace session's resume note) and the text it was rewritten from. */
  rewrite: { bundle: string; baseStdin: string } | null;
  /** Asked inside the lease transaction before anything is written: false when no one waits for the reply any more. */
  live: () => boolean;
};
export type Lease = { id: number; secret: string; runId: number | null; bundle: string; attempt: number };
export type ExpiryResult = { requeued: number[]; failed: number[]; withdrawn: number[]; beaten: string[] };
/** A validated reply, its path root already taken off the text and the tool rows; `usage` is the stored usage object. */
export type ParsedSubmit = {
  reply: string; model: string; usage: unknown; turns: number | null; sessionId: string | null; tools: Omit<ToolRow, "runId">[]; durationMs: number;
};
export type SubmitResult = { accepted: boolean };
/** Where a call the model's safety filter declined runs once more: on another runner (`token` is the one that declined) or on a lower tier; null: nowhere. */
export type RefusalRetry = { token: number } | { tier: Tier; model: string } | null;

/**
 * What the pick rules read. `callState` is the call's state (null: no such call); `call` is read whatever its state. `runners` are the
 * user's live Task Runner credentials. `pickerLogins` are the lowercase logins whose picks count now. `cap`: how long a new pick counts, in ms
 * (null: until it ends otherwise). `max`: the most live picks one user holds whatever their slots (`PICKS_MAX`).
 */
export type PickContext = {
  call: QueuedCall | null; callState: CallState | null; runners: RunnerRow[]; livePicks: number; cooled: { until: string; reason: string } | null;
  pickerLogins: string[]; cap: number | null; max: number;
};
/** `limit`: the user already holds `max` live picks; `taken`: another user's pick counts, or the call is no longer queued. */
export type PickResult = "picked" | "limit" | "taken";
export type ReadyRunner = { login: string; role: string; manual: boolean; tiers: ReadonlySet<Tier>; free: number; repos: ReadonlySet<string> | null; skip: ReadonlySet<string> };
export type TakerSweepPlan = { insertRepos: string[]; deleteRepos: string[]; mark: number[]; clear: number[]; withdraw: { id: number; reason: string }[] };
export type SweepState = { snapshot: RunnerSnapshot; queue: QueueSnapshot; pipelineRepos: string[]; noTakerRepos: Map<string, number>; marked: Map<number, number> };
/**
 * Queued calls with a live caller, counted past each bucket's limit (`queuedMs`, the tier's `tierWaitMs`, `interactiveWaitMs`): `n` of them and
 * `oldestMs`, the epoch ms the oldest was queued (null when none). `ready` counts live credentials with a fresh, ready status, `manualOnly` those of
 * them whose user is Manual only. `noTakerRepos` are the pipeline-on repos marked without a taker for `noTakerMs`, with the mark's epoch ms.
 */
export type RunnerHealth = {
  queued: { total: number; oldestMs: number | null; byTier: Record<string, { n: number; oldestMs: number | null }>; interactive: { n: number; oldestMs: number | null } };
  lastLeaseAt: number | null; ready: number; manualOnly: number; noTakerRepos: { repo: string; since: number }[]; operatorRunners: { login: string; interactiveSlots: number | null }[];
};
export type RelayedCheck = { id: number; runId: number | null; input: string };
export type NewPassage = { callId: number; runId: number | null; login: string; repo: string; passageId: number; page: string; at: number };
