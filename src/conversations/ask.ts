// `ask <question>` on every surface (a GitHub comment to the app, a Discord @-command, the item's chat): the question becomes the asker's
// message in the item's Opus conversation, answered by the Conversation step as any message to Opus is (src/conversations/run.ts): an
// operator's on the shared model queue, a maintainer's on their own Task Runner. Opus reads the item, its discussion and its code and
// changes nothing; its cards wait in the item's chat for someone to press them.
//
// A question asked on Discord runs on the conversation.turn prompt under its Interactive id (interactive.conversation-turn), so its call
// takes only Interactive slots: a maintainer's on their own Task Runner, which needs at least one such slot.
//
// The answer goes back where the question was asked (answerAsked): the dashboard chat shows the reply turn itself; a GitHub question is
// answered with a reply comment through the command drain (src/github/commands.ts), whose answer write goes through write.ts; a Discord
// question's answer is kept on its chat message beside the sealed place it was asked, for the Discord process to post
// (src/discord/answers.ts). Text that reply lint finds a problem in, or that it could not check, is not posted: the reply names the
// item's chat instead. Posted text is cleaned as Opus reviews are (stripLinks): no mentions, raw HTML, images, links outside the repo's
// owner or references that link another thread. A question withdrawn in the item's chat is answered nowhere (withdrawnAsked). The
// message a question came in is linked to its turn in the transaction that stores the turn, with the Discord place it was asked, so
// the Conversation step always knows where the answer goes; a turn that ended without its answer sent is swept (lostAnswer).
import { loadTurnMessage, setPayloadFields } from "../data/chat/index.ts";
import { countAskedTurns, ConversationError } from "../data/conversations/index.ts";
import { loadAskedCommands, settleAsked } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";
import { t } from "../i18n/index.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { userInteractiveSlots } from "../remote/interactive-slots.ts";
import { tierOfModel } from "../remote/mode.ts";
import { ownTaker } from "../remote/takers.ts";
import { isEnabled, pauseReason } from "../runner/autopilot.ts";
import { ownerOf } from "../owners.ts";
import { stripLinks } from "../review/post-template.ts";
import { itemPath } from "../../web/src/lib/links.ts";
import { addMessage, type StoreDeps } from "./store.ts";

/** The step that answers maintainers' messages (src/runner/steps.ts). */
const MAINTAINER_STEP = "conversation-maintainer";

/** The prompt that answers a message: a question asked on Discord takes Interactive slots. */
export const conversationPromptId = (via: string | null | undefined): "conversation.turn" | "interactive.conversation-turn" =>
  via === "discord" ? "interactive.conversation-turn" : "conversation.turn";

/** Who asks: an operator's question runs on the shared model queue, a maintainer's on their own Task Runner. */
export type Asker = { login: string; operator: boolean };

/** The refusal of a maintainer's message to Opus while none of their Task Runners may take it (src/remote/takers.ts). */
export const NO_OWN_RUNNER = "Your Task Runner must be connected and ready to ask Opus. You can still post without Opus.";
/** The refusal of a maintainer's Discord question while they keep no Interactive slots. */
export const NO_INTERACTIVE_SLOTS = "Questions from Discord run in your Task Runner's Interactive slots, and you have none. Set them on the Connect page, under My settings.";

/** Questions a person may put to Opus per hour and per day. */
export const ASK_LIMITS = { hour: 10, day: 50 } as const;
export const ASK_LIMITED = "Too many questions to Opus. Try again later.";

/** Whether the person has put ASK_LIMITS questions to Opus in the last hour or day. */
export async function askLimited(db: Db, login: string): Promise<boolean> {
  const count = (ms: number) => countAskedTurns(db, login, new Date(Date.now() - ms).toISOString());
  return await count(3_600_000) >= ASK_LIMITS.hour || await count(86_400_000) >= ASK_LIMITS.day;
}

/**
 * Why a maintainer's message to Opus would not be answered now, or null: the pipeline is off or draining, its step is paused, none of
 * their Task Runners is ready, or, for a question from Discord, they keep no Interactive slots.
 */
export async function ownAskRefusal(db: Db, login: string, repo: string, via?: string): Promise<string | null> {
  if (!await isEnabled(db)) return "The pipeline is off, so Opus cannot answer now. You can still post without Opus.";
  const paused = await pauseReason(db, MAINTAINER_STEP, Date.now(), { backoff: false });
  if (paused) return `Opus cannot answer now: ${paused}. You can still post without Opus.`;
  if (via === "discord" && await userInteractiveSlots(db, login, "maintainer") < 1) return NO_INTERACTIVE_SLOTS;
  const id = conversationPromptId(via);
  return await ownTaker(db, login, { prompt_id: id, repos: [repo], tier: tierOfModel(CLAUDE_PROMPTS[id].models[0]!) }) ? null : NO_OWN_RUNNER;
}

/** A question whose message could not be linked to its turn, which rolls the turn back. */
class NotLinked extends Error {}
const NOT_LINKED = t("Nothing was asked: the message the question came in was not found. Send it again.");

/**
 * Puts the question to Opus as the asker's message on the item. Returns the turn it created, or why the question was not asked: a
 * maintainer's refusal (ownAskRefusal), an open question Opus has not answered, or a message Opus cannot take. `limit`: also refuse past
 * ASK_LIMITS (the dashboard checks the limit itself, with its own status code). `via`: the surface, when it changes the refusals (Discord).
 * `linked`: links the message the question came in to the turn, in the transaction that stores the turn; when it finds no message to
 * link (false) or throws, nothing is asked.
 */
export async function askQuestion(db: Db, who: Asker, repo: string, n: number, question: string, o: { limit?: boolean; deps?: StoreDeps; via?: "discord"; linked?: (turnId: number) => Promise<boolean> } = {}): Promise<{ turnId: number } | { refusal: string }> {
  if (o.limit && await askLimited(db, who.login)) return { refusal: ASK_LIMITED };
  const refused = who.operator ? null : await ownAskRefusal(db, who.login, repo, o.via);
  if (refused) return { refusal: refused };
  try {
    const linked = o.linked && (async (turnId: number): Promise<void> => { if (!await o.linked!(turnId)) throw new NotLinked(); });
    return { turnId: await addMessage(db, repo, n, { login: who.login, kind: who.operator ? "operator" : "maintainer" }, question, o.deps, true, linked) };
  } catch (e) {
    if (e instanceof NotLinked) return { refusal: NOT_LINKED };
    if (e instanceof ConversationError && (e.status === 409 || e.status === 400)) return { refusal: e.message };
    throw e;
  }
}

/** The line a GitHub or Discord reply carries when the answer itself is not posted: where to read it. */
export function chatPointer(repo: string, n: number, base: string | null = envVar("BASE_URL")?.replace(/\/+$/, "") || null): string {
  return base
    ? t("The answer is in the item's chat on AutoCraft: {url}", { url: `${base}${itemPath(repo, n)}` })
    : t("The answer is in the item's chat on AutoCraft.");
}

/** Whether a question's answer is posted in public, so its prompt holds none of the chat's earlier turns: one from GitHub or Discord. */
export const publicQuestion = (m: { via: string; githubCommentId: number | null } | null): boolean => !!m && (m.via === "discord" || (m.via === "github" && m.githubCommentId !== null));

/** Opus's answer as posted on GitHub or Discord, cleaned as an Opus review is (stripLinks); "" when nothing is left of it. */
export const publicAnswer = (text: string, repo: string): string => stripLinks(text.trim(), ownerOf(repo)).trim();

/** A Discord question's payload fields (src/discord/answers.ts): `answerTo`, the sealed place it was asked; `answer`, the text to post there; `answered`, posted or not to be. */
export type DiscordAsked = { answerTo?: string; answer?: string; answered?: true };

const discordAsked = (payload: unknown): DiscordAsked => (payload && typeof payload === "object" && !Array.isArray(payload) ? payload as DiscordAsked : {});

/** The line that says why a question got no answer. */
const noAnswer = (error: string | null | undefined): string => t("Opus did not answer: {why}.", { why: (error ?? "").replace(/[.\s]+$/, "") || t("no reply") });

/**
 * Sends the end of a question turn where the question was asked. `text`: Opus's answer, written by `model`; `error`: why there is none.
 * `clean`: whether reply lint passed the answer for public text (src/reference-lint.ts); an answer it did not pass, or could not check
 * (it threw), is replaced by chatPointer, and so is one that cleaning (publicAnswer) leaves empty. A question asked in a GitHub comment
 * settles its command; one asked on Discord keeps the text on its message, for the Discord process; a dashboard question's answer is
 * the reply turn in the item's chat. Returns where it went.
 */
export async function answerAsked(db: Db, o: { repo: string; n: number; turnId: number; text?: string; model?: string; error?: string; clean?: () => Promise<boolean>; at?: string }): Promise<"github" | "discord" | "none"> {
  const m = await loadTurnMessage(db, o.turnId);
  const discord = m?.via === "discord" ? discordAsked(m.payload) : null;
  if (!m || !(m.via === "github" && m.githubCommentId !== null) && !(discord?.answerTo && !discord.answered && discord.answer === undefined)) return "none";
  const at = o.at ?? new Date().toISOString();
  const passed = o.text !== undefined && (!o.clean || await o.clean().catch(() => false));
  const answer = passed ? publicAnswer(o.text!, o.repo) : "";
  const result = o.text === undefined ? noAnswer(o.error) : answer || chatPointer(o.repo, o.n);
  if (discord) return await setPayloadFields(db, m.id, { answer: result }) ? "discord" : "none";
  return await settleAsked(db, m.githubCommentId!, { state: o.text !== undefined ? "done" : "refused", result, at, ...(answer && o.model ? { model: o.model } : {}) }) ? "github" : "none";
}

/** How long a question turn may have ended without its answer sent where it was asked before the sweep sends one: reply lint may take minutes. */
export const LOST_ANSWER_MS = 15 * 60_000;
const endedSince = new Map<string, number>();

/**
 * What to send for a question whose turn ended (or is gone) while its answer never reached where it was asked: a crash or a failed
 * write between the reply and answerAsked. `key` names the question on its surface. Null while the turn still runs, and for
 * LOST_ANSWER_MS after the sweep first saw it ended, so answerAsked gets there first; then the pointer to the item's chat for an
 * answered turn, or why there is no answer. Called again for the same key after that, it gives the same text.
 */
export function lostAnswer(key: string, turn: { status: string | null; error: string | null }, repo: string, n: number, now = Date.now()): { state: "done" | "refused"; result: string } | null {
  if (turn.status === "pending" || turn.status === "answering") { endedSince.delete(key); return null; }
  const since = endedSince.get(key);
  if (since === undefined) { endedSince.set(key, now); return null; }
  if (now - since < LOST_ANSWER_MS) return null;
  endedSince.delete(key);
  return turn.status === "answered" ? { state: "done", result: chatPointer(repo, n) } : { state: "refused", result: noAnswer(turn.error ?? (turn.status === null ? t("the question was lost") : null)) };
}

/** When the first question of the surface (`prefix` of its keys) seen ended has waited out LOST_ANSWER_MS, or null: the Discord process runs a pass then. */
export function lostAnswerDue(prefix: string): number | null {
  let first: number | null = null;
  for (const [k, at] of endedSince) if (k.startsWith(prefix) && (first === null || at < first)) first = at;
  return first === null ? null : first + LOST_ANSWER_MS;
}

/** Forgets the questions of the surface that a sweep no longer found waiting (answered or settled meanwhile). */
export function keepLostKeys(prefix: string, seen: ReadonlySet<string>): void {
  for (const k of endedSince.keys()) if (k.startsWith(prefix) && !seen.has(k)) endedSince.delete(k);
}

/** Settles the GitHub commands whose question turn ended without its answer sent (lostAnswer), for the drain to post. Returns how many. */
export async function sweepAskedCommands(db: Db, now = Date.now()): Promise<number> {
  let settled = 0;
  const seen = new Set<string>();
  for (const r of await loadAskedCommands(db)) {
    const key = `github:${r.commentId}`;
    seen.add(key);
    const lost = lostAnswer(key, { status: r.turnStatus, error: r.turnError }, r.repo, r.number, now);
    if (lost && await settleAsked(db, r.commentId, { ...lost, at: new Date(now).toISOString() })) settled++;
  }
  keepLostKeys("github:", seen);
  return settled;
}

/** Ends a question withdrawn in the item's chat where it was asked, posting nothing there: a GitHub command is refused with `why`, a Discord question is answered. */
export async function withdrawnAsked(db: Db, turnId: number, why: string): Promise<void> {
  const m = await loadTurnMessage(db, turnId);
  if (m?.via === "github" && m.githubCommentId !== null) await settleAsked(db, m.githubCommentId, { state: "refused", result: why, at: new Date().toISOString(), reply: false });
  else if (m?.via === "discord" && discordAsked(m.payload).answerTo) await setPayloadFields(db, m.id, { answered: true });
}
