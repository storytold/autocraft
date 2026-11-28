// A queued call whose only taker went away is withdrawn after NO_TAKER_MS; its caller skips the unit without a failure, and
// the remote-no-taker health check names the repo. A Manual only Task Runner is no taker for automatic work, only for the work it claims.
// An approver's Task Runner holds the work they approved while it reports, and stops holding it once silent past OWNER_GONE_MS.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pool } from "../src/classify/run.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { computeChecks } from "../src/health-checks.ts";
import { awaitCall, enqueueCall, withdrawCall } from "../src/remote/calls.ts";
import { parseStatus, STATUS_FRESH_MS, storeStatus } from "../src/remote/helpers.ts";
import { setManualOnly } from "../src/remote/manual-only.ts";
import { claimCall } from "../src/remote/calls.ts";
import { PROTOCOL_VERSION } from "../src/remote/protocol.ts";
import { OWNER_GONE_MS } from "../src/remote/started.ts";
import { NO_TAKER_MS, sweepTakers, takerTest } from "../src/remote/takers.ts";
import { leaseSkips } from "../src/runner/leases.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a call whose only taker went stale is withdrawn, its caller skips it, and the health check names the repo", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-no-taker-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "photocraft", pipeline: 1 }).onConflict((oc) => oc.column("name").doUpdateSet({ pipeline: 1 })));
  await db.run(db.k.insertInto("access").values({ login: "dave", role: "maintainer" }));
  await db.run(db.k.insertInto("repo_permissions").values({ login: "dave", repo: "photocraft", permission: "write", checked_at: new Date().toISOString() }));
  const t0 = Date.now();
  const token = (await createToken(db, "dave", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, token, "dave", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }), t0);
  const id = await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number: 7 }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } }, t0);
  // The caller keeps polling: its stamp follows the test clock.
  const sweep = async (at: number): Promise<number> => { await db.run(db.k.updateTable("remote_calls").set({ seen_at: at }).where("id", "=", id)); return await sweepTakers(db, at); };
  const noTaker = async (at: number) => (await computeChecks(db, at)).find((c) => c.id === "remote-no-taker")!;

  assert.equal(await sweep(t0), 0);
  assert.equal((await db.get(db.k.selectFrom("remote_calls").select("no_taker_since as s").where("id", "=", id)))!.s, null, "dave's runner takes it");

  // Dave's laptop sleeps: his status goes stale.
  const t1 = t0 + STATUS_FRESH_MS + 1000;
  assert.equal(await sweep(t1), 0);
  assert.equal((await noTaker(t1)).state, "ok", "not yet ten minutes");
  assert.equal(await sweep(t1 + NO_TAKER_MS - 1000), 0);
  const t2 = t1 + NO_TAKER_MS;
  assert.equal(await sweep(t2), 1);
  const row = (await db.get(db.k.selectFrom("remote_calls").select(["state", "error"]).where("id", "=", id)))!;
  assert.deepEqual({ ...row }, { state: "failed", error: "no Task Runner can take calls on photocraft" });
  const check = await noTaker(t2);
  assert.equal(check.state, "warn");
  assert.match(check.text, /photocraft/);

  // The pool unit that waits on the call is skipped: no failure, and the job counts a skipped item so the planner runs it again.
  const skips = leaseSkips();
  let after = false;
  await pool([async () => { await awaitCall(db, id, { log: () => {} }); after = true; }], 1);
  assert.equal(after, false);
  assert.equal(leaseSkips(), skips + 1);
});

test("a Manual only runner is no taker for an automatic call, which is withdrawn, but still takes the work its user started", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-no-taker-manual-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "deckcraft", pipeline: 1 }).onConflict((oc) => oc.column("name").doUpdateSet({ pipeline: 1 })));
  await db.run(db.k.insertInto("access").values({ login: "dave", role: "maintainer" }));
  await db.run(db.k.insertInto("repo_permissions").values({ login: "dave", repo: "deckcraft", permission: "write", checked_at: new Date().toISOString() }));
  const t0 = Date.now();
  const token = (await createToken(db, "dave", "helper", { kind: "runner" })).row.id;
  const ready = (at: number) => storeStatus(db, token, "dave", parseStatus({ slots: 2, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }), at);
  await ready(t0);
  await setManualOnly(db, "dave", true);
  const at = new Date(t0).toISOString();
  await db.run(db.k.insertInto("item_workflows").values({ repo: "deckcraft", number: 8, kind: "pr", entry: "merge", weight: 5, state: "running", started_by: "dave", approved_by: "dave", started_at: at, started_via: "github", plan: "[]", updated_at: at } as never));
  // On fontcraft dave's only work is a PR his workflow merged: its post-merge review is his, before its job knows the items.
  await db.run(db.k.insertInto("items").values({ repo: "fontcraft", number: 20, kind: "pr", state: "MERGED", title: "x", author: "dev", created_at: at }));
  await db.run(db.k.insertInto("item_workflows").values({ repo: "fontcraft", number: 20, kind: "pr", entry: "merge", weight: 5, state: "done", started_by: "dave", approved_by: "dave", started_at: at, started_via: "github", plan: "[]", updated_at: at } as never));
  const call = (number: number) => enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "deckcraft", number }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } }, t0);
  const auto = await call(7), started = await call(8);
  const sweep = async (when: number): Promise<number> => { await db.run(db.k.updateTable("remote_calls").set({ seen_at: when }).where("id", "in", [auto, started])); return await sweepTakers(db, when); };
  const row = async (id: number) => (await db.get(db.k.selectFrom("remote_calls").select(["state", "error", "no_taker_since"]).where("id", "=", id)))!;

  assert.equal(await sweep(t0), 0);
  assert.notEqual((await row(auto)).no_taker_since, null, "the automatic call has no taker");
  assert.equal((await row(started)).no_taker_since, null, "dave's own work has his runner");

  const t1 = t0 + NO_TAKER_MS;
  await ready(t1);
  assert.equal(await sweep(t1), 1);
  const gone = await row(auto);
  assert.equal(gone.state, "failed");
  assert.match(gone.error ?? "", /^no Task Runner can take calls on deckcraft.*Manual only/);
  assert.equal((await row(started)).state, "queued");

  const claim = await claimCall(db, { tokenId: token, login: "dave", role: "maintainer" },
    { requestId: "manual-claim-1", protocol: PROTOCOL_VERSION, helperVersion: "9.9.9", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } }, async () => true, t1);
  assert.equal(claim.lease?.id, started);

  const takes = takerTest(db, t1);
  assert.ok(await takes({ prompt_id: "postmerge.opus", repos: ["fontcraft"], step: "postmerge" }), "a post-merge job of his merged PR has his runner");
  assert.equal(await takes({ prompt_id: "review.opus", repos: ["fontcraft"], step: "opus-review" }), false, "an automatic review there has none");
  await db.close();
});

test("approved work goes to the approver's runner first while it reports, and to any runner that allows it once that runner is silent", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-no-taker-approved-")), "t.db"));
  for (const login of ["dave", "erin"]) {
    await db.run(db.k.insertInto("access").values({ login, role: "maintainer" }));
    await db.run(db.k.insertInto("repo_permissions").values({ login, repo: "photocraft", permission: "write", checked_at: new Date().toISOString() }));
  }
  const t0 = Date.now();
  const tokens = { dave: (await createToken(db, "dave", "helper", { kind: "runner" })).row.id, erin: (await createToken(db, "erin", "helper", { kind: "runner" })).row.id };
  const ready = (login: "dave" | "erin", at: number) => storeStatus(db, tokens[login], login, parseStatus({ slots: 2, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }), at);
  await ready("dave", t0);
  await ready("erin", t0);
  // Dave's own settings take no automatic work: his approval alone sends the calls to his runner.
  await setManualOnly(db, "dave", true);
  const at = new Date(t0).toISOString();
  for (const number of [8, 9]) await db.run(db.k.insertInto("item_workflows").values({ repo: "photocraft", number, kind: "pr", entry: "merge", weight: 5, state: "running", started_by: "dave", approved_by: "dave", started_at: at, started_via: "github", plan: "[]", updated_at: at } as never));
  const call = (number: number) => enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } }, t0);
  const first = await call(8), second = await call(9);
  let n = 0;
  const claim = async (login: "dave" | "erin", when: number) => (await claimCall(db, { tokenId: tokens[login], login, role: "maintainer" },
    { requestId: `approved-claim-${++n}`, protocol: PROTOCOL_VERSION, helperVersion: "9.9.9", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } }, async () => true, when)).lease?.id ?? null;
  const sweep = async (when: number): Promise<number> => { await db.run(db.k.updateTable("remote_calls").set({ seen_at: when }).where("id", "=", second)); return await sweepTakers(db, when); };
  const marked = async () => (await db.get(db.k.selectFrom("remote_calls").select("no_taker_since as s").where("id", "=", second)))!.s !== null;

  assert.equal(await claim("erin", t0), null, "erin's runner passes dave's work over while his runner can take it");
  assert.equal(await claim("dave", t0), first);
  await withdrawCall(db, first, "test", ["leased"], t0);

  // Neither runner reports any more. Dave's runner still holds his work for a while, so the call waits for it.
  const t1 = t0 + STATUS_FRESH_MS + 1000;
  await sweep(t1);
  assert.equal(await marked(), false, "a runner that reported lately still holds its approver's work");
  // Silent past OWNER_GONE_MS, it holds nothing: with no other taker the call is marked for the no-taker withdrawal.
  const t2 = t0 + OWNER_GONE_MS + 1000;
  await sweep(t2);
  assert.equal(await marked(), true, "a silent approver's runner holds nothing");
  // Erin's runner comes back and may take photocraft: it takes the call.
  await ready("erin", t2);
  assert.equal(await claim("erin", t2), second);
  await db.close();
});
