// A workflow's stop at a blocker and a person's command: the row, its event and the end of its merge leg are one write, made only while the
// row is as the pass read it (src/workflow/block.ts). And the PR heads a person accepted, as the row says them.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { acceptedHeads, isAccepted } from "../src/core/evidence.ts";
import { workflowGate } from "../src/core/may.ts";
import { addOwnCommits } from "../src/data/control/index.ts";
import { startAttempt } from "../src/data/implement/index.ts";
import { moveWorkflows, saveWorkflows } from "../src/data/workflow/index.ts";
import { textHash } from "../src/core/open-prs.ts";
import { currentAttempt, writeStep } from "../src/implement/attempt.ts";
import { markStuck } from "../src/implement/stuck.ts";
import { setFeature } from "../src/build/features.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { eventsOf, liveWorkflow, workflowHistory } from "../src/workflow/store.ts";
import { world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MAINT = "mira";
const actor: Actor = { login: MAINT, canWrite: async () => true };
const pause = () => new Promise((r) => setTimeout(r, 4));

/** The repo "app" on the maintainer workflow with a maintainer who may act. */
async function repo(): Promise<World> {
  const w = current = await (await world()).repo();
  const { db } = w;
  await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("main.access").values({ login: MAINT, role: "maintainer" }));
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: MAINT, repo: "app", permission: "write", checked_at: new Date().toISOString() }));
  return w;
}
const command = async (w: World, text: string, number = 1) => (await runCommand(w.db, actor, "dashboard", { parsed: parse(text), items: [{ repo: "app", number }] })).items[0]!;
const run = async (w: World, text: string, number = 1): Promise<void> => { const o = await command(w, text, number); assert.equal(o.outcome, "run", o.line); };
/** Two failed fix-up tries at `head`: a step that failed twice, which stops an approved item. */
const failedTwice = async (w: World, head: string) => {
  for (const [state, attempt] of [["failed", 1], ["refused", 2]] as const) await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: head, to_head: null, state, reason: null, files: "[]", attempt, created_at: new Date().toISOString(), source: "review" }));
};
const legs = async (w: World, number = 1) => await w.db.all(w.db.k.selectFrom("main.preapprovals").selectAll().where("number", "=", number).orderBy("id"));
const ACTIVE = ["fixup", "review", "ci", "queued"];
const activeLegs = async (w: World, number = 1) => (await legs(w, number)).filter((l) => ACTIVE.includes(l.state)).length;

/** PR 1 started at Review with the merge approved and a merge leg, and a failing step that stops it. */
async function stopping(): Promise<World> {
  const w = await repo();
  await w.pr(1, { label: "feature" });
  await run(w, "review and merge");
  await advanceWorkflows(w.db);
  await pause();
  await failedTwice(w, "sha1");
  return w;
}

/** Runs `task` with `act` made by another process before its outer write number `n` (0: the first); returns the writes it made. */
async function during(w: World, n: number, task: () => Promise<unknown>, act: () => Promise<unknown>): Promise<number> {
  const { db } = w, write = db.write;
  let writes = 0;
  const counted = (async (f: () => Promise<unknown>, o?: never) => {
    if (!db.inTransaction() && writes++ === n) {
      db.write = write;
      await act();
      db.write = counted;
    }
    return await write.call(db, f, o);
  }) as typeof write;
  db.write = counted;
  try { await task(); } finally { db.write = write; }
  return writes;
}

test("a stop at a blocker and a person's command, in any order: both stand, and no merge leg is left over or missing", async () => {
  const commands = ["stop", "merge", "urgent", "stop, then review and merge", "yes"];
  for (const text of commands) for (const n of [0, 1]) {
    const w = await stopping();
    const label = `${text} at ${n}`;
    const said: string[] = [];
    const act = async () => { await pause(); for (const t of text.split(", then ")) said.push((await command(w, t)).outcome); };
    const writes = await during(w, n, () => advanceWorkflows(w.db), act);
    assert.equal(writes, 1, label);
    if (n >= writes) await act();
    await pause();
    await advanceWorkflows(w.db);
    const history = await workflowHistory(w.db, "app", 1), last = history.at(-1)!;
    // Before the stop a yes or a second approval answers nothing; after it they go on.
    const answers = text === "yes" || text === "merge";
    assert.ok(said.every((o) => (o === "run") !== (answers && n === 0)), label);
    assert.deepEqual(history.map((x) => x.state), {
      stop: ["stopped"], "stop, then review and merge": ["stopped", "running"], urgent: ["blocked"], merge: [n === 0 ? "blocked" : "running"], yes: [n === 0 ? "blocked" : "running"],
    }[text], label);
    if (text === "urgent") assert.equal(last.weight, 10, label);
    assert.equal(await activeLegs(w), last.state === "running" ? 1 : 0, label);
    // The leg ended by the command, or with the stop it belongs to.
    assert.equal((await legs(w))[0]!.reason_code, n === 0 && text.startsWith("stop") ? "person" : "blocked", label);
    assert.ok(last.blocker !== "other", `${label}: the leg's own end is not a blocker`);
    w.close();
  }
});

test("a pass that stops the item between the writes of a person's command loses neither", async () => {
  for (const text of ["urgent", "stop", "stop, then review and merge"]) for (let n = 0, writes = 1; n < writes; n++) {
    const w = await stopping(), label = `${text} at ${n}`;
    writes = await during(w, n, async () => { for (const t of text.split(", then ")) await run(w, t); }, async () => { await advanceWorkflows(w.db); await pause(); });
    await pause();
    await advanceWorkflows(w.db);
    const history = await workflowHistory(w.db, "app", 1), last = history.at(-1)!;
    assert.deepEqual(history.map((x) => x.state), { urgent: ["blocked"], stop: ["stopped"], "stop, then review and merge": ["stopped", "running"] }[text], label);
    if (text === "urgent") assert.deepEqual([last.weight, last.blocker], [10, "failed-twice"], label);
    assert.equal(await activeLegs(w), last.state === "running" ? 1 : 0, label);
    w.close();
  }
});

test("a write of a release that raises no version is noticed, and so is one within the same millisecond", async () => {
  const w = await repo();
  const { db } = w;
  await w.pr(1, { label: "feature" });
  await run(w, "review");
  const was = (await liveWorkflow(db, "app", 1))!;
  const move = async () => (await moveWorkflows(db, [{ id: was.id, patch: { weight: 2 }, at: "2030-01-01T00:00:00.000Z", was }])).size;
  await db.run(db.k.updateTable("main.item_workflows").set({ updated_at: "2029-01-01T00:00:00.000Z" }));
  assert.equal(await move(), 0);
  await db.run(db.k.updateTable("main.item_workflows").set({ updated_at: was.updatedAt }));
  await saveWorkflows(db, [{ id: was.id, patch: { step: "review" }, at: was.updatedAt }]);
  assert.equal(await move(), 0);
  const now = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([now.version > was.version, now.updatedAt, now.weight], [true, was.updatedAt, 5]);
  assert.equal((await moveWorkflows(db, [{ id: was.id, patch: { weight: 2 }, at: was.updatedAt, was: now }])).size, 1);
});

test("a blocker found while an integration batch holds the PR leaves the batch and the leg alone, and stops the item once the batch failed", async () => {
  const w = await stopping();
  const { db } = w, at = new Date().toISOString();
  await db.run(db.k.updateTable("main.preapprovals").set({ state: "queued", head: "sha1" }));
  const id = (await db.get(db.k.insertInto("merge_batches").values({ repo: "app", branch: "b", base_sha: "b", commit_sha: "c", state: "open", pr_number: 900, created_at: at, updated_at: at }).returning("id")))!.id;
  await db.run(db.k.insertInto("merge_batch_prs").values({ batch_id: id, repo: "app", number: 1, head_oid: "sha1", position: 1 }));
  await advanceWorkflows(db);
  assert.deepEqual([(await liveWorkflow(db, "app", 1))!.state, (await legs(w)).map((l) => l.state)], ["running", ["queued"]]);
  assert.equal((await eventsOf(db, "app", 1)).filter((e) => e.kind === "blocked").length, 0);

  await db.run(db.k.updateTable("merge_batches").set({ state: "failed" }));
  await advanceWorkflows(db);
  assert.deepEqual([(await liveWorkflow(db, "app", 1))!.state, (await legs(w)).map((l) => [l.state, l.reason_code])], ["blocked", [["cancelled", "blocked"]]]);
});

/** Issue 7 started with Implement, its attempt's PR 8 open at our commit sha8; `approved`: its merge too. */
async function implementation(approved: boolean): Promise<World> {
  const w = await (await repo()).issue(7);
  const { db } = w;
  await setFeature(db, "implement", true, MAINT, "app");
  await run(w, "implement", 7);
  if (approved) await run(w, "merge", 7);
  const it = (await db.get(db.k.selectFrom("items").select(["title", "body"]).where("number", "=", 7)))!;
  await startAttempt(db, { repo: "app", number: 7, queuedBy: MAINT, textHash: textHash(it.title ?? "", it.body ?? "") });
  await w.pr(8, { author: "craft-bot" });
  await addOwnCommits(db, [{ repo: "app", sha: "sha8", action: "implement-push" }]);
  await writeStep(db, (await currentAttempt(db, "app", 7))!.impl, { to: "pr-opened", patch: { branch: "fix-8", prNumber: 8, prUrl: "https://example.invalid/8" } });
  return w;
}

test("a stuck revision of an approved implementation stops the merge leg of its pull request", async () => {
  const w = await implementation(true);
  await advanceWorkflows(w.db);
  assert.equal(await activeLegs(w, 8), 1);
  await markStuck(w.db, (await currentAttempt(w.db, "app", 7))!.impl, "blocked", null);
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.blocker, await activeLegs(w, 8)], ["blocked", "failed-twice", 0]);
});

test("an issue accepts the head its merge leg starts at and the one a person answered at, not one only shown to them", async () => {
  const w = await implementation(true);
  const { db } = w;
  const row = async () => (await liveWorkflow(db, "app", 7))!;
  /** The gate's answer once the leg ended: it has the row alone. */
  const gate = async (head: string) => isAccepted(workflowGate(await row())!.accepted ?? [], [], head);
  assert.equal((await row()).acceptedHead, null);
  await advanceWorkflows(db);
  assert.equal((await row()).acceptedHead, "sha8");

  // Our own push moves it, someone else's is shown and not accepted.
  await db.run(db.k.insertInto("main.push_outcomes").values({ at: new Date().toISOString(), stage: "fixup", action: "conflict-push", repo: "app", number: 8, from_oid: "sha8", to_oid: "ours", before_res: "unknown" }));
  await w.synced(8, "ours");
  await advanceWorkflows(db);
  assert.equal((await row()).acceptedHead, "ours");
  await w.synced(8, "theirs");
  await advanceWorkflows(db);
  const asked = await row();
  assert.deepEqual([asked.state, asked.blocker, asked.baseHead, asked.acceptedHead], ["blocked", "author-commits", "theirs", "ours"]);
  assert.deepEqual([await gate("theirs"), await gate("ours")], [false, true]);

  await pause();
  await run(w, "yes", 7);
  assert.equal((await row()).acceptedHead, "theirs");
  assert.equal(await gate("theirs"), true);
  await advanceWorkflows(db);
  assert.deepEqual([(await row()).state, await activeLegs(w, 8)], ["running", 1]);
});

test("the accepted head of a PR follows its start, our pushes and an answer; a row without one reads its base head and its legs", async () => {
  const w = await repo();
  const { db } = w;
  await w.pr(1, { label: "feature" });
  await run(w, "merge");
  const heads = async () => { const x = (await liveWorkflow(db, "app", 1))!; return [x.baseHead, x.acceptedHead]; };
  assert.deepEqual(await heads(), ["sha1", "sha1"]);
  await w.synced(1, "theirs");
  await w.outOfScope(1, "theirs");
  await advanceWorkflows(db);
  assert.deepEqual(await heads(), ["sha1", "sha1"]);
  await pause();
  await run(w, "yes");
  assert.deepEqual(await heads(), ["theirs", "theirs"]);

  const leg = { from_head: "a", head: "b" };
  assert.deepEqual(acceptedHeads({ kind: "issue", baseHead: null, acceptedHead: null }, [leg]), ["a", "b"]);
  assert.deepEqual(acceptedHeads({ kind: "issue", baseHead: "shown", acceptedHead: "c" }, [leg]), ["c"]);
  // A release before the accepted head wrote the base head alone.
  assert.deepEqual(acceptedHeads({ kind: "pr", baseHead: "new", acceptedHead: "old" }, []), ["new"]);
});
