// reads: mirror.items, mirror.comments, triage.item_rank, triage.item_areas, triage.dupe_group_items, triage.classifications, workflow.item_workflows,
//        workflow.workflow_events, discord.discord_mentions, review.opus_reviews, intake.outside_holds, planner.liveness_items, access.access
// The Items browser: the items of the visible repos that match a parsed query (src/core/item-query.ts), one page in the asked order,
// with the facts each row shows. Every request is a fixed number of statements: the page, its total and, when asked, the count of
// every preset and the quick-filter values. All of them start from one derived table of an item and its narrow facts.
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { parseSearch } from "../../db/search.ts";
import { queryDb } from "../../db/query-db.ts";
import { itemOfValue, KINDS, type ItemQuery, type QueryTerm } from "../../core/item-query.ts";
import { ownerOf } from "../../owners.ts";
import { reviewBots } from "../../review/bots.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { heldExpr } from "../intake/fragments.ts";
import { stuckItem } from "../planner/fragments.ts";
import { quietPrExpr } from "../security/fragments.ts";
import { hasSecurityVerdict, isDuplicateClose } from "../triage/fragments.ts";
import { LIVE_STATES } from "../workflow/fragments.ts";
import { ASKING_STATES, RULE_STARTER } from "../../workflow/types.ts";
import { textHit } from "./items.ts";
import type { Scope } from "./types.ts";

/** `insiders`: the lower-case logins of the team beyond the repo's collaborators (operators, maintainers, own logins; loadInsiders). */
export type BrowseScope = Pick<Scope, "repos" | "hidden" | "staff"> & { login: string | null; insiders?: readonly string[] };

/** One matched item as read: the item's own columns and its facts. Numbers may come back as text on Postgres. */
export type BrowseItem = {
  repo: string; number: number; kind: string; state: string; is_draft: number | null; title: string | null; author: string | null; outside: number; team: number;
  labels: string | null; priority: string | null; size: string | null; classified: string | null; area: string | null;
  comments: number; reactions: number; discord: number; linked: number | null; ci_state: string | null;
  autocraft: string; asks_me: number; approved: number; duplicate: number; created_at: string | null; updated_at: string | null;
};

export type BrowsePage = { rows: BrowseItem[]; total: number };
/** `refs`: only these items (`repo#number`), in this order. */
export type BrowseOpts = { offset: number; limit: number; normalWeight: number; refs?: string[] };

const MAINTAINER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
const CI: Record<string, string[]> = { green: ["SUCCESS"], red: ["FAILURE", "ERROR"], pending: ["PENDING", "EXPECTED"] };
const ITEM_STATE: Record<string, string> = { open: "OPEN", closed: "CLOSED", merged: "MERGED" };
/** What a person did that makes an item theirs (chat-build plan 1.5): the workflow event kinds. */
const MINE_EVENTS = ["started", "approved", "stopped", "resumed", "answered"];
const one = (eb: kx.AnyEb) => eb.lit(1).as("one");

/**
 * The derived table every statement reads, aliased `x`: the items of the scope with their rank, live and latest workflow, Discord
 * count, area and linked PR. `inner` adds conditions on the item itself (`i`), where the full-text index applies.
 */
function facts(db: Db, scope: BrowseScope, inner: (eb: kx.AnyEb) => Expression<SqlBool>[] = () => []) {
  const k = queryDb(db).k as any;
  const inRepos = (col: string) => kx.inList(db, col, scope.repos);
  const latest = k.selectFrom("main.item_workflows as lw0").select((eb: any) => ["lw0.repo", "lw0.number", eb.fn.max("lw0.id").as("id")])
    .where("lw0.state", "<>", "superseded").where(inRepos("lw0.repo")).groupBy(["lw0.repo", "lw0.number"]);
  const mentions = k.selectFrom("main.discord_mentions as dm0").select((eb: any) => ["dm0.repo", "dm0.number", eb.fn.countAll().as("n")])
    .where(inRepos("dm0.repo")).groupBy(["dm0.repo", "dm0.number"]);
  // The PRs that close each issue, the lowest number first; a PR closed without a merge closes nothing.
  const closers = k.selectFrom(["main.items as lp", kx.jsonEach(db, "lp.closing_issues", "lj", "bigint")])
    // The cast gives the column integer affinity on SQLite, so the join with the item's number can use an index.
    .select((eb: any) => ["lp.repo", eb.cast(eb.ref("lj.value"), "integer").as("issue"), eb.fn.min("lp.number").as("pr")])
    .where("lp.kind", "=", "pr").where("lp.state", "<>", "CLOSED").where("lp.closing_issues", "is not", null).where(inRepos("lp.repo")).groupBy(["lp.repo", "lj.value"]);
  const rank = (path: string) => kx.jsonText(db, "r.breakdown", path);
  const me = scope.login ?? "";
  const insider = (eb: any) => kx.inList(db, eb.fn("lower", [eb.fn.coalesce("i.author", eb.val(""))]), [...(scope.insiders ?? [])]);
  // As isBotAuthor (src/data/intake/pure.ts): the mirror's author type, or for rows synced before it was stored a `[bot]` suffix or a known app login.
  const bot = (eb: any) => eb.or([
    eb(eb.fn.coalesce("i.author_type", eb.val("")), "=", "Bot"),
    eb(eb.fn.coalesce("i.author", eb.val("")), "like", "%[bot]"),
    eb.and([eb("i.author_type", "is", null), kx.inList(db, eb.fn("lower", [eb.fn.coalesce("i.author", eb.val(""))]), [...reviewBots(), "github-actions"])]),
  ]);
  return k.selectFrom("main.items as i")
    .leftJoin("main.item_rank as r", (j: any) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
    .leftJoin("main.item_workflows as w", (j: any) => j.onRef("w.repo", "=", "i.repo").onRef("w.number", "=", "i.number").on("w.state", "in", LIVE_STATES))
    .leftJoin(latest.as("lx"), (j: any) => j.onRef("lx.repo", "=", "i.repo").onRef("lx.number", "=", "i.number"))
    .leftJoin("main.item_workflows as lw", "lw.id", "lx.id")
    .leftJoin(mentions.as("dm"), (j: any) => j.onRef("dm.repo", "=", "i.repo").onRef("dm.number", "=", "i.number"))
    .leftJoin(closers.as("cl"), (j: any) => j.onRef("cl.repo", "=", "i.repo").onRef("cl.issue", "=", "i.number"))
    .leftJoin("main.item_areas as ia", (j: any) => j.onRef("ia.repo", "=", "i.repo").onRef("ia.number", "=", "i.number"))
    .where((eb: any) => eb.and([inRepos("i.repo"), hiddenRepos(db, "i.repo", scope.hidden), ...inner(eb)]))
    .select((eb: any) => [
      "i.repo", "i.number", "i.kind", "i.state", "i.is_draft", "i.title", "i.author", "i.labels", "i.ci_state", "i.created_at", "i.updated_at", "i.head_oid",
      "i.author_association", "w.weight", "r.score", "ia.area",
      // As the pipeline judges authors (src/data/intake/pure.ts): the team is the repo's collaborators and the insiders, bots aside.
      eb.case().when(eb.and([eb("i.author", "is not", null), eb(eb.fn.coalesce("i.author_association", eb.val("")), "not in", MAINTAINER_ASSOCIATIONS), eb.not(insider(eb)), eb.not(bot(eb))])).then(1).else(0).end().as("outside"),
      eb.case().when(eb.and([eb("i.author", "is not", null), eb.or([eb("i.author_association", "in", MAINTAINER_ASSOCIATIONS), insider(eb)]), eb.not(bot(eb))])).then(1).else(0).end().as("team"),
      eb.fn.coalesce("i.comments_count", eb.lit(0)).as("comments"),
      eb.fn.coalesce("i.reactions_count", eb.lit(0)).as("reactions"),
      eb.fn.coalesce("dm.n", eb.lit(0)).as("discord"),
      // Staff see the level with the security raise; others the rated level, which says nothing about security findings.
      eb.case().when(rank("$.rated"), "is", null).then(null).else(scope.staff ? rank("$.level") : rank("$.rated")).end().as("priority"),
      eb.case().when(rank("$.sizeSource"), "=", "lines").then(rank("$.size")).else(null).end().as("size"),
      rank("$.type").as("classified"),
      eb.case().when("i.kind", "=", "pr").then(kx.jsonNum(db, "i.closing_issues", "$[0]")).else(eb.ref("cl.pr")).end().as("linked"),
      eb.case()
        // A row only the automatic merge rule started asks nobody (src/workflow/asked.ts): it is stopped, not waiting on a person.
        .when(eb.and([eb("w.state", "in", [...ASKING_STATES]), eb("w.started_by", "=", RULE_STARTER), eb("w.approved_by", "is", null), eb("w.taken_by", "is", null)])).then("stopped")
        .when("w.state", "in", [...ASKING_STATES]).then("waiting")
        .when("w.state", "=", "waiting").then("author")
        .when("w.state", "in", LIVE_STATES).then("running")
        .when("lw.state", "=", "stopped").then("held")
        .when("lw.state", "=", "backlog").then("backlog")
        .when("lw.state", "in", ["done", "closed"]).then("done")
        .else("none").end().as("autocraft"),
      eb.case().when(eb.and([
        eb("w.state", "in", [...ASKING_STATES]),
        eb.or([eb.and([kx.ciEq(db, "w.started_by", eb.val(me)), eb("w.started_by", "<>", RULE_STARTER)]), kx.ciEq(db, eb.fn.coalesce("w.approved_by", eb.val("")), eb.val(me)), kx.ciEq(db, eb.fn.coalesce("w.taken_by", eb.val("")), eb.val(me))]),
      ])).then(1).else(0).end().as("asks_me"),
      eb.case().when("w.approved_by", "is not", null).then(1).else(0).end().as("approved"),
      eb.case().when(isDuplicateClose(db, eb, "i.repo", "i.number")).then(1).else(0).end().as("duplicate"),
    ]);
}

/** The labels of the item `x` include one of `names`, case-insensitively. */
const hasLabel = (db: Db, eb: kx.AnyEb, names: string[]) =>
  eb.exists(kx.schemaEb(eb).selectFrom(kx.jsonEach(db, eb.fn.coalesce("x.labels", eb.val("[]")), "lb") as any).select(one(eb))
    .where(kx.inList(db, eb.fn("lower", ["lb.value"]), names.map((n) => n.toLowerCase()))));

/** A comment on `x` by a maintainer of the repo: an owner, member or collaborator, or a dashboard operator or maintainer. */
const maintainerReplied = (db: Db, eb: kx.AnyEb) => {
  const e = eb as any;
  return eb.exists(e.selectFrom("main.comments as c").select(one(eb)).whereRef("c.repo", "=", "x.repo").whereRef("c.number", "=", "x.number")
    .where("c.author", "is not", null).where((w: any) => w.not(kx.ciEq(db, "c.author", w.fn.coalesce("x.author", w.val("")))))
    .where((w: any) => w.or([
      w("c.author_association", "in", MAINTAINER_ASSOCIATIONS),
      w.exists(w.selectFrom("main.access as a").select(one(w)).where(kx.ciEq(db, "a.login", "c.author")).where("a.role", "in", ["operator", "maintainer"])),
    ])));
};

/** I started, approved or held one of its workflows, did one of MINE_EVENTS on it, or wrote a message in its conversation (as src/data/chat/mine.ts). */
const mine = (db: Db, eb: kx.AnyEb, login: string | null) => {
  if (!login) return eb.lit(false) as unknown as Expression<SqlBool>;
  const e = eb as any;
  const me = eb.val(login);
  return eb.or([
    eb.exists(e.selectFrom("main.item_workflows as mw").select(one(eb)).whereRef("mw.repo", "=", "x.repo").whereRef("mw.number", "=", "x.number")
      .where((w: any) => w.or([kx.ciEq(db, "mw.started_by", me), kx.ciEq(db, w.fn.coalesce("mw.approved_by", w.val("")), me), kx.ciEq(db, w.fn.coalesce("mw.stopped_by", w.val("")), me)]))),
    eb.exists(e.selectFrom("main.workflow_events as me").select(one(eb)).whereRef("me.repo", "=", "x.repo").whereRef("me.number", "=", "x.number")
      .where(kx.ciEq(db, "me.login", me)).where("me.kind", "in", MINE_EVENTS)),
    eb.exists(e.selectFrom("main.chat_messages as mm").innerJoin("main.chat_conversations as mc", "mc.id", "mm.conversation_id").select(one(eb))
      .whereRef("mc.repo", "=", "x.repo").whereRef("mc.number", "=", "x.number").where("mm.kind", "=", "said").where(kx.ciEq(db, "mm.author", me))),
  ]);
};

/** One term as a condition on `x`, before its negation. */
function termExpr(db: Db, eb: kx.AnyEb, scope: BrowseScope, t: QueryTerm): Expression<SqlBool> {
  const vs = t.values;
  const any = (es: Expression<SqlBool>[]) => (es.length === 1 ? es[0]! : eb.or(es));
  switch (t.key) {
    case "type": return eb("x.kind", "in", vs);
    case "state": return eb("x.state", "in", vs.map((v) => ITEM_STATE[v]!));
    case "label": return hasLabel(db, eb, vs);
    case "priority": return eb("x.priority", "in", vs);
    case "size": return eb("x.size", "in", vs);
    case "kind": return eb("x.classified", "in", vs.map((v) => KINDS[v]!));
    case "repo": return kx.inList(db, "x.repo", vs);
    case "author": return any(vs.map((v) => kx.ciEq(db, "x.author", eb.val(v))));
    case "area": {
      const named = vs.filter((v) => v !== "none");
      return any([...(named.length ? [kx.inList(db, eb.fn("lower", ["x.area"]), named.map((n) => n.toLowerCase()))] : []), ...(vs.includes("none") ? [eb("x.area", "is", null)] : [])]);
    }
    case "discord": return eb("x.discord", ">", 0);
    case "ci": return eb("x.ci_state", "in", vs.flatMap((v) => CI[v]!));
    case "review": return eb.exists((eb as any).selectFrom("main.opus_reviews as o").select(one(eb)).whereRef("o.repo", "=", "x.repo").whereRef("o.number", "=", "x.number")
      .whereRef("o.head_oid", "=", "x.head_oid").where("o.verdict", "=", "take").where("o.sure", "=", 1));
    case "autocraft": return eb("x.autocraft", "in", vs);
    case "items": {
      // A written owner must be the tracked repo's owner; an item of another owner's repo of the same name matches nothing.
      const refs = vs.flatMap((v) => {
        const i = itemOfValue(v);
        return i && (!i.owner || i.owner.toLowerCase() === ownerOf(i.repo).toLowerCase()) ? [[i.repo, i.number] as const] : [];
      });
      return kx.refIn(db, "x", refs);
    }
    case "has": return any(vs.map((v): Expression<SqlBool> => {
      switch (v) {
        case "pr": return eb("x.linked", "is not", null);
        case "label": return eb(eb.fn.coalesce("x.labels", eb.val("[]")), "not in", ["[]", ""]);
        case "priority": return eb("x.priority", "is not", null);
        case "area": return eb("x.area", "is not", null);
        case "kind": return eb("x.classified", "is not", null);
        case "discord": return eb("x.discord", ">", 0);
        default: return maintainerReplied(db, eb);
      }
    }));
    case "flag": return eb.and(vs.map((v): Expression<SqlBool> => {
      switch (v) {
        case "draft": return eb.and([eb("x.kind", "=", "pr"), eb("x.state", "=", ITEM_STATE.open!), eb("x.is_draft", "=", 1)]);
        case "ready": return eb.and([eb("x.kind", "=", "pr"), eb("x.state", "=", ITEM_STATE.open!), eb.or([eb("x.is_draft", "is", null), eb("x.is_draft", "!=", 1)])]);
        case "outside": return eb("x.outside", "=", 1);
        case "mine": return mine(db, eb, scope.login);
        case "asked": return eb("x.asks_me", "=", 1);
        case "approved": return eb("x.approved", "=", 1);
        case "duplicate": return eb("x.duplicate", "=", 1);
        case "outside-held": return heldExpr(eb, "x.repo", "x.number");
        case "stuck": return stuckItem(eb, "x");
        default: return eb.and([hasSecurityVerdict(db, eb, "x.repo", "x.number"), eb.not(quietPrExpr(eb, "x.repo", "x.number"))]);
      }
    }));
  }
}

/** Every term and the numbers of `q` as conditions on `x`. */
function conds(db: Db, eb: kx.AnyEb, scope: BrowseScope, q: Pick<ItemQuery, "terms" | "numbers">): Expression<SqlBool>[] {
  const out = q.terms.map((t) => (t.not ? eb.not(termExpr(db, eb, scope, t)) : termExpr(db, eb, scope, t)));
  if (q.numbers.length) out.push(eb("x.number", "in", q.numbers));
  return out;
}

/** The order of `q.sort`, then repo and number, so that pages never overlap. */
function ordered(b: any, q: ItemQuery, normalWeight: number) {
  const dir = q.sort.asc ? "asc" : "desc";
  const nz = (c: string) => (eb: any) => eb.fn.coalesce(c, eb.val(""));
  switch (q.sort.by) {
    case "created": b = b.orderBy(nz("x.created_at"), dir); break;
    case "comments": b = b.orderBy((eb: any) => eb(eb.ref("x.comments"), "+", eb.ref("x.reactions")), dir).orderBy(nz("x.updated_at"), "desc"); break;
    case "discord": b = b.orderBy("x.discord", dir).orderBy(nz("x.updated_at"), "desc"); break;
    case "priority": b = b.orderBy((eb: any) => eb.fn.coalesce("x.weight", eb.lit(normalWeight)), dir).orderBy((eb: any) => eb.fn.coalesce("x.score", eb.lit(-1)), dir).orderBy(nz("x.updated_at"), "desc"); break;
    default: b = b.orderBy(nz("x.updated_at"), dir);
  }
  return b.orderBy("x.repo").orderBy("x.number", "desc");
}

const ROW_COLS = ["repo", "number", "kind", "state", "is_draft", "title", "author", "outside", "team", "labels", "priority", "size", "classified", "area",
  "comments", "reactions", "discord", "linked", "ci_state", "autocraft", "asks_me", "approved", "duplicate", "created_at", "updated_at"].map((c) => `x.${c}`);

/** The statements of one page of the items matching `q` and of their count (exported for measuring them). */
export function browseStatements(db: Db, scope: BrowseScope, q: ItemQuery, o: BrowseOpts) {
  const fts = q.text ? parseSearch(q.text) : null;
  const refs = o.refs?.map((r) => [r.slice(0, r.lastIndexOf("#")), Number(r.slice(r.lastIndexOf("#") + 1))] as const);
  const matched = () => (queryDb(db).k as any).selectFrom(facts(db, scope, (eb) => (fts ? [textHit(eb, db, fts)] : [])).as("x"))
    .where((eb: any) => eb.and([...conds(db, eb, scope, q), ...(refs ? [kx.refIn(db, "x", refs)] : [])]));
  // Hits of a search by meaning keep their order, best first. The cast keeps the positions numbers on Postgres, where bound values in a CASE are text.
  const rows = refs ? matched().select(ROW_COLS).orderBy((eb: any) => eb.cast(kx.refCase(refs.map(([r, n], i) => [r, n, i] as const)), "integer")).orderBy("x.repo").orderBy("x.number", "desc") : ordered(matched().select(ROW_COLS), q, o.normalWeight);
  return { rows: rows.limit(o.limit).offset(o.offset), total: matched().select((eb: any) => eb.fn.countAll().as("n")) };
}

/** One page of the items matching `q`, and how many match. */
export async function loadBrowsePage(db: Db, scope: BrowseScope, q: ItemQuery, o: BrowseOpts): Promise<BrowsePage> {
  if (!scope.repos.length) return { rows: [], total: 0 };
  const qd = queryDb(db);
  const st = browseStatements(db, scope, q, o);
  const [rows, total] = await db.together(() => Promise.all([qd.all(st.rows), qd.get(st.total)]));
  return { rows: rows as BrowseItem[], total: Number((total as { n: number } | undefined)?.n ?? 0) };
}

/** The statement that counts the matches of every preset (exported for measuring it). */
export function presetStatement(db: Db, scope: BrowseScope, presets: readonly { id: string; query: ItemQuery }[]) {
  return (queryDb(db).k as any).selectFrom(facts(db, scope).as("x")).select((eb: any) => presets.map((p, n) => {
    const c = conds(db, eb, scope, p.query);
    return eb.fn.sum(eb.case().when(c.length ? eb.and(c) : eb.lit(true) as unknown as Expression<SqlBool>).then(1).else(0).end()).as(`p${n}`);
  }));
}

/** How many items of the scope match each of `presets`, in one statement. */
export async function countPresets(db: Db, scope: BrowseScope, presets: readonly { id: string; query: ItemQuery }[]): Promise<Record<string, number>> {
  if (!scope.repos.length || !presets.length) return Object.fromEntries(presets.map((p) => [p.id, 0]));
  const row = await queryDb(db).get(presetStatement(db, scope, presets));
  const r = (row ?? {}) as Record<string, unknown>;
  return Object.fromEntries(presets.map((p, n) => [p.id, Number(r[`p${n}`] ?? 0)]));
}

const FACETS = 40;

/** The labels, authors and areas of the open items of the scope, most used first: the quick filters' choices. */
export async function loadFacets(db: Db, scope: BrowseScope): Promise<{ labels: string[]; authors: string[]; areas: string[] }> {
  if (!scope.repos.length) return { labels: [], authors: [], areas: [] };
  const qd = queryDb(db);
  const k = qd.k as any;
  const open = (b: any, alias: string) => b.where(`${alias}.state`, "=", "OPEN").where(kx.inList(db, `${alias}.repo`, scope.repos)).where(hiddenRepos(db, `${alias}.repo`, scope.hidden));
  const [labels, authors, areas] = await db.together(() => Promise.all([
    qd.all(open(k.selectFrom(["main.items as fl", kx.jsonEach(db, "fl.labels", "lb")]), "fl").where("fl.labels", "is not", null)
      .select((eb: any) => [kx.bytewise(db, "lb.value").as("v"), eb.fn.countAll().as("n")]).groupBy(kx.bytewise(db, "lb.value")).orderBy("n", "desc").orderBy("v").limit(FACETS)),
    qd.all(open(k.selectFrom("main.items as fa"), "fa").where("fa.author", "is not", null)
      .select((eb: any) => ["fa.author as v", eb.fn.countAll().as("n")]).groupBy("fa.author").orderBy("n", "desc").orderBy("fa.author").limit(FACETS)),
    qd.all(open(k.selectFrom("main.item_areas as ar").innerJoin("main.items as fr", (j: any) => j.onRef("fr.repo", "=", "ar.repo").onRef("fr.number", "=", "ar.number")), "fr")
      .where("ar.area", "is not", null).select((eb: any) => ["ar.area as v", eb.fn.countAll().as("n")]).groupBy("ar.area").orderBy("n", "desc").orderBy("ar.area").limit(FACETS)),
  ]));
  const vs = (rows: unknown[]) => (rows as { v: string }[]).map((r) => r.v);
  return { labels: vs(labels), authors: vs(authors), areas: vs(areas) };
}
