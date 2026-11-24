// An item page opened from Needs you goes back to that queue; any other arrival goes back to Items.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromState, readFrom } from "../web/src/lib/links.ts";

test("a Needs you queue URL round-trips through history state", () => {
  assert.deepEqual(readFrom(fromState("/needs?repo=a,b&decision=7")), { url: "/needs?repo=a,b&decision=7" });
  assert.deepEqual(readFrom(fromState("/needs")), { url: "/needs" });
});

test("no state, junk state or another URL falls back to Items", () => {
  for (const state of [null, undefined, 5, "x", {}, { from: null }, { from: { url: 3 } }, fromState("/items"), fromState("/needsx"), fromState("https://evil.example/needs"), fromState("//evil.example/needs")]) {
    assert.equal(readFrom(state), null, JSON.stringify(state));
  }
});
