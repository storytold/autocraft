// decideItem: the triage rules of one open item (issue or PR) in one place: classify, referee, prioritize, embed, duplicates,
// label. Pure: no database, no clock (facts carry `now`). The rules are ported from the step selectors named at each rule.
// decideAll adds a PR's review-to-merge Plan (decide.ts) and derives the Work page's next-step text.
import { BUILD_STATES, ENDED_STATES, MAX_LIVE_PER_REPO, type ImplementBucket, type ImplementationState } from "../implement/types.ts";
import { isWork, unassignActions } from "./assignment.ts";
import { IMPLEMENT_START_RETRIES, issueReviewDueAt } from "./backoff.ts";
import { permitted } from "./authority.ts";
import type { WaitCode } from "./codes.ts";
import { BOX_IDENTITY_WAIT, decidePr, implementOffWait, notStarted, ownRetryWait, refusedWait, standingWait, TELLS, waitFields, type Wait } from "./decide.ts";
import { REFEREE_RETRY_MS, alreadyLabeled, isScope, labelsToAdd } from "./item-rules.ts";
import { unsentAsk } from "./rules.ts";
import type { Action, ItemFacts, ItemPlan, ItemState, ItemView, PassFacts, PrFacts } from "./plan.ts";

const act = (kind: Action["kind"], head: string | null, params?: Record<string, unknown>): Action => ({ kind, head, ...(params ? { params } : {}) });
const person = (code: WaitCode, text: string): Wait => ({ code, who: "person", text });
const system = (code: WaitCode, text: string): Wait => ({ code, who: "system", text });

export { BOX_IDENTITY_WAIT, implementOffWait };
/** The wait of a queued issue whose latest attempt ended without a merged PR and whose text has not changed since. */
export const IMPLEMENT_ENDED_WAIT = "a person to queue the implementation again";

/**
 * The Implement stage's step for an issue, or the wait that holds it; null when the issue is not queued (no live implement
 * workflow) or another rule says what it waits on (a hold).
 * A new attempt starts when there is none, or the last one ended and the issue text changed or it was queued again since; it needs the repo's
 * Implement feature and room among the repo's live implementations, and waits while an open PR closes the issue (a PR that only mentions
 * it holds nothing). A question is planned again when its answer may have
 * come: the issue text changed, a person commented after it, or the workflow's recommendation is answered. An attempt whose workspace
 * did not start before its plan call is planned again by AutoCraft after the retry's backoff (start-retry.ts).
 */
export function implementStep(f: ItemFacts): { bucket: ImplementBucket } | { wait: Wait } | null {
  const im = f.implement, row = im.row;
  if (f.kind !== "issue" || !f.open || !f.inScope || f.held || im.queuedBy === null) return null;
  const state = row?.state as ImplementationState | undefined;
  const ended = !row || ENDED_STATES.has(state!);
  if (im.standing === "no" && ended) return null;
  const held = standingWait(im, f.repo);
  if (held) return { wait: held };
  const due = (bucket: ImplementBucket) => (im.featureOn ? { bucket } : { wait: system("implement-off", implementOffWait(f.repo)) });
  if (ended) {
    if (f.openPr?.closes) return { wait: system("open-pr", answerPrWait(f.openPr.number)) };
    if (row && !row.textChanged && !row.requeuedAfterEnd) return { wait: person("implement-ended", IMPLEMENT_ENDED_WAIT) };
    if (im.featureOn && im.liveInRepo >= MAX_LIVE_PER_REPO) return { wait: system("implement-room", `${im.liveInRepo} implementations already running in ${f.repo}`) };
    return due("plan");
  }
  const retry = row!.startRetry;
  if (retry && f.now < retry.dueAt) return { wait: system("implement-start-retry", `a new workspace start at ${new Date(retry.dueAt).toISOString().slice(11, 16)} UTC (retry ${retry.failures} of ${IMPLEMENT_START_RETRIES})`) };
  const own = row!.ownRetry;
  if (own && f.now < own.dueAt) return { wait: ownRetryWait(own) };
  if (state === "planning") return due("plan");
  if (state === "asked") {
    if (row!.textChanged || row!.newCommentAfterQuestion || row!.decisionAnswered) return due("plan");
    return { wait: row!.asked === "author" ? { code: "implement-question", who: "contributor", text: "the author's answer" } : person("implement-question", "a maintainer's answer") };
  }
  if (BUILD_STATES.has(state!)) return due("build");
  if (state === "revising") return due("revise");
  if (state === "stuck") return row!.decisionAnswered ? due("build") : { wait: person("implement-stuck", "a maintainer's answer on the stuck implementation") };
  // pr-opened: the open PR is the wait (openPr); a PR that merged or closed while the issue stayed open ends the attempt with
  // it (the revise work records that and ends the workspace). Its revisions, and the end of an attempt whose issue is closed
  // too, are planned on the PR (decidePr).
  // Ending the attempt is bookkeeping: it needs neither the Implement feature nor a person's command (gatePermission).
  return row!.prOpen ? null : { bucket: "revise" };
}

/**
 * The issue review step of an issue whose live workflow is a review, or the wait that holds it; null when nothing of it is due. A queued
 * review is due (`review`, a model call), after a backoff when its last call gave no valid review; a stored review's comment and a
 * question for the reporter are due to be posted (`post`, no model call), after the unsent writes' backoff when a post sent nothing; once
 * the question is posted, the review runs again after the issue's author commented, with the same backoff after a call that gave no
 * valid review.
 */
export function issueReviewStep(f: ItemFacts): { due: "review" | "post" } | { wait: Wait } | null {
  const r = f.issueReview;
  if (f.kind !== "issue" || !f.open || !f.inScope || f.held || !r || f.workflow?.entry !== "review") return null;
  if (r.state === "queued" || (r.state === "reporter" && r.reporterAnswered)) {
    const due = issueReviewDueAt(r);
    return f.now < due ? { wait: system("issue-review-retry", `the next issue review at ${new Date(due).toISOString().slice(11, 16)} UTC (call ${r.tries + 1})`) } : { due: "review" };
  }
  // A comment or question whose post sent nothing is posted again after the backoff of the unsent writes.
  if (r.state === "posting" || r.state === "ask") {
    const next = unsentAsk(r.postTries, f.now);
    return next !== null && next !== "final" ? { wait: system("ask-unsent", `the post of the issue review's ${r.state === "ask" ? "question" : "comment"}, tried again at ${new Date(next.until).toISOString().slice(11, 16)} UTC`) } : { due: "post" };
  }
  if (r.state === "reporter") return { wait: { code: "issue-reporter", who: "contributor", text: "the reporter's answer" } };
  return null;
}

/**
 * Jev and Haiku chose different labels, not both scope labels: a referee (Sonnet, then Opus when Sonnet was unsure) settles it.
 * An item they both gave a scope label stays unlabelled, with no further model call.
 */
const labelDisagreement = ({ classification: c }: ItemFacts): boolean => c.status === "disagree" && !(isScope(c.jevLabel) && isScope(c.haikuLabel));

/** An issue's wait on the open PR that closes it. */
export const openPrWait = (n: number): string => `open PR #${n}`;
/** The same wait of a queued issue: its implementation starts once someone merged, closed or took up that PR. */
export const answerPrWait = (n: number): string => `open PR #${n}, which closes it: answer that pull request`;

/** The wait of an open issue with nothing due and nothing to ask: it stays open as a request for anyone to pick up. */
export const TRIAGE_WAIT = "an open request for a person to pick up";

const PLUGIN_WAIT = "stays open as a plugin candidate";
/** A PR settled as a plugin candidate is not reviewed or merged: it stays open with its label. */
const pluginPr = (f: ItemFacts): boolean => f.kind === "pr" && f.classification.status === "settled" && f.classification.label === "plugin candidate";

export function itemState(f: ItemFacts): ItemState {
  if (f.held) return "held-backlog";
  const c = f.classification;
  if (labelDisagreement(f)) return "referee-due";
  if (c.status === "unclassified") return "unclassified";
  if (c.status === "waiting") return "waiting-haiku";
  return "classified";
}

const WAITS: Partial<Record<ItemState, Wait>> = {
  "held-backlog": system("ended", "a Backlog hold"), "referee-due": system("triage", "the label referee"),
  "waiting-haiku": system("triage", "Haiku's second opinion"),
};

/** The item has no priority row at its current text hash; the prioritize step asks it unless a classify request does. */
export const priorityDue = (f: ItemFacts): boolean => f.inScope && !f.integration && f.priorityHash !== f.embedHash;

export function decideItem(f: ItemFacts): ItemPlan {
  const state = itemState(f);
  const c = f.classification;
  const live = f.inScope && !f.integration;
  const actions: Action[] = [];

  // classify-new: Jev for items without a verdict or whose classifier input changed (unless Haiku classified the item alone at this input);
  // Haiku for items Jev is unsure of that have no Haiku verdict as new as Jev's.
  const jevDue = !c.haiku?.aloneCurrent && (!c.jev || c.jev.changed);
  const haikuDue = !!c.jev && c.jev.unsure && (!c.haiku || c.haiku.at < c.jev.at);
  if (f.run && live && (jevDue || haikuDue)) actions.push(act("classify", null, { source: jevDue ? "jev" : "haiku" }));
  // referee: open, not a draft, not held, in scope.
  // A failed Opus call is asked again after a backoff; after the third failure the label stands unsure.
  const backoff = !!c.referee?.failedAt && Date.parse(c.referee.failedAt) > f.now - REFEREE_RETRY_MS;
  // Not while Jev or Haiku is due again: the referee would judge the verdicts they are about to replace.
  if (f.run && live && !f.draft && state === "referee-due" && !backoff && !jevDue && !haikuDue) actions.push(act("referee", null, { source: c.referee ? "opus" : "sonnet" }));
  // prioritize: no priority row at the current text hash. Not while Jev's classify call is due: that request asks the impact
  // question too and settles the priority (src/runner/classify.ts), so the two steps never ask Jev the same item at once.
  // The hold ends once a classify request failed for the item's current input, so an item Jev cannot classify still gets a priority.
  if (priorityDue(f) && !(f.run && live && jevDue && !c.jevFailed)) actions.push(act("prioritize", null));
  // embed: every open item, with no scope test.
  if (f.embeddedHash !== f.embedHash) actions.push(act("embed", null));
  // dupes: items to scan, pairs to check.
  const scan = live && f.embeddedHash === f.embedHash && f.scannedHash !== f.embedHash;
  if (scan || f.pairsToCheck > 0) actions.push(act("dupes", null, { scan, pairs: f.pairsToCheck }));
  if (f.inCompareSet) actions.push(act("dupes-compare", null));
  // label: the repo's labelling approval is applied by gates().
  if (f.run && live && !f.held) {
    const settled = c.status === "settled" && c.label ? { type: c.label, security: c.flags.includes("security") && !f.labels.quietFix, needsDecision: c.flags.includes("needs decision") } : null;
    const add = labelsToAdd(settled, f.labels.existing);
    if (add && add.length && !alreadyLabeled(f.labels.labeledNote, add)) actions.push(act("label", null, { add }));
  }

  // act: a person's close, whatever the item's scope (sending the item to the backlog takes it back). The command is its approval in any repo.
  if (f.close && !f.held) actions.push(act("act", null, { bucket: "close", id: f.close.id, by: f.close.by }));
  // implement: a queued issue's next step (implementStep); the breaker is applied by gates().
  const step = implementStep(f);
  if (step && "bucket" in step) actions.push(act("implement", null, { bucket: step.bucket }));
  // issue-review: the review a maintainer asked for; issue-review-post: its comment, or its question to the reporter (issueReviewStep).
  const review = issueReviewStep(f);
  if (review && "due" in review) actions.push(act(review.due === "post" ? "issue-review-post" : "issue-review", null));

  // unassign (issues; a PR's is decided with its review-to-merge plan): kept while an implementation is due or runs, or its PR is open;
  // released when the issue waits on a person (a question, a stuck attempt, a switch), was given up or left the scope.
  if (f.kind === "issue") {
    const row = f.implement.row;
    const running = (!!step && "bucket" in step) || (row?.state === "pr-opened" && f.openPr !== null) || (!!review && "due" in review);
    actions.push(...unassignActions(f.assignment, f.open, !f.inScope || !!f.held || !running));
  }

  // A closed item is here for its close only.
  if (!f.open) actions.splice(0, actions.length, ...actions.filter((a) => a.kind === "act"));
  const due = permitted(f, actions);
  const idle = !due.some((a) => isWork(a) && (a.permission?.ok || !TELLS.has(a.kind)));
  let wait: Wait | null = !idle ? null : !f.inScope ? system("scope", "not in scope") : state === "classified" && pluginPr(f) ? system("open-request", PLUGIN_WAIT) : WAITS[state] ?? null;
  // A queued issue waits on what holds its implementation.
  if (step && "wait" in step && f.open && idle) wait = step.wait;
  if (review && "wait" in review && f.open && idle) wait = review.wait;
  // An issue with nothing else due waits on the PR that closes it.
  if (wait === null && f.kind === "issue" && f.open && f.inScope && !f.held && idle) {
    if (f.openPr?.closes) wait = system("open-pr", openPrWait(f.openPr.number));
    else if (state === "classified") wait = system("open-request", TRIAGE_WAIT);
  }
  return { repo: f.repo, number: f.number, kind: f.kind, state, actions: due, ...waitFields(wait ?? refusedWait(due)) };
}

/** The Work page's next-step text (rank/next.ts nextStepOf), from the item's state and, for a PR, the facts of its review-to-merge path. */
export function nextStep(item: ItemPlan, f: ItemFacts, pr: PrFacts | null): string {
  switch (item.state) {
    case "held-backlog": return "Held";
    case "referee-due": return `Referee: waiting for ${f.classification.referee ? "Opus" : "Sonnet"}`;
    case "unclassified": case "waiting-haiku": return "Classify";
    default:
  }
  if (item.state === "classified" && pluginPr(f)) return "Stays open as a plugin candidate";
  if (f.kind === "issue") {
    if (f.workflow?.entry === "review") return f.issueReview?.state === "reporter" ? "Review: waiting for the reporter" : "Review";
    const im = f.implement, s = im.row?.state;
    if (im.queuedBy !== null && im.standing !== "no") {
      switch (s) {
        case "planning": return "Implement: planning";
        case "asked": return "Implement: waiting for an answer";
        case "planned": case "implementing": case "checking": case "fixing": case "opening": case "revising": return "Implement: in progress";
        case "pr-opened": return "Implement: pull request opened";
        case "stuck": return "Needs a person";
        default: return "Implement";
      }
    }
    return "Triage by a person";
  }
  if (pr && pr.ghState === "OPEN" && pr.inScope && notStarted(pr)) return "Waiting for a maintainer to start it";
  const o = pr && !pr.inScope ? pr.outside ?? null : null;
  const r = o ? o.review : pr?.review && pr.review.head === pr.head && !pr.review.stale ? pr.review.verdict : null;
  switch (r) {
    case null: return "Review";
    case "take-fix": return "Fix-up";
    case "hold": return "Needs a person";
    case "close": return "Close";
    default: {
      const v = o ? o.verify : pr?.verification?.state ?? null;
      if (v === "unavailable") return "Needs a person: not verified (Verify cannot build this repo)";
      if ((o ? o.ci : pr?.ci) === "none" && pr?.repoFacts.noCi) return "Needs a person: the repo has no CI";
      if (v === "passed" || v === "ci-enough") return "Merge queue";
      if (v === "failed" || v === "error") return "Needs a person: verification failed";
      return v ? "Verify: running" : "Verify";
    }
  }
}

/** Every plan of an item together. A PR's triage actions (classify, label, ...) and its review-to-merge actions can both be due: triage actions come first. */
export function decideAll(item: ItemFacts, pr: PrFacts | null = null, pass?: PassFacts): ItemView {
  const plan = decideItem(item);
  const prPlan = pr ? decidePr(pr, pass) : null;
  return {
    repo: item.repo, number: item.number, kind: item.kind, head: pr?.head ?? null, item: plan, pr: prPlan,
    actions: [...plan.actions, ...(prPlan?.actions ?? [])], next: nextStep(plan, item, pr),
  };
}
