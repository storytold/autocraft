// The conflict step in a fix session (fix-sessions plan §3-5): the merge tree with its conflict markers is committed with the
// PR head and the base as parents under a ref of ours (so it is not pruned), the PR's fix session works in its workspace seeded
// from that commit, and the files the session resolved come back as each section's answer (answersFromFile). The answers then take
// the patch path's way: spliceSections, the quiet check, the per-file patch check, the lint task and the merge commit.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.ts";
import { WORK_ROOT } from "../build/workspace-tool-specs.ts";
import type { ConflictGate } from "../fixsession/gates.ts";
import type { ConflictTurn } from "../fixsession/messages.ts";
import { lintParent, prStep, runStep, type StepEnv, type StepOutcome } from "../fixsession/turn.ts";
import { endSessionWorkspaces, openSession, WorkspaceUnavailable } from "../fixsession/workspace.ts";
import type { Git } from "./git.ts";
import { answersFromFile, type BuildScripts, type ConflictFile, type Resolution } from "./patch.ts";
import type { FixSessionDeps } from "./session.ts";

/** A conflicted file as the merge tree holds it: its sections, its text with LF line ends, its mode and whether it had CRLF ones. */
export type ConflictShown = { view: ConflictFile; content: string; mode: string; crlf: boolean };

/** The ref that keeps a PR's conflict commit in AutoCraft's clone. */
export const conflictRef = (repo: string, n: number): string => `refs/autocraft/conflict/${repo}-${n}`;

/** Fixed author, committer and dates: the same merge of the same two commits is the same commit at every run. */
const SEED_ENV = {
  GIT_AUTHOR_NAME: "autocraft", GIT_AUTHOR_EMAIL: "autocraft@localhost", GIT_COMMITTER_NAME: "autocraft", GIT_COMMITTER_EMAIL: "autocraft@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000", GIT_COMMITTER_DATE: "2000-01-01T00:00:00+0000",
};

/**
 * The commit a conflict session's workspace is seeded from: the merge tree (conflict markers included) with parents `head` and
 * `base`, kept under conflictRef. Never pushed; the merge commit that is pushed is made from the resolved tree.
 */
export async function conflictSeed(git: Pick<Git, "must">, tree: string, head: string, base: string, repo: string, n: number): Promise<string> {
  const commit = (await git.must(["commit-tree", tree, "-p", head, "-p", base, "-F", "-"], { input: `Conflicts of merging ${base.slice(0, 7)} into ${head.slice(0, 7)}\n`, env: SEED_ENV })).trim();
  await git.must(["update-ref", conflictRef(repo, n), commit]);
  return commit;
}

/** A resolved file read back: LF line ends when the conflicted file had CRLF ones, refused when they are mixed. */
function normalized(t: ConflictShown, text: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (!t.crlf) return text.includes("\r") ? { ok: false, reason: "the file has carriage returns its conflicted version does not have" } : { ok: true, text };
  const lf = text.replace(/\r\n/g, "\n");
  return lf.includes("\r") || /(?<!\r)\n/.test(text) ? { ok: false, reason: "the file has mixed or bare CR line endings" } : { ok: true, text: lf };
}

/** The answers of one resolved file, or why it is refused. */
export function answersOf(t: ConflictShown, text: string): Resolution {
  const n = normalized(t, text);
  return n.ok ? answersFromFile(t.content, t.view, n.text) : n;
}

/** What the conflict turn needs beyond the conflicted files: the PR, the seed commit and both sides' diffs. */
export type ConflictTask = {
  ref: string; title: string; quiet: boolean; base: string; reason: string; seed: string; head: string; baseSha: string;
  prDiff: string; scripts: BuildScripts; shown: ConflictShown[];
};

/** The turn and gate of a conflict: the merge in the workspace, the conflicted files and what each side changed in them. */
export async function conflictTurnOf(git: Pick<Git, "must">, t: ConflictTask): Promise<{ turn: ConflictTurn; gate: (pod: { file(path: string, max: number): Promise<Buffer | null> }) => ConflictGate }> {
  const files = t.shown.map((s) => s.view.path);
  const mb = (await git.must(["merge-base", t.head, t.baseSha])).trim();
  const baseDiff = await git.must(["diff-tree", "-p", "-r", "--no-renames", "--no-ext-diff", "--no-textconv", mb, t.baseSha, "--", ...files]);
  const turn: ConflictTurn = {
    ref: t.ref, title: t.title, head: t.seed, ...(t.quiet && { quiet: true }), step: "conflict", base: t.base, ...(t.reason && { reason: t.reason }),
    files: t.shown.map((s) => ({ path: s.view.path, sections: s.view.sections.length })), diff: t.prDiff, baseDiff,
  };
  const byPath = new Map(t.shown.map((s) => [s.view.path, s]));
  const gate = (pod: { file(path: string, max: number): Promise<Buffer | null> }): ConflictGate => ({
    step: "conflict", conflicted: files, scripts: t.scripts, quiet: t.quiet,
    read: async (path) => (await pod.file(`${WORK_ROOT}/src/${path}`, 2 * 1024 * 1024))?.toString("utf8") ?? null,
    answers: async (path, content) => {
      const s = byPath.get(path);
      if (!s) return "not a conflicted file";
      const r = answersOf(s, content);
      return r.ok ? null : r.reason;
    },
  });
  return { turn, gate };
}

export type ConflictSessionResult =
  /** Each conflicted file's answers by section id, recovered from the session's change applied to the seed commit in our clone. */
  | { kind: "ok"; answers: Map<string, Map<number, string>>; turnId: number }
  | { kind: "failed" | "refused"; reason: string }
  /** Nothing recorded and no try (as SessionPatch's wait). */
  | { kind: "wait"; reason: string };

/**
 * Resolves the conflicts as a step of the PR's fix session. With `lint` (findings on a stored resolution that a turn of the session
 * wrote, `patch` the diff from the seed commit to it) the step goes on from that resolution, on the session of the turn that wrote
 * it. Unless it waited, the caller ends the step's hold on the pod (endStepPod).
 */
export async function sessionResolution(r: { db: Db; deps: FixSessionDeps; git: Git; log: (line: string) => void; by: string; root: string }, number: number, repo: string, t: ConflictTask, lint?: { findings: string[]; patch: string; sessionTurn: number | null }): Promise<ConflictSessionResult> {
  const { db, git } = r;
  const { turn, gate } = await conflictTurnOf(git, t);
  const opened = await openSession(db, "pr", repo, number, { head: t.seed });
  if ("refused" in opened) return { kind: "wait", reason: "a person stopped the item's workflow" };
  const env: StepEnv = { ...r.deps, db, log: r.log, by: r.by };
  const base = prStep(db, turn, gate, lint ? { lint: { findings: lint.findings, patch: lint.patch, parentId: await lintParent(db, opened.session, lint.sessionTurn) } } : {});
  // The workspace moves from the PR head to the merge: that is this step's own commit, not a push by someone else.
  const spec = { ...base, message: () => base.message({ moved: null }) };
  let out: StepOutcome;
  try {
    out = await runStep(env, opened.session, spec);
  } catch (e) {
    if (e instanceof WorkspaceUnavailable) return { kind: "wait", reason: `the fix session's workspace: ${e.message}` };
    throw e;
  }
  r.log(`  ${t.ref}: fix session ${out.session.id}: ${out.turns.length} turns, ${out.kind}`);
  switch (out.kind) {
    case "wait":
      return { kind: "wait", reason: out.reason };
    case "ended": {
      // As the fix-up's: the item's next session starts without a workspace, so the lane's reading moves once.
      const next = await openSession(db, "pr", repo, number, { head: t.seed });
      const old = out.workspaceId;
      if (old !== null && ("refused" in next || next.session.workspaceId !== old)) await endSessionWorkspaces(db, [{ workspaceId: old }]);
      return { kind: "wait", reason: out.reason };
    }
    case "failed":
      return { kind: "failed", reason: `fix session: ${out.reason}` };
    case "report":
      return { kind: "failed", reason: out.report.status === "blocked" ? `the fix session is blocked: ${out.report.blocked_reason ?? out.report.summary}` : `the fix session resolved nothing: ${out.report.summary}` };
    case "empty":
      return { kind: "failed", reason: "the fix session reported done but the tree holds no change" };
    case "refused":
      return { kind: "refused", reason: out.problems.join("; ") };
    case "ok": {
      // The change must be on the merge of the two commits the merge commit gets; another one means the branch or the base moved.
      if (out.baseSha !== t.seed) return { kind: "wait", reason: `the fix session's tree is at ${out.baseSha.slice(0, 7) || "no commit"}, not at the merge ${t.seed.slice(0, 7)}` };
      const answers = await answersInClone(git, r.root, t, out.gate.patch);
      return "reason" in answers ? { kind: "refused", reason: answers.reason } : { kind: "ok", answers, turnId: out.turnId };
    }
  }
}

/** The session's change applied to the seed commit in a private index of our clone, and each conflicted file's answers read from it. */
export async function answersInClone(git: Git, root: string, t: ConflictTask, patch: string): Promise<Map<string, Map<number, string>> | { reason: string }> {
  const dir = mkdtempSync(join(root, ".index-"));
  try {
    const applied = await git.applyToTree(t.seed, patch, join(dir, "index"), t.shown.map((s) => s.view.path));
    if (!applied.ok) return { reason: applied.reason };
    const out = new Map<string, Map<number, string>>();
    for (const s of t.shown) {
      const f = await git.file(applied.tree, s.view.path);
      if (!f.ok) return { reason: f.reason };
      if (f.mode !== s.mode) return { reason: `${s.view.path}: the resolution changes the file's mode` };
      const a = answersOf(s, f.content);
      if (!a.ok) return { reason: `${s.view.path}: ${a.reason}` };
      out.set(s.view.path, a.sections);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
