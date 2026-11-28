// Call reads (package runners-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { indexedBy, inList, literal, ref, schemaEb } from "../../db/kx.ts";
import type { ItemRef } from "../../../web/src/api/types.ts";
import { aliveOf, goneCallExpr } from "./calls-expiry.ts";
import { loadQueueFor } from "./calls-queue-load.ts";
import { CALLER_STALE_MS, STICKY_LIVE_MS, lostLeaseExpr } from "./calls-shared.ts";
import type { CallPoll, CallState, CallSummary, LowerLogin, PollRow, QueuedWait, QueueSnapshot, Tier } from "./types.ts";

const items = (text: string): ItemRef[] => JSON.parse(text) as ItemRef[];

/** Summaries of calls by id. 1 statement. */
export async function loadCalls(db: Db, ids: number[]): Promise<Map<number, CallSummary>> {
  if (!ids.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.remote_calls").select(["id", "state", "error", "prompt_id", "items", "user_login", "own_lane", "run_id", "since", "consumed_at", "job_id"]).where(inList(db, "id", ids, "bigint")));
  return new Map(rows.map((r) => [Number(r.id), { id: Number(r.id), state: r.state as CallState, error: r.error, promptId: r.prompt_id, items: items(r.items), userLogin: r.user_login, ownLane: Number(r.own_lane) === 1,
    runId: r.run_id, since: Number(r.since), consumedAt: r.consumed_at, jobId: r.job_id }]));
}

/** The prompt version and system prompt a call was queued with, or null; `alone` because the bundle holds the whole stdin. */
export async function loadCallPrompt(db: Db, id: number): Promise<{ promptVersion: string; system: string | null } | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.remote_calls").select(["prompt_version", "bundle"]).where("id", "=", id), { alone: true, label: "runners.loadCallPrompt" });
  if (!r) return null;
  const system = (JSON.parse(r.bundle) as { system?: unknown }).system;
  return { promptVersion: r.prompt_version, system: typeof system === "string" ? system : null };
}

/** The reply and its call; `alone` because the reply is up to 4 MB. */
export async function loadCallReply(db: Db, id: number): Promise<{ promptId: string; items: { repo: string; number: number }[]; reply: string | null; state: string; runId: number | null } | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.remote_calls").select(["prompt_id", "items", "reply", "state", "run_id"]).where("id", "=", id), { alone: true, label: "runners.loadCallReply" });
  return r ? { promptId: r.prompt_id, items: items(r.items), reply: r.reply, state: r.state, runId: r.run_id } : null;
}

/** The usage (and with `reply`, the reply, up to 4 MB each, so the read runs alone) of calls by id. 1 statement. */
export async function loadCallUsage(db: Db, ids: number[], o: { reply?: boolean } = {}): Promise<Map<number, { usage: string | null; reply: string | null }>> {
  if (!ids.length) return new Map();
  const q = queryDb(db);
  const b = q.k.selectFrom("main.remote_calls").select(["id", "usage"]).where(inList(db, "id", ids, "bigint"));
  const rows = o.reply ? await q.all(b.select("reply"), { alone: true, label: "runners.loadCallUsage" }) : (await q.all(b)).map((r) => ({ ...r, reply: null }));
  return new Map(rows.map((r) => [Number(r.id), { usage: r.usage, reply: r.reply }]));
}

/**
 * The call row, liveness stamp, lost-lease and gone-caller reads: one poller per process reads every call it waits on in one wave of 5
 * statements, whatever their number. Reads only: the poller takes a done call's reply (`takeReplies`) before it hands it out.
 */
export async function loadCallPolls(db: Db, ids: number[], nowMs: number): Promise<Map<number, CallPoll>> {
  if (!ids.length) return new Map();
  const q = queryDb(db);
  const [rows, stamp, lost, gone, parentLive] = await db.together(async () => await Promise.all([
    // The reply only of a done call: it is up to 4 MB and every poll would carry it.
    q.all(q.k.selectFrom("main.remote_calls").select((eb) => ["id", "state", eb.case().when("state", "=", "done").then(eb.ref("reply")).end().as("reply"), "error", "progress", "run_id", "leased_at", "attempt", "consumed_at", "usage", "turns", "session_id",
      "parent_id", "queued_ms", "queued_since", "since", "prompt_id", "tier", "items", "repo"])
      .where(inList(db, "id", ids, "bigint"))),
    q.get(q.k.selectFrom("main.remote_liveness").select(["alive_at", "since"]).where("id", "=", 1)),
    q.all(q.k.selectFrom("main.remote_calls").select("id").where(inList(db, "id", ids, "bigint")).where((eb) => lostLeaseExpr(db, eb, nowMs))),
    q.all(q.k.selectFrom("main.remote_calls").select("id").where(inList(db, "id", ids, "bigint")).where((eb) => goneCallExpr(db, eb, nowMs))),
    // A queued follow-up: the helper that ran its parent holds a lease that heartbeats.
    q.all(q.k.selectFrom("main.remote_calls as c").select("c.id").where(inList(db, "c.id", ids, "bigint")).where("c.state", "=", "queued").where("c.parent_id", "is not", null)
      .where((eb) => eb.exists(schemaEb(eb).selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "l")).select(eb.lit(1).as("one")).where("l.state", "=", literal("leased")).where("l.heartbeat_at", ">=", nowMs - STICKY_LIVE_MS)
        .where("l.token_id", "=", (e) => schemaEb(e).selectFrom("main.remote_calls as p").select("p.token_id").where("p.id", "=", ref<number>("c.parent_id")))))),
  ]));
  const liveness = aliveOf(stamp, nowMs);
  const lostIds = new Set(lost.map((r) => Number(r.id))), goneIds = new Set(gone.map((r) => Number(r.id))), parentIds = new Set(parentLive.map((r) => Number(r.id)));
  const out = new Map<number, CallPoll>();
  for (const id of ids) out.set(id, { call: null, liveness, lost: false, gone: false, parentLive: false, queued: null });
  for (const r of rows) {
    const id = Number(r.id);
    const call: PollRow = { id, state: r.state as CallState, reply: r.reply, error: r.error, progress: r.progress, runId: r.run_id, leasedAt: r.leased_at, attempt: Number(r.attempt), consumedAt: r.consumed_at, usage: r.usage, turns: r.turns, sessionId: r.session_id };
    const queued: QueuedWait | null = r.state !== "queued" ? null : {
      parentId: r.parent_id === null ? null : Number(r.parent_id), queuedMs: Number(r.queued_ms), queuedSince: r.queued_since === null ? null : Number(r.queued_since), since: Number(r.since),
      promptId: r.prompt_id, tier: r.tier as Tier, repos: [...new Set([...items(r.items).map((i) => i.repo), ...(r.repo ? [r.repo] : [])])],
    };
    out.set(id, { call, liveness, lost: lostIds.has(id), gone: goneIds.has(id), parentLive: parentIds.has(id), queued });
  }
  return out;
}

/** Clears the replies of done calls that were read, so each is handed out once and can no longer be adopted. 1 statement. */
export async function takeReplies(db: Db, ids: number[], nowMs: number): Promise<void> {
  if (!ids.length) return;
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.remote_calls").set({ reply: null, consumed_at: nowMs }).where(inList(db, "id", ids, "bigint")).where("state", "=", "done").where("consumed_at", "is", null));
}

/** `GROUP BY job_id`: whether each job has queued calls (for a caller that polls) and when the last lease was taken. */
export async function loadRemoteQueueStates(db: Db, jobIds: number[], now: number): Promise<Map<number, { queued: boolean; lastLeaseAt: number | null }>> {
  if (!jobIds.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.remote_calls").select((eb) => ["job_id",
    eb.fn.max<number>(eb.case().when(eb.and([eb("state", "=", "queued"), eb("seen_at", ">=", now - CALLER_STALE_MS)])).then(eb.lit(1)).else(eb.lit(0)).end()).as("queued"),
    eb.fn.max<number | null>("leased_at").as("last")]).where(inList(db, "job_id", jobIds, "bigint")).groupBy("job_id"));
  return new Map(rows.map((r) => [Number(r.job_id), { queued: Number(r.queued) === 1, lastLeaseAt: r.last === null ? null : Number(r.last) }]));
}

/** The agent run id of each call. */
export async function loadRunIdsOfCalls(db: Db, callIds: number[]): Promise<Map<number, number>> {
  if (!callIds.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.remote_calls").select(["id", "run_id"]).where(inList(db, "id", callIds, "bigint")).where("run_id", "is not", null));
  return new Map(rows.map((r) => [Number(r.id), Number(r.run_id)]));
}

/** Run id to leasing token for leased calls and calls ended after `since`. */
export async function loadLeaseTokenByRun(db: Db, since: number): Promise<Map<number, number>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.remote_calls").select(["run_id", "token_id"]).where("run_id", "is not", null).where("token_id", "is not", null)
    .where((eb) => eb.or([eb("state", "=", "leased"), eb.and([eb("state", "in", ["done", "failed"]), eb("ended_at", ">", since)])])));
  return new Map(rows.map((r) => [Number(r.run_id), Number(r.token_id)]));
}

/** Lease turnover per login: the count of its leases and the newest lease time, as a value that changes whenever one of its helpers takes or ends a call. */
export async function loadLeaseTurnover(db: Db, logins: string[]): Promise<Map<LowerLogin, string>> {
  if (!logins.length) return new Map();
  const q = queryDb(db);
  const wanted = logins.map((l) => l.toLowerCase());
  const rows = await q.all(q.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "c")).select((eb) => [eb.fn<string>("lower", ["c.user_login"]).as("login"), eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("c.leased_at").as("at")])
    .where("c.state", "=", literal("leased")).where(inList(db, "c.user_login", wanted, "citext")).groupBy((eb) => eb.fn("lower", ["c.user_login"])));
  const out = new Map(wanted.map((l) => [l, "0:"]));
  for (const r of rows) out.set(r.login, `${Number(r.n)}:${r.at ?? ""}`);
  return out;
}

/**
 * Every queued call: the follow-ups first, then the others, each oldest first (the pure `sortQueue` of feature code gives the claim order). Cached per `Db` for 2 s and keyed
 * by the (count, newest id) signature; every writer that changes the queue drops the cache. A miss is one wave of 2 statements after the signature, a hit one.
 */
export async function loadQueue(db: Db, now: number): Promise<QueueSnapshot> {
  return await loadQueueFor(db, now);
}
