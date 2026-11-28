// The patch check (fixup.check) of a change a fix session made (a PR's, or a repo's main-fix session's), in that session's workspace:
// the tree there is the head plus the change, so the check reads the change whole with the workspace tools (read, grep, glob, and shell to build and test, no
// write or edit) instead of inline, and no size cap applies. The workspace is made ready at the head with its tree kept (a parked
// pod is resumed); a tree that no longer holds the change gets it back from the diff the step read. When the workspace cannot be
// had (no cluster, another job on the session, a call still bound to it, a start that fails or takes too long, no Task Runner that
// takes the call), the check runs inline as on the patch path, with its cap, and the caller says why.
import { currentJob, isHalt, WaitLimitError } from "../agents/call.ts";
import type { WorkspaceAsk } from "../classify/run.ts";
import type { Db } from "../db/index.ts";
import { loadCalls } from "../data/runners/index.ts";
import { loadLiveFixSession, type FixSessionKind } from "../data/fixsession/index.ts";
import type { CallDeps } from "../build/session-turns.ts";
import type { WorkspaceToolName } from "../build/workspace-tool-specs.ts";
import { getWorkspace } from "../build/workspaces.ts";
import type { FixupCheckInput } from "../patchcheck/types.ts";
import { release, take } from "../runner/leases.ts";
import { scrub } from "../runner/scrub.ts";
import { diffFiles } from "./gates.ts";
import { collectDiff, fixSessionLease } from "./turn.ts";
import { ensureWorkspace, restorePatch, WorkspaceUnavailable, type FixWorkspaceEnv } from "./workspace.ts";

/** The workspace tools a patch check may call: reading, and shell for builds and tests. */
export const CHECK_TOOLS: readonly WorkspaceToolName[] = ["shell", "shell_status", "shell_kill", "read", "grep", "glob"];
/** Turns the check gets beyond its prompt's, for reading a large change file by file and for builds. */
export const CHECK_WORKSPACE_TURNS = 40;
/** Time the check's call gets beyond the prompt's limit, for the builds and tests it runs. */
export const CHECK_WORKSPACE_BUILD_MS = 30 * 60_000;
/** The longest the check's call waits for a Task Runner that runs workspace calls before the check runs inline. */
export const CHECK_WORKSPACE_QUEUE_MS = 30 * 60_000;

/** The check's call in the workspace, and the input fields that replace the inline patch. */
export type CheckInWorkspace = { ws: WorkspaceAsk; change: NonNullable<FixupCheckInput["change"]> };
/** Where the check runs: in the workspace, or inline because of `why`. */
export type CheckPlace = CheckInWorkspace | { why: string };

/** The call still bound to the workspace while it is queued or leased, or null. */
async function busyCall(db: Db, workspaceId: number): Promise<number | null> {
  const bound = (await getWorkspace(db, workspaceId))?.remote_call_id ?? null;
  if (bound === null) return null;
  const c = (await loadCalls(db, [Number(bound)])).get(Number(bound));
  return c && (c.state === "queued" || c.state === "leased") ? Number(bound) : null;
}

/**
 * Runs `check` with the item's fix session workspace (of `item.kind`) holding `made.diff` on `made.head` (the change the step read from it), or, when
 * the workspace cannot be had, with the reason, for the inline check. `env` null: this runner reaches no workspace. The job holds the
 * session's lease while the check runs, so no fix step moves the tree under it; the caller's step ends the pod's hold afterwards.
 */
export async function inCheckWorkspace<T>(env: (FixWorkspaceEnv & { calls?: CallDeps }) | null, item: { kind: FixSessionKind; repo: string; number: number }, made: { head: string; diff: string },
  check: (place: CheckPlace) => Promise<T>): Promise<T> {
  if (!env) return await check({ why: "this runner is not in the cluster, so it cannot reach the fix session's workspace" });
  const { db } = env;
  const ref = `${item.repo}#${item.number}`;
  const job = currentJob();
  const s0 = await loadLiveFixSession(db, item.kind, item.repo, item.number);
  if (!s0) return await check({ why: "there is no live fix session" });
  const key = fixSessionLease(s0);
  if (job && !await take(db, key, job.id, job.step)) return await check({ why: "another job works the fix session" });
  try {
    const place = await (async (): Promise<CheckPlace> => {
      const s = await loadLiveFixSession(db, item.kind, item.repo, item.number);
      if (!s || s.id !== s0.id) return { why: "the fix session ended" };
      const busy = s.workspaceId === null ? null : await busyCall(db, s.workspaceId);
      if (busy !== null) return { why: `call ${busy} still works in the fix session's workspace` };
      const r = await ensureWorkspace(s, made.head, env, { keepTree: true });
      if (r.kind !== "ready") return { why: `the fix session's workspace: ${r.reason}` };
      const now = await collectDiff(env, r.workspaceId);
      if (!now.ok || now.diff !== made.diff) {
        const back = await restorePatch(env, r.workspaceId, { diff: made.diff, head: made.head });
        if (!back.ok) return { why: `the change could not be put back in the fix session's workspace: ${back.reason}` };
        const again = await collectDiff(env, r.workspaceId);
        if (!again.ok || again.diff !== made.diff) return { why: `the fix session's workspace does not hold the change${again.ok ? "" : ` (${again.reason})`}` };
      }
      env.log(`  ${ref}: patch check in fix session ${s.id}'s workspace ${r.workspaceId} (${r.how}), ${made.diff.length} characters`);
      return {
        ws: { workspaceId: r.workspaceId, tools: CHECK_TOOLS, seconds: CHECK_WORKSPACE_BUILD_MS / 1000, turns: CHECK_WORKSPACE_TURNS, firstWaitMs: CHECK_WORKSPACE_QUEUE_MS, ...(env.calls && { calls: env.calls }) },
        change: { base: r.baseCommit, chars: made.diff.length, files: diffFiles(made.diff) },
      };
    })().catch((e: unknown): CheckPlace => {
      if (isHalt(e)) throw e;
      return { why: e instanceof WorkspaceUnavailable ? `the fix session's workspace: ${scrub(e.message)}` : `the fix session's workspace could not be made ready: ${scrub(String((e as Error).message ?? e)).slice(0, 300)}` };
    });
    if ("why" in place) return await check(place);
    try {
      return await check(place);
    } catch (e) {
      // No Task Runner took the call in time: the check is not held up by it, and runs inline.
      if (!(e instanceof WaitLimitError)) throw e;
      return await check({ why: `no Task Runner took the check in the workspace (${String(e.message).slice(0, 200)})` });
    }
  } finally {
    if (job) await release(db, key, job.id);
  }
}

/** The fields of a check input that put the change in the workspace: an empty patch, and `change`. */
export const workspacePatch = (place: CheckInWorkspace): Pick<FixupCheckInput, "patch" | "change"> => ({ patch: "", change: place.change });
