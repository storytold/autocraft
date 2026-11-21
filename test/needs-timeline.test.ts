import test from "node:test";
import assert from "node:assert/strict";
import type { Decision, ItemPageData, TimelineEntry } from "../web/src/api/types.ts";
import {
  timelineModel, timelineReadState, timelineReference,
} from "../web/src/modules/decisions/timeline.ts";

const ref = { repo: "designcraft", number: 17 };
const entry = (index: number, patch: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: `event-${index}`, text: `Event ${index}`, actor: "AutoCraft", at: String(index).padStart(4, "0"),
  kind: "harness", icon: "job", tone: "neutral", costUsd: null, major: false, jobId: null,
  reviewId: null, githubId: null, commit: null, preapproval: null, calls: [], body: null,
  markdown: false, lines: [], feedback: null, ...patch,
});
// A structural ItemPageData fixture for the pure gate's declared fields, not a mock of the native hook.
const page = (timeline: TimelineEntry[] = [], patch: Partial<ItemPageData> = {}): ItemPageData => ({
  ...ref, timeline, ...patch,
}) as ItemPageData;
const own = (repo: unknown, number: unknown) => ({ repo, number }) as Pick<Decision, "repo" | "number">;

// These tests establish pure helper behavior only. Native observers, escaping, role boundaries and no-model-on-error
// require actual UI evidence; no unit mirror counter here claims to prove them.

test("U01 reference.own-issue-pr", () => {
  const issue = { ...ref, shown: { kind: "issue", state: "open", title: "Issue" } };
  const pr = { ...ref, shown: { kind: "pr", state: "open", title: "Pull request" } };
  assert.deepEqual(timelineReference(issue), ref);
  assert.deepEqual(timelineReference(pr), ref);
  assert.deepEqual(timelineReference({ ...ref, number: 1 }), { repo: ref.repo, number: 1 });
});

test("U02 reference.invalid-number", () => {
  for (const number of [null, undefined, 0, -1, 1.5, NaN, Infinity, -Infinity, "17", true]) {
    assert.equal(timelineReference(own(ref.repo, number)), null, `invalid number ${String(number)}`);
  }
});

test("U03 reference.invalid-repo", () => {
  for (const repo of ["", "  \n\t", null, undefined, 17]) assert.equal(timelineReference(own(repo, 17)), null);
  const original = " designcraft ";
  assert.deepEqual(timelineReference(own(original, 17)), { repo: original, number: 17 }, "validity checking must not rewrite the supplied ref");
});

test("U04 reference.no-member-guess", () => {
  const memberOnly = {
    repo: "designcraft", number: null,
    items: [{ repo: "othercraft", number: 99 }], group: [{ repo: "thirdcraft", number: 100 }],
    related: [{ repo: "fourthcraft", number: 101 }], id: "othercraft#99", title: "othercraft#99",
  };
  assert.equal(timelineReference(memberOnly), null);
  const denied = { ...ref };
  for (const field of ["items", "group", "related", "id", "title", "shown", "kind"]) {
    Object.defineProperty(denied, field, { get() { throw new Error(`unexpected member access: ${field}`); } });
  }
  assert.deepEqual(timelineReference(denied), ref);
});









test("U12 model.more-than-four", () => {
  const rows = timelineModel(Array.from({ length: 7 }, (_, i) => entry(i))).rows;
  assert.deepEqual(rows.map((r) => r.text), ["Event 3", "Event 4", "Event 5", "Event 6"]);
  assert.deepEqual(rows.map((r) => r.key), ['[3,"event-3"]', '[4,"event-4"]', '[5,"event-5"]', '[6,"event-6"]']);
});















test("U23 read.error-data", () => {
  const data = page([entry(1)]);
  assert.equal(timelineReadState(ref, { data, loading: false, error: "private failure detail" }), "error");
});

test("U24 read.blank-error", () => {
  assert.equal(timelineReadState(ref, { data: page([entry(1)]), loading: false, error: "" }), "error");
  assert.equal(timelineReadState(ref, { data: undefined, loading: false, error: "" }), "error");
  assert.equal(timelineReadState(ref, { data: undefined, loading: true, error: "" }), "error", "a defined error wins even over loading");
});

test("U25 read.waiting", () => {
  assert.equal(timelineReadState(ref, { data: undefined, loading: true, error: undefined }), "waiting");
});
