// The pod launcher: runs in the runner and starts, follows and removes the build pods of kubernetes environments.
// Each pass, per environment: keep its pod runs (build_pod_runs) alive, list its pods and volumes, move every run on by
// what its pod's status says, claim queued tasks for free slots one at a time, delete pods and volumes no run owns, and
// record what the environment offers and its health. Stateless between passes apart from caches, so a restarted runner
// picks up where the last one stopped: a run whose pod is gone is lost (requeued once, then failed, as for a worker that
// stops answering) unless its node is still up, and pods and volumes of tasks that are no longer this environment's are deleted. The launcher owns
// the tasks it runs: reapLost leaves them alone.
//
// Capacity (setting `capacity`): `fixed` claims up to the slots. `cluster` reads the nodes and the namespace's quota
// once per pass when a task waits, and claims while the next task fits node room left by our own runs' reservations
// and the quota; the slots are the ceiling. It sees no other pod, so the scheduler is the feedback: while one of our
// pods is Unschedulable, nothing new is claimed. A pod the cluster takes away (preemption, eviction) runs again on the
// same volume without using one of the task's attempts.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Requires, SandboxEnv, TaskResult, TaskStep } from "../../web/src/api/types.ts";
import { envVar } from "../env.ts";
import { envSettings, hashKey, newPodKey, type EnvHealth } from "./envs.ts";
import { computeCapacity, feedbackCapacity, overQuota, quotaHard, quotaRoom, toCapNode, type Capacity, type CapNode, type Res } from "./capacity.ts";
import { classifyPodEnd, disruptionPolicy, MAX_DISRUPTIONS, pendingKind } from "./disruption.ts";
import { guardedApi, inClusterApi, KubeError, type CapacityApi, type KResourceQuota, type ConfigMapApi, type ContainerStatus, type KPod, type KubeApi } from "./kube-api.ts";
import { gib, memoryOf, raiseAfterOom, repoMemory, repoSizing } from "./sizing.ts";
import { decideWarm, WARM_COPY_CONTAINER, type WarmUse } from "./warm-mount.ts";
import { TOOLCHAIN_ID_CONTAINER } from "../warm/toolchain.ts";
import { STATUS_NAMESPACE, WarmStatus } from "./warm-status.ts";
import { takeLog, type LogPos } from "./pod-log.ts";
import { WarmPlacer } from "./warm-place.ts";
import { CacheReporter } from "./caches.ts";
import { MirrorAllowlistWriter } from "./mirror-sources.ts";
import {
  ARCH_LABEL, DISK_CONTAINER, MIRROR_WAIT_CONTAINER, envSelector, FIRST_GROUP, groupsOf, CREATE_TRIES, kubeCapabilities, LIST_GRACE_MS, PACKAGES_CONTAINER, parsePrepared, PENDING_LIMIT_MS, PENDING_WARN_MS, PULL_LIMIT_MS,
  ciCheckout, PULL_REASONS, pvcSpec, stepMemory, warmEnvHash, quantity, sourcePod, STAGE_SOURCE, STAGE_TASK, stepCap, stepContainer, stepPod, STUCK_MS, taskLimits, taskPod, taskRequest, toolchainImage, uploadPod, uploadStage,
  stepPeak, WARM_GC_CONTAINER, WARM_PUBLISH_CONTAINER, WARM_RESTORE_CONTAINER, type Group, type KubeSettings, type PodCtx, type Prepared, type StepMemory, type WarmPod, warmCopyMemory, warmMemory,
} from "./pods.ts";
import { autocraftVersion, recordTrimmedPublish, recordWarmBytes, releaseGc, takeGc, WARM_PRODUCER_REV, warmBytes } from "./warm-queue.ts";
import { workspacePass, WorkspaceState } from "./workspace-launch.ts";
import { claimConfigKeys } from "./choose.ts";
import { readConfig } from "../data/control/index.ts";
import { appendLog, finishTask, loseTask, pickTasks, satisfies, type ClaimFit, MAX_CHUNK_BYTES, MAX_LOG_BYTES, WARM_STEP, warmKeyOf } from "./tasks.ts";
import { appendTaskLogs, claimRun, failQueuedTasks, loadClaimInputs, loadEnvPass, loadEnvTasks, loadTasks, reportKubeEnv, releaseClaims, removePodRuns, savePodRuns, touchTasks } from "../data/build/index.ts";
import type { ClaimInputs, EnvRecord, PodRun, PodRunPatch } from "../data/build/index.ts";
import type { Db } from "../db/index.ts";
import { effect } from "../db/effects.ts";

export const PASS_MS = 5000;
/** Beyond a deadline Kubernetes should have enforced, the runner gives up on the pod itself. */
export const DEADLINE_MARGIN_MS = 5 * 60_000;
/** Failed creates of a stage's pod are retried with backoff (15 s doubling, at most 5 min) up to CREATE_TRIES times or this long. */
export const CREATE_GIVE_UP_MS = 15 * 60_000;
const ACCESS_EVERY_MS = 60_000;
const CREATE_BACKOFF_MS = 60_000;
/** Longest the task, source and upload pods may run. */
const APP_POD_SEC = 30 * 60;
/** What a warm producer's pod adds to its deadline: the restore, the publish and the store's gc. */
const WARM_PHASES_SEC = 30 * 60;
/** What a build pod that starts warm adds to its deadline: the copy from its node. */
const WARM_COPY_SEC = 15 * 60;
/** A stage's pod the quota had no room for is created again after this long (an external wait, until the task's deadline). */
const QUOTA_RETRY_MS = 60_000;
/** A first pod no node had room for is placed again at most this often; after that it is lost as before. */
const MAX_REPLACES = 2;

type Run = PodRun;
type TaskRow = { id: number; step: string; state: string; env_id: string | null; repo: string; plan: string; requires: string; log_bytes: number; warm_key: string | null };
type EnvRow = { id: string; enabled: boolean; slots: number; settings: unknown; health: EnvRecord["health"] };
type Kept = Prepared & { image: string };

export type LauncherDeps = {
  db: Db;
  /** null outside a cluster: the environments then report that they cannot start pods. */
  api: KubeApi | null;
  /** Reads the nodes' warm status (src/build/warm-status.ts); null or left out: no warm status is shown. */
  configMaps?: Pick<ConfigMapApi, "listConfigMaps"> | null;
  /** Writes the warm placement (src/build/warm-place.ts) and the crate mirror's derived git allowlist (src/build/mirror-sources.ts); null or left out: neither is written. */
  placement?: Pick<ConfigMapApi, "getConfigMap" | "patchConfigMap"> | null;
  /** Reads the crate mirror's allowlist for the caches report (src/build/caches.ts); null or left out: none is read. */
  caches?: Pick<ConfigMapApi, "getConfigMap"> | null;
  /** The runner's own image (AUTOCRAFT_IMAGE), for environments that name none. */
  defaultImage: string | null;
  log: (line: string) => void;
  now?: () => number;
  /** Blobs of a warm key that consumers reported bad, which the producer's next publish repairs; the nodes' warm-sync status when unset. */
  warmRecheck?: (key: string) => Promise<string[]>;
  /** Node and quota reads for environments with capacity `cluster`; null or left out: they run their fixed slots. */
  capacity?: CapacityApi | null;
  /** Reads of the CI gate files for workspaces (src/worker/gate.ts); the global fetch when left out. */
  fetchImpl?: typeof fetch;
};

/**
 * One pass's view of cluster capacity for envs that share a namespace, arch and node reserve: `take` deducts from it, so
 * envs that share it see each other's claims. `error`: the reads failed, and those envs run their fixed slots.
 */
type CapView = {
  cap: Capacity;
  /** Why a request can never fit (`by` names what bounds it: the arch's nodes, or the namespace's quota); null when it can. */
  tooLarge: (r: Res) => { text: string; by: "nodes" | "quota" } | null;
  /** The most allocatable memory of any node of the arch, or null with none. */
  nodeMaxMem: number | null;
} | { error: string };
/** Reads made once per pass: the nodes, each namespace's quota, and the capacity views built from them. */
class PassReads {
  nodes: Promise<CapNode[]> | null = null;
  quotas = new Map<string, Promise<KResourceQuota[]>>();
  views = new Map<string, Promise<CapView>>();
}

/** Caches between passes: the access review, a pause after a task could not be started, when a pod's node stopped reporting, and the nodes' warm status. */
export class LauncherState {
  warm: WarmStatus | null = null;
  placer: WarmPlacer | null = null;
  caches: CacheReporter | null = null;
  mirrorList: MirrorAllowlistWriter | null = null;
  reads = new PassReads();
  access = new Map<string, { at: number; missing: string[] }>();
  /** `capacity`: the quota refused a first pod, a capacity wait rather than a fault. */
  backoff = new Map<string, { until: number; why: string; capacity?: boolean }>();
  unknownSince = new Map<string, number>();
  /** Runs whose next pod the quota refused, with the health text shown while they wait for the retry. */
  quotaWait = new Map<number, string>();
}

const json = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
const statusOf = (pod: KPod, name: string): ContainerStatus | undefined =>
  [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].find((c) => c.name === name);
const clean = (s: string | undefined): string => (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);

export async function launcherPass(d: LauncherDeps, state: LauncherState): Promise<void> {
  const pass = await loadEnvPass(d.db, "kubernetes");
  const envs = pass.envs.map((e): EnvRow => ({ id: e.id, enabled: e.enabled, slots: e.operatorSlots, settings: e.settings, health: e.health }));
  state.reads = new PassReads();
  if (envs.length && d.configMaps) {
    state.warm ??= new WarmStatus(d.configMaps, { namespace: envVar("WARM_STATUS_NAMESPACE"), now: d.now, log: d.log });
    await state.warm.refresh();
    const mirrorUsed = envs.some((e) => e.enabled && envSettings(e).crateMirror);
    if (d.placement) {
      state.placer ??= new WarmPlacer(d.placement, { namespace: envVar("WARM_STATUS_NAMESPACE") ?? STATUS_NAMESPACE, now: d.now ?? Date.now, log: d.log });
      await state.placer.pass(d.db, state.warm);
      if (mirrorUsed) {
        state.mirrorList ??= new MirrorAllowlistWriter(d.placement, { namespace: envVar("WARM_STATUS_NAMESPACE") ?? STATUS_NAMESPACE, now: d.now ?? Date.now, log: d.log });
        await state.mirrorList.pass(d.db);
      }
    }
    state.caches ??= new CacheReporter(d.caches ?? null, d.now);
    try {
      await state.caches.pass(d.db, state.warm, state.placer, mirrorUsed);
    } catch (e) {
      d.log(`caches report: ${(e as Error).message}`);
    }
  }
  for (const env of envs) {
    try {
      await envPass(d, state, env, pass.tasks.get(env.id)?.runs ?? []);
    } catch (e) {
      d.log(`pod launcher: ${env.id}: ${(e as Error).stack ?? e}`);
    }
  }
}

type EnvCtx = {
  d: LauncherDeps; state: LauncherState; api: KubeApi | null; env: EnvRow; s: KubeSettings; image: string | null; pods: KPod[]; pending: string[]; now: () => number;
  /** Capacity `cluster` with node and quota reads available. */
  cluster: boolean;
  /** What this pass's claim read: the sizings of the queued tasks' repos and the other environments. */
  inputs: ClaimInputs | null;
};

async function envPass(d: LauncherDeps, state: LauncherState, env: EnvRow, firstRuns: Run[]): Promise<void> {
  const { db } = d;
  const now = d.now ?? Date.now;
  const s = envSettings(env);
  const warm = state.warm?.summary() ?? [];
  const warmErrors = state.warm?.nodeErrors() ?? [];
  const caps = { ...kubeCapabilities(s), ...(warm.length ? { warm } : {}), ...(warmErrors.length ? { warmErrors } : {}) };
  const cluster = s.capacity === "cluster" && !!d.capacity;
  // Under cluster capacity the slots offered come from this pass's capacity reads; undefined keeps the last figure.
  let slots: number | undefined = cluster ? undefined : env.slots;
  const report = async (health: Omit<EnvHealth, "since"> | null, reachable: boolean) =>
    await reportKubeEnv(db, { id: env.id, caps, slots, health, priorHealth: env.health, reachable, at: new Date(now()).toISOString() });
  const image = s.image ?? d.defaultImage;
  const ctx: EnvCtx = { d, state, api: d.api, env, s, image, pods: [], pending: [], now, cluster, inputs: null };
  let first: Run[] | null = firstRuns;
  const runs = async (): Promise<Run[]> => {
    if (first) {
      const r = first;
      first = null;
      return r;
    }
    return (await loadEnvTasks(db, env.id)).runs;
  };
  const started = await runs();
  if (started.length) await touchTasks(db, env.id, started.map((r) => r.task_id), new Date(now()).toISOString());
  first = started;

  const api = d.api;
  // Without the API, runs past their deadline are still given up, so their slots come back.
  const offline = async (text: string) => {
    for (const run of await runs()) if (overdue(ctx, run)) await lose(ctx, run, overdueText(ctx));
    await report({ state: "fail", text: text.slice(0, 300) }, false);
  };
  if (!api) return offline("The runner is not running in a Kubernetes cluster, so it cannot start build pods");
  const ns = s.namespace;
  let pvcs: { metadata: { name: string } }[];
  try {
    [ctx.pods, pvcs] = await Promise.all([api.listPods(ns, envSelector(env.id)), api.listPvcs(ns, envSelector(env.id))]);
  } catch (e) {
    return offline(`The Kubernetes API did not answer: ${(e as Error).message}`);
  }
  // Claims need the capabilities, before any health is known.
  await reportKubeEnv(db, { id: env.id, caps, slots, reachable: true, at: new Date(now()).toISOString() });

  let access = state.access.get(env.id);
  if (!access || now() - access.at > ACCESS_EVERY_MS) {
    const wanted: [string, string][] = [["create", "pods"], ["delete", "pods"], ["get", "pods"], ["create", "persistentvolumeclaims"], ["delete", "persistentvolumeclaims"]];
    const allowed = await Promise.all(wanted.map(([v, r]) => api.canI(ns, v, r).catch(() => false)));
    access = { at: now(), missing: wanted.filter((_, i) => !allowed[i]).map(([v, r]) => `${v} ${r}`) };
    state.access.set(env.id, access);
  }

  for (const run of await runs()) await advance(ctx, run);

  const back = state.backoff.get(env.id);
  if (image && !access.missing.length && !(back && back.until > now())) {
    // The scheduler's answer stands in for the pods we cannot see: while it has no room for one of ours, wait.
    const current = await runs();
    const live = new Set(current.map((r) => r.pod));
    const unschedulable = cluster ? ctx.pods.find((p) => live.has(p.metadata.name) && feedbackCapacity(null, p).stop) : undefined;
    let active = current.length;
    // Read before claiming, outside its write transaction, and only when a task waits.
    const writer = s.warmWriter ? { version: autocraftVersion(), rev: WARM_PRODUCER_REV, image: toolchainImage(s, ["rust-stable"]) } : undefined;
    const inputs = !unschedulable && active < env.slots ? await loadClaimInputs(db, env.id, now(), writer) : null;
    const cfg = await readConfig(db, [...(inputs ? claimConfigKeys(inputs) : []), "warm_min_interval_minutes"]);
    ctx.inputs = inputs;
    const view: CapView | null = cluster && inputs && inputs.candidates.length ? await capacityView(ctx) : null;
    let waiting: Res | null = null, quotaFull = false;
    const fit: ClaimFit | undefined = cluster ? async (t) => {
      // No task was queued at the read: one queued since waits for the next pass's read.
      if (!view) return "stop";
      if ("error" in view) return "fit";
      const { res } = await requestOf(ctx, t.repo, t.step);
      const large = view.tooLarge(res);
      if (large) {
        const text = `${large.text}; lower the repository's size with \`tasks sizes\``;
        if (!await otherEnvMayRun(ctx, t.requires, large.by)) return { fail: text };
        ctx.pending.push(`Task ${t.id} is left to other environments: ${text}`.slice(0, 300));
        return "skip";
      }
      if (view.cap.fit(res) === null) {
        waiting = res;
        return "stop";
      }
      return "fit";
    } : undefined;
    if (unschedulable) ctx.pending.push(`New tasks wait for build pod capacity: no node has room for pod ${unschedulable.metadata.name} yet`);
    // One at a time: a claim that cannot start goes back to the queue before the next is taken.
    else if (inputs) while (active < env.slots) {
      // Claimed one at a time: a claim that cannot start goes back to the queue before the next is taken.
      const { picks, failed } = await pickTasks(db, env.id, 1, now(), { fit, inputs, config: cfg, warmMinIntervalMinutes: cfg.warmMinIntervalMinutes });
      if (failed.length) await failQueuedTasks(db, failed, new Date(now()).toISOString());
      const gone = new Set([...failed.map((f) => f.id), ...picks.map((p) => p.id)]);
      inputs.candidates = inputs.candidates.filter((t) => !gone.has(t.id));
      const pick = picks[0];
      if (!pick) break;
      const key = newPodKey(pick.id);
      const claimed = await claimRun(db, {
        envId: env.id, taskId: pick.id, keyHash: hashKey(key), pvc: `acb-${pick.id}-${randomBytes(3).toString("hex")}`, stage: STAGE_TASK, at: new Date(now()).toISOString(),
        ...(pick.head ? { heads: { head: pick.head, base: pick.base ?? null, plan: pick.plan } } : {}),
      });
      // Another process claimed it first.
      if (!claimed) continue;
      inputs.running++;
      const r = await start(ctx, claimed.run, claimed.task.id, key, view);
      if (r?.quota) {
        // The quota counts what the model may not (another quota key, pods outside AutoCraft): the next try waits a minute.
        state.backoff.set(env.id, { until: now() + CREATE_BACKOFF_MS, why: r.err, capacity: true });
        quotaFull = true;
        break;
      }
      if (r) {
        state.backoff.set(env.id, { until: now() + CREATE_BACKOFF_MS, why: r.err });
        break;
      }
      state.backoff.delete(env.id);
      active++;
    }
    const v = view;
    if (v && "error" in v) {
      ctx.pending.push(`Cluster capacity could not be read, so the environment runs its fixed ${env.slots} slots: ${v.error}`.slice(0, 300));
      slots = env.slots;
    } else if (unschedulable || quotaFull) slots = active;
    else if (v) {
      const w = waiting as Res | null;
      if (w) ctx.pending.push(`New tasks wait for build pod capacity: the next needs ${cpuText(w.cpu)} CPU and ${gib(w.mem)} of memory`);
      slots = Math.min(env.slots, active + v.cap.countFit(w ?? toRes(taskRequest(s))));
    }
  }

  // Pods and volumes no run owns: a finished stage whose delete failed, a create that failed late, or a task that is no longer this environment's.
  const owned = await runs();
  const podNames = new Set(owned.map((r) => r.pod)), pvcNames = new Set(owned.map((r) => r.pvc));
  for (const p of ctx.pods) if (!podNames.has(p.metadata.name)) await api.deletePod(ns, p.metadata.name).catch((e: Error) => d.log(`pod launcher: delete pod ${p.metadata.name}: ${e.message}`));
  for (const v of pvcs) if (!pvcNames.has(v.metadata.name)) await api.deletePvc(ns, v.metadata.name).catch((e: Error) => d.log(`pod launcher: delete volume ${v.metadata.name}: ${e.message}`));
  for (const name of state.unknownSince.keys()) if (!podNames.has(name)) state.unknownSince.delete(name);

  const backNow = state.backoff.get(env.id);
  const health: Omit<EnvHealth, "since"> | null =
    access.missing.length ? { state: "fail", text: `The runner may not ${access.missing.join(", ")} in namespace ${ns}` }
    : !image ? { state: "fail", text: "No AutoCraft image is known for build pods: set AUTOCRAFT_IMAGE on the runner or the environment's image" }
    : backNow && backNow.until > now() && backNow.capacity ? { state: "warn", text: "New tasks wait for build pod capacity: the namespace's quota has no room" }
    : backNow && backNow.until > now() ? { state: "fail", text: `A build pod could not be created: ${backNow.why}`.slice(0, 300) }
    : ctx.pending.length ? { state: "warn", text: ctx.pending[0]! }
    : !Object.keys(s.toolchainImages).length ? { state: "warn", text: "No toolchain image is set, so tasks that name a toolchain (every pipeline build) are not taken" }
    : null;
  await report(health, true);
}

const taskOf = async (db: Db, id: number): Promise<TaskRow | undefined> => {
  const t = (await loadTasks(db, [id])).get(id);
  return t && { id: t.id, step: t.step, state: t.state, env_id: t.envId, repo: t.repo, plan: JSON.stringify(t.plan), requires: JSON.stringify(t.requires), log_bytes: t.logBytes, warm_key: t.warmKey };
};
/** Patches the pod run of a task. */
const patchRun = async (db: Db, taskId: number, patch: PodRunPatch): Promise<void> => void await savePodRuns(db, [{ taskId, patch }]);
/** Whether group `index` is a warm producer's build pod: the last group of a warm task, offline, on a warm writer. */
const isWarmGroup = (c: EnvCtx, t: TaskRow, groups: Group[], index: number): boolean =>
  t.step === WARM_STEP && c.s.warmWriter && index === groups.length - 1 && groups[index]!.network === "none";
/** The size of the version a publish reports in its termination message (JSON with `bytes`); 0 when it says none. */
/** Whether the publish left out the units its build did not use (src/warm/trim.ts). */
function publishedTrimmed(message: string | undefined): boolean {
  try {
    return (JSON.parse(message ?? "") as { trimmed?: unknown }).trimmed === true;
  } catch {
    return false;
  }
}
function publishedBytes(message: string | undefined): number {
  try {
    const n = (JSON.parse(message ?? "") as { bytes?: unknown }).bytes;
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}
/** The summary in a phase's termination message (JSON with `summary`, or plain text). */
function reported(message: string | undefined): string {
  try {
    const o = JSON.parse(message ?? "") as { summary?: unknown };
    if (o && typeof o.summary === "string") return clean(o.summary);
  } catch { /* plain text */ }
  return clean(message);
}
const runMs = (term: { startedAt?: string; finishedAt?: string }): number => Math.max(0, Date.parse(term.finishedAt ?? "") - Date.parse(term.startedAt ?? "")) || 0;
const overdue = (c: EnvCtx, run: Run): boolean => c.now() > Date.parse(run.started_at) + c.s.deadlineSec * 1000 + DEADLINE_MARGIN_MS;
const overdueText = (c: EnvCtx) => `The task passed its deadline of ${c.s.deadlineSec} s and its pod did not stop`;

const toRes = (r: { cpuM: number; memBytes: number }): Res => ({ cpu: r.cpuM, mem: r.memBytes });
const cpuText = (m: number): string => String(Math.round(m / 100) / 10);
/** A pod create the namespace's ResourceQuota refused: a wait for capacity, not a failure. */
const quotaRefused = (e: unknown): boolean => e instanceof KubeError && e.status === 403 && /exceeded quota/i.test(e.message);

/** The repository's sizing: from this pass's claim read when it covers the repository, else read now. */
const sizingOf = async (c: EnvCtx, repo: string) => c.inputs?.sizings.get(repo) ?? await repoSizing(c.d.db, repo);

/**
 * The repository's step memory and what one of its runs reserves on its node (pods.ts taskRequest), with an in-memory warm
 * target: a producer's, or a consumer's sized from the key's last published version (decideWarm checks the node's version
 * against what was reserved).
 */
async function requestOf(c: EnvCtx, repo: string, step: string): Promise<{ res: Res; memory: StepMemory }> {
  const sizing = await sizingOf(c, repo);
  const memory = memoryOf(sizing, c.s);
  const key = warmKeyOf(repo);
  let extra = 0;
  if (step === WARM_STEP && c.s.warmWriter) extra = warmMemory({ key, gc: false, bytes: sizing.warmBytes }) ?? 0;
  else if (step !== WARM_STEP && !c.s.warmWriter && sizing.warmTarget === "tmpfs") extra = warmCopyMemory(sizing.warmBytes) ?? 0;
  const lim = taskLimits(c.s, memory, extra);
  return { res: { ...toRes(taskRequest(c.s, memory, extra)), limCpu: lim.cpuM, limMem: lim.memBytes, ephReq: lim.ephRequest, ephLim: lim.ephLimit }, memory };
}

/** This pass's capacity view for the env (see CapView); the reads happen on the first call that needs them. */
async function capacityView(c: EnvCtx): Promise<CapView> {
  const s = c.s;
  const key = [s.namespace, s.arch, s.nodeReserveCpu, s.nodeReserveMemory].join("|");
  let v = c.state.reads.views.get(key);
  if (!v) {
    v = readView(c);
    c.state.reads.views.set(key, v);
  }
  return await v;
}

async function readView(c: EnvCtx): Promise<CapView> {
  const api = c.d.capacity!, reads = c.state.reads, ns = c.s.namespace;
  try {
    reads.nodes ??= api.listNodes().then((ns) => ns.map(toCapNode));
    let q = reads.quotas.get(ns);
    if (!q) {
      q = api.getQuota(ns);
      reads.quotas.set(ns, q);
    }
    const [nodes, quotas] = await Promise.all([reads.nodes, q]);
    const quota = quotaRoom(quotas), hard = quotaHard(quotas);
    const reserve: Res = { cpu: Math.round(quantity(c.s.nodeReserveCpu) * 1000) || 0, mem: Math.round(quantity(c.s.nodeReserveMemory)) || 0 };
    const archLabel = ARCH_LABEL[c.s.arch];
    // Every environment's runs reserve on the nodes they were placed on, whatever their namespace.
    const reservations = new Map<string, Res>();
    for (const r of (await loadEnvPass(c.d.db, "kubernetes")).reservations) {
      const u = reservations.get(r.node) ?? { cpu: 0, mem: 0 };
      u.cpu += r.cpuM;
      u.mem += r.memBytes;
      reservations.set(r.node, u);
    }
    // Other pods are not visible to the runner (capacity.ts): only our own reservations are taken off.
    const cap = computeCapacity({ nodes, pods: [], quota, reservations, settings: { archLabel, nodeReserve: reserve, buildPriority: 0 } });
    // The bound counts every node of the arch, Ready or not, cordoned or not: one that comes back may take the task.
    const arch = nodes.filter((n) => n.arch === archLabel);
    const room = arch.map((n) => ({ cpu: n.allocatable.cpu - reserve.cpu, mem: n.allocatable.mem - reserve.mem }));
    const need = (r: Res) => `The task needs ${cpuText(r.cpu)} CPU and ${gib(r.mem)} of memory`;
    const tooLarge = (r: Res): { text: string; by: "nodes" | "quota" } | null => {
      const over = hard ? overQuota(hard, r) : [];
      if (over.length) return { text: `${need(r)}; it exceeds the namespace's quota in all (${over.join(", ")})`, by: "quota" };
      // With no node of the arch at all nothing is too large for the nodes: the tasks wait for one.
      if (room.length && !room.some((n) => n.cpu >= r.cpu && n.mem >= r.mem)) return { text: `${need(r)}, more than any build node offers`, by: "nodes" };
      return null;
    };
    return { cap, tooLarge, nodeMaxMem: arch.length ? Math.max(...arch.map((n) => n.allocatable.mem)) : null };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Whether an enabled environment other than this one may run a task this one never can: one whose capabilities meet the
 * task's requirements and that is not bound the same way (a kubernetes environment of the same arch shares the nodes, one
 * in the same namespace shares the quota).
 */
async function otherEnvMayRun(c: EnvCtx, requires: Requires, by: "nodes" | "quota"): Promise<boolean> {
  return (c.inputs?.otherEnvs ?? []).some((e) => {
    if (!e.capabilities || !satisfies(e.capabilities, requires)) return false;
    if (e.kind !== "kubernetes") return true;
    const s = envSettings(e);
    return by === "nodes" ? s.arch !== c.s.arch : s.namespace !== c.s.namespace;
  });
}

/** The nodes whose warm status holds the task's warm key, tried first so its build starts warm. */
const warmNodes = (c: EnvCtx, t: TaskRow): string[] => c.state.warm?.warmNodesFor(t.warm_key ?? warmKeyOf(t.repo)).map((n) => n.node) ?? [];

/** The warm version of the repository's key that `node`'s fresh status lists, or null. */
const nodeWarm = (c: EnvCtx, repo: string, node: string | null) =>
  (node && c.state.warm?.warmNodesFor(warmKeyOf(repo)).find((n) => n.node === node)) || null;

/** Whether a task of this environment may start warm at all: not a warm producer's, and its repository has a warm target. */
async function warmTargetOf(c: EnvCtx, t: TaskRow) {
  return t.step === WARM_STEP || c.s.warmWriter ? "none" as const : (await sizingOf(c, t.repo)).warmTarget;
}

/**
 * Places a run under cluster capacity: picks its node (warm nodes first, then the most free room now; with `avoid`, any
 * other node that fits before it) and records node and reservation. Without a view the node is left to the scheduler
 * and learnt from the pod.
 */
async function place(c: EnvCtx, run: Run, t: TaskRow, view: CapView | null, avoid?: string | null): Promise<void> {
  const { res } = await requestOf(c, t.repo, t.step);
  let node: string | null = null;
  if (view && !("error" in view)) {
    const warm = warmNodes(c, t).filter((n) => n !== avoid);
    const others = avoid
      ? [...view.cap.nodes].sort((a, b) => b.free.cpu - a.free.cpu || b.free.mem - a.free.mem).map((n) => n.name).filter((n) => n !== avoid && !warm.includes(n))
      : [];
    node = view.cap.take(res, [...warm, ...others]);
  }
  Object.assign(run, { node, reserved_cpu_m: res.cpu, reserved_mem_bytes: res.mem });
  await patchRun(c.d.db, run.task_id, { node, reserved_cpu_m: res.cpu, reserved_mem_bytes: res.mem });
}

/**
 * Starts a claimed task: its run, volume and task pod. Anything that fails undoes the claim and returns the error;
 * `quota` when the namespace's quota had no room, which is a wait for capacity rather than a fault.
 */
async function start(c: EnvCtx, run: Run, taskId: number, key: string, view: CapView | null): Promise<{ err: string; quota: boolean } | null> {
  const { db } = c.d;
  const pvc = run.pvc;
  try {
    const t = (await taskOf(db, taskId))!;
    await place(c, run, t, c.cluster ? view : null);
    await c.api!.createPvc(c.s.namespace, pvcSpec(c.s, c.env.id, taskId, pvc));
    await createPod(c, run, STAGE_TASK, (ctx) => taskPod(ctx, c.image!, key));
    c.d.log(`pod launcher: task ${taskId} started on ${c.env.id}${run.node ? ` (node ${run.node})` : ""}`);
    return null;
  } catch (e) {
    const msg = (e as Error).message;
    c.d.log(`pod launcher: task ${taskId}: could not start: ${msg}`);
    await c.api!.deletePvc(c.s.namespace, pvc).catch(() => {});
    await removePodRuns(db, [taskId]);
    await releaseClaims(db, c.env.id, [taskId]);
    return { err: msg, quota: quotaRefused(e) };
  }
}

/** Records the stage's pod on the run, then creates it on the run's node; throws when the create fails. */
async function createPod(c: EnvCtx, run: Run, stage: number, spec: (ctx: PodCtx) => object, deadlineSec = APP_POD_SEC, memory?: StepMemory): Promise<void> {
  const now = c.now();
  const left = c.s.deadlineSec - (now - Date.parse(run.started_at)) / 1000;
  const name = `acb-${run.task_id}-${stage}-${randomBytes(3).toString("hex")}`;
  const ctx: PodCtx = { s: c.s, envId: c.env.id, taskId: run.task_id, stage, name, pvc: run.pvc, deadlineSec: Math.min(deadlineSec, left), memory, node: run.node };
  const at = new Date(now).toISOString();
  await patchRun(c.d.db, run.task_id, { stage, pod: name, pod_created_at: at });
  Object.assign(run, { stage, pod: name, pod_created_at: at });
  effect("build-launch");
  await c.api!.createPod(c.s.namespace, spec(ctx));
}

async function removeRun(c: EnvCtx, run: Run): Promise<void> {
  c.state.quotaWait.delete(run.task_id);
  if (c.api) {
    if (run.pod) await c.api.deletePod(c.s.namespace, run.pod).catch(() => {});
    await c.api.deletePvc(c.s.namespace, run.pvc).catch(() => {});
  }
  await removePodRuns(c.d.db, [run.task_id]);
}

async function lose(c: EnvCtx, run: Run, reason: string): Promise<void> {
  c.d.log(`pod launcher: task ${run.task_id}: ${reason}`);
  await removeRun(c, run);
  await loseTask(c.d.db, run.task_id, reason, "Cancelled; its build pod stopped.");
}

/** Bytes of new output one read takes; a running container's output is read once per pass. */
const LOG_READ_BYTES = 512 * 1024;

/**
 * Appends a container's output to the task log under `step`, from where the last read of it stopped (LogPos), within the
 * task's log cap. `live` (the container still runs): one read, complete lines only. Otherwise reads to the end and records
 * the container in `logged`, so it is never read again. Each read's lines and the position after them are written in one
 * transaction, so a runner stopped at any point neither repeats nor drops a line.
 */
async function podLog(c: EnvCtx, run: Run, container: string, step: string, live = false): Promise<void> {
  const { db } = c.d;
  const id = `${run.pod}/${container}`;
  if (!run.pod || json<string[]>(run.logged, []).includes(id)) return;
  let budget = LOG_READ_BYTES;
  for (;;) {
    const t = await taskOf(db, run.task_id);
    if (!t) return;
    const positions = json<Record<string, LogPos>>(run.log_positions, {});
    const pos = positions[id];
    let text: string | null = null;
    let error: string | null = null;
    const limit = (pos?.bytes ?? 0) + budget;
    if (t.log_bytes < MAX_LOG_BYTES) {
      try {
        text = await c.api!.podLog(c.s.namespace, run.pod, container, limit, { timestamps: true, ...(pos ? { sinceTime: pos.since } : {}) });
      } catch (e) {
        if (live) return;
        error = `(the output of ${container} could not be read: ${(e as Error).message})\n`;
      }
    }
    // A shorter answer than asked for is the whole rest; a decoded answer is never shorter in bytes than what was sent.
    const end = !live && (text === null || Buffer.byteLength(text) < limit);
    let took = text === null ? { text: error ?? "", pos, taken: 0 } : takeLog(text, pos, end);
    // No complete line fitted: one line is longer than the read. Read more, up to the log cap, then take what came.
    if (!took.taken && !end && text !== null) {
      if (live) return;
      if (budget < MAX_LOG_BYTES) {
        budget *= 4;
        continue;
      }
      took = takeLog(text, pos, true);
    }
    const done = await db.write(async () => {
      // A quarter of the chunk cap in characters stays under it in bytes.
      const pieces: string[] = [];
      for (let i = 0; i < took.text.length; i += MAX_CHUNK_BYTES / 4) pieces.push(took.text.slice(i, i + MAX_CHUNK_BYTES / 4));
      const truncated = pieces.length ? (await appendTaskLogs(db, c.env.id, run.task_id, step.slice(0, 64), pieces)).truncated : false;
      const finished = end || truncated || budget >= MAX_LOG_BYTES || t.log_bytes >= MAX_LOG_BYTES;
      // Positions are kept only for the run's current pod.
      const kept = Object.fromEntries(Object.entries(positions).filter(([k]) => k !== id && k.startsWith(`${run.pod}/`)));
      if (!finished && took.pos) kept[id] = took.pos;
      run.log_positions = JSON.stringify(kept);
      if (finished) run.logged = JSON.stringify([...json<string[]>(run.logged, []), id]);
      await patchRun(db, run.task_id, { logged: run.logged, log_positions: run.log_positions });
      return finished;
    });
    if (done || live) return;
  }
}

/**
 * While a step pod runs: its finished warm restore and copy, its finished steps and its running step reach the task log,
 * in that order, as they would at the pod's end (endStage); containers that have not started are not read.
 */
async function followStage(c: EnvCtx, run: Run, t: TaskRow, pod: KPod): Promise<void> {
  const plan = json<TaskStep[]>(t.plan, []);
  const groups = groupsOf(plan);
  const g = groups[run.stage - FIRST_GROUP];
  if (!g || run.stage >= uploadStage(plan)) return;
  for (const [name, step] of [[WARM_RESTORE_CONTAINER, "warm restore"], [WARM_COPY_CONTAINER, "warm copy"]] as const) {
    if (statusOf(pod, name)?.state?.terminated?.exitCode === 0) await podLog(c, run, name, step);
  }
  for (const i of g.steps) {
    const st = statusOf(pod, stepContainer(i))?.state;
    if (st?.terminated) await podLog(c, run, stepContainer(i), plan[i]!.name);
    else if (st?.running) await podLog(c, run, stepContainer(i), plan[i]!.name, true);
    else break;
  }
}

/** Why a pod ended without its containers saying so. */
function podFailure(pod: KPod): string {
  const st = pod.status;
  if (st?.reason === "DeadlineExceeded") return "The build pod passed its deadline";
  return `The build pod failed${st?.reason ? ` (${st.reason}${st.message ? `: ${st.message}` : ""})` : ""}`.slice(0, 300);
}

async function advance(c: EnvCtx, run: Run): Promise<void> {
  const { db } = c.d;
  const now = c.now();
  const t = await taskOf(db, run.task_id);
  if (!t || t.env_id !== c.env.id || (t.state !== "claimed" && t.state !== "running")) return removeRun(c, run);
  if (overdue(c, run)) {
    // A run that spent its time waiting for room ends as failed: requeued, it would wait again with a fresh deadline.
    const pending = c.pods.find((p) => p.metadata.name === run.pod);
    const unscheduled = pending?.status?.phase === "Pending" && pending.status.conditions?.some((x) => x.type === "PodScheduled" && x.status === "False");
    if (c.state.quotaWait.has(run.task_id) || unscheduled) return finish(c, run, run.failed ?? "the task passed its deadline waiting for build capacity");
    return lose(c, run, overdueText(c));
  }
  if (!run.pod) {
    if (run.retry_at && now < Date.parse(run.retry_at)) {
      const wait = c.state.quotaWait.get(run.task_id);
      if (wait) c.pending.push(wait);
      return;
    }
    return createStage(c, run, t, run.stage);
  }
  const pod = c.pods.find((p) => p.metadata.name === run.pod);
  const age = now - Date.parse(run.pod_created_at ?? run.started_at);
  if (!pod) {
    if (age < LIST_GRACE_MS) return;
    if (classifyPodEnd(null, run.node ? await nodeReady(c, run.node) : null) === "disruption") return disrupted(c, run, t, null, "it disappeared while its node stayed up");
    return lose(c, run, "The build pod disappeared before it finished (deleted, or its node went away).");
  }
  // A run the scheduler placed (fixed capacity, or no node fitted) reserves on the node its pod went to.
  if (!run.node && pod.spec?.nodeName) {
    run.node = pod.spec.nodeName;
    await patchRun(db, run.task_id, { node: run.node });
  }
  const phase = pod.status?.phase;
  const deleting = pod.metadata.deletionTimestamp;
  if (deleting && now - Date.parse(deleting) > STUCK_MS) return lose(c, run, "The build pod has been stuck in deletion (its node may be gone).");
  if (phase === "Unknown") {
    const since = c.state.unknownSince.get(pod.metadata.name) ?? now;
    c.state.unknownSince.set(pod.metadata.name, since);
    if (now - since > STUCK_MS) return lose(c, run, "The build pod's node stopped reporting.");
    return;
  }
  c.state.unknownSince.delete(pod.metadata.name);
  // Deadline and image pull count from when a node took the pod: a wait for capacity before that is not the pod's time.
  const ran = pod.status?.startTime ? now - Date.parse(pod.status.startTime) : age;
  const limit = pod.spec?.activeDeadlineSeconds;
  const sched = pod.status?.conditions?.find((x) => x.type === "PodScheduled");
  const unscheduled = phase === "Pending" && sched?.status === "False";
  if (limit !== undefined && !unscheduled && ran > limit * 1000 + PENDING_LIMIT_MS + DEADLINE_MARGIN_MS) return lose(c, run, "The build pod ran past its deadline without stopping.");
  if (phase !== "Succeeded" && phase !== "Failed") {
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    const pull = statuses.find((s) => PULL_REASONS.has(s.state?.waiting?.reason ?? ""));
    if (pull && ran > PULL_LIMIT_MS) return lose(c, run, `The build pod's container ${pull.name} could not start: ${pull.state!.waiting!.reason}${pull.state!.waiting!.message ? ` (${pull.state!.waiting!.message})` : ""}`.slice(0, 300));
    if (phase === "Pending" && !statuses.some((s) => s.state?.running || s.state?.terminated)) {
      const why = sched?.status === "False" ? sched.message ?? sched.reason ?? "not scheduled" : pull ? `${pull.state!.waiting!.reason}` : "starting";
      if (unscheduled) {
        // Later stages are pinned to the node that holds the task's volume, and so is a task pod recreated after a
        // disruption; only a first pod that never ran has an unbound volume.
        const kind = pendingKind(pod, age, run.stage !== STAGE_TASK || run.disruptions > 0);
        if (kind === "capacity-wait") {
          c.pending.push(`Task ${t.id} waits for room on node ${pod.spec?.nodeName ?? run.node ?? "of its volume"} until its deadline: ${why}`.slice(0, 300));
          return;
        }
        if (kind === "replace" && run.replaces < MAX_REPLACES) return replace(c, run, t, why);
        if (age > PENDING_LIMIT_MS) return lose(c, run, `No node took the build pod within ${minutes(PENDING_LIMIT_MS)}: ${why}`.slice(0, 300));
      }
      // The text stays the same while the pod waits, so the health check's `since` holds.
      if (age > PENDING_WARN_MS) c.pending.push(`The build pod of task ${t.id} is waiting to start: ${why}`.slice(0, 300));
      return;
    }
    return followStage(c, run, t, pod);
  }
  if (phase === "Failed" && classifyPodEnd(pod, null) === "disruption") return disrupted(c, run, t, pod, disruptionText(pod));
  return endStage(c, run, t, pod);
}

/** Whether a node is Ready: null when it is gone or could not be read. */
async function nodeReady(c: EnvCtx, name: string): Promise<boolean | null> {
  try {
    const n = await c.api!.getNode(name);
    return n ? n.status?.conditions?.find((x) => x.type === "Ready")?.status === "True" : null;
  } catch {
    return null;
  }
}

function disruptionText(pod: KPod): string {
  const dt = pod.status?.conditions?.find((x) => x.type === "DisruptionTarget" && x.status === "True");
  const r = dt ?? pod.status;
  return clean(`${r?.reason ?? "taken away"}${r?.message ? `: ${r.message}` : ""}`);
}

/**
 * The cluster took the stage's pod away (preemption, eviction, a vanished pod on a live node): the stage runs again on
 * the same volume without using an attempt, so its build continues from what is there. Past MAX_DISRUPTIONS the task is lost.
 */
async function disrupted(c: EnvCtx, run: Run, t: TaskRow, pod: KPod | null, why: string): Promise<void> {
  const { db } = c.d;
  if (!disruptionPolicy(run.disruptions).recreate) return lose(c, run, `The cluster took this task's build pods away ${MAX_DISRUPTIONS + 1} times; the last: ${why}`.slice(0, 300));
  c.d.log(`pod launcher: task ${run.task_id}: stage ${run.stage} pod taken away (${why}); running it again`);
  if (pod && statusOf(pod, WARM_GC_CONTAINER)) await releaseGc(db, c.now());
  await appendLog(db, c.env.id, run.task_id, "environment", `The cluster stopped the build pod (${why}); the stage runs again on the same volume.\n`);
  if (run.pod) await c.api!.deletePod(c.s.namespace, run.pod).catch(() => {});
  const disruptions = run.disruptions + 1;
  await patchRun(db, run.task_id, { pod: null, disruptions, create_tries: 0, failing_since: null, retry_at: null });
  Object.assign(run, { pod: null, disruptions, create_tries: 0, failing_since: null, retry_at: null });
  return createStage(c, run, t, run.stage);
}

/** The first pod no node took for PENDING_LIMIT_MS: its volume is not bound yet, so it is deleted and placed again, elsewhere when another node fits. */
async function replace(c: EnvCtx, run: Run, t: TaskRow, why: string): Promise<void> {
  c.d.log(`pod launcher: task ${run.task_id}: no node took its first pod (${why}); placing it again`);
  if (run.pod) await c.api!.deletePod(c.s.namespace, run.pod).catch(() => {});
  const avoid = run.node;
  const view = c.cluster ? await capacityView(c) : null;
  // The view counts this run's reservation and its pod's quota share; both go with the deleted pod.
  if (view && !("error" in view)) {
    const { res } = await requestOf(c, t.repo, t.step);
    view.cap.release({ ...res, cpu: run.reserved_cpu_m ?? res.cpu, mem: run.reserved_mem_bytes ?? res.mem }, avoid);
  }
  const replaces = run.replaces + 1;
  await patchRun(c.d.db, run.task_id, { replaces });
  run.replaces = replaces;
  await place(c, run, t, view, avoid);
  return next(c, run, t, STAGE_TASK);
}

async function endStage(c: EnvCtx, run: Run, t: TaskRow, pod: KPod): Promise<void> {
  const { db } = c.d;
  const plan = json<TaskStep[]>(t.plan, []);
  const groups = groupsOf(plan);
  const up = uploadStage(plan);

  if (run.stage === STAGE_TASK) {
    await podLog(c, run, "task", "source");
    if (statusOf(pod, "task")?.state?.terminated?.exitCode !== 0) return lose(c, run, `The task pod could not read its task: ${podFailure(pod)}`);
    // No key is valid while repository code runs; the upload pod gets a new one.
    await patchRun(db, run.task_id, { key_hash: hashKey(randomBytes(32).toString("hex")) });
    return next(c, run, t, STAGE_SOURCE);
  }
  if (run.stage === STAGE_SOURCE) {
    await podLog(c, run, "source", "source");
    const term = statusOf(pod, "source")?.state?.terminated;
    // Evicted or killed before it could report: the pod's fault, not the task's.
    if (!term || (term.exitCode !== 0 && !term.message?.trim())) return lose(c, run, `The source pod stopped without a report (${term ? term.reason ?? `exit ${term.exitCode}` : podFailure(pod)})`);
    const r = parsePrepared(term.message);
    if (term.exitCode !== 0 || !r.ok) return finish(c, run, r.ok ? `source failed (exit ${term.exitCode})` : r.summary);
    const image = toolchainImage(c.s, json<Requires>(t.requires, {}).toolchains);
    if (!image) return finish(c, run, `no toolchain image for ${json<Requires>(t.requires, {}).toolchains?.join(", ") || "this task"}`);
    const kept: Kept = { ...r.prepared, image };
    run.prepared = JSON.stringify(kept);
    await patchRun(db, run.task_id, { prepared: run.prepared });
    return next(c, run, t, FIRST_GROUP);
  }
  if (run.stage >= FIRST_GROUP && run.stage < up) {
    const g = groups[run.stage - FIRST_GROUP]!;
    const warm = isWarmGroup(c, t, groups, run.stage - FIRST_GROUP);
    const results = json<TaskResult[]>(run.results, []);
    let failed: string | null = null;
    let ran = run.ran;
    for (const [name, fallback] of [[DISK_CONTAINER, "the task's volume is over its size"], [MIRROR_WAIT_CONTAINER, "the crate mirror is not reachable"], [PACKAGES_CONTAINER, "the toolchain image lacks packages the CI gate installs"], [TOOLCHAIN_ID_CONTAINER, "the toolchain image could not report its rustc"], [WARM_RESTORE_CONTAINER, "the warm restore failed"], [WARM_COPY_CONTAINER, "the warm copy failed"]] as const) {
      const term = statusOf(pod, name)?.state?.terminated;
      if (!term || failed) continue;
      // The restore's and the copy's output say which version the build starts from, or why it starts cold.
      const warmLog = name === WARM_RESTORE_CONTAINER ? "warm restore" : name === WARM_COPY_CONTAINER ? "warm copy" : null;
      if (warmLog) await podLog(c, run, name, warmLog);
      if (term.exitCode !== 0) {
        if (!warmLog) await podLog(c, run, name, "environment");
        failed = (name === WARM_RESTORE_CONTAINER ? reported(term.message) : clean(term.message)) || fallback;
      }
    }
    for (const i of failed ? [] : g.steps) {
      const step = plan[i]!;
      const st = statusOf(pod, stepContainer(i))?.state;
      const term = st?.terminated;
      const startedAt = term?.startedAt ?? st?.running?.startedAt;
      if (!term && !startedAt) break;
      await podLog(c, run, stepContainer(i), step.name);
      const end = term?.finishedAt ? Date.parse(term.finishedAt) : c.now();
      const durationMs = Math.max(0, end - (startedAt ? Date.parse(startedAt) : end)) || 0;
      // `timeout` exits 124, or 137 after its grace; a step's own 124 before its limit is an ordinary failure. A step still
      // running when the pod ended was stopped by the pod's deadline.
      const timedOut = !term || ((term.exitCode === 124 || term.exitCode === 137) && durationMs >= stepCap(c.s, step) * 1000 - 2000);
      const oomKilled = term?.reason === "OOMKilled";
      const spec = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].find((x) => x.name === stepContainer(i));
      const peak = stepPeak(term?.message, quantity(spec?.resources?.limits?.memory ?? c.s.maxPodMemory));
      results.push({ step: step.name, exitCode: timedOut ? null : term!.exitCode, durationMs, timedOut, ...(peak ? { peakMemBytes: peak } : {}), ...(oomKilled ? { oomKilled } : {}) });
      ran = Math.max(ran, i + 1);
      if (timedOut) failed = `${step.name} timed out`;
      else if (oomKilled) {
        // The repository's next builds get more memory; this one fails as any failed step does.
        const view = c.cluster ? await capacityView(c) : null;
        const r = await raiseAfterOom(db, t.repo, c.s, view && !("error" in view) ? view.nodeMaxMem : null);
        failed = `${step.name} ran out of memory; ${r.raised ? `the repository's next builds get ${gib(r.memory.limitBytes)}` : `${gib(r.memory.limitBytes)} is already the most a build pod gets`}`;
      }
      else if (term!.exitCode !== 0) failed = pod.status?.reason === "Evicted" ? `${step.name} failed: ${pod.status.message ?? "evicted"}`.slice(0, 300) : `${step.name} failed (exit ${term!.exitCode})`;
      if (failed) break;
    }
    // A failed gc leaves the published version as it is: the task still succeeds, and a later warm pod runs the gc (the
    // lease taken at the pod's creation is released, so it is due again in a few hours).
    let gcFailed = false;
    if (warm) {
      const gc = statusOf(pod, WARM_GC_CONTAINER)?.state?.terminated;
      if (!failed) {
        const pub = statusOf(pod, WARM_PUBLISH_CONTAINER)?.state?.terminated;
        if (pub) {
          await podLog(c, run, WARM_PUBLISH_CONTAINER, "warm publish");
          results.push({ step: "warm publish", exitCode: pub.exitCode, durationMs: runMs(pub), timedOut: false });
          if (pub.exitCode !== 0) failed = `warm publish failed${reported(pub.message) ? `: ${reported(pub.message)}` : ` (exit ${pub.exitCode})`}`.slice(0, 300);
          else {
            await recordWarmBytes(db, warmKeyOf(t.repo), publishedBytes(pub.message));
            if (publishedTrimmed(pub.message)) await recordTrimmedPublish(db, t.repo, c.now());
          }
        } else if (pod.status?.phase !== "Failed") {
          // The pod ended with every step run and no publish status: nothing was published.
          failed = "the warm publish did not run";
        }
        if (gc && !failed) await podLog(c, run, WARM_GC_CONTAINER, "warm gc");
      }
      if (statusOf(pod, WARM_GC_CONTAINER) && !(gc && gc.exitCode === 0 && !failed)) {
        await releaseGc(db, c.now());
        gcFailed = !!gc && gc.exitCode !== 0 && !failed;
      }
    }
    if (!failed && !gcFailed && pod.status?.phase === "Failed") return lose(c, run, podFailure(pod));
    await patchRun(db, run.task_id, { results: JSON.stringify(results), ran, failed });
    Object.assign(run, { results: JSON.stringify(results), ran, failed });
    const nextGroup = run.stage - FIRST_GROUP + 1;
    if (!failed && nextGroup < groups.length) return next(c, run, t, FIRST_GROUP + nextGroup);
    if (plan.slice(0, ran).some((s) => s.artifacts?.length)) return next(c, run, t, up);
    return finish(c, run, failed);
  }
  if (run.stage === up) {
    await podLog(c, run, "upload", "artifacts");
    if (statusOf(pod, "upload")?.state?.terminated?.exitCode !== 0) await appendLog(db, c.env.id, run.task_id, "artifacts", `artifact upload failed: ${podFailure(pod)}\n`);
    return finish(c, run, run.failed);
  }
  return lose(c, run, `The build pod run is at an unknown stage ${run.stage}`);
}

/** Deletes the stage's pod and starts `stage`. */
async function next(c: EnvCtx, run: Run, t: TaskRow, stage: number): Promise<void> {
  if (run.pod) await c.api!.deletePod(c.s.namespace, run.pod).catch(() => {});
  await patchRun(c.d.db, run.task_id, { stage, pod: null, create_tries: 0, failing_since: null, retry_at: null });
  Object.assign(run, { stage, pod: null, create_tries: 0, failing_since: null, retry_at: null });
  return createStage(c, run, t, stage);
}

/**
 * Creates the pod of the run's stage. Past the task's deadline the task ends instead. A failed create (rate limit, quota,
 * an API error) leaves the run at the stage without a pod and is retried with backoff; after CREATE_TRIES or
 * CREATE_GIVE_UP_MS the task is lost.
 */
async function createStage(c: EnvCtx, run: Run, t: TaskRow, stage: number): Promise<void> {
  const { db } = c.d;
  const plan = json<TaskStep[]>(t.plan, []);
  const groups = groupsOf(plan);
  const left = c.s.deadlineSec - (c.now() - Date.parse(run.started_at)) / 1000;
  if (left < 60) return finish(c, run, run.failed ?? `the task passed its deadline of ${c.s.deadlineSec} s`);
  let spec: (ctx: PodCtx) => object;
  let deadline: number | undefined;
  let memory: StepMemory | undefined;
  let gcTaken = false;
  if (stage === STAGE_TASK) {
    // Recreated after a disruption or a replace: the task pod reads its task with a new key.
    const key = newPodKey(run.task_id);
    await patchRun(db, run.task_id, { key_hash: hashKey(key) });
    spec = (ctx) => taskPod(ctx, c.image!, key);
  } else if (stage === STAGE_SOURCE) {
    // The source pod lists what changed since the version the node holds now; a later version means touching every file.
    const commit = (await warmTargetOf(c, t)) !== "none" ? nodeWarm(c, t.repo, run.node)?.commit ?? null : null;
    spec = (ctx) => sourcePod(ctx, c.image!, commit);
  }
  else if (stage >= FIRST_GROUP && stage < FIRST_GROUP + groups.length) {
    const index = stage - FIRST_GROUP;
    const g = groups[index]!;
    const kept = json<Kept | null>(run.prepared, null);
    if (!kept) return lose(c, run, "The build pod run lost its source report");
    if (g.network === "mirror" && !c.s.crateMirror) return finish(c, run, run.failed ?? "a step needs the crate mirror, and this environment has none");
    let warm: WarmPod | undefined;
    gcTaken = false;
    if (t.step === WARM_STEP && index === groups.length - 1) {
      if (!isWarmGroup(c, t, groups, index)) return finish(c, run, run.failed ?? "a warm build needs a warm writer environment and an offline last step");
      const key = warmKeyOf(t.repo);
      gcTaken = await takeGc(db, c.now());
      warm = { key, gc: gcTaken, bytes: await warmBytes(db, key), recheck: c.d.warmRecheck ? await c.d.warmRecheck(key).catch(() => []) : c.state.warm?.badBlobsFor(key) ?? [] };
    }
    memory = await repoMemory(db, t.repo, c.s);
    let use: WarmUse | undefined;
    // A network group before an offline group (the dependency fetch) copies CARGO_HOME from the version that group would
    // start from, so the fetch downloads only what it lacks; a warm producer's fetch starts empty, as its publish carries it.
    const seeds = g.network !== "none" && t.step !== WARM_STEP && groups.slice(index + 1).some((x) => x.network === "none");
    const target = (g.network === "none" && !warm) || seeds ? await warmTargetOf(c, t) : "none";
    if (target !== "none") {
      const step = stepMemory(c.s, memory);
      const view = target === "tmpfs" && c.cluster ? await capacityView(c) : null;
      const d = decideWarm({
        target, key: warmKeyOf(t.repo), node: run.node, status: nodeWarm(c, t.repo, run.node), image: kept.image, toolchain: c.state.warm?.toolchainOf(kept.image) ?? null, envHash: warmEnvHash(kept),
        checkout: ciCheckout(t.repo), cargoLock: kept.cargoLock ?? null, memoryLimitBytes: quantity(step.limit),
        memoryRoomBytes: run.reserved_mem_bytes === null ? null : Math.max(0, run.reserved_mem_bytes - quantity(step.request)),
        nodeMaxBytes: view && !("error" in view) ? view.nodeMaxMem : null,
      });
      use = d.use ?? undefined;
      if (!seeds) await appendLog(db, c.env.id, run.task_id, "warm copy", d.use ? `starts warm from ${d.use.key}@${d.use.commit.slice(0, 12)} (${d.use.target})\n` : `starts cold: ${d.why}\n`);
      else if (d.use) await appendLog(db, c.env.id, run.task_id, "warm copy", `copies CARGO_HOME from ${d.use.key}@${d.use.commit.slice(0, 12)} before "${plan[g.steps[0]!]!.name}"\n`);
    }
    // The steps' limits, a minute each to copy the source, and two minutes to start the pod and measure its volume.
    deadline = g.steps.reduce((n, i) => n + stepCap(c.s, plan[i]!) + 60, 120) + (warm ? WARM_PHASES_SEC : 0) + (use ? WARM_COPY_SEC : 0);
    spec = (ctx) => stepPod(ctx, kept.image, c.image!, plan, g, kept, index === 0, t.repo, warm, use);
  } else if (stage === uploadStage(plan)) {
    const key = newPodKey(run.task_id);
    await patchRun(db, run.task_id, { key_hash: hashKey(key) });
    spec = (ctx) => uploadPod(ctx, c.image!, key, run.ran);
  } else return lose(c, run, `The build pod run is at an unknown stage ${stage}`);
  try {
    await createPod(c, run, stage, spec, deadline, memory);
    c.state.quotaWait.delete(run.task_id);
    await patchRun(db, run.task_id, { create_tries: 0, failing_since: null, retry_at: null });
  } catch (e) {
    if (gcTaken) await releaseGc(db, c.now());
    const now = c.now();
    if (quotaRefused(e)) {
      // The quota is the build budget: wait for room until the task's deadline, without counting a failed create.
      const retry = new Date(now + QUOTA_RETRY_MS).toISOString();
      Object.assign(run, { pod: null, retry_at: retry });
      await patchRun(db, run.task_id, { pod: null, retry_at: retry });
      const wait = `Task ${run.task_id} waits for build pod capacity: the namespace's quota has no room for its next pod`;
      c.state.quotaWait.set(run.task_id, wait);
      c.pending.push(wait);
      c.d.log(`pod launcher: task ${run.task_id}: ${(e as Error).message}`);
      return;
    }
    const tries = run.create_tries + 1;
    const since = run.failing_since ?? new Date(now).toISOString();
    const why = `The next build pod could not be created: ${(e as Error).message}`.slice(0, 300);
    // A create that answered with an error may still have made the pod; with no run naming it, the orphan sweep deletes it.
    Object.assign(run, { pod: null, create_tries: tries, failing_since: since });
    if (tries >= CREATE_TRIES || now - Date.parse(since) > CREATE_GIVE_UP_MS) return lose(c, run, why);
    const retry = new Date(now + Math.min(15_000 * 2 ** (tries - 1), 5 * 60_000)).toISOString();
    await patchRun(db, run.task_id, { pod: null, create_tries: tries, failing_since: since, retry_at: retry });
    run.retry_at = retry;
    c.d.log(`pod launcher: task ${run.task_id}: ${why} (try ${tries}, again at ${retry})`);
  }
}

async function finish(c: EnvCtx, run: Run, failed: string | null): Promise<void> {
  const results = json<TaskResult[]>(run.results, []);
  const kept = json<Kept | null>(run.prepared, null);
  const environment: SandboxEnv | undefined = kept
    ? { image: kept.image, baseImage: kept.image, packages: kept.packages, craftFontsRef: kept.craftFontsRef, craftI18nRev: kept.craftI18nRev }
    : undefined;
  const summary = failed ?? (results.length ? `${results.length} step${results.length === 1 ? "" : "s"} passed` : "no step ran");
  try {
    await finishTask(c.d.db, c.env.id, run.task_id, { results, summary, ...(failed ? { failed: true } : {}), ...(environment ? { environment } : {}) });
  } catch (e) {
    c.d.log(`pod launcher: task ${run.task_id}: finish: ${(e as Error).message}`);
  }
  await removeRun(c, run);
}

/** Runs build-task and workspace passes until `signal` aborts. Started by the runner; a pass with no kubernetes environment reads one table. */
/** `guard` runs before every Kubernetes call that changes something, and stops it by throwing (src/build/kube-api.ts guardedApi). */
export function startPodLauncher(db: Db, signal: AbortSignal, log: (line: string) => void, guard?: () => Promise<void>): void {
  const api = inClusterApi();
  const placement = api && {
    getConfigMap: api.getConfigMap,
    patchConfigMap: async (ns: string, name: string, patch: object) => (await guard?.(), await api.patchConfigMap(ns, name, patch)),
  };
  const deps: LauncherDeps = { db, api: api && guard ? guardedApi(api, guard) : api, configMaps: api, placement, caches: api, capacity: api, defaultImage: envVar("IMAGE") ?? null, log };
  const state = new LauncherState();
  const workspaces = new WorkspaceState();
  void (async () => {
    while (!signal.aborted) {
      try {
        await launcherPass(deps, state);
      } catch (e) {
        log(`pod launcher: ${(e as Error).stack ?? e}`);
      }
      workspaces.warm = state.warm;
      try {
        await workspacePass(deps, workspaces);
      } catch (e) {
        log(`workspace launcher: ${(e as Error).stack ?? e}`);
      }
      await sleep(PASS_MS, undefined, { signal }).catch(() => {});
    }
  })();
}
