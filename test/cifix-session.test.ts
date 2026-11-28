// A CI fix in a fix session, through runCifix with the switch on: the session's turn starts from a reseeded tree (an edit another
// step left in the pod is gone), lint findings on its stored change go back to the session that wrote it, a follow-up that comes
// back unclaimed goes to a fresh session that gets the stored change and the findings, nothing is pushed while lint has findings,
// and the push once lint is clean changes only the CI fix's file, with no line cap. The pod runs the real workspace helper on a
// scratch /work; the model, AutoCraft's in-pod checks, GitHub and the Opus check are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { createEnv } from "../src/build/envs.ts";
import type { WorkspaceCallRequest } from "../src/build/workspace-call.ts";
import { getWorkspace } from "../src/build/workspaces.ts";
import { runCifix, type CifixDeps } from "../src/cifix/index.ts";
import { rowid } from "../src/db/kx.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { turnsOf } from "../src/fixsession/store.ts";
import { setFixSessions } from "../src/fixsession/switch.ts";
import type { StepEnv } from "../src/fixsession/turn.ts";
import type { Querier } from "../src/mirror.ts";
import { CLIPPY_ARTIFACT } from "../src/prepush/index.ts";
import type { Outcome } from "../src/remote/calls.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { acting, appLane } from "./acting.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { validating } from "./gql.ts";
import { callId, fixPod } from "./helpers/fix-pod.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "cifix-session-"));
const cache = join(dir, "fixups");
process.env.AUTOCRAFT_FIXUP_DIR = cache;
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
process.env.AUTOCRAFT_ARTIFACT_DIR = join(dir, "artifacts");
const T0 = "2026-01-01T00:00:00Z";
const LIB = "src/lib.rs", OTHER = "src/other.rs";
const ORIGINAL: Record<string, string> = { "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n', [LIB]: "fn a() {}\nfn main() { b(); }\n", [OTHER]: "pub fn o() {}\n" };
// Over the patch path's 300-line cap, which a fix session's change does not have.
const FIXED = `fn b() {}\nfn main() { b(); }\n${Array.from({ length: 320 }, (_, i) => `pub fn f${i}() {}`).join("\n")}\n`;
const LOG = "test\tcargo test\t2026-01-01T00:00:00Z error[E0425]: cannot find value `b` in this scope\ntest\tcargo test\t2026-01-01T00:00:01Z  --> src/lib.rs:2:20\n";
const APPROVE = JSON.stringify({ verdict: "approve", reasons: "fixes the compile error only", problems: [] });
const FINDING = "error[E0425]: cannot find value `zz` in this scope";

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("lint findings on a session's CI fix go back to that session, an unclaimed follow-up to a fresh one with the stored change, and the push holds only the CI fix's file", async () => {
  // The contributor's branch `fix` (PR #7) in a fork.
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "fix");
  for (const [p, text] of Object.entries(ORIGINAL)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), text); }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "contributor");
  const head = git(work, "rev-parse", "HEAD");
  const fork = join(dir, "fork.git");
  git(dir, "clone", "-q", "--bare", work, fork);
  git(fork, "update-ref", "refs/pull/7/head", head);

  const db = await connectDb(join(dir, "t.db"));
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 7, kind: "pr", state: "OPEN", title: "Rename a to b", author: "someone", additions: 5, deletions: 0, head_oid: head, created_at: T0, updated_at: T0 }));
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 7, head_oid: head, run_id: "rv", at: T0, model: "m", verdict: "take", reason: "looks right", fixes: "[]", sure: 1, mode: "full" }));
  await db.run(db.k.insertInto("pr_checks").values({ repo: "app", number: 7, head_oid: head, state: "OPEN", is_draft: 0, overall: "failure", checks: '[{"name":"gate / test","state":"failure"}]', mergeable: "MERGEABLE", maintainer_can_modify: 1, fetched_at: T0 }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }));
  await setPushApproval(db, "op", "app", true);
  await insertWorkflow(db, { repo: "app", number: 7, kind: "pr", entry: "fixup", state: "running", startedBy: "op", startedAt: T0, startedVia: "dashboard" });
  await acting(db, ["op"]);
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, settings: { image: "autocraft:test" } }, "op");
  await setFixSessions(db, { steps: ["cifix"], repos: null }, "op");

  // GitHub: the open PR, its failing check and log; git's network commands go to the fork.
  const log: string[] = [];
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query() {
      return { repository: { pullRequest: {
        id: "PR7", number: 7, commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "gate / test", status: "COMPLETED", conclusion: "FAILURE" }] } } } }] }, state: "OPEN", isDraft: false, headRefOid: head, headRefName: "fix", maintainerCanModify: true, mergeable: "MERGEABLE",
        headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] }, reviewDecision: null,
      } } };
    },
  });
  const run: Exec = async (cmd, args, o = {}): Promise<ExecResult> => {
    if (cmd === "gh") return { code: 0, stdout: args[0] === "api" ? JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }) : "", stderr: "" };
    if (args.includes("push")) log.push("push");
    const net = args.some((a) => a.startsWith("https://github.com/"));
    const sub = args.map((a) => (a.startsWith("https://github.com/") ? fork : a)).filter((a, i, all) => !(net && ((a === "-c" && all[i + 1] === "protocol.file.allow=never") || a === "protocol.file.allow=never")));
    return exec("git", sub, { ...o });
  };

  // The pod: one scratch /work, run by the real helper, with a live session whose workspace is ready at the head.
  const pod = fixPod(db, { top: dir, src: work, head });
  const live = await pod.session("pr", 7);
  const ws = live.workspaceId!, root = pod.root(ws);
  const tree = (p: string) => readFileSync(join(root, "src", p), "utf8");
  // A fix-up's refused edit left in the pod.
  writeFileSync(join(root, "src", OTHER), "pub fn o() { let _ = 1; }\n");

  // The model: each call is answered by the next step of the case.
  const answers: ((r: WorkspaceCallRequest) => Outcome)[] = [];
  const done = (summary: string): Outcome => ({ state: "done", text: JSON.stringify({ status: "done", summary }), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as never, byModel: null, costUsd: 0.5, turns: 3, sessionId: "s", runId: null });
  const session = (_db: unknown, l: (line: string) => void): StepEnv => ({
    ...pod.deps, db, log: l, agents: async () => null,
    calls: {
      queue: pod.deps.calls!.queue,
      async await(_db, id) {
        const answer = answers.shift();
        assert.ok(answer, `no answer for call ${id}`);
        return answer(pod.queued[id - callId(1)]!);
      },
    },
  });
  const deps: CifixDeps = {
    querier, lane: appLane(querier), exec: run, now: () => new Date("2026-01-03T00:00:00Z"), root: cache, session,
    fetchDiff: async () => ({ ok: true, text: `diff --git a/${LIB} b/${LIB}\n--- a/${LIB}\n+++ b/${LIB}\n@@ -1 +1 @@\n-x\n+fn a() {}\n` }),
    gh: async (args) => {
      if (args[0] === "api" && args[1]!.includes("/pulls/")) return `${"b".repeat(40)}\n`;
      if (args[0] === "api") return JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", completed_at: "2026-01-03T12:00:00Z", details_url: "https://github.com/storytold/app/actions/runs/11/job/5" }] });
      return LOG;
    },
    ask: async () => { throw new Error("the patch path is not used with fix sessions on"); },
    check: async () => APPROVE,
  };
  const out: string[] = [];
  const cifix = async () => { await reportingTaskRunner(db); return await runCifix(db, { repo: "app", dryRun: false }, (l) => out.push(l), deps); };
  const stored = async () => (await db.all(db.k.selectFrom("ci_fixes").select(["state", "lint_task", "lint_round", "session_turn"]).orderBy(rowid("ci_fixes"))));
  const lintDone = async (task: number, finding: boolean) => {
    await db.run(db.k.updateTable("build_tasks").set({ state: "done", ended_at: new Date().toISOString() }).where("id", "=", task));
    const tmp = tempPath(task);
    const message = { level: "error", code: { code: "E0425" }, message: "cannot find value `zz`", rendered: FINDING, spans: [{ is_primary: true, file_name: LIB, line_start: 1, line_end: 1 }] };
    writeFileSync(tmp, finding ? `${JSON.stringify({ reason: "compiler-message", message })}\n{"reason":"build-finished","success":false}\n` : '{"reason":"build-finished","success":true}\n');
    await storeArtifact(db, task, CLIPPY_ARTIFACT, tmp);
  };

  // 1. The CI fix's turn: a clean tree at the head; its change is stored for the lint task with the turn that wrote it.
  answers.push(() => {
    assert.equal(tree(OTHER), ORIGINAL[OTHER], "the turn starts from a reseeded tree");
    writeFileSync(join(root, "src", LIB), FIXED);
    return done("Renamed a to b.");
  });
  await cifix();
  const [first] = await stored();
  assert.equal(first?.state, "linting", out.join("\n"));
  const turns1 = await turnsOf(db, live.id);
  assert.equal(first!.session_turn, turns1.at(-1)!.id);
  const firstCall = turns1.at(-1)!.callId!;

  // 2. Lint findings: a follow-up on the session of that turn's call, which comes back unclaimed; a fresh session gets the
  //    stored change in its tree and the findings, and its change is stored for the next lint round.
  await lintDone(first!.lint_task!, true);
  writeFileSync(join(root, "src", OTHER), "pub fn o() { let _ = 2; }\n");
  answers.push((r) => {
    assert.equal(r.parentId, firstCall, "the lint follow-up continues the session that wrote the change");
    assert.ok(r.stdin.includes("cannot find value `zz`"), "the follow-up names the findings");
    return { state: "unclaimed" };
  });
  answers.push((r) => {
    assert.equal(r.parentId, undefined, "a fresh session");
    assert.ok(r.stdin.includes("cannot find value `zz`"), "the fresh session gets the findings");
    assert.equal(tree(LIB), FIXED, "the fresh session's tree holds the stored change");
    assert.equal(tree(OTHER), ORIGINAL[OTHER], "and nothing else");
    return done("Kept the rename; the finding is gone.");
  });
  await cifix();
  assert.equal(answers.length, 0, out.join("\n"));
  const [second] = await stored();
  assert.equal(second?.state, "linting", out.join("\n"));
  assert.equal(second!.lint_round, 2);
  assert.notEqual(second!.lint_task, first!.lint_task);
  assert.deepEqual((await turnsOf(db, live.id)).map((t) => [t.purpose, t.outcome]), [["start", "done"], ["lint", "unclaimed"], ["fresh", "done"]]);
  assert.equal(log.filter((l) => l === "push").length, 0, "nothing is pushed while lint has findings");

  // 3. Lint clean: the push changes only the CI fix's file, and the pod is parked.
  await lintDone(second!.lint_task!, false);
  await cifix();
  assert.deepEqual((await stored()).map((r) => r.state), ["pushed"], out.join("\n"));
  assert.equal(log.filter((l) => l === "push").length, 1);
  assert.deepEqual(git(fork, "diff", "--name-only", head, "refs/heads/fix").split("\n"), [LIB]);
  assert.ok(Number(git(fork, "diff", "--numstat", head, "refs/heads/fix").split("\t")[0]) > 300, "a session's change over 300 lines is pushed after a clean lint");
  assert.equal((await getWorkspace(db, ws))?.state, "parked");
});
