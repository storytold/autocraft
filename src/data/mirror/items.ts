// Item loaders (M01 mirror-a).
// reads: workflow.item_workflows (listItems `inScope`, through the workflow fragment), control.tracked_repos (through control fragments)
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { parseSearch } from "../../db/search.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { inScopeExpr } from "../workflow/fragments.ts";
import type { KeySource } from "../keys.ts";
import { joinKeys, keyChunks, presetColumns, qualified, refKey, splitKey, type AnyQ } from "./shared.ts";
import type { HiddenRepos, ItemFilter, ItemHashes, ItemHit, ItemKind, ItemOf, ItemPreset, ItemRef, ItemShown, OpenPrRow, PrMirror, RefKey, SnippetMarks } from "./types.ts";

const select = <Q extends AnyQ>(q: Q, columns: readonly string[]): Q => q.select(columns as never) as Q;

/** Rows of the preset's columns for each key; a missing key is absent. One statement (one per 10,000 refs for a list). With `alone` a whole-repo `text` or `full` load is never fused into a `together` wave. */
export async function loadItems<P extends ItemPreset>(db: Db, keys: KeySource, preset: P, opts?: { alone?: boolean }): Promise<Map<RefKey, ItemOf<P>>> {
  const q = queryDb(db);
  const cols = qualified("i", presetColumns(preset));
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all(select(joinKeys(db, q.k.selectFrom("items as i"), k, "i"), cols), { alone: opts?.alone, label: "mirror.loadItems" })));
  const out = new Map<RefKey, ItemOf<P>>();
  for (const rows of parts) for (const r of rows as ItemRef[]) out.set(refKey(r.repo, r.number), r as ItemOf<P>);
  return out;
}

/** The conditions of a filter on the items table aliased `i`. */
function conditions(db: Db, eb: kx.AnyEb, f: ItemFilter): Expression<SqlBool>[] {
  const c: Expression<SqlBool>[] = [];
  if (f.repos) c.push(kx.inList(db, "i.repo", f.repos));
  if (f.kind) c.push(eb("i.kind", "=", f.kind));
  if (f.states) c.push(kx.inList(db, "i.state", f.states));
  if (f.numbers) c.push(kx.inList(db, "i.number", f.numbers, "bigint"));
  if (f.author !== undefined) c.push(eb("i.author", "=", f.author));
  if (f.labelsAny) c.push(eb.exists(eb.selectFrom(kx.jsonEach(db, eb.ref("i.labels"), "l")).select(eb.lit(1).as("one")).where(kx.inList(db, "l.value", f.labelsAny))));
  if (f.createdBetween) c.push(eb("i.created_at", ">=", f.createdBetween[0]), eb("i.created_at", "<", f.createdBetween[1]));
  if (f.updatedSince !== undefined) c.push(eb("i.updated_at", ">=", f.updatedSince));
  if (f.closedBetween) c.push(eb("i.closed_at", ">=", f.closedBetween[0]), eb("i.closed_at", "<", f.closedBetween[1]));
  if (f.mergedBetween) c.push(eb("i.merged_at", ">=", f.mergedBetween[0]), eb("i.merged_at", "<", f.mergedBetween[1]));
  if (f.headOid !== undefined) c.push(eb("i.head_oid", "=", f.headOid));
  if (f.inScope) c.push(inScopeExpr(db, eb, "i.repo", "i.number"));
  if (f.hidden) c.push(hiddenRepos(db, "i.repo", f.hidden));
  if (f.page) {
    const { repo, number } = splitKey(f.page.after);
    c.push(eb.or([eb("i.repo", ">", repo), eb.and([eb("i.repo", "=", repo), eb("i.number", ">", number)])]));
  }
  return c;
}

/** Items matching the filter, ordered by repo and number; one statement. */
export async function listItems<P extends ItemPreset>(db: Db, filter: ItemFilter, preset: P): Promise<ItemOf<P>[]> {
  const q = queryDb(db);
  const base = select(q.k.selectFrom("items as i") as AnyQ, qualified("i", presetColumns(preset)))
    .where((eb) => eb.and(conditions(db, eb, filter))).orderBy("i.repo").orderBy("i.number");
  return (await q.all(filter.page ? base.limit(filter.page.limit) : base, { label: "mirror.listItems" })) as ItemOf<P>[];
}

/** Open item numbers per repo, ascending; a repo with none is absent. */
export async function loadOpenNumbers(db: Db, repos: string[], kind?: ItemKind): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!repos.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("items as i").select(["i.repo", "i.number"]).where(kx.inList(db, "i.repo", repos)).where("i.state", "=", "OPEN")
    .$if(!!kind, (b) => b.where("i.kind", "=", kind!)).orderBy("i.repo").orderBy("i.number"), { label: "mirror.loadOpenNumbers" });
  for (const r of rows) (out.get(r.repo) ?? out.set(r.repo, []).get(r.repo)!).push(r.number);
  return out;
}

/** The `pr` preset joined to `pr_checks`; `checks.checks` text only when `overall` is failure. */
export async function loadPrMirror(db: Db, keys: KeySource): Promise<Map<RefKey, PrMirror>> {
  const q = queryDb(db);
  const itemCols = presetColumns("pr");
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all(
    joinKeys(db, q.k.selectFrom("items as i"), k, "i")
      .leftJoin("pr_checks as pc", (j) => j.onRef("pc.repo", "=", "i.repo").onRef("pc.number", "=", "i.number"))
      .select((eb) => [
        ...qualified("i", itemCols).map((c) => eb.ref(c as "i.repo").as(`i_${c.slice(2)}`)),
        eb.ref("pc.head_oid").as("c_head_oid"), eb.ref("pc.state").as("c_state"), eb.ref("pc.is_draft").as("c_is_draft"), eb.ref("pc.overall").as("c_overall"),
        eb.case().when("pc.overall", "in", ["failure", "pending"]).then(eb.ref("pc.checks")).end().as("c_checks"),
        eb.ref("pc.mergeable").as("c_mergeable"), eb.ref("pc.maintainer_can_modify").as("c_mcm"), eb.ref("pc.fetched_at").as("c_fetched_at"),
      ]), { label: "mirror.loadPrMirror" })));
  const out = new Map<RefKey, PrMirror>();
  for (const rows of parts) for (const r of rows as Record<string, any>[]) {
    const item = Object.fromEntries(itemCols.map((c) => [c, r[`i_${c}`]])) as unknown as ItemOf<"pr">;
    const checks = r.c_overall === null || r.c_overall === undefined ? null
      : { repo: item.repo, number: item.number, head_oid: r.c_head_oid, state: r.c_state, is_draft: r.c_is_draft, overall: r.c_overall, checks: r.c_checks ?? null,
          mergeable: r.c_mergeable, maintainer_can_modify: r.c_mcm, fetched_at: r.c_fetched_at };
    out.set(refKey(item.repo, item.number), { item, checks });
  }
  return out;
}

const NO_REFS = JSON.stringify([[], []]);

/** Open PRs that can hold an issue, with author, closing issues and text refs; title and body only where `text_refs` is null. Ordered by repo, then number descending. */
export async function loadOpenPrLinks(db: Db, repos?: string[]): Promise<OpenPrRow[]> {
  if (repos && !repos.length) return [];
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("items")
    .select((eb) => ["repo", "number", "author", "closing_issues", "text_refs",
      eb.case().when("text_refs", "is", null).then(eb.ref("title")).end().as("title"),
      eb.case().when("text_refs", "is", null).then(eb.ref("body")).end().as("body")])
    .where("kind", "=", "pr").where("state", "=", "OPEN")
    .where((eb) => eb.or([eb("text_refs", "is", null), eb("text_refs", "<>", NO_REFS), eb.and([eb("closing_issues", "is not", null), eb("closing_issues", "<>", "[]")])]))
    .$if(!!repos, (b) => b.where(kx.inList(db, "repo", repos!)))
    .orderBy("repo").orderBy("number", "desc"), { label: "mirror.loadOpenPrLinks" });
}

/** Item counts grouped by one column; without `by` one total under the key "". */
export async function countItems(db: Db, filter: ItemFilter, by?: "repo" | "kind" | "state"): Promise<Map<string, number>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("items as i")
    .select((eb) => [by ? eb.ref(`i.${by}`).as("k") : eb.val("").as("k"), eb.fn.countAll<number>().as("n")])
    .where((eb) => eb.and(conditions(db, eb, filter)))
    .$if(!!by, (b) => b.groupBy(`i.${by}` as "i.repo")), { label: "mirror.countItems" });
  return new Map(rows.map((r) => [String(r.k), Number(r.n)]));
}

const STATE: Record<string, ItemShown["state"]> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };

/** Kind, state and title of the referenced items; no per-key fallback read. */
export async function loadShown(db: Db, keys: KeySource): Promise<Map<RefKey, ItemShown>> {
  const q = queryDb(db);
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all(select(joinKeys(db, q.k.selectFrom("items as i"), k, "i"), ["i.repo", "i.number", "i.kind", "i.state", "i.title"]), { label: "mirror.loadShown" })));
  const out = new Map<RefKey, ItemShown>();
  for (const rows of parts) for (const r of rows as { repo: string; number: number; kind: string; state: string; title: string | null }[])
    out.set(refKey(r.repo, r.number), { kind: r.kind === "pr" ? "pr" : "issue", state: STATE[r.state] ?? "open", title: r.title });
  return out;
}

const MARKS: SnippetMarks = { open: "\u0002", close: "\u0003", words: 24 };

/** Full-text item search over title and body, best first (lower score); no hit for a query with nothing to search. `limit` defaults to 20. */
export async function searchItems(db: Db, search: string, opts: { repos?: string[]; kind?: ItemKind; limit?: number; hidden?: HiddenRepos; snippets?: boolean; titleOnly?: boolean }): Promise<ItemHit[]> {
  const s = parseSearch(search);
  if (!s) return [];
  if (opts.repos && !opts.repos.length) return [];
  const q = queryDb(db);
  const hits = kx.itemHits(db, s, { score: true, titleOnly: opts.titleOnly, ...(opts.snippets ? { snippets: MARKS } : {}) }, "h");
  const rows = await q.all((q.k.selectFrom(hits) as AnyQ)
    .innerJoin("items as i", (j: any) => j.on(kx.rowid("items", "i"), "=", (eb: kx.AnyEb) => eb.ref("h.rid")))
    .select(["i.repo", "i.number", "h.score", ...(opts.snippets ? ["h.title_snippet", "h.body_snippet"] : [])] as never)
    .$if(!!opts.repos, (b: AnyQ) => b.where(kx.inList(db, "i.repo", opts.repos!)))
    .$if(!!opts.kind, (b: AnyQ) => b.where("i.kind", "=", opts.kind!))
    .$if(!!opts.hidden, (b: AnyQ) => b.where(hiddenRepos(db, "i.repo", opts.hidden!)))
    .orderBy("h.score").orderBy("i.repo").orderBy("i.number").limit(opts.limit ?? 20), { label: "mirror.searchItems" });
  return (rows as { repo: string; number: number; score: number; title_snippet?: string | null; body_snippet?: string | null }[]).map((r) => ({
    ref: refKey(r.repo, r.number), score: r.score,
    ...(opts.snippets ? { snippets: [r.title_snippet, r.body_snippet].filter((x): x is string => !!x && x.includes(MARKS.open)) } : {}),
  }));
}

/**
 * Items of `repo`, open or closed (else updated) since `since`, whose title or body contains one of `texts` as written (ASCII case
 * aside), by number. An exact-text scan of the repo: the text index knows words, and Postgres keeps a URL or a path as one word, so
 * it does not find a path inside one. One statement.
 */
export async function listMentioning(db: Db, repo: string, texts: string[], opts: { since: string }): Promise<ItemOf<"text">[]> {
  if (!texts.length) return [];
  const q = queryDb(db);
  const rows = select(q.k.selectFrom("items as i") as AnyQ, qualified("i", presetColumns("text"))).where("i.repo", "=", repo)
    .where((eb) => eb.or([eb("i.state", "=", "OPEN"), eb(eb.fn.coalesce("i.closed_at", "i.merged_at", "i.updated_at"), ">=", opts.since)]))
    .where((eb) => eb.or(texts.flatMap((t) => { const pattern = eb.val(`%${kx.likeEscape(t)}%`); return [kx.like(db, "i.title", pattern, "\\"), kx.like(db, "i.body", pattern, "\\")]; })))
    .orderBy("i.number");
  return (await q.all(rows, { label: "mirror.listMentioning" })) as ItemOf<"text">[];
}

/**
 * The `card` columns and the stored text hashes (embedding text, classifier input and its scheme) of each key: the planner's item
 * pass reads these without the bodies. One statement (one per 10,000 refs for a list).
 */
export async function loadItemsWithHashes(db: Db, keys: KeySource): Promise<Map<RefKey, ItemOf<"card"> & ItemHashes>> {
  const q = queryDb(db);
  const cols = qualified("i", [...presetColumns("card"), "embed_hash", "class_hash", "class_scheme"]);
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all(select(joinKeys(db, q.k.selectFrom("items as i"), k, "i"), cols), { label: "mirror.loadItemsWithHashes" })));
  const out = new Map<RefKey, ItemOf<"card"> & ItemHashes>();
  for (const rows of parts) for (const r of rows as (ItemOf<"card"> & ItemHashes)[]) out.set(refKey(r.repo, r.number), r);
  return out;
}

/** The `limit` most recently updated items of the repos, newest first. */
export async function loadRecentRefs(db: Db, repos: readonly string[], limit: number): Promise<{ repo: string; number: number }[]> {
  if (!repos.length) return [];
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.items as i").select(["i.repo", "i.number"]).where(kx.inList(db, "i.repo", repos))
    .orderBy("i.updated_at", "desc").orderBy("i.repo").orderBy("i.number", "desc").limit(limit), { label: "mirror.loadRecentRefs" });
  return rows.map((r) => ({ repo: r.repo, number: Number(r.number) }));
}
