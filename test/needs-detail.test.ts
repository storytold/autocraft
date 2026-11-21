// Selected-decision state: URL parsing, the paired anchor bookmark (identity + coordinate + fallback offset +
// capture epoch), the independent focus clock, and the owned-root/live-URI guard.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptCapture, captureSnapshot, clamp, clearSnapshotFor, commitChangesId, focusAllows, liveDecisionId, liveScopeOf,
  peekSnapshot, readDecisionParam, resetSnapshots, resolveActive, resolveRestore, scopeOf, snapshotFor,
} from "../web/src/modules/decisions/selection.ts";

const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
const rowMap = (ids: string[]) => new Map(ids.map((id) => [id, { id }]));

test("one non-empty decision value requests it; empty, duplicate and malformed values stay honest", () => {
  assert.deepEqual(readDecisionParam(""), { kind: "none" });
  assert.deepEqual(readDecisionParam("?decision=photocraft%234127"), { kind: "requested", id: "photocraft#4127" });
  assert.deepEqual(readDecisionParam("?decision="), { kind: "unavailable", raw: "", reason: "empty" });
  assert.deepEqual(readDecisionParam("?decision=a&decision=b"), { kind: "unavailable", raw: "b", reason: "duplicate" });
  assert.deepEqual(readDecisionParam("?decision=two%20words"), { kind: "unavailable", raw: "two words", reason: "malformed" });
  for (const id of ["a|b", "café", '{"json":"id"}', "0"]) {
    const parsed = readDecisionParam(`?decision=${encodeURIComponent(id)}`);
    assert.equal(parsed.kind, "requested");
    assert.equal(parsed.kind === "requested" && parsed.id, id);
  }
  // The live URI id is read the same way at mutation time.
  assert.equal(liveDecisionId("?decision=b"), "b");
  assert.equal(liveDecisionId("?decision="), undefined);
});

test("the active decision is the requested id only when the current receipt holds it", () => {
  assert.equal(resolveActive({ kind: "requested", id: "b" }, rows, undefined), "b");
  assert.equal(resolveActive({ kind: "requested", id: "gone" }, rows, "a"), undefined);
  assert.equal(resolveActive({ kind: "unavailable", raw: "", reason: "empty" }, rows, "a"), undefined);
  assert.equal(resolveActive({ kind: "none" }, rows, "c"), "c");
  assert.equal(resolveActive({ kind: "none" }, rows, "gone"), "a");
  assert.equal(resolveActive({ kind: "none" }, [], undefined), undefined);
});



test("the bookmark is one latest-scope record with a paired anchor identity and a fallback offset", () => {
  resetSnapshots();
  const anna = scopeOf({ login: "anna", role: "operator", search: "repo=deckcraft" });
  const bo = scopeOf({ login: "bo", role: "viewer", search: "repo=deckcraft" });
  assert.notEqual(anna, bo);
  const snap = captureSnapshot({ scope: anna, chosenId: "b", captureEpoch: 3, anchor: { kind: "row", id: "a", relTop: -894, fallbackOffset: 900, measuredEpoch: 3 } });
  assert.equal(snap.captureVersion, 1);
  assert.deepEqual(snapshotFor(anna)?.anchor, { kind: "row", id: "a", relTop: -894, fallbackOffset: 900, measuredEpoch: 3 });
  assert.equal(snapshotFor(bo), undefined);
  clearSnapshotFor(bo);
  assert.equal(snapshotFor(anna), undefined);
  assert.equal(peekSnapshot(), undefined);
  resetSnapshots();
});

test("restoration follows the anchor row; a lost row uses its same-read fallback offset, clamped", () => {
  const snap = captureSnapshot({ scope: "S", chosenId: "b", captureEpoch: 1, anchor: { kind: "row", id: "a", relTop: 0, fallbackOffset: 900, measuredEpoch: 1 } });
  assert.deepEqual(resolveRestore(snap, rowMap(["a", "b"]), 2149), { kind: "row", id: "a", relTop: 0 });
  assert.deepEqual(resolveRestore(snap, rowMap(["z"]), 2149), { kind: "offset", offset: 900 });
  assert.deepEqual(resolveRestore(snap, rowMap(["z"]), 400), { kind: "offset", offset: 400 });
  assert.deepEqual(resolveRestore(snap, rowMap(["z"]), 0), { kind: "offset", offset: 0 });
  const nonFinite = captureSnapshot({ scope: "S", chosenId: "b", captureEpoch: 1, anchor: { kind: "row", id: "a", relTop: -894, fallbackOffset: Number.NaN, measuredEpoch: 1 } });
  assert.deepEqual(resolveRestore(nonFinite, rowMap(["z"]), 2149), { kind: "offset", offset: 0 });
  // A genuine zero anchor restores zero; clamping is finite.
  const zero = captureSnapshot({ scope: "S", chosenId: "b", captureEpoch: 1, anchor: { kind: "offset", offset: 0, measuredEpoch: 1 } });
  assert.deepEqual(resolveRestore(zero, rowMap(["a"]), 2149), { kind: "offset", offset: 0 });
  assert.equal(clamp(180, 100), 100);
  assert.equal(clamp(Number.NaN, 100), 0);
  resetSnapshots();
});

test("capture validity is state (epoch/visibility), never the offset value", () => {
  const ok = { ready: true, currentScope: true, visible: true, laidOut: true, transition: false, captureEpoch: 2, layoutEpoch: 2 };
  assert.equal(acceptCapture(ok), true);                                  // a genuine zero is captured
  assert.equal(acceptCapture({ ...ok, captureEpoch: 1 }), false);          // a stale capture is dropped
  assert.equal(acceptCapture({ ...ok, transition: true }), false);         // transient resize
  assert.equal(acceptCapture({ ...ok, laidOut: false }), false);           // hidden/zero-height
  // A restore ignores epochs: a same-scope bookmark survives a layout epoch change.
  const snap = captureSnapshot({ scope: "S", chosenId: "b", captureEpoch: 1, anchor: { kind: "row", id: "a", relTop: -894, fallbackOffset: 900, measuredEpoch: 1 } });
  assert.deepEqual(resolveRestore(snap, rowMap(["a"]), 2149), { kind: "row", id: "a", relTop: -894 });
  resetSnapshots();
});

test("the focus clock is independent of the bookmark version", () => {
  resetSnapshots();
  const first = captureSnapshot({ scope: "S", chosenId: "b", captureEpoch: 1, anchor: { kind: "offset", offset: 0, measuredEpoch: 1 } });
  const intent = { focusIntentVersion: 1, intentScope: "S", intentUriId: "b", targetOwnerId: "needs-decisions" };
  const live = (over = {}) => ({ eventTarget: "OUTER" as unknown as Element, ownedOuterRoot: "OUTER" as unknown as Element, ownedInnerPage: "PAGE" as unknown as Element,
                                liveScope: "S", liveUriId: "b", currentFocusVersion: 1, targetInsideOwner: true, targetOwnerId: "needs-decisions", ...over });
  assert.equal(focusAllows(intent, live()), true);
  // An unrelated bookmark capture advances captureVersion but must not clock focus.
  const second = captureSnapshot({ scope: "S", chosenId: "b", captureEpoch: 1, anchor: { kind: "offset", offset: 40, measuredEpoch: 1 } });
  assert.ok(second.captureVersion > first.captureVersion);
  assert.equal(focusAllows(intent, live()), true);
  // A new intent on the same bookmark supersedes the old one.
  assert.equal(focusAllows(intent, live({ currentFocusVersion: 2 })), false);
  assert.equal(focusAllows({ ...intent, focusIntentVersion: 2 }, live({ currentFocusVersion: 2 })), true);
  resetSnapshots();
});

test("the guard accepts only the owned outer root, the live URI/scope and the current focus version", () => {
  const intent = { focusIntentVersion: 4, intentScope: "S", intentUriId: "b", targetOwnerId: "needs-decisions" };
  const live = (over = {}) => ({ eventTarget: "OUTER" as unknown as Element, ownedOuterRoot: "OUTER" as unknown as Element, ownedInnerPage: "PAGE" as unknown as Element,
                                liveScope: "S", liveUriId: "b", currentFocusVersion: 4, targetInsideOwner: true, targetOwnerId: "needs-decisions", ...over });
  assert.equal(focusAllows(intent, live()), true);
  assert.equal(focusAllows(intent, live({ eventTarget: "PAGE" as unknown as Element })), false);       // the inner page is not the trigger
  assert.equal(focusAllows(intent, live({ eventTarget: "FOREIGN" as unknown as Element })), false);    // a foreign root is not owned
  assert.equal(focusAllows(intent, live({ liveUriId: "c" })), false);                                  // a stale URI cannot retarget
  assert.equal(focusAllows(intent, live({ liveScope: "other" })), false);
  assert.equal(focusAllows(intent, live({ targetOwnerId: "other" })), false);
  assert.equal(focusAllows(intent, live({ targetInsideOwner: false })), false);
  assert.equal(focusAllows(intent, live({ currentFocusVersion: 5 })), false);
});

test("opaque ids with delimiters survive the round trip unchanged", () => {
  for (const id of ["a/b", "a+b", "x?y=z", "repo#12:kind", "café/ü"]) {
    const parsed = readDecisionParam(`?decision=${encodeURIComponent(id)}`);
    assert.equal(parsed.kind, "requested");
    assert.equal(parsed.kind === "requested" && parsed.id, id);
  }
});



test("the live projected scope changes when a filter changes but the primary id stays", () => {
  const b = liveScopeOf("?decision=b", "anna", "operator");
  const age1 = liveScopeOf("?decision=b&age=1", "anna", "operator");
  assert.notEqual(b, age1);                       // the same primary id in another cohort is another scope
  assert.equal(liveScopeOf("?decision=b&peek=b", "anna", "operator"), b);   // peek/selection are not filters
});


test("a pending focus intent cannot follow the same decision into a different project", () => {
  const a = liveScopeOf("?kind=scope&decision=a", "anna", "operator", "deckcraft");
  const b = liveScopeOf("?kind=scope&decision=a", "anna", "operator", "photocraft");
  assert.notEqual(a, b);
  assert.equal(a, scopeOf({ login: "anna", role: "operator", search: "kind=scope", project: "deckcraft" }));
  const root = {} as Element;
  const intent = { focusIntentVersion: 2, intentScope: a, intentUriId: "a", targetOwnerId: "a" };
  const live = { eventTarget: root, ownedOuterRoot: root, ownedInnerPage: null, liveScope: b, liveUriId: "a", currentFocusVersion: 2, targetInsideOwner: true, targetOwnerId: "a" };
  assert.equal(focusAllows(intent, live), false);
  assert.equal(focusAllows(intent, { ...live, liveScope: a }), true);
});
