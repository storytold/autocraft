// The turns of a fix session's step (fix-sessions plan §2): the workspace made ready at the step's commit, the step's task as the
// first turn of a harness session or as a message on the live one, AutoCraft's checks in the pod with their findings sent back,
// the change read from the pod as a diff, and the step's gates, with one undo turn for a refused change. A follow-up whose harness
// session is gone (its Task Runner did not take it, or its call failed) goes to a fresh session that gets the task, the earlier
// turns and what the tree holds. The step's caller applies, checks, lints and pushes the change it returns; nothing here does.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ItemRef } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import { loadRepos } from "../data/mirror/index.ts";
import { ensurePrompts, guidanceOf } from "../data/prompts/index.ts";
import { loadCallPrompt, loadCallUsage } from "../data/runners/index.ts";
import { awaitTurn, queueTurn, realCalls, settleOrphan, type CallDeps, type RoundStore, type TurnResult } from "../build/session-turns.ts";
import { resumePrompt, type WorkspaceCallRequest } from "../build/workspace-call.ts";
import { WORK_ROOT } from "../build/workspace-tool-specs.ts";
import { describeHeader, execWs } from "../build/workspaces.ts";
import { runChecks, statOf, workspacePod, type CheckRound, type Pod } from "../implement/checks.ts";
import { workspaceDiff } from "../implement/diff.ts";
import { CLAUDE_PROMPTS, claudeParts } from "../prompts/index.ts";
import { promptTier } from "../remote/bundle.ts";
import { repoDocsFor } from "../sandbox/repo-docs.ts";
import { runGate, type GateOk, type StepGate } from "./gates.ts";
import {
  checksMessage, LOST_REPLY_MESSAGE, REPORT_MESSAGE, stepMessage, undoMessage,
  type FixSessionTask, type FixStep as TaskStep, type HistoryNote, type HistoryTurn, type StepTurn,
} from "./messages.ts";
import { FIX_FOLLOW_UP_CALL, FIX_SESSION_CALL, parseFixReport, parseSecurityReport, SESSION_DIFF_MAX_BYTES, SESSION_REPO_DOCS, type SecurityReport } from "./report.ts";
import {
  addTurn, endSession, ensureSession, lastTurn, loadSessions, SESSION_MAX_TURNS, settleTurn, turnsOf, updateSession,
  type FixSession, type FixStep, type FixTurn, type FixTurnPurpose,
} from "./store.ts";
import { ensureWorkspace, WORKSPACE_SESSION_KIND, type FixWorkspaceEnv } from "./workspace.ts";

export type FixPromptId = "fix.session" | "security.session";
/** The step a turn works for, with a maintainer's `fix <instructions>` apart from the review's fixes. */
export type GateStep = TaskStep | "security";

/** A lease lost with its Task Runner goes back to the queue once, onto the same workspace. */
const CALL_ATTEMPTS = 2;
/** Follow-ups with AutoCraft's own check findings per step. */
export const CHECK_FOLLOW_UPS = 2;
/** A turn whose call read more input than this (the context it carried) is the session's last: the next turn starts a fresh one. */
export const FRESH_INPUT_TOKENS = 400_000;
/** Turns one step sends at most, whatever their outcomes. */
const STEP_TURNS_MAX = 10;
/** Calls in a row that end without a reply before the step fails. */
const MISSES_MAX = 2;
const AGENTS_FILE = `${SESSION_REPO_DOCS}/AGENTS.txt`;
/** The reasons of a diff that was read but cannot be used (workspaceDiff, collectDiff): the change is refused, not the step failed. */
const CHANGE_REFUSAL = /over \d+ MiB|not UTF-8/;

/** The stored step of a turn: a maintainer's fix is a fix-up. */
export const storedStep = (s: GateStep): FixStep => (s === "maintainer" ? "fixup" : s);

export type FixTurnResult = TurnResult<SecurityReport> & { step: FixStep; head: string; parentId?: number };
export type FixRound = { id: number; callId: number | null; sessionId: number; result: FixTurnResult };
export type FixTurnRequest = {
  session: FixSession; workspaceId: number; step: FixStep; purpose: FixTurnPurpose; head: string; stdin: string;
  promptId: FixPromptId; items: ItemRef[]; by: string;
  /** A follow-up: the call whose harness session it continues. It keeps that session's system prompt and version. */
  parentId?: number;
  /** A first turn's system prompt and version, rendered with its stdin. */
  prompt?: { system: string; version: string };
};

// ---- the round store over fix_session_turns ---------------------------------------------------------------------------

const roundOf = (t: FixTurn): FixRound => ({
  id: t.id, callId: t.callId, sessionId: t.sessionId,
  result: {
    purpose: t.purpose, outcome: t.outcome, report: (t.report as SecurityReport | null) ?? null, ...(t.error !== null && { error: t.error }),
    turns: t.turns, costUsd: t.costUsd, calls: t.toolCalls ?? 0, shellMs: t.shellMs ?? 0, step: t.step, head: t.head ?? "", ...(t.parentId !== null && { parentId: t.parentId }),
  },
});

function storeOf(kind: FixSession["kind"]): RoundStore<FixTurnResult, FixRound, FixTurnRequest, { pinned: Awaited<ReturnType<typeof loadCallPrompt>> }, Pod> {
  return {
    sessionKind: WORKSPACE_SESSION_KIND[kind],
    async beforeWrite(db, t) {
      // A follow-up keeps its session's system prompt and version, so a prompt saved meanwhile reaches only new sessions.
      return { pinned: t.parentId !== undefined ? await loadCallPrompt(db, t.parentId) : null };
    },
    async plan(_db, t, { pinned }) {
      const follow = t.parentId !== undefined;
      const limits = follow ? FIX_FOLLOW_UP_CALL : FIX_SESSION_CALL;
      const p = CLAUDE_PROMPTS[t.promptId];
      const sys = follow && pinned?.system != null ? { system: pinned.system, version: pinned.promptVersion } : t.prompt;
      if (!sys) throw new Error(`turn of fix session ${t.session.id}: no system prompt (the parent call ${t.parentId} is gone)`);
      // No forLogin: started.ts gives a first turn to the approving maintainer's Task Runner first; a follow-up goes to the helper that holds its session.
      const call: WorkspaceCallRequest = {
        workspaceId: t.workspaceId, promptId: t.promptId, promptVersion: sys.version, model: p.models[0]!, tier: promptTier(t.promptId), effort: p.effort,
        stdin: t.stdin, system: sys.system, timeoutSeconds: limits.timeoutSeconds, maxTurns: limits.maxTurns, items: t.items,
        maxAttempts: CALL_ATTEMPTS, keepSession: true, ...(follow && { parentId: t.parentId }),
      };
      const result: FixTurnResult = { purpose: t.purpose, outcome: "queued", report: null, turns: null, costUsd: null, calls: 0, shellMs: 0, step: t.step, head: t.head, ...(follow && { parentId: t.parentId }) };
      return { call, owner: t.session.id, kind: t.purpose, result, session: { repo: t.session.repo, item: t.session.number, baseSha: t.head, requestedBy: t.by, deadlineSec: limits.timeoutSeconds } };
    },
    async add(db, owner, round) {
      const r = round.result;
      const id = await addTurn(db, { sessionId: owner, step: r.step, purpose: r.purpose as FixTurnPurpose, head: r.head, callId: round.callId, parentId: r.parentId ?? null });
      await updateSession(db, owner, { addTurns: 1 });
      return { id, callId: round.callId, sessionId: owner, result: r };
    },
    async set(db, round, r) {
      if (r.outcome === "queued") return;
      round.result = r;
      await settleTurn(db, round.id, {
        outcome: r.outcome, report: r.report, error: r.error ?? r.parseError ?? null, turns: r.turns, costUsd: r.costUsd, toolCalls: r.calls, shellMs: r.shellMs,
      }, { from: ["queued", r.outcome] });
    },
    parse: (_queued, text) => (kind === "security" ? parseSecurityReport(text) : parseFixReport(text)),
    async afterReply() {},
  };
}
const STORES = { pr: storeOf("pr"), security: storeOf("security") };

// ---- prompts ----------------------------------------------------------------------------------------------------------

/** fix.session's system prompt (with the repo's guidance) and its first message, from the prompt revisions as they are now. */
export async function renderFixSession(db: Db, task: FixSessionTask): Promise<{ system: string; stdin: string; version: string }> {
  await ensurePrompts(db);
  const repo = task.ref.split("#")[0]!;
  const guidance = guidanceOf(repo);
  const p = claudeParts("fix.session", [{ ...task, ...(guidance && { repo_guidance: guidance }) }], false);
  return { system: p.system ?? "", stdin: p.stdin, version: p.version };
}

// ---- the step -----------------------------------------------------------------------------------------------------------

/** What a step gives the engine. */
export type StepSpec = {
  step: GateStep;
  /** The commit the step works on: the PR head, a merge commit or a pinned sha. */
  head: string;
  promptId: FixPromptId;
  /** A new harness session's system prompt and first message: the task, and for a fresh session that takes over, the history note. */
  task(history: HistoryNote | null): Promise<{ system: string; stdin: string; version: string }>;
  /** The step's task as a message on the live session. `moved`: the branch moved since the session's last task. */
  message(o: { moved: { from: string; diffStat: string } | null }): string;
  /** The step's gates, with the workspace's pod to read files from. */
  gate(pod: Pod): StepGate;
  items?: ItemRef[];
};

/** A PR step's spec from its task turn: fix.session, with the step message on a live session. */
export function prStep(db: Db, turn: StepTurn, gate: (pod: Pod) => StepGate, o: { lint?: string[] } = {}): StepSpec {
  return {
    step: turn.step, head: turn.head, promptId: "fix.session",
    task: (history) => renderFixSession(db, { ref: turn.ref, turn, ...(history && { history }), ...(o.lint?.length && { lint: o.lint }) }),
    message: ({ moved }) => stepMessage(turn, { later: true, ...(moved && { moved }) }),
    gate,
  };
}

export type StepEnv = FixWorkspaceEnv & {
  calls?: CallDeps;
  /** AutoCraft's checks in the pod; tests replace them. */
  checks?: (pod: Pod, o: { dir: string; base: string; round: number }) => Promise<CheckRound>;
  pod?: (workspaceId: number) => Pod;
  /** The default branch's AGENTS.md of a repo, or null when it has none. */
  agents?: (repo: string) => Promise<string | null>;
  /** The diff stat between two commits of the repo, for the message on a branch that moved. */
  movedStat?: (from: string, to: string) => Promise<string>;
  /** Who the turns are for (workspace_sessions.requested_by). */
  by?: string;
};

export type StepResult =
  | { kind: "wait"; reason: string }
  /** The session ended meanwhile (its PR closed, a person stopped the item) or a new one was refused. */
  | { kind: "ended"; reason: string }
  | { kind: "failed"; reason: string }
  /** The report says none or blocked: nothing to push. */
  | { kind: "report"; report: SecurityReport; callId: number }
  /** The report says done and the tree holds no change. */
  | { kind: "empty"; report: SecurityReport; callId: number }
  | { kind: "refused"; problems: string[]; report: SecurityReport; callId: number; diff: string | null }
  | { kind: "ok"; gate: GateOk; diff: string; diffHash: string; report: SecurityReport; callId: number; turnId: number };
export type StepOutcome = StepResult & { session: FixSession; workspaceId: number | null; turns: FixTurnResult[]; checks: CheckRound[] };

/** The default branch's AGENTS.md of `repo` from the docs cache, or null. */
async function defaultAgents(db: Db, repo: string): Promise<string | null> {
  const branch = (await loadRepos(db, { names: [repo] })).get(repo)?.default_branch ?? "main";
  const dir = await repoDocsFor(repo, branch);
  const f = dir ? join(dir, "AGENTS.txt") : null;
  return f && existsSync(f) ? readFileSync(f, "utf8") : null;
}

/** Puts the default branch's AGENTS.md read-only at SESSION_REPO_DOCS/AGENTS.txt, outside /work/src; none leaves no file. */
async function putRepoDocs(env: StepEnv, workspaceId: number, text: string | null): Promise<string | null> {
  const run = async (what: string, script: string, ...args: string[]): Promise<string | null> => {
    const r = await execWs(env.db, env.api, workspaceId, ["run", "60", "--", "sh", "-c", script, what, ...args], { tool: "checkpoint", args: { repo_docs: what }, timeoutMs: 70_000, touch: true }, env.now);
    return r.header?.kind === "status" && r.header.state === "exited" && r.header.exit === 0 ? null : `${what}: ${r.error ?? describeHeader(r.header)}`;
  };
  const cleared = await run("clear", 'mkdir -p "$1" && rm -f "$2"', SESSION_REPO_DOCS, AGENTS_FILE);
  if (cleared || text === null) return cleared;
  const put = await execWs(env.db, env.api, workspaceId, ["put", AGENTS_FILE], { tool: "checkpoint", args: { repo_docs: "put", bytes: Buffer.byteLength(text) }, stdin: Buffer.from(text), timeoutMs: 120_000, touch: true }, env.now);
  if (put.header?.kind !== "ok") return `put: ${put.error ?? describeHeader(put.header)}`;
  return await run("protect", 'chmod 0444 "$1"', AGENTS_FILE);
}

/**
 * The tree's change against the workspace's base commit (`git add -A -N`, `git diff --binary --no-renames`), at most
 * SESSION_DIFF_MAX_BYTES, as UTF-8 text; a diff over the cap or not UTF-8 is refused with the reason.
 */
export async function collectDiff(env: FixWorkspaceEnv, workspaceId: number): Promise<{ ok: true; diff: string } | { ok: false; reason: string }> {
  const d = await workspaceDiff(env.db, env.api, workspaceId, env.now, "fix-session");
  if (!d.ok) return d;
  if (Buffer.byteLength(d.diff) > SESSION_DIFF_MAX_BYTES) return { ok: false, reason: `the diff is over ${SESSION_DIFF_MAX_BYTES / 1024 ** 2} MiB` };
  return { ok: true, diff: d.diff };
}

/** Input tokens the call read (fresh input plus cache), when its usage was reported. */
async function inputTokens(db: Db, callId: number): Promise<number> {
  const raw = (await loadCallUsage(db, [callId])).get(callId)?.usage;
  if (!raw) return 0;
  try {
    const u = JSON.parse(raw) as Record<string, unknown>;
    return ["input", "cacheRead", "cacheWrite"].reduce((n, k) => n + (typeof u[k] === "number" ? (u[k] as number) : 0), 0);
  } catch {
    return 0;
  }
}

const historyTurn = (t: FixTurnResult, files: string[]): HistoryTurn | null =>
  t.step === "security" ? null : { step: t.step, head: t.head, outcome: t.report ? `${t.outcome} (${t.report.status})` : t.outcome, files, summary: t.report?.summary ?? null };

/**
 * Runs one step on the session: the workspace ready at `spec.head` (a new step starts from a clean tree), the turns, AutoCraft's
 * checks (findings go back at most CHECK_FOLLOW_UPS times), the diff and the step's gates (a refusal goes back once as an undo
 * turn). A turn a job before this one queued for the same step and head is adopted on the tree it worked on. NoTakerError,
 * WaitLimitError, halts and WorkspaceUnavailable pass through.
 */
export async function runStep(env: StepEnv, session: FixSession, spec: StepSpec): Promise<StepOutcome> {
  const db = env.db;
  const calls = env.calls ?? realCalls;
  const store = STORES[session.kind];
  const step = storedStep(spec.step);
  const items = spec.items ?? [{ repo: session.repo, number: session.number }];
  const by = env.by ?? "autocraft";
  let s = session;
  const turns: FixTurnResult[] = [], checks: CheckRound[] = [];
  /** Files each turn's tree held, for a fresh session's history note. */
  const filesOf = new Map<number, string[]>();
  const history: HistoryTurn[] = [];
  for (const t of await turnsOf(db, s.id)) {
    const h = historyTurn(roundOf(t).result, []);
    if (h && t.outcome !== "queued") history.push(h);
  }
  const done = (o: StepResult, workspaceId: number | null): StepOutcome => ({ ...o, session: s, workspaceId, turns, checks });
  const reload = async (): Promise<boolean> => {
    const now = (await loadSessions(db, [s.id])).get(s.id);
    if (now) s = now;
    return now?.state === "live";
  };

  const pending = await lastTurn(db, s.id);
  const queued = pending?.outcome === "queued" ? roundOf(pending) : null;
  const resume = queued !== null && pending!.step === step && pending!.head === spec.head;

  /** Settles a turn's call into the session: what the next follow-up continues (none when its harness session is gone or too large) and the cost. */
  const settled = async (round: FixRound, r: FixTurnResult): Promise<boolean> => {
    turns.push(r);
    const h = historyTurn(r, filesOf.get(round.id) ?? []);
    if (h) history.push(h);
    const keep = r.outcome === "done" && round.callId !== null && await inputTokens(db, round.callId) <= FRESH_INPUT_TOKENS;
    if (r.outcome === "done" && !keep) env.log(`fix session ${s.id}: turn ${round.callId} read over ${FRESH_INPUT_TOKENS} input tokens; the next turn starts a fresh session`);
    const ok = await updateSession(db, s.id, { lastCallId: keep ? round.callId : null, ...(r.costUsd && { addCostUsd: r.costUsd }) });
    return ok && await reload();
  };

  let round: FixRound | null = null, r: FixTurnResult | null = null;
  if (queued) {
    // A turn a job before this one queued ends before the workspace moves: its call works in it until then.
    const orphan = await settleOrphan(db, store, queued, env.log);
    r = orphan ?? await awaitTurn(db, calls, store, null, { workspaceId: s.workspaceId ?? 0, round: queued, log: env.log });
    round = queued;
    if (!await settled(round, r)) return done({ kind: "ended", reason: `fix session ${s.id} ended` }, s.workspaceId);
  }
  const ws = await ensureWorkspace(s, spec.head, env, { keepTree: resume });
  if (ws.kind === "wait") return done({ kind: "wait", reason: ws.reason }, s.workspaceId);
  if (!await reload()) return done({ kind: "ended", reason: `fix session ${s.id} ended` }, ws.workspaceId);
  const pod = env.pod?.(ws.workspaceId) ?? workspacePod(db, ws.workspaceId, env.cancelled, env.api);
  const check = env.checks ?? runChecks;
  // The adopted turn goes on only on the tree it worked on; on a new or remade workspace the step starts over.
  const kept = resume && (ws.how === "kept" || ws.how === "resumed");
  if (!kept) {
    round = r = null;
    const docs = await putRepoDocs(env, ws.workspaceId, await (env.agents ?? ((repo) => defaultAgents(db, repo)))(s.repo));
    if (docs) env.log(`fix session ${s.id}: the repository's AGENTS.md was not put in the workspace (${docs})`);
  }
  // Counts of this step's follow-ups so far, from the adopted turn back to the step's first.
  let checkTurns = 0, undone = false, reportAsked = false;
  if (kept) {
    for (const t of (await turnsOf(db, s.id)).reverse()) {
      if (t.step !== step || t.head !== spec.head) break;
      if (t.purpose === "findings") checkTurns++;
      if (t.purpose === "undo") undone = true;
      if (t.purpose === "report") reportAsked = true;
      if (t.purpose === "step" || t.purpose === "start") break;
    }
  }

  type Next = { purpose: FixTurnPurpose; message: string | null };
  const opening = async (): Promise<Next> => ({
    purpose: "step",
    message: spec.message({ moved: ws.moved ? { from: ws.moved.from, diffStat: await env.movedStat?.(ws.moved.from, ws.moved.to).catch(() => "") ?? "" } : null }),
  });
  let next: Next | null = round ? null : await opening();
  let sent = 0, misses = 0, retryOf: number | null = null;

  for (;;) {
    if (next) {
      if (sent >= STEP_TURNS_MAX) return done({ kind: "failed", reason: `the step sent ${sent} turns without a change to check` }, ws.workspaceId);
      if (s.turns >= SESSION_MAX_TURNS) {
        // The session has had its turns: a new one goes on in the same workspace, from a fresh harness session with the history.
        await endSession(db, s.id, "turns");
        const n = await ensureSession(db, s.kind, s.repo, s.number, { workspaceId: ws.workspaceId, head: spec.head, model: s.model });
        if ("refused" in n) return done({ kind: "ended", reason: "the item's workflow was stopped" }, ws.workspaceId);
        env.log(`fix session ${s.id} had ${s.turns} turns; fix session ${n.session.id} goes on in workspace ${ws.workspaceId}`);
        s = n.session;
      }
      const follow = s.lastCallId !== null;
      let stdin: string, prompt: { system: string; version: string } | undefined, purpose = next.purpose;
      if (follow && next.message !== null) stdin = next.message;
      else {
        // No live harness session: a new one gets the task; one that takes over also gets the history and what the tree holds.
        const fresh = history.length > 0;
        let diffStat = "";
        if (fresh && next.purpose !== "step") {
          const d = await collectDiff(env, ws.workspaceId);
          diffStat = d.ok && d.diff ? statOf(d.diff) : "";
        }
        const t = await spec.task(fresh ? { turns: history.slice(-12), diff_stat: diffStat } : null);
        prompt = { system: t.system, version: t.version };
        const carry = next.purpose === "findings" || next.purpose === "undo" ? next.message : null;
        stdin = carry ? `${t.stdin}\n\n${carry}` : t.stdin;
        if (retryOf !== null) stdin = await resumePrompt(db, retryOf, stdin);
        purpose = fresh ? "fresh" : "start";
      }
      retryOf = null;
      const req: FixTurnRequest = { session: s, workspaceId: ws.workspaceId, step, purpose, head: spec.head, stdin, promptId: spec.promptId, items, by, ...(follow && next.message !== null && { parentId: s.lastCallId! }), ...(prompt && { prompt }) };
      round = await queueTurn(db, calls, store, req);
      sent++;
      env.log(`fix session ${s.id}: turn ${round.callId} (${purpose}, ${spec.step}) queued${req.parentId !== undefined ? ` on the session of call ${req.parentId}` : ""}`);
      await env.progress?.(`fix session ${s.id}: turn ${round.callId} (${purpose})`);
      r = await awaitTurn(db, calls, store, pod, { workspaceId: ws.workspaceId, round, log: env.log });
      if (!await settled(round, r)) return done({ kind: "ended", reason: `fix session ${s.id} ended` }, ws.workspaceId);
    }
    const cur = round!, res = r!;
    const callId = cur.callId!;

    if (res.outcome !== "done") {
      // The harness session is gone with the call: the same turn goes to a new one, on the tree as it is.
      if (++misses >= MISSES_MAX) return done({ kind: "failed", reason: `${misses} calls in a row ended ${res.outcome}${res.error ? `: ${res.error}` : ""}` }, ws.workspaceId);
      if (res.outcome === "failed" && res.parentId === undefined) retryOf = callId;
      next = next ?? { purpose: res.purpose as FixTurnPurpose, message: null };
      continue;
    }
    misses = 0;
    const report = res.report;
    if (!report) {
      if (!res.lost && reportAsked) return done({ kind: "failed", reason: `no report: ${res.parseError ?? "the reply was not the report"}` }, ws.workspaceId);
      if (!res.lost) reportAsked = true;
      next = { purpose: "report", message: res.lost ? LOST_REPLY_MESSAGE : REPORT_MESSAGE };
      continue;
    }
    if (report.status !== "done") return done({ kind: "report", report, callId }, ws.workspaceId);

    if (checkTurns < CHECK_FOLLOW_UPS) {
      const c = await check(pod, { dir: `${WORK_ROOT}/.ws/tmp/autocraft-fix-${s.id}-${cur.id}-${randomBytes(4).toString("hex")}`, base: ws.baseCommit, round: checks.length + 1 });
      checks.push(c);
      env.log(`fix session ${s.id}: checks: ${c.diffStat}; ${c.findings.length} findings${c.notes.length ? `; ${c.notes.join("; ")}` : ""}`);
      if (c.findings.length) {
        checkTurns++;
        next = { purpose: "findings", message: checksMessage(c.findings) };
        continue;
      }
    }

    const d = await collectDiff(env, ws.workspaceId);
    if (!d.ok && !CHANGE_REFUSAL.test(d.reason)) return done({ kind: "failed", reason: `the change could not be read from the workspace: ${d.reason}` }, ws.workspaceId);
    const diff = d.ok ? d.diff : null;
    const diffHash = diff === null ? "" : createHash("sha256").update(diff).digest("hex");
    if (diff !== null) {
      filesOf.set(cur.id, [...new Set([...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!))]);
      await settleTurn(db, cur.id, { outcome: "done", diffHash }, { from: ["done"] });
    }
    if (diff === "") return done({ kind: "empty", report, callId }, ws.workspaceId);
    const g = diff === null ? { ok: false as const, problems: [(d as { reason: string }).reason] } : await runGate(spec.gate(pod), diff, report);
    if (g.ok) return done({ kind: "ok", gate: g, diff: diff!, diffHash, report, callId, turnId: cur.id }, ws.workspaceId);
    env.log(`fix session ${s.id}: the ${spec.step} gates refused the change: ${g.problems.join("; ")}`);
    if (undone) return done({ kind: "refused", problems: g.problems, report, callId, diff }, ws.workspaceId);
    undone = true;
    next = { purpose: "undo", message: undoMessage(g.problems) };
  }
}
