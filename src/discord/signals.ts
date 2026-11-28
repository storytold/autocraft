// Attention signals: whether a message that names a tracked item asks for attention on it (a review, a merge, an answer,
// "is anyone looking at this"). Jev is asked once per message and item; Haiku decides where Jev is unsure and when Jev is
// unavailable, under a daily dollar cap. The text is used for that call only: only a flag is kept on the mention row, the
// recorded prompt and reply are deleted when the call ends, and an edit asks again. A deleted message takes its row, and
// so its flag, with it (store.ts). Display only: nothing in the pipeline reads the flag.
import { setting } from "../data/control/index.ts";
import { loadMentionCounts, loadMentionsOfItems, loadMessageMentions, setSignals } from "../data/discord/index.ts";
import { loadStepSpend, removeRunTexts } from "../data/inference/index.ts";
import { loadShown } from "../data/mirror/index.ts";
import { jevAvailable } from "../agents/jev.ts";
import { runModelStep, type ClaudeStep, type JevStep } from "../agents/step.ts";
import { jevRequestOf } from "../prompts/index.ts";
import type { DiscordKeys } from "./keys.ts";
import { jevSignal, parseSignal, signalBand, signalState, type SignalAsk } from "./signal-ask.ts";
import { isWatched, mentionLinks, trackedRepos, type DiscordLink } from "./store.ts";
import { messageText, parseRefs, type ItemKey } from "./refs.ts";
import type { Db } from "../db/index.ts";
import { DISCORD_TAKE_WAIT_MS } from "./limits.ts";
import { WindowLimits } from "./window-limit.ts";

export const SIGNAL_CAP_KEY = "discord_signal_daily_usd";
export const DEFAULT_SIGNAL_CAP_USD = 1;
/** A message that names more items than this is not a request about any one of them: it is not checked. */
const MAX_ITEMS = 5;
/** Checks per minute per author and per channel (keyed hashes, in memory); a message over a limit stays a plain mention. */
const AUTHOR_LIMIT = { n: 10, ms: 60_000 };
const CHANNEL_LIMIT = { n: 30, ms: 60_000 };
/** Model calls at once; later checks wait their turn. */
const MAX_CALLS = 2;

/** The model calls; tests replace them. Jev gives the yes-probability, Haiku the answer; null when there was none. */
export type Judge = { jev: (db: Db, ask: SignalAsk) => Promise<number | null>; haiku: (db: Db, ask: SignalAsk) => Promise<boolean | null> };

const JEV_STEP: JevStep<SignalAsk, number> = {
  provider: "jev", id: "discord.signal.jev",
  request: (a) => ({ item: { ref: a.ref }, body: JSON.stringify({ ...jevRequestOf("discord.signal.jev"), state: signalState(a) }) }),
  parse: (answers, _a, ctx) => {
    const p = ctx.code === 0 ? jevSignal(answers) : null;
    return p === null ? null : { value: p };
  },
};
const HAIKU_STEP: ClaudeStep<SignalAsk, boolean> = {
  provider: "claude", id: "discord.signal.haiku",
  toPrompt: (a) => [a],
  parse: async (text) => {
    const v = parseSignal(text);
    return v === null ? null : { value: v };
  },
};

export const modelJudge: Judge = {
  jev: async (db, a) => {
    const r = await runModelStep(db, JEV_STEP, a);
    return r.ok ? r.value : null;
  },
  haiku: async (db, a) => {
    const r = await runModelStep(db, HAIKU_STEP, a, { maxWaitMs: DISCORD_TAKE_WAIT_MS });
    return r.ok ? r.value : null;
  },
};

export async function signalCapUsd(db: Db): Promise<number> {
  const v = Number(await setting(db, SIGNAL_CAP_KEY));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_SIGNAL_CAP_USD;
}

/** What today's (UTC) signal calls cost, from the agent runs. */
export async function signalSpentUsd(db: Db, now: number): Promise<number> {
  const day = new Date(now).toISOString().slice(0, 10);
  return (await loadStepSpend(db, ["discord-signal"], day)).get("discord-signal") ?? 0;
}

/** The prompt and reply of a signal call hold the message. Rows of finished calls are removed; `all` (at startup, when no call can be running) removes every row. */
export async function dropSignalTexts(db: Db, all = false): Promise<void> {
  await removeRunTexts(db, { steps: ["discord-signal"], finishedOnly: !all });
}

export type SignalDeps = { db: Db; keys: DiscordKeys; log: (line: string) => void; judge?: Judge; now?: () => number };
type Msg = { id: string; channel_id: string; content?: string; message_snapshots?: { message?: { content?: string } }[]; type?: number; webhook_id?: string; edited_timestamp?: string | null; author?: { id: string; bot?: boolean } };

export class Signals {
  #d: SignalDeps;
  #chain = new Map<string, Promise<void>>();
  #limits = new WindowLimits();
  #running = 0;
  #waiting: (() => void)[] = [];

  constructor(deps: SignalDeps) {
    this.#d = deps;
  }

  /** Resolves when the work started so far has finished; for tests. */
  async idle(): Promise<void> {
    while (this.#chain.size) await Promise.all([...this.#chain.values()]);
  }

  /** Gateway events, handled after the mention rows changed. Returns at once; the work never throws. */
  async dispatch(type: string, d: unknown): Promise<void> {
    if (type !== "MESSAGE_CREATE" && type !== "MESSAGE_UPDATE") return;
    const m = d as Msg;
    const text = messageText(m);
    if (typeof m.id !== "string" || typeof m.channel_id !== "string" || !text) return;
    if (m.author?.bot || m.webhook_id || (m.type !== undefined && m.type !== 0 && m.type !== 19)) return;
    // An update without an edit time is Discord adding a link preview: the text is the same.
    if (type === "MESSAGE_UPDATE" && !m.edited_timestamp) return;
    if (!await isWatched(this.#d.db, m.channel_id)) return;
    // Only a message that names one to MAX_ITEMS items is checked, so only those use up the limits.
    const refs = parseRefs(text, await trackedRepos(this.#d.db));
    if (!refs.length || refs.length > MAX_ITEMS) return;
    if (!this.#allow(m.author?.id ? this.#d.keys.hash("author", m.author.id) : "", this.#d.keys.hash("channel", m.channel_id))) return;
    const hash = this.#d.keys.hash("message", m.id);
    // An edit that arrives during a call waits for it, so the later text decides.
    const run = (this.#chain.get(hash) ?? Promise.resolve()).then(() => this.#check(hash, text, refs)).catch((e: Error) => this.#d.log(`discord: signal check failed: ${e.message.slice(0, 200)}`));
    const tail: Promise<void> = run.finally(() => { if (this.#chain.get(hash) === tail) this.#chain.delete(hash); });
    this.#chain.set(hash, tail);
  }

  /** Sliding-window limits per author and channel; a refused message is not counted. */
  #allow(author: string, channel: string): boolean {
    return this.#limits.allow((this.#d.now ?? Date.now)(), [{ key: `a:${author}`, ...AUTHOR_LIMIT }, { key: `c:${channel}`, ...CHANNEL_LIMIT }]);
  }

  async #slot<T>(f: () => Promise<T>): Promise<T> {
    if (this.#running >= MAX_CALLS) await new Promise<void>((r) => this.#waiting.push(r));
    else this.#running++;
    try { return await f(); } finally {
      const next = this.#waiting.shift();
      if (next) next(); else this.#running--;
    }
  }

  async #check(hash: string, text: string, refs: ItemKey[]): Promise<void> {
    const { db } = this.#d;
    const [shown, mentions] = await db.together(() => Promise.all([loadShown(db, refs.map((r) => ({ repo: r.repo, number: r.number }))), loadMessageMentions(db, [hash])]));
    const named = new Set((mentions.get(hash) ?? []).map((m) => `${m.repo}#${m.number}`));
    const verdicts: { msgHash: string; repo: string; number: number; signal: boolean }[] = [];
    for (const r of refs) {
      const key = `${r.repo}#${r.number}`;
      // No row: the message was deleted, or the item is not named any more.
      if (!shown.has(key) || !named.has(key)) continue;
      const v = await this.#asks({ ref: key, title: shown.get(key)!.title ?? "", text });
      if (v !== null) verdicts.push({ msgHash: hash, repo: r.repo, number: r.number, signal: v });
    }
    // A delete during the calls removed the rows, so this changes nothing then.
    await setSignals(db, verdicts);
  }

  /** True when the message asks for attention, false when it does not, null when no model answered (the flag stays as it was). */
  async #asks(a: SignalAsk): Promise<boolean | null> {
    return this.#slot(() => this.#decide(a));
  }

  async #decide(a: SignalAsk): Promise<boolean | null> {
    const { db, log } = this.#d;
    const judge = this.#d.judge ?? modelJudge;
    try {
      // The daily cap comes first: a spent cap (or a cap of 0) makes no Jev or model call.
      if (await signalSpentUsd(db, (this.#d.now ?? Date.now)()) >= await signalCapUsd(db)) return null;
      if (await jevAvailable(db)) {
        const p = await judge.jev(db, a);
        const band = p === null ? "unsure" : signalBand(p);
        if (band === "yes") return true;
        if (band === "no") return false;
      }
      return await judge.haiku(db, a);
    } catch (e) {
      log(`discord: signal model call failed: ${(e as Error).message.slice(0, 200)}`);
      return null;
    } finally {
      try { await dropSignalTexts(db); } catch (e) { log(`discord: removing signal texts failed: ${(e as Error).message}`); }
    }
  }
}


/** Messages that asked for attention on an item, newest first. Empty when the key is missing or a row does not open. */
export async function signalLinks(db: Db, keys: DiscordKeys | null, repo: string, number: number): Promise<DiscordLink[]> {
  if (!keys) return [];
  return mentionLinks(keys, ((await loadMentionsOfItems(db, [`${repo}#${number}`])).get(`${repo}#${number}`) ?? []).filter((r) => r.signal));
}

export const signalCountOf = async (db: Db, repo: string, number: number): Promise<number> =>
  (await loadMentionCounts(db, [`${repo}#${number}`])).get(`${repo}#${number}`)?.signals ?? 0;
