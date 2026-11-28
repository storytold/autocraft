// The workspace an implementation works in and the model calls it makes there. One workspace per attempt, at the
// default branch head the attempt is based on: the plan call warms it, the session reuses it. Every call is bound to the
// queuer (calls.ts NewCall.forLogin) and runs in one of their Task Runner's normal slots (boundSlot), and each one is
// recorded as a workspace_sessions row of kind `implement`, whose workspace the sweep keeps (keep = 1).
import type { Db } from "../db/index.ts";
import { addSession, patchSessions } from "../data/build/index.ts";
import { loadRepos } from "../data/mirror/index.ts";
import { finishRun } from "../agents/runs.ts";
import { assertFence } from "../db/fence.ts";
import { listEnvs } from "../build/envs.ts";
import { guardedApi, inClusterApi } from "../build/kube-api.ts";
import { queueWorkspaceCall, type WorkspaceCallRequest } from "../build/workspace-call.ts";
import { READY_LIMIT_MS } from "../build/workspace-launch.ts";
import { cleanOutput, createWorkspace, execWs, getWorkspace, LIVE_STATES, resumeWorkspace, type WorkspaceStateName } from "../build/workspaces.ts";
import { awaitCall, type Outcome } from "../remote/calls.ts";
import { slugOf } from "../owners.ts";
import { ghApi } from "../verify/crates.ts";
import type { StepContext } from "../runner/steps.ts";

/** An implementation's pod lives this long from its start: the plan, the session, its checks and follow-ups. */
export const IMPLEMENT_WORKSPACE_DEADLINE_SEC = 24 * 3600;
/** The most a call waits in the remote call queue for the queuer's Task Runner; past it the call is withdrawn and the job ends. */
export const CALL_QUEUE_WAIT_MS = 30 * 60_000;
export const SESSION_KIND = "implement";

const SHA = /^[0-9a-f]{40}$/;
const READY_POLL_MS = 3000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();

/** The workspace did not get ready. `startFailure` is false for a cancel: that is a person's doing, not a failed start. */
export class WorkspaceUnavailable extends Error {
  readonly startFailure: boolean;
  constructor(message: string, startFailure = true) {
    super(message);
    this.startFailure = startFailure;
  }
}

/** The head commit of the repo's default branch on GitHub, or null. */
export async function mainHeadOf(db: Db, repo: string): Promise<string | null> {
  const branch = (await loadRepos(db, { names: [repo] })).get(repo)?.default_branch ?? "main";
  try {
    const s = (await ghApi(`repos/${slugOf(repo)}/commits/${encodeURIComponent(branch)}`, ".sha")).trim();
    return SHA.test(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * The kubernetes environment implementations and PR fix sessions run in: the one enabled kubernetes environment that is neither a
 * warm producer nor confidential (contributor code never runs where private security fixes do).
 */
export async function implementEnv(db: Db): Promise<string> {
  const k = (await listEnvs(db)).filter((e) => e.kind === "kubernetes" && e.enabled && !e.confidential && !e.settings?.warmWriter);
  if (k.length !== 1) throw new WorkspaceUnavailable(k.length ? `${k.length} kubernetes environments are enabled; implementations need exactly one` : "no kubernetes environment is enabled");
  return k[0]!.id;
}

/**
 * A ready workspace of `repo` at `baseSha`: `have` when it is still live at that base (a parked one is resumed), else a new
 * one, which `adopt` records before the wait so a resumed job takes the same workspace. Throws WorkspaceUnavailable when it
 * failed or was not ready in time.
 */
export async function readyWorkspace(ctx: StepContext, o: { repo: string; baseSha: string; have: number | null; adopt: (id: number) => Promise<void> }): Promise<number> {
  const db = ctx.db;
  let id = o.have;
  if (id !== null) {
    const w = await getWorkspace(db, id);
    if (!w || !LIVE_STATES.includes(w.state as WorkspaceStateName) || w.repo !== o.repo || w.base_sha !== o.baseSha) id = null;
  }
  if (id === null) {
    const envId = await implementEnv(db);
    id = await db.write(async () => {
      const w = await createWorkspace(db, { repo: o.repo, baseSha: o.baseSha, envId, limits: { deadlineSec: IMPLEMENT_WORKSPACE_DEADLINE_SEC }, owner: `job ${ctx.job.id}` });
      await o.adopt(w);
      return w;
    });
    ctx.log(`workspace ${id} requested on ${envId}`);
  }
  // An external wait (registry GLOBAL_WAITS "Workspace start"): the launcher moves the row and fails it past its own limits.
  const from = Date.now();
  for (let last = "";;) {
    const w = await getWorkspace(db, id);
    if (!w) throw new WorkspaceUnavailable(`workspace ${id} is gone`);
    if (w.state === "ready") return id;
    if (w.state === "parked" && !await resumeWorkspace(db, id)) throw new WorkspaceUnavailable(`workspace ${id} is parked and could not be resumed${w.error ? `: ${w.error}` : ""}`);
    if (!LIVE_STATES.includes(w.state as WorkspaceStateName)) throw new WorkspaceUnavailable(`workspace ${id} is ${w.state}${w.error ? `: ${w.error}` : ""}`);
    if (Date.now() - from > READY_LIMIT_MS) throw new WorkspaceUnavailable(`workspace ${id} was not ready within ${Math.round(READY_LIMIT_MS / 60_000)} min (still ${w.state})`);
    if (await ctx.cancelled()) throw new WorkspaceUnavailable("cancelled while the workspace started", false);
    if (w.state !== last) {
      last = w.state;
      await ctx.progress(`workspace ${id} ${w.state}`);
      ctx.log(`workspace ${id}: ${w.state}`);
    }
    await sleep(READY_POLL_MS);
  }
}

export type BoundCall = Omit<WorkspaceCallRequest, "forLogin" | "boundSlot" | "level" | "maxAttempts"> & { forLogin: string; repo: string; number: number; baseSha: string };
export type CallResult = { callId: number; outcome: Outcome };

/**
 * Runs one model call in the workspace on the queuer's Task Runner and waits for it (awaitCall serves its tool calls). The
 * call goes back to the queue once when its lease is lost. Finishes the call's agent run with its usage and reply, and
 * records the call as a session row. NoTakerError and WaitLimitError from the wait pass through.
 */
export async function runBoundCall(ctx: StepContext, r: BoundCall): Promise<CallResult> {
  const db = ctx.db, at = iso();
  const session = await addSession(db, {
    kind: SESSION_KIND, repo: r.repo, base_sha: r.baseSha, item: r.number, prompt: null, env_id: (await getWorkspace(db, r.workspaceId))?.env_id ?? "",
    keep: 1, deadline_sec: r.timeoutSeconds, workspace_id: r.workspaceId, job_id: ctx.job.id, state: "starting", requested_by: r.forLogin, created_at: at, updated_at: at,
  });
  const end = async (state: "done" | "failed", outcome: string) => {
    await patchSessions(db, [{ id: session, set: { state, outcome: outcome.slice(0, 300), ended_at: iso() } }]);
  };
  let callId: number;
  try {
    callId = await queueWorkspaceCall(db, { ...r, forLogin: r.forLogin, boundSlot: true, maxAttempts: 2 });
  } catch (e) {
    await end("failed", `not queued: ${(e as Error).message}`);
    throw e;
  }
  await patchSessions(db, [{ id: session, set: { remote_call_id: callId, state: "running" } }]);
  ctx.log(`model call ${callId} queued for ${r.forLogin}'s Task Runner (workspace ${r.workspaceId})`);
  let outcome: Outcome;
  try {
    outcome = await awaitCall(db, callId, { log: ctx.log, maxWaitMs: CALL_QUEUE_WAIT_MS });
  } catch (e) {
    await end("failed", `the model call ended: ${(e as Error).message}`);
    throw e;
  }
  if (outcome.state === "done") {
    if (outcome.runId !== null) {
      const u = outcome.usage;
      await finishRun(db, outcome.runId, { state: "done", tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite }, costUsd: outcome.costUsd, summary: outcome.turns !== null ? `answered in ${outcome.turns} turns` : "answered", output: outcome.text });
    }
    await end("done", `done${outcome.turns !== null ? ` in ${outcome.turns} turns` : ""}${outcome.costUsd !== null ? `, $${outcome.costUsd.toFixed(2)}` : ""}`);
  } else if (outcome.state === "failed") {
    await end("failed", `failed: ${cleanOutput(Buffer.from(outcome.error)).replace(/\s+/g, " ").slice(0, 200)}`);
  } else await end("failed", "not taken by the session's Task Runner");
  return { callId, outcome };
}

/** Puts /work/src back to the base commit's files (`git checkout -- .` and `git clean -fd`) as an own call; the build directory is kept. Returns an error line, or null. */
export async function resetTree(db: Db, workspaceId: number): Promise<string | null> {
  const cluster = inClusterApi();
  if (!cluster) return "this runner is not in the cluster, so it cannot reach the workspace";
  const api = guardedApi(cluster, () => assertFence(db));
  try {
    const r = await execWs(db, api, workspaceId, ["run", "120", "--", "bash", "-c", "cd /work/src && git checkout -- . && git clean -fd -q"], { tool: "report", args: { report: "reset-tree" }, timeoutMs: 130_000 });
    if (r.error) return r.error;
    if (r.header?.kind === "status" && r.header.exit !== 0) return `git exited ${r.header.exit ?? r.header.state}: ${r.output.replace(/\s+/g, " ").slice(0, 200)}`;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

