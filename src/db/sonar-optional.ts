// Once: every repo's stored optional checks gain SonarCloud's analysis check (SONAR_ANALYSIS) where they lack it, so it fails no
// merge; an operator's earlier removal of the scan check and later removal of either stay. Runs on SQLite with backfill()
// (src/db.ts) and on Postgres inside migratePg's transaction (src/db/pg-triggers.ts); the SONAR_OPTIONAL_DONE marker makes a
// second run change nothing.
import type { DatabaseSync } from "node:sqlite";
import type { PgClient } from "./pg-triggers.ts";

/** Part of the Postgres stamp, so a database migrated before this code reaches the migration; the marker decides whether it runs. */
export const SONAR_OPTIONAL_VERSION = 1;
export const SONAR_OPTIONAL_DONE = "optional_checks_sonar_analysis";
/** The check the stored lists gain; one of DEFAULT_OPTIONAL_CHECKS (src/core/rules.ts). */
const SONAR_ANALYSIS = "SonarCloud Code Analysis";

type Row = { key: string; value: string | null };

/** The stored lists that lack SONAR_ANALYSIS, with it appended; unreadable values are left alone. */
function updated(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    let list: unknown;
    try { list = JSON.parse(r.value ?? "[]"); } catch { continue; }
    if (!Array.isArray(list)) continue;
    if (!list.includes(SONAR_ANALYSIS)) out.push({ key: r.key, value: JSON.stringify([...list, SONAR_ANALYSIS]) });
  }
  return out;
}

const ROWS = (main: string) => `SELECT key, value FROM ${main}settings WHERE key LIKE 'optional\\_checks:%' ESCAPE '\\'`;
const DONE = (main: string) => `SELECT 1 FROM ${main}settings WHERE key = '${SONAR_OPTIONAL_DONE}'`;

export function sonarOptionalSqlite(db: DatabaseSync): void {
  if (db.prepare(DONE("main.")).get()) return;
  const put = db.prepare("UPDATE main.settings SET value = ? WHERE key = ?");
  for (const r of updated(db.prepare(ROWS("main.")).all() as Row[])) put.run(r.value, r.key);
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, '1') ON CONFLICT (key) DO NOTHING").run(SONAR_OPTIONAL_DONE);
}

export async function sonarOptionalPg(client: PgClient): Promise<void> {
  if ((await client.query(DONE(""))).rows.length) return;
  for (const r of updated((await client.query(ROWS(""))).rows as Row[])) await client.query("UPDATE settings SET value = $1 WHERE key = $2", [r.value, r.key]);
  await client.query("INSERT INTO settings (key, value) VALUES ($1, '1') ON CONFLICT (key) DO NOTHING", [SONAR_OPTIONAL_DONE]);
}
