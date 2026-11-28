// The Opus reviews of a pull request (the full review and the pre-merge review) in its fix session's workspace, with the `review`
// entry of the fix_sessions setting on. The session's workspace is made ready at the reviewed commit, always from a clean tree
// (reseeded at it, also when it is already there), the default branch's maintainer documents are put beside it, and the review's
// call works in it with the workspace tools that read, build and test (askClaude's WorkspaceAsk). The review changes nothing: it
// never pushes, a change it leaves in the tree is never read, and the next step reseeds the tree. A fix step never waits behind a
// review: the review holds the fix session's lease only until its call is bound to the workspace, it takes a workspace slot only
// while one stays free, and a fix step that needs the workspace withdraws the review's call (turn.ts REVIEW_YIELDED), after which
// the review runs read-only. When the workspace cannot be had now (a quiet pull request, no cluster, no environment, another job on
// the PR's session, a fix turn not settled yet, a call still bound to the workspace, no slot to spare, a slow or failed start) the
// review runs read-only over its checkout, as with the switch off, and never waits for a pod past REVIEW_WORKSPACE_READY_MS. The
// post-merge review always runs read-only: the merged PR's session ends with it.
import { currentJob, isHalt, WaitLimitError } from "../agents/call.ts";
import type { WorkspaceAsk } from "../classify/run.ts";
import { assertFence } from "../db/fence.ts";
import type { Db } from "../db/index.ts";
import { loadWorkspaces } from "../data/build/index.ts";
import { loadLiveFixSession } from "../data/fixsession/index.ts";
import { loadCalls } from "../data/runners/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { BuildError, getEnv } from "../build/envs.ts";
import { guardedApi, inClusterApi } from "../build/kube-api.ts";
import { realCalls, type CallDeps } from "../build/session-turns.ts";
import type { WorkspaceToolName } from "../build/workspace-tool-specs.ts";
import { endWorkspace, getWorkspace, LIVE_STATES, POD_STATES, type WorkspaceStateName } from "../build/workspaces.ts";
import { REVIEW_WORKSPACE_BUILD_MS, REVIEW_WORKSPACE_QUEUE_MS, REVIEW_WORKSPACE_READY_MS, REVIEW_WORKSPACE_SLOT_MS } from "../core/rules.ts";
import { release, take } from "../runner/leases.ts";
import { scrub } from "../runner/scrub.ts";
import { lastTurn, QUEUED_TURN_MS, type FixSession } from "./store.ts";
import { fixSessionsOn } from "./switch.ts";
import { defaultRepoDocs, fixSessionLease, putRepoDocs, REVIEW_YIELDED, type RepoDocs } from "./turn.ts";
import { ensureWorkspace, fixSessionEnv, openSession, parkSession, WorkspaceUnavailable, type FixWorkspaceEnv } from "./workspace.ts";

/** The workspace tools a review may call: reading, and shell for builds and tests. No write or edit, and no app or screenshot. */
export const REVIEW_TOOLS: readonly WorkspaceToolName[] = ["shell", "shell_status", "shell_kill", "read", "grep", "glob"];
/** Turns a review in the workspace gets beyond its prompt's, for the builds and tests it runs. */
export const REVIEW_WORKSPACE_TURNS = 30;

/** The reviews that may run in a fix session's workspace. */
export type WorkspaceReviewPrompt = "review.opus" | "premerge.opus";

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
const refOf = (i: { repo: string; number: number }): string => `${i.repo}#${i.number}`;

/** The call bound to the workspace while it is queued or leased, with the commit the workspace is at, or null. */
async function busyCall(db: Db, workspaceId: number): Promise<{ id: number; jobId: number | null; promptId: string; items: { repo: string; number: number }[]; at: string } | null> {
  const w = await getWorkspace(db, workspaceId);
  const bound = w?.remote_call_id ?? null;
  if (!w || bound === null) return null;
  const c = (await loadCalls(db, [Number(bound)])).get(Number(bound));
  return c && (c.state === "queued" || c.state === "leased") ? { id: c.id, jobId: c.jobId, promptId: c.promptId, items: c.items, at: w.base_sha } : null;
}

/**
 * Why the review may not take a workspace slot of the session's environment: it takes one only while at least one stays free for fix
 * steps afterwards. A workspace that already holds a pod or waits for one takes none more. Null: room, or no environment (which
 * ensureWorkspace reports).
 */
async function noSpareSlot(db: Db, s: FixSession): Promise<string | null> {
  const w = s.workspaceId === null ? undefined : await getWorkspace(db, s.workspaceId);
  const live = !!w && w.repo === s.repo && LIVE_STATES.includes(w.state as WorkspaceStateName);
  const envId = live ? w!.env_id : await fixSessionEnv(db, "pr");
  if (typeof envId !== "string") return null;
  const slots = (await getEnv(db, envId))?.settings?.workspaceSlots;
  if (slots === undefined) return null;
  const counted: WorkspaceStateName[] = [...POD_STATES, "requested"];
  const used = (await loadWorkspaces(db, { env: envId, states: counted })).size;
  const takes = live && counted.includes(w!.state as WorkspaceStateName) ? 0 : 1;
  return slots - used - takes >= 1 ? null : `${used} of environment ${envId}'s ${slots} workspace slots are in use, and a review leaves one free for fix steps`;
}

/**
 * Runs `review` in the PR's fix session workspace, ready at `at` (the reviewed head), when `deps` is given, the `review` entry of
 * fix_sessions covers the repo and the workspace can be had now; otherwise with null, for the read-only call. The job log says which
 * ran (nothing while the switch is off). The job holds the fix session's lease from before the workspace moves until the review's
 * call is bound to it, so no fix step moves the tree in between; a resumed job whose earlier review call is still bound adopts it on
 * the tree it works on. A fix step that takes the workspace meanwhile withdraws the call, and the review runs read-only. When the
 * review is done the workspace ends, unless its verdict asks for fixes (`o.fixes`) and the repo's fix-ups work in fix sessions: then
 * it is parked for the fix-up.
 */
export async function inReviewWorkspace<T>(db: Db, deps: ReviewWorkspaceDeps | null | undefined, item: { repo: string; number: number }, at: string,
  o: { prompt: WorkspaceReviewPrompt; fixes: (value: T) => boolean }, log: (line: string) => void, review: (ws: WorkspaceAsk | null) => Promise<T>): Promise<T> {
  const ref = refOf(item);
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
  const key = fixSessionLease({ kind: "pr", repo: item.repo, number: item.number });
  let held = false;
  const letGo = async (): Promise<void> => {
    if (job && held) {
      held = false;
      await release(db, key, job.id);
    }
  };
  if (job && !await take(db, key, job.id, job.step)) return await readOnly("another job works the pull request's fix session");
  held = job !== null;
  let ws: WorkspaceAsk, workspaceId: number;
  /** The review's calls in the workspace, and why it gave the workspace up to a fix step (a bind of its call was refused). */
  const mine = new Set<number>();
  let yielded: string | null = null;
  try {
    const why = await (async (): Promise<string | number> => {
      const opened = await openSession(db, "pr", item.repo, item.number, { head: at });
      if ("refused" in opened) return "a person stopped the item's workflow";
      const s = opened.session;
      // A fix turn a halted job left queued may be done and unread: its step resumes on the tree it worked on.
      const last = await lastTurn(db, s.id);
      if (last?.outcome === "queued" && Date.parse(last.createdAt) >= Date.now() - QUEUED_TURN_MS) return `turn ${last.callId ?? last.id} of fix session ${s.id} is not settled yet`;
      const busy = s.workspaceId === null ? null : await busyCall(db, s.workspaceId);
      // This job's earlier run (halted) left its review call working in the workspace at this commit: the call is adopted there.
      const own = busy !== null && job !== null && busy.jobId === job.id && busy.promptId === o.prompt && busy.at === at && busy.items.some((i) => refOf(i) === ref);
      if (busy !== null && !own) return `call ${busy.id} still works in the fix session's workspace`;
      if (!own) {
        const full = await noSpareSlot(db, s);
        if (full) return full;
      }
      const r = await ensureWorkspace(s, at, env, { keepTree: own, patience: { limitMs: REVIEW_WORKSPACE_READY_MS, slotMs: REVIEW_WORKSPACE_SLOT_MS } });
      if (r.kind !== "ready") return `the fix session's workspace: ${r.reason}`;
      if (!own) {
        const docs = await (deps.docs ?? ((d, repo) => defaultRepoDocs(d, repo)))(db, item.repo);
        const bad = await putRepoDocs(env, r.workspaceId, docs);
        if (bad) log(`  ${ref}: the maintainer documents were not put in workspace ${r.workspaceId} (${bad})`);
      }
      log(`  ${ref}: review in fix session ${s.id}'s workspace ${r.workspaceId} at ${short(at)} (${own ? `call ${busy!.id} adopted` : r.how})`);
      return r.workspaceId;
    })().catch((e: unknown) => {
      if (isHalt(e)) throw e;
      return e instanceof WorkspaceUnavailable ? `the fix session's workspace: ${scrub(e.message)}` : `the fix session's workspace could not be made ready: ${scrub(String((e as Error).message ?? e)).slice(0, 300)}`;
    });
    if (typeof why === "string") {
      await letGo();
      return await readOnly(why);
    }
    workspaceId = why;
    const calls = deps.calls ?? realCalls;
    ws = {
      workspaceId, tools: REVIEW_TOOLS, seconds: REVIEW_WORKSPACE_BUILD_MS / 1000, turns: REVIEW_WORKSPACE_TURNS, firstWaitMs: REVIEW_WORKSPACE_QUEUE_MS,
      calls: {
        // Once the call is bound to the workspace the lease goes: a fix step that needs the workspace withdraws the call.
        queue: async (d, r) => {
          try {
            const id = await calls.queue(d, r);
            mine.add(id);
            await letGo();
            return id;
          } catch (e) {
            if (e instanceof BuildError && e.status === 409) yielded = `a fix step took the workspace (${scrub(e.message)})`;
            throw e;
          }
        },
        await: calls.await,
      },
    };
  } catch (e) {
    await letGo();
    throw e;
  }
  let out: { value: T } | { readOnly: string };
  try {
    try {
      out = { value: await review(ws) };
    } catch (e) {
      // No Task Runner took the workspace call in time (none that runs workspace calls, or none free): the review is not held up by
      // it. A call no Task Runner may take at all (NoTakerError) is skipped as any review is: a read-only call would have none either.
      const untaken = e instanceof WaitLimitError;
      // A halted job may leave its call running in the pod: the pod stays as it is, and the resumed job adopts the call.
      if (!untaken && isHalt(e)) throw e;
      if (untaken) out = { readOnly: `no Task Runner took the call in the workspace (${String((e as Error).message ?? e).slice(0, 200)})` };
      else if (yielded) out = { readOnly: yielded };
      else {
        await settleWorkspace(env, item, workspaceId, mine, false);
        throw e;
      }
    }
    if ("value" in out) {
      const gave = yielded ?? await withdrawnForFix(db, mine);
      if (gave) out = { readOnly: gave };
    }
    await settleWorkspace(env, item, workspaceId, mine, "value" in out && o.fixes(out.value) && await fixSessionsOn(db, "fixup", item.repo));
  } finally {
    await letGo();
  }
  return "value" in out ? out.value : await readOnly(out.readOnly);
}

/** Why a call of the review was withdrawn because a fix step took the workspace, or null. */
async function withdrawnForFix(db: Db, calls: ReadonlySet<number>): Promise<string | null> {
  if (!calls.size) return null;
  const hit = [...(await loadCalls(db, [...calls])).values()].find((c) => c.state === "failed" && c.error === REVIEW_YIELDED);
  return hit ? `a fix step took the workspace and withdrew call ${hit.id}` : null;
}

/**
 * After the review: a workspace kept for the fix-up its verdict asks for is parked; any other is ended, as the next step reseeds it
 * anyway. Only under the session's lease, while the session still holds that workspace and nothing but the review's own calls is
 * bound to it: a fix step that took it over keeps it, and parks it when its step ends.
 */
async function settleWorkspace(env: FixWorkspaceEnv, item: { repo: string; number: number }, workspaceId: number, calls: ReadonlySet<number>, keep: boolean): Promise<void> {
  const db = env.db, ref = refOf(item);
  const job = currentJob();
  const key = fixSessionLease({ kind: "pr", repo: item.repo, number: item.number });
  try {
    if (job && !await take(db, key, job.id, job.step)) return;
    try {
      const s = await loadLiveFixSession(db, "pr", item.repo, item.number);
      if (s && s.workspaceId !== workspaceId) return;
      const bound = (await getWorkspace(db, workspaceId))?.remote_call_id ?? null;
      if (bound !== null && !calls.has(Number(bound))) return;
      if (keep && s) await parkSession(env, s);
      else if (await endWorkspace(db, workspaceId)) env.log(`  ${ref}: workspace ${workspaceId} ended after the review`);
    } finally {
      if (job) await release(db, key, job.id);
    }
  } catch (e) {
    if (isHalt(e)) throw e;
    env.log(`  ${ref}: workspace ${workspaceId} was not ended after the review: ${scrub(String((e as Error).message ?? e))}`);
  }
}
