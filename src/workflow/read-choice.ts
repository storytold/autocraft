// Reading a message the command parser could not read as one Jev choice: the code lists the commands the message's items can take
// now (the open recommendation as written, its plan parts dropped or fixed, the fixed commands their state allows, a fix with the
// message as its instruction, ask, and "none of these"), and Jev gives each a probability (command.read.jev, question `command`).
// The server side is read.ts. Pure; no Node imports.
import { describe } from "./parse.ts";
import { NONE_CHOICE } from "./read-ask.ts";
import { WEIGHT_WORDS, type CommandPart, type Parsed, type WeightWord } from "./types.ts";
/** The label of the choice that the message is only a question. */
export const ASK_CHOICE = "ask";
/** Plan parts that get choices of their own; later parts are reached by the other choices or by typing the command. */
export const CHOICE_PARTS_MAX = 4;
/** The longest part title a choice's meaning quotes. */
const TITLE_CHARS = 120;
/** The longest recommendation a choice's meaning quotes. */
const REC_CHARS = 400;

/** An item of the message as the choices see it. `rec`: the open recommendation (its text left out on a quiet item). */
export type ChoiceItem = {
  kind: "issue" | "pr";
  live: boolean;
  held: boolean;
  approved: boolean;
  rec: { text: string | null; merges: boolean } | null;
  /** The planned parts of the open question's plan; none on a quiet item. */
  parts: { n: number; title: string }[];
};

/** One choice: its label (what Jev returns), what it means (the criterion), and what runs when it is read. */
export type Candidate = { label: string; meaning: string; parsed: Parsed | null; command: string };

const quote = (s: string, n: number): string => `“${(s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ").trim()}”`;

const commands = (parts: CommandPart[]): Parsed => ({ kind: "commands", items: [], parts });

/**
 * The choices for a message on `items`: the commands every item can take in its state, with the open recommendation and its parts
 * when the message is on one item, `ask` when the surface answers questions, and NONE_CHOICE last. `message` is the instruction of
 * the fix choices, as written.
 */
export function candidatesFor(items: readonly ChoiceItem[], message: string, o: { asks: boolean }): Candidate[] {
  const out: Candidate[] = [];
  const add = (label: string, meaning: string, parsed: Parsed | null, command = label): void => { if (!out.some((c) => c.label === label)) out.push({ label, meaning, parsed, command }); };
  const all = (f: (i: ChoiceItem) => boolean): boolean => items.length > 0 && items.every(f);
  const one = items.length === 1 ? items[0]! : null;
  const said = message.replace(/\s+/g, " ").trim();

  if (one?.rec) {
    const same = "Words that ask for the same thing in other terms (fix what it names, then merge, land or ship it) mean this choice.";
    add("yes", one.rec.text ? `Do what AutoCraft recommends, as it stands: ${quote(one.rec.text, REC_CHARS)} ${same}` : `Do what AutoCraft recommends, as it stands. ${same}`, { kind: "yes" });
    for (const p of one.parts.slice(0, CHOICE_PARTS_MAX)) {
      const title = quote(p.title, TITLE_CHARS);
      if (one.parts.length > 1 || one.rec.merges) add(`drop ${p.n}`, `Leave part ${p.n} (${title}) out, and do the rest of what AutoCraft recommends.`, commands([{ word: "drop", part: p.n }]));
      if (one.parts.length > 1) add(`fix ${p.n}`, `Fix only part ${p.n} (${title}), then review again; no merge yet.`, commands([{ word: "fix", part: p.n }]));
      add(`fix ${p.n} and merge`, `Fix only part ${p.n} (${title}), then merge.`, commands([{ word: "fix", part: p.n }, { word: "merge" }]));
    }
  }
  const prs = all((i) => i.kind === "pr"), issues = all((i) => i.kind === "issue");
  if (prs && said) {
    const fix = (merge: boolean): CommandPart[] => [{ word: "fix", part: said, text: said }, ...(merge ? [{ word: "merge" } as const] : [])];
    add("fix as written", "Make the change the message describes, in its own words (a fix the plan does not list, or a part of it named in other words), then review again; no merge yet.", commands(fix(false)), describe(fix(false)));
    add("fix as written and merge", "Make the change the message describes, in its own words, then merge.", commands(fix(true)), describe(fix(true)));
  }
  if (!all((i) => i.live && i.approved && !i.rec) && !issues) add("merge", one?.rec ? "Approve the merge: do what AutoCraft recommends, then merge, with no further question." : "Approve the merge, with no full review: AutoCraft makes any outstanding fixes and merges on green CI.", commands([{ word: "merge" }]));
  add("review", "Review it (again), and come back with one recommendation; no merge yet.", commands([{ word: "review" }]));
  if (prs) {
    add("review and merge", "Review it, and merge if the review finds no blocker, once its recommended fixes are made.", commands([{ word: "review" }, { word: "merge" }]), "review, merge");
    add("fix-up", "Review it, fix what the review finds, and review the fixes; no merge yet.", commands([{ word: "fix-up" }]));
    add("fix-up and merge", "Review it, fix what the review finds, then merge.", commands([{ word: "fix-up" }, { word: "merge" }]), "fix-up, merge");
    add("ask author", "Ask the pull request's author to finish or fix it, and wait for their push.", commands([{ word: "ask-author" }]));
  }
  if (issues && all((i) => !i.live)) {
    add("implement", "Write the change in a new pull request, then review and fix it; no merge yet.", commands([{ word: "implement" }]));
    add("implement and merge", "Write the change in a new pull request, review and fix it, then merge.", commands([{ word: "implement" }, { word: "merge" }]), "implement, merge");
  }
  add("backlog", "Keep it open with no work planned, for later.", commands([{ word: "backlog" }]));
  add("close", "Close it.", commands([{ word: "close" }]));
  if (all((i) => !i.held)) add("hold", "Stop all work on it for now: hold, pause, wait, not yet, or the maintainer wants to look first.", commands([{ word: "hold" }]));
  if (all((i) => i.held)) add("resume", "Go on with the held work where it was.", commands([{ word: "resume" }]));
  if (all((i) => i.live)) {
    for (const w of Object.keys(WEIGHT_WORDS) as WeightWord[]) add(w, `Change only its priority, to ${w} (${WEIGHT_WORDS[w]} of 10).`, commands([{ word: "weight", weight: WEIGHT_WORDS[w] }]));
  }
  if (o.asks) add(ASK_CHOICE, "The message only asks a question about the item and asks for nothing to be done; AutoCraft answers it in words.", null);
  add(NONE_CHOICE, "The message asks for something none of the other choices is, for several of them at once, or for nothing AutoCraft does.", null);
  return out;
}

/** The criteria of the choice question: each label with its meaning. */
export const choiceCriteria = (cands: readonly Candidate[]): Record<string, string> => Object.fromEntries(cands.map((c) => [c.label, c.meaning]));

/** Jev's probability per label of the choices. */
export type Distribution = Record<string, number>;

/** Jev's answer to the choice question as a probability per label, or null when it is missing or names no label of the choices. */
export function jevChoice(answers: unknown, cands: readonly Candidate[]): Distribution | null {
  const a = (answers as { command?: { choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> } } | undefined)?.command;
  const labels = new Set(cands.map((c) => c.label));
  const choice = typeof a?.choice === "string" ? a.choice.trim().toLowerCase() : null;
  if (choice === null || !labels.has(choice)) return null;
  const out: Distribution = {};
  for (const [k, v] of Object.entries(a?.probabilities ?? {})) if (labels.has(k.trim().toLowerCase()) && typeof v === "number" && v >= 0 && v <= 1) out[k.trim().toLowerCase()] = v;
  if (out[choice] === undefined) {
    if (typeof a?.confidence !== "number" || !(a.confidence >= 0 && a.confidence <= 1)) return null;
    out[choice] = a.confidence;
  }
  return out;
}

/** The likeliest effect: its clearest label and the summed probability of its labels, and the next effect the same way. */
export type Choice = { label: string; score: number; second: { label: string; score: number } | null };

/**
 * Jev's distribution over effects: labels whose commands would run the same thing (`effects`: label to effect key; a label without
 * one is its own effect) count as one, with their probabilities summed. An effect is named by its clearest label: a command over
 * `yes`, then the likelier label.
 */
export function groupChoice(dist: Distribution, cands: readonly Candidate[], effects: ReadonlyMap<string, string> = new Map()): Choice | null {
  const groups = new Map<string, { members: Candidate[]; score: number }>();
  for (const c of cands) {
    const key = effects.get(c.label) ?? `label:${c.label}`;
    const g = groups.get(key) ?? { members: [], score: 0 };
    g.members.push(c);
    g.score += dist[c.label] ?? 0;
    groups.set(key, g);
  }
  const named = [...groups.values()].filter((g) => g.members.some((c) => dist[c.label] !== undefined)).sort((a, b) => b.score - a.score);
  const clearest = (g: { members: Candidate[] }): string =>
    [...g.members].sort((a, b) => Number(a.label === "yes") - Number(b.label === "yes") || (dist[b.label] ?? 0) - (dist[a.label] ?? 0))[0]!.label;
  const [top, next] = named;
  if (!top) return null;
  return { label: clearest(top), score: Math.min(1, top.score), second: next ? { label: clearest(next), score: Math.min(1, next.score) } : null };
}
