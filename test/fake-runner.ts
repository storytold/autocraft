// A stand-in for a Task Runner: it claims every queued remote call, hands the call's bundle to `answer` and submits what
// `answer` returns, as a maintainer's `autocraft` command would. Tests that reach askClaude use it instead of a fake `claude`.
import { allocation } from "../src/agents/call.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { bundleOf, claimCall, heartbeat, submitCall, type Caller } from "../src/remote/calls.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { PROTOCOL_VERSION, type TaskBundle, type SubmitTool } from "../src/remote/protocol.ts";
import type { Db } from "./helpers/raw-db.ts";

/** What a call hands the runner: its bundle, with the call id. `beat` sends a heartbeat with a progress line. */
export type FakeCall = TaskBundle;
/** The reply text; `undefined` fails the call with "no reply". An object adds the tool uses and the turns the helper reports. */
export type FakeReply = string | undefined | { text: string; turns?: number; sessionId?: string; tools?: SubmitTool[]; usage?: { inputTokens: number; outputTokens: number } };

const MODEL_OF_TIER = { top: "claude-opus-4-5", mid: "claude-sonnet-4-5", small: "claude-haiku-4-5" } as const;

export type FakeRunner = {
  /** Every call the runner took, in order. */
  calls: FakeCall[];
  /** Stops claiming; resolves when the claim in flight has ended. */
  stop(): Promise<void>;
};

/** A Task Runner that reports in (fresh, ready, `slots` calls at once, every tier) and claims nothing: the room and takers that pools and planners read. Returns its token id. */
export async function reportingTaskRunner(db: Db, login = "fake-runner", slots = 8, role: "operator" | "maintainer" = "operator"): Promise<number> {
  await db.run(db.k.insertInto("access").values({ login, role }).onConflict((oc) => oc.doNothing()));
  const id = (await createToken(db, login, "fake runner", { kind: "runner" })).row.id;
  // A fresh, ready status makes the runner a taker for every tier: callers queue calls only when a Task Runner may take them.
  await storeStatus(db, id, login, parseStatus({ slots, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", mid: "sonnet", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
  // Its last claim found nothing a moment ago: that is what makes a runner count as room.
  await db.run(db.k.updateTable("remote_helpers").set({ idle_claim_at: Date.now(), idle_tiers: JSON.stringify(["top", "mid", "small"]) }).where("token_id", "=", id));
  return id;
}

/** Starts a runner for `login` (by default an operator, so any call fits it) and returns its handle. */
export async function fakeTaskRunner(db: Db, answer: (call: FakeCall, beat: (progress: string) => Promise<void>) => FakeReply | Promise<FakeReply>, login = "fake-runner", role: "operator" | "maintainer" = "operator"): Promise<FakeRunner> {
  allocation.pollMs = Math.min(allocation.pollMs, 10);
  const caller: Caller = { tokenId: await reportingTaskRunner(db, login, 4, role), login, role };
  const calls: FakeCall[] = [];
  let stopped = false, n = 0;
  /** The calls whose session the runner keeps: it claims their follow-ups first. */
  const sessions: number[] = [];
  const loop = (async () => {
    while (!stopped) {
      try {
        const r = await claimCall(db, caller, { requestId: `fake-claim-${login}-${String(++n).padStart(6, "0")}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1.323", tiers: MODEL_OF_TIER, sessions }, async () => true);
        const b = r.lease ? await bundleOf(db, r.lease.secret) : null;
        if (!r.lease || !b) { await new Promise((res) => setTimeout(res, 5)); continue; }
        calls.push(b);
        const secret = r.lease.secret;
        const out = await answer(b, async (progress) => { await heartbeat(db, secret, { phase: "running", progress }); });
        if (typeof out === "object" && out.sessionId) sessions.push(b.callId);
        const usage = { inputTokens: 100, outputTokens: 10 };
        await submitCall(db, r.lease.secret, out === undefined
          ? { ok: false, error: "no reply", durationMs: 1 }
          : { ok: true, text: typeof out === "string" ? out : out.text, model: MODEL_OF_TIER[b.tier], usage: typeof out === "string" ? usage : out.usage ?? usage,
            ...(typeof out !== "string" && { turns: out.turns, tools: out.tools, sessionId: out.sessionId }), durationMs: 1 });
      } catch (e) {
        if (stopped) return;
        console.log(`fake runner: ${(e as Error).message}`);
        await new Promise((res) => setTimeout(res, 20));
      }
    }
  })();
  return { calls, stop: async () => { stopped = true; await loop; } };
}
