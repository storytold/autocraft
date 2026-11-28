// Who may change prompts: a maintainer without write access on a tracked repo with the pipeline on is refused on the API
// and the MCP tool and nothing is stored; one with write saves through MCP, the save is audited and GET /api/prompts shows
// the new revision; a repo's guidance is refused to a maintainer who writes only another repo.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addTrackedRepo, setPipelineFlags } from "../src/data/control/index.ts";
import * as api from "../src/dash/api/prompts.ts";
import { handleMcp, type McpEnv } from "../src/dash/mcp/index.ts";
import { HttpError } from "../src/dash/server/util.ts";
import type { Req, User } from "../src/dash/types.ts";
import { codeBody } from "../src/prompts/index.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = await connectDb(join(mkdtempSync(join(SCRATCH, "prompts-api-")), "t.db"));
for (const name of ["appa", "appb"]) await addTrackedRepo(db, { name, by: "op" });
await setPipelineFlags(db, [{ repo: "appa", on: true }, { repo: "appb", on: true }], "op");

const maintainer = (login: string, writes: string[]): User => ({ login, role: "maintainer", canWrite: async (r) => writes.includes(r), canRead: async () => true });
const req = (user: User, o: Partial<Req> = {}): Req => ({ method: "GET", path: "/api", params: {}, query: new URLSearchParams(), form: new URLSearchParams(), user, csrf: "", nonce: "", ...o });
const env = (user: User): McpEnv => ({ db, baseUrl: null, canAnswer: false, expensive: () => 0, user: async () => user });
const call = async (user: User, name: string, args: unknown) =>
  ((await handleMcp(env(user), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { isError?: boolean; content: { text: string }[] } }).result;
const status = (e: unknown): number => (e instanceof HttpError ? e.status : 0);
const stored = async () => (await db.all(db.k.selectFrom("prompt_revisions").select("rev"))).length;

const code = codeBody("review.opus");
const edited = code.replace("⟦locked:output⟧", "Read the tests the change touches first.\n\n⟦locked:output⟧");

test("prompt edits need write access on a tracked repo with the pipeline on; guidance needs write on its repo", async () => {
  const nora = maintainer("nora", []);
  await assert.rejects(api.save(db, req(nora, { method: "POST", params: { id: "review.opus" }, json: { body: edited, note: "tests first", baseRev: null } })), (e) => status(e) === 403);
  assert.equal((await call(nora, "edit_prompt", { id: "review.opus", body: edited, note: "tests first" })).isError, true);
  assert.equal(await stored(), 0);

  const mia = maintainer("mia", ["appa"]);
  const saved = await call(mia, "edit_prompt", { id: "review.opus", body: edited, note: "tests first" });
  assert.equal(saved.isError, undefined, saved.content[0]!.text);
  assert.ok(await db.get(db.k.selectFrom("audit").select("action").where("action", "=", "prompt-edit").where("login", "=", "mia")));
  const p = (await api.prompts(db, req(mia))).prompts.find((x) => x.id === "review.opus")!;
  assert.equal(p.edit.following, false);
  assert.ok(p.edit.rev !== null && p.edit.rev > 1, "the edit is a new revision after the release's");
  assert.equal(p.edit.mayEdit, true);
  assert.ok(p.template.includes("Read the tests the change touches first."), "the page shows the text that runs");
  assert.equal((await api.prompts(db, req(nora))).prompts.find((x) => x.id === "review.opus")!.edit.mayEdit, false);

  const guidance = { body: "A missing migration is blocking.", note: "migrations", baseRev: null };
  await assert.rejects(api.saveGuidance(db, req(mia, { method: "POST", params: { repo: "appb" }, json: guidance })), (e) => status(e) === 403);
  assert.equal((await call(mia, "edit_prompt", { id: "repo.guidance", repo: "appb", body: guidance.body, note: guidance.note })).isError, true);
  assert.equal((await api.saveGuidance(db, req(mia, { method: "POST", params: { repo: "appa" }, json: guidance }))).ok, true);
  assert.equal((await api.guidance(db, req(nora, { params: { repo: "appb" } }))).text, "", "the guidance stays with its repo");
});
