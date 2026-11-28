// A red default branch whose failure log GitHub does not serve yet: read again once per slot (each main CI poll, hourly after the
// first hour) while the head is the newest and red, classified once readable, ended for a person when GitHub no longer has the log,
// and never counted toward the step's daily limit; a model reply that sorts nothing is given up after three, a call without a reply never.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { autocraftText, mainFixClock, mainFixDueRepos, runMainFix, setMainFixApproval, type MainFixDeps } from "../src/mainfix/index.ts";
import { POLL_EVERY_MS } from "../src/mainci/index.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const ms = (min: number) => Date.parse("2026-01-01T00:00:00Z") + min * 60_000;
const at = (min: number) => new Date(ms(min)).toISOString();

test("an unread failure log is read again after the main CI poll, then hourly, classified once readable, and left once a newer head comes", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "mainfix-unread-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: at(0), pipeline: 1 }));
  await setMainFixApproval(db, "op", "app", true);
  const w = { readable: false, gone: false, now: at(1), classified: 0, usable: true };
  const deps: MainFixDeps = {
    now: () => new Date(w.now),
    classify: async (_db, input) => { w.classified++; if (!w.usable) return null; return input.checks.map((c) => ({ check: c.check, verdict: "code" as const, reason: "a test fails" })); },
    gh: async (args) => {
      if (args[1]?.includes("check-runs")) return JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", details_url: "https://github.com/storytold/app/actions/runs/11/job/1" }] });
      if (args[0] === "run") { if (w.gone) throw new Error("HTTP 410: Gone"); if (!w.readable) throw new Error("HTTP 404: Not Found"); return "test\tcargo test\tassertion failed\n"; }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "unexpected" }),
  };
  const head = async (sha: string, min: number) => {
    await db.run(db.k.insertInto("main_ci").values({ repo: "app", head_sha: sha, branch: "main", state: "red", failing: "[]", checks: "[]", committed_at: at(min), first_seen_at: at(min), state_changed_at: at(min), updated_at: at(min) }));
    w.now = at(min + 1);
  };
  let handled = 0;
  const run = async (min: number) => { w.now = at(min); await runMainFix(db, { repo: "app", onHandled: (n) => { handled = n; } }, () => {}, deps).catch(() => {}); };
  const due = async (min: number) => { const wake: number[] = []; return { due: (await mainFixDueRepos(db, ["app"], { now: ms(min), wake })).length > 0, wake }; };
  const rows = async (sha: string) => (await db.all(db.k.selectFrom("main_fixes").select(["state"]).where("head_sha", "=", sha))).map((r) => r.state);

  await head("a1", 0);
  await run(1);
  assert.deepEqual(await rows("a1"), ["unread"]);
  const soon = await due(2);
  assert.equal(soon.due, false, "not read again before the next main CI poll");
  assert.ok(soon.wake.some((t) => t > ms(2) && t <= ms(1) + POLL_EVERY_MS), "the planner wakes at the next main CI poll");
  assert.equal((await due(1 + POLL_EVERY_MS / 60_000)).due, true);
  await run(4);
  assert.equal(handled, 0, "a reading that found no log uses none of the daily limit");
  assert.equal((await due(4)).due, false, "not read again within the slot of the last read");
  assert.equal((await due(5)).due, true, "read again in the next slot");

  w.readable = true;
  await run(6);
  assert.deepEqual([await rows("a1"), w.classified, handled > 0], [["needs-fix"], 1, true]);

  w.readable = false;
  await head("a2", 10);
  await run(11);
  await run(40);
  assert.deepEqual(await rows("a2"), ["unread"], "still read again within the hour");
  assert.notEqual(await mainFixClock(db, ms(40)), await mainFixClock(db, ms(43)), "the lane's clock moves while the current head is unread");
  await run(72);
  assert.deepEqual([await rows("a2"), w.classified], [["unread"], 1], "not given up after an hour");
  assert.equal(await mainFixClock(db, ms(80)), await mainFixClock(db, ms(83)), "then read again once an hour");
  assert.notEqual(await mainFixClock(db, ms(80)), await mainFixClock(db, ms(132)));

  w.readable = true;
  w.usable = false;
  handled = 0;
  await head("a3", 90);
  assert.ok(!(await mainFixClock(db, ms(91))).includes("a2"), "a head that is no longer the newest is not read again");
  for (const min of [91, 100, 110]) {
    assert.equal((await due(min)).due, true);
    await run(min);
  }
  assert.deepEqual([await rows("a3"), w.classified, handled, (await due(120)).due], [["nothing-to-do"], 4, 0, false]);

  w.gone = true;
  await head("a4", 130);
  await run(131);
  assert.deepEqual([await rows("a4"), (await due(135)).due], [["unreadable"], false], "a log GitHub no longer has ends the head");
  assert.match(await autocraftText(db, "app", "a4", "red") ?? "", /^needs a person: the failure log cannot be read/);
});

test("a classification call that ended without a reply is no try: the head stays unclassified and the lane's clock moves when it is asked again", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "mainfix-lost-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: at(0), pipeline: 1 }));
  await setMainFixApproval(db, "op", "app", true);
  const w = { now: at(1), lost: true };
  const deps: MainFixDeps = {
    now: () => new Date(w.now),
    classify: async (_db, input) => (w.lost ? { lost: "the classification call ended without a reply" } : input.checks.map((c) => ({ check: c.check, verdict: "code" as const, reason: "a test fails" }))),
    gh: async (args) => {
      if (args[1]?.includes("check-runs")) return JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", details_url: "https://github.com/storytold/app/actions/runs/11/job/1" }] });
      if (args[0] === "run") return "test\tcargo test\tassertion failed\n";
      throw new Error(`unexpected call: ${args.join(" ")}`);
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "unexpected" }),
  };
  await db.run(db.k.insertInto("main_ci").values({ repo: "app", head_sha: "b1", branch: "main", state: "red", failing: "[]", checks: "[]", committed_at: at(0), first_seen_at: at(0), state_changed_at: at(0), updated_at: at(0) }));
  const run = async (min: number) => { w.now = at(min); return await runMainFix(db, { repo: "app" }, () => {}, deps); };
  const due = async (min: number) => (await mainFixDueRepos(db, ["app"], { now: ms(min) })).length > 0;
  const rows = async () => await db.all(db.k.selectFrom("main_fixes").select(["state", "tries"]).where("head_sha", "=", "b1"));

  // More lost calls than the unusable replies that give a head up, asked again after 5, 15 and 60 minutes, then hourly.
  for (const [min, wait] of [[1, 5], [6, 15], [21, 60], [81, 60]] as const) {
    assert.equal(await due(min), true);
    const s = await run(min);
    assert.match(s.note ?? "", /not classified/, "the job says it did not finish its work");
    assert.deepEqual(await rows(), [{ state: "unclassified", tries: 0 }]);
    assert.equal(await due(min + wait - 1), false, "not asked again before its retry time");
    assert.equal(await mainFixClock(db, ms(min + 1)), await mainFixClock(db, ms(min + wait - 1)), "the clock holds still while it waits");
    assert.notEqual(await mainFixClock(db, ms(min + 1)), await mainFixClock(db, ms(min + wait)), "and moves once the retry is due");
  }
  w.lost = false;
  await run(141);
  assert.deepEqual(await rows(), [{ state: "needs-fix", tries: 0 }]);
});
