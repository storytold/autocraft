// A command a person sends is a message in the item's chat (src/data/chat): stored before the command runs, linked to the workflow
// event the command wrote once it has. Every surface that sends commands goes through `saying`; GitHub stores the comment at intake
// and links it when its command ran (`linkComment`). Nothing here may stop a command: a failed write is logged and the command runs.
//
// A message is stored only on items of tracked repos (the owner a text names must be the repo's), and for a person's own words only
// where they may write in the chat (`by`): items in the mirror, in repos they see, as an operator or a maintainer with write access
// (the chat's rule, dash/api/conversations.ts canTalk). A command that ran nothing and wrote no event keeps its reply on its message
// (`payload.refusal`), so the chat shows the answer after a reload.
//
// A command for a list of items is each item's own command: the message on an item the list names holds the command words without
// the list, so no item's chat carries the other items. A GitHub comment is stored as written, as it stands on GitHub.
import * as access from "../data/access/index.ts";
import { linkMessage, linkNewestSaid, loadCommentMessage, recordMessages, setMessageRefusal } from "../data/chat/index.ts";
import type { ChatVia } from "../data/chat/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadLastEventId, loadNewestEventBy } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { ownerOf } from "../owners.ts";
import type { CommandResult } from "./apply.ts";
import { listForm, parse } from "./parse.ts";
import type { ItemRef } from "./types.ts";

/** A stored message and the item it is on. */
export type Said = { id: number; repo: string; number: number };

/**
 * Whose rights decide which items take a person's message: their live write check and, where the surface knows them, their role (read
 * from their access row otherwise) and the repos they see. Null only for text that already stands on the item (a GitHub comment) or
 * comes from the box (the CLI).
 */
export type SaidBy = { canWrite: (repo: string) => Promise<boolean>; role?: string; visible?: (repo: string) => Promise<boolean> } | null;

export type SaidInput = { login: string; via: ChatVia; text: string; items: readonly ItemRef[]; by: SaidBy; payload?: unknown; githubCommentId?: number };

/** The tracked repo an item names (`name` or `owner/name`), or null. */
const trackedName = (tracked: ReadonlyMap<string, unknown>, written: string): string | null => {
  const [owner, name] = written.includes("/") ? written.split("/", 2) as [string, string] : [null, written];
  if (!tracked.has(name)) return null;
  return owner === null || owner.toLowerCase() === ownerOf(name).toLowerCase() ? name : null;
};

/** The items the message may be stored on, each once, by tracked repo name. */
async function storable(db: Db, o: SaidInput): Promise<ItemRef[]> {
  const tracked = await loadTrackedRepos(db);
  const refs = [...new Map(o.items.flatMap((i) => {
    const repo = trackedName(tracked, i.repo);
    return repo ? [[`${repo}#${i.number}`, { repo, number: i.number }] as const] : [];
  })).values()];
  const by = o.by;
  if (!by || !refs.length) return refs;
  const role = by.role ?? (await access.loadAccess(db, [o.login])).get(o.login.toLowerCase())?.role;
  if (role !== "operator" && role !== "maintainer") return [];
  const known = await loadItems(db, refs, "ref");
  const out: ItemRef[] = [];
  for (const r of refs) {
    if (!known.has(`${r.repo}#${r.number}`)) continue;
    if (by.visible && !await by.visible(r.repo).catch(() => false)) continue;
    if (role !== "operator" && !await by.canWrite(r.repo).catch(() => false)) continue;
    out.push(r);
  }
  return out;
}

/** `name#n` or `owner/name#n` in a list names the tracked item `item` (an owner written must be the repo's). */
const names = (i: ItemRef, item: ItemRef): boolean => i.number === item.number && trackedName(new Map([[item.repo, null]]), i.repo) === item.repo;

/**
 * The text as a message on `item`: only the command words before the colon when the text is a list-form command the parser reads, its
 * items are the list (the words name none), and the list names the item. Any other text is stored as written.
 */
function ownBody(text: string, item: ItemRef): string {
  const list = listForm(text, item.repo);
  if (!list?.words) return text;
  const read = parse(text, { repo: item.repo });
  const head = parse(list.words, { repo: item.repo });
  if (read.kind === "ambiguous" || head.kind !== "ambiguous" && head.items?.length) return text;
  const all = read.items ?? [];
  const same = all.length === list.items.length && list.items.every((l) => all.some((a) => a.number === l.number && a.repo.toLowerCase() === l.repo.toLowerCase()));
  return same && list.items.some((l) => names(l, item)) ? list.words : text;
}

/** Stores the text as one message on each item it may be stored on (`storable`). Failures are logged, not thrown. */
export async function recordSaid(db: Db, o: SaidInput): Promise<Said[]> {
  const body = o.text.trim();
  if (!body || !o.items.length) return [];
  try {
    const refs = await storable(db, o);
    if (!refs.length) return [];
    const rows = await recordMessages(db, refs.map((r) => ({
      repo: r.repo, number: r.number, author: o.login, via: o.via, kind: "said" as const, body: o.githubCommentId === undefined ? ownBody(body, r) : body,
      ...(o.payload !== undefined ? { payload: o.payload } : {}), ...(o.githubCommentId !== undefined ? { githubCommentId: o.githubCommentId } : {}),
    })));
    // Rows come back in input order, so row i is on item i.
    return refs.flatMap((r, i) => (rows[i] ? [{ id: rows[i]!.id, repo: r.repo, number: r.number }] : []));
  } catch (e) {
    console.error(`chat: message not stored: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return [];
  }
}

/** Links each message to the newest event the person wrote on its item through `via` after `after`; returns the ids of the linked messages. */
export async function linkSaid(db: Db, said: readonly Said[], o: { login: string; via: ChatVia; after: number }): Promise<Set<number>> {
  const linked = new Set<number>();
  if (!said.length) return linked;
  try {
    for (const s of said) {
      const e = await loadNewestEventBy(db, { repo: s.repo, number: s.number, login: o.login, via: o.via, after: o.after });
      if (e !== null) {
        await linkMessage(db, s.id, { workflowEventId: e });
        linked.add(s.id);
      }
    }
  } catch (err) {
    console.error(`chat: message not linked: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  return linked;
}

/**
 * The reply a message keeps when its command wrote no event on its item: the item's line when the command did not run there, or the
 * whole reply when it ran on no item at all (a rate limit, a command naming nothing).
 */
function replyOf(s: Said, res: CommandResult): string | null {
  // An outcome names a tracked item by its tracked name, as the message does; another owner's repo keeps its owner.
  const mine = res.items.find((i) => i.number === s.number && i.repo.toLowerCase() === s.repo.toLowerCase());
  if (mine) return mine.outcome === "run" ? null : mine.line;
  return res.items.some((i) => i.outcome === "run") || !res.lines.length ? null : res.lines.join("\n");
}

/** Stores the text as a message on its items, runs the command, links the messages to the events it wrote and keeps the reply on the others. */
export async function saying(db: Db, o: SaidInput, run: () => Promise<CommandResult>): Promise<CommandResult> {
  const after = await loadLastEventId(db).catch(() => 0);
  const said = await recordSaid(db, o);
  let res: CommandResult | null = null;
  try {
    res = await run();
    return res;
  } finally {
    const linked = await linkSaid(db, said, { login: o.login, via: o.via, after });
    for (const s of said) {
      const reply = res && !linked.has(s.id) ? replyOf(s, res) : null;
      if (reply) await setMessageRefusal(db, s.id, reply).catch((e: Error) => console.error(`chat: reply not kept: ${String(e?.message ?? e).slice(0, 200)}`));
    }
  }
}

/** The stored message of a GitHub comment, or none. */
export async function saidByComment(db: Db, commentId: number): Promise<Said | null> {
  try {
    return await loadCommentMessage(db, commentId);
  } catch {
    return null;
  }
}

/** Runs a GitHub comment's command and links the comment's stored message to the event it wrote. */
export async function linkingComment<T>(db: Db, commentId: number, login: string, run: () => Promise<T>): Promise<T> {
  const after = await loadLastEventId(db).catch(() => 0);
  try {
    return await run();
  } finally {
    const m = await saidByComment(db, commentId);
    if (m) await linkSaid(db, [m], { login, via: "github", after });
  }
}

/**
 * Links the message a question came in to the Opus turn it was put as (src/conversations/ask.ts), so the chat shows the answer under it
 * and the Conversation step knows where the question came from. Runs in the transaction that stores the turn (askQuestion `linked`):
 * a failure throws, and nothing is asked. False when no message was found to link.
 */
export async function linkAskTurn(db: Db, o: { repo: string; number: number; login: string; via: ChatVia; turnId: number; commentId?: number }): Promise<boolean> {
  if (o.commentId !== undefined) {
    // A comment's own stored message, never another message of the asker's.
    const m = await loadCommentMessage(db, o.commentId);
    if (!m) return false;
    await linkMessage(db, m.id, { turnId: o.turnId });
    return true;
  }
  return await linkNewestSaid(db, { repo: o.repo, number: o.number, author: o.login, via: o.via, turnId: o.turnId }) !== null;
}
