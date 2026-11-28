// The review cut on a PR a person approved for merge: one full review at approval; our checked fix-ups carry the review and the pre-merge
// review with no model call, and CI decides; the pre-merge review is read again only after a review that read new code.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runPremerge, type PremergeDeps } from "../src/premerge/review.ts";
import { advancePreapprovals, preapprovalOf, preapproveMerge } from "../src/preapproval/index.ts";
import { carriedPremerges } from "../src/review/carry.ts";
import { runCarry } from "../src/review/carry-step.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { OPERATOR, T0, T1, untilQuiet, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

const quiet = () => {};
const tick = (w: World): Promise<void> => untilQuiet(w.db, [() => advanceWorkflows(w.db), () => advancePreapprovals(w.db)], 3);
const REGRESSION = { class: "regression" as const, why: "an empty list panics where it worked before" };
const kinds = async (w: World, n: number): Promise<string[]> => (await w.prPlan(n)).actions.map((a) => a.kind);

/** An approved PR at sha<n> with a full take review, its merge leg waiting for CI and the pre-merge review. */
async function approvedPr(w: World, n: number): Promise<void> {
  await (await (await w.pr(n)).workflow(n)).review(n);
  await preapproveMerge(w.db, { repo: "app", number: n, by: OPERATOR });
  await w.db.run(w.db.k.updateTable("preapprovals").set({ state: "ci" }).where("number", "=", n));
}

test("an approved PR whose pre-merge fix-up passed its check merges on green CI, with no review or pre-merge model call and one verification", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  await approvedPr(w, 1);
  await w.premerge(1, "defect", true, "off by one", REGRESSION);
  // The pre-merge round's fix-up: checked, linted and pushed; CI at the new head has not finished.
  await w.db.run(w.db.k.insertInto("patch_checks").values({ kind: "fixup", repo: "app", number: 1, subject: "sha1", patch_hash: "x", round: 1, verdict: "approve", reasons: "", problems: "[]", model: "m", created_at: T0 }));
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: "sha1b", state: "pushed", source: "premerge", files: '["src/lib.rs"]', attempt: 1, created_at: T0 }));
  await w.synced(1, "sha1b");
  await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "pending" }).where("number", "=", 1));
  await tick(w);
  // The review carries, with no model call; nothing else is planned before CI is green.
  for (const k of ["review", "premerge", "verify", "merge"]) assert.ok(!(await kinds(w, 1)).includes(k), `${k} before CI is green: ${await kinds(w, 1)}`);
  assert.equal(await runCarry(w.db, "app", quiet), 1);
  await tick(w);
  for (const k of ["review", "premerge", "verify", "merge"]) assert.ok(!(await kinds(w, 1)).includes(k), `${k} before CI is green: ${await kinds(w, 1)}`);

  await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "success" }).where("number", "=", 1));

  let calls = 0;
  await w.models(() => { calls++; return undefined; });
  const deps: PremergeDeps = { fetchDiff: async () => { calls++; return { ok: false, tooLarge: false, error: "no model call expected" }; }, model: "opus", maxChars: 120_000 };
  assert.ok((await kinds(w, 1)).includes("premerge"));
  const s = await runPremerge(w.db, { repo: "app" }, quiet, deps);
  assert.deepEqual([s.carried, s.reviewed, calls], [1, 0, 0]);

  // Verified once, at the head that merges, then handed over and merged as the approver.
  assert.ok((await kinds(w, 1)).includes("verify"));
  await w.verified(1);
  await tick(w);
  assert.equal((await preapprovalOf(w.db, "app", 1))!.state, "queued");
  assert.ok((await kinds(w, 1)).includes("merge"), `${await kinds(w, 1)}`);
});

test("the pre-merge review is read again after a delta review of the author's commits, and carried past a CI fix of ours", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  for (const n of [1, 2]) {
    await approvedPr(w, n);
    await w.premerge(n, "clean");
    await w.synced(n, `sha${n}b`);
    await w.review(n, { head: `sha${n}b` });
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ mode: "delta", base_head: `sha${n}`, at: T1 }).where("number", "=", n).where("head_oid", "=", `sha${n}b`));
  }
  // PR 2's new head is our CI fix; PR 1's is the author's.
  await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 2, head: "sha2", to_head: "sha2b", kind: "code", state: "pushed", attempt: 1, created_at: T0 }));
  const rows = await carriedPremerges(w.db, [{ repo: "app", number: 1, head: "sha1b" }, { repo: "app", number: 2, head: "sha2b" }], "run", T1);
  assert.deepEqual([...rows.keys()], ["app#2@sha2b"]);
});

test("on an approved PR our checked fix-up of a person's own words carries the review and the pre-merge review", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  await approvedPr(w, 1);
  await w.premerge(1, "clean");
  await w.db.run(w.db.k.insertInto("main.operator_fixups").values({ repo: "app", number: 1, from_head: "sha1", instructions: "Keep the box centred when the window narrows.", by: OPERATOR, at: T0, state: "ended" }));
  const [fix] = await w.rows("SELECT id FROM operator_fixups WHERE number = 1");
  await w.db.run(w.db.k.insertInto("patch_checks").values({ kind: "fixup", repo: "app", number: 1, subject: "sha1", patch_hash: "x", round: 1, verdict: "approve", reasons: "", problems: "[]", model: "m", created_at: T0 }));
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: "sha1b", state: "pushed", source: "operator", operator_fix: Number(fix!.id), files: '["src/layout.rs"]', attempt: 1, created_at: T0 }));
  await w.synced(1, "sha1b");
  await tick(w);
  assert.ok(!(await kinds(w, 1)).includes("review"), `${await kinds(w, 1)}`);
  assert.equal(await runCarry(w.db, "app", quiet), 1, "the review carries with no model call");
  assert.equal((await carriedPremerges(w.db, [{ repo: "app", number: 1, head: "sha1b" }], "run", T1)).get("app#1@sha1b")?.findings?.length, 0, "the pre-merge review carries clean");
});
