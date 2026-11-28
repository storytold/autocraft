// Constants and pure helpers of the merge rule, shared by the old modules (which re-export them) and by decide.ts. No imports,
// so the web client can use them.

/** Type labels whose PRs may merge without asking. */
export const RULE_LABELS = ["bugfix", "infra"];
/** Sizes that may merge without asking. */
export const RULE_SIZES = ["S", "M"];
/** Tiers that count as on the whitelist. */
export type Tier = "whitelisted" | "not" | "allow" | "deny";
export const RULE_TIERS: Tier[] = ["whitelisted", "allow"];

/**
 * The PRs that go through review, fix-up and merge with nobody starting them: small and
 * medium bug fixes (and infra) from whitelisted authors, the merge rule's own criteria, with a label no unsure referee settled,
 * no needs-decision flag and no duplicate among the repo's open and merged PRs.
 */
export const autoEligible = (p: { label: string | null; size: string; tier: string; labelUnsure?: boolean; needsDecisionFlag: boolean; duplicates?: unknown }): boolean =>
  !p.duplicates && !!p.label && RULE_LABELS.includes(p.label) && RULE_SIZES.includes(p.size) && (RULE_TIERS as string[]).includes(p.tier) && !p.labelUnsure && !p.needsDecisionFlag;

/** Why an unsure Opus take waits for a person instead of merging by the rule. */
export const UNSURE_REASON = "Opus was unsure";
export const PREMERGE_UNSURE_REASON = "the pre-merge review could not verify a claim of the description";
export const PREMERGE_DEFECT_REASON = "the pre-merge review found a defect";
export const PREMERGE_FAILED_REASON = "the pre-merge review failed";

/** Verification states that let a PR merge. */
export const VERIFY_OK = ["passed", "ci-enough"];
export const verifyOk = (state: string | null | undefined): boolean => !!state && VERIFY_OK.includes(state);
/** A PR in a repo Verify cannot build is merged only on a person's approval, which says "not verified". */
export const VERIFY_UNAVAILABLE = "unavailable";
/** A failed or errored verification stops the merge; an approval given after the result stands over it (`override`). */
export const verifyAllows = (path: "rule" | "operator" | "maintainer" | null, state: string | null | undefined, override = false): boolean =>
  verifyOk(state) || (path === "operator" && (state === VERIFY_UNAVAILABLE || (override && (state === "failed" || state === "error"))));

/** A PR whose mergeable state stayed unknown for several checks reads is requested once from GitHub's REST endpoint (src/merge/mergeable.ts); a null answer asks a person. */
export const UNKNOWN_REREADS = 1;

/** A refusal caused by GitHub or the network, not by the PR: tried once more before a person is asked. */
export const TRANSIENT_REFUSAL = /\b5\d\d\b|timed? ?out|ETIMEDOUT|ECONN|EAI_AGAIN|rate limit|temporar|unavailable|bad gateway/i;

/** A merge refusal that only reports the state of CI, mergeable or the head: it clears when that state changes. Any other refusal is asked about. */
export const STATE_REFUSAL = /^(not ready at merge time|head moved|no longer open|GitHub returned no such PR|the operator's merge answer is gone|verification at)/;
/** Why nothing merges a PR aimed elsewhere, whoever approves it. */
export const OFF_DEFAULT_REASON = "its base is not the default branch";
/** CI lets a head merge only once it passed, also where a person approved the merge and in a repo that has no CI. */
export const ciAllows = (ci: string | null | undefined): boolean => ci === "success";

export type Size = "S" | "M" | "L";

/**
 * The PR's head commit as best known: the checks table's when it was fetched after the mirror last saw the PR change, else the mirror's.
 */
export function headOf(r: { head_oid: string | null; updated_at: string | null; c_head: string | null; c_at: string | null }): string | null {
  if (r.c_head && r.c_at && (!r.updated_at || r.c_at > r.updated_at)) return r.c_head;
  return r.head_oid ?? r.c_head;
}
/** Same S and M bounds as the dashboard's size column; its L and XL are both L here. */
export function sizeOf(linesChanged: number): Size {
  return linesChanged <= 50 ? "S" : linesChanged <= 300 ? "M" : "L";
}

/** Approval attempts per CI run before the PR is left to a person. */
export const MAX_FAILURES = 2;
/** A failed head counts as failed after this many pre-merge tries. */
export const PREMERGE_MAX_TRIES = 3;
/** Automatic fix-up rounds of a PR's pre-merge defects over its whole life; a round that brings a defect back stops them sooner. */
export const PREMERGE_FIX_ROUNDS = 3;
/** How long a failed try waits before the next one. */
export const RETRY_AFTER_MS = 3600_000;

/** Queue states a PR leaves for its batch's state while it is in a batch. */
export const BATCHABLE = ["ready", "decision-answered-merge", "refused", "waiting-ci"];
/** States that wait while the repo's main CI is red. */
export const MAIN_RED_HELD = ["ready", "decision-answered-merge", "refused"];

/** The queue's note for a conflicted PR, or null when nothing acts on it. */
export function conflictNote(bucket: string, base: string): string | null {
  switch (bucket) {
    case "merge": case "linting": return `conflict: merging ${base}`;
    case "ask": case "asked": return "conflict: asked the contributor";
    case "ask-retry": return "conflict: the ask comment is tried again";
    case "held": return "conflict: held";
    case "capped": return "conflict: merge cap for today reached";
    default: return null;
  }
}

/** Fix-up tries (pushed, failed, refused or rejected) before the step leaves the PR to a person: since a person last went on with a PR approved for merge, else over the PR's life. */
export const FIXUP_MAX_ATTEMPTS = 2;
/** Review rounds of the author's new commits on a PR approved for merge per UTC day (since a person last went on with it): the next one waits for their answer. A runaway backstop that normal work never reaches. */
export const AUTHOR_ROUNDS_PER_DAY = 10;
/** Lint rounds (a lint task on a stored model patch) per head before the patch is abandoned. */
export const LINT_MAX_ROUNDS = 2;
/** Base branch names a conflict merge accepts. */
export const BASE_NAME = /^[A-Za-z0-9._/-]+$/;

/** CI fix: tries per head, pushed fixes and tries per PR over all heads. */
export const CIFIX_MAX_TRIES = 2;
export const CIFIX_MAX_PUSHES_PER_PR = 2;
export const CIFIX_MAX_TRIES_PER_PR = 4;
/** Merges of the base branch into one PR per UTC day (pushed ones, over all heads); a busy base branch otherwise keeps a PR in a merge, check and review loop. */
export const CONFLICT_MAX_MERGES_PER_PR_PER_DAY = 2;
export const CIFIX_TRY_STATES = ["formatting", "linting", "superseded", "pushing", "pushed", "failed", "refused", "rejected"];
export const CIFIX_PUSH_STATES = ["pushing", "pushed"];
/** States that end the CI fix step's work at a head. */
export const CIFIX_FINAL_STATES = ["pushed", "pushing", "asked", "push-denied", "cannot-push", "skipped", "comment-failed"];
/** The reason of the `asked` row that hands red CI to the contributor (an `asked` row with a posted patch has another). */
export const CIFIX_ASK_REASON = "the CI fix is left to the contributor";
/** The reason of a `failed` row older code wrote when the failure log could not be read; such a row is no try (it is `unread` now). */
export const CIFIX_NO_LOG_REASON = "no failure log";
/**
 * A failure log that cannot be read yet (the run still goes on, GitHub has no log to download yet), or a rerun that left no check
 * result newer than itself, is recorded as `unread`, which is no try, and read again after these delays, then once per the last
 * delay for as long as the head stays the same.
 */
export const CIFIX_UNREAD_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

/** When the next try after the `n`th (1-based) of a series is due: `delays` in turn, then the last one again for every further try. */
export const repeatAfter = (lastMs: number, n: number, delays: readonly number[]): number => lastMs + delays[Math.min(Math.max(n, 1), delays.length) - 1]!;

/**
 * An ask comment that never reached GitHub (the app lane got no token, so no request went out) is recorded as
 * `comment-unsent` and asked again after these delays; one more unsent row past them is final, as `comment-failed` is.
 */
export const COMMENT_UNSENT_DELAYS_MS = [10 * 60_000, 60 * 60_000];
/** Where a head's unsent ask comments (`ats`: their rows' times, ISO) leave the next ask: due (null), due at `until` (ms), or final. */
export function unsentAsk(ats: readonly string[], nowMs: number, delays: readonly number[] = COMMENT_UNSENT_DELAYS_MS): { until: number } | "final" | null {
  if (ats.length === 0) return null;
  if (ats.length > delays.length) return "final";
  const until = Math.max(...ats.map((a) => Date.parse(a))) + delays[ats.length - 1]!;
  return until > nowMs ? { until } : null;
}

/** Setting that holds the pipeline account's login, recorded wherever the pipeline pushes as that account. */
export const PIPELINE_LOGIN_KEY = "pipeline_login";

/** Build-tool (check) calls one patch-writing model call may make, and the wall time they may take in all. */
export const CHECK_MAX_CALLS = 6;
export const CHECK_MAX_WALL_MS = 45 * 60_000;
/** One check is stopped after CHECK_LIMIT_FACTOR times the repo's median recent duration of that command, clamped to [CHECK_LIMIT_MIN_MS, CHECK_LIMIT_MAX_MS]; without CHECK_HISTORY_MIN finished runs it gets the maximum. */
export const CHECK_LIMIT_FACTOR = 5;
export const CHECK_LIMIT_MIN_MS = 5 * 60_000;
export const CHECK_LIMIT_MAX_MS = 15 * 60_000;
export const CHECK_HISTORY_MIN = 3;
export const CHECK_HISTORY_RUNS = 20;
/** Lines of command output the tool returns to the model. */
export const CHECK_OUTPUT_LINES = 150;

/**
 * Value of the `pipeline_enabled` setting: "1" is on, "drain" is draining (no new jobs; jobs already running keep their writes),
 * anything else is off (running jobs stop writing).
 */
export const PIPELINE_DRAIN = "drain";
/** Whether a job's GitHub writes pass the pipeline switch: on, or draining. */
export const pipelineWrites = (value: string | undefined): boolean => value === "1" || value === PIPELINE_DRAIN;
