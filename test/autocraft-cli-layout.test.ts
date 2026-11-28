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
import { ALL_TOOL_NAMES, PROMPT_EDIT_TOOLS, TOOLS } from "../src/dash/mcp/index.ts";
import { CLI_COMMANDS, MCP_ONLY, parseToolArgs } from "../worker/autocraft.mjs";

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

test("a boolean flag takes a following on/off only when no positional argument needs that word", () => {
  const tool = { name: "t", inputSchema: { type: "object", properties: { item: { type: "string" }, force: { type: "boolean" } } } };
  const withItem = { path: ["x"], args: ["item"], usage: "<item>", summary: "", tool: "t" };
  const noItem = { path: ["y"], usage: "", summary: "", tool: "t" };
  assert.deepEqual(parseToolArgs(tool, ["--force", "off"], noItem).args, { force: false });
  assert.deepEqual(parseToolArgs(tool, ["--force", "on"], withItem).args, { force: true, item: "on" });
  assert.deepEqual(parseToolArgs(tool, ["--force", "off", "app#1"], withItem).args, { force: false, item: "app#1" });
});

test("commands send their tool with their arguments", async () => {
  const calls: { name: string; arguments: unknown }[] = [];
  let tools: { name: string }[] = [...TOOLS, ...PROMPT_EDIT_TOOLS];
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
    const file = join(mkdtempSync(join(tmpdir(), "ac-prompt-")), "review.txt");
    writeFileSync(file, "Look closer.\n⟦locked:output⟧{}⟦/locked⟧");
    for (const args of [["queue", "--repo", "photocraft"], ["repos"], ["fixups", "--repo", "photocraft"], ["prompts", "edit", "review.opus", "--file", file, "--note", "stricter"]]) {
      const r = await cli(url, args);
      assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
    }
    rmSync(file);
    assert.deepEqual(calls, [
      { name: "list_merge_queue", arguments: { repo: "photocraft" } },
      { name: "list_repos", arguments: {} },
      { name: "list_fixups", arguments: { repo: "photocraft" } },
      { name: "edit_prompt", arguments: { id: "review.opus", body: "Look closer.\n⟦locked:output⟧{}⟦/locked⟧", note: "stricter" } },
    ]);
    // A tool the credential lacks gets one line.
    tools = [...TOOLS];
    assert.equal((await cli(url, ["queue", "nope"])).code, 2);
    assert.equal(calls.length, 4);
  } finally { server.close(); }
});

test("help prints the grouped overview; --all adds the task commands", async () => {
  const r = await cli(null, ["help"]);
  assert.equal(r.code, 0);
  const headings = r.out.split("\n").filter((l) => /^[A-Z][a-z]+( [a-z]+)*$/.test(l));
  assert.deepEqual(headings, ["Setup", "Runner", "Merge queue", "Model calls", "Settings", "Prompts", "Items", "Other"]);
  assert.match(r.out, /^ {2}autocraft do <item> "<command>" /m);
  assert.doesNotMatch(r.out, /autocraft work/);
  assert.match((await cli(null, ["help", "--all"])).out, /^Task commands[^\n]*\n {2}autocraft work /m);
});
