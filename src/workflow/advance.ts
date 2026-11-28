// Moves each live maintainer workflow on from what the pipeline recorded: its numbered plan from the latest review, a blocker that
// stops an approved item, the one recommendation an unapproved item comes back with when its steps are done, the merge leg of an
// approved PR (the pre-approved merge in src/preapproval, owned through preapprovals.workflow_id, which merges as the approver), and
// the end once the PR merged or closed. An implementation's open question, and a stuck implementation, come back as the issue's
// recommendation (question.ts). The runner runs it on each tick its inputs changed, before the pre-approval pass.
//
// A person answers the recommendation with a command (apply.ts), and nothing here writes to GitHub. While an item waits for its
// answer nothing moves, unless the author pushes: the question is about commits that are no longer the head, so it is made again.
// The author's commits on a PR approved for merge go through a review round: Opus reviews them, and only a review that finds them
// beyond what was approved asks the approver. The
// pass loads every workflow's facts at once and writes what changed in one write at its end, a stop at a blocker at once with the end
// of its merge leg (block.ts). A workflow a person changed meanwhile (held, answered, approved) keeps what they did: the pass's write
// leaves it out and the next pass looks at it again. Each pass first starts the workflows of PRs the automatic merge rule stopped for a
// person's judgement (auto-stop.ts), so they come back the same way.
import { withConfig } from "../data/control/index.ts";
import { loadOperatorFixResults, loadPatchFacts, type PatchFacts } from "../data/changes/index.ts";
import { loadImplementFacts, type ImplementFacts } from "../data/implement/index.ts";
import { loadIssueReviews, type IssueReviewRow } from "../data/issuereview/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadReviewRows, type PremergeRow, type ReviewRow } from "../data/review/index.ts";
import { adoptLegs, fixupRequestsAt, listWorkflows, loadFixupRequests, moveFixupRequests, loadActions, loadGoOnAt, loadLegs, moveWorkflows, recordEvents, retryActions, saveWorkflows, type GoneOn, type Preapproval, type WorkflowPatch, type WorkflowRead } from "../data/workflow/index.ts";
import { loadOwnPushes } from "../data/views/own-pushes.ts";
import { loadOwnLogins } from "../data/access/index.ts";
import { saveWorkflowFailures, type WorkflowFailure } from "../data/jobs/index.ts";
import { isFenced } from "../db/fence.ts";
import type { Db } from "../db/index.ts";
import { recheckDelayMs } from "../core/backoff.ts";
import { AUTHOR_ROUNDS_PER_DAY, CIFIX_NO_LOG_REASON } from "../core/rules.ts";
import type { StopCode } from "../core/codes.ts";
import { decidePr, premergeStopLifts } from "../core/decide.ts";
import { loadPrFacts } from "../core/facts.ts";
import { loadItemFacts } from "../core/issue-facts.ts";
import { acceptedHeads, agreedAt, approvedHead, chainsOwn, isAccepted, LOCKFILE, neededReview, type RecordedPush } from "../core/evidence.ts";
import type { ItemFacts, PrFacts } from "../core/plan.ts";
import type { PlanReply } from "../implement/types.ts";
import { PreapprovalRefused, preapproveMerge } from "../preapproval/index.ts";
import { operatorTries } from "../preapproval/state.ts";
import { FIXUP_MAX_ATTEMPTS } from "../core/rules.ts";
import { asSentence, clipText } from "../prose.ts";
import { fixPath, redCiPath } from "../preapproval/paths.ts";
import { t, tk } from "../i18n/index.ts";
import { ROUND_DELTA_LARGE, ROUND_UNSEPARATED, roundsToday } from "../core/author-round.ts";
import { partsToMake } from "../core/review-blocking.ts";
import { verificationOf } from "../data/merge/index.ts";
import { loadBlockerReads, openFrom, type BlockerReads } from "../review/blockers.ts";
import { markReviewsStale, nextUtcMidnight } from "../review/discussion.ts";
import { authorUnaskable } from "./unaskable.ts";
import { actBlocked } from "../core/repo-approvals.ts";
import { causeWent, fixable, itemQuestion, legStop, questionFor, type CauseNow, type Question } from "./ask.ts";
import { asksNobody } from "./asked.ts";
import { headKey, premergeOf, recheckRuleRow, startAutoStops } from "./auto-stop.ts";
import { blockWorkflow } from "./block.ts";
import { checkedOtherHead, codeOf, detectBlocker, FAILED_TWICE, fixesFirst, fixUnmade, premergeStop, type BlockerFacts, type EndedLeg, type Found } from "./blockers.ts";
import { again as fixAgain, authorAskFor, EffectError, queueAuthorAsk, type Instruction } from "./effects.ts";
import { premergeParts } from "./premerge.ts";
import { afterPush, atBlocker, conflictOf, droppedOf, onConflict, planOf, textFor, withoutAuthor, type ReviewView } from "./recommend.ts";
import { askedBy, isOpenQuestion, openQuestionOf, viewOf } from "./question.ts";
import { issueRecommendation, recommendsImplement } from "./issue-review.ts";
import { listText, ROUND_STEP, stepsFor, type StepName } from "./status.ts";
import { authorAsk, RULE_STARTER, type AuthorAsk, type Blocker, type ItemWorkflow, type PlanPart, type Recommendation } from "./types.ts";
import { candidatePr, workOf } from "./work.ts";

const ACTOR = "pipeline";
const ACTIVE_LEG = ["fixup", "review", "ci", "queued"];
const ENDED_LEG = ["asked", "cancelled", "failed"];
/** Fix-up and CI fix tries that failed (src/fixup, src/cifix). */
const FAILED_TRY = ["failed", "refused", "rejected", "cannot-push", "push-denied"];

/** What changed in a pass, for the Discord alerts and the log. */
export type Moved = { id: number; repo: string; number: number; to: ItemWorkflow["state"] };

/**
 * A live workflow whose check, or the write of what it found, failed each time since the pass last got it through: how often, the
 * latest error, and the row's version then. It is tried again at `until`, or when a person's command changed the row.
 */
export type FailedCheck = { ref: string; times: number; error: unknown; until: number; version: string; /** The first failure of this run of them (ISO). */ since: string };

/** Passes in a row a workflow's check failed before the item and the health checks show it. */
export const FAILING_SHOWN = 3;

/** The failures stored last per map of failed checks (one per runner), so the mark is written when what shows changes, and once by a new runner. */
const storedFailures = new WeakMap<Map<number, FailedCheck>, string>();

/** Stores the workflows that failed FAILING_SHOWN passes in a row, for the item's state line and the health checks; a failed write is tried at the next pass. */
async function showFailures(db: Db, failed: Map<number, FailedCheck>, log: (line: string) => void): Promise<void> {
  const list: WorkflowFailure[] = [...failed].filter(([, f]) => f.times >= FAILING_SHOWN).sort(([a], [b]) => a - b)
    .map(([id, f]) => ({ id, ref: f.ref, since: f.since, error: String((f.error as Error)?.message ?? f.error).replace(/\s+/g, " ").slice(0, 300) }));
  const value = JSON.stringify(list);
  if (storedFailures.get(failed) === value) return;
  try {
    await saveWorkflowFailures(db, list);
    storedFailures.set(failed, value);
  } catch (e) {
    if (isFenced(e)) throw e;
    log(`workflows: the failing checks were not stored: ${(e as Error).message}`);
  }
}

/** What the pass loaded for every live workflow, keyed `repo#number` (of the item, or of its PR). */
type Pass = {
  items: Map<string, { state: string; head_oid: string | null; closed_at: string | null; author?: string | null; author_type?: string | null; mergeable?: string | null; base_ref?: string | null }>;
  /** AutoCraft's own logins, lower case: it never asks itself as a PR's author. */
  own: ReadonlySet<string>;
  implement: ImplementFacts;
  /** Before anything was read: what a question made in this pass shows happened by then. */
  at: string;
  goOn: Map<number, GoneOn>;
  legs: Map<string, Preapproval[]>;
  reviews: Map<string, ReviewRow[]>;
  /** The pre-merge reviews at the heads the automatic merge rule's unanswered rows stopped at (auto-stop.ts headKey). */
  premerge: Map<string, PremergeRow>;
  patches: Map<string, PatchFacts>;
  /** Every push of ours per PR. */
  moves: Map<string, RecordedPush[]>;
  facts: Map<string, PrFacts>;
  /** Of the issues whose workflow has no PR. */
  issues: Map<string, ItemFacts>;
  /** The items the questions of held reviews wait for (cause blocked-by). */
  blockers: BlockerReads;
  /** Tells the runner to pass again at a time a question's cause goes by itself (ms). */
  wake: (at: number) => void;
  /** The newest review row of each issue review workflow, by workflow id. */
  issueReviews: Map<number, IssueReviewRow>;
};
/** The writes the pass collects, written once at its end; `was`: the row as the pass read it. `stored`: the workflows whose stop at a blocker is written already (blockWorkflow). */
type Writes = {
  workflows: { id: number; patch: WorkflowPatch; at: string; was: WorkflowRead }[]; adopt: { id: number; workflowId: number }[]; stored: Set<number>;
  /** The questions that close without an answer, by workflow: why, and the merges of an approver who can act again, which are tried again. */
  closed: { w: ItemWorkflow; line: string; at: string; retry: number[] }[];
  /** The comments to PR authors that the review's recommendation asked for, queued once the workflow waits for them. */
  asks: { w: ItemWorkflow; pr: { repo: string; number: number }; ask: AuthorAsk }[];
  /** The person's fix-ups queued at a head our own push moved on from, carried to the new head with the workflow's write (carryFixups). */
  carry: { w: ItemWorkflow; repo: string; number: number; from: string; to: string }[];
};

const key = (repo: string, n: number): string => `${repo}#${n}`;

/** Whether our own pushes lead from `from` to `to`. */
const ownChain = (pass: Pass, ref: string, from: string, to: string): boolean => chainsOwn(pass.moves.get(ref) ?? [], from, to);

/** Why the review round's review was not made, as the approver reads it (src/review/opus.ts writes the reason). */
const unreadReason = (reason: string): string =>
  reason === ROUND_UNSEPARATED ? t("the author's new commits could not be separated from the rest of this large pull request")
    : reason === ROUND_DELTA_LARGE ? t("the author's new commits are too large to review automatically")
      : t("the pull request is too large to review automatically");

const reviewAt = (pass: Pass, ref: string, head: string): ReviewRow | null => pass.reviews.get(ref)?.find((r) => r.head === head) ?? null;

/**
 * Tries of a step on the PR that failed after `since`: the fix-up and CI fix rows that record a failed try. A job that ended without one
 * (past its deadline, a crash, an outage) is no try of the item's own: the planner runs it again after its failure backoff, and the health
 * checks show a step that keeps failing. A step whose work is the contributor's now counts none: they are asked first, once, and the item
 * waits for them; where they were asked after `since` at an earlier head of ours, the tries count.
 */
function failures(pass: Pass, ref: string, since: string, head: string, facts: PrFacts | undefined): { step: string; count: number }[] {
  const p = pass.patches.get(ref), f = facts?.head === head ? facts : undefined;
  // A CI fix row of older code that found no failure log to read was no try.
  const count = (rows: { state: string; createdAt: string; reason?: string | null }[]): number =>
    rows.filter((r) => FAILED_TRY.includes(r.state) && r.createdAt > since && !(r.state === "failed" && r.reason === CIFIX_NO_LOG_REASON)).length;
  const asked = (rows: { state: string; createdAt: string; at: string }[]): boolean => rows.some((r) => r.state === "asked" && r.createdAt > since && r.at !== head);
  const of = (step: string, rows: { state: string; createdAt: string; at: string }[], theirs: boolean) => ({ step, count: theirs && !asked(rows) ? 0 : count(rows) });
  return [
    of("fix-up", (p?.fixups ?? []).map((r) => ({ ...r, at: r.fromHead })), !!f && fixPath(f) === "contributor"),
    of("CI fix", (p?.cifixes ?? []).map((r) => ({ ...r, at: r.head })), !!f && redCiPath(f) === "contributor"),
  ];
}

/**
 * Why a stop at a step that failed twice (detectBlocker) closes by itself: its tries, counted again, are fewer now (a try was superseded, or
 * was a job's failure that counts no more). Null while they still stop it, and for every other stop.
 */
function recounted(pass: Pass, w: ItemWorkflow, ref: string, head: string, f: PrFacts): string | null {
  const p = w.blockerParams;
  if (w.blocker !== "failed-twice" || typeof p?.step !== "string" || typeof p.count !== "number" || p.reason !== undefined) return null;
  const since = pass.goOn.get(w.id)?.since ?? w.startedAt;
  const count = failures(pass, ref, since, head, f).find((x) => x.step === p.step)?.count ?? 0;
  return count >= FAILED_TWICE ? null : t("The {step} has not failed twice since, so the work goes on.", { step: p.step });
}

/** Waits of an approved PR whose plan, while its merge leg works, shows the leg instead (core/decide.ts queueWait). */
const LEG_CARRIES: readonly string[] = ["batch-failed", "merge-refused"];

/** The facts as the item's plan reads them once its question closed. */
const asRunning = (f: PrFacts): PrFacts => (f.may.workflow ? { ...f, may: { ...f.may, workflow: { ...f.may.workflow, state: "running", blocker: null } } } : f);

/** The state of the newest try of the fix-up request `fix` on the PR; null when it has none. */
const tryState = (pass: Pass, ref: string, fix: number): string | null => (pass.patches.get(ref)?.fixups ?? []).filter((r) => r.operatorFix === fix).at(-1)?.state ?? null;

/**
 * The person's last answer was given at `head`, and no push of ours made that head since: a conflict there that a person has to resolve was theirs
 * to see when they went on with the merge approved, so its wait asks them nothing again.
 */
const answeredAt = (w: ItemWorkflow, moves: ReadonlyMap<string, readonly RecordedPush[]>, ref: string, head: string, said: string): boolean =>
  said > w.startedAt && w.baseHead === head && !(moves.get(ref) ?? []).some((p) => p.to === head && p.at > said);

/** What an approved item fixes before its merge: a leg end that is a finding (blockers.ts fixesFirst), or a wait of its plan on a failed check of the head. */
type FixCause = "review-hold" | "review-close" | "premerge-defect" | "verification-failed" | "screenshots";
const FIX_WAITS: readonly FixCause[] = ["verification-failed", "screenshots"];
/** Final states of a fix-up try that pushed nothing. */
const UNFIXED: readonly string[] = ["failed", "rejected", "too-large", "refused", "cannot-push", "push-denied"];
const FIX_WHAT: Record<FixCause, string> = {
  "review-hold": tk("what the review holds it for"),
  "review-close": tk("what the review would close it for"),
  "premerge-defect": tk("the pre-merge review's defects"),
  "verification-failed": tk("what its verification found"),
  screenshots: tk("the regression its screenshots show"),
};

/** The question of an approved PR whose review says to close it: nothing to fix, so the approver decides. */
function closeRec(finding: string | null, plan: readonly PlanPart[]): Recommendation {
  const said = finding?.trim() ? asSentence(clipText(finding.trim(), FINDING_SHOWN)) : null;
  const text = said ? t("The review says to close it: {finding} Close it, as the review recommends.", { finding: said }) : t("The review says to close it. Close it, as the review recommends.");
  return { text, parts: { fix: [], drop: droppedOf(plan) }, merges: false, close: true };
}

/**
 * The question once the fix-up tries since the approver last went on are used up on a finding that stops the merge: it says what was not
 * fixed and what the last try said, and a yes makes the fix again (resolve.ts). The word merge merges it as it is, past the review or check
 * it could not satisfy (the merge leg goes past a review a person was shown, and pre-merge parts it drops are overruled).
 */
function triedEnough(what: string, tries: number, plan: readonly PlanPart[], fix: readonly number[], last: string | null = null, instruction: Instruction | null = null): Recommendation {
  const said = tries > 1 ? t("AutoCraft's fix-up could not fix {what} in {n} tries.", { what, n: tries }) : t("AutoCraft's fix-up could not fix {what}.", { what });
  const lastTry = last?.trim() ? ` ${t("Its last try: {reason}", { reason: asSentence(clipText(last.trim(), FINDING_SHOWN)) })}` : "";
  return {
    text: `${said}${lastTry} ${t("Try the fix-up again, then merge. Write merge to merge it as it is.")}`,
    parts: { fix: [...fix], drop: droppedOf(plan) }, merges: true, ...(fix.length ? {} : { again: "fixup" as const }),
    triedFix: instruction ? { instruction } : {},
  };
}

/**
 * The question of an approved PR whose review holds it until the items `blockedBy` are settled: no fix-up merges them, so a yes reviews it
 * again then, and so does AutoCraft once none of them blocks any more.
 */
function waitsForOthers(finding: string | null, blockedBy: readonly string[], plan: readonly PlanPart[]): Recommendation {
  const said = finding?.trim() ? asSentence(clipText(finding.trim(), FINDING_SHOWN)) : null;
  const text = said ? t("The review holds it until other items are settled: {finding} Review it again, then merge.", { finding: said }) : t("The review holds it until other items are settled. Review it again, then merge.");
  return { text, parts: { fix: [], drop: droppedOf(plan) }, merges: true, again: "review", cause: { code: "blocked-by", items: [...blockedBy] } };
}
/** Characters of a finding the fix-up is handed (its instructions take at most INSTRUCTIONS_MAX). */
const FINDING_FIX_CHARS = 1200;
/** Characters of a review's finding a question quotes. */
const FINDING_SHOWN = 300;

/** How a hold ends a merge leg: its person cancels it, or the pre-approval pass does, with its workflow. */
const HOLD_ENDS: readonly StopCode[] = ["person", "workflow-ended"];

/** The reason of a leg the pass itself ended for the question it made (blockWorkflow). */
const OWN_CANCEL = `cancelled by ${ACTOR}`;

/** Leg ends that say only that someone else pushed: the workflow itself judges the new head (the review round), and a new leg starts at a head it accepts. */
const PUSH_ENDS: readonly StopCode[] = ["author-push", "head-back"];

/** The merge leg of the workflow that ended after `since` (and none active), with its reason. One a hold ended says nothing once someone resumed the item. */
function endedLeg(pass: Pass, w: ItemWorkflow, since: string, resumed: string | null): EndedLeg | null {
  const r = [...pass.legs.values()].flat().filter((l) => l.workflow_id === w.id).sort((a, b) => b.id - a.id)[0];
  if (!r || !ENDED_LEG.includes(r.state) || r.updated_at <= since || r.reason === OWN_CANCEL) return null;
  if (w.kind === "pr" && PUSH_ENDS.includes(codeOf({ reason: r.reason ?? r.state, code: r.reason_code as StopCode | null }))) return null;
  const ended: EndedLeg = { reason: r.reason ?? r.state, code: r.reason_code as StopCode | null, head: r.head, fix: r.fix_id };
  if (HOLD_ENDS.includes(codeOf(ended)) && resumed !== null && r.updated_at <= resumed) return null;
  return ended;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A row the automatic merge rule started whose question nobody answered: it asks nobody (asked.ts). */
const unansweredRuleRow = (w: ItemWorkflow): boolean => w.state === "recommending" && w.startedBy === RULE_STARTER && asksNobody(w);

/** Starts or adopts the approved PR's merge leg; a refusal is returned as the reason it cannot go on. */
async function ensureLeg(db: Db, pass: Pass, writes: Writes, w: ItemWorkflow, repo: string, pr: number, head: string, since: string): Promise<string | null> {
  const legs = pass.legs.get(key(repo, pr)) ?? [];
  const active = legs.filter((l) => ACTIVE_LEG.includes(l.state)).at(-1);
  if (!active) {
    // The queue merged the leg and the mirror does not show it yet: no new leg on a merged PR.
    if (legs.at(-1)?.state === "merged") return null;
    try {
      await preapproveMerge(db, { repo, number: pr, by: w.approvedBy!, via: "workflow", head, fromHead: approvedHead(pass.moves.get(key(repo, pr)) ?? [], head, since), workflowId: w.id });
    } catch (e) {
      // A refusal by rule (not reviewable, merging not approved) needs a person; anything else is tried again on the next pass.
      // A leg that became active meanwhile is adopted, or waited for, on the next pass, and a draft is waited for as with a leg.
      if (e instanceof PreapprovalRefused) return e.active || e.draft ? null : e.message;
      throw e;
    }
  } else if (active.workflow_id === null) writes.adopt.push({ id: active.id, workflowId: w.id });
  return null;
}

/** Whether the head is our own pushes on top of one a person accepted (acceptedHeads). */
function accepted(pass: Pass, w: ItemWorkflow, ref: string, head: string): boolean {
  return isAccepted(acceptedHeads(w, (pass.legs.get(ref) ?? []).filter((l) => l.workflow_id === w.id)), pass.moves.get(ref) ?? [], head);
}

/**
 * Whether the head of an issue's implementation PR is one the workflow may go on with: an accepted one, or a commit of ours on the
 * branch we opened. "later": its facts are at another head, as for a moment after a push.
 */
function implHead(pass: Pass, w: ItemWorkflow, ref: string, head: string): "ours" | "theirs" | "later" | "unread" {
  const f = pass.facts.get(ref);
  if (accepted(pass, w, ref, head)) return "ours";
  if (!f) return "unread";
  return f.head !== head ? "later" : f.may.ownHead ? "ours" : "theirs";
}

/**
 * One pass over the live workflows. Writes only what changed, in one write at the end, or each workflow by itself when that
 * write fails; returns the workflows that moved to another state. `failed`, kept between passes, holds by id the workflows the pass
 * could not check or store (their merge legs must not move), each tried again after a failure backoff; `wake` is told when.
 */
export async function advanceWorkflows(db: Db, log: (line: string) => void = () => {}, wake: (at: number) => void = () => {}, failed: Map<number, FailedCheck> = new Map()): Promise<Moved[]> {
  return await withConfig(db, async () => {
    const at = new Date().toISOString();
    try {
      const started = await startAutoStops(db, at);
      if (started) log(`workflows: ${started} pull requests the automatic merge rule stopped now wait for an answer`);
    } catch (e) {
      if (isFenced(e)) throw e;
      log(`workflows: the automatic merge rule's stops were not started: ${(e as Error).message}`);
    }
    const live = await listWorkflows(db, { live: true });
    const ids = new Set(live.map((w) => w.id));
    for (const id of failed.keys()) if (!ids.has(id)) failed.delete(id);
    if (!live.length) { await showFailures(db, failed, log); return []; }
    const version = (w: ItemWorkflow): string => `${w.version} ${w.state} ${w.updatedAt}`;
    const now = Date.now();
    const due = live.filter((w) => { const f = failed.get(w.id); return !f || now >= f.until || f.version !== version(w); });
    for (const w of live) if (!due.includes(w)) wake(failed.get(w.id)!.until);
    const errors = new Map<number, unknown>();
    const issues = live.filter((w) => w.kind === "issue").map((w) => ({ repo: w.repo, number: w.number }));
    const [implement, goOn, issueReviews, own] = await db.together(() => Promise.all([
      loadImplementFacts(db, issues, { withPlans: true }), loadGoOnAt(db, live),
      loadIssueReviews(db, live.filter((w) => w.kind === "issue" && w.entry === "review").map((w) => w.id)), loadOwnLogins(db),
    ]));
    const prRefs = [...new Map(live.flatMap((w) => {
      const number = w.kind === "pr" ? w.number : candidatePr(implement.byIssue.get(key(w.repo, w.number)), w);
      return number === null ? [] : [[key(w.repo, number), { repo: w.repo, number }] as const];
    })).values()];
    const itemRefs = [...new Map([...live.map((w) => ({ repo: w.repo, number: w.number })), ...prRefs].map((r) => [key(r.repo, r.number), r])).values()];
    const [items, legs, reviews, patches, moves] = await db.together(() => {
      const patchFacts = loadPatchFacts(db, prRefs);
      return Promise.all([
        loadItems(db, itemRefs, "pr"), loadLegs(db, prRefs), loadReviewRows(db, prRefs), patchFacts, loadOwnPushes(db, prRefs, patchFacts),
      ]);
    });
    const byRef = <F extends { repo: string; number: number }>(list: F[]): Map<string, F> => new Map(list.map((f) => [key(f.repo, f.number), f]));
    const alone = live.filter((w) => w.kind === "issue" && candidatePr(implement.byIssue.get(key(w.repo, w.number)), w) === null);
    const facts = byRef(prRefs.length ? await loadPrFacts(db, { refs: prRefs.map((r) => key(r.repo, r.number)) }) : []);
    const issueFacts = byRef(alone.length ? await loadItemFacts(db, { refs: alone.map((w) => key(w.repo, w.number)) }) : []);
    // A question whose cause may go with the time comes back to the pass then: a timed hold, a backoff or a cache in the facts ends, or a new day begins.
    for (const f of [...facts.values(), ...issueFacts.values()]) if (f.refreshAt !== undefined) wake(f.refreshAt);
    for (const w of live) if (w.rec?.cause?.code === "daily-cap") wake(Date.parse(w.rec.cause.until));
    const ruleHeads = live.flatMap((w) => { const f = unansweredRuleRow(w) ? facts.get(key(w.repo, w.number)) : undefined; return f && f.head === w.recHead ? [f] : []; });
    const premerge = ruleHeads.length ? await premergeOf(db, ruleHeads) : new Map<string, PremergeRow>();
    const blockers = await loadBlockerReads(db, live.flatMap((w) => (w.rec?.cause?.code === "blocked-by" ? w.rec.cause.items : [])));
    const pass: Pass = {
      at, items, implement, goOn, legs, reviews, patches, moves, facts, premerge, issues: issueFacts, blockers, issueReviews, own, wake,
    };
    const writes: Writes = { workflows: [], adopt: [], stored: new Set(), closed: [], asks: [], carry: [] };
    const moved: Moved[] = [];
    for (const w of due) {
      try {
        const to = await advanceOne(db, pass, writes, w);
        if (to) moved.push({ id: w.id, repo: w.repo, number: w.number, to });
      } catch (e) {
        if (isFenced(e)) throw e;
        errors.set(w.id, e);
      }
    }
    const written = writes.workflows.length || writes.adopt.length ? await storeWrites(db, writes, due, log, errors) : new Set<number>();
    for (const w of due) {
      if (!errors.has(w.id)) { failed.delete(w.id); continue; }
      const was = failed.get(w.id), error = errors.get(w.id), times = (was?.times ?? 0) + 1, until = Date.now() + recheckDelayMs(times);
      failed.set(w.id, { ref: key(w.repo, w.number), times, error, until, version: version(w), since: was?.since ?? at });
      log(`workflow ${w.repo}#${w.number}: ${(error as Error).message}`);
      wake(until);
    }
    await showFailures(db, failed, log);
    return moved.filter((m) => written.has(m.id) || writes.stored.has(m.id));
  });
}

/** Stores the pass's writes in one transaction; when it fails, each workflow's in its own, and those that fail go into `errors`. A fenced write is thrown. Returns the workflows stored. */
async function storeWrites(db: Db, writes: Writes, due: ItemWorkflow[], log: (line: string) => void, errors: Map<number, unknown>): Promise<Set<number>> {
  const store = (o: Writes): Promise<Set<number>> => db.write(async () => {
    const ids = await moveWorkflows(db, o.workflows);
    await adoptLegs(db, o.adopt);
    const closed = o.closed.filter((c) => ids.has(c.w.id));
    await recordEvents(db, closed.map((c) => ({ workflowId: c.w.id, repo: c.w.repo, number: c.w.number, login: ACTOR, via: "cli" as const, kind: "set" as const, line: c.line, at: c.at })));
    await retryActions(db, { ids: closed.flatMap((c) => c.retry) });
    const asks = o.asks.filter((a) => ids.has(a.w.id));
    for (const a of asks) await queueAuthorAsk(db, a.w.id, a.pr, a.ask);
    await recordEvents(db, asks.map((a) => ({ workflowId: a.w.id, repo: a.w.repo, number: a.w.number, login: ACTOR, via: "cli" as const, kind: "set" as const, line: t("The review asks the author: {line}", { line: a.ask.line }), at: a.ask.at })));
    for (const c of o.carry) if (ids.has(c.w.id)) await carryFixups(db, c.repo, c.number, c.from, c.to);
    return ids;
  });
  try {
    return await store(writes);
  } catch (e) {
    if (isFenced(e)) throw e;
    const changed = due.filter((w) => writes.workflows.some((r) => r.id === w.id) || writes.adopt.some((r) => r.workflowId === w.id));
    log(`workflows: ${changed.length} changes not stored together, now one by one: ${(e as Error).message}`);
    const written = new Set<number>();
    for (const w of changed) {
      try {
        const ids = await store({
          workflows: writes.workflows.filter((r) => r.id === w.id), adopt: writes.adopt.filter((r) => r.workflowId === w.id), stored: writes.stored, closed: writes.closed.filter((c) => c.w.id === w.id), asks: writes.asks.filter((a) => a.w.id === w.id),
          carry: writes.carry.filter((c) => c.w.id === w.id),
        });
        for (const id of ids) written.add(id);
      } catch (err) {
        if (isFenced(err)) throw err;
        errors.set(w.id, err);
      }
    }
    return written;
  }
}

/**
 * The workflow that waits for its author with `ask`, whose comment AutoCraft did not post (`why`): it comes back to the person at the
 * ask's head, so it never waits for a comment nobody got. `again`: a yes asks the author again (the post failed or the PR moved); else
 * the author cannot be asked and a yes puts it in the backlog. Written only while the workflow still waits with that ask; true when written.
 */
export async function authorNotAsked(db: Db, workflowId: number, ask: AuthorAsk, why: string, again: boolean, at: string): Promise<boolean> {
  return await db.write(async () => {
    const w = (await listWorkflows(db, { ids: [workflowId], live: true }))[0];
    if (!w || authorAsk(w)?.at !== ask.at) return false;
    const drop = w.plan.filter((p) => p.state === "dropped").map((p) => p.n);
    const rec: Recommendation = again
      ? { text: t("AutoCraft did not ask the author: {why}. Ask the author to address the review's findings.", { why }), parts: { fix: [], drop }, merges: false, author: "scope" }
      : { text: t("AutoCraft does not ask the author: {why}. Put it in the backlog.", { why }), parts: { fix: [], drop }, merges: false, backlog: true };
    const approved = w.approvedBy !== null;
    await saveWorkflows(db, [{
      id: w.id, at,
      patch: { state: approved ? "blocked" : "recommending", rec, recAt: at, recHead: ask.head, blocker: approved ? "other" : null, blockerParams: approved ? { reason: why } : null },
    }]);
    await recordEvents(db, [{ workflowId: w.id, repo: w.repo, number: w.number, login: ACTOR, via: "cli", kind: approved ? "blocked" : "set", line: rec.text, at }]);
    return true;
  });
}

/**
 * Records on the workflow that waits for its author with `ask` that its comment is posted, or why it is not yet (`unsent`), so its status
 * says which. Written only while the workflow still waits with that ask and it changed; true when written.
 */
export async function authorAskState(db: Db, workflowId: number, ask: AuthorAsk, to: "posted" | { unsent: string }, at: string): Promise<boolean> {
  return await db.write(async () => {
    const w = (await listWorkflows(db, { ids: [workflowId], live: true }))[0];
    const now = w ? authorAsk(w) : null;
    if (!w || !now || now.at !== ask.at) return false;
    const { unsent: _, posted: __, ...rest } = now;
    const next: AuthorAsk = to === "posted" ? { ...rest, posted: true } : { ...rest, unsent: to.unsent };
    if (sameJson(next, now)) return false;
    await saveWorkflows(db, [{ id: w.id, at, patch: { blockerParams: { ...w.blockerParams, author: next } } }]);
    return true;
  });
}

/**
 * A person's fix-up of a PR that no merge leg works (not approved for merge), queued at the head our own push moved on from (the base
 * merge that comes first on a PR that conflicts): it is made at the new head. An approved PR's merge leg moves its own.
 */
async function carryFixups(db: Db, repo: string, number: number, from: string, to: string): Promise<void> {
  const queued = (await loadFixupRequests(db, { open: true, refs: [{ repo, number }], anyMaker: true })).filter((r) => r.state === "queued" && r.from_head === from);
  await moveFixupRequests(db, queued.map((r) => ({ id: r.id, from, to })));
}

/** A ready plan's numbered parts; a part a person dropped before (same title) stays dropped. Null when the plan gave none. */
function implementParts(before: readonly PlanPart[], reply: PlanReply | null): PlanPart[] | null {
  const parts = reply?.ready ? reply.workflow?.parts ?? [] : [];
  if (!parts.length) return null;
  const dropped = new Set(before.filter((p) => p.source === "implement" && p.state === "dropped").map((p) => p.title.toLowerCase()));
  return parts.map((p, i) => ({ n: i + 1, title: p.title, source: "implement" as const, ...(p.files[0] ? { file: p.files[0] } : {}), files: p.files, state: dropped.has(p.title.toLowerCase()) ? "dropped" as const : "planned" as const }));
}

/** The files of a diff stat (src/build/workspaces.ts diffStat): one ` path | +a -d` line per file, at most its first 40. */
const statFiles = (stat: string | null): string[] =>
  (stat ?? "").split("\n").flatMap((l) => { const m = / (.+) \| (?:binary|\+\d+ -\d+)$/.exec(l); return m ? [m[1]!.trim()] : []; });

/**
 * The files the implementation itself changed (its own diff when its PR opened, not our later fix-ups or revisions) that no
 * planned part of the plan it was built from names; null when the plan named no files or the attempt recorded no diff.
 */
function implementationBeyond(pass: Pass, w: ItemWorkflow, pr: number): string[] | null {
  const opened = pass.implement.byIssue.get(key(w.repo, w.number))?.prAttempts.find((p) => p.prNumber === pr);
  const parts = implementParts([], opened?.plan ?? null) ?? [];
  const plannedFiles = new Set(parts.flatMap((p) => p.files ?? []));
  const files = statFiles(opened?.diffStat ?? null).filter((f) => !LOCKFILE.test(f));
  if (!plannedFiles.size || !files.length) return null;
  return files.filter((f) => !plannedFiles.has(f));
}

/** The first of `names` the workflow's steps have, else its first step. */
const stepIn = (w: ItemWorkflow, ...names: StepName[]): StepName => {
  const steps = stepsFor(w.entry, w.approvedBy !== null);
  return names.find((n) => steps.includes(n)) ?? steps[0]!;
};

async function advanceOne(db: Db, pass: Pass, writes: Writes, w0: ItemWorkflow): Promise<ItemWorkflow["state"] | null> {
  const at = new Date().toISOString();
  // The PR the workflow works on: its own item, or an implement workflow's implementation PR; null while an issue has none.
  const attempts = w0.kind === "issue" && w0.entry === "implement" ? pass.implement.byIssue.get(key(w0.repo, w0.number)) : undefined;
  const candidate = candidatePr(attempts, w0);
  const work = workOf(attempts, w0, candidate === null ? null : pass.items.get(key(w0.repo, candidate)));
  const attempt = work.attempt;
  const target = w0.kind === "pr" ? w0.number : work.pr;
  let w = w0;
  /** The step the pass found the workflow at; written with the pass's other changes, or alone when only it changed. */
  let step: StepName | null = null;
  /** The step to record: an item back with its end recommendation is at "recommend"; one back with a question waits at its step. */
  const stepTo = (patch: WorkflowPatch): StepName | null => {
    const rec = patch.rec !== undefined ? patch.rec : w.rec;
    return (patch.state ?? w.state) === "recommending" && !rec?.question ? stepIn(w, "recommend", "merge") : step;
  };
  const withStep = (patch: WorkflowPatch): WorkflowPatch => {
    const s = stepTo(patch);
    return { ...patch, ...(s !== null && s !== w0.step ? { step: s } : {}) };
  };
  const write = (patch: WorkflowPatch): ItemWorkflow["state"] | null => {
    const next = patch.state ?? w.state;
    writes.workflows.push({ id: w.id, patch: withStep(patch), at, was: w0 });
    return next !== w0.state ? next : null;
  };
  /** Ends the pass: writes what changed (the step included). */
  const settle = (patch: WorkflowPatch): ItemWorkflow["state"] | null => {
    const s = stepTo(patch);
    return Object.keys(patch).length || (s !== null && s !== w0.step) ? write(patch) : null;
  };
  const legRow = target === null ? null : (pass.legs.get(key(w0.repo, target)) ?? []).filter((l) => ACTIVE_LEG.includes(l.state)).at(-1) ?? null;
  /** Stops the workflow at a blocker, with the merge leg that works for it; a stop that cannot be made now settles `otherwise` instead. */
  const block = async (patch: WorkflowPatch & { blocker: Blocker }, otherwise: WorkflowPatch): Promise<ItemWorkflow["state"] | null> => {
    const r = await blockWorkflow(db, {
      w: w0, patch: withStep({ ...patch, state: "blocked" }), at, line: patch.rec?.text ?? null, pr: target === null ? null : { repo: w.repo, number: target }, leg: legRow,
      stop: { code: "blocked", who: "person", params: { blocker: patch.blocker }, text: OWN_CANCEL },
    });
    switch (r) {
      case "written": writes.stored.add(w0.id); return w0.state === "blocked" ? null : "blocked";
      case "changed": return null;
      case "merging": return settle(otherwise);
    }
  };
  const self = pass.items.get(key(w.repo, w.number));
  const base: WorkflowPatch = {};
  /** When the question the workflow stood at on this pass was made: a review older than it was read for that question. */
  const leftQuestionAt = w0.state === "blocked" || w0.state === "recommending" ? w0.recAt : null;
  // A recommendation that stands for an implementation's question goes once the question is answered or set aside elsewhere (a
  // comment on the issue, an edited issue, a later round): the workflow runs on.
  const asks = askedBy(w.rec);
  if ((w.state === "blocked" || w.state === "recommending") && asks && !isOpenQuestion(attempt, asks)) {
    const on = { state: "running", rec: null, recAt: null, recHead: null, blocker: null, blockerParams: null } as const satisfies WorkflowPatch;
    Object.assign(base, on);
    w = { ...w, ...on };
  }
  /** The question made at `head`: one that follows another the author pushed past says so. */
  const ask = (rec: Recommendation, head: string): Recommendation => (w.recHead !== null && !ownChain(pass, key(w.repo, target!), w.recHead, head) ? afterPush(rec) : rec);
  /** The attempt's open question, as the issue's recommendation; a stuck attempt of an approved issue is a step that failed twice. */
  const comeBack = async (patch: WorkflowPatch, head: string | null): Promise<{ to: ItemWorkflow["state"] | null } | null> => {
    const q = openQuestionOf(attempt);
    if (!attempt || !q) return null;
    const { plan, rec } = viewOf(attempt, q, patch.plan ?? w.plan, w.approvedBy !== null);
    const asked: WorkflowPatch = { ...patch, plan, rec: head !== null ? ask(rec, head) : rec, recAt: pass.at, recHead: head };
    return { to: attempt.attempt.state === "stuck" && w.approvedBy !== null
      ? await block({ ...asked, blocker: "failed-twice", blockerParams: { step: "implement" } }, patch)
      : write({ ...asked, state: "recommending", blocker: null, blockerParams: null }) };
  };
  /** The approver's merge, refused before for their access, is tried again with this pass's write. */
  let retried = false;
  /** Closes the question whose cause went: the item goes on with the plan and the approval it had. */
  const closeQuestion = async (why: string): Promise<void> => {
    const gone = w.rec?.cause?.code === "actor-gone" && w.approvedBy !== null && target !== null;
    const waiting = gone ? [...(await loadActions(db, { workflowIds: [w.id], kinds: ["merge"], states: ["waiting-permission"] })).values()].flat().filter((a) => a.by.toLowerCase() === w.approvedBy!.toLowerCase()) : [];
    retried = waiting.length > 0;
    writes.closed.push({ w, line: t("The question closed without an answer: {why} {rec}", { why, rec: w.rec!.text }), at, retry: waiting.map((a) => a.id) });
    const on = { state: "running", rec: null, recAt: null, recHead: null, blocker: null, blockerParams: null } as const satisfies WorkflowPatch;
    Object.assign(base, on);
    w = { ...w, ...on };
  };
  /** Comes back with the question: an approved item stops at it, one not approved shows its recommendation. */
  const comeWith = async (q: Question, patch: WorkflowPatch, head: string | null): Promise<ItemWorkflow["state"] | null> => {
    // What the question is about may have happened while the pass was reading.
    const recAt = q.showed !== undefined && q.showed > pass.at ? q.showed : pass.at;
    const asked: WorkflowPatch = { ...patch, rec: head !== null ? ask(q.rec, head) : q.rec, recAt, recHead: head };
    return w.approvedBy !== null ? await block({ ...asked, blocker: q.blocker, blockerParams: q.params }, patch) : write({ ...asked, state: "recommending", blocker: null, blockerParams: null });
  };
  /**
   * An issue's review: it runs while its newest row is queued, waits while the row's question to the reporter is to be posted or
   * answered, and comes back with the review's recommendation; `review and implement` goes on to implement without a question when
   * the review recommends that. While the recommendation waits for its answer nothing moves.
   */
  const issueReviewed = (row: IssueReviewRow | null): ItemWorkflow["state"] | null => {
    step = "review";
    if (!row || (w.state !== "running" && w.state !== "waiting")) return settle(base);
    if (row.state === "done" || row.state === "failed") {
      if (row.thenImplement && recommendsImplement(row)) {
        step = "implement";
        return write({ ...base, entry: "implement", state: "running", plan: [], rec: null, recAt: null, recHead: null });
      }
      return write({ ...base, state: "recommending", rec: issueRecommendation(row), recAt: pass.at, recHead: null });
    }
    const to = row.state === "ask" || row.state === "reporter" ? "waiting" : "running";
    return settle({ ...base, ...(w.state !== to ? { state: to } : {}) });
  };
  if (target === null) {
    // An issue with no PR yet: it ends when the issue closes, comes back with its implementation's question, and shows a ready plan's parts.
    if (self && self.state !== "OPEN") return write({ state: "closed", rec: null, blocker: null, blockerParams: null });
    if (w.entry === "review") return issueReviewed(pass.issueReviews.get(w.id) ?? null);
    step = stepIn(w, "implement");
    const issueFacts = pass.issues.get(key(w.repo, w.number));
    if (w.state === "blocked" || w.state === "recommending") {
      const went = issueFacts ? causeWent(w.rec?.cause, issueFacts, w.approvedBy !== null, { at: pass.at }) : null;
      if (went === null) return settle(base);
      await closeQuestion(went);
    }
    const asked = await comeBack(base, null);
    if (asked) return asked.to;
    const question = issueFacts ? itemQuestion(issueFacts, { approved: w.approvedBy !== null, parts: w.plan }) : null;
    if (question) return await comeWith(question, base, null);
    if (!attempt) return settle(base);
    // A ready plan's parts; an answered question's options are no plan any more.
    const parts = implementParts(w.plan, (attempt.planned?.plan ?? null) as PlanReply | null) ?? (w.plan.some((p) => p.option !== undefined) ? [] : null);
    return settle({ ...base, ...(parts && !sameJson(parts, w.plan) ? { plan: parts } : {}) });
  }
  const ref = key(w.repo, target);
  const pr = pass.items.get(ref);
  if (!pr) return settle(base);
  if (pr.state === "MERGED") return write({ state: "done", rec: null, blocker: null, blockerParams: null });
  if (pr.state !== "OPEN") return write({ state: "closed", rec: null, blocker: null, blockerParams: null });
  const head = pr.head_oid;
  // Waiting for the author: nothing moves until they push. Their push ends the wait, and the item is looked at like a running one, so
  // its new commits are reviewed (the review round, on a PR approved for merge). A comment of theirs, or a push of ours, changes nothing.
  const waitsOn = authorAsk(w);
  if (waitsOn) {
    step = stepIn(w, "review again", "review");
    if (!head || head === waitsOn.head || ownChain(pass, ref, waitsOn.head, head)) return settle(base);
    const on = { state: "running", blocker: null, blockerParams: null } as const satisfies WorkflowPatch;
    Object.assign(base, on);
    w = { ...w, ...on };
  }
  // Waiting for a person: nothing moves until they answer, the cause of their question goes, or someone else pushes past the head their question was made at. Then the
  // question goes and the item is looked at like a running one; `recHead` stays, so that the next question says why it is asked.
  let repushed = w.state === "blocked" || w.state === "recommending";
  // The question closed because what ended the merge leg went (the hold that stopped its fix-up, a refusal of its merge, the items its review
  // waited for): that leg says nothing any more, and a new one starts.
  let legWent: ((leg: EndedLeg) => boolean) | null = null;
  // A stop at the author's commits made before they went through the review round: the round takes its place.
  if (w.state === "blocked" && w.kind === "pr" && w.blocker === "author-commits" && w.blockerParams?.round === undefined && w.rec) {
    await closeQuestion(t("the author's new commits are reviewed first, and the merge stays approved."));
    repushed = false;
  }
  if (repushed && (!head || w.recHead === null || ownChain(pass, ref, w.recHead, head))) {
    // Nor does it wait when what the question is about went: the approval covers the head, or our pushes on it, as it did.
    const now = pass.facts.get(ref);
    // The automatic merge rule's question nobody answered stands only while the rule would stop the PR there as it did (auto-stop.ts).
    if (unansweredRuleRow(w) && now && now.head === head && head === w.recHead && (pass.goOn.get(w.id)?.said ?? w.startedAt) <= w.startedAt) {
      const again = recheckRuleRow(w, now, pass.reviews.get(ref) ?? [], pass.premerge.get(headKey(now)) ?? null);
      if (again === "superseded") return write({ state: "superseded", rec: null, recAt: null, blocker: null, blockerParams: null });
      if (again) return write({ ...base, rec: again.rec, recAt: pass.at, plan: again.plan });
    }
    const approved = w.approvedBy !== null;
    const causeNow: CauseNow = {
      at: pass.at,
      fixState: (fix) => tryState(pass, ref, fix),
      waitNow: () => {
        if (!now) return undefined;
        const r = asRunning(now), plan = decidePr(r), asked = w.rec?.cause?.code === "wait" ? w.rec.cause.wait : null;
        // The question ended the merge leg, and the plan waits for the next one, which would stop at a wait that a working leg carries past
        // the plan: whether it still stands the facts cannot say.
        if (plan.waitCode === "leg" && asked !== null && LEG_CARRIES.includes(asked)) return undefined;
        return (questionFor(r, plan, { approved, review: null, parts: w.plan, conflict: conflictOf(r) })?.params.code as string | undefined) ?? null;
      },
      blocks: (items) => openFrom(pass.blockers, items).length > 0,
    };
    const went = head && w.recHead !== null && now?.head === head ? causeWent(w.rec?.cause, now, approved, causeNow) ?? recounted(pass, w, ref, head, now) : null;
    if (went === null) return settle(base);
    const cause = w.rec?.cause?.code;
    legWent = cause === "fix-unmade" || cause === "leg" ? fixUnmade
      : cause === "merge-refused" ? (l) => codeOf(l) === "merge-refused"
        : cause === "blocked-by" ? (l) => codeOf(l) === "review-hold" : null;
    await closeQuestion(went);
    repushed = false;
    // The items the review held it for went: it is reviewed again, as a yes would have it, and the item goes on once that review is made.
    if (cause === "blocked-by") {
      await markReviewsStale(db, ACTOR, w.repo, target);
      if (!approved) return settle(base);
    }
  }
  if (repushed) {
    // The facts are at another head, as for a moment after a push: the next pass looks again.
    if ((pass.facts.get(ref)?.head ?? head) !== head) return settle(base);
    const on = { state: "running", rec: null, recAt: null, blocker: null, blockerParams: null } as const satisfies WorkflowPatch;
    Object.assign(base, on);
    w = { ...w, ...on };
  }
  if (!head) return settle(base);
  const { since, said, resumed } = pass.goOn.get(w.id) ?? { since: w.startedAt, said: w.startedAt, resumed: null };
  const agreed = agreedAt({ approvedAt: w.approvedAt, since, said });
  const patch: WorkflowPatch = { ...base };

  // The head the workflow accepted moves along our own pushes; any other push is the author's.
  let authorPush: BlockerFacts["authorPush"] = null;
  const baseHead = w.kind === "pr" ? w.baseHead : null;
  if (!baseHead || w.kind !== "pr") {
    if (w.kind === "pr") Object.assign(patch, { baseHead: head, acceptedHead: head });
  } else if (baseHead !== head) {
    if (ownChain(pass, ref, baseHead, head)) {
      Object.assign(patch, { baseHead: head, acceptedHead: head });
      if (!w.approvedBy) writes.carry.push({ w, repo: w.repo, number: target, from: baseHead, to: head });
    }
    else authorPush = { from: baseHead, to: head };
  }

  const impl = w.kind === "issue" ? implHead(pass, w, ref, head) : null;
  if (w.kind === "issue" && w.acceptedHead !== null && w.acceptedHead !== head && ownChain(pass, ref, w.acceptedHead, head)) patch.acceptedHead = head;
  if (impl === "theirs") authorPush = { from: w.acceptedHead ?? w.baseHead ?? (pass.legs.get(ref) ?? []).filter((l) => l.workflow_id === w.id).at(-1)?.head ?? "", to: head };
  // Past a question nobody answered, nothing but an accepted head goes on by itself.
  if (repushed && !authorPush && !accepted(pass, w, ref, head)) authorPush = { from: w.recHead, to: head };
  // The automatic merge rule's question that nobody answered is about commits that are gone: the rule takes the PR back (auto-stop.ts).
  if (authorPush && w.startedBy === RULE_STARTER && w.approvedBy === null && said <= w.startedAt && resumed === null) {
    return write({ state: "superseded", rec: null, recAt: null, blocker: null, blockerParams: null });
  }

  // The numbered plan follows the latest review at the head; a merge-queue entry has none, unless it owes one.
  const gone = { entry: w.entry, startedAt: w.startedAt, since, reviewAskedAt: w.reviewAskedAt };
  const needed = neededReview(gone, pass.moves.get(ref) ?? [], head, pass.reviews.get(ref) ?? []);
  const stored = reviewAt(pass, ref, head);
  const review = stored && needed && (needed.from === null || stored.at > needed.from) ? stored : null;
  const read = pass.facts.get(ref);
  // Where a new review failed for good, the question also names what an earlier one of the head asks.
  const says = review ?? (needed && read?.head === head && read.reviewHold?.kind === "failed" && read.reviewHold.until === undefined ? stored : null);
  const plan: PlanPart[] = says ? planOf(says.fixes, w.plan) : w.plan;
  if (!sameJson(plan, w.plan)) patch.plan = plan;
  const view: ReviewView | null = says ? { verdict: says.verdict, sure: says.sure, rec: says.workflow?.recommendation ?? null, finding: says.public_summary, blockedBy: says.blocked_by, hold: says.workflow?.hold } : null;

  // The step: the merge leg's state for the merge part, else where the review and its fixes are.
  const leg = legRow?.state ?? null;
  if (leg === "fixup") step = stepIn(w, "fix-up", "update from main");
  else if (leg === "review") step = stepIn(w, "review again", "update from main");
  else if (leg === "ci") step = stepIn(w, "fix CI and conflicts", "merge");
  else if (leg === "queued") step = stepIn(w, "batch", "merge");
  else if (w.entry === "merge") step = stepIn(w, "update from main");
  else if (!review) step = (pass.reviews.get(ref) ?? []).some((r) => r.head !== head) ? stepIn(w, "review again", "review") : stepIn(w, "review");
  else if (review.verdict === "take-fix" && partsToMake(plan, review.fixes, w.approvedBy !== null).length && (w.entry !== "review" || w.approvedBy !== null)) step = stepIn(w, "fix-up", "merge", "recommend");
  else step = stepIn(w, "merge", "recommend");

  // A stuck revision of the implementation PR comes back before anything else the PR needs.
  const asked = w.kind === "issue" ? await comeBack(patch, head) : null;
  if (asked) return asked.to;
  // An implementation's files beyond its plan are shown once: base_head of an implement issue is the implementation PR head the
  // workflow showed them at, and it follows our own pushes; a new attempt's PR, or someone else's push, is shown again.
  let beyond: string[] | null = null;
  if (w.kind === "issue") {
    const shown = w.baseHead !== null && (w.baseHead === head || ownChain(pass, ref, w.baseHead, head));
    if (shown) { if (w.baseHead !== head) patch.baseHead = head; }
    else beyond = implementationBeyond(pass, w, target);
  }
  const approved = w.approvedBy !== null;
  // A question that went leaves the workflow running, as the facts do not say yet.
  const f = read?.may.workflow && w.state !== w0.state ? { ...read, may: { ...read.may, workflow: { ...read.may.workflow, state: w.state, blocker: null } }, ...(retried ? { mergeWaiting: false, mergeLacksAccess: false } : {}) } : read;
  const conflict = f?.head === head ? conflictOf(f) : null;
  const stopped = approved ? endedLeg(pass, w, since, resumed) : null;
  // Once CI is green at the head, a leg that red CI ended says nothing any more: a new one starts.
  // Nor does a leg the pre-merge review's defects ended, once a fix-up round repairs them at the head.
  let ended = stopped && ((codeOf(stopped) === "ci-failed" && f?.head === head && causeWent({ code: "red-ci" }, f, approved, { at: pass.at }) !== null) || (premergeStop(stopped) && premergeStopLifts(f, head)) || legWent?.(stopped)) ? null : stopped;
  const blockerRec = (x: Found, parts: readonly PlanPart[]): Recommendation => {
    const o = { approved, review: view, parts: plan, conflict }, now = f?.head === head ? f : null;
    const rec = (now && ended && x.params.reason === ended.reason ? legStop(codeOf(ended), now, o) : null) ?? atBlocker(x, view, parts, w.entry === "merge");
    return onConflict(now ? fixable(rec, now, o) : rec, conflict);
  };
  // The review round of the author's new commits on an approved PR: the approval stays, and the merge leg starts again at a head the
  // round accepts. A review carried to the head (the PR's own diff is unchanged) accepts it without a model call, and so does a review that
  // finds the commits within what was approved; one that finds them beyond it asks the approver, naming its public finding. A merge entry
  // owes the review as one a person asked for, so the planner makes it and the new leg waits for it.
  if (w.kind === "pr" && authorPush && approved) {
    // A review hold written without a model call (too large to review) judged nothing: the approver decides.
    const unread = stored !== null && stored.model === null;
    // The day's rounds are used up: the approver says whether the author's new commits are reviewed too.
    const rounds = roundsToday(pass.reviews.get(ref) ?? [], pass.moves.get(ref) ?? [], { head, since, startedAt: w.startedAt, now: Date.parse(pass.at) });
    if (rounds >= AUTHOR_ROUNDS_PER_DAY && !(stored?.mode === "carried")) {
      const round: Found = { blocker: "author-commits", params: { from: authorPush.from, to: head, round: "daily-cap", rounds } };
      // A new day gives the rounds again: the question closes by itself then, unless someone answered it first.
      const until = nextUtcMidnight(Date.parse(pass.at));
      pass.wake(until);
      const rec: Recommendation = { ...blockerRec(round, plan), cause: { code: "daily-cap", until: new Date(until).toISOString() } };
      return await block({ ...patch, blocker: round.blocker, blockerParams: round.params, rec: ask(rec, head), recAt: pass.at, recHead: head }, patch);
    }
    if (stored && !unread && (stored.mode === "carried" || stored.workflow?.author_commits?.in_scope !== false)) {
      Object.assign(patch, { baseHead: head, acceptedHead: head });
      authorPush = null;
    } else {
      let round: Found | null = null;
      if (unread) round = { blocker: "other", params: { reason: unreadReason(stored.reason), round: "too-large" } };
      else if (stored) round = { blocker: "author-commits", params: { from: authorPush.from, to: head, round: "out-of-scope", ...(stored.public_summary ? { finding: stored.public_summary } : {}) } };
      else if (read?.head === head && read.reviewHold?.kind === "failed" && read.reviewHold.until === undefined) {
        round = { blocker: "other", params: { reason: t("the review of the author's new commits failed"), round: "review-failed" } };
      }
      if (round) return await block({ ...patch, blocker: round.blocker, blockerParams: round.params, rec: ask(blockerRec(round, plan), head), recAt: pass.at, recHead: head }, patch);
      const owes = w.reviewAskedAt !== null && !(pass.reviews.get(ref) ?? []).some((r) => r.at > w.reviewAskedAt!);
      if (w.entry === "merge" && !owes) patch.reviewAskedAt = pass.at;
      step = ROUND_STEP;
      return settle(patch);
    }
  }
  // A leg a check of an earlier head stopped says nothing about a head the workflow accepted since (a review round took in the author's
  // commits, or our pushes followed): a new leg checks this one.
  if (ended && !authorPush && checkedOtherHead(ended, head)) ended = null;
  const found = detectBlocker({ entry: w.entry, approved, authorPush, failures: failures(pass, ref, since, head, f), leg: ended });
  if (found) {
    // A CI fix that failed twice names what fails and what it tried last.
    if (found.blocker === "failed-twice" && found.params.step === "CI fix" && f?.head === head && f.cifix) {
      if (f.cifix.failing.length) found.params.failing = f.cifix.failing.slice(0, 3);
      if (f.cifix.lastTry) found.params.last = f.cifix.lastTry;
    }
    const shown: WorkflowPatch = impl === "theirs" ? { baseHead: head } : {};
    let rec = blockerRec(found, plan);
    // A leg that ended on a fix-up try, or on a refused merge, comes back once that try is superseded or the refusal no longer stands.
    if (!rec.cause && ended && found.params.reason === ended.reason) {
      const tried = fixUnmade(ended) && ended.fix != null ? tryState(pass, ref, ended.fix) : null;
      if (tried !== null) rec = { ...rec, cause: { code: "leg", fix: ended.fix!, state: tried } };
      else if (codeOf(ended) === "merge-refused") rec = { ...rec, cause: { code: "merge-refused" } };
    }
    // The merge leg stops before it can merge. One an integration batch holds goes through; a queued leg outside a batch is cancelled like any other.
    return await block({ ...patch, ...shown, blocker: found.blocker, blockerParams: found.params, rec: ask(rec, head), recAt: pass.at, recHead: head }, patch);
  }

  /**
   * A finding the approved merge needs fixed first: AutoCraft asks for the fix-up as the approver, as their yes to the question it would
   * have asked, and the merge goes on after its push is reviewed and checked again. A fix-up asked for at the head already, in any state,
   * comes first, and so does a push of ours the mirror does not show yet. These come back at once: a review that says close (a duplicate,
   * an obsolete change: nothing to fix), a review made without a model call (too large, or tests only: it judged nothing), a hold that
   * waits for other items, pre-merge defects that name nothing to fix. With the fix-up tries since the approver last went on used up, the
   * question is whether to merge it as it is; a fix-up that cannot be asked for otherwise is a fix that could not be made.
   */
  const fixFirst = async (cause: FixCause): Promise<ItemWorkflow["state"] | null> => {
    const stop = async (x: Found, parts: readonly PlanPart[] = plan, rec = blockerRec(x, parts)): Promise<ItemWorkflow["state"] | null> =>
      await block({ ...patch, ...(parts !== plan ? { plan: [...parts] } : {}), blocker: x.blocker, blockerParams: x.params, rec: ask(rec, head), recAt: pass.at, recHead: head }, patch);
    if ((pass.moves.get(ref) ?? []).some((x) => x.landed && x.from === head && x.to !== head && x.at > since)) return settle(patch);
    const asked = await fixupRequestsAt(db, w.repo, target, head, since);
    if (asked.length) {
      // The latest one ended without a push: what it was to fix could not be fixed at this head.
      const last = (await loadOperatorFixResults(db, asked)).get(asked.at(-1)!);
      if (!last || !UNFIXED.includes(last.state)) return settle(patch);
      const tried = await operatorTries(db, w.repo, target, since);
      const parts = plan.filter((p) => p.premerge && p.state === "planned").map((p) => p.n);
      return await stop({ blocker: "failed-twice", params: { step: "fix-up", count: tried, reason: t("the fix-up ended without a push") } }, plan, triedEnough(t(FIX_WHAT[cause]), tried, plan, parts, last.reason));
    }
    const reviewed = cause === "review-hold" || cause === "review-close";
    if (reviewed && stored && stored.model === null) return await stop({ blocker: "other", params: { reason: unreadReason(stored.reason), round: "too-large" } });
    if (cause === "review-close") return await stop({ blocker: "other", params: { reason: t("the review says to close it") } }, plan, closeRec(stored?.public_summary ?? null, plan));
    if (reviewed && stored?.blocked_by?.length) return await stop({ blocker: "other", params: { reason: t("the review holds it until other items are settled") } }, plan, waitsForOthers(stored.public_summary, stored.blocked_by, plan));
    let fixPlan = plan, fix: number[] = [], instruction: Instruction | null = null;
    if (cause === "premerge-defect") {
      const extra = await premergeParts(db, { repo: w.repo, number: target, head }, plan, true);
      if (!extra.length) return await stop({ blocker: "other", params: { reason: t("the pre-merge review's defects name nothing to fix") } }, plan, { text: t("The pre-merge review found defects but names nothing to fix. Review it again, then merge."), parts: { fix: [], drop: droppedOf(plan) }, merges: true, again: "review" });
      fixPlan = [...plan, ...extra];
      fix = extra.map((p) => p.n);
    } else if (cause === "verification-failed" || cause === "screenshots") {
      const said = (cause === "screenshots" ? f?.screenshots?.summary : (await verificationOf(db, w.repo, target, head))?.summary)?.trim();
      const what = cause === "screenshots" ? "The screenshots of this pull request show a regression" : "The verification of this pull request failed";
      instruction = { text: clipText(said ? `${what}. Fix it. What it found:\n${said}` : `${what}. Find the cause and fix it.`, FINDING_FIX_CHARS) };
    } else {
      fix = partsToMake(plan, stored?.fixes ?? [], true).map((p) => p.n);
      const finding = (stored?.public_summary ?? stored?.reason ?? "").trim();
      if (finding) instruction = { text: clipText(finding, FINDING_FIX_CHARS), review: true };
    }
    // A conflict with the base branch that no step of ours merges first: no fix-up can be made before someone settles it.
    if (conflict && conflict.path !== "merge") {
      const rec: Recommendation = { ...onConflict({ text: textFor({ fix, merges: true }), parts: { fix, drop: droppedOf(plan) }, merges: true }, conflict), cause: { code: "conflict" } };
      return await stop({ blocker: "other", params: { reason: t("it conflicts with its base branch, and no fix-up can be made before that is settled") } }, fixPlan, rec);
    }
    const tries = await operatorTries(db, w.repo, target, since);
    if (tries >= FIXUP_MAX_ATTEMPTS) {
      const asIs = triedEnough(t(FIX_WHAT[cause]), tries, fixPlan, fix, null, instruction);
      return await stop({ blocker: "failed-twice", params: { step: "fix-up", count: tries, reason: t("the fix-up tries are used up") } }, fixPlan, asIs);
    }
    try {
      const r = await fixAgain({ db, by: w.approvedBy!, via: "cli", at, item: { repo: w.repo, number: target, kind: "pr", head }, workflowId: w.id }, { again: "fixup", plan: fixPlan, fix, merges: true, instruction });
      await db.write(() => r.write(w.id));
    } catch (e) {
      if (!(e instanceof EffectError)) throw e;
      if (e.later) return settle(patch);
      // A check that failed is no refusal: the workflow is checked again after the failure backoff, and nothing stops for it.
      if (e.unknown) throw e.cause;
      return await stop({ blocker: "failed-twice", params: { step: "fix-up", reason: t("AutoCraft could not ask for a fix-up of {what}: {why}", { what: t(FIX_WHAT[cause]), why: e.message }) } }, fixPlan);
    }
    return settle({ ...patch, ...(fixPlan !== plan ? { plan: fixPlan } : {}) });
  };
  if (approved && impl !== "later" && ended && fixesFirst(ended)) return await fixFirst(codeOf(ended) as FixCause);

  const question = f && f.head === head ? questionFor(f, decidePr(f), { approved, review: view, parts: plan, conflict }) : null;
  const fixWait = approved && question && FIX_WAITS.includes(question.params.code as FixCause) ? question.params.code as FixCause : null;
  if (fixWait && impl !== "later") return await fixFirst(fixWait);
  if (!approved) {
    if (question) {
      let { rec } = question;
      // The end recommendation also says which files the implementation changed beyond its plan; they count as shown.
      if (beyond?.length) {
        rec = { ...rec, text: t("{text} The implementation also changes {files}, which no part of its plan names.", { text: rec.text, files: listText(beyond.slice(0, 10)) }) };
        patch.baseHead = head;
      }
      // A bot, AutoCraft itself or a quiet PR's author is never asked: a yes puts the item in the backlog instead.
      const unaskable = rec.author && w.kind === "pr" ? authorUnaskable({ login: pr.author, type: pr.author_type, quiet: !!f?.quiet, own: pass.own }) : null;
      if (unaskable) rec = withoutAuthor(rec, unaskable, says?.public_summary ?? null);
      // The review finds the PR incomplete or wrong and recommends asking its author: AutoCraft does that at once, and the item waits for
      // their push. Only a review made since the person last started or answered (or one that asks in its own words) asks by itself, and
      // never one made before a question this workflow left (it closed by itself, or a push went past it) or before the last resume: that
      // review, read again, comes back as the question, and the person who resumed can still say ask author.
      const fresh = says !== null && (says.workflow?.recommendation?.author === true || says.at > since)
        && (leftQuestionAt === null || says.at > leftQuestionAt) && (resumed === null || says.at > resumed);
      if (rec.author === "ask" && w.kind === "pr" && says && says.head === head && w.startedBy !== RULE_STARTER && fresh) {
        const login = pr.author ?? null;
        const conflict = pr.mergeable === "CONFLICTING" ? pr.base_ref ?? null : null;
        const asked = authorAskFor({ login, head, review: says, plan, words: null, by: w.takenBy ?? w.startedBy, at: pass.at, conflict, auto: true, unsent: await actBlocked(db, w.repo) });
        writes.asks.push({ w, pr: { repo: w.repo, number: target }, ask: asked });
        return write({ ...patch, state: "waiting", rec: null, recAt: null, recHead: null, blocker: null, blockerParams: { author: asked } });
      }
      return await comeWith({ ...question, rec }, patch, head);
    }
  } else if (question && impl !== "later" && !(question.params.code === "conflict-person" && answeredAt(w, pass.moves, ref, head, said))) return await comeWith(question, patch, head);
  else if (impl !== "later") {
    const refused = await ensureLeg(db, pass, writes, w, w.repo, target, head, agreed);
    if (refused) {
      const stop: Found = { blocker: "other", params: { reason: refused } };
      return await block({ ...patch, blocker: stop.blocker, blockerParams: stop.params, rec: ask(blockerRec(stop, plan), head), recAt: pass.at, recHead: head }, patch);
    }
    // The head its merge leg starts at.
    if (impl === "ours" && w.acceptedHead !== head) patch.acceptedHead = head;
  }
  return settle(patch);
}
