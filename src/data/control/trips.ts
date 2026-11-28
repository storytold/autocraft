// Circuit breakers (M06 control-b). The pure rules stay in `src/core/push-outcome.ts`.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { parseTripKey, TRIP_STAGES, tripKey, tripOf } from "../../core/push-outcome.ts";
import { addAudit } from "./audit.ts";
import type { TripRow } from "./types.ts";

/** The key of the outside-author surge breaker. */
export const OUTSIDE_SURGE_KEY = "outside-surge";

/** A refused resume; `status` is the HTTP status the dashboard answers with. */
export class TripError extends Error {
  status = 400;
}

const evidenceOf = (text: string): string[] => {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

async function rows(db: Db, f: { active?: boolean; keys?: string[] }): Promise<Map<string, TripRow>> {
  if (f.keys && !f.keys.length) return new Map();
  const q = queryDb(db);
  const found = await q.all(q.k.selectFrom("main.stage_trips").select(["stage", "active", "reason", "evidence", "tripped_at", "cleared_at", "cleared_by"])
    .$if(f.active !== undefined, (b) => b.where("active", "=", f.active ? 1 : 0))
    .$if(!!f.keys, (b) => b.where(kx.inList(db, "stage", f.keys!))).orderBy("tripped_at").orderBy("stage"));
  return new Map(found.map((r) => [r.stage, { stage: r.stage, active: r.active === 1, reason: r.reason, evidence: evidenceOf(r.evidence), trippedAt: r.tripped_at, clearedAt: r.cleared_at, clearedBy: r.cleared_by }]));
}

/** Active trips by default (`active: false` gives the cleared ones), oldest first; `keys` limits them to those breakers. */
export async function loadTrips(db: Db, f?: { active?: boolean; keys?: string[] }): Promise<Map<string, TripRow>> {
  return await rows(db, { active: f?.active ?? true, keys: f?.keys });
}

/** The breaker's row whether active or cleared. */
export async function loadTrip(db: Db, key: string): Promise<TripRow | undefined> {
  return (await rows(db, { keys: [key] })).get(key);
}

/** `cleared_at` per key (empty text when never cleared); every key asked for is present. */
export async function loadBreakerSince(db: Db, keys: string[]): Promise<Map<string, string>> {
  const found = await rows(db, { keys });
  return new Map(keys.map((k) => [k, found.get(k)?.clearedAt ?? ""]));
}

/** Joins the reasons of one trip: a trip that gained a cause while active lists every cause. */
export const TRIP_REASON_SEPARATOR = "; ";

/** Tries of a compare-and-set on a trip row that another writer changes in between. */
const CAS_TRIES = 3;

type RawTrip = { stage: string; active: number; reason: string; evidence: string };

/** The stored rows of `keys` as written (reason and evidence text), for a compare-and-set on them. */
async function rawRows(db: Db, keys: string[]): Promise<Map<string, RawTrip>> {
  if (!keys.length) return new Map();
  const q = queryDb(db);
  const found = await q.all(q.k.selectFrom("main.stage_trips").select(["stage", "active", "reason", "evidence"]).where(kx.inList(db, "stage", keys)));
  return new Map(found.map((r) => [r.stage, r]));
}

const tripRowOf = (r: RawTrip): Pick<TripRow, "stage" | "reason" | "evidence"> => ({ stage: r.stage, reason: r.reason, evidence: evidenceOf(r.evidence) });

/**
 * Compare-and-set (`ON CONFLICT ... WHERE active = 0 RETURNING`): trips each key that is not active already and returns those
 * keys, with one `stage-trip` audit row each. A repeated key takes its first row. Joins the caller's transaction.
 * `append`: a key that is active already gains a reason it does not list yet, with that reason's evidence (one `stage-trip`
 * audit row each), so a later cause is kept and a resume sees it; such a key is not returned. The append is a compare-and-set
 * on the row's reason and evidence, read again when another writer changed them, so concurrent causes are all kept; a trip
 * resumed in between is tripped anew.
 */
export async function tripStage(db: Db, rowsIn: { key: string; reason: string; evidence: string[]; at: string }[], o: { append?: boolean } = {}): Promise<string[]> {
  const first = new Map<string, (typeof rowsIn)[number]>();
  for (const r of rowsIn) if (!first.has(r.key)) first.set(r.key, r);
  const unique = [...first.values()];
  if (!unique.length) return [];
  const q = queryDb(db);
  const insert = async (list: typeof unique): Promise<Set<string>> => new Set((await q.all(q.k.insertInto("main.stage_trips")
    .values(list.map((r) => ({ stage: r.key, active: 1, reason: r.reason, evidence: JSON.stringify(r.evidence), tripped_at: r.at })))
    .onConflict((oc) => oc.column("stage").doUpdateSet(kx.excluded(["active", "reason", "evidence", "tripped_at"])).where((eb) => eb(eb.ref("stage_trips.active" as never), "=", 0 as never)))
    .returning("stage"))).map((r) => r.stage));
  return await db.write(async () => {
    const tripped = await insert(unique);
    const added: typeof unique = [];
    if (o.append) {
      let todo = unique.filter((r) => !tripped.has(r.key));
      for (let i = 0; i < CAS_TRIES && todo.length; i++) {
        const stored = await rawRows(db, todo.map((r) => r.key));
        const again: typeof unique = [];
        for (const r of todo) {
          const t = stored.get(r.key);
          if (!t || t.active !== 1) {
            if ((await insert([r])).has(r.key)) tripped.add(r.key);
            else again.push(r);
            continue;
          }
          const row = tripRowOf(t);
          if (row.reason.split(TRIP_REASON_SEPARATOR).includes(r.reason)) continue;
          const evidence = [...row.evidence, ...r.evidence.filter((e) => !row.evidence.includes(e))];
          const won = await q.all(q.k.updateTable("main.stage_trips").set({ reason: `${t.reason}${TRIP_REASON_SEPARATOR}${r.reason}`, evidence: JSON.stringify(evidence) })
            .where("stage", "=", r.key).where("active", "=", 1).where("reason", "=", t.reason).where("evidence", "=", t.evidence).returning("stage"));
          if (won.length) added.push(r);
          else again.push(r);
        }
        todo = again;
      }
      if (todo.length) throw new Error(`could not add a cause to ${todo.map((r) => r.key).join(", ")}: the trip kept changing`);
    }
    await addAudit(db, [...unique.filter((r) => tripped.has(r.key)), ...added].map((r) => ({ login: "pipeline", action: "stage-trip", target: r.key, details: { reason: r.reason, evidence: r.evidence } })));
    return unique.filter((r) => tripped.has(r.key)).map((r) => r.key);
  });
}

/** Clears active trips (`cleared_at`, `cleared_by`) and audits each; returns the ones that were active. */
export async function resumeTrips(db: Db, keys: string[], by: string): Promise<{ key: string; reason: string }[]> {
  if (!keys.length) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const at = new Date().toISOString();
    const done = await q.all(q.k.updateTable("main.stage_trips").set({ active: 0, cleared_at: at, cleared_by: by })
      .where(kx.inList(db, "stage", keys)).where("active", "=", 1).returning(["stage", "reason"]));
    await addAudit(db, done.map((r) => ({ login: by, action: "stage-resume", target: r.stage, details: { reason: r.reason }, at })));
    return done.map((r) => ({ key: r.stage, reason: r.reason }));
  });
}

/**
 * Clears the active trips of `keys` that `may` accepts, as read in the same write: each clear is a compare-and-set on the reason
 * and evidence `may` saw, so a cause added in between keeps the trip (the next call decides again). Audits each like resumeTrips.
 */
export async function resumeTripsIf(db: Db, keys: string[], by: string, may: (t: Pick<TripRow, "stage" | "reason" | "evidence">) => boolean): Promise<{ key: string; reason: string }[]> {
  if (!keys.length) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const at = new Date().toISOString();
    const done: { key: string; reason: string }[] = [];
    for (const t of (await rawRows(db, keys)).values()) {
      if (t.active !== 1 || !may(tripRowOf(t))) continue;
      const won = await q.all(q.k.updateTable("main.stage_trips").set({ active: 0, cleared_at: at, cleared_by: by })
        .where("stage", "=", t.stage).where("active", "=", 1).where("reason", "=", t.reason).where("evidence", "=", t.evidence).returning(["stage", "reason"]));
      done.push(...won.map((r) => ({ key: r.stage, reason: r.reason })));
    }
    await addAudit(db, done.map((r) => ({ login: by, action: "stage-resume", target: r.key, details: { reason: r.reason }, at })));
    return done;
  });
}

/** Clears one breaker; throws `TripError` for a key that names no breaker, or for one that is not paused. */
export async function resumeStage(db: Db, key: string, by: string): Promise<void> {
  if (key !== OUTSIDE_SURGE_KEY && !tripOf(key)) throw new TripError(`no such breaker: ${key}; breakers are <stage>:<repo> or <stage> with stage one of ${TRIP_STAGES.join(", ")}, or ${OUTSIDE_SURGE_KEY}`);
  if (!(await resumeTrips(db, [key], by)).length) throw new TripError(`${key} is not paused by the circuit breaker`);
}

/**
 * Who may resume a trip: an operator any trip; a maintainer a per-repo push-breaker trip (`<stage>:<repo>`) when GitHub gives
 * them write permission on its repo. An instance-wide push-stage trip and the outside-author surge breaker are operator-only.
 * `role` absent counts as a maintainer.
 */
export async function mayResumeTrip(_db: Db, user: { role?: string; canWrite(repo: string): Promise<boolean> }, key: string): Promise<boolean> {
  if (user.role === "operator") return true;
  const k = parseTripKey(key);
  if ((user.role !== undefined && user.role !== "maintainer") || !k) return false;
  return await user.canWrite(k.repo).catch(() => false);
}

/**
 * Trips `merge:<repo>` for rows merged after the key's `cleared_at`: one read of the cleared times, one `tripStage` call. A
 * breaker that is active already keeps each new cause with its evidence (a post-merge defect while a red main holds it). The
 * caller loads `mergedAt` with `merge.loadMergedInfo`.
 */
export async function tripMergeBreakers(db: Db, rowsIn: { repo: string; number: number; mergedAt: string; reason: string; evidence: string[] }[], at: string = new Date().toISOString()): Promise<string[]> {
  if (!rowsIn.length) return [];
  const since = await loadBreakerSince(db, [...new Set(rowsIn.map((r) => tripKey("merge", r.repo)))]);
  const due = rowsIn.filter((r) => r.mergedAt > since.get(tripKey("merge", r.repo))!);
  return await tripStage(db, due.map((r) => ({ key: tripKey("merge", r.repo), reason: r.reason, evidence: r.evidence, at })), { append: true });
}
