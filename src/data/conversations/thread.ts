// Conversations and turns (M12 conversations).
import { randomUUID } from "node:crypto";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { withdrawTurnCalls } from "../runners/index.ts";
import { ensureMainConversations } from "../chat/messages.ts";
import { CARD_COLS, loadQueue } from "./cards.ts";
import type { CardRow, ConversationRow, GuidanceTurn, NewConversation, NewCard, NewTurn, PendingTurn, PostMessage, RefKey, Thread, ThreadTurn, TurnDigest, TurnEvent, TurnKind, TurnRow, TurnTail } from "./types.ts";

export class ConversationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const PERSON = ["operator", "maintainer"] as const;
const WAITING = ["pending", "answering"] as const;
const BUSY = "Opus has not answered the last message yet";

const keyOf = (repo: string, number: number): RefKey => `${repo}#${number}`;
const refsOf = (refs: readonly RefKey[]): RefKey[] => [...new Set(refs)];
const splitRef = (ref: RefKey): [string, number] => { const i = ref.lastIndexOf("#"); return [ref.slice(0, i), Number(ref.slice(i + 1))]; };

/** Integer columns come back as numbers on SQLite and may be text-sized on Postgres. */
const turnOf = <T extends { id: unknown; number: unknown; seq: unknown }>(r: T): T => ({ ...r, id: Number(r.id), number: Number(r.number), seq: r.seq === null ? null : Number(r.seq) });

/** The display order of a thread: prompt order, then the message being answered, then turns held until its reply. */
const displayOrder = <Q extends { orderBy: Function }>(qb: Q, a: string): Q =>
  (qb as any).orderBy((eb: kx.AnyEb) => eb(`${a}.seq`, "is", null)).orderBy((eb: kx.AnyEb) => eb(eb.fn.coalesce(`${a}.status`, eb.val("")), "=", "held")).orderBy(`${a}.seq`).orderBy(`${a}.id`);

const turnCols = (blocks: boolean) => (blocks ? kx.cols("main.conversation_turns", "t") : kx.cols("main.conversation_turns", "t").filter((c) => c !== "t.block"));

/** Conversation, turns (display order), cards and the waiting turn in one wave; `block` only with `blocks`; `withQueue` adds the card queue snapshot. */
export async function loadThreads(db: Db, refs: RefKey[], o?: { blocks?: boolean; withQueue?: boolean }): Promise<Map<RefKey, Thread>> {
  const out = new Map<RefKey, Thread>();
  const keys = refsOf(refs);
  if (!keys.length) return out;
  const q = queryDb(db);
  const [convs, turns, cards, queue] = await db.together(() => Promise.all([
    loadConversations(db, keys),
    q.all(displayOrder(q.k.selectFrom("main.conversation_turns as t").select(turnCols(!!o?.blocks)).where(kx.refIn(db, "t", keys)).orderBy("t.repo").orderBy("t.number"), "t")),
    q.all(q.k.selectFrom("main.conversation_cards as c").select(CARD_COLS.map((c) => `c.${c}` as const)).where(kx.refIn(db, "c", keys)).orderBy("c.id")),
    o?.withQueue ? loadQueue(db) : Promise.resolve(undefined),
  ]));
  for (const [k, conversation] of convs) out.set(k, { conversation, turns: [], cards: [], waiting: null, ...(queue && { queue }) });
  for (const r of turns) {
    const t = out.get(keyOf(r.repo, Number(r.number)));
    if (!t) continue;
    const turn = turnOf(r) as unknown as ThreadTurn;
    t.turns.push(turn);
    if (!t.waiting && (PERSON as readonly string[]).includes(turn.kind) && (WAITING as readonly string[]).includes(turn.status ?? "")) t.waiting = turn;
  }
  for (const c of cards) out.get(keyOf(c.repo, Number(c.number)))?.cards.push({ ...c, id: Number(c.id), turn_id: Number(c.turn_id), number: Number(c.number) } as unknown as CardRow);
  return out;
}

/** Conversation rows. */
export async function loadConversations(db: Db, refs: RefKey[]): Promise<Map<RefKey, ConversationRow>> {
  const out = new Map<RefKey, ConversationRow>();
  const keys = refsOf(refs);
  if (!keys.length) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("main.conversations as c").select(kx.cols("main.conversations", "c")).where(kx.refIn(db, "c", keys)))) out.set(keyOf(r.repo, Number(r.number)), { ...r, number: Number(r.number) });
  return out;
}

/**
 * Max seq, waiting turn, held ids and the newest person block that carries a `<steps>` line, per item; replaces `nextSeq`, `pendingTurn` and
 * `seenSteps`. 3 statements in one wave; every ref asked for has an entry.
 */
export async function loadTurnTails(db: Db, refs: RefKey[]): Promise<Map<RefKey, TurnTail>> {
  const out = new Map<RefKey, TurnTail>();
  const keys = refsOf(refs);
  if (!keys.length) return out;
  for (const k of keys) out.set(k, { maxSeq: 0, waiting: null, heldIds: [], lastPersonBlock: null });
  const q = queryDb(db), { k } = q;
  const [maxes, open, newest] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.conversation_turns as t").select(["t.repo", "t.number", (eb) => eb.fn.max<number | null>("t.seq").as("max_seq")]).where(kx.refIn(db, "t", keys)).groupBy(["t.repo", "t.number"])),
    q.all(k.selectFrom("main.conversation_turns as t").select(kx.cols("main.conversation_turns", "t")).where(kx.refIn(db, "t", keys)).where("t.status", "in", ["pending", "answering", "held"]).orderBy("t.id")),
    q.all(k.selectFrom(k.selectFrom("main.conversation_turns as t").select((eb) => ["t.repo", "t.number", "t.block", eb.fn.agg<number>("row_number").over((o) => o.partitionBy(["t.repo", "t.number"])
      .orderBy(eb.case().when("t.seq", "is", null).then(1).else(0).end(), "desc")
      .orderBy(eb.case().when(eb(eb.fn.coalesce("t.status", eb.val("")), "=", "held")).then(1).else(0).end(), "desc")
      .orderBy("t.seq", "desc").orderBy("t.id", "desc")).as("rn")])
      .where(kx.refIn(db, "t", keys)).where("t.kind", "in", [...PERSON]).where((eb) => kx.like(db, "t.block", eb.val("%<steps>%"))).as("w"))
      .select(["w.repo", "w.number", "w.block"]).where("w.rn", "=", 1)),
  ]));
  for (const r of maxes) out.get(keyOf(r.repo, Number(r.number)))!.maxSeq = Number(r.max_seq ?? 0);
  for (const r of open) {
    const t = out.get(keyOf(r.repo, Number(r.number)))!;
    const turn = turnOf(r) as unknown as TurnRow;
    if (turn.status === "held") t.heldIds.push(turn.id);
    else if ((PERSON as readonly string[]).includes(turn.kind)) t.waiting = turn;
  }
  for (const r of newest) out.get(keyOf(r.repo, Number(r.number)))!.lastPersonBlock = r.block;
  return out;
}

/** Operator and maintainer turns waiting for an answer, oldest first: queued, or claimed by a run that went stale. */
export async function loadPending(db: Db, o: { now: Date; staleMs: number }): Promise<PendingTurn[]> {
  const stale = new Date(o.now.getTime() - o.staleMs).toISOString();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.conversation_turns as t").select(["t.repo", "t.number", "t.id", "t.kind", "t.login"]).where("t.kind", "in", [...PERSON])
    .where((eb) => eb.or([eb("t.status", "=", "pending"), eb.and([eb("t.status", "=", "answering"), eb("t.claimed_at", "<", stale)])])).orderBy("t.id"));
  return rows.map((r) => ({ repo: r.repo, number: Number(r.number), turnId: Number(r.id), kind: r.kind as PendingTurn["kind"], login: r.login }));
}

/** Operator and maintainer turns by `at`, `id`. */
export async function loadGuidanceTurns(db: Db, refs: RefKey[]): Promise<Map<RefKey, GuidanceTurn[]>> {
  const out = new Map<RefKey, GuidanceTurn[]>();
  const keys = refsOf(refs);
  if (!keys.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.conversation_turns as t").select(["t.repo", "t.number", "t.kind", "t.login", "t.at", "t.body"]).where(kx.refIn(db, "t", keys)).where("t.kind", "in", [...PERSON]).orderBy("t.at").orderBy("t.id"));
  for (const r of rows) {
    const k = keyOf(r.repo, Number(r.number));
    (out.get(k) ?? out.set(k, []).get(k)!).push({ kind: r.kind as TurnKind, login: r.login, at: r.at, body: r.body });
  }
  return out;
}

/** For the activity feed and the item trace: newest first; `since` and `before` bound `at` (inclusive). */
export async function loadTurnEvents(db: Db, f: { refs?: RefKey[]; since?: string; before?: string; kinds?: TurnKind[]; limit?: number }): Promise<TurnEvent[]> {
  if (f.refs && !f.refs.length) return [];
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.conversation_turns as t").select(["t.id", "t.repo", "t.number", "t.kind", "t.login", "t.at", (eb) => eb.fn<number>("length", ["t.body"]).as("len"), "t.status"])
    .$if(!!f.refs, (b) => b.where(kx.refIn(db, "t", f.refs!)))
    .$if(!!f.since, (b) => b.where("t.at", ">=", f.since!))
    .$if(!!f.before, (b) => b.where("t.at", "<=", f.before!))
    .$if(!!f.kinds, (b) => b.where(kx.inList(db, "t.kind", f.kinds!)))
    .orderBy("t.at", "desc").orderBy("t.id", "desc").$if(f.limit !== undefined, (b) => b.limit(f.limit!)));
  return rows.map((r) => ({ id: Number(r.id), repo: r.repo, number: Number(r.number), kind: r.kind as TurnKind, login: r.login, at: r.at, len: Number(r.len), status: r.status }));
}

/** Count, newest id and the states in id order, per item: the trace signature. */
export async function loadTurnDigests(db: Db, refs: RefKey[]): Promise<Map<RefKey, TurnDigest>> {
  const out = new Map<RefKey, TurnDigest>();
  const keys = refsOf(refs);
  if (!keys.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.conversation_turns as t").select((eb) => ["t.repo", "t.number", eb.fn.countAll<number>().as("n"), eb.fn.max<number>("t.id").as("newest"),
    kx.groupConcat(db, eb.fn.coalesce("t.status", eb.val("")), ",", "t.id").as("states")]).where(kx.refIn(db, "t", keys)).groupBy(["t.repo", "t.number"]));
  for (const r of rows) out.set(keyOf(r.repo, Number(r.number)), { n: Number(r.n), newest: Number(r.newest), states: r.states ?? "" });
  return out;
}

/** `on conflict do nothing returning`; returns the refs created. 1 statement per 500 rows. */
export async function saveConversations(db: Db, rows: NewConversation[]): Promise<Set<RefKey>> {
  const made = new Set<RefKey>();
  if (!rows.length) return made;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(rows)) {
      const at = new Date().toISOString();
      const got = await q.all(q.k.insertInto("main.conversations").values(part.map((r) => ({ repo: r.repo, number: r.number, item_block: r.item_block, item_sig: r.item_sig, created_at: r.created_at ?? at, created_by: r.created_by })))
        .onConflict((oc) => oc.doNothing()).returning(["repo", "number"]));
      for (const r of got) made.add(keyOf(r.repo, Number(r.number)));
    }
  });
  return made;
}

type Row = { repo: string; number: number; kind: string; login: string; at: string; body: string; block: string; status: string | null; notes: string | null; seq: number | null; cards: NewCard[]; seen: string | null; cardState: "proposed" | "replaced" };

/** The head and newest comment Opus had been told about (the conversation's item snapshot), recorded on each card it proposes. */
const seenOf = (c: { item_sig: string } | undefined): string | null => {
  try {
    const s = c ? JSON.parse(c.item_sig) as { head?: string | null; last_comment?: string | null } | null : null;
    return s && typeof s === "object" ? JSON.stringify({ head: s.head ?? null, last_comment: s.last_comment ?? null }) : null;
  } catch { return null; }
};

/** Inserts the rows in order, replaces the proposals of items that get an `opus` row, then inserts the cards. Inside a write. */
async function insertRows(db: Db, rows: Row[]): Promise<number[]> {
  const q = queryDb(db);
  const ids: number[] = [];
  // Each turn names its item's main conversation in the chat.
  const convs = await ensureMainConversations(db, rows.map((r) => ({ repo: r.repo, number: r.number, by: r.login, at: r.at })));
  for (const part of kx.batches(rows)) {
    const got = await q.all(q.k.insertInto("main.conversation_turns").values(part.map((r) => ({ repo: r.repo, number: r.number, kind: r.kind, login: r.login, at: r.at, body: r.body, block: r.block, status: r.status, error: null, notes: r.notes, seq: r.seq, conversation_id: convs.get(keyOf(r.repo, r.number)) ?? null }))).returning("id"));
    ids.push(...got.map((g) => Number(g.id)).sort((a, b) => a - b));
  }
  const opus = [...new Set(rows.filter((r) => r.kind === "opus").map((r) => keyOf(r.repo, r.number)))];
  if (opus.length) await q.run(q.k.updateTable("main.conversation_cards").set({ state: "replaced" }).where("state", "=", "proposed").where(kx.refIn(db, "main.conversation_cards", opus)));
  const cards = rows.flatMap((r, i) => r.cards.map((c) => ({ turn_id: ids[i]!, repo: r.repo, number: r.number, kind: c.kind, params: c.params, text: c.text, description: c.description, seen: r.seen, state: r.cardState })));
  for (const part of kx.batches(cards)) await q.run(q.k.insertInto("main.conversation_cards").values(part));
  return ids;
}

/**
 * Appends turns to their items as `appendTurn` did, in input order: a message with status `pending` waits (no seq; one per item, else 409);
 * while a run is answering a message, other turns are held without a seq; every other turn takes the next seq. An `opus` turn replaces the
 * item's proposed cards, so only the last `opus` turn of an item in the batch keeps its cards proposed. A turn marked `onlyIfThread` is
 * skipped (its id is null) when the item has no conversation. At most 7 statements whatever the number of turns (2 for the chat conversations).
 */
export async function addTurns(db: Db, turns: NewTurn[], deps?: { now?: () => Date }): Promise<(number | null)[]> {
  if (!turns.length) return [];
  return await db.write(async () => {
    const refs = refsOf(turns.map((t) => t.ref));
    const needConv = turns.some((t) => t.onlyIfThread || t.cards?.length);
    const [tails, convs] = await db.together(() => Promise.all([loadTurnTails(db, refs), needConv ? loadConversations(db, refs) : Promise.resolve(new Map<RefKey, ConversationRow>())]));
    const state = new Map([...tails].map(([k, t]) => [k, { max: t.maxSeq, wait: t.waiting?.status ?? null }]));
    const keep = turns.map((t) => !t.onlyIfThread || convs.has(t.ref));
    const lastOpus = new Map<RefKey, number>();
    turns.forEach((t, i) => { if (keep[i] && t.kind === "opus") lastOpus.set(t.ref, i); });
    const rows: Row[] = [];
    turns.forEach((t, i) => {
      if (!keep[i]) return;
      const s = state.get(t.ref)!;
      let seq: number | null, status: string | null;
      if (t.status === "pending") {
        if (s.wait) throw new ConversationError(409, BUSY);
        s.wait = "pending";
        seq = null; status = "pending";
      } else if (s.wait === "answering") { seq = null; status = "held"; }
      else { seq = ++s.max; status = t.status ?? null; }
      const [repo, number] = splitRef(t.ref);
      rows.push({ repo, number, kind: t.kind, login: t.login, at: (deps?.now?.() ?? new Date()).toISOString(), body: t.body, block: t.block, status, notes: t.notes ?? null, seq, cards: t.cards ?? [],
        seen: seenOf(convs.get(t.ref)), cardState: (lastOpus.get(t.ref) ?? i) > i ? "replaced" : "proposed" });
    });
    const ids = await insertRows(db, rows);
    let n = 0;
    return keep.map((k) => (k ? ids[n++]! : null));
  });
}

/** Compare-and-set of the stored item signature; true when this call moved it. */
async function casSig(db: Db, ref: RefKey, expectSig: string, sig: string): Promise<boolean> {
  const [repo, number] = splitRef(ref);
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("main.conversations").set({ item_sig: sig }).where("repo", "=", repo).where("number", "=", number).where("item_sig", "=", expectSig))).changes) === 1;
}

const isUnique = (e: unknown): boolean => /UNIQUE|unique constraint|duplicate key/i.test(String((e as Error)?.message ?? e));

/**
 * One transaction: creates the conversation if absent, appends the refresh turn when `item_sig` still equals `expectSig` (and moves it),
 * appends the person's message as pending when `ask`. Returns the message's turn id.
 */
export async function postMessage(db: Db, p: PostMessage): Promise<number> {
  try {
    return await db.write(async () => {
      if (p.newConversation) await saveConversations(db, [p.newConversation]);
      const turns: NewTurn[] = [];
      if (p.refresh && await casSig(db, p.ref, p.refresh.expectSig, p.refresh.sig)) turns.push(p.refresh.turn);
      turns.push({ ...p.turn, ...(p.ask && { status: "pending" }) });
      const ids = await addTurns(db, turns);
      const id = ids[ids.length - 1]!;
      if (p.linked) await p.linked(id);
      return id;
    });
  } catch (e) {
    if (isUnique(e)) throw new ConversationError(409, BUSY);
    throw e;
  }
}

/** The Conversation step's refresh before a claim: moves `item_sig` and appends the update turn only when the signature still equals `expectSig`. */
export async function refreshSig(db: Db, ref: RefKey, p: { expectSig: string; sig: string; turn: NewTurn }): Promise<boolean> {
  return await db.write(async () => {
    if (!await casSig(db, ref, p.expectSig, p.sig)) return false;
    await addTurns(db, [p.turn]);
    return true;
  });
}

/**
 * Releases a stale claim, gives turns held by a dead run a seq (in id order) when no run is answering, then claims the pending message
 * and returns it. At most 4 statements.
 */
export async function claimTurn(db: Db, ref: RefKey, o: { now: Date; staleMs: number }): Promise<{ turn: TurnRow; claim: string } | null> {
  const [repo, number] = splitRef(ref);
  const at = o.now.toISOString();
  const stale = new Date(o.now.getTime() - o.staleMs).toISOString();
  const q = queryDb(db);
  return await db.write(async () => {
    await q.run(q.k.updateTable("main.conversation_turns").set({ status: "pending", claim: null, claimed_at: null, progress: null })
      .where("repo", "=", repo).where("number", "=", number).where("kind", "in", [...PERSON]).where("status", "=", "answering").where("claimed_at", "<", stale));
    const open = await q.all(q.k.selectFrom("main.conversation_turns as t").select(["t.id", "t.status", (eb) => eb.selectFrom("main.conversation_turns as m").select((e) => e.fn.coalesce(e.fn.max("m.seq"), e.lit(0)).as("s"))
      .whereRef("m.repo", "=", "t.repo").whereRef("m.number", "=", "t.number").as("max_seq")]).where("t.repo", "=", repo).where("t.number", "=", number).where("t.status", "in", ["answering", "held"]).orderBy("t.id"));
    const held = open.filter((r) => r.status === "held");
    if (held.length && open.length === held.length) {
      const base = Number(held[0]!.max_seq);
      await kx.updateFrom(db, "main.conversation_turns", ["id"], held.map((h, i) => ({ id: Number(h.id), status: null, seq: base + i + 1 })), ["status", "seq"]);
    }
    const claim = randomUUID();
    const row = await q.get(q.k.updateTable("main.conversation_turns").set({ status: "answering", claim, claimed_at: at })
      .where("repo", "=", repo).where("number", "=", number).where("kind", "in", [...PERSON]).where("status", "=", "pending")
      .returning(kx.cols("main.conversation_turns")));
    return row ? { turn: turnOf(row) as unknown as TurnRow, claim } : null;
  });
}

/** Writes progress lines for the run that holds the claim. */
export async function setProgress(db: Db, ref: RefKey, claim: string, lines: string[]): Promise<void> {
  const [repo, number] = splitRef(ref);
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.conversation_turns").set({ progress: JSON.stringify(lines) }).where("repo", "=", repo).where("number", "=", number).where("status", "=", "answering").where("claim", "=", claim));
}

/** Returns a claimed turn to pending. */
export async function releaseTurn(db: Db, ref: RefKey, claim: string): Promise<boolean> {
  const [repo, number] = splitRef(ref);
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("main.conversation_turns").set({ status: "pending", claim: null, claimed_at: null, progress: null })
    .where("repo", "=", repo).where("number", "=", number).where("status", "=", "answering").where("claim", "=", claim))).changes) === 1;
}

/**
 * Settles the waiting turn that `match` picks and gives it the next seq in the same statement; returns that seq, or null when no row
 * matched. Held turns follow in `unhold`, after anything the caller inserts in between.
 */
async function settle(db: Db, repo: string, number: number, status: string, error: string | null, match: (b: any) => any): Promise<number | null> {
  const q = queryDb(db);
  const upd = q.k.updateTable("main.conversation_turns").set((eb) => ({
    status, error, claim: null, progress: null,
    seq: eb.selectFrom("main.conversation_turns as m").select((e) => e(e.fn.coalesce(e.fn.max("m.seq"), e.lit(0)), "+", 1).as("s")).where("m.repo", "=", repo).where("m.number", "=", number),
  })).where("repo", "=", repo).where("number", "=", number);
  const row = await q.get(match(upd).returning("seq") as ReturnType<typeof upd.returning>) as { seq: number } | undefined;
  return row ? Number(row.seq) : null;
}

/** Turns held while the message was answered take the seqs from `from` on, in the order they arrived. 2 statements. */
async function unhold(db: Db, repo: string, number: number, from: number): Promise<void> {
  const q = queryDb(db);
  const held = await q.all(q.k.selectFrom("main.conversation_turns").select("id").where("repo", "=", repo).where("number", "=", number).where("status", "=", "held").orderBy("id"));
  if (held.length) await kx.updateFrom(db, "main.conversation_turns", ["id"], held.map((h, i) => ({ id: Number(h.id), status: null, seq: from + i })), ["status", "seq"]);
}

/** Settles a claimed turn as failed (the message gets its place, held turns follow). False when the run no longer holds it. 3 statements. */
export async function failTurn(db: Db, ref: RefKey, claim: string, error: string): Promise<boolean> {
  const [repo, number] = splitRef(ref);
  return await db.write(async () => {
    const seq = await settle(db, repo, number, "failed", error.slice(0, 300), (b) => b.where("status", "=", "answering").where("claim", "=", claim));
    if (seq === null) return false;
    await unhold(db, repo, number, seq + 1);
    return true;
  });
}

/**
 * Settles the claimed message as answered and inserts Opus's reply with its cards right after it; turns held meanwhile follow the reply.
 * Returns the reply's turn id, or null when the run no longer holds the message. `seen` stamps the cards. At most 6 statements.
 */
export async function storeReply(db: Db, ref: RefKey, claim: string, reply: { turn: NewTurn; seen: string | null }): Promise<number | null> {
  const [repo, number] = splitRef(ref);
  return await db.write(async () => {
    const seq = await settle(db, repo, number, "answered", null, (b) => b.where("status", "=", "answering").where("claim", "=", claim));
    if (seq === null) return null;
    const t = reply.turn;
    const [id] = await insertRows(db, [{ repo, number, kind: t.kind, login: t.login, at: new Date().toISOString(), body: t.body, block: t.block, status: null, notes: t.notes ?? null, seq: seq + 1, cards: t.cards ?? [], seen: reply.seen, cardState: "proposed" }]);
    await unhold(db, repo, number, seq + 2);
    return id!;
  });
}

/**
 * Withdraws the maintainer's message that waits for Opus, queued or being answered: it ends as failed, naming who withdrew it, and the
 * item takes messages again. The writer's queued or leased model calls for the item are withdrawn too. `by`: an operator, or the maintainer who wrote it.
 * Returns the withdrawn turn's id.
 */
export async function withdrawTurn(db: Db, ref: RefKey, by: { login: string; operator: boolean }): Promise<number> {
  const [repo, number] = splitRef(ref);
  const q = queryDb(db);
  return await db.write(async () => {
    const wait = await q.get(q.k.selectFrom("main.conversation_turns").select(["id", "kind", "login"]).where("repo", "=", repo).where("number", "=", number).where("kind", "in", [...PERSON]).where("status", "in", [...WAITING]));
    if (!wait || wait.kind !== "maintainer") throw new ConversationError(409, "no maintainer's message waits for Opus here");
    if (!by.operator && wait.login.toLowerCase() !== by.login.toLowerCase()) throw new ConversationError(403, "only an operator, or the person who wrote it, withdraws a message");
    const why = `withdrawn by ${by.login}`;
    const seq = await settle(db, repo, number, "failed", why, (b) => b.where("id", "=", Number(wait.id)).where("status", "in", [...WAITING]));
    if (seq !== null) await unhold(db, repo, number, seq + 1);
    await withdrawTurnCalls(db, { ref, forLogin: wait.login, reason: why });
    return Number(wait.id);
  });
}

/** How many questions `login` put to Opus (operator and maintainer turns) after `since`. */
export async function countAskedTurns(db: Db, login: string, since: string): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.conversation_turns").select((eb) => eb.fn.countAll().as("n"))
    .where("login", "=", login).where("kind", "in", ["operator", "maintainer"]).where("at", ">", since));
  return Number(r?.n ?? 0);
}
