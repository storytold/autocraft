// A red integration batch, worked out without a model: checks red on main at the base too blame no PR; a failure the
// log traces tests the traced PRs alone and rebuilds the rest; otherwise the failed runs are rerun once; then the batch
// splits. GitHub and git are faked (test/world-db.ts) with failed check runs, their logs, rev-list, diff and blame.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { setFeature } from "../src/build/features.ts";
import { failureLocations, repoPath } from "../src/core/failure-locations.ts";
import { batchSizeOf } from "../src/merge/batch-store.ts";
import { runBatches, type BatchDeps } from "../src/merge/batch.ts";
import { world, type World } from "./world-db.ts";
import { mapSeq } from "../src/async-seq.ts";

const quiet = () => {};
let current: World | null = null;
afterEach(() => current?.close());

const MAIN = "a".repeat(40);
const sha40 = (n: number) => `c${String(n).padStart(39, "0")}`;

describe("failure locations", () => {
  test("rustc errors and panics give repo paths and lines; warnings, dependencies and odd paths do not", () => {
    const log = [
      "warning: unused variable `x`",
      "  --> src/warn.rs:3:9",
      "error[E0308]: mismatched types",
      "  --> /home/runner/work/app/app/crates/core/src/b.rs:41:17",
      "error: could not compile `core`",
      "thread 'paint::tests::fill' panicked at crates/paint/src/fill.rs:88:5:",
      "assertion `left == right` failed",
      "thread 'old' panicked at 'boom', src/old.rs:7:1",
      "error[E0425]: cannot find value",
      "  --> /home/runner/.cargo/registry/src/x/lib.rs:1:1",
      "error[E0425]: cannot find value",
      "  --> ../escape.rs:1:1",
      "error[E0308]: mismatched types",
      "  --> crates/core/src/b.rs:41:17",
    ].join("\n");
    assert.deepEqual(failureLocations(log), [
      { file: "crates/core/src/b.rs", line: 41, what: "error" },
      { file: "crates/paint/src/fill.rs", line: 88, what: "panic" },
      { file: "src/old.rs", line: 7, what: "panic" },
    ]);
    for (const bad of ["-rf", "../x.rs", "a//b.rs", "a/./b.rs", "target/debug/x.rs", "x y.rs", "$(rm).rs"]) assert.equal(repoPath(bad), null, bad);
    assert.equal(repoPath("D:\\a\\app\\app\\src\\win.rs"), "src/win.rs");
    // Only an absolute path loses a checkout prefix; a relative one is the repo's as it is.
    assert.equal(repoPath("crates/work/x/y/lib.rs"), "crates/work/x/y/lib.rs");
    assert.equal(repoPath("/home/runner/work/app/app/crates/work/x/y/lib.rs"), "crates/work/x/y/lib.rs");
    assert.deepEqual(failureLocations("thread 'w' panicked at D:\\a\\app\\app\\src\\win.rs:9:1:\n"), [{ file: "src/win.rs", line: 9, what: "panic" }]);
  });
});

type Fake = {
  /** The failed log of run 77, as `gh run view --log-failed` prints it (job, step, text). */
  log: string;
  /** completed_at of the failed check run. */
  completedAt: string;
  /** Files each PR changed, and the PR whose commit wrote each `file:line`. */
  files: Record<number, string[]>;
  blame: Record<string, number>;
};

async function setup(prs: number[], o: { build?: boolean } = {}) {
  const w = (current = await (await world()).repo());
  for (const n of prs) await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
  if (o.build) await setFeature(w.db, "batch-build", true, "op", "app");
  const fake: Fake = { log: "", completedAt: "2026-01-01T23:00:00Z", files: {}, blame: {} };
  const reruns: string[] = [];
  const base = w.gh.batchDeps();
  let mainHead = MAIN;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const deps: BatchDeps = {
    ...base,
    mainHead: async () => mainHead,
    exec: async (cmd, args, opts) => {
      const a = [...args];
      if (cmd === "git") {
        while (a[0] === "-c") a.splice(0, 2);
        if (a[0] === "diff-tree") return ok("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
        if (a[0] === "rev-list") return ok(`${sha40(Number(/sha(\d+)/.exec(a[1]!)![1]))}\n`);
        if (a[0] === "diff" && a.includes("--name-only")) return ok(`${(fake.files[Number(/sha(\d+)$/.exec(a.at(-1)!)![1])] ?? []).join("\n")}\n`);
        if (a[0] === "rev-parse" && a[1] === "refs/batch/main") return ok(`${mainHead}\n`);
        if (a[0] === "blame") {
          const n = fake.blame[`${a.at(-1)}:${a[a.indexOf("-L") + 1]!.split(",")[0]}`];
          return n ? ok(`${sha40(n)} 4 4 1\nauthor x\n`) : ok(`${MAIN} 4 4 1\n`);
        }
      }
      if (cmd === "gh") {
        if (a[0] === "api" && /\/commits\/[0-9a-f]+\/check-runs/.test(a[1]!)) {
          return ok(JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", details_url: "https://github.com/storytold/app/actions/runs/77/job/1", completed_at: fake.completedAt }] }));
        }
        if (a[0] === "run" && a[1] === "view") return ok(fake.log);
        if (a[0] === "api" && /actions\/runs\/77$/.test(a[1]!)) return ok(JSON.stringify({ head_sha: (await w.db.get(w.db.k.selectFrom("merge_batches").select("commit_sha").where("state", "in", ["checking", "open"]).orderBy("id", "desc")))!.commit_sha }));
        if (a[0] === "run" && a[1] === "rerun") { reruns.push(a[2]!); return ok(); }
      }
      return base.exec(cmd, args, opts);
    },
  };
  const run = () => runBatches(w.db, { repo: "app" }, quiet, deps);
  const batches = async () => await w.db.all(w.db.k.selectFrom("merge_batches").select(["id", "state", "parent_id", "ci_reruns", "summary"]).orderBy("id"));
  const membersOf = async (id: number) => (await w.db.all(w.db.k.selectFrom("merge_batch_prs").select("number").where("batch_id", "=", id).orderBy("position"))).map((r) => r.number);
  const red = () => w.gh.live(900, { ci: "failure" });
  const setMain = (sha: string) => { mainHead = sha; };
  const baseOf = async (id: number) => (await w.db.get(w.db.k.selectFrom("merge_batches").select("base_sha").where("id", "=", id)))!.base_sha;
  return { w, fake, reruns, run, batches, membersOf, red, setMain, baseOf, deps };
}

const errorAt = (file: string, line: number) => `test\tRun tests\terror[E0308]: mismatched types\ntest\tRun tests\t  --> ${file}:${line}:5\n`;

describe("a red batch", () => {
  test("traced to one PR: that PR is tested alone, the rest rebuilt without it, and the batch size stays", async () => {
    const t = await setup([1, 2, 3]);
    await t.run();
    const size = await batchSizeOf(t.w.db, "app");
    t.fake.log = errorAt("src/b.rs", 4);
    t.fake.blame["src/b.rs:4"] = 2;
    t.red();
    const s = await t.run();
    assert.equal(s.split.length, 1);
    const rows = await t.batches();
    assert.equal(rows[0]!.state, "split");
    assert.match(rows[0]!.summary!, /traced to #2 \(the error at src\/b\.rs:4 is in its commit c000000\)/);
    assert.deepEqual(await mapSeq(rows.slice(1), async (b) => [b.parent_id, await t.membersOf(b.id)]), [[1, [2]], [1, [1, 3]]]);
    assert.equal(await batchSizeOf(t.w.db, "app"), size);
    assert.deepEqual(t.reruns, []);
    assert.equal((await t.w.db.all(t.w.db.k.selectFrom("audit").select("target").where("action", "=", "batch-blame"))).map((r) => r.target).join(), "app#2");
    // Nothing is held: #2 is only held if it is red alone too.
    assert.deepEqual(await t.w.db.all(t.w.db.k.selectFrom("stages").select("number").where("stage", "=", "hold")), []);
  });

  test("a file only one PR changed points at it when blame finds no member's commit", async () => {
    const t = await setup([1, 2]);
    await t.run();
    t.fake.log = "test\tRun tests\tthread 'x' panicked at src/only1.rs:9:1:\n";
    t.fake.files = { 1: ["src/only1.rs"], 2: ["src/other.rs"] };
    t.red();
    await t.run();
    assert.match((await t.batches())[0]!.summary!, /traced to #1 \(the panic is in src\/only1\.rs:9, a file only it changed\)/);
  });

  test("no trace: the failed runs are rerun once; stale results wait, fresh ones split the batch and halve the size", async () => {
    const t = await setup([1, 2, 3, 4]);
    await t.run();
    const size = await batchSizeOf(t.w.db, "app");
    t.fake.log = "test\tRun tests\ttest paint::fill ... FAILED\n";
    t.red();
    const first = await t.run();
    assert.deepEqual(t.reruns, ["77"]);
    assert.equal(first.waiting.length, 1);
    assert.deepEqual((await t.batches()).map((b) => [b.state, b.ci_reruns]), [["open", 1]]);
    assert.match((await t.batches())[0]!.summary!, /no PR traced, rerunning the failed runs once/);
    // The red result from before the rerun does not count.
    assert.equal((await t.run()).waiting.length, 1);
    assert.equal((await t.batches())[0]!.state, "open");
    t.fake.completedAt = "2026-01-02T00:30:00Z";
    const s = await t.run();
    assert.equal(s.split.length, 1);
    assert.deepEqual(t.reruns, ["77"], "one rerun per batch");
    assert.deepEqual((await t.batches()).map((b) => b.state), ["split", "open", "open"]);
    assert.equal(await batchSizeOf(t.w.db, "app"), Math.floor(size / 2));
  });

  test("the rerun waits while a failed check's run is in progress, and a fully refused rerun fails the batch at once", async () => {
    const t = await setup([1]);
    await t.run();
    t.red();
    let status = "in_progress";
    let refuse = false;
    const exec = t.deps.exec;
    t.deps.exec = async (cmd, args, opts) => {
      if (cmd === "gh" && args[0] === "api" && /actions\/runs\/77$/.test(args[1] ?? "")) {
        const r = await exec(cmd, args, opts);
        return { ...r, stdout: JSON.stringify({ ...JSON.parse(r.stdout), status }) };
      }
      if (cmd === "gh" && args[0] === "run" && args[1] === "rerun" && refuse) return { code: 1, stdout: "", stderr: "run is in progress" };
      return exec(cmd, args, opts);
    };
    assert.equal((await t.run()).waiting.length, 1);
    assert.deepEqual(t.reruns, []);
    assert.deepEqual((await t.batches()).map((b) => [b.state, b.ci_reruns]), [["open", 0]]);
    assert.match((await t.batches())[0]!.summary!, /waiting for the failed CI runs to finish/);
    // Completed, but GitHub refuses every rerun call: no wait out of the rerun window.
    status = "completed";
    refuse = true;
    await t.run();
    assert.deepEqual((await t.batches()).map((b) => [b.state, b.ci_reruns]), [["failed", 1]]);
  });

  test("a single PR is rerun once before it is held", async () => {
    const t = await setup([1]);
    await t.run();
    t.red();
    await t.run();
    assert.deepEqual(t.reruns, ["77"]);
    assert.deepEqual(await t.w.db.all(t.w.db.k.selectFrom("stages").select("number").where("stage", "=", "hold")), []);
    t.fake.completedAt = "2026-01-02T00:30:00Z";
    await t.run();
    assert.equal((await t.batches())[0]!.state, "failed");
    assert.deepEqual((await t.w.db.all(t.w.db.k.selectFrom("stages").select("number").where("stage", "=", "hold"))).map((r) => r.number), [1]);
  });

  test("checks red on main at the base too blame no PR: the batch waits, then is rebuilt on the new head", async () => {
    const t = await setup([1, 2]);
    await t.run();
    await t.w.db.run(t.w.db.k.insertInto("main_ci").values({ repo: "app", head_sha: MAIN, branch: "main", state: "green", failing: '[{"name":"gate / test","url":"u"}]', checks: "[]",
      first_seen_at: "2026-01-01T00:00:00Z", state_changed_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
    t.fake.log = errorAt("src/b.rs", 4);
    t.fake.blame["src/b.rs:4"] = 2;
    t.red();
    assert.equal((await t.run()).waiting.length, 1);
    assert.deepEqual((await t.batches()).map((b) => b.state), ["open"]);
    assert.match((await t.batches())[0]!.summary!, /failed on main at the base too; waits for main to change/);
    assert.deepEqual(t.reruns, []);
    t.setMain("d".repeat(40));
    const s = await t.run();
    assert.equal(s.superseded.length, 1);
    assert.equal((await t.batches())[0]!.state, "superseded");
    assert.deepEqual(await t.membersOf((await t.batches())[1]!.id), [1, 2]);
    assert.equal(await t.baseOf((await t.batches())[1]!.id), "d".repeat(40));
    assert.deepEqual(await t.w.db.all(t.w.db.k.selectFrom("stages").select("number").where("stage", "=", "hold")), []);
  });

  test("a red combined-tree build is traced from its log the same way", async () => {
    const t = await setup([1, 2, 3], { build: true });
    await t.run();
    const task = (await t.w.db.get(t.w.db.k.selectFrom("merge_batches").select("task_id")))!.task_id!;
    await t.w.db.run(t.w.db.k.updateTable("merge_batches").set({ build_tries: 2 }));
    const plan = JSON.parse(((await t.w.rows("SELECT plan FROM build_tasks WHERE id = ?", task))[0] as { plan: string }).plan) as { name: string }[];
    const results = [];
    for (const step of plan) { results.push({ step: step.name, exitCode: step.name === "test" ? 1 : 0, durationMs: 1, timedOut: false }); if (step.name === "test") break; }
    await t.w.db.prepare("UPDATE build_tasks SET state = 'failed', results = ?, ended_at = ?, summary = 'x' WHERE id = ?").run(JSON.stringify(results), "2026-01-02T00:00:00Z", task);
    await t.w.db.prepare("INSERT INTO build_task_logs (task_id, step, seq, chunk) VALUES (?, 'test', 1, ?)").run(task, "thread 'fill' panicked at src/fill.rs:3:1:\n");
    t.fake.blame["src/fill.rs:3"] = 3;
    await t.run();
    const rows = await t.batches();
    assert.match(rows[0]!.summary!, /combined tree failed at test; traced to #3/);
    assert.deepEqual(await mapSeq(rows.slice(1), async (b) => await t.membersOf(b.id)), [[3], [1, 2]]);
  });

  test("after the rerun, results that cannot be read wait out the deadline instead of holding the PR", async () => {
    const t = await setup([1]);
    await t.run();
    t.red();
    await t.run();
    assert.deepEqual(t.reruns, ["77"]);
    // The check runs cannot be read now: no fresh result, so the batch waits.
    const exec = t.deps.exec;
    t.deps.exec = async (cmd, args, opts) => (cmd === "gh" && args[0] === "api" && /check-runs/.test(args[1] ?? "") ? { code: 1, stdout: "", stderr: "HTTP 502" } : exec(cmd, args, opts));
    assert.equal((await t.run()).waiting.length, 1);
    assert.equal((await t.batches())[0]!.state, "open");
    assert.deepEqual(await t.w.db.all(t.w.db.k.selectFrom("stages").select("number").where("stage", "=", "hold")), []);
    // Past the deadline the batch goes on, as it would with stale results.
    await t.w.db.run(t.w.db.k.updateTable("merge_batches").set({ ci_rerun_at: "2026-01-01T00:00:00Z" }));
    await t.run();
    assert.equal((await t.batches())[0]!.state, "failed");
    assert.deepEqual((await t.w.db.all(t.w.db.k.selectFrom("stages").select("number").where("stage", "=", "hold"))).map((r) => r.number), [1]);
  });

  test("the batches a trace starts share one base, also when the default branch moves between them", async () => {
    const t = await setup([1, 2, 3]);
    await t.run();
    t.fake.log = errorAt("src/b.rs", 4);
    t.fake.blame["src/b.rs:4"] = 2;
    t.red();
    // The default branch moves after each fetch: separate fetches would give each batch its own base.
    let fetches = 0;
    const exec = t.deps.exec;
    t.deps.exec = async (cmd, args, opts) => {
      if (cmd === "git" && args.includes("fetch")) t.setMain(`${"e".repeat(39)}${++fetches}`);
      return exec(cmd, args, opts);
    };
    await t.run();
    const started = (await t.batches()).slice(1);
    assert.equal(started.length, 2);
    assert.equal(await t.baseOf(started[0]!.id), await t.baseOf(started[1]!.id));
  });
});
