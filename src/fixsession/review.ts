// The Opus reviews of a pull request (the full review and the pre-merge review) in a workspace pod of their own, with the `review`
// entry of the fix_sessions setting on. The review job makes a workspace at the reviewed head (owner reviewWorkspaceOwner: the job
// and the PR), puts the default branch's maintainer documents beside it, and its call works in it with the workspace tools that
// read, build and test (askClaude's WorkspaceAsk). Only that job uses it, for every attempt of its call and the reply's fix turn;
// the job ends it when the review is done, and the launcher ends one a stopped job left (workspace-launch.ts reviewWorkspaceDone).
// The PR's fix session and its workspace are never touched. The review takes a workspace only while one of the environment's slots
// stays free for fix steps. When the workspace cannot be had now (a quiet pull request, no cluster, no environment, no slot to
// spare, a slow or failed start) the review runs read-only over its checkout, as with the switch off, and never waits for a pod past
// REVIEW_WORKSPACE_READY_MS. The post-merge review always runs read-only.
import { currentJob, isHalt, WaitLimitError } from "../agents/call.ts";
import type { WorkspaceAsk } from "../classify/run.ts";
import { assertFence } from "../db/fence.ts";
import type { Db } from "../db/index.ts";
import { loadWorkspaces, reviewWorkspaceOwner, type WorkspaceRow } from "../data/build/index.ts";
import { loadCalls } from "../data/runners/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { getEnv } from "../build/envs.ts";
import { guardedApi, inClusterApi } from "../build/kube-api.ts";
import type { CallDeps } from "../build/session-turns.ts";
import { SEED_LIMIT_MS, sourceArchive } from "../build/workspace-launch.ts";
import type { WorkspaceToolName } from "../build/workspace-tool-specs.ts";
import { createWorkspace, endWorkspace, POD_STATES, reseedWorkspace, type WorkspaceStateName } from "../build/workspaces.ts";
import { REVIEW_WORKSPACE_BUILD_MS, REVIEW_WORKSPACE_QUEUE_MS, REVIEW_WORKSPACE_READY_MS, REVIEW_WORKSPACE_SLOT_MS } from "../core/rules.ts";
import { scrub } from "../runner/scrub.ts";
import { fixSessionsOn } from "./switch.ts";
import { defaultRepoDocs, putRepoDocs, type RepoDocs } from "./turn.ts";
import { fetchIfNeeded, fixSessionEnv, waitReady, WorkspaceUnavailable, type FixWorkspaceEnv } from "./workspace.ts";

/** The workspace tools a review may call: reading, and shell for builds and tests. No write or edit, and no app or screenshot. */
export const REVIEW_TOOLS: readonly WorkspaceToolName[] = ["shell", "shell_status", "shell_kill", "read", "grep", "glob"];
/** Turns a review in the workspace gets beyond its prompt's, for the builds and tests it runs. */
export const REVIEW_WORKSPACE_TURNS = 30;

export type ReviewWorkspaceDeps = {
  /** The cluster this runner reaches (and, in tests, the poll interval), or null when it is not in one. */
  env: (db: Db) => Omit<FixWorkspaceEnv, "db" | "log"> | null;
  /** The model calls; tests replace them. */
  calls?: CallDeps;
  /** The default branch's maintainer documents of a repo; tests replace them. */
  docs?: (db: Db, repo: string) => Promise<RepoDocs>;
};

export function defaultReviewWorkspace(): ReviewWorkspaceDeps {
  return {
    env: (db) => {
      const cluster = inClusterApi();
      return cluster ? { api: guardedApi(cluster, () => assertFence(db)) } : null;
    },
  };
}

const short = (sha: string): string => sha.slice(0, 8);
/** States that hold a workspace slot: a pod, or the wait for one. */
const SLOT_STATES: WorkspaceStateName[] = [...POD_STATES, "requested"];

/** Why a new workspace may not take a slot of `envId`: at least one must stay free for fix steps afterwards. Null: room. */
async function noSpareSlot(db: Db, envId: string): Promise<string | null> {
  const slots = (await getEnv(db, envId))?.settings?.workspaceSlots;
  if (slots === undefined) return null;
  const used = (await loadWorkspaces(db, { env: envId, states: SLOT_STATES })).size;
  return slots - used - 1 >= 1 ? null : `${used} of environment ${envId}'s ${slots} workspace slots are in use, and a review leaves one free for fix steps`;
}

/** Whether the call bound to the workspace is still queued or leased: a resumed job adopts it on the tree it works on. */
async function callOpen(db: Db, w: WorkspaceRow): Promise<boolean> {
  if (w.remote_call_id === null) return false;
  const c = (await loadCalls(db, [Number(w.remote_call_id)])).get(Number(w.remote_call_id));
  return c?.state === "queued" || c?.state === "leased";
}

/**
 * Runs `review` in a workspace of its own at `at` (the reviewed head) when `deps` is given, the `review` entry of fix_sessions
 * covers the repo and a workspace can be had now; otherwise with null, for the read-only call. The job log says which ran (nothing
 * while the switch is off). A resumed job goes on in the workspace its earlier run made at `at`: with that run's call still open the
 * tree stays as it is and the call is adopted; otherwise the tree is reseeded. The workspace ends when the review is done; after a
 * halt it stays for the resumed job.
 */
export async function inReviewWorkspace<T>(db: Db, deps: ReviewWorkspaceDeps | null | undefined, item: { repo: string; number: number }, at: string,
  log: (line: string) => void, review: (ws: WorkspaceAsk | null) => Promise<T>): Promise<T> {
  const ref = `${item.repo}#${item.number}`;
  if (!deps || !await fixSessionsOn(db, "review", item.repo)) return await review(null);
  const readOnly = async (why: string): Promise<T> => {
    log(`  ${ref}: read-only review: ${why}`);
    return await review(null);
  };
  if ((await loadQuiet(db, [ref])).size) return await readOnly("a quiet pull request is reviewed read-only");
  const base = deps.env(db);
  if (!base) return await readOnly("this runner is not in the cluster, so it cannot reach a workspace");
  const env: FixWorkspaceEnv = { ...base, db, log };
  const owner = reviewWorkspaceOwner(currentJob()?.id ?? null, ref);
  let id: number | null = null;
  const end = async (): Promise<void> => {
    if (id !== null && await endWorkspace(db, id).catch(() => false)) log(`  ${ref}: review workspace ${id} ended`);
  };
  const started = Date.now();
  const until = { all: started + REVIEW_WORKSPACE_READY_MS, slot: started + REVIEW_WORKSPACE_SLOT_MS };
  const why = await (async (): Promise<string | number> => {
    const envId = await fixSessionEnv(db, "pr");
    if (typeof envId !== "string") return envId.reason;
    // A resumed job's own workspace at this head is used again; any other it made is ended.
    for (const w of (await loadWorkspaces(db, { env: envId, states: SLOT_STATES })).values()) {
      if (w.owner !== owner) continue;
      if (id === null && w.base_sha === at) id = w.id;
      else await endWorkspace(db, w.id);
    }
    const reused = id !== null;
    if (id === null) {
      const full = await noSpareSlot(db, envId);
      if (full) return full;
      id = await createWorkspace(db, { repo: item.repo, baseSha: at, envId, owner });
      log(`  ${ref}: review workspace ${id} requested on ${envId} at ${short(at)}`);
    }
    let row = await waitReady(env, id, until);
    if ("pending" in row) return `the review workspace: ${row.pending}`;
    if ("lost" in row) return `the review workspace: ${row.lost}`;
    const adopt = reused && await callOpen(db, row);
    if (reused && !adopt) {
      // An earlier run's tree: the review starts from a clean one.
      const r = await reseedWorkspace(db, env.api, id, at, await sourceArchive(item.repo, at), SEED_LIMIT_MS);
      if (!r.ok) return `the review workspace could not be reseeded: ${r.reason}`;
      row = { ...row, base_commit: r.baseCommit };
    }
    if (!adopt) {
      await fetchIfNeeded(env, row, at);
      const bad = await putRepoDocs(env, id, await (deps.docs ?? ((d, repo) => defaultRepoDocs(d, repo)))(db, item.repo));
      if (bad) log(`  ${ref}: the maintainer documents were not put in workspace ${id} (${bad})`);
    }
    log(`  ${ref}: review in workspace ${id} at ${short(at)}${adopt ? " (the earlier run's call adopted)" : reused ? " (reseeded)" : ""}`);
    return id;
  })().catch((e: unknown) => {
    if (isHalt(e)) throw e;
    return e instanceof WorkspaceUnavailable ? `the review workspace: ${scrub(e.message)}` : `the review workspace could not be made ready: ${scrub(String((e as Error).message ?? e)).slice(0, 300)}`;
  });
  if (typeof why === "string") {
    await end();
    return await readOnly(why);
  }
  const ws: WorkspaceAsk = {
    workspaceId: why, tools: REVIEW_TOOLS, seconds: REVIEW_WORKSPACE_BUILD_MS / 1000, turns: REVIEW_WORKSPACE_TURNS, firstWaitMs: REVIEW_WORKSPACE_QUEUE_MS,
    ...(deps.calls && { calls: deps.calls }),
  };
  let untaken: string;
  try {
    const value = await review(ws);
    await end();
    return value;
  } catch (e) {
    // A halted job may leave its call running in the pod: the workspace stays for the resumed job, or the launcher ends it.
    if (!(e instanceof WaitLimitError) && isHalt(e)) throw e;
    await end();
    // No Task Runner took the workspace call in time (none that runs workspace calls, or none free): the review is not held up by it.
    if (!(e instanceof WaitLimitError)) throw e;
    untaken = String((e as Error).message ?? e).slice(0, 200);
  }
  return await readOnly(`no Task Runner took the call in the workspace (${untaken})`);
}
