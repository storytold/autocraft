// Writers of attempts and rounds. Atomic on their own (`db.write`, joining an outer transaction) and take sets.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "../control/index.ts";
import { COLUMN_TYPE, ENDED, IMPL_COLS, columnsOf, json, ofRow, type ImplRow } from "./rows.ts";
import { reviseCopy, type AttemptGuidance, type AttemptStep, type Implementation, type ImplementationState, type RefKey, type ReviseRound, type StartAttempt } from "./types.ts";

const now = () => new Date().toISOString();
const refOf = (r: { repo: string; number: number }): RefKey => `${r.repo}#${r.number}`;

/** One `INSERT ... SELECT` of the next attempts of issues that have no current one. The caller rejects duplicate refs. */
async function insertAttempts(db: Db, rows: StartAttempt[], at: string): Promise<Implementation[]> {
  const q = queryDb(db);
  const k = q.k as any;
  const out: Implementation[] = [];
  for (const chunk of kx.chunks(rows)) {
    const v = kx.valuesTable(db, chunk.map((r, ord) => ({ ord, repo: r.repo, number: r.number, queued_by: r.queuedBy, text_hash: r.textHash, base_sha: r.baseSha ?? null })),
      { ord: "bigint", repo: "text", number: "bigint", queued_by: "text", text_hash: "text", base_sha: "text" }, "v");
    const sel = k.selectFrom(v).select((eb: any) => [
      "v.repo as repo", "v.number as number", "v.queued_by as queued_by", eb.val("planning").as("state"),
      eb(eb.fn.coalesce(eb.selectFrom("main.implementations as p").select((e: any) => e.fn.max("p.attempt").as("n")).whereRef("p.repo", "=", "v.repo").whereRef("p.number", "=", "v.number"), eb.lit(0)), "+", eb.lit(1)).as("attempt"),
      "v.text_hash as text_hash", "v.base_sha as base_sha", eb.val(at).as("created_at"), eb.val(at).as("updated_at"),
    ]).where((eb: any) => eb.not(eb.exists(eb.selectFrom("main.implementations as c").select(eb.lit(1).as("one")).whereRef("c.repo", "=", "v.repo").whereRef("c.number", "=", "v.number").where("c.state", "not in", ENDED)))).orderBy("v.ord");
    out.push(...((await q.all(k.insertInto("main.implementations").columns(["repo", "number", "queued_by", "state", "attempt", "text_hash", "base_sha", "created_at", "updated_at"]).expression(sel).returning([...IMPL_COLS]))) as ImplRow[]).map(ofRow));
  }
  return out;
}

/** Starts attempts in state `planning` with `attempt = max + 1`, refusing an issue that has a current attempt. 1 statement, plus 1 read when some were refused. */
export async function startAttempts(db: Db, rows: StartAttempt[], at: string = now()): Promise<{ started: Implementation[]; refused: { ref: RefKey; current: { id: number; state: string } }[] }> {
  if (rows.length === 0) return { started: [], refused: [] };
  if (new Set(rows.map(refOf)).size !== rows.length) throw new Error("startAttempts: two attempts of one issue in one call");
  return await db.write(async () => {
    const started = await insertAttempts(db, rows, at);
    const got = new Set(started.map(refOf));
    const missing = rows.filter((r) => !got.has(refOf(r)));
    if (missing.length === 0) return { started, refused: [] };
    const q = queryDb(db);
    const cur = await q.all(q.k.selectFrom("main.implementations").select(["id", "repo", "number", "state"]).where("state", "not in", ENDED).where(kx.refIn(db, "implementations", missing.map((r): [string, number] => [r.repo, r.number]))));
    return { started, refused: cur.map((c) => ({ ref: refOf({ repo: c.repo, number: Number(c.number) }), current: { id: Number(c.id), state: c.state } })) };
  });
}

/** One-row wrapper over `startAttempts`; null when the issue has a current attempt. */
export async function startAttempt(db: Db, row: StartAttempt, at?: string): Promise<Implementation | null> {
  return (await startAttempts(db, [row], at)).started[0] ?? null;
}

/**
 * Applies moves, round inserts and round-result updates in one transaction with compare-and-set guards; a guarded step that did not match adds nothing.
 * Steps are grouped by the columns they write and the states they expect, one `UPDATE ... FROM` per group; the rounds of the applied steps are
 * one multi-row insert and their result updates one more statement.
 */
export async function recordSteps(db: Db, steps: AttemptStep[], at: string = now()): Promise<{ applied: Map<number, boolean>; roundIds: Map<number, number[]> }> {
  const applied = new Map<number, boolean>();
  const roundIds = new Map<number, number[]>();
  if (steps.length === 0) return { applied, roundIds };
  const q = queryDb(db);
  const k = q.k as any;
  await db.write(async () => {
    const groups = new Map<string, { cols: string[]; expect: ImplementationState[] | null; rows: Record<string, string | number | null>[] }>();
    for (const s of steps) {
      const values = { ...columnsOf(s.patch ?? {}), ...(s.to ? { state: s.to } : {}) };
      const cols = Object.keys(values).sort();
      if (cols.length === 0 && !s.expect) { applied.set(s.id, true); continue; }
      const expect = s.expect ? [...s.expect].sort() : null;
      const key = JSON.stringify([cols, expect]);
      (groups.get(key) ?? groups.set(key, { cols, expect, rows: [] }).get(key)!).rows.push({ step_id: s.id, ...values });
    }
    for (const g of groups.values()) {
      for (const chunk of kx.chunks(g.rows)) {
        const v = kx.valuesTable(db, chunk, { step_id: "bigint", ...Object.fromEntries(g.cols.map((c) => [c, COLUMN_TYPE[c]!])) }, "v");
        const rows = await q.all(k.updateTable("main.implementations as im").from(v)
          .set((eb: any) => ({ ...Object.fromEntries(g.cols.map((c) => [c, eb.ref(`v.${c}`)])), updated_at: eb.val(at) }))
          .where((eb: any) => eb.and([eb("im.id", "=", eb.ref("v.step_id")), ...(g.expect ? [eb("im.state", "in", g.expect)] : [])]))
          .returning("id")) as { id: number | string }[];
        const hit = new Set(rows.map((r) => Number(r.id)));
        for (const r of chunk) applied.set(Number(r.step_id), hit.has(Number(r.step_id)));
      }
    }
    const added = steps.flatMap((s) => (applied.get(s.id) ? (s.addRounds ?? []).map((r) => ({ step: s.id, r })) : []));
    for (const part of kx.batches(added)) {
      const ids = ((await q.all(k.insertInto("main.implementation_rounds").values(part.map(({ step, r }) => ({ implementation_id: step, kind: r.kind, call_id: r.callId ?? null, result: json(r.result), at })))
        .returning("id"))) as { id: number | string }[]).map((x) => Number(x.id)).sort((a, b) => a - b);
      part.forEach(({ step }, i) => (roundIds.get(step) ?? roundIds.set(step, []).get(step)!).push(ids[i]!));
    }
    const set = steps.flatMap((s) => (applied.get(s.id) ? (s.setRounds ?? []).map((r) => ({ id: r.id, result: json(r.result) })) : []));
    if (set.length) await kx.updateFrom(db, "implementation_rounds", ["id"], set);
  });
  return { applied, roundIds };
}

/** "Try again" on an attempt without a PR: moves the old attempt to `failed` and starts the next, with the guidance round on the new id. */
export async function restartAttempt(db: Db, o: { id: number; reason: string; queuedBy: string; textHash: string; guidance?: AttemptGuidance; at?: string }): Promise<Implementation> {
  const at = o.at ?? now();
  const q = queryDb(db);
  return await db.write(async () => {
    const old = await q.get(q.k.updateTable("main.implementations").set({ state: "failed", reason: `${o.reason}; tried again`, updated_at: at }).where("id", "=", o.id).where("state", "not in", ENDED).returning(["repo", "number"]));
    if (!old) throw new Error(`attempt ${o.id} is not open`);
    const next = (await insertAttempts(db, [{ repo: old.repo, number: Number(old.number), queuedBy: o.queuedBy, textHash: o.textHash }], at))[0];
    if (!next) throw new Error(`${old.repo}#${old.number} has a current attempt`);
    if (o.guidance) await q.run(q.k.insertInto("main.implementation_rounds").values({ implementation_id: next.id, kind: "guidance", call_id: null, result: json({ by: o.guidance.by, text: o.guidance.text.slice(0, 4000) }), at }));
    return next;
  });
}

/** "Try again" on a stuck revision: copies the newest `revise` round with the guidance appended and moves `stuck` to `revising`; false when there is no revise round or the attempt is not stuck. */
export async function retryRevision(db: Db, o: { id: number; guidance?: AttemptGuidance; at?: string }): Promise<boolean> {
  const at = o.at ?? now();
  const q = queryDb(db);
  return await db.write(async () => {
    const last = await q.get(q.k.selectFrom("main.implementation_rounds").select("result").where("implementation_id", "=", o.id).where("kind", "=", "revise").orderBy("id", "desc").limit(1));
    if (!last) return false;
    const was = JSON.parse(last.result ?? "null") as ReviseRound | null;
    if (!was) return false;
    const moved = await q.run(q.k.updateTable("main.implementations").set({ state: "revising", updated_at: at }).where("id", "=", o.id).where("state", "=", "stuck"));
    if (moved.changes !== 1) return false;
    const note = o.guidance?.text.trim();
    const message = note ? `${was.message}\n\nA maintainer's note on this revision:\n<guidance>\n${note.slice(0, 4000).replace(/</g, "\\u003c")}\n</guidance>` : was.message;
    await q.run(q.k.insertInto("main.implementation_rounds").values([
      ...(note ? [{ implementation_id: o.id, kind: "guidance", call_id: null, result: json({ by: o.guidance!.by, text: note.slice(0, 4000) }), at }] : []),
      { implementation_id: o.id, kind: "revise", call_id: null, result: json({ ...reviseCopy(was), message } satisfies ReviseRound), at },
    ]));
    return true;
  });
}

/** Cancels attempts without a PR and records `implement-cancel` audit rows; the caller ends the returned workspaces. */
export async function cancelUnopened(db: Db, rows: { repo: string; number: number; reason: string }[], by: string, at: string = now()): Promise<{ id: number; repo: string; number: number; workspaceId: number | null }[]> {
  if (rows.length === 0) return [];
  const q = queryDb(db);
  const k = q.k as any;
  const last = new Map(rows.map((r) => [refOf(r), r]));
  return await db.write(async () => {
    const out: { id: number; repo: string; number: number; workspaceId: number | null; reason: string }[] = [];
    const reasonOf = new Map([...last].map(([ref, r]) => [ref, r.reason]));
    for (const chunk of kx.chunks([...last.values()])) {
      const v = kx.valuesTable(db, chunk.map((r) => ({ v_repo: r.repo, v_number: r.number, v_reason: r.reason })), { v_repo: "text", v_number: "bigint", v_reason: "text" }, "v");
      const hit = await q.all(k.updateTable("main.implementations as im").from(v).set((eb: any) => ({ state: "cancelled", reason: eb.ref("v.v_reason"), updated_at: eb.val(at) }))
        .where((eb: any) => eb.and([eb("im.repo", "=", eb.ref("v.v_repo")), eb("im.number", "=", eb.ref("v.v_number")),
          eb("im.state", "not in", ENDED), eb("im.pr_number", "is", null)]))
        .returning(["id", "repo", "number", "workspace_id"])) as { id: number | string; repo: string; number: number | string; workspace_id: number | string | null }[];
      for (const r of hit) { const ref = refOf({ repo: r.repo, number: Number(r.number) }); out.push({ id: Number(r.id), repo: r.repo, number: Number(r.number), workspaceId: r.workspace_id === null ? null : Number(r.workspace_id), reason: reasonOf.get(ref)! }); }
    }
    await addAudit(db, out.map((r) => ({ login: by, action: "implement-cancel", target: refOf(r), details: { id: r.id, reason: r.reason }, at })));
    return out.map(({ reason: _reason, ...r }) => r);
  });
}

/** One multi-row insert of `answer` rounds when a person answers an `asked` or `stuck` recommendation; writes no state change. */
export async function recordAnswers(db: Db, rows: { id: number; question: number; by: string; via: string; option?: string; text?: string }[], at: string = now()): Promise<number> {
  if (rows.length === 0) return 0;
  const q = queryDb(db);
  let n = 0;
  await db.write(async () => {
    for (const part of kx.batches(rows))
      n += (await q.run(q.k.insertInto("main.implementation_rounds").values(part.map((r) => ({
        implementation_id: r.id, kind: "answer", call_id: null, at,
        result: JSON.stringify({ by: r.by, via: r.via, at, question: r.question, ...(r.option !== undefined && { option: r.option }), ...(r.text !== undefined && { text: r.text }) }),
      }))))).changes;
  });
  return n;
}
