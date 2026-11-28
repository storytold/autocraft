// Opus conversations on items. Everyone who may see the repo reads them. Operators write to Opus, and so do maintainers with
// write access to the repo, whose messages run on their own Task Runners.
import type { ConversationCard } from "../../../web/src/api/types.ts";
import { actionRefusal, buttonLabel, cardEffect, cardLines, cardRepos, commandText, followupsOf, headline, isRegistry, readParams, type CardParams } from "../../conversations/cards.ts";
import { queueReason } from "../../conversations/queue.ts";
import { cardDigest, type CardRow } from "../../conversations/act.ts";
import { loadStale, withdrawTurn, type Stale, type StoreDeps } from "../../conversations/store.ts";
import { ASK_LIMITED, askLimited, askQuestion, withdrawnAsked } from "../../conversations/ask.ts";
import { ConversationError, loadQueue, type Queue } from "../../data/conversations/index.ts";
import { HttpError } from "../server/util.ts";
import type { Req, User } from "../types.ts";
import { loadQuiet } from "../../data/security/index.ts";
import { listWorkflows } from "../../data/workflow/index.ts";
import { PERM_READ_TTL } from "../server/sessions.ts";
import { githubIdentity } from "../../github/identity.ts";
import { canActMany, permKey } from "../../data/access/index.ts";
import { mayRunRepo } from "../repo-access.ts";
import type { Db } from "../../db/index.ts";

const isOperator = (req: Req): boolean => req.user.role === "operator";

/**
 * Whether the user may write to Opus on an item of `repo`: an operator, or a maintainer with write permission on the repo, read
 * live as the act rule reads it. A maintainer's turn runs on their own Task Runner. Talking writes nothing to GitHub, so the act
 * rule's app-identity condition does not apply.
 */
export async function canTalk(_db: Db, user: Pick<User, "role" | "canWrite">, repo: string): Promise<boolean> {
  if (user.role === "operator") return true;
  return await mayRunRepo(user, repo);
}

export { NO_OWN_RUNNER } from "../../conversations/ask.ts";

async function guard<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ConversationError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** Without `canWrite` the stored permissions count as they are. */
type Viewer = { login: string; role: string; canWrite?: (repo: string) => Promise<boolean> };
const refOf = (x: { repo: string; number: number }): string => `${x.repo}#${x.number}`;
/** What the views of several cards share. */
type CardsView = {
  queue: Queue; stale: Map<number, Stale>;
  /** Items ("repo#n") whose pull request is quiet, and when each item's live recommendation was written. */
  quiet: ReadonlySet<string>; recAt: Map<string, string | null>;
  /** The repos of the cards the viewer may act on. */
  mayAct: ReadonlySet<string>;
};

/**
 * The repos of `cards` the viewer may act on by the act rule. A permission too old to count is read from GitHub first, so the buttons
 * do not go when the stored one ages; an operator keeps them when GitHub does not answer. Each press checks live.
 */
async function mayActOn(db: Db, cards: CardRow[], who: Viewer | undefined): Promise<Set<string>> {
  const repos = [...new Set(cards.flatMap((c) => { const p = readParams(c.kind, c.params); return p ? cardRepos(c.repo, p) : []; }))];
  if (!who || (who.role !== "operator" && who.role !== "maintainer") || !repos.length) return new Set();
  if (who.canWrite) await Promise.all(repos.map((r) => who.canWrite!(r).catch(() => false)));
  const identity = await githubIdentity(db);
  const verdicts = await canActMany(db, repos.map((repo) => ({ login: who.login, repo })), { identity, mode: "cached", maxAgeMs: PERM_READ_TTL });
  return new Set(repos.filter((repo) => {
    const v = verdicts.get(permKey(who.login, repo));
    return v?.ok === true || (who.role === "operator" && identity === "app" && v?.ok === false && v.why === "stale");
  }));
}

const cardsView = async (db: Db, cards: CardRow[], who?: Viewer): Promise<CardsView> => {
  const proposed = cards.filter((c) => c.state === "proposed");
  const keys = [...new Set(proposed.map(refOf))];
  const refs = [...new Map(proposed.map((c) => [refOf(c), { repo: c.repo, number: c.number }])).values()];
  const [queue, stale, quiet, flows, mayAct] = await Promise.all([
    loadQueue(db), loadStale(db, proposed), keys.length ? loadQuiet(db, keys) : [], refs.length ? listWorkflows(db, { live: true, refs }) : [], mayActOn(db, cards, who),
  ]);
  return { queue, stale, mayAct, quiet: new Set(quiet), recAt: new Map(flows.map((w) => [refOf(w), w.recAt])) };
};

/** One card's view. A card of the retired decision system shows its stored line and its result only. */
export const cardView = async (db: Db, c: CardRow, who?: Viewer): Promise<ConversationCard> => viewOf(c, await cardsView(db, [c], who));

function viewOf(c: CardRow, v: CardsView): ConversationCard {
  const params = readParams(c.kind, c.params);
  const effect = params ? cardEffect(params) : null;
  const issue = params ? issueOf(params) : undefined;
  const command = params ? commandText(params) : undefined;
  const refusal = params && c.state === "proposed" ? actionRefusal(params, { quiet: v.quiet.has(refOf(c)), recAt: v.recAt.get(refOf(c)) ?? null }) : null;
  const stale = c.state === "proposed" ? v.stale.get(c.id) : undefined;
  const one = (t: string) => t.replace(/\s+/g, " ").trim();
  const preview = c.text && one(c.text) ? `Comment: ${one(c.text)}` : issue ? `Issue: ${one(issue.title)}` : undefined;
  const repos = params ? cardRepos(c.repo, params) : [];
  const place = c.state === "queued" ? v.queue.rows.find((r) => r.id === c.id)?.place ?? null : null;
  return {
    steps: params ? cardLines(params) : [c.description],
    ...(command !== undefined && { command }),
    ...(refusal && { refusal }),
    ...(stale && { stale }),
    label: params ? buttonLabel(params) : c.description,
    headline: params ? headline(params) : c.description,
    ...(preview && { preview }),
    canSettle: repos.length > 0 && repos.every((r) => v.mayAct.has(r)),
    id: c.id, kind: params?.kind ?? "comment", title: c.description, state: c.state as ConversationCard["state"], digest: cardDigest(c),
    ...(c.text !== null && { text: c.text }),
    ...(effect && { writes: effect }),
    ...(c.state === "done" && { done: { at: c.acted_at ?? "", link: c.result_url ?? "", label: c.result ?? "Done" } }),
    ...(c.state === "failed" && c.error && { error: c.error }),
    ...(c.state === "queued" && { queued: { place, reason: queueReason(place) } }),
    ...(c.acted_by && { by: c.acted_by }),
    ...(c.acted_at && { at: c.acted_at }),
    ...(c.edited_by && { edited: true, editedBy: c.edited_by }),
  };
}

/** The issue draft a card carries: the first a merge holds, or the one it would open. */
function issueOf(p: CardParams): { title: string } | undefined {
  return followupsOf(p)[0] ?? (p.kind === "command" && !isRegistry(p.command) && p.command.word === "open_issue" ? p.command : undefined);
}

/** Throws 429 when the user has put ASK_LIMITS questions to Opus in the last hour or day. */
export async function assertAskRate(db: Db, login: string): Promise<void> {
  if (await askLimited(db, login)) throw new HttpError(429, ASK_LIMITED);
}

/**
 * Puts a question to Opus on the sender's own runner, for a message the chat has stored already. Returns the turn it created, or why
 * the question was not asked (the message stays in the chat): see askQuestion.
 */
export async function askOpus(db: Db, req: Req, repo: string, n: number, body: string, deps?: StoreDeps): Promise<{ turnId: number } | { refusal: string }> {
  return await askQuestion(db, { login: req.user.login, operator: isOperator(req) }, repo, n, body, deps ? { deps } : {});
}

/** Withdraws the message on the item that waits for Opus, as the reader: an operator, or the person who wrote it. A question asked on GitHub or Discord then gets no answer there. */
export async function withdrawMessage(db: Db, req: Req, repo: string, n: number): Promise<void> {
  const turnId = await guard(async () => await withdrawTurn(db, repo, n, { login: req.user.login, operator: isOperator(req) }));
  await withdrawnAsked(db, turnId, `withdrawn by ${req.user.login}`);
}
