import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { calls, detail, image, list, output } from "../src/dash/api/workspaces.ts";
import { SECURITY_WORKSPACE_OWNER } from "../src/data/build/index.ts";
import { TOPICS } from "../src/db/live.ts";
import { securityRepo } from "../src/security/rules.ts";
import { INPUT_TOPICS } from "../src/runner/autopilot.ts";
import type { Req } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

const req = (role: "operator" | "viewer", params: Record<string, string> = {}): Req =>
  ({ params, query: new URLSearchParams(), user: { login: role, role, canRead: async () => true, canWrite: async () => role === "operator" } }) as unknown as Req;

test("a viewer sees a workspace's state but none of its prompts, replies, errors, calls or screenshots; an operator sees them", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "ws-")), "t.db"));
  const at = "2026-01-01T00:00:00Z";
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: at, pipeline: 1 }));
  await db.run(db.k.insertInto("workspaces").values({ id: 1, repo: "app", base_sha: "a".repeat(40), env_id: "cluster", state: "failed", state_at: at, error: "secret pod detail", created_at: at, updated_at: at }));
  await db.run(db.k.insertInto("workspace_sessions").values({ repo: "app", base_sha: "a".repeat(40), item: 7, prompt: "operator text", env_id: "cluster", deadline_sec: 60, outcome: "failed: x", workspace_id: 1, requested_by: "op", created_at: at, updated_at: at }));
  const png = Buffer.from("png").toString("base64");
  await db.run(db.k.insertInto("workspace_calls").values({ workspace_id: 1, n: 1, tool: "shell", args: JSON.stringify({ command: "cargo build" }), state: "done", result: JSON.stringify({ text: "exit 0", images: [{ data: png, mimeType: "image/png" }], acct: { images: 1 } }), created_at: at }));

  const rows = (await list(db, { ...req("viewer"), query: new URLSearchParams("state=all") })).workspaces;
  assert.deepEqual([rows[0]!.state, rows[0]!.canSee, rows[0]!.item], ["failed", false, 7]);
  const d = await detail(db, req("viewer", { id: "1" }));
  assert.equal(d.error, null);
  assert.deepEqual([d.sessionList, d.env, d.layout], [[], null, null]);
  await assert.rejects(calls(db, req("viewer", { id: "1" })), /only operators and maintainers/);
  assert.equal((await image(db, req("viewer", { id: "1", call: "1" }))).status, 403);

  const op = await detail(db, req("operator", { id: "1" }));
  assert.deepEqual([op.error, op.sessionList[0]!.prompt], ["secret pod detail", "operator text"]);
  const c = (await calls(db, req("operator", { id: "1" }))).calls[0]!;
  assert.deepEqual([c.summary, c.hasOutput, c.images, "output" in c], ["cargo build", true, 1, false]);
  assert.equal((await output(db, req("operator", { id: "1", call: String(c.id) })).then((o) => o.output)), "exit 0");
  await assert.rejects(output(db, req("viewer", { id: "1", call: String(c.id) })), /only operators and maintainers/);
  assert.deepEqual((await calls(db, { ...req("operator", { id: "1" }), query: new URLSearchParams(`after=${c.id}`) })).calls, []);
  const img = await image(db, req("operator", { id: "1", call: String(c.id) }));
  assert.equal(img.headers?.["content-type"], "image/png");

  assert.ok(TOPICS.includes("workspaces") && !INPUT_TOPICS.includes("workspaces"));
});

test("a security fix session's workspace is left out of a viewer's list and is 404 to them; a maintainer who sees the repo sees it under the security pseudo repo", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "ws-")), "t.db"));
  const at = "2026-01-01T00:00:00Z";
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: at, pipeline: 1 }));
  await db.run(db.k.insertInto("workspaces").values({ id: 1, repo: "app", base_sha: "a".repeat(40), env_id: "cluster", state: "ready", state_at: at, owner: "fix session 1", created_at: at, updated_at: at }));
  await db.run(db.k.insertInto("workspaces").values({ id: 2, repo: "app", base_sha: "a".repeat(40), env_id: "vault", state: "ready", state_at: at, owner: `${SECURITY_WORKSPACE_OWNER} 2`, created_at: at, updated_at: at }));
  const all = { query: new URLSearchParams("state=all") };
  const as = (role: "viewer" | "maintainer", params: Record<string, string> = {}): Req =>
    ({ params, query: new URLSearchParams(), user: { login: role, role, canRead: async () => true, canWrite: async () => false } }) as unknown as Req;

  assert.deepEqual((await list(db, { ...as("viewer"), ...all })).workspaces.map((w) => w.id), [1]);
  await assert.rejects(detail(db, as("viewer", { id: "2" })), /no such workspace/);
  assert.deepEqual((await list(db, { ...as("maintainer"), ...all })).workspaces.map((w) => [w.id, w.repo]), [[2, securityRepo("app")], [1, "app"]]);
  assert.equal((await detail(db, as("maintainer", { id: "2" }))).repo, securityRepo("app"));
});
