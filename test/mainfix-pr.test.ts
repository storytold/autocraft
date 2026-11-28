// Fix PR of a red default branch: the patch is stored with its lint task and the step ends; a later run collects the result. With
// main-fix in fix_sessions the change comes from the repo's fix session in a workspace at the failing commit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { createEnv } from "../src/build/envs.ts";
import { getWorkspace } from "../src/build/workspaces.ts";
import { setFixSessions } from "../src/fixsession/switch.ts";
import { branchFor } from "../src/mainfix/pr.ts";
import { fixPod } from "./helpers/fix-pod.ts";
import { HARDENING, type Exec } from "../src/fixup/git.ts";
import { mainFixDue, onCodeVerdict, runMainFix, setMainFixApproval, type FixRow, type MainFixDeps } from "../src/mainfix/index.ts";
import { CLIPPY_ARTIFACT } from "../src/prepush/index.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "mainfix-pr-"));
// AutoCraft's clone, which a fix session's workspace is seeded from, is the fix PR step's root.
process.env.AUTOCRAFT_FIXUP_DIR = join(dir, "fixups");
const T0 = "2026-01-01T00:00:00Z";
const PR_URL = "https://github.com/storytold/app/pull/9";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const BROKEN = "fn a() -> i32 {\n    1\n}\nfn main() {\n    let x: i32 = b();\n}\n";

/** A repo whose head has a compile error, the patch that fixes it, and the fork the PR branch is pushed to. */
async function world(o: { source?: string; log?: string; reply?: string | null } = {}) {
  const work = mkdtempSync(join(dir, "work-"));
  git(work, "init", "-q", "-b", "main");
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src/lib.rs"), o.source ?? BROKEN);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "break");
  const head = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "src/lib.rs"), BROKEN.replace("b()", "a()"));
  const patch = `${git(work, "diff")}\n`;
  git(work, "checkout", "-q", "src/lib.rs");
  const fork = mkdtempSync(join(dir, "fork-"));
  git(fork, "init", "-q", "--bare");

  const db = await connectDb(join(mkdtempSync(join(dir, "db-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }));
  await setMainFixApproval(db, "op", "app", true);
  await reportingTaskRunner(db);
  await db.run(db.k.insertInto("main_ci").values({ repo: "app", head_sha: head, branch: "main", state: "red", failing: "[]", checks: "[]", first_seen_at: T0, state_changed_at: T0, updated_at: T0 }));
  const row: FixRow = { repo: "app", headSha: head, check: "gate / test", verdict: "code", state: "needs-fix", reason: null, runId: 11, runUrl: null, excerpt: null, issueNumber: null, prNumber: null, prUrl: null, patch: null, files: null, lintTask: null, lintRound: null, lintState: null, session: null, createdAt: T0, updatedAt: T0 };
  await onCodeVerdict(db, row, "a compile error", T0);

  const asked: { previous?: { patch: string; findings: string[] }; files: unknown }[] = [];
  const log = { pushed: 0, opened: 0, issues: [] as { title: string; body: string }[] };
  // git talks to local directories in place of github.com; gh answers from fixed data.
  const exec: Exec = async (cmd, args, opts = {}) => {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (cmd === "git") {
      const url = args.find((a) => a.startsWith("https://github.com/"));
      const mapped = args.map((a) => (a === url ? (a.includes("/bot/") ? fork : work) : a));
      if (args.includes("push")) log.pushed++;
      const r = spawnSync("git", [...mapped.slice(0, HARDENING.length), "-c", "protocol.file.allow=always", ...mapped.slice(HARDENING.length)], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, input: opts.input, encoding: "utf8" });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    }
    const joined = args.join(" ");
    if (joined === "api user") return ok(JSON.stringify({ login: "bot", id: 5, node_id: "N" }));
    if (joined.startsWith("api repos/bot/app")) return ok("storytold/app");
    if (args[0] === "pr" && args[1] === "list") return ok("");
    if (args[0] === "pr" && args[1] === "create") { log.opened++; return ok(`${PR_URL}\n`); }
    if (args[0] === "issue" && args[1] === "create") { log.issues.push({ title: args[args.indexOf("--title") + 1]!, body: String(opts.input) }); return ok("https://github.com/storytold/app/issues/41\n"); }
    return { code: 1, stdout: "", stderr: `unexpected gh call: ${joined}` };
  };
  const gh = async (args: string[]): Promise<string> => {
    if (args[1]?.includes("check-runs")) return JSON.stringify({ check_runs: [{ name: "gate / test", status: "completed", conclusion: "failure", details_url: "https://github.com/storytold/app/actions/runs/11/job/1" }] });
    if (args[0] === "run") return o.log ?? "test\tcargo test\terror[E0425]: cannot find function `b`\ntest\tcargo test\t --> src/lib.rs:5:18\n";
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  const deps: MainFixDeps = {
    gh, exec, now: () => new Date(T0), classify: async () => null,
    fix: {
      root: join(dir, "fixups"),
      ask: async (_db, input) => { const i = (input as { previous?: { patch: string; findings: string[] }; files: unknown }[])[0]!; asked.push({ previous: i.previous, files: i.files }); return o.reply === undefined ? patch : o.reply; },
      check: async () => '{"verdict":"approve","reasons":"fixes the call","problems":[]}',
      checkout: async () => join(dir, "checkout"),
    },
  };
  const step = () => runMainFix(db, { repo: "app" }, () => {}, deps);
  return { db, head, step, asked, log, deps, work, fork };
}

/** Ends the repo's newest lint task with these clippy diagnostics (NDJSON). */
async function finishLint(db: Db, clippy: string): Promise<number> {
  const id = (await db.get(db.k.selectFrom("build_tasks").select("id").orderBy("id", "desc").limit(1)))!.id;
  await db.run(db.k.updateTable("build_tasks").set({ state: "done", ended_at: T0 }).where("id", "=", id));
  const tmp = tempPath(id);
  writeFileSync(tmp, clippy);
  await storeArtifact(db, id, CLIPPY_ARTIFACT, tmp);
  return id;
}
const CLEAN = '{"reason":"build-finished","success":true}\n';
const FINDING = JSON.stringify({ reason: "compiler-message", message: { level: "warning", message: "redundant", code: { code: "clippy::redundant_clone" }, spans: [{ file_name: "src/lib.rs", line_start: 5, line_end: 5, is_primary: true }], rendered: "warning: redundant\n" } });
const stateOf = async (db: Db) => (await db.get(db.k.selectFrom("main_fixes").select(["state", "lint_round as round", "pr_number as pr", "reason"])))!;

test("the step stores the patch and ends; the next run opens the PR once lint is clean", async () => {
  const w = await world();
  assert.equal((await w.step()).prs, 0);
  assert.equal((await stateOf(w.db)).state, "linting");
  assert.equal(w.log.opened, 0);
  assert.deepEqual(w.asked[0]!.files, [{ path: "src/lib.rs" }], "with a checkout the model gets paths, not file contents");
  assert.equal(await mainFixDue(w.db, "app"), false, "the lint task is still running");
  await w.step();
  assert.equal((await stateOf(w.db)).state, "linting");
  await finishLint(w.db, CLEAN);
  assert.equal(await mainFixDue(w.db, "app"), true);
  assert.equal((await w.step()).prs, 1);
  assert.deepEqual([(await stateOf(w.db)).state, (await stateOf(w.db)).pr, w.log.pushed, w.log.opened, w.asked.length], ["pr-opened", 9, 1, 1, 1]);
});

test("findings go back to the model with the earlier patch; the second clean patch opens the PR; a second round with findings ends the attempt", async () => {
  const w = await world();
  await w.step();
  const first = await finishLint(w.db, `${FINDING}\n`);
  await w.step();
  assert.equal(w.asked.length, 2);
  assert.match(w.asked[1]!.previous!.findings[0]!, /redundant/);
  assert.match(w.asked[1]!.previous!.patch, /src\/lib\.rs/);
  assert.deepEqual([(await stateOf(w.db)).state, (await stateOf(w.db)).round], ["linting", 2]);
  assert.equal(w.log.opened, 0);
  const second = await finishLint(w.db, CLEAN);
  assert.notEqual(first, second);
  await w.step();
  assert.deepEqual([(await stateOf(w.db)).state, w.log.opened], ["pr-opened", 1]);

  const l = await world();
  await l.step();
  await finishLint(l.db, `${FINDING}\n`);
  await l.step();
  await finishLint(l.db, `${FINDING}\n`);
  await l.step();
  assert.equal((await stateOf(l.db)).state, "fix-failed");
  assert.match((await stateOf(l.db)).reason!, /clippy findings remain after 2 rounds/);
  assert.equal(l.asked.length, 2);
});

test("a panic inside a test whose patch could not be made opens an issue naming the test; one outside the tests stays fix-failed", async () => {
  const source = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert_eq!(super::add(1, 1), 3);\n    }\n}\n";
  const panicAt = (line: number) => `test\tcargo test\tthread 'tests::adds' (437684) panicked at src/lib.rs:${line}:9:\ntest\tcargo test\tassertion \`left == right\` failed\n`;
  const row = async (db: Db) => (await db.get(db.k.selectFrom("main_fixes").select(["state", "issue_number as issue", "reason"])))!;

  const w = await world({ source, log: panicAt(9), reply: null });
  await w.step();
  const r = await row(w.db);
  assert.deepEqual([r.state, Number(r.issue), w.asked.length, w.log.opened, w.log.issues.length], ["issue-opened", 41, 1, 0, 1], "the patch is tried first");
  assert.match(String(r.reason), /tests::adds fails at src\/lib\.rs:9/);
  assert.match(w.log.issues[0]!.title, /failing test/);
  assert.match(w.log.issues[0]!.body, /No fix PR was opened: test tests::adds fails at src\/lib\.rs:9/);

  const lib = await world({ source, log: panicAt(2), reply: null });
  await lib.step();
  assert.deepEqual([(await row(lib.db)).state, lib.log.issues.length], ["fix-failed", 0]);
});

test("with main-fix in fix_sessions the fix is a session turn in a workspace at the failing commit, and the clean change opens the fix PR; off, the patch path", async () => {
  const w = await world();
  await createEnv(w.db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, settings: { image: "autocraft:test" } }, "op");
  await setFixSessions(w.db, { steps: ["main-fix"], repos: null }, "op");
  const pod = fixPod(w.db, { top: mkdtempSync(join(dir, "pods-")), src: w.work, head: w.head });
  const live = await pod.session("mainfix", 0);
  const fixed = BROKEN.replace("b()", "a()");
  pod.model(() => ({ "src/lib.rs": fixed }), { status: "done", summary: "Called the function that exists." });
  w.deps.fix!.session = (db, log) => ({ ...pod.deps, db, log });

  await w.step();
  assert.equal(pod.queued.length, 1);
  const turn = pod.queued[0]!;
  assert.equal(turn.workspaceId, live.workspaceId, "the turn works in the repo's main-fix session");
  assert.equal((await getWorkspace(w.db, live.workspaceId!))?.base_sha, w.head, "at the failing commit");
  assert.match(turn.stdin, /default branch's CI fails/);
  assert.match(turn.stdin, /src\/lib\.rs/);
  assert.equal(w.asked.length, 0, "no patch is asked for");
  assert.equal((await stateOf(w.db)).state, "linting");

  await finishLint(w.db, CLEAN);
  assert.equal((await w.step()).prs, 1);
  assert.deepEqual([(await stateOf(w.db)).state, (await stateOf(w.db)).pr, w.log.pushed, w.log.opened], ["pr-opened", 9, 1, 1]);
  assert.equal(git(w.fork, "show", `refs/heads/${branchFor("gate / test", w.head)}:src/lib.rs`) + "\n", fixed, "the PR branch holds the session's change");
  assert.equal((await getWorkspace(w.db, live.workspaceId!))?.state, "parked");

  const off = await world();
  await off.step();
  assert.equal(off.asked.length, 1, "off: the patch path");
  assert.equal((await off.db.all(off.db.k.selectFrom("fix_sessions").select("id"))).length, 0);
});
