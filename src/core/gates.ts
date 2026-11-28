// The gates on writes: the order in which an action that is due is refused or let through (src/core/authority.ts permit), the repo
// approvals each action needs, and the global pipeline switch. Pure. What is due does not depend on it (decide.ts).
import { refusalWho, type Params, type RefusalCode } from "./codes.ts";
import { isAccepted } from "./evidence.ts";
import { ownImplementation } from "./implementation.ts";
import type { ActionKind, ItemFacts, Permission, PrFacts } from "./plan.ts";
import { handsOff, mayMerge, mayPush, mergeApproved, type MayResult, type MergeInputs } from "./may.ts";
import { tripStageOf } from "./push-outcome.ts";

/** Who asks for a write: the pipeline itself (the autopilot), or an operator (a job they requested, or a command they ran). */
export type By = "pipeline" | { operator: string };

/** An action as the gates and the guard see it: its kind, and the bucket where the kind has several (fix-up: fix | ask, ...). */
export type Want<K extends ActionKind = ActionKind> = { kind: K; bucket?: string; /** Fix-up: the plan action's source (`operator`: a person's fix-up request). */ source?: string };

/** The repo approvals a write can need. */
export type Approval = "merge" | "push" | "comment" | "ci" | "labels" | "fix-issue" | "main-fix" | "status";

const WHAT: Record<Approval, string> = { merge: "Merges", push: "Pushes", comment: "Comments", ci: "CI run approvals", labels: "Labels", "fix-issue": "Issue implementations", "main-fix": "Main CI fixes", status: "PR status comments" };

/** A repo's approvals and the global switch, as the repo-level guard loads them. */
export type RepoApprovals = Record<Approval, boolean> & { pipelineOn: boolean };

/** Why a write needing `need` is refused, or null. A write with no approval need (`need` null) is gated by the switch only. */
/** What a repo-level write needs: a repo approval, `security` for a security fix's writes (approved per finding, no repo approval), or null for none. */
export type RepoNeed = Approval | "security" | null;

export function gateRepo(a: RepoApprovals, need: RepoNeed, by: By, repo: string): string | null {
  if (by === "pipeline" && !a.pipelineOn) return "The pipeline is off";
  return need === null || need === "security" || a[need] ? null : `${WHAT[need]} in ${repo} are not approved`;
}

/** The approval an action's GitHub write needs, or null for an action that writes nothing there. */
export function approvalOf(f: { pushable?: boolean }, a: Want): Approval | null {
  switch (a.kind) {
    // Closing and commenting need the comment approval, when nobody commanded the close (commandedBy): a close comments first.
    case "label": return "labels";
    case "act": return "comment";
    case "merge": return "merge";
    case "post-review": return "comment";
    case "followups": return "comment";
    case "approve-ci": return "ci";
    case "fixup":
    case "conflict":
      return a.bucket === "fix" || a.bucket === "merge" ? "push" : a.bucket === "ask" ? "comment" : null;
    case "cifix":
      if (a.bucket === "rerun") return "ci";
      // A closed branch gets the patch as a comment instead of a push.
      if (a.bucket === "ask") return "comment";
      return a.bucket === "work" || a.bucket === "collect" ? (f.pushable ? "push" : "comment") : null;
    // The collect step of a stored model patch: its push (bucket fixup or cifix), or the patch as a comment where the branch is closed to us.
    case "lint": return a.bucket === "cifix" && !f.pushable ? "comment" : "push";
    default: return null;
  }
}

/** The item's implement work is the end of an attempt whose PR merged or closed (decidePr, implementStep). */
const endsAttempt = (f: PrFacts | ItemFacts): boolean =>
  "ghState" in f ? f.ghState !== "OPEN" : f.implement.row?.state === "pr-opened" && !f.implement.row.prOpen;

/**
 * The person a started item's work acts for (who last answered, approved or started its live workflow, never the automatic merge rule), while
 * they count on the repo under the app identity; null otherwise. Their start is the approval of the writes that show the workflow's work: the
 * Opus review post, and the item's PR status comment (src/prstatus statusDueIn).
 */
export function showsWorkFor(f: Pick<PrFacts, "workflow" | "standing">): string | null {
  const s = f.standing?.work;
  return f.workflow && s && s.standing === "yes" && !s.boxIdentity ? s.login : null;
}

/** Who the implementation (and with it its PR's revisions) runs for, who commanded the close, or whose started item the review post and the follow-up issue show; null for other work. Their command is the approval, in any repo. */
function commandedBy(f: PrFacts | ItemFacts, a: Want): string | null {
  if (a.kind === "implement") return ("ghState" in f ? ownImplementation(f)?.queuedBy : f.implement.queuedBy) ?? null;
  if (a.kind === "issue-review" || a.kind === "issue-review-post") return "ghState" in f ? null : f.issueReview?.requestedBy ?? null;
  if (a.kind === "post-review" || a.kind === "followups") return showsWorkFor(f);
  if (a.kind !== "act" || "ghState" in f) return null;
  // The comment the review asked for acts for the person the started work acts for, while they count on the repo.
  return f.close?.auto ? showsWorkFor(f) : f.close?.by ?? null;
}

const refuse = (code: RefusalCode, text: string, params?: Params): Permission => ({ ok: false, why: { code, who: refusalWho(code), ...(params ? { params } : {}), text } });

/** The triage steps of an item. */
const TRIAGE: readonly ActionKind[] = ["classify", "referee", "prioritize", "embed", "dupes", "dupes-compare", "label"];
/** What goes on while an item waits for a person's answer, or for a person to take the place of one who is gone: its bookkeeping, and the close a person commanded. */
const GOES_ON: ReadonlySet<ActionKind> = new Set([...TRIAGE, "unassign", "post-review", "postmerge", "act"]);
/** What may be planned outside the scope too. */
const ANY_SCOPE: ReadonlySet<ActionKind> = new Set(["unassign", "postmerge", "act", "embed", "dupes", "dupes-compare"]);

/** Why the people a started item acts for do not cover the action, or null. `writes`: it merges, pushes or runs the implementation, which takes their standing; other work goes on while GitHub has not answered on it. */
function standingRefusal(f: PrFacts | ItemFacts, a: Want, writes: boolean): Permission | null {
  const s = a.kind === "merge" ? f.standing?.merge : f.standing?.work;
  if (!s) return null;
  const params = { login: s.login, repo: f.repo };
  if (s.standing === "no") return refuse("actor-gone", `${s.login}, whom the work on ${f.repo}#${f.number} acts for, can no longer act on ${f.repo}; a maintainer there answers, approves or starts it again`, params);
  if (!writes) return null;
  if (s.boxIdentity) return refuse("box-identity", "Started work runs as the person who started it only through the GitHub App; an operator switches AutoCraft to it", params);
  return s.standing === "unknown" ? refuse("actor-unknown", `GitHub has not answered on ${s.login}'s access to ${f.repo}`, params) : null;
}

/**
 * Whether the head of a PR approved for merge is one a person accepted, or our own pushes on top of one. On the implementation PR of an
 * issue our own commits on the branch we opened count too.
 */
function headAccepted(f: PrFacts): boolean {
  const w = f.may.workflow;
  if (!w?.live || (w.approvedBy === null && w.entry !== "merge")) return true;
  const heads = w.accepted ?? (w.baseHead === null ? [] : [w.baseHead]);
  return isAccepted(heads, f.may.pushes, f.head ?? "") || (f.workflow?.own === false && f.may.ownHead);
}

/** Whether the action may run, on whose say and as whom its write is made: a merge a person approved is made as them, every other write as the app. The first rule that refuses it names why. */
export function gatePermission(f: PrFacts | ItemFacts, a: Want, by: By): Permission {
  const pr = "may" in f ? f : null;
  if (by === "pipeline" && !f.pipelineOn) return refuse("pipeline-off", "The pipeline is off");
  // An implement action of a live attempt whose PR merged or closed only ends the attempt and its workspace: no write, no breaker.
  if (a.kind === "implement" && endsAttempt(f)) return { ok: true, as: "app", by: null };
  const need = approvalOf(f as { pushable?: boolean }, a);
  const prefix = need ? `${WHAT[need]} in ${f.repo} are not approved` : "";
  const unapproved = (code: RefusalCode, why: string, params: Params = {}): Permission =>
    (need === "merge" || need === "push" ? refuse(code, code === "repo-approval" ? `${prefix}: ${why}` : why, { need, repo: f.repo, ...params }) : refuse(code, why, params));
  if (!f.inScope && !ANY_SCOPE.has(a.kind)) {
    // A person's end of its workflow takes an item out of the scope, and says more than that it is out.
    const left = pr && !pr.may.workflow?.live ? handsOff({ ended: pr.may.ended }) : null;
    return left ? unapproved(left.code, left.why) : refuse("scope", "The item is outside the pipeline's scope");
  }
  if ((pr ? pr.may.workflow?.state : f.workflow?.state) === "blocked" && !GOES_ON.has(a.kind)) {
    const asks = pr?.may.workflow?.blocker;
    return unapproved("blocked", `The workflow asks again${asks ? `: ${asks}` : ""}`, asks ? { blocker: asks } : {});
  }
  // A PR whose workflow waits for its author's push (src/workflow/types.ts AuthorAsk) gets no work of AutoCraft's but its bookkeeping and the comment to them.
  if (pr && pr.may.workflow?.waitsForAuthor && !GOES_ON.has(a.kind)) return unapproved("author-ask", "The workflow waits for the author's push");
  // A stage that stopped itself on the item's repo (circuit breaker) writes nothing there until it is resumed, whoever asks.
  const stage = tripStageOf(a);
  const tripped = stage && f.tripped?.[stage];
  if (tripped) return refuse("breaker", `${stage[0]!.toUpperCase()}${stage.slice(1)} is paused: ${tripped}`, { stage, reason: tripped });
  const commander = commandedBy(f, a);
  if (a.kind === "act" && commander !== null) return { ok: true, as: "app", by: { kind: "person", login: commander } };
  if (a.kind === "act" && !("ghState" in f) && f.close?.auto) return standingRefusal(f, a, true) ?? refuse("not-approved", "Nobody who counts on the repo started the work whose review asks the author");
  if (a.kind === "implement" && commander === null) return refuse("not-approved", "The issue is not queued");
  if ((a.kind === "issue-review" || a.kind === "issue-review-post") && commander === null) return refuse("not-approved", "Nobody asked for a review of the issue");
  // A revision is a push of the implementation session.
  const writes = need === "merge" || need === "push" || a.kind === "implement";
  const gone = GOES_ON.has(a.kind) ? null : standingRefusal(f, a, writes);
  if (gone) return gone;
  if (pr && writes && !headAccepted(pr)) return unapproved("unaccepted-head", `The author pushed commits after the workflow accepted the head; they are reviewed before ${need === "merge" ? "the merge" : "AutoCraft pushes"}.`);
  if (commander !== null) return { ok: true, as: "app", by: { kind: "person", login: commander } };
  if (!need) return { ok: true, as: "app", by: null };
  if (pr && (need === "merge" || need === "push")) {
    const may = need === "merge" ? mergeMay(pr) : (!pr.may.workflow?.live && handsOff({ ended: pr.may.ended, duplicates: duplicatesOf(pr) })) || pushMay(pr, a);
    if (!may.ok) return unapproved(may.code, may.why);
    return { ok: true, as: need === "merge" && may.as === "person" ? `user:${may.by}` : "app", by: { kind: may.as, login: may.by } };
  }
  const r = f.repoFacts as Partial<Record<"commentApproved" | "ciApproved" | "labelsApproved", boolean>>;
  // An item (no PR facts) has no merge and no push of its own.
  const ok = { merge: undefined, push: undefined, comment: r.commentApproved, ci: r.ciApproved, labels: r.labelsApproved, "fix-issue": undefined, "main-fix": undefined, status: undefined }[need];
  if (ok) return { ok: true, as: "app", by: null };
  // A started item whose person does not count now: why their start is no approval says more than the repo's switch.
  return ((a.kind === "post-review" || a.kind === "followups") && f.workflow ? standingRefusal(f, a, true) : null) ?? refuse("repo-approval", prefix, { need, repo: f.repo });
}

/** Why the write is refused, or null. */
export function gates(f: PrFacts | ItemFacts, a: Want, by: By): string | null {
  const p = gatePermission(f, a, by);
  return p.ok ? null : p.why.text;
}

const duplicatesOf = (f: PrFacts): string[] | undefined => f.duplicates?.of.map((n) => `${f.repo}#${n}`);
const mergeInputs = (f: PrFacts): MergeInputs =>
  ({ repoApproval: f.may.repoMerge, workflow: f.may.workflow, ended: f.may.ended, duplicates: duplicatesOf(f), head: f.head ?? "", pushes: f.may.pushes });

/** Whether the PR may be merged at its head (src/core/may.ts). */
export const mergeMay = (f: PrFacts): MayResult => mayMerge(mergeInputs(f));

/** Whether the merge of the PR at its head is approved, handed over or not, on whose say (`mergeApproved`, src/core/may.ts). */
export const mergeApproval = (f: PrFacts): MayResult => mergeApproved(mergeInputs(f));

/** `mergeApproval` as a yes or no. */
export const mergeAllowed = (f: PrFacts): boolean => mergeApproval(f).ok;

export type PushKind = "fixup" | "cifix" | "conflict";

/** The push kind `mayPush` judges for an action that pushes. */
function pushKind(a: Want): PushKind {
  if (a.kind === "cifix" || (a.kind === "lint" && a.bucket === "cifix")) return "cifix";
  if (a.kind === "conflict" || (a.kind === "lint" && a.bucket === "conflict")) return "conflict";
  return "fixup";
}

/** Whether a push of `kind` is approved (src/core/may.ts). `operatorFix`: a person's fix-up request. */
export const pushMayOf = (f: PrFacts, kind: PushKind, operatorFix: boolean): MayResult =>
  mayPush({ kind, repoApproval: f.may.repoPush, workflow: f.may.workflow, operatorFix, ...(operatorFix && f.may.fixupBy ? { by: f.may.fixupBy } : {}) });
const pushMay = (f: PrFacts, a: Want): MayResult => pushMayOf(f, pushKind(a), a.source === "operator");

/** Why a push of `kind` is not approved; null when it is. */
export function pushRefusal(f: PrFacts, kind: PushKind, operatorFix = false): string | null {
  const m = pushMayOf(f, kind, operatorFix);
  return m.ok ? null : m.why;
}

/** The push approval as a yes or no. */
export const pushAllowed = (f: PrFacts, kind: PushKind, operatorFix = false): boolean => pushRefusal(f, kind, operatorFix) === null;

/** Writes from the command line are an operator's. */
export const CLI_BY: By = { operator: "cli" };

/** The writer behind a job: the autopilot's own jobs are the pipeline's, every other requester is an operator. */
export const byOfJob = (requestedBy: string): By => (requestedBy === "pipeline" ? "pipeline" : { operator: requestedBy });
