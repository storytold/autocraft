// Needs list scope and private cursor codecs: reader-collision safety, the decisions? topic prefix,
// and a cursor that never reaches the wire with its scope on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { topicsFor } from "../web/src/api/topics.ts";
import { hasContinuation, nextCursor, pagesForScope, privateCursor, scopedListKey, scopeString, unwrapCursor } from "../web/src/modules/decisions/list-scope.ts";

const scope = { login: "ana", role: "operator", search: "repo=deckcraft&kind=scope" };

test("the key keeps the decisions? topic prefix the live invalidation depends on", () => {
  const key = scopedListKey(scope);
  assert.ok(key.startsWith("decisions?"), key);
  assert.deepEqual(topicsFor(key), topicsFor("decisions?repo=deckcraft"));
  // Not a bare reader prefix: that form would fall out of the topic rule entirely.
  assert.notEqual(key, `decisions:${scope.login}`);
});

test("the scope string is a collision-safe JSON tuple of reader and filter", () => {
  const a = scopeString(scope);
  const b = scopeString({ ...scope, login: "ana:operator" });
  const c = scopeString({ ...scope, search: "repo=deckcraft&kind=scope&x=1" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  // A delimiter inside a value cannot produce the same tuple as a different split.
  assert.notEqual(scopeString({ login: "a|b", role: "c", search: "s" }), scopeString({ login: "a", role: "b|c", search: "s" }));
  assert.deepEqual(JSON.parse(a), [scope.login, scope.role, scope.search, null]);
});

test("an internal cursor round-trips inside its own scope and fails closed outside it", () => {
  for (const server of ["abc", "a|b", "cursor/with+chars", "café", JSON.stringify(["x", "y"])]) {
    const raw = privateCursor(scopeString(scope), server);
    const unwrapped = unwrapCursor(raw, scopeString(scope));
    assert.deepEqual(unwrapped, { ok: true, cursor: server });
    // The backend never sees the scope or the JSON: only the server cursor.
    assert.equal(unwrapped.ok && unwrapped.cursor?.includes("ana"), false);
  }
  // `undefined` is the first page and stays distinct from any decoded value.
  assert.deepEqual(unwrapCursor(undefined, scopeString(scope)), { ok: true, cursor: undefined });
  // The server never emits an empty continuation; a decoded empty string is invalid, not a first page.
  assert.deepEqual(unwrapCursor(privateCursor(scopeString(scope), ""), scopeString(scope)), { ok: false, reason: "empty" });
  // Another reader/filter, a malformed value or the wrong shape fails closed.
  assert.deepEqual(unwrapCursor(privateCursor(scopeString({ ...scope, login: "bo" }), "abc"), scopeString(scope)), { ok: false, reason: "scope" });
  assert.deepEqual(unwrapCursor(privateCursor(scopeString({ ...scope, search: "repo=deckcraft" }), "abc"), scopeString(scope)), { ok: false, reason: "scope" });
  assert.deepEqual(unwrapCursor("not json", scopeString(scope)), { ok: false, reason: "malformed" });
  assert.deepEqual(unwrapCursor("[\"only-one\"]", scopeString(scope)), { ok: false, reason: "malformed" });
  assert.deepEqual(unwrapCursor(JSON.stringify([scopeString(scope), 7]), scopeString(scope)), { ok: false, reason: "malformed" });
});

test("only pages fetched for the current scope are exposed", () => {
  const s = scopeString(scope);
  assert.equal(pagesForScope(undefined, s), undefined);
  assert.equal(pagesForScope([], s), undefined);
  assert.equal(pagesForScope([{ scope: s, page: 1 }], s)?.length, 1);
  assert.equal(pagesForScope([{ scope: s, page: 1 }, { scope: "other", page: 2 }], s), undefined);
});

test("only a real, non-empty server cursor becomes a continuation", () => {
  const s = scopeString(scope);
  // null and empty both end the list: nothing is minted, so the hook cannot load an empty continuation.
  assert.equal(nextCursor(s, { next: null }), null);
  assert.equal(nextCursor(s, { next: "" }), null);
  assert.equal(hasContinuation({ next: null }), false);
  assert.equal(hasContinuation({ next: "" }), false);
  assert.equal(hasContinuation(undefined), false);
  // A real opaque cursor is minted exactly and unwraps back to the same bytes the server sent.
  for (const server of ["abc", "a|b", "cursor/with+chars", "café", "a b", '{"json":"cursor"}']) {
    const minted = nextCursor(s, { next: server });
    assert.equal(typeof minted, "string");
    assert.deepEqual(unwrapCursor(minted!, s), { ok: true, cursor: server });
    assert.equal(hasContinuation({ next: server }), true);
  }
});


test("project changes reject previous pages and cursors even before the URL is synchronized", () => {
  // Same reader and URL, different effective project: this is the picker-to-URL transition.
  const a = scopeString({ ...scope, search: "kind=scope", project: "deckcraft" });
  const b = scopeString({ ...scope, search: "kind=scope", project: "photocraft" });
  assert.notEqual(a, b);
  const cursor = nextCursor(a, { next: "opaque-server-cursor" })!;
  assert.deepEqual(unwrapCursor(cursor, b), { ok: false, reason: "scope" });
  assert.equal(pagesForScope([{ scope: a, page: { decisions: ["old-project"], total: 1 } }], b), undefined);
  assert.equal(pagesForScope([{ scope: b, page: 1 }, { scope: a, page: 2 }], b), undefined);
  assert.deepEqual(unwrapCursor(nextCursor(b, { next: "opaque-server-cursor" })!, b), { ok: true, cursor: "opaque-server-cursor" });
});

test("multi-repo list URLs remain a distinct all-projects request scope", () => {
  const search = "repo=deckcraft%2Cphotocraft&kind=scope";
  const all = scopeString({ ...scope, search, project: null });
  const picked = scopeString({ ...scope, search, project: "deckcraft" });
  assert.notEqual(all, picked);
  assert.deepEqual(JSON.parse(all), [scope.login, scope.role, search, null]);
  assert.ok(scopedListKey({ ...scope, search, project: null }).startsWith("decisions?"));
  assert.equal(pagesForScope([{ scope: all, page: ["deckcraft", "photocraft"] }], all)?.length, 1);
});
