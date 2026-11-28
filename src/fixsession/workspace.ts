// The workspace of a fix session: one per session, at the commit its step works on (the PR head, a merge commit, or a finding's
// pinned commit). A step gets it ready with ensureWorkspace: a new one from the warm copy, the live one resumed, a lost one made
// again, and one at another commit reseeded there (`ws reseed`: the tree's changes are dropped, the build target stays). A tree a
// lint follow-up needs again is the commit plus the stored patch (restorePatch). A session's workspace is parked as soon as its step
// has nothing pending (parkSession) and ended with the session (endSessionWorkspaces, sweepFixSessions).
import type { Db } from "../db/index.ts";
import { addWorkspaceCalls, loadEnvs, markCalls } from "../data/build/index.ts";
import type { WorkspaceRow } from "../data/build/index.ts";
import { envSettings, listEnvs } from "../build/envs.ts";
import type { KubeApi } from "../build/kube-api.ts";
import { FETCH_CALL_MS, fetchDependencies } from "../build/workspace-fetch.ts";
import { cargoLocksDiffer, READY_LIMIT_MS, SEED_LIMIT_MS, sourceArchive } from "../build/workspace-launch.ts";
import {
  CALL_GRACE_MS, createWorkspace, describeHeader, endWorkspace, execWs, getWorkspace, LIVE_STATES, MAX_CALL_OUTPUT, parkWorkspace, reseedWorkspace, RESUME_TRIES,
  resumeWorkspace, type WorkspaceStateName,
} from "../build/workspaces.ts";
import { implementEnv, WorkspaceUnavailable } from "../implement/workspace.ts";
import { endIdle, ensureSession, updateSession, type EndedFixSession, type FixSession, type FixSessionKind } from "./store.ts";

export { WorkspaceUnavailable };

/** The registry wait (GLOBAL_WAITS) a step is in while its session's workspace is not ready. */
export const FIX_WORKSPACE_WAIT = "Fix session workspace";
/** workspace_sessions.kind of a fix session's model calls. */
export const WORKSPACE_SESSION_KIND: Record<FixSessionKind, "fix" | "security-fix"> = { pr: "fix", security: "security-fix" };
/** A session's pod lives this long from its start; a session idle for a day ends anyway (store.ts SESSION_IDLE_MS). */
export const FIX_WORKSPACE_DEADLINE_SEC = 24 * 3600;
const SRC = "/work/src";
const RESTORE_FILE = "/work/.ws/restore.diff";
/** Puts the tree back to the base commit in `$1` (target kept, unchanged files keep their mtimes) and applies the restore file. */
const RESTORE_SH = `set -e
git update-index -q --refresh >/dev/null 2>&1 || :
git reset -q --hard "$1"
git clean -ffdxq -e /target
git apply --binary --whitespace=nowarn ${RESTORE_FILE}`;
const SHA = /^[0-9a-f]{40}$/;
const short = (s: string) => s.slice(0, 8);

/** What the workspace calls of a step need: the database, the cluster, and the job's log, progress and cancel check. */
export type FixWorkspaceEnv = {
  db: Db; api: KubeApi; log: (line: string) => void;
  progress?: (text: string) => Promise<void>;
  cancelled?: () => Promise<boolean>;
  pollMs?: number;
  now?: () => number;
};

/** The step waits (registry wait FIX_WORKSPACE_WAIT): no environment can hold the session's workspace now. */
export type WorkspaceWait = { kind: "wait"; wait: typeof FIX_WORKSPACE_WAIT; reason: string };
/**
 * created: a new workspace; kept: the live one, already at the commit, tree as it was (keepTree); resumed: a parked one brought back
 * at the commit (keepTree); reseeded: a live one moved to the commit, or started anew at it; remade: a new one for one that was lost.
 */
export type WorkspaceHow = "created" | "kept" | "resumed" | "reseeded" | "remade";
/** The dependency fetch at seed: none needed, needed but no crate mirror (the session is told), or its outcome. */
export type DependencyFetch = { state: "unchanged" } | { state: "no-mirror" } | { state: "fetched" | "failed"; text: string };
export type WorkspaceReady = {
  kind: "ready"; workspaceId: number; baseCommit: string; how: WorkspaceHow;
  /** Why a workspace was made again (how `remade`). */
  why: string | null;
  /** The session's workspace was at another commit: the next message names the move. */
  moved: { from: string; to: string } | null;
  dependencies: DependencyFetch;
  /** A workspace ended because it was replaced. */
  ended: number | null;
};

/** The environment a session's workspace runs in: implementations' for a PR, a confidential one for a security fix (none: a wait). */
export async function fixSessionEnv(db: Db, kind: FixSessionKind): Promise<string | WorkspaceWait> {
  if (kind === "pr") return await implementEnv(db);
  const k = (await listEnvs(db)).filter((e) => e.kind === "kubernetes" && e.enabled && e.confidential && !e.settings?.warmWriter).sort((a, b) => a.id.localeCompare(b.id));
  return k[0]?.id ?? { kind: "wait", wait: FIX_WORKSPACE_WAIT, reason: "no confidential kubernetes environment is enabled" };
}

/**
 * The session's workspace, ready at `at` (a PR head, a merge commit or a pinned sha), recorded on the session as its workspace and
 * head. The live one is resumed when parked, and reseeded at `at` when it holds another commit or, unless `keepTree`, holds changes
 * of an earlier turn: a new step always starts from a clean tree. A lost one (gone, failed, out of resumes, not ready in time, or
 * with a helper too old to reseed) is ended and made again from the warm copy, once per call. When the tree changed and its
 * Cargo.lock files differ from the warm version's, the dependencies are fetched through the environment's crate mirror. Throws
 * WorkspaceUnavailable when the workspace does not get ready.
 */
export async function ensureWorkspace(session: FixSession, at: string, env: FixWorkspaceEnv, o: { keepTree?: boolean } = {}): Promise<WorkspaceReady | WorkspaceWait> {
  if (!SHA.test(at)) throw new Error(`not a commit: ${at}`);
  const db = env.db;
  const now = env.now ?? Date.now;
  const moved = session.head && session.head !== at ? { from: session.head, to: at } : null;
  let id = session.workspaceId;
  let how: WorkspaceHow, why: string | null = null, ended: number | null = null, made = false;

  const make = async (reason: string | null): Promise<WorkspaceWait | null> => {
    const envId = await fixSessionEnv(db, session.kind);
    if (typeof envId !== "string") return envId;
    if (id !== null && await endWorkspace(db, id, now())) ended = id;
    id = await db.write(async () => {
      const w = await createWorkspace(db, { repo: session.repo, baseSha: at, envId, limits: { deadlineSec: FIX_WORKSPACE_DEADLINE_SEC }, owner: `fix session ${session.id}` }, now());
      await updateSession(db, session.id, { workspaceId: w, head: at }, now());
      return w;
    });
    made = true;
    how = reason === null ? "created" : "remade";
    why = reason;
    env.log(`fix session ${session.id}: workspace ${id} requested on ${envId} at ${short(at)}${reason ? ` (${reason})` : ""}${ended !== null ? `; workspace ${ended} ended` : ""}`);
    return null;
  };

  const w = id !== null ? await getWorkspace(db, id) : undefined;
  if (!w || !LIVE_STATES.includes(w.state as WorkspaceStateName) || w.repo !== session.repo || (w.state === "parked" && w.resume_tries >= RESUME_TRIES)) {
    const wait = await make(w ? `workspace ${w.id} was ${w.state === "parked" ? "parked and out of resumes" : w.state}` : null);
    if (wait) return wait;
  } else how = w.state === "parked" ? "resumed" : "kept";

  let row: WorkspaceRow;
  for (;;) {
    const ready = await readyRow(env, id!);
    if (typeof ready !== "string") {
      row = ready;
      if (made || (o.keepTree && row.base_sha === at)) break;
      // Reseeded at `at`, also at the same commit: the new step starts from a clean tree.
      const src = await sourceArchive(session.repo, at);
      const r = await reseedWorkspace(db, env.api, id!, at, src, SEED_LIMIT_MS, now);
      if (r.ok) {
        row = { ...row, base_sha: at, base_commit: r.baseCommit };
        how = "reseeded";
        await updateSession(db, session.id, { workspaceId: id, head: at }, now());
        env.log(`fix session ${session.id}: workspace ${id} reseeded at ${short(at)}${moved ? ` (was ${short(moved.from)})` : ""}`);
        break;
      }
      if (made) throw new WorkspaceUnavailable(`workspace ${id}: ${r.reason}`);
      const wait = await make(r.outdated ? `workspace ${id}'s helper cannot reseed (an older image)` : r.reason);
      if (wait) return wait;
      continue;
    }
    if (made) throw new WorkspaceUnavailable(ready);
    const wait = await make(ready);
    if (wait) return wait;
  }
  if (row.base_sha === at && session.workspaceId === id && session.head !== at) await updateSession(db, session.id, { head: at }, now());
  const baseCommit = row.base_commit && SHA.test(row.base_commit) ? row.base_commit : at;
  const changed = how! !== "kept" && how! !== "resumed";
  const dependencies = changed ? await fetchIfNeeded(env, row, at) : { state: "unchanged" as const };
  return { kind: "ready", workspaceId: id!, baseCommit, how: how!, why, moved, dependencies, ended };
}

/** The ready row of workspace `id`, resuming it when parked; a string says why it will not be ready (an external wait, Workspace start). */
async function readyRow(env: FixWorkspaceEnv, id: number): Promise<WorkspaceRow | string> {
  const now = env.now ?? Date.now;
  const from = now();
  for (let last = "";;) {
    const w = await getWorkspace(env.db, id);
    if (!w) return `workspace ${id} is gone`;
    if (w.state === "ready") return w;
    if (w.state === "parked" && !await resumeWorkspace(env.db, id, now())) return `workspace ${id} is parked and could not be resumed${w.error ? `: ${w.error}` : ""}`;
    if (!LIVE_STATES.includes(w.state as WorkspaceStateName)) return `workspace ${id} is ${w.state}${w.error ? `: ${w.error}` : ""}`;
    if (now() - from > READY_LIMIT_MS) return `workspace ${id} was not ready within ${Math.round(READY_LIMIT_MS / 60_000)} min (still ${w.state})`;
    if (await env.cancelled?.()) throw new WorkspaceUnavailable("cancelled while the workspace started", false);
    if (w.state !== last) {
      last = w.state;
      await env.progress?.(`workspace ${id} ${w.state}`);
      env.log(`workspace ${id}: ${w.state}`);
    }
    await new Promise((r) => setTimeout(r, env.pollMs ?? 3000));
  }
}

/**
 * Fetches the dependencies of a tree that changed when its Cargo.lock files differ from those of the warm version the target came
 * from (with no warm version, whenever it has any), through the environment's crate mirror. A fetch that fails does not fail the
 * step: the session is told, and the lint task, which can fetch, stays the gate.
 */
async function fetchIfNeeded(env: FixWorkspaceEnv, w: WorkspaceRow, at: string): Promise<DependencyFetch> {
  const db = env.db;
  const now = env.now ?? Date.now;
  if (!await cargoLocksDiffer(w.repo, w.warm_commit, at)) return { state: "unchanged" };
  const s = envSettings((await loadEnvs(db, { ids: [w.env_id] }))[0] ?? { settings: null });
  if (!s.crateMirror) return { state: "no-mirror" };
  const iso = () => new Date(now()).toISOString();
  const row = (await addWorkspaceCalls(db, [{
    workspace_id: w.id, n: null, tool: "seed", args: JSON.stringify({ fetch: SRC }), state: "running", result: null, created_at: iso(), started_at: iso(),
    deadline_at: new Date(now() + FETCH_CALL_MS + CALL_GRACE_MS).toISOString(), finished_at: null, run_id: null,
  }]))[0]!;
  const r = await fetchDependencies(db, env.api, w.id, row, SRC, { now });
  await markCalls(db, [{ id: row, set: { state: r.isError ? "failed" : "done", result: JSON.stringify({ output: r.text.slice(0, MAX_CALL_OUTPUT) }), finished_at: iso() } }]);
  env.log(`workspace ${w.id}: dependencies ${r.isError ? "not fetched" : "fetched"} at ${short(at)}`);
  return { state: r.isError ? "failed" : "fetched", text: r.text };
}

export type RestoreResult = { ok: true } | { ok: false; reason: string; stale: boolean };

/**
 * Makes a ready workspace's tree its base commit plus a stored patch (a lint follow-up after the pod was lost): the tree is put back
 * to the base, then the patch applied. A patch made on another head than the workspace's (`stale`) is not applied: the branch moved.
 */
export async function restorePatch(env: FixWorkspaceEnv, workspaceId: number, patch: { diff: Uint8Array | string; head: string }): Promise<RestoreResult> {
  const db = env.db;
  const w = await getWorkspace(db, workspaceId);
  if (w?.state !== "ready" || !w.base_commit || !SHA.test(w.base_commit)) return { ok: false, stale: false, reason: `workspace ${workspaceId} is ${w?.state ?? "gone"}` };
  if (w.base_sha !== patch.head) return { ok: false, stale: true, reason: `the patch was made on ${short(patch.head)}; the workspace is at ${short(w.base_sha)}` };
  const diff = typeof patch.diff === "string" ? Buffer.from(patch.diff) : Buffer.from(patch.diff);
  const put = await execWs(db, env.api, workspaceId, ["put", RESTORE_FILE], { tool: "checkpoint", args: { restore: "patch", bytes: diff.length }, stdin: diff, timeoutMs: 120_000, touch: true }, env.now);
  if (put.header?.kind !== "ok") return { ok: false, stale: false, reason: `the patch could not be copied in: ${put.error ?? describeHeader(put.header)}` };
  const r = await execWs(db, env.api, workspaceId, ["run", "300", "--", "sh", "-c", RESTORE_SH, "restore", w.base_commit], { tool: "checkpoint", args: { restore: "apply" }, timeoutMs: 310_000, touch: true }, env.now);
  if (r.header?.kind !== "status" || r.header.state !== "exited" || r.header.exit !== 0) {
    return { ok: false, stale: false, reason: `the patch does not apply (${r.error ?? describeHeader(r.header)})${r.output.trim() ? `: ${r.output.trim().split("\n").pop()!.slice(0, 300)}` : ""}` };
  }
  return { ok: true };
}

/** Parks the session's pod now (its step has nothing pending); the volume stays, and the next step resumes it. False when it was not ready. */
export async function parkSession(env: FixWorkspaceEnv, session: FixSession): Promise<boolean> {
  if (session.workspaceId === null) return false;
  const parked = await parkWorkspace(env.db, env.api, session.workspaceId, (env.now ?? Date.now)());
  if (parked) env.log(`fix session ${session.id}: workspace ${session.workspaceId} parked`);
  return parked;
}

/** Ends the workspaces of ended sessions; the launcher deletes their pods and volumes. Returns the workspaces ended. */
export async function endSessionWorkspaces(db: Db, ended: readonly Pick<EndedFixSession, "workspaceId">[], nowMs: number = Date.now()): Promise<number[]> {
  const out: number[] = [];
  for (const e of ended) if (e.workspaceId !== null && await endWorkspace(db, e.workspaceId, nowMs)) out.push(e.workspaceId);
  return out;
}

/** ensureSession, with the workspace of a session it ended (replaced, or its item stopped) ended too. */
export async function openSession(db: Db, kind: FixSessionKind, repo: string, number: number, o: Parameters<typeof ensureSession>[4] = {}): ReturnType<typeof ensureSession> {
  const r = await ensureSession(db, kind, repo, number, o);
  if (r.ended) await endSessionWorkspaces(db, [r.ended], o.nowMs);
  return r;
}

/** The maintenance sweep's part: ends the sessions that are done (store.ts endIdle) and their workspaces. Returns the sessions ended. */
export async function sweepFixSessions(db: Db, log: (line: string) => void = () => {}, nowMs: number = Date.now()): Promise<number> {
  const ended = await endIdle(db, nowMs);
  for (const e of ended) {
    const ws = await endSessionWorkspaces(db, [e], nowMs);
    log(`fix session ${e.id} (${e.repo}#${e.number}) ended: ${e.reason}${ws.length ? `; workspace ${ws[0]} ended` : ""}`);
  }
  return ended.length;
}
