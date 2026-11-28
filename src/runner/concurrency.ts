// Which jobs may run together: one queued or running job per (step, repo), at most `step_parallel` repos per step,
// and the named mutexes of StepDef.exclusive. The planner, the command-line gate and the runner use the same rules.
// A queued job that no Task Runner may take (untakenTest) holds no repo of the step.
// Per-item steps (hasApprovedLane): each due item gets a job of its own, `{ repo, number, lane: "approved" }` for an item a person started
// or approved for merge (ownLane in src/core/select.ts) and `{ repo, number, lane: "item" }` for the others. One live job per (step, repo,
// number); such jobs neither count toward step_parallel nor wait for it, so no item waits for another item's job. A job of the step
// without a lane (a command-line run) works the one item its `number` names, the same work as that item's job, or else the repo's
// PRs nobody started, the same work as their item jobs.
import { freshConfig, saveSettings } from "../data/control/index.ts";
import { loadLiveJobs } from "../data/jobs/index.ts";
import { taskOfStep, TASK_CHOICES } from "../remote/my-tasks.ts";
import { takerTest, takerTestIn, type TakerCall } from "../remote/takers.ts";
import type { RemoteView } from "../remote/view.ts";
import { approvedLane, knownStep, modelsOf, perItemLane, usesClaude, type Params, type StepDef } from "./steps.ts";
import { filterSeq, someSeq } from "../async-seq.ts";
import type { ItemRef } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";

export const STEP_PARALLEL_KEY = "step_parallel";
export const STEP_PARALLEL_DEFAULT = 1;
export const STEP_PARALLEL_MAX = 1000;

export class ParallelError extends Error {
  status = 400;
}

/** The setting as shown and stored: a positive integer or "none". */
export async function stepParallelSetting(db: Db): Promise<string> {
  return (await freshConfig(db, [STEP_PARALLEL_KEY])).stepParallelSetting;
}

/** The most repos one step may have running at once (Infinity for "none"). */
export const stepParallel = async (db: Db): Promise<number> => (await freshConfig(db, [STEP_PARALLEL_KEY])).stepParallel;

export async function setStepParallel(db: Db, input: unknown, by: string): Promise<string> {
  const v = typeof input === "number" ? String(input) : input;
  if (v !== "none" && !(typeof v === "string" && /^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= STEP_PARALLEL_MAX)) {
    throw new ParallelError(`repos at once per step must be a whole number from 1 to ${STEP_PARALLEL_MAX}, or none`);
  }
  const was = await stepParallelSetting(db);
  if (v === was) return v as string;
  await saveSettings(db, [{ key: STEP_PARALLEL_KEY, value: v as string }], by, { action: "step-parallel", target: "pipeline", details: { stepParallel: v, was } });
  return v as string;
}

/**
 * A job that holds or waits for its (step, repo). `number` is the finding of a security-fix job or the PR of a per-item job;
 * `params` (JSON) is read for jobs in the table; `approved` and `perItem` mark a proposal of the approved lane and of either per-item
 * lane (a job in the table says so in `params`).
 */
export type Active = { id: number; step: string; state: string; repo: string | null; number: number | null; params?: string; approved?: boolean; perItem?: boolean };

const isApproved = (j: { approved?: boolean; params?: string }): boolean => j.approved ?? approvedLane(j.params);
const isPerItem = (j: { perItem?: boolean; params?: string }): boolean => j.perItem ?? perItemLane(j.params);

export async function activeJobs(db: Db, states: ("queued" | "running")[] = ["queued", "running"]): Promise<Active[]> {
  return (await loadLiveJobs(db)).filter((j) => (states as string[]).includes(j.state)).map((j) => ({ id: j.id, step: j.step, state: j.state, repo: j.repo, number: j.number, params: j.params }));
}

/**
 * A job or proposal as untakenTest reads it: `params` as an object or the stored JSON; `refs`, where known, the items its calls
 * would name (the planner's due items of the job), each of which a call names alone.
 */
export type JobOfRepo = { step: string; repo: string | null; params?: Params | string | null; refs?: readonly ItemRef[] };

/** Why a job waits for a Task Runner, or null when it does not: see untakenTest. */
export type UntakenTest = ((j: JobOfRepo) => Promise<string | null>) & {
  /** Reads the runners now, so a pass can do it with its other first reads. */
  load?: () => Promise<unknown>;
};

/** The reason a job of `repo` waits: shown for the step, the lane's items and the queued job. */
export const noRunnerFor = (repo: string): string => `No Task Runner takes ${repo}`;
/** The reason a job of `step` on `repo` waits when Task Runners take the repo but none takes the step's task (My tasks). */
export const noRunnerForTask = (repo: string, step: string): string => {
  const task = taskOfStep(step);
  return `No Task Runner takes ${TASK_CHOICES.find((t) => t.id === task)?.title ?? task} tasks on ${repo}`;
};
/** The reason a job waits when Task Runners take its repo and step's task, but none takes a call about any of its due items (the first few named). */
export const noRunnerForItems = (_repo: string, step: string, refs: readonly ItemRef[]): string => {
  const task = taskOfStep(step), named = refs.slice(0, 3).map((r) => `${r.repo}#${r.number}`).join(", ");
  return `No Task Runner takes ${TASK_CHOICES.find((t) => t.id === task)?.title ?? task} tasks on ${named}${refs.length > 3 ? ` and ${refs.length - 3} more` : ""}`;
};

/**
 * Why a job waits for a Task Runner, or null: a job of a step that calls Claude, for a repo no Task
 * Runner may take now or whose step's task none of those takes (src/remote/takers.ts, the rule the runner's job starts and the
 * pools use). The runners are read once, on the first such job, so one test serves a whole pass. Never for a job with no repo. A job names no item (a `number` param is a security finding), so a runner that takes only some
 * items counts on the repos with such an item (src/remote/task-items.ts); the job's pools then ask about each unit's items.
 * With the job's due items (`refs`: one PR of a per-item lane, or the PRs a Verify job of the repo would plan) the test is the call's own: the job waits unless a call about one of them has a taker. Without
 * them, someone's started work elsewhere in the repo makes their runner a taker for the whole repo, although a call about an item
 * nobody started never reaches it and is withdrawn.
 */
export async function untakenTest(db: Db, steps?: Map<string, StepDef>, nowMs: number = Date.now(), view?: RemoteView): Promise<UntakenTest> {
  // `view`: a reading of the runners the caller already made, used instead of reading them again.
  const within = view ? takerTestIn(view) : null;
  const takes = within ? async (c: TakerCall): Promise<boolean> => within(c) : takerTest(db, nowMs);
  const load = (): Promise<unknown> => takes({ prompt_id: "", repos: [] });
  const claude = (j: JobOfRepo): boolean => {
    let params: Params = {};
    if (typeof j.params === "string") { try { params = JSON.parse(j.params) as Params; } catch { /* the step's defaults */ } }
    else if (j.params) params = j.params;
    return usesClaude(modelsOf(steps?.get(j.step) ?? knownStep(j.step), params));
  };
  const test: UntakenTest = async (j) => {
    if (j.repo === null || !claude(j)) return null;
    const repo = j.repo, refs = j.refs?.length ? j.refs : null;
    if (refs ? await someSeq(refs, async (r) => await takes({ prompt_id: "", repos: [r.repo], step: j.step, refs: [r] })) : await takes({ prompt_id: "", repos: [repo], step: j.step })) return null;
    if (!await takes({ prompt_id: "", repos: [repo] })) return noRunnerFor(repo);
    return refs && await takes({ prompt_id: "", repos: [repo], step: j.step }) ? noRunnerForItems(repo, j.step, refs) : noRunnerForTask(repo, j.step);
  };
  return Object.assign(test, { load });
}

type Work = { repo: string | null; number: number | null; approved: boolean; perItem: boolean };

/**
 * Two jobs of one step do the same work: one of them is not about a single repo; or the same repo and: the same finding (security-fix),
 * a per-item job and another job naming the same item, an item job and a job of the repo without a lane or item, or two jobs without a lane.
 */
function sameWork(step: string, a: Work, b: Work): boolean {
  if (a.repo === null || b.repo === null) return true;
  if (a.repo !== b.repo) return false;
  if (step === "security-fix") return a.number === b.number;
  if (!a.perItem && !b.perItem) return true;
  if (a.number !== null && b.number !== null) return a.number === b.number;
  return !(a.perItem ? a : b).approved;
}

/** `perItem`: a job of a per-item lane, for the PR `number`; `approved`: of the approved lane. */
export type Want = { step: string; repo: string | null; number?: number | null; approved?: boolean; perItem?: boolean };

/** The Want of a job of `step` with these params. */
export const wantOf = (step: string, params: Params | string): Want => {
  let p: Params = {};
  if (typeof params === "string") { try { p = JSON.parse(params) as Params; } catch { /* no params */ } } else p = params;
  return { step, repo: typeof p.repo === "string" ? p.repo : null, number: typeof p.number === "number" ? p.number : null, approved: approvedLane(p), perItem: perItemLane(p) };
};

/**
 * Why the job cannot be queued or started now, or null. `states` are the jobs that count: queued and running for
 * queueing, running alone for starting. `extra` are proposals of the same pass: they only count as the same work (a duplicate), so a fallback proposal for another repo can still be made. `reserved` are jobs this pass already queued or gated: they count for the same work and for the repo capacity. `mutex` also checks StepDef.exclusive
 * against running jobs. With `precheck` (a planner check before any repo is known) only the repo capacity is checked.
 * A queued job that `untaken` says waits for a Task Runner counts as the same work but takes no repo of the capacity; a
 * pass that asks many times passes one test.
 */
export async function jobBlock(db: Db, steps: Map<string, StepDef>, want: Want, o: JobBlockOptions = {}): Promise<string | null> {
  return blockText(want.step, await jobBlockOf(db, steps, want, o));
}

export type JobBlockOptions = { states?: ("queued" | "running")[]; extra?: Active[]; reserved?: Active[]; mutex?: boolean; precheck?: boolean; untaken?: UntakenTest; active?: Active[]; cap?: number };

/** What holds a job back (jobBlock): a job doing the same work, the step at its repos at once, or a running job of the same mutex. */
export type JobBlock = { kind: "same"; job: Active } | { kind: "parallel"; repos: number } | { kind: "mutex"; job: Active; mutex: string };

const blockText = (step: string, b: JobBlock | null): string | null =>
  b === null ? null
    : b.kind === "same" ? `job ${b.job.id} of ${step} is ${b.job.state}`
    : b.kind === "parallel" ? `${step} is working ${b.repos} repo${b.repos === 1 ? "" : "s"}, the most at once (step_parallel)`
    : `job ${b.job.id} (${b.job.step}) is running with the same mutex (${b.mutex})`;

/** jobBlock's answer as a value, for a reader that words it itself (src/runner/why-queued.ts). */
export async function jobBlockOf(db: Db, steps: Map<string, StepDef>, want: Want, o: JobBlockOptions = {}): Promise<JobBlock | null> {
  // `active`: the queued and running jobs, read once by a caller that asks many times while no job changes.
  const jobsIn = async (states: ("queued" | "running")[] = ["queued", "running"]): Promise<Active[]> => (o.active ? o.active.filter((j) => (states as string[]).includes(j.state)) : await activeJobs(db, states));
  const held = [...await jobsIn(o.states), ...(o.reserved ?? [])].filter((j) => j.step === want.step);
  const same = [...held, ...(o.extra ?? []).filter((j) => j.step === want.step)];
  if (!o.precheck) {
    const w: Work = { repo: want.repo, number: want.number ?? null, approved: !!want.approved, perItem: !!want.perItem };
    const clash = same.find((j) => sameWork(want.step, { repo: j.repo, number: j.number, approved: isApproved(j), perItem: isPerItem(j) }, w));
    if (clash) return { kind: "same", job: clash };
  }
  const cap = want.perItem ? Infinity : o.cap ?? await stepParallel(db);
  if (cap !== Infinity) {
    let untaken = o.untaken;
    const holds = async (j: Active): Promise<boolean> => !isPerItem(j) && (j.state !== "queued" || j.params === undefined || !await (untaken ??= await untakenTest(db, steps))(j));
    const repos = new Set((await filterSeq(held, holds)).map((j) => j.repo ?? ""));
    if (repos.size >= cap && (o.precheck || !repos.has(want.repo ?? ""))) return { kind: "parallel", repos: repos.size };
  }
  const mutex = steps.get(want.step)?.exclusive;
  if (o.mutex && mutex) {
    const other = (await jobsIn(["running"])).find((j) => steps.get(j.step)?.exclusive === mutex);
    if (other) return { kind: "mutex", job: other, mutex };
  }
  return null;
}
