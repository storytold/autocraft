// No new failures: while the default branch is red, a PR's (or batch PR's) CI counts as passing when every failing required check
// also fails on main, in the same failed steps, with no failing test or location main's log does not name for that step and no test
// in the check's test summary that main's does not list. The logs are read whole (up to COMPARE_CAP per check, never shown to a
// model) with the CI fix's reader and parsed with the shared parser (src/core/failure-locations.ts); main's are read once per head
// and kept (main_ci_failures), a PR head's only while its CI and main are both red. A log that cannot be read, names nothing, runs
// over the limit or does not line up with main's counts as new. Read-only on GitHub.
import type { Gh } from "../merge/safe-merge.ts";
import type { CiFailure, FailedCheck } from "../cifix/types.ts";
import { readFailure, type Reading } from "../cifix/logs.ts";
import { summaryTests, testLocations } from "../core/failure-locations.ts";
import type { CiState } from "../core/evidence.ts";
import { CIFIX_UNREAD_DELAYS_MS, passesNote, repeatAfter } from "../core/rules.ts";
import { optionalChecks } from "../optional-checks.ts";
import { loadMainFailures, loadOwnIntegration, loadVsMain, loadVsMainAt, saveMainFailures, saveVsMain, type CheckFailures, type VsMainRow } from "../data/merge/index.ts";
import { loadMainCiAt } from "../data/mirror/index.ts";
import { redMainHeads } from "./index.ts";
import type { PrChecks } from "../review/checks.ts";
import type { KeySource } from "../data/keys.ts";
import type { Db } from "../db/index.ts";

/**
 * A red default-branch head a PR's failures are compared with: its sha, the checks that failed there, when it stops counting as red
 * with nothing new read (null: only a new result ends it), and when it was seen red (null: no check of run start times).
 */
export type RedMain = { sha: string; failing: string[]; until: number | null; redAt: string | null };

/** Failures per check of one head. */
export type HeadFailures = Record<string, CheckFailures>;

/** The facts' view of a red head against a red main: failing checks that let CI pass, a comparison to make, or a read again for a rerun. */
export type VsFact = { passing: string[] } | { comparing: true; at: number | null } | { rerun: true; at: number | null } | null;

/** A PR head stays unread this long after its first unread read; then its failure counts as new. */
export const VS_MAIN_UNREAD_END_MS = 24 * 3600_000;
/** Characters of failed-step text a comparison reads per check; a check with more counts as new. */
export const COMPARE_CAP = 2_000_000;

/** The identity of a failure: each panicking test by name (its line moves with edits), a failure of no named test by file and line. */
const keyOf = (l: { file: string; line: number; test: string | null }): string => (l.test ? `test ${l.test}` : `${l.file}:${l.line}`);

/** One failed check as a comparison reads it: its failed steps' keys, its failing tests (summary and panics), and why it cannot be compared. */
export function checkFailures(c: FailedCheck): CheckFailures {
  const steps = c.steps.map((s) => ({ step: s.step, keys: [...new Set(testLocations(s.tail, Infinity, true).places.map(keyOf))] }));
  const summary = summaryTests(c.steps.map((s) => s.tail).join("\n"));
  const tests = [...new Set([...(summary ?? []), ...steps.flatMap((s) => s.keys.filter((k) => k.startsWith("test ")).map((k) => k.slice(5)))])];
  const bad = c.cut ? "its log is over the comparison's limit" : c.duplicate ? "more than one check run carries its name" : null;
  return { steps, tests, summary, bad, startedAt: c.startedAt ?? null };
}

export function headFailures(f: CiFailure): HeadFailures {
  return Object.fromEntries(f.checks.map((c) => [c.name, checkFailures(c)]));
}

/**
 * Compares a PR head's failing required checks (`failing`) with main's. not-new: each fails on main, and every failed step of it is a
 * failed step of main's check that names at least one failing test or location, all of them main's, and its test summary lists only
 * tests main's lists. new: a check passes on main, or names a test or location main's does not. unparsed: a step names nothing or does
 * not fail on main, a log is over the limit or a check name is not unique. early: otherwise not new, but a check's run started before
 * main's head was seen red (`redAt`). `checks`: the failing checks found not new.
 */
export function compareFailures(pr: HeadFailures, main: HeadFailures, failing: readonly string[], redAt: string | null = null): { state: "not-new" | "new" | "unparsed" | "early"; checks: string[]; reason: string } {
  const notNew: string[] = [];
  let fresh: string | null = null, unparsed: string | null = null, early: string | null = null;
  for (const c of failing) {
    const m = main[c], p = pr[c];
    if (!m) { fresh ??= `${c} passes on main`; continue; }
    if (!p) { unparsed ??= `no failed run of ${c} at the head`; continue; }
    const bad = p.bad ?? (m.bad ? `main's ${m.bad}` : null);
    if (bad) { unparsed ??= `${c}: ${bad}`; continue; }
    if (!p.steps.length) { unparsed ??= `the log of ${c} has no failed step`; continue; }
    let ok = true;
    for (const s of p.steps) {
      const ms = m.steps.filter((x) => x.step === s.step);
      if (!ms.length) { unparsed ??= `the step "${s.step}" of ${c} does not fail on main`; ok = false; break; }
      if (!s.keys.length) { unparsed ??= `the step "${s.step}" of ${c} names no failing test or location`; ok = false; break; }
      const theirs = new Set(ms.flatMap((x) => x.keys));
      const extra = s.keys.find((k) => !theirs.has(k));
      if (extra) { fresh ??= `${c} fails at ${extra}, which main does not`; ok = false; break; }
    }
    if (!ok) continue;
    const test = p.summary?.find((t) => !m.tests.includes(t));
    if (test) { fresh ??= `${c} fails test ${test}, which main does not`; continue; }
    if (redAt && (!p.startedAt || p.startedAt <= redAt)) { early ??= `${c} ran before main turned red; compared again after it reruns`; continue; }
    notNew.push(c);
  }
  if (fresh) return { state: "new", checks: notNew, reason: fresh };
  if (unparsed) return { state: "unparsed", checks: notNew, reason: unparsed };
  if (early) return { state: "early", checks: notNew, reason: early };
  return { state: "not-new", checks: notNew, reason: passesNote(notNew) };
}

/**
 * Where a head whose CI is red stands against a red main: `skip` when no comparison applies (main is not red, nothing fails, or a
 * failing check passes on main by name, so the failure is new without a read); `due` when it is to be read (no row against main's
 * head, a failing check the row did not judge, or an unread or early row whose backoff ended), else `at` when such a row is read again.
 * `row` is the row that still holds.
 */
export function vsMainStatus(o: { failing: readonly string[]; red: RedMain | undefined; row: VsMainRow | null | undefined; now: number }):
  { skip: true } | { skip: false; due: boolean; at: number | null; row: VsMainRow | null } {
  const { failing, red } = o;
  if (!red || !failing.length || failing.some((n) => !red.failing.includes(n))) return { skip: true };
  const row = o.row && o.row.mainHead === red.sha && failing.every((n) => o.row!.failing.includes(n)) ? o.row : null;
  if (!row) return { skip: false, due: true, at: null, row: null };
  if (row.state !== "unread" && row.state !== "early") return { skip: false, due: false, at: null, row };
  const at = repeatAfter(Date.parse(row.readAt), row.reads, CIFIX_UNREAD_DELAYS_MS);
  return { skip: false, due: at <= o.now, at: at > o.now ? at : null, row };
}

/** The failing checks a row lets pass: those found not new, only while the whole head is not new against main head `mainSha`. */
export const passingChecks = (row: VsMainRow | null | undefined, mainSha: string | undefined): string[] =>
  row && mainSha && row.mainHead === mainSha && row.state === "not-new" ? row.checks : [];

/** The failing checks found not new at a head, also when others are new: the CI fix leaves them to main. */
export const mainsChecks = (row: VsMainRow | null | undefined, mainSha: string | undefined): string[] =>
  row && mainSha && row.mainHead === mainSha && row.state !== "unread" ? row.checks : [];

/**
 * The CI state of a head against a red main, for the planner, the review gate and pre-approved legs alike. `ci(passing)` is ciAt with
 * those failing checks counted as optional. Failing checks found not new pass; while a comparison is to be made (or a log read again)
 * CI is pending; an early row is red CI that is compared again after its backoff.
 */
export function ciVsMain(o: { ci: (passing: string[]) => CiState; failing: string[]; red: RedMain | undefined; row: VsMainRow | null | undefined; now: number }): { ci: CiState; vs: VsFact } {
  const plain = o.ci([]);
  if (plain !== "failure") return { ci: plain, vs: null };
  const st = vsMainStatus(o);
  if (st.skip) return { ci: plain, vs: null };
  const passing = passingChecks(st.row, o.red?.sha);
  if (passing.length) return { ci: o.ci(passing), vs: { passing } };
  if (!st.row || st.row.state === "unread") return { ci: "pending", vs: { comparing: true, at: st.at } };
  if (st.row.state === "early") return { ci: plain, vs: { rerun: true, at: st.at } };
  return { ci: plain, vs: null };
}

/** The failing required checks of stored checks `c` at `head`; none when they are of another head. */
export function failingAt(c: { head_oid: string | null; checks: string | { name: string; state: string }[] | null } | null | undefined, head: string, optional: readonly string[]): string[] {
  if (!c || c.head_oid !== head) return [];
  let list: { name: string; state: string }[] = [];
  if (Array.isArray(c.checks)) list = c.checks;
  else try { const v = JSON.parse(c.checks ?? "[]") as unknown; if (Array.isArray(v)) list = v as typeof list; } catch { /* unreadable: none */ }
  return list.filter((x) => x.state === "failure" && !optional.includes(x.name)).map((x) => x.name);
}

/** The red main a batch PR is compared with: the default branch at the batch's base, only when that head is red with the failing checks. */
export async function baseRed(db: Db, repo: string, baseSha: string): Promise<RedMain | undefined> {
  const row = (await loadMainCiAt(db, [{ repo, sha: baseSha }])).get(`${repo}@${baseSha}`);
  if (!row || (row.state !== "red" && row.settled_state !== "red")) return undefined;
  let failing: string[] = [];
  try { failing = (JSON.parse(row.failing) as { name?: string }[]).map((f) => f.name ?? "").filter(Boolean); } catch { /* malformed: nothing fails by name */ }
  return { sha: baseSha, failing, until: null, redAt: null };
}

/** passingChecks of a PR head against the repo's red main now, or against main at `base` for a batch PR; none when that is not red. */
export async function mainsFailuresAt(db: Db, repo: string, number: number, head: string, base?: string, nowMs: number = Date.now()): Promise<string[]> {
  const [red, row] = await db.together(() => Promise.all([base === undefined ? redMainHeads(db, nowMs) : Promise.resolve(null), loadVsMainAt(db, repo, number, head)]));
  return passingChecks(row, base ?? red?.get(repo)?.sha);
}

/**
 * readFailure of a PR head for a fix (the CI fix, an implementation's revision) without the failed checks found failing only where the
 * red main fails: those are main's to fix. A reading left with no check is skipped.
 */
export async function ownFailure(db: Db, gh: Gh, repo: string, number: number, head: string): Promise<Reading> {
  const reading = await readFailure(gh, repo, head, await optionalChecks(db, repo));
  if (reading.kind === "skip") return reading;
  const [red, row] = await db.together(() => Promise.all([redMainHeads(db), loadVsMainAt(db, repo, number, head)]));
  const mains = mainsChecks(row, red.get(repo)?.sha);
  if (!mains.length) return reading;
  const checks = reading.failure.checks.filter((c) => !mains.includes(c.name));
  if (!checks.length) return { kind: "skip", why: `the failed checks fail only where the default branch fails (${mains.join(", ")})` };
  return { ...reading, failure: { ...reading.failure, checks } };
}

/** The red main and the comparison rows of the PRs in `keys`, read once: `at(ref, head)` gives ciVsMain's `red` and `row` for one head. */
export async function vsMainOf(db: Db, keys: KeySource, nowMs: number = Date.now()): Promise<(ref: string, head: string) => { red: RedMain | undefined; row: VsMainRow | undefined }> {
  const [red, rows] = await db.together(() => Promise.all([redMainHeads(db, nowMs), loadVsMain(db, keys)]));
  return (ref, head) => ({ red: red.get(ref.slice(0, ref.lastIndexOf("#"))), row: rows.get(`${ref}@${head}`) });
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);

/** Main's failures at its red head, read once and kept; `why` while a log cannot be read, `permanent` when GitHub no longer serves one. */
async function mainFailures(db: Db, gh: Gh, repo: string, red: RedMain, optional: string[], at: string): Promise<{ keys: HeadFailures } | { why: string; permanent: boolean }> {
  const stored = await loadMainFailures(db, repo, red.sha);
  if (stored?.state === "read") return { keys: stored.keys };
  if (stored?.state === "gone") return { why: `main's failure log: ${stored.reason ?? "gone"}`, permanent: true };
  const reading = await readFailure(gh, repo, red.sha, optional, { cap: COMPARE_CAP });
  if (reading.kind === "unread") {
    const why = oneLine(reading.why);
    await saveMainFailures(db, { repo, headSha: red.sha, state: reading.permanent ? "gone" : "unread", keys: {}, reason: why, readAt: at });
    return { why: `main's failure log: ${why}`, permanent: reading.permanent };
  }
  const keys = reading.kind === "failure" ? headFailures(reading.failure) : {};
  await saveMainFailures(db, { repo, headSha: red.sha, state: "read", keys, reason: null, readAt: at });
  return { keys };
}

/**
 * Reads and compares one PR head's failing required checks (`failing`) with the red main's and stores the result. An unread log, and
 * a read that fails, is read again after the backoff while the head stays; one GitHub no longer serves, or a day of unread reads,
 * counts as new. `mainUnread`: main's log was the one that could not be read.
 */
export async function judgeHead(db: Db, gh: Gh, o: { repo: string; number: number; head: string; failing: readonly string[]; red: RedMain; prev: VsMainRow | null; now: Date }): Promise<{ row: VsMainRow; mainUnread: boolean }> {
  const at = o.now.toISOString();
  const prev = o.prev && o.prev.mainHead === o.red.sha && (o.prev.state === "unread" || o.prev.state === "early") ? o.prev : null;
  const base = { repo: o.repo, number: o.number, head: o.head, mainHead: o.red.sha, failing: [...o.failing], reads: (prev?.reads ?? 0) + 1, firstAt: prev?.firstAt ?? at, readAt: at };
  const save = async (r: VsMainRow, mainUnread = false): Promise<{ row: VsMainRow; mainUnread: boolean }> => { await saveVsMain(db, r); return { row: r, mainUnread }; };
  const unread = (why: string, permanent: boolean, mainUnread = false) => {
    const ended = permanent || o.now.getTime() - Date.parse(base.firstAt) >= VS_MAIN_UNREAD_END_MS;
    return save({ ...base, state: ended ? "unparsed" : "unread", checks: [], reason: oneLine(ended ? `the failure log cannot be read: ${why}` : why) }, mainUnread && !ended);
  };
  try {
    const optional = await optionalChecks(db, o.repo);
    const main = await mainFailures(db, gh, o.repo, o.red, optional, at);
    if ("why" in main) return await unread(main.why, main.permanent, true);
    const reading = await readFailure(gh, o.repo, o.head, optional, { cap: COMPARE_CAP });
    if (reading.kind === "unread") return await unread(reading.why, reading.permanent);
    if (reading.kind === "skip") return await save({ ...base, state: "unparsed", checks: [], reason: oneLine(reading.why) });
    const r = compareFailures(headFailures(reading.failure), main.keys, o.failing, o.red.redAt);
    return await save({ ...base, state: r.state, checks: r.checks, reason: r.reason });
  } catch (e) {
    return await unread(`the comparison failed: ${oneLine(String((e as Error).message ?? e))}`, false);
  }
}

/** Open PR heads one checks job compares at most; the rest wait for the next. */
const COMPARE_PER_JOB = 10;

/**
 * The checks job's part (src/review/index.ts runChecks): each open PR of the repo just read whose CI is red on checks that all fail on
 * the red main by name, and whose comparison is due, is read and compared now; batch PRs are left to the merge job, which compares them
 * with main at their base. A main log that cannot be read ends the job's comparisons. Returns how many were read.
 */
export async function compareRepo(db: Db, gh: Gh, repo: string, prs: readonly PrChecks[], log: (line: string) => void, now: () => Date = () => new Date()): Promise<number> {
  const red = (await redMainHeads(db, now().getTime())).get(repo);
  if (!red) return 0;
  const [optional, batches] = await db.together(() => Promise.all([optionalChecks(db, repo), loadOwnIntegration(db, [repo])]));
  const open = prs.filter((p) => p.state === "OPEN" && !batches.has(`${repo}#${p.number}`));
  const rows = await loadVsMain(db, open.map((p) => ({ repo, number: p.number })));
  let read = 0;
  for (const p of open) {
    if (read >= COMPARE_PER_JOB) break;
    const failing = p.checks.filter((c) => c.state === "failure" && !optional.includes(c.name)).map((c) => c.name);
    const prev = rows.get(`${repo}#${p.number}@${p.head_oid}`) ?? null;
    const st = vsMainStatus({ failing, red, row: prev, now: now().getTime() });
    if (st.skip || !st.due) continue;
    read++;
    const { row, mainUnread } = await judgeHead(db, gh, { repo, number: p.number, head: p.head_oid, failing, red, prev, now: now() });
    log(`  ${repo}#${p.number}: CI compared with main's at ${red.sha.slice(0, 8)}: ${row.state}${row.reason ? ` (${row.reason})` : ""}`);
    if (mainUnread) break;
  }
  return read;
}
