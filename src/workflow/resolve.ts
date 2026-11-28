// What parsed text does to one item, given its workflow: a run, an ambiguity (nothing runs; AutoCraft replies with what it
// understood) or a refusal (clear, but not possible on this item). Pure: the command core carries out a run.
//
// The rules the spec fixes: a yes needs an open recommendation; `merge` puts a pull request nobody started into the merge queue
// and approves the merge of a started item; a yes to a recommendation that ends in a merge records the approval; parts named by
// words must match exactly one planned part; a weight alone needs a started item. While an implementation's question is open, its
// options are the parts, and a reply that is only an option's number or words answers it. A fix whose words match no part is an
// instruction the fix-up carries out, with the planned parts; a bare fix where the review lists no fix fixes its finding.
// Instructions in a person's own words approve the work they describe: it ends in a merge unless the text says not to merge
// (`no-merge`). On a pull request nobody started they are made first, then it goes on as the merge queue does, with no review;
// with review or fix-up the entry's review follows them; on an issue the implementation gets them.
import { CONDITION, describe, GUARD } from "./parse.ts";
import { COMMAND_TEXT_MAX, heldWork, sameQuestion, type CloseReason, type CommandPart, type Entry, type ItemKind, type ItemWorkflow, type Parsed, type PlanPart, type QuestionAnswer, type WorkflowState } from "./types.ts";

/**
 * `held`: the item is held, and what it goes on with when it is resumed; no live workflow works on it. `closing`: a close of the item is
 * queued or waits for its person, which a hold takes back. `mergeWaits`: the merge the sender approved
 * waits for their own sign-in or access.
 */
export type ItemState = { kind: ItemKind; workflow: ItemWorkflow | null; held?: ItemWorkflow | null; closing?: boolean; mergeWaits?: boolean; /** The question is about a review that failed for good, and it has not gone with a later commit. */ reviewFailed?: boolean };

/** How the confirmation line attributes the run: "approved by", "started by", ...; null: "by". */
export type How = "started" | "approved" | "answered" | "held" | "resumed" | "set" | null;

export type Run = {
  how: How;
  /** Unstarted: the entry the item starts at. */
  start: Entry | null;
  /** Started: the step that runs again. */
  again: "review" | "fixup" | null;
  /** Plan parts to fix and to drop. */
  fix: number[];
  drop: number[];
  /** Records merge approval now. */
  approve: boolean;
  /** The start takes the place of the running work, whose review failed for good at the head: it merges without that review. */
  replaces: boolean;
  /** Approves again a merge that waits for the sender's sign-in or access: it is tried again. */
  retryMerge: boolean;
  /** Gives the pre-merge review that failed for good at the question's head one more try. */
  retryPremerge: boolean;
  /** The steps end in a merge (approved now or before); false: they end in a recommendation. */
  merges: boolean;
  weight: number | null;
  end: "backlog" | "close" | "hold" | null;
  /** Goes on with the held item: its steps, its open question, or as an item nobody started. */
  resume: "steps" | "question" | "unstarted" | null;
  /** Why it closes, when the command says. */
  close?: CloseReason;
  /** The autorepin arguments, as written. */
  autorepin: string | null;
  /** Takes the live workflow's work onto the sender's own Task Runner, or releases it (src/data/workflow/item-runners.ts). */
  runner: "take" | "release" | null;
  /** It answers the open recommendation, which closes. */
  answers: boolean;
  /** Answers a question whose yes only lets the work go on: the steps end as before. */
  goesOn: boolean;
  /** The implementation's question this answers, with the option picked, as the person. */
  pick: QuestionAnswer | null;
  /** What the fix-up is to do beyond the parts: the person's words after fix, or the finding of a review that lists no fix (`review`). */
  instruction: { text: string; review?: true } | null;
  /** An issue's review (a start or a review again) that goes on to implement when it recommends that, without a question. */
  thenImplement: boolean;
  /** The issue's live review goes on to implement: the workflow's entry becomes implement. */
  implements: boolean;
  /** The question its review has for the issue's reporter: it is posted, and the issue is reviewed again after their answer. */
  asks: string | null;
  /** A PR's author is asked to finish or fix it, with the review's findings and the person's own `words`; the workflow waits for their push. */
  asksAuthor: { words: string | null } | null;
};

export type Ambiguity =
  | { why: "unreadable"; rest: string }
  | { why: "nothing-to-answer" }
  | { why: "no-plan" }
  | { why: "no-such-part"; part: number }
  | { why: "part-matches-none"; words: string }
  | { why: "part-matches-several"; words: string; parts: number[] }
  | { why: "weight-unstarted"; weight: number }
  | { why: "conflict"; words: string[] }
  /** An implement question's options: the answer leaves several to go with, or names more than one. */
  | { why: "pick-one"; parts: number[] }
  /** A yes to a recommendation that runs nothing by itself: `text` says what answers it. */
  | { why: "needs-words"; text: string }
  /** A bare fix where nothing is named to fix: no planned part, and the review wrote no finding. */
  | { why: "nothing-to-fix" };

export type Refusal =
  | { why: "implement-not-issue" }
  | { why: "not-issue-step"; word: "review" | "fix-up" }
  | { why: "issue-merge-queue" }
  /** `merge` on an issue's review: the merge is approved with the implementation. */
  | { why: "issue-review-merge" }
  | { why: "autorepin-not-pr" }
  | { why: "ask-author-not-pr" }
  /** take or release on an item with no live work. */
  | { why: "no-live-work"; word: "take" | "release" }
  | { why: "already-held"; by: string; at: string }
  | { why: "not-held" }
  | { why: "already-started"; entry: Entry; by: string; at: string }
  /** `review and implement` on an issue whose implementation runs already: review alone reviews its pull request. */
  | { why: "implement-running"; by: string; at: string }
  | { why: "already-approved"; by: string; at: string }
  /** A ready plan's part: the implementation is built from the whole plan, so a part can't be fixed or dropped on its own. */
  | { why: "implement-part"; parts: number[] }
  /** The instructions are longer than any surface takes (COMMAND_TEXT_MAX). */
  | { why: "too-long"; chars: number; max: number }
  /** "don't merge" on an item whose merge someone approved already. */
  | { why: "merge-approved"; by: string; at: string };

export type Resolved =
  | { kind: "run"; run: Run }
  | { kind: "ambiguous"; understood: string; ambiguity: Ambiguity }
  | { kind: "refused"; understood: string; refusal: Refusal };

const LIVE: ReadonlySet<WorkflowState> = new Set(["running", "waiting", "blocked", "recommending"]);

/** A workflow that still runs or waits; a held, finished, closed or backlogged one counts as not started. */
export const isLive = (wf: ItemWorkflow | null): wf is ItemWorkflow => !!wf && LIVE.has(wf.state);

const run = (r: Partial<Run>): Resolved => ({
  kind: "run",
  run: { how: null, start: null, again: null, fix: [], drop: [], approve: false, replaces: false, retryMerge: false, retryPremerge: false, merges: false, weight: null, end: null, resume: null, autorepin: null, runner: null, answers: false, goesOn: false, pick: null, instruction: null, thenImplement: false, implements: false, asks: null, asksAuthor: null, ...r },
});

const ENTRY_OF = { review: "review", "fix-up": "fixup", implement: "implement" } as const;
type EntryWord = keyof typeof ENTRY_OF;
const isEntryWord = (w: string): w is EntryWord => Object.hasOwn(ENTRY_OF, w);

/** Words that say nothing about which part is meant. */
const FILLER = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "and", "part", "finding", "change", "one"]);

const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The planned parts whose title holds every word of `words` as a whole word (case-insensitive; filler words ignored). */
export function partsMatching(plan: readonly PlanPart[], words: string): PlanPart[] {
  const ws = wordsOf(words).filter((w) => !FILLER.has(w));
  if (!ws.length) return [];
  return plan.filter((p) => { const title = new Set(wordsOf(p.title)); return p.state === "planned" && ws.every((w) => title.has(w)); });
}

export function resolve(parsed: Parsed, state: ItemState): Resolved {
  const wf = state.workflow;
  const live = isLive(wf);
  if (parsed.kind === "ambiguous") {
    if (live && !parsed.understood) {
      const option = optionNamed(wf, parsed.rest);
      if (option) return pick(wf, option, {});
    }
    return { kind: "ambiguous", understood: parsed.understood, ambiguity: { why: "unreadable", rest: parsed.rest } };
  }
  if (parsed.kind === "yes") {
    const understood = "yes";
    if (!live && state.held) return goOn(state.held, parsed.weight ?? null);
    if (!live || !wf.rec) return { kind: "ambiguous", understood, ambiguity: { why: "nothing-to-answer" } };
    // A recommendation a yes cannot run (a question only an option's name or a comment answers) needs other words.
    if (runsNothing(wf.rec)) return { kind: "ambiguous", understood, ambiguity: { why: "needs-words", text: wf.rec.text } };
    return accept(wf, wf.rec.parts.fix, wf.rec.parts.drop, parsed.weight ?? null);
  }

  const parts = parsed.parts;
  const understood = describe(parts);
  const ambiguous = (ambiguity: Ambiguity): Resolved => ({ kind: "ambiguous", understood, ambiguity });
  const refused = (refusal: Refusal): Resolved => ({ kind: "refused", understood, refusal });
  const has = (w: CommandPart["word"]) => parts.some((p) => p.word === w);
  const weight = parts.find((p) => p.word === "weight")?.weight ?? null;
  const entries = [...new Set(parts.map((p) => p.word).filter(isEntryWord))];
  const merge = has("merge");
  const end = (["backlog", "close", "hold"] as const).filter((w) => has(w));
  const repin = parts.find((p): p is Extract<CommandPart, { args?: string }> => p.word === "autorepin");
  const runner = (["take", "release"] as const).find((w) => has(w)) ?? null;
  const named = parts.filter((p): p is Extract<CommandPart, { part: unknown }> => "part" in p);
  const noMerge = has("no-merge");
  const long = named.find((p) => "text" in p && p.text && p.text.length > COMMAND_TEXT_MAX);
  if (long && "text" in long) return refused({ why: "too-long", chars: long.text!.length, max: COMMAND_TEXT_MAX });
  if (noMerge && merge) return ambiguous({ why: "conflict", words: ["merge", "don't merge"] });

  // An issue's review that goes on to implement when it recommends that, as a pull request's review goes on to merge.
  const chain = state.kind === "issue" && entries.length === 2 && entries.includes("review") && entries.includes("implement");
  // Words that end the work or stand apart run alone; two entry points can't both start.
  if (((end.length || repin || runner) && parts.length > 1) || (has("resume") && parts.some((p) => p.word !== "resume" && p.word !== "weight")) || (entries.length > 1 && !chain)) return ambiguous({ why: "conflict", words: parts.map((p) => p.word) });

  // The author is asked on its own; the merge may be approved with it, so their push goes on to the merge after its review.
  const askAuthor = parts.find((p): p is Extract<CommandPart, { word: "ask-author" }> => p.word === "ask-author");
  if (askAuthor) {
    if (parts.some((p) => p.word !== "ask-author" && p.word !== "merge" && p.word !== "weight")) return ambiguous({ why: "conflict", words: parts.map((p) => p.word) });
    if (state.kind !== "pr") return refused({ why: "ask-author-not-pr" });
    const approve = merge && !(live && wf.approvedBy);
    return run({ asksAuthor: { words: askAuthor.args ?? null }, approve, merges: merge || (live && !!wf.approvedBy), weight, answers: live && !!wf.rec, how: approve ? "approved" : live && wf.rec ? "answered" : live ? "set" : "started" });
  }
  if (end.length) {
    const e = end[0]!;
    if (e === "hold" && !live && state.held && !state.closing) return refused({ why: "already-held", by: state.held.stoppedBy ?? "", at: state.held.stoppedAt ?? "" });
    const close = e === "close" ? parts.find((p): p is Extract<CommandPart, { word: "close" }> => p.word === "close")?.reason : undefined;
    return run({ end: e, ...(close && { close }), how: e === "hold" ? "held" : live && wf.rec ? "answered" : null, answers: live && !!wf.rec });
  }
  if (has("resume")) return !live && state.held ? goOn(state.held, weight) : refused({ why: "not-held" });
  if (repin) {
    if (state.kind !== "pr") return refused({ why: "autorepin-not-pr" });
    return run({ autorepin: repin.args ?? "", how: "set" });
  }
  if (runner) return live ? run({ runner, how: "set" }) : refused({ why: "no-live-work", word: runner });

  const entry = chain ? "review" : entries[0] ?? null;
  if (entry === "implement" && state.kind !== "issue") return refused({ why: "implement-not-issue" });
  if (entry === "fix-up" && state.kind === "issue") return refused({ why: "not-issue-step", word: entry });
  if (entry === "review" && state.kind === "issue" && merge) return refused({ why: "issue-review-merge" });

  if (!live) {
    // The yes would go on with what was held, the start would drop it.
    if (state.held && parsed.yes && (entry || merge)) return ambiguous({ why: "conflict", words: ["yes", ...parts.map((p) => p.word)] });
    // Words after fix on an item nobody started name no part: they are the work, and approve it unless the text says not to merge.
    const said = named.length === 1 && named[0]!.word === "fix" && typeof named[0]!.part === "string" && "text" in named[0]! && named[0].text && !chain ? named[0].text : null;
    if (said !== null) {
      const instruction = { text: said }, approve = !noMerge, how = approve ? "approved" as const : "started" as const;
      // On an issue only implement or fix starts the implementation with them; merge alone stays no start of an issue.
      if (state.kind === "issue" && (entry === "implement" || (entry === null && !merge))) return run({ start: "implement", instruction, approve, merges: approve, weight, how });
      if (state.kind === "pr" && (entry === "review" || entry === "fix-up")) return run({ start: ENTRY_OF[entry], instruction, approve, merges: approve, weight, how });
      // Their fix, then the merge queue's steps; without the merge, the fix-up start: the fix, its review, a recommendation.
      if (state.kind === "pr" && entry === null) return run({ start: approve ? "merge" : "fixup", instruction, approve, merges: approve, weight, how });
    }
    if (said !== null && state.kind === "issue" && entry === null && merge) return refused({ why: "issue-merge-queue" });
    if (named.length) return ambiguous({ why: "no-plan" });
    if (entry) return run({ start: ENTRY_OF[entry], approve: merge, merges: merge, weight, thenImplement: chain, how: merge ? "approved" : "started" });
    if (merge) {
      if (state.kind === "issue") return refused({ why: "issue-merge-queue" });
      return run({ start: "merge", approve: true, merges: true, weight, how: "approved" });
    }
    return ambiguous({ why: "weight-unstarted", weight: weight! });
  }

  // An issue's review: implement goes on to implement it, review reviews it again; it has no plan and nothing of it merges.
  if (wf.kind === "issue" && wf.entry === "review") {
    const answers = !!wf.rec;
    if (entry === "implement") return run({ implements: true, approve: merge, merges: merge, weight, answers, how: merge ? "approved" : answers ? "answered" : "started" });
    if (merge) return refused({ why: "issue-review-merge" });
    if (named.length) return ambiguous({ why: "no-plan" });
    if (entry === "review") return run({ again: "review", thenImplement: chain, weight, answers, how: answers ? "answered" : null });
  }
  if (entry === "implement") return refused({ why: "already-started", entry: wf.entry, by: wf.startedBy, at: wf.startedAt });
  if (chain) return refused({ why: "implement-running", by: wf.startedBy, at: wf.startedAt });

  // Parts named by number or by words, each matching exactly one part of the plan.
  const fix: number[] = [];
  const drop: number[] = [];
  let instruction: Run["instruction"] = null;
  for (const p of named) {
    let ns: number[];
    if (typeof p.part === "number") {
      if (!wf.plan.some((q) => q.n === p.part)) return ambiguous({ why: "no-such-part", part: p.part });
      ns = [p.part];
    } else if (p.part === "all" || p.part === "both") {
      // Every planned part (of the open question's options, where it has them); "both" only when there are two.
      const pool = wf.plan.filter((q) => q.state === "planned" && (q.option === undefined || sameQuestion(q.question, wf.rec?.question))).map((q) => q.n);
      if (!pool.length || (p.part === "both" && pool.length < 2)) return ambiguous({ why: "part-matches-none", words: p.part });
      if (p.part === "both" && pool.length > 2) return ambiguous({ why: "part-matches-several", words: p.part, parts: pool });
      ns = pool;
    } else {
      const hits = partsMatching(wf.plan, p.part);
      // A fix's words that name no part are what the fix-up is to do.
      if (hits.length === 0 && p.word === "fix" && "text" in p && p.text) { instruction = { text: p.text }; continue; }
      if (hits.length === 0) return ambiguous({ why: "part-matches-none", words: p.part });
      if (hits.length > 1) return ambiguous({ why: "part-matches-several", words: p.part, parts: hits.map((h) => h.n) });
      ns = [hits[0]!.n];
    }
    const into = p.word === "fix" ? fix : drop;
    for (const n of ns) if (!into.includes(n)) into.push(n);
  }
  // A ready plan's parts are what the implementation builds; after it, the review's parts can be fixed or dropped.
  // An option of a question that is no longer the open one is no part any more.
  const stale = [...fix, ...drop].find((n) => wf.plan.some((q) => q.n === n && q.option !== undefined && !sameQuestion(q.question, wf.rec?.question)));
  if (stale !== undefined) return ambiguous({ why: "no-such-part", part: stale });
  const built = [...fix, ...drop].filter((n) => wf.plan.some((q) => q.n === n && q.source === "implement" && q.option === undefined));
  if (built.length) return refused({ why: "implement-part", parts: built });
  if (fix.some((n) => drop.includes(n))) return ambiguous({ why: "conflict", words: named.map((p) => `${p.word} ${p.part}`) });

  const rec = wf.rec;
  const approved = !!wf.approvedBy;
  // "Don't merge" with parts or an option named takes back no approval: the approved merge goes on unless the item is held first.
  if (noMerge && approved) return refused({ why: "merge-approved", by: wf.approvedBy!, at: wf.approvedAt ?? "" });
  // An implement question: its options are the parts. Naming one picks it; dropping options picks the recommended one when it is
  // left, else the one option left.
  const options = optionsOf(wf);
  if (rec?.question && options.length && (fix.length || drop.length) && !entry && !instruction) {
    const left = options.filter((p) => p.state === "planned" && !drop.includes(p.n));
    if (fix.length > 1) return ambiguous({ why: "pick-one", parts: fix });
    const chosen = fix.length ? options.find((p) => p.n === fix[0]) : left.find((p) => p.option === rec.answer?.option) ?? (left.length === 1 ? left[0] : undefined);
    if (!chosen?.option) return ambiguous({ why: "pick-one", parts: left.map((p) => p.n) });
    return pick(wf, chosen, { drop, merge, noMerge, weight });
  }
  // Only drops, while a recommendation is open: the recommendation without those parts, as a yes would run it.
  if (rec && drop.length && !fix.length && !entry && !instruction) {
    // A close or backlog drops nothing: dropping parts of it could mean "go ahead anyway" or "don't".
    if (rec.close || rec.backlog || rec.author) return ambiguous({ why: "conflict", words: [rec.close ? "close" : rec.backlog ? "backlog" : "ask-author", ...named.map((p) => `drop ${p.part}`)] });
    if (merge && state.reviewFailed) return withoutReview(wf, drop, weight);
    const left = rec.parts.fix.filter((n) => !drop.includes(n));
    return accept(wf, left, [...new Set([...rec.parts.drop, ...drop])], weight, merge);
  }
  // The word merge on an open recommendation is the merge button: what the recommendation runs, then the merge.
  if (!entry && !named.length && merge) {
    if (rec) return state.reviewFailed ? withoutReview(wf, [], weight) : accept(wf, rec.parts.fix, rec.parts.drop, weight, true);
    if (approved && state.mergeWaits) return run({ retryMerge: true, merges: true, weight, how: "approved" });
    if (approved) return refused({ why: "already-approved", by: wf.approvedBy!, at: wf.approvedAt ?? "" });
    return run({ approve: true, merges: true, weight, how: "approved" });
  }
  if (!entry && !named.length) return run({ weight, how: "set" });

  if (instruction && entry === "review") return ambiguous({ why: "conflict", words: parts.map((p) => p.word) });
  const planned = wf.plan.filter((p) => p.state === "planned" && !drop.includes(p.n)).map((p) => p.n);
  const again = entry === "review" ? "review" : entry === "fix-up" || fix.length || instruction ? "fixup" : null;
  const fixes = again === "fixup" ? (fix.length ? fix : planned) : [];
  // A bare fix of an open question that names nothing to fix: the review's finding is what to fix; without one, the person says what.
  if (again === "fixup" && !fixes.length && !instruction && rec && rec.again !== "fixup") {
    if (!rec.finding) return ambiguous({ why: "nothing-to-fix" });
    instruction = { text: rec.finding, review: true };
  }
  // A person's own instructions approve the work they describe, unless they say not to merge.
  const merges = merge || approved || (!!instruction && !instruction.review && !noMerge);
  const approve = merges && !approved;
  return run({
    again, fix: fixes, drop, approve, merges, weight, answers: !!rec, instruction,
    how: approve ? "approved" : rec ? "answered" : null,
  });
}

/** The options of the open implementation question, as the plan's parts; none when the recommendation stands for no question. */
const optionsOf = (wf: ItemWorkflow): PlanPart[] =>
  (wf.rec?.question ? wf.plan.filter((p) => p.option !== undefined && sameQuestion(p.question, wf.rec!.question)) : []);

/** Words that reverse or postpone an answer: a reply holding one names no option. */
const HEDGE = new Set(["no", "not", "never", "don", "dont", "wait", "hold", "stop", "pause", "later", "unless", "but", "if", "instead", "or"]);

/**
 * The option of the open question a reply names on its own ("2", "option 2", "go with per document"): by its number, or by words that
 * are all words of exactly one option's title. Null when there is no open question, or the reply says anything else: a question, a
 * negation or hedge (the parser's GUARD) or a condition word names nothing.
 */
export function optionNamed(wf: ItemWorkflow, reply: string): PlanPart | null {
  if (GUARD.test(reply) || reply.toLowerCase().split(/[^\p{L}']+/u).some((w) => CONDITION.test(w))) return null;
  const options = optionsOf(wf);
  const text = reply.toLowerCase().replace(/[.!]+$/, "").replace(/^(?:(?:go with|take|use|option|part|number|answer)\s+)+/, "").trim();
  const number = /^#?(\d+)$/.exec(text);
  if (number) return options.find((p) => p.n === Number(number[1])) ?? null;
  const wordsOf = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const said = wordsOf(text);
  if (said.some((x) => HEDGE.has(x))) return null;
  const words = said.filter((x) => !FILLER.has(x));
  if (!words.length) return null;
  const hits = options.filter((p) => p.state === "planned" && words.every((x) => wordsOf(p.title).includes(x)));
  return hits.length === 1 ? hits[0]! : null;
}

/** Answers the open question with `chosen`; `merge` also approves the merge when nobody has. */
function pick(wf: ItemWorkflow, chosen: PlanPart, o: { drop?: number[]; merge?: boolean; noMerge?: boolean; weight?: number | null }): Resolved {
  const approve = !!o.merge && !o.noMerge && !wf.approvedBy;
  return run({
    pick: { question: wf.rec!.question!, option: chosen.option!, label: chosen.title }, drop: o.drop ?? [], approve, merges: !o.noMerge && (!!o.merge || !!wf.approvedBy), weight: o.weight ?? null,
    answers: true, how: approve ? "approved" : "answered",
  });
}

/** Goes on with the held item. */
const goOn = (held: ItemWorkflow, weight: number | null): Resolved => {
  const { unstarted, rec } = heldWork(held);
  return run({ resume: unstarted ? "unstarted" : rec ? "question" : "steps", how: "resumed", merges: held.approvedBy !== null, weight });
};

/** A recommendation that fixes, runs, answers, closes and merges nothing: a yes to it would do nothing. */
const runsNothing = (r: NonNullable<ItemWorkflow["rec"]>): boolean => !r.parts.fix.length && !r.again && !r.answer && !r.close && !r.backlog && !r.author && !r.merges && !r.goes && !r.issue;

/**
 * The word merge where the review failed for good at the head: the PR starts at the merge queue without that review, unless an earlier
 * review of that head asks for what no one dropped. Then its fixes are made first, or, for a hold or close with none, the review is tried
 * again, as the recommendation says; either way the merge follows.
 */
function withoutReview(wf: ItemWorkflow, drop: number[], weight: number | null): Resolved {
  const { parts, verdict } = wf.rec!.skipsReview!;
  const left = parts.filter((n) => !drop.includes(n) && wf.plan.some((p) => p.n === n && p.state === "planned"));
  const drops = [...new Set([...wf.rec!.parts.drop, ...drop])];
  if (left.length) return accept(wf, left, drops, weight, true);
  if (verdict) return accept(wf, [], drops, weight, true);
  return run({ start: "merge", replaces: true, drop, approve: true, merges: true, weight, answers: true, how: "approved" });
}

/**
 * Runs the recommendation's plan with these parts; approves the merge when it ends in one (or `merge` was said) and nobody has. The word
 * merge runs what the recommendation runs, then merges, and never closes or backlogs the item; only where the recommendation gives a
 * pre-merge review that failed for good one more try, or a fix whose tries are used up another, does merge go on without it, as its text says.
 */
function accept(wf: ItemWorkflow, fix: number[], drop: number[], weight: number | null, merge = false): Resolved {
  const rec = wf.rec!;
  if (rec.close && !fix.length && !merge) return run({ end: "close", ...(rec.closeAs && { close: rec.closeAs }), how: "answered", answers: true, weight });
  if (rec.backlog && !fix.length && !merge) return run({ end: "backlog", how: "answered", answers: true, weight });
  if (rec.author && !fix.length) {
    const approve = merge && !wf.approvedBy;
    return run({ asksAuthor: { words: null }, approve, merges: merge || !!wf.approvedBy, how: approve ? "approved" : "answered", answers: true, weight });
  }
  if (rec.issue && !fix.length && !merge) {
    switch (rec.issue.action) {
      case "implement": return run({ implements: true, how: "answered", answers: true, weight });
      case "backlog": return run({ end: "backlog", how: "answered", answers: true, weight });
      case "ask": return run({ asks: rec.issue.question ?? "", how: "answered", answers: true, weight });
    }
  }
  const merges = rec.merges || merge;
  const approve = merges && !wf.approvedBy;
  if (rec.answer && !fix.length) return run({ pick: rec.answer, drop, approve, merges, weight, answers: true, how: approve ? "approved" : "answered" });
  // The word merge on a fix whose tries are used up merges it as it is: the pre-merge parts it would fix are overruled.
  if (rec.triedFix && merge) {
    const overruled = fix.filter((n) => wf.plan.find((p) => p.n === n)?.premerge);
    return run({ drop: [...new Set([...drop, ...overruled])], approve, merges, weight, answers: true, how: approve ? "approved" : "answered" });
  }
  const again = fix.length ? "fixup" : rec.again ?? null;
  return run({
    again, fix, drop, approve, merges, weight, answers: true, goesOn: !!rec.goes,
    retryPremerge: !!rec.retriesPremerge && !merge && !fix.length, how: approve ? "approved" : "answered",
    instruction: again === "fixup" ? rec.triedFix?.instruction ?? null : null,
  });
}
