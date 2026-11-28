// CI at a head is one answer (src/core/evidence.ts ciAt): the planner's facts, the review gate and the checks a merge reads agree on every set of checks.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { CiState } from "../src/core/evidence.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { setOptionalCheck } from "../src/optional-checks.ts";
import { checksOf } from "../src/review/checks.ts";
import { reviewHolds } from "../src/review/gate.ts";
import { OPERATOR, T1, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => { current?.close(); current = null; });

const LINT = "optional / lint", GATE = "required / gate", DOCS = "required / docs";
type Row = { name: string; overall: string; checks?: [string, string][]; /** Runs we approved that have not finished, with the head they are of. */ approved?: string; /** The head the stored checks are of. */ head?: string; want: CiState };
const ROWS: Row[] = [
  { name: "green", overall: "success", want: "success" },
  { name: "running", overall: "pending", want: "pending" },
  { name: "no checks", overall: "none", want: "none" },
  { name: "a required check failed", overall: "failure", checks: [[GATE, "failure"], [DOCS, "success"]], want: "failure" },
  { name: "only an optional check failed", overall: "failure", checks: [[LINT, "failure"], [GATE, "success"]], want: "success" },
  { name: "an optional check failed and a required one runs", overall: "failure", checks: [[LINT, "failure"], [GATE, "pending"]], want: "pending" },
  { name: "only an optional check ran", overall: "failure", checks: [[LINT, "failure"]], want: "none" },
  { name: "only an optional check still runs", overall: "pending", checks: [[LINT, "pending"], [GATE, "success"]], want: "success" },
  { name: "an optional and a required check still run", overall: "pending", checks: [[LINT, "pending"], [GATE, "pending"]], want: "pending" },
  { name: "an optional and a required check failed", overall: "failure", checks: [[LINT, "failure"], [GATE, "failure"]], want: "failure" },
  { name: "green with approved runs unfinished", overall: "success", approved: "here", want: "pending" },
  { name: "red with approved runs unfinished", overall: "failure", checks: [[GATE, "failure"]], approved: "here", want: "pending" },
  { name: "approved runs of another head", overall: "failure", checks: [[GATE, "failure"]], approved: "old", want: "failure" },
  { name: "checks of another head", overall: "failure", checks: [[GATE, "failure"]], head: "old", want: "unknown" },
];

test("the planner, the review gate and the stored checks read the same CI", async () => {
  const w = current = await (await world()).repo();
  await setOptionalCheck(w.db, OPERATOR, "app", LINT, true);
  for (const [i, r] of ROWS.entries()) {
    const n = i + 1;
    await (await w.pr(n)).review(n);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: r.overall, checks: JSON.stringify((r.checks ?? []).map(([name, state]) => ({ name, state }))), ...(r.head ? { head_oid: r.head, fetched_at: "2025-12-01T00:00:00Z" } : {}) }).where("number", "=", n));
    if (r.approved) await w.db.run(w.db.k.insertInto("ci_run_approvals").values({ repo: "app", number: n, head_oid: r.approved === "here" ? `sha${n}` : r.approved, runs: "[]", approved: "[5]", reread: 0, failed: "{}", cross_repo: 1, checked_at: T1, approved_at: T1 }));
  }
  const refs = ROWS.map((_, i) => `app#${i + 1}`);
  const facts = new Map((await loadPrFacts(w.db, { refs })).map((f) => [f.number, f]));
  const hold = await reviewHolds(w.db);
  for (const [i, r] of ROWS.entries()) {
    const n = i + 1;
    assert.equal(facts.get(n)!.ci, r.want, `${r.name}: the planner`);
    const h = await hold("app", n, `sha${n}`);
    assert.deepEqual(h && { kind: h.kind, red: !!h.red }, r.want === "failure" || r.want === "pending" ? { kind: "ci", red: r.want === "failure" } : null, `${r.name}: the review gate`);
    assert.deepEqual(facts.get(n)!.reviewHold ?? null, h, `${r.name}: the gate in the planner's facts`);
    if (!r.head) assert.equal((await checksOf(w.db, "app", n))!.overall, r.want, `${r.name}: the stored checks`);
  }
});

test("red CI holds an automatic review, passes the one a person's live workflow asks for first or for the author's head, and holds our own pushes", async () => {
  const w = current = await (await (await (await world()).repo()).pr(1, { ci: "failure" })).pr(2, { ci: "failure" });
  await w.pr(4, { ci: "failure" });
  await (await w.pr(3, { ci: "failure" })).review(1, { head: "old1" });
  await w.review(2, { head: "old2" });
  await w.review(3, { head: "old3" });
  await w.review(4, { head: "old4" });
  await w.workflow(4, { approved: false });
  await w.workflow(2, { approved: false });
  await w.workflow(3, { approved: false });
  // PR 2's earlier review predates its workflow; PR 3's was made under it, and our fix-up made its head.
  await w.db.run(w.db.k.updateTable("opus_reviews").set({ at: "2025-01-01T00:00:00Z" }).where("number", "=", 2));
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 3, from_head: "old3", to_head: "sha3", state: "pushed", attempt: 1, created_at: T1, source: "review" }));
  const hold = await reviewHolds(w.db);
  assert.deepEqual(await hold("app", 1, "sha1"), { kind: "ci", wait: "CI on the latest commit to pass", red: true });
  assert.equal(await hold("app", 2, "sha2"), null);
  assert.equal((await hold("app", 3, "sha3"))?.kind, "ci");
  assert.equal(await hold("app", 4, "sha4"), null, "a head the author made, reviewed under the workflow before, is asked for");
});

test("runs we approved that have not finished hold off the repair of a head our push turned red", async () => {
  const w = current = await (await (await world()).repo()).pr(1, { ci: "failure" });
  await w.review(1);
  await w.db.run(w.db.k.insertInto("push_outcomes").values({ repo: "app", number: 1, stage: "fixup", action: "fixup-push", from_oid: "sha0", to_oid: "sha1", before_res: "green", after_res: "red", outcome: "broke", at: T1 }));
  const fact = async () => (await loadPrFacts(w.db, { refs: ["app#1"] }))[0]!;
  assert.equal((await fact()).brokeByUs, true);
  await w.db.run(w.db.k.insertInto("ci_run_approvals").values({ repo: "app", number: 1, head_oid: "sha1", runs: "[]", approved: "[5]", reread: 0, failed: "{}", cross_repo: 1, checked_at: T1, approved_at: T1 }));
  assert.equal((await fact()).brokeByUs, false);
});
