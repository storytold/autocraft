import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { POSTMERGE_OPUS, PREMERGE_OPUS, REVIEW_OPUS } from "../src/agents/steps.ts";
import { CLAIM_EVIDENCE_CHARS, type OpusPr } from "../src/review/opus-parse.ts";
import { connectDb } from "../src/db/open.ts";
import { postmergeOf } from "../src/dash/api/postmerge.ts";
import { fileFinding } from "../src/postmerge/file.ts";
import { SAMPLE_POSTMERGE_PRS } from "../src/postmerge/parse.ts";
import { saveReview } from "../src/postmerge/review.ts";
import { pendingDefects } from "../src/postmerge/select.ts";

test("Review and Pre-merge verify claim citations in the reviewed checkout", async (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "autocraft-review-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(join(checkout, "main.rs"), "first line\r\nsecond line\r\n");
  writeFileSync(join(checkout, "Makefile"), "one line without a final newline");
  writeFileSync(join(checkout, "actual.test.ts"), "one line");
  writeFileSync(join(checkout, "Dockerfile"), "one line");
  writeFileSync(join(checkout, "Cargo.lock"), "one line");
  writeFileSync(join(checkout, "long.rs"), "line\n".repeat(12));
  writeFileSync(join(checkout, "a b.ts"), "one line");
  writeFileSync(join(checkout, "new guide.md"), "one line");
  mkdirSync(join(checkout, "dir"));
  writeFileSync(join(checkout, "dir/main.rs"), "one line");
  writeFileSync(join(checkout, "dir/other guide.md"), "one line");
  writeFileSync(join(checkout, "dir/café.ts"), "one line");
  writeFileSync(join(checkout, "dir/Makefile"), "one line");
  writeFileSync(join(checkout, "dir/notes:present.ts"), "one line");
  const input: OpusPr = {
    ref: "app#1", title: "Updates a check", body: "The check runs on startup.", author_association: null,
    size: "S", lines_changed: 2, ci: "success", mergeable: null, files: ["main.rs", "Makefile", "new guide.md", "dir/main.rs"],
    tests_omitted: [], lockfiles_omitted: [], mode: "full", earlier_opus: null, diff: "",
  };
  const context = { dir: undefined, semantic: undefined, checkout };
  for (const [evidence, resolves] of [
    ["/repo/main.rs:2, Makefile:1 and new guide.md:1", true],
    ["See dir/main.rs:1 for the check", true],
    ["See `dir/other guide.md:1` for the check", true],
    ["src/missing dir/main.rs:1", false],
    ["`missing dir/main.rs:1` and main.rs:1", false],
    ["`missing dir/main.rs:1 `", false],
    ["main.rs:1 and `missing dir/main.rs:1 trailing text`", false],
    ["main.rs:1 and `missing dir/main.rs:1", false],
    ["` dir/main.rs:1 `", true],
    ["``dir/main.rs:1`` and main.rs:1", true],
    ["main.rs:1 and the token `enabled`", true],
    ["main.rs:1 " + "note ".repeat(4_000) + "missing.rs:1", false],
    ["``missing dir/main.rs:1 `` and main.rs:1", false],
    ["main.rs:1 " + "note ".repeat(CLAIM_EVIDENCE_CHARS / 5) + "missing.rs:1", false],
    ["main.rs:1 " + "note ".repeat(CLAIM_EVIDENCE_CHARS / 5) + "dir/main.rs:1", true],
    ["main.rs:2 and missing.rs:1", false],
    ["main.rs:1 and missing.test.ts:1", false],
    ["main.rs:1 and missing-.editorconfig:1", false],
    ["Cargo.lock:1", true],
    ["actual.test.ts:1, dir/café.ts:1 and dir/Makefile:1", true],
    ["main.rs:1 and dir/café-missing.ts:1", false],
    ["main.rs:1 and dir/NotAFile:1", false],
    ["dir/café.ts:1", true],
    ["dir/Makefile:1", true],
    ["`Dockerfile:1`", true],
    ["`dir/notes:present.ts:1`", true],
    ["main.rs:1 and `dir/notes:missing.ts:1`", false],
    ["main.rs:1 and `nonexistent.extensionless` followed by plain prose", true],
    ["main.rs:1 and `MissingMakefile:1`", false],
    ["main.rs:1 and `a  b.ts:1`", false],
    ["main.rs:1 and /tmp/missing dir/main.rs:1", false],
    ["main.rs:1 and main.rs:1x", false],
    ["main.rs:1 and main.rs:-1", false],
    ["main.rs:1 and main.rs:1.5", false],
    ["main.rs:1 and main.rs:9007199254740992", false],
    ["main.rs:1 and v2.0:1 near https://example.com/notes/file.ts:12", true],
    ["main.rs:1 and `https://example.com/notes/file.ts:12`", true],
    ["main.rs:3", false],
    ["main.rs:0", false],
    ["Makefile:2", false],
  ] as const) {
    const claims = [{ claim: "The check runs on startup.", status: "verified", evidence }];
    const reply = JSON.stringify({
      ref: input.ref, verdict: "take", sure: true, reason: "fine", fixes: [], findings: [], claims,
    });
    const review = (await REVIEW_OPUS.parse(reply, input, { attempt: 0, last: true }, context))?.value.review;
    const premerge = (await PREMERGE_OPUS.parse(reply, input, { attempt: 0, last: true }, context))?.value;
    assert.equal(review?.sure, resolves, evidence);
    assert.equal(premerge?.unsure, !resolves, evidence);
    for (const result of [review, premerge]) {
      assert.equal(result?.claims[0]?.status, resolves ? "verified" : "unverified", evidence);
      assert.ok(result!.claims[0]!.evidence.length <= CLAIM_EVIDENCE_CHARS);
    }
  }

  const citation = " long.rs:12";
  const clippedEvidence = "x".repeat(CLAIM_EVIDENCE_CHARS - citation.length + 1) + citation;
  const replyWithLongEvidence = JSON.stringify({
    ref: input.ref, findings: [],
    claims: [{ claim: input.body, status: "contradicted", impact: "code-wrong", evidence: clippedEvidence }],
  });
  const finding = (await PREMERGE_OPUS.parse(replyWithLongEvidence, input, { attempt: 0, last: true }, context))?.value.findings[0];
  assert.equal(finding?.file, "long.rs");
  assert.equal(finding?.line, 12);
  assert.doesNotMatch(finding?.scenario ?? "", /long\.rs:1$/);

  const fix = { file: "main.rs", change: "Restore the startup check." };
  const duplicate = { file: "/repo/main.rs", change: ` ${fix.change} ` };
  const independent = { file: "main.rs", change: "Clarify the error message." };
  for (const [evidence, topLevel, verdict, sure, expected] of [
    ["main.rs:1", [], "take-fix", true, [fix]],
    ["main.rs:3", [], "take", false, []],
    ["main.rs:3", [duplicate], "take", false, []],
    ["main.rs:3", [duplicate, independent], "take-fix", false, [independent]],
    ["main.rs:1", [duplicate], "take-fix", true, [fix, { ...duplicate, file: "main.rs" }]],
  ] as const) {
    const claims = [{ claim: input.body, status: "contradicted", evidence, impact: "code-wrong", fix }];
    const reply = JSON.stringify({ ref: input.ref, verdict: "take-fix", sure: true, reason: "Needs a fix.", fixes: topLevel, claims });
    const review = (await REVIEW_OPUS.parse(reply, input, { attempt: 0, last: true }, context))?.value.review;
    assert.equal(review?.verdict, verdict, evidence);
    assert.equal(review?.sure, sure, evidence);
    assert.deepEqual(review?.fixes, expected, evidence);
  }
});

test("Post-merge keeps unresolved citations in the review and out of issue filing", async (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "autocraft-postmerge-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(join(checkout, "main.rs"), "the line in the merged tree\n");
  const longDir = "longpath/".repeat(30);
  const prefix = longDir + "x".repeat(300 - longDir.length);
  mkdirSync(join(checkout, longDir), { recursive: true });
  writeFileSync(join(checkout, prefix), "one line");

  const reply = JSON.stringify({ findings: [
    { severity: "defect", title: "Valid", body: "A finding on the merged tree.", file: "/repo/main.rs", line: 1 },
    { severity: "defect", title: "Past EOF", body: "A finding with a nonexistent line.", file: "main.rs", line: 2 },
    { severity: "defect", title: "Missing", body: "A finding with a nonexistent file.", file: "gone.rs", line: 1 },
    { severity: "defect", title: "Truncated", body: "A finding whose shortened path points to a different file.", file: prefix + "-missing", line: 1 },
  ] });
  const input = SAMPLE_POSTMERGE_PRS[0]!;
  const ctx = { attempt: 0, last: true };
  const context = { dir: undefined, semantic: undefined };
  const review = await POSTMERGE_OPUS.parse(reply, input, ctx, { ...context, checkout });
  assert.ok(review);
  assert.deepEqual(review.value.map((f) => f.citationUnverified), [undefined, true, true, true]);
  assert.equal(review.value[0]?.file, "main.rs");
  assert.equal(review.value[3]?.file, null);
  const diffOnly = await POSTMERGE_OPUS.parse(reply, input, ctx, context);
  assert.ok(diffOnly?.value.every((f) => f.citationUnverified === undefined));

  const db = await connectDb(":memory:");
  t.after(() => db.close());
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }));
  await saveReview(db, { repo: "app", number: 1 }, { sha: input.merge_sha, runId: null, model: null, findings: review.value, error: null });
  assert.deepEqual((await pendingDefects(db, "app")).map((d) => d.finding), [0]);
  await assert.rejects(fileFinding(db, "app#1", 1), /could not be verified at the merge commit/);
  const item = await postmergeOf(db, "app", 1, true);
  assert.deepEqual(item?.findings.map((f) => f.filing.state), ["pending", "unverified-citation", "unverified-citation", "unverified-citation"]);
});
