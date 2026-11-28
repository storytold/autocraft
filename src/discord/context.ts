// What a Discord command acts on when it does not name its items in full: the conversation decides, and the reply names the
// repo#n it acted on.
//
// A bare number (`850`, `#850`) where the parser would read an item resolves to one item, level by level; the first level with an
// item of that number decides:
//   1. the items of the message the command replies to (the bot reply's or result post's items, the message's mention rows, the
//      items its text names);
//   2. the items recorded in the same channel or thread within BARE_WINDOW_MS, newest first (mention rows of its messages, what the
//      bot's threads and replies started there follow), then the thread's own items;
//   3. the items the sender started, approved or answered, or whose question their alerts showed, within the same window;
//   4. the context items' one repo, else the channel's default repo.
// Only tracked repos count. One item: the text is read with its repo#n. Several: nothing runs and the reply asks which. None: the
// reply says so. A number after an explicit repo#n, a plan part (`fix 2`), a weight, and the argument of autorepin or of a
// duplicate close stay the parser's. When the text reads only partly even with the numbers as items, a number that resolves to one
// item is written out and the rest is left to the model reading.
//
// Focus: in a thread that follows several items, a command that names none and replies to no particular message addresses some:
//   - an answer (yes, plan parts) goes to the items with an open question; to several only when their questions are of one kind,
//     else the reply asks which; with none open, to the item the bot posted about last;
//   - any other command goes to the item or items the bot posted about last;
//   - a text ending in "all" or "both" keeps every item.
import { loadTrackedRepos } from "../data/control/index.ts";
import * as dc from "../data/discord/index.ts";
import { listWorkflows, loadLoginItems, loadWorkflowHistory } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { t } from "../i18n/index.ts";
import { parse, PART_BEFORE } from "../workflow/parse.ts";
import { refsIn } from "../workflow/read.ts";
import { isLive } from "../workflow/resolve.ts";
import { openRecommendation, type ItemRef, type ItemWorkflow, type Parsed } from "../workflow/types.ts";
import { prepareDo, type DoText } from "./do.ts";
import type { DiscordKeys } from "./keys.ts";
import type { TextMessage } from "./refs.ts";
import { messageItems } from "./store.ts";
import { resultAad, threadTarget, type Follow } from "./threads.ts";

/** How far back the channel's messages and the sender's own work count for a bare number. */
export const BARE_WINDOW_MS = 24 * 3_600_000;
/** A repo name no repo has: a bare number written as an item of it shows whether the parser reads the number as an item. */
const PROBE = "bare-number-probe";
const NUMBER_RE = /(^|[\s,;:(])(#?)(\d{1,9})(?=$|[\s,;:)!?]|\.(?:\s|$))/g;
const LEFT_TO_PARSER = [PART_BEFORE, /\bweight\s*$/i, /auto[-\s]?repin\s*$/i, /\bduplicate\s+of\s*$/i];

type Token = { start: number; end: number; n: number };
const short = (repo: string): string => repo.split("/").pop()!;
const keyOf = (i: ItemRef): string => `${short(i.repo)}#${i.number}`;
const orText = (refs: readonly string[]): string =>
  refs.length < 2 ? refs[0] ?? "" : t("{list} or {last}", { list: refs.slice(0, -1).join(", "), last: refs.at(-1)! });

/**
 * The bare numbers of a text the parser cannot read without a repo, and `clean`: with each read as an item, the whole text reads.
 * A text the parser reads as it is has none.
 */
export function bareNumbers(text: string): { tokens: Token[]; clean: boolean } {
  if (parse(text).kind !== "ambiguous") return { tokens: [], clean: false };
  const tokens: Token[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const start = m.index + m[1]!.length;
    const before = text.slice(0, start);
    // After an explicit repo#n the parser gives a bare number that repo.
    if (refsIn(before).length) break;
    const n = Number(m[3]);
    if (n < 1 || LEFT_TO_PARSER.some((r) => r.test(before))) continue;
    tokens.push({ start, end: start + m[2]!.length + m[3]!.length, n });
  }
  if (!tokens.length) return { tokens, clean: false };
  const p = parse(written(text, tokens.map((tk) => ({ ...tk, repo: PROBE }))));
  const clean = p.kind !== "ambiguous" && tokens.every((tk) => (p.items ?? []).some((i) => i.repo === PROBE && i.number === tk.n));
  return { tokens, clean };
}

/** The text with each token written as `repo#n`. */
function written(text: string, tokens: readonly (Token & { repo: string })[]): string {
  let out = text;
  for (const tk of [...tokens].sort((a, b) => b.start - a.start)) out = `${out.slice(0, tk.start)}${tk.repo}#${tk.n}${out.slice(tk.end)}`;
  return out;
}

/** The items of a message the command replies to: the bot reply's (`ours`), the result post's in the thread, else its mention rows and the items its text names. */
export async function repliedItems(db: Db, keys: DiscordKeys, o: { messageId: string; message: TextMessage | null | undefined; ours: readonly ItemRef[]; thread: Follow | null; toBot: boolean }): Promise<ItemRef[]> {
  if (o.ours.length) return [...o.ours];
  if (o.toBot && o.thread) {
    const target = o.thread.targetHash;
    const posted = (await dc.loadFollowPostsOf(db, [target])).filter((p) => p.sealed && keys.open(p.sealed, resultAad(p))?.messageId === o.messageId);
    if (posted.length) return posted.map((p) => ({ repo: p.repo, number: p.number }));
  }
  return await messageItems(db, keys, o.messageId, o.message);
}

/** Where a command was sent. */
export type Conversation = {
  channelId: string;
  /** The items of the message the command replies to; empty when it replies to none, or to one about no item. */
  replied: readonly ItemRef[];
  /** What the bot follows in the thread the command was sent in. */
  thread: Follow | null;
  userId: string;
  login: string;
  nowMs: number;
};

export type Settled = { kind: "run"; d: DoText } | { kind: "ask"; line: string };

/** Resolves the text's bare numbers, then focuses a command that names no item on the thread items it addresses. */
export async function settle(db: Db, keys: DiscordKeys, d: DoText, c: Conversation): Promise<Settled> {
  const bare = bareNumbers(d.text);
  if (bare.tokens.length) {
    const found = await resolveNumbers(db, keys, [...new Set(bare.tokens.map((tk) => tk.n))], d, c);
    const one = bare.tokens.flatMap((tk) => (found.get(tk.n)?.length === 1 ? [{ ...tk, repo: found.get(tk.n)![0]!.repo }] : []));
    if (bare.clean) {
      const lines = [...new Set(bare.tokens.map((tk) => tk.n))].flatMap((n) => {
        const refs = found.get(n) ?? [];
        if (!refs.length) return [t("No item #{n} was found in this conversation. Write it with its repo, as repo#{n}. Nothing ran.", { n })];
        return refs.length > 1 ? [t("Which one: {refs}? Write it with its repo. Nothing ran.", { refs: orText(refs.map(keyOf)) })] : [];
      });
      if (lines.length) return { kind: "ask", line: lines.join("\n") };
    }
    if (one.length) return { kind: "run", d: { ...prepareDo(written(d.text, one), d.context), written: d.written, picked: true } };
    return { kind: "run", d };
  }
  return await focus(db, keys, d, c);
}

/** Per number, the items of the first level that has one, newest first. */
async function resolveNumbers(db: Db, keys: DiscordKeys, numbers: number[], d: DoText, c: Conversation): Promise<Map<number, ItemRef[]>> {
  const tracked = await loadTrackedRepos(db);
  const since = new Date(c.nowMs - BARE_WINDOW_MS).toISOString();
  const channelHash = keys.hash("channel", c.channelId);
  const levels: (() => Promise<ItemRef[]>)[] = [
    async () => [...c.replied],
    async () => {
      const [mentions, follows] = await Promise.all([
        dc.loadChannelMentions(db, channelHash, numbers),
        dc.loadChannelFollows(db, { channelHash, targetHash: threadTarget(keys, c.channelId), numbers, since }),
      ]);
      const dated = [
        ...mentions.flatMap((r) => { const at = keys.open(r.sealed, r.msgHash)?.at; return at && at > since ? [{ repo: r.repo, number: r.number, at }] : []; }),
        ...follows.map((f) => ({ repo: f.repo, number: f.number, at: f.at })),
      ].sort((a, b) => b.at.localeCompare(a.at));
      return [...dated, ...(c.thread?.items ?? [])];
    },
    async () => {
      const [mine, shown] = await Promise.all([loadLoginItems(db, { login: c.login, numbers, since }), dc.loadShownSince(db, keys.hash("author", c.userId), since)]);
      const asked = shown.length ? (await listWorkflows(db, { ids: shown })).filter((w) => numbers.includes(w.number)) : [];
      return [...mine, ...asked];
    },
    async () => {
      const repos = new Set(d.context.map((i) => short(i.repo)));
      const repo = repos.size === 1 ? [...repos][0] : (await dc.loadChannelDefaults(db, [c.channelId])).get(c.channelId)?.defaultRepo;
      return repo ? numbers.map((number) => ({ repo, number })) : [];
    },
  ];
  const out = new Map<number, ItemRef[]>();
  for (const level of levels) {
    const left = numbers.filter((n) => !out.has(n));
    if (!left.length) break;
    const items = (await level()).filter((i) => left.includes(i.number) && tracked.has(short(i.repo)));
    for (const n of left) {
      const seen = new Set<string>();
      const refs = items.filter((i) => i.number === n && !seen.has(keyOf(i)) && !!seen.add(keyOf(i))).map((i) => ({ repo: short(i.repo), number: n }));
      if (refs.length) out.set(n, refs);
    }
  }
  return out;
}

/** An answer to a question: yes, or plan parts by number. */
const isAnswer = (p: Parsed): boolean => p.kind === "yes" || (p.kind === "commands" && (!!p.yes || p.parts.some((x) => x.word === "fix" || x.word === "drop")));

/** What a yes to the workflow's open question runs, so that one yes may answer several alike questions. */
function questionKind(wf: ItemWorkflow): string {
  const rec = openRecommendation(wf)!;
  return JSON.stringify([wf.state, wf.blockerParams?.code ?? null, rec.merges, !!rec.close, !!rec.backlog, rec.parts.fix.length > 0, rec.parts.drop.length > 0]);
}

async function focus(db: Db, keys: DiscordKeys, d: DoText, c: Conversation): Promise<Settled> {
  const p = d.parsed;
  if (!c.thread || c.replied.length || d.all || d.named.length || p.kind === "ambiguous" || p.items?.length || d.context.length < 2) return { kind: "run", d };
  const narrow = (items: readonly ItemRef[]): Settled => ({ kind: "run", d: { ...d, context: [...items], picked: true } });
  const last = await lastPosted(db, c.thread, d.context);
  if (!isAnswer(p)) return last.length ? narrow(last) : { kind: "run", d };
  const history = await loadWorkflowHistory(db, d.context.map((i) => ({ repo: short(i.repo), number: i.number })));
  const open = d.context.flatMap((i) => {
    const wf = (history.get(keyOf(i)) ?? []).findLast((w) => isLive(w));
    return wf && openRecommendation(wf) ? [{ item: i, kind: questionKind(wf) }] : [];
  });
  if (!open.length) return last.length ? narrow(last.slice(0, 1)) : { kind: "run", d };
  if (new Set(open.map((o) => o.kind)).size === 1) return narrow(open.map((o) => o.item));
  return { kind: "ask", line: t("Which one: {refs}? Reply to its message or name it. Nothing ran.", { refs: orText(open.map((o) => keyOf(o.item))) }) };
}

/** The context items the bot posted about last in the thread: its newest result or status post, or command answer. */
async function lastPosted(db: Db, thread: Follow, context: readonly ItemRef[]): Promise<ItemRef[]> {
  const [posts, rows] = await Promise.all([dc.loadFollowPostsOf(db, [thread.targetHash]), dc.loadFollows(db, [thread.targetHash])]);
  const at = new Map<string, string>();
  for (const r of [...posts, ...(rows.get(thread.targetHash) ?? [])]) {
    const k = keyOf(r);
    if ((at.get(k) ?? "") < r.at) at.set(k, r.at);
  }
  const newest = context.reduce((m, i) => ((at.get(keyOf(i)) ?? "") > m ? at.get(keyOf(i))! : m), "");
  return newest ? context.filter((i) => at.get(keyOf(i)) === newest) : [];
}

