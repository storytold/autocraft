// Change markers: one counter per topic in `change_seq`, bumped by triggers on the
// tables the dashboard reads. Triggers fire for writes from every process (runner,
// sync, sandbox worker, dashboard), so no code path can forget to signal.
import type { DatabaseSync } from "node:sqlite";

/**
 * Columns that move without a change to what a page shows: fetch and compute times, content hashes
 * derived from other columns, and flags the runner flips for its own use. An UPDATE that changes only
 * these bumps nothing. Every other column of a table is compared (see liveSql).
 */
export const BOOKKEEPING_COLUMNS: Record<string, string[]> = {
  workspaces: ["updated_at", "last_call_at", "next_call", "create_tries", "pod_created_at"],
  repos: ["synced_at", "high_water", "reconciled_at"],
  items: ["embed_hash", "class_hash", "class_scheme", "text_refs"],
  classifications: ["at", "input_hash"],
  pr_checks: ["fetched_at"],
  main_ci: ["updated_at"],
  release_assets: ["updated_at"],
  release_apps: ["updated_at"],
  ci_run_approvals: ["checked_at"],
  item_priority: ["at"],
  item_rank: ["computed_at"],
  duplicate_scans: ["at"],
  item_plans: ["planned_at"],
  lane_next: ["at"],
  item_workflows: ["updated_at", "version"],
  classify_state: ["at"],
};

/** Settings the runner, the sync and the planner write for their own use; the dashboard shows none of them. */
export const BOOKKEEPING_SETTINGS = [
  "runner_heartbeat", "schema_stamp", "schema_generation", "fts_built", "hashes_built", "text_refs_built", "diff_facts_built", "mentions_built", "item_stage_built", "tracking_started_at",
  "pipeline_planned_at", "pipeline_seqs_seen", "pipeline_wake_at", "pipeline_status", "pipeline_sync_seen", "pipeline_sync_at", "pipeline_review_cursor", "pipeline_verify_cursor",
  "full_sync_cursor", "org_high_water", "main_ci_polled_at", "releases_polled_at", "releases_offset", "search_catchup_at", "repos_refreshed_at", "sync_rate_remaining", "sync_rate_reset_at",
  "flow_summary_marks", "warm_gc_at", "warm_report", "liveness_at", "liveness_open", "classify_run", "discord_role_panel", "worker_update_pending", "worker_update_failures",
];
const BOOKKEEPING_SETTING_LIKE = ["leader:%", "warm\\_bytes:%", "%\\_points\\_last\\_run", "pipeline\\_fp:%", "build\\_feature:%", "pr\\_builds\\_%"];

/** SQL condition on `key` that is true for the settings that matter to a page. */
export function shownSettings(key: string): string {
  const names = BOOKKEEPING_SETTINGS.map((k) => `'${k}'`).join(", ");
  const likes = BOOKKEEPING_SETTING_LIKE.map((l) => ` AND ${key} NOT LIKE '${l}' ESCAPE '\\'`).join("");
  return `${key} NOT IN (${names})${likes}`;
}

/** One table's contribution to a topic: its writes bump the topic's counter when `when` (SQLite syntax, `new`/`old` rows) holds. */
export type Source = {
  table: string; ops?: ("INSERT" | "UPDATE" | "DELETE")[]; when?: string;
  /** The Postgres form of `when`, for a condition the mechanical rewrite (pgExpr in src/core/pg-expr.ts) cannot translate. */
  pg?: string;
};

/**
 * The live topics, in the order their triggers are made. A table that two non-private topics both list gets one trigger, the
 * later topic's, so this order decides which source of such a table counts.
 */
export const TOPICS: string[] = [
  "repos", "sync", "items", "ranks", "stages", "checks", "mainci", "classify", "dupes", "reviews", "queue", "workflows", "workflow-events",
  "outside", "plans", "jobs", "limits", "usage", "agents", "envs", "build-features", "pr-builds", "nightly", "workspaces", "tasks", "actions",
  "conversations", "fixes", "verify", "preapprovals", "discord", "discord-links", "discord-verify", "downloads", "security", "postmerge", "access", "settings",
  "steps", "rank-inputs", "trace", "remote-helpers", "remote-queue", "remote-room", "remote-calls", "plan-inputs", "job-ends", "task-ends", "github", "auto-stops",
  "statement-sources", "chat", "prompts",
];

/** Topics that read tables other topics already watch: their triggers have names of their own. */
const OWN_NAMES = new Set(["steps", "trace", "limits", "build-features", "rank-inputs", "remote-queue", "remote-room", "plan-inputs", "job-ends", "task-ends", "auto-stops", "statement-sources"]);

/** Topics whose counter moves also send a notification on the channel of the same name (Postgres), for `Db.listen`. */
export const NOTIFY_TOPICS = ["settings", "prompts"];

const registered = new Map<string, Source[]>();

/**
 * Adds the tables of one module to a topic. Each module registers the sources of the tables it owns (src/data/<module>/triggers.ts,
 * loaded by src/trigger-sources.ts), so src/db names no table of any module's.
 */
export function registerTriggerSource(topic: string, ...sources: Source[]): void {
  if (!TOPICS.includes(topic)) throw new Error(`registerTriggerSource: unknown topic ${topic}`);
  registered.set(topic, [...(registered.get(topic) ?? []), ...sources]);
}

/** topic -> the tables whose changes it reports. */
export function topicTables(): Record<string, Source[]> {
  const missing = TOPICS.filter((t) => !registered.has(t));
  if (missing.length) throw new Error(`live topics without sources (${missing.join(", ")}): load src/trigger-sources.ts before generating triggers`);
  return Object.fromEntries(TOPICS.map((t) => [t, registered.get(t)!]));
}


const ALL_OPS = ["INSERT", "UPDATE", "DELETE"] as const;

/** The columns an UPDATE of `table` must change to count: all of them but the bookkeeping ones. */
export function watchedColumns(table: string, columns: Map<string, string[]> | undefined): string[] | null {
  const all = columns?.get(table);
  if (!all) return null;
  const skip = new Set(BOOKKEEPING_COLUMNS[table] ?? []);
  return all.filter((c) => !skip.has(c));
}

/** Column names of every table, for the UPDATE conditions. */
export function columnsOf(db: DatabaseSync): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { name } of db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    out.set(name, (db.prepare(`PRAGMA main.table_info('${name}')`).all() as { name: string }[]).map((c) => c.name));
  }
  return out;
}

/** One live trigger: an AFTER `op` on `table` that bumps `topic` when `cond` (SQLite syntax, `new`/`old` rows) holds. */
export type LiveTrigger = { name: string; topic: string; table: string; op: "INSERT" | "UPDATE" | "DELETE"; cond: string; /** The Postgres form of `cond`, when it is not the mechanical rewrite. */ pg?: string };

/**
 * The topics' triggers. With `columns`, an UPDATE trigger fires only when a watched column changed. Two sources that make the
 * same name are one trigger, the later one, as SQLite keeps it (DROP and CREATE again).
 */
export function liveTriggers(columns?: Map<string, string[]>): LiveTrigger[] {
  const out = new Map<string, LiveTrigger>();
  for (const [topic, sources] of Object.entries(topicTables())) {
    for (const { table, ops = ALL_OPS, when, pg } of sources) {
      for (const op of ops) {
        // A settings source outside the `settings` topic reads that topic's table.
        const own = OWN_NAMES.has(topic) || (table === "settings" && topic !== "settings");
        const name = `live_${own ? `${topic.replace(/\W/g, "_")}_` : ""}${table}_${op[0]!.toLowerCase()}`;
        const key = op === "DELETE" ? "old.key" : "new.key";
        let cond = when ? when.replaceAll("new_key", key) : "";
        if (op === "UPDATE" && !when) {
          const watched = watchedColumns(table, columns);
          if (watched?.length) cond = watched.map((c) => `old."${c}" IS NOT new."${c}"`).join(" OR ");
        }
        out.delete(name);
        out.set(name, { name, topic, table, op, cond, ...(pg ? { pg } : {}) });
      }
    }
  }
  return [...out.values()];
}

/** The marker table's DDL (SQLite; src/db/pg-triggers.ts translates it). */
export const CHANGE_SEQ_TABLE = "CREATE TABLE IF NOT EXISTS main.change_seq (topic TEXT PRIMARY KEY, seq INTEGER NOT NULL, at TEXT) WITHOUT ROWID;";

/**
 * DDL for the marker table, its rows and the triggers. Idempotent: triggers are rebuilt. With `db`, an
 * UPDATE trigger fires only when a watched column changed, so a rewrite of identical values bumps nothing.
 * Postgres gets the same topics from src/db/pg-triggers.ts.
 */
export function liveSql(db?: DatabaseSync): string {
  const out = [CHANGE_SEQ_TABLE, ...TOPICS.map((t) => `INSERT OR IGNORE INTO main.change_seq (topic, seq, at) VALUES ('${t}', 0, NULL);`)];
  for (const { name, topic, table, op, cond } of liveTriggers(db ? columnsOf(db) : undefined)) {
    // Unqualified change_seq: a trigger body may not name a schema.
    out.push(`DROP TRIGGER IF EXISTS main.${name};`);
    out.push(`CREATE TRIGGER main.${name} AFTER ${op} ON ${table} ${cond ? `WHEN ${cond}` : ""} BEGIN
          UPDATE change_seq SET seq = seq + 1 WHERE topic = '${topic}';
        END;`);
  }
  return out.join("\n");
}
