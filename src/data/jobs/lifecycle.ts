// State writers; the cross-table orchestration is feature code `src/runner/lifecycle.ts` (M07 jobs).
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { MAX_RESUMES, MAX_TOTAL_RESUMES } from "../../runner/resuming.ts";
import { drainJobItems } from "./items.ts";
import { nowIso } from "./sql.ts";
import type { JobFlags, JobPatch, JobPulse, JobResult, PulseRow } from "./types.ts";

const PIPELINE_USER = "pipeline";
/** The error a job carries once the runner asked it to stop at its deadline or for lack of progress. */
const DEADLINE_ERROR = /^stopped: (ran past|no progress for) /;

/** One `UPDATE ... WHERE state = 'queued' ... RETURNING`. `pipelineOnly` leaves out jobs of people. */
export async function markCancelQueued(db: Db, where: { ids?: number[]; pipelineOnly?: boolean }, by: string): Promise<{ id: number; resumes: number; step: string }[]> {
  if (where.ids && !where.ids.length) return [];
  const q = queryDb(db);
  const t = nowIso();
  return await q.all(q.k.updateTable("jobs").set({ state: "cancelled", ended_at: t, cancel_requested_at: t, cancel_requested_by: by })
    .where("state", "=", "queued")
    .$if(!!where.ids, (b) => b.where(kx.inList(db, "id", where.ids!, "bigint")))
    .$if(!!where.pipelineOnly, (b) => b.where("requested_by", "=", PIPELINE_USER))
    .returning(["id", "resumes", "step"]));
}

/** The running branch; `coalesce` keeps the first requester. */
export async function markCancelRequested(db: Db, ids: number[], by: string): Promise<number> {
  if (!ids.length) return 0;
  const q = queryDb(db);
  const t = nowIso();
  return (await q.run(q.k.updateTable("jobs")
    .set((eb) => ({ cancel_requested_at: eb.fn.coalesce("cancel_requested_at", eb.val(t)), cancel_requested_by: eb.fn.coalesce("cancel_requested_by", eb.val(by)) }))
    .where(kx.inList(db, "id", ids, "bigint")).where("state", "=", "running"))).changes;
}

/** The job in the enclosing `jobs` statement only waits for a Task Runner: it has a queued remote call and none leased (running). */
const waitingForTaker = (eb: kx.AnyEb) => {
  const t = kx.schemaEb(eb);
  const calls = (state: string[]) => t.selectFrom("main.remote_calls as rc").select(eb.lit(1).as("one")).where("rc.job_id", "=", kx.ref<number>("jobs.id")).where("rc.state", "in", state);
  return eb.and([eb.exists(calls(["queued"])), eb.not(eb.exists(calls(["leased"])))]);
};

/**
 * The guarded update of `resumeJob` over many ids: a running job without a cancel request, resumed fewer than
 * MAX_TOTAL_RESUMES times (a graceful resume of a job that only waits for a Task Runner to take a queued call is not
 * limited; a crash resume fewer than MAX_RESUMES), not a command-line run and not stopped at its deadline
 * goes back to the queue. Ids missing from the result did not resume.
 */
export async function markResumed(db: Db, rows: { id: number; kind: "graceful" | "crash" }[]): Promise<{ id: number; resumes: number; crash_resumes: number; log_path: string | null }[]> {
  if (!rows.length) return [];
  const q = queryDb(db);
  const one = async (ids: number[], crash: boolean) => await q.all(q.k.updateTable("jobs")
    .set((eb) => ({ state: "queued", resumes: eb("resumes", "+", 1), crash_resumes: crash ? eb("crash_resumes", "+", 1) : eb.ref("crash_resumes"), started_at: null, ended_at: null, pid: null, progress: null, error: null }))
    .where(kx.inList(db, "id", ids, "bigint")).where("state", "=", "running").where("cancel_requested_at", "is", null)
    .where((eb) => crash ? eb("resumes", "<", MAX_TOTAL_RESUMES) : eb.or([eb("resumes", "<", MAX_TOTAL_RESUMES), waitingForTaker(eb)]))
    .$if(crash, (b) => b.where("crash_resumes", "<", MAX_RESUMES)).where("requested_by", "<>", "cli")
    .where((eb) => eb.or([eb("error", "is", null), eb.and([eb.not(kx.like(db, "error", eb.val("stopped: ran past %"))), eb.not(kx.like(db, "error", eb.val("stopped: no progress for %")))])]))
    .returning(["id", "resumes", "crash_resumes", "log_path"]));
  const graceful = rows.filter((r) => r.kind === "graceful").map((r) => r.id), crash = rows.filter((r) => r.kind === "crash").map((r) => r.id);
  const run = async () => [...(graceful.length ? await one(graceful, false) : []), ...(crash.length ? await one(crash, true) : [])];
  return graceful.length && crash.length ? await db.write(run) : await run();
}

/** Sets the end of running jobs (a job that left `running` meanwhile is untouched): state, error as given, pid cleared, progress cleared where asked; one statement per 500 rows. */
export async function markEnded(db: Db, rows: { id: number; state: string; error: string | null; clearProgress: boolean }[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  const t = nowIso();
  let n = 0;
  for (const part of kx.batches(rows)) {
    const ids = part.map((r) => r.id);
    n += (await q.run(q.k.updateTable("jobs").set({
      state: kx.caseOf("id", part.map((r) => [r.id, r.state] as const)), ended_at: t, pid: null,
      error: kx.caseOf<string | null>("id", part.map((r) => [r.id, r.error] as const)),
      progress: (eb) => eb.case().when(kx.inList(db, "id", part.filter((r) => r.clearProgress).map((r) => r.id), "bigint")).then(eb.lit(null)).else(eb.ref("progress")).end(),
    }).where(kx.inList(db, "id", ids, "bigint")).where("state", "=", "running"))).changes;
  }
  return n;
}

/** Sets the stop error of running jobs the runner flagged for their deadline or lack of progress. */
export async function markDeadlineStops(db: Db, rows: { id: number; error: string }[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.batches(rows)) {
    n += (await q.run(q.k.updateTable("jobs").set({ error: kx.caseOf("id", part.map((r) => [r.id, r.error] as const)) })
      .where(kx.inList(db, "id", part.map((r) => r.id), "bigint")).where("state", "=", "running"))).changes;
  }
  return n;
}

/** Running jobs, for `recover`; `error` lets the caller keep or fill the stored one. */
export async function loadRunning(db: Db): Promise<{ id: number; pid: number | null; cancel_requested_at: string | null; error: string | null }[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("jobs").select(["id", "pid", "cancel_requested_at", "error"]).where("state", "=", "running").orderBy("id"));
}

/** One `UPDATE ... RETURNING` that writes progress or counts and returns the cancel flag, stop error and claim time (a select when the patch is empty). */
export async function pulseJob(db: Db, id: number, patch: JobPatch): Promise<JobFlags> {
  const q = queryDb(db);
  const set: { progress?: string | null; items?: number; acted?: number } = {};
  if (patch.progress !== undefined) set.progress = patch.progress;
  if (patch.items !== undefined) set.items = patch.items;
  if (patch.acted !== undefined) set.acted = patch.acted;
  const cols = ["cancel_requested_at", "error", "started_at"] as const;
  const row = Object.keys(set).length
    ? await q.get(q.k.updateTable("jobs").set(set).where("id", "=", id).returning([...cols]))
    : await q.get(q.k.selectFrom("jobs").select([...cols]).where("id", "=", id));
  return row ?? { cancel_requested_at: null, error: null, started_at: null };
}

/** The final writes of `exec.ts` as one update; stats add to the four count columns (integers: Postgres refuses a fraction) so resumed runs accumulate. */
export async function recordResult(db: Db, id: number, r: JobResult): Promise<void> {
  const q = queryDb(db);
  const s = r.stats;
  const set: Record<string, unknown> = { ...r.patch };
  if (r.usage !== undefined) set.usage = r.usage;
  if (r.summary !== undefined) set.summary = r.summary;
  if (r.error !== undefined) set.error = r.error;
  if (r.leaseSkips !== undefined) set.lease_skips = r.leaseSkips;
  if (r.leaseSkipKeys !== undefined) set.lease_skip_keys = JSON.stringify(r.leaseSkipKeys);
  if (s) {
    set.db_statements = (eb: kx.AnyEb) => eb(eb.fn.coalesce("db_statements", eb.lit(0)), "+", s.statements);
    set.db_round_trips = (eb: kx.AnyEb) => eb(eb.fn.coalesce("db_round_trips", eb.lit(0)), "+", s.roundTrips);
    set.db_ms = (eb: kx.AnyEb) => eb(eb.fn.coalesce("db_ms", eb.lit(0)), "+", Math.round(s.ms));
    set.effects = (eb: kx.AnyEb) => eb(eb.fn.coalesce("effects", eb.lit(0)), "+", s.effects);
  }
  if (!Object.keys(set).length) return;
  await q.run(q.k.updateTable("jobs").set(set as never).where("id", "=", id));
}

/**
 * In-process cache over `pulseJob`: writes merge into the next pulse, at most `minMs` later; `cancelled()` and `timeUp()`
 * return the last flags when younger than `minMs`. `handled` and `acted` take the job's own count; a resumed job's counts add to those of its
 * earlier runs, which `row` carries.
 */
export async function openJobPulse(db: Db, row: PulseRow, o: { minMs: number }): Promise<JobPulse> {
  const itemsBefore = row.resumes ? Number(row.items ?? 0) : 0, actedBefore = row.resumes ? Number(row.acted ?? 0) : 0;
  const claimedAt = row.started_at ?? nowIso();
  let pending: JobPatch = {};
  let flags: JobFlags | null = null, flagsAt = 0;
  // Pulses run one after another, so an older count never lands after a newer one.
  let chain: Promise<unknown> = Promise.resolve();
  const doPulse = async (): Promise<JobFlags> => {
    const patch = pending;
    pending = {};
    try {
      flags = await pulseJob(db, row.id, patch);
    } catch (e) {
      pending = { ...patch, ...pending };
      throw e;
    }
    flagsAt = Date.now();
    return flags;
  };
  const pulse = (): Promise<JobFlags> => {
    const p = chain.then(doPulse, doPulse);
    chain = p.catch(() => {});
    return p;
  };
  const fresh = async (): Promise<JobFlags> => (flags && Date.now() - flagsAt < o.minMs ? flags : await pulse());
  // A note is stored within `minMs`, also when the step says nothing after it. Outside the note's async context: a transaction open there has ended by then.
  const apart = AsyncLocalStorage.snapshot();
  let timer: NodeJS.Timeout | null = null, writing = false, ended = false;
  const later = (ms: number): void => { if (!ended) timer ??= apart(() => setTimeout(() => { timer = null; write(); }, ms).unref()); };
  const write = (): void => {
    if (writing || !Object.keys(pending).length) return;
    writing = true;
    void apart(pulse).catch(() => {}).finally(() => {
      writing = false;
      // Notes made meanwhile, or put back by a write that failed.
      if (Object.keys(pending).length) later(o.minMs);
    });
  };
  const lazyWrite = (): void => {
    const due = flagsAt + o.minMs - Date.now();
    if (due > 0) later(due);
    else write();
  };
  return {
    progress(text) { pending.progress = text; lazyWrite(); },
    handled(n) { pending.items = itemsBefore + n; lazyWrite(); },
    acted(n) { pending.acted = actedBefore + n; lazyWrite(); },
    cancelled: async () => { const f = await fresh(); return !!f.cancel_requested_at || DEADLINE_ERROR.test(f.error ?? ""); },
    timeUp: async (sliceMs) => { const f = await fresh(); return Date.now() - Date.parse(f.started_at ?? claimedAt) >= sliceMs; },
    async end() {
      ended = true;
      if (timer) clearTimeout(timer);
      await drainJobItems(db, row.id);
      // A pulse under way that fails puts its patch back.
      await chain;
      const patch = pending;
      pending = {};
      return patch;
    },
  };
}
