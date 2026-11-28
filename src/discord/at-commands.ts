// Commands to the bot written in a watched channel, publicly. A person's message is a command when it is addressed to the bot (it
// mentions the bot, or it replies to the bot's message in a thread the bot follows or to the bot's command reply) and its text without
// mentions starts with a command word (an alias counts) or reads whole as one (`yes`, `urgent`). A mention that is no command stays a
// search ping (pings.ts). A command runs as `/autocraft do` runs it (do.ts): the same parser, model reading, linked login, write
// permission per repo, limits and audit.
//
// Items: those the text names. A command naming none acts on its context: the items of the message it replies to (the bot's reply
// or result post, else the message's mention rows and the items its text names), else the thread's. Named items replace the
// context; they need not be among it. `review all` reads as `review`. A bare number, and a command in a thread with several items,
// are settled against the conversation first (context.ts).
//
// `status` (alone, or followed by items) is a lookup, not a workflow command: anyone may send it, at most READ_LIMIT a minute. It
// answers with a plain reply like `/autocraft status`: the items named, else the replied-to message's items (its mention rows, the
// bot's reply's items, and the item links and references in its text), else the thread's items; with none, the same "No item found".
//
// Who: a sender with no linked login, or without write access on a repo of the command's items, gets one short public reply (at most
// one per REFUSAL_GAP_MS) and nothing runs.
//
// `ask <question>` (and text the model reading takes for only a question) is no workflow command: on one item, from an operator or a
// maintainer with write access, it goes to Opus as the sender's message in the item's chat (do.ts, src/conversations/ask.ts). The
// bot replies to the question's message that it was asked, and posts the answer as a reply to it when Opus's turn ends (answers.ts),
// in the channel or thread where it was asked. A question starts no thread and makes nothing follow its item.
//
// Answer: when anything ran, the bot starts a public thread on the command message ("review · photocraft#123 (+2)") and posts the
// confirmation lines there, the lines GitHub shows (an item of a private or quiet repo shows a status line and its link only); a command sent in a thread is answered in that thread. Without Create Public
// Threads, Send Messages in Threads or Read Message History in the channel, or when starting the thread fails, the answer is a plain
// reply (logged once per channel). The thread, or that reply, then follows the items that ran (threads.ts). A command that ran nothing
// gets a plain reply. No reply mentions anyone.
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import * as dc from "../data/discord/index.ts";
import { freshWrite, type PermissionFn } from "../remote/permission.ts";
import type { Db } from "../db/index.ts";
import { t } from "../i18n/index.ts";
import type { CommandResult } from "../workflow/apply.ts";
import { askedQuestion, describe, parse } from "../workflow/parse.ts";
import type { ReadDeps } from "../workflow/read.ts";
import { listText } from "../workflow/status.ts";
import type { ItemRef, Parsed } from "../workflow/types.ts";
import { commandOf } from "../workflow/vocab.ts";
import { bareNumbers, repliedItems, settle } from "./context.ts";
import { prepareDo, runDo, targetsOf, type DoText } from "./do.ts";
import type { DiscordKeys } from "./keys.ts";
import { discordDetail } from "./visibility.ts";
import { statusReply } from "./commands.ts";
import { parseRefs, withoutRefs, type ItemKey, type TextMessage } from "./refs.ts";
import { messageItems, trackedRepos } from "./store.ts";
import { loginOf, mayCommand } from "./links.ts";
import { CREATE_PUBLIC_THREADS, READ_MESSAGE_HISTORY, SEND_MESSAGES_IN_THREADS, guildPerms } from "./perms.ts";
import type { DiscordRest } from "./rest.ts";
import { follow, followOf, replyTarget, threadTarget, type Follow, type FollowTarget } from "./threads.ts";
import { WindowLimits } from "./window-limit.ts";

/** The least time between two refusal replies to one sender. */
export const REFUSAL_GAP_MS = 10 * 60_000;
const THREAD_PERMS = CREATE_PUBLIC_THREADS | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY;
const SEEN_MAX = 2000;
/** Status lookups per sender. */
const READ_LIMIT = { n: 10, ms: 60_000 };
const MENTION = /<@[!&]?\d+>/g;

/** The text of a message without mentions, on one line. */
export const withoutMentions = (s: string): string => s.replace(MENTION, " ").replace(/\s+/g, " ").trim();

/** Whether text written to the bot may be a command: it starts with a command word or alias (or is `ask <question>`), or reads whole as one. `take` then drops text that parses as ambiguous and has no items to act on. */
export function isCommand(text: string): boolean {
  return startsWithCommandWord(text) || (text.trim().length > 0 && parse(text).kind !== "ambiguous");
}

/** For a status request (`status`, then nothing but item references and separators), the text after the word; else null. */
export function statusRest(text: string): string | null {
  const m = /^status\b[\s,.:;!?]*(.*)$/i.exec(text);
  if (!m) return null;
  return withoutRefs(m[1]!).replace(/\b(?:of|for|and|on)\b|[\s,.:;!?&]/gi, "") ? null : m[1]!;
}

function startsWithCommandWord(text: string): boolean {
  if (askedQuestion(text) !== null) return true;
  const words = text.toLowerCase().replace(/[‘’]/g, "'").split(/[\s,.:;!]+/).filter(Boolean);
  for (let n = Math.min(4, words.length); n > 0; n--) if (commandOf(words.slice(0, n).join(" "))) return true;
  return false;
}

/** What a message carries that the bot reads (pings.ts PingMessage is this and more). */
export type AtMessage = {
  id: string; channel_id: string; guild_id?: string; content?: string;
  author?: { id: string };
  message_reference?: { message_id?: string; type?: number };
  referenced_message?: ({ author?: { id?: string } } & TextMessage) | null;
};

export type AtRest = Pick<DiscordRest, "createMessage"> & { startThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> };
export type AtDeps = {
  db: Db; keys: DiscordKeys; rest: AtRest; log: (line: string) => void; read?: ReadDeps; now?: () => number;
  /** Replaces the GitHub App permission lookup (tests). */
  permission?: PermissionFn;
  /** Called once the answer is posted and its target follows what ran: the thread's first status lines go out without waiting for a workflow change. */
  followed?: () => void;
};

const refOf = (i: ItemRef): string => `${i.repo.split("/").pop()!}#${i.number}`;

/** The command as the thread name and the follow rows show it. */
function commandLabel(p: Parsed): string {
  if (p.kind === "commands") return describe(p.parts) || t("command");
  return p.kind === "yes" ? "yes" : t("command");
}

/** "review · photocraft#123 (+2)", within Discord's 100 characters. */
export const threadName = (command: string, items: readonly ItemRef[]): string =>
  `${command.slice(0, 60)} · ${refOf(items[0]!)}${items.length > 1 ? ` (+${items.length - 1})` : ""}`.slice(0, 100);

/** The Discord error code in an error from rest.ts, else the message's first words. */
function discordCode(e: unknown): string {
  const msg = (e as Error).message ?? "";
  return /\b(\d{5})\b/.exec(msg)?.[1] ?? String((e as { status?: number }).status ?? "error");
}

/**
 * The lines of a result as a public channel may show them: an item of a private or quiet repo gets a status line (item, whether it
 * ran, GitHub link) in place of its line, which can carry the recommendation or review text.
 */
export async function publicLines(db: Db, result: CommandResult): Promise<string[]> {
  const detail = await discordDetail(db, result.items);
  const quiet = (o: CommandResult["items"][number]): boolean => detail.get(`${o.repo.split("/").pop()!}#${o.number}`) !== "full";
  if (!result.items.some(quiet)) return result.lines;
  const many = result.items.length > 1;
  const lines: string[] = [];
  for (const o of result.items) {
    const ref = refOf(o);
    if (!quiet(o)) { lines.push(many ? t("{ref}: {line}", { ref, line: o.line }) : o.line); continue; }
    const row = (await loadItems(db, [{ repo: o.repo.split("/").pop()!, number: o.number }], "labels")).values().next().value;
    const state = o.outcome === "run" ? t("ran") : t("did not run");
    lines.push([`${ref}: ${state}.`, row?.url].filter(Boolean).join(" "));
  }
  const failed = result.items.filter((o) => o.outcome !== "run");
  if (many && failed.length) lines.push(t("Not run: {refs}.", { refs: listText(failed.map(refOf)) }));
  return lines;
}

export class AtCommands {
  #d: AtDeps;
  #refusals = new WindowLimits();
  #reads = new WindowLimits();
  #logged = new Set<string>();
  /** Ids of messages already taken as commands: a replayed MESSAGE_CREATE (gateway resume) must not run one twice. */
  #seen = new Set<string>();

  constructor(deps: AtDeps) {
    this.#d = deps;
  }

  /**
   * The job that answers `m` as a command, or null when it is none. `m` is a person's new message in a watched channel; `mentioned`:
   * its text names the bot. The job never throws past the caller's job runner.
   */
  async take(m: AtMessage, o: { botId: string; mentioned: boolean }): Promise<(() => Promise<void>) | null> {
    const { db, keys } = this.#d;
    const text = withoutMentions(m.content ?? "");
    const status = statusRest(text);
    if (status === null && !isCommand(text)) return null;
    const here = await followOf(db, keys, threadTarget(keys, m.channel_id));
    // A forward (type 1) is not a reply.
    const repliedId = m.message_reference?.type ? undefined : m.message_reference?.message_id;
    const toBot = !!repliedId && m.referenced_message?.author?.id === o.botId;
    const ourReply = toBot ? await followOf(db, keys, replyTarget(keys, repliedId)) : null;
    if (!o.mentioned && !(toBot && (here || ourReply))) return null;
    if (status !== null) {
      if (!this.#once(m.id)) return async () => {};
      return () => this.#status(m, status, repliedId, ourReply?.items ?? [], here?.items ?? []);
    }
    const replied = repliedId ? await repliedItems(db, keys, { messageId: repliedId, message: m.referenced_message, ours: ourReply?.items ?? [], thread: here, toBot }) : [];
    const context = replied.length ? replied : here?.items ?? [];
    // Text that starts with a command word but reads as ambiguous is a command only with items to act on; otherwise it is a search.
    const d = prepareDo(text, context);
    if (d.parsed.kind === "ambiguous" && !(startsWithCommandWord(text) && (d.named.length || context.length || bareNumbers(d.text).clean))) return null;
    if (!this.#once(m.id)) return async () => {};
    return () => this.#run(m, d, here, replied);
  }

  /** False when message `id` was already taken. */
  #once(id: string): boolean {
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    if (this.#seen.size > SEEN_MAX) this.#seen.delete(this.#seen.values().next().value!);
    return true;
  }

  /** Answers a status request (`rest`: the text after `status`). `ours`: the items of the bot's reply it answers; `thread`: those of the thread it is in. */
  async #status(m: AtMessage, rest: string, repliedId: string | undefined, ours: readonly ItemKey[], thread: readonly ItemKey[]): Promise<void> {
    const { db, keys, rest: discord } = this.#d;
    if (!this.#reads.allow((this.#d.now ?? Date.now)(), [{ key: keys.hash("author", m.author!.id), ...READ_LIMIT }])) return;
    let items: ItemKey[];
    if (withoutRefs(rest) !== rest) items = parseRefs(rest, await trackedRepos(db));
    else {
      const seen = new Set<string>();
      items = [...ours.map((i) => ({ repo: i.repo.split("/").pop()!, number: i.number })), ...(repliedId ? await messageItems(db, keys, repliedId, m.referenced_message) : [])]
        .filter((i) => !seen.has(`${i.repo}#${i.number}`) && !!seen.add(`${i.repo}#${i.number}`));
      if (!items.length) items = thread.map((i) => ({ repo: i.repo.split("/").pop()!, number: i.number }));
    }
    const { content, components } = await statusReply(db, items);
    await discord.createMessage(m.channel_id, { content, components, allowed_mentions: { parse: [] }, message_reference: { message_id: m.id, fail_if_not_exists: false } });
  }

  async #run(m: AtMessage, said: DoText, here: Follow | null, replied: readonly ItemRef[]): Promise<void> {
    const { db, keys } = this.#d;
    const userId = m.author!.id;
    const login = await loginOf(db, keys, userId);
    if (!login) return await this.#refuse(m, t("Link your Discord account with /autocraft account action:link to send commands. Nothing ran."));
    if (!await mayCommand(db, keys, userId, login)) return await this.#refuse(m, t("Commands need an AutoCraft login with write access. Nothing ran."));
    const settled = await settle(db, keys, said, { channelId: m.channel_id, replied, thread: here, userId, login, nowMs: (this.#d.now ?? Date.now)() });
    if (settled.kind === "ask") {
      await this.#d.rest.createMessage(m.channel_id, { content: settled.line, allowed_mentions: { parse: [] }, message_reference: { message_id: m.id, fail_if_not_exists: false } });
      return;
    }
    const d = settled.d;
    const tracked = await loadTrackedRepos(db);
    const denied: string[] = [], unknown: string[] = [];
    for (const repo of new Set(targetsOf(d).map((i) => i.repo.split("/").pop()!))) {
      if (!tracked.has(repo)) continue;
      const w = await freshWrite(db, login, repo, this.#d.permission);
      if (w.kind === "no") denied.push(repo);
      else if (w.kind === "unknown") unknown.push(repo);
    }
    if (denied.length) return await this.#refuse(m, t("{login} has no write access to {repos}. Nothing ran.", { login, repos: listText(denied) }));
    if (unknown.length) return await this.#refuse(m, t("Could not check {login}'s write access to {repos}. Try again. Nothing ran.", { login, repos: listText(unknown) }));
    const where = (await dc.loadWatchedChannels(db, [m.channel_id])).get(m.channel_id);
    const askedAt = { guildId: m.guild_id ?? where?.guildId ?? "", channelId: m.channel_id, messageId: m.id };
    const result = await runDo(db, keys, d, { userId, login, messageId: m.id }, this.#d.read, this.#d.permission, askedAt);
    if (result.asked) {
      // A question is answered by a reply to its message, where it was asked: no thread, nothing to follow.
      const content = (await publicLines(db, result)).join("\n").slice(0, 1990) || t("Nothing ran.");
      await this.#d.rest.createMessage(m.channel_id, { content, allowed_mentions: { parse: [] }, message_reference: { message_id: m.id, fail_if_not_exists: false } });
      return;
    }
    await this.#answer(m, d, result, here, login);
    if (result.items.some((o) => o.outcome === "run")) this.#d.followed?.();
  }

  /** One short public reply per sender within REFUSAL_GAP_MS; later ones are dropped. */
  async #refuse(m: AtMessage, line: string): Promise<void> {
    const now = (this.#d.now ?? Date.now)();
    if (!this.#refusals.allow(now, [{ key: this.#d.keys.hash("author", m.author!.id), n: 1, ms: REFUSAL_GAP_MS }])) return;
    await this.#d.rest.createMessage(m.channel_id, { content: line, allowed_mentions: { parse: [] }, message_reference: { message_id: m.id, fail_if_not_exists: false } });
  }

  async #answer(m: AtMessage, d: DoText, result: CommandResult, here: Follow | null, login: string): Promise<void> {
    const { db, keys, rest } = this.#d;
    const content = (await publicLines(db, result)).join("\n").slice(0, 1990) || t("Nothing ran.");
    const ran = result.items.filter((o) => o.outcome === "run").map((o) => ({ repo: o.repo, number: o.number }));
    const command = commandLabel(d.parsed);
    const where = (await dc.loadWatchedChannels(db, [m.channel_id])).get(m.channel_id);
    const guildId = m.guild_id ?? where?.guildId ?? "";
    const at = new Date((this.#d.now ?? Date.now)()).toISOString();
    const keep = async (targetHash: string, channelHash: string, target: FollowTarget): Promise<void> =>
      await follow(db, keys, { targetHash, channelHash, target, author: keys.hash("author", m.author!.id), items: ran, command, login, at });
    const reply = { content, allowed_mentions: { parse: [] }, message_reference: { message_id: m.id, fail_if_not_exists: false } };
    // Sent in a thread (one the bot started, or any thread of a watched channel): answered there, and the thread follows what ran.
    if (here || where?.parentId) {
      await rest.createMessage(m.channel_id, reply);
      const target: FollowTarget = here?.target ?? { kind: "thread", guildId, channelId: m.channel_id, messageId: m.channel_id };
      await keep(threadTarget(keys, m.channel_id), here?.channelHash ?? keys.hash("channel", where!.parentId!), target);
      return;
    }
    if (ran.length && guildPerms.has(guildId, m.channel_id, THREAD_PERMS)) {
      let thread: { id: string } | null = null;
      try {
        thread = await rest.startThread(m.channel_id, m.id, threadName(command, ran));
      } catch (e) {
        this.#logOnce(m.channel_id, `starting a thread failed (${(e as Error).message}); answering with a reply`, discordCode(e));
      }
      if (thread) {
        await keep(threadTarget(keys, thread.id), keys.hash("channel", m.channel_id), { kind: "thread", guildId, channelId: thread.id, messageId: m.id });
        await rest.createMessage(thread.id, { content, allowed_mentions: { parse: [] } });
        return;
      }
    } else if (ran.length) {
      this.#logOnce(m.channel_id, "missing Create Public Threads, Send Messages in Threads or Read Message History; answering with a reply", "perms");
    }
    const sent = await rest.createMessage(m.channel_id, reply);
    if (ran.length) await keep(replyTarget(keys, sent.id), keys.hash("channel", m.channel_id), { kind: "reply", guildId, channelId: m.channel_id, messageId: sent.id });
  }

  /** Once per channel and cause (`cause`: the Discord error code, or a fixed word). */
  #logOnce(channelId: string, what: string, cause: string): void {
    const key = `${channelId}|${cause}`;
    if (this.#logged.has(key)) return;
    this.#logged.add(key);
    this.#d.log(`discord: command in channel ${channelId}: ${what}`);
  }
}
