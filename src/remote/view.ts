// One reading of the Task Runners for the claim, the room, the taker rule and the picks: the runners module's snapshot (runner
// credentials with their status and lease counts, their users' settings, cool-offs, cached non-write permissions and started
// work) with the accepted model families. Every rule over it is pure; the snapshot is cached 2 s per process by the module.
import type { Db } from "../db/index.ts";
import { loadRunnerSnapshot, type RunnerRow, type RunnerSnapshot, type UserSettings } from "../data/runners/index.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { acceptedModels, familyOf, isTier } from "./mode.ts";
import type { Tier } from "./protocol.ts";
import { claimReposOf } from "./my-repos.ts";
import { skipsIn } from "./my-tasks.ts";
import { itemFilterOf, type ItemFilter } from "./task-items.ts";

export type RemoteView = { now: number; snapshot: RunnerSnapshot; accepted: Record<Tier, string[]> };

/** The snapshot and the accepted model families, in one wave. */
export async function loadView(db: Db, now: number = Date.now()): Promise<RemoteView> {
  const [snapshot, accepted] = await db.together(() => Promise.all([loadRunnerSnapshot(db, now), acceptedModels(db)]));
  return { now, snapshot, accepted };
}

const DEFAULTS: UserSettings = { reserve: { fiveHour: 20, weekly: 20 }, repos: [], maxCalls: null, interactiveSlots: null, manualOnly: false, skipTasks: [], taskItems: "all", runnerPrivate: false };

/** A runner user's settings (the defaults for a login the snapshot does not hold). */
export const settingsOf = (s: RunnerSnapshot, login: string): UserSettings => s.settings.get(login.toLowerCase()) ?? DEFAULTS;

/**
 * The room's write rule: a login counts as able to write to a repo unless a non-write permission confirmed within the
 * permission cache's lifetime is cached (the snapshot's denials). The claim checks the permission itself.
 */
export const canWriteOf = (s: RunnerSnapshot) => (login: string, repo: string): boolean => !s.denied.has(`${login.toLowerCase()}\n${repo}`);

/** The tiers a runner's reported models offer: those whose model is of an accepted family. */
export const tiersOf = (models: RunnerRow["models"], accepted: Record<Tier, string[]>): Set<Tier> =>
  new Set(Object.entries(models).flatMap(([t, m]) => (isTier(t) && typeof m === "string" && familyOf(m, accepted[t]) !== null ? [t] : [])));

/** A runner whose last status is fresh and ready, of a login not cooling off. */
export const freshReady = (s: RunnerSnapshot, r: RunnerRow, now: number): boolean =>
  r.readiness === "ready" && r.reportedAt !== null && r.reportedAt >= now - STATUS_FRESH_MS && !s.cooled.has(r.login.toLowerCase());

/**
 * Whether a Task Runner credential of `login`, connected or not, offers one of `tiers` as it last reported (any tier before its first
 * report); with no tiers, whether the login has a Task Runner credential at all.
 */
export const runnerOffers = (v: RemoteView, login: string, tiers: readonly Tier[]): boolean =>
  v.snapshot.runners.some((r) => r.login.toLowerCase() === login.toLowerCase() && (!tiers.length || r.reportedAt === null || tiers.some((t) => tiersOf(r.models, v.accepted).has(t))));

/**
 * A runner as the taker rule reads it: its user's repos (My repos narrowed by its own last list), skipped tasks, item filter and offered
 * tiers; `manual`: its user's Manual only switch (manual-only.ts), under which it takes no automatic work.
 */
export type Runner = { tokenId: number; login: string; role: string; repos: ReadonlySet<string> | null; skip: ReadonlySet<string>; items: ItemFilter; tiers: ReadonlySet<Tier>; manual: boolean; row: RunnerRow };

/** The user's ItemFilter over the snapshot's started work. */
export const itemFilterIn = (s: RunnerSnapshot, login: string): ItemFilter => itemFilterOf(s.started, login, settingsOf(s, login).taskItems);

/** A runner row as the taker rule reads it. */
export function runnerOf(v: RemoteView, r: RunnerRow): Runner {
  const set = settingsOf(v.snapshot, r.login);
  return {
    tokenId: r.tokenId, login: r.login, role: r.role ?? "", repos: claimReposOf(set.repos, r.idleRepos ?? undefined), skip: skipsIn(set.skipTasks),
    items: itemFilterIn(v.snapshot, r.login), tiers: tiersOf(r.models, v.accepted), manual: set.manualOnly, row: r,
  };
}

const takerCache = new WeakMap<RemoteView, Runner[]>();
/** The takers: fresh, ready runners of users with a role and not cooling off. */
export function takersIn(v: RemoteView): Runner[] {
  let t = takerCache.get(v);
  if (!t) takerCache.set(v, (t = v.snapshot.runners.filter((r) => r.role !== null && freshReady(v.snapshot, r, v.now)).map((r) => runnerOf(v, r))));
  return t;
}
