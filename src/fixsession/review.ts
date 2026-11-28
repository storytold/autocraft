// The Opus reviews of a pull request (the full review, the pre-merge review and the post-merge review) in its fix session's
// workspace, with the `review` entry of the fix_sessions setting on. The session's workspace is made ready at the reviewed commit,
// always from a clean tree (reseeded at it, also when it is already there), the default branch's maintainer documents are put
// beside it, and the review's call works in it with the workspace tools that read, build and test (askClaude's WorkspaceAsk). The
// review changes nothing: it never pushes, a change it leaves in the tree is never read, and the next step reseeds the tree. When
// the workspace cannot be had now (a quiet pull request, no cluster, no environment, another job on the PR's session, a call still
// bound to the workspace, no slot, a slow or failed start) the review runs read-only over its checkout, as with the switch off, and
// never waits for a pod past REVIEW_WORKSPACE_READY_MS.
import { currentJob, isHalt, WaitLimitError } from "../agents/call.ts";
import type { WorkspaceAsk } from "../classify/run.ts";
import { assertFence } from "../db/fence.ts";
import type { Db } from "../db/index.ts";
import { loadCalls } from "../data/runners/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { guardedApi, inClusterApi } from "../build/kube-api.ts";
import type { CallDeps } from "../build/session-turns.ts";
import type { WorkspaceToolName } from "../build/workspace-tool-specs.ts";
import { getWorkspace } from "../build/workspaces.ts";
import { REVIEW_WORKSPACE_BUILD_MS, REVIEW_WORKSPACE_QUEUE_MS, REVIEW_WORKSPACE_READY_MS, REVIEW_WORKSPACE_SLOT_MS } from "../core/rules.ts";
import { release, take } from "../runner/leases.ts";
import { scrub } from "../runner/scrub.ts";
import { endStepPod } from "./park.ts";
import { fixSessionsOn } from "./switch.ts";
import { defaultRepoDocs, fixSessionLease, putRepoDocs, type RepoDocs } from "./turn.ts";
import { ensureWorkspace, openSession, WorkspaceUnavailable, type FixWorkspaceEnv } from "./workspace.ts";

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

/** The call still bound to the workspace while it is queued or leased, or null. */
async function busyCall(db: Db, workspaceId: number): Promise<number | null> {
  const bound = (await getWorkspace(db, workspaceId))?.remote_call_id ?? null;
  if (bound === null) return null;
  const c = (await loadCalls(db, [Number(bound)])).get(Number(bound));
  return c && (c.state === "queued" || c.state === "leased") ? Number(bound) : null;
}

/**
 * Runs `review` in the PR's fix session workspace, ready at `at` (the reviewed head, or the merge commit), when `deps` is given, the
 * `review` entry of fix_sessions covers the repo and the workspace can be had now; otherwise with null, for the read-only call. The
 * job log says which ran (nothing while the switch is off). While `review` runs the job holds the PR's work lease and its fix
 * session's lease, so no fix step moves the tree under it; afterwards the pod is parked (endStepPod) unless a lint follow-up of the
 * session still needs it.
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
  if (!base) return await readOnly("this runner is not in the cluster, so it cannot reach the fix session's workspace");
  const env: FixWorkspaceEnv = { ...base, db, log };
  const job = currentJob();
  const keys = [`pr:${ref}`, fixSessionLease({ kind: "pr", repo: item.repo, number: item.number })];
  const held: string[] = [];
  const letGo = async (): Promise<void> => {
    if (job) for (const k of held.splice(0).reverse()) await release(db, k, job.id);
  };
  let ws: WorkspaceAsk;
  try {
    for (const k of keys) {
      if (job && !await take(db, k, job.id, job.step)) {
        await letGo();
        return await readOnly("another job works the pull request's fix session");
      }
      held.push(k);
    }
    const why = await (async (): Promise<string | number> => {
      const opened = await openSession(db, "pr", item.repo, item.number, { head: at });
      if ("refused" in opened) return "a person stopped the item's workflow";
      const busy = opened.session.workspaceId === null ? null : await busyCall(db, opened.session.workspaceId);
      if (busy !== null) return `call ${busy} still works in the fix session's workspace`;
      const r = await ensureWorkspace(opened.session, at, env, { patience: { limitMs: REVIEW_WORKSPACE_READY_MS, slotMs: REVIEW_WORKSPACE_SLOT_MS } });
      if (r.kind !== "ready") return `the fix session's workspace: ${r.reason}`;
      const docs = await (deps.docs ?? ((d, repo) => defaultRepoDocs(d, repo)))(db, item.repo);
      const bad = await putRepoDocs(env, r.workspaceId, docs);
      if (bad) log(`  ${ref}: the maintainer documents were not put in workspace ${r.workspaceId} (${bad})`);
      log(`  ${ref}: review in fix session ${opened.session.id}'s workspace ${r.workspaceId} at ${short(at)} (${r.how})`);
      return r.workspaceId;
    })().catch((e: unknown) => {
      if (isHalt(e)) throw e;
      return e instanceof WorkspaceUnavailable ? `the fix session's workspace: ${scrub(e.message)}` : `the fix session's workspace could not be made ready: ${scrub(String((e as Error).message ?? e)).slice(0, 300)}`;
    });
    if (typeof why === "string") {
      await letGo();
      return await readOnly(why);
    }
    ws = {
      workspaceId: why, tools: REVIEW_TOOLS, seconds: REVIEW_WORKSPACE_BUILD_MS / 1000, turns: REVIEW_WORKSPACE_TURNS, firstWaitMs: REVIEW_WORKSPACE_QUEUE_MS,
      ...(deps.calls && { calls: deps.calls }),
    };
  } catch (e) {
    await letGo();
    throw e;
  }
  let out: { value: T } | { untaken: string };
  try {
    try {
      out = { value: await review(ws) };
    } catch (e) {
      // No Task Runner took the workspace call in time (none that runs workspace calls, or none free): the review is not held up by
      // it. A call no Task Runner may take at all (NoTakerError) is skipped as any review is: a read-only call would have none either.
      const untaken = e instanceof WaitLimitError;
      // A halted job may leave its call running in the pod: the pod stays as it is, and the next step on the session finds it.
      if (!untaken && isHalt(e)) throw e;
      await endStepPod(env, { repo: item.repo, number: item.number });
      if (!untaken) throw e;
      out = { untaken: String((e as Error).message ?? e).slice(0, 200) };
    }
    if ("value" in out) await endStepPod(env, { repo: item.repo, number: item.number });
  } finally {
    await letGo();
  }
  return "value" in out ? out.value : await readOnly(`no Task Runner took the call in the workspace (${out.untaken})`);
}
