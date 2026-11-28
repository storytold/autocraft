// Lease completion writers (package runners-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { finishRuns, saveTools, setReportedModel } from "../inference/index.ts";
import { noteFailure, noteSuccess } from "./cooloffs.ts";
import { ITEM_WITHDRAWN_PREFIX, REFUSED_PREFIX, dropQueueCache, sha256hex } from "./calls-shared.ts";
import { itemsGoneExpr } from "./cross.ts";
import { bury, requeue, unlease } from "./calls-unlease.ts";
import { moreTurns } from "../../remote/turn-limit.ts";
import type { LiveLease, ParsedSubmit, RefusalRetry, SubmitResult } from "./types.ts";

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Whether the call with this lease secret is done: a repeated submit of an accepted reply (its answer was lost) is accepted again. */
export async function loadSubmitted(db: Db, secret: string): Promise<boolean> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("main.remote_calls").select((eb) => eb.lit(1).as("one")).where("lease_secret_hash", "=", sha256hex(secret)).where("state", "=", "done"))) !== undefined;
}

/**
 * Stores a validated reply: compare-and-set to `done`, the success note, the reported model and the tool rows, in one transaction. `accepted: false`: the
 * lease ended meanwhile (another process expired it) and the reply is not taken (the route answers 410, or accepted when `loadSubmitted`).
 */
export async function submitLease(db: Db, lease: LiveLease, s: ParsedSubmit, now: number = Date.now()): Promise<SubmitResult> {
  const q = queryDb(db);
  return await db.write(async () => {
    const up = await q.run(q.k.updateTable("main.remote_calls").set({ state: "done", reply: s.reply, usage: JSON.stringify(s.usage), turns: s.turns, session_id: s.sessionId, duration_ms: s.durationMs, ended_at: now, progress: null })
      .where("id", "=", lease.id).where("state", "=", "leased").where("lease_secret_hash", "=", lease.secretHash));
    if (Number(up.changes) !== 1) return { accepted: false };
    await noteSuccess(db, [lease.login]);
    // The claim named the model the helper meant to run (often an alias); the reply names the one that ran.
    if (lease.runId !== null) {
      await setReportedModel(db, [{ id: lease.runId, model: s.model.slice(0, 100) }]);
      try { await q.attempt(async () => await saveTools(db, s.tools.map((t) => ({ ...t, runId: lease.runId! })))); } catch (e) { console.log(`tool uses of remote call ${lease.id} not stored: ${(e as Error).message}`); }
    }
    return { accepted: true };
  });
}

/**
 * Requeues with the helper's error, notes the failure and the last attempt's usage, in one transaction. The attempt's run keeps the error, the
 * tokens the attempt used (`usage` in the stored shape) and `output`, the stored form of the helper's whole failure text. `turnLimit`: the run
 * used every turn, and a call with a turn limit goes back to the queue with twice its turns and task budget (`moreTurns`; `promptBudget` is the
 * prompt's budget with tools), which its run's summary names. False when the lease was not the one named.
 */
export async function failLease(db: Db, lease: LiveLease, f: { error: string; skipLogin: boolean; usage: Tokens | null; duration: number; summary?: string; output?: Uint8Array; turnLimit?: { promptBudget: number | undefined } }, now: number): Promise<boolean> {
  const q = queryDb(db);
  return await db.write(async () => {
    const retry = f.turnLimit && lease.attempt < lease.maxAttempts;
    const more = retry ? moreTurns(JSON.parse((await q.get(q.k.selectFrom("main.remote_calls").select("bundle").where("id", "=", lease.id)))!.bundle), f.turnLimit!.promptBudget) : null;
    const summary = f.summary ?? "helper failed";
    const state = await requeue(db, { id: lease.id, runId: lease.runId, attempt: lease.attempt, maxAttempts: lease.maxAttempts, hash: lease.secretHash }, f.error, now,
      { ...(f.skipLogin && { skipLogin: lease.login }), summary: more ? `${summary}; retried with ${more.maxTurns} turns` : summary, ...(f.usage && { tokens: f.usage }), ...(f.output && { output: f.output }) });
    if (state === null) return false;
    // The bundle hash stays: a resumed job adopts the call as it was asked.
    if (more && state === "queued") await q.run(q.k.updateTable("main.remote_calls").set({ bundle: JSON.stringify(more) }).where("id", "=", lease.id).where("state", "=", "queued"));
    await noteFailure(db, lease.login, now);
    // The last attempt's tokens stay with the failed call.
    if (state === "failed") await q.run(q.k.updateTable("main.remote_calls").set({ usage: f.usage ? JSON.stringify(f.usage) : null, duration_ms: f.duration }).where("id", "=", lease.id).where("state", "=", "failed"));
    return true;
  });
}

/**
 * The safety-filter case: the call goes back to the queue once without using an attempt (`to`, decided by the pure `refusalRetry`), or fails as refused when
 * `to` is null. Neither counts toward the login's cool-off. Update, tombstone and run finish in one transaction. False when the lease was not the one named.
 */
export async function refuseLease(db: Db, lease: LiveLease, to: RefusalRetry, a: { error: string; usage: Tokens | null; duration: number; output?: Uint8Array }, now: number): Promise<boolean> {
  const q = queryDb(db);
  const by = `${lease.model ?? lease.askedModel} on ${lease.login}'s Task Runner`;
  const leaseWhere = (b: any) => b.where("id", "=", lease.id).where("state", "=", "leased").where("lease_secret_hash", "=", lease.secretHash);
  const ok = await db.write(async () => {
    if (to) {
      const bundle = "tier" in to ? JSON.stringify({ ...JSON.parse((await q.get(q.k.selectFrom("main.remote_calls").select("bundle").where("id", "=", lease.id)))!.bundle), tier: to.tier }) : null;
      const up = await q.run(leaseWhere(q.k.updateTable("main.remote_calls").set((eb) => ({
        state: "queued", refusals: eb("refusals", "+", 1), lease_secret_hash: null, token_id: null, claim_id: null, lease_timeout_ms: null, started_at: null, queued_since: now, error: a.error, progress: null,
        picked_by: null, picked_at: null, pick_until: null,
        // The bundle hash stays: a resumed job adopts the call as it was asked.
        ...("token" in to ? { refused_token: to.token } : { tier: to.tier, asked_model: to.model, bundle: bundle! }),
      }) as any)));
      if (Number(up.changes) !== 1) return false;
      await bury(db, [{ id: lease.id, hash: lease.secretHash }], now);
      const where = "token" in to ? "another Task Runner" : `the ${to.tier} tier (${to.model})`;
      if (lease.runId !== null) await finishRuns(db, [{ id: lease.runId, state: "failed", ...(a.usage && { tokens: a.usage }), error: a.error, summary: `refused by ${by}; retried on ${where}`, ...(a.output && { output: a.output }), refusal: "retried" }]);
      return true;
    }
    const why = lease.refusals > 0 ? `${REFUSED_PREFIX} again: ${by}, after the retry` : lease.parentId !== null ? `${REFUSED_PREFIX}: ${by}, in a follow-up turn` : `${REFUSED_PREFIX}: ${by}; no other Task Runner or tier could take the call`;
    const up = await q.run(leaseWhere(q.k.updateTable("main.remote_calls").set({
      state: "failed", error: why, ended_at: now, lease_secret_hash: null, token_id: null, claim_id: null, lease_timeout_ms: null, progress: null, usage: a.usage ? JSON.stringify(a.usage) : null, duration_ms: a.duration,
    })));
    if (Number(up.changes) !== 1) return false;
    await bury(db, [{ id: lease.id, hash: lease.secretHash }], now);
    if (lease.runId !== null) await finishRuns(db, [{ id: lease.runId, state: "failed", ...(a.usage && { tokens: a.usage }), error: `${why}. ${a.error}`, summary: `refused by ${by}`, ...(a.output && { output: a.output }), refusal: "failed" }]);
    return true;
  });
  if (ok) {
    dropQueueCache(db);
  }
  return ok;
}

/**
 * Puts the call back in the queue without using an attempt, a cool-off strike or a skip of its login, in one transaction with its run's finish,
 * which keeps the tokens the attempt used. False when the lease was not the one named.
 */
export async function returnLease(db: Db, lease: LiveLease, reason: string, a: { usage: Tokens | null; output?: Uint8Array }, now: number): Promise<boolean> {
  return await db.write(async () => {
    if (!(await unlease(db, { id: lease.id, runId: null, hash: lease.secretHash }, reason, now))) return false;
    if (lease.runId !== null) await finishRuns(db, [{ id: lease.runId, state: "failed", error: reason, summary: "returned to the queue", ...(a.usage && { tokens: a.usage }), ...(a.output && { output: a.output }) }]);
    return true;
  });
}

/**
 * Ends a lease whose call's items all merged or closed since it was leased (itemsGoneExpr), whatever the helper sent: the call fails with an
 * ITEM_WITHDRAWN_PREFIX error, so its job skips the item, and nothing of the result is applied, asked again or counted against the login. The
 * run keeps the tokens the attempt used. One compare-and-set, tombstone and run finish in one transaction; false when the lease is not the one
 * named or an item is still open.
 */
export async function discardGoneLease(db: Db, lease: LiveLease, a: { usage: Tokens | null; duration: number }, now: number): Promise<boolean> {
  const q = queryDb(db);
  const reason = `${ITEM_WITHDRAWN_PREFIX}every item it names was merged or closed while it ran; its result was discarded`;
  return await db.write(async () => {
    const up = await q.run(q.k.updateTable("main.remote_calls").set({ state: "failed", error: reason, ended_at: now, progress: null, usage: a.usage ? JSON.stringify(a.usage) : null, duration_ms: a.duration })
      .where("id", "=", lease.id).where("state", "=", "leased").where("lease_secret_hash", "=", lease.secretHash)
      .where((eb) => itemsGoneExpr(eb, "remote_calls.id", { promptId: "remote_calls.prompt_id", forLogin: "remote_calls.for_login", step: "remote_calls.step" })));
    if (Number(up.changes) !== 1) return false;
    await bury(db, [{ id: lease.id, hash: lease.secretHash }], now);
    if (lease.runId !== null) await finishRuns(db, [{ id: lease.runId, state: "failed", error: reason, summary: "result discarded", ...(a.usage && { tokens: a.usage }) }]);
    dropQueueCache(db);
    return true;
  });
}

/** Unleases with `released_by` and the skip `wait` (src/remote/calls.ts releaseWait), tombstone and run finish. False when the lease was not the one named. */
export async function releaseLease(db: Db, lease: LiveLease, reason: string, now: number, wait: { ms: number | null; setupRetry: boolean } = { ms: null, setupRetry: false }): Promise<boolean> {
  return await unlease(db, { id: lease.id, runId: lease.runId, hash: lease.secretHash }, reason, now, { login: lease.login, waitMs: wait.ms, setupRetry: wait.setupRetry });
}
