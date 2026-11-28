// The command core of the maintainer workflow (src/workflow/apply.ts): who may act, lists of items, and stop.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { listCommand } from "../src/dash/api/commands.ts";
import type { Req } from "../src/dash/types.ts";
import { loadQueue } from "../src/data/runners/index.ts";
import { enqueueCall } from "../src/remote/calls.ts";
import { callLevel } from "../src/remote/level.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { insertWorkflow, liveWorkflow } from "../src/workflow/store.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MAINT = "mira";

/** The repo "app" on the maintainer workflow, with the app identity and a maintainer. */
async function newRepo(): Promise<World> {
  const w = current = await (await world()).repo();
  const db = w.db;
  await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("main.access").values({ login: MAINT, role: "maintainer" }));
  return w;
}

const actor = (login: string | null, write = true): Actor => ({ login, canWrite: async () => write });
const count = async (w: World, table: "main.item_workflows" | "main.workflow_events") =>
  Number((await w.db.get(w.db.k.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("n"))))!.n);

/** A fix-up's model call for the item, queued for a Task Runner. */
const queueCall = async (w: World, number: number) => await enqueueCall(w.db, {
  promptId: "fixup.patch", promptVersion: "1", tier: "top", effort: "high", askedModel: "opus", items: [{ repo: "app", number }], level: 2, maxAttempts: 1, bundle: {
    promptId: "fixup.patch", promptVersion: "1", tier: "top", effort: "high", timeoutSeconds: 60, maxTurns: null, stdin: `fix ${number}`, system: null, mounts: [], mcpServers: [], keepSession: false, hints: { claude: { args: [] } },
  },
});

test("a command from someone without an AutoCraft login or without write access runs nothing", async () => {
  const w = await newRepo();
  await w.pr(1);
  const review = { parsed: parse("review"), items: [{ repo: "app", number: 1 }] };
  for (const who of [actor(null), actor("stranger"), actor(MAINT, false)]) {
    const r = await runCommand(w.db, who, "dashboard", review);
    assert.equal(r.items[0]!.outcome, "refused");
  }
  assert.deepEqual([await count(w, "main.item_workflows"), await count(w, "main.workflow_events")], [0, 0]);
  const ok = await runCommand(w.db, actor(MAINT), "dashboard", review);
  assert.equal(ok.items[0]!.outcome, "run", "the same command from a maintainer with write access runs");
});

test("a list with one bad item runs the others and names the one that did not run", async () => {
  const w = await newRepo();
  await w.pr(1);
  await w.pr(2);
  const r = await runCommand(w.db, actor(MAINT), "dashboard", { parsed: parse("review, urgent: app#1 #99 #2"), items: [] });
  assert.deepEqual(r.items.map((o) => [o.number, o.outcome]), [[1, "run"], [99, "refused"], [2, "run"]]);
  for (const n of [1, 2]) {
    const wf = (await liveWorkflow(w.db, "app", n))!;
    assert.deepEqual([wf.entry, wf.startedBy, wf.weight > 5], ["review", MAINT, true]);
  }
  assert.equal(await count(w, "main.item_workflows"), 2);
  assert.match(r.lines.at(-1)!, /#99/);
  assert.doesNotMatch(r.lines.at(-1)!, /#1\b|#2\b/);
});

test("a command sent from the dashboard to a list of items checks each item's repo on its own", async () => {
  const w = await newRepo();
  await w.pr(1);
  const db = w.db;
  await db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline, workflow) VALUES ('lib', ?, ?, 1, 'new')").run(OPERATOR, T0);
  await db.prepare("INSERT INTO repos (name, visibility, default_branch) VALUES ('lib', 'public', 'main')").run();
  await db.prepare("INSERT INTO items (repo, number, kind, state, title, author, head_oid, created_at, updated_at) VALUES ('lib', 2, 'pr', 'OPEN', 'PR 2', 'regular', 'sha2', ?, ?)").run(T0, T0);
  // The maintainer may write to app only.
  const req: Req = {
    method: "POST", path: "/api/commands", params: {}, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "",
    json: { text: "review and merge", items: ["app#1", "lib#2"] },
    user: { login: MAINT, role: "maintainer", canWrite: async (repo: string) => repo === "app", canRead: async () => true },
  };
  const r = await listCommand(db, req);
  assert.deepEqual(r.items.map((o) => [`${o.repo}#${o.number}`, o.outcome]), [["app#1", "run"], ["lib#2", "refused"]]);
  assert.match(r.items[1]!.line, /write access/);
  assert.ok(await liveWorkflow(db, "app", 1));
  assert.equal(await liveWorkflow(db, "lib", 2), null, "nothing started on the item the maintainer may not command");
});

test("stop ends the pre-approved merge, the queued fix-up and the item's queued model calls", async () => {
  const w = await newRepo();
  const db = w.db;
  await w.pr(1);
  await w.pr(2);
  const wfId = await insertWorkflow(db, { repo: "app", number: 1, kind: "pr", entry: "fixup", state: "running", startedBy: MAINT, startedAt: T0, startedVia: "dashboard", approvedBy: MAINT, approvedAt: T0, approvedVia: "dashboard" });
  const fix = (await db.get(db.k.insertInto("main.operator_fixups").values({ repo: "app", number: 1, from_head: "sha1", instructions: "fix it", by: MAINT, at: T0 }).returning("id")))!.id;
  await db.run(db.k.insertInto("main.preapprovals").values({ repo: "app", number: 1, by: MAINT, at: T0, instructions: "fix it", state: "fixup", from_head: "sha1", updated_at: T0, fix_id: fix, workflow_id: wfId }));
  await db.run(db.k.updateTable("main.operator_fixups").set({ preapproval_id: 1 }).where("id", "=", fix));
  const plain = (await db.get(db.k.insertInto("main.operator_fixups").values({ repo: "app", number: 1, from_head: "sha1", instructions: "rename", by: OPERATOR, at: T0 }).returning("id")))!.id;
  for (const number of [1, 2]) await queueCall(w, number);

  const r = await runCommand(db, actor(MAINT), "dashboard", { parsed: parse("stop"), items: [{ repo: "app", number: 1 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  assert.equal((await db.get(db.k.selectFrom("main.preapprovals").select("state").where("number", "=", 1)))!.state, "cancelled");
  const fixups = await db.all(db.k.selectFrom("main.operator_fixups").select(["id", "state"]).orderBy("id"));
  assert.deepEqual(fixups.map((f) => f.state), ["ended", "ended"], `fix-ups ${fix} and ${plain} end`);
  const calls = await db.all(db.k.selectFrom("main.remote_calls").select("state").orderBy("id"));
  assert.deepEqual(calls.map((c) => c.state), ["failed", "queued"], "only the stopped item's call is withdrawn");
  assert.equal(await liveWorkflow(db, "app", 1), null);
  const row = (await db.get(db.k.selectFrom("main.item_workflows").select(["state", "stopped_by", "approved_by"]).where("id", "=", wfId)))!;
  assert.deepEqual([row.state, row.stopped_by, row.approved_by], ["stopped", MAINT, MAINT], "who approved stays recorded");
});

test("a weight word re-orders the queued calls of a started item", async () => {
  const w = await newRepo();
  const db = w.db;
  await w.pr(1);
  await w.pr(2);
  await insertWorkflow(db, { repo: "app", number: 1, kind: "pr", entry: "review", state: "running", startedBy: MAINT, startedAt: T0, startedVia: "dashboard" });
  for (const number of [1, 2]) await queueCall(w, number);
  const level = async (n: number) => (await loadQueue(db, Date.now())).calls.find((c) => c.refs.some((r) => r.number === n))!.level;
  const plain = await level(2);
  const set = async (text: string) => {
    const r = await runCommand(db, actor(MAINT), "dashboard", { parsed: parse(text), items: [{ repo: "app", number: 1 }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
    return await level(1);
  };
  const urgent = await set("urgent");
  const low = await set("low");
  assert.ok(urgent > low && low > plain, `urgent ${urgent}, low ${low}, not started ${plain}`);
  assert.equal(await level(2), plain, "another item's call keeps its level");
  assert.equal(await callLevel(db, { repo: "app", number: 1 }), low, "the item's next call is queued at the same level");
});

test("stop on an issue ends the merge leg of its implementation PR", async () => {
  const w = await newRepo();
  const db = w.db;
  await w.issue(5);
  await w.pr(9);
  const wfId = await insertWorkflow(db, { repo: "app", number: 5, kind: "issue", entry: "implement", state: "running", startedBy: MAINT, startedAt: T0, startedVia: "dashboard", approvedBy: MAINT, approvedAt: T0, approvedVia: "dashboard" });
  await db.run(db.k.insertInto("main.preapprovals").values({ repo: "app", number: 9, by: MAINT, at: T0, instructions: "", state: "review", from_head: "sha9", head: "sha9", updated_at: T0, fix_id: null, workflow_id: wfId }));
  const r = await runCommand(db, actor(MAINT), "dashboard", { parsed: parse("stop"), items: [{ repo: "app", number: 5 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  assert.equal((await db.get(db.k.selectFrom("main.preapprovals").select("state").where("number", "=", 9)))!.state, "cancelled");
});

test("drop on a close recommendation is ambiguous, so nothing closes", async () => {
  const w = await newRepo();
  const db = w.db;
  await w.pr(1);
  await insertWorkflow(db, { repo: "app", number: 1, kind: "pr", entry: "review", state: "recommending", startedBy: MAINT, startedAt: T0, startedVia: "dashboard",
    plan: [{ n: 1, title: "typo", source: "review", state: "planned" }], rec: { text: "Close it.", parts: { fix: [], drop: [] }, merges: false, close: true } });
  const r = await runCommand(db, actor(MAINT), "dashboard", { parsed: parse("drop 1"), items: [{ repo: "app", number: 1 }] });
  assert.equal(r.items[0]!.outcome, "ambiguous", r.lines.join("\n"));
});
