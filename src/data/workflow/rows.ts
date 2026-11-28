// `item_workflows` and `workflow_events` (M10 workflow-a).
// reads: implement.implementations and mirror.items (through the link fragments), mirror.items (through mirror.openItem), access (canActExpr, writeCheckedAt), changes (operatorFixEnded)
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { canActExpr, writeCheckedAt } from "../access/fragments.ts";
import { HOLD_MAX } from "../access/permissions.ts";
import { operatorFixEnded } from "../changes/fragments.ts";
import { openItem } from "../mirror/fragments.ts";
import { weightOfScore } from "../../core/work-score.ts";
import { endedByMerge, MERGE_WAYS, goOnAt, isGoOn, linkRows, LIVE_LINKS, LIVE_STATES, MERGED_WORK_MS, notArchived, prIssueWorkflows, seenAt, withLiveLinks, workScore } from "./fragments.ts";
import { linkWorkflows } from "./link.ts";
import { patchRows } from "./update.ts";
import { loadChatBefore, patchTalks, recordWorkflowMessages, retitleConversations } from "../chat/workflow.ts";
import type {
  Blocker, EndedWorkflow, Entry, ItemKind, ItemWorkflow, NewWorkflow, OperatorWork, PlanPart, Preapproval, PrWorkflows, QueuePosition, Recommendation, RefKey, StartedFilter,
  GoneOn, SaidEvent, StartedWork, StoredEvent, Surface, WorkflowEvent, WorkflowEventKind, WorkflowFact, WorkflowFilter, WorkflowPassFacts, WorkflowPatch, WorkflowRead, WorkflowState,
} from "./types.ts";
import { authorAsk, RULE_STARTER, type Parsed } from "../../workflow/types.ts";

const ACTIVE_LEGS = ["fixup", "review", "ci", "queued"];

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const isEmpty = (keys: KeySource): boolean => Array.isArray(keys) && keys.length === 0;
const one = (eb: kx.AnyEb) => eb.lit(1).as("one");
const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
const flag = (v: unknown): boolean => v === true || Number(v) === 1;
const pairs = (refs: { repo: string; number: number }[]) => refs.map((r) => [r.repo, r.number] as const);

export type WorkflowRow = {
  id: number; repo: string; number: number; kind: string; entry: string; weight: number; state: string; started_by: string; started_at: string; started_via: string;
  base_head: string | null; approved_by: string | null; approved_at: string | null; approved_via: string | null; stopped_by: string | null; stopped_at: string | null;
  blocker: string | null; blocker_params: string | null; rec: string | null; rec_at: string | null; rec_head: string | null; plan: string; legacy_preapproval_id: number | null;
  updated_at: string; step: string | null; pr_number: number | string | null; version: number; accepted_head: string | null; review_asked_at: string | null; taken_by: string | null;
};

/** Blockers earlier releases wrote that no longer exist; a row stopped at one reads as `other` until src/workflow/retired-stops.ts resumes it. */
export const RETIRED_BLOCKERS: readonly string[] = ["large-fix", "outside-purpose", "major-finding", "beyond-agreed"];

/**
 * Waits an earlier release asked the approver about as `other` that no longer ask as they did: a failed verification and screenshots that
 * show a regression, which AutoCraft now fixes itself, and review fixes nobody makes (`answer`, `ask-failed`), whose minor fixes are filed as
 * follow-ups; a blocking one nobody can make asks again as a fix that could not be made.
 */
const RETIRED_WAITS: readonly unknown[] = ["verification-failed", "screenshots", "answer", "ask-failed"];

/**
 * A stop of an approved item that no longer stops it, as an earlier release stored it (the blocker column and its params): a retired blocker,
 * the limit of our pushes per approval, or a finding AutoCraft now fixes before the merge.
 */
export const retiredStop = (blocker: unknown, params: Record<string, unknown> | null | undefined): boolean =>
  typeof blocker === "string" && (RETIRED_BLOCKERS.includes(blocker) || (blocker === "other" && (params?.limit === "pushes" || RETIRED_WAITS.includes(params?.code))));

/** What a held row goes back to: a question at a retired stop is no question any more, so a resume runs on. */
function heldParams(p: Record<string, unknown> | null): Record<string, unknown> | null {
  const held = p?.held as { rec?: unknown; blocker?: unknown; params?: Record<string, unknown> } | undefined;
  if (!held || !retiredStop(held.blocker, held.params)) return p;
  const { rec: _rec, blocker: _blocker, params: _params, ...rest } = held;
  return { ...p, held: rest };
}

/** An `item_workflows` row as the domain type (the module's one mapper). */
export function workflowOf(r: WorkflowRow): ItemWorkflow {
  return {
    id: Number(r.id), repo: r.repo, number: Number(r.number), kind: r.kind as ItemKind, entry: r.entry as Entry, weight: Number(r.weight), state: r.state as WorkflowState,
    startedBy: r.started_by, startedAt: r.started_at, startedVia: r.started_via as Surface, baseHead: r.base_head, acceptedHead: r.accepted_head,
    approvedBy: r.approved_by, approvedAt: r.approved_at, approvedVia: r.approved_via as Surface | null,
    stoppedBy: r.stopped_by, stoppedAt: r.stopped_at, takenBy: r.taken_by ?? null,
    blocker: (r.blocker !== null && RETIRED_BLOCKERS.includes(r.blocker) ? "other" : r.blocker) as Blocker | null, blockerParams: heldParams(parse<Record<string, unknown> | null>(r.blocker_params, null)),
    rec: parse<Recommendation | null>(r.rec, null), recAt: r.rec_at, recHead: r.rec_head,
    plan: parse<PlanPart[]>(r.plan, []), step: r.step, prNumber: r.pr_number === null ? null : Number(r.pr_number), reviewAskedAt: r.review_asked_at, legacyPreapprovalId: r.legacy_preapproval_id === null ? null : Number(r.legacy_preapproval_id), version: Number(r.version), updatedAt: r.updated_at,
  };
}

const factOf = (w: ItemWorkflow, own: boolean, goOn: string | null): WorkflowFact => {
  const gone = w.plan.filter((p) => p.state === "dropped");
  const dropped = gone.filter((p) => !p.premerge).map((p) => p.title.toLowerCase());
  // Only a person who settles an approved merge overrules a pre-merge finding (G2).
  const droppedFindings = w.approvedBy === null ? [] : gone.filter((p) => p.premerge).map((p) => ({ title: p.title.toLowerCase(), head: p.droppedAt ?? null }));
  const ask = authorAsk(w);
  return {
    id: w.id, entry: w.entry, approved: w.approvedBy !== null, approvedBy: w.approvedBy, startedBy: w.startedBy, startedAt: w.startedAt, weight: w.weight, state: w.state, own,
    since: goOn !== null && goOn > w.startedAt ? goOn : w.startedAt, reviewAskedAt: w.reviewAskedAt, baseHead: w.baseHead,
    ...(dropped.length ? { dropped } : {}), ...(droppedFindings.length ? { droppedFindings } : {}), ...(ask ? { authorAsk: ask.auto ? "auto" as const : "person" as const } : {}),
  };
};

/**
 * Who a workflow acts for, the newest first: whoever last answered or resumed it, approved its merge or started it, never the automatic
 * merge rule. Their command is the authority of
 * its work, an implementation and its PR's revisions among it (src/workflow/work.ts settlerOf picks the one who may act).
 */
export function workflowActors(w: Pick<ItemWorkflow, "startedBy" | "startedAt" | "approvedBy" | "approvedAt">, answer: { login: string; at: string } | null | undefined): string[] {
  const said = [
    ...(answer ? [answer] : []),
    ...(w.approvedBy !== null ? [{ login: w.approvedBy, at: w.approvedAt ?? w.startedAt }] : []),
    { login: w.startedBy, at: w.startedAt },
  ].sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));
  const seen = new Set<string>();
  return said.flatMap(({ login }) => { const key = login.toLowerCase(); return login === RULE_STARTER || seen.has(key) ? [] : (seen.add(key), [login]); });
}

/** Case-insensitive `col IN logins` with a statement text that does not depend on the list. */
const loginIn = (db: Db, eb: kx.AnyEb, col: string, logins: string[], alias: string) =>
  eb.exists(kx.schemaEb(eb).selectFrom(kx.jsonEach(db, kx.json(logins), alias)).select(one(eb)).where(kx.ciEq(db, col, `${alias}.value`)));

/** The events whose maker a workflow acts for. */
const SAID_EVENTS = ["answered", "resumed"];

type EndedRow = { repo: string; number: number | string; state: string };

/** The newest workflow of each item of `keys`, or of the issue a PR of `keys` was opened for (prIssueWorkflows), whichever is newer, when it has ended. */
const endedQuery = (db: Db, keys: KeySource) => {
  const k = queryDb(db).k as any;
  const own = k.selectFrom("main.item_workflows as w").innerJoin(resolveKeys(db, keys, "ke"), (j: any) => j.onRef("ke.repo", "=", "w.repo").onRef("ke.number", "=", "w.number"))
    .select(["w.repo as repo", "w.number as number", "w.state as state", "w.id as id"]);
  const ofPr = prIssueWorkflows(db, keys);
  const ranked = k.selectFrom(own.union(ofPr).as("u"))
    .select((e: any) => ["u.repo", "u.number", "u.state", e.fn.agg("row_number").over((o: any) => o.partitionBy(["u.repo", "u.number"]).orderBy("u.id", "desc")).as("rn")]);
  return k.selectFrom(ranked.as("x")).select(["x.repo", "x.number", "x.state"]).where("x.rn", "=", 1).where("x.state", "not in", LIVE_STATES).orderBy("x.repo").orderBy("x.number");
};
const endedOf = (rows: EndedRow[]): Map<RefKey, EndedWorkflow> => new Map(rows.map((r) => [refKey(r.repo, Number(r.number)), r.state as EndedWorkflow]));

/** How the newest workflow of each item, or of the issue a PR was opened for, ended; items whose newest is live, or that have none, are left out. One statement. */
export async function loadEndedWorkflows(db: Db, keys: KeySource): Promise<Map<RefKey, EndedWorkflow>> {
  if (isEmpty(keys)) return new Map();
  return endedOf(await queryDb(db).all(endedQuery(db, keys)) as EndedRow[]);
}

/**
 * The planner pass's set loader: live workflows with the PR an implement workflow works on, latest ended state per item (a PR's own or its issue's), queued requests and
 * active legs; four statements in one wave. A request counts only while its maker may still act on the repo (`access.canActExpr`: the
 * app identity, and a write permission GitHub confirmed within `HOLD_MAX` of `nowMs`) and while no final fix-up row of it exists.
 */
export async function loadWorkflowFacts(db: Db, keys: KeySource, o: { nowMs?: number } = {}): Promise<WorkflowPassFacts> {
  const out: WorkflowPassFacts = { live: new Map(), ofPr: new Map(), actors: new Map(), ended: new Map(), operator: new Map() };
  if (isEmpty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const after = new Date((o.nowMs ?? Date.now()) - HOLD_MAX).toISOString();
  const keyed = (alias: string, a: string, b: string) => (eb: any) => eb.exists(k.selectFrom(resolveKeys(db, keys, alias)).select(one(eb)).whereRef(`${alias}.repo`, "=", a).whereRef(`${alias}.number`, "=", b));

  /** A column of the newest answer or resume of a workflow. */
  const lastAnswer = (alias: string, col: string) => k.selectFrom(`main.workflow_events as ${alias}`).select(`${alias}.${col}`).whereRef(`${alias}.workflow_id`, "=", "w.id")
    .where(`${alias}.kind`, "in", SAID_EVENTS).orderBy(`${alias}.id`, "desc").limit(1);
  // live_links: shared with the duplicate members read of the same wave (withLiveLinks).
  const liveQ = withLiveLinks(db, k).selectFrom("main.item_workflows as w")
    .leftJoin(`${LIVE_LINKS} as l`, "l.wid", "w.id")
    .selectAll("w")
    .select((eb: any) => [
      "l.pr as pr",
      eb.case().when(keyed("ko", "w.repo", "w.number")(eb)).then(1).else(0).end().as("own"),
      eb.case().when(eb.and([eb("l.pr", "is not", null), keyed("kp", "w.repo", "l.pr")(eb)])).then(1).else(0).end().as("pr_hit"),
      lastAnswer("a1", "login").as("answer_by"), lastAnswer("a2", "at").as("answer_at"),
      goOnAt(eb, "w.id").as("go_on"),
    ])
    .where("w.state", "in", LIVE_STATES)
    .where((eb: any) => eb.or([keyed("ko2", "w.repo", "w.number")(eb), eb.and([eb("l.pr", "is not", null), keyed("kp2", "w.repo", "l.pr")(eb)])]))
    .orderBy("w.id");

  const endedQ = endedQuery(db, keys);

  const requestsQ = k.selectFrom("main.operator_fixups as o").innerJoin(resolveKeys(db, keys, "kr"), (j: any) => j.onRef("kr.repo", "=", "o.repo").onRef("kr.number", "=", "o.number"))
    .selectAll("o").select((eb: any) => writeCheckedAt(db, eb, "o.by", "o.repo").as("maker_checked_at")).where("o.state", "=", "queued")
    .where((eb: any) => canActExpr(db, eb, "o.by", "o.repo", after))
    .where((eb: any) => eb.not(operatorFixEnded(eb, "o")))
    .orderBy("o.repo").orderBy("o.number").orderBy("o.from_head").orderBy("o.id");

  const legsQ = k.selectFrom("main.preapprovals as p").innerJoin(resolveKeys(db, keys, "kl"), (j: any) => j.onRef("kl.repo", "=", "p.repo").onRef("kl.number", "=", "p.number"))
    .selectAll("p").where("p.state", "in", ACTIVE_LEGS).orderBy("p.id");

  const [live, ended, requests, legs] = await db.together(() => Promise.all([q.all(liveQ), q.all(endedQ), q.all(requestsQ), q.all(legsQ)])) as
    [(WorkflowRow & { pr: number | null; own: unknown; pr_hit: unknown; answer_by: string | null; answer_at: string | null; go_on: string | null })[], { repo: string; number: number; state: string }[], OperatorWork["requests"], Preapproval[]];

  for (const r of live) {
    const w = workflowOf(r);
    out.actors.set(w.id, workflowActors(w, r.answer_by !== null ? { login: r.answer_by, at: r.answer_at! } : null));
    if (flag(r.own)) out.live.set(refKey(w.repo, w.number), factOf(w, true, r.go_on));
    if (flag(r.pr_hit) && w.entry === "implement" && r.pr !== null) out.ofPr.set(refKey(w.repo, Number(r.pr)), factOf(w, false, r.go_on));
  }
  for (const [key, state] of endedOf(ended)) out.ended.set(key, state);
  const work = (repo: string, number: number): OperatorWork => {
    const key = refKey(repo, Number(number));
    let w = out.operator.get(key);
    if (!w) out.operator.set(key, (w = { requests: [], legs: [] }));
    return w;
  };
  for (const r of requests) work(r.repo, r.number).requests.push(r);
  for (const p of legs) work(p.repo, p.number).legs.push(p);
  return out;
}

/** Filter loader ordered by id. An empty list in any filter matches nothing. */
export async function listWorkflows(db: Db, f: WorkflowFilter = {}): Promise<ItemWorkflow[]> {
  if (f.ids?.length === 0 || f.refs?.length === 0 || f.repos?.length === 0 || f.states?.length === 0 || f.logins?.length === 0 || f.storedBlockers?.length === 0) return [];
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.item_workflows as w").selectAll("w")
    .$if(!!f.ids, (b: any) => b.where(kx.inList(db, "w.id", f.ids!, "bigint")))
    .$if(f.live !== undefined, (b: any) => b.where("w.state", f.live ? "in" : "not in", LIVE_STATES))
    .$if(!!f.repos, (b: any) => b.where(kx.inList(db, "w.repo", f.repos!)))
    .$if(!!f.refs, (b: any) => b.where(kx.refIn(db, "w", pairs(f.refs!))))
    .$if(!!f.states, (b: any) => b.where(kx.inList(db, "w.state", f.states!)))
    .$if(!!f.logins, (b: any) => b.where((eb: any) => eb.or([loginIn(db, eb, "w.started_by", f.logins!, "ls"), loginIn(db, eb, "w.approved_by", f.logins!, "la")])))
    .$if(f.approved !== undefined, (b: any) => b.where("w.approved_by", f.approved ? "is not" : "is", null))
    .$if(f.recAfter !== undefined, (b: any) => b.where("w.rec_at", ">", f.recAfter!))
    .$if(!!f.storedBlockers, (b: any) => b.where(kx.inList(db, "w.blocker", f.storedBlockers!)))
    .orderBy("w.id")) as WorkflowRow[];
  return rows.map(workflowOf);
}

/** The live workflow that works on each PR: its own, else the implement workflow of an issue that does (linkRows). `others`: without the PR's own. One statement. */
export async function loadPrWorkflows(db: Db, refs: { repo: string; number: number }[], o: { others?: boolean } = {}): Promise<PrWorkflows> {
  const out: PrWorkflows = new Map();
  if (refs.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const own = k.selectFrom("main.item_workflows as o").innerJoin(resolveKeys(db, refs, "kk"), (j: any) => j.onRef("kk.repo", "=", "o.repo").onRef("kk.number", "=", "o.number"))
    .select((eb: any) => ["o.repo as repo", "o.number as number", "o.id as wid", eb.lit(0).as("rank")]).where("o.state", "in", LIVE_STATES);
  const viaIssue = k.selectFrom(linkRows(db, LIVE_STATES, { prs: refs }).as("l")).select((eb: any) => ["l.repo as repo", "l.pr as number", "l.wid as wid", eb.lit(1).as("rank")]);
  const rows = await q.all(k.selectFrom(own.unionAll(viaIssue).as("h")).innerJoin("main.item_workflows as w", "w.id", "h.wid")
    .selectAll("w").select(["h.number as pr", "h.rank as rank"])
    .$if(!!o.others, (b: any) => b.whereRef("w.number", "<>", "h.number")).orderBy("h.rank", "desc").orderBy("w.id")) as (WorkflowRow & { pr: number | string; rank: number })[];
  // The best match of a PR comes last and is the one kept.
  for (const { pr, rank: _rank, ...row } of rows) out.set(refKey(row.repo, Number(pr)), workflowOf(row as WorkflowRow));
  return out;
}

/** The held items: the newest workflow of an open item, when it is held. Of the given repos or items; the latest hold first. */
export async function loadHeldWorkflows(db: Db, f: { repos: string[] } | { refs: { repo: string; number: number }[] }): Promise<(ItemWorkflow & { title: string | null })[]> {
  if (("repos" in f ? f.repos : f.refs).length === 0) return [];
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.item_workflows as w").innerJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "w.repo").onRef("i.number", "=", "w.number"))
    .selectAll("w").select("i.title as title").where("w.state", "=", "stopped").where("i.state", "=", "OPEN")
    .$if("repos" in f, (b: any) => b.where(kx.inList(db, "w.repo", (f as { repos: string[] }).repos)))
    .$if("refs" in f, (b: any) => b.where(kx.refIn(db, "w", pairs((f as { refs: { repo: string; number: number }[] }).refs))))
    .where((eb: any) => eb.not(eb.exists(eb.selectFrom("main.item_workflows as nw").select(eb.lit(1).as("one")).whereRef("nw.repo", "=", "w.repo").whereRef("nw.number", "=", "w.number").whereRef("nw.id", ">", "w.id"))))
    .orderBy("w.stopped_at", "desc").orderBy("w.id", "desc")) as (WorkflowRow & { title: string | null })[];
  return rows.map(({ title, ...r }) => ({ ...workflowOf(r as WorkflowRow), title }));
}

/** Every workflow of each item, oldest first. */
export async function loadWorkflowHistory(db: Db, refs: { repo: string; number: number }[]): Promise<Map<RefKey, ItemWorkflow[]>> {
  const out = new Map<RefKey, ItemWorkflow[]>();
  if (refs.length === 0) return out;
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.item_workflows as w").selectAll("w").where(kx.refIn(db, "w", pairs(refs))).orderBy("w.id")) as WorkflowRow[];
  for (const r of rows) {
    const key = refKey(r.repo, Number(r.number));
    (out.get(key) ?? out.set(key, []).get(key)!).push(workflowOf(r));
  }
  return out;
}

type EventRow = { id: number; workflow_id: number | null; repo: string; number: number; login: string; via: string; kind: string; parsed: string | null; line: string | null; at: string };

type EventFilter = { lastPerRef?: number; kinds?: WorkflowEventKind[] };
/**
 * Events in the order written; `lastPerRef` keeps the newest n of each item. `archived` adds the history of the decision system before the
 * maintainer workflow, whose rows are written later than their `at`.
 */
export async function loadEvents(db: Db, refs: { repo: string; number: number }[], o: EventFilter & { archived: true }): Promise<Map<RefKey, StoredEvent[]>>;
export async function loadEvents(db: Db, refs: { repo: string; number: number }[], o?: EventFilter): Promise<Map<RefKey, SaidEvent[]>>;
export async function loadEvents(db: Db, refs: { repo: string; number: number }[], o: EventFilter & { archived?: true } = {}): Promise<Map<RefKey, StoredEvent[]>> {
  const out = new Map<RefKey, StoredEvent[]>();
  if (refs.length === 0 || o.kinds?.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const base = k.selectFrom("main.workflow_events as e")
    .select(["e.id", "e.workflow_id", "e.repo", "e.number", "e.login", "e.via", "e.kind", "e.parsed", "e.line", "e.at"])
    .where(kx.refIn(db, "e", pairs(refs)))
    .$if(!o.archived, (b: any) => b.where((eb: any) => notArchived(eb, "e.kind")))
    .$if(!!o.kinds, (b: any) => b.where(kx.inList(db, "e.kind", o.kinds!)));
  const query = o.lastPerRef === undefined
    ? base.orderBy("e.id")
    : k.selectFrom(base.select((e: any) => e.fn.agg("row_number").over((o: any) => o.partitionBy(["e.repo", "e.number"]).orderBy("e.id", "desc")).as("rn")).as("x")).selectAll("x").where("x.rn", "<=", o.lastPerRef).orderBy("x.id");
  for (const r of await q.all(query) as EventRow[]) {
    const key = refKey(r.repo, Number(r.number));
    (out.get(key) ?? out.set(key, []).get(key)!).push({
      id: Number(r.id), workflowId: r.workflow_id === null ? null : Number(r.workflow_id), repo: r.repo, number: Number(r.number), login: r.login, via: r.via as Surface,
      kind: r.kind as WorkflowEventKind, parsed: parse<Parsed | null>(r.parsed, null), line: r.line, at: r.at,
    });
  }
  return out;
}

/** Latest event kind per item. */
export async function loadLastEventKinds(db: Db, keys: KeySource): Promise<Map<RefKey, WorkflowEventKind>> {
  const out = new Map<RefKey, WorkflowEventKind>();
  if (isEmpty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const newest = k.selectFrom("main.workflow_events as m").innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "m.repo").onRef("kk.number", "=", "m.number"))
    .select((eb: any) => eb.fn.max("m.id").as("id")).where((eb: any) => notArchived(eb, "m.kind")).groupBy(["m.repo", "m.number"]);
  for (const r of await q.all(k.selectFrom("main.workflow_events as e").select(["e.repo", "e.number", "e.kind"]).where("e.id", "in", newest)) as { repo: string; number: number; kind: string }[]) {
    out.set(refKey(r.repo, Number(r.number)), r.kind as WorkflowEventKind);
  }
  return out;
}

/** Latest `answered` event per workflow. */
export async function loadAnswers(db: Db, workflowIds: number[], o: { resumes?: true } = {}): Promise<Map<number, { login: string; at: string }>> {
  const out = new Map<number, { login: string; at: string }>();
  if (workflowIds.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const newest = k.selectFrom("main.workflow_events as m").select((eb: any) => eb.fn.max("m.id").as("id")).where("m.kind", "in", o.resumes ? SAID_EVENTS : ["answered"])
    .where(kx.inList(db, "m.workflow_id", workflowIds, "bigint")).groupBy("m.workflow_id");
  for (const r of await q.all(k.selectFrom("main.workflow_events as e").select(["e.workflow_id", "e.login", "e.at"]).where("e.id", "in", newest)) as { workflow_id: number; login: string; at: string }[]) {
    out.set(Number(r.workflow_id), { login: r.login, at: r.at });
  }
  return out;
}

/** Each workflow's newest event that a person sent (a model's reading of a message left out): who, from where, on which item and when. */
export async function loadLatestSaid(db: Db, workflowIds: number[]): Promise<Map<number, { login: string; via: string; number: number; at: string }>> {
  const out = new Map<number, { login: string; via: string; number: number; at: string }>();
  if (workflowIds.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const newest = k.selectFrom("main.workflow_events as m").select((eb: any) => eb.fn.max("m.id").as("id")).where("m.kind", "<>", "read")
    .where(kx.inList(db, "m.workflow_id", workflowIds, "bigint")).groupBy("m.workflow_id");
  for (const r of await q.all(k.selectFrom("main.workflow_events as e").select(["e.workflow_id", "e.login", "e.via", "e.number", "e.at"]).where("e.id", "in", newest)) as { workflow_id: number; login: string; via: string; number: number; at: string }[]) {
    out.set(Number(r.workflow_id), { login: r.login, via: r.via, number: Number(r.number), at: r.at });
  }
  return out;
}

/** Up to when a person has seen each workflow's item and chose to go on with it, and when they last said so (its start without an event); when someone last resumed it. */
export async function loadGoOnAt(db: Db, workflows: { id: number; startedAt: string }[]): Promise<Map<number, GoneOn>> {
  const out = new Map<number, GoneOn>();
  if (workflows.length === 0) return out;
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.workflow_events as e").select(["e.workflow_id"]).select((eb: any) => {
      const of = (is: Expression<SqlBool>, col: unknown) => eb.fn.max(eb.case().when(is).then(col).end());
      return [of(isGoOn(eb, "e"), seenAt(eb, "e")).as("seen"), of(isGoOn(eb, "e"), eb.ref("e.at")).as("said"), of(eb("e.kind", "=", "resumed"), eb.ref("e.at")).as("resumed")];
    })
    .where((eb: any) => eb.or([isGoOn(eb, "e"), eb("e.kind", "=", "resumed")])).where(kx.inList(db, "e.workflow_id", workflows.map((w) => w.id), "bigint")).groupBy("e.workflow_id")) as { workflow_id: number; seen: string | null; said: string | null; resumed: string | null }[];
  const latest = new Map(rows.map((r) => [Number(r.workflow_id), r]));
  for (const w of workflows) {
    const r = latest.get(w.id);
    const from = (at: string | null | undefined): string => (at != null && at > w.startedAt ? at : w.startedAt);
    out.set(w.id, { since: from(r?.seen), said: from(r?.said), resumed: r?.resumed ?? null });
  }
  return out;
}

/** Command rate limit count: events of `login` on `via` after `since`; a model reading (`read`) comes with the event of its command and is not counted. */
export async function countEventsSince(db: Db, c: { login: string; via: Surface; since: string }): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.workflow_events").select((eb) => eb.fn.countAll<number>().as("n")).where("login", "=", c.login).where("via", "=", c.via).where("at", ">", c.since)
    .where((eb) => notArchived(eb, "kind")).where("kind", "<>", kx.literal("read")));
  return Number(r?.n ?? 0);
}

/** The id of the newest workflow event, 0 when there is none. */
export async function loadLastEventId(db: Db): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.workflow_events").select((eb) => eb.fn.max("id").as("m")));
  return Number(r?.m ?? 0);
}

/** The id of the newest event `login` wrote on the item through `via` with an id above `after`, or null. */
export async function loadNewestEventBy(db: Db, f: { repo: string; number: number; login: string; via: string; after: number }): Promise<number | null> {
  const q = queryDb(db);
  const e = await q.get(q.k.selectFrom("main.workflow_events").select("id").where("repo", "=", f.repo).where("number", "=", f.number)
    .where("login", "=", f.login).where("via", "=", f.via as never).where("id", ">", f.after).orderBy("id", "desc").limit(1));
  return e ? Number(e.id) : null;
}

/** Items a login started, approved or answered on after `since` whose number is one of `numbers`, newest first, each once. */
export async function loadLoginItems(db: Db, f: { login: string; numbers: number[]; since: string }): Promise<{ repo: string; number: number; at: string }[]> {
  if (!f.numbers.length) return [];
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workflow_events").select(["repo", "number", "at"]).where("login", "=", f.login).where("at", ">", f.since)
    .where(kx.inList(db, "kind", ["started", "approved", "answered"])).where(kx.inList(db, "number", f.numbers, "bigint")).orderBy("at", "desc"), { label: "workflow.loadLoginItems" });
  const seen = new Set<string>();
  return rows.map((r) => ({ repo: r.repo, number: Number(r.number), at: r.at })).filter((r) => !seen.has(`${r.repo}#${r.number}`) && !!seen.add(`${r.repo}#${r.number}`));
}

/**
 * Inserts workflows in the `running` state, one statement per 500 rows, `ON CONFLICT DO NOTHING` against the unique index of live workflows: a
 * ref missing from the result already has a live workflow. A row with `approvedBy` is approved at its `at`; a PR's base head is the head its
 * starter accepted. An implement workflow takes over the PR of an attempt that has not ended (linkWorkflows). Joins the caller's `db.write`.
 */
export async function startWorkflows(db: Db, rows: NewWorkflow[]): Promise<Map<RefKey, number>> {
  const out = new Map<RefKey, number>();
  if (rows.length === 0) return out;
  const q = queryDb(db);
  const now = new Date().toISOString();
  await db.write(async () => {
    for (const batch of kx.batches(rows)) {
      const got = await q.all((q.k as any).insertInto("main.item_workflows").values(batch.map((w) => {
        const at = w.at ?? now;
        return {
          repo: w.repo, number: w.number, kind: w.kind, entry: w.entry, weight: w.weight, state: "running", started_by: w.startedBy, started_at: at, started_via: w.startedVia,
          base_head: w.baseHead ?? null, accepted_head: w.kind === "pr" ? w.baseHead ?? null : null, approved_by: w.approvedBy ?? null, approved_at: w.approvedBy ? at : null, approved_via: w.approvedBy ? w.approvedVia ?? null : null,
          plan: JSON.stringify(w.plan ?? []), step: w.step ?? null, updated_at: at,
        };
      })).onConflict((oc: any) => oc.doNothing()).returning(["id", "repo", "number"])) as { id: number; repo: string; number: number }[];
      for (const r of got) out.set(refKey(r.repo, Number(r.number)), Number(r.id));
    }
    const ids = rows.filter((w) => w.entry === "implement").flatMap((w) => out.get(refKey(w.repo, w.number)) ?? []);
    await linkWorkflows(db, { ids });
    await retitleConversations(db, rows.filter((w) => out.has(refKey(w.repo, w.number))));
  });
  return out;
}

type Cell = string | number | null;
const PATCH_COLUMNS: { [K in keyof WorkflowPatch]-?: (v: never) => [string, Cell] } = {
  entry: (v) => ["entry", v], weight: (v) => ["weight", v], state: (v) => ["state", v], baseHead: (v) => ["base_head", v], acceptedHead: (v) => ["accepted_head", v],
  approvedBy: (v) => ["approved_by", v], approvedAt: (v) => ["approved_at", v], approvedVia: (v) => ["approved_via", v],
  stoppedBy: (v) => ["stopped_by", v], stoppedAt: (v) => ["stopped_at", v], takenBy: (v) => ["taken_by", v], blocker: (v) => ["blocker", v],
  blockerParams: (v) => ["blocker_params", v ? JSON.stringify(v) : null], rec: (v) => ["rec", v ? JSON.stringify(v) : null], recAt: (v) => ["rec_at", v],
  recHead: (v) => ["rec_head", v], plan: (v) => ["plan", JSON.stringify(v ?? [])], step: (v) => ["step", v], reviewAskedAt: (v) => ["review_asked_at", v], legacyPreapprovalId: (v) => ["legacy_preapproval_id", v],
};

/** The rows to write per distinct column set; patches of the same id merge in order. Every row sets `updated_at` (the live topic `workflows`). */
function patchGroups(rows: { id: number; patch: WorkflowPatch; at?: string }[]): Record<string, Cell>[][] {
  const now = new Date().toISOString();
  const byId = new Map<number, Record<string, Cell>>();
  for (const r of rows) {
    const set = byId.get(r.id) ?? { id: r.id, updated_at: r.at ?? now };
    if (r.at) set.updated_at = r.at;
    for (const [key, value] of Object.entries(r.patch)) {
      if (value === undefined) continue;
      const [col, v] = PATCH_COLUMNS[key as keyof WorkflowPatch](value as never);
      set[col] = v;
    }
    byId.set(r.id, set);
  }
  const groups = new Map<string, Record<string, Cell>[]>();
  for (const set of byId.values()) {
    const shape = Object.keys(set).sort().join(",");
    (groups.get(shape) ?? groups.set(shape, []).get(shape)!).push(set);
  }
  return [...groups.values()];
}

/** The columns of a patch that are not text. */
const BIGINT: readonly string[] = ["id", "weight", "legacy_preapproval_id"];

/**
 * Batched update, one statement per distinct patch column set; each row's `version` goes up by one. A row that comes back with a new
 * recommendation, or ends done or closed, gets AutoCraft's message in its item's chat in the same write (src/data/chat/workflow.ts).
 * Returns the rows changed.
 */
export async function saveWorkflows(db: Db, rows: { id: number; patch: WorkflowPatch; at?: string }[]): Promise<number> {
  if (rows.length === 0) return 0;
  return await db.write(async () => {
    const talking = rows.filter((r) => patchTalks(r.patch)).map((r) => r.id);
    const before = talking.length ? await loadChatBefore(db, talking) : null;
    let changed = 0;
    for (const group of patchGroups(rows)) {
      const set = Object.fromEntries(Object.keys(group[0]!).filter((c) => c !== "id").map((c) => [c, BIGINT.includes(c) ? "bigint" as const : "text" as const]));
      changed += await patchRows(db, "main.item_workflows", { id: "bigint" }, set, group, { also: (eb) => ({ version: eb("main.item_workflows.version", "+", 1) }) });
    }
    if (before) await recordWorkflowMessages(db, before);
    return changed;
  });
}

/** The row is as it was read. A release before `version` writes the row without raising it, so the state and the time of its last write count too. */
export const sameWorkflow = (now: WorkflowRead, was: WorkflowRead): boolean => now.version === was.version && now.state === was.state && now.updatedAt === was.updatedAt;

/**
 * `saveWorkflows` for rows read before this write: one that changed since (`was`: how it was read) is left as it is. One patch per id. Returns
 * the ids written. Joins the caller's `db.write`.
 */
export async function moveWorkflows(db: Db, rows: { id: number; patch: WorkflowPatch; at: string; was: WorkflowRead }[]): Promise<Set<number>> {
  if (rows.length === 0) return new Set();
  const q = queryDb(db);
  return await db.write(async () => {
    const now = new Map((await q.all((q.k as any).selectFrom("main.item_workflows as w").select(["w.id", "w.state", "w.updated_at", "w.version"]).where(kx.inList(db, "w.id", rows.map((r) => r.id), "bigint"))) as
      { id: number | string; state: WorkflowState; updated_at: string; version: number | string }[]).map((r) => [Number(r.id), { state: r.state, updatedAt: r.updated_at, version: Number(r.version) }]));
    const same = rows.filter((r) => { const n = now.get(r.id); return n !== undefined && sameWorkflow(n, r.was); });
    await saveWorkflows(db, same);
    return new Set(same.map((r) => r.id));
  });
}

/** Deletes the rows: the hold of an item nobody started, once it is over. Returns the rows deleted. */
export async function dropWorkflows(db: Db, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const q = queryDb(db);
  return (await q.run((q.k as any).deleteFrom("main.item_workflows").where(kx.inList(db, "id", ids, "bigint")))).changes;
}

/** Batched insert, 500 rows a statement. */
export async function recordEvents(db: Db, rows: WorkflowEvent[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const now = new Date().toISOString();
  await db.write(async () => {
    for (const batch of kx.batches(rows)) {
      await q.run((q.k as any).insertInto("main.workflow_events").values(batch.map((e) => ({
        workflow_id: e.workflowId, repo: e.repo, number: e.number, login: e.login, via: e.via ?? "cli", kind: e.kind,
        parsed: e.parsed ? JSON.stringify(e.parsed) : null, line: e.line ?? null, at: e.at ?? now, seen_at: e.seenAt ?? null,
      }))));
    }
  });
}

/**
 * The work score (src/core/work-score.ts) for every item of `keys` with a live workflow and for the PR a live implement workflow works on
 * (the maximum when both apply). One statement.
 */
export async function loadWorkScores(db: Db, keys: KeySource): Promise<Map<RefKey, number>> {
  const out = new Map<RefKey, number>();
  if (isEmpty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const own = k.selectFrom("main.item_workflows as w").innerJoin(resolveKeys(db, keys, "ks"), (j: any) => j.onRef("ks.repo", "=", "w.repo").onRef("ks.number", "=", "w.number"))
    .select((eb: any) => ["w.repo as repo", "w.number as number", workScore(eb).as("s")]).where("w.state", "in", LIVE_STATES);
  const viaPr = k.selectFrom(linkRows(db, LIVE_STATES, { prs: keys }).as("l")).innerJoin("main.item_workflows as w", "w.id", "l.wid").select((eb: any) => ["l.repo as repo", "l.pr as number", workScore(eb).as("s")]);
  for (const r of await q.all(own.unionAll(viaPr)) as { repo: string; number: number; s: number | string }[]) {
    const key = refKey(r.repo, Number(r.number)), s = Number(r.s), old = out.get(key);
    if (old === undefined || s > old) out.set(key, s);
  }
  return out;
}

/** The weight behind each item's work score (loadWorkScores): its live workflow's, or that of the issue its PR implements. One statement. */
export async function loadWorkWeights(db: Db, keys: KeySource): Promise<Map<RefKey, number>> {
  return new Map([...await loadWorkScores(db, keys)].map(([key, s]) => [key, weightOfScore(s)]));
}

/** Open items with a live workflow ordered by weight then id, with `row_number()` and `count(*) OVER ()` over the whole queue; `repos` narrows the result, not the positions. */
export async function loadQueuePositions(db: Db, f: { repos?: string[] } = {}): Promise<Map<RefKey, QueuePosition>> {
  const out = new Map<RefKey, QueuePosition>();
  if (f.repos?.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const all = k.selectFrom("main.item_workflows as w")
    .select((e: any) => ["w.repo", "w.number", "w.weight", "w.started_by", e.fn.agg("row_number").over((o: any) => o.orderBy("w.weight", "desc").orderBy("w.id")).as("pos"), e.fn.countAll().over().as("total")])
    .where("w.state", "in", LIVE_STATES).where((eb: any) => openItem(eb, "w.repo", "w.number"));
  const rows = await q.all(k.selectFrom(all.as("x")).selectAll("x").$if(!!f.repos, (b: any) => b.where(kx.inList(db, "x.repo", f.repos!))).orderBy("x.pos")) as
    { repo: string; number: number; weight: number; started_by: string; pos: number; total: number }[];
  for (const r of rows) out.set(refKey(r.repo, Number(r.number)), { position: Number(r.pos), of: Number(r.total), weight: Number(r.weight), startedBy: r.started_by });
  return out;
}

/** Items a person started or approved (case-insensitive login), with the PRs implement workflows of those work on; narrowed by workflow state, refs, repos and open state. */
export async function loadStartedRefs(db: Db, f: StartedFilter = {}): Promise<Set<RefKey>> {
  const out = new Set<RefKey>();
  if (f.refs?.length === 0 || f.repos?.length === 0 || f.states?.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const who = (b: any) => f.login === undefined ? b : b.where((eb: any) => eb.or([loginIn(db, eb, "w.started_by", [f.login!], "ls"), loginIn(db, eb, "w.approved_by", [f.login!], "la")]));
  const states = f.states ?? LIVE_STATES;
  const own = who(k.selectFrom("main.item_workflows as w").select(["w.repo as repo", "w.number as number"]).where("w.state", "in", states));
  const viaPr = who(k.selectFrom(linkRows(db, states).as("l")).innerJoin("main.item_workflows as w", "w.id", "l.wid").select(["l.repo as repo", "l.pr as number"]));
  const rows = await q.all(k.selectFrom(own.union(viaPr).as("s")).select(["s.repo", "s.number"])
    .$if(!!f.refs, (b: any) => b.where(kx.refIn(db, "s", pairs(f.refs!))))
    .$if(!!f.repos, (b: any) => b.where(kx.inList(db, "s.repo", f.repos!)))
    .$if(!!f.openOnly, (b: any) => b.where((eb: any) => openItem(eb, "s.repo", "s.number")))) as { repo: string; number: number }[];
  for (const r of rows) out.add(refKey(r.repo, Number(r.number)));
  return out;
}

/**
 * The Task Runner snapshot's input: live workflows, the PRs live implement workflows work on, and the merged PRs of workflows that ended
 * done through that merge within MERGED_WORK_MS of `now` (endedByMerge); the live rows carry the Task Runners taken onto their
 * workflow (item-runners.ts). Four result sets in one wave.
 */
export async function loadStartedWork(db: Db, now: number = Date.now()): Promise<StartedWork> {
  const q = queryDb(db);
  const k = q.k as any;
  const since = new Date(now - MERGED_WORK_MS).toISOString();
  const [live, prs, merged, taken] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.item_workflows as w").select(["w.id", "w.repo", "w.number", "w.entry", "w.state", "w.started_by", "w.approved_by"]).where("w.state", "in", LIVE_STATES).orderBy("w.id")),
    q.all(k.selectFrom(linkRows(db, LIVE_STATES).as("l")).innerJoin("main.item_workflows as w", "w.id", "l.wid").select(["w.id as id", "l.repo as repo", "l.pr as pr", "w.started_by as started_by", "w.approved_by as approved_by"]).orderBy("w.id")),
    q.all(MERGE_WAYS.map((via) => k.selectFrom("main.item_workflows as w").innerJoin("main.items as m", (j: any) => j.onRef("m.repo", "=", "w.repo").onRef("m.number", "=", via === "pr" ? "w.number" : "w.pr_number"))
      .select(["m.repo as repo", "m.number as pr", "w.started_by as started_by", "w.approved_by as approved_by", "w.id as id"]).where("w.state", "=", "done").where("w.updated_at", ">=", since)
      .where((eb: any) => endedByMerge(eb, "w", "m.repo", "m.number", since, via))).reduce((a: any, b: any) => a.unionAll(b)).orderBy("id")),
    q.all(k.selectFrom("main.item_runners as g").innerJoin("main.item_workflows as w", "w.id", "g.workflow_id").select(["g.workflow_id", "g.login"])
      .where("g.released_at", "is", null).where("w.state", "in", LIVE_STATES).orderBy("g.id")),
  ])) as [{ id: number; repo: string; number: number; entry: Entry; state: WorkflowState; started_by: string; approved_by: string | null }[], { id: number; repo: string; pr: number; started_by: string; approved_by: string | null }[], { repo: string; pr: number; started_by: string; approved_by: string | null }[], { workflow_id: number; login: string }[]];
  // The Task Runners taken onto each workflow (item-runners.ts), which its rows carry.
  const takers = new Map<number, string[]>();
  for (const g of taken) (takers.get(Number(g.workflow_id)) ?? takers.set(Number(g.workflow_id), []).get(Number(g.workflow_id))!).push(g.login);
  const takenBy = (id: number): { takenBy?: string[] } => (takers.has(Number(id)) ? { takenBy: takers.get(Number(id))! } : {});
  return {
    live: live.map((r) => ({ repo: r.repo, number: Number(r.number), entry: r.entry, state: r.state, startedBy: r.started_by, approvedBy: r.approved_by, ...takenBy(r.id) })),
    prs: prs.map((r) => ({ repo: r.repo, pr: Number(r.pr), startedBy: r.started_by, approvedBy: r.approved_by, ...takenBy(r.id) })),
    merged: merged.map((r) => ({ repo: r.repo, pr: Number(r.pr), startedBy: r.started_by, approvedBy: r.approved_by })),
  };
}

/** Distinct logins the pipeline acts for with their repo: active leg owners, queued fix-up requesters, `approved_by` or `started_by` of live workflows, and who answered or resumed a live workflow; one `UNION`. */
export async function loadActingPairs(db: Db): Promise<{ login: string; repo: string }[]> {
  const q = queryDb(db);
  const k = q.k as any;
  const legs = k.selectFrom("main.preapprovals as p").select(["p.by as login", "p.repo as repo"]).where("p.state", "in", ACTIVE_LEGS);
  const requests = k.selectFrom("main.operator_fixups as o").select(["o.by as login", "o.repo as repo"]).where("o.state", "=", "queued");
  const approvers = k.selectFrom("main.item_workflows as w").select(["w.approved_by as login", "w.repo as repo"]).where("w.state", "in", LIVE_STATES).where("w.approved_by", "is not", null);
  const starters = k.selectFrom("main.item_workflows as w").select(["w.started_by as login", "w.repo as repo"]).where("w.state", "in", LIVE_STATES);
  const answerers = k.selectFrom("main.item_workflows as w").innerJoin("main.workflow_events as e", "e.workflow_id", "w.id").select(["e.login as login", "w.repo as repo"])
    .where("w.state", "in", LIVE_STATES).where("e.kind", "in", SAID_EVENTS);
  return await q.all(k.selectFrom(legs.union(requests).union(approvers).union(starters).union(answerers).as("a")).select(["a.login", "a.repo"]).orderBy("a.repo").orderBy("a.login")) as { login: string; repo: string }[];
}

/**
 * How each workflow's path ended after the approval made at `approvedAt`: `stopped` when the approval was withdrawn or replaced (another or no
 * `approved_at`) or the workflow went to the backlog, or was held and other work on its item took its place, `closed`, `merged` for a finished
 * workflow (`done`), null while the approval stands: on a live workflow, or on a held one, which a resume goes on with. A workflow row that is gone
 * reads `stopped`.
 */
export async function loadPathEnds(db: Db, rows: { workflowId: number; approvedAt: string }[]): Promise<Map<number, "merged" | "closed" | "stopped" | null>> {
  const out = new Map<number, "merged" | "closed" | "stopped" | null>();
  if (rows.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const newer = (eb: any) => eb.exists(k.selectFrom("main.item_workflows as n").select(one(eb)).whereRef("n.repo", "=", "w.repo").whereRef("n.id", ">", "w.id")
    .where((x: any) => x.or([x("n.number", "=", x.ref("w.number")), x("n.number", "=", x.ref("w.pr_number"))])));
  const got = await q.all(k.selectFrom("main.item_workflows as w").select((eb: any) => ["w.id as id", "w.state as state", "w.approved_at as approved_at", eb.case().when(newer(eb)).then(1).else(0).end().as("replaced")])
    .where(kx.inList(db, "w.id", rows.map((r) => r.workflowId), "bigint"))) as { id: number; state: string; approved_at: string | null; replaced: unknown }[];
  const byId = new Map(got.map((r) => [Number(r.id), r]));
  for (const r of rows) {
    const w = byId.get(r.workflowId);
    if (!w || w.approved_at !== r.approvedAt) out.set(r.workflowId, "stopped");
    else out.set(r.workflowId, w.state === "done" ? "merged" : w.state === "closed" ? "closed" : w.state === "backlog" || (w.state === "stopped" && flag(w.replaced)) ? "stopped" : null);
  }
  return out;
}
