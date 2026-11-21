// Needs queue rows: the reference's meta line, the compact answer word, ages and roving selection.
// Pure helpers only — no DOM, no data access beyond the Decision they are given.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "../web/src/lib/format.ts";
import type { Decision } from "../web/src/api/types.ts";
import { ageTitle, answerWord, compactAge, metaFacts, refText, selectedFor, stepIndex } from "../web/src/modules/decisions/rows.ts";

const decision = (over: Partial<Decision> = {}): Decision => ({ id: "d1", repo: "deckcraft", number: 3180, items: [], kind: "merge", title: "t", askedAt: "2026-11-16T09:00:00Z", claim: null, answer: null, appliedAt: null, exec: null, dispute: null, ...over } as Decision);











test("roving selection defaults to the first row and clamps every movement", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(selectedFor(list, undefined), "a");
  assert.equal(selectedFor(list, "gone"), "a");
  assert.equal(selectedFor(list, "b"), "b");
  assert.equal(selectedFor([], "b"), undefined);
  assert.equal(stepIndex(list, 0, "ArrowDown"), 1);
  assert.equal(stepIndex(list, 2, "ArrowDown"), 2);
  assert.equal(stepIndex(list, 0, "ArrowUp"), 0);
  assert.equal(stepIndex(list, 1, "Home"), 0);
  assert.equal(stepIndex(list, 1, "End"), 2);
  assert.equal(stepIndex([], 0, "ArrowDown"), -1);
});
