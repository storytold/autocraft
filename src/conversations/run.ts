// The Conversation step: answers each person's message that waits for Opus with one sandboxed `claude -p` call
// (the item's repository and the workspace, read-only) and stores the reply with its action cards. An operator's message is a
// call of the shared model queue; a maintainer's runs only on the maintainer's own Task Runners (a call bound to their login).
// A message put as a question from GitHub or Discord (src/conversations/ask.ts) gets its answer, or why there is none, sent back there;
// one from Discord runs as interactive.conversation-turn, in Interactive slots.
import { jobItem } from "../runner/job-items.ts";
import { referenceDir } from "../reference.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { NoTakerError, WaitLimitError, poolRoom, takersFirst, type PoolRoom } from "../agents/call.ts";
import { tierOfModel } from "../remote/mode.ts";
import { scaled } from "../remote/time-scale.ts";
import type { PersonKind } from "./types.ts";
import { ownTaker } from "../remote/takers.ts";
import { pool } from "../classify/run.ts";
import { runModelStep } from "../agents/step.ts";
import { CONVERSATION, CONVERSATION_INTERACTIVE } from "../agents/steps.ts";
import { PROGRESS_KEEP, coalesce } from "../classify/progress.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { defaultSemanticDeps, referenceProblems, type SemanticDeps } from "../reference-lint.ts";
import { needsFixTurn } from "../replylint.ts";
import { answerAsked, conversationPromptId, NO_INTERACTIVE_SLOTS } from "./ask.ts";
import { loadTurnMessage } from "../data/chat/index.ts";
import { userInteractiveSlots } from "../remote/interactive-slots.ts";
import { sweepRunningCards } from "./act.ts";
import { claimPending, failTurn, pendingConversations, promptParts, refreshItem, releaseTurn, setTurnProgress, storeReply, type DiffSource } from "./store.ts";
import type { Db } from "../db/index.ts";

export const CONVERSATION_PROMPT = CLAUDE_PROMPTS["conversation.turn"];

export type ConversationParams = {
  /** Most messages to answer in this run. */
  limit?: number;
  model?: string;
  /** Read-only checkout of the repo's default branch, or null to ask without tools. */
  checkout: (repo: string) => Promise<string | null>;
  diff?: DiffSource;
  usageRun: string;
  onHandled?: (n: number) => void;
  cancelled?: () => Promise<boolean>;
  log: (line: string) => void;
  /** The Jev and Haiku calls of the semantic reference check; absent: the real ones. */
  semantic?: SemanticDeps;
  /** Whose messages: operators' (the shared model queue) or maintainers' (each on the maintainer's own Task Runner); absent: both. */
  kind?: PersonKind;
  /** How long a maintainer's first call waits for their runner; absent: OWN_LEASE_WAIT_MS. */
  ownWaitMs?: number;
};

/** How long a maintainer's call waits for their own Task Runner to take it; then the message waits for a later job. */
export const OWN_LEASE_WAIT_MS = scaled(2 * 60_000);

const now = () => new Date().toISOString();

/** Why a maintainer's message got no reply when their own Task Runner could not take it. */
const ownRunnerGone = (login: string): string => `${login}'s Task Runner was not connected and ready; send the message again`;

/**
 * Answers the waiting messages (of `p.kind`), oldest first. Returns how many got a reply. A maintainer's message is bound to the
 * maintainer's own Task Runners, which take it beside their other calls: it fails at once when none of them is ready, and waits
 * for a later job when none took it within OWN_LEASE_WAIT_MS.
 */
export async function answerPending(db: Db, p: ConversationParams): Promise<number> {
  const model = p.model ?? CONVERSATION_PROMPT.models[0]!, tier = tierOfModel(model);
  let todo = await pendingConversations(db, undefined, p.kind);
  const ownerOf = (c: (typeof todo)[number]): string | undefined => (c.kind === "maintainer" ? c.login : undefined);
  if (p.limit !== undefined) todo = (await takersFirst(db, todo, (c) => [c.repo], (c) => [c], CONVERSATION_PROMPT.id)).slice(0, Math.max(0, p.limit));
  const checkouts = new Map<string, Promise<string | null>>();
  let answered = 0, handled = 0;
  // One running turn per maintainer login: the next one waits, so its reference check does not queue behind it on the same runner.
  const busy = new Set<string>();
  const loginOf = (i: number): string | undefined => ownerOf(todo[i]!)?.toLowerCase();
  await pool(todo.map((c, k) => async () => {
    const mine = ownerOf(c)?.toLowerCase();
    if (mine !== undefined) busy.add(mine);
    try {
    if (await p.cancelled?.()) return;
    const { repo, number: n } = c;
    // The item may have changed since the message was written; the update goes in front of the message.
    await refreshItem(db, repo, n, { diff: p.diff });
    // One run holds the message; another run or a second start skips it.
    const held = await claimPending(db, repo, n);
    if (!held) return;
    const { turn: wait, claim } = held;
    const forLogin = ownerOf(c);
    // A failed turn tells a GitHub question why it has no answer.
    const fail = async (why: string): Promise<void> => {
      if (await failTurn(db, repo, n, claim, why)) await answerAsked(db, { repo, n, turnId: wait.id, error: why }).catch((e: Error) => p.log(`conversation: ${repo}#${n}: answer not sent: ${e.message}`));
    };
    // An operator's message counts when claimed (the step's daily limit). A maintainer's counts once it has an outcome: one given
    // back for a later job is no work done, so the lane waits for its input to change instead of running again at once.
    let released = false;
    if (forLogin === undefined) p.onHandled?.(++handled);
    try {
      // A question asked on Discord takes Interactive slots only.
      const promptId = conversationPromptId((await loadTurnMessage(db, wait.id))?.via);
      if (forLogin !== undefined) {
        const why = promptId !== CONVERSATION_PROMPT.id && await userInteractiveSlots(db, forLogin, "maintainer") < 1 ? NO_INTERACTIVE_SLOTS
          : !await ownTaker(db, forLogin, { prompt_id: promptId, repos: [repo], tier }) ? ownRunnerGone(forLogin) : null;
        if (why) { await fail(why); return; }
      }
      const parts = await promptParts(db, repo, n, wait);
      if (!parts) { await fail("the conversation has no item block; send the message again"); return; }
      if (!checkouts.has(repo)) checkouts.set(repo, p.checkout(repo).catch(() => null));
      const checkout = await checkouts.get(repo)!;
      let recent: string[] = [];
      const shown = coalesce(async (lines: string[]) => await setTurnProgress(db, repo, n, claim, lines));
      const onProgress = async (line: string) => {
        if (recent.at(-1) === line) return;
        recent = [...recent, line].slice(-PROGRESS_KEEP);
        await shown.push(recent);
      };
      const dir = referenceDir(repo);
      // A maintainer's reference check runs on their own Task Runner too.
      const semantic = dir ? p.semantic ?? defaultSemanticDeps(db, `${repo}#${n}`, forLogin === undefined ? {} : { forLogin }) : undefined;
      const step = runModelStep(db, promptId === CONVERSATION_PROMPT.id ? CONVERSATION : CONVERSATION_INTERACTIVE, { ref: `${repo}#${n}`, item: parts.item, turns: parts.turns, ...(checkout && { repo_dir: REPO_PATH }) }, {
        model, ...(forLogin !== undefined && { forLogin, firstWaitMs: p.ownWaitMs ?? OWN_LEASE_WAIT_MS }), checkout: checkout ?? undefined, reference: checkout ? dir : undefined, onProgress, ctx: { db, repo, n, dir, semantic },
        usage: { run: p.usageRun, agent: `conversation-${String(k).padStart(3, "0")}`, stage: "conversation", items: () => 1 },
        onReply: (reply) => { if (reply.fixTurn) p.log(`conversation: ${repo}#${n}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`); },
      });
      let r: Awaited<typeof step>;
      try { r = await step; } catch (e) {
        if (forLogin === undefined || !(e instanceof NoTakerError || e instanceof WaitLimitError)) throw e;
        await shown.flush();
        // Their runners took nothing in time: the message waits for a later job, which does not hold this one.
        if (e instanceof WaitLimitError) { released = await releaseTurn(db, repo, n, claim); p.log(`conversation: ${repo}#${n}: ${forLogin}'s Task Runner did not take the message in time; it waits for a later run`); return; }
        // Their runners went away while the call waited (src/remote/takers.ts sweepTakers): only theirs could answer it.
        await fail(ownRunnerGone(forLogin));
        return;
      }
      await shown.flush();
      const parsed = r.ok ? r.value : null;
      if (parsed) {
        if (await storeReply(db, repo, n, claim, parsed.text, parsed.cards, parsed.notes, parts.seen) !== null) {
          answered++;
          await jobItem(db, repo, n, "answered a message", p.log);
          // The answer goes public only when reply lint finds nothing in it; otherwise the reply points to the item's chat.
          const clean = async () => !needsFixTurn(await referenceProblems([{ field: "text", text: parsed.text }], dir ?? undefined, semantic, { stage: "fix" }));
          await answerAsked(db, { repo, n, turnId: wait.id, text: parsed.text, clean }).catch((e: Error) => p.log(`conversation: ${repo}#${n}: answer not sent: ${e.message}`));
        }
      } else {
        await fail("Opus gave no usable reply; send the message again");
        await jobItem(db, repo, n, "no usable reply to a message", p.log);
      }
    } finally {
      if (forLogin !== undefined && !released) p.onHandled?.(++handled);
    }
    } finally {
      if (mine !== undefined) busy.delete(mine);
    }
  }), ownFirst(poolRoom(db, (i) => [todo[i]!.repo], (i) => [todo[i]!], { promptId: CONVERSATION_PROMPT.id }), (i) => ownerOf(todo[i]!) !== undefined, (i) => { const l = loginOf(i); return l !== undefined && busy.has(l); }), { first: p.kind !== "maintainer" });
  return answered;
}

/** The shared queue's room for the operators' messages; a maintainer's own message always has room and a taker, its own runners, which take it beside their other calls (checked when it starts). */
const ownFirst = (shared: PoolRoom, own: (i: number) => boolean, busy: (i: number) => boolean): PoolRoom => ({
  round: () => shared.round(),
  room: async (i) => (own(i) ? (busy(i) ? 0 : 1) : await shared.room(i)),
  taker: async (i) => own(i) || await shared.taker(i),
  changed: (pollMs, signal) => shared.changed(pollMs, signal),
  ...(shared.untaken && { untaken: (i: number) => shared.untaken!(i) }),
});

/** PR diffs from the diff cache or GitHub; null when unavailable. */
export const githubDiff = (db: Db): DiffSource => async (repo, n, head) => {
  const { cachedDiff, ghDiff } = await import("../review/diff.ts");
  const r = await cachedDiff(db, repo, n, head, ghDiff);
  return r.ok ? r.text : null;
};

/**
 * The steps' body: the item's default checkout (the workspace comes with the prompt) and diffs, for the operators' messages
 * (the conversation step, under its limits) or the maintainers' (conversation-maintainer, on their own Task Runners and outside
 * those limits). Returns the answered count and the usage run id.
 */
export async function runConversations(db: Db, p: { kind: PersonKind; limit?: number; onHandled?: (n: number) => void; cancelled?: () => Promise<boolean> }, log: (line: string) => void = console.log): Promise<{ answered: number; waiting: number; usageRun: string }> {
  await sweepRunningCards(db);
  const usageRun = `conversation-${now().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const waiting = (await pendingConversations(db, undefined, p.kind)).length;
  const answered = await answerPending(db, {
    ...p, usageRun, log, diff: githubDiff(db),
    checkout: (repo) => import("../dupes/compare.ts").then((m) => m.baseCheckout(db, repo)),
  });
  log(`conversation: ${answered} of ${waiting} messages answered`);
  return { answered, waiting, usageRun };
}
