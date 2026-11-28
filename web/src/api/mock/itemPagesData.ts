// Mock content for the redesign: the curated items, their status lines, reviews, results, history and GitHub sides, and findings.
import type { FixRound, GithubEvent, ItemBar, ItemBarStep, GithubSide, HistoryEntry, ItemImplementation, ItemKind, ItemPageData, ItemPageHeader, ItemPeek, ItemPhase, ItemStatus, OpusReviewEntry, ScreenshotRun, TimelineEntry } from "../types";
import { withTimeline, type MockPage, type ResultCard } from "./storyMock";
import { NOW } from "./fixtures";

export const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const H = 60;
const D = 1440;

const status = (phase: ItemPhase, since: number, waiting: string | null, next: string | null): ItemStatus => ({ phase, waiting, next, since: at(since) });

const HEADER_1484: Partial<ItemPageHeader> = {
  labels: ["enhancement", "i18n", "needs-decision"], assignees: ["rhea-m"], autocraftAssigned: true,
  discord: { count: 2, links: [{ url: "https://discord.example/channels/1/2/3", at: at(3 * H) }], signals: 1, signalLinks: [{ url: "https://discord.example/channels/1/2/3", at: at(3 * H) }] },
  queue: { stage: "Merge", tab: "merge", place: 3 }, tier: "whitelisted", size: "XL",
  releases: { reviewAgain: true, verifyAgain: true, batchAgain: true },
  preapproval: { id: 7, by: "rhea-m", at: at(4 * H), instructions: "Use load_pack for the dictionary, then merge when CI is green.", state: "failed", fromHead: "e6a09b1", head: null, reason: "the fix-up refused: crates/doc/Cargo.toml is not a file a fix-up may edit", updatedAt: at(3 * H) },
};

type Seed = { repo: string; number: number; kind: "pr" | "issue"; state: "open" | "closed" | "merged"; title: string; author: string; status: ItemStatus; updated: number };
const seeds: Seed[] = [
  { repo: "photocraft", number: 812, kind: "pr", state: "merged", title: "Crop handles snap past the canvas edge", author: "larkspur-dev", updated: 211, status: status("Merged", 219, null, null) },
  { repo: "designcraft", number: 455, kind: "pr", state: "open", title: "Snap guides ignore hidden layers", author: "sable-ui", updated: 26, status: status("Waiting for a person", 26, "an answer to the recommendation", "what the answer says") },
  { repo: "deckcraft", number: 77, kind: "issue", state: "open", title: "Export speaker notes", author: "brushstroke42", updated: 6, status: status("Fixing", 96, "the workspace test run", "open a PR, review it, then ask before merging") },
  { repo: "designcraft", number: 1484, kind: "pr", state: "open", title: "Add Hungarian spellchecking and nonstandard hyphenation", author: "rhea-m", updated: 20, status: status("Waiting for a person", 5 * H, "an answer to the recommendation", "what the answer says") },
  { repo: "photocraft", number: 9981, kind: "pr", state: "open", title: "Fix crop handles on rotated layers", author: "dana-k", updated: 38, status: status("In queue", 46, "CI on a1b2c3d", "merge in batch #41") },
  { repo: "wordcraft", number: 2231, kind: "pr", state: "open", title: "Keep the hyperlink run when exporting the last paragraph", author: "linnea-w", updated: 3, status: status("Fixing", 6, "fix-up round 2", "review of the new head, then merge") },
  { repo: "vectorcraft", number: 1388, kind: "pr", state: "open", title: "Snap guides ignore locked layers", author: "kiri-n", updated: 12, status: status("Fixing", 26, "a fix-up", "review of the new head, then merge") },
  { repo: "wordcraft", number: 2214, kind: "issue", state: "open", title: "Export to PDF drops the hyperlink on the last paragraph", author: "linnea-w", updated: 9, status: status("Fixing", 70, "fix-up round 2 on wordcraft#2231", "review of the new head, then merge") },
  { repo: "photocraft", number: 9970, kind: "pr", state: "merged", title: "Curves: keep the endpoint handles inside the plot", author: "hollowbrook", updated: 98, status: status("Merged", 98, null, null) },
  { repo: "pdfcraft", number: 2210, kind: "pr", state: "open", title: "Add CMYK output profile selection", author: "pixel-wrangler", updated: 1 * D, status: status("Waiting for a person", 1 * D, "a maintainer to start it", null) },
  { repo: "photocraft", number: 4127, kind: "pr", state: "open", title: "Add Wave distortion filter with live preview", author: "pixel-wrangler", updated: 3 * H, status: status("Waiting for a person", 71 * H, "a maintainer to start it", null) },
  { repo: "gridcraft", number: 977, kind: "pr", state: "open", title: "Range spill: keep neighbouring cells when a formula grows", author: "saltmarsh-ink", updated: 2 * H, status: status("Waiting for a person", 2 * H, "an answer to the recommendation", "what the answer says") },
  { repo: "vectorcraft", number: 1402, kind: "pr", state: "open", title: "Rename the curvature toggle and add a shortcut", author: "kiri-n", updated: 6, status: status("Verifying", 14, "a build worker", "merge queue if verified") },
  { repo: "lightcraft", number: 540, kind: "pr", state: "open", title: "Bloom threshold slider is ignored in preview", author: "hollowbrook", updated: 30, status: status("Review", 22, "an Opus review", "its verdict") },
  { repo: "filmcraft", number: 1830, kind: "issue", state: "open", title: "Timeline playhead jumps when zooming with the trackpad", author: "mosswood", updated: 50, status: status("Triage", 50, "classifier verdicts", "priority") },
  { repo: "craft-libs", number: 517, kind: "pr", state: "open", title: "Improve startup time", author: "wren-lat", updated: 4 * H, status: { ...status("Held", 4 * H, "author's daily limit (5 new PRs a day)", "Model work starts when the window frees or an operator releases it"), outside: { reason: "limit", author: "wren-lat", kind: "pr", limit: 5 } } },
  { repo: "effectcraft", number: 301, kind: "pr", state: "open", title: "Glow effect: use linear blending", author: "brushstroke42", updated: 2 * D, status: status("Held", 2 * D, "an operator to release the hold", "review resumes") },
  { repo: "craft-libs", number: 412, kind: "pr", state: "merged", title: "Bump the egui pin", author: "kiri-n", updated: 3 * H, status: status("Merged", 3 * H, null, null) },
  { repo: "deckcraft", number: 655, kind: "issue", state: "closed", title: "Slide thumbnails are blank after undo", author: "glasswing", updated: 5 * H, status: status("Closed", 5 * H, null, null) },
  { repo: "designcraft", number: 2007, kind: "pr", state: "open", title: "Text frames: overset indicator stays after the frame grows", author: "larkspur-dev", updated: 4 * H, status: status("Waiting for a person", 55, "a Duplicates answer", "close the others on the answer") },
  { repo: "pdfcraft", number: 2188, kind: "pr", state: "open", title: "Bookmark panel: add a collapse-all button", author: "rhea-m", updated: 6 * H, status: status("Out of scope", 6 * H, null, null) },
];

const step = (stage: string, title: string, state: ItemBarStep["state"], minAgo: number | null, costUsd: number | null, jobId: number | null, running = false): ItemBarStep =>
  ({ stage, title, state, running, at: minAgo === null ? null : at(minAgo), costUsd, jobId });
const PR_NEXT = [step("verify", "Verify", "next", null, null, null), step("merge", "Merge", "next", null, null, null), step("postmerge", "Post-merge review", "next", null, null, null)];

/** The status bar of the curated items: a running fix-up, a queued review, a failed fix-up, an issue and a merged PR. */
const BARS: Record<string, ItemBar> = {
  "wordcraft#2231": {
    headline: { tone: "running", text: "Fix-up running", next: "review of the new head, then merge", model: "Opus", startedAt: at(1.2), jobId: 4412 },
    steps: [step("classify", "Classify", "done", 5 * H, 0.01, 4301), step("review", "Review", "done", 3 * H, 0.92, 4377), step("fixup", "Fix-up", "current", null, 1.4, 4412, true), ...PR_NEXT],
  },
  "pdfcraft#7286": {
    headline: { tone: "waiting", text: "Waiting for octo-dev, asked after the review: The group editor and the pinned layout have no caller.", next: "review of the author's new commits", model: null, startedAt: null, jobId: null },
    steps: [step("classify", "Classify", "done", 2 * D, 0.01, 4210), step("review", "Review", "done", 3 * H, 1.2, 4340), step("decide", "Recommendation", "current", null, null, null)],
  },
  "lightcraft#540": {
    headline: { tone: "queued", text: "Queued for Opus review · #2 in line", next: "its verdict", model: null, startedAt: null, jobId: 4415 },
    steps: [step("classify", "Classify", "done", 40, 0.01, 4398), step("review", "Review", "current", null, null, 4415), ...PR_NEXT],
  },
  "vectorcraft#1388": {
    headline: { tone: "failed", text: "Fix-up failed: the patch does not compile: fs::metadata returns a Result that is not handled", next: "review of the new head, then merge", model: null, startedAt: null, jobId: 4404 },
    steps: [step("classify", "Classify", "done", 4 * H, 0.01, 4290), step("review", "Review", "done", 2 * H, 0.88, 4366), step("fixup", "Fix-up", "failed", 26, 1.84, 4404), ...PR_NEXT],
  },
  "designcraft#1484": {
    headline: { tone: "waiting", text: "Waiting for an answer to the recommendation", next: "what the answer says", model: null, startedAt: null, jobId: null },
    steps: [step("classify", "Classify", "done", 2 * D, 0.01, 4001), step("review", "Review", "done", 5 * H, 1.35, 4350), step("fixup", "Fix-up", "failed", 3 * H, 0.4, 4380), step("decide", "Recommendation", "current", null, 0.2, null), ...PR_NEXT],
  },
  "craft-libs#517": {
    headline: { tone: "waiting", text: "Waiting: author's daily limit (5 new PRs a day)", next: "Model work starts when the window frees or an operator releases it", model: null, startedAt: null, jobId: null, outside: { reason: "limit", author: "wren-lat", kind: "pr", limit: 5 } },
    steps: [],
  },
  "filmcraft#1830": {
    headline: { tone: "running", text: "Classify running", next: "priority", model: "Jev", startedAt: at(0.15), jobId: 4418 },
    steps: [step("dupes", "Duplicates", "done", 49, 0, 4416), step("classify", "Classify", "current", null, null, 4418, true)],
  },
  "photocraft#9970": {
    headline: { tone: "done", text: "Merged", next: null, model: null, startedAt: null, jobId: null },
    steps: [step("classify", "Classify", "done", 2 * D, 0.01, 4100), step("review", "Review", "done", 2 * D - 30, 0.9, 4120), step("verify", "Verify", "done", 3 * H, 0.3, 4360), step("merge", "Merge", "done", 98, null, null), step("postmerge", "Post-merge review", "done", 95, 0.4, 4372)],
  },
};

const TONE_OF: Partial<Record<ItemPhase, ItemBar["headline"]["tone"]>> = { "Waiting for a person": "waiting", Merged: "done", Closed: "done" };
/** Items without a curated bar: the headline restates the status line and no steps are known. */
export const barFromStatus = (s: ItemStatus): ItemBar => ({
  headline: { tone: TONE_OF[s.phase] ?? "idle", text: s.waiting ? (s.phase === "Waiting for a person" ? `Waiting for ${s.waiting}` : `${s.phase} · waiting for ${s.waiting}`) : s.phase, next: s.next, model: null, startedAt: null, jobId: null },
  steps: [],
});

export const findingStatus = (state: string, attempts: number, note: string | null): ItemStatus => {
  if (state === "new" && attempts > 0) return status("Waiting for a person", 40, `a decision: ${note ?? "see the rounds"}`, "Fix again with a note, Backlog or Dismiss");
  if (state === "new") return status("Waiting for a person", 9 * D, "a decision to fix", "Fix opens a private fix");
  if (state === "fixing") return status("Fixing", 25, "round 2 of 3 building", "Opus review of the patch");
  if (state === "ready") return status("Waiting for a person", 3 * H, "Land or an advisory", "Land opens a quiet pull request");
  if (state === "landing") return status("In queue", 2 * H, "the pull request's checks", "merge by rule");
  if (state === "awaiting-admin") return status("Waiting for a person", 5 * H, "a repository admin", "publish the advisory");
  if (state === "backlog") return status("Held", 3 * D, null, null);
  return status("Closed", 3 * D, null, null);
};

/** What the hover card of a mock item shows. */
export type PeekRow = Omit<ItemPeek, "createdAt" | "labels">;

/** Quieter items from many repos. */
function fillerRows(): PeekRow[] {
  const repos = ["designcraft", "photocraft", "wordcraft", "pdfcraft", "gridcraft", "vectorcraft", "lightcraft", "filmcraft"];
  const titles = ["Tooltip clips at the window edge", "Add a keyboard shortcut for zoom to selection", "Crash when the recent list is empty", "Panel resize handle flickers", "Update the French strings", "Undo skips the last brush stroke", "Rulers show the wrong unit after import", "Typo in the export dialog"];
  const phases: [ItemPhase, string | null, string | null][] = [["Triage", "classification", null], ["Review", "an Opus review", "post the review"], ["Fixing", "fix-up round 1", "verify"], ["Merged", null, null], ["Closed", null, null], ["Out of scope", null, null], ["In queue", "CI", "merge by rule"], ["Verifying", "a build worker", "merge queue"]];
  return Array.from({ length: 44 }, (_, i) => {
    const [phase, waiting, next] = phases[i % phases.length]!;
    const kind = i % 3 === 0 ? "issue" : "pr";
    const state = phase === "Merged" ? "merged" : phase === "Closed" || phase === "Out of scope" ? "closed" : "open";
    const m = 8 * H + i * 37;
    return { closes: kind === "pr" && i % 2 === 0 ? [3000 + i] : [], repo: repos[i % repos.length]!, number: 3100 + i * 7, kind, state: kind === "issue" && state === "merged" ? "closed" : state, title: titles[(i * 5) % titles.length]!, author: ["mosswood", "kestrel", "dmann", null][i % 4] ?? null, status: status(phase, m, waiting, next), updatedAt: at(m) } as PeekRow;
  });
}

export function peekRows(): PeekRow[] {
  return [...seedRows(), ...fillerRows()];
}

function seedRows(): PeekRow[] {
  return seeds.map((s) => ({ repo: s.repo, number: s.number, kind: s.kind, state: s.state, title: s.title, author: s.author ?? null, status: s.status, updatedAt: at(s.updated), closes: [] }));
}

/** A plain header for mock pages: open, nothing queued or held. */
export function mockHeader(kind: ItemKind, labels: string[] = []): ItemPageHeader {
  return {
    labels, assignees: [], autocraftAssigned: false, pipelineOn: true, discord: null, queue: null, held: false, preapproval: null,
    releases: { reviewAgain: false, verifyAgain: false, batchAgain: false }, tier: "not", size: kind === "pr" ? "S" : null,
    backlog: { held: false, canSettle: true },
  };
}

const review = (p: Partial<OpusReviewEntry> & Pick<OpusReviewEntry, "id" | "head" | "at" | "trigger" | "why" | "verdict" | "summary">): OpusReviewEntry => ({
  current: false, sure: true, fixes: [], risks: [], claims: [], blockedBy: [], costUsd: 0.8, ...p,
});

const REVIEWS_1484: { latest: OpusReviewEntry; earlier: OpusReviewEntry[] } = {
  latest: review({
    id: "r4", head: "e6a09b1", current: true, at: at(5 * H + 30), trigger: "discussion", why: "mosswood replied that the language pack loads, so the earlier finding was checked again", verdict: "take", sure: false,
    summary: "The spellchecker and hyphenation code are sound and well tested. Almost all of the diff is dictionary and pattern data that the language pack in craft-i18n already ships, so merging duplicates about 270,000 lines. Opus is unsure whether the team wants a second copy.",
    blockedBy: [{ repo: "craft-i18n", number: 88 }],
    risks: ["Every clone grows by about 9 MB.", "The pack's hyphenation rules differ in 14 patterns, so two versions would be in use."],
    claims: [
      { path: "crates/spell/src/hu.rs", line: 41, text: "Loads the bundled dictionary with include_bytes!, not through load_pack" },
      { path: "crates/spell/src/hyphen.rs", line: 118, text: "Handles the nonstandard cases the pack lacks (ccs, ggy)" },
      { path: "data/hu/hyph.dic", line: 1, text: "270,112 lines of pattern data, identical in 31 of 45 pattern groups to craft-i18n" },
    ],
    costUsd: 0.92,
  }),
  earlier: [
    review({ id: "r3", head: "e6a09b1", at: at(2 * D), trigger: "operator", why: "An operator asked for another look after the contributor pushed the lint fix", verdict: "take-fix", summary: "Same code, clippy warnings fixed. Still asks to load the pack instead of bundling the data.", fixes: ["Use load_pack for the dictionary"], costUsd: 0.88 }),
    review({ id: "r2", head: "b72c4d8", at: at(3 * D + 4 * H), trigger: "new-head", why: "Two new commits since the last review: the hyphenation tests and a rename", verdict: "take-fix", summary: "The hyphenation tests cover the nonstandard cases. The dictionary is still bundled.", fixes: ["Use load_pack for the dictionary", "Rename hu_spell to hungarian"], costUsd: 0.74 }),
    review({ id: "r1", head: "5d19f03", at: at(4 * D + 2 * H), trigger: "new-head", why: "First review of the pull request", verdict: "hold", sure: false, summary: "Large data addition with no tests. Asks for tests and for a check against the language pack.", fixes: ["Add tests for the three nonstandard hyphenation cases"], risks: ["No tests"], costUsd: 1.1 }),
  ],
};

const REVIEWS_9981: { latest: OpusReviewEntry; earlier: OpusReviewEntry[] } = {
  latest: review({
    id: "q2", head: "a1b2c3d", current: true, at: at(95), trigger: "new-head", why: "A fix-up pushed a1b2c3d, a delta review against the last one", verdict: "take",
    summary: "Handles now use the layer transform, and the skew case kiri-n raised is clamped. No regressions found in the tool code.",
    claims: [{ path: "crates/crop/src/handles.rs", line: 212, text: "Applies the inverse layer transform before hit testing" }, { path: "crates/crop/src/skew.rs", line: 33, text: "Clamps skew to +/- 80 degrees" }],
    costUsd: 0.8,
  }),
  earlier: [review({ id: "q1", head: "7c1d5ee", at: at(4 * H), trigger: "new-head", why: "First review of the pull request", verdict: "take-fix", summary: "The fix is right for rotation but breaks on skewed layers.", fixes: ["Clamp skew"], costUsd: 1.9 })],
};

const hist = (id: string, minAgo: number, step: string, outcome: string, model: string | null, costUsd: number | null, kind: HistoryEntry["kind"] = "model", calls: HistoryEntry["calls"] = [], writeId: string | null = null): HistoryEntry => ({ id, at: at(minAgo), step, outcome, model, costUsd, kind, calls, writeId });

const HISTORY_1484: HistoryEntry[] = [
  hist("h1", 4 * D + 3 * H, "Classify", "missing feature, three of three agree", "Jev", 0.0, "model"),
  hist("h2", 4 * D + 2 * H, "Review", "Hold, unsure", "Opus", 1.1, "model", [{ label: "Read crates/spell/src/hu.rs", kind: "tool", costUsd: null }, { label: "Read data/hu/hyph.dic", kind: "tool", costUsd: null }, { label: "Opus, 38k tokens", via: { login: "kiri-n", harness: "claude", model: "claude-opus-4-5" }, kind: "model", costUsd: 1.1 }]),
  hist("h3", 4 * D + 2 * H - 4, "Posted review on GitHub", "Review comment created", null, null, "write", [], "h3"),
  hist("h4", 3 * D + 4 * H, "Review", "Take with fixes, new head b72c4d8", "Opus", 0.74, "model", [{ label: "Read crates/spell/tests/hyphen.rs", kind: "tool", costUsd: null }, { label: "Opus, 29k tokens", kind: "model", costUsd: 0.74 }]),
  hist("h5", 3 * D + 4 * H - 3, "Edited review on GitHub", "Review comment updated", null, null, "write", [], "h5"),
  hist("h6", 2 * D, "Review", "Take with fixes, head e6a09b1", "Opus", 0.88, "model", [{ label: "Opus, 31k tokens", kind: "model", costUsd: 0.88 }]),
  hist("h7", 5 * H + 30, "Review", "Take, unsure", "Opus", 0.92, "model", [{ label: "Read crates/spell/src/hu.rs", kind: "tool", costUsd: null }, { label: "Opus, 33k tokens", kind: "model", costUsd: 0.92 }]),
  hist("h8", 5 * H + 20, "Edited review on GitHub", "Review comment updated", null, null, "write", [], "h8"),
  hist("h9", 5 * H, "Recommendation written", "Merge parts 1 and 3, and move the dictionary to a follow-up issue?", "Opus", 0.31, "decision", [{ label: "Opus, 12k tokens", kind: "model", costUsd: 0.31 }]),
];

const RESULTS_1484: ResultCard[] = [
  { id: "c1", kind: "verify", title: "Verify", outcome: "Passed on e6a09b1", tone: "ok", at: at(2 * D), detail: "cargo test -p spell: 41 passed.", earlier: [{ at: at(3 * D + 4 * H), outcome: "Passed on b72c4d8" }] },
  { id: "c2", kind: "classifiers", title: "Classifiers", outcome: "Missing feature, 3 of 3 agree", tone: "neutral", at: at(4 * D + 3 * H), detail: null, earlier: [] },
  { id: "c3", kind: "duplicates", title: "Duplicates and links", outcome: "Related: craft-i18n#88, designcraft#1391", tone: "neutral", at: at(4 * D + 3 * H), detail: null, earlier: [] },
  { id: "c4", kind: "patch-checks", title: "Patch checks", outcome: "Opus approved round 2", tone: "ok", at: at(2 * D + 20), detail: "Round 1 rejected: the test does not cover the ccs case.", earlier: [{ at: at(2 * D + 50), outcome: "Round 1 rejected" }] },
  { id: "c5", kind: "actions", title: "Actions", outcome: "Comment posted, not closed", tone: "neutral", at: at(5 * H + 10), detail: "rhea-m answered: wait for the language pack.", earlier: [] },
  { id: "c6", kind: "postmerge", title: "Post-merge review", outcome: "1 follow-up opened", tone: "warn", at: at(95), detail: "Earlier merge of the pack loader left a stale cache path.", earlier: [], followups: [{ repo: "designcraft", number: 1490 }, { repo: "craft-i18n", number: 91 }] },
];

const gh = (id: string, type: GithubEvent["type"], minAgo: number, actor: string, body: string | null, autocraft: GithubEvent["autocraft"] = null): GithubEvent => ({ id, type, at: at(minAgo), actor, body, autocraft });
const AC_APP = "kiri-n via the App";

const GITHUB_1484: GithubSide = {
  syncedAt: at(1),
  description: "Adds Hungarian spellchecking and the nonstandard hyphenation cases (ccs, ggy, sz+sz) that the pattern file lacks.\n\nThe dictionary and the pattern file come from the Magyar Ispell project under its permissive licence.",
  url: "https://github.com/storytold/designcraft/pull/1484",
  events: [
    gh("g1", "opened", 4 * D + 5 * H, "rhea-m", "Adds Hungarian spellchecking and the nonstandard hyphenation cases."),
    gh("g2", "review", 4 * D + 2 * H - 4, "autocraft", "**Review of 5d19f03: Not ready.** Large data addition with no tests. Asks for tests and a check against the language pack in craft-i18n.\n\nOpus, not sure.", { as: AC_APP, historyId: "h3" }),
    gh("g3", "push", 3 * D + 6 * H, "rhea-m", "Pushed 2 commits: hyphenation tests, rename hu_spell to hungarian"),
    gh("g4", "review", 3 * D + 4 * H - 3, "autocraft", "(edited) **Review of b72c4d8: Take with fixes.** The tests cover the nonstandard cases. Use load_pack for the dictionary.", { as: AC_APP, historyId: "h5" }),
    gh("g5", "comment", 150, "kiri-n", "The pack is the better source; I checked that the patterns match."),
    gh("g6", "comment", 14, "mosswood", "@autocraft the pack does load, I checked it against `load_pack`. Could you review again, the earlier finding no longer applies?"),
    gh("g7", "review", 5 * H + 20, "autocraft", "(edited) **Review of e6a09b1: Take, unsure.** About 270,000 of the added lines are data the language pack already ships.", { as: AC_APP, historyId: "h8" }),
  ],
  checks: [{ name: "build (linux)", state: "passing" }, { name: "build (macos)", state: "passing" }, { name: "test", state: "passing" }, { name: "clippy", state: "passing" }, { name: "fmt", state: "passing" }],
  commits: [
    { sha: "5d19f03", message: "Add Hungarian dictionary and spellchecker", author: "rhea-m", at: at(4 * D + 5 * H), byAutoCraft: false },
    { sha: "9a41e07", message: "Hyphenation tests for ccs, ggy and sz+sz", author: "rhea-m", at: at(3 * D + 6 * H), byAutoCraft: false },
    { sha: "b72c4d8", message: "Rename hu_spell to hungarian", author: "rhea-m", at: at(3 * D + 6 * H), byAutoCraft: false },
    { sha: "e6a09b1", message: "Fix clippy warnings", author: "rhea-m", at: at(2 * D + 2 * H), byAutoCraft: false },
  ],
  files: [{ path: "data/hu/hyph.dic", additions: 270112, deletions: 0 }, { path: "data/hu/hu.dic", additions: 291, deletions: 0 }, { path: "crates/spell/src/hu.rs", additions: 96, deletions: 12 }, { path: "crates/spell/src/hyphen.rs", additions: 188, deletions: 84 }],
};

// ---- photocraft#9981: in queue, waiting for CI ----
const HISTORY_9981: HistoryEntry[] = [
  hist("h1", 5 * H, "Classify", "bug fix, three of three agree", "Jev", 0, "model"),
  hist("h2", 4 * H, "Review", "Take with fixes", "Opus", 1.9, "model", [{ label: "Read crates/crop/src/handles.rs", kind: "tool", costUsd: null }, { label: "Opus, 52k tokens", kind: "model", costUsd: 1.9 }]),
  hist("h3", 4 * H - 3, "Posted review on GitHub", "Review comment created", null, null, "write", [], "h3"),
  hist("h4", 2 * H + 20, "Fix-up", "Pushed a1b2c3d: clamp skew", "Sonnet", 1.4, "model", [{ label: "Edit crates/crop/src/skew.rs", kind: "tool", costUsd: null }, { label: "cargo test -p crop", kind: "tool", costUsd: null }, { label: "Sonnet, 41k tokens", kind: "model", costUsd: 1.4 }]),
  hist("h5", 2 * H + 18, "Pushed 1 commit", "a1b2c3d to the contributor's branch", null, null, "write", [], "h5"),
  hist("h6", 95, "Review", "Take", "Opus", 0.8, "model", [{ label: "Opus, 24k tokens", kind: "model", costUsd: 0.8 }]),
  hist("h7", 50, "Verify", "Passed on a1b2c3d", "Sonnet", 0.02, "model"),
  hist("h8", 46, "Queued", "In batch #41, waiting for CI", null, null, "event"),
];
const GITHUB_9981: GithubSide = {
  syncedAt: at(1),
  description: "Crop handles drift when the layer is rotated. They are placed with the unrotated bounds.\n\nFixes #9940.",
  url: "https://github.com/storytold/photocraft/pull/9981",
  events: [
    gh("g1", "opened", 6 * H, "dana-k", "Crop handles drift when the layer is rotated."),
    gh("g2", "review", 4 * H - 3, "autocraft", "**Review of 7c1d5ee: Take with fixes.** The fix is right for rotation but breaks on skewed layers.", { as: "box account", historyId: "h3" }),
    gh("g3", "comment", 3 * H, "kiri-n", "Can we also cover skew?"),
    gh("g4", "push", 2 * H + 18, "autocraft", "Pushed 1 commit: fix-up: clamp skew (a1b2c3d)", { as: "box account", historyId: "h5" }),
  ],
  checks: [{ name: "build", state: "passing" }, { name: "test", state: "pending" }, { name: "clippy", state: "passing" }, { name: "fmt", state: "passing" }, { name: "wasm", state: "passing" }, { name: "docs", state: "passing" }, { name: "e2e", state: "passing" }],
  commits: [{ sha: "7c1d5ee", message: "Use the layer transform for crop handles", author: "dana-k", at: at(6 * H), byAutoCraft: false }, { sha: "a1b2c3d", message: "fix-up: clamp skew", author: "autocraft", at: at(2 * H + 18), byAutoCraft: true }],
  files: [{ path: "crates/crop/src/handles.rs", additions: 38, deletions: 11 }, { path: "crates/crop/src/skew.rs", additions: 14, deletions: 2 }],
};

// ---- wordcraft#2214: an issue AutoCraft is fixing ----
const HISTORY_2214: HistoryEntry[] = [
  hist("h1", 3 * H, "Classify", "bug, three of three agree", "Jev", 0, "model"),
  hist("h2", 3 * H - 10, "Assigned", "Assigned to autocraft", null, null, "write", [], "h2"),
  hist("h3a", 3 * H, "Implementation attempt 1", "Started, queued by ochre-fox", null, null, "event"),
  hist("h3b", 2 * H + 58, "Plan", "Planned the change (bugfix, size S)", "Opus", 0.84, "model", [{ label: "Plan (opus)", kind: "model", costUsd: 0.84, runId: 5120 }]),
  hist("h3c", 2 * H + 50, "Implementation session", "Done, 48 tool calls, 6 min in the shell", "Opus", 1.92, "model", [{ label: "Implementation session (opus)", kind: "model", costUsd: 1.92, runId: 5131 }, { label: "48 workspace tool calls", kind: "tool", costUsd: null }]),
  hist("h3d", 2 * H + 40, "Checks, round 1", "1 finding (1 file changed, 24 insertions, 3 deletions)", null, null, "event"),
  hist("h3e", 2 * H + 35, "Follow-up turn on the checks' findings", "Done, 6 tool calls", "Opus", 0.21, "model", [{ label: "Follow-up turn on the checks' findings (opus)", kind: "model", costUsd: 0.21, runId: 5140 }]),
  hist("h3", 2 * H + 30, "Checks, round 2", "Clean (2 files changed, 61 insertions, 3 deletions)", null, null, "event"),
  hist("h4", 2 * H + 25, "Opened pull request", "wordcraft#2231", null, null, "write", [], "h4"),
  hist("h5", 100, "Review of the patch", "Take with fixes: the link rect ignores the last line's descent", "Opus", 0.7, "model"),
  hist("h6", 70, "Fix-up", "Round 2 started on wordcraft#2231", "Sonnet", null, "model", [{ label: "Edit crates/export/src/pdf/links.rs", kind: "tool", costUsd: null }]),
];
const IMPL_2214: ItemImplementation = {
  id: 41, attempt: 1, attempts: 1, state: "pr-opened", queuedBy: "ochre-fox", createdAt: at(3 * H), updatedAt: at(2 * H + 25), reason: null,
  plan: {
    ready: true, kind: "bugfix", size: "S", summary: "The PDF writer closes the link annotation before the last line box of a paragraph is laid out, so a link that ends the paragraph gets no rectangle.",
    markdown: "1. Reproduce with a paragraph whose last run is a link; export and read the annotations back.\n2. In `crates/export/src/pdf/links.rs`, emit the pending link rect after the final line box, not at the paragraph break.\n3. Add a regression test that exports such a paragraph and asserts one `/Link` annotation covering the last words.",
    acceptance: ["A paragraph that ends with a hyperlink exports a clickable link area over the link text", "Links in the middle of a paragraph keep their current rectangles"],
    tests: ["cargo test -p export pdf_links"], app: "Export a document with a trailing link and click it in the PDF viewer", risks: ["Multi-line links that wrap onto the last line"],
  },
  questions: [],
  calls: [
    { at: at(2 * H + 58), purpose: "plan", outcome: "done", status: null, summary: "Ready: one file, a regression test in the export crate.", error: null, turns: null, toolCalls: 0, shellMs: 0, costUsd: 0.84, runId: 5120, via: { login: "ochre-fox", harness: "claude-code", model: "opus" } },
    { at: at(2 * H + 50), purpose: "start", outcome: "done", status: "done", summary: "Moved the link rect flush after the last line box and added `trailing_link_gets_annotation`.", error: null, turns: 31, toolCalls: 48, shellMs: 6 * 60_000, costUsd: 1.92, runId: 5131, via: { login: "ochre-fox", harness: "claude-code", model: "opus" } },
    { at: at(2 * H + 35), purpose: "findings", outcome: "done", status: "done", summary: "Fixed the clippy finding: the rect is built with `Rect::from_points`.", error: null, turns: 4, toolCalls: 6, shellMs: 90_000, costUsd: 0.21, runId: 5140, via: { login: "ochre-fox", harness: "claude-code", model: "opus" } },
  ],
  checks: [
    { at: at(2 * H + 40), round: 1, diffStat: "1 file changed, 24 insertions(+), 3 deletions(-)", crates: ["export"], fmt: { ran: true, exit: 0, findings: 0, noVerdict: false, note: null }, clippy: { ran: true, exit: 0, findings: 1, noVerdict: false, note: null }, tests: { ran: true, exit: 0, findings: 0, noVerdict: false, note: null }, clean: false,
      findings: [{ check: "clippy", file: "crates/export/src/pdf/links.rs", line: 142, message: "manual construction of a rectangle from two points" }], notes: [] },
    { at: at(2 * H + 30), round: 2, diffStat: "2 files changed, 61 insertions(+), 3 deletions(-)", crates: ["export"], fmt: { ran: true, exit: 0, findings: 0, noVerdict: false, note: null }, clippy: { ran: true, exit: 0, findings: 0, noVerdict: false, note: null }, tests: { ran: true, exit: 0, findings: 0, noVerdict: false, note: null }, clean: true, findings: [], notes: [] },
  ],
  diffStat: "2 files changed, 61 insertions(+), 3 deletions(-)",
  pr: { repo: "wordcraft", number: 2231, kind: "pr", state: "open", title: "Keep the hyperlink run when exporting the last paragraph", url: "https://github.com/storytold/wordcraft/pull/2231" },
  shots: [{ n: 1, what: "Exported PDF with the trailing link selected", url: "/api/implementations/41/shots/0123456789abcdef0123456789abcdef.png", width: 640, height: 400 }],
  costUsd: 2.97,
};
const GITHUB_2214: GithubSide = {
  syncedAt: at(1),
  description: "When a paragraph ends with a hyperlink, the exported PDF has the text but the link area is missing.\n\nSteps: type a paragraph, make the last words a link, export to PDF, click the link in a viewer.",
  url: "https://github.com/storytold/wordcraft/issues/2214",
  events: [
    gh("g1", "opened", 6 * H, "linnea-w", "When a paragraph ends with a hyperlink, the exported PDF has the text but no link area."),
    gh("g2", "label", 3 * H - 10, "autocraft", "assigned autocraft and added label bug", { as: AC_APP, historyId: "h2" }),
    gh("g3", "comment", 2 * H + 25, "autocraft", "Opened wordcraft#2231 with a fix. A reviewer is checking it.", { as: AC_APP, historyId: "h4" }),
  ],
  checks: [], commits: [], files: [],
};

// ---- The chat mock's items (chatMock.ts tells the same story) ----
const BOT = "AutoCraft Bot";
const GITHUB_812: GithubSide = {
  syncedAt: at(1),
  description: "The crop handles can be dragged past the canvas edge and then snap back on release. This clamps them while dragging.\n\nFixes #790.",
  url: "https://github.com/storytold/photocraft/pull/812",
  events: [
    gh("g1", "opened", 26 * H, "larkspur-dev", "The crop handles can be dragged past the canvas edge. This clamps them while dragging."),
    gh("g2", "review", 295, "autocraft", "**Review of 4e1a2b7: take with two fixes.**\n\n1. Handles still snap past the edge below 100 % zoom (`crates/crop/src/handles.rs:142`).\n2. No test covers the clamped position.", { as: BOT, historyId: "h1" }),
    gh("g3", "comment", 270, "kiri-n", "Nice catch on the zoom case, I hit that last week."),
    gh("g4", "comment", 262, "larkspur-dev", "Thanks! Happy for the fixes to go in on my branch."),
    gh("g5", "comment", 241, "ochre-fox", "@autocraft yes"),
    gh("g6", "push", 239, "autocraft", "Pushed 1 commit: clamp in canvas units, test the clamped position (9c0d3e1)", { as: BOT, historyId: "h2" }),
    gh("g7", "push", 231, "autocraft", "Pushed 1 commit: fix clippy::manual_clamp (a7f2c10)", { as: BOT, historyId: "h3" }),
    gh("g8", "merged", 219, "autocraft", "Merged into main (approved by ochre-fox)", { as: "ochre-fox via the App", historyId: "h4" }),
  ],
  checks: [{ name: "build", state: "passing" }, { name: "test", state: "passing" }, { name: "clippy", state: "passing" }, { name: "fmt", state: "passing" }, { name: "wasm", state: "passing" }],
  commits: [
    { sha: "4e1a2b7", message: "Clamp crop handles to the canvas while dragging", author: "larkspur-dev", at: at(26 * H), byAutoCraft: false },
    { sha: "9c0d3e1", message: "Clamp in canvas units; test the clamped position", author: "autocraft", at: at(239), byAutoCraft: true },
    { sha: "a7f2c10", message: "Fix clippy::manual_clamp", author: "autocraft", at: at(231), byAutoCraft: true },
  ],
  files: [{ path: "crates/crop/src/handles.rs", additions: 31, deletions: 9 }, { path: "crates/crop/tests/handles.rs", additions: 44, deletions: 0 }],
};
const GITHUB_455: GithubSide = {
  syncedAt: at(1),
  description: "Hidden layers were still offered as snap targets. This filters them out and renames `SnapSource` to `SnapTarget` (#430).",
  url: "https://github.com/storytold/designcraft/pull/455",
  events: [
    gh("g1", "opened", 2 * D, "sable-ui", "Hidden layers were still offered as snap targets. This filters them out and renames SnapSource to SnapTarget (#430)."),
    gh("g2", "comment", 185, "kiri-n", "@autocraft review this, and check that locked layers still snap."),
    gh("g3", "review", 176, "autocraft", "**Review of 2c9e4f1: take with one fix.** Locked layers still snap. Hidden layers inside a hidden group are still offered as snap targets (`crates/snap/src/targets.rs:57`).", { as: BOT, historyId: "h1" }),
    gh("g4", "comment", 120, "sable-ui", "The SnapSource → SnapTarget rename was asked for in #430, that's why it's in here."),
    gh("g5", "comment", 26, "kiri-n", "@autocraft merge after the 2.4 release"),
    gh("g6", "comment", 26, "autocraft", "I understood **merge**, but not “after the 2.4 release”: I can't wait for a release. Nothing runs until the instruction is clear.", { as: BOT, historyId: "h2" }),
  ],
  checks: [{ name: "build (linux)", state: "passing" }, { name: "build (macos)", state: "passing" }, { name: "test", state: "passing" }, { name: "clippy", state: "passing" }, { name: "fmt", state: "passing" }, { name: "wasm", state: "passing" }],
  commits: [{ sha: "2c9e4f1", message: "Skip hidden layers as snap targets; rename SnapSource", author: "sable-ui", at: at(2 * D), byAutoCraft: false }],
  files: [{ path: "crates/snap/src/targets.rs", additions: 22, deletions: 6 }, { path: "crates/snap/tests/targets.rs", additions: 30, deletions: 0 }, { path: "crates/snap/src/lib.rs and 12 more (rename)", additions: 61, deletions: 61 }],
};
const GITHUB_77: GithubSide = {
  syncedAt: at(1),
  description: "Speaker notes are lost on export. PDF export should be able to include them, and PPTX export should keep them.",
  url: "https://github.com/storytold/deckcraft/issues/77",
  events: [
    gh("g1", "opened", 3 * D, "brushstroke42", "Speaker notes are lost on export."),
    gh("g2", "comment", 2 * D, "quietgrid", "Would love this for conference talks."),
    gh("g3", "label", 95, "autocraft", "assigned autocraft and added label enhancement", { as: BOT, historyId: "h1" }),
    gh("g4", "comment", 74, "brushstroke42", "Notes should use the slide's font if possible."),
  ],
  checks: [], commits: [], files: [],
};
const chatHistory = (outcome: string): HistoryEntry[] => [hist("h1", 300, "Conversation", outcome, null, null, "event")];

// ---- photocraft#9970: merged ----
const HISTORY_9970: HistoryEntry[] = [
  hist("h1", 2 * D, "Review", "Take", "Opus", 0.9, "model"),
  hist("h2", 3 * H, "Verify", "Passed", "Sonnet", 0.02, "model"),
  hist("h3", 100, "Merged", "In batch #40, merge commit 4f8a21c", null, null, "write", [], "h3"),
  hist("h4", 95, "Post-merge review", "No issues found", "Opus", 0.6, "model"),
];
const tl = (id: string, minAgo: number, kind: TimelineEntry["kind"], actor: string, icon: TimelineEntry["icon"], text: string, o: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id, at: at(minAgo), kind, actor, icon, text, tone: "neutral", costUsd: null, major: true, jobId: null, reviewId: null, githubId: null, commit: null, preapproval: null, calls: [], body: null, markdown: false, lines: [], ...o,
});
/** Two follow-up issues held until the merge: one dropped when its Merge answer was taken back, one opened after the merge. */
const HELD_9970: TimelineEntry[] = [
  tl("held:1", 2 * D - 30, "person", "aiongg", "person", "After the merge: open an issue in photocraft", { body: "Clamp the handles in the curve preview too" }),
  tl("held:1:end", 2 * D - 50, "harness", "AutoCraft", "github", "Held issue dropped: the Merge answer was taken back", { tone: "warn" }),
  tl("held:2", 3 * H - 10, "person", "aiongg", "person", "After the merge: open an issue in photocraft", { body: "Share the plot clamp with the levels editor" }),
  tl("audit:held-2", 99, "harness", "AutoCraft", "github", "Opened issue: photocraft#9984 Share the plot clamp with the levels editor", { githubId: "audit:held-2", tone: "ok", major: false }),
];
const GITHUB_9970: GithubSide = {
  syncedAt: at(1),
  description: "Keeps the endpoint handles inside the plot area when the curve is steep.",
  url: "https://github.com/storytold/photocraft/pull/9970",
  events: [
    gh("g1", "opened", 2 * D + 4 * H, "hollowbrook", "Keeps the endpoint handles inside the plot area."),
    gh("g2", "merged", 100, "autocraft", "Merged in integration batch #40 (merge commit 4f8a21c).", { as: AC_APP, historyId: "h3" }),
  ],
  checks: [{ name: "build", state: "passing" }, { name: "test", state: "passing" }],
  commits: [{ sha: "c04d9be", message: "Clamp curve handles", author: "hollowbrook", at: at(2 * D + 4 * H), byAutoCraft: false }],
  files: [{ path: "crates/curves/src/plot.rs", additions: 21, deletions: 6 }],
};

const total = (h: HistoryEntry[]) => Math.round(h.reduce((s, e) => s + (e.costUsd ?? 0), 0) * 100) / 100;

const RESULTS_9981: ResultCard[] = [
  { id: "c1", kind: "verify", title: "Verify", outcome: "Passed on a1b2c3d", tone: "ok", at: at(50), detail: "cargo test -p crop: 18 passed.", earlier: [] },
  { id: "c2", kind: "fixup", title: "Fix-ups", outcome: "1 try, kept green", tone: "ok", at: at(2 * H + 20), detail: "clamp skew, pushed a1b2c3d", earlier: [] },
  { id: "c3", kind: "classifiers", title: "Classifiers", outcome: "Bug fix, 3 of 3 agree", tone: "neutral", at: at(5 * H), detail: null, earlier: [] },
];

const SCREENSHOTS_9981: ScreenshotRun = {
  head: "a1b2c3d", current: true, state: "compared", verdict: "regression", clear: true, held: true, model: "opus", at: at(52), reason: null,
  comparison: "The handles now sit outside the layer outline and the right-hand handle is clipped by the canvas edge; before, all eight handles were inside it.",
  shots: [
    { name: "s1.png", before: { taskId: 901, name: "s1.png" }, after: { taskId: 902, name: "s1.png" } },
    { name: "s2.png", before: { taskId: 901, name: "s2.png" }, after: { taskId: 902, name: "s2.png" } },
  ],
};

const FULL: Record<string, Omit<MockPage, "repo" | "number" | "kind" | "state" | "draft" | "title" | "author" | "status" | "costUsd" | "stamp" | "header" | "bar"> & { header?: Partial<ItemPageHeader>; draft?: boolean }> = {
  "photocraft#812": { reviews: { latest: null, earlier: [] }, results: [], history: chatHistory("merged"), github: GITHUB_812 },
  "designcraft#455": { draft: true, reviews: { latest: null, earlier: [] }, results: [], history: chatHistory("waiting for an answer"), github: GITHUB_455 },
  "deckcraft#77": { reviews: { latest: null, earlier: [] }, results: [], history: chatHistory("implementing"), github: GITHUB_77 },
  "designcraft#1484": { prBuild: { headSha: "9f3a1c2", current: true, state: "failed", summary: "test failed with exit code 101", disagree: true, ci: "success", createdAt: at(80), finishedAt: at(35) }, header: HEADER_1484, reviews: REVIEWS_1484, results: RESULTS_1484, history: HISTORY_1484, github: GITHUB_1484 },
  "photocraft#9981": { prBuild: { headSha: "b51e7d0", current: true, state: "running", summary: null, disagree: false, ci: "pending", createdAt: at(12), finishedAt: null }, reviews: REVIEWS_9981, results: RESULTS_9981, history: HISTORY_9981, github: GITHUB_9981, screenshots: [SCREENSHOTS_9981] },
  "wordcraft#2214": {
    reviews: { latest: null, earlier: [] },
    results: [
      { id: "c1", kind: "fixup", title: "Fix-ups", outcome: "Round 2 of 3 running", tone: "accent", at: at(70), detail: "Round 1: review asked to cover the last line's descent.", earlier: [{ at: at(100), outcome: "Round 1 pushed, review wants changes" }] },
      { id: "c2", kind: "classifiers", title: "Classifiers", outcome: "Bug, 3 of 3 agree", tone: "neutral", at: at(3 * H), detail: null, earlier: [] },
    ],
    history: HISTORY_2214, github: GITHUB_2214, implementation: IMPL_2214,
  },
  "photocraft#9970": {
    reviews: { latest: review({ id: "m1", head: "c04d9be", current: true, at: at(2 * D), trigger: "new-head", why: "First review of the pull request", verdict: "take", summary: "Clamps the handles to the plot rectangle. Small and covered by a test.", claims: [{ path: "crates/curves/src/plot.rs", line: 88, text: "t is already normalised here" }], costUsd: 0.9 }), earlier: [] },
    results: [
      { id: "c1", kind: "postmerge", title: "Post-merge review", outcome: "No issues found", tone: "ok", at: at(95), detail: null, earlier: [] },
      { id: "c2", kind: "verify", title: "Verify", outcome: "Passed", tone: "ok", at: at(3 * H), detail: null, earlier: [] },
    ],
    history: HISTORY_9970, github: GITHUB_9970, extra: HELD_9970,
  },
};

/** The item page payload: curated items in full, others from the list row with an empty history. */
export function itemPageFor(repo: string, number: number): ItemPageData | null {
  const s = seeds.find((x) => x.repo === repo && x.number === number);
  if (!s) return null;
  const full = FULL[`${repo}#${number}`];
  const base = { repo, number, kind: s.kind, state: s.state, draft: false, title: s.title, author: s.author, status: s.status, bar: BARS[`${repo}#${number}`] ?? barFromStatus(s.status), stamp: "mock", header: { ...mockHeader(s.kind), ...full?.header } };
  if (full) return withTimeline({ ...base, ...full, header: base.header, costUsd: total(full.history) });
  const history = [hist("h1", s.updated + 20, "Classify", "classified", "Jev", 0), hist("h2", s.updated, s.status.phase, s.status.waiting ?? "done", null, null, "event")];
  return withTimeline({
    ...base, reviews: { latest: null, earlier: [] }, results: [{ id: "c1", kind: "classifiers", title: "Classifiers", outcome: "3 of 3 agree", tone: "neutral", at: at(s.updated + 20), detail: null, earlier: [] }], history, costUsd: 0,
    github: { description: s.title, url: `https://github.com/storytold/${repo}/${s.kind === "pr" ? "pull" : "issues"}/${number}`, events: [gh("g1", "opened", s.updated + 60, s.author, s.title)], checks: [], commits: [], files: [], syncedAt: at(3) },
  });
}

export const FIX_ROUNDS_11: FixRound[] = [
  { round: 1, outcome: "failed", why: "The patch does not compile: fs::metadata returns a Result that is not handled.", at: at(3 * H), costUsd: 1.84 },
  { round: 2, outcome: "failed", why: "Opus review: the check runs after the path is opened, so the defect remains.", at: at(2 * H), costUsd: 2.1 },
  { round: 3, outcome: "failed", why: "The regression test passes without the fix, so it does not show the defect.", at: at(40), costUsd: 2.4 },
];

/** A fix that failed twice and passed on the third round. */
export const FIX_ROUNDS_4: FixRound[] = [
  { round: 1, outcome: "failed", why: "The new test did not run: the module is not part of the test target.", at: at(2 * D), costUsd: 1.52 },
  { round: 2, outcome: "failed", why: "Opus review: redirects to the same host are still refused, which breaks updates behind a proxy.", at: at(2 * D - 50), costUsd: 1.97 },
  { round: 3, outcome: "passed", why: "The regression test fails before the fix and passes after; Opus review found nothing.", at: at(3 * H), costUsd: 2.05 },
];

export const FINDING_HISTORY_11: HistoryEntry[] = [
  hist("f1", 9 * D, "Deep scan", "Found in scan 1, area ipc", "Opus", 1.34, "model"),
  hist("f2", 9 * D - 40, "Verification", "Reasoning confirms, score 8", "Opus", 0.61, "model"),
  hist("f3", 3 * H + 10, "Fix started", "Pressed by ochre-fox", null, null, "decision"),
  hist("f4", 3 * H, "Fix round 1", "Failed: patch does not compile", "Opus", 1.84, "model", [{ label: "Edit crates/ipc/src/recent.rs", kind: "tool", costUsd: null }, { label: "cargo check", kind: "tool", costUsd: null }, { label: "Opus, 44k tokens", kind: "model", costUsd: 1.84 }]),
  hist("f5", 2 * H, "Fix round 2", "Failed: review says the check runs too late", "Opus", 2.1, "model", [{ label: "Opus, 51k tokens", kind: "model", costUsd: 2.1 }]),
  hist("f6", 40, "Fix round 3", "Failed: regression test passes without the fix", "Opus", 2.4, "model", [{ label: "Opus, 55k tokens", kind: "model", costUsd: 2.4 }]),
  hist("f7", 40, "Gave up", "Back to a decision for a person", null, null, "event"),
];
