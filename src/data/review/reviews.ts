// Review, history, post and pre- and post-merge loaders (M13 review).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { loadOwnLogins } from "../access/index.ts";
import { listAudit } from "../control/index.ts";
import { unclearWrite } from "../../github/unsent.ts";
import { itemHead, openItem } from "../mirror/fragments.ts";
import { discussionEntries, followupFixLinks, mergeEntryReviews, premergeBase } from "./cross.ts";
import { headRef, headTuples, latestRows, listOf, noKeys, parseHistory, parseReview, pushTo, refKey, reviewSelect, reviewWindow } from "./rows.ts";
import type { Filing, Finding, Followup, HeadKey, HeadRef, HistoryRow, MirrorEntry, PendingDefect, PostmergeRow, PremergeRow, RefKey, ReviewPost, ReviewRow, ReviewTexts, StoredHistory } from "./types.ts";

/** A review that failed with a `retry:` error is tried again after this long; filing retries wait 1 h after the first failed try and 6 h after the second, three tries at most. */
const FAILED_BACKOFF_MS = [3600_000, 6 * 3600_000];
const MAX_ATTEMPTS = 3;

/** Window `row_number() OVER (PARTITION BY repo, number ORDER BY at DESC, rowid DESC) = 1` over the rows with a verdict. 1 statement. */
export async function loadLatestReviews(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewRow>> {
  return await latestRows(db, keys);
}

/** The review at each head (tuple key); replaces every point read by `(repo, number, head)`. 1 statement. */
export async function loadReviewsAt(db: Db, heads: HeadKey[]): Promise<Map<HeadRef, ReviewRow>> {
  const out = new Map<HeadRef, ReviewRow>();
  if (!heads.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(heads)) {
    const rows = await q.all(q.k.selectFrom("main.opus_reviews as o").select((eb) => reviewSelect(db, eb, "o") as any).where("o.verdict", "is not", null)
      .where(kx.tupleIn(db, ["o.repo", "o.number", "o.head_oid"], headTuples(part), ["text", "bigint", "text"])) as any) as any[];
    for (const r of rows) out.set(headRef(r.repo, r.number, r.head_oid), parseReview(r));
  }
  return out;
}

/** The reviewed heads of merge-entry PRs, and when each was reviewed last. 1 statement. */
export async function loadMergeEntryReviews(db: Db, keys: KeySource): Promise<Map<RefKey, { head: string; at: string }[]>> {
  const out = new Map<RefKey, { head: string; at: string }[]>();
  if (noKeys(keys)) return out;
  for (const r of await queryDb(db).all(mergeEntryReviews(db, keys), { label: "review.loadMergeEntryReviews" })) pushTo(out, refKey(r.repo, r.number), { head: r.head_oid, at: r.at });
  return out;
}

/** The verdict of every reviewed head of the PRs. 1 statement. */
export async function loadReviewVerdicts(db: Db, refs: { repo: string; number: number }[]): Promise<Map<HeadRef, string>> {
  if (!refs.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.opus_reviews as o").select(["o.repo", "o.number", "o.head_oid", "o.verdict"]).where("o.verdict", "is not", null)
    .where(kx.refIn(db, "o", refs.map((r) => [r.repo, r.number] as const))));
  return new Map(rows.map((r) => [headRef(r.repo, Number(r.number), r.head_oid), r.verdict!]));
}

/** All heads' reviews of each PR, newest first. 1 statement. */
export async function loadReviewRows(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewRow[]>> {
  const out = new Map<RefKey, ReviewRow[]>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(reviewWindow(db, keys).orderBy("o.repo").orderBy("o.number").orderBy("rn") as any) as any[];
  for (const r of rows) pushTo(out, refKey(r.repo, r.number), parseReview(r));
  return out;
}

/** The heavy columns, kept out of `ReviewRow`. 1 statement. */
export async function loadReviewTexts(db: Db, heads: HeadKey[]): Promise<Map<HeadRef, ReviewTexts>> {
  const out = new Map<HeadRef, ReviewTexts>();
  if (!heads.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(heads)) {
    const rows = await q.all(q.k.selectFrom("main.opus_reviews as o").select(["o.repo", "o.number", "o.head_oid", "o.summary", "o.why", "o.public_review", "o.claims", "o.conflicts"]).where("o.verdict", "is not", null)
      .where(kx.tupleIn(db, ["o.repo", "o.number", "o.head_oid"], headTuples(part), ["text", "bigint", "text"])));
    for (const r of rows) out.set(headRef(r.repo, r.number, r.head_oid), { summary: r.summary, why: r.why, public_review: r.public_review, claims: r.claims, conflicts: r.conflicts });
  }
  return out;
}

/** `opus_review_history` rows with a verdict (`any`: every row), oldest first; `headOnly` keeps the rows at those heads. 1 statement. */
export async function loadReviewHistory(db: Db, keys: KeySource, o: { headOnly?: HeadKey[]; any: true }): Promise<Map<RefKey, StoredHistory[]>>;
export async function loadReviewHistory(db: Db, keys: KeySource, o?: { headOnly?: HeadKey[] }): Promise<Map<RefKey, HistoryRow[]>>;
export async function loadReviewHistory(db: Db, keys: KeySource, o?: { headOnly?: HeadKey[]; any?: true }): Promise<Map<RefKey, StoredHistory[]>> {
  const out = new Map<RefKey, StoredHistory[]>();
  if (noKeys(keys) || (o?.headOnly && !o.headOnly.length)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.opus_review_history as h")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "h.repo").onRef("kk.number", "=", "h.number"))
    .select(["h.repo", "h.number", kx.rowid("main.opus_review_history", "h").as("rowid"), "h.head_oid", "h.at", "h.model", "h.mode", "h.verdict", "h.sure", "h.reason", "h.summary", "h.risks", "h.fixes", "h.claims", "h.blocked_by", "h.trigger", "h.job_id"])
    .$if(!o?.any, (b) => b.where("h.verdict", "is not", null))
    .$if(!!o?.headOnly, (b) => b.where(kx.tupleIn(db, ["h.repo", "h.number", "h.head_oid"], headTuples(o!.headOnly!), ["text", "bigint", "text"])))
    .orderBy("h.at").orderBy(kx.rowid("main.opus_review_history", "h")));
  for (const r of rows) pushTo(out, refKey(r.repo, r.number), parseHistory(r));
  return out;
}

/** The fixes of the latest history row with a verdict at each head, as `file: change`, at most 8. 1 statement. */
export async function loadFixesAsked(db: Db, heads: HeadKey[]): Promise<Map<HeadRef, string[]>> {
  const out = new Map<HeadRef, string[]>();
  if (!heads.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(heads)) {
    const win = q.k.selectFrom("main.opus_review_history as h")
      .select((eb) => ["h.repo", "h.number", "h.head_oid", "h.fixes", eb.fn.agg<number>("row_number").over((w) => w.partitionBy(["h.repo", "h.number", "h.head_oid"]).orderBy("h.at", "desc").orderBy(kx.rowid("main.opus_review_history", "h"), "desc")).as("rn")])
      .where("h.verdict", "is not", null).where(kx.tupleIn(db, ["h.repo", "h.number", "h.head_oid"], headTuples(part), ["text", "bigint", "text"]));
    for (const r of await q.all(q.k.selectFrom(win.as("t")).select(["t.repo", "t.number", "t.head_oid", "t.fixes"]).where("t.rn", "=", 1))) {
      const fixes = listOf<{ file?: unknown; change?: unknown }>(r.fixes).filter((x) => x && typeof x.file === "string" && typeof x.change === "string").slice(0, 8).map((x) => `${x.file}: ${x.change}`);
      out.set(headRef(r.repo, r.number, r.head_oid), fixes);
    }
  }
  return out;
}

/** `review_posts` rows. 1 statement. */
export async function loadPosts(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewPost>> {
  const out = new Map<RefKey, ReviewPost>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.review_posts as rp").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "rp.repo").onRef("kk.number", "=", "rp.number"))
    .select(["rp.repo", "rp.number", "rp.review_id", "rp.head_oid", "rp.posted_at", "rp.edited_at", "rp.opus_at", "rp.posted_as"]));
  for (const r of rows) out.set(refKey(r.repo, r.number), { repo: r.repo, number: r.number, review_id: r.review_id, head: r.head_oid, posted_at: r.posted_at, edited_at: r.edited_at, opus_at: r.opus_at, posted_as: r.posted_as });
  return out;
}

/**
 * Mirrored comments and review bodies others wrote, oldest first (the fallback source of a review prompt that has no GitHub read).
 * `o.own`: our logins (`access.loadOwnLogins`); read first, in one more statement, when not given. 1 statement.
 */
export async function loadDiscussionEntries(db: Db, keys: KeySource, o?: { own?: readonly string[] }): Promise<Map<RefKey, MirrorEntry[]>> {
  const out = new Map<RefKey, MirrorEntry[]>();
  if (noKeys(keys)) return out;
  const own = o?.own ?? [...await loadOwnLogins(db)];
  const q = queryDb(db);
  for (const r of await q.all(discussionEntries(db, keys, own))) {
    pushTo(out, refKey(r.repo, r.number), { id: r.id, kind: r.kind, author: r.author, created_at: r.created_at, body: r.body, review_state: r.review_state, counted: Number(r.counted) === 1, maint: Number(r.maint) === 1 });
  }
  return out;
}

/** Pre-merge rows read against the same base branch as the head's Opus review. 1 statement. */
export async function loadPremerge(db: Db, heads: HeadKey[]): Promise<Map<HeadRef, PremergeRow>> {
  const out = new Map<HeadRef, PremergeRow>();
  if (!heads.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(heads)) {
    const rows = await q.all(premergeBase(db).select(kx.cols("premerge_reviews", "p")).where(kx.tupleIn(db, ["p.repo", "p.number", "p.head_oid"], headTuples(part), ["text", "bigint", "text"])));
    for (const r of rows) out.set(headRef(r.repo, r.number, r.head_oid), r as PremergeRow);
  }
  return out;
}

export const parsePostmerge = (r: { repo: string; number: number; merge_sha: string; at: string; model: string | null; run_id: string | null; findings: string | null; error: string | null; tries: number }): PostmergeRow =>
  ({ repo: r.repo, number: r.number, merge_sha: r.merge_sha, at: r.at, model: r.model, run_id: r.run_id, findings: listOf<Finding>(r.findings), error: r.error, tries: Number(r.tries) });

/** Post-merge rows. 1 statement. */
export async function loadPostmerge(db: Db, keys: KeySource): Promise<Map<RefKey, PostmergeRow>> {
  const out = new Map<RefKey, PostmergeRow>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.postmerge_reviews as r").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number"))
    .select(["r.repo", "r.number", "r.merge_sha", "r.at", "r.model", "r.run_id", "r.findings", "r.error", "r.tries"]));
  for (const r of rows) out.set(refKey(r.repo, r.number), parsePostmerge(r));
  return out;
}

/** Ordered by `review_at`, `finding`. 1 statement. */
export async function loadFollowups(db: Db, keys: KeySource): Promise<Map<RefKey, Followup[]>> {
  const out = new Map<RefKey, Followup[]>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.postmerge_followups as f").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "f.repo").onRef("kk.number", "=", "f.number"))
    .select(kx.cols("postmerge_followups", "f")).orderBy("f.repo").orderBy("f.number").orderBy("f.review_at").orderBy("f.finding"));
  for (const r of rows) pushTo(out, refKey(r.repo, r.number), r as Followup);
  return out;
}

/** The PRs among `keys` that are the fix PR of a follow-up issue this stage filed (`implementations.pr_number`). 1 statement. */
export async function loadFollowupFixPrs(db: Db, keys: KeySource): Promise<Set<RefKey>> {
  if (noKeys(keys)) return new Set();
  const q = queryDb(db);
  return new Set((await q.all(followupFixLinks(db, keys))).map((r) => refKey(r.repo, r.number!)));
}

/** A failed filing is tried again this long after its attempt. */
const retryDue = (f: Pick<Followup, "state" | "attempts" | "at">, now: number): boolean => {
  if (f.state !== "failed") return false;
  const wait = FAILED_BACKOFF_MS[f.attempts - 1];
  return wait !== undefined && f.attempts < MAX_ATTEMPTS && now - Date.parse(f.at) >= wait;
};

/**
 * Defects of the latest clean post-merge review of each PR of `keys` that filing may still try, oldest review first: no row yet, a
 * skipped-limit row, or a failed row whose backoff has passed. A review held by an earlier filed or filing follow-up of the PR, or
 * by the PR fixing a follow-up issue, has none. `keys` holds the non-quiet PRs whose defects are filed. Three statements in one wave.
 */
export async function loadPendingDefects(db: Db, keys: KeySource, o: { now: number }): Promise<PendingDefect[]> {
  if (noKeys(keys)) return [];
  const q = queryDb(db);
  const [reviews, followups, fixes] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.postmerge_reviews as r").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number"))
      .select(["r.repo", "r.number", "r.at", "r.model", "r.findings"]).where("r.error", "is", null).orderBy("r.at").orderBy("r.number")),
    loadFollowups(db, keys),
    loadFollowupFixPrs(db, keys),
  ]));
  const out: PendingDefect[] = [];
  for (const r of reviews) {
    const ref = refKey(r.repo, r.number);
    const all = followups.get(ref) ?? [];
    if (all.some((x) => (x.state === "filed" || x.state === "filing") && x.review_at !== r.at) || fixes.has(ref)) continue;
    const have = all.filter((x) => x.review_at === r.at);
    listOf<Finding>(r.findings).forEach((f, i) => {
      if (f.severity !== "defect" || f.duplicate_of !== null) return;
      const row = have.find((x) => x.finding === i);
      if (row && row.state !== "skipped-limit" && !retryDue(row, o.now)) return;
      out.push({ repo: r.repo, number: r.number, review_at: r.at, finding: i, f, model: r.model, attempts: row?.attempts ?? 0, note: row?.note ?? null, was: row ?? null });
    });
  }
  return out;
}

/** Defects filed in the last 30 days with their finding, by one join of the follow-up to the review it came from. 1 statement. */
export async function loadRecentFiled(db: Db, repo: string, o: { now: number }): Promise<{ number: number; f: Finding }[]> {
  const since = new Date(o.now - 30 * 86400_000).toISOString();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.postmerge_followups as pf").innerJoin("main.postmerge_reviews as r", (j) => j.onRef("r.repo", "=", "pf.repo").onRef("r.number", "=", "pf.number").onRef("r.at", "=", "pf.review_at"))
    .select(["pf.number", "pf.finding", "r.findings"]).where("pf.repo", "=", repo).where("pf.state", "in", ["filed", "filing"]).where("pf.at", ">=", since)
    .orderBy("pf.review_at").orderBy("pf.number").orderBy("pf.finding"));
  return rows.flatMap((x) => { const f = listOf<Finding>(x.findings)[x.finding]; return f ? [{ number: x.number, f }] : []; });
}

/**
 * The rows in `filing` (of the PRs of `repo` when given), each with what the audit rows tell of its create: an issue any create of this
 * finding made, else whether one begun since the claim may have made it. 1 statement, 1 more when there are any.
 */
export async function loadFilings(db: Db, o: { repo?: string } = {}): Promise<Filing[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.postmerge_followups as f").select(kx.cols("postmerge_followups", "f")).where("f.state", "=", "filing").$if(o.repo !== undefined, (b) => b.where("f.repo", "=", o.repo!))
    .orderBy("f.repo").orderBy("f.number").orderBy("f.review_at").orderBy("f.finding")) as Followup[];
  if (!rows.length) return [];
  const since = rows.reduce((m, r) => (r.review_at < m ? r.review_at : m), rows[0]!.review_at);
  const audits = await listAudit(db, { actions: ["postmerge-file"], targets: [...new Set(rows.map((r) => refKey(r.repo, r.number)))], since });
  return rows.map((r) => {
    const mine = audits.filter((a) => a.target === refKey(r.repo, r.number) && a.details?.finding === r.finding && a.at >= r.review_at);
    const made = mine.flatMap((a) => { const m = a.details?.state === "done" ? /\/issues\/(\d+)/.exec(String(a.details.url ?? "")) : null; return m ? [{ number: Number(m[1]), url: String(a.details!.url) }] : []; });
    const open = mine.some((a) => a.at >= r.at && (a.details?.state === "done" || unclearWrite(a.details)));
    return { ...r, create: made.length ? { issue: made[made.length - 1]! } : open ? { issue: null } : null };
  });
}

/** The PRs whose post-merge review, stored at or after `since`, is without an error. 1 statement. */
export async function listPostmergeReviewed(db: Db, o: { since: string; repo?: string }): Promise<{ repo: string; number: number }[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.postmerge_reviews as r").select(["r.repo", "r.number"]).where("r.error", "is", null).where("r.at", ">=", o.since)
    .$if(o.repo !== undefined, (b) => b.where("r.repo", "=", o.repo!)).orderBy("r.repo").orderBy("r.number"));
}

/** PRs whose latest review was at `head`. 1 statement. */
export async function loadReviewedRefs(db: Db, repo: string, head: string): Promise<RefKey[]> {
  const q = queryDb(db);
  const at = q.k.selectFrom("main.opus_reviews as a").select(["a.repo", "a.number"]).where("a.repo", "=", repo).where("a.head_oid", "=", head).where("a.verdict", "is not", null);
  const win = q.k.selectFrom("main.opus_reviews as o").innerJoin(at.as("kk"), (j) => j.onRef("kk.repo", "=", "o.repo").onRef("kk.number", "=", "o.number"))
    .select((eb) => ["o.repo", "o.number", "o.head_oid", eb.fn.agg<number>("row_number").over((w) => w.partitionBy(["o.repo", "o.number"]).orderBy("o.at", "desc").orderBy(kx.rowid("main.opus_reviews", "o"), "desc")).as("rn")])
    .where("o.verdict", "is not", null);
  const rows = await q.all(q.k.selectFrom(win.as("t")).select(["t.repo", "t.number"]).where("t.rn", "=", 1).where("t.head_oid", "=", head).orderBy("t.number"));
  return rows.map((r) => refKey(r.repo, r.number));
}

/**
 * The too-large holds (verdict hold, no model) at the current head of an open PR made under a diff size cap below `cap`; a hold stored
 * without its cap counts as made under `unstamped`.
 */
export async function loadTooLargeHolds(db: Db, cap: number, unstamped: number): Promise<{ repo: string; number: number; head: string }[]> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.opus_reviews as o")
    .select(["o.repo", "o.number", "o.head_oid"])
    .where("o.verdict", "=", "hold").where("o.model", "is", null)
    .where((eb: any) => eb(eb.fn.coalesce("o.size_cap", eb.lit(unstamped)), "<", cap))
    .where((eb: any) => openItem(eb, "o.repo", "o.number", { kind: "pr" }))
    .where((eb: any) => eb("o.head_oid", "=", itemHead(eb, "o.repo", "o.number")))) as { repo: string; number: number; head_oid: string }[];
  return rows.map((r) => ({ repo: r.repo, number: Number(r.number), head: r.head_oid }));
}
