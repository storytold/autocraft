// The question a started item comes back with when nothing of it is due and a person has to move it on: its plan waits for one, or the
// people it acts for can no longer act. Pure.
import { needsQuestion, type StopCode, type WaitCode } from "../core/codes.ts";
import { redAtHead, refusalStuck, unapprovedStop, unknownStuck, worksOn } from "../core/decide.ts";
import { implementStep } from "../core/decide-item.ts";
import type { Action, ItemFacts, Plan, PrFacts, StandingFact } from "../core/plan.ts";
import { t } from "../i18n/index.ts";
import { fixPath, nobodyFixes, nobodyFixesFor } from "../preapproval/paths.ts";
import { FIXUP_MAX_ATTEMPTS } from "../core/rules.ts";
import { afterSteps, droppedOf, onConflict, planned, some, textFor, unmade, type Conflict, type ReviewView, type Unmade } from "./recommend.ts";
import { earlierReview, listText } from "./status.ts";
import { asSentence, clipText } from "../prose.ts";
import type { Blocker, PlanPart, Recommendation } from "./types.ts";

/** `blocker` and `params` are what an approved item stops at (`params.code`: the wait); one not approved comes back with `rec` alone. */
export type Question = { blocker: Blocker; params: Record<string, unknown>; rec: Recommendation; /** When what it is about happened, where that may be after the pass began. */ showed?: string };

export type Asked = { approved: boolean; review: ReviewView | null; parts: readonly PlanPart[]; conflict: Conflict | null };

/** An action that moves the item on by itself, or once something other than a person does. One refused for the question that is being looked at again counts. */
const moves = (a: Action): boolean => !a.permission || a.permission.ok || a.permission.why.who !== "person" || a.permission.why.code === "blocked";

/** Whether the plan stops for a maintainer's answer: its steps are done, or a review verdict needs a person. */
const waitsForAnswer = (p: Plan): boolean => p.waitCode === "answer" || p.waitCode === "ci-nothing-to-fix" || p.state === "opus-hold" || p.state === "opus-close";

/** The people the item acts for can no longer write to its repo: whoever says yes takes their place, and an approved merge is approved anew as them. */
function goneQuestion(repo: string, login: string, o: Pick<Asked, "approved" | "parts">, lane = false): Question {
  const text = o.approved
    ? t("{login} has no write access to {repo} any more, so their approval does not count: approve the merge in their place.", { login, repo })
    : t("{login} has no write access to {repo} any more, so the work has nobody to act for: go on with it in their place.", { login, repo });
  return { blocker: "other", params: { code: "actor-gone", reason: `${login} has no write access to ${repo}`, login }, rec: { text, parts: { fix: [], drop: droppedOf(o.parts) }, merges: o.approved, goes: "on", cause: { code: "actor-gone", ...(lane ? { lane: true as const } : {}) } } };
}

/** Characters of the CI fix's last reason a question names. */
const LAST_TRY_CHARS = 200;

/** `head` followed by which required checks fail and what the CI fix tried at the commit, when the facts say. */
function ciFixTried(f: PrFacts | undefined, head: string): string {
  const c = f?.cifix;
  if (!c) return head;
  const out = [head];
  if (c.failing.length) out.push(t("Failing: {checks}.", { checks: listText(c.failing.slice(0, 3).map((x) => `\`${x}\``)) }));
  if (c.lastTry) out.push(t("Its last try: {reason}", { reason: asSentence(clipText(c.lastTry, LAST_TRY_CHARS)) }));
  return out.join(" ");
}

const isGone = (s: StandingFact | null | undefined): s is StandingFact => s?.standing === "no" && !s.boxIdentity;

/** What an approved item waits on that a review of its head may settle, as the question says it. */
const REVIEW_AGAIN: Partial<Record<WaitCode, (f?: PrFacts) => string>> = {
  answer: () => t("The review asks for fixes and lists none AutoCraft can make."),
  "review-failed": () => t("Its review failed too often at this commit."),
  "ask-failed": () => t("AutoCraft could not post its comment to the contributor."),
  "ci-fix-failed": (f) => ciFixTried(f, t("CI fails, and the CI fix could not repair it.")),
  "ci-own-breakage": (f) => ciFixTried(f, f?.brokeByDrift ? t("CI fails since the base branch moved, and the CI fix could not repair it.") : t("CI fails since a push of AutoCraft's, and the CI fix could not repair it.")),
  "ci-nothing-to-fix": () => t("CI fails, and the CI fix has nothing to fix there."),
  "revision-failed": () => t("The implementation session ended, and its pull request is not ready to merge."),
};

type GithubCode = "base-off-default" | "no-ci" | "mergeable-stuck" | "ci-approval-failed";
/** What only a person can change on GitHub. */
const ON_GITHUB: Record<GithubCode, () => string> = {
  "base-off-default": () => t("Its base is not the default branch, and AutoCraft merges only into that: change its base on GitHub."),
  "no-ci": () => t("The repo has no CI, and AutoCraft merges only on green CI: add a CI workflow, or merge it on GitHub."),
  "mergeable-stuck": () => t("GitHub still reports the merge state as unknown: close and reopen the pull request on GitHub, which makes GitHub compute it."),
  "ci-approval-failed": () => t("AutoCraft could not approve its CI runs: approve them on GitHub."),
};

const onGithub = (code: WaitCode): code is GithubCode => Object.hasOwn(ON_GITHUB, code);

/** What the pull request may be merged past, once a person says so. */
const MERGE_PAST: Partial<Record<WaitCode, (f: PrFacts) => string>> = {
  "batch-failed": () => t("It failed alone in a merge batch: merge it again in a new one."),
  "verification-failed": () => t("Its verification failed: merge it anyway."),
  "verification-error": () => t("Its verification kept erroring, also when AutoCraft ran it again over a day: merge it without it."),
  "merge-refused": (f) => (f.lastMerge?.reason ? t("The merge was refused ({reason}): try it again.", { reason: f.lastMerge.reason }) : t("The merge was refused: try it again.")),
  screenshots: (f) => regression(f, t("merge it anyway.")),
};

const regression = (f: PrFacts, rest: string): string =>
  (f.screenshots?.summary ? t("Its screenshots show a regression ({summary}): {rest}", { summary: f.screenshots.summary, rest }) : t("Its screenshots show a regression: {rest}", { rest }));

/** The sentence of a wait that has none of its own. */
const waitText = (wait: string): string => t("It waits for {what}.", { what: wait.replace(/\.$/, "") });

/** Hold states of the fix-up at a head: a migration or a lifted limit supersedes the row, and the fix-up can run again. */
const FIX_HOLDS = ["too-large", "cannot-push", "push-denied"] as const;

/** Why the fix-up made none of the review's fixes at the head, from what it recorded there. */
function unmadeWhy(f: PrFacts): Unmade {
  const x = f.fixup, held = x?.held ?? "";
  if (x?.fixes === 0 || /may not edit/.test(held)) return { why: t("the fix changes files that AutoCraft's rules do not let it edit"), author: true };
  if (x?.recorded.includes("push-denied")) return { why: t("GitHub refused AutoCraft's push to the pull request's branch"), author: true };
  if (!f.pushable || x?.recorded.includes("cannot-push")) return { why: t("AutoCraft cannot push to the pull request's branch"), author: true };
  if (/diff is over/.test(held)) return { why: t("the pull request's diff is over AutoCraft's size limit for a fix-up"), author: false };
  if (x?.recorded.includes("too-large")) return { why: t("the files the fix names are over AutoCraft's size limit for a fix-up"), author: false };
  if ((x?.attempts ?? 0) >= FIXUP_MAX_ATTEMPTS) return { why: t("the fix-up failed {n} times", { n: x!.attempts }), author: false };
  return { why: t("the fix-up could not run"), author: false };
}

/**
 * A PR whose review asks for fixes nobody makes comes back with what could not be made and why; null for any other. On a PR approved for
 * merge only the fixes that block it count: the others are filed as follow-ups and stop nothing. A fix that blocks the merge is never dropped.
 */
export function withoutFixes(f: PrFacts, o: Asked, forPerson = false): Recommendation | null {
  const minor = (n: number) => { const p = o.parts.find((x) => x.n === n); return !!p?.minor && !p.major; };
  const own = o.approved && !forPerson;
  const parts = planned(o.parts).filter((n) => !(own && minor(n)));
  if (o.review?.verdict !== "take-fix" || !parts.length || !(own ? nobodyFixes(f) : nobodyFixesFor(f))) return null;
  const hold = FIX_HOLDS.find((s) => f.fixup?.recorded.includes(s));
  const why = { ...unmadeWhy(f), ...(f.quiet || f.authorIsPipeline ? { byHand: true } : {}) };
  return unmade(o.parts, { blocking: parts.filter((n) => !minor(n)), minor: parts.filter(minor) }, why, o.approved, hold ? { code: "fix-unmade", state: hold } : undefined);
}

/** A recommendation to make the review's fixes, unless nobody can make them, not even for the person who says yes. */
export const fixable = (rec: Recommendation, f: PrFacts, o: Asked): Recommendation =>
  (rec.parts.fix.length && nobodyFixesFor(f) ? withoutFixes(f, o, true) ?? rec : rec);

/**
 * Waits of an approved PR that the facts alone say, whatever its merge leg does. Asking stops the leg (block.ts), so the plan read afterwards
 * no longer shows a wait that the leg's hand-over, hold or pre-merge review made: a question of one of those stands until it is answered.
 */
const LEG_FREE_WAITS: ReadonlySet<string> = new Set<WaitCode>(["conflict-person", "mergeable-unknown"]);

/** Whether a question kept with only the wait `wait` that asked it may close once the plan no longer stops there (causeWent). */
export const waitCloses = (wait: string, approved: boolean): boolean => !approved || LEG_FREE_WAITS.has(wait);

/** The question of the plan's wait `code`. Its cause is its own where one says more, else the wait itself where that may close (waitCloses). */
function recFor(code: WaitCode, f: PrFacts, wait: string | null, o: Asked): Recommendation {
  const rec = waitRec(code, f, wait, o);
  return rec.cause || !waitCloses(code, o.approved) ? rec : { ...rec, cause: { code: "wait", wait: code } };
}

function waitRec(code: WaitCode, f: PrFacts, wait: string | null, o: Asked): Recommendation {
  const parts = { fix: [] as number[], drop: droppedOf(o.parts) }, merges = o.approved;
  if (onGithub(code)) return { text: ON_GITHUB[code](), parts, merges, goes: "look", cause: { code } };
  const past = MERGE_PAST[code];
  if (past) return { text: past(f), parts, merges: true, ...(code === "merge-refused" ? { cause: { code } } : {}) };
  const skip = code === "answer" || code === "ask-failed" ? withoutFixes(f, o) : null;
  if (skip) return skip;
  if (code === "review-failed") return reviewFailed(o);
  if (code === "conflict-person") return conflictByHand(parts, merges);
  const why = (REVIEW_AGAIN[code] ?? (() => waitText(wait ?? "")))(f);
  // The session does not make the review's fixes: a fix-up of ours does.
  const fix = code === "revision-failed" && o.review?.verdict === "take-fix" ? planned(o.parts) : [];
  const again = fix.length ? {} : { again: "review" as const };
  return { text: `${why} ${textFor(some(fix) ? { fix, merges } : { again: "review", merges })}`, parts: { ...parts, fix }, merges, ...again, ...(RED_CI.has(code) ? { cause: { code: "red-ci" as const } } : {}) };
}

/** Waits on red CI that nothing repairs: no answer merges it. */
const RED_CI: ReadonlySet<WaitCode> = new Set(["ci-fix-failed", "ci-own-breakage", "ci-nothing-to-fix"]);

/**
 * The recommendation where the review failed for good at the head: a yes tries it once more, the word merge goes on without it. `o.review`: an
 * earlier review of that head, whose open parts and whose hold or close the word merge does not pass over.
 */
function reviewFailed(o: Pick<Asked, "approved" | "parts" | "review">): Recommendation {
  const again = "review" as const, merges = o.approved;
  const parts = o.review ? planned(o.parts) : [], v = o.review?.verdict, verdict = v === "hold" || v === "close" ? v : undefined;
  return {
    text: `${REVIEW_AGAIN["review-failed"]!()} ${textFor({ again, merges })} ${parts.length || verdict ? earlierReview(parts, verdict) : t("Write merge to merge it without that review when CI is green.")}`,
    parts: { fix: [], drop: droppedOf(o.parts) }, merges, again, skipsReview: { parts, ...(verdict ? { verdict } : {}) },
  };
}

/** A conflict with the base branch that AutoCraft's merge of it could not resolve, on a PR approved for merge: someone resolves it on its branch, and a yes looks again. */
const conflictByHand = (parts: Recommendation["parts"], merges: boolean): Recommendation => ({
  text: t("It conflicts with its base branch, and AutoCraft could not resolve the conflict. Resolve it on the pull request's branch, or ask the contributor to; the merge stays approved, and AutoCraft reviews the new commits before it merges. Reply once it is resolved."),
  parts, merges, goes: "look", cause: { code: "conflict" },
});

/**
 * The recommendation where the pre-merge review failed for good at the head: a yes gives it one more try, and the merge goes on once it is clean
 * and CI is green; the word merge goes on without it.
 */
function premergeFailed(f: PrFacts, o: Pick<Asked, "approved" | "parts">): Recommendation {
  const tries = f.premerge?.tries ?? 0;
  const failed = tries > 1 ? t("The pre-merge review of this commit failed {n} times.", { n: tries }) : t("The pre-merge review of this commit failed.");
  return {
    text: `${failed} ${t("Going ahead gives it one more try, and the merge goes on once it is clean and CI is green. Write merge to merge it without that review once CI is green.")}`,
    parts: { fix: [], drop: droppedOf(o.parts) }, merges: o.approved, retriesPremerge: true,
  };
}

/** The recommendation of a stopped merge leg that says what its wait would: going on with it as it is would stop it there again. */
export function legStop(code: StopCode, f: PrFacts, o: Asked): Recommendation | null {
  switch (code) {
    case "fix-cannot-run": case "fix-failed": case "fix-too-large": return withoutFixes(f, o);
    case "review-failed": return reviewFailed(o);
    case "premerge-failed": return premergeFailed(f, o);
    case "ci-failed": return recFor(f.brokeByUs ? "ci-own-breakage" : "ci-fix-failed", f, null, o);
    default: return null;
  }
}

/** An end recommendation of a PR that no approval merges as it is: the base and the missing CI (which a conflict may have kept from running) come first, and its screenshots are named. */
function asItStands(rec: Recommendation, f: PrFacts): Recommendation {
  const code = f.baseOffDefault ? "base-off-default" : f.ci === "none" && f.repoFacts.noCi && f.mergeable !== "CONFLICTING" ? "no-ci" : null;
  if (code === null) return f.screenshots && rec.merges ? { ...rec, text: regression(f, rec.text) } : rec;
  if (!rec.merges) return rec;
  const text = ON_GITHUB[code](), { parts } = rec;
  const fix = parts.fix;
  return some(fix)
    ? { text: `${text} ${textFor({ fix, merges: false })}`, parts, merges: false }
    : { text, parts, merges: false, ...(rec.again ? { again: rec.again } : { goes: "look" as const, cause: { code } }) };
}

/** The question of the PR whose facts are `f` and whose plan is `p`; null when nothing is to be asked. `parts`: the workflow's plan; `conflict`: the conflict with the base branch. */
export function questionFor(f: PrFacts, p: Plan, o: Asked): Question | null {
  const approver = o.approved ? f.standing?.merge : null;
  if (approver && (isGone(approver) || f.mergeLacksAccess)) return goneQuestion(f.repo, approver.login, o, !isGone(approver));
  const busy = p.actions.some((a) => worksOn(a) && moves(a));
  // Whoever answers takes the place of a person who is gone.
  if (!o.approved && !busy && waitsForAnswer(p)) return { blocker: "other", params: {}, rec: asItStands(fixable(afterSteps(o.review, o.parts, unapprovedStop(f), o.conflict), f, o), f) };
  if (!o.approved && isGone(f.standing?.work)) return goneQuestion(f.repo, f.standing!.work!.login, o);
  const code = p.waitCode;
  if (busy || !code || !p.waitKind || !needsQuestion(code, p.waitKind, o.approved)) return null;
  // The implementation's own question, and a review that says hold or close: what the person has not answered comes back by itself (question.ts, blockers.ts).
  if (code === "implement-question" || code === "implement-stuck" || p.state === "opus-hold" && code === "answer") return null;
  const rec = recFor(code, f, p.wait, o);
  // Blocking fixes of an approved PR that nobody can make: a fix that could not be made.
  const notMade = o.approved && (code === "answer" || code === "ask-failed");
  return {
    blocker: notMade ? "failed-twice" : "other",
    params: { code, reason: (p.wait ?? code).replace(/^a person: /, ""), ...(notMade ? { step: "fix-up" } : {}) }, rec: rec.goes ? rec : onConflict(rec, o.conflict),
  };
}

/**
 * The question of an issue whose implementation has no pull request yet (what holds its next step); null when nothing is to be asked. The
 * implementation's own questions come back by themselves (question.ts).
 */
export function itemQuestion(f: ItemFacts, o: Pick<Asked, "approved" | "parts">): Question | null {
  const gone = o.approved && isGone(f.standing?.merge) ? f.standing!.merge! : isGone(f.standing?.work) ? f.standing!.work! : null;
  if (gone) return goneQuestion(f.repo, gone.login, o);
  const step = implementStep(f);
  if (!step || !("wait" in step)) return null;
  const { code, who, text: wait } = step.wait;
  if (!needsQuestion(code, who) || code === "implement-question" || code === "implement-stuck") return null;
  const ended = code === "implement-ended", showed = ended ? f.implement.row?.endedAt : undefined;
  return {
    blocker: "other", params: { code, reason: wait }, ...(showed !== undefined ? { showed } : {}),
    rec: {
      text: ended ? t("The implementation ended without a merged pull request: implement it again.") : waitText(wait),
      parts: { fix: [], drop: droppedOf(o.parts) }, merges: o.approved, goes: ended ? "on" : "look",
    },
  };
}

/** What the pass reads beside an item's facts to tell whether the cause of its question went. Each reader is undefined while the pass cannot say. */
export type CauseNow = {
  /** When the pass began (ISO). */
  at: string;
  /** The state of the newest try of a fix-up request; null when it has none. */
  fixState?: (fix: number) => string | null;
  /** The wait the item's plan stops at with its question closed; null for none. */
  waitNow?: () => string | null | undefined;
  /** Whether any of the items (`repo#number`) still blocks the review. */
  blocks?: (items: readonly string[]) => boolean | undefined;
  /** Whether a job of the lane step `lane` ran through at `head` after the question was asked. */
  laneDone?: (lane: string, head: string) => boolean | undefined;
  /** Whether the review stored at the head is a hold made without a model call (too large to review). */
  unread?: () => boolean | undefined;
};

/** Why a question whose cause clears without an answer closes: what the facts at its head say now. Null while the cause stands, or while they do not say. */
export function causeWent(cause: Recommendation["cause"], f: PrFacts | ItemFacts, approved: boolean, now: CauseNow): string | null {
  if (!cause) return null;
  if (cause.code === "daily-cap") return now.at >= cause.until ? t("A new day began, so the author's new commits get their review round.") : null;
  if (cause.code === "actor-gone") {
    const s = approved ? f.standing?.merge : f.standing?.work;
    if (s?.standing !== "yes" || (cause.lane && "mergeLacksAccess" in f && f.mergeLacksAccess)) return null;
    return t("{login} can act on {repo} again.", { login: s.login, repo: f.repo });
  }
  if (!("ci" in f)) return null;
  switch (cause.code) {
    case "base-off-default": return f.inScope && !f.baseOffDefault ? t("Its base is the default branch now.") : null;
    case "no-ci": return !f.repoFacts.noCi || f.ci === "pending" || f.ci === "success" || f.ci === "failure" ? t("CI runs now.") : null;
    case "mergeable-stuck": return unknownStuck(f) === null && (f.mergeable === "MERGEABLE" || f.mergeable === "CONFLICTING") ? t("GitHub says whether it can be merged now.") : null;
    case "red-ci": return f.ci === "success" && !redAtHead(f) ? t("CI is green now.") : null;
    case "ci-approval-failed": return f.ci !== "unknown" && f.runs?.blocked !== "failed" && f.runs?.blocked !== "unsupported" ? t("Its CI runs wait for no approval any more.") : null;
    case "fix-unmade": {
      // The hold row at the head is gone (superseded); an approved PR's own fix-up runs again only while its tries last (fixupOf).
      const r = f.review;
      if (!r || r.verdict !== "take-fix" || r.head !== f.head || r.stale || !f.fixup || f.fixup.recorded.includes(cause.state)) return null;
      if (approved && fixPath(f) !== "fix") return null;
      return fixAgainText(approved);
    }
    case "leg": {
      // The try that ended the merge leg was superseded (a migration, a lifted limit): a new leg makes the fix again.
      if (cause.state === "superseded" || now.fixState?.(cause.fix) !== "superseded") return null;
      return fixAgainText(approved);
    }
    case "wait": {
      if (!waitCloses(cause.wait, approved)) return null;
      const wait = now.waitNow?.();
      return wait === undefined || wait === cause.wait ? null : t("Its plan no longer waits for that.");
    }
    case "merge-refused": return !refusalStuck(f) ? t("What refused the merge changed since, so it can be tried again.") : null;
    case "conflict": return f.mergeable === "MERGEABLE" ? t("It no longer conflicts with its base branch.") : null;
    case "blocked-by": return now.blocks?.(cause.items) === false ? t("The items its review waited for no longer block it.") : null;
    case "too-large": return now.unread?.() === false ? t("Its hold for size is gone, so the pull request is reviewed again.") : null;
    case "lane-failed":
      if ("head" in f && f.head !== null && f.head !== cause.head) return t("It has a new commit, so the step runs there.");
      return now.laneDone?.(cause.lane, cause.head) === true ? t("The step ran through at this commit since.") : null;
  }
}

const fixAgainText = (approved: boolean): string =>
  (approved ? t("What stopped the fix-up no longer applies, so AutoCraft makes the fix again.") : t("What stopped the fix-up no longer applies."));
