// The conflict step's candidate shape, tries and per-head bucket (the PRs come from their Plans, fixup/select.ts).
import { BASE_NAME, conflictNote as coreConflictNote } from "../core/rules.ts";
import { conflictAskRetryAtOf, conflictBucketOf, loadPatchFacts, mergesToday, triesIn, type ConflictBucket, type ConflictRow } from "../data/changes/index.ts";
import type { Db } from "../db/index.ts";

/** Base branch names the merge accepts as a fetch ref. */
export { BASE_NAME };

export const CONFLICT_STATES = ["pushing", "merged", "failed", "refused", "rejected", "asked", "comment-failed", "comment-unsent", "linting", "skipped", "cannot-push", "push-denied", "superseded"] as const;
export type ConflictState = (typeof CONFLICT_STATES)[number];

export type ConflictCandidate = {
  repo: string; number: number; head: string; /** The PR's base branch name. */ base: string; title: string;
  /** The final review's reason. */ reason: string; attempt: number; pushable: boolean;
  /** A model resolution stored and linted: the collect step pushes it, or gives it up. */
  lint?: { rowid: number; round: number; task: number | null; baseSha: string; resolved: string; files: string[]; /** The kept resolver sessions by file (src/prepush/resume.ts). */ session: string | null; /** The fix session turn that wrote it, or null. */ sessionTurn: number | null };
};
export { MAX_CONFLICT_TRIES, conflictAskRetryAtOf, conflictBucketOf, mergesToday, triesIn } from "../data/changes/index.ts";
export type { ConflictBucket, ConflictRow } from "../data/changes/index.ts";

/** The PR's conflict_merges rows, oldest first. */
async function conflictRows(db: Db, repo: string, number: number): Promise<ConflictRow[]> {
  return (await loadPatchFacts(db, [{ repo, number }])).get(`${repo}#${number}`)?.conflicts ?? [];
}

export async function conflictTries(db: Db, repo: string, number: number, head: string): Promise<number> {
  return triesIn(await conflictRows(db, repo, number), head);
}

export async function conflictMergesToday(db: Db, repo: string, number: number, nowMs: number = Date.now()): Promise<number> {
  return mergesToday(await conflictRows(db, repo, number), nowMs);
}

export async function conflictAskRetryAt(db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<number | undefined> {
  return conflictAskRetryAtOf(await conflictRows(db, repo, number), head, nowMs);
}

export async function conflictBucket(db: Db, p: { repo: string; number: number; head: string; pushable: boolean; uncapped?: boolean }, approvals: { push: boolean; comment: boolean }, nowMs: number = Date.now()): Promise<ConflictBucket> {
  return conflictBucketOf(await conflictRows(db, p.repo, p.number), p, approvals, nowMs);
}

export const conflictNote = (bucket: ConflictBucket, base: string): string | null => coreConflictNote(bucket, base);
