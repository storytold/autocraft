// Loaders of attempts and rounds.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { openItem } from "../mirror/fragments.ts";
import { ownRetryOf, startRetryOf } from "../../implement/start-retry.ts";
import { ENDED, IMPL_COLS, num, ofRow, parse, roundOf, type ImplRow, type RoundRow } from "./rows.ts";
import {
  LIVE_STATES,
  type AnswerRound, type AttemptLite, type ImplementFacts, type ImplementStamp, type ImplementationState, type ImplementationView, type IssueAttempt,
  type PlanReply, type PrAttempt, type QuestionAudience, type QuestionRound, type RefKey, type ReviseRound, type SessionReport, type StuckStreakRow,
} from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const empty = (keys: KeySource): boolean => Array.isArray(keys) && keys.length === 0;
const LITE_COLS = IMPL_COLS.filter((c) => c !== "plan_json" && c !== "plan_md" && c !== "report_json");

const liteOf = (r: ImplRow): AttemptLite => {
  const { plan: _p, planMd: _m, report: _r, ...lite } = ofRow(r);
  return lite;
};

type AttemptRow = ImplRow & { rn: number | string; a: number | string; b: number | string; counts: string | null };

/** Order: attempts that ended come after the current one. */
const endedLast = (eb: any, state: string) => eb.case().when(state, "in", ENDED.map((s) => kx.literal(s))).then(eb.lit(1)).else(eb.lit(0)).end();

/**
 * The latest attempt per issue and per PR, question and answer state, revise heads and per-text attempt counts. Keys may be
 * issue refs or PR refs; the loader matches either. 3 statements in one `together` wave.
 * The rounds (questions, answers, guidance, revisions) are read for attempts not ended only; an ended attempt carries none.
 * `textCounts` is filled only for issues with a failed or stuck attempt, or with several.
 */
export async function loadImplementFacts(db: Db, keys: KeySource, o: { repos?: string[]; withPlans?: boolean } = {}): Promise<ImplementFacts> {
  const out: ImplementFacts = { byIssue: new Map(), byPr: new Map(), liveByRepo: new Map() };
  if (empty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const keyed = (eb: any, col: string) => eb.exists(eb.selectFrom(resolveKeys(db, keys, "kk")).select(eb.lit(1).as("one")).whereRef("kk.repo", "=", "im.repo").whereRef("kk.number", "=", `im.${col}`));
  const byNumber = (eb: any) => keyed(eb, "number");
  const byPrNumber = (eb: any) => eb.and([eb("im.pr_number", "is not", null), keyed(eb, "pr_number")]);
  const wide = o.withPlans ? ["im.plan_json", "im.plan_md", "im.report_json"] : [];
  const [attempts, rounds, live] = await db.together(() => Promise.all([
    q.all(k.selectFrom(k.selectFrom("main.implementations as im").select((eb: any) => [
      ...LITE_COLS.map((c) => `im.${c}`), ...wide,
      eb.fn.agg("row_number").over((o: any) => o.partitionBy(["im.repo", "im.number"]).orderBy(endedLast(eb, "im.state")).orderBy("im.attempt", "desc").orderBy("im.id", "desc")).as("rn"),
      eb.case().when(byNumber(eb)).then(eb.lit(1)).else(eb.lit(0)).end().as("a"),
      eb.case().when(byPrNumber(eb)).then(eb.lit(1)).else(eb.lit(0)).end().as("b"),
    ]).where((eb: any) => eb.or([byNumber(eb), byPrNumber(eb)])).as("t"))
      .select((eb: any) => [
        ...LITE_COLS.map((c) => `t.${c}`), ...(o.withPlans ? ["t.plan_json", "t.plan_md", "t.report_json"] : []), "t.rn", "t.a", "t.b",
        eb.case().when(eb.and([eb("t.rn", "=", eb.lit(1)), eb("t.a", "=", eb.lit(1)), eb.exists(eb.selectFrom("main.implementations as y").select(eb.lit(1).as("one"))
          .whereRef("y.repo", "=", "t.repo").whereRef("y.number", "=", "t.number").where((y: any) => y.or([y("y.state", "in", ["failed", "stuck"]), y("y.id", "<>", y.ref("t.id"))])))]))
          .then(kx.jsonRows(db, eb.selectFrom("main.implementations as x").select(["x.text_hash as h", eb.fn.countAll().as("n")]).whereRef("x.repo", "=", "t.repo").whereRef("x.number", "=", "t.number").groupBy("x.text_hash")))
          .else(eb.lit(null)).end().as("counts"),
      ])
      .where((eb: any) => eb.or([eb.and([eb("t.a", "=", eb.lit(1)), eb.or([eb("t.rn", "=", eb.lit(1)), eb("t.pr_number", "is not", null)])]), eb("t.b", "=", eb.lit(1))]))
      .orderBy("t.id")) as Promise<AttemptRow[]>,
    q.all(k.selectFrom("main.implementation_rounds as r").innerJoin("main.implementations as im", "im.id", "r.implementation_id")
      .select(["r.id", "r.implementation_id", "r.kind", "r.call_id", "r.result", "r.at"])
      .where("r.kind", "in", ["question", "answer", "guidance", "revise", "start-failed", "retry"]).where("im.state", "not in", ENDED)
      .where((eb: any) => eb.or([byNumber(eb), byPrNumber(eb)])).orderBy("r.id")) as Promise<RoundRow[]>,
    q.all(k.selectFrom("main.implementations as im").select(["im.repo", "im.number"]).where("im.state", "in", [...LIVE_STATES])
      .where((eb: any) => openItem(eb, "im.repo", "im.number")).$if(!!o.repos, (s: any) => s.where(kx.inList(db, "im.repo", o.repos!)))) as Promise<{ repo: string; number: number | string }[]>,
  ]));

  const roundsOf = new Map<number, ReturnType<typeof roundOf>[]>();
  for (const r of rounds) { const x = roundOf(r); (roundsOf.get(x.implementationId) ?? roundsOf.set(x.implementationId, []).get(x.implementationId)!).push(x); }
  const plannedOf = (r: AttemptRow): IssueAttempt["planned"] | undefined =>
    o.withPlans ? { plan: parse<PlanReply>(r.plan_json), planMd: r.plan_md, report: parse<SessionReport>(r.report_json) } : undefined;
  const revisedOf = (id: number): string[] => (roundsOf.get(id) ?? []).filter((x) => x.kind === "revise").flatMap((x) => { const h = (x.result as { head?: unknown } | null)?.head; return typeof h === "string" ? [h] : []; });

  const prAttempts = new Map<RefKey, IssueAttempt["prAttempts"]>();
  for (const r of attempts) {
    if (Number(r.a) === 1 && r.pr_number !== null) {
      const key = refKey(r.repo, Number(r.number));
      const planned = plannedOf(r);
      (prAttempts.get(key) ?? prAttempts.set(key, []).get(key)!).push({ id: Number(r.id), prNumber: Number(r.pr_number), state: r.state as ImplementationState, createdAt: r.created_at, diffStat: r.diff_stat, ...(planned && { plan: planned.plan }) });
    }
    if (Number(r.b) === 1) {
      // Rows are in id order: the newest attempt that opened a PR is the one kept.
      const planned = plannedOf(r);
      out.byPr.set(refKey(r.repo, Number(r.pr_number)), { issue: Number(r.number), attemptId: Number(r.id), state: r.state as ImplementationState, revisedHeads: revisedOf(Number(r.id)), ownRetry: ownRetryOf(roundsOf.get(Number(r.id)) ?? []), ...(planned && { planned }) } satisfies PrAttempt);
    }
  }
  for (const r of attempts) {
    if (Number(r.a) !== 1 || Number(r.rn) !== 1) continue;
    const id = Number(r.id);
    const rs = roundsOf.get(id) ?? [];
    const questions = rs.filter((x) => x.kind === "question");
    const q1 = questions.at(-1);
    const qr = (q1?.result ?? null) as Partial<QuestionRound & { cause: string }> | null;
    const audience: QuestionAudience | null = qr?.audience === "author" || qr?.audience === "maintainer" ? qr.audience : null;
    const answer = rs.filter((x) => x.kind === "answer" && x.id > (q1?.id ?? 0)).at(-1);
    const revises = rs.filter((x) => x.kind === "revise");
    const planned = plannedOf(r);
    const counts: Record<string, number> = {};
    for (const c of kx.parseJsonRows<{ h: string; n: number | string }>(r.counts)) counts[c.h] = Number(c.n);
    out.byIssue.set(refKey(r.repo, Number(r.number)), {
      attempt: liteOf(r),
      ...(planned && { planned }),
      question: (r.state === "asked" || r.state === "stuck") && q1 ? { round: q1.id, at: q1.at, audience, text: qr?.text ?? "", limit: qr?.limit === true, cause: qr?.cause ?? null, options: qr?.options ?? [], recommended: qr?.recommended ?? null } : null,
      answer: answer && answer.result && typeof answer.result === "object" ? (answer.result as AnswerRound) : null,
      guidance: rs.filter((x) => x.kind === "guidance").flatMap((x) => {
        const g = x.result as { text?: unknown; by?: unknown } | null;
        return typeof g?.text === "string" && g.text.trim() ? [{ by: typeof g.by === "string" ? g.by : null, at: x.at, text: g.text.trim() }] : [];
      }),
      reviseHeads: revises.flatMap((x) => { const v = x.result as Partial<ReviseRound> | null; return typeof v?.head === "string" && (v.review || v.ci) ? [v.head] : []; }),
      lastRevise: (revises.at(-1)?.result ?? null) as ReviseRound | null,
      startRetry: startRetryOf({ state: r.state as ImplementationState, rounds: rs }),
      ownRetry: ownRetryOf(rs),
      textCounts: counts,
      prAttempts: (prAttempts.get(refKey(r.repo, Number(r.number))) ?? []).sort((x, y) => y.id - x.id),
    });
  }
  for (const r of live) {
    const set = out.liveByRepo.get(r.repo) ?? out.liveByRepo.set(r.repo, new Set()).get(r.repo)!;
    set.add(refKey(r.repo, Number(r.number)));
  }
  return out;
}

/** All attempts of the issue and the rounds of the latest one, for the item page and CLI. 2 statements in one wave. */
export async function loadImplementationView(db: Db, ref: RefKey): Promise<ImplementationView | null> {
  const i = ref.lastIndexOf("#");
  const repo = ref.slice(0, i), number = Number(ref.slice(i + 1));
  const q = queryDb(db);
  const k = q.k as any;
  const [all, rounds] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.implementations").select([...IMPL_COLS]).where("repo", "=", repo).where("number", "=", number).orderBy("attempt", "desc").orderBy("id", "desc")) as Promise<ImplRow[]>,
    q.all(k.selectFrom("main.implementation_rounds").select(["id", "implementation_id", "kind", "call_id", "result", "at"]).where("implementation_id", "in", (eb: any) =>
      eb.selectFrom("main.implementations as l").select("l.id").where("l.repo", "=", repo).where("l.number", "=", number)
        .orderBy((e: any) => endedLast(e, "l.state")).orderBy("l.attempt", "desc").orderBy("l.id", "desc").limit(1)).orderBy("id")) as Promise<RoundRow[]>,
  ]));
  if (all.length === 0) return null;
  const impls = all.map(ofRow);
  const impl = impls.find((r) => !ENDED.includes(r.state)) ?? impls[0]!;
  return { impl, attempts: impls.length, rounds: rounds.map(roundOf) };
}

/** The newest `plan` round's reply text with that `call_id`. */
export async function loadPlanReplyOfCall(db: Db, callId: number): Promise<string | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.implementation_rounds").select("result").where("kind", "=", "plan").where("call_id", "=", callId).orderBy("id", "desc").limit(1));
  return r?.result ?? null;
}

/** Fingerprints of attempts and rounds per item for the item page's "did anything change" probe. 2 statements in one wave. */
export async function loadImplementStamps(db: Db, keys: KeySource): Promise<Map<RefKey, ImplementStamp>> {
  const out = new Map<RefKey, ImplementStamp>();
  if (empty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const on = (j: any) => j.onRef("kk.repo", "=", "im.repo").onRef("kk.number", "=", "im.number");
  const [attempts, rounds] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.implementations as im").innerJoin(resolveKeys(db, keys, "kk"), on).select(["im.repo", "im.number", "im.id", "im.state", "im.updated_at"]).orderBy("im.id")) as Promise<{ repo: string; number: number | string; id: number | string; state: ImplementationState; updated_at: string }[]>,
    q.all(k.selectFrom("main.implementation_rounds as r").innerJoin("main.implementations as im", "im.id", "r.implementation_id").innerJoin(resolveKeys(db, keys, "kk"), on)
      .select((eb: any) => ["im.repo", "im.number", eb.fn.countAll().as("n"), eb.fn.max("r.id").as("newest"), eb.fn.sum(eb.fn("length", ["r.result"])).as("length")]).groupBy(["im.repo", "im.number"])) as Promise<{ repo: string; number: number | string; n: number | string; newest: number | string | null; length: number | string | null }[]>,
  ]));
  const stamp = (key: RefKey): ImplementStamp => out.get(key) ?? out.set(key, { attempts: [], rounds: { n: 0, newest: null, length: 0 } }).get(key)!;
  for (const r of attempts) stamp(refKey(r.repo, Number(r.number))).attempts.push({ id: Number(r.id), state: r.state, updatedAt: r.updated_at });
  for (const r of rounds) stamp(refKey(r.repo, Number(r.number))).rounds = { n: Number(r.n), newest: r.newest === null ? null : String(r.newest), length: Number(r.length ?? 0) };
  return out;
}

/** The repo of each implementation id, for the visibility check of a screenshot. */
export async function loadImplementationRepos(db: Db, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.implementations").select(["id", "repo"]).where(kx.inList(db, "id", ids, "bigint")));
  return new Map(rows.map((r) => [Number(r.id), r.repo]));
}

/**
 * The newest `n` finished attempts per repo after the repo's `since` that ended in a PR or in `stuck`/`failed`, newest first. An
 * attempt whose newest question round is a stuck blocker with a cause in `skip` is left out. 1 statement.
 */
export async function loadStuckStreaks(db: Db, sinceByRepo: Map<string, string>, n: number, skip: readonly string[] = []): Promise<Map<string, StuckStreakRow[]>> {
  const out = new Map<string, StuckStreakRow[]>();
  if (sinceByRepo.size === 0 || n <= 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const v = kx.valuesTable(db, [...sinceByRepo].map(([repo, since]) => ({ repo, since })), { repo: "text", since: "text" }, "w");
  const rows = await q.all(k.selectFrom(k.selectFrom("main.implementations as im").innerJoin(v, (j: any) => j.onRef("w.repo", "=", "im.repo"))
    .select((eb: any) => ["im.repo as repo", "im.number as number", "im.attempt as attempt", "im.state as state", "im.pr_number as pr_number",
      eb.fn.agg("row_number").over((o: any) => o.partitionBy("im.repo").orderBy("im.updated_at", "desc").orderBy("im.id", "desc")).as("rn")])
    .where((eb: any) => eb("im.updated_at", ">", eb.ref("w.since")))
    .where((eb: any) => eb.or([eb("im.pr_number", "is not", null), eb("im.state", "in", ["stuck", "failed"])]))
    .$if(skip.length > 0, (s: any) => s.where((eb: any) => eb.not(eb.exists(eb.selectFrom("main.implementation_rounds as qr").select(eb.lit(1).as("one"))
      .whereRef("qr.implementation_id", "=", "im.id").where("qr.kind", "=", "question")
      .where(kx.inList(db, kx.jsonText(db, "qr.result", "$.cause"), skip))
      .where((x: any) => x.not(x.exists(x.selectFrom("main.implementation_rounds as later").select(x.lit(1).as("one"))
        .whereRef("later.implementation_id", "=", "im.id").where("later.kind", "=", "question").whereRef("later.id", ">", "qr.id"))))))))
    .as("t"))
    .select(["t.repo", "t.number", "t.attempt", "t.state", "t.pr_number"]).where("t.rn", "<=", n).orderBy("t.repo").orderBy("t.rn")) as { repo: string; number: number | string; attempt: number | string; state: ImplementationState; pr_number: number | string | null }[];
  for (const r of rows) (out.get(r.repo) ?? out.set(r.repo, []).get(r.repo)!).push({ number: Number(r.number), attempt: Number(r.attempt), state: r.state, prNumber: num(r.pr_number) });
  return out;
}
