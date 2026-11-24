// Build environments (workers): operator-registered places that run untrusted
// code. The coordinator holds only a hash of each worker key. Everything a
// worker reports is stored as data and shown as text.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BuildEnv, EnvTask, Capabilities, EnvCreate, EnvInput, EnvKind } from "../../web/src/api/types.ts";
import { audit } from "../dash/audit.ts";
import { parseSettings, settingsOf } from "./pods.ts";
import type { Db } from "../db/index.ts";
import { cols } from "../db/kx.ts";

export class BuildError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const ONLINE_MS = 60_000;
export const MAX_SLOTS = 200;
export const LABEL_MAX = 40;
export const ENV_ID_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const KINDS: EnvKind[] = ["local-sandbox", "remote", "kubernetes"];
const KEY_PREFIX = "cwk";
const POD_KEY_PREFIX = "cwp";

type Row = {
  id: string; label: string; kind: EnvKind; enabled: number; slots: number; key_hash: string; capabilities: string | null; confidential: number;
  reported_slots: number | null; version: string | null; paused_reason: string | null; last_seen_at: string | null; settings: string | null;
};

export const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** A new key: `cwk_<env id>_<secret>`; the id lets the coordinator find the row without scanning. */
export function newKey(envId: string): string {
  return `${KEY_PREFIX}_${envId}_${randomBytes(32).toString("base64url")}`;
}

/** A build pod's one-time key, `cwp_<task id>_<secret>`: valid while the task's pod run exists (launcher.ts). */
export function newPodKey(taskId: number): string {
  return `${POD_KEY_PREFIX}_${taskId}_${randomBytes(32).toString("base64url")}`;
}

const DUMMY_HASH = hashKey("no such environment");
/** The key hash of a kubernetes environment: not a SHA-256 hex digest, so no key matches it. */
const UNUSABLE_HASH = "none";

/**
 * The environment a bearer key belongs to, or null; a pod key also names its one task. The comparison takes the same time
 * for a wrong key and an unknown id.
 */
export async function authenticate(db: Db, key: string): Promise<{ id: string; taskId?: number } | null> {
  if (key.length > 200) return null;
  const m = /^cwk_([a-z0-9-]{3,32})_[A-Za-z0-9_-]{20,100}$/.exec(key);
  const p = m ? null : /^cwp_(\d{1,15})_[A-Za-z0-9_-]{20,100}$/.exec(key);
  const row = m
    ? await db.get(db.k.selectFrom("build_envs").select(["id", "key_hash"]).where("id", "=", m[1]!).where("kind", "!=", "kubernetes"))
    : p
      ? await db.get(db.k.selectFrom("build_pod_runs as r").innerJoin("build_envs as e", "e.id", "r.env_id")
        .select(["r.env_id as id", "r.key_hash", "r.task_id"]).where("r.task_id", "=", Number(p[1])).where("e.kind", "=", "kubernetes"))
      : undefined;
  const a = Buffer.from(hashKey(key), "hex");
  const b = Buffer.from(row?.key_hash ?? DUMMY_HASH, "hex");
  const same = a.length === b.length && timingSafeEqual(a, b);
  if (!row || !same) return null;
  return p ? { id: row.id, taskId: Number(p[1]) } : { id: row.id };
}

function parseCaps(s: string | null): Capabilities | null {
  try {
    return s ? (JSON.parse(s) as Capabilities) : null;
  } catch {
    return null;
  }
}

/** The name of the first plan step with no result yet; null when the plan or results cannot be read. */
export function currentStep(plan: string | null, results: string | null): string | null {
  try {
    const done = new Set((JSON.parse(results || "[]") as { step: string }[]).map((r) => r.step));
    return (JSON.parse(plan || "[]") as { name: string }[]).find((s) => !done.has(s.name))?.name ?? null;
  } catch {
    return null;
  }
}

async function runningTasks(db: Db): Promise<Map<string | null, EnvTask[]>> {
  const rows = await db.all(db.k.selectFrom("build_tasks").select(["id", "env_id", "step", "repo", "number", "plan", "results", "started_at", "claimed_at"])
    .where("state", "in", ["claimed", "running"]).orderBy("id"));
  const by = new Map<string | null, EnvTask[]>();
  for (const r of rows) {
    const t: EnvTask = { id: r.id, step: r.step, repo: r.repo, number: r.number, current: currentStep(r.plan, r.results), startedAt: r.started_at ?? r.claimed_at ?? "" };
    by.set(r.env_id, [...(by.get(r.env_id) ?? []), t]);
  }
  return by;
}

export const slotsOf = (r: { slots: number; reported_slots: number | null }): number => Math.min(r.slots, r.reported_slots ?? r.slots);

function toEnv(r: Row, tasks: EnvTask[], nowMs: number): BuildEnv {
  const online = r.last_seen_at !== null && nowMs - Date.parse(r.last_seen_at) < ONLINE_MS;
  return {
    id: r.id, label: r.label, kind: r.kind, enabled: r.enabled === 1, online, lastSeenAt: r.last_seen_at,
    slots: slotsOf(r), running: tasks.length, tasks, capabilities: parseCaps(r.capabilities), version: r.version,
    pause: { fiveHour: 80, weekly: 80 }, pauseCustom: false,
    pausedReason: r.enabled === 1 && online ? r.paused_reason : null, confidential: r.confidential === 1,
    settings: r.kind === "kubernetes" ? settingsOf(r.settings) : null,
  };
}

/** Every environment, in the order they were registered. */
export async function listEnvs(db: Db, nowMs: number = Date.now()): Promise<BuildEnv[]> {
  const tasks = await runningTasks(db);
  return (await db.all(db.k.selectFrom("build_envs").select(cols("build_envs")).$narrowType<{ kind: EnvKind }>().orderBy("created_at").orderBy("id"))).map((r) => toEnv(r, tasks.get(r.id) ?? [], nowMs));
}

export async function getEnv(db: Db, id: string, nowMs: number = Date.now()): Promise<BuildEnv | null> {
  return (await listEnvs(db, nowMs)).find((e) => e.id === id) ?? null;
}

function checkLabel(v: unknown): string {
  if (typeof v !== "string") throw new BuildError(400, "label must be text");
  const l = v.trim();
  if (!l || l.length > LABEL_MAX || /[\u0000-\u001f<>@]/.test(l)) throw new BuildError(400, `label must be 1 to ${LABEL_MAX} characters without @, < or >`);
  return l;
}

function checkSlots(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_SLOTS) throw new BuildError(400, `slots must be a whole number from 1 to ${MAX_SLOTS}`);
  return v;
}

function checkFlag(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new BuildError(400, `${name} must be true or false`);
  return v;
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BuildError(400, "the body must be a JSON object");
  return input as Record<string, unknown>;
}

/**
 * Registers an environment. The key is returned here and never again. A kubernetes environment has no worker and no key:
 * the runner starts its pods, each task's with a one-time key.
 */
export async function createEnv(db: Db, input: unknown, by: string): Promise<{ env: BuildEnv; key: string | null }> {
  const o = object(input);
  const bad = Object.keys(o).find((k) => !["id", "label", "kind", "slots", "confidential", "settings"].includes(k));
  if (bad) throw new BuildError(400, `${bad} cannot be set`);
  const id = o.id;
  if (typeof id !== "string" || !ENV_ID_RE.test(id)) throw new BuildError(400, "id must be 3 to 32 lowercase letters, digits or hyphens, starting with a letter");
  const label = checkLabel(o.label);
  if (!KINDS.includes(o.kind as EnvKind)) throw new BuildError(400, `kind must be ${KINDS.join(" or ")}`);
  const slots = checkSlots(o.slots);
  const confidential = o.confidential === undefined ? false : checkFlag(o.confidential, "confidential");
  const kube = o.kind === "kubernetes";
  if (!kube && o.settings !== undefined) throw new BuildError(400, "settings are only for kubernetes environments");
  const settings = kube ? JSON.stringify(parseSettings(o.settings)) : null;
  const key = newKey(id);
  const at = new Date().toISOString();
  try {
    await db.run(db.k.insertInto("build_envs").values({
      id, label, kind: o.kind as EnvKind, slots, confidential: confidential ? 1 : 0, confidential_since: confidential ? at : null,
      key_hash: kube ? UNUSABLE_HASH : hashKey(key), created_at: at, updated_by: by, updated_at: at, settings,
    }));
  } catch (e) {
    if (/UNIQUE|constraint/i.test((e as Error).message)) throw new BuildError(409, `environment ${id} exists`);
    throw e;
  }
  await audit(db, by, "env-create", `env:${id}`, { label, kind: o.kind, slots, ...(confidential && { confidential }), ...(settings && { settings: JSON.parse(settings) as unknown }) });
  return { env: (await getEnv(db, id))!, key: kube ? null : key };
}

export async function updateEnv(db: Db, id: unknown, input: unknown, by: string): Promise<BuildEnv> {
  const o = object(input);
  const bad = Object.keys(o).find((k) => !["label", "enabled", "slots", "confidential", "settings"].includes(k));
  if (bad) throw new BuildError(400, `${bad} cannot be set`);
  const before = typeof id === "string" ? (await db.get(db.k.selectFrom("build_envs").select(cols("build_envs")).$narrowType<{ kind: EnvKind }>().where("id", "=", id))) : undefined;
  if (!before) throw new BuildError(404, "no such environment");
  if (o.settings !== undefined && before.kind !== "kubernetes") throw new BuildError(400, "settings are only for kubernetes environments");
  const settings = o.settings !== undefined ? JSON.stringify(parseSettings(o.settings, settingsOf(before.settings))) : before.settings;
  if (settings !== before.settings && settingsOf(settings).namespace !== settingsOf(before.settings).namespace && await db.get(db.k.selectFrom("build_pod_runs").select((eb) => eb.lit(1).as("one")).where("env_id", "=", before.id).limit(1))) {
    throw new BuildError(409, "the namespace cannot change while tasks run in it; disable the environment and wait for them to finish");
  }
  const next = {
    label: o.label !== undefined ? checkLabel(o.label) : before.label,
    enabled: before.enabled === 1,
    slots: o.slots !== undefined ? checkSlots(o.slots) : before.slots,
    confidential: o.confidential !== undefined ? checkFlag(o.confidential, "confidential") : before.confidential === 1,
  };
  if (o.enabled !== undefined) next.enabled = checkFlag(o.enabled, "enabled");
  const at = new Date().toISOString();
  await db.run(db.k.updateTable("build_envs")
    .set({ label: next.label, enabled: next.enabled ? 1 : 0, slots: next.slots, confidential: next.confidential ? 1 : 0, settings, updated_by: by, updated_at: at })
    .where("id", "=", before.id));
  // The private tasks' build limit starts at the worker's first call after the flag, or the environment, is turned on.
  if (!next.confidential) await db.run(db.k.updateTable("build_envs").set({ confidential_since: null, confidential_online_at: null }).where("id", "=", before.id));
  else if (before.confidential !== 1 || (next.enabled && before.enabled !== 1)) await db.run(db.k.updateTable("build_envs").set({ confidential_since: at, confidential_online_at: null }).where("id", "=", before.id));
  await audit(db, by, "env-change", `env:${before.id}`, {
    ...(next.label !== before.label && { label: next.label, was: before.label }),
    ...(next.enabled !== (before.enabled === 1) && { enabled: next.enabled }),
    ...(next.slots !== before.slots && { slots: next.slots, was: before.slots }),
    ...(next.confidential !== (before.confidential === 1) && { confidential: next.confidential }),
    ...(settings !== before.settings && { settings: JSON.parse(settings!) as unknown }),
  });
  return (await getEnv(db, before.id))!;
}

/** A new key; the old one stops working at once. */
export async function rotateKey(db: Db, id: unknown, by: string): Promise<{ key: string }> {
  const row = typeof id === "string" ? (await db.get(db.k.selectFrom("build_envs").select("kind").$narrowType<{ kind: EnvKind }>().where("id", "=", id))) : undefined;
  if (!row) throw new BuildError(404, "no such environment");
  if (row.kind === "kubernetes") throw new BuildError(400, "a kubernetes environment has no key: each task's pods get a one-time key");
  const key = newKey(id as string);
  await db.run(db.k.updateTable("build_envs").set({ key_hash: hashKey(key), updated_by: by, updated_at: new Date().toISOString() }).where("id", "=", id as string));
  await audit(db, by, "env-rotate-key", `env:${id}`);
  return { key };
}

const OS = ["linux", "macos", "windows"], ARCH = ["x86_64", "aarch64"];
const TOOLCHAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;

/** Checks what a worker reports about itself; anything else is refused. */
export function parseCapabilities(v: unknown): Capabilities {
  const o = object(v);
  const int = (k: string, max: number) => {
    const n = o[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) throw new BuildError(400, `capabilities.${k} must be a number from 0 to ${max}`);
    return Math.round(n);
  };
  if (!OS.includes(o.os as string)) throw new BuildError(400, "capabilities.os is not known");
  if (!ARCH.includes(o.arch as string)) throw new BuildError(400, "capabilities.arch is not known");
  if (typeof o.display !== "boolean" || typeof o.gpu !== "boolean") throw new BuildError(400, "capabilities.display and gpu must be true or false");
  const tc = o.toolchains;
  if (!Array.isArray(tc) || tc.length > 40 || tc.some((t) => typeof t !== "string" || !TOOLCHAIN_RE.test(t))) throw new BuildError(400, "capabilities.toolchains must be a list of at most 40 short names");
  return {
    os: o.os as Capabilities["os"], arch: o.arch as Capabilities["arch"], cpus: int("cpus", 4096), memGb: int("memGb", 65536), diskGb: int("diskGb", 10_000_000),
    display: o.display, gpu: o.gpu, toolchains: [...new Set(tc as string[])].sort(),
    ...(o.warmSigner === true ? { warmSigner: true } : {}),
  };
}

/** A flagged, enabled environment's first worker call since the flag was turned on. */
async function markOnline(db: Db, id: string, at: string): Promise<void> {
  await db.run(db.k.updateTable("build_envs").set({ confidential_online_at: at })
    .where("id", "=", id).where("confidential", "=", 1).where("enabled", "=", 1).where("confidential_online_at", "is", null));
}

/** Records a call from the worker: the heartbeat and, when given, its paused reason. */
export async function touch(db: Db, id: string, paused?: string | null): Promise<void> {
  const at = new Date().toISOString();
  await markOnline(db, id, at);
  if (paused === undefined) await db.run(db.k.updateTable("build_envs").set({ last_seen_at: at }).where("id", "=", id));
  else await db.run(db.k.updateTable("build_envs").set({ last_seen_at: at, paused_reason: paused }).where("id", "=", id));
}

/** The worker's first call: stores what it can do, capped by the operator's slot count. */
export async function hello(db: Db, id: string, body: unknown): Promise<{ envId: string; label: string; slots: number }> {
  const o = object(body);
  const caps = parseCapabilities(o.capabilities);
  const version = typeof o.version === "string" && o.version.length <= 40 && /^[\w.+-]+$/.test(o.version) ? o.version : null;
  if (typeof o.slots !== "number" || !Number.isInteger(o.slots) || o.slots < 0 || o.slots > 1024) throw new BuildError(400, "slots must be a whole number");
  const at = new Date().toISOString();
  await db.run(db.k.updateTable("build_envs")
    .set({ capabilities: JSON.stringify(caps), reported_slots: o.slots, version, last_seen_at: at, paused_reason: null }).where("id", "=", id));
  await markOnline(db, id, at);
  const r = (await db.get(db.k.selectFrom("build_envs").select(cols("build_envs")).$narrowType<{ kind: EnvKind }>().where("id", "=", id)))!;
  return { envId: id, label: r.label, slots: slotsOf(r) };
}

export type EnvHealth = { state: "warn" | "fail"; text: string; since: string };

/**
 * The pod launcher's pass over a kubernetes environment: what its pods offer, its health (undefined keeps it), and, when
 * the Kubernetes API answered, the heartbeat. `health` keeps its `since` while the text stays the same; `slots` undefined keeps the reported slots.
 */
export async function kubeReport(db: Db, id: string, caps: Capabilities, slots: number | undefined, health: Omit<EnvHealth, "since"> | null | undefined, reachable: boolean): Promise<void> {
  const at = new Date().toISOString();
  if (health === undefined) {
    await db.run(db.k.updateTable("build_envs").set({ capabilities: JSON.stringify(caps), ...(slots === undefined ? {} : { reported_slots: slots }) }).where("id", "=", id));
    if (reachable) await touchSeen(db, id, at);
    return;
  }
  const prior = await db.get(db.k.selectFrom("build_envs").select("health").where("id", "=", id));
  let old: EnvHealth | null = null;
  try {
    old = prior?.health ? (JSON.parse(prior.health) as EnvHealth) : null;
  } catch { /* rewritten below */ }
  const next = health ? JSON.stringify({ ...health, since: old && old.text === health.text && old.state === health.state ? old.since : at }) : null;
  await db.run(db.k.updateTable("build_envs").set({ capabilities: JSON.stringify(caps), ...(slots === undefined ? {} : { reported_slots: slots }), health: next, health_at: at }).where("id", "=", id));
  if (reachable) await touchSeen(db, id, at);
}

async function touchSeen(db: Db, id: string, at: string): Promise<void> {
  await markOnline(db, id, at);
  await db.run(db.k.updateTable("build_envs").set({ last_seen_at: at }).where("id", "=", id));
}
