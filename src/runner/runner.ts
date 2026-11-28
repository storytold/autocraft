// `autocraft-server runner serve`: the only process that runs pipeline steps. It
// polls the jobs table, runs each job in its own child process (`autocraft
// runner exec <id>`, its own process group, output to a per-job log file),
// stops jobs whose cancel was requested, runs the autopilot (queues jobs while the
// pipeline switch is on) and puts jobs that a stop or an earlier runner left
// unfinished back in the queue to resume (src/runner/resuming.ts).
import { recheckDelayMs } from "../core/backoff.ts";
import { advanceWorkflows, type FailedCheck } from "../workflow/advance.ts";
import { endGoneCloses } from "../act/gone.ts";
import { copyLogs, JobLogCopy, pruneJobLogs } from "./job-log.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, statSync, closeSync, mkdirSync, openSync, readFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbEnv, dbLockName, dbTarget } from "../db/open.ts";
import { advancePreapprovals, preapprovalInputs } from "../preapproval/index.ts";
import { applyProposals, AUTOPILOT_USER, isEnabled, KEY_ENABLED, loadPlanDue, planDue, type Detected } from "./autopilot.ts";
import { pruneRuns } from "../agents/runs.ts";
import { pruneJevUnsure } from "../agents/step.ts";
import { pruneTasks, reapLost } from "../build/tasks.ts";
import { loadStaleTasks } from "../data/build/index.ts";
import { freshConfig } from "../data/control/index.ts";
import { pruneBench } from "../nightly/index.ts";
import { prunePlanHistory } from "../core/plan-cache.ts";
import { drainCommands, pruneCommands } from "../github/commands.ts";
import { checkPendingUpdate } from "../build/worker-update.ts";
import { JOB_KEEP_MS, now, pruneJobs, scrub } from "./jobs.ts";
import { endJob, recoverJobs } from "./lifecycle.ts";
import { advanceSecurityFixes, autoFixConfirmed, loadSecurityFixWork } from "../security/actions.ts";
import { advanceScanTests, loadScanTestWork } from "../security/scantest.ts";
import { OffThread } from "./offthread.ts";
import { buildDiffFacts } from "../review/diff.ts";
import { laneOf, loadSteps, modelsOf, usesClaude, type Params, type StepDef } from "./steps.ts";
import { jobBlock, STEP_PARALLEL_KEY, wantOf } from "./concurrency.ts";
import { queueRoomPass } from "../agents/call.ts";
import { TRY_STEP } from "../build/workspace-session.ts";
import { pruneWorkspaceImages } from "../build/workspace-relay.ts";
import { noTakerFor } from "../remote/takers.ts";
import { JOB_DEADLINE_ENV, RUNNER_FAILING_MS, SESSION_VARIANT_STEPS, stepDeadlineMin, stepNoProgressMin, type StepVariant } from "./deadlines.ts";
import { fixSessionsOn } from "../fixsession/switch.ts";
import { envVar } from "../env.ts";
import { anyRepinDue } from "../repin/due.ts";
import { REMOTE_WAIT_CAP_MS } from "../remote/calls.ts";
import { CALLER_STALE_MS, jobRoom, roomState, type JobCalls, type RoomState } from "../remote/room.ts";
import { CAPACITY_EVERY_MS, capacityText, readJobCapacity, type JobCapacity } from "./capacity.ts";
import { claimJob, failQueued, loadLiveJobs, loadRunnerTick, markDeadlineStops, saveLaneState, setPids, type LogCursor, type QueuedJob, type RunningState } from "../data/jobs/index.ts";
import { loadSyncState, hasSyncRequests } from "../data/mirror/index.ts";
import { hasCommandWork, linkWorkflows } from "../data/workflow/index.ts";
import { exclusive } from "../async-seq.ts";
import { refreshReadIdentity } from "../github/read.ts";
import type { Db } from "../db/index.ts";

export const logsDir = (): string => envVar("RUNNER_LOGS") ?? join(homedir(), ".cache/autocraft-logs/jobs");

export function runnerLockPath(): string {
  const dir = envVar("LOCK_DIR") ?? join(homedir(), ".cache/autocraft-logs");
  return join(dir, `runner-${dbLockName()}.lock`);
}

/** The lane_state mark the runner writes on every tick. */
export const HEARTBEAT_MARK = "heartbeat";
/** The worst failure of the runner's parts as JSON TickFailure, written with the heartbeat; "" while none fails. */
export const TICK_FAILURE_MARK = "tick_failure";
/** How often queued webhook items are read again from GitHub. */
export const WEBHOOK_DRAIN_MS = 5_000;
/** How often the runner checks for a repo due for its daily reconcile. */
export const RECONCILE_CHECK_MS = 5 * 60_000;
/** How often the runner sweeps GitHub questions whose answer was lost. */
const ASKED_SWEEP_MS = 60_000;
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

/**
 * The most job processes at once (the ceiling of the capacity-based cap, src/runner/capacity.ts): the database connection budget
 * of src/db/postgres.ts. A job that calls Claude also waits for room in the model queue (see startJobs).
 */
export const DEFAULT_MAX_JOBS = 32;
/** The job capacity mark: the cap startJobs keeps and where it comes from (JSON JobCapacity). */
export const JOB_CAPACITY_MARK = "job_capacity";
/** A Claude job started this recently that has no call queued or leased yet is still preparing its call: it takes room the queue does not show yet. */
const PREPARING_MS = 90_000;

export type RunnerOptions = {
  db: Db;
  /** Database the children and worker threads open (a SQLite path or a postgres:// URL); default `dbTarget()`. */
  dbTarget?: string;
  logs?: string;
  /** Most job processes running at once: the ceiling of the capacity-based cap. */
  maxJobs?: number;
  /** Time a job gets to stop after SIGTERM before SIGKILL. */
  killAfterMs?: number;
  lockFile?: string;
  log?: (line: string) => void;
  /** The planner's detection pass (default: a worker thread on its own connection to `dbTarget`). Tests pass a fake. */
  detect?: (nowMs: number) => Promise<Detected>;
  /** Longest run of a job of a step in minutes, given the job's `limit` param (default: stepDeadlineMin). Tests pass a short one. */
  maxMin?: (step: string, items?: number, variant?: StepVariant) => number;
  /** Minutes a job may show no progress, by step (default: stepNoProgressMin). */
  noProgressMin?: (step: string, variant?: StepVariant) => number;
  /** How long past its deadline a job may finish its current item before the runner stops its process (default 10 minutes). */
  graceMs?: number;
};

type Running = { child: ChildProcess; termAt: number | null; exited: Promise<void>; startedAt: number; deadlineMin: number; logPath: string; logCopy: JobLogCopy; /** When the job was told to finish its current item and stop. */ flaggedAt: number | null; noProgressMin: number; /** Why it was told to stop. */ stopMsg: string | null; /** Time in which a user-local call of the job waited for a helper, summed over the checks that saw one waiting. */ remoteWaitMs: number; remoteSeen: { at: number; queued: boolean } | null };

/** The error of a job the runner stopped for running past its step's limit. */
export const deadlineError = (min: number): string => `stopped: ran past ${min} min`;
export const noProgressError = (min: number): string => `stopped: no progress for ${min} min`;

/** True when `pid` is alive and is the child of job `id`. */
function isJobProcess(pid: number, id: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").includes(`runner exec ${id}`);
  } catch {
    return false;
  }
}

/** An error as the health check shows it: one scrubbed line. */
const errorText = (e: unknown): string => scrub(((e as Error)?.message ?? String(e)).replace(/\s+/g, " ").trim()).slice(0, 200);

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/** The `number` param of a job (a security finding), or null. */
function numberOfParams(params: string): number | null {
  try { const n = (JSON.parse(params) as { number?: unknown }).number; return typeof n === "number" ? n : null; } catch { return null; }
}

/** The calls a job makes as the start test reads them: its repo and step, and the item a lane job works on (its `number`). */
export function jobCalls(step: string, repo: string | null, params: string): JobCalls {
  const number = repo && laneOf(params) ? numberOfParams(params) : null;
  return { step, ...(repo && { repos: [repo] }), ...(repo && number !== null && { refs: [{ repo, number }] }) };
}

type TickReads = Awaited<ReturnType<Runner["load"]>>;

/**
 * Since when a part of the runner's work has failed each time it ran, and its latest error: `fail` for a pass's reads, its
 * cancels or the pass itself, `warn` for any other part.
 */
export type TickFailure = { since: string; state: "warn" | "fail"; error: string };

/** The part that reads a pass's one wave; when it fails, the parts read one by one. */
const READS = "the pass's reads, now made one by one";

export class Runner {
  readonly db: Db;
  readonly running = new Map<number, Running>();
  /** Ended jobs whose end could not be recorded: every tick records them again, so their rows reach a final state. */
  private readonly unrecorded = new Map<number, { code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>();
  private stopping = false;
  private webhookAt = 0;
  private webhooking: Promise<void> | null = null;
  /** The autorepin drain (src/repin), apart from the webhook pass so its git work never delays re-reads and comment commands. */
  private repinning: Promise<void> | null = null;
  private webhookClient: import("../mirror.ts").Client | null = null;
  private reconcileAt = 0;
  private askedSweepAt = 0;
  private askedSweeping: Promise<void> | null = null;
  private reconciling: Promise<void> | null = null;
  private reconcileClient: import("../mirror.ts").Client | null = null;
  private planning: Promise<void> | null = null;
  private detected: Detected | null = null;
  /** The parts that failed when they last ran (not every part runs on every pass), and what is stored of them (undefined: what an earlier runner left). */
  private readonly failing = new Map<string, TickFailure>();
  private storedFailure: string | undefined;
  /** Jobs were queued at the last look: the next tick reads the model queue's room with the rest. */
  private jobsWaited = false;
  /** The job cap startJobs keeps (src/runner/capacity.ts), when it was read, and the text last stored in the mark. */
  private capacity: { at: number; c: JobCapacity } | null = null;
  private storedCapacity = "";
  /** What the last pre-approval pass read (preapprovalInputs) and the earliest time its answer changes with the clock alone. */
  private preapprovalMark: { sig: string; wakeAt: number } | null = null;
  /** The workflows whose check failed when it last ran, kept between the passes of advanceWorkflows. */
  private readonly failedWorkflows = new Map<number, FailedCheck>();
  /** Planner passes that failed in a row (their detection, or queueing what it found), and when the planner runs again for it. */
  private planRetry: { times: number; at: number } | null = null;
  private readonly planThread: OffThread;
  private readonly o: Required<Omit<RunnerOptions, "db" | "lockFile" | "detect" | "maxMin" | "graceMs" | "noProgressMin">> & { lockFile: string | null };
  private readonly detect: (nowMs: number) => Promise<Detected>;
  private readonly maxMin: (step: string, items?: number, variant?: StepVariant) => number;
  private readonly graceMs: number;
  private readonly noProgressMin: (step: string, variant?: StepVariant) => number;

  constructor(opts: RunnerOptions) {
    this.db = opts.db;
    this.o = {
      dbTarget: opts.dbTarget ?? dbTarget(), logs: opts.logs ?? logsDir(), maxJobs: opts.maxJobs ?? DEFAULT_MAX_JOBS, killAfterMs: opts.killAfterMs ?? 10_000,
      lockFile: opts.lockFile ?? null, log: opts.log ?? ((l) => console.log(l)),
    };
    mkdirSync(this.o.logs, { recursive: true });
    this.planThread = new OffThread(this.o.dbTarget);
    this.detect = opts.detect ?? ((t) => this.planThread.plan(t));
    this.maxMin = opts.maxMin ?? stepDeadlineMin;
    this.graceMs = opts.graceMs ?? 600_000;
    this.noProgressMin = opts.noProgressMin ?? stepNoProgressMin;
  }

  /**
   * Jobs left `running` belong to a runner that is gone: what is left of their processes is stopped and each job resumes
   * (resumeJob), or ends cancelled (a cancel was asked) or failed (it may not resume). The remote calls and agent runs of
   * resuming jobs stay; other calls of jobs, model-queue waits and work leases of the gone runner end.
   */
  async recover(): Promise<number> {
    return await recoverJobs(this.db, {
      skip: (id) => this.running.has(id),
      stop: (r) => {
        if (!r.pid || !isJobProcess(r.pid, r.id)) return;
        killGroup(r.pid, "SIGKILL");
        // A command-line run's process leads no group of its own.
        try { process.kill(r.pid, "SIGKILL"); } catch { /* gone with its group */ }
      },
      log: this.o.log,
    });
  }

  /**
   * One pass: heartbeat, cancels, autopilot, new jobs. Everything it decides on is read in one wave; a part that changed
   * something (a job's end recorded, proposals applied) makes the parts after it read again, and so does a wave that failed:
   * one broken read then stops its own part only. The heartbeat and the jobs' new log lines are written beside it: it ends
   * once they have landed. The heartbeat carries how the parts fail since the passes before it, for the health check.
   */
  async tick(): Promise<void> {
    const worst = this.worstFailure(), failure = worst ? JSON.stringify(worst) : "";
    // Writes are awaited at the end of the pass, so each handles its own failure: a promise that rejects before that would end the process.
    const beside = [saveLaneState(this.db, [{ kind: "mark", step: HEARTBEAT_MARK, value: now() }, ...(failure !== this.storedFailure ? [{ kind: "mark" as const, step: TICK_FAILURE_MARK, value: failure }] : [])])
      .then(() => { this.storedFailure = failure; }, (e) => this.o.log(`runner: heartbeat not stored: ${(e as Error)?.message ?? String(e)}`))];
    try {
      await this.pass(beside);
      this.passed("pass");
    } catch (e) {
      this.noteFailure("pass", e, "fail");
      throw e;
    } finally {
      await Promise.all(beside);
    }
  }

  /** The failure the health check shows: of those that have lasted, else of all, a `fail` before a `warn`, then the oldest. */
  private worstFailure(): TickFailure | null {
    const t = Date.now();
    const rank = (f: TickFailure): number => (t - Date.parse(f.since) >= RUNNER_FAILING_MS ? 2 : 0) + (f.state === "fail" ? 1 : 0);
    return [...this.failing.values()].sort((a, b) => rank(b) - rank(a) || Date.parse(a.since) - Date.parse(b.since))[0] ?? null;
  }

  private async pass(beside: Promise<void>[]): Promise<void> {
    if (this.o.lockFile) {
      try {
        utimesSync(this.o.lockFile, new Date(), new Date());
      } catch {
        // removed under us; the next start notices
      }
    }
    const read = await this.load();
    const { wave } = read;
    try {
      if (wave) {
        await this.checkRunning(wave.jobs.running);
        beside.push(this.copyRunningLogs());
      } else await this.cancels();
      this.passed("cancels");
    } catch (e) { this.fault("cancels", e, "fail"); }
    if (await this.recordEnds()) read.stale = true;
    if (this.stopping) return;
    try {
      const lost = await reapLost(this.db, read.at, wave?.staleTasks);
      if (lost) {
        read.stale = true;
        this.o.log(`${lost} build tasks lost their worker`);
      }
      this.passed("build tasks");
    } catch (e) { this.fault("build tasks", e); }
    try {
      const hooks = wave ? wave.webhooks : read.webhooksDue ? await this.webhookWork() : null;
      if (hooks) {
        this.passed("webhooks");
        this.webhookTick(...hooks);
      }
    } catch (e) { this.fault("webhooks", e); }
    this.reconcileTick();
    this.askedSweepTick();
    await this.pruneTick();
    this.workerUpdateTick();
    await this.autopilot(read);
    await this.startJobs(read);
  }

  /** The part ran and did not fail. */
  private passed(part: string): void {
    this.failing.delete(part);
  }

  private noteFailure(part: string, e: unknown, state: TickFailure["state"]): void {
    this.failing.set(part, { since: this.failing.get(part)?.since ?? now(), state, error: `${part}: ${errorText(e)}` });
  }

  /** Logs the failure of a part of the pass; the pass goes on, and the part counts as failing until it runs through (TickFailure). */
  private fault(part: string, e: unknown, state: TickFailure["state"] = "warn"): void {
    this.noteFailure(part, e, state);
    this.o.log(`${part}: ${(e as Error)?.message ?? String(e)}`);
  }

  /**
   * What a tick reads, in one wave. `stale`: a part of the tick wrote since, so what follows it reads again. `wave` is null
   * when the wave failed (on Postgres one broken read fails all of them): every part then reads its own, as after a write.
   */
  private async load() {
    const db = this.db, at = Date.now();
    const webhooksDue = !this.webhooking && at - this.webhookAt >= WEBHOOK_DRAIN_MS;
    if (webhooksDue) this.webhookAt = at;
    try {
      const [start, staleTasks, fixes, scanTests, seqs, plan, webhooks] = await db.together(() => Promise.all([
        this.loadStart(at), loadStaleTasks(db, at), loadSecurityFixWork(db), loadScanTestWork(db), db.seqs(), this.planning ? null : loadPlanDue(db, at),
        webhooksDue ? this.webhookWork() : null,
        refreshReadIdentity(db).catch((e: unknown) => this.o.log(`GitHub identity not refreshed: ${(e as Error).message}`)),
      ]));
      this.passed(READS);
      return { at, wave: { ...start, staleTasks, fixes, scanTests, seqs, plan, webhooks }, webhooksDue, stale: false };
    } catch (e) {
      this.fault(READS, e, "fail");
      return { at, wave: null, webhooksDue, stale: true };
    }
  }

  /** Commands in comments, autorepins whose pull request was merged or closed or whose lockfile task ended (src/repin), webhook re-reads. */
  private async webhookWork(): Promise<[boolean, boolean, boolean]> {
    return await Promise.all([hasCommandWork(this.db), anyRepinDue(this.db), hasSyncRequests(this.db)]);
  }

  /** What startJobs reads: the jobs, the switch and the cap, and (when jobs waited at the last tick, so some likely wait now) the model queue's room. */
  private async loadStart(at: number) {
    const db = this.db;
    const [jobs, live, cfg, room] = await db.together(() => Promise.all([
      loadRunnerTick(db, at, CALLER_STALE_MS), loadLiveJobs(db), freshConfig(db, [KEY_ENABLED, STEP_PARALLEL_KEY]), this.jobsWaited ? roomState(db, at) : undefined,
    ]));
    return { jobs, live, on: cfg.pipelineEnabled, draining: cfg.pipelineDraining, cap: cfg.stepParallel, room };
  }

  /** Reads the items GitHub App webhooks named again from GitHub, off the tick, while no sync run holds its lock. The poll covers any that fail. */
  private webhookTick(commands: boolean, repinDue: boolean, requests: boolean): void {
    const repins = !this.repinning && repinDue;
    if (!commands && !repins && !requests) return;
    this.webhooking = (async () => {
      const { lockHeld, lockPath, fullLockPath, Client, SYNC_RESERVE } = await import("../mirror.ts");
      if (lockHeld(lockPath()) || lockHeld(fullLockPath())) return;
      const c = this.webhookClient = await this.seedRate(this.webhookClient ?? new Client(SYNC_RESERVE));
      const { drainSyncRequests } = await import("../github/webhooks.ts");
      const n = await drainSyncRequests(this.db, c, { limit: 10, log: this.o.log });
      if (n) this.o.log(`webhooks: read ${n} items again`);
      // Commands in comments (`@<app> merge queue`) after the re-reads, so the item is read at its current head.
      if (commands) {
        const k = await drainCommands(this.db, { querier: c, log: this.o.log });
        if (k) this.o.log(`webhooks: carried out ${k} commands from comments`);
      }
      // Started after the commands, so an autorepin set on a pull request that is already merged starts in this pass, and not
      // waited for: the next pass's re-reads and commands do not wait on its git work.
      if ((repins || commands) && !this.repinning) {
        this.repinning = (async () => {
          const { drainRepins } = await import("../repin/index.ts");
          const k = await drainRepins(this.db, { querier: c, log: this.o.log });
          if (k) this.o.log(`autorepin: ${k} ended`);
        })().catch((e) => this.o.log(`autorepin: ${(e as Error).message}`)).finally(() => (this.repinning = null));
      }
    })().catch((e) => this.o.log(`webhooks: ${(e as Error).message}`)).finally(() => (this.webhooking = null));
  }

  /**
   * Seeds a client the runner keeps for its life with the last sync's rate reading, so the reserve holds from its first read.
   * Below the reserve nothing is read until the limit resets; the sync's reading is newer than ours when it is the later one.
   */
  private async seedRate(c: import("../mirror.ts").Client): Promise<import("../mirror.ts").Client> {
    const state = await loadSyncState(this.db);
    const seen = state.rate_remaining ?? NaN;
    const reset = Date.parse(state.rate_reset_at ?? "");
    if (Number.isFinite(seen) && Number.isFinite(reset) && reset > Date.now()) {
      c.remaining = c.remaining === null ? seen : Math.min(c.remaining, seen);
      c.resetAt = new Date(reset);
    } else if (c.resetAt && c.resetAt.getTime() <= Date.now()) {
      c.remaining = null;
      c.resetAt = null;
    }
    return c;
  }

  /**
   * GitHub questions whose turn ended LOST_ANSWER_MS ago without their answer settled get the pointer (src/conversations/ask.ts),
   * off the tick, at most once a minute. An `asked` command is no command work, so this does not wait for the comment drain; the rows
   * it settles are, and the drain posts them.
   */
  private askedSweepTick(): void {
    if (this.askedSweeping || Date.now() - this.askedSweepAt < ASKED_SWEEP_MS) return;
    this.askedSweepAt = Date.now();
    this.askedSweeping = (async () => {
      const { sweepAskedCommands } = await import("../conversations/ask.ts");
      const k = await sweepAskedCommands(this.db);
      if (k) this.o.log(`github commands: ${k} questions whose answer was lost get the pointer to the item's chat`);
    })().catch((e) => this.o.log(`github commands: asked sweep: ${(e as Error).message}`)).finally(() => (this.askedSweeping = null));
  }

  /**
   * The daily reconcile of one tracked repo (mirror.ts reconcileNext), off the tick, one at a time. Its reads give way to
   * the minute sync and a full re-sync: before each one it waits while either holds its lock, and it keeps the sync's reserve.
   * Sync is not pipeline work, so this runs with the pipeline off too.
   */
  private reconcileTick(): void {
    if (this.reconciling || Date.now() - this.reconcileAt < RECONCILE_CHECK_MS) return;
    this.reconcileAt = Date.now();
    this.reconciling = (async () => {
      const { lockHeld, lockPath, fullLockPath, lowPriority, reconcileNext, Client, SYNC_RESERVE } = await import("../mirror.ts");
      const c = this.reconcileClient = await this.seedRate(this.reconcileClient ?? new Client(SYNC_RESERVE));
      const busy = (): boolean => lockHeld(lockPath()) || lockHeld(fullLockPath());
      await reconcileNext(this.db, lowPriority(c, { busy, minRemaining: SYNC_RESERVE }), new Date(), this.o.log);
    })().catch((e) => this.o.log(`reconcile: ${(e as Error).message}`)).finally(() => (this.reconciling = null));
  }

  /**
   * The planner. Detection reads a lot and runs off the loop, at most one pass at a time; the
   * tick queues what it found, so a slow detection never delays the heartbeat or cancels.
   */
  private async autopilot(read: TickReads): Promise<void> {
    const found = this.detected;
    this.detected = null;
    if (found) {
      read.stale = true;
      for (const l of found.logs) this.o.log(l);
      try {
        // Detection read the database a moment ago; the switch may have been turned off since.
        if (await isEnabled(this.db)) {
          await applyProposals(this.db, found.proposals, { log: this.o.log, wakeAt: found.wakeAt ?? null, ...(found.status ? { status: found.status } : {}) });
          // A private fix that a switch-off cancelled is queued again once the pipeline is on.
          const fixes = await autoFixConfirmed(this.db);
          if (fixes) this.o.log(`autopilot: started the private fix of ${fixes} confirmed security findings`);
        }
        this.planRetry = null;
        this.passed("autopilot");
      } catch (e) { this.planFault("autopilot", e); }
    }
    // What a part reads while nothing wrote since the wave.
    const wave = (): TickReads["wave"] => (read.stale ? null : read.wave);
    // A private fix waits for its build without a job; the next job starts when the build tasks end, for operator-started fixes with the pipeline off too.
    try {
      const w = wave();
      const next = await (w ? advanceSecurityFixes(this.db, w.on, w.fixes) : advanceSecurityFixes(this.db, await isEnabled(this.db)));
      if (next) read.stale = true;
      if (next) this.o.log(`security: continued the private fix of ${next} findings after their builds`);
      this.passed("security fixes");
    } catch (e) { this.fault("security fixes", e); }
    // The build task of a scan test is read here (database only); a finding whose test ended can then start its automatic fix.
    try {
      for (const t of await advanceScanTests(this.db, wave()?.scanTests)) {
        read.stale = true;
        this.o.log(`security: scan test of ${t.repo} finding ${t.number}: ${t.state}`);
        if (await isEnabled(this.db) && t.state !== "not-shown") await autoFixConfirmed(this.db, t.repo, t.number);
      }
      this.passed("security scan tests");
    } catch (e) { this.fault("security scan tests", e); }
    // Pre-approved merges move on rows other steps wrote; they are read here, not on a timer of their own.
    try { await this.preapprovals(read); } catch (e) { this.fault("preapprovals", e); }
    if (this.planning) return;
    try {
      const due = await planDue(this.db, read.at, wave()?.plan ?? undefined);
      this.passed("planner reads");
      if (!due && (!this.planRetry || read.at < this.planRetry.at)) return;
    } catch (e) {
      this.fault("planner reads", e);
      return;
    }
    this.planning = this.detect(Date.now())
      .then((d) => { this.detected = d; this.passed("planner"); }, (e) => this.planFault("planner", e))
      .finally(() => (this.planning = null));
  }

  /** A failed planner pass runs again by itself: planDue moved its marks before it ran. */
  private planFault(part: "planner" | "autopilot", e: unknown): void {
    this.fault(part, e);
    const times = (this.planRetry?.times ?? 0) + 1;
    this.planRetry = { times, at: Date.now() + recheckDelayMs(times) };
  }

  /**
   * The pre-approval pass, when what it reads changed since the last one (read before it runs, so its own moves make the next tick run it
   * again) or a time it was told about has come, also one told after the pass ended (a permission read's answer). A pass that failed in any
   * part runs again on the next tick; a workflow whose check keeps failing is checked again after a backoff.
   */
  private async preapprovals(read: TickReads): Promise<void> {
    const t = Date.now();
    const sig = preapprovalInputs(read.stale || !read.wave ? await this.db.seqs() : read.wave.seqs);
    const m = this.preapprovalMark;
    if (m && m.sig === sig && t < m.wakeAt) return this.passed("preapprovals");
    this.preapprovalMark = null;
    read.stale = true;
    const next = { sig, wakeAt: Infinity };
    const wake = (at: number): void => { if (at < next.wakeAt) next.wakeAt = at; };
    try {
      await linkWorkflows(this.db);
      this.passed("links");
    } catch (e) {
      this.fault("links", e);
      wake(t);
    }
    // The maintainer workflow's blockers and recommendations come first: a blocker stops its merge leg before the leg moves on,
    // so legs wait while their blockers could not be checked.
    let checked = false;
    try {
      await advanceWorkflows(this.db, this.o.log, wake, this.failedWorkflows);
      checked = true;
      // A workflow whose own check fails is shown on its item and as its own health check (advance.ts FAILING_SHOWN), not as the runner's.
      this.passed("workflows");
    } catch (e) {
      this.fault("workflows", e);
      wake(t);
    }
    try {
      await endGoneCloses(this.db);
      this.passed("closes");
    } catch (e) {
      this.fault("closes", e);
      wake(t);
    }
    if (checked) {
      await advancePreapprovals(this.db, this.o.log, {}, wake, this.failedWorkflows);
      this.passed("preapprovals");
    }
    this.preapprovalMark = next;
  }

  private updateAt = 0;
  private updating = false;

  /** About once a minute, runs the sandbox worker update that a deploy left pending once its tasks have finished. */
  private workerUpdateTick(): void {
    if (this.updating || Date.now() - this.updateAt < 60_000) return;
    this.updateAt = Date.now();
    this.updating = true;
    checkPendingUpdate(this.db, undefined, this.o.log)
      .catch((e) => this.o.log(`worker update: ${(e as Error).message}`))
      .finally(() => (this.updating = false));
  }

  private pruneAt = 0;

  /** Prunes old jobs, logs and agent data hourly. */
  private async pruneTick(): Promise<void> {
    const t = Date.now();
    if (t - this.pruneAt >= 3600_000) {
      this.pruneAt = t;
      try {
        await pruneJobs(this.db, t);
      } catch (e) {
        this.o.log(`prune jobs: ${(e as Error).message}`);
      }
      try {
        await pruneJobLogs(this.db, t);
      } catch (e) {
        this.o.log(`prune job logs: ${(e as Error).message}`);
      }
      try {
        await prunePlanHistory(this.db, JOB_KEEP_MS, t);
      } catch (e) {
        this.o.log(`prune plan history: ${(e as Error).message}`);
      }
      try {
        await pruneTasks(this.db, t);
      } catch (e) {
        this.o.log(`prune build tasks: ${(e as Error).message}`);
      }
      try {
        await pruneWorkspaceImages(this.db, t);
      } catch (e) {
        this.o.log(`prune workspace images: ${(e as Error).message}`);
      }
      try {
        await pruneBench(this.db, t);
      } catch (e) {
        this.o.log(`prune nightly bench: ${(e as Error).message}`);
      }
      try {
        await pruneRuns(this.db, t);
      } catch (e) {
        this.o.log(`prune agent runs: ${(e as Error).message}`);
      }
      try {
        await pruneJevUnsure(this.db, t);
      } catch (e) {
        this.o.log(`prune kept Jev answers: ${(e as Error).message}`);
      }
      try {
        await pruneCommands(this.db, t);
      } catch (e) {
        this.o.log(`prune github commands: ${(e as Error).message}`);
      }
    }
  }

  /** The cancels and deadlines alone, while the runner stops. */
  private async cancels(): Promise<void> {
    if (this.running.size) await this.checkRunning((await loadRunnerTick(this.db, Date.now(), CALLER_STALE_MS)).running);
    await this.copyRunningLogs();
  }

  /** The new log lines of every running job, in one write (each job at most every JOB_LOG_FLUSH_MS). */
  private async copyRunningLogs(): Promise<void> {
    await copyLogs(this.db, [...this.running.values()].map((r) => r.logCopy)).catch((e: Error) => this.o.log(`job logs not stored: ${e.message}`));
  }

  private async checkRunning(states: RunningState[]): Promise<void> {
    const byId = new Map(states.map((r) => [r.id, r]));
    for (const [id, r] of this.running) {
      const row = byId.get(id);
      // Time a user-local model call waits for a helper counts like waiting for an account slot: not toward the deadline, and not as a time without progress.
      const nowMs = Date.now();
      const remote = { queued: row?.queued ?? false, lastLeaseAt: row?.lastLeaseAt ?? null };
      if (r.remoteSeen?.queued) r.remoteWaitMs += nowMs - r.remoteSeen.at;
      r.remoteSeen = { at: nowMs, queued: remote.queued };
      // Up to REMOTE_WAIT_CAP_MS of it; past that a call nobody takes no longer holds the job and its item.
      const waiting = remote.queued && r.remoteWaitMs < REMOTE_WAIT_CAP_MS;
      const late = nowMs - r.startedAt - Math.min(r.remoteWaitMs, REMOTE_WAIT_CAP_MS) >= r.deadlineMin * 60_000;
      const cancel = !!row?.cancel_requested_at || this.stopping;
      // Progress is a new line in the job's log (the job's own output: progress lines, check-tool notes, results); reading its mtime costs one stat.
      let lastLine = Math.max(r.startedAt, waiting ? nowMs : remote.lastLeaseAt ?? 0);
      try { lastLine = Math.max(lastLine, statSync(r.logPath).mtimeMs); } catch { /* no log yet */ }
      const idle = r.flaggedAt === null && Date.now() - lastLine >= r.noProgressMin * 60_000;
      // Past its deadline a job is first asked to stop: the failure is recorded, which the job reads at its item boundaries (ctx.cancelled)
      // and finishes the writes of its current item. Only after the grace does the process get the signals a cancel gets.
      if ((late || idle) && !cancel && r.flaggedAt === null && r.termAt === null) {
        r.flaggedAt = Date.now();
        const msg = r.stopMsg = idle && !late ? noProgressError(r.noProgressMin) : deadlineError(r.deadlineMin);
        await markDeadlineStops(this.db, [{ id, error: msg }]);
        try { appendFileSync(r.logPath, `${now()} ${msg}; the job may finish its current item, and is stopped ${Math.round(this.graceMs / 60_000)} min from now\n`); } catch { /* the log is gone */ }
        this.o.log(`job ${id}: ${msg}; finishing its current item`);
      }
      const graceOver = r.flaggedAt !== null && Date.now() - r.flaggedAt >= this.graceMs;
      if (!cancel && !graceOver) continue;
      const pid = r.child.pid;
      if (!pid) continue;
      if (r.termAt === null) {
        r.termAt = Date.now();
        const deadline = !cancel;
        if (deadline) {
          try { appendFileSync(r.logPath, `${now()} ${r.stopMsg ?? deadlineError(r.deadlineMin)}; the job did not finish in time and is stopped\n`); } catch { /* the log is gone */ }
        }
        // The job process alone: it lets its GitHub writes in flight finish, then stops its process group (src/runner/exec.ts).
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        this.o.log(`job ${id}: stopping (${this.stopping ? "runner stopping" : deadline ? `${r.stopMsg} grace over` : "cancel requested"})`);
      } else if (Date.now() - r.termAt >= this.o.killAfterMs) {
        killGroup(pid, "SIGKILL");
      }
    }
  }

  /**
   * Starts queued jobs: security first (priority 2), then by id. A job whose step calls Claude starts only while a Task Runner
   * user who would take its calls (its repo, its step's task and, for a lane job, its item; the people whose started work it is
   * first) has a slot left after the queued calls that user would take (src/remote/room.ts jobRoom), so processes do not sit
   * waiting for slots, unless no job of its step runs. Calls no free runner takes hold nobody's room. A job without a repo param
   * spans repos and is asked about none. Such a job with a repo starts only while a Task Runner may take its calls (the taker
   * rule, src/remote/takers.ts); a job no Task Runner may take waits queued. The room is read once per pass; each start, and each
   * Claude job still preparing its call, holds a slot of one user who would take it.
   */
  private async startJobs(read: TickReads): Promise<void> {
    const steps = await loadSteps();
    const { jobs: tick, live, on, draining, cap, room: state } = read.stale || !read.wave ? await this.loadStart(Date.now()) : read.wave;
    const queued = tick.queued.sort((a, b) => (steps.get(b.step)?.priority ?? 0) - (steps.get(a.step)?.priority ?? 0) || a.id - b.id);
    this.jobsWaited = queued.length > 0;
    if (!queued.length) return;
    const running = live.filter((j) => j.state === "running");
    // Automatic jobs wait while the pipeline is off; they are cancelled when it is switched off. While it drains, nothing new starts.
    const st = state ?? await roomState(this.db);
    const pass = await queueRoomPass(this.db, undefined, st);
    const rooms = jobRoom(st);
    const maxJobs = await this.jobCap(st);
    // Claude jobs still preparing their call hold a slot the queue does not show yet, of a Task Runner that would take it, as this pass's starts do.
    const nowMs = Date.now();
    const calling = new Map(tick.running.map((r) => [r.id, r.queued || r.lastLeaseAt !== null]));
    for (const j of running) {
      const r = this.running.get(j.id), step = steps.get(j.step);
      if (!r || calling.get(j.id) !== false || nowMs - r.startedAt > PREPARING_MS || !step) continue;
      let claude = false;
      try { claude = usesClaude(modelsOf(step, JSON.parse(j.params) as Params)); } catch { /* not a Claude job */ }
      if (claude) rooms.take(step.priority ?? 0, jobCalls(j.step, j.repo, j.params));
    }
    const pids: Promise<unknown>[] = [];
    const failed: { id: number; error: string }[] = [];
    try {
      for (const q of queued) {
        if (draining || (q.requested_by === AUTOPILOT_USER && !on)) continue;
        if (this.running.size >= maxJobs) return;
        const step = steps.get(q.step);
        if (!step) {
          failed.push({ id: q.id, error: "This step does not exist in this build." });
          continue;
        }
        // The claim checks the same rules in one statement; this test spares the model-queue questions for a job that cannot start.
        if (await jobBlock(this.db, steps, { ...wantOf(q.step, q.params), repo: q.repo }, { states: ["running"], mutex: true, active: running, cap })) continue;
        let claude = false;
        try { claude = usesClaude(modelsOf(step, JSON.parse(q.params) as Params)); } catch { /* params are checked when the job runs */ }
        const cls = step.priority ?? 0, calls = jobCalls(q.step, q.repo, q.params);
        if (claude && q.repo && !await pass.taker(calls.repos, q.step, calls.refs)) {
          // A pipeline job waits for a Task Runner; a command-line session job (`workspace try`) is not replanned, so it fails.
          const why = q.step === TRY_STEP ? await noTakerFor(this.db, q.repo, q.step) : null;
          if (why) failed.push({ id: q.id, error: why });
          continue;
        }
        // Nothing of the step runs: it starts anyway, and takes a slot of the room.
        if (claude && running.some((j) => j.step === step.name) && rooms.room(cls, calls) <= 0) continue;
        const spawned = await this.start(q, step, steps, cap, tick.logCursors.get(q.id));
        if (spawned) {
          // Written at once, beside the next starts: a runner that takes over stops what the process left running by its pid (recover).
          if (spawned.pid !== null) pids.push(setPids(this.db, [{ id: q.id, pid: spawned.pid }]).catch((e: unknown) => this.fault(`job ${q.id}: pid not stored`, e)));
          running.push({ id: q.id, step: step.name, state: "running", repo: q.repo, number: numberOfParams(q.params), params: q.params, items: null, requested_by: q.requested_by, resumes: q.resumes, cancel_requested_at: null, started_at: null, pid: spawned.pid });
          if (claude) rooms.take(cls, calls);
        }
      }
    } finally {
      await Promise.all(pids);
      await failQueued(this.db, failed);
    }
  }

  /**
   * The most job processes now: the capacity of the Task Runners and build environments (src/runner/capacity.ts), read at most every
   * CAPACITY_EVERY_MS, within the ceiling `maxJobs`. A change is stored as the job capacity mark (the runner health check shows it) and logged.
   */
  private async jobCap(st: RoomState): Promise<number> {
    const nowMs = Date.now();
    if (this.capacity && nowMs - this.capacity.at < CAPACITY_EVERY_MS) return this.capacity.c.max;
    try {
      const c = await readJobCapacity(this.db, st, this.o.maxJobs, nowMs);
      this.capacity = { at: nowMs, c };
      this.passed("job capacity");
      const value = JSON.stringify(c);
      if (value !== this.storedCapacity) {
        await saveLaneState(this.db, [{ kind: "mark", step: JOB_CAPACITY_MARK, value }]);
        if (this.storedCapacity === "" || this.capacity.c.max !== (JSON.parse(this.storedCapacity) as JobCapacity).max) this.o.log(`runner: ${capacityText(c)}`);
        this.storedCapacity = value;
      }
    } catch (e) {
      this.fault("job capacity", e);
      // Without a reading, the last one, or the ceiling before any.
      this.capacity = { at: nowMs, c: this.capacity?.c ?? { max: this.o.maxJobs, inference: 0, pods: 0, other: 0, floor: 0, ceiling: this.o.maxJobs } };
    }
    return this.capacity.c.max;
  }

  /**
   * The job's variant: fix-session when its step works in fix sessions on its repo now (the job reads the same setting when it
   * starts). A setting that cannot be read leaves the step's own bound.
   */
  private async variantOf(q: QueuedJob): Promise<StepVariant | undefined> {
    const step = SESSION_VARIANT_STEPS[q.step];
    if (!step) return undefined;
    try {
      const repo = (JSON.parse(q.params) as { repo?: unknown }).repo;
      return typeof repo === "string" && await fixSessionsOn(this.db, step, repo) ? "fix-session" : undefined;
    } catch (e) {
      this.o.log(`runner: job ${q.id}: the fix_sessions setting was not read (${(e as Error).message}); the step's own deadline applies`);
      return undefined;
    }
  }

  /** The job's claim, then its process; null when another job holds the step or the claim failed. */
  private async start(q: QueuedJob, step: StepDef, steps: Map<string, StepDef>, cap: number, cursor: LogCursor | undefined): Promise<{ pid: number | null } | null> {
    const id = q.id, stepName = step.name;
    const logPath = join(this.o.logs, `job-${id}.log`);
    const logCopy = JobLogCopy.open(id, logPath, cursor);
    const variant = await this.variantOf(q);
    const deadlineMin = this.maxMin(stepName, q.limit ?? undefined, variant);
    const mutexSteps = step.exclusive ? [...steps.values()].filter((x) => x.exclusive === step.exclusive).map((x) => x.name) : [];
    // One guarded statement: a command-line run cannot take the step in between.
    const claimed = await claimJob(this.db, { id, step: stepName, repo: q.repo, number: numberOfParams(q.params), lane: laneOf(q.params), cap: cap === Infinity ? null : cap, mutexSteps, logPath });
    if (!claimed) return null;
    const fd = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [CLI, "runner", "exec", String(id)], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...dbEnv(this.o.dbTarget), [JOB_DEADLINE_ENV]: String(deadlineMin) },
      });
    } finally {
      closeSync(fd);
    }
    // Registered before any await, so abandon() reaches every child that runs.
    let spawnError: string | null = null;
    child.on("error", (e) => (spawnError = e.message));
    const exited = new Promise<void>((resolve) => {
      child.on("close", (code, signal) => {
        void this.finish(id, code, signal, spawnError)
          .catch((e) => {
            this.unrecorded.set(id, { code, signal, spawnError });
            this.o.log(`job ${id}: end not recorded: ${(e as Error).message}`);
          })
          // After the end is recorded (or not): resumeJob and the deadline notes append to the file first.
          .then(() => copyLogs(this.db, [logCopy], true).catch((e: Error) => this.o.log(`job ${id}: log not stored: ${e.message}`)))
          .finally(() => {
            this.running.delete(id);
            resolve();
          });
      });
    });
    this.running.set(id, { child, termAt: null, exited, startedAt: Date.now(), deadlineMin, logPath, logCopy, flaggedAt: null, noProgressMin: this.noProgressMin(stepName, variant), stopMsg: null, remoteWaitMs: 0, remoteSeen: null });
    this.o.log(`job ${id}: started (pid ${child.pid})`);
    return { pid: child.pid ?? null };
  }

  private async finish(id: number, code: number | null, signal: NodeJS.Signals | null, spawnError: string | null): Promise<void> {
    const r = await endJob(this.db, id, code, signal, spawnError, this.stopping);
    if (r) this.o.log(`job ${id}: ${r.state === "queued" ? "queued to resume after the restart" : r.state}${r.state === "failed" && r.error ? `: ${r.error}` : ""}`);
  }

  /** True when it recorded one. */
  private async recordEnds(): Promise<boolean> {
    let some = false;
    for (const [id, e] of [...this.unrecorded]) {
      try {
        await this.finish(id, e.code, e.signal, e.spawnError);
        this.unrecorded.delete(id);
        some = true;
      } catch (err) {
        this.o.log(`job ${id}: end still not recorded: ${(err as Error).message}`);
      }
    }
    return some;
  }

  /**
   * Fencing, after the leader lease was lost (src/db/leader.ts): starts nothing more and kills every job's process group at
   * once, writing nothing. The new leader's recover() resumes or fails the jobs, as after a crash.
   */
  abandon(): void {
    this.stopping = true;
    for (const r of this.running.values()) if (r.child.pid) killGroup(r.child.pid, "SIGKILL");
  }

  /** Resolves when every running job has ended. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((r) => r.exited));
  }

  /** Stops every running job (SIGTERM, then SIGKILL after the grace time) and waits for them; each unfinished job is queued to resume (endJob). */
  async stop(): Promise<void> {
    this.stopping = true;
    const cancels = exclusive(() => this.cancels());
    const timer = setInterval(() => void cancels.skip().catch((e) => this.o.log(`cancels: ${(e as Error).message}`)), 500);
    await cancels.run();
    await this.idle();
    clearInterval(timer);
    await this.recordEnds();
    await this.planThread.close();
  }

  /** Polls until `signal` aborts, then stops running jobs. */
  async serve(signal: AbortSignal, pollMs = 2000): Promise<void> {
    await this.recover();
    try {
      const read = await buildDiffFacts(this.db);
      if (read) this.o.log(`diff facts: computed again for new rules: ${read.computed} heads from the diff cache, ${read.pending} wait for a re-read`);
    } catch (e) {
      this.o.log(`diff facts: ${(e as Error).message}`);
    }
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (e) {
        this.o.log(`runner: ${(e as Error).stack ?? e}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
    await this.stop();
  }
}
