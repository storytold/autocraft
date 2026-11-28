// Fix rounds and the fix log (package security).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { nowIso } from "./internal.ts";
import { findingKey, type FindingKey, type LogRound, type RoundRow, type SessionRow } from "./types.ts";

/** Live rounds per finding, ordered by round. */
export async function loadRounds(db: Db, keys: FindingKey[]): Promise<Map<FindingKey, RoundRow[]>> {
  const out = new Map<FindingKey, RoundRow[]>();
  if (keys.length === 0) return out;
  const q = queryDb(db);
  for (const chunk of kx.chunks(keys)) {
    for (const r of await q.all(q.k.selectFrom("security_fix_rounds as r").select(kx.cols("security_fix_rounds", "r")).where(kx.refIn(db, "r", chunk)).orderBy("r.repo").orderBy("r.number").orderBy("r.round"))) {
      const k = findingKey(r.repo, r.number);
      out.set(k, [...(out.get(k) ?? []), r]);
    }
  }
  return out;
}

/** The fix log per finding, ordered by attempt and round. */
export async function loadRoundLog(db: Db, keys: FindingKey[]): Promise<Map<FindingKey, LogRound[]>> {
  const out = new Map<FindingKey, LogRound[]>();
  if (keys.length === 0) return out;
  const q = queryDb(db);
  for (const chunk of kx.chunks(keys)) {
    for (const r of await q.all(q.k.selectFrom("security_fix_log as l").select(kx.cols("security_fix_log", "l")).where(kx.refIn(db, "l", chunk)).orderBy("l.repo").orderBy("l.number").orderBy("l.attempt").orderBy("l.round"))) {
      const k = findingKey(r.repo, r.number);
      out.set(k, [...(out.get(k) ?? []), r]);
    }
  }
  return out;
}

const ROUND_COLS = ["patch", "test_patch", "title", "summary", "head_task", "base_task", "retried", "session", "session_turn", "state", "failure", "created_at"] as const;

/** Inserts a round or replaces every column of the round with the same number (a `session_turn` left out is null). */
export async function saveRound(db: Db, r: Omit<RoundRow, "session_turn"> & { session_turn?: number | null }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("security_fix_rounds").values({ ...r, session_turn: r.session_turn ?? null }).onConflict((oc) => oc.columns(["repo", "number", "round"]).doUpdateSet(kx.excluded(ROUND_COLS))));
}

/** Patches rounds, one statement per distinct set of patched columns. Returns the rows changed. */
export async function markRounds(db: Db, rows: { repo: string; number: number; round: number; set: Partial<RoundRow> }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const shapes = new Map<string, typeof rows>();
  for (const r of rows) {
    const shape = Object.keys(r.set).sort().join(",");
    shapes.set(shape, [...(shapes.get(shape) ?? []), r]);
  }
  let changed = 0;
  await db.write(async () => {
    for (const [shape, group] of shapes) {
      if (!shape) continue;
      changed += await kx.updateFrom(db, "security_fix_rounds", ["repo", "number", "round"], group.map((r) => ({ repo: r.repo, number: r.number, round: r.round, ...(r.set as Record<string, string | number | null>) })), shape.split(","));
    }
  });
  return changed;
}

/**
 * Logs the rounds of the findings under the finding's `fix_attempts` (a `building` round of a `ready` finding logs as `passed`)
 * and deletes them, returning the stored sessions. The caller removes the session directories after the transaction commits.
 */
export async function clearRounds(db: Db, keys: FindingKey[]): Promise<{ sessions: string[] }> {
  if (keys.length === 0) return { sessions: [] };
  const q = queryDb(db);
  const ended = nowIso();
  const sessions: string[] = [];
  await db.write(async () => {
    for (const chunk of kx.chunks(keys)) {
      const select = q.k.selectFrom("security_fix_rounds as r").leftJoin("security_findings as f", (j) => j.onRef("f.repo", "=", "r.repo").onRef("f.number", "=", "r.number"))
        .select((eb) => ["r.repo", "r.number", eb.fn.coalesce("f.fix_attempts", eb.lit(0)).as("attempt"), "r.round",
          eb.case().when(eb.and([eb("r.state", "=", "building"), eb("f.state", "=", "ready")])).then("passed").else(eb.ref("r.state")).end().as("state"),
          "r.failure", "r.title", "r.created_at", eb.val(ended).as("ended_at")])
        .where(kx.refIn(db, "r", chunk));
      await q.run(q.k.insertInto("security_fix_log").columns(["repo", "number", "attempt", "round", "state", "failure", "title", "created_at", "ended_at"]).expression(select)
        .onConflict((oc) => oc.columns(["repo", "number", "attempt", "round"]).doUpdateSet(kx.excluded(["state", "failure", "title", "created_at", "ended_at"]))));
      const gone = await q.all(q.k.deleteFrom("security_fix_rounds").where(kx.refIn(db, "security_fix_rounds", chunk)).returning("session"));
      for (const g of gone) if (g.session) sessions.push(g.session);
    }
  });
  return { sessions };
}

/** Rounds with a stored session, for the session sweep; the waiting state is applied in pure code. */
export async function loadFixSessionRows(db: Db): Promise<SessionRow[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("security_fix_rounds").select(["repo", "number", "round", "state", "session"]).where("session", "is not", null).orderBy("repo").orderBy("number").orderBy("round"));
  return rows.map((r) => ({ kind: "security", id: `${r.repo}#${r.number}#${r.round}`, state: r.state, session: r.session }));
}

/** Sets `session = NULL` on rounds. Returns the rows changed. */
export async function clearSessions(db: Db, rows: { repo: string; number: number; round: number }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const q = queryDb(db);
  let changed = 0;
  await db.write(async () => {
    for (const chunk of kx.chunks(rows)) {
      changed += (await q.run(q.k.updateTable("security_fix_rounds").set({ session: null }).where(kx.tupleIn(db, ["repo", "number", "round"], chunk.map((r) => [r.repo, r.number, r.round]), ["text", "bigint", "bigint"])))).changes;
    }
  });
  return changed;
}
