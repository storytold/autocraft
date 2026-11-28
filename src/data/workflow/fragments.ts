// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression, Expression, SelectQueryBuilder, SqlBool } from "kysely";
import { LOW_WEIGHT, STARTED_SCORE, WEIGHT_STEP } from "../../core/work-score.ts";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { registerKeySource, resolveKeys, type KeySource } from "../keys.ts";
import { queryDb } from "../../db/query-db.ts";
import { ASKING_STATES } from "../../workflow/types.ts";
import * as control from "../control/fragments.ts";
import * as intake from "../intake/fragments.ts";

const one = (eb: kx.AnyEb) => eb.lit(1).as("one");
/** Live states of `item_workflows`, spelled out so the SQL needs no import of the store. */
export const LIVE_STATES = ["running", "waiting", "blocked", "recommending"];

/** How long after its last write a workflow that ended done through its PR's merge still owns that PR's post-merge review (src/remote/started.ts). */
export const MERGED_WORK_MS = 3 * 24 * 3600_000;

/** The two ways a workflow merges a PR: a PR workflow its own (`number`), an implement workflow of an issue the PR it worked on (`pr_number`). */
export const MERGE_WAYS = ["pr", "issue"] as const;

/**
 * The workflow `w` ended done through the merge of the PR at `repo`/`number` (column references), the PR it merged in the way `via`
 * (MERGE_WAYS), merged in the mirror, with the workflow's last write at or after `sinceIso`. One way per statement, so each matches the PR on
 * an indexed column pair. The Task Runner snapshot and the lease both read it, for both ways.
 */
export const endedByMerge = (eb: kx.AnyEb, w: string, repo: string, number: string, sinceIso: string, via: (typeof MERGE_WAYS)[number]): Expression<SqlBool> => eb.and([
  eb(`${w}.state`, "=", "done"), eb(`${w}.repo`, "=", kx.ref<string>(repo)), eb(`${w}.kind`, "=", via),
  eb(`${w}.${via === "pr" ? "number" : "pr_number"}`, "=", kx.ref<number>(number)),
  eb(`${w}.updated_at`, ">=", sinceIso),
  eb.exists(kx.schemaEb(eb).selectFrom("main.items as mi").select(one(eb)).where("mi.repo", "=", kx.ref<string>(repo)).where("mi.number", "=", kx.ref<number>(number)).where("mi.state", "=", "MERGED")),
]);

/**
 * `kind` (a column of workflow_events) is not `archived`: what happened in the maintainer workflow, without the history of the decision system before it,
 * whose rows are written later than what they record. Written as the partial indexes of workflow_events write it.
 */
export const notArchived = (eb: kx.AnyEb, kind: string): Expression<SqlBool> => eb(kind, "<>", kx.literal("archived"));

/** The events by which a person chooses to go on with an item. */
const GO_ON_EVENTS = ["started", "answered"];

/** Up to when the person of a go-on event `e` had seen the item: an answer is about what its question showed, not about what came between the two. */
export const seenAt = (eb: kx.AnyEb, e: string) => eb.fn.coalesce(`${e}.seen_at`, `${e}.at`);
export const isGoOn = (eb: kx.AnyEb, e: string): Expression<SqlBool> => eb(`${e}.kind`, "in", GO_ON_EVENTS);
/** The newest `seenAt` of the workflow's go-on events (`w`: its id column). */
export const goOnAt = (eb: kx.AnyEb, w: string) =>
  kx.schemaEb(eb).selectFrom("main.workflow_events as ge").select((g: any) => g.fn.max(seenAt(g, "ge")).as("at")).where("ge.workflow_id", "=", kx.ref<number>(w)).where((g: any) => isGoOn(g, "ge"));

/** When a person last said so: the newest of the workflow's go-on events (`w`: its id column). */
export const saidAt = (eb: kx.AnyEb, w: string) =>
  kx.schemaEb(eb).selectFrom("main.workflow_events as gs").select((g: any) => g.fn.max("gs.at").as("at")).where("gs.workflow_id", "=", kx.ref<number>(w)).where((g: any) => isGoOn(g, "gs"));

/** Attempt states that no longer work a PR (src/implement/types.ts ENDED_STATES). */
const ENDED_ATTEMPTS = ["merged", "closed", "failed", "cancelled"];

/**
 * The attempt `i` is one the implement workflow `w` of its issue works on (src/workflow/work.ts candidatePr): the current one, one made in it,
 * or the issue's latest when it ended in it. An attempt that ended before the workflow started belongs to an earlier one, and so does one whose
 * end was recorded late and that the workflow has an attempt of its own for: its PR (reopened, say) is no work of this one.
 */
export const attemptOf = (eb: kx.AnyEb, i: string, w: string): Expression<SqlBool> => {
  const started = kx.ref<string>(`${w}.started_at`);
  const newer = kx.schemaEb(eb).selectFrom("main.implementations as ni").select(one(eb))
    .where("ni.repo", "=", kx.ref<string>(`${i}.repo`)).where("ni.number", "=", kx.ref<number>(`${i}.number`)).where("ni.id", ">", kx.ref<number>(`${i}.id`));
  return eb.or([
    eb(`${i}.state`, "not in", ENDED_ATTEMPTS),
    eb(`${i}.created_at`, ">=", started),
    eb.and([eb(`${i}.updated_at`, ">=", started), eb.not(eb.exists(newer))]),
  ]);
};

/**
 * The attempt `i` opened the PR that the implement workflow `w` of its issue works on: the newest with a PR of those the workflow works on
 * (attemptOf). An attempt made after a later implement workflow of the issue started is that one's. Written as "`i` is the newest that
 * qualifies", so the statement carries the qualifying rule once instead of once for `i` and again for a newer attempt.
 */
export const linkingAttempt = (eb: kx.AnyEb, i: string, w: string): Expression<SqlBool> => {
  const t = kx.schemaEb(eb);
  // COALESCE: a plain IS NOT NULL makes SQLite walk the repo's attempts by PR instead of the issue's.
  const of = (x: kx.AnyEb, a: string): Expression<SqlBool> => x.and([
    x(x.fn.coalesce(`${a}.pr_number`, x.lit(0)), "<>", 0), attemptOf(x, a, w),
    x.not(x.exists(t.selectFrom("main.item_workflows as nw").select(one(x)).where("nw.repo", "=", kx.ref<string>(`${w}.repo`)).where("nw.number", "=", kx.ref<number>(`${w}.number`))
      .where("nw.id", ">", kx.ref<number>(`${w}.id`)).where("nw.entry", "=", "implement").where("nw.started_at", "<=", kx.ref<string>(`${a}.created_at`)))),
  ]);
  const newest = t.selectFrom("main.implementations as nj").select((x) => x.fn.max("nj.id").as("id")).where("nj.repo", "=", kx.ref<string>(`${i}.repo`)).where("nj.number", "=", kx.ref<number>(`${i}.number`))
    .where((x) => of(x as unknown as kx.AnyEb, "nj"));
  return eb(`${i}.id`, "=", newest as never);
};

/** The PR `pr` was merged or closed before the workflow `w` started (src/workflow/work.ts overBefore): it is none of its work. */
export const prOverBefore = (eb: kx.AnyEb, w: string, pr: kx.Ex): Expression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.items as ob").select(one(eb)).where("ob.repo", "=", kx.ref<string>(`${w}.repo`)).where("ob.number", "=", kx.exprOf(eb, pr))
    .where("ob.state", "<>", "OPEN").where("ob.closed_at", "<", kx.ref<string>(`${w}.started_at`)));

/**
 * The implement workflow of the row `w` (an alias of `item_workflows`) works on the PR `pr`: the one it is linked to (`pr_number`, written by
 * linkWorkflows), or, for a row without a link, the one it would be linked to.
 */
export const worksOnPr = (eb: kx.AnyEb, w: string, pr: kx.Ex): Expression<SqlBool> => {
  const p = kx.exprOf(eb, pr);
  const would = kx.schemaEb(eb).selectFrom("main.implementations as wi").select(one(eb)).where("wi.repo", "=", kx.ref<string>(`${w}.repo`)).where("wi.number", "=", kx.ref<number>(`${w}.number`))
    .where("wi.pr_number", "=", p).where((x) => linkingAttempt(x as unknown as kx.AnyEb, "wi", w));
  return eb.and([
    eb(`${w}.entry`, "=", "implement"),
    eb.or([eb(`${w}.pr_number`, "=", p), eb.and([eb(`${w}.pr_number`, "is", null), eb.exists(would)])]),
    eb.not(prOverBefore(eb, w, p)),
  ]);
};

/**
 * `(wid, repo, issue, pr, live)`: the implement workflows and the PR each works on (worksOnPr); those in `states`, null for every state. `by`
 * narrows both arms by workflow, by the PR or by the issue, so each arm starts from its index.
 */
export function linkRows(db: Db, states: readonly string[] | null, by: { ids?: readonly number[]; prs?: KeySource; issues?: KeySource } = {}): SelectQueryBuilder<any, any, { wid: number; repo: string; issue: number; pr: number; live: number }> {
  const k = queryDb(db).k as any;
  const arm = (b: any, pr: string) => b
    .$if(!!by.prs, (x: any) => x.innerJoin(resolveKeys(db, by.prs!, "kp"), (j: any) => j.onRef("kp.repo", "=", "lw.repo").onRef("kp.number", "=", pr)))
    .$if(!!by.issues, (x: any) => x.innerJoin(resolveKeys(db, by.issues!, "ki"), (j: any) => j.onRef("ki.repo", "=", "lw.repo").onRef("ki.number", "=", "lw.number")))
    .$if(!!by.ids, (x: any) => x.where(kx.inList(db, "lw.id", by.ids!, "bigint")))
    .$if(states !== null, (x: any) => x.where("lw.state", "in", states))
    .where("lw.entry", "=", "implement").where((eb: any) => eb.not(prOverBefore(eb, "lw", pr)))
    .select((eb: any) => ["lw.id as wid", "lw.repo as repo", "lw.number as issue", `${pr} as pr`, eb.case().when("lw.state", "in", LIVE_STATES).then(eb.lit(1)).else(eb.lit(0)).end().as("live")]);
  const stored = arm(k.selectFrom("main.item_workflows as lw").where("lw.pr_number", "is not", null), "lw.pr_number");
  const unlinked = arm(k.selectFrom("main.implementations as li").innerJoin("main.item_workflows as lw", (j: any) => j.onRef("lw.repo", "=", "li.repo").onRef("lw.number", "=", "li.number"))
    .where("lw.pr_number", "is", null).where((eb: any) => linkingAttempt(eb, "li", "lw")), "li.pr_number");
  return stored.unionAll(unlinked);
}

/** The CTE `withLiveLinks` adds. */
export const LIVE_LINKS = "live_links";

/**
 * `k` with the CTE `live_links`: linkRows of the live workflows, materialized. Each read declares it first in its WITH, so the reads of a
 * fused wave that declare it share one copy (src/db/postgres.ts hoistShared) and Postgres plans the link rule once for all of them.
 */
export const withLiveLinks = (db: Db, k: any): any => k.with((cte: any) => cte(LIVE_LINKS).materialized(), () => linkRows(db, LIVE_STATES));

/** A live implement workflow works on the PR `pr`, read from the CTE of `withLiveLinks`. */
const implementsLiveIn = (eb: kx.AnyEb, repo: kx.Ex, pr: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom(`${LIVE_LINKS} as ll` as never).select(one(eb)).where("ll.repo" as never, "=", kx.exprOf(eb, repo)).where("ll.pr" as never, "=", kx.exprOf(eb, pr)));

/** `liveWorkflowExpr` for a statement made with `withLiveLinks`. */
export const liveWorkflowIn = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> => {
  const r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  return eb.or([
    eb.exists(kx.schemaEb(eb).selectFrom("main.item_workflows as pw").select(one(eb)).where("pw.repo", "=", r).where("pw.number", "=", n).where("pw.state", "in", LIVE_STATES)),
    implementsLiveIn(eb, r, n),
  ]);
};

/** A live implement workflow works on the PR: one probe per arm of `worksOnPr`, each on its index. */
export function implementsLive(eb: kx.AnyEb, repo: kx.Ex, pr: kx.Ex): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), p = kx.exprOf(eb, pr);
  const live = (x: any) => x.where("lw.entry", "=", "implement").where("lw.state", "in", LIVE_STATES).where((e: any) => e.not(prOverBefore(e, "lw", p)));
  return eb.or([
    eb.exists(live(t.selectFrom("main.item_workflows as lw").select(one(eb)).where("lw.repo", "=", r).where("lw.pr_number", "=", p))),
    eb.exists(live(t.selectFrom("main.implementations as li").innerJoin("main.item_workflows as lw", (j) => j.onRef("lw.repo", "=", "li.repo").onRef("lw.number", "=", "li.number")).select(one(eb))
      .where("li.repo", "=", r).where("li.pr_number", "=", p).where("lw.pr_number", "is", null).where((x) => linkingAttempt(x as unknown as kx.AnyEb, "li", "lw")))),
  ]);
}

/**
 * The implement workflow `w` of an issue speaks for the PR of its attempt `i`: the attempt belongs to it (attemptOf). Ends are read from every
 * attempt, not from the link alone: an older PR of an issue that was stopped stays stopped when someone reopens it. An issue's workflow that
 * ended as a PR of it merged says nothing about the issue's other PRs.
 */
const speaksFor = (eb: kx.AnyEb, i: string, w: string): Expression<SqlBool> => eb.and([
  eb(`${w}.entry`, "=", "implement"), attemptOf(eb, i, w),
  eb.or([eb(`${w}.state`, "<>", "done"), eb.not(eb.exists(
    kx.schemaEb(eb).selectFrom("main.implementations as im").innerJoin("main.items as mi", (j) => j.onRef("mi.repo", "=", "im.repo").onRef("mi.number", "=", "im.pr_number")).select(one(eb))
      .where("im.repo", "=", kx.ref<string>(`${w}.repo`)).where("im.number", "=", kx.ref<number>(`${w}.number`)).where("mi.state", "=", "MERGED")
      .where((m) => m.or([m("mi.closed_at", "is", null), m("mi.closed_at", ">=", kx.ref<string>(`${w}.started_at`))]))))]),
]);

/** `(repo, number, state, id)`: for each PR of `keys`, the implement workflows, live and ended, of the issue it was opened for (speaksFor). */
export function prIssueWorkflows(db: Db, keys: KeySource): SelectQueryBuilder<any, any, { repo: string; number: number; state: string; id: number }> {
  const k = queryDb(db).k as any;
  const on = (alias: string, repo: string, number: string) => (j: any) => j.onRef(`${alias}.repo`, "=", repo).onRef(`${alias}.number`, "=", number);
  return k.selectFrom("main.implementations as i").innerJoin(resolveKeys(db, keys, "kf"), on("kf", "i.repo", "i.pr_number"))
    .innerJoin("main.item_workflows as w", on("w", "i.repo", "i.number")).where((eb: any) => speaksFor(eb, "i", "w"))
    .select(["i.repo as repo", "i.pr_number as number", "w.state as state", "w.id as id"]);
}

/** States in which a person ended a workflow. */
const ENDED_BY_PERSON = ["stopped", "backlog", "closed"];

/**
 * A person ended the item: its newest workflow, or the newest of the issue a PR was opened for (speaksFor), whichever is newer, is stopped,
 * closed or in the backlog (loadEndedWorkflows is the set form).
 */
export function endedByPerson(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): Expression<SqlBool> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  const own = t.selectFrom("main.item_workflows as ew").select(["ew.id as id", "ew.state as state"]).where("ew.repo", "=", r).where("ew.number", "=", n);
  const ofPr = t.selectFrom("main.implementations as ei").innerJoin("main.item_workflows as ew", (j) => j.onRef("ew.repo", "=", "ei.repo").onRef("ew.number", "=", "ei.number"))
    .select(["ew.id as id", "ew.state as state"]).where("ei.repo", "=", r).where("ei.pr_number", "=", n).where((x) => speaksFor(x as unknown as kx.AnyEb, "ei", "ew"));
  const newest = t.selectFrom(own.unionAll(ofPr).as("eu")).select("eu.state").orderBy("eu.id", "desc").limit(1);
  return eb(eb.fn.coalesce(newest as any, eb.val("")), "in", ENDED_BY_PERSON);
}

/** The PR has a live workflow of the merge entry. */
export const inMergeEntry = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.item_workflows as mw").select(one(eb)).where("mw.repo", "=", kx.exprOf(eb, repo)).where("mw.number", "=", kx.exprOf(eb, number))
    .where("mw.entry", "=", "merge").where("mw.state", "in", LIVE_STATES));

/** A live workflow approved for merge (an approver, or a merge entry) handed the PR over to the merge queue at `head`: its leg is queued there. */
export const handedOverAt = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, head: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.preapprovals as hl").innerJoin("main.item_workflows as hw", "hw.id", "hl.workflow_id").select(one(eb))
    .where("hl.repo", "=", kx.exprOf(eb, repo)).where("hl.number", "=", kx.exprOf(eb, number)).where("hl.head", "=", kx.exprOf(eb, head)).where("hl.state", "=", "queued")
    .where("hw.state", "in", LIVE_STATES).where((w) => w.or([w("hw.approved_by", "is not", null), w("hw.entry", "=", "merge")])));

/** The item has a live workflow, or a live implement workflow works on it (implementsLive). */
export function liveWorkflowExpr(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
  const r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  // One probe by item and one per link arm, each on its index: a single subquery with all would read every live workflow for every item.
  return eb.or([
    eb.exists(kx.schemaEb(eb).selectFrom("main.item_workflows as pw").select(one(eb)).where("pw.repo", "=", r).where("pw.number", "=", n).where("pw.state", "in", LIVE_STATES)),
    implementsLive(eb, r, n),
  ]);
}

/** The work score (src/core/work-score.ts) of the workflow row aliased `w`. */
export const workScore = (eb: any): AliasableExpression<number> => eb(eb(eb.case().when("w.weight", ">", eb.lit(LOW_WEIGHT)).then(eb.lit(STARTED_SCORE)).else(eb.lit(-STARTED_SCORE)).end(), "+", eb("w.weight", "*", eb.lit(WEIGHT_STEP))), "-", eb.ref("w.id"));

/** The work score `s` of every item with a live workflow and of the PR a live implement workflow works on, the highest when both apply. */
export function workScores(db: Db): SelectQueryBuilder<any, any, { repo: string; number: number; s: number }> {
  const k = queryDb(db).k as any;
  const own = k.selectFrom("main.item_workflows as w").select((eb: any) => ["w.repo as repo", "w.number as number", workScore(eb).as("s")]).where("w.state", "in", LIVE_STATES);
  const viaPr = k.selectFrom(linkRows(db, LIVE_STATES).as("l")).innerJoin("main.item_workflows as w", "w.id", "l.wid").select((eb: any) => ["l.repo as repo", "l.pr as number", workScore(eb).as("s")]);
  return k.selectFrom(own.unionAll(viaPr).as("ws")).select((eb: any) => ["ws.repo", "ws.number", eb.fn.max("ws.s").as("s")]).groupBy(["ws.repo", "ws.number"]);
}

/**
 * The item is in the pipeline: `liveWorkflowExpr`, or auto-eligible: the repo's pipeline is on, an outside-author hold does not keep it back,
 * and no person ended it or the issue it implements.
 */
export function inScopeExpr(_db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
  return eb.or([liveWorkflowExpr(eb, repo, number), autoEligibleExpr(eb, repo, number)]);
}

/** The auto-eligible half of `inScopeExpr`, for a statement that has `liveWorkflowExpr` as a column already. */
export function autoEligibleExpr(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
  return eb.and([
    control.pipelineOn(eb, repo),
    eb.not(intake.heldExpr(eb, repo, number)),
    eb.not(endedByPerson(eb, repo, number)),
  ]);
}

/** A live workflow that came back to a person. */
export const needsPerson = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.item_workflows as np").select(one(eb)).where("np.repo", "=", kx.exprOf(eb, repo)).where("np.number", "=", kx.exprOf(eb, number)).where("np.state", "in", ASKING_STATES));

/** The repo has a live workflow. */
export const startedRepo = (eb: kx.AnyEb, repoCol: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.item_workflows as sr").select(one(eb)).where("sr.repo", "=", kx.exprOf(eb, repoCol)).where("sr.state", "in", LIVE_STATES));

/** A close a person asked for in the repo is to be carried out. */
export const closeDueIn = (eb: kx.AnyEb, repoCol: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.workflow_actions as ca").select(one(eb)).where("ca.repo", "=", kx.exprOf(eb, repoCol)).where("ca.state", "=", "pending")
    .where("ca.kind", "in", ["close", "comment-close"]));

/** Items with a live workflow, optionally of some repos. */
registerKeySource<{ repos?: string[] }>("workflow.liveItems", (db, o) =>
  queryDb(db).k.selectFrom("main.item_workflows as kw").select(["kw.repo", "kw.number"]).where("kw.state", "in", LIVE_STATES)
    .$if(!!o.repos, (b) => b.where(kx.inList(db, "kw.repo", o.repos!))));
