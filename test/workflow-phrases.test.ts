// How maintainers actually write: each phrase reads as the commands it means, or runs nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, parse } from "../src/workflow/parse.ts";
import { resolve } from "../src/workflow/resolve.ts";
import type { ItemWorkflow, PlanPart, Recommendation } from "../src/workflow/types.ts";

const SLUG = "autocraft-bot";
const AMBIGUOUS = "ambiguous";

/** The canonical text of what a phrase reads as; "yes + …" when a yes-word stood beside the commands. */
function read(text: string): string {
  const p = parse(text, { slug: SLUG, repo: "photocraft" });
  if (p.kind === "ambiguous") return AMBIGUOUS;
  if (p.kind === "yes") return describe(p.weight ? [{ word: "weight", weight: p.weight }] : [], p.items ?? []) ? `yes, ${describe(p.weight ? [{ word: "weight", weight: p.weight }] : [], p.items ?? [])}` : "yes";
  return `${p.yes ? "yes + " : ""}${describe(p.parts, p.items)}`;
}

const PHRASES: readonly (readonly [string, string])[] = [
  // Politeness, approval and references to the item in context around a command.
  ["please merge", "merge"],
  ["can you merge this PR", "merge"],
  ["could you review it please", "review"],
  ["let's merge it", "merge"],
  ["@autocraft-bot please go ahead and merge this PR", "yes + merge"],
  ["thanks for the fix, merge it", "merge"],
  ["Nice work, merge it please", "merge"],
  ["Thanks. Merge it.", "merge"],
  ["review it for now", "review"],
  ["review its PR", "review"],
  ["close the issue", "close"],
  ["looks good, merge it", "yes + merge"],
  ["LGTM, merge", "yes + merge"],
  ["Looks good to me. Merge it.", "yes + merge"],
  ["approved, merge", "yes + merge"],
  ["looks good", "yes"],
  ["thanks, looks good", "yes"],
  ["let's do it", "yes"],
  ["looks great, thanks!", "yes"],
  // Other words for the commands.
  ["land it", "merge"],
  ["please land this PR", "merge"],
  ["ship", "merge"],
  ["ship it", "yes"],
  ["park it", "backlog"],
  ["park this for now", "backlog"],
  ["hold off", "hold"],
  ["not now", "hold"],
  ["don't merge yet", "hold"],
  ["please don’t merge yet", "hold"],
  ["no, don't merge yet", "hold"],
  ["carry on", "resume"],
  ["unpause", "resume"],
  ["please carry on", "resume"],
  ["take a look", "review"],
  ["can you take a look at this PR", "review"],
  ["have a look, high priority", "review, high"],
  ["close, it's a dupe of #12", "close as duplicate of #12"],
  ["close this as a dupe of #12", "close as duplicate of #12"],
  ["please close this, it's a dupe of #12", "close as duplicate of #12"],
  ["close it, same as photocraft#9", "close as duplicate of photocraft#9"],
  ["close as dupe of storytold/deckcraft#3", "close as duplicate of storytold/deckcraft#3"],
  ["close the issue as completed", "close as completed"],
  ["close this issue, not planned", "close as not planned"],
  // Conditions every merge meets anyway; others run nothing.
  ["merge once CI is green", "merge"],
  ["merge when CI passes", "merge"],
  ["merge it when ready", "merge"],
  ["LGTM, merge once the checks pass", "yes + merge"],
  ["fix-up and merge after review", "fix-up, merge"],
  ["merge after CI", "merge"],
  ["merge after CI passes", "merge"],
  ["merge after CI is green", "merge"],
  ["merge after CI is done", "merge"],
  ["merge after CI finishes", "merge"],
  ["merge once CI passes", "merge"],
  ["merge once CI is done", "merge"],
  ["merge when CI is done", "merge"],
  ["merge after the checks pass", "merge"],
  ["merge after tests pass", "merge"],
  ["LGTM, merge after CI", "yes + merge"],
  ["review after CI", AMBIGUOUS],
  ["hold after CI", AMBIGUOUS],
  ["close after CI", AMBIGUOUS],
  ["merge after CI fails", AMBIGUOUS],
  ["merge after Friday", AMBIGUOUS],
  ["merge after Dylan's review", AMBIGUOUS],
  ["merge after review", AMBIGUOUS],
  ["review once CI is green", AMBIGUOUS],
  ["yes, once CI is green", AMBIGUOUS],
  ["hold once CI is green", AMBIGUOUS],
  ["merge this after #12 lands", AMBIGUOUS],
  ["merge after #12 merges", AMBIGUOUS],
  ["merge tomorrow", AMBIGUOUS],
  ["merge unless someone objects", AMBIGUOUS],
  ["merge if CI is green", AMBIGUOUS],
  // Exceptions to a yes.
  ["yes but skip the export change", "yes + drop the export change"],
  ["yes except 3", "yes + drop 3"],
  ["all except 3", "yes + drop 3"],
  ["everything but the first one", "yes + drop 1"],
  ["LGTM except 2 and 4", "yes + drop 2, drop 4"],
  ["yes, but drop 2", "yes + drop 2"],
  ["all but 3, urgent", "yes + drop 3, urgent"],
  ["merge everything except 3", "drop 3, merge"],
  ["fix all except 2", "fix-up, drop 2"],
  ["yes but wait", AMBIGUOUS],
  ["yes except when CI fails", AMBIGUOUS],
  ["yes but not 3", AMBIGUOUS],
  ["yes except merge", AMBIGUOUS],
  ["approve except merge", AMBIGUOUS],
  ["all but merge", AMBIGUOUS],
  ["yes, all except merge", AMBIGUOUS],
  ["yes except\nmerge", AMBIGUOUS],
  ["yes except close", AMBIGUOUS],
  ["yes except review", AMBIGUOUS],
  ["yes except hold", AMBIGUOUS],
  ["lgtm except the merge", AMBIGUOUS],
  ["merge everything except review", AMBIGUOUS],
  ["yes except 3 and the reveiw", AMBIGUOUS],
  ["fix all except 2, then merge", "fix-up, drop 2, merge"],
  // Parts by number word, ordinal and range.
  ["drop the second one", "drop 2"],
  ["fix one and three", "fix 1, fix 3"],
  ["fix 1-3", "fix 1, fix 2, fix 3"],
  ["drop 2 to 4", "drop 2, drop 3, drop 4"],
  ["fix the first and the third, then merge", "fix 1, fix 3, merge"],
  ["drop the 2nd", "drop 2"],
  ["fix both", "fix both"],
  ["drop all of them, merge", "drop all, merge"],
  ["skip 2", "drop 2"],
  ["leave out the third one", "drop 3"],
  ["skip review", AMBIGUOUS],
  ["yes but skip review", AMBIGUOUS],
  ["yes except the last one", AMBIGUOUS],
  ["drop 1-30", AMBIGUOUS],
  // A typo of one letter in a long command word.
  ["mrege", "merge"],
  ["please merg it", AMBIGUOUS],
  ["reveiw", "review"],
  ["backlgo", "backlog"],
  ["implemnet", "implement"],
  ["implment", AMBIGUOUS],
  ["clsoe", AMBIGUOUS],
  ["lose", AMBIGUOUS],
  ["chose", AMBIGUOUS],
  ["closet", AMBIGUOUS],
  ["cloze", AMBIGUOUS],
  ["verge", AMBIGUOUS],
  ["emerge", AMBIGUOUS],
  ["preview", AMBIGUOUS],
  ["reviews", AMBIGUOUS],
  ["merger", AMBIGUOUS],
  ["close's", AMBIGUOUS],
  ["hodl", AMBIGUOUS],
  ["drpo 2", AMBIGUOUS],
  ["merged", AMBIGUOUS],
  ["closed", AMBIGUOUS],
  ["clone", AMBIGUOUS],
  // Negation, hedges and questions.
  ["don't merge", AMBIGUOUS],
  ["do not merge", AMBIGUOUS],
  ["never merge this", AMBIGUOUS],
  ["maybe merge?", AMBIGUOUS],
  ["maybe merge", AMBIGUOUS],
  ["perhaps review it", AMBIGUOUS],
  ["merge?", AMBIGUOUS],
  ["can you merge this?", AMBIGUOUS],
  ["why did this fail?", AMBIGUOUS],
  ["the export change is wrong because it drops the undo stack, merge the rest", AMBIGUOUS],
  ["not sure, review it", AMBIGUOUS],
  ["I don't think we should merge", AMBIGUOUS],
  ["merge, not review", AMBIGUOUS],
  ["don't close", AMBIGUOUS],
  // Quoted lines and code are not read as commands.
  ["> merge\nreview", "review"],
  ["```\nmerge\n```\nreview", "review"],
  ["`merge`", AMBIGUOUS],
  ["review, the `merge` helper is fine", AMBIGUOUS],
  ["drop the `exportDialog` change", "drop the exportDialog change"],
];

test("maintainer phrasing reads as the commands it means, and anything else runs nothing", () => {
  const wrong = PHRASES.map(([text, want]) => [text, want, read(text)] as const).filter(([, want, got]) => want !== got);
  assert.deepEqual(wrong, []);
});

test("an exception to a yes runs what drop runs, and both or all name the planned parts", () => {
  const part = (n: number, title: string): PlanPart => ({ n, title, source: "review", state: "planned" });
  const rec: Recommendation = { text: "Fix all three, then merge.", parts: { fix: [1, 2, 3], drop: [] }, merges: true };
  const wf = (plan: PlanPart[]): ItemWorkflow => ({
    id: 1, repo: "storytold/photocraft", number: 812, kind: "pr", entry: "review", weight: 5, state: "recommending", step: null,
    startedBy: "mira", startedAt: "2026-11-24T09:02:00Z", startedVia: "github", baseHead: "abc", acceptedHead: null, version: 0,
    approvedBy: null, approvedAt: null, approvedVia: null, stoppedBy: null, stoppedAt: null, takenBy: null, closedWaits: null, blocker: null, blockerParams: null,
    rec, recAt: "2026-11-24T10:00:00Z", recHead: null, plan, prNumber: null, reviewAskedAt: null, legacyPreapprovalId: null, updatedAt: "2026-11-24T09:02:00Z",
  });
  const three = { kind: "pr" as const, workflow: wf([part(1, "Export dialog loses focus"), part(2, "Title typo"), part(3, "Unused import")]) };
  const run = (text: string, state = three) => resolve(parse(text), state);
  const plain = run("drop 2");
  for (const text of ["yes except 2", "everything but the second one", "LGTM but skip the title typo"]) assert.deepEqual(run(text), plain, text);
  const all = run("fix all of them");
  assert.ok(all.kind === "run" && all.run.fix.join() === "1,2,3");
  assert.equal(run("fix both").kind, "ambiguous");
  // A word inside another word names no part: "port" is in "import", not a word of its title.
  const inside = run("drop port");
  assert.ok(inside.kind === "ambiguous" && inside.ambiguity.why === "part-matches-none");
  const two = { kind: "pr" as const, workflow: wf([part(1, "Export dialog loses focus"), part(2, "Title typo")]) };
  const both = run("fix both", two);
  assert.ok(both.kind === "run" && both.run.fix.join() === "1,2");
});
