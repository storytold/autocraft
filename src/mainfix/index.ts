// Red default branch: for a repo with the "Fix red main" approval whose current head is red, each failed gate check is
// read (the CI fix reader) and sorted by Haiku, without tools:
//   flaky  a timeout, a network error, a cancelled job or a lost runner: the failed jobs are rerun once per head. Red again
//          at the same head counts as code.
//   infra  a refused request from a service, a missing secret, a quota or an outage: nothing here can fix it. One issue per
//          (repo, check, culprit) is opened under the repo's approval, with the check, the run link and a scrubbed log excerpt: the
//          row is `issue-opening` before the create, later red heads of the streak reuse its number, and a create whose outcome was
//          lost is looked up in the audit and on GitHub before another one is made.
//   code   a compile, test, lint or format failure: recorded as needs-fix for the fix PR step (`onCodeVerdict`).
// A failure log GitHub does not serve yet is recorded as an `unread` row at the head and read again once per main CI poll interval,
// for at most an hour. A model reply that sorts none of the checks is tried again after the failure backoff, at most 3 times. Only a
// usable classification counts toward the step's daily limit.
// The log is untrusted text: it only reaches a model that has no tools, and what is stored or posted is scrubbed.
//
//   autocraft-server main-fix --repo R [--apply]
//   autocraft-server main-fix-approval [--repo R]
import { leaseItem } from "../runner/leases.ts";
import { countMainFixes, dropMainFix, loadMainFixHeads, loadMainFixes, loadMainFixDue, saveMainFixes, type MainFixRow } from "../data/changes/index.ts";
import { listAudit, loadTrackedRepos, loadStepApprovals } from "../data/control/index.ts";
import { loadMainCiAt } from "../data/mirror/index.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guardRepo } from "../core/guard.ts";
import { exec, fixupDir, type Exec } from "../fixup/git.ts";
import { byUs, issueMade } from "../github/made.ts";
import { createIssue, ghRerunMainFailed, IssueError, unclearWrite, type Writer } from "../github/write.ts";
import { askClaude, saveUsage, type Usage } from "../classify/run.ts";
import { checkoutForCommit } from "../sandbox/index.ts";
import { readFailure } from "../cifix/logs.ts";
import { optionalChecks } from "../optional-checks.ts";
import type { CiFailure } from "../cifix/types.ts";
import { mainCiRepos, POLL_EVERY_MS } from "../mainci/index.ts";
import { ghExec, type Gh } from "../merge/safe-merge.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { cleanLine } from "../review/post-template.ts";
import { scrub } from "../runner/scrub.ts";
import { approvedRepos, repoApproved } from "../core/repo-approvals.ts";
import { lintReadyIn, openFixPrs, type FixPrDeps } from "./pr.ts";
import { REASON_WORDS, VERDICTS, type MainFixInput, type MainFixVerdict } from "./types.ts";
import { slugOf } from "../owners.ts";
import { wholeReplyJson } from "../core/reply-json.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { filterSeq } from "../async-seq.ts";

export { setMainFixApproval } from "./approval.ts";
export { autocraftText } from "./status.ts";

export const ACTOR = "main-fix";
const PROMPT = CLAUDE_PROMPTS["mainfix.classify"];
const PATCH = CLAUDE_PROMPTS["cifix.patch"];
const CHECK = CLAUDE_PROMPTS["fixup.check"];
/** The model named in the note of an issue opened for an infrastructure failure: it wrote the reason. */
const NOTE_MODEL = "haiku";
/** After a rerun the head may stay red this long without a new reading before the rerun counts as failed. */
const RERUN_WAIT_MS = 10 * 60_000;
const EXCERPT_CHARS = 1500;
/** The check of a head's row that is about the head as a whole: nothing to read there, or a log not readable yet. */
const HEAD_ROW = "(none)";
/** A head whose failure log stays unreadable this long after the first read is given up: the row records why. */
const UNREAD_GIVE_UP_MS = 60 * 60_000;
/** Model replies at a head that sort none of its failed checks before the head is given up. */
const UNUSABLE_GIVE_UP = 3;

export type Verdict = { check: string; verdict: MainFixVerdict; reason: string };
export type MainFixDeps = {
  gh: Gh;
  exec: Exec;
  /** Sorts the failed checks of one head; null when the model gave no usable answer. */
  classify: (db: Db, input: MainFixInput) => Promise<Verdict[] | null>;
  now: () => Date;
  /** What the fix PR step needs; without it no fix PR is made. */
  fix?: FixPrDeps;
};

export type FixRow = MainFixRow;

export type MainFixSummary = { repo: string; classified: number; reran: number; needsFix: number; issues: number; prs: number; note: string | null };

const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const words = (s: string): string => s.replace(/\s+/g, " ").trim().split(" ").slice(0, REASON_WORDS).join(" ");
/** URLs and mentions out of text that goes into a public issue. */
const plain = (s: string): string => scrub(s).replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"')]*/gi, "<url>").replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9_])/g, "$1");

export function defaultDeps(): MainFixDeps {
  return {
    gh: ghExec, exec, now: () => new Date(),
    fix: {
      root: fixupDir(),
      ask: async (db, input, checkout, tool) => (await askClaude("cifix.patch", PATCH.models[0]!, input, db, { checkout, check: tool }))?.text ?? null,
      check: async (db, input, checkout) => (await askClaude("fixup.check", CHECK.models[0]!, input, db, { checkout }))?.text ?? null,
      checkout: (repo, branch, sha) => checkoutForCommit(repo, branch, sha, console.log),
    },
    classify: async (db, input) => {
      const model = PROMPT.models[0]!;
      const start = new Date().toISOString();
      const reply = await askClaude("mainfix.classify", model, [input], db);
      const usage = reply?.usage ?? ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as Usage);
      await saveUsage(db, `main-fix-${start.replace(/[-:]/g, "").slice(0, 15)}`, "main-fix", "main-fix", model, reply ? 1 : 0, usage, start, new Date().toISOString());
      return reply ? parseVerdicts(reply.text, input.checks.map((c) => c.check)) : null;
    },
  };
}

/** The checks of a reply; a check the reply leaves out or sorts into no known kind is code. Null when the reply holds no JSON object with a checks array. */
export function parseVerdicts(text: string, checks: string[]): Verdict[] | null {
  const parsed = wholeReplyJson(text) as { checks?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.checks)) return null;
  const given = new Map<string, { verdict?: unknown; reason?: unknown }>();
  for (const c of parsed.checks as { check?: unknown; verdict?: unknown; reason?: unknown }[]) if (c && typeof c.check === "string") given.set(c.check, c);
  return checks.map((check) => {
    const g = given.get(check);
    const verdict = VERDICTS.find((v) => v === g?.verdict);
    return { check, verdict: verdict ?? "code", reason: words(plain(typeof g?.reason === "string" ? g.reason : "")) || (verdict ? "" : "no clear verdict") };
  });
}

// ---- rows ---------------------------------------------------------------------

/** A head is classified once it has a row other than an unread reading or an unusable model reply. */
const classified = (rows: readonly { state: string }[]): boolean => rows.some((r) => r.state !== "unread" && r.state !== "unclassified");

const rowsAt = async (db: Db, repo: string, head: string): Promise<FixRow[]> => await loadMainFixes(db, { heads: [{ repo, headSha: head }] });

async function save(db: Db, row: FixRow, at: string): Promise<void> {
  await saveMainFixes(db, [row], at);
}

const setState = async (db: Db, r: FixRow, state: string, reason: string | null, at: string, extra: Partial<FixRow> = {}): Promise<FixRow> => {
  const next = { ...r, ...extra, state, reason };
  await save(db, next, at);
  return next;
};

/**
 * Where a code verdict goes. The row records `needs-fix`; the fix PR step takes its rows from here (state needs-fix, verdict code).
 */
export async function onCodeVerdict(db: Db, row: FixRow, why: string, at: string): Promise<FixRow> {
  const c = codeState(why);
  return await setState(db, { ...row, verdict: c.verdict }, c.state, c.reason, at);
}
const codeState = (why: string) => ({ verdict: "code" as const, state: "needs-fix", reason: oneLine(why) });

// ---- the red head ---------------------------------------------------------------

type Current = { headSha: string; branch: string; state: string; culprit: string; culpritPr: number | null; redSince: string; /** When the culprit was first seen: everything recorded about this red streak is from then on. */ culpritAt: string; stateChangedAt: string };

/** The head's CI ended. */
const known = (c: Current): boolean => c.state === "red" || c.state === "green" || c.state === "optional";

/** The default branch's head of each of `repos` that has one read, in its own state: a fix works on the head whose checks failed. */
async function currentHeads(db: Db, repos: readonly string[]): Promise<Map<string, Current>> {
  const wanted = new Set(repos);
  const heads = (await mainCiRepos(db)).filter((x) => wanted.has(x.repo)).map((r) => (r.headState === "red" ? r : { ...r, redSince: null, culprit: null }));
  const at = await loadMainCiAt(db, heads.flatMap((r) => [r.headSha, ...(r.culprit && r.culprit.sha !== r.headSha ? [r.culprit.sha] : [])].map((sha) => ({ repo: r.repo, sha }))));
  return new Map(heads.map((r) => {
    const stateChangedAt = at.get(`${r.repo}@${r.headSha}`)?.state_changed_at ?? "";
    const culprit = r.culprit?.sha ?? r.headSha;
    return [r.repo, { headSha: r.headSha, branch: r.branch, state: r.headState, culprit, culpritPr: r.culprit?.pr ?? null, redSince: r.redSince ?? stateChangedAt, culpritAt: at.get(`${r.repo}@${culprit}`)?.first_seen_at ?? "", stateChangedAt }];
  }));
}

const currentOf = async (db: Db, repo: string): Promise<Current | null> => (await currentHeads(db, [repo])).get(repo) ?? null;

/** Those of `repos` where a run of the step has something to do. */
export async function mainFixDueRepos(db: Db, repos: readonly string[], o: { now?: number; wake?: number[] } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const approved = await approvedRepos(db, repos, "mainfix");
  const heads = await currentHeads(db, repos.filter((r) => approved.has(r)));
  const facts = await loadMainFixDue(db, [...heads].map(([repo, cur]) => ({ repo, headSha: cur.headSha, running: cur.state === "running" })));
  return await filterSeq([...heads.keys()], async (repo) => {
    const cur = heads.get(repo)!, due = facts.get(`${repo}@${cur.headSha}`)!;
    // A stored patch is collected once its lint task ended, or closed when its head is no longer the current one.
    if (cur.state !== "running" && await lintReadyIn(db, due.lintingHeads, cur.headSha)) return true;
    // An issue whose create was interrupted or held back is settled once the head's result is known.
    if (due.opening && known(cur)) return true;
    if (cur.state === "red") {
      if (classified(due.rows)) return due.rows.some((r) => r.state === "rerun-requested" || r.state === "needs-fix");
      const unread = due.rows.find((r) => r.state === "unread");
      if (!unread) return true;
      // A failure log GitHub did not serve yet is read again after the next main CI poll, then once in each poll interval
      // (mainFixClock moves the lane's fingerprint; a retry that reads nothing writes nothing).
      const next = Date.parse(unread.updatedAt) + POLL_EVERY_MS;
      o.wake?.push(next > now ? next : (Math.floor(now / POLL_EVERY_MS) + 1) * POLL_EVERY_MS);
      return next <= now;
    }
    // A row left at needs-fix by an older head is closed by the next run.
    return due.rows.some((r) => r.state === "rerun-requested") || due.staleNeedsFix;
  });
}

/**
 * The part of the main-fix lane's fingerprint that moves with the clock: every 5 minutes while a rerun waits for its result, every
 * main CI poll interval while the current red head of a repo has a failure log not readable yet (a row left at an older head moves
 * nothing).
 */
export async function mainFixClock(db: Db, now: number): Promise<string> {
  const rerun = await countMainFixes(db, { state: "rerun-requested" });
  const rows = await loadMainFixHeads(db, "unread");
  const heads = rows.length ? await currentHeads(db, [...new Set(rows.map((r) => r.repo))]) : new Map<string, Current>();
  const unread = rows.filter((r) => { const c = heads.get(r.repo); return c?.state === "red" && c.headSha === r.headSha; }).length;
  return [rerun ? `${rerun}:${Math.floor(now / 300_000)}` : "", unread ? `unread ${unread}:${Math.floor(now / POLL_EVERY_MS)}` : ""].filter(Boolean).join(";");
}

/** Whether a run of the step has something to do for the repo. */
export const mainFixDue = async (db: Db, repo: string): Promise<boolean> => (await mainFixDueRepos(db, [repo])).length > 0;

const issueTarget = (r: Pick<FixRow, "repo" | "headSha">): string => `${r.repo}:${r.headSha.slice(0, 8)}`;
const issueTitle = (check: string): string => `Main CI fails: ${cleanLine(check, 100)}`;

/** The issue's text. Fixed layout; the check name, reason and log excerpt are scrubbed, without URLs or mentions. */
export function issueBody(r: Pick<FixRow, "repo" | "headSha" | "check" | "reason" | "runId" | "excerpt">): string {
  const run = r.runId ? `\nRun: https://github.com/${slugOf(r.repo)}/actions/runs/${r.runId}` : "";
  const log = (r.excerpt ?? "").replace(/```/g, "'''").trim();
  return `The CI of the default branch fails at ${r.headSha.slice(0, 8)}.\n\nFailing check: \`${cleanLine(r.check, 100).replace(/`/g, "'")}\`${run}\n\nThe log reads as a failure outside the code (a refused request, a missing secret, a quota or an outage)${r.reason ? `: ${r.reason}` : "."}${log ? `\n\nLog excerpt:\n\n\`\`\`\n${log}\n\`\`\`` : ""}`;
}

const excerptOf = (c: CiFailure["checks"][number]): string => {
  const text = plain(c.steps.map((s) => s.tail).join("\n")).split("\n").filter((l) => l.trim()).join("\n");
  return text.length > EXCERPT_CHARS ? text.slice(-EXCERPT_CHARS) : text;
};

const inputOf = (repo: string, f: CiFailure): MainFixInput => ({
  ref: `${repo}@${f.head.slice(0, 8)}`,
  checks: f.checks.map((c) => ({ check: c.name, conclusion: c.conclusion, steps: c.steps.map((s) => ({ job: s.job, step: s.step, log: scrub(s.tail) })) })),
});

/**
 * Reads and sorts the failed checks of the red head. `count` is called once the model sorted them: a reading that finds nothing to
 * do, a log not readable yet or a model reply that sorts nothing uses none of the step's daily limit. Returns why a model reply was
 * unusable, for the failure backoff; the third such reply at the head gives it up.
 */
async function classifyHead(db: Db, repo: string, cur: Current, deps: MainFixDeps, log: (l: string) => void, s: MainFixSummary, count: () => void, by: By = CLI_BY): Promise<string | null> {
  const at = deps.now().toISOString();
  const reading = await readFailure(deps.gh, repo, cur.headSha, await optionalChecks(db, repo));
  const base = { repo, headSha: cur.headSha, runId: null, runUrl: null, excerpt: null, issueNumber: null, prNumber: null, prUrl: null, patch: null, files: null, lintTask: null, lintRound: null, lintState: null, session: null, createdAt: at } as const;
  if (reading.kind === "skip") {
    await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "nothing-to-do", reason: oneLine(reading.why), updatedAt: at }, at);
    log(`  ${repo}: nothing to do: ${reading.why}`);
    return null;
  }
  const headRow = (await rowsAt(db, repo, cur.headSha)).find((r) => r.check === HEAD_ROW);
  const unread = headRow?.state === "unread" ? headRow : undefined;
  if (reading.kind === "unread") {
    const why = oneLine(scrub(reading.why));
    const first = unread?.createdAt ?? at;
    if (Date.parse(at) - Date.parse(first) >= UNREAD_GIVE_UP_MS) {
      await save(db, { ...base, createdAt: first, check: HEAD_ROW, verdict: "code", state: "nothing-to-do", reason: oneLine(`the failure log could not be read for an hour: ${why}`), updatedAt: at }, at);
      log(`  ${repo}: given up: the failure log could not be read for an hour: ${why}`);
    } else {
      // Only the first unread reading is written: a retry that reads nothing moves no planner input.
      if (!unread) await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "unread", reason: why, updatedAt: at }, at);
      log(`  ${repo}: ${why}; read again after the next main CI poll`);
    }
    return null;
  }
  const failure = reading.failure;
  const verdicts = await deps.classify(db, inputOf(repo, failure));
  if (!verdicts) {
    const tries = (headRow?.state === "unclassified" ? headRow.tries ?? 0 : 0) + 1;
    const why = `no usable classification of the failed checks at ${cur.headSha.slice(0, 8)}`;
    if (tries >= UNUSABLE_GIVE_UP) {
      await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "nothing-to-do", reason: `${why} after ${tries} model replies`, tries, updatedAt: at }, at);
      log(`  ${repo}: given up: ${why} after ${tries} model replies`);
      return null;
    }
    await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "unclassified", reason: why, tries, updatedAt: at }, at);
    log(`  ${repo}: ${why}`);
    return `${repo}: ${why}`;
  }
  count();
  s.classified++;
  const rerunRuns = new Map<number, FixRow[]>();
  const rows = failure.checks.map((c): FixRow => {
    const v = verdicts.find((x) => x.check === c.name) ?? { check: c.name, verdict: "code" as const, reason: "no verdict" };
    const row: FixRow = {
      ...base, check: c.name, verdict: v.verdict, state: "nothing-to-do", reason: v.reason || null, runId: c.runId,
      runUrl: c.runId ? `https://github.com/${slugOf(repo)}/actions/runs/${c.runId}` : null, excerpt: excerptOf(c) || null, updatedAt: at,
    };
    if (v.verdict === "code") return { ...row, ...codeState(v.reason || "a build, lint or test step failed") };
    if (v.verdict === "infra") return { ...row, state: "issue-opening" };
    // flaky
    return row.runId === null ? { ...row, reason: "no Actions run to rerun" } : { ...row, state: "rerun-requested" };
  });
  // Every row is recorded before the first call to GitHub, so a process that dies in between leaves no check of the head unread:
  // one rerun per head, and an issue the next run settles.
  await saveMainFixes(db, rows, at);
  if (headRow) await dropMainFix(db, { repo, headSha: cur.headSha, check: HEAD_ROW });
  s.needsFix += rows.filter((r) => r.state === "needs-fix").length;
  for (const r of rows) if (r.state === "rerun-requested" && r.runId !== null) (rerunRuns.get(r.runId) ?? rerunRuns.set(r.runId, []).get(r.runId)!).push(r);
  const w: Writer = { db, login: ACTOR };
  for (const [runId, rows] of rerunRuns) {
    const g = await guardRepo(db, repo, "main-fix", by);
    const res = "refused" in g ? { code: 1, stdout: "", stderr: g.refused } : await ghRerunMainFailed(w, g, deps.exec, { repo, head: cur.headSha, runId }, { checks: rows.map((r) => r.check) });
    if (res.code !== 0) for (const r of rows) await setState(db, r, "nothing-to-do", `GitHub refused the rerun: ${oneLine(res.stderr || res.stdout, 120)}`, deps.now().toISOString());
    else { s.reran++; log(`  ${repo}: reran the failed jobs of run ${runId}`); }
  }
  return null;
}

/**
 * The `issue-opening` rows of the repo, check by check: one issue for the check's red streak. Returns what stopped a check whose rows
 * stay `issue-opening` for the next run: a create without a known outcome, or one the write pacing held back.
 */
async function openInfraIssues(db: Db, repo: string, cur: Current, deps: MainFixDeps, log: (l: string) => void, s: MainFixSummary, by: By): Promise<string[]> {
  const open: string[] = [];
  const checks = new Set((await loadMainFixes(db, { repo, states: ["issue-opening"] })).map((r) => r.check));
  for (const check of checks) {
    const release = await leaseItem(db, `main-issue:${repo}:${check}`, log);
    if (!release) continue;
    try {
      const why = await openInfraIssue(db, repo, check, cur, deps, log, s, by);
      if (why) open.push(why);
    } finally { await release(); }
  }
  return open;
}

async function openInfraIssue(db: Db, repo: string, check: string, cur: Current, deps: MainFixDeps, log: (l: string) => void, s: MainFixSummary, by: By): Promise<string | null> {
  const stored = (await loadMainFixes(db, { repo, states: ["issue-opening", "issue-opened", "declined"] })).filter((r) => r.check === check);
  const rows = stored.filter((r) => r.state === "issue-opening");
  const newest = rows.at(-1);
  if (!newest) return null;
  const end = async (state: string, extra: Partial<FixRow> = {}, reason?: string): Promise<null> => {
    const at = deps.now().toISOString();
    await saveMainFixes(db, rows.map((r) => ({ ...r, ...extra, state, reason: reason ?? r.reason })), at);
    return null;
  };
  // The streak's issue, opened (or declined by a person) at an earlier red head.
  const streak = (r: FixRow): boolean => r.createdAt >= cur.culpritAt;
  const had = streak(newest) ? stored.find((r) => r.state === "issue-opened" && r.issueNumber !== null && streak(r)) ?? stored.find((r) => r.state === "declined" && streak(r)) : undefined;
  if (had) return await end(had.state, { issueNumber: had.issueNumber });
  // A create an earlier run began: its audit row tells the issue, and one that ended without a known outcome is looked up on GitHub.
  const began = (await listAudit(db, { actions: ["postmerge-file"], targets: rows.map(issueTarget), order: "desc" })).filter((a) => a.details?.check === check && a.at >= rows[0]!.createdAt);
  const done = began.map((a) => /\/issues\/(\d+)$/.exec(a.details?.state === "done" ? String(a.details.url ?? "") : "")).find((m) => m !== null);
  if (done) return await end("issue-opened", { issueNumber: Number(done[1]) });
  // The next result tells whether the streak goes on.
  if (!known(cur)) return null;
  for (const a of began.filter((a) => unclearWrite(a.details))) {
    let made: { number: number; url: string } | null;
    try {
      made = await issueMade(deps.gh, { repo, title: String(a.details?.title ?? ""), body: String(a.details?.text ?? ""), since: a.at, mine: await byUs(db) });
    } catch (e) { return `${repo}: whether the issue for ${check} was opened is not known: ${oneLine(String((e as Error).message ?? e))}`; }
    if (made) { log(`  ${repo}: the issue for ${check} was opened before: ${made.url}`); return await end("issue-opened", { issueNumber: made.number }); }
  }
  if (cur.state !== "red" || !streak(newest)) return await end("nothing-to-do", {}, "main is green again");
  const g = await guardRepo(db, repo, "main-fix", by);
  if ("refused" in g) { log(`  ${repo}: issue for ${check} not opened: ${g.refused}`); return await end("issue-failed", {}, oneLine(g.refused, 100)); }
  try {
    const made = await createIssue({ db, login: ACTOR }, g, deps.exec, { repo, target: issueTarget(newest), title: issueTitle(check), body: issueBody(newest) }, { by: "model", kind: "issue", model: NOTE_MODEL }, { check });
    await end("issue-opened", { issueNumber: made.number });
    s.issues++;
    log(`  ${repo}: opened ${made.url}`);
    return null;
  } catch (e) {
    const why = oneLine(String((e as Error).message ?? e));
    log(`  ${repo}: issue for ${check} not opened: ${why}`);
    if (e instanceof IssueError && e.later) return why;
    if (!(e instanceof IssueError) || !e.clear) return `${repo}: whether the issue for ${check} was opened is not known: ${why}`;
    return await end("issue-failed", {}, `issue not opened: ${why}`.slice(0, 200));
  }
}

/** Rows waiting on a rerun: green is a pass; red again after a new reading, or after the wait, is a code failure. */
async function settleReruns(db: Db, repo: string, cur: Current, deps: MainFixDeps, s: MainFixSummary): Promise<void> {
  const at = deps.now().toISOString();
  for (const r of (await rowsAt(db, repo, cur.headSha)).filter((x) => x.state === "rerun-requested")) {
    if (cur.state === "green" || cur.state === "optional") { await setState(db, r, "rerun-passed", r.reason, at); continue; }
    if (cur.state !== "red") continue;
    const changedSince = cur.stateChangedAt > r.updatedAt;
    if (changedSince || deps.now().getTime() - Date.parse(r.updatedAt) > RERUN_WAIT_MS) { await onCodeVerdict(db, r, "red again after a rerun", at); s.needsFix++; }
  }
}

/** One repo: nothing without the approval; then answers, rerun results and, for a red head with no rows, the reading and sorting. */
export async function runMainFix(db: Db, params: { repo: string; onHandled?: (n: number) => void; stopping?: () => Promise<boolean>; by?: By }, log: (line: string) => void = console.log, deps: MainFixDeps = defaultDeps()): Promise<MainFixSummary> {
  const { repo } = params;
  const s: MainFixSummary = { repo, classified: 0, reran: 0, needsFix: 0, issues: 0, prs: 0, note: null };
  if (!await repoApproved(db, repo, "mainfix")) {
    s.note = `fixing a red main in ${repo} is not approved`;
    log(`main-fix ${repo}: ${s.note}; nothing done`);
    return s;
  }
  let handled = 0;
  const bump = (): void => params.onHandled?.(++handled);
  const cur = await currentOf(db, repo);
  if (!cur) return s;
  await settleReruns(db, repo, cur, deps, s);
  let unusable: string | null = null;
  if (cur.state === "red" && !classified(await rowsAt(db, repo, cur.headSha)) && !await params.stopping?.()) {
    const release = await leaseItem(db, `head:${repo}@${cur.headSha}`, log);
    // Another job may have classified the head before the lease was taken.
    if (release) {
      try {
        if (!classified(await rowsAt(db, repo, cur.headSha))) unusable = await classifyHead(db, repo, cur, deps, log, s, bump, params.by ?? CLI_BY);
      } finally { await release(); }
    }
  }
  const unsettled = await openInfraIssues(db, repo, cur, deps, log, s, params.by ?? CLI_BY);
  if (deps.fix) {
    const asHead = (c: Current | null) => (c ? { headSha: c.headSha, branch: c.branch, state: c.state, redSince: c.redSince, culprit: c.culprit, culpritPr: c.culpritPr } : null);
    const r = await openFixPrs({ db, repo, gh: deps.gh, exec: deps.exec, fix: deps.fix, now: deps.now, log, by: params.by, ...(params.stopping && { stopping: params.stopping }), setState: async (r, state, reason, at, extra) => await setState(db, r, state, reason, at, extra), current: async () => asHead(await currentOf(db, repo)) }, bump);
    s.prs = r.opened;
  }
  log(`main-fix ${repo}: classified ${s.classified}, reran ${s.reran}, needs fix ${s.needsFix}, issues ${s.issues}, fix PRs ${s.prs}`);
  // The job fails: the failure backoff spaces the next look (a paced write's message is skipped by it, so the next pass runs it again).
  if (unusable) unsettled.push(unusable);
  if (unsettled.length) throw new Error(unsettled.join("; "));
  return s;
}

export const commands = {
  "main-fix": {
    summary: "main-fix --repo R [--apply]: sort the failed checks of a red default branch and rerun, ask or record; without --apply, lists the stored rows. Needs the repo's Fix red main approval",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo");
      if (i < 0 || !args[i + 1]) throw new Error("usage: main-fix --repo R [--apply]");
      const repo = args[i + 1]!;
      const db = await openDb();
      if (args.includes("--apply")) { await runMainFix(db, { repo }); return; }
      const states = ["needs-fix", "linting", "pr-opened", "fix-failed", "rerun-requested", "rerun-passed", "issue-opening", "issue-opened", "issue-failed", "declined", "nothing-to-do", "unread", "unclassified"];
      for (const r of (await loadMainFixes(db, { repo, states })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, 50))
        console.log(`${r.headSha.slice(0, 8)}\t${r.check}\t${r.verdict}\t${r.state}\t${r.reason ?? ""}`);
    },
  },
  "main-fix-approval": {
    summary: "main-fix-approval [--repo R]: which repos the operator approved for acting on a red default branch",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo");
      const db = await openDb();
      const repos = i >= 0 ? [args[i + 1]!] : [...(await loadTrackedRepos(db)).keys()].sort();
      const approvals = await loadStepApprovals(db, repos, ["mainfix"]);
      for (const r of repos) {
        const a = approvals.get(r)?.mainfix;
        console.log(`${r}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};
