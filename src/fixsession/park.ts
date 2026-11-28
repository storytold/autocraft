// What happens to a fix session's pod when a step on it ends, the same for every lane: it is parked (the volume stays and the next
// step resumes it), unless a lint follow-up for the same session is pending, in which case the pod stays live for it. Callers hold
// the item's work lease (`pr:<repo>#<n>`, or a default branch's `head:<repo>@<sha>`), which every lane's step holds from its turn until
// its change is stored, so a change still on its way to its lint row is never parked under.
import { currentJob, isHalt } from "../agents/call.ts";
import { loadStoredPatches } from "../data/changes/index.ts";
import { loadFixTurnsById, loadLiveFixSession } from "../data/fixsession/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";
import { release, take } from "../runner/leases.ts";
import type { FixSession, FixSessionKind } from "./store.ts";
import { fixSessionLease } from "./turn.ts";
import { parkSession, type FixWorkspaceEnv } from "./workspace.ts";

/**
 * A change a turn of the session wrote at the PR's current head is stored and waits for its lint task, whose findings go back to the
 * session. A row at an older head has no follow-up: the plan no longer lists it.
 */
async function lintFollowUpPending(db: Db, s: FixSession): Promise<boolean> {
  const head = (await loadItems(db, [{ repo: s.repo, number: s.number }], "pr")).get(`${s.repo}#${s.number}`)?.head_oid ?? null;
  if (head === null) return false;
  const turns = (await loadStoredPatches(db, [{ repo: s.repo, number: s.number }], ["fixup", "cifix", "conflict"]))
    .flatMap((p) => (p.head === head && p.lintTask !== null && p.sessionTurn !== null ? [p.sessionTurn] : []));
  if (!turns.length) return false;
  return [...(await loadFixTurnsById(db, turns)).values()].some((t) => t.sessionId === s.id);
}

/**
 * A step on the item's PR fix session ended (not a wait): its pod is parked, unless a lint follow-up for the session is pending.
 * Returns whether the pod was parked; a failure is logged (through `scrub`), as the step's outcome stands.
 */
export async function endStepPod(env: FixWorkspaceEnv, item: { repo: string; number: number }, scrub: (raw: string) => string = (x) => x): Promise<boolean> {
  return await parkStepPod(env, "pr", item, (s) => lintFollowUpPending(env.db, s), scrub);
}

/**
 * A step on the live session of `kind` for the item ended (not a wait): its pod is parked, unless `pending` says a follow-up for the
 * session waits. The session's lease is taken first, so the check and the park see the same session; while another job works it
 * nothing is parked, as that job's step parks it when it ends. Returns whether the pod was parked; a failure is logged (through
 * `scrub`), as the step's outcome stands.
 */
export async function parkStepPod(env: FixWorkspaceEnv, kind: FixSessionKind, item: { repo: string; number: number }, pending: (s: FixSession) => Promise<boolean>, scrub: (raw: string) => string = (x) => x): Promise<boolean> {
  const ref = `${item.repo}#${item.number}`;
  try {
    const s = await loadLiveFixSession(env.db, kind, item.repo, item.number);
    if (!s || s.workspaceId === null) return false;
    const job = currentJob();
    const key = fixSessionLease(s);
    if (job && !await take(env.db, key, job.id, job.step)) return false;
    try {
      // Read again under the lease: the session may have moved on to another workspace or ended meanwhile.
      const now = await loadLiveFixSession(env.db, kind, item.repo, item.number);
      if (!now || now.id !== s.id || now.workspaceId === null) return false;
      if (await pending(now)) {
        env.log(`  ${ref}: fix session ${now.id}: workspace ${now.workspaceId} stays live for the lint follow-up`);
        return false;
      }
      return await parkSession(env, now);
    } finally {
      if (job) await release(env.db, key, job.id);
    }
  } catch (e) {
    if (isHalt(e)) throw e;
    env.log(`  ${ref}: the fix session's workspace was not parked: ${scrub(String((e as Error).message ?? e))}`);
    return false;
  }
}
