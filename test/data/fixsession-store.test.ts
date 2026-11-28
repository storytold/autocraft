// Fix sessions: which live sessions the sweep ends and why, a step never continuing one past its idle time or turn cap, and no
// session for an item a person stopped (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { addTurn, endIdle, ensureSession, SESSION_IDLE_MS, SESSION_MAX_TURNS, updateSession } from "../../src/fixsession/store.ts";

const NOW = Date.parse("2026-01-02T12:00:00.000Z");
const T = new Date(NOW).toISOString();

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

test("the sweep ends sessions of closed or merged PRs, stopped workflows, idle and over-turned sessions, and keeps the rest and those with a queued turn", async () => {
  const run = async (db: Db) => {
    const k = queryDb(db).k as any;
    const pr = (number: number, state: string) => ({ repo: "app", number, kind: "pr", state, author: "a", head_oid: `h${number}` });
    await queryDb(db).run(k.insertInto("main.items").values([pr(1, "OPEN"), pr(2, "MERGED"), pr(3, "CLOSED"), pr(4, "OPEN"), pr(5, "OPEN"), pr(6, "OPEN"), pr(8, "OPEN")]));
    const ids: Record<string, number> = {};
    const sessionOf = async (kind: "pr" | "security", number: number, nowMs: number) => {
      const r = await ensureSession(db, kind, "app", number, { nowMs });
      assert.ok("session" in r);
      return r.session;
    };
    // 7 is not mirrored yet (just opened): it is not taken for closed. The security session's number is a finding, not a PR.
    for (const [name, kind, number] of [["open", "pr", 1], ["merged", "pr", 2], ["closed", "pr", 3], ["stopped", "pr", 4], ["idle", "pr", 5], ["turns", "pr", 6], ["unmirrored", "pr", 7], ["queued", "pr", 8], ["security", "security", 2]] as const) {
      ids[name] = (await sessionOf(kind, number, name === "idle" || name === "queued" ? NOW - SESSION_IDLE_MS - 1 : NOW)).id;
    }
    await queryDb(db).run(k.insertInto("main.item_workflows").values({ repo: "app", number: 4, kind: "pr", entry: "review", state: "stopped", started_by: "ann", started_at: T, started_via: "cli", updated_at: T }));
    await updateSession(db, ids.turns!, { addTurns: SESSION_MAX_TURNS + 1 }, NOW);
    // A turn queued before the idle mark may still be running: its session stays.
    await addTurn(db, { sessionId: ids.queued!, step: "cifix", purpose: "start" }, NOW - SESSION_IDLE_MS - 1);

    // A step on an over-turned session gets a new one; a step on a session within its limits continues it.
    const again = await ensureSession(db, "pr", "app", 6, { nowMs: NOW });
    const same = await ensureSession(db, "pr", "app", 1, { nowMs: NOW });
    assert.ok("session" in again && "session" in same);
    assert.equal(again.ended?.reason, "turns");
    assert.notEqual(again.session.id, ids.turns);
    assert.equal(same.session.id, ids.open);
    assert.equal(same.created, false);

    const ended = await endIdle(db, NOW);
    // The stopped PR's session ended; a step on it gets no new one.
    assert.deepEqual(await ensureSession(db, "pr", "app", 4, { nowMs: NOW }), { refused: "stopped", ended: null });
    const byId = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
    return ended.map((e) => `${byId.get(e.id) ?? "new"}:${e.reason}`).sort();
  };
  const lite = await withDb("sqlite", run);
  assert.deepEqual(lite, ["closed:closed", "idle:idle", "merged:closed", "stopped:stopped"]);
  if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", run), lite);
});
