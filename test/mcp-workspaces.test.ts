// Workspaces through the MCP server: offered only where a kubernetes environment takes workspaces, opened on a recorded
// default-branch commit, used only by their owner (or an operator), the patch applied before any other call, results
// (images too) returned through the runner's agent server, and a call that outlives its wait read later.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AgentWorkspaceServer, SETUP_TOOL } from "../src/build/agent-workspaces.ts";
import { createEnv } from "../src/build/envs.ts";
import { getWorkspace } from "../src/build/workspaces.ts";
import type { WorkspaceToolResult } from "../src/build/workspace-tools.ts";
import { handleMcp, type McpEnv } from "../src/dash/mcp/index.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import type { Role } from "../src/dash/types.ts";
import { OPERATOR, world, type World } from "./world-db.ts";

const MAIN = "a".repeat(40);
let current: World | null = null;
afterEach(() => current?.close());

async function fresh(k8s = true): Promise<World> {
  const w = current = await (await world()).repo();
  const at = "2026-01-02T00:00:00Z";
  await w.db.run(w.db.k.insertInto("main_ci").values({ repo: "app", head_sha: MAIN, branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: at, first_seen_at: at, state_changed_at: at, updated_at: at }));
  if (k8s) await createEnv(w.db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2 }, OPERATOR);
  return w;
}

const envOf = (w: World, role: Role, login = role === "operator" ? OPERATOR : "maint", canWrite = true): McpEnv => ({
  db: w.db, baseUrl: null, limiter: new RateLimiter(60, 3600_000), canAnswer: false, expensive: () => 0,
  user: async () => ({ login, role, canWrite: async () => canWrite, canRead: async () => true }),
});

let id = 0;
const rpc = async (env: McpEnv, method: string, params?: Record<string, unknown>): Promise<any> => (await handleMcp(env, { jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }))!.result;
async function call(env: McpEnv, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; content: any[] }> {
  const r = await rpc(env, "tools/call", { name, arguments: args });
  return { text: r.content[0].text as string, isError: r.isError === true, content: r.content };
}
const json = async (env: McpEnv, name: string, args: Record<string, unknown>): Promise<any> => {
  const r = await call(env, name, { ...args, format: "json" });
  assert.equal(r.isError, false, r.text);
  return JSON.parse(r.text);
};
const names = async (env: McpEnv): Promise<string[]> => (await rpc(env, "tools/list")).tools.map((t: { name: string }) => t.name);

/** A server whose sessions answer from `answer`, recording the calls in order. */
function fakeServer(w: World, answer: (tool: string, args: any) => WorkspaceToolResult = () => ({ text: "exited 0 after 0.1 s\nok" })) {
  const ran: { tool: string; args: any }[] = [];
  const server = new AgentWorkspaceServer(w.db, null, () => {}, () => ({
    call: async (tool: string, args: unknown, row: number) => {
      ran.push({ tool, args });
      const res = answer(tool, args);
      await w.db.run(w.db.k.updateTable("workspace_calls").set({ state: "done", result: JSON.stringify(res), finished_at: new Date().toISOString() }).where("id", "=", row));
      return res;
    },
  }));
  return { server, ran };
}
const settle = async (server: AgentWorkspaceServer): Promise<void> => {
  for (let i = 0; i < 100 && server.running; i++) await new Promise((r) => setTimeout(r, 5));
};

test("the workspace tools are offered to operators and maintainers only where a kubernetes environment takes workspaces", async () => {
  const none = await fresh(false);
  assert.equal((await names(envOf(none, "operator"))).includes("workspace_open"), false);
  const r = await call(envOf(none, "operator"), "workspace_open", { repo: "app" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no kubernetes build environment takes workspaces/);
  none.close();
  const w = await fresh();
  for (const role of ["operator", "maintainer"] as const) {
    const list = await names(envOf(w, role));
    for (const n of ["workspace_open", "workspace_shell", "workspace_screenshot", "workspace_diff", "workspace_close"]) assert.ok(list.includes(n), `${role}: ${n}`);
  }
  assert.equal((await names(envOf(w, "viewer"))).includes("workspace_open"), false);
});

test("a workspace opens on the current head by default, never on an unrecorded commit, at most three per user, and its patch is queued as its setup", async () => {
  const w = await fresh();
  const maint = envOf(w, "maintainer");
  assert.equal((await call(maint, "workspace_open", { repo: "app", base: "c".repeat(40) })).isError, true);
  assert.match((await call(maint, "workspace_open", { repo: "app", patch: "diff --git a/x b/x\nGIT binary patch\n" })).text, /binary/);
  const v = await json(maint, "workspace_open", { repo: "app", patch: "diff --git a/x b/x\n" });
  assert.equal(v.base, MAIN);
  assert.equal(v.owner, "maint");
  assert.equal(v.patch, "queued");
  assert.equal((await getWorkspace(w.db, v.id))!.owner, "agent:maint");
  await call(maint, "workspace_open", { repo: "app" });
  await call(maint, "workspace_open", { repo: "app" });
  const fourth = await call(maint, "workspace_open", { repo: "app" });
  assert.equal(fourth.isError, true);
  assert.match(fourth.text, /already has 3 live workspaces/);
  assert.equal((await call(envOf(w, "maintainer", "maint", false), "workspace_open", { repo: "app" })).isError, true, "a maintainer needs write access");
});

test("only the owner or an operator uses a workspace, and the tools reach no other workspace", async () => {
  const w = await fresh();
  const ws = (await json(envOf(w, "maintainer"), "workspace_open", { repo: "app" })).id;
  const other = envOf(w, "maintainer", "someone-else");
  for (const [name, args] of [["workspace_status", { workspace: ws }], ["workspace_shell", { workspace: ws, command: "ls", wait_sec: 0 }], ["workspace_close", { workspace: ws }]] as const) {
    const r = await call(other, name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.text, /belongs to maint/, name);
  }
  assert.equal((await call(envOf(w, "operator"), "workspace_status", { workspace: ws })).isError, false);
  const { createWorkspace } = await import("../src/build/workspaces.ts");
  const cli = await createWorkspace(w.db, { repo: "app", baseSha: MAIN, envId: "pods", owner: "cli" });
  assert.equal((await call(envOf(w, "operator"), "workspace_shell", { workspace: cli, command: "ls", wait_sec: 0 })).isError, true);
  assert.equal((await w.db.prepare("SELECT COUNT(*) AS n FROM workspace_calls WHERE workspace_id = ?").get(cli) as { n: number }).n, 0);
});

test("the patch is applied before any other call, results and images come back, and a call past its wait is read later", async () => {
  const w = await fresh();
  const maint = envOf(w, "maintainer");
  const ws = (await json(maint, "workspace_open", { repo: "app", patch: "diff --git a/x b/x\n" })).id;
  const png = "iVBORw0KGgo=";
  const { server, ran } = fakeServer(w, (tool) => (tool === "screenshot" ? { text: "screenshot 1", images: [{ data: png, mimeType: "image/png" }] } : { text: "exited 0 after 0.1 s\nok" }));
  // Queued while the setup waits: the shell call does not run first.
  const pending = call(maint, "workspace_shell", { workspace: ws, command: "cargo build", wait_sec: 0 });
  const early = await pending;
  assert.match(early.text, /still running/);
  const callId = Number(/call (\d+)/.exec(early.text)![1]);
  await server.serve();
  await settle(server);
  assert.deepEqual(ran.map((r) => r.tool), ["shell"], "only the setup ran");
  assert.equal(ran[0]!.args.command, "git apply --whitespace=nowarn -");
  await server.serve();
  await settle(server);
  assert.deepEqual(ran.map((r) => r.args.command), ["git apply --whitespace=nowarn -", "cargo build"]);
  assert.match((await call(maint, "workspace_result", { workspace: ws, call: callId, wait_sec: 0 })).text, /exited 0/);
  assert.equal((await json(maint, "workspace_status", { workspace: ws })).patch, "applied");
  const shot = call(maint, "workspace_screenshot", { workspace: ws, wait_sec: 5 });
  await new Promise((r) => setTimeout(r, 20));
  await server.serve();
  const r = await shot;
  assert.equal(r.content.find((c: { type: string }) => c.type === "image")?.data, png);
});

test("a patch that did not apply refuses the workspace's other calls, and a session that cannot reach the cluster still answers", async () => {
  const w = await fresh();
  const maint = envOf(w, "maintainer");
  const ws = (await json(maint, "workspace_open", { repo: "app", patch: "diff --git a/x b/x\n" })).id;
  const { server, ran } = fakeServer(w, () => ({ text: "exited 1 after 0.1 s\nerror: patch failed: x:1" }));
  await server.serve();
  await settle(server);
  assert.match((await json(maint, "workspace_status", { workspace: ws })).patch, /^failed: exited 1/);
  const shell = call(maint, "workspace_shell", { workspace: ws, command: "cargo test", wait_sec: 5 });
  await new Promise((r) => setTimeout(r, 20));
  await server.serve();
  const r = await shell;
  assert.equal(r.isError, true);
  assert.match(r.text, /patch did not apply/);
  assert.deepEqual(ran.map((x) => x.args.command), ["git apply --whitespace=nowarn -"], "the build never ran on the unpatched tree");

  // Outside the cluster the session only refuses, without settling its row: the server stores that answer.
  const plain = (await json(maint, "workspace_open", { repo: "app" })).id;
  const offline = new AgentWorkspaceServer(w.db, null, () => {});
  const read = call(maint, "workspace_read", { workspace: plain, path: "Cargo.toml", wait_sec: 5 });
  await new Promise((r) => setTimeout(r, 20));
  await offline.serve();
  const out = await read;
  assert.equal(out.isError, true);
  assert.match(out.text, /not in the cluster/);
});

test("rows the server does not own are left alone, a closed workspace refuses its queued calls, and a restart fails calls of unknown outcome", async () => {
  const w = await fresh();
  const maint = envOf(w, "maintainer");
  const ws = (await json(maint, "workspace_open", { repo: "app" })).id;
  const at = new Date().toISOString();
  // A row the CLI's `workspace tool` made runs in the CLI, never here.
  await w.db.run(w.db.k.insertInto("workspace_calls").values({ workspace_id: ws, tool: "shell", args: "{}", state: "queued", created_at: at }));
  // A row an earlier runner left running before the helper gave it a number.
  const stuck = Number((await w.db.get(w.db.k.insertInto("workspace_calls").values({ workspace_id: ws, tool: "read", args: "{}", state: "running", created_at: at, agent_login: "maint" }).returning("id")))!.id);
  const { server, ran } = fakeServer(w);
  await server.recover();
  assert.equal((await w.db.get(w.db.k.selectFrom("workspace_calls").select("state").where("id", "=", stuck)))!.state, "failed");
  await server.serve();
  assert.deepEqual(ran, []);
  const queued = call(maint, "workspace_read", { workspace: ws, path: "Cargo.toml", wait_sec: 5 });
  await new Promise((r) => setTimeout(r, 20));
  assert.match((await call(maint, "workspace_close", { workspace: ws })).text, /closed/);
  const r = await queued;
  assert.equal(r.isError, true);
  assert.match(r.text, /closed/);
  assert.equal((await getWorkspace(w.db, ws))!.state, "ended");
  assert.equal((await call(maint, "workspace_shell", { workspace: ws, command: "ls" })).isError, true);
  assert.equal((await w.db.prepare("SELECT COUNT(*) AS n FROM workspace_calls WHERE tool = ?").get(SETUP_TOOL) as { n: number }).n, 0);
});
