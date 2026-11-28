// An approved merge goes on through the pipeline's own fix-ups, and a review that failed for good is tried again once per request.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { advancePreapprovals, preapprovalOf } from "../src/preapproval/index.ts";
import { markReviewsStale } from "../src/review/discussion.ts";
import { FAILURE_BACKOFF_MS, recordReviewFailure, reviewHold } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { OPERATOR, T0, untilQuiet, world, type World } from "./world-db.ts";

let current: World | null = null;
const fresh = async (): Promise<World> => (current = await (await world()).repo());
afterEach(() => current?.close());

const startPushed = async (w: World, n: number, to: string) => {
  await w.fixup(n);
  const fix = (await w.rows("SELECT id FROM operator_fixups WHERE number = ? ORDER BY id DESC", n))[0]!.id as number;
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: n, from_head: `sha${n}`, to_head: to, state: "pushed", attempt: 1, created_at: T0, source: "operator", operator_fix: fix }));
  await w.synced(n, to);
};
const settle = (w: World) => untilQuiet(w.db, [() => advancePreapprovals(w.db)], 5);
/** Model failures at one head that make its review fail for good: one past the last backoff. */
const FOR_GOOD = FAILURE_BACKOFF_MS.length + 1;

describe("a review that failed for good", () => {
  test("a request newer than the last failure grants exactly one more try", async () => {
    const w = await (await fresh()).pr(1);
    const t = Date.now() - 60_000;
    for (let i = 0; i < FOR_GOOD; i++) await recordReviewFailure(w.db, "app", 1, "h", t);
    const held = await reviewHold(w.db, "app", 1, "h");
    assert.equal(held?.kind, "failed");
    assert.match(held!.wait, /Review again/);
    await markReviewsStale(w.db, OPERATOR, "app", 1);
    assert.equal(await reviewHold(w.db, "app", 1, "h"), null);
    // The extra try fails too: final again until the next request.
    await recordReviewFailure(w.db, "app", 1, "h", Date.now() + 1000);
    assert.equal((await reviewHold(w.db, "app", 1, "h"))?.kind, "failed");
  });
});

describe("a fix-up's push and the review of it", () => {
  test("the push lifts a blocked hold; a review that failed for good fails the approved merge", async () => {
    const w = await (await (await (await (await (await fresh()).acting()).pr(1)).workflow(1)).review(1, { verdict: "hold" })).pr(2);
    await (await (await w.pr(3)).workflow(3)).review(3, { verdict: "take-fix" });
    await saveOpus(w.db, "rv", { repo: "app", number: 1, head_oid: "sha1" }, {
      mode: "full", base: null, model: "m",
      review: { ref: "app#1", verdict: "hold", sure: true, reason: "r", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: ["app#2"] },
    });
    await startPushed(w, 1, "sha1b");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review", String((await preapprovalOf(w.db, "app", 1))?.reason));
    assert.equal(await reviewHold(w.db, "app", 1, "sha1b"), null);

    await startPushed(w, 3, "sha3b");
    for (let i = 0; i < FOR_GOOD; i++) await recordReviewFailure(w.db, "app", 3, "sha3b");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 3))?.state, "failed");
  });
});

describe("a sure take-fix review of a pre-approved fix-up", () => {
  test("the pipeline's fix-up runs, its push continues the pre-approval, and a take moves it to ci", async () => {
    const w = await (await (await (await (await fresh()).acting()).pr(1)).workflow(1)).review(1, { verdict: "take-fix" });
    await startPushed(w, 1, "sha1b");
    await settle(w);
    await w.review(1, { verdict: "take-fix", head: "sha1b" });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review");
    const kinds = (await w.prPlan(1)).actions.map((a) => `${a.kind}:${String(a.params?.source ?? "")}`);
    assert.ok(kinds.includes("fixup:review"), kinds.join());

    await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 1, from_head: "sha1b", to_head: "sha1c", state: "pushed", attempt: 1, created_at: T0, source: "review" }));
    await w.synced(1, "sha1c");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.head, "sha1c");
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review");
    await w.review(1, { head: "sha1c" });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "ci");
  });
});
