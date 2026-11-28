// Prompt edits keep what code relies on: every template locks its placeholders, harness wording and data tail; a save that
// changes a locked block, a placeholder, carries a credential, grows too large or has no note stores nothing; rollback and
// the switch to the release default bring the code's version back; a newer release default raises the release flag.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promptVersion } from "../src/classify/run.ts";
import { ensurePrompts, releaseFlag, rollback, saveEdit, useRelease } from "../src/data/prompts/index.ts";
import { harnessSpans } from "../src/prompts/harness.ts";
import { CLAUDE_PROMPTS, codeBody, codeDefault, type ClaudePromptId } from "../src/prompts/index.ts";
import { segments, stripLocks } from "../src/prompts/locks.ts";
import { DATA_LOCK, dataStart } from "../src/prompts/template-locks.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

test("every template locks its placeholders, harness wording and data tail, and strips to its text", () => {
  for (const [id, p] of Object.entries(CLAUDE_PROMPTS)) {
    const body = codeBody(id as ClaudePromptId);
    assert.equal(stripLocks(body), p.template, `${id}: the text form strips to the template`);
    const segs = segments(body);
    assert.ok(segs, `${id}: markers pair up`);
    const lockedAt: [number, number][] = [];
    let at = 0;
    for (const s of segs) { if (s.locked) lockedAt.push([at, at + s.text.length]); at += s.text.length; }
    const inLock = (a: number, b: number): boolean => lockedAt.some(([x, y]) => x <= a && b <= y);
    for (const m of p.template.matchAll(/\{\{\w+\}\}/g)) assert.ok(inLock(m.index, m.index + m[0].length), `${id}: ${m[0]} is locked`);
    for (const [a, b] of harnessSpans(p.template)) assert.ok(inLock(a, b), `${id}: "${p.template.slice(a, b)}" is locked`);
    const tail = p.template.slice(dataStart(p.template));
    if (tail) assert.deepEqual(segs.at(-1), { locked: true, name: DATA_LOCK, text: tail }, `${id}: the data tail is one locked block`);
  }
});

mkdirSync(SCRATCH, { recursive: true });
const db = await connectDb(join(mkdtempSync(join(SCRATCH, "prompt-edit-")), "t.db"));
const rows = async () => await db.all(db.k.selectFrom("prompt_revisions").select(["prompt_id", "scope", "rev", "kind", "active", "follows"]).orderBy("id"));
const audits = async () => (await db.all(db.k.selectFrom("audit").select(["action", "target"]).where("action", "like", "prompt-%"))).length;

test("saves are checked, rolled back and switched to the release, with their audit rows", async () => {
  const id = "review.opus";
  const code = codeBody(id);
  const by = "maintainer";
  const add = (text: string, at = 0): string => `${code.slice(0, at)}${text}${code.slice(at)}`;
  const outputAt = code.indexOf("⟦locked:output⟧");
  const refused = [
    { why: "a locked block changed", body: code.replace("Reply with ONLY one JSON object:", "Reply with one JSON object:") },
    { why: "a placeholder dropped", body: code.replace("⟦locked:repo_access⟧{{repo_access}}⟦/locked⟧", "") },
    { why: "a placeholder added", body: add("Also see {{discussion}}.\n\n") },
    { why: "a credential", body: add("Use token abcdefghijklmnop1234 for the API.\n\n") },
    { why: "too large", body: add(`${"Look closer. ".repeat(4000)}\n\n`) },
    { why: "the guidance slot moved out of the data block", body: code.replace("{{repo_guidance}}\n", "").replace("⟦locked:output⟧", "{{repo_guidance}}\n⟦locked:output⟧") },
    { why: "no note", body: add("Read the tests first.\n\n", outputAt), note: " " },
    { why: "a credential in the note", body: add("Read the tests first.\n\n", outputAt), note: "token abcdefghijklmnop1234" },
    { why: "a bidirectional override", body: add("Read the tests \u202efirst.\n\n", outputAt) },
    { why: "unchanged", body: code },
  ];
  for (const r of refused) {
    const res = await saveEdit(db, { id, scope: "base", body: r.body, note: r.note ?? "a change", by, baseRev: null });
    assert.equal(res.ok, false, r.why);
    assert.ok(!res.ok && res.problems.length > 0, `${r.why}: a problem is named`);
  }
  // A sandbox path whose neighbouring editable text makes it read as another path.
  const compare = codeBody("verify.compare");
  const path = "⟦locked:harness⟧/repo⟦/locked⟧";
  assert.ok(compare.includes(path));
  assert.equal((await saveEdit(db, { id: "verify.compare", scope: "base", body: compare.replace(path, `${path}s`), note: "x", by, baseRev: null })).ok, false, "a harness path cannot grow");
  assert.equal((await saveEdit(db, { id: "classify.jev", scope: "base", body: "{}", note: "x", by, baseRev: null })).ok, false, "Jev prompts wait for their form");
  assert.deepEqual(await rows(), [], "a refused save stores nothing");
  assert.equal(await audits(), 0);

  const edited = add("Read the tests the change touches first.\n\n", outputAt);
  const saved = await saveEdit(db, { id, scope: "base", body: edited, note: "tests first", by, baseRev: null });
  assert.ok(saved.ok);
  await ensurePrompts(db);
  assert.notEqual(promptVersion(id), codeDefault(id).version, "the edit runs");
  assert.equal(promptVersion(id), saved.version);
  const stale = await saveEdit(db, { id, scope: "base", body: add("Other text.\n\n", outputAt), note: "late", by, baseRev: null });
  assert.ok(!stale.ok && stale.stale, "a save from an older revision is refused");

  assert.ok((await rollback(db, { id, scope: "base", rev: 1, by, note: "back to the release" })).ok);
  await ensurePrompts(db);
  assert.equal(promptVersion(id), codeDefault(id).version, "rollback to rev 1 runs the code default");
  assert.deepEqual((await releaseFlag(db, id)).newerDefault, false);

  // An edit made against an older default (a release has changed the code since): the flag is raised and shows the change.
  const older = codeDefault(id).body.replace("A wrong take costs more than a wrong hold.", "A wrong take is costly.");
  const old = { prompt_id: id, scope: "base", at: "2026-11-28T00:00:00Z", from_rev: null, author: "release", note: "older release" };
  await db.run(db.k.updateTable("prompt_revisions").set({ active: 0 }).where("prompt_id", "=", id));
  await db.run(db.k.insertInto("prompt_revisions").values([
    { ...old, rev: 10, kind: "release", body: older, version: "0lderdef01", default_hash: "0lderdef01", follows: 1, active: 0 },
    { ...old, rev: 11, kind: "edit", body: edited, version: saved.version, default_hash: "0lderdef01", follows: 0, active: 1, author: by, note: "tests first" },
  ]));
  const flag = await releaseFlag(db, id);
  assert.equal(flag.newerDefault, true);
  assert.equal(flag.structureChanged, false);
  assert.ok(flag.diff?.some((l) => l.kind === "add" && "text" in l && l.text.includes("A wrong take costs more")), "the diff shows what the release changed");
  assert.ok((await useRelease(db, { id, by, note: "take the new wording" })).ok);
  assert.equal((await releaseFlag(db, id)).newerDefault, false, "switching to the release clears the flag");
  await ensurePrompts(db);
  assert.equal(promptVersion(id), codeDefault(id).version);
  assert.equal((await rows()).filter((r) => Number(r.active) === 1).length, 1, "one active revision");
  assert.equal(await audits(), 3, "the save, the rollback and the switch are audited");
});
