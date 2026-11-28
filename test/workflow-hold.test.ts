// `hold` ends all work on an item, started or not, and keeps AutoCraft off it; `resume` (or a yes) by any maintainer goes on with what it
// had, in their name, and accepts no commits that came meanwhile.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setFeature } from "../src/build/features.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { mergeMay } from "../src/core/gates.ts";
import { loadPrFact } from "../src/core/facts.ts";
import { startAttempt } from "../src/data/implement/index.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor, type CommandInput } from "../src/workflow/apply.ts";
import { holdBatched, stopBatch } from "../src/workflow/batch.ts";
import { parse } from "../src/workflow/parse.ts";
import { eventsOf, insertWorkflow, liveWorkflow, updateWorkflow, workflowHistory } from "../src/workflow/store.ts";
import { T0, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MAINT = "mira", OTHER = "noor";
const as = (login: string): Actor => ({ login, canWrite: async () => true });
const send = async (w: World, text: string, login = MAINT, number = 1, o: Partial<CommandInput> = {}) =>
  (await runCommand(w.db, as(login), "github", { parsed: parse(text), items: [{ repo: "app", number }], ...o })).items[0]!;
const run = async (w: World, text: string, login = MAINT, number = 1): Promise<string> => {
  const o = await send(w, text, login, number);
  assert.equal(o.outcome, "run", `${text}: ${o.line}`);
  return o.line;
};
const settle = async (w: World) => {
  for (let i = 0; i < 5; i++) { await advanceWorkflows(w.db); await advancePreapprovals(w.db); }
};
const tick = () => new Promise((r) => setTimeout(r, 5));
async function fresh(): Promise<World> {
  const w = current = await (await (await (await world()).repo(["merge", "push"])).acting(MAINT)).acting(OTHER);
  return await (await (await w.pr(1, { label: "feature" })).verified(1)).premerge(1, "clean");
}
const legs = async (w: World, number = 1) => await w.rows(`SELECT state, "by", head, reason FROM preapprovals WHERE number = ${number} ORDER BY id`);
const push = async (w: World, head: string) => {
  await w.db.run(w.db.k.updateTable("main.items").set({ head_oid: head }).where("number", "=", 1));
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ head_oid: head }).where("number", "=", 1));
};
const mayMerge = async (w: World) => (await mergeMay((await loadPrFact(w.db, "app", 1))!)).ok;

test("an approved PR on hold merges nothing; another maintainer's resume goes on with its merge, as them", async () => {
  for (const coded of [true, false]) {
    const w = await fresh();
    await run(w, "merge");
    await settle(w);
    assert.ok(await mayMerge(w));
    assert.match(await run(w, "stop"), /On hold \(held by mira/);
    await settle(w);
    assert.deepEqual([(await workflowHistory(w.db, "app", 1)).at(-1)!.state, (await legs(w)).map((l) => l.state)], ["stopped", ["cancelled"]]);
    assert.ok(!await mayMerge(w));
    // A leg's end that is stored as its sentence alone counts the same.
    if (!coded) await w.db.run(w.db.k.updateTable("main.preapprovals").set({ reason_code: null }));
    await tick();
    await run(w, "yes", OTHER);
    await settle(w);
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.approvedBy, wf.stoppedBy, wf.blocker], ["running", OTHER, null, null]);
    assert.deepEqual((await legs(w)).map((l) => [l.state, l.by]), [["cancelled", MAINT], ["queued", OTHER]]);
    assert.deepEqual(mergeMay((await loadPrFact(w.db, "app", 1))!), { ok: true, as: "person", by: OTHER });
    w.close();
  }
});

test("the author's commits while it is held are reviewed after a resume", async () => {
  const w = await fresh();
  await run(w, "merge");
  await settle(w);
  await run(w, "hold");
  await push(w, "sha-author");
  await tick();
  await run(w, "resume", OTHER);
  await settle(w);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([wf.state, wf.blocker, wf.step, wf.approvedBy], ["running", null, "review new commits", OTHER]);
  assert.ok(!await mayMerge(w));
});

test("an item held at a blocker comes back with its question; the resume answers nothing", async () => {
  const w = await fresh();
  const rec = { text: "Fix it, then merge.", parts: { fix: [1], drop: [] }, merges: true };
  const id = await insertWorkflow(w.db, {
    repo: "app", number: 1, kind: "pr", entry: "fixup", state: "blocked", startedBy: MAINT, startedAt: T0, startedVia: "github", baseHead: "sha1", approvedBy: MAINT, approvedAt: T0,
    blocker: "failed-twice", blockerParams: { step: "fix-up", count: 2 }, rec, recAt: T0, recHead: "sha1", plan: [{ n: 1, title: "A bug", source: "review", state: "planned" }],
  });
  // The two failed tries the stop counted: one it no longer finds would close it by itself.
  for (const attempt of [1, 2]) await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: null, state: "failed", reason: "the patch did not apply", files: "[]", attempt, created_at: new Date().toISOString() }));
  await run(w, "hold");
  assert.deepEqual([(await workflowHistory(w.db, "app", 1))[0]!.rec, (await send(w, "fix 1")).outcome], [null, "ambiguous"]);
  assert.match(await run(w, "continue", OTHER), /question is open again/);
  await settle(w);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([wf.id, wf.state, wf.blocker, wf.blockerParams, wf.rec, wf.plan[0]!.state], [id, "blocked", "failed-twice", { step: "fix-up", count: 2 }, rec, "planned"]);
});

test("a question that closes by itself does not while the item is held; resumed, it is open again and the pass closes it once its cause is gone", async () => {
  const w = await fresh();
  const rec = { text: "Make the default branch its base.", parts: { fix: [], drop: [] }, merges: true, goes: "look" as const, cause: { code: "base-off-default" as const } };
  for (const head of ["sha1", "sha-author"]) {
    const id = await insertWorkflow(w.db, {
      repo: "app", number: 1, kind: "pr", entry: "merge", state: "blocked", startedBy: MAINT, startedAt: T0, startedVia: "github", baseHead: "sha1", approvedBy: MAINT, approvedAt: T0,
      blocker: "other", blockerParams: { code: "base-off-default", reason: "x" }, rec, recAt: T0, recHead: "sha1",
    });
    await run(w, "hold");
    await push(w, head);
    await settle(w);
    const held = (await workflowHistory(w.db, "app", 1)).at(-1)!;
    assert.deepEqual([held.state, held.stoppedBy], ["stopped", MAINT], "its cause is gone, and the hold stands");
    await run(w, "resume", OTHER);
    assert.deepEqual((await liveWorkflow(w.db, "app", 1))!.rec, rec);
    await settle(w);
    const now = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([now.id, now.state, now.blocker, now.approvedBy, now.step === "review new commits"], [id, "running", null, OTHER, head !== "sha1"]);
    await run(w, "backlog");
  }
});

test("a fix-up that was asked for is asked for again by the resume, as the person, unless the head moved", async () => {
  for (const moved of [false, true]) {
    const w = await fresh();
    await w.review(1, { verdict: "take-fix" });
    await run(w, "fix-up and merge");
    await w.db.run(w.db.k.insertInto("main.operator_fixups").values({ repo: "app", number: 1, from_head: "sha1", instructions: "Fix part 1.", by: MAINT, at: T0 }));
    await run(w, "hold");
    assert.deepEqual((await w.rows("SELECT state FROM operator_fixups")).map((r) => r.state), ["ended"]);
    if (moved) await push(w, "sha-author");
    await run(w, "resume", OTHER);
    const again = (await w.rows("SELECT instructions, state, \"by\" FROM operator_fixups ORDER BY id")).slice(1);
    assert.deepEqual(again, moved ? [] : [{ instructions: "Fix part 1.", state: "queued", by: OTHER }]);
    w.close();
  }
});

test("hold keeps AutoCraft off a PR nobody started; resume puts it back as it was", async () => {
  const w = await fresh();
  await w.review(1);
  assert.ok((await w.prPlan(1)).state !== "out-of-scope");
  await run(w, "hold");
  assert.equal((await w.prPlan(1)).state, "out-of-scope");
  assert.ok(!await mayMerge(w));
  assert.equal((await send(w, "hold", OTHER)).outcome, "refused", "it is held already");
  assert.match(await run(w, "resume", OTHER), /Nobody had started it/);
  assert.ok((await w.prPlan(1)).state !== "out-of-scope");
  assert.deepEqual(await workflowHistory(w.db, "app", 1), []);
  assert.deepEqual((await eventsOf(w.db, "app", 1)).map((e) => [e.kind, e.login]), [["stopped", MAINT], ["resumed", OTHER]]);
});

test("a yes written before the hold resumes nothing, the word resume sent after it does", async () => {
  const w = await fresh();
  const read = new Date(Date.now() - 60_000).toISOString();
  await run(w, "review");
  await run(w, "hold");
  const o = await send(w, "yes", OTHER, 1, { asked: () => read });
  assert.equal(o.outcome, "refused");
  assert.match(o.line, /mira held it/);
  assert.equal((await send(w, "resume", OTHER)).outcome, "run");
});

test("work asked for before the hold does not start again what it ended, whatever the word", async () => {
  const w = await fresh();
  const read = new Date(Date.now() - 60_000).toISOString();
  await run(w, "review");
  await run(w, "hold");
  for (const text of ["merge", "review", "resume"]) {
    const o = await send(w, text, OTHER, 1, { asked: () => read });
    assert.equal(o.outcome, "refused", text);
    assert.match(o.line, /mira held it after you wrote/);
  }
  const now = (await workflowHistory(w.db, "app", 1));
  assert.deepEqual(now.map((x) => x.state), ["stopped"]);
  assert.equal((await send(w, "merge", OTHER, 1, { asked: () => new Date(Date.now() + 1000).toISOString() })).outcome, "run", "written after the hold, it starts the item");
});

test("a held issue whose pull request merged or closed meanwhile ends when it is resumed", async () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const w = await fresh();
    await setFeature(w.db, "implement", true, MAINT, "app");
    await w.issue(7);
    await run(w, "implement and merge", MAINT, 7);
    const { id } = (await startAttempt(w.db, { repo: "app", number: 7, queuedBy: MAINT, textHash: "h" } as never))!;
    await w.db.run(w.db.k.updateTable("main.implementations").set({ state: "pr", pr_number: 1 }).where("id", "=", id));
    await run(w, "hold", MAINT, 7);
    await w.db.run(w.db.k.updateTable("main.items").set({ state, closed_at: new Date().toISOString() }).where("number", "=", 1));
    await tick();
    await run(w, "resume", OTHER, 7);
    await settle(w);
    assert.deepEqual((await workflowHistory(w.db, "app", 7)).map((x) => x.state), [state === "MERGED" ? "done" : "closed"], state);
    assert.equal((await w.rows("SELECT id FROM implementations")).length, 1);
    w.close();
  }
});

test("a held issue without a pull request is implemented again after a resume, with its approval and its plan's dropped parts", async () => {
  const w = await fresh();
  await setFeature(w.db, "implement", true, MAINT, "app");
  await w.issue(7);
  await run(w, "implement and merge", MAINT, 7);
  await startAttempt(w.db, { repo: "app", number: 7, queuedBy: MAINT, textHash: "h" } as never);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  await updateWorkflow(w.db, wf.id, { plan: [{ n: 1, title: "Core", source: "implement", state: "planned" }, { n: 2, title: "Extra", source: "implement", state: "dropped" }] });
  await run(w, "hold", MAINT, 7);
  assert.deepEqual((await w.rows("SELECT state FROM implementations")).map((r) => r.state), ["cancelled"]);
  await tick();
  await run(w, "resume", OTHER, 7);
  const now = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([now.entry, now.approvedBy, now.startedBy, now.plan.map((p) => p.state)], ["implement", OTHER, OTHER, ["planned", "dropped"]]);
  assert.ok("bucket" in (implementStep((await loadItemFact(w.db, "app", 7))!) ?? {}), "the implementation is due");
});

test("removing a PR from its batch holds it, and stopping a batch holds its PRs; the batch ends", async () => {
  const w = await fresh();
  await (await (await w.pr(2, { label: "feature" })).verified(2)).premerge(2, "clean");
  for (const n of [1, 2]) await run(w, "merge", MAINT, n);
  await settle(w);
  const batch = async (id: number, members: number[]) => {
    await w.db.run(w.db.k.insertInto("merge_batches").values({ id, repo: "app", branch: `integration-app-${id}`, state: "open", base_sha: "b", commit_sha: "t", created_at: T0, updated_at: T0 }));
    for (const n of members) await w.db.run(w.db.k.insertInto("merge_batch_prs").values({ batch_id: id, number: n, head_oid: `sha${n}`, position: n }));
  };
  const state = async (id: number) => (await w.rows(`SELECT state FROM merge_batches WHERE id = ${id}`))[0]!.state;
  const states = async () => [1, 2].map(async (n) => (await workflowHistory(w.db, "app", n)).at(-1)!.state);
  await batch(5, [1, 2]);
  assert.match((await holdBatched(w.db, as(MAINT), "dashboard", "app", 1)).line, /On hold/);
  assert.deepEqual([await state(5), await Promise.all(await states())], ["superseded", ["stopped", "running"]]);
  await run(w, "resume");
  await settle(w);
  await batch(6, [1, 2]);
  const r = await stopBatch(w.db, as(OTHER), "dashboard", 6);
  assert.deepEqual([await state(6), r.held, await Promise.all(await states())], ["superseded", [1, 2], ["stopped", "stopped"]]);
  assert.ok((await legs(w)).concat(await legs(w, 2)).every((l) => l.state === "cancelled"), "no merge leg is left");
});

test("a batch that could not be ended says so, and the same control ends it when it is sent again", async () => {
  const w = await fresh();
  await run(w, "merge");
  await settle(w);
  for (const id of [5, 6]) {
    await w.db.run(w.db.k.insertInto("merge_batches").values({ id, repo: "app", branch: `integration-app-${id}`, state: "open", base_sha: "b", commit_sha: "t", pr_number: 50 + id, created_at: T0, updated_at: T0 }));
    await w.db.run(w.db.k.insertInto("merge_batch_prs").values({ batch_id: id, number: 1, head_oid: "sha1", position: 1 }));
    const send1 = async () => (id === 5 ? await holdBatched(w.db, as(MAINT), "dashboard", "app", 1) : await stopBatch(w.db, as(MAINT), "dashboard", id));
    const state = async () => (await w.rows(`SELECT state FROM merge_batches WHERE id = ${id}`))[0]!.state;
    // No app is registered to close its PR with; then there is none to close.
    await assert.rejects(send1(), /could not be closed/);
    assert.deepEqual([await state(), (await workflowHistory(w.db, "app", 1)).at(-1)!.state], ["open", "stopped"]);
    await w.db.run(w.db.k.updateTable("merge_batches").set({ pr_number: null }).where("id", "=", id));
    await send1();
    assert.equal(await state(), "superseded");
    if (id === 5) { await tick(); await run(w, "resume"); await settle(w); }
  }
});
