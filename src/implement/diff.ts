// The diff of an implementation: read out of the workspace by an own call, then checked before anything of it reaches a
// clone of ours. A session's diff is untrusted data: every path, mode and size is checked here, and pr.ts checks the
// commit it applies to again.
import type { Db } from "../db/index.ts";
import type { KubeApi } from "../build/kube-api.ts";
import { describeHeader, execInWorkspace, execWs, getWorkspace } from "../build/workspaces.ts";
import { diffScript, MAX_CHECKPOINT_BYTES } from "../build/workspace-launch.ts";
import { safePath, trustPath, type BuildScripts } from "../fixup/patch.ts";

/** Changed text lines (added plus removed) an implementation may have. */
export const MAX_IMPLEMENTATION_LINES = 3000;
export const MAX_IMPLEMENTATION_FILES = 80;
/** The largest binary file an implementation may add or change. */
export const MAX_BINARY_BYTES = 1024 ** 2;

/** Renames show as a deletion and an addition, so every path is checked; colour and prefixes are pinned against the workspace's git config. */
export const DIFF_FLAGS = "--no-renames --no-color --src-prefix=a/ --dst-prefix=b/";
const DIFF_NAME = "implement";

export type ChangedFile = {
  path: string;
  /** Added, modified or deleted. */
  status: "A" | "M" | "D";
  /** The file's mode before and after (an added file's, a deleted file's): a regular file, never a mode change. */
  mode: "100644" | "100755";
  binary: boolean;
  added: number;
  removed: number;
};

export type ImplementationCheck =
  | {
    ok: true; files: ChangedFile[]; /** Changed text lines. */ changed: number; /** Changed Cargo manifests and lockfiles: allowed, and flagged in the PR body. */ manifests: string[];
    /**
     * Manifest changes that make Cargo run new code at compile time (a proc-macro crate, build dependencies, `[patch]` or
     * `[replace]` entries), one line each: such a change opens only as a draft PR for a maintainer. Empty when no manifest
     * texts were given.
     */
    compileTime: CompileTimeChange[];
  }
  | { ok: false; reason: string; /** Every problem, one line each, for the session's "undo" turn. */ problems: string[] };

const MANIFEST = /(^|\/)Cargo\.(toml|lock)$/;
const CARGO_TOML = /(^|\/)Cargo\.toml$/;
const REGULAR = new Set(["100644", "100755"]);

const modeWord = (m: string): string =>
  m === "120000" ? "a symlink" : m === "160000" ? "a submodule" : m === "100755" ? "an executable file" : `a file of mode ${m}`;

/** The path of a `diff --git a/P b/P` line, where both sides are the same path (renames are off); null when it is quoted or the sides differ. */
function headerPath(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith("\"")) return null;
  const len = (rest.length - 5) / 2;
  if (!Number.isInteger(len) || len < 1) return null;
  const p = rest.slice(2, 2 + len);
  return rest === `a/${p} b/${p}` ? p : null;
}

/**
 * Checks a workspace diff (`git diff --binary` against the base commit, DIFF_FLAGS) for the PR: every path is safe and not a
 * trust path (workflows, build scripts per `scripts`, cargo and tool config, agent instruction files); no symlink, submodule
 * or mode change, and an added file is not executable; at most MAX_IMPLEMENTATION_FILES files, MAX_IMPLEMENTATION_LINES
 * changed text lines and MAX_BINARY_BYTES per binary file. Cargo.toml and Cargo.lock changes pass and are listed in `manifests`;
 * with `manifestTexts` (each changed Cargo.toml before and after, null where it does not exist) their compile-time changes
 * are listed in `compileTime`. Whether it applies is decided by `git apply --check` in the clone, and pr.ts counts the
 * committed lines again with `git diff --numstat`.
 */
export function validateImplementation(diff: string | Uint8Array, scripts: BuildScripts, manifestTexts?: ManifestTexts): ImplementationCheck {
  let text: string;
  if (typeof diff === "string") text = diff;
  else {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(diff); } catch { return refuse(["the diff is not UTF-8 text"]); }
  }
  if (text.includes("\0")) return refuse(["the diff holds a NUL byte"]);
  if (!text.trim()) return refuse(["the diff is empty"]);
  const lines = text.split("\n");
  if (!lines[0]!.startsWith("diff --git ")) return refuse(["the diff does not start with a file header"]);

  const problems: string[] = [];
  const files: ChangedFile[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const head = lines[i]!;
    if (!head.startsWith("diff --git ")) { i++; continue; }
    let end = i + 1;
    while (end < lines.length && !lines[end]!.startsWith("diff --git ")) end++;
    const f = section(lines.slice(i, end), problems);
    if (f) {
      if (seen.has(f.path)) problems.push(`${f.path}: appears twice in the diff`);
      seen.add(f.path);
      if (!safePath(f.path)) problems.push(`${f.path}: not a plain path inside the repository`);
      else if (trustPath(f.path, scripts)) problems.push(`${f.path}: workflows, build scripts, tool configuration and agent instruction files are not changed by an implementation`);
      files.push(f);
    }
    i = end;
  }
  const changed = files.reduce((n, f) => n + f.added + f.removed, 0);
  if (files.length > MAX_IMPLEMENTATION_FILES) problems.push(`${files.length} files changed; at most ${MAX_IMPLEMENTATION_FILES}`);
  if (changed > MAX_IMPLEMENTATION_LINES) problems.push(`${changed} lines changed; at most ${MAX_IMPLEMENTATION_LINES}`);
  if (problems.length) return refuse(problems);
  const manifests = files.map((f) => f.path).filter((p) => MANIFEST.test(p));
  const compileTime = manifestTexts ? manifests.filter((p) => CARGO_TOML.test(p)).flatMap((p) => {
    const t = manifestTexts.get(p);
    return t ? compileTimeChanges(p, t.before, t.after) : [{ path: p, what: "its text could not be read" }];
  }) : [];
  return { ok: true, files, changed, manifests, compileTime };
}

function refuse(problems: string[]): ImplementationCheck {
  const shown = problems.slice(0, 5).join("; ");
  return { ok: false, reason: problems.length > 5 ? `${shown}; and ${problems.length - 5} more` : shown, problems };
}

/** One file's part of the diff, or null (with the problem added) when its header cannot be read. */
function section(lines: string[], problems: string[]): ChangedFile | null {
  const path = headerPath(lines[0]!);
  if (path === null) {
    problems.push(`a path git quotes, or a header that does not name one path: ${lines[0]!.slice(0, 120)}`);
    return null;
  }
  let status: ChangedFile["status"] = "M";
  let mode: string | null = null;
  let k = 1;
  for (; k < lines.length; k++) {
    const l = lines[k]!;
    let m: RegExpExecArray | null;
    if (l.startsWith("--- ") || l === "GIT binary patch" || l.startsWith("Binary files ") || l.startsWith("@@")) break;
    if ((m = /^new file mode (\d+)$/.exec(l))) { status = "A"; mode = m[1]!; }
    else if ((m = /^deleted file mode (\d+)$/.exec(l))) { status = "D"; mode = m[1]!; }
    else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d+))?$/.exec(l))) { if (m[1]) mode ??= m[1]; }
    else if (/^(old|new) mode /.test(l)) { problems.push(`${path}: changes the file mode`); return null; }
    else if (/^(similarity index|dissimilarity index|rename from|rename to|copy from|copy to) /.test(l)) { problems.push(`${path}: a rename or copy`); return null; }
    else { problems.push(`${path}: an unexpected header line: ${l.slice(0, 80)}`); return null; }
  }
  if (mode === null) { problems.push(`${path}: the header names no file mode`); return null; }
  if (!REGULAR.has(mode) || (status === "A" && mode !== "100644")) {
    problems.push(`${path}: ${status === "A" ? "adds" : status === "D" ? "deletes" : "changes"} ${modeWord(mode)}`);
    return null;
  }
  const f: ChangedFile = { path, status, mode: mode as ChangedFile["mode"], binary: false, added: 0, removed: 0 };
  const rest = lines.slice(k);
  if (rest[0]?.startsWith("Binary files ")) { problems.push(`${path}: a binary change without its content`); return null; }
  if (rest[0] === "GIT binary patch") {
    f.binary = true;
    // The first block gives the new content (a literal's size is the file's; pr.ts reads the size of a delta's result in the clone), the second the reverse.
    const m = rest.map((l) => /^(literal|delta) (\d+)$/.exec(l)).find((x) => x !== null);
    if (!m) { problems.push(`${path}: a binary patch without content`); return null; }
    if (Number(m[2]) > MAX_BINARY_BYTES) { problems.push(`${path}: a binary file over ${MAX_BINARY_BYTES / 1024 ** 2} MiB`); return null; }
    return f;
  }
  if (rest[0]?.startsWith("@@")) { problems.push(`${path}: hunks without --- and +++ lines`); return null; }
  if (rest.length && rest[0]!.startsWith("--- ")) {
    // git ends the name with a tab when it holds a space.
    const from = rest[0]!.slice(4).replace(/\t$/, ""), to = rest[1]?.startsWith("+++ ") ? rest[1].slice(4).replace(/\t$/, "") : null;
    const fromOk = status === "A" ? from === "/dev/null" : from === `a/${path}`;
    const toOk = status === "D" ? to === "/dev/null" : to === `b/${path}`;
    if (!fromOk || !toOk) { problems.push(`${path}: its --- and +++ lines name another file`); return null; }
    let inHunk = false;
    for (const l of rest.slice(2)) {
      if (l.startsWith("@@")) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (l.startsWith("+")) f.added++;
      else if (l.startsWith("-")) f.removed++;
    }
  }
  return f;
}

/** One compile-time change of a manifest: its path and what it does. */
export type CompileTimeChange = { path: string; what: string };

/** Per changed Cargo.toml path: its text at the base and in the change, null where the file does not exist. */
export type ManifestTexts = Map<string, { before: string | null; after: string | null }>;

/** A manifest's entries as `key path = value` lines: the table path joined with the dotted key, quotes and spaces dropped. */
function manifestEntries(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  let table: string[] = [];
  let depth = 0;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (depth > 0) {
      // A multi-line array: its lines belong to the entry before.
      out[out.length - 1] += ` ${line}`;
      depth = Math.max(0, depth + nesting(line));
      continue;
    }
    const header = /^\[\[?(.*?)\]\]?$/.exec(line);
    if (header) { table = keyPath(header[1]!); continue; }
    const eq = equalsAt(line);
    if (eq < 0) continue;
    out.push(`${[...table, ...keyPath(line.slice(0, eq))].join(".")}=${line.slice(eq + 1).replace(/\s+/g, "")}`);
    depth = Math.max(0, nesting(line.slice(eq + 1)));
  }
  return out;
}

/** The line without a `#` comment outside strings. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === "\\" && quote === "\"") i++; else if (c === quote) quote = null; }
    else if (c === "\"" || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** Index of the `=` that ends the key (outside quotes), or -1. */
function equalsAt(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = null; }
    else if (c === "\"" || c === "'") quote = c;
    else if (c === "=") return i;
  }
  return -1;
}

/** Opened minus closed brackets and braces outside strings. */
function nesting(s: string): number {
  let n = 0, quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) { if (c === "\\" && quote === "\"") i++; else if (c === quote) quote = null; }
    else if (c === "\"" || c === "'") quote = c;
    else if (c === "[" || c === "{") n++;
    else if (c === "]" || c === "}") n--;
  }
  return n;
}

/** A dotted TOML key as its parts, quotes removed and `_` read as `-` (Cargo takes both spellings). */
function keyPath(key: string): string[] {
  const parts: string[] = [];
  let cur = "", quote: string | null = null;
  for (const c of key.trim()) {
    if (quote) { if (c === quote) quote = null; else cur += c; }
    else if (c === "\"" || c === "'") quote = c;
    else if (c === ".") { parts.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  parts.push(cur.trim());
  return parts.map((p) => p.replace(/_/g, "-"));
}

/**
 * The compile-time changes of one Cargo.toml, one line each: it becomes a proc-macro crate, its build dependencies are
 * added or changed (any `build-dependencies` table, target-specific ones too), or it adds or changes `[patch]` or
 * `[replace]` entries. Cargo runs such code while it builds, as it runs build.rs.
 */
export function compileTimeChanges(path: string, before: string | null, after: string | null): CompileTimeChange[] {
  const was = manifestEntries(before), now = manifestEntries(after);
  const had = new Set(was);
  const added = now.filter((e) => !had.has(e));
  const out: CompileTimeChange[] = [];
  const procMacro = (es: string[]) => es.some((e) => /^lib\.proc-macro=true$/.test(e));
  if (procMacro(now) && !procMacro(was)) out.push({ path, what: before === null ? "adds a proc-macro crate" : "makes the crate a proc-macro crate" });
  const build = (e: string) => e.split("=")[0]!.split(".").includes("build-dependencies");
  if (added.some(build)) out.push({ path, what: "adds or changes build dependencies" });
  if (added.some((e) => /^(patch|replace)[.=]/.test(e))) out.push({ path, what: "adds or changes [patch] or [replace] entries" });
  return out;
}

/**
 * The workspace's diff against its base commit, read by an own call (it does not count as a session tool call): every
 * change of the working tree, untracked files included (`git add -A -N` on a copy of the index), at most MAX_CHECKPOINT_BYTES.
 */
export async function workspaceDiff(db: Db, api: KubeApi, workspaceId: number, now: () => number = Date.now, purpose = "implement"): Promise<{ ok: true; diff: string; base: string } | { ok: false; reason: string }> {
  const w = await getWorkspace(db, workspaceId);
  if (!w || w.state !== "ready") return { ok: false, reason: `workspace ${workspaceId} is not ready` };
  if (!w.base_commit) return { ok: false, reason: `workspace ${workspaceId} has no base commit` };
  const r = await execWs(db, api, workspaceId, ["run", "300", "--", "sh", "-c", diffScript(DIFF_NAME, DIFF_FLAGS), DIFF_NAME, w.base_commit],
    { tool: "checkpoint", args: { purpose }, timeoutMs: 310_000 }, now);
  if (r.header?.kind !== "status" || r.header.state !== "exited" || r.header.exit !== 0) {
    const last = r.output.trim().split("\n").pop()?.slice(0, 200);
    return { ok: false, reason: `the diff failed (${r.error ?? describeHeader(r.header)})${last ? `: ${last}` : ""}` };
  }
  const raw = await execInWorkspace(db, api, workspaceId, ["head", "-c", String(MAX_CHECKPOINT_BYTES + 1), `/work/.ws/${DIFF_NAME}.diff`], { maxOut: MAX_CHECKPOINT_BYTES + 1, timeoutMs: 120_000 });
  if (raw.exitCode !== 0) return { ok: false, reason: `the diff could not be read (${raw.error ?? `exit ${raw.exitCode}`})` };
  if (raw.stdout.length > MAX_CHECKPOINT_BYTES) return { ok: false, reason: `the diff is over ${MAX_CHECKPOINT_BYTES / 1024 ** 2} MiB` };
  try {
    return { ok: true, diff: new TextDecoder("utf-8", { fatal: true }).decode(raw.stdout), base: w.base_commit };
  } catch {
    return { ok: false, reason: "the diff is not UTF-8 text" };
  }
}
