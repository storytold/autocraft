// No new failures: while the default branch is red, a PR's (or batch PR's) CI counts as passing when every failing required check
// also fails at main's red settled head and names no failing test or location main's log does not name for that check. The logs
// are read with the CI fix's reader and parsed with the shared parser (src/core/failure-locations.ts); main's failures are read
// once per head and kept (main_ci_failures), a PR head's only while its CI and main are both red. A log that cannot be read, or
// names nothing, counts as new. Read-only on GitHub.
import type { Gh } from "../merge/safe-merge.ts";
import type { CiFailure } from "../cifix/types.ts";
import { readFailure, type Reading } from "../cifix/logs.ts";
import { testLocations } from "../core/failure-locations.ts";
import { CIFIX_UNREAD_DELAYS_MS, passesNote, repeatAfter } from "../core/rules.ts";
import { optionalChecks } from "../optional-checks.ts";
import { loadMainFailures, loadVsMainAt, saveMainFailures, saveVsMain, type VsMainRow } from "../data/merge/index.ts";
import { redMainHeads } from "./index.ts";
import type { PrChecks } from "../review/checks.ts";
import { loadVsMain } from "../data/merge/index.ts";
import type { KeySource } from "../data/keys.ts";
import type { Db } from "../db/index.ts";

/** A red default branch: the settled head its state comes from, the checks that failed there, and when it stops counting as red with nothing new read (null: only a new result ends it). */
export type RedMain = { sha: string; failing: string[]; until: number | null };

/** Failing tests and locations per check. */
export type FailureKeys = Record<string, string[]>;

/** A PR head stays unread this long after its first unread read; then its failure counts as new. */
export const VS_MAIN_UNREAD_END_MS = 24 * 3600_000;

/** The identity of a failure: the panicking test's name when the log names one (its line moves with edits), else the file and line. */
const keyOf = (l: { file: string; line: number; test: string | null }): string => (l.test ? `test ${l.test}` : `${l.file}:${l.line}`);

/** The failing tests and locations of each check of a reading. */
export function failureKeys(f: CiFailure): FailureKeys {
  const out: FailureKeys = {};
  for (const c of f.checks) out[c.name] = [...new Set(testLocations(c.steps.map((s) => s.tail).join("\n")).places.map(keyOf))];
  return out;
}

/**
 * Compares a PR head's failing required checks (`failing`) with main's. not-new: every one fails on main with only failing tests or
 * locations main's has; new: some check passes on main or names one main's does not; unparsed: some side's log named nothing.
 */
export function compareFailures(pr: FailureKeys, main: FailureKeys, failing: readonly string[]): { state: "not-new" | "new" | "unparsed"; checks: string[]; reason: string } {
  const notNew: string[] = [];
  let fresh: string | null = null, unparsed: string | null = null;
  for (const c of failing) {
    const m = main[c], p = pr[c];
    if (!m) { fresh ??= `${c} passes on main`; continue; }
    if (!p?.length) { unparsed ??= `the log of ${c} names no failing test or location`; continue; }
    if (!m.length) { unparsed ??= `main's log of ${c} names no failing test or location`; continue; }
    const extra = p.find((k) => !m.includes(k));
    if (extra) { fresh ??= `${c} fails at ${extra}, which main does not`; continue; }
    notNew.push(c);
  }
  if (fresh) return { state: "new", checks: notNew, reason: fresh };
  if (unparsed) return { state: "unparsed", checks: notNew, reason: unparsed };
  return { state: "not-new", checks: notNew, reason: passesNote(notNew) };
}

/**
 * Where a head whose CI is red stands against a red main: `skip` when no comparison applies (main is not red, nothing fails, or a
 * failing check passes on main by name, so the failure is new without a read); `due` when it is to be read (no row against main's
 * head, or an unread row whose backoff ended), else `at` when an unread row is read again; `row` is the current row against main's head.
 */
export function vsMainStatus(o: { failing: readonly string[]; red: RedMain | undefined; row: VsMainRow | null | undefined; now: number }):
  { skip: true } | { skip: false; due: boolean; at: number | null; row: VsMainRow | null } {
  const { failing, red } = o;
  if (!red || !failing.length || failing.some((n) => !red.failing.includes(n))) return { skip: true };
  const row = o.row && o.row.mainHead === red.sha ? o.row : null;
  if (!row) return { skip: false, due: true, at: null, row: null };
  if (row.state !== "unread") return { skip: false, due: false, at: null, row };
  const at = repeatAfter(Date.parse(row.readAt), row.reads, CIFIX_UNREAD_DELAYS_MS);
  return { skip: false, due: at <= o.now, at: at > o.now ? at : null, row };
}

/** The failing checks a row lets pass: those found not new, only while the whole head is not new against main's current red head. */
export const passingChecks = (row: VsMainRow | null | undefined, red: RedMain | undefined): string[] =>
  row && red && row.mainHead === red.sha && row.state === "not-new" ? row.checks : [];

/** The failing checks found not new at a head, also when others are new: the CI fix leaves them to main. */
export const mainsChecks = (row: VsMainRow | null | undefined, red: RedMain | undefined): string[] =>
  row && red && row.mainHead === red.sha && (row.state === "not-new" || row.state === "new") ? row.checks : [];

/** passingChecks of a PR head against the repo's red main now; none when main is not red. */
export async function mainsFailuresAt(db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<string[]> {
  const [red, row] = await db.together(() => Promise.all([redMainHeads(db, nowMs), loadVsMainAt(db, repo, number, head)]));
  return passingChecks(row, red.get(repo));
}

/**
 * readFailure of a PR head for a fix (the CI fix, an implementation's revision) without the failed checks found failing only where the
 * red main fails: those are main's to fix. A reading left with no check is skipped.
 */
export async function ownFailure(db: Db, gh: Gh, repo: string, number: number, head: string): Promise<Reading> {
  const reading = await readFailure(gh, repo, head, await optionalChecks(db, repo));
  if (reading.kind === "skip") return reading;
  const [red, row] = await db.together(() => Promise.all([redMainHeads(db), loadVsMainAt(db, repo, number, head)]));
  const mains = mainsChecks(row, red.get(repo));
  if (!mains.length) return reading;
  const checks = reading.failure.checks.filter((c) => !mains.includes(c.name));
  if (!checks.length) return { kind: "skip", why: `the failed checks fail only where the default branch fails (${mains.join(", ")})` };
  return { ...reading, failure: { ...reading.failure, checks } };
}

/** passingChecks for the PRs in `keys`, read once: the checks of `ref` ("repo#number") at `head` that fail only where the red main fails. */
export async function mainsFailuresOf(db: Db, keys: KeySource, nowMs: number = Date.now()): Promise<(ref: string, head: string) => string[]> {
  const [red, rows] = await db.together(() => Promise.all([redMainHeads(db, nowMs), loadVsMain(db, keys)]));
  return (ref, head) => passingChecks(rows.get(`${ref}@${head}`), red.get(ref.slice(0, ref.lastIndexOf("#"))));
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);

/** Main's failures at its red head, read once and kept; null while a log cannot be read (`why`). */
async function mainKeys(db: Db, gh: Gh, repo: string, red: RedMain, optional: string[], at: string): Promise<{ keys: FailureKeys } | { why: string }> {
  const stored = await loadMainFailures(db, repo, red.sha);
  if (stored?.state === "read") return { keys: stored.keys };
  const reading = await readFailure(gh, repo, red.sha, optional, true);
  if (reading.kind === "unread") {
    const why = oneLine(reading.why);
    await saveMainFailures(db, { repo, headSha: red.sha, state: "unread", keys: {}, reason: why, readAt: at });
    return { why: `main's failure log: ${why}` };
  }
  const keys = reading.kind === "failure" ? failureKeys(reading.failure) : {};
  await saveMainFailures(db, { repo, headSha: red.sha, state: "read", keys, reason: null, readAt: at });
  return { keys };
}

/**
 * Reads and compares one PR head's failing required checks (`failing`) with the red main's and stores the result. An unread log is
 * read again after the backoff while the head stays; one GitHub no longer serves, or a day of unread reads, counts as new.
 */
export async function judgeHead(db: Db, gh: Gh, o: { repo: string; number: number; head: string; failing: readonly string[]; red: RedMain; prev: VsMainRow | null; now: Date }): Promise<VsMainRow> {
  const at = o.now.toISOString();
  const prev = o.prev && o.prev.mainHead === o.red.sha && o.prev.state === "unread" ? o.prev : null;
  const base = { repo: o.repo, number: o.number, head: o.head, mainHead: o.red.sha, reads: (prev?.reads ?? 0) + 1, firstAt: prev?.firstAt ?? at, readAt: at };
  const save = async (r: VsMainRow): Promise<VsMainRow> => { await saveVsMain(db, r); return r; };
  const unread = (why: string, permanent: boolean): Promise<VsMainRow> => {
    const ended = permanent || o.now.getTime() - Date.parse(base.firstAt) >= VS_MAIN_UNREAD_END_MS;
    return save({ ...base, state: ended ? "unparsed" : "unread", checks: [], reason: oneLine(ended ? `the failure log cannot be read: ${why}` : why) });
  };
  const optional = await optionalChecks(db, o.repo);
  const main = await mainKeys(db, gh, o.repo, o.red, optional, at);
  if ("why" in main) return unread(main.why, false);
  const reading = await readFailure(gh, o.repo, o.head, optional, true);
  if (reading.kind === "unread") return unread(reading.why, reading.permanent);
  if (reading.kind === "skip") return save({ ...base, state: "unparsed", checks: [], reason: oneLine(reading.why) });
  const r = compareFailures(failureKeys(reading.failure), main.keys, o.failing);
  return save({ ...base, state: r.state, checks: r.checks, reason: r.reason });
}

/** Open PR heads one checks job compares at most; the rest wait for the next. */
const COMPARE_PER_JOB = 10;

/**
 * The checks job's part (src/review/index.ts runChecks): each open PR of the repo just read whose CI is red on checks that all fail on
 * the red main by name, and whose comparison is due, is read and compared now. Returns how many were read.
 */
export async function compareRepo(db: Db, gh: Gh, repo: string, prs: readonly PrChecks[], log: (line: string) => void, now: () => Date = () => new Date()): Promise<number> {
  const red = (await redMainHeads(db, now().getTime())).get(repo);
  if (!red) return 0;
  const optional = await optionalChecks(db, repo);
  const open = prs.filter((p) => p.state === "OPEN");
  const rows = await loadVsMain(db, open.map((p) => ({ repo, number: p.number })));
  let read = 0;
  for (const p of open) {
    if (read >= COMPARE_PER_JOB) break;
    const failing = p.checks.filter((c) => c.state === "failure" && !optional.includes(c.name)).map((c) => c.name);
    const prev = rows.get(`${repo}#${p.number}@${p.head_oid}`) ?? null;
    const st = vsMainStatus({ failing, red, row: prev, now: now().getTime() });
    if (st.skip || !st.due) continue;
    read++;
    try {
      const r = await judgeHead(db, gh, { repo, number: p.number, head: p.head_oid, failing, red, prev, now: now() });
      log(`  ${repo}#${p.number}: CI compared with main's at ${red.sha.slice(0, 8)}: ${r.state}${r.reason ? ` (${r.reason})` : ""}`);
    } catch (e) {
      log(`  ${repo}#${p.number}: CI not compared with main's: ${oneLine(String((e as Error).message ?? e))}`);
    }
  }
  return read;
}
