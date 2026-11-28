// The registered failure backoffs (src/stages/registry.ts GLOBAL_WAITS) of failed jobs and of the runner's own failed checks.

/** Failed jobs of a step are retried after 1, 2, 4, 8, 16 minutes, then every 30. */
export const FAIL_BACKOFF_MS = 60_000;
export const FAIL_BACKOFF_MAX_MS = 30 * 60_000;

/** Minutes-long wait after `failures` failed jobs in a row: 1, 2, 4, 8, 16 minutes, then 30. */
export const failureDelayMs = (failures: number): number => Math.min(FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_MS * 2 ** Math.max(0, failures - 1));

/** The longest wait of the runner's own checks: they cost a few reads, and a merge leg stands still meanwhile. */
export const RECHECK_MAX_MS = 2 * 60_000;

/** The wait after `failures` failed runs in a row of a check the runner makes itself: none after the first, then 1 minute, then 2. */
export const recheckDelayMs = (failures: number): number => (failures < 2 ? 0 : Math.min(RECHECK_MAX_MS, failureDelayMs(failures - 1)));

/** Retries AutoCraft makes itself of an implementation whose workspace did not start before its plan call; the next failure asks a person. */
export const IMPLEMENT_START_RETRIES = 3;

/** Issue review calls without a valid review before its maintainer is asked whether to try again (src/issuereview). */
export const ISSUE_REVIEW_TRIES = 3;
/** The wait before the next issue review call after `tries` calls without a valid review: 10, then 30 minutes. */
export const issueReviewDelayMs = (tries: number): number => (tries <= 1 ? 10 : 30) * 60_000;
/** When the issue review's next call is due: at once, or after the backoff of the calls that gave no valid review. */
export const issueReviewDueAt = (r: { tries: number; triedAt: string | null }): number => (r.tries > 0 && r.triedAt ? Date.parse(r.triedAt) + issueReviewDelayMs(r.tries) : 0);
const IMPLEMENT_START_DELAYS_MIN = [5, 15, 30] as const;

/** The wait after the `failures`-th failed implementation start in a row: 5, 15, then 30 minutes. */
export const implementStartDelayMs = (failures: number): number => IMPLEMENT_START_DELAYS_MIN[Math.min(Math.max(failures, 1), IMPLEMENT_START_DELAYS_MIN.length) - 1]! * 60_000;

/**
 * Retries AutoCraft makes itself of an implementation that stopped on a failure of its own (src/implement/stuck.ts OWN), counted
 * apart for Task Runner losses and for every other failure; the next stop of that kind asks a person.
 */
export const IMPLEMENT_RETRIES = 3;
const IMPLEMENT_RETRY_DELAYS_MIN = [15, 60, 180] as const;
/** The wait before the `n`-th retry of a stopped implementation: 15 minutes, 1 hour, then 3 hours. */
export const implementRetryDelayMs = (n: number): number => IMPLEMENT_RETRY_DELAYS_MIN[Math.min(Math.max(n, 1), IMPLEMENT_RETRY_DELAYS_MIN.length) - 1]! * 60_000;

/**
 * How long the repo's Implement breaker stays tripped by failures of AutoCraft's own before it lifts by itself for one probe
 * implementation (src/implement/stuck.ts): 3 hours after the trip, the longest wait of an implementation's own retries.
 */
export const IMPLEMENT_OWN_TRIP_LIFT_MS = 3 * 3600_000;
