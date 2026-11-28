// A fix session's workspace follows the PR: when the head moved between turns, the next step's workspace is reseeded at the new
// head (the earlier turn's edits dropped) and the move is reported, and a stored patch made on the old head is not restored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";
import { createEnv } from "../src/build/envs.ts";
import type { KubeApi } from "../src/build/kube-api.ts";
import { WS_POD_PATH } from "../src/build/workspace.ts";
import { createWorkspace, getWorkspace, moveWorkspace } from "../src/build/workspaces.ts";
import { ensureSession, loadSessions, updateSession } from "../src/fixsession/store.ts";
import { ensureWorkspace, restorePatch } from "../src/fixsession/workspace.ts";

const top = join(SCRATCH, "fix-ws");
process.env.AUTOCRAFT_FIXUP_DIR = join(top, "fixups");
const helper = new URL("../deploy/container/ws", import.meta.url).pathname;

test("a head that moved between turns reseeds the workspace at the new head and reports the move; the old head's patch is not restored", async () => {
  // The PR's two heads, in AutoCraft's clone of the repo.
  const work = join(top, "work");
  mkdirSync(work, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: work, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "lib.rs"), "pub fn a() {}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const oldHead = git("rev-parse", "HEAD");
  const patchOnOld = "diff --git a/lib.rs b/lib.rs\n--- a/lib.rs\n+++ b/lib.rs\n@@ -1 +1 @@\n-pub fn a() {}\n+pub fn a() -> u8 { 1 }\n";
  writeFileSync(join(work, "lib.rs"), "pub fn b() {}\n");
  writeFileSync(join(work, "new.rs"), "pub fn c() {}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "two");
  const newHead = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", "--bare", work, join(top, "fixups/app")]);

  // The pod runs the real helper on a scratch /work, seeded at the old head.
  const root = join(top, "pod");
  for (const d of ["src", "home", ".ws/calls"]) mkdirSync(join(root, d), { recursive: true });
  const seeded = spawnSync("sh", [helper, "untar"], { env: { ...process.env, WS_ROOT: root }, input: execFileSync("git", ["archive", oldHead], { cwd: work }) });
  const baseCommit = seeded.stdout.toString().trim().split(" ")[2]!;
  const local = (a: string) => a.replace(/\/work(?=\/|$|\s|")/g, root);
  const api = {
    listPods: async (_ns: string, selector: string) => {
      const id = /craft\.build\/workspace=(\d+)/.exec(selector)![1]!;
      return [{ metadata: { name: `ws-${id}`, labels: { "craft.build/workspace": id } }, status: { phase: "Running" } }];
    },
    exec: async (_ns: string, _pod: string, _c: string, argv: string[], o: { stdin?: Buffer | AsyncIterable<Buffer> }) => {
      const [cmd, ...args] = argv[0] === WS_POD_PATH ? ["sh", helper, ...argv.slice(1)] : argv;
      const p = spawn(cmd!, args.map(local), { env: { ...process.env, WS_ROOT: root } });
      const out: Buffer[] = [];
      p.stdout.on("data", (b: Buffer) => out.push(b));
      if (o.stdin && !Buffer.isBuffer(o.stdin)) for await (const chunk of o.stdin) p.stdin.write(chunk);
      p.stdin.end(Buffer.isBuffer(o.stdin) ? o.stdin : undefined);
      const code = await new Promise<number | null>((r) => p.on("close", r));
      return { exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.alloc(0), truncated: false };
    },
  } as unknown as KubeApi;

  const w = await world();
  const db = w.db;
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2, settings: { image: "autocraft:test" } }, "op");
  const ws = await createWorkspace(db, { repo: "app", baseSha: oldHead, envId: "pods", owner: "test" });
  await moveWorkspace(db, ws, ["requested"], "ready", { pod: `ws-${ws}`, base_commit: baseCommit });
  const opened = await ensureSession(db, "pr", "app", 5);
  assert.ok("session" in opened);
  await updateSession(db, opened.session.id, { workspaceId: ws, head: oldHead });
  // The earlier turn left an edit in the tree; then the contributor pushed.
  writeFileSync(join(root, "src/lib.rs"), "pub fn a() -> u8 { 1 }\n");

  const env = { db, api, log: () => {} };
  const session = (await loadSessions(db, [opened.session.id])).get(opened.session.id)!;
  const r = await ensureWorkspace(session, newHead, env);
  assert.ok(r.kind === "ready");
  assert.equal(r.workspaceId, ws, "the live workspace is kept, not made again");
  assert.equal(r.how, "reseeded");
  assert.deepEqual(r.moved, { from: oldHead, to: newHead });
  assert.equal(readFileSync(join(root, "src/lib.rs"), "utf8"), "pub fn b() {}\n", "the earlier turn's edit is dropped");
  assert.ok(existsSync(join(root, "src/new.rs")));
  assert.equal((await getWorkspace(db, ws))?.base_sha, newHead);
  assert.equal((await loadSessions(db, [session.id])).get(session.id)?.head, newHead);

  const restored = await restorePatch(env, ws, { diff: patchOnOld, head: oldHead });
  assert.ok(!restored.ok && restored.stale, "the old head's patch is not applied");
  assert.equal(readFileSync(join(root, "src/lib.rs"), "utf8"), "pub fn b() {}\n");
});
