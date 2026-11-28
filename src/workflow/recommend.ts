// The one recommendation an item comes back with, and the numbered plan it refers to. Pure: advance.ts gives it the latest
// review and the blocker, and records the result on the workflow row.
//
// The review writes the sentence and says what a yes runs (src/review/opus-parse.ts ReviewRecommendation), so the text and the run
// always agree. A blocker the review cannot speak for (author commits, a failing step, files beyond the plan, a merge
// leg that stopped) gets a sentence built here from its facts.
import { t } from "../i18n/index.ts";
import { byHand, type ConflictPath } from "../core/decide.ts";
import { PREMERGE_DEFECT_REASON, PREMERGE_FAILED_REASON, PREMERGE_UNSURE_REASON, UNSURE_REASON } from "../core/rules.ts";
import { notBlocking } from "../premerge/types.ts";
import { asSentence, clipText } from "../prose.ts";
import type { ReviewFix, ReviewRecommendation } from "../review/opus-parse.ts";
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

/** `finding`: what the review found, in the words it wrote for the PR (its public summary, which is posted anyway); null when it wrote none. */
export type ReviewView = { verdict: string; sure: boolean; rec: ReviewRecommendation | null; finding?: string | null };

/** Characters of a review's finding a recommendation quotes. */
const FINDING_CHARS = 300;

export const planned = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "planned").map((p) => p.n);
export const droppedOf = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "dropped").map((p) => p.n);

/** "Fix 1 and 2, then merge." / "Fix 1, then come back." */
const fixText = (fix: readonly number[], merges: boolean): string => (merges
  ? t("Fix {parts}, then merge.", { parts: listText(fix) })
  : t("Fix {parts}, then come back with the result.", { parts: listText(fix) }));

/** The sentence for what a yes runs, when the review's own sentence does not say it. */
export function textFor(r: { fix: readonly number[]; merges: boolean; close?: boolean; backlog?: boolean; again?: "review" | "fixup" }): string {
  if (r.close) return t("Close it, as the review recommends.");
  if (r.backlog) return t("Put it in the backlog.");
  if (r.fix.length) return fixText(r.fix, r.merges);
  if (r.again === "review") return r.merges ? t("Review it again, then merge.") : t("Review it again, then come back with the result.");
  return r.merges ? t("Merge it.") : t("Leave it as it is.");
}

/** The planned parts of the review's fixes that nobody makes, dropped: the merge goes on without them. */
export function without(parts: readonly number[], protectedFiles: boolean): Recommendation {
  const vars = { parts: listText(parts) };
  return {
    text: protectedFiles ? t("The review asks for changes to files AutoCraft may not touch. Drop {parts}, then merge.", vars)
      : t("The review asks for fixes that AutoCraft's fix-up cannot make and nobody else is asked for. Drop {parts}, then merge.", vars),
    parts: { fix: [], drop: [...parts] }, merges: true,
  };
}

const STOPS = {
  conflict: (text: string) => t("It conflicts with its base branch. {text}", { text }),
  ci: (text: string) => t("CI fails at its latest commit. {text}", { text }),
};

/** A conflict with the base branch, and who settles it once the merge is approved (src/core/decide.ts conflictPath). */
export type Conflict = { path: ConflictPath | null };

const ON_CONFLICT: Record<Exclude<ConflictPath, "merge">, (text: string) => string> = {
  contributor: (text) => t("It conflicts with its base branch, which the contributor has to resolve first. {text}", { text }),
  person: (text) => t("It conflicts with its base branch, which AutoCraft cannot resolve: someone has to do that on its branch first. {text}", { text }),
};

/**
 * The recommendation on a PR that conflicts with its base branch, where no fix-up can be made before that merge. Where the pipeline merges the
 * base in, a yes approves the merge and the fixes follow that merge. Where a person has to resolve the conflict, a yes approves the
 * merge and waits for them: it runs nothing that could ask the same again. A PR with no review to go on from is reviewed again.
 */
export function onConflict(rec: Recommendation, conflict: Conflict | null): Recommendation {
  if (!conflict || rec.close || rec.backlog || rec.answer) return rec;
  const { path } = conflict, fixes = rec.parts.fix.length > 0 || rec.again === "fixup";
  if (path === null) return fixes ? { text: textFor({ fix: [], merges: rec.merges, again: "review" }), parts: { fix: [], drop: rec.parts.drop }, merges: rec.merges, again: "review" } : rec;
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
  const rec = onConflict(withFinding(recommended(review, plan), review?.finding ?? null), conflict);
  // Where the sentence is already about the conflict and who settles it, it is not said twice.
  const said = stop === "conflict" && !!conflict?.path && conflict.path !== "merge" && rec.merges;
  return stop && !rec.close && !rec.backlog && !said ? { ...rec, text: STOPS[stop](rec.text) } : rec;
}

function recommended(review: ReviewView | null, plan: readonly PlanPart[]): Recommendation {
  const drop = droppedOf(plan);
  const rec = review?.rec;
  if (rec) {
    if (rec.close) return { text: rec.text || textFor({ fix: [], merges: false, close: true }), parts: { fix: [], drop }, merges: false, close: true };
    if (rec.backlog) return { text: rec.text || textFor({ fix: [], merges: false, backlog: true }), parts: { fix: [], drop }, merges: false, backlog: true };
    const fix = rec.fix.filter((n) => !drop.includes(n));
    // A person dropped every part the review wanted fixed: the rule below decides what is left.
    if (fix.length || (!rec.fix.length && rec.merge)) {
      return { text: rec.text && fix.length === rec.fix.length ? rec.text : textFor({ fix, merges: rec.merge }), parts: { fix, drop }, merges: rec.merge };
    }
  }
  const fix = planned(plan);
  if (review?.verdict === "close") return { text: textFor({ fix: [], merges: false, close: true }), parts: { fix: [], drop }, merges: false, close: true };
  if (review?.verdict === "hold" && !fix.length) return held(review.finding ?? null, drop);
  // An unsure take with nothing to fix asks whether to merge it: the person's yes is the judgement the review could not make.
  return { text: textFor({ fix, merges: true }), parts: { fix, drop }, merges: true };
}

/**
 * A hold that plans no fix: the item goes to the backlog, open with no work planned. What it waits for (the scope a maintainer settles,
 * the rest the author builds, other items) is not AutoCraft's to do; any command starts it again, and a bare fix makes the fix-up build
 * what the review found (`finding`, withFinding).
 */
function held(finding: string | null, drop: number[]): Recommendation {
  const said = finding?.trim() ? asSentence(clipText(finding.trim(), FINDING_CHARS)) : null;
  const text = said ? t("The review holds it: {finding} Put it in the backlog.", { finding: said }) : t("The review holds it. Put it in the backlog.");
  return { text, parts: { fix: [], drop }, merges: false, backlog: true };
}

/** Characters of a review's finding a bare fix hands the fix-up (the instructions take at most INSTRUCTIONS_MAX). */
const FINDING_FIX_CHARS = 1200;

/** The review's finding on a recommendation that fixes no part and closes nothing: a bare fix in answer fixes what it says. */
function withFinding(rec: Recommendation, finding: string | null): Recommendation {
  const text = finding?.trim();
  return text && !rec.parts.fix.length && !rec.close ? { ...rec, finding: clipText(text, FINDING_FIX_CHARS) } : rec;
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
