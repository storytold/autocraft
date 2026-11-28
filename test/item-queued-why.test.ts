// The item page's line for queued work says what holds it back, from the rules the runner and the claims use, and names a
// person's Task Runner only to operators and maintainers, as the item's state line does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { dropQueueCache } from "../src/data/runners/calls-shared.ts";
import { dropSnapshotCache } from "../src/data/runners/index.ts";
import { enqueueCall } from "../src/remote/calls.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { enqueue } from "../src/runner/jobs.ts";
import { queuedOfItems } from "../src/runner/why-queued.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { legWait } from "../src/workflow/waits.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("queued work about an item: no taker gives the no-taker line, work held for its starter's runner names that runner to staff only", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "item-queued-why-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 } as never));
  await db.run(db.k.insertInto("access").values({ login: "mira", role: "maintainer" }));
  await db.run(db.k.insertInto("settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  const at = new Date().toISOString();
  await db.run(db.k.insertInto("item_workflows").values({ repo: "app", number: 5, kind: "pr", entry: "review", weight: 5, state: "running", started_by: "mira", started_at: at, started_via: "github", plan: "[]", updated_at: at } as never));
  // Its plan's next action is a fix-up, a model step: the item's state line says what that waits for.
  await db.run(db.k.insertInto("item_plans").values({ repo: "app", number: 5, kind: "pr", head: "h1", state: "fixup", actions: JSON.stringify([{ kind: "fixup", head: "h1" }]), reasons: "[]", view: "{}", planned_at: at } as never));
  await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "app", number: 5 }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } });
  const job = await enqueue(db, "opus-review", { repo: "app", number: 5, lane: "approved", limit: 1 }, "mira");
  const why = async (shown: boolean) => {
    dropQueueCache(db);
    dropSnapshotCache(db);
    const list = (await queuedOfItems(db, [{ repo: "app", number: 5 }], { shown })).get("app#5")!;
    return { call: list.find((w) => w.kind === "call")?.why, job: list.find((w) => w.kind === "job" && w.id === job.id)?.why };
  };

  // Nobody has a Task Runner.
  const none = await why(true);
  assert.match(none.call ?? "", /^No Task Runner/);
  assert.equal(none.job, "No Task Runner takes app");

  // Mira started the item; her runner is held by its usage limit, so the call waits for her runner alone.
  const token = (await createToken(db, "mira", "runner", { kind: "runner" })).row.id;
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await storeStatus(db, token, "mira", parseStatus({ slots: 1, busy: 0, readiness: "quota-held", until, harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  assert.equal((await why(true)).call, `Waiting for mira's Task Runner (usage limit until ${until.slice(11, 16)} UTC)`);
  assert.equal((await why(false)).call, "Waiting for the starter's Task Runner", "a viewer reads no login or quota");
  const wf = (await liveWorkflow(db, "app", 5))!;
  assert.equal(await legWait(db, wf, Date.now(), { shown: true }), "Waiting for mira's Task Runner (usage limit)");
  assert.equal(await legWait(db, wf, Date.now(), { shown: false }), "Waiting for the starter's Task Runner", "the item's state line names no account to a viewer");

  // Her runner is ready: other runners pass the call over for her.
  await storeStatus(db, token, "mira", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  assert.match((await why(true)).call ?? "", /^Held for mira's Task Runner/);
  assert.equal((await why(false)).call, "Waiting for a Task Runner");
});
