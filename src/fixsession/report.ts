// The report a fix session's turn ends with, and the limits of a fix session's calls. No Node imports: the prompts
// module, which the web mockup imports, reads the limits.
import { wholeReplyJson } from "../core/reply-json.ts";
import { REPORT_LIST_MAX, REPORT_TEXT_MAX } from "../implement/session-input.ts";
import { FIX_SUMMARY_MAX, FIX_TITLE_MAX } from "../security/rules.ts";

export { REPORT_LIST_MAX, REPORT_TEXT_MAX };

/** A first or fresh turn's limits; a follow-up turn (checks, lint, undo, report) has FIX_FOLLOW_UP_CALL's. */
export const FIX_SESSION_CALL = { timeoutSeconds: 90 * 60, maxTurns: 400 } as const;
export const FIX_FOLLOW_UP_CALL = { timeoutSeconds: 45 * 60, maxTurns: 200 } as const;
/** Follow-ups with AutoCraft's own check findings per step. */
export const CHECK_FOLLOW_UPS = 2;
/** Bytes of the diff read back from the pod: a transport bound, not a scope rule. */
export const SESSION_DIFF_MAX_BYTES = 5 * 1024 * 1024;
/** Where a fix session's workspace holds the default branch's maintainer documents (AGENTS.txt): outside /work/src, so the PR cannot change them and they are not part of the diff. */
export const SESSION_REPO_DOCS = "/work/repo-docs";

/**
 * done: the tree holds the change. none: nothing needed changing, or the step has no cause it can fix in the files it
 * allows. blocked: the session could not finish (blocked_reason says why).
 */
export type FixStatus = "done" | "none" | "blocked";
export type FixReport = {
  status: FixStatus;
  summary: string;
  changes: string[];
  tests_run: { command: string; exit: number }[];
  blocked_reason?: string;
};
/** A security fix's report also carries the pull request's title; its summary is the pull request's summary. */
export type SecurityReport = FixReport & { title?: string };

const KEYS = new Set(["status", "summary", "changes", "tests_run", "blocked_reason"]);
const SECURITY_KEYS = new Set([...KEYS, "title"]);

const strings = (v: unknown, key: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > REPORT_LIST_MAX || !v.every((x) => typeof x === "string" && x.length <= REPORT_TEXT_MAX)) throw new Error(`${key} must be a list of at most ${REPORT_LIST_MAX} texts`);
  return (v as string[]).map((x) => x.trim()).filter(Boolean);
};

function read(text: string, security: boolean): SecurityReport {
  const v = wholeReplyJson(text);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("the reply is not one JSON object");
  const o = v as Record<string, unknown>;
  const keys = security ? SECURITY_KEYS : KEYS;
  const extra = Object.keys(o).filter((k) => !keys.has(k));
  if (extra.length) throw new Error(`unknown keys: ${extra.join(", ")}`);
  const statuses = security ? ["done", "blocked"] : ["done", "none", "blocked"];
  if (typeof o.status !== "string" || !statuses.includes(o.status)) throw new Error(`status must be ${statuses.join(", ").replace(/, (?=[^,]*$)/, " or ")}`);
  const status = o.status as FixStatus;
  const summaryMax = security ? FIX_SUMMARY_MAX : REPORT_TEXT_MAX;
  if (typeof o.summary !== "string" || !o.summary.trim() || o.summary.length > summaryMax) throw new Error(`summary must be a text of at most ${summaryMax} characters`);
  const tests = o.tests_run ?? [];
  if (!Array.isArray(tests) || tests.length > REPORT_LIST_MAX || !tests.every((t) => typeof t?.command === "string" && Number.isInteger(t?.exit))) throw new Error("tests_run must be a list of {command, exit}");
  if (o.blocked_reason !== undefined && typeof o.blocked_reason !== "string") throw new Error("blocked_reason must be a text");
  if (status === "blocked" && !(o.blocked_reason as string | undefined)?.trim()) throw new Error("a blocked report needs blocked_reason");
  if (o.title !== undefined && (typeof o.title !== "string" || o.title.length > FIX_TITLE_MAX)) throw new Error(`title must be a text of at most ${FIX_TITLE_MAX} characters`);
  if (security && status === "done" && !(o.title as string | undefined)?.trim()) throw new Error("a done report needs title");
  return {
    status, summary: o.summary.trim(), changes: strings(o.changes, "changes"),
    tests_run: (tests as { command: string; exit: number }[]).map((t) => ({ command: t.command.slice(0, 500), exit: t.exit })),
    ...(status === "blocked" && { blocked_reason: (o.blocked_reason as string).trim().slice(0, REPORT_TEXT_MAX) }),
    ...(typeof o.title === "string" && o.title.trim() && { title: o.title.trim() }),
  };
}

/** A fix session's report (fix.session), read strictly: one JSON object, fenced or not, with only the report's keys. */
export function parseFixReport(text: string): { report: FixReport } | { error: string } {
  try { return { report: read(text, false) }; } catch (e) { return { error: (e as Error).message }; }
}

/** A security fix session's report (security.session): the same keys plus title; status done or blocked; done needs a title. */
export function parseSecurityReport(text: string): { report: SecurityReport } | { error: string } {
  try { return { report: read(text, true) }; } catch (e) { return { error: (e as Error).message }; }
}
