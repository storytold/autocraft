// The fix sessions of the fix-up, CI fix, conflict and security fix steps (docs/pipeline.md, Fix-up): one live model session per
// item, kept in the item's workspace and continued turn by turn, until its PR is closed or merged, a person ends its workflow, it is
// idle for a day, or it has had its turns. Turn writers join the caller's transaction, so a turn row goes in with its queued call.
import { FIX_SESSION_CALL } from "./report.ts";
import type { Db } from "../db/index.ts";
import {
  addFixTurn, endFixSessions, ensureFixSession, loadFixSessionGate, loadFixSessions, loadFixTurns, loadFixTurnsById, loadLastFixTurn, loadLiveFixSessions,
  settleFixTurn, updateFixSession,
  type EndedFixSession, type EndGuard, type FixSession, type FixSessionEnd, type FixSessionKind, type FixSessionPatch, type FixTurn, type FixTurnOutcome, type FixTurnSettle, type NewFixTurn,
} from "../data/fixsession/index.ts";

export type { EndedFixSession, FixSession, FixSessionEnd, FixSessionKind, FixSessionPatch, FixStep, FixTurn, FixTurnOutcome, FixTurnPurpose, FixTurnSettle, NewFixTurn } from "../data/fixsession/index.ts";

/** A session without a write for this long ends: its workspace is not kept for work that may not come. */
export const SESSION_IDLE_MS = 24 * 3600_000;
/** A session with more turns than this ends, so its context stays small; the next step starts a fresh one. */
export const SESSION_MAX_TURNS = 8;

/**
 * A queued turn keeps its session from the idle and turn ends for this long after it was queued: a fix session call's time limit
 * (FIX_SESSION_CALL) plus its wait in the call queue (30 min). An older one is a leftover no job settles.
 */
export const QUEUED_TURN_MS = FIX_SESSION_CALL.timeoutSeconds * 1000 + 30 * 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();
/** The guard an idle or turns end re-checks when it writes, so a session touched or queued meanwhile stays live. */
const expiryGuard = (why: "idle" | "turns", nowMs: number): EndGuard => ({
  queuedSince: iso(nowMs - QUEUED_TURN_MS), ...(why === "idle" ? { idleBefore: iso(nowMs - SESSION_IDLE_MS) } : { maxTurns: SESSION_MAX_TURNS }),
});

/** Why a live session is past its use on its own counts (idle, turns), or null. */
export function expiredReason(s: FixSession, nowMs: number): "idle" | "turns" | null {
  if (s.turns > SESSION_MAX_TURNS) return "turns";
  if (Date.parse(s.updatedAt) < nowMs - SESSION_IDLE_MS) return "idle";
  return null;
}

/** ensureSession's answer when a person ended the item's workflow: no session is made, and a live one was ended (`ended`). */
export type SessionRefused = { refused: "stopped"; ended: EndedFixSession | null };

/**
 * The item's live session, or a new one. A live session past its idle time or turn cap is ended first and replaced, unless a turn
 * of it is still queued (its call may still run, and the step adopts it). `ended` names the replaced session, whose workspace the
 * caller ends. A continued session is touched, so its idle time starts again; its head and workspace move only with updateSession.
 * An item whose workflow a person ended (stopped, closed, backlog) gets no session, so the sweep and a step never end and make one
 * in turn: a live one is ended with reason `stopped`, and the answer is a SessionRefused.
 */
export async function ensureSession(db: Db, kind: FixSessionKind, repo: string, number: number, o: { model?: string | null; head?: string | null; workspaceId?: number | null; nowMs?: number } = {}):
  Promise<{ session: FixSession; created: boolean; ended: EndedFixSession | null } | SessionRefused> {
  const nowMs = o.nowMs ?? Date.now(), at = iso(nowMs);
  return await db.write(async () => {
    const g = await loadFixSessionGate(db, kind, repo, number, iso(nowMs - QUEUED_TURN_MS));
    if (g.stopped) return { refused: "stopped" as const, ended: g.live ? (await endFixSessions(db, [g.live.id], "stopped", at))[0] ?? null : null };
    const why = g.live && !g.queuedTurn ? expiredReason(g.live, nowMs) : null;
    const ended = g.live && why ? (await endFixSessions(db, [g.live.id], why, at, expiryGuard(why, nowMs)))[0] ?? null : null;
    const r = await ensureFixSession(db, { kind, repo, number, model: o.model, head: o.head, workspaceId: o.workspaceId }, at);
    return { ...r, ended };
  });
}

/** Ends a session with `reason`; null when it was not live. The caller ends its workspace. */
export async function endSession(db: Db, id: number, reason: FixSessionEnd, nowMs: number = Date.now()): Promise<EndedFixSession | null> {
  return (await endFixSessions(db, [id], reason, iso(nowMs)))[0] ?? null;
}

/**
 * Ends the live sessions that are done: the PR was closed or merged (a PR the mirror has not read yet is not), a person ended the
 * PR's workflow, or, while no turn of it is queued, the session has been idle for SESSION_IDLE_MS or has had more than
 * SESSION_MAX_TURNS turns. Returns the ended sessions, whose workspaces the caller ends.
 */
export async function endIdle(db: Db, nowMs: number = Date.now()): Promise<EndedFixSession[]> {
  const live = await loadLiveFixSessions(db, iso(nowMs - QUEUED_TURN_MS));
  const byReason = new Map<FixSessionEnd, number[]>();
  for (const l of live) {
    const why = l.closed ? "closed" : l.stopped ? "stopped" : l.queuedTurn ? null : expiredReason(l.session, nowMs);
    if (why) (byReason.get(why) ?? byReason.set(why, []).get(why)!).push(l.session.id);
  }
  if (!byReason.size) return [];
  const at = iso(nowMs);
  return await db.write(async () => {
    const out: EndedFixSession[] = [];
    for (const [why, ids] of byReason) out.push(...await endFixSessions(db, ids, why, at, why === "idle" || why === "turns" ? expiryGuard(why as "idle" | "turns", nowMs) : {}));
    return out.sort((a, b) => a.id - b.id);
  });
}

export const loadSessions = (db: Db, ids: readonly number[]): Promise<Map<number, FixSession>> => loadFixSessions(db, ids);

/** Moves the session on after a turn: what the next follow-up continues, its workspace and head, the turn and cost counts. */
export const updateSession = (db: Db, id: number, p: FixSessionPatch, nowMs: number = Date.now()): Promise<boolean> => updateFixSession(db, id, p, iso(nowMs));

/** Inserts a queued turn; call it inside the transaction that queues the turn's model call. */
export const addTurn = (db: Db, t: NewFixTurn, nowMs: number = Date.now()): Promise<number> => addFixTurn(db, t, iso(nowMs));

/** Settles a queued turn (or one in `from`); false when it had already moved. */
export const settleTurn = (db: Db, id: number, s: FixTurnSettle, o: { nowMs?: number; from?: readonly FixTurnOutcome[] } = {}): Promise<boolean> =>
  settleFixTurn(db, id, s, iso(o.nowMs ?? Date.now()), o.from);

export const lastTurn = (db: Db, sessionId: number): Promise<FixTurn | null> => loadLastFixTurn(db, sessionId);
export const turnsOf = (db: Db, sessionId: number): Promise<FixTurn[]> => loadFixTurns(db, sessionId);
export const loadTurns = (db: Db, ids: readonly number[]): Promise<Map<number, FixTurn>> => loadFixTurnsById(db, ids);
