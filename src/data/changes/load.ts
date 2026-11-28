// Set loaders for the planner pass and the steps.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { patchLines } from "./pure.ts";
import {
  CONFLICT_EDGE_STATES, FIXUP_EDGE_STATES, cifixEdge, cifixRow, conflictEdge, conflictRow, fixupEdge, fixupRow, newestFirst, noKeys, num, onKey, PATCH_CHECK_COLS, patchCheckRow, push, refKey, rowsOf, splitRef, strings,
} from "./rows.ts";
import type { FixupSource, LintingRow, PatchCheckRow, PatchFacts, PatchKind, PushEdge, PushingRow, RefKey, StoredPatch } from "./types.ts";

const FIXUP_FACT_COLS = ["f.repo", "f.number", "f.from_head", "f.to_head", "f.state", "f.reason", "f.attempt", "f.created_at", "f.source", "f.lint_task", "f.lint_state", "f.operator_fix"] as const;
const CIFIX_FACT_COLS = ["c.repo", "c.number", "c.head", "c.to_head", "c.kind", "c.state", "c.reason", "c.files", "c.attempt", "c.task_id", "c.runs", "c.created_at", "c.lint_task"] as const;
const CONFLICT_FACT_COLS = ["c.repo", "c.number", "c.from_head", "c.to_head", "c.base_sha", "c.state", "c.reason", "c.attempt", "c.created_at", "c.lint_task", "c.own_diff"] as const;

const pushEdgesOf = (facts: Omit<PatchFacts, "pushes">): PushEdge[] => newestFirst([
  ...facts.fixups.filter((r) => r.toHead !== null && FIXUP_EDGE_STATES.includes(r.state)).map((r): PushEdge => ({ kind: "fixup", id: r.id, from: r.fromHead, to: r.toHead!, state: r.state as PushEdge["state"], source: r.source, reason: r.reason, at: r.createdAt })),
  ...facts.cifixes.filter((r) => r.toHead !== null && FIXUP_EDGE_STATES.includes(r.state)).map((r): PushEdge => ({ kind: "cifix", id: r.id, from: r.head, to: r.toHead!, state: r.state as PushEdge["state"], source: null, ciKind: r.kind, reason: r.reason, at: r.createdAt })),
  ...facts.conflicts.filter((r) => r.toHead !== null && CONFLICT_EDGE_STATES.includes(r.state)).map((r): PushEdge => ({ kind: "conflict", id: r.id, from: r.fromHead, to: r.toHead!, state: r.state as PushEdge["state"], source: null, ownDiff: r.ownDiff, reason: r.reason, at: r.createdAt })),
]);

/**
 * Patch rows of the three tables and the derived push edges for each PR of `keys`. 3 statements in one wave, no blobs (`patch`,
 * `own_diff` text apart from the `same`/`changed` flag, `own_delta`, `session` stay in the tables). Rows are oldest first by id.
 */
export async function loadPatchFacts(db: Db, keys: KeySource): Promise<Map<RefKey, PatchFacts>> {
  const out = new Map<RefKey, PatchFacts>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const [fixups, cifixes, conflicts] = await db.together(() => Promise.all([
    rowsOf<any>(db, k.selectFrom("main.fixups as f").innerJoin(resolveKeys(db, keys, "kk"), onKey("f")).select([...FIXUP_FACT_COLS, kx.rowid("main.fixups", "f").as("id")]).orderBy(kx.rowid("main.fixups", "f"))),
    rowsOf<any>(db, k.selectFrom("main.ci_fixes as c").innerJoin(resolveKeys(db, keys, "kk"), onKey("c")).select([...CIFIX_FACT_COLS, kx.rowid("main.ci_fixes", "c").as("id")]).orderBy(kx.rowid("main.ci_fixes", "c"))),
    rowsOf<any>(db, k.selectFrom("main.conflict_merges as c").innerJoin(resolveKeys(db, keys, "kk"), onKey("c")).select([...CONFLICT_FACT_COLS, kx.rowid("main.conflict_merges", "c").as("id")]).orderBy(kx.rowid("main.conflict_merges", "c"))),
  ]));
  const of = (ref: RefKey): Omit<PatchFacts, "pushes"> & { pushes: PushEdge[] } => {
    let f = out.get(ref);
    if (!f) out.set(ref, f = { fixups: [], cifixes: [], conflicts: [], pushes: [] });
    return f;
  };
  for (const r of fixups) of(refKey(r.repo, Number(r.number))).fixups.push(fixupRow(r));
  for (const r of cifixes) of(refKey(r.repo, Number(r.number))).cifixes.push(cifixRow(r));
  for (const r of conflicts) of(refKey(r.repo, Number(r.number))).conflicts.push(conflictRow(r));
  for (const f of out.values()) f.pushes = pushEdgesOf(f);
  return out;
}

/** Push edges (`to_head` set; fix-ups and CI fixes `pushing` or `pushed`, conflict merges `merged` or `pushing`) per PR. 3 statements in one wave. */
export async function loadPushEdges(db: Db, keys: KeySource): Promise<Map<RefKey, PushEdge[]>> {
  const out = new Map<RefKey, PushEdge[]>();
  if (noKeys(keys)) return out;
  const k = queryDb(db).k as any;
  const [fixups, cifixes, conflicts] = await db.together(() => Promise.all([
    rowsOf<any>(db, k.selectFrom("main.fixups as f").innerJoin(resolveKeys(db, keys, "kk"), onKey("f"))
      .select(["f.repo", "f.number", "f.from_head", "f.to_head", "f.state", "f.source", "f.reason", "f.created_at", kx.rowid("main.fixups", "f").as("id")])
      .where("f.to_head", "is not", null).where("f.state", "in", FIXUP_EDGE_STATES)),
    rowsOf<any>(db, k.selectFrom("main.ci_fixes as c").innerJoin(resolveKeys(db, keys, "kk"), onKey("c"))
      .select(["c.repo", "c.number", "c.head", "c.to_head", "c.kind", "c.state", "c.reason", "c.created_at", kx.rowid("main.ci_fixes", "c").as("id")])
      .where("c.to_head", "is not", null).where("c.state", "in", FIXUP_EDGE_STATES)),
    rowsOf<any>(db, k.selectFrom("main.conflict_merges as c").innerJoin(resolveKeys(db, keys, "kk"), onKey("c"))
      .select(["c.repo", "c.number", "c.from_head", "c.to_head", "c.state", "c.own_diff", "c.reason", "c.created_at", kx.rowid("main.conflict_merges", "c").as("id")])
      .where("c.to_head", "is not", null).where("c.state", "in", CONFLICT_EDGE_STATES)),
  ]));
  for (const r of fixups) push(out, refKey(r.repo, Number(r.number)), fixupEdge(r));
  for (const r of cifixes) push(out, refKey(r.repo, Number(r.number)), cifixEdge(r));
  for (const r of conflicts) push(out, refKey(r.repo, Number(r.number)), conflictEdge(r));
  for (const list of out.values()) newestFirst(list);
  return out;
}

/**
 * Rows in state `linting` that hold a patch, with the patch, for the step's lint actions: up to 3 statements in one wave, each
 * ordered by id (the selector takes every fix-up row and the newest CI fix row, as before).
 */
export async function loadStoredPatches(db: Db, keys: KeySource, kinds?: PatchKind[]): Promise<StoredPatch[]> {
  if (noKeys(keys)) return [];
  const want = (kind: PatchKind) => !kinds || kinds.includes(kind);
  const k = queryDb(db).k as any;
  const [fixups, cifixes, conflicts] = await db.together(() => Promise.all([
    want("fixup") ? rowsOf<any>(db, k.selectFrom("main.fixups as f").innerJoin(resolveKeys(db, keys, "kk"), onKey("f"))
      .select(["f.repo", "f.number", "f.from_head", "f.source", "f.attempt", "f.patch", "f.lint_task", "f.lint_round", "f.lint_state", "f.session", "f.session_turn", "f.operator_fix", "f.changes", kx.rowid("main.fixups", "f").as("id")])
      .where("f.state", "=", "linting").where("f.patch", "is not", null).orderBy(kx.rowid("main.fixups", "f"))) : [],
    want("cifix") ? rowsOf<any>(db, k.selectFrom("main.ci_fixes as c").innerJoin(resolveKeys(db, keys, "kk"), onKey("c"))
      .select(["c.repo", "c.number", "c.head", "c.attempt", "c.patch", "c.files", "c.lint_task", "c.lint_round", "c.lint_state", "c.session", "c.session_turn", kx.rowid("main.ci_fixes", "c").as("id")])
      .where("c.state", "=", "linting").where("c.patch", "is not", null).orderBy(kx.rowid("main.ci_fixes", "c"))) : [],
    want("conflict") ? rowsOf<any>(db, k.selectFrom("main.conflict_merges as c").innerJoin(resolveKeys(db, keys, "kk"), onKey("c"))
      .select(["c.repo", "c.number", "c.from_head", "c.attempt", "c.patch", "c.base_sha", "c.files", "c.lint_task", "c.lint_round", "c.session", kx.rowid("main.conflict_merges", "c").as("id")])
      .where("c.state", "=", "linting").where("c.patch", "is not", null).orderBy(kx.rowid("main.conflict_merges", "c"))) : [],
  ]));
  return [
    ...fixups.map((r): StoredPatch => ({
      kind: "fixup", id: Number(r.id), repo: r.repo, number: Number(r.number), head: r.from_head, source: (r.source ?? "review") as FixupSource, attempt: Number(r.attempt), patch: r.patch,
      lintTask: num(r.lint_task), lintRound: r.lint_round ?? 1, lintState: r.lint_state ?? "pending", session: r.session, sessionTurn: num(r.session_turn), operatorFix: num(r.operator_fix), changes: strings(r.changes),
    })),
    ...cifixes.map((r): StoredPatch => ({
      kind: "cifix", id: Number(r.id), repo: r.repo, number: Number(r.number), head: r.head, attempt: Number(r.attempt), patch: r.patch, files: strings(r.files),
      lintTask: num(r.lint_task), lintRound: r.lint_round ?? 1, lintState: r.lint_state ?? "pending", session: r.session, sessionTurn: num(r.session_turn),
    })),
    ...conflicts.map((r): StoredPatch => ({
      kind: "conflict", id: Number(r.id), repo: r.repo, number: Number(r.number), head: r.from_head, attempt: Number(r.attempt), patch: r.patch, baseSha: r.base_sha ?? "", files: strings(r.files),
      lintTask: num(r.lint_task), lintRound: r.lint_round ?? 1, session: r.session,
    })),
  ];
}

/**
 * Linting rows with the count of `comment-unsent` siblings at the same head (CI fixes only; the other kinds count 0), for
 * `dropUnlisted`. 3 statements in one wave; the sibling count is a grouped join, not a query per row.
 */
export async function loadLintingRows(db: Db, keys: KeySource): Promise<LintingRow[]> {
  if (noKeys(keys)) return [];
  const k = queryDb(db).k as any;
  const [fixups, cifixes, conflicts] = await db.together(() => Promise.all([
    rowsOf<any>(db, k.selectFrom("main.fixups as f").innerJoin(resolveKeys(db, keys, "kk"), onKey("f"))
      .select(["f.repo", "f.number", "f.from_head as head", "f.lint_task", kx.rowid("main.fixups", "f").as("id")]).where("f.state", "=", "linting").orderBy(kx.rowid("main.fixups", "f"))),
    rowsOf<any>(db, k.selectFrom("main.ci_fixes as c").innerJoin(resolveKeys(db, keys, "kk"), onKey("c"))
      .leftJoin(k.selectFrom("main.ci_fixes as u").select(["u.repo", "u.number", "u.head", (eb: any) => eb.fn.countAll().as("n")]).where("u.state", "=", "comment-unsent").groupBy(["u.repo", "u.number", "u.head"]).as("us"),
        (j: any) => j.onRef("us.repo", "=", "c.repo").onRef("us.number", "=", "c.number").onRef("us.head", "=", "c.head"))
      .select(["c.repo", "c.number", "c.head", "c.lint_task", "us.n as unsent", kx.rowid("main.ci_fixes", "c").as("id")]).where("c.state", "=", "linting").orderBy(kx.rowid("main.ci_fixes", "c"))),
    rowsOf<any>(db, k.selectFrom("main.conflict_merges as c").innerJoin(resolveKeys(db, keys, "kk"), onKey("c"))
      .select(["c.repo", "c.number", "c.from_head as head", "c.lint_task", kx.rowid("main.conflict_merges", "c").as("id")]).where("c.state", "=", "linting").orderBy(kx.rowid("main.conflict_merges", "c"))),
  ]));
  const row = (kind: PatchKind, r: any): LintingRow => ({ kind, id: Number(r.id), repo: r.repo, number: Number(r.number), head: r.head, lintTask: num(r.lint_task), unsentSibling: Number(r.unsent ?? 0) });
  return [...fixups.map((r) => row("fixup", r)), ...cifixes.map((r) => row("cifix", r)), ...conflicts.map((r) => row("conflict", r))];
}

/** The fix-ups and CI fixes in state `pushing`, whatever their head; `stored`: the row keeps a patch that passed through a lint task. 2 statements in one wave. */
export async function loadPushingRows(db: Db, keys: KeySource): Promise<PushingRow[]> {
  if (noKeys(keys)) return [];
  const k = queryDb(db).k as any;
  const of = (kind: PushingRow["kind"], t: "fixups" | "ci_fixes", head: string) => rowsOf<any>(db, k.selectFrom(`main.${t} as f`).innerJoin(resolveKeys(db, keys, "kk"), onKey("f"))
    .select(["f.repo", "f.number", `f.${head} as head`, "f.to_head", "f.files", "f.lint_task", kx.rowid(`main.${t}`, "f").as("id"), (eb: any) => eb.case().when("f.patch", "is not", null).then(1).else(0).end().as("has_patch")])
    .where("f.state", "=", "pushing").where("f.to_head", "is not", null).orderBy(kx.rowid(`main.${t}`, "f")))
    .then((rows) => rows.map((r): PushingRow => ({ kind, id: Number(r.id), repo: r.repo, number: Number(r.number), head: r.head, toHead: r.to_head, files: JSON.parse(r.files ?? "[]") as string[], stored: Number(r.has_patch) === 1 && r.lint_task !== null })));
  return (await db.together(() => Promise.all([of("fixup", "fixups", "from_head"), of("cifix", "ci_fixes", "head")]))).flat();
}

/** The newest operator fix-up row of each request id. 1 statement (`row_number()` over the request). */
export async function loadOperatorFixResults(db: Db, fixIds: number[]): Promise<Map<number, { state: string; fromHead: string; toHead: string | null; reason: string | null }>> {
  const out = new Map<number, { state: string; fromHead: string; toHead: string | null; reason: string | null }>();
  if (!fixIds.length) return out;
  const k = queryDb(db).k as any;
  for (const part of kx.chunks(fixIds)) {
    const rows = await rowsOf<any>(db, k.selectFrom((eb: any) => eb.selectFrom("main.fixups as f")
      .select(["f.operator_fix", "f.state", "f.from_head", "f.to_head", "f.reason",
        (e: any) => e.fn.agg("row_number").over((o: any) => o.partitionBy("f.operator_fix").orderBy(kx.rowid("main.fixups", "f"), "desc")).as("rn")])
      .where("f.source", "=", "operator").where(kx.inList(db, "f.operator_fix", part, "bigint")).as("t")).select(["t.operator_fix", "t.state", "t.from_head", "t.to_head", "t.reason"]).where("t.rn", "=", 1));
    for (const r of rows) out.set(Number(r.operator_fix), { state: r.state, fromHead: r.from_head, toHead: r.to_head, reason: r.reason });
  }
  return out;
}

/**
 * The newest pushed fix-up row with source review or operator per PR; `lines` is computed from the patch, which is read for the
 * winning row only and not returned. 1 statement.
 */
export async function loadLatestFixPushes(db: Db, keys: KeySource): Promise<Map<RefKey, { fromHead: string; toHead: string | null; createdAt: string; source: string | null; lines: number; files: string[] }>> {
  const out = new Map<RefKey, { fromHead: string; toHead: string | null; createdAt: string; source: string | null; lines: number; files: string[] }>();
  if (noKeys(keys)) return out;
  const k = queryDb(db).k as any;
  const rows = await rowsOf<any>(db, k.selectFrom((eb: any) => eb.selectFrom("main.fixups as f").innerJoin(resolveKeys(db, keys, "kk"), onKey("f"))
    .select(["f.repo", "f.number", "f.from_head", "f.to_head", "f.created_at", "f.source", "f.patch", "f.files",
      (e: any) => e.fn.agg("row_number").over((o: any) => o.partitionBy(["f.repo", "f.number"]).orderBy("f.created_at", "desc").orderBy(kx.rowid("main.fixups", "f"), "desc")).as("rn")])
    .where("f.state", "=", "pushed").where((w: any) => w(w.fn.coalesce("f.source", w.val("review")), "in", ["review", "operator"])).as("t"))
    .select(["t.repo", "t.number", "t.from_head", "t.to_head", "t.created_at", "t.source", "t.patch", "t.files"]).where("t.rn", "=", 1));
  for (const r of rows) out.set(refKey(r.repo, Number(r.number)), { fromHead: r.from_head, toHead: r.to_head ?? null, createdAt: r.created_at, source: r.source ?? null, lines: patchLines(r.patch), files: strings(r.files) });
  return out;
}

/** The newest non-superseded fix-up row at each (PR, head); key is `repo#number@head`. 1 statement per 10,000 pairs. */
export async function loadLatestFixupAt(db: Db, pairs: { ref: RefKey; head: string }[]): Promise<Map<string, { state: string; reason: string | null }>> {
  const out = new Map<string, { state: string; reason: string | null }>();
  if (!pairs.length) return out;
  const k = queryDb(db).k as any;
  for (const part of kx.chunks(pairs)) {
    const rows = await rowsOf<any>(db, k.selectFrom((eb: any) => eb.selectFrom("main.fixups as f")
      .select(["f.repo", "f.number", "f.from_head", "f.state", "f.reason",
        (e: any) => e.fn.agg("row_number").over((o: any) => o.partitionBy(["f.repo", "f.number", "f.from_head"]).orderBy("f.created_at", "desc").orderBy(kx.rowid("main.fixups", "f"), "desc")).as("rn")])
      .where(kx.tupleIn(db, ["f.repo", "f.number", "f.from_head"], part.map((p) => { const [repo, n] = splitRef(p.ref); return [repo, n, p.head]; }), ["text", "bigint", "text"]))
      .where("f.state", "<>", "superseded").as("t")).select(["t.repo", "t.number", "t.from_head", "t.state", "t.reason"]).where("t.rn", "=", 1));
    for (const r of rows) out.set(`${refKey(r.repo, Number(r.number))}@${r.from_head}`, { state: r.state, reason: r.reason });
  }
  return out;
}

/** Patch checks per PR, oldest first by id. 1 statement. */
export async function loadPatchChecks(db: Db, keys: KeySource): Promise<Map<RefKey, PatchCheckRow[]>> {
  const out = new Map<RefKey, PatchCheckRow[]>();
  if (noKeys(keys)) return out;
  const k = queryDb(db).k as any;
  const rows = await rowsOf<any>(db, k.selectFrom("main.patch_checks as p").innerJoin(resolveKeys(db, keys, "kk"), onKey("p"))
    .select([...PATCH_CHECK_COLS]).orderBy("p.id"));
  for (const r of rows) push(out, refKey(r.repo, Number(r.number)), patchCheckRow(r));
  return out;
}

/** The newest `patch_checks` verdict of kind `fixup` at each subject; key is `repo#number@subject`. 1 statement per 10,000 pairs. */
export async function loadFixupVerdicts(db: Db, pairs: { ref: RefKey; subject: string }[]): Promise<Map<string, "approve" | "reject">> {
  const out = new Map<string, "approve" | "reject">();
  if (!pairs.length) return out;
  const k = queryDb(db).k as any;
  for (const part of kx.chunks(pairs)) {
    const rows = await rowsOf<any>(db, k.selectFrom((eb: any) => eb.selectFrom("main.patch_checks as p")
      .select(["p.repo", "p.number", "p.subject", "p.verdict",
        (e: any) => e.fn.agg("row_number").over((o: any) => o.partitionBy(["p.repo", "p.number", "p.subject"]).orderBy("p.id", "desc")).as("rn")])
      .where("p.kind", "=", "fixup")
      .where(kx.tupleIn(db, ["p.repo", "p.number", "p.subject"], part.map((p) => { const [repo, n] = splitRef(p.ref); return [repo, n, p.subject]; }), ["text", "bigint", "text"])).as("t"))
      .select(["t.repo", "t.number", "t.subject", "t.verdict"]).where("t.rn", "=", 1));
    for (const r of rows) out.set(`${refKey(r.repo, Number(r.number))}@${r.subject}`, r.verdict);
  }
  return out;
}

/**
 * What carrying a review over a pushed fix-up reads, per (PR, head it was made on, head it made): the files it changed and, for an operator's
 * fix-up, the instructions of the request it worked. Key is `repo#number@from>to`. 1 statement per 10,000 pushes.
 */
export async function loadFixupPushes(db: Db, pushes: { ref: RefKey; from: string; to: string }[]): Promise<Map<string, { files: string[]; instructions: string | null }>> {
  const out = new Map<string, { files: string[]; instructions: string | null }>();
  if (!pushes.length) return out;
  const k = queryDb(db).k as any;
  for (const part of kx.chunks(pushes)) {
    const rows = await rowsOf<any>(db, k.selectFrom("main.fixups as f").leftJoin("main.operator_fixups as o", "o.id", "f.operator_fix")
      .select(["f.repo", "f.number", "f.from_head", "f.to_head", "f.files", "o.instructions"])
      .where("f.state", "in", FIXUP_EDGE_STATES)
      .where(kx.tupleIn(db, ["f.repo", "f.number", "f.from_head", "f.to_head"], part.map((p) => { const [repo, n] = splitRef(p.ref); return [repo, n, p.from, p.to]; }), ["text", "bigint", "text", "text"]))
      .orderBy(kx.rowid("main.fixups", "f")));
    for (const r of rows) out.set(`${refKey(r.repo, Number(r.number))}@${r.from_head}>${r.to_head}`, { files: strings(r.files), instructions: r.instructions ?? null });
  }
  return out;
}

/**
 * The newest merged conflict-merge row at each (PR, head the merge produced): the PR's own diff flag and the delta the review
 * reads instead of the head diff (the delta is a blob, so it is returned for the named rows only). Key is `repo#number@toHead`.
 */
export async function loadOwnDeltas(db: Db, pairs: { ref: RefKey; toHead: string }[]): Promise<Map<string, { fromHead: string; ownDiff: string | null; ownDelta: string | null }>> {
  const out = new Map<string, { fromHead: string; ownDiff: string | null; ownDelta: string | null }>();
  if (!pairs.length) return out;
  const k = queryDb(db).k as any;
  for (const part of kx.chunks(pairs)) {
    const rows = await rowsOf<any>(db, k.selectFrom((eb: any) => eb.selectFrom("main.conflict_merges as c")
      .select(["c.repo", "c.number", "c.to_head", "c.from_head", "c.own_diff", "c.own_delta",
        (e: any) => e.fn.agg("row_number").over((o: any) => o.partitionBy(["c.repo", "c.number", "c.to_head"]).orderBy(kx.rowid("main.conflict_merges", "c"), "desc")).as("rn")])
      .where("c.state", "=", "merged")
      .where(kx.tupleIn(db, ["c.repo", "c.number", "c.to_head"], part.map((p) => { const [repo, n] = splitRef(p.ref); return [repo, n, p.toHead]; }), ["text", "bigint", "text"])).as("t"))
      .select(["t.repo", "t.number", "t.to_head", "t.from_head", "t.own_diff", "t.own_delta"]).where("t.rn", "=", 1));
    for (const r of rows) out.set(`${refKey(r.repo, Number(r.number))}@${r.to_head}`, { fromHead: r.from_head, ownDiff: r.own_diff ?? null, ownDelta: r.own_delta ?? null });
  }
  return out;
}
