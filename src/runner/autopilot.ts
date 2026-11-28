// The pipeline switch and the autopilot behind it. With the switch on, the
// runner looks for work whenever a content topic changed, a job finished or an
// operator released work (a 5-minute timer is only a fallback), and queues one
// job per stage that has work, no job of its own queued or running, and an
// item limit left for the day. A job that handled nothing is not queued again
// until the input it saw changes (its fingerprint); a failed job is retried
// after a short, growing backoff. Stages run in pipeline order; a failure in
// one does not stop the others. Turned off, no new jobs are queued and running
// jobs finish.
//
// The planner reads the database, writes only its Plan cache (item_plans) and queues jobs; the runner starts them.
// Each lane's `detect` reads the Plans of the pass (src/core/plan-set.ts).
import type { ItemRef } from "../../web/src/api/types.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { REFEREE_RETRY_MS } from "../core/item-rules.ts";
import type { PipelineState, StageLimit } from "../../web/src/api/types.ts";
import { TOPICS } from "../db/live.ts";
import { pendingConversations } from "../conversations/store.ts";
import { plannedItems, type PlannedItem } from "../core/select-items.ts";
import { loadPlanSet, type PlanSet } from "../core/plan-set.ts";
import { mayRun, mergePermission } from "../core/authority.ts";
import type { RefusalCode } from "../core/codes.ts";
import type { Action, ActionKind, PrFacts } from "../core/plan.ts";
import { planCacheDiff, writePlanDiff } from "../core/plan-cache.ts";
import { refreshLiveness } from "../liveness.ts";
import { embedderId, modelName } from "../embed/model.ts";
import { jevUsable } from "../agents/jev.ts";
import { PACE_MAX_WAIT_MS, pipelineWriteWaits } from "../github/write.ts";
import { embedDue } from "../embed/store.ts";
import { selectFixups } from "../fixup/select.ts";
import { approvedRepos } from "../core/repo-approvals.ts";
import { ciApproveRepos } from "../merge/ci-approval.ts";
import { batchesDue, publishBackoffs } from "../merge/batch-store.ts";
import { trackedNames } from "../repos.ts";
import { inFlightNow, ownLane, planned, type Planned } from "../core/select.ts";
import { isQueueState } from "../core/plan.ts";
import { isWork } from "../core/assignment.ts";
import { collectDue } from "../verify/results.ts";
import { featureRepos } from "../build/features.ts";
import { nightlyRepos } from "../nightly/index.ts";
import { EVAL_EVERY_MS, evalRepo } from "../eval/schedule.ts";
import { prBuildsDue } from "../prbuild/index.ts";
import { actLimit, actUsedToday } from "../conversations/usage.ts";
import { queueHead } from "../conversations/queue.ts";
import { filingWakes, heldDue } from "../conversations/held.ts";
import { defaultPerDay, lanesInOrder, limitSteps, zeroOnlySteps } from "../stages/registry.ts";
import { premergeCandidates } from "../premerge/review.ts";
import { pendingDefects, postmergeRepos, stuckFilings } from "../postmerge/select.ts";
import { mainFixClock, mainFixDueRepos } from "../mainfix/index.ts";
import { statusDueIn, statusRetriesAt, statusRetriesDue } from "../prstatus/index.ts";
import { waitsForHaiku } from "../priority/index.ts";
import { loadOwnLogins } from "../data/access/index.ts";
import { loadLivenessState, loadStoredPlans } from "../data/planner/index.ts";
import { PIPELINE_DRAIN } from "../core/rules.ts";
import { checkRequest, DEADLINE_ERROR, JobError, now } from "./jobs.ts";
import { NO_TAKER_SKIP, UNITS_RAN } from "./leases.ts";
import { jobBlock, stepParallel, untakenTest, wantOf, type Active, type UntakenTest } from "./concurrency.ts";
import { APPROVED_LANE, approvedLane, hasApprovedLane, isHeadSha, ITEM_LANE, knownStep, loadSteps, perItemLane, type Params, type StepDef } from "./steps.ts";
import { repoInScope, type RepoScope, type ScopeFor } from "../core/scope.ts";
import { loadRepoScopes } from "../data/workflow/index.ts";
import { refreshOutsideHolds } from "../outside.ts";
import { ackDeadlines, addAudit, freshConfig, loadAuditMax, loadLiveConfig, loadStageLimits, loadTrips, readSettingsSnapshot, rereadSettingsSnapshot, resetLimitCounts, saveSettings, setStageLimit, withSettingsSnapshot, limitsSignature } from "../data/control/index.ts";
import { dropJobCalls } from "./lifecycle.ts";
import { prLease } from "../prepush/settle.ts";
import { enqueueJobs, itemFpStep, loadLastJobPerStep, loadDeadlineStops, loadHeldLeaseKeys, loadLaneInputs, loadLaneState, markCancelQueued, pruneItemFps, removeLaneState, saveLaneState, saveLanes, loadLanes, type DeadlineStop, type EndedJob, type LaneInputs, type LaneStatePut, type StreakRow } from "../data/jobs/index.ts";
import { loadTakerSignature } from "../data/runners/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadDueOwnRetries } from "../data/implement/index.ts";
import { loadRefereeFailureTimes } from "../data/triage/index.ts";
import { failureDelayMs } from "../core/backoff.ts";
import { STEP_STAGE, tripOf } from "../core/push-outcome.ts";
import { planPass, type PlanPass } from "../core/plan-engine.ts";
import { filterSeq, mapSeq, someSeq } from "../async-seq.ts";
import { leaseTurnover } from "../remote/calls.ts";
import type { Db } from "../db/index.ts";
import { createHash } from "node:crypto";

/** Fallback only: the planner normally runs on a content change, a finished job or a release. */
export const PLAN_EVERY_MS = 5 * 60_000;
/** An incremental planner (the runner's) loads every item's facts again at least this often: the bound on a change the log missed. */
export const PLAN_FULL_EVERY_MS = 30 * 60_000;
/** Checks younger than this count as current for the review that follows. */
export const CHECKS_FRESH_MS = 5 * 60_000;
/** How often the CI and mergeable state of a repo with PRs waiting for CI (or an open batch PR) is read again. */
export const WAITING_CI_RECHECK_MS = 60_000;
export const AUTOPILOT_USER = "pipeline";

export const KEY_ENABLED = "pipeline_enabled";
/** Who changed the pipeline switch last, and when. */
export const KEY_BY = "pipeline_changed_by", KEY_AT = "pipeline_changed_at";
/** Names of the planner marks in lane_state. */
const MARK_PLANNED_AT = "planned_at", MARK_SEQS_SEEN = "seqs_seen", MARK_WAKE_AT = "wake_at", MARK_STATUS = "status";

// ---- lanes ---------------------------------------------------------------------

/** The most items one job of `step` works: the largest limit it takes. */
const limitMax = (step: string): number => {
  const p = knownStep(step)?.params.find((x) => x.name === "limit");
  return p?.kind === "int" ? p.max : Infinity;
};

/** The first (best-scored) planned PR of each repo. */
const firstByRepo = (items: Planned[]): Map<string, Planned> => {
  const out = new Map<string, Planned>();
  for (const p of items) if (!out.has(p.facts.repo)) out.set(p.facts.repo, p);
  return out;
};

/**
 * Repos with a PR of ours we broke come first, then repos with work of ours in flight, then the rest, each group in the given order:
 * a job takes one repo, so finishing what AutoCraft started beats starting new work.
 */
function flightFirst(plans: PlanSet, repos: string[]): string[] {
  const broke = new Set(plans.prs.filter((p) => p.facts.brokeByUs && p.plan.actions.some(isWork)).map((p) => p.facts.repo));
  const flying = new Set([...plans.prs, ...plans.items].filter((p) => p.plan.actions.some(isWork) && inFlightNow(p.facts, p.plan.state)).map((p) => p.facts.repo));
  const rank = (r: string): number => (broke.has(r) ? 0 : flying.has(r) ? 1 : 2);
  return [...repos].sort((a, b) => rank(a) - rank(b));
}

/** One job the autopilot may queue; `params` leaves out `limit`, which the planner sets. */
export type Candidate = {
  step: string; params: Params;
  /** Polls an external system (CI, GitHub, the sandbox): it may run again on unchanged inputs, at most once a minute. */
  poll?: boolean;
  /** The due items the job's calls would name: the job is proposed only while a call about one of them has a Task Runner (untakenTest). */
  refs?: readonly ItemRef[];
  /** Another job that must also be startable now, e.g. the review that follows a checks job. */
  gate?: { step: string; params: Params; poll?: boolean; refs?: readonly ItemRef[] };
  /** What its repo must be in scope for, where that is not the lane's. */
  scope?: ScopeFor;
};
/** A pipeline stage in order. `detect` lists the jobs that have work, best first. */
export type Lane = {
  name: string;
  /** Every step the lane may queue. When none of them can start (busy, paused, limit reached, cooling down), the lane is not detected at all. */
  steps?: string[];
  /** Its jobs are per repo: the lane's jobs are judged one repo at a time. */
  perRepo?: boolean;
  /** What a repo must be in scope for to get its jobs (`work` when omitted); `detect` decides which of those have any. */
  scope?: ScopeFor;
  /** The change topics the lane's input lives in (default: INPUT_TOPICS). A job that handled nothing is not queued again while these and `extra` are unchanged. */
  topics?: string[];
  /** Input that no topic reports, e.g. the room under a daily limit. */
  extra?: (db: Db) => Promise<string>;
  /** Least time between two of the lane's jobs: for cheap recomputes whose input moves in bursts (a sync writes in several transactions) and that no stage waits on. */
  minGapMs?: number;
  detect: (db: Db, ctx: PlanCtx) => Promise<Candidate[]>;
  /** Work score of the lane's best item, null when it has none. Lanes that define it share capacity: see orderLanes(). */
  topScore?: (db: Db, ctx: PlanCtx) => Promise<number | null>;
  /** Runs when the candidate was queued; may write. */
  chosen?: (db: Db, c: Candidate) => Promise<void>;
};

/** What every lane's detect shares, resolved once per planner pass. */
export type PlanCtx = {
  run: string | null;
  /** The repos in scope for work. */
  tracked: string[];
  /** The Plans of the pass: facts loaded and decided once. Lanes read them; a lane run without them (a test) loads them on first use. */
  plans?: PlanSet;
  /** Times (ms) at which something the lanes wait for becomes due; the planner wakes at the earliest. */
  wake?: number[];
  /** Why a stage waits on an outside system (CI, the sandbox), keyed by step; shown on the Pipeline page. */
  notes?: Record<string, string>;
  /** The pass's reading of the Task Runners (untakenTest); a lane run without it reads them on first use. */
  untaken?: UntakenTest;
  /** The planner marks and round-robin cursors (lane_state), as the pass read them. */
  marks?: Map<string, string>;
  /** What decides the scope of every tracked repo, as the pass read it. */
  scopes?: Map<string, RepoScope>;
  /** The topic counters the pass read with the change log, so a change after them is new input to the next pass. */
  seqs?: Record<string, number>;
  /** The planner pass's candidates of each lane, by lane name: the Next lists reuse what the pass detected. */
  detected?: Map<string, Promise<Candidate[]>>;
  /** The incremental pass that built `plans`, when the planner keeps facts between passes. */
  pass?: PlanPass;
};

/** The tracked repos in scope for `what`, in name order; a context a test made without scopes has its `tracked` for everything. */
const reposFor = (ctx: PlanCtx, what: ScopeFor): string[] => (ctx.scopes ? [...ctx.scopes].filter(([, r]) => repoInScope(r, what)).map(([name]) => name) : ctx.tracked);

const workRepos = (scopes: Map<string, RepoScope>): string[] => [...scopes].filter(([, r]) => repoInScope(r, "work")).map(([name]) => name);

/** Only the repos in scope are planned for; a job for another repo is never proposed. */
export const planCtx = async (db: Db, incremental = false, own?: ReadonlySet<string>): Promise<PlanCtx> => {
  // The outside-author holds first: the facts below read them through the scope condition (src/outside.ts).
  const wake: number[] = [];
  try {
    const outside = await refreshOutsideHolds(db, Date.now(), own);
    if (outside.wakeAt !== null) wake.push(outside.wakeAt);
  } catch (e) {
    console.error(`autopilot: outside-author holds: ${(e as Error).message}`);
  }
  if (incremental) {
    // The pass reads the settings, the change log and every load in one transaction, so a write in between is either all seen or left for the next pass.
    let scopes = new Map<string, RepoScope>(), seqs: Record<string, number> = {};
    const first = async (): Promise<void> => { [scopes, seqs] = await Promise.all([loadRepoScopes(db), db.seqs(), rereadSettingsSnapshot(db)]); };
    const pass = await planPass(db, { now: Date.now(), first, fullEveryMs: PLAN_FULL_EVERY_MS });
    wakeAtRefresh(pass.plans, wake);
    return { run: pass.plans.run, tracked: workRepos(scopes), plans: pass.plans, pass, wake, notes: {}, scopes, seqs };
  }
  const [scopes, seqs] = await db.together(() => Promise.all([loadRepoScopes(db), db.seqs()]));
  const plans = await loadPlanSet(db);
  wakeAtRefresh(plans, wake);
  return { run: plans.run, tracked: workRepos(scopes), plans, wake, notes: {}, scopes, seqs };
};

/**
 * The earliest refreshAt of the pass's facts (a timed hold, backoff, permission-read lifetime or cache lifetime ends): the
 * Plans can change then with no logged write, and steps outside the planner take their items from the stored Plans.
 */
function wakeAtRefresh(plans: Pick<PlanSet, "prs" | "items">, wake: number[]): void {
  let at = Infinity;
  for (const { facts } of plans.prs) if (facts.refreshAt !== undefined && facts.refreshAt < at) at = facts.refreshAt;
  for (const { facts } of plans.items) if (facts.refreshAt !== undefined && facts.refreshAt < at) at = facts.refreshAt;
  if (at !== Infinity) wake.push(at);
}

/** The lane's candidates, detected once per planner pass (ctx.detected). */
const detectOf = (db: Db, ctx: PlanCtx, lane: Pick<Lane, "name" | "detect">): Promise<Candidate[]> => {
  if (!ctx.detected) return lane.detect(db, ctx);
  let c = ctx.detected.get(lane.name);
  if (!c) {
    const m = ctx.detected;
    m.set(lane.name, (c = lane.detect(db, ctx)));
    // A detect that failed is run again by the next caller.
    void c.catch(() => { if (m.get(lane.name) === c) m.delete(lane.name); });
  }
  return c;
};

/** The pass's Plans (loaded on first use when the ctx came without). */
const plansOf = async (db: Db, ctx: PlanCtx): Promise<PlanSet> => (ctx.plans ??= await loadPlanSet(db, { run: ctx.run }));
/**
 * The planned items of `kind` that a job of `step`, which serves every repo, gets to work now. In the user-local mode a job
 * leaves out the Claude calls no Task Runner takes (the pools' poolRoom, the pair check's taker test), so an item that only
 * such a call would serve is not work: a job for it would handle nothing and be queued again on every change of its input.
 * `free`: the item needs no Claude call now (no model, or Jev while Jev may be called).
 */
async function servable(db: Db, ctx: PlanCtx, kind: ActionKind, step: string, free: (p: PlannedItem) => boolean = () => false): Promise<PlannedItem[]> {
  const untaken = (ctx.untaken ??= await untakenTest(db)), byRepo = new Map<string, string | null>();
  let why: string | null = null;
  const out = await filterSeq((await plannedItems(db, kind, { plans: await plansOf(db, ctx) })), async (p) => {
    if (free(p)) return true;
    const repo = p.facts.repo;
    if (!byRepo.has(repo)) byRepo.set(repo, await untaken({ step, repo }));
    const w = byRepo.get(repo)!;
    why ??= w;
    return w === null;
  });
  // With nothing left, the step's status names the wait rather than "nothing to do".
  if (!out.length && why !== null && ctx.notes) ctx.notes[step] ??= why;
  return out;
}

/** The round-robin cursor of a lane: the repo its last job took. */
const cursorOf = async (db: Db, ctx: PlanCtx, name: "review" | "verify"): Promise<string | null> =>
  (ctx.marks ??= new Map([...(await loadLaneState(db, ["cursor"])).values()].map((r) => [r.step, r.value]))).get(name) ?? null;

/**
 * Topics whose changes call for a plan: content the stages read. Job logs, usage, agent runs, sandbox environments and tasks, audit entries, the
 * item-trace bookkeeping and the limits topic (its tables are already read through the jobs topic) do not. `plan-inputs` covers what
 * the plan facts read in tables of the other topics or of none; a table of theirs without a topic says why (noTopic in src/db/plan-inputs.ts).
 */
export const INPUT_TOPICS = TOPICS.filter((t) => !["jobs", "usage", "agents", "envs", "tasks", "workspaces", "access", "github", "plans", "trace", "limits", "security", "discord", "discord-links", "discord-verify", "downloads", "build-features", "pr-builds", "nightly", "remote-helpers", "remote-queue", "remote-room", "remote-calls", "rank-inputs", "workflow-events", "job-ends", "task-ends", "auto-stops", "statement-sources", "chat", "prompts"].includes(t));

/**
 * Topics that make the planner due. Ended jobs and returned leases let held-back work start, but are no new input to a lane whose job
 * handled nothing; nor is a build feature's switch, which is planned at once. A sync run's own rows make nothing due: what a sync
 * changed moves the topics of the tables it wrote.
 */
export const DUE_TOPICS = [...INPUT_TOPICS.filter((t) => t !== "sync"), "job-ends", "task-ends", "build-features"];

/** The topics of lanes that also read the results of sandbox tasks. */
const TASK_TOPICS = [...INPUT_TOPICS, "task-ends"];

/** The Task Runners that could take calls (loadTakerSignature). Work a pool left for want of a taker waits on it. */
const takersOf = async (db: Db): Promise<string> => passOf(db)?.takers ?? await loadTakerSignature(db, Date.now());

/** The lane's input that no topic reports, read once per pass (several lanes share a reading). */
const extraOf = async (db: Db, extra: Lane["extra"]): Promise<string> => {
  const pass = passOf(db);
  if (!extra || !pass) return await extra?.(db) ?? "";
  let r = pass.extras.get(extra);
  if (!r) {
    pass.extras.set(extra, (r = extra(db)));
    void r.catch(() => pass.extras.delete(extra));
  }
  return await r;
};

const repoOf = (c: { params: Params }): string | null => (typeof c.params.repo === "string" ? c.params.repo : null);

type JobEnd = { id: number; endedAt: string; state: string; items: number | null; acted: number | null; lease_skips: number | null; lease_skip_keys: string | null };

/** Job, limit, breaker and release reads of one planner pass, loaded once. Other connections may start or end jobs meanwhile; applyProposals re-checks blocks and limits with fresh reads. */
type Reads = {
  inputs: LaneInputs; limits: Map<string, LimitRow>;
  /** The newest operator release per action (RELEASE_STEPS). */
  released: Map<string, string>;
};
type PassReads = {
  db: Db; reads: Reads;
  /** The Task Runner signature (takersOf). */
  takers?: string;
  /** The lanes' `extra` readings, by function. */
  extras: Map<NonNullable<Lane["extra"]>, Promise<string>>;
  /** Act's usage per UTC day start. */
  act: Map<string, number>;
};
const passScope = new AsyncLocalStorage<PassReads>();
const passOf = (db: Db): PassReads | null => { const p = passScope.getStore(); return p?.db === db ? p : null; };

async function loadReads(db: Db, ms: number): Promise<Reads> {
  const [inputs, limits, released] = await db.together(() => Promise.all([
    loadLaneInputs(db, ms), loadStageLimits(db, DEFAULT_PER_DAY), loadAuditMax(db, Object.keys(RELEASE_STEPS)),
  ]));
  return { inputs, limits, released };
}

/** The pass's reads, or a fresh load for a caller outside a pass. */
const readsOf = async (db: Db, ms: number = Date.now()): Promise<Reads> => passOf(db)?.reads ?? await loadReads(db, ms);

async function withPassReads<T>(db: Db, r: Pick<PassReads, "reads"> & Partial<PassReads>, fn: () => Promise<T>): Promise<T> {
  if (passOf(db)) return await fn();
  return await passScope.run({ extras: new Map(), act: new Map(), ...r, db }, fn);
}

async function lastJobEnd(db: Db, step: string, repo: string | null, requestedBy?: string, lane?: number | null): Promise<JobEnd | undefined> {
  // The newest ended job of each step, repo, requester and lane PR; the answer is the newest of those that match. `lane`: only the
  // jobs of that lane PR (lanePrOf), or with null only the step's jobs without a lane.
  let best: EndedJob | undefined;
  for (const e of (await readsOf(db)).inputs.ends) if (e.step === step && (repo === null || e.repo === repo) && (requestedBy === undefined || e.requested_by === requestedBy) && (lane === undefined || e.lane_number === lane) && (!best || e.id > best.id)) best = e;
  return best && { id: best.id, endedAt: best.ended_at!, state: best.state, items: best.items, acted: best.acted, lease_skips: best.lease_skips, lease_skip_keys: best.lease_skip_keys };
}

/** A job that changed nothing: it handled no items and made no other progress (a batch advanced, a PR opened). */
const wasIdle = (j: { items: number | null; acted: number | null }): boolean => !j.items && !j.acted;

// ---- fingerprints ----------------------------------------------------------------

type FpRecord = { job: number | null; fp: string };

/**
 * What the lane's input looked like: the step, its repo, and the counters of the topics it reads. A per-item job's input is its own
 * PR (`prSig`: prSigOf its facts) in place of the counters, so an idle item job runs again when its PR changed, not when any item did.
 * A repo job proposed for its due items (Candidate.refs) reads those PRs the same way (`refsSig`: refsSigOf them).
 */
export async function fingerprintOf(db: Db, lane: Pick<Lane, "topics" | "extra">, step: string, params: Params, seqs?: Record<string, number>, prSig?: string, refsSig?: string): Promise<string> {
  const repo = typeof params.repo === "string" ? params.repo : "";
  if (prSig !== undefined && lanePrOf(params) !== null) return [step, repo, `#${lanePrOf(params)}`, prSig, await extraOf(db, lane.extra), await takersOf(db)].join("|");
  if (refsSig !== undefined && lanePrOf(params) === null) return [step, repo, `refs:${refsSig}`, await extraOf(db, lane.extra), await takersOf(db)].join("|");
  if (seqs === undefined) seqs = await db.seqs();
  const topics = lane.topics ?? INPUT_TOPICS;
  return [step, repo, ...topics.map((t) => seqs[t] ?? 0), await extraOf(db, lane.extra), await takersOf(db)].join("|");
}

/** A digest of the due items of a repo job and of each one's facts (`sigOf`: prSigOf, undefined for an item without facts). */
export function refsSigOf(refs: readonly ItemRef[], sigOf: (r: ItemRef) => string | undefined): string {
  const parts = refs.map((r) => `${r.repo}#${r.number}=${sigOf(r) ?? ""}`).sort();
  return createHash("sha1").update(parts.join(",")).digest("base64url");
}

/** A digest of a PR's facts, without the clock and the rank score, which move without the PR changing. */
export function prSigOf(facts: PrFacts): string {
  const { now: _now, score: _score, ...rest } = facts;
  return createHash("sha1").update(JSON.stringify(rest)).digest("base64url");
}

async function fpRecord(db: Db, step: string, repo: string | null, lane: number | null = null): Promise<FpRecord | null> {
  return (await readsOf(db)).inputs.fps.get(`${fpStep(step, lane)}|${repo ?? ""}`) ?? null;
}

/** The PR of a job of a per-item lane, approved or item (src/runner/concurrency.ts), null for a job without a lane. */
export const lanePrOf = (params: Params): number | null => (perItemLane(params) && typeof params.number === "number" ? params.number : null);

/** The step under which a job's input fingerprint is kept: a lane PR's jobs keep their own. */
const fpStep = (step: string, lane: number | null): string => (lane === null ? step : itemFpStep(step, lane));

/** Tracked repos after `cursor` first, wrapping round. */
export function roundRobin(repos: string[], cursor: string | null): string[] {
  const sorted = [...repos].sort();
  const after = sorted.filter((r) => cursor !== null && r > cursor);
  return [...after, ...sorted.filter((r) => !after.includes(r))];
}

/** The issue an implement job works on, its bucket and the planned item's work score. */
type ImplementJob = { number: number; bucket: string; score: number | null };

/** implementWork of a planner pass's Plans, made on first use and kept with them. */
const passImplementWork = new WeakMap<PlanSet, Promise<Map<string, ImplementJob>>>();

/**
 * Per repo, the queued issue its next implement job works on. The revisions of our implementation PRs (planned on the PR,
 * for the PR's issue) come first, then the issues in the planned order (work of ours in flight, then the work score). With several, the first
 * whose job may run now (implementRefusals): one that may not keeps no other work of the repo back.
 */
async function implementWork(db: Db, tracked: string[], plans: PlanSet): Promise<Map<string, ImplementJob>> {
  let work = passImplementWork.get(plans);
  if (!work) {
    passImplementWork.set(plans, (work = findImplementWork(db, tracked, plans)));
    void work.catch(() => passImplementWork.delete(plans));
  }
  return await work;
}

async function findImplementWork(db: Db, tracked: string[], plans: PlanSet): Promise<Map<string, ImplementJob>> {
  const found = new Map<string, ImplementJob[]>(tracked.map((repo) => [repo, []]));
  for (const p of await planned(db, "implement", { plans })) found.get(p.facts.repo)?.push({ number: Number(p.action.params?.issue), bucket: "revise", score: p.facts.score });
  for (const p of await plannedItems(db, "implement", { plans })) found.get(p.facts.repo)?.push({ number: p.facts.number, bucket: String(p.action.params?.bucket ?? "plan"), score: p.facts.score });
  const choices = [...found].flatMap(([repo, jobs]) => (jobs.length > 1 ? jobs.map((j) => ({ repo, number: j.number })) : []));
  const refused = choices.length ? await (await import("../implement/gate.ts")).implementRefusals(db, choices) : new Map<string, string | null>();
  const out = new Map<string, ImplementJob>();
  for (const [repo, jobs] of found) {
    const next = jobs.find((j) => (refused.get(`${repo}#${j.number}`) ?? null) === null) ?? jobs[0];
    if (next) out.set(repo, next);
  }
  return out;
}

/** The highest of the scores, null when there is none. */
export const bestScore = (scores: (number | null | undefined)[]): number | null => {
  const some = scores.filter((s): s is number => typeof s === "number");
  return some.length ? Math.max(...some) : null;
};

/**
 * Lanes that have a topScore trade places by it: the lane whose best item has the higher work score comes
 * first, so its job is queued first. A lane without work goes last; ties keep the pipeline order. Other
 * lanes keep their places.
 */
export function orderLanes<T extends { name: string }>(lanes: T[], tops: Map<string, number | null>): T[] {
  const shared = lanes.filter((l) => tops.has(l.name));
  const sorted = [...shared].sort((a, b) => (tops.get(b.name) ?? -Infinity) - (tops.get(a.name) ?? -Infinity) || 0);
  let k = 0;
  return lanes.map((l) => (tops.has(l.name) ? sorted[k++]! : l));
}

/** Repos with a CI-fix action of one of the buckets that may run. */
async function cifixRepos(db: Db, ctx: PlanCtx, buckets: string[]): Promise<string[]> {
  const repos = new Set(ctx.tracked);
  const due = (await planned(db, "cifix", { plans: await plansOf(db, ctx) })).filter((p) => buckets.includes(String(p.action.params?.bucket)));
  return flightFirst(await plansOf(db, ctx), [...new Set(due.map((p) => p.facts.repo))].filter((r) => repos.has(r)).sort());
}

/** A PR due the work of a per-item step (src/runner/concurrency.ts); `approved`: a person started or approved it (ownLane). */
/** `head`: the PR's head now, which the job's params name (steps.ts HEAD_PARAM). */
type LaneDue = { repo: string; number: number; approved: boolean; head?: string | null };
const laneDue = (p: { facts: PrFacts }): LaneDue => ({ repo: p.facts.repo, number: p.facts.number, approved: ownLane(p.facts), head: p.facts.head });

/**
 * The jobs of a per-item step, one per due PR of `repos`: first those a person started or approved, in `due` order
 * (`{ repo, number, lane: "approved" }`), then the others (`{ repo, number, lane: "item" }`), taking one PR of each repo in turn in
 * the order of `repos`, so a pass's proposals spread over the repos. `make` builds a candidate from the job's params and the item
 * its calls name.
 */
export function laneCandidates(step: string, repos: string[], due: readonly LaneDue[], make: (params: Params, refs: ItemRef[]) => Candidate = (params, refs) => ({ step, params, refs })): Candidate[] {
  const inScope = new Set(repos), seen = new Set<string>(), items = new Map<string, LaneDue[]>();
  const fresh = (d: LaneDue): boolean => inScope.has(d.repo) && !seen.has(`${d.repo}#${d.number}`) && !!seen.add(`${d.repo}#${d.number}`);
  const approved = due.filter((d) => d.approved && fresh(d));
  for (const d of due) if (!d.approved && fresh(d)) (items.get(d.repo) ?? items.set(d.repo, []).get(d.repo)!).push(d);
  const turns: LaneDue[] = [];
  const queues = repos.filter((r, i) => items.has(r) && repos.indexOf(r) === i).map((r) => items.get(r)!);
  for (let k = 0; queues.some((q) => k < q.length); k++) for (const q of queues) if (k < q.length) turns.push(q[k]!);
  const job = (d: LaneDue, lane: string): Candidate => make({ repo: d.repo, number: d.number, lane, ...(isHeadSha(d.head) ? { head: d.head } : {}) }, [{ repo: d.repo, number: d.number }]);
  return [...approved.map((d) => job(d, APPROVED_LANE)), ...turns.map((d) => job(d, ITEM_LANE))];
}

/** The code of each lane, keyed by name. Names, steps and order come from the stage registry. */
const LANE_CODE: Omit<Lane, "steps">[] = [
  {
    name: "classify",
    // Jev classifies the items Jev is due for without a Task Runner; Haiku's calls need one.
    detect: async (db, ctx) => {
      const jev = !!ctx.run && await jevUsable(db);
      return ctx.run && (await servable(db, ctx, "classify", "classify-new", (p) => jev && p.action.params?.source === "jev")).length ? [{ step: "classify-new", params: {} }] : [];
    },
  },
  {
    // Items without a priority at their current text hash; the scores of the others are refreshed by the same job. Jev rates without a Task
    // Runner; an item Jev was unsure of waits for one that takes Haiku's call.
    name: "priority",
    detect: async (db, ctx) => {
      const jev = await jevUsable(db);
      const haiku = jev ? await waitsForHaiku(db, await plannedItems(db, "prioritize", { plans: await plansOf(db, ctx) })) : null;
      return (await servable(db, ctx, "prioritize", "prioritize", (p) => !!haiku && !haiku.has(`${p.facts.repo}#${p.facts.number}`))).length ? [{ step: "prioritize", params: {} }] : [];
    },
  },
  {
    // Work score from the stored priority, size, type and security flag; no model. The rank-inputs topic is its work test:
    // it moves only when something runRank reads changed (the lane's own output is not in it).
    name: "rank",
    topics: ["rank-inputs"],
    minGapMs: 60_000,
    detect: async () => [{ step: "rank", params: {} }],
  },
  {
    name: "embed",
    // The diff probe reads every tracked item; it is asked again only when the pass's counters of what it reads moved.
    detect: async (db, ctx) => (await embedDue(db, embedderId(modelName()), await plansOf(db, ctx), ctx.seqs) ? [{ step: "embed", params: {} }] : []),
  },
  {
    // Scans (local vectors) need no model; a pair check needs a Task Runner, also for its Jev half.
    name: "dupes",
    detect: async (db, ctx) => ((await servable(db, ctx, "dupes", "dupes", (p) => !!p.action.params?.scan)).length ? [{ step: "dupes", params: {} }] : []),
  },
  {
    // Each duplicate group is compared once its pairs are checked.
    name: "dupes-compare",
    // A set settled by rule (a closed member, a lone member) needs no model; the others need a Task Runner.
    detect: async (db, ctx) => ((await servable(db, ctx, "dupes-compare", "dupes-compare", (p) => p.facts.inCompareSet === "rule")).length ? [{ step: "dupes-compare", params: {} }] : []),
  },
  {
    // One repo per job, round robin; the repo's checks come before its review.
    name: "review",
    perRepo: true,
    detect: async (db, ctx) => {
      const due = await planned(db, "review", { plans: await plansOf(db, ctx) });
      // A PR waiting out the minimum time between reviews, the conflict merge cap or the backoff of an unsent comment is planned again when it ends.
      for (const p of (await plansOf(db, ctx)).prs) {
        const f = p.facts;
        for (const t of [f.reviewHold?.until, f.conflict?.until, f.fixup?.unsent, f.cifix?.unsent]) {
          const at = typeof t === "object" ? t.until : t;
          if (typeof at === "number") ctx.wake?.push(at);
        }
      }
      // No other stage re-reads the checks of a head that was stored as running or red: a PR whose review waits for CI has its repo's checks read again, at most once per WAITING_CI_RECHECK_MS.
      const ciWait = new Set((await plansOf(db, ctx)).prs.filter((p) => p.facts.reviewHold?.kind === "ci" && !p.facts.reviewHold.red && p.plan.wait === p.facts.reviewHold.wait).map((p) => p.facts.repo));
      const fresh = new Map(await mapSeq(ctx.tracked, async (repo) => {
        const checks = await lastJobEnd(db, "checks", repo);
        return [repo, checks?.state === "done" && Date.now() - Date.parse(checks.endedAt) < CHECKS_FRESH_MS] as const;
      }));
      const order = flightFirst(await plansOf(db, ctx), roundRobin(ctx.tracked, await cursorOf(db, ctx, "review")));
      const out: Candidate[] = laneCandidates("opus-review", order, due.map(laneDue), (params, refs) => {
        const review = { step: "opus-review", params, refs };
        return fresh.get(String(params.repo)) ? review : { step: "checks", params: { repo: params.repo! }, poll: true, gate: review };
      });
      // A repo whose waiting heads have all been pending for more than an hour is read every 5 minutes instead.
      const waiting = (await plansOf(db, ctx)).prs.filter((p) => ciWait.has(p.facts.repo) && p.facts.reviewHold?.kind === "ci" && !p.facts.reviewHold.red);
      const updated = new Map([...(waiting.length ? await loadItems(db, waiting.map((p) => ({ repo: p.facts.repo, number: p.facts.number })), "pr") : new Map()).values()].map((r) => [`${r.repo}#${r.number}`, r.updated_at] as const));
      const young = new Set(waiting.filter((p) => { const u = updated.get(`${p.facts.repo}#${p.facts.number}`); return !!u && Date.now() - Date.parse(u) <= 3600_000; })
        .map((p) => p.facts.repo));
      for (const repo of [...ciWait].sort()) {
        if (out.some((c) => c.params.repo === repo)) continue;
        const last = await lastJobEnd(db, "checks", repo);
        const gap = young.has(repo) ? WAITING_CI_RECHECK_MS : 5 * 60_000;
        if (last && Date.now() - Date.parse(last.endedAt) < gap) {
          ctx.wake?.push(Date.parse(last.endedAt) + gap);
          continue;
        }
        out.push({ step: "checks", params: { repo }, poll: true });
      }
      return out;
    },
    topScore: async (db, ctx) => {
      const top = firstByRepo(await planned(db, "review", { plans: await plansOf(db, ctx) }));
      return bestScore(ctx.tracked.map((repo) => top.get(repo)?.facts.score));
    },
    chosen: async (db, c) => {
      if (c.step === "opus-review" && lanePrOf(c.params) === null) await saveLaneState(db, [{ kind: "cursor", step: "review", value: String(c.params.repo) }]);
    },
  },
  {
    name: "labels",
    perRepo: true,
    detect: async (db, ctx) => {
      if (!ctx.run) return [];
      const repos = new Set((await plannedItems(db, "label", { plans: await plansOf(db, ctx) })).map((p) => p.facts.repo));
      // A repo whose GitHub write budget is used up would label nothing (the writes are refused as paced): it waits for the window to move.
      const now = Date.now();
      const waits = await pipelineWriteWaits(db, "labels-apply", ctx.tracked.filter((r) => repos.has(r)), now);
      return ctx.tracked.filter((repo) => {
        const wait = waits.get(repo);
        if (wait === undefined) return false;
        if (wait <= PACE_MAX_WAIT_MS) return true;
        ctx.wake?.push(now + wait);
        if (ctx.notes) ctx.notes["labels-apply"] ??= `The GitHub write budget for ${repo} is used up until ${hhmm(now + wait)}`;
        return false;
      }).map((repo) => ({ step: "labels-apply", params: { repo } }));
    },
  },
  {
    // Batches in flight and PRs waiting for CI are external waits: they are read again every WAITING_CI_RECHECK_MS, on unchanged inputs too.
    name: "merge",
    perRepo: true,
    topics: TASK_TOPICS,
    // A publish backoff ending changes no row: its end is part of the input, so the job runs again then.
    extra: async (db) => {
      const now = Date.now();
      return [...await publishBackoffs(db, new Date(now))].map(([repo, at]) => `${repo}:${at}:${at > now ? "on" : "over"}`).sort().join(",");
    },
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx);
      // The merge queue: PRs with a queue state (merged ones too) whose merge is approved, by a person or by the repo.
      const queue = plans.prs.filter((p) => p.facts.ghState !== "CLOSED" && isQueueState(p.plan.state) && mergePermission(p.facts).ok)
        .map((p) => ({ repo: p.facts.repo, number: p.facts.number, state: p.plan.state, eligible: p.plan.eligible }));
      const due = new Set((await planned(db, "merge", { plans })).map((p) => p.facts.repo));
      const batches = await batchesDue(db);
      // A repo whose last batches could not be published starts no batch until its backoff ends (single merges go on): the planner wakes then.
      for (const at of due.size ? (await publishBackoffs(db, new Date(), [...due])).values() : []) ctx.wake?.push(at);
      const out: Candidate[] = [];
      // No other stage refreshes a PR that waits only for CI or for GitHub to compute its mergeable state: a queue entry waiting for CI, a PR
      // whose approved merge waits in ci for CI the stored checks do not settle (src/preapproval), or a red head due for its comparison with a red main. A due merge job reads only the PRs it merges,
      // so these are read whatever else the repo has going on; the members of a due batch are left to its merge job, which reads them with the batch PR.
      const ciWaits = new Map<string, Set<string>>();
      const waits = (repo: string, number: number): void => {
        const ref = `${repo}#${number}`;
        if (!batches.get(repo)?.has(ref)) ciWaits.set(repo, (ciWaits.get(repo) ?? new Set()).add(ref));
      };
      for (const e of queue) if (e.state === "waiting-ci") waits(e.repo, e.number);
      for (const p of plans.prs) if (p.facts.ghState === "OPEN" && p.facts.operator?.ciWait) waits(p.facts.repo, p.facts.number);
      // A red head due for its comparison with a red main (src/mainci/no-new.ts), in any queue state: the checks job makes it.
      for (const p of plans.prs) if (p.facts.ghState === "OPEN" && p.facts.vsMain && "comparing" in p.facts.vsMain && p.facts.vsMain.at === null) waits(p.facts.repo, p.facts.number);
      // A merge job that advanced a batch runs again at once; one that only watched waits.
      const later = async (step: string, repo: string): Promise<boolean> => {
        const last = await lastJobEnd(db, step, repo);
        if (last && (step === "checks" || wasIdle(last)) && Date.now() - Date.parse(last.endedAt) < WAITING_CI_RECHECK_MS) {
          ctx.wake?.push(Date.parse(last.endedAt) + WAITING_CI_RECHECK_MS);
          const n = ciWaits.get(repo)?.size ?? 0;
          (ctx.notes ??= {})[step] = n ? `waiting for CI on ${n} PR${n === 1 ? "" : "s"} in ${repo}` : `waiting for the batch PR's CI in ${repo}`;
          return true;
        }
        return false;
      };
      for (const repo of flightFirst(plans, [...new Set([...due, ...batches.keys()])].sort())) {
        const poll = batches.has(repo);
        if (poll && await later("merge", repo)) continue;
        // A batch its repo left behind is closed wherever the repo is tracked.
        out.push({ step: "merge", params: { repo }, ...(poll ? { poll, scope: "cleanup" as const } : {}) });
      }
      const waiting = (await filterSeq([...ciWaits.keys()], async (repo) => !await later("checks", repo))).sort();
      for (const repo of waiting) out.push({ step: "checks", params: { repo }, poll: true, gate: { step: "merge", params: { repo }, poll: true } });
      // A push no running job is at any more: its PR's head, read with the checks, tells what became of it (src/prepush/settle.ts).
      const pushing = plans.prs.filter((p) => p.facts.pushing);
      const held = pushing.length ? await loadHeldLeaseKeys(db) : new Set<string>();
      const stopped = new Set(pushing.filter((p) => !held.has(prLease(p.facts.repo, p.facts.number))).map((p) => p.facts.repo));
      for (const repo of [...stopped].sort()) if (!waiting.includes(repo) && !await later("checks", repo)) out.push({ step: "checks", params: { repo }, poll: true });
      return out;
    },
  },
  {
    // The closes people asked for, queued card presses and held follow-up issues.
    name: "act",
    perRepo: true,
    scope: "cards",
    // Queued card presses: the drain runs when the first press fits under the daily limit, so the room (and the limit) is part of the input.
    extra: async (db) => {
      const [h, { sig: held }, limit] = await db.together(() => Promise.all([queueHead(db), heldDue(db), actLimit(db)]));
      return [h ? `queue:${h.fits ? 1 : 0}:${limit ?? "n"}` : "", held ? `${held}:${limit ?? "n"}` : ""].filter(Boolean).join("|");
    },
    detect: async (db, ctx) => {
      // Repos in the order of their best close: workflow weight, then repos that Act served least recently (so one busy repo does not keep the shared daily limit), then the oldest command.
      const best = new Map<string, { weight: number; at: string }>();
      for (const p of await plannedItems(db, "act", { plans: await plansOf(db, ctx) })) {
        const c = p.facts.close, b = best.get(p.facts.repo);
        if (c && (!b || c.weight > b.weight || (c.weight === b.weight && c.at < b.at))) best.set(p.facts.repo, { weight: c.weight, at: c.at });
      }
      const first = { weight: Infinity, at: "" }, repos = reposFor(ctx, "cards");
      const [approved, head, wakes, held] = await db.together(() => Promise.all([approvedRepos(db, repos, "comment"), queueHead(db), filingWakes(db), heldDue(db)]));
      // The press at the head of the queue is carried out by the job of its repo once it fits; until then the planner wakes at the next UTC midnight, when room returns.
      if (head && !head.fits) ctx.wake?.push(nextUtcMidnight(Date.now()));
      else if (head && approved.has(head.repo)) best.set(head.repo, first);
      // Follow-up issues held until a PR merged: filed by the job of the PR's repo once it merged, dropped once it closed or its merge path ended.
      // A row a stopped create left in `filing` is settled from its audit row once it is old enough: wake then.
      ctx.wake?.push(...wakes);
      for (const [repo, fits] of held.repos) {
        if (!fits) ctx.wake?.push(nextUtcMidnight(Date.now()));
        else if (approved.has(repo)) best.set(repo, first);
      }
      const served = new Map(await mapSeq(repos, async (repo) => [repo, (await lastJobEnd(db, "act", repo))?.endedAt ?? ""]));
      const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
      return repos.filter((repo) => best.has(repo)).sort((a, b) => {
        const x = best.get(a)!, y = best.get(b)!;
        return (x.weight === y.weight ? 0 : x.weight > y.weight ? -1 : 1) || cmp(served.get(a)!, served.get(b)!) || cmp(x.at, y.at) || a.localeCompare(b);
      }).map((repo) => ({ step: "act", params: { repo } }));
    },
  },
  {
    name: "fixup",
    perRepo: true,
    // A stored patch is collected when its lint task ends.
    topics: TASK_TOPICS,
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx);
      // Each planned action is judged on its own PR: a person's fix-up runs whatever the repo approves.
      const due: LaneDue[] = [], failed: unknown[] = [];
      const approved = new Set(plans.prs.filter((p) => ownLane(p.facts)).map((p) => `${p.facts.repo}#${p.facts.number}`));
      const heads = new Map(plans.prs.map((p) => [`${p.facts.repo}#${p.facts.number}`, p.facts.head] as const));
      for (const repo of ctx.tracked) {
        try {
          const sel = await selectFixups(db, repo, ctx.run, plans, "pipeline");
          for (const c of [...sel.fix, ...sel.lint, ...sel.conflictMerge, ...sel.ask, ...sel.conflictAsk]) due.push({ repo, number: c.number, approved: approved.has(`${repo}#${c.number}`), head: heads.get(`${repo}#${c.number}`) ?? null });
        } catch (e) {
          // A repo whose selection fails leaves the lane to the others; a failure of every repo is the lane's own.
          failed.push(e);
          if (failed.length === ctx.tracked.length) throw e;
          console.error(`autopilot: fixup: ${repo}: ${(e as Error).message}`);
          (ctx.notes ??= {}).fixup ??= `the fix-ups of ${repo} could not be selected: ${(e as Error).message}`;
        }
      }
      return laneCandidates("fixup", flightFirst(plans, [...ctx.tracked].sort()), due);
    },
  },
  {
    // One repo per job, round robin; the repo's checks come before its planning. The job's refs are the repo's PRs it would plan, in
    // its own selection order (src/verify/select.ts), at most as many as one job's limit allows, those a Task Runner takes first, as the job plans them.
    // PRs Verify cannot build are recorded without a call, so a repo with only those carries no refs.
    name: "verify",
    perRepo: true,
    topics: TASK_TOPICS,
    detect: async (db, ctx) => {
      const out: Candidate[] = [];
      const plans = await plansOf(db, ctx);
      const toPlan = new Map<string, ItemRef[]>(), unavailable = new Set<string>();
      for (const p of await planned(db, "verify", { plans, bucket: "plan" })) (toPlan.get(p.facts.repo) ?? toPlan.set(p.facts.repo, []).get(p.facts.repo)!).push({ repo: p.facts.repo, number: p.facts.number });
      for (const p of await planned(db, "verify", { plans, bucket: "unavailable" })) unavailable.add(p.facts.repo);
      const most = limitMax("verify"), untaken = (ctx.untaken ??= await untakenTest(db));
      const takenFirst = async (refs: ItemRef[]): Promise<ItemRef[]> => {
        const taken = new Set(await filterSeq(refs, async (r) => await untaken({ step: "verify", repo: r.repo, refs: [r] }) === null));
        return [...refs.filter((r) => taken.has(r)), ...refs.filter((r) => !taken.has(r))];
      };
      for (const repo of flightFirst(plans, roundRobin(ctx.tracked, await cursorOf(db, ctx, "verify")))) {
        if (!toPlan.has(repo) && !unavailable.has(repo)) continue;
        const checks = await lastJobEnd(db, "checks", repo);
        const fresh = checks?.state === "done" && Date.now() - Date.parse(checks.endedAt) < CHECKS_FRESH_MS;
        const due = toPlan.get(repo);
        // PRs a Task Runner takes first, as the job plans them, so a taken one is always among the refs the gate tests.
        const refs = due && (due.length > most ? (await takenFirst(due)).slice(0, most) : due);
        const verify = { step: "verify", params: { repo }, ...(refs ? { refs } : {}) };
        out.push(fresh ? verify : { step: "checks", params: { repo }, poll: true, gate: verify });
      }
      return out;
    },
    chosen: async (db, c) => {
      if (c.step === "verify") await saveLaneState(db, [{ kind: "cursor", step: "verify", value: String(c.params.repo) }]);
    },
  },
  {
    name: "verify-collect",
    topics: TASK_TOPICS,
    detect: async (db) => (await collectDue(db) ? [{ step: "verify-collect", params: {} }] : []),
  },
  {
    // Our own build of PR heads (pr-builds feature): queues new builds and collects finished ones, no model call. Off: no repo is detected.
    name: "pr-build",
    perRepo: true,
    topics: TASK_TOPICS,
    detect: async (db, ctx) => {
      return (await prBuildsDue(db, ctx.tracked)).sort().map((repo) => ({ step: "pr-build", params: { repo } }));
    },
  },
  {
    // One queued issue per job: plan (and build in the same job when the plan is ready), build from a stored plan, or revise our PR.
    name: "implement",
    perRepo: true,
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx), work = await implementWork(db, ctx.tracked, plans);
      return flightFirst(plans, [...work.keys()].sort())
        .map((repo) => { const j = work.get(repo)!; return { step: "implement", params: { repo, number: j.number, bucket: j.bucket } }; });
    },
    topScore: async (db, ctx) => bestScore([...(await implementWork(db, ctx.tracked, await plansOf(db, ctx))).values()].map((j) => j.score)),
    // AutoCraft's own retry of a stopped implementation falls due with no input changing: the lane runs again at its time, also
    // after an idle job (start-retry.ts).
    extra: async (db) => [...(await loadDueOwnRetries(db, Date.now()))].sort(([a], [b]) => a.localeCompare(b)).map(([repo, at]) => `${repo}=${at}`).join(","),
  },
  {
    // The issue reviews a maintainer asked for: one job per repo works every due issue of it.
    name: "issue-review",
    perRepo: true,
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx);
      const repos = new Set((await plannedItems(db, "issue-review", { plans })).map((p) => p.facts.repo));
      return flightFirst(plans, [...repos].sort()).map((repo) => ({ step: "issue-review", params: { repo } }));
    },
  },
  {
    // Their review comments and questions to reporters: no model call, so no Task Runner holds them.
    name: "issue-review-post",
    perRepo: true,
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx);
      const repos = new Set((await plannedItems(db, "issue-review-post", { plans })).map((p) => p.facts.repo));
      return flightFirst(plans, [...repos].sort()).map((repo) => ({ step: "issue-review-post", params: { repo } }));
    },
  },
  {
    // Label disagreements outside the scope labels, after Jev and Haiku have both answered.
    name: "referee",
    detect: async (db, ctx) => {
      // An item whose Opus call failed is asked again once its backoff ends.
      if (ctx.run) for (const at of await loadRefereeFailureTimes(db, ctx.run, new Date(Date.now() - REFEREE_RETRY_MS).toISOString())) ctx.wake?.push(Date.parse(at) + REFEREE_RETRY_MS);
      return ctx.run && (await servable(db, ctx, "referee", "referee")).length ? [{ step: "referee", params: {} }] : [];
    },
  },
  {
    // A review carried to our checked fix-up needs no model, so this runs while Claude is paused.
    name: "review-carry",
    perRepo: true,
    detect: async (db, ctx) => {
      const due = new Set((await planned(db, "carry", { plans: await plansOf(db, ctx) })).map((p) => p.facts.repo));
      return ctx.tracked.filter((repo) => due.has(repo)).sort().map((repo) => ({ step: "review-carry", params: { repo } }));
    },
  },
  {
    // The final Opus reviews, posted as one PR review each in repos approved for comments.
    name: "review-post",
    perRepo: true,
    detect: async (db, ctx) => {
      const due = new Set((await planned(db, "post-review", { plans: await plansOf(db, ctx) })).map((p) => p.facts.repo));
      return ctx.tracked.filter((repo) => due.has(repo)).sort().map((repo) => ({ step: "review-post", params: { repo } }));
    },
  },
  {
    // Operator messages in conversations; answered whether or not the item's repo is in scope, since an operator started them.
    name: "conversation",
    detect: async (db) => ((await pendingConversations(db, undefined, "operator")).length ? [{ step: "conversation", params: {} }] : []),
  },
  {
    // Maintainers' messages, each on the maintainer's own Task Runner: apart from the operators' lane and its daily limit. A job
    // whose messages none of their runners took in time gives them back and handled nothing; the lane then runs again when a
    // message is added or answered, or a waiting maintainer's runners take or end a call (or report ready, the taker signature),
    // not on the claim and release its own job wrote.
    name: "conversation-maintainer",
    topics: [],
    extra: async (db) => {
      const waiting = await pendingConversations(db, undefined, "maintainer");
      const logins = [...new Set(waiting.map((c) => c.login.toLowerCase()))].sort();
      return `${waiting.map((c) => c.turnId).join(",")}|${(await Promise.all(logins.map(async (l) => `${l}:${await leaseTurnover(db, l)}`))).join(",")}`;
    },
    detect: async (db) => ((await pendingConversations(db, undefined, "maintainer")).length ? [{ step: "conversation-maintainer", params: {} }] : []),
  },
  {
    // Runs GitHub holds for approval on reviewed outside PRs; the checks job records them, the step approves.
    name: "ci-approve",
    perRepo: true,
    detect: async (db, ctx) => {
      const due = await ciApproveRepos(db, await plansOf(db, ctx), ctx.run);
      return ctx.tracked.filter((repo) => due.has(repo)).sort().map((repo) => ({ step: "ci-approve", params: { repo } }));
    },
  },
  {
    // Failing gate checks of wanted PRs: the log is read, a formatter run is queued or collected, or a patch is written and pushed.
    name: "cifix",
    perRepo: true,
    topics: TASK_TOPICS,
    detect: async (db, ctx) => {
      // A stored patch whose lint task ended is collected by the same step.
      const plans = await plansOf(db, ctx);
      const buckets = ["work", "collect", "ask", "capped"];
      const due = [...(await planned(db, "cifix", { plans })).filter((p) => buckets.includes(String(p.action.params?.bucket))), ...await planned(db, "lint", { plans, bucket: "cifix" })];
      return laneCandidates("cifix", flightFirst(plans, [...ctx.tracked].sort()), due.map(laneDue));
    },
  },
  {
    // The planner decides which items left the path to merge; this lane only carries out the unassign actions, in every tracked repo: an item leaves the scope with its repo.
    name: "unassign",
    perRepo: true,
    scope: "cleanup",
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx), repos = new Set(reposFor(ctx, "cleanup"));
      const due = [...await planned(db, "unassign", { plans }), ...await plannedItems(db, "unassign", { plans })];
      return [...new Set(due.map((p) => p.facts.repo))].filter((r) => repos.has(r)).sort().map((repo) => ({ step: "unassign", params: { repo } }));
    },
  },
  {
    // One status comment per PR, in repos with the PR status switch on, and per item a person started or approved in any repo: queued
    // when the item's status line differs from the posted one.
    // Every tracked repo, not only those in scope: comments already posted get their last Merged or Closed edit after the repo's Pipeline is switched off.
    name: "pr-status",
    perRepo: true,
    scope: "cleanup",
    // A PR's failure backoff ends with the clock, not with a change in the data.
    extra: async (db) => await statusRetriesDue(db),
    detect: async (db, ctx) => {
      const now = Date.now();
      const [repos, approved] = await db.together(() => Promise.all([ctx.scopes ? reposFor(ctx, "cleanup") : trackedNames(db), approvedRepos(db, "all", "prstatus")]));
      const [retries, dueIn, waits] = await db.together(() => Promise.all([statusRetriesAt(db, repos, now), statusDueIn(db, repos, now, approved), pipelineWriteWaits(db, "pr-status-comment", repos, now)]));
      for (const at of retries.values()) ctx.wake?.push(at);
      return repos.filter((repo) => {
        if (!dueIn.get(repo)?.length) return false;
        // A repo whose GitHub write budget is used up would write nothing (the writes are refused as paced): it waits for the window to move.
        const wait = waits.get(repo)!;
        if (wait <= PACE_MAX_WAIT_MS) return true;
        ctx.wake?.push(now + wait);
        if (ctx.notes) ctx.notes["pr-status"] ??= `The GitHub write budget for ${repo} is used up until ${hhmm(now + wait)}`;
        return false;
      }).sort().map((repo) => ({ step: "pr-status", params: { repo } }));
    },
  },
  {
    name: "cifix-rerun",
    perRepo: true,
    detect: async (db, ctx) => (await cifixRepos(db, ctx, ["rerun"])).map((repo) => ({ step: "cifix-rerun", params: { repo } })),
  },
  {
    // The adversarial review of each PR head the merge rule would merge; the queue holds the PR until it is stored.
    name: "premerge",
    perRepo: true,
    detect: async (db, ctx) => {
      const due = await premergeCandidates(db, { plans: await plansOf(db, ctx), by: "pipeline", ...(ctx.wake ? { wake: ctx.wake } : {}) });
      return laneCandidates("premerge", [...ctx.tracked].sort(), due.map(laneDue));
    },
  },
  {
    // What the reviews of a PR approved for merge found that does not stop it becomes its follow-up issue, before it merges.
    name: "premerge-followups",
    perRepo: true,
    detect: async (db, ctx) => {
      const due = new Set((await planned(db, "followups", { plans: await plansOf(db, ctx) })).map((p) => p.facts.repo));
      return ctx.tracked.filter((repo) => due.has(repo)).sort().map((repo) => ({ step: "premerge-followups", params: { repo } }));
    },
  },
  {
    // Opus reviews what the pipeline's merges landed, also where the Pipeline switch is off; reads only, so it needs no repo approval.
    name: "postmerge",
    perRepo: true,
    scope: "cleanup",
    detect: async (db, ctx) => {
      const due = new Set(await postmergeRepos(db, await plansOf(db, ctx), Date.now(), ctx.run));
      return reposFor(ctx, "cleanup").filter((repo) => due.has(repo)).sort().map((repo) => ({ step: "postmerge", params: { repo } }));
    },
  },
  {
    // The defects of those reviews become issues in repos approved for comments. A row a stopped create left in `filing` is settled from its audit row once it is old enough: wake then.
    name: "postmerge-file",
    perRepo: true,
    scope: "cleanup",
    detect: async (db, ctx) => {
      const tracked = reposFor(ctx, "cleanup"), { wake } = ctx;
      const [defects, stuck, approved] = await db.together(() => Promise.all([pendingDefects(db), stuckFilings(db, { now: Date.now() }), approvedRepos(db, tracked, "comment")]));
      wake?.push(...stuck.wakes);
      const pending = new Set([...defects.map((d) => d.repo), ...stuck.due.map((x) => x.row.repo)]);
      return tracked.filter((repo) => approved.has(repo) && pending.has(repo)).sort().map((repo) => ({ step: "postmerge-file", params: { repo } }));
    },
  },
  {
    // A red default branch in a repo approved for it: flaky failures are rerun once, code failures are recorded.
    name: "main-fix",
    perRepo: true,
    // A rerun waits for the next reading of the head or a time limit, and a failure log not readable yet is read again after the
    // next main CI poll; the clock moves with no change in the data.
    extra: async (db) => await mainFixClock(db, Date.now()),
    detect: async (db, { tracked, wake }) => (await mainFixDueRepos(db, tracked, wake ? { wake } : {})).sort().map((repo) => ({ step: "main-fix", params: { repo } })),
  },
  {
    // The nightly checks of repos with the build feature on: queued once a day per repo (in data, from the last run's time), collected when their tasks end.
    name: "nightly",
    perRepo: true,
    // The day's schedule moves with the clock, not with a change in the data.
    extra: async (db) => ((await featureRepos(db, "nightly")).length ? String(Math.floor(Date.now() / 3_600_000)) : ""),
    detect: async (db, { tracked }) => (await nightlyRepos(db, tracked)).map((repo) => ({ step: "nightly", params: { repo } })),
  },
  {
    // The hourly self-evaluation of AutoCraft's own records, while the setting eval_repo names a tracked repo (also one whose Pipeline switch is off).
    name: "eval",
    topics: [],
    // Every tracked repo: the eval repo's Pipeline switch is usually off (its merges wait for a maintainer).
    scope: "cleanup",
    // The hour moves with the clock, not with a change in the data.
    extra: async (db) => ((await evalRepo(db)) ? String(Math.floor(Date.now() / 300_000)) : ""),
    detect: async (db, ctx) => {
      const repo = await evalRepo(db);
      if (!repo) return [];
      const last = (await loadLastJobPerStep(db, ["eval"])).get("eval");
      const due = last ? Date.parse(last.requested_at) + EVAL_EVERY_MS : 0;
      if (due > Date.now()) { ctx.wake?.push(due); return []; }
      return [{ step: "eval", params: { repo } }];
    },
  },
];

export const LANES: Lane[] = buildLanes(LANE_CODE);

/** Every registry lane needs its code and every code entry a registry lane; a mismatch is a programming error. */
export function buildLanes(code: Omit<Lane, "steps">[]): Lane[] {
  const reg = lanesInOrder();
  const names = new Set(reg.map((l) => l.name));
  const missing = reg.filter((l) => !code.some((c) => c.name === l.name)).map((l) => l.name);
  const extra = code.filter((c) => !names.has(c.name)).map((c) => c.name);
  if (missing.length || extra.length) throw new Error(`autopilot lanes and the stage registry differ: no detect for [${missing}], no registry lane for [${extra}]`);
  return reg.map((l) => ({ ...code.find((c) => c.name === l.name)!, steps: l.steps }));
}

// ---- limits and usage ----------------------------------------------------------

export const dayStart = (ms: number = Date.now()): string => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

type LimitRow = { step: string; perDay: number | null };

/** Daily limits that apply until an operator sets one. */
export const DEFAULT_PER_DAY: Record<string, number> = defaultPerDay();

export const limitRow = async (db: Db, step: string): Promise<LimitRow> =>
  (await readsOf(db)).limits.get(step) ?? { step, perDay: DEFAULT_PER_DAY[step] ?? null };

/** Items handled by the step's jobs that started today (UTC) and after the operator's last reset of its count; for Act, also the GitHub writes of conversation cards. */
export async function usageToday(db: Db, step: string, ms: number = Date.now()): Promise<number> {
  if (step === "act") {
    const pass = passOf(db);
    if (!pass) return await actUsedToday(db, ms);
    const day = dayStart(ms);
    if (!pass.act.has(day)) pass.act.set(day, await actUsedToday(db, ms));
    return pass.act.get(day)!;
  }
  return (await readsOf(db, ms)).inputs.usedToday.get(step) ?? 0;
}

/**
 * The part of its `limit` that each queued or running job of the step has not used yet: the day's limit keeps it for them.
 * A queued job that waits for a Task Runner (untakenTest) keeps none.
 */
export async function reservedByJobs(db: Db, step: string, untaken?: UntakenTest): Promise<number> {
  let n = 0;
  for (const r of (await readsOf(db)).inputs.live) {
    if (r.step !== step) continue;
    if (r.state === "queued" && await (untaken ??= await untakenTest(db))({ step, repo: r.repo, params: r.params })) continue;
    let limit: unknown;
    try { limit = (JSON.parse(r.params) as { limit?: unknown }).limit; } catch { continue; }
    if (typeof limit === "number") n += Math.max(0, limit - (r.items ?? 0));
  }
  return n;
}

/** The `limit` a job of the step may get (undefined when the step has none), or null when the day's limit leaves less than the step's minimum. `wanted` is a limit asked for (default: the step's). */
export async function jobLimit(db: Db, step: StepDef, ms: number = Date.now(), wanted?: number, untaken?: UntakenTest): Promise<{ limit?: number } | null> {
  const lp = step.params.find((p) => p.name === "limit" && p.kind === "int");
  if (!lp || lp.kind !== "int") return {};
  const perDay = (await limitRow(db, step.name)).perDay;
  const limit = Math.min(wanted ?? lp.default ?? lp.max, lp.max, perDay === null ? Infinity : perDay - await usageToday(db, step.name, ms) - await reservedByJobs(db, step.name, untaken));
  return limit < lp.min ? null : { limit };
}

/**
 * Why a command-line run of the step cannot start now, or null: the gate() rules of the planner that are not pacing
 * (a job of the step for the same repo is queued or running, the step already works its most repos, a running job
 * holds the step's mutex, the daily limit, a pause).
 */
export async function cliGate(db: Db, step: { name: string }, steps: Map<string, StepDef>, params: Params = {}, ms: number = Date.now()): Promise<string | null> {
  const busy = await jobBlock(db, steps, wantOf(step.name, params), { mutex: true });
  if (busy) return busy;
  return await pauseReason(db, step.name, ms, { backoff: false });
}

/** The steps an operator release (operator-actions.ts) or a resumed breaker, by its audit action, hands new work to. */
const RELEASE_STEPS: Record<string, string[]> = {
  "batch-again": ["merge"], "review-again": ["opus-review"], "verify-again": ["verify"], "stage-resume": Object.keys(STEP_STAGE),
};

/** When an operator last released work for the step, or null. */
async function releasedAt(db: Db, step: string): Promise<string | null> {
  const released = (await readsOf(db)).released;
  const times = Object.keys(RELEASE_STEPS).filter((a) => RELEASE_STEPS[a]!.includes(step)).flatMap((a) => released.get(a) ?? []);
  return times.length ? times.reduce((m, t) => (t > m ? t : m)) : null;
}

/** The least wait after a job stopped for running past its deadline. */
export const DEADLINE_BACKOFF_MS = 3600_000;

/**
 * Failed autopilot jobs of the step (of the repo, when given) since its last success: when it may run again, else null.
 * An operator release since the last failure ends it. After a single failure, so does a changed input (`fp` given and
 * different from the one the failed job saw); later failures wait out the backoff, because inputs that change every
 * minute would otherwise retry a failing step at once, every time. Jobs a runner restart ended, and jobs that failed only because a write was paced (it is retried later anyway), do not count.
 * Without `repo` it is the whole step's: each repo (and lane PR) keeps its own streak, and the step waits only while every one of them
 * that is live (its newest job failed, or it ran within STEP_LIVE_MS) does, until the first of them may run again; one repo that keeps
 * failing does not hold the others.
 */
export async function failureBackoff(db: Db, step: string, ms: number = Date.now(), o: { repo?: string | null; fp?: string; lane?: number | null } = {}): Promise<{ until: number; failures: number } | null> {
  const all = (await readsOf(db, ms)).inputs.streaks.filter((r) => r.step === step);
  if (o.repo !== undefined) {
    // The pipeline jobs of the step (of the repo, and the jobs without a lane or one lane PR's, when given).
    return await streakBackoff(db, step, ms, all.filter((r) => (o.repo === null || r.repo === o.repo) && (o.lane === undefined || r.lane_number === o.lane)), o);
  }
  const groups = new Map<string, StreakRow[]>();
  for (const r of all) { const k = `${r.repo ?? ""}#${r.lane_number ?? ""}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  let first: { until: number; failures: number } | null = null;
  for (const rows of groups.values()) {
    const newest = rows.reduce((a, b) => (b.id > a.id ? b : a));
    if (newest.state !== "failed" && ms - Date.parse(newest.ended_at ?? "") > STEP_LIVE_MS) continue;
    const b = await streakBackoff(db, step, ms, rows, { repo: newest.repo, lane: newest.lane_number });
    if (!b) return null;
    if (!first || b.until < first.until) first = b;
  }
  return first;
}

/** How recently a repo's job of a step must have run for a success there to keep the whole step out of its failure backoff. */
const STEP_LIVE_MS = 3600_000;

/** The backoff of one streak: `rows` are its jobs, any order (newest first, back to the first success, at most 12, are read). */
async function streakBackoff(db: Db, step: string, ms: number, streak: readonly StreakRow[], o: { repo?: string | null; fp?: string; lane?: number | null }): Promise<{ until: number; failures: number } | null> {
  const rows = [...streak].sort((a, b) => b.id - a.id).slice(0, 12);
  let failures = 0;
  while (failures < rows.length && rows[failures]!.state === "failed") failures++;
  if (!failures || !rows[0]!.ended_at) return null;
  const released = await releasedAt(db, step);
  if (released && released > rows[0]!.ended_at) return null;
  // A job stopped for its deadline did paid work that a rerun would repeat: a changed input does not end the wait.
  const stopped = DEADLINE_ERROR.test(rows[0]!.error ?? "");
  if (o.fp !== undefined && failures === 1 && !stopped) {
    const rec = await fpRecord(db, step, o.repo ?? null, o.lane ?? null);
    if (rec && rec.job === rows[0]!.id && rec.fp !== o.fp) return null;
  }
  const until = Date.parse(rows[0]!.ended_at) + (stopped ? Math.max(DEADLINE_BACKOFF_MS, failureDelayMs(failures)) : failureDelayMs(failures));
  return until > ms ? { until, failures } : null;
}

const hhmm = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/**
 * Why the stage cannot start jobs now and when that can lift by itself (null: only a write lifts it, such as a limit change), or null when it is not paused.
 * A circuit breaker pauses no step: it refuses the actions that push or merge (gates.ts), and the step's asks and bookkeeping run.
 */
export async function pauseOf(db: Db, step: string, ms: number = Date.now(), o: { backoff?: boolean } = {}): Promise<{ why: string; wakeAt: number | null } | null> {
  const l = await limitRow(db, step), used = await usageToday(db, step, ms);
  if (l.perDay === 0) return { why: "paused: the daily limit is 0", wakeAt: null };
  if (l.perDay !== null && used >= l.perDay) return { why: `daily limit of ${l.perDay} items reached; resumes at 00:00 UTC`, wakeAt: nextUtcMidnight(ms) };
  const b = o.backoff === false ? null : await failureBackoff(db, step, ms);
  if (b !== null) return { why: `failed ${b.failures} time${b.failures === 1 ? "" : "s"} in a row; retry at ${hhmm(b.until)}`, wakeAt: b.until };
  return null;
}

/** Why the stage cannot start jobs now, or null. The one place a stage's pause is decided. */
export const pauseReason = async (db: Db, step: string, ms: number = Date.now(), o: { backoff?: boolean } = {}): Promise<string | null> => (await pauseOf(db, step, ms, o))?.why ?? null;

// ---- state ---------------------------------------------------------------------

/** On: the planner queues jobs and the runner starts them. Draining and off are both not enabled. */
export const isEnabled = async (db: Db): Promise<boolean> => (await freshConfig(db, [KEY_ENABLED])).pipelineEnabled;
/** Draining: like off for new work, but the writes of jobs already running go through. */
export const isDraining = async (db: Db): Promise<boolean> => (await freshConfig(db, [KEY_ENABLED])).pipelineDraining;

export async function setEnabled(db: Db, enabled: boolean, by: string, mode: "off" | "drain" = "off"): Promise<void> {
  await db.write(async () => {
    await saveSettings(db, [{ key: KEY_ENABLED, value: enabled ? "1" : mode === "drain" ? PIPELINE_DRAIN : "0" }, { key: KEY_BY, value: by }, { key: KEY_AT, value: now() }], by);
    // Automatic jobs still waiting are dropped; running ones finish.
    if (!enabled) {
      const waiting = await markCancelQueued(db, { pipelineOnly: true }, by);
      const resuming = waiting.filter((j) => Number(j.resumes) > 0).map((j) => j.id);
      if (resuming.length) await dropJobCalls(db, "The job was cancelled.", resuming);
      await addAudit(db, waiting.map((j) => ({ login: by, action: "job-cancel", target: `job:${j.id}`, details: { step: j.step, state: "queued", reason: "pipeline switched off" } })));
    }
    // Turning on plans at once; the sync that already happened is not new.
    if (enabled) await removeLaneState(db, [{ kind: "mark", step: MARK_PLANNED_AT }]);
  });
}

/** Jobs the runner stopped for running past their step's limit that nobody has acknowledged and no later job of the step has beaten. */
export async function deadlineStops(db: Db): Promise<DeadlineStop[]> {
  return await loadDeadlineStops(db);
}

/** An operator acknowledges the deadline stops of a step: they leave the warnings until the next one. */
export async function ackDeadline(db: Db, step: string, by: string): Promise<void> {
  await ackDeadlines(db, [step], by);
}

/** Steps that have a row in stage_limits, in pipeline order. */
export const LIMIT_STEPS = limitSteps();

/** Steps whose jobs cannot be sized to what remains of the day: only no limit or a pause makes sense. */
export const ZERO_ONLY = zeroOnlySteps();

export class LimitError extends Error {
  status = 400;
}

export async function setLimit(db: Db, step: unknown, input: unknown, by: string): Promise<{ perDay: number | null }> {
  if (typeof step !== "string" || !LIMIT_STEPS.includes(step)) throw Object.assign(new LimitError("no such stage"), { status: 404 });
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LimitError("the body must be a JSON object");
  const keys = Object.keys(input);
  if (keys.some((k) => k !== "perDay")) throw new LimitError("only perDay can be set");
  const perDay = (input as { perDay?: unknown }).perDay;
  if (perDay === undefined) throw new LimitError("perDay is required (null means no limit)");
  if (ZERO_ONLY.includes(step) && perDay !== null && perDay !== 0) throw new LimitError(`${step} cannot be sized by a daily limit: use none, or 0 to pause it`);
  if (perDay !== null && (typeof perDay !== "number" || !Number.isInteger(perDay) || perDay < 0 || perDay > 100_000)) throw new LimitError("perDay must be null or a whole number from 0 to 100000");
  await setStageLimit(db, step, perDay, by);
  return { perDay };
}

/** Starts today's count of one step (or of all) again from zero. */
export async function resetLimitCount(db: Db, step: unknown, by: string): Promise<{ steps: string[] }> {
  const steps = step === "all" ? LIMIT_STEPS : typeof step === "string" && LIMIT_STEPS.includes(step) ? [step] : null;
  if (!steps) throw Object.assign(new LimitError("no such stage"), { status: 404 });
  await resetLimitCounts(db, steps, now(), DEFAULT_PER_DAY, by);
  return { steps };
}

/** What a stage is doing now: running, queued, or why it is not (the planner's last reading); null when unknown. */
async function stepStatus(db: Db, step: string, why: string | undefined): Promise<string | null> {
  const jobs = (await readsOf(db)).inputs.live.filter((j) => j.step === step);
  const j = jobs.find((x) => x.state === "running") ?? jobs[0];
  return j ? j.state : why ?? null;
}

export async function stageLimits(db: Db): Promise<StageLimit[]> {
  const steps = await loadSteps(), ms = Date.now();
  const [reads, why, active, act] = await db.together(() => Promise.all([loadReads(db, ms), stageStatus(db), loadTrips(db, { active: true }), actUsedToday(db, ms)]));
  return await withPassReads(db, { reads, act: new Map([[dayStart(ms), act]]) }, async () => {
    const trips = [...active.values()].flatMap((t) => { const k = tripOf(t.stage); return k ? [{ ...t, tripStage: k.stage, repo: k.repo }] : []; });
    return await Promise.all(LIMIT_STEPS.map(async (step) => {
      const [l, usedToday, pausedReason, status] = await Promise.all([limitRow(db, step), usageToday(db, step), pauseReason(db, step), stepStatus(db, step, why[step])]);
      // canResume is the viewer's: the dashboard API sets it per request.
      const mine = trips.filter((t) => t.tripStage === STEP_STAGE[step]).map((t) => ({ key: t.stage, repo: t.repo, reason: t.reason, since: t.trippedAt, canResume: false }));
      return { step, title: steps.get(step)?.title ?? step, perDay: l.perDay, usedToday, pausedReason, ...(mine.length ? { trips: mine } : {}), status };
    }));
  });
}

export async function pipelineState(db: Db): Promise<Omit<PipelineState, "outside" | "blockers">> {
  const [live, marks, limits] = await db.together(() => Promise.all([loadLiveConfig(db), loadLaneState(db, ["mark"]), stageLimits(db)]));
  return {
    enabled: live.pipelineEnabled, draining: live.drain, changedBy: live.changedBy, changedAt: live.changedAt,
    heartbeat: marks.get("mark|heartbeat|")?.value ?? null, limits,
  };
}

// ---- planner -------------------------------------------------------------------

export type PlanOptions = {
  lanes?: Lane[]; nowMs?: number; log?: (line: string) => void;
  /** Keep facts between passes on this connection and reload only what changed (the runner's worker); AUTOCRAFT_PLAN_SHADOW=throw turns it on for every pass. */
  incremental?: boolean;
};

/** A job the detection pass wants queued; `params` include the `limit` the gate set. */
export type Proposal = { lane: string; step: string; params: Params; fp?: string; gate?: { step: string; params: Params } };
/** `wakeAt`: when a wait the pass found ends (ms), null when none. `status`: why each stage without a proposal is not starting. */
export type Detected = {
  proposals: Proposal[]; logs: string[]; wakeAt?: number | null; status?: Record<string, string>;
  /** Milliseconds the pass spent: loading and deciding the Plans, the lanes, writing the Plan cache; and the cache rows written and deleted. */
  timing?: { loadMs: number; lanesMs: number; cacheMs: number; written: number; deleted: number; pass?: string };
};

/** The fewest proposals one lane hands to apply: one per repo, in order, so that when the first is refused at enqueue (or the step is full at step_parallel) the next repo's goes in. */
const PROPOSALS_PER_LANE = 3;
/** Most item jobs (one PR nobody started each) one lane proposes in a pass. */
const ITEM_PROPOSALS_PER_LANE = 24;

const nextUtcMidnight = (ms: number): number => Date.parse(dayStart(ms)) + 86_400_000;

/**
 * Detection: loads and decides the Plans of every PR and item once, then returns, per lane, the candidates whose
 * step is idle, not backing off, not unchanged since a job that handled nothing, and has limit left. A lane is the
 * items whose Plan holds its action and where that action may run (mayRun). The only write is the Plan cache
 * (item_plans), so the runner can do it on another connection while it keeps polling; applyProposals() queues the result.
 * The order of the checks on a lane: a step of the lane can start (gate), the lane's items that may run,
 * the pipeline scope, then gate() per candidate: same-step job, pause and daily limit, failure backoff,
 * unchanged input, minimum gap.
 */
export async function detectAutopilot(db: Db, opts: PlanOptions = {}): Promise<Detected> {
  const steps = await loadSteps(), ms = opts.nowMs ?? Date.now();
  // One reading of the Task Runners for the pass: which repos' Claude jobs no runner may take.
  const untaken = await untakenTest(db, steps, ms);
  const [settings, reads, cap, takers, act, own] = await db.together(() => Promise.all([
    readSettingsSnapshot(db), loadReads(db, ms), stepParallel(db), loadTakerSignature(db, Date.now()), actUsedToday(db, ms), loadOwnLogins(db), untaken.load?.(),
  ]));
  // Every setting the pass reads comes from that reading of the table (planCtx reads it again in its snapshot).
  return await withSettingsSnapshot(db, async () => await withPassReads(db, { reads, takers, act: new Map([[dayStart(ms), act]]) }, async () => await detectPass(db, opts, steps, { untaken, cap, own })), Promise.resolve(settings));
}

async function detectPass(db: Db, opts: PlanOptions, steps: Map<string, StepDef>, read: { untaken: UntakenTest; cap: number; own: ReadonlySet<string> }): Promise<Detected> {
  const lanes = opts.lanes ?? LANES, ms = opts.nowMs ?? Date.now();
  const logs: string[] = [];
  const log = (l: string) => { logs.push(l); opts.log?.(l); };
  const proposals: Proposal[] = [];
  const t0 = performance.now();
  const { untaken, cap } = read;
  const ctx = await planCtx(db, opts.incremental === true || process.env.AUTOCRAFT_PLAN_SHADOW === "throw", read.own);
  ctx.detected = new Map();
  ctx.untaken = untaken;
  const loadMs = performance.now() - t0;
  const inScope = new Map<ScopeFor, Set<string>>();
  const scopeOf = (what: ScopeFor): Set<string> => { let s = inScope.get(what); if (!s) inScope.set(what, (s = new Set(reposFor(ctx, what)))); return s; };
  const seqs = ctx.seqs ?? await db.seqs();
  const status: Record<string, string> = {};
  // The queued and running jobs, read with the pass's other job reads.
  const live = (await readsOf(db, ms)).inputs.live;
  const active: Active[] = live.map((j) => ({ id: j.id, step: j.step, state: j.state, repo: j.repo, number: j.number, params: j.params }));
  ctx.marks = (await readsOf(db, ms)).inputs.marks;
  const perLane = Math.max(PROPOSALS_PER_LANE, Math.min(cap, 16));
  // Pause and limit do not change during the pass: one answer per step.
  const paused = new Map<string, string | null>();
  const limitLeft = new Map<string, { limit?: number } | null>();

  const pausedWhy = async (stepName: string): Promise<string | null> => {
    if (!paused.has(stepName)) {
      const p = await pauseOf(db, stepName, ms, { backoff: false });
      const why = p?.why ?? null;
      paused.set(stepName, why);
      if (p?.wakeAt != null) ctx.wake?.push(p.wakeAt);
    }
    return paused.get(stepName)!;
  };
  const note = (stepName: string, why: string) => { status[stepName] ??= why; };
  // The facts digest of each PR of the pass, for the fingerprints of per-item jobs and of repo jobs proposed for their items; made on first use.
  let sigs: Map<string, PrFacts> | null = null;
  const digests = new Map<string, string>();
  const digestOf = async (repo: string, number: number): Promise<string | undefined> => {
    const key = `${repo}#${number}`;
    if (!digests.has(key)) {
      sigs ??= new Map((await plansOf(db, ctx)).prs.map((p) => [`${p.facts.repo}#${p.facts.number}`, p.facts]));
      const f = sigs.get(key);
      if (!f) return undefined;
      digests.set(key, prSigOf(f));
    }
    return digests.get(key);
  };
  const prSig = async (params: Params): Promise<string | undefined> => {
    const n = lanePrOf(params);
    return n === null || typeof params.repo !== "string" ? undefined : await digestOf(params.repo, n);
  };
  const refsSig = async (refs: readonly ItemRef[] | undefined): Promise<string | undefined> => {
    if (!refs?.length) return undefined;
    const each = new Map(await mapSeq(refs, async (r) => [`${r.repo}#${r.number}`, await digestOf(r.repo, r.number)] as const));
    return refsSigOf(refs, (r) => each.get(`${r.repo}#${r.number}`));
  };

  /**
   * The job's `limit` (undefined when the step has none), or null when it cannot start now. With `lane`, the
   * input checks apply too: failure backoff and "nothing changed since a job that handled nothing".
   */
  const gate = async (stepName: string, params: Params, lane?: Lane, poll = false, precheck = false, refs?: readonly ItemRef[]): Promise<{ limit?: number } | null> => {
    const step = steps.get(stepName);
    if (!step) return null;
    const pending: Active[] = proposals.filter((p) => p.step === stepName).map((p) => ({ ...wantOf(p.step, p.params), id: 0, state: "proposed", number: typeof p.params.number === "number" ? p.params.number : null }));
    const repo0 = typeof params.repo === "string" ? params.repo : null;
    if (await jobBlock(db, steps, wantOf(stepName, params), { extra: pending, precheck, untaken, active, cap })) return null;
    const reason = await pausedWhy(stepName);
    if (reason) { note(stepName, reason); return null; }
    const waits = repo0 === null ? null : await untaken({ step: stepName, repo: repo0, params, ...(refs ? { refs } : {}) });
    if (waits !== null) { note(stepName, waits); return null; }
    if (lane) {
      const repo = typeof params.repo === "string" ? params.repo : null;
      const fp = await fingerprintOf(db, lane, stepName, params, seqs, await prSig(params), await refsSig(refs));
      const pr = lanePrOf(params);
      const b = await failureBackoff(db, stepName, ms, { repo, fp, lane: pr });
      if (b) {
        ctx.wake?.push(b.until);
        const where = repo === null ? "" : ` on ${pr === null ? repo : `${repo}#${pr}`}`;
        note(stepName, `failed ${b.failures} time${b.failures === 1 ? "" : "s"} in a row${where}; retry at ${hhmm(b.until)}`);
        const key = `${stepName}:${repo ?? ""}:${b.until}`;
        if (!warned.has(key)) { warned.add(key); log(`autopilot: ${stepName}: failed ${b.failures} times in a row${where}; retry at ${hhmm(b.until)}`); }
        return null;
      }
      const idle = poll ? null : await unchangedSinceIdle(db, stepName, repo, fp, { lane: pr, byRefs: refs !== undefined, topics: lane.topics ?? INPUT_TOPICS });
      if (idle) { note(stepName, idle); return null; }
      if (lane.minGapMs) {
        const last = await lastJobEnd(db, stepName, repo, AUTOPILOT_USER);
        const next = last ? Date.parse(last.endedAt) + lane.minGapMs : 0;
        if (next > ms) { ctx.wake?.push(next); return null; }
      }
    }
    if (!limitLeft.has(stepName)) limitLeft.set(stepName, await jobLimit(db, step, ms, undefined, untaken));
    return limitLeft.get(stepName)!;
  };

  // A lane whose steps cannot start is not worth detecting, but the Next lists still name its items.
  const closed = new Set<string>();
  for (const lane of lanes) {
    try {
      // A per-item step is open while its per-item jobs could start, also when a job without a lane cannot (step_parallel).
      if (lane.steps && !await someSeq(lane.steps, async (s) => !!await gate(s, {}, undefined, false, true) || (hasApprovedLane(steps.get(s)) && !!await gate(s, { lane: ITEM_LANE }, undefined, false, true)))) closed.add(lane.name);
    } catch (e) { closed.add(lane.name); log(`autopilot: ${lane.name}: ${(e as Error).message}`); }
  }
  // The lanes' reads and what the writes below compare with go out together. A read that fails here runs again by itself where it is used.
  const ahead = async <T>(p: Promise<T>): Promise<T | undefined> => { try { return await p; } catch { return undefined; } };
  const [storedLanes, storedPlans, liveness] = await db.together(() => Promise.all([
    opts.lanes ? undefined : ahead(loadLanes(db)), ahead(loadStoredPlans(db)), ahead(loadLivenessState(db)),
    ...lanes.filter((l) => !closed.has(l.name) || (!opts.lanes && LANE_KINDS[l.name])).map(async (l) => {
      await Promise.all([ahead(detectOf(db, ctx, l)), closed.has(l.name) ? undefined : ahead(extraOf(db, l.extra))]);
    }),
  ] as const));

  const tops = new Map<string, number | null>();
  for (const lane of lanes) {
    if (!lane.topScore) continue;
    try { tops.set(lane.name, await lane.topScore(db, ctx)); } catch (e) { log(`autopilot: ${lane.name}: ${(e as Error).message}`); }
  }
  for (const lane of orderLanes(lanes, tops)) {
    try {
      if (closed.has(lane.name)) continue;
      const candidates = await detectOf(db, ctx, lane);
      if (!candidates.length) { for (const s of lane.steps ?? []) note(s, "nothing to do"); continue; }
      let taken = 0, items = 0;
      for (const c of candidates) {
        // A job of a PR a person started or approved is proposed as soon as it is due. Item jobs have a budget of their own per pass,
        // so one pass does not queue a job for every due PR at once; ended jobs make the planner due, and the next pass adds more.
        const lanePr = c.gate?.params ?? c.params, item = lanePrOf(lanePr) !== null && !approvedLane(lanePr);
        if (item && items >= ITEM_PROPOSALS_PER_LANE) continue;
        const scope = scopeOf(c.scope ?? lane.scope ?? "work");
        const outside = [c, c.gate].find((x) => x && typeof x.params.repo === "string" && !scope.has(x.params.repo));
        if (outside) { note(outside.step, "outside the pipeline scope"); continue; }
        if (c.gate && !await gate(c.gate.step, c.gate.params, lane, c.gate.poll, false, c.gate.refs)) continue;
        const g = await gate(c.step, c.params, lane, c.poll, false, c.refs);
        if (!g) continue;
        // A lane PR's own job works one PR: it keeps no more of the daily limit than that.
        const limit = g.limit === undefined ? undefined : lanePrOf(c.params) !== null ? Math.min(g.limit, 1) : g.limit;
        const params: Params = { ...c.params, ...(limit === undefined ? {} : { limit }) };
        proposals.push({ lane: lane.name, step: c.step, params, fp: await fingerprintOf(db, lane, c.step, c.params, seqs, await prSig(c.params), await refsSig(c.refs)), ...(c.gate ? { gate: (({ refs: _, ...g }) => g)(c.gate) } : {}) });
        if (item) items++;
        else if (!approvedLane(lanePr) && ++taken >= perLane) break;
      }
    } catch (e) {
      log(`autopilot: ${lane.name}: ${(e as Error).message}`);
    }
  }
  // The lists the Next page shows come from the same pass, so the page needs no Plans of its own.
  let laneRows: LaneRow[] = [];
  if (!opts.lanes) {
    try { laneRows = await changedLanes(db, lanes, ctx, storedLanes); } catch (e) { log(`autopilot: next items: ${(e as Error).message}`); }
  }
  const lanesMs = performance.now() - t0 - loadMs;
  // The Plan cache: the planner's output for the dashboard. It is written with the Next lists and the pass's records in one transaction.
  let cache = { written: 0, deleted: 0 };
  const t1 = performance.now();
  try {
    const diff = await planCacheDiff(db, ctx.plans!, storedPlans);
    const write = async (): Promise<void> => {
      await saveLanes(db, laneRows, true);
      cache = await writePlanDiff(db, diff);
      await ctx.pass?.finish(performance.now() - t0);
    };
    if (laneRows.length || diff.changed || ctx.pass?.logged) await db.write(write);
    else await write();
  } catch (e) { log(`autopilot: plan cache: ${(e as Error).message}`); }
  const cacheMs = performance.now() - t1;
  // The liveness check follows the plan cache and stores its own result at most every few minutes.
  try { await refreshLiveness(db, Date.now(), false, liveness); } catch (e) { log(`autopilot: liveness: ${(e as Error).message}`); }
  const passKind = ctx.pass ? `${ctx.pass.kind}, ${ctx.pass.refs} loaded${ctx.pass.diffs.length ? `, ${ctx.pass.diffs.length} shadow differences` : ""}` : undefined;
  if (ctx.pass?.diffs.length) log(`autopilot: plan shadow: ${ctx.pass.diffs.length} differences (plan_shadow_diffs)`);
  if (loadMs + lanesMs + cacheMs > 2000) log(`autopilot: pass took ${Math.round(loadMs + lanesMs + cacheMs)} ms${passKind ? ` (${passKind})` : ""}: plans ${Math.round(loadMs)}, lanes ${Math.round(lanesMs)}, cache ${Math.round(cacheMs)} (${cache.written} rows written, ${cache.deleted} deleted)`);
  // A stage with a candidate the checks above held back says why; the others had no candidate or start now.
  Object.assign(status, ctx.notes ?? {});
  for (const p of proposals) delete status[p.step];
  const wakes = (ctx.wake ?? []).filter((t) => t > ms);
  return { proposals, logs, wakeAt: wakes.length ? Math.min(...wakes) : null, status, timing: { loadMs, lanesMs, cacheMs, ...cache, ...(passKind ? { pass: passKind } : {}) } };
}

/**
 * A job that acted on nothing and whose every handled item was skipped for want of a taker (its call withdrawn, or its pool unit
 * left unstarted): it did nothing either, so like an idle job it runs again only once its input or the Task Runners change.
 */
function onlyUntaken(j: { items: number | null; acted: number | null; lease_skips: number | null; lease_skip_keys: string | null }): boolean {
  if (j.acted || !j.lease_skips || (j.items ?? 0) > j.lease_skips || !j.lease_skip_keys) return false;
  try {
    const keys = (JSON.parse(j.lease_skip_keys) as string[]).filter((k) => !k.startsWith(UNITS_RAN));
    return keys.length > 0 && keys.every((k) => k.startsWith(NO_TAKER_SKIP));
  } catch { return false; }
}

/** The lease keys among a job's skip keys: null for a job from before the keys were recorded. */
function leaseSkipKeys(keys: string | null): string[] | null {
  if (!keys) return null;
  try { return (JSON.parse(keys) as string[]).filter((k) => !k.startsWith(NO_TAKER_SKIP) && !k.startsWith(UNITS_RAN)); } catch { return null; }
}

/** True when a running job holds a lease on one of the keys a job skipped (a job from before the keys were recorded: on any lease). */
async function skippedLeaseHeld(db: Db, keys: string[] | null): Promise<boolean> {
  const held = (await readsOf(db)).inputs.heldLeaseKeys;
  return keys === null ? held.size > 0 : keys.some((k) => held.has(k));
}

/**
 * The topics that move which items a person's Task Runner takes beyond its repos: the work they started or approved
 * (src/remote/started.ts). The taker signature names repos only, so their counters stand in for the items.
 */
const STARTED_TOPICS = ["workflows", "preapprovals"];

/**
 * The part of a fingerprint without a PR (fingerprintOf: step, repo, one counter per topic of `topics`, the extra reading, the taker
 * signature) that decides whether work left for want of a taker can run now: all of it but the counters outside STARTED_TOPICS.
 * Null for a fingerprint without that layout.
 */
function takerPartOf(fp: string, topics: readonly string[]): string | null {
  const parts = fp.split("|"), n = topics.length;
  if (parts.length < n + 4) return null;
  return [parts[0], parts[1], ...topics.flatMap((t, i) => (STARTED_TOPICS.includes(t) ? [parts[2 + i]] : [])), ...parts.slice(2 + n)].join("|");
}

/**
 * Why the step is not queued again, or null: the last autopilot job of the step (and repo) handled nothing and saw the input `fp`
 * still describes. An operator release since then ends it. `lane`: the lane PR (lanePrOf) of a per-item job; `topics`: the lane's.
 * A job proposed for its items (`byRefs`) whose calls were only withdrawn for want of a taker is not idle: the gate on its items' takers already
 * holds it back while nobody can take them, and the same Task Runner coming back leaves the taker signature as it was.
 * A job without items that handled nothing, ran no pool unit to an end (UNITS_RAN) and only left work no Task Runner takes waits for
 * the takers, not for the rest of its input: it runs again once the taker signature, the work people started or approved (STARTED_TOPICS) or the lane's extra reading
 * changes. On a busy repo the other counters move on every pass, while the work it left stays untaken.
 */
async function unchangedSinceIdle(db: Db, step: string, repo: string | null, fp: string, o: { lane?: number | null; byRefs?: boolean; topics?: readonly string[] } = {}): Promise<string | null> {
  const lane = o.lane ?? null;
  const last = await lastJobEnd(db, step, repo, AUTOPILOT_USER, lane);
  const onlyLeft = !!last && !o.byRefs && onlyUntaken(last);
  if (!last || last.state !== "done" || !(wasIdle(last) || onlyLeft)) return null;
  // A job that skipped items another job was working retries once no running job holds a lease on any of them. While one does, the step stays parked, so the planner does not queue it in a loop.
  // Skips for want of a taker do not count: such a step is woken by the taker signature in its fingerprint.
  const leaseKeys = leaseSkipKeys(last.lease_skip_keys);
  if (last.lease_skips && leaseKeys?.length !== 0 && !await skippedLeaseHeld(db, leaseKeys)) return null;
  const rec = await fpRecord(db, step, repo, lane);
  if (!rec || rec.job !== last.id) return null;
  const parked = onlyLeft && wasIdle(last) && lane === null && !unitsRan(last.lease_skip_keys);
  const topics = o.topics ?? INPUT_TOPICS;
  if (parked ? (takerPartOf(fp, topics) ?? fp) !== (takerPartOf(rec.fp, topics) ?? rec.fp) : rec.fp !== fp) return null;
  if ((await releasedAt(db, step) ?? "") > last.endedAt) return null;
  return parked ? "no Task Runner takes the work it left; it runs again when a Task Runner can take it" : "nothing to do: its input has not changed since the last run";
}

/** True when a job's pool units ran to an end other than a skip for want of a taker (UNITS_RAN): one may wait on work that is still going. */
function unitsRan(keys: string | null): boolean {
  try { return (JSON.parse(keys ?? "[]") as string[]).some((k) => k.startsWith(UNITS_RAN)); } catch { return true; }
}

const warned = new Set<string>();

/**
 * Queues the proposals: per lane and repo the first one that is accepted. Returns the queued job ids. One reading decides them all,
 * and one transaction queues the jobs and writes the planner's marks.
 */
export async function applyProposals(db: Db, proposals: Proposal[], opts: PlanOptions & { wakeAt?: number | null; status?: Record<string, string> } = {}): Promise<number[]> {
  const lanes = opts.lanes ?? LANES, log = opts.log ?? (() => {});
  const accepted = proposals.length ? await acceptProposals(db, proposals, log) : [];
  // Marks the next planner pass wants: when a wait ends, and why stages are not starting.
  const marks: LaneStatePut[] = [
    ...(opts.wakeAt ? [{ kind: "mark" as const, step: MARK_WAKE_AT, value: new Date(opts.wakeAt).toISOString() }] : []),
    ...(opts.status ? [{ kind: "mark" as const, step: MARK_STATUS, value: JSON.stringify(opts.status) }] : []),
  ];
  const ids = await db.write(async () => {
    const { queued } = await enqueueJobs(db, accepted.map(({ p, params }) => ({ step: p.step, params, repo: repoOf(p), by: AUTOPILOT_USER })));
    const fps = accepted.flatMap(({ p }, i): LaneStatePut[] => (p.fp !== undefined && queued.has(i) ? [{ kind: "fp", step: fpStep(p.step, lanePrOf(p.params)), repo: repoOf(p) ?? "", value: p.fp, job_id: queued.get(i)! }] : []));
    await saveLaneState(db, [...marks, ...fps]);
    if (fps.some((f) => f.step.includes(":"))) await pruneItemFps(db);
    if (!opts.wakeAt) await removeLaneState(db, [{ kind: "mark", step: MARK_WAKE_AT }]);
    for (const [i, { p }] of accepted.entries()) {
      const c: Candidate = { step: p.step, params: Object.fromEntries(Object.entries(p.params).filter(([k]) => k !== "limit")) };
      if (queued.has(i)) await lanes.find((l) => l.name === p.lane)?.chosen?.(db, c);
    }
    return queued;
  });
  for (const [i, { p, params }] of accepted.entries()) {
    log(ids.has(i) ? `autopilot: job ${ids.get(i)}: ${p.step} ${JSON.stringify(params)}` : `autopilot: ${p.step}: not queued: ${p.step} with these settings is already queued`);
  }
  return accepted.flatMap((_, i) => (ids.has(i) ? [ids.get(i)!] : []));
}

/** The proposals to queue, with their params. The detection ran a moment ago: a job of the same step and repo may have been queued since. */
async function acceptProposals(db: Db, proposals: Proposal[], log: (line: string) => void): Promise<{ p: Proposal; params: Params }[]> {
  const steps = await loadSteps(), ms = Date.now();
  const untaken = await untakenTest(db, steps);
  const [loaded, cap, names] = await db.together(() => Promise.all([loadReads(db, ms), stepParallel(db), trackedNames(db), untaken.load?.()]));
  const active: Active[] = loaded.inputs.live.map((j) => ({ id: j.id, step: j.step, state: j.state, repo: j.repo, number: j.number, params: j.params }));
  // The jobs accepted here count against the limits of the next ones.
  const reads: Reads = { ...loaded, inputs: { ...loaded.inputs, live: [...loaded.inputs.live] } };
  const out: { p: Proposal; params: Params }[] = [];
  const done = new Set<string>();
  // Jobs accepted in this pass and the steps their proposals gate: they hold a repo of the step, so with step_parallel 1 no other repo takes it.
  const reserved: Active[] = [];
  const asActive = (step: string, params: Params, state: string): Active => ({ ...wantOf(step, params), id: 0, state, number: typeof params.number === "number" ? params.number : null });
  const blocked = (step: string, params: Params): Promise<string | null> => jobBlock(db, steps, wantOf(step, params), { reserved, untaken, active, cap });
  // The checks of the requests go out together; a refusal is told when its proposal's turn comes.
  const checks = new Map<Proposal, Promise<Awaited<ReturnType<typeof checkRequest>>>>();
  await db.together(async () => {
    for (const p of proposals) checks.set(p, checkRequest(db, p.step, p.params, names));
    await Promise.allSettled(checks.values());
  });
  await withPassReads(db, { reads }, async () => {
    for (const p of proposals) {
      // Per lane and repo the first one, and each lane PR's own.
      const slot = `${p.lane}\0${repoOf(p) ?? ""}\0${lanePrOf(p.gate?.params ?? p.params) ?? ""}`;
      if (done.has(slot)) continue;
      try {
        if (await blocked(p.step, p.params) || (p.gate && await blocked(p.gate.step, p.gate.params))) continue;
        // A failed read of one check fails its whole wave: the check then runs by itself.
        const { step, params: checked } = await checks.get(p)!.catch((e: unknown) => { if (e instanceof JobError) throw e; return checkRequest(db, p.step, p.params, names); });
        let params: Params = checked;
        // The limit is what is left now, so two proposals of one step cannot both carry the whole remainder.
        if (typeof params.limit === "number") {
          const lim = await jobLimit(db, step, ms, params.limit, untaken);
          if (!lim) throw new JobError(409, `the daily limit of ${step.name} leaves too little for a job`);
          params = { ...params, ...lim };
        }
        out.push({ p, params });
        reserved.push(asActive(p.step, p.params, "queued"));
        reads.inputs.live.push({ ...asActive(p.step, p.params, "queued"), params: JSON.stringify(params), items: null } as Reads["inputs"]["live"][number]);
        if (p.gate) reserved.push(asActive(p.gate.step, p.gate.params, "gated"));
        done.add(slot);
      } catch (e) {
        if (!(e instanceof JobError)) {
          log(`autopilot: ${p.lane}: ${(e as Error).message}`);
          done.add(slot);
        } else log(`autopilot: ${p.step}: not queued: ${e.message}`);
      }
    }
  });
  return out;
}

/** Detection and queueing in one go, on one connection. */
export async function planAutopilot(db: Db, opts: PlanOptions = {}): Promise<number[]> {
  const found = await detectAutopilot(db, opts);
  return applyProposals(db, found.proposals, { ...opts, wakeAt: found.wakeAt ?? null, ...(found.status ? { status: found.status } : {}) });
}

/**
 * What the planner's marks say about the content stages read, the limits that apply to them and the operators' releases, from its
 * parts read. The releases' times are compared as values: on Postgres a release can commit after a planner mark later than its time.
 */
const inputSignature = (seqs: Record<string, number>, limits: string, takers: string, released: Map<string, string>): string =>
  [...DUE_TOPICS.map((t) => seqs[t] ?? 0), limits, takers, ...[...released].sort().flat()].join(",");

type PlanDueReads = Awaited<ReturnType<typeof loadPlanDue>>;

/** What planDue reads, in one wave. */
export async function loadPlanDue(db: Db, nowMs: number) {
  return await db.together(() => Promise.all([
    loadLaneState(db, ["mark"]), limitsSignature(db), db.seqs(), loadTakerSignature(db, nowMs), loadAuditMax(db, Object.keys(RELEASE_STEPS)),
  ]));
}

/**
 * Whether the planner is due now (also with the switch off: the Plan cache must follow the data; the runner queues nothing then): a content topic changed, a job or sandbox task
 * ended, a lease was given back, a limit changed, an operator released work, the Task Runners that may take calls changed, a wait the last pass found has ended, or the fallback timer ran out. Moves the planner's marks when
 * it is, so the caller must then plan.
 */
export async function planDue(db: Db, nowMs: number = Date.now(), read?: PlanDueReads): Promise<boolean> {
  const t = nowMs;
  const [marks, limits, seqs, takers, released] = read ?? await loadPlanDue(db, t);
  const mark = (name: string): string | null => marks.get(`mark|${name}|`)?.value ?? null;
  const [seen, plannedAt, wake] = [mark(MARK_SEQS_SEEN), mark(MARK_PLANNED_AT), mark(MARK_WAKE_AT)];
  const sig = inputSignature(seqs, limits, takers, released);
  const changed = sig !== (seen ?? "");
  const planned = plannedAt === null ? 0 : Date.parse(plannedAt);
  const woken = wake !== null && Date.parse(wake) <= t;
  if (!changed && plannedAt !== null && t - planned < PLAN_EVERY_MS && !woken) return false;
  // The pass about to run sets the next wake time when it is applied. With the switch off nothing is applied, so a
  // wake time that has passed would stay and make every tick plan again.
  await db.write(async () => {
    await saveLaneState(db, [{ kind: "mark", step: MARK_SEQS_SEEN, value: sig }, { kind: "mark", step: MARK_PLANNED_AT, value: new Date(t).toISOString() }]);
    if (woken) await removeLaneState(db, [{ kind: "mark", step: MARK_WAKE_AT }]);
  });
  return true;
}

/** Why each stage is not starting, as the last planner pass saw it; keyed by step. */
export async function stageStatus(db: Db): Promise<Record<string, string>> {
  try { return JSON.parse((await loadLaneState(db, ["mark"])).get(`mark|${MARK_STATUS}|`)?.value ?? "{}") as Record<string, string>; } catch { return {}; }
}

// ---- what each lane will take next ----------------------------------------------

/** The plan actions whose items a lane's job works on, in the order the lane's own selection lists them. Lanes without items are absent. */
export const LANE_KINDS: Record<string, ActionKind[]> = {
  classify: ["classify"], priority: ["prioritize"], embed: ["embed"], dupes: ["dupes"], "dupes-compare": ["dupes-compare"],
  review: ["review"], labels: ["label"], merge: ["merge"], act: ["act"], fixup: ["fixup", "conflict"], verify: ["verify"],
  implement: ["implement"], "issue-review": ["issue-review"], "issue-review-post": ["issue-review-post"], referee: ["referee"], "review-carry": ["carry"], "review-post": ["post-review"],
  "ci-approve": ["approve-ci"], cifix: ["cifix", "lint"], unassign: ["unassign"], premerge: ["premerge"], "premerge-followups": ["followups"],
};

/** Lanes whose jobs are not about listed items (counters, collection, operator messages, per-repo scans); every other lane needs a LANE_KINDS entry. */
export const NO_ITEM_LANES = ["rank", "verify-collect", "pr-build", "conversation", "conversation-maintainer", "postmerge", "postmerge-file", "main-fix", "cifix-rerun", "nightly", "eval", "pr-status"];

export type LaneItem = {
  repo: string; number: number; kind: "pr" | "issue"; action: string; bucket: string | null;
  rank: number | null; inFlight: boolean;
  /** The next job of the lane covers this item's repo. */
  next: boolean;
  /** Why the item's action may not run, or why no job of the lane will take its repo now (no Task Runner takes it), or null. */
  blocked: string | null;
  /** The code of a refused action, or null. */
  refusal: RefusalCode | null;
};

/**
 * The items a lane's jobs work on, in the order its next jobs take them: the repos in the order `detect` lists
 * its candidates, and within a repo the order the planner's own selection (planned, plannedItems) gives. Items of
 * other repos follow. The dashboard's Next page reads this, so it cannot drift from what the autopilot picks.
 */
export async function laneItems(db: Db, ctx: PlanCtx, lane: Pick<Lane, "name" | "perRepo" | "scope" | "detect" | "steps">): Promise<LaneItem[]> {
  const kinds = LANE_KINDS[lane.name];
  if (!kinds) return [];
  const plans = await plansOf(db, ctx);
  const seen = new Set<string>(), all: LaneItem[] = [];
  // An item whose calls no Task Runner takes in any step of the lane: the planner proposes no job for it.
  const scope = new Set(reposFor(ctx, lane.scope ?? "work"));
  const untaken = (ctx.untaken ??= await untakenTest(db));
  // Why the item's jobs wait (the first step's reason), or null when some step of the lane has a taker for a call about it.
  const waits = async (repo: string, number: number): Promise<string | null> => {
    const why = lane.steps ? await mapSeq(lane.steps, async (step) => await untaken({ step, repo, refs: [{ repo, number }] })) : [];
    return why.length > 0 && why.every((x) => x !== null) ? why[0]! : null;
  };
  const add = async (f: Planned["facts"] | PlannedItem["facts"], state: string, a: Action) => {
    const ref = `${f.repo}#${f.number}`;
    if (seen.has(ref)) return;
    seen.add(ref);
    const may = mayRun({ facts: f, action: a }, "pipeline"), refused = may.ok || may.why.code === "pipeline-off" ? null : may.why;
    const outside = !scope.has(f.repo);
    const blocked = outside ? "outside the pipeline scope" : refused?.text ?? (may.ok ? await waits(f.repo, f.number) : null);
    all.push({
      repo: f.repo, number: f.number, kind: "kind" in f ? f.kind : "pr", action: a.kind, bucket: typeof a.params?.bucket === "string" ? a.params.bucket : null,
      rank: f.score, inFlight: inFlightNow(f, state), next: false, blocked, refusal: outside ? null : refused?.code ?? null,
    });
  };
  for (const k of kinds) {
    for (const p of await planned(db, k, { plans, refused: true })) await add(p.facts, p.plan.state, p.action);
    for (const p of await plannedItems(db, k, { plans, refused: true })) await add(p.facts, p.plan.state, p.action);
  }
  const repos: string[] = [];
  for (const c of await detectOf(db, ctx, lane)) { const r = repoOf(c); if (r && !repos.includes(r)) repos.push(r); }
  const order = new Map(repos.map((r, i) => [r, i]));
  const picked = (i: LaneItem) => !lane.perRepo || order.has(i.repo);
  // A stable sort keeps the planner's order within a repo; items of repos detect did not list follow.
  const first = lane.perRepo ? all.filter(picked).sort((a, b) => order.get(a.repo)! - order.get(b.repo)!) : all;
  const rest = lane.perRepo ? all.filter((i) => !picked(i)) : [];
  return [...first, ...rest].map((i) => ({ ...i, next: picked(i) && !i.blocked }));
}

const plain = (why: string): string => { const t = why.replace(/^paused: /, ""); return t.charAt(0).toUpperCase() + t.slice(1); };

/** The most items of one lane the planner stores. */
const NEXT_PER_LANE = 500;
export type StoredLaneItems = Record<string, { total: number; items: LaneItem[] }>;

type LaneRow = { lane: string; total: number; items: unknown[]; at: string };

/** Each lane's items as this pass sees them: only the lanes that differ from the stored lists. The table belongs to the `plans` topic, which the planner does not take as input. */
async function changedLanes(db: Db, lanes: Lane[], ctx: PlanCtx, stored?: Awaited<ReturnType<typeof loadLanes>>): Promise<LaneRow[]> {
  const old = new Map(stored ?? await loadLanes(db));
  const at = new Date().toISOString();
  const changed: LaneRow[] = [];
  for (const lane of lanes) {
    const all = await laneItems(db, ctx, lane);
    const prev = old.get(lane.name);
    old.delete(lane.name);
    if (!all.length) { if (prev) changed.push({ lane: lane.name, total: 0, items: [], at }); continue; }
    const items = all.slice(0, NEXT_PER_LANE);
    if (!prev || prev.total !== all.length || JSON.stringify(prev.items) !== JSON.stringify(items)) changed.push({ lane: lane.name, total: all.length, items, at });
  }
  for (const lane of old.keys()) changed.push({ lane, total: 0, items: [], at });
  return changed;
}

/** The lane lists of the planner's last pass, keyed by lane name. */
export async function storedLaneItems(db: Db): Promise<StoredLaneItems> {
  const out: StoredLaneItems = {};
  for (const [lane, r] of await loadLanes(db)) out[lane] = { total: r.total, items: r.items as LaneItem[] };
  return out;
}

export type LaneGate = { canRun: boolean; kind: "ok" | "running" | "off" | "limit" | "backoff"; why: string | null };

/** Whether a job of each lane can start now, from the same checks the planner's gate() makes; one reading serves them all. */
export async function laneGates(db: Db, lanes: readonly Pick<Lane, "name" | "steps">[], allSteps: Map<string, StepDef>, ms: number = Date.now()): Promise<Map<string, LaneGate>> {
  const untaken = await untakenTest(db, allSteps, ms);
  const [cfg, reads, cap, act] = await db.together(() => Promise.all([freshConfig(db, [KEY_ENABLED]), loadReads(db, ms), stepParallel(db), actUsedToday(db, ms), untaken.load?.()]));
  const off: LaneGate | null = cfg.pipelineEnabled ? null : { canRun: false, kind: "off", why: cfg.pipelineDraining ? "The pipeline is draining" : "The pipeline is off" };
  const active: Active[] = reads.inputs.live.map((j) => ({ id: j.id, step: j.step, state: j.state, repo: j.repo, number: j.number, params: j.params }));
  const gateOf = async (lane: Pick<Lane, "steps">): Promise<LaneGate> => {
    let blocked: LaneGate | null = null;
    for (const s of lane.steps ?? []) {
      // Blocked only when no repo can start: the step already works its most repos.
      const full = await jobBlock(db, allSteps, { step: s, repo: null }, { precheck: true, untaken, active, cap });
      if (full) { blocked ??= { canRun: false, kind: "running", why: full.replace(/ \(step_parallel\)$/, "") }; continue; }
      const why = await pauseReason(db, s, ms);
      if (!why) return { canRun: true, kind: "ok", why: null };
      const kind = /^failed/.test(why) ? "backoff" : "limit";
      blocked ??= { canRun: false, kind, why: plain(why) };
    }
    return blocked ?? { canRun: true, kind: "ok", why: null };
  };
  return await withPassReads(db, { reads, act: new Map([[dayStart(ms), act]]) }, async () => {
    const out = new Map<string, LaneGate>();
    for (const l of lanes) out.set(l.name, off ?? await gateOf(l));
    return out;
  });
}
