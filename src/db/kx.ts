/**
 * Typed query helpers that mean the same on SQLite and Postgres, for Kysely queries built with `db.k`. Each returns a
 * Kysely expression (or a table expression, or a builder callback), so app code never writes SQL text: raw SQL lives here
 * and in the engine. test/kx.test.ts runs every helper on both databases.
 *
 * Arguments named `e`, `a`, `b` take a column reference as a string (`"c.data"`, `"main.items.repo"`) or any Kysely
 * expression (`eb.ref(...)`, a subquery, another helper). JSON paths are SQLite's (`$.a.b`, `$[0]`, `$."odd key"`) and
 * are written into the statement text, so they must be constants. JSON is stored as text on both engines.
 *
 * Use Kysely's own API where it already means the same on both (src/db/types.ts is the schema it checks against):
 * - `.onConflict((oc) => oc.doNothing())` for INSERT OR IGNORE (unique conflicts only, see `insertIgnore` below)
 * - `.onConflict((oc) => oc.columns([...]).doUpdateSet(excluded([...])))` for upserts
 * - `.orderBy("x", (o) => o.asc().nullsFirst())`, `eb("a", "is distinct from", b)`, `eb.and/or/not`, `$if`
 * - `eb.fn.count/sum/max/min/coalesce`, `eb.case()`, `eb.exists(...)`, `with(...)`, `union(...)`, `returning(...)`
 */
import type { AliasedRawBuilder, Expression, ExpressionBuilder, InsertObject, RawBuilder, SelectQueryBuilder, SqlBool } from "kysely";
import type { Db, Dialect, Param } from "./index.ts";
import { nowParam, pgPath, quote, rowidOf } from "./portable.ts";
import { queryDb } from "./query-db.ts";
import { fts5Query, tsQueryText, type Search } from "./search.ts";
import { sql } from "./sql.ts";
import { COLUMNS, type DB } from "./types.ts";

type D = Dialect | { readonly dialect: Dialect };

/** A column reference (`"t.c"`) or a Kysely expression. */
export type Ex = string | Expression<unknown>;

const pgOf = (d: D): boolean => (typeof d === "string" ? d : d.dialect) === "postgres";
const x = (e: Ex): Expression<unknown> => (typeof e === "string" ? sql.ref(e) : e);

/** The current UTC time as SQLite's strftime text (`2026-01-02T03:04:05.678Z`): bind it as a value in place of 'now'. */
export { nowParam };

/** A JS value bound as one JSON text parameter, for helpers that read a JSON array (`jsonEach`). */
export const json = (value: unknown): RawBuilder<string> => sql<string>`${JSON.stringify(value)}`;

// ---- JSON fields --------------------------------------------------------------------------------------------------

/** The string at `path` (`json_extract`). On SQLite a number field stays a number; read strings with it. */
export function jsonText(d: D, e: Ex, path: string): RawBuilder<string | null> {
  return pgOf(d) ? sql`((${x(e)})::json #>> ${sql.raw(pgPath(path))})` : sql`json_extract(${x(e)}, ${sql.raw(quote(path))})`;
}

/** The number at `path`. */
export function jsonNum(d: D, e: Ex, path: string): RawBuilder<number | null> {
  return pgOf(d) ? sql`((${x(e)})::json #>> ${sql.raw(pgPath(path))})::numeric` : sql`json_extract(${x(e)}, ${sql.raw(quote(path))})`;
}

/** The boolean at `path` as 1/0; NULL when absent. Any other value gives NULL on Postgres and the value itself on SQLite (stored values are only true and false). */
export function jsonBool(d: D, e: Ex, path: string): RawBuilder<0 | 1 | null> {
  if (!pgOf(d)) return sql`json_extract(${x(e)}, ${sql.raw(quote(path))})`;
  return sql`(CASE (${x(e)})::json #>> ${sql.raw(pgPath(path))} WHEN 'true' THEN 1 WHEN 'false' THEN 0 END)`;
}

export type JsonType = "null" | "true" | "false" | "integer" | "real" | "text" | "array" | "object";

/** SQLite's json_type names for the value at `path` (default the whole value); NULL when the path is absent. */
export function jsonType(d: D, e: Ex, path?: string): RawBuilder<JsonType | null> {
  if (!pgOf(d)) return path === undefined ? sql`json_type(${x(e)})` : sql`json_type(${x(e)}, ${sql.raw(quote(path))})`;
  const v = path === undefined ? sql`(${x(e)})::json` : sql`(${x(e)})::json #> ${sql.raw(pgPath(path))}`;
  return sql`(SELECT CASE json_typeof(v) WHEN 'string' THEN 'text' WHEN 'boolean' THEN v::text WHEN 'number' THEN CASE WHEN v::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE json_typeof(v) END FROM (SELECT ${v} AS v) AS jt)`;
}

/** Whether `e` is valid JSON: a predicate for `where(...)`; selected, it reads 1/0 on both. */
export function jsonValid(d: D, e: Ex): RawBuilder<SqlBool> {
  return pgOf(d) ? sql`((${x(e)}) IS JSON)` : sql`json_valid(${x(e)})`;
}

/**
 * The JSON object `e` without its top-level `key`, as text. Postgres goes through jsonb, so key order and spacing of the
 * text may differ from SQLite's (the parsed value is the same); guard text that may not be valid JSON.
 */
export function jsonRemoveKey(d: D, e: Ex, key: string): RawBuilder<string | null> {
  return pgOf(d) ? sql`((${x(e)})::jsonb - ${sql.raw(quote(key))})::text` : sql`json_remove(${x(e)}, ${sql.raw(quote(`$.${key}`))})`;
}

/** Element types `jsonEach` and `inList` cast to on Postgres, where JSON elements come out as text. */
export type ElemType = "text" | "citext" | "bigint" | "numeric";
type ElemTs<T extends ElemType> = T extends "bigint" | "numeric" ? number : string;

/**
 * A table expression over the elements of the JSON array `e`, named `alias`, with one column `value`. Join it with
 * `crossJoin(...)`, `leftJoin(..., (j) => j.onTrue())`, or name it in `selectFrom([...])`; it may refer to tables before
 * it. Objects and arrays come out as JSON text. Strings are text; numbers need `type` "bigint"/"numeric" (otherwise
 * numbers on SQLite and text on Postgres). Arrays only: guard text that may not be an array; NULL gives no rows.
 */
export function jsonEach<A extends string, T extends ElemType = "text">(d: D, e: Ex, alias: A, type?: T): AliasedRawBuilder<{ value: ElemTs<T> }, A> {
  if (!pgOf(d)) return sql<{ value: ElemTs<T> }>`json_each(${x(e)})`.as(alias);
  const v = !type || type === "text" ? sql.raw("e") : sql.raw(`e::${type}`);
  return sql<{ value: ElemTs<T> }>`LATERAL (SELECT ${v} AS value FROM json_array_elements_text((${x(e)})::json) AS e)`.as(alias);
}

/**
 * The string at `key` of each element of the JSON array in `e`: `from` is the table expression to join (as `jsonEach`), `value` the string, NULL for an
 * element that is not an object or has no such key. Text that is not a JSON array has no elements.
 */
export function jsonEachField<A extends string>(d: D, e: Ex, key: string, alias: A): { from: AliasedRawBuilder<{ value: string }, A>; value: RawBuilder<string | null> } {
  if (pgOf(d)) {
    return {
      from: sql<{ value: string }>`LATERAL (SELECT e ->> ${sql.lit(key)} AS value FROM json_array_elements(CASE WHEN (${x(e)}) IS JSON ARRAY THEN (${x(e)})::json ELSE '[]'::json END) AS e)`.as(alias),
      value: sql`${sql.ref(`${alias}.value`)}`,
    };
  }
  return {
    from: sql<{ value: string }>`json_each(CASE WHEN json_valid(${x(e)}) THEN CASE json_type(${x(e)}) WHEN 'array' THEN ${x(e)} ELSE '[]' END ELSE '[]' END)`.as(alias),
    value: sql`(CASE ${sql.ref(`${alias}.type`)} WHEN 'object' THEN json_extract(${sql.ref(`${alias}.value`)}, ${sql.lit(`$.${key}`)}) END)`,
  };
}

/**
 * `e IN (values)` with the list bound as one JSON parameter, so the statement text is the same for any length and an
 * empty list matches nothing (Kysely's `in` with an empty array is a syntax error on Postgres). `type` is the elements'
 * type on Postgres; compare a citext column with "citext" to keep SQLite's NOCASE match. `not` gives NOT IN.
 */
export function inList(d: D, e: Ex, values: readonly Param[], type: ElemType = "text", not = false): RawBuilder<SqlBool> {
  const op = sql.raw(not ? "NOT IN" : "IN");
  const list = JSON.stringify(values);
  if (!pgOf(d)) return sql`${x(e)} ${op} (SELECT value FROM json_each(${list}))`;
  const v = sql.raw(type === "text" ? "value" : `value::${type}`);
  return sql`${x(e)} ${op} (SELECT ${v} FROM json_array_elements_text((${list})::json) AS value)`;
}

// ---- JSON row sets ----------------------------------------------------------------------------------------------

/** Column names of `valuesTable` and `updateFrom` are written into the statement text, so they must be plain names. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (name: string): string => {
  if (!IDENT.test(name)) throw new Error(`not a plain column name: ${name}`);
  return name;
};

/**
 * A subselect as JSON array text of its rows (objects keyed by the select's column names), for a select list: SQLite
 * `json_group_array(json_object(..))`, Postgres `json_agg`. Rows keep the subselect's `ORDER BY`; no row gives `[]`.
 * Text, integers and reals only (no booleans, no blobs). Every column needs a name (an alias or a plain reference). Read
 * the value with `parseJsonRows`. `q` may refer to the enclosing query's tables.
 */
export function jsonRows(d: D, q: SelectQueryBuilder<any, any, any>): RawBuilder<string | null> {
  const pairs = sql.join(selectionNames(q).flatMap((n) => [sql.lit(n), sql.ref(`s.${n}`)]));
  return pgOf(d)
    ? sql`(SELECT COALESCE(json_agg(json_build_object(${pairs})), '[]'::json)::text FROM ${q} AS s)`
    : sql`(SELECT json_group_array(json_object(${pairs})) FROM ${q} AS s)`;
}

/** The rows of a `jsonRows` value; none for NULL. */
export function parseJsonRows<T = Record<string, unknown>>(value: string | null | undefined): T[] {
  return value === null || value === undefined ? [] : (JSON.parse(value) as T[]);
}

type ValuesRow<C extends Record<string, ElemType>> = { [K in keyof C]: ElemTs<C[K]> | null };

/**
 * A table expression named `alias` over `rows`, bound as one JSON parameter, with the columns `cols` (name to type; the
 * type is the Postgres cast, as in `jsonEach`). The statement text is the same for any number of rows. Row values are
 * text, numbers or null; a missing key is NULL. Generalizes `refPairs` and `tupleIn`.
 */
export function valuesTable<C extends Record<string, ElemType>, A extends string>(d: D, rows: readonly Record<string, Param>[], cols: C, alias: A): AliasedRawBuilder<ValuesRow<C>, A> {
  const list = JSON.stringify(rows);
  const pg = pgOf(d);
  const proj = sql.join(Object.entries(cols).map(([name, type]) => {
    const get = sql.raw(`value ->> ${quote(ident(name))}`);
    return pg && type !== "text" ? sql`(${get})::${sql.raw(type)} AS ${sql.id(name)}` : sql`${get} AS ${sql.id(name)}`;
  }));
  return pg
    ? sql<ValuesRow<C>>`(SELECT ${proj} FROM json_array_elements((${list})::json) AS value)`.as(alias)
    : sql<ValuesRow<C>>`(SELECT ${proj} FROM json_each(${list}))`.as(alias);
}

/**
 * A table expression named `alias` over `rows` that may hold blobs, which cannot travel as JSON (`valuesTable`): every value
 * is its own parameter, so keep the rows few. Needs at least one row.
 */
export function blobTable<C extends Record<string, ElemType | "bytea">, A extends string>(d: D, rows: readonly Record<keyof C & string, Param>[], cols: C, alias: A): AliasedRawBuilder<{ [K in keyof C]: C[K] extends "bytea" ? Uint8Array : ElemTs<C[K] & ElemType> }, A> {
  const pg = pgOf(d);
  const picks = rows.map((r) => sql`SELECT ${sql.join(Object.entries(cols).map(([name, type]) => pg ? sql`(${r[name]})::${sql.raw(type)} AS ${sql.id(ident(name))}` : sql`${r[name]} AS ${sql.id(ident(name))}`))}`);
  return sql<any>`(${sql.join(picks, sql` UNION ALL `)})`.as(alias);
}

/** Keys per JSON key list and rows per `updateFrom` statement. */
export const JSON_CHUNK = 10_000;

/** `rows` in slices of `n` (default 10,000) for JSON key lists; `batches` slices to BATCH_ROWS for multi-row VALUES. */
export const chunks = <T>(rows: readonly T[], n: number = JSON_CHUNK): T[][] => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(i * n, (i + 1) * n));

/**
 * `UPDATE table SET c = v.c FROM (rows) v WHERE table.k = v.k`: one statement sets different values on many rows, in
 * chunks of 10,000 rows. `keyCols` match rows; `setCols` default to every other column of the first row. Values are text,
 * numbers or null, stored as the column's own type (Postgres reads the rows with json_populate_recordset against the
 * table, so a JSON number into a bigint or text into a citext column needs no cast). Returns the rows changed. Call
 * inside `db.write`.
 */
export async function updateFrom(db: Db, table: string, keyCols: readonly string[], rows: readonly Record<string, Param>[], setCols?: readonly string[]): Promise<number> {
  if (rows.length === 0) return 0;
  const set = setCols ?? Object.keys(rows[0]).filter((c) => !keyCols.includes(c));
  if (set.length === 0 || keyCols.length === 0) throw new Error("updateFrom needs key columns and columns to set");
  const qdb = queryDb(db), k = qdb.k as any;
  const names = [...keyCols, ...set].map(ident);
  let changed = 0;
  for (const chunk of chunks(rows)) {
    const v = db.dialect === "postgres"
      ? sql`json_populate_recordset(NULL::${sql.table(table)}, ${JSON.stringify(chunk)}::json)`.as("v")
      : valuesTable(db, chunk, Object.fromEntries(names.map((n) => [n, "text" as const])), "v");
    const q = k.updateTable(table).from(v)
      .set((eb: ExpressionBuilder<any, any>) => Object.fromEntries(set.map((c) => [c, eb.ref(`v.${c}`)])))
      .where((eb: ExpressionBuilder<any, any>) => eb.and(keyCols.map((c) => eb(`${table}.${c}`, "=", eb.ref(`v.${c}`)))));
    changed += (await qdb.run(q)).changes;
  }
  return changed;
}

// ---- item refs ----------------------------------------------------------------------------------------------------

/** `[repo, number]` pairs from "repo#number" refs (unreadable ones left out) or from pairs as they are. */
function pairsOf(refs: Iterable<string> | readonly (readonly [string, number])[]): [string, number][] {
  const out: [string, number][] = [];
  for (const r of refs as Iterable<string | readonly [string, number]>) {
    if (typeof r !== "string") {
      out.push([r[0], r[1]]);
      continue;
    }
    const i = r.lastIndexOf("#");
    const n = Number(r.slice(i + 1));
    if (i > 0 && Number.isInteger(n)) out.push([r.slice(0, i), n]);
  }
  return out;
}

/**
 * A table expression `(repo, number)` over item refs ("repo#number" strings or `[repo, number]` pairs), bound as one JSON
 * parameter. Join items to it (`innerJoin(refPairs(db, refs, "rp"), (j) => j.onRef("rp.repo", "=", "i.repo").onRef(...))`).
 */
export function refPairs<A extends string>(d: D, refs: Iterable<string> | readonly (readonly [string, number])[], alias: A): AliasedRawBuilder<{ repo: string; number: number }, A> {
  const list = JSON.stringify(pairsOf(refs));
  if (pgOf(d)) return sql<{ repo: string; number: number }>`(SELECT value ->> 0 AS repo, (value ->> 1)::bigint AS number FROM json_array_elements((${list})::json) AS value)`.as(alias);
  return sql<{ repo: string; number: number }>`(SELECT value ->> 0 AS repo, value ->> 1 AS number FROM json_each(${list}))`.as(alias);
}

/**
 * Condition: the row of table alias `t` (its `repo` and `number` columns) is one of `refs`. SQLite looks the few refs up
 * through the (repo, number) keys instead of testing every row.
 */
export function refIn(d: D, t: string, refs: Iterable<string> | readonly (readonly [string, number])[]): RawBuilder<SqlBool> {
  const list = JSON.stringify(pairsOf(refs));
  const cols = sql`(${sql.ref(`${t}.repo`)}, ${sql.ref(`${t}.number`)})`;
  if (pgOf(d)) return sql`${cols} IN (SELECT value ->> 0, (value ->> 1)::bigint FROM json_array_elements((${list})::json) AS value)`;
  return sql`${cols} IN (SELECT value ->> 0, value ->> 1 FROM json_each(${list}))`;
}

/**
 * Condition: `(cols[0], cols[1], ...) IN (rows)`, for tuples of any width, the rows bound as one JSON parameter (an empty
 * list matches nothing). `types[i]` is the type of the i-th element of each row: "bigint"/"numeric" for numbers, "citext"
 * against a citext column, else "text".
 */
export function tupleIn(d: D, cols: readonly Ex[], rows: readonly (readonly Param[])[], types: readonly ElemType[]): RawBuilder<SqlBool> {
  const list = JSON.stringify(rows);
  const left = sql`(${sql.join(cols.map(x))})`;
  const pg = pgOf(d);
  const elems = cols.map((_, i) => {
    const t = types[i] ?? "text";
    return sql.raw(pg && t !== "text" ? `(value ->> ${i})::${t}` : `value ->> ${i}`);
  });
  if (pg) return sql`${left} IN (SELECT ${sql.join(elems)} FROM json_array_elements((${list})::json) AS value)`;
  return sql`${left} IN (SELECT ${sql.join(elems)} FROM json_each(${list}))`;
}

// ---- SQLite planner hints ---------------------------------------------------------------------------------------------

/**
 * Table `table` named `alias`, read on SQLite through `index` (INDEXED BY), on Postgres as the plain table. Name a
 * `main.` table: SQLite takes no hint on a view. For a partial index, write the terms of its WHERE with `literal` values
 * in the query, or SQLite finds no plan and the statement fails. A null `index` gives the plain table on both. `S` is the
 * schema, for tables outside DB (tests).
 */
export function indexedBy<T extends keyof S & string, A extends string, S = DB>(d: D, table: T, index: string | null, alias: A): AliasedRawBuilder<S[T], A> {
  const t = sql<S[T]>`${sql.table(table)}`;
  return pgOf(d) || index === null ? t.as(alias) : t.as<A>(sql`${sql.id(alias)} INDEXED BY ${sql.id(index)}`);
}

/**
 * The constant `value` written into the statement text instead of bound, so SQLite can match a partial index whose WHERE
 * names it (`kind = 'pr'`): a bound value never matches one. Constants only, never input.
 */
export function literal<V extends string | number>(value: V): RawBuilder<V> {
  return sql.lit(value);
}

// ---- comparison and ordering ----------------------------------------------------------------------------------------

/** Case-insensitive equality (ASCII, as SQLite's NOCASE); also for a citext column against a text one on Postgres. */
export function ciEq(d: D, a: Ex, b: Ex): RawBuilder<SqlBool> {
  return pgOf(d) ? sql`(${x(a)})::citext = (${x(b)})::citext` : sql`${x(a)} = ${x(b)} COLLATE NOCASE`;
}

/**
 * `ciEq` for a text column that has an index on `col COLLATE NOCASE` (on Postgres the index holds `lower(col)`): Postgres
 * compares `lower(a) = lower(b)`, which that index serves, where ciEq's citext cast of the column keeps every index out of use.
 */
export function nocaseEq(d: D, a: Ex, b: Ex): RawBuilder<SqlBool> {
  return pgOf(d) ? sql`lower(${x(a)}) = lower(${x(b)})` : sql`${x(a)} = ${x(b)} COLLATE NOCASE`;
}

/**
 * `e` sorted and grouped case-insensitively as SQLite's NOCASE does (ASCII letters folded to lower case, then by code
 * point), for `orderBy(...)` and `groupBy(...)`. On Postgres it is `lower(e)` by code point: citext would sort in the
 * database's collation. Compare with `ciEq` or `inList(..., "citext")`.
 */
export function nocase<T = string>(d: D, e: Ex): RawBuilder<T> {
  return pgOf(d) ? sql`lower(${x(e)}) COLLATE "C"` : sql`${x(e)} COLLATE NOCASE`;
}

/**
 * `e` compared and sorted by code point, as SQLite compares text. App columns sort that way on Postgres too (COLLATE "C"),
 * but text Postgres computes from no column (JSON fields, jsonEach values, literals) takes the database's collation,
 * which may sort "B" after "a": wrap such an ORDER BY, GROUP BY, MIN/MAX or comparison term in it.
 */
export function bytewise<T = string>(d: D, e: Ex): RawBuilder<T> {
  return pgOf(d) ? sql`(${x(e)}) COLLATE "C"` : sql`${x(e)}`;
}

/**
 * Case-insensitive LIKE (ASCII). With no `escape`, every character of the pattern but `%` and `_` is literal on both
 * (Postgres would otherwise treat a backslash as the escape). A pattern from a JS value: `eb.val(...)`; escape user text
 * in it with `likeEscape`.
 */
export function like(d: D, a: Ex, pattern: Ex, escape?: string): RawBuilder<SqlBool> {
  const esc = sql.raw(` ESCAPE ${quote(escape ?? "")}`);
  if (pgOf(d)) return sql`${x(a)} ILIKE ${x(pattern)}${esc}`;
  return escape === undefined ? sql`${x(a)} LIKE ${x(pattern)}` : sql`${x(a)} LIKE ${x(pattern)}${esc}`;
}

/** The text `a` followed by the text `b` (`||` on both databases; cast, so a bound value needs no type); NULL when either is NULL. */
export function concat(a: Ex, b: Ex): RawBuilder<string> {
  return sql`(CAST(${x(a)} AS TEXT) || CAST(${x(b)} AS TEXT))`;
}

/** `e` without any of the characters of `chars` at either end (SQLite `trim(e, chars)`, Postgres `btrim`). */
export function trimChars(d: D, e: Ex, chars: string): RawBuilder<string | null> {
  return pgOf(d) ? sql`btrim(${x(e)}, ${chars})` : sql`trim(${x(e)}, ${chars})`;
}

/** The size in bytes of the UTF-8 text `e`, as `Buffer.byteLength` counts it. */
export function byteLength(d: D, e: Ex): RawBuilder<number> {
  return pgOf(d) ? sql`octet_length(${x(e)})` : sql`length(CAST(${x(e)} AS BLOB))`;
}

/** The ISO timestamp `e` (as `Date.toISOString` writes it) less `hours`, in the same form; NULL when it is NULL. */
export function isoMinusHours(d: D, e: Ex, hours: number): RawBuilder<string | null> {
  const n = sql.lit(Math.trunc(hours));
  return pgOf(d)
    ? sql`to_char(((${x(e)})::timestamptz - make_interval(hours => ${n})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    : sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${x(e)}, '-' || ${n} || ' hours')`;
}

/** `text` with `esc` (one character), `%` and `_` escaped by `esc`: `like(db, "title", eb.val(`%${likeEscape(s)}%`), "\\")`. */
export const likeEscape = (text: string, esc = "\\"): string => text.replaceAll(esc, esc + esc).replace(/[%_]/g, (c) => esc + c);

function extreme<T>(d: D, fn: "max" | "min", args: Ex[], type: ElemType): RawBuilder<T | null> {
  if (args.length < 2) throw new Error(`${fn === "max" ? "greatest" : "least"} needs two or more arguments`);
  if (!pgOf(d)) return sql`${sql.raw(fn)}(${sql.join(args.map(x))})`;
  // Each argument is cast: bound parameters alone would be resolved as text, and '9' > '10'.
  const rows = sql.join(args.map((a) => sql`((${x(a)})::${sql.raw(type)})`));
  return sql`(SELECT CASE WHEN count(*) = count(g.x) THEN ${sql.raw(fn)}(g.x) END FROM (VALUES ${rows}) AS g(x))`;
}

/** The largest of `args`, NULL when any is NULL (SQLite's scalar max; Postgres GREATEST would skip NULLs). `type` is the arguments' type on Postgres. */
export const greatest = <T = number>(d: D, args: Ex[], type: ElemType = "bigint"): RawBuilder<T | null> => extreme<T>(d, "max", args, type);

/** The smallest of `args`, NULL when any is NULL (SQLite's scalar min). `type` is the arguments' type on Postgres. */
export const least = <T = number>(d: D, args: Ex[], type: ElemType = "bigint"): RawBuilder<T | null> => extreme<T>(d, "min", args, type);

/**
 * Aggregate: the non-NULL values of `e` as text joined by `sep`, in `orderBy` order (required: Postgres has no default
 * order). NULL when there are none.
 */
export function groupConcat(d: D, e: Ex, sep: string, orderBy: Ex, dir: "asc" | "desc" = "asc"): RawBuilder<string | null> {
  const o = sql`${x(orderBy)} ${sql.raw(dir)}`;
  return pgOf(d) ? sql`string_agg((${x(e)})::text, ${sql.raw(quote(sep))} ORDER BY ${o})` : sql`group_concat(${x(e)}, ${sql.raw(quote(sep))} ORDER BY ${o})`;
}

/**
 * The rowid of `table` (named `alias` in the query, default the table's name): its INTEGER PRIMARY KEY when it has one,
 * else SQLite's rowid, which Postgres carries as an identity column `rowid`. Not in src/db/types.ts, since `SELECT *`
 * returns it on Postgres only: select the columns you need instead of `selectAll()` on such a table.
 */
export function rowid(table: keyof DB & string, alias?: string): RawBuilder<number> {
  return sql.ref(`${alias ?? table.replace(/^main\./, "")}.${rowidOf(table.replace(/^main\./, ""))}`) as unknown as RawBuilder<number>;
}

/** A table or view of src/db/types.ts without its `main.` prefix. */
type Bare<T extends keyof DB & string> = T extends `main.${infer B extends keyof typeof COLUMNS}` ? B : T & keyof typeof COLUMNS;
type Col<T extends keyof DB & string> = (typeof COLUMNS)[Bare<T>][number];

/**
 * The whole row of `table` as a select list: every column in table order from src/db/types.ts, each prefixed with `alias`
 * when given. `selectAll()` also returns rowid on Postgres and on SQLite's scoped views, and the full-text column `fts` of
 * items and comments on Postgres; this list holds neither. `.selectFrom("decisions as d").select(kx.cols("decisions", "d"))`.
 */
export function cols<T extends keyof DB & string, A extends string | undefined = undefined>(table: T, alias?: A): readonly (A extends string ? `${A}.${Col<T>}` : Col<T>)[] {
  const names: readonly string[] = COLUMNS[table.replace(/^main\./, "") as keyof typeof COLUMNS];
  return (alias ? names.map((c) => `${alias}.${c}`) : names) as readonly (A extends string ? `${A}.${Col<T>}` : Col<T>)[];
}

// ---- upserts ------------------------------------------------------------------------------------------------------

/**
 * The `doUpdateSet` of an upsert that overwrites `cols` with the inserted row's values:
 * `.onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["title", "state"])))`. Upserts update the row
 * in place; INSERT OR REPLACE deletes and inserts (new rowid, delete triggers), so a REPLACE becomes an upsert that
 * names every non-key column it wrote.
 */
export function excluded<C extends string>(cols: readonly C[]): (eb: ExpressionBuilder<any, any>) => Record<C, Expression<any>> {
  return (eb) => Object.fromEntries(cols.map((c) => [c, eb.ref(`excluded.${c}`) as Expression<any>]) as [C, Expression<any>][]) as Record<C, Expression<any>>;
}

/** `CASE e WHEN k THEN v ... END` over `pairs`: one statement sets a different value per row (NULL for a key not listed). */
export function caseOf<V extends Param>(e: Ex, pairs: readonly (readonly [Param, V])[]): RawBuilder<V> {
  return sql<V>`CASE ${x(e)} ${sql.join(pairs.map(([k, v]) => sql`WHEN ${k} THEN ${v}`), sql` `)} END`;
}

/** `CASE WHEN repo = r AND number = n THEN v ... END` over `[r, n, v]` triples: a different value per item in one statement (NULL for an item not listed). */
export function refCase<V extends Param>(triples: readonly (readonly [string, number, V])[]): RawBuilder<V> {
  return sql<V>`CASE ${sql.join(triples.map(([r, n, v]) => sql`WHEN ${sql.ref("repo")} = ${r} AND ${sql.ref("number")} = ${n} THEN ${v}`), sql` `)} END`;
}

/** Rows per multi-row statement: a row of ten bound values keeps a statement far under both engines' parameter limits. */
export const BATCH_ROWS = 500;

/**
 * `rows` in slices of BATCH_ROWS, for multi-row inserts and `IN` lists: on Postgres every statement is a network round
 * trip, so a write per row costs a round trip per row inside the write lock.
 */
export const batches = <T>(rows: readonly T[]): T[][] => Array.from({ length: Math.ceil(rows.length / BATCH_ROWS) }, (_, i) => rows.slice(i * BATCH_ROWS, (i + 1) * BATCH_ROWS));

/**
 * INSERT OR REPLACE of one row, for a table whose readers follow rowid changes: the row ends up with a rowid above every
 * other. SQLite runs the statement itself (REPLACE allocates the new rowid before it deletes the old row, so even the row
 * that held the highest rowid gets a higher one). Postgres deletes the row by `key` and inserts it again; its identity
 * rowid only increases. Postgres runs two statements: call it inside `db.write`.
 */
export async function replaceRow<T extends keyof DB & string>(db: Db, table: T, key: readonly string[], row: InsertObject<DB, T>): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  if (db.dialect !== "postgres") {
    await q.run(k.insertInto(table).orReplace().values(row));
    return;
  }
  await q.run(k.deleteFrom(table).where((eb: ExpressionBuilder<any, any>) => eb.and(key.map((c) => eb(c, "=", (row as Record<string, unknown>)[c])))));
  await q.run(k.insertInto(table).values(row));
}

/**
 * replaceRow for many rows: one statement per BATCH_ROWS rows (two on Postgres: the delete by `key`, then the insert). Rows get
 * rowids in the order given. Call inside `db.write`.
 */
export async function replaceRows<T extends keyof DB & string>(db: Db, table: T, key: readonly string[], rows: readonly InsertObject<DB, T>[]): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  for (const chunk of batches(rows)) {
    if (db.dialect !== "postgres") {
      await q.run(k.insertInto(table).orReplace().values(chunk));
      continue;
    }
    await q.run(k.deleteFrom(table).where((eb: ExpressionBuilder<any, any>) => eb.or(chunk.map((row) => eb.and(key.map((c) => eb(c, "=", (row as Record<string, unknown>)[c])))))));
    await q.run(k.insertInto(table).values(chunk));
  }
}

// ---- full-text search -----------------------------------------------------------------------------------------------

/** Snippet marks: `open`/`close` around each match, about `words` words, `…` where cut. */
export interface SnippetOpts {
  open: string;
  close: string;
  words: number;
}

const tsq = (q: string) => sql`to_tsquery('english', ${q})`;

function snippet(d: D, q: string, field: "title" | "body" | "comment", s: SnippetOpts): RawBuilder<string | null> {
  if (!pgOf(d)) {
    const [table, col] = field === "comment" ? ["comments_fts", 0] : ["items_fts", field === "title" ? 0 : 1];
    return sql`snippet(${sql.raw(table)}, ${sql.raw(String(col))}, ${sql.raw(quote(s.open))}, ${sql.raw(quote(s.close))}, '…', ${sql.raw(String(s.words))})`;
  }
  const opts = `StartSel="${s.open}", StopSel="${s.close}", MaxWords=${s.words}, MinWords=${Math.max(1, Math.min(s.words - 1, 8))}, MaxFragments=1, FragmentDelimiter="…"`;
  return sql`ts_headline('english', COALESCE(${sql.raw(field === "comment" ? "c.body" : field)}, ''), ${tsq(q)}, ${sql.raw(quote(opts))})`;
}

export interface ItemHitOpts {
  /** Match titles only. */
  titleOnly?: boolean;
  /** Add `score`: lower is better (SQLite bm25, Postgres -ts_rank), a title match weighing ten times the body. */
  score?: boolean;
  /** Add `title_snippet` and `body_snippet`. */
  snippets?: SnippetOpts;
}

export type ItemHit<O extends ItemHitOpts> = { rid: number }
  & (O["score"] extends true ? { score: number } : unknown)
  & (O["snippets"] extends SnippetOpts ? { title_snippet: string | null; body_snippet: string | null } : unknown);

/**
 * A table expression over the items matching `s`, every repo (join `items` on `rowid("items", ...)` = `rid` to read or
 * scope them): `selectFrom(itemHits(db, s, {}, "h")).innerJoin("items as i", (j) => j.on(rowid("items", "i"), "=", eb.ref("h.rid")))`.
 * Ordering by `rid` lets the search stop early; ranking every match by score is slow for common words.
 */
export function itemHits<A extends string, O extends ItemHitOpts = {}>(d: D, s: Search, opts: O, alias: A): AliasedRawBuilder<ItemHit<O>, A> {
  const pg = pgOf(d);
  const q = pg ? tsQueryText(s, opts.titleOnly ? "A" : "") : opts.titleOnly ? `title : ${fts5Query(s)}` : fts5Query(s);
  const cols = [sql`rowid AS rid`];
  if (opts.score) cols.push(pg ? sql`-ts_rank(fts, ${tsq(q)}) AS score` : sql`bm25(items_fts, 10.0, 1.0) AS score`);
  if (opts.snippets) cols.push(sql`${snippet(d, q, "title", opts.snippets)} AS title_snippet`, sql`${snippet(d, q, "body", opts.snippets)} AS body_snippet`);
  const where = pg ? sql`FROM ${sql.table("main.items")} WHERE fts @@ ${tsq(q)}` : sql`FROM items_fts WHERE items_fts MATCH ${q}`;
  return sql<ItemHit<O>>`(SELECT ${sql.join(cols)} ${where})`.as(alias);
}

export interface CommentHitOpts {
  /** Add `score`: lower is better (SQLite bm25, Postgres -ts_rank), times `weight` (default 1). */
  score?: boolean;
  weight?: number;
  /** Add `snippet` of the comment body. */
  snippet?: SnippetOpts;
}

export type CommentHit<O extends CommentHitOpts> = { repo: string; number: number; id: string; author: string | null }
  & (O["score"] extends true ? { score: number } : unknown)
  & (O["snippet"] extends SnippetOpts ? { snippet: string | null } : unknown);

/** A table expression over the comments matching `s` (every repo): their item ref, id and author, best first by `score`. */
export function commentHits<A extends string, O extends CommentHitOpts = {}>(d: D, s: Search, opts: O, alias: A): AliasedRawBuilder<CommentHit<O>, A> {
  const pg = pgOf(d);
  const q = pg ? tsQueryText(s) : fts5Query(s);
  const cols = [sql`c.repo, c.number, c.id, c.author`];
  const w = sql.raw(String(opts.weight ?? 1));
  if (opts.score) cols.push(pg ? sql`-ts_rank(c.fts, ${tsq(q)}) * ${w} AS score` : sql`bm25(comments_fts) * ${w} AS score`);
  if (opts.snippet) cols.push(sql`${snippet(d, q, "comment", opts.snippet)} AS snippet`);
  const from = pg
    ? sql`FROM ${sql.table("main.comments")} c WHERE c.fts @@ ${tsq(q)}`
    : sql`FROM comments_fts JOIN ${sql.table("main.comments")} c ON c.rowid = comments_fts.rowid WHERE comments_fts MATCH ${q}`;
  return sql<CommentHit<O>>`(SELECT ${sql.join(cols)} ${from})`.as(alias);
}

// ---- fragment twins ------------------------------------------------------------------------------------------------
// Typed twins of SQL-text fragments that other files splice into their statements. A twin
// takes its caller's expression builder and names the caller's tables by alias strings, as the text version does.

/** The expression builder a fragment twin takes from its caller: any query's, since the twin names the caller's tables by alias. */
export type AnyEb = ExpressionBuilder<any, any>;

/** `eb` typed against the schema alone, for a twin's subqueries over its own tables; outer columns come in as `eb.ref(...)`. */
export const schemaEb = (eb: AnyEb): ExpressionBuilder<DB, never> => eb as unknown as ExpressionBuilder<DB, never>;

/** `e` as an expression: a column reference string (`"i.repo"`) through `eb.ref`, an expression as it is. */
export const exprOf = (eb: AnyEb, e: Ex): Expression<any> => (typeof e === "string" ? eb.ref(e) : e);

/**
 * A JSON object as text whose values are the JSON texts in `entries` (SQLite `json_object('k', json(v), ...)`). Keys are
 * constants. Postgres spaces the text differently (`{"k" : ...}`); the parsed value is the same.
 */
export function jsonObject(d: D, entries: Record<string, Ex>): RawBuilder<string | null> {
  const pg = pgOf(d);
  const parts = Object.entries(entries).map(([k, v]) => (pg ? sql`${sql.raw(quote(k))}, (${x(v)})::json` : sql`${sql.raw(quote(k))}, json(${x(v)})`));
  return pg ? sql`json_build_object(${sql.join(parts)})::text` : sql`json_object(${sql.join(parts)})`;
}

/** The output names of a select's columns, in order. Each column needs one: an alias or a plain column reference. */
function selectionNames(q: SelectQueryBuilder<any, any, any>): string[] {
  type Node = { kind: string; name?: string; alias?: Node; column?: Node };
  return (q.toOperationNode().selections ?? []).map((s) => {
    const e = s.selection as unknown as Node;
    const name = e.kind === "AliasNode" ? e.alias?.name : e.kind === "ReferenceNode" ? e.column?.column?.name : e.kind === "ColumnNode" ? e.column?.name : undefined;
    if (!name) throw new Error(`rowArray: every column needs a name (got ${e.kind})`);
    return name;
  });
}

/**
 * Scalar subquery: the first row of `q` as JSON array text of its column values in select order (SQLite `json_array`),
 * NULL when `q` has no row. Several in one `selectNoFrom` read many small queries in one statement. Integers, text and
 * NULL come back the same on both engines; `q` names every column and selects no booleans.
 */
export function rowArray(d: D, q: SelectQueryBuilder<any, any, any>): RawBuilder<string | null> {
  const values = sql.join(selectionNames(q).map((n) => sql.ref(`s.${n}`)));
  return pgOf(d) ? sql`(SELECT json_build_array(${values})::text FROM ${q} AS s LIMIT 1)` : sql`(SELECT json_array(${values}) FROM ${q} AS s LIMIT 1)`;
}

/**
 * The column values of the first row of each query in select order (`[]` when there is none), read in one statement (rowArray).
 * Every value is an integer, text or null, which a JSON array carries unchanged.
 */
export async function rowValues(db: Db, queries: readonly SelectQueryBuilder<any, any, any>[]): Promise<unknown[][]> {
  const row: Record<string, string | null> | undefined = await queryDb(db).get(queryDb(db).k.selectNoFrom(queries.map((q, k) => rowArray(db, q).as(`c${k}`))));
  return queries.map((_, k) => { const v = row?.[`c${k}`]; return v === null || v === undefined ? [] : (JSON.parse(v) as unknown[]); });
}

/**
 * The expression builder a fragment twin takes from its caller's callback (`.where((eb) => quietExprFor(db, eb, "i.repo",
 * "i.number"))`). Its tables are the caller's, so the twin's column references are not checked against them.
 */
export type Eb = AnyEb;

/** `e` as an expression: a string is a column reference, a value goes in as `eb.val(v)`. For twins whose arguments are `Ex`. */
export const ref = <T = unknown>(e: Ex): Expression<T> => x(e) as Expression<T>;
