// Our own build of PR heads (pr-builds feature): a second opinion beside upstream CI. It never holds a PR or changes a
// merge decision. One no-model job step queues the builds and collects the finished ones; the task runs in a worker.
// A build that fails where CI passed is noted on the item (stage row `pr-build-disagree`) and nothing more: our build
// lacks CI's gate inputs and toolchain targets, so such failures are often false.
import { BuildError } from "../build/envs.ts";
import { featureOn } from "../build/features.ts";
import { cloneTasks, warmKeyOf } from "../build/tasks.ts";
import { currentJobId } from "../agents/call.ts";
import { QueueFullError, TERMINAL, cancelTasks, loadTasks } from "../data/build/index.ts";
import { loadLateDisagreements, loadPendingPrBuilds, queuePrBuilds, restartPrBuilds, savePrBuildErrors, settlePrBuilds, type NewPrBuild } from "../data/merge/index.ts";
import { config, withConfig } from "../data/control/index.ts";
import { loadChecks } from "../data/mirror/index.ts";
import { loadInScope } from "../data/workflow/index.ts";
import { leaseItem } from "../runner/leases.ts";
import { jobItem } from "../runner/job-items.ts";
import { outcomeOf } from "../verify/results.ts";
import { defaultDeps } from "../verify/index.ts";
import { cachedCrates, ghCrates, type CratesFetcher } from "../verify/crates.ts";
import { planFor } from "./plans.ts";
import { buildScope, scopeOf, selectPrBuilds, selectPrBuildsIn } from "./select.ts";
import type { Db } from "../db/index.ts";

const ACTOR = "pr-build";
const SUMMARY_LIMIT = 200;

const now = (): string => new Date().toISOString();
const headKey = (repo: string, number: number, head: string): string => `${repo}#${number}@${head}`;

export type PrBuildDeps = { fetchCrates: CratesFetcher; /** The PR's base commit, or null when GitHub did not answer. Default: GitHub. */ baseOf?: (repo: string, number: number) => Promise<string | null> };

/**
 * The repos of `repos`, and of those with a queued build, with work for a pr-build job: a PR to build, a queued build whose task ended, whose PR moved on or that must stop, or a failure that now disagrees with CI. Reads only.
 */
export async function prBuildsDue(db: Db, repos: readonly string[]): Promise<string[]> {
  return await withConfig(db, async () => {
    const onIn = (r: string): boolean => config(db).repo(r).buildFeature("pr-builds");
    const on = new Set(repos.filter(onIn));
    const [selected, late, pending] = await db.together(() => Promise.all([selectPrBuildsIn(db, [...on]), on.size ? loadLateDisagreements(db) : [], loadPendingPrBuilds(db)]));
    const inScope = await loadInScope(db, pending.filter((p) => onIn(p.repo)).map((p) => ({ repo: p.repo, number: p.number })));
    const due = new Set([...late.map((d) => d.repo).filter((r) => on.has(r)), ...[...selected].filter(([, cs]) => cs.some((c) => c.rust !== false)).map(([r]) => r)]);
    for (const p of pending) {
      if (!onIn(p.repo) || p.itemState !== "OPEN" || p.currentHead !== p.headSha || p.taskId === null || !inScope.has(`${p.repo}#${p.number}`)
        || (p.taskState !== null && (TERMINAL as readonly string[]).includes(p.taskState))) due.add(p.repo);
    }
    return [...due];
  });
}

export type PrBuildSummary = { queued: number; passed: number; failed: number; errors: number; stale: number; retried: number; disagreements: number };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LIMIT);

/** Reads the finished tasks of the repo's queued builds and records their state. */
export async function collectPrBuilds(db: Db, repo: string, log: (line: string) => void = console.log): Promise<Omit<PrBuildSummary, "queued">> {
  const s = { passed: 0, failed: 0, errors: 0, stale: 0, retried: 0, disagreements: 0 };
  const pending = await loadPendingPrBuilds(db, repo);
  const on = await featureOn(db, "pr-builds", repo);
  const refs = pending.map((p) => ({ repo: p.repo, number: p.number }));
  const taskIds = pending.flatMap((p) => (p.taskId === null ? [] : [p.taskId]));
  const [tasks, scope, checks] = pending.length ? await db.together(() => Promise.all([
    loadTasks(db, taskIds),
    on ? buildScope(db, repo, pending.map((p) => p.number)) : Promise.resolve(new Set<number>()),
    loadChecks(db, refs, { checksOnlyIfNotGreen: true }),
  ])) : [new Map(), new Set<number>(), new Map()];
  for (const p of pending) {
    const release = await leaseItem(db, `pr:${p.repo}#${p.number}`, log);
    if (!release) continue;
    try {
      const key = headKey(p.repo, p.number, p.headSha);
      const finish = async (state: string, summary: string | null, extra: { ci?: string | null; disagree?: boolean } = {}): Promise<boolean> =>
        (await settlePrBuilds(db, [{ key, from: "queued", set: { state, summary, ciOverall: extra.ci ?? null, disagree: extra.disagree ?? false, finishedAt: now() } }])).has(key);
      const task = p.taskId === null ? undefined : tasks.get(p.taskId);
      // A head that moved, a PR no longer open, a switch turned off or a PR out of the worker's scope ends the build.
      if (p.itemState !== "OPEN" || p.currentHead !== p.headSha || !on || !scope.has(p.number)) {
        if (task) await cancelTasks(db, { ids: [task.id] }, ACTOR);
        if (await finish("stale", null)) s.stale++;
        continue;
      }
      if (!task) { if (await finish("error", "the build task is gone")) s.errors++; continue; }
      if (!TERMINAL.includes(task.state)) continue;
      const out = outcomeOf(task);
      // Only a failed or lost task is tried again; an operator's cancel stands.
      if (out.kind === "error" && task.state !== "cancelled" && p.retried < 1) {
        try {
          await db.write(async () => {
            const cloned = await cloneTasks(db, [task.id]);
            await restartPrBuilds(db, [{ key, taskId: cloned.get(task.id)! }]);
          });
          s.retried++;
          await jobItem(db, p.repo, p.number, `pr-build: ${out.reason}; queued again`, log);
          continue;
        } catch (e) {
          if (!(e instanceof BuildError)) throw e;
        }
      }
      const sha7 = p.headSha.slice(0, 7);
      if (out.kind === "pass") {
        if (await finish("passed", null)) { s.passed++; await jobItem(db, p.repo, p.number, `pr-build at ${sha7}: passed`, log); }
      } else if (out.kind === "error") {
        if (await finish("error", oneLine(out.reason))) { s.errors++; await jobItem(db, p.repo, p.number, `pr-build at ${sha7}: error: ${oneLine(out.reason)}`, log); }
      } else {
        const why = `${out.step} ${out.timedOut ? "timed out" : `failed with exit code ${out.exitCode ?? "none"}`}`;
        // CI at the same head: the checks row counts only while it was read at this head.
        const row = checks.get(`${p.repo}#${p.number}`);
        const ci = row?.head_oid === p.headSha ? row.overall ?? null : null;
        const disagree = ci === "success";
        if (await finish("failed", why, { ci, disagree })) {
          s.failed++;
          await jobItem(db, p.repo, p.number, `pr-build at ${sha7}: failed: ${why}`, log);
          if (disagree) {
            s.disagreements++;
            await jobItem(db, p.repo, p.number, `pr-build at ${sha7}: failed (${why}) while upstream CI passed`, log);
          }
        }
      }
    } finally { await release(); }
  }
  // CI can finish after our build: the failure then disagrees with it. Noted once; the disagree flag keeps it from repeating.
  const late = await loadLateDisagreements(db, repo);
  const flagged = await settlePrBuilds(db, late.map((d) => ({ key: headKey(d.repo, d.number, d.head), from: "failed" as const, set: { state: "failed", ciOverall: "success", disagree: true } })));
  for (const d of late) {
    if (!flagged.has(headKey(d.repo, d.number, d.head))) continue;
    s.disagreements++;
    await jobItem(db, repo, d.number, `pr-build at ${d.head.slice(0, 7)}: failed (${d.summary ?? "failed"}) while upstream CI passed`, log);
  }
  return s;
}

/** The job step: collect finished builds (also while the switch is off, which stops the queued ones), then queue the builds of new heads while it is on. */
export async function runPrBuilds(db: Db, repo: string, log: (line: string) => void = console.log, deps: PrBuildDeps = { fetchCrates: ghCrates }): Promise<PrBuildSummary> {
  const zero: PrBuildSummary = { queued: 0, passed: 0, failed: 0, errors: 0, stale: 0, retried: 0, disagreements: 0 };
  const out: PrBuildSummary = { ...zero, ...await collectPrBuilds(db, repo, log) };
  if (!await featureOn(db, "pr-builds", repo)) return out;
  const scope = await scopeOf(db, repo);
  const rows: NewPrBuild[] = [];
  const errors: { repo: string; number: number; head: string; scope: string; summary: string }[] = [];
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const c of await selectPrBuilds(db, repo)) {
      if (c.rust === null) {
        const r = await cachedCrates(repo, c.head, deps.fetchCrates, db);
        if (!r.ok) {
          // Recorded as an error so the head is not selected (and fetched) again; a new push is a new head.
          errors.push({ repo, number: c.number, head: c.head, scope, summary: oneLine(`no crate list: ${r.error}`) });
          log(`  ${repo}#${c.number}: no crate list: ${r.error}`);
          continue;
        }
        if (!r.rust) continue;
      }
      // The worker takes its CI gate from the base commit, so a build is never queued without one.
      const base = await (deps.baseOf ?? defaultDeps().baseOf)(repo, c.number);
      if (!base) { log(`  ${repo}#${c.number}: no base commit; not queued`); continue; }
      const plan = planFor("rust", repo, c.head);
      if (!plan) continue;
      const release = await leaseItem(db, `pr:${repo}#${c.number}`, log);
      if (!release) continue;
      releases.push(release);
      rows.push({ repo, number: c.number, head: c.head, base, scope, plan, warm: { key: warmKeyOf(repo), role: "use" }, jobId: currentJobId() });
    }
    await savePrBuildErrors(db, errors);
    if (rows.length && await featureOn(db, "pr-builds", repo)) {
      try {
        const queued = await queuePrBuilds(db, rows);
        for (const r of rows) {
          if (!queued.has(headKey(r.repo, r.number, r.head))) continue;
          out.queued++;
          await jobItem(db, repo, r.number, `pr-build queued at ${r.head.slice(0, 7)}`, log);
        }
      } catch (e) {
        if (!(e instanceof BuildError) && !(e instanceof QueueFullError)) throw e;
        log(`  ${repo}: not queued: ${e.message}`);
      }
    }
  } finally { for (const release of releases) await release(); }
  return out;
}
