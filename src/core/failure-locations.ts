// The places a CI failure log names: compiler errors (`error...` followed by `--> file:line`) and Rust panics
// (`panicked at file:line`). Read by the batch trace, the CI fix and Fix red main. The log is untrusted: only paths that
// look like plain repo paths are kept, and a test name only when it is a Rust path.

export type Location = { file: string; line: number; what: "error" | "panic" };
/** A location with the test whose thread panicked there (`thread '<test>' panicked at`), when the log names one. */
export type TestLocation = Location & { test: string | null };

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const ARROW = /^\s*-->\s+(\S+?):(\d+)(?::\d+)?\s*$/;
// `thread 'x' panicked at src/a.rs:3:5:` (Rust 1.73 on) and `panicked at 'msg', src/a.rs:3:5` (before).
// The path may start with a Windows drive (`D:\a\app\app\src\a.rs:3:5`); its colon is not the line's.
const PANIC = /panicked at (?:'.*?', |".*?", )?((?:[A-Za-z]:)?[^\s:'"]+\.rs):(\d+)(?::\d+)?/;
// Newer toolchains print the thread id: `thread 'a::tests::b' (437684) panicked at`.
const THREAD = /thread '([^'\n]*)'(?: \(\d+\))? panicked at /;
const TEST_NAME = /^[A-Za-z_]\w*(::[A-Za-z_]\w*)*$/;
const ERROR = /^\s*error(\[E\d+\])?:/;
/**
 * A runner's checkout prefix (`/home/runner/work/<repo>/<repo>/`, `D:\a\<repo>\<repo>\`), cut so the path is the repo's.
 * Only an absolute path has one: a relative path such as `crates/work/x/y/lib.rs` is already the repo's.
 */
const CHECKOUT = /^(?:\/|[A-Za-z]:[/\\])(?:.*?[/\\])?(?:work|a)[/\\][^/\\]+[/\\][^/\\]+[/\\]/;

/** A path inside the repo, or null: relative, no `..`, no option-like or odd characters, not a dependency's source. */
export function repoPath(raw: string): string | null {
  const p = raw.replace(CHECKOUT, "").replace(/\\/g, "/");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,250}$/.test(p)) return null;
  if (p.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  if (/(^|\/)(\.cargo|\.rustup|target)\//.test(p)) return null;
  return p;
}

/** The error and panic locations of a failure's log text, first seen first, without repeats; at most `max`. */
export function failureLocations(text: string, max = Infinity): Location[] {
  return testLocations(text, max).places.map((l) => ({ file: l.file, line: l.line, what: l.what }));
}

/**
 * failureLocations with the panicking test's name (`main`, no test thread, and names that are no Rust path are null), and
 * whether more than `max` were named (`capped`).
 */
export function testLocations(text: string, max = Infinity): { places: TestLocation[]; capped: boolean } {
  const out: TestLocation[] = [];
  const seen = new Set<string>();
  let capped = false;
  const add = (raw: string, line: string, what: Location["what"], test: string | null) => {
    const file = repoPath(raw);
    const n = Number(line);
    if (!file || !Number.isInteger(n) || n < 1) return;
    const key = `${file}:${n}`;
    if (seen.has(key)) return;
    if (out.length >= max) { capped = true; return; }
    seen.add(key);
    out.push({ file, line: n, what, test });
  };
  let sinceError = Infinity;
  for (const line of text.replace(ANSI, "").split(/\r?\n/)) {
    sinceError = ERROR.test(line) ? 0 : sinceError + 1;
    const p = PANIC.exec(line);
    if (p) {
      const name = THREAD.exec(line)?.[1] ?? null;
      add(p[1]!, p[2]!, "panic", name && name !== "main" && TEST_NAME.test(name) ? name : null);
    }
    // A `-->` belongs to the diagnostic above it; only an error's counts (a warning names lines that compiled).
    const a = ARROW.exec(line);
    if (a && sinceError <= 3) add(a[1]!, a[2]!, "error", null);
  }
  return { places: out, capped };
}
