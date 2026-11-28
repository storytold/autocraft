// Checks, review gates and diff facts (M01 mirror-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { KeySource } from "../keys.ts";
import { keepKnownMergeableExpr } from "./fragments.ts";
import { joinKeys, keyChunks, refKey, splitKey, type AnyQ } from "./shared.ts";
import type { DiffFactsKey, DiffFactsRow, Gate, GateRead, PrChecksRow, PrChecksView, RefKey, RepoCiSignals } from "./types.ts";

const CHECK_COLUMNS = kx.cols("pr_checks", "pc");

/** The stored checks row of each PR. With `checksOnlyIfNotGreen` the check list is read only where `overall` is "failure" or "pending", where optional checks can change the reading (null elsewhere). */
export async function loadChecks(db: Db, keys: KeySource, o?: { checksOnlyIfNotGreen?: boolean }): Promise<Map<RefKey, PrChecksView>> {
  const q = queryDb(db);
  const cols = (CHECK_COLUMNS as readonly string[]).filter((c) => c !== "pc.checks");
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all(
    (joinKeys(db, q.k.selectFrom("pr_checks as pc"), k, "pc") as AnyQ).select((eb: kx.AnyEb) => [
      ...cols.map((c) => eb.ref(c).as(c.slice(3))),
      (o?.checksOnlyIfNotGreen ? eb.case().when("pc.overall", "in", ["failure", "pending"]).then(eb.ref("pc.checks")).end() : eb.ref("pc.checks")).as("checks"),
    ] as never), { label: "mirror.loadChecks" })));
  const out = new Map<RefKey, PrChecksView>();
  for (const rows of parts) for (const r of rows as PrChecksView[]) out.set(refKey(r.repo, r.number), r);
  return out;
}

/** Rows `saveChecks` writes in one statement: callers flush their pending rows at this count. */
export const SAVE_CHECKS_ROWS = kx.BATCH_ROWS;

/** Batched upsert, one `db.write`; a known `mergeable` at the same head survives UNKNOWN. The follow-ups (`recordRuns`, `resolvePushes`, `noteMergeable`) stay calls of their own modules. A PR given twice keeps its last row. */
export async function saveChecks(db: Db, rows: PrChecksRow[], at: string): Promise<void> {
  const last = [...new Map(rows.map((r) => [refKey(r.repo, r.number), r])).values()];
  if (!last.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(last)) {
      await q.run(q.k.insertInto("pr_checks").values(part.map((r) => ({
        repo: r.repo, number: r.number, head_oid: r.head_oid, state: r.state, is_draft: r.is_draft, overall: r.overall, checks: r.checks,
        mergeable: r.mergeable, maintainer_can_modify: r.maintainer_can_modify, fetched_at: at,
      }))).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => ({
        ...kx.excluded(["head_oid", "state", "is_draft", "overall", "checks", "maintainer_can_modify", "fetched_at"])(eb),
        mergeable: keepKnownMergeableExpr(eb, "pr_checks"),
      }))));
    }
  });
}

/** Rows of a repo's most recent PR checks that tell whether it has CI. */
const NO_CI_SAMPLE = 20;

/** Whether a repo's checks are known (some row exists) and whether it has no CI (none of its latest 20 rows reported a check); a repo asked for with no rows is neither. */
export async function loadRepoCiSignals(db: Db, repos?: string[]): Promise<Map<string, RepoCiSignals>> {
  const out = new Map<string, RepoCiSignals>();
  if (repos && !repos.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom((eb) => eb.selectFrom("pr_checks").select(["repo", "overall", (e) => e.fn.agg<number>("row_number", []).over((o) => o.partitionBy("repo").orderBy("fetched_at", "desc")).as("n")])
      .$if(!!repos, (b) => b.where(kx.inList(db, "repo", repos!))).as("c"))
    .select((eb) => ["c.repo", eb.fn.countAll<number>().as("rows"), eb.fn.sum<number>(eb.case().when(eb.or([eb("c.overall", "is", null), eb("c.overall", "=", "none")])).then(eb.lit(0)).else(eb.lit(1)).end()).as("reported")])
    .where("c.n", "<=", NO_CI_SAMPLE).groupBy("c.repo"), { label: "mirror.loadRepoCiSignals" });
  for (const r of rows) out.set(r.repo, { known: true, noCi: Number(r.reported) === 0 });
  for (const repo of repos ?? []) if (!out.has(repo)) out.set(repo, { known: false, noCi: false });
  return out;
}

/** Check names seen on the latest 40 PR rows and 10 main heads of each repo, sorted; a list that is not an array names nothing. Two statements in one wave. */
export async function loadCheckSamples(db: Db, repos: string[]): Promise<Map<string, { pr: string[]; main: string[] }>> {
  const out = new Map(repos.map((repo) => [repo, { pr: [] as string[], main: [] as string[] }]));
  if (!repos.length) return out;
  const q = queryDb(db);
  const named = (rows: AnyQ, newest: number) => {
    const name = kx.jsonEachField(db, "c.checks", "name", "e");
    const each = (q.k.selectFrom(rows.as("c") as never) as AnyQ).crossJoin(name.from).select(["c.repo", name.value.as("name")]).where("c.n", "<=", newest);
    return (q.k.selectFrom(each.as("x") as never) as AnyQ).select(["x.repo", "x.name"]).distinct().where("x.name", "is not", null).where("x.name", "<>", "");
  };
  const [pr, main] = await Promise.all([
    q.all(named(q.k.selectFrom("pr_checks").select(["repo", "checks", (e) => e.fn.agg<number>("row_number", []).over((o) => o.partitionBy("repo").orderBy("fetched_at", "desc")).as("n")]).where(kx.inList(db, "repo", repos)), 40), { label: "mirror.loadCheckSamples" }),
    q.all(named(q.k.selectFrom("main_ci").select(["repo", "checks", (e) => e.fn.agg<number>("row_number", []).over((o) => o.partitionBy("repo").orderBy("updated_at", "desc")).as("n")]).where(kx.inList(db, "repo", repos)), 10), { label: "mirror.loadCheckSamples" }),
  ]) as { repo: string; name: string }[][];
  for (const r of pr!) out.get(r.repo)!.pr.push(String(r.name));
  for (const r of main!) out.get(r.repo)!.main.push(String(r.name));
  for (const s of out.values()) { s.pr.sort(); s.main.sort(); }
  return out;
}

/** Review gate rows of the PRs, or of every PR of a repo. */
export async function loadGates(db: Db, keys: KeySource | { repo: string }): Promise<Map<RefKey, Gate>> {
  const q = queryDb(db);
  const cols = ["repo", "number", "blocked", "by_login", "read_at", "failures"] as const;
  const out = new Map<RefKey, Gate>();
  if (!Array.isArray(keys) && "repo" in keys && typeof keys.repo === "string") {
    for (const r of await q.all(q.k.selectFrom("review_gates").select(cols).where("repo", "=", keys.repo), { label: "mirror.loadGates" })) out.set(refKey(r.repo, r.number), r);
    return out;
  }
  const parts = await Promise.all(keyChunks(keys as KeySource).map((k) => q.all((joinKeys(db, q.k.selectFrom("review_gates as g"), k, "g") as AnyQ).select(cols.map((c) => `g.${c}`) as never), { label: "mirror.loadGates" })));
  for (const rows of parts) for (const r of rows as Gate[]) out.set(refKey(r.repo, r.number), r);
  return out;
}

/** Batched upsert of successful live reads; each resets the failure counter. A PR given twice keeps its last read. */
export async function saveGates(db: Db, rows: GateRead[]): Promise<void> {
  const last = [...new Map(rows.map((r) => [refKey(r.repo, r.number), r])).values()];
  if (!last.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(last)) {
      await q.run(q.k.insertInto("review_gates").values(part.map((r) => ({ repo: r.repo, number: r.number, blocked: r.blocked, by_login: r.by_login, read_at: r.read_at, failures: 0 })))
        .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["blocked", "by_login", "read_at", "failures"]))));
    }
  });
}

/** Batched increment of the gate failure counter; a key given twice counts twice. */
export async function markGateFailures(db: Db, keys: RefKey[]): Promise<void> {
  if (!keys.length) return;
  const counts = new Map<RefKey, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches([...counts])) {
      await q.run(q.k.insertInto("review_gates").values(part.map(([k, n]) => ({ ...splitKey(k), failures: n })))
        .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => ({ failures: eb("review_gates.failures", "+", eb.ref("excluded.failures")) }))));
    }
  });
}

const headRows = (heads: readonly DiffFactsKey[]) => heads.map((h) => [splitKey(h.ref).repo, splitKey(h.ref).number, h.head] as const);
const headIn = (db: Db, t: string, heads: readonly DiffFactsKey[]) => kx.tupleIn(db, [`${t}.repo`, `${t}.number`, `${t}.head_oid`], headRows(heads), ["text", "bigint", "text"]);
const isHeads = (x: DiffFactsKey[] | KeySource): x is DiffFactsKey[] => Array.isArray(x) && (x.length === 0 || "head" in x[0]!);
const factKey = (r: { repo: string; number: number; head_oid: string }) => `${refKey(r.repo, r.number)}@${r.head_oid}`;
const FACT_COLUMNS = ["repo", "number", "head_oid", "reasons", "lines", "pending", "last_read"] as const;

/** Diff facts keyed "ref@head": the given heads, or every head stored for the keyed items. */
export async function loadDiffFacts(db: Db, heads: DiffFactsKey[] | KeySource): Promise<Map<string, DiffFactsRow>> {
  const q = queryDb(db);
  const out = new Map<string, DiffFactsRow>();
  const queries = isHeads(heads)
    ? kx.chunks(heads).map((c) => q.all(q.k.selectFrom("diff_facts as x").select(FACT_COLUMNS.map((f) => `x.${f}`) as never).where(headIn(db, "x", c)), { label: "mirror.loadDiffFacts" }))
    : keyChunks(heads as KeySource).map((k) => q.all((joinKeys(db, q.k.selectFrom("diff_facts as x"), k, "x") as AnyQ).select(FACT_COLUMNS.map((f) => `x.${f}`) as never), { label: "mirror.loadDiffFacts" }));
  for (const rows of await Promise.all(queries)) for (const r of rows as DiffFactsRow[]) out.set(factKey(r), r);
  return out;
}

/** Every diff-facts row, for the rebuild only. Marked `alone`. */
export async function loadAllDiffFacts(db: Db): Promise<Map<string, DiffFactsRow>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("diff_facts").select(FACT_COLUMNS), { alone: true, label: "mirror.loadAllDiffFacts" });
  return new Map(rows.map((r) => [factKey(r), r]));
}

/** Batched upsert of diff facts: "upsert-if-changed" writes a row only when a fact differs, "insert-ignore" leaves a stored row alone. A head given twice keeps its last row. */
export async function saveDiffFacts(db: Db, rows: DiffFactsRow[], mode: "upsert-if-changed" | "insert-ignore"): Promise<void> {
  const last = [...new Map(rows.map((r) => [factKey(r), r])).values()];
  if (!last.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(last)) {
      const ins = q.k.insertInto("diff_facts").values(part.map((r) => ({ repo: r.repo, number: r.number, head_oid: r.head_oid, reasons: r.reasons, lines: r.lines, pending: r.pending, last_read: r.last_read })));
      await q.run(mode === "insert-ignore" ? ins.onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doNothing())
        : ins.onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doUpdateSet(kx.excluded(["reasons", "lines", "pending", "last_read"]))
          .where((eb) => eb.or(["reasons", "lines", "pending", "last_read"].map((c) => eb(`diff_facts.${c}` as "diff_facts.lines", "is distinct from", eb.ref(`excluded.${c}` as "excluded.lines")))))));
    }
  });
}

/**
 * Compare-and-set: each row is written only while the stored row still holds `was` (every fact compared with IS NOT DISTINCT FROM). A row with
 * `was` null is inserted when absent. Returns the rows written.
 */
export async function setDiffFactsIf(db: Db, rows: { key: DiffFactsKey; was: DiffFactsRow | null; to: DiffFactsRow }[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    let changed = 0;
    const fresh = rows.filter((r) => !r.was).map((r) => r.to);
    for (const part of kx.batches(fresh)) {
      changed += (await q.run(q.k.insertInto("diff_facts").values(part.map((r) => ({ repo: r.repo, number: r.number, head_oid: r.head_oid, reasons: r.reasons, lines: r.lines, pending: r.pending, last_read: r.last_read })))
        .onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doNothing()))).changes;
    }
    const guarded = rows.filter((r) => r.was).map((r) => ({
      repo: r.to.repo, number: r.to.number, head_oid: r.to.head_oid, reasons: r.to.reasons, lines: r.to.lines, pending: r.to.pending, last_read: r.to.last_read,
      w_reasons: r.was!.reasons, w_lines: r.was!.lines, w_pending: r.was!.pending, w_last_read: r.was!.last_read,
    }));
    for (const part of kx.chunks(guarded)) {
      const v = kx.valuesTable(db, part, { repo: "text", number: "bigint", head_oid: "text", reasons: "text", lines: "bigint", pending: "bigint", last_read: "bigint", w_reasons: "text", w_lines: "bigint", w_pending: "bigint", w_last_read: "bigint" }, "v");
      changed += (await q.run((q.k.updateTable("diff_facts") as any).from(v)
        .set((eb: kx.AnyEb) => ({ reasons: eb.ref("v.reasons"), lines: eb.ref("v.lines"), pending: eb.ref("v.pending"), last_read: eb.ref("v.last_read") }))
        .where((eb: kx.AnyEb) => eb.and([
          eb("diff_facts.repo", "=", eb.ref("v.repo")), eb("diff_facts.number", "=", eb.ref("v.number")), eb("diff_facts.head_oid", "=", eb.ref("v.head_oid")),
          eb("diff_facts.reasons", "is not distinct from", eb.ref("v.w_reasons")), eb("diff_facts.lines", "is not distinct from", eb.ref("v.w_lines")),
          eb("diff_facts.pending", "is not distinct from", eb.ref("v.w_pending")), eb("diff_facts.last_read", "is not distinct from", eb.ref("v.w_last_read")),
        ])))).changes;
    }
    return changed;
  });
}

/** Batched update of the read time (a number, as stored). */
export async function markDiffRead(db: Db, heads: DiffFactsKey[], at: number): Promise<void> {
  if (!heads.length) return;
  const q = queryDb(db);
  await db.write(async () => { for (const c of kx.chunks(heads)) await q.run(q.k.updateTable("diff_facts").set({ last_read: at }).where(headIn(db, "diff_facts", c))); });
}

/** Batched delete. */
export async function removeDiffFacts(db: Db, heads: DiffFactsKey[]): Promise<void> {
  if (!heads.length) return;
  const q = queryDb(db);
  await db.write(async () => { for (const c of kx.chunks(heads)) await q.run(q.k.deleteFrom("diff_facts").where(headIn(db, "diff_facts", c))); });
}
