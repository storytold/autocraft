// The Task Runner's command layout: every server tool has a command or is listed as MCP-only, the commands send the
// right tools/call, and `help` prints the grouped overview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_TOOL_NAMES, QUEUE_APPROVE_TOOLS, QUEUE_TOOLS, TOOLS } from "../src/dash/mcp/index.ts";
import { CLI_COMMANDS, MCP_ONLY } from "../worker/autocraft.mjs";

const WORKER = new URL("../worker/autocraft.mjs", import.meta.url).pathname;

test("every server tool has a command or is listed as MCP-only, and every command names a server tool", () => {
  const mapped = new Set(CLI_COMMANDS.map((c) => c.tool));
  const missing = ALL_TOOL_NAMES.filter((n) => !mapped.has(n) && !MCP_ONLY.includes(n));
  assert.deepEqual(missing, [], "add a command to CLI_COMMANDS in worker/autocraft.mjs, or the tool to MCP_ONLY");
  assert.deepEqual([...mapped, ...MCP_ONLY].filter((n) => !ALL_TOOL_NAMES.includes(n)), []);
});

async function cli(url: string | null, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ac-layout-"));
  try {
    if (url) {
      mkdirSync(join(dir, "autocraft-runner"), { recursive: true });
      writeFileSync(join(dir, "autocraft-runner", "credentials.json"), JSON.stringify({ server: url, credential: "acrun_test", state: "approved", label: "t" }));
      writeFileSync(join(dir, "autocraft-runner", "config.json"), JSON.stringify({ server: url }));
    }
    const p = spawn(process.execPath, [WORKER, ...args], { env: { ...process.env, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir } });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    const code = await new Promise<number>((r) => p.on("close", (c) => r(c ?? -1)));
    return { code, out, err };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("commands send their tool with positional and renamed arguments; a tool the credential lacks gets one line", async () => {
  const calls: { name: string; arguments: unknown }[] = [];
  // An operator without answering: the queue tools but not queue_pr.
  let tools: { name: string }[] = [...TOOLS, ...QUEUE_TOOLS];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (body.id === undefined) { res.writeHead(202); return res.end(); }
      if (body.method === "tools/call") calls.push(body.params);
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : body.method === "tools/list" ? { tools } : { content: [{ type: "text", text: "ok" }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const args of [["inbox", "show", "12"], ["queue", "weight", "designcraft#5", "7"], ["inbox", "feedback", "12", "--pick", "small", "--note", "Built it; works."], ["inbox", "--repo", "photocraft"]]) {
      const r = await cli(url, args);
      assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
    }
    assert.deepEqual(calls, [
      { name: "get_inbox_item", arguments: { id: "12" } },
      { name: "set_weight", arguments: { item: "designcraft#5", weight: 7 } },
      { name: "send_feedback", arguments: { id: "12", option: "small", text: "Built it; works." } },
      { name: "list_inbox", arguments: { repo: "photocraft" } },
    ]);
    const add = await cli(url, ["queue", "add", "designcraft#5"]);
    assert.equal(add.code, 1);
    assert.match(add.err, /^autocraft queue add: this Task Runner cannot approve merges/);
    assert.match((await cli(url, ["queue", "remove", "designcraft#5"])).err, /^autocraft queue remove: this Task Runner cannot approve merges/);
    // A maintainer's answering token: queue_pr only. Withdrawing stays with operators, and the line says so.
    tools = [...TOOLS, ...QUEUE_APPROVE_TOOLS.filter((t) => t.name === "queue_pr")];
    assert.match((await cli(url, ["queue", "remove", "designcraft#5"])).err, /^autocraft queue remove: only operators withdraw an approved merge/);
    tools = [...TOOLS, ...QUEUE_TOOLS];
    assert.equal((await cli(url, ["queue", "weight", "designcraft#5", "7", "8"])).code, 2);
    assert.equal((await cli(url, ["inbox", "nope"])).code, 2);
    assert.equal(calls.length, 4);
  } finally { server.close(); }
});

test("help prints the grouped overview; --all adds the task commands", async () => {
  const r = await cli(null, ["help"]);
  assert.equal(r.code, 0);
  const headings = r.out.split("\n").filter((l) => /^[A-Z][a-z]+( [a-z]+)*$/.test(l));
  assert.deepEqual(headings, ["Setup", "Runner", "Inbox", "Merge queue", "Model calls", "Settings", "Builds", "Workspaces", "Other"]);
  assert.match(r.out, /^ {2}autocraft inbox show <id> /m);
  assert.doesNotMatch(r.out, /autocraft work/);
  assert.match((await cli(null, ["help", "--all"])).out, /^Task commands[^\n]*\n {2}autocraft work /m);
});
