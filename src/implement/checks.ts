// AutoCraft's own checks of an implementation in its workspace (D5): the formatter on the changed .rs files, clippy on the
// affected crates filtered to the changed lines, and the affected crates' tests. Fixed scripts with the paths and crate names
// as arguments, run as the job's own calls; only their output files are read back. The session's own claims count for nothing.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/index.ts";
import { assertFence } from "../db/fence.ts";
import { guardedApi, inClusterApi, type KubeApi } from "../build/kube-api.ts";
import { describeHeader, execHelper, execWs } from "../build/workspaces.ts";
import { SRC_ROOT, WORK_ROOT } from "../build/workspace-tool-specs.ts";
import { DIFF_FLAGS } from "./diff.ts";
import { findingsOf, patchLines, type Finding } from "../prepush/index.ts";
import { classifyTests, testFindings } from "../prepush/tests.ts";
import type { Crate } from "../verify/types.ts";
import type { SessionFinding } from "./session-input.ts";

/** One fixed script run in the workspace; the job waits for it. `state` is the helper's: exited, killed or timed-out. */
export type PodRun = { exit: number | null; state: string };

/** The job's own access to a workspace's pod. Tests fake it. */
export interface Pod {
  /** Runs `bash -c <script> <what> <args...>` in /work/src as an own call and waits for it to end. */
  run(what: string, script: string, args: string[], limitSec: number): Promise<PodRun>;
  /** The bytes of a file in the pod, or null when there is none. Throws when it is larger than `max`. */
  file(path: string, max: number): Promise<Buffer | null>;
}

const STATUS_WAIT_SEC = 60;
/** A `--since` past any log's end: a status call that returns only the header. */
const NO_OUTPUT = "999999999999";

/** The pod of workspace `wsId` through `through`, by default the in-cluster API; throws when this process is not in the cluster. */
export function workspacePod(db: Db, wsId: number, cancelled: () => Promise<boolean> = async () => false, through?: KubeApi): Pod {
  const cluster = through ?? inClusterApi();
  if (!cluster) throw new Error("this runner is not in the cluster, so it cannot reach the workspace");
  const api = through ?? guardedApi(cluster, () => assertFence(db));
  return {
    async run(what, script, args, limitSec) {
      const start = await execWs(db, api, wsId, ["run", String(limitSec), "--background", "--", "bash", "-c", script, what, ...args], { tool: "report", args: { report: what }, timeoutMs: 30_000 });
      if (start.header?.kind !== "started") throw new Error(`${what} did not start: ${describeHeader(start.header)}${start.error ? `: ${start.error}` : ""}`);
      const n = String(start.header.n);
      for (;;) {
        if (await cancelled()) {
          await execHelper(db, api, wsId, ["kill", n], { maxOut: 64 * 1024, timeoutMs: 30_000 }).catch(() => undefined);
          throw new Error(`${what} was stopped: the job was cancelled`);
        }
        const st = await execHelper(db, api, wsId, ["status", n, "--wait", String(STATUS_WAIT_SEC), "--since", NO_OUTPUT], { maxOut: 64 * 1024, timeoutMs: (STATUS_WAIT_SEC + 30) * 1000 });
        if (st.header?.kind !== "status") throw new Error(`${what}: ${describeHeader(st.header)}${st.error ? `: ${st.error}` : ""}`);
        if (st.header.state !== "running") return { exit: st.header.exit, state: st.header.state };
      }
    },
    async file(path, max) {
      const r = await execHelper(db, api, wsId, ["cat", path, String(max)], { maxOut: max + 64 * 1024, timeoutMs: 120_000 });
      const h = r.header;
      if (h?.kind === "error" && h.code === "nofile") return null;
      if (h?.kind !== "ok" || h.fields.length !== 2) throw new Error(`reading ${path}: ${describeHeader(h)}${r.error ? `: ${r.error}` : ""}`);
      const [size, sha] = h.fields;
      if (r.truncated || r.body.length !== Number(size) || createHash("sha256").update(r.body).digest("hex") !== sha) throw new Error(`reading ${path}: the file was cut in transfer`);
      return r.body;
    },
  };
}

/** A fresh directory for one round's output files in the pod. */
export const roundDir = (implementationId: number, round: number): string => `${WORK_ROOT}/.ws/tmp/autocraft-${implementationId}-${round}-${randomBytes(4).toString("hex")}`;

// ---- the scripts ---------------------------------------------------------------------------------------------------

/** $1 the output directory, $2 the base commit. The change against the base (new files included), and the crates. */
const CHANGES_SCRIPT = `set -f
out=$1; base=$2
mkdir -p "$out" || exit 90
git -c core.hooksPath=/dev/null add -A -N >"$out/add.err" 2>&1 || exit 91
git -c core.quotePath=false diff --no-ext-diff --no-textconv --no-color --no-renames -U0 "$base" >"$out/diff.txt" 2>"$out/diff.err" || exit 92
cargo metadata --offline --no-deps --format-version 1 >"$out/meta.json" 2>"$out/meta.err"; echo $? >"$out/meta.exit"
git -c core.quotePath=false diff --binary --no-ext-diff --no-textconv ${DIFF_FLAGS} "$base" 2>/dev/null | sha256sum | cut -d' ' -f1 >"$out/full.sha"
exit 0`;

/** $1 the output directory, $2 the number of files, then the changed .rs files, then the affected crates. */
const CHECKS_SCRIPT = `set -f
out=$1; nf=$2; shift 2
files=("\${@:1:$nf}"); crates=("\${@:$((nf + 1))}")
p=(); for c in "\${crates[@]}"; do p+=(-p "$c"); done
if [ \${#files[@]} -gt 0 ]; then
  timeout 600 cargo fmt --all --check -- --color never >"$out/fmt.txt" 2>&1; echo $? >"$out/fmt.exit"
fi
if [ \${#crates[@]} -gt 0 ]; then
  timeout 3600 cargo clippy --offline --locked "\${p[@]}" --all-targets --message-format=json --color never -- -D warnings >"$out/clippy.json" 2>"$out/clippy.err"; echo $? >"$out/clippy.exit"
  timeout 1800 cargo test --offline --locked --no-fail-fast --color never "\${p[@]}" >"$out/tests.txt" 2>&1; echo $? >"$out/tests.exit"
  if [ "$(cat "$out/tests.exit")" != 0 ]; then
    names=$(sed -n 's/^test \\([^ ]*\\) \\.\\.\\. FAILED.*/\\1/p' "$out/tests.txt")
    if [ -n "$names" ]; then
      timeout 600 cargo test --offline --locked --no-fail-fast --color never "\${p[@]}" -- --exact $names >"$out/tests-rerun.txt" 2>&1; echo $? >"$out/tests-rerun.exit"
    fi
  fi
fi
exit 0`;

const CHANGES_LIMIT_SEC = 300;
const CHECKS_LIMIT_SEC = 7200;
const DIFF_MAX = 8 * 1024 * 1024;
const JSON_MAX = 16 * 1024 * 1024;
const TEXT_MAX = 4 * 1024 * 1024;
const RENDERED_CAP = 2000;
const FINDINGS_MAX = 50;

/** Cargo could not resolve or fetch a dependency offline: the change needs something the workspace does not hold (W9 seeds them). Only lines cargo prints itself count, not text inside a test's output. */
export const NEEDS_DEPENDENCY = /^(?:error: )?(?:no matching package named|failed to (?:download|load source for dependency|get `[^`]+` as a dependency)|failed to select a version for the requirement|unable to update registry)|^error: .*but --offline was specified/im;

// ---- reading the output --------------------------------------------------------------------------------------------

/** Every path the diff touches (old and new side), relative to the checkout. */
export function changedPaths(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm)) out.add(m[1]!.replace(/\t$/, ""));
  return [...out].sort();
}

/** "N files changed, +A -D" from a -U0 diff. */
export function statOf(diff: string): string {
  const files = new Set<string>();
  let add = 0, del = 0;
  for (const l of diff.split("\n")) {
    const f = /^diff --git a\/(.+) b\//.exec(l);
    if (f) files.add(f[1]!);
    else if (l.startsWith("+") && !l.startsWith("+++ ")) add++;
    else if (l.startsWith("-") && !l.startsWith("--- ")) del++;
  }
  return files.size ? `${files.size} file${files.size === 1 ? "" : "s"} changed, +${add} -${del}` : "no changes";
}

/** The workspace's crates from `cargo metadata --no-deps`: name and directory relative to the checkout ("." for the root). */
export function cratesOf(metadata: string): Crate[] {
  try {
    const m = JSON.parse(metadata) as { packages?: { name?: unknown; manifest_path?: unknown }[] };
    return (m.packages ?? []).flatMap((p) => {
      if (typeof p.name !== "string" || typeof p.manifest_path !== "string" || !p.manifest_path.startsWith(`${SRC_ROOT}/`)) return [];
      const dir = p.manifest_path.slice(SRC_ROOT.length + 1).replace(/\/?Cargo\.toml$/, "");
      return [{ name: p.name, dir: dir || "." }];
    });
  } catch {
    return [];
  }
}

/** The crates owning the changed paths: the crate with the longest directory prefix; root-level files beside a workspace manifest count for none. */
export function affectedCrates(paths: string[], crates: Crate[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    let best: Crate | null = null;
    for (const c of crates) if ((c.dir === "." || path === c.dir || path.startsWith(`${c.dir}/`)) && (!best || c.dir.length > best.dir.length)) best = c;
    if (best && !(best.dir === "." && !path.includes("/"))) names.add(best.name);
  }
  // The workspace's root manifest or lockfile changes every crate's build.
  if (paths.some((p) => p === "Cargo.toml" || p === "Cargo.lock")) for (const c of crates) names.add(c.name);
  return [...names].sort();
}

const rel = (p: string): string => (p.startsWith(`${SRC_ROOT}/`) ? p.slice(SRC_ROOT.length + 1) : p);
const cap = (s: string): string => s.trim().slice(0, RENDERED_CAP);

/** rustfmt's verdict on the changed files: one finding per file it would reformat or could not parse. */
export function fmtFindings(text: string, changed: ReadonlySet<string>): SessionFinding[] {
  const out = new Map<string, SessionFinding>();
  const blocks = text.split(/^(?=Diff in )/m);
  for (const b of blocks) {
    const m = /^Diff in (\S+?)(?::(\d+):| at line (\d+):)/.exec(b);
    if (!m) continue;
    const file = rel(m[1]!);
    if (!changed.has(file)) continue;
    const had = out.get(file);
    if (had) had.rendered = cap(`${had.rendered}\n${b}`);
    else out.set(file, { check: "fmt", file, line: Number(m[2] ?? m[3]), message: `rustfmt would reformat ${file}`, rendered: cap(b) });
  }
  for (const m of text.matchAll(/^error[^\n]*\n\s*--> ([^:\n]+):(\d+):\d+/gm)) {
    const file = rel(m[1]!);
    if (changed.has(file) && !out.has(file)) out.set(file, { check: "fmt", file, line: Number(m[2]), message: `rustfmt could not parse ${file}`, rendered: cap(m[0]) });
  }
  return [...out.values()];
}

const asFinding = (check: SessionFinding["check"], f: Finding): SessionFinding => ({ check, file: f.file, line: f.line, message: f.message, rendered: f.rendered });

export type CheckPart = { ran: boolean; exit: number | null; findings: number; note?: string; /** The check gave no verdict (timed out, killed, did not run). */ noVerdict?: boolean };

/** One round of checks, stored as the result of a `checks` round. */
export type CheckRound = {
  round: number;
  base: string;
  diffStat: string;
  files: string[];
  crates: string[];
  fmt: CheckPart; clippy: CheckPart; tests: CheckPart;
  /** What goes back to the session: format, clippy and test findings, the first FINDINGS_MAX. */
  findings: SessionFinding[];
  /** Why a check gave no verdict or passed only on a rerun: recorded, never sent back. */
  notes: string[];
  /** The checks that gave no verdict; the round is not clean while there are any. */
  noVerdict: string[];
  /** Hash of the whole workspace diff (the PR step's format) the checks ran on. */
  diffHash: string;
  /** Cargo could not resolve a dependency offline. */
  needsDependency: boolean;
  clean: boolean;
};

const exitOf = async (pod: Pod, path: string): Promise<number | null> => {
  const b = await pod.file(path, 64);
  const n = b === null ? NaN : Number(b.toString("utf8").trim());
  return Number.isInteger(n) ? n : null;
};
const textOf = async (pod: Pod, path: string, max = TEXT_MAX): Promise<string> => (await pod.file(path, max))?.toString("utf8") ?? "";

/** The change as it stands against `base`, for the checks and for the session's later turns. */
export async function changesOf(pod: Pod, dir: string, base: string): Promise<{ diff: string; paths: string[]; crates: Crate[]; metaError: string }> {
  const r = await pod.run("implement-changes", CHANGES_SCRIPT, [dir, base], CHANGES_LIMIT_SEC);
  if (r.exit !== 0) throw new Error(`reading the change failed (${r.state}${r.exit !== null ? ` ${r.exit}` : ""}): ${cap(await textOf(pod, `${dir}/diff.err`, 64 * 1024) || await textOf(pod, `${dir}/add.err`, 64 * 1024))}`);
  const diff = await textOf(pod, `${dir}/diff.txt`, DIFF_MAX);
  const metaExit = await exitOf(pod, `${dir}/meta.exit`);
  const crates = metaExit === 0 ? cratesOf(await textOf(pod, `${dir}/meta.json`, JSON_MAX)) : [];
  return { diff, paths: changedPaths(diff), crates, metaError: metaExit === 0 ? "" : await textOf(pod, `${dir}/meta.err`, 64 * 1024) };
}

/** Runs round `round` of the checks on the workspace's change against `base` and reads their verdict. */
export async function runChecks(pod: Pod, o: { dir: string; base: string; round: number }): Promise<CheckRound> {
  const ch = await changesOf(pod, o.dir, o.base);
  const rs = [...patchLines(ch.diff).keys()].filter((p) => p.endsWith(".rs")).sort();
  const crates = affectedCrates(ch.paths, ch.crates);
  const notes: string[] = [];
  let needsDependency = NEEDS_DEPENDENCY.test(ch.metaError);
  const noVerdict: string[] = [];
  const findings: SessionFinding[] = [];
  const manifests = ch.paths.filter((p) => /(?:^|\/)Cargo\.(?:toml|lock)$/.test(p));
  if (ch.metaError && !needsDependency && (rs.length || manifests.length)) {
    findings.push({ check: "clippy", file: manifests[0] ?? rs[0]!, line: 0, message: "cargo metadata failed, so the crates cannot be checked", rendered: cap(ch.metaError) });
  }
  const part = (ran: boolean): CheckPart => ({ ran, exit: null, findings: 0 });
  const fmt = part(rs.length > 0), clippy = part(crates.length > 0), tests = part(crates.length > 0);
  if (fmt.ran || clippy.ran) {
    const r = await pod.run("implement-checks", CHECKS_SCRIPT, [o.dir, String(rs.length), ...rs, ...crates], CHECKS_LIMIT_SEC);
    if (r.state !== "exited" || r.exit !== 0) {
      notes.push(`the checks ${r.state} before they finished`);
      noVerdict.push("the checks script did not finish");
    }
  }
  if (fmt.ran) {
    fmt.exit = await exitOf(pod, `${o.dir}/fmt.exit`);
    const text = await textOf(pod, `${o.dir}/fmt.txt`);
    const f = fmtFindings(text, new Set(rs));
    fmt.findings = f.length;
    findings.push(...f);
    // Exit 1 is a format result only with rustfmt's diff blocks (or a parse error it located); anything else did not run.
    const verdict = fmt.exit === 0 || (fmt.exit === 1 && (/^Diff in /m.test(text) || f.length > 0));
    if (!verdict && !f.length) {
      fmt.noVerdict = true;
      const why = `cargo fmt gave no verdict (exit ${fmt.exit ?? "none"}): ${cap(text).split("\n")[0] ?? ""}`;
      notes.push(fmt.note = why);
      noVerdict.push(why);
    }
  }
  if (clippy.ran) {
    clippy.exit = await exitOf(pod, `${o.dir}/clippy.exit`);
    const err = await textOf(pod, `${o.dir}/clippy.err`);
    if (NEEDS_DEPENDENCY.test(err)) {
      needsDependency = true;
      clippy.note = "a dependency is not available offline";
    } else if (clippy.exit === 124) {
      notes.push(clippy.note = "clippy timed out");
      clippy.noVerdict = true;
      noVerdict.push("clippy timed out");
    } else {
      const f = findingsOf(await textOf(pod, `${o.dir}/clippy.json`, JSON_MAX), err, ch.diff).map((x) => asFinding("clippy", x));
      clippy.findings = f.length;
      findings.push(...f);
      if (clippy.exit === null || clippy.exit === 137) {
        clippy.noVerdict = true;
        noVerdict.push(clippy.note = clippy.exit === 137 ? "clippy was killed (out of memory)" : "clippy did not run");
      }
    }
  }
  if (tests.ran && !needsDependency) {
    tests.exit = await exitOf(pod, `${o.dir}/tests.exit`);
    const text = await textOf(pod, `${o.dir}/tests.txt`);
    const rerunExit = await exitOf(pod, `${o.dir}/tests-rerun.exit`);
    const c = classifyTests({ text: tests.exit === null ? null : text, exit: tests.exit, rerunText: rerunExit === null ? null : await textOf(pod, `${o.dir}/tests-rerun.txt`), rerunExit, timedOut: tests.exit === 124 });
    if (NEEDS_DEPENDENCY.test(text)) needsDependency = true;
    else if (c.kind === "failed") {
      const f = testFindings(c).map((x) => asFinding("test", x));
      tests.findings = f.length;
      findings.push(...f);
    } else if (c.kind === "inconclusive") {
      notes.push(tests.note = c.note);
      // A test that failed and then passed on rerun is a clean round with a note.
      if (!c.note.startsWith("flaky:")) {
        tests.noVerdict = true;
        noVerdict.push(c.note);
      }
    }
  }
  const kept = findings.slice(0, FINDINGS_MAX);
  return {
    round: o.round, base: o.base, diffStat: statOf(ch.diff), files: rs, crates, fmt, clippy, tests, findings: kept, notes, noVerdict, diffHash: (await textOf(pod, `${o.dir}/full.sha`, 128)).trim(), needsDependency,
    clean: !kept.length && !needsDependency && !noVerdict.length,
  };
}

/** The round's checks as the PR body lists them (CheckLine in the PR step's template). */
export function checkLines(c: CheckRound): { name: string; ok: boolean; detail?: string | null }[] {
  const line = (name: string, p: CheckPart, skipped: string) => ({ name, ok: p.ran && p.findings === 0 && !p.noVerdict, detail: p.ran ? p.note ?? null : skipped });
  const crates = c.crates.length ? ` (${c.crates.join(", ")})` : "";
  return [
    line("cargo fmt --check", c.fmt, "no Rust file changed"),
    line(`cargo clippy on the changed lines${crates}`, c.clippy, "no crate affected"),
    line(`cargo test${crates}`, c.tests, "no crate affected"),
  ];
}
