// A Jev prompt's edit changes only its questions' text: one that renames a key, sets a type, renames a criteria label or
// repeats the locked opening is refused and stores nothing; an accepted classify.jev edit changes only that instruction in
// the request sent to `jev ask`, the call records the edit's version, and the answer is still read by key and label.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promptVersion, runJev, setRunner, type Runner } from "../src/classify/run.ts";
import { ensurePrompts, releaseFlag, saveEdit } from "../src/data/prompts/index.ts";
import { JEV_PROMPTS, codeDefault } from "../src/prompts/index.ts";
import { jevLead } from "../src/prompts/jev-body.ts";
import { SAMPLE_ITEMS } from "../src/prompts/samples.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = await connectDb(join(mkdtempSync(join(SCRATCH, "prompt-jev-")), "t.db"));
for (const i of SAMPLE_ITEMS)
  await db.run(db.k.insertInto("items").values({ repo: i.repo, number: i.number, kind: i.kind, state: "OPEN", title: i.title, body: i.body, additions: null, deletions: null, changed_files: i.files_changed,
    author_association: i.author_association, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));

type Body = { questions: Record<string, { instructions: string; criteria?: Record<string, string>; type?: string }> };
const id = "classify.jev";
const code = JEV_PROMPTS[id].request;
const start = (): Body => JSON.parse(codeDefault(id).body) as Body;
const save = (b: Body | string, note = "a change") => saveEdit(db, { id, scope: "base", body: typeof b === "string" ? b : JSON.stringify(b), note, by: "maintainer", baseRev: null });

test("a Jev edit keeps keys, types and labels; only its text changes what is sent", async () => {
  const refused: [string, (b: Body) => void][] = [
    ["a renamed key", (b) => { b.questions.flaw = b.questions.security!; delete b.questions.security; }],
    ["a type", (b) => { b.questions.security!.type = "choice"; }],
    ["a renamed criteria label", (b) => { const c = b.questions.type!.criteria!; c.fix = c.bugfix!; delete c.bugfix; }],
    ["an emptied criterion", (b) => { b.questions.type!.criteria!.infra = " "; }],
    ["the locked opening repeated", (b) => { b.questions.security!.instructions = code.questions.security.instructions; }],
    ["a placeholder", (b) => { b.questions.security!.instructions += " See {{item}}."; }],
    ["unchanged", () => {}],
  ];
  for (const [why, change] of refused) {
    const b = start();
    change(b);
    const r = await save(b);
    assert.ok(!r.ok && r.problems.length > 0, `${why} is refused with a problem`);
  }
  assert.equal((await db.all(db.k.selectFrom("prompt_revisions").select("id"))).length, 0, "a refused save stores nothing");

  const added = " A missing permission check on a write counts as a hole.";
  const b = start();
  b.questions.security!.instructions += added;
  const saved = await save(b, "permission checks count");
  assert.ok(saved.ok, JSON.stringify(saved));
  await ensurePrompts(db);
  assert.equal(promptVersion(id), saved.version, "calls record the edit's version");
  assert.notEqual(saved.version, codeDefault(id).version);
  assert.equal((await releaseFlag(db, id)).structureChanged, false);

  const sent: string[] = [];
  const fake: Runner = async (_cmd, _args, input) => {
    sent.push(input);
    const answers = { type: { choice: "bugfix", confidence: 0.9, probabilities: { bugfix: 0.9 } }, security: { noul: 0.95 }, needs_decision: { noul: 0.1 } };
    return { code: 0, stdout: JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 2 } }), stderr: "" };
  };
  const restore = setRunner(fake);
  try {
    await runJev(db, "t", [SAMPLE_ITEMS[0]!]);
  } finally {
    restore();
  }
  assert.equal(sent.length, 1);
  const req = JSON.parse(sent[0]!) as { state: string } & typeof code;
  const want = { ...code, questions: { ...code.questions, security: { ...code.questions.security, instructions: code.questions.security.instructions + added } } };
  assert.deepEqual({ ...req, state: code.state }, want, "only the edited instruction differs from the code's request");
  assert.ok(req.questions.security.instructions.startsWith(jevLead(code.questions.security.instructions)), "the locked opening stays in front");
  const row = await db.get(db.k.selectFrom("classifications").select(["type_label", "flags"]).where("run_id", "=", "t"));
  assert.equal(row?.type_label, "bugfix", "the answer is read by its key and label");
  assert.match(String(row?.flags), /security/);
});
