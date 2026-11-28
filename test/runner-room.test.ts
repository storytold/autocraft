import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runnerRoomIn, stallNotices } from "../src/core/runner-room.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { loadConversationsOfItem, loadMessages } from "../src/data/chat/index.ts";
import type { RunnerRow, RunnerSnapshot, UserSettings } from "../src/data/runners/index.ts";
import { startWorkflows } from "../src/data/workflow/index.ts";
import { enqueueCall } from "../src/remote/calls.ts";
import { parseStatus, STATUS_FRESH_MS, storeStatus } from "../src/remote/helpers.ts";
import { STARTED_HOLD_MS } from "../src/remote/started.ts";
import { sweepTakers } from "../src/remote/takers.ts";
import type { RemoteView } from "../src/remote/view.ts";
import { RULE_STARTER } from "../src/workflow/types.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { tmpdir } from "./world-db.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const LATER = "2026-06-01T15:00:00.000Z", SOONER = "2026-06-01T13:00:00.000Z";
const ACCEPTED = { top: ["opus"], mid: ["sonnet"], small: ["haiku"] };

const row = (tokenId: number, login: string, o: Partial<RunnerRow> = {}): RunnerRow => ({
  tokenId, login, role: "maintainer", label: null, machine: null, helperVersion: null, createdAt: "", expiresAt: "", canAgent: true, canAnswer: false,
  readiness: "ready", until: null, reason: null, harness: null, models: { top: "claude-opus-5", mid: "claude-sonnet-5" }, reserve: null, usage: null, reportedAt: NOW - 1000, slots: 2, busy: 0,
  lastError: null, idleClaimAt: NOW - 1000, idleTiers: null, idleRepos: null, leased: 0, ownLaneLeased: 0, beatAt: null, ...o,
});
const view = (runners: RunnerRow[], settings: Record<string, Partial<UserSettings>> = {}): RemoteView => ({
  now: NOW, accepted: ACCEPTED, snapshot: {
    at: NOW, runners, cooled: new Map(), denied: new Set(), leasedByLogin: new Map(), started: { live: [], prs: [], merged: [], mainfix: [] },
    settings: new Map(Object.entries(settings).map(([l, s]) => [l as never, { reserve: { fiveHour: 20, weekly: 20 }, repos: [], maxCalls: null, interactiveSlots: null, manualOnly: false, skipTasks: [], taskItems: "all", runnerPrivate: false, ...s }])),
  } satisfies RunnerSnapshot,
});

test("a person's command finds whether a Task Runner can take its repo and tier now, and why not", () => {
  const ask = { repo: "app", login: "mira", tier: "top" as const };
  // A ready runner picked other repos and another is Manual only: the ready ones exclude the repo. With none ready at all, none is.
  assert.deepEqual(runnerRoomIn(view([row(1, "ana", { idleRepos: ["other"] }), row(2, "bo")], { bo: { manualOnly: true } }), ask), { can: false, own: false, why: "repo", until: null });
  assert.deepEqual(runnerRoomIn(view([row(1, "ana", { reportedAt: NOW - 3_600_000 })]), ask), { can: false, own: false, why: "none", until: null });

  // Every runner that takes it is held by its usage limit: the earliest end is when it can start.
  const held = view([row(1, "ana", { readiness: "quota-held", until: LATER }), row(2, "cy", { readiness: "quota-held", until: SOONER })]);
  assert.deepEqual(runnerRoomIn(held, ask), { can: false, own: false, why: "held", until: SOONER });

  // The person's own runner is the only one, held; Manual only does not keep it from their own work.
  assert.deepEqual(runnerRoomIn(view([row(3, "Mira", { readiness: "quota-held", until: LATER })], { mira: { manualOnly: true } }), ask), { can: false, own: true, why: "own-held", until: LATER });

  // A ready runner takes the repo but offers no model of the call's tier.
  assert.deepEqual(runnerRoomIn(view([row(1, "ana", { models: { mid: "claude-sonnet-5" } })]), ask), { can: false, own: false, why: "tier", until: null, tier: "top" });

  // A runner whose user takes only the items they started or approved never takes this person's work.
  assert.deepEqual(runnerRoomIn(view([row(1, "ana")], { ana: { taskItems: "mine" } }), ask), { can: false, own: false, why: "repo", until: null });
  // The person's ready runner may not write to the repo; an offline one says so.
  const denied = view([row(3, "mira")]);
  (denied.snapshot.denied as Set<string>).add("mira\napp");
  assert.deepEqual(runnerRoomIn(denied, ask), { can: false, own: true, why: "own-denied", until: null });
  assert.deepEqual(runnerRoomIn(view([row(3, "mira", { reportedAt: NOW - 3_600_000 })]), ask), { can: false, own: true, why: "own-off", until: null });

  // An implementation runs only on the person's own runner: someone else's ready runner does not help.
  const implement = { ...ask, bound: true as const, promptId: "implement.session" };
  assert.deepEqual(runnerRoomIn(view([row(1, "ana"), row(3, "mira", { reportedAt: NOW - 3_600_000 })]), implement), { can: false, own: true, why: "own-off", until: null });
  assert.deepEqual(runnerRoomIn(view([row(1, "ana")]), implement), { can: false, own: false, why: "own-none", until: null });

  // Someone else's ready runner takes it, though the person has none of their own; their own takes it outside their My repos.
  assert.deepEqual(runnerRoomIn(view([row(1, "ana")]), ask), { can: true, own: false });
  assert.deepEqual(runnerRoomIn(view([row(3, "mira", { idleRepos: ["other"] })], { mira: { repos: ["other"] } }), ask), { can: true, own: true });
});

test("the sweep tells the person whose started work waits for their offline or held runner once per reason in the item's chat, and nobody for the automatic rule's work", async () => {
  const db = await connectDb(join(tmpdir("runner-room"), "t.db"));
  try {
    await db.run(db.k.insertInto("access").values({ login: "mira", role: "maintainer" }));
    await db.run(db.k.insertInto("repo_permissions").values({ login: "mira", repo: "photocraft", permission: "write", checked_at: new Date().toISOString() }));
    const t0 = Date.now();
    const token = (await createToken(db, "mira", "helper", { kind: "runner" })).row.id;
    const report = (readiness: string, at: number, until?: string) =>
      storeStatus(db, token, "mira", parseStatus({ slots: 1, busy: 0, readiness, ...(until && { until }), harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }), at);
    await report("ready", t0);
    await startWorkflows(db, [
      { repo: "photocraft", number: 7, kind: "pr", entry: "review", weight: 5, startedBy: "mira", startedVia: "discord", approvedBy: "olu", approvedVia: "github" },
      { repo: "photocraft", number: 9, kind: "issue", entry: "implement", weight: 5, startedBy: "mira", startedVia: "discord" },
      { repo: "photocraft", number: 8, kind: "pr", entry: "merge", weight: 5, startedBy: RULE_STARTER, startedVia: "github" },
    ]);
    const enqueue = (number: number, promptId = "review.opus", forLogin?: string) => enqueueCall(db, { promptId, promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number }], level: 0, maxAttempts: 1, ...(forLogin && { forLogin }),
      bundle: { promptId, promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } }, t0);
    // An implementation's call is bound to the person who started it.
    const ids = [await enqueue(7), await enqueue(8), await enqueue(9, "implement.session", "mira")];
    const sweep = async (at: number) => {
      await db.run(db.k.updateTable("remote_calls").set({ seen_at: at }).where("id", "in", ids));
      await sweepTakers(db, at, { stalled: async (v, calls) => { await stallNotices(db, v, calls); } });
    };
    const notices = async (number: number) => {
      const convs = await loadConversationsOfItem(db, "photocraft", number);
      return [...(await loadMessages(db, convs.map((c) => c.id))).values()].flat().filter((m) => m.kind === "notice").map((m) => m.body);
    };

    // Within the hold the work waits for mira's runner without a word.
    await sweep(t0 + 1000);
    assert.deepEqual([...await notices(7), ...await notices(9)], []);
    // Past the hold her runner has gone quiet: one notice about her runner, though the approver has none, naming her role, and not again
    // on the next pass. The implementation bound to her says the same.
    const t1 = t0 + STARTED_HOLD_MS + STATUS_FRESH_MS + 1000;
    await sweep(t1);
    await sweep(t1 + 60_000);
    assert.deepEqual(await notices(7), ["No Task Runner can take this right now (the starter's Task Runner is not connected). It starts when one is free."]);
    assert.deepEqual(await notices(8), [], "the automatic rule's work tells nobody");
    assert.deepEqual(await notices(9), ["No Task Runner can take this right now (the starter's Task Runner is not connected). It starts when one is free."]);
    // It comes back held by its usage limit: a different reason, one more notice.
    await report("quota-held", t1 + 120_000, new Date(t1 + 3_600_000).toISOString());
    await sweep(t1 + 120_000);
    const after = await notices(7);
    assert.equal(after.length, 2);
    assert.match(after[1]!, /the starter's Task Runner is held by its usage limit/);
  } finally {
    await db.close();
  }
});
