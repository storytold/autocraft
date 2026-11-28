// Batches (`merge_batches`, `merge_batch_prs`, `merge_repo_state`) (package merge-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "../control/index.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { applyLocal } from "../mirror/index.ts";
import { addStageEvents } from "../planner/index.ts";
import { loadItemAreas } from "../triage/index.ts";
import { batchViews, headOf, holdsMembers, publishDelayMs, refOf, short, toBatchView } from "./read.ts";
import { ACTIVE_BATCH, MAX_BATCH, PUBLISH_FAILED, START_BATCH } from "./types.ts";
import type { BatchByTask, BatchDue, BatchEnd, BatchLanded, BatchListRow, BatchPageView, BatchRun, BatchState, BatchUpdate, BatchView, HeadRef, HiddenRepos, NewBatch } from "./types.ts";

const sizeOf = (n: number | undefined): number => (n !== undefined && Number.isInteger(n) && n >= 1 && n <= MAX_BATCH ? n : START_BATCH);
const filtered = (h: HiddenRepos | undefined): h is HiddenRepos => !!h && (!!h.visible || h.length > 0);

/** Active batches of the repo with members, and the repo's batch size. 2 statements in one wave. */
export async function loadBatchRun(db: Db, repo: string): Promise<BatchRun> {
  const q = queryDb(db);
  const [rows, size] = await db.together(() => Promise.all([
    q.all(batchViews(db).where("b.repo", "=", repo).where("b.state", "in", ACTIVE_BATCH).orderBy("b.id")),
    q.get(q.k.selectFrom("merge_repo_state").select("batch_size").where("repo", "=", repo)),
  ]));
  return { active: rows.map(toBatchView), size: sizeOf(size?.batch_size) };
}

/** Batches by id, with members. 1 statement. */
export async function loadBatches(db: Db, ids: number[]): Promise<Map<number, BatchView>> {
  if (ids.length === 0) return new Map();
  const rows = await queryDb(db).all(batchViews(db).where(kx.inList(db, "b.id", ids, "bigint")));
  return new Map(rows.map((r) => [r.id, toBatchView(r)]));
}

/** One-key wrapper over `loadBatches`. */
export async function getBatch(db: Db, id: number): Promise<BatchView | undefined> {
  return (await loadBatches(db, [id])).get(id);
}

/** The id of the batch with that branch. */
export async function loadBatchByBranch(db: Db, repo: string, branch: string): Promise<number | undefined> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("merge_batches").select("id").where("repo", "=", repo).where("branch", "=", branch).orderBy("id", "desc").limit(1)))?.id;
}

/** Child batches (split from `id`), newest first. */
export async function loadBatchChildren(db: Db, id: number): Promise<{ id: number; createdAt: string }[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("merge_batches").select(["id", "created_at"]).where("parent_id", "=", id).orderBy("id", "desc"))).map((r) => ({ id: r.id, createdAt: r.created_at }));
}

/** The batch, its parent's state and its children in one statement. */
export async function loadBatchPage(db: Db, id: number): Promise<BatchPageView | null> {
  const q = queryDb(db);
  const r = await q.get(batchViews(db).where("b.id", "=", id).select((eb) => [
    eb.selectFrom("merge_batches as p").select("p.state").whereRef("p.id", "=", "b.parent_id").as("parent_state"),
    kx.jsonRows(db, eb.selectFrom("merge_batches as c").select(["c.id", "c.created_at"]).whereRef("c.parent_id", "=", "b.id").orderBy("c.id", "desc")).as("children"),
  ]));
  if (!r) return null;
  const { parent_state, children, ...batch } = r;
  return {
    batch: toBatchView(batch), parent: (parent_state as BatchState | null) ?? null,
    children: kx.parseJsonRows<{ id: number; created_at: string }>(children).map((c) => ({ id: c.id, createdAt: c.created_at })),
  };
}

/** Active batches with members, optionally of some repos and not hidden. 1 statement. */
export async function listActiveBatches(db: Db, f: { repos?: string[]; hidden?: HiddenRepos }): Promise<BatchView[]> {
  if (f.repos && f.repos.length === 0) return [];
  const rows = await queryDb(db).all(batchViews(db).where("b.state", "in", ACTIVE_BATCH)
    .$if(!!f.repos, (s) => s.where(kx.inList(db, "b.repo", f.repos!)))
    .$if(filtered(f.hidden), (s) => s.where(hiddenRepos(db, "b.repo", f.hidden!)))
    .orderBy("b.id"));
  return rows.map(toBatchView);
}

/** A page of batches with members and areas: wave 1 count and page, wave 2 `triage.loadItemAreas`. */
export async function listBatchPage(db: Db, o: { repo?: string; hidden?: HiddenRepos; before?: number; limit: number }): Promise<{ batches: BatchListRow[]; total: number; more: boolean }> {
  const q = queryDb(db);
  const [count, rows] = await db.together(() => Promise.all([
    q.get(q.k.selectFrom("merge_batches as b").select((eb) => eb.fn.countAll<number>().as("n"))
      .$if(!!o.repo, (s) => s.where("b.repo", "=", o.repo!)).$if(filtered(o.hidden), (s) => s.where(hiddenRepos(db, "b.repo", o.hidden!)))),
    q.all(batchViews(db).$if(!!o.repo, (s) => s.where("b.repo", "=", o.repo!)).$if(filtered(o.hidden), (s) => s.where(hiddenRepos(db, "b.repo", o.hidden!)))
      .$if(o.before !== undefined, (s) => s.where("b.id", "<", o.before!)).orderBy("b.id", "desc").limit(o.limit + 1)),
  ]));
  const page = rows.slice(0, o.limit).map(toBatchView);
  const refs = page.flatMap((b) => b.members.map((m) => ({ repo: b.repo, number: m.number })));
  const areaOf = refs.length ? await loadItemAreas(db, refs) : new Map<string, { area: string | null }>();
  // The members' areas, each once, in batch order: the first is the area the batch was filled around.
  const areasOf = (b: BatchView): string[] => [...new Set(b.members.flatMap((m) => areaOf.get(refOf(b.repo, m.number))?.area ?? []))];
  return { batches: page.map((b) => ({ ...b, areas: areasOf(b) })), total: Number(count?.n ?? 0), more: rows.length > o.limit };
}

/** The batch of each build task id. 1 statement. */
export async function loadBatchesByTask(db: Db, taskIds: number[]): Promise<Map<number, BatchByTask>> {
  if (taskIds.length === 0) return new Map();
  const rows = await queryDb(db).all(batchViews(db).where(kx.inList(db, "b.task_id", taskIds, "bigint")).orderBy("b.id", "desc"));
  const out = new Map<number, BatchByTask>();
  for (const r of rows) {
    const b = toBatchView(r);
    if (!out.has(b.task_id!)) out.set(b.task_id!, { id: b.id, repo: b.repo, branch: b.branch, commitSha: b.commit_sha, baseSha: b.base_sha, fork: b.fork, members: b.members.map((m) => m.number) });
  }
  return out;
}

/** Active batches that are open, or checking and past their retry wait, with member refs. */
export async function loadBatchDue(db: Db, now: Date): Promise<BatchDue[]> {
  const rows = (await queryDb(db).all(batchViews(db).where("b.state", "in", ACTIVE_BATCH).orderBy("b.id"))).map(toBatchView);
  return rows.filter((b) => b.state === "open" || now.getTime() - Date.parse(b.updated_at) >= publishDelayMs(b.retries))
    .map((b) => ({ repo: b.repo, id: b.id, memberRefs: b.members.map((m) => refOf(b.repo, m.number)) }));
}

/**
 * Per repo, the publish failures since its last batch PR opened, from the batches updated since `since` (newest first): how many
 * batches in a row failed to push or open their PR, and when the newest of them ended. 1 statement.
 */
export async function loadPublishFailures(db: Db, since: string, repos?: string[]): Promise<Map<string, { count: number; at: string }>> {
  if (repos && repos.length === 0) return new Map();
  const q = queryDb(db);
  // Only the batches that count are read: the failed ones and the ones whose PR opened (merge_batches_updated bounds the range).
  const rows = await q.all(q.k.selectFrom("merge_batches as b").select(["b.repo", "b.state", "b.summary", "b.pr_number", "b.updated_at"])
    .where("b.updated_at", ">=", since).where((eb) => eb.or([eb("b.state", "=", "failed"), eb("b.pr_number", "is not", null)]))
    .$if(!!repos, (s) => s.where(kx.inList(db, "b.repo", repos!))).orderBy("b.id", "desc"));
  const out = new Map<string, { count: number; at: string }>(), done = new Set<string>();
  for (const r of rows) {
    if (done.has(r.repo)) continue;
    // A batch whose PR opened ends the run of failures; a batch that failed before it had a PR for another reason does not count.
    if (r.pr_number !== null) { done.add(r.repo); continue; }
    if (r.state !== "failed" || !r.summary?.startsWith(PUBLISH_FAILED)) continue;
    const o = out.get(r.repo);
    if (o) o.count++;
    else out.set(r.repo, { count: 1, at: r.updated_at });
  }
  return out;
}

/** Opens a batch in one `db.write`: branch name, batch row, member rows and the `batch-start` audit row. */
export async function openBatch(db: Db, b: NewBatch): Promise<{ id: number; branch: string }> {
  const q = queryDb(db);
  return await db.write(async () => {
    const prefix = `integration-${b.repo}-${b.at.slice(0, 10).replace(/-/g, "")}-`;
    const n = (await q.get(q.k.selectFrom("merge_batches").select((eb) => eb.fn.countAll<number>().as("n")).where("repo", "=", b.repo)
      .where((eb) => kx.like(db, "branch", eb.val(`${prefix}%`)))))!.n;
    const branch = `${prefix}${Number(n) + 1}`;
    const row = (await q.get(q.k.insertInto("merge_batches").values({
      repo: b.repo, branch, state: "checking", base_sha: b.baseSha, commit_sha: b.commitSha, parent_id: b.parentId, task_id: b.taskId, created_at: b.at, updated_at: b.at,
      build_state: b.build, build_tries: b.build === "pending" ? 1 : 0, topped_up: b.toppedUp ? 1 : 0, opened_at: b.openedAt ?? null,
    }).returning("id")))!;
    const id = Number(row.id);
    for (const values of kx.batches(b.members.map((m, i) => ({ batch_id: id, repo: b.repo, number: m.number, head_oid: m.head_oid, position: i }))))
      await q.run(q.k.insertInto("merge_batch_prs").values(values));
    await addAudit(db, [{ login: "batch", action: "batch-start", target: `${b.repo}:${branch}`, at: b.at, details: { run: b.runId, base: b.baseSha, prs: b.prs } }]);
    return { id, branch };
  });
}

const COLUMN_TYPE = {
  state: "text", commit_sha: "text", base_sha: "text", task_id: "bigint", retries: "bigint", pr_number: "bigint", pr_url: "text", summary: "text",
  fork: "text", merge_sha: "text", build_state: "text", build_tries: "bigint", ci_reruns: "bigint", ci_rerun_at: "text", opened_at: "text",
} as const satisfies Record<string, kx.ElemType>;

type Changed = { id: number; repo: string; branch: string };

/** The updates of `updateBatches`, returning each changed batch's repo and branch. */
async function applyUpdates(db: Db, rows: BatchUpdate[]): Promise<Changed[]> {
  if (rows.length === 0) return [];
  const q = queryDb(db);
  const k = q.k as any;
  const byId = new Map<number, BatchUpdate>();
  for (const r of rows) {
    const prev = byId.get(r.id);
    byId.set(r.id, prev ? { ...r, set: { ...prev.set, ...r.set }, size: r.size ?? prev.size, onlyIf: r.onlyIf ?? prev.onlyIf } : r);
  }
  const groups = new Map<string, BatchUpdate[]>();
  for (const r of byId.values()) {
    const shape = `${Object.keys(r.set).sort().join(",")}|${(r.onlyIf ?? []).slice().sort().join(",")}`;
    (groups.get(shape) ?? groups.set(shape, []).get(shape)!).push(r);
  }
  const changed: Changed[] = [];
  for (const group of groups.values()) {
    const cols = Object.keys(group[0]!.set) as (keyof typeof COLUMN_TYPE)[];
    const only = group[0]!.onlyIf;
    for (const chunk of kx.chunks(group)) {
      const v = kx.valuesTable(db, chunk.map((r) => ({ id: r.id, at: r.at, ...(r.set as Record<string, string | number | null>) })),
        { id: "bigint", at: "text", ...Object.fromEntries(cols.map((c) => [c, COLUMN_TYPE[c]])) }, "v");
      changed.push(...(await q.all(k.updateTable("merge_batches").from(v)
        .set((eb: any) => ({ ...Object.fromEntries(cols.map((c) => [c, eb.ref(`v.${c}`)])), updated_at: eb.ref("v.at") }))
        .where((eb: any) => eb.and([eb("merge_batches.id", "=", eb.ref("v.id")), ...(only ? [eb("merge_batches.state", "in", only)] : [])]))
        .returning(["merge_batches.id as id", "merge_batches.repo as repo", "merge_batches.branch as branch"])) as Changed[]));
    }
  }
  const ids = new Set(changed.map((c) => c.id));
  const sizes = [...byId.values()].filter((r) => r.size && ids.has(r.id));
  if (sizes.length) await resizeRepos(db, sizes.map((r) => ({ repo: changed.find((c) => c.id === r.id)!.repo, op: r.size!, at: r.at })));
  return changed;
}

/** Grows (+1, at most MAX_BATCH) or shrinks (halves, at least 1) each repo's batch size; a repo with no row starts from START_BATCH. */
async function resizeRepos(db: Db, ops: { repo: string; op: "grow" | "shrink"; at: string }[]): Promise<void> {
  const q = queryDb(db);
  const at = ops[ops.length - 1]!.at;
  const repos = [...new Set(ops.map((o) => o.repo))];
  for (const values of kx.batches(repos.map((repo) => ({ repo, batch_size: START_BATCH, updated_at: at }))))
    await q.run(q.k.insertInto("merge_repo_state").values(values).onConflict((oc) => oc.column("repo").doNothing()));
  const count = (op: "grow" | "shrink") => {
    const m = new Map<string, number>();
    for (const o of ops) if (o.op === op) m.set(o.repo, (m.get(o.repo) ?? 0) + 1);
    return m;
  };
  for (const [op, counts] of [["grow", count("grow")], ["shrink", count("shrink")]] as const) {
    for (let level = 0; ; level++) {
      const due = [...counts].filter(([, n]) => n > level).map(([repo]) => repo);
      if (due.length === 0) break;
      await q.run(q.k.updateTable("merge_repo_state").set((eb) => ({
        batch_size: (op === "grow" ? kx.least(db, [kx.literal(MAX_BATCH), eb("batch_size", "+", eb.lit(1))]) : kx.greatest(db, [kx.literal(1), eb("batch_size", "/", eb.lit(2))])) as any,
        updated_at: at,
      })).where(kx.inList(db, "repo", due)));
    }
  }
}

/** Updates batches with `kx.updateFrom`; `onlyIf` is the compare-and-set, `size` grows or shrinks the repo's batch size. Returns the ids changed. */
export async function updateBatches(db: Db, rows: BatchUpdate[]): Promise<number[]> {
  if (rows.length === 0) return [];
  return (await db.write(async () => await applyUpdates(db, rows))).map((c) => c.id);
}

/** Ends batches in one `db.write`: the batch rows, stage events and audit rows. */
export async function endBatches(db: Db, rows: BatchEnd[]): Promise<void> {
  if (rows.length === 0) return;
  await db.write(async () => {
    const at = new Date().toISOString();
    // A control that already ended the batch wins over a supersede or fail; a merge that landed meanwhile always records.
    const changed = await applyUpdates(db, rows.map((r) => ({ id: r.id, at, set: { state: r.state, summary: r.summary }, ...(r.state === "merged" ? {} : { onlyIf: ACTIVE_BATCH }) })));
    const done = new Set(changed.map((c) => c.id));
    const ended = rows.filter((r) => done.has(r.id));
    const stages = ended.flatMap((r) => r.stage ?? []);
    if (stages.length) await addStageEvents(db, stages);
    const audits = ended.flatMap((r) => r.audit ?? []).map((a) => ({ login: a.actor, action: a.action, target: a.target, at: a.at, details: a.details }));
    if (audits.length) await addAudit(db, audits);
  });
}

/** Records a landed batch: batch to `merged`, member `merges` rows, size growth, mirror write-through, stage events and audit. Max 8 statements. */
export async function recordLanded(db: Db, r: BatchLanded): Promise<{ was: BatchState }> {
  const q = queryDb(db);
  return await db.write(async () => {
    // A control may have ended the batch while the merge ran: the merge still happened, so the row says so and the audit shows the order of events.
    const b = await q.get(q.k.selectFrom("merge_batches").select(["repo", "branch", "state"]).where("id", "=", r.batchId));
    if (!b) throw new Error(`no batch ${r.batchId}`);
    const was = b.state as BatchState;
    await applyUpdates(db, [{ id: r.batchId, at: r.at, set: { state: "merged", summary: null, ...(r.mergeSha ? { merge_sha: r.mergeSha } : {}) }, size: "grow" }]);
    for (const values of kx.batches(r.members.map((m) => ({ repo: b.repo, number: m.number, head_oid: m.head, run_id: r.runId, at: r.at, path: m.path, method: "merge", outcome: "merged", reason: null, ci: m.ci ?? "success", mergeable: m.mergeable ?? "MERGEABLE" }))))
      await q.run(q.k.insertInto("merges").values(values));
    if (r.members.length) {
      await applyLocal(db, r.members.map((m) => ({ kind: "merged" as const, repo: b.repo, number: m.number, at: r.at })));
      await addStageEvents(db, r.members.map((m) => ({ repo: b.repo, number: m.number, stage: "merged", at: r.at, actor: r.by, note: `merge in ${b.branch} at ${short(m.head)}` })));
    }
    await addAudit(db, [
      ...(ACTIVE_BATCH.includes(was) ? [] : [{ login: r.by, action: "batch-merged-after-end", target: `${b.repo}:${b.branch}`, at: r.at, details: { run: r.runId, was, prs: r.members.map((m) => m.number) } }]),
      ...r.members.map((m) => ({ login: r.by, action: "merge", target: refOf(b.repo, m.number), at: r.at, details: { run: r.runId, head: m.head, method: "merge", batch: b.branch } })),
    ]);
    return { was };
  });
}

/** Sets the repo's batch size. */
export async function setBatchSize(db: Db, repo: string, n: number, _by?: string): Promise<number> {
  const size = Math.max(1, Math.min(MAX_BATCH, n));
  const q = queryDb(db);
  await q.run(q.k.insertInto("merge_repo_state").values({ repo, batch_size: size, updated_at: new Date().toISOString() })
    .onConflict((oc) => oc.column("repo").doUpdateSet(kx.excluded(["batch_size", "updated_at"]))));
  return size;
}

/** Batch sizes per repo; a requested repo with no row gets the starting size. */
export async function loadBatchSizes(db: Db, repos?: string[]): Promise<Map<string, number>> {
  const q = queryDb(db);
  const rows = repos && repos.length === 0 ? [] : await q.all(q.k.selectFrom("merge_repo_state").select(["repo", "batch_size"]).$if(!!repos, (s) => s.where(kx.inList(db, "repo", repos!))));
  const out = new Map(rows.map((r) => [r.repo, sizeOf(r.batch_size)] as const));
  for (const repo of repos ?? []) if (!out.has(repo)) out.set(repo, START_BATCH);
  return out;
}

type HeadKeyRow = { repo: string; number: number; head: string };

/** The failed batch holding each head of `keys`; a key without a head stands for every head of the PR. */
async function failedHolding(db: Db, keys: (Omit<HeadKeyRow, "head"> & { head?: string })[]): Promise<Map<HeadRef, { id: number; summary: string | null }>> {
  if (keys.length === 0) return new Map();
  const q = queryDb(db);
  const heads = keys.filter((k): k is HeadKeyRow => k.head !== undefined), refs = keys.filter((k) => k.head === undefined);
  const rows = await q.all(q.k.selectFrom("merge_batches as b").innerJoin("merge_batch_prs as bp", "bp.batch_id", "b.id")
    .select((eb) => ["b.id", "b.repo", "b.summary", "bp.number", "bp.head_oid", eb.selectFrom("merge_batch_prs as q").select(eb.fn.countAll<number>().as("n")).whereRef("q.batch_id", "=", "b.id").as("members")])
    .where("b.state", "=", "failed")
    .where((eb) => eb.or([
      ...(heads.length ? [kx.tupleIn(db, [eb.ref("b.repo"), eb.ref("bp.number"), eb.ref("bp.head_oid")], heads.map((k) => [k.repo, k.number, k.head]), ["text", "bigint", "text"])] : []),
      ...(refs.length ? [kx.tupleIn(db, [eb.ref("b.repo"), eb.ref("bp.number")], refs.map((k) => [k.repo, k.number]), ["text", "bigint"])] : []),
    ]))
    .orderBy("b.id"));
  const out = new Map<HeadRef, { id: number; summary: string | null }>();
  // Ascending ids, so a later (newer) batch replaces an older one at the same head.
  for (const r of rows) if (holdsMembers({ summary: r.summary, members: Number(r.members) })) out.set(headOf(r.repo, r.number, r.head_oid), { id: r.id, summary: r.summary });
  return out;
}

/** Supersedes the failed batch holding the head, with the `batch-again` audit row. */
export async function supersedeFailedBatch(db: Db, by: string, key: { repo: string; number: number; head: string }): Promise<{ id: number; summary: string | null }> {
  return await db.write(async () => {
    const b = (await failedHolding(db, [key])).get(headOf(key.repo, key.number, key.head));
    if (!b) throw new Error(`${refOf(key.repo, key.number)} is not held by a failed batch at its current head`);
    const at = new Date().toISOString();
    await applyUpdates(db, [{ id: b.id, at, set: { state: "superseded" } }]);
    await addAudit(db, [{ login: by, action: "batch-again", target: refOf(key.repo, key.number), at, details: { head: key.head, batch: b.id, summary: b.summary } }]);
    return b;
  });
}

/** The failed batch holding each head of the PRs. 1 statement. */
export async function loadFailedBatches(db: Db, refs: { repo: string; number: number }[]): Promise<Map<HeadRef, { id: number; summary: string | null }>> {
  return await failedHolding(db, refs);
}
