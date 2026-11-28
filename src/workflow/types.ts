// Shared shapes of the maintainer workflow: one live row per started item records where it entered,
// whether it is approved for merge, its weight, its numbered parts, any blocker and the open recommendation. The parser,
// the store, the command core and the status builder all use these; nothing here touches the database.

export type ItemKind = "pr" | "issue";
export type Entry = "review" | "fixup" | "implement" | "merge";
export type WorkflowState = "running" | "waiting" | "blocked" | "recommending" | "done" | "stopped" | "closed" | "backlog" | "superseded";
export type Surface = "github" | "discord" | "agent" | "dashboard" | "cli";

/**
 * Who started the workflow of a PR the automatic merge rule took up and then stopped for a person's judgement (auto-stop.ts). No GitHub
 * login has a space, so it is nobody's. The workflow acts for nobody until someone answers it: that person takes the item over.
 */
export const RULE_STARTER = "automatic merge rule";

/** The workflow an item is shown with: its newest, unless the automatic merge rule took the PR back from it, when it shows as unstarted. */
export const shownWorkflow = (history: readonly ItemWorkflow[]): ItemWorkflow | null => {
  const w = history.at(-1) ?? null;
  return w?.state === "superseded" ? null : w;
};

/** The blockers that bring an approved item back to a person, and `other` for a stop only a person can settle (its reason shown as given). */
export type Blocker = "author-commits" | "failed-twice" | "other";

export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 10;
export const WEIGHT_NORMAL = 5;
export const WEIGHT_WORDS = { urgent: 10, high: 8, low: 2 } as const;
export type WeightWord = keyof typeof WEIGHT_WORDS;

/** A finding or a separate change, numbered from 1 in the order the review listed it. */
export type PlanPart = {
  n: number;
  title: string;
  source: "review" | "change" | "implement";
  file?: string;
  /** An implement part: every file it changes or adds (the implementation PR comes back when it changes a file no planned part names). */
  files?: string[];
  /** An implement question's option this part is (its key in the question): naming the part picks it. */
  option?: string;
  /** The question whose option the part is. */
  question?: QuestionRef;
  major?: boolean;
  /** A review fix whose blocking class says it does not block (src/core/review-blocking.ts): on a PR approved for merge it is filed as a follow-up, not made. */
  minor?: true;
  /** A finding of the pre-merge review: a person who drops it overrules it, and it stays dropped in the plan while it is the workflow's. */
  premerge?: true;
  /** Who dropped it from the plan. */
  droppedBy?: string;
  /** The PR head it was dropped at: a dropped pre-merge finding stays overruled only while the PR's head is that one or follows it through our own pushes. */
  droppedAt?: string;
  state: "planned" | "dropped" | "fixed";
};

export type Recommendation = {
  /** One plain sentence; either written by the model step that produced it or built from a rule key. */
  text: string;
  /** Why the automatic merge rule stopped, as a phrase ("the review is unsure"): set on the recommendation of a rule row (auto-stop.ts). */
  stop?: string;
  /** What a yes runs. */
  parts: { fix: number[]; drop: number[] };
  merges: boolean;
  /** A yes closes the item (the review says close); no parts are fixed and nothing merges. */
  close?: boolean;
  /** A yes sends the item to the backlog: it stays open with no work planned (a hold that waits for other items). */
  backlog?: true;
  /**
   * The next step is the author's: AutoCraft posts the review's findings to the PR's author and waits for their push. `ask`: it does so
   * without a question, right after the review; `scope`: the review raises a scope question, so a person answers first and a yes asks the author.
   */
  author?: "ask" | "scope";
  /** How a yes closes the item, where the review says (an issue review's close). */
  closeAs?: CloseReason;
  /** An issue review's recommendation other than a close (src/issuereview): a yes implements the issue, sends it to the backlog, or asks its reporter `question`. */
  issue?: { review: number; action: "implement" | "backlog" | "ask"; question?: string };
  /** A yes runs this step again when it fixes no part: a new review, or a fix-up of the latest review's fixes. */
  again?: "review" | "fixup";
  /** The author pushed commits nobody reviewed: a yes merges only after a model review of them, which the merge leg waits for (a merge-queue PR asks for it with `again`). */
  newCommits?: true;
  /** The PR conflicts with its base branch, and this one has to resolve it: a yes approves the merge, and nothing is fixed or merged before. */
  waits?: "contributor" | "person";
  /** A yes runs no step of its own: the work goes on in the name of the person who says it, or AutoCraft looks again at what they settled on GitHub. */
  goes?: "on" | "look";
  /** What the question is about, which may clear without an answer: the question closes then and the item goes on. `lane`: the merge itself was refused for its approver's access. */
  cause?: { code: "actor-gone"; lane?: true } | { code: "base-off-default" | "no-ci" | "mergeable-stuck" | "ci-approval-failed" | "red-ci" }
    /** The fix-up made nothing at the head for a hold row in `state` (too-large, cannot-push, push-denied); it clears once that row is superseded. */
    | { code: "fix-unmade"; state: string };
  /** The review failed for good at this head: the word merge starts the PR at the merge queue, without it. Not past what an earlier review there asks: its planned parts, or its verdict. */
  skipsReview?: { parts: number[]; verdict?: "hold" | "close" };
  /** A yes answers this question of the implementation with this option, as the person (a stuck implementation's Try again). */
  answer?: QuestionAnswer;
  /** The open question of the implementation the recommendation stands for: once it is answered or set aside, the recommendation goes. */
  question?: QuestionRef;
  /** What the review found, in the words the question shows (its public summary), where it lists no fix: a bare fix makes the fix-up fix it. */
  finding?: string;
  /** The pre-merge review failed for good at the head: a yes gives it one more try there, the word merge goes on without it. */
  retriesPremerge?: true;
  /**
   * The fix-up tries are used up on a finding that stops the merge: a yes makes the fix again, told `instruction` (what the review or check
   * found) besides its parts; the word merge merges it as it is, past the pre-merge parts it would fix.
   */
  triedFix?: { instruction?: { text: string; review?: true } };
};

/** A question an implementation attempt asked: the attempt and the round that asked it (answers are recorded on that attempt). */
export type QuestionRef = { implementation: number; round: number };
/** An option picked as the answer to an implementation's question. */
export type QuestionAnswer = { question: QuestionRef; option: string; label?: string };

/** Both name the same question; a stored value of another shape names none. */
export const sameQuestion = (a: QuestionRef | null | undefined, b: QuestionRef | null | undefined): boolean =>
  typeof a === "object" && a !== null && typeof b === "object" && b !== null && a.implementation === b.implementation && a.round === b.round;

/**
 * What a held workflow goes back to when someone resumes it, kept in its `blockerParams` while it is held: the question that was open and
 * its blocker, and the fix-ups that were asked for and not made. `unstarted`: nobody had started the item, so there is nothing to go back to.
 */
export type HeldWork = {
  unstarted?: true;
  rec?: Recommendation;
  blocker?: Blocker;
  params?: Record<string, unknown>;
  fixes?: { instructions: string; head: string }[];
};

/** States in which an item has come back to a person: its recommendation is open, whether its steps are done or a blocker stopped it. */
export const ASKING_STATES = ["recommending", "blocked"] as const satisfies readonly WorkflowState[];

/** The item asks for another person in place of its approver, whose approval does not count any more (ask.ts). */
export const asksForApprover = (wf: Pick<ItemWorkflow, "state" | "blockerParams">): boolean => wf.state === "blocked" && wf.blockerParams?.code === "actor-gone";

/** The recommendation that waits for an answer, which every surface shows; null when none is open. */
export const openRecommendation = (wf: Pick<ItemWorkflow, "state" | "rec"> | null): Recommendation | null =>
  (wf && (ASKING_STATES as readonly WorkflowState[]).includes(wf.state) ? wf.rec : null);

/**
 * A PR's workflow that waits for its author (state `waiting`, kept in `blockerParams.author`): the comment AutoCraft posts to them, at the
 * head it was asked at. Their push ends the wait; nothing else of AutoCraft's runs on the item meanwhile. `by`: who asked; `auto`: the
 * review's recommendation asked, with nobody's question first.
 */
/**
 * `posted`: the comment is on GitHub. `unsent`: why AutoCraft has not posted it yet, while that clears by itself (the pipeline is off,
 * GitHub has not answered on access); it posts once it does.
 */
export type AuthorAsk = { login: string | null; head: string; text: string; line: string; by: string; at: string; auto?: true; posted?: true; unsent?: string };

/** The author ask of a workflow that waits for its PR's author; null for any other. */
export const authorAsk = (wf: Pick<ItemWorkflow, "kind" | "state" | "blockerParams"> | null): AuthorAsk | null => {
  const a = wf?.kind === "pr" && wf.state === "waiting" ? (wf.blockerParams?.author as AuthorAsk | undefined) : undefined;
  return a && typeof a.head === "string" && typeof a.text === "string" ? a : null;
};

/** What the held workflow goes back to. */
export const heldWork = (wf: Pick<ItemWorkflow, "blockerParams">): HeldWork => (wf.blockerParams?.held ?? {}) as HeldWork;

export type ItemWorkflow = {
  id: number;
  repo: string;
  number: number;
  kind: ItemKind;
  entry: Entry;
  weight: number;
  state: WorkflowState;
  startedBy: string;
  startedAt: string;
  startedVia: Surface;
  baseHead: string | null;
  /** The PR head a person accepted, moved along our own pushes: for a PR the same head as `baseHead`, for an issue the head of its implementation PR; null where only `baseHead` and the merge legs say it (src/core/evidence.ts acceptedHeads). */
  acceptedHead: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvedVia: Surface | null;
  /** Who holds it, and since when (state `stopped`). */
  stoppedBy: string | null;
  stoppedAt: string | null;
  /** A row the automatic merge rule started: the person whose answer last ran on it. Its questions go to them (asked.ts). */
  takenBy: string | null;
  blocker: Blocker | null;
  blockerParams: Record<string, unknown> | null;
  rec: Recommendation | null;
  recAt: string | null;
  /** The PR's head the recommendation was made at; an answer accepts it and our own pushes on it. Kept while a question the author pushed past is made again. */
  recHead: string | null;
  plan: PlanPart[];
  /** The step the workflow is at, as the advance pass last recorded it (status.ts StepName); null before its first pass. */
  step: string | null;
  /** An implement workflow's PR as `linkWorkflows` stored it (data/workflow/link.ts); null before an attempt opened one. */
  prNumber: number | null;
  /** A merge entry: a person asked for a model review of the head, made after this time. Null: it merges without one (core/evidence.ts neededReview). */
  reviewAskedAt: string | null;
  legacyPreapprovalId: number | null;
  /** How often the row was written since it was made. */
  version: number;
  updatedAt: string;
};

/** An item as written in a command: `repo` is `owner/name` or a bare name, resolved against the tracked repos by the caller. */
export type ItemRef = { repo: string; number: number };

/** Why a close command closes the item. `of`: the item it duplicates; a null repo is the closed item's own. */
export type CloseReason = { as: "completed" | "not-planned" } | { as: "duplicate"; of: { repo: string | null; number: number } };

/** One command word with its arguments, as the parser understood it. */
export type CommandPart =
  | { word: "review" | "fix-up" | "implement" | "merge" | "backlog" | "hold" | "resume" | "take" | "release" | "autorepin"; args?: string }
  /** `args`: the person's own words for the author, as written. */
  | { word: "ask-author"; args?: string }
  | { word: "close"; reason?: CloseReason }
  | { word: "drop" | "fix"; part: number | string; /** A fix's words as written, which the fix-up carries out when they name no part of the plan. */ text?: string }
  | { word: "weight"; weight: number };

/**
 * `items` is the list after a colon; empty means the item the text was written on. `understood` is the canonical text of what was
 * read (`fix-up, merge, urgent`) and `rest` the words that were not, as written.
 */
export type Parsed =
  | { kind: "yes"; items?: ItemRef[]; weight?: number }
  | { kind: "commands"; items: ItemRef[]; parts: CommandPart[]; /** A yes-word stood beside the commands ("yes, merge"). */ yes?: true }
  | { kind: "ambiguous"; understood: string; rest: string };

/** A registered control: a state change a panel needs that is not one of the command words. */
export type Control = "resume-breaker" | "release-outside" | "set-automatic" | "runner-settings";

/** `read`: a command a model read in a message the parser could not read, with its score and whether it ran (read.ts). */
export type WorkflowEventKind = "started" | "approved" | "answered" | "ambiguous" | "blocked" | "stopped" | "resumed" | "weighted" | "closed" | "backlog" | "set" | "read" | "taken" | "released";
