// The comments the act step posts. Fixed templates: the only variable parts
// are a cleaned one-line reason and a duplicate reference. No Node imports:
// the Prompts page lists these through src/prompts.
import type { CommentTemplate } from "../../web/src/api/types.ts";
import { withNote } from "../github/note.ts";
import { recommendation, reviewBody } from "../review/post-template.ts";
import { scrubMarkdown } from "../review/public-text.ts";
import { slugOf } from "../owners.ts";

export const REASON_MAX = 200;

/** One plain line: no mentions, no URLs or Markdown links, cut to `max` (REASON_MAX by default). */
export function cleanReason(s: string | null | undefined, max = REASON_MAX): string | null {
  const t = scrubMarkdown((s ?? "").replace(/\s+/g, " "), (x) => x
    .replace(/(^|\n)[ \t>]*\[[^\]]*\]:[^\n]*/g, "$1")
    .replace(/!?\[([^[\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/!?\[([^[\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z!][^>]*>/gi, "")
    .replace(/<?(?<![A-Za-z0-9])(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]*>?/gi, "")
    .replace(/(^|\s)\/\/[^\s]*/g, "$1")
    .replace(/(?<![A-Za-z0-9])GH-(\d+)(?![A-Za-z0-9])/gi, "issue $1")
    .replace(/(?<![A-Za-z0-9/&])(?:[\w.-]+\/[\w.-]+)?#(\d+)(?![A-Za-z0-9])/g, "issue $1")
    .replace(/@/g, ""))
    .replace(/\s+/g, " ").trim();
  if (!t) return null;
  const cut = t.length > max ? cutAtBoundary(t, max) : t;
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
}

/** Cuts `t` to at most `max` characters: after the last sentence end that fits, else at the last word boundary with "…". Never inside a word. */
function cutAtBoundary(t: string, max: number): string {
  const head = t.slice(0, max);
  const ends = [...head.matchAll(/[.!?](?=\s|$)/g)];
  const last = ends.length ? ends[ends.length - 1]!.index! + 1 : 0;
  if (last >= Math.min(40, max / 2)) return head.slice(0, last);
  const room = t.slice(0, max - 1);
  // A word is whole when the next character is a space.
  const i = t[max - 1] === " " ? room.length : room.lastIndexOf(" ");
  const words = (i > 0 ? room.slice(0, i) : room).trimEnd().replace(/[,;:\-–]+$/, "");
  return `${words}…`;
}

/** `#n` in the same repo, else the full cross-repo reference. */
export function refText(from: string, ref: string): string {
  const m = /^([\w.-]+)#(\d+)$/.exec(ref.trim());
  if (!m) return "";
  return m[1] === from ? `#${m[2]}` : `${slugOf(m[1])}#${m[2]}`;
}

/** The comment before a person's close; `as` is the action's `close_as` (completed, not-planned, or none given). */
export function closeComment(o: { pr: boolean; as: string | null }): string {
  const how = o.as === "completed" ? " as completed" : o.as === "not-planned" ? " as not planned" : "";
  return `Closing this ${o.pr ? "pull request" : "issue"}${how}.`;
}

/** `original` is the canonical item's reference (`repo#n`); `closed` when it is no longer open. */
export function duplicateComment(o: { repo: string; original: string; closed: boolean }): string {
  return `Duplicate of ${refText(o.repo, o.original)}${o.closed ? ", which is closed" : ""}.`;
}

/** Fixes the comment to the author lists at most. */
export const AUTHOR_FIXES_SHOWN = 8;
const AUTHOR_SUMMARY_MAX = 600;
const AUTHOR_WORDS_MAX = 1000;

/**
 * The comment that asks a pull request's author to finish or fix it: a ping to them, what the review found (its public summary), the
 * fixes it lists by title and file, and the words of the person who asked (`from`, their login). Mentions of anyone else are removed.
 */
export function authorAskComment(o: { login: string | null; summary: string | null; fixes: readonly { title: string; file: string }[]; words: string | null; from: string | null; conflict?: string | null }): string {
  const plain = (x: string, max: number) => cleanReason(x.replace(/@/g, ""), max);
  const out = [o.login ? `@${o.login} this pull request needs more work before it can be merged.` : "This pull request needs more work before it can be merged."];
  const summary = o.summary ? plain(o.summary, AUTHOR_SUMMARY_MAX) : null;
  if (summary) out.push(summary);
  const base = o.conflict?.replace(/[`\s]/g, "");
  if (base) out.push(`It conflicts with \`${base}\`: merge \`${base}\` into this branch, or rebase it on \`${base}\`, and resolve the conflicts.`);
  const fixes = o.fixes.slice(0, AUTHOR_FIXES_SHOWN).flatMap((f) => { const title = plain(f.title, REASON_MAX); return title ? [`- ${title.replace(/\.$/, "")}${f.file ? ` (\`${f.file.replace(/`/g, "")}\`)` : ""}`] : []; });
  if (fixes.length) out.push(`What needs to change:\n${fixes.join("\n")}`);
  const words = o.words ? o.words.replace(/@(?=[\w-])/g, "").replace(/\s+/g, " ").trim().slice(0, AUTHOR_WORDS_MAX) : "";
  if (words) out.push(o.from ? `${o.from} adds: ${words}` : words);
  out.push("Push your changes to this branch, and the new commits are reviewed.");
  return out.join("\n\n");
}

export const COMMENT_TEMPLATES: CommentTemplate[] = [
  {
    id: "act.ask-author", stage: "Act",
    purpose: "Posted once when a maintainer tells AutoCraft to ask a pull request's author for more work, or when the review of a started pull request finds it incomplete or wrong. The pull request then waits for the author's push.",
    text: authorAskComment({ login: "{{author}}", summary: "{{summary}}", fixes: [{ title: "{{fix}}", file: "{{file}}" }], words: "{{words}}", from: "{{maintainer}}", conflict: "{{base}}" }),
    placeholders: [
      { name: "author", meaning: "The pull request's author" },
      { name: "summary", meaning: "The review's public summary, as it passed the review's reply checks, cleaned to one line (mentions, links and HTML removed, at most 600 characters)" },
      { name: "base", meaning: "The base branch, when the pull request conflicts with it" },
      { name: "fix, file", meaning: "Each fix the review lists that nobody dropped, by its title (as it passed the review's reply checks) and file; at most 8" },
      { name: "maintainer, words", meaning: "The maintainer who asked and their own words after ask author, when they wrote any; mentions removed" },
    ],
    example: authorAskComment({ login: "octo-dev", summary: "Most of the described tab UI is never wired in: the group pill and the group editor have no caller.", fixes: [{ title: "Wire the group editor into the tab bar", file: "src/tabs/bar.rs" }], words: "Please also cover split panes in close-other.", from: "mira" }),
  },
  {
    id: "act.close", stage: "Act",
    purpose: "Posted when a maintainer tells AutoCraft to close an issue or a pull request, just before the close, which is made as that maintainer.",
    text: "Closing this {{kind}}{{reason}}.",
    placeholders: [
      { name: "kind", meaning: "issue or pull request" },
      { name: "reason", meaning: "\" as completed\" or \" as not planned\" when the command gave that reason, else nothing" },
    ],
    example: closeComment({ pr: false, as: "not-planned" }),
  },
  {
    id: "act.duplicate", stage: "Act",
    purpose: "Posted when a maintainer tells AutoCraft to close an item as a duplicate, just before the close, which is made as that maintainer.",
    text: duplicateComment({ repo: "app", original: "app#{{original}}", closed: false }),
    placeholders: [
      { name: "original", meaning: "The number of the item that stays, in the same repo; another repo's item is written as org/repo#N" },
      { name: "closed", meaning: "When the original is no longer open on GitHub at the time of the comment, \", which is closed\" follows the number" },
    ],
    example: duplicateComment({ repo: "app", original: "app#12", closed: true }),
  },
  {
    id: "review.post", stage: "Review",
    purpose: "Posted as a pull request review (event Comment, never an approval or a change request) on a pull request with a final Opus review at its current head. A later review at a new head edits this review instead of adding another.",
    text: withNote({ by: "model", kind: "review", model: "{{model}}" }, reviewBody({ verdict: "take-fix", sure: true, summary: "{{summary}}", points: ["{{point}}"], head: "{{head}}", recommendation: "{{recommendation}}" })),
    placeholders: [
      { name: "model", meaning: "The model that wrote the review, as a name and version (Opus 5.5)" },
      { name: "verdict", meaning: "By verdict: take \"No blocking problems found.\", take-fix \"Small fixes needed:\", hold \"Changes needed:\", close \"Significant problems found:\"; \" (not certain)\" goes before the final colon or full stop when the model was unsure. After our own checked fix-up of a take-fix review, the take-fix line reads \"Small fixes needed, made in <fix-up commit>:\"" },
      { name: "summary, point", meaning: "The review text Opus wrote for the PR author (its public field: summary and at most 8 points), cleaned to one line each (mentions and HTML tags removed, at most 600 characters); the whole body is cut at 6000 characters. Opus's internal reason, fixes and risks are never posted" },
      { name: "recommendation", meaning: "One closing line on what happens next, chosen when the review is posted: take \"merge after CI and checks pass.\" when the PR may merge without a decision and merging is approved in the repo, otherwise \"merge, after a maintainer's decision.\"; take-fix \"merge after the fixes above.\", with \"; they may be pushed to this branch.\" when the pipeline may push to the branch; hold \"update the pull request; it will be reviewed again.\"; close, or anything unclear, \"wait for maintainer feedback.\" The line is never cut off by the length limit" },
      { name: "head", meaning: "The first 7 characters of the reviewed head commit; after our own checked fix-up of the reviewed commit, the footer adds \"Fixes pushed in <fix-up commit>.\" and the closing line is the one for a take verdict" },
    ],
    example: withNote({ by: "model", kind: "review", model: "claude-opus-5-5" }, reviewBody({ verdict: "take-fix", sure: true, summary: "The change does what the description says; one call can fail without being handled.", points: ["`src/net.rs:42`: send() unwraps the result; return the error instead.", "`src/net.rs:60`: the retry count is read once and handled correctly."], head: "0123456789abcdef", recommendation: recommendation({ verdict: "take-fix", queue: null, mergeApproved: true, canPush: false }) })),
  },
];
