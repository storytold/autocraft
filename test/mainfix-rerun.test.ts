// A flaky red default branch whose rerun GitHub refuses: the rows stay rerun-requested and are asked again after the backoff, and
// a rerun GitHub takes ends the refusals.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mainFixDueRepos, runMainFix, setMainFixApproval, type MainFixDeps } from "../src/mainfix/index.ts";
import { acting } from "./acting.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const ms = (min: number) => Date.parse("2026-01-01T00:00:00Z") + min * 60_000;
const at = (min: number) => new Date(ms(min)).toISOString();

test("a refused rerun is asked again after 5 and 15 minutes, and one GitHub takes clears the refusals", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "mainfix-rerun-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: at(0), pipeline: 1 }));
  await setMainFixApproval(db, "op", "app", true);
  const w = { now: at(1), refuse: true, asked: 0 };
  const deps: MainFixDeps = {
    now: () => new Date(w.now),
    classify: async (_db, input) => input.checks.map((c) => ({ check: c.check, verdict: "flaky" as const, reason: "a timeout" })),
    gh: async (args) => {
      if (args[1]?.includes("check-runs")) return JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", details_url: "https://github.com/storytold/app/actions/runs/11/job/1" }] });
      if (args[0] === "run") return "test\tcargo test\ttimed out\n";
      throw new Error(`unexpected call: ${args.join(" ")}`);
    },
    lane: { mint: async () => "installation-token", appClient: () => { throw new Error("no app client in this test"); } },
    exec: async (_cmd, args) => {
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ head_sha: "c1", run_attempt: 1, status: "completed" }), stderr: "" };
      w.asked++;
      return w.refuse ? { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" } : { code: 0, stdout: "", stderr: "" };
    },
  };
  await db.run(db.k.insertInto("main_ci").values({ repo: "app", head_sha: "c1", branch: "main", state: "red", failing: "[]", checks: "[]", committed_at: at(0), first_seen_at: at(0), state_changed_at: at(0), updated_at: at(0) }));
  const run = async (min: number) => { w.now = at(min); await acting(db, ["op"]); await runMainFix(db, { repo: "app" }, () => {}, deps); };
  const due = async (min: number) => (await mainFixDueRepos(db, ["app"], { now: ms(min) })).length > 0;
  const row = async () => (await db.all(db.k.selectFrom("main_fixes").select(["state", "tries", "reason"])))[0]!;

  await run(1);
  assert.deepEqual([(await row()).state, (await row()).tries, w.asked], ["rerun-requested", 1, 1]);
  assert.deepEqual([await due(5), await due(6)], [false, true], "asked again 5 minutes after the refusal");
  await run(6);
  assert.deepEqual([(await row()).tries, w.asked], [2, 2]);
  assert.deepEqual([await due(20), await due(21)], [false, true], "then 15 minutes after");
  w.refuse = false;
  await run(21);
  const r = await row();
  assert.deepEqual([r.state, r.tries, w.asked], ["rerun-requested", 0, 3]);
  assert.match(r.reason ?? "", /rerun after 2 refused requests/);
});
