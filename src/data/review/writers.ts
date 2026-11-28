// Writers (M13 review). Each opens `db.write` itself or joins an outer one and writes its audit rows and stage events in the same transaction.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { addAudit } from "../control/index.ts";
import { markVerificationsStale } from "../merge/index.ts";
import { addStageEvents } from "../planner/index.ts";
import { headTuples, refKey } from "./rows.ts";
import type { Finding, FollowupClaim, FollowupRow, PostSave, PostmergeSave, PremergeSave, RefKey, SaveReviewInput, SaveReviewResult } from "./types.ts";

import { PREMERGE_LOST_LIMIT, PREMERGE_MAX_TRIES, PREMERGE_QUICK_TRIES, REVIEW_LOST_LIMIT } from "../../core/rules.ts";
export { PREMERGE_MAX_TRIES };
/** A post-merge review that fails with a `retry:` error is stored as held at this try. */
const MAX_RETRIES = 3;

const TUPLE = ["text", "bigint", "text"] as const;
const json = (v: unknown[] | null | undefined): string | null => (v && v.length ? JSON.stringify(v) : null);

/**
 * Stores each review: the row about to be replaced is copied to history first (unless the history has it), then the history row,
 * the `opus_reviews` upsert, the `review_state` update (a same-head re-review that no operator or discussion asked for counts against
 * the daily cap; the failure marks at that head clear) and two stage rows (`reviewed`, then take, hold or close; take-fix is take).
 * A diff read against another base than before (`rebased`) deletes the head's pre-merge row and marks its verifications stale in the
 * same transaction. Of two inputs for one head in a call, the later is saved. No GitHub or model call inside.
 */
export async function saveReviews(db: Db, inputs: SaveReviewInput[]): Promise<SaveReviewResult[]> {
  if (!inputs.length) return [];
  const q = queryDb(db);
  const keyOf = (i: { repo: string; number: number; head: string }) => `${i.repo}#${i.number}@${i.head}`;
  const last = new Map<string, SaveReviewInput>(inputs.map((i) => [keyOf(i), i]));
  const list = [...last.values()];
  const heads = list.map((i) => ({ repo: i.repo, number: i.number, head: i.head }));
  const refs = [...new Set(list.map((i) => refKey(i.repo, i.number)))];
  const [existingRows, stateRows] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.opus_reviews as o").select(["o.repo", "o.number", "o.head_oid", "o.at", "o.base_ref", "o.verdict"]).where(kx.tupleIn(db, ["o.repo", "o.number", "o.head_oid"], headTuples(heads), TUPLE))),
    q.all(q.k.selectFrom("main.review_state as s").innerJoin(kx.refPairs(db, refs, "kk"), (j) => j.onRef("kk.repo", "=", "s.repo").onRef("kk.number", "=", "s.number")).select(["s.repo", "s.number", "s.stale_at"])),
  ]));
  const existing = new Map(existingRows.map((r) => [`${r.repo}#${r.number}@${r.head_oid}`, r]));
  const staleAt = new Map(stateRows.map((r) => [refKey(r.repo, r.number), r.stale_at]));
  const clock = new Date().toISOString();

  type Plan = { i: SaveReviewInput; at: string; had: boolean; rebased: boolean; counted: boolean; trigger: string };
  const plans: Plan[] = list.map((i) => {
    const ex = existing.get(keyOf(i));
    const mark = staleAt.get(refKey(i.repo, i.number)) ?? null;
    const marked = !!ex && !!mark && mark > ex.at;
    const before = ex ? ex.base_ref ?? i.defaultBranch : null;
    const rebased = !!before && !!i.baseRef && before !== i.baseRef;
    return { i, at: i.at ?? clock, had: !!ex, rebased, counted: !!ex && ex.verdict !== null && !marked, trigger: i.trigger ?? (ex ? (marked ? "operator" : rebased ? "base" : "discussion") : "new-head") };
  });

  await db.write(async () => {
    const had = plans.filter((p) => p.had).map((p) => ({ repo: p.i.repo, number: p.i.number, head: p.i.head }));
    if (had.length) {
      const copied = ["repo", "number", "head_oid", "at", "model", "mode", "verdict", "sure", "reason", "risks", "fixes", "summary", "why", "public_review", "claims", "blocked_by"] as const;
      await q.run(q.k.insertInto("main.opus_review_history").columns([...copied])
        .expression((eb) => eb.selectFrom("main.opus_reviews as o").select(copied.map((c) => `o.${c}` as const))
          .where(kx.tupleIn(db, ["o.repo", "o.number", "o.head_oid"], headTuples(had), TUPLE))
          .where((e) => e.not(e.exists(e.selectFrom("main.opus_review_history as h").select(e.lit(1).as("one"))
            .whereRef("h.repo", "=", "o.repo").whereRef("h.number", "=", "o.number").whereRef("h.head_oid", "=", "o.head_oid").whereRef("h.at", "=", "o.at"))))));
    }
    const rows = plans.map(({ i, at, trigger }) => {
      const r = i.review;
      const fixes = json(r.fixes), risks = JSON.stringify(r.risks), pub = r.public ? JSON.stringify(r.public) : null, claims = json(r.claims);
      const blockedBy = r.verdict === "hold" && i.blockedBy.length ? JSON.stringify(i.blockedBy) : null;
      return {
        history: { repo: i.repo, number: i.number, head_oid: i.head, at, model: i.model, mode: i.mode, verdict: r.verdict, sure: r.sure ? 1 : 0, reason: r.reason, risks, fixes, summary: r.summary, why: r.why, public_review: pub, claims, blocked_by: blockedBy, trigger, job_id: i.jobId },
        review: { repo: i.repo, number: i.number, head_oid: i.head, run_id: i.runId, at, model: i.model, mode: i.mode, base_head: i.base, verdict: r.verdict, sure: r.sure ? 1 : 0, reason: r.reason, fixes, risks, public_review: pub,
          seen_at: i.snap?.seen ?? at, disc_hash: i.snap?.hash ?? null, summary: r.summary, why: r.why, conflicts: json(r.conflicts), claims, blocked_by: blockedBy, base_ref: i.baseRef, workflow: r.workflow ? JSON.stringify(r.workflow) : null, size_cap: i.sizeCap ?? null },
      };
    });
    for (const part of kx.batches(rows)) await q.run(q.k.insertInto("main.opus_review_history").values(part.map((x) => x.history)));
    for (const part of kx.batches(rows)) {
      await q.run(q.k.insertInto("main.opus_reviews").values(part.map((x) => x.review))
        .onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doUpdateSet(kx.excluded(["run_id", "at", "model", "mode", "base_head", "verdict", "sure", "reason", "fixes", "risks", "public_review",
          "seen_at", "disc_hash", "summary", "why", "conflicts", "claims", "blocked_by", "base_ref", "workflow", "size_cap"]))));
    }
    const reruns = new Map<RefKey, { repo: string; number: number; rerun_day: string; rerun_count: number }>();
    for (const p of plans) {
      if (!p.counted) continue;
      const ref = refKey(p.i.repo, p.i.number);
      const cur = reruns.get(ref);
      reruns.set(ref, { repo: p.i.repo, number: p.i.number, rerun_day: p.at.slice(0, 10), rerun_count: (cur?.rerun_count ?? 0) + 1 });
    }
    for (const part of kx.batches([...reruns.values()])) {
      await q.run(q.k.insertInto("main.review_state").values(part).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => ({
        rerun_count: eb.case().when(eb("main.review_state.rerun_day", "=", eb.ref("excluded.rerun_day"))).then(eb("main.review_state.rerun_count", "+", eb.ref("excluded.rerun_count"))).else(eb.ref("excluded.rerun_count")).end(),
        rerun_day: eb.ref("excluded.rerun_day"),
      }))));
    }
    await q.run(q.k.updateTable("main.review_state").set({ fail_head: null, fail_count: 0, fail_at: null, lost_count: 0, lost_at: null }).where(kx.tupleIn(db, ["repo", "number", "fail_head"], headTuples(heads), TUPLE)));
    await addStageEvents(db, plans.flatMap(({ i, at }) => [
      { repo: i.repo, number: i.number, stage: "reviewed", at, actor: "opus-review", note: `${i.review.verdict}${i.review.sure ? "" : " (unsure)"} at ${i.head.slice(0, 7)}: ${i.review.reason}` },
      { repo: i.repo, number: i.number, stage: i.review.verdict === "take-fix" ? "take" : i.review.verdict, at, actor: "opus-review", note: i.review.reason },
    ]));
    const rebased = plans.filter((p) => p.rebased).map((p) => ({ repo: p.i.repo, number: p.i.number, head: p.i.head }));
    if (rebased.length) {
      await q.run(q.k.deleteFrom("main.premerge_reviews").where(kx.tupleIn(db, ["repo", "number", "head_oid"], headTuples(rebased), TUPLE)));
      await markVerificationsStale(db, rebased.map((h) => `${h.repo}#${h.number}@${h.head}`));
    }
  });
  const rebased = new Set(plans.filter((p) => p.rebased).map((p) => keyOf(p.i)));
  return inputs.map((i) => ({ repo: i.repo, number: i.number, head: i.head, saved: last.get(keyOf(i)) === i, rebased: last.get(keyOf(i)) === i && rebased.has(keyOf(i)) }));
}

/** Upserts `stale_at = now`; with `by` also writes `review-again` audit rows. */
export async function markStale(db: Db, items: { repo: string; number: number }[], by: string | null): Promise<void> {
  const refs = [...new Map(items.map((i) => [refKey(i.repo, i.number), { repo: i.repo, number: i.number }])).values()];
  if (!refs.length) return;
  const q = queryDb(db);
  const at = new Date().toISOString();
  await db.write(async () => {
    for (const part of kx.batches(refs)) await q.run(q.k.insertInto("main.review_state").values(part.map((r) => ({ ...r, stale_at: at }))).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["stale_at"]))));
    if (by !== null) await addAudit(db, refs.map((r) => ({ login: by, action: "review-again", target: refKey(r.repo, r.number), details: { stale: true } })));
  });
}

/**
 * One upsert: a failure at the head already counted adds to its count, a failure at another head sets both counts again. A `lost` call
 * (it ended without a reply, lostCallError) counts in lost_count and leaves the model's fail_count as it was, until `lostLimit` of them
 * stand at the head: the next one counts as one model failure and lost_count starts over, so lost calls too end with a person.
 */
export async function recordReviewFailures(db: Db, items: { repo: string; number: number; head: string; at: string; lost?: boolean }[], lostLimit = REVIEW_LOST_LIMIT): Promise<void> {
  type R = { repo: string; number: number; fail_head: string; fail_count: number; fail_at: string | null; lost_count: number; lost_at: string | null };
  const rows = new Map<RefKey, R>();
  for (const i of items) {
    const ref = refKey(i.repo, i.number), was = rows.get(ref), cur = was?.fail_head === i.head ? was : undefined;
    rows.set(ref, i.lost
      ? { repo: i.repo, number: i.number, fail_head: i.head, fail_count: cur?.fail_count ?? 0, fail_at: cur?.fail_at ?? null, lost_count: (cur?.lost_count ?? 0) + 1, lost_at: i.at }
      : { repo: i.repo, number: i.number, fail_head: i.head, fail_count: (cur?.fail_count ?? 0) + 1, fail_at: i.at, lost_count: cur?.lost_count ?? 0, lost_at: cur?.lost_at ?? null });
  }
  if (!rows.size) return;
  const q = queryDb(db);
  for (const part of kx.batches([...rows.values()])) {
    await q.run(q.k.insertInto("main.review_state").values(part).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => {
      const same = eb("main.review_state.fail_head", "=", eb.ref("excluded.fail_head"));
      // A lost call past the limit at the same head: one model failure.
      const over = eb.and([same, eb("excluded.lost_count", ">", 0), eb("main.review_state.lost_count", ">=", lostLimit)]);
      const sum = (c: "fail_count" | "lost_count") => eb.case().when(same).then(eb(`main.review_state.${c}`, "+", eb.ref(`excluded.${c}`))).else(eb.ref(`excluded.${c}`)).end();
      // A time this upsert does not set keeps the stored one at the same head.
      const time = (c: "fail_at" | "lost_at") => eb.case().when(same).then(eb.fn.coalesce(eb.ref(`excluded.${c}`), eb.ref(`main.review_state.${c}`))).else(eb.ref(`excluded.${c}`)).end();
      return {
        fail_count: eb.case().when(over).then(eb(eb("main.review_state.fail_count", "+", eb.ref("excluded.fail_count")), "+", 1)).else(sum("fail_count")).end(),
        lost_count: eb.case().when(over).then(eb.lit(0)).else(sum("lost_count")).end(),
        fail_at: eb.case().when(over).then(eb.ref("excluded.lost_at")).else(time("fail_at")).end(),
        lost_at: time("lost_at"), fail_head: eb.ref("excluded.fail_head"),
      };
    })));
  }
}

/**
 * Deletes the too-large holds at `heads` that are still holds made without a model call under a diff size cap below `cap` (a hold without
 * its cap counts as `unstamped`), and audits each as `review-again` by `by`. A review a model wrote there meanwhile stays. Returns what it removed.
 */
export async function dropTooLargeHolds(db: Db, heads: { repo: string; number: number; head: string }[], cap: number, unstamped: number, by: string): Promise<{ repo: string; number: number }[]> {
  if (!heads.length) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const gone: { repo: string; number: number; head_oid: string; reason: string | null; size_cap: number | null }[] = [];
    for (const part of kx.chunks(heads)) {
      gone.push(...await q.all(q.k.deleteFrom("main.opus_reviews").where(kx.tupleIn(db, ["repo", "number", "head_oid"], headTuples(part), TUPLE))
        .where("verdict", "=", "hold").where("model", "is", null).where((eb) => eb(eb.fn.coalesce("size_cap", eb.lit(unstamped)), "<", cap))
        .returning(["repo", "number", "head_oid", "reason", "size_cap"])));
    }
    if (gone.length) await addAudit(db, gone.map((g) => ({ login: by, action: "review-again", target: refKey(g.repo, g.number), details: { head: g.head_oid, reason: g.reason, cap: g.size_cap ?? unstamped, now: cap } })));
    return gone.map((g) => ({ repo: g.repo, number: Number(g.number) }));
  });
}

/** The operator "Review again" on a hold: deletes the hold review at each head and audits it. Returns what it removed. */
export async function dropHoldReviews(db: Db, items: { repo: string; number: number; head: string }[], by: string): Promise<{ repo: string; number: number; reason: string }[]> {
  if (!items.length) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const gone: { repo: string; number: number; head_oid: string; reason: string | null }[] = [];
    for (const part of kx.chunks(items)) {
      gone.push(...await q.all(q.k.deleteFrom("main.opus_reviews").where(kx.tupleIn(db, ["repo", "number", "head_oid"], headTuples(part), TUPLE)).where("verdict", "=", "hold").returning(["repo", "number", "head_oid", "reason"])));
    }
    if (gone.length) await addAudit(db, gone.map((g) => ({ login: by, action: "review-again", target: refKey(g.repo, g.number), details: { head: g.head_oid, reason: g.reason } })));
    return gone.map((g) => ({ repo: g.repo, number: g.number, reason: g.reason ?? "" }));
  });
}

/**
 * Stored reviews (`tries` kept, error cleared) and failed tries (one more try, or the maximum when final) as multi-row upserts. A `lost`
 * try (the call ended without a reply) uses no try: it adds to `lost`, which a stored review or a counted try sets back to 0.
 */
export async function savePremerge(db: Db, saves: PremergeSave[]): Promise<void> {
  if (!saves.length) return;
  const q = queryDb(db);
  const stored = new Map<string, any>(), failed = new Map<string, any>(), final = new Map<string, any>(), lost = new Map<string, any>();
  for (const s of saves) {
    const key = `${s.repo}#${s.number}@${s.head}`, id = { repo: s.repo, number: s.number, head_oid: s.head };
    if (s.findings) {
      stored.set(key, { ...id, at: s.at, run_id: s.runId ?? null, model: s.model ?? null, findings: JSON.stringify(s.findings), searched: s.searched ?? null, conflicts: json(s.conflicts), unsure: s.unsure ? 1 : 0, claims: json(s.claims), base_ref: s.baseRef ?? null, error: null, tries: 0, lost: 0 });
    } else if (s.final) {
      final.set(key, { ...id, at: s.at, run_id: s.runId ?? null, model: s.model ?? null, error: s.error ?? "failed", tries: PREMERGE_MAX_TRIES, lost: 0 });
    } else if (s.lost) {
      lost.set(key, { ...id, at: s.at, run_id: s.runId ?? null, model: s.model ?? null, error: s.error ?? "failed", tries: 0, lost: (lost.get(key)?.lost ?? 0) + 1 });
    } else {
      const n = (failed.get(key)?.tries ?? 0) + 1;
      failed.set(key, { ...id, at: s.at, run_id: s.runId ?? null, model: s.model ?? null, error: s.error ?? "failed", tries: n, lost: 0 });
    }
  }
  await db.write(async () => {
    for (const part of kx.batches([...stored.values()])) {
      await q.run(q.k.insertInto("main.premerge_reviews").values(part).onConflict((oc) => oc.columns(["repo", "number", "head_oid"])
        .doUpdateSet((eb) => ({ ...kx.excluded(["at", "run_id", "model", "findings", "searched", "conflicts", "unsure", "claims", "base_ref"])(eb), error: null, lost: 0 }))));
    }
    for (const part of kx.batches([...failed.values()])) {
      await q.run(q.k.insertInto("main.premerge_reviews").values(part).onConflict((oc) => oc.columns(["repo", "number", "head_oid"])
        .doUpdateSet((eb) => ({ ...kx.excluded(["at", "run_id", "model", "error", "lost"])(eb), tries: eb("main.premerge_reviews.tries", "+", eb.ref("excluded.tries")) }))));
    }
    for (const part of kx.batches([...lost.values()])) {
      // A stored review stays as it is: a lost call says nothing about it. Past PREMERGE_LOST_LIMIT lost calls in a row the next one uses a try.
      await q.run(q.k.insertInto("main.premerge_reviews").values(part).onConflict((oc) => oc.columns(["repo", "number", "head_oid"])
        .doUpdateSet((eb) => {
          const over = eb("main.premerge_reviews.lost", ">=", PREMERGE_LOST_LIMIT);
          return {
            ...kx.excluded(["at", "run_id", "model", "error"])(eb),
            tries: eb.case().when(over).then(eb("main.premerge_reviews.tries", "+", 1)).else(eb.ref("main.premerge_reviews.tries")).end(),
            lost: eb.case().when(over).then(eb.lit(0)).else(eb("main.premerge_reviews.lost", "+", eb.ref("excluded.lost"))).end(),
          };
        })
        .where("main.premerge_reviews.findings", "is", null)));
    }
    for (const part of kx.batches([...final.values()])) {
      await q.run(q.k.insertInto("main.premerge_reviews").values(part).onConflict((oc) => oc.columns(["repo", "number", "head_oid"])
        .doUpdateSet(kx.excluded(["at", "run_id", "model", "error", "tries", "lost"]))));
    }
  });
}

/**
 * Gives each head's pre-merge review that failed for good one more try, due an hour after its last failure: its failed tries go back to
 * the last quick one, so a failure of that try starts the slow tries of the day again. A stored review is left as it is.
 */
export async function retryPremergeAt(db: Db, heads: { repo: string; number: number; head: string }[]): Promise<void> {
  if (!heads.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.updateTable("main.premerge_reviews").set({ tries: PREMERGE_QUICK_TRIES - 1, lost: 0 })
      .where("findings", "is", null).where("tries", ">=", PREMERGE_MAX_TRIES).where(kx.tupleIn(db, ["repo", "number", "head_oid"], headTuples(heads), TUPLE)));
  });
}

/**
 * A failed try never replaces a stored clean review; a `retry:` error adds to `tries` and becomes `held: gave up after N tries` at the
 * maximum; one skipped-minor or skipped-duplicate follow-up row per finding. Returns the defect count of each PR stored, for the caller
 * to record with `control.tripMergeBreakers` in the same outer transaction.
 */
export async function savePostmerge(db: Db, saves: PostmergeSave[]): Promise<{ defects: Map<RefKey, number> }> {
  const defects = new Map<RefKey, number>();
  if (!saves.length) return { defects };
  const q = queryDb(db);
  await db.write(async () => {
    const prev = new Map((await q.all(q.k.selectFrom("main.postmerge_reviews as r").innerJoin(kx.refPairs(db, saves.map((s): [string, number] => [s.repo, s.number]), "kk"), (j) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number"))
      .select(["r.repo", "r.number", "r.tries", "r.error"]))).map((r) => [refKey(r.repo, r.number), { tries: Number(r.tries), error: r.error }]));
    const rows = new Map<RefKey, any>();
    const skipped: any[] = [];
    for (const s of saves) {
      const ref = refKey(s.repo, s.number), here = rows.get(ref), p = prev.get(ref) ?? (here ? { tries: here.tries as number, error: here.error as string | null } : undefined);
      if (s.error && p && p.error === null) continue;
      let error = s.error, tries = 0;
      if (error?.startsWith("retry:")) {
        tries = (p?.tries ?? 0) + 1;
        if (tries >= MAX_RETRIES) error = `held: gave up after ${tries} tries (${error.slice("retry:".length).trim()})`;
      }
      rows.set(ref, { repo: s.repo, number: s.number, merge_sha: s.merge_sha, at: s.at, model: s.model, run_id: s.run_id, findings: s.findings ? JSON.stringify(s.findings) : null, error, tries });
      defects.set(ref, (s.findings ?? []).filter((f) => f.severity === "defect").length);
      (s.findings ?? []).forEach((f: Finding, i) => {
        if (f.severity === "minor") skipped.push({ repo: s.repo, number: s.number, review_at: s.at, finding: i, title: f.title, issue_number: null, url: null, state: "skipped-minor", at: s.at, duplicate_of: null });
        else if (f.duplicate_of !== null) skipped.push({ repo: s.repo, number: s.number, review_at: s.at, finding: i, title: f.title, issue_number: null, url: null, state: "skipped-duplicate", at: s.at, duplicate_of: f.duplicate_of });
      });
    }
    for (const part of kx.batches([...rows.values()])) {
      await q.run(q.k.insertInto("main.postmerge_reviews").values(part).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["merge_sha", "at", "model", "run_id", "findings", "error", "tries"]))
        .where((eb) => eb.or([eb("main.postmerge_reviews.error", "is not", null), eb("excluded.error", "is", null)]))));
    }
    for (const part of kx.batches(skipped)) await q.run(q.k.insertInto("main.postmerge_followups").values(part).onConflict((oc) => oc.doNothing()));
  });
  return { defects };
}

/** The key `claimFollowups` returns for a follow-up. */
export const followupKey = (k: { repo: string; number: number; review_at: string; finding: number }): string => `${k.repo}#${k.number}@${k.review_at}:${k.finding}`;

const FOLLOWUP_SET = ["title", "issue_number", "url", "state", "at", "duplicate_of", "attempts", "note"] as const;
const followupConflict = (oc: any) => oc.columns(["repo", "number", "review_at", "finding"]);

/** Compare-and-set claim: writes the `filing` row of each unless it is already `filing` or `filed`, in one statement. Returns the `followupKey`s claimed. */
export async function claimFollowups(db: Db, rows: FollowupClaim[], o: { at: string }): Promise<Set<string>> {
  const won = new Set<string>();
  if (!rows.length) return won;
  const q = queryDb(db);
  const unique = [...new Map(rows.map((r) => [followupKey(r), r])).values()];
  for (const part of kx.batches(unique)) {
    const got = await q.all(q.k.insertInto("main.postmerge_followups")
      .values(part.map((r) => ({ repo: r.repo, number: r.number, review_at: r.review_at, finding: r.finding, title: r.title, issue_number: null, url: null, state: "filing", at: o.at, duplicate_of: null, attempts: r.attempts, note: null })))
      .onConflict((oc) => followupConflict(oc).doUpdateSet(kx.excluded(FOLLOWUP_SET)).where("main.postmerge_followups.state", "not in", ["filing", "filed"]))
      .returning(["repo", "number", "review_at", "finding"]));
    for (const g of got) won.add(followupKey(g));
  }
  return won;
}

/** Upsert of follow-up rows (filing result, failed, skipped). A later row of one key in the call wins. */
export async function saveFollowups(db: Db, rows: FollowupRow[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const unique = [...new Map(rows.map((r) => [followupKey(r), r])).values()];
  for (const part of kx.batches(unique)) {
    await q.run(q.k.insertInto("main.postmerge_followups")
      .values(part.map((r) => ({ repo: r.repo, number: r.number, review_at: r.review_at, finding: r.finding, title: r.title, issue_number: r.issue_number, url: r.url, state: r.state, at: r.at, duplicate_of: r.duplicate_of, attempts: r.attempts, note: r.note })))
      .onConflict((oc) => followupConflict(oc).doUpdateSet(kx.excluded(FOLLOWUP_SET))));
  }
}

/** Writes the outcome of rows left in `filing`: only over a row still in `filing` that was claimed by `before`. */
export async function settleFilings(db: Db, rows: FollowupRow[], o: { before: string }): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  for (const part of kx.batches(rows)) {
    await q.run(q.k.insertInto("main.postmerge_followups")
      .values(part.map((r) => ({ repo: r.repo, number: r.number, review_at: r.review_at, finding: r.finding, title: r.title, issue_number: r.issue_number, url: r.url, state: r.state, at: r.at, duplicate_of: r.duplicate_of, attempts: r.attempts, note: r.note })))
      .onConflict((oc) => followupConflict(oc).doUpdateSet(kx.excluded(FOLLOWUP_SET)).where("main.postmerge_followups.state", "=", "filing").where("main.postmerge_followups.at", "<=", o.before)));
  }
}

/** A fresh post is an upsert of every column; an edit updates head, edit time, `opus_at` and `posted_as` only. A later row of one PR in the call wins. */
export async function saveReviewPosts(db: Db, rows: PostSave[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const posted = new Map<RefKey, any>(), edited = new Map<RefKey, any>();
  for (const r of rows) {
    const ref = refKey(r.repo, r.number);
    if (r.kind === "posted") { posted.set(ref, { repo: r.repo, number: r.number, review_id: r.review_id, head_oid: r.head, posted_at: r.posted_at, edited_at: r.edited_at, opus_at: r.opus_at, posted_as: r.posted_as }); edited.delete(ref); }
    else if (!posted.has(ref)) edited.set(ref, { repo: r.repo, number: r.number, head_oid: r.head, edited_at: r.edited_at, opus_at: r.opus_at, posted_as: r.posted_as });
    else { const p = posted.get(ref); posted.set(ref, { ...p, head_oid: r.head, edited_at: r.edited_at, opus_at: r.opus_at, posted_as: r.posted_as }); }
  }
  await db.write(async () => {
    for (const part of kx.batches([...posted.values()])) {
      await q.run(q.k.insertInto("main.review_posts").values(part).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["review_id", "head_oid", "posted_at", "edited_at", "opus_at", "posted_as"]))));
    }
    if (edited.size) await kx.updateFrom(db, "main.review_posts", ["repo", "number"], [...edited.values()], ["head_oid", "edited_at", "opus_at", "posted_as"]);
  });
}
