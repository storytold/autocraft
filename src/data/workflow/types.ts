import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { Blocker, Entry, ItemKind, ItemWorkflow, Parsed, PlanPart, Recommendation, Surface, WorkflowEventKind, WorkflowState } from "../../workflow/types.ts";
import type { Params, StopCode } from "../../core/codes.ts";
import type { RefKey } from "../mirror/types.ts";

export type { Blocker, Entry, ItemKind, ItemWorkflow, PlanPart, Recommendation, Surface, WorkflowEventKind, WorkflowState, RefKey };
export type EndedWorkflow = "done" | "stopped" | "closed" | "backlog" | "superseded";


export type WorkflowFact = {
  id: number; entry: Entry; approved: boolean; approvedBy: string | null; startedBy: string; startedAt: string;
  weight: number; state: WorkflowState; own: boolean;
  /** Up to when a person has seen the item and chose to go on with it: its start, or when the question they answered was asked. */
  since: string;
  reviewAskedAt: string | null;
  /** The PR head the workflow last accepted (`base_head`); for an issue, the implementation head its files were shown at. */
  baseHead: string | null;
  /** The lower-case titles of the parts a person dropped from its plan, but the pre-merge review's findings; absent when none. */
  dropped?: string[];
  /** The pre-merge findings a person dropped from the plan of a workflow approved for merge: lower-case title and the head they were dropped at; absent when none. */
  droppedFindings?: { title: string; head: string | null }[];
  /** The lower-case titles of `droppedFindings` that still overrule the pre-merge review at the PR's head (the PR facts set it, src/core/facts.ts). */
  overruled?: string[];
  /** The PR's workflow waits for its author (src/workflow/types.ts authorAsk): `auto` when the review asked, `person` when a person did. */
  authorAsk?: "auto" | "person";
};
/** Live workflows of PRs, by the PR. */
export type PrWorkflows = Map<RefKey, ItemWorkflow>;
/** `maker_checked_at`: when GitHub last confirmed the maker's write permission; the request counts until `HOLD_MAX` after it. */
export type OperatorWork = { requests: (FixupRequest & { maker_checked_at?: string | null })[]; legs: Preapproval[] };
export type WorkflowPassFacts = {
  live: Map<RefKey, WorkflowFact>;
  ofPr: Map<RefKey, WorkflowFact>;
  /** Who each live workflow acts for, newest first (workflowActors), by its id. */
  actors: Map<number, string[]>;
  ended: Map<RefKey, EndedWorkflow>;
  operator: Map<RefKey, OperatorWork>;
};

export type NewWorkflow = {
  repo: string; number: number; kind: ItemKind; entry: Entry; weight: number; startedBy: string; startedVia: Surface; baseHead?: string | null;
  approvedBy?: string | null; approvedVia?: Surface | null; plan?: PlanPart[]; step?: string | null; at?: string;
};
/** The fields of `ItemWorkflow` except identity and the PR, which only `linkWorkflows` writes. */
export type WorkflowPatch = Partial<Omit<ItemWorkflow, "id" | "repo" | "number" | "kind" | "startedBy" | "startedAt" | "startedVia" | "prNumber" | "version" | "updatedAt">>;
/** An implement workflow of an issue and the PR it works on. */
export type WorkflowLink = { workflowId: number; repo: string; issue: number; pr: number; live: boolean };
export type WorkflowFilter = { live?: boolean; ids?: number[]; repos?: string[]; refs?: { repo: string; number: number }[]; states?: WorkflowState[]; logins?: string[]; approved?: boolean; recAfter?: string; /** The row's own blocker column, a retired blocker included (workflowOf reads one as `other`). */ storedBlockers?: string[] };
/** `via` defaults to `cli` (the archived rows of retired decisions have no surface). */
export type WorkflowEvent = { workflowId: number | null; repo: string; number: number; login: string; kind: WorkflowEventKind | "archived"; via?: Surface | null; parsed?: Parsed | null; line?: string | null; at?: string; /** An answer's: when its question was asked. */ seenAt?: string | null };
/** Up to when a person has seen an item and chose to go on with it (`since`), when they said so (`said`), and when someone last resumed it. */
export type GoneOn = { since: string; said: string; resumed: string | null };
export type StoredEvent = WorkflowEvent & { id: number; at: string };
/** A stored event of the maintainer workflow itself. */
export type SaidEvent = StoredEvent & { kind: WorkflowEventKind };
export type QueuePosition = { position: number; of: number; weight: number; startedBy: string };
export type StartedWork = {
  /** `takenBy`: the lowercase logins whose Task Runners were taken onto the workflow (item-runners.ts). */
  live: { repo: string; number: number; entry: Entry; state: WorkflowState; startedBy: string; approvedBy: string | null; takenBy?: string[] }[];
  prs: { repo: string; pr: number; startedBy: string; approvedBy: string | null; takenBy?: string[] }[];
  /** Merged PRs whose workflow ended done through the merge lately (fragments.ts endedByMerge): their post-merge review is that workflow's work. */
  merged: { repo: string; pr: number; startedBy: string; approvedBy: string | null }[];
};
export type StartedFilter = { /** Live states only. */ states?: WorkflowState[]; refs?: { repo: string; number: number }[]; login?: string; repos?: string[]; openOnly?: boolean };

export type LegState = "fixup" | "review" | "ci" | "queued" | "merged" | "cancelled" | "failed";
export type Preapproval = Omit<Selectable<DB["preapprovals"]>, "state"> & { state: LegState };
export type LegRow = Preapproval;
export type LegContext = { workflowId: number; entry: Entry; startedAt: string; since: string; reviewAskedAt: string | null };
/** `requests`: the queued requests of the active legs. */
export type LegPass = { rows: LegRow[]; context: Map<number, LegContext | "ended" | "unlinked">; requests: FixupRequest[] };
export type LegMove = { id: number; from: LegState; to: LegState; head?: string | null; reason?: string | null; /** What `reason` is, as a code, with its parts. */ code?: StopCode; params?: Params; by?: string; via?: string };
/** What a row was read with, for a write that takes place only while it is still the same. */
export type WorkflowRead = { state: WorkflowState; updatedAt: string; version: number };
/** A queued fix-up request follows the PR's head from `from` to `to`. */
export type FixupRequestMove = { id: number; from: string; to: string };
export type LegMoved = LegMove & { repo: string; number: number };
/** `fromHead`: the head the person approved, when pushes of ours lead from it to `head`. */
export type NewLeg = { repo: string; number: number; by: string; workflowId: number; head: string; fromHead?: string; state: "review" | "fixup"; instructions?: string; fixId?: number; via?: string };
export type FixupRequest = Omit<Selectable<DB["operator_fixups"]>, "state"> & { state: "queued" | "started" | "ended" };
export type NewFixupRequest = { repo: string; number: number; fromHead: string; instructions: string; by: string; merge?: boolean; workflowId?: number; at?: string };

export type CommandRow = Selectable<DB["github_commands"]>;
export type NewCommand = Pick<CommandRow, "comment_id" | "repo" | "number" | "pr" | "login" | "github_id" | "created_at" | "requested_at" | "parsed">;
/** `asked`: an `ask <question>` put to Opus; its answer settles it `done` (or `refused` without one), to post. */
export type CommandState = "done" | "refused" | "ignored" | "expired" | "asked";
export type CommandSettle = { commentId: number; state: CommandState; result: string | null; reply: boolean; allowed: boolean; at: string };
export type CommandProgress = { commentId: number; triedAt?: string; retryInc?: boolean; reply?: "posted" | "failed" | "none" };

export type StatusRow = Selectable<DB["pr_status_comments"]>;

export type RepinState = string;
/** The request a row was read with: its pair, asker, and (to refuse a newer command by the same asker) the request time. */
export type RepinKey = { repo: string; number: number; refRepo: string; refNumber: number; login: string; requestedAt?: string };
export type RepinRow = Selectable<DB["autorepins"]>;
export type RepinRequest = { repo: string; number: number; refRepo: string; refNumber: number; refBranch: string | null; login: string; githubId: number; off?: boolean; at?: string };
export type RepinPatch = Partial<Pick<RepinRow, "state" | "sha" | "head" | "task_id" | "tries" | "tried_at" | "to_head" | "result" | "done_at" | "notice">>;

/** `ask-author`: the comment to a PR's author of a workflow that waits for them (src/workflow/effects.ts queueAuthorAsk). */
export type ActionKind = "close" | "comment-close" | "merge" | "ask-author";
export type ActionState = "pending" | "waiting-token" | "waiting-permission" | "done" | "failed" | "stopped" | "skipped";
export type WorkflowAction = Omit<Selectable<DB["workflow_actions"]>, "kind" | "state"> & { kind: ActionKind; state: ActionState };
/** How a close ends the item, as `workflow_actions.close_as` stores it. */
export type CloseAs = "completed" | "not-planned" | `duplicate ${string}#${number}`;
export type NewAction = { workflowId: number; repo: string; number: number; kind: ActionKind; by: string; head: string | null; state?: ActionState; at?: string; closeAs?: CloseAs | null };
export type DueAction = WorkflowAction & { weight: number; itemState: string | null; itemHead: string | null };
export type Surface2 = Surface;
