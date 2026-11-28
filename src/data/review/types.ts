import type { PremergeFollowupRow } from "./premerge-followups.ts";
import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { RefKey } from "../mirror/types.ts";
import type { Blocking } from "../../premerge/types.ts";

export type { RefKey };

/** `repo#number@head`: the key of a loader result for one review row. */
export type HeadRef = string;
export type HeadKey = { repo: string; number: number; head: string };

/** One plan part of a review. */
export type ReviewFinding = { file: string; change: string; title?: string; major?: boolean; /** Absent: blocking (premerge/types.ts). */ blocking?: Blocking };
/**
 * What the review recommends: one sentence, and what a yes runs (the fixes it makes, by number from 1; whether it then merges or closes;
 * `backlog`: it keeps the item open with no work planned, for a hold that waits for other items; `author`: the PR is incomplete or wrong
 * and its author finishes it, asked at once; with `scope`, the hold is a question of scope a maintainer answers first, and their yes asks
 * the author). Parsed in review/opus-parse.ts.
 */
export type ReviewRecommendation = { text: string; fix: number[]; merge: boolean; close: boolean; backlog?: true; author?: true; scope?: true };
export type ReviewWorkflow = {
  /** `checked`: the note passed the reply checks at parse (review/opus-parse.ts); a note without it is never filed. */
  outside_purpose: { lines: number; note: string; checked?: true } | null; recommendation: ReviewRecommendation | null;
  /** Whether the author's commits since the approved head stay within the approval (review/opus-parse.ts). */
  author_commits?: { in_scope: boolean; note: string } | null;
  /** A hold's blocking class (review/opus-parse.ts); absent: blocking. */
  hold?: Blocking | null;
};
export type Verdict = "take" | "take-fix" | "hold" | "close";

/** An `opus_reviews` row with a verdict, JSON parsed once. */
export type ReviewRow = {
  repo: string; number: number; head: string; at: string; run_id: string | null; model: string | null;
  mode: "full" | "delta" | "carried"; base_head: string | null; base_ref: string | null;
  verdict: Verdict; sure: boolean; reason: string;
  fixes: ReviewFinding[]; risks: string[]; conflicts: { id: number; reason: string }[];
  blocked_by: RefKey[]; seen_at: string | null; disc_hash: string | null;
  public_summary: string | null;
  workflow: ReviewWorkflow | null;
};
/** The heavy columns, loaded on demand. */
export type ReviewTexts = { summary: string | null; why: string | null; public_review: string | null; claims: string | null; conflicts: string | null };
export type HistoryRow = {
  rowid: number; head: string; at: string; model: string | null; mode: string | null; verdict: string; sure: boolean; reason: string;
  summary: string | null; risks: string[]; fixes: ReviewFinding[]; claims: string | null; blocked_by: RefKey[]; trigger: string | null; job_id: number | null;
};
/** A stored history row of any review, one that gave no verdict included. */
export type StoredHistory = Omit<HistoryRow, "verdict"> & { verdict: string | null };
/** An `opus_reviews` row of any review, one that gave no verdict included, with its claims. */
export type StoredReview = Omit<ReviewRow, "verdict"> & { verdict: Verdict | null; claims: string | null };
export type ReviewPost = { repo: string; number: number; review_id: string; head: string; posted_at: string; edited_at: string | null; opus_at: string | null; posted_as: string | null };
/** The `review_state` row. */
export type ReviewMarks = { staleAt: string | null; rerunDay: string | null; rerunCount: number; failHead: string | null; failCount: number; failAt: string | null };
export type PremergeRow = Selectable<DB["premerge_reviews"]>;
export type Finding = { title: string; detail?: string; file?: string; line?: number; severity?: string; [k: string]: unknown };
export type PostmergeRow = { repo: string; number: number; merge_sha: string; at: string; model: string | null; run_id: string | null; findings: Finding[]; error: string | null; tries: number };
export type Followup = Selectable<DB["postmerge_followups"]>;
export type FollowupKey = { repo: string; number: number; review_at: string; finding: number };
/** What a claim writes: the follow-up key with the finding's title and the attempt number this try is. */
export type FollowupClaim = FollowupKey & { title: string; attempts: number };
export type PendingDefect = { repo: string; number: number; review_at: string; finding: number; f: Finding; model: string | null; attempts: number; note: string | null; /** Its row now. */ was: Followup | null };
/** A row in `filing`, with the create its claim began (null: none was begun, or GitHub refused it), and the issue that made when it is known. */
export type Filing = Followup & { create: { issue: { number: number; url: string } | null } | null };
export type DiscussionStat = { newest: string; maint: string; counted: { id: string; body: string | null }[] | null };
export type MirrorEntry = { id: string; kind: string | null; author: string | null; created_at: string | null; body: string | null; review_state: string | null; counted: boolean; maint: boolean };

export type ReviewFacts = {
  latest: Map<RefKey, ReviewRow>;
  unsureHeads: Set<HeadRef>;
  reviewsToday: Map<RefKey, { n: number; last: string | null }>;
  carriedChains: Map<RefKey, ReviewRow[]>;
  posts: Map<RefKey, ReviewPost>;
  premerge: Map<HeadRef, PremergeRow>;
  /** premerge_followups rows of each PR, oldest first. */
  premergeFollowups: Map<RefKey, PremergeFollowupRow[]>;
  /** review_followups rows of each PR, oldest first. */
  reviewFollowups: Map<RefKey, PremergeFollowupRow[]>;
  postmerge: Map<RefKey, { at: string; error: string | null }>;
  marks: Map<RefKey, ReviewMarks>;
  discussion: Map<RefKey, DiscussionStat>;
  blockerLatest: Map<RefKey, { verdict: Verdict; blocked_by: RefKey[] }>;
};
export type ReviewRecord = { latest: ReviewRow | null; /** One per reviewed head, newest first. */ reviews: StoredReview[]; history: StoredHistory[]; premerge: PremergeRow[]; postmerge: PostmergeRow | null; followups: Followup[]; post: ReviewPost | null };
export type ReviewSignature = { history: { n: number; newest: string | null }; reviews: { n: number; newest: string | null }; premerge: { n: number; newest: string | null; tries: number }; postmerge: { n: number; newest: string | null }; followups: string };
/** The stored columns of one feed row of `dash/api/activity.ts`; JSON columns stay text for the page to parse. */
export type ReviewEventRow =
  | { kind: "review"; repo: string; number: number; at: string; model: string | null; rowid: number; head_oid: string; mode: string | null; verdict: string | null; sure: number | null; reason: string | null; risks: string | null; fixes: string | null; claims: string | null }
  | { kind: "premerge"; repo: string; number: number; at: string; model: string | null; head_oid: string; findings: string | null; error: string | null; searched: string | null }
  | { kind: "postmerge"; repo: string; number: number; at: string; model: string | null; merge_sha: string; findings: string | null; error: string | null };

/** The parsed model reply of one review, as `opus-parse.ts` gives it (the ref and `blocked_by` are left out: `blockedBy` of the input is the reduced list). */
export type ReviewInput = {
  verdict: Verdict; sure: boolean; reason: string; fixes: ReviewFinding[]; risks: string[]; workflow?: ReviewWorkflow | null;
  summary: string | null; why: string | null; public: unknown | null; conflicts: unknown[]; claims: unknown[];
};
/** What the caller loaded for one review save (the module reads no GitHub or model data). `at` defaults to the clock at the call. */
export type SaveReviewInput = {
  runId: string | null; repo: string; number: number; head: string; mode: "full" | "delta" | "carried"; base: string | null; baseRef: string | null;
  defaultBranch: string | null; model: string | null; review: ReviewInput; snap?: { seen: string; hash: string | null }; blockedBy: RefKey[]; jobId: number | null; trigger?: string | null; at?: string;
};
export type SaveReviewResult = { repo: string; number: number; head: string; saved: boolean; rebased: boolean };
/** A stored review has `findings`; without them `error` records a failed try (`final`: no more tries). Empty `conflicts` and `claims` are stored as null. */
export type PremergeSave = {
  repo: string; number: number; head: string; at: string; runId?: string | null; model?: string | null;
  findings?: unknown[]; searched?: string | null; conflicts?: unknown[]; unsure?: boolean; claims?: unknown[]; baseRef?: string | null;
  error?: string | null; final?: boolean;
};
/** `findings` null with an `error`: a failed try. The skipped-minor and skipped-duplicate follow-up rows are derived from the findings. */
export type PostmergeSave = { repo: string; number: number; merge_sha: string; at: string; model: string | null; run_id: string | null; findings: Finding[] | null; error: string | null };
export type FollowupRow = Followup;
export type PostSave = ({ kind: "posted" } & ReviewPost) | { kind: "edited"; repo: string; number: number; head: string; edited_at: string; opus_at: string | null; posted_as: string | null };
