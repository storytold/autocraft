// `ask <question>` on every surface (a GitHub comment to the app, a Discord @-command, the item's chat): the question becomes the asker's
// message in the item's Opus conversation, answered by the Conversation step as any message to Opus is (src/conversations/run.ts): an
// operator's on the shared model queue, a maintainer's on their own Task Runner. Opus reads the item, its discussion and its code and
// changes nothing; its cards wait in the item's chat for someone to press them.
//
// The answer goes back where the question was asked (answerAsked): the dashboard chat shows the reply turn itself; a GitHub question is
// answered with a reply comment through the command drain (src/github/commands.ts), whose answer write goes through write.ts. Text that
// reply lint finds a problem in is not posted: the reply names the item's chat instead.
import { loadTurnMessage } from "../data/chat/index.ts";
import { countAskedTurns, ConversationError } from "../data/conversations/index.ts";
import { settleAsked } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";
import { t } from "../i18n/index.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { tierOfModel } from "../remote/mode.ts";
import { ownTaker } from "../remote/takers.ts";
import { isEnabled, pauseReason } from "../runner/autopilot.ts";
import { itemPath } from "../../web/src/lib/links.ts";
import { addMessage, type StoreDeps } from "./store.ts";

const CONVERSATION_PROMPT_ID = "conversation.turn";
/** The step that answers maintainers' messages (src/runner/steps.ts). */
const MAINTAINER_STEP = "conversation-maintainer";

/** Who asks: an operator's question runs on the shared model queue, a maintainer's on their own Task Runner. */
export type Asker = { login: string; operator: boolean };

/** The refusal of a maintainer's message to Opus while none of their Task Runners may take it (src/remote/takers.ts). */
export const NO_OWN_RUNNER = "Your Task Runner must be connected and ready to ask Opus. You can still post without Opus.";

/** Questions a person may put to Opus per hour and per day. */
export const ASK_LIMITS = { hour: 10, day: 50 } as const;
export const ASK_LIMITED = "Too many questions to Opus. Try again later.";

/** Whether the person has put ASK_LIMITS questions to Opus in the last hour or day. */
export async function askLimited(db: Db, login: string): Promise<boolean> {
  const count = (ms: number) => countAskedTurns(db, login, new Date(Date.now() - ms).toISOString());
  return await count(3_600_000) >= ASK_LIMITS.hour || await count(86_400_000) >= ASK_LIMITS.day;
}

/** Why a maintainer's message to Opus would not be answered now, or null: the pipeline is off or draining, its step is paused, or none of their Task Runners is ready. */
export async function ownAskRefusal(db: Db, login: string, repo: string): Promise<string | null> {
  if (!await isEnabled(db)) return "The pipeline is off, so Opus cannot answer now. You can still post without Opus.";
  const paused = await pauseReason(db, MAINTAINER_STEP, Date.now(), { backoff: false });
  if (paused) return `Opus cannot answer now: ${paused}. You can still post without Opus.`;
  return await ownTaker(db, login, { prompt_id: CONVERSATION_PROMPT_ID, repos: [repo], tier: tierOfModel(CLAUDE_PROMPTS[CONVERSATION_PROMPT_ID].models[0]!) }) ? null : NO_OWN_RUNNER;
}

/**
 * Puts the question to Opus as the asker's message on the item. Returns the turn it created, or why the question was not asked: a
 * maintainer's refusal (ownAskRefusal), an open question Opus has not answered, or a message Opus cannot take. `limit`: also refuse past
 * ASK_LIMITS (the dashboard checks the limit itself, with its own status code).
 */
export async function askQuestion(db: Db, who: Asker, repo: string, n: number, question: string, o: { limit?: boolean; deps?: StoreDeps } = {}): Promise<{ turnId: number } | { refusal: string }> {
  if (o.limit && await askLimited(db, who.login)) return { refusal: ASK_LIMITED };
  const refused = who.operator ? null : await ownAskRefusal(db, who.login, repo);
  if (refused) return { refusal: refused };
  try {
    return { turnId: await addMessage(db, repo, n, { login: who.login, kind: who.operator ? "operator" : "maintainer" }, question, o.deps, true) };
  } catch (e) {
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

/**
 * Sends the end of a question turn where the question was asked. `text`: Opus's answer; `error`: why there is none. `clean`: whether
 * reply lint passed the answer for public text (src/reference-lint.ts); an answer it did not pass is replaced by chatPointer. Only a
 * question asked in a GitHub comment has anything to send: a dashboard question's answer is the reply turn in the item's chat. Returns
 * where it went.
 */
export async function answerAsked(db: Db, o: { repo: string; n: number; turnId: number; text?: string; error?: string; clean?: () => Promise<boolean>; at?: string }): Promise<"github" | "none"> {
  const m = await loadTurnMessage(db, o.turnId);
  if (!m || m.via !== "github" || m.githubCommentId === null) return "none";
  const at = o.at ?? new Date().toISOString();
  const result = o.text !== undefined
    ? (o.clean && !await o.clean() ? chatPointer(o.repo, o.n) : o.text)
    : t("Opus did not answer: {why}.", { why: (o.error ?? "").replace(/[.\s]+$/, "") || t("no reply") });
  return await settleAsked(db, m.githubCommentId, { state: o.text !== undefined ? "done" : "refused", result, at }) ? "github" : "none";
}
