// The Opus review in the PR's fix session workspace (fix_sessions entry `review`): the call works in the PR's workspace, reseeded at
// the head, with the tools that read, build and test but none that edit, and its verdict is stored as a read-only review's is. A PR
// whose workspace cannot be had (here: no build environment enabled) is reviewed read-only instead of waiting for one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createEnv, updateEnv } from "../src/build/envs.ts";
import { loadSessions } from "../src/fixsession/store.ts";
import { setFixSessions } from "../src/fixsession/switch.ts";
import { runOpusReview, type OpusDeps } from "../src/review/opus.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { callId, fixPod } from "./helpers/fix-pod.ts";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";

const top = join(SCRATCH, "review-ws");
process.env.AUTOCRAFT_FIXUP_DIR = join(top, "fixups");
process.env.AUTOCRAFT_DIFF_CACHE = join(top, "diffs");

const DIFF = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-pub fn a() {}\n+pub fn a() -> u8 { 0 }\n";
const take = (ref: string) => ({ ref, verdict: "take", sure: true, reason: "fine", fixes: [], risks: [], summary: "Returns a value.", why: "It is correct.", public: { summary: "Fine.", points: [] }, claims: [] });

test("a review with `review` on runs in the PR's workspace and stores its verdict; without a workspace it runs read-only", async () => {
  const work = join(top, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: work, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "src/lib.rs"), "pub fn a() -> u8 { 0 }\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const head = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", "--bare", work, join(top, "fixups/app")]);

  const w = await (await (await world()).repo()).pr(1, { head });
  await w.pr(2, { head });
  const db = w.db;
  await reportingTaskRunner(db);
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, settings: { image: "autocraft:test" } }, "op");
  await setFixSessions(db, { steps: ["review"], repos: null }, "op");
  const pod = fixPod(db, { top: join(top, "pods"), src: work, head });
  const session = await pod.session("pr", 1);
  pod.model(() => ({}), take("app#1"));
  const deps: OpusDeps = {
    fetchDiff: async () => ({ ok: true, text: DIFF }), fetchDelta: async () => ({ ok: false, tooLarge: false, error: "unused" }), model: "opus", maxChars: 120_000,
    workspace: { env: () => ({ api: pod.api, pollMs: 20 }), calls: pod.deps.calls, docs: async () => ({ "AGENTS.txt": "Test with cargo test.\n" }) },
  };
  const log: string[] = [];
  const verdict = async (n: number) => (await w.rows("SELECT verdict, sure FROM opus_reviews WHERE number = ?", n)).map((r) => [r.verdict, r.sure]);

  await runOpusReview(db, { repo: "app", number: 1 }, (l) => log.push(l), deps);
  const call = pod.queued[0];
  assert.ok(call, "the review was queued as a workspace call");
  assert.equal(call.workspaceId, session.workspaceId, "in the PR's fix session workspace");
  assert.equal(call.promptId, "review.opus");
  assert.ok(call.tools?.includes("shell") && !call.tools.includes("write") && !call.tools.includes("edit"), "it may build and test, not edit");
  assert.match(call.stdin, /\/work\/src/);
  assert.equal(readFileSync(join(pod.root(session.workspaceId!), "repo-docs/AGENTS.txt"), "utf8"), "Test with cargo test.\n");
  assert.equal((await loadSessions(db, [session.id])).get(session.id)?.head, head);
  assert.deepEqual(await verdict(1), [["take", 1]]);
  assert.ok(log.some((l) => /app#1: review in fix session \d+'s workspace/.test(l)));

  // No environment can hold PR #2's workspace: the review does not wait for one, and a Task Runner answers the read-only call.
  await updateEnv(db, "pods", { enabled: false }, "op");
  await db.run(db.k.updateTable("main.remote_calls").set({ state: "done" }).where("id", ">=", callId(1)));
  const asked = pod.queued.length;
  await w.models(() => JSON.stringify(take("app#2")));
  await runOpusReview(db, { repo: "app", number: 2 }, (l) => log.push(l), deps);
  assert.equal(pod.queued.length, asked, "no workspace call");
  assert.deepEqual(await verdict(2), [["take", 1]]);
  assert.ok(log.some((l) => /app#2: read-only review: .*no kubernetes environment is enabled/.test(l)));
  w.close();
});
