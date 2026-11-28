// Verifications (`verifications`) (package merge-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { loadTasks } from "../build/index.ts";
import { taskEndedExpr, taskStateExpr } from "../build/fragments.ts";
import { TERMINAL, type TaskRecord } from "../build/types.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { itemHead, openItem } from "../mirror/fragments.ts";
import { addStageEvents } from "../planner/index.ts";
import type { StageEventRow } from "../planner/types.ts";
import { inScopeExpr } from "../workflow/fragments.ts";
import { headOf, refOf } from "./read.ts";
import { safeJson, settleByHead, splitHead } from "./settle.ts";
import type { HeadRef, PendingVerification, RefKey, SavedVerification, StageRow, VerificationSettle, VerificationState, VerificationTask, VerificationView, VerifyDue } from "./types.ts";

type Row = {
  repo: string; number: number; head_sha: string; base_sha: string | null; kind: string; reason: string; plan: string | null; model: string | null;
  head_task_id: number | null; base_task_id: number | null; state: string; summary: string | null; note: string | null; created_at: string; finished_at: string | null;
};
const COLUMNS = ["repo", "number", "head_sha", "base_sha", "kind", "reason", "plan", "model", "head_task_id", "base_task_id", "state", "summary", "note", "created_at", "finished_at"] as const;
const cols = COLUMNS.map((c) => `v.${c}` as const);

const taskOf = (role: "head" | "base", t: TaskRecord | undefined): VerificationTask | null =>
  t ? { id: t.id, role, state: t.state, plan: t.plan, results: t.results, summary: t.summary, endedAt: t.endedAt } : null;

/** The task rows of `rows` in one statement (none when no row has a task). */
async function tasksOf(db: Db, rows: readonly Row[]): Promise<Map<number, TaskRecord>> {
  const ids = [...new Set(rows.flatMap((r) => [r.head_task_id, r.base_task_id]).filter((id): id is number => id !== null))];
  return ids.length ? await loadTasks(db, ids) : new Map();
}

function viewOf(r: Row, tasks: ReadonlyMap<number, TaskRecord>): VerificationView {
  const head = taskOf("head", r.head_task_id === null ? undefined : tasks.get(r.head_task_id));
  const base = taskOf("base", r.base_task_id === null ? undefined : tasks.get(r.base_task_id));
  return {
    repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha, kind: r.kind, reason: r.reason, plan: safeJson(r.plan), model: r.model,
    state: r.state as VerificationState, summary: r.summary, note: r.note, createdAt: r.created_at, finishedAt: r.finished_at,
    tasks: [head, base].filter((t): t is VerificationTask => t !== null),
  };
}

/**
 * Verification rows of the items in `keys` with their tasks (none with `tasks: false`): two statements in one wave. With
 * `heads`, only the row at the item's current head.
 */
export async function loadVerifications(db: Db, keys: KeySource, o?: { heads?: boolean; tasks?: boolean }): Promise<Map<HeadRef, VerificationView>> {
  const q = queryDb(db);
  const of = (): any => (q.k as any).selectFrom("verifications as v")
    .innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "v.repo").onRef("kk.number", "=", "v.number"))
    .$if(!!o?.heads, (s: any) => s.where((eb: any) => eb("v.head_sha", "=", itemHead(eb, "v.repo", "v.number"))));
  const ids = of().select("v.head_task_id as id").unionAll(of().select("v.base_task_id as id"));
  const [rows, tasks] = await db.together(() => Promise.all([q.all(of().select(cols)) as Promise<Row[]>, o?.tasks === false ? new Map<number, TaskRecord>() : loadTasks(db, ids)]));
  return new Map(rows.map((r) => [headOf(r.repo, r.number, r.head_sha), viewOf(r, tasks)]));
}

/** One-key wrapper for the merge-time read. */
export async function verificationOf(db: Db, repo: string, number: number, head: string): Promise<VerificationView | undefined> {
  return (await loadVerifications(db, [{ repo, number }])).get(headOf(repo, number, head));
}

/** Verification rows by state and repo, newest first, with tasks. */
export async function listVerifications(db: Db, f: { states?: VerificationState[]; repo?: string; limit?: number }): Promise<VerificationView[]> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("verifications as v").select(cols)
    .$if(!!f.states?.length, (s: any) => s.where("v.state", "in", f.states!))
    .$if(!!f.repo, (s: any) => s.where("v.repo", "=", f.repo!))
    .orderBy("v.created_at", "desc").orderBy("v.number", "desc").limit(Math.min(f.limit ?? 100, 1000))) as Row[];
  const tasks = await tasksOf(db, rows);
  return rows.map((r) => viewOf(r, tasks));
}

/** The newest verification of each ref: the row at the item's head when there is one, else the newest by creation time. */
export async function loadLatestVerification(db: Db, refs: { repo: string; number: number }[]): Promise<Map<RefKey, { head: string; view: VerificationView }>> {
  if (refs.length === 0) return new Map();
  const q = queryDb(db);
  const k = q.k as any;
  const rows = await q.all(k.selectFrom((eb: any) => eb.selectFrom("verifications as v")
    .innerJoin(kx.refPairs(db, refs.map((r) => [r.repo, r.number] as const), "kk"), (j: any) => j.onRef("kk.repo", "=", "v.repo").onRef("kk.number", "=", "v.number"))
    .select((e: any) => [...cols, e.fn.agg("row_number").over((o: any) => o.partitionBy(["v.repo", "v.number"])
      .orderBy(e.case().when("v.head_sha", "=", itemHead(e, "v.repo", "v.number")).then(e.lit(0)).else(e.lit(1)).end()).orderBy("v.created_at", "desc")).as("rn")]).as("t"))
    .selectAll().where("rn", "=", 1)) as (Row & { rn: number })[];
  const tasks = await tasksOf(db, rows);
  return new Map(rows.map((r) => [refOf(r.repo, r.number), { head: r.head_sha, view: viewOf(r, tasks) }]));
}

/**
 * Whether a verification needs a collection run (its PR head moved or closed, its tasks ended, or it is `planned` while a task
 * started) and whether a screenshot run does; with the repos that have a screenshot run in flight. A verification that was started is
 * collected whatever became of its PR's scope; a screenshot run, whose comparison is a model call, only for a PR in scope. One statement.
 */
export async function loadVerifyDue(db: Db): Promise<VerifyDue> {
  const q = queryDb(db);
  const k = q.k as any;
  const moved = (table: "verifications" | "screenshot_runs", a: string) => k.selectFrom(`${table} as ${a}`).select((eb: any) => eb.lit(1).as("one"))
    .where(`${a}.state`, "in", ["planned", "running"])
    .$if(table === "screenshot_runs", (s: any) => s.where((eb: any) => inScopeExpr(db, eb, `${a}.repo`, `${a}.number`)))
    .where((eb: any) => eb.or([
      eb.not(openItem(eb, `${a}.repo`, `${a}.number`)),
      eb(itemHead(eb, `${a}.repo`, `${a}.number`), "is distinct from", eb.ref(`${a}.head_sha`)),
      eb.and([eb(taskStateExpr(eb, `${a}.head_task_id`), "in", [...TERMINAL]), taskEndedExpr(eb, `${a}.base_task_id`)]),
      eb.and([eb(`${a}.state`, "=", "planned"), eb.or([
        eb(taskStateExpr(eb, `${a}.head_task_id`), "in", ["claimed", "running"]), eb(taskStateExpr(eb, `${a}.base_task_id`), "in", ["claimed", "running"]),
      ])]),
    ]))
    .limit(1);
  const inFlight = k.selectFrom("screenshot_runs as r").select("r.repo").distinct().where("r.state", "in", ["planned", "running"])
    .where((eb: any) => inScopeExpr(db, eb, "r.repo", "r.number"));
  const r = (await q.get(k.selectNoFrom([kx.rowArray(db, moved("verifications", "v")).as("verification"), kx.rowArray(db, moved("screenshot_runs", "s")).as("screenshots"),
    kx.jsonRows(db, inFlight).as("shot_repos")]))) as { verification: string | null; screenshots: string | null; shot_repos: string | null };
  return { verifications: r.verification !== null, screenshots: r.screenshots !== null, shotRepos: kx.parseJsonRows<{ repo: string }>(r.shot_repos).map((x) => x.repo) };
}

/** Rows `planned` or `running` with the item's state, head and whether it is in scope; the tasks come in a second wave. */
export async function loadPendingVerifications(db: Db): Promise<PendingVerification[]> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("verifications as v")
    .select((eb: any) => [...cols, openItem(eb, "v.repo", "v.number").as("is_open"), itemHead(eb, "v.repo", "v.number").as("item_head"), inScopeExpr(db, eb, "v.repo", "v.number").as("in_scope")])
    .where("v.state", "in", ["planned", "running"])
    .orderBy("v.created_at").orderBy("v.number")) as (Row & { is_open: unknown; item_head: string | null; in_scope: unknown })[];
  const tasks = await tasksOf(db, rows);
  return rows.map((r) => ({ ...viewOf(r, tasks), itemState: r.is_open ? "OPEN" as const : "CLOSED" as const, currentHead: r.item_head, inScope: !!Number(r.in_scope), headTask: r.head_task_id, baseTask: r.base_task_id }));
}

const stageRows = (rows: (StageRow | undefined)[]): StageEventRow[] => rows.filter((s): s is StageRow => !!s).map((s) => ({ ...s, stage: s.stage as StageEventRow["stage"] }));

/**
 * Upserts verification rows (a new verification of a head clears the earlier note) and records each row's stage event, in one
 * `db.write`. A row written over an errored one counts that retry in `errors`.
 */
export async function saveVerifications(db: Db, rows: SavedVerification[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const byKey = new Map<HeadRef, SavedVerification>();
  for (const r of rows) byKey.set(headOf(r.repo, r.number, r.headSha), r);
  const list = [...byKey.values()];
  await db.write(async () => {
    for (const values of kx.batches(list.map((r) => ({
      repo: r.repo, number: r.number, head_sha: r.headSha, base_sha: r.baseSha, kind: r.kind, reason: r.reason, plan: r.plan === null ? null : JSON.stringify(r.plan), model: r.model,
      head_task_id: r.headTaskId, base_task_id: r.baseTaskId, state: r.state, summary: r.summary, note: r.note, created_at: r.at, finished_at: r.finishedAt,
    }))))
      await q.run(q.k.insertInto("verifications").values(values).onConflict((oc) => oc.columns(["repo", "number", "head_sha"])
        .doUpdateSet((eb) => ({
          ...kx.excluded(["base_sha", "kind", "reason", "plan", "model", "head_task_id", "base_task_id", "state", "summary", "note", "created_at", "finished_at"])(eb),
          // A run made over an errored verification is a retry of that error (src/core/rules.ts verifyRetryAt).
          errors: eb.case().when("verifications.state", "=", "error").then(eb("verifications.errors", "+", 1)).else(eb.ref("verifications.errors")).end(),
        }))));
    const stages = stageRows(list.map((r) => r.stage));
    if (stages.length) await addStageEvents(db, stages);
  });
}

/**
 * Compare-and-set: each row changes only while its state is one of `from`. A column left out of `set` keeps its value. Stage events
 * are recorded for the rows that changed, in the same `db.write`. Returns the keys changed.
 */
export async function settleVerifications(db: Db, rows: VerificationSettle[]): Promise<Set<HeadRef>> {
  if (rows.length === 0) return new Set();
  return await db.write(async () => {
    const changed = await settleByHead(db, "verifications", { state: "text", summary: "text", note: "text", finished_at: "text" }, rows.map((r) => ({
      key: r.key, from: r.from,
      set: {
        state: r.set.state,
        ...(r.set.summary !== undefined ? { summary: r.set.summary } : {}),
        ...(r.set.note !== undefined ? { note: r.set.note } : {}),
        ...(r.set.finishedAt !== undefined ? { finished_at: r.set.finishedAt } : {}),
      },
    })));
    const stages = stageRows(rows.filter((r) => changed.has(r.key)).map((r) => r.stage));
    if (stages.length) await addStageEvents(db, stages);
    return changed;
  });
}

/** Retry path: points each row at its cloned tasks and plans it again. */
export async function restartVerifications(db: Db, rows: { key: HeadRef; headTask: number | null; baseTask: number | null }[]): Promise<void> {
  if (rows.length === 0) return;
  await db.write(async () => {
    await kx.updateFrom(db, "verifications", ["repo", "number", "head_sha"], rows.map((r) => {
      const { repo, number, head } = splitHead(r.key);
      return { repo, number, head_sha: head, head_task_id: r.headTask, base_task_id: r.baseTask, state: "planned" };
    }));
  });
}

/**
 * Stamps each errored verification among `keys` as run again at `at` (`errors` + 1, `finished_at`): a retry of the error that wrote no row
 * of its own (no plan, no diff), so its backoff (src/core/rules.ts verifyRetryAt) starts again. Rows in another state are left alone.
 */
export async function restampVerifyErrors(db: Db, keys: HeadRef[], at: string): Promise<void> {
  if (keys.length === 0) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const chunk of kx.chunks(keys)) {
      const rows = chunk.map(splitHead);
      await q.run(q.k.updateTable("verifications").set((eb) => ({ finished_at: at, errors: eb("errors", "+", 1) })).where("state", "=", "error")
        .where((eb) => kx.tupleIn(db, [eb.ref("repo"), eb.ref("number"), eb.ref("head_sha")], rows.map((r) => [r.repo, r.number, r.head]), ["text", "bigint", "text"])));
    }
  });
}

/**
 * Marks verifications stale. Returns the rows changed. Marked by AutoCraft itself (no `by`: the diff's base changed), a head's count of
 * runs again over errors starts over; a person's Verify again (`by`) keeps it, so it gives one more run.
 */
export async function markVerificationsStale(db: Db, keys: HeadRef[], by?: string): Promise<number> {
  if (keys.length === 0) return 0;
  const q = queryDb(db);
  let n = 0;
  for (const chunk of kx.chunks(keys)) {
    const rows = chunk.map(splitHead);
    n += Number((await q.run(q.k.updateTable("verifications").set(by === undefined ? { state: "stale", errors: 0 } : { state: "stale" })
      .where((eb) => kx.tupleIn(db, [eb.ref("repo"), eb.ref("number"), eb.ref("head_sha")], rows.map((r) => [r.repo, r.number, r.head]), ["text", "bigint", "text"])))).changes);
  }
  return n;
}

