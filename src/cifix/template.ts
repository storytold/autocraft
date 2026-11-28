// Texts the CI fix step writes on GitHub. No Node imports.

/** The one comment after a push; `{{files}}` is the comma-separated list of changed paths. */
export const COMMENT_TEMPLATE = "Pushed a fix for the failing CI check: {{files}}.";
export function commentText(files: string[]): string {
  return COMMENT_TEMPLATE.replace("{{files}}", files.map((f) => `\`${f}\``).join(", "));
}

/** The commit message: a subject and one line per changed file. */
export function commitMessage(kind: "format" | "code", files: string[]): string {
  return `${kind === "format" ? "Fix formatting for CI" : "Fix failing CI check"}\n\n${files.map((f) => `- ${f}`).join("\n")}\n`;
}

/** The comment on a PR we can't push to; `{{patch}}` is the diff in a code fence. */
export const ASK_TEMPLATE = "The CI check `{{check}}` fails on this branch. This patch fixes it:\n\n```diff\n{{patch}}```";
/** The comment instead when the patch is over ASK_PATCH_MAX: a patch is never posted cut. `{{files}}` is one line per changed file. */
export const ASK_LARGE_TEMPLATE = "The CI check `{{check}}` fails on this branch. A fix is ready, but the change is too large to post as a comment. It changes:\n\n{{files}}";
export const ASK_PATCH_MAX = 12_000;
/** Files the too-large comment lists at most. */
const ASK_FILES_MAX = 50;
/** The reason of the hold row when the patch was too large for its comment. */
export const ASK_TOO_LARGE_REASON = `the change is over the ${ASK_PATCH_MAX} character limit of a comment, so the comment lists its files and line counts`;

/** A path git wrote C-quoted (`"a/x\tb"`, octal escapes for the bytes of non-ASCII names), from `s` at its opening quote. */
function unquoted(s: string): { text: string; rest: string } | null {
  const bytes: number[] = [];
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') return { text: new TextDecoder().decode(new Uint8Array(bytes)), rest: s.slice(i + 1) };
    if (ch !== "\\") { bytes.push(...new TextEncoder().encode(ch)); continue; }
    const oct = /^[0-7]{3}/.exec(s.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    const code = esc[s[i + 1] ?? ""];
    if (code === undefined) return null;
    bytes.push(code);
    i++;
  }
  return null;
}

/**
 * The new path of a `diff --git` header: both paths C-quoted when git quotes them, or plain, where a path with spaces is the same
 * on both sides (a rename's new path comes from its `rename to` line).
 */
function headerPath(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"') || rest.includes(' "b/')) {
    const a = rest.startsWith('"') ? unquoted(rest) : { text: "", rest: rest.slice(rest.indexOf(' "b/')) };
    const b = a && a.rest.startsWith(" ") ? (a.rest.startsWith(' "') ? unquoted(a.rest.slice(1)) : { text: a.rest.slice(1), rest: "" }) : null;
    return b?.text.startsWith("b/") ? b.text.slice(2) : null;
  }
  if (!rest.startsWith("a/")) return null;
  const n = (rest.length - 5) / 2;
  const same = Number.isInteger(n) ? rest.slice(2, 2 + n) : "";
  if (same && rest === `a/${same} b/${same}`) return same;
  const at = rest.lastIndexOf(" b/");
  return at < 0 ? null : rest.slice(at + 3);
}

/** The files of a git diff with the lines each adds and removes, in diff order. */
export function diffLineCounts(patch: string): { path: string; added: number; removed: number }[] {
  const out: { path: string; added: number; removed: number }[] = [];
  let cur: { path: string; added: number; removed: number } | null = null, inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = { path: headerPath(line) ?? line.slice(11), added: 0, removed: 0 }; out.push(cur); inHunk = false; continue; }
    if (!cur) continue;
    if (!inHunk && line.startsWith("rename to ")) { cur.path = line.slice(10).startsWith('"') ? unquoted(line.slice(10))?.text ?? cur.path : line.slice(10); continue; }
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) cur.added++;
    else if (line.startsWith("-")) cur.removed++;
  }
  return out;
}

/** The comment on a PR we can't push to: the whole patch, or (`whole` false) over ASK_PATCH_MAX the changed files with their line counts. */
export function askText(check: string, patch: string): { text: string; whole: boolean } {
  const name = check.replace(/[`@\r\n]/g, " ").trim().slice(0, 100) || "CI";
  const body = patch.replace(/```/g, "'''").replace(/\n?$/, "\n");
  // Function replacers: the text may contain `$&` and similar.
  if (body.length <= ASK_PATCH_MAX) return { text: ASK_TEMPLATE.replace("{{check}}", () => name).replace("{{patch}}", () => body), whole: true };
  const files = diffLineCounts(patch);
  const lines = files.slice(0, ASK_FILES_MAX).map((f) => `- \`${f.path.replace(/[`\r\n]/g, "")}\`: +${f.added} −${f.removed}`);
  if (files.length > ASK_FILES_MAX) lines.push(`- and ${files.length - ASK_FILES_MAX} more files`);
  return { text: ASK_LARGE_TEMPLATE.replace("{{check}}", () => name).replace("{{files}}", () => lines.join("\n")), whole: false };
}

/** A GitHub user login that can be mentioned (a bot's `name[bot]` cannot). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * The comment on a PR nobody approved for merge whose CI failure we could not fix: one line naming the failing checks, addressed to the
 * PR's author by login when there is one to mention.
 */
export function askCiText(checks: string[], author: string | null = null): string {
  const names = [...new Set(checks.map((c) => c.replace(/[`@\r\n]/g, " ").trim().slice(0, 100)).filter(Boolean))].slice(0, 5);
  const list = names.map((n) => `\`${n}\``).join(", ");
  const to = author && LOGIN.test(author) ? `@${author} ` : "";
  return names.length ? `${to}The CI check${names.length > 1 ? "s" : ""} ${list} fail${names.length > 1 ? "" : "s"} on this branch. Could you take a look?` : `${to}CI fails on this branch. Could you take a look?`;
}
