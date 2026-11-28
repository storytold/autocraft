// Conversation text: the item block (written once), the blocks of the turns, and what changed in the item since. Storage is the
// conversations data module. Every turn stores the exact text its prompt block carries, so later prompts repeat earlier ones byte for byte.
import { createHash } from "node:crypto";
import { isBotLogin } from "../review/bots.ts";
import * as store from "../data/conversations/index.ts";
import { ConversationError, loadConversations, loadPending, loadThreads, loadTurnTails, type ConversationRow, type Thread, type ThreadTurn, type TurnRow, type TurnTail } from "../data/conversations/index.ts";
import { freshConfig } from "../data/control/index.ts";
import { loadCommentHeads, loadItems, loadNewerComments, loadSpokenComments, newerKey, type CommentHead, type ItemOf } from "../data/mirror/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { listWorkflows } from "../data/workflow/index.ts";
import { CLAUDE_PROMPTS, untrustedJson } from "../prompts/index.ts";
import type { ItemWorkflow } from "../workflow/types.ts";
import { applicableSteps, itemLabels, replyForm, storedCard, type NewCard } from "./cards.ts";
import { ITEM_BODY_LIMIT, ITEM_COMMENT_LIMIT, ITEM_COMMENTS, ITEM_DIFF_LIMIT, MESSAGE_MAX, type PersonKind, type TurnKind } from "./types.ts";
import type { Db } from "../db/index.ts";

export { ConversationError };
export type { ConversationRow, TurnRow };

/** The pull request diff for the item block, or null (an issue, an unavailable or oversized diff). Injected: the default asks GitHub. */
export type DiffSource = (repo: string, number: number, head: string) => Promise<string | null>;
export type StoreDeps = { diff?: DiffSource; now?: () => Date };

const refOf = (repo: string, n: number): string => `${repo}#${n}`;
const nowOf = (d?: StoreDeps): Date => d?.now?.() ?? new Date();

export const conversationOf = async (db: Db, repo: string, n: number): Promise<ConversationRow | undefined> => (await loadConversations(db, [refOf(repo, n)])).get(refOf(repo, n));

/** All turns in display order: the prompt order, then the message Opus is answering, then turns held until its reply. */
export const turnsOf = async (db: Db, repo: string, n: number): Promise<TurnRow[]> =>
  ((await loadThreads(db, [refOf(repo, n)], { blocks: true })).get(refOf(repo, n))?.turns ?? []).map((t) => ({ ...t, block: t.block ?? "" }));

/** The person's message that waits for its reply: queued or claimed by a run. */
export const pendingTurn = async (db: Db, repo: string, n: number): Promise<TurnRow | undefined> =>
  (await loadTurnTails(db, [refOf(repo, n)])).get(refOf(repo, n))?.waiting ?? undefined;

/** A claim older than this is released: a run makes `attempts` calls of at most the prompt timeout each. */
const STALE_CLAIM_MS = (CLAUDE_PROMPTS["conversation.turn"].limits.timeoutSeconds * CLAUDE_PROMPTS["conversation.turn"].limits.attempts + 60) * 1000;

// ---- blocks ------------------------------------------------------------------

/** Text of people and Opus must not close or open the frame the prompt puts around turns. */
const frameSafe = (t: string): string => t.replace(/<(\/?)(turn|item|actions|choices|cores|untrusted|included|steps)\b/gi, "&lt;$1$2");

const attr = (v: string): string => v.replace(/[^\w.:-]/g, "");

/** A person's turn, framed as from an operator or a maintainer. `steps`: the step kinds that apply now, when they differ from what Opus last saw. */
export function personBlock(from: PersonKind, login: string, text: string, steps?: string[]): string {
  return `<turn from="${from}" login="${attr(login)}">\n${frameSafe(text)}\n${steps ? `<steps>${JSON.stringify(steps)}</steps>\n` : ""}</turn>\n`;
}

/** The steps list Opus last saw: the newest `<steps>` line of the stored turns, else the item block's. */
function seenSteps(lastPersonBlock: string | null, itemBlock: string): string[] | null {
  const parse = (j: string): string[] | null => { try { const v = JSON.parse(j) as unknown; return Array.isArray(v) ? v.map(String) : null; } catch { return null; } };
  const m = /\n<steps>(\[[^\n]*\])<\/steps>\n<\/turn>\n$/.exec(lastPersonBlock ?? "") ?? /"steps": (\[[^\]]*\])/.exec(itemBlock);
  return m ? parse(m[1]!) : null;
}

export function opusBlock(text: string, cards: NewCard[]): string {
  return `<turn from="opus">\n${frameSafe(text)}\n${cards.length ? `<actions>\n${JSON.stringify(cards.map(replyForm))}\n</actions>\n` : ""}</turn>\n`;
}

/** A turn from our code: a plain sentence and, when GitHub text is quoted, that data as untrusted JSON. */
export function systemBlock(text: string, data?: unknown): string {
  return `<turn from="system">\n${text}\n${data === undefined ? "" : `<untrusted>\n${untrustedJson(data)}\n</untrusted>\n`}</turn>\n`;
}

// ---- the item ----------------------------------------------------------------

type ItemRow = ItemOf<"text">;
/** What the blocks read of an item. `conversation` and `tail`: the thread as stored. */
type ItemState = {
  slugs: string[];
  item: ItemRow | undefined;
  comments: CommentHead | undefined;
  workflow: ItemWorkflow | null;
  steps: string[];
  conversation: ConversationRow | undefined;
  tail: TurnTail | undefined;
};

/** The app's bot (the mirror stores its bare slug) is the pipeline itself: its posts are no news for the conversation. */
const ownSlugs = async (db: Db): Promise<string[]> => (await freshConfig(db, ["app_slugs"])).appSlugs;

async function loadState(db: Db, repo: string, n: number): Promise<ItemState> {
  const key = refOf(repo, n), at = { repo, number: n };
  const slugs = await ownSlugs(db);
  const [items, heads, quiet, live, convs, tails] = await db.together(() => Promise.all([
    loadItems(db, [at], "text"), loadCommentHeads(db, [at], { not: slugs }), loadQuiet(db, [key]), listWorkflows(db, { live: true, refs: [at] }), loadConversations(db, [key]), loadTurnTails(db, [key]),
  ]));
  const item = items.get(key), workflow = live.at(-1) ?? null;
  return {
    slugs, item, comments: heads.get(key), workflow, conversation: convs.get(key), tail: tails.get(key),
    steps: applicableSteps({ item: item ? { kind: item.kind, state: item.state, author: item.author, labels: itemLabels(item) } : null, quiet: quiet.size > 0 }),
  };
}

const hash = (v: unknown, n = 16): string => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, n);

/** What a block or update turn described of the item; a change in any field sends an update turn. `flow` and `rec`: the live workflow's state and when its recommendation was written. */
type Snapshot = { head: string | null; title: string; body: string; state: string; labels: string[]; comments: number; last_comment: string | null; flow: string | null; rec: string | null };

const snapshotOf = (s: ItemState, i: ItemRow): Snapshot => ({
  head: i.head_oid, title: hash(i.title), body: hash(i.body), state: i.state, labels: itemLabels(i).sort(), comments: s.comments?.n ?? 0, last_comment: s.comments?.last ?? null,
  flow: s.workflow?.state ?? null, rec: s.workflow?.recAt ?? null,
});

const parseSig = (sig: string): Snapshot | null => {
  try { const v = JSON.parse(sig) as Snapshot; return v && typeof v === "object" ? { ...v, flow: v.flow ?? null, rec: v.rec ?? null } : null; } catch { return null; }
};

/** The head and newest comment Opus had been told about (the conversation's item snapshot), recorded on each card it proposes. */
const seenOf = (c: ConversationRow): string | null => {
  const s = parseSig(c.item_sig);
  return s ? JSON.stringify({ head: s.head ?? null, last_comment: s.last_comment ?? null }) : null;
};

const parseSeen = (seen: string | null): { head: string | null; last_comment: string | null } | null => {
  try { const v = JSON.parse(seen ?? "null") as { head?: string | null; last_comment?: string | null } | null; return v && typeof v === "object" ? { head: v.head ?? null, last_comment: v.last_comment ?? null } : null; } catch { return null; }
};

/** The head a card was written for. */
export const seenHead = (seen: string | null): string | null => parseSeen(seen)?.head ?? null;

/** Whether the PR was pushed to since the card was written. */
export const prChanged = (i: { kind: string; head_oid: string | null }, seen: string | null): boolean => {
  const was = parseSeen(seen);
  return i.kind === "pr" && was !== null && was.head !== i.head_oid;
};

export type Stale = "pr-changed" | "new-comments" | undefined;

/**
 * Whether each card still proposed was written for an older item: a push since (it refuses to run if it rests on the code) or new GitHub comments since (it still
 * runs). Stricter than the snapshot, which also drives update turns: review bots and our own posts (made through an account a person
 * also uses, so recognised by their note line, never by login) are news for Opus but do not make a card stale. When the seen comment is
 * gone, any change in the newest counted comment counts. By card id.
 */
export async function loadStale(db: Db, cards: { id: number; repo: string; number: number; seen: string | null }[]): Promise<Map<number, Stale>> {
  const out = new Map<number, Stale>();
  if (!cards.length) return out;
  const refs = [...new Map(cards.map((c) => [refOf(c.repo, c.number), { repo: c.repo, number: c.number }])).values()];
  const slugs = await ownSlugs(db);
  const [items, heads] = await db.together(() => Promise.all([loadItems(db, refs, "pr"), loadCommentHeads(db, refs, { not: slugs })]));
  const ask: { id: number; repo: string; number: number; after: string | null }[] = [];
  for (const c of cards) {
    const i = items.get(refOf(c.repo, c.number)), was = parseSeen(c.seen);
    if (!i || !was) continue;
    if (prChanged(i, c.seen)) out.set(c.id, "pr-changed");
    else if (was.last_comment !== (heads.get(refOf(c.repo, c.number))?.last ?? null)) ask.push({ id: c.id, repo: c.repo, number: c.number, after: was.last_comment });
  }
  const newer = await loadNewerComments(db, ask, { not: slugs });
  for (const a of ask) {
    const rows = newer.get(newerKey(a));
    if (rows === null || rows?.some((r) => !(r.author && isBotLogin(r.author)) && !OWN_NOTE_PREFIXES.some((p) => r.body.trimStart().startsWith(p)))) out.set(a.id, "new-comments");
  }
  return out;
}

// Openings of the note lines in src/github/note.ts.
export const OWN_NOTE_PREFIXES = ["_AI-generated ", "_Automated "];

const cut = (s: string | null, max: number): string => (s ?? "").slice(0, max);

const workflowPart = (w: ItemWorkflow | null): unknown => (w ? {
  entry: w.entry, state: w.state, started_by: w.startedBy, merge_approved: w.approvedBy !== null, blocker: w.blocker, recommendation: w.rec?.text ?? null,
  parts: w.plan.map((p) => ({ n: p.n, title: p.title, state: p.state, ...(p.file && { file: p.file }) })),
} : null);

async function diffPart(i: ItemRow, deps?: StoreDeps): Promise<{ head: string | null; lines: unknown; diff: string | null }> {
  const diff = i.head_oid && deps?.diff ? await deps.diff(i.repo, i.number, i.head_oid).catch(() => null) : null;
  return { head: i.head_oid, lines: { additions: i.additions, deletions: i.deletions, files: i.changed_files }, diff: diff === null ? null : cut(diff, ITEM_DIFF_LIMIT) + (diff.length > ITEM_DIFF_LIMIT ? "\n[diff cut]" : "") };
}

/** The item block: everything about the item the conversation starts from, as untrusted JSON. Written once. */
async function itemBlock(db: Db, s: ItemState, i: ItemRow, deps?: StoreDeps): Promise<{ block: string; sig: string }> {
  const pr = i.kind === "pr";
  const comments = await loadSpokenComments(db, i, { order: "first", limit: ITEM_COMMENTS, not: s.slugs });
  const data = {
    ref: refOf(i.repo, i.number), kind: pr ? "pull request" : "issue", state: i.state, title: i.title ?? "", body: cut(i.body, ITEM_BODY_LIMIT),
    author: i.author, author_association: i.author_association, labels: itemLabels(i),
    comments: comments.map((c) => ({ author: c.author, body: cut(c.body, ITEM_COMMENT_LIMIT) })),
    ...(pr ? await diffPart(i, deps) : {}),
    workflow: workflowPart(s.workflow),
    steps: s.steps,
  };
  return { block: untrustedJson(data), sig: JSON.stringify(snapshotOf(s, i)) };
}

const notInMirror = (repo: string, n: number) => new ConversationError(404, `no item ${repo}#${n} in the mirror`);

export async function buildItemBlock(db: Db, repo: string, n: number, deps?: StoreDeps): Promise<{ block: string; sig: string }> {
  const s = await loadState(db, repo, n);
  if (!s.item) throw notInMirror(repo, n);
  return await itemBlock(db, s, s.item, deps);
}

/** Creates the conversation with its item block when the item has none. Returns whether it was created. */
export async function ensureConversation(db: Db, repo: string, n: number, by: string, deps?: StoreDeps): Promise<boolean> {
  if (await conversationOf(db, repo, n)) return false;
  const { block, sig } = await buildItemBlock(db, repo, n, deps);
  return (await store.saveConversations(db, [{ repo, number: n, item_block: block, item_sig: sig, created_by: by, created_at: nowOf(deps).toISOString() }])).size > 0;
}

// ---- turns -------------------------------------------------------------------

type NewTurn = { kind: TurnKind; login: string; body: string; block: string; status?: string; notes?: string[]; cards?: NewCard[] };

const storedTurn = (repo: string, n: number, t: NewTurn): store.NewTurn => ({
  ref: refOf(repo, n), kind: t.kind, login: t.login, body: t.body, block: t.block, ...(t.status && { status: t.status }),
  ...(t.notes?.length && { notes: JSON.stringify(t.notes) }), ...(t.cards?.length && { cards: t.cards.map(storedCard) }),
});

/**
 * Appends a turn. It takes the next place in the prompt order; while a run is answering the message it is held and placed after the reply
 * (the run already sent the prompt without it). Returns the turn id.
 */
export async function insertTurn(db: Db, repo: string, n: number, t: NewTurn, deps?: StoreDeps): Promise<number> {
  return (await store.addTurns(db, [storedTurn(repo, n, t)], deps))[0]!;
}

const NOTHING: Snapshot = { head: null, title: "", body: "", state: "", labels: [], comments: -1, last_comment: null, flow: null, rec: null };

type Refresh = NonNullable<store.PostMessage["refresh"]>;

/** The update turn for what changed in the item since the stored block or the last update turn described it, or null. The block itself is never rewritten. */
async function updateTurn(db: Db, s: ItemState, deps?: StoreDeps): Promise<Refresh | null> {
  const c = s.conversation, i = s.item;
  if (!c || !i) return null;
  const now = snapshotOf(s, i), was = parseSig(c.item_sig) ?? NOTHING;
  const pr = i.kind === "pr";
  const changed: string[] = [];
  const data: Record<string, unknown> = {};
  if (pr && was.head !== now.head) { changed.push("head commit"); Object.assign(data, await diffPart(i, deps)); }
  if (was.title !== now.title) { changed.push("title"); data.title = i.title ?? ""; }
  if (was.body !== now.body) { changed.push("text"); data.body = cut(i.body, ITEM_BODY_LIMIT); }
  if (was.state !== now.state) { changed.push("state"); data.state = i.state; }
  if (JSON.stringify(was.labels) !== JSON.stringify(now.labels)) { changed.push("labels"); data.labels = itemLabels(i); }
  if (was.comments !== now.comments || was.last_comment !== now.last_comment) {
    changed.push("comments");
    const rows = await loadSpokenComments(db, i, { order: "last", limit: 3, not: s.slugs });
    data.comments = { total: now.comments, newest: rows.reverse().map((r) => ({ author: r.author, body: cut(r.body, ITEM_COMMENT_LIMIT) })) };
  }
  if (was.flow !== now.flow || was.rec !== now.rec) { changed.push("workflow"); data.workflow = workflowPart(s.workflow); }
  if (!changed.length) return null;
  const text = `The ${pr ? "PR" : "issue"} was updated (${changed.join(", ")}). The current values of these fields follow; they replace the item block where they differ.`;
  return { expectSig: c.item_sig, sig: JSON.stringify(now), turn: storedTurn(i.repo, i.number, { kind: "system", login: UPDATE_LOGIN, body: text, block: systemBlock(text, data) }) };
}

/** The login of a system turn that says what changed in the item (updateTurn), apart from card results and follow-up lines. */
export const UPDATE_LOGIN = "item-update";

/** Adds a system turn carrying what changed in the item (see updateTurn). False when nothing changed, or another run wrote the same update. */
export async function refreshItem(db: Db, repo: string, n: number, deps?: StoreDeps): Promise<boolean> {
  const u = await updateTurn(db, await loadState(db, repo, n), deps);
  return u !== null && await store.refreshSig(db, refOf(repo, n), u);
}

/**
 * A person's message (`by.kind`: an operator's or a maintainer's): creates the conversation when the item has none and queues
 * the message for the Conversation step, which answers a maintainer's on the maintainer's own Task Runner. With `ask` false the
 * message is only stored (no pending state, no model call); Opus sees it among the turns at the next ask. `linked` runs in the same
 * transaction once the turn exists (see PostMessage).
 */
export async function addMessage(db: Db, repo: string, n: number, by: { login: string; kind: PersonKind }, text: string, deps?: StoreDeps, ask = true, linked?: (turnId: number) => Promise<void>): Promise<number> {
  const body = text.trim();
  if (!body) throw new ConversationError(400, "the message is empty");
  if (body.length > MESSAGE_MAX) throw new ConversationError(400, `the message is longer than ${MESSAGE_MAX} characters`);
  const s = await loadState(db, repo, n);
  if (!s.item) throw notInMirror(repo, n);
  if (ask && s.tail?.waiting) throw new ConversationError(409, "Opus has not answered the last message yet");
  const fresh = s.conversation ? null : await itemBlock(db, s, s.item, deps);
  const refresh = await updateTurn(db, s, deps);
  const seen = seenSteps(s.tail?.lastPersonBlock ?? null, s.conversation?.item_block ?? fresh!.block);
  const steps = seen && JSON.stringify(seen) === JSON.stringify(s.steps) ? undefined : s.steps;
  return await store.postMessage(db, {
    ref: refOf(repo, n), by, ask, turn: storedTurn(repo, n, { kind: by.kind, login: by.login, body, block: personBlock(by.kind, by.login, body, steps) }),
    ...(fresh && { newConversation: { repo, number: n, item_block: fresh.block, item_sig: fresh.sig, created_by: by.login, created_at: nowOf(deps).toISOString() } }),
    ...(refresh && { refresh }),
    ...(linked && { linked }),
  });
}

/** The message Opus is answering and the token of the run that holds it. */
export type Claim = { turn: TurnRow; claim: string };

/**
 * Takes the queued message of the conversation for one run, or null when none is queued or another run holds it.
 * A claim older than the prompt timeouts is released first, so a crashed run does not block the conversation.
 */
export const claimPending = async (db: Db, repo: string, n: number, deps?: StoreDeps): Promise<Claim | null> =>
  await store.claimTurn(db, refOf(repo, n), { now: nowOf(deps), staleMs: STALE_CLAIM_MS });

/** Stores what Opus is doing on the message the run holds (newest line last); the live topic pushes it. Cleared when the reply or the failure is stored. */
export const setTurnProgress = async (db: Db, repo: string, n: number, claim: string, lines: string[]): Promise<void> =>
  await store.setProgress(db, refOf(repo, n), claim, lines);

/**
 * The pieces of the next prompt: the stored item block and the turns in prompt order, the claimed message last. `alone`: a question whose
 * answer is posted in public (GitHub, Discord) gets none of the chat's earlier turns (messages, replies, card results with their notes,
 * follow-up lines), only the item's update turns (UPDATE_LOGIN).
 */
export async function promptParts(db: Db, repo: string, n: number, wait: TurnRow, o: { alone?: boolean } = {}): Promise<{ item: string; turns: string; earlier: string; message: string; seen: string | null } | null> {
  const t: Thread | undefined = (await loadThreads(db, [refOf(repo, n)], { blocks: true })).get(refOf(repo, n));
  if (!t) return null;
  const earlier = t.turns.filter((x: ThreadTurn) => x.seq !== null && (!o.alone || (x.kind === "system" && x.login === UPDATE_LOGIN))).map((x) => x.block ?? "").join("");
  return { item: t.conversation.item_block, turns: earlier + wait.block, earlier, message: wait.block, seen: seenOf(t.conversation) };
}

/**
 * Stores Opus's reply to the claimed message and marks the message answered, in one transaction. Returns the reply's turn id,
 * or null when the run no longer holds the message (its claim was released and taken by another run). `seen` stamps the cards with what
 * Opus was told when its prompt was built, not with a later refresh.
 */
export const storeReply = async (db: Db, repo: string, n: number, claim: string, text: string, cards: NewCard[], notes: string[], seen: string | null): Promise<number | null> =>
  await store.storeReply(db, refOf(repo, n), claim, { turn: storedTurn(repo, n, { kind: "opus", login: "opus", body: text, block: opusBlock(text, cards), notes, cards }), seen });

/**
 * Withdraws the maintainer's message that waits for Opus, queued or being answered: it ends as failed, naming who withdrew it, the writer's
 * model calls for it go too, and the item takes messages again; a reply that arrives later is not stored. `by`: an operator, or the maintainer who wrote it.
 * Returns the withdrawn turn's id.
 */
export const withdrawTurn = async (db: Db, repo: string, n: number, by: { login: string; operator: boolean }): Promise<number> =>
  await store.withdrawTurn(db, refOf(repo, n), by);

/** Gives the claimed message back: it waits, pending, for a later run. */
export const releaseTurn = async (db: Db, repo: string, n: number, claim: string): Promise<boolean> => await store.releaseTurn(db, refOf(repo, n), claim);

export const failTurn = async (db: Db, repo: string, n: number, claim: string, error: string): Promise<boolean> => await store.failTurn(db, refOf(repo, n), claim, error);

/** Conversations with a message waiting for Opus (queued, or claimed by a run that went stale), oldest message first, with who wrote it. */
export const pendingConversations = async (db: Db, deps?: StoreDeps, kind?: PersonKind): Promise<{ repo: string; number: number; turnId: number; kind: PersonKind; login: string }[]> =>
  (await loadPending(db, { now: nowOf(deps), staleMs: STALE_CLAIM_MS })).filter((t) => !kind || t.kind === kind);
