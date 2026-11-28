// Room in the user-local model queue: how many more calls may be made now. Each helper whose last status is `ready` and
// fresh (helpers.ts), and which is active (its last claim found nothing within IDLE_FRESH_MS, or it runs a lease that
// heartbeats), is room for its free slots: its `--parallel` slots (the fast lane is not counted, see remoteRoom) less the
// leases its token holds. Only helpers that may take a call naming the caller's repos count (runnerTakes: the role rules, write
// permission, My repos narrowed by the helper's own list). A user's helpers together count no more than the user's "Max calls
// at once" leaves (max-calls.ts). The queued calls that rank at or above the caller's class in the claim order (claim-class.ts)
// and that a counted helper may take come first. A helper held by its plan usage or paused stops asking for work and reports
// so; a helper that stopped without a word stops counting once its last claim and heartbeats are old. The helpers of a Manual
// only user (manual-only.ts) take only the user's own picks and follow-ups, so they are no room. For work its user started or
// approved (started.ts) a helper is room whatever its Manual only, My repos, tasks and items.
import { claimClass } from "./claim-class.ts";
import { leasedIn } from "./calls.ts";
import { orderedOf, type Ordered } from "./cands.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { claimReposOf } from "./my-repos.ts";
import { TASK_CHOICES, skipsIn, taskOfStep } from "./my-tasks.ts";
import type { ItemFilter } from "./task-items.ts";
import { scaled } from "./time-scale.ts";
import { startedOf } from "./started.ts";
import { runnerTakes } from "./rules.ts";
import type { Db } from "../db/index.ts";
import { IDLE_FRESH_MS, LIVE_LEASE_MS, loadQueue, type RunnerRow } from "../data/runners/index.ts";
import { canWriteOf, itemFilterIn, loadView, settingsOf, type RemoteView } from "./view.ts";

/** How long an empty claim counts as an idle helper (src/data/runners/calls-shared.ts). */
export { IDLE_FRESH_MS };
/** How often a waiting caller stamps its call's `seen_at` (it polls more often, but writes only this often). */
export const SEEN_EVERY_MS = scaled(30_000);
/** A queued call whose caller has not stamped it for this long has lost its caller and is not counted or claimed: two stamps and some slack. */
export const CALLER_STALE_MS = 2 * SEEN_EVERY_MS + scaled(15_000);


/**
 * Room for calls of class `cls` that name `repos` (undefined: any repo, every helper counts; empty: no repo, which only
 * operators take) and are of `step` (only helpers whose users take its task count; undefined: every task). A helper's fast-lane slot takes only small-tier and gating calls, and the planner does not
 * know which calls it is about to make, so the fast lane is not room. The status names no fast lane: a helper reporting 2
 * or more slots is taken to run one (work adds it to `--parallel N`, except for a harness that runs one call at a time,
 * which reports 1, and on macOS at `--parallel 16`, which this undercounts by one). A lease in the fast lane is not told
 * apart from the others', so it also undercounts by one while it runs.
 *
 * Write permission is the cached one (repo_permissions, roomCanWrite): only a non-write permission confirmed within
 * PERM_READ_TTL leaves a user out. A user with no fresh row for a repo counts for it, so a repo nobody's claim has looked at
 * lately still gets calls; the claim then checks the permission itself. The helper's repos are those of its last idle claim
 * (`idle_repos`) narrowed by the user's current My repos.
 */
export async function remoteRoom(db: Db, cls: number, nowMs: number = Date.now(), repos?: readonly string[], step?: string): Promise<number> {
  return roomOf(await roomState(db, nowMs), cls, repos, step);
}

type Helper = RunnerRow;
type Taker = { h: Helper; active: boolean; r: { login: string; role: string; repos: ReadonlySet<string> | null; skip: ReadonlySet<string>; items: ItemFilter } };
/**
 * What the room reads, once for any number of room questions at one moment: the runner snapshot and the queue; of the runners,
 * the fresh, ready ones that are not Manual only and whose users take some task and some item (`ready`; with no task ticked, or
 * only started items and none open, a user takes only picks, as Manual only), and those of them that are active.
 */
export type RoomState = {
  v: RemoteView; queue: Ordered; ready: Helper[]; active: Helper[]; takers?: { list: Taker[]; canWrite: (login: string, repo: string) => boolean }; left: Map<string, number>;
  /** Every fresh, ready helper, Manual only and without tasks too: room for the work its user started or approved (started.ts). */
  fresh: Helper[];
};

export async function roomState(db: Db, nowMs: number = Date.now()): Promise<RoomState> {
  const [v, queue] = await db.together(() => Promise.all([loadView(db, nowMs), loadQueue(db, nowMs)]));
  return roomStateOf(v, orderedOf(queue, nowMs));
}

/** RoomState over a reading already made. */
export function roomStateOf(v: RemoteView, queue: Ordered): RoomState {
  const s = v.snapshot, nowMs = v.now;
  const fresh = s.runners.filter((r) => r.readiness === "ready" && r.reportedAt !== null && r.reportedAt >= nowMs - STATUS_FRESH_MS);
  const rows = fresh.filter((h) => {
    const set = settingsOf(s, h.login);
    return !set.manualOnly && skipsIn(set.skipTasks).size < TASK_CHOICES.length && (itemFilterIn(s, h.login)?.refs.size ?? 1) > 0;
  });
  return { v, queue, ready: rows, active: rows.filter((h) => isActive(h, nowMs)), left: new Map(), fresh };
}

/**
 * When the room of a reading next rises with time alone, with no write to report it: a counted queued call's caller going stale
 * (CALLER_STALE_MS after its last stamp) or a cool-off ending. Null when neither is ahead.
 */
export function roomRisesAt(st: RoomState): number | null {
  let at = Infinity;
  for (const r of st.queue.all) if (r.seen_at >= st.v.now - CALLER_STALE_MS) at = Math.min(at, r.seen_at + CALLER_STALE_MS + 1);
  for (const c of st.v.snapshot.cooled.values()) at = Math.min(at, Date.parse(c.until));
  return at === Infinity ? null : at;
}

const isActive = (h: Helper, nowMs: number): boolean =>
  (h.beatAt !== null && h.beatAt >= nowMs - LIVE_LEASE_MS) || (h.idleClaimAt !== null && h.idleClaimAt >= nowMs - IDLE_FRESH_MS);

function takersOf(st: RoomState): NonNullable<RoomState["takers"]> {
  const s = st.v.snapshot;
  return st.takers ??= {
    canWrite: canWriteOf(s),
    list: st.ready.map((h) => {
      const set = settingsOf(s, h.login);
      return { h, active: isActive(h, st.v.now), r: { login: h.login, role: h.role ?? "", repos: claimReposOf(set.repos, h.idleRepos ?? undefined), skip: skipsIn(set.skipTasks), items: itemFilterIn(s, h.login) } };
    }),
  };
}

/**
 * Room for class `cls`, `repos`, `step` and `refs` (see remoteRoom) from a state read at `nowMs`. `step` left out: every task
 * counts. `refs`: the call's items (with `repos` their repos), so a runner whose user takes only some items (task-items.ts) counts
 * only for a call on them; left out, it counts on the repos that have such an item.
 *
 * The calls ahead that only runners taking every item may take use up those runners' slots alone, so a call on a chosen item
 * finds the filtered runners' slots free while the others are busy with calls they alone take.
 */
export function roomOf(st: RoomState, cls: number, repos?: readonly string[], step?: string, refs?: readonly { repo: string; number: number }[]): number {
  const nowMs = st.v.now;
  let takers: { h: Helper; filtered: boolean }[] = st.active.map((h) => ({ h, filtered: false }));
  let takes: (c: { prompt_id: string; repos: readonly string[]; step?: string; refs?: readonly { repo: string; number: number }[] }) => boolean = () => true;
  let filteredTake: typeof takes = () => false;
  if ((repos !== undefined || step !== undefined || refs !== undefined) && st.active.length) {
    const t = takersOf(st);
    const task = step === undefined ? undefined : taskOfStep(step);
    const on = repos ?? (refs ? [...new Set(refs.map((x) => x.repo))] : undefined);
    const fit = t.list.filter(({ active, r }) => active && (on === undefined ? !(task !== undefined && r.skip.has(task)) && (r.items === null || [...r.items.repos].some((x) => runnerTakes(r, { prompt_id: "", repos: [x], step }, t.canWrite))) : runnerTakes(r, { prompt_id: "", repos: on, step, refs }, t.canWrite)));
    takers = fit.map((x) => ({ h: x.h, filtered: x.r.items !== null }));
    takes = (c) => fit.some(({ r }) => runnerTakes(r, c, t.canWrite));
    filteredTake = (c) => fit.some(({ r }) => r.items !== null && runnerTakes(r, c, t.canWrite));
  }
  // The active helpers of the users whose started work this is (started.ts) are room for it whatever their Manual only, My
  // repos, tasks and items, as runners that take only some items; the calls ahead they take are those of their own started work.
  const on = repos ?? (refs ? [...new Set(refs.map((x) => x.repo))] : undefined);
  if (on?.length) {
    const sw = startedOf(st.v);
    const owners = sw.ownersFor({ repos: on, ...(refs && { refs }), ...(step !== undefined && { step }) });
    const counted = new Set(takers.map((x) => x.h.tokenId));
    const extra = owners.size ? st.fresh.filter((h) => isActive(h, nowMs) && !counted.has(h.tokenId) && owners.has(h.login.toLowerCase())
      && sw.canTake(h.login, { prompt_id: "", repos: on })) : [];
    if (extra.length) {
      const logins = new Set(extra.map((h) => h.login.toLowerCase()));
      const own = (c: { repos: readonly string[]; refs?: readonly { repo: string; number: number }[]; step?: string }): boolean => [...sw.owners(c.refs ?? [], c.step, undefined, c.repos)].some((o) => logins.has(o));
      // With no other helper counted nothing ahead is theirs.
      const [t0, f0] = takers.length ? [takes, filteredTake] : [() => false, () => false];
      takers = [...takers, ...extra.map((h) => ({ h, filtered: true }))];
      takes = (c) => t0(c) || own(c);
      filteredTake = (c) => f0(c) || own(c);
    }
  }
  // Free slots by login, within the user's cap, split into users who take every item (`all`) and filtered users (`some`).
  const free = new Map<string, { n: number; filtered: boolean }>();
  for (const { h, filtered } of takers) {
    const key = h.login.toLowerCase();
    const all = h.slots ?? 1;
    const slots = all - (all >= 2 ? 1 : 0);
    free.set(key, { n: (free.get(key)?.n ?? 0) + Math.max(0, slots - h.leased), filtered });
  }
  let all = 0, some = 0;
  for (const [login, { n, filtered }] of free) {
    let left = st.left.get(login);
    if (left === undefined) {
      const max = settingsOf(st.v.snapshot, login).maxCalls;
      left = max === null ? Infinity : Math.max(0, max - leasedIn(st.v.snapshot, login));
      st.left.set(login, left);
    }
    if (filtered) some += Math.min(n, left);
    else all += Math.min(n, left);
  }
  if (all + some === 0) return 0;
  let aheadAll = 0, aheadSome = 0;
  for (const r of st.queue.all) {
    if (r.seen_at < nowMs - CALLER_STALE_MS || claimClass(r, nowMs) < cls || !takes(r)) continue;
    if (some > 0 && filteredTake(r)) aheadSome++;
    else aheadAll++;
  }
  // Calls the filtered runners may take go to them first; what they cannot hold falls to the others.
  return Math.max(0, all - aheadAll - Math.max(0, aheadSome - some)) + Math.max(0, some - aheadSome);
}

/** A job's calls as the runner's start test reads them: the job's repo, step and, for a lane job, the item it works on. */
export type JobCalls = { repos?: readonly string[]; step?: string; refs?: readonly { repo: string; number: number }[] };

/**
 * Room for the runner's job starts (src/runner/runner.ts startJobs), counted per Task Runner user over one reading. Each user of an
 * active, fresh, ready runner has free slots: its runners' slots (the fast lane not counted, as in roomOf) less their leases, within
 * the user's Max calls at once. The queued calls of class `cls` and above go each to one user who would take them, those with the
 * fewest such users first, the people whose started work a call is first (started.ts), else the user with the most slots left; a
 * call no user with a free slot takes reduces nobody's room. A job has room when the users who would take its calls (roomOf's
 * takers, its started work's owners first) have a slot left; `take` holds one of them for a job started, or one still preparing its call.
 */
export type JobRoom = {
  room(cls: number, c: JobCalls): number;
  take(cls: number, c: JobCalls): void;
};

export function jobRoom(st: RoomState): JobRoom {
  const nowMs = st.v.now, t = takersOf(st), sw = startedOf(st.v);
  // Free slots by lowercase login before any queued call, over every fresh, ready, active runner (Manual only ones serve started work).
  const base = new Map<string, number>();
  for (const h of st.fresh) {
    if (!isActive(h, nowMs)) continue;
    const key = h.login.toLowerCase(), all = h.slots ?? 1;
    base.set(key, (base.get(key) ?? 0) + Math.max(0, all - (all >= 2 ? 1 : 0) - h.leased));
  }
  for (const [login, n] of base) {
    const max = settingsOf(st.v.snapshot, login).maxCalls;
    base.set(login, max === null ? n : Math.min(n, Math.max(0, max - leasedIn(st.v.snapshot, login))));
  }
  /** The logins that would take calls `c`, and of them the owners of its started work. */
  const takers = (c: JobCalls & { prompt_id?: string }): { all: string[]; owners: ReadonlySet<string> } => {
    const task = c.step === undefined ? undefined : taskOfStep(c.step);
    const on = c.repos ?? (c.refs ? [...new Set(c.refs.map((x) => x.repo))] : undefined);
    const call = { prompt_id: c.prompt_id ?? "", repos: on ?? [], step: c.step, refs: c.refs };
    const fit = t.list.filter(({ active, r }) => active && (on === undefined
      ? !(task !== undefined && r.skip.has(task)) && (r.items === null || [...r.items.repos].some((x) => runnerTakes(r, { prompt_id: call.prompt_id, repos: [x], step: c.step }, t.canWrite)))
      : runnerTakes(r, call, t.canWrite)));
    const owners = new Set<string>();
    if (on?.length) {
      for (const o of sw.ownersFor({ repos: on, ...(c.refs && { refs: c.refs }), ...(c.step !== undefined && { step: c.step }) })) {
        if (base.has(o) && sw.canTake(o, { prompt_id: call.prompt_id, repos: on })) owners.add(o);
      }
    }
    return { all: [...new Set([...owners, ...fit.map(({ r }) => r.login.toLowerCase())])], owners };
  };
  const taken = new Map<string, number>();
  const ledgers = new Map<number, Map<string, number>>();
  const best = (left: ReadonlyMap<string, number>, who: { all: readonly string[]; owners: ReadonlySet<string> }): string | undefined => {
    let pick: string | undefined, pickOwner = false, most = 0;
    for (const l of who.all) {
      const n = left.get(l) ?? 0, owner = who.owners.has(l);
      if (n > 0 && ((owner && !pickOwner) || (owner === pickOwner && n > most))) [pick, pickOwner, most] = [l, owner, n];
    }
    return pick;
  };
  const ledger = (cls: number): Map<string, number> => {
    let left = ledgers.get(cls);
    if (left) return left;
    left = new Map(base);
    const ahead: { all: string[]; owners: ReadonlySet<string> }[] = [];
    for (const r of st.queue.all) {
      // A call in a conversation's own slot holds none of the user's slots (calls.ts claimOrder); one bound to a user goes to them alone.
      if (r.seen_at < nowMs - CALLER_STALE_MS || claimClass(r, nowMs) < cls || r.boundSlot) continue;
      if (r.forLogin) ahead.push({ all: [r.forLogin.toLowerCase()], owners: new Set() });
      else ahead.push(takers({ prompt_id: r.prompt_id, repos: r.repos, step: r.step, refs: r.refs }));
    }
    for (const who of ahead.filter((w) => w.all.length).sort((a, b) => a.all.length - b.all.length)) {
      const l = best(left, who);
      if (l !== undefined) left.set(l, left.get(l)! - 1);
    }
    for (const [l, n] of taken) left.set(l, (left.get(l) ?? 0) - n);
    ledgers.set(cls, left);
    return left;
  };
  return {
    room: (cls, c) => {
      const left = ledger(cls);
      return takers(c).all.reduce((n, l) => n + Math.max(0, left.get(l) ?? 0), 0);
    },
    take: (cls, c) => {
      const l = best(ledger(cls), takers(c));
      if (l === undefined) return;
      taken.set(l, (taken.get(l) ?? 0) + 1);
      for (const left of ledgers.values()) left.set(l, (left.get(l) ?? 0) - 1);
    },
  };
}
