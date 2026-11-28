// Operator tool: `autocraft-server fix-session try REPO#N --step fixup|cifix|conflict|maintainer [--instructions TEXT]` runs one
// step of the PR's fix session as the step would (the workspace at the PR head, or for a conflict at the merge of the default
// branch with its markers, the turns, AutoCraft's checks in the pod, the diff and the step's gates) and prints the report, the gate
// result and the diff stat. It records no fixups, ci_fixes or
// conflict_merges row and pushes nothing; the session, its turns and its workspace are kept as for any run, and the pod is parked
// at the end. The fix_sessions setting and the steps' limits do not apply.
import { assertFence } from "../db/fence.ts";
import type { Db } from "../db/index.ts";
import { guardedApi, inClusterApi } from "../build/kube-api.ts";
import { cifixFiles, guardApplied, logText } from "../cifix/index.ts";
import { loadHeldLeaseKeys } from "../data/jobs/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadReviewsAt } from "../data/review/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { parseFixes } from "../fixup/candidates.ts";
import { exec, fixupDir, Git } from "../fixup/git.ts";
import { answersInClone, conflictSeed, conflictTurnOf, type ConflictTask } from "../fixup/conflict-session.ts";
import { conflictShown } from "../fixup/conflict.ts";
import { buildScriptsAt, fixupEditable } from "../fixup/patch.ts";
import { loadRepos } from "../data/mirror/index.ts";
import { statOf, type Pod } from "../implement/checks.ts";
import { ownFailure } from "../mainci/no-new.ts";
import { ghExec } from "../merge/safe-merge.ts";
import { ownerOf } from "../owners.ts";
import { cachedDiff, ghDiff } from "../review/diff.ts";
import type { TryStep } from "./cli.ts";
import { prPackages, type StepGate } from "./gates.ts";
import type { StepTurn } from "./messages.ts";
import { fixSessionLease, prStep, runStep, type StepEnv, type StepOutcome } from "./turn.ts";
import { endStepPod } from "./park.ts";
import { lastTurn } from "./store.ts";
import { openSession } from "./workspace.ts";


const indent = (s: string) => s.trimEnd().split("\n").map((l) => `  ${l}`).join("\n");

/** Returns the exit code: 0 when the gates passed, 2 when they refused or the session changed nothing, 1 when the step could not run. */
export async function runSessionTry(db: Db, repo: string, number: number, step: TryStep, instructions: string | null, log: (line: string) => void = console.log): Promise<number> {
  const ref = `${repo}#${number}`;
  if (step === "maintainer" && !instructions?.trim()) throw new Error("--step maintainer needs --instructions <text>");
  const found = (await loadItems(db, [{ repo, number }], "text")).get(ref);
  const item = found?.kind === "pr" ? found : undefined;
  if (!item?.head_oid) throw new Error(`${ref} is not a PR in the database`);
  const cluster = inClusterApi();
  if (!cluster) throw new Error("this process is not in the cluster, so it cannot reach a workspace");
  const api = guardedApi(cluster, () => assertFence(db));

  const root = fixupDir();
  const git = new Git(exec, root, repo);
  const head = await git.fetchPr(ownerOf(repo), repo, number);
  if (head !== item.head_oid) throw new Error(`the PR head is now ${head.slice(0, 7)}, not ${item.head_oid.slice(0, 7)} as mirrored; try again after the mirror reads it`);
  const scripts = await buildScriptsAt(git, head);
  const diff = await cachedDiff(db, repo, number, head, ghDiff);
  if (!diff.ok) throw new Error(`no diff: ${diff.error}`);
  const quiet = (await loadQuiet(db, [ref])).size > 0;
  const base = { ref, title: (item.title ?? "").slice(0, 300), head, ...(quiet && { quiet }) };

  let turn: StepTurn, gate: (pod: Pod) => StepGate;
  /** A conflict's task: the merge of the default branch, which the workspace is seeded from. */
  let conflict: ConflictTask | null = null;
  if (step === "conflict") {
    const branch = (await loadRepos(db, { names: [repo] })).get(repo)?.default_branch;
    if (!branch) throw new Error(`${repo} has no default branch in the database`);
    const baseSha = await git.fetchBase(ownerOf(repo), repo, branch);
    const merge = await git.mergeTreeOf(head, baseSha);
    if (merge.clean) { log(`${ref}: ${branch} merges into ${head.slice(0, 7)} without conflicts, which needs no model; nothing was run`); return 1; }
    const [h, b] = [scripts, await buildScriptsAt(git, baseSha)];
    if (!h || !b) throw new Error("the build scripts of the branch or the base could not be read");
    const both = new Set([...h, ...b]);
    const views = await conflictShown(git, merge.tree, head, baseSha, merge.conflicted, both);
    if (!views.ok) { log(`${ref}: the conflict merge would refuse this merge: ${views.reason}; nothing was run`); return 1; }
    const review = (await loadReviewsAt(db, [{ repo, number, head }])).get(`${ref}@${head}`);
    const seed = await conflictSeed(git, merge.tree, head, baseSha, repo, number);
    conflict = { ...base, quiet, base: branch, reason: review?.reason ?? "", seed, head, baseSha, prDiff: diff.text, scripts: both, shown: views.shown };
    const t = await conflictTurnOf(git, conflict);
    turn = t.turn;
    gate = t.gate;
  } else if (step === "fixup") {
    const review = (await loadReviewsAt(db, [{ repo, number, head }])).get(`${ref}@${head}`);
    if (review?.verdict !== "take-fix") throw new Error(`${ref} has no take-fix review at its head ${head.slice(0, 7)}`);
    const fixes = parseFixes(JSON.stringify(review.fixes));
    const allowed = [...new Set(fixes.map((f) => f.file))].filter((f) => fixupEditable(f, scripts));
    if (!allowed.length) throw new Error(`the take-fix review of ${ref} names no file a fix-up may edit`);
    const { newFilesIn, packages } = await prPackages(git, head, diff.text);
    turn = { ...base, step: "fixup", reason: review.reason ?? "", fixes, allowed, newFilesIn, diff: diff.text };
    gate = () => ({ step: "fixup", allowed, newFilesIn, packages, scripts, quiet });
  } else if (step === "maintainer") {
    turn = { ...base, step: "maintainer", instructions: instructions!.trim(), diff: diff.text };
    gate = () => ({ step: "maintainer", scripts, quiet });
  } else {
    const reading = await ownFailure(db, ghExec, repo, number, head);
    if (reading.kind !== "failure") throw new Error(`no CI failure to fix at ${head.slice(0, 7)}: ${reading.why}`);
    const allowed = cifixFiles(reading.failure, diff.text, scripts);
    if (!allowed.length) throw new Error("the failure names no file a CI fix may edit");
    turn = { ...base, step: "cifix", failure: logText(reading.failure), allowed, diff: diff.text };
    gate = () => ({ step: "cifix", allowed, scripts, quiet, guard: (patch) => guardApplied(git, root, head, patch, []) });
  }

  const at = turn.head;
  const opened = await openSession(db, "pr", repo, number, { head: at });
  if ("refused" in opened) { log(`${ref}: no fix session: a person stopped the item's workflow`); return 1; }
  // The command line holds no lease, so it stays off a session a step works on.
  if ((await loadHeldLeaseKeys(db)).has(fixSessionLease(opened.session))) { log(`${ref}: a job works fix session ${opened.session.id} now; nothing was run`); return 1; }
  if ((await lastTurn(db, opened.session.id))?.outcome === "queued") { log(`${ref}: fix session ${opened.session.id} has a turn queued; nothing was run`); return 1; }
  log(`${ref} at ${head.slice(0, 7)}${conflict ? ` merged with ${conflict.base} at ${conflict.baseSha.slice(0, 7)}` : ""}: ${step} on fix session ${opened.session.id}${opened.created ? " (new)" : ""}`);
  const env: StepEnv = {
    db, api, log, by: "cli",
    movedStat: async (from, to) => (await git.git(["diff", "--stat", from, to])).stdout.trim().split("\n").pop() ?? "",
  };
  let out: StepOutcome | undefined;
  try {
    const spec = prStep(db, turn, gate);
    // A conflict's workspace moves to the merge: the step's own commit, not someone else's push.
    out = await runStep(env, opened.session, conflict ? { ...spec, message: () => spec.message({ moved: null }) } : spec);
  } finally {
    if (out?.kind !== "wait") await endStepPod(env, { repo, number });
  }

  log("\nturns:");
  for (const t of out.turns) log(`  ${t.purpose}: ${t.outcome}${t.report ? ` (${t.report.status})` : ""}${t.error ? `: ${t.error}` : ""}${t.parseError ? `; not the report: ${t.parseError}` : ""}; ${t.calls} tool calls, ${t.turns ?? "?"} model turns, $${(t.costUsd ?? 0).toFixed(2)}`);
  for (const c of out.checks) log(`checks round ${c.round}: ${c.diffStat}; ${c.findings.length} findings${c.notes.length ? `; ${c.notes.join("; ")}` : ""}`);
  if ("report" in out) log(`\nreport:\n${indent(JSON.stringify(out.report, null, 1))}`);
  switch (out.kind) {
    case "ok": {
      log(`\ngates: passed; ${out.gate.files.length} files, ${out.gate.changed} changed lines (${statOf(out.diff)})`);
      if (!conflict) return 0;
      // The sections' answers as the conflict merge reads them: the change applied to the merge in AutoCraft's clone.
      const answers = await answersInClone(git, root, conflict, out.gate.patch);
      if ("reason" in answers) { log(`the resolution read back in AutoCraft's clone is refused: ${answers.reason}`); return 2; }
      for (const [path, a] of answers) log(`  ${path}: ${a.size} sections resolved`);
      return 0;
    }
    case "refused":
      log(`\ngates: refused after the undo turn:\n${indent(out.problems.join("\n"))}${out.diff ? `\n${statOf(out.diff)}` : ""}`);
      return 2;
    case "empty":
      log("\nthe session reported done and the tree holds no change");
      return 2;
    case "report":
      log(`\nthe session reported ${out.report.status}; nothing to check`);
      return 2;
    default:
      log(`\n${out.kind}: ${out.reason}`);
      return 1;
  }
}
