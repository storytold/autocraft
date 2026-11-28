// The dashboard's prompt editor changes only editable text: its body passes the server's save checks, and a draft for a
// locked block is refused before it is sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEdit } from "../src/prompts/checks.ts";
import { BASE_SCOPE, codeBody } from "../src/prompts/index.ts";
import { joinSegments, segments } from "../src/prompts/locks.ts";
import { editedBody } from "../web/src/lib/prompt-segments.ts";

test("an edit of editable text saves; a draft or a change of a locked block is refused", () => {
  const segs = segments(codeBody("review.opus"))!;
  const editable = segs.findIndex((s) => !s.locked && s.text.trim());
  const lockedAt = segs.findIndex((s) => s.locked);
  assert.ok(editable >= 0 && lockedAt >= 0);

  const body = editedBody(segs, { [editable]: `${segs[editable]!.text}\nPrefer small, focused fixes.\n` });
  assert.ok(body);
  assert.deepEqual(checkEdit("review.opus", BASE_SCOPE, body, "prefer small fixes", null), []);

  assert.equal(editedBody(segs, { [lockedAt]: "anything" }), null);
  const altered = joinSegments(segs.map((s, i) => (i === lockedAt ? { ...s, text: `${s.text} ` } : s)));
  assert.ok(checkEdit("review.opus", BASE_SCOPE, altered, "a change", null).some((p) => p.where.startsWith("locked block")));
});
