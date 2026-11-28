// The runner on fake steps: it runs queued jobs in child processes, records
// success, failure and usage, honours cancels, recovers jobs an earlier runner
// left running, runs one job per step and repo at a time.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { rowid } from "../src/db/kx.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { enqueue, getJob, jobDetail, requestCancel } = await import("../src/runner/jobs.ts");
const { computeChecks } = await import("../src/health-checks.ts");
const { DEFAULT_MAX_JOBS, Runner } = await import("../src/runner/runner.ts");
const { STEPS } = await import("../src/runner/steps.ts");
const { FAKE_TOKEN } = await import("./runner-steps.ts");
const { inputHash } = await import("../src/runner/classify.ts");
const { RUNNER_STOPPED, endJob } = await import("../src/runner/jobs.ts");
const { createToken } = await import("../src/dash/mcp/tokens.ts");
const { claimCall, submitCall } = await import("../src/remote/calls.ts");
const { PROTOCOL_VERSION } = await import("../src/remote/protocol.ts");
const { setCallContext } = await import("../src/agents/call.ts");
const { ghComment, resumeWritesForTests, stopWrites } = await import("../src/github/write.ts");
type GuardedItem = import("../src/core/guard.ts").GuardedItem;

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "runner-test-"));
const dbFile = join(dir, "runner.db");
const db = await connectDb(dbFile);
await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }).onConflict((oc) => oc.doNothing()));
await db.run(db.k.updateTable("tracked_repos").set({ pipeline: 1 }));
const runner = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} });

after(async () => {
  await runner.stop();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(cond: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await runner.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
}

const state = async (id: number) => (await getJob(db, id)).state;

describe("runner", () => {
  test("runs a queued job and records its summary, usage and a scrubbed log; a failing job is failed", async () => {
    const ok = await enqueue(db, "test-echo", { n: 7 }, "boss");
    const bad = await enqueue(db, "test-echo", { mode: "fail" }, "boss");
    await until(async () => await state(ok.id) === "done" && await state(bad.id) === "failed");
    const j = await jobDetail(db, ok.id);
    assert.equal(j.summary, "echo 7");
    assert.deepEqual(j.usage, { calls: 1, input: 100, output: 10, costUsd: 0.01 });
    assert.ok(j.startedAt && j.endedAt);
    assert.ok(j.log!.includes("token in the log: [hidden]"), j.log!);
    assert.ok(!j.log!.includes(FAKE_TOKEN));
    assert.equal((await getJob(db, bad.id)).error, "echo failed on purpose");
    // The runner stored the log too: without the file (another disk) the job page shows the same scrubbed text.
    await until(async () => !!await db.get(db.k.selectFrom("job_log_chunks").select("seq").where("job_id", "=", ok.id)));
    rmSync((await db.get(db.k.selectFrom("jobs").select("log_path").where("id", "=", ok.id)))!.log_path!);
    const stored = (await jobDetail(db, ok.id)).log!;
    assert.ok(stored.includes("token in the log: [hidden]") && !stored.includes(FAKE_TOKEN), stored);
  });

  test("with AUTOCRAFT_DB_URL set, a job process opens that Postgres database, not a SQLite file", async () => {
    // A stand-in server that records the startup packet a Postgres client sends first (it names the database), then hangs up.
    const seen: Buffer[] = [];
    const server = createServer((s) => s.on("data", (b: Buffer) => { seen.push(b); s.destroy(); }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const saved = { url: process.env.AUTOCRAFT_DB_URL, db: process.env.AUTOCRAFT_DB };
    const pgDir = mkdtempSync(join(dir, "pg-"));
    const pgDb = await connectDb(join(pgDir, "jobs.db"));
    process.env.AUTOCRAFT_DB_URL = `postgres://autocraft@127.0.0.1:${port}/childjob`;
    delete process.env.AUTOCRAFT_DB;
    const pgRunner = new Runner({ db: pgDb, logs: join(pgDir, "logs"), killAfterMs: 2000, log: () => {}, detect: async () => ({ proposals: [], logs: [] }) });
    try {
      const job = await enqueue(pgDb, "test-echo", { n: 1 }, "boss");
      const end = Date.now() + 60_000;
      while (!Buffer.concat(seen).includes("database\0childjob\0")) {
        if (Date.now() > end) throw new Error(`the job process did not connect; job ${job.id} is ${(await getJob(pgDb, job.id)).state}`);
        await pgRunner.tick();
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await pgRunner.stop();
      await pgDb.close();
      await new Promise((r) => server.close(r));
      for (const [k, v] of [["AUTOCRAFT_DB_URL", saved.url], ["AUTOCRAFT_DB", saved.db]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("a job stopped by a runner stop resumes under the same id and reads the reply its Task Runner sent meanwhile", async () => {
    await db.run(db.k.insertInto("access").values({ login: "bob", role: "maintainer" }));
    const bob = { tokenId: (await createToken(db, "bob", "helper", { kind: "runner" })).row.id, login: "bob", role: "maintainer" as const };
    const opts = { db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} };
    const first = new Runner(opts);
    const job = await enqueue(db, "test-remote", {}, "boss");
    const callOf = async () => await db.all(db.k.selectFrom("remote_calls").select(["id", "state", "run_id"]).where("job_id", "=", job.id));
    let lease = null;
    for (let i = 0; i < 400 && !lease; i++) {
      await first.tick();
      if ((await callOf()).length) lease = (await claimCall(db, bob, { requestId: `resume-${i}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } }, async () => true)).lease;
      if (!lease) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(lease, "the job's call was leased");
    await first.stop();
    const stopped = await getJob(db, job.id);
    assert.equal(stopped.state, "queued", "the stop queued the job to resume");
    assert.equal((await callOf())[0]!.state, "leased", "the call stays with its Task Runner");
    // The Task Runner answers while no runner runs the job.
    assert.deepEqual(await submitCall(db, lease.secret, { ok: true, text: "the review", model: "claude-opus-4-5", usage: { inputTokens: 10, outputTokens: 2 } }), { accepted: true });

    const second = new Runner(opts);
    try {
      await second.recover();
      for (let i = 0; i < 400 && !["done", "failed"].includes(await state(job.id)); i++) {
        await second.tick();
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await second.stop();
    }
    const j = await jobDetail(db, job.id);
    assert.equal(j.state, "done", j.error ?? j.log ?? "");
    assert.equal(j.summary, "reply: the review");
    const calls = await callOf();
    assert.equal(calls.length, 1, "the resumed run adopted the call instead of asking again");
    assert.equal((await db.get(db.k.selectFrom("agent_runs").select("state").where("id", "=", calls[0]!.run_id!)))!.state, "done");
    assert.ok(j.log!.includes("queued to resume after the restart (resume 1)"), j.log!);

    // A job left running by a runner that is gone resumes too, until it has crash-resumed twice.
    const left = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "boss", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString(), resumes: 1, crash_resumes: 1 }).returning("id")))!.id);
    await second.recover();
    assert.equal((await getJob(db, left)).state, "queued");
    await db.run(db.k.updateTable("jobs").set({ state: "running" }).where("id", "=", left));
    await second.recover();
    assert.equal((await getJob(db, left)).error, RUNNER_STOPPED);
    // A command-line run is not resumed: its process belongs to the command, which may still be running it.
    const cli = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "cli", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString() }).returning("id")))!.id);
    await second.recover();
    assert.equal((await getJob(db, cli)).state, "failed");
  });

  test("graceful stops (deploys) resume a job well past the crash limit, which only unclean stops count against", async () => {
    const id = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "boss", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString() }).returning("id")))!.id);
    for (let i = 0; i < 3; i++) {
      assert.equal((await endJob(db, id, 143, null, null, true))?.state, "queued");
      await db.run(db.k.updateTable("jobs").set({ state: "running" }).where("id", "=", id));
    }
    const j = (await db.get(db.k.selectFrom("jobs").select(["resumes", "crash_resumes"]).where("id", "=", id)))!;
    assert.equal(j.resumes, 3);
    assert.equal(j.crash_resumes, 0);
    await db.run(db.k.updateTable("jobs").set({ crash_resumes: 2 }).where("id", "=", id));
    assert.equal((await endJob(db, id, 143, null, null, true))?.state, "queued", "a graceful stop ignores crash resumes");
    await db.run(db.k.updateTable("jobs").set({ state: "running" }).where("id", "=", id));
    await new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} }).recover();
    assert.equal((await getJob(db, id)).error, RUNNER_STOPPED);
  });

  test("a graceful stop resumes a job at the resume cap that only waits for a Task Runner to take its queued call, and fails one whose call runs", async () => {
    const mk = async (callState: string) => {
      const id = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "boss", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString(), resumes: 12 }).returning("id")))!.id);
      await db.run(db.k.insertInto("remote_calls").values({ job_id: id, step: "fixup", stage: 7, prompt_id: "fixup.patch", prompt_version: "v", tier: "top", effort: "high", asked_model: "opus", bundle: "{}", state: callState, items: "[]", repo: "app", since: 1, seen_at: 1, queued_since: 1, max_attempts: 2, timeout_ms: 1_200_000 }));
      return id;
    };
    const waiting = await mk("queued"), running = await mk("leased");
    assert.equal((await endJob(db, waiting, 143, null, null, true))?.state, "queued");
    assert.equal((await db.get(db.k.selectFrom("jobs").select("resumes").where("id", "=", waiting)))!.resumes, 13);
    assert.equal((await endJob(db, running, 143, null, null, true))?.state, "failed");
    assert.equal((await getJob(db, running)).error, RUNNER_STOPPED);
  });

  test("a runner stop while a step writes lets the write finish, and the write it refuses is no failed item: the job resumes", async () => {
    const stopper = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 5000, log: () => {} });
    const job = await enqueue(db, "test-writes", { n: 5 }, "boss");
    const states = async () => (await db.all(db.k.selectFrom("audit").select("details").orderBy(rowid("audit")))).map((r) => JSON.parse(r.details || "{}") as { jobId?: number; state?: string }).filter((d) => d.jobId === job.id).map((d) => d.state!);
    for (let i = 0; i < 400 && !(await states()).includes("started"); i++) {
      await stopper.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok((await states()).includes("started"), "a comment is being written");
    await stopper.stop();
    const j = await jobDetail(db, job.id);
    assert.equal(j.state, "queued", j.log ?? "");
    assert.ok(!j.log!.includes("failed:"), j.log!);
    const written = await states();
    assert.ok(written.length >= 1 && written.every((s) => s === "done"), `the write in flight finished and was recorded: ${written.join(", ")}`);
    await requestCancel(db, job.id, "boss");
  });

  test("a job stopped by its runner keeps the items and counts it held in memory", async () => {
    const stopper = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 5000, log: () => {} });
    const job = await enqueue(db, "test-notes", {}, "boss");
    const noted = async () => { try { return readFileSync(join(dir, "logs", `job-${job.id}.log`), "utf8").includes("handled before the stop"); } catch { return false; } };
    for (let i = 0; i < 1000 && !await noted(); i++) {
      await stopper.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(await noted(), "the step noted its item");
    await stopper.stop();
    const row = (await db.get(db.k.selectFrom("jobs").select(["state", "items", "acted"]).where("id", "=", job.id)))!;
    assert.deepEqual({ ...row }, { state: "queued", items: 3, acted: 2 });
    assert.deepEqual((await db.all(db.k.selectFrom("job_items").select(["repo", "number", "outcome"]).where("job_id", "=", job.id))).map((r) => ({ ...r })), [{ repo: "app", number: 3, outcome: "handled before the stop" }]);
    await requestCancel(db, job.id, "boss");
  });

  test("a read of the tick that keeps failing stops neither cancels nor the recording of ends, and the health check shows it", async (t) => {
    const lines: string[] = [];
    const r = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: (l) => lines.push(l), detect: async () => ({ proposals: [], logs: [] }) });
    const job = await enqueue(db, "test-sleep", { ms: 600_000 }, "boss");
    const tickUntil = async (cond: () => Promise<boolean>) => {
      for (let i = 0; i < 600 && !await cond(); i++) {
        await r.tick();
        await new Promise((ok) => setTimeout(ok, 30));
      }
      assert.ok(await cond());
    };
    await tickUntil(async () => await state(job.id) === "running");
    const check = async () => (await computeChecks(db, Date.now() + 90_000)).find((c) => c.id === "runner")!;
    await r.tick();
    assert.equal((await check()).state, "ok");
    // A job whose end could not be recorded when its process exited.
    const left = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-other", params: "{}", requested_by: "boss", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString() }).returning("id")))!.id);
    (r as unknown as { unrecorded: Map<number, object> }).unrecorded.set(left, { code: 0, signal: null, spawnError: null });
    const broken = t.mock.method(db, "seqs", async () => { throw new Error("no such column"); });
    try {
      await requestCancel(db, job.id, "boss");
      await tickUntil(async () => await state(job.id) === "cancelled" && await state(left) === "done");
      await r.tick();
      assert.ok(lines.some((l) => l.includes("no such column")), lines.join("\n"));
      const bad = await check();
      assert.equal(bad.state, "fail");
      assert.match(bad.text, /no such column/);
      assert.doesNotMatch(bad.brief, /no such column/, "viewers do not read the error");
    } finally {
      broken.mock.restore();
    }
    await r.tick();
    await r.tick();
    assert.equal((await check()).state, "ok");
    await r.stop();
  });

  test("a part that fails each time it runs shows although the passes between did not run it, until it runs through", async (t) => {
    const lines: string[] = [];
    let detect: () => Promise<{ proposals: []; logs: [] }> = async () => ({ proposals: [], logs: [] });
    const r = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: (l) => lines.push(l), detect: () => detect() });
    const check = async () => (await computeChecks(db, Date.now() + 90_000)).find((c) => c.id === "runner")!;
    const webhooksDue = () => { (r as unknown as { webhookAt: number }).webhookAt = 0; };
    const planAgain = () => db.run(db.k.deleteFrom("lane_state").where("kind", "=", "mark").where("step", "=", "planned_at"));
    const pass = async () => { await r.tick(); await new Promise((ok) => setTimeout(ok, 20)); };
    await pass();
    const broken = t.mock.method(r as unknown as { webhookWork: () => Promise<unknown> }, "webhookWork", async () => { throw new Error("no webhook reads"); });
    webhooksDue();
    for (let i = 0; i < 3; i++) await pass();
    const { since } = await check();
    assert.ok(since);
    webhooksDue();
    for (let i = 0; i < 3; i++) await pass();
    const bad = await check();
    assert.deepEqual([bad.state, bad.since], ["warn", since]);
    assert.match(bad.text, /no webhook reads/);
    broken.mock.restore();
    webhooksDue();
    await pass();
    await pass();
    assert.equal((await check()).state, "ok");

    detect = async () => { throw new Error("no plan"); };
    await planAgain();
    await pass();
    await pass();
    assert.match((await check()).text, /no plan/);
    detect = async () => ({ proposals: [], logs: [] });
    await planAgain();
    await pass();
    await pass();
    assert.equal((await check()).state, "ok");
    await r.stop();
  });

  test("a planner pass that failed once runs again by itself and shows no lasting failure", async () => {
    let failures = 0;
    const r = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {}, detect: async () => {
      if (failures > 0) { failures--; throw new Error("no plan"); }
      return { proposals: [], logs: [] };
    } });
    const pass = async () => { await r.tick(); await new Promise((ok) => setTimeout(ok, 20)); };
    for (let i = 0; i < 3; i++) await pass();
    failures = 1;
    await db.run(db.k.deleteFrom("lane_state").where("kind", "=", "mark").where("step", "=", "planned_at"));
    for (let i = 0; i < 4; i++) await pass();
    assert.equal(failures, 0);
    assert.equal((await computeChecks(db, Date.now() + 90_000)).find((c) => c.id === "runner")!.state, "ok");
    await r.stop();
  });

  test("a workflow pass that throws runs again on the next tick, and the merge legs wait for it", async (t) => {
    const lines: string[] = [];
    const r = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: (l) => lines.push(l), detect: async () => ({ proposals: [], logs: [] }) });
    await r.tick();
    await r.tick();
    (r as unknown as { preapprovalMark: null }).preapprovalMark = null;
    const all = db.all.bind(db);
    t.mock.method(db, "all", async (q: Parameters<typeof db.all>[0], o?: never) => {
      if (/item_workflows/.test(q.compile().sql)) throw new Error("no workflows");
      return await all(q, o);
    });
    try {
      await r.tick();
      await r.tick();
      assert.equal(lines.filter((l) => l === "workflows: no workflows").length, 2, lines.join("\n"));
      assert.ok(!lines.some((l) => l.startsWith("preapproval")), lines.join("\n"));
    } finally { t.mock.restoreAll(); }
    lines.length = 0;
    await r.tick();
    await r.tick();
    assert.deepEqual(lines, []);
    await r.stop();
  });

  test("a heartbeat that cannot be stored while the pass still runs is logged and ends nothing", async (t) => {
    const lines: string[] = [];
    const r = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: (l) => lines.push(l), detect: async () => ({ proposals: [], logs: [] }) });
    const seqs = db.seqs.bind(db);
    t.mock.method(db, "seqs", async (topics?: readonly string[]) => { await new Promise((ok) => setTimeout(ok, 100)); return await seqs(topics); });
    const run = db.run.bind(db);
    let refused = 0;
    t.mock.method(db, "run", async (q: Parameters<typeof db.run>[0]) => {
      if (!refused && q.compile().sql.includes("lane_state")) { refused++; throw new Error("lock timeout"); }
      return await run(q);
    });
    try { await r.tick(); } finally { t.mock.restoreAll(); }
    assert.equal(refused, 1);
    assert.ok(lines.some((l) => /heartbeat not stored: lock timeout/.test(l)), lines.join("\n"));
    await r.stop();
  });

  test("a resumed job does not post again a comment its earlier run posted", async () => {
    const id = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "boss", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString() }).returning("id")))!.id);
    setCallContext({ jobId: id, step: "test-echo", stage: 2, cancelled: async () => false });
    try {
      let posts = 0;
      const exec = async () => { posts++; return { code: 0, stdout: `https://github.com/storytold/app/issues/3#issuecomment-${posts}\n`, stderr: "" }; };
      const g = { scope: "item", action: { kind: "act" }, repo: "app", number: 3, as: "app" } as unknown as GuardedItem;
      const comment = (text: string) => ghComment({ db, login: "act" }, g, exec, "act-comment", { repo: "app", number: 3, pr: false }, { by: "fixed" } as never, text);
      await comment("hello");
      // The runner stopped, the job resumed and runs again from the start.
      await db.run(db.k.updateTable("jobs").set({ resumes: 1, started_at: new Date(Date.now() + 1000).toISOString() }).where("id", "=", id));
      const again = await comment("hello");
      assert.equal(posts, 1, "the comment is not posted twice");
      assert.match(again.stdout, /issuecomment-1/, "the earlier comment's URL is the result");
      await comment("something else");
      assert.equal(posts, 2, "a comment the earlier run did not post is posted");

      // The earlier run stopped, or lost GitHub's answer, during a comment: GitHub's own list of comments settles it.
      const started = (await db.get(db.k.selectFrom("audit").select([rowid("audit").as("id"), "details"]).where("action", "=", "act-comment").where("details", "like", `%"jobId":${id},%`).where("details", "like", "%hello%").limit(1)))!;
      const was = JSON.parse(started.details!) as { text: string };
      let resumes = 1;
      const outcome = async (state: "started" | "failed") => {
        await db.run(db.k.updateTable("jobs").set({ resumes: ++resumes, started_at: new Date(Date.now() + 1000 * resumes).toISOString() }).where("id", "=", id));
        await db.run(db.k.updateTable("audit").set({ details: JSON.stringify({ ...was, url: undefined, state, ...(state === "failed" && { error: "timeout" }) }) }).where(rowid("audit"), "=", started.id));
      };
      const on = (seen: string | null) => async (_cmd: string, args: string[]) => args[0] !== "api" ? await exec() : seen === null ? { code: 1, stdout: "", stderr: "no network" } : { code: 0, stdout: seen, stderr: "" };
      const retry = (seen: string | null) => ghComment({ db, login: "act" }, g, on(seen), "act-comment", { repo: "app", number: 3, pr: false }, { by: "fixed" } as never, "hello");
      for (const state of ["started", "failed"] as const) {
        await outcome(state);
        const r = await retry(`${JSON.stringify({ url: "https://github.com/storytold/app/issues/3#issuecomment-77", body: was.text, at: new Date().toISOString() })}\n`);
        assert.match(r.stdout, /issuecomment-77/);
        assert.equal(posts, 2, "a comment GitHub already shows is not posted again");
      }
      await outcome("started");
      await assert.rejects(retry(null), /could not be read/);
      assert.equal(posts, 2, "nothing is posted while GitHub cannot be read");
      await retry("");
      assert.equal(posts, 3, "a comment GitHub does not show was never made");

      // Another job, after one that lost GitHub's answer: the same comment is looked up, and one that carries out a known action is made once for good.
      setCallContext(null);
      const act = (text: string, e: Parameters<typeof ghComment>[2], o: { action?: number } = {}) => ghComment({ db, login: "act" }, g, e, "act-comment", { repo: "app", number: 3, pr: false }, { by: "fixed" } as never, text, o);
      assert.notEqual((await act("later", async () => ({ code: 1, stdout: "", stderr: "timeout" }))).code, 0);
      const lost = JSON.parse((await db.get(db.k.selectFrom("audit").select("details").where("action", "=", "act-comment").where("details", "like", "%later%")))!.details!) as { text: string };
      const shown = `${JSON.stringify({ url: "https://github.com/storytold/app/issues/3#issuecomment-88", body: lost.text, at: new Date().toISOString() })}\n`;
      assert.match((await act("later", on(shown))).stdout, /issuecomment-88/);
      assert.equal(posts, 3);
      await act("later", on(null));
      assert.equal(posts, 4, "a comment that was made may be made again later, with nothing to look up");
      for (let k = 0; k < 2; k++) await act("closing", on(null), { action: 7 });
      assert.equal(posts, 5, "the comment of one action is made once");
      setCallContext({ jobId: id, step: "test-echo", stage: 2, cancelled: async () => false });

      // A stopping job lets a write in flight finish and be recorded, and refuses writes asked for after the stop.
      let send = (): void => {};
      let sending = (): void => {};
      const sent = new Promise<void>((r) => { sending = r; });
      const slow = async () => { const answer = new Promise<void>((r) => { send = r; }); sending(); await answer; return { code: 0, stdout: "https://github.com/storytold/app/issues/3#issuecomment-9\n", stderr: "" }; };
      const inFlight = ghComment({ db, login: "act" }, g, slow, "act-comment", { repo: "app", number: 3, pr: false }, { by: "fixed" } as never, "in flight");
      // The stop comes once the write is on its way to GitHub: a write still being recorded when the stop comes is not made, and never settles.
      await sent;
      const stopping = stopWrites("the job is stopping", 5000);
      send();
      assert.equal(await stopping, 0, "nothing is left in flight");
      assert.equal((await inFlight).code, 0);
      assert.equal((JSON.parse((await db.get(db.k.selectFrom("audit").select("details").where("action", "=", "act-comment").orderBy(rowid("audit"), "desc").limit(1)))!.details!) as { state: string }).state, "done");
      // A write asked for after the stop is not made, and its caller waits for the process to exit.
      const rows = async () => (await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("n")).where("action", "=", "act-comment")))!.n;
      const n = await rows();
      const late = await Promise.race([comment("after the stop").then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("waits"), 200))]);
      assert.equal(late, "waits");
      assert.equal(await rows(), n, "no row for the write that was not made");
    } finally {
      resumeWritesForTests();
      setCallContext(null);
    }
  });






});
