// Reads why a head's CI failed. Read-only, no write wrapper: one `gh` call for the head's check runs, then one per failed run,
// or, while the run goes on, two per failed check of it (its job's log and step list). The text is the PR's own CI output,
// so it is untrusted data wherever it goes next (a prompt frames it as such).
import type { Gh } from "../merge/safe-merge.ts";
import type { CiFailure, FailedCheck, FailedStep } from "./types.ts";
import { slugOf } from "../owners.ts";

/** Characters kept from the end of one failed step's log, per check, and in all. */
export const STEP_TAIL = 4000;
export const CHECK_CAP = 8000;
export const TOTAL_CAP = 16_000;
/** Failed steps kept per check. */
const MAX_STEPS = 3;

const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure", "stale"]);
/** Colour codes, raw or in the caret notation (`^[[1m`) some job logs carry them in. */
const ANSI = /(?:\u001b|\^\[)\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const GATE = /gate/i;

type CheckRuns = { check_runs?: { id?: number; name?: string; status?: string; conclusion?: string | null; details_url?: string | null; completed_at?: string | null }[] };
/** `checkId`: the check run's id, which for a GitHub Actions check is its job's id. */
type Run = { name: string; conclusion: string; runId: number | null; checkId: number | null; completedAt: string | null };

/**
 * The failed check runs of a head. The repos' CI calls the suite's gate workflow, so its checks carry "gate" in their
 * name; when some failed check does, only those count (a failing optional check next to a passing gate is not the
 * gate's failure). With no such name every failed check counts. `gates`: "passed" when gate checks exist, none failed and
 * all have completed as success, skipped or neutral, so whatever fails is not the gate and is left alone; "running" when
 * gate checks exist, none failed and some have not completed, so the head is not judged yet; "none" otherwise. Checks on
 * the repo's optional list are never failures to fix. `every`: each failed check counts and gates are "none", for a reading that compares
 * every failing check (src/mainci/no-new.ts).
 */
export function failedRuns(reply: CheckRuns, optional: string[] = [], every = false): { runs: Run[]; gates: "passed" | "running" | "none" } {
  const all = reply.check_runs ?? [];
  const failed = all.filter((c) => c.status === "completed" && FAILED.has(c.conclusion ?? "") && !optional.includes(c.name ?? "?"))
    .map((c) => ({ name: c.name ?? "?", conclusion: c.conclusion ?? "failure", runId: Number(/\/actions\/runs\/(\d+)/.exec(c.details_url ?? "")?.[1]) || null, checkId: c.id ?? null, completedAt: c.completed_at ?? null }));
  if (every) return { runs: failed, gates: "none" };
  const gate = failed.filter((c) => GATE.test(c.name));
  const gateChecks = all.filter((c) => GATE.test(c.name ?? ""));
  const gates = gate.length || !gateChecks.length ? "none"
    : gateChecks.every((c) => c.status === "completed" && ["success", "skipped", "neutral"].includes(c.conclusion ?? "")) ? "passed" : "running";
  return { runs: gate.length ? gate : failed, gates };
}

/** The step name `gh` gives every line when it cannot split a job's log into steps: the line's job log is then the whole job's. */
export const UNKNOWN_STEP = "UNKNOWN STEP";
const POST_JOB = /^Post job cleanup\.$/;
const ERROR_LINE = /^##\[error\]/;
/** A step's start: a composite action step's display name, or the `Run <command>` group every step opens with. */
const START_ACTION = /^##\[start-action display=([^;\]]+)/;
const END_ACTION = /^##\[end-action /;
const GROUP_RUN = /^##\[group\]Run (.+)$/;
/** Characters of a step name taken from a log line. */
const STEP_NAME = 80;

/** Log lines read one at a time, so a long log is not copied whole. */
type Lines = { length: number; at: (i: number) => string };
const ofArray = (a: readonly string[]): Lines => ({ length: a.length, at: (i) => a[i]! });

/** The first post-job cleanup line (which can run to hundreds of kilobytes after the failure), or the end. */
function postStart(lines: Lines): number {
  for (let i = 0; i < lines.length; i++) if (POST_JOB.test(lines.at(i))) return i;
  return lines.length;
}

/** The end (exclusive) of the failed part of lines [from, to): through its last `##[error]` line, or all of it without one. */
function errorEnd(lines: Lines, from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (ERROR_LINE.test(lines.at(i))) return i + 1;
  return to;
}

/** The step line `from` belongs to: the nearest step start at or before it. A `Run` group right after a display name is that display name's step. */
function stepAt(lines: Lines, from: number): string {
  for (let i = from; i >= 0; i--) {
    const l = lines.at(i);
    const shown = START_ACTION.exec(l);
    if (shown) return shown[1]!.trim().slice(0, STEP_NAME);
    const run = GROUP_RUN.exec(l);
    if (run) return ((i > 0 ? START_ACTION.exec(lines.at(i - 1))?.[1] : undefined) ?? run[1]!).trim().slice(0, STEP_NAME);
  }
  return UNKNOWN_STEP;
}

/** The last STEP_TAIL characters of lines [from, to), each ending in a newline, built from the end. */
function tailOf(lines: Lines, from: number, to: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = to - 1; i >= from && size < STEP_TAIL; i--) {
    const l = `${lines.at(i)}\n`;
    parts.push(l);
    size += l.length;
  }
  const tail = parts.reverse().join("");
  return tail.length > STEP_TAIL ? tail.slice(-STEP_TAIL) : tail;
}

/** A whole job's failed step: up to its last `##[error]` line before the post-job cleanup, named after the nearest step start above it. */
function failedTail(job: string, lines: Lines): FailedStep {
  const end = errorEnd(lines, 0, postStart(lines));
  return { job, step: stepAt(lines, end - 1), tail: tailOf(lines, 0, end) };
}

/**
 * `gh run view --log-failed` lines are `job<TAB>step<TAB>text`; groups them per job and step, in order. A job whose lines all name
 * no step (`UNKNOWN STEP`) is cut to its failed step (failedTail).
 */
export function parseFailedLog(text: string): FailedStep[] {
  const groups = new Map<string, { job: string; step: string; lines: string[] }>();
  for (const line of text.split("\n")) {
    const [job, step, ...rest] = line.split("\t");
    if (job === undefined || step === undefined || !rest.length) continue;
    const key = `${job}\t${step}`;
    const g = groups.get(key) ?? { job, step, lines: [] };
    g.lines.push(rest.join("\t").replace(ANSI, "").replace(STAMP, "").replace(/\r$/, ""));
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const lines = ofArray(g.lines);
    return g.step === UNKNOWN_STEP ? failedTail(g.job, lines) : { job: g.job, step: g.step, tail: tailOf(lines, 0, lines.length) };
  });
}

/** A step of a job as the jobs API lists it. */
export type JobStep = { name?: string; conclusion?: string | null };

/** A raw job log's lines by offset, each without its timestamp, colour codes and CR. */
function jobLines(text: string): Lines {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0 && i < text.length - 1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const last = text.endsWith("\n") ? text.length - 1 : text.length;
  return {
    length: starts.length,
    at: (i) => text.slice(starts[i]!, i + 1 < starts.length ? starts[i + 1]! - 1 : last).replace(ANSI, "").replace(/\r$/, "").replace(/^﻿/, "").replace(STAMP, ""),
  };
}

/**
 * A single job's raw log (`<timestamp> <text>` lines), as the jobs API serves it, cut to its failed steps. The log holds one
 * section per step that ran, in order: the job's setup, then one per `##[group]Run` outside a composite action's
 * `##[start-action]`/`##[end-action]`. When those sections match the steps that ran (`steps`, from the jobs API; skipped steps
 * write nothing), each failed step is its own section under its own name; otherwise the log is cut at its last error, named
 * after the nearest step start.
 */
export function parseJobLog(job: string, text: string, steps: readonly JobStep[] = []): FailedStep[] {
  const lines = jobLines(text);
  const post = postStart(lines);
  const firstPost = steps.findIndex((s) => /^Post /.test(s.name ?? "") || s.name === "Complete job");
  const ran = (firstPost < 0 ? steps : steps.slice(0, firstPost)).filter((s) => s.conclusion !== "skipped");
  const starts = [0];
  let depth = 0;
  for (let i = 0; i < post; i++) {
    const l = lines.at(i);
    if (START_ACTION.test(l)) depth++;
    else if (END_ACTION.test(l)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && GROUP_RUN.test(l)) starts.push(i);
  }
  if (ran.length === starts.length) {
    const out = ran.flatMap((s, k) => {
      if (s.conclusion !== "failure") return [];
      const from = starts[k]!;
      return [{ job, step: (s.name ?? UNKNOWN_STEP).slice(0, STEP_NAME), tail: tailOf(lines, from, errorEnd(lines, from, starts[k + 1] ?? post)) }];
    });
    if (out.length) return out;
  }
  return [failedTail(job, lines)];
}

/** `gh run view` refuses a run's log while the run goes on. */
const IN_PROGRESS = /is still in progress/i;
const firstLine = (e: unknown): string => String((e as Error).message ?? e).split("\n")[0]!.slice(0, 200);

/**
 * GitHub answers that the log is gone (expired, deleted): reading it again finds nothing either. A 404 is not: GitHub gives it for a
 * failed job's log while its run still goes on, and a log that really is gone ends after a day of reads.
 */
const GONE = /\bHTTP 410\b/;

/**
 * `unread`: a failed check's log could not be read, so no CI fix try is made; `failure` holds every failed check, those without a
 * readable log with no steps. `permanent`: no later read can find it (GitHub answers that the log is gone, or the run's log holds no
 * job of the check), so the caller ends the head instead of reading it again.
 */
export type Reading = { kind: "failure"; failure: CiFailure } | { kind: "skip"; why: string } | { kind: "unread"; why: string; failure: CiFailure; permanent: boolean };

/**
 * Reads the failed checks of `head` and the failed steps' log tails. A head with no failed check run (a commit status
 * or an action_required run failed it), or whose gate checks all passed, is skipped: there is nothing here to fix.
 */
export async function readFailure(gh: Gh, repo: string, head: string, optional: string[] = [], every = false): Promise<Reading> {
  const { runs, gates } = failedRuns(JSON.parse(await gh(["api", `repos/${slugOf(repo)}/commits/${head}/check-runs?per_page=100`])) as CheckRuns, optional, every);
  if (gates === "running") return { kind: "unread", why: "the gate checks are still running", failure: { head, checks: [] }, permanent: false };
  if (gates === "passed") return { kind: "skip", why: "the gate checks passed; only an optional check failed" };
  if (!runs.length) return { kind: "skip", why: "no failed check run at the head (a commit status or a run waiting for approval failed)" };
  // Per run: its failed steps, or "jobs" when the run goes on and each failed check's own job log is read instead.
  const logs = new Map<number, FailedStep[] | "jobs">();
  const checks: FailedCheck[] = [];
  let total = 0;
  let unread: string | null = null, gone: string | null = null;
  const missed = (why: string, fallback: string): void => { if (GONE.test(why)) gone ??= `${fallback.replace("could not be read yet", "is gone")}: ${why}`; else unread ??= `${fallback}: ${why}`; };
  for (const r of runs) {
    let steps: FailedStep[] = [];
    if (r.runId !== null && r.conclusion === "failure") {
      if (!logs.has(r.runId)) {
        // GitHub serves a run's log only once the whole run has ended; a completed job's own log is served at once.
        try { logs.set(r.runId, parseFailedLog(await gh(["run", "view", String(r.runId), "--repo", `${slugOf(repo)}`, "--log-failed"]))); }
        catch (e) {
          const why = firstLine(e);
          if (IN_PROGRESS.test(why)) logs.set(r.runId, "jobs");
          else { logs.set(r.runId, []); missed(why, `the log of run ${r.runId} could not be read yet`); }
        }
      }
      const all = logs.get(r.runId)!;
      if (all === "jobs") {
        if (r.checkId === null) unread ??= `the log of run ${r.runId} could not be read yet: it is still in progress and ${r.name} names no job`;
        else {
          const job = `repos/${slugOf(repo)}/actions/jobs/${r.checkId}`;
          let text: string | null = null;
          // `gh api` refuses output with terminal escape sequences unless told to pass them; parseJobLog strips them.
          try { text = await gh(["api", `${job}/logs`, "--allow-escape-sequences"]); }
          catch (e) { missed(firstLine(e), `the log of job ${r.checkId} of run ${r.runId} could not be read yet`); }
          if (text !== null) {
            // Without the job's step list the log is still cut at its last error, so a failed read of it is not an unread log.
            let listed: JobStep[] = [];
            try { listed = (JSON.parse(await gh(["api", job])) as { steps?: JobStep[] }).steps ?? []; } catch { listed = []; }
            steps = parseJobLog(r.name, text, listed);
          }
        }
      } else {
        // A run holds several checks (jobs); a step belongs to the check whose name ends with its job's name.
        steps = all.filter((s) => r.name === s.job || r.name.endsWith(` / ${s.job}`));
        if (!steps.length && runs.filter((x) => x.runId === r.runId).length === 1) steps = all;
        // The run has ended (its whole log was served) and no job in it matches the check: a later read finds the same.
        if (!steps.length && all.length) gone ??= `the log of run ${r.runId} has no failed step of ${r.name}`;
        else if (!steps.length) unread ??= `the log of run ${r.runId} has no failed step of ${r.name} yet`;
      }
    }
    const kept: FailedStep[] = [];
    let size = 0;
    for (const s of steps.slice(-MAX_STEPS)) {
      const room = Math.min(CHECK_CAP - size, TOTAL_CAP - total);
      if (room <= 0) break;
      const tail = s.tail.length > room ? s.tail.slice(-room) : s.tail;
      kept.push({ ...s, tail });
      size += tail.length;
      total += tail.length;
    }
    checks.push({ name: r.name, conclusion: r.conclusion, runId: r.runId, completedAt: r.completedAt, steps: kept });
  }
  if (gone !== null) return { kind: "unread", why: gone, failure: { head, checks }, permanent: true };
  return unread === null ? { kind: "failure", failure: { head, checks } } : { kind: "unread", why: unread, failure: { head, checks }, permanent: false };
}
