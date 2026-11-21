// Needs controls: the View select and the inline scope panel. These pin the URL semantics the server
// actually reads (repo/kind CSV, age days, all=1) and the truthful display of what a single select
// cannot show.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGE_VALUES, ALL_SCOPE_VIEWS, ageOptions, clearScopePatch, compatValues, hasRawScope, multiLabel, multiSelectValue,
  needsTabsHref, parseScope, removeRawAgePatch, removeRawScopePatch, scopeCount, viewOf,
} from "../web/src/modules/decisions/needs-controls.ts";

const KINDS = ["scope", "duplicate", "close", "merge", "hold", "split", "other"];



test("an unknown repository is a real filter that matches nothing, not an ignored value", () => {
  const scope = parseScope("?repo=no-such-repo", KINDS);
  assert.deepEqual(scope.repo, ["no-such-repo"]);
  assert.equal(scopeCount(scope, "open"), 1);
  assert.deepEqual(compatValues(scope), []);
});

test("the scope parses exactly the keys the server reads", () => {
  const scope = parseScope("?repo=deckcraft&kind=scope,merge&age=3&all=1", KINDS);
  assert.deepEqual(scope.repo, ["deckcraft"]);
  assert.deepEqual(scope.kind, ["scope", "merge"]);
  assert.equal(scope.minAge, 3);
  assert.equal(scope.all, true);
  assert.deepEqual(scope.unusedKinds, []);
  assert.equal(scope.unusedAge, undefined);
  assert.deepEqual(parseScope("", KINDS), { repo: [], kind: [], minAge: undefined, all: false, unusedKinds: [], unusedAge: undefined, cappedAge: undefined, raw: { repo: [], kind: [], age: undefined } });
});

test("values the API will not use are kept apart, never applied", () => {
  const scope = parseScope("?kind=scope,bogus&age=zero", KINDS);
  assert.deepEqual(scope.kind, ["scope"]);
  assert.deepEqual(scope.unusedKinds, ["bogus"]);
  assert.equal(scope.minAge, undefined);
  assert.equal(scope.unusedAge, "zero");
  const chips = compatValues(scope);
  assert.ok(chips.some((c) => c.value === "bogus" && /not applied/.test(c.label)));
  assert.ok(chips.some((c) => c.value === "zero" && /not applied/.test(c.label)));
  // The server caps ages above 36500 days and ignores non-positive ones; reflect what is applied.
  const capped = parseScope("?age=99999", KINDS);
  assert.equal(capped.minAge, 36500);
  assert.equal(capped.cappedAge, "99999");
  assert.ok(compatValues(capped).some((c) => /36500 days \(99999 in the link, capped\)/.test(c.label)));
  assert.equal(parseScope("?age=0", KINDS).minAge, undefined);
  assert.equal(parseScope("?age=0", KINDS).unusedAge, "0");
});



test("Clear scope drops the four scope keys, the preview and nothing else", () => {
  assert.deepEqual(clearScopePatch(), { repo: null, kind: null, age: null, all: null, peek: null });
  const patch = clearScopePatch();
  for (const key of ["tab", "ticket"]) assert.equal(Object.hasOwn(patch, key), false, key);
});





test("queue-tab links carry the compatible scope, drop the preview and set the tab", () => {
  assert.equal(needsTabsHref("feedback", "?tab=decisions&repo=a&peek=x"), "/needs?tab=feedback&repo=a");
  assert.equal(needsTabsHref("decisions", "?tab=stopped&repo=a"), "/needs?repo=a");
  assert.equal(needsTabsHref("decisions", ""), "/needs");
});

test("B1: the effective age is the server's own arithmetic, shared by the request and the controls", () => {
  // Positive fractions are real filters (server: minAge = min(Number(age), 36500); applied when > 0).
  const fraction = parseScope("?age=1.5", KINDS);
  assert.equal(fraction.minAge, 1.5);
  assert.equal(fraction.unusedAge, undefined);
  assert.equal(scopeCount(fraction, "open"), 1);
  // Infinity and values above the cap become 36500, with the raw value named.
  for (const raw of ["Infinity", "99999"]) {
    const capped = parseScope(`?age=${raw}`, KINDS);
    assert.equal(capped.minAge, 36500);
    assert.equal(capped.cappedAge, raw);
    assert.equal(scopeCount(capped, "open"), 1);
  }
  // Non-numeric, zero and negative ages are ignored by the server and reported as not applied.
  for (const raw of ["not-an-age", "0", "-3", ""]) {
    const ignored = parseScope(`?age=${raw}`, KINDS);
    assert.equal(ignored.minAge, undefined);
    assert.equal(scopeCount(ignored, "open"), 0);
    assert.equal(ignored.unusedAge, raw);
  }
  // A legacy 2-day link is applied as 2.
  assert.equal(parseScope("?age=2", KINDS).minAge, 2);
});

test("B1: only whitelisted kinds are sent; unknown kinds stay in the raw link", () => {
  const scope = parseScope("?kind=merge,badA", KINDS);
  assert.deepEqual(scope.kind, ["merge"]);
  assert.deepEqual(scope.unusedKinds, ["badA"]);
  assert.deepEqual(scope.raw.kind, ["merge", "badA"]);
});

test("B2: every raw scope value has a direct cleanup that keeps the others", () => {
  const search = "?kind=merge,badA,badB&age=not-an-age&repo=a,b&ticket=T&peek=x";
  assert.equal(hasRawScope(parseScope(search, KINDS)), true);
  // Removing one unknown kind keeps the valid one and the other unknown, and every unknown key.
  assert.deepEqual(removeRawScopePatch(search, "kind", "badA"), { kind: "merge,badB", peek: null });
  assert.deepEqual(removeRawScopePatch(search, "kind", "merge"), { kind: "badA,badB", peek: null });
  // Removing the last value clears only that key.
  assert.deepEqual(removeRawScopePatch("?kind=badA", "kind", "badA"), { kind: null, peek: null });
  // A raw age is removable whatever it is, including when it is unusable or capped.
  assert.deepEqual(removeRawAgePatch(), { age: null, peek: null });
  // An invalid-only link still has a cleanup path, with a zero applied badge.
  const invalidOnly = parseScope("?kind=not-a-kind&age=not-an-age", KINDS);
  assert.equal(scopeCount(invalidOnly, "open"), 0);
  assert.equal(hasRawScope(invalidOnly), true);
});
