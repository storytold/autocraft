// The build bucket of the `implement` step: from a stored plan to a change that passes AutoCraft's checks, then the PR.
// A job does one unit and stores where it got: a session turn (state implementing, or fixing for a follow-up) and, when
// time allows, the checks after it (checking); clean checks hand the attempt to the PR step (opening). Findings go back to
// the same session, FOLLOW_UP_ROUNDS times at most; a follow-up its Task Runner no longer takes starts a fresh session on the
// changes. Anything that cannot go on makes the attempt stuck (stuck.ts).
// Every step is resumable from the rounds: a turn is a round from the write that queues its call, so a later job waits
// for that call instead of making another; the reply is in the round as soon as it is read; the next turn, the lint turn,
// the checks and their outcome follow from the rounds after the latest `workspace` round, so a restart at any await
// neither starts a second session in the workspace nor repeats a settled turn or checks.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import { loadEnvs } from "../data/build/index.ts";
import { createWorkspace, getWorkspace, LIVE_STATES, resumeWorkspace, type WorkspaceStateName } from "../build/workspaces.ts";
import { READY_LIMIT_MS } from "../build/workspace-launch.ts";
import { guardedApi, inClusterApi, type KubeApi } from "../build/kube-api.ts";
import type { By } from "../core/gates.ts";
import { assertFence } from "../db/fence.ts";
import { fixupDir, Git, exec as realExec } from "../fixup/git.ts";
import { buildScriptsAt } from "../fixup/patch.ts";
import { validateImplementation, workspaceDiff } from "./diff.ts";
import { defaultPrDeps, openImplementationPr } from "./pr.ts";
import { checkLines, roundDir, runChecks, workspacePod, type CheckRound, type Pod } from "./checks.ts";
import {
  awaitTurn, findingsMessage, lintedReport, LOST_REPLY_MESSAGE, needsDependency, queueTurn, realCalls, REPORT_MESSAGE, retryStdin, SESSION_MODEL, sessionInput, sessionTask,
  settleOrphan, summaryFixTurn, type CallDeps, type TurnRequest, type TurnRound,
} from "./session.ts";
import { applyStuckAnswer, markStuck, opensAsDraft, stuckLine, type DiffCheck, type StuckCause } from "./stuck.ts";
import { attemptNow, currentAttempt, roundOf, writeStep, type Attempt, type NewRound } from "./attempt.ts";
import { BUILD_STATES, type Implementation, type ImplementationPatch, type ImplementationRound, type ImplementationState, type RetryRound, type SessionReport } from "./types.ts";

/** Follow-up turns with the checks' findings before the attempt is stuck (D6). */
export const FOLLOW_UP_ROUNDS = 3;
/** Model calls one job makes at most: a turn, its report or lint follow-up, and a fresh session. */
const TURNS_PER_JOB = 4;
/** Sessions started over on the changes (a lost harness session or a failed follow-up) between two checks rounds before the attempt is stuck. */
const FRESH_PER_CHECKS = 2;
/** A job that has run this long ends after its turn; the next job runs the checks, so a long session and its checks do not share one job's time limit. */
const CHECKS_IN_SAME_JOB_MS = 60 * 60_000;
/** A workspace made again for an attempt whose workspace was lost. */
const WORKSPACE_DEADLINE_SEC = 12 * 3600;
/** Consecutive PR attempts that failed in a way a later run may fix before the attempt is stuck. */
const PUSH_FAILURES_MAX = 3;
const READY_POLL_MS = 3000;
const SHA = /^[0-9a-f]{40}$/;

/** What a build job needs from its context; StepContext has it. */
export type BuildRun = {
  db: Db;
  log(line: string): void;
  progress(text: string): Promise<void>;
  cancelled(): Promise<boolean>;
  stopping(): Promise<boolean>;
  /** When the job started (ms). */
  startedMs: number;
  /** Stop at `opening`: nothing goes to GitHub (the CLI's --no-pr). */
  noPr?: boolean;
  /** The job's actor, for the PR step's guard; default the pipeline. */
  by?: By;
};

/** `checks`: the last checks round; a draft may have none, or failing ones. */
export type OpenPr = (run: BuildRun, impl: Implementation, o: { draft: boolean; checks: CheckRound | null }) =>
  Promise<{ ok: true; url: string } | { ok: false; reason: string; retry: boolean; problems?: string[]; recheck?: boolean; stale?: boolean }>;

export type BuildDeps = {
  calls: CallDeps;
  pod(db: Db, workspaceId: number, cancelled: () => Promise<boolean>): Pod;
  /** Whether the change passes the PR step's diff check, for the stuck blocker's Open as draft PR. */
  diffCheck: DiffCheck;
  /** Opens the PR (the PR step). Absent: a clean attempt waits in `opening`. */
  openPr?: OpenPr;
};

/** The cluster API to the workspaces, fenced like the checks' pod. */
function workspaceApi(db: Db): KubeApi {
  const cluster = inClusterApi();
  if (!cluster) throw new Error("this runner is not in the cluster, so it cannot reach the workspace");
  return guardedApi(cluster, () => assertFence(db));
}

/** The attempt's change as the PR step reads it: the workspace diff against its base commit. */
async function attemptDiff(db: Db, impl: Implementation) {
  if (impl.workspaceId === null) return { ok: false as const, reason: "the attempt has no workspace" };
  return await workspaceDiff(db, workspaceApi(db), impl.workspaceId);
}

/** The PR step: the workspace diff, applied and opened by pr.ts with this round's check list. */
const realOpenPr: OpenPr = async (run, impl, o) => {
  const d = await attemptDiff(run.db, impl);
  if (!d.ok) return { ok: false, reason: d.reason, retry: true };
  // The change being pushed must be the one the last clean checks ran on.
  if (!o.draft && o.checks && createHash("sha256").update(Buffer.from(d.diff)).digest("hex") !== o.checks.diffHash) {
    return { ok: false, reason: "the workspace changed after the last clean checks", retry: false, recheck: true };
  }
  const r = await openImplementationPr(run.db, {
    implementation: impl, base: d.base, diff: d.diff, model: SESSION_MODEL, checks: o.checks ? checkLines(o.checks) : [], by: run.by ?? "pipeline", draft: o.draft,
  }, { ...defaultPrDeps(), log: run.log });
  return r.ok ? { ok: true, url: r.url } : r;
};

/** Whether the workspace diff passes the PR step's diff check, against the build scripts of the base when the cache has it. */
const realDiffCheck: DiffCheck = async (db, impl) => {
  try {
    const d = await attemptDiff(db, impl);
    if (!d.ok) return { ok: false, reason: d.reason };
    const scripts = await buildScriptsAt(new Git(realExec, fixupDir(), impl.repo), d.base);
    const c = validateImplementation(d.diff, scripts);
    return c.ok ? { ok: true } : { ok: false, reason: c.reason };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

export const defaultBuildDeps = (): BuildDeps => ({ calls: realCalls, pod: workspacePod, diffCheck: realDiffCheck, openPr: realOpenPr });

const ref = (i: Implementation): string => `${i.repo}#${i.number}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const turnResult = (r: ImplementationRound): TurnRound => r.result as TurnRound;
/** The rounds of the attempt's current workspace: those after its latest `workspace` round. */
const epochOf = (rounds: ImplementationRound[]) => rounds.slice(rounds.map((r) => r.kind).lastIndexOf("workspace") + 1);
/** The turn rounds that count: a withdrawn call is as if it was never made. */
const turnsOf = (rounds: ImplementationRound[]) => rounds.filter((r) => (r.kind === "session" || r.kind === "follow-up") && turnResult(r).outcome !== "withdrawn");
const checksOf = (rounds: ImplementationRound[]) => rounds.filter((r) => r.kind === "checks").map((r) => r.result as CheckRound);
const isDiffRefusal = (r: ImplementationRound) => r.kind === "refusal" && (r.result as { kind?: string } | null)?.kind === "diff";
/** Whether the checks ran, or the diff check refused the change, after the turn round `turn`. */
const checkedAfter = (rounds: ImplementationRound[], turn: ImplementationRound) => rounds.some((r) => r.id > turn.id && (r.kind === "checks" || isDiffRefusal(r)));

/** `retry: false`: a stop of our own that a later run cannot get past, which asks at once (markStuck). */
class Stuck extends Error {
  cause_: StuckCause;
  retry: boolean;
  constructor(cause: StuckCause, detail: string, o: { retry?: boolean } = {}) {
    super(detail);
    this.cause_ = cause;
    this.retry = o.retry ?? true;
  }
}

/**
 * Waits for the attempt's workspace to be ready, making it again (once) when it is gone. A new workspace holds none of the
 * attempt's changes: the same write moves the attempt back to `planned` and adds the `workspace` round that ends the turns
 * and checks of the lost one.
 */
async function readyWorkspace(run: BuildRun, impl: Implementation): Promise<{ wsId: number; base: string; impl: Implementation }> {
  const db = run.db;
  const make = async (envId: string, why: string): Promise<number> => {
    if (!impl.baseSha) throw new Stuck("workspace-lost", "the attempt has no base commit");
    const id = await db.write(async () => {
      const id = await createWorkspace(db, { repo: impl.repo, baseSha: impl.baseSha!, envId, limits: { deadlineSec: WORKSPACE_DEADLINE_SEC }, owner: `implementation ${impl.id}` });
      impl = (await step(db, impl, { to: "planned", patch: { workspaceId: id, sessionCallId: null }, rounds: [{ kind: "workspace", result: { workspaceId: id, reason: why } }] })).impl;
      return id;
    });
    run.log(`${ref(impl)}: workspace ${id} requested (${why}); the session starts over from the plan`);
    return id;
  };
  const envOf = async (wsId: number | null): Promise<string> => (wsId !== null ? (await getWorkspace(db, wsId))?.env_id : undefined)
    ?? (await loadEnvs(db, { kind: "kubernetes", enabled: true })).map((e) => e.id).sort()[0]
    ?? (() => { throw new Stuck("workspace-lost", "no kubernetes environment is set up for workspaces"); })();
  let wsId = impl.workspaceId, remade = false;
  const live = async (id: number | null) => id !== null && LIVE_STATES.includes((await getWorkspace(db, id))?.state as WorkspaceStateName);
  if (!await live(wsId)) {
    wsId = await make(await envOf(wsId), `workspace ${wsId} was gone`);
    remade = true;
  }
  for (let from = Date.now(), last = "";;) {
    const w = await getWorkspace(db, wsId!);
    let gone: string | null = null;
    if (!w) gone = "is gone";
    else if (w.state === "ready") return { wsId: wsId!, base: w.base_commit && SHA.test(w.base_commit) ? w.base_commit : impl.baseSha ?? w.base_sha, impl };
    else if (w.state === "parked" && !await resumeWorkspace(db, wsId!)) gone = `is parked and could not be resumed${w.error ? `: ${w.error}` : ""}`;
    else if (!LIVE_STATES.includes(w.state as WorkspaceStateName)) gone = `is ${w.state}${w.error ? `: ${w.error}` : ""}`;
    else if (Date.now() - from > READY_LIMIT_MS) gone = `was not ready within ${Math.round(READY_LIMIT_MS / 60_000)} min`;
    if (gone) {
      if (remade) throw new Stuck("workspace-lost", `workspace ${wsId} ${gone}`);
      wsId = await make(await envOf(wsId), `workspace ${wsId} ${gone}`);
      remade = true;
      from = Date.now();
      continue;
    }
    if (await run.cancelled()) throw new Error("cancelled while the workspace started");
    if (w!.state !== last) {
      last = w!.state;
      await run.progress(`${ref(impl)}: workspace ${wsId} ${last}`);
    }
    await sleep(READY_POLL_MS);
  }
}

/** The last checks round's findings and a refusal after it, for a follow-up turn. */
function fixingMessage(rounds: ImplementationRound[]): string {
  const lastChecks = rounds.map((r) => r.kind).lastIndexOf("checks");
  const refusal = rounds.slice(lastChecks + 1).reverse().find(isDiffRefusal);
  if (refusal) {
    const problems = ((refusal.result as { problems?: string[] }).problems ?? []).slice(0, 30);
    return `These changes cannot go into the pull request:\n${problems.map((p) => `- ${p}`).join("\n")}\nUndo them, keep the rest of your work, run the checks again, and reply with the JSON report as before.`;
  }
  const c = lastChecks >= 0 ? rounds[lastChecks]!.result as CheckRound : null;
  return findingsMessage(c?.findings ?? []);
}

type Next = { finish: { report: SessionReport; callId: number } } | { turn: Omit<TurnRequest, "impl" | "workspaceId"> };

/** What follows the settled turns of the current workspace: the next turn, or the report the checks go on with. */
async function nextTurn(run: BuildRun, impl: Implementation, ws: { base: string }, rounds: ImplementationRound[], turns: ImplementationRound[]): Promise<Next> {
  const db = run.db;
  const input = async (earlier?: Parameters<typeof sessionInput>[3]) => await sessionTask(db, await sessionInput(db, impl, ws.base, earlier));
  const last = turns.at(-1);
  if (!last) return { turn: { purpose: "start", ...await input() } };
  const r = turnResult(last), checked = checkedAfter(rounds, last);
  if (r.purpose === "lint" && !checked) {
    // The summary's lint turn is settled: the report goes on with the summary it left, from the call that has the session.
    return { finish: { report: await lintedReport(db, impl, r, run.log), callId: r.outcome === "done" ? last.callId! : r.parentId! } };
  }
  if (r.outcome === "failed" || r.outcome === "unclaimed") {
    // A failed lint turn is not the session failing: the report went on with a fixed summary.
    const tail = turns.filter((x) => turnResult(x).purpose !== "lint").reverse();
    const streak = tail.findIndex((x) => turnResult(x).outcome !== "failed");
    if (r.outcome === "failed" && (streak < 0 ? tail.length : streak) >= 2) throw new Stuck("session-failed", r.error ?? "the call failed");
    if (r.outcome === "failed" && last.kind === "session") {
      const t = await input();
      return { turn: { purpose: "retry", stdin: await retryStdin(db, last.callId!, t.stdin), prompt: t.prompt } };
    }
    // The follow-up's harness session is gone with its Task Runner, or the follow-up failed: a fresh session on the changes, with what the checks found.
    const lastChecks = rounds.map((x) => x.kind).lastIndexOf("checks");
    const fresh = turns.filter((x) => rounds.indexOf(x) > lastChecks && turnResult(x).purpose === "fresh").length;
    if (fresh >= FRESH_PER_CHECKS) throw new Stuck("session-lost", `the session started over ${fresh} times without reaching the checks; the last turn was ${r.outcome}`);
    const c = checksOf(rounds).at(-1);
    return { turn: { purpose: "fresh", ...await input({ diff_stat: c?.diffStat ?? "", findings: c?.findings ?? [] }) } };
  }
  if (!r.report) {
    if (r.purpose === "report" && !r.lost) throw new Stuck("no-report", r.parseError ?? "no report");
    return { turn: { purpose: "report", stdin: r.lost ? LOST_REPLY_MESSAGE : REPORT_MESSAGE, parentId: last.callId! } };
  }
  if (checked) return { turn: { purpose: "findings", stdin: fixingMessage(rounds), parentId: last.callId! } };
  // A blocked report is linted too: Open as draft PR puts its summary in the PR body.
  const fix = await summaryFixTurn(db, impl, r.report);
  if (fix) return { turn: { purpose: "lint", stdin: fix.stdin, parentId: last.callId!, base: r.report, problems: fix.problems } };
  return { finish: { report: r.report, callId: last.callId! } };
}

/** The session's turns for this unit, until one ends in a report (then checking) or the attempt is stuck. */
async function turnPhase(run: BuildRun, deps: BuildDeps, impl: Implementation, ws: { wsId: number; base: string }, pod: Pod): Promise<Implementation> {
  const db = run.db;
  for (let n = 0;;) {
    const rounds = epochOf(await roundsNow(db, impl));
    const turns = turnsOf(rounds);
    const last = turns.at(-1);
    let round: ImplementationRound;
    if (last && turnResult(last).outcome === "queued") {
      // A turn queued by a job that ended before it read the reply.
      if (await settleOrphan(db, last, run.log)) continue;
      round = last;
      run.log(`${ref(impl)}: waiting for turn ${round.callId} (${turnResult(round).purpose}) of the run before`);
    } else {
      const next = await nextTurn(run, impl, ws, rounds, turns);
      if ("finish" in next) {
        const { report, callId } = next.finish;
        if (report.status === "blocked") {
          impl = (await step(db, impl, { patch: { report, sessionCallId: callId } })).impl;
          throw needsDependency(report) ? new Stuck("needs-dependency", report.blocked_reason ?? "") : new Stuck("blocked", report.blocked_reason ?? "");
        }
        return (await step(db, impl, { to: "checking", patch: { report, sessionCallId: callId } })).impl;
      }
      if (n >= TURNS_PER_JOB) {
        run.log(`${ref(impl)}: ${TURNS_PER_JOB} turns in this job; the next job goes on`);
        return impl;
      }
      if (n > 0 && await run.stopping()) return impl;
      const t = next.turn;
      round = await db.write(async () => {
        const q = await queueTurn(db, deps.calls, { impl, workspaceId: ws.wsId, ...t });
        impl = (await step(db, impl, { to: impl.state === "fixing" ? "fixing" : "implementing", patch: { sessionCallId: q.callId } })).impl;
        return q;
      });
      run.log(`${ref(impl)}: turn ${round.callId} (${t.purpose}) queued for ${impl.queuedBy}'s Task Runner${t.parentId !== undefined ? `, on the session of call ${t.parentId}` : ""}`);
    }
    n++;
    await run.progress(`${ref(impl)}: session turn ${round.callId} (${turnResult(round).purpose})`);
    await awaitTurn(db, deps.calls, pod, { impl, workspaceId: ws.wsId, round, log: run.log });
  }
}

/** Runs the checks and moves the attempt on: to opening when clean, fixing with findings, or stuck. */
async function checksPhase(run: BuildRun, impl: Implementation, ws: { base: string }, pod: Pod): Promise<{ impl: Implementation; line: string }> {
  const db = run.db;
  const all = await roundsNow(db, impl);
  const rounds = epochOf(all);
  const lastTurn = turnsOf(rounds).at(-1);
  // Checks a restart cut off after they were stored count once: their rounds are the turn's result. AutoCraft's own retry of
  // checks without a verdict runs them afresh.
  const retried = rounds.filter((r) => r.kind === "retry" && (r.result as Partial<RetryRound> | null)?.cause === "checks-no-verdict").at(-1);
  const since = rounds.filter((r) => r.kind === "checks" && (!lastTurn || r.id > lastTurn.id) && (!retried || r.id > retried.id)).map((r) => r.result as CheckRound);
  const noVerdict = (x: CheckRound) => !x.findings.length && !x.needsDependency && (x.noVerdict ?? []).length > 0;
  let c = since.at(-1);
  let round = checksOf(all).length;
  if (c) run.log(`${ref(impl)}: checks round ${round} of this turn ran before a restart; its result stands`);
  // A check with no verdict is not a pass: the checks run once more, and a second round without a verdict ends the attempt.
  while (!c || (noVerdict(c) && since.length < 2)) {
    if (c) run.log(`${ref(impl)}: checks round ${round} gave no verdict (${(c.noVerdict ?? []).join("; ")}); running them again`);
    round++;
    await run.progress(`${ref(impl)}: checks, round ${round}`);
    const r = await runChecks(pod, { dir: roundDir(impl.id, round), base: ws.base, round });
    const at = new Date().toISOString();
    const w = await step(db, impl, { patch: { diffStat: r.diffStat }, rounds: [{ kind: "checks", result: r }], at });
    impl = w.impl;
    all.push(roundOf(impl.id, w.roundIds[0]!, { kind: "checks", result: r }, at));
    since.push(r);
    c = r;
    run.log(`${ref(impl)}: checks round ${round}: ${c.diffStat}; ${c.findings.length} findings${c.notes.length ? `; ${c.notes.join("; ")}` : ""}`);
  }
  if (noVerdict(c)) throw new Stuck("checks-no-verdict", (c.noVerdict ?? []).join("; "));
  if (c.needsDependency) throw new Stuck("needs-dependency", "cargo could not resolve a dependency offline");
  if (c.clean) {
    if (c.diffStat === "no changes") throw new Stuck("no-change", "");
    return { impl: (await step(db, impl, { to: "opening" })).impl, line: `checks clean (${c.diffStat})` };
  }
  const failing = checksOf(epochOf(all)).filter((x) => !x.clean && !(x.noVerdict ?? []).length).length;
  if (failing > FOLLOW_UP_ROUNDS) throw new Stuck("checks-failing", `${c.findings.length} findings, first: ${c.findings[0]?.message ?? ""}`);
  return { impl: (await step(db, impl, { to: "fixing" })).impl, line: `checks round ${round}: ${c.findings.length} findings; a follow-up turn is next` };
}

/** Hands a clean attempt to the PR step. */
async function openingPhase(run: BuildRun, deps: BuildDeps, impl: Implementation): Promise<string> {
  const db = run.db;
  if (run.noPr) return "ready for its PR; not opened (--no-pr)";
  if (!deps.openPr) return "ready for its PR; opening it is not available, so it waits";
  const all = await roundsNow(db, impl);
  const rounds = epochOf(all);
  const checks = checksOf(rounds).at(-1) ?? null;
  // A draft is the answer to the stuck blocker: it opens the change as it is, whatever the checks found.
  const draft = opensAsDraft(all);
  if (!draft && !checks?.clean) throw new Stuck("checks-failing", "the attempt reached the PR step without clean checks");
  const r = await deps.openPr(run, impl, { draft, checks });
  if (r.ok) return `PR ${r.url}`;
  // The attempt left opening while the PR step ran (a cancel or a stuck blocker): that state stands.
  if (r.stale) return r.reason;
  if (r.recheck) {
    await step(db, impl, { to: "checking" });
    return `${r.reason}; the checks run again`;
  }
  if (r.problems?.length) {
    // One turn to undo what the diff check refused (D7); a second refusal is stuck.
    if (rounds.some(isDiffRefusal)) throw new Stuck("diff-refused", r.problems.slice(0, 3).join("; "));
    await step(db, impl, { to: "fixing", rounds: [{ kind: "refusal", result: { kind: "diff", reason: r.reason, problems: r.problems } }] });
    return `the diff check refused the change (${r.reason}); an undo turn is next`;
  }
  if (r.retry) {
    // Unguarded, as the attempt may have left opening: the refusal is on record either way.
    const refusal: NewRound = { kind: "refusal", result: { kind: "push", reason: r.reason } };
    const at = new Date().toISOString();
    const w = await writeStep(db, impl, { rounds: [refusal], at });
    const tail = [...all, roundOf(impl.id, w!.roundIds[0]!, refusal, at)].reverse();
    const streak = tail.findIndex((x) => !(x.kind === "refusal" && (x.result as { kind?: string })?.kind === "push"));
    if ((streak < 0 ? tail.length : streak) >= PUSH_FAILURES_MAX) throw new Stuck("push-failed", r.reason);
    return `the PR was not opened (${r.reason}); the next run tries again`;
  }
  if (/issue is closed/.test(r.reason)) {
    await step(db, impl, { to: "closed", patch: { reason: r.reason } });
    return r.reason;
  }
  // A refusal a later run cannot get past: the base commit gone, our PR closed, a head that is not our push.
  throw new Stuck("push-failed", r.reason, { retry: false });
}

/** One unit of the build bucket for the issue's current attempt: the job's summary line, and whether anything moved. */
export async function runBuild(run: BuildRun, repo: string, number: number, deps: BuildDeps = defaultBuildDeps()): Promise<{ summary: string; moved: boolean }> {
  const before = await currentAttempt(run.db, repo, number);
  const summary = await buildUnit(run, before, deps);
  const after = before ? (await attemptNow(run.db, before.impl))?.impl : null;
  const moved = !!before && (after?.state !== before.impl.state || after?.updatedAt !== before.impl.updatedAt);
  return { summary, moved };
}

async function buildUnit(run: BuildRun, cur: Attempt | null, deps: BuildDeps): Promise<string> {
  const db = run.db;
  if (!cur) return "no current implementation";
  let impl = cur.impl;
  try {
    if (impl.state === "stuck") {
      const o = await applyStuckAnswer(db, cur);
      return `${ref(impl)}: ${o ? o.did : "stuck; no answer to carry out"}`;
    }
    if (!BUILD_STATES.has(impl.state)) return `${ref(impl)}: ${impl.state}; nothing to build`;
    if (!impl.plan) throw new Stuck("plan-unparseable", "the attempt has no stored plan");
    // The PR step reads the change out of the workspace, so it waits for the workspace like a turn does.
    const ws = await readyWorkspace(run, impl);
    impl = ws.impl;
    if (impl.state === "opening") return `${ref(impl)}: ${await openingPhase(run, deps, impl)}`;
    const pod = deps.pod(db, ws.wsId, run.cancelled);
    if (impl.state !== "checking") {
      impl = await turnPhase(run, deps, impl, ws, pod);
      if (impl.state !== "checking") return `${ref(impl)}: ${impl.state}; the next job goes on`;
      if (Date.now() - run.startedMs > CHECKS_IN_SAME_JOB_MS || await run.stopping()) return `${ref(impl)}: the session reported ${impl.report?.status}; the checks run in the next job`;
    }
    const c = await checksPhase(run, impl, ws, pod);
    if (c.impl.state !== "opening") return `${ref(impl)}: ${c.line}`;
    return `${ref(impl)}: ${c.line}; ${await openingPhase(run, deps, c.impl)}`;
  } catch (e) {
    if (e instanceof Left) return `${ref(impl)}: ${e.message}`;
    if (!(e instanceof Stuck)) throw e;
    const now = (await attemptNow(db, impl))?.impl ?? impl;
    return `${ref(impl)}: ${stuckLine(e.cause_, await markStuck(db, now, e.cause_, e.message || null, { diffCheck: deps.diffCheck, retry: e.retry }))}`;
  }
}

/** The attempt left the build states meanwhile: nothing more is written. */
class Left extends Error {}

/**
 * Writes a step of the attempt while it is in a build state; one that left them meanwhile (a cancel) stops the unit, as a
 * re-read of the row did.
 */
async function step(db: Db, impl: Implementation, o: { to?: ImplementationState; patch?: ImplementationPatch; rounds?: NewRound[]; at?: string }): Promise<{ impl: Implementation; roundIds: number[] }> {
  const w = await writeStep(db, impl, { ...o, expect: [...BUILD_STATES] });
  if (!w) throw new Left(`it left ${impl.state} meanwhile; nothing more is written`);
  return w;
}

/** The attempt's rounds as stored now. */
async function roundsNow(db: Db, impl: Implementation): Promise<ImplementationRound[]> {
  const a = await attemptNow(db, impl);
  if (!a) throw new Left("a newer attempt started meanwhile");
  return a.rounds;
}
