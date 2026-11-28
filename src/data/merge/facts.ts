// The planner's merge facts (package merge-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { finalTakeAtLatestHead, premergeClean } from "../review/fragments.ts";
import { handedOverAt } from "../workflow/fragments.ts";
import { batchViews, headOf, holdsMembers, mergedInfoOf, refOf, toBatchView } from "./read.ts";
import { ACTIVE_BATCH } from "./types.ts";
import type { BatchMembership, BatchOfPr, MergeAttempt, MergeFacts, RefKey, RunApproval, UnknownState, VerificationFact, VerificationState, WaitingRun } from "./types.ts";

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  try { return text ? (JSON.parse(text) as T) : fallback; } catch { return fallback; }
};

/**
 * Every merge fact the planner needs for `keys`: attempts, merged history, verifications, run approvals, unknown state, batch
 * membership, screenshot regressions. 8 statements in one `together` wave whatever the key count. An integration PR's `membersReviewed` is true while every member
 * has a final take or take-fix review at its batched head, or is approved for merge and handed over there with a clean pre-merge review.
 */
export async function loadMergeFacts(db: Db, keys: KeySource): Promise<MergeFacts> {
  const q = queryDb(db);
  const k = q.k as any;
  const onKey = (alias: string) => (j: any) => j.onRef("kk.repo", "=", `${alias}.repo`).onRef("kk.number", "=", `${alias}.number`);
  const [attempts, merged, verifs, runs, unknown, batches, batchPrs, regressions] = await db.together(() => Promise.all([
    // The newest attempt at each head and the refusals there.
    q.all(k.selectFrom((eb: any) => eb.selectFrom("merges as m").innerJoin(resolveKeys(db, keys, "kk"), onKey("m"))
      .select((e: any) => [
        "m.repo", "m.number", "m.head_oid", "m.outcome", "m.reason", "m.ci", "m.mergeable", "m.at", "m.path", "m.method",
        e.fn.agg("row_number").over((o: any) => o.partitionBy(["m.repo", "m.number", "m.head_oid"]).orderBy("m.at", "desc").orderBy(kx.rowid("merges", "m"), "desc")).as("rn"),
        e.fn.sum(e.case().when("m.outcome", "=", kx.literal("refused")).then(e.lit(1)).else(e.lit(0)).end()).over((o: any) => o.partitionBy(["m.repo", "m.number", "m.head_oid"])).as("refusals"),
      ]).as("t")).selectAll().where("rn", "=", 1)) as Promise<any[]>,
    mergedInfoOf(db, keys),
    q.all(k.selectFrom("verifications as v").innerJoin(resolveKeys(db, keys, "kk"), onKey("v"))
      .select(["v.repo", "v.number", "v.head_sha", "v.state", "v.kind", "v.summary", "v.note", "v.finished_at", "v.errors"])) as Promise<any[]>,
    q.all(k.selectFrom("ci_run_approvals as a").innerJoin(resolveKeys(db, keys, "kk"), onKey("a"))
      .select(["a.repo", "a.number", "a.head_oid", "a.runs", "a.approved", "a.reread", "a.failed", "a.cross_repo", "a.checked_at", "a.approved_at"])) as Promise<any[]>,
    q.all(k.selectFrom("merge_state as s").innerJoin(resolveKeys(db, keys, "kk"), onKey("s"))
      .select(["s.repo", "s.number", "s.head", "s.since", "s.reads", "s.rereads", "s.stuck"])) as Promise<any[]>,
    // Batches whose PR or any member is in the keys. A member's repo is its batch's repo.
    q.all(batchViews(db)
      .select((eb) => eb.case().when(eb.not(eb.exists(eb.selectFrom("merge_batch_prs as mr").select(eb.lit(1).as("one")).whereRef("mr.batch_id", "=", "b.id")
        .where((w) => w.not(w.or([
          finalTakeAtLatestHead(w, "b.repo", "mr.number", "mr.head_oid"),
          w.and([handedOverAt(w, "b.repo", "mr.number", "mr.head_oid"), premergeClean(db, w, "b.repo", "mr.number", "mr.head_oid")]),
        ])))))).then(1).else(0).end().as("members_reviewed"))
      .where("b.state", "in", [...ACTIVE_BATCH, "failed"]).where((eb: any) => eb.or([
      eb.exists(eb.selectFrom("merge_batch_prs as bp").innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "b.repo").onRef("kk.number", "=", "bp.number"))
        .select(eb.lit(1).as("one")).whereRef("bp.batch_id", "=", "b.id")),
      eb.exists(eb.selectFrom(resolveKeys(db, keys, "kk")).select(eb.lit(1).as("one")).whereRef("kk.repo", "=", "b.repo").whereRef("kk.number", "=", "b.pr_number")),
    ])).orderBy("b.id")) as Promise<unknown[]>,
    q.all(k.selectFrom("merge_batches as b").innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "b.repo").onRef("kk.number", "=", "b.pr_number")).select(["b.repo", "b.pr_number"])) as Promise<any[]>,
    q.all(k.selectFrom("screenshot_runs as s").innerJoin(resolveKeys(db, keys, "kk"), onKey("s")).where("s.held", "=", 1)
      .select(["s.repo", "s.number", "s.head_sha", "s.comparison", "s.finished_at"])) as Promise<any[]>,
  ]));

  const facts: MergeFacts = {
    attempts: new Map(), merged, verifications: new Map(), runs: new Map(), unknown: new Map(), batchStates: new Map(), batchFailedAt: new Map(), regressions: new Map(),
    activeBatched: new Set(), integration: new Map(), batchPrs: new Set(batchPrs.map((r) => refOf(r.repo, r.pr_number))),
  };
  for (const r of attempts) {
    facts.attempts.set(headOf(r.repo, r.number, r.head_oid), { outcome: r.outcome, reason: r.reason, ci: r.ci, mergeable: r.mergeable, at: r.at, refusals: Number(r.refusals), path: r.path, method: r.method } as MergeAttempt);
  }
  for (const r of verifs) {
    facts.verifications.set(headOf(r.repo, r.number, r.head_sha), { head: r.head_sha, state: r.state as VerificationState, kind: r.kind, summary: r.summary, note: r.note, finishedAt: r.finished_at, errors: Number(r.errors ?? 0) } satisfies VerificationFact);
  }
  for (const r of runs) {
    facts.runs.set(headOf(r.repo, r.number, r.head_oid), {
      head: r.head_oid, runs: parse<WaitingRun[]>(r.runs, []), approved: parse<number[]>(r.approved, []), reread: !!r.reread, failed: parse<Record<string, number>>(r.failed, {}),
      crossRepo: !!r.cross_repo, checkedAt: r.checked_at, approvedAt: r.approved_at,
    } satisfies RunApproval);
  }
  for (const r of regressions) facts.regressions.set(headOf(r.repo, r.number, r.head_sha), { summary: r.comparison, at: r.finished_at ?? "" });
  for (const r of unknown) facts.unknown.set(refOf(r.repo, r.number), { head: r.head, since: r.since, reads: r.reads, rereads: r.rereads, stuck: !!r.stuck } satisfies UnknownState);

  const wanted = new Set<string>();
  if (Array.isArray(keys)) for (const r of keys) wanted.add(refOf(r.repo, r.number));
  for (const raw of batches) {
    const b = toBatchView(raw);
    const active = b.state === "checking" || b.state === "open";
    if (b.state === "failed" && !holdsMembers({ summary: b.summary, members: b.members.length })) continue;
    for (const m of b.members) {
      const ref = refOf(b.repo, m.number);
      // Lists are filtered here; a descriptor was resolved inside the statement, so every member of a matched batch is kept.
      if (Array.isArray(keys) && !wanted.has(ref)) continue;
      facts.batchStates.set(headOf(b.repo, m.number, m.head_oid), b.state === "checking" ? "batch-checking" : b.state === "open" ? "in-batch" : "batch-failed");
      if (b.state === "failed") facts.batchFailedAt.set(headOf(b.repo, m.number, m.head_oid), b.updated_at);
      if (active) facts.activeBatched.add(ref);
    }
    if (active && b.pr_number !== null) {
      const ref = refOf(b.repo, b.pr_number);
      if ((!Array.isArray(keys) || wanted.has(ref)) && !facts.integration.has(ref)) {
        const membersReviewed = Number((raw as { members_reviewed: unknown }).members_reviewed) === 1;
        facts.integration.set(ref, { id: b.id, repo: b.repo, branch: b.branch, state: b.state, commitSha: b.commit_sha, prNumber: b.pr_number, members: b.members, membersReviewed } satisfies BatchOfPr);
      }
    }
  }
  return facts;
}

/** The active batch of each PR in `keys`. 1 statement. */
export async function loadBatchMembership(db: Db, keys: KeySource): Promise<Map<RefKey, BatchMembership>> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("merge_batch_prs as bp").innerJoin("merge_batches as b", "b.id", "bp.batch_id")
    .innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "b.repo").onRef("kk.number", "=", "bp.number"))
    .select(["b.repo", "bp.number", "b.id", "b.state", "b.branch", "b.pr_number"]).where("b.state", "in", ACTIVE_BATCH).orderBy("b.id")) as { repo: string; number: number; id: number; state: string; branch: string; pr_number: number | null }[];
  const out = new Map<RefKey, BatchMembership>();
  for (const r of rows) {
    const ref = refOf(r.repo, r.number);
    if (!out.has(ref)) out.set(ref, { batchId: r.id, state: r.state, branch: r.branch, prNumber: r.pr_number });
  }
  return out;
}

/** Integration PRs we opened, optionally of some repos. 1 statement. */
export async function loadOwnIntegration(db: Db, repos?: string[]): Promise<Set<RefKey>> {
  if (repos && repos.length === 0) return new Set();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("merge_batches as b").select(["b.repo", "b.pr_number"]).where("b.pr_number", "is not", null).distinct()
    .$if(!!repos, (s) => s.where(kx.inList(db, "b.repo", repos!)))) as { repo: string; pr_number: number }[];
  return new Set(rows.map((r) => refOf(r.repo, r.pr_number)));
}
