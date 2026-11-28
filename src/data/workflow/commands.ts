// The GitHub commands inbox and link nudges (M11 workflow-b).
import type { AliasableExpression, SqlBool } from "kysely";
import type { Db, Param } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "../control/audit.ts";
import type { CommandProgress, CommandRow, CommandSettle, NewCommand } from "./types.ts";
import { groupBy, patchRows } from "./update.ts";

const T = "main.github_commands";
/** Settled commands are kept this long. */
const KEEP_MS = 30 * 86400_000;
/** The audit login of commands nobody answered (ignored, expired). */
const AUDIT_LOGIN = "github-command";

/** Queued commands, and settled ones whose answer is still to post. */
const workExpr = (eb: kx.AnyEb): AliasableExpression<SqlBool> =>
  eb.or([eb("state", "=", "queued"), eb.and([eb("state", "<>", "queued"), eb("reply", "is", null)])]);

/** Batched insert `ON CONFLICT DO NOTHING` (a redelivered comment adds nothing); returns the rows added. */
export async function queueCommands(db: Db, rows: NewCommand[]): Promise<number> {
  const q = queryDb(db);
  const unique = [...new Map(rows.map((r) => [r.comment_id, r])).values()];
  if (!unique.length) return 0;
  return await db.write(async () => {
    let added = 0;
    for (const part of kx.batches(unique)) {
      // `command` is a legacy NOT NULL column until the drop migration.
      added += Number((await q.run(q.k.insertInto(T).values(part.map((r) => ({ ...r, command: "answer", state: "queued" }))).onConflict((oc) => oc.doNothing()))).changes);
    }
    return added;
  });
}

/**
 * Queued commands, or settled ones whose answer is still to post, never-tried first, then by last try or arrival, then arrival.
 * With `retryBefore`, a queued command tried after it is left out (it waits out its retry delay, so it cannot fill the limit).
 */
export async function loadCommandWork(db: Db, o: { limit: number; retryBefore?: string }): Promise<CommandRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom(T).select(kx.cols(T))
    .where((eb) => workExpr(eb))
    .$if(o.retryBefore !== undefined, (b) => b.where((eb) => eb.or([eb("state", "<>", "queued"), eb("tried_at", "is", null), eb("tried_at", "<=", o.retryBefore!)])))
    .orderBy((eb) => eb("tried_at", "is not", null)).orderBy((eb) => eb.fn.coalesce("tried_at", "requested_at")).orderBy(kx.rowid(T))
    .limit(o.limit)) as CommandRow[];
}

/** Existence probe for the runner tick. */
export async function hasCommandWork(db: Db): Promise<boolean> {
  const q = queryDb(db);
  return !!await q.get(q.k.selectFrom(T).select((eb) => eb.lit(1).as("one")).where((eb) => workExpr(eb)).limit(1));
}

/** Batched update that audits `github-command` per row; a comment id that is not stored is skipped. `reply` true leaves the answer to post (null), false marks none (`none`). */
export async function settleCommands(db: Db, rows: CommandSettle[]): Promise<void> {
  const last = [...new Map(rows.map((r) => [r.commentId, r])).values()];
  if (!last.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    const known = new Map((await q.all(q.k.selectFrom(T).select(["comment_id", "repo", "number", "login", kx.jsonText(db, "parsed", "$.kind").as("kind")])
      .where(kx.inList(db, "comment_id", last.map((r) => r.commentId), "bigint")))).map((r) => [Number(r.comment_id), r]));
    const mine = last.filter((r) => known.has(r.commentId));
    await kx.updateFrom(db, T, ["comment_id"], mine.map((r): Record<string, Param> => ({
      comment_id: r.commentId, state: r.state, result: r.result, done_at: r.at, reply: r.reply ? null : "none", allowed: r.allowed ? 1 : 0,
    })));
    await addAudit(db, mine.map((r) => {
      const c = known.get(r.commentId)!;
      return {
        login: r.state === "ignored" || r.state === "expired" ? AUDIT_LOGIN : c.login, action: "github-command", target: `${c.repo}#${c.number}`, at: r.at,
        details: { comment: r.commentId, command: c.kind, by: c.login, state: r.state, ...(r.result ? { result: r.result } : {}) },
      };
    }));
  });
}

/** Batched update, one statement per distinct column set (a try time, a try time with a retry, a reply). `retryInc` adds one to `retries`. */
export async function saveCommandProgress(db: Db, rows: CommandProgress[]): Promise<void> {
  if (!rows.length) return;
  const shape = (r: CommandProgress) => [r.triedAt !== undefined, !!r.retryInc, r.reply !== undefined] as const;
  await db.write(async () => {
    for (const group of groupBy(rows, (r) => shape(r).join())) {
      const [tried, retry, reply] = shape(group[0]);
      const set: Record<string, kx.ElemType> = { ...(tried ? { tried_at: "text" } : {}), ...(reply ? { reply: "text" } : {}) };
      const values = group.map((r): Record<string, Param> => ({ comment_id: r.commentId, ...(tried ? { tried_at: r.triedAt! } : {}), ...(reply ? { reply: r.reply! } : {}) }));
      if (!Object.keys(set).length && !retry) continue;
      await patchRows(db, T, { comment_id: "bigint" }, set, values, { also: retry ? (eb) => ({ retries: eb("retries", "+", 1) }) : undefined });
    }
  });
}

/** Deletes settled commands older than the keep time; returns the rows deleted. */
export async function pruneCommands(db: Db, nowMs: number): Promise<number> {
  const q = queryDb(db);
  return await db.write(async () => Number((await q.run(q.k.deleteFrom(T).where("state", "<>", "queued").where("done_at", "<", new Date(nowMs - KEEP_MS).toISOString()))).changes));
}

/** Last nudge time per login, keyed by the logins as given (matched case-insensitively). */
export async function loadNudges(db: Db, logins: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!logins.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.github_link_nudges").select(["login", "at"]).where(kx.inList(db, "login", logins, "citext")));
  const at = new Map(rows.map((r) => [r.login.toLowerCase(), r.at]));
  for (const l of logins) if (at.has(l.toLowerCase())) out.set(l, at.get(l.toLowerCase())!);
  return out;
}

/** Batched upsert of the last nudge per login. */
export async function recordNudges(db: Db, rows: { login: string; at: string }[]): Promise<void> {
  const unique = [...new Map(rows.map((r) => [r.login.toLowerCase(), r])).values()];
  if (!unique.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(unique)) await q.run(q.k.insertInto("main.github_link_nudges").values(part).onConflict((oc) => oc.column("login").doUpdateSet(kx.excluded(["at"]))));
  });
}

/**
 * Settles a command that waits for the answer to its question (state `asked`) with the answer to post: `done` with the answer, `refused`
 * with why there is none. `reply` false: nothing is posted (a question withdrawn in the item's chat). `model`: the model that wrote the
 * answer, which the post's note line names; absent for template text. False when the command does not wait (it was settled already, or pruned).
 */
export async function settleAsked(db: Db, commentId: number, o: { state: "done" | "refused"; result: string; at: string; reply?: boolean; model?: string }): Promise<boolean> {
  const q = queryDb(db);
  return await db.write(async () => {
    const row = await q.get(q.k.selectFrom(T).select("state").where("comment_id", "=", commentId));
    if (row?.state !== "asked") return false;
    await settleCommands(db, [{ commentId, state: o.state, result: o.result, reply: o.reply ?? true, allowed: true, at: o.at }]);
    if (o.model) await q.run(q.k.updateTable(T).set({ model: o.model }).where("comment_id", "=", commentId));
    return true;
  });
}

/** The commands that wait for the answer to their question, with the state and end time of the Opus turn their comment's message was put as (null: no such turn). */
export async function loadAskedCommands(db: Db): Promise<{ commentId: number; repo: string; number: number; requestedAt: string; turnStatus: string | null; turnError: string | null; turnEndedAt: string | null }[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(`${T} as g`)
    .leftJoin("main.chat_messages as m", (j) => j.onRef("m.github_comment_id", "=", "g.comment_id").on("m.turn_id", "is not", null))
    .leftJoin("main.conversation_turns as t", "t.id", "m.turn_id")
    .select(["g.comment_id as comment_id", "g.repo as repo", "g.number as number", "g.requested_at as requested_at", "t.status as status", "t.error as error", "t.ended_at as ended_at"])
    .where("g.state", "=", "asked").orderBy("g.comment_id"));
  return rows.map((r) => ({
    commentId: Number(r.comment_id), repo: r.repo, number: Number(r.number), requestedAt: r.requested_at, turnStatus: r.status ?? null, turnError: r.error ?? null, turnEndedAt: r.ended_at ?? null,
  }));
}
