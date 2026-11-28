// Key names of the `build_state` rows and the warm key of a repo. Internal to the build module.
import { createHash } from "node:crypto";

/** The warm-cache key of a repo name: a readable slug (at most 49 characters) and a hash of the lowercased name, so distinct names never share a key. */
export function warmKeyOfRepo(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 49).replace(/-+$/, "") || "repo";
  return `${slug}-${createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 14)}`;
}

export const WARM_REPORT_KEY = "warm_report";
export const WARM_GC_KEY = "warm_gc_at";
export const WARM_TRIMMED_KEY = "warm_trimmed_publish";
export const PENDING_UPDATE_KEY = "worker_update_pending";
export const UPDATE_FAILURES_KEY = "worker_update_failures";
export const ENDPOINT_KEY = "leader:runner:endpoint";
export const warmBytesKey = (key: string): string => `warm_bytes:${key}`;
export const warmRebuildKey = (repo: string): string => `warm_rebuild:${repo}`;
export const mirrorSourcesKey = (repo: string): string => `mirror_git_sources:${repo}`;
