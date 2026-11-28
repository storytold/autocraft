// Calls for work a person started or approved in the maintainer workflow (src/workflow): every item a queued call names has a
// live workflow in a repo on that workflow whose starter or approver is the person, or is the PR that the live implement
// workflow of an issue, which they started or approved, works on. Their own Task Runners take such a call first, ahead of
// automatic work, in a slot that counts toward their Max calls at once, and not held back by their cool-off. While one of
// their runners is fresh, ready and not cooling off, offers the call's tier and may take it (role rules, write permission, a
// token whose model did not decline it), other users' runners pass the call over, for at most STARTED_HOLD_MS from its
// queueing (calls.ts claimOrder, takers.ts sweepTakers). Then, or when no owner can take it, any runner takes it under all
// its own limits. For the taker rule (takers.ts) an owner's runner counts connected or not, ready or not: the work waits for
// it rather than being reported as having no taker. Registered as a wait in src/stages/registry.ts. A call of the post-merge
// review step on a merged PR is such work too: of the starter and approver of the workflow that ended done through that merge, for
// MERGED_WORK_MS after its last write (src/data/workflow/fragments.ts endedByMerge, which the lease's condition reads too).
// A person who took a live workflow's work onto their Task Runner (`take`, src/data/workflow/item-runners.ts) is one of its
// people too, while no Task Runner of its starter or approver is ready with room (readyWithRoom; the lease's condition is
// readyWithRoomExpr in src/data/runners/cross.ts): the starter's runner comes first, the taker's takes the work while it cannot.
// An item workflow's work bound to a person (the implement step's calls, takeableBound) goes the same way: a taker's runner takes it
// while no runner of that person is ready with room (boundTakers; the lease's condition is boundTakeAllows in cross.ts).
// A repo's Fix red main approval (src/mainfix/approval.ts) makes the main-fix step's calls in that repo, which name no item, the work
// of the person who gave it, until it is revoked (approvedFix; the lease's condition is the MAINFIX_STEP branch of startedWorkAllows).
import type { ItemRef } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import type { Entry } from "../workflow/types.ts";
import { judges, roleFits } from "./rules.ts";
import { taskOfStep } from "./my-tasks.ts";
import type { Tier } from "./protocol.ts";
import { IDLE_FRESH_MS, LIVE_LEASE_MS, MAINFIX_STEP, POSTMERGE_STEP, takeableBound } from "../data/runners/index.ts";
import { scaled } from "./time-scale.ts";
import { canWriteOf, freshReady, loadView, settingsOf, tiersOf, type RemoteView } from "./view.ts";

/** How long other users' runners pass a started call over for its owner, from its queueing. */
export const STARTED_HOLD_MS = scaled(10 * 60_000);

/** The My tasks ids (my-tasks.ts) of the steps a live workflow of each entry runs. */
const ENTRY_TASKS: Record<Entry, ReadonlySet<string>> = {
  review: new Set(["review", "fixup", "verify", "merge"]),
  fixup: new Set(["fixup", "review", "verify", "merge"]),
  implement: new Set(["fix", "review", "fixup", "verify", "merge"]),
  merge: new Set(["fixup", "review", "verify", "merge"]),
};
/** Workflow states in which AutoCraft runs steps; in the others the workflow waits for a person. */
const WORKING = new Set(["running", "waiting"]);

export type StartedCalls = {
  /**
   * The lowercase logins whose call one with these items is: those that started or approved work on every one of them, or took it onto
   * their Task Runner while no runner of those is ready with room. For a call of the
   * post-merge review (`step` postmerge), a merged PR's workflow that ended done through that merge lately counts as such work. A call
   * of the main-fix step that names no item is the work of who approved Fix red main on every one of `repos`.
   */
  owners: (refs: readonly ItemRef[], step?: string, tier?: Tier, repos?: readonly string[]) => ReadonlySet<string>;
  /** The tiers the lowercase login's fresh, ready Task Runners offer while the login is not cooling off (empty: none). */
  tiersOf: (login: string) => ReadonlySet<Tier>;
  /** Whether one of the login's such runners, of a credential other than `refusedToken`, may take a call on `repos` of `prompt_id`. */
  canTake: (login: string, c: { prompt_id: string; repos: readonly string[]; tier?: Tier; refusedToken?: number | null }) => boolean;
  /** The lowercase logins with such a runner. */
  runnerLogins: readonly string[];
  /**
   * The lowercase logins whose started work a call or job is: with `refs`, owners(refs); without (a job asked about before its
   * items are known), the logins with such a runner that have, in every one of `repos`, a live workflow AutoCraft is working
   * on (running or waiting) whose steps include `step`'s task, or for the main-fix step that approved Fix red main there. No step: none.
   */
  ownersFor: (c: { repos: readonly string[]; refs?: readonly ItemRef[]; step?: string; tier?: Tier }) => ReadonlySet<string>;
  /**
   * The lowercase logins whose started work a call or job is (as ownersFor) and who have a runner token, connected or not, ready
   * or not, cooling off or not, that may take it once it claims: the role rules, write permission, and its tier among the models
   * the runner last reported (any tier before its first report). The taker rule counts them, so the work waits for their runner.
   */
  waitersFor: (c: { prompt_id: string; repos: readonly string[]; refs?: readonly ItemRef[]; step?: string; tier?: Tier }) => ReadonlySet<string>;
  /**
   * The lowercase logins that took onto their Task Runner the live workflow of every one of `refs` (at least one), or of the issue whose
   * PR one is. With `forLogin`, a call bound to that person: only an item workflow's bound work (takeableBound), and none while a runner
   * of `forLogin` is ready with room for `tier` (readyWithRoom), leaving out the credential whose model declined the call
   * (`refusedToken`). The lease's side is boundTakeAllows in src/data/runners/cross.ts.
   */
  boundTakers: (c: { prompt_id: string; refs: readonly ItemRef[]; forLogin: string; tier?: Tier; refusedToken?: number | null }) => ReadonlySet<string>;
};

const NONE: ReadonlySet<never> = new Set();

/** Reads the live workflows' starters and approvers and the runners that may take their calls. */
export async function readStartedCalls(db: Db, nowMs: number): Promise<StartedCalls> {
  return startedOf(await loadView(db, nowMs));
}

const startedCache = new WeakMap<RemoteView, StartedCalls>();

/** StartedCalls over one reading of the runners (memoised per reading). */
export function startedOf(v: RemoteView): StartedCalls {
  let s = startedCache.get(v);
  if (!s) startedCache.set(v, (s = buildStarted(v)));
  return s;
}

/** The runner credentials whose reported model serves `tier` (an accepted family), for the lease's taker rule (cross.ts readyWithRoomExpr). */
export const tierTokens = (v: RemoteView, tier: Tier): number[] =>
  v.snapshot.runners.filter((r) => tiersOf(r.models, v.accepted).has(tier)).map((r) => r.tokenId);

/**
 * Whether some Task Runner of `login` could run a call of `tier` now (any tier when left out): a maintainer's or operator's fresh,
 * ready runner not cooling off whose reported model serves the tier, active (a lease heartbeat within LIVE_LEASE_MS or an empty claim
 * within IDLE_FRESH_MS) and with a free slot (its slots, less the fast lane when it has two or more, less its leases outside the own
 * lane), the login under its Max calls at once; never the credential `exceptToken`. The lease's side is readyWithRoomExpr in src/data/runners/cross.ts.
 */
export function readyWithRoom(v: RemoteView, login: string, tier?: Tier, exceptToken: number | null = null): boolean {
  const { snapshot, now } = v;
  const key = login.toLowerCase();
  const max = settingsOf(snapshot, key).maxCalls;
  if (max !== null && (snapshot.leasedByLogin.get(key)?.leased ?? 0) >= max) return false;
  return snapshot.runners.some((r) => r.login.toLowerCase() === key && r.tokenId !== exceptToken && (r.role === "maintainer" || r.role === "operator") && freshReady(snapshot, r, now)
    && (tier === undefined || tiersOf(r.models, v.accepted).has(tier))
    && ((r.beatAt ?? -Infinity) >= now - LIVE_LEASE_MS || (r.idleClaimAt ?? -Infinity) >= now - IDLE_FRESH_MS)
    && (r.slots ?? 1) - ((r.slots ?? 1) >= 2 ? 1 : 0) > r.leased);
}

function buildStarted(v: RemoteView): StartedCalls {
  const { snapshot, accepted, now: nowMs } = v;
  const { live, prs, merged } = snapshot.started;
  const byItem = new Map<string, Set<string>>(), byMerged = new Map<string, Set<string>>();
  const add = (to: Map<string, Set<string>>, repo: string, number: number, logins: (string | null)[]) => {
    const key = `${repo}#${number}`;
    let s = to.get(key);
    if (!s) to.set(key, (s = new Set()));
    for (const l of logins) if (l) s.add(l.toLowerCase());
  };
  // A workflow's people: its starter and approver, and the logins that took its work while none of those could run the call now.
  type Row = { started_by: string; approved_by: string | null; taken_by?: string[] };
  const ready = new Map<string, boolean>();
  const readyOf = (l: string, tier?: Tier, exceptToken: number | null = null): boolean => {
    const k = `${l}\n${tier ?? ""}\n${exceptToken ?? ""}`;
    return ready.get(k) ?? ready.set(k, readyWithRoom(v, l, tier, exceptToken)).get(k)!;
  };
  const takersOf = (w: Row, tier?: Tier): string[] =>
    w.taken_by?.length && ![w.started_by, w.approved_by].some((l) => l && readyOf(l.toLowerCase(), tier)) ? w.taken_by : [];
  const peopleOf = (w: Row, tier?: Tier): (string | null)[] => [w.started_by, w.approved_by, ...takersOf(w, tier)];
  const taken = new Map<string, Row[]>();
  for (const { repo, number, w } of [...live.map((w) => ({ repo: w.repo, number: w.number, w })), ...prs.map((w) => ({ repo: w.repo, number: w.prNumber, w }))]) {
    add(byItem, repo, number, [w.started_by, w.approved_by]);
    const key = `${repo}#${number}`;
    if (w.taken_by?.length) (taken.get(key) ?? taken.set(key, []).get(key)!).push(w);
  }
  for (const p of merged) add(byMerged, p.repo, p.prNumber, [p.started_by, p.approved_by]);
  // Who approved Fix red main, by repo: the main-fix step's item-less calls there are theirs.
  const fixers = new Map<string, string>(snapshot.started.mainfix.map((a) => [a.repo, a.by.toLowerCase()]));
  const approvedFix = (repos: readonly string[], step?: string): ReadonlySet<string> => {
    if (step !== MAINFIX_STEP || !repos.length) return NONE;
    const by = fixers.get(repos[0]!);
    return by !== undefined && repos.every((x) => fixers.get(x) === by) ? new Set([by]) : NONE;
  };
  const runnersOf = new Map<string, { role: string; tokens: Map<number, Set<Tier>> }>();
  for (const r of snapshot.runners) {
    if (r.role === null || !freshReady(snapshot, r, nowMs)) continue;
    const login = r.login.toLowerCase();
    const u = runnersOf.get(login) ?? { role: r.role, tokens: new Map<number, Set<Tier>>() };
    u.tokens.set(r.tokenId, tiersOf(r.models, accepted));
    runnersOf.set(login, u);
  }
  const runnerLogins = [...runnersOf.keys()];
  // Every runner token, by login: its tiers as last reported, null before its first report.
  const tokensOf = new Map<string, { role: string; tiers: (Set<Tier> | null)[] }>();
  for (const r of snapshot.runners) {
    const login = r.login.toLowerCase();
    const u = tokensOf.get(login) ?? { role: r.role ?? "", tiers: [] };
    u.tiers.push(r.reportedAt === null ? null : tiersOf(r.models, accepted));
    tokensOf.set(login, u);
  }
  const tokenLogins = [...tokensOf.keys()];
  // The room's write rule: only a non-write permission confirmed within the cache's lifetime leaves a login out.
  const canWrite = canWriteOf(snapshot);
  const owners = (refs: readonly ItemRef[], step?: string, tier?: Tier, repos: readonly string[] = []): ReadonlySet<string> => {
    if (!refs.length) return approvedFix(repos, step);
    const postmerge = step === POSTMERGE_STEP;
    if (!byItem.size && !(postmerge && byMerged.size)) return NONE;
    const of = (r: ItemRef): ReadonlySet<string> | undefined => {
      const key = `${r.repo}#${r.number}`, a = byItem.get(key), b = postmerge ? byMerged.get(key) : undefined;
      const t = (taken.get(key) ?? []).flatMap((w) => takersOf(w, tier));
      return a && (b || t.length) ? new Set([...a, ...b ?? [], ...t]) : a ?? b;
    };
    const [first, ...rest] = refs.map(of);
    if (!first || rest.some((s) => !s)) return NONE;
    return new Set([...first].filter((l) => rest.every((s) => s!.has(l))));
  };
  /** owners(refs) with `refs`; without, those of `logins` with a working live workflow in every repo whose steps include the step's task. */
  const startedBy = (logins: readonly string[], c: { repos: readonly string[]; refs?: readonly ItemRef[]; step?: string; tier?: Tier }): ReadonlySet<string> => {
    if (c.refs) return owners(c.refs, c.step, c.tier, c.repos);
    if (c.step === undefined || !c.repos.length) return NONE;
    if (c.step === MAINFIX_STEP) {
      const fix = approvedFix(c.repos, c.step);
      return new Set(logins.filter((l) => fix.has(l)));
    }
    const task = taskOfStep(c.step);
    const working = live.filter((w) => WORKING.has(w.state) && ENTRY_TASKS[w.entry as Entry]?.has(task));
    return new Set(logins.filter((l) => c.repos.every((x) => working.some((w) => w.repo === x && peopleOf(w, c.tier).some((b) => b?.toLowerCase() === l)))));
  };
  const deniedOn = (login: string, repos: readonly string[]): boolean => repos.some((x) => !canWrite(login, x));
  return {
    owners, runnerLogins,
    tiersOf: (login) => new Set([...runnersOf.get(login.toLowerCase())?.tokens.values() ?? []].flatMap((t) => [...t])),
    canTake: (login, c) => {
      const u = runnersOf.get(login.toLowerCase());
      if (!u || !roleFits(u.role, c) || deniedOn(login, c.repos)) return false;
      return [...u.tokens].some(([id, tiers]) => id !== c.refusedToken && (c.tier === undefined ? tiers.size > 0 : tiers.has(c.tier)));
    },
    ownersFor: (c) => startedBy(runnerLogins, c),
    boundTakers: (c) => {
      if (!c.refs.length || !takeableBound(c.prompt_id) || !taken.size) return NONE;
      const [first, ...rest] = c.refs.map((r) => new Set((taken.get(`${r.repo}#${r.number}`) ?? []).flatMap((w) => w.taken_by ?? [])));
      const all = [...first!].filter((l) => rest.every((x) => x.has(l)));
      return all.length && !readyOf(c.forLogin.toLowerCase(), c.tier, c.refusedToken ?? null) ? new Set(all) : NONE;
    },
    waitersFor: (c) => new Set([...startedBy(tokenLogins, c)].filter((l) => {
      const u = tokensOf.get(l);
      return !!u && roleFits(u.role, c) && !deniedOn(l, c.repos) && u.tiers.some((t) => t === null || (c.tier === undefined ? t.size > 0 : t.has(c.tier)));
    })),
  };
}

/**
 * Whether a queued call is held for an owner other than `login` (null: anyone): within STARTED_HOLD_MS of its queueing, an
 * owner who may take it (canTake: a fresh, ready runner not cooling off that offers its tier, the role rules, write permission,
 * a credential other than the one whose model declined it; not a judging call on an item they authored). A call bound to a
 * user is never one of these. A runner's harness, effort and time limit are known only at its claim: a call none of the
 * owner's runners will lease for those is free once the hold ends.
 */
export function heldForOwner(s: StartedCalls, c: HeldCall, login: string | null, nowMs: number): boolean {
  return heldFor(s, c, login, nowMs) !== null;
}

type HeldCall = { forLogin: string | null; refs: readonly ItemRef[]; repos: readonly string[]; prompt_id: string; step: string; tier: Tier; authors: ReadonlySet<string>; refusedToken: number | null; since: number };

/** The owner (lowercase login) a queued call is held for, as heldForOwner decides it; null when it is held for none. */
export function heldFor(s: StartedCalls, c: HeldCall, login: string | null, nowMs: number): string | null {
  if (c.forLogin !== null || c.since < nowMs - STARTED_HOLD_MS) return null;
  const self = login?.toLowerCase() ?? null;
  const judging = judges(c.prompt_id);
  for (const o of s.owners(c.refs, c.step, c.tier, c.repos)) if (o !== self && !(judging && c.authors.has(o)) && s.canTake(o, c)) return o;
  return null;
}
