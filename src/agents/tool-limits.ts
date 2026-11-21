// Limits of the file tools (src/agents/filetools.ts) and of the Grep worker that runs a model's pattern.
// In their own module so the parent and the worker do not import each other's code.

/** Files a Read may show: one file bigger than this is refused (a diff or a log the model should read in parts). */
export const READ_MAX_BYTES = 8 << 20;
/** Lines a Read returns without `limit`. */
export const READ_DEFAULT_LINES = 2_000;
/** Files a Glob or Grep walk visits, so a huge tree cannot make one tool call unbounded. */
export const WALK_MAX_FILES = 20_000;
/** Paths a Glob returns. */
export const GLOB_MAX = 1_000;
/** Matches a Grep returns. */
export const GREP_MAX = 200;
/** Bytes of one file a Grep reads. */
export const GREP_FILE_MAX_BYTES = 2 << 20;
/** Characters of one line a tool returns; longer lines are cut. */
export const LINE_MAX = 2_000;
/** Longest a Grep may run: its worker is stopped after it. */
export const GREP_TIMEOUT_MS = 5_000;
