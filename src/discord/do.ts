// A command written in Discord, run the same way from `/autocraft do` and from an @-command (src/discord/at-commands.ts): the workflow
// parser, the model reading of text it cannot read with its refusal rules (src/workflow/read.ts runText), the sender's linked login
// with their write permission (freshWrite: cached a minute, else asked through the GitHub App), and the questions the sender's alerts
// showed. `/autocraft do` has no items of its own, so the text must name them; an @-command may have context items (the replied-to
// message's, or its thread's), which a command naming none acts on.
import * as access from "../data/access/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { addSentAlerts, loadShownQuestions } from "../data/discord/index.ts";
import type { Db } from "../db/index.ts";
import type { CommandResult } from "../workflow/apply.ts";
import { parse } from "../workflow/parse.ts";
import { READ_OWN_MAX, refsIn, runText, type ReadDeps } from "../workflow/read.ts";
import type { ItemRef, Parsed } from "../workflow/types.ts";
import type { DiscordKeys } from "./keys.ts";
import { t } from "../i18n/index.ts";
import { slugOf } from "../owners.ts";
import { writeAccess, type PermissionFn } from "../remote/permission.ts";
import { linkAskTurn, saying } from "../workflow/said.ts";
import { askQuestion } from "../conversations/ask.ts";
import { keepAskedAt, type AskedAt } from "./answers.ts";

/** "all", "both", "all of them" at the end: every context item, which is what a command naming no item acts on anyway. */
const ALL_TAIL = /[\s,]+(?:all(?:\s+of\s+(?:them|these|those))?|them\s+all|both(?:\s+of\s+them)?|everything)\s*[.!]*\s*$/i;

export type DoText = {
  /** The text as the person wrote it: what the item's chat shows. */
  written: string;
  /** The text the parser read: `written` without a trailing "all". */
  text: string;
  parsed: Parsed;
  /** Items the text names. */
  named: ItemRef[];
  /** Items the message is about without naming them. */
  context: ItemRef[];
  /** The repo a bare `#n` takes: the context items' one repo. */
  repo?: string;
  /** The text ends in "all" or "both": every context item. */
  all?: true;
  /** The items were picked out of the conversation (context.ts), so the reply names each one. */
  picked?: true;
};

/** Parses the text against its context items. `review all` with context items reads as `review`. */
export function prepareDo(raw: string, context: readonly ItemRef[] = []): DoText {
  const repos = new Set(context.map((i) => i.repo));
  const repo = repos.size === 1 ? [...repos][0] : undefined;
  const opts = repo ? { repo } : {};
  let text = raw.trim();
  let parsed = parse(text, opts);
  const named = refsIn(text, repo);
  const all = ALL_TAIL.test(text);
  if (parsed.kind === "ambiguous" && context.length && !named.length) {
    const cut = text.replace(ALL_TAIL, "");
    const p = cut !== text ? parse(cut, opts) : null;
    if (p && p.kind !== "ambiguous") { text = cut; parsed = p; }
  }
  return { written: raw.trim(), text, parsed, named, context: [...context], ...(repo ? { repo } : {}), ...(all ? { all: true as const } : {}) };
}

/** The items the command acts on: those it names, else its context items. */
export const targetsOf = (d: DoText): ItemRef[] =>
  d.parsed.kind !== "ambiguous" && d.parsed.items?.length ? d.parsed.items : d.named.length ? d.named : d.context;

/**
 * `ask <question>` from Discord, about the one item the text is about: the question goes to Opus as the sender's message on it
 * (src/conversations/ask.ts), that message is linked to the turn, and the place it was asked is kept for the answer (answers.ts).
 * `asked` is called when it was asked.
 */
function discordAsk(db: Db, keys: DiscordKeys, o: { login: string; own: readonly ItemRef[]; canWrite: (repo: string) => Promise<boolean>; at: AskedAt; asked: () => void }): (question: string) => Promise<CommandResult> {
  const one = (i: ItemRef | null, outcome: "run" | "refused", line: string): CommandResult =>
    ({ items: i ? [{ repo: i.repo, number: i.number, outcome, line, workflowId: null }] : [], lines: [line] });
  return async (question) => {
    if (o.own.length !== 1) return one(null, "refused", t("Ask about one item: reply to its message, or name it."));
    const item = { repo: o.own[0]!.repo.split("/").pop()!, number: o.own[0]!.number };
    if (!(await loadTrackedRepos(db)).has(item.repo)) return one(item, "refused", t("AutoCraft does not track {repo}.", { repo: item.repo }));
    const operator = (await access.loadAccess(db, [o.login])).get(o.login.toLowerCase())?.role === "operator";
    if (!operator && !await o.canWrite(item.repo).catch(() => false)) return one(item, "refused", t("Only operators, and maintainers with write access to the repository, ask Opus."));
    const a = await askQuestion(db, { login: o.login, operator }, item.repo, item.number, question, { limit: true, via: "discord" });
    if ("refusal" in a) return one(item, "refused", a.refusal);
    await linkAskTurn(db, { ...item, login: o.login, via: "discord", turnId: a.turnId });
    await keepAskedAt(db, keys, a.turnId, o.at);
    o.asked();
    return one(item, "run", t("Asked Opus. The answer comes as a reply here, and in the item's chat."));
  };
}

/**
 * Runs the text as the sender's linked login, through the command core. The text is a message in the chat of each item it is about
 * (src/workflow/said.ts); `messageId` is the Discord message or interaction it came in, whose hash keeps the item's chat from also
 * showing that message as a mention. `askedAt`: where an `ask <question>` was written, which the answer replies to; without it a
 * question is no command. `asked` in the result: the text was put to Opus as a question.
 */
export async function runDo(db: Db, keys: DiscordKeys, d: DoText, sender: { userId: string; login: string; messageId: string }, read?: ReadDeps, permission?: PermissionFn, askedAt?: AskedAt): Promise<CommandResult & { asked?: true }> {
  const { login } = sender;
  const userHash = keys.hash("author", sender.userId);
  const shown = await loadShownQuestions(db, userHash);
  // Text that names items is read as a list, as `/autocraft do` reads it; otherwise the context items are the message's own.
  const byName = d.named.length > 0 || !d.context.length;
  const own = (byName ? d.named : d.context).slice(0, READ_OWN_MAX);
  const write = writeAccess(db, login, permission);
  const said = { login, via: "discord" as const, text: d.written, items: [...own, ...(d.parsed.kind !== "ambiguous" ? d.parsed.items ?? [] : [])], by: { canWrite: write.canWrite }, payload: { msgHash: keys.hash("message", sender.messageId) } };
  let asked = false;
  const ask = askedAt ? discordAsk(db, keys, { login, own, canWrite: write.canWrite, at: askedAt, asked: () => { asked = true; } }) : undefined;
  const result: CommandResult & { asked?: true } = await saying(db, said, () => runText(db, { login, ...write }, "discord",
    { parsed: d.parsed, items: byName ? [] : d.context, asked: ({ workflow }) => shown.get(workflow.id) },
    { text: d.text, own, named: byName, ...(d.repo ? { parse: { repo: d.repo } } : {}), ...(read ? { deps: read } : {}), ...(ask ? { ask } : {}) }));
  if (asked) return { ...result, asked: true };
  // An item picked out of the conversation is named in the reply, which for one item the command core leaves out.
  const one = result.items.length === 1 ? result.items[0]! : null;
  if (d.picked && one && result.lines.length === 1 && !result.lines[0]!.includes(`#${one.number}`)) result.lines[0] = t("{ref}: {line}", { ref: `${slugOf(one.repo.split("/").pop()!)}#${one.number}`, line: result.lines[0]! });
  // The reply shows the question that took the answered one's place, as an alert does.
  const sentAt = new Date().toISOString();
  await addSentAlerts(db, result.items.flatMap((o) => (o.question ? [{ userHash, ...o.question, sentAt }] : [])));
  return result;
}
