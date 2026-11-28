// "Run on my Task Runner" picks and Manual only: a pick goes to the picker's runners first and no one else's while it counts;
// it lapses with its time or its picker's runners and does not count while its picker cannot take it; a Manual only user's
// runners take only their picks and are no room; the queue view hides picker logins and errors from viewers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import * as modelQueue from "../src/dash/api/model-queue.ts";
import { handleMcp } from "../src/dash/mcp/index.ts";
import * as userSettings from "../src/dash/api/user-settings.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import type { Req, Role } from "../src/dash/types.ts";
import { claimCall, enqueueCall, leasedBy, leaseTurnover, withdrawCall, type Caller } from "../src/remote/calls.ts";
import { dropQueueCache } from "../src/data/runners/calls-shared.ts";
import { defaultSemanticDeps } from "../src/reference-lint.ts";
import { parseStatus, STATUS_FRESH_MS, storeStatus } from "../src/remote/helpers.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import { setUserMaxCalls } from "../src/remote/max-calls.ts";
import { pickCall, setPickMinutes, unpickCall } from "../src/remote/picks.ts";
import { PROTOCOL_VERSION, type Claim, type Tier } from "../src/remote/protocol.ts";
import { whyWaiting, type ReadyRunner } from "../src/remote/queue-view.ts";
import { remoteRoom, roomOf, roomState } from "../src/remote/room.ts";
import { setManualOnly } from "../src/remote/manual-only.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { takerTest } from "../src/remote/takers.ts";
import { insertWorkflow, updateWorkflow } from "../src/workflow/store.ts";
import { releaseItemRunner, takeItemRunner } from "../src/data/workflow/index.ts";
import { STARTED_HOLD_MS } from "../src/remote/started.ts";
import { setMainFixApproval } from "../src/mainfix/approval.ts";
import { allocation, poolRoom, repoBatches } from "../src/agents/call.ts";
import { pool } from "../src/classify/run.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { excluded, like } from "../src/db/kx.ts";

/** A started item: the workflow row a maintainer's start command writes. */
const startedItem = async (db: Db, by: string, repo: string, number: number): Promise<void> => {
  await insertWorkflow(db, { repo, number, kind: "issue", entry: "review", state: "running", startedBy: by, startedAt: "2026-01-01T00:00:00Z", startedVia: "dashboard" });
  dropQueueCache(db);
};
/** Ends every started item. */
const endStarted = async (db: Db): Promise<void> => {
  await db.run(db.k.updateTable("item_workflows").set({ state: "done" }));
  dropQueueCache(db);
};

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "remote-picks-"));

describe("picks and Manual only", async () => {
  const db = await connectDb(join(dir, "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "photocraft" }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values({ name: "photocraft", visibility: "public" }).onConflict((oc) => oc.column("name").doUpdateSet(excluded(["visibility"]))));
  const callers: Record<string, Caller> = {};
  for (const [login, role] of [["alice", "maintainer"], ["bob", "maintainer"], ["olga", "operator"], ["eve", "viewer"]] as const) {
    await db.run(db.k.insertInto("access").values({ login, role }));
    if (role !== "viewer") callers[login] = { tokenId: (await createToken(db, login, "runner", { kind: "runner" })).row.id, login, role };
  }
  /** The users' runners reported their last status too long ago to count. */
  const unfresh = async (...logins: string[]) => {
    await db.run(db.k.updateTable("remote_helpers").set({ reported_at: Date.now() - STATUS_FRESH_MS - 1000 }).where("login", "in", logins));
    dropQueueCache(db);
  };
  /** The user's runner reports ready now: two slots and the fast lane. */
  const ready = async (login: string) => await storeStatus(db, callers[login]!.tokenId, login, parseStatus({ slots: 3, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
  for (const login of ["alice", "bob", "olga"]) await ready(login);
  let claims = 0;
  const claim = (extra: Partial<Claim> = {}): Claim => ({ requestId: `picks-claim-${String(++claims).padStart(4, "0")}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus", small: "haiku" }, ...extra });
  const yes = async () => true;
  const leased = async (login: string, extra: Partial<Claim> = {}, canWrite = yes) => (await claimCall(db, callers[login]!, claim(extra), canWrite)).lease?.id ?? null;
  const user = (login: string, role: Role = "maintainer") => ({ login, role, canWrite: yes, canRead: yes });
  const req = (login: string, role: Role, extra: Partial<Req> = {}) => ({ user: user(login, role), params: {}, query: new URLSearchParams(), ...extra }) as unknown as Req;
  const q = async (opts: { tier?: Tier; ageMs?: number; items?: { repo: string; number: number }[]; promptId?: string; forLogin?: string; boundSlot?: boolean; parentId?: number } = {}) => {
    const tier = opts.tier ?? "top", promptId = opts.promptId ?? "review.opus";
    const id = await enqueueCall(db, { promptId, promptVersion: "1", tier, effort: "medium", askedModel: tier === "top" ? "opus" : "haiku", items: opts.items ?? [{ repo: "photocraft", number: 2 }], level: 0, maxAttempts: 2,
      ...(opts.forLogin && { forLogin: opts.forLogin }), ...(opts.boundSlot && { boundSlot: true }), ...(opts.parentId !== undefined && { parentId: opts.parentId }),
      bundle: { promptId, promptVersion: "1", tier, effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: true, hints: {} } });
    if (opts.ageMs) await db.run(db.k.updateTable("remote_calls").set((eb) => ({ since: eb("since", "-", opts.ageMs!) })).where("id", "=", id));
    return id;
  };
  const clear = async () => await db.run(db.k.updateTable("remote_calls").set({ state: "failed" }).where("state", "in", ["queued", "leased"]));
  const pickedBy = async (id: number) => (await db.get(db.k.selectFrom("remote_calls").select("picked_by").where("id", "=", id)))!.picked_by;

  test("the picker's runners take a pick first; others pass it over; the fast lane takes only picks that fit it", async () => {
    const older = await q({ ageMs: 10 * 60_000 });
    const newer = await q();
    await pickCall(db, user("bob"), newer);
    assert.equal(await leased("bob"), newer, "bob's pick before the older call");
    assert.equal(await pickedBy(newer), null, "the lease ends the pick");
    const third = await q();
    await pickCall(db, user("bob"), third);
    assert.equal(await leased("alice"), older, "alice takes the unpicked call");
    assert.equal(await leased("alice"), null, "and not bob's pick");
    assert.equal(await leased("bob", { fastLane: true }), null, "a top-tier review does not fit the fast lane");
    assert.equal(await leased("bob"), third);
    assert.ok(await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "=", "remote-pick").where("login", "=", "bob").where("target", "=", "photocraft#2")));
    await clear();
  });

  test("a call bound to a maintainer goes to their own runners alone, on their own item too; its follow-up keeps the binding", async () => {
    await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 30, kind: "pr", state: "OPEN", title: "x", author: "alice", created_at: "2026-01-01T00:00:00Z" }).onConflict((oc) => oc.doNothing()));
    const own = await q({ promptId: "conversation.turn", items: [{ repo: "photocraft", number: 30 }], forLogin: "Alice" });
    assert.equal(await leased("olga"), null, "not the operator's runner");
    assert.equal(await leased("bob"), null, "not another maintainer's, though bob's runner now asks for work");
    await assert.rejects(async () => await pickCall(db, user("bob"), own), /Task Runner of the person who asked/);
    assert.equal(await leased("alice"), own, "alice's runner takes it although she wrote the item");
    // An older Task Runner (no withOwnLane) took it in a slot, where it counts toward Max calls at once.
    await setUserMaxCalls(db, "alice", 1);
    const other = await q();
    assert.equal(await leased("alice"), null, "her slot's bound lease counts toward her limit");
    const bound = () => q({ promptId: "conversation.turn", items: [{ repo: "photocraft", number: 30 }], forLogin: "alice" });
    const second = await bound();
    assert.equal(await leased("alice", { ownLane: true }), second, "the own lane takes a bound call at the limit");
    await setUserMaxCalls(db, "alice", 2);
    assert.equal(await leased("alice", { withOwnLane: true }), other, "its lease counted for nothing: room for one more");
    // A Task Runner with an own lane leaves bound calls to it.
    await setUserMaxCalls(db, "alice", null);
    const third = await bound();
    assert.equal(await leased("alice", { withOwnLane: true }), null, "not in a slot of a Task Runner with an own lane");
    assert.equal(await leased("alice", { ownLane: true }), third);
    // What the maintainers' lane watches changes with a lease turnover that keeps the count.
    const before = await leaseTurnover(db, "alice");
    await db.run(db.k.updateTable("remote_calls").set({ state: "done" }).where("id", "=", third));
    await new Promise((r) => setTimeout(r, 2));
    const fourth = await q();
    assert.equal(await leased("alice", { withOwnLane: true }), fourth);
    assert.notEqual(await leaseTurnover(db, "alice"), before);
    await setUserMaxCalls(db, "alice", null);
    const next = await q({ promptId: "conversation.turn", items: [{ repo: "photocraft", number: 30 }], parentId: own });
    assert.equal((await db.get(db.k.selectFrom("remote_calls").select("for_login").where("id", "=", next)))!.for_login?.toLowerCase(), "alice");
    // A maintainer's reference check (lint.reference.haiku) is bound to them as well.
    const was = allocation.pollMs;
    allocation.pollMs = 10;
    try {
      const check = defaultSemanticDeps(db, "photocraft#30", { forLogin: "alice" }).haiku("See the manual.");
      let row: { id: number; for_login: string | null } | undefined;
      for (let i = 0; i < 200 && !row; i++) {
        row = await db.get(db.k.selectFrom("remote_calls").select(["id", "for_login"]).where("prompt_id", "=", "lint.reference.haiku").where("state", "=", "queued"));
        if (!row) await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(row?.for_login, "alice");
      // Each attempt queues the check again; withdrawn, it counts as no answer.
      let done = false;
      void check.finally(() => { done = true; });
      while (!done) {
        for (const r of await db.all(db.k.selectFrom("remote_calls").select("id").where("prompt_id", "=", "lint.reference.haiku").where("state", "=", "queued"))) await withdrawCall(db, r.id, "test");
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(await check, null);
    } finally {
      allocation.pollMs = was;
    }
    await clear();
  });

  test("a bound call that runs in a slot skips the own lane, takes one of its user's slots and counts toward their limit", async () => {
    const id = await q({ forLogin: "alice", boundSlot: true });
    assert.equal(await leased("alice", { ownLane: true }), null, "not in alice's own lane");
    for (const extra of [{}, { ownLane: true }, { withOwnLane: true }]) assert.equal(await leased("bob", extra), null, "never on another user's runner");
    const before = await leasedBy(db, "alice");
    assert.equal(await leased("alice", { withOwnLane: true }), id, "in a slot of alice's runner that has an own lane");
    assert.ok(await leasedBy(db, "alice") > before, "the lease counts toward her calls at once");
    await clear();
  });

  test("a pick lapses with its time or its picker's runners; with no time limit it lasts", async () => {
    await setPickMinutes(db, 0, "test");
    const a = await q();
    await pickCall(db, user("bob"), a);
    assert.equal((await db.get(db.k.selectFrom("remote_calls").select("pick_until").where("id", "=", a)))!.pick_until, null);
    assert.equal(await leased("alice"), null, "no time limit: still bob's");
    await db.run(db.k.updateTable("remote_helpers").set({ reported_at: Date.now() - STATUS_FRESH_MS - 1000 }).where("login", "=", "bob"));
    assert.equal(await leased("alice"), a, "none of bob's runners is fresh: the pick no longer counts");
    await ready("bob");
    await setPickMinutes(db, 15, "test");
    const b = await q();
    await pickCall(db, user("bob"), b);
    assert.equal(await leased("alice"), null);
    await db.run(db.k.updateTable("remote_calls").set({ pick_until: Date.now() - 1 }).where("id", "=", b));
    dropQueueCache(db);
    assert.equal(await leased("alice"), b, "the pick's time is up");
    await clear();
  });

  test("a pick does not count while its picker is cooling off or at their Max calls at once", async () => {
    const a = await q();
    await pickCall(db, user("bob"), a);
    await db.run(db.k.insertInto("remote_cooloffs").values({ login: "Bob", until: Date.now() + 60_000, reason: "testing cool-off" }));
    assert.equal(await leased("alice"), a, "bob is cooling off: alice's runner takes his pick");
    await db.run(db.k.deleteFrom("remote_cooloffs").where("login", "=", "bob"));
    await setUserMaxCalls(db, "bob", 1);
    const b = await q();
    await pickCall(db, user("bob"), b);
    assert.equal(await leased("alice"), null, "bob may still take it");
    const held = await q({ ageMs: 60_000 });
    await db.run(db.k.updateTable("remote_calls").set({ state: "leased", user_login: "bob", leased_at: Date.now(), heartbeat_at: Date.now() }).where("id", "=", held));
    dropQueueCache(db);
    assert.equal(await leased("alice"), b, "bob runs his Max calls at once: alice's runner takes his pick");
    await setUserMaxCalls(db, "bob", null);
    await clear();
  });

  test("a pick the picker may no longer take or released ends at their claim; two users picking at once: one wins", async () => {
    const a = await q();
    await pickCall(db, user("bob"), a);
    assert.equal(await leased("bob", {}, async () => false), null, "bob lost write permission");
    assert.equal(await pickedBy(a), null, "and with it the pick");
    await pickCall(db, user("bob"), a);
    await db.run(db.k.updateTable("remote_calls").set({ released_by: "bob", released_at: Date.now() }).where("id", "=", a));
    dropQueueCache(db);
    assert.equal(await leased("bob"), null);
    assert.equal(await pickedBy(a), null, "a call bob's runner released loses bob's pick");
    const results = await Promise.allSettled([pickCall(db, user("bob"), a), pickCall(db, user("alice"), a)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const winner = (await pickedBy(a))!;
    const loser = winner === "bob" ? "alice" : "bob";
    await assert.rejects(async () => await unpickCall(db, user(loser), a), /only operators/);
    await unpickCall(db, user("olga", "operator"), a);
    assert.equal(await pickedBy(a), null);
    assert.ok(await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "=", "remote-unpick").where("login", "=", "olga").where((eb) => like(db, "details", eb.val(`%"picker":"${winner}"%`)))));
    await clear();
  });

  test("a Manual only user's runners take only their picks and are no room", async () => {
    const a = await q();
    // Both runners asked for work a moment ago (active), so both are room.
    for (const login of ["alice", "bob", "olga"]) await db.run(db.k.updateTable("remote_helpers").set({ idle_claim_at: Date.now() }).where("login", "=", login));
    dropQueueCache(db);
    const room = await remoteRoom(db, 0);
    await userSettings.setSettings(db, req("alice", "maintainer", { json: { manualOnly: true } }));
    assert.equal((await userSettings.settings(db, req("alice", "maintainer"))).manualOnly, true);
    assert.equal(await remoteRoom(db, 0), room - 2, "alice's two slots are no room");
    assert.equal(await leased("alice"), null, "an unpicked call");
    await pickCall(db, user("alice"), a);
    assert.equal(await leased("alice"), a, "her own pick");
    await userSettings.setSettings(db, req("alice", "maintainer", { json: { manualOnly: false } }));
    assert.ok(await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "=", "manual-only").where("login", "=", "alice")));
    await clear();
  });

  test("the queue view: viewers see no picker, error or repo-less call; maintainers see them and what they may pick", async () => {
    const a = await q();
    const b = await q();
    const loose = await q({ items: [] });
    await pickCall(db, user("bob"), a);
    await db.run(db.k.updateTable("remote_calls").set({ error: "lease expired" }).where("id", "=", b));
    const viewer = await modelQueue.get(db, req("eve", "viewer"));
    assert.deepEqual(viewer.calls.map((c) => c.id), [a, b]);
    assert.deepEqual(viewer.calls[0]!.picked, {});
    assert.equal(viewer.calls[0]!.why.text, "Picked by a user");
    assert.equal(viewer.calls[1]!.lastError, undefined);
    assert.equal(viewer.runners.manualLogins, undefined);
    assert.deepEqual(viewer.me, { canPick: false, manualOnly: false, picks: 0, pickMax: 0 });
    const alice = await modelQueue.get(db, req("alice", "maintainer"));
    assert.deepEqual(alice.calls.map((c) => [c.id, c.picked, c.pickable]), [[a, { login: "bob" }, false], [b, null, true], [loose, null, false]]);
    assert.equal(alice.calls[1]!.lastError, "lease expired");
    assert.deepEqual(alice.me, { canPick: true, manualOnly: false, picks: 0, pickMax: 2 });
    const bob = await modelQueue.unpick(db, req("bob", "maintainer", { params: { id: String(a) } }));
    assert.equal(bob.calls[0]!.picked, null);
    await clear();
  });

  test("the MCP model call tools apply the queue page's rules: viewers list without pickers and cannot pick; a pick is audited via mcp", async () => {
    const a = await q();
    await pickCall(db, user("bob"), a);
    const b = await q();
    const env = (login: string, role: Role) => ({ db, user: () => user(login, role) as any, baseUrl: null, canAnswer: false, expensive: () => 0 });
    const rpc = async (login: string, role: Role, method: string, params?: Record<string, unknown>) => (await handleMcp(env(login, role), { jsonrpc: "2.0", id: 1, method, ...(params && { params }) }))!.result as any;
    const names = async (login: string, role: Role) => (await rpc(login, role, "tools/list")).tools.map((t: { name: string }) => t.name).filter((n: string) => n.includes("model_call"));
    assert.deepEqual(await names("eve", "viewer"), ["list_model_calls"]);
    assert.deepEqual(await names("alice", "maintainer"), ["list_model_calls", "pick_model_call", "unpick_model_call"]);
    const listed = (await rpc("eve", "viewer", "tools/call", { name: "list_model_calls", arguments: {} })).content[0].text as string;
    assert.match(listed, /"picked": "a user"/);
    assert.doesNotMatch(listed, /bob/);
    const refused = await rpc("eve", "viewer", "tools/call", { name: "pick_model_call", arguments: { id: String(b) } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /only maintainers and operators/);
    const taken = await rpc("alice", "maintainer", "tools/call", { name: "pick_model_call", arguments: { id: String(a) } });
    assert.equal(taken.isError, true);
    assert.match(taken.content[0].text, /another user picked it/);
    assert.equal((await rpc("alice", "maintainer", "tools/call", { name: "pick_model_call", arguments: { id: String(b) } })).isError, undefined);
    assert.equal(await pickedBy(b), "alice");
    assert.ok(await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "=", "remote-pick").where("login", "=", "alice").where((eb) => like(db, "details", eb.val('%"via":"mcp"%')))));
    await rpc("alice", "maintainer", "tools/call", { name: "unpick_model_call", arguments: { id: String(b) } });
    assert.equal(await pickedBy(b), null);
    await clear();
  });

  test("My tasks: unticked tasks are left in the queue for others; a pick and every task again still run", async () => {
    const all = (await userSettings.settings(db, req("alice", "maintainer"))).taskChoices.map((t) => t.id);
    assert.deepEqual((await userSettings.settings(db, req("alice", "maintainer"))).tasks, all, "every task is ticked by default");
    const put = (tasks: unknown) => userSettings.setSettings(db, req("alice", "maintainer", { json: { tasks } }));
    await assert.rejects(put(["review", "nope"]), /unknown task: nope/);
    assert.deepEqual((await put(all.filter((t) => t !== "review"))).tasks, all.filter((t) => t !== "review"));
    const step = async (id: number, s: string) => await db.run(db.k.updateTable("remote_calls").set({ step: s }).where("id", "=", id));
    const review = await q({ ageMs: 60_000 }), fix = await q();
    await step(review, "opus-review");
    await step(fix, "fixissue");
    dropQueueCache(db);
    assert.equal(await leased("alice"), fix, "the older review is passed over");
    assert.equal(await leased("alice"), null);
    assert.equal(await leased("bob"), review, "another user who takes reviews gets it");
    const picked = await q();
    await step(picked, "opus-review");
    dropQueueCache(db);
    await pickCall(db, user("alice"), picked);
    assert.equal(await leased("alice"), picked, "a call alice picked runs although she unticked its task");
    const later = await q();
    await step(later, "opus-review");
    dropQueueCache(db);
    await put(all);
    assert.equal(await db.get(db.k.selectFrom("user_settings").select((eb) => eb.lit(1).as("one")).where("login", "=", "alice").where("key", "=", "skip_tasks")), undefined, "every task ticked again stores nothing");
    assert.equal(await leased("alice"), later);
    await clear();
  });

  test("My tasks items: started only takes calls on started items; by me only on the user's own; a repo counts only with such an item", async () => {
    for (const n of [10, 11, 12]) await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: n, kind: "pr", state: "OPEN", title: "x", author: "dev", created_at: "2026-01-01T00:00:00Z" }).onConflict((oc) => oc.doNothing()));
    const put = (taskItems: unknown) => userSettings.setSettings(db, req("alice", "maintainer", { json: { taskItems } }));
    assert.equal((await userSettings.settings(db, req("alice", "maintainer"))).taskItems, "all", "every item by default");
    await assert.rejects(put("some"), /taskItems must be one of/);
    await put("started");
    const at = (n: number) => [{ repo: "photocraft", number: n }];
    const takes = () => takerTest(db, Date.now());
    // Only alice's runner is fresh, so the taker rule reads her choice alone.
    await unfresh("bob", "olga");
    assert.equal(await takes()({ prompt_id: "review.opus", repos: ["photocraft"], step: "opus-review" }), false, "no started item on the repo: no taker before the items are known");
    assert.equal(await leased("alice"), null, "an idle claim: alice's runner is active");
    assert.equal(await remoteRoom(db, 0), 0, "no started item at all: no room, even for a question about no repo or task");

    await startedItem(db, "bob", "photocraft", 11);
    await startedItem(db, "alice", "photocraft", 12);
    assert.ok(await remoteRoom(db, 0, Date.now(), undefined, "opus-review") > 0, "room for the task: the started items are on a repo alice takes");
    await setUserRepos(db, "alice", ["deckcraft"]);
    assert.equal(await remoteRoom(db, 0, Date.now(), undefined, "opus-review"), 0, "no room once alice takes only a repo without started items");
    await setUserRepos(db, "alice", []);
    await q({ ageMs: 60_000, items: at(10) });
    const bobs = await q({ items: at(11) }), mixed = await q({ items: [...at(10), ...at(12)] });
    dropQueueCache(db);
    assert.equal(await takes()({ prompt_id: "review.opus", repos: ["photocraft"], step: "opus-review" }), true, "the repo now has started items");
    assert.equal(await takes()({ prompt_id: "review.opus", repos: ["photocraft"], step: "opus-review", refs: at(10) }), false, "but not this item");
    assert.equal(await leased("alice"), bobs, "the older call on an item nobody started is passed over");
    assert.equal(await leased("alice"), mixed, "one started item of a call is enough");
    assert.equal(await leased("alice"), null);
    await clear();

    await put("mine");
    const theirs = await q({ ageMs: 60_000, items: at(11) }), own = await q({ items: at(12) });
    dropQueueCache(db);
    assert.equal(await leased("alice"), own, "only the item alice started");
    for (const login of ["bob", "olga"]) await ready(login);
    assert.equal(await leased("bob"), theirs, "a runner that takes every item gets the rest");
    assert.equal(await leased("alice"), null, "nothing else alice started");

    const r: ReadyRunner = { login: "alice", role: "maintainer", manual: false, tiers: new Set<Tier>(["top"]), free: 1, repos: null, skip: new Set<string>(), items: { refs: new Set(["photocraft#12"]), repos: new Set(["photocraft"]) } };
    const c = { tier: "top" as Tier, promptId: "review.opus", step: "opus-review", repos: ["photocraft"], followUp: false, picked: null };
    assert.equal(whyWaiting({ ...c, refs: at(10) }, [r], 0, () => true).code, "items-off");
    assert.equal(whyWaiting({ ...c, refs: at(12) }, [r], 0, () => true).code, "behind");
    assert.equal(whyWaiting({ ...c, refs: at(10) }, [{ ...r, items: { refs: new Set(), repos: new Set() } }], 0, () => true).code, "items-off", "no started item on the repo is still about items, not repo access");
    await put("all");
    assert.equal(await db.get(db.k.selectFrom("user_settings").select((eb) => eb.lit(1).as("one")).where("login", "=", "alice").where("key", "=", "task_items")), undefined, "every item again stores nothing");
    await endStarted(db);
    await clear();
  });

  test("My tasks items in a pool: a started-only runner gets the started item's unit at once and no unit on other items, even with the other runners busy", async () => {

    const units = [21, 22, 23, 20];
    for (const n of units) await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: n, kind: "issue", state: "OPEN", title: "x", author: "dev", created_at: "2026-01-01T00:00:00Z" }).onConflict((oc) => oc.doNothing()));
    await startedItem(db, "bob", "photocraft", 20);
    await userSettings.setSettings(db, req("alice", "maintainer", { json: { taskItems: "started" } }));
    await unfresh("bob", "olga");
    assert.equal(await leased("alice"), null, "an idle claim: alice's runner is active");
    const refs = (i: number) => [{ repo: "photocraft", number: units[i]! }];
    const started: number[] = [];
    await pool(units.map((_, i) => async () => { started.push(i); }), poolRoom(db, () => ["photocraft"], refs, { promptId: "review.opus" }), { pollMs: 5 });
    assert.deepEqual(started, [3], "only the started item's unit ran, though it came last");
    assert.deepEqual(await repoBatches(db, units, 3, () => "photocraft", (n) => [{ repo: "photocraft", number: n }]), [[21, 22, 23], [20]], "the started item is batched apart");

    // Bob takes every item, and the calls ahead fill his slots: they take none of alice's.
    await ready("bob");
    assert.equal(await leased("bob"), null);
    for (let k = 0; k < 4; k++) await q({ items: refs(0) });
    dropQueueCache(db);
    const room = poolRoom(db, () => ["photocraft"], refs, { promptId: "review.opus" });
    assert.equal(await room.room(0), 0, "no room for another unit: bob is full");
    assert.ok(await room.room(3) > 0, "room for the started unit on alice's runner");
    await userSettings.setSettings(db, req("alice", "maintainer", { json: { taskItems: "all" } }));
    for (const login of ["alice", "bob", "olga"]) await ready(login);
    await endStarted(db);
    await clear();
  });

  test("calls for an item a user started go to their runner first, in a slot under their Max calls at once, and past their cool-off", async () => {
    await db.run(db.k.updateTable("tracked_repos").set({ workflow: "new" }).where("name", "=", "photocraft"));
    const wf = await insertWorkflow(db, { repo: "photocraft", number: 5, kind: "pr", entry: "review", state: "running", startedBy: "alice", startedAt: new Date().toISOString(), startedVia: "github" });
    dropQueueCache(db);
    await setUserMaxCalls(db, "alice", 1);
    const auto = await q({ ageMs: 10 * 60_000 });
    await db.run(db.k.insertInto("remote_cooloffs").values({ login: "alice", until: Date.now() + 60_000, reason: "testing cool-off" }));
    assert.equal(await leased("alice"), null, "cooling off: no automatic call");
    const first = await q({ items: [{ repo: "photocraft", number: 5 }] });
    assert.equal(await leased("alice"), first, "cooling off: still the call for her own item");
    await db.run(db.k.deleteFrom("remote_cooloffs").where("login", "=", "alice"));
    const second = await q({ items: [{ repo: "photocraft", number: 5 }] });
    assert.equal(await leased("alice"), null, "at her Max calls at once: nothing");
    await db.run(db.k.updateTable("remote_calls").set({ state: "done" }).where("id", "=", first));
    assert.equal(await leased("alice"), second, "a free slot takes her own item's call ahead of the older automatic one");
    await db.run(db.k.updateTable("remote_calls").set({ state: "done" }).where("id", "=", second));
    assert.equal(await leased("alice"), auto);
    await setUserMaxCalls(db, "alice", null);
    await updateWorkflow(db, wf, { state: "done" });
    await clear();
  });

  test("another user's runner takes a started item's call only while the starter has no fresh runner, under its own limits", async () => {
    await db.run(db.k.updateTable("tracked_repos").set({ workflow: "new" }).where("name", "=", "photocraft"));
    const wf = await insertWorkflow(db, { repo: "photocraft", number: 6, kind: "pr", entry: "review", state: "running", startedBy: "alice", startedAt: new Date().toISOString(), startedVia: "github" });
    dropQueueCache(db);
    const call = await q({ items: [{ repo: "photocraft", number: 6 }] });
    assert.equal(await leased("bob"), null, "alice's runner is fresh: bob passes it over");
    const old = await q({ items: [{ repo: "photocraft", number: 6 }], ageMs: STARTED_HOLD_MS + 60_000 });
    assert.equal(await leased("bob"), old, "past the hold bob takes it, though alice's runner is fresh");
    await db.run(db.k.updateTable("remote_calls").set({ state: "done" }).where("id", "=", old));
    await unfresh("alice");
    await setUserMaxCalls(db, "bob", 1);
    const busy = await q({ ageMs: 60_000 });
    await db.run(db.k.updateTable("remote_calls").set({ state: "leased", user_login: "bob", leased_at: Date.now(), heartbeat_at: Date.now() }).where("id", "=", busy));
    dropQueueCache(db);
    assert.equal(await leased("bob"), null, "bob runs his Max calls at once");
    await db.run(db.k.updateTable("remote_calls").set({ state: "done" }).where("id", "=", busy));
    await db.run(db.k.insertInto("remote_cooloffs").values({ login: "bob", until: Date.now() + 60_000, reason: "testing cool-off" }));
    assert.equal(await leased("bob"), null, "bob's cool-off holds it back: the call is not his");
    await db.run(db.k.deleteFrom("remote_cooloffs").where("login", "=", "bob"));
    assert.equal(await leased("bob"), call);
    await setUserMaxCalls(db, "bob", null);
    await updateWorkflow(db, wf, { state: "done" });
    await ready("alice");
    await clear();
  });

  test("a maintainer who took a started item's work: their Manual only runner takes its calls while the starter's runner cannot run them, no other item's, and the starter's runner comes first once it can", async () => {
    await db.run(db.k.updateTable("tracked_repos").set({ workflow: "new" }).where("name", "=", "photocraft"));
    const wf = await insertWorkflow(db, { repo: "photocraft", number: 40, kind: "issue", entry: "implement", state: "running", startedBy: "alice", startedAt: new Date().toISOString(), startedVia: "github" });
    await takeItemRunner(db, { workflowId: wf, repo: "photocraft", number: 40, login: "bob", at: new Date().toISOString() });
    await setManualOnly(db, "bob", true);
    await unfresh("olga");
    await storeStatus(db, callers.alice!.tokenId, "alice", parseStatus({ slots: 3, busy: 0, readiness: "quota-held", harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
    dropQueueCache(db);
    const item = [{ repo: "photocraft", number: 40 }];
    await q({ items: [{ repo: "photocraft", number: 41 }], ageMs: 60_000 });
    const first = await q({ items: item });
    assert.equal(await leased("bob"), first, "alice's runner is held by its usage limit: bob's takes the item's call");
    assert.equal(await leased("bob"), null, "and no other item on the repo");
    await ready("alice");
    // Her helper asks for work: its last claim found nothing.
    await db.run(db.k.updateTable("remote_helpers").set({ idle_claim_at: Date.now() }).where("login", "=", "alice"));
    dropQueueCache(db);
    const second = await q({ items: item });
    assert.equal(await leased("bob"), null, "alice's runner could run it now: bob's passes the call over");
    assert.equal(await leased("alice"), second);
    await setUserMaxCalls(db, "alice", 1);
    const third = await q({ items: item });
    assert.equal(await leased("bob"), third, "alice runs her Max calls at once: bob's takes the next one");
    await releaseItemRunner(db, { workflowId: wf, login: "bob", at: new Date().toISOString() });
    dropQueueCache(db);
    const fourth = await q({ items: item });
    assert.equal(await leased("bob"), null, "released: bob's runner takes none of it");
    await setUserMaxCalls(db, "alice", null);
    await setManualOnly(db, "bob", false);
    await updateWorkflow(db, wf, { state: "done" });
    await ready("olga");
    await clear();
  });

  test("the implement step's calls bound to its starter: a taker's runner leases them while the starter's cannot, its session's next turn too, never a conversation turn, and none once the starter's runner is ready with room", async () => {
    const wf = await insertWorkflow(db, { repo: "photocraft", number: 42, kind: "issue", entry: "implement", state: "running", startedBy: "alice", startedAt: new Date().toISOString(), startedVia: "github" });
    await takeItemRunner(db, { workflowId: wf, repo: "photocraft", number: 42, login: "bob", at: new Date().toISOString() });
    await ready("bob");
    await unfresh("alice", "olga");
    const item = [{ repo: "photocraft", number: 42 }];
    const turn = await q({ promptId: "conversation.turn", items: item, forLogin: "alice", ageMs: 60_000 });
    const plan = await q({ promptId: "implement.plan", items: item, forLogin: "alice", boundSlot: true });
    assert.ok(await takerTest(db, Date.now())({ prompt_id: "implement.plan", repos: ["photocraft"], refs: item, forLogin: "alice", tier: "top" }), "bob's runner is a taker, so the call is not withdrawn");
    assert.equal(await leased("bob"), plan, "alice's runner is gone: bob's takes the plan call bound to her");
    assert.equal(await leased("bob"), null, "never her conversation turn");
    const next = await q({ promptId: "implement.plan", items: item, parentId: plan });
    assert.equal(await leased("bob", { sessions: [plan] }), next, "the session's next turn stays on bob's runner");
    await ready("alice");
    await db.run(db.k.updateTable("remote_helpers").set({ idle_claim_at: Date.now() }).where("login", "=", "alice"));
    dropQueueCache(db);
    const session = await q({ promptId: "implement.session", items: item, forLogin: "alice", boundSlot: true });
    assert.equal(await leased("bob"), null, "alice's runner could run it now: bob's passes it over");
    assert.ok([turn, session].includes((await leased("alice"))!));
    await clear();
    // A call alice's only credential declined (requeued with refused_token) goes to bob although her runner has room again;
    // with bob's runner gone nobody may take it, so it has no taker.
    await db.run(db.k.updateTable("remote_helpers").set({ idle_claim_at: Date.now() }).where("login", "=", "alice"));
    const declined = await q({ promptId: "implement.plan", items: item, forLogin: "alice", boundSlot: true });
    await db.run(db.k.updateTable("remote_calls").set({ refused_token: callers.alice!.tokenId }).where("id", "=", declined));
    dropQueueCache(db);
    const asTaker = { prompt_id: "implement.plan", repos: ["photocraft"], refs: item, forLogin: "alice", tier: "top" as Tier, refusedToken: callers.alice!.tokenId };
    assert.equal(await leased("alice"), null, "not again on the credential that declined it");
    assert.equal(await leased("bob"), declined, "bob's runner takes the declined call while alice's other credentials cannot run it");
    await unfresh("bob");
    assert.equal(await takerTest(db, Date.now())(asTaker), false, "with bob's runner gone the declined call has no taker");
    await updateWorkflow(db, wf, { state: "done" });
    await ready("olga");
    await clear();
  });

  test("a starter's runner on Manual only, not taking the repo, is room and a taker for their started item alone", async () => {
    await db.run(db.k.updateTable("tracked_repos").set({ workflow: "new" }).where("name", "=", "photocraft"));
    const wf = await insertWorkflow(db, { repo: "photocraft", number: 7, kind: "pr", entry: "review", state: "running", startedBy: "alice", startedAt: new Date().toISOString(), startedVia: "github" });
    dropQueueCache(db);
    await unfresh("bob", "olga");
    await setManualOnly(db, "alice", true);
    await setUserRepos(db, "alice", ["deckcraft"]);
    await db.run(db.k.updateTable("remote_helpers").set({ idle_claim_at: Date.now() }).where("login", "=", "alice"));
    dropQueueCache(db);
    const now = Date.now(), st = await roomState(db, now), takes = takerTest(db, now);
    const started = [{ repo: "photocraft", number: 7 }], auto = [{ repo: "photocraft", number: 8 }];
    assert.ok(await roomOf(st, 0, ["photocraft"], "opus-review", started) > 0, "room for her started item");
    assert.equal(await roomOf(st, 0, ["photocraft"], "opus-review", auto), 0, "no room for an automatic item");
    assert.ok(await roomOf(st, 0, ["photocraft"], "opus-review") > 0, "a job on the repo of her started item has room");
    assert.ok(await takes({ prompt_id: "", repos: ["photocraft"], step: "opus-review", refs: started }), "a taker for her started item");
    assert.equal(await takes({ prompt_id: "", repos: ["photocraft"], step: "opus-review", refs: auto }), false, "none for an automatic item");
    await setUserRepos(db, "alice", []);
    await setManualOnly(db, "alice", false);
    await updateWorkflow(db, wf, { state: "done" });
    for (const login of ["bob", "olga"]) await ready(login);
    await clear();
  });

  test("the pre-merge check of a merge a maintainer approved waits for their runner, outside their My repos and while it is not ready", async () => {
    await db.run(db.k.updateTable("tracked_repos").set({ workflow: "new" }).where("name", "=", "photocraft"));
    await unfresh("bob", "olga");
    await setUserRepos(db, "alice", ["deckcraft"]);
    const premerge = { prompt_id: "", repos: ["photocraft"], step: "premerge" };
    assert.equal(await takerTest(db, Date.now())(premerge), false, "no started work: no taker");
    const at = new Date().toISOString();
    const wf = await insertWorkflow(db, { repo: "photocraft", number: 9, kind: "pr", entry: "review", state: "running", startedBy: "alice", startedAt: at, startedVia: "github", approvedBy: "alice", approvedAt: at, approvedVia: "github", step: "merge" });
    dropQueueCache(db);
    assert.ok(await takerTest(db, Date.now())(premerge), "her approved merge: her runner takes the pre-merge check");
    assert.ok(await takerTest(db, Date.now())({ ...premerge, refs: [{ repo: "photocraft", number: 9 }] }), "and the call on its PR");
    await db.run(db.k.updateTable("remote_helpers").set({ readiness: "quota-held" }).where("login", "=", "alice"));
    dropQueueCache(db);
    assert.ok(await takerTest(db, Date.now())(premerge), "her runner is held for its quota: the check waits for it");
    assert.equal(await takerTest(db, Date.now())({ ...premerge, refs: [{ repo: "photocraft", number: 10 }] }), false, "a PR nobody started has no taker");
    await setUserRepos(db, "alice", []);
    await updateWorkflow(db, wf, { state: "done" });
    for (const login of ["alice", "bob", "olga"]) await ready(login);
    await clear();
  });

  test("a repo's Fix red main approval makes its main-fix calls the approver's: their runner takes them outside its repos, others pass them over", async () => {
    await setUserRepos(db, "alice", ["deckcraft"]);
    const call = await q({ items: [], promptId: "mainfix.classify" });
    await db.run(db.k.updateTable("remote_calls").set({ repo: "photocraft" }).where("id", "=", call));
    dropQueueCache(db);
    assert.equal(await leased("alice"), null, "no approval: photocraft is outside her repos");
    await setMainFixApproval(db, "alice", "photocraft", true);
    dropQueueCache(db);
    assert.equal(await leased("bob"), null, "bob's runner passes the approver's call over");
    assert.equal(await leased("alice"), call, "her runner takes it outside her repos");
    await setMainFixApproval(db, "alice", "photocraft", false);
    await setUserRepos(db, "alice", []);
    await clear();
  });

  test("why a call waits", () => {
    const r = (o: Partial<ReadyRunner> = {}): ReadyRunner => ({ login: "bob", role: "maintainer", manual: false, tiers: new Set<Tier>(["top"]), free: 1, repos: null, skip: new Set<string>(), ...o });
    const c = { tier: "top" as Tier, promptId: "review.opus", step: "opus-review", repos: ["photocraft"], followUp: false, picked: null };
    const write = () => true;
    assert.equal(whyWaiting({ ...c, picked: { login: "bob" } }, [r()], 0, write).text, "Picked by bob");
    assert.equal(whyWaiting({ ...c, followUp: true }, [r()], 0, write).code, "session");
    assert.equal(whyWaiting({ ...c, tier: "mid" }, [r()], 0, write).code, "no-runner");
    assert.equal(whyWaiting(c, [r({ manual: true })], 0, write).code, "manual-only");
    assert.equal(whyWaiting(c, [r()], 0, () => false).code, "no-repo-access");
    assert.equal(whyWaiting({ ...c, repos: [] }, [r()], 0, write).code, "no-repo-access", "a repo-less call goes to operators only");
    assert.equal(whyWaiting(c, [r({ skip: new Set(["review"]) })], 0, write).code, "task-off");
    assert.equal(whyWaiting(c, [r({ skip: new Set(["review"]) }), r({ free: 0 })], 0, write).code, "busy", "the free runner does not take reviews");
    assert.equal(whyWaiting(c, [r({ free: 0 }), r({ manual: true })], 0, write).code, "busy");
    assert.deepEqual(whyWaiting(c, [r()], 3, write), { code: "behind", text: "3 calls ahead" });
  });
});
