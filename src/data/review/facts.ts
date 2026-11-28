// The planner's review facts (M13 review).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { loadOwnLogins } from "../access/index.ts";
import { blockerRefsOf } from "../planner/fragments.ts";
import { discussionAgg, discussionBodies, premergeBase } from "./cross.ts";
import { headRef, latestRows, noKeys, parseReview, pushTo, refKey, refsOf, reviewWindow } from "./rows.ts";
import { loadPosts } from "./reviews.ts";
import { loadFollowupRows, loadPremergeFollowups } from "./premerge-followups.ts";
import { unsureHeadsQuery } from "./unsure.ts";
import type { DiscussionStat, ReviewFacts, ReviewMarks, Verdict } from "./types.ts";

/**
 * Twelve statements in one wave: latest reviews, unsure heads, today's reviews, carried chains, posts, pre-merge rows, pre-merge follow-ups, post-merge rows,
 * `review_state` marks, the discussion aggregate and its conditional bodies, and blocker verdicts.
 * `o.own`: our logins (`access.loadOwnLogins`); read first, in one more wave, when not given.
 */
export async function loadReviewFacts(db: Db, keys: KeySource, o: { now: number; own?: readonly string[] }): Promise<ReviewFacts> {
  const facts: ReviewFacts = { latest: new Map(), unsureHeads: new Set(), reviewsToday: new Map(), carriedChains: new Map(), posts: new Map(), premerge: new Map(), premergeFollowups: new Map(), reviewFollowups: new Map(), postmerge: new Map(), marks: new Map(), discussion: new Map(), blockerLatest: new Map() };
  if (noKeys(keys)) return facts;
  const own = o.own ?? [...await loadOwnLogins(db)];
  const today = new Date(o.now).toISOString().slice(0, 10);
  const q = queryDb(db);
  const keyed = <T extends string>(alias: T) => resolveKeys(db, keys, alias);

  const latestHead = q.k.selectFrom(reviewWindow(db, keys).as("t")).select(["t.repo", "t.number", "t.head_oid"]).where("t.rn", "=", 1);
  const blockerWin = q.k.selectFrom("main.opus_reviews as b")
    .innerJoin(blockerRefsOf(db, keys).as("bk"), (j) => j.onRef("bk.repo", "=", "b.repo").onRef("bk.number", "=", "b.number"))
    .select((eb) => ["b.repo", "b.number", "b.verdict", "b.blocked_by", eb.fn.agg<number>("row_number").over((w) => w.partitionBy(["b.repo", "b.number"]).orderBy("b.at", "desc").orderBy(kx.rowid("main.opus_reviews", "b"), "desc")).as("rn")])
    .where("b.verdict", "is not", null);

  const [latest, unsureRows, todays, carried, posts, premerge, premergeFollowups, reviewFollowups, postmerge, marks, agg, bodies, blockers] = await db.together(() => Promise.all([
    latestRows(db, keys),
    q.all(unsureHeadsQuery(db, keys)),
    q.all(q.k.selectFrom("main.opus_review_history as h").innerJoin(keyed("kk"), (j) => j.onRef("kk.repo", "=", "h.repo").onRef("kk.number", "=", "h.number"))
      .select((eb) => ["h.repo", "h.number", eb.fn.count<number>(eb.case().when("h.at", ">=", today).then(1).end()).as("n"), eb.fn.max<string | null>("h.at").as("last")])
      .where("h.model", "is not", null).where("h.model", "<>", "carried").where((eb) => eb(eb.fn.coalesce("h.mode", eb.val("")), "<>", "carried"))
      .groupBy(["h.repo", "h.number"])),
    q.all(reviewWindow(db, keys).where((eb) => eb.exists((eb as kx.AnyEb).selectFrom("main.opus_reviews as c").select(eb.lit(1).as("one")).whereRef("c.repo", "=", "o.repo").whereRef("c.number", "=", "o.number")
      .where((c) => c.or([c("c.mode", "=", "carried"), c("c.model", "=", "carried")])))).orderBy("o.repo").orderBy("o.number").orderBy("rn") as any) as Promise<any[]>,
    loadPosts(db, keys),
    q.all(premergeBase(db).innerJoin(keyed("kk"), (j) => j.onRef("kk.repo", "=", "p.repo").onRef("kk.number", "=", "p.number"))
      .leftJoin(latestHead.as("lr"), (j) => j.onRef("lr.repo", "=", "p.repo").onRef("lr.number", "=", "p.number"))
      .select(kx.cols("premerge_reviews", "p"))
      .where("p.head_oid", "=", (eb) => eb.ref("lr.head_oid"))),
    loadPremergeFollowups(db, keys),
    loadFollowupRows(db, keys, "review"),
    q.all(q.k.selectFrom("main.postmerge_reviews as r").innerJoin(keyed("kk"), (j) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number")).select(["r.repo", "r.number", "r.at", "r.error"])),
    q.all(q.k.selectFrom("main.review_state as s").innerJoin(keyed("kk"), (j) => j.onRef("kk.repo", "=", "s.repo").onRef("kk.number", "=", "s.number"))
      .select(["s.repo", "s.number", "s.stale_at", "s.rerun_day", "s.rerun_count", "s.fail_head", "s.fail_count", "s.fail_at", "s.lost_count", "s.lost_at"])),
    q.all(discussionAgg(db, keys, own)),
    q.all(discussionBodies(db, keys, own)),
    q.all(q.k.selectFrom(blockerWin.as("t")).select(["t.repo", "t.number", "t.verdict", "t.blocked_by"]).where("t.rn", "=", 1).distinct()),
  ]));

  facts.latest = latest;
  for (const r of unsureRows) facts.unsureHeads.add(headRef(r.repo, r.number, r.head_oid));
  for (const r of todays) facts.reviewsToday.set(refKey(r.repo, r.number), { n: Number(r.n), last: r.last });
  for (const r of carried) pushTo(facts.carriedChains, refKey(r.repo, r.number), parseReview(r));
  facts.posts = posts;
  for (const r of premerge) facts.premerge.set(headRef(r.repo, r.number, r.head_oid), r as any);
  facts.premergeFollowups = premergeFollowups;
  facts.reviewFollowups = reviewFollowups;
  for (const r of postmerge) facts.postmerge.set(refKey(r.repo, r.number), { at: r.at, error: r.error });
  for (const r of marks) {
    const m: ReviewMarks = { staleAt: r.stale_at, rerunDay: r.rerun_day, rerunCount: Number(r.rerun_count), failHead: r.fail_head, failCount: Number(r.fail_count), failAt: r.fail_at, lostCount: Number(r.lost_count), lostAt: r.lost_at };
    facts.marks.set(refKey(r.repo, r.number), m);
  }
  const counted = new Map<string, { id: string; body: string | null }[]>();
  for (const r of bodies) pushTo(counted, refKey(r.repo, r.number), { id: r.id, body: r.body });
  for (const r of agg) {
    const ref = refKey(r.repo, r.number);
    const s: DiscussionStat = { newest: r.newest, maint: r.maint, counted: counted.get(ref) ?? null };
    facts.discussion.set(ref, s);
  }
  for (const r of blockers) facts.blockerLatest.set(refKey(r.repo, r.number), { verdict: r.verdict as Verdict, blocked_by: refsOf(r.blocked_by) });
  return facts;
}
