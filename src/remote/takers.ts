// Takers in the user-local model queue: whether some Task Runner may take calls on a repo now, and what happens when none
// can. A taker is a fresh, ready Task Runner (helpers.ts) of a user who is not cooled off (cooloff.ts) and who may take the
// call (runnerTakes: role rules, write permission by the room's rule roomCanWrite, My repos narrowed by the runner's own
// list), busy or not. A Manual only user's runner (manual-only.ts) is no taker for automatic work, which it never claims: only
// for the calls it claims (work its user started or approved, calls bound to its user or taken over, follow-ups and picks). For work
// its user started or approved (started.ts) a runner is a taker whatever its My repos, tasks and items, ready or not, while it
// holds the work (it reported lately, or its usage limit or cool-off has a known end). takerTest is the one taker rule: pools and the runner's job starts skip work without a taker, the
// dashboard's minute maintenance runs sweepTakers: a queued call with no taker for NO_TAKER_MS is withdrawn, and pipeline-on
// repos with no taker are recorded for the remote-no-taker health check. Follow-up turns and calls with a pick that counts
// keep their own rules (calls.ts awaitCall, picks). A call bound to a user (a maintainer's conversation turn) has a taker only
// in that user's runners; an item workflow's bound work (the implement step's calls) also in the runners of a person who took
// the workflow's work while that user's runners cannot run it (started.ts boundTakers).
import { NO_TAKER_PREFIX } from "./calls.ts";
import { t, tk } from "../i18n/index.ts";
import { orderedOf, type Cand } from "./cands.ts";
import { pickCounts } from "./picks-rules.ts";
import { heldForOwner, STARTED_HOLD_MS, startedOf, type OwnerRole } from "./started.ts";
import { acceptedModels } from "./mode.ts";
import type { Tier } from "./protocol.ts";
import { roleFits, runnerTakes } from "./rules.ts";
import { TASK_CHOICES, taskOfStep } from "./my-tasks.ts";
import { CALLER_STALE_MS } from "./room.ts";
import { itemsFit, TASK_ITEMS, TASK_ITEMS_TITLE, type TaskItems } from "./task-items.ts";
import type { ItemRef } from "../../web/src/api/types.ts";
import { scaled } from "./time-scale.ts";
import type { Db } from "../db/index.ts";
import { loadSweepState, loadTakerSignature, loadUserSettings, pickerLoginsOf, saveTakerSweep, takeableBound, withdrawGoneCalls } from "../data/runners/index.ts";
import { canWriteOf, itemFilterIn, loadView, settingsOf, takersIn, type RemoteView, type Runner } from "./view.ts";
import { itemFilterOf } from "./task-items.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";

/** How long a queued call may have no taker before it is withdrawn, and a pipeline-on repo before the health check warns. */
export const NO_TAKER_MS = scaled(10 * 60_000);

/** A call as the taker rule reads it: its prompt (role rules for discord.* calls) and the repos it names. */
/**
 * `step`: the call's step, for the takers' tasks (my-tasks.ts); left out, the question is about repos alone. `someTask`: with no
 * step, only a runner whose user takes at least one task counts (with none ticked a user takes only picks).
 */
export type TakerCall = {
  prompt_id: string; repos: readonly string[]; step?: string; someTask?: boolean; /** The call's items; left out, a question asked before they are known (task-items.ts). */ refs?: readonly ItemRef[]; /** Only runners whose user takes some items count. */ filtered?: boolean;
  /** A call bound to this user (calls.ts NewCall.forLogin): only their runners count, under the role rules and write permission alone, as for a pick, and only those that offer `tier`. */
  forLogin?: string | null;
  tier?: Tier;
  /** For a bound call: the runner credential whose model declined it, which is no taker for it. */
  refusedToken?: number | null;
};

/**
 * Whether some taker may take a call now, for many questions at one moment (a pool's round, the runner's pass over queued
 * jobs, a sweep): the runners are read once, on the first question.
 */
export function takerTest(db: Db, nowMs: number): (c: TakerCall) => Promise<boolean> {
  let test: ((c: TakerCall) => boolean) | null = null;
  return async (c) => (test ??= takerTestIn(await loadView(db, nowMs)))(c);
}

/**
 * The runners the taker rule reads, in a form that changes only when they or what decides their repos change (the runners
 * module's taker signature). The planner adds it to its input, so work left for want of a taker is planned again when one
 * connects or comes back, without every status report waking the planner.
 */
export async function takerSignature(db: Db, nowMs: number = Date.now()): Promise<string> {
  return await loadTakerSignature(db, nowMs);
}

/** The taker rule over one reading of the runners. */
export function takerTestIn(v: RemoteView): (c: TakerCall) => boolean {
  const runners = takersIn(v), canWrite = canWriteOf(v.snapshot), owner = startedOf(v);
  const bound = (r: Runner, login: string, c: TakerCall): boolean =>
    r.login.toLowerCase() === login && r.tokenId !== c.refusedToken && (c.tier === undefined || r.tiers.has(c.tier)) && roleFits(r.role, c) && c.repos.every((x) => canWrite(r.login, x));
  return (c) => c.forLogin
    ? runners.some((r) => bound(r, c.forLogin!.toLowerCase(), c))
      // An item workflow's bound work also has a taker in the runners of a person who took it (started.ts boundTakers).
      || (!!c.refs?.length && [...owner.boundTakers({ prompt_id: c.prompt_id, refs: c.refs, forLogin: c.forLogin, ...(c.tier && { tier: c.tier }), refusedToken: c.refusedToken ?? null })].some((l) => runners.some((r) => bound(r, l, c))))
    : runners.some((r) => !(c.someTask && r.skip.size >= TASK_CHOICES.length) && !(c.filtered && !r.items) && autoTakes(r, c, canWrite)) || owner.waitersFor(c).size > 0;
}

/** Whether a runner takes `c` as automatic work: runnerTakes, and its user is not on Manual only. */
function autoTakes(r: Runner, c: Parameters<typeof runnerTakes>[1], canWrite: (login: string, repo: string) => boolean): boolean {
  return !r.manual && runnerTakes(r, c, canWrite);
}

/** Why a person's Task Runner cannot claim now: no fresh report, held for its plan usage, cooling off, or another readiness. */
export type RunnerHold = "offline" | "usage-limit" | "cooling-off" | "not-ready";

/**
 * The people whose own Task Runners a call waits for: the call has a taker (takerTest), but only through the runners of the
 * people whose started work it is (StartedCalls.waitersFor), none of which may claim it now; with why each one cannot. Empty
 * when a runner may claim it now, or when it has no taker at all.
 */
export async function waitingOn(db: Db, c: TakerCall, nowMs: number = Date.now()): Promise<RunnerWait[]> {
  return waitingOnIn(await loadView(db, nowMs), c);
}

/**
 * One person whose Task Runner a call waits for, and why; `until`: for a usage limit, the earliest time one of their runners reported it ends;
 * `role`: their part in the work (StartedCalls.roleOf), which names them to a reader who may not see logins.
 */
export type RunnerWait = { login: string; hold: RunnerHold; until: number | null; role?: OwnerRole };

export function waitingOnIn(v: RemoteView, c: TakerCall): RunnerWait[] {
  const runners = takersIn(v), canWrite = canWriteOf(v.snapshot), s = startedOf(v);
  if (runners.some((r) => autoTakes(r, c, canWrite)) || [...s.ownersFor(c)].some((o) => s.canTake(o, c))) return [];
  return [...s.waitersFor(c)].sort().map((login) => ({ ...runnerHoldOf(v, login), role: s.roleOf(login, { refs: c.refs ?? [], repos: c.repos }) }));
}

/** Why none of `login`'s Task Runners can claim now (RunnerWait), for a login whose runners cannot. */
export function runnerHoldOf(v: RemoteView, login: string): RunnerWait {
  const key = login.toLowerCase(), nowMs = v.now;
  const fresh = v.snapshot.runners.filter((r) => r.login.toLowerCase() === key && r.reportedAt !== null && r.reportedAt >= nowMs - STATUS_FRESH_MS);
  const hold: RunnerHold = !fresh.length ? "offline" : fresh.some((r) => r.readiness === "quota-held") ? "usage-limit" : v.snapshot.cooled.has(key) || fresh.some((r) => r.readiness === "cooled-off") ? "cooling-off" : "not-ready";
  const ends = hold === "usage-limit" ? fresh.flatMap((r) => (r.readiness === "quota-held" && r.until !== null && Date.parse(r.until) > nowMs ? [Date.parse(r.until)] : [])) : [];
  return { login: key, hold, until: ends.length ? Math.min(...ends) : null };
}

const HOLD_TEXT: Record<RunnerHold, string> = { offline: tk("offline"), "usage-limit": tk("usage limit"), "cooling-off": tk("cooling off"), "not-ready": tk("not ready") };
export const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/**
 * The line of work that waits for one person's Task Runner (waitingOnIn, or loginWaitIn's renewal), in the words of the item's state
 * line (src/workflow/waits.ts). `shown`: the reader may see whose runner it is and why it cannot claim (operators and maintainers);
 * others read the person by role (hiddenWaitText).
 */
export function runnerWaitText(w: RunnerWait | { login: string; renewsAt: number }, shown: boolean): string {
  if (!shown) return "renewsAt" in w ? t("Waiting for a Task Runner") : hiddenWaitText(w);
  if ("renewsAt" in w) return t("Waiting for {login}'s Task Runner (login renews at {time} UTC)", { login: w.login, time: hhmm(w.renewsAt) });
  const why = w.until !== null ? t("{hold} until {time} UTC", { hold: t(HOLD_TEXT[w.hold]), time: hhmm(w.until) }) : t(HOLD_TEXT[w.hold]);
  return t("Waiting for {login}'s Task Runner ({why})", { login: w.login, why });
}

/** A hidden wait line names the person by their part in the work. */
const ROLE_WAIT: Record<OwnerRole, string> = {
  approver: tk("Waiting for the approver's Task Runner"), starter: tk("Waiting for the starter's Task Runner"), taker: tk("Waiting for the Task Runner of a person who took the work"),
};
const ROLE_OFFLINE: Record<OwnerRole, string> = {
  approver: tk("Waiting for the approver's Task Runner (offline)"), starter: tk("Waiting for the starter's Task Runner (offline)"), taker: tk("Waiting for the Task Runner of a person who took the work (offline)"),
};

/**
 * runnerWaitText for a reader who may not see logins or usage: the person by their role in the work, and only whether their runner is
 * offline; without a role, that it waits for a Task Runner.
 */
export function hiddenWaitText(w: Pick<RunnerWait, "hold" | "role">): string {
  if (!w.role) return t("Waiting for a Task Runner");
  return t((w.hold === "offline" ? ROLE_OFFLINE : ROLE_WAIT)[w.role]);
}

/**
 * The person whose Task Runner a call waits for while its harness login renews, and when it renews: every runner that may take
 * the call now (a taker, or for started work a runner of its people) left calls at its latest claim for want of room on that login
 * (RunnerRow.loginRenewsAt, src/remote/calls.ts LOGIN_CUT_MIN_MS); the earliest renewal. Null when some runner may take it
 * without that wait, or none may.
 */
export function loginWaitIn(v: RemoteView, c: TakerCall): { login: string; at: number } | null {
  const canWrite = canWriteOf(v.snapshot), s = startedOf(v), owners = s.ownersFor(c);
  const now = takersIn(v).filter((r) => autoTakes(r, c, canWrite) || (owners.has(r.login.toLowerCase()) && s.canTake(r.login, c)));
  if (!now.length || now.some((r) => (r.row.loginRenewsAt ?? 0) <= v.now)) return null;
  const first = now.reduce((a, b) => (b.row.loginRenewsAt! < a.row.loginRenewsAt! ? b : a));
  return { login: first.login, at: first.row.loginRenewsAt! };
}

/**
 * Whether a taker other than the runner token `exceptToken` (null: any) may take `c` on `c.tier` now: where a call that a
 * model's safety filter declined can run once more (calls.ts submitCall). A bound call counts only its user's runners and, for an
 * item workflow's bound work, the runners of a person who took it while its user's cannot run it (started.ts boundTakers); an unbound
 * call also the runners of the people whose started work it is (StartedCalls.ownersFor).
 */
export function tierTaker(v: RemoteView, c: TakerCall & { tier: Tier }, exceptToken: number | null): boolean {
  const canWrite = canWriteOf(v.snapshot), s = startedOf(v);
  const logins = c.forLogin ? new Set([c.forLogin.toLowerCase(), ...(c.refs?.length ? s.boundTakers({ prompt_id: c.prompt_id, refs: c.refs, forLogin: c.forLogin, tier: c.tier, refusedToken: exceptToken }) : [])]) : null;
  // An unbound call also runs on a runner of the people whose started work it is, whatever their My repos, tasks or Manual only.
  const owners = logins ? null : s.ownersFor({ repos: c.repos, ...(c.refs && { refs: c.refs }), ...(c.step !== undefined && { step: c.step }), tier: c.tier });
  const asPerson = (r: Runner): boolean => roleFits(r.role, c) && c.repos.every((x) => canWrite(r.login, x));
  return takersIn(v).some((r) => r.tokenId !== exceptToken && r.tiers.has(c.tier) && (logins
    ? logins.has(r.login.toLowerCase()) && asPerson(r)
    : autoTakes(r, c, canWrite) || (owners!.has(r.login.toLowerCase()) && asPerson(r))));
}

/** A key equal for two units exactly when the same users of `logins` take them under their item choices (task-items.ts); "" when none does. */
function filterKey(filters: { login: string; f: ReturnType<typeof itemFilterIn> }[]): (refs: readonly { repo: string; number: number }[]) => string {
  const some = filters.filter((x) => x.f !== null);
  if (!some.length) return () => "";
  return (refs) => some.filter(({ f }) => itemsFit(f, { repos: [], refs })).map((x) => x.login).join(",");
}

/**
 * For batching: a key equal for two units exactly when the same filtered users take them, so a batch of one key matches a
 * filtered user when every unit in it does and a unit some takers take is never held with units only others take. Every user
 * with a stored item choice counts, connected or not, so a runner that connects after the batches are made is not handed items
 * its user does not take.
 */
export async function batchKey(db: Db): Promise<(refs: readonly { repo: string; number: number }[]) => string> {
  const [settings, v] = await db.together(() => Promise.all([loadUserSettings(db, "all"), loadView(db)]));
  const logins = [...settings].filter(([, s]) => s.taskItems !== "all").map(([login]) => login).sort();
  return filterKey(logins.map((login) => ({ login, f: itemFilterOf(v.snapshot.started, login, settings.get(login)!.taskItems) })));
}

/**
 * For caching room and taker answers by unit: as batchKey, over the users of the fresh, ready runners with an item choice (a
 * superset of the takers and the room's helpers), so units of one repo share answers when no connected runner filters.
 */
export function roomKey(v: RemoteView): (refs: readonly { repo: string; number: number }[]) => string {
  const logins = [...new Set(v.snapshot.runners.filter((r) => r.readiness === "ready" && r.reportedAt !== null && r.reportedAt >= v.now - STATUS_FRESH_MS && settingsOf(v.snapshot, r.login).taskItems !== "all")
    .map((r) => r.login.toLowerCase()))].sort();
  return filterKey(logins.map((login) => ({ login, f: itemFilterIn(v.snapshot, login) })));
}

/**
 * The error of a call withdrawn for lack of a taker: its caller skips the work (NoTakerError). `step`: a taker may take calls on
 * its repos, but none takes its task. `items`: the item choices of the takers that take its repos and task but not its items
 * (task-items.ts).
 */
export const noTakerReason = (repos: readonly string[], step?: string, items?: readonly Exclude<TaskItems, "all">[]): string => {
  const task = step === undefined ? undefined : taskOfStep(step);
  return `${NO_TAKER_PREFIX} ${items?.length ? `on its items (My tasks: ${items.map((x) => TASK_ITEMS_TITLE[x]).join(" or ")})` : task !== undefined ? `of the ${TASK_CHOICES.find((t) => t.id === task)?.title ?? task} task (My tasks)` : repos.length ? `on ${repos.join(", ")}` : "that name no repo"}`;
};

/** Whether one of `login`'s own Task Runners is a taker for a call bound to them (NewCall.forLogin) on `repos` now. */
export async function ownTaker(db: Db, login: string, c: { prompt_id: string; repos: readonly string[]; tier: Tier }, nowMs: number = Date.now()): Promise<boolean> {
  return takerTestIn(await loadView(db, nowMs))({ ...c, forLogin: login });
}

/** The error of a call withdrawn because the only Task Runners that would take it are on Manual only, which take no automatic work. */
export const manualOnlyReason = (repos: readonly string[]): string =>
  `${NO_TAKER_PREFIX} ${repos.length ? `on ${repos.join(", ")}` : "that name no repo"}: no Task Runner takes automatic work there (the Task Runners that would are on Manual only)`;

/** The error of a bound call withdrawn because none of its user's Task Runners is ready: its caller skips the work (NoTakerError). */
export const noOwnRunnerReason = (login: string): string => `${NO_TAKER_PREFIX} for ${login}: none of their Task Runners is connected and ready`;

/**
 * Why no taker takes a call `takes` says no to: its user's runners for a bound call; else its repos (Manual only when such a runner would
 * take them), else its task, else the item choices of the runners that take the rest.
 */
function whyNoTaker(v: RemoteView, takes: (c: TakerCall) => boolean, c: { prompt_id: string; repos: readonly string[]; step: string; forLogin?: string | null }): string {
  if (c.forLogin) return noOwnRunnerReason(c.forLogin);
  const canWrite = canWriteOf(v.snapshot);
  if (!takes({ prompt_id: c.prompt_id, repos: c.repos })) return takersIn(v).some((r) => r.manual && runnerTakes({ ...r, items: null }, { prompt_id: c.prompt_id, repos: c.repos }, canWrite)) ? manualOnlyReason(c.repos) : noTakerReason(c.repos);
  if (!takes({ prompt_id: c.prompt_id, repos: c.repos, step: c.step })) return noTakerReason(c.repos, c.step);
  const choices = new Set(takersIn(v).filter((r: Runner) => !r.manual && r.items && runnerTakes({ ...r, items: null }, { prompt_id: c.prompt_id, repos: c.repos, step: c.step }, canWrite)).map((r) => settingsOf(v.snapshot, r.login).taskItems));
  return noTakerReason(c.repos, c.step, TASK_ITEMS.filter((x): x is Exclude<TaskItems, "all"> => x !== "all" && choices.has(x)));
}

/**
 * Why no connected Task Runner may take a call of `step` on `repo` now, or null when one may. For a request that would
 * otherwise queue work nothing takes.
 */
export async function noTakerFor(db: Db, repo: string, step: string, nowMs: number = Date.now()): Promise<string | null> {
  const v = await loadView(db, nowMs);
  const takes = takerTestIn(v);
  if (takes({ prompt_id: "", repos: [repo], step })) return null;
  return whyNoTaker(v, takes, { prompt_id: "", repos: [repo], step });
}

/**
 * One maintenance pass at `nowMs`. Each pipeline-on repo with no taker whose user takes some task keeps the time it was first seen so
 * (remote_no_taker); one with a taker loses it. Each queued call with a live caller that is no follow-up, has no pick
 * that counts and is not held for the user who started its work (started.ts) gets the same mark (no_taker_since), and is withdrawn once
 * the mark is NO_TAKER_MS old. Before that, queued calls whose items all merged or closed are withdrawn (withdrawGoneCalls), so one the sync
 * did not see close (queued before that rule, say) ends here; their jobs skip the item. One statement, one read wave and one write transaction.
 * Then `stalled` gets the calls that cannot run now (StalledHook; src/core/runner-room.ts stallNotices tells the people whose work they are). Returns the
 * number of calls withdrawn.
 */
export async function sweepTakers(db: Db, nowMs: number = Date.now(), o: { stalled?: StalledHook } = {}): Promise<number> {
  const gone = (await withdrawGoneCalls(db, nowMs)).length;
  const [st, accepted] = await db.together(() => Promise.all([loadSweepState(db, nowMs), acceptedModels(db)]));
  const v: RemoteView = { now: nowMs, snapshot: st.snapshot, accepted };
  const takes = takerTestIn(v), started = startedOf(v), pickers = pickerLoginsOf(st.snapshot, nowMs);
  const untaken = st.pipelineRepos.filter((repo) => !takes({ prompt_id: "", repos: [repo], someTask: true }));
  const plan = { insertRepos: untaken, deleteRepos: [...st.noTakerRepos.keys()].filter((r) => !untaken.includes(r)), mark: [] as number[], clear: [] as number[], withdraw: [] as { id: number; reason: string }[] };
  for (const c of orderedOf(st.queue, nowMs).all) {
    const since = st.marked.get(c.id);
    const own = c.parent_id !== null || c.seen_at < nowMs - CALLER_STALE_MS || heldForOwner(started, c, null, nowMs) || pickCounts(c, nowMs, (who) => pickers.has(who));
    if (own || takes(c)) {
      if (since !== undefined) plan.clear.push(c.id);
    } else if (since === undefined) plan.mark.push(c.id);
    else if (since <= nowMs - NO_TAKER_MS) plan.withdraw.push({ id: c.id, reason: whyNoTaker(v, takes, c) });
  }
  const withdrawn = await saveTakerSweep(db, plan, nowMs);
  if (o.stalled) {
    const cleared = new Set(plan.clear), marking = new Set(plan.mark);
    // Without a taker (a bound call only when it is an item workflow's implementation, whose people are told); or started work past its
    // owners' hold that waits for their runners, none of which can claim it (waitingOnIn).
    const untaken = (c: Cand): boolean => !cleared.has(c.id) && (st.marked.has(c.id) || marking.has(c.id));
    const stalled = orderedOf(st.queue, nowMs).all.filter((c) => c.parent_id === null && c.seen_at >= nowMs - CALLER_STALE_MS && (c.forLogin !== null
      ? takeableBound(c.prompt_id) && untaken(c)
      : untaken(c) || (c.since < nowMs - STARTED_HOLD_MS && waitingOnIn(v, c).length > 0)));
    if (stalled.length) await o.stalled(v, stalled);
  }
  return gone + withdrawn;
}

/**
 * What the sweep hands on: queued calls with a live caller that have no taker (marked or withdrawn this pass, or marked before), and calls
 * of started work queued longer than STARTED_HOLD_MS that wait only for their people's runners, none of which can claim now. Of the bound
 * calls only an item workflow's implementation calls with no taker; follow-ups are left out.
 */
export type StalledHook = (v: RemoteView, calls: readonly Cand[]) => Promise<void>;
