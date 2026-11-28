// Writers of patch rows (fixups, ci_fixes, conflict_merges). Each opens `db.write`, or joins an outer one, and records its own
// stage event and job note through the owners' batch writers in the same transaction.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addJobItems } from "../jobs/index.ts";
import { addStageEvents } from "../planner/index.ts";
import type { StageEventRow } from "../planner/types.ts";
import type { CifixRerunRow, FixupSource, PatchKind, SessionClear } from "./types.ts";

type Key = { repo: string; number: number };
type Table = "fixups" | "ci_fixes" | "conflict_merges";
const TABLE: Record<PatchKind, Table> = { fixup: "fixups", cifix: "ci_fixes", conflict: "conflict_merges" };
/** Stored `source` of a fix-up row: NULL means the review's own. */
const sourceCol = (s: FixupSource | undefined | null): string | null => (s === undefined || s === null || s === "review" ? null : s);
const json = (v: unknown): string => JSON.stringify(v);

/** `UPDATE table SET .. WHERE rowid = id`; returns the rows changed. */
async function updateById(db: Db, table: Table, id: number, set: Record<string, unknown>): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run((q.k as any).updateTable(table).set(set).where(kx.rowid(table), "=", id))).changes);
}

/** `UPDATE table SET .. WHERE rowid = (the newest row at `at` in one of `states`)`: one statement, so the row read is the row written. */
async function updateNewestOpen(db: Db, table: Table, at: Record<string, string | number | null>, states: readonly string[], set: Record<string, unknown>): Promise<number> {
  const q = queryDb(db);
  const k = q.k as any;
  let open = k.selectFrom(`${table} as o`).select(kx.rowid(table, "o").as("id"));
  for (const [col, v] of Object.entries(at)) open = v === null ? open.where(`o.${col}`, "is", null) : open.where(`o.${col}`, "=", v);
  open = open.where("o.state", "in", states).orderBy(kx.rowid(table, "o"), "desc").limit(1);
  return Number((await q.run(k.updateTable(table).set(set).where(kx.rowid(table), "=", open))).changes);
}

const insert = async (db: Db, table: Table, values: Record<string, unknown>): Promise<void> => {
  const q = queryDb(db);
  await q.run((q.k as any).insertInto(table).values(values));
};

/**
 * Marks a patch as pushing, before the push, so a crash between the push and its record leaves the commit in the push chain.
 * A stored patch's row (`storedId`) is updated; a CI fix updates the newest open row at its head (formatting, pushing or linting)
 * and inserts when none changed; a fix-up or conflict merge without a stored row inserts a row of its own, so an earlier
 * `pushing` row left by a crash keeps its commit in the chain. A conflict merge clears the stored resolution; the others keep the
 * patch (the pushed fix-up's patch is read for its size).
 */
export async function recordPushing(db: Db, p: { kind: PatchKind; repo: string; number: number; head: string; commit: string; files: string[]; attempt: number; source?: FixupSource; operatorFix?: number | null; storedId?: number; ciKind?: string; baseSha?: string | null; at?: string }): Promise<void> {
  const files = json(p.files);
  const at = p.at ?? new Date().toISOString();
  await db.write(async () => {
    if (p.kind === "fixup") {
      if (p.storedId !== undefined) { await updateById(db, "fixups", p.storedId, { state: "pushing", to_head: p.commit, files }); return; }
      await insert(db, "fixups", { repo: p.repo, number: p.number, from_head: p.head, to_head: p.commit, state: "pushing", reason: null, files, attempt: p.attempt, created_at: at, source: sourceCol(p.source), operator_fix: p.operatorFix ?? null });
    } else if (p.kind === "cifix") {
      const set = { state: "pushing", to_head: p.commit, files };
      const changed = p.storedId !== undefined ? await updateById(db, "ci_fixes", p.storedId, set)
        : await updateNewestOpen(db, "ci_fixes", { repo: p.repo, number: p.number, head: p.head }, ["formatting", "pushing", "linting"], set);
      if (changed === 0) await insert(db, "ci_fixes", { repo: p.repo, number: p.number, head: p.head, to_head: p.commit, kind: p.ciKind ?? "code", state: "pushing", reason: null, files, attempt: p.attempt, created_at: at });
    } else {
      if (p.storedId !== undefined) { await updateById(db, "conflict_merges", p.storedId, { state: "pushing", to_head: p.commit, patch: null }); return; }
      await insert(db, "conflict_merges", { repo: p.repo, number: p.number, from_head: p.head, to_head: p.commit, base_sha: p.baseSha ?? null, state: "pushing", reason: null, files, attempt: p.attempt, created_at: at });
    }
  });
}

/**
 * Stores the model's patch in a `linting` row: the stored row with the next round's patch and task (update by `storedId`), or a
 * first row. A CI fix without a lint task is a patch kept for posting again (`lintTask` null).
 */
export async function storePatch(db: Db, p: { kind: PatchKind; storedId?: number; repo: string; number: number; head: string; patch: string; files: string[]; lintTask: number | null; lintRound: number; lintState: string; session: string | null; /** The fix session turn that wrote the patch. */ sessionTurn?: number | null; changes?: string[]; source?: FixupSource; operatorFix?: number | null; baseSha?: string; attempt: number; at?: string }): Promise<void> {
  const files = json(p.files);
  const at = p.at ?? new Date().toISOString();
  await db.write(async () => {
    if (p.kind === "fixup") {
      const changes = p.changes?.length ? json(p.changes) : null;
      if (p.storedId !== undefined) { await updateById(db, "fixups", p.storedId, { patch: p.patch, files, lint_task: p.lintTask, lint_round: p.lintRound, lint_state: p.lintState, session: p.session, session_turn: p.sessionTurn ?? null, changes }); return; }
      await insert(db, "fixups", { repo: p.repo, number: p.number, from_head: p.head, to_head: null, state: "linting", reason: null, files, attempt: p.attempt, created_at: at, source: sourceCol(p.source), patch: p.patch,
        lint_task: p.lintTask, lint_round: p.lintRound, lint_state: p.lintState, session: p.session, session_turn: p.sessionTurn ?? null, operator_fix: p.operatorFix ?? null, changes });
    } else if (p.kind === "cifix") {
      if (p.storedId !== undefined) { await updateById(db, "ci_fixes", p.storedId, { patch: p.patch, files, lint_task: p.lintTask, lint_round: p.lintRound, lint_state: p.lintState, session: p.session, session_turn: p.sessionTurn ?? null }); return; }
      await insert(db, "ci_fixes", { repo: p.repo, number: p.number, head: p.head, to_head: null, kind: "code", state: "linting", reason: null, files, attempt: p.attempt, created_at: at, patch: p.patch,
        lint_task: p.lintTask, lint_round: p.lintRound, lint_state: p.lintState, session: p.session, session_turn: p.sessionTurn ?? null });
    } else {
      if (p.storedId !== undefined) { await updateById(db, "conflict_merges", p.storedId, { patch: p.patch, files, lint_task: p.lintTask, lint_round: p.lintRound, session: p.session, session_turn: p.sessionTurn ?? null }); return; }
      await insert(db, "conflict_merges", { repo: p.repo, number: p.number, from_head: p.head, to_head: null, base_sha: p.baseSha ?? null, state: "linting", reason: null, files, attempt: p.attempt, created_at: at,
        patch: p.patch, lint_task: p.lintTask, lint_round: p.lintRound, session: p.session, session_turn: p.sessionTurn ?? null });
    }
  });
}

/**
 * Records a patch outcome: the row, its stage event and the job note in one transaction. The row is the stored one (`storedId`) or
 * the newest open row of its key (a fix-up: pushing or linting at the head, same source and operator request; a conflict merge:
 * pushing or linting at the head; a CI fix: formatting, pushing or linting at the head), else a new row. A CI fix in state
 * `comment-unsent` or `formatting` always inserts: the open row stays for the retry, and the unsent row times the backoff.
 * A conflict merge also clears its stored resolution. `jobNote` is written as a `job_items` row of `jobId` when both are set;
 * a failed job-note write never fails the outcome.
 */
export async function finishPatch(db: Db, o: Key & { kind: PatchKind; head: string; state: string; reason: string | null; files: string[]; toHead?: string | null; storedId?: number; task?: number | null; runs?: number[] | null; attempt?: number; source?: FixupSource; operatorFix?: number | null; ciKind?: string; baseSha?: string | null; at?: string; note: StageEventRow | null; jobNote: string | null; jobId?: number | null }): Promise<void> {
  const files = json(o.files);
  const at = o.at ?? o.note?.at ?? new Date().toISOString();
  const toHead = o.toHead ?? null;
  const attempt = o.attempt ?? 1;
  await db.write(async () => {
    if (o.kind === "fixup") {
      const set = { state: o.state, reason: o.reason, files, to_head: toHead };
      const source = o.source === undefined || o.source === "review" ? "review" : o.source;
      const changed = o.storedId !== undefined ? await updateById(db, "fixups", o.storedId, set) : await updateOpenFixup(db, o, source, set);
      if (changed === 0) await insert(db, "fixups", { repo: o.repo, number: o.number, from_head: o.head, to_head: toHead, state: o.state, reason: o.reason, files, attempt, created_at: at, source: sourceCol(o.source), operator_fix: o.operatorFix ?? null });
    } else if (o.kind === "cifix") {
      const insertOnly = o.state === "comment-unsent" || o.state === "formatting";
      const set = { state: o.state, reason: o.reason, files, to_head: toHead };
      const changed = insertOnly ? 0 : o.storedId !== undefined ? await updateById(db, "ci_fixes", o.storedId, set)
        : await updateNewestOpen(db, "ci_fixes", { repo: o.repo, number: o.number, head: o.head }, ["formatting", "pushing", "linting"], set);
      if (changed === 0) await insert(db, "ci_fixes", { repo: o.repo, number: o.number, head: o.head, to_head: toHead, kind: o.ciKind ?? "code", state: o.state, reason: o.reason, files, attempt, task_id: o.task ?? null, runs: o.runs ? json(o.runs) : null, created_at: at });
    } else {
      const set = { state: o.state, reason: o.reason, files, to_head: toHead, base_sha: o.baseSha ?? null, patch: null };
      const changed = o.storedId !== undefined ? await updateById(db, "conflict_merges", o.storedId, set)
        : await updateNewestOpen(db, "conflict_merges", { repo: o.repo, number: o.number, from_head: o.head }, ["pushing", "linting"], set);
      if (changed === 0) await insert(db, "conflict_merges", { repo: o.repo, number: o.number, from_head: o.head, to_head: toHead, base_sha: o.baseSha ?? null, state: o.state, reason: o.reason, files, attempt, created_at: at });
    }
    if (o.note) await addStageEvents(db, [o.note]);
    if (o.jobNote && o.jobId != null) {
      const job_id = o.jobId;
      const outcome = o.jobNote.replace(/\s+/g, " ").trim().slice(0, 300);
      // Bookkeeping: a failed insert must not fail the outcome, and `attempt` keeps the open transaction usable.
      try { await queryDb(db).attempt(() => addJobItems(db, [{ job_id, repo: o.repo, number: o.number, outcome, at }])); } catch { /* not recorded */ }
    }
  });
}

/** The newest open fix-up row at the head with the same source (NULL is the review's) and operator request. */
async function updateOpenFixup(db: Db, o: Key & { head: string; operatorFix?: number | null }, source: string, set: Record<string, unknown>): Promise<number> {
  const q = queryDb(db);
  const k = q.k as any;
  const open = k.selectFrom("fixups as o").select(kx.rowid("fixups", "o").as("id"))
    .where("o.repo", "=", o.repo).where("o.number", "=", o.number).where("o.from_head", "=", o.head).where("o.state", "in", ["pushing", "linting"])
    .where((eb: any) => eb(eb.fn.coalesce("o.source", eb.val("review")), "=", source))
    .where((eb: any) => (o.operatorFix == null ? eb("o.operator_fix", "is", null) : eb("o.operator_fix", "=", o.operatorFix)))
    .orderBy(kx.rowid("fixups", "o"), "desc").limit(1);
  return Number((await q.run(k.updateTable("fixups").set(set).where(kx.rowid("fixups"), "=", open))).changes);
}

/**
 * Sets rows to `superseded` with `reason` and clears their patch; only rows still `linting` change, so a row that moved on since
 * it was listed keeps its state. 1 statement per kind present. Returns the rows changed.
 */
export async function supersedePatches(db: Db, rows: { kind: PatchKind; id: number }[], reason: string): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    let n = 0;
    for (const kind of ["fixup", "cifix", "conflict"] as const) {
      const ids = rows.filter((r) => r.kind === kind).map((r) => r.id);
      for (const part of kx.chunks(ids)) {
        const table = TABLE[kind];
        n += Number((await q.run((q.k as any).updateTable(table).set({ state: "superseded", reason, patch: null }).where("state", "=", "linting").where(kx.inList(db, kx.rowid(table), part, "bigint")))).changes);
      }
    }
    return n;
  });
}

export type PushingSettle = { kind: "fixup" | "cifix"; id: number; state: "pushed" | "linting" | "superseded"; reason: string | null; note: StageEventRow | null };
/** Sets rows still `pushing` to what became of the push; back to `linting`, the stored patch has its push ahead again. Returns the rows changed. */
export async function settlePushingRows(db: Db, rows: readonly PushingSettle[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    let n = 0;
    for (const r of rows) {
      const set = r.state === "linting" ? { state: r.state, to_head: null } : { state: r.state, reason: r.reason };
      const changed = Number((await q.run((q.k as any).updateTable(TABLE[r.kind]).set(set).where(kx.rowid(TABLE[r.kind]), "=", r.id).where("state", "=", "pushing"))).changes);
      if (changed && r.note) await addStageEvents(db, [r.note]);
      n += changed;
    }
    return n;
  });
}

/** Records whether conflict merges kept the PR's own diff, and the delta the review reads: one statement per 10,000 rows, on the merged row at each `toHead`. */
export async function setOwnDiff(db: Db, rows: { repo: string; number: number; toHead: string; ownDiff: string; ownDelta: string | null }[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks(rows)) {
      const v = kx.valuesTable(db, part.map((r) => ({ repo: r.repo, number: r.number, to_head: r.toHead, own_diff: r.ownDiff, own_delta: r.ownDelta })),
        { repo: "text", number: "bigint", to_head: "text", own_diff: "text", own_delta: "text" }, "v");
      await q.run((q.k as any).updateTable("conflict_merges").from(v).set((eb: any) => ({ own_diff: eb.ref("v.own_diff"), own_delta: eb.ref("v.own_delta") }))
        .where((eb: any) => eb.and([eb("conflict_merges.repo", "=", eb.ref("v.repo")), eb("conflict_merges.number", "=", eb.ref("v.number")), eb("conflict_merges.to_head", "=", eb.ref("v.to_head")), eb("conflict_merges.state", "=", "merged")])));
    }
  });
}

/** Marks CI-fix heads as rerunning infrastructure checks: one `rerunning` row per head (attempt 0, not a try), written before the GitHub calls. */
export async function startInfraRerun(db: Db, rows: CifixRerunRow[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(rows)) await q.run((q.k as any).insertInto("ci_fixes").values(part.map((r) => ({ repo: r.repo, number: r.number, head: r.head, kind: "infra", state: "rerunning", reason: null, files: "[]", attempt: 0, runs: json(r.runs), created_at: r.at }))));
  });
}

/** Closes the `rerunning` rows of those heads with their final state and reason. */
export async function finishInfraRerun(db: Db, rows: (CifixRerunRow & { state: string; reason: string | null })[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks(rows)) {
      const v = kx.valuesTable(db, part.map((r) => ({ repo: r.repo, number: r.number, head: r.head, state: r.state, reason: r.reason })), { repo: "text", number: "bigint", head: "text", state: "text", reason: "text" }, "v");
      await q.run((q.k as any).updateTable("ci_fixes").from(v).set((eb: any) => ({ state: eb.ref("v.state"), reason: eb.ref("v.reason") }))
        .where((eb: any) => eb.and([eb("ci_fixes.repo", "=", eb.ref("v.repo")), eb("ci_fixes.number", "=", eb.ref("v.number")), eb("ci_fixes.head", "=", eb.ref("v.head")), eb("ci_fixes.state", "=", "rerunning")])));
    }
  });
}

/** Clears the stored session text of rows whose session directory was removed. 1 statement per table. Returns the rows changed. */
export async function clearSessions(db: Db, rows: SessionClear[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  const tables = { fixup: "fixups", cifix: "ci_fixes", conflict: "conflict_merges", main: "main_fixes" } as const;
  return await db.write(async () => {
    let n = 0;
    for (const kind of Object.keys(tables) as (keyof typeof tables)[]) {
      const ids = rows.filter((r) => r.kind === kind).map((r) => r.id);
      for (const part of kx.chunks(ids)) n += Number((await q.run((q.k as any).updateTable(tables[kind]).set({ session: null }).where(kx.inList(db, kx.rowid(tables[kind]), part, "bigint")))).changes);
    }
    return n;
  });
}
