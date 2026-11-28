// Task Runner calls (the user-local mode): the caller queues a call and waits for its reply, a Task Runner claims it,
// heartbeats while it runs and submits the reply. The rows and their writers live in the runners module
// (src/data/runners); this file holds the rules: the claim order, eligibility, the lease routes' checks and the caller's poll.
import type { ItemRef } from "../../web/src/api/types.ts";
import { allocation, callQueue, ItemWithdrawnError, NoTakerError, stepOf, throwIfHalted, unitCalled, WaitLimitError } from "../agents/call.ts";
import { packPrompt } from "../agents/runs.ts";
import { scrubError } from "../agents/text.ts";
import type { Usage } from "../classify/run.ts";
import { HttpError } from "../dash/server/util.ts";
import type { Role } from "../dash/types.ts";
import { fillHarness, rootArgs, validRoot } from "../prompts/harness.ts";
import { rootAgents } from "../sandbox/agents.ts";
import { joinParts, TASK_BUDGET_CLAUDE, taskBudgetOf, withoutTaskBudget, withTaskBudget } from "../prompts/index.ts";
import { scrub } from "../runner/scrub.ts";
import { remoteToolRows } from "../agents/tools.ts";
import { loadFreshWrites, permKey } from "../data/access/index.ts";
import { setting } from "../data/control/index.ts";
import { CALL_WAIT_LIMIT } from "../data/jobs/index.ts";
import * as runners from "../data/runners/index.ts";
import { LEASE_IDLE_MS } from "../data/runners/index.ts";
import { ERROR_MAX } from "../data/inference/types.ts";
import type { ClaimFacts, LiveLease, PollRow, QueueSnapshot, RefusalRetry, RunnerSnapshot } from "../data/runners/index.ts";
import { familyOf, isEffort, isTier, meetsEffort, modelsOf, REMOTE_MODELS_KEY, TIERS } from "./mode.ts";
import { expectTranscript, storeCallTranscript, takeTranscript, transcriptAwaited, transcriptsOn } from "../transcripts/index.ts";
import { ACCEPTED_PROTOCOLS, CLAIM_ID_TTL_S, ROUTES, TRANSCRIPT_MAX, TRANSCRIPT_WAIT_S, type Claim, type ClaimReply, type Effort, type HarnessId, type Heartbeat, type Release, type Reserve, type Submit, type SubmitReply, type TaskBundle, type Tier } from "./protocol.ts";
import { claimReposOf } from "./my-repos.ts";
import { skipsIn, taskOfStep } from "./my-tasks.ts";
import { itemsFit, type ItemFilter } from "./task-items.ts";
import { INTERACTIVE_HELPER, interactive, slotsOf } from "./interactive-slots.ts";
import { holdMs, Ticket, type ClaimTry, type ClaimWaits, type EmptyReply } from "./claim-wait.ts";
import { scaled, scaledS } from "./time-scale.ts";
import { CALLER_STALE_MS, IDLE_FRESH_MS, SEEN_EVERY_MS } from "./room.ts";
import { serveChecks, endChecks } from "./check-relay.ts";
import { loadQueuedWorkspaces } from "../data/build/index.ts";
import { WorkspaceServer, type ToolSession } from "../build/workspace-relay.ts";
import { resumePrompt } from "../build/workspace-call.ts";
import { WORKSPACE_SERVER } from "../build/workspace-tools.ts";
import { NO_TAKER_SKIP, skipItem } from "../runner/leases.ts";
import { tierTaker } from "./takers.ts";
import { heldForOwner, startedOf, tierTokens, type StartedCalls } from "./started.ts";
import { orderedOf, releaseSkip, type Cand } from "./cands.ts";
import { pickCounts } from "./picks-rules.ts";
import { fastLaneFits, judges, roleFits, runnerTakes, sameLogin } from "./rules.ts";
import { itemFilterIn, settingsOf, type RemoteView } from "./view.ts";
import type { CheckTool } from "../checktool/index.ts";
import type { Db } from "../db/index.ts";

export { judges, roleFits, runnerTakes };
export type { Cand };

// The lease and caller limits live in the runners module, which applies them in SQL.
export { CALLER_GONE_MS, LEASE_IDLE_MS, LEASE_MARGIN_MS, QUEUE_CACHE_MS, REFUSED_PREFIX } from "../data/runners/index.ts";
/**
 * How long a follow-up turn waits for the helper that holds its session before the caller falls back to a fresh call, while
 * that login runs no live lease. While it does (the helper is busy, and its fast lane takes the turn as soon as it is free),
 * the turn waits up to STICKY_CAP_MS.
 */
export const STICKY_MS = LEASE_IDLE_MS;
export const STICKY_CAP_MS = scaled(15 * 60_000);
/** Seconds a helper waits before claiming again when nothing could be taken. */
export const CLAIM_RETRY_S = scaledS(15);
/** The oldest helper version that may run a lease. */
export const REQUIRED_HELPER = "1.2.0";
/** The oldest helper that may run a workspace call: earlier ones run the session with no tools, and bill it, when the MCP server fails to load (worker `claudeMcpProblem`). */
export const WORKSPACE_HELPER = "1.3.7";
/** Where interactive calls go (claimOrder): only to the interactive lane, to no claim (the claim's pipeline slots), or, for a helper older than INTERACTIVE_HELPER that has no such lane, to any claim. */
type InteractiveMode = "lane" | "off" | "legacy";
/** Where a claim's bound calls go (claimOrder). */
type BoundCalls = "only" | "with" | "without";
export { RELEASE_SKIP_MS } from "./cands.ts";
/**
 * The skip after a give-back for a local setup failure (Release.setup: a fetch, git or disk error on the helper): such a failure is
 * usually transient, and the releasing runner may be the only one allowed on the repo. At most the call's attempts give-backs get it.
 */
export const SETUP_RETRY_MS = scaled(60_000);
/**
 * A claim names the room left on its harness login before the login's refresh (Claim.maxTimeoutSeconds). Calls carry worst-case
 * timeouts far above their usual run time, so with at least this much room a longer call is leased anyway, with the lease's time
 * limit cut to the room; one that runs into the cut goes back to the queue without using an attempt (submitCall) and runs again
 * after the refresh. With less room a longer call is left for the refresh, and the runner shows when its login renews.
 */
export const LOGIN_CUT_MIN_MS = 20 * 60_000;
/**
 * What a Task Runner keeps back from the login room it claims with, beyond the call's timeout (the helper's LOGIN_CALL_SLACK_S and
 * LOGIN_PREPARE_S): the login renews this long after the room ends.
 */
const LOGIN_ROOM_SLACK_MS = 120_000;
/** A failure this close to a cut lease's time limit, or later, is the cut running out: the run is not the call's fault. */
const CUT_END_MARGIN_MS = 30_000;
/**
 * The most queue time the runner leaves out of a job's deadline and no-progress stop. Helpers run on people's own machines
 * across time zones, so a call may wait out a night with nobody online; past 12 hours the call is unlikely to be taken at all
 * (no eligible helper: the only maintainers authored the item), and the job is stopped so it no longer holds its item.
 */
export const REMOTE_WAIT_CAP_MS = 12 * 3600_000;
/** The start of the error of a call withdrawn because no Task Runner could take it (takers.ts sweepTakers). */
export const NO_TAKER_PREFIX = "no Task Runner can take calls";
const PROGRESS_MAX = 200;
const REPLY_MAX = 4_000_000;

export type NewCall = {
  promptId: string; promptVersion: string; tier: Tier; effort: string; askedModel: string;
  bundle: Omit<TaskBundle, "callId">; items: ItemRef[]; level: number; maxAttempts: number;
  /** A follow-up turn on the session of this call. */
  parentId?: number;
  /** The repo whose reference documentation the call's reference tools search (when its bundle lists REFERENCE_SERVER). */
  referenceRepo?: string;
  /** Only this user's own Task Runners take the call (a maintainer's conversation turn); a follow-up keeps its parent's. */
  forLogin?: string;
  /**
   * With forLogin: the call runs in one of that user's Task Runner slots and counts toward their Max calls at once, never in
   * the own lane (Claim.ownLane), which is for short turns; a follow-up keeps its parent's.
   */
  boundSlot?: boolean;
};

/**
 * Queues a call for the current job and step; a follow-up is offered only to the helper of the parent's lease holder. In a
 * resumed job (src/runner/resuming.ts) it adopts an equal call of the job's earlier run instead: the reply a Task Runner
 * sends, or sent during the restart, lands there.
 */
export async function enqueueCall(db: Db, c: NewCall, nowMs: number = Date.now()): Promise<number> {
  const s = stepOf(c.promptId), q = callQueue(c.promptId);
  const id = await runners.enqueueCall(db, { ...c, job: { jobId: s.jobId, step: s.step, stage: s.stage, cls: q.cls, repo: q.repo } }, nowMs);
  unitCalled();
  return id;
}

/** Ends a call that is in one of `states` as failed; true when it did. A leased call's agent run fails with it. */
export async function withdrawCall(db: Db, id: number, reason: string, states: ("queued" | "leased")[] = ["queued", "leased"], nowMs: number = Date.now()): Promise<boolean> {
  return (await runners.withdrawCalls(db, [{ id, reason }], { states, now: nowMs })).length > 0;
}

/**
 * Withdraws the open calls of a job that ended, or of every job (the runner restarted); calls made outside a job are left to
 * their caller, and calls of jobs waiting to resume stay for the resumed run to adopt.
 */
export async function withdrawJobCalls(db: Db, reason: string, jobId?: number): Promise<number> {
  return await runners.withdrawJobCalls(db, reason, jobId);
}

/**
 * The failure backoff of remote calls (registered in src/stages/registry.ts): a lease with no heartbeat for LEASE_IDLE_MS, a
 * lease still preparing too long after the claim, or one running past its time limit plus LEASE_MARGIN_MS goes back to the
 * queue (attempt + 1, up to the prompt's attempts); a call whose caller stopped polling fails. Leases end only while the
 * dashboard serves (liveness.ts). The lost lease counts toward its login's cool-off. Run by a claim's first try and by the
 * caller's poll for its calls (`id`); old rows go with pruneRemote.
 */
export async function expireLeases(db: Db, nowMs: number = Date.now(), id?: number): Promise<void> {
  await runners.expireLeases(db, { now: nowMs, ...(id !== undefined && { ids: [id] }) });
}

/** Deletes ended calls, finished check relays, lease tombstones, drops and cool-offs that no longer count, and the last status of deleted tokens. The dashboard runs it once a minute. */
export async function pruneRemote(db: Db, nowMs: number = Date.now()): Promise<void> {
  await runners.pruneRemote(db, nowMs);
}

/**
 * The call a lease secret belongs to while its lease is live (a lost lease is ended first), or null. For the per-lease
 * routes: bundle, heartbeat, submit, the task MCP servers and the tarball. The lease lives only while the Task Runner
 * credential that claimed it lives and its login is still a maintainer or operator.
 */
export async function liveLease(db: Db, secret: string | undefined, nowMs: number = Date.now()): Promise<LiveLease | null> {
  return secret ? await runners.loadLiveLease(db, secret, nowMs) : null;
}

/**
 * The call a lease secret was issued for, whether its lease is live or has ended (the tombstones), or null for a secret never
 * issued. The lease routes answer 410 for an ended lease and 401 only for null.
 */
export async function leaseState(db: Db, secret: string | undefined): Promise<{ id: number; live: boolean } | null> {
  return secret ? await runners.loadLeaseState(db, secret) : null;
}

// ---- claims ------------------------------------------------------------------------

export type Caller = { tokenId: number; login: string; role: Role };

/**
 * Whether a login other than the caller could take a call now: its helper's last claim found nothing within IDLE_FRESH_MS,
 * the login is not Manual only, that claim covered the call's tier and repos, the login fits the role rules, a write
 * permission of it on every repo is cached and fresh (an author gives way only to someone known to be able to take the call),
 * and it authored no item of the call. Over the runner snapshot; the permissions are read the first time they matter.
 */
function idleOthers(db: Db, v: RemoteView, login: string): (c: Cand) => Promise<boolean> {
  const s = v.snapshot, self = login.toLowerCase();
  const idle = s.runners.filter((r) => r.role !== null && r.idleClaimAt !== null && r.idleClaimAt >= v.now - IDLE_FRESH_MS && r.login.toLowerCase() !== self && !settingsOf(s, r.login).manualOnly)
    .map((r) => ({ login: r.login.toLowerCase(), role: r.role!, tiers: new Set<string>(r.idleTiers ?? []), only: r.idleRepos ? new Set(r.idleRepos) : null, skip: skipsIn(settingsOf(s, r.login).skipTasks), items: itemFilterIn(s, r.login) }));
  let writes: Promise<ReadonlySet<string>> | null = null;
  return async (c) => {
    const others = idle.filter((o) => o.tiers.has(c.tier) && !c.authors.has(o.login) && itemsFit(o.items, c));
    if (!others.length) return false;
    const writable = await (writes ??= loadFreshWrites(db, [...new Set(idle.map((o) => o.login))], v.now));
    return others.some((o) => runnerTakes({ login: o.login, role: o.role, repos: o.only, skip: o.skip }, c, (who, repo) => writable.has(permKey(who, repo))));
  };
}

/**
 * Who may take a call: a maintainer or operator with write permission on every repo of the call (which covers reading a
 * private one); discord.* calls and calls that name no repo go to operators only. An author or co-author of an item a judging
 * prompt judges is passed over only while another helper that could take the call is asking for work (idleOthers). A call
 * bound to a user (NewCall.forLogin) goes to that user alone, author or not; an item workflow's bound work (takeableBound) also to
 * a person who took it, as claimOrder offers it and the lease checks it (boundTakeAllows).
 */
async function mayTake(caller: Caller, c: Cand, canWrite: (repo: string) => Promise<boolean>, othersIdle: (c: Cand) => Promise<boolean>): Promise<boolean> {
  if (c.forLogin !== null && !sameLogin(c.forLogin, caller.login) && !runners.takeableBound(c.prompt_id)) return false;
  if (!roleFits(caller.role, c)) return false;
  for (const repo of c.repos) if (!(await canWrite(repo))) return false;
  // A call bound to the caller is theirs whatever they authored: nobody else may take it.
  return c.forLogin !== null || !(judges(c.prompt_id) && c.authors.has(caller.login.toLowerCase()) && await othersIdle(c));
}

const HARNESSES: HarnessId[] = ["claude", "codex"];
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** The claim body, checked; throws HttpError 400 for a malformed one and 409 for a protocol version outside ACCEPTED_PROTOCOLS. */
export function parseClaim(raw: unknown): Claim {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a Claim object");
  const c = raw as Record<string, unknown>;
  if (typeof c.protocol !== "number" || !ACCEPTED_PROTOCOLS.includes(c.protocol)) throw new HttpError(409, `this server speaks protocol ${ACCEPTED_PROTOCOLS.join(" or ")}; update the helper`);
  const protocol = c.protocol;
  if (!HARNESSES.includes(c.harness as HarnessId)) throw new HttpError(400, `harness must be one of ${HARNESSES.join(", ")}`);
  if (!short(c.helperVersion, 40) || !short(c.harnessVersion, 80)) throw new HttpError(400, "helperVersion and harnessVersion must be short strings");
  if (!c.tiers || typeof c.tiers !== "object" || Array.isArray(c.tiers)) throw new HttpError(400, "tiers must map a tier to a model");
  const tiers: Claim["tiers"] = {};
  for (const [t, m] of Object.entries(c.tiers as Record<string, unknown>)) {
    if (!isTier(t) || !short(m, 100)) throw new HttpError(400, `tier ${t}: a known tier with a model name`);
    tiers[t] = m;
  }
  let efforts: Claim["efforts"];
  if (c.efforts !== undefined) {
    if (!c.efforts || typeof c.efforts !== "object" || Array.isArray(c.efforts) || !Object.entries(c.efforts).every(([t, e]) => isTier(t) && isEffort(e))) throw new HttpError(400, "efforts must map a tier to an effort of the ladder low, medium, high, xhigh, max");
    efforts = c.efforts as Claim["efforts"];
  }
  if (c.repos !== undefined && (!Array.isArray(c.repos) || c.repos.length > 500 || !c.repos.every((x) => short(x, 100)))) throw new HttpError(400, "repos must be a list of repo names");
  if (c.sessions !== undefined && (!Array.isArray(c.sessions) || c.sessions.length > 500 || !c.sessions.every((x) => Number.isInteger(x)))) throw new HttpError(400, "sessions must be a list of call ids");
  if (c.root !== undefined && (typeof c.root !== "string" || !validRoot(c.root))) throw new HttpError(400, "root must be an absolute path of plain characters (letters, digits, . _ + @ -) without . or .. components");
  if (typeof c.requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(c.requestId)) throw new HttpError(400, "requestId must be 8 to 64 letters, digits, - or _");
  if (c.fastLane !== undefined && typeof c.fastLane !== "boolean") throw new HttpError(400, "fastLane must be a boolean");
  if (c.ownLane !== undefined && typeof c.ownLane !== "boolean") throw new HttpError(400, "ownLane must be a boolean");
  if (c.interactiveLane !== undefined && typeof c.interactiveLane !== "boolean") throw new HttpError(400, "interactiveLane must be a boolean");
  if (c.interactiveLane === true && (c.fastLane === true || c.ownLane === true || c.withOwnLane === true)) throw new HttpError(400, "interactiveLane excludes the other lanes");
  if (c.withOwnLane !== undefined && typeof c.withOwnLane !== "boolean") throw new HttpError(400, "withOwnLane must be a boolean");
  if (c.maxTimeoutSeconds !== undefined && (!Number.isInteger(c.maxTimeoutSeconds) || (c.maxTimeoutSeconds as number) < 1)) throw new HttpError(400, "maxTimeoutSeconds must be whole seconds, at least 1");
  // Protocol 3 helpers know no wait; a field they might send is not read.
  const wait = protocol >= 4 ? c.wait : undefined;
  if (wait !== undefined && (!Number.isInteger(wait) || (wait as number) < 0 || (wait as number) > 30)) throw new HttpError(400, "wait must be whole seconds from 0 to 30");
  return { requestId: c.requestId, ...(c.fastLane === true && { fastLane: true }), ...(c.ownLane === true && { ownLane: true }), ...(c.withOwnLane === true && { withOwnLane: true }), ...(c.interactiveLane === true && { interactiveLane: true }), ...(wait !== undefined && { wait: wait as number }), protocol, helperVersion: c.helperVersion, harness: c.harness as HarnessId, harnessVersion: c.harnessVersion, tiers, ...(efforts && { efforts }), ...(c.repos !== undefined && { repos: c.repos as string[] }), ...(c.sessions !== undefined && { sessions: c.sessions as number[] }), ...(c.root !== undefined && { root: c.root as string }), ...(c.maxTimeoutSeconds !== undefined && { maxTimeoutSeconds: c.maxTimeoutSeconds as number }) };
}

/** Whether dotted version `v` is older than `min` (numeric parts compared in order; a part that is not a number counts as 0). */
export function olderVersion(v: string, min: string): boolean {
  const a = v.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0), b = min.split(".").map((x) => Number(x));
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) < b[i]!;
  return false;
}

/** One line for the lease: the prompt and its first item. */
function titleOf(promptId: string, refs: ItemRef[]): string {
  if (!refs.length) return promptId;
  return `${promptId} on ${refs[0]!.repo}#${refs[0]!.number}${refs.length > 1 ? ` (+${refs.length - 1})` : ""}`;
}

/**
 * The calls the login's helpers hold leases on, all helpers together, that count toward its Max calls at once (a call its own
 * lane runs does not), as the runner snapshot counts them: at most 2 s old, and fresh after a lease of this process.
 */
export const leasedIn = (s: RunnerSnapshot, login: string): number => s.leasedByLogin.get(login.toLowerCase())?.leased ?? 0;
export const leasedBy = async (db: Db, login: string): Promise<number> => leasedIn(await runners.loadRunnerSnapshot(db, Date.now()), login);

/**
 * The login's leases as one value that changes whenever one of its helpers takes or ends a call: their count and the newest
 * lease time (a turnover that keeps the count brings a newer lease).
 */
export const leaseTurnover = async (db: Db, login: string): Promise<string> => (await runners.loadLeaseTurnover(db, [login])).get(login.toLowerCase()) ?? "0:";

/** Whether the queued call is for work the caller started or approved (started.ts): never a call bound to a user. */
const startedBy = (s: StartedCalls, r: Cand, login: string): boolean => r.forLogin === null && s.owners(r.refs, r.step, r.tier, r.repos).has(login.toLowerCase());

/** What the claim order reads of the caller: Manual only, skipped tasks, item filter; whose calls are whose; whose picks count. */
type OrderReads = { manual: boolean; skip: ReadonlySet<string>; items: ItemFilter; started: StartedCalls; pickers: ReadonlySet<string> };
const orderReadsOf = (v: RemoteView, login: string): OrderReads => {
  const set = settingsOf(v.snapshot, login);
  return { manual: set.manualOnly, skip: skipsIn(set.skipTasks), items: itemFilterIn(v.snapshot, login), started: startedOf(v), pickers: runners.pickerLoginsOf(v.snapshot, v.now) };
};

/**
 * The queued calls a claim could take in the order it takes them, before eligibility: follow-up turns of the sessions its
 * helper holds first, then calls for work the user started or approved (started.ts) in queue order, then the user's own live
 * picks (picks.ts) oldest first, then the model queue's order without other users' live picks or the started calls of other
 * users who can take them, filtered by tiers and repos (every repo a call names must be in the set; picks do not go by it);
 * the queue's order also by the user's tasks (my-tasks.ts) and items (task-items.ts), which picks, started calls and
 * follow-ups do not go by. Calls bound to the caller (NewCall.forLogin) come after its follow-ups, like picks; then calls bound to
 * another user for an item workflow's work the caller took while that user's runners cannot run them (started.ts boundTakers);
 * other calls bound to another user are not offered. `bound` says where the caller's bound calls and their follow-ups go: an own-lane claim
 * (Claim.ownLane) gets only them ("only"), the slots of a Task Runner that has an own lane (Claim.withOwnLane) none of them
 * ("without"), and other Task Runners' slots take them with the rest ("with"). Bound calls that run in a slot
 * (NewCall.boundSlot) and their follow-ups go with the slots' calls. A fast-lane claim gets only what fastLaneFits. A Manual
 * only user gets no calls from the queue's order. The ids of the caller's picks of calls it released or whose role rules it
 * no longer fits go to `unpick`. Pure.
 */
function claimOrder(q: ReturnType<typeof orderedOf>, reads: OrderReads, caller: Caller, tiers: ReadonlySet<Tier>, repos: ReadonlySet<string> | null, sessionIds: readonly number[], nowMs: number, o: { fastLane?: boolean; bound?: BoundCalls; lane?: InteractiveMode; unpick?: number[] } = {}): Cand[] {
  const all = claimOrderAll(q, reads, caller, tiers, repos, sessionIds, nowMs, o.fastLane ?? false, o.bound ?? "with", o.unpick ?? []);
  const lane = o.lane ?? "off";
  return lane === "legacy" ? all : all.filter((r) => interactive(r) === (lane === "lane"));
}

function claimOrderAll(q: ReturnType<typeof orderedOf>, reads: OrderReads, caller: Caller, tiers: ReadonlySet<Tier>, repos: ReadonlySet<string> | null, sessionIds: readonly number[], nowMs: number, fastLane: boolean, bound: BoundCalls, unpick: number[]): Cand[] {
  const { manual, skip, items, started, pickers } = reads;
  const login = caller.login.toLowerCase();
  const live = (r: Cand): boolean => r.seen_at >= nowMs - CALLER_STALE_MS;
  const released = (r: Cand): boolean => r.refusedToken === caller.tokenId || releaseSkip(r, nowMs)?.login === login;
  const fits = (r: Cand): boolean => live(r) && !released(r) && tiers.has(r.tier) && (!repos || r.repos.every((x) => repos.has(x)));
  const fast = (r: Cand): boolean => !fastLane || fastLaneFits(r);
  const sessions = new Set(sessionIds);
  // A follow-up goes with the session that holds its parent, by no repo choice: the parent already passed the caller's rules
  // (a started item's call bypasses My repos, and its fix turn must too).
  const allFollowUps = q.followUps.filter((r) => sessions.has(r.parent_id!) && sameLogin(r.sticky_login, caller.login) && live(r) && !released(r) && tiers.has(r.tier));
  // Calls bound to the caller (a maintainer's own conversation turn) next, oldest first: like picks, they go by no repo, task or item choice.
  const own = q.ordered.filter((r) => r.forLogin === login && live(r) && !released(r) && tiers.has(r.tier) && fast(r));
  if (bound === "only") return [...allFollowUps.filter((r) => r.forLogin === login && !r.boundSlot), ...own.filter((r) => !r.boundSlot)];
  const followUps = bound === "without" ? allFollowUps.filter((r) => r.forLogin === null || r.boundSlot) : allFollowUps;
  const ownHere = bound === "with" ? own : own.filter((r) => r.boundSlot);
  // Bound work of a workflow the caller took, in the same lanes as the caller's own bound calls.
  const took = q.ordered.filter((r) => r.forLogin !== null && r.forLogin !== login && (bound === "with" || r.boundSlot) && live(r) && !released(r) && tiers.has(r.tier) && fast(r)
    && started.boundTakers({ prompt_id: r.prompt_id, refs: r.refs, forLogin: r.forLogin, tier: r.tier, refusedToken: r.refusedToken }).has(login));
  // The caller's own picks count for it; other pickers' while they can take them.
  const counts = (r: Cand): boolean => pickCounts(r, nowMs, (who) => who === login || pickers.has(who));
  // Calls for work the caller started or approved come next, in queue order (started.ts): like picks, they go by no repo, task,
  // item choice or Manual only, and count toward the caller's Max calls at once like any call in a slot.
  const startedHere = q.ordered.filter((r) => startedBy(started, r, login) && live(r) && !released(r) && tiers.has(r.tier) && !(r.pickedBy !== null && r.pickedBy !== login && counts(r)) && fast(r));
  const mine: Cand[] = [];
  for (const r of q.ordered) {
    if (r.forLogin !== null || r.pickedBy !== login || startedBy(started, r, login) || !counts(r)) continue;
    if (released(r) || !roleFits(caller.role, r)) unpick.push(r.id);
    else if (live(r) && tiers.has(r.tier) && fast(r)) mine.push(r);
  }
  mine.sort((a, b) => a.pickedAt! - b.pickedAt! || a.id - b.id);
  if (manual) return [...followUps, ...ownHere, ...took, ...startedHere, ...mine];
  // The queue's order leaves out the caller's started calls (above) and other users' while one of theirs can take them.
  const held = (r: Cand): boolean => startedBy(started, r, login) || heldForOwner(started, r, login, nowMs);
  return [...followUps, ...ownHere, ...took, ...startedHere, ...mine, ...q.ordered.filter((r) => r.forLogin === null && fits(r) && !held(r) && !skip.has(taskOfStep(r.step)) && itemsFit(items, r) && !(r.pickedBy !== null && counts(r)) && fast(r))];
}

/** The logins (lowercase) whose picks count now. */
export async function pickerLogins(db: Db, nowMs: number): Promise<Set<string>> {
  return runners.pickerLoginsOf(await runners.loadRunnerSnapshot(db, nowMs), nowMs);
}

/** Ends a queued call's pick (only `login`'s, when given); true when one ended. */
export async function clearPick(db: Db, id: number, login?: string): Promise<boolean> {
  return await runners.clearPicks(db, [id], login) === 1;
}

/** Memoises the caller's write permission per repo; a failed lookup counts as no permission. */
const memoWrite = (canWrite: (repo: string) => Promise<boolean>): ((repo: string) => Promise<boolean>) => {
  const memo = new Map<string, Promise<boolean>>();
  return (repo) => {
    let p = memo.get(repo);
    if (!p) memo.set(repo, (p = canWrite(repo).catch(() => false)));
    return p;
  };
};

/** What a claim decides on (runners.loadClaim) with the accepted models, in one wave. */
async function claimReads(db: Db, caller: Caller, nowMs: number, requestId?: string): Promise<{ facts: ClaimFacts; queue: QueueSnapshot; snapshot: RunnerSnapshot; accepted: Record<Tier, string[]>; floors: Partial<Record<Tier, Effort>> }> {
  const [claim, models] = await db.together(() => Promise.all([runners.loadClaim(db, caller, { now: nowMs, ...(requestId !== undefined && { requestId }) }), setting(db, REMOTE_MODELS_KEY)]));
  return { ...claim, ...modelsOf(models) };
}

/** The queue in order and the view of the runners, of one claim's reads. */
const claimView = (x: Awaited<ReturnType<typeof claimReads>>, nowMs: number): { q: ReturnType<typeof orderedOf>; view: RemoteView } =>
  ({ q: orderedOf(x.queue, nowMs), view: { now: nowMs, snapshot: x.snapshot, accepted: x.accepted } });

/** The tiers a claim's models serve: of an accepted family and at the minimum effort. */
const claimTiers = (claim: Pick<Claim, "tiers" | "efforts" | "harness">, accepted: Record<Tier, string[]>, floors: Partial<Record<Tier, Effort>>): Set<Tier> =>
  new Set((Object.keys(claim.tiers) as Tier[]).filter((t) => familyOf(claim.tiers[t]!, accepted[t]) !== null && meetsEffort(claim.efforts?.[t], floors[t], claim.harness)));

/** How many queued calls the caller could claim now (same filters and eligibility as claimCall, nothing is leased), for a session's next_task. Follow-ups of a helper's own sessions are not counted. */
export async function claimableCalls(db: Db, caller: Caller, opts: { tiers?: readonly Tier[]; models?: Partial<Record<Tier, string>> }, canWrite: (repo: string) => Promise<boolean>, nowMs: number = Date.now()): Promise<number> {
  await expireLeases(db, nowMs);
  const x = await claimReads(db, caller, nowMs);
  const set = x.facts.settings;
  if (x.facts.cooled !== null) return 0;
  if (set.maxCalls !== null && x.facts.leased >= set.maxCalls) return 0;
  // A tier counts when the model the helper would use for it is of an accepted family; without a model, when the tier accepts any.
  const tiers = new Set((opts.tiers ?? TIERS).filter((t) => x.accepted[t].length > 0 && (opts.models?.[t] === undefined || familyOf(opts.models[t]!, x.accepted[t]) !== null)));
  const w = claimView(x, nowMs);
  const can = memoWrite(canWrite), others = idleOthers(db, w.view, caller.login);
  let n = 0;
  for (const r of claimOrder(w.q, orderReadsOf(w.view, caller.login), caller, tiers, claimReposOf(set.repos, undefined), [], nowMs)) if (await mayTake(caller, r, can, others)) n++;
  return n;
}

/** The state of a call this login holds or held (by its lease id); null for an unknown call and for another login's. */
export async function callStatus(db: Db, id: number, login: string): Promise<{ id: number; state: runners.CallState; error: string | null; title: string } | null> {
  const r = (await runners.loadCalls(db, [id])).get(id);
  if (!r || !sameLogin(r.userLogin, login)) return null;
  return { id: r.id, state: r.state, error: r.error, title: titleOf(r.promptId, r.items) };
}

/**
 * Claim replies by agent token and request id, for CLAIM_ID_TTL_S: a repeated claim (its reply was lost) gets the same reply,
 * the same lease with the same secret included. Kept in the memory of the dashboard process, the only one that serves
 * claims, so the secret is never stored; the promise is kept from the start, so a repeat that arrives while the first is
 * still being answered waits for it.
 */
const claimReplies = new Map<string, { at: number; reply: Promise<ClaimReply>; ticket?: Ticket }>();

/**
 * Gives the caller the first queued call it may take (claimOrder), filtered by eligibility. `canWrite` reads the caller's live
 * write permission on a repo. The reply carries the user's reserve either way. A claim repeated with the same request id
 * gets the first one's reply. While the login's leases are at the user's "Max calls at once" (max-calls.ts), only a follow-up
 * of its own sessions is leased, one past the limit at most, so a session can finish; otherwise the reply says why.
 * With `hold`, a protocol 4 claim that finds nothing and has no reason to give waits for a call up to its `wait` (claim-wait.ts).
 */
export function claimCall(db: Db, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number = Date.now(), hold?: Hold, o: ClaimOptions = {}): Promise<ClaimReply> {
  void o;
  // Entries are in claim order, so the expired ones come first.
  for (const [k, v] of claimReplies) { if (v.at >= nowMs - scaled(CLAIM_ID_TTL_S * 1000)) break; claimReplies.delete(k); }
  const key = `${caller.tokenId}:${claim.requestId}`;
  const seen = claimReplies.get(key);
  if (seen) {
    if (hold) seen.ticket?.attach(hold.signal);
    return seen.reply;
  }
  // Protocol 3 helpers send no wait (parseClaim); their claims are answered at once.
  const ms = hold && claim.protocol >= 4 ? holdMs(claim.wait) : 0;
  const ticket = hold && ms > 0 ? new Ticket(hold.signal) : undefined;
  // An own-lane claim's reply says the lane was honoured: a server without it ignores the field and would offer any call.
  const reply = claimNew(db, caller, claim, canWrite, nowMs, hold && ticket ? { ...hold, ms, ticket } : undefined).then((r): ClaimReply => (claim.ownLane && !claim.interactiveLane ? { ...r, ownLane: true } : r));
  claimReplies.set(key, { at: nowMs, reply, ticket });
  reply.catch(() => { if (claimReplies.get(key)?.reply === reply) claimReplies.delete(key); });
  // Every request for a held claim left before its reply: a retry with the same id claims afresh. A lease already given stays
  // remembered, so the retry gets it.
  if (ticket) ticket.onGone = () => void reply.then((r) => { if (!r.lease && claimReplies.get(key)?.reply === reply) claimReplies.delete(key); }, () => {});
  return reply;
}

/**
 * How a claim may wait (claim-wait.ts): `signal` aborts when the request's connection closes before its reply; `blocked` says
 * the claim has a reason to give outside its tries (a write permission GitHub could not confirm), so it is answered at once.
 * `waits.closed` (shutting down) answers at once too.
 */
export type Hold = { waits: ClaimWaits; signal: AbortSignal; blocked: () => boolean };

/** `userLocalOnly`: the claim route's flag from when Claude calls could also run on this host; every call is a Task Runner call, so it changes nothing. */
export type ClaimOptions = { userLocalOnly?: boolean };

async function claimNew(db: Db, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number, hold: (Hold & { ms: number; ticket: Ticket }) | undefined): Promise<ClaimReply> {
  const c = await prepareClaim(db, caller, claim, canWrite, nowMs);
  if ("reply" in c) return c.reply;
  const live = hold ? () => !hold.ticket.gone && !hold.waits.closed : () => true;
  const answer = async (r: ClaimReply): Promise<ClaimReply> => (claim.interactiveLane ? { ...r, interactiveSlots: c.slots() } : r);
  const first = await c.attempt(nowMs, { quick: false, live });
  if (first) return await answer(first);
  await c.idle(nowMs);
  if (!hold || hold.waits.closed || hold.ticket.gone || hold.blocked()) return await answer(await c.empty(nowMs, false));
  return await answer(await hold.waits.hold(hold.ticket, nowMs + hold.ms, { ...c, blocked: hold.blocked }));
}


/**
 * The once-per-claim part of a claim: the helper's version, and a lease of a repeated claim the dashboard no longer remembers.
 * Returns a reply when the claim is answered here, else its tries. A full try reads one wave (claimReads: role, cool-off,
 * settings, lease counts, and the queue and the runner snapshot where they are not cached), orders the queue in memory, and leases the first eligible call in one short transaction (runners.leaseCall); it gives null when there is
 * nothing to take and no reason to give.
 */
async function prepareClaim(db: Db, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number):
  Promise<{ reply: ClaimReply } | { attempt: ClaimTry; idle: (nowMs: number) => Promise<void>; empty: (nowMs: number, held: boolean) => Promise<EmptyReply>; slots: () => number }> {
  if (olderVersion(claim.helperVersion, REQUIRED_HELPER)) throw new HttpError(409, `helper ${claim.helperVersion} is older than ${REQUIRED_HELPER}, the oldest this server accepts; download the current helper from ${ROUTES.helper}`);
  // The first try's wave carries the repeat's orphan lease and the expiry's lost and gone calls. A repeat the dashboard no
  // longer remembers (it restarted in between): the lease the first claim took cannot be given out again, as only its secret's
  // hash is stored, so it goes back to the queue unused and this claim is answered afresh.
  let pending: Awaited<ReturnType<typeof claimReads>> | null = await claimReads(db, caller, nowMs, claim.requestId);
  const { orphan } = pending.facts;
  if (orphan) {
    await runners.returnOrphanLease(db, orphan, nowMs);
    await runners.expireLeases(db, { now: nowMs });
    pending = null;
  } else if (pending.facts.lost.length || pending.facts.gone.length) {
    await runners.expireLeases(db, { now: nowMs, facts: pending.facts });
    pending = null;
  }
  const fast = claim.fastLane === true, own = claim.ownLane === true, lane = claim.interactiveLane === true;
  const mode: InteractiveMode = lane ? "lane" : olderVersion(claim.helperVersion, INTERACTIVE_HELPER) ? "legacy" : "off";
  const bound: BoundCalls = own ? "only" : claim.withOwnLane === true ? "without" : "with";
  const login = caller.login.toLowerCase();
  // What the latest full try took, for a quick try's look at the queue.
  let tiers = new Set<Tier>(), repos: ReadonlySet<string> | null = null, accepted: Record<Tier, string[]> | null = null;
  // The user's settings as the latest full try read them, and when.
  let last: { at: number; reserve: Reserve; slots: number } | null = null;
  // Calls the latest try could have taken but for their time limit (Claim.maxTimeoutSeconds): the claim then counts as no
  // idle helper's, so other runners do not pass over those calls for it, and its empty reply says why.
  let tooLong = 0;
  // Workspace calls the latest try left because the helper is older than WORKSPACE_HELPER; they stay queued for other runners.
  let oldHelper = 0;
  const attempt: ClaimTry = async (now, { quick, live }) => {
    // A quick try with nothing to take changes nothing; the full tries, at least every RETRY_MS, check the credential as well.
    if (quick && accepted) {
      const [queue, snapshot] = await db.together(() => Promise.all([runners.loadQueue(db, now), runners.loadRunnerSnapshot(db, now)]));
      const v: RemoteView = { now, snapshot, accepted };
      if (!claimOrder(orderedOf(queue, now), orderReadsOf(v, login), caller, tiers, repos, claim.sessions ?? [], now, { fastLane: fast, bound, lane: mode }).length) return null;
    }
    tooLong = 0;
    oldHelper = 0;
    const x = (now === nowMs && pending) || await claimReads(db, caller, now);
    pending = null;
    const f = x.facts, set = f.settings;
    const slots = lane ? slotsOf(set.interactiveSlots, caller.role) : 0;
    last = { at: now, reserve: set.reserve, slots };
    // A held claim outlives the route's credential check: a credential removed, expired or demoted meanwhile ends the hold untaken.
    if (f.role !== caller.role) return { lease: null, retryAfter: CLAIM_RETRY_S, reason: "this Task Runner credential was removed or its user's role changed", reserve: set.reserve };
    accepted = x.accepted;
    const w = claimView(x, now);
    const reads = orderReadsOf(w.view, login);
    const cooled = f.cooled;
    // A cool-off holds back every call but those for work the user started or approved (started.ts), which a slot or the fast
    // lane still takes while one is queued; the claim is then asked again soon instead of at the cool-off's end.
    const coolStarted = cooled !== null && !own && !lane && w.q.all.some((r) => r.seen_at >= now - CALLER_STALE_MS && startedBy(reads.started, r, login));
    const coolReply = (c: NonNullable<typeof cooled>): ClaimReply => {
      const left = Math.ceil((c.until - now) / 1000);
      return { lease: null, retryAfter: coolStarted ? Math.min(CLAIM_RETRY_S, left) : left, reason: c.reason, until: c.until, reserve: set.reserve };
    };
    if (cooled && !coolStarted) return coolReply(cooled);
    tiers = claimTiers(claim, x.accepted, x.floors);
    if (!tiers.size && cooled) return coolReply(cooled);
    if (!tiers.size) throw new HttpError(400, `no tier of the claim has an accepted model at the minimum effort; accepted: ${(Object.keys(x.accepted) as Tier[]).map((t) => `${t} ${x.accepted[t].join("/")}${x.floors[t] ? ` at effort ${x.floors[t]} or higher` : ""}`).join(", ")}`);
    const can = memoWrite(canWrite), others = idleOthers(db, w.view, caller.login);
    repos = claimReposOf(set.repos, claim.repos);
    const max = set.maxCalls;
    // An interactive-lane claim is bounded by the user's Interactive slots alone; Max calls at once and the pipeline slots do not apply to it.
    if (lane && !slots) return { lease: null, retryAfter: CLAIM_RETRY_S, reason: "your Interactive slots are 0 (Connect page, My settings)", reserve: set.reserve };
    const full = !lane && max !== null && f.leased >= max;
    let limited = full && !own;
    // The caller's picks of calls it may no longer take end: they would hold the calls from every other user.
    const unpick: number[] = [];
    const order = claimOrder(w.q, reads, caller, tiers, repos, claim.sessions ?? [], now, { fastLane: fast, bound, lane: mode, unpick });
    const lease = async (): Promise<ClaimReply | null | undefined> => {
      for (const r of order) {
        const started = startedBy(reads.started, r, login);
        // A call bound to another person reaches here only as their workflow's work the caller took (claimOrder).
        const took = r.forLogin !== null && !sameLogin(r.forLogin, login);
        if (cooled && !started) continue;
        // Only follow-ups of the helper's own sessions carry a parent here (claimOrder). The own lane's calls count toward no
        // calls at once: it takes them at the limit too, with no limit of its own. An older helper runs them in a slot, as any call.
        if (full && r.parent_id === null && !own) continue;
        if (!(await mayTake(caller, r, can, others))) {
          if (r.pickedBy === login) unpick.push(r.id);
          continue;
        }
        // The room counts from the claim's arrival: the time it was held is gone from the helper's login too.
        const room = claim.maxTimeoutSeconds === undefined ? null : claim.maxTimeoutSeconds * 1000 - (now - nowMs);
        const cut = room !== null && r.timeoutMs > room;
        if (cut && room < LOGIN_CUT_MIN_MS) { tooLong++; continue; }
        const got = await leaseOne(db, caller, claim, r, cut ? Math.floor(room / 1000) * 1000 : null, {
          perLogin: lane || max === null || own ? null : r.parent_id !== null ? max + 1 : max, interactive: lane ? slots : null,
        }, started, started || took ? tierTokens(w.view, r.tier) : null, !fast && !own && !lane && f.idle, live);
        // The client left, or shutdown answered the claim: nothing is leased to nobody.
        if (got === "gone") return null;
        if (got === "old") { oldHelper++; continue; }
        if (got === "limit") {
          limited = true;
          continue;
        }
        if (!got) continue;
        // A lease with the room again ends the wait for the login's renewal that an earlier claim recorded.
        if ((room === null || room >= LOGIN_CUT_MIN_MS) && w.view.snapshot.runners.some((h) => h.tokenId === caller.tokenId && h.loginRenewsAt != null)) await runners.markLoginRenewal(db, caller.tokenId, null);
        return { lease: got, reserve: set.reserve };
      }
      return undefined;
    };
    const got = await lease();
    if (unpick.length) await runners.clearPicks(db, [...new Set(unpick)]);
    if (got !== undefined) return got;
    if (cooled) return coolReply(cooled);
    if (limited && lane) return { lease: null, retryAfter: CLAIM_RETRY_S, reason: `your helpers hold ${slots} interactive calls, your Interactive slots (Connect page, My settings)`, reserve: set.reserve };
    if (limited) return { lease: null, retryAfter: CLAIM_RETRY_S, reason: `your helpers run ${max} calls, your limit of calls at once (Connect page, My settings)`, reserve: set.reserve };
    return null;
  };
  return {
    attempt,
    // An idle helper, with what it takes (the user's picks narrowed by the helper's list): an author's claim gives way to it
    // (idleOthers). The fast lane and the own lane say nothing about the helper's other slots.
    // A claim that left calls for want of login room says when the login renews (the wait lines of the items, src/workflow/waits.ts).
    idle: async (now) => {
      if (tooLong) await runners.markLoginRenewal(db, caller.tokenId, nowMs + claim.maxTimeoutSeconds! * 1000 + LOGIN_ROOM_SLACK_MS);
      else if (!fast && !own && !oldHelper) await runners.markHelperIdle(db, caller, { now, tiers: [...tiers], repos: repos ? [...repos] : null });
    },
    empty: async (now, held) => ({ lease: null, retryAfter: held ? scaledS(1) : CLAIM_RETRY_S, reserve: last?.at === now ? last.reserve : settingsOf(await runners.loadRunnerSnapshot(db, now), login).reserve,
      ...(!tooLong && oldHelper && { reason: `${oldHelper} queued workspace call${oldHelper === 1 ? "" : "s"} need a helper of ${WORKSPACE_HELPER} or newer, this one is ${claim.helperVersion}: update the Task Runner` }),
      ...(tooLong && { reason: `${tooLong} queued call${tooLong === 1 ? " needs" : "s need"} more time than the ${Math.max(0, Math.floor((claim.maxTimeoutSeconds! * 1000 - (now - nowMs)) / 60_000))} min this Task Runner's harness login has before its refresh` }) }),
    slots: () => last?.slots ?? 0,
  };
}

/**
 * Leases call `r` to the caller (runners.leaseCall: one transaction under the login's lease lock, every condition in its
 * compare-and-set). The run's stored prompt is built before: scrubbing and compressing a large prompt takes milliseconds. A
 * call whose bundle lists the workspace server goes only to the claude harness, with the resume note of its workspace. `started`: work
 * the caller started, approved or took (started.ts); `tiered`: for that work or a call bound to another person, the credentials that
 * serve its tier (started.ts tierTokens); null for other work.
 */
async function leaseOne(db: Db, caller: Caller, claim: Claim, r: Cand, timeoutMs: number | null, caps: { perLogin: number | null; interactive: number | null }, started: boolean, tiered: readonly number[] | null, clearIdle: boolean, live: () => boolean): Promise<Extract<ClaimReply, { lease: object }>["lease"] | "limit" | "gone" | "old" | null> {
  const source = await runners.loadLeaseSource(db, r.id);
  if (!source) return null;
  const bundle = JSON.parse(source.bundle) as Omit<TaskBundle, "callId">;
  // A workspace session runs only in Claude Code with its own tools off; another harness would keep a shell of its own.
  const workspace = bundle.mcpServers.includes(WORKSPACE_SERVER);
  if (workspace && claim.harness !== "claude") return null;
  if (workspace && olderVersion(claim.helperVersion, WORKSPACE_HELPER)) return "old";
  // Its prompt tells a session after a lost lease that the workspace keeps the earlier session's work; stored with the lease.
  const base = source.baseStdin ?? bundle.stdin;
  const stdin = workspace ? await resumePrompt(db, r.id, base) : bundle.stdin;
  const rewritten = stdin !== bundle.stdin;
  bundle.stdin = stdin;
  const prompt = packPrompt(joinParts(forHarness(bundle, claim.harness, claim.root ?? "", claim.harnessVersion)));
  const l = await runners.leaseCall(db, {
    id: r.id, caller: { tokenId: caller.tokenId, login: caller.login, role: caller.role, claimId: claim.requestId },
    claim: { harness: claim.harness, harnessVersion: claim.harnessVersion, root: claim.root ?? null, requestId: claim.requestId, ownLane: claim.ownLane === true },
    model: claim.tiers[r.tier]!, now: Date.now(), caps, started, ...(tiered && { tierTokens: tiered }), clearIdle, timeoutMs, source, prompt, rewrite: rewritten ? { bundle: JSON.stringify(bundle), baseStdin: base } : null, live,
  });
  if (l === null || l === "limit" || l === "gone") return l;
  return { id: l.id, secret: l.secret, title: titleOf(source.promptId, source.items), requiredHelper: REQUIRED_HELPER };
}

// ---- lease routes ------------------------------------------------------------------

/**
 * A queued bundle as one harness reads it: the marked harness phrases of its text, and of the `claude` hints that carry the
 * system prompt, filled in. With the claim's path root (a macOS helper) the marked sandbox paths, the path arguments of the
 * hints and the explorer's prompt name the same paths below it; the mounts keep the fixed paths, which the helper places
 * below its root itself. The `claude` hints get the prompt's task budget here, not in the queued bundle, and only when the
 * claim's `harnessVersion` is at least the first Claude Code that takes it (unknown counts as older): an older Claude Code
 * still runs the call, and a server of an earlier version leasing a queued bundle never hands the flag on.
 */
export function forHarness<B extends Omit<TaskBundle, "callId">>(b: B, harness: HarnessId, root = "", harnessVersion?: string | null): B {
  const claude = b.hints.claude;
  const takes = harness === "claude" && harnessVersion && !olderVersion(harnessVersion, TASK_BUDGET_CLAUDE);
  const budget = takes ? taskBudgetOf(b.promptId, b.maxTurns !== null) : undefined;
  const args = claude && (budget !== undefined ? withTaskBudget(withoutTaskBudget(claude.args), budget) : withoutTaskBudget(claude.args));
  return {
    ...b, stdin: fillHarness(b.stdin, harness, root), system: b.system === null ? null : fillHarness(b.system, harness, root),
    hints: { ...b.hints, ...(claude && args && { claude: { ...claude, args: rootArgs(args.map((a) => fillHarness(a, "claude", root)), root), ...(claude.agents !== undefined && { agents: rootAgents(claude.agents, root) }) } }) },
  };
}

/** Reply or progress text with the claim's path root taken off, so paths read as the fixed sandbox paths the rest of the server expects (`/repo/src/a.rs`). */
const unrooted = (text: string, root: string | null): string => (root ? text.split(root).join("") : text);
/** A JSON value (the reply's tool uses) with the claim's path root taken off every string in it; the root is plain characters, so its JSON form is itself. */
const rootless = (v: unknown, root: string | null): unknown => (root && v !== undefined ? JSON.parse(unrooted(JSON.stringify(v), root)) as unknown : v);

/** The task bundle of a live lease, worded for the harness that claimed it, with the lease's time limit, or null. */
export async function bundleOf(db: Db, secret: string | undefined): Promise<TaskBundle | null> {
  const l = secret ? await runners.loadLeaseBundle(db, secret, Date.now()) : null;
  // A claim always records its harness.
  if (!l || l.harness === null) return null;
  const cut = l.lease.leaseTimeoutMs === null ? {} : { timeoutSeconds: Math.floor(l.lease.leaseTimeoutMs / 1000) };
  return { ...forHarness(JSON.parse(l.bundle) as Omit<TaskBundle, "callId">, l.harness as HarnessId, l.lease.root ?? "", l.harnessVersion), ...cut, callId: l.lease.id, ...(await transcriptsOn(db) && { transcriptAfter: true }) };
}

/** A plain one-line progress text from the helper: control characters removed, scrubbed, cut. */
const progressLine = (v: unknown): string | null => (typeof v === "string" && v.trim() ? scrub(v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).slice(0, PROGRESS_MAX) : null);

/** Records a heartbeat; the first `running` one starts the call's time limit. False when the lease is gone (the route answers 410). */
export async function heartbeat(db: Db, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): Promise<boolean> {
  if (!secret) return false;
  const h = raw as Partial<Heartbeat> | undefined;
  const text = typeof h?.progress === "string" && h.progress.trim() ? h.progress : null;
  // A progress line names paths below the claim's path root: the lease is read first for its root (a heartbeat without one is a single statement).
  let root: string | null = null;
  if (text !== null) {
    const l = await runners.loadLiveLease(db, secret, nowMs);
    if (!l) return false;
    root = l.root;
  }
  return (await runners.heartbeatLease(db, secret, { progress: progressLine(text === null ? null : unrooted(text, root)), phase: h?.phase ?? null }, nowMs)) !== null;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
function usageOf(raw: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  return { input: count(u.inputTokens), output: count(u.outputTokens), cacheRead: count(u.cacheReadTokens), cacheWrite: count(u.cacheWriteTokens) };
}

/** Tokens as stored in the `usage` column (usageOf's shape). */
const storedTokens = (v: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } => {
  const u = (v ?? {}) as Record<string, unknown>;
  return { input: count(u.input), output: count(u.output), cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite) };
};

/**
 * Takes a helper's result; null when the lease is gone (the route answers 410). A repeat of an accepted reply (the first
 * answer was lost) is accepted again. A reply from another model than the claim declared for the tier, and a failed reply
 * (`ok: false`), send the call back to the queue with its next attempt, not offered to that login for a while, and count
 * toward the login's cool-off; the call fails once its attempts are used up. A lease cut to its login's room (LOGIN_CUT_MIN_MS)
 * that fails at its cut goes back to the queue without any of these. A result for a call whose items all merged or closed while it
 * ran is accepted and discarded (runners.discardGoneLease): its job skips the item, and the call is neither applied nor asked again.
 */
export async function submitCall(db: Db, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): Promise<SubmitReply | null> {
  const l = await liveLease(db, secret, nowMs);
  const gone = async (): Promise<SubmitReply | null> => (secret && await runners.loadSubmitted(db, secret) ? { accepted: true } : null);
  if (!l) return await gone();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a Submit object");
  const s = raw as Submit;
  const usage = usageOf((s as { usage?: unknown }).usage);
  const duration = count((s as { durationMs?: unknown }).durationMs);
  // Once the reply is recorded the helper sends the full session to ROUTES.transcript (helpers 1.5.0 and 1.5.1 sent it in
  // the submit); it is stored in the background, and a transcript that cannot be stored never fails the submit.
  const transcript = (s as { transcript?: unknown }).transcript;
  const keep = async (outcome: "done" | "failed" | "refused"): Promise<void> => {
    if (l.runId === null) return;
    const attempt = { runId: l.runId, callId: l.id, attempt: l.attempt, outcome, root: l.root };
    if (typeof transcript === "string") {
      if (transcript.length > TRANSCRIPT_MAX) console.log(`transcript of remote call ${l.id} not stored: larger than ${TRANSCRIPT_MAX} characters`);
      else storeCallTranscript(db, { ...attempt, gzipBase64: transcript });
      return;
    }
    try { await expectTranscript(db, secret!, attempt, nowMs + scaledS(TRANSCRIPT_WAIT_S) * 1000, nowMs); } catch (e) { console.log(`transcript of remote call ${l.id} not awaited: ${(e as Error).message}`); }
  };
  // Every item the call names merged or closed while it ran: the result is accepted and discarded, and nothing runs it again.
  if (await runners.discardGoneLease(db, l, { usage, duration }, nowMs)) {
    await keep("failed");
    return { accepted: true };
  }
  if (s.ok === true) {
    if (typeof s.text !== "string" || s.text.length > REPLY_MAX) throw new HttpError(400, "text must be the reply as a string");
    if (typeof s.model !== "string") throw new HttpError(400, "model must name the model that ran");
    const families = modelsOf(await setting(db, REMOTE_MODELS_KEY)).accepted[l.tier];
    const family = familyOf(l.model ?? "", families);
    if (family === null || familyOf(s.model, families) !== family) {
      await runners.failLease(db, l, { error: `the harness reported model ${s.model.slice(0, 100)}, not the ${family ?? l.model} family claimed for the tier`, skipLogin: true, usage, duration, summary: "refused" }, nowMs);
      await keep("failed");
      return { accepted: false, reason: `the claim declared ${l.model} for this tier` };
    }
    const byModel: Record<string, ReturnType<typeof usageOf>> = {};
    const mu = (s as { modelUsage?: unknown }).modelUsage;
    if (mu && typeof mu === "object" && !Array.isArray(mu)) for (const [m, u] of Object.entries(mu).slice(0, 20)) if (m.length <= 100 && usageOf(u)) byModel[m] = usageOf(u);
    const turns = Number.isInteger(s.turns) && s.turns! >= 0 ? s.turns! : null;
    const sessionId = typeof s.sessionId === "string" && s.sessionId.length <= 200 ? s.sessionId : null;
    const costUsd = typeof s.costUsd === "number" && Number.isFinite(s.costUsd) && s.costUsd >= 0 ? s.costUsd : null;
    let tools: Awaited<ReturnType<typeof remoteToolRows>> = [];
    if (l.runId !== null) {
      try { tools = await remoteToolRows(db, l.runId, l.id, rootless((s as { tools?: unknown }).tools, l.root)); } catch (e) { console.log(`tool uses of remote call ${l.id} not stored: ${(e as Error).message}`); }
    }
    // The lease can end between the check above and this write (another process expired it): then the reply is not taken.
    const r = await runners.submitLease(db, l, {
      reply: unrooted(s.text, l.root), model: s.model, usage: { ...(usage ?? usageOf({})), ...(Object.keys(byModel).length > 0 && { byModel }), ...(costUsd !== null && { costUsd }) },
      turns, sessionId, tools, durationMs: duration,
    }, nowMs);
    if (r.accepted) await keep("done");
    return r.accepted ? { accepted: true } : await gone();
  }
  if (s.ok !== false || typeof s.error !== "string") throw new HttpError(400, "ok must be true with text and model, or false with error");
  const said = unrooted(s.error, l.root);
  const error = scrubError(`helper${stopNote(s, usage)}: ${said}`, ERROR_MAX);
  // The whole failure text (the harness's refusal or error as it printed it) is the failed run's output.
  const output = packPrompt(said.slice(0, FAILURE_TEXT_MAX));
  if (s.refused === true || SAFETY_REFUSAL.test(s.error)) {
    const to = refusalRetry(await loadViewFor(db, nowMs), l);
    if (await runners.refuseLease(db, l, to, { error, usage, duration, output }, nowMs)) {
      const by = `${l.model ?? l.askedModel} on ${l.login}'s Task Runner`;
      console.log(`remote call ${l.id} (${l.promptId}) refused by ${by}; ${to ? `retried on ${"token" in to ? "another Task Runner" : `the ${to.tier} tier (${to.model})`}` : "not retried"}`);
      await keep("refused");
    }
    return { accepted: true };
  }
  // A lease cut to its login's room that ran out: the call goes back to the queue without using an attempt or a cool-off strike,
  // and runs with its own time limit after the login's refresh.
  if (l.leaseTimeoutMs !== null && l.startedAt !== null && nowMs - l.startedAt >= l.leaseTimeoutMs - CUT_END_MARGIN_MS) {
    if (await runners.returnLease(db, l, `returned to the queue: the run reached the ${Math.round(l.leaseTimeoutMs / 60_000)} min its Task Runner's harness login had before its refresh`, { usage, output }, nowMs)) await keep("failed");
    return { accepted: true };
  }
  // The last attempt's tokens stay with the failed call.
  if (await runners.failLease(db, l, { error, skipLogin: true, usage, duration, summary: "helper failed", output }, nowMs)) await keep("failed");
  return { accepted: true };
}

/** Whether the attempt behind this lease secret may still send its transcript; checked before its body is read. */
export async function transcriptWanted(db: Db, secret: string | undefined, nowMs: number = Date.now()): Promise<boolean> {
  return !!secret && await transcriptAwaited(db, secret, nowMs);
}

/** Takes a helper's transcript for the attempt it just submitted and stores it in the background; false when none is awaited (the route answers 410). */
export async function uploadTranscript(db: Db, secret: string | undefined, raw: unknown): Promise<boolean> {
  const t = (raw as { transcript?: unknown } | null)?.transcript;
  if (typeof t !== "string" || !t || t.length > TRANSCRIPT_MAX) throw new HttpError(400, `transcript must be the gzip JSONL as base64, at most ${TRANSCRIPT_MAX} characters`);
  const w = secret ? await takeTranscript(db, secret) : null;
  if (!w) return false;
  storeCallTranscript(db, { ...w, gzipBase64: t });
  return true;
}

const FAILURE_TEXT_MAX = 2000;
const STOP_WORD = /^[a-z][a-z0-9_]{0,39}$/;
/** Why a failed run stopped, in parentheses, as the helper reports it: the harness's stop reason and result subtype, and the output tokens it used. Empty when nothing is known. */
function stopNote(s: Extract<Submit, { ok: false }>, usage: { output: number } | null): string {
  const parts = [
    ...(typeof s.stopReason === "string" && STOP_WORD.test(s.stopReason) ? [`stop_reason ${s.stopReason}`] : []),
    ...(typeof s.subtype === "string" && STOP_WORD.test(s.subtype) ? [`subtype ${s.subtype}`] : []),
    ...(usage && usage.output > 0 ? [`${usage.output} output tokens`] : []),
  ];
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** The harness's text for a request the model's safety filter declined, for helpers that do not say so (Submit.refused). */
export const SAFETY_REFUSAL = /safeguards flagged this message|appears to violate our usage policy/i;

const loadViewFor = async (db: Db, nowMs: number): Promise<RemoteView> => {
  const [snapshot, models] = await db.together(() => Promise.all([runners.loadRunnerSnapshot(db, nowMs), setting(db, REMOTE_MODELS_KEY)]));
  return { now: nowMs, snapshot, accepted: modelsOf(models).accepted };
};

/**
 * Where a call the model's safety filter declined runs once more: on another runner token for the same tier, else, for a call
 * that does not judge, a tier lower (top to mid, the instance's model for it), else nowhere. A follow-up turn stays with its
 * session and is not retried; neither is a call that was retried already. Pure over the runner snapshot.
 */
function refusalRetry(v: RemoteView, l: LiveLease): RefusalRetry {
  if (l.refusals > 0 || l.parentId !== null) return null;
  const c = { prompt_id: l.promptId, repos: [...new Set([...l.items.map((i) => i.repo), ...(l.repo ? [l.repo] : [])])], step: l.step, refs: l.items, forLogin: l.forLogin };
  if (l.tokenId !== null && tierTaker(v, { ...c, tier: l.tier }, l.tokenId)) return { token: l.tokenId };
  // A call that judges (gates a merge or a security finding) is never answered by a lower tier: without another runner it fails as refused.
  const lower: Tier | null = l.tier === "top" && !judges(l.promptId) && !l.promptId.startsWith("security.") ? "mid" : null;
  if (lower === null || !tierTaker(v, { ...c, tier: lower }, null)) return null;
  return { tier: lower, model: v.accepted[lower][0] ?? lower };
}

/**
 * The helper gives the lease back (it could not prepare or start the run, or it is stopping): the call returns to the queue without using an
 * attempt and is not offered to that login for RELEASE_SKIP_MS, or for SETUP_RETRY_MS after a setup failure while the call has had fewer such
 * short waits than attempts. A give-back because the helper is stopping (Release.stopped) skips nobody. False when the lease is gone.
 */
export async function releaseCall(db: Db, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): Promise<boolean> {
  const l = await liveLease(db, secret, nowMs);
  if (!l) return false;
  const body = raw as Release | undefined;
  const reason = progressLine(body?.reason) ?? "released by the helper";
  if (body?.stopped === true) return await runners.returnLease(db, l, `released by the helper: ${reason}`, { usage: null }, nowMs);
  const setupRetry = body?.setup === true && l.setupRetries < l.maxAttempts;
  return await runners.releaseLease(db, l, `released by the helper: ${reason}`, nowMs, { ms: setupRetry ? SETUP_RETRY_MS : null, setupRetry });
}

// ---- the caller's side -------------------------------------------------------------

export type Outcome =
  /** `byModel`: tokens per model id as the helper reported them (subagents included), when it did. `costUsd`: the harness's cost of the whole call, when it reported one. */
  | { state: "done"; text: string; usage: Usage; byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> | null; costUsd: number | null; turns: number | null; sessionId: string | null; runId: number | null }
  | { state: "failed"; error: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; runId: number | null }
  /** A follow-up turn that the session's helper did not take in time (STICKY_MS, STICKY_CAP_MS); it was withdrawn. */
  | { state: "unclaimed" };

/** What an await serves while its call is leased: the check relay, the tool calls of its workspace. */
type Held = { checks: boolean; workspaceId: number | null };
/** A call's poll, with whether a check or a tool call of it waits to be run. */
type Polled = runners.CallPoll & { checks: boolean; tools: boolean };

/**
 * The change topics whose writes change a waiting call's poll (src/data/runners/triggers.ts, src/data/build/triggers.ts): its
 * state and progress, a check requested for it, its lease starting or ending, the queue and Task Runners a queued call waits on,
 * and its workspace's tool calls.
 */
const POLL_TOPICS = ["remote-calls", "remote-queue", "remote-helpers", "workspaces"];

/**
 * The poll of every call this process waits on, one read wave whatever their number (runners.loadCallPolls), with the check
 * requests and tool calls that wait for them, and the caller's `seen_at` stamp for all of them every SEEN_EVERY_MS. The wave
 * runs for a call not polled yet, when a counter of POLL_TOPICS moved, and at least every SEEN_EVERY_MS, for what moves with
 * time alone (a lease running out, a session's helper going idle). At the other poll intervals only the counters are read, and
 * the waiters get the last poll again without its checks and tool calls. A lost lease or a gone call among them is ended
 * (runners.expireLeases) and read again in the same poll; a queued call's poll carries the waits' fields. A failed read of the
 * wave fails every call waiting on it (no reply is taken by then); a write that fails after it fails only the calls it was for,
 * and a stamp that fails none: the next poll stamps again.
 */
class CallPoller {
  readonly #db: Db;
  /** The last full poll of each held call, with the POLL_TOPICS counters read with it and when it was read. */
  #polls = new Map<number, { poll: runners.CallPoll; stamp: string; at: number }>();
  #waiting = new Map<number, { resolve: (p: Polled) => void; reject: (e: unknown) => void }[]>();
  /** Calls awaited now, with how many awaits hold each and what else they wait for. */
  #held = new Map<number, Held & { n: number }>();
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #last = 0;
  #seenAt = 0;
  constructor(db: Db) { this.#db = db; }

  hold(id: number, o: Held): void {
    const h = this.#held.get(id);
    this.#held.set(id, { n: (h?.n ?? 0) + 1, checks: o.checks || !!h?.checks, workspaceId: o.workspaceId ?? h?.workspaceId ?? null });
  }
  release(id: number): void {
    const h = this.#held.get(id);
    if (h && --h.n <= 0) {
      this.#held.delete(id);
      this.#polls.delete(id);
    }
  }

  async #stampOf(): Promise<string> {
    const s = await this.#db.seqs(POLL_TOPICS);
    return POLL_TOPICS.map((t) => s[t] ?? 0).join(",");
  }

  /** The next poll of call `id`: the first at once, later ones a poll interval after the one before. */
  next(id: number): Promise<Polled> {
    return new Promise((resolve, reject) => {
      const list = this.#waiting.get(id);
      if (list) list.push({ resolve, reject });
      else this.#waiting.set(id, [{ resolve, reject }]);
      this.#schedule();
    });
  }

  #schedule(): void {
    if (this.#timer || this.#running || !this.#waiting.size) return;
    this.#timer = setTimeout(() => void this.#tick(), Math.max(0, this.#last + allocation.pollMs - Date.now()));
  }

  async #tick(): Promise<void> {
    this.#timer = null;
    this.#running = true;
    this.#last = Date.now();
    const batch = this.#waiting;
    this.#waiting = new Map();
    const db = this.#db, ids = [...batch.keys()];
    try {
      const now = Date.now();
      // The caller's liveness stamp; claims and the room count a call while it is fresher than CALLER_STALE_MS.
      if (now - this.#seenAt >= SEEN_EVERY_MS && this.#held.size) {
        try {
          await runners.markCallersSeen(db, [...this.#held.keys()], now);
          this.#seenAt = now;
        } catch (e) {
          console.error(`the liveness of this process's model calls is not stored: ${(e as Error).message}`);
        }
      }
      const cached = ids.map((id) => this.#polls.get(id));
      if (cached.every((c) => c && now - c.at < SEEN_EVERY_MS)) {
        const stamp = await this.#stampOf();
        if (cached.every((c) => c!.stamp === stamp)) {
          ids.forEach((id, i) => { for (const w of batch.get(id)!) w.resolve({ ...cached[i]!.poll, checks: false, tools: false }); });
          return;
        }
      }
      const held = ids.map((id) => ({ callId: id, ...this.#held.get(id) }));
      const workspaces = held.flatMap((h) => (h.workspaceId != null ? [{ callId: h.callId, workspaceId: h.workspaceId }] : []));
      // The counters are read in the same statement as the polls, so a write after them moves the counters.
      const [stamp, polls, checks, tools] = await db.together(() => Promise.all([
        this.#stampOf(), runners.loadCallPolls(db, ids, now), runners.loadRequestedChecks(db, held.filter((h) => h.checks).map((h) => h.callId)), loadQueuedWorkspaces(db, workspaces),
      ]));
      // A done call's poll carries the reply this wave takes, so it is never served again from here.
      for (const id of ids) {
        const poll = polls.get(id)!;
        if (this.#held.has(id) && poll.call?.state !== "done") this.#polls.set(id, { poll, stamp, at: now });
        else this.#polls.delete(id);
      }
      const asked = new Set(workspaces.filter((w) => tools.has(w.workspaceId)).map((w) => w.callId));
      const resolve = (id: number, p: runners.CallPoll): void => { for (const w of batch.get(id)!) w.resolve({ ...p, checks: checks.has(id), tools: asked.has(id) }); };
      const ended = ids.filter((id) => polls.get(id)!.lost || polls.get(id)!.gone);
      await this.#hand(batch, ids.filter((id) => !ended.includes(id)), polls, now, resolve);
      if (ended.length) {
        await runners.expireLeases(db, { now, ids: ended });
        await this.#hand(batch, ended, await runners.loadCallPolls(db, ended, now), now, resolve);
      }
    } catch (e) {
      // Waiters that have their answer keep it.
      for (const list of batch.values()) for (const w of list) w.reject(e);
    } finally {
      this.#running = false;
      this.#schedule();
    }
  }

  /** Answers the waiters of `ids`; the reply of a done call is taken (runners.takeReplies) before it is handed out. */
  async #hand(batch: ReadonlyMap<number, { reject: (e: unknown) => void }[]>, ids: number[], polls: ReadonlyMap<number, runners.CallPoll>, now: number, resolve: (id: number, p: runners.CallPoll) => void): Promise<void> {
    const taken = ids.filter((id) => { const c = polls.get(id)!.call; return c?.state === "done" && c.consumedAt === null; });
    for (const id of ids) if (!taken.includes(id)) resolve(id, polls.get(id)!);
    try {
      await runners.takeReplies(this.#db, taken, now);
    } catch (e) {
      for (const id of taken) for (const w of batch.get(id)!) w.reject(e);
      return;
    }
    for (const id of taken) resolve(id, polls.get(id)!);
  }
}
const pollers = new WeakMap<Db, CallPoller>();
const pollerOf = (db: Db): CallPoller => {
  let p = pollers.get(db);
  if (!p) pollers.set(db, (p = new CallPoller(db)));
  return p;
};

/**
 * Waits for the call's result. The process's poller reads every waiting call together every allocation.pollMs (CallPoller)
 * and ends a lost lease. A queued call is withdrawn when the job is cancelled or the pipeline is switched off (the halt is
 * thrown), after `maxWaitMs` in the queue (WaitLimitError), and, for a follow-up, after STICKY_MS while its session's helper
 * runs no live lease, else after STICKY_CAP_MS. A call the dashboard withdrew because no Task Runner could take it
 * (takers.ts) throws a NoTakerError and counts as a skipped item (skipItem), so the planner runs the step again. A call withdrawn
 * because of its item (runners.ITEM_WITHDRAWN_PREFIX: merged or closed, its work ended, or taken over by a person's workflow) throws an
 * ItemWithdrawnError: the item is skipped without a failure, and nothing plans it again on that account. While the
 * call is leased, each poll runs the `check` requests the dashboard relayed for it on `check` (src/remote/check-relay.ts)
 * and the tool calls of the workspace bound to the call (src/build/workspace-relay.ts), which also run as soon as their wake
 * arrives. The helper's progress lines go to `onProgress`, each once. `workspace` gives the session they run on (default: the process's session on the workspace, jobSession).
 */
export async function awaitCall(db: Db, id: number, opts: AwaitOptions = {}): Promise<Outcome> {
  const ws = await WorkspaceServer.open(db, id, opts.workspace);
  const poller = pollerOf(db);
  poller.hold(id, { checks: !!opts.check, workspaceId: ws?.workspaceId ?? null });
  try {
    return await pollCall(db, id, opts, ws, poller);
  } finally {
    poller.release(id);
    // Each cleanup runs even when one before it fails.
    try {
      await endChecks(db, id);
    } finally {
      await ws?.end();
    }
  }
}

type AwaitOptions = { onProgress?: (line: string) => void; maxWaitMs?: number; log?: (line: string) => void; check?: Pick<CheckTool, "run">; workspace?: (db: Db, workspaceId: number) => ToolSession };

const parseJson = (v: string | null): unknown => {
  if (!v) return {};
  try { return JSON.parse(v) as unknown; } catch { return {}; }
};

async function pollCall(db: Db, id: number, opts: AwaitOptions, ws: WorkspaceServer | null, poller: CallPoller): Promise<Outcome> {
  const log = opts.log ?? console.log;
  let lastLog = 0, lastProgress: string | null = null;
  // The repos the call names, from its queue entry: a call withdrawn for want of a taker skips them.
  let repos: string[] | null = null;
  for (;;) {
    const poll = await poller.next(id);
    const queued = poll.queued;
    const nowMs = Date.now();
    const r: PollRow | null = poll.call;
    if (queued) repos = queued.repos;
    if (!r) return { state: "failed", error: "the call is gone", tokens: null, runId: null };
    if (r.state === "done") {
      const stored = parseJson(r.usage) as { byModel?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>; costUsd?: number };
      const costUsd = typeof stored.costUsd === "number" ? stored.costUsd : null;
      // The poll cleared the raw reply (the agent run stores the scrubbed copy); a read reply can no longer be adopted.
      return { state: "done", text: r.reply ?? "", usage: { ...storedTokens(stored), cost: costUsd }, byModel: stored.byModel ?? null, costUsd, turns: r.turns, sessionId: r.sessionId, runId: r.runId };
    }
    if (r.state === "failed" && r.error?.startsWith(NO_TAKER_PREFIX)) {
      const named = repos ?? [...new Set((await runners.loadCalls(db, [id])).get(id)?.items.map((i) => i.repo) ?? [])];
      skipItem(`${NO_TAKER_SKIP}${named.join(",")}`, log, r.error, named.join(", ") || `call ${id}`);
      throw new NoTakerError(r.error);
    }
    if (r.state === "failed" && r.error?.startsWith(runners.ITEM_WITHDRAWN_PREFIX)) {
      log(`  call ${id} ${r.error}`);
      throw new ItemWithdrawnError(r.error);
    }
    if (r.state === "failed") return { state: "failed", error: r.error ?? "failed", tokens: r.usage ? storedTokens(parseJson(r.usage)) : null, runId: r.runId };
    if (r.state === "queued") {
      try {
        await throwIfHalted("waiting for a user-local helper");
      } catch (e) {
        if (await withdrawCall(db, id, (e as Error).message, ["queued"])) throw e;
        continue; // claimed meanwhile: the call runs on
      }
      if (queued) {
        const waited = nowMs - (queued.queuedSince ?? queued.since);
        if (queued.parentId !== null && (waited >= STICKY_CAP_MS || (waited >= STICKY_MS && !poll.parentLive))) {
          if (await withdrawCall(db, id, "the helper holding the session did not take the follow-up", ["queued"])) return { state: "unclaimed" };
          continue;
        }
        // Only time in the queue counts; a helper running the call is not waiting.
        if (opts.maxWaitMs !== undefined && queued.queuedMs + (queued.queuedSince === null ? 0 : nowMs - queued.queuedSince) >= opts.maxWaitMs) {
          if (await withdrawCall(db, id, "no helper took the call in time", ["queued"])) throw new WaitLimitError(CALL_WAIT_LIMIT);
          continue;
        }
        if (nowMs - lastLog >= allocation.logEveryMs) {
          lastLog = nowMs;
          log(`waiting for a user-local helper (${queued.promptId}, ${queued.tier} tier)`);
        }
      }
    }
    if (r.state === "leased" && opts.check && poll.checks) await serveChecks(db, id, opts.check);
    if (r.state === "leased" && ws && poll.tools) await ws.serve();
    if (r.progress !== null && r.progress !== lastProgress) {
      lastProgress = r.progress;
      try { opts.onProgress?.(r.progress); } catch { /* progress is best effort */ }
    }
  }
}

/**
 * For the runner: whether a remote call of the job waits in the queue now for a caller that polls it, and when its latest
 * lease began. The runner sums the time in which any call waited (the union, as calls of one job wait side by side).
 */
export async function jobRemoteQueue(db: Db, jobId: number, nowMs: number = Date.now()): Promise<{ queued: boolean; lastLeaseAt: number | null }> {
  return (await runners.loadRemoteQueueStates(db, [jobId], nowMs)).get(jobId) ?? { queued: false, lastLeaseAt: null };
}
