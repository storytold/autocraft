import assert from "node:assert/strict";
import { loadAllDiffFacts, loadChecks, loadCheckSamples, loadDiffFacts, loadGates, loadRepoCiSignals, markDiffRead, markGateFailures, removeDiffFacts, saveChecks, saveDiffFacts, saveGates, setDiffFactsIf } from "../../src/data/mirror/index.ts";
import type { PrChecksRow } from "../../src/data/mirror/index.ts";
import type { Db } from "../helpers/raw-db.ts";
import { both, bothFlat } from "./mirror-fixture.ts";

const check = (repo: string, number: number, o: Partial<PrChecksRow> = {}): PrChecksRow =>
  ({ repo, number, head_oid: "h1", state: "OPEN", is_draft: 0, overall: "success", checks: '[{"name":"build","state":"success"}]', mergeable: "MERGEABLE", maintainer_can_modify: 1, fetched_at: "x", ...o });
const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));
const fact = (number: number, head: string, o: Record<string, number | string | null> = {}) => ({ repo: "app", number, head_oid: head, reasons: "[]", lines: 10, pending: 0, last_read: null, ...o }) as never;

both("saveChecks keeps a known mergeable at the same head when GitHub reports UNKNOWN, and takes any value at a new head", async (db) => {
  await saveChecks(db, [check("app", 1), check("app", 2), check("app", 3, { mergeable: "UNKNOWN" })], "t1");
  await saveChecks(db, [check("app", 1, { mergeable: "UNKNOWN" }), check("app", 2, { mergeable: "UNKNOWN", head_oid: "h2" }), check("app", 3, { mergeable: "CONFLICTING" }), check("app", 3, { mergeable: "MERGEABLE" })], "t2");
  const m = await loadChecks(db, refs(3));
  assert.deepEqual([1, 2, 3].map((n) => m.get(`app#${n}`)!.mergeable), ["MERGEABLE", "UNKNOWN", "MERGEABLE"]);
  assert.equal(m.get("app#1")!.fetched_at, "t2");
  return [...m.values()].map((r) => [r.mergeable, r.fetched_at]);
});

both("loadChecks can leave the check list out of rows that are not failing", async (db) => {
  await saveChecks(db, [check("app", 1, { overall: "failure" }), check("app", 2)], "t");
  const m = await loadChecks(db, refs(2), { checksOnlyIfNotGreen: true });
  assert.deepEqual([m.get("app#1")!.checks === null, m.get("app#2")!.checks === null], [false, true]);
  assert.ok((await loadChecks(db, refs(2))).get("app#2")!.checks!.includes("build"));
  return [m.get("app#1")!.checks, m.get("app#2")!.checks];
});

both("loadRepoCiSignals and loadCheckSamples read a repo's latest rows", async (db) => {
  await saveChecks(db, [check("none", 1, { overall: "none", checks: "[]" }), check("none", 2, { overall: "none", checks: "[]" }), check("some", 1, { overall: "none", checks: "[]" }), check("some", 2)], "t");
  const s = await loadRepoCiSignals(db, ["none", "some", "fresh"]);
  assert.deepEqual([s.get("none"), s.get("some"), s.get("fresh")], [{ known: true, noCi: true }, { known: true, noCi: false }, { known: false, noCi: false }]);
  assert.equal((await loadRepoCiSignals(db)).size, 2);
  await db.write(async () => { await db.run(db.k.insertInto("main.main_ci").values({ repo: "some", head_sha: "m1", branch: "main", state: "success", failing: "[]", checks: '[{"name":"deploy"}]', first_seen_at: "t", state_changed_at: "t", updated_at: "t" })); });
  const samples = await loadCheckSamples(db, ["some", "none"]);
  assert.deepEqual(samples.get("some"), { pr: ["build"], main: ["deploy"] });
  assert.deepEqual(samples.get("none"), { pr: [], main: [] });
  return [s.get("some"), samples.get("some")];
});

both("review gates: a read resets the failure counter, failures add up", async (db) => {
  await markGateFailures(db, ["app#1", "app#1", "app#2"]);
  await markGateFailures(db, ["app#1"]);
  let g = await loadGates(db, { repo: "app" });
  assert.deepEqual([g.get("app#1")!.failures, g.get("app#2")!.failures], [3, 1]);
  await saveGates(db, [{ repo: "app", number: 1, blocked: 1, by_login: "rev", read_at: "t" }]);
  g = await loadGates(db, refs(2));
  assert.deepEqual([g.get("app#1")!.failures, g.get("app#1")!.blocked, g.get("app#2")!.failures], [0, 1, 1]);
  return refs(2).map((r) => g.get(`${r.repo}#${r.number}`)!.failures);
});

both("diff facts: upsert only when a fact changed, compare-and-set, read mark and removal", async (db) => {
  await saveDiffFacts(db, [fact(1, "a"), fact(2, "b")], "insert-ignore");
  await saveDiffFacts(db, [fact(1, "a", { lines: 99 }), fact(3, "c")], "insert-ignore");
  assert.equal((await loadDiffFacts(db, [{ ref: "app#1", head: "a" }])).get("app#1@a")!.lines, 10);
  await saveDiffFacts(db, [fact(1, "a", { lines: 99 })], "upsert-if-changed");
  assert.equal((await loadDiffFacts(db, [{ ref: "app#1", head: "a" }])).get("app#1@a")!.lines, 99);
  // The guard compares the stored row with `was`: only the row that still holds it is written.
  const n = await setDiffFactsIf(db, [
    { key: { ref: "app#1", head: "a" }, was: fact(1, "a", { lines: 99 }), to: fact(1, "a", { lines: 1, pending: 1 }) },
    { key: { ref: "app#2", head: "b" }, was: fact(2, "b", { lines: 5 }), to: fact(2, "b", { lines: 2 }) },
    { key: { ref: "app#4", head: "d" }, was: null, to: fact(4, "d") },
    { key: { ref: "app#3", head: "c" }, was: null, to: fact(3, "c", { lines: 7 }) },
  ]);
  assert.equal(n, 2);
  const all = await loadAllDiffFacts(db);
  assert.deepEqual([all.get("app#1@a")!.lines, all.get("app#1@a")!.pending, all.get("app#2@b")!.lines, all.get("app#3@c")!.lines, all.has("app#4@d")], [1, 1, 10, 10, true]);
  await markDiffRead(db, [{ ref: "app#2", head: "b" }], 1234);
  await removeDiffFacts(db, [{ ref: "app#3", head: "c" }]);
  assert.deepEqual([(await loadDiffFacts(db, [{ ref: "app#2", head: "b" }])).get("app#2@b")!.last_read, (await loadDiffFacts(db, refs(4))).has("app#3@c")], [1234, false]);
  return [...(await loadAllDiffFacts(db)).keys()].sort();
});

const seedChecks = async (db: Db, size: number) => {
  await saveChecks(db, Array.from({ length: size }, (_, i) => check("app", i + 1, { overall: i % 2 ? "failure" : "none" })), "t");
  await db.write(async () => {
    await db.run(db.k.insertInto("main.review_gates").values(Array.from({ length: size }, (_, i) => ({ repo: "app", number: i + 1, blocked: 0, by_login: "", read_at: "t", failures: 0 }))));
    await db.run(db.k.insertInto("main.diff_facts").values(Array.from({ length: size }, (_, i) => fact(i + 1, "h1"))));
  });
};

bothFlat("the check, gate and diff-fact loaders issue the same number of statements for 2 and 12 keys", seedChecks, async (db, size) => {
  const keys = refs(size);
  await db.together(async () => {
    await Promise.all([loadChecks(db, keys), loadRepoCiSignals(db, ["app"]), loadCheckSamples(db, ["app"]), loadGates(db, keys), loadDiffFacts(db, keys),
      loadDiffFacts(db, keys.map((k) => ({ ref: `${k.repo}#${k.number}`, head: "h1" })))]);
  });
});

bothFlat("the check and diff-fact writers issue the same number of statements for 2 and 12 rows", async () => {}, async (db, size) => {
  const n = Array.from({ length: size }, (_, i) => i + 1);
  await saveChecks(db, n.map((i) => check("app", i)), "t");
  await saveGates(db, n.map((i) => ({ repo: "app", number: i, blocked: 0, by_login: "", read_at: "t" })));
  await markGateFailures(db, n.map((i) => `app#${i}`));
  await saveDiffFacts(db, n.map((i) => fact(i, "h")), "upsert-if-changed");
  await setDiffFactsIf(db, n.map((i) => ({ key: { ref: `app#${i}`, head: "h" }, was: fact(i, "h"), to: fact(i, "h", { lines: 3 }) })));
  await markDiffRead(db, n.map((i) => ({ ref: `app#${i}`, head: "h" })), 5);
  await removeDiffFacts(db, n.map((i) => ({ ref: `app#${i}`, head: "h" })));
});
