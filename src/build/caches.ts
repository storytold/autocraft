// The warm caches report: what each node's warm-sync agent holds, where the runner placed each key, the warm producer's
// state per repository and the crate mirror's git allowlist (hand-kept and derived) (GET /api/envs/caches, `autocraft-server envs caches`).
// Only the runner reads the Kubernetes API, so its pod launcher stores what it read in the settings row CACHE_REPORT_KEY
// (CacheReporter); the dashboard and the CLI combine that with the warm tasks and settings in the database (cacheReport).
// The row is bookkeeping for the planner and bumps only the `envs` topic (src/live.ts).
import type { CacheHeld, CacheNode, CachePlaced, CacheRepo, CacheReport, TaskState } from "../../web/src/api/types.ts";
import { normalizeRepo } from "../cratemirror/git.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";
import { filtered, isHiddenRepo, type HiddenRepos } from "../hidden-sql.ts";
import { loadCacheReport, saveWarmReport } from "../data/build/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import type { Placement } from "../warm/placement.ts";
import type { NodeStatus } from "../warm/sync-agent.ts";
import type { ConfigMapApi } from "./kube-api.ts";
import { settingsOf } from "./pods.ts";
import { autoWarmTarget } from "./sizing.ts";
import { warmKeyOf } from "./tasks.ts";
import { WARM_TARGETS } from "./warm-mount.ts";
import type { WarmPlacer } from "./warm-place.ts";
import { warmCoverage, warmTaskImage, warmWriter } from "./warm-queue.ts";
import { STATUS_NAMESPACE, STATUS_STALE_MS, type WarmStatus } from "./warm-status.ts";

/** The crate mirror's git allowlist (one `owner/repo` per line, `#` comments), in the warm status namespace. */
export const MIRROR_ALLOWLIST_CONFIGMAP = "crate-mirror-git-allowlist";
export const MIRROR_ALLOWLIST_DATA_KEY = "allowlist.txt";
/** The list AutoCraft derives from the tracked repos' Cargo.lock files (src/build/mirror-sources.ts), with the same data key. */
export const MIRROR_DERIVED_CONFIGMAP = "crate-mirror-git-derived";
/** The row is rewritten at least this often while only report times move, and the allowlist is read this often. */
const REFRESH_MS = 5 * 60_000;

/** What the runner stores: its last reads, times in ms. */
export type StoredCaches = {
  version: 1;
  readAt: number | null;
  nodes: NodeStatus[];
  placement: Placement | null;
  placementNote: string | null;
  mirror: { allowlist: string[] | null; error: string | null; readAt: number } | null;
};

/** The repositories in an allowlist file's text, sorted, as the mirror reads them. */
export const parseAllowlist = (text: string): string[] =>
  [...new Set(text.split("\n").map((l) => l.replace(/#.*/, "")).join("\n").split(/[\s,]+/).flatMap((e) => normalizeRepo(e) ?? []))].sort();

/** The runner's half: stores the launcher's warm status, placement and mirror allowlist reads when they change. */
export class CacheReporter {
  private written = "";
  private shape = "";
  private writtenAt = -Infinity;
  private mirror: StoredCaches["mirror"] = null;
  private mirrorAt = -Infinity;
  private readonly api: Pick<ConfigMapApi, "getConfigMap"> | null;
  private readonly now: () => number;

  constructor(api: Pick<ConfigMapApi, "getConfigMap"> | null, now: () => number = Date.now) {
    this.api = api;
    this.now = now;
  }

  private async readMirror(): Promise<StoredCaches["mirror"]> {
    const ns = envVar("WARM_STATUS_NAMESPACE") ?? STATUS_NAMESPACE;
    const name = envVar("MIRROR_ALLOWLIST_CONFIGMAP") ?? MIRROR_ALLOWLIST_CONFIGMAP;
    const readAt = this.now();
    try {
      const cm = await this.api!.getConfigMap(ns, name);
      const text = cm?.data?.[MIRROR_ALLOWLIST_DATA_KEY];
      if (text === undefined) return { allowlist: null, error: cm ? `ConfigMap ${name} in ${ns} has no ${MIRROR_ALLOWLIST_DATA_KEY}` : `ConfigMap ${name} is missing in ${ns}`, readAt };
      // The mirror also serves the derived list (src/build/mirror-sources.ts); without that ConfigMap it serves the hand-kept one alone.
      const derived = (await this.api!.getConfigMap(ns, MIRROR_DERIVED_CONFIGMAP))?.data?.[MIRROR_ALLOWLIST_DATA_KEY] ?? "";
      return { allowlist: parseAllowlist(`${text}\n${derived}`), error: null, readAt };
    } catch (e) {
      return { allowlist: null, error: (e as Error).message.slice(0, 300), readAt };
    }
  }

  /** `mirrorUsed`: an environment's pods fetch through the crate mirror, so its allowlist is worth reading. */
  async pass(db: Db, warm: WarmStatus, placer: WarmPlacer | null, mirrorUsed: boolean): Promise<void> {
    const now = this.now();
    if (!mirrorUsed || !this.api) this.mirror = null;
    else if (now - this.mirrorAt >= REFRESH_MS) {
      this.mirrorAt = now;
      this.mirror = await this.readMirror();
    }
    const report: StoredCaches = { version: 1, readAt: warm.readOkAt, nodes: warm.all(), placement: placer?.current ?? null, placementNote: placer?.note ?? null, mirror: this.mirror };
    const full = JSON.stringify(report);
    if (full === this.written) return;
    // Node statuses are rewritten every 5 minutes with only `updated` moving: those changes wait for the refresh.
    const shape = JSON.stringify({ ...report, readAt: null, nodes: report.nodes.map((n) => ({ ...n, updated: 0 })), mirror: report.mirror && { ...report.mirror, readAt: 0 } });
    if (shape === this.shape && now - this.writtenAt < REFRESH_MS) return;
    await saveWarmReport(db, full);
    this.written = full;
    this.shape = shape;
    this.writtenAt = now;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The nodes and the placement as a reader sees them. `published` is each key's last successful warm build commit; a key
 * without one takes the newest version a fresh node holds. `repoOf` names a key's repository (null: none known) and returns
 * undefined for a key the reader may not see.
 */
export function cacheNodes(stored: Pick<StoredCaches, "nodes" | "placement">, published: Map<string, string>, now: number, repoOf: (key: string) => string | null | undefined): { nodes: CacheNode[]; placement: CachePlaced[] | null } {
  const fresh = (s: NodeStatus) => now - s.updated <= STATUS_STALE_MS;
  const newest = new Map(published);
  const best = new Map<string, number>();
  for (const s of stored.nodes.filter(fresh)) {
    for (const [key, k] of Object.entries(s.keys)) {
      if (published.has(key) || (best.get(key) ?? -Infinity) >= k.stored) continue;
      best.set(key, k.stored);
      newest.set(key, k.commit);
    }
  }
  const shown = (key: string) => repoOf(key) !== undefined;
  const placedOn = (key: string, node: string): boolean | null => (stored.placement ? stored.placement.keys.some((p) => p.key === key && p.nodes.includes(node)) : null);
  const nodes = stored.nodes.map((s): CacheNode => ({
    node: s.node, updated: iso(s.updated), fresh: fresh(s),
    fs: s.fs ?? null, warmBytes: s.warmBytes ?? null,
    keys: Object.entries(s.keys).filter(([key]) => shown(key)).map(([key, k]): CacheHeld => ({
      key, repo: repoOf(key) ?? null, commit: k.commit, bytes: k.bytes, image: k.image, stored: iso(k.stored), synced: iso(k.synced),
      newest: newest.get(key) === k.commit, placed: placedOn(key, s.node),
    })).sort((a, b) => (a.repo ?? a.key).localeCompare(b.repo ?? b.key)),
    pending: Object.entries(s.pending ?? {}).filter(([key]) => shown(key)).map(([key, why]) => ({ key, repo: repoOf(key) ?? null, why })),
    badBlobs: Object.entries(s.badBlobs ?? {}).filter(([key, b]) => shown(key) && b.length).map(([key, b]) => ({ key, repo: repoOf(key) ?? null, count: b.length })),
    error: typeof s.error === "string" && s.error ? s.error : null,
  })).sort((a, b) => a.node.localeCompare(b.node));
  const byNode = new Map(stored.nodes.map((s) => [s.node, s]));
  const placement = stored.placement && stored.placement.keys.filter((p) => shown(p.key)).map((p): CachePlaced => ({
    key: p.key, repo: repoOf(p.key) ?? null,
    nodes: p.nodes.map((node) => {
      const s = byNode.get(node), k = s?.keys[p.key];
      return { node, fresh: !!s && fresh(s), holds: !k ? "none" as const : k.commit === newest.get(p.key) ? "newest" as const : "older" as const };
    }),
  }));
  return { nodes, placement };
}

/** The report for a reader who may not see the `hidden` repositories. */
export async function cacheReport(db: Db, hidden: HiddenRepos, now = Date.now()): Promise<CacheReport> {
  const [cov, tracked, writer] = await db.together(async () => await Promise.all([warmCoverage(db), loadTrackedRepos(db), warmWriter(db)]));
  const covered = new Map(cov.repos.map((r) => [r.repo, r.why]));
  const known = [...new Set([...tracked.keys(), ...covered.keys(), ...cov.added, ...cov.excluded])];
  const inputs = await loadCacheReport(db, known, { hiddenRepos: hidden, staff: false });
  const stored = inputs.stored as StoredCaches | null;
  const { taskRepos, last, done, bytes, heads } = inputs;
  const keyRepo = new Map([...known, ...taskRepos].map((r) => [warmKeyOf(r), r]));
  const visible = (repo: string | null) => (repo ? !isHiddenRepo(hidden, repo) : !filtered(hidden));
  const repoOf = (key: string) => {
    const repo = keyRepo.get(key) ?? null;
    return visible(repo) ? repo : undefined;
  };

  const listed = [...new Set([...covered.keys(), ...cov.added, ...cov.excluded, ...taskRepos])].filter((r) => visible(r)).sort();
  const keys = listed.map(warmKeyOf);
  const sizes = inputs.warmTargets;

  const published = new Map([...done.values()].map((r) => [warmKeyOf(r.repo), r.head_sha]));
  const { nodes, placement } = stored ? cacheNodes(stored, published, now, repoOf) : { nodes: [], placement: null };
  const freshNodes = stored?.nodes.filter((s) => now - s.updated <= STATUS_STALE_MS) ?? [];

  const repos = listed.map((repo, i): CacheRepo => {
    const key = keys[i]!, head = heads.get(repo) ?? null, l = last.get(repo), d = done.get(repo);
    const image = d ? warmTaskImage(d) : null;
    const set = sizes.get(repo);
    const isSet = (WARM_TARGETS as readonly string[]).includes(set ?? "");
    const b = bytes.get(key) ?? null;
    return {
      repo, key,
      coverage: cov.excluded.includes(repo) ? "excluded" : covered.get(repo) ?? "none",
      freshness: !d ? "never" : writer?.image && image !== writer.image ? "image" : head && d.head_sha !== head ? "behind" : "current",
      head,
      last: l ? { id: l.id, state: l.state as TaskState, summary: l.summary, headSha: l.head_sha, endedAt: l.ended_at } : null,
      published: d ? { id: d.id, headSha: d.head_sha, image, endedAt: d.ended_at } : null,
      warmTarget: isSet ? (set as CacheRepo["warmTarget"]) : autoWarmTarget(b), warmTargetSource: isSet ? "operator" : "auto",
      bytes: b,
      nodes: d ? freshNodes.filter((s) => s.keys[key]?.commit === d.head_sha).length : 0, of: freshNodes.length,
    };
  });

  const mirrorEnvs = inputs.kubeEnvs.filter((e) => settingsOf(e.settings).crateMirror).map((e) => e.id);
  const m = stored?.mirror;
  return {
    readAt: stored?.readAt ? iso(stored.readAt) : null,
    nodes, placement, placementNote: stored?.placementNote ?? null,
    writer, repos,
    mirror: m ? { allowlist: m.allowlist, error: m.error, readAt: iso(m.readAt), envs: mirrorEnvs } : null,
  };
}
