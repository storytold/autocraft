import test from "node:test";
import assert from "node:assert/strict";
import { decisionEvidenceModel, itemEvidenceModel, evidenceStaff } from "../web/src/modules/decisions/evidence.ts";

const d = (over: Record<string, unknown> = {}) => ({
  id: "designcraft#3837:scope", kind: "scope", repo: "designcraft", number: 3837,
  summary: "One summary.", summaryBy: "sonnet", summaryAt: "2026-10-30T02:10:00.000Z",
  context: ["c1", "c2"], facts: ["+1 −2 · 3 files", "author: x", "CI passing", "f4", "f5", "f6", "f7", "f8"],
  risks: ["r-should-not-show-for-scope"], classifications: [], askedBy: "autocraft", askedAt: "2026-10-30T02:00:00.000Z",
  docket: "deckcraft#77", optionTexts: [], items: [], shown: null, ...over,
}) as never;












test("item evidence: a viewer never sees staff-only summary/why/risks, whatever the payload says", () => {
  const payload = {
    repo: "designcraft", number: 3837, kind: "pr", state: "open", title: "t", author: "a", stamp: "s",
    header: {}, status: {}, bar: {}, costUsd: 0,
    reviews: { latest: { id: "r1", head: "abc1234", current: true, at: "2026-10-30T02:00:00.000Z", trigger: "new-head", why: "why-text", verdict: "take", sure: true, summary: "sum-text", fixes: ["f"], risks: ["risk-text"], claims: [], blockedBy: [], costUsd: 3 }, earlier: [] },
    timeline: [], github: { checks: [{ name: "ci", state: "passing" }], syncedAt: "2026-10-30T03:00:00.000Z", description: "", events: [], commits: [], files: [], url: "" },
    screenshots: [], prBuild: null,
  } as never;
  const viewer = itemEvidenceModel(payload, false)!;
  assert.equal(viewer.review?.summary, null);
  assert.equal(viewer.review?.why, null);
  assert.deepEqual(viewer.review?.risks, []);
  const staff = itemEvidenceModel(payload, true)!;
  assert.equal(staff.review?.summary, "sum-text");
  assert.equal(staff.review?.why, "why-text");
  assert.deepEqual(staff.review?.risks, ["risk-text"]);
});
