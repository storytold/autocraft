// Why work waits, is refused or stopped, as codes: who can move it on and what the reader may do about it. The sentence a person reads
// stays beside the code, in `text`. No imports: the web build may use it.

export type Who = "person" | "contributor" | "system";

/** Why an action that is due may not run. */
export type RefusalCode =
  | "pipeline-off" | "scope" | "ended" | "duplicate" | "blocked" | "not-approved" | "unaccepted-head" | "not-handed-over"
  | "actor-gone" | "actor-unknown" | "box-identity" | "request-unnamed" | "repo-approval" | "breaker" | "author-ask" | "untracked" | "unplanned" | "other";

/** What an item waits on when nothing of it is due. */
export type WaitCode = RefusalCode
  | "answer" | "not-started" | "ci" | "mergeable-unknown" | "mergeable-stuck" | "premerge" | "verification" | "verification-failed"
  | "ci-approval" | "ci-approval-failed" | "main-red" | "batch" | "batch-failed" | "changes-requested" | "merge-refused" | "refusal-retry"
  | "sign-in" | "hand-over" | "followups" | "leg" | "base-off-default" | "no-ci" | "review-hold" | "review-failed" | "review-cap"
  | "fix-contributor" | "fix-running" | "fix-failed" | "conflict-contributor" | "conflict-person" | "conflict-cap"
  | "ci-contributor" | "ci-running" | "ci-fix-failed" | "ci-own-breakage" | "ci-nothing-to-fix" | "ask-unsent" | "ask-failed" | "lint"
  | "screenshots" | "revision" | "revision-failed" | "implement-question" | "implement-stuck" | "implement-off" | "implement-ended" | "implement-room"
  | "implement-start-retry" | "issue-review-retry" | "issue-reporter" | "open-pr" | "draft" | "mirror" | "triage" | "open-request" | "outside-hold";

/** Why a merge leg ended without a merge. */
export type StopCode =
  | "author-push" | "head-back" | "review-hold" | "review-close" | "review-failed" | "not-reviewable" | "verification-failed"
  | "premerge-defect" | "premerge-failed" | "merge-refused" | "fix-failed" | "fix-too-large" | "fix-cannot-run" | "ci-failed" | "no-ci"
  | "approval-gone" | "actor-gone" | "workflow-ended" | "pr-gone" | "pr-closed" | "pr-merged" | "person" | "blocked" | "other";

export type Params = Readonly<Record<string, string | number | null | readonly (string | number)[]>>;
export type Why<C extends string> = { code: C; who: Who; params?: Params; text: string };
export type Refusal = Why<RefusalCode>;
export type Stop = Why<StopCode>;

/** Who settles a refusal of this code. */
export const refusalWho = (code: RefusalCode): Who =>
  (code === "not-handed-over" || code === "actor-unknown" || code === "scope" || code === "untracked" || code === "unplanned" ? "system" : code === "author-ask" ? "contributor" : "person");

/**
 * Person waits that ask nothing: a person set them on purpose, or their person acts on GitHub, on a switch or at the sign-in, or (the item that
 * blocks a review) their question is another item's.
 */
const NO_QUESTION: ReadonlySet<WaitCode> = new Set([
  "repo-approval", "changes-requested", "sign-in", "open-pr", "conflict-person", "review-hold", "box-identity", "pipeline-off", "breaker",
]);

/** Whether a started item with this wait has to have a question open. A conflict our step cannot resolve on a PR approved for merge (`approved`) is its approver's question. */
export const needsQuestion = (code: WaitCode, who: Who, approved = false): boolean => who === "person" && (!NO_QUESTION.has(code) || (approved && code === "conflict-person"));

// ---- codes of the texts ---------------------------------------------------------------------------------------------

/**
 * The reasons a merge leg ends with, the first that matches. The codes that stand for a blocker of their own come first, in the blockers'
 * order: a reason that quotes another (a review's sentence, a refusal) keeps the blocker of what it quotes.
 */
const STOP_FORM: readonly (readonly [RegExp, StopCode])[] = [
  [/another push moved the head/, "author-push"],
  [/the head went back/, "head-back"],
  [/pre-merge review found/, "premerge-defect"],
  [/the review says hold/, "review-hold"],
  [/the review says close/, "review-close"],
  [/verification failed/, "verification-failed"],
  [/too-large/, "fix-too-large"],
  [/^the fix-up cannot run: |^the review of .* asks for fixes and its fix-up cannot run/, "fix-cannot-run"],
  [/^the fix-up /, "fix-failed"],
  [/ cannot be reviewed \(/, "not-reviewable"],
  [/^the review of .* waits on /, "review-failed"],
  [/^the pre-merge review of .* failed$/, "premerge-failed"],
  [/^the merge was refused: /, "merge-refused"],
  [/^CI failed at /, "ci-failed"],
  [/^the repo has no CI/, "no-ci"],
  [/^merging is no longer approved$/, "approval-gone"],
  [/ no longer may act on /, "actor-gone"],
  [/^its workflow ended$/, "workflow-ended"],
  [/^the PR is gone$/, "pr-gone"],
  [/^the PR was merged before /, "pr-merged"],
  [/^the PR was closed$/, "pr-closed"],
  [/^cancelled by pipeline$/, "blocked"],
  [/^cancelled by /, "person"],
];

/** The code of a merge leg's stored reason, for a row that has none. */
export const stopCodeOf = (reason: string): StopCode => STOP_FORM.find(([re]) => re.test(reason))?.[1] ?? "other";
