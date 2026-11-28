// Red default branch: for a repo with the "Fix red main" approval whose current head is red, each failed gate check is
// read (the CI fix reader) and sorted by Haiku, without tools:
//   flaky  a timeout, a network error, a cancelled job or a lost runner: the failed jobs are rerun once per head. Red again
//          at the same head counts as code.
//   infra  a refused request from a service, a missing secret, a quota or an outage: nothing here can fix it. One issue per
//          (repo, check, culprit) is opened under the repo's approval, with the check, the run link and a scrubbed log excerpt: the
//          row is `issue-opening` before the create, later red heads of the streak reuse its number, and a create whose outcome was
//          lost is looked up in the audit and on GitHub before another one is made.
//   code   a compile, test, lint or format failure: recorded as needs-fix for the fix PR step (`onCodeVerdict`).
// A failure log GitHub does not serve yet is recorded as an `unread` row at the head and read again once per main CI poll interval
// for an hour, then hourly, while the head is the repo's newest and red (also a fix PR's re-read of the log); a log GitHub no longer
// has, one with no job of the check, or one still unreadable after a day ends the head as `unreadable`, which needs a person.
// A model reply that sorts none of the checks leaves the head `unclassified`, asked again after CLASSIFY_RETRY_MS; the third gives
// the head up. A classification call that ended without a reply (lost, given back, ended with its job) is no try: it is asked again
// on LOST_RETRY_MS. A rerun GitHub refused stays `rerun-requested` with the reason and is asked again on RERUN_RETRY_MS; the third
// refusal by GitHub makes the rows code failures. Only a usable classification counts toward the step's daily limit.
// The log is untrusted text: it only reaches a model that has no tools, and what is stored or posted is scrubbed.
//
//   autocraft-server main-fix --repo R [--apply]
//   autocraft-server main-fix-approval [--repo R]
import { leaseItem } from "../runner/leases.ts";
import { dropMainFix, loadMainFixHeads, loadMainFixes, loadMainFixDue, MAIN_FIX_HEAD_CHECK, saveMainFixes, type MainFixRow, type MainFixTry } from "../data/changes/index.ts";
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
import { repeatAfter } from "../core/rules.ts";
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
const HEAD_ROW = MAIN_FIX_HEAD_CHECK;
/** A failure log not readable yet is read again once per main CI poll for this long after the first read, then hourly. */
const UNREAD_POLLED_MS = 60 * 60_000;
/** A failure log still unreadable this long after the first read ends the head (`unreadable`): a person looks. */
const UNREAD_END_MS = 24 * 60 * 60_000;
/** Model replies at a head that sort none of its failed checks before the head is given up. */
const UNUSABLE_GIVE_UP = 3;
/** A head whose model reply sorted none of its checks is asked again this long after. */
const CLASSIFY_RETRY_MS = 5 * 60_000;
/** A classification call without a reply is asked again after these delays, then hourly; such calls count apart (lostIn). */
const LOST_RETRY_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];
/** A rerun GitHub refused, or one held back here, is asked again after these delays, then hourly while the head stays red. */
const RERUN_RETRY_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Refusals by GitHub itself after which the rerun is not asked again: the rows become code failures. */
const RERUN_REFUSALS = 3;
/** The reason prefix of a rerun this side held back (the write guard, no token): no refusal by GitHub, `tries` unchanged. */
const RERUN_HELD = "the rerun was held back";
const HOUR_MS = 60 * 60_000;
/** Every 5 minutes while a rerun waits for its result. */
const RERUN_SLOT_MS = 5 * 60_000;

export type Verdict = { check: string; verdict: MainFixVerdict; reason: string };
/** A classification call that ended without a reply: lost, given back, ended with its job, or a reply refused before it was read. */
export type CallLost = { lost: string };
export type MainFixDeps = {
  gh: Gh;
  exec: Exec;
  /** Sorts the failed checks of one head; null when the model's reply sorted none of them. */
  classify: (db: Db, input: MainFixInput) => Promise<Verdict[] | null | CallLost>;
  now: () => Date;
  /** What the fix PR step needs; without it no fix PR is made. */
  fix?: FixPrDeps;
  /** The GitHub App lane of the writes (installation token, app client); without it the writer gets them itself. */
  lane?: Pick<Writer, "mint" | "appClient">;
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
      return reply ? parseVerdicts(reply.text, input.checks.map((c) => c.check)) : { lost: "the classification call ended without a reply" };
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
      // A timed row is due once its next try is (nextTry); the planner wakes when its slot moves on.
      const timed = (r: MainFixTry): boolean => {
        const t = nextTry(r, now);
        if (!t) return true;
        if (Number.isFinite(t.next)) o.wake?.push(t.next);
        return t.due;
      };
      const headRow = due.rows.find((r) => r.check === HEAD_ROW && (r.state === "unread" || r.state === "unclassified"));
      if (classified(due.rows)) {
        // A fix PR whose re-read of the log found none waits on the head's unread row.
        const needs = due.rows.some((r) => r.state === "needs-fix") && (headRow?.state !== "unread" || timed(headRow));
        const reruns = due.rows.filter((r) => r.state === "rerun-requested").map(timed);
        return needs || reruns.some(Boolean);
      }
      return !headRow || timed(headRow);
    }
    // A row left at needs-fix by an older head is closed by the next run.
    return due.rows.some((r) => r.state === "rerun-requested") || due.staleNeedsFix;
  });
}

/**
 * When a timed row's next try is due: `due` now, the `slot` that try belongs to and when the slot moves on (`next`, ms). Null for a row
 * that waits on nothing timed.
 *   unread         read again after the next main CI poll, then once per poll interval for an hour, then hourly
 *   unclassified   asked again CLASSIFY_RETRY_MS after a model reply, on LOST_RETRY_MS after calls without a reply
 *   rerun-requested  one not run (rerunPending) asked again on RERUN_RETRY_MS; a sent one is looked at every 5 minutes for its result
 */
function nextTry(r: MainFixTry, now: number): { due: boolean; slot: string; next: number } | null {
  const once = (at: number) => ({ due: at <= now, slot: `${r.updatedAt}:${at <= now ? 1 : 0}`, next: at <= now ? Infinity : at });
  if (r.state === "unread") {
    // Slots from the first read: one per poll interval for an hour, then one per hour. Each read writes `updated_at`, so the next
    // read is due once a later slot than the last read's has begun.
    const from = Date.parse(r.createdAt), polled = UNREAD_POLLED_MS / POLL_EVERY_MS;
    const slot = (t: number): number => { const age = Math.max(0, t - from); return age < UNREAD_POLLED_MS ? Math.floor(age / POLL_EVERY_MS) : polled + Math.floor((age - UNREAD_POLLED_MS) / HOUR_MS); };
    const start = (i: number): number => from + (i < polled ? i * POLL_EVERY_MS : UNREAD_POLLED_MS + (i - polled) * HOUR_MS);
    return once(start(slot(Date.parse(r.updatedAt)) + 1));
  }
  if (r.state === "unclassified") {
    const lost = lostIn(r.reason);
    return once(lost ? repeatAfter(Date.parse(r.updatedAt), lost, LOST_RETRY_MS) : Date.parse(r.updatedAt) + CLASSIFY_RETRY_MS);
  }
  if (r.state === "rerun-requested") {
    if (rerunPending(r)) return once(repeatAfter(Date.parse(r.updatedAt), r.tries, RERUN_RETRY_MS));
    const k = Math.floor(now / RERUN_SLOT_MS);
    return { due: true, slot: String(k), next: (k + 1) * RERUN_SLOT_MS };
  }
  return null;
}

/** Classification calls without a reply in a row, from the reason of the head's `unclassified` row (lostReason); 0 when its last try was a model reply. */
const LOST_MARK = /; (\d+) calls? without a reply in a row$/;
const lostIn = (reason: string | null): number => Number(LOST_MARK.exec(reason ?? "")?.[1] ?? 0);
const lostReason = (why: string, n: number): string => `${why}; ${n} call${n === 1 ? "" : "s"} without a reply in a row`;

/** A rerun that was not run: GitHub refused it (`tries`), or this side held it back. */
const rerunPending = (r: { state: string; tries?: number; reason: string | null }): boolean => r.state === "rerun-requested" && ((r.tries ?? 0) > 0 || !!r.reason?.startsWith(RERUN_HELD));

/**
 * The part of the main-fix lane's fingerprint that moves with the clock: the slot of every timed row at the current head of its repo
 * (nextTry; an unread or unclassified head only while it is red). A row left at an older head moves nothing.
 */
export async function mainFixClock(db: Db, now: number): Promise<string> {
  const rows = await loadMainFixHeads(db, ["rerun-requested", "unread", "unclassified"]);
  if (!rows.length) return "";
  const heads = await currentHeads(db, [...new Set(rows.map((r) => r.repo))]);
  return rows.flatMap((r) => {
    const c = heads.get(r.repo);
    if (c?.headSha !== r.headSha || (r.state !== "rerun-requested" && c.state !== "red")) return [];
    const t = nextTry(r, now);
    return t ? [`${r.repo}@${r.headSha.slice(0, 8)}:${r.check}:${t.slot}`] : [];
  }).join(";");
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
 * Why an unreadable failure log ends the head (`unreadable`, for a person), or null while it is read again: GitHub no longer has
 * the log or the log holds no job of the check (`permanent`), or the reads of the `unread` row's series found none for a day.
 */
function unreadEnd(row: Pick<FixRow, "createdAt"> | undefined, why: string, permanent: boolean, at: string): string | null {
  if (permanent) return oneLine(`the failure log cannot be read: ${why}`);
  if (row && Date.parse(at) - Date.parse(row.createdAt) >= UNREAD_END_MS) return oneLine(`the failure log could not be read for a day: ${why}`);
  return null;
}

/** The fields of a row of the head as a whole (check HEAD_ROW) that hold nothing for it. */
const headBase = (repo: string, headSha: string, at: string) => ({ repo, headSha, check: HEAD_ROW, verdict: "code", runId: null, runUrl: null, excerpt: null, issueNumber: null, prNumber: null, prUrl: null, patch: null, files: null, lintTask: null, lintRound: null, lintState: null, session: null, createdAt: at } as const);

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/**
 * Reads and sorts the failed checks of the red head. `count` is called once the model sorted them: a reading that finds nothing to
 * do, a log not readable yet, a call without a reply or a model reply that sorts nothing uses none of the step's daily limit. Returns
 * what left the head unclassified, for the job's summary; the third unusable reply at the head gives it up.
 */
async function classifyHead(db: Db, repo: string, cur: Current, deps: MainFixDeps, log: (l: string) => void, s: MainFixSummary, count: () => void, by: By = CLI_BY): Promise<string | null> {
  const at = deps.now().toISOString();
  const reading = await readFailure(deps.gh, repo, cur.headSha, await optionalChecks(db, repo));
  const { check: _check, ...base } = headBase(repo, cur.headSha, at);
  const short = cur.headSha.slice(0, 8);
  if (reading.kind === "skip") {
    await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "nothing-to-do", reason: oneLine(reading.why), updatedAt: at }, at);
    log(`  ${repo}: nothing to do: ${reading.why}`);
    return null;
  }
  const headRow = (await rowsAt(db, repo, cur.headSha)).find((r) => r.check === HEAD_ROW);
  const unread = headRow?.state === "unread" ? headRow : undefined;
  // The head row's model-reply count stays with the head whatever its state (saveMainFixes keeps it).
  const before = headRow?.tries ?? 0;
  if (reading.kind === "unread") {
    const why = oneLine(scrub(reading.why));
    const end = unreadEnd(unread, why, reading.permanent, at);
    if (end) {
      await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "unreadable", reason: end, tries: before, updatedAt: at }, at);
      log(`  ${repo}: ${end}`);
      return `${short} not classified: ${end}`;
    }
    // Read again while the head is the repo's newest and red: each read writes the row's time, and the next is due in a later slot (nextTry).
    await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "unread", reason: why, tries: before, updatedAt: at }, at);
    log(`  ${repo}: ${why}; read again later`);
    return `${short} not classified: its failure log could not be read yet`;
  }
  const failure = reading.failure;
  const verdicts = await deps.classify(db, inputOf(repo, failure));
  if (verdicts && "lost" in verdicts) {
    // A call without a reply is no model reply: it counts apart (lostIn), and the head is asked again however often that happens.
    const n = (headRow?.state === "unclassified" ? lostIn(headRow.reason) : 0) + 1;
    await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "unclassified", reason: lostReason(`${verdicts.lost} at ${short}`, n), tries: before, updatedAt: at }, at);
    const again = hhmm(repeatAfter(Date.parse(at), n, LOST_RETRY_MS));
    log(`  ${repo}: ${verdicts.lost} at ${short}; asked again at ${again}`);
    return `${short} not classified: ${verdicts.lost}; asked again at ${again}`;
  }
  if (!verdicts) {
    const tries = before + 1;
    const why = `no usable classification of the failed checks at ${short}`;
    if (tries >= UNUSABLE_GIVE_UP) {
      await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "nothing-to-do", reason: `${why} after ${tries} model replies`, tries, updatedAt: at }, at);
      log(`  ${repo}: given up: ${why} after ${tries} model replies`);
      return null;
    }
    await save(db, { ...base, check: HEAD_ROW, verdict: "code", state: "unclassified", reason: why, tries, updatedAt: at }, at);
    const again = hhmm(Date.parse(at) + CLASSIFY_RETRY_MS);
    log(`  ${repo}: ${why}; asked again at ${again}`);
    return `${short} not classified: the model's reply sorted none of the failed checks; asked again at ${again}`;
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
  for (const [runId, rows] of rerunRuns) await requestRerun(db, repo, cur, runId, rows, deps, log, s, by);
  return null;
}

/**
 * Asks GitHub to rerun the failed jobs of one run for its rows. A rerun held back here (the write guard, a request that never went
 * out) keeps the rows `rerun-requested` with RERUN_HELD as the reason; a refusal by GitHub adds one to `tries`. Both are asked again
 * on RERUN_RETRY_MS while the head is red; the RERUN_REFUSALS-th refusal by GitHub makes the rows code failures (onCodeVerdict),
 * with the refusal as the reason.
 */
async function requestRerun(db: Db, repo: string, cur: Current, runId: number, rows: FixRow[], deps: MainFixDeps, log: (l: string) => void, s: MainFixSummary, by: By): Promise<void> {
  const g = await guardRepo(db, repo, "main-fix", by);
  const res = "refused" in g ? null : await ghRerunMainFailed({ db, login: ACTOR, ...deps.lane }, g, deps.exec, { repo, head: cur.headSha, runId }, { checks: rows.map((r) => r.check) });
  const at = deps.now().toISOString();
  if (res?.code === 0) {
    s.reran++;
    log(`  ${repo}: reran the failed jobs of run ${runId}`);
    // The wait for the rerun's result counts from the request GitHub took.
    for (const r of rows.filter((x) => rerunPending(x))) await setState(db, r, "rerun-requested", (r.tries ?? 0) > 0 ? `the failed jobs were rerun after ${r.tries} refused request${r.tries === 1 ? "" : "s"}` : "the failed jobs were rerun", at, { tries: 0 });
    return;
  }
  if (res === null || res.sent === false) {
    const why = `${RERUN_HELD}: ${oneLine(res === null && "refused" in g ? g.refused : res?.stderr || res?.stdout || "", 120)}`;
    for (const r of rows) await setState(db, r, "rerun-requested", why, at);
    log(`  ${repo}: ${why}; asked again later`);
    return;
  }
  const why = `GitHub refused the rerun: ${oneLine(res.stderr || res.stdout, 120)}`;
  for (const r of rows) {
    const tries = (r.tries ?? 0) + 1;
    if (tries >= RERUN_REFUSALS) { await onCodeVerdict(db, { ...r, tries }, `the rerun was refused ${tries} times; ${why}`, at); s.needsFix++; }
    else await setState(db, r, "rerun-requested", why, at, { tries });
  }
  log(`  ${repo}: ${why}`);
}

/** The reruns of the head that were not run and whose next try is due, by run. */
function dueReruns(rows: readonly FixRow[], now: number): Map<number, FixRow[]> {
  const out = new Map<number, FixRow[]>();
  for (const r of rows) {
    if (!rerunPending(r) || r.runId === null || !nextTry({ ...r, tries: r.tries ?? 0 }, now)?.due) continue;
    (out.get(r.runId) ?? out.set(r.runId, []).get(r.runId)!).push(r);
  }
  return out;
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

/** Rows waiting on a rerun: green is a pass; red again after a new reading, or after the wait, is a code failure. A refused rerun was never run: it waits for its next request. */
async function settleReruns(db: Db, repo: string, cur: Current, deps: MainFixDeps, s: MainFixSummary): Promise<void> {
  const at = deps.now().toISOString();
  for (const r of (await rowsAt(db, repo, cur.headSha)).filter((x) => x.state === "rerun-requested")) {
    if (cur.state === "green" || cur.state === "optional") { await setState(db, r, "rerun-passed", r.reason, at); continue; }
    if (cur.state !== "red" || rerunPending(r)) continue;
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
  const by = params.by ?? CLI_BY;
  const work = (rows: readonly FixRow[]): boolean => !classified(rows) || dueReruns(rows, deps.now().getTime()).size > 0;
  if (cur.state === "red" && work(await rowsAt(db, repo, cur.headSha))) {
    if (await params.stopping?.()) s.note = `stopping: ${cur.headSha.slice(0, 8)} was not classified or its rerun not asked again`;
    else {
      const release = await leaseItem(db, `head:${repo}@${cur.headSha}`, log);
      // Another job may have classified the head before the lease was taken.
      if (release) {
        try {
          const rows = await rowsAt(db, repo, cur.headSha);
          if (!classified(rows)) s.note = await classifyHead(db, repo, cur, deps, log, s, bump, by);
          else for (const [runId, list] of dueReruns(rows, deps.now().getTime())) await requestRerun(db, repo, cur, runId, list, deps, log, s, by);
        } finally { await release(); }
      }
    }
  }
  const unsettled = await openInfraIssues(db, repo, cur, deps, log, s, by);
  if (deps.fix) {
    const asHead = (c: Current | null) => (c ? { headSha: c.headSha, branch: c.branch, state: c.state, redSince: c.redSince, culprit: c.culprit, culpritPr: c.culpritPr } : null);
    const r = await openFixPrs({
      db, repo, gh: deps.gh, exec: deps.exec, fix: deps.fix, now: deps.now, log, by: params.by, ...(params.stopping && { stopping: params.stopping }),
      setState: async (r, state, reason, at, extra) => await setState(db, r, state, reason, at, extra), current: async () => asHead(await currentOf(db, repo)),
      unread: async (head, why, permanent) => await markUnread(db, repo, head, why, permanent, deps.now().toISOString()),
    }, bump);
    s.prs = r.opened;
  }
  log(`main-fix ${repo}: classified ${s.classified}, reran ${s.reran}, needs fix ${s.needsFix}, issues ${s.issues}, fix PRs ${s.prs}${s.note ? `; ${s.note}` : ""}`);
  // The job fails: the failure backoff spaces the next look (a paced write's message is skipped by it, so the next pass runs it again).
  if (unsettled.length) throw new Error(unsettled.join("; "));
  return s;
}

/**
 * The head row that says a fix PR's re-read of the failure log found none (`why`), or, with null, that it read one. Returns why the
 * rows end instead (unreadEnd), with the head row then `unreadable`; null while they wait for the next read (nextTry). Each read
 * writes the row's time.
 */
async function markUnread(db: Db, repo: string, head: string, why: string | null, permanent: boolean, at: string): Promise<string | null> {
  const row = (await rowsAt(db, repo, head)).find((r) => r.check === HEAD_ROW);
  if (why === null) { if (row?.state === "unread") await dropMainFix(db, { repo, headSha: head, check: HEAD_ROW }); return null; }
  const reason = oneLine(scrub(why));
  const end = unreadEnd(row?.state === "unread" ? row : undefined, reason, permanent, at);
  await save(db, { ...headBase(repo, head, at), state: end ? "unreadable" : "unread", reason: end ?? reason, tries: row?.tries ?? 0, updatedAt: at }, at);
  return end;
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
      const states = ["needs-fix", "linting", "pr-opened", "fix-failed", "unreadable", "rerun-requested", "rerun-passed", "issue-opening", "issue-opened", "issue-failed", "declined", "nothing-to-do", "unread", "unclassified"];
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
