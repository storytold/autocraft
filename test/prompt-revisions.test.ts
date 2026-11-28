// A stored prompt revision and a repository's guidance reach the model call that a Task Runner takes, with the version the
// call records; unedited prompts keep the version of their code text, and the fixed system prompt stays the same for every repo.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { askClaude, promptVersion } from "../src/classify/run.ts";
import { ensurePrompts } from "../src/data/prompts/index.ts";
import { CLAUDE_PROMPTS, JEV_PROMPTS, withoutRepoDir, type ClaudePromptId, type JevPromptId } from "../src/prompts/index.ts";
import { SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { fakeTaskRunner } from "./fake-runner.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = await connectDb(join(mkdtempSync(join(SCRATCH, "prompt-revisions-")), "t.db"));

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 10);
/** The version of a prompt's code text, the formula every recorded version had before revisions existed (the guidance line is new). */
const codeVersion = (id: ClaudePromptId | JevPromptId): string =>
  id in CLAUDE_PROMPTS ? hash(CLAUDE_PROMPTS[id as ClaudePromptId].template.replace("{{repo_guidance}}\n", "")) : hash(JSON.stringify(JEV_PROMPTS[id as JevPromptId].request));

test("an active edit and a repo's guidance reach the Task Runner; versions and the system prompt follow", async () => {
  const code = CLAUDE_PROMPTS["review.opus"].template;
  const edited = `Read the tests the change touches before anything else.\n\n${code}`;
  const row = { scope: "base", at: "2026-11-28T00:00:00Z", default_hash: codeVersion("review.opus"), follows: 0, from_rev: null };
  await db.run(db.k.insertInto("prompt_revisions").values([
    { ...row, prompt_id: "review.opus", rev: 1, kind: "release", body: code, version: codeVersion("review.opus"), follows: 1, active: 0, author: "release", note: "the release default" },
    { ...row, prompt_id: "review.opus", rev: 2, kind: "edit", body: edited, version: hash(edited.replace("{{repo_guidance}}\n", "")), active: 1, author: "maintainer", note: "tests first" },
    { ...row, prompt_id: "repo.guidance", scope: "alpha", rev: 1, kind: "edit", body: "In this repository a saved-file change without a migration is blocking.", version: "g", default_hash: null, active: 1, author: "maintainer", note: "migrations" },
  ]));

  const runner = await fakeTaskRunner(db, () => "{}");
  const pr = (repo: string) => withoutRepoDir(SAMPLE_OPUS_PRS).map((p) => ({ ...p, ref: `${repo}#${p.ref.split("#")[1]}` }));
  try {
    await askClaude("review.opus", "opus", pr("alpha"), db);
    await askClaude("review.opus", "opus", pr("beta"), db);
  } finally {
    await runner.stop();
  }
  const [a, b] = runner.calls;
  assert.ok(a && b, "both calls reached the Task Runner");
  assert.ok(a.system?.startsWith("Read the tests the change touches"), "the edited text runs");
  assert.equal(a.system, b.system, "the fixed system prompt is the same for every repo");
  assert.match(a.stdin, /<repo_guidance>[\s\S]*without a migration is blocking/);
  assert.doesNotMatch(b.stdin, /repo_guidance|without a migration/);

  const recorded = new Map((await db.all(db.k.selectFrom("remote_calls").select(["id", "prompt_version"]).orderBy("id"))).map((r, i) => [i, r.prompt_version]));
  const editedVersion = hash(edited.replace("{{repo_guidance}}\n", ""));
  assert.notEqual(editedVersion, codeVersion("review.opus"));
  assert.equal(recorded.get(1), editedVersion, "a call without guidance records the edit's version");
  assert.ok(recorded.get(0)!.startsWith(`${editedVersion}.g`), "a call with guidance records it in its version");

  // Every prompt not edited keeps the version of its code text.
  await ensurePrompts(db);
  const ids = [...Object.keys(CLAUDE_PROMPTS), ...Object.keys(JEV_PROMPTS)].filter((id) => id !== "review.opus") as (ClaudePromptId | JevPromptId)[];
  assert.deepEqual(ids.filter((id) => promptVersion(id) !== codeVersion(id)), []);
});
