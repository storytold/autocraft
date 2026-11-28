// The one recommendation an item comes back with, and the numbered plan it refers to. Pure: advance.ts gives it the latest
// review and the blocker, and records the result on the workflow row.
//
// The review writes the sentence and says what a yes runs (src/review/opus-parse.ts ReviewRecommendation), so the text and the run
// always agree. A blocker the review cannot speak for (author commits, a failing step, files beyond the plan, a merge
// leg that stopped) gets a sentence built here from its facts.
import { t } from "../i18n/index.ts";
import { byHand, conflictPath, mergeOwned, settlesConflict, type ConflictPath } from "../core/decide.ts";
import type { PrFacts } from "../core/plan.ts";
import { PREMERGE_DEFECT_REASON, PREMERGE_FAILED_REASON, PREMERGE_UNSURE_REASON, UNSURE_REASON } from "../core/rules.ts";
import { notBlocking, type Blocking } from "../premerge/types.ts";
import { asSentence, clipText } from "../prose.ts";
import type { ReviewRecommendation } from "../data/review/types.ts";
import type { ReviewFix } from "../review/opus-parse.ts";
import type { Found } from "./blockers.ts";
import { listText } from "./status.ts";
import type { PlanPart, Recommendation } from "./types.ts";
import { droppedTitles, partTitle } from "./work.ts";

/**
 * The plan of a review's fixes, numbered from 1 in the review's order. A part a person dropped from the plan before (same title)
 * stays dropped; a part with no fix (the review asks for nothing) is no part. A pre-merge review's finding a person dropped (overruled)
 * stays in the plan after the review's parts, so it stops no merge of the workflow's.
 */
export function planOf(fixes: readonly ReviewFix[], before: readonly PlanPart[]): PlanPart[] {
  const dropped = new Set(droppedTitles(before));
  const parts: PlanPart[] = fixes.map((f, i) => {
    const title = partTitle(f);
    const was = before.find((p) => p.state === "dropped" && p.title.toLowerCase() === title.toLowerCase());
    return { n: i + 1, title, source: "review" as const, file: f.file, ...(f.major ? { major: true } : {}), ...(notBlocking(f) ? { minor: true as const } : {}), ...(was?.droppedBy ? { droppedBy: was.droppedBy } : {}), state: dropped.has(title.toLowerCase()) ? "dropped" as const : "planned" as const };
  });
  const titles = new Set(parts.map((p) => p.title.toLowerCase()));
  const overruled = before.filter((p) => p.premerge && p.state === "dropped" && !titles.has(p.title.toLowerCase()));
  return [...parts, ...overruled.map((p, i) => ({ ...p, n: parts.length + i + 1 }))];
}

/**
 * `finding`: what the review found, in the words it wrote for the PR (its public summary, which is posted anyway); null when it wrote none.
 * `blockedBy`: the open items a hold names as its reason (`repo#number`).
 */
export type ReviewView = { verdict: string; sure: boolean; rec: ReviewRecommendation | null; finding?: string | null; blockedBy?: readonly string[]; /** A hold's blocking class; null: it blocks nothing an approval merges. */ hold?: Blocking | null };

/** Characters of a review's finding a recommendation quotes. */
const FINDING_CHARS = 300;

export const planned = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "planned").map((p) => p.n);
export const droppedOf = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "dropped").map((p) => p.n);

/** "Fix 1 and 2, then merge." / "Fix 1, then come back." */
const fixText = (fix: readonly number[], merges: boolean): string => (merges
  ? t("Fix {parts}, then merge.", { parts: listText(fix) })
  : t("Fix {parts}, then come back with the result.", { parts: listText(fix) }));

/** A list with at least one entry. */
export type Some<T> = readonly [T, ...T[]];
export const some = <T>(a: readonly T[]): a is Some<T> => a.length > 0;

/** What a yes runs, for its sentence: each shape runs something, so there is no sentence for a yes that runs nothing. */
export type TextOf = { close: true } | { backlog: true } | { author: true } | { again: "review"; merges: boolean } | { fix: Some<number>; merges: boolean } | { fix: readonly number[]; merges: true };

/** The sentence for what a yes runs, when the review's own sentence does not say it. */
export function textFor(r: TextOf): string {
  if ("close" in r) return t("Close it, as the review recommends.");
  if ("backlog" in r) return t("Put it in the backlog.");
  if ("author" in r) return t("Ask the author to address the review's findings.");
  if ("again" in r) return r.merges ? t("Review it again, then merge.") : t("Review it again, then come back with the result.");
  return r.fix.length ? fixText(r.fix, r.merges) : t("Merge it.");
}

/** Characters of a part's title a sentence names. */
const TITLE_CHARS = 100;

/** "fix 1 (the alt text box regression) and fix 2 (...)": the parts with their titles. */
const namedFixes = (plan: readonly PlanPart[], parts: readonly number[]): string =>
  listText(parts.map((n) => { const title = plan.find((p) => p.n === n)?.title; return title ? t("fix {n} ({title})", { n, title: clipText(title, TITLE_CHARS) }) : t("fix {n}", { n }); }));

/**
 * Why AutoCraft's fix-up made none of the review's fixes at the head, as a clause ("the pull request's diff is over AutoCraft's size limit for
 * a fix-up"). `author`: only the author can make them (they change files AutoCraft may not edit, or AutoCraft cannot push to the branch).
 */
export type Unmade = { why: string; author: boolean; /** Nobody can be asked on the PR (AutoCraft's own, or quiet): a person makes the fix on its branch. */ byHand?: boolean };

/**
 * The recommendation where AutoCraft's fix-up could not make planned fixes of the review. A fix that stops the merge (`blocking`: major, or a
 * regression, a break of the build or tests, security, data loss, the PR not doing what it says) is never dropped to merge: on a PR approved for
 * merge a yes makes it again, unless only the author can make it; otherwise the author is asked, or, where nobody can be asked on the PR, a
 * person makes it on its branch. Fixes that stop nothing (`minor`) go to a follow-up issue once the merge is approved, and the merge goes on.
 * `cause`: the hold that stopped the fix-up, which may lift by itself.
 */
export function unmade(plan: readonly PlanPart[], fixes: { blocking: readonly number[]; minor: readonly number[] }, u: Unmade, approved: boolean, cause?: Recommendation["cause"]): Recommendation {
  const { blocking, minor } = fixes, drop = droppedOf(plan), on = cause ? { cause } : {};
  const said = t("AutoCraft could not make {fixes}: {why}.", { fixes: namedFixes(plan, blocking.length ? blocking : minor), why: u.why });
  if (!blocking.length) {
    const then = minor.length > 1 ? t("They do not block the merge, so they go to a follow-up issue. Merge it.") : t("It does not block the merge, so it goes to a follow-up issue. Merge it.");
    return { text: `${said} ${then}`, parts: { fix: [], drop }, merges: true, ...on };
  }
  if (u.byHand && (u.author || !approved)) {
    const made = blocking.length > 1 ? t("Make them on the pull request's branch and reply once they are there.") : t("Make it on the pull request's branch and reply once it is there.");
    const then = approved ? `${made} ${t("The merge stays approved, and AutoCraft reviews the new commits before it merges.")}` : made;
    return { text: `${said} ${then}`, parts: { fix: [], drop }, merges: approved, goes: "look", ...on };
  }
  if (u.author || !approved) return { text: `${said} ${textFor({ author: true })}`, parts: { fix: [], drop }, merges: approved, author: "ask", ...on };
  const then = blocking.length > 1 ? t("Make them again, then merge.") : t("Make it again, then merge.");
  return { text: `${said} ${then}`, parts: { fix: [...blocking], drop }, merges: true, ...on };
}

const STOPS = {
  conflict: (text: string) => t("It conflicts with its base branch. {text}", { text }),
  ci: (text: string) => t("CI fails at its latest commit. {text}", { text }),
};

/**
 * A conflict with the base branch, and who settles it once the merge is approved (src/core/decide.ts conflictPath). `held`: a review of the
 * head holds the PR (so `path` is null), with who could settle the conflict were it wanted.
 */
export type Conflict = { path: ConflictPath | null; held?: ConflictPath };

/** The conflict of a PR that conflicts with its base branch at its head; null when it does not. */
export function conflictOf(f: PrFacts): Conflict | null {
  if (f.mergeable !== "CONFLICTING") return null;
  const r = f.review, settles = settlesConflict(f);
  const held = !!r && r.verdict === "hold" && r.head === f.head && !r.stale;
  return { path: conflictPath(f), ...(held ? { held: settles === "contributor" && mergeOwned(f) ? "person" as const : settles } : {}) };
}

const ON_CONFLICT: Record<Exclude<ConflictPath, "merge">, (text: string) => string> = {
  contributor: (text) => t("It conflicts with its base branch, which the contributor has to resolve first. {text}", { text }),
  person: (text) => t("It conflicts with its base branch, which AutoCraft cannot resolve: someone has to do that on its branch first. {text}", { text }),
};

/** A held PR whose fixes a yes makes, with the base branch AutoCraft merges in first: its sentence says so (onConflict). */
const mergedFirst = (rec: Recommendation, c: Conflict | null): boolean =>
  !!c && c.path === null && c.held === "merge" && !(rec.close || rec.backlog || rec.author || rec.answer) && (rec.parts.fix.length > 0 || rec.again === "fixup");

/**
 * The recommendation on a PR that conflicts with its base branch, where no fix-up can be made before that merge. Where the pipeline merges the
 * base in, a yes approves the merge and the fixes follow that merge. Where a person has to resolve the conflict, a yes approves the
 * merge and waits for them: it runs nothing that could ask the same again. A PR with no review to go on from is reviewed again. One whose
 * review of the head holds it gets no merge of the base (decide.ts plans the conflict step only for a wanted PR), so its fixes cannot be
 * made: it goes to the backlog, and a new review of the same head would only hold it again.
 */
export function onConflict(rec: Recommendation, conflict: Conflict | null): Recommendation {
  if (!conflict || rec.close || rec.backlog || rec.author || rec.answer) return rec;
  const { path } = conflict, fixes = rec.parts.fix.length > 0 || rec.again === "fixup";
  if (path === null && fixes && conflict.held) {
    // A person's fix of a held PR also lets AutoCraft merge the base branch in first (decide.ts); one that only its contributor or a person can settle goes to the author.
    if (conflict.held === "merge") return { ...rec, text: t("It conflicts with its base branch, which AutoCraft merges in first. {text}", { text: rec.text }) };
    return { text: ON_CONFLICT[conflict.held](t("Ask the author to resolve it and address the review's findings.")), parts: { fix: [], drop: rec.parts.drop }, merges: false, author: "scope" };
  }
  if (path === null) return fixes ? { text: textFor({ again: "review", merges: rec.merges }), parts: { fix: [], drop: rec.parts.drop }, merges: rec.merges, again: "review" } : rec;
  if (!fixes && !rec.merges) return rec;
  if (byHand(path)) {
    if (!fixes) return { ...rec, text: ON_CONFLICT[path](rec.text), waits: path };
    return { text: ON_CONFLICT[path](t("Wait for that with the merge approved.")), parts: { fix: [], drop: rec.parts.drop }, merges: true, waits: path };
  }
  const out = rec.merges ? rec : { ...rec, merges: true, text: textFor({ fix: rec.parts.fix, merges: true }) };
  return out;
}

/**
 * What the item comes back with when its steps are done and the merge is not approved: the review's recommendation when it gave
 * one (without the parts a person dropped; its sentence written again when the parts changed), else one built from its verdict: fix
 * the planned parts then merge, merge, close, or, for a hold that plans no fix, the backlog. The review covers the head, so the item
 * never comes back with a review of that head again. A yes always runs something. `stop`: what the PR ran into besides the
 * review (unapprovedStop), which the sentence names.
 */
export function afterSteps(review: ReviewView | null, plan: readonly PlanPart[], stop: keyof typeof STOPS | null = null, conflict: Conflict | null = null): Recommendation {
  const base = withFinding(recommended(review, plan), review?.finding ?? null), rec = onConflict(base, conflict);
  // Where the sentence is already about the conflict and who settles it, it is not said twice.
  const said = stop === "conflict" && ((!!conflict?.path && conflict.path !== "merge" && rec.merges) || mergedFirst(base, conflict));
  return stop && !rec.close && !rec.backlog && !rec.author && !said ? { ...rec, text: STOPS[stop](rec.text) } : rec;
}

function recommended(review: ReviewView | null, plan: readonly PlanPart[]): Recommendation {
  const drop = droppedOf(plan);
  const rec = review?.rec;
  if (rec) {
    if (rec.close) return { text: rec.text || textFor({ close: true }), parts: { fix: [], drop }, merges: false, close: true };
    if (rec.backlog) return { text: rec.text || textFor({ backlog: true }), parts: { fix: [], drop }, merges: false, backlog: true };
    if (rec.author) return { text: rec.text || textFor({ author: true }), parts: { fix: [], drop }, merges: false, author: rec.scope ? "scope" : "ask" };
    const fix = rec.fix.filter((n) => !drop.includes(n));
    const said = (text: string): Recommendation => ({ text: rec.text && fix.length === rec.fix.length ? rec.text : text, parts: { fix, drop }, merges: rec.merge });
    // A person dropped every part the review wanted fixed: the rule below decides what is left.
    if (some(fix)) return said(textFor({ fix, merges: rec.merge }));
    if (!rec.fix.length && rec.merge) return said(textFor({ fix, merges: true }));
  }
  const fix = planned(plan);
  if (review?.verdict === "close") return { text: textFor({ close: true }), parts: { fix: [], drop }, merges: false, close: true };
  if (review?.verdict === "hold" && !fix.length) return held(review.finding ?? null, review.blockedBy ?? [], review.hold, drop);
  // An unsure take with nothing to fix asks whether to merge it: the person's yes is the judgement the review could not make.
  return { text: textFor({ fix, merges: true }), parts: { fix, drop }, merges: true };
}

/**
 * A hold that plans no fix, where the review gave no recommendation of its own. One that waits for the other items it names goes to the
 * backlog: nothing of the PR's own can settle it, and once none of them blocks any more the question closes and the PR is reviewed again. Otherwise its author finishes it: a hold the review classed as blocking the merge
 * (`hold`: a regression, the PR not doing what it says, security, data loss) asks the author at once; one that blocks nothing an
 * approval would merge may be a question of scope, and one with no class says neither, so a person answers first. A bare fix makes the fix-up build what the review found (withFinding).
 */
function held(finding: string | null, blockedBy: readonly string[], hold: Blocking | null | undefined, drop: number[]): Recommendation {
  const said = finding?.trim() ? asSentence(clipText(finding.trim(), FINDING_CHARS)) : null;
  const holds = (then: string) => (said ? t("The review holds it: {finding} {then}", { finding: said, then }) : t("The review holds it. {then}", { then }));
  if (blockedBy.length) {
    return { text: holds(t("It waits for {items}. Put it in the backlog.", { items: listText(blockedBy.map((r) => `\`${r}\``)) })), parts: { fix: [], drop }, merges: false, backlog: true, cause: { code: "blocked-by", items: [...blockedBy] } };
  }
  // Only a hold the review classed as blocking asks at once; one stored before reviews classed holds (no class) asks a person first.
  return { text: holds(textFor({ author: true })), parts: { fix: [], drop }, merges: false, author: hold != null && hold.class !== null ? "ask" : "scope" };
}

/** Characters of a review's finding a bare fix hands the fix-up (the instructions take at most INSTRUCTIONS_MAX). */
const FINDING_FIX_CHARS = 1200;

/** The review's finding on a recommendation that fixes no part and closes nothing: a bare fix in answer fixes what it says. */
function withFinding(rec: Recommendation, finding: string | null): Recommendation {
  const text = finding?.trim();
  return text && !rec.parts.fix.length && !rec.close ? { ...rec, finding: clipText(text, FINDING_FIX_CHARS) } : rec;
}

/**
 * A recommendation to ask the author, where AutoCraft does not ask them (`why`, effects.ts authorUnaskable): a yes puts the item in the
 * backlog, and the sentence keeps what the review found.
 */
export function withoutAuthor(rec: Recommendation, why: string, finding: string | null): Recommendation {
  const said = finding?.trim() ? asSentence(clipText(finding.trim(), FINDING_CHARS)) : null;
  const then = t("AutoCraft does not ask the author, since {why}. Put it in the backlog.", { why });
  return { text: said ? t("The review found: {finding} {then}", { finding: said, then }) : then, parts: { fix: [], drop: rec.parts.drop }, merges: false, backlog: true };
}

/** A question that takes the place of one the author pushed past. */
export const afterPush = (rec: Recommendation): Recommendation => ({ ...rec, text: t("The author pushed commits after the last question. {text}", { text: rec.text }) });

/**
 * What an item approved for merge stopped at a blocker comes back with. A yes resumes the plan with the merge still approved:
 * - a failing step runs again (the fix-up of the planned parts, a new review for a failing CI fix; a stuck implementation comes back through question.ts);
 * - the author's commits that the review round found beyond what was approved are kept; where the round had no review, they are reviewed;
 * - for the rest, what the blocker was about is accepted as it is.
 */
export function atBlocker(found: Found, _review: ReviewView | null, plan: readonly PlanPart[], mergeEntry = false): Recommendation {
  const drop = droppedOf(plan);
  const go = (text: string, extra: Partial<Recommendation> = {}): Recommendation => ({ text, parts: { fix: [], drop }, merges: true, ...extra });
  const p = found.params;
  switch (found.blocker) {
    case "author-commits": {
      // The day's review rounds of the author's commits are used up (advance.ts): a yes reviews the new ones too.
      if (p.round === "daily-cap") {
        const said = t("The author pushed new commits again, and AutoCraft already reviewed {n} rounds of the author's commits on this pull request today.", { n: Number(p.rounds ?? 0) });
        return go(`${said} ${t("Review the new commits, then merge.")}`, { newCommits: true, ...(mergeEntry ? { again: "review" } : {}) });
      }
      // The review round found the author's new commits beyond what was approved (advance.ts): its public finding, and a yes keeps them.
      if (p.round === "out-of-scope") {
        const finding = typeof p.finding === "string" && p.finding.trim() ? asSentence(clipText(p.finding, FINDING_CHARS)) : null;
        const said = finding ? t("The review finds the author's new commits go beyond what was approved: {finding}", { finding }) : t("The review finds the author's new commits go beyond what was approved.");
        return go(`${said} ${t("Keep them, then merge.")}`);
      }
      return go(t("Review the new commits, then merge."), { newCommits: true, ...(mergeEntry ? { again: "review" } : {}) });
    }
    case "failed-twice": {
      if (p.step === "fix-up") {
        // Minor parts are filed as follow-ups on an approved PR, never fixed (ask.ts withoutFixes).
        const fix = planned(plan).filter((n) => !plan.find((x) => x.n === n)?.minor);
        const why = typeof p.reason === "string" && p.reason ? `${asSentence(clipText(p.reason, FINDING_CHARS))} ` : "";
        return fix.length ? { text: `${why}${t("Try the fix-up of {parts} again, then merge.", { parts: listText(fix) })}`, parts: { fix, drop }, merges: true } : go(`${why}${t("Try the fix-up again, then merge.")}`, { again: "fixup" });
      }
      const again = t("Review it again with the failing checks, then merge.");
      return go(p.step === "CI fix" ? `${ciFixFailed(p)} ${again}` : again, { again: "review" });
    }
    case "other": {
      // The review of the author's new commits failed for good: a yes asks for it again.
      if (p.round === "review-failed") return go(t("Review the author's new commits again, then merge."), { newCommits: true, again: "review" });
      return afterStop(String(p.reason ?? ""), go);
    }
  }
}

/** What a CI fix that failed twice says: the failing checks (`params.failing`) and its last try (`params.last`), where the blocker names them. */
function ciFixFailed(p: Record<string, unknown>): string {
  const failing = Array.isArray(p.failing) ? (p.failing as string[]) : [];
  const last = typeof p.last === "string" && p.last ? asSentence(clipText(p.last, FINDING_CHARS)) : null;
  const what = failing.length ? t("CI fails ({checks}), and the CI fix failed twice.", { checks: listText(failing.map((x) => `\`${x}\``)) }) : t("CI fails, and the CI fix failed twice.");
  return last ? `${what} ${t("Its last try: {reason}", { reason: last })}` : what;
}

const afterStop = (reason: string, go: (text: string) => Recommendation): Recommendation =>
  go(reason ? t("Go on with the merge after this stop: {reason}", { reason: asSentence(reason) }) : t("Go on with the merge."));

/** The merge rule's reasons (core/decide.ts queueEntry) as a person reads them; a reason of its own wording is shown as it is. */
const RULE_REASONS: readonly (readonly [(r: string) => boolean, () => string])[] = [
  [(r) => r === UNSURE_REASON, () => t("the review is unsure")],
  [(r) => r === PREMERGE_DEFECT_REASON, () => t("the pre-merge review found a defect")],
  [(r) => r === PREMERGE_UNSURE_REASON, () => t("the pre-merge review could not verify a claim of the description")],
  [(r) => r === PREMERGE_FAILED_REASON, () => t("the pre-merge review failed")],
  [(r) => r.startsWith("conflicts with "), () => t("it goes against an earlier statement of the owners")],
  [(r) => r.startsWith("verification failed") || r.startsWith("verification errored"), () => t("verification failed")],
  [(r) => r.startsWith("the screenshots show"), () => t("the screenshots show a regression")],
];
/** Reasons a sentence names at most. */
const RULE_REASONS_SHOWN = 3;

/**
 * The recommendation of a PR the rule stopped at the pre-merge review's defects (`premerge`: their plan parts), where the end of its steps
 * would merge it as it is: the defects are fixed first, then it merges, as on an item approved for merge (atBlocker). A recommendation that
 * closes it, fixes nothing it could merge, or waits for a person to resolve a conflict stays as it is.
 */
export function premergeFirst(rec: Recommendation, premerge: readonly number[]): Recommendation {
  if (!rec.merges || rec.close || rec.waits || rec.again) return rec;
  const drop = rec.parts.drop;
  if (!premerge.length) return { text: t("Review it again, then merge."), parts: { fix: [], drop }, merges: true, again: "review" };
  const fix = [...rec.parts.fix, ...premerge];
  const text = rec.parts.fix.length ? textFor({ fix, merges: true }) : t("Fix the pre-merge review's findings {parts}, then merge.", { parts: listText(premerge) });
  return { text, parts: { fix, drop }, merges: true };
}

/** The recommendation of a PR the automatic merge rule took up and stopped, with why the rule does not merge it. */
export function ruleStopped(rec: Recommendation, reasons: readonly string[]): Recommendation {
  const why = [...new Set(reasons.map((r) => RULE_REASONS.find(([is]) => is(r))?.[1]() ?? r))].slice(0, RULE_REASONS_SHOWN);
  return { ...rec, stop: why.length ? listText(why) : t("it needs a person's judgement") };
}
