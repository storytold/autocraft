// Reading a message the command parser could not read: a model translates it into one command in the parser's words (or says
// it is unclear), and Jev scores whether the message asks for exactly that command. The server side is read.ts. Pure; no Node
// imports (the Prompts page imports it).
import { wholeReplyJson } from "../core/reply-json.ts";
import { COMMANDS, WEIGHT_HELP, YES_WORDS } from "./vocab.ts";

/** The longest message text a call carries. */
export const READ_TEXT_CHARS = 2000;
/** Items whose state a call carries at most. */
export const READ_ITEMS_MAX = 5;
/** Plan parts per item a call carries at most, and the length of each title. */
export const READ_PARTS_MAX = 20;
export const READ_TITLE_CHARS = 160;
/** The longest command a reply may give. */
export const READ_COMMAND_CHARS = 300;

/** An item the message was written on or names, as the call sees it. */
export type ReadItem = {
  ref: string;
  kind: "issue" | "pull request";
  /** The state of AutoCraft's work on it: "not started", "running", "waiting", "stopped" and so on. */
  work: string;
  /** The open question's recommendation, when one is open. */
  question?: string;
  /** The parts of the plan the open question is about, by number. */
  parts?: { n: number; title: string }[];
};

/** One message to read. `ref`: the first item, which the call is recorded under. */
export type ReadAsk = { ref?: string; message: string; items: ReadItem[] };
/** What Jev scores: the message and the command read from it, with the meanings of the command's words. */
export type ScoreAsk = { message: string; command: string };

/** The command vocabulary as the prompt lists it, from the parser's own list. */
export const READ_VOCABULARY = [
  ...COMMANDS.map((c) => `- ${c.usage}: ${c.short}${c.word === "fix" ? " It names parts of the plan by number or by words from their title; other words after fix are instructions for the fix-up, which must be the message's own words." : c.answer ? " Only in an answer to an open question; it names parts of the plan by number or by words from their title." : ""} Example: ${c.example}`),
  "- ask: the message only asks a question about the item, and asks for nothing to be done; AutoCraft answers it in words. Write ask alone: the question is the message itself.",
  `- yes: runs the open recommendation as it stands (also: ${YES_WORDS.filter((w) => w !== "yes").slice(0, 6).join(", ")}). Only when a question is open.`,
  `- Weight words, alone or after a command: ${WEIGHT_HELP.filter((w) => w.word !== "(none)").map((w) => w.word).join(", ")}.`,
  "- Several commands in one: separate them with commas, as in \"fix 1, drop 2, then merge\".",
  "- Items: repo#number. A list goes after a colon: \"merge: photocraft#123 photocraft#456\".",
].join("\n");

export const READ_QUESTION = "Does the message ask AutoCraft for exactly the command given, nothing more and nothing less, and without a condition or a question?";
/** Jev's second question: whether the message is only a question, which `ask` answers in words. */
export const READ_ASKS = "Is the message only a question about the item, asking for an answer in words and asking AutoCraft to do nothing?";

export const SAMPLE_READ: ReadAsk[] = [{
  ref: "photocraft#812",
  message: "@autocraft looks good to me, but leave out the second finding and then get it merged",
  items: [{ ref: "photocraft#812", kind: "pull request", work: "waiting", question: "Fix 1 and 2, then merge.", parts: [{ n: 1, title: "Export ignores the quality setting" }, { n: 2, title: "Rename the dialog's OK button" }] }],
}];

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const safe = (v: unknown): string => JSON.stringify(v, null, 1).replace(/</g, "\\u003c");

/** The data block of the translate prompt: the message and the items, as one JSON string. */
export const readState = (a: ReadAsk): string => safe({
  message: cut(a.message, READ_TEXT_CHARS),
  items: a.items.slice(0, READ_ITEMS_MAX).map((i) => ({ ...i, ...(i.parts && { parts: i.parts.slice(0, READ_PARTS_MAX).map((p) => ({ n: p.n, title: cut(p.title, READ_TITLE_CHARS) })) }) })),
});

/** Jev's request state: the message, the command and the meanings of the command words it uses. */
export function scoreState(a: ScoreAsk): string {
  const words = COMMANDS.filter((c) => [c.word, ...c.aliases].some((w) => new RegExp(`(?<![\\w-])${w.replace(/[- ]/g, "[-\\s]?")}(?![\\w-])`, "i").test(a.command)));
  return safe({ message: cut(a.message, READ_TEXT_CHARS), command: a.command, meanings: Object.fromEntries(words.map((c) => [c.word, c.short])) });
}

/** The translate reply: `{"command": string | null, "confidence": 0..1}` as its one JSON value; null otherwise. */
export function parseTranslation(text: string): { command: string | null; confidence: number } | null {
  const v = wholeReplyJson(text) as { command?: unknown; confidence?: unknown } | null;
  if (!v || typeof v !== "object") return null;
  const c = v.confidence;
  if (typeof c !== "number" || !(c >= 0 && c <= 1)) return null;
  if (v.command === null) return { command: null, confidence: c };
  if (typeof v.command !== "string") return null;
  const command = v.command.replace(/\s+/g, " ").trim();
  return { command: command && command.length <= READ_COMMAND_CHARS ? command : null, confidence: c };
}

/** Words a fix's instructions may hold that the message need not: articles and the like. */
const LINKING = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "and", "with", "it", "its", "this", "that", "from", "by", "as", "at", "so", "is", "are"]);
const wordsIn = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
const stem = (w: string): string => w.replace(/(?:es|s)$/, "");

/**
 * The words of a fix's instructions in a command read from the message (`fix`: the words as the parser read them) that are neither in
 * the message nor in a plan part's title the call showed: the model added them. Empty when the instructions are the person's own words.
 */
export function addedWords(fix: string, a: ReadAsk): string[] {
  const known = new Set([a.message, ...a.items.flatMap((i) => (i.parts ?? []).map((p) => p.title))].flatMap(wordsIn).map(stem));
  return wordsIn(fix).filter((w) => !LINKING.has(w) && !known.has(stem(w)));
}

/**
 * Jev's answer to one of its questions: `exact`, the probability that the message asks for exactly the command, or `question`, that it is
 * only a question (READ_ASKS); null without a number from 0 to 1.
 */
export function jevScore(answers: unknown, field: "exact" | "question" = "exact"): number | null {
  const p = (answers as Record<string, { noul?: unknown } | undefined> | undefined)?.[field]?.noul;
  return typeof p === "number" && p >= 0 && p <= 1 ? p : null;
}
