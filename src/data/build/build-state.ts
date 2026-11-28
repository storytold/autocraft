// The `build_state` rows: stored warm report, warm bytes, warm gc lock, trimmed publish, worker update and endpoint status (package build-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { EndpointStatus, StoredCaches, UpdateSpec, WorkerUpdate } from "./types.ts";
import { ENDPOINT_KEY, PENDING_UPDATE_KEY, UPDATE_FAILURES_KEY, WARM_GC_KEY, WARM_REPORT_KEY, WARM_TRIMMED_KEY, mirrorSourcesKey, warmBytesKey } from "./warm-key.ts";

/** The warm gc runs in one producer pod at most this often, and a failed one is due again after `WARM_GC_RETRY_MS`. */
export const WARM_GC_EVERY_MS = 24 * 3600_000;
export const WARM_GC_RETRY_MS = 3 * 3600_000;

/** True when every field of a stored worker update has the expected shape; the values reach ssh and git argument lists. */
export function validUpdateSpec(s: UpdateSpec): boolean {
  return (
    typeof s.sha === "string" && /^[0-9a-f]{40,64}$/.test(s.sha) &&
    typeof s.ssh === "string" && /^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+$/.test(s.ssh) && !s.ssh.startsWith("-") &&
    typeof s.gitDir === "string" && s.gitDir.startsWith("/") &&
    typeof s.keyFile === "string" && s.keyFile.startsWith("/")
  );
}

const parse = <T>(text: string | null | undefined): T | null => {
  try { return text ? JSON.parse(text) as T : null; } catch { return null; }
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** One multi-row upsert; a key twice in `rows` keeps the last value. */
async function put(db: Db, rows: { key: string; value: string }[], at: string): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const last = [...new Map(rows.map((r) => [r.key, r.value])).entries()].map(([key, value]) => ({ key, value, updated_at: at }));
  await db.write(async () => {
    for (const part of kx.batches(last)) await q.run(q.k.insertInto("main.build_state").values(part).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value", "updated_at"]))));
  });
}

async function values(db: Db, keys: string[], alone = false): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.build_state").select(["key", "value"]).where(kx.inList(db, "key", keys)), alone ? { alone: true } : undefined);
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Stores the Caches page's report JSON. 1 statement. */
export async function saveWarmReport(db: Db, json: string): Promise<void> {
  await put(db, [{ key: WARM_REPORT_KEY, value: json }], iso(Date.now()));
}

/** The stored report, or null when none is stored or it does not parse; `alone` because it is large. 1 statement. */
export async function loadWarmReport(db: Db): Promise<StoredCaches | null> {
  const s = parse<StoredCaches>((await values(db, [WARM_REPORT_KEY], true)).get(WARM_REPORT_KEY));
  return s?.version === 1 && Array.isArray(s.nodes) ? s : null;
}

const validBytes = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/** Published warm sizes per key; keys without a valid size are absent. 1 statement. */
export async function loadWarmBytes(db: Db, keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const [stored, v] of await values(db, keys.map(warmBytesKey))) {
    const n = Number(v);
    if (validBytes(n)) out.set(stored.slice("warm_bytes:".length), n);
  }
  return out;
}

/** Stores published warm sizes; sizes that are not positive whole numbers are left out. 1 statement. */
export async function saveWarmBytes(db: Db, rows: { key: string; bytes: number }[]): Promise<void> {
  await put(db, rows.filter((r) => validBytes(r.bytes)).map((r) => ({ key: warmBytesKey(r.key), value: String(r.bytes) })), iso(Date.now()));
}

/**
 * Takes the day's gc for one warm pod: true when none ran or was taken in the last day. One upsert whose update runs only when
 * the stored time is due, so pods created in one pass do not all run gc. A value that is not a time counts as due.
 */
export async function takeWarmGc(db: Db, nowMs: number): Promise<boolean> {
  const q = queryDb(db);
  const at = iso(nowMs), cutoff = iso(nowMs - WARM_GC_EVERY_MS);
  const r = await db.write(async () => await q.run(q.k.insertInto("main.build_state").values({ key: WARM_GC_KEY, value: at, updated_at: at })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: at, updated_at: at })
      .where((eb) => eb.or([eb("main.build_state.value", "<=", cutoff), eb.not(kx.like(db, "main.build_state.value", eb.val("____-__-__T__:__:__%")))])))));
  return r.changes > 0;
}

/** A gc that failed: the day's gc is due again after `WARM_GC_RETRY_MS`. */
export async function releaseWarmGc(db: Db, nowMs: number): Promise<void> {
  await put(db, [{ key: WARM_GC_KEY, value: iso(nowMs - WARM_GC_EVERY_MS + WARM_GC_RETRY_MS) }], iso(nowMs));
}

/** Records the first trimmed publish; later ones change nothing. */
export async function recordTrimmedPublish(db: Db, repo: string, nowMs: number): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.insertInto("main.build_state").values({ key: WARM_TRIMMED_KEY, value: `${repo} ${iso(nowMs)}`, updated_at: iso(nowMs) }).onConflict((oc) => oc.column("key").doNothing()));
  });
}

/** The repo and time of the first trimmed publish, if any. 1 statement. */
export async function loadTrimmedPublish(db: Db): Promise<{ repo: string; at: string } | null> {
  const v = (await values(db, [WARM_TRIMMED_KEY])).get(WARM_TRIMMED_KEY);
  if (!v) return null;
  const i = v.indexOf(" ");
  return i < 0 ? { repo: "", at: v } : { repo: v.slice(0, i), at: v.slice(i + 1) };
}

/** The pending worker update (null when none or malformed) and its failures. 1 statement. */
export async function loadWorkerUpdate(db: Db): Promise<WorkerUpdate> {
  const v = await values(db, [PENDING_UPDATE_KEY, UPDATE_FAILURES_KEY]);
  const spec = parse<UpdateSpec>(v.get(PENDING_UPDATE_KEY));
  return { pending: spec && validUpdateSpec(spec) ? spec : null, failures: parse<{ count: number; error: string }>(v.get(UPDATE_FAILURES_KEY)) };
}

/** Sets (a value) or removes (null) the pending update and the failures; a field left out stays. At most 2 statements. */
export async function saveWorkerUpdate(db: Db, patch: { pending?: UpdateSpec | null; failures?: { count: number; error: string } | null }): Promise<void> {
  const set: { key: string; value: string }[] = [], drop: string[] = [];
  for (const [key, v] of [[PENDING_UPDATE_KEY, patch.pending], [UPDATE_FAILURES_KEY, patch.failures]] as const) {
    if (v === undefined) continue;
    if (v === null) drop.push(key);
    else set.push({ key, value: JSON.stringify(v) });
  }
  const q = queryDb(db);
  await db.write(async () => {
    await put(db, set, iso(Date.now()));
    if (drop.length) await q.run(q.k.deleteFrom("main.build_state").where(kx.inList(db, "key", drop)));
  });
}

/** Clears the pending update and the failures. 1 statement. */
export async function clearWorkerUpdate(db: Db): Promise<void> {
  await saveWorkerUpdate(db, { pending: null, failures: null });
}

/** Claimed or running tasks on the local sandbox environments, the ones whose worker an update restarts. 1 statement. */
export async function loadBusyLocalTasks(db: Db): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.build_tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "in", ["claimed", "running"])
    .where("env_id", "in", q.k.selectFrom("main.build_envs").select("id").where("kind", "=", "local-sandbox")));
  return Number(r?.n ?? 0);
}

/** The runner's EndpointSlice record, for the health check; null when none is stored or it does not parse. 1 statement. */
export async function loadEndpointStatus(db: Db): Promise<EndpointStatus | null> {
  return parse<EndpointStatus>((await values(db, [ENDPOINT_KEY])).get(ENDPOINT_KEY));
}

/** Stores the runner's EndpointSlice record. 1 statement. */
export async function saveEndpointStatus(db: Db, status: EndpointStatus): Promise<void> {
  await put(db, [{ key: ENDPOINT_KEY, value: JSON.stringify(status) }], iso(Date.now()));
}

/** The git sources a repo's default-branch Cargo.lock names, as read at `sha`; `note` says why `repos` were kept from an older read. */
export type MirrorSources = { sha: string; repos: string[]; note: string | null };

/** The stored git sources of `repos`; a repo without a valid row is absent. 1 statement. */
export async function loadMirrorSources(db: Db, repos: string[]): Promise<Map<string, MirrorSources>> {
  const out = new Map<string, MirrorSources>();
  const byKey = new Map(repos.map((r) => [mirrorSourcesKey(r), r]));
  for (const [key, v] of await values(db, [...byKey.keys()])) {
    const s = parse<MirrorSources>(v);
    if (s && typeof s.sha === "string" && Array.isArray(s.repos) && s.repos.every((r) => typeof r === "string")) out.set(byKey.get(key)!, { sha: s.sha, repos: s.repos, note: typeof s.note === "string" ? s.note : null });
  }
  return out;
}

/** Stores repos' git sources. 1 statement. */
export async function saveMirrorSources(db: Db, rows: { repo: string; sources: MirrorSources }[]): Promise<void> {
  await put(db, rows.map((r) => ({ key: mirrorSourcesKey(r.repo), value: JSON.stringify(r.sources) })), iso(Date.now()));
}
