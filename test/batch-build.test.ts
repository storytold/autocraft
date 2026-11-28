// Build batches: with the feature on, a build task checks the combined tree before the batch PR opens; every failure to
// build opens the PR anyway. A batch that cannot be published frees its PRs behind a backoff. GitHub, git and the build worker
// are faked (test/world-db.ts); no build runs.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { setFeature } from "../src/build/features.ts";
import { like } from "../src/db/kx.ts";
import { runBatches, type BatchDeps } from "../src/merge/batch.ts";
import { MAX_PUBLISH_FAILURES } from "../src/merge/batch-store.ts";
import { planned } from "../src/core/select.ts";
import { T1, world, type World } from "./world-db.ts";

const quiet = () => {};
let current: World | null = null;
afterEach(() => current?.close());

const PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
async function setup(prs: number[], on: boolean) {
  const w = (current = await (await world()).repo());
  for (const n of prs) await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
  if (on) await setFeature(w.db, "batch-build", true, "op", "app");
  const base = w.gh.batchDeps();
  const calls: string[] = [];
  let patch = PATCH;
  const deps: BatchDeps = { ...base, exec: async (cmd, args, opts) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git" && args.includes("diff-tree")) return { code: 0, stdout: patch, stderr: "" };
    return base.exec(cmd, args, opts);
  } };
  return { w, deps, calls, setPatch: (p: string) => { patch = p; } };
}
const run = (t: Awaited<ReturnType<typeof setup>>) => runBatches(t.w.db, { repo: "app" }, quiet, t.deps);
const batches = async (w: World) => await w.db.all(w.db.k.selectFrom("merge_batches").select(["id", "state", "build_state", "build_tries", "task_id", "parent_id", "pr_number", "updated_at"]).orderBy("id"));
const tasks = async (w: World) => await w.rows("SELECT id, step, state FROM build_tasks ORDER BY id");

/** Ends a task the way a worker would: every plan step passed, or the named step failed (earlier ones passed), or no step ran. */
async function finish(w: World, id: number, how: "pass" | "env" | { failAt: string }): Promise<void> {
  const plan = JSON.parse(((await w.rows("SELECT plan FROM build_tasks WHERE id = ?", id))[0] as { plan: string }).plan) as { name: string }[];
  const results: object[] = [];
  if (how !== "env") {
    for (const s of plan) {
      const bad = typeof how === "object" && s.name === how.failAt;
      results.push({ step: s.name, exitCode: bad ? 1 : 0, durationMs: 1, timedOut: false });
      if (bad) break;
    }
  }
  const state = how === "pass" ? "done" : "failed";
  await w.db.prepare("UPDATE build_tasks SET state = ?, results = ?, ended_at = ?, summary = 'x' WHERE id = ?").run(state, JSON.stringify(results), "2026-01-02T00:00:00Z", id);
}

describe("batch-build", () => {
  test("off: the batch PR opens at once with no task; on: a task is queued, the PR opens once it passed", async () => {
    const off = await setup([1, 2], false);
    await run(off);
    assert.deepEqual(await tasks(off.w), []);
    assert.deepEqual((await batches(off.w)).map((b) => [b.build_state, b.pr_number]), [[null, 900]]);
    assert.ok(!off.calls.some((c) => c.includes("diff-tree")));
    off.w.close();

    const t = await setup([1, 2], true);
    const first = await run(t);
    assert.equal(first.published.length, 0);
    assert.deepEqual(await tasks(t.w), [{ id: 1, step: "merge-batch", state: "queued" }]);
    assert.deepEqual((await batches(t.w)).map((b) => [b.state, b.build_state, b.build_tries, b.pr_number]), [["checking", "pending", 1, null]]);
    assert.equal(t.w.gh.writesOf("pr").length, 0);

    assert.deepEqual((await run(t)).waiting.length, 1);
    assert.equal(t.w.gh.writesOf("pr").length, 0);
    await finish(t.w, 1, "pass");
    assert.equal((await run(t)).published.length, 1);
    assert.deepEqual((await batches(t.w)).map((b) => [b.state, b.build_state, b.pr_number]), [["open", "passed", 900]]);
  });

  test("a member that lost its merge approval while the batch is checking is left out, and the others go on", async () => {
    const t = await setup([1, 2], true);
    await (await (await t.w.acting()).workflow(2)).handedOver(2);
    await run(t);
    assert.deepEqual((await t.w.rows("SELECT number FROM merge_batch_prs ORDER BY number")).map((x) => x.number), [1, 2]);
    await t.w.db.run(t.w.db.k.updateTable("preapprovals").set({ state: "cancelled" }));
    await finish(t.w, 1, "pass");
    await run(t);
    const [first, second] = await batches(t.w);
    assert.deepEqual([first!.state, second!.parent_id], ["superseded", first!.id]);
    assert.deepEqual((await t.w.rows("SELECT number FROM merge_batch_prs WHERE batch_id = ?", second!.id as number)).map((x) => x.number), [1]);
  });

  test("a binary diff, or the switch turned off mid-flight, opens the PR without the build", async () => {
    const bin = await setup([1], true);
    bin.setPatch("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n");
    await run(bin);
    assert.deepEqual(await tasks(bin.w), []);
    assert.deepEqual((await batches(bin.w)).map((b) => [b.build_state, b.pr_number]), [["skipped", 900]]);
    bin.w.close();

    const t = await setup([1], true);
    await run(t);
    await setFeature(t.w.db, "batch-build", false, "op", "app");
    await run(t);
    assert.deepEqual(await tasks(t.w), [{ id: 1, step: "merge-batch", state: "cancelled" }]);
    assert.deepEqual((await batches(t.w)).map((b) => [b.build_state, b.pr_number]), [["skipped", 900]]);
  });

  test("a red tree splits the batch, each half is built before it opens; a single PR is held", async () => {
    const t = await setup([1, 2, 3, 4], true);
    await run(t);
    await t.w.db.run(t.w.db.k.updateTable("merge_batches").set({ build_tries: 2 }));
    await finish(t.w, 1, { failAt: "test" });
    const s = await run(t);
    assert.equal(s.split.length, 1);
    const rows = await batches(t.w);
    assert.deepEqual(rows.map((b) => [b.state, b.parent_id]), [["split", null], ["checking", 1], ["checking", 1]]);
    assert.deepEqual(rows.slice(1).map((b) => b.build_state), ["pending", "pending"]);
    assert.equal((await t.w.db.get(t.w.db.k.selectFrom("merge_batch_prs").select((eb) => eb.fn.countAll<number>().as("n")).where("batch_id", "=", 2)))!.n, 2);
    assert.equal((await tasks(t.w)).length, 3);
    assert.equal(t.w.gh.writesOf("pr").length, 0);
    t.w.close();

    const one = await setup([1], true);
    await run(one);
    await finish(one.w, 1, { failAt: "build" });
    await run(one);
    assert.deepEqual((await batches(one.w)).map((b) => [b.state, b.build_state]), [["failed", "failed"]]);
    assert.match((await one.w.db.get(one.w.db.k.selectFrom("stages").select("note").where("stage", "=", "hold").where("number", "=", 1)))!.note!, /combined tree failed at build/);
    assert.equal(one.w.gh.writesOf("pr").length, 0);
  });

  test("a failed test step is rerun once; an environment error is queued again, then the PR opens anyway", async () => {
    const t = await setup([1], true);
    await run(t);
    await finish(t.w, 1, { failAt: "test" });
    await run(t);
    assert.deepEqual((await batches(t.w)).map((b) => [b.state, b.build_tries, b.task_id]), [["checking", 2, 2]]);

    await finish(t.w, 2, "env");
    assert.equal((await run(t)).waiting.length, 1);
    assert.equal((await batches(t.w))[0]!.task_id, 2, "waits out the retry delay");
    await t.w.db.run(t.w.db.k.updateTable("merge_batches").set({ updated_at: "2025-01-01T00:00:00Z" }));
    await run(t);
    assert.deepEqual((await batches(t.w)).map((b) => [b.state, b.build_state, b.build_tries, b.task_id]), [["checking", "pending", 3, 3]]);
    assert.equal(t.w.gh.writesOf("pr").length, 0);

    await finish(t.w, 3, "env");
    await run(t);
    assert.deepEqual((await batches(t.w)).map((b) => [b.state, b.build_state, b.pr_number]), [["open", "skipped", 900]]);
  });
});

test("a batch that cannot be published returns its PRs to the queue, and the repo's next batch waits out a backoff", async () => {
  const t = await setup([1, 2], false);
  let clock = Date.parse(T1), pushes = false;
  const deps: BatchDeps = { ...t.deps, now: () => new Date(clock), exec: async (cmd, args, opts) => (cmd === "git" && args.includes("push") && !pushes ? { code: 1, stdout: "", stderr: "HTTP 503" } : t.deps.exec(cmd, args, opts)) };
  const go = () => runBatches(t.w.db, { repo: "app" }, quiet, deps);
  for (let i = 0; i < MAX_PUBLISH_FAILURES; i++) { await go(); clock += 31 * 60_000; }
  assert.deepEqual((await batches(t.w)).map((b) => b.state), ["failed"]);
  // Back in the queue, not held for a person.
  assert.deepEqual((await planned(t.w.db, "merge", { repo: "app" })).map((p) => p.facts.number).sort(), [1, 2]);

  pushes = true;
  clock = Date.parse((await batches(t.w))[0]!.updated_at) + 10 * 60_000;
  await go();
  assert.equal((await batches(t.w)).length, 1, "no batch starts during the backoff");
  clock += 30 * 60_000;
  await go();
  assert.deepEqual((await batches(t.w)).map((b) => [b.state, b.pr_number]), [["failed", null], ["open", 900]]);
});
