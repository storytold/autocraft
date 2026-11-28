// The lease writer (package runners-a).
// reads: access.mcp_tokens (the credential is live at the instant of the lease, inside the lease update)
import { randomBytes } from "node:crypto";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { ciEq, indexedBy, literal, schemaEb } from "../../db/kx.ts";
import { openRun } from "../inference/index.ts";
import { manualOnlyExpr } from "./fragments.ts";
import { INTERACTIVE_PROMPTS, LEASE_PREFIX, queuedMsAfter, remoteLeaseLock, sha256hex, takeFromQueueCache } from "./calls-shared.ts";
import { boundTakeAllows, itemsGoneExpr, leasedCountExpr, pickLapsedExpr, startedWorkAllows } from "./cross.ts";
import type { Lease, LeaseRequest } from "./types.ts";

/** Thrown in the lease transaction when the update took no row: the run opened for the call goes with the rollback. */
class Missed extends Error {
  result: "limit" | null;
  constructor(result: "limit" | null) {
    super("lease missed");
    this.result = result;
  }
}

const interactiveCount = (db: Db, eb: any, login: string) => schemaEb(eb).selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased_own", "il")).select((e) => e.fn.countAll<number>().as("n"))
  .where("il.state", "=", literal("leased")).where("il.own_lane", "=", literal(1)).where(ciEq(db, "il.user_login", (eb as any).val(login))).where((e) => e.or(INTERACTIVE_PROMPTS.map((p) => e("il.prompt_id", "like", `${p}%`))));

/**
 * Leases a call inside one transaction under the module lock `remote-lease:<login>`: opens the agent run, then one compare-and-set
 * `UPDATE remote_calls ... WHERE state = 'queued'` with every condition in the statement (pick, refused token, bound login, items not all merged or
 * closed, Manual only or the started-work check, the credential still valid, the caps), then clears the helper's idle mark. A miss runs one diagnostic read and rolls back.
 * Two claims of one call: the update changes one row for exactly one of them. Must not be called inside an outer `db.write`.
 */
export async function leaseCall(db: Db, req: LeaseRequest): Promise<Lease | "limit" | "gone" | null> {
  const q = queryDb(db);
  const { caller, claim, now, caps } = req;
  const secret = `${LEASE_PREFIX}${randomBytes(32).toString("base64url")}`;
  const login = caller.login;
  try {
    return await db.write(async () => {
      if (!req.live()) return "gone";
      const s = req.source;
      const runId = await openRun(db, { jobId: s.jobId, step: s.step, stage: s.stage, promptId: s.promptId, promptVersion: s.promptVersion, provider: "claude", model: s.askedModel,
        items: s.items, prompt: req.prompt, remote: { callId: req.id, userLogin: login, tokenId: caller.tokenId, harness: claim.harness, reportedModel: req.model } });
      const r = await q.get(q.k.updateTable("main.remote_calls").set((eb) => ({
        state: "leased", token_id: caller.tokenId, user_login: login, harness: claim.harness, harness_version: claim.harnessVersion, model: req.model, root: claim.root ?? null,
        lease_secret_hash: sha256hex(secret), leased_at: now, heartbeat_at: now, started_at: null, lease_timeout_ms: req.timeoutMs ?? null, claim_id: claim.requestId ?? null, run_id: runId,
        own_lane: claim.ownLane || caps.interactive !== null ? 1 : 0, ...(req.rewrite && { bundle: req.rewrite.bundle, base_stdin: req.rewrite.baseStdin }),
        queued_ms: queuedMsAfter(db, eb, now), queued_since: null, progress: null, error: null, picked_by: null, picked_at: null, pick_until: null, no_taker_since: null,
      }) as any).where("id", "=", req.id).where("state", "=", literal("queued"))
        .where((eb) => eb.or([eb("picked_by", "is", null), eb("picked_by", "=", login), pickLapsedExpr(db, eb, now)]))
        // The runner whose model declined the call does not take it again (another process's queue cache may still offer it).
        .where((eb) => eb.or([eb("refused_token", "is", null), eb("refused_token", "!=", caller.tokenId)]))
        // Only the user a call is bound to takes it, or for an item workflow's bound work a person who took it while that user's runners cannot (boundTakeAllows).
        // A Manual only caller takes only follow-ups, its own picks, bound calls it may take and calls for work it started or approved.
        .where((eb) => eb.or([eb("for_login", "is", null), eb("for_login", "=", login), boundTakeAllows(db, eb, login, { now, tierTokens: req.tierTokens ?? [] })]))
        // A call whose items all merged or closed meanwhile is no one's work any more (sync withdraws it).
        .where((eb) => eb.not(itemsGoneExpr(eb, "remote_calls.id", { promptId: "remote_calls.prompt_id", forLogin: "remote_calls.for_login", step: "remote_calls.step" })))
        .where((eb) => (req.started ? startedWorkAllows(db, eb, login, "remote_calls.id", { stepRef: "remote_calls.step", repoRef: "remote_calls.repo", now, tierTokens: req.tierTokens ?? [] })
          : eb.or([eb.not(manualOnlyExpr(eb, eb.val(login))), eb("parent_id", "is not", null), eb("picked_by", "=", login), eb("for_login", "is not", null)])))
        .where((eb) => eb.exists(schemaEb(eb).selectFrom("main.mcp_tokens as lt").select(eb.lit(1).as("one")).where("lt.id", "=", caller.tokenId).where("lt.kind", "=", "runner").where("lt.expires_at", ">", new Date(now).toISOString())))
        .$if(caps.perLogin !== null, (b) => b.where((eb) => eb(leasedCountExpr(db, eb, eb.val(login)), "<", caps.perLogin!)))
        .$if(caps.interactive !== null, (b) => b.where((eb) => eb(interactiveCount(db, eb, login), "<", caps.interactive!)))
        .returning("attempt"));
      if (!r) {
        // Why: at a cap, or taken, withdrawn or no longer allowed (one read; the transaction rolls back and the run with it).
        const n = (await q.get(q.k.selectNoFrom((eb) => [(leasedCountExpr(db, eb, eb.val(login)) as any).as("leased"), (interactiveCount(db, eb, login) as any).as("interactive")] as any))) as { leased: number; interactive: number };
        const limited = (caps.perLogin !== null && Number(n.leased) >= caps.perLogin) || (caps.interactive !== null && Number(n.interactive) >= caps.interactive);
        throw new Missed(limited ? "limit" : null);
      }
      // The fast lane says nothing about the helper's other slots: only their claims mark it idle or busy.
      if (req.clearIdle) await q.run(q.k.updateTable("main.remote_helpers").set({ idle_claim_at: null }).where("token_id", "=", caller.tokenId));
      return { id: req.id, secret, runId, bundle: req.rewrite?.bundle ?? req.source.bundle, attempt: Number(r.attempt) };
    }, { lock: remoteLeaseLock(login) }).then((res) => {
      if (typeof res === "object" && res !== null) takeFromQueueCache(db, req.id);
      return res;
    });
  } catch (e) {
    if (e instanceof Missed) return e.result;
    throw e;
  }
}
