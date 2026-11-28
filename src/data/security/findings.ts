// Findings (package security).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
// reads: control.hiddenRepos (fragment, tracked_repos hidden list)
import { hiddenRepos } from "../control/fragments.ts";
import { jobsOfItems, liveJobOfFinding } from "../jobs/fragments.ts";
import { briefCols, nowIso, severityRank } from "./internal.ts";
import {
  ENV_WAIT_NOTE, INTERNAL_FINDING_STATES, TRANSITIONS, findingKey,
  type CallRow, type FindingAttention, type FixAdvanceRow, type FindingBoardRow, type FindingDetailData, type FindingKey, type FindingMove, type FindingRow, type FindingState, type HiddenRepos,
  type LandingWatch, type LinkRow, type LiveRound, type LogRound, type NewFinding, type NewScanFinding, type Ref, type ScanTestView, type StaleWork,
} from "./types.ts";

const INTERNAL: string[] = [...INTERNAL_FINDING_STATES];
const FIX_STEPS = ["security-fix"];
const CLAIM_STALE_MS = 600_000;

const filtered = (h: HiddenRepos | undefined): h is HiddenRepos => !!h && (!!h.visible || h.length > 0);
const pairs = (refs: readonly Ref[]): [string, number][] => refs.map((r) => { const i = r.lastIndexOf("#"); return [r.slice(0, i), Number(r.slice(i + 1))]; });

/** Full rows; `internal: true` includes `unverified`, `disproved` and `duplicate`. */
export async function loadFindings(db: Db, keys: FindingKey[], o?: { internal?: boolean }): Promise<Map<FindingKey, FindingRow>> {
  if (keys.length === 0) return new Map();
  const q = queryDb(db);
  const out = new Map<FindingKey, FindingRow>();
  for (const chunk of kx.chunks(keys)) {
    const rows = await q.all(q.k.selectFrom("security_findings as f").select(kx.cols("security_findings", "f")).where(kx.refIn(db, "f", chunk))
      .$if(!o?.internal, (b) => b.where("f.state", "not in", INTERNAL)));
    for (const r of rows) out.set(findingKey(r.repo, r.number), r);
  }
  return out;
}

/** Every listed finding of the repos with its building round and the rounds its last attempt ran. 1 statement. */
export async function loadFindingBoard(db: Db, f: { repos: string[] }): Promise<FindingBoardRow[]> {
  if (f.repos.length === 0) return [];
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("security_findings as f").select(briefCols("f"))
    .select((eb: any) => eb.selectFrom("security_fix_rounds as r").select(eb.fn.max("r.round").as("n")).whereRef("r.repo", "=", "f.repo").whereRef("r.number", "=", "f.number").where("r.state", "=", "building").as("building_round"))
    .select((eb: any) => eb.selectFrom("security_fix_log as l").select(eb.fn.countAll().as("n")).whereRef("l.repo", "=", "f.repo").whereRef("l.number", "=", "f.number").whereRef("l.attempt", "=", "f.fix_attempts").as("last_attempt_rounds"))
    .where(kx.inList(db, "f.repo", f.repos)).where("f.state", "not in", INTERNAL).orderBy("f.repo").orderBy((eb: any) => severityRank(eb, "f.severity")).orderBy("f.number"));
  return rows as FindingBoardRow[];
}

/** The lowest index of the area named like the finding's `area` in its scan. */
const areaIdx = (eb: kx.AnyEb) => { const s = kx.schemaEb(eb); return s.selectFrom("security_areas as fa").select((e) => e.fn.min("fa.idx").as("i")).where("fa.scan_id", "=", eb.ref("f.scan_id")).where("fa.name", "=", eb.ref("f.area")); };

/** The finding page's data in one wave: finding, calls, repeats, scan test, fix log, live rounds. 6 statements. */
export async function loadFindingDetail(db: Db, key: FindingKey): Promise<FindingDetailData | undefined> {
  const q = queryDb(db);
  const [[repo, number]] = pairs([key]);
  const [finding, calls, repeats, scanTest, log, rounds] = await db.together(() => Promise.all([
    q.get(q.k.selectFrom("security_findings").select(kx.cols("security_findings")).where("repo", "=", repo!).where("number", "=", number!).where("state", "not in", INTERNAL)),
    // The finding's scan: the threat model call, its area's call and its own verify, test, fix and review calls.
    q.all(q.k.selectFrom("security_findings as f").innerJoin("security_calls as c", "c.scan_id", "f.scan_id")
      .leftJoin("security_areas as ar", (j) => j.onRef("ar.scan_id", "=", "c.scan_id").onRef("ar.idx", "=", "c.area_idx"))
      .select(kx.cols("security_calls", "c")).select("ar.name as area_name").where("f.repo", "=", repo!).where("f.number", "=", number!).where("f.state", "not in", INTERNAL)
      .where((eb) => eb.or([
        eb("c.kind", "=", "model"),
        eb.and([eb("c.kind", "=", "area"), eb("c.area_idx", "=", eb.fn.coalesce(areaIdx(eb), eb.lit(-1)))]),
        eb.and([eb("c.kind", "in", ["verify", "test", "fix", "review"]), eb("c.finding_number", "=", number!)]),
      ])).orderBy("c.id")),
    q.all(q.k.selectFrom("security_findings").select(["repo", "number", "title", "state", "created_at"]).where("repo", "=", repo!).where("duplicate_of", "=", number!).orderBy("created_at")),
    q.get(q.k.selectFrom("security_scan_tests").select(["state", "detail", "test_path", "test_source"]).where("repo", "=", repo!).where("number", "=", number!)),
    q.all(q.k.selectFrom("security_fix_log").select(kx.cols("security_fix_log")).where("repo", "=", repo!).where("number", "=", number!).orderBy("attempt").orderBy("round")),
    q.all(q.k.selectFrom("security_fix_rounds").select(["round", "state", "failure", "created_at"]).where("repo", "=", repo!).where("number", "=", number!).orderBy("round")),
  ]));
  if (!finding) return undefined;
  return { finding, calls: calls as (CallRow & { area_name: string | null })[], repeats, scanTest: (scanTest ?? null) as ScanTestView | null, log: log as LogRound[], rounds: rounds as LiveRound[] };
}

/** Listed quiet-route findings whose `fix_pr` is the PR. */
export async function loadFixPrFindings(db: Db, prs: Ref[]): Promise<Map<Ref, { number: number; title: string; severity: string; state: string }[]>> {
  const out = new Map<Ref, { number: number; title: string; severity: string; state: string }[]>();
  if (prs.length === 0) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("security_findings").select(["repo", "number", "title", "severity", "state", "fix_pr"]).where(kx.tupleIn(db, ["repo", "fix_pr"], pairs(prs), ["text", "bigint"]))
    .where("fork", "is", null).where("state", "not in", INTERNAL).orderBy("repo").orderBy("number"));
  for (const r of rows) {
    const k: Ref = `${r.repo}#${r.fix_pr}`;
    const list = out.get(k) ?? [];
    list.push({ number: r.number, title: r.title, severity: r.severity, state: r.state });
    out.set(k, list);
  }
  return out;
}

/** Open high findings (count and the oldest `o.oldest`, default 5) and findings the fix gave up on. 3 statements, 1 round trip. */
export async function loadFindingAttention(db: Db, f: { hide?: HiddenRepos; oldest?: number }): Promise<FindingAttention> {
  const q = queryDb(db);
  const open = () => q.k.selectFrom("security_findings").where("state", "=", "new").where("severity", "in", ["high", "critical"])
    .$if(filtered(f.hide), (b) => b.where(hiddenRepos(db, "repo", f.hide!)));
  const [count, oldest, gaveUp] = await db.together(() => Promise.all([
    q.get(open().select((eb) => eb.fn.countAll<number>().as("n"))),
    q.all(open().select(["repo", "number", "title", "created_at"]).orderBy("created_at").orderBy("number").limit(f.oldest ?? 5)),
    q.all(q.k.selectFrom("security_findings").select(["repo", "number", "fix_attempts", "last_failure"]).$narrowType<{ last_failure: string }>().where("state", "=", "new").where("last_failure", "is not", null)
      .$if(filtered(f.hide), (b) => b.where(hiddenRepos(db, "repo", f.hide!))).orderBy("updated_at", "desc")),
  ]));
  return { openHighCount: count!.n, openHigh: oldest, gaveUp };
}

/** `fixing` findings with `env_wait_at`: count and the oldest. */
export async function countEnvWaits(db: Db): Promise<{ n: number; oldest: string | null }> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("security_findings").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<string | null>("env_wait_at").as("oldest")])
    .where("state", "=", "fixing").where("env_wait_at", "is not", null)))!;
}

/**
 * Automatic-fix candidates: state `new`, verification score at least `minScore`, no fix job that was not cancelled, and, with
 * `scanTests` on, no scan test in `building` or `not-shown`.
 */
export async function loadFindingsToFix(db: Db, f: { repo?: string; number?: number; scanTests: boolean; minScore: number }): Promise<FindingKey[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("security_findings as f").select(["f.repo", "f.number"]).where("f.state", "=", "new")
    .where((eb) => eb(kx.jsonNum(db, "f.verification", "$.score"), ">=", f.minScore))
    .$if(f.repo !== undefined, (b) => b.where("f.repo", "=", f.repo!)).$if(f.number !== undefined, (b) => b.where("f.number", "=", f.number!))
    .where((eb) => eb.not(jobsOfItems(db, eb, "f.repo", "f.number", { steps: FIX_STEPS, states: ["queued", "running", "done", "failed"] })))
    .$if(f.scanTests, (b) => b.where((eb) => eb.not(eb.exists(eb.selectFrom("security_scan_tests as t").select(eb.lit(1).as("one")).whereRef("t.repo", "=", "f.repo").whereRef("t.number", "=", "f.number").where("t.state", "in", ["building", "not-shown"])))))
    .orderBy("f.repo").orderBy("f.number"));
  return rows.map((r) => findingKey(r.repo, r.number));
}

/**
 * `fixing` findings with no queued or running fix job: those with a `building` round (task ids, the round's `created_at`) first, then
 * those waiting on a confidential environment, with the state of their security fix session's workspace. 1 statement.
 */
export async function loadFixesToAdvance(db: Db): Promise<FixAdvanceRow[]> {
  const q = queryDb(db);
  const noJob = (eb: kx.AnyEb) => eb.not(liveJobOfFinding(db, eb, FIX_STEPS, "f.repo", "f.number"));
  const building = q.k.selectFrom("security_findings as f").innerJoin("security_fix_rounds as r", (j) => j.onRef("r.repo", "=", "f.repo").onRef("r.number", "=", "f.number").on("r.state", "=", "building"))
    .select(["f.repo", "f.number", "f.decided_by as by", "r.created_at as round_at", "r.head_task as head", "r.base_task as base"])
    .select((eb) => [kx.literal(0).as("src"), eb.lit(null).as("env_at"), eb.lit(null).as("ws_state")])
    .where("f.state", "=", "fixing").where(noJob);
  const waiting = q.k.selectFrom("security_findings as f")
    .select(["f.repo", "f.number", "f.decided_by as by"])
    .select((eb) => [eb.lit(null).as("round_at"), eb.lit(null).as("head"), eb.lit(null).as("base"), kx.literal(1).as("src")])
    .select("f.env_wait_at as env_at")
    // The state of the workspace of the finding's live security fix session, if any.
    .select((eb) => eb.selectFrom("main.fix_sessions as fs").innerJoin("main.workspaces as w", "w.id", "fs.workspace_id").select("w.state")
      .where("fs.kind", "=", "security").whereRef("fs.repo", "=", "f.repo").whereRef("fs.number", "=", "f.number").where("fs.state", "=", "live").limit(1).as("ws_state"))
    .where("f.state", "=", "fixing").where("f.env_wait_at", "is not", null).where(noJob);
  const rows = (await q.all((building as any).unionAll(waiting as any).orderBy("src").orderBy("repo").orderBy("number"))) as {
    repo: string; number: number; by: string | null; round_at: string | null; head: number | null; base: number | null; env_at: string | null; ws_state: string | null;
  }[];
  return rows.map((r) => ({
    repo: r.repo, number: r.number, by: r.by, tasks: r.head === null ? null : { head: r.head, base: r.base! }, roundCreatedAt: r.round_at, envWaitAt: r.env_at, workspaceState: r.ws_state,
  }));
}

/** Narrow columns of all findings for `linkRepeatedFindings`, by repo and number. Runs alone: the set can pass 10,000 rows. */
export async function loadFindingsForLinking(db: Db): Promise<LinkRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("security_findings").select(["repo", "number", "state", "fingerprint", "title", "refs", "category"]).orderBy("repo").orderBy("number"), { alone: true, label: "security.loadFindingsForLinking" });
}

/** The findings the landing poll watches: quiet-route findings landing with a pull request, and findings waiting for an admin with a commit. 1 statement. */
export async function loadLandingWatch(db: Db): Promise<LandingWatch> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("security_findings").select(["repo", "number", "state", "fix_commit", "fork", "fix_pr"])
    .where((eb) => eb.or([
      eb.and([eb("state", "=", "landing"), eb("fix_pr", "is not", null), eb("fork", "is", null)]),
      eb.and([eb("state", "=", "awaiting-admin"), eb("fix_commit", "is not", null)]),
    ])).orderBy("repo").orderBy("number"), { label: "security.loadLandingWatch" });
  const out: LandingWatch = { quiet: [], waiting: [] };
  for (const { state, ...r } of rows) {
    if (state === "landing" && r.fix_pr !== null) out.quiet.push({ ...r, fix_pr: Number(r.fix_pr) });
    else if (state === "awaiting-admin" && r.fix_commit !== null) out.waiting.push({ ...r, fix_commit: r.fix_commit, fix_pr: r.fix_pr === null ? null : Number(r.fix_pr) });
  }
  return out;
}

/** Findings by scan, repo and state. */
export async function countFindings(db: Db, f: { scanId?: number; repo?: string; state?: FindingState }): Promise<number> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("security_findings").select((eb) => eb.fn.countAll<number>().as("n"))
    .$if(f.scanId !== undefined, (b) => b.where("scan_id", "=", f.scanId!)).$if(f.repo !== undefined, (b) => b.where("repo", "=", f.repo!)).$if(f.state !== undefined, (b) => b.where("state", "=", f.state!))))!.n;
}

export type { StaleWork };

// ---- writers ----------------------------------------------------------------------------------------------------

/** Multi-row insert with explicit numbers and `duplicate_of`; `created_at` and `updated_at` default to now. */
export async function addFindings(db: Db, repo: string, rows: NewFinding[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const at = nowIso();
  const values = rows.map((r) => ({ ...r, repo, created_at: r.created_at ?? at, updated_at: r.updated_at ?? at }));
  await db.write(async () => {
    for (const chunk of kx.batches(values)) await q.run(q.k.insertInto("security_findings").values(chunk));
  });
}

/** Stores a scan's findings under the repo's next numbers, taken in the same write, so scans of one repo never share one; returns the numbers in order. */
export async function addScanFindings(db: Db, repo: string, rows: NewScanFinding[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const top = await q.get(q.k.selectFrom("security_findings").select((eb) => eb.fn.max<number | null>("number").as("n")).where("repo", "=", repo));
    const first = Number(top?.n ?? 0) + 1;
    await addFindings(db, repo, rows.map(({ repeats, ...r }, i) => ({ ...r, repo, number: first + i, duplicate_of: repeats === undefined ? r.duplicate_of : first + repeats })));
    return rows.map((_, i) => first + i);
  });
}

const NUMERIC_PATCH = new Set(["fix_pr"]);

/**
 * Batched compare-and-set update, one statement per distinct shape of (from, to, patch keys, by, attempt handling): each
 * statement joins the moves' values as one JSON table and carries `state IN from` and `RETURNING`. Returns the keys that moved.
 * `bumpFixAttempts` increments `fix_attempts` and clears `last_failure` in the same statement; `restoreFixAttempts` sets it.
 */
export async function advanceFindings(db: Db, moves: FindingMove[]): Promise<Set<FindingKey>> {
  const moved = new Set<FindingKey>();
  if (moves.length === 0) return moved;
  const q = queryDb(db);
  const at = nowIso();
  const shapes = new Map<string, FindingMove[]>();
  for (const m of moves) {
    const p = m.set ?? {};
    const shape = JSON.stringify([[...m.from].sort(), m.to, Object.keys(p).filter((k) => k !== "bumpFixAttempts" && k !== "restoreFixAttempts").sort(), m.by !== undefined, !!p.bumpFixAttempts, p.restoreFixAttempts !== undefined]);
    shapes.set(shape, [...(shapes.get(shape) ?? []), m]);
  }
  await db.write(async () => {
    for (const group of shapes.values()) {
      const first = group[0]!;
      const keys = Object.keys(first.set ?? {}).filter((k) => k !== "bumpFixAttempts" && k !== "restoreFixAttempts").sort();
      const withBy = first.by !== undefined, bump = !!first.set?.bumpFixAttempts, restore = first.set?.restoreFixAttempts !== undefined;
      const cols: Record<string, "text" | "bigint"> = { repo: "text", number: "bigint" };
      for (const k of keys) cols[`p_${k}`] = NUMERIC_PATCH.has(k) ? "bigint" : "text";
      if (withBy) cols.p_by = "text";
      if (restore) cols.p_attempts = "bigint";
      for (const chunk of kx.chunks(group)) {
        const v = kx.valuesTable(db, chunk.map((m) => {
          const p = m.set ?? {};
          return { repo: m.repo, number: m.number, ...Object.fromEntries(keys.map((k) => [`p_${k}`, (p as Record<string, string | number | null>)[k] ?? null])), ...(withBy ? { p_by: m.by ?? null } : {}), ...(restore ? { p_attempts: p.restoreFixAttempts ?? null } : {}) };
        }), cols, "v");
        const hit = await q.all((q.k as any).updateTable("security_findings").from(v)
          .set((eb: any) => ({
            state: first.to, updated_at: at,
            ...Object.fromEntries(keys.map((k) => [k, eb.ref(`v.p_${k}`)])),
            ...(withBy ? { decided_by: eb.ref("v.p_by") } : {}),
            ...(bump ? { fix_attempts: eb("security_findings.fix_attempts", "+", 1), ...(keys.includes("last_failure") ? {} : { last_failure: null }) } : {}),
            ...(restore ? { fix_attempts: eb.ref("v.p_attempts") } : {}),
          }))
          .where((eb: any) => eb.and([eb("security_findings.repo", "=", eb.ref("v.repo")), eb("security_findings.number", "=", eb.ref("v.number")), kx.inList(db, "security_findings.state", first.from)]))
          .returning(["security_findings.repo", "security_findings.number"])) as { repo: string; number: number }[];
        for (const h of hit) moved.add(findingKey(h.repo, h.number));
      }
    }
  });
  return moved;
}

/** Single-key wrapper over `advanceFindings`, for per-effect sites only. */
export async function advanceFinding(db: Db, m: FindingMove): Promise<boolean> {
  return (await advanceFindings(db, [m])).size > 0;
}

/** Operator dismiss, backlog or reopen: one guarded statement per action. Returns the new state of each finding that moved. */
export async function moveFindings(db: Db, moves: { repo: string; number: number; action: "dismiss" | "backlog" | "reopen"; by: string; reason: string | null }[]): Promise<Map<FindingKey, FindingState>> {
  const out = new Map<FindingKey, FindingState>();
  if (moves.length === 0) return out;
  const q = queryDb(db);
  const at = nowIso();
  await db.write(async () => {
    for (const action of ["dismiss", "backlog", "reopen"] as const) {
      const rows = moves.filter((m) => m.action === action);
      if (rows.length === 0) continue;
      const t = TRANSITIONS[action];
      const v = kx.valuesTable(db, rows.map((m) => ({ repo: m.repo, number: m.number, by: m.by, reason: action === "dismiss" ? m.reason : null })), { repo: "text", number: "bigint", by: "text", reason: "text" }, "v");
      const hit = await q.all((q.k as any).updateTable("security_findings").from(v)
        .set((eb: any) => ({ state: t.to, reason: eb.ref("v.reason"), decided_by: eb.ref("v.by"), updated_at: at }))
        .where((eb: any) => eb.and([eb("security_findings.repo", "=", eb.ref("v.repo")), eb("security_findings.number", "=", eb.ref("v.number")), eb("security_findings.state", "in", t.from)]))
        .returning(["security_findings.repo", "security_findings.number"])) as { repo: string; number: number }[];
      for (const h of hit) out.set(findingKey(h.repo, h.number), t.to);
    }
  });
  return out;
}

/** Marks repeats (`state = 'duplicate'`, `duplicate_of`; guarded by `state = 'new'`); returns the keys marked. The caller audits in the same transaction. */
export async function markDuplicates(db: Db, rows: { repo: string; number: number; duplicateOf: number }[]): Promise<FindingKey[]> {
  if (rows.length === 0) return [];
  const q = queryDb(db);
  const at = nowIso();
  const out: FindingKey[] = [];
  await db.write(async () => {
    for (const chunk of kx.chunks(rows)) {
      const v = kx.valuesTable(db, chunk.map((r) => ({ repo: r.repo, number: r.number, of: r.duplicateOf })), { repo: "text", number: "bigint", of: "bigint" }, "v");
      const hit = await q.all((q.k as any).updateTable("security_findings").from(v)
        .set((eb: any) => ({ state: "duplicate", duplicate_of: eb.ref("v.of"), updated_at: at }))
        .where((eb: any) => eb.and([eb("security_findings.repo", "=", eb.ref("v.repo")), eb("security_findings.number", "=", eb.ref("v.number")), eb("security_findings.state", "=", "new")]))
        .returning(["security_findings.repo", "security_findings.number"])) as { repo: string; number: number }[];
      out.push(...hit.map((h) => findingKey(h.repo, h.number)));
    }
  });
  return out;
}

/** Sets notes of `landing` findings whose note differs. Returns how many changed. */
export async function setNotes(db: Db, rows: { repo: string; number: number; note: string }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const q = queryDb(db);
  const at = nowIso();
  let changed = 0;
  await db.write(async () => {
    for (const chunk of kx.chunks(rows)) {
      const v = kx.valuesTable(db, chunk, { repo: "text", number: "bigint", note: "text" }, "v");
      changed += (await q.run((q.k as any).updateTable("security_findings").from(v)
        .set((eb: any) => ({ note: eb.ref("v.note"), updated_at: at }))
        .where((eb: any) => eb.and([eb("security_findings.repo", "=", eb.ref("v.repo")), eb("security_findings.number", "=", eb.ref("v.number")), eb("security_findings.state", "=", "landing"),
          eb(eb.fn.coalesce("security_findings.note", eb.val("")), "<>", eb.ref("v.note"))])))).changes;
    }
  });
  return changed;
}

/** Compare-and-set claim of the advisory id slot (an empty id): free when unset, or when an earlier claim is over ten minutes old. Per effect, never inside a transaction. */
export async function claimAdvisoryId(db: Db, key: FindingKey): Promise<boolean> {
  const q = queryDb(db);
  const [[repo, number]] = pairs([key]);
  const stale = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  return (await q.run(q.k.updateTable("security_findings").set({ ghsa_id: "", updated_at: nowIso() }).where("repo", "=", repo!).where("number", "=", number!)
    .where((eb) => eb.or([eb("ghsa_id", "is", null), eb.and([eb("ghsa_id", "=", ""), eb("updated_at", "<", stale)])])))).changes > 0;
}

/** Stores the advisory id over the claim; null releases the claim (the draft failed). */
export async function setAdvisoryId(db: Db, key: FindingKey, ghsa: string | null): Promise<void> {
  const q = queryDb(db);
  const [[repo, number]] = pairs([key]);
  await q.run(q.k.updateTable("security_findings").set({ ghsa_id: ghsa }).where("repo", "=", repo!).where("number", "=", number!).where("ghsa_id", "=", ""));
}

/** Sets a finding's note; per effect. */
export async function setFindingNote(db: Db, key: FindingKey, note: string): Promise<void> {
  const q = queryDb(db);
  const [[repo, number]] = pairs([key]);
  await q.run(q.k.updateTable("security_findings").set({ note, updated_at: nowIso() }).where("repo", "=", repo!).where("number", "=", number!));
}

/**
 * Sets or clears `env_wait_at`. Setting needs state `fixing`, keeps an earlier value and puts the confidential-wait note on the
 * finding; clearing also clears that note (any other note stays).
 */
export async function setFindingEnvWait(db: Db, key: FindingKey, at: string | null): Promise<void> {
  const q = queryDb(db);
  const [[repo, number]] = pairs([key]);
  if (at !== null) {
    await q.run(q.k.updateTable("security_findings").set((eb) => ({ env_wait_at: eb.fn.coalesce("env_wait_at", eb.val(at)), note: ENV_WAIT_NOTE })).where("repo", "=", repo!).where("number", "=", number!).where("state", "=", "fixing"));
    return;
  }
  await q.run(q.k.updateTable("security_findings").set((eb) => ({ env_wait_at: null, note: eb.case().when("note", "=", ENV_WAIT_NOTE).then(null).else(eb.ref("note")).end() })).where("repo", "=", repo!).where("number", "=", number!));
}
