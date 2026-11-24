// The `work` MCP server's tools. A session's tool call is a queued workspace_calls row; the job that owns the
// workspace runs it here, in the pod through `ws`, and writes the result to the row. The dashboard only relays
// (src/build/workspace-relay.ts).
//
// Everything the session sends goes into fixed argv data positions of a `ws` subcommand or onto stdin; only the shell
// tool's own command runs as `bash -c`, so a login profile never resets the image's PATH, in the pod. Output from the pod is decoded with replacement and stripped of
// control characters; images are only checked for their signature and size, never decoded.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";
import type { ExecOptions, KubeApi } from "./kube-api.ts";
import {
  ArgError, checkArgs, cutMiddle, FILE_MAX_BYTES, GLOB_LIMIT, IMAGE_EDGE, IMAGE_MAX_BYTES, imageMime, imageSize, isToolName, OUTPUT_CAP, podPath,
  READ_LINE_CHARS, seconds, SESSION_IMAGES, SRC_ROOT, TOOL_DEFINITIONS, WORK_ROOT, type Args, type Rect, type WorkspaceToolName,
} from "./workspace-tool-specs.ts";
import { FETCH_CALL_MS, fetchDependencies } from "./workspace-fetch.ts";
import { READY_LIMIT_MS } from "./workspace-launch.ts";
import { CALL_GRACE_MS, cleanOutput, execHelper, resumeWorkspace, takeCallNumber, type WsHeader, type WsRaw } from "./workspaces.ts";

/** The MCP server of a workspace session's tools. Claude Code reserves the name `workspace` and drops a server so named. */
export const WORKSPACE_SERVER = "work";

/** One image of a tool result: base64 PNG, JPEG, GIF or WebP, already scaled in the pod. */
export type ToolImage = { data: string; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" };
/** A workspace tool's result. `images` follow the text in the MCP reply's content. */
export type WorkspaceToolResult = { text: string; isError?: boolean; images?: ToolImage[] };

/** The MCP tool definitions (name, description, inputSchema, annotations) of the workspace server. */
export const WORKSPACE_TOOLS: readonly unknown[] = TOOL_DEFINITIONS;

/** Per-session limits, counted from the workspace's call rows so a job restart keeps them. */
export const SESSION_LIMITS = { calls: 2000, shellMs: 3 * 3600_000, execs: 4, background: 4 } as const;

/** The job's own deadline for an exec, past the pod's `timeout`: then it closes the stream and kills the command. */
const JOB_GRACE_MS = 15_000;
const SMALL_OUT = 64 * 1024;
const RUN_OUT = 256 * 1024;
/** Bytes of lines `ws read` returns at most (READ_CAP in the helper). */
const READ_BYTES = 128 * 1024;
/** A `--since` past any log's end: a status call that returns only the header. */
const NO_OUTPUT = "999999999999";

/**
 * The launcher's, the operator's and a job's own calls (execWs), and an agent workspace's patch setup and diff
 * (src/build/agent-workspaces.ts); every other row is a session tool call that counts.
 */
export const OWN_CALLS = ["seed", "checkpoint", "cli", "report", "agent-setup", "agent-diff"];
/** A killed command's process group gets this long after SIGTERM. */
const KILL_GRACE_MS = 5_000;
/** app_start's exec: the helper waits 30 s for the window, after up to 15 s for a display that had to start again. */
const APP_START_MS = 75_000;
const APP_STOP_MS = 30_000;
const SHOT_MS = 60_000;
const appLog = (n: number) => `${WORK_ROOT}/.ws/apps/${n}.log`;
/** How often a call waiting for its workspace to come back reads the row. */
const READY_POLL_MS = 3000;

/** Bookkeeping a call row's result carries, read back when a session is rebuilt. Numbers only, so SQL can read them. */
type Acct = { ms?: number; bytes?: number; bg?: 1; limit?: number; ref?: number; ended?: 0 | 1; images?: number };
type Out = WorkspaceToolResult & { acct?: Acct };
/**
 * A shell command whose time still counts: running ones, and background ones. Times are the job's: the pod's call files
 * are writable by the session, so what they say about a command is advisory (the pod's own limits are the hard bounds).
 * `n` is 0 until the call number is taken.
 */
type Cmd = { n: number; startMs: number; limitMs: number; endMs: number | null; background: boolean };

class Refused extends Error {}

const statusLine = (h: Extract<WsHeader, { kind: "status" }>): string =>
  h.state === "running" ? `running for ${seconds(h.ms)}` : h.state === "exited" ? `exited ${h.exit} after ${seconds(h.ms)}` : h.state === "timed-out" ? `timed out after ${seconds(h.ms)}` : `killed after ${seconds(h.ms)}`;

/** The text of a helper call that did not give the header the caller expected. */
const helperFailure = (r: WsRaw, what: string): Out => ({
  text: r.header?.kind === "error" ? `failed: ${what}: ${r.header.message || r.header.code}` : `failed: ${what}: ${r.error ?? "the workspace helper gave no answer"}${r.stderr ? `\n${r.stderr}` : ""}`,
  isError: true,
});

/** Runs at most `max` tasks at once, the rest in arrival order. */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  private async take(): Promise<void> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((r) => this.waiting.push(r));
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
  async run<T>(f: () => Promise<T>): Promise<T> {
    await this.take();
    try {
      return await f();
    } finally {
      this.release();
    }
  }
  /** Runs `f` holding every slot: after the tasks running now, before the ones that arrive later. */
  async runAll<T>(f: () => Promise<T>): Promise<T> {
    let held = 0;
    try {
      for (; held < this.max; held++) await this.take();
      return await f();
    } finally {
      for (; held > 0; held--) this.release();
    }
  }
}

/**
 * One session's tools on one workspace: argument checks, per-session limits, concurrency and the exec into the pod.
 * The owning job keeps one instance per workspace for the session's life. `call` settles the row itself: state
 * done (failed when the exec could not run) and `result` = the WorkspaceToolResult as JSON, plus `acct` bookkeeping.
 */
export class WorkspaceSession {
  readonly db: Db;
  readonly api: KubeApi;
  readonly workspaceId: number;
  private loaded: Promise<void> | null = null;
  /** Call rows that count toward the call limit. */
  private readonly counted = new Set<number>();
  private fgMs = 0;
  private readonly cmds = new Map<number, Cmd>();
  /** Log bytes of each shell call the session has seen, so shell_status returns only what is new. */
  private readonly seen = new Map<number, number>();
  private images = 0;
  private readonly gate = new Gate(SESSION_LIMITS.execs);
  private readonly pathLocks = new Map<string, Promise<void>>();
  /** The wait for the workspace to be ready that the session's calls share. */
  private ready: Promise<void> | null = null;

  constructor(db: Db, api: KubeApi, workspaceId: number) {
    this.db = db;
    this.api = api;
    this.workspaceId = workspaceId;
  }

  /** Runs tool `name` with `args` for the queued workspace_calls row `row` and returns its result; never throws for a tool error. */
  async call(name: string, args: unknown, row: number): Promise<WorkspaceToolResult> {
    await (this.loaded ??= this.load().catch((e: unknown) => {
      this.loaded = null;
      throw e;
    }));
    // A row that already has its result (a job restarted after settling it) is answered from it, never run again.
    const prior = await this.db.get(this.db.k.selectFrom("workspace_calls").select(["state", "result"]).where("id", "=", row).where("workspace_id", "=", this.workspaceId));
    const stored = prior && (prior.state === "done" || prior.state === "failed") ? storedResult(prior.result) : null;
    if (stored) return stored;
    let out: Out;
    let state: "done" | "failed" = "done";
    if (!this.counted.has(row) && this.counted.size >= SESSION_LIMITS.calls) {
      out = { text: `refused: the session's ${SESSION_LIMITS.calls} workspace tool calls are used up; submit your work`, isError: true };
    } else {
      this.counted.add(row);
      try {
        if (!isToolName(name)) throw new Refused(`there is no workspace tool ${JSON.stringify(name.slice(0, 64))}`);
        const checked = checkArgs(name, args);
        await (this.ready ??= this.untilReady().finally(() => { this.ready = null; }));
        out = await this.run(name, checked, row);
      } catch (e) {
        if (e instanceof Refused || e instanceof ArgError) out = { text: `refused: ${e.message}`, isError: true };
        else {
          state = "failed";
          out = { text: `failed: ${cleanOutput(Buffer.from(String(e instanceof Error ? e.message : e))).slice(0, 2000)}`, isError: true };
        }
      }
    }
    const { acct, ...result } = out;
    const at = new Date().toISOString();
    await this.db.run(this.db.k.updateTable("workspace_calls")
      .set((eb) => ({ state, result: JSON.stringify({ ...result, ...(acct ? { acct } : {}) }), started_at: eb.fn.coalesce("started_at", eb.val(at)), finished_at: at }))
      .where("id", "=", row).where("workspace_id", "=", this.workspaceId));
    await this.touch();
    return result;
  }

  /** Call counts, shell time and background commands from the workspace's rows. */
  private async load(): Promise<void> {
    const db = this.db;
    const rows = await db.all(db.k.selectFrom("workspace_calls")
      .select((eb) => {
        const res = eb.case().when(kx.jsonValid(db, "result")).then(eb.ref("result")).end();
        const arg = eb.case().when(kx.jsonValid(db, "args")).then(eb.ref("args")).end();
        const num = (path: string) => kx.jsonNum(db, res, `$.acct.${path}`);
        return ["id", "n", "tool", "state", "started_at", num("ms").as("ms"), num("bytes").as("bytes"), num("bg").as("bg"), num("limit").as("lim"), num("ref").as("ref"),
          num("ended").as("ended"), num("images").as("images"), kx.jsonBool(db, arg, "$.background").as("background"), kx.jsonNum(db, arg, "$.timeout_sec").as("timeout")] as const;
      })
      .where("workspace_id", "=", this.workspaceId).where("tool", "not in", OWN_CALLS).orderBy("id"));
    // Background commands a restart caught mid-launch: their limit was the time left when they started.
    const launching: Cmd[] = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (r.state !== "queued") this.counted.add(id);
      this.images += Number(r.images ?? 0);
      const startMs = r.started_at ? Date.parse(r.started_at) : Date.now();
      if (r.tool === "shell" && r.n !== null) {
        if (r.bg) this.cmds.set(id, { n: Number(r.n), startMs, limitMs: Number(r.lim ?? 0) * 1000, endMs: null, background: true });
        else if (r.state === "running" && Number(r.background) === 1) {
          const c: Cmd = { n: Number(r.n), startMs, limitMs: 0, endMs: null, background: true };
          this.cmds.set(id, c);
          launching.push(c);
        } else if (r.state === "running") this.cmds.set(id, { n: Number(r.n), startMs, limitMs: Number(r.timeout ?? 120) * 1000, endMs: null, background: false });
        else if (r.ms !== null) {
          this.fgMs += Number(r.ms);
          this.seen.set(id, Number(r.bytes ?? 0));
        }
      } else if ((r.tool === "shell_status" || r.tool === "shell_kill") && r.ref !== null) {
        const ref = Number(r.ref);
        const c = this.cmds.get(ref);
        if (c && Number(r.ended) === 1 && r.ms !== null) c.endMs = Number(r.ms);
        if (r.tool === "shell_status" && r.bytes !== null) this.seen.set(ref, Math.max(this.seen.get(ref) ?? 0, Number(r.bytes)));
      }
    }
    const used = this.usedMs();
    for (const c of launching) c.limitMs = Math.max(0, SESSION_LIMITS.shellMs - used);
  }

  /**
   * Returns once the workspace is ready. A parked one is resumed (a new pod, on its volume or rebuilt from the checkpoint);
   * one that is starting or seeding is waited for, up to the launcher's own limit.
   */
  private async untilReady(): Promise<void> {
    const from = Date.now();
    for (;;) {
      const w = await this.db.get(this.db.k.selectFrom("workspaces").select(["state", "error"]).where("id", "=", this.workspaceId));
      if (w?.state === "ready") return;
      if (!w || w.state === "ended" || w.state === "failed") throw new Refused(`the workspace is ${w?.state ?? "gone"}${w?.error ? ` (${w.error})` : ""}; submit your work`);
      if (w.state === "parked" && !await resumeWorkspace(this.db, this.workspaceId)) throw new Refused(`the workspace could not be resumed${w.error ? ` (${w.error})` : ""}; submit your work`);
      if (Date.now() - from > READY_LIMIT_MS) throw new Error(`the workspace did not come back within ${Math.round(READY_LIMIT_MS / 60_000)} min (still ${w.state})`);
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }

  private async touch(): Promise<void> {
    const at = new Date().toISOString();
    await this.db.run(this.db.k.updateTable("workspaces").set({ last_call_at: at, updated_at: at }).where("id", "=", this.workspaceId));
  }

  /** Marks the row running once its exec starts. */
  private async begin(row: number, timeoutMs: number, n: number | null = null): Promise<void> {
    const at = new Date();
    await this.db.run(this.db.k.updateTable("workspace_calls")
      .set((eb) => ({ state: "running", ...(n !== null ? { n } : {}), started_at: eb.fn.coalesce("started_at", eb.val(at.toISOString())), deadline_at: new Date(at.getTime() + timeoutMs + CALL_GRACE_MS).toISOString() }))
      .where("id", "=", row).where("workspace_id", "=", this.workspaceId));
    await this.touch();
  }

  private async exec(argv: string[], opts: ExecOptions): Promise<WsRaw> {
    return await execHelper(this.db, this.api, this.workspaceId, argv, opts);
  }

  /** Runs `f` holding the path's lock (writes and edits to one path never overlap), then an exec slot. */
  private async onPath<T>(path: string, f: () => Promise<T>): Promise<T> {
    const prev = this.pathLocks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const mine = prev.then(() => held);
    this.pathLocks.set(path, mine);
    await prev;
    try {
      return await this.gate.run(f);
    } finally {
      release();
      if (this.pathLocks.get(path) === mine) this.pathLocks.delete(path);
    }
  }

  private async run(name: WorkspaceToolName, a: Args, row: number): Promise<Out> {
    switch (name) {
      case "shell": return await this.gate.run(() => this.shell(a, row));
      case "shell_status": return await this.gate.run(() => this.shellStatus(a, row));
      case "shell_kill": return await this.gate.run(() => this.shellKill(a, row));
      case "read": return await this.gate.run(() => this.read(a, row));
      case "write": { const p = podPath(a.path as string); return await this.onPath(p, () => this.write(p, a, row)); }
      case "edit": { const p = podPath(a.path as string); return await this.onPath(p, () => this.edit(p, a, row)); }
      case "glob": return await this.gate.run(() => this.glob(a, row));
      case "grep": return await this.gate.run(() => this.grep(a, row));
      case "app_start": return await this.gate.run(() => this.appStart(a, row));
      case "app_stop": return await this.gate.run(() => this.appStop(a, row));
      case "screenshot": return await this.gate.run(() => this.screenshot(a, row));
      // Every exec slot: no foreground command or other call runs while cargo fetch rewrites Cargo.lock and CARGO_HOME.
      case "fetch_dependencies": return await this.gate.runAll(() => this.fetchDependencies(a, row));
    }
  }

  // ---- shell -------------------------------------------------------------------

  /** Shell time used; with `reserve`, running foreground commands count their whole limit, so parallel calls do not share the same remainder. */
  private usedMs(reserve = false, now = Date.now()): number {
    let ms = this.fgMs;
    for (const c of this.cmds.values()) ms += c.endMs ?? (reserve && !c.background ? c.limitMs : Math.min(Math.max(0, now - c.startMs), c.limitMs));
    return ms;
  }

  /** What command `c` is charged once the job sees it end: from its start to now, by the job's clock. */
  private ended(c: Cmd): number {
    c.endMs = Math.min(Math.max(0, Date.now() - c.startMs), c.limitMs + KILL_GRACE_MS);
    return c.endMs;
  }

  private runningBackground(): number {
    let k = 0;
    for (const c of this.cmds.values()) if (c.background && c.endMs === null) k++;
    return k;
  }

  /** Asks the pod which commands not seen ending have ended, for the limits. */
  private async refresh(): Promise<void> {
    for (const c of this.cmds.values()) {
      if (c.endMs !== null || c.n === 0) continue;
      const r = await this.exec(["status", String(c.n), "--since", NO_OUTPUT], { maxOut: SMALL_OUT, timeoutMs: 30_000 });
      if (r.header?.kind === "status" && r.header.state !== "running") this.ended(c);
      else if (r.header?.kind === "error" && r.header.code === "nocall") c.endMs = 0;
    }
  }

  private async shell(a: Args, row: number): Promise<Out> {
    const cwd = a.cwd !== undefined ? podPath(a.cwd as string, "cwd") : SRC_ROOT;
    const background = a.background === true;
    const attached = await this.reattach(a, row, background);
    if (attached) return attached;
    if (this.usedMs(true) >= SESSION_LIMITS.shellMs - 1000 || (background && this.runningBackground() >= SESSION_LIMITS.background)) await this.refresh();
    // No await from these checks until the command is in `cmds`, so parallel calls count each other.
    const leftSec = Math.floor((SESSION_LIMITS.shellMs - this.usedMs(true)) / 1000);
    if (leftSec < 1) throw new Refused(`the session's ${SESSION_LIMITS.shellMs / 3600_000} h of shell time are used up; submit your work`);
    if (background && this.runningBackground() >= SESSION_LIMITS.background) {
      throw new Refused(`${SESSION_LIMITS.background} background commands are running; wait for one with shell_status or end one with shell_kill`);
    }
    const limitSec = background ? leftSec : Math.min(Number(a.timeout_sec ?? 120), leftSec);
    const cmd: Cmd = { n: 0, startMs: Date.now(), limitMs: limitSec * 1000, endMs: null, background };
    this.cmds.set(row, cmd);
    const timeoutMs = background ? 30_000 : limitSec * 1000 + JOB_GRACE_MS;
    let r: WsRaw;
    try {
      cmd.n = await takeCallNumber(this.db, this.workspaceId);
      await this.begin(row, timeoutMs, cmd.n);
      const argv = ["run", String(cmd.n), String(limitSec), "--cwd", cwd, ...(background ? ["--background"] : []), "--", "bash", "-c", a.command as string];
      r = await this.exec(argv, { ...(a.stdin !== undefined ? { stdin: Buffer.from(a.stdin as string) } : {}), maxOut: RUN_OUT, timeoutMs });
    } catch (e) {
      this.cmds.delete(row);
      throw e;
    }
    if (background) {
      if (r.header?.kind === "started") return { text: JSON.stringify({ id: row }), acct: { bg: 1, limit: limitSec } };
      this.cmds.delete(row);
      return helperFailure(r, "the command did not start");
    }
    return await this.foregroundResult(row, cmd, r);
  }

  /** A shell row a restarted job already ran: picks the command up in the pod instead of running it again. */
  private async reattach(a: Args, row: number, background: boolean): Promise<Out | null> {
    const prior = await this.db.get(this.db.k.selectFrom("workspace_calls").select(["state", "n", "started_at"]).where("id", "=", row).where("workspace_id", "=", this.workspaceId));
    if (prior?.state !== "running" || prior.n === null) return null;
    const n = Number(prior.n);
    const st = await this.exec(["status", String(n), "--since", NO_OUTPUT], { maxOut: SMALL_OUT, timeoutMs: 30_000 });
    // Run again only when the pod never saw the command; an unclear answer must not run it twice.
    if (st.header?.kind === "error" && st.header.code === "nocall") return null;
    if (st.header?.kind !== "status") return helperFailure(st, "the command's state in the workspace is unknown, so it was not run again");
    if (background) return { text: JSON.stringify({ id: row }), acct: { bg: 1, limit: Math.round((this.cmds.get(row)?.limitMs ?? 0) / 1000) } };
    const startMs = prior.started_at ? Date.parse(prior.started_at) : Date.now();
    const cmd = this.cmds.get(row) ?? { n, startMs, limitMs: Number(a.timeout_sec ?? 120) * 1000, endMs: null, background: false };
    this.cmds.set(row, cmd);
    const deadline = cmd.startMs + cmd.limitMs + JOB_GRACE_MS;
    let h: WsHeader | null = st.header;
    while (h?.kind === "status" && h.state === "running" && Date.now() < deadline) {
      const wait = Math.min(300, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
      h = (await this.exec(["status", String(n), "--wait", String(wait), "--since", NO_OUTPUT], { maxOut: SMALL_OUT, timeoutMs: wait * 1000 + JOB_GRACE_MS })).header;
    }
    if (h?.kind === "status" && h.state === "running") await this.exec(["kill", String(n)], { maxOut: SMALL_OUT, timeoutMs: 30_000 });
    return await this.foregroundResult(row, cmd, await this.exec(["status", String(n)], { maxOut: RUN_OUT, timeoutMs: 30_000 }));
  }

  /** The result of a foreground command from its final status; one the job lost track of is killed first. */
  private async foregroundResult(row: number, cmd: Cmd, r: WsRaw): Promise<Out> {
    let note = "";
    if (r.header?.kind !== "status") {
      if (r.header?.kind === "error") {
        this.cmds.delete(row);
        return helperFailure(r, "the command did not run");
      }
      // The stream ended without the helper's answer (the job's deadline, a lost connection): stop the command and
      // report what it wrote.
      note = `\n[the exec stream ended early (${r.error ?? "no answer"}); the command was stopped]`;
      await this.exec(["kill", String(cmd.n)], { maxOut: SMALL_OUT, timeoutMs: 30_000 });
      r = await this.exec(["status", String(cmd.n)], { maxOut: RUN_OUT, timeoutMs: 30_000 });
      if (r.header?.kind !== "status") return helperFailure(r, "the command's state is unknown");
    }
    const h = r.header;
    this.cmds.delete(row);
    const ms = Math.max(h.ms, Date.now() - cmd.startMs);
    this.fgMs += ms;
    this.seen.set(row, h.bytes);
    const body = cleanOutput(cutMiddle(r.body, OUTPUT_CAP + 2048));
    return { text: `${statusLine(h)}${note}\n${body || "(no output)"}`, acct: { ms, bytes: h.bytes } };
  }

  /** The `ws` call number of shell call `id` of this workspace. */
  private async shellCall(id: number): Promise<number> {
    const r = await this.db.get(this.db.k.selectFrom("workspace_calls").select(["tool", "n"]).where("id", "=", id).where("workspace_id", "=", this.workspaceId));
    if (r?.tool !== "shell" || r.n === null) throw new Refused(`there is no shell call ${id} in this workspace`);
    return Number(r.n);
  }

  private async shellStatus(a: Args, row: number): Promise<Out> {
    const id = a.id as number;
    const n = await this.shellCall(id);
    const wait = Number(a.wait_sec ?? 0);
    const timeoutMs = wait * 1000 + JOB_GRACE_MS;
    await this.begin(row, timeoutMs);
    const r = await this.exec(["status", String(n), "--wait", String(wait), "--since", String(this.seen.get(id) ?? 0)], { maxOut: RUN_OUT, timeoutMs });
    if (r.header?.kind !== "status") return helperFailure(r, "no status");
    const h = r.header;
    const ended = h.state !== "running";
    const c = this.cmds.get(id);
    const ms = c && ended ? this.ended(c) : h.ms;
    this.seen.set(id, h.bytes);
    const body = cleanOutput(cutMiddle(r.body, OUTPUT_CAP + 2048));
    return { text: `${statusLine(h)}, ${h.bytes} bytes of output in all\n${body || "(no new output)"}`, acct: { ref: id, ms, bytes: h.bytes, ended: ended ? 1 : 0 } };
  }

  private async shellKill(a: Args, row: number): Promise<Out> {
    const id = a.id as number;
    const n = await this.shellCall(id);
    await this.begin(row, 30_000);
    const r = await this.exec(["kill", String(n)], { maxOut: SMALL_OUT, timeoutMs: 30_000 });
    if (r.header?.kind !== "status") return helperFailure(r, "no status");
    const h = r.header;
    const ended = h.state !== "running";
    const c = this.cmds.get(id);
    const ms = c && ended ? this.ended(c) : h.ms;
    return { text: statusLine(h), acct: { ref: id, ms, ended: ended ? 1 : 0 } };
  }

  // ---- dependencies --------------------------------------------------------------

  private async fetchDependencies(a: Args, row: number): Promise<Out> {
    const dir = a.path !== undefined ? podPath(a.path as string) : SRC_ROOT;
    // A call number marks the row as one a restarted job hands back to the session, which finds its fetch pod again.
    await this.begin(row, FETCH_CALL_MS, await this.callNumber(row));
    return await fetchDependencies(this.db, this.api, this.workspaceId, row, dir);
  }

  // ---- files -------------------------------------------------------------------

  private async read(a: Args, row: number): Promise<Out> {
    const p = podPath(a.path as string);
    const offset = Number(a.offset ?? 1);
    const limit = Number(a.limit ?? 2000);
    await this.begin(row, 60_000);
    const r = await this.exec(["read", p, String(offset), String(limit), String(IMAGE_EDGE)], { maxOut: IMAGE_MAX_BYTES + SMALL_OUT, timeoutMs: 60_000 });
    const h = r.header;
    if (h?.kind === "error") {
      if (h.code === "binary") {
        const [bytes, ...type] = h.message.split(" ");
        return { text: `${p} is a binary file (${bytes} bytes, ${type.join(" ")}); look at it with shell`, isError: true };
      }
      return { text: h.message || h.code, isError: true };
    }
    if (h?.kind !== "ok") return helperFailure(r, "read");
    if (h.fields[0] === "image") {
      if (this.images >= SESSION_IMAGES) throw new Refused(`the session's ${SESSION_IMAGES} images are used up`);
      const out = this.image(p, h.fields.slice(1).map(Number), r);
      if (out.images) {
        this.images++;
        out.acct = { images: 1 };
      }
      return out;
    }
    if (h.fields[0] !== "text") return helperFailure(r, "read");
    const total = Number(h.fields[1]);
    let body = r.body;
    // Past the helper's byte cap the last line may be partial: drop it and say where to read on.
    if (body.length >= READ_BYTES) body = body.subarray(0, body.lastIndexOf(0x0a) + 1);
    const lines = cleanOutput(body).split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (!lines.length) return { text: total === 0 ? `${p} is empty` : `${p} has ${total} lines; offset ${offset} is past the end` };
    const text = lines.map((l, i) => `${String(offset + i).padStart(6)}\t${l.length > READ_LINE_CHARS ? `${l.slice(0, READ_LINE_CHARS)} [line cut]` : l}`).join("\n");
    const last = offset + lines.length - 1;
    return { text: last < total ? `${text}\n[lines ${offset}-${last} of ${total}; read on with offset ${last + 1}]` : text };
  }

  private image(p: string, [bytes, w, hgt, ow, oh]: number[], r: WsRaw): Out {
    const b = r.body;
    if (r.truncated || b.length !== bytes) return { text: `failed: the image of ${p} was cut in transfer`, isError: true };
    const mime = imageMime(b);
    if (!mime) return { text: `failed: what the pod sent for ${p} is not a PNG, JPEG, GIF or WebP image`, isError: true };
    if (b.length > IMAGE_MAX_BYTES) return { text: `refused: the image of ${p} is ${b.length} bytes`, isError: true };
    const s = imageSize(b, mime);
    if (!s) return { text: `failed: the size of the image of ${p} cannot be read`, isError: true };
    if (Math.max(s.w, s.h) > IMAGE_EDGE) return { text: `failed: the image of ${p} was not scaled (${s.w}x${s.h})`, isError: true };
    const scaled = ow !== w || oh !== hgt;
    return { text: `${p}: ${mime}, ${ow}x${oh}${scaled ? ` (scaled from ${w}x${hgt})` : ""}, ${b.length} bytes`, images: [{ data: b.toString("base64"), mimeType: mime }] };
  }

  private async write(p: string, a: Args, row: number): Promise<Out> {
    await this.begin(row, 60_000);
    const r = await this.exec(["put", p], { stdin: Buffer.from(a.content as string), maxOut: SMALL_OUT, timeoutMs: 60_000 });
    if (r.header?.kind !== "ok") return helperFailure(r, `cannot write ${p}`);
    const [bytes, sha] = r.header.fields;
    return { text: `wrote ${bytes} bytes to ${p} (sha256 ${sha})` };
  }

  private async edit(p: string, a: Args, row: number): Promise<Out> {
    const from = a.old_string as string;
    const to = a.new_string as string;
    if (!from) throw new Refused("old_string is empty; use write to create or replace a whole file");
    if (from === to) throw new Refused("old_string and new_string are the same");
    await this.begin(row, 60_000);
    const cur = await this.exec(["cat", p, String(FILE_MAX_BYTES)], { maxOut: FILE_MAX_BYTES + SMALL_OUT, timeoutMs: 60_000 });
    const h = cur.header;
    if (h?.kind === "error" && h.code === "nofile") throw new Refused(`${h.message}; create it with write`);
    if (h?.kind === "error" && h.code === "toolarge") throw new Refused(`${p} is ${h.message}; edit files up to ${FILE_MAX_BYTES} bytes, or change it with shell`);
    if (h?.kind !== "ok") return helperFailure(cur, `cannot read ${p}`);
    const [bytes, sha] = h.fields;
    if (cur.truncated || cur.body.length !== Number(bytes) || createHash("sha256").update(cur.body).digest("hex") !== sha) return { text: `failed: ${p} was cut in transfer`, isError: true };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(cur.body);
    } catch {
      throw new Refused(`${p} is not UTF-8 text; change it with shell`);
    }
    if (text.includes("\0")) throw new Refused(`${p} is a binary file; change it with shell`);
    const replaced = replaceText(text, from, to, a.replace_all === true);
    if (typeof replaced === "string") throw new Refused(`${replaced} in ${p}`);
    const next = Buffer.from(replaced.text);
    if (next.length > FILE_MAX_BYTES) throw new Refused(`the edit would make ${p} larger than ${FILE_MAX_BYTES} bytes`);
    const put = await this.exec(["put", p, "--expect", sha!], { stdin: next, maxOut: SMALL_OUT, timeoutMs: 60_000 });
    if (put.header?.kind === "error" && put.header.code === "conflict") throw new Refused(`${p} changed while the edit ran; read it again and redo the edit`);
    if (put.header?.kind !== "ok") return helperFailure(put, `cannot write ${p}`);
    return { text: `replaced ${replaced.count} ${replaced.count === 1 ? "occurrence" : "occurrences"} in ${p}; ${put.header.fields[0]} bytes (sha256 ${put.header.fields[1]})` };
  }

  // ---- search ------------------------------------------------------------------

  /** `rg` in the pod with a line limit; the text of its output with what was cut noted. */
  private async rg(path: string, limit: number, rgArgs: string[], row: number, none: string, noun: string): Promise<Out> {
    await this.begin(row, 60_000 + JOB_GRACE_MS);
    const r = await this.exec(["rg", path, "60", String(limit), "--", ...rgArgs], { maxOut: OUTPUT_CAP + SMALL_OUT, timeoutMs: 60_000 + JOB_GRACE_MS });
    if (r.header?.kind === "error") return { text: r.header.message || r.header.code, isError: true };
    if (r.header?.kind !== "ok") return helperFailure(r, "search");
    const [rc, lines] = r.header.fields.map(Number) as [number, number];
    let body = r.body;
    const cut = body.length >= OUTPUT_CAP;
    if (cut) body = body.subarray(0, body.lastIndexOf(0x0a) + 1);
    const text = cleanOutput(body).replace(/\n$/, "");
    const timedOut = rc === 124 || rc === 137;
    if (rc === 1 && !text) return { text: none };
    if (rc !== 0 && rc !== 1 && rc !== 141 && !timedOut) return { text: text || `search failed with exit ${rc}`, isError: true };
    const shown = text ? text.split("\n").length : 0;
    const notes = [
      ...(timedOut ? ["the search hit its 60 s limit"] : []),
      ...(shown < lines ? [`${shown} of ${rc === 141 ? "more than " : ""}${lines} ${noun}${cut ? "; output cut at 30 KiB" : ""}`] : []),
    ];
    return { text: `${text}${notes.length ? `\n[${notes.join("; ")}]` : ""}` };
  }

  private async glob(a: Args, row: number): Promise<Out> {
    const dir = a.path !== undefined ? podPath(a.path as string) : SRC_ROOT;
    return await this.rg(dir, GLOB_LIMIT, ["--files", "--hidden", "--glob", a.pattern as string, "--glob", "!.git", "--sortr", "modified"], row, "no files match", "files, newest first");
  }

  private async grep(a: Args, row: number): Promise<Out> {
    const path = a.path !== undefined ? podPath(a.path as string) : SRC_ROOT;
    const mode = (a.output_mode as string | undefined) ?? "files_with_matches";
    const context = Number(a.context ?? 0);
    const args = [
      "--hidden",
      ...(a.glob !== undefined ? ["--glob", a.glob as string] : []), "--glob", "!.git",
      ...(a.type !== undefined ? ["--type", a.type as string] : []),
      ...(a.case_insensitive === true ? ["-i"] : []),
      ...(a.multiline === true ? ["-U", "--multiline-dotall"] : []),
      ...(mode === "files_with_matches" ? ["-l", "--sortr", "modified"] : mode === "count" ? ["-c", "--sort", "path"]
        : ["-n", "--sort", "path", "--max-columns", "2000", "--max-columns-preview", ...(context > 0 ? ["-C", String(context)] : [])]),
      "-e", a.pattern as string,
    ];
    return await this.rg(path, Number(a.head_limit ?? 250), args, row, "no matches", "lines");
  }

  // ---- apps --------------------------------------------------------------------

  /** Row `row`'s `ws` call number: the one it already has (a resumed job runs the row again), else a new one. */
  private async callNumber(row: number): Promise<number> {
    const r = await this.db.get(this.db.k.selectFrom("workspace_calls").select("n").where("id", "=", row).where("workspace_id", "=", this.workspaceId));
    return r?.n != null ? Number(r.n) : await takeCallNumber(this.db, this.workspaceId);
  }

  /** The `ws` call number of app `id` (its app_start row) of this workspace. */
  private async appCall(id: number): Promise<number> {
    const r = await this.db.get(this.db.k.selectFrom("workspace_calls").select(["tool", "n"]).where("id", "=", id).where("workspace_id", "=", this.workspaceId));
    if (r?.tool !== "app_start" || r.n === null) throw new Refused(`there is no app ${id} in this workspace`);
    return Number(r.n);
  }

  /** The app id (app_start row) of `ws` call number `n`. */
  private async appId(n: number): Promise<number | null> {
    const r = await this.db.get(this.db.k.selectFrom("workspace_calls").select("id").where("workspace_id", "=", this.workspaceId).where("tool", "=", "app_start").where("n", "=", n));
    return r ? Number(r.id) : null;
  }

  private async appStart(a: Args, row: number): Promise<Out> {
    const binary = podPath(a.binary as string, "binary");
    const env = Object.entries((a.env as Record<string, string> | undefined) ?? {}).map(([k, v]) => `${k}=${v}`);
    const n = await this.callNumber(row);
    await this.begin(row, APP_START_MS, n);
    const argv = ["app-start", String(n), String(a.scale ?? 1), binary, String(env.length), ...env, "--", ...((a.args as string[] | undefined) ?? [])];
    const r = await this.exec(argv, { maxOut: SMALL_OUT, timeoutMs: APP_START_MS });
    const h = r.header;
    if (h?.kind === "error") {
      if (h.code === "limit") throw new Refused(h.message);
      return { text: h.message || h.code, isError: true };
    }
    if (h?.kind !== "ok") return helperFailure(r, "the app did not start");
    const log = appLog(n);
    const [what, ...f] = h.fields;
    const tail = cleanOutput(r.body).replace(/\n$/, "");
    const restarted = f.at(-1) === "1" ? "\n[the display had stopped; it was started again, so earlier apps are gone]" : "";
    if (what === "app" && f.length === 7) {
      const [pid, window, x, y, w, hgt] = f;
      return { text: `${JSON.stringify({ app: row, pid: Number(pid), window, geometry: { x: Number(x), y: Number(y), w: Number(w), h: Number(hgt) }, log })}${restarted}` };
    }
    if (what === "exited") return { text: `the app exited with code ${f[0]} before it opened a window; the end of ${log}:\n${tail || "(empty)"}`, isError: true };
    if (what === "nowindow") {
      return { text: `${JSON.stringify({ app: row, pid: f[0] === "-" ? null : Number(f[0]), window: null, log })}${restarted}\n[no window after 30 s; the app runs on: look with screenshot, or end it with app_stop]\n${tail}` };
    }
    return helperFailure(r, "the app did not start");
  }

  private async appStop(a: Args, row: number): Promise<Out> {
    const id = a.app as number;
    const n = await this.appCall(id);
    await this.begin(row, APP_STOP_MS);
    const r = await this.exec(["app-stop", String(n), ...(a.force === true ? ["--force"] : [])], { maxOut: SMALL_OUT, timeoutMs: APP_STOP_MS });
    if (r.header?.kind !== "ok" || r.header.fields[0] !== "stopped") return helperFailure(r, `app ${id} did not stop`);
    const [, code, was] = r.header.fields;
    const tail = cleanOutput(r.body).replace(/\n$/, "");
    if (code === "-") return { text: `app ${id} did not stop after SIGKILL; the end of ${appLog(n)}:\n${tail || "(empty)"}`, isError: true };
    return { text: `app ${id} ${was === "1" ? "stopped" : "had already exited"}: exit code ${code}; the end of ${appLog(n)}:\n${tail || "(empty)"}` };
  }

  private async screenshot(a: Args, row: number): Promise<Out> {
    const target = a.app !== undefined ? await this.appCall(a.app as number) : 0;
    const region = a.region as Rect | undefined;
    // Taken before the exec, so parallel shots cannot pass the limit together; given back when no image comes.
    if (this.images >= SESSION_IMAGES) throw new Refused(`the session's ${SESSION_IMAGES} images are used up`);
    this.images++;
    let out: Out | undefined;
    try {
      out = await this.shot(target, region, Number(a.max_edge ?? IMAGE_EDGE), row);
      return out;
    } finally {
      if (!out?.images) this.images--;
    }
  }

  private async shot(target: number, region: Rect | undefined, maxEdge: number, row: number): Promise<Out> {
    const n = await this.callNumber(row);
    await this.begin(row, SHOT_MS, n);
    const argv = ["shot", String(n), String(target), String(maxEdge), ...(region ? ["--region", String(region.x), String(region.y), String(region.w), String(region.h)] : [])];
    const r = await this.exec(argv, { maxOut: IMAGE_MAX_BYTES + SMALL_OUT, timeoutMs: SHOT_MS });
    const h = r.header;
    if (h?.kind === "error") return { text: h.message || h.code, isError: true };
    if (h?.kind !== "ok" || h.fields[0] !== "shot" || h.fields.length !== 12) return helperFailure(r, "screenshot");
    const [, appN, window, x, y, w, hgt, ...img] = h.fields;
    const id = appN === "0" ? null : await this.appId(Number(appN));
    const what = appN === "0" ? `the screen (${w}x${hgt})` : `app ${id ?? `#${appN}`}, window ${window} (${w}x${hgt} at ${x},${y})`;
    const shot = this.image(`${WORK_ROOT}/.ws/shots/${n}.png`, img.map(Number), r);
    if (!shot.images) return shot;
    return { ...shot, text: `${what}${region ? `, region ${region.w}x${region.h} at ${region.x},${region.y}` : ""}: ${shot.text}`, acct: { images: 1 } };
  }
}

/** A settled row's result as the tool result it was; null when it is not one. */
function storedResult(json: string | null): WorkspaceToolResult | null {
  try {
    const r = JSON.parse(json ?? "null") as Partial<WorkspaceToolResult> | null;
    if (typeof r?.text !== "string") return null;
    return { text: r.text, ...(r.isError ? { isError: true } : {}), ...(Array.isArray(r.images) ? { images: r.images } : {}) };
  } catch {
    return null;
  }
}

/**
 * `text` with `from` replaced by `to`: every occurrence with `all`, else exactly one. A file with CRLF line ends also
 * matches `from` written with LF. Returns why when it refuses.
 */
export function replaceText(text: string, from: string, to: string, all: boolean): { text: string; count: number } | string {
  let parts = text.split(from);
  if (parts.length === 1 && text.includes("\r\n") && from.includes("\n") && !from.includes("\r")) {
    const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
    parts = text.split(crlf(from));
    to = crlf(to);
  }
  const count = parts.length - 1;
  if (count === 0) return "old_string is not found";
  if (count > 1 && !all) return `old_string is found ${count} times; give more context to pick one, or set replace_all`;
  return { text: parts.join(to), count };
}
