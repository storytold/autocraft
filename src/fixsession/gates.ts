// The gates of a fix session's change, per step: what the diff read from the workspace may touch before anything of it reaches a
// clone of ours. Session diffs have no line cap (fix-sessions plan §4) except a security fix's, which validateFixPatch keeps. Each
// gate names every file it refuses, so the one undo turn can take them all back.
import { TEST_PATH } from "../cifix/guard.ts";
import { fixupEditable, hasMarkers, operatorEditable, editable, resolvablePath, validatePatch, type BuildScripts, type PatchRules } from "../fixup/patch.ts";
import { validateFixPatch } from "../security/patch.ts";
import { patchGiveaway, QUIET_PATCH_REFUSAL, quietProblem } from "../security/rules.ts";
import type { Git } from "../fixup/git.ts";
import type { SecurityReport } from "./report.ts";

export type GateOk = { ok: true; patch: string; files: string[]; changed: number; /** A security fix: only its test file, for the base task. */ testPatch?: string };
export type GateResult = GateOk | { ok: false; problems: string[] };

type Common = { scripts: BuildScripts; /** A quiet pull request: the added lines may not name what the fix protects against. */ quiet?: boolean };
/**
 * Review or pre-merge fixes: the files the fixes name, and new .rs or .md files whose package (the innermost of `packages`, the
 * package directories at the head) is one of `newFilesIn` (the crates the PR changes).
 */
export type FixupGate = Common & { step: "fixup"; allowed: string[]; newFilesIn: string[]; packages: string[] };
/** A maintainer's instructions: any file but the protected ones; new, deleted and renamed files allowed. */
export type MaintainerGate = Common & { step: "maintainer" };
/** A failing CI check: the files the log names and the PR's changed files, never a test; `guard` checks the applied change (cifix guardApplied). */
export type CifixGate = Common & { step: "cifix"; allowed: string[]; guard: (patch: string) => Promise<string | null> };
/**
 * A merge conflict: the changed paths are exactly the conflicted files, with no marker left. `read` gives a file of the tree as the
 * session left it. `answers` recovers each section's resolution from the file and refuses edits outside the sections.
 */
export type ConflictGate = Common & { step: "conflict"; conflicted: string[]; read: (path: string) => Promise<string | null>; answers?: (path: string, content: string) => Promise<string | null> };
/** A security fix: existing .rs files of the crate plus exactly `testPath`, at most validateFixPatch's lines; no giveaway word. */
export type SecurityGate = { step: "security"; allowed: string[]; testPath: string; crateDir: string; testName: string; scripts: BuildScripts };
export type StepGate = FixupGate | MaintainerGate | CifixGate | ConflictGate | SecurityGate;

export type DiffFile = { path: string; kind: "edit" | "new" | "deleted" };

/** The files of a git diff with what happens to each, from the file headers and the mode line git writes after them. */
export function diffFiles(diff: string): DiffFile[] {
  const lines = diff.split("\n");
  const out: DiffFile[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^diff --git a\/(\S+) b\/\S+$/.exec(lines[i]!);
    if (!m) continue;
    const next = lines[i + 1] ?? "";
    out.push({ path: m[1]!, kind: next.startsWith("new file mode ") ? "new" : next.startsWith("deleted file mode ") ? "deleted" : "edit" });
  }
  return out;
}

const inside = (path: string, dir: string): boolean => dir === "" || dir === "." || path.startsWith(`${dir.replace(/\/$/, "")}/`);

/** The package directories of a tree: those of its Cargo.toml files (path to text) with a [package] table; "" for the root. */
export function packageDirsOf(manifests: ReadonlyMap<string, string>): string[] {
  return [...manifests].filter(([, toml]) => /^\s*\[package\]/m.test(toml)).map(([p]) => p.slice(0, -"Cargo.toml".length).replace(/\/$/, "")).sort();
}

/** The innermost of the package directories `dirs` that holds `path`, or null: a root package holds only paths outside the others. */
export const packageOf = (path: string, dirs: readonly string[]): string | null =>
  dirs.filter((d) => inside(path, d)).sort((a, b) => b.length - a.length)[0] ?? null;

/** The crate directories (of Cargo.toml files with a package) that hold one of `changed`, the innermost per file. */
export function crateDirsOf(changed: readonly string[], manifests: ReadonlyMap<string, string>): string[] {
  const dirs = packageDirsOf(manifests);
  const out = new Set<string>();
  for (const f of changed) {
    const d = packageOf(f, dirs);
    if (d !== null) out.add(d);
  }
  return [...out].sort();
}

/** The package directories at `head`, and those that hold a file the PR diff changes: where a fix-up may add files. */
export async function prPackages(git: Pick<Git, "git" | "file">, head: string, prDiff: string): Promise<{ newFilesIn: string[]; packages: string[] }> {
  const ls = await git.git(["ls-tree", "-r", "--name-only", head]);
  const manifests = new Map<string, string>();
  for (const f of ls.stdout.split("\n").filter((x) => x === "Cargo.toml" || x.endsWith("/Cargo.toml"))) {
    const t = await git.file(head, f);
    if (t.ok) manifests.set(f, t.content);
  }
  return { newFilesIn: crateDirsOf([...prDiff.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((m) => m[1]!), manifests), packages: packageDirsOf(manifests) };
}

/** The per-file problems when there are any, else validatePatch's structure check (modes, symlinks, binaries). */
function checked(diff: string, problems: string[], allowed: string[] | null, canEdit: (p: string) => boolean, rules: PatchRules): GateResult {
  if (problems.length) return { ok: false, problems };
  const v = validatePatch(diff, allowed, canEdit, rules);
  return v.ok ? { ok: true, patch: v.patch, files: v.files, changed: v.changed } : { ok: false, problems: [v.reason] };
}

const quietWord = (diff: string, quiet: boolean | undefined): string | null => (quiet && patchGiveaway(diff) ? QUIET_PATCH_REFUSAL : null);

/** Runs the step's gate on the diff read from the workspace, and the session's report (a security fix's title and summary). */
export async function runGate(g: StepGate, diff: string, report: SecurityReport | null): Promise<GateResult> {
  const files = diffFiles(diff);
  const problems: string[] = [];
  switch (g.step) {
    case "fixup": {
      const canAdd = (p: string) => { const pkg = packageOf(p, g.packages); return fixupEditable(p, g.scripts) && pkg !== null && g.newFilesIn.includes(pkg); };
      for (const f of files) {
        if (f.kind === "deleted") problems.push(`${f.path}: a fix-up may not delete or rename a file`);
        else if (f.kind === "new" && !canAdd(f.path)) problems.push(`${f.path}: a fix-up may add only .rs or .md files inside the crates this pull request changes`);
        else if (f.kind === "edit" && !fixupEditable(f.path, g.scripts)) problems.push(`${f.path} is not a file a fix-up may edit`);
        else if (f.kind === "edit" && !g.allowed.includes(f.path)) problems.push(`${f.path} is not a file named in the review's fixes`);
      }
      const q = quietWord(diff, g.quiet);
      if (q) problems.push(q);
      return checked(diff, problems, g.allowed, (p) => fixupEditable(p, g.scripts), { lineCap: null, newFile: canAdd, exact: true });
    }
    case "maintainer": {
      for (const f of files) if (!operatorEditable(f.path, g.scripts)) problems.push(`${f.path} is a protected file`);
      const q = quietWord(diff, g.quiet);
      if (q) problems.push(q);
      return checked(diff, problems, null, (p) => operatorEditable(p, g.scripts), { lineCap: null, newFile: (p) => operatorEditable(p, g.scripts), deletes: true, exact: true });
    }
    case "cifix": {
      for (const f of files) {
        if (f.kind !== "edit") problems.push(`${f.path}: a CI fix may not add, delete or rename a file`);
        else if (TEST_PATH.test(f.path)) problems.push(`${f.path} is a test file; a CI fix never edits tests`);
        else if (!editable(f.path, g.scripts)) problems.push(`${f.path} is not a file a CI fix may edit`);
        else if (!g.allowed.includes(f.path)) problems.push(`${f.path} is not a file the failure or the pull request's diff names`);
      }
      const q = quietWord(diff, g.quiet);
      if (q) problems.push(q);
      const r = checked(diff, problems, g.allowed, (p) => editable(p, g.scripts), { lineCap: null, exact: true });
      if (!r.ok) return r;
      const bad = await g.guard(r.patch);
      return bad ? { ok: false, problems: [bad] } : r;
    }
    case "conflict": {
      const changed = new Set(files.map((f) => f.path));
      for (const f of files) {
        if (!g.conflicted.includes(f.path)) problems.push(`${f.path} is not a conflicted file`);
        else if (f.kind !== "edit") problems.push(`${f.path}: a conflict resolution may not add, delete or rename a file`);
        else if (!resolvablePath(f.path, g.scripts)) problems.push(`${f.path} is not a file a conflict resolution may change`);
      }
      for (const p of g.conflicted) {
        if (!changed.has(p)) { problems.push(`${p} still has its conflict sections`); continue; }
        const text = await g.read(p);
        if (text === null) problems.push(`${p} is missing`);
        else if (hasMarkers(text)) problems.push(`${p} still has conflict markers`);
        else if (g.answers) {
          const bad = await g.answers(p, text);
          if (bad) problems.push(`${p}: ${bad}`);
        }
      }
      const q = quietWord(diff, g.quiet);
      if (q) problems.push(q);
      return checked(diff, problems, g.conflicted, (p) => resolvablePath(p, g.scripts), { lineCap: null, exact: true });
    }
    case "security": {
      const quiet = quietProblem(report?.title ?? "", report?.summary ?? "");
      if (quiet) problems.push(quiet);
      const word = patchGiveaway(diff);
      if (word) problems.push(`the diff adds the word "${word}"; name things for what the code does`);
      for (const f of files) {
        if (f.path === g.testPath) { if (f.kind !== "new") problems.push(`${f.path} must be a new file`); }
        else if (f.kind !== "edit") problems.push(`${f.path}: a security fix adds only ${g.testPath} and never deletes or renames a file`);
        else if (!g.allowed.includes(f.path)) problems.push(`${f.path} is not a .rs file of the crate`);
      }
      // validateFixPatch reads model replies and makes CRLF into LF, so a file with CR line ends would not come back as written.
      if (diff.includes("\r")) problems.push("the change has carriage returns (CRLF line ends); a security fix uses LF line ends only");
      if (problems.length) return { ok: false, problems };
      const v = validateFixPatch(diff, g.allowed, g.testPath, g.crateDir, g.testName, g.scripts);
      return v.ok ? { ok: true, patch: v.patch, files: v.files, changed: v.changed, testPatch: v.testPatch } : { ok: false, problems: [v.reason] };
    }
  }
}
