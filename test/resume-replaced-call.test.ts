// A resumed job whose input changed (its item list grew) asks a new call: the earlier run's call for the same prompt and items is
// withdrawn instead of staying queued for an adoption that never comes, and a queued job does not keep its earlier run's queued calls.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CALLER_GONE_MS, enqueueCall, expireLeases, RESUME_REPLACED, type NewCall } from "../src/data/runners/index.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a resumed run that asks again over a changed item list withdraws the earlier run's call", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "resume-replaced-")), "t.db"));
  const t0 = Date.now() - 20 * 60_000, t1 = t0 + 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const jobId = (await db.get(db.k.insertInto("jobs").values({ step: "classify-new", params: "{}", requested_by: "pipeline", requested_at: iso(t0), state: "running", started_at: iso(t0) }).returning("id")))!.id;
  const call = (numbers: number[], at: number) => {
    const c: NewCall = { promptId: "classify.haiku", promptVersion: "1", tier: "small", effort: "medium", askedModel: "haiku", items: numbers.map((number) => ({ repo: "deckcraft", number })), level: 0, maxAttempts: 1,
      job: { jobId, step: "classify-new", stage: 0, cls: 0, repo: "deckcraft" },
      bundle: { promptId: "classify.haiku", promptVersion: "1", tier: "small", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: `items ${numbers.join(",")}`, system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } };
    return enqueueCall(db, c, at);
  };
  const row = async (id: number) => (await db.get(db.k.selectFrom("remote_calls").select(["state", "error"]).where("id", "=", id)))!;

  const first = await call([1, 2], t0);
  // A restart: the job resumes, and the new run finds a third item.
  await db.run(db.k.updateTable("jobs").set({ resumes: 1, started_at: iso(t1) }).where("id", "=", jobId));
  const second = await call([1, 2, 3], t1);
  assert.notEqual(second, first, "other input is not adopted");
  assert.deepEqual({ ...(await row(first)) }, { state: "failed", error: RESUME_REPLACED });
  assert.equal((await row(second)).state, "queued");

  // Another restart; the job waits in the queue, and its call's caller is gone.
  await db.run(db.k.updateTable("jobs").set({ state: "queued", resumes: 2, started_at: null }).where("id", "=", jobId));
  await expireLeases(db, { now: t1 + CALLER_GONE_MS + 1000 });
  assert.equal((await row(second)).state, "failed", "a queued job does not keep its queued call alive");
  await db.close();
});
