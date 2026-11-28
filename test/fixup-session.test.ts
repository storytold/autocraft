// The fix-up step in a fix session: the session's gated change is pushed as AutoCraft's checked fix-up, so a take carries over it
// (B1), and lint findings on a stored change go back to the session that wrote it, or to a fresh session on the tree that holds the
// change when that session's runner does not take them. Real git and the real workspace helper; the model, the network and
// AutoCraft's checks in the pod are fakes.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { createEnv, updateEnv } from "../src/build/envs.ts";
import { endWorkspace, moveWorkspace } from "../src/build/workspaces.ts";
import { addFixupRequests } from "../src/data/workflow/index.ts";
import { loadSessions } from "../src/fixsession/store.ts";
import { setFixSessions } from "../src/fixsession/switch.ts";
import { ensureWorkspace, fixWorkspaceReading, WorkspaceUnavailable } from "../src/fixsession/workspace.ts";
import { runFixup } from "../src/fixup/index.ts";
import { CLIPPY_ARTIFACT } from "../src/prepush/index.ts";
import { carriedReviews } from "../src/review/carry.ts";
import { callId, fixPod } from "./helpers/fix-pod.ts";
import { fresh, git, T0, world } from "./helpers/fixup-world.ts";
import type { Db } from "./helpers/raw-db.ts";

const LIB = "crates/app/src/lib.rs", README = "crates/app/README.md";
const FILES = { "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n', [LIB]: "pub fn a() -> u8 { 0 }\n", [README]: "# App\n- one\n" };
const PR_DIFF = `diff --git a/${LIB} b/${LIB}\n--- a/${LIB}\n+++ b/${LIB}\n@@ -1 +1 @@\n-pub fn a() {}\n+pub fn a() -> u8 { 0 }\n`;
const COMPILE_ERROR = JSON.stringify({ reason: "compiler-message", message: { level: "error", message: "mismatched types", code: { code: "E0308" }, spans: [{ file_name: LIB, line_start: 1, line_end: 1, is_primary: true }], rendered: "error[E0308]: mismatched types" } });

/** PR #7 started with fix-up, with fix sessions on and a live session whose workspace is ready at the head; the review asks to fix `file`. */
async function sessionWorld(file: string) {
  const w = world({ files: FILES, diff: PR_DIFF });
  process.env.AUTOCRAFT_FIXUP_DIR = w.deps.root;
  const db = await fresh(w.head);
  await db.run(db.k.updateTable("opus_reviews").set({ fixes: JSON.stringify([{ file, change: "make it right" }]) }));
  await setFixSessions(db, { steps: ["fixup"], repos: null }, "op");
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, settings: { image: "autocraft:test" } }, "op");
  const pod = fixPod(db, { top: w.base, src: join(w.base, "work"), head: w.head });
  w.deps.fixSession = () => pod.deps;
  const session = await pod.session("pr", 7);
  const out: string[] = [];
  const run = () => runFixup(db, { repo: "app", dryRun: false }, (l) => out.push(l), w.deps);
  const rows = () => db.all(db.k.selectFrom("fixups").select(["state", "source", "to_head", "session_turn", "lint_round"]).orderBy("created_at"));
  return { w, db, pod, session, run, rows, out };
}

/** Finishes the newest lint task as done with the given clippy output. */
async function lintDone(db: Db, clippy: string): Promise<void> {
  const id = (await db.get(db.k.selectFrom("build_tasks").select("id").orderBy("id", "desc").limit(1)))!.id;
  const results = ["fetch deps", "format", "clippy"].map((step) => ({ step, exitCode: 0, durationMs: 1, timedOut: false }));
  await db.run(db.k.updateTable("build_tasks").set({ state: "done", results: JSON.stringify(results) }).where("id", "=", id));
  const tmp = tempPath(id);
  writeFileSync(tmp, clippy);
  await storeArtifact(db, id, CLIPPY_ARTIFACT, tmp);
}

const pushes = (log: string[]) => log.filter((l) => l.startsWith("push "));
const comments = (log: string[]) => log.filter((l) => l.startsWith("comment: "));

/** Makes PR #7 a quiet one: the fix PR of a security finding that is landing. */
const makeQuiet = (db: Db) => db.run(db.k.insertInto("security_findings").values({ repo: "app", number: 1, scan_id: 1, area: "a", title: "t", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "f", fix_pr: 7, created_at: T0, updated_at: T0 }));

/** A maintainer's instructions on PR #7 at its head. */
const instruct = (s: { db: Db; w: { head: string } }) => addFixupRequests(s.db, [{ repo: "app", number: 7, fromHead: s.w.head, instructions: "Move the notes into NOTES.md and drop the README.", by: "op" }]);

test("a fix session's fix-up push is recorded as our checked fix-up, so the review's take carries over it", async () => {
  const s = await sessionWorld(README);
  s.pod.model(() => ({ [README]: "# App\n- two\n" }));
  await s.run();
  assert.equal(s.w.asked.length, 0, "no patch reply was asked for");
  assert.equal(s.pod.queued.length, 1);
  assert.equal(pushes(s.w.log).length, 1);
  const [row] = await s.rows();
  // The same edge a review fix-up of the patch path records (merge-trust.test.ts `fixup(null)`).
  assert.deepEqual([row!.state, row!.source], ["pushed", null]);
  const check = await s.db.get(s.db.k.selectFrom("patch_checks").select(["verdict", "subject"]).where("kind", "=", "fixup"));
  assert.deepEqual(check, { verdict: "approve", subject: s.w.head });
  const carried = (await carriedReviews(s.db, [{ repo: "app", number: 7, head_oid: row!.to_head! }])).get("app#7");
  assert.equal(carried?.review.verdict, "take");
  assert.equal(carried?.from, s.w.head);
});

test("lint findings on a stored change go back to the session that wrote it, and to a fresh session on the restored change when its runner does not take them", async () => {
  for (const lost of [false, true]) {
    const s = await sessionWorld(LIB);
    const first = "pub fn a() -> u8 { 1 }\n";
    s.pod.model(() => ({ [LIB]: first }));
    await s.run();
    const [stored] = await s.rows();
    assert.equal(stored!.state, "linting");
    assert.ok(stored!.session_turn !== null, "the stored row names the turn that wrote the patch");
    await lintDone(s.db, `${COMPILE_ERROR}\n`);

    const tree = () => readFileSync(join(s.pod.root((s.session.workspaceId)!), "src", LIB), "utf8");
    s.pod.model(() => {
      assert.equal(tree(), first, "the turn works on the tree that holds the stored change");
      return { [LIB]: "pub fn a() -> u8 { 2 }\n" };
    }, undefined, (r) => lost && r.parentId !== undefined);
    await s.run();
    const sent = s.pod.queued.slice(1);
    assert.equal(sent[0]!.parentId, callId(1), "the follow-up continues the call that wrote the patch");
    assert.match(sent[0]!.stdin, /AutoCraft linted your changes[\s\S]*mismatched types/);
    if (lost) {
      assert.equal(sent.length, 2);
      assert.equal(sent[1]!.parentId, undefined, "a fresh session after the follow-up was not taken");
      assert.match(sent[1]!.stdin, /An earlier session worked on this pull request[\s\S]*mismatched types/);
      assert.match(sent[1]!.stdin, /with the changes of the earlier session applied/);
    } else assert.equal(sent.length, 1);
    const [again] = await s.rows();
    assert.deepEqual([again!.state, again!.lint_round], ["linting", 2], `${lost ? "fresh" : "same"} session: stored for its next lint round`);
    assert.notEqual(again!.session_turn, stored!.session_turn);
    assert.deepEqual(pushes(s.w.log), [], "nothing is pushed before the lint task passes");
  }
});

test("a maintainer's fix in a session adds and deletes files and is pushed; on a quiet pull request it posts nothing, while a review fix-up posts its files", async () => {
  const NOTES = "crates/app/NOTES.md";
  for (const quiet of [false, true]) {
    const s = await sessionWorld(README);
    if (quiet) await makeQuiet(s.db);
    await instruct(s);
    s.pod.model(() => ({ [NOTES]: "# Notes\n- one\n", [README]: null }), { status: "done", summary: "Moved the notes.", changes: ["Moves the notes into their own file."] });
    await s.run();
    const [row] = await s.rows();
    assert.deepEqual([row?.state, row?.source], ["pushed", "operator"], s.out.join("\n"));
    assert.deepEqual(git(s.w.fork, "diff", "--name-status", s.w.head, "refs/heads/fix").split("\n"), [`A\t${NOTES}`, `D\t${README}`]);
    if (quiet) assert.deepEqual(comments(s.w.log), [], "nothing is posted on a quiet pull request");
    else assert.match(comments(s.w.log).join("\n"), /Moves the notes into their own file/);
  }
  const s = await sessionWorld(README);
  await makeQuiet(s.db);
  s.pod.model(() => ({ [README]: "# App\n- two\n" }));
  await s.run();
  assert.equal((await s.rows())[0]?.state, "pushed", s.out.join("\n"));
  assert.match(comments(s.w.log).join("\n"), new RegExp(`\`${README}\``), "a review fix-up on a quiet pull request names its files, as the patch path does");
});

test("a commit that holds a file outside the session's change is refused, and a change made on another commit than the head is not applied", async () => {
  const s = await sessionWorld(README);
  // The commit gets one more file than the session's change holds.
  const inner = s.w.deps.exec;
  s.w.deps.exec = async (cmd, args, o = {}) => {
    const at = args.indexOf("commit-tree");
    if (cmd !== "git" || at < 0) return await inner(cmd, args, o);
    const env = { ...o.env, GIT_INDEX_FILE: join(s.w.base, "extra.index") };
    const blob = (await inner("git", ["hash-object", "-w", "--stdin"], { ...o, input: "extra\n" })).stdout.trim();
    await inner("git", ["read-tree", args[at + 1]!], { ...o, env });
    await inner("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},crates/app/EXTRA.md`], { ...o, env });
    const tree = (await inner("git", ["write-tree"], { ...o, env })).stdout.trim();
    return await inner(cmd, args.map((a, i) => (i === at + 1 ? tree : a)), o);
  };
  s.pod.model(() => ({ [README]: "# App\n- two\n" }));
  await s.run();
  const [row] = await s.rows();
  assert.equal(row?.state, "refused", s.out.join("\n"));
  assert.deepEqual(pushes(s.w.log), []);

  // The workspace was reseeded at another commit while the turn ran: the change is not applied to the head.
  const t = await sessionWorld(README);
  const calls = t.pod.deps.calls!;
  t.w.deps.fixSession = () => ({ ...t.pod.deps, calls: { ...calls, await: async (db, id, o) => {
    await t.db.run(t.db.k.updateTable("workspaces").set({ base_sha: "f".repeat(40) }));
    return await calls.await(db, id, o);
  } } });
  t.pod.model(() => ({ [README]: "# App\n- two\n" }));
  await t.run();
  assert.equal(t.pod.queued.length, 1, "the turn ran");
  assert.match(t.out.join("\n"), /the fix session's tree is at fffffff, not at/);
  assert.deepEqual(await t.rows(), [], "nothing is recorded");
  assert.deepEqual(pushes(t.w.log), []);
});

test("a session workspace that fails to start a second time at the head fails the step, and none is made there again until the head or an environment changes", async () => {
  const s = await sessionWorld(README);
  s.pod.model(() => ({ [README]: "# App\n- two\n" }));
  // The session's pod is gone, and every new one fails to start (the launcher's part).
  await endWorkspace(s.db, s.session.workspaceId!);
  const failing = setInterval(() => {
    void s.db.all(s.db.k.selectFrom("workspaces").select("id").where("state", "=", "requested")).then(async (rows) => {
      for (const r of rows) await moveWorkspace(s.db, Number(r.id), ["requested"], "failed", { error: "the pod did not start" });
    }).catch(() => {});
  }, 20);
  try {
    const made = async () => (await s.db.all(s.db.k.selectFrom("workspaces").select("id").where("owner", "=", `fix session ${s.session.id}`))).length;
    await s.run();
    assert.deepEqual(await s.rows(), [], `the first start failure is a wait: ${s.out.join("\n")}`);
    await s.run();
    const [row] = await s.rows();
    assert.equal(row?.state, "failed", s.out.join("\n"));
    assert.equal(s.pod.queued.length, 0, "no turn ran");
    const reading = await fixWorkspaceReading(s.db), count = await made();
    // Planned again (its second try), the step makes no new workspace at this head, records nothing, and the lane's reading stays.
    await s.run();
    assert.equal(await made(), count, "no workspace is made at the same head");
    assert.equal((await s.rows()).length, 1, "nothing more is recorded");
    assert.equal(await fixWorkspaceReading(s.db), reading, "the lane is not woken");
    // An edited environment wakes the lane, and the step starts a workspace at the head again.
    await updateEnv(s.db, "pods", { label: "Pods 2" }, "op");
    assert.notEqual(await fixWorkspaceReading(s.db), reading, "the lane is woken");
    await s.run();
    assert.equal(await made(), count + 1, `a workspace is made after the edit: ${s.out.join("\n")}`);
    // At a new head the session gets a workspace too.
    const now = (await loadSessions(s.db, [s.session.id])).get(s.session.id)!;
    await assert.rejects(ensureWorkspace(now, "e".repeat(40), { db: s.db, api: s.pod.api, log: () => {}, pollMs: 20 }), WorkspaceUnavailable);
    assert.equal(await made(), count + 2, "a workspace is made at the new head");
  } finally {
    clearInterval(failing);
  }
});
