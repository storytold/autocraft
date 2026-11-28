// The longest a job of a step may run. The bound comes from the code's own limits: every model call the job can make, at its
// prompt's time limit, times its attempts, plus the check tool's wall time for a patch call and a turn for each lint round,
// times the items of the job. The registry's `maxMin` (src/stages/registry.ts) is the floor from the history of finished jobs;
// the deadline is the larger of the two, so a job is never stopped while the code would still let it work.
import { CHECK_MAX_WALL_MS, LINT_MAX_ROUNDS } from "../core/rules.ts";
import { CLAUDE_PROMPTS, type ClaudePromptId } from "../prompts/index.ts";
import { CHECK_FOLLOW_UPS, FIX_FOLLOW_UP_CALL, FIX_SESSION_CALL } from "../fixsession/report.ts";
import type { FixStep } from "../data/fixsession/types.ts";
import { AREAS_MAX, FINDINGS_PER_AREA_MAX, FIX_ROUNDS } from "../security/rules.ts";
import { stepMaxMin } from "../stages/registry.ts";

/** How long a part of the runner's work fails before it counts as failing (the health check, and which failure it shows). */
export const RUNNER_FAILING_MS = 60_000;

/** One call per item. `lint`: follow-up turns of the same call (one per lint round). */
type Call = { id: ClaudePromptId; lint?: boolean };
/** `items`: the job's items when its params have no `limit`. */
type Plan = { calls: Call[]; items: number };

const item = (id: ClaudePromptId, lint = false): Call => ({ id, ...(lint && { lint }) });

/**
 * Steps whose job makes one call (or a few) per item. The others keep the registry's `maxMin`: the steps with no model call, and the
 * batched Jev and Haiku steps (classify, priority, duplicates), whose calls take seconds and have their own time limit each.
 */
export const STEP_PLANS: Record<string, Plan> = {
  referee: { calls: [item("referee.sonnet")], items: 100 },
  "dupes-compare": { calls: [item("dupes.compare-prs.opus"), item("dupes.compare-issues.sonnet")], items: 20 },
  conversation: { calls: [item("conversation.turn")], items: 30 },
  "areas-propose": { calls: [item("areas.propose")], items: 1 },
  "areas-suggest": { calls: [item("areas.suggest")], items: 1 },
  "opus-review": { calls: [item("review.opus")], items: 10 },
  premerge: { calls: [item("premerge.opus")], items: 10 },
  postmerge: { calls: [item("postmerge.opus")], items: 10 },
  fixup: { calls: [item("fixup.patch", true), item("fixup.conflict", true)], items: 5 },
  cifix: { calls: [item("cifix.patch", true)], items: 5 },
  "main-fix": { calls: [item("mainfix.classify"), item("cifix.patch", true)], items: 1 },
  verify: { calls: [item("verify.plan")], items: 10 },
  "verify-collect": { calls: [item("verify.summary")], items: 10 },
  // One threat model, then per area an audit and a verify of each finding it may report, and a scan test of each (feature scan-tests).
  "security-scan": { calls: [item("security.model"), ...Array.from({ length: AREAS_MAX }, () => item("security.area")), ...Array.from({ length: AREAS_MAX * FINDINGS_PER_AREA_MAX }, () => item("security.verify")), ...Array.from({ length: AREAS_MAX * FINDINGS_PER_AREA_MAX }, () => item("security.scantest"))], items: 1 },
  // A job holds one round: the review of a passed build and the next patch, or one patch. The build runs between jobs. In a fix
  // session the job has its own bound (SESSION_BOUNDS).
  "security-fix": { calls: [item("security.fix", true), item("security.fixcheck")], items: 1 },
};

/** A job's variant whose bound is not its step's plan: the step works in fix sessions (the fix_sessions setting, read when the job starts). */
export type StepVariant = "fix-session";

/** The steps whose jobs have a fix-session variant, with the fix_sessions step that turns it on. */
export const SESSION_VARIANT_STEPS: Record<string, FixStep> = { "security-fix": "security" };

/**
 * A fix session turn's minutes: a step's first turn, then its follow-ups (AutoCraft's check findings, one undo turn and one report
 * turn), each at its call's time limit. The workspace is never waited for in the job: a security fix ends on a workspace that is not
 * ready and its next job starts once the workspace moves on.
 */
const sessionStepMin = (): number => (FIX_SESSION_CALL.timeoutSeconds + (CHECK_FOLLOW_UPS + 2) * FIX_FOLLOW_UP_CALL.timeoutSeconds) / 60;

/** The fix-session bound of a step's job, in minutes, and its longest call: a security fix runs up to FIX_ROUNDS rounds before a build, then the review. */
const SESSION_BOUNDS: Record<string, () => { bound: number; longest: number }> = {
  "security-fix": () => ({ bound: FIX_ROUNDS * sessionStepMin() + callMin(item("security.fixcheck")), longest: Math.max(FIX_SESSION_CALL.timeoutSeconds / 60, callMin(item("security.fixcheck"))) }),
};

/** Minutes one call can take: each attempt runs the first turn and the lint follow-ups at the prompt's time limit, and a patch call adds the check tool's wall time. */
function callMin(c: Call): number {
  const p = CLAUDE_PROMPTS[c.id];
  const turns = 1 + (c.lint ? LINT_MAX_ROUNDS : 0);
  const check = "sandbox" in p && p.sandbox && "check" in p.sandbox && p.sandbox.check ? CHECK_MAX_WALL_MS / 60_000 : 0;
  return p.limits.attempts * (turns * p.limits.timeoutSeconds / 60 + check);
}

/** The longest the code lets a job of `step` work with `items` items (default: the plan's), in minutes, or null for a step with no model call. */
export function stepBoundMin(step: string, items?: number): number | null {
  const plan = STEP_PLANS[step];
  if (!plan) return null;
  const n = items ?? plan.items;
  let total = 0;
  for (const c of plan.calls) {
    total += n * callMin(c);
  }
  return total;
}

/** Environment variable through which the runner tells a job process its deadline in minutes. */
export const JOB_DEADLINE_ENV = "AUTOCRAFT_JOB_DEADLINE_MIN";

/**
 * Share of its deadline after which a job that works in slices (StepContext.timeUp) starts no new unit. The rest covers the unit in
 * flight and the passes after it, so the job ends as a success well before the runner would stop it. Such jobs end near this share of
 * the deadline, so a registry floor taken as twice the longest done job stays at or above the deadline.
 */
export const SLICE_SHARE = 0.5;

/** Margin on the bound: a quarter and a few minutes for the work around the calls (git, GitHub, the database). */
const margin = (min: number): number => Math.ceil(min * 1.25) + 5;

/** The deadline of a job of `step` in minutes. `items`: the job's `limit` param, when it has one; `variant`: the job's (StepVariant). */
export function stepDeadlineMin(step: string, items?: number, variant?: StepVariant): number {
  const session = variant === "fix-session" ? SESSION_BOUNDS[step] : undefined;
  const bound = session ? session().bound : stepBoundMin(step, items);
  return Math.max(stepMaxMin(step), bound === null ? 0 : margin(bound));
}

/** The longest one model call of `step` can legitimately take, in minutes, or null for a step with no model call in STEP_PLANS. */
export function longestCallMin(step: string): number | null {
  const plan = STEP_PLANS[step];
  return plan ? Math.max(...plan.calls.map(callMin)) : null;
}

/** Minutes a job of `step` may show no progress (no new job log line): its longest single call plus 10; the registry floor for a step with no model call. */
export function stepNoProgressMin(step: string, variant?: StepVariant): number {
  const session = variant === "fix-session" ? SESSION_BOUNDS[step] : undefined;
  const call = session ? session().longest : longestCallMin(step);
  return call === null ? stepMaxMin(step) : Math.ceil(call) + 10;
}
