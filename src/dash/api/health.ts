// GET /api/health: what needs attention on the instance, for the header's warnings and the Health page. Viewers get the short text
// and nothing about a repo they cannot see.
import type { Health, HealthProblem } from "../../../web/src/api/types.ts";
import { jevEnabled, jevOutage } from "../../agents/jev.ts";
import { tripOf } from "../../core/push-outcome.ts";
import { blankIfHidden } from "../../data/control/index.ts";
import type { TripRow } from "../../data/control/types.ts";
import { OUTSIDE_SURGE } from "../../data/intake/types.ts";
import { itemsListPath, itemsPath } from "../../../web/src/lib/links.ts";
import { loadAttention } from "../../data/views/attention.ts";
import type { AttentionFacts } from "../../data/views/types.ts";
import { checksOf, healthOptions } from "../../health-checks.ts";
import { effectsInTx } from "../../db/effects.ts";
import { isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import { t } from "../../i18n/index.ts";
import { mainCiRepos, type MainCiRepoRow } from "../../mainci/index.ts";
import { DEFAULT_PER_DAY, LIMIT_STEPS } from "../../runner/autopilot.ts";
import { loadSteps } from "../../runner/steps.ts";
import type { Req } from "../types.ts";
import { pipelineSwitch, type PipelineSwitch } from "./limits.ts";
import { canSeeInternals } from "./staff.ts";
import { stepTitle } from "./trace.ts";
import { hiddenRepos } from "./visible.ts";
import type { Db } from "../../db/index.ts";

/**
 * Where a tripped breaker's row goes for staff: the items its evidence names (`photocraft#12`, `photocraft#12@1a2b3c4d`,
 * `main-ci:photocraft#12@1a2b3c4d`, `photocraft#12 attempt 2`; one opens beside the Items list), the held outside items for the surge breaker, else the Work queue.
 * Viewers go to the Work queue: the evidence and the held items are staff's to read.
 */
export function tripTarget(trip: Pick<TripRow, "stage" | "evidence">, hidden: HiddenRepos, staff: boolean): string {
  if (!staff) return "/queue";
  const items = new Map<string, { repo: string; number: number }>();
  for (const e of trip.evidence) {
    const m = /^(?:main-ci:)?([\w.-]+(?:\/[\w.-]+)?)#([1-9]\d*)\b/.exec(e);
    if (m && !isHiddenRepo(hidden, m[1]!)) items.set(`${m[1]}#${m[2]}`, { repo: m[1]!, number: Number(m[2]) });
  }
  return items.size ? itemsListPath([...items.values()]) : trip.stage === OUTSIDE_SURGE ? itemsPath("is:outside-held") : "/queue";
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const areaOf = (id: string): HealthProblem["area"] =>
  id === "runner" ? "runner" : id.startsWith("deadline:") ? "deadline" : id === "liveness" ? "liveness" : id.startsWith("worker:") || id === "build-queue" ? "workers" : id === "user-tokens" ? "account" : "sync";

/** Facts several problem lists read, so the Jev outage and the red main branches are read once per request. */
export type ProblemFacts = { hidden: HiddenRepos; staff: boolean; nowMs: number; facts: Pick<AttentionFacts, "health" | "failedJobs">; ci: MainCiRepoRow[] };

/** The pipeline switch, the health checks that are not ok, the Jev outage, red main branches of repos whose pipeline is on and the last hour's failed jobs. */
export async function healthProblems(db: Db, o: ProblemFacts): Promise<{ state: PipelineSwitch; problems: HealthProblem[] }> {
  const { hidden, staff, facts, ci } = o;
  // Repos with the pipeline off are off by design; their red mains stay on the Main CI page.
  const on = new Set([...facts.health.tracked.values()].filter((r) => r.pipeline).map((r) => r.name));
  const [state, outage, checks] = await Promise.all([
    pipelineSwitch(db),
    jevEnabled(db).then(async (enabled) => (enabled ? await jevOutage(db) : null)),
    checksOf(db, facts.health, { nowMs: o.nowMs, probe: false }),
  ]);
  const out: HealthProblem[] = [];
  if (!state.enabled) out.push({ id: "pipeline", area: "pipeline", tone: "warn", text: `Pipeline is ${state.draining ? "draining" : "off"}${state.changedBy ? `, switched ${state.draining ? "to drain" : "off"} by ${state.changedBy}` : ""}`, to: "/pipeline", since: state.changedAt });
  for (const c of checks) {
    if (c.state === "ok" || (c.repo !== undefined && isHiddenRepo(hidden, c.repo))) continue;
    // `is:stuck` and `is:stale` are staff's filters: a viewer's liveness warning opens the plain list.
    out.push({ id: c.id, area: areaOf(c.id), tone: c.state === "fail" ? "bad" : "warn", text: staff ? c.text : c.brief, to: staff || c.id !== "liveness" ? c.to : "/items", since: c.since, ...(c.ackStep ? { ackStep: c.ackStep } : {}), ...(c.ack ? { ack: c.ack } : {}) });
  }
  if (outage) out.push({ id: "jev", area: "jev", tone: "warn", text: `Jev is unavailable: ${clip(outage.reason, 100)}`, to: "/admin/inference", since: outage.since });
  for (const r of ci.filter((x) => x.state === "red" && on.has(x.repo))) {
    const names = r.failing.map((f) => f.name).slice(0, 2).join(", ");
    out.push({ id: `main-ci:${r.repo}`, area: "main-ci", tone: "bad", text: `Main is red in ${r.repo}${names ? `: ${names}` : ""}`, to: "/main-ci", since: r.redSince });
  }
  const failed = new Map<string, number>();
  for (const j of facts.failedJobs) if (j.repo === null || on.has(j.repo)) failed.set(j.step, (failed.get(j.step) ?? 0) + j.n);
  const byCount = [...failed].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const n = byCount.reduce((a, [, k]) => a + k, 0);
  if (n) {
    const steps = byCount.slice(0, 3).map(([step]) => stepTitle(step)).join(", ");
    out.push({ id: "jobs", area: "jobs", tone: "warn", text: `${n} job${n === 1 ? "" : "s"} failed in the last hour: ${steps}${byCount.length > 3 ? " and more" : ""}`, to: "/pipeline", since: null });
  }
  // Only effects of the last hour: the counters are per process and never reset, so an old one would warn forever.
  const sites = staff ? effectsInTx().sites.filter((x) => o.nowMs - x.lastAt < 3_600_000) : [];
  if (sites.length) out.push({ id: "effects-in-tx", area: "database", tone: "warn", text: `${sites.length} place${sites.length === 1 ? "" : "s"} made an outside call inside a database transaction in the last hour: ${sites.slice(0, 3).map((x) => x.site).join(", ")}${sites.length > 3 ? " and more" : ""}`, to: "/admin/health", since: null });
  return { state, problems: out };
}

export async function health(db: Db, req: Req): Promise<Health> {
  const hidden = await hiddenRepos(db, req);
  const staff = canSeeInternals(req);
  const nowMs = Date.now();
  const [facts, ci, steps] = await Promise.all([
    loadAttention(db, { hidden }, { nowMs, health: healthOptions(), limits: { steps: LIMIT_STEPS, defaults: DEFAULT_PER_DAY } }),
    mainCiRepos(db, hidden, nowMs), loadSteps(),
  ]);
  const { state, problems } = await healthProblems(db, { hidden, staff, nowMs, facts, ci });
  for (const trip of facts.stops.trips) {
    // A push stage trips per repo or on every repo: the problem says which, and a trip on a hidden repo is left out.
    const k = tripOf(trip.stage);
    if (k?.repo && isHiddenRepo(hidden, k.repo)) continue;
    const why = blankIfHidden(trip.reason, hidden);
    problems.push({ id: `breaker:${trip.stage}`, area: "breaker", tone: "bad", text: `${stepTitle(k?.stage ?? trip.stage)}${k ? (k.repo ? ` in ${k.repo}` : " on every repo") : ""} is stopped by its breaker${why ? `: ${clip(why, 120)}` : ""}`, to: tripTarget(trip, hidden, staff), since: trip.trippedAt });
  }
  for (const l of facts.stops.zeroLimits) problems.push({ id: `limit:${l.step}`, area: "limit", tone: "warn", text: `${steps.get(l.step)?.title ?? l.step} is paused (limit 0 a day)`, to: "/pipeline", since: null });
  // The signed-in person's own stored token can no longer be refreshed, so merges and closes they approve cannot run as them.
  const own = facts.health.userTokens.find((u) => u.login.toLowerCase() === req.user.login.toLowerCase());
  if (own) problems.unshift({ id: "user-token:own", area: "account", tone: "bad", text: t("AutoCraft can no longer act as you on GitHub. Authorize again"), to: "/auth/authorize-app", fullPage: true, since: own.updated_at });
  return { pipeline: { enabled: state.enabled, by: state.changedBy, at: state.changedAt }, problems };
}
