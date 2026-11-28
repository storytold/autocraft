// The merge approval of a started PR and AutoCraft's own pushes: whatever step made the push and wherever the merge leg is, the approval stays, nobody
// is asked again, and the new head goes through the review, CI and the pre-merge review it needs. Anyone else's commits end it.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { addOwnPush, landOwnPush } from "../src/data/control/index.ts";
import { loadOwnPushes } from "../src/data/views/own-pushes.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { advancePreapprovals, preapprovalOf, preapproveMerge } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { OPERATOR, T0, untilQuiet, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

const fixup = (source: string | null) => (w: World, n: number, from: string, to: string) =>
  w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: n, from_head: from, to_head: to, state: "pushed", source, attempt: 1, created_at: T0 }));
const cifix = (w: World, number: number, head: string, to_head: string) =>
  w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number, head, to_head, kind: "code", state: "pushed", attempt: 1, created_at: T0 }));
const merged = (own_diff: string | null) => (w: World, number: number, from_head: string, to_head: string) =>
  w.db.run(w.db.k.insertInto("conflict_merges").values({ repo: "app", number, from_head, to_head, state: "merged", attempt: 1, created_at: T0, own_diff }));
const revision = (w: World, number: number, from_oid: string, to_oid: string) =>
  w.db.run(w.db.k.insertInto("push_outcomes").values({ at: T0, stage: "implement", action: "implement-push", repo: "app", number, from_oid, to_oid, before_res: "unknown" }));
const repin = (w: World, number: number, head: string, to_head: string) =>
  w.db.run(w.db.k.insertInto("autorepins").values({ repo: "app", number, ref_repo: "libs", ref_number: 5, login: OPERATOR, github_id: 1, requested_at: T0, state: "pushed", head, to_head, done_at: T0 }));
/** A push a crash left between the push and its record. */
const pushing = (w: World, n: number, from: string, to: string) =>
  w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: n, head: from, to_head: to, kind: "code", state: "pushing", attempt: 1, created_at: T0 }));

/** A push recorded right before it was made; a crash came before git's answer was stored. */
const made = (action: string) => (w: World, number: number, from_oid: string, to_oid: string) =>
  w.db.run(w.db.k.insertInto("own_pushes").values({ repo: "app", number, from_oid, to_oid, action, at: T0 }));

const PUSHES: {
  name: string; push: (w: World, n: number, from: string, to: string) => Promise<unknown>;
  /** Nothing a model wrote: a PR that merges without a review needs none after it. */ small?: true;
  /** A fix-up a person asked for, which its check judged against their words: a PR that merges without a review needs none after it either. */ asked?: true;
}[] = [
  { name: "review fix-up", push: fixup(null) },
  { name: "pre-merge fix-up", push: fixup("premerge") },
  { name: "operator fix-up", push: fixup("operator"), asked: true },
  { name: "CI fix", push: cifix },
  { name: "CI fix left by a crash", push: pushing },
  { name: "clean base merge", push: merged("same"), small: true },
  { name: "resolved conflict", push: merged("changed") },
  { name: "base merge whose diff nobody could read", push: merged(null) },
  { name: "implementation revision", push: revision },
  { name: "implementation revision left by a crash", push: made("implement-push") },
  { name: "autorepin", push: made("autorepin-push"), small: true },
  { name: "autorepin from before own_pushes", push: repin, small: true },
];
const STATES = ["review", "ci", "queued"] as const;

/** Every push kind, leg state and entry, one PR each. */
type Case = (typeof PUSHES)[number] & { n: number; state: (typeof STATES)[number]; entry: "review" | "merge" };
const cases = (): Case[] => {
  let n = 0;
  return PUSHES.flatMap((p) => STATES.flatMap((state) => (["review", "merge"] as const).map((entry) => ({ ...p, n: ++n, state, entry }))));
};
/** A started PR approved for merge whose leg is in `state` at sha<n>. A merge entry has an old review that says close, which plays no part. */
async function approved(w: World, c: Pick<Case, "n" | "state" | "entry">): Promise<void> {
  await (await w.pr(c.n)).workflow(c.n, { entry: c.entry });
  await w.review(c.n, { verdict: c.entry === "merge" ? "close" : "take" });
  if (c.entry === "merge") await w.db.run(w.db.k.updateTable("opus_reviews").set({ at: "2020-01-01T00:00:00.000Z" }).where("number", "=", c.n));
  await preapproveMerge(w.db, { repo: "app", number: c.n, by: OPERATOR });
  await w.db.run(w.db.k.updateTable("preapprovals").set({ state: c.state }).where("number", "=", c.n));
}
const tick = (w: World, times = 3): Promise<void> => untilQuiet(w.db, [() => advanceWorkflows(w.db), () => advancePreapprovals(w.db)], times);
const legOf = async (w: World, n: number) => (await preapprovalOf(w.db, "app", n))!;

test("a push of ours keeps the merge approval, whatever made it and wherever the leg is, and asks nobody", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  const all = cases();
  for (const c of all) await approved(w, c);
  for (const c of all) { await c.push(w, c.n, `sha${c.n}`, `sha${c.n}b`); await w.synced(c.n, `sha${c.n}b`); await w.verified(c.n); }
  await tick(w);
  const plans = new Map((await w.plan()).prs.map((p) => [p.facts.number, p.plan]));
  const heads = all.map((c) => ({ number: c.n, head: `sha${c.n}b` }));
  const early = await mergeVerdicts(w.db, "app", heads);
  for (const c of all) {
    const label = `${c.name}, ${c.state}, ${c.entry}`;
    const wf = (await liveWorkflow(w.db, "app", c.n))!, leg = await legOf(w, c.n);
    const unreviewed = c.entry === "merge" && !!(c.small || c.asked);
    assert.deepEqual([wf.state, wf.blocker, wf.baseHead, wf.approvedBy], ["running", null, `sha${c.n}b`, OPERATOR], label);
    assert.deepEqual([leg.state, leg.head, leg.fromHead], [unreviewed ? "ci" : "review", `sha${c.n}b`, `sha${c.n}`], label);
    // The next step is planned: the review (or its carry), or the pre-merge review where none is needed.
    const kinds = plans.get(c.n)!.actions.map((a) => a.kind);
    assert.ok(kinds.includes(unreviewed ? "premerge" : c.name === "clean base merge" ? "carry" : "review"), `${label}: ${kinds.join()}`);
    assert.ok(!kinds.includes("merge"), label);
    const may = early.get(c.n)!;
    assert.ok(!may.ok && may.why.code === "not-handed-over", `${label}: ${JSON.stringify(may)}`);
  }

  // Reviewed, green and clean at the new head, every one is handed over and may merge as the approver.
  for (const c of all) {
    if (!(c.entry === "merge" && (c.small || c.asked))) await w.review(c.n, { sure: false });
    await w.premerge(c.n, "clean");
  }
  await tick(w);
  const verdicts = await mergeVerdicts(w.db, "app", heads);
  for (const c of all) {
    assert.equal((await legOf(w, c.n)).state, "queued", `${c.name}, ${c.state}, ${c.entry}`);
    assert.deepEqual(verdicts.get(c.n), { ok: true, as: `user:${OPERATOR}`, by: { kind: "person", login: OPERATOR } }, `${c.name}, ${c.state}, ${c.entry}`);
  }
});

test("someone else's commits end the leg and go to the review round, also under a push of ours or after one", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  const after = STATES.map((state, i) => ({ n: 1 + i, state, entry: "review" as const }));
  const under = STATES.map((state, i) => ({ n: 4 + i, state, entry: "merge" as const }));
  for (const c of [...after, ...under]) await approved(w, c);
  // Ours, then theirs on top; and theirs with ours on top.
  for (const c of after) { await cifix(w, c.n, `sha${c.n}`, `sha${c.n}b`); await w.synced(c.n, `sha${c.n}b`); }
  await tick(w);
  for (const c of after) { assert.equal((await legOf(w, c.n)).state, "review"); await w.synced(c.n, `theirs${c.n}`); }
  for (const c of under) { await cifix(w, c.n, `theirs${c.n}`, `sha${c.n}c`); await w.synced(c.n, `sha${c.n}c`); }
  await tick(w);
  for (const c of [...after, ...under]) {
    const wf = (await liveWorkflow(w.db, "app", c.n))!;
    assert.deepEqual([wf.state, wf.blocker, wf.step, (await legOf(w, c.n)).state], ["running", null, "review new commits", "cancelled"], `${c.n}`);
  }
});

test("the review a push of ours owes a merge entry has a hold fixed first, and its fixes made on a take-fix", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  for (const n of [1, 2]) {
    await approved(w, { n, state: "ci", entry: "merge" });
    await cifix(w, n, `sha${n}`, `sha${n}b`);
    await w.synced(n, `sha${n}b`);
  }
  await tick(w);
  await w.review(1, { verdict: "hold" });
  await w.review(2, { verdict: "take-fix" });
  await tick(w);
  assert.deepEqual([(await liveWorkflow(w.db, "app", 1))!.rec, (await legOf(w, 1)).state], [null, "fixup"], "a hold gets a fix-up and a new leg, no question");
  assert.deepEqual([(await liveWorkflow(w.db, "app", 2))!.state, (await legOf(w, 2)).state], ["running", "review"]);
  assert.ok((await w.prPlan(2)).actions.some((a) => a.kind === "fixup" && a.params?.bucket === "fix"));
});

test("a push of ours while the approved fix-up waits takes the fix-up to the new head", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  for (const n of [1, 2]) { await (await (await w.pr(n)).workflow(n)).review(n, { verdict: "take-fix" }); await w.fixup(n, n === 1); }
  await w.db.run(w.db.k.updateTable("items").set({ maintainer_can_modify: 1 }));
  // A try stored at the old head for its lint check is dropped there, and says nothing about the request.
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 1, from_head: "sha1", state: "superseded", attempt: 1, created_at: T0, source: "operator", operator_fix: Number((await w.rows("SELECT id FROM operator_fixups WHERE number = 1"))[0]!.id) }));
  for (const n of [1, 2]) { await cifix(w, n, `sha${n}`, `sha${n}b`); await w.synced(n, `sha${n}b`); }
  await tick(w);
  assert.deepEqual([(await legOf(w, 1)).state, (await legOf(w, 1)).fromHead, (await legOf(w, 1)).reason], ["fixup", "sha1b", null]);
  for (const n of [1, 2]) {
    assert.deepEqual(await w.rows("SELECT state, from_head FROM operator_fixups WHERE number = ?", n), [{ state: "queued", from_head: `sha${n}b` }]);
    assert.ok((await w.prPlan(n)).actions.some((a) => a.kind === "fixup" && a.params?.source === "operator"), `${n}`);
  }
  await w.synced(1, "theirs");
  await tick(w);
  assert.equal((await legOf(w, 1)).state, "cancelled");
});

test("a push of ours the mirror does not show yet neither moves the leg nor ends it, until a sync that began after it has finished", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  for (const [n, o] of [[1, { mergeable: "CONFLICTING" }], [2, { overall: "failure" }]] as const) {
    await approved(w, { n, state: "ci", entry: "review" });
    await w.db.run(w.db.k.updateTable("pr_checks").set(o).where("number", "=", n));
  }
  await w.db.run(w.db.k.updateTable("items").set({ base_ref: "main" }));
  const at = new Date().toISOString();
  await merged("same")(w, 1, "sha1", "sha1b");
  await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 2, head: "sha2", to_head: "sha2b", kind: "code", state: "pushed", attempt: 1, created_at: at }));
  for (const n of [1, 2]) {
    await w.db.run(w.db.k.insertInto("push_outcomes").values({ at, stage: "fixup", action: n === 1 ? "conflict-push" : "cifix-push", repo: "app", number: n, from_oid: `sha${n}`, to_oid: `sha${n}b`, before_res: "unknown" }));
  }
  await tick(w);
  for (const n of [1, 2]) assert.deepEqual([(await legOf(w, n)).state, (await legOf(w, n)).head, (await liveWorkflow(w.db, "app", n))!.state], ["ci", `sha${n}`, "running"]);
  // The push never shows: the leg judges the head it has.
  await w.db.run(w.db.k.updateTable("repos").set({ synced_at: new Date(Date.now() + 1000).toISOString() }));
  await tick(w);
  assert.equal((await legOf(w, 2)).state, "failed");
});

test("every push of ours is one list: its kind, its size, and the newest time recorded for it", async () => {
  const w = (current = await (await (await world()).repo()).pr(1));
  await fixup(null)(w, 1, "a", "b");
  await addOwnPush(w.db, { repo: "app", number: 1, from: "a", to: "b", action: "fixup-push", lines: 12 }, "2026-11-01T00:00:00.000Z");
  // Tried again, and done; a later record of the same commit changes nothing.
  for (const at of ["2026-12-01T00:00:00.000Z", "2026-12-02T00:00:00.000Z"]) {
    await addOwnPush(w.db, { repo: "app", number: 1, from: "a", to: "b", action: "fixup-push", lines: 12 }, at);
    await landOwnPush(w.db, { repo: "app", number: 1, to: "b" }, at);
  }
  await repin(w, 1, "b", "c");
  const got = (await loadOwnPushes(w.db, [{ repo: "app", number: 1 }])).get("app#1")!;
  assert.deepEqual(got.map((p) => [p.from, p.to, p.what, p.lines, p.landed, p.small]), [["a", "b", "fix-up", 12, true, false], ["b", "c", "autorepin", null, false, true]]);
  assert.equal(got[0]!.at, "2026-12-01T00:00:00.000Z");
});

test("a push whose patch is older than the start owes its review by the time it was made", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  await approved(w, { n: 1, state: "ci", entry: "merge" });
  await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 1, head: "sha1", to_head: "sha1b", kind: "code", state: "pushing", attempt: 1, created_at: "2020-01-01T00:00:00.000Z" }));
  await made("cifix-push")(w, 1, "sha1", "sha1b");
  await w.synced(1, "sha1b");
  await tick(w);
  assert.equal((await legOf(w, 1)).state, "review");
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "review"));
});

test("a fix-up request without a leg whose try another push overtook goes on at the new head, and is dropped with a line when the push was not ours", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  const drop = async (n: number, at = T0) => {
    await (await (await w.pr(n)).workflow(n)).review(n, { verdict: "take-fix" });
    await w.fixup(n, false);
    const id = Number((await w.rows("SELECT id FROM operator_fixups WHERE number = ?", n))[0]!.id);
    if (at !== T0) await w.db.run(w.db.k.updateTable("operator_fixups").set({ at }).where("id", "=", id));
    await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: n, from_head: `sha${n}`, state: "superseded", reason: "the branch moved before the push", attempt: 1, created_at: T0, source: "operator", operator_fix: id }));
  };
  for (const n of [1, 2]) await drop(n);
  await drop(3, "2020-01-01T00:00:00.000Z");
  await w.db.run(w.db.k.updateTable("items").set({ maintainer_can_modify: 1 }));
  // The mirror does not show the push that came first: the request waits for it.
  await addOwnPush(w.db, { repo: "app", number: 1, from: "sha1", to: "sha1b", action: "implement-push", lines: 3 });
  await landOwnPush(w.db, { repo: "app", number: 1, to: "sha1b" });
  await w.synced(2, "theirs");
  await cifix(w, 3, "sha3", "sha3b");
  await w.synced(3, "sha3b");
  await tick(w, 1);
  const requests = async () => (await w.rows("SELECT number, state, from_head FROM operator_fixups ORDER BY number")).map((r) => [Number(r.number), r.state, r.from_head]);
  // 3: made before a person last chose to go on; nobody waits for it any more.
  assert.deepEqual(await requests(), [[1, "queued", "sha1"], [2, "ended", "sha2"], [3, "queued", "sha3"]]);
  await w.synced(1, "sha1b");
  await tick(w, 1);
  assert.deepEqual((await requests())[0], [1, "queued", "sha1b"]);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.params?.source === "operator"));
});

test("a conflict merge of ours that was force-pushed away is made again, and after the tries at the head its approver is asked", async () => {
  const w = (current = await (await (await world()).repo()).acting());
  await approved(w, { n: 1, state: "ci", entry: "review" });
  await w.db.run(w.db.k.updateTable("pr_checks").set({ mergeable: "CONFLICTING" }));
  await w.db.run(w.db.k.updateTable("items").set({ base_ref: "main" }));
  const conflicts = async () => (await w.prPlan(1)).actions.filter((a) => a.kind === "conflict" && a.params?.bucket === "merge").length;
  // After the last try the PR approved for merge is not left to its contributor: the workflow asks its approver, and its leg ends with that question.
  for (const [to, again, leg] of [["sha1b", 1, "ci"], ["sha1c", 0, "cancelled"]] as const) {
    assert.equal(await conflicts(), 1);
    const at = new Date().toISOString();
    await merged("same")(w, 1, "sha1", to);
    await w.db.run(w.db.k.insertInto("push_outcomes").values({ at, stage: "fixup", action: "conflict-push", repo: "app", number: 1, from_oid: "sha1", to_oid: to, before_res: "unknown" }));
    await tick(w);
    // Not shown yet: nothing is merged twice.
    assert.deepEqual([await conflicts(), (await legOf(w, 1)).state], [0, "ci"]);
    // Pushed away before the mirror showed it: GitHub's update after the push has the old head.
    await new Promise((r) => setTimeout(r, 5));
    const later = new Date().toISOString();
    await w.db.run(w.db.k.updateTable("items").set({ updated_at: later }));
    await w.db.run(w.db.k.updateTable("pr_checks").set({ fetched_at: later }));
    await w.db.run(w.db.k.updateTable("repos").set({ synced_at: later }));
    await tick(w);
    assert.deepEqual([await conflicts(), (await legOf(w, 1)).state], [again, leg], to);
  }
  assert.deepEqual((await w.db.all(w.db.k.selectFrom("item_workflows").select("state"))).map((r) => r.state), ["blocked"]);
  await w.verified(1);
  const plan = await w.prPlan(1);
  assert.ok(["person", "contributor"].includes(plan.waitKind!) && plan.wait, JSON.stringify([plan.wait, plan.actions]));
});
