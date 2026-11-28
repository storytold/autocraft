// The fix-up step in a fix session (fix-sessions plan §2, §4): the review's or pre-merge review's fixes, or a maintainer's
// instructions, go to the PR's fix session as a turn; the session edits and checks the tree in its workspace, and the change read
// back and passed by the step's gate is what the fix-up step applies, checks, lints and pushes as for a patch reply. Lint findings
// on a stored change go back to the session that wrote it, on the tree as head plus that change.
import { assertFence } from "../db/fence.ts";
import type { Db } from "../db/index.ts";
import { guardedApi, inClusterApi } from "../build/kube-api.ts";
import { prPackages, runGate, type GateResult, type StepGate } from "../fixsession/gates.ts";
import type { StepTurn } from "../fixsession/messages.ts";
import { loadSessions } from "../fixsession/store.ts";
import { lintParent, prStep, runStep, type StepEnv, type StepOutcome } from "../fixsession/turn.ts";
import { openSession, parkSession, WorkspaceUnavailable } from "../fixsession/workspace.ts";
import type { FixCandidate } from "./candidates.ts";
import type { Git } from "./git.ts";
import type { BuildScripts } from "./patch.ts";

/** What a fix-up step's session turns run on: the cluster, and for tests the calls, checks and pods. */
export type FixSessionDeps = Omit<StepEnv, "db" | "log" | "movedStat" | "by">;

/** The cluster seen from this runner; null when it is not in the cluster, so no workspace can be reached. */
export function defaultSessionDeps(db: Db): FixSessionDeps | null {
  const cluster = inClusterApi();
  return cluster ? { api: guardedApi(cluster, () => assertFence(db)) } : null;
}

/** The step's task and gate on the PR at `head`. */
export type SessionFixup = { turn: StepTurn; gate: StepGate };

/**
 * The turn and gate of a fix-up: the review's fixes in the files they name, with new .rs and .md files inside the crates the PR
 * changes; or an operator's or maintainer's instructions (trusted text), on any file but the protected ones.
 */
export async function sessionFixup(c: FixCandidate, o: { head: string; title: string; quiet: boolean; scripts: BuildScripts; prDiff: string; git: Pick<Git, "git" | "file"> }): Promise<SessionFixup> {
  const base = { ref: `${c.repo}#${c.number}`, title: o.title, head: o.head, ...(o.quiet && { quiet: true }) };
  if (c.operator) {
    return { turn: { ...base, step: "maintainer", instructions: c.operator.instructions, diff: o.prDiff }, gate: { step: "maintainer", scripts: o.scripts, quiet: o.quiet } };
  }
  const allowed = [...new Set(c.fixes.map((f) => f.file))];
  const { newFilesIn, packages } = await prPackages(o.git, o.head, o.prDiff);
  return {
    turn: { ...base, step: "fixup", reason: c.reason, fixes: c.fixes, allowed, newFilesIn, diff: o.prDiff },
    gate: { step: "fixup", allowed, newFilesIn, packages, scripts: o.scripts, quiet: o.quiet },
  };
}

/** A stored session change that came back clean from its lint task, through the step's gate again for its files and size. */
export const storedSessionPatch = (t: SessionFixup, patch: string): Promise<GateResult> => runGate(t.gate, patch, null);

export type SessionPatch =
  | { kind: "ok"; patch: string; files: string[]; changed: number; changes: string[]; turnId: number }
  /** Recorded as today's shapes: refused (the gates refused the change after its undo turn), failed (no change to push). */
  | { kind: "failed" | "refused"; reason: string }
  /**
   * Nothing recorded, and the item is no try: another job works the session (runStep left a skip on the session's lease), or the
   * workspace is starting or cannot be had now (registry wait FIX_WORKSPACE_WAIT; the lane's planner reading wakes the step).
   */
  | { kind: "wait"; reason: string }
  /** Nothing recorded: the session ended meanwhile (the PR closed, a person stopped it) or its tree is at another head. */
  | { kind: "skip"; reason: string };

export type SessionRun = {
  db: Db; deps: FixSessionDeps; git: Git; log: (line: string) => void; by: string;
  /** Lint findings on a stored change: the change, and the fix session turn that wrote it (null: the patch path wrote it). */
  lint?: { findings: string[]; patch: string; sessionTurn: number | null };
};

/**
 * Runs the fix-up as a step of the PR's fix session and returns the gated change. With lint findings the follow-up goes on the
 * session of the turn that wrote the stored change, on the tree as head plus that change; when that session is gone, or its runner
 * does not take the follow-up, a fresh session gets the task with the findings and the tree as it is. The session's pod is parked
 * once the step has nothing pending (the lint task runs elsewhere).
 */
export async function sessionPatch(r: SessionRun, c: FixCandidate, t: SessionFixup): Promise<SessionPatch> {
  const { db, git } = r;
  const opened = await openSession(db, "pr", c.repo, c.number, { head: t.turn.head });
  if ("refused" in opened) return { kind: "skip", reason: "a person stopped the item's workflow" };
  const session = opened.session;
  const env: StepEnv = {
    ...r.deps, db, log: r.log, by: r.by,
    movedStat: async (from, to) => (await git.git(["diff", "--stat", from, to])).stdout.trim().split("\n").pop() ?? "",
  };
  const spec = prStep(db, t.turn, () => t.gate, r.lint ? { lint: { findings: r.lint.findings, patch: r.lint.patch, parentId: await lintParent(db, session, r.lint.sessionTurn) } } : {});
  let out: StepOutcome | null = null;
  try {
    out = await runStep(env, session, spec);
  } catch (e) {
    // The workspace did not get ready (or the job was cancelled while it started): a wait on the workspace, never a try.
    if (e instanceof WorkspaceUnavailable) return { kind: "wait", reason: `the fix session's workspace: ${e.message}` };
    throw e;
  } finally {
    if (out?.kind !== "wait") {
      const id = out?.session.id ?? session.id;
      const now = (await loadSessions(db, [id])).get(id);
      if (now?.state === "live") await parkSession(env, now).catch((e: unknown) => r.log(`  fix session ${id}: parking the workspace: ${(e as Error).message}`));
    }
  }
  switch (out.kind) {
    case "wait":
      return { kind: "wait", reason: out.reason };
    case "ended":
      return { kind: "skip", reason: out.reason };
    case "failed":
      return { kind: "failed", reason: `fix session: ${out.reason}` };
    case "report":
      return { kind: "failed", reason: out.report.status === "blocked" ? `the fix session is blocked: ${out.report.blocked_reason ?? out.report.summary}` : `the fix session made no change: ${out.report.summary}` };
    case "empty":
      return { kind: "failed", reason: "the fix session reported done but the tree holds no change" };
    case "refused":
      return { kind: "refused", reason: out.problems.join("; ") };
    case "ok": {
      // The change must be on the head the fix-up applies it to; another one means the branch moved meanwhile.
      if (out.baseSha !== t.turn.head) return { kind: "skip", reason: `the fix session's tree is at ${out.baseSha.slice(0, 7) || "no commit"}, not at ${t.turn.head.slice(0, 7)}` };
      return { kind: "ok", patch: out.gate.patch, files: out.gate.files, changed: out.gate.changed, changes: out.report.changes, turnId: out.turnId };
    }
  }
}
