// Which PRs a batch takes. By area: a new batch takes the top-ranked PR, then the other ready PRs of its area, then the
// rest in rank order, so a ready PR is never left out for an area match. A rebuild, and once the top-up of a batch in its
// first minutes of CI, also takes the PRs that became eligible meanwhile. GitHub and git are faked (test/world-db.ts).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { editAreas, saveItemAreas } from "../src/data/triage/index.ts";
import { runBatches, type BatchDeps } from "../src/merge/batch.ts";
import { world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

async function members(areas: (string | null)[], limit?: number): Promise<number[]> {
  current?.close();
  const w = (current = await (await world()).repo());
  await editAreas(w.db, "app", { op: "replace", areas: [{ name: "render", description: "Drawing" }, { name: "text", description: "Type" }] }, null);
  for (const [i, area] of areas.entries()) {
    const n = i + 1;
    await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
    await saveItemAreas(w.db, "app", 1, [{ repo: "app", number: n, area, source: "operator", confidence: null }]);
  }
  await runBatches(w.db, { repo: "app", ...(limit === undefined ? {} : { limit }) }, () => {}, w.gh.batchDeps());
  const rows = await w.db.all(w.db.k.selectFrom("merge_batch_prs").select("number").orderBy("batch_id").orderBy("position"));
  return rows.map((r) => r.number);
}

test("a batch with room for some takes the top PR's area first; one with room for all takes every ready PR", async () => {
  const areas = ["render", "text", "render", null];
  const some = await members(areas, 2);
  assert.deepEqual(some, [1, 3]);
  const all = await members(areas);
  assert.deepEqual([...all].sort(), [1, 2, 3, 4]);
  assert.ok(all.indexOf(3) < all.indexOf(2), "the top PR's area comes before the rank-order fill");
  // A top PR with no area matches nothing: the batch fills in rank order.
  assert.deepEqual(await members([null, "render", "text", "render"], 2), [1, 2]);
});

test("a rebuild after the default branch moved takes a newly eligible PR; a batch in its first CI minutes is topped up once per lineage", async () => {
  const w = (current = await (await world()).repo());
  const ready = async (n: number) => { await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean"); };
  const base = w.gh.batchDeps();
  w.gh.live(900, { ci: "pending" });
  let main = "a".repeat(40);
  const deps: BatchDeps = {
    ...base,
    mainHead: async () => main,
    exec: async (cmd, args, opts) => {
      const a = args.filter((x, i) => x !== "-c" && args[i - 1] !== "-c");
      if (cmd === "git" && a[0] === "rev-parse" && a[1] === "refs/batch/main") return { code: 0, stdout: `${main}\n`, stderr: "" };
      // Once the default branch moved, it conflicts with every batch tip (the fake's commits are b…b<n>).
      if (cmd === "git" && a[0] === "merge-tree" && main !== "a".repeat(40) && a.at(-1)!.startsWith("b".repeat(39))) return { code: 1, stdout: "", stderr: "" };
      return base.exec(cmd, args, opts);
    },
  };
  const run = () => runBatches(w.db, { repo: "app" }, () => {}, deps);
  const active = async () => {
    const rows = await w.db.all(w.db.k.selectFrom("merge_batches").select("id").where("state", "in", ["checking", "open"]).orderBy("id"));
    return await Promise.all(rows.map(async (b) => (await w.db.all(w.db.k.selectFrom("merge_batch_prs").select("number").where("batch_id", "=", b.id).orderBy("position"))).map((r) => r.number)));
  };
  await ready(1);
  await run();
  assert.deepEqual(await active(), [[1]]);
  await ready(2);
  main = "d".repeat(40);
  await run();
  assert.deepEqual(await active(), [[1, 2]], "the rebuild on the new head takes #2 too");
  await ready(3);
  await run();
  assert.deepEqual(await active(), [[1, 2, 3]], "the open batch is topped up with #3");
  const count = (await w.db.all(w.db.k.selectFrom("merge_batches").select("id"))).length;
  await ready(4);
  await run();
  assert.deepEqual(await active(), [[1, 2, 3]], "a topped-up batch is not topped up again");
  assert.equal((await w.db.all(w.db.k.selectFrom("merge_batches").select("id"))).length, count);
  // Its rebuild on a newer head takes #4 and stays marked: the lineage got its one top-up.
  main = "e".repeat(40);
  await run();
  assert.deepEqual(await active(), [[1, 2, 3, 4]]);
  await ready(5);
  await run();
  assert.deepEqual(await active(), [[1, 2, 3, 4]], "a rebuild of a topped-up batch is not topped up");
});
