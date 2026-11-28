// Workspace rows and the one way to run something in a workspace pod. Every exec checks that the pod the row names is
// the pod labelled with the row's id, runs the helper `ws` with fixed argv positions for anything that came from a
// session, and records the call in workspace_calls. Output from the pod is untrusted: it is decoded as UTF-8 with
// replacement and stripped of control characters before it is stored or printed.
import type { Db } from "../db/index.ts";
import {
  addWorkspaceCalls, loadCheckpoint, loadEnvs, loadWorkspaces, markCalls, moveWorkspaces, patchWorkspaces, requestWorkspaces, takeCallNumber as nextCallNumber, WorkspaceError,
  DEFAULT_WORKSPACE_DEADLINE_SEC, LIVE_STATES, POD_STATES, WORKSPACE_STATES,
} from "../data/build/index.ts";
import type { WorkspaceRow, WorkspaceStateName } from "../data/build/index.ts";
import { BuildError, envSettings } from "./envs.ts";
import { KubeError, type ExecOptions, type ExecResult, type KubeApi } from "./kube-api.ts";
import { ciCheckout } from "./pods.ts";
import { WS_POD_PATH } from "./workspace.ts";
import { WS_CONTAINER, workspaceSelector, type WorkspaceLimits } from "./workspace-pods.ts";

export { LIVE_STATES, POD_STATES, WORKSPACE_STATES };
export type { WorkspaceRow, WorkspaceStateName };

/** Output kept per call, after the helper's own cap. */
export const MAX_CALL_OUTPUT = 64 * 1024;


export const getWorkspace = async (db: Db, id: number): Promise<WorkspaceRow | undefined> => (await loadWorkspaces(db, { ids: [id] })).get(id);
export const getCheckpoint = async (db: Db, id: number): Promise<Uint8Array | null> => await loadCheckpoint(db, id);

/** A running call holds the pod until this long past its own time limit. */
export const CALL_GRACE_MS = 30_000;

export const limitsOf = (w: { limits: string }): WorkspaceLimits => {
  try {
    const o = JSON.parse(w.limits) as Partial<WorkspaceLimits>;
    return { deadlineSec: typeof o.deadlineSec === "number" && o.deadlineSec > 0 ? o.deadlineSec : DEFAULT_WORKSPACE_DEADLINE_SEC };
  } catch {
    return { deadlineSec: DEFAULT_WORKSPACE_DEADLINE_SEC };
  }
};

/** Throws when `envId` is a warm writer environment: it holds the warm store's write credential, which a workspace must never see. */
export async function refuseWarmWriter(db: Db, envId: string): Promise<void> {
  const env = (await loadEnvs(db, { ids: [envId] }))[0];
  if (env?.kind === "kubernetes" && envSettings(env).warmWriter) throw new BuildError(400, `${envId} is a warm writer environment and takes no workspaces`);
}

export type WorkspaceRequest = { repo: string; baseSha: string; envId: string; app?: string | null; limits?: Partial<WorkspaceLimits>; owner: string | null };

/** Maps the data module's refusals to the status errors the API answers with. */
const mapped = (e: unknown): never => {
  throw e instanceof WorkspaceError ? new BuildError(e.status, e.message) : e;
};

/** Records a `requested` workspace; the launcher creates its volume and pod when the environment has a free slot. */
export async function createWorkspace(db: Db, r: WorkspaceRequest, now = Date.now()): Promise<number> {
  // A repository with a warm target works at the CI paths, so its builds reuse the node's warm version (workspace-layout.ts).
  const ids = await requestWorkspaces(db, [{ repo: r.repo, baseSha: r.baseSha, envId: r.envId, app: r.app, limits: r.limits, owner: r.owner, ciCheckout: ciCheckout(r.repo) !== null }], new Date(now).toISOString()).catch(mapped);
  return ids[0]!;
}

/**
 * Moves a row from one of `from` to `to` with `set`; false when it was no longer in `from` (another pass, the CLI or an
 * end got there first), so a step that ran in the background never revives a row that ended meanwhile.
 */
export async function moveWorkspace(db: Db, id: number, from: WorkspaceStateName[], to: WorkspaceStateName, set: Partial<Omit<WorkspaceRow, "id" | "state">> = {}, now = Date.now()): Promise<boolean> {
  return (await moveWorkspaces(db, [{ id, from, to, set }], new Date(now).toISOString())).has(id);
}

/** Failed resumes after which a parked workspace stays parked, with its volume and checkpoint, until someone looks at it. */
export const RESUME_TRIES = 3;

/**
 * Brings a parked workspace back: the launcher starts a new pod when a slot is free, on the kept volume when there is one,
 * else on a new volume rebuilt from the base and the checkpoint. True when the row is coming back or up; false when it is
 * gone, ended or failed, or its resumes failed RESUME_TRIES times (its error says why).
 */
export async function resumeWorkspace(db: Db, id: number, now = Date.now()): Promise<boolean> {
  const w = await getWorkspace(db, id);
  if (!w) return false;
  if (w.state !== "parked") return POD_STATES.includes(w.state as WorkspaceStateName) || w.state === "requested";
  if (w.resume_tries >= RESUME_TRIES) return false;
  if (await moveWorkspace(db, id, ["parked"], "requested", { create_tries: 0, ...(w.pvc ? {} : { node: null }) }, now)) return true;
  return await resumeWorkspace(db, id, now);
}

/** Ends a live workspace; the launcher's next pass deletes its pod and volume. */
export async function endWorkspace(db: Db, id: number, now = Date.now()): Promise<boolean> {
  return await moveWorkspace(db, id, LIVE_STATES, "ended", {}, now);
}

/** What a reseed did: the new base commit, or why not. `outdated`: the pod's helper has no `reseed` (an older image made it). */
export type ReseedResult = { ok: true; baseCommit: string } | { ok: false; outdated: boolean; reason: string };

/**
 * Replaces a ready workspace's tree with `sha`'s (`ws reseed`, fed the commit's tar from `src`), dropping the tree's changes, and
 * moves the row to it: base_sha, base_commit, no checkpoint (the old one was against the old tree), and restored `reseed` with its
 * time, which a checkpoint read before it compares against. Throws when the pod check fails or the exec never started.
 */
export async function reseedWorkspace(db: Db, api: KubeApi, id: number, sha: string, src: { bytes: number; open: () => AsyncIterable<Buffer> }, timeoutMs: number, now = Date.now): Promise<ReseedResult> {
  const r = await execWs(db, api, id, ["reseed"], { tool: "seed", args: { reseed: sha, bytes: src.bytes }, stdin: src.open(), timeoutMs, touch: true }, now);
  const h = r.header;
  if (h?.kind === "error") return { ok: false, outdated: h.code === "usage" && /^unknown subcommand/.test(h.message), reason: `ws reseed: ${describeHeader(h)}` };
  const commit = h?.kind === "ok" ? h.fields[0] ?? "" : "";
  if (!/^[0-9a-f]{40}$/.test(commit)) return { ok: false, outdated: false, reason: `ws reseed: ${r.error ?? describeHeader(h)}${r.stderr ? `: ${r.stderr.trim().split("\n").pop()}` : ""}` };
  const at = new Date(now()).toISOString();
  const moved = await patchWorkspaces(db, [{ id, whereState: ["ready"], set: { base_sha: sha, base_commit: commit, checkpoint: null, checkpoint_at: null, checkpoint_error: null, error: null, restored: "reseed", restored_at: at, updated_at: at } }]);
  return moved ? { ok: true, baseCommit: commit } : { ok: false, outdated: false, reason: `workspace ${id} left ready during the reseed` };
}

/**
 * Parks a ready workspace now, without waiting for its idle time: the row goes to parked and the pod is deleted, the volume kept.
 * No checkpoint is taken and the stored one is dropped: work a fix session must keep is stored with its step, so a workspace rebuilt
 * from no volume holds the clean base commit (restored `empty`), and a reseed or a restore starts every step's tree anew. False
 * when it was not ready.
 */
export async function parkWorkspace(db: Db, api: KubeApi, id: number, now = Date.now()): Promise<boolean> {
  const w = await getWorkspace(db, id);
  if (w?.state !== "ready") return false;
  if (!await moveWorkspace(db, id, ["ready"], "parked", { pod: null, checkpoint: null, checkpoint_at: null }, now)) return false;
  if (w.pod) {
    const env = (await loadEnvs(db, { ids: [w.env_id] }))[0];
    await api.deletePod(envSettings(env ?? { settings: null }).namespace, w.pod).catch(() => {});
  }
  return true;
}

// ---- the helper's output -------------------------------------------------------

export type WsHeader =
  | { kind: "status"; state: "exited" | "killed" | "timed-out" | "running"; exit: number | null; ms: number; bytes: number }
  | { kind: "started"; n: number }
  | { kind: "ok"; fields: string[] }
  | { kind: "error"; code: string; message: string };

/** The first line `ws` prints; null when it is not one of its headers. */
export function parseHeader(line: string): WsHeader | null {
  const f = line.trim().split(" ");
  if (f[0] !== "WS") return null;
  if (f[1] === "ok") return { kind: "ok", fields: f.slice(2) };
  if (f[1] === "error" && f[2]) return { kind: "error", code: f[2], message: f.slice(3).join(" ") };
  if (f[1] === "started" && /^\d+$/.test(f[2] ?? "")) return { kind: "started", n: Number(f[2]) };
  const st = f[1];
  if ((st === "exited" || st === "killed" || st === "timed-out" || st === "running") && f.length === 5 && /^(-?\d+|-)$/.test(f[2]!) && /^\d+$/.test(f[3]!) && /^\d+$/.test(f[4]!)) {
    return { kind: "status", state: st, exit: f[2] === "-" ? null : Number(f[2]), ms: Number(f[3]), bytes: Number(f[4]) };
  }
  return null;
}

/** Bytes from the pod as text that is safe to store, log and print: UTF-8 with replacement, no control characters but \n and \t. */
export function cleanOutput(b: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(b).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export const describeHeader = (h: WsHeader | null): string =>
  !h ? "no helper header" : h.kind === "error" ? `${h.code}: ${h.message}` : h.kind === "status" ? `${h.state}${h.exit !== null ? ` ${h.exit}` : ""} after ${h.ms} ms` : h.kind === "started" ? `started ${h.n}` : `ok ${h.fields.join(" ")}`;

/** A copy of `v` small enough to store: strings, arrays and nesting cut, so its JSON is always whole. */
export function capJson(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (depth >= 4 || typeof v !== "object") return null;
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => capJson(x, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k.slice(0, 100), capJson(x, depth + 1)]));
}

// ---- exec ----------------------------------------------------------------------

/** The namespace and pod of a workspace whose pod is up, after checking that the pod labelled with its id is the one the row names. */
export async function workspacePod(db: Db, api: KubeApi, id: number): Promise<{ ns: string; pod: string; row: WorkspaceRow }> {
  const row = await getWorkspace(db, id);
  if (!row) throw new BuildError(404, `no workspace ${id}`);
  if ((row.state !== "seeding" && row.state !== "ready") || !row.pod) throw new BuildError(409, `workspace ${id} is ${row.state}, with no pod to run in`);
  const env = (await loadEnvs(db, { ids: [row.env_id] }))[0];
  const ns = envSettings(env ?? { settings: null }).namespace;
  // An earlier pod of the workspace may still be shutting down (a resume while its node is gone); it never runs anything.
  const pods = (await api.listPods(ns, workspaceSelector(id))).filter((p) => !p.metadata.deletionTimestamp);
  const pod = pods.find((p) => p.metadata.name === row.pod);
  if (pods.length !== 1 || !pod || pod.metadata.labels?.["craft.build/workspace"] !== String(id)) {
    throw new BuildError(409, `workspace ${id}: the pod labelled with its id is not ${row.pod}`);
  }
  if (pod.status?.phase !== "Running") throw new BuildError(409, `workspace ${id}: its pod is not running`);
  return { ns, pod: row.pod, row };
}

/** Runs fixed argv in a workspace's pod, after the pod check. For AutoCraft's own commands; session input goes through execWs. */
export async function execInWorkspace(db: Db, api: KubeApi, id: number, argv: string[], opts: ExecOptions): Promise<ExecResult> {
  const { ns, pod } = await workspacePod(db, api, id);
  return await api.exec(ns, pod, WS_CONTAINER, argv, opts);
}

/** One helper call's raw outcome: the parsed first line and the bytes after it, uncleaned (file content, images). */
export type WsRaw = { header: WsHeader | null; body: Buffer; stderr: string; truncated: boolean; error?: string };

/** Splits the helper's stdout into its header line and the raw bytes after it. */
export function splitHeader(stdout: Buffer): { header: WsHeader | null; body: Buffer } {
  const nl = stdout.indexOf(0x0a);
  const header = parseHeader(cleanOutput(nl < 0 ? stdout : stdout.subarray(0, nl)));
  return { header, body: header ? (nl < 0 ? Buffer.alloc(0) : stdout.subarray(nl + 1)) : stdout };
}

/**
 * Runs `ws <argv>` in the workspace's pod after the pod check (or in `at`, a pod the caller just checked) and returns
 * the raw outcome, with no call row: the caller records it. Throws when the pod check fails or the exec never started.
 */
export async function execHelper(db: Db, api: KubeApi, id: number, argv: string[], opts: ExecOptions, at?: { ns: string; pod: string }): Promise<WsRaw> {
  const { ns, pod } = at ?? await workspacePod(db, api, id);
  const r = await api.exec(ns, pod, WS_CONTAINER, [WS_POD_PATH, ...argv], opts);
  return { ...splitHeader(r.stdout), stderr: cleanOutput(r.stderr).slice(0, 8192), truncated: r.truncated, ...(r.error !== undefined ? { error: r.error } : {}) };
}

/** Takes the workspace's next `ws run` call number. */
export const takeCallNumber = async (db: Db, id: number): Promise<number> => await nextCallNumber(db, id).catch(mapped);

export type WsCallOptions = {
  /** What the call is for: a session tool name, or the launcher's `seed` and `checkpoint`. */
  tool: string;
  args?: unknown;
  stdin?: ExecOptions["stdin"];
  timeoutMs: number;
  maxOut?: number;
  /** A queued workspace_calls row to run; otherwise one is added. */
  row?: number;
  /** Counts as activity: the workspace is not parked for 30 min after it. The launcher's own calls do not count. */
  touch?: boolean;
};
export type WsCallResult = { callId: number; n: number | null; header: WsHeader | null; output: string; stderr: string; error?: string; truncated: boolean };

/**
 * Runs `ws <argv>` in the workspace's pod and records it. For `run`, the call number is taken from the row's counter and
 * goes in after `run`, so callers pass `["run", <timeout>, ..., "--", ...cmd]`. Throws when the pod check fails or the exec
 * never started; the call row is failed then.
 */
export async function execWs(db: Db, api: KubeApi, id: number, argv: string[], o: WsCallOptions, now: () => number = Date.now): Promise<WsCallResult> {
  const iso = () => new Date(now()).toISOString();
  const at = await workspacePod(db, api, id);
  const n = argv[0] === "run" ? await takeCallNumber(db, id) : null;
  const full = n === null ? argv : ["run", String(n), ...argv.slice(1)];
  const args = JSON.stringify(capJson(o.args ?? { argv }));
  const deadline = new Date(now() + o.timeoutMs + CALL_GRACE_MS).toISOString();
  let callId = o.row;
  if (callId === undefined) {
    callId = (await addWorkspaceCalls(db, [{ workspace_id: id, n, tool: o.tool, args, state: "running", result: null, created_at: iso(), started_at: iso(), deadline_at: deadline, finished_at: null, run_id: null }]))[0]!;
  } else {
    await markCalls(db, [{ id: callId, set: { n, state: "running", started_at: iso(), deadline_at: deadline } }]);
  }
  const touch = async () => {
    if (o.touch) await patchWorkspaces(db, [{ id, set: { last_call_at: iso(), updated_at: iso() } }]);
  };
  await touch();
  const finish = async (state: "done" | "failed", result: object) => {
    await markCalls(db, [{ id: callId!, set: { state, result: JSON.stringify(result), finished_at: iso() } }]);
    await touch();
  };
  let r: WsRaw;
  try {
    r = await execHelper(db, api, id, full, { stdin: o.stdin, maxOut: o.maxOut ?? MAX_CALL_OUTPUT, timeoutMs: o.timeoutMs }, at);
  } catch (e) {
    await finish("failed", { error: e instanceof KubeError ? e.message : String((e as Error).message) });
    throw e;
  }
  const header = r.header;
  const out: WsCallResult = {
    callId, n, header, output: cleanOutput(r.body).slice(0, MAX_CALL_OUTPUT), stderr: r.stderr,
    truncated: r.truncated, ...(r.error !== undefined ? { error: r.error } : {}),
  };
  await finish(header && header.kind !== "error" && r.error === undefined ? "done" : "failed",
    { header, output: out.output, ...(out.stderr ? { stderr: out.stderr } : {}), ...(r.error ? { error: r.error } : {}), ...(r.truncated ? { truncated: true } : {}) });
  return out;
}

// ---- diff stat ------------------------------------------------------------------

/**
 * A `git diff --stat`-like summary of a `git diff --binary` (a checkpoint), read from its headers and hunks: one line per
 * file (at most `maxFiles`) and a total. The diff is the session's own data; names are cleaned of control characters.
 */
export function diffStat(diff: Uint8Array, maxFiles = 40): string {
  const files: { name: string; add: number; del: number; binary: boolean }[] = [];
  let cur: (typeof files)[number] | null = null;
  let inHunk = false;
  for (const line of cleanOutput(diff).split("\n")) {
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (head) {
      cur = { name: head[2]!, add: 0, del: 0, binary: false };
      files.push(cur);
      inHunk = false;
    } else if (!cur) continue;
    else if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk && (line.startsWith("GIT binary patch") || line.startsWith("Binary files "))) cur.binary = true;
    else if (inHunk && line.startsWith("+")) cur.add++;
    else if (inHunk && line.startsWith("-")) cur.del++;
  }
  if (!files.length) return "no changes";
  const shown = files.slice(0, maxFiles).map((f) => ` ${f.name} | ${f.binary ? "binary" : `+${f.add} -${f.del}`}`);
  const add = files.reduce((a, f) => a + f.add, 0), del = files.reduce((a, f) => a + f.del, 0);
  return [...shown, ...(files.length > maxFiles ? [` (${files.length - maxFiles} more files)`] : []),
    ` ${files.length} ${files.length === 1 ? "file" : "files"} changed, ${add} insertions(+), ${del} deletions(-)`].join("\n");
}
