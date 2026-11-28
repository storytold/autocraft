// The typed settings registry and the snapshot (M05 control-a). `settings` holds configuration only; each key is declared
// once in `SETTINGS`/`REPO_SETTINGS` with its type, default and the rule that reads a stored value, so feature code reads
// typed properties of `config(db)` and never key strings. The functions after the registry are the string-keyed reads.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../../db/index.ts";
import { onSettingsWrite } from "../../db/handle.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "./audit.ts";
import { loadStepApprovals } from "./approvals.ts";
import { loadStageLimits } from "./limits.ts";
import { loadTrackedRepos } from "./repos.ts";
import { loadTrips } from "./trips.ts";
import { DEFAULT_OPTIONAL_CHECKS } from "../../core/rules.ts";
import { FIX_SESSION_SWITCHES, type FixSessionSwitch } from "../fixsession/types.ts";
import type { Config, ControlSnapshot, LiveConfig, RepoConfig, SettingDef, SettingKey, SettingPatch, SettingRow, SettingType } from "./types.ts";

// ---- the registry ------------------------------------------------------------------------------------------------------

/** A registry entry: the declaration plus the rule that turns the stored value (undefined: no row) into the typed value. */
export type Reg<T> = SettingDef & { read(raw: string | undefined): T };

const reg = <T>(name: string, type: SettingType, dflt: T, o: { live?: boolean; owner: string; shown?: boolean; scope?: "instance" | "repo" }, read: (raw: string | undefined) => T): Reg<T> =>
  ({ name, type, default: dflt, scope: o.scope ?? "instance", live: o.live ?? false, owner: o.owner, shown: o.shown ?? true, read });

/** The stored value when it is a whole number in `[min, max]`, else `dflt`. */
const intIn = (raw: string | undefined, min: number, max: number, dflt: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};
const jsonOf = (raw: string | undefined): unknown => {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** GitHub's login rules: letters, digits and single hyphens, not starting or ending with one, at most 39 characters. */
const MENTION = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;
const REPO_LIST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export type FixSessionsSetting = { steps: FixSessionSwitch[]; repos: string[] | null };
const stepParallelText = (raw: string | undefined): string => {
  if (raw === "none") return raw;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? String(n) : "1";
};

/** Instance-scope keys by the property of `config(db)` that reads them. A key read two ways (the pipeline switch) has an entry per way. */
export const SETTINGS = {
  // The pipeline switch: "1" on, "drain" off after the running jobs finish, anything else off.
  pipelineEnabled: reg("pipeline_enabled", "bool", false, { live: true, owner: "jobs" }, (r) => r === "1"),
  pipelineDraining: reg("pipeline_enabled", "bool", false, { live: true, owner: "jobs" }, (r) => r === "drain"),
  /** Whether a job's GitHub writes pass the switch: on, or draining. */
  pipelineWrites: reg("pipeline_enabled", "bool", false, { live: true, owner: "jobs" }, (r) => r === "1" || r === "drain"),
  pipelineChangedBy: reg<string | null>("pipeline_changed_by", "text", null, { live: true, owner: "jobs" }, (r) => r ?? null),
  pipelineChangedAt: reg<string | null>("pipeline_changed_at", "text", null, { live: true, owner: "jobs" }, (r) => r ?? null),
  /** Repos at once per step: a whole number from 1 to 1000, or "none", as stored and shown. */
  stepParallelSetting: reg("step_parallel", "text", "1", { live: true, owner: "jobs" }, stepParallelText),
  /** The same as a number (Infinity for "none"). */
  stepParallel: reg("step_parallel", "int", 1, { live: true, owner: "jobs" }, (r) => { const s = stepParallelText(r); return s === "none" ? Infinity : Number(s); }),
  jevParallel: reg("jev_parallel", "int", 4, { live: true, owner: "inference" }, (r) => intIn(r, 1, 100, 4)),

  pipelineLogin: reg<string | null>("pipeline_login", "text", null, { owner: "github" }, (r) => r ?? null),
  githubIdentity: reg<"app" | "box">("github_identity", "text", "box", { owner: "github" }, (r) => (r === "app" ? "app" : "box")),
  /** The name people type to address the app (no `@`); null when unset or not a valid login. */
  githubMentionName: reg<string | null>("github_mention_name", "text", null, { owner: "github" }, (r) => { const v = r?.trim(); return v && v.length <= 39 && MENTION.test(v) ? v : null; }),
  appSlugs: reg<string[]>("app_slugs", "json", [], { owner: "github" }, (r) => strings(jsonOf(r))),

  whitelistMinMerged: reg("whitelist_min_merged", "int", 5, { owner: "intake" }, (r) => Number(r ?? 5)),
  whitelistMinMergeRate: reg("whitelist_min_merge_rate", "float", 0.6, { owner: "intake" }, (r) => Number(r ?? 0.6)),
  outsidePrsPerDay: reg("outside_prs_per_day", "int", 5, { owner: "intake" }, (r) => intIn(r, 0, Infinity, 5)),
  outsideIssuesPerDay: reg("outside_issues_per_day", "int", 5, { owner: "intake" }, (r) => intIn(r, 0, Infinity, 5)),
  outsideSurgePerHour: reg("outside_surge_per_hour", "int", 30, { owner: "intake" }, (r) => intIn(r, 0, Infinity, 30)),
  singleMergeMax: reg("single_merge_max", "int", 3, { owner: "merge" }, (r) => intIn(r, 0, 100, 3)),
  reviewMinIntervalMinutes: reg("review_min_interval_minutes", "int", 120, { owner: "review" }, (r) => intIn(r, 0, 7 * 24 * 60, 120)),
  warmMinIntervalMinutes: reg("warm_min_interval_minutes", "int", 15, { owner: "build" }, (r) => intIn(r, 0, 24 * 60, 15)),
  warmRepos: reg<string[]>("warm_repos", "json", [], { owner: "build" }, (r) => strings(jsonOf(r ?? "[]")).sort()),
  warmReposExcluded: reg<string[]>("warm_repos_excluded", "json", [], { owner: "build" }, (r) => strings(jsonOf(r ?? "[]")).sort()),
  workspaceExclude: reg<string[]>("workspace_exclude", "json", [], { owner: "sandbox" }, (r) => {
    const v = jsonOf(r);
    return Array.isArray(v) && v.every((x) => typeof x === "string" && REPO_LIST_NAME.test(x)) ? [...new Set((v as string[]).map((n) => n.trim()))].sort() : [];
  }),
  prBuildsPerDay: reg("pr_builds_per_day", "int", 10, { owner: "build", shown: false }, (r) => intIn(r, 0, Infinity, 10)),
  postmergeSince: reg("postmerge_since", "text", "9999", { owner: "review" }, (r) => r ?? "9999"),
  /** Merges outside the pipeline's scope (the repo's switch is off and the work on the item ended with the merge) are reviewed from this time on. */
  postmergeUnscopedSince: reg("postmerge_unscoped_since", "text", "9999", { owner: "review" }, (r) => r ?? "9999"),
  discordIssueDailyUsd: reg("discord_issue_daily_usd", "float", 2, { owner: "discord" }, (r) => { const v = Number(r); return Number.isFinite(v) && v >= 0 ? v : 2; }),
  discordSignalDailyUsd: reg("discord_signal_daily_usd", "float", 1, { owner: "discord" }, (r) => { const v = Number(r); return Number.isFinite(v) && v >= 0 ? v : 1; }),
  /** The raw reaction emoji; the Discord module checks it and applies its default. */
  discordReactEmoji: reg<string | null>("discord_react_emoji", "text", null, { owner: "discord" }, (r) => (r ? r : null)),
  discordReact: reg("discord_react", "bool", true, { owner: "discord" }, (r) => r !== "off"),
  discordContact: reg("discord_contact", "text", "", { owner: "discord" }, (r) => r ?? ""),
  livenessLongDays: reg("liveness_long_days", "int", 7, { owner: "workflow" }, (r) => { const v = Number(r); return Number.isFinite(v) && v > 0 ? v : 7; }),
  /** The raw `remote_models` object (model families per tier and effort floors); the runners module checks and applies it. */
  remoteModels: reg<Record<string, unknown>>("remote_models", "json", {}, { owner: "runners" }, (r) => { const v = jsonOf(r); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; }),
  remotePickMinutes: reg("remote_pick_minutes", "int", 15, { owner: "runners" }, (r) => intIn(r, 0, 24 * 60, 15)),
  jevEnabled: reg("jev_enabled", "bool", true, { owner: "inference" }, (r) => r !== "no"),
  /** Where model-call transcripts are stored (src/transcripts): JSON with the bucket's secret sealed; read through src/transcripts only. */
  transcriptStore: reg<string | null>("transcript_store", "json", null, { owner: "inference", shown: false }, (r) => r ?? null),
  planShadow: reg<"on" | "off">("plan_shadow", "text", "off", { owner: "planner" }, (r) => (r === "on" ? "on" : "off")),
  /** The tracked repo the hourly self-evaluation reads and files its issues on (src/eval); null: the evaluation is off. */
  evalRepo: reg<string | null>("eval_repo", "text", null, { owner: "eval" }, (r) => { const v = r?.trim(); return v && REPO_LIST_NAME.test(v) ? v : null; }),
  /** The fix steps that work in fix sessions (src/fixsession), with `review` for the reviews that run in their workspaces, and the repos they do it in (null: every repo). */
  fixSessions: reg<FixSessionsSetting>("fix_sessions", "json", { steps: [], repos: null }, { owner: "fixup" }, (r) => {
    const v = jsonOf(r) as { steps?: unknown; repos?: unknown } | undefined;
    if (!v || typeof v !== "object") return { steps: [], repos: null };
    const steps = FIX_SESSION_SWITCHES.filter((s) => strings(v.steps).includes(s));
    const repos = Array.isArray(v.repos) ? [...new Set(strings(v.repos).filter((n) => REPO_LIST_NAME.test(n)))].sort() : null;
    return { steps, repos };
  }),
  /** The instance-wide build feature switch (`build_feature:scan-tests`). */
  scanTestsEnabled: reg("build_feature:scan-tests", "bool", false, { owner: "build", shown: false }, (r) => r === "on"),
};

/** Repo-scope keys: the stored key is `<name>:<repo>` (`build_feature:<feature>:<repo>`). */
export const REPO_SETTINGS = {
  optionalChecks: reg<string[]>("optional_checks", "json", [...DEFAULT_OPTIONAL_CHECKS], { owner: "review", scope: "repo" }, (r) => strings(jsonOf(r)).filter((x) => x !== "")),
  prBuildsScope: reg<"all" | "outside">("pr_builds_scope", "text", "outside", { owner: "build", scope: "repo", shown: false }, (r) => (r === "all" ? "all" : "outside")),
  batchSize: reg("batch_size", "int", 20, { owner: "merge", scope: "repo" }, (r) => intIn(r, 1, 50, 20)),
  testRepo: reg("test_repo", "bool", false, { owner: "control", scope: "repo" }, (r) => r !== undefined),
  buildFeature: reg("build_feature", "bool", false, { owner: "build", scope: "repo", shown: false }, (r) => r === "on"),
};

/** Every declared key: instance keys by property, repo keys by property. */
export const REGISTRY: readonly Reg<unknown>[] = [...Object.values(SETTINGS), ...Object.values(REPO_SETTINGS)];

/** Keys the code still reads or writes in `settings` that the registry does not carry. They end with the build: state keys move to their module's tables (conventions 4.3), retired keys are deleted. */
export const RETIRED_SETTINGS = ["usage_pause", "inference", "judgement_model", "maintainer_writes", "pilot_items", "flow_summary_marks", "outside_admitted_backfill", "fixissue_not_rust"] as const;
export const STATE_SETTINGS = [
  "limit_reset_at", "merge_approved", "push_approved", "comment_approved", "fixissue_approved", "labels_approved", "mainfix_approved", "prstatus_approved", "ci_approved",
  "warm_report", "warm_bytes", "warm_gc_at", "warm_trimmed_publish", "warm_rebuild", "worker_update_pending", "worker_update_failures", "worker_update_attempts", "org_high_water", "full_sync_cursor", "classify_run",
  "liveness_at", "liveness_open", "runner_heartbeat", "main_ci_polled_at", "releases_polled_at", "releases_offset", "search_catchup_at", "repos_refreshed_at", "pipeline_planned_at",
  "pipeline_seqs_seen", "pipeline_wake_at", "pipeline_status", "pipeline_review_cursor", "pipeline_verify_cursor", "review_stale", "review_rerun", "review_fail", "mergeable_unknown",
  "author_ids_error", "author_ids_backfilled", "jev_unavailable", "security_poll_at", "diff_facts_built", "leader:runner:endpoint", "app_install_sweep_at", "tracking_started_at",
  "sync_rate_remaining", "sync_rate_reset_at", "choices_converted", "discord_role_channel", "discord_role_id", "discord_role_panel",
] as const;

/** The typed instance properties of `config(db)`. */
export type InstanceConfig = { readonly [K in keyof typeof SETTINGS]: ReturnType<(typeof SETTINGS)[K]["read"]> };

const BY_KEY = new Map<string, Reg<unknown>>(Object.values(SETTINGS).map((d) => [d.name, d]));
const REPO_BY_NAME = new Map<string, Reg<unknown>>(Object.values(REPO_SETTINGS).map((d) => [d.name, d]));

/** The `settings.key` of a registry key for a repo (or the key itself for an instance key). */
export const settingKey = (key: SettingKey, repo?: string): string => (repo === undefined ? key : `${key}:${repo}`);

/** The registry entry and repo of a stored key, or null for a key the registry does not carry. */
export function defOf(key: string): { def: Reg<unknown>; repo: string | null } | null {
  const exact = BY_KEY.get(key);
  if (exact) return { def: exact, repo: null };
  const colon = key.indexOf(":");
  const base = key.slice(0, colon);
  const def = colon < 0 ? undefined : REPO_BY_NAME.get(base);
  if (!def) return null;
  const rest = key.slice(base.length + 1);
  return { def, repo: base === "build_feature" ? rest.slice(rest.indexOf(":") + 1) : rest };
}

type Get = (key: string) => string | undefined;

function repoConfig(get: Get, repo: string): RepoConfig {
  const at = (d: Reg<unknown>, extra = "") => d.read(get(`${d.name}:${extra}${repo}`));
  return {
    get optionalChecks() { return at(REPO_SETTINGS.optionalChecks) as string[]; },
    get prBuildsScope() { return at(REPO_SETTINGS.prBuildsScope) as "all" | "outside"; },
    get batchSize() { return at(REPO_SETTINGS.batchSize) as number; },
    get testRepo() { return at(REPO_SETTINGS.testRepo) as boolean; },
    buildFeature: (feature: string) => at(REPO_SETTINGS.buildFeature, `${feature}:`) as boolean,
  };
}

/** The `Config` over any reader of stored values; properties read on access. */
function makeConfig(get: Get): Config {
  const c: Record<string, unknown> = { repo: (repo: string) => repoConfig(get, repo) };
  for (const [prop, d] of Object.entries(SETTINGS)) Object.defineProperty(c, prop, { enumerable: true, get: () => d.read(get(d.name)) });
  return c as unknown as Config;
}

// ---- the snapshot ------------------------------------------------------------------------------------------------------

type Store = {
  db: Db; map: Map<string, string | null>; live: ReadonlySet<string>; watch: boolean; dirty: boolean; reread?: Promise<void>; at: number;
  /** Writes of the table seen on the handle. */
  writes: number;
  /** The reading of each open transaction that found the snapshot due, for that transaction alone; `writes` as of that reading. */
  tx: WeakMap<object, { read: Promise<SettingsSnapshot>; map?: SettingsSnapshot; writes: number }>;
};

/** The snapshot of the pass running in the current async context, for the handle it was read on. */
const pass = new AsyncLocalStorage<Store>();

// A watching snapshot (a job's) reads the table again after any write to it on its handle, whoever issues the write,
// so a step reads back what it wrote. A planner pass writes its cursors through writeSetting, which keeps its map current.
onSettingsWrite((db) => {
  const s = pass.getStore();
  if (s?.watch && s.db === db) {
    s.dirty = true;
    s.writes++;
  }
});

/** A watching snapshot older than this is read again, so settings other processes change reach a long job. */
const MAX_AGE_MS = 5000;

/** Runs `fn` with the reads of a job's snapshot taken from the table, for the checks that guard a GitHub write (a planner pass keeps its reading). */
export const freshSettings = <T>(fn: () => Promise<T>): Promise<T> => pass.getStore()?.watch ? pass.exit(fn) : fn();

/**
 * The snapshot's map, read again first when it is watching and due; undefined outside a snapshot on `db` and for `live` keys.
 * A read due is shared by the contexts that wait for it, except inside a transaction: a transaction that waited for a read
 * queued behind its own connection would never end. It reads on its own connection, once unless the table is written, keeps
 * that reading to itself (it may be older than the shared one, or never be committed) and leaves the shared read due.
 */
const snapshotOf = async (db: Db, ...keys: string[]): Promise<Map<string, string | null> | undefined> => {
  const s = pass.getStore();
  if (s?.db !== db || keys.some((k) => s.live.has(k))) return undefined;
  if (s.watch && Date.now() - s.at > MAX_AGE_MS) s.dirty = true;
  const read = (): Promise<SettingsSnapshot> => db.fresh(() => readSettingsSnapshot(db));
  const tx = db.transaction();
  if (tx) {
    const had = s.tx.get(tx);
    if (had?.writes === s.writes) return await had.read;
    if (!had && !s.dirty) return s.map;
    const own: NonNullable<typeof had> = { read: read(), writes: s.writes };
    s.tx.set(tx, own);
    // A read that failed is made again by the next caller.
    void own.read.then((m) => { own.map = m; }, () => { if (s.tx.get(tx) === own) s.tx.delete(tx); });
    return await own.read;
  }
  while (s.dirty || s.reread) {
    if (!s.reread) {
      s.dirty = false;
      s.reread = read().then((m) => { s.map = m; s.at = Date.now(); }, (e) => { s.dirty = true; throw e; }).finally(() => { s.reread = undefined; });
    }
    await s.reread;
  }
  return s.map;
};

/** The stored values as this context's last reading has them: its transaction's, else the shared ones. */
const mapOf = (s: Store): Map<string, string | null> => {
  const tx = s.db.transaction();
  return (tx && s.tx.get(tx)?.map) || s.map;
};

/** Keeps the snapshot on `db` current after a write; null deletes. */
function noteWritten(db: Db, rows: Iterable<readonly [string, string | null]>): void {
  const s = pass.getStore();
  if (s?.db !== db) return;
  for (const map of new Set([s.map, mapOf(s)])) for (const [key, value] of rows) {
    if (value === null) map.delete(key);
    else map.set(key, value);
  }
}

export interface SnapshotOptions {
  /** Keys every read takes from the table: settings a running step polls (the pipeline switch, limits). */
  live?: readonly string[];
  /** Read the table again after a write to it on this handle, from any code path. */
  watchWrites?: boolean;
}

/**
 * Runs `fn` with the settings reads on `db` served from one reading of the table. The snapshot belongs to the async context
 * of `fn`: work that runs meanwhile outside it (other requests, timers) reads the table. Inside, writeSetting/deleteSetting
 * keep it current; a snapshot already open on `db` serves it, read again first when due. Other contexts and connections (the runner thread, the dashboard) keep writing: the pass sees settings as
 * they were at its start (except the `live` keys), and applyProposals re-checks limits and blocks with fresh reads.
 */
export async function withSettingsSnapshot<T>(db: Db, fn: () => Promise<T>, read?: Promise<SettingsSnapshot>, opts: SnapshotOptions = {}): Promise<T> {
  if (pass.getStore()?.db === db) {
    await snapshotOf(db);
    return await fn();
  }
  return await pass.run({ db, map: await (read ?? readSettingsSnapshot(db)), live: new Set(opts.live), watch: !!opts.watchWrites, dirty: false, at: Date.now(), writes: 0, tx: new WeakMap() }, fn);
}

export type SettingsSnapshot = Map<string, string | null>;

/** One reading of the table for withSettingsSnapshot, so a caller can start it alongside its other reads. */
export async function readSettingsSnapshot(db: Db): Promise<SettingsSnapshot> {
  const q = queryDb(db);
  return new Map((await q.all(q.k.selectFrom("main.settings").select(["key", "value"]))).map((r) => [r.key, r.value]));
}

/** Reads the table again for the snapshot of a pass on `db` (none: nothing), so a pass sees the settings of a read transaction it opens later. */
export async function rereadSettingsSnapshot(db: Db): Promise<void> {
  const s = pass.getStore();
  if (s?.db !== db) return;
  s.map = await readSettingsSnapshot(db);
}

/** The stored value, undefined when the key has no row. */
export async function setting(db: Db, key: string): Promise<string | undefined> {
  const snap = await snapshotOf(db, key);
  if (snap) return snap.get(key) ?? undefined;
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("main.settings").select("value").where("key", "=", key)))?.value ?? undefined;
}

/** The stored values of `keys` in one read; keys without a row are left out. */
export async function settings(db: Db, keys: string[]): Promise<Map<string, string>> {
  const snap = await snapshotOf(db, ...keys);
  if (snap) return new Map(keys.flatMap((k) => { const v = snap.get(k); return v == null ? [] : [[k, v] as const]; }));
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.settings").select(["key", "value"]).where(kx.inList(db, "key", keys)));
  return new Map(rows.flatMap((r) => r.value == null ? [] : [[r.key, r.value] as const]));
}

/** The rows of `keys` in one read, NULL values kept; keys without a row are left out. */
export async function settingRows(db: Db, keys: string[]): Promise<Map<string, string | null>> {
  const snap = await snapshotOf(db, ...keys);
  if (snap) return new Map(keys.flatMap((k) => snap.has(k) ? [[k, snap.get(k)!] as const] : []));
  const q = queryDb(db);
  return new Map((await q.all(q.k.selectFrom("main.settings").select(["key", "value"]).where(kx.inList(db, "key", keys)))).map((r) => [r.key, r.value] as const));
}

/** True when the key has a row. */
export async function hasSetting(db: Db, key: string): Promise<boolean> {
  const snap = await snapshotOf(db, key);
  if (snap) return snap.has(key);
  const q = queryDb(db);
  return !!await q.get(q.k.selectFrom("main.settings").select("key").where("key", "=", key));
}

export async function writeSetting(db: Db, key: string, value: string): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.settings").values({ key, value }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  noteWritten(db, [[key, value]]);
}

export async function deleteSetting(db: Db, key: string): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("main.settings").where("key", "=", key));
  noteWritten(db, [[key, null]]);
}

// ---- configuration ----------------------------------------------------------------------------------------------------

/** Runs `fn` with one settings snapshot in its async context (replaces `withSettingsSnapshot`); no statement when `preload` is given, else one. */
export async function withConfig<T>(db: Db, fn: () => Promise<T>, o?: { live?: readonly string[]; watchWrites?: boolean; preload?: ControlSnapshot }): Promise<T> {
  const read = o?.preload ? Promise.resolve(new Map(o.preload.settings)) : undefined;
  return await withSettingsSnapshot(db, fn, read, { live: o?.live, watchWrites: o?.watchWrites });
}

/**
 * Sync accessor on the async-context snapshot: typed instance properties and `.repo(repo)` for repo-scope keys. Values are
 * those of the snapshot's last reading: current at the start of a `withConfig` block, not after a long wait inside one, where
 * a job takes `readConfig`. Live keys are read through `loadLiveConfig`. Throws outside a snapshot.
 */
export function config(db: Db): Config {
  const s = pass.getStore();
  if (s?.db !== db) throw new Error("config: no settings snapshot on this handle (wrap the unit of work in withConfig)");
  return makeConfig((k) => mapOf(s).get(k) ?? undefined);
}

/**
 * `keys` from the unit of work's snapshot, read again first when it is due, so a switch changed by another process reaches a
 * running job within MAX_AGE_MS; outside a snapshot, from the table in one read. `keys` are stored keys (repo keys as `<name>:<repo>`).
 */
export async function readConfig(db: Db, keys: readonly string[]): Promise<Config> {
  const map = await snapshotOf(db, ...keys);
  return map ? makeConfig((k) => map.get(k) ?? undefined) : await freshConfig(db, keys);
}

/** All settings rows, tracked repos, step approvals, active trips and limits. */
export async function loadControl(db: Db): Promise<ControlSnapshot> {
  // Approvals of untracked repos come along too (their rows survive untracking); callers look them up by tracked name.
  const [settings, tracked, trips, limits, approvals] = await db.together(() => Promise.all([readSettingsSnapshot(db), loadTrackedRepos(db), loadTrips(db, { active: true }), loadStageLimits(db), loadStepApprovals(db, "all")]));
  return { settings, tracked, approvals, trips, limits };
}

/** Bypasses the snapshot, for the checks that guard a GitHub write; `keys` are stored keys (repo keys as `<name>:<repo>`). */
export async function freshConfig(db: Db, keys: readonly SettingKey[]): Promise<Config> {
  const q = queryDb(db);
  const rows = new Map((await q.all(q.k.selectFrom("main.settings").select(["key", "value"]).where(kx.inList(db, "key", [...keys])))).map((r) => [r.key, r.value] as const));
  return makeConfig((k) => rows.get(k) ?? undefined);
}

const LIVE_KEYS = [...new Set(Object.values(SETTINGS).filter((d) => d.live).map((d) => d.name))];
const LIVE_TTL_MS = 2000;
const liveCache = new WeakMap<Db, { at: number; value: Promise<LiveConfig> }>();

/** The live keys only, cached 2 s per process. */
export function loadLiveConfig(db: Db): Promise<LiveConfig> {
  const hit = liveCache.get(db);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.value;
  const q = queryDb(db);
  const value = q.all(q.k.selectFrom("main.settings").select(["key", "value"]).where(kx.inList(db, "key", LIVE_KEYS))).then((rows) => {
    const m = new Map(rows.map((r) => [r.key, r.value] as const));
    const c = makeConfig((k) => m.get(k) ?? undefined);
    return { pipelineEnabled: c.pipelineEnabled, drain: c.pipelineDraining, changedBy: c.pipelineChangedBy, changedAt: c.pipelineChangedAt, jevParallel: c.jevParallel, stepParallel: c.stepParallel };
  });
  liveCache.set(db, { at: Date.now(), value });
  void value.catch(() => { if (liveCache.get(db)?.value === value) liveCache.delete(db); });
  return value;
}

/** Batched upsert and delete (`value: null` deletes); keeps the snapshot current and writes one audit row for the batch; joins the caller's transaction, else opens one. */
export async function saveSettings(db: Db, rows: SettingPatch[], by: string, audit?: { action: string; target?: string; details?: unknown }): Promise<number> {
  if (!rows.length) return 0;
  const keyed = new Map<string, string | null>();
  for (const r of rows) {
    if (!defOf(settingKey(r.key, r.repo))) throw new Error(`unknown setting ${settingKey(r.key, r.repo)}`);
    keyed.set(settingKey(r.key, r.repo), r.value);
  }
  const sets = [...keyed].flatMap(([key, value]) => value === null ? [] : [{ key, value }]);
  const dels = [...keyed].flatMap(([key, value]) => value === null ? [key] : []);
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(sets)) await q.run(q.k.insertInto("main.settings").values(part).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
    for (const part of kx.batches(dels)) await q.run(q.k.deleteFrom("main.settings").where(kx.inList(db, "key", part)));
    await addAudit(db, [{ login: by, action: audit?.action ?? "settings-save", target: audit?.target ?? "settings", details: audit?.details ?? { set: sets.map((s) => s.key), deleted: dels } }]);
  });
  noteWritten(db, [...keyed]);
  return keyed.size;
}

/** Read model for the admin settings page: every stored row with its registry entry (null for a key the registry does not carry). `shown` keeps the rows the page lists. */
export async function listSettings(db: Db, f?: { scope?: "instance" | "repo"; shown?: boolean }): Promise<SettingRow[]> {
  const q = queryDb(db);
  const rows = (await q.all(q.k.selectFrom("main.settings").select(["key", "value"]).orderBy("key"))).map((r): SettingRow => {
    const d = defOf(r.key);
    return { key: r.key, repo: d?.repo ?? null, value: r.value, def: d?.def ?? null };
  });
  return rows.filter((r) => (!f?.scope || r.def?.scope === f.scope) && (!f?.shown || (r.def !== null && r.def.shown !== false)));
}

// ---- test repos ---------------------------------------------------------------------------------------------------------

/** The `test_repo:<repo>` flag. */
export async function isTestRepo(db: Db, repo: string): Promise<boolean> {
  return await hasSetting(db, settingKey("test_repo", repo));
}

/** Repos flagged as test repos, by name. */
export async function testRepos(db: Db): Promise<string[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.settings").select("key").where((eb) => kx.like(db, "key", eb.val(`${kx.likeEscape("test_repo:")}%`), "\\")).orderBy("key"));
  return rows.map((r) => r.key.slice("test_repo:".length));
}

/** Sets the flag; throws for an untracked repo and does nothing when the flag already matches. */
export async function setTestRepo(db: Db, repo: string, on: boolean, by: string): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const [tracked, flagged] = await db.together(() => Promise.all([
      q.get(q.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo)),
      q.get(q.k.selectFrom("main.settings").select("key").where("key", "=", settingKey("test_repo", repo))),
    ]));
    if (!tracked) throw new Error(`${repo} is not tracked`);
    if ((flagged !== undefined) === on) return;
    await saveSettings(db, [{ key: "test_repo", repo, value: on ? "1" : null }], by, { action: "test-repo", target: repo, details: { on } });
  });
}
