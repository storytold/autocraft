// The fix PR of a red default branch: for each `needs-fix` row of an approved repo whose head is still red, one attempt
// (per repo, head and check): skip when main is green again or an open PR already covers the failure, otherwise the CI fix
// patch path writes a patch against the head commit (Sonnet, Opus check, validators), or, with `main-fix` in the fix_sessions
// setting, the repo's main-fix session edits the tree of a workspace at the head and AutoCraft reads its change back as a diff
// (the CI fix's gates, the Opus check). A patch that changes Rust files is
// stored on the rows (state `linting`) with its lint task and the step ends; a later run collects the result: formatting is
// folded in, findings go back to the model (at most LINT_MAX_ROUNDS lint rounds). The clean commit is pushed to the
// pipeline account's fork on `autocraft/main-ci-<check>-<sha7>` and a PR is opened against the default branch.
// A check whose patch could not be made and whose failure is only in test code, which a CI fix may not change, gets the red
// streak's issue instead (testCodeFailure).
// The log, the files and other PRs are untrusted data; nothing from them is run here.
import { ownPrSelect } from "../github/adopt.ts";
import { leaseItem } from "../runner/leases.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guardRepo } from "../core/guard.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cifixFiles, errorFiles, guardApplied, logText, opusCheck, patchFromFailure, type CifixDeps } from "../cifix/index.ts";
import { CIFIX_SESSION_RULES, type CifixGate } from "../fixsession/gates.ts";
import type { MainFixTurn } from "../fixsession/messages.ts";
import { parkStepPod } from "../fixsession/park.ts";
import { loadTurns, type FixSession } from "../fixsession/store.ts";
import { fixSessionsOn } from "../fixsession/switch.ts";
import { lintParent, prStep, runStep, type StepEnv, type StepOutcome } from "../fixsession/turn.ts";
import { openSession, WorkspaceUnavailable } from "../fixsession/workspace.ts";
import { CHECK_PATCH_CAP } from "../patchcheck/types.ts";
import { isTestLine } from "../cifix/guard.ts";
import { testLocations } from "../core/failure-locations.ts";
import { loadQuiet } from "../data/security/index.ts";
import { readFailure } from "../cifix/logs.ts";
import type { CiFailure, CifixPr } from "../cifix/types.ts";
import { forkOf } from "../github/fork.ts";
import { outsideShown } from "../fixup/excerpt.ts";
import { Git, type Exec } from "../fixup/git.ts";
import { setPipelineLogin } from "../github/pipeline-account.ts";
import { scrubReason, whoAmI } from "../fixup/index.ts";
import { commitIdentity } from "../github/identity.ts";
import { ghOpenPr, pushOwnBranch } from "../github/write.ts";
import { buildScriptsAt, editable, validatePatch } from "../fixup/patch.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { foldFormat, queueLintFor, readLint } from "../prepush/index.ts";
import { findingsWord, lintVerdict, testsNoteOf } from "../prepush/tests.ts";
import { dropSessions, SessionLedger, sessionAsk, storeSessions, sweepSessions, type SessionAsk } from "../prepush/resume.ts";
import { MAIN_FIX_BRANCH_PREFIX } from "../mainci/index.ts";
import type { Gh } from "../merge/safe-merge.ts";
import { cleanLine } from "../review/post-template.ts";
import type { FixRow } from "./index.ts";
import { optionalChecks } from "../optional-checks.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { POOL_MAX, pool } from "../classify/run.ts";
import { isHalt, poolRoom } from "../agents/call.ts";
import { pushesAreUnsettled } from "../fixup/unsettled.ts";
import { loadMainFixes, loadOpenFixPr } from "../data/changes/index.ts";
import { listItems } from "../data/mirror/index.ts";
import { someSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

export const PR_ACTOR = "main-fix";
/** Open PRs read for overlap with the failure. */
const MAX_PRS = 30;

/** What the fix PR step needs beyond the reading and sorting deps; `session`: the workspace and model calls of a fix in a fix session. */
export type FixPrDeps = Pick<CifixDeps, "ask" | "check" | "root" | "session"> & {
  /** Host directory with a read-only checkout of the head commit for the sandboxed model calls, or null to ask without tools. */
  checkout?: (repo: string, branch: string, sha: string) => Promise<string | null>;
};

const PATCH_MODEL = CLAUDE_PROMPTS["cifix.patch"].models[0]!;
const SESSION_MODEL = CLAUDE_PROMPTS["fix.session"].models[0]!;
/** The number of a repo's main-fix session: the default branch, not a PR. */
const MAIN_FIX_ITEM = 0;

/** Whether the repo has stored patches to collect: the lint task of one ended, or its head is not the current one. `lintingHeads` are the repo's `linting` rows (`loadMainFixDue`). */
export async function lintReadyIn(db: Db, lintingHeads: { headSha: string; lintTask: number | null }[], current: string): Promise<boolean> {
  return await someSeq(lintingHeads, async (r) => r.headSha !== current || r.lintTask === null || (await readLint(db, r.lintTask)).kind !== "pending");
}

/** The default branch's head as the polls show it. */
export type Head = { headSha: string; branch: string; state: string; redSince: string; culprit: string; culpritPr: number | null };

type Ctx = {
  by?: By;
  /** True when no new head should be started (cancel, deadline, pipeline off). */
  stopping?: () => Promise<boolean>;
  db: Db; repo: string; gh: Gh; exec: Exec; fix: FixPrDeps; now: () => Date; log: (line: string) => void;
  /** The rows' state writer of the caller. */
  setState: (r: FixRow, state: string, reason: string | null, at: string, extra?: Partial<FixRow>) => Promise<FixRow>;
  /** The head as the polls show it now. */
  current: () => Promise<Head | null>;
  /**
   * Records that the head's failure log could not be read (`why`; `permanent`: no later read can find it), which times the next
   * attempt, or with null that it was read. Returns why the rows end instead, or null while they wait.
   */
  unread?: (head: string, why: string | null, permanent: boolean) => Promise<string | null>;
};

/** The commit message: a subject and one line per changed file. */
const commitMessage = (subject: string, files: string[]): string => `${subject}\n\n${files.map((f) => `- ${f}`).join("\n")}\n`;
const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "check";
export const branchFor = (check: string, sha: string): string => `${MAIN_FIX_BRANCH_PREFIX}${slug(check)}-${sha.slice(0, 7)}`;
const urlOk = (url: string, repo: string): boolean => new RegExp(`^https://github\\.com/${slugOf(repo)}/pull/\\d+$`).test(url);

/** Title of the fix PR: the first check, and how many more the same patch covers. */
export const prTitle = (checks: string[]): string => `Fix main CI: ${cleanLine(checks[0], 100)}${checks.length > 1 ? ` (+${checks.length - 1} more)` : ""}`;

/** Body of the fix PR. Fixed layout; the check names are cleaned of mentions and markup. */
export function prBody(r: { head: string; checks: { name: string; runUrl: string | null }[]; culprit: string; culpritPr: number | null; files: string[]; changed: number }): string {
  const one = (c: { name: string; runUrl: string | null }): string => `\`${cleanLine(c.name, 100).replace(/`/g, "'")}\`${c.runUrl ? ` (${c.runUrl})` : ""}`;
  return [
    `The CI of the default branch fails at ${r.head.slice(0, 8)}.`,
    "",
    r.checks.length === 1 ? `Failing check: ${one(r.checks[0]!)}` : `Failing checks:\n${r.checks.map((c) => `- ${one(c)}`).join("\n")}`,
    `Culprit: ${r.culprit.slice(0, 8)}${r.culpritPr ? ` (#${r.culpritPr})` : ""}`,
    "",
    `Patch: ${r.files.map((f) => `\`${f}\``).join(", ")}, ${r.changed} changed ${r.changed === 1 ? "line" : "lines"}.`,
  ].join("\n");
}

/**
 * The PR (number) that already covers the failure, if any: one of ours opened for this red streak and still open, or an
 * open PR updated after the red that names a failing check or changes a file the failure names.
 */
async function coveringPr(c: Ctx, checks: string[], files: string[], since: string): Promise<number | null> {
  const ours = await loadOpenFixPr(c.db, c.repo, since);
  if (ours !== null) return ours;
  const prs = (await listItems(c.db, { repos: [c.repo], kind: "pr", states: ["OPEN"], updatedSince: since }, "text")).slice(0, MAX_PRS);
  const names = checks.map((x) => x.toLowerCase());
  for (const p of prs) {
    const text = `${p.title ?? ""}\n${p.body ?? ""}`.toLowerCase();
    if (names.some((n) => text.includes(n))) return p.number;
  }
  if (!files.length) return null;
  for (const p of prs) {
    try {
      const out = await c.gh(["api", `repos/${slugOf(c.repo)}/pulls/${p.number}/files?per_page=100`, "--jq", ".[].filename"]);
      if (out.split("\n").some((f) => files.includes(f.trim()))) return p.number;
    } catch { /* unreadable: not counted as covering */ }
  }
  return null;
}

/** The places of one check read to judge it test-only; a log naming more is not judged. */
const TEST_PLACES = 50;

/**
 * The failing test of one check when every place its log names (compile errors and panics, testLocations) is test code at
 * `head` (isTestLine): "test X fails at file:line". Null when the log names no place or more than TEST_PLACES, one is not
 * test code or a file cannot be read.
 */
export async function testCodeFailure(git: Git, head: string, check: CiFailure["checks"][number]): Promise<string | null> {
  const { places, capped } = testLocations(check.steps.map((s) => s.tail).join("\n"), TEST_PLACES);
  if (!places.length || capped) return null;
  for (const p of places) {
    const f = await git.file(head, p.file);
    if (!f.ok || !isTestLine(p.file, f.content, p.line)) return null;
  }
  const first = places.find((p) => p.test) ?? places[0]!;
  return `${first.test ? `test ${first.test} fails` : "test code fails"} at ${first.file}:${first.line}${places.length > 1 ? ` (and ${places.length - 1} more)` : ""}`;
}

type Outcome = "opened" | "skipped" | "failed" | "waiting" | "linting" | "issue";

/**
 * One attempt for the rows of one head: one patch and one PR for all of them. The rows are `needs-fix` (a new patch) or
 * `linting` (a stored patch whose lint task is collected). Each row ends in nothing-to-do, pr-opened or fix-failed, goes to
 * linting with a stored patch, goes to issue-opening when no patch was made and its check fails only in test code
 * (testCodeFailure), or stays as it is while the head is still running or the lint task is.
 */
async function attempt(c: Ctx, rows: FixRow[], count: () => void, ledger: SessionLedger, sessions: boolean): Promise<Outcome> {
  const at = (): string => c.now().toISOString();
  const head = rows[0]!.headSha;
  const set = async (list: FixRow[], state: "nothing-to-do" | "fix-failed", reason: string): Promise<"skipped" | "failed"> => {
    const why = scrubReason(oneLine(reason), c.fix.root);
    for (const r of list) await c.setState(r, state, why, at());
    c.log(`  ${c.repo}: ${list.map((r) => r.check).join(", ")}: ${state}: ${why}`);
    return state === "fix-failed" ? "failed" : "skipped";
  };
  const done = async (state: "nothing-to-do" | "fix-failed", reason: string) => await set(rows, state, reason);
  try {
    const now = await c.current();
    // The head is still being checked (a rerun is running): the row waits, with no state change and no attempt counted.
    if (now && now.headSha === head && now.state === "running") return "waiting";
    if (!now || now.state !== "red") return await done("nothing-to-do", "main is green again");
    if (now.headSha !== head) return await done("nothing-to-do", "main moved to a newer head");
    const reading = await readFailure(c.gh, c.repo, head, await optionalChecks(c.db, c.repo));
    // A log GitHub does not serve yet: the rows wait, and the head's unread row says when they are tried again.
    if (reading.kind === "unread") {
      const end = await c.unread?.(head, reading.why, reading.permanent);
      return end ? await done("fix-failed", end) : "waiting";
    }
    await c.unread?.(head, null, false);
    if (reading.kind === "skip") return await done("nothing-to-do", reading.why);
    const failing = new Map(reading.failure.checks.map((x) => [x.name, x]));
    for (const r of rows.filter((x) => !failing.has(x.check))) await set([r], "nothing-to-do", "the check no longer fails at this head");
    const live = rows.filter((r) => failing.has(r.check));
    if (!live.length) return "skipped";
    const checks = live.map((r) => failing.get(r.check)!);
    const files = [...new Set(checks.flatMap((x) => errorFiles(x.steps.map((s) => s.tail).join("\n"))))];
    const covered = await coveringPr(c, live.map((r) => r.check), files, now.redSince);
    if (covered !== null) return await set(live, "nothing-to-do", `an open PR already covers it: #${covered}`);

    const stored = live[0]!.state === "linting";
    const w = stored ? { patch: live[0]!.patch ?? "", files: JSON.parse(live[0]!.files ?? "[]") as string[], task: live[0]!.lintTask, round: live[0]!.lintRound ?? 1, state: live[0]!.lintState, session: live[0]!.session, sessionTurn: live[0]!.sessionTurn ?? null } : null;
    const res = w ? await readLint(c.db, w.task ?? -1) : null;
    if (res?.kind === "pending") return "waiting";
    // A fix in a fix session counts once it did not wait for its workspace (fromSession).
    if (!stored && !sessions) count();
    const git = new Git(c.exec, c.fix.root, c.repo);
    mkdirSync(c.fix.root, { recursive: true });
    if (!(await git.fetchBranch(ownerOf(c.repo), c.repo, now.branch, head))) return await set(live, "fix-failed", "the head commit is no longer in the repository");
    /**
     * No patch could be made (`reason`). A check whose failure is only in test code is a person's to fix: its rows go to
     * issue-opening and the red streak's issue (openInfraIssues) names the test. The other rows are fix-failed.
     */
    const noPatch = async (reason: string): Promise<"issue" | "failed"> => {
      const how = /\btest/.test(reason) ? "the only fix found changes the test" : "no fix outside the test was found";
      const failed: FixRow[] = [];
      let issues = 0;
      for (const r of live) {
        const found = await testCodeFailure(git, head, failing.get(r.check)!);
        if (!found) { failed.push(r); continue; }
        const why = scrubReason(oneLine(`${found}; ${how}, and a CI fix may not change tests`), c.fix.root);
        // A stored patch of a lint round is dropped with the row's move.
        await c.setState(r, "issue-opening", why, at(), { patch: null, files: null, lintTask: null, lintRound: null, lintState: null, session: null, sessionTurn: null });
        c.log(`  ${c.repo}: ${r.check}: ${why}; opening an issue`);
        issues++;
      }
      if (failed.length) await set(failed, "fix-failed", reason);
      return issues ? "issue" : "failed";
    };
    const ref = `${c.repo}@${head.slice(0, 8)}`;
    const names = live.map((r) => r.check);
    const title = prTitle(names);
    const treeOf = async (patch: string, exact: string[] = []) => {
      const scratch = mkdtempSync(join(c.fix.root, ".index-"));
      try { return await git.applyToTree(head, patch, join(scratch, "index"), exact); }
      finally { rmSync(scratch, { recursive: true, force: true }); }
    };
    const store = async (patch: string, files: string[], task: number, state: "pending" | "requeued", round: number, session: string | null, sessionTurn: number | null = null): Promise<void> => {
      for (const r of live) await c.setState(r, "linting", null, at(), { patch, files: JSON.stringify(files), lintTask: task, lintRound: round, lintState: state, session, sessionTurn });
    };

    /** `sessionTurn`: the fix session turn that wrote the change. `wait`: the fix session cannot work now; nothing is recorded or counted. */
    type Made = { ok: true; patch: string; files: string[]; changed: number; shown: CifixPr["files"]; model: string; applied: Awaited<ReturnType<typeof treeOf>>; sessionTurn?: number } | { ok: false; reason: string; wait?: true };
    const culpritQuiet = async (): Promise<boolean> => !!now.culpritPr && (await loadQuiet(c.db, [`${c.repo}#${now.culpritPr}`])).size > 0;
    const runId = `main-fix-${c.repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
    const reviewReason = `The default branch fails the check${names.length > 1 ? "s" : ""} ${names.join(", ")} at this head. The patch must make ${names.length > 1 ? "them" : "it"} pass without changing what the code is meant to do.`;
    /** A model patch (with the earlier patch and its findings after a lint round), applied and checked. */
    const generate = async (previous: { patch: string; findings: string[] } | null, round: number, ses: SessionAsk = {}): Promise<Made> => {
      const made = await patchFromFailure(c.db, c.fix, {
        git, ref, title, repo: c.repo, number: MAIN_FIX_ITEM, base: head, ...(await culpritQuiet() ? { quiet: true } : {}), head, round, failure: { head, checks }, diffText: "", ...(previous ? { previous } : {}), session: ses,
        runId, actor: PR_ACTOR, at, reviewReason,
        checkout: async () => c.fix.checkout?.(c.repo, now.branch, head),
      });
      ledger.hold(ses.kept);
      if (!made.ok) return made;
      const { v, shown } = made;
      const tree = await treeOf(v.patch, shown.flatMap((f) => ("excerpt" in f ? [f.path] : [])));
      if (!tree.ok) return { ok: false, reason: tree.reason };
      const refusal = await made.check(v.patch);
      if (refusal !== null) return { ok: false, reason: refusal.replace(/^rejected: /, "") };
      // Checked here: the collect step has no excerpts to check against.
      const early = outsideShown(shown, await git.diffText(head, tree.tree));
      if (early) return { ok: false, reason: early };
      return { ok: true, patch: v.patch, files: v.files, changed: v.changed, shown, model: made.model, applied: tree };
    };

    /**
     * The fix in the repo's main-fix session: the session edits the tree of its workspace at the head (the failure as its task, or
     * with `lint` the lint findings on its stored change), and the diff that passes the CI fix's gates (the files the log names, no
     * test, no new file, the guard, no line cap) is applied and checked by Opus as a patch is. A workspace that is not ready is a wait:
     * the job does not wait for it, and the lane runs again when the workspace moves (fixWorkspaceReading).
     */
    const fromSession = async (round: number, lint?: { patch: string; findings: string[]; sessionTurn: number | null }): Promise<Made> => {
      const wait = (reason: string): Made => ({ ok: false, reason, wait: true });
      if (!c.fix.session) return wait("fix sessions are on for main-fix, but this job has no fix session environment");
      let env: StepEnv;
      try {
        env = { ...c.fix.session(c.db, c.log), pollReady: false };
      } catch (e) {
        return wait(String((e as Error).message ?? e));
      }
      const scripts = await buildScriptsAt(git, head);
      const failure = { head, checks };
      const allowed = cifixFiles(failure, "", scripts);
      if (!allowed.length) return { ok: false, reason: "the failure names no file a CI fix may edit" };
      const quiet = await culpritQuiet();
      const turn: MainFixTurn = { ref, title, head, ...(quiet && { quiet }), step: "main-fix", failure: logText(failure), allowed };
      const gate: CifixGate = {
        step: "cifix", allowed, scripts, quiet,
        guard: async (patch) => (await guardApplied(git, c.fix.root, head, patch, [])) ?? (patch.length > CHECK_PATCH_CAP ? `the change is over the ${CHECK_PATCH_CAP} character limit for the check` : null),
      };
      const opened = await openSession(c.db, "mainfix", c.repo, MAIN_FIX_ITEM, { head });
      if ("refused" in opened) return wait("the default branch's fix session was refused");
      const base = prStep(c.db, turn, () => gate, lint ? { lint: { findings: lint.findings, patch: lint.patch, parentId: await lintParent(c.db, opened.session, lint.sessionTurn) } } : {});
      // A new red head is a new task on a clean tree, not a branch someone moved; the calls name no item (Fix red main's own routing).
      const spec = { ...base, items: [], message: () => base.message({ moved: null }) };
      let out: StepOutcome;
      try {
        out = await runStep(env, opened.session, spec);
      } catch (e) {
        if (e instanceof WorkspaceUnavailable) return wait(e.message);
        throw e;
      }
      c.log(`  ${c.repo}: fix session ${out.session.id}: ${out.turns.length} turns, ${out.kind}`);
      if (out.kind === "wait") return wait(out.reason);
      count();
      switch (out.kind) {
        case "ended":
        case "failed": return { ok: false, reason: out.reason };
        case "report": return { ok: false, reason: out.report.status === "blocked" ? `blocked: ${out.report.blocked_reason ?? out.report.summary}` : "no cause it can fix" };
        case "empty": return { ok: false, reason: "the session reported a fix and changed nothing" };
        case "refused": return { ok: false, reason: out.problems.join("; ") };
        case "ok": {
          if (out.baseSha !== head) return wait(`the fix session's tree is at ${out.baseSha.slice(0, 8) || "no commit"}, not the head ${head.slice(0, 8)}`);
          const tree = await treeOf(out.gate.patch);
          if (!tree.ok) return { ok: false, reason: tree.reason };
          const checkout = (await c.fix.checkout?.(c.repo, now.branch, head)) ?? undefined;
          const refusal = await opusCheck(c.db, c.fix, { ref, title, repo: c.repo, number: MAIN_FIX_ITEM, head, round, failure, reviewReason, runId, actor: PR_ACTOR, at }, "", checkout, out.gate.patch);
          if (refusal !== null) return { ok: false, reason: refusal.replace(/^rejected: /, "") };
          return { ok: true, patch: out.gate.patch, files: out.gate.files, changed: out.gate.changed, shown: [], model: SESSION_MODEL, applied: tree, sessionTurn: out.turnId };
        }
      }
    };

    let patch: string, patchFiles: string[], changed: number, shown: CifixPr["files"] = [], model = PATCH_MODEL;
    let applied: Awaited<ReturnType<typeof treeOf>>;
    if (w && res) {
      if (res.kind === "infra-failed") {
        const again = w.state === "requeued" ? null : await queueLintFor(c.db, { step: "mainfix", repo: c.repo, number: null, head, base: head, patch: w.patch });
        if (again === null) return await set(live, "fix-failed", `lint: ${res.reason}`);
        await store(w.patch, w.files, again, "requeued", w.round, w.session, w.sessionTurn);
        c.log(`  ${c.repo}: lint task failed (${res.reason}); queued again as task ${again}`);
        return "linting";
      }
      const verdict = res.kind === "result" ? lintVerdict(res.findings, w.round) : null;
      if (res.kind === "result" && (verdict!.action === "clean" || verdict!.action === "push")) {
        dropSessions(w.session);
        const testsNote = testsNoteOf(verdict!, res.testsNote);
        if (testsNote) c.log(`  ${c.repo}: ${testsNote}`);
        const scripts = await buildScriptsAt(git, head);
        const fold = await foldFormat(git, head, w.patch, res.formatDiff ?? "", c.fix.root);
        if (!fold.ok) return await set(live, "fix-failed", fold.reason);
        // A change a fix session made is git's own diff with no line cap; the patch path's keeps the default rules.
        const v = validatePatch(w.patch, w.files, (x) => editable(x, scripts), w.sessionTurn !== null ? CIFIX_SESSION_RULES : undefined);
        if (!v.ok) return await set(live, "fix-failed", v.reason);
        applied = await treeOf(fold.patch);
        ({ patch, patchFiles, changed } = { patch: fold.patch, patchFiles: v.files, changed: v.changed });
      } else {
        const findings = res.kind === "result" ? res.findings : [];
        if (verdict?.action === "fail") return await set(live, "fix-failed", `${findingsWord(findings)} remain after ${w.round} rounds: ${oneLine(verdict.first.message)}`);
        const texts = verdict?.action === "ask" ? verdict.texts : [];
        let ses: SessionAsk = {};
        let made: Made;
        if (sessions) {
          // A change the patch path stored goes on in the fix session; its kept model session is not used again.
          dropSessions(w.session);
          made = await fromSession(w.round + 1, { patch: w.patch, findings: texts, sessionTurn: w.sessionTurn });
          if (!made.ok && made.wait) { c.log(`  ${c.repo}: waiting: ${scrubReason(oneLine(made.reason), c.fix.root)}`); return "waiting"; }
        } else {
          count();
          ses = sessionAsk(w.session, "", texts, new Date(at()));
          made = await generate({ patch: w.patch, findings: texts }, w.round + 1, ses);
          dropSessions(w.session, ses.kept ? { "": ses.kept } : {});
        }
        if (!made.ok) return await noPatch(made.reason);
        ({ patch, files: patchFiles, changed, shown, model, applied } = made);
        const task = await queueLintFor(c.db, { step: "mainfix", repo: c.repo, number: null, head, base: head, patch });
        if (task === null) { /* the new patch changes no Rust file: nothing to lint */ } else {
          await store(patch, patchFiles, task, "pending", w.round + 1, ses.kept ? storeSessions({ "": ses.kept }, new Date(at())) : null, made.sessionTurn ?? null);
          if (ses.kept) ledger.stored({ "": ses.kept });
          c.log(`  ${c.repo}: patch stored; lint task ${task} queued (round ${w.round + 1})`);
          return "linting";
        }
      }
    } else {
      const ses: SessionAsk = {};
      const made = sessions ? await fromSession(1) : await generate(null, 1, ses);
      if (!made.ok && made.wait) { c.log(`  ${c.repo}: waiting: ${scrubReason(oneLine(made.reason), c.fix.root)}`); return "waiting"; }
      if (!made.ok) return await noPatch(made.reason);
      ({ patch, files: patchFiles, changed, shown, model, applied } = made);
      // Like every model patch, this one is linted before it is pushed; the collect step on a later run folds in the formatting or sends findings back.
      const task = await queueLintFor(c.db, { step: "mainfix", repo: c.repo, number: null, head, base: head, patch });
      if (task !== null) {
        await store(patch, patchFiles, task, "pending", 1, ses.kept ? storeSessions({ "": ses.kept }, new Date(at())) : null, made.sessionTurn ?? null);
        if (ses.kept) ledger.stored({ "": ses.kept });
        c.log(`  ${c.repo}: patch stored; lint task ${task} queued (round 1)`);
        return "linting";
      }
    }
    if (!applied.ok) return await set(live, "fix-failed", applied.reason);

    const who = await whoAmI(c.exec);
    const author = await commitIdentity(c.db, c.repo, async () => who);
    await setPipelineLogin(c.db, who.login);
    const commit = await git.commit(applied.tree, head, commitMessage(title, patchFiles), { name: author.name, email: author.email });
    const changes = await git.rawChanges(head, commit);
    const touched = changes.map((x) => x[3]!).sort().join("\n");
    if (changes.some((x) => x[2] !== "M" || x[0] !== x[1] || (x[0] !== "100644" && x[0] !== "100755")) || touched !== [...patchFiles].sort().join("\n"))
      return await set(live, "fix-failed", "the commit would change files or modes outside the validated diff");
    const outside = outsideShown(shown, await git.diffText(head, commit));
    if (outside) return await set(live, "fix-failed", outside);

    // The model calls took minutes: the head is read again before anything is written.
    const again = await c.current();
    if (!again || again.state !== "red" || again.headSha !== head) return await set(live, "nothing-to-do", "main changed while the patch was written");

    const branch = branchFor(names[0]!, head);
    const g = await guardRepo(c.db, c.repo, "main-fix", c.by ?? CLI_BY);
    if ("refused" in g) return await set(live, "fix-failed", g.refused);
    const fork = await forkOf({ db: c.db, login: PR_ACTOR }, g, c.exec, who.login, c.repo);
    const owner = fork.split("/")[0]!;
    const sel = await ownPrSelect(c.db, c.repo, [owner], now.branch);
    const openPr = async (): Promise<string> => {
      const found = await c.exec("gh", ["pr", "list", "--repo", `${slugOf(c.repo)}`, "--state", "open", "--head", branch, "--json", sel.json, "--jq", sel.jq]);
      return found.code === 0 ? found.stdout.trim().split("\n")[0] ?? "" : "";
    };
    let url = await openPr();
    if (!(url && urlOk(url, c.repo))) {
      const push = await pushOwnBranch({ db: c.db, login: PR_ACTOR }, g, git, "main-fix-push", { repo: c.repo, remote: fork, branch, sha: commit }, { fork, head });
      if (push.code !== 0) return await set(live, "fix-failed", `push failed: ${oneLine(push.stderr)}`);
      const body = prBody({ head, checks: live.map((r) => ({ name: r.check, runUrl: r.runUrl })), culprit: now.culprit, culpritPr: now.culpritPr, files: patchFiles, changed });
      const pr = await ghOpenPr({ db: c.db, login: PR_ACTOR }, g, c.exec, "main-fix-pr", { repo: c.repo, target: ref, base: now.branch, head: `${owner}:${branch}`, title, body },
        { by: "model", kind: "pull request", model }, { branch, files: patchFiles });
      url = pr.stdout.trim().split("\n").pop() ?? "";
      // A create whose answer was lost may have opened it.
      if (pr.code !== 0 || !urlOk(url, c.repo)) url = await openPr();
      if (!urlOk(url, c.repo)) return await set(live, "fix-failed", `the pull request was not opened: ${oneLine(pr.stderr || pr.stdout)}`);
    }
    for (const r of live) await c.setState(r, "pr-opened", r.reason, at(), { prNumber: Number(url.split("/").pop()), prUrl: url });
    c.log(`  ${c.repo}: ${names.join(", ")}: opened ${url}`);
    return "opened";
  } catch (e) {
    if (isHalt(e)) throw e;
    return await done("fix-failed", String((e as Error).message ?? e));
  }
}

/**
 * The step on the repo's main-fix session ended (it did not wait): the session's pod is parked, unless a change a turn of that session
 * wrote is stored and waits for its lint task, whose findings go back to the session.
 */
async function endStepPod(c: Ctx): Promise<void> {
  if (!c.fix.session) return;
  let env: StepEnv;
  try {
    env = c.fix.session(c.db, c.log);
  } catch {
    return;
  }
  const pending = async (s: FixSession): Promise<boolean> => {
    const turns = (await loadMainFixes(c.db, { repo: c.repo, states: ["linting"], verdict: "code" })).flatMap((r) => (r.lintTask !== null && r.sessionTurn != null ? [r.sessionTurn] : []));
    return turns.length > 0 && [...(await loadTurns(c.db, turns)).values()].some((t) => t.sessionId === s.id);
  };
  await parkStepPod(env, "mainfix", { repo: c.repo, number: MAIN_FIX_ITEM }, pending, (raw) => scrubReason(oneLine(raw), c.fix.root));
}

/** Takes the repo's `needs-fix` and `linting` rows head by head; `onHandled` is called once per head that reaches the model work. */
export async function openFixPrs(c: Ctx, onHandled?: () => void): Promise<{ opened: number; skipped: number; failed: number; linting: number; issue: number }> {
  const out = { opened: 0, skipped: 0, failed: 0, linting: 0, issue: 0 };
  const rows = await loadMainFixes(c.db, { repo: c.repo, states: ["needs-fix", "linting"], verdict: "code" });
  const byHead = new Map<string, FixRow[]>();
  const ledger = new SessionLedger();
  for (const r of rows) (byHead.get(r.headSha) ?? byHead.set(r.headSha, []).get(r.headSha)!).push(r);
  // Read once per job: a switch flipped meanwhile applies from the next job.
  const sessions = await fixSessionsOn(c.db, "main-fix", c.repo);
  try {
    await sweepSessions(c.db, c.now());
    let stopLogged = false;
    // One group per head, run at once while the model queue has room; the rows of a head stay in one attempt.
    await pool([...byHead.values()].map((group) => async () => {
      if (await c.stopping?.()) {
        if (!stopLogged) { stopLogged = true; c.log(`  ${c.repo}: stopping, no new heads started`); }
        return;
      }
      if (await pushesAreUnsettled(c.db, c.repo, c.log)) return;
      const release = await leaseItem(c.db, `head:${c.repo}@${group[0]!.headSha}`, c.log);
      if (!release) return;
      try {
        // Another job may have moved the rows on before the lease was taken.
        const now = await loadMainFixes(c.db, { repo: c.repo, states: ["needs-fix", "linting"], verdict: "code", head: group[0]!.headSha });
        if (!now.length) return;
        // Rows that turned red after the patch was stored wait until it is collected.
        const stored = now.filter((r) => r.state === "linting");
        const o = await attempt(c, stored.length ? stored : now, () => onHandled?.(), ledger, sessions);
        if (o !== "waiting") out[o]++;
        if (sessions && o !== "waiting") await endStepPod(c);
      } finally { await release(); }
    }), poolRoom(c.db, () => [c.repo], () => []), { max: POOL_MAX.mainfix });
  } finally {
    ledger.release();
  }
  return out;
}
