// /needs opens with the decision View and scope the person left, unless the link names its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScope, restorePatch, saveScope, scopeOf } from "../web/src/modules/decisions/savedScope.ts";

test("the saved part of a URL is the View and the scope, nothing else", () => {
  assert.deepEqual(scopeOf("?tab=answered&repo=a,b&kind=merge&age=3&all=1&decision=9&peek=2", null), { tab: "answered", repo: "a,b", kind: "merge", age: "3", all: "1" });
  assert.deepEqual(scopeOf("?tab=feedback&kind=merge", null), { kind: "merge" });
  assert.deepEqual(scopeOf("?repo=a&kind=merge", "a"), { kind: "merge" }, "a pick's repo is not saved");
});

test("an empty URL restores; a URL naming any View or scope key wins", () => {
  const saved = { tab: "answered", repo: "a,b", kind: "merge" };
  assert.deepEqual(restorePatch("", saved, null), saved);
  assert.deepEqual(restorePatch("?decision=9", saved, null), saved);
  for (const search of ["?repo=c", "?kind=hold", "?age=1", "?all=1", "?tab=snoozed", "?tab=feedback"]) assert.equal(restorePatch(search, saved, null), null, search);
  assert.equal(restorePatch("", {}, null), null);
});

test("with a pick, saved repos are dropped and the pick's repo in the URL does not block", () => {
  assert.deepEqual(restorePatch("?repo=a", { repo: "b", kind: "merge" }, "a"), { kind: "merge" });
  assert.equal(restorePatch("?repo=a", { repo: "b" }, "a"), null);
});

test("storage round-trips, and junk or blocked storage gives nothing", () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    saveScope("ann", { kind: "merge", tab: "answered" });
    assert.deepEqual(loadScope("ann"), { kind: "merge", tab: "answered" });
    assert.deepEqual(loadScope("bob"), {}, "per person");
    saveScope("ann", {});
    assert.equal(store.size, 0, "an empty scope removes the key");
    store.set("autocraft:ann:needs-filters", JSON.stringify({ kind: 3, repo: "a", other: "x" }));
    assert.deepEqual(loadScope("ann"), { repo: "a" });
    store.set("autocraft:ann:needs-filters", "{not json");
    assert.deepEqual(loadScope("ann"), {});
    g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    assert.deepEqual(loadScope("ann"), {});
    saveScope("ann", { kind: "merge" });
  } finally {
    delete g.localStorage;
  }
});
