// Fix-up for conflicted take / take-fix PRs: merge the default branch into the PR's branch. A clean merge needs no model.
// Conflicts go to Sonnet, which returns resolved file contents; our code validates them, Opus checks the result, and the
// merge commit (head first, base second) is pushed with a lease. Never a rebase or a force-push. Like the rest of
// Fix-up, no working tree exists: the checkout is untrusted data (see git.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isHalt } from "../agents/call.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { audit } from "../dash/audit.ts";
import type { By } from "../core/gates.ts";
import { guard, liveOf } from "../core/guard.ts";
import { isOwnLogin, ownLogins } from "../github/identity.ts";
import type { Note } from "../github/note.ts";
import { ghAskComment, ghComment, ghEditComment, pushBranch, type Writer } from "../github/write.ts";
import { MAX_PATCH_BYTES } from "../build/tasks.ts";
import { foldFormat, queueLintFor, readLint } from "../prepush/index.ts";
import { findingsWord, lintVerdict, testsNoteOf } from "../prepush/tests.ts";
import { cachedDiff } from "../review/diff.ts";
import { mergeInAllowed } from "../merge/base.ts";
import { MAX_DIFF_CHARS } from "../review/opus.ts";
import { changedHunks, changedLines, hasBinary, ownDiffKey } from "../review/own-diff.ts";
import { checkLine, parseCheck, recordCheck } from "../patchcheck/index.ts";
import { CHECK_DIFF_CAP, CHECK_PATCH_CAP, type FixupCheckInput } from "../patchcheck/types.ts";
import { CLAUDE_PROMPTS, untrustedJson } from "../prompts/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { patchGiveaway, QUIET_PATCH_REFUSAL } from "../security/rules.ts";
import { BASE_NAME, type ConflictCandidate } from "./conflict-state.ts";
import type { Git } from "./git.ts";
import { dropSessions, sessionAsk, storeSessions, type Kept, type SessionLedger } from "../prepush/resume.ts";
import { noteLive, type FixupDeps, type FixupSummary, type PrNode } from "./index.ts";
import { answerText, buildScriptsAt, conflictView, endNewline, hasMarkers, locateInHead, parseResolution, resolvablePath, spliceSections, type BuildScripts, type ConflictFile, type ConflictSection, type Resolution } from "./patch.ts";
import { conflictSeed, sessionResolution, type ConflictShown } from "./conflict-session.ts";
import { defaultSessionDeps } from "./session.ts";
import { fixSessionsOn } from "../fixsession/switch.ts";
import { endStepPod } from "../fixsession/park.ts";
import { ensureAuthorWrites } from "./author-permission.ts";
import { longLivedOf, pushable } from "./pushable.ts";
import { conflictAskText, conflictCommentCount, conflictCommentText, mergeMessage } from "./template.ts";
import { ownerOf } from "../owners.ts";
import * as changes from "../data/changes/index.ts";
import { finishPatch, setOwnDiff, storePatch } from "../data/changes/index.ts";
import { loadItems, loadRepos } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";

const CHECK = CLAUDE_PROMPTS["fixup.check"];
const CONFLICT = CLAUDE_PROMPTS["fixup.conflict"];
/** Caps on what the resolver is shown for one file (all its sections with 30 lines of context, and one section's two sides). The check's own limit is applied separately, to what it receives. */
const SECTIONS_CAP = 120_000;
const SECTION_CAP = 40_000;
/** Caps on one try across all its conflicted files: each file costs a resolver call and a check call. */
const MAX_CONFLICT_FILES = 12;
const ALL_SECTIONS_CAP = 360_000;
/** Lines of context per section the check gets. */
const CHECK_CONTEXT = 10;
/** Characters of the earlier resolution's diff the resolver is shown with the findings. */
const PREVIOUS_CAP = 40_000;
const lastLines = (text: string, n: number): string => text.split(/(?<=\n)/).slice(-n).join("");

type CheckSections = NonNullable<FixupCheckInput["conflict"]>["files"];
/** The check's view of the sections; `answer(s)` gives the resolved text of a section. Measured as the prompt renders it. */
const checkSections = (shown: ConflictFile[], answer: (s: ConflictSection) => string): CheckSections =>
  shown.map((f) => ({ path: f.path, sections: f.sections.map((s) => ({ id: s.id, line: s.line, before: lastLines(s.before, CHECK_CONTEXT), ours: s.ours, theirs: s.theirs, resolved: answer(s), after: s.after.split(/(?<=\n)/).slice(0, CHECK_CONTEXT).join("") })) }));
const checkSize = (files: CheckSections): number => untrustedJson({ files }).length;


export type ConflictRun = {
  ledger: SessionLedger;
  repo: string; runId: string; log: (line: string) => void; d: FixupDeps; gw: Writer; at: () => string; summary: FixupSummary;
  prQuery: string; scrub: (raw: string) => string; who: () => Promise<{ login: string; email: string }>; git: () => Git;
  /** Called once per PR handled. */
  onHandled?: (n: number) => void; handled: { n: number };
  /** Who asked: gates the writes. */
  by: By;
  /** Called when the stage starts work on a PR: assigns the pipeline's account when nobody is. */
  claim: (c: ConflictCandidate) => Promise<void>;
};

const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** Written before the push, so a crash between the push and its record leaves the merge commit in the push chain. */
async function recordPushing(db: Db, at: string, c: ConflictCandidate, files: string[], base: string | null, toHead: string): Promise<void> {
  await changes.recordPushing(db, { kind: "conflict", repo: c.repo, number: c.number, head: c.head, commit: toHead, files, attempt: c.attempt, baseSha: base, storedId: c.lint?.rowid, at });
}

async function record(db: Db, at: string, c: ConflictCandidate, state: string, reason: string | null, files: string[], base: string | null, toHead: string | null = null): Promise<void> {
  const note = state === "merged" ? `merged ${c.base} at ${short(c.head)}: ${files.length ? files.join(", ") : "no conflicts"}` : state === "asked" ? `asked the contributor to merge ${c.base} at ${short(c.head)}` : `conflict merge ${state} at ${short(c.head)}: ${reason}`;
  await finishPatch(db, { kind: "conflict", repo: c.repo, number: c.number, head: c.head, state, reason, files, toHead, baseSha: base, attempt: c.attempt, at, note: { repo: c.repo, number: c.number, stage: "take", at, actor: "fixup", note }, jobNote: null });
}

/**
 * Whether the PR's own diff is unchanged by the merge, read from the local commits (no GitHub call, and no wait for GitHub to show the new head).
 * Only a clean git merge is `same`: the key ignores line positions, so a model resolution may have moved PR lines. A binary file is `changed`.
 * `delta` is what changed, for the review; `lines` how many of the PR's lines a model's resolution changed (a clean merge changes none). All
 * are null when git cannot say.
 */
async function ownDiffAfterMerge(git: Git, head: string, baseSha: string, commit: string, resolved: string[]): Promise<{ ownDiff: "same" | "changed" | null; delta: string | null; lines: number | null }> {
  try {
    const mb = (await git.must(["merge-base", head, baseSha])).trim();
    const before = await git.diffText(mb, head), after = await git.diffText(baseSha, commit);
    if (!resolved.length && !hasBinary(before) && !hasBinary(after) && ownDiffKey(before) === ownDiffKey(after)) return { ownDiff: "same", delta: null, lines: 0 };
    // Over the review's size cap the delta is not kept: the review then reads the whole diff (and is refused as too large if that is over the cap too).
    const delta = changedHunks(before, after, resolved) || null;
    return { ownDiff: "changed", delta: delta && delta.length <= MAX_DIFF_CHARS ? delta : null, lines: resolved.length ? changedLines(before, after) : 0 };
  } catch { return { ownDiff: null, delta: null, lines: null }; }
}

async function live(db: Db, x: ConflictRun, c: ConflictCandidate): Promise<PrNode | null> {
  const r = await x.d.querier.query(x.prQuery, { owner: ownerOf(x.repo), name: x.repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
  const pr = r.repository?.pullRequest;
  await noteLive(db, x.repo, c.number, pr, x.at());
  if (!pr || pr.state !== "OPEN" || pr.isDraft) { x.log(`  ${refOf(c)}: skipped: no longer an open, non-draft PR`); return null; }
  if (pr.headRefOid !== c.head) { x.log(`  ${refOf(c)}: skipped: head moved to ${short(pr.headRefOid)} since the review`); return null; }
  return pr;
}

const NEWEST_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) {
    comments(last: 1) { nodes { databaseId body createdAt author { login } } }
    reviews(last: 1) { nodes { submittedAt } }
  } }
}`;

/**
 * Our own comment (author in `logins`: the box login, the bare app slug and `<slug>[bot]`, lower case) when it is the newest comment on the PR and no review came after it, read live in
 * one call; null otherwise, and when the read fails.
 */
export async function newestOwnComment(querier: { query(q: string, v: object): Promise<unknown> }, logins: ReadonlySet<string>, repo: string, number: number): Promise<{ id: string; body: string } | null> {
  try {
    const r = await querier.query(NEWEST_QUERY, { owner: ownerOf(repo), name: repo, n: number }) as { repository?: { pullRequest?: {
      comments?: { nodes?: { databaseId: number; body: string; createdAt: string; author: { login: string } | null }[] };
      reviews?: { nodes?: { submittedAt: string | null }[] };
    } | null } };
    const pr = r.repository?.pullRequest;
    const last = pr?.comments?.nodes?.[0];
    if (!pr || !last || !last.author || !isOwnLogin(logins, last.author.login)) return null;
    const posted = last.createdAt;
    const review = pr.reviews?.nodes?.[0]?.submittedAt;
    if (review && (!posted || review > posted)) return null;
    return { id: String(last.databaseId), body: last.body };
  } catch { return null; }
}

/** Our own conflict note when it is the newest comment on the PR and no review came after it: its comment id and the number of merges it reports. */
export async function newestConflictNote(x: ConflictRun, c: ConflictCandidate, db?: Db): Promise<{ id: string; count: number } | null> {
  try {
    const last = await newestOwnComment(x.d.querier, new Set([(await x.who()).login.toLowerCase(), ...(db ? await ownLogins(db, x.repo) : [])]), x.repo, c.number);
    if (!last) return null;
    const count = conflictCommentCount(last.body, c.base);
    return count === null ? null : { id: last.id, count };
  } catch { return null; }
}

/** One comment per head asking the contributor to bring the base branch in, for a branch we can't push to. */
export async function askConflict(db: Db, x: ConflictRun, c: ConflictCandidate): Promise<void> {
  const ref = refOf(c);
  try {
    const pr = await live(db, x, c);
    if (!pr) return;
    if (pr.baseRefName && pr.baseRefName !== c.base) { x.log(`  ${ref}: skipped: the base branch is now ${pr.baseRefName}`); return; }
    if (pr.mergeable !== "CONFLICTING") { x.log(`  ${ref}: skipped: GitHub no longer reports a conflict`); return; }
    if (!BASE_NAME.test(c.base)) { x.log(`  ${ref}: skipped: unusable base branch name`); return; }
    if ((await loadQuiet(db, [`${x.repo}#${c.number}`])).size > 0) { x.log(`  ${ref}: not asked: nothing is posted about a quiet pull request`); return; }
    const g = await guard(db, { repo: x.repo, number: c.number }, { kind: "conflict", bucket: "ask", head: c.head }, x.by);
    if ("refused" in g) { x.log(`  ${ref}: skipped: ${g.refused}`); return; }
    const cm = await ghAskComment(x.gw, x.d.exec, "conflict-comment", g, { by: "fixed" }, conflictAskText(c.base), { run: x.runId, head: c.head });
    if (cm.code !== 0) {
      // Not sent: nothing reached GitHub, so the ask is tried again after a backoff. Otherwise GitHub may have posted it.
      const why = x.scrub(oneLine(cm.stderr)), state = cm.sent === false ? "comment-unsent" : "comment-failed";
      await record(db, x.at(), c, state, why, [], null);
      x.log(`  ${ref}: comment ${state === "comment-unsent" ? "not sent" : "failed"}: ${why}`);
      return;
    }
    await record(db, x.at(), c, "asked", null, [], null);
    x.summary.asked.push(ref);
    x.onHandled?.(++x.handled.n);
    x.log(`  ${ref}: asked the contributor to merge ${c.base} at ${short(c.head)}`);
  } catch (e) {
    x.log(`  ${ref}: not asked: ${oneLine(String((e as Error).message ?? e))}`);
  }
}

/** Why a merge's conflicted files are refused by their number alone, before anything is read. */
const countRefusal = (files: readonly string[]): string | null =>
  !files.length ? "the merge is not clean but names no conflicted file" : files.length > MAX_CONFLICT_FILES ? `${files.length} files conflict, over the limit of ${MAX_CONFLICT_FILES}` : null;

/**
 * The conflicted files of a merge tree as the resolver and the fix session get them: each file's sections (numbered across the
 * files) with their context, within the size caps. `hold`: refused for the same reason at every run for this head.
 */
export async function conflictShown(git: Git, tree: string, head: string, baseSha: string, files: string[], scripts: BuildScripts): Promise<{ ok: true; shown: ConflictShown[] } | { ok: false; reason: string; hold: boolean }> {
  const hold = (reason: string) => ({ ok: false as const, reason, hold: true });
  const count = countRefusal(files);
  if (count) return hold(count);
  let allSections = 0;
  const shown: ConflictShown[] = [];
  let nextId = 1;
  for (const path of files) {
    if (!resolvablePath(path, scripts)) return hold(`${path} is not a file a conflict resolution may touch`);
    const f = await git.file(tree, path);
    if (!f.ok) return { ok: false, reason: f.reason, hold: !!f.tooLarge };
    if (!hasMarkers(f.content)) return hold(`${path} conflicts without content markers`);
    if (f.content.includes("\uFFFD")) return hold(`${path} is not UTF-8`);
    const crlf = f.content.includes("\r\n");
    const content = crlf ? f.content.replace(/\r\n/g, "\n") : f.content;
    if (content.includes("\r") || (crlf && /(?<!\r)\n/.test(f.content))) return hold(`${path} has mixed or bare CR line endings`);
    const view = conflictView(path, content, nextId);
    if (!view) return hold(`${path} has malformed conflict markers`);
    const headFile = await git.file(head, path);
    // Marker-shaped lines of a side's own text would split the sections elsewhere than git did.
    const baseFile = await git.file(baseSha, path);
    if ((headFile.ok && hasMarkers(headFile.content)) || (baseFile.ok && hasMarkers(baseFile.content))) return hold(`${path} has lines shaped like conflict markers of its own`);
    if (headFile.ok) locateInHead(view, headFile.content.replace(/\r\n/g, "\n"));
    nextId += view.sections.length;
    const size = view.sections.reduce((n, s) => n + s.before.length + s.ours.length + s.theirs.length + s.after.length, 0);
    if (size > SECTIONS_CAP || view.sections.some((s) => s.ours.length + s.theirs.length > SECTION_CAP)) return hold(`the conflict sections of ${path} are over the size limit`);
    allSections += size;
    if (allSections > ALL_SECTIONS_CAP) return hold(`the conflict sections of the ${files.length} conflicted files are over the ${ALL_SECTIONS_CAP} character limit`);
    // The check gets each section with its resolution, which is at most as long as the longer side plus three lines: refused here, before the claim, when even that bound is too big.
    if (checkSize(checkSections([view], (s) => (s.ours.length > s.theirs.length ? s.ours : s.theirs))) > CHECK_PATCH_CAP) return hold(`the conflict sections of ${path} are over the ${CHECK_PATCH_CAP} character limit for the check`);
    shown.push({ view, content, mode: f.mode, crlf });
  }
  return { ok: true, shown };
}

/** Merges the base branch into one PR and pushes the merge commit. */
export async function mergeConflict(db: Db, x: ConflictRun, c: ConflictCandidate): Promise<void> {
  const ref = refOf(c);
  let files: string[] = [];
  let baseSha: string | null = null;
  // The push is recorded: what fails after it (the comment) changes nothing about it.
  let merged = false;
  /** A fix session's wait: the item is neither handled nor a try. The item worked on the PR's fix session: its pod's hold ends with it. */
  let deferHandled = false, waited = false, onSession = false, halted = false;
  const fail = async (state: "failed" | "refused" | "rejected" | "superseded", raw: string) => {
    const reason = x.scrub(raw);
    await record(db, x.at(), c, state, reason, files, baseSha);
    x.summary.failed.push({ ref, reason });
    x.log(`  ${ref}: conflict merge ${state}: ${reason}`);
  };
  /** A skip that holds at every run for this head: recorded once so the PR is not selected again. */
  const skip = async (why: string) => { x.log(`  ${ref}: skipped: ${why}`); await record(db, x.at(), c, "skipped", why, [], baseSha); };
  const held = async (state: "push-denied" | "skipped", reason: string) => {
    await record(db, x.at(), c, state, reason, files, baseSha);
    x.summary.held.push({ ref, reason });
    x.log(`  ${ref}: held: ${reason}`);
  };
  try {
    if (!BASE_NAME.test(c.base)) { await skip("unusable base branch name"); return; }
    const def = (await loadRepos(db, { names: [x.repo] })).get(x.repo)?.default_branch;
    if (def && def !== c.base) { await skip(`the PR's base ${c.base} is not the default branch ${def}`); return; }
    const pr = await live(db, x, c);
    if (!pr) return;
    if (pr.baseRefName && pr.baseRefName !== c.base) { await skip(`the base branch is now ${pr.baseRefName}`); return; }
    if (!await mergeInAllowed(db, x.repo, c.number, c.head, c.base)) { await skip(`${c.base} is neither the default branch nor the base the review read`); return; }
    if (pr.mergeable !== "CONFLICTING") { x.log(`  ${ref}: skipped: GitHub no longer reports a conflict`); return; }
    const writes = pr.headRepository ? await ensureAuthorWrites(db, x.repo, c.number, pr.headRepository.nameWithOwner) : "no";
    if (writes === "unknown") { x.log(`  ${ref}: skipped: the author's permission could not be read yet`); return; }
    if (!pr.headRepository || !pushable(pr.headRepository.nameWithOwner, x.repo, pr.maintainerCanModify, pr.headRefName, await longLivedOf(db, x.repo), !!pr.headRef?.branchProtectionRule, writes === "yes")) { x.log(`  ${ref}: skipped: the branch is no longer pushable`); return; }
    // In a fix session the item counts as handled once it is known not to wait (see the finally below).
    const sessions = await fixSessionsOn(db, "conflict", x.repo);
    if (sessions || c.lint?.sessionTurn != null) deferHandled = true;
    else x.onHandled?.(++x.handled.n);
    const git = x.git();
    const head = await git.fetchPr(ownerOf(x.repo), x.repo, c.number);
    if (head !== c.head) { x.log(`  ${ref}: skipped: fetched head ${short(head)} is not the reviewed ${short(c.head)}`); return; }
    baseSha = c.lint ? c.lint.baseSha : await git.fetchBase(ownerOf(x.repo), x.repo, c.base);
    if (c.lint && (await git.git(["cat-file", "-e", `${baseSha}^{commit}`])).code !== 0) { await fail("failed", "the base commit of the stored resolution is no longer in the cache"); return; }
    if ((await git.git(["merge-base", "--is-ancestor", baseSha, head])).code === 0) { await skip(`${c.base} is already in the branch`); return; }
    const who = await x.who();
    const merge = await git.mergeTreeOf(head, baseSha);
    // A resolution may not write a build script of either parent.
    const scriptsOf = async (): Promise<ReadonlySet<string> | null> => {
      const [h, b] = [await buildScriptsAt(git, head), await buildScriptsAt(git, baseSha!)];
      return h && b ? new Set([...h, ...b]) : null;
    };
    let tree = merge.tree;
    let checkout: string | undefined;
    // Refused for the same reason at every run for this head: recorded as a skip so the head is not tried again, and never claimed.
    const refuse = async (reason: string) => { await held("skipped", reason); };
    /** Clippy findings on a stored resolution: it is resolved again with them, as a patch is in Fix-up. */
    let again: { diff: string; full: string; findings: string[] } | null = null;
    let formatDiff: string | null = null;
    /** The fix session turn whose change the stored resolution is (null: the resolver's). */
    let sessionTurn: number | null = null;
    if (c.lint) {
      // A resolution a fix session wrote: the step's hold on the pod ends with the item (a wait keeps it).
      onSession = c.lint.sessionTurn !== null;
      // The stored resolution is rebuilt on the same two parents, then gated on its lint task.
      files = c.lint.files;
      if (merge.clean || [...merge.conflicted].sort().join("\n") !== [...files].sort().join("\n")) { await fail("failed", "the merge no longer conflicts in the files that were resolved"); return; }
      const scratch = mkdtempSync(join(x.d.root, ".index-"));
      try {
        const stored = JSON.parse(c.lint.resolved) as { path: string; mode: string; content: string }[];
        const scripts = await scriptsOf();
        if (!scripts) { await fail("failed", "the build scripts of the branch or the base could not be read"); return; }
        if (stored.some((f) => !resolvablePath(f.path, scripts) || (f.mode !== "100644" && f.mode !== "100755"))) { await fail("refused", "the stored resolution touches a path or mode a resolution may not"); return; }
        tree = await git.withFiles(merge.tree, stored, join(scratch, "index"));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      const resolutionDiff = await git.diffText(merge.tree, tree);
      const res = await readLint(db, c.lint.task ?? -1, { against: resolutionDiff });
      if (res.kind === "pending") { x.log(`  ${ref}: the lint task is still running`); return; }
      if (res.kind === "infra-failed") { await fail("failed", `lint: ${res.reason}`); return; }
      const verdict = lintVerdict(res.findings, c.lint.round);
      if (verdict.action === "fail") { await fail("rejected", `${findingsWord(res.findings)} remain after ${c.lint.round} rounds: ${oneLine(verdict.first.message)}`); return; }
      if (verdict.action === "ask") again = { diff: resolutionDiff.slice(0, PREVIOUS_CAP), full: resolutionDiff, findings: verdict.texts };
      else { const note = testsNoteOf(verdict, res.testsNote); if (note) x.log(`  ${ref}: ${note}`); }
      formatDiff = res.formatDiff;
    }
    if (c.lint && !again) {
      dropSessions(c.lint.session);
      if (formatDiff) {
        const fold = await foldFormat(git, head, await git.diffText(head, tree), formatDiff, x.d.root);
        if (!fold.ok) { await fail("refused", fold.reason); return; }
        const dir = mkdtempSync(join(x.d.root, ".index-"));
        try {
          const applied = await git.applyToTree(head, fold.patch, join(dir, "index"));
          if (!applied.ok) { await fail("refused", applied.reason); return; }
          tree = applied.tree;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      const changes = await git.rawChanges(merge.tree, tree);
      if (changes.some((ch) => !files.includes(ch[3]!) || ch[0] !== ch[1])) { await fail("refused", "the resolution would change files or modes outside the conflicted files"); return; }
      if (!await live(db, x, c)) return;
    } else if (merge.clean) await x.claim(c);
    else {
      files = merge.conflicted;
      const count = countRefusal(files);
      if (count) { await refuse(count); return; }
      const scripts = await scriptsOf();
      if (!scripts) { await fail("failed", "the build scripts of the branch or the base could not be read"); return; }
      const views = await conflictShown(git, merge.tree, head, baseSha, files, scripts);
      if (!views.ok) { if (views.hold) await refuse(views.reason); else await fail("refused", views.reason); return; }
      const shown = views.shown;
      const prDiff = await cachedDiff(db, x.repo, c.number, head, x.d.fetchDiff);
      if (!prDiff.ok) { await fail("failed", `no diff: ${oneLine(prDiff.error)}`); return; }
      const quiet = (await loadQuiet(db, [`${x.repo}#${c.number}`])).size > 0;
      // In a fix session the model resolves the sections in the PR's workspace, seeded from the merge with its markers. Lint
      // findings on a stored resolution go to whoever wrote it, whatever the switch says now.
      const inSession = again && c.lint ? c.lint.sessionTurn !== null : sessions;
      const sessionDeps = inSession ? (x.d.fixSession ?? defaultSessionDeps)(db) : null;
      if (inSession && !sessionDeps) { waited = true; x.log(`  ${ref}: waiting: this runner is not in the cluster, so it cannot reach the fix session's workspace`); return; }
      await x.claim(c);
      let sessionAnswers: Map<string, Map<number, string>> | null = null;
      if (sessionDeps) {
        // The item works on the session from here: a throw ends the step's hold on the pod too (a wait does not).
        onSession = true;
        const seed = await conflictSeed(git, merge.tree, head, baseSha, x.repo, c.number);
        const lint = again && c.lint ? { findings: again.findings, patch: again.full, sessionTurn: c.lint.sessionTurn } : undefined;
        const got = await sessionResolution({ db, deps: sessionDeps, git, log: x.log, by: x.by === "pipeline" ? "pipeline" : x.by.operator, root: x.d.root }, c.number, x.repo,
          { ref, title: c.title, quiet, base: c.base, reason: c.reason, seed, head, baseSha, prDiff: prDiff.text, scripts, shown }, lint);
        if (got.kind === "wait") {
          // Nothing recorded and no try: the step runs again once the session's lease is free or its workspace moves (the lane's
          // planner reading, fixWorkspaceReading), or once a person goes on with a stopped item.
          waited = true;
          x.log(`  ${ref}: waiting: ${x.scrub(oneLine(got.reason))}`);
          return;
        }
        if (got.kind !== "ok") { await fail(got.kind, got.reason); return; }
        sessionAnswers = got.answers;
        sessionTurn = got.turnId;
      } else if (!x.d.resolve) { await fail("failed", "no resolver"); return; }
      checkout = (await x.d.checkout?.(x.repo, c.number, head)) ?? undefined;
      const body = sessionAnswers ? "" : ((await loadItems(db, [{ repo: x.repo, number: c.number }], "text")).get(refOf(c))?.body ?? "").slice(0, 4000);
      const repoDir = checkout ? { repo_dir: REPO_PATH } : {};
      const resFiles: { path: string; mode: string; content: string }[] = [];
      const keptNow: Kept = {};
      /** A file's answers: the fix session's, or one resolver call per file, so the size caps apply to a file, not to the whole PR. */
      const resolveFile = async (f: ConflictFile): Promise<Resolution | null> => {
        const own = sessionAnswers?.get(f.path);
        if (sessionAnswers) return own ? { ok: true, sections: own } : { ok: false, reason: "the fix session's change has no resolution of it" };
        const ses = again ? sessionAsk(c.lint?.session, f.path, again.findings, new Date(x.at())) : {};
        const reply = await x.d.resolve!(db, [{ ref, title: c.title, body, review_reason: c.reason, base: c.base, ...(quiet ? { quiet } : {}), files: [f], ...(again ? { previous: { patch: again.diff, findings: again.findings } } : {}), ...repoDir }], checkout, ses);
        if (ses.kept) { keptNow[f.path] = ses.kept; x.ledger.hold(ses.kept); }
        return reply === null ? null : parseResolution(reply, f.sections.map((s) => s.id));
      };
      // One check per file. Every file must pass before anything is pushed.
      for (const t of shown) {
        const f = t.view;
        const res = await resolveFile(f);
        if (res === null) { await fail("failed", `the model gave no answer for ${f.path}`); return; }
        if (!res.ok) { await fail("refused", `${f.path}: ${res.reason}`); return; }
        const spliced = spliceSections(t.content, f.sections.map((s) => res.sections.get(s.id)!), f.path);
        if (spliced === null) { await fail("refused", `the resolution of ${f.path} adds lines that are neither side, or declares code, imports or dependencies`); return; }
        if (quiet) {
          // Lines from either side are public already; only the lines the model wrote are checked.
          const written = f.sections.flatMap((sec) => {
            const sides = new Set(`${sec.ours}${sec.theirs}`.split("\n"));
            return answerText(res.sections.get(sec.id)!).split("\n").filter((l) => l !== "" && !sides.has(l));
          });
          const word = written.length ? patchGiveaway(`diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1 +1 @@\n${written.map((l) => `+${l}`).join("\n")}\n`) : null;
          if (word) { await fail("refused", QUIET_PATCH_REFUSAL); return; }
        }
        const text = endNewline(t.content, spliced);
        resFiles.push({ path: f.path, mode: t.mode, content: t.crlf ? text.replace(/\r?\n/g, "\r\n") : text });
        const sections = checkSections([f], (s) => answerText(res.sections.get(s.id)!));
        if (checkSize(sections) > CHECK_PATCH_CAP) { await fail("refused", `the resolved sections of ${f.path} are over the ${CHECK_PATCH_CAP} character limit for the check`); return; }
        const checkReply = await x.d.check(db, [{ ref, title: c.title, review_reason: c.reason, fixes: [], diff: prDiff.text.slice(0, CHECK_DIFF_CAP), patch: "", conflict: { base: c.base, files: sections }, ...repoDir }], checkout);
        if (checkReply === null) { await fail("failed", `the patch check of ${f.path} gave no answer`); return; }
        const verdict = parseCheck(checkReply);
        if (!verdict.ok) { await fail("failed", `the patch check of ${f.path} gave no valid answer: ${verdict.error}`); return; }
        await recordCheck(db, { kind: "fixup", repo: x.repo, number: c.number, subject: head, patch: JSON.stringify(sections), round: c.attempt, model: CHECK.models[0]!, check: verdict.check, at: x.at() });
        await audit(db, "fixup", "fixup-check", ref, { run: x.runId, head, verdict: verdict.check.verdict, reasons: verdict.check.reasons, conflict: true, path: f.path });
        if (verdict.check.verdict === "reject") { await fail("rejected", `Opus rejected the resolution of ${f.path}: ${checkLine(verdict.check)}`); return; }
      }
      const scratch = mkdtempSync(join(x.d.root, ".index-"));
      try {
        tree = await git.withFiles(merge.tree, resFiles, join(scratch, "index"));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      const changes = await git.rawChanges(merge.tree, tree);
      if (changes.some((ch) => !files.includes(ch[3]!) || ch[0] !== ch[1])) { await fail("refused", "the resolution would change files or modes outside the conflicted files"); return; }
      if (!await live(db, x, c)) return;
      // A resolution with Rust files is stored and linted before it is pushed (the collect step above pushes it, or asks again with the findings).
      const rs = resFiles.map((f) => f.path).filter((p) => p.endsWith(".rs"));
      dropSessions(c.lint?.session, keptNow);
      const patch = rs.length ? await git.diffText(head, tree) : "";
      // The lint task takes the merge as a patch on the head; one over the task limit is over it at every run for this head.
      if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) { await refuse("the merge is larger than 1 MiB as a patch, over the lint task limit"); return; }
      const task = rs.length ? await queueLintFor(db, { step: "conflict", repo: x.repo, number: c.number, head, base: baseSha, patch, files: rs }) : null;
      if (task !== null) {
        const round = c.lint ? c.lint.round + 1 : 1;
        await storePatch(db, { kind: "conflict", storedId: c.lint?.rowid, repo: x.repo, number: c.number, head: c.head, patch: JSON.stringify(resFiles), files, lintTask: task, lintRound: round, lintState: "pending", session: storeSessions(keptNow, new Date(x.at())), sessionTurn, baseSha: baseSha ?? undefined, attempt: c.attempt, at: x.at() });
        x.ledger.stored(keptNow);
        x.log(`  ${ref}: resolution stored; lint task ${task} queued (round ${round})`);
        return;
      }
    }
    const commit = await git.commitMerge(tree, [head, baseSha], mergeMessage(c.base, pr.headRefName), { name: who.login, email: who.email });
    const own = await ownDiffAfterMerge(git, head, baseSha, commit, files);
    const g = await guard(db, { repo: x.repo, number: c.number }, c.lint ? { kind: "lint", bucket: "conflict", head: c.head, source: "review" } : { kind: "conflict", bucket: "merge", head: c.head }, x.by, liveOf(db, x.d.querier));
    if ("refused" in g) { x.log(`  ${ref}: skipped: ${g.refused}`); return; }
    await recordPushing(db, x.at(), c, files, baseSha, commit);
    const push = await pushBranch(x.gw, git, "conflict-push", g, { remote: pr.headRepository.nameWithOwner, branch: pr.headRefName, sha: commit }, { run: x.runId, from: head, to: commit, base: c.base, files, ...(own.lines !== null ? { changed: own.lines } : {}) });
    if (push.code !== 0) {
      const err = oneLine(push.stderr);
      if (/denied|403|permission|not allowed|protected branch|declined|GH013/i.test(err)) { await held("push-denied", "the branch cannot be pushed to"); return; }
      // Another push came first: the try says nothing about the merge, and the new head gets its own.
      if (/stale info/i.test(err)) await fail("superseded", "the branch moved before the push");
      else if (/rejected|fetch first/i.test(err)) await fail("refused", "the branch moved since the review");
      else await fail("failed", `push failed: ${err}`);
      return;
    }
    await record(db, x.at(), c, "merged", null, files, baseSha, commit);
    merged = true;
    if (own.ownDiff) await setOwnDiff(db, [{ repo: x.repo, number: c.number, toHead: commit, ownDiff: own.ownDiff, ownDelta: own.delta }]);
    x.summary.pushed.push(ref);
    x.log(`  ${ref}: merged ${c.base} into the branch: ${short(commit)} on ${short(head)}${files.length ? `, resolved ${files.join(", ")}` : ""}`);
    const note: Note = files.length ? { by: "model", kind: "comment", model: CONFLICT.models[0] } : { by: "fixed" };
    const prev = await newestConflictNote(x, c, db);
    const cm = prev
      ? await ghEditComment(x.gw, g, x.d.exec, "conflict-comment-edit", { repo: x.repo, number: c.number, commentId: prev.id }, note, conflictCommentText(c.base, prev.count + 1, x.at()), { run: x.runId })
      : await ghComment(x.gw, g, x.d.exec, "conflict-comment", { repo: x.repo, number: c.number, pr: true }, note, conflictCommentText(c.base), { run: x.runId, to: commit });
    if (cm.code !== 0) x.log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
  } catch (e) {
    if (isHalt(e)) { halted = true; throw e; }
    if (merged) { x.log(`  ${ref}: after the push: ${x.scrub(oneLine(String((e as Error).message ?? e)))}`); return; }
    await fail("failed", oneLine(String((e as Error).message ?? e)));
  } finally {
    try {
      if (onSession && !waited && !halted) {
        const deps = (x.d.fixSession ?? defaultSessionDeps)(db);
        if (deps) await endStepPod({ ...deps, db, log: x.log }, { repo: x.repo, number: c.number }, (raw) => x.scrub(oneLine(raw)));
      }
    } finally {
      if (deferHandled && !waited) x.onHandled?.(++x.handled.n);
    }
  }
}
