// Key sources of a planner pass, and predicates other modules embed.
import type { Expression, SqlBool, SelectQueryBuilder } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { schemaEb, type Eb } from "../../db/kx.ts";
import { PASS_SOURCES, registerKeySource, resolveKeys, type KeyRow, type KeySource, type Ref } from "../keys.ts";
import { attemptOfPr } from "../implement/fragments.ts";
import { itemsOfRepos } from "../mirror/fragments.ts";
import { hasTakeReview } from "../review/fragments.ts";
import { trackedRepo } from "../control/fragments.ts";
import { mergedByUs } from "../merge/fragments.ts";

/** A change log longer than this selects nothing: the pass becomes a full pass (core/plan-changes.ts). */
const CHANGES_CAP = 50_000;
/** `due` lists above this many refs make `changedPass` equivalent to a full pass. */
const DUE_MAX = 10_000;
/** The queue states of core/plan.ts (a value import from feature code is not allowed here). */
const QUEUE_STATES = [
  "ready", "decision-answered-merge", "refused", "waiting-ci", "waiting-premerge", "ci-failed", "conflict",
  "needs-fix-up", "waiting-verify", "verify-failed", "verify-error", "needs-decision", "merged", "held-backlog",
  "batch-checking", "in-batch", "batch-failed", "ci-approval", "changes-requested",
] as const;

/**
 * The mirror's item rows (alias `ir`) of `repos` (every repo when absent), narrowed to the pass universe: open PRs, merged PRs with a
 * take review or merged by us, PRs of a current implementation attempt, and open issues of tracked repos.
 */
const passUniverse = (db: Db, repos?: readonly string[], prsOnly = false) =>
  itemsOfRepos(db, repos).clearSelect().select(["ir.repo as repo", "ir.number as number"])
    .where((eb: any) => eb.or([
      eb.and([eb("ir.kind", "=", "pr"), eb.or([
        eb("ir.state", "=", "OPEN"),
        eb.and([eb("ir.state", "=", "MERGED"), hasTakeReview(eb, "ir.repo", "ir.number")]),
        mergedByUs(eb, "ir.repo", "ir.number"),
        attemptOfPr(eb, eb.ref("ir.repo"), eb.ref("ir.number"), { current: true }),
      ])]),
      ...(prsOnly ? [] : [eb.and([eb("ir.kind", "=", "issue"), eb("ir.state", "=", "OPEN"), trackedRepo(eb, "ir.repo")])]),
    ])) as unknown as SelectQueryBuilder<any, any, KeyRow>;

registerKeySource<undefined>(PASS_SOURCES.full, (db) => passUniverse(db));
/** The PRs of the pass universe, of every repo or one (planner.prPass). */
registerKeySource<{ repo?: string }>("planner.prPass", (db, args) => passUniverse(db, args.repo === undefined ? undefined : [args.repo], true));

registerKeySource<{ due: Ref[]; seen: number }>(PASS_SOURCES.changed, (db, args) => {
  const k = queryDb(db).k;
  const refs = args.due.map((r): [string, number] => [r.repo, r.number]);
  const logged = k.selectFrom("item_changes as c").select(["c.repo as repo", "c.number as number"])
    .where((eb) => eb(eb.selectFrom("item_changes").select((x) => x.fn.countAll<number>().as("n")), "<=", CHANGES_CAP + args.seen));
  const due = k.selectFrom(kx.refPairs(db, refs, "d")).select(["d.repo as repo", "d.number as number"]);
  return logged.union(due) as SelectQueryBuilder<any, any, KeyRow>;
});

/** The subquery of `keys` named `alias`, for `(repo, number) IN (select repo, number from <alias>)`. */
export const keysOf = <A extends string>(db: Db, keys: KeySource, alias: A) => resolveKeys(db, keys, alias);
export { DUE_MAX };

/** The plan is a PR in a queue state with a queue view. */
export function queuedPlan(db: Db, eb: Eb, alias: string): Expression<SqlBool> {
  return eb.and([eb(`${alias}.kind`, "=", "pr"), eb(`${alias}.state`, "in", [...QUEUE_STATES]), eb(kx.jsonType(db, `${alias}.view`, "$.queue"), "=", "object")]);
}
/** `view.gh` of the plan row aliased `p`. */
export const planGh = (db: Db, p: string) => kx.jsonText(db, `${p}.view`, "$.gh");
/** `view.scope` of the plan row aliased `p`. */
export const planScope = (db: Db, p: string) => kx.jsonBool(db, `${p}.view`, "$.scope");
/**
 * `view.scope` of the plan row aliased `p` is set, as a test of the text: JSON.stringify wrote the view, and no string in it can hold these quotes
 * unescaped. Parsing every view is the cost of the reads that filter on it, and its estimate (one row in 200) makes Postgres nest loops over all of them.
 */
export const inPlanScope = (eb: Eb, p: string): Expression<SqlBool> => eb(eb.fn<number>("instr", [`${p}.view`, eb.val('"scope":true')]), ">", 0);
/** The plan's view says the automatic merge rule takes the PR up by itself (PlanView.auto). */
export const onPlanAutoPath = (eb: Eb, p: string): Expression<SqlBool> => eb(eb.fn<number>("instr", [`${p}.view`, eb.val('"auto":true')]), ">", 0);
/** `view.cifix` of the plan row aliased `p` is `bucket`; the text test first, since parsing every view is the cost of the read. */
export const planCifixIs = (db: Db, eb: Eb, p: string, bucket: string): Expression<SqlBool> =>
  eb.and([eb(eb.fn<number>("instr", [`${p}.view`, eb.val(`"${bucket}"`)]), ">", 0), eb(kx.jsonText(db, `${p}.view`, "$.cifix"), "=", bucket)]);
/** `view.fixup` of the plan row aliased `p`. */
export const planFixup = (db: Db, p: string) => kx.jsonText(db, `${p}.view`, "$.fixup");
/** `view.waitKind` of the plan row aliased `p`. */
export const planWaitKind = (db: Db, p: string) => kx.jsonText(db, `${p}.view`, "$.waitKind");

/** The item has a stored plan. */
export function plannedItem(eb: Eb, alias: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("item_plans as ip").select(w.lit(1).as("one")).where("ip.repo", "=", eb.ref(`${alias}.repo`)).where("ip.number", "=", eb.ref(`${alias}.number`)));
}
/** `item_stage` rows, optionally of one repo, for the Progress funnel. */
export function latestStage(db: Db, repo?: string) {
  return queryDb(db).k.selectFrom("item_stage").selectAll().$if(!!repo, (q) => q.where("repo", "=", repo!));
}
/** The item has a `liveness_items` row with this verdict: `stuck` (nothing is due and nobody is asked) or `long` (live, but its plan has not changed for days). */
export function stuckItem(eb: Eb, alias: string, verdict: "stuck" | "long" = "stuck"): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("liveness_items as li").select(w.lit(1).as("one")).where("li.repo", "=", eb.ref(`${alias}.repo`)).where("li.number", "=", eb.ref(`${alias}.number`)).where("li.verdict", "=", verdict));
}
/** A `stages` row of that stage exists for the item. */
export function hasStage(eb: Eb, alias: string, stage: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("main.stages as sg").select(w.lit(1).as("one")).where("sg.repo", "=", eb.ref(`${alias}.repo`)).where("sg.number", "=", eb.ref(`${alias}.number`)).where("sg.stage", "=", stage));
}
/** `(repo, number)` of the blocked PRs recorded for the PRs in `keys` (review's blocker loader). */
export function blockerRefsOf(db: Db, keys: KeySource): SelectQueryBuilder<any, any, KeyRow> {
  return queryDb(db).k.selectFrom("review_blockers as rb")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "rb.repo").onRef("kk.number", "=", "rb.number"))
    .select(["rb.b_repo as repo", "rb.b_number as number"]) as SelectQueryBuilder<any, any, KeyRow>;
}
