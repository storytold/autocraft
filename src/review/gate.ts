// Reasons a due review waits: another item blocks the PR, CI at its head has not passed, the PR used its reviews for the day,
// the last review is too recent, or the last attempts at this head failed.
import { ciAt } from "../core/evidence.ts";
import { personReviewSince, roundWaits } from "../core/author-round.ts";
import { optionalChecksOf } from "../optional-checks.ts";
import { mainsFailuresOf } from "../mainci/no-new.ts";
import { BLOCKED_EXPIRES_MS, BLOCKS_REVIEW, activeFrom, hasOpenQuestion, loadBlockerReads, type BlockerReads } from "./blockers.ts";
import { MAX_RERUNS_PER_DAY, maintainerSince, discussionStateOf, nextUtcMidnight, staleMarksOf } from "./discussion.ts";
import { ourPathIn } from "./ours.ts";
import type { Db } from "../db/index.ts";
import type { KeySource } from "../data/keys.ts";
import { loadPushEdges, type PushEdge } from "../data/changes/index.ts";
import { saveSettings, setting } from "../data/control/index.ts";
import { loadReviewRunCounts } from "../data/inference/index.ts";
import { loadRunApprovals } from "../data/merge/index.ts";
import { loadChecks } from "../data/mirror/index.ts";
import { loadReviewFacts, recordReviewFailures, type ReviewFacts } from "../data/review/index.ts";
import { loadLegs, loadWorkflowFacts } from "../data/workflow/index.ts";
import { loadOwnPushes } from "../data/views/own-pushes.ts";

/** Opus review calls of one PR per UTC day, new heads, re-runs and failed calls together (a reply-fix turn is part of its review). */
export const MAX_REVIEWS_PER_DAY = MAX_RERUNS_PER_DAY;

/** Setting: least minutes between two Opus reviews of one PR; 0 turns the wait off. */
export const MIN_INTERVAL_KEY = "review_min_interval_minutes";
export const MIN_INTERVAL_DEFAULT = 120;
const MIN_INTERVAL_MAX = 7 * 24 * 60;

const HOUR = 3600_000;
/**
 * Waits after each failed review at one head: 10 and 30 minutes and 2 hours, then every 6 hours for about a day. The failure after the
 * last wait holds the head for a person: a new commit, a Review again press or a maintainer's comment.
 */
export const FAILURE_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR];
/**
 * Waits after review calls in a row at one head that ended without a reply (a lost Task Runner, an outage). The call after the last wait
 * counts as one model failure (recordReviewFailures), and the count of lost calls starts over.
 */
export const LOST_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * HOUR, 6 * HOUR];

/** When the review may run again after the `n`th failure counted by `delays`, made at `at`; past the last delay null, or with `repeat` that delay again. */
const retryAt = (delays: readonly number[], n: number, at: string | null, repeat: boolean): number | null => {
  const d = delays[n - 1] ?? (repeat ? delays.at(-1)! : undefined);
  return d === undefined ? null : Date.parse(at ?? "") + d;
};

/** The setting's value as stored. */
export function minIntervalOf(v: string | null | undefined): number {
  const n = Number(v);
  return v != null && Number.isInteger(n) && n >= 0 && n <= MIN_INTERVAL_MAX ? n : MIN_INTERVAL_DEFAULT;
}

export const reviewMinInterval = async (db: Db): Promise<number> => minIntervalOf(await setting(db, MIN_INTERVAL_KEY));

export async function setReviewMinInterval(db: Db, input: unknown, by: string): Promise<number> {
  const n = typeof input === "number" ? input : typeof input === "string" && /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MIN_INTERVAL_MAX) throw new Error(`the minimum minutes between reviews must be a whole number from 0 to ${MIN_INTERVAL_MAX}`);
  const was = await reviewMinInterval(db);
  await saveSettings(db, [{ key: MIN_INTERVAL_KEY as never, value: String(n) }], by, n !== was ? { action: "review-min-interval", target: "pipeline", details: { minutes: n, was } } : { action: "settings-save", target: "settings" });
  return n;
}

/** Counts a review call at this head that gave no valid review, or with `lost` one that ended without a reply; the earlier heads' counts are forgotten. */
export async function recordReviewFailure(db: Db, repo: string, number: number, head: string, nowMs: number = Date.now(), lost = false): Promise<void> {
  await recordReviewFailures(db, [{ repo, number, head, at: new Date(nowMs).toISOString(), ...(lost ? { lost } : {}) }]);
}

/** `until`: when a timed wait ends (ms), so the planner wakes then. `red`: a ci hold whose head's CI has failed (not still running). */
export type ReviewHold = { kind: "blocked" | "ci" | "cap" | "interval" | "failed"; wait: string; until?: number; red?: boolean; /** A blocker has an open question: the wait is on a person. */ person?: boolean };

export { nextUtcMidnight };

/** What the hold check of a set of PRs reads besides their review facts: one wave. */
export async function loadHoldInputs(db: Db, keys: KeySource, nowMs: number) {
  const [runs, legs, checks] = await db.together(() => Promise.all([
    loadReviewRunCounts(db, keys, new Date(nowMs).toISOString().slice(0, 10)), loadLegs(db, keys, { activeOnly: true }), loadChecks(db, keys, { checksOnlyIfFailing: true }),
  ]));
  return { runs, legs, checks };
}

export type HoldInputs = Awaited<ReturnType<typeof loadHoldInputs>> & {
  facts: ReviewFacts;
  optional: (repo: string) => string[];
  /** The failing checks of `ref` at `head` that fail only where the red main fails (src/mainci/no-new.ts): they do not make CI red. */
  mains: (ref: string, head: string) => string[];
  /** The least minutes between two reviews of one PR. */
  interval: number;
  /** The blockers the holds among the latest reviews name. */
  reads: BlockerReads;
  /** The pushes of ours to each PR, by "repo#number". */
  edges: ReadonlyMap<string, readonly PushEdge[]>;
  /** The run approvals at each head, by "repo#number@head". */
  approvals: ReadonlyMap<string, { approved: readonly number[] }>;
  /** Whether the PR ("repo#number") waits at `head` for the review round of its author's new commits (roundWaits). */
  authorRound?: (ref: string, head: string) => boolean;
  /** When a person's live workflow on the PR ("repo#number") that asks for a review started, or null: red CI does not hold that review (see holdsFrom). */
  personReview?: (ref: string) => string | null;
};


export type HoldCheck = (repo: string, number: number, head: string, refresh?: (at: number) => void) => Promise<ReviewHold | null>;

/** The hold check of `refs` ("repo#number"; every PR without them), with what it reads loaded once. */
export async function reviewHolds(db: Db, nowMs: number = Date.now(), refs?: Iterable<string>): Promise<HoldCheck> {
  const keys: KeySource = refs ? [...refs].map((r) => ({ repo: r.slice(0, r.lastIndexOf("#")), number: Number(r.slice(r.lastIndexOf("#") + 1)) })) : { mode: "full" };
  const [facts, inputs, interval, optional, edges, approvals, workflows, pushes, mains] = await db.together(() => Promise.all([
    loadReviewFacts(db, keys, { now: nowMs }), loadHoldInputs(db, keys, nowMs), reviewMinInterval(db), optionalChecksOf(db), loadPushEdges(db, keys), loadRunApprovals(db, keys),
    loadWorkflowFacts(db, keys, { nowMs }), loadOwnPushes(db, keys), mainsFailuresOf(db, keys, nowMs),
  ]));
  const reads = await loadBlockerReads(db, [...facts.latest.values()].filter((r) => r.verdict === "hold").flatMap((r) => r.blocked_by));
  const authorRound = (ref: string, head: string): boolean => roundWaits(workflows.live.get(ref), pushes.get(ref) ?? [], head);
  const personReview = (ref: string): string | null => personReviewSince(workflows.live.get(ref));
  return holdsFrom({ ...inputs, facts, interval, optional, mains, reads, edges, approvals, authorRound, personReview }, nowMs);
}

/**
 * The hold check of every PR of one planning pass, from its loads. A hold is what keeps the next review of a PR at `head`
 * from starting, or null. A maintainer's or operator's request after the latest review lifts every hold.
 * An unknown CI state does not hold (the review step reads the checks live before asking the model and applies this again).
 * Not held by CI: the first review of a PR when CI is red (running CI still waits), and the one review after the blockers settled.
 * Not held by the cap or the interval: a head that only our own pushes made since the last review.
 * `refresh` is told when a hold without an `until` of its own ends with the clock (a blocker list expiring).
 */
export function holdsFrom(d: HoldInputs, nowMs: number): HoldCheck {
  const { facts, runs, legs, checks, optional, reads } = d;
  const interval = d.interval * 60_000;
  const lastReviews = facts.latest;
  const history = facts.reviewsToday;
  const staleSince = staleMarksOf(facts);
  // A "Queue items" row at the head it started on (no fix-up, no push since) asks for no review of its own: CI, the cap and the interval hold it as any PR.
  const preapproved = new Set([...legs.values()].flat().filter((p) => p.state === "review" && (p.fix_id !== null || p.head !== p.from_head) && p.head !== null).map((p) => `${p.repo}#${p.number}@${p.head}`));
  const states = discussionStateOf(facts);
  return async (repo, number, head, refresh) => {
    const ref = `${repo}#${number}`;
    const last = lastReviews.get(ref);
    // The failure backoff holds even after a request: a review that keeps failing is not retried on every pass.
    const mark = facts.marks.get(ref);
    const failed = mark && mark.failHead === head && mark.failCount > 0 ? mark : undefined;
    if (failed) {
      const n = failed.failCount, until = retryAt(FAILURE_BACKOFF_MS, n, failed.failAt, false);
      if (until === null) {
        // Final. A request newer than the last failure grants one more try; a failure then stamps a newer time and makes it final again.
        const since = failed.failAt ?? "";
        const asked = staleSince(repo, number, since) || await maintainerSince(states.get(ref), since, null);
        if (!asked) return { kind: "failed", wait: `its review failed ${n} times at this commit; a new commit, a Review again press or a maintainer's comment gives it one more try` };
      } else if (until > nowMs) return { kind: "failed", wait: `the review after ${n} failed ${n === 1 ? "try" : "tries"} at this commit, from ${new Date(until).toISOString().slice(11, 16)}`, until };
    }
    const lost = mark && mark.failHead === head && mark.lostCount > 0 ? mark : undefined;
    const lostUntil = lost ? retryAt(LOST_BACKOFF_MS, lost.lostCount, lost.lostAt, true)! : 0;
    // A person's request since the last lost call goes ahead of its wait.
    if (lost && lostUntil > nowMs && !(staleSince(repo, number, lost.lostAt ?? "") || await maintainerSince(states.get(ref), lost.lostAt ?? "", null))) {
      return { kind: "failed", wait: `the review after ${lost.lostCount} ${lost.lostCount === 1 ? "call" : "calls"} at this commit that ended without a reply, from ${new Date(lostUntil).toISOString().slice(11, 16)}`, until: lostUntil };
    }
    // A person's pre-approved merge waits for the review of the head the pipeline pushed for it: that is their request for it, as a review-again press would be.
    // So does the review round of the author's new commits on a PR approved for merge.
    if (preapproved.has(`${ref}@${head}`) || d.authorRound?.(ref, head)) return null;
    if (last) {
      // reviewRequestedSince() with the stale marks read once.
      if (staleSince(repo, number, last.at) || await maintainerSince(states.get(ref), last.seen_at ?? last.at, last.disc_hash)) return null;
    }
    let settled = false;
    if (last?.verdict === "hold" && last.blocked_by.length) {
      const open = activeFrom(reads, ref, last.blocked_by, last.at, nowMs);
      if (open.length) {
        refresh?.(Date.parse(last.at) + BLOCKED_EXPIRES_MS + 1);
        return { kind: "blocked", wait: `${open.join(", ")}${BLOCKS_REVIEW}`, ...(hasOpenQuestion(reads, open) ? { person: true } : {}) };
      }
      settled = true;
    }
    const ci = ciAt(checks.get(ref), head, { optional: [...optional(repo), ...d.mains(ref, head)], approvedRuns: d.approvals.get(`${ref}@${head}`)?.approved.length ?? 0 });
    if (ci === "pending") return { kind: "ci", wait: "CI on the latest commit to finish" };
    const ours = last && last.head !== head ? ourPathIn(d.edges.get(ref) ?? [], last.head, head) : null;
    if (ci === "failure" && last && !settled) {
      // A person's workflow asks for a review of red CI once: when nothing was reviewed under it yet, or the author made the head. Our own pushes (the CI fix) get none.
      const since = d.personReview?.(ref);
      const asked = since != null && (last.at < since || !(ours?.complete && ours.commits.length));
      if (!asked) return { kind: "ci", wait: "CI on the latest commit to pass", red: true };
    }
    if (ours?.complete && ours.commits.length) return null;
    const h = history.get(ref) ?? { n: 0, last: null };
    const r = runs.get(ref) ?? { n: 0, last: null };
    if (Math.max(h.n, r.n) >= MAX_REVIEWS_PER_DAY) return { kind: "cap", wait: "review cap for today reached; next on a maintainer's request or tomorrow", until: nextUtcMidnight(nowMs) };
    if (interval) {
      // Successful reviews only: failed calls count toward the cap, and the failure backoff spaces their retries.
      const until = h.last ? Date.parse(h.last) + interval : 0;
      if (until > nowMs) return { kind: "interval", wait: `next review after ${new Date(until).toISOString().slice(11, 16)}`, until };
    }
    return null;
  };
}

export const reviewHold = async (db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<ReviewHold | null> => await (await reviewHolds(db, nowMs, [`${repo}#${number}`]))(repo, number, head);
