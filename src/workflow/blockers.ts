// The blockers of the maintainer workflow: when AutoCraft stops an item approved for merge and comes back to a person. The approval is
// the maintainer's merge button: AutoCraft makes every fix the merge needs, and comes back only where it cannot get there (a step that
// keeps failing, a fix it cannot make) or where the author's new commits need the approver's judgement. Pure: advance.ts reads the facts and
// records what this returns; the merge approval stays on the workflow row.
//
// Every detector looks only at what happened after `since`, up to when the person who last started or answered the item has seen it (an
// answer: when its question was asked): what they had seen then, they chose to go on with, so a yes after a blocker resumes instead of stopping again on the same evidence.
import { stopCodeOf, type StopCode } from "../core/codes.ts";
import type { Blocker, Entry } from "./types.ts";

export type BlockerFacts = {
  entry: Entry;
  approved: boolean;
  /** A push that is not ours moved the PR's head off the head the workflow last accepted (`base_head`). A PR's own workflow sends it to the review round instead (advance.ts), so it comes here as a blocker only for an issue's implementation PR. */
  authorPush: { from: string | null; to: string } | null;
  /** Steps whose tries failed since `since`, with how many failed. */
  failures: readonly { step: string; count: number }[];
  /** Jobs of the PR's own lane that failed in a row at its head, per job step (`lane`) and as the step is named; LANE_FAILS of them stop it. */
  laneFailures?: readonly { step: string; lane: string; count: number }[];
  /** The merge leg (the pre-approved merge) stopped or was cancelled since `since`, with its reason, and its code where the row has one. */
  leg: EndedLeg | null;
};

/** `fix`: the fix-up request the leg worked on. */
export type EndedLeg = { reason: string; code?: StopCode | null; head?: string | null; fix?: number | null };

/** Why the leg ended, its text's where the row has no code. */
export const codeOf = (leg: EndedLeg): StopCode => leg.code ?? stopCodeOf(leg.reason);

export type Found = { blocker: Blocker; params: Record<string, unknown> };

/** The steps of a PR's approved lane, as a failing step is named. */
export const LANE_STEPS: Record<string, string> = { "opus-review": "review", premerge: "pre-merge review", fixup: "fix-up", cifix: "CI fix" };

/** A step failing this many times stops the item (blocker 3). */
export const FAILED_TWICE = 2;
/** Failed jobs in a row of one step of the PR's own lane at one head that stop the item (advance.ts laneFailures). */
export const LANE_FAILS = 4;

const PREMERGE_STOP = /pre-merge review found/;

/** The stopped merge leg's reason is the pre-merge review's finding: its defects. An unsure review stops no workflow's merge leg. */
export const premergeStop = (leg: EndedLeg): boolean => (leg.code ? leg.code === "premerge-defect" : PREMERGE_STOP.test(leg.reason));

/** Stops a check of the leg's head made: what they found is about that head's code, not about a later head. */
const HEAD_CHECKS: readonly StopCode[] = ["premerge-defect", "premerge-failed", "ci-failed", "verification-failed", "verification-error", "review-hold", "review-close"];

/** The leg ended on a check of a head other than `head`. */
export const checkedOtherHead = (leg: EndedLeg, head: string): boolean => !!leg.head && leg.head !== head && HEAD_CHECKS.includes(codeOf(leg));

/**
 * Leg ends that are findings about the code: a review that says hold or close, the pre-merge review's defects past its own fix-up rounds, a
 * failed verification. On an approved item they are AutoCraft's to fix (advance.ts fixFirst), and the item goes on to the merge.
 */
const FIX_STOPS: readonly StopCode[] = ["review-hold", "review-close", "premerge-defect", "verification-failed"];

/** The ended leg stands for a finding AutoCraft fixes before the merge. */
export const fixesFirst = (leg: EndedLeg): boolean => FIX_STOPS.includes(codeOf(leg));

/** Leg ends of a fix-up that could not be made: it failed, grew too large, or cannot run. */
const FIX_FAILED: readonly StopCode[] = ["fix-failed", "fix-too-large", "fix-cannot-run"];

/** The ended leg stopped because a fix-up could not be made. */
export const fixUnmade = (leg: EndedLeg): boolean => FIX_FAILED.includes(codeOf(leg));

/**
 * The blocker a stopped merge leg (src/preapproval) stands for, when it is no finding to fix: the author's push, a fix-up that could not be
 * made (a step that failed: `failed-twice`), or `other` for what only a person can settle, shown with its reason.
 */
export function legBlocker(leg: EndedLeg): Found {
  const code = codeOf(leg);
  if (code === "author-push" || code === "head-back") return { blocker: "author-commits", params: { reason: leg.reason } };
  if (fixUnmade(leg)) return { blocker: "failed-twice", params: { step: "fix-up", reason: leg.reason } };
  return { blocker: "other", params: { reason: leg.reason } };
}

/**
 * The first blocker that applies, in the order a person needs them: someone else's commits first (everything after rests on code
 * nobody reviewed), then a step that keeps failing, then what stopped the merge leg, unless it is a finding AutoCraft fixes. An item not
 * approved comes back with its recommendation anyway, so only a failing step stops it early.
 */
export function detectBlocker(f: BlockerFacts): Found | null {
  const tried = f.failures.find((x) => x.count >= FAILED_TWICE), jobs = f.laneFailures?.find((x) => x.count >= LANE_FAILS);
  const failed: Found | null = tried ? { blocker: "failed-twice", params: { step: tried.step, count: tried.count } }
    : jobs ? { blocker: "failed-twice", params: { step: jobs.step, count: jobs.count, lane: jobs.lane } } : null;
  if (!f.approved) return failed;
  if (f.authorPush) return { blocker: "author-commits", params: { from: f.authorPush.from, to: f.authorPush.to } };
  if (failed) return failed;
  if (f.leg && !fixesFirst(f.leg)) return legBlocker(f.leg);
  return null;
}
