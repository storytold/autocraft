import assert from "node:assert/strict";
import { test } from "node:test";
import type { Decision, User } from "../web/src/api/types.ts";
import { reviewDecision } from "../web/src/modules/decisions/review.ts";

const decision = (over: Partial<Decision> = {}) => ({ id: "designcraft#1484:merge", repo: "designcraft", number: 1484, items: [], answer: null, ...over } as Decision);
const user = (role: User["role"]) => ({ login: "reader", role } as User);

test("explicit review claims presence then opens the native item decision, without answering", () => {
  const calls: string[] = [];
  reviewDecision(decision(), user("operator"), async id => { calls.push(`claim:${id}`); }, to => calls.push(`navigate:${to}`));
  assert.deepEqual(calls, ["claim:designcraft#1484:merge", "navigate:/items/designcraft/1484#decision-designcraft%231484%3Amerge"]);
});

test("viewers open the native read-only item without a claim", () => {
  const calls: string[] = [];
  reviewDecision(decision(), user("viewer"), async () => { calls.push("claim"); }, to => calls.push(to));
  assert.deepEqual(calls, ["/items/designcraft/1484#decision-designcraft%231484%3Amerge"]);
});

test("reviewing an answered decision never sends a new presence claim", () => {
  let claims = 0; let path = "";
  reviewDecision(decision({ answer: "merge" }), user("operator"), async () => { claims++; }, to => { path = to; });
  assert.equal(claims, 0);
  assert.equal(path, "/items/designcraft/1484#decision-designcraft%231484%3Amerge");
});

test("a refused presence claim does not hide or delay the full answer form", async () => {
  let path = "";
  reviewDecision(decision(), user("maintainer"), async () => { throw new Error("presence unavailable"); }, to => { path = to; });
  assert.equal(path, "/items/designcraft/1484#decision-designcraft%231484%3Amerge");
  await Promise.resolve();
});

test("batch and memberless decisions retain the native item or resolver route", () => {
  const paths: string[] = [];
  const open = (d: Decision) => reviewDecision(d, user("operator"), async () => undefined, to => paths.push(to));
  open(decision({ id: "batch:7", number: null, items: [{ repo: "photocraft", number: 42, kind: "issue", state: "open", title: "Batch item" }] }));
  open(decision({ id: "group:9", number: null, items: [] }));
  assert.deepEqual(paths, ["/items/photocraft/42#decision-batch%3A7", "/needs/decisions/group%3A9"]);
});
