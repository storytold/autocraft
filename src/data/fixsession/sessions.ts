// Readers and writers of fix sessions and their turns. Each writer is atomic on its own (`db.write`) and joins an outer
// transaction, so a turn row is written in the transaction that queues its model call.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { itemNotMirrored, openItem } from "../mirror/fragments.ts";
import { endedByPerson } from "../workflow/fragments.ts";
import type {
  EndedFixSession, FixSession, FixSessionEnd, FixSessionKind, FixSessionPatch, FixTurn, FixTurnStep, FixTurnOutcome, FixTurnPurpose, FixTurnSettle, NewFixSession, NewFixTurn,
} from "./types.ts";

type Raw = Record<string, any>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const parse = (v: string | null): unknown => {
  if (v === null) return null;
  try { return JSON.parse(v) as unknown; } catch { return null; }
};

const sessionOf = (r: Raw): FixSession => ({
  id: Number(r.id), kind: r.kind as FixSessionKind, repo: r.repo, number: Number(r.number), workspaceId: num(r.workspace_id), head: r.head ?? null,
  lastCallId: num(r.last_call_id), model: r.model ?? null, turns: Number(r.turns), costUsd: Number(r.cost_usd), state: r.state === "live" ? "live" : "ended",
  endReason: r.end_reason ?? null, createdAt: r.created_at, updatedAt: r.updated_at, endedAt: r.ended_at ?? null,
});

const turnOf = (r: Raw): FixTurn => ({
  id: Number(r.id), sessionId: Number(r.session_id), step: r.step as FixTurnStep, purpose: r.purpose as FixTurnPurpose, head: r.head ?? null,
  callId: num(r.call_id), parentId: num(r.parent_id), outcome: r.outcome as FixTurnOutcome, report: parse(r.report ?? null), error: r.error ?? null,
  turns: num(r.turns), costUsd: num(r.cost_usd), toolCalls: num(r.tool_calls), shellMs: num(r.shell_ms), diffHash: r.diff_hash ?? null,
  createdAt: r.created_at, settledAt: r.settled_at ?? null,
});

/** The live session of an item, or null. 1 statement. */
export async function loadLiveFixSession(db: Db, kind: FixSessionKind, repo: string, number: number): Promise<FixSession | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.fix_sessions").selectAll().where("kind", "=", kind).where("repo", "=", repo).where("number", "=", number).where("state", "=", "live"));
  return r ? sessionOf(r) : null;
}

/**
 * The workspaces of live fix sessions of `kind` that are neither ready nor parked, as `id:state`, and those at another commit than
 * their session's head, as `id:state@commit`, sorted by id: a step that waited for one runs again when it moves
 * (fixWorkspaceReading). 1 statement.
 */
export async function loadFixWorkspaceWaits(db: Db, kind: FixSessionKind): Promise<string> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.fix_sessions as fs").innerJoin("main.workspaces as w", "w.id", "fs.workspace_id")
    .select(["w.id", "w.state", "w.base_sha", "fs.head"]).where("fs.kind", "=", kind).where("fs.state", "=", "live")
    .where((eb) => eb.or([eb("w.state", "not in", ["ready", "parked"]), eb.and([eb("fs.head", "is not", null), eb("w.base_sha", "<>", eb.ref("fs.head"))])])).orderBy("w.id"));
  return rows.map((r: Raw) => `${Number(r.id)}:${r.state}${r.head !== null && r.base_sha !== r.head ? `@${String(r.base_sha).slice(0, 12)}` : ""}`).join(",");
}

/**
 * Workspaces of `owner` (a fix session) at `head` that failed before they were ever ready, failed after `since` when given: the
 * session's start failures at that head. 1 statement.
 */
export async function countFixStartFailures(db: Db, owner: string, head: string, since: string | null): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.workspaces").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("owner", "=", owner).where("base_sha", "=", head).where("state", "=", "failed").where("base_commit", "is", null)
    .$if(since !== null, (b) => b.where("state_at", ">", since!)));
  return Number(r?.n ?? 0);
}

/** Sessions by id. 1 statement. */
export async function loadFixSessions(db: Db, ids: readonly number[]): Promise<Map<number, FixSession>> {
  const out = new Map<number, FixSession>();
  if (!ids.length) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("main.fix_sessions").selectAll().where(kx.inList(db, "id", [...ids], "bigint")))) out.set(Number(r.id), sessionOf(r));
  return out;
}

/** A turn of the session `id` (a column reference) queued after `since`: its call may still run. */
const queuedTurn = (eb: kx.AnyEb, id: string, since: string) =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.fix_session_turns as qt").select(eb.lit(1).as("one")).where("qt.session_id", "=", kx.ref<number>(id)).where("qt.outcome", "=", "queued")
    .where("qt.created_at", ">", since));

/**
 * What a step reads before it continues or starts an item's session: the live session, whether it has a turn queued after
 * `queuedSince`, and whether a person ended the item's workflow (stopped, closed or backlog; security sessions never are). 2 statements.
 */
export async function loadFixSessionGate(db: Db, kind: FixSessionKind, repo: string, number: number, queuedSince: string): Promise<{ live: FixSession | null; queuedTurn: boolean; stopped: boolean }> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.fix_sessions as fs").selectAll("fs").select((eb) => queuedTurn(eb, "fs.id", queuedSince).as("queued_turn"))
    .where("fs.kind", "=", kind).where("fs.repo", "=", repo).where("fs.number", "=", number).where("fs.state", "=", "live"));
  const stopped = kind === "pr" && Number((await q.get(q.k.selectNoFrom((eb) => eb.case().when(endedByPerson(eb, eb.val(repo), eb.val(number))).then(1).else(0).end().as("stopped"))))?.stopped) === 1;
  return { live: r ? sessionOf(r) : null, queuedTurn: !!r && Number((r as Raw).queued_turn) === 1, stopped };
}

/**
 * The item's live session, or a new one when it has none. The insert skips on the live unique index, so two writers get the same
 * row. A live session is only touched (`updated_at`), so its idle time starts again: `head`, `workspaceId` and `model` apply only to
 * a new one, and a caller that reseeds a live one's workspace follows with updateFixSession. 1 statement, 2 when the item already had
 * a live session.
 */
export async function ensureFixSession(db: Db, s: NewFixSession, at: string): Promise<{ session: FixSession; created: boolean }> {
  const q = queryDb(db);
  return await db.write(async () => {
    const made = await q.get(q.k.insertInto("main.fix_sessions").values({
      kind: s.kind, repo: s.repo, number: s.number, model: s.model ?? null, head: s.head ?? null, workspace_id: s.workspaceId ?? null, created_at: at, updated_at: at,
    }).onConflict((oc) => oc.columns(["kind", "repo", "number"]).where("state", "=", kx.literal("live")).doNothing()).returningAll());
    if (made) return { session: sessionOf(made), created: true };
    const live = await q.get(q.k.updateTable("main.fix_sessions").set({ updated_at: at })
      .where("kind", "=", s.kind).where("repo", "=", s.repo).where("number", "=", s.number).where("state", "=", "live").returningAll());
    if (!live) throw new Error(`fix session of ${s.repo}#${s.number} (${s.kind}) neither inserted nor live`);
    return { session: sessionOf(live), created: false };
  });
}

/** Moves a live session on: what the next follow-up continues, its workspace and head, and the turn and cost counts. False when it was not live. 1 statement. */
export async function updateFixSession(db: Db, id: number, p: FixSessionPatch, at: string): Promise<boolean> {
  const q = queryDb(db);
  const r = await db.write(async () => await q.get(q.k.updateTable("main.fix_sessions").set((eb) => ({
    updated_at: at,
    ...(p.lastCallId !== undefined && { last_call_id: p.lastCallId }),
    ...(p.head !== undefined && { head: p.head }),
    ...(p.workspaceId !== undefined && { workspace_id: p.workspaceId }),
    ...(p.model !== undefined && { model: p.model }),
    ...(p.addTurns && { turns: eb("turns", "+", p.addTurns) }),
    ...(p.addCostUsd && { cost_usd: eb("cost_usd", "+", p.addCostUsd) }),
  })).where("id", "=", id).where("state", "=", "live").returning("id")));
  return !!r;
}

/** What must still hold of a session when it ends: no write since `idleBefore`, more than `maxTurns` turns, no turn queued after `queuedSince`. */
export type EndGuard = { idleBefore?: string; maxTurns?: number; queuedSince?: string };

/** Ends live sessions with one reason, those that still meet `guard`. Returns the sessions that were live and ended. 1 statement. */
export async function endFixSessions(db: Db, ids: readonly number[], reason: FixSessionEnd, at: string, guard: EndGuard = {}): Promise<EndedFixSession[]> {
  if (!ids.length) return [];
  const q = queryDb(db);
  const rows = await db.write(async () => await q.all(q.k.updateTable("main.fix_sessions").set({ state: "ended", end_reason: reason, ended_at: at, updated_at: at })
    .where(kx.inList(db, "id", [...ids], "bigint")).where("state", "=", "live")
    .$if(guard.idleBefore !== undefined, (b) => b.where("updated_at", "<", guard.idleBefore!))
    .$if(guard.maxTurns !== undefined, (b) => b.where("turns", ">", guard.maxTurns!))
    .$if(guard.queuedSince !== undefined, (b) => b.where((eb) => eb.not(queuedTurn(eb as unknown as kx.AnyEb, "fix_sessions.id", guard.queuedSince!))))
    .returning(["id", "kind", "repo", "number", "workspace_id"])));
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind as FixSessionKind, repo: r.repo, number: Number(r.number), workspaceId: num(r.workspace_id), reason })).sort((a, b) => a.id - b.id);
}

/**
 * Live sessions with what the sweep reads of each: `closed` when the PR is in the mirror and not open, `stopped` when a person ended
 * its workflow (stopped, closed or backlog; for an implementation PR also its issue's), `queuedTurn` when a turn queued after
 * `queuedSince` may still run. Security sessions read neither closed nor stopped. 1 statement.
 */
export async function loadLiveFixSessions(db: Db, queuedSince: string): Promise<{ session: FixSession; closed: boolean; stopped: boolean; queuedTurn: boolean }[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.fix_sessions as fs").selectAll("fs").select((eb) => [
    eb.case().when("fs.kind", "<>", "pr").then(0).when(itemNotMirrored(eb, "fs.repo", "fs.number")).then(0).when(openItem(eb, "fs.repo", "fs.number")).then(0).else(1).end().as("pr_closed"),
    eb.case().when("fs.kind", "<>", "pr").then(0).when(endedByPerson(eb, "fs.repo", "fs.number")).then(1).else(0).end().as("wf_stopped"),
    eb.case().when(queuedTurn(eb, "fs.id", queuedSince)).then(1).else(0).end().as("queued_turn"),
  ]).where("fs.state", "=", "live").orderBy("fs.id"));
  return rows.map((r: Raw) => ({ session: sessionOf(r), closed: Number(r.pr_closed) === 1, stopped: Number(r.wf_stopped) === 1, queuedTurn: Number(r.queued_turn) === 1 }));
}

/** Inserts a queued turn and touches its session (`updated_at`), so the session's idle time starts again. 2 statements. */
export async function addFixTurn(db: Db, t: NewFixTurn, at: string): Promise<number> {
  const q = queryDb(db);
  return await db.write(async () => {
    const r = await q.get(q.k.insertInto("main.fix_session_turns").values({
      session_id: t.sessionId, step: t.step, purpose: t.purpose, head: t.head ?? null, call_id: t.callId ?? null, parent_id: t.parentId ?? null, created_at: at,
    }).returning("id"));
    await q.run(q.k.updateTable("main.fix_sessions").set({ updated_at: at }).where("id", "=", t.sessionId));
    return Number(r!.id);
  });
}

/**
 * Settles a turn: its outcome and what the call reported. Only a turn in one of `from` (default: queued) moves, so a turn adopted
 * after a restart is settled once. Returns whether it moved. 1 statement.
 */
export async function settleFixTurn(db: Db, id: number, s: FixTurnSettle, at: string, from: readonly FixTurnOutcome[] = ["queued"]): Promise<boolean> {
  if (!from.length) return false;
  const q = queryDb(db);
  const r = await db.write(async () => await q.get(q.k.updateTable("main.fix_session_turns").set({
    outcome: s.outcome, settled_at: at,
    ...(s.report !== undefined && { report: s.report === null ? null : JSON.stringify(s.report) }),
    ...(s.error !== undefined && { error: s.error }),
    ...(s.turns !== undefined && { turns: s.turns }),
    ...(s.costUsd !== undefined && { cost_usd: s.costUsd }),
    ...(s.toolCalls !== undefined && { tool_calls: s.toolCalls }),
    ...(s.shellMs !== undefined && { shell_ms: s.shellMs }),
    ...(s.diffHash !== undefined && { diff_hash: s.diffHash }),
  }).where("id", "=", id).where("outcome", "in", [...from]).returning("id")));
  return !!r;
}

/** A session's newest turn, or null. 1 statement. */
export async function loadLastFixTurn(db: Db, sessionId: number): Promise<FixTurn | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.fix_session_turns").selectAll().where("session_id", "=", sessionId).orderBy("id", "desc").limit(1));
  return r ? turnOf(r) : null;
}

/** A session's turns, oldest first (the history note of a fresh session reads them). 1 statement. */
export async function loadFixTurns(db: Db, sessionId: number): Promise<FixTurn[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.fix_session_turns").selectAll().where("session_id", "=", sessionId).orderBy("id"))).map(turnOf);
}

/** Turns by id. 1 statement. */
export async function loadFixTurnsById(db: Db, ids: readonly number[]): Promise<Map<number, FixTurn>> {
  const out = new Map<number, FixTurn>();
  if (!ids.length) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("main.fix_session_turns").selectAll().where(kx.inList(db, "id", [...ids], "bigint")))) out.set(Number(r.id), turnOf(r));
  return out;
}
