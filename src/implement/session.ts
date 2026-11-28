// The implementation session (D4): Opus with the workspace tools in the attempt's workspace, bound to the queuer's Task
// Runner in one of its normal slots (D10). One call is one turn: the first session, a fresh session that starts over, or a
// follow-up on the same harness session (parentId, keepSession). Each turn is a round from the moment it is queued (its
// purpose and call), settled when the call returns: the reply parsed strictly as the SessionReport, then the screenshots
// it names copied out. A report's summary is reply-linted, with problems sent back as a lint turn of its own.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { Db } from "../db/index.ts";
import { loadEnvs } from "../data/build/index.ts";
import { loadImplementationView } from "../data/implement/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadCallPrompt } from "../data/runners/index.ts";
import { ensurePrompts } from "../data/prompts/index.ts";
import { artifactDir } from "../build/artifacts.ts";
import { settingsOf } from "../build/pods.ts";
import { resumePrompt, type WorkspaceCallRequest } from "../build/workspace-call.ts";
import type { RoundStore } from "../build/session-turns.ts";
import { WORKSPACE_SERVER } from "../build/workspace-tools.ts";
import { WORK_ROOT } from "../build/workspace-tool-specs.ts";
import { cleanOutput } from "../build/workspaces.ts";
import { wholeReplyJson } from "../core/reply-json.ts";
import { CLAUDE_PROMPTS, claudeParts, resolvedTemplate } from "../prompts/index.ts";
import { promptTier } from "../remote/bundle.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, referenceProblems } from "../reference-lint.ts";
import { fixTurnMessage, mergeFixFields, needsFixTurn, type LintProblem } from "../replylint.ts";
import type { Pod } from "./checks.ts";
import { FOLLOW_UP_CALL, REPORT_LIST_MAX, REPORT_SHOTS_MAX, REPORT_TEXT_MAX, SESSION_CALL, SAMPLE_SESSION, SESSION_SERVER, type SessionFinding, type SessionInput } from "./session-input.ts";
import { addRounds, setRound } from "./attempt.ts";
import { attemptGuidance } from "./stuck.ts";
import type { Implementation, ImplementationRound, SessionReport } from "./types.ts";

// The prompt names the tool server; this fails to compile when the two differ.
const SERVER: typeof WORKSPACE_SERVER = SESSION_SERVER;

export const SESSION_PROMPT_ID = "implement.session";
const PROMPT = CLAUDE_PROMPTS[SESSION_PROMPT_ID];
/** The model of every turn. */
export const SESSION_MODEL = PROMPT.models[0]!;
/** A lease lost with its Task Runner goes back to the queue once, onto the same workspace (D8). */
const CALL_ATTEMPTS = 2;
/** Bytes of a screenshot copied out at most. */
const SHOT_MAX_BYTES = 10 * 1024 * 1024;
const SHOT_EDGE_MAX = 16384;
/** Characters of the issue body the task carries; the plan already read the whole issue. */
const ISSUE_BODY_MAX = 20_000;

/** Why a turn was made: the first session, a session that starts over (after a failed call, or with its harness session lost), the checks' findings, a reply that was not the report (or was lost), the summary's lint, or a revision of our open PR (the review's fixes or red CI). */
export type TurnPurpose = "start" | "retry" | "fresh" | "findings" | "report" | "lint" | "revise";

/** A screenshot of the report, copied out of the workspace: `file` is under the artifact directory. */
export type StoredShot = { n: number; what: string; file: string; bytes: number; width: number; height: number };

/**
 * The result of a `session` or `follow-up` round. `queued`: the call is not read yet. `withdrawn`: the call ended without
 * its turn being worked (no Task Runner took it, the pipeline stopped, or no job read it); the turn is made again.
 */
export type TurnRound = {
  purpose: TurnPurpose;
  outcome: "queued" | "done" | "failed" | "unclaimed" | "withdrawn";
  /** The call whose harness session the turn goes on. */
  parentId?: number;
  /** A lint turn: the report its reply's fields go into, and the problems it was sent. */
  base?: SessionReport;
  problems?: LintProblem[];
  error?: string;
  report: SessionReport | null;
  /** Why the reply is not the report. */
  parseError?: string;
  /** The reply was read and lost before its round was written. */
  lost?: boolean;
  turns: number | null;
  costUsd: number | null;
  calls: number;
  shellMs: number;
  shots: StoredShot[];
  /** Why a named screenshot was not copied. */
  shotErrors: string[];
  /** The turn's workspace_sessions row. */
  session?: number;
};

export type TurnRequest = {
  impl: Implementation;
  workspaceId: number;
  purpose: TurnPurpose;
  stdin: string;
  /** A follow-up turn on this call's session. */
  parentId?: number;
  /** A lint fix turn: the report its reply's fields go into, and the problems it was sent. */
  base?: SessionReport;
  problems?: LintProblem[];
  /** A new session's system prompts and version, rendered with its stdin (sessionTask), so all three are one revision. */
  prompt?: SessionPrompt;
};

// ---- the input ---------------------------------------------------------------------------------------------------

/** The session's task for the attempt, from its stored plan. */
export async function sessionInput(db: Db, impl: Implementation, sha: string, earlier?: SessionInput["earlier"]): Promise<SessionInput> {
  if (!impl.plan) throw new Error(`implementation ${impl.id} has no plan`);
  const ref = `${impl.repo}#${impl.number}` as const;
  const [items, view] = await db.together(() => Promise.all([loadItems(db, [impl], "text"), loadImplementationView(db, ref)]));
  const it = items.get(ref);
  const p = impl.plan;
  return {
    ref: `${impl.repo}#${impl.number}`, repo: impl.repo, sha,
    issue: { title: it?.title ?? "", body: (it?.body ?? "").slice(0, ISSUE_BODY_MAX), author: it?.author ?? null },
    plan: { kind: p.kind, summary: p.summary, plan: impl.planMd ?? p.plan, acceptance: p.acceptance, tests: p.verification.tests, app: p.verification.app, risks: p.risks },
    guidance: view?.impl.id === impl.id ? attemptGuidance(view.rounds).map((g) => g.text) : [],
    ...(earlier && { earlier }),
  };
}

/** The fixed system prompt (the same for every turn, so it caches), the task on stdin, and the version the turn records. */
export const renderSession = (input: SessionInput): { system: string; stdin: string; version: string } => {
  const p = claudeParts(SESSION_PROMPT_ID, [input], false), r = resolvedTemplate(SESSION_PROMPT_ID);
  // The code default's version also hashes the tool server's name, which the prompt names; a stored edit records its revision's version.
  return { system: p.system ?? "", stdin: p.stdin, version: r.edited ? r.version : createHash("sha256").update(r.text).update(SERVER).digest("hex").slice(0, 10) };
};
/** The system prompt as it runs now, with fetch_dependencies (the workspace's environment has a crate mirror) or without, and its version. */
const systemOf = (mirror: boolean): { system: string; version: string } => renderSession({ ...SAMPLE_SESSION[0]!, ...(mirror && { fetch_dependencies: true }) });

/** The two system prompts of a new session (queueTurn picks one by the workspace's environment) and the version both record. */
export type SessionPrompt = { version: string; mirror: string; none: string };

/** A new session's task on stdin and its system prompts, from the prompt revisions as they are now. */
export async function sessionTask(db: Db, input: SessionInput): Promise<{ stdin: string; prompt: SessionPrompt }> {
  await ensurePrompts(db);
  const task = renderSession(input), mirror = systemOf(true), none = systemOf(false);
  return { stdin: task.stdin, prompt: { version: task.version, mirror: mirror.system, none: none.system } };
}

/** Whether environment `envId` has a crate mirror, so its session may fetch dependencies. */
async function hasCrateMirror(db: Db, envId: string | undefined): Promise<boolean> {
  if (!envId) return false;
  const [env] = await loadEnvs(db, { ids: [envId] });
  // The loader parses the settings column; settingsOf reads it as stored.
  return settingsOf(env?.settings == null ? null : typeof env.settings === "string" ? env.settings : JSON.stringify(env.settings)).crateMirror !== null;
}

const findingsJson = (f: SessionFinding[]): string => JSON.stringify(f, null, 1).replace(/</g, "\\u003c");

/** The follow-up turn with the findings of AutoCraft's checks. Fixed text around the list, so the cache covers the rest. */
export const findingsMessage = (findings: SessionFinding[]): string =>
  `AutoCraft ran its own checks on the changes in /work/src: cargo fmt, clippy on the changed lines and the tests of the affected crates. They found the problems below. Fix them, run the checks again yourself, and reply with the JSON report as before.\n\n<findings>\n${findingsJson(findings)}\n</findings>`;

export const REPORT_MESSAGE = "Your last reply was not the JSON report. Do not use tools. Reply with only the JSON report object, as the instructions describe.";
/** The report turn after a reply AutoCraft lost in a restart. */
export const LOST_REPLY_MESSAGE = "AutoCraft did not receive your last reply. Do not use tools. Reply with only the JSON report object for the work so far, as the instructions describe.";

// ---- the report --------------------------------------------------------------------------------------------------

const REPORT_KEYS = new Set(["status", "summary", "changes", "tests_run", "shots", "deviations", "blocked_reason"]);
const strings = (v: unknown, key: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > REPORT_LIST_MAX || !v.every((x) => typeof x === "string" && x.length <= REPORT_TEXT_MAX)) throw new Error(`${key} must be a list of at most ${REPORT_LIST_MAX} texts`);
  return v as string[];
};

/** The session's report, read strictly: one JSON object (fenced or not) with only the report's keys. */
export function parseReport(text: string): { report: SessionReport } | { error: string } {
  const v = wholeReplyJson(text);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { error: "the reply is not one JSON object" };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !REPORT_KEYS.has(k));
  try {
    if (extra.length) throw new Error(`unknown keys: ${extra.join(", ")}`);
    if (o.status !== "done" && o.status !== "blocked") throw new Error("status must be done or blocked");
    if (typeof o.summary !== "string" || !o.summary.trim() || o.summary.length > REPORT_TEXT_MAX) throw new Error(`summary must be a text of at most ${REPORT_TEXT_MAX} characters`);
    const tests = o.tests_run ?? [];
    if (!Array.isArray(tests) || tests.length > REPORT_LIST_MAX || !tests.every((t) => typeof t?.command === "string" && Number.isInteger(t?.exit))) throw new Error("tests_run must be a list of {command, exit}");
    const shots = o.shots ?? [];
    if (!Array.isArray(shots) || shots.length > REPORT_SHOTS_MAX || !shots.every((s) => Number.isInteger(s?.n) && s.n > 0 && typeof s?.what === "string")) throw new Error(`shots must be at most ${REPORT_SHOTS_MAX} {n, what}`);
    if (o.status === "blocked" && (typeof o.blocked_reason !== "string" || !o.blocked_reason.trim())) throw new Error("a blocked report needs blocked_reason");
    if (o.blocked_reason !== undefined && typeof o.blocked_reason !== "string") throw new Error("blocked_reason must be a text");
    return {
      report: {
        status: o.status, summary: o.summary.trim(), changes: strings(o.changes, "changes"),
        tests_run: (tests as { command: string; exit: number }[]).map((t) => ({ command: t.command.slice(0, 500), exit: t.exit })),
        shots: (shots as { n: number; what: string }[]).map((s) => ({ n: s.n, what: s.what.slice(0, 300) })),
        deviations: strings(o.deviations, "deviations"),
        ...(typeof o.blocked_reason === "string" && { blocked_reason: o.blocked_reason.slice(0, REPORT_TEXT_MAX) }),
      },
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A report blocked for want of a dependency (the prompt asks for a reason that starts so). */
export const needsDependency = (r: SessionReport): boolean => r.status === "blocked" && /^needs? (a )?dependenc/i.test(r.blocked_reason ?? "");

// ---- screenshots ---------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height of a PNG whose signature and IHDR chunk (length, type, CRC, sizes, bit depth and colour type) check out; else null. */
export function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  if (crc32(b.subarray(12, 29)) !== b.readUInt32BE(29)) return null;
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20), depth = b[24]!, colour = b[25]!;
  if (width < 1 || height < 1 || width > SHOT_EDGE_MAX || height > SHOT_EDGE_MAX) return null;
  if (![1, 2, 4, 8, 16].includes(depth) || ![0, 2, 3, 4, 6].includes(colour)) return null;
  return { width, height };
}

/** Writes a checked screenshot under the artifact directory, named by its hash; returns its path there. */
function storeShot(implementationId: number, b: Buffer): string {
  const rel = join("implementations", String(implementationId), `${createHash("sha256").update(b).digest("hex").slice(0, 32)}.png`);
  const full = join(artifactDir(), rel);
  mkdirSync(join(artifactDir(), "implementations", String(implementationId)), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  writeFileSync(tmp, b);
  renameSync(tmp, full);
  return rel;
}

/** Copies the report's screenshots out of the workspace after the PNG checks. */
export async function copyShots(pod: Pod, implementationId: number, report: SessionReport): Promise<{ shots: StoredShot[]; errors: string[] }> {
  const shots: StoredShot[] = [], errors: string[] = [];
  for (const s of report.shots.slice(0, REPORT_SHOTS_MAX)) {
    const path = `${WORK_ROOT}/.ws/shots/${s.n}.png`;
    try {
      const b = await pod.file(path, SHOT_MAX_BYTES);
      const size = b && pngSize(b);
      if (!b) errors.push(`shot ${s.n}: no ${path}`);
      else if (!size) errors.push(`shot ${s.n}: ${path} is not a valid PNG`);
      else shots.push({ n: s.n, what: s.what, file: storeShot(implementationId, b), bytes: b.length, ...size });
    } catch (e) {
      errors.push(`shot ${s.n}: ${cleanOutput(Buffer.from((e as Error).message)).slice(0, 200)}`);
    }
  }
  return { shots, errors };
}

// ---- one turn ------------------------------------------------------------------------------------------------------

/** The stdin of a session that goes again after its call failed: the task with AutoCraft's note on what the workspace kept. */
export const retryStdin = async (db: Db, failedCallId: number, stdin: string): Promise<string> => await resumePrompt(db, failedCallId, stdin);

/** The implementation rounds the turn mechanics (src/build/session-turns.ts) read and write. */
export const implementRounds: RoundStore<TurnRound, ImplementationRound, TurnRequest, { pinned: Awaited<ReturnType<typeof loadCallPrompt>> }, Pod> = {
  sessionKind: "implement",
  async beforeWrite(db, t) {
    const follow = t.parentId !== undefined;
    // A follow-up keeps its session's system prompt and version, so a prompt saved meanwhile reaches only new sessions.
    const pinned = follow ? await loadCallPrompt(db, t.parentId!) : null;
    if (!t.prompt && pinned?.system == null) await ensurePrompts(db);
    return { pinned };
  },
  async plan(db, t, { pinned }, w) {
    const follow = t.parentId !== undefined;
    const limits = follow ? FOLLOW_UP_CALL : SESSION_CALL;
    const mirror = await hasCrateMirror(db, w?.env_id ?? undefined);
    const { system, version } = pinned?.system != null ? { system: pinned.system, version: pinned.promptVersion }
      : t.prompt ? { system: mirror ? t.prompt.mirror : t.prompt.none, version: t.prompt.version } : systemOf(mirror);
    const call: WorkspaceCallRequest = {
      workspaceId: t.workspaceId, promptId: SESSION_PROMPT_ID, promptVersion: version, model: SESSION_MODEL, tier: promptTier(SESSION_PROMPT_ID), effort: PROMPT.effort,
      stdin: t.stdin, system, timeoutSeconds: limits.timeoutSeconds, maxTurns: limits.maxTurns, items: [{ repo: t.impl.repo, number: t.impl.number }],
      maxAttempts: CALL_ATTEMPTS, keepSession: true, ...(follow && { parentId: t.parentId }), forLogin: t.impl.queuedBy, boundSlot: true,
    };
    const result: TurnRound = {
      purpose: t.purpose, outcome: "queued", report: null, turns: null, costUsd: null, calls: 0, shellMs: 0, shots: [], shotErrors: [],
      ...(follow && { parentId: t.parentId }), ...(t.base && { base: t.base, problems: t.problems ?? [] }),
    };
    return {
      call, owner: t.impl.id, kind: follow ? "follow-up" : "session", result,
      session: { repo: t.impl.repo, item: t.impl.number, baseSha: t.impl.baseSha ?? "", requestedBy: t.impl.queuedBy, deadlineSec: limits.timeoutSeconds },
    };
  },
  async add(db, owner, round, at) {
    const kind = round.kind as ImplementationRound["kind"];
    const [id] = await addRounds(db, owner, [{ kind, callId: round.callId, result: round.result }], at);
    return { id: id!, implementationId: owner, kind, callId: round.callId, result: round.result, at };
  },
  async set(db, round, result) { await setRound(db, round.implementationId, round.id, result); },
  parse(queued, text) {
    const merged = queued.base ? mergeFixFields(JSON.stringify(queued.base), text, queued.problems ?? []) : text;
    return merged === null ? { error: "the fix reply is not a JSON object with the asked fields" } : parseReport(merged);
  },
  async afterReply(_db, pod, round, r) {
    // A lint turn's report carries the main turn's screenshots, which that turn copied.
    if (pod && r.report?.shots.length && r.purpose !== "lint") {
      const c = await copyShots(pod, round.implementationId, r.report);
      r.shots = c.shots;
      r.shotErrors = c.errors;
    }
  },
};

// ---- the summary's reply lint ----------------------------------------------------------------------------------------

/** Problems of the report's summary, which goes into the PR body: it may not mention, quote or point to the reference documentation. */
export async function summaryProblems(db: Db, impl: Implementation, summary: string, stage: "first" | "fix"): Promise<LintProblem[]> {
  return await referenceProblems([{ field: "summary", text: summary }], referenceDir(impl.repo), defaultSemanticDeps(db, `${impl.repo}#${impl.number}`, { forLogin: impl.queuedBy }), { stage });
}

/** The lint turn a report's summary goes back to the session with, or null when the summary has nothing to fix. */
export async function summaryFixTurn(db: Db, impl: Implementation, report: SessionReport): Promise<{ stdin: string; problems: LintProblem[] } | null> {
  const first = await summaryProblems(db, impl, report.summary, "first");
  return needsFixTurn(first) ? { stdin: fixTurnMessage(first), problems: first } : null;
}

/** The report a settled lint turn leaves: its fixed summary when that has no problems left, else a fixed line in place of the summary. */
export async function lintedReport(db: Db, impl: Implementation, lint: TurnRound, log: (line: string) => void): Promise<SessionReport> {
  const base = lint.base!;
  const fixed = lint.outcome === "done" ? lint.report?.summary : undefined;
  if (fixed && !(await summaryProblems(db, impl, fixed, "fix")).length) return { ...base, summary: fixed };
  log("the report's summary still refers to outside documentation after the fix turn; a fixed line replaces it");
  return { ...base, summary: `Implements #${impl.number}.` };
}
