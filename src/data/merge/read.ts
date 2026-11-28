// Internal row readers shared by the merge loaders (not exported from index.ts).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import type { BatchMember, BatchState, BatchView, MergedInfo } from "./types.ts";
import { BLOCKED_BY_REVIEW, CLOSED_BY_PERSON, PUBLISH_FAILED } from "./types.ts";

export const refOf = (repo: string, number: number): string => `${repo}#${number}`;
export const headOf = (repo: string, number: number, head: string): string => `${repo}#${number}@${head}`;
export const short = (sha: string): string => sha.slice(0, 7);

/** Wait before a batch whose push or PR creation failed is tried again: 1, 2, 4, 8 minutes, at most 30. */
export const publishDelayMs = (failures: number): number => (failures === 0 ? 0 : Math.min(60_000 * 2 ** (failures - 1), 30 * 60_000));

/** A failed batch holds its PRs only when it failed for a reason that concerns the PRs. */
export const holdsMembers = (b: { summary: string | null; members: number }): boolean =>
  !b.summary?.startsWith(PUBLISH_FAILED) && (b.members === 1 || b.summary === CLOSED_BY_PERSON || b.summary === BLOCKED_BY_REVIEW);

type BatchRaw = Omit<BatchView, "members" | "state"> & { state: string; members: string | null };

/** `merge_batches b` with its members (in position order) as one JSON column. */
export function batchViews(db: Db) {
  const k = queryDb(db).k;
  return k.selectFrom("merge_batches as b").select((eb) => [
    "b.id", "b.repo", "b.branch", "b.state", "b.base_sha", "b.commit_sha", "b.parent_id", "b.task_id", "b.retries", "b.pr_number", "b.pr_url", "b.summary",
    "b.created_at", "b.updated_at", "b.fork", "b.build_state", "b.build_tries", "b.merge_sha", "b.ci_reruns", "b.ci_rerun_at", "b.opened_at", "b.topped_up", "b.below_id", "b.root_sha", "b.side",
    kx.jsonRows(db, eb.selectFrom("merge_batch_prs as bp").select(["bp.number", "bp.head_oid"]).whereRef("bp.batch_id", "=", "b.id").orderBy("bp.position")).as("members"),
  ]);
}

export function toBatchView(r: unknown): BatchView {
  const { members, ...rest } = r as BatchRaw;
  return { ...rest, state: rest.state as BatchState, members: kx.parseJsonRows<BatchMember>(members) } as BatchView;
}

type MergedRaw = { repo: string; number: number; head_oid: string; outcome: string; reason: string | null; at: string; method: string | null; first_at: string | null; is_last: number; is_last_merged: number; via_batch: number };

/**
 * Per ref in `keys` that the pipeline merged: the first merged time, the newest merged attempt (head, method, time) and the
 * newest attempt of any outcome. One statement; the windows order by `at`, then rowid, newest first.
 */
export async function mergedInfoOf(db: Db, keys: KeySource): Promise<Map<string, MergedInfo>> {
  const k = queryDb(db).k as any;
  const rows: MergedRaw[] = await queryDb(db).all(
    k.selectFrom((eb: any) => eb.selectFrom("merges as m")
      .innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "m.repo").onRef("kk.number", "=", "m.number"))
      .select((e: any) => [
        "m.repo", "m.number", "m.head_oid", "m.outcome", "m.reason", "m.at", "m.method",
        e.fn.min(e.case().when("m.outcome", "=", kx.literal("merged")).then(e.ref("m.at")).end()).over((o: any) => o.partitionBy(["m.repo", "m.number"])).as("first_at"),
        e.fn.agg("row_number").over((o: any) => o.partitionBy(["m.repo", "m.number"]).orderBy("m.at", "desc").orderBy(kx.rowid("merges", "m"), "desc")).as("rn_all"),
        e.fn.agg("row_number").over((o: any) => o.partitionBy(["m.repo", "m.number", e.case().when("m.outcome", "=", kx.literal("merged")).then(e.lit(1)).else(e.lit(0)).end()])
          .orderBy("m.at", "desc").orderBy(kx.rowid("merges", "m"), "desc")).as("rn_kind"),
      ]).as("t"))
      .select((eb: any) => [
        "t.repo", "t.number", "t.head_oid", "t.outcome", "t.reason", "t.at", "t.method", "t.first_at",
        eb.case().when("t.rn_all", "=", 1).then(1).else(0).end().as("is_last"),
        eb.case().when(eb.and([eb("t.outcome", "=", "merged"), eb("t.rn_kind", "=", 1)])).then(1).else(0).end().as("is_last_merged"),
        // A merged batch that carried the PR: its member rows are in `merges` as well, so the batch tables only say how it landed.
        eb.exists(eb.selectFrom("merge_batch_prs as bp").innerJoin("merge_batches as b", "b.id", "bp.batch_id").select(eb.lit(1).as("one"))
          .whereRef("b.repo", "=", "t.repo").whereRef("bp.number", "=", "t.number").where("b.state", "=", "merged")).as("via_batch"),
      ])
      .where("t.first_at", "is not", null)
      .where((eb: any) => eb.or([eb("t.rn_all", "=", 1), eb.and([eb("t.outcome", "=", "merged"), eb("t.rn_kind", "=", 1)])])),
  );
  const out = new Map<string, MergedInfo>();
  for (const r of rows) {
    const key = refOf(r.repo, r.number);
    const cur = out.get(key) ?? { firstAt: r.first_at!, lastAt: "", lastHead: "", method: null, viaBatch: !!r.via_batch, last: { outcome: "", reason: null } };
    if (r.is_last_merged) Object.assign(cur, { lastAt: r.at, lastHead: r.head_oid, method: r.method });
    if (r.is_last) cur.last = { outcome: r.outcome, reason: r.reason };
    out.set(key, cur);
  }
  return out;
}
