// The user-local inference mode: askClaude queues a remote call, a helper claims it, fetches the bundle and submits, and
// askClaude returns the reply. A lease without heartbeats goes back to the queue; the item's authors never get a judging call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { allocation, WaitLimitError } from "../src/agents/call.ts";
import { askClaude, setWorkspace } from "../src/classify/run.ts";
import type { Lint } from "../src/replylint.ts";
import { handleMcp, type McpEnv } from "../src/dash/mcp/index.ts";
import { noteLine } from "../src/github/note.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import type { User } from "../src/dash/types.ts";
import { SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { awaitCall, bundleOf, claimableCalls, claimCall, CLAIM_RETRY_S, enqueueCall, expireLeases, heartbeat, leaseState, RELEASE_SKIP_MS, releaseCall, SETUP_RETRY_MS, withdrawCall, submitCall, type Caller } from "../src/remote/calls.ts";
import { stampAlive } from "../src/remote/liveness.ts";
import { clearCooloff } from "../src/remote/cooloff.ts";
import * as userSettings from "../src/dash/api/user-settings.ts";
import type { Req } from "../src/dash/types.ts";
import { listHelpers, parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { remoteRoom } from "../src/remote/room.ts";
import { setAcceptedModels } from "../src/remote/mode.ts";
import { PROTOCOL_VERSION, type Claim } from "../src/remote/protocol.ts";
import { SCRATCH } from "./scratch.ts";
import { checkoutForPr } from "../src/sandbox/index.ts";
import { mapSeq } from "../src/async-seq.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { excluded } from "../src/db/kx.ts";
import { dropQueueCache } from "../src/data/runners/calls-shared.ts";
import { markHelperIdle } from "../src/data/runners/index.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "remote-calls-"));

describe("user-local remote calls", async () => {
  const db = await connectDb(join(dir, "t.db"));
  allocation.pollMs = 10;
  const T0 = new Date().toISOString();
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 1287, kind: "pr", state: "OPEN", title: "t", author: "alice", created_at: T0, updated_at: T0 }));
  await db.run(db.k.insertInto("pr_commits").values({ repo: "photocraft", number: 1287, oid: "abc", committed_at: T0, author: "carol", co_authors: JSON.stringify(["carol", "Dave"]) }));
  const callers: Record<string, Caller> = {};
  for (const login of ["alice", "bob", "carol", "dave"]) {
    await db.run(db.k.insertInto("access").values({ login, role: "maintainer" }));
    callers[login] = { tokenId: (await createToken(db, login, "helper", { kind: "runner" })).row.id, login, role: "maintainer" };
  }
  let claims = 0;
  /** A claim body with its own request id: a repeated id gets the first claim's reply. */
  const claim = (): Claim => ({ requestId: `test-claim-${String(++claims).padStart(4, "0")}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } });
  const canWrite = async () => true;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const leaseFor = async (login: string, extra: Partial<Claim> = {}) => {
    for (let i = 0; i < 200; i++) {
      // A call queued before the claim and not leased by it: nothing for this login. One queued while the claim ran is tried again.
      const queued = !!await db.get(db.k.selectFrom("remote_calls").select((eb) => eb.lit(1).as("one")).where("state", "=", "queued"));
      const r = await claimCall(db, callers[login]!, { ...claim(), ...extra }, canWrite);
      if (r.lease) return r.lease;
      if (queued) return null;
      await sleep(5);
    }
    throw new Error("no call was queued");
  };
  /** `login`'s helper asked for top-tier work a moment ago and found none; its write permission on the repo is cached. */
  const idle = async (login: string) => {
    await markHelperIdle(db, callers[login]!, { now: Date.now(), tiers: ["top"], repos: null });
    await db.run(db.k.insertInto("repo_permissions").values({ login, repo: "photocraft", permission: "write", checked_at: new Date().toISOString() })
      .onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet(excluded(["permission", "checked_at"]))));
  };
  const noneIdle = async () => {
    await db.run(db.k.updateTable("remote_helpers").set({ idle_claim_at: null }));
    dropQueueCache(db);
  };
  const req = (login: string, role: string, json?: unknown) => ({ user: { login, role, canWrite: async () => true }, json }) as unknown as Req;
  const done = async (secret: string, text: string) => await submitCall(db, secret, { ok: true, text, model: "claude-opus-4-5", usage: { inputTokens: 100, outputTokens: 20 }, modelUsage: { "claude-opus-4-5": { inputTokens: 90, outputTokens: 15 }, "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5 } }, costUsd: 0.25,
    tools: [{ name: "mcp__items__item", args: '{"ref":"photocraft#1"}', resultBytes: 300, isError: false, startedAt: "2026-11-19T10:00:00.000Z", endedAt: "2026-11-19T10:00:01.000Z" }], durationMs: 1000 });

  test("a helper claims, fetches the bundle and submits; authors and co-authors give way while another helper is idle", async () => {
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    await idle("bob");
    assert.equal(await leaseFor("alice"), null, "the PR's author");
    assert.equal(await leaseFor("carol"), null, "a committer on the PR");
    assert.equal(await leaseFor("dave"), null, "a co-author of a commit");
    await assert.rejects(claimCall(db, callers.bob!, { ...claim(), helperVersion: "0.9.0" }, canWrite), /older than/);
    const lease = (await leaseFor("bob"))!;
    assert.match(lease.title, /^review\.opus on photocraft#1287/);
    const b = (await bundleOf(db, lease.secret))!;
    assert.equal(b.tier, "top");
    assert.equal(b.callId, lease.id);
    assert.ok(b.stdin.length > 0 && b.system !== null);
    assert.deepEqual(b.mounts, []);
    assert.ok(b.hints.claude!.args.includes("--model"));
    assert.equal(await heartbeat(db, lease.secret, { progress: "reading" }), true);
    assert.deepEqual(await done(lease.secret, "the review"), { accepted: true });
    const r = await ask;
    assert.equal(r?.text, "the review");
    assert.equal(r?.model, "claude-opus-4-5", "the stage learns the model that ran");
    assert.equal(noteLine({ by: "model", kind: "review", model: r?.model }), "_AI-generated review (Claude Opus 4.5). Not a maintainer decision._");
    assert.equal(noteLine({ by: "model", kind: "review", model: "gpt-6.2-astra" }), "_AI-generated review (Codex Astra 6.2). Not a maintainer decision._");
    assert.equal(noteLine({ by: "model", kind: "review", model: "opus" }), "_AI-generated review (Opus). Not a maintainer decision._", "a server call names the prompt's model as before");
    assert.equal((await db.get(db.k.selectFrom("remote_calls").select("reply").where("id", "=", lease.id)))!.reply, null, "the raw reply is not kept");
    assert.equal(r?.usage.input, 90);
    assert.deepEqual(r?.usage.extra?.map((e) => [e.model, e.usage.input]), [["haiku", 10]]);
    const run = await db.get(db.k.selectFrom("agent_runs").select(["state", "user_login", "harness", "reported_model", "cost_usd"])
      .where("id", "=", (eb) => eb.selectFrom("remote_calls").select("run_id").where("remote_calls.id", "=", lease.id)));
    assert.deepEqual({ ...run }, { state: "done", user_login: "bob", harness: "claude", reported_model: "claude-opus-4-5", cost_usd: 0.25 });
    const tool = await db.prepare("SELECT seq, tool, args, result_bytes, started_at FROM agent_run_tools WHERE run_id = (SELECT run_id FROM remote_calls WHERE id = ?)").get(lease.id) as Record<string, unknown>;
    assert.deepEqual({ ...tool }, { seq: 1, tool: "mcp__items__item", args: '{"ref":"photocraft#1"}', result_bytes: 300, started_at: "2026-11-19T10:00:00.000Z" });
  });

  test("with no other helper asking for work, the PR's author gets the review", async () => {
    await noneIdle();
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    const lease = (await leaseFor("alice"))!;
    assert.ok(lease, "the author's helper takes it");
    await done(lease.secret, "by the author");
    assert.equal((await ask)?.text, "by the author");
  });

  test("the author does not give way to a helper whose write permission is not known", async () => {
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    await idle("bob");
    await db.run(db.k.deleteFrom("repo_permissions").where("login", "=", "bob"));
    const lease = (await leaseFor("alice"))!;
    assert.ok(lease, "nobody else is known to be able to take it");
    await done(lease.secret, "by the author");
    assert.equal((await ask)?.text, "by the author");
    await noneIdle();
  });

  const queue = async () => await enqueueCall(db, {
    promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number: 1287 }], level: 0, maxAttempts: 2,
    bundle: { stdin: "x", timeoutSeconds: 600, mcpServers: [], hints: {}, mounts: [], keepSession: false, system: null } as never,
  });

  test("a waiting caller gets the helper's progress lines, each once", async () => {
    const id = await queue();
    const lines: string[] = [];
    const out = awaitCall(db, id, { onProgress: (l) => void lines.push(l) });
    const lease = (await leaseFor("bob"))!;
    for (const progress of ["reading a.rs", "reading a.rs", "reading b.rs"]) {
      await heartbeat(db, lease.secret, { progress });
      await sleep(60);
    }
    await done(lease.secret, "ok");
    assert.equal((await out).state, "done");
    assert.deepEqual(lines, ["reading a.rs", "reading b.rs"]);
  });

  test("a lost lease that cannot be expired fails its own caller; another call's reply of the same poll is delivered", async (t) => {
    const ids = [await queue(), await queue()];
    const leases = [(await leaseFor("bob"))!, (await leaseFor("bob"))!];
    assert.deepEqual(leases.map((l) => l.id).sort((a, b) => a - b), ids);
    const [finished, lost] = ids.map((id) => awaitCall(db, id).then((o) => (o.state === "done" ? o.text : o.state), (e: Error) => e.message)) as [Promise<string>, Promise<string>];
    const write = db.write.bind(db);
    let failed = false;
    t.mock.method(db, "write", (async (fn: () => Promise<unknown>, ...rest: []) => {
      if (!failed && new Error().stack!.includes("expireLeases")) {
        failed = true;
        throw new Error("the expiry failed");
      }
      return await write(fn, ...rest);
    }) as typeof db.write);
    await write(async () => {
      await db.run(db.k.updateTable("remote_calls").set({ state: "done", reply: "the reply", ended_at: Date.now(), lease_secret_hash: null }).where("id", "=", ids[0]!));
      await db.run(db.k.updateTable("remote_calls").set((eb) => ({ heartbeat_at: eb("heartbeat_at", "-", 3 * 60000) })).where("id", "=", ids[1]!));
    });
    assert.equal(await finished, "the reply");
    assert.equal(await lost, "the expiry failed");
    await withdrawCall(db, ids[1]!, "test over");
  });

  test("a reply goes to one await: a second await of the call that starts while the reply is taken does not get it", async (t) => {
    const id = await queue();
    const lease = (await leaseFor("bob"))!;
    const text = (o: Promise<Awaited<ReturnType<typeof awaitCall>>>) => o.then((r) => (r.state === "done" ? r.text : r.state));
    const first = text(awaitCall(db, id));
    let second: Promise<string> | null = null;
    const run = db.run.bind(db);
    t.mock.method(db, "run", (async (...args: Parameters<typeof db.run>) => {
      if (!second && new Error().stack!.includes("takeReplies")) {
        second = text(awaitCall(db, id));
        await sleep(50);
      }
      return await run(...args);
    }) as typeof db.run);
    await done(lease.secret, "the reply");
    assert.equal(await first, "the reply");
    assert.ok(second, "the reply was taken");
    assert.notEqual(await second, "the reply");
  });

  test("a lease without heartbeats goes back to the queue and the next claim gets it; the old secret is dead", async () => {
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    const first = (await leaseFor("bob"))!;
    await db.run(db.k.updateTable("remote_calls").set((eb) => ({ heartbeat_at: eb("heartbeat_at", "-", 3 * 60000) })).where("id", "=", first.id));
    let second = null;
    for (let i = 0; i < 200 && !second; i++) { second = (await claimCall(db, callers.bob!, claim(), canWrite)).lease; if (!second) await sleep(5); }
    assert.equal(second!.id, first.id, "the same call, leased again");
    assert.equal(await heartbeat(db, first.secret, {}), false);
    assert.equal(await done(first.secret, "stale"), null, "the route answers 410");
    assert.deepEqual(await leaseState(db, first.secret), { id: first.id, live: false }, "a requeued lease's secret is known: 410, not 401");
    assert.equal(await leaseState(db, "aclease_never-issued"), null);
    assert.equal((await db.get(db.k.selectFrom("remote_calls").select("attempt").where("id", "=", first.id)))!.attempt, 2);
    assert.equal(await db.get(db.k.selectFrom("remote_lease_drops").select("token_id").where("login", "=", "bob")), undefined, "a lease that never had a heartbeat (its claim's reply was likely lost) is no drop");
    // A reply from another model family than the claim declared is refused.
    assert.equal((await submitCall(db, second!.secret, { ok: true, text: "x", model: "claude-sonnet-4-5", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 }))?.accepted, false);
    assert.equal(await ask, null, "both attempts are used up");
    const runs = await db.all(db.k.selectFrom("agent_runs").select(["state", "error"]).where("prompt_id", "=", "review.opus").orderBy("id", "desc").limit(2));
    assert.deepEqual(runs.map((x) => x.state), ["failed", "failed"]);
    assert.match(runs[1]!.error!, /lease expired/);
  });

  test("three lost leases of distinct calls of one login within two hours cool its helpers off for six hours; its next claim says why and until when; an operator clears it", async () => {
    await db.run(db.k.insertInto("access").values({ login: "erin", role: "maintainer" }));
    // A token's drops count once in 10 minutes: three helpers of the same user each lose one.
    const tokens = await mapSeq([1, 2, 3], async () => (await createToken(db, "erin", "helper", { kind: "runner" })).row.id);
    let erin: Caller = { tokenId: tokens[0]!, login: "erin", role: "maintainer" };
    const mine = async () => (await claimCall(db, erin, claim(), canWrite)).lease;
    const lose = async (id: number, now: number) => {
      // The helper heartbeat after its claim, then went quiet. One transaction: the caller's own poll expires a lost lease at the real time.
      await db.write(async () => {
        await db.run(db.k.updateTable("remote_calls").set({ leased_at: now - 4 * 60000, heartbeat_at: now - 3 * 60000 }).where("id", "=", id));
        await expireLeases(db, now);
      });
    };
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    const t0 = Date.now();
    let lease = null;
    for (let i = 0; i < 200 && !lease; i++) { lease = await mine(); if (!lease) await sleep(5); }
    await lose(lease!.id, t0);
    erin = { ...erin, tokenId: tokens[1]! };
    const again = (await mine())!;
    assert.equal(again.id, lease!.id, "a lost lease is not a failed call: the call goes back to the queue");
    await lose(again.id, t0 + 1000);
    assert.equal((await db.get(db.k.selectFrom("remote_lease_drops").select((eb) => eb.fn.countAll<number>().as("n")).where("login", "=", "erin")))!.n, 1, "the same call lost again counts once");
    erin = { ...erin, tokenId: tokens[2]! };
    assert.equal(await ask, null, "the call used its attempts");
    const take = async () => { for (let i = 0; i < 200; i++) { const l = await mine(); if (l) return l; await sleep(5); } throw new Error("no lease"); };
    // A second call, lost twice: one more drop.
    const ask2 = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    const second = await take();
    await lose(second.id, t0 + 1500);
    assert.equal((await claimCall(db, erin, claim(), canWrite, t0 + 1600)).lease?.id, second.id, "two drops: no cool-off yet");
    await lose(second.id, t0 + 1700);
    assert.equal(await ask2, null);
    erin = { ...erin, tokenId: tokens[1]! };
    const ask3 = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    await lose((await take()).id, t0 + 2000);
    const reply = await claimCall(db, erin, claim(), canWrite, t0 + 3000);
    assert.equal(reply.lease, null);
    assert.equal(reply.lease === null && reply.until, t0 + 2000 + 6 * 3600_000);
    assert.match(reply.lease === null ? reply.reason ?? "" : "", /3 times within 2 hours/);
    assert.equal((await claimCall(db, { ...erin, tokenId: tokens[0]! }, claim(), canWrite, t0 + 3000)).lease, null, "every token of the login");
    assert.equal(await clearCooloff(db, "erin", "test"), true);
    assert.ok((await claimCall(db, erin, claim(), canWrite, t0 + 3000)).lease, "the call is back in the queue for the cleared helper");
    await withdrawCall(db, (await db.get(db.k.selectFrom("remote_calls").select("id").where("state", "in", ["queued", "leased"]).orderBy("id", "desc").limit(1)))!.id, "test over");
    await ask3;
  });

  test("a claim whose declared effort is below a tier's minimum gets nothing, and the refusal names the families and the floor", async () => {
    await setAcceptedModels(db, undefined, "test", { top: "high" });
    const claimant = callers.bob!;
    await assert.rejects(claimCall(db, claimant, claim(), canWrite), /opus\/astra at effort high or higher/);
    await assert.rejects(claimCall(db, claimant, { ...claim(), efforts: { top: "medium" } }, canWrite), /at effort high or higher/);
    assert.equal((await claimCall(db, claimant, { ...claim(), efforts: { top: "xhigh" } }, canWrite)).lease, null, "meets the floor; nothing is queued");
    await setAcceptedModels(db, undefined, "test", { top: "max" });
    const codex: Claim = { ...claim(), harness: "codex", tiers: { top: "gpt-6-astra" }, efforts: { top: "xhigh" } };
    assert.equal((await claimCall(db, claimant, codex, canWrite)).lease, null, "Codex's top level, xhigh, meets a max floor");
    await assert.rejects(claimCall(db, claimant, { ...claim(), efforts: { top: "xhigh" } }, canWrite), /effort max/);
    await setAcceptedModels(db, undefined, "test", { top: null });
    assert.equal((await claimCall(db, claimant, claim(), canWrite)).lease, null, "no floor: any helper");
  });

  test("the session tools count what the login may claim, and show a lease only to its holder", async () => {
    const env = (login: string, run = true): McpEnv => ({
      db, baseUrl: null, canAnswer: false, expensive: () => 0,
      user: async () => ({ login, role: "maintainer" }) as unknown as User,
      ...(run && { run: { canWrite } }),
    });
    const call = async (e: McpEnv, name: string, args: unknown = {}) => {
      const r = (await handleMcp(e, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }))!.result as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]!.text, isError: r.isError === true };
    };
    const names = async (e: McpEnv) => ((await handleMcp(e, { jsonrpc: "2.0", id: 1, method: "tools/list" }))!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.ok((await names(env("bob"))).includes("next_task"));
    assert.ok(!(await names(env("bob", false))).includes("next_task"), "not offered without a Task Runner that reports in");
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    while (!await db.get(db.k.selectFrom("remote_calls").select((eb) => eb.lit(1).as("one")).where("state", "=", "queued"))) await sleep(5);
    await idle("bob");
    assert.match((await call(env("alice"), "next_task")).text, /^No call is queued/, "the PR's author, while bob's helper is idle");
    assert.match((await call(env("bob"), "next_task", { tiers: ["mid"] })).text, /^No call is queued/, "wrong tier");
    assert.match((await call(env("bob"), "next_task", { models: { top: "gpt-5" } })).text, /^No call is queued/, "a model outside the accepted families");
    assert.match((await call(env("bob"), "next_task", { models: { top: "claude-opus-4-5" } })).text, /^1 call is queued/);
    const queued = await call(env("bob"), "next_task");
    assert.match(queued.text, /^1 call is queued/);
    assert.match(queued.text, /autocraft run --detach/);
    assert.ok(await db.get(db.k.selectFrom("remote_calls").select((eb) => eb.lit(1).as("one")).where("state", "=", "queued")), "next_task leases nothing");
    const lease = (await leaseFor("bob"))!;
    assert.match((await call(env("bob"), "task_status", { lease: String(lease.id) })).text, /: leased$/);
    assert.equal((await call(env("alice"), "task_status", { lease: String(lease.id) })).isError, true, "another login's lease");
    assert.match((await call(env("bob"), "my_work")).text, /review\.opus/);
    await done(lease.secret, "ok");
    await ask;
  });

  test("a user sets their own usage reserve, the claim reply carries it, and only a helper that reported ready is room", async () => {
    assert.deepEqual((await userSettings.settings(db, req("bob", "maintainer"))).reserve, { fiveHour: 20, weekly: 20 }, "the default");
    await userSettings.setSettings(db, req("bob", "maintainer", { reserve: { fiveHour: 35, weekly: 10 } }));
    assert.deepEqual((await userSettings.settings(db, req("bob", "maintainer"))).reserve, { fiveHour: 35, weekly: 10 });
    assert.deepEqual((await userSettings.settings(db, req("carol", "maintainer"))).reserve, { fiveHour: 20, weekly: 20 }, "another user's is their own");
    await assert.rejects(userSettings.setSettings(db, req("bob", "maintainer", { reserve: { fiveHour: 95, weekly: 10 } })), /0 to 90/);
    await assert.rejects(userSettings.setSettings(db, req("eve", "viewer", { reserve: { fiveHour: 30, weekly: 30 } })), /viewers/);
    assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action = 'usage-reserve' AND login = 'bob'").get());
    assert.deepEqual(await claimCall(db, callers.bob!, claim(), canWrite), { lease: null, retryAfter: CLAIM_RETRY_S, reserve: { fiveHour: 35, weekly: 10 } });
    assert.equal(await remoteRoom(db, 0), 0, "an idle helper that never reported ready");
    const status = { slots: 1, busy: 0, harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 35, weekly: 10 }, usage: { fiveHour: { usedPercent: 70, resetsAt: null }, weekly: null, at: new Date().toISOString() } };
    await storeStatus(db, callers.bob!.tokenId, "bob", parseStatus({ ...status, readiness: "ready" }));
    assert.equal(await remoteRoom(db, 0), 1);
    await storeStatus(db, callers.bob!.tokenId, "bob", parseStatus({ ...status, slots: 3, readiness: "ready" }));
    assert.equal(await remoteRoom(db, 0), 2, "--parallel 2 and the fast lane: the fast lane is no room");
    await storeStatus(db, callers.bob!.tokenId, "bob", parseStatus({ ...status, readiness: "quota-held", until: "2026-11-20T01:30:00.000Z", reason: "5-hour window 70% used" }));
    assert.equal(await remoteRoom(db, 0), 0, "held by its plan usage");
    const [h] = await listHelpers(db, "bob");
    assert.equal(h?.readiness, "quota-held");
    assert.equal(h?.fresh, true);
    assert.equal(h?.usage?.fiveHour?.usedPercent, 70);
    await db.run(db.k.insertInto("remote_cooloffs").values({ login: "bob", until: Date.now() + 3600_000, reason: "test" })
      .onConflict((oc) => oc.column("login").doUpdateSet((eb) => ({ ...excluded(["until", "reason"])(eb), failures: 0, failures_since: null }))));
    assert.equal((await listHelpers(db, "bob"))[0]?.readiness, "cooled-off", "the server's cool-off shows before the helper reports it");
    await db.run(db.k.deleteFrom("remote_cooloffs").where("login", "=", "bob"));
  });

  test("a user's repo picks limit their claims and next_task; the helper's own list narrows them, never widens them", async () => {
    await noneIdle();
    await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('photocraft', 1), ('fontcraft', 1), ('gridcraft', 0) ON CONFLICT (name) DO UPDATE SET pipeline = excluded.pipeline").run();
    const pick = (repos: string[]) => userSettings.setSettings(db, req("bob", "maintainer", { repos }));
    const got = await pick(["fontcraft", "gridcraft"]);
    assert.deepEqual([got.repos, got.repoChoices], [["fontcraft", "gridcraft"], ["fontcraft", "photocraft"]], "picks are kept; choices are the pipeline-on repos");
    await assert.rejects(pick(["nosuchrepo"]), /not tracked/);
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    while (!await db.get(db.k.selectFrom("remote_calls").select((eb) => eb.lit(1).as("one")).where("state", "=", "queued"))) await sleep(5);
    assert.equal((await claimCall(db, callers.bob!, claim(), canWrite)).lease, null, "photocraft is not picked");
    assert.equal((await db.get(db.k.selectFrom("remote_helpers").select("idle_repos").where("token_id", "=", callers.bob!.tokenId)))!.idle_repos, '["fontcraft","gridcraft"]', "the idle helper records what it takes");
    assert.equal(await claimableCalls(db, callers.bob!, {}, canWrite), 0);
    await pick(["photocraft"]);
    assert.equal(await claimableCalls(db, callers.bob!, {}, canWrite), 1);
    assert.equal((await claimCall(db, callers.bob!, { ...claim(), repos: ["fontcraft"] }, canWrite)).lease, null, "the helper's list narrows");
    assert.equal((await db.get(db.k.selectFrom("remote_helpers").select("idle_repos").where("token_id", "=", callers.bob!.tokenId)))!.idle_repos, "[]");
    const lease = (await claimCall(db, callers.bob!, { ...claim(), repos: ["photocraft", "fontcraft"] }, canWrite)).lease!;
    assert.match(lease.title, /photocraft#1287/);
    await done(lease.secret, "picked");
    assert.equal((await ask)?.text, "picked");
    await pick([]);
  });

  const stateOf = async (id: number) => (await db.get(db.k.selectFrom("remote_calls").select("state").where("id", "=", id)))!.state;

  test("a repeated claim gets the same lease, and a dashboard outage ends no lease", async () => {
    await noneIdle();
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    while (!await db.get(db.k.selectFrom("remote_calls").select((eb) => eb.lit(1).as("one")).where("state", "=", "queued"))) await sleep(5);
    const c = claim();
    const [a, b] = await Promise.all([claimCall(db, callers.bob!, c, canWrite), claimCall(db, callers.bob!, c, canWrite)]);
    assert.ok(a.lease);
    assert.deepEqual(b, a, "a repeat while the first is still being answered");
    assert.deepEqual(await claimCall(db, callers.bob!, c, canWrite), a, "a repeat after the reply was lost");
    const id = a.lease!.id, now = Date.now();
    // The dashboard's last stamp is 5 minutes old; the lease's last heartbeat 3 minutes.
    await db.run(db.k.insertInto("remote_liveness").values({ id: 1, alive_at: now - 5 * 60_000, since: now - 3600_000 }).onConflict((oc) => oc.column("id").doUpdateSet(excluded(["alive_at", "since"]))));
    await db.run(db.k.updateTable("remote_calls").set({ heartbeat_at: now - 3 * 60_000 }).where("id", "=", id));
    await expireLeases(db, now);
    assert.equal(await stateOf(id), "leased", "nothing expires while the dashboard is down");
    await stampAlive(db, now);
    assert.equal((await db.get(db.k.selectFrom("remote_calls").select("heartbeat_at").where("id", "=", id)))!.heartbeat_at, now, "the dashboard came back: the heartbeat moved forward by the gap, up to now");
    await db.run(db.k.deleteFrom("remote_liveness"));
    await done(a.lease!.secret, "after the outage");
    assert.equal((await ask)?.text, "after the outage");
  });

  test("a call bound to a maintainer waits only firstWaitMs for their runner; its fix turn on the session waits past that and keeps the first reply", async () => {
    const restore = setWorkspace(async () => []);
    const checkout = join(SCRATCH, "checkouts", "photocraft", "c".repeat(40));
    mkdirSync(checkout, { recursive: true });
    const lint: Lint = (text, stage) => (stage === "first" && text.includes("leaky") ? [{ field: "public.points[0]", message: "mentions the reference folder", text: "a leaky point" }] : []);
    const reply = (secret: string, text: string) => submitCall(db, secret, { ok: true, text, model: "claude-opus-4-5", usage: { inputTokens: 10, outputTokens: 5 }, sessionId: "s1", durationMs: 10 });
    const wait = 100;
    const opts = { checkout, lint, itemTools: null, forLogin: "alice", firstWaitMs: wait };
    try {
      await assert.rejects(askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, opts), WaitLimitError, "no runner took the first call in time");
      const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, opts);
      const first = (await leaseFor("alice"))!;
      await reply(first.secret, JSON.stringify({ verdict: "take", summary: "s", why: "w", public: { summary: "ok", points: ["a leaky point", "second"] } }));
      // The fix turn on the session waits longer than the first call could.
      let fix: { id: number; secret: string } | null = null;
      for (let i = 0; i < 100 && !fix; i++) {
        await sleep(wait / 2);
        const queued = await db.get(db.k.selectFrom("remote_calls").select(["since"]).where("parent_id", "=", first.id).where("state", "=", "queued"));
        if (queued && Date.now() - Number(queued.since) > wait * 2) fix = (await claimCall(db, callers.alice!, { ...claim(), sessions: [first.id] }, canWrite)).lease;
      }
      assert.ok(fix, "the fix turn was still queued past firstWaitMs");
      await reply(fix.secret, JSON.stringify({ "public.points[0]": "clean point" }));
      assert.deepEqual(JSON.parse((await ask)!.text).public.points, ["clean point", "second"]);
    } finally {
      restore();
    }
  });

  test("a review on a server with no local sandbox (AUTOCRAFT_NO_SANDBOX=1, no claude) still gets its checkout as a mount and tool mode", async () => {
    const restore = setWorkspace(async () => []);
    const saved = { no: process.env.AUTOCRAFT_NO_SANDBOX, bin: process.env.AUTOCRAFT_CLAUDE_BIN };
    process.env.AUTOCRAFT_NO_SANDBOX = "1";
    process.env.AUTOCRAFT_CLAUDE_BIN = join(dir, "no-claude");
    const sha = "d".repeat(40);
    mkdirSync(join(SCRATCH, "checkouts", "photocraft", sha), { recursive: true });
    try {
      const checkout = await checkoutForPr("photocraft", 1287, sha);
      assert.ok(checkout, "the existing checkout is used");
      const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, { checkout, itemTools: null });
      await idle("bob");
      const lease = (await leaseFor("bob"))!;
      const b = (await bundleOf(db, lease.secret))!;
      assert.ok(b.mounts.some((m) => m.path === "/repo"), "the checkout is mounted");
      assert.ok(b.maxTurns !== null && b.maxTurns > 0);
      const args = b.hints.claude!.args;
      assert.ok(args[args.indexOf("--tools") + 1]!.includes("Read"), "file tools are given");
      await done(lease.secret, JSON.stringify({ verdict: "take", summary: "s", why: "w", public: { summary: "ok", points: [] } }));
      await ask;
    } finally {
      process.env.AUTOCRAFT_NO_SANDBOX = saved.no;
      process.env.AUTOCRAFT_CLAUDE_BIN = saved.bin;
      if (saved.no === undefined) delete process.env.AUTOCRAFT_NO_SANDBOX;
      if (saved.bin === undefined) delete process.env.AUTOCRAFT_CLAUDE_BIN;
      restore();
    }
  });

  test("a failed reply sends the call back to the queue with its next attempt, for another user's helper; the old secret answers 410", async () => {
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    const first = (await leaseFor("bob"))!;
    assert.equal(await heartbeat(db, first.secret, { phase: "running" }), true);
    const runId = (await db.get(db.k.selectFrom("remote_calls").select("run_id").where("id", "=", first.id)))!.run_id!;
    const failure = { ok: false, error: "model error the run stopped (exit 1)", stopReason: "max_tokens", subtype: "error_during_execution", usage: { inputTokens: 900, outputTokens: 128000 }, durationMs: 5 };
    assert.deepEqual(await submitCall(db, first.secret, failure), { accepted: true });
    // The attempt's run records why it stopped and what it used.
    const run = (await db.get(db.k.selectFrom("agent_runs").select(["state", "error", "output_tokens"]).where("id", "=", runId)))!;
    assert.equal(run.state, "failed");
    assert.match(run.error ?? "", /stop_reason max_tokens.*subtype error_during_execution.*128000 output tokens.*the run stopped/);
    assert.equal(Number(run.output_tokens), 128000);
    assert.deepEqual({ ...await db.get(db.k.selectFrom("remote_calls").select(["state", "attempt", "released_by", "started_at"]).where("id", "=", first.id)) }, { state: "queued", attempt: 2, released_by: "bob", started_at: null });
    assert.deepEqual(await leaseState(db, first.secret), { id: first.id, live: false });
    assert.equal((await claimCall(db, callers.bob!, claim(), canWrite)).lease, null, "not offered to the user whose helper failed it");
    assert.equal((await db.get(db.k.selectFrom("remote_cooloffs").select("failures").where("login", "=", "bob")))!.failures, 1, "counts toward bob's cool-off");
    await noneIdle();
    const second = (await leaseFor("alice"))!;
    assert.equal(second.id, first.id);
    await done(second.secret, "second try");
    assert.equal((await ask)?.text, "second try");
  });

  test("a run that used every turn goes back with twice the turns and a larger task budget; another failure keeps the limit", async () => {
    const restore = setWorkspace(async () => []);
    const saved = { no: process.env.AUTOCRAFT_NO_SANDBOX, bin: process.env.AUTOCRAFT_CLAUDE_BIN };
    process.env.AUTOCRAFT_NO_SANDBOX = "1";
    process.env.AUTOCRAFT_CLAUDE_BIN = join(dir, "no-claude");
    const sha = "e".repeat(40);
    mkdirSync(join(SCRATCH, "checkouts", "photocraft", sha), { recursive: true });
    const limits = (b: Awaited<ReturnType<typeof bundleOf>>) => {
      const args = b!.hints.claude!.args;
      return { maxTurns: b!.maxTurns!, flag: Number(args[args.indexOf("--max-turns") + 1]), budget: Number(args[args.indexOf("--task-budget") + 1]) };
    };
    const fail = (subtype: string) => ({ ok: false, error: "the run stopped", subtype, usage: { inputTokens: 900, outputTokens: 100 }, durationMs: 5 });
    try {
      const checkout = (await checkoutForPr("photocraft", 1287, sha))!;
      const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, { checkout, itemTools: null });
      const newer = { harnessVersion: "2.1.323" };
      await idle("bob");
      const first = (await leaseFor("bob", newer))!;
      // A third attempt, for the failure after the retry.
      await db.run(db.k.updateTable("remote_calls").set({ max_attempts: 3 }).where("id", "=", first.id));
      const before = limits(await bundleOf(db, first.secret));
      assert.equal(before.flag, before.maxTurns, "the harness gets the bundle's turn limit");
      const runId = (await db.get(db.k.selectFrom("remote_calls").select("run_id").where("id", "=", first.id)))!.run_id!;
      await submitCall(db, first.secret, fail("error_max_turns"));
      assert.match((await db.get(db.k.selectFrom("agent_runs").select("summary").where("id", "=", runId)))!.summary ?? "", new RegExp(`retried with ${before.maxTurns * 2} turns`));
      await noneIdle();
      await idle("alice");
      const second = (await leaseFor("alice", newer))!;
      assert.equal(second.id, first.id);
      const after = limits(await bundleOf(db, second.secret));
      assert.equal(after.maxTurns, before.maxTurns * 2);
      assert.equal(after.flag, after.maxTurns);
      assert.ok(after.budget > before.budget, "the task budget grows with the turns");
      await submitCall(db, second.secret, fail("error_during_execution"));
      await noneIdle();
      await idle("carol");
      const third = (await leaseFor("carol", newer))!;
      assert.deepEqual(limits(await bundleOf(db, third.secret)), after, "a failure that is not the turn limit keeps it");
      await done(third.secret, JSON.stringify({ verdict: "take", summary: "s", why: "w", public: { summary: "ok", points: [] } }));
      await ask;
    } finally {
      process.env.AUTOCRAFT_NO_SANDBOX = saved.no;
      process.env.AUTOCRAFT_CLAUDE_BIN = saved.bin;
      if (saved.no === undefined) delete process.env.AUTOCRAFT_NO_SANDBOX;
      if (saved.bin === undefined) delete process.env.AUTOCRAFT_CLAUDE_BIN;
      restore();
    }
  });

  test("after a give-back for a local setup failure the same user's runner takes the call again within minutes, up to its attempts; other give-backs keep it away longer", async () => {
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    let lease = (await leaseFor("bob"))!;
    const id = lease.id;
    const ago = async (ms: number) => {
      await db.run(db.k.updateTable("remote_calls").set((eb) => ({ released_at: eb("released_at", "-", ms) })).where("id", "=", id));
      dropQueueCache(db);
    };
    const bobGets = async () => (await claimCall(db, callers.bob!, claim(), canWrite)).lease;
    assert.equal(await releaseCall(db, lease.secret, { reason: "the provider refused the run for its usage limit" }), true);
    await ago(SETUP_RETRY_MS + 1000);
    assert.equal(await bobGets(), null, "a give-back for another reason keeps the long skip");
    await ago(RELEASE_SKIP_MS);
    lease = (await leaseFor("bob"))!;
    const { max_attempts } = (await db.get(db.k.selectFrom("remote_calls").select("max_attempts").where("id", "=", id)))!;
    for (let i = 0; i < Number(max_attempts); i++) {
      assert.equal(await releaseCall(db, lease.secret, { reason: "setting up the files failed: could not fetch", setup: true }), true);
      assert.equal(await bobGets(), null, "not at once");
      await ago(SETUP_RETRY_MS + 1000);
      lease = (await leaseFor("bob"))!;
      assert.equal(lease.id, id);
    }
    assert.equal(await releaseCall(db, lease.secret, { reason: "setting up the files failed: could not fetch", setup: true }), true);
    await ago(SETUP_RETRY_MS + 1000);
    assert.equal(await bobGets(), null, "past the call's attempts a setup failure keeps the long skip");
    await ago(RELEASE_SKIP_MS);
    lease = (await leaseFor("bob"))!;
    await done(lease.secret, "after the retries");
    assert.equal((await ask)?.text, "after the retries");
  });

  test("a call given back because its helper is stopping is the same user's again at once and uses nothing; a give-back for another reason keeps the skip", async () => {
    const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
    let lease = (await leaseFor("bob"))!;
    const id = lease.id;
    const before = (await db.get(db.k.selectFrom("remote_calls").select(["attempt", "setup_retries", "released_by"]).where("id", "=", id)))!;
    assert.equal(await releaseCall(db, lease.secret, { reason: "stopped on the helper", stopped: true }), true);
    assert.deepEqual({ ...await db.get(db.k.selectFrom("remote_calls").select(["attempt", "setup_retries", "released_by"]).where("id", "=", id)) }, { ...before });
    const again = (await claimCall(db, callers.bob!, claim(), canWrite)).lease;
    assert.equal(again?.id, id, "the restarted runner takes it again");
    assert.equal(await releaseCall(db, again!.secret, { reason: "the provider refused the run for its usage limit" }), true);
    assert.equal((await claimCall(db, callers.bob!, claim(), canWrite)).lease, null, "an ordinary give-back keeps the skip");
    await db.run(db.k.updateTable("remote_calls").set((eb) => ({ released_at: eb("released_at", "-", RELEASE_SKIP_MS + 1000) })).where("id", "=", id));
    dropQueueCache(db);
    lease = (await leaseFor("bob"))!;
    await done(lease.secret, "after the restart");
    assert.equal((await ask)?.text, "after the restart");
  });

  test("an Opus review gets its task budget when a Task Runner whose Claude Code takes the flag leases it, and not from the queued call or for an older one", async () => {
    const REVIEW = JSON.stringify({ verdict: "take", summary: "s", why: "w", public: { summary: "ok", points: [] } });
    for (const [version, budget] of [["2.1.323", true], ["2.1", false]] as const) {
      const ask = askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
      const lease = (await leaseFor("bob", { harnessVersion: version }))!;
      const queued = (await db.get(db.k.selectFrom("remote_calls").select("bundle").orderBy("id", "desc").limit(1)))!;
      assert.equal(queued.bundle.includes("--task-budget"), false, "a server of an earlier version leasing the queued call hands on no flag");
      const args = (await bundleOf(db, lease.secret))!.hints.claude!.args;
      const i = args.indexOf("--task-budget");
      assert.equal(i >= 0 ? args[i + 1] : null, budget ? "80000" : null, `Claude Code ${version}`);
      await done(lease.secret, REVIEW);
      await ask;
    }
  });

  test("gating calls go first, the fast lane takes only gating and small calls, and Max calls at once stops new leases but lets a session finish", async () => {
    await db.run(db.k.updateTable("remote_calls").set({ state: "failed" }).where("state", "in", ["queued", "leased"]));
    const q = async (promptId: string, tier: "top" | "small", opts: { ageMs?: number; parentId?: number } = {}) => {
      const id = await enqueueCall(db, { promptId, promptVersion: "1", tier, effort: "medium", askedModel: tier === "top" ? "opus" : "haiku", items: [{ repo: "photocraft", number: 1287 }], level: 0, maxAttempts: 1, ...(opts.parentId !== undefined && { parentId: opts.parentId }),
        bundle: { promptId, promptVersion: "1", tier, effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: true, hints: {} } });
      if (opts.ageMs) await db.run(db.k.updateTable("remote_calls").set((eb) => ({ since: eb("since", "-", opts.ageMs!) })).where("id", "=", id));
      return id;
    };
    const both = (extra: Partial<Claim> = {}): Claim => ({ ...claim(), tiers: { top: "opus", small: "haiku" }, ...extra });
    const opus = await q("review.opus", "top", { ageMs: 10 * 60_000 });
    const lint = await q("lint.reference.haiku", "small");
    const small = await q("classify.haiku", "small");
    assert.equal((await claimCall(db, callers.bob!, both(), canWrite)).lease?.id, lint, "the lint check before the older Opus review");
    assert.equal((await claimCall(db, callers.bob!, both({ fastLane: true }), canWrite)).lease?.id, small, "the fast lane takes the small call, not the review");
    assert.deepEqual(await claimCall(db, callers.bob!, both({ fastLane: true }), canWrite), { lease: null, retryAfter: CLAIM_RETRY_S, reserve: { fiveHour: 35, weekly: 10 } }, "nothing else fits the fast lane");

    await assert.rejects(userSettings.setSettings(db, req("bob", "maintainer", { maxCalls: 0 })), /1 to 64/);
    await userSettings.setSettings(db, req("bob", "maintainer", { maxCalls: 2 }));
    assert.equal((await userSettings.settings(db, req("bob", "maintainer"))).maxCalls, 2);
    assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action = 'max-calls' AND login = 'bob'").get());
    const refused = await claimCall(db, callers.bob!, both(), canWrite);
    assert.equal(refused.lease, null);
    assert.match(("reason" in refused && refused.reason) || "", /limit of calls at once/, "two leases held: the review waits");
    const fix = await q("review.opus", "top", { parentId: lint });
    assert.equal((await claimCall(db, callers.bob!, both({ sessions: [lint] }), canWrite)).lease?.id, fix, "a follow-up of bob's own session, one past the limit");
    await q("review.opus", "top", { parentId: lint });
    assert.equal((await claimCall(db, callers.bob!, both({ sessions: [lint] }), canWrite)).lease, null, "but not two past it");
    await userSettings.setSettings(db, req("bob", "maintainer", { maxCalls: null }));
    assert.equal((await claimCall(db, callers.bob!, both(), canWrite)).lease?.id, opus, "no limit: the review");
    await db.run(db.k.updateTable("remote_calls").set({ state: "failed" }).where("state", "in", ["queued", "leased"]));
  });
  test("an interactive call takes only an interactive slot and a pipeline call never does", async () => {
    await db.run(db.k.updateTable("remote_calls").set({ state: "failed" }).where("state", "in", ["queued", "leased"]));
    const q = async (promptId: string) => enqueueCall(db, { promptId, promptVersion: "1", tier: "small", effort: "medium", askedModel: "haiku", items: [{ repo: "photocraft", number: 1287 }], level: 0, maxAttempts: 1,
      bundle: { promptId, promptVersion: "1", tier: "small", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: true, hints: {} } });
    const both = (extra: Partial<Claim> = {}): Claim => ({ ...claim(), tiers: { top: "opus", small: "haiku" }, ...extra });
    await db.run(db.k.insertInto("access").values({ login: "opera", role: "operator" }));
    const op: Caller = { tokenId: (await createToken(db, "opera", "helper", { kind: "runner" })).row.id, login: "opera", role: "operator" };
    await userSettings.setSettings(db, req("opera", "operator", { maxCalls: 1 }));
    await q("lint.reference.haiku");
    assert.ok((await claimCall(db, op, both(), canWrite)).lease, "the lint call fills the pipeline slots");
    const lint = await q("lint.reference.haiku");
    const search = await q("discord.issue-questions");
    assert.equal((await claimCall(db, op, both(), canWrite)).lease, null, "a pipeline claim never takes the Discord call");
    assert.equal((await claimCall(db, op, both({ interactiveLane: true }), canWrite)).lease?.id, search, "the interactive slot takes it with the pipeline slots full");
    const next = await q("discord.issue-questions");
    assert.equal((await claimCall(db, op, both({ interactiveLane: true }), canWrite)).lease, null, "one interactive slot, held");
    await userSettings.setSettings(db, req("opera", "operator", { interactiveSlots: 2 }));
    assert.equal((await claimCall(db, op, both({ interactiveLane: true }), canWrite)).lease?.id, next, "a second slot takes the next one");
    await userSettings.setSettings(db, req("opera", "operator", { maxCalls: null }));
    await db.run(db.k.updateTable("remote_calls").set({ state: "failed" }).where("state", "=", "queued"));
    const old = await q("discord.issue-questions");
    assert.equal((await claimCall(db, op, both({ helperVersion: "1.3.9" }), canWrite)).lease?.id, old, "a helper older than the lane is offered it in an ordinary claim");
    const other = await q("lint.reference.haiku");
    assert.equal((await claimCall(db, op, both({ interactiveLane: true }), canWrite)).lease, null, "the interactive slot never takes a pipeline call");
    assert.ok(other);
    await db.run(db.k.updateTable("remote_calls").set({ state: "failed" }).where("state", "in", ["queued", "leased"]));
  });
});
