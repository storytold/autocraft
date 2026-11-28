// Answers to `@AutoCraft ask <question>` (src/discord/at-commands.ts), posted as a reply to the question's message, in the channel or
// thread where it was asked. The question is the asker's message in the item's chat (src/conversations/ask.ts); its payload keeps the
// place it was asked, sealed with the message row's id (keys.ts), and, once Opus's turn has ended, the text to post (`answer`: the
// answer that passed reply lint, a pointer to the item's chat, or why there is none). A posted answer, or one that has nowhere to go,
// is marked `answered`, so a restart posts nothing twice. A question whose turn ended without an answer kept (a crash or a failed write
// in between) gets the pointer, or why there is none, once LOST_ANSWER_MS has passed (lostAnswer).
//
// Private repos and quiet items (visibility.ts discordDetail) get the pointer to the item's chat in place of the answer, decided when it
// is posted. An answer longer than one message is cut, with the pointer after it. No answer mentions anyone: the text was cleaned
// when it was kept (publicAnswer), and the post allows no mentions.
//
// When: a poll of the change markers of the `chat` topic (the answer is written there); a change runs one pass, and so does the end of
// a back-off. A target whose channel is gone or closed to the bot (Discord codes 10003, 50001) gets nothing; any other failed send is
// tried again after FAIL_FIRST_MS, doubling up to FAIL_MAX_MS. Questions older than ANSWER_KEEP_DAYS are no longer answered here.
import { exclusive } from "../async-seq.ts";
import { chatPointer, keepLostKeys, lostAnswer, lostAnswerDue, type DiscordAsked } from "../conversations/ask.ts";
import { loadDiscordQuestions, loadTurnMessage, setPayloadFields } from "../data/chat/index.ts";
import type { Db } from "../db/index.ts";
import type { DiscordKeys } from "./keys.ts";
import { FAIL_FIRST_MS, FAIL_MAX_MS } from "./results.ts";
import { MISSING_ACCESS, RestError, UNKNOWN_CHANNEL, type DiscordRest } from "./rest.ts";
import { sendToFollow } from "./threads.ts";
import { discordDetail } from "./visibility.ts";

const POLL_MS = 2000;
/** The prefix of this surface's keys in lostAnswer. */
const LOST_PREFIX = "discord:";
const TOPIC = "chat";
/** Days a question waits for its answer to be posted. */
export const ANSWER_KEEP_DAYS = 7;
/** The longest answer posted, within Discord's 2000 characters. */
const MESSAGE_MAX = 1990;

/** Where a question was asked: the channel or thread and the question's message. */
export type AskedAt = { guildId: string; channelId: string; messageId: string };

/** What the seal of a question's place is bound to: its chat message row. */
const answerAad = (messageRowId: number): string => `answer:${messageRowId}`;

/** Keeps where the question of `turnId` was asked on its chat message; false when the turn has no message. */
export async function keepAskedAt(db: Db, keys: DiscordKeys, turnId: number, at: AskedAt): Promise<boolean> {
  const m = await loadTurnMessage(db, turnId);
  if (!m || m.via !== "discord") return false;
  const answerTo = keys.seal({ guildId: at.guildId, channelId: at.channelId, messageId: at.messageId, at: new Date().toISOString() }, answerAad(m.id));
  return await setPayloadFields(db, m.id, { answerTo });
}

/** The text as one message: cut with the pointer after it when it does not fit. */
export function answerText(text: string, pointer: string): string {
  if (text.length <= MESSAGE_MAX) return text;
  const room = MESSAGE_MAX - pointer.length - 3;
  return `${text.slice(0, Math.max(0, room)).trimEnd()}…\n\n${pointer}`;
}

export type AnswerDeps = { db: Db; keys: DiscordKeys; rest: Pick<DiscordRest, "createMessage">; log: (line: string) => void; now?: () => number };

const goneTarget = (e: unknown): boolean => e instanceof RestError && (e.code === UNKNOWN_CHANNEL || e.code === MISSING_ACCESS);

export class DiscordAnswers {
  #d: AnswerDeps;
  #running: Promise<void> | null = null;
  #again = false;
  #last = -1;
  #backoff = new Map<number, { until: number; fails: number }>();

  constructor(d: AnswerDeps) {
    this.#d = d;
  }

  /** Polls the change marker of the chat topic; a change, or the end of a back-off, runs one pass. Runs a first pass at once. */
  start(signal: AbortSignal): void {
    void this.sync();
    const poll = exclusive(async () => {
      try {
        const seq = (await this.#d.db.seqs())[TOPIC] ?? 0;
        const now = this.#now();
        const lost = lostAnswerDue(LOST_PREFIX);
        const retry = [...this.#backoff.values()].some((b) => b.until <= now) || (lost !== null && lost <= now);
        if (seq !== this.#last || retry) { this.#last = seq; void this.sync(); }
      } catch (e) {
        this.#d.log(`discord: answers poll failed: ${(e as Error).message}`);
      }
    });
    const timer = setInterval(() => void poll.skip(), POLL_MS);
    timer.unref();
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  }

  /** One pass. Passes never overlap; a request during a pass runs another after it, and its promise resolves when that one has finished. */
  sync(): Promise<void> {
    if (this.#running) { this.#again = true; return this.#running; }
    const run = (async () => {
      try {
        do {
          this.#again = false;
          try { await this.#pass(); } catch (e) { this.#d.log(`discord: answers pass failed: ${(e as Error).message}`); }
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    this.#running = run;
    return run;
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  async #pass(): Promise<void> {
    const { db, keys, rest } = this.#d;
    const now = this.#now();
    const rows = await loadDiscordQuestions(db, new Date(now - ANSWER_KEEP_DAYS * 86_400_000).toISOString());
    const waiting = new Set<string>();
    for (const r of rows) {
      const p = (r.payload ?? {}) as DiscordAsked;
      if (!p.answerTo || p.answered) continue;
      if (p.answer === undefined) {
        const key = `${LOST_PREFIX}${r.id}`;
        waiting.add(key);
        const lost = lostAnswer(key, { status: r.turnStatus, error: r.turnError }, r.repo, r.number, now);
        // The next pass posts it.
        if (lost) await setPayloadFields(db, r.id, { answer: lost.result });
        continue;
      }
      const b = this.#backoff.get(r.id);
      if (b && b.until > now) continue;
      const at = keys.open(p.answerTo, answerAad(r.id));
      if (!at) { await setPayloadFields(db, r.id, { answered: true }); continue; }
      const pointer = chatPointer(r.repo, r.number);
      const full = (await discordDetail(db, [{ repo: r.repo, number: r.number }])).get(`${r.repo}#${r.number}`) === "full";
      try {
        await sendToFollow(rest, { kind: "reply", guildId: at.guildId, channelId: at.channelId, messageId: at.messageId }, { content: full ? answerText(p.answer, pointer) : pointer });
        this.#backoff.delete(r.id);
      } catch (e) {
        if (!goneTarget(e)) {
          const fails = (b?.fails ?? 0) + 1;
          const wait = Math.min(FAIL_MAX_MS, FAIL_FIRST_MS * 2 ** (fails - 1));
          this.#backoff.set(r.id, { until: now + wait, fails });
          this.#d.log(`discord: answer not posted (failure ${fails}, next try in ${Math.round(wait / 1000)} s): ${(e as Error).message}`);
          continue;
        }
        this.#d.log(`discord: answer not posted: the channel is gone or closed to the bot (${(e as RestError).code})`);
        this.#backoff.delete(r.id);
      }
      await setPayloadFields(db, r.id, { answered: true });
    }
    keepLostKeys(LOST_PREFIX, waiting);
  }
}
