// The lines every surface shows for a started item: its steps, the state line, the open recommendation, who started, approved,
// answered or holds it, its place in line, and the one-line confirmation and reply to each command. GitHub, Discord, the
// agent and the dashboard all build their text here, so the same words appear everywhere. All text goes through t().
import { t, tk } from "../i18n/index.ts";
import type { Ambiguity, Refusal, Resolved, Run } from "./resolve.ts";
import type { Blocker, Entry, ItemWorkflow, Recommendation } from "./types.ts";
import { clipText } from "../prose.ts";
import { asksNobody } from "./asked.ts";
import { authorAsk, heldWork, openRecommendation, RULE_STARTER } from "./types.ts";
import { ASK, COMMANDS, ENTRY_LABEL, weightWord } from "./vocab.ts";
import type { RunnerRoom } from "../core/runner-room.ts";

export type StepName = "implement" | "review" | "fix-up" | "review again" | "update from main" | "fix CI and conflicts" | "batch" | "merge" | "recommend" | "review new commits";
export type StepState = "done" | "running" | "waiting" | "stopped" | "next";
export type Step = {
  name: StepName;
  /** What the step does or did, in a few words: "1 and 2", "no findings". */
  note?: string;
  state: StepState;
};

/** Formats a stored ISO time; the default is `hh:mm UTC`, the dashboard passes the viewer's local time. */
export type Clock = (iso: string) => string;
export const utcClock: Clock = (iso) => (iso.length >= 16 ? `${iso.slice(11, 16)} UTC` : iso);

const ENTRY_STEPS: Record<Entry, StepName[]> = {
  review: ["review"],
  fixup: ["review", "fix-up", "review again"],
  implement: ["implement", "review", "fix-up", "review again"],
  merge: ["update from main", "fix CI and conflicts", "batch", "merge"],
};

/** The steps an entry runs, ending in a merge when approved and in one recommendation when not; the merge queue implies approval. */
export const stepsFor = (entry: Entry, approved: boolean): StepName[] =>
  entry === "merge" ? ENTRY_STEPS.merge : [...ENTRY_STEPS[entry], approved ? "merge" : "recommend"];

/** The review round of the author's commits on an approved PR (src/workflow/advance.ts): recorded as the step, it runs right before the merge. */
export const ROUND_STEP: StepName = "review new commits";

/** The workflow's steps by name: stepsFor, with the review round before the merge while the advance pass records it. */
export function stepNamesOf(wf: Pick<ItemWorkflow, "entry" | "approvedBy" | "step">): StepName[] {
  const names = stepsFor(wf.entry, wf.approvedBy !== null);
  return wf.step === ROUND_STEP ? [...names.slice(0, -1), ROUND_STEP, names[names.length - 1]!] : names;
}

/** Steps with states: those before `at` done, `at` in state `now`, the rest next. */
export const stepsAt = (names: StepName[], at: number, now: StepState = "running", notes: Record<number, string> = {}): Step[] =>
  names.map((name, i) => ({ name, ...(notes[i] ? { note: notes[i] } : {}), state: i < at ? "done" : i === at ? now : "next" }));

const STEP_LABEL: Record<StepName, string> = {
  implement: tk("implement"),
  review: tk("review"),
  "fix-up": tk("fix-up"),
  "review again": tk("review again"),
  "update from main": tk("update from main"),
  "fix CI and conflicts": tk("fix CI and conflicts"),
  batch: tk("batch"),
  merge: tk("merge"),
  recommend: tk("come back with a recommendation"),
  "review new commits": tk("review the author's new commits"),
};
const STATE_LABEL: Record<StepState, string> = { done: tk("done"), running: tk("running"), waiting: tk("waiting"), stopped: tk("stopped"), next: tk("next") };

export const stepLabel = (s: Step): string => (s.note ? t("{step}: {note}", { step: t(STEP_LABEL[s.name]), note: s.note }) : t(STEP_LABEL[s.name]));

/** Where the item's machinery is, as the mirror shows it: the public step, read for the workflow's steps. */
export type Progress = "implementing" | "reviewing" | "fixing" | "waiting-ci" | "queued" | "batched" | "merged" | "other";

/** The index of the step the advance pass recorded on the row, or -1 when it recorded none (a row before its first pass). */
export const recordedStep = (wf: Pick<ItemWorkflow, "step">, names: readonly StepName[]): number =>
  wf.step === null ? -1 : names.indexOf(wf.step as StepName);

/**
 * The workflow's steps with their states: the step the advance pass recorded runs (or waits, or stopped, by the workflow's state),
 * those before it are done. A row with no recorded step yet reads it from where the machinery is.
 */
export function workflowSteps(wf: Pick<ItemWorkflow, "entry" | "kind" | "state" | "approvedBy" | "plan" | "step">, progress: Progress): Step[] {
  const names = stepNamesOf(wf);
  if (progress === "merged" || wf.state === "done" || wf.state === "closed") return stepsAt(names, names.length);
  const idx = (n: StepName): number => names.indexOf(n);
  const last = names.length - 1;
  let at = recordedStep(wf, names);
  if (at < 0) {
    if (wf.entry === "merge") at = progress === "batched" ? idx("batch") : progress === "fixing" ? idx("fix CI and conflicts") : idx("update from main");
    else if (wf.state === "recommending" && names[last] === "recommend") at = last;
    else if (progress === "implementing" || (wf.kind === "issue" && wf.entry === "implement")) at = idx("implement");
    else if (progress === "fixing") at = idx("fix-up");
    else if (progress === "waiting-ci" || progress === "queued" || progress === "batched") at = last;
    else at = wf.plan.some((p) => p.state === "fixed") && idx("review again") >= 0 ? idx("review again") : idx("review");
  }
  if (at < 0) at = Math.max(0, idx("review"));
  const now: StepState = wf.state === "running" ? "running" : wf.state === "blocked" || wf.state === "stopped" || wf.state === "backlog" ? "stopped" : "waiting";
  return stepsAt(names, at, now);
}

/** One line per step: `2. fix-up: 1 and 2 (running)`. */
export const stepLines = (steps: readonly Step[]): string[] =>
  steps.map((s, i) => t("{n}. {step} ({state})", { n: i + 1, step: stepLabel(s), state: t(STATE_LABEL[s.state]) }));

/** The step that runs, waits or stopped now. */
export const currentStep = (steps: readonly Step[]): Step | undefined => steps.find((s) => s.state === "running" || s.state === "waiting" || s.state === "stopped");

const BLOCKER_LABEL: Record<Blocker, string> = {
  "author-commits": tk("new commits from the author beyond what was approved"),
  "failed-twice": tk("a step failed twice or a fix could not be made"),
  other: tk("a stop the review or merge step reported"),
};
export const blockerLabel = (b: Blocker): string => t(BLOCKER_LABEL[b] ?? BLOCKER_LABEL.other);

/** "1", "1 and 2", "1, 2 and 3". */
export function listText(ns: readonly (number | string)[]): string {
  if (ns.length < 2) return String(ns[0] ?? "");
  return t("{list} and {last}", { list: ns.slice(0, -1).join(", "), last: String(ns[ns.length - 1]) });
}

/** What an earlier review of the commit whose new review failed asks. */
export function earlierReview(parts: readonly number[], verdict?: "hold" | "close"): string {
  const vars = { parts: listText(parts) };
  if (verdict === "hold") return parts.length ? t("An earlier review of this commit says to hold it, and asks to fix {parts}.", vars) : t("An earlier review of this commit says to hold it.");
  if (verdict === "close") return parts.length ? t("An earlier review of this commit says to close it, and asks to fix {parts}.", vars) : t("An earlier review of this commit says to close it.");
  return t("An earlier review of this commit asks to fix {parts}.", vars);
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The state line of a row the automatic merge rule stopped, which asks nobody: why it stopped and what a yes would run. A rule row's
 * recommendation stored before `stop` existed has the reason in its sentence ("The automatic merge rule stops here: …"), shown as it is.
 */
export const ruleStopLine = (rec: Recommendation): string =>
  rec.stop ? t("Stopped: {reason}. AutoCraft would: {recommendation}", { reason: rec.stop, recommendation: rec.text }) : rec.text;

/**
 * Where the item stands, in one line. `wait`: what a running item waits for that nothing can move on, what became of a close, or the
 * follow-ups a merge filed (waits.ts legWait). `veiled`: a quiet pull request's reader, who sees no recommendation, so a rule row's line says only that it stopped.
 */
export function stateLine(wf: ItemWorkflow, current?: Step, clock: Clock = utcClock, wait: string | null = null, veiled = false): string {
  if (wait && (wf.state === "running" || (wf.state === "waiting" && !authorAsk(wf)) || wf.state === "closed" || wf.state === "done")) return wait;
  const ruleRec = asksNobody(wf) ? openRecommendation(wf) : null;
  if (ruleRec) return veiled ? t("Stopped") : ruleStopLine(ruleRec);
  switch (wf.state) {
    case "running": return current ? t("Running: {step}", { step: stepLabel(current) }) : t("Running");
    case "waiting": {
      const ask = authorAsk(wf);
      if (ask) {
        const who = ask.login ?? t("the author");
        if (ask.unsent) return t("Waiting to ask {author}: {reason}", { author: who, reason: ask.unsent });
        if (!ask.posted) return t("Asking {author}: {line}", { author: who, line: ask.line });
        return ask.auto ? t("Waiting for {author}, asked after the review: {line}", { author: who, line: ask.line }) : t("Waiting for {author}: {line}", { author: who, line: ask.line });
      }
      return current ? t("Waiting: {step}", { step: stepLabel(current) }) : t("Waiting");
    }
    case "blocked": return wf.blocker ? t("Stopped at a blocker: {blocker}", { blocker: blockerLabel(wf.blocker) }) : t("Stopped at a blocker");
    case "recommending": return t("Waiting for an answer");
    case "done": return t("Done");
    case "stopped": return wf.stoppedBy ? t("Held by {login}, {time}", { login: wf.stoppedBy, time: clock(wf.stoppedAt ?? "") }) : t("Held");
    case "closed": return t("Closed");
    case "backlog": return t("In the backlog");
    case "superseded": return t("Back with the automatic merge rule");
  }
}

const AFTER_CHECKS = (): string => t("after the pre-merge check and green CI");

/** What a yes runs before a merge, as a clause ("fix 1 and 2", "look again"); null when it runs only the merge, or nothing. */
function yesWhat(rec: Recommendation): string | null {
  const fix = rec.parts.fix;
  if (rec.close && !fix.length) return t("close it");
  if (rec.issue?.action === "implement") return t("implement it");
  if ((rec.backlog || rec.issue?.action === "backlog") && !fix.length) return t("put it in the backlog");
  if (rec.issue?.action === "ask") return t("ask the reporter");
  if (rec.author && !fix.length) return t("ask the author");
  if (rec.answer && !fix.length) return rec.answer.label ? t("go with “{option}”", { option: rec.answer.label }) : t("go on with the implementation");
  if (rec.waits && !rec.again) return t("approve the merge and wait");
  if (rec.goes === "look") return t("look again");
  if (rec.goes === "on" && !fix.length && !rec.again) return t("go on in your name");
  return fix.length ? t("fix {parts}", { parts: listText(fix) }) : rec.newCommits ? t("review the new commits") : rec.again === "review" ? t("review it again") : rec.again === "fixup" ? t("fix what the review found") : null;
}

/**
 * What a bare yes runs for this recommendation, built from its stored fields in the order `accept` (resolve.ts) applies them;
 * null when a yes runs nothing (the recommendation's text says what answers it instead).
 */
export function yesClause(rec: Recommendation): string | null {
  const fix = rec.parts.fix;
  if (rec.close && !fix.length) return t("Reply to go ahead and close it.");
  if ((rec.backlog || rec.issue?.action === "backlog") && !fix.length) return t("Reply to go ahead and put it in the backlog.");
  if (rec.issue?.action === "ask") return t("Reply to go ahead and ask the reporter; the issue is reviewed again after their answer.");
  if (rec.author && !fix.length) return rec.merges ? t("Reply to go ahead and ask the author; their new commits are reviewed, then it merges ({checks}).", { checks: AFTER_CHECKS() }) : t("Reply to go ahead and ask the author; their new commits are reviewed, and it comes back to you after.");
  if (rec.answer && !fix.length) {
    const what = yesWhat(rec)!;
    return rec.merges ? t("Reply to go ahead: {what}, then merge ({checks}).", { what, checks: AFTER_CHECKS() }) : t("Reply to go ahead: {what}; it comes back to you after.", { what });
  }
  if (rec.waits && !rec.again) return t("Reply to go ahead: the merge is approved and waits; new commits come back to you.");
  if (rec.goes === "look") return rec.merges ? t("Reply to go ahead: look again, then merge ({checks}).", { checks: AFTER_CHECKS() }) : t("Reply to go ahead and look again.");
  if (rec.goes === "on" && !fix.length && !rec.again) return rec.merges ? t("Reply to go ahead in your name, then merge ({checks}).", { checks: AFTER_CHECKS() }) : t("Reply to go ahead in your name.");
  const what = yesWhat(rec);
  if (what) return rec.merges ? t("Reply to go ahead: {what}, then merge ({checks}).", { what, checks: AFTER_CHECKS() }) : t("Reply to go ahead: {what}; it comes back to you after.", { what });
  return rec.merges ? t("Reply to go ahead and merge it ({checks}).", { checks: AFTER_CHECKS() }) : null;
}

/** What a yes to the recommendation runs, as the item header's next step ("fix 1, then merge"); null when it runs nothing. */
export function yesNext(rec: Recommendation): string | null {
  const what = yesWhat(rec);
  if (((rec.close || rec.backlog || rec.author) && !rec.parts.fix.length) || (rec.waits && !rec.again) || rec.issue) return what;
  return what ? (rec.merges ? t("{what}, then merge", { what }) : what) : rec.merges ? t("merge") : null;
}

/** A recommendation's sentence and what a yes runs; the sentence alone, with a request for words, when a yes runs nothing. */
export const recommendationText = (rec: Recommendation): string =>
  `${rec.text} ${yesClause(rec) ?? t("Reply with what to do.")}`;

/** The open recommendation and how to answer it, or null when none is open. */
export const recommendationLine = (rec: Recommendation | null): string | null =>
  rec ? t("Recommendation: {text}", { text: recommendationText(rec) }) : null;

/** Who started, approved, answered and holds the item; `answered` is the latest answer, from the item's events. */
export function attributionLines(wf: ItemWorkflow, answered?: { by: string; at: string } | null, clock: Clock = utcClock): string[] {
  const entry = t(ENTRY_LABEL[wf.entry]), time = clock(wf.startedAt);
  const started = wf.startedBy === RULE_STARTER ? t("{entry}, started by the automatic merge rule, {time}", { entry, time }) : t("{entry}, started by {login}, {time}", { entry, login: wf.startedBy, time });
  const out = wf.state === "stopped" && heldWork(wf).unstarted ? [] : [started];
  if (wf.approvedBy) out.push(t("Approved for merge by {login}, {time}", { login: wf.approvedBy, time: clock(wf.approvedAt ?? "") }));
  if (answered) out.push(t("Answered by {login}, {time}", { login: answered.by, time: clock(answered.at) }));
  if (wf.stoppedBy) out.push(t("Held by {login}, {time}", { login: wf.stoppedBy, time: clock(wf.stoppedAt ?? "") }));
  return out;
}

/** The item's place in a queue, counted from 1. */
export const queueLine = (position: number): string => t("#{n} in line", { n: position });

/** The weight as items show it; the normal weight shows nothing. */
export const weightLabel = (w: number | null | undefined): string | null => {
  const word = weightWord(w);
  return word === null ? null : word.startsWith("weight ") ? t("weight {n}", { n: w! }) : t(word);
};

/** "(approved by mira, 09:31 UTC)" */
function byText(how: Run["how"], login: string, time: string): string {
  const p = { login, time };
  switch (how) {
    case "started": return t("(started by {login}, {time})", p);
    case "approved": return t("(approved by {login}, {time})", p);
    case "answered": return t("(answered by {login}, {time})", p);
    case "held": return t("(held by {login}, {time})", p);
    case "resumed": return t("(resumed by {login}, {time})", p);
    case "set": return t("(set by {login}, {time})", p);
    default: return t("(by {login}, {time})", p);
  }
}

/** Characters of a fix's instruction the confirmation quotes. */
const INSTRUCTION_SHOWN = 200;

/** What a fix-up of a started item fixes: the person's words, the review's finding, the named parts. */
function fixingText(r: Run): string {
  const parts = r.fix.length ? listText(r.fix) : null;
  if (!r.instruction) return parts ? t("fixing {parts}", { parts }) : t("fixing what the review found");
  const instruction = clipText(r.instruction.text, INSTRUCTION_SHOWN);
  if (r.instruction.review) return t("fixing what the review found: “{finding}”", { finding: instruction });
  return parts ? t("fixing “{instruction}” and {parts}", { instruction, parts }) : t("fixing “{instruction}”", { instruction });
}

/**
 * The one-line confirmation of an accepted command, the same on every surface:
 * "Fixing 1 and 2, then merging when CI is green (approved by mira, 09:31 UTC). Reply hold to halt."
 * `waits`: who has to resolve the PR's conflict with its base branch before anything is fixed or merged.
 */
export function confirmLine(r: Run, by: string, at: string, clock: Clock = utcClock, waits: Recommendation["waits"] | null = null): string {
  const who = byText(r.how, by, clock(at));
  if (r.end === "hold") return t("On hold {by}. AutoCraft keeps off it. Reply resume to go on.", { by: who });
  if (r.resume === "unstarted") return t("No longer held {by}. Nobody had started it, so AutoCraft treats it as it did before.", { by: who });
  if (r.resume === "question") return t("No longer held {by}. Its question is open again.", { by: who });
  if (r.end === "close") {
    if (!r.close) return t("Closing {by}.", { by: who });
    if (r.close.as === "duplicate") return t("Closing as a duplicate of {ref} {by}.", { ref: `${r.close.of.repo ?? ""}#${r.close.of.number}`, by: who });
    return r.close.as === "completed" ? t("Closing as completed {by}.", { by: who }) : t("Closing as not planned {by}.", { by: who });
  }
  if (r.end === "backlog") return t("In the backlog: open, no work planned {by}. Any command starts it again.", { by: who });
  if (r.asksAuthor !== null) {
    const then = r.merges ? t("their new commits are reviewed, then it merges when CI is green") : t("their new commits are reviewed, then it comes back with a recommendation");
    return r.asksAuthor.words
      ? t("Asking the author: “{words}”, with the review's findings. Nothing runs until they push; {then} {by}. Reply hold to halt.", { words: clipText(r.asksAuthor.words, INSTRUCTION_SHOWN), then, by: who })
      : t("Asking the author to address the review's findings. Nothing runs until they push; {then} {by}. Reply hold to halt.", { then, by: who });
  }
  if (r.asks !== null) return t("Asking the reporter: “{question}” The issue is reviewed again after their answer {by}. Reply hold to halt.", { question: clipText(r.asks, INSTRUCTION_SHOWN), by: who });
  if (r.autorepin !== null) {
    return r.autorepin.toLowerCase() === "off"
      ? t("No Cargo repin after this merges {by}.", { by: who })
      : t("Repinning the Cargo dependencies of {target} when this merges {by}.", { target: r.autorepin, by: who });
  }
  const did: string[] = [];
  if (r.drop.length) did.push(t("dropping {parts}", { parts: listText(r.drop) }));
  const said = r.instruction && !r.instruction.review ? clipText(r.instruction.text, INSTRUCTION_SHOWN) : null;
  if (r.start === "review" && said !== null && !waits) did.push(t("fixing “{instruction}”", { instruction: said }), t("reviewing"));
  else if (r.start === "review") did.push(t("reviewing"));
  else if (r.start === "fixup" && said !== null && !waits) did.push(t("fixing “{instruction}”", { instruction: said }), t("reviewing the fix and fixing what the review finds"));
  else if (r.start === "merge" && said !== null && !waits) did.push(t("fixing “{instruction}”", { instruction: said }));
  else if (r.start === "implement" && said !== null) did.push(t("implementing with your instructions “{instruction}”, reviewing, fixing what the review finds, reviewing again", { instruction: said }));
  else if (r.start === "fixup") did.push(waits ? t("reviewing") : t("reviewing, fixing what the review finds, reviewing again"));
  else if (r.start === "implement" || r.implements) did.push(t("implementing, reviewing, fixing what the review finds, reviewing again"));
  else if (r.again === "review") did.push(t("reviewing again"));
  else if (r.again === "fixup" && !waits) did.push(fixingText(r));
  if (r.resume) did.push(t("going on where it was held"));
  else if (r.goesOn && !r.merges) did.push(t("going on"));
  if (r.pick) did.push(r.pick.label ? t("going on with “{option}”", { option: r.pick.label }) : t("going on with the implementation"));
  const weight = weightLabel(r.weight);
  if (!did.length && !r.start && !r.approve && !r.retryMerge && !r.answers) {
    // A weight alone.
    const shown = r.weight === null ? null : weightWord(r.weight)?.startsWith("weight ") ? String(r.weight) : weight;
    return t("Weight {weight} {by}.", { weight: shown ?? t("normal"), by: who });
  }
  const end = waits
    ? waits === "contributor" ? t("keeping the merge approved until the contributor resolves the conflict with the base branch") : t("keeping the merge approved until someone resolves the conflict with the base branch")
    : r.start === "merge" && said !== null ? t("merging when CI is green")
    : r.start === "merge"
      ? r.replaces ? t("updating from main, then merging without the review when CI is green") : t("updating from main, then merging in the next batch when CI is green")
    : r.merges
      ? did.length || r.answers || r.retryMerge ? t("merging when CI is green") : t("merging when the steps are done and CI is green")
      : r.thenImplement ? t("implementing when the review recommends it, else coming back with a recommendation")
      : t("coming back with a recommendation");
  const what = cap(did.length ? t("{done}, then {end}", { done: did.join(", "), end }) : end);
  return t("{what}{weight} {by}. Reply hold to halt.", { what, weight: weight ? `, ${weight}` : "", by: who });
}

/**
 * The line a confirmation, or a stalled call's notice, adds about the Task Runners (src/core/runner-room.ts RunnerRoom): why none can take
 * the work now, and the setup page for a person with no Task Runner of their own; null when one can and the person has their own.
 * `connect`: the setup page's URL. `whose`: the person's role in the work, for a line others read too; left out, it speaks to the person.
 */
export function runnerLine(room: RunnerRoom, repo: string, connect: string, clock: Clock = utcClock, whose?: "starter" | "approver" | "taker"): string | null {
  const setup = t("Set up your own Task Runner: {url}", { url: connect });
  if (room.can) return room.own ? null : setup;
  const until = room.until ? clock(room.until) : null;
  const runner = whose === "approver" ? t("the approver's Task Runner") : whose === "starter" ? t("the starter's Task Runner") : whose === "taker" ? t("the Task Runner it was taken onto") : t("your Task Runner");
  const reason = ((): string => {
    switch (room.why) {
      case "own-off": return t("{runner} is not connected", { runner });
      case "own-held": return until ? t("{runner} is held by its usage limit until {time}", { runner, time: until }) : t("{runner} is held by its usage limit", { runner });
      case "own-cooling": return t("{runner} is cooling off", { runner });
      case "own-not-ready": return t("{runner} is not ready", { runner });
      case "own-denied": return t("{runner} may not take {repo}", { runner, repo });
      case "own-none": return whose === undefined ? t("the implementation runs only on your own Task Runner, and you have none") : t("the implementation runs only on {runner}, which is not set up", { runner });
      case "held": return until ? t("the Task Runners that may take {repo} are held by their usage limit until {time}", { repo, time: until }) : t("the Task Runners that may take {repo} are held by their usage limit", { repo });
      case "tier": return t("no ready Task Runner that may take {repo} offers a {tier} tier model", { repo, tier: room.tier ?? "" });
      case "repo": return t("the ready Task Runners do not take {repo}", { repo });
      case "none": return t("no Task Runner that may take {repo} is ready", { repo });
    }
  })();
  const line = t("No Task Runner can take this right now ({reason}). It starts when one is free.", { reason });
  return room.own ? line : `${line} ${setup}`;
}

/**
 * Where approved work stands, for a refusal that says it is already approved: the state line and the steps still to come, the merge
 * with its checks. Null when no step is current.
 */
export function approvedNowLine(wf: ItemWorkflow, clock: Clock = utcClock): string | null {
  const steps = workflowSteps(wf, "other");
  const current = currentStep(steps);
  if (!current) return null;
  const next = steps.filter((s) => s.state === "next").map((s) => (s.name === "merge" ? t("{step} {checks}", { step: stepLabel(s), checks: AFTER_CHECKS() }) : stepLabel(s)));
  const now = stateLine(wf, current, clock);
  return next.length ? t("{state}. Next: {steps}.", { state: now, steps: listText(next) }) : t("{state}.", { state: now });
}

/** The reply when nothing ran: what was understood, and why it waits. `proposed`: a command a model read in text the parser could not read. */
export function replyLine(r: Exclude<Resolved, { kind: "run" }>, clock: Clock = utcClock, mention?: string, proposed?: string): string {
  return r.kind === "ambiguous" ? ambiguityText(r.understood, r.ambiguity, mention, proposed) : refusalText(r.refusal, clock);
}

/** The sentence that proposes a command to send. */
const proposalLine = (command: string, mention?: string): string =>
  t("I read this as `{command}`. Reply `{reply}` to run it.", { command, reply: mention ? `@${mention} ${command}` : command });

/** Words that reverse or postpone a command: a reply holding one is never read back as that command. */
export const MEANING_WORDS = /(?<![\w-])(?:don't|dont|do not|not|no|never|wait|hold|stop|pause|later|unless|but|if|instead|n't)(?![\w-])|n't(?![\w-])/i;

/** The one start-or-approve command a leftover text names, or null when it names none, several, or is hedged. */
function singleCommand(rest: string): string | null {
  if (MEANING_WORDS.test(rest) || /(?<![\w-])duplicate(?![\w-])/i.test(rest)) return null;
  const found = COMMANDS.filter((c) => !c.answer && c.word !== "autorepin" && c.word !== "hold" && c.word !== "resume" && [c.word, ...c.aliases].some((w) => new RegExp(`(?<![\\w-])${w.replace(/[- ]/g, "[-\\s]?")}(?![\\w-])`, "i").test(rest)));
  return found.length === 1 ? found[0]!.word : null;
}

/** How to write a part-naming word that came without its part (`drop and merge`), or null when the leftover is something else. */
function partHint(rest: string): string | null {
  const word = rest.trim().toLowerCase();
  return COMMANDS.some((x) => x.answer && [x.word, ...x.aliases].includes(word)) ? t("“{word}” names a part of the plan, as in “{example}”.", { word, example: `${word} 1` }) : null;
}

function ambiguityText(understood: string, a: Ambiguity, mention?: string, proposed?: string): string {
  switch (a.why) {
    case "unreadable":
      if (proposed) {
        const unread = understood && a.rest ? t("I understood “{understood}” but not “{rest}”.", { understood, rest: a.rest }) : a.rest ? t("I couldn't read “{rest}” as a command.", { rest: a.rest }) : null;
        return [unread, proposalLine(proposed, mention)].filter((x) => x !== null).join(" ");
      }
      if (understood && a.rest) {
        const hint = partHint(a.rest);
        return hint
          ? t("I understood “{understood}” but not “{rest}”. {hint} Nothing runs until the instruction is clear.", { understood, rest: a.rest, hint })
          : t("I understood “{understood}” but not “{rest}”. Nothing runs until the instruction is clear.", { understood, rest: a.rest });
      }
      if (a.rest) {
        const one = singleCommand(a.rest);
        if (one) return proposalLine(one, mention);
        const hint = partHint(a.rest);
        if (hint) return t("{hint} Nothing runs until the instruction is clear.", { hint });
        return t("I couldn't read “{rest}” as a command. Nothing runs until the instruction is clear. Commands: {commands}.", { rest: a.rest, commands: [...COMMANDS.filter((c) => !c.answer || c.word === "drop"), ASK].map((c) => c.usage).join(", ") });
      }
      if (understood) return t("I understood “{understood}” but not which items. Nothing runs until the instruction is clear.", { understood });
      return t("There was no command. Nothing runs.");
    case "nothing-to-answer": return t("There is no open recommendation to say yes to. Nothing runs.");
    case "no-plan": return t("“{understood}” names parts of a plan, but this item has no plan yet. Nothing runs.", { understood });
    case "no-such-part": return t("There is no part {n}. Nothing runs until you name one, by number or words.", { n: a.part });
    case "part-matches-none": return t("“{words}” matches no part. Nothing runs until you name one, by number or words.", { words: a.words });
    case "part-matches-several": return t("“{words}” matches parts {parts}. Nothing runs until you name one, by number or words.", { words: a.words, parts: listText(a.parts) });
    case "weight-unstarted": return t("Nothing runs on this item yet. Give the weight with a command, such as “review, {weight}”.", { weight: weightLabel(a.weight) ?? "urgent" });
    case "conflict": return t("“{words}” can't run together. Nothing runs.", { words: a.words.join(", ") });
    case "pick-one": return a.parts.length
      ? t("Name one of {parts} to go with. Nothing runs until you do.", { parts: listText(a.parts) })
      : t("Every option is dropped. Nothing runs: name one to go with, or answer in a comment on the issue.");
    case "needs-words": return t("A yes can't answer this. {text} Nothing runs until then.", { text: a.text });
    case "nothing-to-fix": return t("The review names nothing to fix. Nothing runs until you say what to fix, as in “fix the export normals, then merge”.");
  }
}

function refusalText(r: Refusal, clock: Clock): string {
  switch (r.why) {
    case "implement-not-issue": return t("implement is for issues.");
    case "not-issue-step": return t("{word} is for pull requests. Use review or implement for an issue.", { word: r.word });
    case "issue-merge-queue": return t("An issue can't go in the merge queue. Use implement and merge.");
    case "issue-review-merge": return t("An issue's review merges nothing. Approve the merge with implement: implement and merge.");
    case "autorepin-not-pr": return t("autorepin is for pull requests.");
    case "ask-author-not-pr": return t("ask author is for pull requests.");
    case "no-live-work": return r.word === "take" ? t("Nothing to take: no work runs on this item.") : t("Nothing to release: no work runs on this item.");
    case "already-held": return t("Already held by {login}, {time}. Reply resume to go on.", { login: r.by, time: clock(r.at) });
    case "not-held": return t("This item is not held.");
    case "already-started": return t("Already started: {entry}, by {login}, {time}.", { entry: t(ENTRY_LABEL[r.entry]), login: r.by, time: clock(r.at) });
    case "implement-running": return t("Implement already runs, started by {login}, {time}. Send review alone to review its pull request again.", { login: r.by, time: clock(r.at) });
    case "implement-part": return t("Part {parts} belongs to the plan the implementation is built from. Fix or drop parts of its review, or hold it.", { parts: listText(r.parts) });
    case "already-approved": return t("Already approved for merge by {login}, {time}.", { login: r.by, time: clock(r.at) });
    case "too-long": return t("The instructions are {chars} characters; the most AutoCraft takes is {max}. Nothing runs. Send them shorter.", { chars: r.chars.toLocaleString("en-US"), max: r.max.toLocaleString("en-US") });
    case "merge-approved": return t("The merge was approved by {login}, {time}, so the work would still end in a merge. Nothing runs. Reply hold first to keep it from merging.", { login: r.by, time: clock(r.at) });
  }
}
