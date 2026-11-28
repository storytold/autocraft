// Conversations and their messages (`chat_conversations`, `chat_messages`): the chat of an item.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { UNTITLED } from "../../workflow/chat.ts";
import { ENTRY_LABEL } from "../../workflow/vocab.ts";
import type { ChatKind, ChatMessageRow, ChatVia, ConversationRow, NewChatMessage, Ref } from "./types.ts";

const keyOf = (repo: string, number: number): Ref => `${repo}#${number}`;

const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const CONVERSATION_COLS = ["id", "repo", "number", "is_main", "title", "created_at", "created_by"] as const;
const MESSAGE_COLS = ["id", "conversation_id", "author", "via", "kind", "body", "payload", "workflow_event_id", "turn_id", "workflow_id", "github_comment_id", "at"] as const;

type ConversationDbRow = { id: number | string; repo: string | null; number: number | string | null; is_main: number | string; title: string; created_at: string; created_by: string };
type MessageDbRow = {
  id: number | string; conversation_id: number | string; author: string; via: string; kind: string; body: string; payload: string | null;
  workflow_event_id: number | string | null; turn_id: number | string | null; workflow_id: number | string | null; github_comment_id: number | string | null; at: string;
};

const conversationOf = (r: ConversationDbRow): ConversationRow => ({
  id: Number(r.id), repo: r.repo, number: num(r.number), title: r.title, main: Number(r.is_main) === 1, createdAt: r.created_at, createdBy: r.created_by,
});
const messageOf = (r: MessageDbRow): ChatMessageRow => ({
  id: Number(r.id), conversationId: Number(r.conversation_id), author: r.author, via: r.via as ChatVia, kind: r.kind as ChatKind, body: r.body, payload: parse(r.payload),
  workflowEventId: num(r.workflow_event_id), turnId: num(r.turn_id), workflowId: num(r.workflow_id), githubCommentId: num(r.github_comment_id), at: r.at,
});

/** The title a new main conversation takes: the entry of the item's first workflow, or UNTITLED before it has one. */
const titleOf = (q: ReturnType<typeof queryDb>, repo: string, number: number) => {
  const first = q.k.selectFrom("main.item_workflows as w").select(kx.caseOf("w.entry", Object.entries(ENTRY_LABEL)).as("title"))
    .where("w.repo", "=", repo).where("w.number", "=", number).orderBy("w.id").limit(1);
  return q.k.fn.coalesce(first, kx.literal(UNTITLED));
};

/**
 * The main conversation of each item, made where there is none (`by` and `at` are its creator and time). Two statements per 500 items.
 * Joins the caller's `db.write`.
 */
export async function ensureMainConversations(db: Db, items: readonly { repo: string; number: number; by: string; at?: string }[]): Promise<Map<Ref, number>> {
  const out = new Map<Ref, number>();
  const byKey = new Map(items.map((i) => [keyOf(i.repo, i.number), i]));
  if (!byKey.size) return out;
  const q = queryDb(db);
  const now = new Date().toISOString();
  await db.write(async () => {
    for (const part of kx.batches([...byKey.values()])) {
      await q.run((q.k as any).insertInto("main.chat_conversations").values(part.map((i) => ({
        repo: i.repo, number: i.number, is_main: 1, title: titleOf(q, i.repo, i.number), created_at: i.at ?? now, created_by: i.by,
      // A conflict target repeats a partial index's predicate as written there: a bound value does not match it.
      }))).onConflict((oc: any) => oc.columns(["repo", "number"]).where("is_main", "=", kx.literal(1)).doNothing()));
      const got = await q.all(q.k.selectFrom("main.chat_conversations as c").select(["c.id", "c.repo", "c.number"]).where("c.is_main", "=", 1)
        .where(kx.refIn(db, "c", part.map((i) => keyOf(i.repo, i.number)))), { label: "chat.ensureMainConversations" });
      for (const r of got) out.set(keyOf(r.repo!, Number(r.number)), Number(r.id));
    }
  });
  return out;
}

/** The id of the item's main conversation, made when it has none. */
export async function ensureMainConversation(db: Db, repo: string, number: number, by: string): Promise<number> {
  const id = (await ensureMainConversations(db, [{ repo, number, by }])).get(keyOf(repo, number));
  if (id === undefined) throw new Error(`chat: no main conversation for ${repo}#${number}`);
  return id;
}

/** The item's conversations, the main one first, then oldest first. */
export async function loadConversationsOfItem(db: Db, repo: string, number: number): Promise<ConversationRow[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.chat_conversations").select(CONVERSATION_COLS).where("repo", "=", repo).where("number", "=", number)
    .orderBy("is_main", "desc").orderBy("id"), { label: "chat.loadConversationsOfItem" });
  return rows.map((r) => conversationOf(r as ConversationDbRow));
}

/** The messages of each conversation in time order (`at`, then id); with `sinceId`, only those with a larger id. A conversation with none is absent. */
export async function loadMessages(db: Db, conversationIds: number[], sinceId?: number): Promise<Map<number, ChatMessageRow[]>> {
  const out = new Map<number, ChatMessageRow[]>();
  const q = queryDb(db);
  for (const ids of kx.chunks([...new Set(conversationIds)])) {
    const rows = await q.all(q.k.selectFrom("main.chat_messages").select(MESSAGE_COLS).where(kx.inList(db, "conversation_id", ids, "bigint"))
      .$if(sinceId !== undefined, (s) => s.where("id", ">", sinceId!)).orderBy("at").orderBy("id"), { label: "chat.loadMessages" });
    for (const r of rows) {
      const m = messageOf(r as MessageDbRow);
      const list = out.get(m.conversationId);
      if (list) list.push(m); else out.set(m.conversationId, [m]);
    }
  }
  return out;
}

/**
 * Stores the messages, each in its item's main conversation (made when missing), one insert per 500 rows. A GitHub comment that is
 * stored already (a redelivery) is not stored again: its stored row comes back. Returns the rows, inserted ones in input order.
 * Joins the caller's `db.write`.
 */
export async function recordMessages(db: Db, ms: readonly NewChatMessage[]): Promise<ChatMessageRow[]> {
  if (!ms.length) return [];
  const q = queryDb(db);
  const now = new Date().toISOString();
  return await db.write(async () => {
    const convs = await ensureMainConversations(db, ms.map((m) => ({ repo: m.repo, number: m.number, by: m.author, ...(m.at ? { at: m.at } : {}) })));
    const out: ChatMessageRow[] = [];
    for (const part of kx.batches(ms)) {
      const got = await q.all((q.k as any).insertInto("main.chat_messages").values(part.map((m) => ({
        conversation_id: convs.get(keyOf(m.repo, m.number))!, author: m.author, via: m.via, kind: m.kind, body: m.body,
        payload: m.payload === undefined || m.payload === null ? null : JSON.stringify(m.payload),
        workflow_event_id: m.workflowEventId ?? null, turn_id: m.turnId ?? null, workflow_id: m.workflowId ?? null, github_comment_id: m.githubCommentId ?? null, at: m.at ?? now,
      }))).onConflict((oc: any) => oc.column("github_comment_id").where("github_comment_id", "is not", null).doNothing()).returning(MESSAGE_COLS)) as MessageDbRow[];
      out.push(...got.map(messageOf).sort((a, b) => a.id - b.id));
    }
    const stored = new Set(out.flatMap((m) => (m.githubCommentId === null ? [] : [m.githubCommentId])));
    const again = [...new Set(ms.flatMap((m) => (m.githubCommentId != null && !stored.has(m.githubCommentId) ? [m.githubCommentId] : [])))];
    if (again.length) {
      const rows = await q.all(q.k.selectFrom("main.chat_messages").select(MESSAGE_COLS).where(kx.inList(db, "github_comment_id", again, "bigint")), { label: "chat.recordMessages" });
      out.push(...rows.map((r) => messageOf(r as MessageDbRow)));
    }
    return out;
  });
}

/**
 * Stores Task Runner notices (kind `notice`), each in its item's main conversation: a notice whose workflow already has one of the same
 * payload (its reason) is left out by the unique index `chat_messages_notice`, so two processes never store it twice. Returns how many
 * were stored. Joins the caller's `db.write`.
 */
export async function recordNotices(db: Db, ms: readonly (NewChatMessage & { kind: "notice"; workflowId: number })[]): Promise<number> {
  if (!ms.length) return 0;
  const q = queryDb(db);
  const now = new Date().toISOString();
  return await db.write(async () => {
    const convs = await ensureMainConversations(db, ms.map((m) => ({ repo: m.repo, number: m.number, by: m.author })));
    let n = 0;
    for (const m of ms) {
      const got = await q.all((q.k as any).insertInto("main.chat_messages").values({
        conversation_id: convs.get(keyOf(m.repo, m.number))!, author: m.author, via: m.via, kind: m.kind, body: m.body,
        payload: m.payload === undefined || m.payload === null ? null : JSON.stringify(m.payload), workflow_id: m.workflowId, at: m.at ?? now,
      }).onConflict((oc: any) => oc.doNothing()).returning(["id"]), { label: "chat.recordNotices" }) as { id: unknown }[];
      n += got.length;
    }
    return n;
  });
}

/** Stores one message; see recordMessages. */
export async function recordMessage(db: Db, m: NewChatMessage): Promise<ChatMessageRow> {
  const [row] = await recordMessages(db, [m]);
  if (!row) throw new Error(`chat: message on ${m.repo}#${m.number} was not stored`);
  return row;
}

/** The item and id of the message stored for a GitHub comment, or null. */
export async function loadCommentMessage(db: Db, commentId: number): Promise<{ id: number; repo: string; number: number } | null> {
  const q = queryDb(db);
  const m = await q.get(q.k.selectFrom("main.chat_messages as m").innerJoin("main.chat_conversations as c", "c.id", "m.conversation_id")
    .select(["m.id as id", "c.repo as repo", "c.number as number"]).where("m.github_comment_id", "=", commentId));
  return m && m.repo ? { id: Number(m.id), repo: m.repo, number: Number(m.number) } : null;
}

/** Links a stored message to what it produced: the workflow event of its command, or the turn of its question. Joins the caller's `db.write`. */
export async function linkMessage(db: Db, id: number, link: { workflowEventId?: number; turnId?: number }): Promise<void> {
  const set = { ...(link.workflowEventId !== undefined ? { workflow_event_id: link.workflowEventId } : {}), ...(link.turnId !== undefined ? { turn_id: link.turnId } : {}) };
  if (!Object.keys(set).length) return;
  const q = queryDb(db);
  await db.write(() => q.run(q.k.updateTable("main.chat_messages").set(set).where("id", "=", id)));
}

/**
 * Keeps the reply to a said message that produced no event or turn (a refused command, a question Opus could not take) in its payload
 * as `refusal`, beside what the payload holds already. Joins the caller's `db.write`.
 */
export async function setMessageRefusal(db: Db, id: number, refusal: string): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const row = await q.get(q.k.selectFrom("main.chat_messages").select("payload").where("id", "=", id));
    if (!row) return;
    const was = parse(row.payload as string | null);
    const payload = was && typeof was === "object" && !Array.isArray(was) ? { ...(was as Record<string, unknown>), refusal } : { refusal };
    await q.run(q.k.updateTable("main.chat_messages").set({ payload: JSON.stringify(payload) }).where("id", "=", id));
  });
}

/** The person's message a question turn was put from (linkMessage turnId): where it came from, or null. */
export async function loadTurnMessage(db: Db, turnId: number): Promise<{ id: number; via: ChatVia; author: string; githubCommentId: number | null; payload: unknown } | null> {
  const q = queryDb(db);
  const m = await q.get(q.k.selectFrom("main.chat_messages").select(["id", "via", "author", "github_comment_id", "payload"]).where("turn_id", "=", turnId).orderBy("id").limit(1));
  return m ? { id: Number(m.id), via: m.via as ChatVia, author: m.author, githubCommentId: m.github_comment_id === null ? null : Number(m.github_comment_id), payload: parse(m.payload as string | null) } : null;
}

/** Links the person's newest message on the item from `via` that is linked to nothing yet to the question turn it was put as; returns its id, or null. */
export async function linkNewestSaid(db: Db, o: { repo: string; number: number; author: string; via: ChatVia; turnId: number }): Promise<number | null> {
  const q = queryDb(db);
  return await db.write(async () => {
    const m = await q.get(q.k.selectFrom("main.chat_messages as m").innerJoin("main.chat_conversations as c", "c.id", "m.conversation_id").select("m.id as id")
      .where("c.repo", "=", o.repo).where("c.number", "=", o.number).where("m.author", "=", o.author).where("m.via", "=", o.via).where("m.kind", "=", "said")
      .where("m.turn_id", "is", null).where("m.workflow_event_id", "is", null).orderBy("m.id", "desc").limit(1));
    if (!m) return null;
    await q.run(q.k.updateTable("main.chat_messages").set({ turn_id: o.turnId }).where("id", "=", Number(m.id)));
    return Number(m.id);
  });
}
