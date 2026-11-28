// The mechanics of one session turn, shared by the engines that run a model session in a workspace: a call bound to its
// queuer, queued together with its workspace_sessions row and its round; settled when the call returns, or after a
// restart that left the round queued. What a round is and how its reply is read belong to the engine's RoundStore.
import type { Db } from "../db/index.ts";
import { addSession, loadSessions, patchSessions } from "../data/build/index.ts";
import { loadCalls } from "../data/runners/index.ts";
import { queueWorkspaceCall, type WorkspaceCallRequest } from "./workspace-call.ts";
import { sessionStats } from "./workspace-session.ts";
import { cleanOutput, getWorkspace } from "./workspaces.ts";
import { awaitCall, type Outcome } from "../remote/calls.ts";

/** The most a turn may wait in the queue for the queuer's Task Runner; past it the call is withdrawn and the job ends. */
export const QUEUE_WAIT_MS = 30 * 60_000;

/** The model calls a build makes. Tests replace them. */
export type CallDeps = {
  queue(db: Db, r: WorkspaceCallRequest): Promise<number>;
  await(db: Db, id: number, o: { log: (line: string) => void; maxWaitMs: number }): Promise<Outcome>;
};
export const realCalls: CallDeps = { queue: queueWorkspaceCall, await: async (db, id, o) => await awaitCall(db, id, o) };

/**
 * The result of a turn round. `queued`: the call is not read yet. `withdrawn`: the call ended without its turn being
 * worked (no Task Runner took it, the pipeline stopped, or no job read it); the turn is made again.
 */
export type TurnResult<Report extends { status: string }> = {
  purpose: string;
  outcome: "queued" | "done" | "failed" | "unclaimed" | "withdrawn";
  error?: string;
  report: Report | null;
  /** Why the reply is not the report. */
  parseError?: string;
  /** The reply was read and lost before its round was written. */
  lost?: boolean;
  turns: number | null;
  costUsd: number | null;
  calls: number;
  shellMs: number;
  /** The turn's workspace_sessions row. */
  session?: number;
};

/** What a turn queued by the engine is: its call, its round and the facts of its workspace_sessions row. */
export type TurnPlan<T> = {
  call: WorkspaceCallRequest;
  /** The id of what the round belongs to (an attempt). */
  owner: number;
  /** The round's kind. */
  kind: string;
  /** The queued result; the session row's id is added to it. */
  result: T;
  session: { repo: string; item: number; baseSha: string; requestedBy: string; deadlineSec: number };
};

/** The operations the turn mechanics need on an engine's rounds and on how its replies are read. */
export type RoundStore<T extends TurnResult<{ status: string }>, Round extends { id: number; callId: number | null; result: unknown }, Request extends { workspaceId: number }, Prepared, P> = {
  /** The kind of the turn's workspace_sessions rows. */
  sessionKind: string;
  /** Before the write: what the plan needs that is read outside it. */
  prepare(db: Db, t: Request): Promise<Prepared>;
  /** Inside the write: the call and round of the turn, with the workspace as stored (undefined when gone). */
  plan(db: Db, t: Request, prepared: Prepared, workspace: { base_sha?: string | null; env_id?: string | null } | undefined): Promise<TurnPlan<T>>;
  /** Writes a new round (the turn's queued round) and returns it. */
  add(db: Db, owner: number, round: { kind: string; callId: number; result: T }, at: string): Promise<Round>;
  /** Replaces the result of a round. */
  set(db: Db, round: Round, result: T): Promise<void>;
  /** Reads the reply of a done call against its queued round: the report, or why it is not one. */
  parse(queued: T, text: string): { report: NonNullable<T["report"]> } | { error: string };
  /** After the reply is stored and the tool-call counts are in: whatever the reply names (screenshots). */
  afterReply(db: Db, pod: P | null, round: Round, r: T): Promise<void>;
};

/**
 * Queues a turn: a call bound to the queuer, in one of their Task Runner's normal slots, with the harness session kept for
 * follow-ups. The call, its workspace_sessions row and its round (outcome `queued`, with the turn's purpose) are one write,
 * so a restart at any point finds either no call or the round that says what the call is for.
 */
export async function queueTurn<T extends TurnResult<{ status: string }>, Round extends { id: number; callId: number | null; result: unknown }, Request extends { workspaceId: number }, Prepared, P>(
  db: Db, calls: CallDeps, store: RoundStore<T, Round, Request, Prepared, P>, t: Request,
): Promise<Round> {
  const prepared = await store.prepare(db, t);
  return await db.write(async () => {
    const w = await getWorkspace(db, t.workspaceId);
    const p = await store.plan(db, t, prepared, w);
    const callId = await calls.queue(db, p.call);
    // A workspace_sessions row per turn, kept with the workspace: the attempt's workspace outlives each job.
    const at = new Date().toISOString();
    const session = await addSession(db, {
      kind: store.sessionKind, repo: p.session.repo, base_sha: w?.base_sha ?? p.session.baseSha, item: p.session.item, prompt: null, env_id: w?.env_id ?? "", keep: 1,
      deadline_sec: p.session.deadlineSec, state: "running", workspace_id: t.workspaceId, remote_call_id: callId, requested_by: p.session.requestedBy, created_at: at, updated_at: at,
    });
    return await store.add(db, p.owner, { kind: p.kind, callId, result: { ...p.result, session } }, at);
  });
}

const endSession = async <T extends TurnResult<{ status: string }>>(db: Db, kind: string, callId: number, r: T): Promise<void> => {
  const at = new Date().toISOString();
  // Turns queued before the round named its session row find it by the call.
  const ids = r.session !== undefined ? [r.session] : [...(await loadSessions(db, { remoteCallId: callId })).values()].flat().filter((x) => x.kind === kind).map((x) => Number(x.id));
  await patchSessions(db, ids.map((id) => ({ id, set: { state: r.outcome === "done" ? "done" : "failed", outcome: `${r.purpose}: ${r.outcome}${r.report ? ` (${r.report.status})` : ""}`.slice(0, 300), ended_at: at } })));
};

/**
 * Settles a queued turn round whose job ended before it read the call (a restart): a call still open, or answered and not
 * yet read, is waited for (awaitTurn); a reply read and lost before its round was written is `done` with `lost` set, so a
 * report turn asks for it again; a call withdrawn or failed meanwhile is `withdrawn`, and the turn is made again.
 * Null: the round needs awaitTurn.
 */
export async function settleOrphan<T extends TurnResult<{ status: string }>, Round extends { id: number; callId: number | null; result: unknown }, Request extends { workspaceId: number }, Prepared, P>(
  db: Db, store: RoundStore<T, Round, Request, Prepared, P>, round: Round, log: (line: string) => void,
): Promise<T | null> {
  const queued = round.result as T;
  const c = round.callId === null ? undefined : (await loadCalls(db, [round.callId])).get(round.callId);
  if (c && (c.state === "queued" || c.state === "leased" || (c.state === "done" && c.consumedAt === null))) return null;
  const r: T = c?.state === "done"
    ? { ...queued, outcome: "done", lost: true, parseError: "the reply was read before a restart and not stored" }
    : { ...queued, outcome: "withdrawn", error: c ? "the call ended without a reader" : "the call is gone" };
  await store.set(db, round, r);
  if (round.callId !== null) await endSession(db, store.sessionKind, round.callId, r);
  log(`turn ${round.callId} (${r.purpose}): ${r.lost ? "its reply was lost in a restart" : "withdrawn while no job read it"}`);
  return r;
}

/**
 * Waits for a queued turn and settles its round. The parsed reply is written to the round as soon as the call returns
 * (the reply is gone from the call once read); tool-call counts and the screenshots are added after. NoTakerError,
 * WaitLimitError and halts pass through, with the round `withdrawn` when the call was.
 */
export async function awaitTurn<T extends TurnResult<{ status: string }>, Round extends { id: number; callId: number | null; result: unknown }, Request extends { workspaceId: number }, Prepared, P>(
  db: Db, calls: CallDeps, store: RoundStore<T, Round, Request, Prepared, P>, pod: P | null, o: { workspaceId: number; round: Round; log: (line: string) => void },
): Promise<T> {
  const callId = o.round.callId!;
  const queued = o.round.result as T;
  let out: Outcome;
  try {
    out = await calls.await(db, callId, { log: o.log, maxWaitMs: QUEUE_WAIT_MS });
  } catch (e) {
    const c = (await loadCalls(db, [callId])).get(callId);
    if (c?.state === "failed") {
      const r: T = { ...queued, outcome: "withdrawn", error: cleanOutput(Buffer.from((e as Error).message)).slice(0, 300) };
      await store.set(db, o.round, r);
      await endSession(db, store.sessionKind, callId, r);
    }
    throw e;
  }
  const r: T = { ...queued, outcome: out.state };
  if (out.state === "failed") r.error = cleanOutput(Buffer.from(out.error)).replace(/\s+/g, " ").slice(0, 300);
  if (out.state === "done") {
    r.turns = out.turns;
    r.costUsd = out.costUsd;
    const p = store.parse(queued, out.text);
    if ("error" in p) r.parseError = p.error;
    else r.report = p.report;
  }
  await store.set(db, o.round, r);
  const stats = await sessionStats(db, o.workspaceId, callId);
  r.calls = stats.calls;
  r.shellMs = stats.shellMs;
  await store.afterReply(db, pod, o.round, r);
  await store.set(db, o.round, r);
  await endSession(db, store.sessionKind, callId, r);
  o.log(`turn ${callId} (${r.purpose}): ${r.outcome}${r.error ? `: ${r.error}` : ""}${r.parseError ? `; not the report: ${r.parseError}` : ""}${r.report ? `; ${r.report.status}` : ""}; ${r.calls} tool calls`);
  return r;
}
