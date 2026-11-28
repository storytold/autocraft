// The words maintainers use on every surface, in one list: the commands, the answer words, the yes-words, the weight words
// and the registered controls. The parser reads its words from here, and Help, Discord help and the agent's tool
// descriptions are generated from it. Text is stored as translation keys (tk) and shown through t(). Plain data; the
// dashboard bundle loads it too.
import { tk } from "../i18n/index.ts";
import { WEIGHT_NORMAL, WEIGHT_WORDS, type Control, type Entry, type WeightWord } from "./types.ts";

export type CommandWord = "review" | "fix-up" | "implement" | "merge" | "drop" | "fix" | "ask-author" | "backlog" | "close" | "hold" | "resume" | "take" | "release" | "autorepin";

export type CommandDef = {
  word: CommandWord;
  /** As Help writes it, with its argument. */
  usage: string;
  /** Other spellings the parser accepts, lower case. */
  aliases: readonly string[];
  /** The entry it starts at on an item nobody started; null for words that start nothing. */
  entry: Entry | null;
  /** Only in an answer to a started item: it names parts of the plan. */
  answer?: boolean;
  /** One line for lists and tool descriptions. */
  short: string;
  /** What it does, for Help. */
  does: string;
  /** When AutoCraft comes back to a person afterwards. */
  back: string;
  /** The example every surface shows. */
  example: string;
  /** Listed under "More commands" in Help. */
  more?: boolean;
};

export const COMMANDS: readonly CommandDef[] = [
  {
    word: "review", usage: "review", aliases: ["review again", "take a look", "take a look at", "have a look", "have a look at"], entry: "review",
    short: tk("Start at Review."),
    does: tk("Reviews the pull request. On an issue, reviews the issue against the code and recommends implement, close, ask the reporter or backlog; review and implement goes on to implement when the review recommends it. On a started item, reviews it again."),
    back: tk("When the review is done, with one recommendation. If the merge is approved: only at a blocker."),
    example: "review",
  },
  {
    word: "fix-up", usage: "fix-up", aliases: ["fixup", "fix up"], entry: "fixup",
    short: tk("Start at Fix-up: review, fix-up, review again."),
    does: tk("Reviews the pull request, fixes what the review finds, and reviews the fixes. fix alone means the same."),
    back: tk("When the second review is done, with one recommendation. If the merge is approved: only at a blocker."),
    example: "fix-up and merge",
  },
  {
    word: "implement", usage: "implement", aliases: [], entry: "implement",
    short: tk("Start at Implement (issues)."),
    does: tk("Issues only. Writes the change and its tests in a new pull request, then reviews and fixes it."),
    back: tk("When the pull request is reviewed and fixed, with one recommendation. If the merge is approved: only at a blocker."),
    example: "implement",
  },
  {
    word: "merge", usage: "merge", aliases: ["merge queue", "merge-queue", "mergequeue", "land", "ship"], entry: "merge",
    short: tk("Approve for merge; on a pull request nobody started, the merge queue."),
    does: tk("Approves the merge, as the merge button on GitHub would: AutoCraft makes every fix the merge needs first. On a started item the steps stay the same and end in a merge; on an open recommendation, it runs the recommendation, then merges. A pull request nobody started goes straight to the merge queue, with no review."),
    back: tk("Only at a blocker."),
    example: "merge",
  },
  {
    word: "drop", usage: "drop <part>", aliases: ["skip", "leave out"], entry: null, answer: true,
    short: tk("Remove a finding or change from the plan."),
    does: tk("Leaves one finding or change out, named by its number or by words from its title. Words that match no part or several parts run nothing."),
    back: tk("As the plan said before."),
    example: "drop 2",
  },
  {
    word: "fix", usage: "fix <part or instructions>", aliases: [], entry: null, answer: true,
    short: tk("Fix the named findings, or what your words after fix say."),
    does: tk("Runs the fix-up on the named findings or changes, by number or by words from the title, then reviews again. Words that match no part are instructions: the fix-up does what they say, with the planned findings. With no part, fix is fix-up; if the review lists no fix, it fixes what the review found."),
    back: tk("As the plan said before."),
    example: "fix the export normals, then merge",
  },
  {
    word: "ask-author", usage: "ask author [<your words for the author>]", aliases: ["ask the author"], entry: null,
    short: tk("Ask the pull request's author to finish or fix it, and wait for their push."),
    does: tk("Posts one comment to the author with what the review found and the fixes it lists, and your own words when you add them. AutoCraft runs nothing on the pull request until the author pushes; it then reviews the new commits. A comment by the author without a push keeps it waiting. Any command replaces the wait."),
    back: tk("When the review of the author's new commits is done, with one recommendation. If the merge is approved: only at a blocker."),
    example: "ask author to wire the group editor into the tab bar",
  },
  {
    word: "backlog", usage: "backlog", aliases: ["park"], entry: null,
    short: tk("Keep it open, with no work planned."),
    does: tk("The item stays open with nothing planned and leaves the active lists."),
    back: tk("Never; send any command to start it again."),
    example: "backlog",
  },
  {
    word: "close", usage: "close [as completed | as not planned | as duplicate of <item>]", aliases: [], entry: null,
    short: tk("Close the item."),
    does: tk("Closes the issue or pull request on GitHub as you, with a short comment. The reason is optional: completed, not planned, or the item it duplicates. Nothing more runs."),
    back: tk("Never."),
    example: "close as duplicate of #12",
  },
  {
    word: "hold", usage: "hold", aliases: ["stop", "pause", "wait", "halt", "hold on", "hold off", "on hold", "not yet", "not now", "don't merge yet", "dont merge yet", "do not merge yet"], entry: null,
    short: tk("End all work on the item, and keep off it until someone resumes it."),
    does: tk("Ends every step at once and takes the item out of its batch. AutoCraft keeps off it, whether anyone started it or not, and shows who holds it. stop, pause, wait and not yet mean the same."),
    back: tk("Never; resume or yes goes on, and any other command starts again."),
    example: "hold",
  },
  {
    word: "resume", usage: "resume", aliases: ["carry on", "unpause"], entry: null,
    short: tk("Go on with a held item."),
    does: tk("Goes on with a held item where it was, with its merge approval, now in your name. yes and continue do the same. If the author pushed commits meanwhile, AutoCraft reviews them first. An item nobody started goes back to how it was."),
    back: tk("As the plan said before the hold."),
    example: "resume",
  },
  {
    word: "take", usage: "take", aliases: ["run on my task runner", "take on my task runner"], entry: null,
    short: tk("Run the item's work on your own Task Runner too."),
    does: tk("Your Task Runner takes this item's work while the Task Runners of the person who started or approved it are busy, away or held by their usage limit; theirs come first. Only this item: your other settings stay as they are. Until its work ends or you release it."),
    back: tk("As the plan said before."),
    example: "take",
    more: true,
  },
  {
    word: "release", usage: "release", aliases: ["release my task runner"], entry: null,
    short: tk("Stop running the item's work on your Task Runner."),
    does: tk("Ends a take: your Task Runner takes no more of this item's work. A call it runs now finishes."),
    back: tk("As the plan said before."),
    example: "release",
    more: true,
  },
  {
    word: "autorepin", usage: "autorepin <pull request> [via <branch>]", aliases: ["auto-repin", "auto repin"], entry: null,
    short: tk("Repin Cargo dependencies when the pull request merges."),
    does: tk("Once this pull request merges, the named pull request's Cargo dependencies on this repository are repinned to the merge commit, or with via, to the first commit of that branch that holds it. off drops it."),
    back: tk("Never."),
    example: "autorepin photocraft#812",
    more: true,
  },
];

/** The words that mean a hold, lower case. */
export const HOLD_WORDS: readonly string[] = COMMANDS.filter((c) => c.word === "hold").flatMap((c) => [c.word, ...c.aliases]);

/** Answers that run the open recommendation as it stands, lower case and without punctuation. */
export const YES_WORDS: readonly string[] = [
  "yes", "y", "yep", "yeah", "yup", "ok", "okay", "approve", "approved", "lgtm", "looks good", "looks good to me", "looks great", "go", "go ahead", "go for it", "sounds good", "do it", "ship it", "proceed", "continue",
];
/** Words a yes may carry after it without changing it: "yes please", "lgtm, thanks". */
export const YES_TRAILERS: readonly string[] = ["please", "thanks", "thank you", "thx"];

export const WEIGHT_HELP: readonly { word: string; weight: string }[] = [
  { word: "urgent", weight: tk("10, first in every queue") },
  { word: "high", weight: "8" },
  { word: tk("(none)"), weight: tk("5, normal") },
  { word: "low", weight: "2" },
  { word: "weight <1-10>", weight: tk("an exact value") },
];

/** The word a weight shows as; the normal weight shows nothing. */
export function weightWord(w: number | null | undefined): string | null {
  if (w == null || w === WEIGHT_NORMAL) return null;
  const word = (Object.keys(WEIGHT_WORDS) as WeightWord[]).find((k) => WEIGHT_WORDS[k] === w);
  return word ?? `weight ${w}`;
}

export type ControlDef = { control: Control; name: string; short: string };

/** State changes panels need beyond the command words; each is a registered command, so the agent can do it too. */
export const CONTROLS: readonly ControlDef[] = [
  { control: "resume-breaker", name: tk("Resume"), short: tk("Resume a step its circuit breaker paused.") },
  { control: "release-outside", name: tk("Release"), short: tk("Release an outside author's held items.") },
  { control: "set-automatic", name: tk("Automatic"), short: tk("Turn automatic work on a repository on or off.") },
  { control: "runner-settings", name: tk("Task Runner settings"), short: tk("Choose what your Task Runner takes.") },
];

export const ENTRY_LABEL: Record<Entry, string> = {
  review: tk("Review"),
  fixup: tk("Fix-up"),
  implement: tk("Implement"),
  merge: tk("Merge queue"),
};

/** The command a word or alias names, or null. `text` is lower case with single spaces. */
export function commandOf(text: string): CommandDef | null {
  return COMMANDS.find((c) => c.word === text || c.aliases.includes(text)) ?? null;
}
