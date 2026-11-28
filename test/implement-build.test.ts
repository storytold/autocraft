// The build of an implementation: AutoCraft's own check findings go back to the same session as a follow-up and a clean
// round makes it ready for its PR; findings that survive three follow-ups make it stuck, a blocker whose Try again answer
// starts a new attempt with the answer's words as guidance. A restart at any await picks up from the rounds without a second
// session in the workspace.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Outcome } from "../src/remote/calls.ts";
import type { WorkspaceCallRequest } from "../src/build/workspace-call.ts";
import { runBuild, type BuildDeps, type BuildRun } from "../src/implement/build.ts";
import type { Pod } from "../src/implement/checks.ts";
import { LOST_REPLY_MESSAGE } from "../src/implement/session.ts";
import { STUCK_OPTIONS, type StuckQuestion } from "../src/implement/stuck.ts";
import { recordAnswers } from "../src/data/implement/index.ts";
import { currentImplementation, implementationById, roundsOf, setImplementationState, startImplementation } from "./implement-rows.ts";
import type { PlanReply, SessionReport } from "../src/implement/types.ts";
import { textHash } from "../src/core/open-prs.ts";
import { OPERATOR, world } from "./world-db.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { sessionInput } from "../src/implement/session.ts";

const BASE = "b".repeat(40);
const PLAN: PlanReply = {
  ready: true, kind: "bugfix", summary: "Return None for an empty slice.", plan: "Guard first().", acceptance: ["first() of an empty slice is None"],
  verification: { tests: ["cargo test -p app"], app: null }, size: "S", risks: [], questions: [],
};
const REPORT: SessionReport = { status: "done", summary: "first() checks the length before it indexes.", changes: ["guard in first()"], tests_run: [{ command: "cargo test", exit: 0 }], shots: [], deviations: [] };
const DIFF = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -9,0 +10 @@\n+    let x = 1;\n";
const WARNING = JSON.stringify({ reason: "compiler-message", message: { level: "warning", message: "unused variable: `x`", code: { code: "unused_variables" }, spans: [{ file_name: "src/lib.rs", line_start: 10, line_end: 10, is_primary: true }], rendered: "warning: unused variable: `x`" } });

async function setup() {
  const w = await (await (await world()).repo()).issue(7);
  const db = w.db, at = new Date().toISOString();
  const ws = Number((await db.get(db.k.insertInto("workspaces").values({ repo: "app", base_sha: BASE, base_commit: BASE, env_id: "k", state: "ready", state_at: at, created_at: at, updated_at: at }).returning("id")))!.id);
  const it = (await db.get(db.k.selectFrom("items").select(["title", "body"]).where("repo", "=", "app").where("number", "=", 7)))!;
  const impl = await startImplementation(db, { repo: "app", number: 7, queuedBy: OPERATOR, textHash: textHash(it.title ?? "", it.body ?? ""), baseSha: BASE });
  await setImplementationState(db, impl.id, "planned", { plan: PLAN, planMd: PLAN.plan, workspaceId: ws });

  const queued: WorkspaceCallRequest[] = [];
  let checksRound = 0;
  const clippyFails = { rounds: new Set<number>() };
  /** Output files replaced per checks round (round number to file name to content). */
  const override = new Map<number, Record<string, string>>();
  const pod: Pod = {
    async run(what) {
      if (what === "implement-changes") checksRound++;
      return { exit: 0, state: "exited" };
    },
    async file(path) {
      const name = path.split("/").pop()!;
      const failing = clippyFails.rounds.has(checksRound);
      const files: Record<string, string> = {
        "diff.txt": DIFF, "meta.exit": "0", "meta.json": JSON.stringify({ packages: [{ name: "app", manifest_path: "/work/src/Cargo.toml" }] }),
        "fmt.exit": "0", "fmt.txt": "", "clippy.err": "", "clippy.exit": failing ? "101" : "0",
        "clippy.json": failing ? `${WARNING}\n{"reason":"build-finished","success":false}\n` : `{"reason":"build-finished","success":true}\n`,
        "tests.exit": "0", "tests.txt": "test result: ok. 3 passed",
      };
      Object.assign(files, override.get(checksRound));
      return name in files ? Buffer.from(files[name]!) : null;
    },
  };
  const deps: BuildDeps = {
    calls: {
      async queue(_db, r) { queued.push(r); return 1000 + queued.length; },
      async await(): Promise<Outcome> { return { state: "done", text: JSON.stringify(REPORT), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as never, byModel: null, costUsd: 1, turns: 5, sessionId: "s", runId: null }; },
    },
    pod: () => pod,
    diffCheck: async () => ({ ok: false }),
  };
  const run: BuildRun = { db, log: () => {}, progress: async () => {}, cancelled: async () => false, stopping: async () => false, startedMs: Date.now(), noPr: true };
  return { db, impl, deps, run, queued, clippyFails, override };
}

/** The fakes with a remote_calls row per queued call, as the real queue makes. */
function withCallRows(s: Awaited<ReturnType<typeof setup>>) {
  const queue = s.deps.calls.queue;
  s.deps.calls.queue = async (db, r) => {
    const id = await queue(db, r), now = Date.now();
    await s.db.run(s.db.k.insertInto("main.remote_calls").values({
      id, step: "implement", stage: 0, prompt_id: r.promptId, prompt_version: r.promptVersion, tier: r.tier, effort: r.effort, asked_model: r.model, bundle: "{}",
      state: "queued", since: now, seen_at: now, max_attempts: 2, timeout_ms: 1000, parent_id: r.parentId ?? null,
    } as never));
    return id;
  };
}

const RESTART = "the runner restarted";

test("check findings go back to the same session as a follow-up, and a clean round leaves the attempt ready for its PR", async () => {
  const s = await setup();
  s.clippyFails.rounds.add(1);
  await runBuild(s.run, "app", 7, s.deps);
  assert.equal((await implementationById(s.db, s.impl.id))!.state, "fixing", "a finding on a changed line sends the attempt to a follow-up");
  await runBuild(s.run, "app", 7, s.deps);
  const done = (await implementationById(s.db, s.impl.id))!;
  assert.equal(done.state, "opening");
  assert.equal(s.queued.length, 2);
  assert.equal(s.queued[0]!.parentId, undefined);
  assert.equal(s.queued[1]!.parentId, 1001, "the follow-up continues the first session");
  assert.match(s.queued[1]!.stdin, /unused variable/);
  assert.ok(s.queued.every((q) => q.forLogin === OPERATOR && q.boundSlot === true && q.keepSession === true), "every turn runs in a slot of the queuer's Task Runner");
  const kinds = (await roundsOf(s.db, s.impl.id)).map((r) => r.kind);
  assert.deepEqual(kinds, ["session", "checks", "follow-up", "checks"]);
});

test("findings that survive three follow-ups make the attempt stuck, and Try again starts a new attempt with the note as guidance", async () => {
  const s = await setup();
  for (const r of [1, 2, 3, 4]) s.clippyFails.rounds.add(r);
  for (let i = 0; i < 4; i++) await runBuild(s.run, "app", 7, s.deps);
  const stuck = (await implementationById(s.db, s.impl.id))!;
  assert.equal(stuck.state, "stuck");
  assert.equal(s.queued.filter((q) => q.parentId !== undefined).length, 3);
  const blocker = (await roundsOf(s.db, s.impl.id)).filter((r) => r.kind === "question").at(-1)!;
  const q = blocker.result as StuckQuestion;
  assert.equal(q.stuck, true);
  assert.equal(q.recommended, STUCK_OPTIONS.tryAgain.key);
  assert.ok(!q.options!.some((o) => o.key === STUCK_OPTIONS.draft.key), "a change that fails the diff check is not offered as a draft PR");

  await recordAnswers(s.db, [{ id: s.impl.id, question: blocker.id, by: OPERATOR, via: "github", option: STUCK_OPTIONS.tryAgain.key, text: "Keep the old signature." }]);
  await runBuild(s.run, "app", 7, s.deps);
  const next = (await currentImplementation(s.db, "app", 7))!;
  assert.notEqual(next.id, s.impl.id);
  assert.equal(next.state, "planning");
  assert.deepEqual((await roundsOf(s.db, next.id)).map((r) => [r.kind, (r.result as { text?: string }).text]), [["guidance", "Keep the old signature."]]);
});

test("a restart after a turn's reply was read asks the same session for the report again instead of starting over", async () => {
  const s = await setup();
  withCallRows(s);
  const normal = s.deps.calls.await;
  s.deps.calls.await = async (db, id) => {
    // The reply is read (and dropped from the call) and the runner stops before the round is written.
    await s.db.run(s.db.k.updateTable("main.remote_calls").set({ state: "done", reply: null, consumed_at: Date.now() }).where("id", "=", id));
    throw new Error(RESTART);
  };
  await assert.rejects(runBuild(s.run, "app", 7, s.deps), new RegExp(RESTART));
  s.deps.calls.await = normal;
  await runBuild(s.run, "app", 7, s.deps);
  assert.equal(s.queued.length, 2);
  assert.equal(s.queued[1]!.parentId, 1001, "the second turn goes on the first turn's session");
  assert.equal(s.queued[1]!.stdin, LOST_REPLY_MESSAGE, "the second turn asks for the report, not the task again");
  assert.equal((await implementationById(s.db, s.impl.id))!.state, "opening");
});

test("a restart after the turn's report and before the checks runs the checks on that report, with no new session", async () => {
  const s = await setup();
  let crashed = false;
  s.run.log = (line) => {
    if (!crashed && /^turn \d+ \(start\): done/.test(line)) {
      crashed = true;
      throw new Error(RESTART);
    }
  };
  await assert.rejects(runBuild(s.run, "app", 7, s.deps), new RegExp(RESTART));
  await runBuild(s.run, "app", 7, s.deps);
  assert.equal(s.queued.length, 1, "no second session in the workspace");
  assert.equal((await implementationById(s.db, s.impl.id))!.state, "opening");
  assert.deepEqual((await roundsOf(s.db, s.impl.id)).map((r) => r.kind), ["session", "checks"]);
});

test("tests that timed out are no verdict: the checks run again, a second no verdict is AutoCraft's to retry, and the retry runs the checks afresh", async () => {
  const s = await setup();
  const timedOut = { "tests.exit": "124", "tests.txt": "" };
  s.override.set(1, timedOut);
  s.override.set(2, timedOut);
  await runBuild(s.run, "app", 7, s.deps);
  assert.equal((await implementationById(s.db, s.impl.id))!.state, "checking", "the checks wait for their retry");
  assert.equal(s.queued.length, 1, "nothing goes back to the session");
  assert.deepEqual((await roundsOf(s.db, s.impl.id)).map((r) => r.kind).filter((k) => k === "question" || k === "retry"), ["retry"], "nothing is asked");
  await runBuild(s.run, "app", 7, s.deps);
  assert.equal((await implementationById(s.db, s.impl.id))!.state, "opening", "the retried checks have a verdict");
});

test("a no verdict that passes on the rerun is clean, and cargo fmt that is not installed is no verdict", async () => {
  const s = await setup();
  s.override.set(1, { "fmt.exit": "1", "fmt.txt": "error: no such command: `fmt`\n\tcargo-fmt is not installed" });
  await runBuild(s.run, "app", 7, s.deps);
  assert.equal((await implementationById(s.db, s.impl.id))!.state, "opening", "the second round has a verdict");
  const checks = (await roundsOf(s.db, s.impl.id)).filter((r) => r.kind === "checks").map((r) => r.result as { clean: boolean; noVerdict: string[] });
  assert.deepEqual(checks.map((c) => c.clean), [false, true]);
  assert.match(checks[0]!.noVerdict[0]!, /cargo fmt gave no verdict/);
});

test("the first session is given the plan's parts except the ones a maintainer dropped", async () => {
  const { db, impl } = await setup();
  const parts = ["Guard first()", "Rename the helper", "Add a test"].map((title) => ({ title, files: [`src/${title.length}.rs`] }));
  await setImplementationState(db, impl.id, "planned", { plan: { ...PLAN, workflow: { parts, recommendation: null } } });
  await insertWorkflow(db, {
    repo: "app", number: 7, kind: "issue", entry: "implement", state: "running", startedBy: "op", startedAt: "2026-11-04T08:00:00.000Z", startedVia: "dashboard",
    plan: parts.map((p, i) => ({ n: i + 1, title: p.title, source: "implement" as const, files: p.files, state: i === 1 ? "dropped" as const : "planned" as const })),
  });
  const input = await sessionInput(db, (await implementationById(db, impl.id))!, BASE);
  assert.deepEqual(input.plan.parts?.map((p) => [p.n, p.title]), [[1, "Guard first()"], [3, "Add a test"]]);
});
