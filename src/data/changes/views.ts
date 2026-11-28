// Read models for views: timelines, activity events, trace signature, Main CI texts.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { MODEL_CHECK_COLS, PATCH_CHECK_COLS, modelCheckRow, noKeys, num, onKey, patchCheckRow, push, refKey, rowsOf, strings } from "./rows.ts";
import type { FixupSource, ModelCheckEventRow, ModelCheckRow, PatchCheckEventRow, PatchEventFilter, PatchEventRow, PatchKind, PatchSignature, PatchTimelineRow, RefKey } from "./types.ts";

const KIND_ORDER: Record<PatchKind, number> = { fixup: 0, cifix: 1, conflict: 2 };

const timelineRow = (kind: PatchKind, r: any, internals: boolean): PatchTimelineRow => ({
  kind, ciKind: kind === "cifix" ? r.kind ?? null : null, id: Number(r.id), head: kind === "cifix" ? r.head : r.from_head, toHead: r.to_head ?? null, state: r.state,
  reason: internals ? r.reason ?? null : null, files: internals ? strings(r.files) : [], attempt: Number(r.attempt), taskId: kind === "cifix" ? num(r.task_id) : null,
  source: kind === "fixup" ? ((r.source ?? null) as FixupSource | null) : null, createdAt: r.created_at,
});

const TIMELINE_COLS = {
  fixup: (a: string) => [`${a}.repo`, `${a}.number`, `${a}.from_head`, `${a}.to_head`, `${a}.state`, `${a}.reason`, `${a}.files`, `${a}.attempt`, `${a}.created_at`, `${a}.source`],
  cifix: (a: string) => [`${a}.repo`, `${a}.number`, `${a}.head`, `${a}.to_head`, `${a}.kind`, `${a}.state`, `${a}.reason`, `${a}.files`, `${a}.attempt`, `${a}.task_id`, `${a}.created_at`],
  conflict: (a: string) => [`${a}.repo`, `${a}.number`, `${a}.from_head`, `${a}.to_head`, `${a}.state`, `${a}.reason`, `${a}.files`, `${a}.attempt`, `${a}.created_at`],
};
const TABLE = { fixup: "main.fixups", cifix: "main.ci_fixes", conflict: "main.conflict_merges" } as const;
const ALIAS = { fixup: "f", cifix: "c", conflict: "c" } as const;

/**
 * Rows of all three kinds per PR, oldest first by (created, kind, id). `reason` and `files` are blanked for viewers
 * (`internals` false) inside the loader. 3 statements in one wave.
 */
export async function loadPatchTimeline(db: Db, keys: KeySource, opts: { internals: boolean }): Promise<Map<RefKey, PatchTimelineRow[]>> {
  const out = new Map<RefKey, PatchTimelineRow[]>();
  if (noKeys(keys)) return out;
  const k = queryDb(db).k as any;
  const kinds = ["fixup", "cifix", "conflict"] as const;
  const lists = await db.together(() => Promise.all(kinds.map((kind) => rowsOf<any>(db, k.selectFrom(`${TABLE[kind]} as ${ALIAS[kind]}`).innerJoin(resolveKeys(db, keys, "kk"), onKey(ALIAS[kind]))
    .select([...TIMELINE_COLS[kind](ALIAS[kind]), kx.rowid(TABLE[kind], ALIAS[kind]).as("id")])))));
  kinds.forEach((kind, i) => { for (const r of lists[i]!) push(out, refKey(r.repo, Number(r.number)), timelineRow(kind, r, opts.internals)); });
  for (const rows of out.values()) rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id - b.id));
  return out;
}

/** The feed's row filter for one table: repo, visible repos, time window and id cursor. `coalesce(repo, repo)` keeps the planner on the time index. */
const feed = (db: Db, q: any, a: string, time: string, f: PatchEventFilter, id: unknown) => {
  let b = q.where(`${a}.${time}`, "is not", null);
  if (f.repo) b = b.where(`${a}.repo`, "=", f.repo);
  if (f.repos) b = b.where((eb: any) => kx.inList(db, eb.fn.coalesce(`${a}.repo`, `${a}.repo`), f.repos!));
  if (f.since) b = b.where(`${a}.${time}`, ">=", f.since);
  if (f.before) b = b.where(`${a}.${time}`, "<=", f.before);
  if (f.afterId !== undefined) b = b.where(id, ">", f.afterId);
  return b.orderBy(`${a}.${time}`, "desc").orderBy(id, "desc").limit(f.limit);
};

/** The newest `limit` patch rows of all three kinds for the activity feed, newest first. 3 statements in one wave. */
export async function listPatchEvents(db: Db, f: PatchEventFilter): Promise<PatchEventRow[]> {
  const k = queryDb(db).k as any;
  const kinds = ["fixup", "cifix", "conflict"] as const;
  const lists = await db.together(() => Promise.all(kinds.map((kind) => {
    const a = ALIAS[kind], id = kx.rowid(TABLE[kind], a);
    return rowsOf<any>(db, feed(db, k.selectFrom(`${TABLE[kind]} as ${a}`).select([...TIMELINE_COLS[kind](a), id.as("id")]), a, "created_at", f, id));
  })));
  const rows = kinds.flatMap((kind, i) => lists[i]!.map((r): PatchEventRow => ({ ...timelineRow(kind, r, true), repo: r.repo, number: Number(r.number) })));
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : KIND_ORDER[b.kind] - KIND_ORDER[a.kind] || b.id - a.id)).slice(0, f.limit);
}

/** The newest `limit` model check rows (by start time) for the activity feed and trace, newest first. 1 statement. */
export async function listModelCheckEvents(db: Db, f: PatchEventFilter): Promise<ModelCheckEventRow[]> {
  const k = queryDb(db).k as any;
  return (await rowsOf<any>(db, feed(db, k.selectFrom("main.model_checks as m").select([...MODEL_CHECK_COLS]), "m", "started_at", f, "m.id"))).map(modelCheckRow);
}

/** The newest `limit` patch check rows for the activity feed and trace, newest first. 1 statement. */
export async function listPatchCheckEvents(db: Db, f: PatchEventFilter): Promise<PatchCheckEventRow[]> {
  const k = queryDb(db).k as any;
  return (await rowsOf<any>(db, feed(db, k.selectFrom("main.patch_checks as p").select([...PATCH_CHECK_COLS]), "p", "created_at", f, "p.id"))).map(patchCheckRow);
}

/**
 * The trace's "did anything change" probe for all keys: per PR, one string per patch table (count and the `state` + `to_head` of
 * every row by id), a count, newest id and finished count for model checks and a count and newest id for patch checks, and whether
 * a model check has no outcome yet. 5 grouped statements in one wave. A PR with no rows in any table has no entry.
 */
export async function loadPatchSignature(db: Db, keys: KeySource): Promise<Map<RefKey, PatchSignature>> {
  const out = new Map<RefKey, PatchSignature>();
  if (noKeys(keys)) return out;
  const k = queryDb(db).k as any;
  const states = (table: "main.fixups" | "main.ci_fixes" | "main.conflict_merges", a: string) => k.selectFrom(`${table} as ${a}`).innerJoin(resolveKeys(db, keys, "kk"), onKey(a))
    .select((eb: any) => [`${a}.repo`, `${a}.number`, eb.fn.countAll().as("n"),
      kx.groupConcat(db, eb(`${a}.state`, "||", eb.fn.coalesce(`${a}.to_head`, eb.val(""))), ",", kx.rowid(table, a)).as("states")]).groupBy([`${a}.repo`, `${a}.number`]);
  const [fixups, cifixes, conflicts, models, patches] = await db.together(() => Promise.all([
    rowsOf<any>(db, states("main.fixups", "f")), rowsOf<any>(db, states("main.ci_fixes", "c")), rowsOf<any>(db, states("main.conflict_merges", "x")),
    rowsOf<any>(db, k.selectFrom("main.model_checks as m").innerJoin(resolveKeys(db, keys, "kk"), onKey("m"))
      .select((eb: any) => ["m.repo", "m.number", eb.fn.countAll().as("n"), eb.fn.max("m.id").as("newest"),
        eb.fn.sum(eb.case().when("m.outcome", "is not", null).then(eb.lit(1)).else(eb.lit(0)).end()).as("done")]).groupBy(["m.repo", "m.number"])),
    rowsOf<any>(db, k.selectFrom("main.patch_checks as p").innerJoin(resolveKeys(db, keys, "kk"), onKey("p"))
      .select((eb: any) => ["p.repo", "p.number", eb.fn.countAll().as("n"), eb.fn.max("p.id").as("newest")]).groupBy(["p.repo", "p.number"])),
  ]));
  const of = (repo: string, number: unknown): PatchSignature => {
    const ref = refKey(repo, Number(number));
    let s = out.get(ref);
    if (!s) out.set(ref, s = { fixups: "0", cifixes: "0", conflicts: "0", modelChecks: "0", patchChecks: "0", running: false });
    return s;
  };
  for (const r of fixups) of(r.repo, r.number).fixups = `${r.n}:${r.states ?? ""}`;
  for (const r of cifixes) of(r.repo, r.number).cifixes = `${r.n}:${r.states ?? ""}`;
  for (const r of conflicts) of(r.repo, r.number).conflicts = `${r.n}:${r.states ?? ""}`;
  for (const r of models) { const s = of(r.repo, r.number); s.modelChecks = `${r.n}:${r.newest}:${r.done ?? 0}`; s.running = Number(r.n) > Number(r.done ?? 0); }
  for (const r of patches) of(r.repo, r.number).patchChecks = `${r.n}:${r.newest}`;
  return out;
}

/**
 * Main CI page text: the fix states, the lowest PR number of the fix PRs and why the failure log cannot be read (`unreadable`, the
 * reason of such a row) per default-branch head; key is `repo@headSha`. 1 statement (heads as one JSON list).
 */
export async function loadMainFixStates(db: Db, heads: { repo: string; headSha: string }[]): Promise<Map<string, { states: string[]; prNumber: number | null; unreadable?: string }>> {
  const out = new Map<string, { states: string[]; prNumber: number | null; unreadable?: string }>();
  if (!heads.length) return out;
  const k = queryDb(db).k as any;
  for (const part of kx.chunks(heads)) {
    const rows = await rowsOf<any>(db, k.selectFrom("main.main_fixes").select(["repo", "head_sha", "state", "reason", "pr_number"])
      .where(kx.tupleIn(db, ["repo", "head_sha"], part.map((h) => [h.repo, h.headSha]), ["text", "text"])).orderBy("repo").orderBy("head_sha").orderBy("check"));
    for (const r of rows) {
      const key = `${r.repo}@${r.head_sha}`;
      const e = out.get(key) ?? out.set(key, { states: [], prNumber: null }).get(key)!;
      if (!e.states.includes(r.state)) e.states.push(r.state);
      if (r.state === "unreadable" && r.reason) e.unreadable = r.reason;
      if (r.state === "pr-opened" && r.pr_number !== null && (e.prNumber === null || Number(r.pr_number) < e.prNumber)) e.prNumber = Number(r.pr_number);
    }
  }
  return out;
}

/** The model checks recorded for one run, by id, for linking tool uses to checks. 1 statement. */
export async function loadModelChecksOfRun(db: Db, runId: number): Promise<ModelCheckRow[]> {
  const k = queryDb(db).k as any;
  return (await rowsOf<any>(db, k.selectFrom("main.model_checks as m").select([...MODEL_CHECK_COLS]).where("m.run_id", "=", runId).orderBy("m.id"))).map(modelCheckRow);
}
