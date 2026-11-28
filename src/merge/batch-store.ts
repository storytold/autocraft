// Pure rules of the merge queue's integration batches (see batch.ts), and the batch reads other features call. The rows
// live in the merge module (src/data/merge).
import { cancelTasks } from "../data/build/index.ts";
import { getBatch as loadBatch, listBatchPage, loadBatchDue, loadBatchRun, loadBatchSizes, loadMergeFacts, loadPublishFailures, updateBatches } from "../data/merge/index.ts";
import { openItemKeys } from "../data/mirror/index.ts";
import type { HiddenRepos } from "../data/control/types.ts";
import type { BatchMember, BatchPatch, BatchRow, BatchView } from "../data/merge/types.ts";
import type { Db } from "../db/index.ts";

export { ACTIVE_BATCH, BATCH_STATES, BLOCKED_BY_REVIEW, CLOSED_BY_PERSON, MAX_BATCH, PUBLISH_FAILED, START_BATCH } from "../data/merge/types.ts";
export type { BatchMember, BatchRow, BatchState, BatchView } from "../data/merge/types.ts";
export { setBatchSize } from "../data/merge/index.ts";

/** Push or PR-creation failures after which a batch fails and its PRs go back to the queue, not on hold. */
export const MAX_PUBLISH_FAILURES = 5;
/** Wait before a batch whose push or PR creation failed is tried again: 1, 2, 4, 8 minutes, at most 30. */
export const publishDelayMs = (failures: number): number => (failures === 0 ? 0 : Math.min(60_000 * 2 ** (failures - 1), 30 * 60_000));
/**
 * Wait before a repo's next batch starts after batches in a row failed to push or open their PR (a GitHub outage, a refused push):
 * 30 minutes after the first, doubling up to 4 hours. Their PRs are back in the queue meanwhile; a batch PR that opens ends the run.
 */
export const publishBackoffMs = (failures: number): number => (failures <= 0 ? 0 : Math.min(30 * 60_000 * 2 ** (failures - 1), 4 * 3600_000));
/** How far back the publish failures of a run are read: older ones no longer lengthen the wait. */
const PUBLISH_BACKOFF_WINDOW_MS = 24 * 3600_000;
/** Wait before a batch's build task is queued again after a build-environment error: none for the first retry, then doubling from 5 minutes up to 30 minutes. */
export const retryDelayMs = (retries: number): number => (retries <= 0 ? 0 : Math.min(5 * 60_000 * 2 ** (retries - 1), 30 * 60_000));
/** Builds a batch's task may take, counting every try, before the batch PR opens without the build. */
export const MAX_BUILD_TRIES = 3;
/** How long a batch waits for its build task before the PR opens anyway. */
export const BUILD_MAX_MS = 3 * 3600_000;
/** Shown on a batch PR whose workflow runs wait for a maintainer's approval. */
export const RUNS_WAIT_NOTE = "batch PR runs wait for a maintainer's approval";
/** Changed lines (additions plus deletions) a batch may carry, beyond its first PR. */
export const MAX_BATCH_LINES = 10_000;

/** Most PRs the repo's next batch takes: grows by one after a passing batch, halves after a failed one. */
export async function batchSizeOf(db: Db, repo: string): Promise<number> {
  return (await loadBatchSizes(db, [repo])).get(repo)!;
}

export async function membersOf(db: Db, batchId: number): Promise<BatchMember[]> {
  return (await loadBatch(db, batchId))?.members ?? [];
}

export async function activeBatches(db: Db, repo: string): Promise<BatchView[]> {
  return (await loadBatchRun(db, repo)).active;
}

export async function getBatch(db: Db, id: number): Promise<BatchView> {
  return (await loadBatch(db, id))!;
}

export async function updateBatch(db: Db, id: number, at: string, set: BatchPatch): Promise<void> {
  await updateBatches(db, [{ id, at, set }]);
}

/** Cancels the build task of a batch that is ending before its build was read; a task that already ended is left alone. */
export async function cancelBuild(db: Db, b: BatchRow, by: string): Promise<void> {
  if (b.build_state !== "pending" || b.task_id === null) return;
  await cancelTasks(db, { ids: [b.task_id] }, by);
}

/** Whether the next candidate may join the PRs taken so far: up to `max` PRs and MAX_BATCH_LINES changed lines; an L-size PR goes alone. */
export function admits(taken: { size: string; lines: number }[], c: { size: string; lines: number }, max: number): boolean {
  if (taken.length === 0) return true;
  if (taken[0]!.size === "L" || taken.length >= max || c.size === "L") return false;
  return taken.reduce((a, t) => a + t.lines, 0) + c.lines <= MAX_BATCH_LINES;
}

/** Queue state each open PR head in an active or failed batch is in: `repo#number@head` → batch-checking | in-batch | batch-failed. */
export async function batchStates(db: Db, repo?: string): Promise<Map<string, "batch-checking" | "in-batch" | "batch-failed">> {
  return (await loadMergeFacts(db, openItemKeys({ kind: "pr", ...(repo === undefined ? {} : { repos: [repo] }) }))).batchStates;
}

/**
 * Repos with a batch that has something to do (a batch PR to watch, or a batch still to be pushed whose retry wait is over), each with the
 * members (`repo#number`) of those batches: the merge job reads their checks with the batch's.
 */
export async function batchesDue(db: Db, now = new Date()): Promise<Map<string, Set<string>>> {
  // No repo approval is read: a batch may hold only PRs people approved one by one, and each member's approval is checked before the batch's writes.
  const out = new Map<string, Set<string>>();
  for (const b of await loadBatchDue(db, now)) {
    const members = out.get(b.repo) ?? new Set<string>();
    for (const m of b.memberRefs) members.add(m);
    out.set(b.repo, members);
  }
  return out;
}

/** Per repo whose last batches failed to publish, when its next batch may start (ms); it may be in the past. */
export async function publishBackoffs(db: Db, now = new Date(), repos?: string[]): Promise<Map<string, number>> {
  const runs = await loadPublishFailures(db, new Date(now.getTime() - PUBLISH_BACKOFF_WINDOW_MS).toISOString(), repos);
  return new Map([...runs].map(([repo, r]) => [repo, Date.parse(r.at) + publishBackoffMs(r.count)] as const));
}

/** One page of batches, newest first (ids below `before`), with their members in order. */
export async function pageBatches(db: Db, o: { repo?: string; hidden?: HiddenRepos; before?: number; limit: number }): Promise<{ batches: (BatchRow & { prs: BatchMember[]; areas: string[] })[]; total: number; more: boolean }> {
  const page = await listBatchPage(db, o);
  return { ...page, batches: page.batches.map((b) => ({ ...b, prs: b.members })) };
}
