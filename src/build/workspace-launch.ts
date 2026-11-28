// The workspace half of the pod launcher: one pass every PASS_MS, per kubernetes environment, after the build-task pass.
//
//   requested  → starting  volume and pod created when a workspace slot is free
//   starting   → seeding   the pod runs and its container is ready; the node is recorded
//   seeding    → ready     `git archive <base_sha>` from AutoCraft's clone streamed into `ws untar`, which commits it
//   ready      → parked    no call for IDLE_PARK_MS, no bound remote call queued or leased and no background command
//                          running: checkpoint, pod deleted, volume kept (PARKED_VOLUME_MS, then deleted)
//   parked     → requested its bound remote call is queued or leased, or a session asks for it (resumeWorkspace). The new
//                          pod uses the kept volume, which seeding only checks (never seeds again); without one, seeding
//                          fills a new volume from the base and applies the checkpoint. A resume onto a volume whose node
//                          is gone drops the volume and rebuilds, unless the last checkpoint failed.
//   resuming   → parked    a resume that cannot start or seed goes back to parked with its kept volume and checkpoint, up to
//                          RESUME_TRIES times; then it stays parked with the reason in its error.
// A parked volume whose last checkpoint failed holds work no checkpoint has: it is kept past PARKED_VOLUME_MS.
//   any live   → failed    the pod could not start or seed, or passed its time limit; pod and volume deleted
//   ended                  set by whoever is done with it; the pass deletes pod and volume
// While ready, a checkpoint (`git diff --binary` against the base commit) is stored every CHECKPOINT_EVERY_MS. Seeding,
// checkpoints and parking run in the background, at most one per workspace, so a slow exec never holds up the pass.
// Stateless between passes apart from what is in flight: after a restart a `seeding` row seeds again (from an empty tree).
// A pod of a resumed workspace has a new name (workspaceName with an incarnation), and so has a volume it rebuilds on.
// A layout-2 workspace (src/build/workspace-layout.ts) first reads its CI gate at the base commit (`prepared`, in the
// background while requested), picks the node whose warm version its target starts from when it starts (`warm`), and
// while seeding also copies in the gate's craft-fonts / craft-i18n checkouts and sets the checkout's mtimes.
import { spawn } from "node:child_process";
import type { Db } from "../db/index.ts";
import { exec, fixupDir, GIT_ENV, gitDirEnv, Git, HARDENING } from "../fixup/git.ts";
import { ownerOf } from "../owners.ts";
import { failStuckCalls, loadEnvPass, loadWorkspaces, loadWorkspacePass, patchWorkspaces } from "../data/build/index.ts";
import type { WorkspacePass } from "../data/build/index.ts";
import { envSettings } from "./envs.ts";
import { KubeError, type KPod, type KubeApi } from "./kube-api.ts";
import type { LauncherDeps } from "./launcher.ts";
import { CREATE_TRIES, ciCheckout, LIST_GRACE_MS, PENDING_LIMIT_MS, PULL_LIMIT_MS, PULL_REASONS, quantity, STUCK_MS, type KubeSettings } from "./pods.ts";
import { repoWarmTarget } from "./sizing.ts";
import { warmKeyOf } from "./tasks.ts";
import { COPY_MARK_FILE, type WarmTarget } from "./warm-mount.ts";
import { warmBytes } from "./warm-queue.ts";
import type { WarmStatus } from "./warm-status.ts";
import { chooseWarm, LAYOUT_CI, sha256, warmOf, WARM_CHANGED_DIRS, WARM_CHANGED_FILES, WARM_MTIMES_SH, workspaceStorageBytes, type WorkspacePrepared, type WorkspaceWarm } from "./workspace-layout.ts";
import { fetchPodKept, workspaceEnvSelector, workspaceName, workspacePodSpec, workspacePvcSpec, workspaceSelector, WS_CONTAINER, type WorkspaceCiLayout } from "./workspace-pods.ts";
import { resolveGate, resolveI18nRev } from "../worker/gate.ts";
import { EXT_ARCHIVE_MAX_BYTES, gateStepEnv } from "../worker/environment.ts";
import { changedFrom, parseLsTree, type CopyMark } from "../worker/warm-copy.ts";
import { describeHeader, execInWorkspace, execWs, getCheckpoint, getWorkspace, limitsOf, LIVE_STATES, moveWorkspace, POD_STATES, RESUME_TRIES, resumeWorkspace, type WorkspaceRow, type WorkspaceStateName, type WsCallResult } from "./workspaces.ts";
import { effect } from "../db/effects.ts";

export const SEED_LIMIT_MS = 10 * 60_000;
export const IDLE_PARK_MS = 30 * 60_000;
export const CHECKPOINT_EVERY_MS = 10 * 60_000;
/** A parked workspace's volume is deleted after this long; the checkpoint stays, and a resume rebuilds from base plus checkpoint. */
export const PARKED_VOLUME_MS = 60 * 60_000;
/** A parked workspace whose volume is gone ends this long after it parked; the checkpoint stays on the row. */
export const PARKED_END_MS = 24 * 3600_000;
/** A resume onto a kept volume whose pod is still unscheduled after this long asks whether the volume's node is gone. */
export const RESUME_PENDING_MS = 3 * 60_000;
/** A node not ready for this long counts as gone, with the volumes it holds. */
export const NODE_LOST_MS = 5 * 60_000;
/** How often seeding checks a kept volume again after an unclear answer. */
const KEPT_RETRY_MS = 10_000;
/** The longest a workspace takes from requested (or parked) to ready before the launcher fails it; a minute more covers its pass interval. */
export const READY_LIMIT_MS = PENDING_LIMIT_MS + SEED_LIMIT_MS + 60_000;
/** While the bound remote call is leased, the idle time is counted from at most this long ago, so it parks only after the lease ends. */
const LEASE_TOUCH_MS = 60_000;
/** A bound call back in the queue (its Task Runner was lost) gets a fresh checkpoint for the next session's prompt, tried this often. */
const REQUEUE_CHECKPOINT_MS = 60_000;
export const MAX_SOURCE_BYTES = 512 * 1024 ** 2;
export const MAX_CHECKPOINT_BYTES = 5 * 1024 ** 2;
/** The toolchain image workspace pods run. */
export const WORKSPACE_TOOLCHAIN = "rust-stable";
const CREATE_BACKOFF_MS = 60_000;
const CHECKPOINT_FILE = "/work/.ws/checkpoint.diff";
const RESUME_FILE = "/work/.ws/resume.diff";
/** Reads of a layout-2 workspace's CI gate before it fails, and the wait between them. */
export const PREPARE_TRIES = 3;
const PREPARE_RETRY_MS = 30_000;
/** A pod pinned to a warm node that the scheduler cannot place there for this long starts again cold, on any node. */
export const WARM_PLACE_MS = 3 * 60_000;
/** Grace past a background command's own limit before the launcher stops counting it as running (the helper's kill -k 5). */
const BACKGROUND_GRACE_MS = 30_000;
/**
 * The script that writes the workspace's diff against the commit in `$1` to `/work/.ws/<name>.diff`, with its own index copy and
 * temporary files per name. `flags` go before the commit. The diff is cut one byte past the cap, so an oversized one shows as such;
 * head stopping early makes git's status 141. It works on a copy of the index, so the session's index and its lock are never touched.
 * The copy keeps the index's mtime (cp -p): git re-reads a file whose mtime is not older than the index, so an edit of the same size
 * made in the second the index was written still shows, which a copy with a new mtime would hide.
 */
export const diffScript = (name: string, flags = ""): string => `set -e
GIT_INDEX_FILE=/work/.ws/${name}.index
export GIT_INDEX_FILE
rm -f "$GIT_INDEX_FILE" "$GIT_INDEX_FILE.lock"
cp -p .git/index "$GIT_INDEX_FILE" 2>/dev/null || :
git add -A -N
{ git diff --binary --no-ext-diff --no-textconv${flags ? ` ${flags}` : ""} "$1"; echo $? >/work/.ws/${name}.rc; } | head -c ${MAX_CHECKPOINT_BYTES + 1} >/work/.ws/${name}.tmp
rc=$(cat /work/.ws/${name}.rc)
[ "$rc" = 0 ] || [ "$(wc -c </work/.ws/${name}.tmp)" -gt ${MAX_CHECKPOINT_BYTES} ] || exit "$rc"
mv /work/.ws/${name}.tmp /work/.ws/${name}.diff`;
const CHECKPOINT_SH = diffScript("checkpoint");

/** What is in flight between passes. */
export class WorkspaceState {
  busy = new Map<number, Promise<void>>();
  unknownSince = new Map<number, number>();
  /** When each workspace's last checkpoint was tried, so a failing one is retried on the same schedule, not every pass. */
  checkpointTried = new Map<number, number>();
  backoff = new Map<string, number>();
  counts = new Map<string, string>();
  /** Failed reads of each requested workspace's CI gate: how many, and when the next may start. */
  prepareTries = new Map<number, { tries: number; next: number }>();
  /** The nodes' warm status, shared with the build-task launcher (it refreshes it); null: no workspace starts warm. */
  warm: WarmStatus | null = null;
  /** Resolves when nothing runs in the background (tests). */
  async idle(): Promise<void> {
    while (this.busy.size) await Promise.allSettled([...this.busy.values()]);
  }
}

/**
 * Fails the calls still marked running past their deadline (their time limit plus CALL_GRACE_MS): the process that ran them
 * died (a runner or dashboard pod replaced mid-call), so nothing will settle them. Rows without a deadline are the
 * session relay's own, taken over when its job resumes. Returns the rows failed.
 */
export async function sweepStuckCalls(db: Db, now: number): Promise<number> {
  return await failStuckCalls(db, new Date(now).toISOString());
}

type EnvRow = { id: string; enabled: boolean };
type Ctx = { d: LauncherDeps; state: WorkspaceState; api: KubeApi; env: EnvRow; s: KubeSettings; now: () => number; pass: WorkspacePass };

const clean = (s: string | undefined): string => (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
const errText = (e: unknown): string => clean(e instanceof Error ? e.message : String(e));

export async function workspacePass(d: LauncherDeps, state: WorkspaceState): Promise<void> {
  try {
    // Loaded here: the session module imports this one.
    const { sweepSessions } = await import("./workspace-session.ts");
    await sweepSessions(d.db, d.log);
  } catch (e) {
    d.log(`workspace launcher: session sweep: ${(e as Error).stack ?? e}`);
  }
  try {
    await sweepStuckCalls(d.db, (d.now ?? Date.now)());
  } catch (e) {
    d.log(`workspace launcher: call sweep: ${(e as Error).stack ?? e}`);
  }
  const api = d.api;
  if (!api) return;
  const envs = (await loadEnvPass(d.db, "workspace")).envs;
  for (const env of envs) {
    const s = envSettings(env);
    if (s.warmWriter) continue;
    try {
      await envPass({ d, state, api, env, s, now: d.now ?? Date.now, pass: { rows: [], calls: new Map(), bound: new Map() } });
    } catch (e) {
      d.log(`workspace launcher: ${env.id}: ${(e as Error).stack ?? e}`);
    }
  }
}

const liveRows = async (c: Ctx): Promise<WorkspaceRow[]> =>
  [...(await loadWorkspaces(c.d.db, { env: c.env.id, states: LIVE_STATES })).values()].sort((a, b) => a.id - b.id);

/** Patches a row only while columns of it still hold what the pass read. */
async function patchIf(c: Ctx, w: WorkspaceRow, whereState: WorkspaceStateName[], where: Partial<Pick<WorkspaceRow, "pvc" | "pod" | "checkpoint_error">>, set: Partial<Omit<WorkspaceRow, "id">>): Promise<boolean> {
  return await patchWorkspaces(c.d.db, [{ id: w.id, whereState, where, set }]) > 0;
}

async function envPass(c: Ctx): Promise<void> {
  const { api, s } = c;
  const ns = s.namespace;
  const [pods, pvcs] = await Promise.all([api.listPods(ns, workspaceEnvSelector(c.env.id)), api.listPvcs(ns, workspaceEnvSelector(c.env.id))]);
  c.pass = await loadWorkspacePass(c.d.db, c.env.id, c.now());
  for (const w of c.pass.rows) if (!c.state.busy.has(w.id)) await advance(c, w, pods);

  const back = c.state.backoff.get(c.env.id);
  if (c.env.enabled && !(back && back > c.now())) {
    const rows = await liveRows(c);
    let active = rows.filter((w) => POD_STATES.includes(w.state as WorkspaceStateName)).length;
    for (const w of rows) {
      if (w.state !== "requested" || c.state.busy.has(w.id)) continue;
      if (active >= s.workspaceSlots) break;
      if (w.layout === LAYOUT_CI && w.prepared === null) {
        if ((c.state.prepareTries.get(w.id)?.next ?? 0) <= c.now()) background(c, w.id, () => prepare(c, w.id));
        continue;
      }
      if (!await start(c, w)) break;
      active++;
    }
  }

  // Pods and volumes no live row owns: ended and failed workspaces, a parked one's old pod, a create that failed late, and
  // fetch pods whose workspace is no longer ready on the pod they were made for, or that outlived any fetch.
  const owned = await liveRows(c);
  const podNames = new Set(owned.filter((w) => POD_STATES.includes(w.state as WorkspaceStateName)).map((w) => w.pod));
  const pvcNames = new Set(owned.map((w) => w.pvc));
  const kept = (p: KPod): boolean => podNames.has(p.metadata.name) || fetchPodKept(p, owned, c.now());
  for (const p of pods) if (!kept(p) && !p.metadata.deletionTimestamp) await api.deletePod(ns, p.metadata.name).catch((e: Error) => c.d.log(`workspace launcher: delete pod ${p.metadata.name}: ${e.message}`));
  for (const v of pvcs) if (!pvcNames.has(v.metadata.name)) await api.deletePvc(ns, v.metadata.name).catch((e: Error) => c.d.log(`workspace launcher: delete volume ${v.metadata.name}: ${e.message}`));
  for (const m of [c.state.unknownSince, c.state.checkpointTried, c.state.prepareTries]) for (const id of m.keys()) if (!owned.some((w) => w.id === id)) m.delete(id);

  const n = (st: string) => owned.filter((w) => w.state === st).length;
  const line = `${n("starting") + n("seeding") + n("ready")}/${s.workspaceSlots} running (${n("ready")} ready), ${n("parked")} parked, ${n("requested")} waiting`;
  if (c.state.counts.get(c.env.id) !== line) {
    c.state.counts.set(c.env.id, line);
    c.d.log(`workspace launcher: ${c.env.id}: workspaces ${line}`);
  }
}

/** Runs `f` in the background as the workspace's one step in flight. */
function background(c: Ctx, id: number, f: () => Promise<void>): void {
  const p = (async () => {
    try {
      await f();
    } catch (e) {
      c.d.log(`workspace launcher: workspace ${id}: ${(e as Error).stack ?? e}`);
    } finally {
      c.state.busy.delete(id);
    }
  })();
  c.state.busy.set(id, p);
}

/** `kind` capacity: the pod was never scheduled (no node had room, or the quota was used), which a fix session does not count as a failed start. */
async function fail(c: Ctx, w: WorkspaceRow, reason: string, kind: "capacity" | null = null): Promise<void> {
  if (!await moveWorkspace(c.d.db, w.id, [w.state as WorkspaceStateName], "failed", { error: reason.slice(0, 300), fail_kind: kind }, c.now())) return;
  c.d.log(`workspace launcher: workspace ${w.id} failed: ${reason}`);
  if (w.pod) await c.api.deletePod(c.s.namespace, w.pod).catch(() => {});
  if (w.pvc) await c.api.deletePvc(c.s.namespace, w.pvc).catch(() => {});
}

/**
 * A workspace that could not start or seed. One that is resuming (it was ready before) goes back to parked with its kept
 * volume and its checkpoint, counting the try: the launcher resumes it again while its call is live, up to RESUME_TRIES.
 * Any other fails. A volume made for this start holds nothing the checkpoint lacks and is deleted.
 */
async function giveUp(c: Ctx, w: WorkspaceRow, reason: string, kind: "capacity" | null = null): Promise<void> {
  if (!w.base_commit) return fail(c, w, reason, kind);
  const tries = w.resume_tries + 1;
  const keep = w.pvc !== null && w.volume_fresh === 0;
  const what = `${keep ? "its volume" : ""}${keep && w.checkpoint_at ? " and " : ""}${w.checkpoint_at ? "its checkpoint" : ""}` || "nothing to rebuild from";
  const error = `${reason}${tries >= RESUME_TRIES ? `; resuming failed ${tries} times, so it stays parked with ${what}` : ` (resume try ${tries} of ${RESUME_TRIES})`}`;
  if (!await moveWorkspace(c.d.db, w.id, [w.state as WorkspaceStateName], "parked", { pod: null, pvc: keep ? w.pvc : null, node: keep ? w.node : null, volume_fresh: 0, resume_tries: tries, error: error.slice(0, 300) }, c.now())) return;
  c.d.log(`workspace launcher: workspace ${w.id} back to parked: ${error}`);
  if (w.pod) await c.api.deletePod(c.s.namespace, w.pod).catch(() => {});
  if (!keep && w.pvc) await c.api.deletePvc(c.s.namespace, w.pvc).catch(() => {});
}

type Images = { appImage: string; toolchainImage: string };

/** The images a workspace pod needs, or why the environment cannot start one. `defaultImage`: the runner's own (AUTOCRAFT_IMAGE). */
export function workspaceImages(s: KubeSettings, defaultImage: string | null): Images | string {
  const appImage = s.image ?? defaultImage;
  const toolchainImage = s.toolchainImages[WORKSPACE_TOOLCHAIN];
  if (!appImage) return "No AutoCraft image is known for workspace pods: set AUTOCRAFT_IMAGE on the runner or the environment's image";
  if (!toolchainImage) return `The environment has no ${WORKSPACE_TOOLCHAIN} toolchain image for workspace pods`;
  return { appImage, toolchainImage };
}
const imagesOf = (c: Ctx): Images | string => workspaceImages(c.s, c.d.defaultImage);

/** Starts a requested workspace. False when the environment should wait before the next create. */
async function start(c: Ctx, w: WorkspaceRow): Promise<boolean> {
  const images = imagesOf(c);
  if (typeof images === "string") {
    await giveUp(c, w, images);
    return true;
  }
  // A workspace that was ready before (it has a base commit) is resuming: its pod gets a new name, and so does a volume it rebuilds on.
  const name = workspaceName(w.id, w.base_commit ? c.now().toString(36) : undefined);
  const pvc = w.pvc ?? name;
  const fresh = w.pvc ? 0 : 1;
  let ci: Partial<Pick<WorkspaceRow, "warm" | "warm_commit">> = {};
  if (w.layout === LAYOUT_CI) {
    const warm = await planWarm(c, w, fresh === 1, images.toolchainImage);
    ci = { warm: JSON.stringify(warm), warm_commit: fresh ? warm.use?.commit ?? null : w.warm_commit };
    c.d.log(`workspace launcher: workspace ${w.id}: ${warm.use ? `starts warm from ${warm.use.key}@${warm.use.commit.slice(0, 12)} on ${warm.use.node} (${warm.use.target})` : warm.why ? `starts cold: ${warm.why}` : "keeps its volume's target"}`);
  }
  if (!await moveWorkspace(c.d.db, w.id, ["requested"], "starting", { pod: name, pvc, volume_fresh: fresh, create_tries: 0, error: null, ...ci }, c.now())) return true;
  return await create(c, { ...w, state: "starting", pod: name, pvc, volume_fresh: fresh, create_tries: 0, ...ci }, images);
}

// ---- layout 2 ------------------------------------------------------------------------

const parse = <T>(s: string | null): T | null => {
  try {
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
};
const preparedOf = (w: Pick<WorkspaceRow, "prepared">): WorkspacePrepared | null => parse<WorkspacePrepared>(w.prepared);

/** The pod-spec part of a layout-2 row; null for layout 1, or before its gate was read. */
export function ciLayoutOf(w: WorkspaceRow): WorkspaceCiLayout | null {
  const checkout = ciCheckout(w.repo);
  const prepared = preparedOf(w);
  if (w.layout !== LAYOUT_CI || !checkout || !prepared) return null;
  return { checkout, prepared, copy: warmOf(w)?.use ?? null };
}

/**
 * Reads a requested layout-2 workspace's CI gate at its base commit, as a build's source pod does, and the sha256 of the
 * base commit's Cargo.lock from AutoCraft's clone. A failed read is tried again after PREPARE_RETRY_MS, PREPARE_TRIES times.
 */
async function prepare(c: Ctx, id: number): Promise<void> {
  const { db } = c.d;
  const w = await getWorkspace(db, id);
  if (!w || w.state !== "requested" || w.prepared !== null) return;
  try {
    const f = c.d.fetchImpl ?? fetch;
    const gate = await resolveGate(w.repo, w.base_sha, f);
    const rev = gate ? await resolveI18nRev(w.repo, w.base_sha, f) : null;
    const g = await cloneWith(w.repo, w.base_sha);
    const lock = await g.git(["cat-file", "blob", `${w.base_sha}:Cargo.lock`]);
    const p: WorkspacePrepared = {
      env: gate ? gateStepEnv(gate, rev) : {}, craftFontsRef: gate?.craftFontsRef ?? null, craftI18nRev: rev, cacheVersion: gate?.cacheVersion ?? null,
      cargoLock: lock.code === 0 ? sha256(lock.stdout) : null,
    };
    await patchWorkspaces(db, [{ id, whereState: ["requested"], set: { prepared: JSON.stringify(p), error: null, updated_at: new Date(c.now()).toISOString() } }]);
    c.state.prepareTries.delete(id);
  } catch (e) {
    const tries = (c.state.prepareTries.get(id)?.tries ?? 0) + 1;
    const why = `The CI gate at ${w.base_sha.slice(0, 8)} could not be read: ${errText(e)}`;
    if (tries >= PREPARE_TRIES) {
      c.state.prepareTries.delete(id);
      return await giveUp(c, w, `${why} (${tries} tries)`);
    }
    c.state.prepareTries.set(id, { tries, next: c.now() + PREPARE_RETRY_MS });
    c.d.log(`workspace launcher: workspace ${id}: ${why} (try ${tries} of ${PREPARE_TRIES})`);
  }
}

/**
 * How a layout-2 workspace's target starts. A fresh volume is sized for the repository's warm version and starts from the
 * best node's version, or cold. A kept volume keeps its target.
 */
async function planWarm(c: Ctx, w: WorkspaceRow, fresh: boolean, image: string): Promise<WorkspaceWarm> {
  const { db } = c.d;
  const prev = warmOf(w);
  const key = warmKeyOf(w.repo);
  // The session's target always lives on its volume, whatever the repository's warm target says; that only decides warm or cold.
  const target: WarmTarget = fresh ? (await repoWarmTarget(db, w.repo) === "none" ? "none" : "pvc") : prev?.target === "pvc" ? "pvc" : "none";
  const storageBytes = fresh || !prev ? workspaceStorageBytes(quantity(c.s.workspaceStorage), target, await warmBytes(db, key)) : prev.storageBytes;
  const prepared = preparedOf(w);
  const checkout = ciCheckout(w.repo);
  if (!prepared || !checkout) return { target, storageBytes, use: null, why: "the workspace has no CI layout" };
  if (!fresh) return { target, storageBytes, use: null, why: null };
  const nodes = c.state.warm?.warmNodesFor(key) ?? [];
  const load = new Map<string, number>();
  for (const r of await liveRows(c)) {
    const n = r.node ?? warmOf(r)?.use?.node;
    if (n && r.id !== w.id) load.set(n, (load.get(n) ?? 0) + 1);
  }
  const d = chooseWarm({
    target, key, image, toolchain: c.state.warm?.toolchainOf(image) ?? null, prepared, checkout, nodes, load, memoryLimitBytes: quantity(c.s.workspaceMemoryLimit),
  });
  return { target, storageBytes, use: d.use, why: d.why };
}

/** A starting pod pinned to its warm node that the scheduler cannot place there: it starts again cold, wherever it fits. */
async function coldInstead(c: Ctx, w: WorkspaceRow, warm: WorkspaceWarm, why: string): Promise<void> {
  const name = workspaceName(w.id, c.now().toString(36));
  const next: WorkspaceWarm = { ...warm, use: null, why: `node ${warm.use?.node} had no room for it (${why})` };
  const at = new Date(c.now()).toISOString();
  if (!await patchIf(c, w, ["starting"], { pod: w.pod }, { pod: name, warm: JSON.stringify(next), warm_commit: null, create_tries: 0, pod_created_at: null, state_at: at, updated_at: at })) return;
  c.d.log(`workspace launcher: workspace ${w.id}: ${next.why}; starting cold on another node`);
  if (w.pod) await c.api.deletePod(c.s.namespace, w.pod).catch(() => {});
}

/** The row's warm plan once its volume is replaced by an empty one: nothing to copy from the old node. */
const lostWarm = (w: WorkspaceRow, why: string): Partial<Pick<WorkspaceRow, "warm" | "warm_commit">> => {
  const warm = warmOf(w);
  return warm ? { warm: JSON.stringify({ ...warm, use: null, why } satisfies WorkspaceWarm), warm_commit: null } : {};
};

/** A pod of the same name is still being deleted: the create is tried again once it is gone. */
class PodDeleting extends Error {}

/**
 * Creates the volume and pod of a starting workspace, counting the try. The row keeps its pod and volume names whatever
 * happens, so the sweep leaves objects a failed create may still have made. False after a failure.
 */
async function create(c: Ctx, row: WorkspaceRow, images: Images): Promise<boolean> {
  const { db } = c.d;
  let w = row;
  const ns = c.s.namespace;
  const tries = w.create_tries + 1;
  const at = new Date(c.now()).toISOString();
  await patchWorkspaces(db, [{ id: w.id, whereState: ["starting"], set: { create_tries: tries, pod_created_at: at, updated_at: at } }]);
  // A create that answered with an error may still have made the object; the name is the workspace's own.
  const conflict = (e: unknown) => e instanceof KubeError && e.status === 409;
  try {
    if (w.volume_fresh === 0 && w.pvc) {
      // The kept volume must still be there: a create would otherwise make an empty one of its name, which seeding would take for the kept tree.
      const v = (await c.api.listPvcs(ns, workspaceSelector(w.id))).find((x) => x.metadata.name === w.pvc);
      if (!v || v.metadata.deletionTimestamp) w = await freshVolume(c, w, v ? "its kept volume is being deleted" : "its kept volume is gone");
    }
    if (w.layout === LAYOUT_CI && !ciLayoutOf(w)) throw new Error("the workspace's CI layout is missing its gate");
    await c.api.createPvc(ns, workspacePvcSpec(c.s, c.env.id, w.id, w.pvc ?? undefined, warmOf(w)?.storageBytes)).catch((e: unknown) => {
      if (!conflict(e)) throw e;
    });
    effect("build-launch");
    await c.api.createPod(ns, workspacePodSpec({ s: c.s, envId: c.env.id, id: w.id, ...images, limits: limitsOf(w), pod: w.pod ?? undefined, pvc: w.pvc ?? undefined, ci: ciLayoutOf(w) ?? undefined })).catch(async (e: unknown) => {
      if (!conflict(e)) throw e;
      const old = (await c.api.listPods(ns, workspaceSelector(w.id))).find((p) => p.metadata.name === w.pod);
      if (old?.metadata.deletionTimestamp) throw new PodDeleting();
    });
    c.d.log(`workspace launcher: workspace ${w.id} (${w.repo}@${w.base_sha.slice(0, 8)}) starting on ${c.env.id}${tries > 1 ? ` (try ${tries})` : ""}`);
    return true;
  } catch (e) {
    if (e instanceof PodDeleting) {
      c.d.log(`workspace launcher: workspace ${w.id}: an earlier pod of the same name is still being deleted; creating again later`);
      return true;
    }
    // Quota, rate limits or an API error: tried again on a later pass, up to CREATE_TRIES.
    const why = `The workspace pod could not be created: ${errText(e)}`;
    c.state.backoff.set(c.env.id, c.now() + CREATE_BACKOFF_MS);
    c.d.log(`workspace launcher: workspace ${w.id}: ${why} (try ${tries} of ${CREATE_TRIES})`);
    if (tries >= CREATE_TRIES) await giveUp(c, w, why);
    else await patchWorkspaces(db, [{ id: w.id, whereState: ["starting"], set: { error: why.slice(0, 300) } }]);
    return false;
  }
}

function podFailure(pod: KPod): string {
  const st = pod.status;
  return `The workspace pod stopped${st?.reason ? ` (${st.reason}${st.message ? `: ${st.message}` : ""})` : ""}`.slice(0, 300);
}

async function advance(c: Ctx, w: WorkspaceRow, pods: KPod[]): Promise<void> {
  const now = c.now();
  const age = now - Date.parse(w.state_at);
  if (w.state === "parked") {
    const bound = w.resume_tries < RESUME_TRIES ? boundCall(c, w) : null;
    if (bound) {
      if (await resumeWorkspace(c.d.db, w.id, now)) c.d.log(`workspace launcher: workspace ${w.id} resuming for call ${w.remote_call_id} (${bound})${w.pvc ? " on its volume" : "; rebuilding from base and checkpoint"}`);
      return;
    }
    // TODO(AUTO-43): also delete parked volumes oldest first when the node's disk passes 70%, once there is a disk metric.
    // A volume whose last checkpoint failed holds the only copy of the latest work, so it stays (the row's error says why).
    if (w.pvc && age > PARKED_VOLUME_MS && w.checkpoint_error === null) {
      // The row lets go of the volume first, so a resume meanwhile starts on a new one instead of taking this one.
      if (!await patchIf(c, w, ["parked"], { pvc: w.pvc, checkpoint_error: null }, { pvc: null, node: null, updated_at: new Date(now).toISOString() })) return;
      await c.api.deletePvc(c.s.namespace, w.pvc);
      c.d.log(`workspace launcher: workspace ${w.id}: parked volume deleted after ${PARKED_VOLUME_MS / 60_000} min; the checkpoint stays`);
    } else if (!w.pvc && age > PARKED_END_MS) {
      // TODO(W7): end a parked workspace when its item closes, and keep it while the item is open.
      if (await moveWorkspace(c.d.db, w.id, ["parked"], "ended", {}, now)) c.d.log(`workspace launcher: workspace ${w.id} ended after ${PARKED_END_MS / 3600_000} h parked; the checkpoint stays`);
    }
    return;
  }
  if (!POD_STATES.includes(w.state as WorkspaceStateName)) return;
  const pod = pods.find((p) => p.metadata.name === w.pod);
  if (!pod) {
    if (w.state !== "starting") return lost(c, w, "The workspace pod disappeared (deleted, or its node went away)");
    // Not made, or gone before it started (a failed create, an old pod of the same name deleted meanwhile): create again.
    if (now - Date.parse(w.pod_created_at ?? w.state_at) < LIST_GRACE_MS) return;
    if (w.create_tries >= CREATE_TRIES) return giveUp(c, w, `The workspace pod could not be created in ${CREATE_TRIES} tries${w.error ? `: ${w.error}` : ""}`);
    const images = imagesOf(c);
    if (typeof images === "string") return giveUp(c, w, images);
    await create(c, w, images);
    return;
  }
  const deleting = pod.metadata.deletionTimestamp;
  if (deleting) {
    if (now - Date.parse(deleting) > STUCK_MS) return lost(c, w, "The workspace pod has been stuck in deletion (its node may be gone)");
    return;
  }
  const phase = pod.status?.phase;
  if (phase === "Unknown") {
    const since = c.state.unknownSince.get(w.id) ?? now;
    c.state.unknownSince.set(w.id, since);
    if (now - since > STUCK_MS) return lost(c, w, "The workspace pod's node stopped reporting");
    return;
  }
  c.state.unknownSince.delete(w.id);
  if (phase === "Succeeded" || phase === "Failed") {
    if (pod.status?.reason === "DeadlineExceeded") return (w.state === "ready" ? fail : giveUp)(c, w, `The workspace passed its time limit of ${Math.round(limitsOf(w).deadlineSec / 60)} min`);
    return lost(c, w, podFailure(pod));
  }

  if (w.state === "starting") {
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    const pull = statuses.find((x) => PULL_REASONS.has(x.state?.waiting?.reason ?? ""));
    if (pull && age > PULL_LIMIT_MS) return giveUp(c, w, `The workspace pod's container ${pull.name} could not start: ${pull.state!.waiting!.reason}${pull.state!.waiting!.message ? ` (${clean(pull.state!.waiting!.message)})` : ""}`);
    const main = pod.status?.containerStatuses?.find((x) => x.name === WS_CONTAINER);
    if (phase === "Running" && main?.ready && main.state?.running) {
      if (await moveWorkspace(c.d.db, w.id, ["starting"], "seeding", { node: pod.spec?.nodeName ?? null }, now)) {
        background(c, w.id, () => seed(c, w.id));
      }
      return;
    }
    const sched = pod.status?.conditions?.find((x) => x.type === "PodScheduled");
    const warm = warmOf(w);
    if (warm?.use && w.volume_fresh === 1 && sched?.status === "False" && now - Date.parse(w.pod_created_at ?? w.state_at) > WARM_PLACE_MS) {
      return coldInstead(c, w, warm, clean(sched.message ?? sched.reason ?? "not scheduled"));
    }
    // A resume onto a kept volume, which local-path pins to its node (`node`): a pod that cannot go there may mean the node is gone.
    if (w.volume_fresh === 0 && w.node !== null && sched?.status === "False" && now - Date.parse(w.pod_created_at ?? w.state_at) > RESUME_PENDING_MS) {
      const gone = await volumeNodeGone(c, w.node, sched.message ?? "", now);
      if (gone && w.checkpoint_error !== null) return giveUp(c, w, `${gone}, and the last checkpoint failed (${w.checkpoint_error}): the latest work is only on its volume`);
      if (gone) return dropVolume(c, w, gone);
    }
    if (age > PENDING_LIMIT_MS) {
      const unscheduled = sched?.status === "False";
      const why = unscheduled ? clean(sched.message ?? sched.reason ?? "not scheduled") : pull ? pull.state!.waiting!.reason! : "its container did not become ready";
      return giveUp(c, w, `The workspace pod did not start within ${PENDING_LIMIT_MS / 60_000} min: ${why}`, unscheduled ? "capacity" : null);
    }
    return;
  }
  if (w.state === "seeding") {
    // Nothing in flight for a seeding row: the runner restarted while it seeded.
    if (age > SEED_LIMIT_MS) return giveUp(c, w, `Seeding took longer than ${SEED_LIMIT_MS / 60_000} min`);
    background(c, w.id, () => seed(c, w.id));
    return;
  }
  // ready
  const lastCall = Math.max(Date.parse(w.state_at), w.last_call_at ? Date.parse(w.last_call_at) : 0);
  const bound = boundCall(c, w);
  if (bound === "leased" && now - lastCall > LEASE_TOUCH_MS) {
    const at = new Date(now).toISOString();
    await patchWorkspaces(c.d.db, [{ id: w.id, whereState: ["ready"], set: { last_call_at: at, updated_at: at } }]);
  } else if (!bound && now - lastCall > IDLE_PARK_MS && !callRunning(c, w.id, now) && !backgroundRunning(c, w, now)) return background(c, w.id, () => park(c, w.id));
  const tried = c.state.checkpointTried.get(w.id) ?? 0;
  const lastCheckpoint = Math.max(Date.parse(w.state_at), w.checkpoint_at ? Date.parse(w.checkpoint_at) : 0, tried);
  // A call back in the queue after its session did work: the next session's prompt states the checkpoint's changes.
  const requeued = bound === "queued" && w.last_call_at !== null && (w.checkpoint_at === null || w.last_call_at > w.checkpoint_at) && now - tried > REQUEUE_CHECKPOINT_MS;
  // A checkpoint waits for a dependency fetch, which rewrites Cargo.lock, and for a seed call (a fix session's reseed, restore
  // or dependency fetch), which replaces the tree: the next pass takes it. (a fix session's reseed, restore or dependency fetch) replaces the tree: the next pass takes it.
  if ((now - lastCheckpoint > CHECKPOINT_EVERY_MS || requeued) && !callRunning(c, w.id, now, "fetch_dependencies") && !callRunning(c, w.id, now, "seed")) {
    c.state.checkpointTried.set(w.id, now);
    background(c, w.id, async () => void await checkpoint(c, w.id));
  }
}

/** Whether a call (of `tool`, when given) is running in the workspace within its time limit (plus CALL_GRACE_MS); a row past it no longer holds the pod. */
function callRunning(c: Ctx, id: number, now: number, tool?: string): boolean {
  const at = new Date(now).toISOString();
  return !!c.pass.calls.get(id)?.running.some((r) => r.deadlineAt > at && (!tool || r.tool === tool));
}

/** The state of the remote call bound to the workspace while it is queued or leased (its session may still make tool calls), else null. */
function boundCall(c: Ctx, w: WorkspaceRow): "queued" | "leased" | null {
  return c.pass.bound.get(w.id) ?? null;
}

/**
 * Whether a background shell command the session started in the current pod may still run, by the session's bookkeeping
 * on its rows (WorkspaceSession): started, not seen ending by a shell_status or shell_kill, and within its own limit.
 */
function backgroundRunning(c: Ctx, w: WorkspaceRow, now: number): boolean {
  const rows = c.pass.calls.get(w.id)?.background ?? [];
  const ended = new Set(rows.filter((r) => r.tool !== "shell" && r.ended === 1).map((r) => r.ref));
  return rows.some((r) => r.tool === "shell" && r.bg === 1 && !ended.has(r.id) && r.startedAt !== null
    && Date.parse(r.startedAt) + (r.limit ?? 0) * 1000 + BACKGROUND_GRACE_MS > now);
}

/**
 * Why the node holding a kept volume is gone, or null when it may not be. Gone: the node does not exist, or has not been
 * ready for NODE_LOST_MS, or (when nodes cannot be read) the scheduler refused the pod on every node for the volume's
 * node affinity. Never for a node that is only full or tainted: the pod waits for it.
 */
async function volumeNodeGone(c: Ctx, node: string, message: string, now: number): Promise<string | null> {
  try {
    const n = await c.api.getNode(node);
    if (!n) return `its volume's node ${node} is gone`;
    const ready = n.status?.conditions?.find((x) => x.type === "Ready");
    const since = ready?.lastTransitionTime ? Date.parse(ready.lastTransitionTime) : NaN;
    if (ready && ready.status !== "True" && now - since > NODE_LOST_MS) return `its volume's node ${node} has not been ready since ${new Date(since).toISOString().slice(11, 16)}`;
    return null;
  } catch {
    // Nodes cannot be read: the scheduler's answer decides.
  }
  const m = /^0\/(\d+) nodes are available: ([^]*?)(?:preemption:|$)/.exec(message);
  if (!m) return null;
  let conflicts = 0;
  for (const x of m[2]!.matchAll(/(\d+) node\(s\) (?:had volume node affinity conflict|didn't match PersistentVolume's node affinity)/g)) conflicts += Number(x[1]);
  return Number(m[1]) > 0 && conflicts === Number(m[1]) ? "no node of the cluster can hold its volume (its node is gone)" : null;
}

/** Moves a starting workspace onto a new, empty volume, which seeding fills from the base and the checkpoint; returns the updated row. */
async function freshVolume(c: Ctx, w: WorkspaceRow, why: string): Promise<WorkspaceRow> {
  const name = workspaceName(w.id, c.now().toString(36));
  const at = new Date(c.now()).toISOString();
  const lost = lostWarm(w, why);
  if (!await patchIf(c, w, ["starting"], { pvc: w.pvc }, { pvc: name, node: null, volume_fresh: 1, updated_at: at, ...lost })) throw new Error("the workspace changed while its volume was replaced");
  c.d.log(`workspace launcher: workspace ${w.id}: ${why}; starting on a new volume rebuilt from base and ${w.checkpoint_at ? `the checkpoint of ${w.checkpoint_at}` : "no checkpoint"}${w.checkpoint_error ? ` (the last checkpoint failed: ${w.checkpoint_error})` : ""}`);
  return { ...w, pvc: name, node: null, volume_fresh: 1, ...lost };
}

/** The kept volume of a resuming workspace is lost with its node: the pod and volume are deleted and the workspace starts on a new volume. */
async function dropVolume(c: Ctx, w: WorkspaceRow, why: string): Promise<void> {
  const name = workspaceName(w.id, c.now().toString(36));
  const at = new Date(c.now()).toISOString();
  if (!await patchIf(c, w, ["starting"], { pod: w.pod, checkpoint_error: null }, { pod: name, pvc: name, node: null, volume_fresh: 1, create_tries: 0, pod_created_at: null, updated_at: at, ...lostWarm(w, why) })) return;
  c.d.log(`workspace launcher: workspace ${w.id}: ${why}; rebuilding on a new volume from base and ${w.checkpoint_at ? `the checkpoint of ${w.checkpoint_at}` : "no checkpoint"}`);
  if (w.pod) await c.api.deletePod(c.s.namespace, w.pod).catch(() => {});
  if (w.pvc) await c.api.deletePvc(c.s.namespace, w.pvc).catch(() => {});
}

/** The pod went away. A ready workspace keeps its volume and checkpoint (parked, for a resume); an earlier one gives up. */
async function lost(c: Ctx, w: WorkspaceRow, reason: string): Promise<void> {
  if (w.state !== "ready") return giveUp(c, w, reason);
  if (!await moveWorkspace(c.d.db, w.id, ["ready"], "parked", { pod: null, error: reason.slice(0, 300) }, c.now())) return;
  c.d.log(`workspace launcher: workspace ${w.id} parked: ${reason}`);
  if (w.pod) await c.api.deletePod(c.s.namespace, w.pod).catch(() => {});
}

// ---- seeding ---------------------------------------------------------------------

/** The tar of `sha` from AutoCraft's clone of `repo`, fetching the commit first when the clone lacks it. Refuses sources over `maxBytes`. */
export async function sourceArchive(repo: string, sha: string, maxBytes = MAX_SOURCE_BYTES): Promise<{ bytes: number; open: () => AsyncIterable<Buffer> }> {
  const g = await cloneWith(repo, sha);
  // The tar's size from the tree: a 512-byte header per entry and each blob padded to 512 bytes.
  let bytes = 1024;
  for (const e of (await g.must(["ls-tree", "-r", "-t", "-l", "-z", sha])).split("\0")) {
    const m = /^\d+ \w+ [0-9a-f]+ +(\d+|-)\t/.exec(e);
    if (m) bytes += 512 + (m[1] === "-" ? 0 : Math.ceil(Number(m[1]) / 512) * 512);
  }
  if (bytes > maxBytes) throw new Error(`the source of ${repo}@${sha.slice(0, 8)} is ${Math.round(bytes / 1024 ** 2)} MiB, over the ${maxBytes / 1024 ** 2} MiB limit`);
  const env = { ...process.env, ...GIT_ENV, ...gitDirEnv(g.dir) };
  return {
    bytes,
    open: async function* () {
      const p = spawn("git", [...HARDENING, "archive", "--format=tar", sha], { env, stdio: ["ignore", "pipe", "ignore"] });
      const closed = new Promise<number | null>((ok) => {
        p.on("close", (code) => ok(code));
        p.on("error", () => ok(null));
      });
      try {
        for await (const chunk of p.stdout) yield chunk as Buffer;
        if (await closed !== 0) throw new Error("git archive failed");
      } finally {
        if (p.exitCode === null) p.kill();
      }
    },
  };
}

/** AutoCraft's clone of `repo`, with `sha` fetched (as refs/workspace/<ref>) when it lacks it. */
async function cloneWith(repo: string, sha: string, ref = "base"): Promise<Git> {
  const g = new Git(exec, fixupDir(), repo);
  await g.init();
  if ((await g.git(["cat-file", "-e", `${sha}^{commit}`])).code !== 0) {
    await g.must(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", `https://github.com/${ownerOf(repo)}/${repo}.git`, `+${sha}:refs/workspace/${ref}`]);
  }
  return g;
}

/**
 * The base commit's files that differ from the warm commit's, with the deleted-file rule of a build pod's list
 * (warm-copy.ts changedFrom), from AutoCraft's clone.
 */
export async function warmChanges(repo: string, warmCommit: string, base: string): Promise<{ files: string[] | null; dirs?: string[] }> {
  const g = await cloneWith(repo, base);
  if ((await g.git(["cat-file", "-e", `${warmCommit}^{commit}`])).code !== 0) await cloneWith(repo, warmCommit, "warm");
  const tree = parseLsTree(await g.must(["ls-tree", "-r", "-z", "--full-tree", warmCommit]));
  const head = parseLsTree(await g.must(["ls-tree", "-r", "-z", "--full-tree", base]));
  const dirs = new Set<string>();
  for (const p of head.keys()) for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i));
  return changedFrom(tree, head, (d) => dirs.has(d));
}

/**
 * Whether the Cargo.lock files of `to` differ from those of `from`, read in AutoCraft's clone; with `from` null, whether `to` has
 * any. A clone that cannot tell counts as a difference.
 */
export async function cargoLocksDiffer(repo: string, from: string | null, to: string): Promise<boolean> {
  try {
    const g = await cloneWith(repo, to);
    if (from === null) return (await g.must(["ls-tree", "-r", "-z", "--name-only", to])).split("\0").some((p) => p === "Cargo.lock" || p.endsWith("/Cargo.lock"));
    if ((await g.git(["cat-file", "-e", `${from}^{commit}`])).code !== 0) await cloneWith(repo, from, "warm");
    return (await g.git(["diff", "--quiet", from, to, "--", "Cargo.lock", ":(glob)**/Cargo.lock"])).code !== 0;
  } catch {
    return true;
  }
}

/** The base commit `ws untar` made, or null when it failed. */
const untarCommit = (r: WsCallResult): string | null => (r.header?.kind === "ok" && /^[0-9a-f]{40}$/.test(r.header.fields[0] ?? "") ? r.header.fields[0]! : null);

async function seed(c: Ctx, id: number): Promise<void> {
  const { db } = c.d;
  const w = await getWorkspace(db, id);
  if (!w || w.state !== "seeding") return;
  const deadline = Date.parse(w.state_at) + SEED_LIMIT_MS;
  if (w.base_commit && w.volume_fresh === 0) return await seedKept(c, w, w.base_commit, deadline);
  try {
    // A volume made for this start: an earlier seed cut off by a restart may be wiped.
    const src = await sourceArchive(w.repo, w.base_sha);
    const untar = async () => await execWs(db, c.api, id, ["untar"], { tool: "seed", args: { repo: w.repo, sha: w.base_sha, bytes: src.bytes }, stdin: src.open(), timeoutMs: Math.max(10_000, deadline - c.now()) }, c.now);
    let r = await untar();
    if (r.header?.kind === "error" && r.header.code === "conflict") {
      // An earlier seed was cut off (a restart): start again from an empty tree. In layout 2 /work/src links to the checkout,
      // whose `target` is a mount point that stays.
      const find = w.layout === LAYOUT_CI ? ["find", "/work/src/", "-mindepth", "1", "-maxdepth", "1", "!", "-name", "target", "-exec", "rm", "-rf", "--", "{}", "+"] : ["find", "/work/src", "-mindepth", "1", "-delete"];
      const wipe = await execWs(db, c.api, id, ["run", "300", "--", ...find], { tool: "seed", args: { wipe: true }, timeoutMs: 310_000 }, c.now);
      if (wipe.header?.kind !== "status" || wipe.header.exit !== 0) throw new Error(`could not empty /work/src: ${describeHeader(wipe.header)}`);
      r = await untar();
    }
    const commit = untarCommit(r);
    if (!commit) throw new Error(`ws untar: ${r.error ?? describeHeader(r.header)}${r.stderr ? `: ${r.stderr.trim().split("\n").pop()}` : ""}`);
    // Before the checkpoint: the files it changes get newer mtimes when it applies.
    const ci = w.layout === LAYOUT_CI ? await seedCi(c, w, deadline) : {};
    const applied = w.base_commit ? await applyCheckpoint(c, id) : false;
    const restored = !w.base_commit ? null : applied && w.checkpoint_at ? `checkpoint ${w.checkpoint_at}` : "empty";
    const at = new Date(c.now()).toISOString();
    if (await moveWorkspace(db, id, ["seeding"], "ready", { base_commit: commit, volume_fresh: 0, resume_tries: 0, ...(restored && { restored, restored_at: at }), ...ci }, c.now())) {
      c.d.log(`workspace launcher: workspace ${id} ${w.base_commit ? `rebuilt from base and ${applied ? `the checkpoint of ${w.checkpoint_at}` : "no checkpoint"}` : "ready"} (base ${commit.slice(0, 8)})`);
    }
  } catch (e) {
    await giveUp(c, w, `Seeding failed: ${errText(e)}`);
  }
}

/**
 * Seeding a resume onto a kept volume: the volume holds the tree and every change since the last checkpoint, so it is only
 * checked for the base commit, never seeded or wiped. An unclear answer is asked again until SEED_LIMIT_MS; a volume
 * without the base commit, or no answer in time, sends the workspace back to parked with the volume as it is.
 */
async function seedKept(c: Ctx, w: WorkspaceRow, base: string, deadline: number): Promise<void> {
  const { db } = c.d;
  let why = "no answer";
  for (let i = 0; i < SEED_LIMIT_MS / KEPT_RETRY_MS; i++) {
    try {
      const r = await execWs(db, c.api, w.id, ["run", "60", "--", "git", "cat-file", "-e", `${base}^{commit}`], { tool: "seed", args: { resume: "check" }, timeoutMs: 70_000 }, c.now);
      if (r.header?.kind === "status" && r.header.state === "exited") {
        if (r.header.exit !== 0) return await giveUp(c, w, `The kept volume does not hold the base commit ${base.slice(0, 8)} (git exit ${r.header.exit}); the volume is left as it is`);
        const at = new Date(c.now()).toISOString();
        if (await moveWorkspace(db, w.id, ["seeding"], "ready", { resume_tries: 0, restored: "kept", restored_at: at }, c.now())) c.d.log(`workspace launcher: workspace ${w.id} resumed on its volume`);
        return;
      }
      why = r.error ?? describeHeader(r.header);
    } catch (e) {
      why = errText(e);
    }
    if (c.now() + KEPT_RETRY_MS >= deadline || (await getWorkspace(db, w.id))?.state !== "seeding") break;
    await new Promise((r) => setTimeout(r, KEPT_RETRY_MS));
  }
  const now = await getWorkspace(db, w.id);
  if (now?.state === "seeding") await giveUp(c, now, `The kept volume could not be checked: ${why}`);
}

/** Seeding's layout-2 part on a fresh volume: the gate's checkouts, then the outcome of the warm copy and the checkout's mtimes. */
async function seedCi(c: Ctx, w: WorkspaceRow, deadline: number): Promise<Partial<Pick<WorkspaceRow, "warm" | "warm_commit">>> {
  const prepared = preparedOf(w);
  if (!prepared) throw new Error("the workspace's CI layout is missing its gate");
  for (const [name, ref] of [["craft-fonts", prepared.craftFontsRef], ["craft-i18n", prepared.craftI18nRev]] as const) if (ref) await putExt(c, w.id, name, ref, deadline);
  const warm = warmOf(w);
  return warm ? await warmDone(c, w, warm, true) : {};
}

const EXT_SH = 'set -e; d=/work/ext/$1; find "$d" -mindepth 1 -delete; tar -x -f "/work/.ws/$1.tar" -C "$d" --no-same-owner --no-same-permissions; rm -f "/work/.ws/$1.tar"';

/** Copies a checkout the CI gate mounts (craft-fonts, craft-i18n) at `ref` from AutoCraft's clone into the volume's `ext/<name>`. */
async function putExt(c: Ctx, id: number, name: "craft-fonts" | "craft-i18n", ref: string, deadline: number): Promise<void> {
  const { db } = c.d;
  const src = await sourceArchive(name, ref, EXT_ARCHIVE_MAX_BYTES);
  const left = () => Math.max(10_000, deadline - c.now());
  const put = await execWs(db, c.api, id, ["put", `/work/.ws/${name}.tar`], { tool: "seed", args: { ext: name, ref, bytes: src.bytes }, stdin: src.open(), timeoutMs: left() }, c.now);
  if (put.header?.kind !== "ok") throw new Error(`${name} could not be copied in: ${put.error ?? describeHeader(put.header)}`);
  const r = await execWs(db, c.api, id, ["run", "300", "--", "sh", "-c", EXT_SH, "ext", name], { tool: "seed", args: { ext: name, unpack: true }, timeoutMs: 310_000 }, c.now);
  if (r.header?.kind !== "status" || r.header.state !== "exited" || r.header.exit !== 0) throw new Error(`${name} could not be unpacked (${r.error ?? describeHeader(r.header)})`);
}

/**
 * What warm-copy did in the current pod (its mark on the volume), as the row's note: the copy's size and time, or why it
 * started cold. With `mtimes` (a fresh checkout) it then sets the checkout's mtimes against the warm commit: every file old
 * and the changed ones new when the version is trimmed and the list is known, else every file new.
 */
async function warmDone(c: Ctx, w: WorkspaceRow, warm: WorkspaceWarm, mtimes: boolean): Promise<Partial<Pick<WorkspaceRow, "warm" | "warm_commit">>> {
  const { db } = c.d;
  const at = new Date(c.now()).toISOString();
  const done = (note: string, commit: string | null) => {
    c.d.log(`workspace launcher: workspace ${w.id}: ${note}`);
    return { warm: JSON.stringify({ ...warm, note, at } satisfies WorkspaceWarm), warm_commit: commit };
  };
  const use = warm.use;
  if (!use) return done(warm.why ? `started cold: ${warm.why}` : "kept its volume's target", mtimes ? null : w.warm_commit);
  const raw = await execInWorkspace(db, c.api, w.id, ["cat", `/work/${COPY_MARK_FILE}`], { maxOut: 4096, timeoutMs: 30_000 });
  const mark = raw.exitCode === 0 ? parse<CopyMark>(raw.stdout.toString("utf8")) : null;
  if (mark?.state !== "done" || mark.commit !== use.commit) return done(`started cold: ${mark?.why ?? "the warm copy left no result"}`, null);
  let how = "";
  if (mtimes) {
    const ch = mark.trimmed ? await warmChanges(w.repo, use.commit, w.base_sha).catch((e: Error) => ({ error: errText(e) })) : null;
    let list = ch && "files" in ch && ch.files ? { files: ch.files, dirs: ch.dirs ?? [] } : null;
    if (list) {
      const put = async (file: string, paths: string[]) => {
        const r = await execWs(db, c.api, w.id, ["put", file], { tool: "seed", args: { warm: "changed", paths: paths.length }, stdin: Buffer.from(paths.join("\0")), timeoutMs: 120_000 }, c.now);
        if (r.header?.kind !== "ok") throw new Error(`the changed-file list could not be copied in: ${r.error ?? describeHeader(r.header)}`);
      };
      try {
        await put(WARM_CHANGED_FILES, list.files);
        await put(WARM_CHANGED_DIRS, list.dirs.map((d) => d || "."));
      } catch (e) {
        list = null;
      }
    }
    const mode = list ? "list" : "all";
    const r = await execWs(db, c.api, w.id, ["run", "600", "--", "sh", "-c", WARM_MTIMES_SH, "mtimes", mode], { tool: "seed", args: { warm: "mtimes", mode }, timeoutMs: 610_000 }, c.now);
    if (r.header?.kind !== "status" || r.header.state !== "exited" || r.header.exit !== 0) throw new Error(`the checkout's mtimes could not be set (${r.error ?? describeHeader(r.header)})`);
    how = list ? `; ${list.files.length} files changed since ${use.commit.slice(0, 12)}`
      : `; every file counts as changed (${!mark.trimmed ? "the version may hold units its build did not check" : ch && "error" in ch ? `no list of changed files: ${ch.error}` : "too many files changed"})`;
  }
  return done(`warm copy ${((mark.bytes ?? use.bytes) / 1e9).toFixed(1)} GB in ${Math.round(mark.secs ?? 0)} s from ${use.key}@${use.commit.slice(0, 12)} on ${use.node} (${use.target === "pvc" ? "volume" : "memory"})${how}`, use.commit);
}

/** Applies the stored checkpoint to a rebuilt tree; false when there is none. Throws when it does not apply. */
async function applyCheckpoint(c: Ctx, id: number): Promise<boolean> {
  const { db } = c.d;
  const diff = await getCheckpoint(db, id);
  if (!diff?.length) return false;
  const put = await execWs(db, c.api, id, ["put", RESUME_FILE], { tool: "seed", args: { resume: "checkpoint", bytes: diff.length }, stdin: Buffer.from(diff), timeoutMs: 120_000 }, c.now);
  if (put.header?.kind !== "ok") throw new Error(`the checkpoint could not be copied in: ${put.error ?? describeHeader(put.header)}`);
  const r = await execWs(db, c.api, id, ["run", "300", "--", "git", "apply", "--binary", "--whitespace=nowarn", RESUME_FILE], { tool: "seed", args: { resume: "apply" }, timeoutMs: 310_000 }, c.now);
  if (r.header?.kind !== "status" || r.header.state !== "exited" || r.header.exit !== 0) {
    throw new Error(`the checkpoint does not apply (${r.error ?? describeHeader(r.header)})${r.output.trim() ? `: ${clean(r.output.trim().split("\n").pop())}` : ""}`);
  }
  return true;
}

// ---- checkpoints and parking -------------------------------------------------------

/**
 * Stores the workspace's diff against its base commit. Problems are recorded on the row and never fail the workspace; false then,
 * and when nothing was stored. Both writes hold only while the row is at the tree the diff was read from: a reseed or a restore
 * meanwhile (a new base commit or restored_at) makes the diff stale.
 */
async function checkpoint(c: Ctx, id: number): Promise<boolean> {
  const { db } = c.d;
  const w = await getWorkspace(db, id);
  if (w?.state !== "ready" || !w.base_commit) return false;
  const same = { base_commit: w.base_commit, restored_at: w.restored_at };
  // While checkpoint_error is set the volume holds work no checkpoint has, so it is not deleted with time or dropped with a lost node.
  const problem = async (why: string) => {
    await patchWorkspaces(db, [{ id, whereState: ["ready"], where: same, set: { error: `checkpoint: ${why}`.slice(0, 300), checkpoint_error: why.slice(0, 300), updated_at: new Date(c.now()).toISOString() } }]);
    c.d.log(`workspace launcher: workspace ${id}: checkpoint: ${why}`);
    return false;
  };
  try {
    const r = await execWs(db, c.api, id, ["run", "300", "--", "sh", "-c", CHECKPOINT_SH, "checkpoint", w.base_commit], { tool: "checkpoint", timeoutMs: 310_000 }, c.now);
    if (r.header?.kind !== "status" || r.header.state !== "exited" || r.header.exit !== 0) {
      return await problem(`the diff failed (${r.error ?? describeHeader(r.header)})${r.output.trim() ? `: ${clean(r.output.trim().split("\n").pop())}` : ""}`);
    }
    const raw = await execInWorkspace(db, c.api, id, ["head", "-c", String(MAX_CHECKPOINT_BYTES + 1), CHECKPOINT_FILE], { maxOut: MAX_CHECKPOINT_BYTES + 1, timeoutMs: 120_000 });
    if (raw.exitCode !== 0) return await problem(`the diff could not be read (${raw.error ?? `exit ${raw.exitCode}`})`);
    if (raw.stdout.length > MAX_CHECKPOINT_BYTES) return await problem(`the diff is over ${MAX_CHECKPOINT_BYTES / 1024 ** 2} MiB; the previous checkpoint is kept`);
    const at = new Date(c.now()).toISOString();
    return await patchWorkspaces(db, [{ id, whereState: ["ready"], where: same, set: { checkpoint: raw.stdout, checkpoint_at: at, checkpoint_error: null, error: null, updated_at: at } }]) > 0;
  } catch (e) {
    return await problem(errText(e));
  }
}

async function park(c: Ctx, id: number): Promise<void> {
  if (!await checkpoint(c, id)) c.d.log(`workspace launcher: workspace ${id}: parking without a new checkpoint; its volume is kept until one succeeds`);
  const w = await getWorkspace(c.d.db, id);
  if (w?.state !== "ready") return;
  if (!await moveWorkspace(c.d.db, id, ["ready"], "parked", { pod: null }, c.now())) return;
  if (w.pod) await c.api.deletePod(c.s.namespace, w.pod).catch((e: Error) => c.d.log(`workspace launcher: delete pod ${w.pod}: ${e.message}`));
  c.d.log(`workspace launcher: workspace ${id} parked after ${IDLE_PARK_MS / 60_000} min without a call`);
}
