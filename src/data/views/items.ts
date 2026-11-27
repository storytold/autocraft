// reads: mirror.items, planner.item_plans
// Top-bar search and the hover card of an item.
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { parseSearch, type Search } from "../../db/search.ts";
import { hiddenRepos, trackedRepo } from "../control/fragments.ts";
import type { Scope } from "./types.ts";

/** The item's rowid is among the full-text hits of the search; needs the items table aliased `i`. */
export const textHit = (eb: kx.AnyEb, db: Db, s: Search): Expression<SqlBool> =>
  eb(kx.rowid("items", "i"), "in", queryDb(db).k.selectFrom(kx.itemHits(db, s, {}, "h")).select("h.rid"));

export type QuickHit = { repo: string; number: number; kind: string; title: string | null; author: string | null; state: string };

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const COLS = ["repo", "number", "kind", "title", "author", "state"] as const;
const HITS = 100;

/**
 * Items for the top-bar search: `repo#n`, `#n` and bare numbers match by number; one word may be an author's login (that author's
 * latest items first); text goes through the full-text index, titles first, newest hits first. At most `limit` rows.
 */
export async function loadQuickSearch(db: Db, scope: Pick<Scope, "hidden">, query: string, o: { limit: number }): Promise<QuickHit[]> {
  const text = query.trim().slice(0, 200);
  if (!text) return [];
  const q = queryDb(db);
  const hide = (col: string) => hiddenRepos(db, col, scope.hidden);
  const ref = /^([A-Za-z0-9._-]+)?#(\d{1,9})$/.exec(text) ?? /^()(\d{1,9})$/.exec(text);
  if (ref) {
    return await q.all(q.k.selectFrom("main.items").select([...COLS])
      .where((eb) => kx.like(db, eb.cast<string>("number", "text"), eb.val(`${ref[2]}%`))).where(hide("repo")).where((eb) => trackedRepo(eb, "repo"))
      .$if(!!ref[1], (b) => b.where((eb) => kx.like(db, "repo", eb.val(`${likeEscape(ref[1]!)}%`), "\\")))
      .orderBy((eb) => eb.fn<number>("length", [eb.cast<string>("number", "text")])).orderBy("repo").orderBy("number").limit(o.limit)) as QuickHit[];
  }
  const fts = parseSearch(text, true);
  const look = (titleOnly: boolean) => q.all(q.k
    .with("hits", (qb) => qb.selectFrom(kx.itemHits(db, fts!, { titleOnly }, "x")).select("x.rid").orderBy("x.rid", "desc").limit(HITS))
    .selectFrom("hits as h").innerJoin("main.items as i", (j) => j.on(kx.rowid("main.items", "i"), "=", (eb) => eb.ref("h.rid")))
    .select(["i.repo", "i.number", "i.kind", "i.title", "i.author", "i.state"]).where(hide("i.repo")).where((eb) => trackedRepo(eb, "i.repo"))
    .orderBy((eb) => eb("i.state", "<>", "OPEN")).orderBy("i.updated_at", (ob) => ob.desc().nullsLast()).limit(o.limit)) as Promise<QuickHit[]>;
  const [byAuthor, byTitle] = await db.together(() => Promise.all([
    // A single word may be a login: that author's latest items first.
    /^[A-Za-z0-9-]{2,39}$/.test(text)
      ? q.all(q.k.selectFrom(kx.indexedBy(db, "main.items", "items_author_nocase", "a")).select([...COLS])
        .where((eb) => kx.like(db, "author", eb.val(`${text}%`))).where((eb) => eb("repo", "in", eb.selectFrom("main.tracked_repos").select("name")))
        .where(hide("repo")).orderBy((eb) => eb("state", "<>", "OPEN")).orderBy("updated_at", (ob) => ob.desc().nullsLast()).limit(5)) as Promise<QuickHit[]>
      : Promise.resolve([] as QuickHit[]),
    fts ? look(true) : Promise.resolve([] as QuickHit[]),
  ]));
  if (!fts) return byAuthor;
  let hits = byTitle;
  if (hits.length < o.limit) {
    const seen = new Set(hits.map((r) => `${r.repo}#${r.number}`));
    hits = [...hits, ...(await look(false)).filter((r) => !seen.has(`${r.repo}#${r.number}`))];
  }
  const have = new Set(byAuthor.map((r) => `${r.repo}#${r.number}`));
  return [...byAuthor, ...hits.filter((r) => !have.has(`${r.repo}#${r.number}`))].slice(0, o.limit);
}

export type PeekRow = {
  repo: string; number: number; kind: string; state: string; title: string | null; author: string | null; labels: string | null; created_at: string | null;
  updated_at: string | null; merged_at: string | null; closed_at: string | null; closing_issues: string | null; view: string | null;
};

/** The columns of the hover card and the item's stored plan view; null when the item is not in the mirror. */
export async function loadItemPeek(db: Db, ref: { repo: string; number: number }): Promise<PeekRow | null> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("main.items as i").leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .select(["i.repo", "i.number", "i.kind", "i.state", "i.title", "i.author", "i.labels", "i.created_at", "i.updated_at", "i.merged_at", "i.closed_at", "i.closing_issues", "p.view"])
    .where("i.repo", "=", ref.repo).where("i.number", "=", ref.number))) ?? null;
}

export type ItemSearch = {
  text?: string; repo?: string; kind?: "issue" | "pr"; state: "open" | "closed" | "merged" | "all"; author?: string; since?: string; limit: number; offset: number;
};
export type ItemSearchRow = {
  repo: string; number: number; kind: string; state: string; title: string | null; author: string | null; created_at: string | null; updated_at: string | null; comments_count: number | null;
};

const STATES = { open: ["OPEN"], closed: ["CLOSED"], merged: ["MERGED"], all: null } as const;

/**
 * One page of the tracked items the scope may see, newest update first: `text` through the full-text index, `author` as the exact login
 * (case aside, never a pattern), `since` an update on or after that time. `total` counts every match. One wave.
 */
export async function loadItemSearch(db: Db, scope: Pick<Scope, "hidden">, f: ItemSearch): Promise<{ rows: ItemSearchRow[]; total: number }> {
  const fts = f.text?.trim() ? parseSearch(f.text.trim().slice(0, 200)) : null;
  if (f.text?.trim() && !fts) return { rows: [], total: 0 };
  const q = queryDb(db);
  const states = STATES[f.state];
  const where = (eb: kx.AnyEb): Expression<SqlBool> => eb.and([
    trackedRepo(eb, "i.repo"), hiddenRepos(db, "i.repo", scope.hidden),
    ...(f.repo ? [eb("i.repo", "=", f.repo)] : []),
    ...(f.kind ? [eb("i.kind", "=", f.kind)] : []),
    ...(states ? [kx.inList(db, "i.state", [...states])] : []),
    ...(f.author ? [kx.nocaseEq(db, "i.author", eb.val(f.author))] : []),
    ...(f.since ? [eb("i.updated_at", ">=", f.since)] : []),
    ...(fts ? [textHit(eb, db, fts)] : []),
  ]);
  const [rows, count] = await db.together(() => Promise.all([
      q.all(q.k.selectFrom("main.items as i").select(["i.repo", "i.number", "i.kind", "i.state", "i.title", "i.author", "i.created_at", "i.updated_at", "i.comments_count"])
        .where(where).orderBy("i.updated_at", (ob) => ob.desc().nullsLast()).orderBy("i.repo").orderBy("i.number", "desc").limit(f.limit).offset(f.offset)),
      q.get(q.k.selectFrom("main.items as i").select((eb) => eb.fn.countAll<number>().as("n")).where(where)),
  ]));
  return { rows: (rows as ItemSearchRow[]).map((r) => ({ ...r, number: Number(r.number) })), total: Number(count?.n ?? 0) };
}
