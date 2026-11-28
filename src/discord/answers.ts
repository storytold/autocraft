// Answers to `@AutoCraft ask <question>` (src/discord/at-commands.ts), posted as a reply to the question's message, in the channel or
// thread where it was asked. The question is the asker's message in the item's chat (src/conversations/ask.ts); its payload keeps the
// place it was asked, sealed with the message row's id (keys.ts), and, once Opus's turn has ended, the text to post (`answer`: the
// answer that passed reply lint, a pointer to the item's chat, or why there is none). A posted answer, or one that has nowhere to go,
// is marked `answered`, so a restart posts nothing twice. A question whose turn ended without an answer kept (a crash or a failed write
// in between) gets the pointer, or why there is none, once LOST_ANSWER_MS has passed since the turn's stored end (lostAnswer). Opus's
// own text ends with the AI note naming the model, as on GitHub.
//
// Private repos and quiet items (visibility.ts discordDetail) get the pointer to the item's chat in place of the answer, decided when it
// is posted. An answer longer than one message is cut, closing a code block the cut falls in, with the pointer after it. No answer
// mentions anyone: the post allows no mentions, and the text was cleaned of links and images when it was kept (publicAnswer).
//
// When: a poll of the change markers of the `chat` topic (the answer is written there); a change runs one pass, and so does the end of
// a back-off, and every LOST_PASS_MS while a question waits for its answer. A target whose channel is gone or closed to the bot (Discord codes 10003, 50001) gets nothing; any other failed send is
// tried again after FAIL_FIRST_MS, doubling up to FAIL_MAX_MS. Questions older than ANSWER_KEEP_DAYS are no longer answered here.
import { exclusive } from "../async-seq.ts";
import { chatPointer, lostAnswer, type DiscordAsked } from "../conversations/ask.ts";
import { noteLine } from "../github/note.ts";
import { loadDiscordQuestions, loadTurnMessage, setPayloadFields } from "../data/chat/index.ts";
import type { Db } from "../db/index.ts";
import type { DiscordKeys } from "./keys.ts";
import { FAIL_FIRST_MS, FAIL_MAX_MS } from "./results.ts";
import { MISSING_ACCESS, RestError, UNKNOWN_CHANNEL, type DiscordRest } from "./rest.ts";
import { sendToFollow } from "./threads.ts";
import { discordDetail } from "./visibility.ts";

const POLL_MS = 2000;
/** How often a pass runs while a question waits for its answer, so a lost one is swept. */
const LOST_PASS_MS = 3 * 60_000;
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

/** The fence of a code block the text leaves open, or null. */
function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    if (open === null) open = m[1]!;
    else if (m[1]![0] === open[0] && m[1]!.length >= open.length && /^ {0,3}[`~]+[ \t]*$/.test(line)) open = null;
  }
  return open;
}

/** At most `room` characters of the text; a code block the cut falls in is closed. */
function cutText(text: string, room: number): string {
  const cut = text.slice(0, Math.max(0, room)).trimEnd();
  const fence = openFence(cut);
  if (fence === null) return cut;
  const shorter = text.slice(0, Math.max(0, room - fence.length - 1)).trimEnd();
  const still = openFence(shorter);
  return still === null ? shorter : `${shorter}\n${still}\n`;
}

/** The text as one message, `note` last: cut, with the pointer after it, when it does not fit. */
export function answerText(text: string, pointer: string, note?: string): string {
  const tail = note ? `\n\n${note}` : "";
  if (text.length + tail.length <= MESSAGE_MAX) return text + tail;
  const end = `…\n\n${pointer}${tail}`;
  return `${cutText(text, MESSAGE_MAX - end.length)}${end}`;
}

export type AnswerDeps = { db: Db; keys: DiscordKeys; rest: Pick<DiscordRest, "createMessage">; log: (line: string) => void; now?: () => number };

const goneTarget = (e: unknown): boolean => e instanceof RestError && (e.code === UNKNOWN_CHANNEL || e.code === MISSING_ACCESS);

export class DiscordAnswers {
  #d: AnswerDeps;
  #running: Promise<void> | null = null;
  #again = false;
  #last = -1;
  #backoff = new Map<number, { until: number; fails: number }>();
  /** Questions the last pass found waiting for their answer, and when that pass started. */
  #waiting = 0;
  #passAt = 0;

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
        const retry = [...this.#backoff.values()].some((b) => b.until <= now) || (this.#waiting > 0 && now - this.#passAt >= LOST_PASS_MS);
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
    this.#passAt = now;
    const rows = await loadDiscordQuestions(db, new Date(now - ANSWER_KEEP_DAYS * 86_400_000).toISOString());
    let waiting = 0;
    for (const r of rows) {
      const p = (r.payload ?? {}) as DiscordAsked;
      if (!p.answerTo || p.answered) continue;
      if (p.answer === undefined) {
        const lost = lostAnswer({ status: r.turnStatus, error: r.turnError, endedAt: r.turnEndedAt }, r.at, r.repo, r.number, "discord", now);
        // The change of the chat topic runs the pass that posts it.
        if (lost) await setPayloadFields(db, r.id, { answer: lost.result });
        else waiting++;
        continue;
      }
      const b = this.#backoff.get(r.id);
      if (b && b.until > now) continue;
      const at = keys.open(p.answerTo, answerAad(r.id));
      if (!at) { await setPayloadFields(db, r.id, { answered: true }); continue; }
      const pointer = chatPointer(r.repo, r.number);
      const full = (await discordDetail(db, [{ repo: r.repo, number: r.number }])).get(`${r.repo}#${r.number}`) === "full";
      try {
        await sendToFollow(rest, { kind: "reply", guildId: at.guildId, channelId: at.channelId, messageId: at.messageId }, { content: full ? answerText(p.answer, pointer, p.model ? noteLine({ by: "model", kind: "answer", model: p.model }) : undefined) : pointer });
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
    this.#waiting = waiting;
  }
}
