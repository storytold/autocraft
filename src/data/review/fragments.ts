// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";

/** The number of the post-merge PR whose follow-up issue is `repo#number`, or null. */
export const followupParentOf = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): Expression<number | null> =>
  kx.schemaEb(eb).selectFrom("main.postmerge_followups as pf").select("pf.number").where("pf.repo", "=", kx.exprOf(eb, repo)).where("pf.issue_number", "=", kx.exprOf(eb, number)).limit(1) as unknown as Expression<number | null>;

/** The PR has an Opus review with a take or take-fix verdict. */
export const hasTakeReview = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.opus_reviews as tr").select(eb.lit(1).as("one")).where("tr.repo", "=", kx.exprOf(eb, repo)).where("tr.number", "=", kx.exprOf(eb, number)).where("tr.verdict", "in", ["take", "take-fix"]));

/** The pre-merge review of the PR's `head` was made and found no blocking defect: a defect the review classed as not blocking (`blocking.class` null) does not count. */
export const premergeClean = (db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, head: kx.Ex): AliasableExpression<SqlBool> => {
  const f = kx.jsonEachFindings(db, kx.ref("pn.findings"), "pf");
  return eb.exists(kx.schemaEb(eb).selectFrom("main.premerge_reviews as pn").select(eb.lit(1).as("one"))
    .where("pn.repo", "=", kx.exprOf(eb, repo)).where("pn.number", "=", kx.exprOf(eb, number)).where("pn.head_oid", "=", kx.exprOf(eb, head)).where("pn.findings", "is not", null)
    .where((x) => x.not(x.exists(kx.schemaEb(x).selectFrom(f.from).select(x.lit(1).as("one")).where(f.severity, "=", "defect").where((y) => y.or([y(f.classType, "is", null), y(f.classType, "<>", "null")]))))));
};

/** The PR's final review at `head` is a take or take-fix, and `head` is the head of its newest Opus review with a verdict. */
export const finalTakeAtLatestHead = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, head: kx.Ex): AliasableExpression<SqlBool> => {
  const s = kx.schemaEb(eb);
  return eb.exists(s.selectFrom("main.final_reviews as fl").select(eb.lit(1).as("one"))
    .where("fl.repo", "=", kx.exprOf(eb, repo)).where("fl.number", "=", kx.exprOf(eb, number)).where("fl.head_oid", "=", kx.exprOf(eb, head)).where("fl.verdict", "in", ["take", "take-fix"])
    .where((x) => x("fl.head_oid", "=", kx.schemaEb(x).selectFrom("main.opus_reviews as fr").select("fr.head_oid").where("fr.repo", "=", kx.ref<string>("fl.repo")).where("fr.number", "=", kx.ref<number>("fl.number"))
      .where("fr.verdict", "is not", null).orderBy("fr.at", "desc").orderBy(kx.rowid("main.opus_reviews", "fr"), "desc").limit(1))));
};
