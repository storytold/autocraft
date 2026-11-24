// Operators' and maintainers' own builds through the MCP server: only they get the tools (a maintainer where they write), a build starts only from a default-branch
// commit AutoCraft recorded, no confidential or signing environment takes one, and the status reads each line's own exit code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { createEnv, hello } from "../src/build/envs.ts";
import { appendLog, claim, createTask, finishTask, getTask, startTask } from "../src/build/tasks.ts";
import { handleMcp, type McpEnv } from "../src/dash/mcp/index.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import type { Role } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";
import { OPERATOR, world, type World } from "./world-db.ts";

process.env.AUTOCRAFT_ARTIFACT_DIR = join(SCRATCH, "artifacts");

const MAIN = "a".repeat(40);
const OLD = "b".repeat(40);
let current: World | null = null;
afterEach(() => current?.close());

async function fresh(): Promise<World> {
  const w = current = await (await world()).repo();
  for (const [sha, at] of [[OLD, "2026-01-01T00:00:00Z"], [MAIN, "2026-01-02T00:00:00Z"]] as const) {
    await w.db.run(w.db.k.insertInto("main_ci").values({ repo: "app", head_sha: sha, branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: at, first_seen_at: at, state_changed_at: at, updated_at: at }));
  }
  return w;
}

const envOf = (w: World, role: Role, canWrite = true): McpEnv => ({
  db: w.db, baseUrl: null, limiter: new RateLimiter(60, 3600_000), canAnswer: false, expensive: () => 0,
  user: async () => ({ login: role === "operator" ? OPERATOR : "someone", role, canWrite: async () => canWrite, canRead: async () => true }),
});

let id = 0;
const rpc = async (env: McpEnv, method: string, params?: Record<string, unknown>): Promise<any> => (await handleMcp(env, { jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }))!.result;
async function call(env: McpEnv, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await rpc(env, "tools/call", { name, arguments: args });
  return { text: r.content[0].text as string, isError: r.isError === true };
}
const buildId = (text: string): number => Number(/Queued build (\d+)/.exec(text)![1]);
const CAPS = { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: false, gpu: false, toolchains: ["rust-stable"] };

test("operators, and maintainers with write access to the repo, may build; viewers and maintainers without write access may not", async () => {
  const w = await fresh();
  const tools = ["build_base", "start_build", "build_status", "cancel_build"];
  const listed = async (env: McpEnv) => (await rpc(env, "tools/list")).tools.map((t: { name: string }) => t.name).filter((n: string) => tools.includes(n));
  const start = { repo: "app", base: MAIN, steps: ["cargo test"] };
  assert.deepEqual(await listed(envOf(w, "operator")), tools);
  assert.deepEqual(await listed(envOf(w, "maintainer")), tools);
  assert.deepEqual(await listed(envOf(w, "viewer")), []);
  const id = buildId((await call(envOf(w, "maintainer"), "start_build", start)).text);
  for (const env of [envOf(w, "viewer"), envOf(w, "maintainer", false)]) {
    for (const [name, args] of [["start_build", start], ["build_status", { id }], ["cancel_build", { id }]] as const) {
      const r = await call(env, name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, /only operators, and maintainers with write access/, name);
    }
  }
  assert.equal((await w.db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, 1);
  assert.equal((await getTask(w.db, id))!.state, "queued");
});

test("a build starts from a recorded default-branch commit only", async () => {
  const w = await fresh();
  const op = envOf(w, "operator");
  assert.match((await call(op, "build_base", { repo: "app" })).text, new RegExp(MAIN));
  const stranger = await call(op, "start_build", { repo: "app", base: "c".repeat(40), steps: ["cargo test"] });
  assert.equal(stranger.isError, true);
  assert.match(stranger.text, new RegExp(`the current one is ${MAIN}`));
  for (const base of [MAIN, OLD]) {
    const r = await call(op, "start_build", { repo: "app", base, patch: "diff --git a/x b/x\n", steps: ["cargo test"] });
    assert.equal(r.isError, false, r.text);
    const t = (await getTask(w.db, buildId(r.text)))!;
    assert.equal(t.headSha, base);
    assert.equal(t.baseSha, base, "the CI gate is read at the default-branch commit, never at the caller's tree");
  }
});

test("no confidential or warm-signing environment takes a build; a plain one does, also for a repo out of the pipeline's scope", async () => {
  const w = await fresh();
  await w.db.prepare("UPDATE tracked_repos SET pipeline = 0 WHERE name = 'app'").run();
  for (const e of ["vault", "signer", "plain"]) await createEnv(w.db, { id: e, label: e, kind: "local-sandbox", slots: 2, ...(e === "vault" && { confidential: true }) }, OPERATOR);
  await hello(w.db, "vault", { version: "1", capabilities: CAPS, slots: 2 });
  await hello(w.db, "signer", { version: "1", capabilities: { ...CAPS, warmSigner: true }, slots: 2 });
  await hello(w.db, "plain", { version: "1", capabilities: CAPS, slots: 2 });
  const r = await call(envOf(w, "operator"), "start_build", { repo: "app", base: MAIN, steps: ["cargo test"] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual((await claim(w.db, "vault", 2)).tasks, []);
  assert.deepEqual((await claim(w.db, "signer", 2)).tasks, []);
  assert.deepEqual((await claim(w.db, "plain", 2)).tasks.map((t) => t.id), [buildId(r.text)]);
});

const exitArtifact = async (w: World, id: number, line: number, code: number): Promise<void> => {
  const tmp = tempPath(id);
  writeFileSync(tmp, `${code}\n`);
  await storeArtifact(w.db, id, `step-${line}.exit`, tmp);
};
const json = async (env: McpEnv, name: string, args: Record<string, unknown>): Promise<any> => {
  const r = await call(env, name, { ...args, format: "json" });
  assert.equal(r.isError, false, r.text);
  return JSON.parse(r.text);
};

test("a running build shows the line its log is on, finished lines' exit codes and the lines still waiting; at the end a failed line fails the build though every task step succeeded", async () => {
  const w = await fresh();
  const op = envOf(w, "operator");
  await createEnv(w.db, { id: "plain", label: "plain", kind: "local-sandbox", slots: 2 }, OPERATOR);
  await hello(w.db, "plain", { version: "1", capabilities: CAPS, slots: 2 });
  const id = (await json(op, "start_build", { repo: "app", base: MAIN, steps: ["cargo test -p a", "cargo clippy", "cargo doc"] })).id;
  assert.equal((await json(op, "build_status", { id })).queuePosition, 1);
  await claim(w.db, "plain", 2);
  await startTask(w.db, "plain", id);
  await exitArtifact(w, id, 1, 0);
  await appendLog(w.db, "plain", id, "step 2", "Checking a v0.1.0\n");
  const live = await json(op, "build_status", { id });
  assert.equal(live.ok, null);
  assert.equal(live.phase, "line 2");
  assert.deepEqual(live.lines.map((l: { state: string }) => l.state), ["ok", "running", "waiting"]);
  assert.match(live.log, /Checking a/);
  await exitArtifact(w, id, 2, 101);
  await exitArtifact(w, id, 3, 0);
  const ok = { exitCode: 0, durationMs: 1000, timedOut: false };
  await finishTask(w.db, "plain", id, { results: ["fetch deps", "step 1", "step 2", "step 3"].map((step) => ({ step, ...ok })), summary: "" });
  const end = await json(op, "build_status", { id });
  assert.equal(end.ok, false);
  assert.deepEqual(end.lines.map((l: { exitCode: number }) => l.exitCode), [0, 101, 0]);
  assert.match((await call(op, "build_status", { id })).text, /did not pass/);
});

test("on a build pod, which reports exit codes only at the end, a line that prints nothing is running once its container starts, and the line before it ended", async () => {
  const w = await fresh();
  const op = envOf(w, "operator");
  await createEnv(w.db, { id: "plain", label: "plain", kind: "local-sandbox", slots: 2 }, OPERATOR);
  await hello(w.db, "plain", { version: "1", capabilities: CAPS, slots: 2 });
  const id = (await json(op, "start_build", { repo: "app", base: MAIN, steps: ["echo built", "true", "true"] })).id;
  await claim(w.db, "plain", 2);
  await startTask(w.db, "plain", id);
  // The pod logs a running line's container live, and only what it printed; run the first two lines' real commands.
  const out = join(SCRATCH, `build-${id}-out`);
  mkdirSync(out, { recursive: true });
  for (const step of (await getTask(w.db, id))!.plan.slice(1, 3)) {
    const [sh, flag, script, ...args] = step.cmd;
    const printed = execFileSync(sh!, [flag!, script!.replaceAll("/out/", `${out}/`), ...args], { encoding: "utf8" });
    if (printed) await appendLog(w.db, "plain", id, step.name, printed);
  }
  const live = await json(op, "build_status", { id });
  assert.equal(live.phase, "line 2");
  assert.deepEqual(live.lines.map((l: { state: string }) => l.state), ["ended", "running", "waiting"]);
});

test("list_builds shows open builds by default, ended ones with all, one user's with mine, and only repos the user may build", async () => {
  const w = await fresh();
  const op = envOf(w, "operator"), maint = envOf(w, "maintainer");
  const a = (await json(op, "start_build", { repo: "app", base: MAIN, steps: ["cargo test"] })).id;
  const b = (await json(maint, "start_build", { repo: "app", base: MAIN, steps: ["cargo test"] })).id;
  await call(op, "cancel_build", { id: a });
  const ids = async (env: McpEnv, args: Record<string, unknown> = {}) => (await json(env, "list_builds", args)).builds.map((x: { id: number }) => x.id);
  assert.deepEqual(await ids(op), [b]);
  assert.deepEqual(await ids(op, { all: true }), [b, a]);
  assert.deepEqual(await ids(op, { all: true, mine: true }), [a]);
  assert.equal((await json(op, "list_builds", {})).builds[0].startedBy, "someone");
  assert.deepEqual(await ids(envOf(w, "maintainer", false)), []);
});

test("start_build refuses a patch the worker would refuse, and the open-build cap holds for calls made at once", async () => {
  const w = await fresh();
  const op = envOf(w, "operator");
  const binary = "diff --git a/x.png b/x.png\nnew file mode 100644\nGIT binary patch\nliteral 1\n";
  const r = await call(op, "start_build", { repo: "app", base: MAIN, patch: binary, steps: ["cargo test"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /binary/);
  const all = await Promise.all(Array.from({ length: 12 }, () => call(op, "start_build", { repo: "app", base: MAIN, steps: ["cargo test"] })));
  const queued = all.filter((x) => !x.isError).length;
  assert.ok(queued > 0 && queued <= 8, `${queued} queued`);
  assert.equal((await w.db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, queued);
});

test("a display build runs only on a worker with a display, and the files its lines write come back, a PNG as an image", async () => {
  const w = await fresh();
  const op = envOf(w, "operator");
  await createEnv(w.db, { id: "plain", label: "plain", kind: "local-sandbox", slots: 2 }, OPERATOR);
  await createEnv(w.db, { id: "screen", label: "screen", kind: "local-sandbox", slots: 2 }, OPERATOR);
  await hello(w.db, "plain", { version: "1", capabilities: CAPS, slots: 2 });
  await hello(w.db, "screen", { version: "1", capabilities: { ...CAPS, display: true }, slots: 2 });
  const id = (await json(op, "start_build", { repo: "app", base: MAIN, display: true, artifacts: ["shots/*.png"], steps: ["cargo build", "cargo run --example shot -- /out/shots/a.png"] })).id;
  const task = (await getTask(w.db, id))!;
  assert.ok(task.plan.at(-1)!.artifacts!.includes("shots/*.png"), "the caller's globs are collected after the last line");
  assert.ok(!task.plan.at(-2)!.artifacts!.includes("shots/*.png"));
  assert.deepEqual((await claim(w.db, "plain", 2)).tasks, []);
  assert.deepEqual((await claim(w.db, "screen", 2)).tasks.map((t) => t.id), [id]);
  await startTask(w.db, "screen", id);
  await exitArtifact(w, id, 1, 0);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const tmp = tempPath(id);
  writeFileSync(tmp, png);
  await storeArtifact(w.db, id, "shots__a.png", tmp);
  const view = await json(op, "build_status", { id, log_lines: 0 });
  assert.deepEqual(view.artifacts.map((a: { name: string }) => a.name), ["shots__a.png"], "exit codes are not listed as files");
  const r = await rpc(op, "tools/call", { name: "build_artifact", arguments: { id, name: "shots__a.png" } });
  const image = r.content.find((c: { type: string }) => c.type === "image");
  assert.equal(Buffer.from(image.data, "base64").equals(png), true);
  assert.equal(Buffer.from((await json(op, "build_artifact", { id, name: "shots__a.png" })).data, "base64").equals(png), true);
  assert.equal((await call(op, "build_artifact", { id, name: "step-1.exit" })).isError, true);
});

test("the build tools reach no other build task", async () => {
  const w = await fresh();
  const op = envOf(w, "operator");
  const other = await createTask(w.db, { step: "nightly", repo: "app", headSha: MAIN, baseSha: MAIN, plan: [{ name: "x", cmd: ["true"], network: "none", timeoutSec: 60 }] });
  for (const name of ["build_status", "cancel_build"]) {
    const r = await call(op, name, { id: other });
    assert.equal(r.isError, true, name);
  }
  assert.equal((await getTask(w.db, other))!.state, "queued");
});
