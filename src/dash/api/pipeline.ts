// The Pipeline page over JSON. Everyone signed in reads steps, jobs, logs, the
// pipeline switch and the stage limits; only operators request or cancel jobs,
// flip the switch and change limits. The
// dashboard never runs a step: it writes job rows that the runner picks up.
import { mayRunRepo } from "../repo-access.ts";
import type { Job, JobState, PipelineOverview, PipelineStage, PipelineState, PipelineStep, StepParam } from "../../../web/src/api/types.ts";
import { enqueue, getJob, jobDetail, jobRow, JobError, JOB_STATES, listJobs, requestCancel, toJobs } from "../../runner/jobs.ts";
import { ackDeadline, LimitError, pipelineState as rawPipelineState, resetLimitCount, setEnabled, setLimit } from "../../runner/autopilot.ts";
import { HEARTBEAT_MARK } from "../../runner/runner.ts";
import { loadLaneState } from "../../data/jobs/index.ts";
import { loadSteps, type StepDef } from "../../runner/steps.ts";
import { audit } from "../audit.ts";
import { outsideState } from "../../outside.ts";
import { mayResumeTrip, resumeStage, TripError } from "../../data/control/index.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { blankIfHidden, hiddenRepos, visibleRepos } from "./visible.ts";
import { isHiddenRepo, type HiddenRepos } from "../../data/control/index.ts";
import { loadPipelineOverview } from "../../data/views/pipeline.ts";
import { loadQuiet } from "../../data/security/index.ts";
import { canSeeInternals } from "./staff.ts";
import { SECURITY_PREFIX, SECURITY_STEP } from "../../security/rules.ts";
import { mapSeq } from "../../async-seq.ts";
import type { Db } from "../../db/index.ts";

// Stages of docs/pipeline.md. A stage with registered steps shows them; the
// mirror also runs on its own timer.
const STAGES: { n: number; name: string; automatic?: boolean }[] = [
  { n: 1, name: "Mirror", automatic: true },
  { n: 2, name: "Classify" },
  { n: 3, name: "Duplicates and conversations" },
  { n: 4, name: "Label" },
  { n: 5, name: "Review" },
  { n: 6, name: "Integrate" },
  { n: 7, name: "Fix issues" },
];

const RUNNER_ALIVE_MS = 30_000;

function requireOperator(req: Req, step?: StepDef): void {
  if (req.user.role !== "operator" || (step && step.requires !== "operator")) throw new HttpError(403, "only operators run or cancel pipeline steps and change the pipeline switch and limits");
}

/** The pipeline state for the requester: reasons that name a hidden repo and trips on one are left out. */
async function pipelineState(db: Db, req: Req): Promise<PipelineState> {
  const [s, hidden, outside] = await Promise.all([rawPipelineState(db), hiddenRepos(db, req), hiddenRepos(db, req).then((h) => outsideState(db, h))]);
  const limits = await mapSeq(s.limits, async ({ trips, ...l }) => {
    const shown = await mapSeq((trips ?? []).filter((t) => t.repo === null || !isHiddenRepo(hidden, t.repo)), async (t) => ({ ...t, reason: blankIfHidden(t.reason, hidden), canResume: await mayResumeTrip(db, req.user, t.key) }));
    return { ...l, pausedReason: blankIfHidden(l.pausedReason, hidden) || null, status: blankIfHidden(l.status, hidden) || null, ...(shown.length ? { trips: shown } : {}) };
  });
  return { ...s, outside, limits };
}

/** Viewers read that a job failed, not why: the error carries log and command text. */
/**
 * A job as the reader may see it: viewers get "failed" for an error; no reader gets a summary, progress or error that names a repo
 * hidden from them (a job without a repo works across repos), and an error left out that way reads "failed". Operators hide nothing.
 */
const forViewer = (req: Req, hidden: HiddenRepos) => (j: Job): Job => ({
  ...j, summary: blankIfHidden(j.summary, hidden) || null, progress: blankIfHidden(j.progress, hidden) || null,
  error: j.error && (canSeeInternals(req) ? blankIfHidden(j.error, hidden) || "failed" : "failed"),
});

const wrap = async <T>(f: () => Promise<T | Promise<T>>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof JobError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

function wireParams(s: StepDef, repos: string[]): StepParam[] {
  return s.params.filter((p) => !p.cliOnly).flatMap((p): StepParam[] => {
    const base = { name: p.name, label: p.label, help: p.help, required: !!p.required };
    switch (p.kind) {
      case "enum": return [{ ...base, kind: "enum", options: p.options, default: p.default }];
      case "repo": return [{ ...base, kind: "repo", options: repos }];
      case "int": return [{ ...base, kind: "int", min: p.min, max: p.max, default: p.default }];
      case "run-id": return [{ ...base, kind: "run-id", default: p.default }];
      // A commit id is set by the planner, never typed in the form.
      case "sha": return [];
    }
  });
}

/** A running or queued step decides; else a sync result for the automatic stage; else the newest finished job. */
function stageState(fromJobs: PipelineStage["state"], syncFailed: boolean | null): PipelineStage["state"] {
  if (fromJobs === "running" || fromJobs === "queued") return fromJobs;
  return syncFailed !== null ? (syncFailed ? "failed" : "ok") : fromJobs;
}

export async function overview(db: Db, req: Req): Promise<PipelineOverview> {
  const all = [...(await loadSteps()).values()].filter((s) => s.name !== SECURITY_STEP || canSeeInternals(req));
  const [repos, hidden] = await Promise.all([visibleRepos(db, req), hiddenRepos(db, req)]);
  const stageSteps = STAGES.map((st) => ({ n: st.n, steps: all.filter((s) => s.stage === st.n).map((s) => s.name) }));
  const [facts, marks] = await db.together(() => Promise.all([
    loadPipelineOverview(db, { steps: all.map((s) => s.name), stages: stageSteps, hidden, syncRuns: 10, settingKeys: ["org_high_water"] }),
    loadLaneState(db, ["mark"]),
  ]));
  const lastRows = [...facts.lastJobs.values()];
  const lastJobs = new Map(lastRows.map((r, i) => [r.id, i]));
  const jobsOf = await toJobs(db, lastRows);
  const view = forViewer(req, hidden);
  const steps: PipelineStep[] = all.map((s) => {
    const row = facts.lastJobs.get(s.name);
    return {
      name: s.name, title: s.title, description: s.description, stage: s.stage, requires: s.requires,
      params: wireParams(s, repos), unavailable: s.available?.() ?? null,
      lastJob: row ? view(jobsOf[lastJobs.get(row.id)!]!) : null,
    };
  });
  const raw = facts.syncRuns.map((r) => ({ startedAt: r.started_at, endedAt: r.ended_at, mode: r.mode, items: r.items, error: r.error }));
  const lastSync = raw.find((r) => r.endedAt);
  // A sync error can quote GitHub's answer about any repo: staff read it unless it names a repo hidden from them, viewers read "failed".
  const runs = raw.map((r) => ({ ...r, error: r.error && (canSeeInternals(req) ? blankIfHidden(r.error, hidden) || "failed" : "failed") }));
  const high = facts.settings.get("org_high_water") ?? null;
  const stages: PipelineStage[] = STAGES.map((st) => {
    const names = steps.filter((s) => s.stage === st.n).map((s) => s.name);
    const mode = st.automatic ? "automatic" : names.length ? "steps" : "planned";
    return { n: st.n, name: st.name, mode, steps: names, state: mode === "planned" ? "planned" : stageState(facts.stageStates.get(st.n) ?? "idle", st.automatic ? (lastSync ? lastSync.error !== null : high ? false : null) : null) };
  });
  const beat = marks.get(`mark|${HEARTBEAT_MARK}|`)?.value ?? null;
  return {
    stages, steps,
    runner: { lastSeen: beat, alive: beat !== null && Date.now() - Date.parse(beat) < RUNNER_ALIVE_MS },
    sync: { lastFinishedAt: lastSync?.endedAt ?? high, runs },
    counts: { queued: facts.counts.get("queued") ?? 0, running: facts.counts.get("running") ?? 0 },
  };
}

const intQuery = (req: Req, name: string): number | undefined => {
  const v = req.query.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a whole number`);
  return n;
};

export async function jobs(db: Db, req: Req) {
  const state = req.query.get("state") || undefined;
  if (state && !JOB_STATES.includes(state as JobState)) throw new HttpError(400, "unknown state");
  const hidden = await hiddenRepos(db, req);
  const list = await listJobs(db, { step: req.query.get("step") || undefined, state: state as JobState | undefined, limit: intQuery(req, "limit"), offset: intQuery(req, "offset") }, hidden);
  return { ...list, jobs: list.jobs.map(forViewer(req, hidden)) };
}

const jobId = (req: Req): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "not a job id");
  return id;
};

export const job = async (db: Db, req: Req) => wrap(async () => {
  const hidden = await hiddenRepos(db, req);
  const id = jobId(req);
  const d = await jobDetail(db, id, { hidden, logs: canSeeInternals(req) });
  const repo = jobRepo((await jobRow(db, id))?.repo);
  d.canCancel = req.user.role === "operator" || (!!repo && await mayRunRepo(req.user, repo));
  if (canSeeInternals(req)) return forViewer(req, hidden)(d) as typeof d;
  // An item's outcome reads "failed: <reason>" or carries notes: viewers get the leading state word, and nothing for a quiet pull request.
  const items = await mapSeq(d.items, async (i) => ({ ...i, outcome: (await loadQuiet(db, [`${i.repo}#${i.number}`])).size > 0 ? null : /^[A-Za-z-]+/.exec(i.outcome ?? "")?.[0] ?? null }));
  return { ...forViewer(req, hidden)(d) as typeof d, items };
});

function body(req: Req): Record<string, unknown> {
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
}

export async function request(db: Db, req: Req): Promise<Job> {
  requireOperator(req);
  const b = body(req);
  const step = typeof b.step === "string" ? (await loadSteps()).get(b.step) : undefined;
  if (!step) throw new HttpError(400, "no such step");
  requireOperator(req, step);
  if (step.name === SECURITY_STEP) throw new HttpError(400, "scans are started from the repo page");
  const given = b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params as Record<string, unknown> : {};
  const cli = step.params.find((p) => p.cliOnly && given[p.name] !== undefined);
  if (cli) throw new HttpError(400, `${cli.label} is set from the command line only`);
  const j = await wrap(async () => enqueue(db, step.name, b.params, req.user.login));
  await audit(db, req.user.login, "job-request", `job:${j.id}`, { step: j.step, params: j.params });
  return j;
}

/** A security job stores its repo as `(security):<repo>`; the permission is on the repo itself. */
const jobRepo = (r: string | null | undefined): string | null => (r?.startsWith(SECURITY_PREFIX) ? r.slice(SECURITY_PREFIX.length) : r ?? null);

// An operator cancels any job; a maintainer with write access cancels the jobs of that repo. A job without a repo stays operator-only.
export async function cancel(db: Db, req: Req): Promise<Job> {
  if (req.user.role === "viewer") throw new HttpError(403, "only operators and maintainers cancel pipeline jobs");
  const id = jobId(req);
  const before = await wrap(async () => await getJob(db, id));
  const repo = jobRepo((await jobRow(db, id))?.repo);
  if (req.user.role !== "operator" && !(repo && await mayRunRepo(req.user, repo))) throw new HttpError(403, "only an operator, or a maintainer with write access to the job's repo, cancels it");
  const j = await wrap(async () => await requestCancel(db, id, req.user.login));
  await audit(db, req.user.login, "job-cancel", `job:${id}`, { step: j.step, state: before.state });
  return j;
}

export const state = async (db: Db, req: Req) => pipelineState(db, req);

export async function putState(db: Db, req: Req) {
  requireOperator(req);
  const b = body(req);
  if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  const was = (await rawPipelineState(db)).enabled;
  await setEnabled(db, b.enabled, req.user.login);
  await audit(db, req.user.login, "pipeline-switch", "pipeline", { enabled: b.enabled, was });
  return pipelineState(db, req);
}

export async function putLimit(db: Db, req: Req) {
  requireOperator(req);
  try {
    await setLimit(db, req.params.step, req.json, req.user.login);
  } catch (e) {
    if (e instanceof LimitError) throw new HttpError(e.status, e.message);
    throw e;
  }
  return (await pipelineState(db, req)).limits.find((l) => l.step === req.params.step)!;
}

/** An operator, or a maintainer with write access to the trip's repo, clears a breaker (`<stage>:<repo>`, or outside-surge). */
export async function resumeTrip(db: Db, req: Req) {
  if (!await mayResumeTrip(db, req.user, req.params.stage!)) throw new HttpError(403, "only an operator, or a maintainer with write access to the breaker's repo, resumes it");
  try {
    await resumeStage(db, req.params.stage, req.user.login);
  } catch (e) {
    if (e instanceof TripError) throw new HttpError(e.status, e.message);
    throw e;
  }
  return pipelineState(db, req);
}

/** Starts today's count of a step again from zero; the step `all` resets every stage. */
export async function resetLimit(db: Db, req: Req) {
  requireOperator(req);
  try {
    await resetLimitCount(db, req.params.step, req.user.login);
  } catch (e) {
    if (e instanceof LimitError) throw new HttpError(e.status, e.message);
    throw e;
  }
  return pipelineState(db, req);
}

/** An operator acknowledges the deadline stops of a step, which clears their warning in the header. */
export async function ackStepDeadline(db: Db, req: Req) {
  requireOperator(req);
  const step = req.params.step!;
  if (!(await loadSteps()).has(step)) throw new HttpError(404, "no such step");
  await ackDeadline(db, step, req.user.login);
  return { ok: true };
}
