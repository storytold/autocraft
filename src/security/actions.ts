// The security deep scan's operator actions, shared by the dashboard API and the CLI. Callers check who may act; these
// functions check the state of the scan or finding and throw a SecurityError that carries an HTTP-style status.
import type { FindingAction, FindingState, FindingView, ScanState, ScanView } from "../../web/src/api/types.ts";
import { addAudit, config, withConfig } from "../data/control/index.ts";
import { cancelTasks, loadConfidentialReadyAt, loadTasks, TERMINAL } from "../data/build/index.ts";
import { enqueueJobs, loadLiveJobs } from "../data/jobs/index.ts";
import * as sec from "../data/security/index.ts";
import { checkRequest, JobError, requestCancel } from "../runner/jobs.ts";
import { securityRepo, SECURITY_STEP, REASON_MAX, MIN_VERIFY_SCORE } from "./rules.ts";
import { activeScan, ACTIVE_STATES, advance, clearRounds, finishScan, findingKey, findingRow, moveFinding, reconcile, scanRow, toFinding, toScan, type FindingRow } from "./store.ts";
import type { Db } from "../db/index.ts";
import type { FixSessionsSetting } from "../data/control/index.ts";
import { fixSessionsSetting } from "../fixsession/switch.ts";
import { fixSessionEnv } from "../fixsession/workspace.ts";

export class SecurityError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const NOT_FOUND = "not found";
/** The most a spend cap may be, in dollars. */
const CAP_MAX = 100_000;
/** Extra audit details, for example where the action came from. */
export type AuditExtra = Record<string, unknown>;
const auditAs = (db: Db, login: string, action: string, target: string, details: Record<string, unknown>): Promise<void> => addAudit(db, [{ login, action, target, details }]);

/**
 * Queues a step job recorded under the scan's pseudo repo, so every job listing that leaves out hidden repos leaves it out for
 * viewers. Throws JobError when the request is invalid or the same step with the same settings is already queued.
 */
async function enqueueSecurity(db: Db, stepName: string, params: Record<string, unknown>, by: string): Promise<number> {
  const checked = await checkRequest(db, stepName, params);
  const { queued } = await enqueueJobs(db, [{ step: checked.step.name, params: checked.params, repo: securityRepo(params.repo as string), by }]);
  const id = queued.get(0);
  if (id === undefined) throw new JobError(409, `${checked.step.name} with these settings is already queued`);
  return id;
}

/** The actions that start a step: the states they start from, the state the finding takes at once, and the step. */
const STEPS: Partial<Record<FindingAction, { from: FindingState[]; to: FindingState | null; step: string; busy: string }>> = {
  fix: { from: ["new", "backlog"], to: "fixing", step: "security-fix", busy: "a fix" },
  land: { from: ["ready", "awaiting-admin"], to: "landing", step: "security-land", busy: "a fix that is ready or waiting for an admin" },
  advisory: { from: ["ready", "awaiting-admin"], to: "landing", step: "security-advisory", busy: "a fix that is ready or waiting for an admin" },
  publish: { from: ["landed", "advisory"], to: null, step: "security-publish", busy: "a landed fix" },
};

export async function startScanAs(db: Db, repo: string, login: string, capUsd: unknown, extra: AuditExtra = {}): Promise<ScanView> {
  const cap = capUsd === undefined || capUsd === null ? null : capUsd;
  if (cap !== null && (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > CAP_MAX)) throw new SecurityError(400, `capUsd must be a dollar amount above 0 and up to ${CAP_MAX}, or null for no cap`);
  await reconcile(db, repo);
  if (await activeScan(db, repo)) throw new SecurityError(409, `${repo} already has a scan running`);
  // The scan and its job are written together: a refused job leaves no scan behind.
  const id = await db.write(async () => {
    const id = await sec.addScan(db, { repo, cap_usd: cap, started_by: login });
    try {
      await sec.linkScanJob(db, id, await enqueueSecurity(db, SECURITY_STEP, { repo, scan: id }, login));
    } catch (e) {
      if (e instanceof JobError) throw new SecurityError(e.status, e.message);
      throw e;
    }
    await auditAs(db, login, "security-scan-start", `${repo}:scan:${id}`, { repo, capUsd: cap, ...extra });
    return id;
  });
  return await toScan(db, (await scanRow(db, id))!);
}

/**
 * Continues a scan that stopped at its spend cap with a new cap (null = none) that is above what it has spent. It takes the
 * repo's one active-scan slot, keeps its pinned commit, threat model, areas and findings, and queues its job again. A
 * stopped scan is not continued: an operator ended it, and it may have no threat model.
 */
export async function continueScanAs(db: Db, id: number, login: string, capUsd: unknown, extra: AuditExtra = {}): Promise<ScanView> {
  const scan = await scanRow(db, id);
  if (!scan) throw new SecurityError(404, NOT_FOUND);
  if (scan.state !== "capped") throw new SecurityError(409, `only a scan that stopped at its cap can be continued (this one is ${scan.state})`);
  const cap = capUsd === undefined || capUsd === null ? null : capUsd;
  if (cap !== null && (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > CAP_MAX)) throw new SecurityError(400, `capUsd must be a dollar amount above 0 and up to ${CAP_MAX}, or null for no cap`);
  if (cap !== null && cap <= scan.cost_usd) throw new SecurityError(400, `the new cap must be above the $${scan.cost_usd.toFixed(2)} the scan has spent`);
  await reconcile(db, scan.repo);
  if (await activeScan(db, scan.repo)) throw new SecurityError(409, `${scan.repo} already has a scan running`);
  // The resume and the new job are written together: a refused job leaves the scan capped as it was.
  await db.write(async () => {
    if (!await sec.resumeScan(db, { id, cap_usd: cap })) throw new SecurityError(409, "the scan changed; reload and try again");
    try {
      await sec.linkScanJob(db, id, await enqueueSecurity(db, SECURITY_STEP, { repo: scan.repo, scan: id }, login));
    } catch (e) {
      if (e instanceof JobError) throw new SecurityError(e.status, e.message);
      throw e;
    }
    await auditAs(db, login, "security-scan-continue", `${scan.repo}:scan:${id}`, { repo: scan.repo, capUsd: cap, spentUsd: scan.cost_usd, ...extra });
  });
  return await toScan(db, (await scanRow(db, id))!);
}

export async function stopScanAs(db: Db, id: number, login: string, extra: AuditExtra = {}): Promise<ScanView> {
  const scan = await scanRow(db, id);
  if (!scan) throw new SecurityError(404, NOT_FOUND);
  if (!ACTIVE_STATES.includes(scan.state as ScanState)) throw new SecurityError(409, `the scan already ended (${scan.state})`);
  // A running job sees the state or the cancel flag before its next call and ends the scan itself.
  if (scan.job_id !== null) {
    try { await requestCancel(db, scan.job_id, login); } catch (e) { if (!(e instanceof JobError)) throw e; }
  }
  await finishScan(db, id, "stopped");
  await auditAs(db, login, "security-scan-stop", `${scan.repo}:scan:${id}`, { repo: scan.repo, was: scan.state, ...extra });
  return await toScan(db, (await scanRow(db, id))!);
}

export async function actOnFindingAs(db: Db, repo: string, n: number, login: string, b: Record<string, unknown>, extra: AuditExtra = {}): Promise<FindingView> {
  const action = b.action as FindingAction;
  const start = STEPS[action];
  if (start) {
    const row = await findingRow(db, repo, n);
    if (!row) throw new SecurityError(404, NOT_FOUND);
    return startStep(db, row, login, action, start, b, extra);
  }
  if (action !== "dismiss" && action !== "backlog" && action !== "reopen") throw new SecurityError(400, "unknown action");
  const row = await findingRow(db, repo, n);
  if (!row) throw new SecurityError(404, NOT_FOUND);
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, REASON_MAX) : "";
  if (action === "dismiss" && !reason) throw new SecurityError(400, "dismissing needs a reason");
  const to = await moveFinding(db, repo, n, action, login, reason || null);
  if (!to) throw new SecurityError(409, `a finding that is ${row.state} cannot be ${action === "reopen" ? "reopened" : action === "dismiss" ? "dismissed" : "moved to the backlog"}`);
  await auditAs(db, login, `security-finding-${action}`, findingKey(repo, n), { from: row.state, to, ...(reason && { reason }), ...extra });
  return await toFinding(db, (await findingRow(db, repo, n))!);
}

/**
 * Starts the private fix of each confirmed finding (of `repo`, or finding `n` of it) that has never had a fix job (a cancelled one does not count):
 * verify held it up, so the fix is ready when an operator opens it, and Land stays the operator's. A fix that fails
 * leaves the finding new with its note, for the operator's Fix. With the scan-tests switch on, a finding whose scan test is
 * still building, or passed on the current code, waits for a person. Returns how many fixes it queued.
 */
export async function autoFixConfirmed(db: Db, repo?: string, n?: number): Promise<number> {
  return await withConfig(db, async () => {
    // A fix whose job was cancelled (the pipeline was switched off) left the finding fixing; it goes back to new first.
    await reconcile(db, repo);
    const keys = await sec.loadFindingsToFix(db, { repo, number: n, scanTests: config(db).scanTestsEnabled, minScore: MIN_VERIFY_SCORE });
    const rows = await sec.loadFindings(db, keys);
    let queued = 0;
    for (const k of keys) {
      const row = rows.get(k);
      if (!row) continue;
      try {
        await startStep(db, row as FindingRow, "pipeline", "fix", STEPS.fix!, {}, { auto: true });
        queued++;
      } catch (e) {
        if (!(e instanceof SecurityError)) throw e;
      }
    }
    return queued;
  });
}

/** The longest a round's build tasks may run before the round counts as ended and its tasks are cancelled; the clock waits for a confidential environment (privateClockStart). */
export const ROUND_BUILD_LIMIT_MS = 4 * 3_600_000;

/**
 * `ready`: when a confidential build environment was first ready, or null. `sessions`: the fix_sessions setting; `sessionEnv`: a
 * confidential kubernetes environment can hold a security fix session's workspace.
 */
export type SecurityFixWork = { due: Awaited<ReturnType<typeof sec.loadFixesToAdvance>>; ready: number | null; sessions: FixSessionsSetting; sessionEnv: boolean };

/** What advanceSecurityFixes reads, in one wave. */
export async function loadSecurityFixWork(db: Db): Promise<SecurityFixWork> {
  const [due, ready, sessions, env] = await db.together(() => Promise.all([sec.loadFixesToAdvance(db), loadConfidentialReadyAt(db), fixSessionsSetting(db), fixSessionEnv(db, "security")]));
  return { due, ready, sessions, sessionEnv: typeof env === "string" };
}

/**
 * Queues a fix job for each fixing finding whose build round has ended (its tasks are done, or it has been building past
 * ROUND_BUILD_LIMIT_MS, when the tasks are cancelled), or that waited for a confidential build environment that is now ready, and that has no fix job queued or running: the job reads the result and
 * writes the next round or the commit. The job is requested by whoever started the fix; fixes the pipeline started continue
 * only while `pipelineOn` (read by the caller at the same time as the rows here). Returns how many jobs it queued.
 */
export async function advanceSecurityFixes(db: Db, pipelineOn = true, work?: SecurityFixWork): Promise<number> {
  const { due, ready, sessions, sessionEnv } = work ?? await loadSecurityFixWork(db);
  const inSessions = (repo: string): boolean => sessions.steps.includes("security") && (sessions.repos === null || sessions.repos.includes(repo));
  // A fix that waits for a confidential build environment continues once one is ready; in a fix session, once a confidential
  // kubernetes environment can hold its workspace too.
  const rows = due.filter((r) => r.tasks !== null || (ready !== null && (sessionEnv || !inSessions(r.repo))));
  const ids = rows.flatMap((r) => (r.tasks ? [r.tasks.head, r.tasks.base] : []));
  const tasks = await loadTasks(db, ids);
  let queued = 0;
  for (const r of rows) {
    const by = r.by ?? "pipeline";
    if (by === "pipeline" && !pipelineOn) continue;
    const open = r.tasks ? [r.tasks.head, r.tasks.base].filter((id) => { const t = tasks.get(id); return !!t && !TERMINAL.includes(t.state); }) : [];
    if (open.length) {
      // The private clock starts when the round was queued, or when a confidential environment could first take it.
      const since = ready === null ? null : Math.max(Date.parse(r.roundCreatedAt!), ready);
      if (since === null || Date.now() - since <= ROUND_BUILD_LIMIT_MS) continue;
      await cancelTasks(db, { ids: open }, "security-fix");
    }
    try {
      await enqueueSecurity(db, STEPS.fix!.step, { repo: r.repo, number: r.number }, by);
      queued++;
    } catch (e) {
      if (!(e instanceof JobError)) throw e;
    }
  }
  return queued;
}

/** Moves the finding to the state the step works in, then queues the step; the state goes back when the queue refuses. */
async function startStep(db: Db, row: FindingRow, login: string, action: FindingAction, s: NonNullable<(typeof STEPS)[FindingAction]>, b: Record<string, unknown>, extra: AuditExtra): Promise<FindingView> {
  const { repo, number: n } = row;
  if (!s.from.includes(row.state)) throw new SecurityError(409, `a finding that is ${row.state} cannot be ${action === "fix" ? "fixed" : action === "land" ? "landed" : action === "advisory" ? "sent the advisory way" : "published"}; this needs ${s.busy}`);
  if (action === "publish" && (await loadLiveJobs(db)).some((j) => j.step === s.step && (j.state === "queued" || j.state === "running") && sameFinding(j.params, repo, n))) {
    throw new SecurityError(409, "this finding is already being published");
  }
  if (action === "fix" && !row.verification) throw new SecurityError(409, "the finding has not been verified");
  // Land after the advisory route starts over on the public fork: the advisory's private fork and its pull request are forgotten (ghsa_id stays).
  const reset: sec.FindingPatch = action === "land" && row.state === "awaiting-admin" ? { fork: null, fix_pr: null } : {};
  // The state change, the attempt count and the job are written together: a refused job leaves the finding as it was.
  await db.write(async () => {
    if (action === "fix") await clearRounds(db, repo, n);
    if (s.to && !await advance(db, repo, n, s.from, s.to, { note: null, ...reset, ...(action === "fix" && { bumpFixAttempts: true as const }) }, login)) throw new SecurityError(409, "the finding changed; reload and try again");
    try {
      await enqueueSecurity(db, s.step, { repo, number: n, ...(action === "publish" && { cve: b.cve === true ? 1 : 0 }) }, login);
    } catch (e) {
      if (e instanceof JobError) throw new SecurityError(e.status, e.message);
      throw e;
    }
    await auditAs(db, login, `security-finding-${action}`, findingKey(repo, n), { from: row.state, ...(action === "publish" && { cve: b.cve === true }), ...extra });
  });
  return await toFinding(db, (await findingRow(db, repo, n))!);
}

const sameFinding = (params: string, repo: string, n: number): boolean => {
  try {
    const p = JSON.parse(params) as { repo?: unknown; number?: unknown };
    return p.repo === repo && p.number === n;
  } catch { return false; }
};
