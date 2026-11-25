import assert from "node:assert/strict";
import { test } from "node:test";
import { verdictOf } from "../src/verify/results.ts";

test("a passing head distinguishes a demonstrated regression from an inconclusive base", () => {
  const head = { kind: "pass" } as const;
  const failedTest = { kind: "fail", step: "test", exitCode: 1, timedOut: false } as const;
  assert.deepEqual(verdictOf(head, failedTest), { state: "passed" });
  const timeout = verdictOf(head, { ...failedTest, timedOut: true });
  assert.equal(timeout.state, "passed");
  assert.match(timeout.note ?? "", /inconclusive.*timed out/i);
  const buildFailure = verdictOf(head, { ...failedTest, step: "build" });
  assert.equal(buildFailure.state, "passed");
  assert.match(buildFailure.note ?? "", /inconclusive.*did not build/i);
});
