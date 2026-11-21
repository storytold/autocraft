// Read-only file tools for a compatible provider's model calls (src/agents/compatible.ts): Read, Grep and Glob, the same
// names the prompts use for the Claude tools, over the paths a Claude sandbox would mount (/repo, /repos/<name>,
// /repo-docs, /reference).
//
// There is no sandbox process: the tools read on the host, so every path is resolved to its real path and must stay
// inside the root it names. A symlink in a checkout that points outside it is refused, as it would dangle inside a
// sandbox mount. Nothing here writes.
//
// Grep takes a regular expression from the model, and model text is influenced by the repository content it reads, so
// the regex runs in a worker thread with a deadline (grep-thread.ts): a pattern that backtracks catastrophically is
// stopped instead of holding the service's event loop.
import { closeSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { grepThread } from "./grep-thread.ts";
import { GLOB_MAX, GREP_MAX, LINE_MAX, READ_DEFAULT_LINES, READ_MAX_BYTES, WALK_MAX_FILES } from "./tool-limits.ts";

/** One mounted directory: the path the model names, and the host directory it stands for. */
export type ToolRoot = { path: string; dir: string };

export class ToolError extends Error {}

/** The roots of one call: the checkout at /repo, the workspace repositories, the repo docs and the reference docs. */
export function toolRoots(o: { checkout?: string; shared?: { name: string; dir: string }[]; docs?: string; reference?: string }): ToolRoot[] {
  const out: ToolRoot[] = [];
  if (o.checkout) out.push({ path: "/repo", dir: o.checkout });
  for (const s of o.shared ?? []) out.push({ path: `/repos/${s.name}`, dir: s.dir });
  if (o.docs) out.push({ path: "/repo-docs", dir: o.docs });
  if (o.reference) out.push({ path: "/reference", dir: o.reference });
  return out;
}

/** A path as a model names it: absolute, plain, no `.`/`..` segment, no NUL. */
function checkVirtual(p: string): string {
  if (typeof p !== "string" || !p) throw new ToolError("the path is missing");
  if (p.includes("\0")) throw new ToolError("the path holds a NUL character");
  if (!isAbsolute(p)) throw new ToolError(`the path must be absolute, such as /repo/src/a.ts (it was "${p.slice(0, 80)}")`);
  const parts = p.split("/").filter(Boolean);
  if (parts.some((c) => c === "." || c === "..")) throw new ToolError("the path must not hold a . or .. segment");
  return "/" + parts.join("/");
}

/** The host path a virtual path names, or a ToolError saying which roots exist. The real path must stay below its root. */
export function resolveToolPath(roots: readonly ToolRoot[], virtual: string): { host: string; root: ToolRoot } {
  const p = checkVirtual(virtual);
  const root = [...roots].sort((a, b) => b.path.length - a.path.length).find((r) => p === r.path || p.startsWith(`${r.path}/`));
  if (!root) throw new ToolError(roots.length ? `no such path: it is not under ${roots.map((r) => r.path).join(", ")}` : "this call has no files to read");
  const rel = p.slice(root.path.length).replace(/^\//, "");
  let host: string, real: string, realRoot: string;
  try {
    realRoot = realpathSync(root.dir);
    host = join(realRoot, rel);
    real = realpathSync(host);
  } catch {
    throw new ToolError(`no such file: ${p}`);
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) throw new ToolError(`${p} leads outside ${root.path}`);
  return { host: real, root };
}

const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8_000).includes(0);

/** `Read`: numbered lines, a window of the file, or why it cannot be shown. */
export function readText(roots: readonly ToolRoot[], args: { file_path?: unknown; offset?: unknown; limit?: unknown }): string {
  if (typeof args.file_path !== "string") throw new ToolError("file_path is required");
  const { host } = resolveToolPath(roots, args.file_path);
  const st = statSync(host);
  if (st.isDirectory()) throw new ToolError(`${args.file_path} is a directory; use Glob to list its files`);
  if (!st.isFile()) throw new ToolError(`${args.file_path} is not a regular file`);
  if (st.size > READ_MAX_BYTES) throw new ToolError(`${args.file_path} is ${Math.round(st.size / (1 << 20))} MB, too big to read at once (at most ${READ_MAX_BYTES >> 20} MB)`);
  const fd = openSync(host, "r");
  let head = Buffer.alloc(8_000), got = 0;
  try { got = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  head = head.subarray(0, got);
  if (isBinary(head)) {
    const kind = /^\x89PNG/.test(head.toString("latin1")) ? "a PNG image" : /^\xff\xd8/.test(head.toString("latin1")) ? "a JPEG image" : /^%PDF/.test(head.toString("latin1")) ? "a PDF" : "a binary file";
    throw new ToolError(`${args.file_path} is ${kind} (${st.size} bytes); this provider's tools read text only, so the file cannot be opened. Work from the text files that describe it.`);
  }
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : 1;
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(READ_DEFAULT_LINES, Math.max(1, Math.floor(args.limit))) : READ_DEFAULT_LINES;
  const lines = readFileSync(host, "utf8").split("\n");
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  if (!slice.length) throw new ToolError(`${args.file_path} has ${lines.length} lines; offset ${offset} is past its end`);
  const shown = slice.map((l, i) => `${String(offset + i).padStart(6)}→${l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l}`).join("\n");
  const more = offset - 1 + slice.length < lines.length ? `\n(… ${lines.length - (offset - 1 + slice.length)} more lines; read on with offset ${offset + slice.length})` : "";
  return `${args.file_path}\n${shown}${more}`;
}

/** Every file under `dir`, skipping `.git` and not following directory symlinks; paths are relative with `/`. */
function walk(dir: string, visit: (rel: string, host: string) => boolean): void {
  let n = 0;
  const stack: { host: string; rel: string }[] = [{ host: dir, rel: "" }];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: Dirent[];
    try { entries = readdirSync(cur.host, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++n > WALK_MAX_FILES) return;
      if (e.name === ".git" || e.name === "node_modules") continue;
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      const host = join(cur.host, e.name);
      if (e.isDirectory()) stack.push({ host, rel });
      else if (e.isFile() && !visit(rel, host)) return;
    }
  }
}

/**
 * A glob over `/`-separated relative paths, matched with bounded work per path: `**` matches zero or more path
 * segments, `*` and `?` match within one segment, and everything else is literal. It is a hand-written matcher rather
 * than a regular expression because the pattern comes from the model: `["*a" × 30, "b"]` compiles to a regular
 * expression that backtracks exponentially on a long path, which would hold the service's event loop (the Grep content
 * search runs in a worker for the same reason, but Glob and the Grep filter run here).
 */
export function globMatches(pattern: string, rel: string): boolean {
  const pat = pattern.split("/").filter((x) => x !== "");
  const segs = rel.split("/").filter(Boolean);
  // A pattern without a slash names a file at any depth, as Glob documents.
  if (!pattern.includes("/")) pat.unshift("**");
  const memo = new Map<number, boolean>();
  const at = (i: number, j: number): boolean => {
    const k = i * (segs.length + 1) + j;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === pat.length) r = j === segs.length;
    else if (pat[i] === "**") r = at(i + 1, j) || (j < segs.length && at(i, j + 1));
    else r = j < segs.length && segmentMatches(pat[i]!, segs[j]!) && at(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return at(0, 0);
}

/** One segment pattern (`*`, `?` and literals) against one path segment: a table walk, never a backtracking regex. */
export function segmentMatches(pattern: string, segment: string): boolean {
  let prev = new Array<boolean>(segment.length + 1).fill(false);
  prev[0] = true;
  for (let i = 1; i <= pattern.length; i++) {
    const c = pattern[i - 1]!;
    const cur = new Array<boolean>(segment.length + 1).fill(false);
    if (c === "*") {
      cur[0] = prev[0]!;
      for (let j = 1; j <= segment.length; j++) cur[j] = prev[j]! || cur[j - 1]!;
    } else if (c === "?") {
      for (let j = 1; j <= segment.length; j++) cur[j] = prev[j - 1]!;
    } else {
      for (let j = 1; j <= segment.length; j++) cur[j] = prev[j - 1]! && segment[j - 1] === c;
    }
    prev = cur;
  }
  return prev[segment.length]!;
}

/** `Glob`: the files under a root that match a pattern (a pattern without `/` matches a file name at any depth). */
export function globFiles(roots: readonly ToolRoot[], args: { pattern?: unknown; path?: unknown }): string {
  if (typeof args.pattern !== "string" || !args.pattern.trim()) throw new ToolError("pattern is required");
  const base = typeof args.path === "string" && args.path ? args.path : roots[0]?.path;
  if (!base) throw new ToolError("this call has no files to read");
  const { host } = resolveToolPath(roots, base);
  if (!statSync(host).isDirectory()) throw new ToolError(`${base} is not a directory`);
  const pattern = args.pattern.trim();
  // Results are named from the directory the model searched, so a Read of one opens what it saw.
  const dir = checkVirtual(base);
  const found: string[] = [];
  walk(host, (rel) => {
    if (globMatches(pattern, rel)) found.push(`${dir}/${rel}`);
    return found.length < GLOB_MAX;
  });
  if (!found.length) return `no file matches ${pattern} under ${base}`;
  found.sort();
  return `${found.length}${found.length >= GLOB_MAX ? "+" : ""} file(s) matching ${pattern} under ${base}\n${found.join("\n")}${found.length >= GLOB_MAX ? "\n(stopped at the limit; narrow the pattern)" : ""}`;
}

/** `Grep`: lines of the files under a root that match a regular expression, as `path:line:text`. */
export async function grepFiles(roots: readonly ToolRoot[], args: { pattern?: unknown; path?: unknown; glob?: unknown; head_limit?: unknown; "-i"?: unknown }): Promise<string> {
  if (typeof args.pattern !== "string" || !args.pattern) throw new ToolError("pattern is required");
  const base = typeof args.path === "string" && args.path ? args.path : roots[0]?.path;
  if (!base) throw new ToolError("this call has no files to read");
  const { host, root } = resolveToolPath(roots, base);
  const st = statSync(host);
  // A glob without a slash matches a file name at any depth, as Glob does (`*.rs`, not only a top-level match).
  const include = typeof args.glob === "string" && args.glob ? args.glob : null;
  const head = typeof args.head_limit === "number" && Number.isFinite(args.head_limit) ? Math.min(GREP_MAX, Math.max(1, Math.floor(args.head_limit))) : GREP_MAX;
  const files: string[] = [];
  if (st.isDirectory()) {
    walk(host, (rel, h) => {
      if (include === null || globMatches(include, rel)) files.push(h);
      return files.length < WALK_MAX_FILES;
    });
  } else files.push(host);
  if (!files.length) return `no file matches ${typeof args.glob === "string" ? args.glob : "the path"}`;
  const flags = args["-i"] === true ? "i" : "";
  let r: Awaited<ReturnType<typeof grepThread>>;
  try { r = await grepThread({ pattern: args.pattern, flags, files, max: head }); } catch (e) {
    throw new ToolError((e as Error).message);
  }
  // The worker sees host paths; the model sees the paths it named.
  const realRoot = realpathSync(root.dir);
  const virt = (h: string): string => `${root.path}${h === realRoot ? "" : `/${h.slice(realRoot.length + 1)}`}`;
  if (!r.matches.length) return `no match for ${args.pattern} under ${base}`;
  return r.matches.map((m) => `${virt(m.file)}:${m.line}:${m.text.length > LINE_MAX ? `${m.text.slice(0, LINE_MAX)}…` : m.text}`).join("\n")
    + (r.limitHit ? `\n(stopped at ${head} matches; narrow the pattern)` : "");
}

/** The tool declarations a call with these roots offers. `check` adds the build tool (src/checktool) the patch prompts name. */
export function toolDefs(o: { check: boolean }): { name: string; description: string; parameters: Record<string, unknown> }[] {
  const path = { type: "string", description: "An absolute path under /repo, /repos/<name>, /repo-docs or /reference, such as /repo/src/main.ts" };
  const defs: { name: string; description: string; parameters: Record<string, unknown> }[] = [
    { name: "Read", description: "Read a text file, with line numbers. A big file can be read in windows with offset and limit. Images and other binary files cannot be read.",
      parameters: { type: "object", properties: { file_path: path, offset: { type: "number", description: "The first line to read (1-based). Default 1." }, limit: { type: "number", description: `How many lines to read. Default ${READ_DEFAULT_LINES}.` } }, required: ["file_path"] } },
    { name: "Grep", description: "Search the files under a path for a JavaScript regular expression, line by line. Returns path:line:text.",
      parameters: { type: "object", properties: { pattern: { type: "string", description: "A regular expression, such as \"fn main\\\\(\" or \"TODO|FIXME\"" }, path, glob: { type: "string", description: "Only files matching this glob, such as \"*.ts\" or \"src/**/*.rs\"" }, head_limit: { type: "number", description: `At most this many matching lines (default ${GREP_MAX}).` }, "-i": { type: "boolean", description: "Ignore case." } }, required: ["pattern"] } },
    { name: "Glob", description: "List the files that match a glob pattern (list files with Glob when you do not know their names).",
      parameters: { type: "object", properties: { pattern: { type: "string", description: "A glob, such as \"**/*.md\" or \"src/**/test_*.ts\"" }, path: { ...path, description: "The directory to search. Default: the repository root /repo." } }, required: ["pattern"] } },
    { name: "Agent", description: "Not available with this provider. Search with Grep and Glob instead.",
      parameters: { type: "object", properties: { prompt: { type: "string" }, subagent_type: { type: "string" } }, required: [] } },
  ];
  if (o.check) defs.push({ name: "mcp__build__check", description: "Run fmt, clippy, check or test on your complete patch on a build worker, and read what it reports. Call it with command fmt and then command clippy on the diff you answer with.",
    parameters: { type: "object", properties: { command: { type: "string", enum: ["fmt", "clippy", "check", "test"] }, patch: { type: "string", description: "Your complete diff" }, crate: { type: "string", description: "For test: the crate name" }, test_name: { type: "string", description: "For test: a test name filter" } }, required: ["command", "patch"] } });
  return defs;
}
