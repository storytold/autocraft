// The live topics (src/db/live.ts) and the planner's change log (src/db/plan-triggers.ts) on Postgres: one plpgsql function per
// table and operation (AFTER ROW) evaluates every topic and change-log trigger SQLite has for that table and operation.
//
// Counter rows move once per transaction, at commit. A row trigger only records what it touched in transaction-local settings
// (topics in `ac.topics`, full-pass causes in `ac.causes`) and, on the first touch, inserts one row into `live_flush`. That
// insert queues a deferred constraint trigger, which runs at commit: it locks the touched change_seq rows in sorted order, then
// plan_full, then the plan_full_causes rows in sorted order, and bumps each once. Every transaction locks counters in that one
// order, so two cannot deadlock on them, and the bump commits with the data (a sequence would show before the commit).
// A topic in NOTIFY_TOPICS also sends a notification on its channel at that flush, for `Db.listen`.
// A rolled-back savepoint undoes its settings, its live_flush row and the queued trigger together.
//
// item_changes rows are inserted by the row triggers themselves; the planner consumes them by key (src/data/planner/changes.ts).
// The bulk marker is the transaction-local setting `ac.bulk` (PG_BULK).
import { createHash } from "node:crypto";
import { BOOKKEEPING_COLUMNS, CHANGE_SEQ_TABLE, liveTriggers, NOTIFY_TOPICS, TOPICS } from "./live.ts";
import { blockerFill, blockerSync, PG_BULK, PLAN_TABLES, planTriggers } from "./plan-triggers.ts";
import { pgExpr } from "../core/pg-expr.ts";
import { PIN_SEARCH_PATH, pgSchemaSql, pgSchemaStamp, withMigrationLock, type MigrationOpts, type PgClient } from "./pg-migrate.ts";
import { translateSqlite } from "./pg-schema.ts";
import { pgScopeViews, SCOPED_SCHEMA } from "./scoped.ts";
import { splitStageTripsPg, TRIP_SPLIT_VERSION } from "./trip-split.ts";
import { featuresRepoOnlyPg, FEATURES_REPO_ONLY_VERSION } from "./feature-repo-only.ts";
import { pingsSettledPg, PINGS_SETTLED_VERSION } from "./pings-settled.ts";
import { fixupDiffHeldPg, FIXUP_DIFF_VERSION } from "./fixup-diff-held.ts";
import { sonarOptionalPg, SONAR_OPTIONAL_VERSION } from "./sonar-optional.ts";
import { retireFixAttemptsPg } from "./fix-retire.ts";
import { backfillRefusalsPg } from "./refused-runs.ts";
import { backfillRunTokensPg } from "./run-tokens.ts";
import { holdsToItemsPg, HOLDS_TO_ITEMS_VERSION } from "./holds-to-items.ts";
import { chatBackfillPg, CHAT_BACKFILL_VERSION } from "./chat-backfill.ts";
import { PG_SCHEMA_GENERATION } from "./pg-generation.ts";
import { builtAfterCopy, copyStatePg, oneActiveLegPg } from "./state-copy.ts";

const OPS = ["INSERT", "UPDATE", "DELETE"] as const;
type Op = (typeof OPS)[number];

/** Separator of the causes list: source names are code strings, never multi-line. */
const NL = "E'\\n'";

const PROLOGUE = `-- SQLite's CAST(text AS INTEGER): the leading integer, else 0.
CREATE OR REPLACE FUNCTION ac_int(t text) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE WHEN t IS NOT NULL THEN COALESCE(substring(t from '^\\s*([+-]?[0-9]{1,18})')::bigint, 0) END;
-- One row per writing transaction that touched a counter, inserted and deleted inside it: it queues the commit-time flush.
CREATE UNLOGGED TABLE IF NOT EXISTS live_flush (xid xid8 PRIMARY KEY);
CREATE OR REPLACE FUNCTION ac_schedule() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('ac.flush', true) IS DISTINCT FROM '1' THEN
    PERFORM set_config('ac.flush', '1', true);
    INSERT INTO live_flush (xid) VALUES (pg_current_xact_id());
  END IF;
END $$;
CREATE OR REPLACE FUNCTION ac_touch(topic text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE cur text := COALESCE(current_setting('ac.topics', true), '');
BEGIN
  IF strpos(cur, ',' || topic || ',') = 0 THEN
    PERFORM set_config('ac.topics', CASE WHEN cur = '' THEN ',' ELSE cur END || topic || ',', true);
    PERFORM ac_schedule();
  END IF;
END $$;
CREATE OR REPLACE FUNCTION ac_mark_full(source text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE cur text := COALESCE(current_setting('ac.causes', true), '');
BEGIN
  IF strpos(cur, ${NL} || source || ${NL}) = 0 THEN
    PERFORM set_config('ac.causes', CASE WHEN cur = '' THEN ${NL} ELSE cur END || source || ${NL}, true);
    PERFORM ac_schedule();
  END IF;
END $$;
CREATE OR REPLACE FUNCTION ac_flush() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  topics text[] := ARRAY(SELECT DISTINCT t FROM unnest(string_to_array(COALESCE(current_setting('ac.topics', true), ''), ',')) t WHERE t <> '' ORDER BY t);
  causes text[] := ARRAY(SELECT DISTINCT c FROM unnest(string_to_array(COALESCE(current_setting('ac.causes', true), ''), ${NL})) c WHERE c <> '' ORDER BY c);
  gen bigint;
BEGIN
  IF cardinality(topics) > 0 THEN
    PERFORM 1 FROM change_seq WHERE topic = ANY (topics) ORDER BY topic FOR UPDATE;
    UPDATE change_seq SET seq = seq + 1 WHERE topic = ANY (topics);
${NOTIFY_TOPICS.map((t) => `    IF '${t}' = ANY (topics) THEN PERFORM pg_notify('${t}', ''); END IF;`).join("\n")}
  END IF;
  IF cardinality(causes) > 0 THEN
    INSERT INTO plan_full (id, seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
    UPDATE plan_full SET seq = seq + 1 WHERE id = 1 RETURNING seq INTO gen;
    INSERT INTO plan_full_causes (source, n, last_seq) SELECT c, 1, gen FROM unnest(causes) c ORDER BY c
      ON CONFLICT (source) DO UPDATE SET n = plan_full_causes.n + 1, last_seq = excluded.last_seq;
  END IF;
  DELETE FROM live_flush WHERE xid = NEW.xid;
  PERFORM set_config('ac.topics', '', true), set_config('ac.causes', '', true), set_config('ac.flush', '', true);
  RETURN NULL;
END $$;`;

const ifThen = (cond: string, body: string, indent: string): string =>
  cond ? `${indent}IF ${cond} THEN\n${indent}  ${body}\n${indent}END IF;` : `${indent}${body}`;

/** The parts of the live topics and the change log, in the order a migration applies them. */
export interface PgTriggerParts {
  /** Helper functions, the tables the triggers write to and their seed rows: idempotent DDL for Migration.ddl. */
  ddl: string;
  /** Every trigger function (CREATE OR REPLACE FUNCTION): no table locks. */
  functions: string[];
  /** CREATE OR REPLACE TRIGGER per table. */
  triggers: Map<string, { name: string; sql: string }[]>;
  /** Creates the commit-time flush trigger when it is missing (a constraint trigger cannot be replaced). */
  flush: string;
  /** Rebuilds review_blockers from opus_reviews. */
  blockers: string[];
}

/**
 * The tables, functions, triggers and rows of the live topics and the change log, for a database that has the schema of
 * src/schema.pg.sql. Idempotent. With `columns` (pgColumns), an UPDATE counts only when a watched column changed.
 */
export function pgTriggerParts(columns?: Map<string, string[]>): PgTriggerParts {
  // Indexes on schema tables are plain SQL both dialects take; the translator only knows the tables it is given.
  const ddl = [CHANGE_SEQ_TABLE, ...PLAN_TABLES].map((s) => s.replaceAll("main.", ""));
  const own = (s: string) => !/^CREATE INDEX/.test(s) || /\bON review_blockers\(/.test(s);
  const tables = [translateSqlite(ddl.filter(own).join("\n")), ...ddl.filter((s) => !own(s))].join("\n");
  const groups = new Map<string, { table: string; op: Op; topics: Map<string, string[]>; plan: string[] }>();
  const group = (table: string, op: Op) => {
    const key = `${table}|${op}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { table, op, topics: new Map(), plan: [] }));
    return g;
  };
  for (const t of liveTriggers(columns)) {
    const g = group(t.table, t.op);
    g.topics.set(t.topic, [...(g.topics.get(t.topic) ?? []), t.pg ?? (t.cond ? pgExpr(t.cond) : "")]);
  }
  for (const t of planTriggers("postgres", columns)) {
    const body = "full" in t ? `PERFORM ac_mark_full('${t.full}');`
      : `INSERT INTO item_changes (repo, number) SELECT s.repo, s.number FROM (${t.refs}) AS s WHERE s.repo IS NOT NULL AND s.number IS NOT NULL;`;
    group(t.table, t.op).plan.push(ifThen(t.cond, body, "    "));
  }
  const sync = blockerSync("postgres");
  for (const op of OPS) group("opus_reviews", op);
  const functions: string[] = [];
  const triggers = new Map<string, { name: string; sql: string }[]>();
  for (const { table, op, topics, plan } of [...groups.values()].sort((a, b) => (`${a.table}|${a.op}` < `${b.table}|${b.op}` ? -1 : 1))) {
    const o = op[0]!.toLowerCase();
    const lines: string[] = [];
    if (table === "opus_reviews") lines.push(ifThen(sync[op].cond, sync[op].body, "  "));
    for (const [topic, conds] of topics) lines.push(ifThen(conds.includes("") ? "" : conds.map((c) => `(${c})`).join(" OR "), `PERFORM ac_touch('${topic}');`, "  "));
    if (plan.length) lines.push(`  IF current_setting('${PG_BULK}', true) IS DISTINCT FROM '1' THEN\n${plan.join("\n")}\n  END IF;`);
    functions.push(`CREATE OR REPLACE FUNCTION ac_trg_${table}_${o}() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
${lines.join("\n")}
  RETURN NULL;
END $f$;`);
    const name = `ac_${table}_${o}`;
    triggers.set(table, [...(triggers.get(table) ?? []), { name, sql: `CREATE OR REPLACE TRIGGER ${name} AFTER ${op} ON ${table} FOR EACH ROW EXECUTE FUNCTION ac_trg_${table}_${o}();` }]);
  }
  const seeds = [
    `INSERT INTO change_seq (topic, seq, at) VALUES ${TOPICS.map((t) => `('${t}', 0, NULL)`).join(", ")} ON CONFLICT (topic) DO NOTHING;`,
    "INSERT INTO plan_full (id, seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;",
  ];
  return {
    ddl: [PROLOGUE, tables, ...seeds].join("\n"),
    functions,
    triggers,
    flush: `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ac_flush' AND tgrelid = 'live_flush'::regclass) THEN
    CREATE CONSTRAINT TRIGGER ac_flush AFTER INSERT ON live_flush DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ac_flush();
  END IF;
END $$;`,
    // SHARE keeps opus_reviews writes (whose triggers maintain review_blockers) out until the rebuild commits.
    blockers: ["LOCK TABLE opus_reviews IN SHARE MODE;", "DELETE FROM review_blockers;", blockerFill("postgres")],
  };
}

/** The whole of pgTriggerParts as one text, for the stamp. */
export function pgTriggerSql(columns?: Map<string, string[]>): string {
  const p = pgTriggerParts(columns);
  return [p.ddl, ...p.functions, ...[...p.triggers.values()].flat().map((t) => t.sql), p.flush, ...p.blockers].join("\n");
}

/** Column names of every table, as the SQLite schema has them: no generated search columns, no added rowid. */
export const PG_COLUMNS_SQL = `SELECT table_name AS t, column_name AS c FROM information_schema.columns
  WHERE table_schema = current_schema() AND is_generated = 'NEVER' AND column_name <> 'rowid' ORDER BY table_name, ordinal_position`;

export function pgColumns(rows: { t: string; c: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { t, c } of rows) out.set(t, [...(out.get(t) ?? []), c]);
  return out;
}

let stamp: string | undefined;

/** The schema stamp a migrated Postgres database stores in settings: the schema file's stamp and the trigger and view generators. */
export function pgStamp(): string {
  return stamp ??= createHash("sha256").update(pgSchemaStamp()).update(pgTriggerSql()).update(JSON.stringify(pgScopeViews("app"))).update(PIN_SEARCH_PATH)
    .update(JSON.stringify(BOOKKEEPING_COLUMNS)).update(`trip-split ${TRIP_SPLIT_VERSION}`).update(`features-repo-only ${FEATURES_REPO_ONLY_VERSION}`).update(`holds-to-items ${HOLDS_TO_ITEMS_VERSION}`).update(`chat-backfill ${CHAT_BACKFILL_VERSION}`).update(`pings-settled ${PINGS_SETTLED_VERSION}`).update(`fixup-diff-held ${FIXUP_DIFF_VERSION}`).update(`sonar-optional ${SONAR_OPTIONAL_VERSION}`).digest("hex").slice(0, 16);
}

export type { PgClient };

const STAMP_SQL = "SELECT value FROM settings WHERE key = 'schema_stamp'";

/** The stamp the database stores, or null before its first migration. `rows` runs one statement. */
export async function storedPgStamp(rows: (sql: string) => Promise<Record<string, unknown>[]>): Promise<string | null> {
  // A missing table would abort a transaction, so its existence is asked first.
  if (!(await rows("SELECT to_regclass('settings') IS NOT NULL AS ok"))[0]?.ok) return null;
  return ((await rows(STAMP_SQL))[0]?.value as string | undefined) ?? null;
}

/** The schema generation the database stores (src/db/pg-generation.ts), 0 before any. `rows` runs one statement. */
export async function storedPgGeneration(rows: (sql: string) => Promise<Record<string, unknown>[]>): Promise<number> {
  if (!(await rows("SELECT to_regclass('settings') IS NOT NULL AS ok"))[0]?.ok) return 0;
  return Number((await rows("SELECT value FROM settings WHERE key = 'schema_generation'"))[0]?.value ?? 0) || 0;
}

let newerSaid = false;

/**
 * True when a newer version migrated the database: an older process (a rollout's old pods and their job processes) serves
 * on the newer schema as it is rather than migrate it back. Said in the log once per process.
 */
export async function newerPgSchema(rows: (sql: string) => Promise<Record<string, unknown>[]>): Promise<boolean> {
  const stored = await storedPgGeneration(rows);
  if (stored <= PG_SCHEMA_GENERATION.generation) return false;
  if (!newerSaid) console.warn(`schema migration: skipped: the database has schema generation ${stored}, newer than this version's ${PG_SCHEMA_GENERATION.generation}`);
  newerSaid = true;
  return true;
}

/**
 * Brings the database at `client` to the current schema, triggers and views under the migration lock, in small steps that
 * each lock at most one table (src/db/pg-migrate.ts), unless it already stores the current stamp (checked again under the
 * lock, so concurrent openers migrate once) or a newer version migrated it (newerPgSchema). The stamp and the generation
 * are written last, so they mark a database with every step applied.
 */
export async function migratePg(client: PgClient, opts: MigrationOpts = {}): Promise<void> {
  const stamp = pgStamp();
  const rows = async (sql: string) => (await client.query(sql)).rows;
  await withMigrationLock(client, async (m) => {
    if ((await storedPgStamp(rows)) === stamp || (await newerPgSchema(rows))) return;
    // The schema adds a unique index over the active pre-approved merge legs, which needs one active leg per PR first.
    await m.step({ label: "preapprovals: one active leg", table: "preapprovals", run: () => oneActiveLegPg(client) });
    // Columns are only ever added, which the views over the tables allow, so the views are replaced after the schema.
    // Each index of the schema file is one line.
    const schema = pgSchemaSql().split("\n");
    await m.ddl(schema.filter((l) => !builtAfterCopy(l)).join("\n"), "schema");
    const parts = pgTriggerParts(pgColumns(await rows(PG_COLUMNS_SQL) as { t: string; c: string }[]));
    await m.ddl(parts.ddl, "live tables");
    await m.step({ label: "trigger functions", sql: [...parts.functions, PIN_SEARCH_PATH] });
    // Triggers this module made whose registry entry is gone are dropped with the others on their table.
    const old = new Map<string, string[]>();
    for (const r of await rows(`SELECT tg.tgname::text AS name, c.relname::text AS tbl FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
        WHERE c.relnamespace = current_schema()::regnamespace AND NOT tg.tgisinternal AND tg.tgname LIKE 'ac\\_%' AND tg.tgname <> 'ac_flush'`) as { name: string; tbl: string }[]) {
      if (!parts.triggers.get(r.tbl)?.some((t) => t.name === r.name)) old.set(r.tbl, [...(old.get(r.tbl) ?? []), `DROP TRIGGER IF EXISTS ${r.name} ON ${r.tbl}`]);
    }
    for (const table of [...new Set([...parts.triggers.keys(), ...old.keys()])].sort()) {
      await m.step({ label: `triggers: ${table}`, table, sql: [...(parts.triggers.get(table) ?? []).map((t) => t.sql), ...(old.get(table) ?? [])] });
    }
    await m.step({ label: "flush trigger", table: "live_flush", sql: [parts.flush] });
    await m.step({ label: "review blockers", table: "opus_reviews", sql: parts.blockers });
    await m.step({ label: "scoped schema", sql: [`CREATE SCHEMA IF NOT EXISTS ${SCOPED_SCHEMA}`] });
    const views = pgScopeViews((await rows("SELECT current_schema() AS s"))[0]!.s as string);
    for (const v of views) await m.step({ label: `view ${v.view}`, table: v.view, sql: [v.sql], fallback: [`DROP VIEW IF EXISTS ${v.view}`, v.sql.replace("CREATE OR REPLACE VIEW", "CREATE VIEW")] });
    for (const r of await rows(`SELECT table_schema || '.' || table_name AS v FROM information_schema.views WHERE table_schema = '${SCOPED_SCHEMA}'`) as { v: string }[]) {
      if (!views.some((v) => v.view === r.v)) await m.step({ label: `view ${r.v}`, table: r.v, sql: [`DROP VIEW IF EXISTS ${r.v}`] });
    }
    await m.step({ label: "stage trips", run: () => splitStageTripsPg(client) });
    await m.step({ label: "fix attempts", run: () => retireFixAttemptsPg(client) });
    await m.step({ label: "features", run: () => featuresRepoOnlyPg(client) });
    await m.step({ label: "holds", run: () => holdsToItemsPg(client) });
    await m.step({ label: "refused runs", table: "agent_runs", run: () => backfillRefusalsPg(client) });
    await m.step({ label: "run tokens", table: "agent_runs", run: () => backfillRunTokensPg(client) });
    await m.step({ label: "chat", run: () => chatBackfillPg(client) });
    await m.step({ label: "status pings", run: () => pingsSettledPg(client) });
    await m.step({ label: "fix-up diff holds", table: "fixups", run: () => fixupDiffHeldPg(client) });
    await m.step({ label: "optional checks", table: "settings", run: () => sonarOptionalPg(client) });
    await copyStatePg(client, m);
    await m.ddl(schema.filter(builtAfterCopy).join("\n"), "after the copy");
    await m.step({ label: "stamp", run: async () => void (await client.query(`INSERT INTO settings (key, value) VALUES ('schema_stamp', $1), ('schema_generation', $2)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [stamp, String(PG_SCHEMA_GENERATION.generation)])) });
  }, opts);
}
