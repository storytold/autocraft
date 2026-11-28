// Stage 6, Integrate (fix-ups): for a take-fix PR we may push to, Sonnet turns
// the review's fix list into a unified diff, our code validates and applies
// it on top of the reviewed head, and the result is pushed to the
// contributor's branch. The new head gets reviewed again by the Review stage.
//
//   autocraft-server fixup --repo R [--limit N] [--apply]
//   autocraft-server fixup repost R#N [--apply]
//   autocraft-server push-approval [--repo R]
//
// Without --apply it is a dry run: local tables only, nothing called or written.
// The checkout is untrusted data: nothing from it is ever run (see git.ts).
import { queuedOperatorFix } from "../preapproval/state.ts";
import { commitIdentity, ownLogins, type CommitIdentity } from "../github/identity.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askClaude } from "../classify/run.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { audit } from "../dash/audit.ts";
import { withNote } from "../github/note.ts";
import { CLI_BY, type By, type Want } from "../core/gates.ts";
import { guard, guardClaim, guardRepo, liveOf } from "../core/guard.ts";
import { ghAskComment, ghComment, ghEditComment, pushBranch, type Note, type Writer } from "../github/write.ts";
import { loadAuditActions, loadStepApprovals, loadTrackedRepos } from "../data/control/index.ts";
import { finishPatch, loadPatchFacts, recordPushing, storePatch } from "../data/changes/index.ts";
import { applyLocal, loadItems, loadPrMirror } from "../data/mirror/index.ts";
import { loadReviewsAt } from "../data/review/index.ts";
import { dropUnlistedPatches } from "../prepush/drop.ts";
import { Client, type Querier } from "../mirror.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { patchGiveaway, QUIET_PATCH_REFUSAL } from "../security/rules.ts";
import { cachedDiff, ghDiff, type DiffFetcher } from "../review/diff.ts";
import { checkoutDiff } from "./diff-view.ts";
import { checkLine, parseCheck, recordCheck } from "../patchcheck/index.ts";
import { CHECK_DIFF_CAP, CHECK_PATCH_CAP, type FixupCheckInput } from "../patchcheck/types.ts";
import { CheckTool, applyCheck, refusal } from "../checktool/index.ts";
import { foldFormat, queueLintFor, readLint } from "../prepush/index.ts";
import { findingsWord, lintVerdict, testsNoteOf } from "../prepush/tests.ts";
import { dropSessions, SessionLedger, sessionAsk, storeSessions, sweepSessions, type SessionAsk } from "../prepush/resume.ts";
import { parseFixes, type FixCandidate } from "./candidates.ts";
import { onlyPr, selectFixups } from "./select.ts";
import { Git, exec, fixupDir, type Exec } from "./git.ts";
import { scrubGitError } from "../worker/patch.ts";
import { ensureAuthorWrites } from "./author-permission.ts";
import { longLivedOf, pushable } from "./pushable.ts";
import { claimForWork } from "../github/claim.ts";
import { askConflict, mergeConflict, newestOwnComment, type ConflictRun } from "./conflict.ts";
import { referenceDir } from "../reference.ts";
import { cleanReason } from "../act/templates.ts";
import { defaultSemanticDeps, referenceProblems } from "../reference-lint.ts";
import { dropTexts } from "../replylint.ts";
import { DIFF_CAP, buildScriptsAt, fixupEditable, operatorEditable, quotesText, splitChanges, validatePatch, type ConflictPr, type FixupPr } from "./patch.ts";
import { outsideShown, shownSize, viewFile } from "./excerpt.ts";
import { HOLD_CANNOT_PUSH, askText, commentText, commitMessage, fixupCommentEdited, fixupCommentLines, operatorCommentText } from "./template.ts";
import { jobItem } from "../runner/job-items.ts";
import { ownerOf } from "../owners.ts";
import { leaseItem } from "../runner/leases.ts";
import { isHalt, poolRoom, takersCut, takersFirst } from "../agents/call.ts";
import { pushesAreUnsettled } from "./unsettled.ts";
import { POOL_MAX, pool } from "../classify/run.ts";

export { MAX_ATTEMPTS, type FixCandidate, type FixSelection } from "./candidates.ts";
export { selectFixups } from "./select.ts";

const ACTOR = "fixup";
const PROMPT = CLAUDE_PROMPTS["fixup.patch"];
const CHECK = CLAUDE_PROMPTS["fixup.check"];
const CONFLICT = CLAUDE_PROMPTS["fixup.conflict"];
/** Characters of one file shown whole (a larger file is shown in part, and the part is held to the same limit), of all files shown, and of the PR diff; over any of them a PR without a checkout is held. With a checkout a longer diff is trimmed to DIFF_CAP (`checkoutDiff`). */
export const FILE_CAP = 40_000;
export const TOTAL_CAP = 120_000;
export { DIFF_CAP };

export type FixupDeps = {
  querier: Querier;
  /** Every git and gh command. */
  exec: Exec;
  fetchDiff: DiffFetcher;
  /** The model's reply to the fixup.patch prompt, or null when it gave none. */
  ask: (db: Db, input: FixupPr[], checkout?: string, tool?: CheckTool, session?: SessionAsk) => Promise<string | null>;
  /** The model's reply to the fixup.check prompt (Opus), or null when it gave none. */
  check: (db: Db, input: FixupCheckInput[], checkout?: string) => Promise<string | null>;
  /** The model's reply to the fixup.conflict prompt (Sonnet), or null when it gave none. Absent: conflicts are not resolved by a model. */
  resolve?: (db: Db, input: ConflictPr[], checkout?: string, session?: SessionAsk) => Promise<string | null>;
  /** Host directory with a read-only checkout of the PR head for the sandboxed model calls, or null to ask without tools. Absent: no tools. */
  checkout?: (repo: string, number: number, head: string) => Promise<string | null>;
  now: () => Date;
  /** Directory holding one bare cache repository per repo. */
  root: string;
  /** Stands in for the app lane's token and client (tests). */
  lane?: Pick<Writer, "mint" | "appClient">;
};

export function defaultDeps(): FixupDeps {
  return {
    querier: new Client(1000), exec, fetchDiff: ghDiff, now: () => new Date(), root: fixupDir(),
    ask: async (db, input, checkout, tool, session) => (await askClaude("fixup.patch", PROMPT.models[0]!, input, db, { checkout, check: tool, session }))?.text ?? null,
    check: async (db, input, checkout) => (await askClaude("fixup.check", CHECK.models[0]!, input, db, { checkout }))?.text ?? null,
    resolve: async (db, input, checkout, session) => (await askClaude("fixup.conflict", CONFLICT.models[0]!, input, db, { checkout, session }))?.text ?? null,
    checkout: (r, n, h) => checkoutForPr(r, n, h, console.log),
  };
}

export type FixupParams = {
  repo: string;
  limit?: number;
  /** Default true. */
  dryRun?: boolean;
  onHandled?: (n: number) => void;
  /** True when no new item should start (cancel, deadline, pipeline off). */
  stopping?: () => Promise<boolean>;
  /** Who asked; default: an operator at the command line. */
  by?: By;
  /** Only PRs approved for merge (the step's approved job), or only the others; absent: every PR. */
  approved?: boolean;
  /** Only this PR. */
  number?: number;
};
export type FixupSummary = {
  runId: string; repo: string; dryRun: boolean;
  pushed: string[]; asked: string[]; failed: { ref: string; reason: string }[]; held: { ref: string; reason: string }[];
};

const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
const refPair = (c: { repo: string; number: number }) => ({ repo: c.repo, number: c.number });
const short = (sha: string) => sha.slice(0, 7);
/** Reasons are shown on the dashboard: first line only, known directories and any absolute path removed. */
export function scrubReason(text: string, root: string): string {
  return scrubGitError(text, [root, homedir()]).replace(/(^|[\s"'(=:])\/[^\s"')]*/g, "$1<path>");
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

export const PR_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      id state isDraft headRefOid baseRefOid baseRefName headRefName maintainerCanModify mergeable
      headRepository { nameWithOwner }
      headRef { branchProtectionRule { id } }
      assignees(first: 10) { nodes { login } }
    }
  }
}`;

export type PrNode = {
  id: string; state: string; isDraft: boolean; headRefOid: string; baseRefOid?: string; baseRefName?: string; headRefName: string; maintainerCanModify: boolean; mergeable: string | null;
  headRepository: { nameWithOwner: string } | null; headRef?: { branchProtectionRule?: { id: string } | null } | null; assignees?: { nodes?: { login: string }[] };
};

/** The mergeable value stored for the PR at this head: the checks row's, or the item's; a conflict in either wins. */
async function storedMergeable(db: Db, repo: string, number: number, head: string): Promise<string | null> {
  const m = (await loadPrMirror(db, [{ repo, number }])).get(`${repo}#${number}`);
  const c = m?.checks?.head_oid === head ? m.checks.mergeable : null, i = m?.item.head_oid === head ? m.item.mergeable : null;
  return c === "CONFLICTING" || i === "CONFLICTING" ? "CONFLICTING" : c ?? i;
}

/**
 * Writes what the live read found into the mirror, as the checks sync would, so a PR the live read shows is no candidate
 * (conflicting, closed, a draft, head moved) is not selected again until the checks data changes.
 */
export async function noteLive(db: Db, repo: string, number: number, pr: PrNode | null | undefined, at: string): Promise<void> {
  if (!pr) return;
  await applyLocal(db, [{ kind: "live", repo, number, at, pr: { head: pr.headRefOid, state: pr.state, draft: pr.isDraft, mergeable: pr.mergeable ?? "UNKNOWN", maintainerCanModify: pr.maintainerCanModify } }]);
}

import { pipelineAccount, type Who } from "../github/pipeline-account.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
export type { Who };

/** The Plan action's source of a candidate. */
const sourceOf = (c: FixCandidate): string => c.source ?? "review";

export const whoAmI = (run: Exec): Promise<Who> => pipelineAccount(run);

class Recorder {
  private db: Db;
  private at: () => string;
  constructor(db: Db, at: () => string) {
    this.db = db;
    this.at = at;
  }

  /** Written before the push: the commit about to be pushed, so a crash between the push and its record leaves the head in the push chain. */
  async pushing(c: FixCandidate, commit: string, files: string[]): Promise<void> {
    await recordPushing(this.db, { kind: "fixup", repo: c.repo, number: c.number, head: c.head, commit, files, attempt: c.attempt, source: c.source, operatorFix: c.operator?.id ?? null, storedId: c.lint?.rowid, at: this.at() });
  }

  /** The model patch waits for its lint task: a first row, or the same row with the next round's patch and task. */
  async linting(c: FixCandidate, patch: string, files: string[], task: number, lintState: "pending" | "requeued", round: number, session: string | null, changes: string[] = []): Promise<void> {
    await storePatch(this.db, { kind: "fixup", storedId: c.lint?.rowid, repo: c.repo, number: c.number, head: c.head, patch, files, lintTask: task, lintRound: round, lintState, session, changes, source: c.source, operatorFix: c.operator?.id ?? null, attempt: c.attempt, at: this.at() });
  }

  /** Stored patches whose Plan no longer lists the push (head moved, a Hold or Close answer, approval revoked) are dropped. */
  async dropUnlisted(repo: string, listed: number[]): Promise<void> {
    await dropUnlistedPatches(this.db, "fixup", repo, new Set(listed));
  }

  /** A fixups row and a stages row: `hold` for the two states that need a person, else the PR's `take` stage with a note. */
  async fixup(c: FixCandidate, state: "pushed" | "failed" | "refused" | "rejected" | "superseded" | "cannot-push" | "too-large" | "asked" | "comment-failed" | "comment-unsent" | "push-denied", reason: string | null, files: string[], toHead: string | null = null): Promise<void> {
    const at = this.at();
    const hold = state === "cannot-push" || state === "too-large" || state === "push-denied";
    const note = state === "pushed" ? `fix-up pushed at ${short(c.head)}: ${files.join(", ")}${reason ? `; ${reason}` : ""}`
      : state === "asked" ? `asked the contributor for changes at ${short(c.head)}: ${files.join(", ")}` : `fix-up ${state} at ${short(c.head)}: ${reason}`;
    await finishPatch(this.db, {
      kind: "fixup", repo: c.repo, number: c.number, head: c.head, state, reason, files, toHead, storedId: c.lint?.rowid, attempt: c.attempt, source: c.source, operatorFix: c.operator?.id ?? null, at,
      note: { repo: c.repo, number: c.number, stage: hold ? "hold" : "take", at, actor: ACTOR, note: hold ? reason : note }, jobNote: null,
    });
  }
}

export async function runFixup(db: Db, params: FixupParams, log: (line: string) => void = console.log, deps?: FixupDeps): Promise<FixupSummary> {
  const ledger = new SessionLedger();
  try {
    if (!(params.dryRun ?? true)) await sweepSessions(db, deps?.now() ?? new Date());
    return await runFixupWith(db, params, log, deps, ledger);
  } finally {
    ledger.release();
  }
}

async function runFixupWith(db: Db, params: FixupParams, log: (line: string) => void, deps: FixupDeps | undefined, ledger: SessionLedger): Promise<FixupSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const runId = `fixup-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  const gw: Writer = { db, login: ACTOR, ...deps?.lane };
  const summary: FixupSummary = { runId, repo, dryRun, pushed: [], asked: [], failed: [], held: [] };
  const sel = onlyPr(await selectFixups(db, repo, undefined, undefined, params.by, params.approved), params.number);
  const asks = await takersCut(db, sel.ask, params.limit, repo, (c) => c.number);
  // Stored patches whose lint task ended come first: they hold a model patch that is already paid for.
  const wanted = [...sel.lint, ...sel.fix];
  const budget = params.limit === undefined ? Infinity : Math.max(0, params.limit - asks.length);
  // A PR found conflicting live is skipped without using the limit, so the candidates behind it still get their turn.
  const picks = budget === 0 ? [] : budget < wanted.length ? await takersFirst(db, wanted, () => [repo], (c) => [{ repo, number: c.number }]) : wanted;
  const left = params.limit === undefined ? Infinity : Math.max(0, params.limit - asks.length - Math.min(budget, wanted.length));
  const cAsks = await takersCut(db, sel.conflictAsk, left === Infinity ? undefined : left, repo, (c) => c.number);
  const cMerges = sel.conflictMerge.slice(0, Math.max(0, left - cAsks.length));
  log(`fixup ${repo}: ${sel.conflictMerge.length} conflicted PRs to merge into, ${sel.conflictAsk.length} to ask`);
  log(`fixup ${repo}: ${sel.fix.length} PRs to fix up, ${sel.cannotPush.length + sel.ask.length} we can't push to`);
  if (dryRun) {
    for (const c of picks.slice(0, budget)) log(`  would fix up ${refOf(c)} at ${short(c.head)} (try ${c.attempt}): ${[...new Set(c.fixes.map((f) => f.file))].join(", ")}`);
    for (const c of asks) log(`  would comment the fixes on ${refOf(c)} at ${short(c.head)}`);
    for (const c of cMerges) log(`  would merge ${c.base} into ${refOf(c)} at ${short(c.head)} (try ${c.attempt})`);
    for (const c of cAsks) log(`  would ask the contributor of ${refOf(c)} to merge ${c.base}`);
    for (const c of sel.cannotPush) log(`  would hold ${refOf(c)}: ${HOLD_CANNOT_PUSH}`);
    log(`fixup ${repo}: dry run, nothing called or written`);
    return summary;
  }
  const d = deps ?? defaultDeps();
  const titles = new Map([...await loadItems(db, [...sel.lint, ...sel.fix].map(refPair), "card")].map(([k, r]) => [k, (r.title ?? "").slice(0, 300)]));
  const titleOf = (c: { repo: string; number: number }) => titles.get(refOf(c)) ?? "";
  const rec = new Recorder(db, at);
  await rec.dropUnlisted(repo, sel.listed);

  // Not approved for comments: no GitHub write, recorded once per head.
  for (const c of sel.cannotPush) {
    await rec.fixup(c, "cannot-push", HOLD_CANNOT_PUSH, []);
    summary.held.push({ ref: refOf(c), reason: HOLD_CANNOT_PUSH });
    log(`  ${refOf(c)}: held: ${HOLD_CANNOT_PUSH}`);
  }
  const handled = { n: 0 };
  const askOne = async (c: FixCandidate) => {
    const ref = refOf(c);
    try {
      const r = await d.querier.query(PR_QUERY, { owner: ownerOf(repo), name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const pr = r.repository?.pullRequest;
      await noteLive(db, repo, c.number, pr, at());
      if (!pr || pr.state !== "OPEN" || pr.isDraft) { log(`  ${ref}: skipped: no longer an open, non-draft PR`); return; }
      if (pr.headRefOid !== c.head) { log(`  ${ref}: skipped: head moved to ${short(pr.headRefOid)} since the review`); return; }
      if ((await loadQuiet(db, [`${repo}#${c.number}`])).size > 0) {
        // The review's fix list names what the fix protects against: a quiet pull request is never asked.
        const reason = "a quiet pull request is not asked for changes";
        await rec.fixup(c, "cannot-push", reason, []);
        summary.held.push({ ref, reason });
        log(`  ${ref}: held: ${reason}`);
        return;
      }
      const body = askText(c.fixes);
      const g = await guard(db, { repo, number: c.number }, { kind: "fixup", bucket: "ask", head: c.head, source: sourceOf(c) }, params.by ?? CLI_BY);
      if ("refused" in g) { log(`  ${ref}: not asked: ${g.refused}`); return; }
      const note: Note = { by: "model", kind: "comment", model: c.model };
      const earlier = await earlierAsk(db, repo, c.number, c.head);
      const cm = earlier
        ? (withNote(note, body) === earlier.text ? { code: 0, stdout: "", stderr: "" } : await ghEditComment(gw, g, d.exec, "fixup-comment-edit", { repo, number: c.number, commentId: earlier.id }, note, body, { run: runId, head: c.head }))
        : await ghAskComment(gw, d.exec, "fixup-comment", g, note, body, { run: runId, head: c.head });
      if (cm.code !== 0) {
        // Not sent: nothing reached GitHub, so the ask is tried again after a backoff. Otherwise GitHub may have posted it.
        const why = scrubReason(oneLine(cm.stderr), d.root), state = cm.sent === false ? "comment-unsent" : "comment-failed";
        await rec.fixup(c, state, why, []);
        log(`  ${ref}: comment ${state === "comment-unsent" ? "not sent" : "failed"}: ${why}`);
        return;
      }
      await rec.fixup(c, "asked", null, [...new Set(c.fixes.map((f) => f.file))]);
      params.onHandled?.(++handled.n);
      summary.asked.push(ref);
      await jobItem(db, repo, c.number, `asked the contributor for changes at ${short(c.head)}`, log);
    } catch (e) {
      log(`  ${ref}: not asked: ${oneLine(String((e as Error).message ?? e))}`);
    }
  };
  /** Runs `fn` on the PR under its lease, unless the run is stopping or another job holds it. */
  const leased = async (c: { number: number }, fn: () => Promise<void>): Promise<void> => {
    if (await params.stopping?.()) return;
    const release = await leaseItem(db, `pr:${repo}#${c.number}`, log);
    if (!release) return;
    try { await fn(); } finally { await release(); }
  };
  await pool(asks.map((c) => () => leased(c, () => askOne(c))), poolRoom(db, () => [repo], (i) => [{ repo, number: asks[i]!.number }]));
  const git = new Git(d.exec, d.root, repo);
  let whoP: Promise<Who> | undefined;
  let identP: Promise<CommitIdentity> | undefined;
  /** The author of our commits and comments here: the app's bot user on an app-lane repo, else the box account. */
  const ident = (): Promise<CommitIdentity> => (identP ??= commitIdentity(db, repo, () => (whoP ??= whoAmI(d.exec))));
  /** The stage starts work on a PR: the pipeline's account is assigned when nobody is. */
  const claim = async (c: { number: number }, want: Want): Promise<void> => {
    const g = await guardClaim(db, { repo, number: c.number }, want, params.by ?? CLI_BY);
    if ("refused" in g) { log(`  ${repo}#${c.number}: not assigned: ${g.refused}`); return; }
    await claimForWork(gw, g, d.querier, repo, c.number, "pr", async () => { const who = await (whoP ??= whoAmI(d.exec)); return { id: who.nodeId, login: who.login }; }, { run: runId }, log);
  };
  const conflictRun: ConflictRun = {
    ledger,
    repo, runId, log, d, gw, at, summary, prQuery: PR_QUERY, scrub: (raw) => scrubReason(raw, d.root), git: () => git,
    who: ident, onHandled: params.onHandled, handled, claim: (c) => claim(c, { kind: "conflict", bucket: "merge" }), by: params.by ?? CLI_BY,
  };
  await pool(cAsks.map((c) => () => leased(c, () => askConflict(db, conflictRun, c))), poolRoom(db, () => [repo], (i) => [{ repo, number: cAsks[i]!.number }]));
  if (!picks.length && !cMerges.length) return summary;

  const who = await ident();
  mkdirSync(d.root, { recursive: true });
  let worked = 0, stoppedLogged = false;
  let inflight = 0;
  let wake: (() => void)[] = [];
  /** Fix-up of one PR: takes one unit of the limit before its first await after the check, then its lease, so concurrent items count exactly. */
  const fixOne = async (c: FixCandidate): Promise<void> => {
    // While the limit is spent but other items are still running, one of them may give its unit back (not worked): wait for it.
    while (worked >= budget && inflight > 0) await new Promise<void>((r) => wake.push(r));
    if (await params.stopping?.()) { if (!stoppedLogged) { stoppedLogged = true; log(`fixup ${repo}: stopping, no new PRs started`); } return; }
    if (worked >= budget) return;
    // The item takes its budget before its next await; it is given back when the item ends without being worked.
    worked++;
    inflight++;
    let counted = false;
    const giveBack = () => {
      if (!counted) worked--;
      inflight--;
      const w = wake;
      wake = [];
      for (const r of w) r();
    };
    // Every exit before the lease is held, a throw included, gives the unit back here; after it, the finally below does.
    let release: (() => Promise<void>) | null = null;
    try {
      if (await pushesAreUnsettled(db, repo, log)) return;
      release = await leaseItem(db, `pr:${repo}#${c.number}`, log);
    } finally {
      if (!release) giveBack();
    }
    if (!release) return;
    const ref = refOf(c);
    let files = [...new Set(c.fixes.map((f) => f.file))];
    // The push is recorded: what fails after it (the comment) changes nothing about it.
    let pushed = false;
    const fail = async (state: "failed" | "refused" | "rejected" | "superseded", raw: string) => {
      const reason = scrubReason(raw, d.root);
      await rec.fixup(c, state, reason, files);
      summary.failed.push({ ref, reason });
      await jobItem(db, repo, c.number, `${state}: ${reason}`, log);
    };
    const hold = async (state: "cannot-push" | "too-large" | "push-denied", raw: string) => {
      const reason = scrubReason(raw, d.root);
      await rec.fixup(c, state, reason, files);
      summary.held.push({ ref, reason });
      await jobItem(db, repo, c.number, `held: ${reason}`, log);
    };
    try {
      const r = await d.querier.query(PR_QUERY, { owner: ownerOf(repo), name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const pr = r.repository?.pullRequest;
      await noteLive(db, repo, c.number, pr, at());
      if (!pr || pr.state !== "OPEN" || pr.isDraft) { log(`  ${ref}: skipped: no longer an open, non-draft PR`); return; }
      if (pr.headRefOid !== c.head) { log(`  ${ref}: skipped: head moved to ${short(pr.headRefOid)} since the review`); return; }
      // GitHub says UNKNOWN while it recomputes: the value stored at this head (kept by the mirror) decides.
      if (pr.mergeable === "CONFLICTING" || (pr.mergeable !== "MERGEABLE" && await storedMergeable(db, repo, c.number, c.head) === "CONFLICTING")) { log(`  ${ref}: skipped: conflicts with the base branch; the conflict merge handles it`); return; }
      counted = true;
      params.onHandled?.(++handled.n);
      const writes = pr.headRepository ? await ensureAuthorWrites(db, repo, c.number, pr.headRepository.nameWithOwner) : "no";
      if (writes === "unknown") { log(`  ${ref}: skipped: the author's permission could not be read yet`); return; }
      if (!pr.headRepository || !pushable(pr.headRepository.nameWithOwner, repo, pr.maintainerCanModify, pr.headRefName, await longLivedOf(db, repo), !!pr.headRef?.branchProtectionRule, writes === "yes")) {
        await hold("cannot-push", HOLD_CANNOT_PUSH);
        return;
      }
      const head = await git.fetchPr(ownerOf(repo), repo, c.number);
      if (head !== c.head) { log(`  ${ref}: skipped: fetched head ${short(head)} is not the reviewed ${short(c.head)}`); return; }
      const scripts = await buildScriptsAt(git, head);
      if (files.some((f) => !fixupEditable(f, scripts))) { await hold("too-large", "the fixes name files a fix-up may not edit"); return; }

      const diff = await cachedDiff(db, repo, c.number, head, d.fetchDiff);
      if (!diff.ok) { await fail("failed", `no diff: ${oneLine(diff.error)}`); return; }
      // An operator's fix-up may edit any file of the repository a fix-up may touch: the instructions name no file. The PR's own files are the ones shown.
      if (c.operator) {
        files = [...new Set([...diff.text.matchAll(DIFF_FILE)].map((m) => m[1]!))].filter((p) => operatorEditable(p, scripts));
      }
      // With a sandbox checkout the model reads the files itself, so they are listed by path and no size limit applies,
      // and a diff over the cap is shown as the named files' sections plus the other files by path.
      const checkout = (await d.checkout?.(repo, c.number, head)) ?? undefined;
      if (!checkout && diff.text.length > DIFF_CAP) {
        // A checkout that could not be made this time holds nothing: the next run tries again.
        if (d.checkout) { log(`  ${ref}: skipped: the PR diff is over the ${DIFF_CAP} character limit and there is no checkout; tried again later`); return; }
        await hold("too-large", `the PR diff is over the ${DIFF_CAP} character limit`);
        return;
      }
      // The model and the patch check read the same diff, within both their limits.
      const modelDiff = checkout ? checkoutDiff(diff.text, new Set(c.fixes.map((f) => f.file)), Math.min(DIFF_CAP, CHECK_DIFF_CAP)) : diff.text;
      const repoDir = checkout ? { repo_dir: REPO_PATH } : {};
      const quiet = (await loadQuiet(db, [`${repo}#${c.number}`])).size > 0;
      const shown: FixupPr["files"] = [];
      let total = 0, tooBig: string | null = null, bad: string | null = null;
      for (const path of files) {
        const f = await git.file(head, path);
        if (!f.ok) { bad = f.reason; break; }
        if (checkout) { shown.push({ path }); continue; }
        const v = viewFile(path, f.content, c.fixes.filter((x) => x.file === path).map((x) => x.change), diff.text, FILE_CAP);
        if (!v.ok) { tooBig = v.reason; break; }
        total += shownSize(v.file);
        if (total > TOTAL_CAP) { tooBig = `the files named in the fixes are over the ${TOTAL_CAP} character limit`; break; }
        shown.push(v.file);
      }
      if (bad) { await fail("refused", bad); return; }
      if (tooBig) { await hold("too-large", tooBig); return; }
      await claim(c, { kind: "fixup", bucket: "fix", source: sourceOf(c) });
      // A stored patch: the lint task's outcome decides whether it is pushed (clean), asked for again (findings) or queued again (lost task).
      let findings: string[] = [];
      let folded: string | null = null;
      let testsNote: string | null = null;
      if (c.lint) {
        const res = await readLint(db, c.lint.task ?? -1);
        if (res.kind === "pending") { log(`  ${ref}: the lint task is still running`); return; }
        if (res.kind === "infra-failed") {
          if (c.lint.state === "requeued") { await fail("failed", `lint: ${res.reason}`); return; }
          const again = await queueLintFor(db, { step: "fixup", repo, number: c.number, head, base: pr.baseRefOid ?? null, patch: c.lint.patch });
          if (again === null) { await fail("failed", `lint: ${res.reason}`); return; }
          await rec.linting(c, c.lint.patch, files, again, "requeued", c.lint.round, c.lint.session, c.lint.changes);
          log(`  ${ref}: lint task failed (${res.reason}); queued again as task ${again}`);
          return;
        }
        const verdict = lintVerdict(res.findings, c.lint.round);
        if (verdict.action === "fail") { await fail("rejected", `${findingsWord(res.findings)} remain after ${c.lint.round} rounds: ${oneLine(verdict.first.message)}`); return; }
        if (verdict.action === "ask") findings = verdict.texts;
        else {
          testsNote = testsNoteOf(verdict, res.testsNote);
          if (testsNote) await jobItem(db, repo, c.number, testsNote, log);
          const fold = await foldFormat(git, head, c.lint.patch, res.formatDiff ?? "", d.root);
          if (!fold.ok) { await fail("refused", fold.reason); return; }
          folded = fold.patch;
        }
      }
      // The model's patch: the stored one when it is clean, else a new answer (with the findings on the earlier patch).
      const ses: SessionAsk = c.lint && findings.length ? sessionAsk(c.lint.session, "", findings, new Date(at())) : {};
      if (folded !== null) dropSessions(c.lint!.session);
      const raw = folded !== null ? c.lint!.patch : await d.ask(db, [{ ref, title: titleOf(c), fixes: c.fixes, ...(quiet ? { quiet } : {}), files: shown, diff: modelDiff, ...(c.operator ? { operator: c.operator.instructions } : {}),
        ...(c.lint && findings.length ? { previous: { patch: c.lint.patch, findings } } : {}), ...repoDir }], checkout,
        new CheckTool({ db, step: "fixup", repo, number: c.number, head, base: pr.baseRefOid ?? null, applies: applyCheck(git, d.root, head, (p) => refusal(c.operator ? validatePatch(splitChanges(p).diff, null, (x) => operatorEditable(x, scripts)) : validatePatch(p, files, (x) => fixupEditable(x, scripts)))) }), ses);
      ledger.hold(ses.kept);
      if (c.lint && folded === null) dropSessions(c.lint.session, ses.kept ? { "": ses.kept } : {});
      if (raw === null) { await fail("failed", "the model gave no answer"); return; }
      // An operator fix-up's reply ends with the model's list of what it changed; a stored patch keeps the list in its row.
      const split = c.operator && folded === null ? splitChanges(raw, c.operator.instructions) : { diff: raw, changes: c.lint?.changes ?? [] };
      const reply = split.diff;
      const v = c.operator ? validatePatch(reply, null, (x) => operatorEditable(x, scripts)) : validatePatch(reply, files, (x) => fixupEditable(x, scripts));
      if (!v.ok) { await fail("refused", v.reason); return; }
      const word = quiet ? patchGiveaway(v.patch) : null;
      if (word) { await fail("refused", QUIET_PATCH_REFUSAL); return; }

      const scratch = mkdtempSync(join(d.root, ".index-"));
      let applied;
      try {
        applied = await git.applyToTree(head, folded ?? v.patch, join(scratch, "index"), shown.flatMap((f) => ("excerpt" in f ? [f.path] : [])));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      if (!applied.ok) { await fail("refused", applied.reason); return; }
      const commit = await git.commit(applied.tree, head, commitMessage(v.files, !!c.operator), { name: who.login, email: who.email });
      const changes = await git.rawChanges(head, commit);
      const touched = changes.map((x) => x[3]!).sort().join("\n");
      if (changes.some((x) => x[2] !== "M" || x[0] !== x[1] || (x[0] !== "100644" && x[0] !== "100755")) || touched !== [...v.files].sort().join("\n")) {
        await fail("refused", "the commit would change files or modes outside the validated diff");
        return;
      }

      const outside = outsideShown(shown, await git.diffText(head, commit));
      if (outside) { await fail("refused", outside); return; }

      // Opus checks the validated patch; only an approve goes on. A stored patch that came back clean was checked already (the format changes are whitespace only).
      if (folded === null) {
        if (v.patch.length > CHECK_PATCH_CAP) { await fail("refused", `the patch is over the ${CHECK_PATCH_CAP} character limit for the check`); return; }
        const checkReply = await d.check(db, [{ ref, title: titleOf(c), review_reason: c.reason, fixes: c.fixes, ...(c.operator ? { operator: c.operator.instructions } : {}), diff: modelDiff.slice(0, CHECK_DIFF_CAP), patch: v.patch, ...repoDir }], checkout);
        if (checkReply === null) { await fail("failed", "the patch check gave no answer"); return; }
        const verdict = parseCheck(checkReply);
        if (!verdict.ok) { await fail("failed", `the patch check gave no valid answer: ${verdict.error}`); return; }
        await recordCheck(db, { kind: "fixup", repo, number: c.number, subject: head, patch: v.patch, round: c.attempt, model: CHECK.models[0]!, check: verdict.check, at: at() });
        await audit(db, ACTOR, "fixup-check", ref, { run: runId, head, verdict: verdict.check.verdict, reasons: verdict.check.reasons });
        if (verdict.check.verdict === "reject") { await fail("rejected", `Opus rejected the patch: ${checkLine(verdict.check)}`); return; }
      }

      // The model calls took minutes: read the PR again before pushing.
      const again = await d.querier.query(PR_QUERY, { owner: ownerOf(repo), name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const now = again.repository?.pullRequest;
      await noteLive(db, repo, c.number, now, at());
      if (!now || now.state !== "OPEN" || now.isDraft) { log(`  ${ref}: skipped: no longer an open, non-draft PR after the model calls`); return; }
      if (now.headRefOid !== c.head) { log(`  ${ref}: skipped: head moved to ${short(now.headRefOid)} during the model calls`); return; }

      const g = await guard(db, { repo, number: c.number }, c.lint ? { kind: "lint", bucket: "fixup", head: c.head, source: sourceOf(c) } : { kind: "fixup", bucket: "fix", head: c.head, source: sourceOf(c) }, params.by ?? CLI_BY, liveOf(db, d.querier));
      if ("refused" in g) { log(`  ${ref}: skipped: ${g.refused}`); return; }
      // A model patch is stored and linted before it is pushed (the collect step above pushes it); a patch without a Rust file needs no lint.
      if (folded === null) {
        const round = c.lint ? c.lint.round + 1 : 1;
        const task = await queueLintFor(db, { step: "fixup", repo, number: c.number, head, base: now.baseRefOid ?? null, patch: v.patch });
        if (task !== null) {
          await rec.linting(c, v.patch, v.files, task, "pending", round, ses.kept ? storeSessions({ "": ses.kept }, new Date(at())) : null, split.changes);
          if (ses.kept) ledger.stored({ "": ses.kept });
          await jobItem(db, repo, c.number, `patch stored; lint task ${task} queued (round ${round})`, log);
          return;
        }
      }
      // The planner may have released the PR while the model worked (our own unassign is no one's final word).
      await claim(c, { kind: "fixup", bucket: "fix", source: sourceOf(c) });
      // A request withdrawn while its try ran (a person dropped what it fixes) pushes nothing.
      if (c.operator && (await queuedOperatorFix(db, repo, c.number, c.head))?.id !== c.operator.id) { log(`  ${ref}: skipped: its fix-up request was withdrawn`); return; }
      await rec.pushing(c, commit, v.files);
      const push = await pushBranch(gw, git, "fixup-push", g, { remote: pr.headRepository.nameWithOwner, branch: pr.headRefName, sha: commit }, { run: runId, from: head, to: commit, files: v.files, changed: v.changed });
      if (push.code !== 0) {
        const err = oneLine(push.stderr);
        // Another push came first: the try says nothing about the fix-up, and the new head gets its own.
        if (/stale info/i.test(err)) await fail("superseded", "the branch moved before the push");
        else if (/rejected|fetch first/i.test(err)) await fail("refused", "the branch moved since the review");
        else if (/denied|403|permission|not allowed|protected branch|declined|GH013/i.test(err)) await hold("push-denied", HOLD_CANNOT_PUSH);
        else await fail("failed", `push failed: ${err}`);
        return;
      }
      await rec.fixup(c, "pushed", testsNote, v.files, commit);
      pushed = true;
      summary.pushed.push(ref);
      await jobItem(db, repo, c.number, `pushed ${short(commit)} on ${short(head)}: ${v.files.join(", ")}`, log);

      const body = c.operator ? operatorCommentText(v.files, quiet ? [] : await postableChanges(db, repo, `${repo}#${c.number}`, split.changes, c.operator.instructions)) : commentText(v.files, c.attempt);
      const note: Note = c.operator ? { by: "fixed-operator" } : { by: "model", kind: "comment", model: PROMPT.models[0] };
      // A plain review-fix push right after our own review-fix comment extends that comment instead of adding a second one.
      const prev = c.operator ? null : await newestOwnComment(d.querier, new Set([who.login.toLowerCase(), ...await ownLogins(db, repo)]), repo, c.number);
      const prevLines = prev ? fixupCommentLines(prev.body) : null;
      const cm = prev && prevLines
        ? await ghEditComment(gw, g, d.exec, "fixup-comment-edit", { repo, number: c.number, commentId: prev.id }, note, fixupCommentEdited(prevLines, v.files), { run: runId })
        : await ghComment(gw, g, d.exec, "fixup-comment", { repo, number: c.number, pr: true }, note, body, { run: runId, to: commit });
      if (cm.code !== 0) log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
    } catch (e) {
      if (isHalt(e)) throw e;
      if (pushed) { log(`  ${ref}: after the push: ${scrubReason(oneLine(String((e as Error).message ?? e)), d.root)}`); return; }
      await fail("failed", oneLine(String((e as Error).message ?? e)));
    } finally {
      try { await release(); } finally { giveBack(); }
    }
  };
  // Items of one PR run one after the other inside one pool item; PRs run side by side.
  const byPr = <T extends { number: number }>(items: T[]): T[][] => {
    const out = new Map<number, T[]>();
    for (const c of items) (out.get(c.number) ?? out.set(c.number, []).get(c.number)!).push(c);
    return [...out.values()];
  };
  const pickGroups = byPr(picks), mergeGroups = byPr(cMerges);
  await pool(pickGroups.map((group) => async () => { for (const c of group) await fixOne(c); }), poolRoom(db, () => [repo], (i) => [{ repo, number: pickGroups[i]![0]!.number }]), { max: POOL_MAX.fixup });
  await pool(mergeGroups.map((group) => async () => { for (const c of group) await leased(c, () => mergeConflict(db, conflictRun, c)); }), poolRoom(db, () => [repo], (i) => [{ repo, number: mergeGroups[i]![0]!.number }], { mayNotCall: true }), { max: POOL_MAX.fixup });
  log(`fixup ${repo}: ${summary.pushed.length} pushed, ${summary.asked.length} asked, ${summary.failed.length} failed, ${summary.held.length} held; run ${runId}`);
  return summary;
}

/** The model's list of changes with the items the reference lint flags (a mention or quote of the reference documentation) left out. */
async function postableChanges(db: Db, repo: string, ref: string, changes: string[], instructions: string): Promise<string[]> {
  const items = changes.map((t) => cleanReason(t, 200) ?? "").filter((t) => t && !quotesText(t, instructions));
  const dir = referenceDir(repo);
  const bad = dropTexts(await referenceProblems(items.map((text, i) => ({ field: `changes[${i}]`, text })), dir, dir ? defaultSemanticDeps(db, ref) : undefined));
  return items.filter((t) => !bad.has(t));
}

const DIFF_FILE = /^diff --git a\/(\S+) b\/\S+$/gm;

const OWN_PUSHES = ["fixup-push", "cifix-push", "conflict-push", "fixissue-push", "batch-push"];

/**
 * Our last ask comment on the PR when every commit since the head it was made at is an AutoCraft push (the recorded
 * pushes chain from the ask's head to `head`): a new ask then edits it instead of notifying the contributor again.
 * `text` is the text as last posted or edited.
 */
export async function earlierAsk(db: Db, repo: string, number: number, head: string): Promise<{ id: string; text: string } | null> {
  const target = `${repo}#${number}`;
  type Done = { action: string; d: { state?: string; url?: string; text?: string; comment?: string; head?: string; from?: string; to?: string } };
  const [facts, audits] = await db.together(() => Promise.all([
    loadPatchFacts(db, [{ repo, number }]),
    loadAuditActions(db, [target], ["fixup-comment", "fixup-comment-edit", ...OWN_PUSHES]),
  ]));
  // Newest first, as the chain walk below expects.
  const done = (actions: string[]): Done[] =>
    (audits.get(target) ?? []).filter((r) => actions.includes(r.action)).reverse().map((r) => ({ action: r.action, d: (r.details ?? {}) as Done["d"] })).filter((r) => r.d.state === "done");
  const asked = new Set((facts.get(target)?.fixups ?? []).filter((r) => r.state === "asked").map((r) => r.fromHead));
  if (!asked.size) return null;
  const comments = done(["fixup-comment", "fixup-comment-edit"]);
  const post = comments.find((r) => r.action === "fixup-comment" && r.d.head && asked.has(r.d.head) && /#issuecomment-\d+$/.test(r.d.url ?? ""));
  if (!post) return null;
  const id = /#issuecomment-(\d+)$/.exec(post.d.url!)![1]!;
  const edit = comments.find((r) => r.action === "fixup-comment-edit" && r.d.comment === id);
  const pushes = done(OWN_PUSHES);
  let cur = head;
  for (let i = 0; cur !== post.d.head && i <= pushes.length; i++) {
    const p = pushes.find((r) => r.d.to === cur && r.d.from);
    if (!p) return null;
    cur = p.d.from!;
  }
  if (cur !== post.d.head) return null;
  return { id, text: (edit ?? post).d.text ?? "" };
}

export type RepostResult = { status: "unchanged" | "dry-run" | "edited" | "failed"; old: string; text: string };

/**
 * Re-posts the ask comment of a PR we asked, by editing the comment we posted, from the fix list of the review at the
 * head the ask was made on. Does nothing when the text equals the one last recorded for that comment.
 */
export async function repostAsk(db: Db, repo: string, number: number, apply: boolean, run: Exec = exec): Promise<RepostResult> {
  const target = `${repo}#${number}`;
  const [facts, audits] = await db.together(() => Promise.all([loadPatchFacts(db, [{ repo, number }]), loadAuditActions(db, [target], ["fixup-comment", "fixup-comment-edit"])]));
  // The newest review-source row: the rows come oldest first by id; `created_at` then id decides the newest.
  const state = (facts.get(target)?.fixups ?? []).filter((r) => r.source === null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id))[0];
  if (state?.state !== "asked") throw new Error(`${repo}#${number} is not in the asked state`);
  const ds = [...(audits.get(target) ?? [])].reverse().map((r) => ({ action: r.action, d: (r.details ?? {}) as { state?: string; url?: string; text?: string; comment?: string } })).filter((r) => r.d.state === "done");
  const last = ds[0];
  const url = ds.find((r) => r.action === "fixup-comment" && r.d.url)?.d.url;
  const id = /#issuecomment-(\d+)$/.exec(url ?? "")?.[1];
  if (!last || !id) throw new Error(`no recorded ask comment for ${repo}#${number}`);
  const review = (await loadReviewsAt(db, [{ repo, number, head: state.fromHead }])).get(`${repo}#${number}@${state.fromHead}`);
  const fixes = parseFixes(review?.verdict === "take-fix" ? JSON.stringify(review.fixes) : null);
  if (!fixes.length) throw new Error(`no fix list for ${repo}#${number} at ${state.fromHead.slice(0, 7)}`);
  const old = last.d.text ?? "";
  const note: Note = { by: "model", kind: "comment", model: review?.model };
  const text = askText(fixes);
  // The recorded text is the text as posted, note line included.
  if (withNote(note, text) === old) return { status: "unchanged", old, text };
  if (!apply) return { status: "dry-run", old, text };
  const g = await guardRepo(db, repo, "comment", CLI_BY);
  if ("refused" in g) throw new Error(g.refused);
  const r = await ghEditComment({ db, login: ACTOR }, g, run, "fixup-comment-edit", { repo, number, commentId: id }, note, text, { head: state.fromHead });
  return { status: r.code === 0 ? "edited" : "failed", old, text };
}

function parseArgs(args: string[]): { repo: string; limit?: number; apply: boolean } {
  let repo: string | undefined, limit: number | undefined, apply = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo") repo = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--apply") apply = true;
    else throw new Error(`unknown option ${a}; options: --repo R --limit N --apply`);
  }
  if (!repo) throw new Error("missing --repo");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new Error("--limit is a whole number");
  return { repo, limit, apply };
}

export const commands = {
  fixup: {
    summary: "fixup --repo R [--limit N] [--apply] | fixup repost <repo>#<n> [--apply] | fixup try <repo>#<n>: push the review's small fixes to take-fix PRs we may push to; repost edits our ask comment to the full fix list (dry run unless --apply); try runs the patch step for one PR with the check tool and prints the tool calls, the patch, the Opus check and the lint result, storing and pushing nothing",
    async run(args: string[]): Promise<void> {
      if (args[0] === "try") {
        const m = /^([^#\s]+)#(\d+)$/.exec(args[1] ?? "");
        if (!m || args.length !== 2) throw new Error("usage: autocraft-server fixup try <repo>#<n>");
        process.exitCode = await (await import("./try.ts")).runFixupTry(await openDb(), m[1]!, Number(m[2]));
        return;
      }
      if (args[0] === "repost") {
        const m = /^([^#\s]+)#(\d+)$/.exec(args[1] ?? "");
        if (!m || args.slice(2).some((a) => a !== "--apply")) throw new Error("usage: autocraft-server fixup repost <repo>#<n> [--apply]");
        const r = await repostAsk(await openDb(), m[1]!, Number(m[2]), args.includes("--apply"));
        console.log(`old:\n${r.old}\n\nnew:\n${r.text}\n\n${r.status}`);
        if (r.status === "failed") process.exitCode = 1;
        return;
      }
      const f = parseArgs(args);
      await runFixup(await openDb(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  "push-approval": {
    summary: "push-approval [--repo R]: which repos the operator approved for fix-up pushes",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo");
      const db = await openDb();
      const repos = i >= 0 ? [args[i + 1]!] : [...(await loadTrackedRepos(db)).keys()].sort();
      const approvals = await loadStepApprovals(db, repos, ["push"]);
      for (const r of repos) {
        const a = approvals.get(r)?.push;
        console.log(`${r}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};
