// reads: workflow.item_workflows, workflow.item_runners (and through workflow.worksOnPr implement.implementations), mirror.items, access.mcp_tokens, access.access, control.repo_step_approvals
// The conditions that must hold at the instant of the lease, under the login's lock, so they cannot be loaded beforehand.
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { ciEq, indexedBy, literal, ref, schemaEb, type Eb, type Ex } from "../../db/kx.ts";
import { setRunProgress } from "../inference/index.ts";
import { endedByMerge, LIVE_STATES, MERGE_WAYS, MERGED_WORK_MS, worksOnPr } from "../workflow/fragments.ts";
import type { ItemRef } from "../../../web/src/api/types.ts";
import { IDLE_FRESH_MS, INTERACTIVE_PROMPTS, TAKEABLE_BOUND_PROMPTS, LIVE_LEASE_MS, MAX_CALLS_KEY, MAX_CALLS_MAX, STATUS_FRESH_MS, lostLeaseExpr, sha256hex } from "./calls-shared.ts";
import type { LiveLease, Tier } from "./types.ts";
import { expireLeases } from "./calls-expiry.ts";
import { unlease } from "./calls-unlease.ts";

/** The step of the post-merge review: its calls (the review and the calls it makes, a reference check say) are work of the workflow that merged their PR (endedByMerge), also once it ended. */
export const POSTMERGE_STEP = "postmerge";

/** The step of Fix red main: its calls name no item and are the work of who approved Fix red main on the call's repo (repo_step_approvals, step `mainfix`). */
export const MAINFIX_STEP = "main-fix";

/**
 * Some Task Runner of a login the workflow `alias` (an `item_workflows` row) names in `cols` could run the call now: a live runner
 * credential of a maintainer or operator, one of `tierTokens` (the credentials whose reported model serves the call's tier, read by the
 * caller: src/remote/started.ts tierTokens), whose helper reported `ready` within STATUS_FRESH_MS, is active (a lease heartbeat within
 * LIVE_LEASE_MS, or an empty claim within IDLE_FRESH_MS) and has a free slot (its slots, less the fast lane when it has two or more,
 * less its leases outside the own lane), its login not cooling off and under its Max calls at once. The Task Runner snapshot's side is
 * readyWithRoom in src/remote/started.ts. `exceptTokenRef`: a column whose credential (when set) does not count.
 */
export function readyWithRoomExpr(db: Db, eb: Eb, alias: string, cols: readonly string[], now: number, tierTokens: readonly number[], exceptTokenRef?: string): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  if (!tierTokens.length) return w.lit(false);
  const one = w.lit(1).as("one");
  const login = ref<string>("rh.login");
  const slots = w.fn.coalesce("rh.slots", w.lit(1));
  const free = w(slots, "-", w.case().when(slots, ">=", 2).then(1).else(0).end());
  const leased = schemaEb(w).selectFrom("main.remote_calls as rl").select((e: any) => e.fn.countAll().as("n"))
    .where("rl.state", "=", literal("leased")).where("rl.token_id", "=", ref<number>("rh.token_id")).where("rl.own_lane", "<>", 1);
  const max = w.cast(w.case().when("rs.key", "=", MAX_CALLS_KEY).then(w.ref("rs.value")).end(), "bigint");
  return w.exists(schemaEb(w).selectFrom("main.remote_helpers as rh").innerJoin("main.mcp_tokens as rt", "rt.id", "rh.token_id").innerJoin("main.access as ra", "ra.login", "rt.login").select(one)
    .where("rt.kind", "=", "runner").where("rt.expires_at", ">", new Date(now).toISOString()).where("ra.role", "in", ["maintainer", "operator"])
    .where((x: any) => x.or(cols.map((c) => ciEq(db, login, ref<string>(`${alias}.${c}`)))))
    .where("rh.token_id", "in", [...tierTokens]).$if(exceptTokenRef !== undefined, (b: any) => b.where((x: any) => x.or([x(exceptTokenRef!, "is", null), x("rh.token_id", "<>", ref<number>(exceptTokenRef!))]))).where("rh.readiness", "=", "ready").where("rh.reported_at", ">=", now - STATUS_FRESH_MS)
    .where((x: any) => x.or([
      x.exists(schemaEb(x).selectFrom("main.remote_calls as rb").select(one).where("rb.state", "=", literal("leased")).where("rb.token_id", "=", ref<number>("rh.token_id")).where("rb.heartbeat_at", ">=", now - LIVE_LEASE_MS)),
      x("rh.idle_claim_at", ">=", now - IDLE_FRESH_MS),
    ]))
    .where((x: any) => x(free, ">", leased))
    .where((x: any) => x.not(x.exists(schemaEb(x).selectFrom("main.remote_cooloffs as rc").select(one).where(ciEq(db, "rc.login", login)).where("rc.until", ">", now))))
    .where((x: any) => x.not(x.exists(schemaEb(x).selectFrom("main.user_settings as rs").select(one).where(ciEq(db, "rs.login", login)).where("rs.key", "=", MAX_CALLS_KEY)
      .where(x.between(max, 1, MAX_CALLS_MAX)).where(x(leasedCountExpr(db, x, login), ">=", max))))));
}

/**
 * The started-work condition inside the lease update: the call names at least one item (`remote_call_items`) and every one has a live
 * workflow started or approved by `login`, or is the PR that one works on. A live workflow whose work `login` took onto their Task Runner (`item_runners`,
 * not released) counts too while no Task Runner of its starter or approver could run the call now (readyWithRoomExpr, over `tierTokens`:
 * the credentials that serve the call's tier; none given, none does). With `stepRef` (the
 * call's `step` column), a call of the post-merge review's item may instead be a merged PR whose workflow, started or approved by
 * `login`, ended done through that merge since `now` less MERGED_WORK_MS (src/data/workflow/fragments.ts endedByMerge, which the Task
 * Runner snapshot reads too). With `stepRef` and `repoRef` (the call's `repo` column), a call of the main-fix step (MAINFIX_STEP) that
 * names no item may instead be on a repo whose Fix red main approval `login` gave (StartedCalls.owners in src/remote/started.ts).
 */
export function startedWorkAllows(db: Db, eb: Eb, login: string, callIdRef: string, o: { stepRef?: string; repoRef?: string; now?: number; tierTokens?: readonly number[] } = {}): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  const one = w.lit(1).as("one");
  const now = o.now ?? Date.now();
  const by = (x: any, alias: string) => x.or([ciEq(db, `${alias}.started_by`, x.val(login)), ciEq(db, `${alias}.approved_by`, x.val(login))]);
  const took = (x: any, alias: string) => x.and([
    x.exists(schemaEb(x).selectFrom("main.item_runners as tr").select(one).where("tr.workflow_id", "=", ref<number>(`${alias}.id`)).where("tr.login", "=", login.toLowerCase()).where("tr.released_at", "is", null)),
    x.not(readyWithRoomExpr(db, x, alias, ["started_by", "approved_by"], now, o.tierTokens ?? [])),
  ]);
  const since = new Date(now - MERGED_WORK_MS).toISOString();
  const owns = (e: any, item: string) => {
    const live = e.exists(schemaEb(e).selectFrom("main.item_workflows as ow").select(one)
      .where("ow.state", "in", LIVE_STATES).where("ow.repo", "=", ref<string>(`${item}.repo`)).where((x: any) => x.or([by(x, "ow"), took(x, "ow")]))
      .where((x: any) => x.or([x("ow.number", "=", ref<number>(`${item}.number`)), worksOnPr(x, "ow", `${item}.number`)])));
    if (o.stepRef === undefined) return live;
    const merged = MERGE_WAYS.map((via) => e.exists(schemaEb(e).selectFrom("main.item_workflows as mw").select(one)
      .where((x: any) => by(x, "mw")).where((x: any) => endedByMerge(x, "mw", `${item}.repo`, `${item}.number`, since, via))));
    return e.or([live, e.and([e(o.stepRef, "=", POSTMERGE_STEP), e.or(merged)])]);
  };
  const items = () => schemaEb(w).selectFrom("main.remote_call_items as ci").select(one).where("ci.call_id", "=", ref<number>(callIdRef));
  const itemsOwned = w.and([w.exists(items()), w.not(w.exists(items().where((e: any) => e.not(owns(e, "ci")))))]);
  if (o.stepRef === undefined || o.repoRef === undefined) return itemsOwned;
  const fixApproved = w.and([
    w(o.stepRef, "=", MAINFIX_STEP),
    w.not(w.exists(items())),
    w.exists(schemaEb(w).selectFrom("main.repo_step_approvals as fa").select(one).where("fa.repo", "=", ref<string>(o.repoRef)).where("fa.step", "=", "mainfix").where(ciEq(db, "fa.by", w.val(login)))),
  ]);
  return w.or([itemsOwned, fixApproved]);
}

/**
 * A call bound to another person (`for_login`) for an item workflow's work (TAKEABLE_BOUND_PROMPTS) that `login` may lease: a follow-up
 * on the session `login`'s Task Runner holds (`sticky_login`), or a first call (no parent) whose items (at least one) each have a live workflow, or are the
 * PR one works on, whose work `login` took onto their Task Runner (`item_runners`, not released), while no Task Runner of `for_login`
 * could run the call now (readyWithRoomExpr, over `tierTokens`, leaving out the credential whose model declined the call). The Task Runner snapshot's side is StartedCalls.boundTakers in
 * src/remote/started.ts.
 */
export function boundTakeAllows(db: Db, eb: Eb, login: string, o: { now: number; tierTokens: readonly number[] }): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  const one = w.lit(1).as("one");
  const took = (e: any, item: string) => e.exists(schemaEb(e).selectFrom("main.item_workflows as tw").select(one)
    .where("tw.state", "in", LIVE_STATES).where("tw.repo", "=", ref<string>(`${item}.repo`))
    .where((x: any) => x.or([x("tw.number", "=", ref<number>(`${item}.number`)), worksOnPr(x, "tw", `${item}.number`)]))
    .where((x: any) => x.exists(schemaEb(x).selectFrom("main.item_runners as tr").select(one).where("tr.workflow_id", "=", ref<number>("tw.id")).where("tr.login", "=", login.toLowerCase()).where("tr.released_at", "is", null))));
  const items = () => schemaEb(w).selectFrom("main.remote_call_items as bi").where("bi.call_id", "=", ref<number>("remote_calls.id"));
  return w.and([
    w("remote_calls.for_login", "is not", null),
    w.or(TAKEABLE_BOUND_PROMPTS.map((p) => w("remote_calls.prompt_id", "like", `${p}%`))),
    w.or([
      w.and([w("remote_calls.parent_id", "is not", null), ciEq(db, "remote_calls.sticky_login", w.val(login))]),
      w.and([
        w("remote_calls.parent_id", "is", null),
        w.exists(items().select(one)),
        w.not(w.exists(items().select(one).where((x: any) => x.not(took(x, "bi"))))),
        w.not(readyWithRoomExpr(db, w, "remote_calls", ["for_login"], o.now, o.tierTokens, "remote_calls.refused_token")),
      ]),
    ]),
  ]);
}

/**
 * The call's items all left the pipeline: it names at least one, and every one is merged or closed in the mirror. Calls a person waits for
 * or that are bound to one (Discord and interactive prompts, a maintainer's conversation turn) and the post-merge review step's calls, which
 * run on merged PRs, never count. The lease never takes such a call; sync withdraws it (withdrawClosedItemCalls).
 */
export function itemsGoneExpr(eb: Eb, callIdRef: string, cols: { promptId: string; forLogin: string; step: string }): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  const one = w.lit(1).as("one");
  const items = () => schemaEb(w).selectFrom("main.remote_call_items as gi").where("gi.call_id", "=", ref<number>(callIdRef));
  const closed = (x: any) => x.exists(schemaEb(x).selectFrom("main.items as gm").select(one).where("gm.repo", "=", ref<string>("gi.repo")).where("gm.number", "=", ref<number>("gi.number")).where("gm.state", "in", ["MERGED", "CLOSED"]));
  return w.and([
    w(cols.forLogin, "is", null),
    w(cols.step, "<>", POSTMERGE_STEP),
    ...INTERACTIVE_PROMPTS.map((p) => w.not(w(cols.promptId, "like", `${p}%`))),
    w.exists(items().select(one)),
    w.not(w.exists(items().select(one).where((x: any) => x.not(closed(x))))),
  ]);
}

/** The Task Runner credential is live (a runner token not expired) and its login may run tasks (maintainer or operator). */
export function credentialLive(eb: Eb, tokenIdRef: string, nowIso: string): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  return w.exists(schemaEb(w).selectFrom("main.mcp_tokens as lt").innerJoin("main.access as la", "la.login", "lt.login").select(w.lit(1).as("one"))
    .where("lt.id", "=", ref<number>(tokenIdRef)).where("lt.kind", "=", "runner").where("lt.expires_at", ">", nowIso).where("la.role", "in", ["maintainer", "operator"]));
}

/** The role of a live Task Runner credential's user and whether its helper marked itself idle; null when the credential is gone or expired. */
export async function loadRunnerRole(db: Db, tokenId: number, now: number): Promise<{ role: string; idleClaimAt: number | null } | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.mcp_tokens as t").innerJoin("main.access as a", "a.login", "t.login").leftJoin("main.remote_helpers as h", "h.token_id", "t.id")
    .select(["a.role", "h.idle_claim_at"]).where("t.id", "=", tokenId).where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(now).toISOString()));
  return r ? { role: r.role, idleClaimAt: r.idle_claim_at } : null;
}

const LEASE_COLS = ["c.id", "c.job_id", "c.run_id", "c.user_login", "c.prompt_id", "c.items", "c.repo", "c.root", "c.lease_secret_hash", "c.token_id", "c.tier", "c.model", "c.asked_model", "c.step", "c.attempt", "c.max_attempts", "c.leased_at", "c.parent_id", "c.for_login", "c.refusals", "c.setup_retries", "c.lease_timeout_ms", "c.started_at"] as const;

type Found = { lease: LiveLease; bundle: string | null; harness: string | null; harnessVersion: string | null; referenceRepo: string | null };

/**
 * The lease of `secret` with its credential check and lost flag, in one statement; the slow paths (lost lease, credential gone) run here and
 * answer null. `bundle` reads what the harness runs too (up to megabytes, so the lease checks leave it out).
 */
async function findLease(db: Db, secret: string, now: number, o: { bundle?: boolean } = {}): Promise<Found | null> {
  const q = queryDb(db);
  const hash = sha256hex(secret);
  const r = await q.get(q.k.selectFrom("main.remote_calls as c")
    .leftJoin("main.mcp_tokens as t", (j) => j.onRef("t.id", "=", "c.token_id").on("t.kind", "=", "runner").on("t.expires_at", ">", new Date(now).toISOString()))
    .leftJoin("main.access as a", (j) => j.onRef("a.login", "=", "t.login").on("a.role", "in", ["maintainer", "operator"]))
    .select([...LEASE_COLS, "a.login as ok", (eb) => eb.case().when(lostLeaseExpr(db, eb, now, "c")).then(1).else(0).end().as("lost")])
    .$if(!!o.bundle, (b) => b.select(["c.bundle", "c.harness", "c.harness_version", "c.reference_repo"]))
    .where("c.lease_secret_hash", "=", hash).where("c.state", "=", "leased"));
  if (!r) return null;
  if (Number(r.lost) === 1) {
    await expireLeases(db, { now, ids: [Number(r.id)] });
    return null;
  }
  if (r.ok === null) {
    await unlease(db, { id: Number(r.id), runId: r.run_id, hash }, "returned to the queue: the Task Runner that claimed it was removed or may no longer run tasks", now);
    return null;
  }
  // A claim always records its login; a leased row without one has no one to act for.
  if (r.user_login === null) return null;
  const lease: LiveLease = {
    id: Number(r.id), jobId: r.job_id, runId: r.run_id, login: r.user_login, promptId: r.prompt_id, items: JSON.parse(r.items) as ItemRef[], repo: r.repo, root: r.root,
    secretHash: hash, tokenId: r.token_id === null ? null : Number(r.token_id), tier: r.tier as Tier, model: r.model, askedModel: r.asked_model, step: r.step,
    attempt: Number(r.attempt), maxAttempts: Number(r.max_attempts), leasedAt: r.leased_at === null ? null : Number(r.leased_at), parentId: r.parent_id, forLogin: r.for_login, refusals: Number(r.refusals), setupRetries: Number(r.setup_retries),
    leaseTimeoutMs: r.lease_timeout_ms === null ? null : Number(r.lease_timeout_ms), startedAt: r.started_at === null ? null : Number(r.started_at),
  };
  return { lease, bundle: r.bundle ?? null, harness: r.harness ?? null, harnessVersion: r.harness_version ?? null, referenceRepo: r.reference_repo ?? null };
}

const validSecret = (secret: string | undefined): secret is string => !!secret && secret.length <= 200 && secret.startsWith("aclease_");

/** The call by lease secret joined to the runner credential (`mcp_tokens`, `access`), with a `lost` flag. 1 statement; the slow path runs `expireLeases` or `unlease`. */
export async function loadLiveLease(db: Db, secret: string, now: number): Promise<LiveLease | null> {
  return validSecret(secret) ? (await findLease(db, secret, now))?.lease ?? null : null;
}

/** The live lease with its bundle, harness and reference repo in one statement. */
export async function loadLeaseBundle(db: Db, secret: string, now: number): Promise<{ lease: LiveLease; bundle: string; harness: string | null; harnessVersion: string | null; referenceRepo: string | null } | null> {
  const f = validSecret(secret) ? await findLease(db, secret, now, { bundle: true }) : null;
  return f ? { lease: f.lease, bundle: f.bundle!, harness: f.harness, harnessVersion: f.harnessVersion, referenceRepo: f.referenceRepo } : null;
}

/** Fast path of a heartbeat: one compare-and-set update guarded by the lease, the lost test and a valid credential. */
export async function heartbeatLease(db: Db, secret: string, h: { progress: string | null; phase: string | null }, now: number): Promise<{ runId: number | null } | null> {
  if (!validSecret(secret)) return null;
  const q = queryDb(db);
  const r = await q.get(q.k.updateTable("main.remote_calls").set((eb) => ({
    heartbeat_at: now, ...(h.progress !== null && { progress: h.progress }),
    ...(h.phase === "running" && { started_at: eb.case().when("started_at", "is", null).then(now).else(eb.ref("started_at")).end() }),
  })).where("lease_secret_hash", "=", sha256hex(secret)).where("state", "=", "leased")
    .where((eb) => eb.not(lostLeaseExpr(db, eb, now))).where((eb) => credentialLive(eb, "remote_calls.token_id", new Date(now).toISOString()))
    .returning(["id", "run_id"]));
  if (!r) {
    // No row: the lease is lost, ended or its credential gone; the slow path ends it as needed and the route answers 410.
    await findLease(db, secret, now);
    return null;
  }
  if (h.progress !== null && r.run_id !== null) await setRunProgress(db, [{ id: r.run_id, line: h.progress }]);
  return { runId: r.run_id };
}

/** Deletes the last status of tokens that no longer exist (the backstop of `removeHelpers`). */
export async function deleteOrphanHelpers(db: Db): Promise<number> {
  const q = queryDb(db);
  const r = await q.run(q.k.deleteFrom("main.remote_helpers").where((eb) => eb.not(eb.exists(q.k.selectFrom("main.mcp_tokens as t").select(eb.lit(1).as("one")).where("t.id", "=", ref<number>("remote_helpers.token_id"))))));
  return Number(r.changes);
}

/** The leases `loginExpr` holds outside the own lane, as a scalar subquery (the count `Max calls at once` limits). */
export function leasedCountExpr(db: Db, eb: Eb, loginExpr: Ex): Expression<number> {
  const w = schemaEb(eb) as any;
  return w.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "pl")).select((e: any) => e.fn.coalesce(e.fn.sum(e.case().when("pl.own_lane", "=", 1).then(0).else(1).end()), e.lit(0)).as("n"))
    .where("pl.state", "=", literal("leased")).where(ciEq(db, "pl.user_login", loginExpr));
}

/**
 * On a `remote_calls` row that has a pick: the pick no longer counts at `now`, as its time is up or its picker cannot take it now: no fresh Task Runner
 * credential, cooling off, or already at its Max calls at once.
 */
export function pickLapsedExpr(db: Db, eb: Eb, now: number): Expression<SqlBool> {
  const w = schemaEb(eb) as any;
  const one = w.lit(1).as("one");
  const login = ref<string>("remote_calls.picked_by");
  const max = w.cast(w.case().when("ps.key", "=", MAX_CALLS_KEY).then(w.ref("ps.value")).end(), "bigint");
  const picker = w.and([
    w.exists(schemaEb(w).selectFrom("main.remote_helpers as ph").innerJoin("main.mcp_tokens as pt", "pt.id", "ph.token_id").select(one)
      .where("ph.login", "=", login).where("pt.kind", "=", "runner").where("pt.expires_at", ">", new Date(now).toISOString()).where("ph.reported_at", ">=", now - STATUS_FRESH_MS)),
    w.not(w.exists(schemaEb(w).selectFrom("main.remote_cooloffs as pc").select(one).where("pc.login", "=", login).where("pc.until", ">", now))),
    w.not(w.exists(schemaEb(w).selectFrom("main.user_settings as ps").select(one).where("ps.login", "=", login).where("ps.key", "=", MAX_CALLS_KEY)
      .where(w.between(max, 1, MAX_CALLS_MAX)).where(w(leasedCountExpr(db, w, login), ">=", max)))),
  ]);
  return w.or([w("pick_until", "<", now), w.not(picker)]);
}
