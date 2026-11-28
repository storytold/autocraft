// A security finding's fix round as a turn of its fix session (fix-sessions plan §2-4): Opus edits the tree of a workspace in a
// confidential kubernetes environment, seeded at the scan's pinned commit, and runs the crate's tests there; the change read back
// passes the security gate (the report's title and summary, the diff's wording, the crate's .rs files plus exactly the test file,
// validateFixPatch with its line cap) before runFix queues the round's builds. A round that failed goes back to the same session:
// with its stored change put back in the tree when it has one, from a clean tree when it has none. Nothing here writes to GitHub.
// The calls name the finding's security pseudo repo item, so they are recorded, routed and shown as the patch path's are.
import type { ItemRef } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import { ensurePrompts } from "../data/prompts/index.ts";
import { loadLiveFixSession } from "../data/fixsession/index.ts";
import type { SecurityGate } from "../fixsession/gates.ts";
import { roundFailedMessage, securityRetryMessage, securityTakeoverMessage, securityTaskMessage } from "../fixsession/messages.ts";
import { endSession } from "../fixsession/store.ts";
import { lintParent, runStep, type StepEnv, type StepOutcome, type StepSpec } from "../fixsession/turn.ts";
import { endSessionWorkspaces, openSession, parkSession, WorkspaceUnavailable } from "../fixsession/workspace.ts";
import type { FixSessionDeps } from "../fixup/session.ts";
import { claudeParts } from "../prompts/index.ts";
import type { SecurityFixInput } from "./rules.ts";

/** security.session's system prompt and first message for the finding, from the prompt revisions as they are now. */
export async function renderSecuritySession(db: Db, input: SecurityFixInput): Promise<{ system: string; stdin: string; version: string }> {
  await ensurePrompts(db);
  const p = claudeParts("security.session", [input], false);
  return { system: p.system ?? "", stdin: p.stdin, version: p.version };
}

/** The round runFix goes on from: why it failed, and its stored change with the session turn that wrote it (none: the next try starts clean). */
export type FailedRound = { reason: string; patch: string | null; sessionTurn: number | null };

export type SessionRoundRequest = {
  db: Db; deps: FixSessionDeps; log: (line: string) => void;
  repo: string; n: number;
  /** The scan's pinned commit: the workspace's tree. */
  sha: string;
  /** The finding as the first turn gets it; `previous` is never set (a failed round goes back as a message). */
  input: SecurityFixInput;
  /** The calls' item: the finding's run under the security pseudo repo. */
  item: ItemRef;
  gate: SecurityGate;
  failed?: FailedRound;
  /** The job's cancel check, read while the workspace starts. */
  cancelled?: () => Promise<boolean>;
};

export type SessionRound =
  /** A change that passed the gate, with the report's title and summary and the turn that wrote it. */
  | { kind: "ok"; patch: string; testPatch: string; files: string[]; title: string; summary: string; turnId: number; cost: number; resumed: boolean }
  /** The round failed: counts as a round, and the next one starts clean on the same session. */
  | { kind: "failed"; why: string; cost: number; resumed: boolean }
  /** Nothing ran to an end: the workspace is not ready, or the session ended meanwhile. `stuck`: no workspace starts until a kubernetes environment changes. */
  | { kind: "wait"; reason: string; stuck?: true };

/** Runs one round of the finding's fix as a step of its security fix session. */
export async function sessionRound(r: SessionRoundRequest): Promise<SessionRound> {
  const { db, sha } = r;
  const opened = await openSession(db, "security", r.repo, r.n, { head: sha });
  if ("refused" in opened) return { kind: "wait", reason: "the finding's fix session was refused" };
  const session = opened.session;
  const env: StepEnv = { ...r.deps, db, log: r.log, ...(r.cancelled && { cancelled: r.cancelled }) };
  const task = await renderSecuritySession(db, r.input);
  const f = r.failed;
  const lint = f?.patch ? { patch: f.patch, message: roundFailedMessage(f.reason), parentId: await lintParent(db, session, f.sessionTurn) } : undefined;
  const spec: StepSpec = {
    step: "security", head: sha, promptId: "security.session", items: [r.item],
    // A new harness session: the finding, and what failed before when this round goes on from a failed one.
    task: async (history) => {
      const note = f ? (lint ? securityTakeoverMessage(f.reason, history?.diff_stat ?? "") : securityRetryMessage(f.reason, sha)) : "";
      return { ...task, stdin: note ? `${task.stdin}\n\n${note}` : task.stdin };
    },
    message: () => (f ? securityRetryMessage(f.reason, sha) : securityTaskMessage(sha, task.stdin)),
    gate: () => r.gate,
    ...(lint && { lint }),
  };
  let out: StepOutcome;
  try {
    out = await runStep(env, session, spec);
  } catch (e) {
    // The workspace did not get ready, or the session ended meanwhile: no try of the model's work.
    if (e instanceof WorkspaceUnavailable) return { kind: "wait", reason: `the fix session's workspace: ${e.message}` };
    throw e;
  }
  const cost = out.turns.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  const resumed = out.turns[0]?.parentId !== undefined;
  const failed = (why: string): SessionRound => ({ kind: "failed", why, cost, resumed });
  r.log(`${r.repo} finding ${r.n}: fix session ${out.session.id}: ${out.turns.length} turns, ${out.kind}`);
  switch (out.kind) {
    case "wait": return { kind: "wait", reason: out.reason, ...(out.stuck && { stuck: true as const }) };
    case "ended": return { kind: "wait", reason: out.reason };
    case "failed": return failed(`fix session: ${out.reason}`);
    case "report": return failed(`the fix session is blocked: ${out.report.blocked_reason ?? out.report.summary}`);
    case "empty": return failed("the fix session reported done but the tree holds no change");
    case "refused": return failed(`the change was refused: ${out.problems.join("; ")}`);
    case "ok": {
      if (out.baseSha !== sha) return { kind: "wait", reason: `the fix session's tree is at ${out.baseSha.slice(0, 7) || "no commit"}, not at the pinned ${sha.slice(0, 7)}` };
      const title = out.report.title;
      if (!title || out.gate.testPatch === undefined) return failed("the fix session's report has no title");
      return { kind: "ok", patch: out.gate.patch, testPatch: out.gate.testPatch, files: out.gate.files, title, summary: out.report.summary, turnId: out.turnId, cost, resumed };
    }
  }
}

/**
 * The finding's fix waits for its round's builds (`park`: the pod goes, the volume stays, and a failed round puts its change back
 * in the tree) or has ended (`end`, with `reason`: the session and its workspace end). False when it has no live session.
 */
export async function settleSecuritySession(db: Db, deps: FixSessionDeps | null, repo: string, n: number, how: "park" | "end", reason = "done", log: (line: string) => void = () => {}): Promise<boolean> {
  const s = await loadLiveFixSession(db, "security", repo, n);
  if (!s) return false;
  if (how === "end") {
    const ended = await endSession(db, s.id, reason);
    if (ended) await endSessionWorkspaces(db, [ended]);
    return ended !== null;
  }
  return deps ? await parkSession({ ...deps, db, log }, s) : false;
}
