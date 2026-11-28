// Constants, predicates and caches shared by the call files of the runners module (not exported by index.ts).
import { createHash } from "node:crypto";
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { greatest, ref, schemaEb, literal, type Eb } from "../../db/kx.ts";
import { HEARTBEAT_S, PREPARE_MAX_S } from "../../remote/protocol.ts";
import { scaled } from "../../remote/time-scale.ts";
import type { QueueSnapshot } from "./types.ts";

/** A lease with no heartbeat for this long, while the dashboard was serving, goes back to the queue. */
export const LEASE_IDLE_MS = scaled(2 * 60_000);
/** A lease also ends this long after the bundle's own time limit, counted from its first `running` heartbeat. */
export const LEASE_MARGIN_MS = scaled(2 * 60_000);
/** A call whose caller has not polled for this long has lost it. */
export const CALLER_GONE_MS = scaled(5 * 60_000);
/** A claim, and the caller's poll, count a call while its caller's stamp is fresher than this. */
export const CALLER_STALE_MS = 2 * scaled(30_000) + scaled(15_000);
/** A lease counts as live for a waiting follow-up while its last heartbeat is at most this old. */
export const STICKY_LIVE_MS = 3 * scaled(HEARTBEAT_S * 1000);
/** A stamp of the dashboard's liveness older than this means it is not serving. */
export const ALIVE_STALE_MS = 3 * scaled(5_000);
export const PREPARE_MS = scaled(PREPARE_MAX_S * 1000);
/** Ended calls are kept this long, then deleted. */
export const KEEP_MS = 24 * 3600_000;
export const LEASE_PREFIX = "aclease_";
/** How long claims reuse the queued calls before reading them again. */
export const QUEUE_CACHE_MS = 2_000;
/** Prompts whose calls run on the interactive lane. */
export const INTERACTIVE_PROMPTS: readonly string[] = ["discord.", "interactive."];
/**
 * Prompts of an item workflow's work that is bound to a person (NewCall.forLogin, the implement step's calls on its starter's Task Runner):
 * a person who took the workflow's work onto their Task Runner may run such a call while no runner of that person could (cross.ts
 * boundTakeAllows). Every other bound call (Discord and interactive prompts, a maintainer's conversation turn) runs only on its person's runners.
 */
export const TAKEABLE_BOUND_PROMPTS: readonly string[] = ["implement."];
export const takeableBound = (promptId: string): boolean => TAKEABLE_BOUND_PROMPTS.some((p) => promptId.startsWith(p));
/** `user_settings` key of a login's Max calls at once and its largest value. */
export const MAX_CALLS_KEY = "max_calls";
export const MAX_CALLS_MAX = 64;
/** Runner statuses count as fresh for this long. */
export const STATUS_FRESH_MS = scaled((300 + 60) * 1000);
/** How long an empty claim counts as an idle helper: two claim intervals and some slack. */
export const IDLE_FRESH_MS = scaled(45_000);
/** A lease whose last heartbeat is at most this old shows its helper is running: three heartbeats (src/remote/protocol.ts HEARTBEAT_S, 30 s). */
export const LIVE_LEASE_MS = 3 * scaled(30 * 1000);
export const DROP_WINDOW_MS = scaled(2 * 3600_000);
export const FAILURE_WINDOW_MS = scaled(30 * 60_000);

/** Prompts that judge an item: an author or co-author of an item they judge gets their calls only when no other runner that could take them asks for work. */
const JUDGING = new Set(["review.opus", "premerge.opus", "postmerge.opus", "fixup.check", "conversation.turn", "interactive.conversation-turn", "verify.compare", "classify.haiku", "security.verify", "security.fixcheck"]);
export const judges = (promptId: string): boolean => JUDGING.has(promptId) || promptId.startsWith("dupes.compare-");

/** The named lock of one login's lease transactions (lowercase). */
export const remoteLeaseLock = (login: string): string => `remote-lease:${login.toLowerCase()}`;

export const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

const ident = (_eb: Eb, p: string, name: string) => ref<any>(p ? `${p}.${name}` : name);

/** The dashboard is serving: no stamp ever written counts as serving. */
export function dashboardAliveExpr(eb: Eb, now: number): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  const stamp = w.selectFrom("main.remote_liveness as lv").select("lv.alive_at").where("lv.id", "=", 1);
  return w.or([w.not(w.exists(stamp)), w(stamp, ">=", now - ALIVE_STALE_MS)]);
}
/** The dashboard has served without a gap for the whole idle window (a stamp never written counts as such). */
function idleWindowExpr(eb: Eb, now: number): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  const stamp = w.selectFrom("main.remote_liveness as lv").select("lv.since").where("lv.id", "=", 1);
  return w.or([w.not(w.exists(stamp)), w(stamp, "<=", now - LEASE_IDLE_MS)]);
}

/**
 * A `remote_calls` row (column prefix `p`, none for the unaliased table) whose lease is lost at `now`: leased, the dashboard serving, and
 * no heartbeat for LEASE_IDLE_MS (when it served for the whole window), or still preparing past PREPARE_MS, or running past its limit.
 * Expiry, the heartbeat and the lease routes share this one definition.
 */
export function lostLeaseExpr(_db: Db, eb: Eb, now: number, p = ""): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  const c = (n: string) => ident(eb, p, n);
  return w.and([
    w(c("state"), "=", literal("leased")),
    dashboardAliveExpr(eb, now),
    w.or([
      w.and([idleWindowExpr(eb, now), w(c("heartbeat_at"), "<", now - LEASE_IDLE_MS)]),
      w.and([w(c("started_at"), "is", null), w(w(c("leased_at"), "+", PREPARE_MS), "<", now)]),
      w.and([w(c("started_at"), "is not", null), w(w(w(c("started_at"), "+", c("timeout_ms")), "+", LEASE_MARGIN_MS), "<", now)]),
    ]),
  ]);
}

/** The reason text of a lost lease, in SQL, so the row and its run say the same. */
export function lostReasonExpr(eb: Eb, now: number): Expression<string> {
  const w = schemaEb(eb) as any;
  return w.case()
    .when(w.and([idleWindowExpr(eb, now), w(ref("heartbeat_at"), "<", now - LEASE_IDLE_MS)])).then(`lease expired: no heartbeat for ${Math.round(LEASE_IDLE_MS / 1000)} s`)
    .when(w(ref("started_at"), "is", null)).then(`lease expired: still preparing ${Math.round(PREPARE_MS / 1000)} s after the claim`)
    .else("lease expired: past the call's time limit").end();
}

// ---- queue cache (per handle, 2 s) ------------------------------------------------------------------------------------

type QueueCache = { at: number; snapshot: QueueSnapshot };
const queueCaches = new WeakMap<Db, QueueCache>();
const dropHooks: ((db: Db) => void)[] = [];

/** Registers a function that forgets a cache derived from the queue (the runner snapshot), called with every drop of the queue cache. */
export const onQueueDrop = (fn: (db: Db) => void): void => void dropHooks.push(fn);
/** Forgets the cached queue: a writer of this process changed it. Other processes' changes show in the signature or within QUEUE_CACHE_MS. */
export function dropQueueCache(db: Db): void {
  queueCaches.delete(db);
  for (const h of dropHooks) h(db);
}
/** The cached queue read within the window; it stands while its signature is still the queue's. */
export const cachedQueue = (db: Db, now: number): QueueSnapshot | null => {
  const hit = queueCaches.get(db);
  return hit && now >= hit.at && now - hit.at < QUEUE_CACHE_MS ? hit.snapshot : null;
};
export const storeQueue = (db: Db, snapshot: QueueSnapshot, now: number): void => void queueCaches.set(db, { at: now, snapshot });
export const queueSignature = (n: number, newest: number | null): string => `${n}:${newest}`;

/** Takes a call this process just leased out of the cached queue, so a burst of claims does not rebuild it after every lease. */
export function takeFromQueueCache(db: Db, id: number): void {
  const c = queueCaches.get(db);
  if (!c) return;
  const calls = c.snapshot.calls.filter((r) => r.id !== id);
  if (calls.length === c.snapshot.calls.length) return dropQueueCache(db);
  let m: number | null = null;
  for (const r of calls) if (m === null || r.id > m) m = r.id;
  c.snapshot = { ...c.snapshot, calls, signature: queueSignature(calls.length, m) };
  for (const h of dropHooks) h(db);
}

/** The parsed texts of queued calls by id; they never change. */
export type Parsed = { refs: import("./types.ts").QueuedCall["refs"]; repos: string[]; authors: ReadonlySet<string> };
const parsedCalls = new WeakMap<Db, Map<number, Parsed>>();
export const parsedOf = (db: Db): ReadonlyMap<number, Parsed> => parsedCalls.get(db) ?? new Map();
export const keepParsed = (db: Db, m: Map<number, Parsed>): void => void parsedCalls.set(db, m);

/** SET value of `queued_ms` for a call that ends or leaves the queue at `now`: the time it waited since `queued_since` is added. */
export function queuedMsAfter(db: Db, eb: Eb, now: number): Expression<number> {
  const w = schemaEb(eb) as any;
  return w("queued_ms", "+", w.case().when("queued_since", "is", null).then(w.lit(0)).else(greatest(db, [w.lit(0), w(w.val(now), "-", w.ref("queued_since"))])).end());
}

/**
 * Starts the error of a call withdrawn because of its item: the item merged or closed, a person ended its work, or a person's workflow
 * took it over. The job awaiting such a call skips the item without a failure and asks no model again (src/remote/calls.ts awaitCall).
 */
export const ITEM_WITHDRAWN_PREFIX = "withdrawn for the item: ";

/** Starts the error of a call that ended because the model's safety filter declined it. */
export const REFUSED_PREFIX = "refused by the model's safety filter";
