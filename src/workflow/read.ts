// A model reading of text the command parser could not read, on every surface. When parse() gives `ambiguous` and the sender may
// send commands on the items, Haiku translates the text into one command in the parser's words: on the sender's own Task Runner
// first (a bound call, outside its slots), else on any Task Runner's Interactive slots (never for a quiet item), never on pipeline
// slots. The command must parse in full, name no item the text does not, and hold no word in a fix's instructions that the text (or a
// plan part's title) does not; Jev then scores whether the text asks for exactly it.
// It runs through runCommand as if the sender had typed it only with Jev's score at READ_RUN_SCORE or more, with the message's own
// items, and with no condition or hedge in the text (a hold runs anyway); otherwise the reply proposes it. With no reading (no Task
// Runner took the call, it failed or timed out, or the model found it unclear) the reply is the parser's own. The text goes only
// into the calls, whose recorded texts are deleted when they end; each reading is logged as a `read` event with the text's hash.
import { createHash } from "node:crypto";
import { runModelStep, type ClaudeStep, type JevStep } from "../agents/step.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { removeRunTexts } from "../data/inference/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { listWorkflows, loadLinks, loadWorkflowHistory, recordEvents } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { actRefusal } from "../github/identity.ts";
import { t } from "../i18n/index.ts";
import { ownerOf } from "../owners.ts";
import { jevRequestOf } from "../prompts/index.ts";
import { runCommand, type Actor, type CommandInput, type CommandResult } from "./apply.ts";
import { CONDITION, GUARD, parse, type ParseOptions } from "./parse.ts";
import { addedWords, jevExact, parseTranslation, READ_ITEMS_MAX, READ_TEXT_CHARS, scoreState, type ReadAsk, type ReadItem, type ScoreAsk } from "./read-ask.ts";
import { isLive, optionNamed } from "./resolve.ts";
import { MEANING_WORDS, recommendationText } from "./status.ts";
import { openRecommendation, shownWorkflow, type ItemRef, type Parsed, type Surface } from "./types.ts";

/** The score from which a command read from a message runs without asking. */
export const READ_RUN_SCORE = 0.9;
/** The longest a reading may take, from the first call to the score, while the sender waits for the reply (dashboard, agent, Discord); past it the parser's own reply goes out. */
export const READ_WAIT_MS = 45_000;
/** The same for a reading off the request (a GitHub comment, read off the comment drain). */
export const READ_BACKGROUND_WAIT_MS = 90_000;
/** Items one message may be about. */
export const READ_OWN_MAX = 100;
/** How long each translate call waits in the queue for a Task Runner to take it. */
export const READ_TAKE_WAIT_MS = 8_000;
/** The step the calls are recorded under; their texts are deleted when they end. */
const READ_STEP = "command-read";
/** Words that put a command off to a later time or carve something out of it, beside the parser's own condition words (CONDITION). */
const LATER = /(?<![\w-])(?:if|after|when|until|once|before|later|tomorrow|except|without|minus|other than|apart from|instead of)(?![\w-])/i;
/**
 * A text that negates, hedges, asks or sets a condition: the parser's guard (GUARD), the words an unclear reply never reads back as a
 * command (MEANING_WORDS), its condition words (CONDITION) and LATER. Such a text never runs a reading, unless it is a hold.
 */
export function hedged(text: string): boolean {
  const s = text.replace(/[\u2018\u2019]/g, "'");
  return GUARD.test(s) || MEANING_WORDS.test(s) || LATER.test(s) || s.toLowerCase().split(/[^\p{L}']+/u).some((w) => CONDITION.test(w));
}

export type Translation = { command: string | null; confidence: number };
/** `fit`: how its items fit the message (itemsFit). */
export type Reading = { command: string; parsed: Parsed; score: number; source: "jev" | "haiku"; fit: "own" | "text" };

/** What tests replace: the translate call (null: no answer) and Jev's score (null: no answer). */
export type ReadDeps = {
  /** `ownOnly`: only the sender's own Task Runner may read it (a quiet item). */
  translate?: (db: Db, ask: ReadAsk, login: string, o: { ownOnly: boolean }) => Promise<Translation | null>;
  score?: (db: Db, ask: ScoreAsk) => Promise<number | null>;
};

export type ReadText = {
  /** What the person wrote, as the model reads it. */
  text: string;
  /** The items the message was written on, or names. */
  own: readonly ItemRef[];
  /**
   * The command must name its items, exactly the items of `own` (a surface with no item of its own: Discord, a dashboard list typed
   * as text). Otherwise `own` is the item the text was written on, or the items selected: the command names none, or only those.
   */
  named: boolean;
  /** The parser found a condition beside the text's command (parseComment): a reading is only proposed. */
  condition?: boolean;
  /** The longest the reading may take (default READ_WAIT_MS). */
  waitMs?: number;
  /** How the command read is parsed (the item's repo for a bare #n). */
  parse?: ParseOptions;
  /** Settles what the command needs before it runs (GitHub: the comment unchanged, the PR head at it), or a line saying why it cannot run; may throw to end the command. */
  pin?: (p: Parsed) => Promise<Partial<CommandInput> | string>;
  deps?: ReadDeps;
};

const lower = (s: string): string => s.toLowerCase();
const nameOf = (repo: string): string => lower(repo.split("/").pop()!);

const sameRef = (a: ItemRef, b: ItemRef): boolean => a.number === b.number && nameOf(a.repo) === nameOf(b.repo);

/**
 * Items a text names, each once: `owner/name#n`, `name#n`, a GitHub URL, and with `repo` a bare `#n`. A written owner stays in `repo`, so
 * the caller's tracked-repo check refuses another owner's repo of the same name.
 */
export function refsIn(text: string, repo?: string): ItemRef[] {
  const out: ItemRef[] = [];
  const full = (r: ItemRef): string => (r.repo.includes("/") ? lower(r.repo) : `${lower(ownerOf(r.repo))}/${lower(r.repo)}`);
  const add = (r: ItemRef): void => { if (!out.some((o) => o.number === r.number && full(o) === full(r))) out.push(r); };
  for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/gi)) add({ repo: `${m[1]!}/${m[2]!}`, number: Number(m[3]) });
  for (const m of text.matchAll(/(?<![\w./#-])((?:[\w.-]+\/)?[\w.-]+)#(\d+)(?!\d)/g)) add({ repo: m[1]!, number: Number(m[2]) });
  if (repo) for (const m of text.matchAll(/(?<![\w./#-])#(\d+)(?!\d)/g)) add({ repo, number: Number(m[1]) });
  return out;
}

/**
 * How the command's items fit the message: `own` when they are the message's own (none, or exactly the items of `own`; a named list
 * must name them), `text` when every item the command names stands in the text but they are not that, a part of `own` included (it
 * may only be proposed), `none` when it names an item the text does not. A duplicate's original and an autorepin target count as named.
 */
function itemsFit(p: Parsed, command: string, read: ReadText): "own" | "text" | "none" {
  if (p.kind === "ambiguous") return "none";
  const items = p.items ?? [];
  const inText = [...read.own, ...refsIn(read.text, read.parse?.repo)];
  const home = read.parse?.repo ?? read.own[0]?.repo ?? "";
  const originals = p.kind === "commands" ? p.parts.flatMap((x) => (x.word === "close" && x.reason?.as === "duplicate" ? [{ repo: x.reason.of.repo ?? home, number: x.reason.of.number }] : [])) : [];
  // A bare #n in the command's words is a plan part or an item the parse already resolved; named items are checked by name.
  if (![...items, ...originals, ...refsIn(command)].every((i) => inText.some((o) => sameRef(i, o)))) return "none";
  const ofOwn = items.every((i) => read.own.some((o) => sameRef(i, o)));
  const all = ofOwn && read.own.every((o) => items.some((i) => sameRef(i, o)));
  const fits = read.named ? items.length > 0 && all : items.length === 0 || all;
  return fits ? "own" : "text";
}

/** The sender may send commands on every item: a tracked repo, and the act rule (actRefusal) lets them. */
async function mayRead(db: Db, actor: Actor, own: readonly ItemRef[]): Promise<boolean> {
  if (!own.length || !actor.login) return false;
  const tracked = await loadTrackedRepos(db);
  for (const i of own) {
    const [owner, name] = i.repo.includes("/") ? i.repo.split("/", 2) as [string, string] : [null, i.repo];
    if (!tracked.has(name) || (owner !== null && lower(owner) !== lower(ownerOf(name)))) return false;
    if (await actRefusal(db, actor, name)) return false;
  }
  return true;
}

/** The call's input: the text, and each item's kind, AutoCraft's work on it and an open question with its plan parts (left out on a quiet item). */
async function askOf(db: Db, read: ReadText): Promise<{ ask: ReadAsk; quiet: boolean }> {
  const refs = read.own.slice(0, READ_ITEMS_MAX).map((i) => ({ repo: i.repo.split("/").pop()!, number: i.number }));
  const keys = refs.map((r) => `${r.repo}#${r.number}`);
  // Quiet over every item of the message, not only those the call describes: one quiet item keeps the text on the sender's own Task Runner.
  const [items, history, quiet] = await Promise.all([loadItems(db, refs, "pr"), loadWorkflowHistory(db, refs), loadQuiet(db, read.own.map((i) => `${i.repo.split("/").pop()!}#${i.number}`))]);
  const out: ReadItem[] = [];
  for (const key of keys) {
    const it = items.get(key as never);
    if (!it) continue;
    const all = history.get(key) ?? [];
    const wf = all.findLast((w) => isLive(w)) ?? shownWorkflow(all);
    const rec = isLive(wf) ? openRecommendation(wf) : null;
    const veiled = quiet.has(key);
    out.push({
      ref: key, kind: it.kind === "pr" ? "pull request" : "issue", work: wf ? wf.state : "not started",
      ...(rec && !veiled ? { question: recommendationText(rec), parts: wf!.plan.filter((p) => p.state !== "dropped").map((p) => ({ n: p.n, title: p.title })) } : {}),
    });
  }
  return { ask: { ...(keys[0] ? { ref: keys[0] } : {}), message: read.text.slice(0, READ_TEXT_CHARS), items: out }, quiet: quiet.size > 0 };
}

const TRANSLATE = (id: "command.read" | "interactive.command-read"): ClaudeStep<ReadAsk, Translation> => ({
  provider: "claude", id,
  toPrompt: (a) => [a],
  parse: async (text) => {
    const v = parseTranslation(text);
    return v === null ? null : { value: v };
  },
});
const SCORE: JevStep<ScoreAsk, number> = {
  provider: "jev", id: "command.read.jev",
  request: (a) => ({ item: { ref: "command" }, body: JSON.stringify({ ...jevRequestOf("command.read.jev"), state: scoreState(a) }) }),
  parse: (answers, _a, ctx) => {
    const p = ctx.code === 0 ? jevExact(answers) : null;
    return p === null ? null : { value: p };
  },
};

/** One translate call; null when no Task Runner took it in time or it gave no answer. */
async function translateOn(db: Db, id: "command.read" | "interactive.command-read", a: ReadAsk, forLogin?: string): Promise<Translation | null> {
  try {
    const r = await runModelStep(db, TRANSLATE(id), a, { maxWaitMs: READ_TAKE_WAIT_MS, ...(forLogin ? { forLogin } : {}) });
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

/** The sender's own Task Runner first; when it gives no answer, any Task Runner with a free Interactive slot, except for a quiet item (`ownOnly`). */
async function translate(db: Db, a: ReadAsk, login: string, o: { ownOnly: boolean }): Promise<Translation | null> {
  try {
    return await translateOn(db, "command.read", a, login) ?? (o.ownOnly ? null : await translateOn(db, "interactive.command-read", a));
  } finally {
    await removeRunTexts(db, { steps: [READ_STEP], finishedOnly: true }).catch(() => 0);
  }
}

async function score(db: Db, a: ScoreAsk): Promise<number | null> {
  try {
    const r = await runModelStep(db, SCORE, a);
    return r.ok ? r.value : null;
  } catch {
    return null;
  } finally {
    await removeRunTexts(db, { steps: [READ_STEP], finishedOnly: true }).catch(() => 0);
  }
}

/** The command a model reads in the text, checked by the parser and scored; null when there is none. */
export async function readCommand(db: Db, login: string, read: ReadText): Promise<Reading | null> {
  const { ask, quiet } = await askOf(db, read);
  const tr = await (read.deps?.translate ?? translate)(db, ask, login, { ownOnly: quiet });
  if (!tr?.command) return null;
  const parsed = parse(tr.command, read.parse);
  const fit = itemsFit(parsed, tr.command, read);
  if (fit === "none") return null;
  // A fix's words are the person's own: a reading that adds to them is no reading.
  if (parsed.kind === "commands" && parsed.parts.some((x) => x.word === "fix" && typeof x.part === "string" && addedWords(x.text ?? x.part, ask).length)) return null;
  const p = await (read.deps?.score ?? score)(db, { message: ask.message, command: tr.command });
  return p === null ? { command: tr.command, parsed, score: tr.confidence, source: "haiku", fit } : { command: tr.command, parsed, score: p, source: "jev", fit };
}

/** Resolves after `ms` with null, or with the promise's value; a rejection is null. */
const within = <T>(ms: number, p: Promise<T>): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => null), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
};

const isHold = (p: Parsed): boolean => p.kind === "commands" && p.parts.length > 0 && p.parts.every((x) => x.word === "hold");

/**
 * Whether a reading runs without asking: Jev's score at READ_RUN_SCORE or more (Haiku's own confidence only proposes), items that are
 * the message's own, and no condition the parser found and no hedge in the text, unless it is a hold.
 */
export const readingRuns = (r: Reading, read: Pick<ReadText, "text" | "condition">): boolean =>
  r.source === "jev" && r.score >= READ_RUN_SCORE && r.fit === "own" && (isHold(r.parsed) || (!read.condition && !hedged(read.text)));

/** Adds the note to every item's line and to the reply. */
function noted(res: CommandResult, note: string): CommandResult {
  const items = res.items.map((o) => ({ ...o, line: `${o.line} ${note}` }));
  return { items, lines: items.length === 1 ? [items[0]!.line] : [...res.lines, note] };
}

/** The text names an option of the open implementation question of the one item, or of the issue whose implementation the PR is, on its own. */
export async function namesOption(db: Db, items: readonly ItemRef[], parsed: Parsed): Promise<boolean> {
  if (parsed.kind !== "ambiguous" || parsed.understood || items.length !== 1) return false;
  const ref = { repo: items[0]!.repo.split("/").pop()!, number: items[0]!.number };
  const [own] = await listWorkflows(db, { live: true, refs: [ref] });
  const issue = own ? null : (await loadLinks(db, { prs: [ref] }))[0];
  const wf = own ?? (issue ? (await listWorkflows(db, { live: true, refs: [{ repo: issue.repo, number: issue.issue }] }))[0] : undefined);
  return !!wf && optionNamed(wf, parsed.rest) !== null;
}

/**
 * Runs text the way every surface does: through runCommand. Text the parser could not read, from a sender who may send commands
 * on `read.own`, is read by a model first (see the file comment). `read` null: no reading on this path.
 */
export async function runText(db: Db, actor: Actor, via: Surface, given: CommandInput, read: ReadText | null): Promise<CommandResult> {
  // An ambiguous parse carries no items: on a surface with none of its own, the parser's reply goes on the items the text names.
  const input = given.parsed.kind === "ambiguous" && !given.items.length && read?.named ? { ...given, items: [...read.own] } : given;
  if (input.parsed.kind !== "ambiguous" || !read || !actor.login || !await mayRead(db, actor, read.own)) return await runCommand(db, actor, via, input);
  // An option of the open question named on its own ("2", "go with one archive") answers it as the parser reads it: no model reading.
  if (await namesOption(db, input.items.length ? input.items : read.own, input.parsed)) return await runCommand(db, actor, via, input.items.length ? input : { ...input, items: [...read.own] });
  const reading = await within(read.waitMs ?? READ_WAIT_MS, readCommand(db, actor.login, read));
  if (!reading) return await runCommand(db, actor, via, input);
  const runs = readingRuns(reading, read);
  const hash = createHash("sha256").update(read.text).digest("hex").slice(0, 16);
  const line = t("Read “{command}” from a message ({hash}): {source} {score}, {outcome}.", { command: reading.command, hash, source: reading.source === "jev" ? "Jev" : "Haiku", score: reading.score.toFixed(2), outcome: runs ? t("run") : t("proposed") });
  const at = input.at ?? new Date().toISOString();
  // Logged before the command's own event, which stays the item's latest.
  await recordEvents(db, read.own.map((i) => ({ workflowId: null, repo: i.repo.split("/").pop()!, number: i.number, login: actor.login!, via, kind: "read" as const, parsed: reading.parsed, line, at })));
  const items = input.items.length ? input.items : [...read.own];
  if (!runs) return await runCommand(db, actor, via, { ...input, items, proposed: reading.command });
  const note = t("Read from your words as `{command}`.", { command: reading.command });
  const pinned = read.pin ? await read.pin(reading.parsed) : {};
  if (typeof pinned === "string") {
    return noted({ items: items.map((x) => ({ repo: x.repo, number: x.number, outcome: "refused", line: pinned, workflowId: null })), lines: [pinned] }, note);
  }
  const parsed = read.named || reading.parsed.kind === "ambiguous" ? reading.parsed : { ...reading.parsed, items: [] };
  return noted(await runCommand(db, actor, via, { ...input, ...pinned, items, parsed }), note);
}
