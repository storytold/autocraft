// Lane lists, lane state and the planner's gate inputs (M07 jobs).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { itemsStartedSince, limitResets } from "./cross.ts";
import { loadHeldLeaseKeys } from "./leases.ts";
import { RUNNER_STOPPED } from "./fragments.ts";
import { loadLiveJobs } from "./queue.ts";
import { approvedOf, nowIso, numberOf, perItemOf } from "./sql.ts";
import type { EndedJob, FpRecord, JobState, LaneInputs, LaneRun, LaneStateKind, LaneStatePut, LaneStateRow, StoredLane, StoredLaneItems, StreakRow, WorkflowFailure } from "./types.ts";

const PIPELINE_USER = "pipeline";
/** Pipeline jobs of the last this-many ids are looked at for failure streaks; older failures no longer delay anything. */
const STREAK_WINDOW = 20_000;
/** Failed jobs of a streak the backoff looks at. */
const STREAK_ROWS = 12;

/** The start of the UTC day that `ms` falls in, as job times are stored. */
export const dayStart = (ms: number): string => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** Postgres reads a JSON number as text. */
const laneNum = (n: unknown): number | null => (n === null || n === undefined ? null : Number(n));

/**
 * One load per planner pass: eight statements in one `together`, joined into the pass's wave. `marks` holds the
 * planner marks and the round-robin cursors, keyed by name. `streaks` keeps, per step and repo, the newest pipeline
 * jobs back to and including the last success, at most 12.
 */
export async function loadLaneInputs(db: Db, nowMs: number): Promise<LaneInputs> {
  const q = queryDb(db);
  const day = dayStart(nowMs);
  const notStopped = (eb: kx.AnyEb) => eb(eb.fn.coalesce("error", eb.val("")), "<>", RUNNER_STOPPED);
  // The PR of a job of a per-item lane, null for every other job: each PR's jobs keep their own ends and streaks.
  const laneNumber = (eb: kx.AnyEb) => eb.case().when(perItemOf(db, eb)).then(numberOf(db)).end().as("lane_number");
  const windowStart = (eb: kx.AnyEb) => eb(eb.selectFrom("jobs as mx").select((e) => e.fn.max<number>("mx.id").as("m")), "-", STREAK_WINDOW);
  const recent = q.k.selectFrom("jobs").select((eb) => ["step", "repo", "id", "state", "error", "ended_at", laneNumber(eb)])
    .where("id", ">", windowStart)
    .where("requested_by", "=", PIPELINE_USER).where("state", "in", ["done", "failed"])
    .where((eb) => eb.and([notStopped(eb), eb.not(kx.like(db, eb.fn.coalesce("error", eb.val("")), eb.val("write paced:%")))]));
  const ranked = q.k.selectFrom(recent.as("j")).select((eb) => ["j.step", "j.repo", "j.id", "j.state", "j.error", "j.ended_at", "j.lane_number",
    eb.fn.agg<number>("row_number").over((o) => o.partitionBy(["j.step", "j.repo", "j.lane_number"]).orderBy("j.id", "desc")).as("rn"),
    eb.fn.max<number | null>(eb.case().when("j.state", "=", "done").then(eb.ref("j.id")).end()).over((o) => o.partitionBy(["j.step", "j.repo", "j.lane_number"])).as("last_ok")]);
  const [live, used, ends, streaks, fps, resets, heldLeaseKeys, marks] = await db.together(() => Promise.all([
    loadLiveJobs(db),
    q.all(itemsStartedSince(db, day)),
    q.all(q.k.selectFrom("jobs").select((eb) => ["id", "step", "repo", "requested_by", "state", "error", "ended_at", "items", "acted", "lease_skips", "lease_skip_keys", laneNumber(eb)]).$narrowType<{ state: JobState }>()
      .where("id", "in", (eb) => eb.selectFrom(eb.selectFrom("jobs").select((e) => ["id", "step", "repo", "requested_by", laneNumber(e)])
        // A per-item job's end counts only within the streak window: there is one per PR ever worked, and the checks that read ends are about recent runs.
        .where((e) => e.and([e("ended_at", "is not", null), notStopped(e), e.or([e.not(perItemOf(db, e)), e("id", ">", windowStart(e))])])).as("e")).select((e) => e.fn.max<number>("e.id").as("m")).groupBy(["e.step", "e.repo", "e.requested_by", "e.lane_number"]))),
    q.all(q.k.selectFrom(ranked.as("r")).select(["r.step", "r.repo", "r.id", "r.state", "r.error", "r.ended_at", "r.lane_number"]).$narrowType<{ state: JobState }>()
      .where("r.rn", "<=", STREAK_ROWS).where((eb) => eb.or([eb("r.last_ok", "is", null), eb("r.id", ">=", eb.ref("r.last_ok"))])).orderBy("r.step").orderBy("r.repo").orderBy("r.id", "desc")),
    q.all(q.k.selectFrom("lane_state").select(["step", "repo", "value", "job_id"]).where("kind", "=", "fp")
      .where((eb) => eb.or([eb.not(itemFp(db, eb)), eb("job_id", ">", windowStart(eb))]))),
    q.all(limitResets(db)),
    loadHeldLeaseKeys(db),
    q.all(q.k.selectFrom("lane_state").select(["step", "value"]).where("kind", "in", ["mark", "cursor"])),
  ]));
  return {
    live,
    usedToday: new Map(used.map((r) => [r.step, Number(r.n)])),
    ends: (ends as EndedJob[]).map((e) => ({ ...e, lane_number: laneNum(e.lane_number) })),
    streaks: (streaks as StreakRow[]).map((r) => ({ ...r, lane_number: laneNum(r.lane_number) })),
    fps: new Map(fps.map((r): [string, FpRecord] => [`${r.step}|${r.repo}`, { job: r.job_id, fp: r.value }])),
    resets: new Map(resets.map((r) => [r.step, r.reset_at!])),
    heldLeaseKeys,
    marks: new Map(marks.map((r) => [r.step, r.value])),
  };
}

/**
 * Lanes with items are upserted and lanes with none are deleted; with `keepOthers` false every stored lane not named is
 * deleted too. A caller that holds the stored lists passes only the changed lanes with `keepOthers` true. One `db.write`.
 */
export async function saveLanes(db: Db, lanes: { lane: string; total: number; items: unknown[]; at: string }[], keepOthers = false): Promise<void> {
  const q = queryDb(db);
  const full = lanes.filter((l) => l.items.length > 0);
  const empty = lanes.filter((l) => l.items.length === 0).map((l) => l.lane);
  if (keepOthers && !lanes.length) return;
  await db.write(async () => {
    for (const part of kx.batches(full)) {
      await q.run(q.k.insertInto("lane_next").values(part.map((l) => ({ lane: l.lane, total: l.total, items: JSON.stringify(l.items), at: l.at })))
        .onConflict((oc) => oc.column("lane").doUpdateSet(kx.excluded(["total", "items", "at"]))));
    }
    if (!keepOthers) await q.run(q.k.deleteFrom("lane_next").where(kx.inList(db, "lane", full.map((l) => l.lane), "text", true)));
    else if (empty.length) await q.run(q.k.deleteFrom("lane_next").where(kx.inList(db, "lane", empty)));
  });
}

/** The stored lane lists, by lane name. */
export async function loadLanes(db: Db, names?: string[]): Promise<StoredLaneItems> {
  const out: StoredLaneItems = new Map();
  if (names && !names.length) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("lane_next").select(["lane", "total", "items", "at"]).$if(!!names, (b) => b.where(kx.inList(db, "lane", names!))))) {
    out.set(r.lane, { lane: r.lane, total: Number(r.total), items: JSON.parse(r.items) as unknown[], at: r.at } satisfies StoredLane);
  }
  return out;
}

/** One upsert for everything a pass or an apply writes: fingerprints, resets, cursors, marks. The last row of a key wins. */
/** The step name under which a per-item job's input fingerprint is kept (one per step and PR). */
export const itemFpStep = (step: string, number: number): string => `${step}:pr:${number}`;
/** A per-item fingerprint row: itemFpStep, or the name approved-lane jobs kept theirs under before. */
const itemFp = (db: Db, eb: kx.AnyEb) => eb.or([kx.like(db, eb.ref("step"), eb.val("%:pr:%")), kx.like(db, eb.ref("step"), eb.val("%:approved:%"))]);

/** Deletes the per-item fingerprints of jobs older than the streak window: their ends are no longer read (loadLaneInputs). */
export async function pruneItemFps(db: Db): Promise<number> {
  const q = queryDb(db);
  return (await q.run(q.k.deleteFrom("lane_state").where("kind", "=", "fp").where((eb) => itemFp(db, eb))
    .where((eb) => eb.or([eb("job_id", "is", null), eb("job_id", "<=", eb(eb.selectFrom("jobs as mx").select((e) => e.fn.max<number>("mx.id").as("m")), "-", STREAK_WINDOW))])))).changes;
}

export async function saveLaneState(db: Db, rows: LaneStatePut[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const at = nowIso();
  const byKey = new Map<string, LaneStatePut>();
  for (const r of rows) byKey.set(`${r.kind}\0${r.step}\0${r.repo ?? ""}`, r);
  const parts = kx.batches([...byKey.values()]);
  const write = async () => {
    for (const part of parts) {
      await q.run(q.k.insertInto("lane_state").values(part.map((r) => ({ kind: r.kind, step: r.step, repo: r.repo ?? "", value: r.value, job_id: r.job_id ?? null, at })))
        .onConflict((oc) => oc.columns(["kind", "step", "repo"]).doUpdateSet(kx.excluded(["value", "job_id", "at"]))));
    }
  };
  if (parts.length === 1) await write(); else await db.write(write);
}

/** Deletes state rows. */
export async function removeLaneState(db: Db, keys: { kind: LaneStateKind; step: string; repo?: string }[]): Promise<number> {
  if (!keys.length) return 0;
  const q = queryDb(db);
  return (await q.run(q.k.deleteFrom("lane_state").where(kx.tupleIn(db, ["kind", "step", "repo"], keys.map((k) => [k.kind, k.step, k.repo ?? ""]), ["text", "text", "text"])))).changes;
}

/** State rows of the kinds (all without `kinds`), keyed "kind|step|repo". */
export async function loadLaneState(db: Db, kinds?: LaneStateKind[]): Promise<Map<string, LaneStateRow>> {
  if (kinds && !kinds.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("lane_state").select(["kind", "step", "repo", "value", "job_id", "at"]).$narrowType<{ kind: LaneStateKind }>()
    .$if(!!kinds, (b) => b.where("kind", "in", kinds!)));
  return new Map(rows.map((r) => [`${r.kind}|${r.step}|${r.repo}`, r]));
}

/**
 * Compare-and-set on a `lane_state` row of kind `mark`: sets the time only when the stored one is older than
 * `minGapMs` (or there is none); true when this caller won.
 */
export async function claimMark(db: Db, name: string, nowMs: number, minGapMs: number): Promise<boolean> {
  const q = queryDb(db);
  const at = new Date(nowMs).toISOString(), threshold = new Date(nowMs - minGapMs).toISOString();
  const won = await q.all(q.k.insertInto("lane_state").values({ kind: "mark", step: name, repo: "", value: at, job_id: null, at })
    .onConflict((oc) => oc.columns(["kind", "step", "repo"]).doUpdateSet(kx.excluded(["value", "at"])).where("lane_state.value", "<=", threshold)).returning("step"));
  return won.length > 0;
}

/**
 * The pipeline's ended jobs of the approved lane (one PR each) of `steps` for the PRs `refs` that ended after `since`, among the last
 * STREAK_WINDOW job ids, oldest first. Which count as the item's own failures is the workflow's call (src/workflow/advance.ts laneFailures).
 */
export async function loadLaneRuns(db: Db, refs: readonly { repo: string; number: number }[], since: string, steps: readonly string[]): Promise<LaneRun[]> {
  if (!refs.length || !steps.length) return [];
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("jobs").select(["repo", "step", "id", "state", "ended_at", "error"]).select(() => [numberOf(db).as("number"), kx.jsonText(db, "params", "$.head").as("head")])
    .where("id", ">", (eb) => eb(eb.selectFrom("jobs as mx").select((e) => e.fn.max<number>("mx.id").as("m")), "-", STREAK_WINDOW))
    .where("requested_by", "=", PIPELINE_USER).where("ended_at", ">", since).where("state", "in", ["done", "failed"])
    .where((eb) => kx.inList(db, eb.ref("step"), steps)).where((eb) => kx.inList(db, eb.ref("repo"), [...new Set(refs.map((r) => r.repo))]))
    .where(kx.inList(db, numberOf(db), [...new Set(refs.map((r) => r.number))], "bigint"))
    .where((eb) => approvedOf(db, eb))
    .orderBy("id"));
  const wanted = new Set(refs.map((r) => `${r.repo}#${r.number}`));
  return rows.flatMap((r) => {
    const number = r.number === null ? NaN : Number(r.number);
    return r.repo !== null && r.ended_at !== null && wanted.has(`${r.repo}#${number}`)
      ? [{ repo: r.repo, number, step: r.step, id: Number(r.id), state: r.state as LaneRun["state"], endedAt: r.ended_at, head: (r.head as string | null) ?? null, error: r.error }] : [];
  });
}

/** The lane_state mark of the live workflows whose check keeps failing (src/workflow/advance.ts), as the runner stored them last. */
export const WORKFLOW_FAILURES_MARK = "workflow_failures";

/** Parses the stored mark; an empty or unreadable one is none. */
export function workflowFailuresOf(value: string | null | undefined): WorkflowFailure[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value) as unknown;
    return Array.isArray(v) ? v.filter((x): x is WorkflowFailure => !!x && typeof x === "object" && typeof (x as WorkflowFailure).id === "number" && typeof (x as WorkflowFailure).ref === "string") : [];
  } catch { return []; }
}

export async function saveWorkflowFailures(db: Db, list: readonly WorkflowFailure[]): Promise<void> {
  await saveLaneState(db, [{ kind: "mark", step: WORKFLOW_FAILURES_MARK, value: list.length ? JSON.stringify(list) : "" }]);
}

export async function loadWorkflowFailures(db: Db): Promise<WorkflowFailure[]> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("lane_state").select("value").where("kind", "=", "mark").where("step", "=", WORKFLOW_FAILURES_MARK).where("repo", "=", ""));
  return workflowFailuresOf(r?.value);
}
