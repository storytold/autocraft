import { test } from "node:test";
import assert from "node:assert/strict";
import { queryDb } from "../../src/db/query-db.ts";
import { claimJob, enqueueJobs, failQueued, listJobs, loadJobs, loadLiveJobs, loadRunnerTick, setPids } from "../../src/data/jobs/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { both, flat, seedJobs } from "./jobs-fixture.ts";

both("enqueueJobs refuses a queued duplicate and a repeat in the batch, and returns ids by input index", async (db) => {
  const a = await enqueueJobs(db, [
    { step: "review", params: { repo: "app" }, repo: "app", by: "pipeline" },
    { step: "review", params: { repo: "app" }, repo: "app", by: "pipeline" },
    { step: "review", params: { repo: "lib" }, repo: "lib", by: "pipeline" },
    { step: "sync", params: {}, repo: null, by: "me" },
  ]);
  assert.deepEqual([...a.queued.keys()].sort(), [0, 2, 3]);
  assert.deepEqual(a.refused, [1]);
  const rows = await loadJobs(db, [...a.queued.values()]);
  assert.equal(rows.get(a.queued.get(2)!)!.repo, "lib");
  assert.equal(rows.get(a.queued.get(3)!)!.repo, null);
  const b = await enqueueJobs(db, [{ step: "review", params: { repo: "app" }, repo: "app", by: "x" }, { step: "review", params: { repo: "new" }, repo: "new", by: "x" }]);
  assert.deepEqual(b.refused, [0]);
  assert.deepEqual([...b.queued.keys()], [1]);
  return { q: [...a.queued.keys()], r: a.refused, b: b.refused };
});

both("claimJob takes a queued job only when no running job does the same work or holds the cap or the mutex", async (db) => {
  const [run, same, other, nullRepo, sec1, sec2] = await seedJobs(db, [
    { step: "review", state: "running", repo: "app" }, { step: "review", repo: "app" }, { step: "review", repo: "lib" }, { step: "review", repo: null },
    { step: "security-fix", state: "running", repo: "app", params: { repo: "app", number: 1 } }, { step: "security-fix", repo: "app", params: { repo: "app", number: 2 } },
  ]);
  const c = (id: number, step: string, repo: string | null, o: { number?: number | null; cap?: number | null; mutexSteps?: string[] } = {}) =>
    claimJob(db, { id, step, repo, number: o.number ?? null, cap: o.cap ?? null, mutexSteps: o.mutexSteps ?? [], logPath: `/tmp/job-${id}.log` });
  const results = {
    sameRepo: await c(same!, "review", "app"),
    nullRepoBlocked: await c(nullRepo!, "review", null),
    capFull: await c(other!, "review", "lib", { cap: 1 }),
    mutex: await c(other!, "review", "lib", { mutexSteps: ["review"] }),
    otherFindingFree: await c(sec2!, "security-fix", "app", { number: 2 }),
    otherRepo: await c(other!, "review", "lib", { cap: 2 }),
  };
  assert.deepEqual(results, { sameRepo: false, nullRepoBlocked: false, capFull: false, mutex: false, otherFindingFree: true, otherRepo: true });
  assert.equal(await c(other!, "review", "lib"), false, "an already running job is not claimed twice");
  assert.equal((await loadJobs(db, [run!, other!])).get(other!)!.state, "running");
  return results;
});

both("setPids and failQueued write many rows in one statement each and leave a started job alone", async (db) => {
  const [a, b, c] = await seedJobs(db, [{ state: "running" }, { state: "queued" }, { state: "running" }]);
  assert.equal(await setPids(db, [{ id: a!, pid: 11 }, { id: c!, pid: 12 }]), 2);
  assert.equal(await failQueued(db, [{ id: b!, error: "no step" }, { id: c!, error: "not queued" }]), 1);
  const rows = await loadJobs(db, [a!, b!, c!]);
  assert.deepEqual([rows.get(a!)!.pid, rows.get(c!)!.pid, rows.get(b!)!.state, rows.get(b!)!.error, rows.get(c!)!.error], [11, 12, "failed", "no step", null]);
  return null;
});

both("listJobs pages and counts together, and loadLiveJobs lists queued and running jobs with the item number", async (db) => {
  await seedJobs(db, [{ state: "done" }, { state: "queued", params: { repo: "app", number: 7 }, repo: "app" }, { state: "running" }, { state: "failed" }]);
  const page = await listJobs(db, { state: "done", limit: 10, offset: 0 });
  assert.equal(page.total, 1);
  const live = await loadLiveJobs(db);
  assert.deepEqual(live.map((j) => [j.state, j.number]), [["queued", 7], ["running", null]]);
  return null;
});

test("the runner tick reads the same number of statements for 1 and 6 running jobs and 2 and 12 queued", async () => {
  await expectFlat(flat(async (db, size) => {
    await seedJobs(db, Array.from({ length: size }, (_, i) => ({ step: "review", state: "running", repo: `r${i}` })));
    const queued = await seedJobs(db, Array.from({ length: size * 2 }, (_, i) => ({ step: "verify", repo: `q${i}`, resumes: i % 2 })));
    const q = queryDb(db);
    await q.run(q.k.insertInto("job_log_chunks").values(queued.filter((_, i) => i % 2).map((id) => ({ job_id: id, seq: 1, start: 0, next_start: 4, chunk: "héé\n", at: "2026-01-01T00:00:00.000Z" }))));
    return async () => {
      const t = await loadRunnerTick(db, Date.now());
      assert.equal(t.running.length, size);
      assert.equal(t.queued.length, size * 2);
      assert.equal(t.logCursors.size, size);
      assert.deepEqual([...t.logCursors.values()][0], { lastSeq: 1, lastNextStart: 4, bytes: [6] });
    };
  }), 1, 6);
});

both("claimJob and jobBlock agree on generated running sets (same repo, finding, item lanes, null repo, cap, mutex)", async (db) => {
  const { jobBlock, wantOf } = await import("../../src/runner/concurrency.ts");
  const q = queryDb(db);
  const steps = new Map([["review", { exclusive: "x" }], ["verify", { exclusive: "x" }], ["security-fix", {}], ["merge", {}]]) as never;
  let seed = 7;
  const rnd = (n: number) => Math.floor((seed = (seed * 1103515245 + 12345) % 2147483648) / 65536) % n;
  const names = ["review", "verify", "security-fix", "merge"], repos = ["a", "b", null];
  const out: boolean[] = [];
  for (let round = 0; round < 120; round++) {
    await q.run(q.k.deleteFrom("jobs"));
    const cap = [null, 1, 2][rnd(3)]!;
    await q.run(q.k.deleteFrom("settings").where("key", "=", "step_parallel"));
    await q.run(q.k.insertInto("settings").values({ key: "step_parallel", value: cap === null ? "none" : String(cap) }));
    // A job of a per-item lane names its item; a job without a lane names one or none.
    const job = () => {
      const lane = [null, "approved", "item"][rnd(3)], repo = repos[rnd(3)]!, number = lane ? 1 + rnd(2) : [null, 1, 2][rnd(3)]!;
      return { step: names[rnd(4)]!, repo, number, lane, params: { ...(repo ? { repo } : {}), ...(number !== null ? { number } : {}), ...(lane ? { lane } : {}) } };
    };
    const running = Array.from({ length: rnd(4) }, () => ({ ...job(), state: "running" }));
    await seedJobs(db, running.map(({ step, state, repo, params }) => ({ step, state, repo, params })));
    const want = job();
    const [id] = await seedJobs(db, [{ step: want.step, repo: want.repo, params: want.params }]);
    const active = running.map((r, i) => ({ id: i + 1000, step: r.step, state: "running", repo: r.repo, number: r.number, params: JSON.stringify(r.params) }));
    const blocked = await jobBlock(db, steps, wantOf(want.step, want.params), { states: ["running"], mutex: true, active });
    const mutexSteps = names.filter((n) => (steps as Map<string, { exclusive?: string }>).get(n)?.exclusive && (steps as Map<string, { exclusive?: string }>).get(n)!.exclusive === (steps as Map<string, { exclusive?: string }>).get(want.step)?.exclusive);
    const claimed = await claimJob(db, { id: id!, step: want.step, repo: want.repo, number: want.number, lane: want.lane, cap, mutexSteps, logPath: "/tmp/x.log" });
    assert.equal(claimed, blocked === null, `round ${round}: ${JSON.stringify({ cap, running, want, blocked })}`);
    out.push(claimed);
  }
  assert.ok(out.includes(true) && out.includes(false), `the generated cases include both outcomes: ${out.join("")}`);
  return out;
});
