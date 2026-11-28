// The pipeline steps the runner can run. Each step is a declaration: who may
// request it, a params schema, an optional mutex and the function that runs
// it. Adding a step means adding one entry to STEPS (and the module its `run`
// imports); the dashboard, the API, the autopilot and the runner pick it up from here.
//
// Params are only enums, tracked repo names, bounded integers and run ids:
// nothing a person types can reach a model's prompt or a shell.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { byOfJob } from "../core/gates.ts";
import { featureOn } from "../build/features.ts";
import { envVar } from "../env.ts";
import { stageOfStep } from "../stages/registry.ts";
import { stepDeadlineMin } from "./deadlines.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { IMPLEMENT_BUCKETS } from "../implement/types.ts";
import { mapSeq } from "../async-seq.ts";
import { jobRunId } from "./resuming.ts";
import { findingKey, loadFindings, loadScans } from "../data/security/index.ts";
import type { Db } from "../db/index.ts";

/** `cliOnly`: set from the command line only; the dashboard's run-step form does not offer it and refuses it. */
type Base = { name: string; label: string; help?: string; required?: boolean; cliOnly?: boolean };
export type ParamDef =
  | (Base & { kind: "enum"; options: string[]; default?: string })
  | (Base & { kind: "repo" })                                        // a tracked repo
  | (Base & { kind: "int"; min: number; max: number; default?: number })
  | (Base & { kind: "run-id"; default?: string })                    // RUN_ID below
  | (Base & { kind: "sha" });                                         // a commit id, HEAD_SHA below

export type Params = Record<string, string | number>;

export const RUN_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HEAD_SHA = /^[0-9a-f]{7,64}$/;
/** Whether `v` is a commit id a `sha` param takes. */
export const isHeadSha = (v: unknown): v is string => typeof v === "string" && HEAD_SHA.test(v);

/**
 * The `lane` of a job of a per-item step (Review, Post final reviews, Pre-merge review, Fix-up, Fix, Implement) that works one item
 * (`number`): `approved` for an item a person started or approved for merge (core/select.ts ownLane; every issue Implement works was
 * queued by a person), `item` for a PR nobody started. A job without a lane works every PR of the repo nobody started (a command-line
 * run), or the one item its `number` names. One live job per (step, item), so no item waits behind another (src/runner/concurrency.ts).
 */
export const APPROVED_LANE = "approved";
export const ITEM_LANE = "item";
const LANE_PARAM: ParamDef = { name: "lane", label: "Lane", kind: "enum", options: [APPROVED_LANE, ITEM_LANE], help: "approved: the pull request (number), which a person started or approved for merge; item: the pull request, which nobody started; empty: every pull request nobody started" };
/** Implement's lane: every issue it works was queued by a person, so its planner jobs are all of the approved lane. */
const IMPLEMENT_LANE_PARAM: ParamDef = { name: LANE_PARAM.name, label: "Lane", kind: "enum", options: [APPROVED_LANE], help: "approved: the planner's job for the queued issue (number), which runs beside the repo's other issues; empty: a run started by hand" };
const PR_PARAM: ParamDef = { name: "number", label: "Pull request", kind: "int", min: 1, max: 1_000_000_000, help: "only this pull request" };
/** The PR's head when the planner queued a per-item job, so its failures count per head (src/workflow/advance.ts laneStops); the job works the head the PR has when it runs. */
const HEAD_PARAM: ParamDef = { name: "head", label: "Head", kind: "sha", cliOnly: true, help: "the pull request's head commit when the job was queued" };

/** The `number` param of a job of a per-item step: the one PR it works. */
const onlyPr = (params: Params): { number?: number } => (typeof params.number === "number" ? { number: params.number } : {});

/** The step runs one job per item (Review, Post final reviews, Pre-merge review, Fix-up, Fix, Implement): `{ repo, number, lane: "approved" }` for an item a person started or approved (core/select.ts ownLane), `{ repo, number, lane: "item" }` for the others. */
export const hasApprovedLane = (step: StepDef | undefined): boolean => !!step?.params.some((p) => p.name === LANE_PARAM.name);

/** True for a job (its params, as an object or the stored JSON) of the approved lane. */
export function approvedLane(params: Params | string | null | undefined): boolean {
  if (typeof params === "string") {
    try { return (JSON.parse(params) as Params).lane === APPROVED_LANE; } catch { return false; }
  }
  return params?.lane === APPROVED_LANE;
}

/** The `lane` param of a job (its params, as an object or the stored JSON), null without one. */
export function laneOf(params: Params | string | null | undefined): string | null {
  let lane: unknown;
  if (typeof params === "string") {
    try { lane = (JSON.parse(params) as Params).lane; } catch { return null; }
  } else lane = params?.lane;
  return typeof lane === "string" && lane !== "" ? lane : null;
}

/** True for a job of either per-item lane (approved or item): it works the one PR its `number` names. */
export const perItemLane = (params: Params | string | null | undefined): boolean => {
  const lane = laneOf(params);
  return lane === APPROVED_LANE || lane === ITEM_LANE;
};

export type StepContext = {
  db: Db;
  /** `resumes`: times the job resumed after a runner stop or restart (src/runner/resuming.ts); 0 on its first run. */
  job: { id: number; requestedBy: string; startedAt: string; resumes: number };
  params: Params;
  /** One line shown on the dashboard while the job runs. */
  progress(text: string): Promise<void>;
  /** A line in the job's log. Logs are shown to everyone signed in: no secrets. */
  log(line: string): void;
  /** Model calls recorded in token_usage under this run id (from the job's start) count as the job's usage. */
  usageRun(runId: string): void;
  /** Items this job has handled so far (units attempted, such as items sent to a model), counted against the stage's daily limit. Pass the running total as work goes: it is saved at once, so a failed or stopped job keeps its count. */
  handled(n: number): void;
  /** Progress that is not an item: a batch started, opened or advanced. A job with no items and no acted is recorded as having done nothing, and the autopilot does not queue it again until its input changes. */
  acted(n: number): void;
  /** Set when a cancel was requested; long loops should stop between units of work. */
  cancelled(): Promise<boolean>;
  /** True when no new item should start: a cancel was requested, the deadline passed, or a pipeline job runs while the pipeline is not on. The current item finishes. */
  stopping(): Promise<boolean>;
  /**
   * True once the job has used its slice of the time before its deadline (SLICE_SHARE, src/runner/deadlines.ts). A step that works
   * through a backlog stops at its next unit boundary and returns what is left as a success; the leftover items make the next job due.
   * Always false for a run without a runner deadline (a command-line run).
   */
  timeUp(): Promise<boolean>;
};

export type StepDef = {
  name: string;
  /** Model-call queue class: 2 security, 1 path to merge, 0 (default) triage and after merge. A higher class takes a freed account slot first. */
  priority?: 0 | 1 | 2;
  title: string;
  /** One or two plain sentences for the Pipeline page. */
  description: string;
  /** Stage number in docs/pipeline.md. */
  stage: number;
  /** Who may start or cancel it. Anything that writes to GitHub or spends model quota is operator-only. */
  requires: "operator";
  /**
   * A named mutex: running jobs of steps that share the name run one at a time. Only for work on shared run tables or
   * global state. Other steps have at most one queued or running job per repo (security-fix: per finding), and the
   * `step_parallel` setting limits how many repos one step works at once.
   */
  exclusive?: string;
  params: ParamDef[];
  /** Models the step calls, known before any call is made: a list, or derived from the params. Empty or absent for steps that call none. */
  models?: string[] | ((params: Params) => string[]);
  /** null when the step can run; otherwise why not, shown on the page. */
  available?: () => string | null;
  /** Checks a request beyond the schema (null = fine), at request time and again before the run. */
  check?: (db: Db, params: Params) => Promise<Promise<string | null> | string | null>;
  /** Runs the step in the job's child process and returns a one-line summary. */
  run: (ctx: StepContext) => Promise<string>;
};

/** Creating a repo's labels, a repo-level write, is for repos in the pipeline scope that an operator approved for labelling on the Repos page. */
async function checkApproved(db: Db, p: Params): Promise<string | null> {
  const { repoApproved } = await import("../core/repo-approvals.ts");
  const { inRepoScope } = await import("./scope.ts");
  if (!await inRepoScope(db, String(p.repo), "work")) return `${p.repo} is not in the pipeline scope`;
  return await repoApproved(db, String(p.repo), "labels") ? null : `labelling ${p.repo} is not approved`;
}

export function modelsOf(step: StepDef | undefined, params: Params): string[] {
  const m = step?.models;
  return typeof m === "function" ? m(params) : (m ?? []);
}

/** Models that run on a Task Runner (everything but Jev). */
export const usesClaude = (models: string[]): boolean => models.some((m) => m !== "jev");

/** The nightly checks run only for repos whose build feature is switched on. */
async function checkNightlyOn(db: Db, p: Params): Promise<string | null> {
  return await featureOn(db, "nightly", String(p.repo)) ? null : `the Nightly checks feature is off for ${p.repo}`;
}

/** Acting on a red default branch is opt-in per repo. */
async function checkMainFixApproved(db: Db, p: Params): Promise<string | null> {
  const { repoApproved } = await import("../core/repo-approvals.ts");
  return await repoApproved(db, String(p.repo), "mainfix") ? null : `fixing a red main in ${p.repo} is not approved`;
}

/** Comments and closes are opt-in per repo: tracked repos include ones we do not maintain. */
async function checkCommentApproved(db: Db, p: Params): Promise<string | null> {
  const { repoApproved } = await import("../core/repo-approvals.ts");
  return await repoApproved(db, String(p.repo), "comment") ? null : `commenting in ${p.repo} is not approved`;
}

/** The `implement` buckets this build carries out. */
const IMPLEMENT_BUILT: ReadonlySet<string> = new Set(["plan", "build", "revise"]);

/** An implementation needs the repo's Implement switch and someone its live workflow acts for who settles on the repo. */
async function checkImplement(db: Db, p: Params): Promise<string | null> {
  const { implementRefusal } = await import("../implement/gate.ts");
  const bucket = String(p.bucket ?? "plan");
  if (!IMPLEMENT_BUILT.has(bucket)) return `Implement's ${bucket} work is not built yet`;
  // A dry run writes nothing but its workspace and model call, so it may run before the repo's Implement switch is on;
  // it still needs the repo's approval and a queuer who settles on the repo, whose Task Runner runs the call.
  if (p.mode === "dry" && bucket !== "plan") return "a dry run only plans";
  return await implementRefusal(db, String(p.repo), Number(p.number), { dry: p.mode === "dry" });
}

const SECURITY_FINDING_PARAMS: ParamDef[] = [
  { name: "repo", label: "Repo", kind: "repo", required: true },
  { name: "number", label: "Finding", kind: "int", min: 1, max: 1_000_000_000, required: true, help: "the finding's number in the repo" },
];

/** The finding exists and is in a state the step works on. */
async function securityFindingCheck(db: Db, p: Params, states: string[]): Promise<string | null> {
  const key = findingKey(String(p.repo), Number(p.number));
  const row = (await loadFindings(db, [key], { internal: true })).get(key);
  if (!row) return "no such finding";
  return states.includes(row.state) ? null : `the finding is ${row.state}`;
}

async function securityLandDeps(ctx: StepContext): Promise<import("../security/land.ts").LandDeps> {
  const { exec, fixupDir } = await import("../fixup/git.ts");
  const { whoAmI } = await import("../fixup/index.ts");
  return { exec, root: fixupDir(), who: () => whoAmI(exec), log: ctx.log };
}

/** The run number a step records in agent_runs.stage: its stage's, from the registry. */
function runStage(step: string): number {
  const s = stageOfStep(step);
  if (!s) throw new Error(`step ${step} is in no stage of the registry`);
  return s.runStage;
}

export const STEPS: StepDef[] = [
  {
    name: "classify-new",
    title: "Classify new and changed items",
    description: "Jev labels open items that have no verdict in the current classification run, or whose text changed since; Haiku gives a second opinion where Jev is under 90 % sure.",
    stage: runStage("classify-new"),
    requires: "operator",
    exclusive: "classify",
    models: ["jev", "haiku"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 5000, default: 500, help: "items per model in this job" }],
    run: async (ctx) => (await import("./classify.ts")).classifyNew(ctx),
  },
  {
    name: "classify-all",
    title: "Classification pass",
    description: "Jev labels every open item of the tracked repos into the given run, then Haiku the ones Jev is unsure of. A stopped pass continues where it left off when started again with the same run id; once complete, the run becomes the current one.",
    stage: runStage("classify-all"),
    requires: "operator",
    exclusive: "classify",
    models: ["jev", "haiku"],
    params: [
      { name: "run", label: "Run id", kind: "run-id", required: true, help: "lowercase letters, digits and dashes" },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 30000, default: 30000, help: "items per model in this job" },
    ],
    run: async (ctx) => (await import("./classify.ts")).classifyAll(ctx),
  },
  {
    name: "embed",
    title: "Embed items",
    description: "Computes local sentence embeddings of new and changed items for similar items and semantic search. Runs on this machine; no model quota.",
    stage: runStage("embed"),
    requires: "operator",
    exclusive: "embed",
    params: [
      { name: "all", label: "Every item", kind: "enum", options: ["no", "yes"], default: "no", help: "yes embeds all items again, not only new and changed ones" },
      { name: "threads", label: "Threads", kind: "int", min: 1, max: 8, default: 4 },
    ],
    run: async (ctx) => {
      const { embedCommand } = await import("../embed/index.ts");
      ctx.handled(await embedCommand([...(ctx.params.all === "yes" ? ["--all"] : []), "--threads", String(ctx.params.threads)], ctx.handled));
      return ctx.params.all === "yes" ? "embedded every item" : "embedded new and changed items";
    },
  },
  {
    name: "labels-ensure",
    title: "Create the pipeline labels on GitHub",
    description: "Creates the labels of the set that the repo is missing. Refused unless the operator has approved labelling for that repo.",
    stage: runStage("labels-ensure"),
    requires: "operator",
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    check: checkApproved,
    run: async (ctx) => {
      const repo = String(ctx.params.repo);
      const refused = await checkApproved(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const { ensureLabels } = await import("../labels/github.ts");
      const { Client } = await import("../mirror.ts");
      const missing = await ensureLabels(new Client(500), repo, true, { db: ctx.db, login: ctx.job.requestedBy }, undefined, byOfJob(ctx.job.requestedBy));
      for (const l of missing) ctx.log(`${repo}: created "${l.name}"`);
      return missing.length ? `created ${missing.length} labels on ${repo}` : `${repo}: all labels exist`;
    },
  },
  {
    name: "labels-apply",
    title: "Apply labels on GitHub",
    description: "Puts the settled type label and flags of the current classification run onto the open items of one repo on GitHub, in a repo approved for labelling.",
    stage: runStage("labels-apply"),
    requires: "operator",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 5000, default: 500, help: "items to label in this job" },
    ],
    // No repo check: whether an item's labels may be written is its action's own permission.
    run: async (ctx) => {
      const repo = String(ctx.params.repo);
      const { classifyRun } = await import("../data/triage/index.ts");
      const runId = await classifyRun(ctx.db);
      if (!runId) throw new Error("there is no classification run yet");
      const { applyLabels, ensureLabels } = await import("../labels/github.ts");
      const { Client } = await import("../mirror.ts");
      // Approval for labelling covers creating the set's labels the repo lacks.
      for (const l of await ensureLabels(new Client(500), repo, true, { db: ctx.db, login: ctx.job.requestedBy }, undefined, byOfJob(ctx.job.requestedBy))) ctx.log(`${repo}: created "${l.name}"`);
      // Stop starting batches 5 minutes before the job's deadline so it ends as done; the items left go in the next job.
      const limit = Number(ctx.params.limit);
      const stopAt = Date.parse(ctx.job.startedAt) + (stepDeadlineMin("labels-apply", limit) - 5) * 60_000;
      const r = await applyLabels(ctx.db, new Client(500), repo, { runId, limit, stopAt: Number.isNaN(stopAt) ? undefined : stopAt, apply: true, login: ctx.job.requestedBy, by: byOfJob(ctx.job.requestedBy), log: ctx.log, onLabeled: ctx.handled });
      return `${repo}: labelled ${r.labeled} of ${r.planned} items in ${r.batches} batches, ${r.failed.length} failed${r.stopped ? "; stopped before the time limit, the rest go in the next job" : ""}${r.paced ? "; paused for the GitHub write budget, the rest go in the next job" : ""}${r.held ? `; ${r.held}` : ""}`;
    },
  },
  {
    name: "main-ci",
    title: "Read CI on the default branches",
    description: "Reads the head commit and the checks of the default branch of every synced repo from GitHub in one query, and stores the state of each: green, red, optional failing, running or no CI. Writes nothing to GitHub.",
    stage: runStage("main-ci"),
    requires: "operator",
    params: [{ name: "repo", label: "Repo", kind: "repo", help: "every synced repo when empty" }],
    run: async (ctx) => {
      const { pollMainCi } = await import("../mainci/index.ts");
      const { Client } = await import("../mirror.ts");
      const r = await pollMainCi(ctx.db, new Client(1000), typeof ctx.params.repo === "string" ? ctx.params.repo : undefined, ctx.log);
      ctx.handled(r.heads);
      return `read the default branch of ${r.repos} repos`;
    },
  },
  {
    name: "checks",
    title: "Refresh CI and merge state",
    description: "Reads the CI and merge state of every open pull request of one repo from GitHub. Writes nothing to GitHub.",
    stage: runStage("checks"),
    requires: "operator",
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    run: async (ctx) => {
      const { runChecks } = await import("../review/index.ts");
      const r = await runChecks(ctx.db, { repo: String(ctx.params.repo) }, ctx.log);
      ctx.handled(r.prs);
      return `${ctx.params.repo}: refreshed ${r.prs} open pull requests`;
    },
  },
  {
    name: "merge",
    title: "Merge queued pull requests",
    description: "Lands the pull requests of one repo that may merge in integration batches: up to 10 at a time are merged into one integration branch, checked in the sandbox, opened as one pull request on the storytold repo and merged with merge commits through the safe-merge command once upstream CI is green. A failed batch is split in half; a single failing PR is held. Pull requests in a repo the sandbox cannot build are merged one at a time. When a few pull requests are ready (at most the single-merge limit, 3 by default), each is mergeable with green CI and no two change the same file, they are merged one at a time in order without a batch; each is checked again just before its merge and the first that is no longer ready ends the round.",
    stage: runStage("merge"),
    requires: "operator",
    models: [],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 500, default: 10, help: "pull requests to start or merge in this job" },
    ],
    // No repo check: whether a PR may merge is its own (src/core/may.ts), applied by the step to each PR.
    run: async (ctx) => {
      const { runMerge } = await import("../merge/index.ts");
      const { runBatches } = await import("../merge/batch.ts");
      const { runSingles } = await import("../merge/single.ts");
      const repo = String(ctx.params.repo), limit = Number(ctx.params.limit);
      const singly = await runSingles(ctx.db, { repo, limit, onMerged: ctx.handled, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      if (singly) {
        ctx.acted(singly.merged.length);
        return `${repo}: ${singly.merged.length} merged singly, ${singly.refused.length} refused`;
      }
      // Batches land under what the day's merge limit leaves, read again before each landing, not under this job's share of it (the
      // share bounds what it starts). The day's usage counts this job's items as far as they were written; the rest of what it landed
      // is taken off here.
      const { limitRow, usageToday } = await import("./autopilot.ts");
      const { loadJobs } = await import("../data/jobs/index.ts");
      // A resumed job's row already holds its earlier runs' items; only what this run wrote counts against what it landed.
      const writtenNow = async () => Number((await loadJobs(ctx.db, [ctx.job.id])).get(ctx.job.id)?.items ?? 0);
      const itemsBefore = await writtenNow();
      const dayLeft = async (landed: number): Promise<number> => {
        const perDay = (await limitRow(ctx.db, "merge")).perDay;
        if (perDay === null) return Infinity;
        return perDay - await usageToday(ctx.db, "merge") - Math.max(0, landed - (await writtenNow() - itemsBefore));
      };
      const b = await runBatches(ctx.db, { repo, limit, onMerged: ctx.handled, by: byOfJob(ctx.job.requestedBy), dayLeft }, ctx.log);
      ctx.usageRun(b.runId);
      let single = { merged: [] as string[], attempted: [] as string[], refused: [] as unknown[] };
      if (limit > b.merged.length) {
        single = await runMerge(ctx.db, { repo, limit: limit - b.merged.length, dryRun: false, singleOnly: true, onMerged: (n) => ctx.handled(b.merged.length + n), by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      }
      ctx.acted(b.started.length + b.published.length + b.split.length + b.superseded.length + b.failed.length + single.merged.length + b.merged.length);
      return `${repo}: ${b.merged.length} merged in batches (${b.started.length} started, ${b.published.length} opened, ${b.split.length} split), ${single.merged.length} merged singly`;
    },
  },
  {
    name: "act",
    title: "Comment and close",
    description: "Posts one short comment on each item a maintainer told AutoCraft to close and closes it as that maintainer. Skips an item that already closed or whose PR head moved; waits for a maintainer who has to sign in. Also carries out queued card presses and opens the follow-up issues cards held until their PR merged. Calls no model.",
    stage: runStage("act"),
    requires: "operator",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 20, help: "items to act on in this job" },
    ],
    // No repo check: a close is a person's command, and every card press and held issue is guarded by itself.
    run: async (ctx) => {
      const { runAct } = await import("../act/index.ts");
      const r = await runAct(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), dryRun: false, onHandled: ctx.handled, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.acted(r.done.length + r.asked.length + r.skipped.length + r.failed.length + (r.cards ?? 0) + (r.held ?? 0));
      const line = `${r.repo}: ${r.done.length} closed, ${r.asked.length} authors asked, ${r.skipped.length} skipped, ${r.failed.length} failed${r.cards ? `, ${r.cards} queued presses carried out` : ""}${r.held ? `, ${r.held} held follow-up issues filed or dropped` : ""}`;
      // A failed close ends the job as failed, so the registered failure backoff spaces its next tries (a close stops after ACT_MAX_ATTEMPTS).
      if (r.failed.length) throw new Error(`${line}; ${r.failed[0]!.ref}: ${r.failed[0]!.reason}`);
      // Starts with the pacing message, so the failure backoff skips it like any paced job and the next pass runs it again.
      if (r.paced) throw new Error(`${r.paced}; ${line}`);
      return line;
    },
  },
  {
    name: "fixup",
    priority: 1,
    title: "Fix up take-fix pull requests",
    description: "For take-fix pull requests we may push to, Sonnet turns the review's fix list into a diff that is checked and applied on top of the reviewed head, checked by Opus, pushed to the contributor's branch and noted with one short comment. For a pull request it cannot push to, in a repo approved for comments, it posts the fixes as one comment instead. The new head is reviewed again.",
    stage: runStage("fixup"),
    requires: "operator",
    models: ["sonnet", "opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 5, help: "pull requests to fix up in this job" },
      LANE_PARAM,
      PR_PARAM,
      HEAD_PARAM,
    ],
    // No repo check: whether we may push to a PR is its own (src/core/may.ts), and the planner plans only what is approved.
    run: async (ctx) => {
      const { runFixup } = await import("../fixup/index.ts");
      const r = await runFixup(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), approved: approvedLane(ctx.params), ...onlyPr(ctx.params), dryRun: false, onHandled: ctx.handled, stopping: ctx.stopping, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.acted(r.pushed.length + r.asked.length + r.failed.length + r.held.length);
      return `${r.repo}: pushed ${r.pushed.length}, ${r.asked.length} asked, ${r.failed.length} failed or refused, ${r.held.length} held`;
    },
  },
  {
    name: "verify",
    priority: 1,
    title: "Plan verification of taken pull requests",
    description: "Sonnet decides per taken pull request of one repo whether CI is enough, or which crates and tests a build machine should run, or (bug fixes) a regression test that fails before the change. Queues the build tasks; reads GitHub, writes nothing to it.",
    stage: runStage("verify"),
    requires: "operator",
    models: ["sonnet"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10, help: "PRs to plan in this job" },
    ],
    run: async (ctx) => {
      const { runVerify } = await import("../verify/index.ts");
      const r = await runVerify(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), onHandled: ctx.handled, stopping: ctx.stopping, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.usageRun(r.runId);
      // PRs skipped because GitHub could not be read (crates, diff, base) would otherwise leave an idle job that waits for its PRs to
      // change: failing it retries them after the failed-job backoff.
      if (!r.handled && r.skipped.length) throw new Error(`${r.repo}: planned none of ${r.candidates} candidates; GitHub could not be read for ${r.skipped.join(", ")}`);
      const k = Object.entries(r.kinds).map(([x, n]) => `${n} ${x}`).join(", ");
      return `${r.repo}: planned ${r.handled} of ${r.candidates} candidates${k ? ` (${k})` : ""}; ${r.errors} errors, ${r.tasks.length} tasks queued`;
    },
  },
  {
    name: "verify-collect",
    priority: 1,
    title: "Collect verification results",
    description: "Reads the finished build tasks of each pending verification and sets passed, failed or error from their exit codes. For a failure, Haiku summarises the log; the failure becomes a hold. Cancels the tasks of a PR whose head moved on, and queued warm builds of a branch that moved on.",
    stage: runStage("verify-collect"),
    requires: "operator",
    models: ["haiku"],
    params: [],
    run: async (ctx) => {
      const { runCollect } = await import("../verify/results.ts");
      const r = await runCollect(ctx.db, { stopping: ctx.stopping }, ctx.log);
      ctx.usageRun(r.runId);
      ctx.handled(r.changed);
      return `${r.looked} pending: ${r.passed} passed, ${r.failed} failed, ${r.errors} errors, ${r.retried} retried, ${r.stale} stale, ${r.running} running; ${r.warmCancelled} warm builds cancelled`;
    },
  },
  {
    name: "pr-build",
    priority: 1,
    title: "Build pull requests",
    description: "Queues our own workspace build of open pull request heads of one repo (outside authors' PRs, or every PR, as the repo's scope says) and records the finished ones. A second opinion beside upstream CI: it never holds a PR; a build that fails where CI passed is noted on the item. No model call, nothing written to GitHub.",
    stage: runStage("pr-build"),
    requires: "operator",
    models: [],
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    run: async (ctx) => {
      const { runPrBuilds } = await import("../prbuild/index.ts");
      const r = await runPrBuilds(ctx.db, String(ctx.params.repo), ctx.log);
      ctx.handled(r.queued + r.passed + r.failed + r.errors + r.stale + r.retried);
      return `${ctx.params.repo}: ${r.queued} queued, ${r.passed} passed, ${r.failed} failed (${r.disagreements} where CI passed), ${r.errors} errors, ${r.stale} stale, ${r.retried} retried`;
    },
  },
  {
    name: "prioritize",
    title: "Prioritize open items",
    description: "Jev rates the priority level (P0 to P4, P4 = backlog) of open items whose text has no priority yet; Haiku decides where Jev is under 90 % sure. Then every item's reach (the tie-breaker inside a level) is recomputed from comments, linked PRs, duplicates, age and the security flag.",
    stage: runStage("prioritize"),
    requires: "operator",
    models: ["jev", "haiku"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 30000, default: 1000, help: "items sent to Jev in this job" }],
    run: async (ctx) => {
      const { runPrioritize } = await import("../priority/index.ts");
      const r = await runPrioritize(ctx.db, { limit: Number(ctx.params.limit), onSent: ctx.handled, cancelled: ctx.cancelled, log: ctx.log, by: byOfJob(ctx.job.requestedBy) });
      return r.due ? `rated ${r.saved} of ${r.sent} items (${r.jev} by Jev, ${r.haiku} by Haiku), ${r.due - r.sent > 0 ? r.due - r.sent : 0} left; ${r.rescored} reach values changed` : `nothing new to rate; ${r.rescored} reach values changed`;
    },
  },
  {
    name: "dupes",
    title: "Find duplicates",
    description: "Looks up the nearest neighbours of new and changed open items in the same repo, among open items and items closed in the last year. Jev checks each pair; Haiku gives a second opinion where Jev is under 90 % sure either way. A confirmed duplicate is a signal on both items; it closes nothing and holds back only a pull request nobody started. Writes nothing to GitHub.",
    stage: runStage("dupes"),
    requires: "operator",
    exclusive: "dupes",
    models: ["jev", "haiku"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 5000, default: 2000, help: "pairs to check in this job" }],
    run: async (ctx) => {
      const { runDupes } = await import("../dupes/index.ts");
      const r = await runDupes(ctx.db, { limit: Number(ctx.params.limit), onHandled: ctx.handled, progress: ctx.progress, cancelled: ctx.cancelled, timeUp: ctx.timeUp, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      const v = Object.entries(r.verdicts).map(([k, n]) => `${n} ${k}`).join(", ");
      ctx.acted(r.scanned + r.pairsAdded);
      return `scanned ${r.scanned} items, ${r.pairsAdded} new pairs; checked ${r.checked}${v ? ` (${v})` : ""}${r.left ? `, ${r.left} left for a later job` : ""}`;
    },
  },
  {
    name: "implement",
    priority: 1,
    title: "Implement issues",
    description: "Works one queued issue on workspace sessions: plans it with Opus (asking when the issue leaves facts or choices open), writes the change and its tests, runs the formatter, clippy and the tests in the workspace, and opens the pull request; or revises our open PR. Every model call runs on the Task Runner of the person who queued the issue",
    stage: runStage("implement"),
    requires: "operator",
    models: ["opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "number", label: "Issue", kind: "int", min: 1, max: 1_000_000_000, required: true, help: "the queued issue" },
      { name: "bucket", label: "Work", kind: "enum", options: [...IMPLEMENT_BUCKETS], default: "plan", help: "plan, build from the stored plan, or revise our PR" },
      { name: "mode", label: "Mode", kind: "enum", options: ["normal", "dry"], default: "normal", cliOnly: true, help: "dry: plan only, storing and posting nothing (`implement run --plan-only --no-post`)" },
      IMPLEMENT_LANE_PARAM,
    ],
    check: checkImplement,
    run: async (ctx) => {
      const refused = await checkImplement(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const repo = String(ctx.params.repo), number = Number(ctx.params.number);
      if (ctx.params.mode !== "dry") await (await import("../implement/gate.ts")).moveTurns(ctx.db, repo, number);
      // The item page and the Now feed find the job by its item: its outcome, or its failure, is the job item.
      const { jobItem } = await import("./job-items.ts");
      try {
        if (String(ctx.params.bucket ?? "plan") === "plan") {
          const { runPlan } = await import("../implement/plan.ts");
          const summary = await runPlan(ctx, { repo, number, dry: ctx.params.mode === "dry" });
          await jobItem(ctx.db, repo, number, summary, ctx.log);
          return summary;
        }
        const run = { ...ctx, startedMs: Date.parse(ctx.job.startedAt), by: byOfJob(ctx.job.requestedBy) };
        ctx.handled(1);
        let r: { summary: string; moved: boolean };
        if (String(ctx.params.bucket) === "revise") {
          const { runRevise } = await import("../implement/revise.ts");
          r = await runRevise(run, repo, number);
        } else {
          const { runBuild } = await import("../implement/build.ts");
          r = await runBuild(run, repo, number);
        }
        if (r.moved) ctx.acted(1);
        await jobItem(ctx.db, repo, number, r.summary, ctx.log);
        return r.summary;
      } catch (e) {
        // A skip for want of a Task Runner or a stop is no outcome of the item's.
        const { NoTakerError, StoppedError } = await import("../agents/call.ts");
        if (!(e instanceof NoTakerError || e instanceof StoppedError)) await jobItem(ctx.db, repo, number, `failed: ${(e as Error).message}`, ctx.log);
        throw e;
      }
    },
  },
  {
    name: "workspace-try",
    priority: 1,
    title: "Workspace session",
    description: "An operator's test of a model session in a workspace pod: creates the workspace (or takes a live one), waits for it to be ready, runs one session with the implementation model through the workspace tools, and logs the outcome, cost, tool calls, shell time and the diff stat. Started only with `workspace try` on the command line; nothing goes to GitHub.",
    stage: runStage("workspace-try"),
    requires: "operator",
    models: [CLAUDE_PROMPTS["implement.session"].models[0]],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "session", label: "Session", kind: "int", min: 1, max: 1_000_000_000, required: true, help: "the session row `workspace try` created" },
    ],
    check: async (db, p) => {
      const { checkTrySession } = await import("../build/workspace-session.ts");
      return await checkTrySession(db, p);
    },
    run: async (ctx) => {
      const { runTrySession } = await import("../build/workspace-session.ts");
      return await runTrySession(ctx);
    },
  },
  {
    name: "security-scan",
    priority: 2,
    title: "Security deep scan",
    description: "Audits the default branch of a repo for vulnerabilities: Opus builds a threat model and splits the code into areas, scans each area read-only, then tries to disprove every finding. Started only by an operator on the repo page, with an optional spend cap; findings are visible to operators and maintainers only and nothing goes to GitHub.",
    stage: 9,
    requires: "operator",
    models: ["opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "scan", label: "Scan", kind: "int", min: 1, max: 1_000_000_000, required: true, help: "the scan row the API created" },
    ],
    check: async (db, p) => {
      const row = (await loadScans(db, [Number(p.scan)])).get(Number(p.scan));
      if (!row || row.repo !== p.repo) return "no such scan";
      return ["modeling", "scanning", "verifying"].includes(row.state) ? null : `the scan already ended (${row.state})`;
    },
    run: async (ctx) => {
      const { runScan } = await import("../security/scan.ts");
      const { realDeps } = await import("../security/real.ts");
      const { usageRunId } = await import("../security/real.ts");
      ctx.usageRun(usageRunId(Number(ctx.params.scan)));
      const { autoFixConfirmed } = await import("../security/actions.ts");
      const deps = realDeps(ctx.db, Number(ctx.params.scan), { cancelled: ctx.cancelled, log: ctx.log, progress: ctx.progress, resumes: ctx.job.resumes });
      return runScan(ctx.db, Number(ctx.params.scan), { ...deps, confirmed: (n) => autoFixConfirmed(ctx.db, String(ctx.params.repo), n) });
    },
  },
  {
    name: "security-fix",
    priority: 2,
    title: "Security fix",
    description: "Writes the private fix of one finding on the scan's pinned commit: Opus writes the patch and a regression test, the worker container builds and tests it, and Opus reviews the diff. A failed round is repeated in the same model session while the prompt cache is warm. With fix sessions on for security fixes (setting fix_sessions), each round is a turn of the finding's fix session instead: Opus edits the tree of a workspace in a confidential kubernetes environment seeded at the pinned commit and runs the crate's tests there, and a failed round goes back to the same session. The commit stays in the local cache and is never pushed. Starts on its own when verify confirms the finding, once per finding; after a failed fix an operator starts it again from the finding page. Nothing goes to GitHub.",
    stage: 9,
    requires: "operator",
    models: ["opus"],
    params: SECURITY_FINDING_PARAMS,
    check: async (db, p) => securityFindingCheck(db, p, ["fixing"]),
    run: async (ctx) => {
      const { runFix, defaultFixDeps } = await import("../security/fix.ts");
      const { usageRunId } = await import("../security/real.ts");
      const { rawFinding } = await import("../security/store.ts");
      const repo = String(ctx.params.repo), n = Number(ctx.params.number);
      const scan = (await rawFinding(ctx.db, repo, n))!.scan_id;
      ctx.usageRun(usageRunId(scan));
      const { leaseItem } = await import("./leases.ts");
      const release = await leaseItem(ctx.db, `finding:${repo}#${n}`, ctx.log);
      if (!release) return `${repo}#${n}: another job is working this finding`;
      try {
        return await runFix(ctx.db, repo, n, defaultFixDeps(ctx.db, scan, { cancelled: ctx.cancelled, log: ctx.log }));
      } finally { await release(); }
    },
  },
  {
    name: "security-land",
    priority: 2,
    title: "Land a security fix",
    description: "Opens the finding's fix as a plain pull request from the pipeline's fork, with a neutral branch, title and description. The normal Verify and merge path takes it from there. Started only by an operator.",
    stage: 9,
    requires: "operator",
    exclusive: "security-write",
    params: SECURITY_FINDING_PARAMS,
    check: async (db, p) => securityFindingCheck(db, p, ["landing"]),
    run: async (ctx) => {
      const { runLand } = await import("../security/land.ts");
      return runLand(ctx.db, String(ctx.params.repo), Number(ctx.params.number), byOfJob(ctx.job.requestedBy), await securityLandDeps(ctx));
    },
  },
  {
    name: "security-advisory",
    priority: 2,
    title: "Security advisory route",
    description: "For an urgent finding: creates the draft advisory and its private fork, pushes the fix there with the box account's token and opens the pull request inside the fork. A repository admin merges it on the advisory page. Started only by an operator.",
    stage: 9,
    requires: "operator",
    exclusive: "security-write",
    params: SECURITY_FINDING_PARAMS,
    check: async (db, p) => securityFindingCheck(db, p, ["landing"]),
    run: async (ctx) => {
      const { runAdvisory } = await import("../security/land.ts");
      return runAdvisory(ctx.db, String(ctx.params.repo), Number(ctx.params.number), byOfJob(ctx.job.requestedBy), await securityLandDeps(ctx));
    },
  },
  {
    name: "security-publish",
    priority: 2,
    title: "Publish a security advisory",
    description: "Publishes the finding's advisory after a release, and requests a CVE when asked (public repositories only). Started only by an operator.",
    stage: 9,
    requires: "operator",
    exclusive: "security-write",
    params: [...SECURITY_FINDING_PARAMS, { name: "cve", label: "CVE", kind: "int", min: 0, max: 1, default: 0, help: "1 to request a CVE" }],
    check: async (db, p) => securityFindingCheck(db, p, ["landed", "advisory"]),
    run: async (ctx) => {
      const { runPublish } = await import("../security/land.ts");
      return runPublish(ctx.db, String(ctx.params.repo), Number(ctx.params.number), byOfJob(ctx.job.requestedBy), Number(ctx.params.cve) === 1, await securityLandDeps(ctx));
    },
  },
  {
    name: "rank",
    title: "Rank open items",
    description: "Computes the work rank of every open item: priority level (raised by one for the security flag), type label, size (changed lines of a PR, the Fix triage's estimate for an issue), then reach. Review, Fix (which skips P4), Verify, Fix-up, Decide and the merge queue take their items in this order. Calls no model and writes nothing to GitHub.",
    stage: runStage("rank"),
    requires: "operator",
    exclusive: "rank",
    models: [],
    params: [],
    run: async (ctx) => {
      const { runRank } = await import("../rank/index.ts");
      const r = await runRank(ctx.db);
      ctx.handled(r.changed + r.removed);
      return `${r.items} open items ranked, ${r.changed} changed, ${r.removed} removed`;
    },
  },
  {
    name: "referee",
    title: "Referee label disagreements",
    description: "Sonnet settles items where Jev and Haiku chose different type labels. A sure answer settles the type. When Sonnet is unsure, Opus answers; its label settles the item either way, and an unsure Opus keeps the item off the automatic merge path.",
    stage: runStage("referee"),
    requires: "operator",
    models: ["sonnet", "opus"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 500, default: 100, help: "items sent to the referee models in this job" }],
    run: async (ctx) => {
      const { classifyRun } = await import("../data/triage/index.ts");
      const { refereeItems } = await import("../classify/referee.ts");
      const { itemOf, plannedItems } = await import("../core/select-items.ts");
      const run = await classifyRun(ctx.db);
      if (!run) throw new Error("There is no classification run yet; start a classification pass first.");
      const { takersFirst } = await import("../agents/call.ts");
      const due = (await takersFirst(ctx.db, await plannedItems(ctx.db, "referee", { run, by: byOfJob(ctx.job.requestedBy) }), (p) => [p.facts.repo], (p) => [p.facts])).slice(0, Number(ctx.params.limit));
      if (!due.length) return `Nothing to referee in run ${run}.`;
      const asked = async (source: string) => await mapSeq(due.filter((p) => p.action.params?.source === source), async (p) => await itemOf(ctx.db, p.facts.repo, p.facts.number));
      const sonnet = await asked("sonnet"), opus = await asked("opus");
      let sent = 0;
      const onSent = (n: number) => ctx.handled(sent + n);
      const gotSonnet = sonnet.length ? await refereeItems(ctx.db, run, sonnet, { pipeline: true, onSent, cancelled: ctx.cancelled }) : 0;
      sent += sonnet.length;
      const gotOpus = opus.length ? await refereeItems(ctx.db, run, opus, { pipeline: true, model: "opus", onSent, cancelled: ctx.cancelled }) : 0;
      ctx.usageRun(run);
      return `Run ${run}: Sonnet answered ${gotSonnet} of ${sonnet.length}, Opus ${gotOpus} of ${opus.length} disagreements.`;
    },
  },
  {
    name: "opus-review",
    priority: 1,
    title: "Review pull requests",
    description: "Opus reviews, one pull request per call, the pull requests we want from one repo: take, take with fixes, hold or close. After a new push it reads only the changes since the head it reviewed before. Its verdict and fix list are the ones every later stage reads.",
    stage: runStage("opus-review"),
    requires: "operator",
    models: ["opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10, help: "pull requests to review in this job" },
      LANE_PARAM,
      PR_PARAM,
      HEAD_PARAM,
    ],
    run: async (ctx) => {
      const { runOpusReview } = await import("../review/opus.ts");
      const r = await runOpusReview(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), approved: approvedLane(ctx.params), ...onlyPr(ctx.params), onHandled: ctx.handled, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.usageRun(r.runId);
      const v = Object.entries(r.verdicts).map(([k, n]) => `${n} ${k}`).join(", ");
      return `${r.repo}: reviewed ${r.reviewed} of ${r.candidates} candidates${v ? ` (${v})` : ""}; ${r.skipped.length} without a diff, ${r.off.length} off the automatic path, ${r.missing.length} without an answer`;
    },
  },
  {
    name: "review-carry",
    title: "Carry reviews",
    description: "Stores the earlier take or take-fix review on the new head of a pull request whose only new commit is our own checked fix-up. Calls no model, so it runs while models are paused. The Review step leaves such heads to it.",
    stage: runStage("review-carry"),
    requires: "operator",
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    run: async (ctx) => {
      const { runCarry } = await import("../review/carry-step.ts");
      const repo = String(ctx.params.repo);
      return `${repo}: carried ${await runCarry(ctx.db, repo, ctx.log, byOfJob(ctx.job.requestedBy))} reviews`;
    },
  },
  {
    name: "review-post",
    title: "Post final reviews",
    description: "Posts the final Opus review of each pull request of one repo as one pull request review (a comment, never an approval or a change request) that says it is AI-generated and names the model. A review at a new head edits the earlier one. Skips a pull request that closed or moved on. Calls no model.",
    stage: runStage("review-post"),
    requires: "operator",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 20, help: "reviews to post in this job" },
      LANE_PARAM,
      PR_PARAM,
      HEAD_PARAM,
    ],
    run: async (ctx) => {
      const { runReviewPost } = await import("../review/post.ts");
      const r = await runReviewPost(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), approved: approvedLane(ctx.params), ...onlyPr(ctx.params), dryRun: false, onHandled: ctx.handled, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      const line = `${r.repo}: ${r.posted.length} posted, ${r.edited.length} edited, ${r.skipped.length} skipped, ${r.failed.length} failed${r.note ? `; ${r.note}` : ""}`;
      // A review that could not be written stays due: a failed job backs off instead of trying again at once, a lane job for its own PR only.
      if (r.failed.length && !r.posted.length && !r.edited.length) throw new Error(`${line}; ${r.failed[0]!.ref}: ${r.failed[0]!.reason}`);
      return line;
    },
  },
  {
    name: "premerge",
    priority: 1,
    title: "Pre-merge review",
    description: "Opus reads, one pull request head per call, the diff of each PR the merge rule would merge without a person, independently of the first review, and lists defects and minor findings. The merge queue holds those PRs until the review is stored. Reads GitHub; writes only to the local database.",
    stage: runStage("premerge"),
    requires: "operator",
    models: ["opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10, help: "pull requests to review in this job" },
      LANE_PARAM,
      PR_PARAM,
      HEAD_PARAM,
    ],
    run: async (ctx) => {
      const { runPremerge } = await import("../premerge/review.ts");
      const r = await runPremerge(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), approved: approvedLane(ctx.params), ...onlyPr(ctx.params), onHandled: ctx.handled, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.usageRun(r.runId);
      return `${r.repo}: reviewed ${r.reviewed} of ${r.candidates.length} candidates; ${r.findings} findings (${r.defects} blocking defects, ${r.notBlocking} not blocking), ${r.failed.length} without an answer, ${r.off.length} off the path, ${r.moved.length} moved`;
    },
  },
  {
    name: "premerge-followups",
    title: "File follow-ups of approved merges",
    description: "For each pull request a maintainer approved for merge whose review found fixes or a hold that do not block the merge (they are not made), or whose pre-merge review found defects that do not stop it, opens one follow-up issue that lists them (where, what to change or what goes wrong, why it does not block) and links the pull request; later follow-ups are a comment on that issue. The merge waits for the try. Writes to GitHub in repos approved for comments, or as the approver's work.",
    stage: runStage("premerge-followups"),
    requires: "operator",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 20, help: "pull requests to file follow-ups for in this job" },
    ],
    run: async (ctx) => {
      const { runPremergeFollowups } = await import("../premerge/followups.ts");
      const r = await runPremergeFollowups(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), onHandled: ctx.handled, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.acted(r.filed.length + r.commented.length + r.failed.length);
      return `${r.repo}: ${r.filed.length} follow-up issues opened, ${r.commented.length} comments, ${r.failed.length} failed, ${r.skipped.length} skipped`;
    },
  },
  {
    name: "postmerge",
    title: "Review merged pull requests",
    description: "Opus reads, one pull request per call, what the merges of one repo that need a post-merge review landed, with our own commits and reviews of the PR, and lists defects and minor findings. Reads GitHub; writes only to the local database.",
    stage: runStage("postmerge"),
    requires: "operator",
    models: ["opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10, help: "merged pull requests to review in this job" },
    ],
    run: async (ctx) => {
      const { runPostmerge } = await import("../postmerge/review.ts");
      const r = await runPostmerge(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), onHandled: ctx.handled, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.usageRun(r.runId);
      return `${r.repo}: reviewed ${r.reviewed} of ${r.candidates} candidates; ${r.findings} findings (${r.defects} defects), ${r.failed.length} without an answer`;
    },
  },
  {
    name: "postmerge-file",
    title: "File post-merge defects as issues",
    description: "Opens one GitHub issue for each defect of a post-merge review that no open item covers yet, in a repo approved for comments. Minor findings are never filed. Refused unless the operator approved commenting for the repo. Calls no model.",
    stage: runStage("postmerge-file"),
    requires: "operator",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 20, help: "issues to open in this job" },
    ],
    check: checkCommentApproved,
    run: async (ctx) => {
      const { runPostmergeFile } = await import("../postmerge/file.ts");
      const refused = await checkCommentApproved(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const r = await runPostmergeFile(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), onHandled: ctx.handled, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.acted(r.filed.length + r.failed.length + r.unknown.length + r.settled);
      const line = `${r.repo}: ${r.filed.length} issues filed, ${r.limited} over the limit, ${r.failed.length} failed${r.unknown.length ? `, ${r.unknown.length} with an unknown outcome (check GitHub)` : ""}${r.settled ? `, ${r.settled} stopped filings settled` : ""}`;
      // As in Act: the failure backoff spaces the next try, and skips the write pacing's message.
      if (r.later) throw new Error(`${r.later}; ${line}`);
      return line;
    },
  },
  {
    name: "dupes-compare",
    title: "Compare duplicate groups",
    description: "Compares each group of duplicates in one pass: Opus, with read-only tools on the base checkout, for the pull requests of a group (diffs, titles, bodies and linked issues; CI and review state as background), Sonnet for its issues. It picks the best item to keep, and lists what the others do better or add. A closed or merged member wins without a call; a failed call falls back to the older-wins rule. A group is compared again only when a member's state, head or text changes. Writes nothing to GitHub.",
    stage: runStage("dupes-compare"),
    requires: "operator",
    exclusive: "dupes",
    models: ["opus", "sonnet"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 200, default: 20, help: "groups (per kind) to compare in this job" }],
    run: async (ctx) => {
      const { runDupeCompare } = await import("../dupes/compare.ts");
      const r = await runDupeCompare(ctx.db, { limit: Number(ctx.params.limit), onHandled: ctx.handled }, ctx.log);
      return `${r.due} due: ${r.compared} compared by a model, ${r.byRule} by rule, ${r.closedWins} won by a closed member, ${r.single} single, ${r.dropped} dropped`;
    },
  },
  {
    name: "conversation",
    priority: 1,
    title: "Answer conversations",
    description: "Answers each operator's message in an item's conversation with one Opus call, with read-only tools on the item's repository, the workspace and the item tools. The reply may propose action cards that a person runs with a button; nothing runs by itself. Messages are answered even for a repo whose pipeline is off. Each answered message counts as one item.",
    stage: runStage("conversation"),
    requires: "operator",
    models: ["opus"],
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 200, default: 30, help: "messages to answer in this job" }],
    run: async (ctx) => {
      const { runConversations } = await import("../conversations/run.ts");
      const r = await runConversations(ctx.db, { kind: "operator", limit: Number(ctx.params.limit), onHandled: ctx.handled, cancelled: ctx.cancelled }, ctx.log);
      ctx.usageRun(r.usageRun);
      return `${r.answered} of ${r.waiting} messages answered`;
    },
  },
  {
    name: "conversation-maintainer",
    priority: 1,
    title: "Answer maintainers' conversations",
    description: "Answers each maintainer's message in an item's conversation with one Opus call on that maintainer's own Task Runner, which takes it beside its other calls, with the same tools as the operators' conversations. A message none of their runners takes within two minutes waits for a later job. The reply may propose action cards; nothing runs by itself. These calls use the maintainers' own subscriptions, so the step has no daily limit and its messages do not count toward the operators' conversations.",
    stage: runStage("conversation-maintainer"),
    requires: "operator",
    models: ["opus"],
    params: [],
    run: async (ctx) => {
      const { runConversations } = await import("../conversations/run.ts");
      const r = await runConversations(ctx.db, { kind: "maintainer", onHandled: ctx.handled, cancelled: ctx.cancelled }, ctx.log);
      ctx.usageRun(r.usageRun);
      return `${r.answered} of ${r.waiting} messages answered`;
    },
  },
  {
    name: "areas-propose",
    title: "Propose areas",
    description: "One Opus call proposes the area list of a repo (10 to 25 areas with one-line descriptions), reading the repo's default branch, its docs and a sample of its open item titles. The proposal waits on the repo's page; nothing changes until an operator accepts it.",
    stage: runStage("areas-propose"),
    requires: "operator",
    models: ["opus"],
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    run: async (ctx) => {
      const { proposeAreas } = await import("../areas/propose.ts");
      const { baseCheckout } = await import("../dupes/compare.ts");
      const repo = String(ctx.params.repo), usageRun = jobRunId("areas", ctx.job);
      ctx.usageRun(usageRun);
      ctx.handled(1);
      const id = await proposeAreas(ctx.db, repo, { by: ctx.job.requestedBy, checkout: (r) => baseCheckout(ctx.db, r), usageRun, log: ctx.log });
      return id === null ? `${repo}: no usable proposal` : `${repo}: proposal ${id} is waiting for an operator`;
    },
  },
  {
    name: "areas-suggest",
    title: "Suggest areas",
    description: "Sonnet reads a sample of the repo's open items that have no area and suggests new areas for them. An operator accepts or ignores each suggestion; accepting saves a new list version and re-scans the unassigned items.",
    stage: runStage("areas-suggest"),
    requires: "operator",
    models: ["sonnet"],
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    run: async (ctx) => {
      const { suggestAreas } = await import("../areas/propose.ts");
      const repo = String(ctx.params.repo), usageRun = jobRunId("areas", ctx.job);
      ctx.usageRun(usageRun);
      ctx.handled(1);
      const id = await suggestAreas(ctx.db, repo, { by: ctx.job.requestedBy, usageRun, log: ctx.log });
      return id === null ? `${repo}: no new area suggested` : `${repo}: suggestion ${id} is waiting for an operator`;
    },
  },
  {
    name: "areas-rescan",
    title: "Re-scan areas",
    description: "Asks again for the open items of a repo that have no area (never asked, none of these, or unassigned by a removed area) against the repo's current area list: Jev first, Haiku where Jev is under 90 % sure or unavailable.",
    stage: runStage("areas-rescan"),
    requires: "operator",
    exclusive: "classify",
    models: ["jev", "haiku"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 30000, default: 5000, help: "items in this job" },
    ],
    run: async (ctx) => {
      const { assignAreas } = await import("../areas/assign.ts");
      const usageRun = jobRunId("areas", ctx.job);
      ctx.usageRun(usageRun);
      const r = await assignAreas(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), rescan: true, usageRun, onSent: ctx.handled, cancelled: ctx.cancelled, progress: ctx.progress, log: ctx.log });
      return `${ctx.params.repo}: ${r.due} items asked; Jev settled ${r.jev}, Haiku ${r.haiku}; ${r.none} fit none of the areas, ${r.left} unanswered`;
    },
  },
  {
    name: "unassign",
    title: "Unassign",
    description: "Takes the pipeline's account off the open pull requests and issues that left the path to merge (waiting on a person, given up by a stage, out of scope), so someone else may pick them up. Only its own assignment is removed, and only while it is the sole assignee; the assignees are read from GitHub before each write. Calls no model.",
    stage: runStage("unassign"),
    requires: "operator",
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    run: async (ctx) => {
      const { runUnassign } = await import("../unassign/index.ts");
      const repo = String(ctx.params.repo);
      const r = await runUnassign(ctx.db, { repo, by: byOfJob(ctx.job.requestedBy), runId: `unassign-${ctx.job.id}`, log: ctx.log });
      ctx.acted(r.unassigned.length);
      if (r.due && r.failed.length === r.due) throw new Error(`${repo}: could not unassign on ${r.failed.join(", ")}`);
      return `${repo}: ${r.unassigned.length} unassigned${r.failed.length ? `, ${r.failed.length} failed` : ""}`;
    },
  },
  {
    name: "pr-status",
    title: "PR status comments",
    description: "Keeps one status comment on each pull request the pipeline works on, in repos where the PR status switch is on, and on each issue or PR a person started or approved, in any repo: posted once the item is past triage or started, then edited in place when its status changes, and when it merges or closes. Calls no model.",
    stage: runStage("pr-status"),
    requires: "operator",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 2000, default: 100, help: "comments to post or edit in this job" },
    ],
    // No check on the repo's PR status switch: the comments of started items need none (src/prstatus/index.ts runPrStatus guards each write).
    run: async (ctx) => {
      const { runPrStatus } = await import("../prstatus/index.ts");
      const repo = String(ctx.params.repo);
      const r = await runPrStatus(ctx.db, { repo, by: byOfJob(ctx.job.requestedBy), runId: `pr-status-${ctx.job.id}`, limit: Number(ctx.params.limit), log: ctx.log });
      ctx.acted(r.posted.length + r.edited.length + r.pinged.length);
      if (r.due && r.failed.length === r.due) throw new Error(`${repo}: no status comment could be written (${r.failed.join(", ")})`);
      return `${repo}: ${r.posted.length} posted, ${r.edited.length} edited${r.pinged.length ? `, ${r.pinged.length} pinged` : ""}${r.pingFailed.length ? `, ${r.pingFailed.length} pings failed` : ""}${r.failed.length ? `, ${r.failed.length} failed` : ""}${r.gone.length ? `, ${r.gone.length} deleted on GitHub` : ""}${r.paced ? "; the rest wait for the write budget" : ""}`;
    },
  },
  {
    name: "ci-approve",
    title: "Approve waiting CI runs",
    description: "Approves the Actions runs that GitHub holds for a maintainer's approval on outside contributors' pull requests, once the PR's current head has a final take or take-fix review. Skips a PR that is closed, a draft or at another head. Calls no model.",
    stage: runStage("ci-approve"),
    requires: "operator",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 30, help: "pull requests to approve runs for in this job" },
    ],
    run: async (ctx) => {
      const { approveRuns } = await import("../merge/ci-approval.ts");
      const { ghExec } = await import("../merge/safe-merge.ts");
      const { exec } = await import("../fixup/git.ts");
      const repo = String(ctx.params.repo);
      const r = await approveRuns(ctx.db, repo, { gh: ghExec, exec, limit: Number(ctx.params.limit), log: ctx.log, by: byOfJob(ctx.job.requestedBy) });
      ctx.handled(r.approved.length + r.failed.length);
      if (r.failed.length) throw new Error(`${repo}: runs not approved on ${r.failed.join(", ")}`);
      return `${repo}: runs approved on ${r.approved.length} PRs, ${r.skipped.length} skipped`;
    },
  },
  {
    name: "cifix",
    priority: 1,
    title: "Fix failing CI on wanted pull requests",
    description: "For a take or take-fix pull request whose gate check fails at its reviewed head, reads the failed jobs' logs and sorts the failure. A formatter-only failure is fixed by running the formatter in a build environment. A code failure gets a Sonnet patch, checked by Opus, pushed to the contributor's branch or posted as a comment where the branch is closed to us; with fix sessions on for the step, the pull request's fix session makes the change in its workspace, building and testing there, in place of the patch. An infrastructure failure is left to the cifix-rerun step. At most two tries per head.",
    stage: runStage("cifix"),
    requires: "operator",
    models: ["sonnet", "opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 5, help: "pull requests to work on in this job" },
      LANE_PARAM,
      PR_PARAM,
      HEAD_PARAM,
    ],
    // No repo check: whether we may push to a PR is its own (src/core/may.ts), and the planner plans only what is approved.
    run: async (ctx) => {
      const { runCifix } = await import("../cifix/index.ts");
      const r = await runCifix(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), approved: approvedLane(ctx.params), ...onlyPr(ctx.params), dryRun: false, onHandled: ctx.handled, stopping: ctx.stopping, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      const acted = r.pushed.length + r.asked.length + r.queued.length + r.failed.length + r.held.length + r.infra.length;
      ctx.acted(acted + r.unasked.length);
      const line = `${r.repo}: pushed ${r.pushed.length}, ${r.asked.length} commented, ${r.queued.length} formatter runs queued, ${r.infra.length} infrastructure failures, ${r.failed.length + r.unasked.length} failed or refused, ${r.held.length} held${r.waiting.length ? `, ${r.waiting.length} waiting on a fix session (${r.waiting[0]!.reason})` : ""}`;
      // Asks that failed are all this job had: the failure backoff spaces their next try (and skips the write pacing's message).
      if (r.unasked.length && !acted) throw new Error(`${r.unasked[0]!.reason}; ${r.unasked[0]!.ref} not asked; ${line}`);
      return line;
    },
  },
  {
    name: "cifix-rerun",
    title: "Rerun CI jobs that failed on infrastructure",
    description: "Reruns the failed jobs of a wanted pull request whose failure the cifix step read as a network or runner error, once per head. Calls no model.",
    stage: runStage("cifix-rerun"),
    requires: "operator",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 30, help: "pull requests to rerun in this job" },
    ],
    run: async (ctx) => {
      const { runRerun } = await import("../cifix/index.ts");
      const r = await runRerun(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), dryRun: false, onHandled: ctx.handled, stopping: ctx.stopping, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      return `${r.repo}: reran ${r.reran.length} PRs, ${r.skipped.length} skipped`;
    },
  },
  {
    name: "main-fix",
    priority: 1,
    title: "Handle a red default branch",
    description: "For a repo approved for it whose default branch is red, reads the failed gate checks' logs and has Haiku sort each: a flaky failure gets its failed jobs rerun once, an infrastructure failure opens an issue in the repo, and a code failure is recorded as needing a fix and gets a fix PR (the CI fix patch path against the default branch head: Sonnet patch, Opus check, pushed to the pipeline account's fork) unless main is green again or an open PR already covers it.",
    stage: runStage("main-fix"),
    requires: "operator",
    models: ["haiku", "sonnet", "opus"],
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    check: checkMainFixApproved,
    run: async (ctx) => {
      const { runMainFix } = await import("../mainfix/index.ts");
      const refused = await checkMainFixApproved(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const r = await runMainFix(ctx.db, { repo: String(ctx.params.repo), onHandled: ctx.handled, stopping: ctx.stopping, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.acted(r.reran + r.needsFix + r.issues + r.prs);
      return `${r.repo}: classified ${r.classified} heads, reran ${r.reran}, ${r.needsFix} need a fix, ${r.issues} issues opened, ${r.prs} fix PRs opened${r.note ? `; ${r.note}` : ""}`;
    },
  },
  {
    name: "nightly",
    title: "Nightly checks",
    description: "For a repo with the Nightly checks build feature on, queues its selected checks (dependency audit, cross builds, Miri, benchmarks) once a day as low-priority sandbox tasks at the default branch head, and collects the results of finished ones. A check that fails two nights in a row is shown on the Nightly page, where a person opens an issue for it. Calls no model.",
    stage: runStage("nightly"),
    requires: "operator",
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }],
    check: async (db, p) => await checkNightlyOn(db, p),
    run: async (ctx) => {
      const { runNightly } = await import("../nightly/index.ts");
      const refused = await checkNightlyOn(ctx.db, ctx.params);
      if (refused) throw new Error(refused);
      const r = await runNightly(ctx.db, { repo: String(ctx.params.repo), onHandled: ctx.handled, by: byOfJob(ctx.job.requestedBy) }, ctx.log);
      ctx.acted(r.queued);
      return `${r.repo}: queued ${r.queued}, skipped ${r.skipped}, collected ${r.collected}`;
    },
  },
  {
    name: "issue-review",
    title: "Review issues",
    description: "Reviews the issues maintainers started with review: Opus reads each issue, its discussion and the repository at the default branch and gives one recommendation (implement, close, needs info, backlog), which Post issue reviews posts and the maintainer answers. A call is the started work of the issue's workflow: its starter's and approver's Task Runners take it first",
    stage: runStage("issue-review"),
    requires: "operator",
    models: ["opus"],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "number", label: "Issue", kind: "int", min: 1, max: 1_000_000_000, help: "only this issue; empty: every issue of the repo whose review is due" },
    ],
    run: async (ctx) => {
      const { runIssueReviews } = await import("../issuereview/run.ts");
      const r = await runIssueReviews(ctx.db, { repo: String(ctx.params.repo), ...(typeof ctx.params.number === "number" ? { number: ctx.params.number } : {}), by: byOfJob(ctx.job.requestedBy), jobId: ctx.job.id, onHandled: ctx.handled }, ctx.log);
      ctx.acted(r.reviewed);
      ctx.usageRun(r.runId);
      return `${r.reviewed} issues reviewed, ${r.failed} failed, ${r.waiting} waiting`;
    },
  },
  {
    name: "issue-review-post",
    title: "Post issue reviews",
    description: "Posts the stored issue reviews as one comment each, and a review's question to the reporter after a maintainer's yes. Calls no model, so it runs without a Task Runner and while models are paused",
    stage: runStage("issue-review-post"),
    requires: "operator",
    models: [],
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true },
      { name: "number", label: "Issue", kind: "int", min: 1, max: 1_000_000_000, help: "only this issue; empty: every issue of the repo with a post due" },
    ],
    run: async (ctx) => {
      const { runIssueReviews } = await import("../issuereview/run.ts");
      const r = await runIssueReviews(ctx.db, { repo: String(ctx.params.repo), ...(typeof ctx.params.number === "number" ? { number: ctx.params.number } : {}), by: byOfJob(ctx.job.requestedBy), jobId: ctx.job.id, post: true, onHandled: ctx.handled }, ctx.log);
      ctx.acted(r.posted + r.asked);
      return `${r.posted} reviews posted, ${r.asked} questions posted to reporters, ${r.failed} failed, ${r.waiting} waiting`;
    },
  },
  {
    name: "eval",
    title: "Self-evaluation",
    description: "Looks for stalls, loops, repeated failures and cost outliers in AutoCraft's own records, groups them by cause, and has Opus investigate each new or grown cause in the eval repo's code. Each real defect becomes one issue on the eval repo (setting eval_repo), new evidence a comment on it at most once a day. Runs once an hour while the setting is set; implements nothing.",
    stage: runStage("eval"),
    requires: "operator",
    models: ["opus"],
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true, help: "the eval repo (setting eval_repo)" }],
    check: async (db, p) => {
      const { evalRepo } = await import("../eval/schedule.ts");
      return await evalRepo(db) === String(p.repo) ? null : `${p.repo} is not the eval repo (autocraft-server eval repo <name>)`;
    },
    run: async (ctx) => {
      const { runEval } = await import("../eval/run.ts");
      const r = await runEval(ctx.db, { repo: String(ctx.params.repo), by: byOfJob(ctx.job.requestedBy), onHandled: ctx.handled, stopping: ctx.stopping }, ctx.log);
      if (r.note) throw new Error(r.note);
      ctx.usageRun(r.runId);
      const f = r.filing;
      ctx.acted(r.added + (f ? f.filed.length + f.commented.length + f.declined : 0));
      const line = `${r.groups} candidate groups, ${r.added} new pieces of evidence, ${r.investigated} investigated (${r.defects} real defects), ${r.waiting} waiting; ${f ? `${f.filed.length} issues filed, ${f.commented.length} comments${f.note ? ` (${f.note})` : ""}` : "nothing filed"}`;
      if (f?.later) throw new Error(`${f.later}; ${line}`);
      return line;
    },
  },
];

let loaded: Promise<Map<string, StepDef>> | null = null;
let loadedMap: Map<string, StepDef> | null = null;

/** A step by name without waiting: the loaded list once `loadSteps` has finished, else the built-in steps. */
export const knownStep = (name: string): StepDef | undefined => loadedMap?.get(name) ?? STEPS.find((s) => s.name === name);

/**
 * Every step by name. AUTOCRAFT_EXTRA_STEPS names a module exporting `steps:
 * StepDef[]` that is added too; tests and development smoke runs use it for
 * fake steps. The dashboard, the runner and each job's child read the same
 * variable, so they see the same list.
 */
export function loadSteps(): Promise<Map<string, StepDef>> {
  loaded ??= (async () => {
    const map = new Map(STEPS.map((s) => [s.name, s]));
    const extra = envVar("EXTRA_STEPS");
    if (extra) for (const s of ((await import(pathToFileURL(resolve(extra)).href)) as { steps: StepDef[] }).steps) map.set(s.name, s);
    loadedMap = map;
    return map;
  })();
  return loaded;
}

export class ParamError extends Error {}

/** The request's params checked against the step's schema, with defaults filled in. Unknown keys are refused. */
export function validateParams(step: StepDef, raw: unknown, trackedRepos: string[]): Params {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ParamError("params must be an object");
  const given = raw as Record<string, unknown>;
  const known = new Set(step.params.map((p) => p.name));
  for (const k of Object.keys(given)) if (!known.has(k)) throw new ParamError(`${step.name} has no parameter ${k}`);
  const out: Params = {};
  for (const p of step.params) {
    const v = given[p.name];
    if (v === undefined || v === null || v === "") {
      const d = "default" in p ? p.default : undefined;
      if (d !== undefined) out[p.name] = d;
      else if (p.required) throw new ParamError(`${p.label} is required`);
      continue;
    }
    switch (p.kind) {
      case "enum":
        if (typeof v !== "string" || !p.options.includes(v)) throw new ParamError(`${p.label} must be one of ${p.options.join(", ")}`);
        out[p.name] = v;
        break;
      case "repo":
        if (typeof v !== "string" || !trackedRepos.includes(v)) throw new ParamError(`${p.label} must be a tracked repo`);
        out[p.name] = v;
        break;
      case "int":
        if (typeof v !== "number" || !Number.isInteger(v) || v < p.min || v > p.max) throw new ParamError(`${p.label} must be a whole number from ${p.min} to ${p.max}`);
        out[p.name] = v;
        break;
      case "run-id":
        if (typeof v !== "string" || !RUN_ID.test(v)) throw new ParamError(`${p.label} must be lowercase letters, digits and dashes (at most 48)`);
        out[p.name] = v;
        break;
      case "sha":
        // Only a note for counting the job's failures: one that is no commit id is left out, and the job runs without it.
        if (isHeadSha(v)) out[p.name] = v;
        break;
    }
  }
  return out;
}
