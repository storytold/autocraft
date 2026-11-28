// Free text to commands, the same on every surface: a GitHub comment, the Discord slash command, the agent's tools and the
// dashboard's text box. Deterministic and without a model call. Anything it cannot read in full comes back `ambiguous` with
// what it did read, and nothing runs from it; resolve.ts then applies the item's state.
//
//   fix-up and merge, urgent         combined commands; a weight word anywhere (urgent, high, low, or weight <1-10>)
//   fix and merge                    fix alone is fix-up
//   fix 1 and 2, drop 3, then merge  an answer naming plan parts by number
//   drop export dialog               a part named by words from its title (resolve.ts matches them)
//   fix the UV seam normals, then merge  fix with words that name no part: the fix-up carries them out (resolve.ts); they run
//   fix: weld the normals and merge  up to a comma, full stop, `and` or `then` before the next command word or a weight
//   implement: store it per document an entry word and a colon before words that are no list of items: the same instructions
//   fix the seams but don't merge    beside instructions, don't merge, review only or hold after end the work with the person
//   merge: photocraft#12 #15         a list of items after a colon; a bare number takes the repo before it
//   review photocraft#12 urgent      items written inline: repo#n, owner/repo#n, a GitHub link, or #n after one (or in an item's context)
//   close as duplicate of #12        a close with its reason: completed, not planned, or duplicate of an item
//   yes / lgtm / go                  runs the open recommendation
//   stop / no, wait / hold for now   a message that only says to hold, with nothing else asked for, is a hold
//
// Ordinary phrasing reads as the same commands (normalise): politeness and approval around a command ("looks good, can you merge
// it please"), the other words in vocab.ts (land, park, carry on, skip ...), "it's a dupe of #12" after a close, conditions AutoCraft
// applies anyway beside a merge ("once CI is green", "when ready"), exceptions to a yes ("yes except 3", "all but the export change"),
// number words, ordinals and ranges for parts ("drop the second one", "fix 1 to 3", "fix both"), and a typo of one letter in a
// command word of five letters or more. Negation, hedges and questions (not, don't, never, maybe, perhaps, unless, should, could we,
// can we, ?) leave a message unread, except the hold phrases "not yet", "not now" and "don't merge yet"; inside a fix's words too.
// Quoted lines and code are not read; inline code in a fix's words stays part of them.
import { commentLines } from "../github/comment-lines.ts";
import { parseBranch, parsePrRef } from "../repin/manifest.ts";
import { COMMAND_TEXT_MAX, WEIGHT_MAX, WEIGHT_MIN, WEIGHT_WORDS, type CloseReason, type CommandPart, type ItemRef, type Parsed, type WeightWord } from "./types.ts";
import { commandOf, COMMANDS, HOLD_WORDS, weightWord, YES_TRAILERS, YES_WORDS } from "./vocab.ts";

export type ParseOptions = {
  /** The app's slug, and its mention name when set: a leading `@<slug>` (or `@<slug>[bot]`) is not part of the command. */
  slug?: string | readonly string[];
  /** The repo of the item the text was written on: a bare number before any `repo#n` in a list, or an inline `#n`, takes it. */
  repo?: string;
};

/** GitHub caps a comment body at 65536 characters. */
const BODY_MAX = 65_536;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionRe = (names: readonly string[]): RegExp => new RegExp(`^@(?:${names.map(escape).join("|")})(?:\\[bot\\])?(?=[\\s,:]|$)[\\s,:]*`, "i");
const isWeightWord = (w: string): w is WeightWord => Object.hasOwn(WEIGHT_WORDS, w);
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** A close's reason as a command writes it: `as not planned`, `as duplicate of photocraft#12`. */
export const closeText = (r: CloseReason): string =>
  r.as === "duplicate" ? `as duplicate of ${r.of.repo ?? ""}#${r.of.number}` : r.as === "not-planned" ? "as not planned" : "as completed";

const CLOSE_RE = /^close\s+(?:as\s+)?(?:(completed)|(not[-\s]planned)|(?:a\s+)?duplicate\s+of\s+(\S+))$/i;

/** The reason after `close`, or null for anything else. */
function readClose(seg: string): CloseReason | null {
  const m = CLOSE_RE.exec(seg);
  if (!m) return null;
  if (m[1]) return { as: "completed" };
  if (m[2]) return { as: "not-planned" };
  const short = /^#(\d+)$/.exec(m[3]!);
  const ref = short ? { repo: null, number: Number(short[1]) } : refOf(m[3]!);
  return ref && Number.isSafeInteger(ref.number) && ref.number > 0 ? { as: "duplicate", of: { repo: ref.repo, number: ref.number } } : null;
}

/** The canonical text of parts and items, as an ambiguous reply quotes what was understood: `fix 1, merge, urgent: photocraft#12`. */
export function describe(parts: readonly CommandPart[], items: readonly ItemRef[] = []): string {
  const words = parts.map((p) => {
    if ("part" in p) return `${p.word} ${"text" in p && p.text ? p.text : p.part}`;
    if ("weight" in p) return weightWord(p.weight) ?? `weight ${p.weight}`;
    if (p.word === "close") return p.reason ? `close ${closeText(p.reason)}` : "close";
    if (p.word === "no-merge") return "don't merge";
    return p.args ? `${p.word} ${p.args}` : p.word;
  }).join(", ");
  const refs = items.map((i) => `${i.repo}#${i.number}`).join(" ");
  return items.length ? (words ? `${words}: ${refs}` : refs) : words;
}

/** The list form: the command, a colon, then the items. A colon that starts `://` belongs to a URL. */
const LIST_FORM = /^([^:\n]+?):(?!\/\/)([\s\S]*)$/;

/** Text in the list form whose items all read (a bare number takes `repo`): the command words before the colon and the items; else null. */
export function listForm(text: string, repo?: string): { words: string; items: ItemRef[] } | null {
  const m = LIST_FORM.exec(text.trim());
  if (!m) return null;
  const read = readItems(m[2]!, repo);
  return read.items.length && !read.bad.length ? { words: m[1]!.trim(), items: read.items } : null;
}

/** Reads text written to AutoCraft. */
export function parse(text: string, opts: ParseOptions = {}): Parsed {
  let s = text.trim().replace(/[\u2018\u2019]/g, "'");
  const names = [opts.slug ?? []].flat().filter(Boolean);
  if (names.length) s = s.replace(mentionRe(names), "");
  // Quoted lines and code blocks are someone else's words; inline code only names a part (readWords).
  const code: string[] = [];
  s = commentLines(s).filter(Boolean).join("\n").replace(/`([^`\n]+)`/g, (_m, c: string) => `${CODE}${code.push(c) - 1}${CODE}`);
  // The words for the author come out first, then a fix's own words, so no other reading (conditions, items, the list form) reaches into them.
  const author = pullAuthorWords(s);
  s = author.text;
  // Words that keep instructions from merging count only beside instructions; anywhere else they stay for the reader.
  const back = pullBack(s);
  const withBack = back.found ? pullInstruction(back.text) : null;
  const said = withBack?.instruction != null ? withBack : pullInstruction(s);
  const noMerge = said === withBack;
  s = said.text;
  const normal = normalise(s);
  s = normal.text;
  const list = LIST_FORM.exec(s);
  const head = list ? list[1]! : s;
  const inline = pullItems(head, opts.repo);
  const marked = pullItems(head, opts.repo, true);
  let items = inline.items;
  s = inline.text;
  // The items an ambiguous reply may quote: not those that stood inside words it could not read.
  const named = (r: Read, all: ItemRef[]): ItemRef[] => {
    const lost = [...r.tainted].map((id) => marked.marks[id]!.ref);
    return all.filter((i) => !lost.some((l) => l.repo === i.repo && l.number === i.number) || !inline.items.some((x) => x.repo === i.repo && x.number === i.number));
  };
  if (list) {
    const read = readItems(list[2]!, inline.last ?? opts.repo);
    items = addItems(items, read.items);
    if (read.bad.length || !read.items.length) {
      const r = readWords(marked.text, marked.marks, code, said.instruction, author.words);
      return { kind: "ambiguous", understood: describe(r.parts, named(r, items)), rest: [...r.unknown, ...read.bad].join(" ") };
    }
  }
  const plain = s.replace(CODE_RE, " ");
  // A condition is read only beside the command it belongs to, so a bare yes or hold with one stays unread.
  if (!normal.conditions.length && !normal.refused) {
    const yes = readYes(plain);
    if (yes) return { kind: "yes", ...(items.length ? { items } : {}), ...(yes.weight === null ? {} : { weight: yes.weight }) };
    if (saysHold(plain)) return { kind: "commands", items, parts: [{ word: "hold" }] };
  }
  const r = readWords(marked.text, marked.marks, code, said.instruction, author.words);
  if (noMerge) r.parts.push({ word: "no-merge" });
  const unmet = unmetConditions(normal.conditions, r.parts);
  const guard = GUARD.exec(marked.text.replace(INSTRUCTION_RE, () => ` ${said.instruction} `).replace(MARK_RE, " ").replace(CODE_RE, " ").replace(/(?<![\w-])not[-\s]planned(?![\w-])/gi, " "))?.[0];
  const rest = [...r.unknown, ...unmet, ...(normal.refused ? [normal.refused] : []), ...(guard && !r.unknown.some((u) => u.toLowerCase().includes(guard.toLowerCase())) ? [guard] : [])];
  if (rest.length || r.conflict || !r.parts.length) return { kind: "ambiguous", understood: describe(r.parts, named(r, items)), rest: rest.join(", ") };
  return { kind: "commands", items, parts: r.parts, ...(r.yes ? { yes: true } : {}) };
}

/** Wraps the index of an inline code span taken out of the text. */
const CODE = "\u0002";
const CODE_RE = /\u0002(\d+)\u0002/g;

/**
 * Words that turn, soften or ask about what they stand beside ("should we merge this" asks, without a question mark). A message holding
 * one is never read as a command, whatever else it says; the hold phrases that hold one ("not yet", "don't merge yet") are read before this.
 */
export const GUARD = /(?<![\w-])(?:not|never|maybe|perhaps|unless|dont|do not|cannot|cant|wont|shouldnt|should|could we|can we)(?![\w-])|n't(?![\w-])|\?/i;

/**
 * The command in a GitHub comment, or null when no line of it is addressed to the app. A command starts on a line of its own with
 * `@<slug>`; quoted, fenced, indented and HTML-commented lines never count (commentLines). In the list form, the lines after
 * `@<slug> merge:` up to the next blank or hidden line are the items. Several addressed lines are read as one text, so an unclear
 * mix is ambiguous rather than half run. A command whose comment goes on with a condition ("merge", then "after CI is green") is
 * ambiguous too; a hold stands, whatever the comment says about it.
 */
export function parseComment(body: unknown, slug: string | readonly string[], opts: Omit<ParseOptions, "slug"> = {}): Parsed | null {
  const a = addressed(body, slug);
  if (!a) return null;
  const { texts, condition, accepted } = a;
  const p = parse(texts.join("\n"), opts);
  if (p.kind === "commands" && p.parts.every((x) => x.word === "hold")) return p;
  // A condition every merge meets on a later line counts as it does on the command's own line: only beside a merge.
  const unmet = condition ?? (p.kind === "commands" ? unmetConditions(accepted, p.parts)[0] ?? null : accepted[0]?.text ?? null);
  if (unmet === null) return p;
  const rest = unmet;
  if (p.kind === "ambiguous") return { ...p, rest: [p.rest, rest].filter(Boolean).join(", ") };
  return { kind: "ambiguous", understood: p.kind === "yes" ? "yes" : describe(p.parts, p.items), rest };
}

/** The text without a leading mention of the app (`@<slug>`, `@<slug>[bot]`). */
export const withoutMention = (text: string, slug: string | readonly string[]): string => {
  const names = [slug].flat().filter(Boolean);
  return names.length ? text.trimStart().replace(mentionRe(names), "") : text;
};

/** The longest question `ask` takes (the chat's message limit). */
export const QUESTION_MAX = COMMAND_TEXT_MAX;
const ASK_RE = /^(?:(?:please|pls)\s+)?ask(?![\w-])[\s,:]*/i;
/** `ask author`, `ask the author`: the ask-author command, never a question. */
const AUTHOR_NEXT = /^(?:the\s+)?author(?![\w-])/i;

/**
 * The question of an `ask <question>` message ("ask why does the export drop alpha?"), as written after `ask`; null for any other text,
 * `ask author` and its forms included. A mention of the app in front is dropped. Nothing else of the text is read: the question is the
 * person's own words, with no question mark needed.
 */
export function askedQuestion(text: string, opts: Pick<ParseOptions, "slug"> = {}): string | null {
  let s = text.trim().replace(/[\u2018\u2019]/g, "'");
  const names = [opts.slug ?? []].flat().filter(Boolean);
  if (names.length) s = s.replace(mentionRe(names), "");
  const m = ASK_RE.exec(s);
  if (!m) return null;
  const q = s.slice(m[0].length).trim();
  return /[\p{L}\p{N}]/u.test(q) && !AUTHOR_NEXT.test(q) ? q.slice(0, QUESTION_MAX) : null;
}

/**
 * The question of a GitHub comment whose first line addressed to the app is `@<slug> ask <question>`: that line's text and every visible
 * line after it (commentLines), so a question may run over several lines. Null for any other comment.
 */
export function commentQuestion(body: unknown, slug: string | readonly string[]): string | null {
  const names = [slug].flat().filter(Boolean);
  if (typeof body !== "string" || !names.length) return null;
  const lines = commentLines(body.slice(0, BODY_MAX));
  const mention = mentionRe(names);
  const at = lines.findIndex((l) => mention.test(l));
  return at < 0 ? null : askedQuestion([lines[at]!.replace(mention, ""), ...lines.slice(at + 1)].join("\n"));
}

/** The conditions that do not stand beside what they need: a merge, and for the review, a start that reviews. */
function unmetConditions(conditions: readonly Condition[], parts: readonly CommandPart[]): string[] {
  const has = (w: string) => parts.some((p) => p.word === w);
  return conditions.filter((c) => !has("merge") || (c.needs === "entry" && !["review", "fix-up", "implement"].some(has))).map((c) => c.text);
}

/** The condition a GitHub comment sets after its addressed lines ("but wait for CI", "after CI"), or null. */
export const commentCondition = (body: unknown, slug: string | readonly string[]): string | null => {
  const a = addressed(body, slug);
  return a ? a.condition ?? a.accepted[0]?.text ?? null : null;
};

/** The addressed texts of a comment and the first condition after them; null when no line is addressed to the app. */
function addressed(body: unknown, slug: string | readonly string[]): { texts: string[]; condition: string | null; accepted: Condition[] } | null {
  const names = [slug].flat().filter(Boolean);
  if (typeof body !== "string" || !names.length) return null;
  const lines = commentLines(body.slice(0, BODY_MAX));
  const mention = mentionRe(names);
  const texts: string[] = [];
  let condition: string | null = null;
  const accepted: Condition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!mention.test(line)) continue;
    let text = line.replace(mention, "");
    if (/^[^:]+:(?!\/\/)/.test(text)) {
      while (i + 1 < lines.length && lines[i + 1] && !mention.test(lines[i + 1]!)) text += `\n${lines[++i]}`;
    }
    texts.push(text);
    condition ??= conditionIn(lines.slice(i + 1), mention, accepted);
  }
  return texts.length ? { texts, condition, accepted } : null;
}

/** Words that open a condition on what was said before. */
export const CONDITION = /^(?:if|unless|but|wait|after|when|until|not)$/;
/** Words a condition may start with before its own ("please only merge it when ..."). */
const LEAD_IN = new Set(["and", "so", "then", "only", "just", "please", "pls", "also", "though", "maybe", "perhaps", "thanks", "ok", "okay", "yes", "no", "let", "us", "lets", "let's", "i", "i'd", "we", "we'd", "would", "should", "do", "go", "land", "merge", "it", "this", "that", "the"]);
/** Words beside an accepted condition that leave it the only thing its clause says. */
const ACCEPTED_FILLER = new Set(["thanks", "thank", "you", "thx", "pls"]);

/**
 * The sentence with a condition in what follows an addressed line, up to the end of the next paragraph, or null. A condition opens its line or
 * clause ("but wait for CI", "only merge it when CI is green"); the same word inside another sentence ("it crashed when a file was empty") is a reason.
 * `don't` counts as `do not`; unless and until count anywhere.
 */
function conditionIn(after: readonly string[], mention: RegExp, accepted: Condition[]): string | null {
  let gaps = 0, text = false;
  for (const line of after) {
    if (mention.test(line)) return null;
    if (!line) { gaps += text || gaps === 0 ? 1 : 0; text = false; if (gaps > 2) return null; continue; }
    text = true;
    if (gaps > 1) return null;
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      for (const clause of sentence.toLowerCase().replace(/\u2019/g, "'").replace(/\bdon'?t\b/g, "do not").split(/[,;:()]|\s[-\u2013\u2014]\s/)) {
        // A clause that is only a condition every merge meets ("after CI", "only when the tests pass") goes to `accepted`.
        const found: Condition[] = [];
        let left = clause;
        for (const { re, needs } of CONDITIONS) left = left.replace(re, (m) => { found.push({ text: m.trim(), needs }); return " "; });
        if (found.length && left.replace(/[^\p{L}\p{N}' -]+/gu, " ").split(/\s+/).every((w) => !w || LEAD_IN.has(w) || ACCEPTED_FILLER.has(w))) { accepted.push(...found); continue; }
        const words = clause.replace(/[^\p{L}\p{N}' -]+/gu, " ").replace(/^[\s-]+/, "").split(/\s+/).filter(Boolean);
        if (CONDITION.test(words.find((w) => !LEAD_IN.has(w)) ?? "") || words.some((w) => w === "unless" || w === "until")) return sentence.replace(/[.!]+$/, "").slice(0, 200);
      }
    }
  }
  return null;
}

type Read = { parts: CommandPart[]; unknown: string[]; conflict: boolean; /** A yes-word stood beside the commands ("yes, merge"). */ yes: boolean; /** Inline items that stood inside words that were not read. */ tainted: ReadonlySet<number> };

/** A yes-word with nothing else but a weight and politeness: `yes`, `lgtm, thanks`, `go ahead, urgent`. */
function readYes(s: string): { weight: number | null } | null {
  let weight: number | null = null;
  let bad = false;
  const setW = (w: number) => { if (weight !== null && weight !== w) bad = true; weight = w; };
  let t = norm(s.replace(/[,.!;]+/g, " "));
  t = t.replace(/(^| )weight (\d+)(?= |$)/g, (_m, pre: string, n: string) => {
    const w = Number(n);
    if (w < WEIGHT_MIN || w > WEIGHT_MAX) bad = true;
    else setW(w);
    return pre;
  });
  const words = t.split(" ").filter((w) => {
    if (!isWeightWord(w)) return true;
    setW(WEIGHT_WORDS[w]);
    return false;
  });
  let rest = words.join(" ");
  for (let again = true; again;) {
    again = false;
    for (const tr of YES_TRAILERS) if (rest.endsWith(` ${tr}`)) { rest = rest.slice(0, -tr.length - 1); again = true; }
    for (const lead of YES_LEADS) if (rest.startsWith(`${lead} `)) { rest = rest.slice(lead.length + 1); again = true; }
  }
  return !bad && YES_WORDS.includes(rest) ? { weight } : null;
}

/**
 * Filler a maintainer writes around a command word: "please merge it now", "ok go ahead and merge", "yes, merge the PR". A small
 * explicit list; words that change a meaning (don't, not, no, wait, hold, later, unless, but, if, instead) are never in it, so such
 * a reply stays unread.
 */
const FILLER_WORDS = [
  "thank you", "thanks", "thx", "please", "pls", "the pull request", "the pr", "this pull request", "this pr", "its pull request", "its pr",
  "the issue", "this issue", "this one", "the rest", "go ahead", "sounds good", "lgtm", "looks good to me", "looks good", "looks great",
  "approve", "approved", "yes", "yep", "yeah", "yup", "ok", "okay", "sure", "great", "nice", "perfect", "cool", "nice work", "great work",
  "good work", "can you", "could you", "would you", "will you", "let's", "lets", "let us", "for now", "now", "it", "this", "that", "just",
];
const THANKS_FOR = String.raw`thanks?(?: you)? for (?:the |this |your )?(?:fix|pr|pull request|change|changes|work|contribution|patch|report)`;
const FILLER = new RegExp(`(?<![\\w-])(?:${THANKS_FOR}|${FILLER_WORDS.map(escape).sort((a, b) => b.length - a.length).join("|")})(?![\\w-])`, "gi");
/** Words a yes may carry before it: "thanks, looks good", "let's do it". */
const YES_LEADS: readonly string[] = ["please", "pls", "ok", "okay", "thanks", "thank you", "thx", "great", "nice", "perfect", "cool", "let's", "lets"];
const stripFiller = (seg: string): string => seg.replace(FILLER, " ").replace(/\s+/g, " ").trim();
const saysYes = (seg: string): boolean => (seg.match(FILLER) ?? []).some((w) => YES_WORDS.includes(w.toLowerCase()));

const any = (words: readonly string[]): string => words.map(escape).sort((a, b) => b.length - a.length).join("|");
/** Nothing but a hold word and what people write around one: "no, stop", "let's wait", "hold the merge for now". */
const HOLD_ONLY = new RegExp(`^(?:(?:no|oh|ok|okay|sorry|actually|please|pls|just|let'?s|let us|we should) )*(?:${any(HOLD_WORDS)})(?: (?:${any([...HOLD_WORDS, "please", "pls", "thanks", "thank you", "thx", "for now", "right now", "now", "for a moment", "a moment", "a minute", "a sec", "the merge", "merging", "it", "this", "that", "everything"])}))*$`);
/** What a text beside a hold word may not hold: another command, a yes, or a condition. */
const ASKS = new RegExp(`(?<![\\w-])(?:${any([...COMMANDS.filter((c) => c.word !== "hold").flatMap((c) => [c.word, ...c.aliases]), ...YES_WORDS, "merging", "if", "unless", "until", "but", "after", "when", "then", "not", "instead", "only"])})(?![\\w-])|n't(?![\\w-])`, "i");

/** The message only says to hold: hold words first, and after them nothing that asks for anything ("stop. I will look"). */
function saysHold(s: string): boolean {
  const sentences = s.replace(/\u2019/g, "'").split(/[.!;\n]+/).map((x) => norm(x.replace(/,/g, " "))).filter(Boolean);
  for (let k = sentences.length; k > 0; k--) {
    if (HOLD_ONLY.test(sentences.slice(0, k).join(" "))) return !sentences.slice(k).some((x) => ASKS.test(x));
  }
  return false;
}

type Condition = { text: string; /** What must stand beside it: a merge, or a merge and a start whose steps hold the review. */ needs: "merge" | "entry" };

const ITEM_AHEAD = String.raw`(?=\s*(?:https?:\/\/|(?:[\w.-]+\/)?[\w.-]*#\d))`;
/** "it's a dupe of #12", "same as #12" and a close beside them, as `close as duplicate of #12`; "close it, not planned" as `close as not planned`. */
const DUPLICATE: readonly [RegExp, string][] = [
  [/(?<![\w-])(?:it's|its|it is|this is|that's|that is)\s+(?:a\s+)?(?:dupe|duplicate)\s+of(?![\w-])/gi, "duplicate of"],
  [/(?<![\w-])(?:a\s+)?dupe\s+of(?![\w-])/gi, "duplicate of"],
  [new RegExp(String.raw`(?<![\w-])(?:it's\s+|it is\s+|this is\s+)?(?:the\s+)?same\s+(?:issue\s+|thing\s+|bug\s+)?as${ITEM_AHEAD}`, "gi"), "duplicate of"],
  [/(?<![\w-])close((?:\s+(?:the pull request|this pull request|the issue|this issue|the pr|this pr|this one|this|it|that))?)\s*(?:[,;]|\s[-\u2013\u2014])?\s*(?:as\s+)?(?:a\s+)?duplicate\s+of(?![\w-])/gi, "close$1 as duplicate of"],
  [/(?<![\w-])close((?:\s+(?:the pull request|this pull request|the issue|this issue|the pr|this pr|this one|this|it|that))?)\s*(?:[,;]|\s[-\u2013\u2014])\s*(?:as\s+)?(not[-\s]planned|completed)(?![\w-])/gi, "close$1 as $2"],
];
const CI = String.raw`(?:the\s+)?(?:ci(?:\s+checks)?|checks|tests|build)`;
const PASSES = String.raw`(?:is\s+|are\s+|goes\s+|turns\s+|has\s+|have\s+)?(?:green|pass(?:es|ed)?|succeeds?|succeeded|done|finished|finishes)`;
/** Conditions every merge meets anyway: green CI, mergeable, and (with a start that reviews) the review. */
const CONDITIONS: readonly { re: RegExp; needs: Condition["needs"] }[] = [
  { re: new RegExp(String.raw`(?<![\w-])(?:only\s+)?(?:once|when|after|as soon as)\s+(?:${CI}\s+${PASSES}|(?:it's|it is|it)\s+(?:green|passes|goes green|turns green))(?![\w-])`, "gi"), needs: "merge" },
  // "after CI" means after it passes: a merge never runs on red CI.
  { re: new RegExp(String.raw`(?<![\w-])(?:only\s+)?after\s+(?:green\s+)?${CI}(?![\w-])`, "gi"), needs: "merge" },
  { re: /(?<![\w-])(?:only\s+)?on\s+green\s+ci(?![\w-])/gi, needs: "merge" },
  { re: /(?<![\w-])(?:only\s+)?(?:once|when)\s+(?:it's\s+|it is\s+|you're\s+|you are\s+)?ready(?![\w-])/gi, needs: "merge" },
  { re: /(?<![\w-])(?:only\s+)?(?:(?:after|once|when)\s+(?:the\s+|a\s+)?review(?:\s+(?:is\s+)?(?:done|passes|finished|clean))?|(?:after|once|when)\s+(?:it's\s+|it is\s+|it has been\s+)?reviewed)(?![\w-])/gi, needs: "entry" },
];
const ALL_WORDS = String.raw`all(?:\s+of\s+(?:them|it))?|everything`;
/** `yes except 3`, `all but the export change`, `merge everything except 2`: the yes, or the command, with those parts dropped. */
const EXCEPT_RE = new RegExp(String.raw`^((?:(?:${any([...YES_WORDS.filter((w) => w.length > 1), "sure"])})[\s,]+)*)(?:(merge|land|fix)\s+)?(${ALL_WORDS})?[\s,]*(?<![\w-])(but|except(?:\s+for)?|apart\s+from|other\s+than|minus|save\s+for)\s+([\s\S]+)$`, "i");
const DROP_VERB = /^(?:drop|skip|leave\s+out)\s+(.+)$/i;
/** Words that make an exception a condition, not a list of parts. */
const NOT_PARTS = /(?<![\w-])(?:if|when|once|unless|until|after|before|wait|not|never|maybe|perhaps)(?![\w-])|n't|\?/i;

/** Ordinary phrasing rewritten into the command words it means; anything else is left as written for readWords to judge. */
function normalise(text: string): { text: string; conditions: Condition[]; /** An exception naming a command or step: the message is not read. */ refused: string | null } {
  let s = text.replace(/(?<![\w-])(urgent|high|low)[-\s]+priority(?![\w-])/gi, "$1");
  for (const [re, to] of DUPLICATE) s = s.replace(re, to);
  const conditions: Condition[] = [];
  for (const { re, needs } of CONDITIONS) s = s.replace(re, (m) => { conditions.push({ text: m.trim(), needs }); return " "; });
  const ex = EXCEPT_RE.exec(s.trim());
  if (ex) {
    const [, lead, cmd, all, sep, list] = ex as unknown as [string, string, string | undefined, string | undefined, string, string];
    // Only an explicit "then" ends the list of parts; what follows it is read as written.
    const [except, then] = splitThen(list);
    const pieces = except.split(/\s*[,;\n]\s*|[.!]+\s+|\s+(?:and|&|or)\s+/i).map((x) => x.trim().replace(/[.!]+$/, "")).filter(Boolean);
    const ok = (lead.trim() || all) && (!cmd || all) && !NOT_PARTS.test(except) && pieces.length && (sep.toLowerCase() !== "but" || all || DROP_VERB.test(pieces[0]!));
    if (ok) {
      // "yes except merge" must never merge: an exception that names a command or a step leaves the message unread.
      const step = pieces.find((x) => namesStep(DROP_VERB.exec(x)?.[1] ?? x));
      if (step) return { text, conditions, refused: `${sep} ${step}` };
      const out = pieces.map((x) => (DROP_VERB.test(x) || isWeightWord(x.toLowerCase()) || /^weight\s+\d+$/i.test(x) ? x : `drop ${x}`));
      const word = cmd?.toLowerCase();
      s = [word ? null : "yes", word === "fix" ? "fix-up" : null, ...out, word === "merge" || word === "land" ? "merge" : null, then].filter(Boolean).join(", ");
    }
  }
  return { text: s, conditions, refused: null };
}

/** Stands for a fix's own words taken out of the text (pullInstruction). */
const INSTRUCTION = "\u00030\u0003";
const INSTRUCTION_RE = /\u0003\d+\u0003/g;
/** Words that start the next command after a fix's words: every command word and alias, and the weights. */
const NEXT_COMMAND = String.raw`(?:(?:please|pls|also)\s+)?(?=(?:${any([...COMMANDS.flatMap((c) => [c.word, ...c.aliases]), ...Object.keys(WEIGHT_WORDS), "weight"])})(?![\w-]))`;
const LIST_ITEM = String.raw`(?:https?:\/\/\S+|(?:[\w.-]+\/)?[\w.-]*#\d+|\d+)`;
/** Where a fix's words end: a comma, semicolon, new line or full stop, or `and` / `then`, before the next command; or the colon of a list of items. */
const INSTRUCTION_END = new RegExp(String.raw`(?:\s*[,;\n]\s*|[.!]+\s+)(?:(?:and\s+then|then|and|&)\s+)?${NEXT_COMMAND}|\s+(?:and\s+then|then|and|&)\s+${NEXT_COMMAND}|\s*(?=:\s*${LIST_ITEM}(?:(?:[\s,;]+(?:and\s+|&\s*)?)${LIST_ITEM})*[\s.]*$)`, "i");
/** Words after fix that mean every planned part, as fix alone does. */
const EVERY_PART = /^(?:them|those|these|them all|all those|all these|the (?:findings|fixes|issues|problems)|the review(?:'s)? (?:findings|fixes)|what the review (?:found|lists|asks for))$/i;

/** The words after a fix that name parts as the reader already reads them: numbers, positions, all or both, a weight, or nothing but filler. */
function namesParts(words: string): boolean {
  if (CODE_RE.test(words)) { CODE_RE.lastIndex = 0; return false; }
  const bare = stripFiller(words).toLowerCase();
  if (!bare || /^up(?![\w-])/.test(bare) || EVERY_PART.test(bare) || BOTH_PARTS.test(bare) || ALL_PARTS.test(bare) || POSITION.test(bare)) return true;
  if (/^[#\d][#\d\s,&\-\u2013]*$/.test(bare) || partNumbers(bare)) return true;
  return bare.split(/\s+/).every((w, i, all) => isWeightWord(w) || w === "weight" || (/^\d+$/.test(w) && all[i - 1] === "weight"));
}

/**
 * The first fix whose words name something other than parts by number, position or all ("fix the UV seam normals, then merge",
 * "fix: weld the normals"): its words up to where the next command starts come out of the text, and `fix` stays with a marker in their
 * place. Whether the words name a part by its title only the plan tells (resolve.ts). "fix all but 2" stays for normalise.
 */
function pullInstruction(text: string): { text: string; instruction: string | null } {
  if (EXCEPT_RE.test(text.trim())) return { text, instruction: null };
  // "implement: store it per document", "fix-up: rename the helper too": an entry word's colon before words that are no list of items.
  const entry = ENTRY_COLON.exec(text);
  if (entry) {
    const tail = text.slice(entry.index + entry[0].length);
    const end = INSTRUCTION_END.exec(tail);
    const words = trimInstruction(end ? tail.slice(0, end.index) : tail);
    const items = readItems(words, undefined);
    if (words && /[\p{L}]/u.test(words.replace(CODE_RE, "")) && (items.bad.length || !items.items.length)) {
      return { text: `${text.slice(0, entry.index)}${entry[1]} and fix ${INSTRUCTION}${end ? tail.slice(end.index) : ""}`, instruction: words };
    }
  }
  for (const m of text.matchAll(/(?<![\w-])fix(?![\w-])/gi)) {
    const tail = text.slice(m.index + m[0].length);
    const end = INSTRUCTION_END.exec(tail);
    const words = trimInstruction(end ? tail.slice(0, end.index) : tail);
    if (!words || namesParts(words)) continue;
    return { text: `${text.slice(0, m.index)}fix ${INSTRUCTION}${end ? tail.slice(end.index) : ""}`, instruction: words };
  }
  return { text, instruction: null };
}

/** An instruction's words without the colon before them and the punctuation and thanks after them. */
const trimInstruction = (raw: string): string =>
  raw.replace(/^\s*:?\s*/, "").replace(/[\s,;.!]+$/, "").replace(/(?:[\s,]+(?:thanks|thank you|thx|please|pls))+[.!]*$/i, "").trim();

/** An entry word and a colon: what follows may be instructions (pullInstruction). */
const ENTRY_COLON = /(?<![\w-])(review|fix-?up|fix up|implement|merge|land)\s*:(?!\/\/)/i;

/**
 * Words that end instructions with the person instead of a merge ("but don't merge", "review only", "then hold", "come back to me"),
 * with the connector before them. They count only as a clause of their own, so the same words inside instructions stay theirs.
 */
const BACK_RE = /(?:^|\s*[,;.\n]\s*|\s+(?=(?:but|and|then)\s))(?:(?:but|and|then|just|please)\s+)*(?:(?:do not|don't|dont)\s+merge(?:\s+(?:it|this|that|yet))*|without\s+merging|no\s+merge|(?:review|reviewing)\s+only|only\s+review|hold(?:\s+(?:it|this))?\s+after(?:wards?|\s+that)?|then\s+hold(?:\s+(?:it|this))?|(?:then\s+)?come\s+back\s+to\s+me|(?:ask|check\s+with)\s+me\s+before\s+merging)(?=\s*(?:$|[,;.!\n]))/gi;

/** The text without the words that keep instructions from merging, and whether it had any. */
function pullBack(text: string): { text: string; found: boolean } {
  let found = false;
  const out = text.replace(BACK_RE, () => { found = true; return ", "; }).replace(/^[\s,]+/, "");
  return { text: out, found };
}

/** Stands for the person's words for the author taken out of the text (pullAuthorWords). */
const AUTHOR_MARK = "\u0004";
/** The words of the ask-author command, longest first. */
const ASK_AUTHOR_RE = new RegExp(`(?<![\\w-])(?:${any(["ask author", ...COMMANDS.filter((c) => c.word === "ask-author").flatMap((c) => [c.word, ...c.aliases])])})(?![\\w-])`, "i");

/** Words after ask author that doubt the command itself ("ask the author? not sure", "ask author, maybe"): they are not words for the author. */
const DOUBT_START = /^(?:\?|(?:maybe|perhaps|possibly|probably|unless|if|or|not sure|unsure|i guess|i think)(?![\w-]))/i;

/**
 * The first ask-author command and the person's words for the author after it ("ask the author to wire in the group editor, then merge"),
 * up to where the next command starts: they come out of the text, and the command stays with a marker in their place. A leading
 * "to", "for" or "that" is not theirs. Words that start with a question mark or a hedge stay in the text, so the message reads as ambiguous.
 */
function pullAuthorWords(text: string): { text: string; words: string | null } {
  const m = ASK_AUTHOR_RE.exec(text);
  if (!m) return { text, words: null };
  const tail = text.slice(m.index + m[0].length);
  const end = INSTRUCTION_END.exec(tail);
  const raw = end ? tail.slice(0, end.index) : tail;
  if (DOUBT_START.test(raw.replace(/^[\s,;:]+/, ""))) return { text, words: null };
  const words = raw.replace(/^\s*:?\s*/, "").replace(/^(?:to|for|that)\s+/i, "").replace(/[\s,;.!]+$/, "").trim();
  return { text: `${text.slice(0, m.index)}ask-author${words ? ` ${AUTHOR_MARK}` : ""}${end ? tail.slice(end.index) : ""}`, words: words || null };
}

/** The list before the first `then` / `and then`, and what follows it (null without one). */
function splitThen(list: string): [string, string | null] {
  const m = /(?:\s*[,;]\s*|\s+)(?:and\s+)?then\s+/i.exec(list);
  return m ? [list.slice(0, m.index), list.slice(m.index + m[0].length)] : [list, null];
}

/** Every command word and alias, and the steps a person may name: words an exception never drops as a part. */
const STEP_RE = new RegExp(`(?<![\\w-])(?:${any([...COMMANDS.flatMap((c) => [c.word, ...c.aliases]), "fix up", "ci", "tests", "test", "checks", "build", "builds", "review", "reviews", "merging", "closing", "approval", "merge queue"])})(?![\\w-])`, "i");
function namesStep(piece: string): boolean {
  const t = norm(piece.replace(CODE_RE, " "));
  return STEP_RE.test(t) || t.split(/[^\p{L}\p{N}-]+/u).some((w) => typoOf(w) !== null);
}

const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** A part number written as digits, `#n`, a number word or an ordinal (`second`, `2nd`), else null. */
function numberOf(w: string): number | null {
  const d = /^#?(\d+)(?:st|nd|rd|th)?$/.exec(w);
  if (d) return Number(d[1]) > 0 ? Number(d[1]) : null;
  const i = NUMBER_WORDS.indexOf(w), j = ORDINALS.indexOf(w);
  return i >= 0 ? i + 1 : j >= 0 ? j + 1 : null;
}

/**
 * The parts named only by number, as digit tokens (weight words kept): `the second one`, `1-3`, `first to third`, `two and four`.
 * Null when any word is no number, so the text names a part by its title instead.
 */
function partNumbers(arg: string): string[] | null {
  const t = arg.toLowerCase().replace(/[,&]/g, " ").replace(/(\S+?)\s*(?:-|\u2013|\s(?:to|through|thru)\s)\s*(\S+)/g, (m, a: string, b: string) => {
    const x = numberOf(a), y = numberOf(b);
    return x === null || y === null || x >= y || y - x > 20 ? m : Array.from({ length: y - x + 1 }, (_v, k) => String(x + k)).join(" ");
  });
  const out: string[] = [];
  let ordinal = false;
  for (const w of t.split(/\s+/).filter(Boolean)) {
    if (["the", "and", "part", "parts", "finding", "findings", "change", "changes", "number"].includes(w) || (w === "one" && ordinal)) continue;
    const n = numberOf(w);
    ordinal = ORDINALS.includes(w) || /^\d+(?:st|nd|rd|th)$/.test(w);
    if (n !== null) out.push(String(n));
    else if (isWeightWord(w)) out.push(w);
    else return null;
  }
  return out.some((w) => /^\d+$/.test(w)) ? out : null;
}

/** "both" and "all of them" where parts are expected; resolve.ts reads them against the plan. */
const ALL_PARTS = /^(?:(?:all|each)(?:\s+of\s+(?:them|it|these|those))?|everything|every\s+one|each\s+one)$/i;
const BOTH_PARTS = /^both(?:\s+of\s+them)?$/i;
const POSITION = /^(?:the\s+)?(?:last|final|latter|former|other|previous|next|rest)(?:\s+(?:one|two|three|part|parts))?$/i;

/**
 * Command words a typo of reads as: five letters or more, and never close, which acts on GitHub. Only a wrong letter or two letters
 * swapped count, so inflections and other words a letter longer or shorter don't.
 */
const TYPO_WORDS: readonly string[] = [...COMMANDS.filter((c) => c.word.length >= 5 && c.word !== "autorepin" && c.word !== "close").map((c) => c.word), "fixup"];
/** Real words a letter away from a command word. */
const NOT_TYPOS = new Set(["verge", "serge", "emerge", "merged", "merger", "merges", "preview", "reviews", "closed", "clone", "close's", "closet", "cloze", "chose", "lose", "resumé"]);

/** The command word `w` misspells by one wrong letter or one swap of neighbours, when exactly one fits. */
function typoOf(w: string): string | null {
  if (w.length < 5 || NOT_TYPOS.has(w)) return null;
  const hits = TYPO_WORDS.filter((c) => c !== w && oneSwapOrSubstitution(w, c));
  return hits.length === 1 ? hits[0]! : null;
}

function oneSwapOrSubstitution(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.slice(i + 1) === b.slice(i + 1)) return true;
  return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

/** A fix or drop with the parts it names; drop's other words (skip, leave out) too. */
const NAMED_RE = new RegExp(`^(${any(COMMANDS.filter((c) => c.answer).flatMap((c) => [c.word, ...c.aliases]))})\\s+(.+)$`, "i");

/** Commands, separated by commas, semicolons, new lines, `and` or `then`. */
function readWords(src: string, marks: readonly { tok: string }[] = [], code: readonly string[] = [], instruction: string | null = null, author: string | null = null): Read {
  const tainted = new Set<number>();
  const parts: CommandPart[] = [];
  const unknown: string[] = [];
  const weights: { text: string; w: number }[] = [];
  let yes = false;
  let s = src.trim().replace(/[.!]+$/, "");
  s = s.replace(/(^|[\s,;])weight\s+(\d+)(?=$|[\s,;])/gi, (m, pre: string, n: string) => {
    const w = Number(n);
    if (w < WEIGHT_MIN || w > WEIGHT_MAX) unknown.push(m.trim());
    else weights.push({ text: m.trim(), w });
    return `${pre} `;
  });
  const takeWeights = (tokens: string[]): string[] => tokens.filter((tok) => {
    const low = tok.toLowerCase();
    if (!isWeightWord(low)) return true;
    weights.push({ text: tok, w: WEIGHT_WORDS[low] });
    return false;
  });
  const push = (p: CommandPart) => {
    const key = JSON.stringify(p);
    if (!parts.some((q) => JSON.stringify(q) === key)) parts.push(p);
  };
  const readSeg = (text: string): void => {
    const before = unknown.length;
    const ids = [...text.matchAll(MARK_RE)].map((m) => Number(m[1]));
    readOne(text.replace(MARK_RE, " "));
    if (unknown.length === before || !ids.length) return;
    // An item named inside words that were not read is part of those words, not a target.
    for (const id of ids) tainted.add(id);
    unknown[unknown.length - 1] = [unknown[unknown.length - 1], ...ids.map((id) => marks[id]?.tok)].filter(Boolean).join(" ");
  };
  const readOne = (raw: string): void => {
    let seg = raw.trim().replace(/\s+/g, " ").replace(/^(?:(?:and then|then|and|please) )+/i, "").replace(/(?: (?:and|&))+$/i, "").trim();
    if (!seg) return;
    // The words for the author (pullAuthorWords), as written, inline code in backticks.
    if (/^ask-author(?:\s+\u0004)?$/i.test(seg)) {
      const words = /\u0004/.test(seg) && author ? author.replace(CODE_RE, (_m, i: string) => `\`${code[Number(i)] ?? ""}\``).replace(/\s+/g, " ").trim() : "";
      push({ word: "ask-author", ...(words ? { args: words } : {}) });
      return;
    }
    if (!/^auto[-\s]?repin(?:\s|$)/i.test(seg)) {
      const bare = stripFiller(seg);
      yes ||= saysYes(seg);
      if (!bare) return;
      // "yes?" asks, so what is left of it says nothing: the words as written are what was not understood.
      if (!/[\p{L}\p{N}]/u.test(bare.replace(CODE_RE, ""))) { if (bare.replace(CODE_RE, "").trim()) unknown.push(seg.replace(CODE_RE, " ").trim()); return; }
      seg = bare;
    }
    // A fix's own words (pullInstruction): a part's title when they match one, else what the fix-up is to do (resolve.ts).
    if (instruction !== null && /^fix \u0003\d+\u0003$/i.test(seg)) {
      const withCode = (x: string, quote: string) => x.replace(CODE_RE, (_m, i: string) => `${quote}${code[Number(i)] ?? ""}${quote}`);
      push({ word: "fix", part: withCode(stripFiller(instruction), " ").replace(/\s+/g, " ").trim(), text: withCode(instruction, "`") });
      return;
    }
    // Inline code counts only as words of a part's title.
    const named = NAMED_RE.exec(seg);
    seg = seg.replace(CODE_RE, " ").replace(/\s+/g, " ").trim();
    if (named && !/^fix\s+up(?:\s|$)/i.test(seg)) {
      const word = /^fix$/i.test(named[1]!) ? "fix" : "drop";
      const arg = named[2]!.replace(CODE_RE, (_m, i: string) => ` ${code[Number(i)] ?? ""} `).trim().replace(/\s+/g, " ");
      // "skip review" means a step, not a part.
      if (word === "drop" && !/^drop$/i.test(named[1]!) && /^(?:the\s+)?(?:review|fix-?up|ci|checks|tests|build|merge)$/i.test(arg)) { unknown.push(seg); return; }
      if (BOTH_PARTS.test(arg) || ALL_PARTS.test(arg)) { push({ word, part: BOTH_PARTS.test(arg) ? "both" : "all" }); return; }
      // "fix them", "fix urgent": every planned part, as fix alone.
      if (word === "fix" && (EVERY_PART.test(arg) || arg.split(/\s+/).every((w) => isWeightWord(w.toLowerCase())))) { takeWeights(arg.split(/\s+/)); push({ word: "fix-up" }); return; }
      const numbers = partNumbers(arg);
      // A position other than a number ("the last one") or a range too long to be parts would match titles by accident.
      if (!numbers && (POSITION.test(arg) || /^[#\d][#\d\s,&\-\u2013]*$/.test(arg))) { unknown.push(seg); return; }
      const rest = takeWeightsIfNumbers(numbers ?? arg.split(/\s+/), weights);
      if (rest) for (const n of rest) push({ word, part: n });
      else push({ word, part: arg });
      return;
    }
    if (!seg) return;
    const repin = /^auto[-\s]?repin(?:\s+(.+))?$/i.exec(seg);
    if (repin) {
      const args = repin[1]?.trim().replace(/\s+/g, " ") ?? "";
      if (validRepin(args)) push({ word: "autorepin", args });
      else unknown.push(seg);
      return;
    }
    const reason = readClose(seg);
    if (reason) { push({ word: "close", reason }); return; }
    const numbers = partNumbers(seg);
    if (numbers?.every((n) => /^\d+$/.test(n))) {
      // "fix 1 and 2", "drop the first, the third": a bare number continues the fix or drop before it.
      const last = parts[parts.length - 1];
      if (last && (last.word === "fix" || last.word === "drop") && typeof last.part === "number") {
        for (const n of numbers) push({ word: last.word, part: Number(n) });
      } else unknown.push(seg);
      return;
    }
    const tokens = takeWeights(seg.split(/\s+/));
    if (!tokens.length) return;
    const text = norm(tokens.join(" "));
    const legacy = /^merge[- ]?queue (\d{1,2})$/.exec(text);
    if (legacy) {
      const w = Number(legacy[1]);
      if (w < WEIGHT_MIN || w > WEIGHT_MAX) unknown.push(seg);
      else { weights.push({ text: legacy[1]!, w }); push({ word: "merge" }); }
      return;
    }
    const c = commandOf(text) ?? commandOf(typoOf(text) ?? "");
    // `fix` with no part is the fix-up: it fixes every finding nobody dropped, which is what "fix them all" asks for too.
    if (c?.word === "fix") push({ word: "fix-up" });
    else if (c && c.word !== "drop" && c.word !== "autorepin") push({ word: c.word });
    else unknown.push(seg);
  };
  for (const raw of s.split(/\s*[,;\n]\s*|[.!]+\s+|\s+(?:and\s+then|then|and|&)\s+/i)) readSeg(raw);
  const distinct = [...new Set(weights.map((w) => w.w))];
  const conflict = distinct.length > 1;
  if (conflict) unknown.push(...weights.map((w) => w.text));
  else if (distinct.length) push({ word: "weight", weight: distinct[0]! });
  // Words that were not read quote a fix's own words as written.
  const quoted = instruction === null ? unknown : unknown.map((u) => u.replace(INSTRUCTION_RE, () => instruction.replace(CODE_RE, (_m, i: string) => `\`${code[Number(i)] ?? ""}\``)));
  return { parts, unknown: quoted, conflict, yes, tainted };
}

/** The part numbers when the tokens are numbers (with `part`, `finding` or `change` before them, and weight words), else null. */
function takeWeightsIfNumbers(tokens: string[], weights: { text: string; w: number }[]): number[] | null {
  const ns: number[] = [];
  const ws: { text: string; w: number }[] = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (isWeightWord(low)) ws.push({ text: tok, w: WEIGHT_WORDS[low] });
    else if (/^#?\d+$/.test(tok) && Number(tok.replace("#", "")) > 0) ns.push(Number(tok.replace("#", "")));
    else if (!["part", "parts", "finding", "findings", "change", "changes"].includes(low)) return null;
  }
  if (!ns.length) return null;
  weights.push(...ws);
  return ns;
}

/** `<pull request> [via <branch>]` or `off`, as the existing autorepin command takes them. */
function validRepin(args: string): boolean {
  const m = /^(\S+)(?:\s+via\s+(\S+))?$/i.exec(args);
  if (!m) return false;
  if (m[1]!.toLowerCase() === "off") return m[2] === undefined;
  return !!parsePrRef(m[1]!) && (m[2] === undefined || !!parseBranch(m[2]));
}

const URL_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/?#]\S*)?$/i;
const FULL_RE = /^((?:[\w.-]+\/)?[\w.-]+)#(\d+)$/;

/** The item a token names: a GitHub link or `[owner/]repo#n`; null for anything else. */
function refOf(tok: string): ItemRef | null {
  const url = URL_RE.exec(tok);
  const full = FULL_RE.exec(tok);
  const ref = url ? { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) } : full ? { repo: full[1]!, number: Number(full[2]) } : null;
  return ref && Number.isSafeInteger(ref.number) && ref.number > 0 ? ref : null;
}

const addItems = (into: ItemRef[], more: readonly ItemRef[]): ItemRef[] => {
  for (const r of more) if (!into.some((i) => i.repo === r.repo && i.number === r.number)) into.push(r);
  return into;
};

/** Text that ends where a plan part's number follows (`fix `, `drop 1 and `): a number after it is a part, not an item. */
export const PART_BEFORE = /\b(?:drop|fix)(?:\s+(?:parts?|findings?|changes?))?(?:(?:\s*[,;]\s*|\s+and\s+|\s+)#?\d+)*(?:\s*[,;]\s*|\s+and\s+|\s+)$/i;

/** Wraps the index of an item taken out of the text, so the reader can tell which words an item stood in. */
const MARK = "\u0001";
const MARK_RE = /\u0001(\d+)\u0001/g;

/**
 * Items written inline, taken out of the text: `[owner/]repo#n` and GitHub links anywhere, and `#n` when a repo is known (the last
 * one written before it, else `repo`). A `#n` after `drop` or `fix` stays a plan part, and the arguments of autorepin and of a close
 * as a duplicate stay their own. With `mark`, each item leaves a marker in the text instead of nothing.
 */
function pullItems(text: string, repo: string | undefined, mark = false): { text: string; items: ItemRef[]; last: string | null; marks: { tok: string; ref: ItemRef }[] } {
  const items: ItemRef[] = [];
  const marks: { tok: string; ref: ItemRef }[] = [];
  let last = repo ?? null;
  const out = text.replace(/(^|[\s,;(])(https?:\/\/[^\s,;]+|(?:[\w.-]+\/)?[\w.-]*#\d+)(?=$|[\s,;)!?]|\.(?:\s|$))/g, (m, pre: string, raw: string, at: number) => {
    const before = text.slice(0, at + pre.length);
    if (/auto[-\s]?repin\s*$/i.test(before) || /\bduplicate\s+of\s*$/i.test(before)) return m;
    const tok = raw.replace(/[.)!?]+$/, "");
    let ref = refOf(tok);
    if (!ref && /^#\d+$/.test(tok)) {
      if (!last || PART_BEFORE.test(before)) return m;
      ref = { repo: last, number: Number(tok.slice(1)) };
      if (!Number.isSafeInteger(ref.number) || ref.number < 1) return m;
    }
    if (!ref) return m;
    last = ref.repo;
    addItems(items, [ref]);
    if (!mark) return `${pre} `;
    marks.push({ tok, ref });
    return `${pre} ${MARK}${marks.length - 1}${MARK} `;
  });
  return { text: out, items, last, marks };
}

/**
 * The items a pasted text names, each once and in order: `[owner/]repo#n` and GitHub issue and pull request links anywhere, and `#n`
 * after one of them or, with `repo`, on its own, also in `<…>` or backticks. A lone number names nothing.
 */
export function itemsIn(text: string, repo?: string): ItemRef[] {
  // Discord wraps links in <…> to stop previews, and Markdown puts refs in backticks.
  return pullItems(text.replace(/[<>`]/g, " "), repo).items;
}

/** Items in a list: `owner/name#12`, `name#12`, a GitHub URL, or a bare `#12`/`12` taking the repo before it. */
function readItems(text: string, repo: string | undefined): { items: ItemRef[]; bad: string[] } {
  const items: ItemRef[] = [];
  const bad: string[] = [];
  let last = repo ?? null;
  for (const raw of text.split(/[\s,;]+/)) {
    const tok = raw.replace(/[.)]+$/, "");
    if (!tok || /^(?:and|&)$/i.test(tok)) continue;
    const short = /^#?(\d+)$/.exec(tok);
    const ref = refOf(tok) ?? (short && last ? { repo: last, number: Number(short[1]) } : null);
    if (!ref || !Number.isSafeInteger(ref.number) || ref.number < 1) { bad.push(tok); continue; }
    last = ref.repo;
    if (!items.some((i) => i.repo === ref.repo && i.number === ref.number)) items.push(ref);
  }
  return { items, bad };
}
