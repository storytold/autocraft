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
import { recordReviewFailure, reviewHolds } from "./gate.ts";
import { MAX_RERUNS_PER_DAY, discussionOf, ensurePipelineLogin, liveDiscussion, staleReviews, withRetry, type Snapshot } from "./discussion.ts";
import type { By } from "../core/gates.ts";
import { laneMismatch, notDue, planNow } from "../core/select.ts";
import { recordLiveBase } from "../merge/base.ts";
import { relatedOpen, latestReview } from "../postmerge/related.ts";
import type { DiscussionEntry } from "./parse.ts";
import { changedHunks, reviewAfterBaseMerge, sameOwnDiff } from "./own-diff.ts";
import { MAX_DIFF_CHARS, cachedDiff, cachedDiffBase, codeDiff, ghDelta, ghDiff, splitDiff, type DeltaFetcher, type DiffFetcher } from "./diff.ts";
import { roundOwnDiffs, type OwnDiffReader } from "./round-diff.ts";
import { CARRIED } from "./carry.ts";
import { selectOpusCandidates, type OpusCandidate } from "./opus-candidates.ts";
import { carriedOutcome, rawReason, type EarlierOpus, type OpusPr, type OpusReview, type UnappliedFix } from "./opus-parse.ts";
import { ourCommitsSince } from "./ours.ts";
import { relatedStatements } from "../memory/retrieve.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, type SemanticDeps } from "../reference-lint.ts";
import { jobItem } from "../runner/job-items.ts";
import { leaseItem } from "../runner/leases.ts";
import { filterSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { loadOwnDeltas, loadPatchFacts } from "../data/changes/index.ts";
import { loadChecks, loadItems, loadRepos } from "../data/mirror/index.ts";
import { optionalChecksOf } from "../optional-checks.ts";
import { checkList } from "../core/facts.ts";
import { loadReviewRows, loadReviewTexts, saveReviews, type ReviewRow } from "../data/review/index.ts";
import { mergeApprovedOf, ROUND_DELTA_LARGE, ROUND_UNSEPARATED, roundHeadOf } from "../core/author-round.ts";
import { loadGoOnAt, loadPrWorkflows } from "../data/workflow/index.ts";
import { settledBy } from "../core/settled.ts";
import type { ItemWorkflow, PlanPart } from "../workflow/types.ts";
import { droppedReviewTitles } from "../workflow/work.ts";
import { fixesToMake } from "../core/review-blocking.ts";
import { loadBlockerReads, openFrom } from "./blockers.ts";

const PROMPT = CLAUDE_PROMPTS["review.opus"];
/** The required checks that fail at `head` (the same list the CI fix reads: facts.ts requiredAt); none when the stored checks are of another head. */
async function failingRequired(db: Db, repo: string, number: number, head: string): Promise<string[]> {
  const row = (await loadChecks(db, [{ repo, number }])).get(`${repo}#${number}`);
  if (row?.head_oid !== head) return [];
  const optional = (await optionalChecksOf(db))(repo);
  return checkList(row.checks).filter((x) => x.state === "failure" && !optional.includes(x.name)).map((x) => x.name);
}

export { MAX_DIFF_CHARS };
export const TOO_LARGE = "too large to review automatically";

export type OpusParams = {
  repo: string; limit?: number; dryRun?: boolean;
  /** Called with the running count of PRs handled. */
  onHandled?: (n: number) => void;
  /** Who asked; a command-line run is an operator's. */
  by?: By;
  /** Only PRs approved for merge (the step's approved job), or only the others; absent: every PR. */
  approved?: boolean;
  /** Only this PR. */
  number?: number;
};
export type OpusDeps = {
  /** Reads the live head and state of the candidates just before the model calls; absent: the mirror's view stands. */
  querier?: Querier;
  fetchDiff: DiffFetcher; fetchDelta: DeltaFetcher; model: string; maxChars: number;
  /** Host directory with a read-only checkout of the PR head for a sandboxed call, or null to ask without tools. Absent: no tools. */
  checkout?: (repo: string, number: number, head: string) => Promise<string | null>;
  /** The Jev and Haiku calls of the semantic reference check; absent: the real ones. */
  semantic?: SemanticDeps;
  /** The PR's own diffs at two heads, for the review round; absent: unavailable, so the round reviews the whole diff where it fits. */
  ownDiffs?: OwnDiffReader;
};
export type OpusSummary = {
  runId: string; repo: string; candidates: number; reviewed: number; dropped: number;
  verdicts: Record<string, number>; missing: string[]; skipped: string[];
  /** Unstarted PRs whose diff (or a duplicate) took them off the automatic path: no model call. */
  off: string[];
};

const now = () => new Date().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export function defaultOpusDeps(): OpusDeps {
  return { querier: new Client(500), fetchDiff: ghDiff, fetchDelta: ghDelta, model: PROMPT.models[0]!, maxChars: MAX_DIFF_CHARS, checkout: (r, n, h) => checkoutForPr(r, n, h, console.log), ownDiffs: roundOwnDiffs };
}

type Saved = { snap?: Snapshot; mode: "full" | "delta" | "carried"; base: string | null; model: string | null; review: OpusReview;
  /** The base branch the reviewed diff was read against (a delta or carried review: the earlier review's); absent: the cached diff's, else the mirrored base. */ baseRef?: string | null;
  /** A too-large hold: the diff size cap it was made under. */ sizeCap?: number };

/**
 * Stores the Opus row of a head commit, then a `reviewed` stages row and a take/hold/close
 * stages row (take-fix counts as take). A second review of the same head counts against
 * the PR's daily cap unless an operator or a merge-time check asked for it.
 * A review of the head against another base than the one before it voids what was decided for the old diff:
 * the pre-merge review and the verification.
 */
export async function saveOpus(db: Db, runId: string | null, c: { repo: string; number: number; head_oid: string }, s: Saved): Promise<void> {
  const r = s.review, ref = refOf(c);
  const baseRef = s.baseRef !== undefined ? s.baseRef : await reviewedBase(db, c);
  const [repos, blockers] = await Promise.all([
    loadRepos(db, { names: [c.repo] }),
    // Only open tracked items other than the PR can block it: a reference that is already closed would end the wait at once.
    r.verdict === "hold" ? openBlockerRefs(db, r.blocked_by.filter((x) => x !== ref)) : Promise.resolve([] as string[]),
  ]);
  await saveReviews(db, [{
    runId, repo: c.repo, number: c.number, head: c.head_oid, mode: s.mode, base: s.base, baseRef: baseRef ?? null, defaultBranch: repos.get(c.repo)?.default_branch ?? null,
    model: s.model, review: { verdict: r.verdict, sure: r.sure, reason: r.reason, fixes: r.fixes as never, risks: r.risks, workflow: (r.workflow ?? null) as never, summary: r.summary, why: r.why, public: r.public, conflicts: r.conflicts, claims: r.claims },
    ...(s.snap ? { snap: { seen: s.snap.seen, hash: s.snap.hash } } : {}), blockedBy: blockers, jobId: currentJobId(), ...(s.sizeCap !== undefined ? { sizeCap: s.sizeCap } : {}),
  }]);
}

/** The refs among `refs` that still block a hold. */
async function openBlockerRefs(db: Db, refs: string[]): Promise<string[]> {
  return openFrom(await loadBlockerReads(db, refs), refs);
}

/** The Opus review of the PR's latest earlier head that a model wrote (not a too-large hold), for the delta. */
export async function earlierOpus(db: Db, c: { repo: string; number: number; head_oid: string }, skip = 0): Promise<EarlierOpus | null> {
  const o = earlierRows(await loadReviewRows(db, [{ repo: c.repo, number: c.number }]), c)[skip];
  return o ? earlierOf(o) : null;
}

/** The PR's reviews of other heads that a model wrote (not a too-large hold), newest first. */
const earlierRows = (rows: Map<string, ReviewRow[]>, c: { repo: string; number: number; head_oid: string }): ReviewRow[] =>
  (rows.get(`${c.repo}#${c.number}`) ?? []).filter((r) => r.head !== c.head_oid && r.model !== null);

const earlierOf = (o: ReviewRow): EarlierOpus => ({ head: o.head, verdict: o.verdict, sure: o.sure, reason: o.reason ?? "", fixes: o.fixes as EarlierOpus["fixes"] });

/**
 * The fixes of the PR's latest earlier reviewed head, when that review was a take-fix whose fixes were never pushed
 * and never posted as a comment (a conflict merge of ours or an author push made a new head first). `plan`: its workflow's; a part a person
 * dropped from it is left out, and so, on a PR approved for merge (`approved`), is a fix that does not block it (it is filed, not made).
 */
export async function unappliedFixes(db: Db, c: { repo: string; number: number; head_oid: string }, rows?: Map<string, ReviewRow[]>, plan: readonly PlanPart[] = [], approved = false): Promise<UnappliedFix[]> {
  // A hold in between (an author push the reviewer could not judge) does not make the older take-fix's fixes moot.
  const [first, second] = earlierRows(rows ?? await loadReviewRows(db, [{ repo: c.repo, number: c.number }]), c);
  const e = first && first.verdict === "hold" ? second : first;
  if (!e || e.verdict !== "take-fix") return [];
  const facts = (await loadPatchFacts(db, [{ repo: c.repo, number: c.number }])).get(refOf(c));
  if (facts?.fixups.some((f) => f.fromHead === e.head && (f.state === "pushed" || f.state === "asked"))) return [];
  const asked = e.fixes.filter((f) => typeof f?.file === "string" && !!f.file.trim() && typeof f.change === "string");
  return fixesToMake(asked, droppedReviewTitles(plan), approved).map((f) => ({ head: e.head, file: f.file, change: f.change }));
}

/** The base branch the review's diff was computed against; the mirrored base when the cached diff does not say. */
async function reviewedBase(db: Db, c: { repo: string; number: number; head_oid: string }): Promise<string | null> {
  return cachedDiffBase(c.repo, c.number, c.head_oid) ?? (await loadItems(db, [{ repo: c.repo, number: c.number }], "pr")).get(refOf(c))?.base_ref ?? null;
}

/** A review recorded at a head without a model call: what it says, the head it was carried from, and the discussion mark of that review. */
export type RoundCarry = { review: OpusReview; from: string; baseRef: string | null; snap: Snapshot };

/**
 * The review the round's head takes over without a model call: the author's push left the PR's own diff as the latest earlier review read it
 * (a merge of the base branch, a rebase), so that sure take or take-fix carries to the head with its fixes, as over our own merge of the base
 * branch (carry.ts). Null when it does not carry: no round, no such review, a review stale for new discussion (`stale`: "repo#n@head"), another
 * base branch, the own diffs not readable (`ownDiffs`), or the head's diff not readable.
 */
export async function roundCarry(db: Db, c: OpusCandidate, deps: Pick<OpusDeps, "fetchDiff" | "ownDiffs">, stale: ReadonlySet<string>): Promise<RoundCarry | null> {
  const { repo, number } = c, ref = refOf(c);
  const [workflows, stored, items, repos] = await db.together(() => Promise.all([
    loadPrWorkflows(db, [{ repo, number }]), loadReviewRows(db, [{ repo, number }]), loadItems(db, [{ repo, number }], "pr"), loadRepos(db, { names: [repo] }),
  ]));
  const wf = workflows.get(ref);
  if (!wf || (stored.get(ref) ?? []).some((r) => r.head === c.head_oid) || !await roundHeadOf(db, c)) return null;
  // A PR a person sent to merge without a review carries only a review made after they did.
  const since = wf.entry === "merge" ? (await loadGoOnAt(db, [wf])).get(wf.id)!.since : null;
  const e = earlierRows(stored, c)[0];
  if (!e || (since !== null && e.at <= since) || !e.sure || (e.verdict !== "take" && e.verdict !== "take-fix") || stale.has(`${ref}@${e.head}`)) return null;
  const baseRef = e.base_ref ?? repos.get(repo)?.default_branch ?? null, liveBase = items.get(ref)?.base_ref ?? null;
  if (baseRef && liveBase && baseRef !== liveBase) return null;
  const branch = liveBase ?? baseRef;
  if (!branch || !deps.ownDiffs) return null;
  const own = await deps.ownDiffs(repo, number, branch, e.head, c.head_oid);
  if (!own.ok || !sameOwnDiff(own.before, own.after)) return null;
  // The head's diff is read as for any review: its facts are what the merge rule reads, and a PR GitHub cannot show is not carried to a merge.
  const d = await cachedDiff(db, repo, number, c.head_oid, deps.fetchDiff, liveBase);
  if (!d.ok || (d.base && baseRef && d.base !== baseRef)) return null;
  const texts = (await loadReviewTexts(db, [{ repo, number, head: e.head }])).get(`${ref}@${e.head}`);
  return {
    review: {
      ref, verdict: e.verdict, sure: true, fixes: e.fixes as OpusReview["fixes"], risks: e.risks, conflicts: e.conflicts as unknown as OpusReview["conflicts"], claims: [], blocked_by: [], public: null,
      summary: texts?.summary ?? null, why: texts?.why ?? null,
      reason: `carried from ${e.head.slice(0, 7)}: the author's push left the PR's own diff unchanged`,
    },
    from: e.head, baseRef, snap: { seen: e.seen_at ?? e.at, hash: e.disc_hash },
  };
}

/** `base`: the earlier head a delta was read from; `baseRef`: the base branch the whole PR diff was read against. */
export type PreparedOpus =
  | { kind: "no-diff"; error: string }
  | { kind: "off"; why: string }
  | { kind: "large"; mode: "full" | "delta"; base: string | null; baseRef: string | null; /** Why, when it is not the whole PR's size (the review round's). */ reason?: string }
  | { kind: "no-threads"; error: string }
  | { kind: "ready"; input: OpusPr; snap: Snapshot; mode: "full" | "delta"; base: string | null; baseRef: string | null; /** A maintainer's entry was left out of the discussion for length. */ maintDropped?: boolean };

/** The person's decision that the change belongs in the app (core settledBy), as the prompt input carries it. */
export function scopeSettled(w: ItemWorkflow | undefined): { scope_settled?: NonNullable<OpusPr["scope_settled"]> } {
  const by = settledBy(w);
  return by ? { scope_settled: { ...by, note: null } } : {};
}

/**
 * Builds the Opus prompt input of a candidate: diff (full, or the delta since the last Opus review),
 * size cap and discussion. `independent`: the whole diff with no earlier review, discussion or unapplied fixes, for a
 * review that must not be anchored on the first one (the pre-merge review); the snapshot then marks the time of the read.
 * `off`: asked once the diff is read and its facts are stored, why the review is no longer wanted.
 */
export async function prepareOpusInput(db: Db, repo: string, c: OpusCandidate, deps: OpusDeps, log: (line: string) => void, opts: { independent?: boolean; off?: () => Promise<string | null> } = {}): Promise<PreparedOpus> {
  const ref = refOf(c);
  const [items, stored, repos, workflows] = await db.together(() => Promise.all([
    loadItems(db, [{ repo, number: c.number }], "pr"), loadReviewRows(db, [{ repo, number: c.number }]), loadRepos(db, { names: [repo] }),
    loadPrWorkflows(db, [{ repo, number: c.number }]),
  ]));
  // A PR a person sent to merge without a review is reviewed for what came after: what they went past is no base of it.
  const wf = workflows.get(ref);
  const since = wf?.entry === "merge" ? (await loadGoOnAt(db, [wf])).get(wf.id)!.since : null;
  const rows = since === null ? stored : new Map([...stored].map(([k, rs]) => [k, rs.filter((r) => r.at > since)]));
  const liveBase = items.get(ref)?.base_ref;
  const scope = scopeSettled(workflows.get(ref));
  const d = await cachedDiff(db, repo, c.number, c.head_oid, deps.fetchDiff, liveBase);
  if (!d.ok) return d.tooLarge ? { kind: "large", mode: "full", base: null, baseRef: liveBase ?? null } : { kind: "no-diff", error: d.error };
  const baseRef = d.base ?? liveBase ?? null;
  // The read saw the PR's live base: the mirror takes it at once, so the review is not compared with a base the next sync would replace.
  if (d.base && liveBase !== undefined && d.base !== liveBase) await recordLiveBase(db, repo, c.number, c.head_oid, d.base, { by: "opus-review", keepDiff: true });
  const why = await opts.off?.();
  if (why) return { kind: "off", why };
  const ch = await checksOf(db, repo, c.number);
  // Test files are shown while they fit the size cap; the merge rule sends a PR whose tests do not fit to a person.
  const cd = codeDiff(d.text, deps.maxChars);
  // The size cap applies to the whole PR, so a small push never lets a too-large PR through as a delta. In the review round the approver
  // accepted the rest, so there it applies to what the author's new commits changed.
  const fits = cd.text.length <= deps.maxChars && !(!cd.files.length && cd.testsOmitted.length);
  if (opts.independent) {
    if (!fits) return { kind: "large", mode: "full", base: null, baseRef };
    const input: OpusPr = {
      ref: refOf(c), title: c.title, body: c.body, author_association: c.author_association, size: c.size, lines_changed: c.lines_changed,
      ci: ch?.overall ?? "unknown", mergeable: ch?.mergeable ?? null, files: cd.files, tests_omitted: cd.testsOmitted, lockfiles_omitted: cd.lockfilesOmitted,
      mode: "full", earlier_opus: null, diff: cd.text,
      related_open: await relatedOpen(db, repo, c.number, cd.files), review_history: await latestReview(db, repo, c.number, c.head_oid),
    };
    return { kind: "ready", input: { ...input, statements: await relatedStatements(db, repo, c.number), ...scope }, snap: { seen: now(), hash: null }, mode: "full", base: null, baseRef };
  }
  let mode: "full" | "delta" = "full", diff = cd.text, base: string | null = null;
  // A delta stands on the earlier review only when that review read the PR against the same base branch; after a retarget the whole diff is reviewed.
  const priorRow = earlierRows(rows, c)[0];
  const prior = priorRow ? earlierOf(priorRow) : null;
  const priorBase = priorRow ? priorRow.base_ref ?? repos.get(repo)?.default_branch ?? null : null;
  const earlier = prior && (priorBase === null || baseRef === null || priorBase === baseRef) ? prior : null;
  // A merge commit of ours carries the base branch's changes since the earlier head, so a delta of the heads would show unrelated changes: the delta is taken between the PR's own diffs.
  const merged = (await loadOwnDeltas(db, [{ ref, toHead: c.head_oid }])).get(`${ref}@${c.head_oid}`);
  const accepted = await roundHeadOf(db, c);
  /** The review round's delta: whether the author's new commits were separated from the rest of the PR, and the files they touch. */
  let round: { separated: true; files: string[] } | { separated: false } | null = null;
  if (accepted && !merged) {
    // So does an author's merge of the base branch: the round reads what the PR's own diff gained and lost since the earlier review, or since
    // the approved head when none was made after it (a PR sent to merge without one).
    const from = earlier?.head ?? accepted;
    const branch = baseRef ?? repos.get(repo)?.default_branch ?? null;
    const own = !branch ? { ok: false as const, error: "the base branch is unknown" } : deps.ownDiffs ? await deps.ownDiffs(repo, c.number, branch, from, c.head_oid) : { ok: false as const, error: "no reader of the PR's own diffs" };
    if (own.ok) {
      const delta = changedHunks(own.before, own.after);
      round = { separated: true, files: splitDiff(delta).map((f) => f.path) };
      const dd = delta ? codeDiff(delta, deps.maxChars) : null;
      if (dd && (dd.text.length > deps.maxChars || (dd.testsOmitted.length && !fits))) return { kind: "large", mode: "delta", base: from, baseRef, reason: ROUND_DELTA_LARGE };
      // A delta whose test files do not all fit is not used: the full diff shows them. An empty one (the own diff unchanged) leaves the full diff.
      if (dd && !dd.testsOmitted.length) { mode = "delta"; diff = dd.text; base = from; }
    } else {
      log(`  ${ref}: the author's commits since ${from.slice(0, 7)} could not be separated (${own.error}); full diff`);
      round = { separated: false };
    }
    if (mode === "full" && !fits) return { kind: "large", mode: "full", base: null, baseRef, ...(round.separated ? {} : { reason: ROUND_UNSEPARATED }) };
  } else if (!fits) return { kind: "large", mode: "full", base: null, baseRef };
  else if (earlier && !merged) {
    const delta = await deps.fetchDelta(repo, earlier.head, c.head_oid);
    // A delta whose test files do not all fit is not used: the full diff shows them.
    const dd = delta.ok ? codeDiff(delta.text, deps.maxChars) : null;
    if (dd && !dd.testsOmitted.length) { mode = "delta"; diff = dd.text; base = earlier.head; }
    else if (!delta.ok) log(`  ${refOf(c)}: delta since ${earlier.head.slice(0, 7)} unavailable (${delta.error}); full diff`);
  } else if (earlier && merged?.ownDelta && reviewAfterBaseMerge(merged.ownDiff) === "delta" && merged.fromHead === earlier.head && earlier.sure && (earlier.verdict === "take" || earlier.verdict === "take-fix")) {
    // The delta was computed from the local commits when the merge was made; the diff of the earlier head is never fetched by number.
    const dd = codeDiff(merged.ownDelta, deps.maxChars);
    if (dd.text && !dd.testsOmitted.length) { mode = "delta"; diff = dd.text; base = earlier.head; }
  }
  if (diff.length > deps.maxChars) return { kind: "large", mode, base, baseRef };
  let discussion: DiscussionEntry[], snap: Snapshot, maintDropped: boolean;
  try {
    // What the PR's previous review read is not lost to the budget silently: only maintainers' words since then must fit.
    const latest = rows.get(ref)?.[0];
    const since = latest ? latest.seen_at ?? latest.at : "";
    ({ entries: discussion, snap, maintDropped } = await discussionOf(db, repo, c.number, deps.querier ? await withRetry(() => liveDiscussion(deps.querier!, db, repo, c.number)) : undefined, since));
  } catch (e) {
    return { kind: "no-threads", error: String((e as Error).message ?? e) };
  }
  const mergeApproved = await mergeApprovedOf(db, c);
  const failing = ch?.overall === "failure" ? await failingRequired(db, repo, c.number, c.head_oid) : [];
  const unapplied = await unappliedFixes(db, c, rows, workflows.get(ref)?.plan, mergeApproved);
  // Our own commits since the earlier reviewed head, for the reviewer to check against what was asked of them.
  const ours = earlier ? (await ourCommitsSince(db, repo, c.number, earlier.head, c.head_oid)).commits.map(({ from: _from, ...x }) => x) : [];
  const input: OpusPr = {
    ref: refOf(c), title: c.title, body: c.body, author_association: c.author_association, size: c.size, lines_changed: c.lines_changed,
    ci: ch?.overall ?? "unknown", ...(failing.length ? { failing_checks: failing } : {}), mergeable: ch?.mergeable ?? null, files: cd.files, tests_omitted: cd.testsOmitted, lockfiles_omitted: cd.lockfilesOmitted,
    mode, earlier_opus: mode === "delta" ? earlier : null, ...(unapplied.length ? { unapplied_fixes: unapplied } : {}),
    ...(accepted ? { author_commits: { approved_head: accepted, new_head: c.head_oid, ...(round ?? {}) } } : {}),
    ...(ours.length ? { pipeline_commits: ours } : {}), ...(mergeApproved ? { merge_approved: true } : {}), diff, discussion,
    related_open: await relatedOpen(db, repo, c.number, cd.files),
    statements: await relatedStatements(db, repo, c.number), ...scope,
  };
  return { kind: "ready", input, snap, mode, base, baseRef, ...(maintDropped ? { maintDropped } : {}) };
}

export async function runOpusReview(db: Db, params: OpusParams, log: (line: string) => void = console.log, deps: OpusDeps = defaultOpusDeps()): Promise<OpusSummary> {
  const { repo } = params;
  const runId = `opus-review-${repo}-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  let cands = await selectOpusCandidates(db, repo, undefined, params.by, params.approved);
  if (params.number !== undefined) cands = cands.filter((c) => c.number === params.number);
  const uncapped = await staleReviews(db, repo, true);
  const allStale = await staleReviews(db, repo);
  const capped = [...allStale].filter((k) => !uncapped.has(k));
  if (capped.length) log(`opus-review ${repo}: ${capped.join(", ")} not reviewed again: already ${MAX_RERUNS_PER_DAY} re-reviews today after new discussion`);
  const summary: OpusSummary = { runId, repo, candidates: cands.length, reviewed: 0, dropped: 0, verdicts: {}, missing: [], skipped: [], off: [] };
  if (!params.dryRun) {
    // An author's push that left the PR's own diff as reviewed, in the review round, keeps that review: no model call and no Task Runner.
    const carried = new Set<number>();
    for (const c of cands) {
      const k = await roundCarry(db, c, deps, allStale);
      if (!k) continue;
      await saveOpus(db, runId, c, { mode: CARRIED, base: k.from, baseRef: k.baseRef, model: CARRIED, review: k.review, snap: k.snap });
      await jobItem(db, c.repo, c.number, `carried review: ${k.review.reason}`, log);
      carried.add(c.number);
    }
    cands = cands.filter((c) => !carried.has(c.number));
  }
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
    const holds = await reviewHolds(db, Date.now(), cands.map(refOf));
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
  /**
   * A job of one lane (src/runner/concurrency.ts) reviews a PR under the step's lease, and only while it is still due at the head and in
   * the job's lane: the other lane's job of the repo may have reviewed it, or a maintainer approved it, since this job picked it.
   */
  const inLane = async (c: OpusCandidate, fn: () => Promise<void>): Promise<void> => {
    if (params.approved === undefined) return await fn();
    const release = await leaseItem(db, `review:${refOf(c)}`, log);
    if (!release) return;
    try {
      const p = await planNow(db, repo, c.number);
      const why = notDue(p, "review", c.head_oid) ?? laneMismatch(p!.facts, params.approved);
      if (why) { await jobItem(db, c.repo, c.number, `not reviewed: ${why}`, log); return; }
      await fn();
    } finally { await release(); }
  };
  await pool(cands.map((c) => async () => await inLane(c, async () => {
    const p = await prepareOpusInput(db, repo, c, deps, log, c.auto ? { off: async () => notDue(await planNow(db, repo, c.number), "review", c.head_oid) } : {});
    if (p.kind === "off") {
      await jobItem(db, c.repo, c.number, `not reviewed: ${p.why}`, log);
      summary.off.push(refOf(c));
      params.onHandled?.(++handled);
      return;
    }
    if (p.kind === "no-diff") {
      await jobItem(db, c.repo, c.number, `no diff: ${p.error}`, log);
      summary.skipped.push(refOf(c));
      return;
    }
    if (p.kind === "large") {
      const r: OpusReview = { ref: refOf(c), verdict: "hold", sure: true, reason: p.reason ?? TOO_LARGE, fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: [] };
      await saveOpus(db, runId, c, { mode: p.mode, base: p.base, baseRef: p.baseRef, model: null, review: r, sizeCap: deps.maxChars });
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
    input.workflow = true;
    const dir = referenceDir(repo);
    const semantic = dir ? deps.semantic ?? defaultSemanticDeps(db, input.ref) : undefined;
    const r = await runModelStep(db, REVIEW_OPUS, input, {
      model: deps.model, checkout, reference: checkout ? dir : undefined, ctx: { dir, semantic },
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
      await saveOpus(db, runId, c, { mode, base, baseRef, model: (r.ok && r.model) || deps.model, review: got, snap });
      await tally(c, got);
    } else {
      // A call lost with its Task Runner, or to an outage, says nothing about the PR: it counts apart and never holds the PR for a person.
      const lost = !r.ok && r.lost === true;
      await recordReviewFailure(db, c.repo, c.number, c.head_oid, Date.now(), lost);
      await jobItem(db, c.repo, c.number, lost ? "no Opus review: the call ended without a reply" : "no valid Opus review", log);
      summary.missing.push(refOf(c));
    }
    params.onHandled?.(++handled);
  })), poolRoom(db, (i) => [cands[i]!.repo], (i) => [cands[i]!]));
  log(`opus-review ${repo}: ${summary.reviewed} reviewed (${Object.entries(summary.verdicts).map(([v, k]) => `${k} ${v}`).join(", ")}); ${summary.skipped.length} without a diff, ${summary.off.length} off the automatic path, ${summary.missing.length} without an answer`);
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
      await runOpusReview(await openDb(), { repo: f.repo, limit, dryRun: f["dry-run"] === true });
    },
  },
};
