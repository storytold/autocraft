// Enqueue and withdraw calls (package runners-a).
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { batches, greatest, inList, least, schemaEb, tupleIn, valuesTable, ciEq, ref, type Eb } from "../../db/kx.ts";
import { approvedLaneJob, resumingJobs } from "../jobs/fragments.ts";
import { loadJobs } from "../jobs/index.ts";
import { adoptableCall } from "./fragments.ts";
import { finishCalls } from "./calls-unlease.ts";
import { ITEM_WITHDRAWN_PREFIX, dropQueueCache, judges, queuedMsAfter } from "./calls-shared.ts";
import { itemsGoneExpr } from "./cross.ts";
import { reuseKey } from "../../remote/reuse-key.ts";
import { loadItemAuthors } from "../mirror/authors.ts";
import type { NewCall } from "./types.ts";

/** Why a resumed job's earlier call is withdrawn: the resumed run asked the same prompt about its items with other input. */
export const RESUME_REPLACED = "replaced by the resumed run's call";

/** Calls this process queued or adopted: a resumed run adopts each earlier call once. */
const adopted = new Set<number>();
/** Of those, the earlier runs' calls this process adopted: they belong to the run now, so a later call of it does not withdraw them. */
const adoptedEarlier = new Set<number>();
/** One adoption at a time, so two equal calls of one job made side by side do not adopt the same earlier call. */
let adopting: Promise<unknown> = Promise.resolve();

const refKey = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;
const parentOf = (c: NewCall) => (eb: Eb) => (c.parentId === undefined ? eb("parent_id", "is", null) : eb("parent_id", "=", c.parentId));

/**
 * In a resumed job: adopts a call of the job's earlier runs with the same prompt, version, reuse key (src/remote/reuse-key.ts) and parent that is
 * still open or answered and unread, and returns its id. When there is none, the earlier runs' open calls with the same prompt and parent that
 * name one of its items (or name no item, like it) asked about input this call replaces (a job's item list changes between runs): the queued
 * ones are withdrawn; leased ones run on, since a later call of the run may still adopt them. At most 4 statements per call.
 */
function adoptEarlier(db: Db, jobId: number, startedMs: number, c: NewCall, hash: string, now: number): Promise<number | null> {
  const q = queryDb(db);
  const turn = adopting.then(async (): Promise<number | null> => {
    const taken = [...adopted];
    const earlier = await q.get(q.k.selectFrom("main.remote_calls").select("id").where("job_id", "=", jobId).where("since", "<", startedMs).where("prompt_id", "=", c.promptId)
      .where("prompt_version", "=", c.promptVersion).where("bundle_hash", "=", hash).where(parentOf(c)).where((eb) => adoptableCall(eb))
      .$if(taken.length > 0, (b) => b.where(inList(db, "id", taken, "bigint", true))).orderBy("id").limit(1));
    if (earlier) {
      const id = Number(earlier.id);
      adopted.add(id);
      adoptedEarlier.add(id);
      // Fresh again for claims: its caller is back. A queued call's wait starts again: the time it waited before the stop counts toward its wait limits, the restart's does not.
      await q.run(q.k.updateTable("main.remote_calls").set((eb) => {
        const w = schemaEb(eb) as any;
        return {
          queued_ms: w("queued_ms", "+", w.case().when(w.and([w("state", "=", "queued"), w("queued_since", "is not", null)])).then(greatest(db, [w.lit(0), w(least(db, [w.ref("seen_at"), w.val(now)]), "-", w.ref("queued_since"))])).else(w.lit(0)).end()),
          queued_since: w.case().when(w("state", "=", "queued")).then(now).else(w.ref("queued_since")).end(), seen_at: now,
        } as any;
      }).where("id", "=", id));
      dropQueueCache(db);
      return id;
    }
    const refs = c.items.map((i) => [i.repo, i.number] as const), kept = [...adoptedEarlier];
    const stale = await q.all(q.k.selectFrom("main.remote_calls").select("id").where("job_id", "=", jobId).where("since", "<", startedMs).where("prompt_id", "=", c.promptId)
      .where((eb) => refs.length
        ? eb.exists(schemaEb(eb).selectFrom("main.remote_call_items as ri").select(eb.lit(1).as("one")).where("ri.call_id", "=", ref<number>("remote_calls.id"))
          .where(tupleIn(db, ["ri.repo", "ri.number"], refs, ["text", "bigint"])))
        : eb("items", "=", "[]"))
      .where(parentOf(c)).where("state", "=", "queued").$if(kept.length > 0, (b) => b.where(inList(db, "id", kept, "bigint", true))));
    if (stale.length) await withdrawCalls(db, stale.map((r) => ({ id: Number(r.id), reason: RESUME_REPLACED })), { states: ["queued"], now });
    return null;
  });
  adopting = turn.catch(() => undefined);
  return turn;
}

/**
 * Queues calls: one read wave (the jobs, parent rows, item authors), then one write with a multi-row insert of `remote_calls` and `remote_call_items`.
 * A resumed job adopts an equal earlier call instead of inserting. Returns the call ids in the order given.
 */
export async function enqueueCalls(db: Db, calls: NewCall[], now: number = Date.now()): Promise<number[]> {
  if (!calls.length) return [];
  const q = queryDb(db);
  const jobIds = [...new Set(calls.flatMap((c) => (c.job.jobId === null ? [] : [c.job.jobId])))];
  const parentIds = [...new Set(calls.flatMap((c) => (c.parentId === undefined ? [] : [c.parentId])))];
  const judged = new Map(calls.filter((c) => judges(c.promptId)).flatMap((c) => c.items).map((i) => [refKey(i), i]));
  const [jobs, parents, authors] = await db.together(async () => await Promise.all([
    jobIds.length ? loadJobs(db, jobIds) : Promise.resolve(new Map<number, { resumes: number; started_at: string | null }>()),
    parentIds.length ? q.all(q.k.selectFrom("main.remote_calls").select(["id", "user_login", "for_login", "bound_slot"]).where(inList(db, "id", parentIds, "bigint"))) : Promise.resolve([]),
    judged.size ? loadItemAuthors(db, [...judged.values()].map((r) => ({ repo: r.repo, number: r.number }))) : Promise.resolve(new Map<string, string[]>()),
  ]));
  const parentRow = new Map(parents.map((r) => [Number(r.id), r]));
  const ids: (number | null)[] = [];
  const fresh: { c: NewCall; at: number; hash: string }[] = [];
  for (const c of calls) {
    const job = c.job.jobId === null ? undefined : jobs.get(c.job.jobId);
    const hash = reuseKey(c.bundle, c.items);
    const adoptedId = job && Number(job.resumes) > 0 && job.started_at ? await adoptEarlier(db, c.job.jobId!, Date.parse(job.started_at), c, hash, now) : null;
    ids.push(adoptedId);
    if (adoptedId === null) fresh.push({ c, at: ids.length - 1, hash });
  }
  if (fresh.length) {
    await db.write(async () => {
      const rows = fresh.map(({ c, hash }) => {
        const parent = c.parentId === undefined ? undefined : parentRow.get(c.parentId);
        const forLogin = c.forLogin ?? parent?.for_login ?? null;
        const boundSlot = forLogin !== null && (c.forLogin !== undefined ? c.boundSlot === true : Number(parent?.bound_slot) === 1);
        const names = judges(c.promptId) ? [...new Set(c.items.flatMap((i) => authors.get(refKey(i)) ?? []))] : [];
        return {
          job_id: c.job.jobId, step: c.job.step, stage: c.job.stage, prompt_id: c.promptId, prompt_version: c.promptVersion, tier: c.tier, effort: c.effort, asked_model: c.askedModel,
          bundle: JSON.stringify(c.bundle), bundle_hash: hash, state: "queued" as const, items: JSON.stringify(c.items), repo: c.job.repo, class: c.job.cls, level: c.level,
          since: now, seen_at: now, queued_since: now, max_attempts: Math.max(1, c.maxAttempts), timeout_ms: c.bundle.timeoutSeconds * 1000, parent_id: c.parentId ?? null,
          sticky_login: parent?.user_login ?? null, reference_repo: c.referenceRepo ?? null, authors: JSON.stringify(names), for_login: forLogin, bound_slot: boundSlot ? 1 : 0,
        };
      });
      const inserted: number[] = [];
      for (const b of batches(rows)) for (const r of await q.all(q.k.insertInto("main.remote_calls").values(b).returning("id"))) inserted.push(Number(r.id));
      const items = fresh.flatMap(({ c }, i) => c.items.map((it, pos) => ({ call_id: inserted[i]!, pos, repo: it.repo, number: it.number })));
      for (const b of batches(items)) await q.run(q.k.insertInto("main.remote_call_items").values(b));
      fresh.forEach(({ c, at }, i) => { ids[at] = inserted[i]!; if (c.job.jobId !== null) adopted.add(inserted[i]!); });
    });
    dropQueueCache(db);
  }
  return ids as number[];
}

/** One-call wrapper over `enqueueCalls`. */
export async function enqueueCall(db: Db, call: NewCall, now?: number): Promise<number> {
  return (await enqueueCalls(db, [call], now))[0]!;
}

/** Ends the calls `where` selects as failed with `reason` and finishes their runs, in one transaction. Returns the ids ended. */
async function withdrawWhere(db: Db, reason: string, now: number, where: (eb: Eb) => Expression<SqlBool>): Promise<number[]> {
  const q = queryDb(db);
  const ended = await db.write(async () => {
    const rows = await q.all(q.k.updateTable("main.remote_calls").set((eb) => ({ state: "failed", error: reason, ended_at: now, queued_ms: queuedMsAfter(db, eb, now), queued_since: null }) as any)
      .where((eb) => where(eb)).returning(["id", "run_id"]));
    await finishCalls(db, rows.filter((r) => r.run_id !== null).map((r) => ({ id: r.run_id!, state: "failed" as const, error: reason, summary: "withdrawn" })));
    return rows;
  });
  if (ended.length) dropQueueCache(db);
  return ended.map((r) => Number(r.id));
}

/** Withdraws calls in the given states with a per-row reason and finishes their runs in the same transaction. Returns the ids withdrawn. */
export async function withdrawCalls(db: Db, rows: { id: number; reason: string }[], opts: { states?: string[]; now?: number } = {}): Promise<number[]> {
  if (!rows.length) return [];
  const now = opts.now ?? Date.now(), states = opts.states ?? ["queued", "leased"];
  const q = queryDb(db);
  const reasons = new Map(rows.map((r) => [r.id, r.reason]));
  const ended = await db.write(async () => {
    const out: { id: number; run_id: number | null }[] = [];
    for (const chunk of batches(rows.map((r) => ({ id: r.id, reason: r.reason })))) {
      const v = valuesTable(db, chunk, { id: "bigint", reason: "text" }, "v");
      const got = await q.all((q.k.updateTable("main.remote_calls") as any).from(v)
        .set((eb: Eb) => ({ state: "failed", error: eb.ref("v.reason"), ended_at: now, queued_ms: queuedMsAfter(db, eb, now), queued_since: null }))
        .where((eb: Eb) => eb.and([eb("remote_calls.id", "=", eb.ref("v.id")), eb("remote_calls.state", "in", states)])).returning(["remote_calls.id as id", "remote_calls.run_id as run_id"]));
      out.push(...got.map((r: any) => ({ id: Number(r.id), run_id: r.run_id as number | null })));
    }
    await finishCalls(db, out.filter((r) => r.run_id !== null).map((r) => ({ id: r.run_id!, state: "failed" as const, error: reasons.get(r.id)!, summary: "withdrawn" })));
    return out;
  });
  if (ended.length) dropQueueCache(db);
  return ended.map((r) => r.id);
}

/** Withdraws the open calls of a job, or of every job except resuming ones, and finishes their runs. */
export async function withdrawJobCalls(db: Db, reason: string, jobId?: number): Promise<number> {
  return (await withdrawWhere(db, reason, Date.now(), (eb) => eb.and([eb("state", "in", ["queued", "leased"]),
    jobId === undefined ? eb("job_id", "is not", null) : eb("job_id", "=", jobId), eb("job_id", "not in", resumingJobs(db))]))).length;
}

const splitRef = (r: string): { repo: string; number: number } => ({ repo: r.slice(0, r.lastIndexOf("#")), number: Number(r.slice(r.lastIndexOf("#") + 1)) });

const onlyItem = (eb: Eb, it: { repo: string; number: number }): Expression<SqlBool> => {
  const items = () => schemaEb(eb).selectFrom("main.remote_call_items as ci").where("ci.call_id", "=", ref<number>("remote_calls.id"));
  return eb.and([eb.exists(items().select(eb.lit(1).as("one")).where("ci.repo", "=", it.repo).where("ci.number", "=", it.number)),
    eb(items().select((e) => e.fn.countAll<number>().as("n")), "=", 1)]);
};

/**
 * Withdraws the open queued calls whose only item is `ref`. The error of those not bound to a person starts with ITEM_WITHDRAWN_PREFIX, so the
 * jobs awaiting them skip the item; a call bound to a person (a maintainer's conversation turn) fails with `reason`, as its job handles.
 */
export async function withdrawItemCalls(db: Db, refStr: string, reason: string): Promise<number> {
  const it = splitRef(refStr), now = Date.now();
  const [free, bound] = [await withdrawWhere(db, `${ITEM_WITHDRAWN_PREFIX}${reason}`, now, (eb) => eb.and([eb("state", "=", "queued"), eb("for_login", "is", null), onlyItem(eb, it)])),
    await withdrawWhere(db, reason, now, (eb) => eb.and([eb("state", "=", "queued"), eb("for_login", "is not", null), onlyItem(eb, it)]))];
  return free.length + bound.length;
}

/**
 * Withdraws the queued calls of the automatic path whose only item is `ref`, once a person started or approved its workflow: calls of jobs of
 * `steps` (the steps with an approved lane) outside that lane, not bound to a person. The person's lane works the item from then on.
 */
export async function withdrawUnownedItemCalls(db: Db, a: { ref: string; steps: readonly string[]; reason: string }): Promise<number> {
  if (!a.steps.length) return 0;
  const it = splitRef(a.ref);
  return (await withdrawWhere(db, `${ITEM_WITHDRAWN_PREFIX}${a.reason}`, Date.now(), (eb) => eb.and([eb("state", "=", "queued"), eb("job_id", "is not", null),
    eb("for_login", "is", null), inList(db, "step", [...a.steps]), eb.not(approvedLaneJob(db, eb, "remote_calls.job_id")), onlyItem(eb, it)]))).length;
}

/**
 * Withdraws the queued calls that name one of `refs` and whose items all merged or closed (itemsGoneExpr): sync calls it for the items it
 * saw merge or close. Returns the ids withdrawn.
 */
export async function withdrawGoneItemCalls(db: Db, refs: readonly { repo: string; number: number }[], now: number = Date.now()): Promise<number[]> {
  if (!refs.length) return [];
  const named = (eb: Eb) => eb.exists(schemaEb(eb).selectFrom("main.remote_call_items as ni").select(eb.lit(1).as("one")).where("ni.call_id", "=", ref<number>("remote_calls.id"))
    .where(tupleIn(db, ["ni.repo", "ni.number"], refs.map((r) => [r.repo, r.number] as const), ["text", "bigint"])));
  return await withdrawGone(db, now, named);
}

/** Withdraws every queued call whose items all merged or closed (itemsGoneExpr), however they got there: the maintenance sweep's backstop for sync. Returns the ids withdrawn. */
export async function withdrawGoneCalls(db: Db, now: number = Date.now()): Promise<number[]> {
  return await withdrawGone(db, now, () => null);
}

const withdrawGone = async (db: Db, now: number, more: (eb: Eb) => Expression<SqlBool> | null): Promise<number[]> =>
  await withdrawWhere(db, `${ITEM_WITHDRAWN_PREFIX}every item it names was merged or closed`, now, (eb) => eb.and([eb("state", "=", "queued"), ...[more(eb)].filter((x) => x !== null),
    itemsGoneExpr(eb, "remote_calls.id", { promptId: "remote_calls.prompt_id", forLogin: "remote_calls.for_login", step: "remote_calls.step" })]));

/** Withdraws queued or leased conversation turn calls (`conversation.turn`, `interactive.conversation-turn`) bound to `forLogin` that name `ref`. */
export async function withdrawTurnCalls(db: Db, a: { ref: string; forLogin: string; reason: string }): Promise<number> {
  const it = splitRef(a.ref);
  return (await withdrawWhere(db, a.reason, Date.now(), (eb) => eb.and([eb("prompt_id", "in", ["conversation.turn", "interactive.conversation-turn"]), eb("repo", "=", it.repo), eb("state", "in", ["queued", "leased"]),
    ciEq(db, "for_login", eb.val(a.forLogin)),
    eb.exists(schemaEb(eb).selectFrom("main.remote_call_items as ci").select(eb.lit(1).as("one")).where("ci.call_id", "=", ref<number>("remote_calls.id")).where("ci.repo", "=", it.repo).where("ci.number", "=", it.number))]))).length;
}

/** Sets the claim level of the queued calls of each item (the highest level named when a call has several items). */
export async function setCallLevels(db: Db, rows: { ref: string; level: number }[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  const v = valuesTable(db, rows.map((r) => ({ ...splitRef(r.ref), level: r.level })), { repo: "text", number: "bigint", level: "bigint" }, "v");
  const named = (eb: Eb) => schemaEb(eb).selectFrom("main.remote_call_items as ci").innerJoin(v, (j) => j.onRef("v.repo", "=", "ci.repo").onRef("v.number", "=", "ci.number")).where("ci.call_id", "=", ref<number>("remote_calls.id"));
  const r = await q.run(q.k.updateTable("main.remote_calls").set((eb) => ({ level: named(eb).select((e: any) => e.fn.max("v.level").as("l")) }) as any)
    .where("state", "=", "queued").where((eb) => eb.exists(named(eb).select(eb.lit(1).as("one")))));
  if (Number(r.changes) > 0) dropQueueCache(db);
  return Number(r.changes);
}

/** Stamps `seen_at` on the calls a process awaits. */
export async function markCallersSeen(db: Db, ids: number[], now: number): Promise<void> {
  if (!ids.length) return;
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.remote_calls").set({ seen_at: now }).where(inList(db, "id", ids, "bigint")));
}

/** Clears `reply` on the done calls of the jobs. */
export async function clearJobReplies(db: Db, jobIds: number[]): Promise<number> {
  if (!jobIds.length) return 0;
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("main.remote_calls").set({ reply: null }).where(inList(db, "job_id", jobIds, "bigint")).where("state", "=", "done").where("reply", "is not", null))).changes);
}
