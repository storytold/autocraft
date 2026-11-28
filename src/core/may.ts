import type { StepApproval } from "../data/control/types.ts";
import type { ActionState, EndedWorkflow, Preapproval, WorkflowAction } from "../data/workflow/types.ts";
import { authorAsk, RULE_STARTER, type ItemWorkflow } from "../workflow/types.ts";
import type { RefusalCode } from "./codes.ts";
import { acceptedHeads, chainsOwn, type OwnPush } from "./evidence.ts";

export type WorkflowGate = {
  live: boolean;
  entry: "review" | "fix-up" | "implement" | "merge";
  state: string;
  startedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  blocker: string | null;
  baseHead: string | null;
  /** The heads a person accepted (src/core/evidence.ts acceptedHeads, isAccepted); absent in a gate that judges one head by itself. */
  accepted?: readonly string[];
  /** Its merge leg on the PR while the leg is active; null before it starts and once it ended (cancelled, failed). */
  leg: { state: string; head: string | null } | null;
  /** The PR's workflow waits for its author's push (src/workflow/types.ts authorAsk). */
  waitsForAuthor?: true;
};

/**
 * What `mayMerge` and `mayPush` read of a live workflow row; null without a live one. `legs`: the PR's active merge legs, newest last.
 * An issue's base_head only says which implementation head its files were shown at, so its implementation PR's base is the head its leg is at: the leg starts at a head of ours or one a person answered at, and
 * follows our own pushes only.
 */
export function workflowGate(w: ItemWorkflow | null | undefined, o: { legs?: readonly Pick<Preapproval, "workflow_id" | "state" | "from_head" | "head">[] } = {}): WorkflowGate | null {
  if (!w) return null;
  const legs = (o.legs ?? []).filter((l) => l.workflow_id === w.id), leg = legs.at(-1);
  return {
    live: true, entry: w.entry === "fixup" ? "fix-up" : w.entry, state: w.state, startedBy: w.startedBy, approvedBy: w.approvedBy, approvedAt: w.approvedAt,
    blocker: w.blocker, baseHead: w.kind === "issue" ? leg?.head ?? null : w.baseHead, accepted: acceptedHeads(w, legs),
    leg: leg ? { state: leg.state, head: leg.head } : null, ...(authorAsk(w) ? { waitsForAuthor: true as const } : {}),
  };
}

export type MayResult = { ok: true; as: "person" | "repo"; by: string } | { ok: false; code: RefusalCode; why: string };

const person = (by: string): MayResult => ({ ok: true, as: "person", by });
const refuse = (code: RefusalCode, why: string): Extract<MayResult, { ok: false }> => ({ ok: false, code, why });
const REPO_OFF = "An operator, or a maintainer of the repo, turns it on on the Repos page.";
const ENDS_WITH_RECOMMENDATION = "Nobody approved this yet; the workflow ends with a recommendation.";

/** Workflow ends by which a person took the item out of the pipeline: nothing merges it until someone starts it again. */
const ENDED_WHY: Partial<Record<EndedWorkflow, string>> = {
  stopped: "Someone holds this; it merges once someone resumes it or starts it again.",
  backlog: "Someone sent this to the backlog; it merges once someone starts it again.",
  closed: "The work on this ended with a close; it merges once someone starts it again.",
  done: "The work on this ended with an answer that did not merge it; it merges once someone starts it again.",
};

export type MergeInputs = {
  repoApproval: StepApproval | null;
  workflow: WorkflowGate | null;
  /** Without a live workflow: how the latest one of the PR, or of the issue it implements, ended. */
  ended: EndedWorkflow | null;
  head: string;
  /** The open or merged PRs it duplicates, as "repo#number": without a live workflow it merges only once a person picks it. */
  duplicates?: readonly string[] | undefined;
  /** Every push we made to the PR (src/core/evidence.ts ownPushes). */
  pushes: readonly OwnPush[];
};

/** Why the PR neither merges nor gets our pushes while nobody has started it: a person took it out of the pipeline, or it duplicates another. */
export function handsOff(f: Pick<MergeInputs, "ended" | "duplicates">): Extract<MayResult, { ok: false }> | null {
  const ended = f.ended && ENDED_WHY[f.ended];
  if (ended) return refuse("ended", ended);
  return f.duplicates?.length ? refuse("duplicate", `It duplicates ${f.duplicates.join(", ")}; it merges once a maintainer starts it.`) : null;
}

/** Whether the merge of the PR at `head` is approved, by a person or by the repo. A started PR merges only once handed over (`mayMerge`). */
export function mergeApproved(f: MergeInputs): MayResult {
  const w = f.workflow;
  if (w?.live) {
    if (w.blocker) return refuse("blocked", `The workflow asks again: ${w.blocker}`);
    if (w.baseHead === null || !chainsOwn(f.pushes, w.baseHead, f.head)) return refuse("unaccepted-head", "The author pushed commits after the workflow accepted the head; they are reviewed before the merge.");
    if (w.approvedBy === null && w.entry !== "merge") return refuse("not-approved", ENDS_WITH_RECOMMENDATION);
    return person(w.approvedBy ?? w.startedBy);
  }
  return handsOff(f) ?? (f.repoApproval ? { ok: true, as: "repo", by: f.repoApproval.by } : refuse("repo-approval", REPO_OFF));
}

/**
 * Whether the PR may be merged at `head`. A live workflow's merge is made only through its leg, once the leg handed the PR over at
 * that head: while the leg works, before it starts, and after it ended until the workflow moves on, nothing merges.
 */
export function mayMerge(f: MergeInputs): MayResult {
  const r = mergeApproved(f);
  const w = f.workflow;
  if (!r.ok || !w?.live) return r;
  if (w.leg?.state === "queued" && w.leg.head === f.head) return r;
  return refuse("not-handed-over", w.leg ? "The merge waits for the workflow's steps to hand it over." : "The workflow's merge is not under way; it merges once the workflow hands it over.");
}

/** Whose merge the pull request of an implementation is, once its issue's workflow is approved; null before. */
export const mergesFor = (w: Pick<ItemWorkflow, "approvedBy"> | null | undefined): string | null => w?.approvedBy ?? null;

export function mayPush(f: {
  kind: "fixup" | "cifix" | "conflict";
  repoApproval: StepApproval | null;
  workflow: WorkflowGate | null;
  operatorFix: boolean;
  by?: string;
}): MayResult {
  const w = f.workflow;
  if (f.operatorFix) {
    const by = f.by ?? w?.approvedBy ?? (w?.startedBy === RULE_STARTER ? undefined : w?.startedBy);
    return by ? person(by) : refuse("request-unnamed", "The fix-up command does not name who asked for it.");
  }
  if (w?.live) {
    if (f.kind === "fixup") {
      if (w.entry !== "review") return person(w.startedBy);
      return w.approvedBy !== null ? person(w.approvedBy) : refuse("not-approved", ENDS_WITH_RECOMMENDATION);
    }
    return w.entry !== "review" || w.approvedBy !== null ? person(w.approvedBy ?? w.startedBy) : refuse("not-approved", ENDS_WITH_RECOMMENDATION);
  }
  return f.repoApproval ? { ok: true, as: "repo", by: f.repoApproval.by } : refuse("repo-approval", REPO_OFF);
}

/** States of a person action that waits for its person's sign-in or access. */
export const ACTION_WAITS: readonly ActionState[] = ["waiting-token", "waiting-permission"];

/**
 * The PR's merge waits for its approver's sign-in or access: it was tried at `head` for this approval, so it stays put until the
 * row goes back to pending, the head or the approver changes, or the approval is given again.
 */
export function mergeWaits(actions: readonly WorkflowAction[] | undefined, wf: Pick<ItemWorkflow, "id" | "startedBy" | "approvedBy" | "approvedAt"> | undefined, head: string, states: readonly ActionState[] = ACTION_WAITS): boolean {
  if (!wf) return false;
  const by = (wf.approvedBy ?? wf.startedBy).toLowerCase();
  return (actions ?? []).some((a) => a.kind === "merge" && a.workflow_id === wf.id && a.head === head && states.includes(a.state)
    && a.by.toLowerCase() === by && (!wf.approvedAt || a.updated_at >= wf.approvedAt));
}
