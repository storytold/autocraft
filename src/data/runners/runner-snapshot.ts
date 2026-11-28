// reads: access.mcp_tokens, access.access
// Runner snapshot and takers (package runners-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { loadPermissionDenials } from "../access/index.ts";
import { loadStepApprovals, loadTrackedRepos } from "../control/index.ts";
import { loadStartedWork } from "../workflow/index.ts";
import { loadQueue } from "./calls-read.ts";
import { withdrawCalls } from "./calls-queue.ts";
import { DROP_REASON } from "./cooloffs.ts";
import { runnerCredentials, runnerRowOf, STATUS_FRESH_MS } from "./helpers.ts";
import { cachedSnapshot, dropSnapshotCache, keepSnapshot } from "./snapshot-cache.ts";
import { settingsByLogin, USER_SETTING_KEYS } from "./user-settings.ts";
import type { LowerLogin, RunnerSnapshot, StartedWork, SweepState, TakerSweepPlan } from "./types.ts";

/** Calls whose prompt starts with one of these run in a login's Interactive slots; keep in step with the claim's rule. */
const INTERACTIVE_LIKE = "discord.%";

/** The reads of other modules the snapshot embeds; tests may pass fixed answers in their place. */
export type SnapshotDeps = {
  started: (db: Db, now: number) => Promise<{ live: { repo: string; number: number; entry: string; startedBy: string; approvedBy: string | null; state: string; takenBy?: string[] }[]; prs: { repo: string; pr: number; startedBy: string; approvedBy: string | null; takenBy?: string[] }[]; merged?: { repo: string; pr: number; startedBy: string; approvedBy: string | null }[] }>;
  /** Non-write permission checks of every login with a live runner credential, by "login\nrepo", with when each was checked. */
  denials: (db: Db, logins: { runners: true }, now: number) => Promise<Map<string, { checkedAt: string }>>;
  /** The repos approved for Fix red main with who approved each; left out, the control module's rows. */
  mainFix?: (db: Db) => Promise<{ repo: string; by: string }[]>;
};
const mainFixApprovers = async (db: Db): Promise<{ repo: string; by: string }[]> =>
  [...await loadStepApprovals(db, "all", ["mainfix"])].flatMap(([repo, a]) => (a.mainfix ? [{ repo, by: a.mainfix.by }] : []));
const REAL: SnapshotDeps = { started: loadStartedWork, denials: loadPermissionDenials, mainFix: mainFixApprovers };

/** The workflow module's started-work rows and the Fix red main approvals in the shape the pure builder reads. */
const startedOf = (w: Awaited<ReturnType<SnapshotDeps["started"]>>, mainfix: { repo: string; by: string }[] = []): StartedWork => ({
  live: w.live.map((r) => ({ repo: r.repo, number: r.number, entry: r.entry, state: r.state, started_by: r.startedBy, approved_by: r.approvedBy, ...(r.takenBy && { taken_by: r.takenBy }) })),
  prs: w.prs.map((r) => ({ repo: r.repo, prNumber: r.pr, started_by: r.startedBy, approved_by: r.approvedBy, ...(r.takenBy && { taken_by: r.takenBy }) })),
  merged: (w.merged ?? []).map((r) => ({ repo: r.repo, prNumber: r.pr, started_by: r.startedBy, approved_by: r.approvedBy })),
  mainfix,
});

/**
 * Every live Task Runner credential with its status, the settings of their users, live cool-offs, lease counts, permission denials and
 * started work (with the Fix red main approvals), in one wave whatever the number of runners, repos and calls (`access` reads the denials of live runner logins itself).
 * Cached 2 s per `Db` (`snapshot-cache.ts`), dropped by the writers of runner state.
 */
export function loadRunnerSnapshot(db: Db, now: number, deps?: SnapshotDeps): Promise<RunnerSnapshot> {
  if (deps) return readSnapshot(db, now, deps);
  return cachedSnapshot(db, now) ?? keepSnapshot(db, now, readSnapshot(db, now, REAL));
}

async function readSnapshot(db: Db, now: number, deps: SnapshotDeps): Promise<RunnerSnapshot> {
  const q = queryDb(db);
  const iso = new Date(now).toISOString();
  const [creds, settingRows, cooled, leases, started, denials, mainfix] = await db.together(() => Promise.all([
    q.all(runnerCredentials(db, now).orderBy("t.id")),
    q.all(q.k.selectFrom("main.user_settings").select(["login", "key", "value"]).where(kx.inList(db, "key", USER_SETTING_KEYS))
      .where("login", "in", (eb) => eb.selectFrom("main.mcp_tokens").select("login").where("kind", "=", "runner").where("expires_at", ">", iso))),
    q.all(q.k.selectFrom("main.remote_cooloffs").select(["login", "until", "reason"]).where("until", ">", now)),
    q.all(q.k.selectFrom(kx.indexedBy(db, "main.remote_calls", "remote_calls_leased", "c"))
      .select((eb) => ["c.token_id", "c.user_login", "c.own_lane", eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("c.heartbeat_at").as("beat"),
        eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("c.prompt_id", "like", INTERACTIVE_LIKE).then(1).else(0).end()), eb.lit(0)).as("interactive")])
      .where("c.state", "=", kx.literal("leased")).groupBy(["c.token_id", "c.user_login", "c.own_lane"])),
    deps.started(db, now),
    deps.denials(db, { runners: true }, now),
    (deps.mainFix ?? mainFixApprovers)(db),
  ]));
  const logins = [...new Set(creds.map((r) => r.login))];

  const perToken = new Map<number, { leased: number; own: number; beat: number | null }>();
  const leasedByLogin = new Map<LowerLogin, { leased: number; interactive: number }>();
  for (const l of leases) {
    const n = Number(l.n), own = Number(l.own_lane) === 1;
    if (l.token_id !== null) {
      const t = perToken.get(Number(l.token_id)) ?? { leased: 0, own: 0, beat: null };
      if (own) t.own += n; else t.leased += n;
      if (l.beat !== null && (t.beat === null || Number(l.beat) > t.beat)) t.beat = Number(l.beat);
      perToken.set(Number(l.token_id), t);
    }
    if (l.user_login !== null) {
      const key = l.user_login.toLowerCase();
      const u = leasedByLogin.get(key) ?? { leased: 0, interactive: 0 };
      if (!own) u.leased += n;
      else u.interactive += Number(l.interactive);
      leasedByLogin.set(key, u);
    }
  }
  const runners = creds.map((c) => {
    const row = runnerRowOf(c);
    const t = perToken.get(row.tokenId);
    return { ...row, leased: t?.leased ?? 0, ownLaneLeased: t?.own ?? 0, beatAt: t?.beat ?? null };
  });
  return {
    at: now, runners, settings: settingsByLogin(settingRows, logins),
    cooled: new Map(cooled.map((c) => [c.login.toLowerCase(), { until: new Date(Number(c.until)).toISOString(), reason: c.reason ?? DROP_REASON }] as const)),
    denied: new Set(denials.keys()), leasedByLogin, started: startedOf(started, mainfix),
  };
}

/** Runner credentials that may take calls now: live, fresh, ready, and their login not cooling off. On `t` joined to its status `h`. */
const takerExpr = (eb: kx.Eb, now: number) => eb.and([
  eb("t.kind", "=", "runner"), eb("t.expires_at", ">", new Date(now).toISOString()), eb("h.readiness", "=", "ready"), eb("h.reported_at", ">=", now - STATUS_FRESH_MS),
  eb.not(eb.exists(kx.schemaEb(eb).selectFrom("main.remote_cooloffs as co").select(eb.lit(1).as("one")).where("co.login", "=", eb.ref("t.login")).where("co.until", ">", now))),
]);

const lastSignature = new WeakMap<Db, string>();

/**
 * The runners the taker rule reads, in a form that changes only when they or what decides their repos change: each one's login, role,
 * My repos, own repo list and skipped tasks. The planner adds it to its input, so work left for want of a taker is planned again when one
 * connects or comes back, without every status report waking the planner. Then, per user with an item choice, the repos of the items they
 * take (started work, or the work they started or approved), and the oldest cached non-write permission check of the takers' logins, so
 * the signature changes when that one expires. One wave: the grouped string, the takers with their item choice, the started work and the
 * permission checks. A signature that differs from the handle's last one drops the cached snapshot: work planned on it must not be
 * judged on an older reading, which would leave it waiting for a signature that does not change again.
 */
export async function loadTakerSignature(db: Db, now: number, deps: SnapshotDeps = REAL): Promise<string> {
  const sig = await readTakerSignature(db, now, deps);
  if (lastSignature.get(db) !== sig) {
    lastSignature.set(db, sig);
    dropSnapshotCache(db);
  }
  return sig;
}

async function readTakerSignature(db: Db, now: number, deps: SnapshotDeps): Promise<string> {
  const q = queryDb(db);
  const [sig, takers, started, denials] = await db.together(() => Promise.all([
    q.get(q.k.selectFrom((eb) => eb.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id").leftJoin("main.access as a", "a.login", "t.login")
      .leftJoin("main.user_settings as us", (j) => j.onRef("us.login", "=", "t.login").on("us.key", "=", "repos"))
      .leftJoin("main.user_settings as sk", (j) => j.onRef("sk.login", "=", "t.login").on("sk.key", "=", "skip_tasks"))
      .select((e) => [[e.fn<string>("lower", ["t.login"]), e.fn.coalesce("a.role", e.val("")), e.fn.coalesce("us.value", e.val("")), e.fn.coalesce("h.idle_repos", e.val("")), e.fn.coalesce("sk.value", e.val(""))]
        .reduce((acc, part) => e(e(acc, "||", e.val(":")), "||", part)).as("k")])
      .distinct().where((e) => takerExpr(e, now)).as("ks"))
      .select(kx.groupConcat(db, "k", ";", kx.bytewise(db, "k")).as("s"))),
    q.all(q.k.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id")
      .leftJoin("main.user_settings as ti", (j) => j.onRef("ti.login", "=", "t.login").on("ti.key", "=", "task_items"))
      .select(["t.login", "ti.value as items"]).where((eb) => takerExpr(eb, now)).groupBy(["t.login", "ti.value"]).orderBy((eb) => eb.fn("lower", ["t.login"])).orderBy("t.login")),
    deps.started(db, now),
    deps.denials(db, { runners: true }, now),
  ]));
  if (!sig?.s) return "";
  const work = startedOf(started);
  const filtered = takers.filter((t) => t.items !== null).map((t) => {
    const me = t.login.toLowerCase();
    const mine = (by: string, approved: string | null): boolean => by.toLowerCase() === me || approved?.toLowerCase() === me;
    const repos = new Set<string>();
    if (t.items === "started" || t.items === "fast") {
      for (const r of work.live) repos.add(r.repo);
      for (const r of work.prs) repos.add(r.repo);
    } else if (t.items === "mine") {
      for (const r of work.live) if (mine(r.started_by, r.approved_by)) repos.add(r.repo);
      for (const r of work.prs) if (mine(r.started_by, r.approved_by)) repos.add(r.repo);
    }
    return `${me}=${[...repos].sort().join(",")}`;
  });
  // The takers' oldest cached denial: the signature changes when it expires, and not for a login that takes nothing now.
  const taking = new Set(takers.map((t) => t.login.toLowerCase()));
  const oldest = [...denials].filter(([key]) => taking.has(key.slice(0, key.indexOf("\n")))).map(([, d]) => d.checkedAt).sort()[0];
  const s = filtered.length ? `${sig.s}|items:${filtered.join(";")}` : sig.s;
  return oldest ? `${s}|${oldest}` : s;
}

/**
 * What `sweepTakers` needs: the snapshot, the queue, the pipeline-on repos, the `remote_no_taker` rows and the queued calls with
 * `no_taker_since`. One wave of five reads (the snapshot's own join it).
 */
export async function loadSweepState(db: Db, now: number): Promise<SweepState> {
  const q = queryDb(db);
  const [snapshot, queue, tracked, noTaker, marked] = await db.together(() => Promise.all([
    loadRunnerSnapshot(db, now),
    loadQueue(db, now),
    loadTrackedRepos(db),
    q.all(q.k.selectFrom("main.remote_no_taker").select(["repo", "since"])),
    q.all(q.k.selectFrom("main.remote_calls").select(["id", "no_taker_since"]).where("state", "=", "queued").where("no_taker_since", "is not", null)),
  ]));
  return {
    snapshot, queue, pipelineRepos: [...tracked.values()].filter((r) => r.pipeline).map((r) => r.name).sort(),
    noTakerRepos: new Map(noTaker.map((r) => [r.repo, Number(r.since)] as const)),
    marked: new Map(marked.map((r) => [Number(r.id), Number(r.no_taker_since)] as const)),
  };
}

/**
 * Applies a sweep plan in one transaction: `remote_no_taker` rows inserted (an existing mark keeps its time) and deleted, `no_taker_since`
 * set on and cleared from queued calls, then the withdrawals. Returns the number withdrawn.
 */
export async function saveTakerSweep(db: Db, plan: TakerSweepPlan, now: number): Promise<number> {
  const q = queryDb(db);
  const withdrawn = await db.write(async () => {
    if (plan.deleteRepos.length) await q.run(q.k.deleteFrom("main.remote_no_taker").where(kx.inList(db, "repo", plan.deleteRepos)));
    if (plan.insertRepos.length) await q.run(q.k.insertInto("main.remote_no_taker").values(plan.insertRepos.map((repo) => ({ repo, since: now }))).onConflict((oc) => oc.doNothing()));
    if (plan.mark.length) await q.run(q.k.updateTable("main.remote_calls").set({ no_taker_since: now }).where(kx.inList(db, "id", plan.mark, "bigint")).where("state", "=", "queued"));
    if (plan.clear.length) await q.run(q.k.updateTable("main.remote_calls").set({ no_taker_since: null }).where(kx.inList(db, "id", plan.clear, "bigint")).where("state", "=", "queued"));
    return plan.withdraw.length ? (await withdrawCalls(db, plan.withdraw, { states: ["queued"], now })).length : 0;
  });
  dropSnapshotCache(db);
  return withdrawn;
}
