// The Opus review in the PR's fix session workspace (fix_sessions entry `review`): the call works in the PR's workspace, reseeded at
// the head, with the tools that read, build and test but none that edit, its verdict is stored as a read-only review's is, and a
// workspace only the review used ends afterwards. A PR whose workspace cannot be had (here: no build environment enabled) is
// reviewed read-only instead of waiting for one. A fix turn a halted job left queued keeps the review out of the workspace, and its
// resumed step never takes a tree reseeded after the turn was queued for the turn's work.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { StoppedError } from "../src/agents/call.ts";
import { createEnv, updateEnv } from "../src/build/envs.ts";
import type { CallDeps } from "../src/build/session-turns.ts";
import { getWorkspace } from "../src/build/workspaces.ts";
import { inReviewWorkspace } from "../src/fixsession/review.ts";
import { loadSessions } from "../src/fixsession/store.ts";
import { setFixSessions } from "../src/fixsession/switch.ts";
import { prStep, runStep } from "../src/fixsession/turn.ts";
import { ensureWorkspace } from "../src/fixsession/workspace.ts";
import type { Outcome } from "../src/remote/calls.ts";
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
  assert.equal((await getWorkspace(db, session.workspaceId!))?.state, "ended", "a take asks for no fix-up: the workspace ends instead of parking");

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

test("a fix turn a halted job left queued keeps the review read-only, and its resumed step redoes the turn on a tree reseeded since", async () => {
  const LIB = "crates/app/src/lib.rs";
  const work = join(top, "resume");
  mkdirSync(join(work, "crates/app/src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: work, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "crates/app/Cargo.toml"), '[package]\nname = "app"\nversion = "0.1.0"\n');
  writeFileSync(join(work, LIB), "pub fn a() -> u8 { 0 }\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const head = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", "--bare", work, join(top, "fixups/lib")]);

  const db = (await world()).db;
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, settings: { image: "autocraft:test" } }, "op");
  await setFixSessions(db, { steps: ["fixup", "review"], repos: null }, "op");
  const pod = fixPod(db, { top: join(top, "resume-pods"), src: work, head, repo: "lib" });
  const session = await pod.session("pr", 1);
  // Each call's edit lands once, when it is first awaited; the first one's job stops right after.
  let n = 0, halt = true;
  pod.model(() => ({ [LIB]: `pub fn a() -> u8 { ${++n} }\n` }));
  const seen = new Map<number, Outcome>();
  const calls: CallDeps = {
    queue: pod.deps.calls!.queue,
    await: async (d, id, o) => {
      const done = seen.get(id) ?? await pod.deps.calls!.await(d, id, o);
      seen.set(id, done);
      if (halt) { halt = false; throw new StoppedError("the runner restarted"); }
      return done;
    },
  };
  const env = { db, log: () => {}, by: "op", ...pod.deps, calls };
  const turn = { ref: "lib#1", title: "Fix a", head, step: "fixup" as const, reason: "a returns the wrong value", fixes: [{ file: LIB, change: "return 2" }], allowed: [LIB], newFilesIn: ["crates/app"], diff: "" };
  const spec = () => prStep(db, turn, () => ({ step: "fixup", allowed: [LIB], newFilesIn: ["crates/app"], packages: ["crates/app"], scripts: null }));
  await assert.rejects(runStep(env, session, spec()), StoppedError);

  const log: string[] = [];
  const ws = await inReviewWorkspace(db, { env: () => ({ api: pod.api, pollMs: 20 }), calls, docs: async () => ({}) }, { repo: "lib", number: 1 }, head,
    { prompt: "review.opus", fixes: () => false }, (l) => log.push(l), async (w) => w);
  assert.equal(ws, null, "the review runs read-only");
  assert.ok(log.some((l) => /read-only review: turn \d+ of fix session \d+ is not settled yet/.test(l)), log.join("\n"));

  // What a review that did not wait would have done: the tree is reseeded at the same head, the turn's edit gone.
  const live = (await loadSessions(db, [session.id])).get(session.id)!;
  assert.equal((await ensureWorkspace(live, head, { db, log: () => {}, api: pod.api, pollMs: 20 })).kind, "ready");
  const asked = pod.queued.length;
  const out = await runStep(env, (await loadSessions(db, [session.id])).get(session.id)!, spec());
  assert.equal(out.kind, "ok", out.kind);
  assert.ok(out.kind === "ok");
  assert.ok(pod.queued.length > asked, "the step sent its turn again");
  assert.match(out.diff, /u8 \{ 2 \}/, "the change is the new turn's, made on the reseeded tree");
});
