// A red default branch whose failure log GitHub does not serve yet: read again after the main CI poll, classified once readable,
// given up after an hour, and never counted toward the step's daily limit.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mainFixDueRepos, runMainFix, setMainFixApproval, type MainFixDeps } from "../src/mainfix/index.ts";
import { POLL_EVERY_MS } from "../src/mainci/index.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const ms = (min: number) => Date.parse("2026-01-01T00:00:00Z") + min * 60_000;
const at = (min: number) => new Date(ms(min)).toISOString();

test("an unread failure log is read again after the main CI poll, classified once readable, and given up after an hour", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "mainfix-unread-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: at(0), pipeline: 1 }));
  await setMainFixApproval(db, "op", "app", true);
  const w = { readable: false, now: at(1), classified: 0 };
  const deps: MainFixDeps = {
    now: () => new Date(w.now),
    classify: async (_db, input) => { w.classified++; return input.checks.map((c) => ({ check: c.check, verdict: "code" as const, reason: "a test fails" })); },
    gh: async (args) => {
      if (args[1]?.includes("check-runs")) return JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", details_url: "https://github.com/storytold/app/actions/runs/11/job/1" }] });
      if (args[0] === "run") { if (!w.readable) throw new Error("HTTP 404: Not Found"); return "test\tcargo test\tassertion failed\n"; }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "unexpected" }),
  };
  const head = async (sha: string, min: number) => {
    await db.run(db.k.insertInto("main_ci").values({ repo: "app", head_sha: sha, branch: "main", state: "red", failing: "[]", checks: "[]", committed_at: at(min), first_seen_at: at(min), state_changed_at: at(min), updated_at: at(min) }));
    w.now = at(min + 1);
  };
  let handled = 0;
  const run = async (min: number) => { w.now = at(min); await runMainFix(db, { repo: "app", onHandled: (n) => { handled = n; } }, () => {}, deps); };
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

  w.readable = true;
  await run(6);
  assert.deepEqual([await rows("a1"), w.classified, handled > 0], [["needs-fix"], 1, true]);

  w.readable = false;
  await head("a2", 10);
  await run(11);
  await run(72);
  assert.deepEqual([await rows("a2"), (await due(80)).due, w.classified], [["nothing-to-do"], false, 1]);
});
