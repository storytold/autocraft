// The merge train: up to the repo's depth of batches (cars) in flight, each next car built on the tip of the car below it. A car
// lands only after the car below landed, in the same run; a car whose car below ended without landing goes, and its PRs are built
// again on the last car still in flight. GitHub and git are faked (test/world-db.ts), one PR per car from #900 up.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { batchSizeOf, trainCapacities } from "../src/merge/batch-store.ts";
import { runBatches, type BatchDeps } from "../src/merge/batch.ts";
import { saveTrainDepth } from "../src/data/merge/index.ts";
import { world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

const MAIN = "a".repeat(40);
const sha40 = (n: number) => `c${String(n).padStart(39, "0")}`;

async function setup(depth: number) {
  const w = (current = await (await world()).repo());
  await saveTrainDepth(w.db, "app", depth, "op");
  const base = w.gh.batchDeps({ cars: { ci: "pending" } });
  const fake = { main: MAIN, conflicts: new Set<string>(), log: "", blame: {} as Record<string, number> };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const deps: BatchDeps = {
    ...base,
    mainHead: async () => fake.main,
    exec: async (cmd, args, opts) => {
      const a = [...args];
      if (cmd === "git") {
        while (a[0] === "-c") a.splice(0, 2);
        if (a[0] === "rev-parse" && a[1] === "refs/batch/main") return ok(`${fake.main}\n`);
        if (a[0] === "merge-tree" && fake.conflicts.has(a.at(-1)!)) return { code: 1, stdout: "", stderr: "" };
        if (a[0] === "rev-list") return ok(`${sha40(Number(/sha(\d+)/.exec(a[1]!)![1]))}\n`);
        if (a[0] === "diff" && a.includes("--name-only")) return ok("\n");
        if (a[0] === "blame") {
          const n = fake.blame[`${a.at(-1)}:${a[a.indexOf("-L") + 1]!.split(",")[0]}`];
          return ok(`${n ? sha40(n) : MAIN} 4 4 1\n`);
        }
      }
      if (cmd === "gh") {
        if (a[0] === "api" && /\/rules\/branches\//.test(a[1]!)) return ok("[]");
        if (a[0] === "api" && /\/protection\//.test(a[1]!)) return { code: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
        if (a[0] === "api" && /\/commits\/[0-9a-f]+\/check-runs/.test(a[1]!)) {
          return ok(JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", details_url: "https://github.com/storytold/app/actions/runs/77/job/1", completed_at: "2026-01-01T23:00:00Z" }] }));
        }
        if (a[0] === "run" && a[1] === "view") return ok(fake.log);
      }
      return base.exec(cmd, args, opts);
    },
  };
  const ready = async (n: number) => { await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean"); };
  const run = () => runBatches(w.db, { repo: "app" }, () => {}, deps);
  const batches = async () => await Promise.all((await w.db.all(w.db.k.selectFrom("merge_batches").select(["id", "state", "base_sha", "commit_sha", "below_id", "root_sha", "side", "pr_number", "summary"]).orderBy("id")))
    .map(async (b) => ({ ...b, members: (await w.db.all(w.db.k.selectFrom("merge_batch_prs").select("number").where("batch_id", "=", b.id).orderBy("position"))).map((r) => r.number) })));
  const active = async () => (await batches()).filter((b) => b.state === "checking" || b.state === "open");
  return { w, fake, ready, run, batches, active };
}

test("a car starts on the tip of the car below while that one's CI runs, waits for it, and lands right after it in the same run", async () => {
  const t = await setup(2);
  assert.ok((await trainCapacities(t.w.db, ["app"])).get("app")! > await batchSizeOf(t.w.db, "app"), "a merge job of a two-car train may take more than one batch");
  await t.ready(1);
  await t.run();
  await t.ready(2);
  await t.run();
  const [one, two] = await t.active();
  assert.deepEqual([one!.members, two!.members], [[1], [2]]);
  assert.equal(two!.below_id, one!.id);
  assert.equal(two!.base_sha, one!.commit_sha, "car 2 is built on car 1's tip");
  assert.equal(two!.root_sha, MAIN);
  const body = t.w.gh.writesOf("pr").at(-1)!.detail!;
  assert.match(body, /Builds on \[app#900\]\(https:\/\/github\.com\/storytold\/app\/pull\/900\); lands after it\./);
  assert.doesNotMatch(body, /app#1\]/, "a car lists only its own PRs");

  t.w.gh.live(two!.pr_number!, { ci: "success" });
  await t.run();
  assert.deepEqual(t.w.gh.writesOf("merge"), [], "a green car waits for the car below");
  assert.equal((await t.active())[1]!.summary, "waits for the car below to land");

  t.w.gh.live(one!.pr_number!, { ci: "success" });
  const s = await t.run();
  assert.deepEqual(t.w.gh.writesOf("merge").map((m) => m.number), [900, 901]);
  assert.deepEqual(s.merged, [1, 2]);
});

test("a traced red car evicts the car above; its PRs are built again on the last good base, the suspect alone, the size kept", async () => {
  const t = await setup(2);
  await t.ready(1);
  await t.ready(2);
  await t.run();
  await t.ready(3);
  await t.run();
  const [one, two] = await t.active();
  assert.deepEqual([one!.members, two!.members], [[1, 2], [3]]);
  const size = await batchSizeOf(t.w.db, "app");
  t.fake.log = "test\tRun tests\terror[E0308]: mismatched types\ntest\tRun tests\t  --> src/b.rs:4:5\n";
  t.fake.blame["src/b.rs:4"] = 2;
  t.w.gh.live(one!.pr_number!, { ci: "failure" });
  await t.run();
  const rows = await t.batches();
  assert.equal(rows.find((b) => b.id === one!.id)!.state, "split");
  assert.equal(rows.find((b) => b.id === two!.id)!.state, "superseded");
  assert.ok(t.w.gh.writesOf("close").some((c) => c.number === two!.pr_number), "the evicted car's PR is closed");
  const now = await t.active();
  // The suspect alone and the rest beside the train, and the evicted car's PR in a new car: all on the default branch, the failed car's base.
  assert.deepEqual(now.map((b) => [b.members, b.side, b.below_id, b.base_sha]), [[[2], 1, null, MAIN], [[1], 1, null, MAIN], [[3], 0, null, MAIN]]);
  assert.equal(await batchSizeOf(t.w.db, "app"), size);
});

test("the default branch moving from outside keeps the clean cars and rebuilds the first conflicting one and those above it", async () => {
  const t = await setup(3);
  for (const n of [1, 2, 3]) { await t.ready(n); await t.run(); }
  const [one, two, three] = await t.active();
  assert.deepEqual([one!.members, two!.members, three!.members], [[1], [2], [3]]);
  assert.deepEqual([two!.below_id, three!.below_id], [one!.id, two!.id]);
  t.fake.main = "d".repeat(40);
  t.fake.conflicts.add(two!.commit_sha);
  await t.run();
  const rows = await t.batches();
  const stateOf = (id: number) => rows.find((b) => b.id === id)!.state;
  assert.equal(stateOf(one!.id), "open", "the clean bottom car stays");
  assert.deepEqual([stateOf(two!.id), stateOf(three!.id)], ["superseded", "superseded"]);
  const [, two2, three2] = await t.active();
  assert.deepEqual([two2!.members, two2!.below_id, two2!.base_sha], [[2], one!.id, one!.commit_sha], "rebuilt on the car below");
  assert.deepEqual([three2!.members, three2!.below_id, three2!.base_sha], [[3], two2!.id, two2!.commit_sha]);
});
