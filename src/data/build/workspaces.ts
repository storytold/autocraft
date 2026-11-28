// Workspaces (`workspaces`) (package build-b).
// reads: runners.remote_calls (through runners.loadCalls)
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { loadCalls } from "../runners/index.ts";
import { patchRows } from "./row-patch.ts";
import { loadSizings } from "./sizes.ts";
import type { CallActivity, WarmNote, WorkspacePass, WorkspaceMove, WorkspaceRequest, WorkspaceRow, WorkspaceSource, WorkspaceStateName } from "./types.ts";
import { LIVE_STATES } from "./types.ts";

/** A refusal with the HTTP status the dashboard and CLI answer it with. */
export class WorkspaceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_WORKSPACE_DEADLINE_SEC = 4 * 3600;
/** `workspaces.layout` of a repository that works at the CI paths, so its builds reuse the node's warm version; others use 1. */
export const WORKSPACE_LAYOUT_CI = 2;
const NUMERIC = ["create_tries", "next_call", "volume_fresh", "resume_tries", "layout", "remote_call_id"] as const;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Every column but the checkpoint, which only a resume and `workspace show` read. */
const COLUMNS = [
  "id", "repo", "base_sha", "base_commit", "app", "env_id", "state", "state_at", "pod", "pod_created_at", "create_tries", "pvc", "node", "limits",
  "checkpoint_at", "last_call_at", "next_call", "error", "owner", "created_at", "updated_at", "ended_at", "remote_call_id",
  "volume_fresh", "resume_tries", "checkpoint_error", "restored", "restored_at", "layout", "prepared", "warm", "warm_commit",
] as const;

/** Workspace rows by ids, environment and states, remote call ids or an id subquery; `checkpoint` adds the checkpoint blob (and reads `alone`). 1 statement. */
export async function loadWorkspaces(db: Db, src: WorkspaceSource, opt: { checkpoint?: boolean } = {}): Promise<Map<number, WorkspaceRow>> {
  const out = new Map<number, WorkspaceRow>();
  if (("ids" in src && !src.ids.length) || ("remoteCallIds" in src && !src.remoteCallIds.length)) return out;
  const q = queryDb(db);
  let b = q.k.selectFrom("main.workspaces").select(opt.checkpoint ? [...COLUMNS, "checkpoint"] as const : COLUMNS).orderBy("id");
  if ("ids" in src) b = b.where(kx.inList(db, "id", src.ids, "bigint"));
  else if ("env" in src) b = b.where("env_id", "=", src.env).where("state", "in", src.states);
  else if ("remoteCallIds" in src) b = b.where(kx.inList(db, "remote_call_id", src.remoteCallIds, "bigint"));
  else b = b.where("id", "in", src.idsFrom);
  for (const r of await q.all(b, opt.checkpoint ? { alone: true } : undefined)) out.set(Number(r.id), r as WorkspaceRow);
  return out;
}

const BG_TOOLS = ["shell", "shell_status", "shell_kill"];

/**
 * One pass of the workspace launcher for `envId`: the live rows; per ready workspace the calls running with their deadlines; the
 * session's background-shell bookkeeping since its pod was created; and the state of each bound remote call that is queued or leased.
 * Three statements in one wave, then one `runners.loadCalls` when a live row is bound to a call.
 */
export async function loadWorkspacePass(db: Db, envId: string, nowMs: number): Promise<WorkspacePass> {
  const q = queryDb(db), { k } = q;
  const ready = k.selectFrom("main.workspaces").select("id").where("env_id", "=", envId).where("state", "=", "ready");
  const [rows, running, background] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.workspaces").select(COLUMNS).where("env_id", "=", envId).where("state", "in", LIVE_STATES).orderBy("id")),
    q.all(k.selectFrom("main.workspace_calls").select(["workspace_id", "id", "tool", "deadline_at"]).where("state", "=", "running").where("deadline_at", ">", new Date(nowMs).toISOString())
      .where("workspace_id", "in", ready).orderBy("id")),
    q.all(k.selectFrom("main.workspace_calls as c").innerJoin("main.workspaces as w", "w.id", "c.workspace_id")
      .select((eb) => {
        const res = eb.case().when(kx.jsonValid(db, "c.result")).then(eb.ref("c.result")).end();
        return ["c.workspace_id", "c.id", "c.tool", "c.started_at", kx.jsonNum(db, res, "$.acct.bg").as("bg"), kx.jsonNum(db, res, "$.acct.limit").as("lim"),
          kx.jsonNum(db, res, "$.acct.ref").as("ref"), kx.jsonNum(db, res, "$.acct.ended").as("ended")] as const;
      })
      .where("w.env_id", "=", envId).where("w.state", "=", "ready").where("c.tool", "in", BG_TOOLS).where("c.state", "=", "done")
      .where((eb) => eb("c.started_at", ">=", eb.fn.coalesce("w.pod_created_at", "w.state_at"))).orderBy("c.id")),
  ]));
  const calls = new Map<number, CallActivity>();
  const slot = (id: number): CallActivity => calls.get(id) ?? calls.set(id, { running: [], background: [] }).get(id)!;
  for (const r of running) slot(Number(r.workspace_id)).running.push({ id: Number(r.id), tool: r.tool, deadlineAt: r.deadline_at! });
  for (const r of background) {
    slot(Number(r.workspace_id)).background.push({ id: Number(r.id), tool: r.tool, startedAt: r.started_at, bg: r.bg === null ? null : Number(r.bg), limit: r.lim === null ? null : Number(r.lim),
      ref: r.ref === null ? null : Number(r.ref), ended: r.ended === null ? null : Number(r.ended) });
  }
  const bound = new Map<number, "queued" | "leased">();
  const callIds = [...new Set(rows.flatMap((r) => (r.remote_call_id === null ? [] : [Number(r.remote_call_id)])))];
  if (callIds.length) {
    const states = await loadCalls(db, callIds);
    for (const r of rows) {
      const s = r.remote_call_id === null ? undefined : states.get(Number(r.remote_call_id))?.state;
      if (s === "queued" || s === "leased") bound.set(Number(r.id), s);
    }
  }
  return { rows: rows as WorkspaceRow[], calls, bound };
}

/**
 * Records `requested` workspaces; the launcher creates each volume and pod when the environment has a free slot. Refuses the whole set
 * when a row is invalid, its environment is not a Kubernetes one, or it is a warm writer (it holds the warm store's write credential,
 * which a workspace must never see). A repository with a warm target works at the CI paths. Returns the ids in order.
 */
export async function requestWorkspaces(db: Db, rows: WorkspaceRequest[], now: string): Promise<number[]> {
  if (!rows.length) return [];
  const q = queryDb(db), { k } = q;
  const deadline = (r: WorkspaceRequest): number => r.limits?.deadlineSec ?? DEFAULT_WORKSPACE_DEADLINE_SEC;
  for (const r of rows) {
    if (!REPO.test(r.repo)) throw new WorkspaceError(400, "repo must be a repository name");
    if (!SHA.test(r.baseSha)) throw new WorkspaceError(400, "the base must be a full 40-character commit sha");
    const d = deadline(r);
    if (!Number.isInteger(d) || d < 300 || d > 24 * 3600) throw new WorkspaceError(400, "deadlineSec must be 300 to 86400");
  }
  const envIds = [...new Set(rows.map((r) => r.envId))], ciRepos = [...new Set(rows.filter((r) => r.ciCheckout).map((r) => r.repo))];
  const [envs, sizings] = await Promise.all([
    q.all(k.selectFrom("main.build_envs").select(["id", "kind", "settings"]).where(kx.inList(db, "id", envIds))),
    loadSizings(db, ciRepos),
  ]);
  const envOf = new Map(envs.map((e) => [e.id, e]));
  for (const id of envIds) {
    const env = envOf.get(id);
    if (env?.kind !== "kubernetes") throw new WorkspaceError(400, `${id} is not a kubernetes environment`);
    let writer = false;
    try { writer = (JSON.parse(env.settings ?? "null") as { warmWriter?: unknown } | null)?.warmWriter === true; } catch { /* no settings: not a writer */ }
    if (writer) throw new WorkspaceError(400, `${id} is a warm writer environment and takes no workspaces`);
  }
  const values = rows.map((r) => ({
    repo: r.repo, base_sha: r.baseSha, app: r.app ?? null, env_id: r.envId, state: "requested", state_at: now, limits: JSON.stringify({ deadlineSec: deadline(r) }),
    owner: r.owner, created_at: now, updated_at: now, layout: r.ciCheckout && sizings.get(r.repo)?.warmTarget !== "none" ? WORKSPACE_LAYOUT_CI : 1,
  }));
  const ids: number[] = [];
  await db.write(async () => {
    for (const part of kx.batches(values)) ids.push(...(await q.all(k.insertInto("main.workspaces").values(part).returning("id"))).map((r) => Number(r.id)));
  });
  return ids;
}

/**
 * Compare-and-set moves: each row goes from one of `from` to `to` with `set`, `state_at` and `updated_at` at `now` (and `ended_at` for
 * `ended` and `failed`). Returns the ids that moved; one that was no longer in `from` (another pass, the CLI or an end got there first)
 * is absent, so a step that ran in the background never revives a row that ended meanwhile. One statement per distinct patch shape.
 */
export async function moveWorkspaces(db: Db, moves: WorkspaceMove[], now: string): Promise<Set<number>> {
  return await patchRows(db, "workspaces", moves.map((m) => ({
    id: m.id, from: m.from,
    set: { ...m.set, state: m.to, state_at: now, updated_at: now, ...(m.to === "ended" || m.to === "failed" ? { ended_at: now } : {}) },
  })), NUMERIC);
}

/**
 * Patches rows (`whereState` and the values of `where` are the compare-and-set); returns the number of rows changed. A row that sets the
 * checkpoint blob or has a `where` has its own statement.
 */
export async function patchWorkspaces(db: Db, rows: { id: number; whereState?: WorkspaceStateName[]; where?: Partial<Pick<WorkspaceRow, "pvc" | "pod" | "checkpoint_error" | "base_commit" | "restored_at">>; set: Partial<Omit<WorkspaceRow, "id">> }[]): Promise<number> {
  return (await patchRows(db, "workspaces", rows.map((r) => ({ id: r.id, ...(r.whereState ? { from: r.whereState } : {}), ...(r.where ? { where: r.where } : {}), set: r.set })), NUMERIC)).size;
}

/**
 * Binds a remote call to a live workspace in the caller's transaction (after `runners.enqueueCalls`). Throws a 409 when the workspace is
 * not live, or another call is bound to it and is queued or leased and is not the call's parent. 3 statements.
 */
export async function bindWorkspaceCall(db: Db, workspaceId: number, callId: number, o: { parentId?: number } = {}): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const ws = await q.get(q.k.selectFrom("main.workspaces").select(["id", "remote_call_id"]).where("id", "=", workspaceId).where("state", "in", LIVE_STATES));
    if (!ws) throw new WorkspaceError(409, `workspace ${workspaceId} is not live`);
    // Checked after the enqueue: a resumed job adopts its earlier call, which is then the one bound already.
    const bound = ws.remote_call_id === null ? null : Number(ws.remote_call_id);
    if (bound !== null && bound !== callId && bound !== o.parentId) {
      const other = (await loadCalls(db, [bound])).get(bound);
      if (other && (other.state === "queued" || other.state === "leased")) throw new WorkspaceError(409, `workspace ${workspaceId} is in use by call ${bound}, which is ${other.state}`);
    }
    await q.run(q.k.updateTable("main.workspaces").set({ remote_call_id: callId, updated_at: new Date().toISOString() }).where("id", "=", workspaceId));
  });
}

/** Takes the workspace's next `ws run` call number (`update ... returning`). Throws a 404 for a workspace that does not exist. */
export async function takeCallNumber(db: Db, id: number): Promise<number> {
  const q = queryDb(db);
  const r = await db.write(async () => await q.get(q.k.updateTable("main.workspaces").set((eb) => ({ next_call: eb("next_call", "+", 1) })).where("id", "=", id).returning("next_call")));
  if (!r) throw new WorkspaceError(404, `no workspace ${id}`);
  return Number(r.next_call) - 1;
}

/** The checkpoint blob; `alone`. */
export async function loadCheckpoint(db: Db, id: number): Promise<Uint8Array | null> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("main.workspaces").select("checkpoint").where("id", "=", id), { alone: true }))?.checkpoint ?? null;
}

/** How each workspace started its build dir: the stored `warm` JSON and the warm commit (null: a cold start). Workspaces that do not exist are absent. 1 statement. */
export async function loadWorkspaceWarm(db: Db, workspaceIds: number[]): Promise<Map<number, WarmNote>> {
  const out = new Map<number, WarmNote>();
  if (!workspaceIds.length) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("main.workspaces").select(["id", "warm", "warm_commit"]).where(kx.inList(db, "id", workspaceIds, "bigint")).orderBy("id"))) {
    out.set(Number(r.id), { warm: r.warm, warmCommit: r.warm_commit });
  }
  return out;
}
