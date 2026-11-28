// The dashboard's command box and controls: the same text and the same command core as GitHub, Discord and the agent
// (src/workflow/apply.ts). Every reply is the lines every surface shows; a refused or unclear command is a line, not an error.
//
//   POST /api/items/:repo/:n/command  { text, asked? }    a command written on one item
//   POST /api/commands                { text, items? }    a command for a list: the list after a colon in the text, or `items`
//                                                        (then the text holds only the command's words)
//   POST /api/controls                { control, ... }    a registered control (hold or release a merge, resume a breaker, ...)
import type { Db } from "../../db/index.ts";
import type { Req } from "../types.ts";
import { HttpError } from "../server/util.ts";
import { needVisible, allVisibleRepos } from "./visible.ts";
import { appSlug } from "../../github/identity.ts";
import { mentionName, shownMention } from "../../github/slugs.ts";
import { askedQuestion, listForm, parse } from "../../workflow/parse.ts";
import { runControl, type CommandResult, type ControlInput } from "../../workflow/apply.ts";
import { refsIn, runText } from "../../workflow/read.ts";
import { linkAskTurn, saying } from "../../workflow/said.ts";
import { askQuestion } from "../../conversations/ask.ts";
import { canTalk } from "./conversations.ts";
import { t } from "../../i18n/index.ts";
import type { ItemRef, Parsed } from "../../workflow/types.ts";

/** Longer text is no command anyone types. */
const TEXT_MAX = 4000;
/** Items in one dashboard command. */
const ITEMS_MAX = 100;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function textOf(req: Req): string {
  const text = obj(req.json).text;
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text is required");
  if (text.length > TEXT_MAX) throw new HttpError(400, `text is over ${TEXT_MAX} characters`);
  return text;
}

export const actorOf = (req: Req) => ({ login: req.user.login, canWrite: (repo: string) => req.user.canWrite(repo) });

async function visibleFn(db: Db, req: Req): Promise<(repo: string) => Promise<boolean>> {
  const repos = new Set(await allVisibleRepos(db, req));
  return async (repo) => repos.has(repo);
}

/** `owner/name#n`, `name#n` or `{ repo, number }`. */
export function itemOf(v: unknown): ItemRef {
  if (typeof v === "string") {
    const m = /^((?:[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(v.trim());
    if (m) return { repo: m[1]!, number: Number(m[2]) };
  }
  const o = obj(v);
  if (typeof o.repo === "string" && Number.isInteger(o.number) && (o.number as number) > 0) return { repo: o.repo, number: o.number as number };
  throw new HttpError(400, "each item is repo#number");
}

/** When the question the page showed was asked (`asked` of the item or row it read); null from a page that does not say. */
const timeOf = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

export async function itemCommand(db: Db, req: Req): Promise<CommandResult> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  const text = textOf(req);
  const parsed = parse(text, { repo });
  if (parsed.kind !== "ambiguous" && (parsed.items?.length ?? 0) > ITEMS_MAX) throw new HttpError(400, `at most ${ITEMS_MAX} items in one command`);
  const asked = obj(req.json).asked;
  return await runItemText(db, req, repo, n, text, parsed, timeOf(asked));
}

/**
 * The dashboard's `ask <question>` on one item: the question goes to Opus as the person's message (src/conversations/ask.ts), and the
 * chat message it came in is linked to that turn, so the answer shows under it. Only those who may write in the chat ask.
 */
function dashboardAsk(db: Db, req: Req, repo: string, n: number): (question: string) => Promise<CommandResult> {
  const one = (outcome: "run" | "refused", line: string): CommandResult => ({ items: [{ repo, number: n, outcome, line, workflowId: null }], lines: outcome === "run" ? [] : [line] });
  return async (question) => {
    if (!await canTalk(db, req.user, repo)) return one("refused", t("Only operators, and maintainers with write access to the repository, ask Opus."));
    const r = await askQuestion(db, { login: req.user.login, operator: req.user.role === "operator" }, repo, n, question, {
      limit: true, linked: async (turnId) => await linkAskTurn(db, { repo, number: n, login: req.user.login, via: "dashboard", turnId }),
    });
    if ("refusal" in r) return one("refused", r.refusal);
    return one("run", t("Asked Opus. The answer comes in the item's chat."));
  };
}

/**
 * Text written on one item through the command core, stored as the person's message in the item's chat; `ask <question>` goes to Opus.
 * `question`: the text is a question as it stands, put to Opus with no command reading (the item chat's question mark).
 */
export async function runItemText(db: Db, req: Req, repo: string, n: number, text: string, parsed: Parsed, asked: string | null, o: { question?: boolean } = {}): Promise<CommandResult> {
  const visible = await visibleFn(db, req);
  const ask = dashboardAsk(db, req, repo, n);
  return await saying(db, { login: req.user.login, via: "dashboard", text, items: [{ repo, number: n }], by: { canWrite: actorOf(req).canWrite, role: req.user.role, visible } }, async () =>
    o.question ? await ask(askedQuestion(text) ?? text.trim())
      : await runText(db, actorOf(req), "dashboard", { parsed, items: [{ repo, number: n }], visible, asked: ({ ref }) => (ref === `${repo}#${n}` ? asked : null) },
        { text, own: [{ repo, number: n }], named: false, parse: { repo }, ask }));
}

export async function listCommand(db: Db, req: Req): Promise<CommandResult> {
  const raw = obj(req.json).items;
  if (raw !== undefined && !Array.isArray(raw)) throw new HttpError(400, "items must be a list");
  const items = (raw ?? []).map(itemOf);
  const text = textOf(req);
  const parsed = parse(text);
  const named = parsed.kind !== "ambiguous" ? parsed.items?.length ?? 0 : 0;
  if (Math.max(items.length, named) > ITEMS_MAX) throw new HttpError(400, `at most ${ITEMS_MAX} items in one command`);
  // With items given, the text is only the command's words: items it names as well would decide which items it runs on.
  if (items.length && (named || listForm(text))) return { items: [], lines: [t("Write only the command's words while items are ticked.")] };
  const asked = obj(obj(req.json).asked);
  const own = items.length ? items : refsIn(text).slice(0, ITEMS_MAX);
  const visible = await visibleFn(db, req);
  return await saying(db, { login: req.user.login, via: "dashboard", text, items: own, by: { canWrite: actorOf(req).canWrite, role: req.user.role, visible } }, async () =>
    await runText(db, actorOf(req), "dashboard", { parsed, items, visible, asked: ({ ref }) => timeOf(Object.hasOwn(asked, ref) ? asked[ref] : null) },
      { text, own, named: !items.length }));
}

export async function control(db: Db, req: Req): Promise<{ ok: boolean; line: string }> {
  const b = obj(req.json);
  let input: ControlInput;
  switch (b.control) {
    case "release-outside": {
      const item = itemOf({ repo: b.repo, number: b.number });
      await needVisible(db, req, item.repo.split("/").pop()!);
      input = { control: b.control, item };
      break;
    }
    case "resume-breaker":
      if (typeof b.key !== "string" || !b.key) throw new HttpError(400, "key is required");
      input = { control: "resume-breaker", key: b.key };
      break;
    case "set-automatic":
      if (typeof b.repo !== "string" || typeof b.on !== "boolean") throw new HttpError(400, "repo and on are required");
      await needVisible(db, req, b.repo.split("/").pop()!);
      input = { control: "set-automatic", repo: b.repo, on: b.on };
      break;
    default:
      throw new HttpError(400, "control must be release-outside, resume-breaker or set-automatic");
  }
  return await runControl(db, actorOf(req), "dashboard", input);
}

/** GET /api/mention: the name to type to address the app in a GitHub comment (the mention name, else the app's slug); null without an app. */
export async function mention(db: Db): Promise<{ mention: string | null }> {
  return { mention: shownMention(appSlug(), await mentionName(db)) };
}
