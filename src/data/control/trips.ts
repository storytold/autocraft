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

/**
 * Compare-and-set (`ON CONFLICT ... WHERE active = 0 RETURNING`): trips each key that is not active already and returns those
 * keys, with one `stage-trip` audit row each. A repeated key takes its first row. Joins the caller's transaction.
 */
export async function tripStage(db: Db, rowsIn: { key: string; reason: string; evidence: string[]; at: string }[]): Promise<string[]> {
  const first = new Map<string, (typeof rowsIn)[number]>();
  for (const r of rowsIn) if (!first.has(r.key)) first.set(r.key, r);
  const unique = [...first.values()];
  if (!unique.length) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const won = await q.all(q.k.insertInto("main.stage_trips")
      .values(unique.map((r) => ({ stage: r.key, active: 1, reason: r.reason, evidence: JSON.stringify(r.evidence), tripped_at: r.at })))
      .onConflict((oc) => oc.column("stage").doUpdateSet(kx.excluded(["active", "reason", "evidence", "tripped_at"])).where((eb) => eb(eb.ref("stage_trips.active" as never), "=", 0 as never)))
      .returning("stage"));
    const tripped = new Set(won.map((r) => r.stage));
    await addAudit(db, unique.filter((r) => tripped.has(r.key)).map((r) => ({ login: "pipeline", action: "stage-trip", target: r.key, details: { reason: r.reason, evidence: r.evidence } })));
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
 * Clears trips that lift by themselves (`by` is the bookkeeping login that lifted them): each only while it is still the trip
 * that was read (active, same `tripped_at`), so a person's resume and a newer trip stay as they are. Returns the keys cleared.
 */
export async function liftTrips(db: Db, rowsIn: { key: string; trippedAt: string }[], by: string, at: string = new Date().toISOString()): Promise<string[]> {
  if (!rowsIn.length) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const out: string[] = [];
    for (const r of rowsIn) {
      const done = await q.all(q.k.updateTable("main.stage_trips").set({ active: 0, cleared_at: at, cleared_by: by })
        .where("stage", "=", r.key).where("active", "=", 1).where("tripped_at", "=", r.trippedAt).returning(["stage", "reason"]));
      await addAudit(db, done.map((d) => ({ login: by, action: "stage-resume", target: d.stage, details: { reason: d.reason }, at })));
      out.push(...done.map((d) => d.stage));
    }
    return out;
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
 * Trips `merge:<repo>` for rows merged after the key's `cleared_at`: one read of the cleared times, one `tripStage` call. The
 * caller loads `mergedAt` with `merge.loadMergedInfo`.
 */
export async function tripMergeBreakers(db: Db, rowsIn: { repo: string; number: number; mergedAt: string; reason: string; evidence: string[] }[], at: string = new Date().toISOString()): Promise<string[]> {
  if (!rowsIn.length) return [];
  const since = await loadBreakerSince(db, [...new Set(rowsIn.map((r) => tripKey("merge", r.repo)))]);
  const due = rowsIn.filter((r) => r.mergedAt > since.get(tripKey("merge", r.repo))!);
  return await tripStage(db, due.map((r) => ({ key: tripKey("merge", r.repo), reason: r.reason, evidence: r.evidence, at })));
}
