import type { RefKey } from "../mirror/types.ts";
// The vocabulary of an implementation of a queued issue (the Implement stage): its states, rounds and the replies of
// its model calls. The planner and the dashboard bundle use it.

export const IMPLEMENTATION_STATES = [
  "planning", "asked", "planned", "implementing", "checking", "fixing", "opening", "pr-opened", "revising", "stuck",
  "merged", "closed", "failed", "cancelled",
] as const;
export type ImplementationState = (typeof IMPLEMENTATION_STATES)[number];

/** States in which work of ours runs or is due without a person: at most MAX_LIVE_PER_REPO such rows per repo. */
export const LIVE_STATES: ReadonlySet<ImplementationState> = new Set(["planning", "planned", "implementing", "checking", "fixing", "opening", "revising"]);
/** States a row never leaves: a new attempt is a new row. The rest are the issue's current attempt (one at most). */
export const ENDED_STATES: ReadonlySet<ImplementationState> = new Set(["merged", "closed", "failed", "cancelled"]);
/** States whose work the build bucket carries on: the plan is stored, the session or its checks or the PR are due or were cut off by a restart. */
export const BUILD_STATES: ReadonlySet<ImplementationState> = new Set(["planned", "implementing", "checking", "fixing", "opening"]);

/** Live implementations one repo may hold at once; one per issue. */
export const MAX_LIVE_PER_REPO = 2;

/** What a job of the `implement` step does: plan (and, when ready, go on to build in the same job), build from a stored plan, or revise our open PR. */
export const IMPLEMENT_BUCKETS = ["plan", "build", "revise"] as const;
export type ImplementBucket = (typeof IMPLEMENT_BUCKETS)[number];

/**
 * `guidance`: a person's note for the attempt (a Try again answer's text), read into its plan and session input.
 * `workspace`: the attempt's workspace was made again; the turns and checks before it belong to the lost one.
 * `ask-failed`: posting or asking a stored plan's questions failed; the next job tries the write again from the stored plan.
 * `answer`: a person answered a question or stuck recommendation (AnswerRound).
 * `revise`: a revision of our open PR starts (ReviseRound); the turns and checks after it belong to that revision.
 * `start-failed`: the plan bucket's workspace did not start, before its model call (StartFailedRound); AutoCraft starts it again itself.
 * `retry`: the attempt stopped on a failure of AutoCraft's own and goes on by itself after a backoff (RetryRound), instead of asking.
 */
export const ROUND_KINDS = ["plan", "session", "follow-up", "checks", "refusal", "question", "guidance", "workspace", "ask-failed", "revise", "answer", "start-failed", "retry"] as const;
export type RoundKind = (typeof ROUND_KINDS)[number];

/** One `implementations` row. JSON columns are parsed; a column that does not parse reads as null. */
export type Implementation = {
  id: number;
  repo: string; number: number;
  queuedBy: string;
  state: ImplementationState;
  attempt: number;
  textHash: string;
  baseSha: string | null;
  workspaceId: number | null;
  plan: PlanReply | null;
  planMd: string | null;
  planCallId: number | null;
  sessionCallId: number | null;
  report: SessionReport | null;
  diffHash: string | null;
  diffStat: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The columns a step may set besides the state (updated_at is always set). */
export type ImplementationPatch = Partial<Pick<Implementation,
  "queuedBy" | "textHash" | "baseSha" | "workspaceId" | "plan" | "planMd" | "planCallId" | "sessionCallId" | "report" | "diffHash" | "diffStat" | "branch" | "prNumber" | "prUrl" | "reason">>;

export type ImplementationRound = {
  id: number;
  implementationId: number;
  kind: RoundKind;
  callId: number | null;
  /** The round's JSON result, parsed; null when there is none or it does not parse. */
  result: unknown;
  at: string;
};

// ---- the model calls' replies (implement.plan, implement.session) ------------------------------------------------

export type QuestionAudience = "author" | "maintainer";
/**
 * The result of a `question` round: whom it asked, and where (the issue comment). The planner reads the newest
 * question round of an `asked` attempt: only answers after it plan again, so every new question needs a round of its own.
 */
export type QuestionRound = { audience: QuestionAudience; text: string; commentId?: string; options?: { key: string; label: string; hint: string }[]; recommended?: string | null; limit?: boolean };
/** The result of an `answer` round: who answered which question round, and what. */
export type AnswerRound = { by: string; via: string; at: string; option?: string; text?: string; question: number };
/** The result of an `ask-failed` round: what failed, for the plan round whose questions it was writing. */
export type AskFailedRound = { planRound: number; error: string };
/** A `start-failed` round: why the workspace did not start. */
export type StartFailedRound = { error: string };
/**
 * A `retry` round: the stuck cause AutoCraft retries itself, its detail, whether a Task Runner lost the call, the states it went
 * from and to, and `reset` for a revision that starts over on a tree reset to the change last pushed.
 */
export type RetryRound = { cause: string; detail: string | null; runner: boolean; from: string; to: string; reset?: boolean };
export type PlanQuestion = { audience: QuestionAudience; text: string; options: { label: string; hint: string }[]; recommended: string | null };

/**
 * The result of a `revise` round: the PR head it revises and why (the review's fixes, red CI or both), the commit our last
 * push made (the revision's push carries the change since it onto the PR's head), and the follow-up it sends the session.
 * `verified`: the hash of the workspace diff the revision's first turn started from, set once it was checked to be the change
 * last pushed (the attempt's `diffHash`); the push is refused without it. A copy of the round for a new revision leaves it out.
 */
export type ReviseRound = { prNumber: number; head: string; from: string; review: boolean; ci: boolean; message: string; verified?: string };

/** The `revise` round a new revision starts with, copied from an earlier one: without its start check (`verified`). */
export const reviseCopy = (r: ReviseRound): ReviseRound => ({ prNumber: r.prNumber, head: r.head, from: r.from, review: r.review, ci: r.ci, message: r.message });

/** The plan call's reply: ready to implement, or the questions that come first. */
export type PlanReply = {
  ready: boolean;
  kind: "bugfix" | "feature" | "change";
  summary: string;
  /** Markdown. */
  plan: string;
  acceptance: string[];
  verification: { tests: string[]; app: string | null };
  size: "S" | "M" | "L" | "XL";
  risks: string[];
  questions: PlanQuestion[];
  /** On the maintainer workflow: what the reply adds; absent when it had neither field. */
  workflow?: PlanWorkflow;
};

/** A ready plan's numbered parts (each with the files it changes) and, for a plan that asks, the sentence recommending an option. */
export type PlanWorkflow = { parts: { title: string; files: string[] }[]; recommendation: string | null };

/** The session's JSON report. AutoCraft trusts only its own checks; this says what the session claims. */
export type SessionReport = {
  status: "done" | "blocked";
  summary: string;
  changes: string[];
  tests_run: { command: string; exit: number }[];
  shots: { n: number; what: string }[];
  deviations: string[];
  blocked_reason?: string;
};

// ---- results of the loaders (src/data/implement) --------------------------------------------------------------------

export type { RefKey };
/** One `implementations` row without the large JSON columns. */
export type AttemptLite = Omit<Implementation, "plan" | "planMd" | "report">;
export type IssueAttempt = {
  /** The latest attempt: the current one, else the newest ended one. */
  attempt: AttemptLite;
  /** Only with `withPlans`. */
  planned?: { plan: PlanReply | null; planMd: string | null; report: SessionReport | null };
  /** The newest question round, only while the state is `asked` or `stuck` (a stuck attempt's round holds the blocker's options). */
  question: { round: number; at: string; audience: QuestionAudience | null; text: string; limit: boolean; /** A stuck attempt's cause (its key). */ cause: string | null; options: NonNullable<QuestionRound["options"]>; recommended: string | null } | null;
  /** The newest answer round after that question round. */
  answer: AnswerRound | null;
  /** This attempt's guidance rounds, oldest first. */
  guidance: { by: string | null; at: string; text: string }[];
  /** Heads of this attempt's `revise` rounds with a review or CI fix. */
  reviseHeads: string[];
  lastRevise: ReviseRound | null;
  /** AutoCraft's own retry of a failed workspace start (src/implement/start-retry.ts): the failures in a row and when the next start is due; null when none is due. */
  startRetry: { failures: number; dueAt: number } | null;
  /** AutoCraft's own retry of a stopped attempt (src/implement/start-retry.ts): its newest retry round's cause, its number and when it is due; null when none stands. */
  ownRetry: OwnRetry | null;
  /** Attempts of the issue per text_hash; empty while its only attempt is neither failed nor stuck. */
  textCounts: Record<string, number>;
  /** Attempts with a PR, newest id first; the plan each was built from only with `withPlans`. */
  prAttempts: { id: number; prNumber: number; state: ImplementationState; createdAt: string; diffStat: string | null; plan?: PlanReply | null }[];
};
export type PrAttempt = { issue: number; attemptId: number; state: ImplementationState; revisedHeads: string[]; ownRetry: OwnRetry | null; planned?: IssueAttempt["planned"] };
export type OwnRetry = { cause: string; n: number; dueAt: number };
export type ImplementFacts = {
  byIssue: Map<RefKey, IssueAttempt>;
  /** The latest attempt that opened each PR, ended ones too. */
  byPr: Map<RefKey, PrAttempt>;
  /** Live attempts (LIVE_STATES) of open issues, per repo. */
  liveByRepo: Map<string, Set<RefKey>>;
};
export type ImplementationView = { impl: Implementation; attempts: number; rounds: ImplementationRound[] };
export type ImplementStamp = { attempts: { id: number; state: ImplementationState; updatedAt: string }[]; rounds: { n: number; newest: string | null; length: number } };
/** `stuck`: the stuck blocker the attempt's newest question round is, with its cause and AutoCraft's own retries before it; null when that round is none. */
export type StuckStreakRow = { number: number; attempt: number; state: ImplementationState; prNumber: number | null; stuck: { cause: string; retried: number | null } | null };

export type StartAttempt = { repo: string; number: number; queuedBy: string; textHash: string; baseSha?: string | null };
export type AttemptStep = {
  id: number;
  /** Absent means unguarded. */
  expect?: ImplementationState[];
  to?: ImplementationState | null;
  patch?: ImplementationPatch;
  addRounds?: { kind: RoundKind; callId?: number | null; result?: unknown }[];
  setRounds?: { id: number; result: unknown }[];
};
export type AttemptGuidance = { by: string; text: string };
