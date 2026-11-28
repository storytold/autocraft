// A resumed job whose input changed (its item list grew) asks a new call: the earlier run's call over a subset of its items is withdrawn
// instead of staying queued for an adoption that never comes, while an unchanged call is adopted and one over other items too is left
// to end with the job. A queued job does not keep its earlier run's queued calls. Each run is a fresh process: its own copy of the module.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CALLER_GONE_MS, expireLeases, RESUME_REPLACED, type NewCall } from "../src/data/runners/index.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

type Queue = typeof import("../src/data/runners/calls-queue.ts");
const freshQueue = async (run: number): Promise<Queue> => await import(new URL(`../src/data/runners/calls-queue.ts?run=${run}`, import.meta.url).href) as Queue;

test("a resumed run withdraws the earlier call it replaces, adopts the unchanged one and leaves one over other items", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "resume-replaced-")), "t.db"));
  const t0 = Date.now() - 20 * 60_000, t1 = t0 + 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const jobId = (await db.get(db.k.insertInto("jobs").values({ step: "classify-new", params: "{}", requested_by: "pipeline", requested_at: iso(t0), state: "running", started_at: iso(t0) }).returning("id")))!.id;
  const call = (q: Queue, numbers: number[], at: number, text = numbers.join(",")) => {
    const c: NewCall = { promptId: "classify.haiku", promptVersion: "1", tier: "small", effort: "medium", askedModel: "haiku", items: numbers.map((number) => ({ repo: "deckcraft", number })), level: 0, maxAttempts: 1,
      job: { jobId, step: "classify-new", stage: 0, cls: 0, repo: "deckcraft" },
      bundle: { promptId: "classify.haiku", promptVersion: "1", tier: "small", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: `items ${text}`, system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } };
    return q.enqueueCall(db, c, at);
  };
  const row = async (id: number) => (await db.get(db.k.selectFrom("remote_calls").select(["state", "error"]).where("id", "=", id)))!;

  const run1 = await freshQueue(1);
  const grown = await call(run1, [1, 2], t0), same = await call(run1, [5], t0), wider = await call(run1, [2, 9], t0);
  // A restart: the job resumes, and the new run finds a third item for its first chunk.
  await db.run(db.k.updateTable("jobs").set({ resumes: 1, started_at: iso(t1) }).where("id", "=", jobId));
  const run2 = await freshQueue(2);
  const next = await call(run2, [1, 2, 3], t1);
  assert.notEqual(next, grown, "other input is not adopted");
  assert.deepEqual({ ...(await row(grown)) }, { state: "failed", error: RESUME_REPLACED });
  assert.equal((await row(wider)).state, "queued", "a call that names an item outside the new one is left for the job's end");
  assert.equal((await row(same)).state, "queued");
  assert.equal(await call(run2, [5], t1), same, "the unchanged call is adopted");

  // Another restart; the job waits in the queue, and its calls' caller is gone.
  await db.run(db.k.updateTable("jobs").set({ state: "queued", resumes: 2, started_at: null }).where("id", "=", jobId));
  await expireLeases(db, { now: t1 + CALLER_GONE_MS + 1000 });
  assert.equal((await row(next)).state, "failed", "a queued job does not keep its queued call alive");
  await db.close();
});
