// The fix-up step in a fix session: the session's gated change is pushed as AutoCraft's checked fix-up, so a take carries over it
// (B1), and lint findings on a stored change go back to the session that wrote it, or to a fresh session on the tree that holds the
// change when that session's runner does not take them. Real git and the real workspace helper; the model, the network and
// AutoCraft's checks in the pod are fakes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { createEnv } from "../src/build/envs.ts";
import { setFixSessions } from "../src/fixsession/switch.ts";
import { runFixup } from "../src/fixup/index.ts";
import { CLIPPY_ARTIFACT } from "../src/prepush/index.ts";
import { carriedReviews } from "../src/review/carry.ts";
import { callId, fixPod } from "./helpers/fix-pod.ts";
import { fresh, world } from "./helpers/fixup-world.ts";
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
  const run = () => runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
  const rows = () => db.all(db.k.selectFrom("fixups").select(["state", "source", "to_head", "session_turn", "lint_round"]).orderBy("created_at"));
  return { w, db, pod, session, run, rows };
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
