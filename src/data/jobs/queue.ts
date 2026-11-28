// Enqueue, load, claim and list (M07 jobs).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { lastLeaseOf, remoteQueuedOf } from "../runners/fragments.ts";
import { resumingJobs } from "./fragments.ts";
import { hasFilter, nowIso, numberOf, octets, perItemOf, repoVisible } from "./sql.ts";
import type { CliJob, HiddenRepos, JobRow, JobState, LiveJob, LogCursor, NewJob, QueuedJob, RunningState } from "./types.ts";

/** Longest a Task Runner caller may go unseen and still count as polling; the runner passes `CALLER_STALE_MS` of the remote protocol. */
const CALLER_STALE_MS = 75_000;

/**
 * One `INSERT ... SELECT ... WHERE NOT EXISTS` (a queued job with the same step and params) `RETURNING id`; maps input index to job id, refused indexes are duplicates. Validation stays in feature code.
 * A repeat of the same step and params within `jobs` is refused too: the first one is queued.
 */
export async function enqueueJobs(db: Db, jobs: NewJob[]): Promise<{ queued: Map<number, number>; refused: number[] }> {
  const queued = new Map<number, number>();
  if (!jobs.length) return { queued, refused: [] };
  const q = queryDb(db);
  const at = nowIso();
  const keyOf = (step: string, params: string): string => `${step}\0${params}`;
  const first = new Map<string, number>();
  const rows: { idx: number; step: string; params: string; repo: string | null; by: string; at: string }[] = [];
  jobs.forEach((j, idx) => {
    const params = JSON.stringify(j.params), key = keyOf(j.step, params);
    if (first.has(key)) return;
    first.set(key, idx);
    rows.push({ idx, step: j.step, params, repo: j.repo, by: j.by, at });
  });
  const insert = async (chunk: typeof rows): Promise<void> => {
    const v = kx.valuesTable(db, chunk, { idx: "bigint", step: "text", params: "text", repo: "text", by: "text", at: "text" }, "v");
    const out = await q.all(q.k.insertInto("jobs").columns(["step", "params", "repo", "requested_by", "requested_at", "state"])
      .expression((eb) => eb.selectFrom(v).select(["v.step", "v.params", "v.repo", "v.by", "v.at", kx.literal("queued").as("state")])
        .where((e) => e.not(e.exists(e.selectFrom("jobs as dup").select(e.lit(1).as("one")).where("dup.state", "=", "queued").whereRef("dup.step", "=", "v.step").whereRef("dup.params", "=", "v.params"))))
        .orderBy("v.idx"))
      .returning(["id", "step", "params"]));
    for (const r of out) {
      const idx = first.get(keyOf(r.step, r.params));
      if (idx !== undefined) queued.set(idx, r.id);
    }
  };
  const parts = kx.chunks(rows);
  if (parts.length === 1) await insert(parts[0]!);
  else await db.write(async () => { for (const p of parts) await insert(p); });
  return { queued, refused: jobs.map((_, i) => i).filter((i) => !queued.has(i)) };
}

/** Job rows by id. */
export async function loadJobs(db: Db, ids: number[]): Promise<Map<number, JobRow>> {
  const out = new Map<number, JobRow>();
  if (!ids.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(ids)) {
    for (const r of await q.all(q.k.selectFrom("jobs").select(kx.cols("jobs")).$narrowType<{ state: JobState }>().where(kx.inList(db, "id", part, "bigint")))) out.set(r.id, r);
  }
  return out;
}

/** Page and total in one wave. */
export async function listJobs(db: Db, filter: { step?: string; state?: string; limit: number; offset: number; hidden?: HiddenRepos }): Promise<{ rows: JobRow[]; total: number }> {
  const q = queryDb(db);
  const where = <B extends ReturnType<typeof q.k.selectFrom<"jobs">>>(b: B): B => b
    .$if(!!filter.step, (b) => b.where("step", "=", filter.step!))
    .$if(!!filter.state, (b) => b.where("state", "=", filter.state!))
    .$if(hasFilter(filter.hidden), (b) => b.where((eb) => repoVisible(db, eb, "repo", filter.hidden!))) as B;
  const limit = Math.min(Math.max(filter.limit, 1), 200), offset = Math.max(filter.offset, 0);
  const [total, rows] = await db.together(() => Promise.all([
    q.get(where(q.k.selectFrom("jobs")).select((eb) => eb.fn.countAll<number>().as("n"))),
    q.all(where(q.k.selectFrom("jobs")).select(kx.cols("jobs")).$narrowType<{ state: JobState }>().orderBy("id", "desc").limit(limit).offset(offset)),
  ]));
  return { rows, total: Number(total?.n ?? 0) };
}

const liveJobs = (db: Db) => {
  const q = queryDb(db);
  return q.k.selectFrom("jobs").select(["id", "step", "state", "repo", numberOf(db).as("number"), "params", "items", "requested_by", "resumes", "cancel_requested_at", "started_at", "pid"])
    .$narrowType<{ state: JobState }>().where("state", "in", ["queued", "running"]).orderBy("id");
};

/** Queued and running jobs. */
export async function loadLiveJobs(db: Db): Promise<LiveJob[]> {
  return (await queryDb(db).all(liveJobs(db))).map((r) => ({ ...r, number: r.number === null ? null : Number(r.number) }));
}

/**
 * Everything a runner tick reads, in one round trip of three statements. `callerStaleMs` is how long a remote-call
 * caller may go unseen and still hold its call in the queue.
 */
export async function loadRunnerTick(db: Db, nowMs: number, callerStaleMs: number = CALLER_STALE_MS): Promise<{ queued: QueuedJob[]; running: RunningState[]; logCursors: Map<number, LogCursor> }> {
  const q = queryDb(db);
  const [running, queued, chunks] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("jobs").select((eb) => ["jobs.id", "jobs.cancel_requested_at", "jobs.error", "jobs.started_at",
      remoteQueuedOf(eb, "jobs.id", nowMs, callerStaleMs).as("remote_queued"), lastLeaseOf(eb, "jobs.id").as("last_lease")]).where("jobs.state", "=", "running").orderBy("jobs.id")),
    q.all(q.k.selectFrom("jobs").select(["id", "step", "repo", "params", "requested_by", "resumes"]).where("state", "=", "queued").orderBy("id")),
    q.all(q.k.selectFrom("job_log_chunks").select(["job_id", "seq", "next_start", octets(db, "chunk").as("bytes")])
      .where("job_id", "in", resumingJobs(db)).orderBy("job_id").orderBy("seq")),
  ]));
  const logCursors = new Map<number, LogCursor>();
  for (const c of chunks) {
    const cur = logCursors.get(c.job_id) ?? { lastSeq: 0, lastNextStart: 0, bytes: [] };
    cur.lastSeq = Number(c.seq);
    cur.lastNextStart = Number(c.next_start);
    cur.bytes.push(Number(c.bytes));
    logCursors.set(c.job_id, cur);
  }
  return {
    queued: queued.map((r): QueuedJob => ({ id: r.id, step: r.step, repo: r.repo, params: r.params, limit: limitOf(r.params), requested_by: r.requested_by, resumes: Number(r.resumes) })),
    running: running.map((r): RunningState => ({ id: r.id, cancel_requested_at: r.cancel_requested_at, error: r.error, started_at: r.started_at, queued: Number(r.remote_queued) === 1, lastLeaseAt: r.last_lease === null ? null : Number(r.last_lease) })),
    logCursors,
  };
}

/** The job's `limit` param when it is a number. */
function limitOf(params: string): number | null {
  try {
    const p = JSON.parse(params) as { limit?: unknown };
    return typeof p.limit === "number" ? p.limit : null;
  } catch { return null; }
}

/**
 * One guarded `UPDATE ... WHERE state = 'queued' AND NOT EXISTS (...)`; false when no row changed. The block rules
 * (the same work running, the step already working `cap` repos, a running job of a mutex step) are the SQL twin of
 * `jobBlock` with `states: ["running"]`. `lane`: the job's lane param; a per-item job (`approved` or `item`) is one per PR
 * `number`, outside the repo count, and an `item` job also clashes with a job of its repo without a lane.
 */
export async function claimJob(db: Db, c: { id: number; step: string; repo: string | null; number: number | null; lane?: string | null; cap: number | null; mutexSteps: string[]; logPath: string }): Promise<boolean> {
  const q = queryDb(db);
  const running = (eb: kx.AnyEb, alias: string): any => (kx.schemaEb(eb) as any).selectFrom(`jobs as ${alias}`).where(`${alias}.state`, "=", "running");
  const res = await q.run(q.k.updateTable("jobs").set({ state: "running", started_at: nowIso(), log_path: c.logPath })
    .where("id", "=", c.id).where("state", "=", "queued")
    .where((eb) => {
      const same = running(eb, "s").where("s.step", "=", c.step).select(eb.lit(1).as("one"));
      const sameNumber = (e: kx.AnyEb) => (c.number === null ? e(numberOf(db, "s.params"), "is", null) : e(numberOf(db, "s.params"), "=", c.number));
      const perItem = c.lane === "approved" || c.lane === "item";
      const laneless = (e: kx.AnyEb) => e(e.fn.coalesce(kx.jsonText(db, "s.params", "$.lane"), e.val("")), "=", "");
      // Per-item: any job naming the same item, or (an item job) a job of the repo without a lane or item. Without a lane: naming an
      // item, a job without a lane or a per-item job of that item; naming none, any job but an approved one.
      const lane = c.step === "security-fix" ? sameNumber
        : perItem ? (e: kx.AnyEb) => e.or([sameNumber(e), ...(c.lane === "item" ? [e.and([laneless(e), e(numberOf(db, "s.params"), "is", null)])] : [])])
        : c.number !== null ? (e: kx.AnyEb) => e.or([laneless(e), e.and([perItemOf(db, e, "s.params"), sameNumber(e)])])
        : (e: kx.AnyEb) => e(e.fn.coalesce(kx.jsonText(db, "s.params", "$.lane"), e.val("")), "<>", "approved");
      const sameWork = c.repo === null ? same : same.where((e: kx.AnyEb) => e.or([e("s.repo", "is", null), e.and([e("s.repo", "=", c.repo!), lane(e)])]));
      const conds = [eb.not(eb.exists(sameWork))];
      if (c.cap !== null && !perItem) {
        const repos = running(eb, "p").where("p.step", "=", c.step).where((e: kx.AnyEb) => e.not(perItemOf(db, e, "p.params")));
        conds.push(eb.or([
          eb(repos.select((e: kx.AnyEb) => e.fn.count<number>(e.fn.coalesce("p.repo", e.val(""))).distinct().as("n")), "<", c.cap),
          eb.exists(running(eb, "r").where("r.step", "=", c.step).where((e: kx.AnyEb) => e.and([e(e.fn.coalesce("r.repo", e.val("")), "=", c.repo ?? ""), e.not(perItemOf(db, e, "r.params"))])).select(eb.lit(1).as("one"))),
        ]));
      }
      if (c.mutexSteps.length) conds.push(eb.not(eb.exists(running(eb, "m").where("m.step", "in", c.mutexSteps).select(eb.lit(1).as("one")))));
      return eb.and(conds);
    }));
  return res.changes > 0;
}

/** One `updateFrom`. */
export async function setPids(db: Db, rows: { id: number; pid: number }[]): Promise<number> {
  return await kx.updateFrom(db, "jobs", ["id"], rows);
}

/** Fails queued jobs that cannot run (unknown step, no Task Runner); a job that left the queue meanwhile is untouched. */
export async function failQueued(db: Db, rows: { id: number; error: string }[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  const at = nowIso();
  let n = 0;
  for (const part of kx.batches(rows)) {
    n += (await q.run(q.k.updateTable("jobs").set({ state: "failed", ended_at: at, error: kx.caseOf("id", part.map((r) => [r.id, r.error] as const)) })
      .where(kx.inList(q, "id", part.map((r) => r.id), "bigint")).where("state", "=", "queued"))).changes;
  }
  return n;
}

/**
 * A command-line run: inserts the `running` row and sets its log file `<logDir>/job-<id>.log` (the id names it). The
 * caller opens the gate and this insert in one `db.write`; the pid follows through `setPids`.
 */
export async function claimCliJob(db: Db, o: { step: string; params: Record<string, unknown>; repo: string | null; logDir: string }): Promise<CliJob> {
  const q = queryDb(db);
  const t = nowIso();
  return await db.write(async () => {
    const id = Number((await q.get(q.k.insertInto("jobs").values({ step: o.step, params: JSON.stringify(o.params), repo: o.repo, requested_by: "cli", requested_at: t, state: "running", started_at: t }).returning("id")))!.id);
    const logPath = `${o.logDir}/job-${id}.log`;
    await q.run(q.k.updateTable("jobs").set({ log_path: logPath }).where("id", "=", id));
    return { id, logPath };
  });
}
