// Workspaces an operator's or maintainer's own agent opens through the MCP Connector (workspace_open and the workspace_*
// tools): a workspace pod with a checkout of a default-branch commit, the caller's patch applied, a virtual display and
// the session tools (shell, read, write, edit, glob, grep, app_start, screenshot, app_stop, fetch_dependencies).
//
// The dashboard queues each tool call as a workspace_calls row marked with the caller's login (agent_login) and waits for
// its result; the runner's AgentWorkspaceServer, which has the cluster's API, claims those rows and runs them on a
// WorkspaceSession, the same code a model session's calls run through. The launcher creates, parks, resumes and ends the
// pod as for any workspace: an idle one parks after IDLE_PARK_MS and the next call resumes it.
import type { Db } from "../db/index.ts";
import { audit } from "../dash/audit.ts";
import { patchProblem } from "../worker/patch.ts";
import { workspaceDiff } from "../implement/diff.ts";
import { BuildError } from "./envs.ts";
import { guardedApi, inClusterApi, type KubeApi } from "./kube-api.ts";
import { currentBase, knownBase } from "./mcp-builds.ts";
import { settingsOf } from "./pods.ts";
import { MAX_PATCH_BYTES } from "./tasks.ts";
import { IDLE_PARK_MS } from "./workspace-launch.ts";
import { CALL_CHANNEL, parseResult, REPLY_CHANNEL, stubImages } from "./workspace-relay.ts";
import { isToolName, SESSION_IMAGES, TOOL_DEFINITIONS, TOOL_NAMES } from "./workspace-tool-specs.ts";
import { SESSION_LIMITS, WorkspaceSession, type WorkspaceToolResult } from "./workspace-tools.ts";
import { capJson, createWorkspace, endWorkspace, getWorkspace, LIVE_STATES, type WorkspaceRow } from "./workspaces.ts";

export const OWNER_PREFIX = "agent:";
export const ownerOf = (login: string): string => `${OWNER_PREFIX}${login}`;
/** The login an agent workspace belongs to, or null for any other workspace. */
export const agentOf = (w: { owner: string | null }): string | null => (w.owner?.startsWith(OWNER_PREFIX) ? w.owner.slice(OWNER_PREFIX.length) : null);

/** The runner's own rows on an agent workspace: applying the caller's patch, and reading the diff. */
export const SETUP_TOOL = "agent-setup";
export const DIFF_TOOL = "agent-diff";
/** A workspace's session limits over its life, as a model session's (src/build/workspace-tools.ts SESSION_LIMITS, SESSION_IMAGES). */
export const LIMITS_NOTE = `${SESSION_LIMITS.calls} tool calls, ${SESSION_LIMITS.shellMs / 3600_000} h of shell time and ${SESSION_IMAGES} images per workspace`;
/** Live agent workspaces one login may hold. */
export const MAX_PER_LOGIN = 3;
export const HOURS = { min: 1, max: 24, default: 8 } as const;
/** Longest the dashboard waits for one call before answering that it still runs (workspace_result fetches it later). */
export const WAIT_SEC = { max: 900, default: 660 } as const;
const POLL_MS = 1000;
const SHA = /^[0-9a-f]{40}$/;
const iso = (): string => new Date().toISOString();

/** Kubernetes environments that take workspaces: enabled, not a warm writer, with workspace slots. */
export async function workspaceEnvs(db: Db): Promise<string[]> {
  const rows = await db.all(db.k.selectFrom("build_envs").select(["id", "settings"]).where("kind", "=", "kubernetes").where("enabled", "=", 1).orderBy("id"));
  return rows.filter((r) => { const s = settingsOf(r.settings); return !s.warmWriter && s.workspaceSlots > 0; }).map((r) => r.id);
}

export type OpenInput = { repo: string; base: string | null; patch?: string; envId?: string; hours: number; by: string };

/** The tool's arguments, or a BuildError(400). `repo` is checked by the caller. */
export function parseOpen(repo: string, raw: Record<string, unknown>, by: string): OpenInput {
  for (const k of Object.keys(raw)) if (!["repo", "base", "patch", "env", "hours", "format"].includes(k)) throw new BuildError(400, `unknown argument "${k}"`);
  if (raw.base !== undefined && raw.base !== null && (typeof raw.base !== "string" || !SHA.test(raw.base))) throw new BuildError(400, "base must be a full lowercase commit id (leave it out for the current default-branch head)");
  let patch: string | undefined;
  if (raw.patch !== undefined && raw.patch !== null && raw.patch !== "") {
    if (typeof raw.patch !== "string" || raw.patch.includes("\0")) throw new BuildError(400, "patch must be the text of a unified diff");
    if (Buffer.byteLength(raw.patch) > MAX_PATCH_BYTES) throw new BuildError(400, "patch is larger than 1 MiB; open a workspace on a default-branch commit closer to your tree");
    const problem = patchProblem(raw.patch);
    if (problem) throw new BuildError(400, `${problem} (binary files, symlinks and paths outside the tree cannot be sent; write them in the workspace instead)`);
    patch = raw.patch.endsWith("\n") ? raw.patch : `${raw.patch}\n`;
  }
  if (raw.env !== undefined && raw.env !== null && (typeof raw.env !== "string" || !/^[a-z][a-z0-9-]{2,31}$/.test(raw.env))) throw new BuildError(400, "env must be a build environment id");
  const hours = raw.hours ?? HOURS.default;
  if (!Number.isInteger(hours) || (hours as number) < HOURS.min || (hours as number) > HOURS.max) throw new BuildError(400, `hours must be a whole number from ${HOURS.min} to ${HOURS.max}`);
  return { repo, base: (raw.base as string | undefined) ?? null, ...(patch !== undefined && { patch }), ...(typeof raw.env === "string" && { envId: raw.env }), hours: hours as number, by };
}

/** Requests the workspace (the launcher starts it when its environment has a free slot) and queues the patch's setup; returns its id. */
export async function openWorkspace(db: Db, i: OpenInput): Promise<number> {
  const head = await currentBase(db, i.repo);
  if (!head) throw new BuildError(409, `AutoCraft has recorded no default-branch commit of ${i.repo} yet`);
  const base = i.base ?? head.sha;
  if (base !== head.sha && !await knownBase(db, i.repo, base)) throw new BuildError(400, `base must be a default-branch commit AutoCraft has seen; the current one is ${head.sha} (${head.branch})`);
  const envs = await workspaceEnvs(db);
  if (!envs.length) throw new BuildError(409, "no kubernetes build environment takes workspaces here (one needs workspace slots and must be enabled)");
  if (i.envId && !envs.includes(i.envId)) throw new BuildError(400, `${i.envId} takes no workspaces; these do: ${envs.join(", ")}`);
  if (!i.envId && envs.length > 1) throw new BuildError(400, `give env: ${envs.join(", ")} take workspaces`);
  const envId = i.envId ?? envs[0]!;
  return await db.write(async () => {
    const mine = await db.all(db.k.selectFrom("workspaces").select("id").where("owner", "=", ownerOf(i.by)).where("state", "in", LIVE_STATES));
    if (mine.length >= MAX_PER_LOGIN) throw new BuildError(429, `${i.by} already has ${mine.length} live workspaces (${mine.map((m) => m.id).join(", ")}); close one with workspace_close`);
    const id = await createWorkspace(db, { repo: i.repo, baseSha: base, envId, limits: { deadlineSec: i.hours * 3600 }, owner: ownerOf(i.by) });
    if (i.patch) await queueCall(db, id, SETUP_TOOL, { patch: i.patch }, i.by);
    await audit(db, i.by, "mcp-workspace-open", i.repo, { workspace: id, base, patchBytes: i.patch ? Buffer.byteLength(i.patch) : 0, hours: i.hours, via: "mcp" });
    return id;
  });
}

/** An agent workspace by id; 404 for any other workspace, so these tools reach nothing else. */
export async function agentWorkspace(db: Db, id: unknown): Promise<WorkspaceRow & { login: string }> {
  const n = typeof id === "number" ? id : typeof id === "string" && /^\d{1,12}$/.test(id) ? Number(id) : NaN;
  const w = Number.isInteger(n) ? await getWorkspace(db, n) : undefined;
  const login = w ? agentOf(w) : null;
  if (!w || !login) throw new BuildError(404, `no workspace ${String(id).slice(0, 40)} opened through the MCP Connector`);
  return { ...w, login };
}

/** Queues one call on the workspace for the runner's server; returns the row id. */
export async function queueCall(db: Db, workspaceId: number, tool: string, args: unknown, login: string): Promise<number> {
  const row = await db.get(db.k.insertInto("workspace_calls").values({
    workspace_id: workspaceId, run_id: null, tool, args: JSON.stringify(args ?? {}), state: "queued", created_at: iso(), agent_login: login,
  }).returning("id"));
  await db.notify(CALL_CHANNEL, String(workspaceId));
  return Number(row!.id);
}

/**
 * Waits up to `waitMs` for the call's result; null while it still runs (a call still queued then stays queued, so it runs
 * later and workspace_result reads it). `tick` is called about every 15 s, so the HTTP reply stays open behind proxies.
 */
export async function awaitCall(db: Db, id: number, o: { waitMs: number; signal?: AbortSignal; tick?: () => void }): Promise<WorkspaceToolResult | null> {
  const until = Date.now() + o.waitMs;
  let woken: (() => void) | null = null;
  const sub = db.listen(REPLY_CHANNEL, (p) => { if (p === null || p === String(id)) woken?.(); });
  let lastTick = Date.now();
  try {
    for (;;) {
      const r = await db.fresh(() => db.get(db.k.selectFrom("workspace_calls").select(["state", "result"]).where("id", "=", id)));
      if (!r) return { text: `call ${id} is gone`, isError: true };
      if ((r.state === "done" || r.state === "failed") && r.result) {
        const out = parseResult(r.result);
        if (out.images) await stubImages(db, id, r.result);
        return out;
      }
      if (Date.now() >= until || o.signal?.aborted) return null;
      if (o.tick && Date.now() - lastTick >= 15_000) { lastTick = Date.now(); o.tick(); }
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, Math.min(POLL_MS, Math.max(0, until - Date.now())));
        function done(): void { clearTimeout(t); woken = null; resolve(); }
        woken = done;
      });
    }
  } finally {
    sub?.off();
  }
}

export type CallSummary = { id: number; tool: string; state: string; createdAt: string; finishedAt: string | null; summary: string };
export type WorkspaceView = {
  id: number; repo: string; base: string; environment: string; state: string; owner: string;
  createdAt: string; lastCallAt: string | null; endsBy: string; error: string | null;
  /** The caller's patch: none, queued, applied, or failed with git's message. */
  patch: "none" | "queued" | "applied" | `failed: ${string}`;
  /** A ready workspace without a call for this long parks; the next call resumes it. */
  parksAfterIdleMin: number;
  recentCalls: CallSummary[];
};

const firstLine = (result: string | null): string => {
  if (!result) return "";
  try { return String((JSON.parse(result) as { text?: unknown }).text ?? "").split("\n", 1)[0]!.slice(0, 160); } catch { return ""; }
};

/** What a workspace's last setup row says about its patch. */
export function patchState(setup: { state: string; result: string | null } | undefined): WorkspaceView["patch"] {
  if (!setup) return "none";
  if (setup.state === "queued" || setup.state === "running") return "queued";
  const r = setup.result ? parseResult(setup.result) : null;
  // The shell tool's first line is its status: `exited 0 after 0.2 s` when git applied the patch.
  return r && !r.isError && r.text.startsWith("exited 0 ") ? "applied" : `failed: ${(r?.text ?? "no result").replace(/\s+/g, " ").slice(0, 300)}`;
}

export async function viewOf(db: Db, w: WorkspaceRow & { login: string }): Promise<WorkspaceView> {
  const calls = await db.all(db.k.selectFrom("workspace_calls").select(["id", "tool", "state", "created_at", "finished_at", "result"])
    .where("workspace_id", "=", w.id).where("agent_login", "is not", null).orderBy("id", "desc").limit(10));
  const setup = await db.get(db.k.selectFrom("workspace_calls").select(["state", "result"]).where("workspace_id", "=", w.id).where("tool", "=", SETUP_TOOL).orderBy("id", "desc").limit(1));
  const patch = patchState(setup);
  let deadlineSec = 4 * 3600;
  try { deadlineSec = (JSON.parse(w.limits) as { deadlineSec?: number }).deadlineSec ?? deadlineSec; } catch { /* the default */ }
  return {
    id: w.id, repo: w.repo, base: w.base_sha, environment: w.env_id, state: w.state, owner: w.login,
    createdAt: w.created_at, lastCallAt: w.last_call_at, endsBy: new Date(Date.parse(w.created_at) + deadlineSec * 1000).toISOString(), error: w.error,
    patch, parksAfterIdleMin: IDLE_PARK_MS / 60_000,
    recentCalls: calls.map((c) => ({ id: c.id, tool: c.tool, state: c.state, createdAt: c.created_at, finishedAt: c.finished_at, summary: firstLine(c.result) })),
  };
}

/** Agent workspaces in `repos`, newest first: the live ones, or all; one login's with `login`. */
export async function listWorkspaces(db: Db, f: { repos: string[]; all: boolean; login?: string; limit: number }): Promise<WorkspaceView[]> {
  if (!f.repos.length) return [];
  let q = db.k.selectFrom("workspaces").select("id").where("repo", "in", f.repos).where("owner", "like", `${OWNER_PREFIX}%`).orderBy("id", "desc").limit(Math.min(Math.max(1, f.limit), 50));
  if (!f.all) q = q.where("state", "in", LIVE_STATES);
  if (f.login) q = q.where("owner", "=", ownerOf(f.login));
  const out: WorkspaceView[] = [];
  for (const { id } of await db.all(q)) out.push(await viewOf(db, await agentWorkspace(db, id)));
  return out;
}

export async function closeWorkspace(db: Db, id: number): Promise<boolean> {
  const ended = await endWorkspace(db, id);
  // Calls nobody will run now: answered, so a waiting request returns.
  const refused = await db.all(db.k.updateTable("workspace_calls").set({ state: "failed", result: JSON.stringify({ text: "refused: the workspace was closed", isError: true }), finished_at: iso() })
    .where("workspace_id", "=", id).where("state", "=", "queued").where("agent_login", "is not", null).returning("id"));
  for (const r of refused) await db.notify(REPLY_CHANNEL, String(r.id));
  return ended;
}

/** The MCP tools that run one workspace tool: `workspace_<tool>`, the tool's own arguments plus `workspace` and `wait_sec`. */
export const WORKSPACE_TOOL_DEFINITIONS = (TOOL_DEFINITIONS as { name: string; description: string; inputSchema: { required: string[]; properties: Record<string, unknown> }; annotations: object }[]).map((t) => ({
  name: `workspace_${t.name}`,
  description: `${t.description} Runs in the workspace workspace_open gave.`,
  inputSchema: {
    type: "object", additionalProperties: false, required: ["workspace", ...t.inputSchema.required],
    properties: {
      workspace: { type: "integer", description: "The workspace id workspace_open gave." },
      ...t.inputSchema.properties,
      wait_sec: { type: "integer", minimum: 0, maximum: WAIT_SEC.max, description: `Seconds to wait for the result (default ${WAIT_SEC.default}); past it the answer names the call, and workspace_result reads it.` },
    },
  },
  annotations: t.annotations,
}));

/** The workspace tool a `workspace_<tool>` MCP tool runs, or null. */
export function toolOf(mcpName: string): string | null {
  if (!mcpName.startsWith("workspace_")) return null;
  const t = mcpName.slice("workspace_".length);
  return isToolName(t) ? t : null;
}
export { TOOL_NAMES };

// ---- the runner's side ------------------------------------------------------------

type Session = Pick<WorkspaceSession, "call">;
type Row = { id: number; workspace_id: number; tool: string; args: string; n?: number | null };

const parseArgs = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
const refusal = (why: string): WorkspaceToolResult => ({ text: `refused: ${why}`, isError: true });

/**
 * Runs the queued calls of agent workspaces, in the runner, which can exec in the pods. A workspace's patch setup runs
 * before its other calls; the others run side by side on the workspace's session, which holds the per-session limits
 * and queues beyond its own exec limit, and settles each row.
 */
export class AgentWorkspaceServer {
  readonly db: Db;
  readonly api: KubeApi | null;
  readonly log: (line: string) => void;
  readonly #sessions = new Map<number, Session>();
  readonly #running = new Set<number>();
  readonly sessionOf: (id: number) => Session;

  constructor(db: Db, api: KubeApi | null, log: (line: string) => void, sessionOf?: (id: number) => Session) {
    this.db = db;
    this.api = api;
    this.log = log;
    this.sessionOf = sessionOf ?? ((id) => {
      let s = this.#sessions.get(id);
      if (!s) this.#sessions.set(id, s = api ? new WorkspaceSession(db, api, id) : { call: async () => refusal("the runner is not in the cluster, so it cannot reach the workspace") });
      return s;
    });
  }

  /** At start: rows an earlier runner left running. A shell command the session started is handed back to it (it re-attaches); any other is failed, since its outcome is unknown. */
  async recover(): Promise<void> {
    const left = await this.db.all(this.db.k.selectFrom("workspace_calls").select(["id", "workspace_id", "tool", "args", "n"]).where("state", "=", "running").where("agent_login", "is not", null).orderBy("id"));
    for (const r of left) {
      if (r.n !== null && isToolName(r.tool)) this.#run(r);
      else if (await this.#settle(r.id, "failed", { text: "failed: the runner restarted while this call ran, so its outcome is unknown; check the workspace and call it again", isError: true })) await this.db.notify(REPLY_CHANNEL, String(r.id));
    }
  }

  /** Claims and starts the queued calls; returns how many started. */
  async serve(): Promise<number> {
    const { db } = this;
    const rows = await db.all(db.k.selectFrom("workspace_calls as c").innerJoin("workspaces as w", "w.id", "c.workspace_id")
      .select(["c.id", "c.workspace_id", "c.tool", "c.args"]).where("c.state", "=", "queued").where("c.agent_login", "is not", null)
      .where("w.owner", "like", `${OWNER_PREFIX}%`).orderBy("c.id"));
    if (!rows.length) return 0;
    // Each workspace's newest setup: its other calls wait while it runs, and are refused when the patch did not apply, so
    // nothing builds or tests a tree that is not the caller's.
    const setups = new Map<number, WorkspaceView["patch"]>();
    for (const r of await db.all(db.k.selectFrom("workspace_calls").select(["workspace_id", "state", "result"]).where("tool", "=", SETUP_TOOL)
      .where("workspace_id", "in", [...new Set(rows.map((r) => r.workspace_id))]).orderBy("id"))) setups.set(r.workspace_id, patchState(r));
    let started = 0;
    for (const r of rows) {
      if (this.#running.has(r.id)) continue;
      const patch = setups.get(r.workspace_id) ?? "none";
      if (r.tool !== SETUP_TOOL && patch === "queued") continue;
      if (r.tool !== SETUP_TOOL && r.tool !== DIFF_TOOL && patch.startsWith("failed")) {
        if (await this.#settle(r.id, "failed", refusal(`the workspace's patch did not apply (${patch.slice("failed: ".length, 200)}); close it and open a new one with a patch against its base`))) await db.notify(REPLY_CHANNEL, String(r.id));
        continue;
      }
      const claimed = await db.run(db.k.updateTable("workspace_calls").set({ state: "running", started_at: iso(), args: JSON.stringify(capJson(parseArgs(r.args) ?? {})) })
        .where("id", "=", r.id).where("state", "=", "queued"));
      if (Number(claimed.changes) !== 1) continue;
      this.#run(r);
      started++;
    }
    return started;
  }

  #run(r: Row): void {
    this.#running.add(r.id);
    const args = parseArgs(r.args);
    void (async () => {
      try {
        if (r.tool === SETUP_TOOL) {
          const patch = (args as { patch?: unknown } | null)?.patch;
          if (typeof patch !== "string") await this.#settle(r.id, "failed", refusal("the setup has no patch"));
          // The shell result says whether git applied it. A WorkspaceSession has settled the row already; the conditional settle keeps its result.
          else await this.#settle(r.id, "done", await this.sessionOf(r.workspace_id).call("shell", { command: "git apply --whitespace=nowarn -", stdin: patch, timeout_sec: 300 }, r.id));
        } else if (r.tool === DIFF_TOOL) {
          const d = this.api ? await workspaceDiff(this.db, this.api, r.workspace_id) : { ok: false as const, reason: "the runner is not in the cluster, so it cannot reach the workspace" };
          await this.#settle(r.id, d.ok ? "done" : "failed", d.ok ? { text: d.diff } : { text: `failed: ${d.reason}`, isError: true });
        } else {
          await this.#settle(r.id, "done", await this.sessionOf(r.workspace_id).call(r.tool, args, r.id));
        }
      } catch (e) {
        await this.#settle(r.id, "failed", { text: `failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, isError: true });
      }
      await this.db.notify(REPLY_CHANNEL, String(r.id));
    })().catch(() => { /* the database is closed: the process is ending */ }).finally(() => this.#running.delete(r.id));
  }

  async #settle(id: number, state: "done" | "failed", res: WorkspaceToolResult): Promise<boolean> {
    const r = await this.db.run(this.db.k.updateTable("workspace_calls").set({ state, result: JSON.stringify(res), finished_at: iso() })
      .where("id", "=", id).where("state", "in", ["queued", "running"]));
    return Number(r.changes) === 1;
  }

  /** Calls running on the sessions now. */
  get running(): number {
    return this.#running.size;
  }
}

/** Serves agent workspace calls until `signal` aborts. Started by the runner next to the pod launcher; `guard` is the leader fence. */
export function startAgentWorkspaces(db: Db, signal: AbortSignal, log: (line: string) => void, guard?: () => Promise<void>): void {
  const cluster = inClusterApi();
  const api = cluster && guard ? guardedApi(cluster, guard) : cluster;
  const server = new AgentWorkspaceServer(db, api, log);
  let wake: (() => void) | null = null;
  const sub = db.listen(CALL_CHANNEL, () => wake?.());
  signal.addEventListener("abort", () => { sub?.off(); wake?.(); }, { once: true });
  void (async () => {
    try {
      await server.recover();
    } catch (e) {
      log(`agent workspaces: recover: ${(e as Error).stack ?? e}`);
    }
    while (!signal.aborted) {
      try {
        await server.serve();
      } catch (e) {
        log(`agent workspaces: ${(e as Error).stack ?? e}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, POLL_MS);
        function done(): void { clearTimeout(t); wake = null; resolve(); }
        wake = done;
      });
    }
  })();
}
