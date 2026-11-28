// Build tasks for a validated plan, and the warm build of the default branch.
import { createTaskSet, warmKeyOf } from "../build/tasks.ts";
import { hasWarmBuild, loadEnvs, type NewTask } from "../data/build/index.ts";
import { rustPlan } from "../worker/rust.ts";
import { WORKSPACE_TEST_TARGETS } from "../worker/rust-targets.ts";
import type { TaskStep } from "../worker/types.ts";
import { featureOn } from "../build/features.ts";
import type { VerifyPlan } from "./plan.ts";
import type { ParamSpec, ScreenshotConfigBody } from "./screenshot-config.ts";
import type { ShotStep } from "./types.ts";
import type { Db } from "../db/index.ts";

const REQUIRES = { os: "linux", toolchains: ["rust-stable"] } as const;
export const WARM_EVERY_MS = 24 * 3600_000;
/** Warm builds wait behind verification tasks. */
export const WARM_PRIORITY = -10;

type Planned = Exclude<VerifyPlan, { kind: "ci-enough" }>;

const FOCUSED_TESTS_ARGV0 = "verify-focused-tests";
const NO_FOCUSED_TESTS_EXIT = 86;
export const NO_FOCUSED_TESTS_SUMMARY = "No tests ran for the requested Rust test filter.";

// Cargo can succeed even when libtest filters out every test. Read all target summaries
// and keep reporting Cargo's own failure status when compilation or a test fails.
const FOCUSED_TESTS_SCRIPT = `"$@" | awk '
  { print }
  /^test result: ok[.] [1-9][0-9]* passed;/ { passed = 1 }
  END { if (!passed) exit ${NO_FOCUSED_TESTS_EXIT} }
'
status=("\${PIPESTATUS[@]}")
if [ "\${status[0]}" -ne 0 ]; then exit "\${status[0]}"; fi
if [ "\${status[1]}" -eq ${NO_FOCUSED_TESTS_EXIT} ]; then
  printf '%s\\n' '${NO_FOCUSED_TESTS_SUMMARY}' >&2
fi
exit "\${status[1]}"`;

export const noFocusedTests = (cmd: string[] | undefined, exitCode: number | null): boolean =>
  cmd?.[3] === FOCUSED_TESTS_ARGV0 && exitCode === NO_FOCUSED_TESTS_EXIT;

/** The tasks that run `plan` at `head` (and, for a regression, at `base`). Order: head first. */
export function tasksFor(plan: Planned, c: { repo: string; number: number; head: string; base: string }): NewTask[] {
  const common = { step: "verify", repo: c.repo, number: c.number, requires: { ...REQUIRES, toolchains: [...REQUIRES.toolchains] }, warm: { key: warmKeyOf(c.repo), role: "use" as const } };
  if (plan.kind === "tests") {
    const steps = rustPlan({ cargoArgs: plan.crates.flatMap((n) => ["-p", n]) }).map((s): TaskStep =>
      s.name === "test" && plan.tests.length ? { ...s, cmd: ["bash", "-c", FOCUSED_TESTS_SCRIPT, FOCUSED_TESTS_ARGV0, ...s.cmd, "--", ...plan.tests] } : s);
    return [{ ...common, headSha: c.head, baseSha: c.base, plan: steps }];
  }
  const steps = rustPlan({ cargoArgs: ["-p", plan.crate] }).map((s): TaskStep =>
    s.name === "test" ? { ...s, cmd: [...s.cmd, "--test", plan.test] } : s);
  return [
    { ...common, headSha: c.head, baseSha: c.base, plan: steps, patch: plan.patch },
    { ...common, headSha: c.base, baseSha: c.base, plan: steps, patch: plan.patch },
  ];
}

/** Queues the tasks; returns their ids, head task first. */
export async function queueTasks(db: Db, plan: Planned, c: { repo: string; number: number; head: string; base: string }): Promise<number[]> {
  return await createTaskSet(db, tasksFor(plan, c));
}

/**
 * Queues a build-only task for the default branch head when the repo has no warm build for it yet and
 * none in the last 24 hours. Returns the task id, or null when nothing was queued. These builds fill a worker's own warm
 * dirs (src/worker/warm.ts), so none is queued without an enabled worker environment: build pods start from the warm
 * store, which the warm producer fills (src/build/warm-queue.ts).
 */
export async function queueWarmBuild(db: Db, repo: string, mainSha: string, nowMs: number = Date.now()): Promise<number | null> {
  const [envs, seen] = await db.together(() => Promise.all([loadEnvs(db, { enabled: true }), hasWarmBuild(db, repo, mainSha, new Date(nowMs - WARM_EVERY_MS).toISOString())]));
  if (seen || !envs.some((e) => e.kind !== "kubernetes")) return null;
  return (await createTaskSet(db, [{
    step: "verify", repo, headSha: mainSha, baseSha: mainSha, requires: { ...REQUIRES, toolchains: [...REQUIRES.toolchains] }, priority: WARM_PRIORITY,
    plan: warmBuildPlan(), warm: { key: warmKeyOf(repo), role: "build" },
  }]))[0] ?? null;
}

/** The worker's warm build: the units a whole-workspace plan builds and tests, as the cluster's warm producer builds them. */
function warmBuildPlan(): TaskStep[] {
  const [fetch, build] = rustPlan({ cargoArgs: ["--workspace"], test: false });
  return [fetch!, build!, { name: "build tests", cmd: ["cargo", "test", "--offline", "--locked", "--no-run", ...WORKSPACE_TEST_TARGETS], network: "none", timeoutSec: 3600 }];
}

const RENDER_TIMEOUT_SEC = 120;
const OUT_DIR = "/out";
/** The artifact a capture step at 1-based position `i` of the script writes. */
/** The task step of render tasks. Not "verify": the verification retry counts the verify tasks of a head. */
export const SCREENSHOT_STEP = "screenshot";
export const shotName = (i: number): string => `s${i}.png`;

/** Replaces `{param}` and `{out}` in one pass, so a value is never expanded again. `out` is null outside a capture command. */
const expand = (t: string, args: Record<string, string | number>, out: string | null): string =>
  t.replace(/\{([^{}]*)\}/g, (_m, name: string) => (name === "out" && out !== null ? out : String(args[name])));

/** The command-line words a step adds after `--` (driver "args"): the command's argv with its arguments filled in. */
function argvOf(config: Pick<ScreenshotConfigBody, "commands">, step: ShotStep, i: number): string[] {
  const spec = config.commands[step.cmd]!;
  return (spec.argv ?? []).map((t) => expand(t, step.args, spec.capture ? `${OUT_DIR}/${shotName(i)}` : null));
}

/** One JSON line of the script file (driver "jsonl"); a value that is exactly one integer param stays a number. */
function lineOf(config: Pick<ScreenshotConfigBody, "commands">, step: ShotStep, i: number): string {
  const spec = config.commands[step.cmd]!;
  const out = spec.capture ? `${OUT_DIR}/${shotName(i)}` : null;
  const obj: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(spec.line ?? {})) {
    const whole = typeof v === "string" ? /^\{([^{}]*)\}$/.exec(v) : null;
    const p: ParamSpec | undefined = whole ? spec.params[whole[1]!] : undefined;
    obj[k] = typeof v !== "string" ? v : p && "int" in p ? Number(step.args[whole![1]!]) : expand(v, step.args, out);
  }
  return JSON.stringify(obj);
}

/**
 * The tasks that render a validated screenshot script at `head` and at `base`. Head first. The base task runs at
 * the base commit for both of its commits, as the regression pair does, so both resolve the same gate and image.
 * Only the config's templates and validated argument values reach a command line; the model's text never does.
 */
export function screenshotTasks(script: ShotStep[], config: Pick<ScreenshotConfigBody, "package" | "example" | "driver" | "commands">, c: { repo: string; number: number; head: string; base: string }): NewTask[] {
  const common = {
    step: SCREENSHOT_STEP, repo: c.repo, number: c.number, warm: { key: warmKeyOf(c.repo), role: "use" as const },
    requires: { os: "linux" as const, toolchains: ["rust-stable"], display: true },
  };
  const run = ["cargo", "run", "--offline", "--locked", "-p", config.package, "--example", config.example];
  const steps: TaskStep[] = [
    rustPlan({ test: false })[0]!,
    { name: "build", cmd: ["cargo", "build", "--offline", "--locked", "-p", config.package, "--example", config.example], network: "none", timeoutSec: 3600 },
  ];
  if (config.driver === "args") {
    script.forEach((s, n) => {
      const i = n + 1;
      steps.push({ name: config.commands[s.cmd]!.capture ? `render s${i}` : `run ${i}`, cmd: [...run, "--", ...argvOf(config, s, i)], network: "none", timeoutSec: RENDER_TIMEOUT_SEC,
        ...(config.commands[s.cmd]!.capture ? { artifacts: [shotName(i)] } : {}) });
    });
  } else {
    // One process reads the whole script, so a later line sees what an earlier one set up. The shell text is a constant; the script is only $1.
    const lines = script.map((s, n) => lineOf(config, s, n + 1)).join("\n");
    const artifacts = script.flatMap((s, n) => (config.commands[s.cmd]!.capture ? [shotName(n + 1)] : []));
    steps.push({ name: "render", cmd: ["sh", "-c", `printf "%s\\n" "$1" > /tmp/ui.jsonl && exec ${run.join(" ")} -- /tmp/ui.jsonl`, "sh", lines], network: "none", timeoutSec: RENDER_TIMEOUT_SEC * Math.max(1, artifacts.length), artifacts });
  }
  return [
    { ...common, headSha: c.head, baseSha: c.base, plan: steps },
    { ...common, headSha: c.base, baseSha: c.base, plan: steps },
  ];
}

/** Queues the screenshot tasks; returns their ids, head task first, or [] when the repo's screenshots switch is off. */
export async function queueScreenshotTasks(db: Db, script: ShotStep[], config: Pick<ScreenshotConfigBody, "package" | "example" | "driver" | "commands">, c: { repo: string; number: number; head: string; base: string }): Promise<number[]> {
  if (!await featureOn(db, "screenshots", c.repo)) return [];
  return await createTaskSet(db, screenshotTasks(script, config, c));
}
