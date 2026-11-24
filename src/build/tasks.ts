// Build tasks: created by pipeline steps, claimed by workers that pull, run
// on the worker, and reported back. Everything a worker sends is stored as
// data; nothing here executes it, renders it or puts it in a prompt.
import { createHash } from "node:crypto";
import { currentJobId } from "../agents/call.ts";
import type { ItemShown, BuildSummary, BuildTask, BuildTaskDetail, Capabilities, Requires, SandboxEnv, TaskArtifact, TaskBatch, TaskFilter, TaskPage, TaskResult, TaskState, TaskStep } from "../../web/src/api/types.ts";
import { audit } from "../dash/audit.ts";
import { excludeHiddenExpr } from "../dash/api/visible.ts";
import { shownLookup, shownMap } from "../dash/api/shown.ts";
import { removeArtifacts } from "./artifacts.ts";
import { BuildError, slotsOf } from "./envs.ts";
import { draining } from "./worker-update.ts";
import { baseScopeRepos } from "../pilot.ts";
import { fastTask } from "../fasttrack.ts";
import { featureOn } from "./features.ts";
import { settingsOf } from "./pods.ts";
import { warmClaim } from "./warm-queue.ts";
import { slugOf } from "../owners.ts";
import { mapSeq } from "../async-seq.ts";
import type { AliasableExpression, SqlBool } from "kysely";
import type { Db } from "../db/index.ts";
import { cols, inList, ref, type Eb, type Ex } from "../db/kx.ts";

export const LOST_AFTER_MS = 2 * 60_000;
/** A task is claimed at most this often: the first time and one requeue after a lost worker. */
export const MAX_ATTEMPTS = 2;
export const MAX_QUEUED = 500;
/** Task rows and logs are kept ten years, like jobs; artifacts (built binaries) 30 days. */
export const KEEP_MS = 3650 * 24 * 3600_000;
export const ARTIFACT_KEEP_MS = 30 * 24 * 3600_000;
export const MAX_LOG_BYTES = 20 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const LOG_TAIL_BYTES = 64 * 1024;
export const TERMINAL: TaskState[] = ["done", "failed", "cancelled", "lost"];

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const STEP_NAME_RE = /^[A-Za-z0-9 ._:-]{1,64}$/;
const GLOB_RE = /^[A-Za-z0-9._*?/{},-]{1,200}$/;
const nowIso = (): string => new Date().toISOString();

type TaskRow = {
  id: number; job_id: number | null; step: string; repo: string; number: number | null; head_sha: string; base_sha: string | null;
  requires: string; priority: number; plan: string; state: TaskState; env_id: string | null; attempts: number;
  queued_at: string; claimed_at: string | null; started_at: string | null; ended_at: string | null; heartbeat_at: string | null;
  cancel_requested_at: string | null; results: string; summary: string | null; log_bytes: number; artifact_bytes: number;
  patch?: string | null; warm_key?: string | null; warm_role?: string | null; sandbox_env?: string | null; warm_image?: string | null; warm_version?: string | null;
  env_label?: string | null; default_branch?: string | null;
};

const json = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export type NewTask = {
  jobId?: number | null; step: string; repo: string; number?: number | null; headSha: string; baseSha?: string | null;
  requires?: Requires; priority?: number; plan: TaskStep[];
  /** Unified git diff applied to the checkout before the plan runs. */
  patch?: string;
  /** Tasks of one repo share a build cache under `key`: `build` fills it, `use` reads it. */
  warm?: Warm;
  /** A warm producer task: the toolchain image it was queued with. */
  warmImage?: string;
  warmVersion?: string;
};

export type Warm = { key: string; role: "use" | "build" };
/** The step of the warm producer's builds (src/build/warm-queue.ts): only a `warmWriter` environment takes them, and it takes nothing else. */
export const WARM_STEP = "warm";
export const MAX_PATCH_BYTES = 1024 * 1024;
/** A warm-cache key for a repo name: a readable slug (at most 49 characters) and a hash of the lowercased name, so distinct names never share a key; always valid. */
export function warmKeyOf(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 49).replace(/-+$/, "") || "repo";
  return `${slug}-${createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 14)}`;
}
const WARM_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseWarm(v: unknown): Warm {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "key" && k !== "role")) throw new BuildError(400, "warm must be { key, role }");
  if (typeof o.key !== "string" || !WARM_KEY_RE.test(o.key)) throw new BuildError(400, "warm.key is not valid");
  if (o.role !== "use" && o.role !== "build") throw new BuildError(400, "warm.role must be use or build");
  return { key: o.key, role: o.role };
}

export function parsePatch(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new BuildError(400, "patch must be a non-empty string");
  if (Buffer.byteLength(v) > MAX_PATCH_BYTES) throw new BuildError(400, "patch is larger than 1 MiB");
  if (v.includes("\0")) throw new BuildError(400, "patch must be text");
  return v;
}

export function parseRequires(v: unknown): Requires {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BuildError(400, "requires must be an object");
  const o = v as Record<string, unknown>;
  const out: Requires = {};
  for (const [k, x] of Object.entries(o)) {
    if (k === "os" && ["linux", "macos", "windows"].includes(x as string)) out.os = x as Capabilities["os"];
    else if (k === "arch" && ["x86_64", "aarch64"].includes(x as string)) out.arch = x as Capabilities["arch"];
    else if ((k === "display" || k === "gpu") && typeof x === "boolean") out[k] = x;
    else if ((k === "minMemGb" || k === "minDiskGb") && typeof x === "number" && x >= 0 && x <= 1e7) out[k] = x;
    else if (k === "toolchains" && Array.isArray(x) && x.length <= 40 && x.every((t) => typeof t === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(t))) out.toolchains = x as string[];
    else throw new BuildError(400, `requires.${k} is not valid`);
  }
  return out;
}

export function parsePlan(v: unknown): TaskStep[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) throw new BuildError(400, "plan must list 1 to 20 steps");
  return v.map((s, i): TaskStep => {
    const o = s as Record<string, unknown> | null;
    const where = `plan[${i}]`;
    if (!o || typeof o !== "object") throw new BuildError(400, `${where} must be an object`);
    if (typeof o.name !== "string" || !STEP_NAME_RE.test(o.name)) throw new BuildError(400, `${where}.name is not valid`);
    if (!Array.isArray(o.cmd) || o.cmd.length < 1 || o.cmd.length > 64 || o.cmd.some((a) => typeof a !== "string" || a.length > 8192 || a.includes("\0"))) throw new BuildError(400, `${where}.cmd must be 1 to 64 strings`);
    if (o.network !== "fetch" && o.network !== "none" && o.network !== "mirror") throw new BuildError(400, `${where}.network must be fetch, none or mirror`);
    if (typeof o.timeoutSec !== "number" || !Number.isInteger(o.timeoutSec) || o.timeoutSec < 1 || o.timeoutSec > 7200) throw new BuildError(400, `${where}.timeoutSec must be 1 to 7200`);
    const step: TaskStep = { name: o.name, cmd: o.cmd as string[], network: o.network, timeoutSec: o.timeoutSec };
    if (o.artifacts !== undefined) {
      if (!Array.isArray(o.artifacts) || o.artifacts.length > 20 || o.artifacts.some((g) => typeof g !== "string" || !GLOB_RE.test(g) || g.startsWith("/") || g.split("/").includes(".."))) throw new BuildError(400, `${where}.artifacts must be up to 20 relative globs`);
      step.artifacts = o.artifacts as string[];
    }
    if (o.bare !== undefined) {
      if (typeof o.bare !== "boolean") throw new BuildError(400, `${where}.bare must be a boolean`);
      if (o.bare) step.bare = true;
    }
    return step;
  });
}

/** Queues a task. Used by pipeline steps and the CLI; the source is fetched by sha, so it must be a full commit id. */
export async function createTask(db: Db, t: NewTask): Promise<number> {
  if (typeof t.step !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(t.step)) throw new BuildError(400, "step is not valid");
  if (typeof t.repo !== "string" || !REPO_RE.test(t.repo)) throw new BuildError(400, "repo is not valid");
  if (!SHA_RE.test(t.headSha)) throw new BuildError(400, "headSha must be a full lowercase commit id");
  if (t.baseSha != null && !SHA_RE.test(t.baseSha)) throw new BuildError(400, "baseSha must be a full lowercase commit id");
  if (t.number != null && (!Number.isInteger(t.number) || t.number < 1)) throw new BuildError(400, "number is not valid");
  const priority = t.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new BuildError(400, "priority must be -100 to 100");
  const requires = parseRequires(t.requires);
  const plan = parsePlan(t.plan);
  const patch = t.patch === undefined ? null : parsePatch(t.patch);
  const warm = t.warm === undefined ? null : parseWarm(t.warm);
  const queued = (await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", "queued")))!.n;
  if (queued >= MAX_QUEUED) throw new BuildError(429, `${MAX_QUEUED} tasks are already queued`);
  const r = await db.get(db.k.insertInto("build_tasks").values({
    job_id: t.jobId ?? currentJobId(), step: t.step, repo: t.repo, number: t.number ?? null, head_sha: t.headSha, base_sha: t.baseSha ?? null,
    requires: JSON.stringify(requires), priority, plan: JSON.stringify(plan), state: "queued", queued_at: nowIso(),
    patch, warm_key: warm?.key ?? null, warm_role: warm?.role ?? null, warm_image: t.warmImage ?? null, warm_version: t.warmVersion ?? null,
  }).returning("id"));
  return r!.id;
}

/** Whether an environment with these capabilities can run a task with these requirements. */
export function satisfies(caps: Capabilities, req: Requires): boolean {
  if (req.os && caps.os !== req.os) return false;
  if (req.arch && caps.arch !== req.arch) return false;
  if (req.display && !caps.display) return false;
  if (req.gpu && !caps.gpu) return false;
  if (req.toolchains && !req.toolchains.every((t) => caps.toolchains.includes(t))) return false;
  if (req.minMemGb !== undefined && caps.memGb < req.minMemGb) return false;
  if (req.minDiskGb !== undefined && caps.diskGb < req.minDiskGb) return false;
  return true;
}

export type ClaimedTask = { id: number; repo: string; headSha: string; baseSha: string | null; requires: Requires; plan: TaskStep[]; sourceUrl: string; patch?: string; warm?: Warm };
export type ClaimResult = { tasks: ClaimedTask[]; cancel: number[] };

/**
 * Ids of this environment's tasks that an operator cancelled and whose containers the worker may still be running.
 * A cancel ends the task at once; the worker kills its containers and does not report back, so the id is
 * repeated for LOST_AFTER_MS after the cancel.
 */
export async function cancelIds(db: Db, envId: string): Promise<number[]> {
  const since = new Date(Date.now() - LOST_AFTER_MS).toISOString();
  return (await db.all(db.k.selectFrom("build_tasks").select("id").where("env_id", "=", envId).where("cancel_requested_at", ">", since).orderBy("id"))).map((r) => r.id);
}

/** Builds an operator or maintainer starts from their agent (src/build/mcp-builds.ts): their own command lines and patch. */
export const MCP_BUILD_STEP = "mcp-build";
/** The task builds code from a PR (its head, or an integration branch of PRs) or a build an operator or maintainer started from their agent, which may be a PR's code too. */
const runsPrCode = (t: { step: string; number: number | null }): boolean => t.step === "pr-build" || t.step === "merge-batch" || t.step === MCP_BUILD_STEP || t.number !== null;

/**
 * Whether an environment has room for a task it would claim (the pod launcher's cluster capacity): "fit" claims it,
 * "stop" ends claiming for now (no later task is taken in its place, so priority order holds), "skip" passes over a task
 * this environment can never run but another may, and `fail` ends the task at once with that summary (no environment can run it).
 */
export type ClaimFit = (t: { id: number; repo: string; step: string; warmKey: string | null; requires: Requires }) => Promise<"fit" | "stop" | "skip" | { fail: string }>;

/**
 * Hands out queued tasks to an environment that has `free` slots: the oldest of the highest priority
 * whose requirements it meets, at most min(free, its slots minus the tasks it is running). A disabled,
 * paused or unreported environment gets none. One write transaction, so two environments never get the same task.
 * With `fit`, its slots are only the ceiling (not the slots it reported) and `fit` decides each task.
 */
export async function claim(db: Db, envId: string, free: number, nowMs: number = Date.now(), fit?: ClaimFit): Promise<ClaimResult> {
  await reapLost(db, nowMs);
  const tasks = await db.write(async () => {
    const env = await db.get(db.k.selectFrom("build_envs").select(["enabled", "kind", "slots", "reported_slots", "capabilities", "paused_reason", "confidential", "settings"]).where("id", "=", envId));
    const caps = env?.capabilities ? json<Capabilities | null>(env.capabilities, null) : null;
    const kube = env?.kind === "kubernetes" ? settingsOf(env.settings) : null;
    const out: ClaimedTask[] = [];
    if (env && env.enabled === 1 && caps && !env.paused_reason && !await draining(db, env.kind) && Number.isInteger(free) && free > 0) {
      const running = (await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("env_id", "=", envId).where("state", "in", ["claimed", "running"])))!.n;
      const room = Math.min(free, (fit ? env.slots : slotsOf(env)) - running);
      if (room > 0) {
        const queued = await db.all(db.k.selectFrom("build_tasks").select(cols("build_tasks")).$narrowType<{ state: TaskState }>().where("state", "=", "queued").orderBy("priority", "desc").orderBy("id").limit(500));
        const scope = await baseScopeRepos(db);
        const at = new Date(nowMs).toISOString();
        for (const t of queued) {
          if (out.length >= room) break;
          if (!satisfies(caps, json<Requires>(t.requires, {}))) continue;
          // The warm producer builds trusted default-branch heads with the cache's write credentials: it takes nothing else, and nothing else takes its builds.
          if (!!kube?.warmWriter !== (t.step === WARM_STEP)) continue;
          // A worker's warm build fills its own warm dirs; build pods have none.
          if (kube && t.warm_role === "build" && t.step !== WARM_STEP) continue;
          let plan = json<TaskStep[]>(t.plan, []);
          if (plan.some((s) => s.network === "mirror") && !kube?.crateMirror) continue;
          // Untrusted-code builds run only while their feature's switch is on for the repo.
          // A worker that holds the warm-snapshot signing key runs only default-branch code as it is: no PR, no patch, no merge batch.
          if (caps.warmSigner && (runsPrCode(t) || !!t.patch)) continue;
          // A security finding's private tasks go only to environments an operator marked confidential, which take no PR code.
          if (env.confidential === 1 ? runsPrCode(t) : PRIVATE_STEPS.includes(t.step)) continue;
          // The CI gate of a PR build comes from its base commit.
          if (t.step === "pr-build" && t.base_sha === null) continue;
          if (t.step === "pr-build" && !await featureOn(db, "pr-builds", t.repo)) continue;
          if (t.step === "nightly" && !await featureOn(db, "nightly", t.repo)) continue;
          if (t.step === "screenshot" && !await featureOn(db, "screenshots", t.repo)) continue;
          // Operator smoke tests, builds operators and maintainers start from their agents and the security fix's builds (an operator's request, under the finding's real repo) run anywhere; pipeline builds only for repos in scope, or for fast-tracked items of any repo.
          if (t.step !== "smoke-test" && t.step !== "fix-check" && t.step !== MCP_BUILD_STEP && !scope.has(t.repo) && !await fastTask(db, t)) continue;
          // A warm build waits for its repo's interval and takes the newest default-branch head, with the plan this environment runs.
          let head = t.head_sha, base = t.base_sha;
          if (t.step === WARM_STEP) {
            const w = await warmClaim(db, t.repo, kube!, nowMs);
            if (!w) continue;
            [head, base, plan] = [w.head, w.head, w.plan];
          }
          if (fit) {
            const f = await fit({ id: t.id, repo: t.repo, step: t.step, warmKey: t.warm_key, requires: json<Requires>(t.requires, {}) });
            if (f === "stop") break;
            if (f === "skip") continue;
            if (f !== "fit") {
              await db.run(db.k.updateTable("build_tasks").set({ state: "failed", ended_at: at, summary: f.fail.slice(0, 300) }).where("id", "=", t.id).where("state", "=", "queued"));
              continue;
            }
          }
          await db.run(db.k.updateTable("build_tasks").set((eb) => ({
            state: "claimed", env_id: envId, attempts: eb("attempts", "+", 1), claimed_at: at, heartbeat_at: at,
            ...(t.step === WARM_STEP ? { head_sha: head, base_sha: base, plan: JSON.stringify(plan) } : {}),
          })).where("id", "=", t.id).where("state", "=", "queued"));
          out.push({
            id: t.id, repo: t.repo, headSha: head, baseSha: base, requires: json<Requires>(t.requires, {}), plan,
            sourceUrl: `https://codeload.github.com/${slugOf(t.repo)}/tar.gz/${head}`,
            ...(t.patch ? { patch: t.patch } : {}),
            ...(t.warm_key && (t.warm_role === "use" || t.warm_role === "build") ? { warm: { key: t.warm_key, role: t.warm_role } } : {}),
          });
        }
      }
    }
    return out;
  });
  return { tasks, cancel: await cancelIds(db, envId) };
}

/** Tasks without a heartbeat for LOST_AFTER_MS: requeued once, then failed; a cancelled one is just cancelled. Returns how many were handled. */
export async function reapLost(db: Db, nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - LOST_AFTER_MS).toISOString();
  // The pod launcher owns the tasks it runs in pods (launcher.ts) and loses them by their pods' state.
  const stale = await db.all(db.k.selectFrom("build_tasks").select("id").where("state", "in", ["claimed", "running"]).where("heartbeat_at", "<", cutoff)
    .where((eb) => eb("id", "not in", eb.selectFrom("build_pod_runs").select("task_id"))).orderBy("id"));
  for (const t of stale) await loseTask(db, t.id, "The worker stopped answering twice (no heartbeat for 2 minutes).", "Cancelled; the worker stopped answering.", nowMs);
  return stale.length;
}

/**
 * A claimed or running task whose worker or pod is gone: requeued when it has a claim left and nobody cancelled it,
 * else failed with `reason` (or cancelled with `cancelled`). Its artifacts go; a requeued task also loses its log.
 */
export async function loseTask(db: Db, id: number, reason: string, cancelled = "Cancelled; the worker stopped answering.", nowMs: number = Date.now()): Promise<void> {
  const t = await db.get(db.k.selectFrom("build_tasks").select(["attempts", "cancel_requested_at"]).where("id", "=", id).where("state", "in", ["claimed", "running"]));
  if (!t) return;
  await removeArtifacts(db, [id]);
  if (!t.cancel_requested_at && t.attempts < MAX_ATTEMPTS) {
    await db.run(db.k.deleteFrom("build_task_logs").where("task_id", "=", id));
    await db.run(db.k.updateTable("build_tasks").set({ state: "queued", env_id: null, claimed_at: null, started_at: null, heartbeat_at: null, results: "[]", log_bytes: 0, summary: null })
      .where("id", "=", id).where("state", "in", ["claimed", "running"]));
  } else {
    await db.run(db.k.updateTable("build_tasks").set({ state: t.cancel_requested_at ? "cancelled" : "failed", ended_at: new Date(nowMs).toISOString(), summary: t.cancel_requested_at ? cancelled : reason })
      .where("id", "=", id).where("state", "in", ["claimed", "running"]));
  }
}

/** Undoes a claim whose task never started (its first pod could not be created): queued again, the claim not counted. */
export async function releaseClaim(db: Db, envId: string, id: number): Promise<void> {
  await db.run(db.k.deleteFrom("build_task_logs").where("task_id", "=", id));
  await db.run(db.k.updateTable("build_tasks").set((eb) => ({
    state: "queued", env_id: null, attempts: eb.case().when(eb("attempts", "-", eb.lit(1)), ">", eb.lit(0)).then(eb("attempts", "-", eb.lit(1))).else(eb.lit(0)).end(),
    claimed_at: null, started_at: null, heartbeat_at: null, results: "[]", log_bytes: 0, summary: null,
  })).where("id", "=", id).where("env_id", "=", envId).where("state", "in", ["claimed", "running"]));
}

/** Keeps a task alive while its pods run (they send no heartbeats of their own). */
export async function touchTask(db: Db, envId: string, id: number): Promise<void> {
  await db.run(db.k.updateTable("build_tasks").set({ heartbeat_at: nowIso() }).where("id", "=", id).where("env_id", "=", envId).where("state", "in", ["claimed", "running"]));
}

/** What a build pod's API containers need of their task: the source to fetch, the patch, and each step's name and artifact patterns. */
export type PodTask = {
  id: number; repo: string; headSha: string; baseSha: string | null; sourceUrl: string; patch?: string; steps: { name: string; artifacts: string[] }[];
  /** A warm producer's task (step `warm`): its source pod also reports the CI gate's warm-command. */
  warm?: true;
};

export async function podTask(db: Db, envId: string, id: number): Promise<PodTask> {
  const t = await mine(db, envId, id);
  return {
    id: t.id, repo: t.repo, headSha: t.head_sha, baseSha: t.base_sha, sourceUrl: `https://codeload.github.com/${slugOf(t.repo)}/tar.gz/${t.head_sha}`,
    ...(t.patch ? { patch: t.patch } : {}),
    steps: json<TaskStep[]>(t.plan, []).map((s) => ({ name: s.name, artifacts: s.artifacts ?? [] })),
    ...(t.step === WARM_STEP ? { warm: true as const } : {}),
  };
}

/** The task row when it is running on this environment, else a 409. */
async function mine(db: Db, envId: string, id: number): Promise<TaskRow> {
  const t = await db.get(db.k.selectFrom("build_tasks").select(cols("build_tasks")).$narrowType<{ state: TaskState }>().where("id", "=", id));
  if (!t) throw new BuildError(404, "no such task");
  if (t.env_id !== envId || (t.state !== "claimed" && t.state !== "running")) throw new BuildError(409, "this task is not running on this environment");
  return t;
}

export const ownedTask = mine;

export async function startTask(db: Db, envId: string, id: number): Promise<{ cancel: number[] }> {
  const t = await mine(db, envId, id);
  const at = nowIso();
  const r = await db.run(db.k.updateTable("build_tasks").set((eb) => ({ state: "running", started_at: eb.fn.coalesce("started_at", eb.val(at)), heartbeat_at: at }))
    .where("id", "=", t.id).where("env_id", "=", envId).where("state", "in", ["claimed", "running"]));
  if (r.changes !== 1) throw new BuildError(409, "this task is not running on this environment");
  return { cancel: await cancelIds(db, envId) };
}

export async function heartbeat(db: Db, envId: string, id: number): Promise<{ cancel: number[] }> {
  const prior = await db.get(db.k.selectFrom("build_tasks").select(["state", "env_id"]).$narrowType<{ state: TaskState }>().where("id", "=", id));
  if (prior?.env_id === envId && prior.state === "cancelled") return { cancel: await cancelIds(db, envId) };
  const t = await mine(db, envId, id);
  await db.run(db.k.updateTable("build_tasks").set({ heartbeat_at: nowIso() }).where("id", "=", t.id));
  return { cancel: await cancelIds(db, envId) };
}

const cleanLine = (s: unknown, max: number): string | null =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) || null : null;

/** Appends a log chunk; past the per-task cap the rest is dropped with a marker. */
export async function appendLog(db: Db, envId: string, id: number, step: unknown, chunk: unknown): Promise<{ truncated: boolean }> {
  const t = await mine(db, envId, id);
  if (typeof chunk !== "string") throw new BuildError(400, "chunk must be text");
  const bytes = Buffer.byteLength(chunk);
  if (bytes > MAX_CHUNK_BYTES) throw new BuildError(413, "a log chunk is at most 64 KB");
  const name = cleanLine(step, 64) ?? "";
  // The bytes are reserved first by one conditional update and its changed-row count, so concurrent appends cannot pass the cap together.
  const claim = await db.get(db.k.updateTable("build_tasks").set((eb) => ({ log_bytes: eb("log_bytes", "+", bytes), heartbeat_at: nowIso() }))
    .where("id", "=", id).where("log_bytes", "<", MAX_LOG_BYTES).returning("log_bytes"));
  if (!claim) return { truncated: true };
  let text = chunk;
  let truncated = false;
  if (claim.log_bytes > MAX_LOG_BYTES) {
    const before = claim.log_bytes - bytes;
    text = `${Buffer.from(chunk).subarray(0, MAX_LOG_BYTES - before).toString("utf8")}\n[log truncated at 20 MB]\n`;
    truncated = true;
    await db.run(db.k.updateTable("build_tasks").set({ log_bytes: MAX_LOG_BYTES }).where("id", "=", id).where("log_bytes", ">", MAX_LOG_BYTES));
  }
  const seq = ((await db.get(db.k.selectFrom("build_task_logs").select((eb) => eb.fn.max<number | null>("seq").as("m")).where("task_id", "=", id)))!.m ?? 0) + 1;
  await db.run(db.k.insertInto("build_task_logs").values({ task_id: id, seq, step: name, chunk: text }));
  return { truncated };
}

export function parseResults(v: unknown): TaskResult[] {
  if (!Array.isArray(v) || v.length > 40) throw new BuildError(400, "results must be a list of at most 40 entries");
  return v.map((r, i) => {
    const o = r as Record<string, unknown> | null;
    if (!o || typeof o !== "object") throw new BuildError(400, `results[${i}] must be an object`);
    const step = cleanLine(o.step, 64);
    const code = o.exitCode;
    const ms = o.durationMs;
    if (!step || (code !== null && (typeof code !== "number" || !Number.isInteger(code))) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || typeof o.timedOut !== "boolean") {
      throw new BuildError(400, `results[${i}] is not valid`);
    }
    const mem = o.peakMemBytes;
    const peakMemBytes = typeof mem === "number" && Number.isFinite(mem) && mem >= 0 ? Math.round(mem) : undefined;
    return { step, exitCode: code as number | null, durationMs: Math.round(ms), timedOut: o.timedOut, ...(peakMemBytes !== undefined ? { peakMemBytes } : {}), ...(typeof o.oomKilled === "boolean" ? { oomKilled: o.oomKilled } : {}) };
  });
}

const REF_RE = /^[0-9a-f]{40}$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,299}$/;
const PKG_RE = /^[a-z0-9][a-z0-9+.-]{0,99}$/;

/** The environment a worker reports for a task: image, packages and the craft-fonts / craft-i18n commits. */
export function parseSandboxEnv(v: unknown): SandboxEnv | null {
  if (v === undefined || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof v !== "object" || Array.isArray(v)) throw new BuildError(400, "environment must be an object");
  const ref = (x: unknown, name: string): string | null => {
    if (x === null || x === undefined) return null;
    if (typeof x !== "string" || !REF_RE.test(x)) throw new BuildError(400, `environment.${name} must be a commit id`);
    return x;
  };
  if (typeof o.image !== "string" || !IMAGE_RE.test(o.image) || typeof o.baseImage !== "string" || !IMAGE_RE.test(o.baseImage)) throw new BuildError(400, "environment images are not valid");
  if (!Array.isArray(o.packages) || o.packages.length > 100 || o.packages.some((p) => typeof p !== "string" || !PKG_RE.test(p))) throw new BuildError(400, "environment.packages is not valid");
  return { image: o.image, baseImage: o.baseImage, packages: o.packages as string[], craftFontsRef: ref(o.craftFontsRef, "craftFontsRef"), craftI18nRev: ref(o.craftI18nRev, "craftI18nRev") };
}

/** The worker's last word: done when every step exited 0, cancelled when an operator asked, else failed. */
export async function finishTask(db: Db, envId: string, id: number, body: unknown): Promise<{ state: TaskState }> {
  // A retried finish (the answer was lost) gets the state the first one set.
  const prior = await db.get(db.k.selectFrom("build_tasks").select(["state", "env_id"]).$narrowType<{ state: TaskState }>().where("id", "=", id));
  if (prior && prior.env_id === envId && TERMINAL.includes(prior.state)) return { state: prior.state };
  const t = await mine(db, envId, id);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BuildError(400, "the body must be a JSON object");
  const o = body as Record<string, unknown>;
  const results = parseResults(o.results);
  const summary = cleanLine(o.summary, 500);
  const sandbox = parseSandboxEnv(o.environment);
  // `failed`: the runner stopped the task for a reason no step result shows (a phase before or after the steps).
  const ok = o.failed !== true && results.length > 0 && results.every((r) => r.exitCode === 0 && !r.timedOut);
  const state: TaskState = t.cancel_requested_at ? "cancelled" : ok ? "done" : "failed";
  const r = await db.run(db.k.updateTable("build_tasks").set({ state, ended_at: nowIso(), results: JSON.stringify(results), summary, sandbox_env: sandbox ? JSON.stringify(sandbox) : null })
    .where("id", "=", id).where("env_id", "=", envId).where("state", "in", ["claimed", "running"]));
  if (r.changes !== 1) {
    // An operator cancelled it between the read and the write: the cancel stands.
    const now = await db.get(db.k.selectFrom("build_tasks").select("state").$narrowType<{ state: TaskState }>().where("id", "=", id));
    if (now && TERMINAL.includes(now.state)) return { state: now.state };
    throw new BuildError(409, "this task is not running on this environment");
  }
  return { state };
}

/** Cancels a task at once. An active one stays listed in its worker's claim and heartbeat responses for two minutes, so the worker kills it. */
export async function cancelTask(db: Db, id: unknown, by: string): Promise<BuildTask> {
  const n = typeof id === "number" ? id : Number(id);
  const t = Number.isInteger(n) ? (await db.get(db.k.selectFrom("build_tasks").select(cols("build_tasks")).$narrowType<{ state: TaskState }>().where("id", "=", n))) : undefined;
  if (!t) throw new BuildError(404, "no such task");
  const at = nowIso();
  // The update names the state it saw, so the audit row records the state it really changed. A worker claiming the task in another
  // process between the read and the write makes it match nothing; read again and retry.
  let was = t.state;
  for (let tries = 0; ; tries++) {
    if (TERMINAL.includes(was)) throw new BuildError(409, `the task is already ${was}`);
    const r = await db.run(db.k.updateTable("build_tasks").set((eb) => ({
      state: "cancelled", ended_at: at, cancel_requested_at: at,
      summary: eb.case("state").when("queued").then("Cancelled before it started.").else("Cancelled by an operator.").end(),
    })).where("id", "=", t.id).where("state", "=", was));
    if (r.changes === 1) break;
    const now = await db.get(db.k.selectFrom("build_tasks").select("state").$narrowType<{ state: TaskState }>().where("id", "=", t.id));
    was = now?.state ?? was;
    if (tries >= 5) throw new BuildError(409, `the task is already ${was}`);
  }
  await audit(db, by, "task-cancel", `task:${t.id}`, { repo: t.repo, was });
  return (await getTask(db, t.id))!;
}

// ---- reading -----------------------------------------------------------------

const selectTasks = (db: Db) => db.k.selectFrom("build_tasks as t").leftJoin("build_envs as e", "e.id", "t.env_id").leftJoin("repos as r", "r.name", "t.repo")
  .select([...cols("build_tasks", "t"), "e.label as env_label", "r.default_branch as default_branch"]).$narrowType<{ state: TaskState }>();

async function artifactsOf(db: Db, ids: number[]): Promise<Map<number, TaskArtifact[]>> {
  const out = new Map<number, TaskArtifact[]>();
  if (!ids.length) return out;
  const rows = await db.all(db.k.selectFrom("build_artifacts").select(["task_id", "name", "bytes", "content_type"]).where(inList(db, "task_id", ids, "bigint")).orderBy("name"));
  for (const r of rows) (out.get(r.task_id) ?? out.set(r.task_id, []).get(r.task_id)!).push({ name: r.name, bytes: r.bytes, contentType: r.content_type });
  return out;
}

/** The integration batches whose sandbox task is one of `ids`. */
async function batchesOf(db: Db, ids: number[]): Promise<Map<number, TaskBatch>> {
  const out = new Map<number, TaskBatch>();
  if (!ids.length) return out;
  const rows = await db.all(db.k.selectFrom("main.merge_batches").select(["id", "task_id", "repo", "branch", "commit_sha", "base_sha", "fork"]).$narrowType<{ task_id: number }>()
    .where(inList(db, "task_id", ids, "bigint")));
  if (!rows.length) return out;
  const prsOf = new Map<number, number[]>();
  for (const m of await db.all(db.k.selectFrom("main.merge_batch_prs").select(["batch_id", "number"]).where(inList(db, "batch_id", rows.map((b) => b.id), "bigint")).orderBy("batch_id").orderBy("position")))
    (prsOf.get(m.batch_id) ?? prsOf.set(m.batch_id, []).get(m.batch_id)!).push(m.number);
  const items = await shownMap(db, rows.flatMap((b) => (prsOf.get(b.id) ?? []).map((number) => ({ repo: b.repo, number }))));
  for (const b of rows) {
    const prs = prsOf.get(b.id) ?? [];
    out.set(b.task_id, {
      id: b.id, branch: b.branch, fork: b.fork, commitSha: b.commit_sha, baseSha: b.base_sha,
      prs, shown: prs.map((n) => ({ ...(items.get(`${b.repo}#${n}`) ?? { kind: null, state: null, title: null }) })),
    });
  }
  return out;
}

async function toTask(r: TaskRow, artifacts: TaskArtifact[], batch: TaskBatch | null, shown: (repo: string, number: number) => Promise<ItemShown>, noConfidential: boolean): Promise<BuildTask> {
  return {
    id: r.id, jobId: r.job_id, step: r.step, repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha,
    requires: json<Requires>(r.requires, {}), priority: r.priority, plan: json<TaskStep[]>(r.plan, []),
    state: r.state, envId: r.env_id, envLabel: r.env_label ?? null, cancelRequested: r.cancel_requested_at !== null,
    queuedAt: r.queued_at, claimedAt: r.claimed_at, startedAt: r.started_at, endedAt: r.ended_at, heartbeatAt: r.heartbeat_at,
    results: json<TaskResult[]>(r.results, []), artifacts,
    summary: r.summary ?? (r.state === "queued" && noConfidential && PRIVATE_STEPS.includes(r.step) ? CONFIDENTIAL_WAIT : null),
    patchBytes: r.patch ? Buffer.byteLength(r.patch) : null,
    warm: r.warm_key && (r.warm_role === "use" || r.warm_role === "build") ? { key: r.warm_key, role: r.warm_role } : null,
    batch,
    item: r.number === null ? null : await shown(r.repo, r.number),
    baseline: r.step === "verify" && r.number === null && !r.patch ? { branch: r.default_branch ?? null } : null,
    sandbox: r.sandbox_env ? json<SandboxEnv | null>(r.sandbox_env, null) : null,
  };
}

export async function getTask(db: Db, id: number): Promise<BuildTask | null> {
  const r = await db.get(selectTasks(db).where("t.id", "=", id));
  if (!r) return null;
  const [arts, batches, ready] = await Promise.all([artifactsOf(db, [r.id]), batchesOf(db, [r.id]), confidentialReadyAt(db)]);
  return await toTask(r, arts.get(r.id) ?? [], batches.get(r.id) ?? null, shownLookup(db), ready === null);
}

/** The last bytes of the log, from whole chunks. */
export async function logTail(db: Db, id: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const t = await db.get(db.k.selectFrom("build_tasks").select("log_bytes").where("id", "=", id));
  const parts: string[] = [];
  let size = 0;
  for (const c of await db.all(db.k.selectFrom("build_task_logs").select("chunk").where("task_id", "=", id).orderBy("seq", "desc"))) {
    parts.push(c.chunk);
    size += Buffer.byteLength(c.chunk);
    if (size >= LOG_TAIL_BYTES) break;
  }
  const joined = parts.reverse().join("");
  const cut = size > LOG_TAIL_BYTES ? Buffer.from(joined).subarray(-LOG_TAIL_BYTES).toString("utf8") : joined;
  return { text: cut, bytes: t?.log_bytes ?? 0, truncated: (t?.log_bytes ?? 0) > Buffer.byteLength(cut) };
}

export async function getTaskDetail(db: Db, id: number): Promise<BuildTaskDetail | null> {
  const t = await getTask(db, id);
  if (!t) return null;
  const l = await logTail(db, id);
  const p = await db.get(db.k.selectFrom("build_tasks").select("patch").where("id", "=", id));
  return { ...t, logTail: l.text, logBytes: l.bytes, logTruncated: l.truncated, patch: p?.patch ?? null, canCancel: false };
}

const CURSOR_RE = /^[1-9][0-9]{0,15}$/;
const FILTER_STATES = ["queued", "claimed", "running", "done", "failed", "cancelled", "lost", "active"];

/** The step of a security fix's builds: its tasks run under the finding's real repo, so viewers must not see them. */
export const FIX_CHECK_STEP = "fix-check";
/** Steps whose tasks hold a private finding: staff only. */
export const PRIVATE_STEPS = [FIX_CHECK_STEP, "scan-test"];
/** A private task's wait while no confidential environment can take it. */
export const CONFIDENTIAL_WAIT = "Waiting for a confidential build environment.";

/**
 * Since when the private tasks can be claimed: the earliest first worker call of an enabled confidential environment
 * after its flag (or the environment) was turned on; null while none has called since.
 */
export async function confidentialReadyAt(db: Db): Promise<number | null> {
  const r = (await db.get(db.k.selectFrom("build_envs").select((eb) => eb.fn.min<string | null>("confidential_online_at").as("at")).where("enabled", "=", 1).where("confidential", "=", 1)))!;
  return r.at ? Date.parse(r.at) : null;
}

/** When a private task's build limit starts: when it was queued, or when a confidential environment could first take it. null: it waits for one. */
export async function privateClockStart(db: Db, queuedAt: string): Promise<number | null> {
  const ready = await confidentialReadyAt(db);
  return ready === null ? null : Math.max(Date.parse(queuedAt), ready);
}

/** SQL for the steps hidden from viewers, for `step NOT IN (...)`. */
export const PRIVATE_STEPS_SQL = PRIVATE_STEPS.map((x) => `'${x}'`).join(", ");

/** `step IN (PRIVATE_STEPS_SQL)` as an expression on the step in `col`; `eb.not(...)` for NOT IN. */
export const privateStepExpr = (eb: Eb, col: Ex = "step"): AliasableExpression<SqlBool> => eb(ref(col), "in", PRIVATE_STEPS);

/** Newest first, keyset-paged by id. `hidden` repos are left out, and the security fix's tasks unless `staff`. */
export async function listTasks(db: Db, f: TaskFilter, hidden: string[] = [], staff = true): Promise<TaskPage> {
  let q = selectTasks(db);
  if (!staff) q = q.where((eb) => eb.not(privateStepExpr(eb, "t.step")));
  const hide = excludeHiddenExpr(db, "t.repo", hidden);
  if (hide) q = q.where(hide);
  if (f.state !== undefined) {
    if (!FILTER_STATES.includes(f.state)) throw new BuildError(400, "unknown state");
    q = f.state === "active" ? q.where("t.state", "in", ["queued", "claimed", "running"]) : q.where("t.state", "=", f.state);
  }
  if (f.env) q = q.where("t.env_id", "=", f.env);
  if (f.repo) q = q.where("t.repo", "=", f.repo);
  if (f.cursor !== undefined) {
    if (!CURSOR_RE.test(f.cursor)) throw new BuildError(400, "bad cursor");
    q = q.where("t.id", "<", Number(f.cursor));
  }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const rows = await db.all(q.orderBy("t.id", "desc").limit(limit + 1));
  const page = rows.slice(0, limit);
  const [arts, batches, ready] = await Promise.all([artifactsOf(db, page.map((r) => r.id)), batchesOf(db, page.map((r) => r.id)), confidentialReadyAt(db)]);
  const shown = shownLookup(db, page.flatMap((r) => (r.number === null ? [] : [{ repo: r.repo, number: r.number }])));
  return { tasks: await mapSeq(page, async (r) => await toTask(r, arts.get(r.id) ?? [], batches.get(r.id) ?? null, shown, ready === null)), next: rows.length > limit ? String(page[page.length - 1]!.id) : null };
}

export type { BuildSummary };
/** Queued and running tasks and the slots left, over all enabled environments (the flowchart's Verify node). */
export async function summary(db: Db, hidden: string[] = [], staff = true): Promise<BuildSummary> {
  const hide = excludeHiddenExpr(db, "repo", hidden);
  const c = (await db.get(db.k.selectFrom("build_tasks").select((eb) => [
    eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("state", "=", "queued").then(eb.lit(1)).else(eb.lit(0)).end()), eb.lit(0)).as("queued"),
    eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("state", "in", ["claimed", "running"]).then(eb.lit(1)).else(eb.lit(0)).end()), eb.lit(0)).as("running"),
  ]).where("state", "in", ["queued", "claimed", "running"])
    .$if(!staff, (q) => q.where((eb) => eb.not(privateStepExpr(eb))))
    .$if(!!hide, (q) => q.where(hide!))))!;
  const all = await db.all(db.k.selectFrom("build_envs").select(["slots", "reported_slots", "id"]).where("enabled", "=", 1).where("last_seen_at", ">", new Date(Date.now() - 60_000).toISOString()));
  const used = await db.all(db.k.selectFrom("build_tasks").select((eb) => ["env_id as id", eb.fn.countAll<number>().as("n")]).where("state", "in", ["claimed", "running"]).groupBy("env_id"));
  const byEnv = new Map(used.map((u) => [u.id, u.n]));
  const slots = all.reduce((s, e) => s + slotsOf(e), 0);
  const inUse = all.reduce((s, e) => s + Math.min(byEnv.get(e.id) ?? 0, slotsOf(e)), 0);
  return { queued: c.queued, running: c.running, slots, free: slots - inUse, online: all.length };
}

/** Drops the artifacts of tasks that ended more than ARTIFACT_KEEP_MS ago, and deletes tasks that ended more than KEEP_MS ago with their logs. Returns the count of deleted tasks. */
export async function pruneTasks(db: Db, nowMs: number = Date.now()): Promise<number> {
  const artifactsBefore = new Date(nowMs - ARTIFACT_KEEP_MS).toISOString();
  for (;;) {
    const ids = (await db.all(db.k.selectFrom("build_tasks").select("id").where("ended_at", "is not", null).where("ended_at", "<", artifactsBefore).where("artifact_bytes", ">", 0)
      .where("state", "in", TERMINAL).orderBy("ended_at").limit(200))).map((r) => r.id);
    if (!ids.length) break;
    await removeArtifacts(db, ids);
  }
  const before = new Date(nowMs - KEEP_MS).toISOString();
  let n = 0;
  for (;;) {
    const ids = (await db.all(db.k.selectFrom("build_tasks").select("id").where("ended_at", "is not", null).where("ended_at", "<", before)
      .where("state", "in", TERMINAL).orderBy("ended_at").limit(200))).map((r) => r.id);
    if (!ids.length) return n;
    await removeArtifacts(db, ids);
    for (const id of ids) {
      await db.run(db.k.deleteFrom("build_task_logs").where("task_id", "=", id));
      await db.run(db.k.deleteFrom("build_tasks").where("id", "=", id));
    }
    n += ids.length;
  }
}

export type MemRow = { repo: string; step: string; steps: number; medianBytes: number; maxBytes: number; oom: number };

/** Peak memory per repo and step name over tasks that ended in the last `days` days; steps without a measurement are skipped. */
export async function memorySummary(db: Db, days: number): Promise<MemRow[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db.all(db.k.selectFrom("build_tasks").select(["repo", "results"]).where("ended_at", ">=", since).where("results", "!=", "[]"));
  const groups = new Map<string, { repo: string; step: string; peaks: number[]; oom: number }>();
  for (const row of rows) {
    for (const r of json<TaskResult[]>(row.results, [])) {
      if (typeof r.peakMemBytes !== "number") continue;
      const key = `${row.repo}\0${r.step}`;
      const g = groups.get(key) ?? { repo: row.repo, step: r.step, peaks: [], oom: 0 };
      g.peaks.push(r.peakMemBytes);
      if (r.oomKilled) g.oom++;
      groups.set(key, g);
    }
  }
  return [...groups.values()]
    .map((g) => {
      const p = g.peaks.sort((a, b) => a - b);
      const mid = p.length >> 1;
      return { repo: g.repo, step: g.step, steps: p.length, medianBytes: p.length % 2 ? p[mid]! : Math.round((p[mid - 1]! + p[mid]!) / 2), maxBytes: p[p.length - 1]!, oom: g.oom };
    })
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.step.localeCompare(b.step));
}
