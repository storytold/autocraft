// Stage 5, Review: Opus reviews every wanted PR, one PR per call, and its verdict is the
// one every later stage reads (the `final_reviews` view). After a new push Opus reads only
// the delta since the head it reviewed before. Reads GitHub (diffs); never writes to it.
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { currentJobId, poolRoom, takersCut } from "../agents/call.ts";
import { pool } from "../classify/run.ts";
import { runModelStep } from "../agents/step.ts";
import { REVIEW_OPUS } from "../agents/steps.ts";
import { Client, type Querier } from "../mirror.ts";
import { checksOf, refreshChecks } from "./checks.ts";
import { openBlockers } from "./blockers.ts";
import { isScopeQuestion, settledScope } from "./candidates.ts";
import { recordReviewFailure, reviewHolds } from "./gate.ts";
import { MAX_RERUNS_PER_DAY, countRerun, discussionOf, ensurePipelineLogin, liveDiscussion, markedStaleSince, staleReviews, withRetry, type Snapshot } from "./discussion.ts";
import { withdrawHoldQuestion, withdrawMergeQuestion } from "../merge/withdraw.ts";
import { headWasUnsure, mergeDecisionId, holdDecisionId } from "../merge/queue.ts";
import { defaultBranchOf, recordLiveBase, reviewedBaseOf } from "../merge/base.ts";
import { relatedOpen, latestReview } from "../postmerge/related.ts";
import type { DiscussionEntry } from "./parse.ts";
import { reviewAfterBaseMerge } from "./own-diff.ts";
import { MAX_DIFF_CHARS, cachedDiff, cachedDiffBase, codeDiff, ghDelta, ghDiff, type DeltaFetcher, type DiffFetcher } from "./diff.ts";
import { selectOpusCandidates, type OpusCandidate } from "./opus-candidates.ts";
import { carriedOutcome, rawReason, type EarlierOpus, type OpusPr, type OpusReview, type UnappliedFix } from "./opus-parse.ts";
import { ourCommitsSince } from "./ours.ts";
import { relatedStatements } from "../memory/retrieve.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, type SemanticDeps } from "../reference-lint.ts";
import { jobItem } from "../runner/job-items.ts";
import { filterSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import * as kx from "../db/kx.ts";
import type { NotNull } from "kysely";

const PROMPT = CLAUDE_PROMPTS["review.opus"];
export { MAX_DIFF_CHARS };
export const TOO_LARGE = "too large to review automatically";

export type OpusParams = {
  repo: string; limit?: number; dryRun?: boolean;
  /** Called with the running count of PRs handled. */
  onHandled?: (n: number) => void;
};
export type OpusDeps = {
  /** Reads the live head and state of the candidates just before the model calls; absent: the mirror's view stands. */
  querier?: Querier;
  fetchDiff: DiffFetcher; fetchDelta: DeltaFetcher; model: string; maxChars: number;
  /** Host directory with a read-only checkout of the PR head for a sandboxed call, or null to ask without tools. Absent: no tools. */
  checkout?: (repo: string, number: number, head: string) => Promise<string | null>;
  /** The Jev and Haiku calls of the semantic reference check; absent: the real ones. */
  semantic?: SemanticDeps;
};
export type OpusSummary = {
  runId: string; repo: string; candidates: number; reviewed: number; dropped: number;
  verdicts: Record<string, number>; missing: string[]; skipped: string[];
};

const now = () => new Date().toISOString();
const scopeSettledField = async (db: Db, repo: string, number: number): Promise<{ scope_settled?: NonNullable<OpusPr["scope_settled"]> }> => {
  const s = await settledScope(db, repo, number);
  return s ? { scope_settled: s } : {};
};
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export function defaultOpusDeps(): OpusDeps {
  return { querier: new Client(500), fetchDiff: ghDiff, fetchDelta: ghDelta, model: PROMPT.models[0]!, maxChars: MAX_DIFF_CHARS, checkout: (r, n, h) => checkoutForPr(r, n, h, console.log) };
}

type Saved = { snap?: Snapshot; mode: "full" | "delta" | "carried"; base: string | null; model: string | null; review: OpusReview; /** The fixes this review was given as unapplied, with what the reply did with each. */ unapplied?: (UnappliedFix & { outcome: string })[];
  /** The base branch the reviewed diff was read against (a delta or carried review: the earlier review's); absent: the cached diff's, else the mirrored base. */ baseRef?: string | null };

/**
 * Stores the Opus row of a head commit, then a `reviewed` stages row and a take/hold/close
 * stages row (take-fix counts as take). A second review of the same head counts against
 * the PR's daily cap unless an operator or a merge-time check asked for it.
 * A review of the head against another base than the one before it voids what was decided for the old diff:
 * the Merge answer, the pre-merge review and the verification.
 */
export async function saveOpus(db: Db, runId: string | null, c: { repo: string; number: number; head_oid: string }, s: Saved): Promise<void> {
  const at = now(), r = s.review;
  const again = await db.get(db.k.selectFrom("opus_reviews").select("at").where("repo", "=", c.repo).where("number", "=", c.number).where("head_oid", "=", c.head_oid));
  const baseRef = s.baseRef !== undefined ? s.baseRef : await reviewedBase(db, c);
  const before = again ? await reviewedBaseOf(db, c.repo, c.number, c.head_oid) ?? await defaultBranchOf(db, c.repo) : null;
  const rebased = !!before && !!baseRef && before !== baseRef;
  const reviewed = await db.get(db.k.selectFrom("opus_reviews").select("at").where("repo", "=", c.repo).where("number", "=", c.number).where("head_oid", "=", c.head_oid).where("verdict", "is not", null));
  if (reviewed && !await markedStaleSince(db, c.repo, c.number, reviewed.at)) await countRerun(db, c.repo, c.number);
  // A head that was ever unsure keeps its Merge? question (and a person's answer to it) through a re-review that stays take or take-fix.
  // An answered question is withdrawn as for any re-review: the head then needs a new answer.
  const unanswered = !!await db.get(db.k.selectFrom("decisions").select((eb) => eb.lit(1).as("one")).where("id", "=", mergeDecisionId(c.repo, c.number, c.head_oid)).where("answer", "is", null));
  const keepsQuestion = !!again && !rebased && unanswered && (r.verdict === "take" || r.verdict === "take-fix") && await headWasUnsure(db, c.repo, c.number, c.head_oid);
  // An answered, unapplied merge answer stands through a re-review at the same head and base unless the verdict got worse.
  const keepsAnswer = !!again && !rebased && (r.verdict === "take" || r.verdict === "take-fix") && r.sure
    && !!await db.get(db.k.selectFrom("decisions").select((eb) => eb.lit(1).as("one")).where("id", "=", mergeDecisionId(c.repo, c.number, c.head_oid)).where("answer", "=", "merge").where("applied_at", "is", null));
  if (again && !keepsQuestion && !keepsAnswer) {
    const worse = r.verdict === "take" || r.verdict === "take-fix" ? "the new review is unsure" : `the new review is a ${r.verdict}`;
    await withdrawMergeQuestion(db, c.repo, c.number, c.head_oid, at, rebased ? `the base branch changed from ${before} to ${baseRef}` : `superseded by a new review: ${worse}`);
  }
  if (rebased) {
    await db.run(db.k.deleteFrom("premerge_reviews").where("repo", "=", c.repo).where("number", "=", c.number).where("head_oid", "=", c.head_oid));
    await db.run(db.k.updateTable("verifications").set({ state: "stale" }).where("repo", "=", c.repo).where("number", "=", c.number).where("head_sha", "=", c.head_oid));
  }
  // The Hold question belongs to one review: a review made again at the head asks it anew if the verdict is still hold.
  // An unanswered or Wait-answered question stays while the verdict is still hold: its review time moves, so the prepare is written again.
  const holdId = holdDecisionId(c.repo, c.number, c.head_oid);
  const keepsHold = r.verdict === "hold" && !!await db.get(db.k.selectFrom("decisions").select((eb) => eb.lit(1).as("one")).where("id", "=", holdId).where((eb) => eb.or([eb("answer", "is", null), eb("answer", "=", "wait")])));
  if (again && !keepsHold) await withdrawHoldQuestion(db, c.repo, c.number, c.head_oid, at, "superseded by a new review");
  // The row about to be replaced may predate the history: copy it first.
  await db.run(db.k.insertInto("main.opus_review_history")
    .columns(["repo", "number", "head_oid", "at", "model", "mode", "verdict", "sure", "reason", "risks", "fixes", "summary", "why", "public_review", "claims", "blocked_by"])
    .expression((eb) => eb.selectFrom("main.opus_reviews as o")
      .select(["o.repo", "o.number", "o.head_oid", "o.at", "o.model", "o.mode", "o.verdict", "o.sure", "o.reason", "o.risks", "o.fixes", "o.summary", "o.why", "o.public_review", "o.claims", "o.blocked_by"])
      .where((eb) => eb.not(eb.exists(eb.selectFrom("main.opus_review_history as h").select(eb.lit(1).as("one"))
        .whereRef("h.repo", "=", "o.repo").whereRef("h.number", "=", "o.number").whereRef("h.head_oid", "=", "o.head_oid").whereRef("h.at", "=", "o.at"))))
      .where("o.repo", "=", c.repo).where("o.number", "=", c.number).where("o.head_oid", "=", c.head_oid)));
  const risks = JSON.stringify(r.risks), fixes = r.fixes.length ? JSON.stringify(r.fixes) : null, pub = r.public ? JSON.stringify(r.public) : null, claims = r.claims.length ? JSON.stringify(r.claims) : null;
  // Only open tracked items other than the PR can block it: a reference that is already closed would end the wait at once.
  // A scope question is no blocker once a person has settled scope for this PR.
  const scopeSettled = await settledScope(db, c.repo, c.number) !== null;
  const blockers = r.verdict === "hold" ? await filterSeq((await openBlockers(db, r.blocked_by.filter((x) => x !== `${c.repo}#${c.number}`))), async (b) => !(scopeSettled && await isScopeQuestion(db, b))) : [];
  const blockedBy = blockers.length ? JSON.stringify(blockers) : null;
  await db.run(db.k.insertInto("opus_review_history").values({ repo: c.repo, number: c.number, head_oid: c.head_oid, at, model: s.model, mode: s.mode, verdict: r.verdict,
    sure: r.sure ? 1 : 0, reason: r.reason, risks, fixes, summary: r.summary, why: r.why, public_review: pub, claims, blocked_by: blockedBy,
    trigger: again ? (await markedStaleSince(db, c.repo, c.number, again.at) ? "operator" : rebased ? "base" : "discussion") : "new-head", job_id: currentJobId() }));
  await db.run(db.k.insertInto("opus_reviews").values({ repo: c.repo, number: c.number, head_oid: c.head_oid, run_id: runId, at, model: s.model, mode: s.mode, base_head: s.base,
      verdict: r.verdict, sure: r.sure ? 1 : 0, reason: r.reason, fixes, risks, public_review: pub, seen_at: s.snap?.seen ?? at, disc_hash: s.snap?.hash ?? null, summary: r.summary,
      why: r.why, conflicts: r.conflicts.length ? JSON.stringify(r.conflicts) : null, claims, blocked_by: blockedBy, base_ref: baseRef })
    .onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doUpdateSet(kx.excluded(["run_id", "at", "model", "mode", "base_head", "verdict", "sure", "reason", "fixes", "risks", "public_review",
      "seen_at", "disc_hash", "summary", "why", "conflicts", "claims", "blocked_by", "base_ref"]))));
  await db.run(db.k.deleteFrom("main.settings").where("key", "=", `review_fail:${c.repo}#${c.number}@${c.head_oid}`));
  await db.run(db.k.deleteFrom("opus_carried_fixes").where("repo", "=", c.repo).where("number", "=", c.number).where("head_oid", "=", c.head_oid));
  for (const u of s.unapplied ?? []) {
    await db.run(db.k.insertInto("opus_carried_fixes").values({ repo: c.repo, number: c.number, head_oid: c.head_oid, from_head: u.head, file: u.file, change: u.change, outcome: u.outcome, at }));
  }
  await db.run(db.k.insertInto("main.stages").values({ repo: c.repo, number: c.number, stage: "reviewed", at, actor: "opus-review", note: `${r.verdict}${r.sure ? "" : " (unsure)"} at ${c.head_oid.slice(0, 7)}: ${r.reason}` }));
  await db.run(db.k.insertInto("main.stages").values({ repo: c.repo, number: c.number, stage: r.verdict === "take-fix" ? "take" : r.verdict, at, actor: "opus-review", note: r.reason }));
}

/** The Opus review of the PR's latest earlier head that a model wrote (not a too-large hold), for the delta. */
export async function earlierOpus(db: Db, c: { repo: string; number: number; head_oid: string }, skip = 0): Promise<EarlierOpus | null> {
  const o = await db.get(db.k.selectFrom("opus_reviews").select(["head_oid", "verdict", "sure", "reason", "fixes"]).$narrowType<{ verdict: NotNull }>()
    .where("repo", "=", c.repo).where("number", "=", c.number).where("head_oid", "<>", c.head_oid).where("verdict", "is not", null).where("model", "is not", null)
    .orderBy("at", "desc").orderBy(kx.rowid("opus_reviews"), "desc").limit(1).offset(skip));
  if (!o) return null;
  let fixes: EarlierOpus["fixes"] = [];
  try { fixes = JSON.parse(o.fixes ?? "[]") as EarlierOpus["fixes"]; } catch { /* none */ }
  return { head: o.head_oid, verdict: o.verdict, sure: o.sure === 1, reason: o.reason ?? "", fixes };
}

/**
 * The fixes of the PR's latest earlier reviewed head, when that review was a take-fix whose fixes were never pushed
 * and never posted as a comment (a conflict merge of ours or an author push made a new head first).
 */
export async function unappliedFixes(db: Db, c: { repo: string; number: number; head_oid: string }): Promise<UnappliedFix[]> {
  // A hold in between (an author push the reviewer could not judge) does not make the older take-fix's fixes moot.
  let e = await earlierOpus(db, c);
  if (e?.verdict === "hold") e = await earlierOpus(db, c, 1);
  if (!e || e.verdict !== "take-fix") return [];
  if (await db.get(db.k.selectFrom("fixups").select((eb) => eb.lit(1).as("one")).where("repo", "=", c.repo).where("number", "=", c.number).where("from_head", "=", e.head).where("state", "in", ["pushed", "asked"]))) return [];
  return e.fixes.filter((f) => typeof f?.file === "string" && !!f.file.trim() && typeof f.change === "string").map((f) => ({ head: e.head, file: f.file, change: f.change }));
}

/** The base branch the review's diff was computed against; the mirrored base when the cached diff does not say. */
async function reviewedBase(db: Db, c: { repo: string; number: number; head_oid: string }): Promise<string | null> {
  return cachedDiffBase(c.repo, c.number, c.head_oid)
    ?? (await db.get(db.k.selectFrom("items").select("base_ref").where("repo", "=", c.repo).where("number", "=", c.number)))?.base_ref ?? null;
}

/** `base`: the earlier head a delta was read from; `baseRef`: the base branch the whole PR diff was read against. */
export type PreparedOpus =
  | { kind: "no-diff"; error: string }
  | { kind: "large"; mode: "full" | "delta"; base: string | null; baseRef: string | null }
  | { kind: "no-threads"; error: string }
  | { kind: "ready"; input: OpusPr; snap: Snapshot; mode: "full" | "delta"; base: string | null; baseRef: string | null; /** A maintainer's entry was left out of the discussion for length. */ maintDropped?: boolean };

/**
 * Builds the Opus prompt input of a candidate: diff (full, or the delta since the last Opus review),
 * size cap and discussion. `independent`: the whole diff with no earlier review, discussion or unapplied fixes, for a
 * review that must not be anchored on the first one (the pre-merge review); the snapshot then marks the time of the read.
 */
export async function prepareOpusInput(db: Db, repo: string, c: OpusCandidate, deps: OpusDeps, log: (line: string) => void, opts: { independent?: boolean } = {}): Promise<PreparedOpus> {
  const liveBase = (await db.get(db.k.selectFrom("items").select("base_ref").where("repo", "=", repo).where("number", "=", c.number)))?.base_ref;
  const d = await cachedDiff(db, repo, c.number, c.head_oid, deps.fetchDiff, liveBase);
  if (!d.ok) return d.tooLarge ? { kind: "large", mode: "full", base: null, baseRef: liveBase ?? null } : { kind: "no-diff", error: d.error };
  const baseRef = d.base ?? liveBase ?? null;
  // The read saw the PR's live base: the mirror takes it at once, so the review is not compared with a base the next sync would replace.
  if (d.base && liveBase !== undefined && d.base !== liveBase) await recordLiveBase(db, repo, c.number, c.head_oid, d.base, { by: "opus-review", keepDiff: true });
  const ch = await checksOf(db, repo, c.number);
  // Test files are shown while they fit the size cap; the merge rule sends a PR whose tests do not fit to a person.
  const cd = codeDiff(d.text, deps.maxChars);
  // The size cap applies to the whole PR, so a small push never lets a too-large PR through as a delta.
  if (cd.text.length > deps.maxChars || (!cd.files.length && cd.testsOmitted.length)) return { kind: "large", mode: "full", base: null, baseRef };
  if (opts.independent) {
    const input: OpusPr = {
      ref: refOf(c), title: c.title, body: c.body, author_association: c.author_association, size: c.size, lines_changed: c.lines_changed,
      ci: ch?.overall ?? "unknown", mergeable: ch?.mergeable ?? null, files: cd.files, tests_omitted: cd.testsOmitted, lockfiles_omitted: cd.lockfilesOmitted,
      mode: "full", earlier_opus: null, diff: cd.text,
      related_open: await relatedOpen(db, repo, c.number, cd.files), review_history: await latestReview(db, repo, c.number, c.head_oid),
    };
    return { kind: "ready", input: { ...input, statements: await relatedStatements(db, repo, c.number), ...await scopeSettledField(db, repo, c.number) }, snap: { seen: now(), hash: null }, mode: "full", base: null, baseRef };
  }
  let mode: "full" | "delta" = "full", diff = cd.text, base: string | null = null;
  // A delta stands on the earlier review only when that review read the PR against the same base branch; after a retarget the whole diff is reviewed.
  const prior = await earlierOpus(db, c);
  const priorBase = prior ? await reviewedBaseOf(db, repo, c.number, prior.head) ?? await defaultBranchOf(db, repo) : null;
  const earlier = prior && (priorBase === null || baseRef === null || priorBase === baseRef) ? prior : null;
  // A merge commit of ours carries the base branch's changes since the earlier head, so a delta of the heads would show unrelated changes: the delta is taken between the PR's own diffs.
  const merged = await db.get(db.k.selectFrom("conflict_merges").select(["from_head", "own_diff", "own_delta"]).where("repo", "=", repo).where("number", "=", c.number).where("to_head", "=", c.head_oid).where("state", "=", "merged")
    .orderBy(kx.rowid("conflict_merges"), "desc").limit(1));
  if (earlier && !merged) {
    const delta = await deps.fetchDelta(repo, earlier.head, c.head_oid);
    // A delta whose test files do not all fit is not used: the full diff shows them.
    const dd = delta.ok ? codeDiff(delta.text, deps.maxChars) : null;
    if (dd && !dd.testsOmitted.length) { mode = "delta"; diff = dd.text; base = earlier.head; }
    else if (!delta.ok) log(`  ${refOf(c)}: delta since ${earlier.head.slice(0, 7)} unavailable (${delta.error}); full diff`);
  } else if (earlier && merged?.own_delta && reviewAfterBaseMerge(merged.own_diff) === "delta" && merged.from_head === earlier.head && earlier.sure && (earlier.verdict === "take" || earlier.verdict === "take-fix")) {
    // The delta was computed from the local commits when the merge was made; the diff of the earlier head is never fetched by number.
    const dd = codeDiff(merged.own_delta, deps.maxChars);
    if (dd.text && !dd.testsOmitted.length) { mode = "delta"; diff = dd.text; base = earlier.head; }
  }
  if (diff.length > deps.maxChars) return { kind: "large", mode, base, baseRef };
  let discussion: DiscussionEntry[], snap: Snapshot, maintDropped: boolean;
  try {
    // What the PR's previous review read is not lost to the budget silently: only maintainers' words since then must fit.
    const since = (await db.get(db.k.selectFrom("opus_reviews").select((eb) => eb.fn.coalesce("seen_at", "at").as("seen")).where("repo", "=", repo).where("number", "=", c.number).where("verdict", "is not", null)
      .orderBy("at", "desc").orderBy(kx.rowid("opus_reviews"), "desc").limit(1)))?.seen ?? "";
    ({ entries: discussion, snap, maintDropped } = await discussionOf(db, repo, c.number, deps.querier ? await withRetry(() => liveDiscussion(deps.querier!, db, repo, c.number)) : undefined, since));
  } catch (e) {
    return { kind: "no-threads", error: String((e as Error).message ?? e) };
  }
  const unapplied = await unappliedFixes(db, c);
  // Our own commits since the earlier reviewed head, for the reviewer to check against what was asked of them.
  const ours = earlier ? (await ourCommitsSince(db, repo, c.number, earlier.head, c.head_oid)).commits.map(({ from: _from, ...x }) => x) : [];
  const input: OpusPr = {
    ref: refOf(c), title: c.title, body: c.body, author_association: c.author_association, size: c.size, lines_changed: c.lines_changed,
    ci: ch?.overall ?? "unknown", mergeable: ch?.mergeable ?? null, files: cd.files, tests_omitted: cd.testsOmitted, lockfiles_omitted: cd.lockfilesOmitted,
    mode, earlier_opus: mode === "delta" ? earlier : null, ...(unapplied.length ? { unapplied_fixes: unapplied } : {}), ...(ours.length ? { pipeline_commits: ours } : {}), diff, discussion,
    related_open: await relatedOpen(db, repo, c.number, cd.files),
    statements: await relatedStatements(db, repo, c.number),
    ...await scopeSettledField(db, repo, c.number),
  };
  return { kind: "ready", input, snap, mode, base, baseRef, ...(maintDropped ? { maintDropped } : {}) };
}

export async function runOpusReview(db: Db, params: OpusParams, log: (line: string) => void = console.log, deps: OpusDeps = defaultOpusDeps()): Promise<OpusSummary> {
  const { repo } = params;
  const runId = `opus-review-${repo}-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  let cands = await selectOpusCandidates(db, repo);
  const uncapped = await staleReviews(db, repo, true);
  const allStale = await staleReviews(db, repo);
  const capped = [...allStale].filter((k) => !uncapped.has(k));
  if (capped.length) log(`opus-review ${repo}: ${capped.join(", ")} not reviewed again: already ${MAX_RERUNS_PER_DAY} re-reviews today after new discussion`);
  const summary: OpusSummary = { runId, repo, candidates: cands.length, reviewed: 0, dropped: 0, verdicts: {}, missing: [], skipped: [] };
  cands = await takersCut(db, cands, params.limit, repo, (c) => c.number);
  if (params.dryRun || !cands.length) {
    log(`opus-review ${repo}: ${summary.candidates} candidates${params.dryRun ? "; dry run, nothing fetched or asked" : ""}`);
    return summary;
  }
  if (deps.querier) {
    // The mirror can be minutes behind: a PR closed, turned draft or pushed since selection returns as a candidate at its new head on a later pass.
    let live;
    try {
      live = await refreshChecks(db, deps.querier, repo, cands.map((c) => c.number), log);
    } catch (e) {
      log(`opus-review ${repo}: live state unavailable (${String((e as Error).message ?? e)}); nothing asked`);
      return summary;
    }
    const asked = cands.length;
    const holds = await reviewHolds(db);
    const byNumber = new Map(live.map((l) => [l.number, l]));
    cands = await filterSeq(cands, async (c) => {
      const l = byNumber.get(c.number);
      const ok = !!l && l.state === "OPEN" && !l.is_draft && l.head_oid === c.head_oid;
      // The checks were just read: a head whose CI is running or red waits for the next push or the finished run.
      const hold = ok ? await holds(c.repo, c.number, c.head_oid) : null;
      if (hold) { log(`  ${refOf(c)}: not reviewed, waits for ${hold.wait}`); return false; }
      if (!ok) log(`  ${refOf(c)}: dropped, ${l ? `now ${l.state}${l.is_draft ? " draft" : ""} at ${l.head_oid.slice(0, 7)}` : "not found on GitHub"}`);
      return ok;
    });
    summary.dropped = asked - cands.length;
    await ensurePipelineLogin(db, deps.querier).catch(() => {});
    if (!cands.length) return summary;
  }
  let handled = 0;
  const tally = async (c: { repo: string; number: number }, r: OpusReview) => { summary.verdicts[r.verdict] = (summary.verdicts[r.verdict] ?? 0) + 1; summary.reviewed++; await jobItem(db, c.repo, c.number, `Opus review: ${r.verdict}${r.sure ? "" : " (unsure)"}`, log); };
  await pool(cands.map((c) => async () => {
    const start = now();
    const p = await prepareOpusInput(db, repo, c, deps, log);
    if (p.kind === "no-diff") {
      await jobItem(db, c.repo, c.number, `no diff: ${p.error}`, log);
      summary.skipped.push(refOf(c));
      return;
    }
    if (p.kind === "large") {
      const r: OpusReview = { ref: refOf(c), verdict: "hold", sure: true, reason: TOO_LARGE, fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: [] };
      await saveOpus(db, runId, c, { mode: p.mode, base: p.base, baseRef: p.baseRef, model: null, review: r });
      await tally(c, r);
      params.onHandled?.(++handled);
      return;
    }
    if (p.kind === "no-threads") {
      log(`  ${refOf(c)}: review threads unavailable (${p.error}); not reviewed this pass`);
      summary.skipped.push(refOf(c));
      return;
    }
    const { input, snap, mode, base, baseRef } = p;
    const checkout = (await deps.checkout?.(repo, c.number, c.head_oid)) ?? undefined;
    if (checkout) input.repo_dir = REPO_PATH;
    const dir = referenceDir(repo);
    const semantic = dir ? deps.semantic ?? defaultSemanticDeps(db, input.ref) : undefined;
    const r = await runModelStep(db, REVIEW_OPUS, input, {
      model: deps.model, checkout, reference: checkout ? dir : undefined, ctx: { dir, semantic, checkout },
      usage: { run: runId, agent: `opus-${refOf(c).replace("#", "-")}`, stage: "review", items: (ok) => (ok ? 1 : 0) },
      onReply: (reply) => {
        if (reply.fixTurn) log(`  ${refOf(c)}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`);
        else if (reply.problems?.length) log(`  ${refOf(c)}: reply lint: ${reply.problems.length} problems, no fix turn possible`);
      },
    });
    let got: OpusReview | null = r.ok ? r.value.review : null;
    const gotText = r.ok ? r.value.text : "";
    if (got) {
      // The outcome is read from the uncut reason, as the lint does.
      const outcomes = (input.unapplied_fixes ?? []).map((u) => ({ ...u, outcome: carriedOutcome({ ...got!, reason: rawReason(gotText) ?? got!.reason }, u) }));
      // A take that neither made nor explained an earlier fix goes to a person before it can merge.
      if (got.verdict === "take") {
        const risks = outcomes.filter((u) => u.outcome === "unaddressed").map((u) => `an earlier fix was neither made nor explained: ${u.file}: ${u.change.length > 100 ? `${u.change.slice(0, 100)}...` : u.change}`);
        if (risks.length) got = { ...got, sure: false, risks: [...got.risks, ...risks] };
      }
      // A maintainer's word the model was not shown leaves the take to a person.
      if (p.maintDropped && got.sure && (got.verdict === "take" || got.verdict === "take-fix")) got = { ...got, sure: false, risks: [...got.risks, "a maintainer's comment was left out of the review for length"] };
      await saveOpus(db, runId, c, { mode, base, baseRef, model: (r.ok && r.model) || deps.model, review: got, snap, unapplied: outcomes });
      await tally(c, got);
    } else {
      await recordReviewFailure(db, c.repo, c.number, c.head_oid);
      await jobItem(db, c.repo, c.number, "no valid Opus review", log);
      summary.missing.push(refOf(c));
    }
    params.onHandled?.(++handled);
  }), poolRoom(db, (i) => [cands[i]!.repo], (i) => [cands[i]!]));
  log(`opus-review ${repo}: ${summary.reviewed} reviewed (${Object.entries(summary.verdicts).map(([v, k]) => `${k} ${v}`).join(", ")}); ${summary.skipped.length} without a diff, ${summary.missing.length} without an answer`);
  return summary;
}


export const commands = {
  "opus-review": {
    summary: "opus-review --repo R [--limit N] [--dry-run]: Opus code review of wanted PRs, one verdict per head commit",
    async run(args: string[]): Promise<void> {
      const f: Record<string, string | true> = {};
      for (let i = 0; i < args.length; i++) {
        const n = args[i]!.replace(/^--/, "");
        if (!["repo", "limit", "dry-run"].includes(n)) throw new Error(`unknown option ${args[i]}; options: --repo --limit --dry-run`);
        if (n === "dry-run") f[n] = true;
        else {
          const v = args[++i];
          if (v === undefined) throw new Error(`--${n} needs a value`);
          f[n] = v;
        }
      }
      if (typeof f.repo !== "string") throw new Error("missing --repo");
      const limit = typeof f.limit === "string" ? Number(f.limit) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit is a positive whole number");
      const { connect } = await import("../db.ts");
      await runOpusReview(await openDb(), { repo: f.repo, limit, dryRun: f["dry-run"] === true });
    },
  },
};
