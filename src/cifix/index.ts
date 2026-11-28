// CI fix: a PR we want whose gate check failed at its reviewed head gets one of three things, by what the log says:
//   format  the formatter runs in a build environment (never on this host) and its diff is pushed; no model;
//   infra   the failed jobs are rerun once per head (the `cifix-rerun` step);
//   code    Sonnet writes a patch from the log and the PR's code, Opus checks it, then it is pushed.
// A branch we can't push to gets the patch as a comment where the repo allows comments. At most two tries per head.
// The log and the PR are untrusted data: nothing from them is run here, and a model only reads them.
//
//   autocraft-server cifix --repo R [--limit N] [--apply]
//   autocraft-server cifix-rerun --repo R [--limit N] [--apply]
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { absolute } from "../build/artifacts.ts";
import { createTask, warmKeyOf } from "../build/tasks.ts";
import { askClaude, POOL_MAX, pool } from "../classify/run.ts";
import { isHalt, poolRoom, takersCut } from "../agents/call.ts";
import { pushesAreUnsettled } from "../fixup/unsettled.ts";
import { audit } from "../dash/audit.ts";
import { finishInfraRerun, finishPatch, loadPatchFacts, recordPushing, startInfraRerun, storePatch } from "../data/changes/index.ts";
import { loadTaskStates } from "../data/build/index.ts";
import { loadArtifactFiles } from "../data/build/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { dropUnlistedPatches } from "../prepush/drop.ts";
import { currentJobId } from "../agents/call.ts";
import { Git, exec, fixupDir, type Exec } from "../fixup/git.ts";
import { DIFF_CAP, FILE_CAP, PR_QUERY, TOTAL_CAP, noteLive, scrubReason, whoAmI, type PrNode } from "../fixup/index.ts";
import { commitIdentity } from "../github/identity.ts";
import { outsideShown, shownSize, viewFile } from "../fixup/excerpt.ts";
import { buildScriptsAt, editable, validatePatch, type BuildScripts } from "../fixup/patch.ts";
import { loadQuiet } from "../data/security/index.ts";
import { patchGiveaway, QUIET_PATCH_REFUSAL } from "../security/rules.ts";
import { readGate } from "../merge/changes-requested.ts";
import { ensureAuthorWrites } from "../fixup/author-permission.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { HOLD_CANNOT_PUSH } from "../fixup/template.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guard, guardClaim, liveOf } from "../core/guard.ts";
import { claimForWork } from "../github/claim.ts";
import { pipelineMe } from "../github/pipeline-account.ts";
import { ghAskComment, ghComment, ghRerunFailed, pushBranch, type Note, type Writer } from "../github/write.ts";
import { Client, type Querier } from "../mirror.ts";
import { ghExec, type Gh } from "../merge/safe-merge.ts";
import { checkLine, parseCheck, recordCheck } from "../patchcheck/index.ts";
import { CHECK_DIFF_CAP, CHECK_PATCH_CAP, type FixupCheckInput } from "../patchcheck/types.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { cachedDiff, ghDiff, type DiffFetcher } from "../review/diff.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { checkoutDiff } from "../fixup/diff-view.ts";
import { MAX_PUSHES_PER_PR, MAX_TRIES_PER_PR, type CifixCandidate } from "./candidates.ts";
import { selectCifix } from "./select.ts";
import { formattingOnly, guardPatch, TEST_PATH } from "./guard.ts";
import { ownFailure } from "../mainci/no-new.ts";
import { askCiText, askText, commentText, commitMessage } from "./template.ts";
import { formatDiffPaths, matchPrFiles, triage, unrelatedTests } from "./triage.ts";
import { CIFIX_ASK_REASON } from "../core/rules.ts";
import { CheckTool, applyCheck, refusal } from "../checktool/index.ts";
import { foldFormat, queueLintFor, readLint } from "../prepush/index.ts";
import { findingsWord, lintVerdict, testsNoteOf } from "../prepush/tests.ts";
import { dropSessions, SessionLedger, sessionAsk, storeSessions, sweepSessions, type SessionAsk } from "../prepush/resume.ts";
import type { LintPrevious } from "../fixup/patch.ts";
import { failureLocations } from "../core/failure-locations.ts";
import type { CiFailure, CifixPr } from "./types.ts";
import { jobItem } from "../runner/job-items.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { leaseItem } from "../runner/leases.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

export { MAX_TRIES, type CifixCandidate } from "./candidates.ts";
export { selectCifix } from "./select.ts";

const ACTOR = "cifix";
const RERUN_ACTOR = "cifix-rerun";
const PROMPT = CLAUDE_PROMPTS["cifix.patch"];
const CHECK = CLAUDE_PROMPTS["fixup.check"];
/** Files shown to the patch model. */
const MAX_FILES = 8;
/** Characters of the failure log the Opus check sees. */
const CHECK_LOG_CAP = 8000;
/** A failure log still unreadable this long after the first unread read of the head is a failed try. */
const UNREAD_END_MS = 24 * 3600_000;

/**
 * The formatter step. /src is a writable overlay inside the step, so the formatted copy is made beside an untouched
 * copy and the unified diff of the two goes to /out. No artifact means nothing to format.
 */
/** Where the build image keeps its Rust toolchain. */
export const IMAGE_CARGO = "/usr/local/cargo";
export const IMAGE_RUSTUP = "/usr/local/rustup";
export const FORMAT_SCRIPT = [
  // `set -f`: the file list is never glob-expanded.
  "set -e", "set -f", "mkdir -p /tmp/w", "cp -a /src /tmp/w/a", "cp -a /src /tmp/w/b", "cd /tmp/w",
  // The PR controls `.cargo/config.toml` (aliases) and `rust-toolchain.toml`: the image's rustfmt runs on the named files
  // directly, by absolute path, from outside the checkout, under an empty environment with the toolchain paths fixed.
  // rustfmt run on a file parses and formats it as its crate's edition, like `cargo fmt`: the nearest Cargo.toml's
  // `edition`, the workspace's for `edition.workspace = true`, 2015 (Cargo's default) when none is set.
  'files="$*"',
  `ed() { sed -n 's/^[[:space:]]*edition[[:space:]]*=[[:space:]]*"\\([0-9]*\\)".*/\\1/p' "$1" | head -n 1; }`,
  'edition_of() { d=$(dirname "b/$1"); while :; do if [ -f "$d/Cargo.toml" ]; then e=$(ed "$d/Cargo.toml"); if [ -n "$e" ]; then echo "$e"; return; fi; if grep -q "^[[:space:]]*edition[.[:space:]]*\\(workspace\\|=[[:space:]]*{\\)" "$d/Cargo.toml"; then e=$(ed b/Cargo.toml); echo "${e:-2015}"; return; fi; if grep -q "^[[:space:]]*\\[package\\]" "$d/Cargo.toml"; then echo 2015; return; fi; fi; [ "$d" = b ] && break; d=$(dirname "$d"); done; echo 2015; }',
  // A named path that is a symlink or resolves outside the checkout is refused, so rustfmt never writes through a link.
  // A file rustfmt cannot parse is listed in fmt-err.txt (an `@@ path` line, then rustfmt's output) and the run goes on.
  ": > /tmp/w/fmt-err.txt",
  `for f in $files; do r=$(realpath -- "b/$f" 2>/dev/null || true); case "$r" in /tmp/w/b/*) ;; *) printf '%s\\n' "@@ $f" "refused: the path is a symlink or leaves the checkout" >> /tmp/w/fmt-err.txt; continue;; esac; if ! o=$(env -i PATH=${IMAGE_CARGO}/bin:/usr/bin:/bin HOME=/tmp RUSTUP_HOME=${IMAGE_RUSTUP} CARGO_HOME=${IMAGE_CARGO} ${IMAGE_CARGO}/bin/rustfmt --edition "$(edition_of "$f")" "b/$f" 2>&1); then printf '%s\\n' "@@ $f" "$o" >> /tmp/w/fmt-err.txt; fi; done`,
  "if [ -s /tmp/w/fmt-err.txt ]; then cp /tmp/w/fmt-err.txt /out/fmt-err.txt; fi",
  ": > /tmp/w/format.txt",
  'for f in $files; do if ! cmp -s "a/$f" "b/$f"; then echo "diff -uN a/$f b/$f" >> /tmp/w/format.txt; diff -uN "a/$f" "b/$f" >> /tmp/w/format.txt || true; fi; done',
  "if [ -s /tmp/w/format.txt ]; then cp /tmp/w/format.txt /out/format.txt; fi",
].join("; ");
/** The most files one formatter run names. */
const FORMAT_FILES_MAX = 20;
export const FORMAT_ARTIFACT = "format.txt";

export type CifixDeps = {
  querier: Querier;
  /** Every git and gh write command. */
  exec: Exec;
  fetchDiff: DiffFetcher;
  /** Reads from GitHub (`gh` arguments): the failed check runs and their logs. */
  gh: Gh;
  /** The model's reply to the cifix.patch prompt, or null when it gave none. */
  ask: (db: Db, input: CifixPr[], checkout?: string, tool?: CheckTool, session?: SessionAsk) => Promise<string | null>;
  /** The model's reply to the fixup.check prompt (Opus), or null when it gave none. */
  check: (db: Db, input: FixupCheckInput[], checkout?: string) => Promise<string | null>;
  /** Host directory with a read-only checkout of the PR head for the sandboxed model calls, or null to ask without tools. */
  checkout?: (repo: string, number: number, head: string) => Promise<string | null>;
  now: () => Date;
  /** Directory holding one bare cache repository per repo. */
  root: string;
  /** Stands in for the app lane's token and client (tests). */
  lane?: Pick<Writer, "mint" | "appClient">;
};

/** The note for a comment about a model-written patch. */
const codeNote: Note = { by: "model", kind: "comment", model: PROMPT.models[0] };

export function defaultDeps(): CifixDeps {
  return {
    querier: new Client(1000), exec, fetchDiff: ghDiff, gh: ghExec, now: () => new Date(), root: fixupDir(),
    ask: async (db, input, checkout, tool, session) => (await askClaude("cifix.patch", PROMPT.models[0]!, input, db, { checkout, check: tool, session }))?.text ?? null,
    check: async (db, input, checkout) => (await askClaude("fixup.check", CHECK.models[0]!, input, db, { checkout }))?.text ?? null,
    checkout: (r, n, h) => checkoutForPr(r, n, h, console.log),
  };
}

export type CifixParams = { repo: string; limit?: number; /** Only PRs approved for merge (the step's approved job), or only the others; absent: every PR. */ approved?: boolean; /** Only this PR. */ number?: number; /** True when no new item should start (cancel, deadline, pipeline off). */ stopping?: () => Promise<boolean>; /** Default true. */ dryRun?: boolean; onHandled?: (n: number) => void; /** Who asked; default: an operator at the command line. */ by?: By };
export type CifixSummary = {
  runId: string; repo: string; dryRun: boolean;
  pushed: string[]; asked: string[]; queued: string[]; infra: string[]; skipped: string[];
  failed: { ref: string; reason: string }[]; held: { ref: string; reason: string }[];
  /** Asks that threw: nothing is stored for them, so the next job tries them again. */
  unasked: { ref: string; reason: string }[];
};

const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** The formatter's `diff -ruN a b` output as a git-format diff, which validatePatch and `git apply` read. */
export function gitFormatDiff(text: string): string {
  return text.split("\n").map((l) => {
    const m = /^diff .* a\/(\S+) b\/(\S+)$/.exec(l);
    if (m) return `diff --git a/${m[1]} b/${m[2]}`;
    return l.startsWith("--- ") || l.startsWith("+++ ") ? l.replace(/\t.*$/, "") : l;
  }).join("\n");
}

const DIFF_FILE = /^diff --git a\/(\S+) b\/\S+$/gm;
/** The Rust files a failure's compiler errors name (failureLocations), first seen first. */
export function errorFiles(log: string): string[] {
  return [...new Set(failureLocations(log).filter((x) => x.what === "error" && x.file.endsWith(".rs")).map((x) => x.file))];
}

/** The files a failure's panics name. */
const panicFiles = (log: string): string[] => [...new Set(failureLocations(log).filter((x) => x.what === "panic").map((x) => x.file))];

type Fix = { patch: string; files: string[]; changed: number };

class Recorder {
  private db: Db;
  private at: () => string;
  constructor(db: Db, at: () => string) {
    this.db = db;
    this.at = at;
  }

  /** Written before the push: the commit about to be pushed, so a crash between the push and its record leaves the head in the push chain. */
  async pushing(c: CifixCandidate, kind: "format" | "code", commit: string, files: string[]): Promise<void> {
    await recordPushing(this.db, { kind: "cifix", repo: c.repo, number: c.number, head: c.head, commit, files, attempt: c.attempt, ciKind: kind, at: this.at() });
  }

  /** The model patch waits for its lint task: a first row, or the same row with the next round's patch and task. No task: a patch without a Rust file kept for posting again. */
  async linting(c: CifixCandidate, patch: string, files: string[], task: number | null, lintState: "pending" | "requeued", round: number, session: string | null): Promise<void> {
    await storePatch(this.db, { kind: "cifix", storedId: c.lint?.rowid, repo: c.repo, number: c.number, head: c.head, patch, files, lintTask: task, lintRound: round, lintState, session, attempt: c.attempt, at: this.at() });
  }

  /** Stored patches whose Plan no longer lists the push (head moved, a Hold or Close answer, approval revoked) are dropped. */
  async dropUnlisted(repo: string, listed: number[]): Promise<void> {
    await dropUnlistedPatches(this.db, "cifix", repo, new Set(listed));
  }

  /**
   * One ci_fixes row. A formatter run keeps its `formatting` row and the result replaces its state. Every outcome
   * but the waiting states also notes the PR's stage, so the item page and the queue say what happened.
   */
  async set(c: CifixCandidate, kind: "format" | "code" | "infra", state: string, reason: string | null, o: { files?: string[]; toHead?: string | null; task?: number | null; runs?: number[] } = {}): Promise<void> {
    const at = this.at();
    const quiet = state === "infra" || state === "formatting" || state === "rerun" || state === "rerunning" || state === "unread";
    const note = state === "pushed" ? `CI fix pushed at ${short(c.head)}: ${(o.files ?? []).join(", ")}`
      : state === "skipped" ? `CI fix skipped at ${short(c.head)}: ${reason}`
      : state === "asked" && reason === CIFIX_ASK_REASON ? `asked the contributor to fix CI at ${short(c.head)}`
      : state === "asked" ? `posted a CI fix at ${short(c.head)}: ${(o.files ?? []).join(", ")}` : `CI fix ${state} at ${short(c.head)}: ${reason}`;
    await finishPatch(this.db, {
      kind: "cifix", repo: c.repo, number: c.number, head: c.head, state, reason, files: o.files ?? [], toHead: o.toHead ?? null, task: o.task ?? null, runs: o.runs ?? null, attempt: c.attempt, ciKind: kind, at,
      note: quiet ? null : { repo: c.repo, number: c.number, stage: "take", at, actor: ACTOR, note },
      jobNote: quiet ? null : note, jobId: currentJobId(),
    });
  }
}

/** The failure text the models and the check see: every failed step's tail, with its check and step names. */
export function logText(f: CiFailure): CifixPr["failure"] {
  return f.checks.map((c) => ({ check: c.name, steps: c.steps.map((s) => ({ job: s.job, step: s.step, log: s.tail })) }));
}

const failureText = (f: CiFailure): string => f.checks.flatMap((x) => x.steps.map((s) => s.tail)).join("\n");

/**
 * The files a CI fix may edit: the files a compiler error points at first, then the files the diff changes, then the files a panic
 * points at, at most MAX_FILES; nothing else, and never a test file.
 */
export function cifixFiles(failure: CiFailure, diffText: string, scripts: BuildScripts): string[] {
  const text = failureText(failure);
  return [...new Set(errorFiles(text).concat([...diffText.matchAll(DIFF_FILE)].map((m) => m[1]!), panicFiles(text)))]
    .filter((p) => editable(p, scripts) && !TEST_PATH.test(p)).slice(0, MAX_FILES);
}

/** What `patchFromFailure` needs to know about the commit and the failure it patches. */
export type PatchRequest = {
  git: Git;
  /** The patch is for a quiet pull request even though `number` names none (a default-branch fix whose culprit is one). */
  quiet?: boolean;
  /** How the models and the audit log name the subject, for example `repo#12`. */
  ref: string;
  title: string;
  repo: string;
  /** Recorded with the Opus check (0 for a default-branch head). */
  number: number;
  /** The commit the patch applies to. */
  head: string;
  /** The default-branch commit the check tool's tasks take their CI gate from (the PR's base, or `head` on the default branch). */
  base: string | null;
  /** The fix round or try. */
  round: number;
  failure: CiFailure;
  /** The unified diff of the change under repair; empty when there is none. */
  diffText: string;
  runId: string;
  actor: string;
  at: () => string;
  /** What the Opus check is told the patch is for; default: a pull request's failing check. */
  reviewReason?: string;
  /** An earlier patch that failed the lint check, with the findings on its lines. */
  previous?: LintPrevious;
  /** Continues the kept session that wrote `previous`; the call reports the session it ends with. */
  session?: SessionAsk;
  /** The read-only checkout of `head` for the model calls, or nothing to ask without tools. */
  checkout: () => Promise<string | null | undefined>;
};

export type PatchResult =
  | { ok: false; state: "failed" | "refused"; reason: string }
  | { ok: true; v: { patch: string; files: string[]; changed: number }; shown: CifixPr["files"]; names: string[]; model: string; check: (patch: string) => Promise<string | null> };

/**
 * The guard (see guardPatch) on the patch as git applies it at `head`: the patched tree is built in a scratch index under
 * `root`, and git's own diff and the files before and after it are judged.
 */
export async function guardApplied(git: Git, root: string, head: string, patch: string, exact: string[]): Promise<string | null> {
  const scratch = mkdtempSync(join(root, ".index-"));
  let applied;
  try {
    applied = await git.applyToTree(head, patch, join(scratch, "index"), exact);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return applied.ok ? guardTree(git, head, applied.tree) : applied.reason;
}

/** The guard on the change from commit `head` to `tree`. */
async function guardTree(git: Git, head: string, tree: string): Promise<string | null> {
  const diff = await git.diffText(head, tree);
  const sides = new Map<string, { before: string; after: string }>();
  for (const m of diff.matchAll(/^diff --git a\/(\S+) b\//gm)) {
    const before = await git.file(head, m[1]!), after = await git.file(tree, m[1]!);
    if (!before.ok || !after.ok) return `the content of ${m[1]} could not be read to check it`;
    sides.set(m[1]!, { before: before.content, after: after.content });
  }
  return guardPatch(diff, sides);
}

/**
 * The model patch for a failed check at `head`: the files the log names (and the diff's files) are shown whole or in
 * part, Sonnet writes the patch, and the validators and the size limit run. `check` is the Opus check: null when it
 * approves, else the refusal (`rejected: ...` when Opus said no).
 */
export async function patchFromFailure(db: Db, d: Pick<CifixDeps, "ask" | "check" | "root">, r: PatchRequest): Promise<PatchResult> {
  const no = (state: "failed" | "refused", reason: string): PatchResult => ({ ok: false, state, reason });
  const { git, ref, title, repo, head, failure } = r;
  const text = failureText(failure);
  const scripts = await buildScriptsAt(git, head);
  const cited = errorFiles(text);
  const named = cifixFiles(failure, r.diffText, scripts);
  // With a sandbox checkout the model reads the files itself, so they are listed by path and no size limit applies.
  const checkout = (await r.checkout()) ?? undefined;
  if (!checkout && r.diffText.length > DIFF_CAP) return no("failed", `the PR diff is over the ${DIFF_CAP} character limit and no checkout could be made`);
  // The model and the patch check read the same diff: with a checkout, one over the cap keeps the sections of the files the log names.
  const diffText = checkout ? checkoutDiff(r.diffText, new Set(cited), Math.min(DIFF_CAP, CHECK_DIFF_CAP)) : r.diffText;
  const repoDir = checkout ? { repo_dir: REPO_PATH } : {};
  const shown: CifixPr["files"] = [];
  let total = 0;
  for (const path of named) {
    const f = await git.file(head, path);
    if (!f.ok) continue;
    if (checkout) { shown.push({ path }); continue; }
    // The log lines that mention the file give the lines a large file is cut around.
    const v = viewFile(path, f.content, text.split("\n").filter((l) => l.includes(path)), r.diffText, FILE_CAP);
    if (!v.ok) return no("failed", v.reason);
    total += shownSize(v.file);
    if (total > TOTAL_CAP) return no("failed", "the parts of the files the failure names are over the size limit");
    shown.push(v.file);
  }
  if (!shown.length) return no("failed", "the failure names no file a CI fix may edit");
  const quiet = !!r.quiet || (await loadQuiet(db, [`${repo}#${r.number}`])).size > 0;
  const tool = new CheckTool({ db, step: "cifix", repo, number: r.number || null, head, base: r.base, applies: applyCheck(git, d.root, head, (p) => refusal(validatePatch(p, shown.map((s) => s.path), (x) => editable(x, scripts)))) });
  const reply = await d.ask(db, [{ ref, title, failure: logText(failure), ...(quiet ? { quiet } : {}), files: shown, diff: diffText, ...(r.previous ? { previous: r.previous } : {}), ...repoDir }], checkout, tool, r.session);
  if (reply === null) return no("failed", "the model gave no answer");
  const v = validatePatch(reply, shown.map((s) => s.path), (x) => editable(x, scripts));
  if (!v.ok) return no("refused", v.reason);
  const word = quiet ? patchGiveaway(v.patch) : null;
  if (word) return no("refused", QUIET_PATCH_REFUSAL);
  const guard = await guardApplied(git, d.root, head, v.patch, shown.flatMap((f) => ("excerpt" in f ? [f.path] : [])));
  if (guard) return no("refused", guard);
  if (v.patch.length > CHECK_PATCH_CAP) return no("refused", `the patch is over the ${CHECK_PATCH_CAP} character limit for the check`);
  const names = failure.checks.map((x) => x.name);
  const check = async (patch: string): Promise<string | null> => {
    const input: FixupCheckInput = {
      ref, title, fixes: [], diff: diffText.slice(0, CHECK_DIFF_CAP), patch, ...repoDir,
      review_reason: r.reviewReason ?? `The check ${names.join(", ")} fails at this head. The patch must make it pass without changing what the pull request does.`,
      ci_failure: { checks: names, log: JSON.stringify(logText(failure)).slice(0, CHECK_LOG_CAP) },
    };
    const reply2 = await d.check(db, [input], checkout);
    if (reply2 === null) return "the patch check gave no answer";
    const verdict = parseCheck(reply2);
    if (!verdict.ok) return `the patch check gave no valid answer: ${verdict.error}`;
    await recordCheck(db, { kind: "fixup", repo, number: r.number, subject: head, patch, round: r.round, model: CHECK.models[0]!, check: verdict.check, at: r.at() });
    await audit(db, r.actor, "cifix-check", ref, { run: r.runId, head, verdict: verdict.check.verdict, reasons: verdict.check.reasons });
    return verdict.check.verdict === "reject" ? `rejected: Opus rejected the patch: ${checkLine(verdict.check)}` : null;
  };
  return { ok: true, v, shown, names, model: PROMPT.models[0]!, check };
}

export async function runCifix(db: Db, params: CifixParams, log: (line: string) => void = console.log, deps?: CifixDeps): Promise<CifixSummary> {
  const ledger = new SessionLedger();
  try {
    if (!(params.dryRun ?? true)) await sweepSessions(db, deps?.now() ?? new Date());
    return await runCifixWith(db, params, log, deps, ledger);
  } finally {
    ledger.release();
  }
}

async function runCifixWith(db: Db, params: CifixParams, log: (line: string) => void, deps: CifixDeps | undefined, ledger: SessionLedger): Promise<CifixSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const runId = `cifix-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  const summary: CifixSummary = { runId, repo, dryRun, pushed: [], asked: [], queued: [], infra: [], skipped: [], failed: [], held: [], unasked: [] };
  const sel = await selectCifix(db, repo, undefined, undefined, params.by, params.approved, params.number);
  const collect = params.limit === undefined ? sel.collect : sel.collect.slice(0, params.limit);
  const work = await takersCut(db, sel.work, params.limit === undefined ? undefined : params.limit - collect.length, repo, (c) => c.number);
  log(`cifix ${repo}: ${sel.work.length} PRs with a failing check to read, ${sel.collect.length} formatter results to apply, ${sel.rerun.length} reruns due`);
  if (dryRun) {
    for (const x of collect) log(`  would apply the formatter result for ${refOf(x.c)} at ${short(x.c.head)}`);
    for (const c of work) log(`  would read the failure of ${refOf(c)} at ${short(c.head)} (try ${c.attempt}, ${c.route})`);
    log(`cifix ${repo}: dry run, nothing called or written`);
    return summary;
  }
  const d = deps ?? defaultDeps();
  const rec = new Recorder(db, at);
  await rec.dropUnlisted(repo, sel.listed);
  const gw: Writer = { db, login: ACTOR, ...d.lane };
  const git = new Git(d.exec, d.root, repo);
  const titles = new Map([...await loadItems(db, [...sel.work, ...sel.collect.map((x) => x.c), ...sel.lint].map((c) => ({ repo: c.repo, number: c.number })), "card")].map(([k, r]) => [k, (r.title ?? "").slice(0, 300)]));
  const titleOf = (c: { repo: string; number: number }) => titles.get(refOf(c)) ?? "";
  let whoP: ReturnType<typeof whoAmI> | undefined;
  let handled = 0;

  /** Why `readPr` returned null for a PR; items run at once, so it is kept per PR. */
  const gone = new Map<number, string>();
  const readPr = async (c: CifixCandidate): Promise<PrNode | null> => {
    const r = await d.querier.query(PR_QUERY, { owner: ownerOf(repo), name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
    const pr = r.repository?.pullRequest;
    await noteLive(db, repo, c.number, pr, at());
    if (!pr || pr.state !== "OPEN" || pr.isDraft) { const why = "no longer an open, non-draft PR"; gone.set(c.number, why); log(`  ${refOf(c)}: skipped: ${why}`); return null; }
    if (pr.headRefOid !== c.head) { const why = `head moved to ${short(pr.headRefOid)} since the checks ran`; gone.set(c.number, why); log(`  ${refOf(c)}: skipped: ${why}`); return null; }
    return pr;
  };

  const isQuiet = async (number: number): Promise<boolean> => (await loadQuiet(db, [`${repo}#${number}`])).size > 0;
  /** Applies a validated patch to the PR head: pushed to the branch, or posted as a comment where the branch is closed to us. */
  const deliver = async (c: CifixCandidate, kind: "format" | "code", pr: PrNode, v: Fix, checkName: string, check?: (patch: string) => Promise<string | null>, shown: CifixPr["files"] = [], folded: string | null = null, ses: SessionAsk = {}): Promise<void> => {
    const ref = refOf(c);
    const fail = async (state: "failed" | "refused" | "rejected" | "superseded", raw: string) => {
      const reason = scrubReason(raw, d.root);
      await rec.set(c, kind, state, reason, { files: v.files });
      summary.failed.push({ ref, reason });
      log(`  ${ref}: ${state}: ${reason}`);
    };
    const writes = pr.headRepository ? await ensureAuthorWrites(db, repo, c.number, pr.headRepository.nameWithOwner) : "no";
    if (writes === "unknown") { log(`  ${ref}: skipped: the author's permission could not be read yet`); return; }
    // A patch planned as a comment is not pushed without an approval of the push, also when the branch is open to us by now.
    const canPush = c.mayPush && !!pr.headRepository && pushable(pr.headRepository.nameWithOwner, repo, pr.maintainerCanModify, pr.headRefName, await longLivedOf(db, repo), !!pr.headRef?.branchProtectionRule, writes === "yes");
    if (!canPush && (!c.mayComment || await isQuiet(c.number))) {
      await rec.set(c, kind, "cannot-push", HOLD_CANNOT_PUSH, { files: v.files });
      summary.held.push({ ref, reason: HOLD_CANNOT_PUSH });
      log(`  ${ref}: held: ${HOLD_CANNOT_PUSH}`);
      return;
    }
    const head = await git.fetchPr(ownerOf(repo), repo, c.number);
    if (head !== c.head) {
      await noteLive(db, repo, c.number, { ...pr, headRefOid: head }, at());
      await fail("failed", `fetched head ${short(head)} is not the checked ${short(c.head)}`);
      return;
    }
    const scratch = mkdtempSync(join(d.root, ".index-"));
    let applied;
    try {
      applied = await git.applyToTree(head, folded ?? v.patch, join(scratch, "index"), shown.flatMap((f) => ("excerpt" in f ? [f.path] : [])));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (!applied.ok) { await fail("refused", applied.reason); return; }
    if (kind === "format") {
      // Formatting alone, whatever produced the diff: the same limits as any patch, and by tokens on the whole files before and after.
      const guard = await guardTree(git, head, applied.tree);
      if (guard) { await fail("refused", guard); return; }
      for (const f of v.files) {
        const before = await git.file(head, f), after = await git.file(applied.tree, f);
        const why = !before.ok ? before.reason : !after.ok ? after.reason : formattingOnly(f, before.content, after.content);
        if (why) { await fail("refused", why); return; }
      }
    }
    if (check) {
      const refusal = await check(v.patch);
      if (refusal !== null) { await fail(refusal.startsWith("rejected:") ? "rejected" : "failed", refusal.replace(/^rejected: /, "")); return; }
    }
    // The model calls took minutes: read the PR again before writing.
    const now = await readPr(c);
    if (!now) { await fail("failed", gone.get(c.number) ?? ""); return; }
    // A maintainer's changes request may have come in during the model calls; an unreadable answer counts as blocked.
    const blocked = await readGate(db, d.querier, ownerOf(repo), repo, c.number, log);
    if (blocked !== null) {
      const reason = blocked ?? "the PR's reviews could not be read";
      await rec.set(c, kind, "skipped", reason, { files: v.files });
      summary.skipped.push(ref);
      log(`  ${ref}: skipped: ${reason}`);
      return;
    }
    const g = await guard(db, { repo, number: c.number }, c.lint ? { kind: "lint", bucket: "cifix", head: c.head, source: "review" } : { kind: "cifix", bucket: kind === "format" ? "collect" : "work", head: c.head }, params.by ?? CLI_BY, liveOf(db, d.querier));
    if ("refused" in g) {
      // Nothing is recorded: the head is tried again once the refusal's reason is gone.
      summary.skipped.push(ref);
      log(`  ${ref}: skipped: ${g.refused}`);
      return;
    }
    // A model patch is stored and linted before it is pushed or posted (the collect step does that); a patch without a Rust file needs no lint.
    if (kind === "code" && folded === null) {
      // Checked here: the collect step has no excerpts to check against.
      const early = outsideShown(shown, await git.diffText(head, applied.tree));
      if (early) { await fail("refused", early); return; }
      const round = c.lint ? c.lint.round + 1 : 1;
      const task = await queueLintFor(db, { step: "cifix", repo, number: c.number, head: c.head, base: now.baseRefOid ?? null, patch: v.patch });
      if (task !== null) {
        await rec.linting(c, v.patch, v.files, task, "pending", round, ses.kept ? storeSessions({ "": ses.kept }, new Date(at())) : null);
        if (ses.kept) ledger.stored({ "": ses.kept });
        log(`  ${ref}: patch stored; lint task ${task} queued (round ${round})`);
        return;
      }
    }
    if (!canPush) {
      const shownPatch = folded ?? v.patch;
      const cm = await ghAskComment(gw, d.exec, "cifix-comment", g, codeNote, askText(checkName, shownPatch), { run: runId, head: c.head });
      if (cm.code !== 0) {
        // Not sent: nothing reached GitHub, so the step tries again after a backoff. Otherwise GitHub may have posted it.
        const reason = `the comment ${cm.sent === false ? "was not sent" : "failed"}: ${scrubReason(oneLine(cm.stderr), d.root)}`;
        // A patch that needed no lint task is stored in place of any earlier round's, so the retry posts it without new model work.
        if (cm.sent === false && kind === "code" && folded === null) await rec.linting(c, v.patch, v.files, null, "pending", c.lint ? c.lint.round + 1 : 1, null);
        await rec.set(c, kind, cm.sent === false ? "comment-unsent" : "comment-failed", reason, { files: v.files });
        summary.failed.push({ ref, reason });
        log(`  ${ref}: ${reason}`);
        return;
      }
      await rec.set(c, kind, "asked", null, { files: v.files });
      summary.asked.push(ref);
      log(`  ${ref}: posted the patch as a comment at ${short(c.head)}`);
      return;
    }
    const who = await (whoP ??= whoAmI(d.exec));
    const author = await commitIdentity(db, repo, async () => who);
    const commit = await git.commit(applied.tree, head, commitMessage(kind, v.files), { name: author.name, email: author.email });
    const changes = await git.rawChanges(head, commit);
    const touched = changes.map((x) => x[3]!).sort().join("\n");
    if (changes.some((x) => x[2] !== "M" || x[0] !== x[1] || (x[0] !== "100644" && x[0] !== "100755")) || touched !== [...v.files].sort().join("\n")) {
      await fail("refused", "the commit would change files or modes outside the validated diff");
      return;
    }
    const outside = outsideShown(shown, await git.diffText(head, commit));
    if (outside) { await fail("refused", outside); return; }
    await rec.pushing(c, kind, commit, v.files);
    const push = await pushBranch(gw, git, "cifix-push", g, { remote: pr.headRepository!.nameWithOwner, branch: pr.headRefName, sha: commit }, { run: runId, from: head, to: commit, files: v.files, changed: v.changed, kind });
    if (push.code !== 0) {
      const err = oneLine(push.stderr);
      // Another push came first: the try says nothing about the fix, and the new head gets its own.
      if (/stale info/i.test(err)) await fail("superseded", "the branch moved before the push");
      else if (/rejected|fetch first/i.test(err)) await fail("refused", "the branch moved since the checks ran");
      else if (/denied|403|permission|not allowed|protected branch|declined|GH013/i.test(err)) {
        await rec.set(c, kind, "push-denied", HOLD_CANNOT_PUSH, { files: v.files });
        summary.held.push({ ref, reason: HOLD_CANNOT_PUSH });
        log(`  ${ref}: held: ${HOLD_CANNOT_PUSH}`);
      } else await fail("failed", `push failed: ${err}`);
      return;
    }
    await rec.set(c, kind, "pushed", null, { files: v.files, toHead: commit });
    summary.pushed.push(ref);
    log(`  ${ref}: pushed ${short(commit)} on ${short(head)}: ${v.files.join(", ")}`);
    // The push is recorded: a comment that throws must not record the fix as failed.
    try {
      const cm = await ghComment(gw, g, d.exec, "cifix-comment", { repo, number: c.number, pr: true }, kind === "format" ? { by: "fixed" } : codeNote, commentText(v.files), { run: runId, to: commit });
      if (cm.code !== 0) log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
    } catch (e) {
      if (isHalt(e)) throw e;
      log(`  ${ref}: comment failed: ${scrubReason(oneLine(String((e as Error).message ?? e)), d.root)}`);
    }
  };

  /** The formatter task ended: its diff, if any, is validated and delivered. Every exit records a state, which closes the `formatting` row. */
  const collectFormat = async (c: CifixCandidate, taskId: number): Promise<void> => {
    const ref = refOf(c);
    const scripts = await buildScriptsAt(git, c.head);
    const t = (await loadTaskStates(db, [taskId])).get(taskId);
    const fail = async (state: "failed" | "refused", reason: string) => { await rec.set(c, "format", state, reason); summary.failed.push({ ref, reason }); log(`  ${ref}: ${state}: ${reason}`); };
    if (!t || t.state !== "done") { await fail("failed", `the formatter task ${t?.state ?? "is gone"}`); return; }
    // The files the formatter was told to format: the PR's files that the log's `Diff in` lines name.
    const [facts, artifacts] = await db.together(() => Promise.all([loadPatchFacts(db, [{ repo: c.repo, number: c.number }]), loadArtifactFiles(db, [{ taskId, name: FORMAT_ARTIFACT }])]));
    const allowed = facts.get(refOf(c))?.cifixes.find((r) => r.head === c.head && r.state === "formatting")?.files ?? [];
    const file = artifacts.get(`${taskId}/${FORMAT_ARTIFACT}`);
    const path = file ? absolute(file) : null;
    if (!path) { await fail("failed", "the formatter changed nothing, so the failure is not formatting"); return; }
    const text = gitFormatDiff(readFileSync(path, "utf8"));
    const v = validatePatch(text, allowed, (x) => editable(x, scripts));
    if (!v.ok) { await fail("refused", v.reason); return; }
    const pr = await readPr(c);
    if (!pr) { await fail("failed", gone.get(c.number) ?? ""); return; }
    params.onHandled?.(++handled);
    await deliver(c, "format", pr, v, "format", undefined);
  };

  /** Sonnet patches the code from the log, Opus checks the patch. */
  /** The CI fix starts work on the PR (a model patch or a formatter run): the pipeline's account is assigned when nobody is. */
  const claim = async (c: CifixCandidate): Promise<void> => {
    const g = await guardClaim(db, { repo, number: c.number }, { kind: "cifix", bucket: "work" }, params.by ?? CLI_BY);
    if (!("refused" in g)) await claimForWork({ db, login: ACTOR }, g, d.querier, repo, c.number, "pr", () => pipelineMe(log, d.exec), { run: runId }, log);
  };
  const fixCode = async (c: CifixCandidate, pr: PrNode, failure: CiFailure, previous?: LintPrevious, ses: SessionAsk = {}): Promise<void> => {
    const ref = refOf(c);
    await claim(c);
    const fail = async (state: "failed" | "refused", raw: string) => {
      const reason = scrubReason(raw, d.root);
      await rec.set(c, "code", state, reason);
      summary.failed.push({ ref, reason });
      log(`  ${ref}: ${state}: ${reason}`);
    };
    const head = await git.fetchPr(ownerOf(repo), repo, c.number);
    if (head !== c.head) { await noteLive(db, repo, c.number, { ...pr, headRefOid: head }, at()); await fail("failed", `fetched head ${short(head)} is not the checked ${short(c.head)}`); return; }
    const diff = await cachedDiff(db, repo, c.number, head, d.fetchDiff);
    if (!diff.ok) { await fail("failed", `no diff: ${oneLine(diff.error)}`); return; }
    // With a checkout the model reads a trimmed diff (patchFromFailure); without one, a diff over the cap gets no patch.
    if (!d.checkout && diff.text.length > DIFF_CAP) { await fail("failed", `the PR diff is over the ${DIFF_CAP} character limit`); return; }
    const made = await patchFromFailure(db, d, { git, ref, title: titleOf(c),
      repo, number: c.number, head, base: pr.baseRefOid ?? null, round: c.attempt, failure, diffText: diff.text, ...(previous ? { previous } : {}), session: ses, runId, actor: ACTOR, at, checkout: async () => d.checkout?.(repo, c.number, head) });
    ledger.hold(ses.kept);
    if (c.lint) dropSessions(c.lint.session, ses.kept ? { "": ses.kept } : {});
    if (!made.ok) { await fail(made.state, made.reason); return; }
    const { v, shown, names, check } = made;
    await deliver(c, "code", pr, v, names[0] ?? "CI", check, shown, null, ses);
  };

  /**
   * A stored patch whose lint task ended: clean, the patch with the format changes folded in is pushed (or posted); with
   * findings, the model is asked again with them, up to LINT_MAX_ROUNDS lint rounds; a lost task is queued once more.
   */
  const collectLint = async (c: CifixCandidate): Promise<void> => {
    const ref = refOf(c);
    const w = c.lint!;
    const scripts = await buildScriptsAt(git, c.head);
    const fail = async (state: "failed" | "refused" | "rejected", raw: string) => {
      const reason = scrubReason(raw, d.root);
      await rec.set(c, "code", state, reason, { files: w.files });
      summary.failed.push({ ref, reason });
      log(`  ${ref}: ${state}: ${reason}`);
    };
    if (w.task === null) {
      // Kept when its comment did not reach GitHub (no Rust file, so no lint task): posted again as it is.
      const pr = await readPr(c);
      if (!pr) return;
      params.onHandled?.(++handled);
      const v = validatePatch(w.patch, w.files, (x) => editable(x, scripts));
      if (!v.ok) { await fail("refused", v.reason); return; }
      await deliver(c, "code", pr, v, "CI", undefined, [], w.patch);
      return;
    }
    const res = await readLint(db, w.task);
    if (res.kind === "pending") { log(`  ${ref}: the lint task is still running`); return; }
    const pr = await readPr(c);
    if (!pr) return;
    params.onHandled?.(++handled);
    if (res.kind === "infra-failed") {
      const again = w.state === "requeued" ? null : await queueLintFor(db, { step: "cifix", repo, number: c.number, head: c.head, base: pr.baseRefOid ?? null, patch: w.patch });
      if (again === null) { await fail("failed", `lint: ${res.reason}`); return; }
      await rec.linting(c, w.patch, w.files, again, "requeued", w.round, w.session);
      log(`  ${ref}: lint task failed (${res.reason}); queued again as task ${again}`);
      return;
    }
    const verdict = lintVerdict(res.findings, w.round);
    if (verdict.action === "clean" || verdict.action === "push") {
      dropSessions(w.session);
      const testsNote = testsNoteOf(verdict, res.testsNote);
      if (testsNote) await jobItem(db, repo, c.number, testsNote, log);
      const fold = await foldFormat(git, c.head, w.patch, res.formatDiff ?? "", d.root);
      if (!fold.ok) { await fail("refused", fold.reason); return; }
      const v = validatePatch(w.patch, w.files, (x) => editable(x, scripts));
      if (!v.ok) { await fail("refused", v.reason); return; }
      await deliver(c, "code", pr, v, "CI", undefined, [], fold.patch);
      return;
    }
    if (verdict.action === "fail") { await fail("rejected", `${findingsWord(res.findings)} remain after ${w.round} rounds: ${oneLine(verdict.first.message)}`); return; }
    const reading = await ownFailure(db, d.gh, repo, c.number, c.head);
    if (reading.kind !== "failure") { await fail("failed", reading.why); return; }
    const findings = verdict.texts;
    await fixCode(c, pr, reading.failure, { patch: w.patch, findings }, sessionAsk(w.session, "", findings, new Date(at())));
  };

  const workOne = async (c: CifixCandidate): Promise<void> => {
    const ref = refOf(c);
    try {
      const pr = await readPr(c);
      if (!pr) return;
      // A PR that only waits for rerun results is not counted as handled (it does not use the step's limit).
      const handle = () => params.onHandled?.(++handled);
      const reading = await ownFailure(db, d.gh, repo, c.number, c.head);
      const skip = async (why: string) => { await rec.set(c, "code", "skipped", why); summary.skipped.push(ref); log(`  ${ref}: skipped: ${why}`); };
      if (reading.kind === "skip") { handle(); await skip(reading.why); return; }
      /**
       * A log or a rerun result GitHub does not serve yet is no try: it is read again after a backoff (CIFIX_UNREAD_DELAYS_MS), then
       * hourly while the head stays. A log no later read can find, or a day of such reads, is a failed try with the reason.
       */
      const notRead = async (kind: "code" | "infra", raw: string, permanent: boolean): Promise<void> => {
        const why = scrubReason(oneLine(raw), d.root);
        const reason = permanent ? `the failure log cannot be read: ${why}`
          : c.unreadSince && Date.parse(at()) - Date.parse(c.unreadSince) >= UNREAD_END_MS ? `the failure log could not be read for a day: ${why}` : null;
        if (reason === null) { await rec.set(c, kind, "unread", why); log(`  ${ref}: unread: ${why}`); return; }
        await rec.set(c, kind, "failed", reason);
        summary.failed.push({ ref, reason });
      };
      if (reading.kind === "unread") { handle(); await notRead("code", reading.why, reading.permanent); return; }
      const failure = reading.failure;
      const runsOf = (): number[] => [...new Set(failure.checks.flatMap((x) => (x.runId === null ? [] : [x.runId])))];
      // After the one rerun, only results from after it say how the code fares; older ones are what the rerun was meant to replace.
      // Only the checks of the runs it covered wait for such results; until they exist the head is unread, as above.
      const reran = c.rerunRuns?.length ? failure.checks.filter((x) => x.runId !== null && c.rerunRuns!.includes(x.runId)) : failure.checks;
      if (c.rerun && !reran.every((x) => !!x.completedAt && !!c.rerunAt && Date.parse(x.completedAt) > Date.parse(c.rerunAt))) {
        await notRead("infra", "the rerun produced no new check results yet", false);
        return;
      }
      const t = triage(failure);
      log(`  ${ref}: ${t.kind}: ${t.why}`);
      handle();
      if (t.kind === "skip") { await skip(t.why); return; }
      if (t.kind === "unreadable") { await rec.set(c, "code", "failed", t.why); summary.failed.push({ ref, reason: t.why }); return; }
      if (t.kind === "infra") {
        if (c.rerun) {
          const reason = "the failure looks like an infrastructure error again after the rerun";
          await rec.set(c, "infra", "failed", reason);
          summary.failed.push({ ref, reason });
          return;
        }
        await rec.set(c, "infra", "infra", t.why, { runs: runsOf() });
        summary.infra.push(ref);
        return;
      }
      // Failed tests that nothing in the log ties to the PR's changes look flaky: the failed jobs are rerun once before a code fix.
      if (t.kind === "code" && !c.rerun && c.mayRerun && runsOf().length) {
        const diff = await cachedDiff(db, repo, c.number, c.head, d.fetchDiff);
        const tests = diff.ok ? unrelatedTests(failure, [...diff.text.matchAll(DIFF_FILE)].map((m) => m[1]!)) : null;
        if (tests) {
          const shown = tests.slice(0, 3).join(", ") + (tests.length > 3 ? ", …" : "");
          const reason = `the failing test${tests.length === 1 ? "" : "s"} (${shown}) ${tests.length === 1 ? "is" : "are"} outside the PR's changes; the failed jobs are rerun once first`;
          await rec.set(c, "infra", "infra", reason, { runs: runsOf() });
          summary.infra.push(ref);
          log(`  ${ref}: ${reason}`);
          return;
        }
      }
      if (t.kind === "format") {
        // Only files that are in both the PR's diff and the log's `Diff in` lines are formatted.
        const diff = await cachedDiff(db, repo, c.number, c.head, d.fetchDiff);
        if (!diff.ok) { await rec.set(c, "format", "failed", `no diff: ${oneLine(diff.error)}`); summary.failed.push({ ref, reason: "no diff" }); return; }
        const prFiles = [...diff.text.matchAll(DIFF_FILE)].map((m) => m[1]!);
        const names = matchPrFiles(formatDiffPaths(failure), prFiles).filter((p) => editable(p) && !TEST_PATH.test(p));
        if (!names.length || names.length > FORMAT_FILES_MAX) {
          const reason = names.length ? `the formatter failure names ${names.length} of the PR's files` : "the formatter failure is in files the PR does not change";
          await rec.set(c, "format", "refused", reason);
          summary.failed.push({ ref, reason });
          log(`  ${ref}: refused: ${reason}`);
          return;
        }
        // The build environment (packages, env) is read from the PR's base commit, never from the PR's own workflow.
        const base = (await d.gh(["api", `repos/${slugOf(repo)}/pulls/${c.number}`, "--jq", ".base.sha"])).trim();
        if (!/^[0-9a-f]{40}$/.test(base)) { await rec.set(c, "format", "failed", "no base commit for the build environment"); summary.failed.push({ ref, reason: "no base commit" }); return; }
        await claim(c);
        const id = await createTask(db, {
          step: "cifix", repo, number: c.number, headSha: c.head, baseSha: base, requires: { os: "linux", toolchains: ["rust-stable"] }, warm: { key: warmKeyOf(repo), role: "use" },
          plan: [{ name: "format", cmd: ["sh", "-c", FORMAT_SCRIPT, "format", ...names], network: "none", timeoutSec: 600, bare: true, artifacts: [FORMAT_ARTIFACT] }],
        });
        await rec.set(c, "format", "formatting", null, { task: id, files: names });
        summary.queued.push(ref);
        log(`  ${ref}: formatter task ${id} queued for ${names.join(", ")}`);
        return;
      }
      if (await pushesAreUnsettled(db, repo, log)) return;
      await fixCode(c, pr, failure);
    } catch (e) {
      if (isHalt(e)) throw e;
      const reason = scrubReason(oneLine(String((e as Error).message ?? e)), d.root);
      await rec.set(c, "code", "failed", reason);
      summary.failed.push({ ref, reason });
      log(`  ${ref}: failed: ${reason}`);
    }
  };

  if (collect.length || work.length) mkdirSync(d.root, { recursive: true });
  for (const c of sel.capped) {
    const reason = `the PR's limit of ${MAX_PUSHES_PER_PR} pushed CI fixes or ${MAX_TRIES_PER_PR} tries is used`;
    await rec.set(c, "code", "capped", reason);
    log(`  ${refOf(c)}: ${reason}`);
  }
  let stopLogged = false;
  const stopped = async (): Promise<boolean> => {
    if (!await params.stopping?.()) return false;
    if (!stopLogged) { stopLogged = true; log(`cifix ${repo}: stopping, no new PRs started`); }
    return true;
  };
  /** Runs the items as a pool that starts one more only while the model queue has room; each takes its lease and gives it back. */
  const each = async <T>(items: T[], numberOf: (x: T) => number, run: (x: T) => Promise<void>): Promise<void> => {
    await pool(items.map((x) => async () => {
      if (await stopped()) return;
      const release = await leaseItem(db, `pr:${repo}#${numberOf(x)}`, log);
      if (!release) return;
      try { await run(x); } finally { await release(); }
    }), poolRoom(db, () => [repo], (i) => [{ repo, number: numberOf(items[i]!) }]), { max: POOL_MAX.cifix });
  };
  // A fix capped or given up at this head: one comment naming the failing checks, then the PR waits on the contributor.
  for (const c of sel.ask) {
    if (await stopped()) break;
    const ref = refOf(c);
    const release = await leaseItem(db, `pr:${repo}#${c.number}`, log);
    if (!release) continue;
    try {
      const reading = await ownFailure(db, d.gh, repo, c.number, c.head);
      if (reading.kind === "skip") { await rec.set(c, "code", "skipped", reading.why); summary.skipped.push(ref); log(`  ${ref}: skipped: ${reading.why}`); continue; }
      // A maintainer's changes request is the person's to resolve first; an unreadable answer counts as blocked.
      const blocked = await readGate(db, d.querier, ownerOf(repo), repo, c.number, log);
      if (blocked !== null) { const why = blocked ?? "the PR's reviews could not be read"; await rec.set(c, "code", "skipped", why); summary.skipped.push(ref); log(`  ${ref}: skipped: ${why}`); continue; }
      if (await isQuiet(c.number)) {
        const reason = "a quiet pull request is not asked for changes";
        await rec.set(c, "code", "cannot-push", reason);
        summary.held.push({ ref, reason });
        log(`  ${ref}: held: ${reason}`);
        continue;
      }
      const g = await guard(db, { repo, number: c.number }, { kind: "cifix", bucket: "ask", head: c.head }, params.by ?? CLI_BY, liveOf(db, d.querier));
      if ("refused" in g) { summary.skipped.push(ref); log(`  ${ref}: skipped: ${g.refused}`); continue; }
      const cm = await ghAskComment(gw, d.exec, "cifix-comment", g, { by: "fixed" }, askCiText(reading.failure.checks.map((x) => x.name), c.author ?? null), { run: runId, head: c.head });
      if (cm.code !== 0) {
        const reason = `the comment ${cm.sent === false ? "was not sent" : "failed"}: ${scrubReason(oneLine(cm.stderr), d.root)}`;
        await rec.set(c, "code", cm.sent === false ? "comment-unsent" : "comment-failed", reason);
        summary.failed.push({ ref, reason });
        log(`  ${ref}: ${reason}`);
        continue;
      }
      await rec.set(c, "code", "asked", CIFIX_ASK_REASON);
      summary.asked.push(ref);
      log(`  ${ref}: asked the contributor about the failing CI at ${short(c.head)}`);
    } catch (e) {
      if (isHalt(e)) throw e;
      const reason = scrubReason(oneLine(String((e as Error).message ?? e)), d.root);
      summary.unasked.push({ ref, reason });
      log(`  ${ref}: not asked: ${reason}`);
    } finally { await release(); }
  }
  await each(collect, (x) => x.c.number, async (x) => {
    try { await collectFormat(x.c, x.task); }
    catch (e) {
      if (isHalt(e)) throw e;
      const reason = scrubReason(oneLine(String((e as Error).message ?? e)), d.root);
      await rec.set(x.c, "format", "failed", reason);
      summary.failed.push({ ref: refOf(x.c), reason });
    }
  });
  await each(sel.lint, (c) => c.number, async (c) => {
    try { await collectLint(c); }
    catch (e) {
      if (isHalt(e)) throw e;
      const reason = scrubReason(oneLine(String((e as Error).message ?? e)), d.root);
      await rec.set(c, "code", "failed", reason);
      summary.failed.push({ ref: refOf(c), reason });
    }
  });
  await each(work, (c) => c.number, workOne);
  log(`cifix ${repo}: ${summary.pushed.length} pushed, ${summary.asked.length} commented, ${summary.queued.length} formatter runs queued, ${summary.infra.length} infra, ${summary.skipped.length} skipped, ${summary.failed.length + summary.unasked.length} failed, ${summary.held.length} held; run ${runId}`);
  return summary;
}

export type RerunSummary = { repo: string; reran: string[]; skipped: string[] };

/** Reruns the failed jobs of every PR whose failure was triaged as infrastructure: once per head. */
export async function runRerun(db: Db, params: CifixParams, log: (line: string) => void = console.log, deps?: Pick<CifixDeps, "querier" | "exec" | "now">): Promise<RerunSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  const out: RerunSummary = { repo, reran: [], skipped: [] };
  const due = (await selectCifix(db, repo, undefined, undefined, params.by)).rerun;
  const picks = params.limit === undefined ? due : due.slice(0, params.limit);
  log(`cifix-rerun ${repo}: ${due.length} heads due a rerun`);
  if (dryRun) {
    for (const x of picks) log(`  would rerun the failed jobs of ${refOf(x.c)} at ${short(x.c.head)}`);
    return out;
  }
  const d = deps ?? defaultDeps();
  const w: Writer = { db, login: RERUN_ACTOR };
  let n = 0;
  for (const { c, runs } of picks) {
    if (await params.stopping?.()) { log(`cifix-rerun ${repo}: stopping, no new PRs started`); break; }
    const ref = refOf(c);
    const release = await leaseItem(db, `pr:${repo}#${c.number}`, log);
    if (!release) continue;
    try {
      const r = await d.querier.query(PR_QUERY, { owner: ownerOf(repo), name: repo, n: c.number }) as { repository?: { pullRequest?: PrNode | null } };
      const pr = r.repository?.pullRequest;
      await noteLive(db, repo, c.number, pr, d.now().toISOString());
      if (!pr || pr.state !== "OPEN" || pr.isDraft || pr.headRefOid !== c.head) { log(`  ${ref}: skipped: closed, a draft or at another head`); out.skipped.push(ref); continue; }
      const g = await guard(db, { repo, number: c.number }, { kind: "cifix", bucket: "rerun", head: c.head }, params.by ?? CLI_BY);
      if ("refused" in g) { log(`  ${ref}: skipped: ${g.refused}`); out.skipped.push(ref); continue; }
      params.onHandled?.(++n);
      // Recorded before the calls: one rerun per head, even if this process dies in the middle of them.
      const rerun = { repo, number: c.number, head: c.head, runs, at: d.now().toISOString() };
      await startInfraRerun(db, [rerun]);
      const errors: string[] = [];
      for (const run of runs) {
        const res = await ghRerunFailed(w, d.exec, g, run, { head: c.head });
        if (res.code !== 0) errors.push(oneLine(res.stderr || res.stdout));
      }
      // One rerun per head, whether or not GitHub took every run.
      await finishInfraRerun(db, [{ ...rerun, state: "rerun", reason: errors.length ? errors[0]!.slice(0, 200) : null }]);
      out.reran.push(ref);
      log(`  ${ref}: reran ${runs.length} runs${errors.length ? ` (${errors.length} refused)` : ""}`);
    } catch (e) {
      log(`  ${ref}: not rerun: ${oneLine(String((e as Error).message ?? e))}`);
    } finally { await release(); }
  }
  return out;
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
  cifix: {
    summary: "cifix --repo R [--limit N] [--apply]: read the failing gate check of taken PRs and fix it (formatter run, patch checked by Opus, or the patch as a comment); dry run unless --apply",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runCifix(await openDb(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  "cifix-rerun": {
    summary: "cifix-rerun --repo R [--limit N] [--apply]: rerun the failed jobs once per head where the failure looks like an infrastructure error; dry run unless --apply",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runRerun(await openDb(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
};
