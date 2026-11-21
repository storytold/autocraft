// Items is one browser over two existing server contracts. These tests pin the URL contract, the
// endpoint each URL reaches, and one rule the round-1 review enforced: what the toolbar, bar,
// summary and chips show is exactly what the chosen endpoint receives.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aliasHref, appliedConstraints, appliedDetail, clearPhasePatch, compatExtras, constraints, filterCount,
  hiddenFilterCount, historyOptions, HISTORY_ENTRY, ignoredConstraints, ignoredPhaseScopes, isActive, itemFilter,
  itemOffset, itemPageSize, parseBrowse, previewRef, primarySelects, removeValuePatch, resetPatch, secondarySummary,
  statusFilter, unappliedCount,
} from "../web/src/modules/items/browseState.ts";

const of = (search: string) => parseBrowse(search.startsWith("?") ? search.slice(1) : search);
const REPOS = ["photocraft", "designcraft", "deckcraft"];

test("an empty URL is the approved default: open state, first page, no phase", () => {
  const browse = of("");
  assert.equal(browse.phase, undefined);
  assert.equal(browse.state, "open");
  assert.equal(browse.limit, 50);
  assert.equal(browse.offset, 0);
  assert.equal(browse.desc, true);
  assert.deepEqual(browse.repos, []);
  assert.equal(isActive(browse), false);
  assert.deepEqual(itemFilter(browse).state, "open");
  assert.equal(itemFilter(browse).q, undefined);
  assert.deepEqual(browse.unknown, []);
  assert.deepEqual(constraints(browse), []);
  assert.deepEqual(appliedDetail(browse), []);
});

test("a phase link selects the status endpoint and sends it only what it serves", () => {
  const browse = of("phase=Fixing&q=crash&kind=pr&repo=wordcraft&discord=1&status=settled&label=bugfix&flag=security&author=ana&since=2026-01-01&flow=review.take-fix&sort=created&desc=0&run=org-1&limit=25&offset=50");
  assert.equal(browse.phase, "Fixing");
  const filter = statusFilter(browse);
  assert.deepEqual(Object.keys(filter).sort(), ["discord", "kind", "phase", "q", "repo"]);
  assert.deepEqual(filter, { q: "crash", phase: "Fixing", kind: "pr", repo: ["wordcraft"], discord: true });
  // The list filter builder never carries phase; the status builder never carries the rest.
  assert.equal(itemFilter(of("phase=Fixing&status=settled")).state, "open");
  assert.equal(Object.hasOwn(statusFilter(browse), "state"), false);
  assert.equal(Object.hasOwn(statusFilter(browse), "status"), false);
  assert.equal(Object.hasOwn(statusFilter(browse), "sort"), false);
  assert.equal(Object.hasOwn(statusFilter(browse), "offset"), false);
  assert.equal(Object.hasOwn(statusFilter(browse), "limit"), false);
});

test("a classification URL keeps its filters on the list endpoint and never gains a phase", () => {
  const browse = of("state=all&status=waiting&label=bugfix&flag=security&repo=photocraft,deckcraft&q=dialog&sort=created&limit=100&offset=100");
  const filter = itemFilter(browse);
  assert.equal(filter.state, "all");
  assert.deepEqual(filter.status, ["waiting"]);
  assert.equal(filter.label, "bugfix");
  assert.deepEqual(filter.flag, ["security"]);
  assert.deepEqual(filter.repo, ["photocraft", "deckcraft"]);
  assert.equal(filter.q, "dialog");
  assert.equal(filter.sort, "created");
  assert.equal(filter.limit, 100);
  assert.equal(filter.offset, 100);
  assert.equal(Object.hasOwn(filter, "phase"), false);
});

test("a phase link that also names classification scopes says they are not applied", () => {
  const browse = of("phase=Review&status=settled&label=bugfix&flag=security&state=merged");
  assert.equal(ignoredPhaseScopes(browse), true);
  assert.equal(ignoredPhaseScopes(of("phase=Review")), false);
  const applied = appliedConstraints(browse).map((c) => `${c.key}=${c.value}`);
  assert.deepEqual(applied, ["phase=Review"]);
  const ignored = ignoredConstraints(browse);
  for (const key of ["state", "label", "status", "flag"]) assert.ok(ignored.some((c) => c.key === key), key);
  assert.equal(unappliedCount(browse), ignored.length);
  const chips = compatExtras(browse);
  for (const key of ["state", "label", "status", "flag"]) assert.equal(chips.find((c) => c.key === key)?.applied, false, key);
});

test("an explicit all-state remains visible but unapplied under a phase", () => {
  const browse = of("phase=Review&state=all&repo=photocraft&status=settled&flag=security");
  const chip = compatExtras(browse).find((entry) => entry.key === "state");
  assert.ok(chip, "explicit all-state must remain visible under a phase");
  assert.equal(chip.value, "Any state");
  assert.equal(chip.rawValue, "all");
  assert.equal(chip.applied, false);
  assert.equal(ignoredPhaseScopes(of("phase=Review&state=all")), true);
  const patch = removeValuePatch(browse, chip.key, chip.rawValue);
  assert.deepEqual(patch, { state: null });
  const next = new URLSearchParams(browse.search);
  for (const [key, value] of Object.entries(patch)) value === null ? next.delete(key) : next.set(key, value);
  assert.equal(next.has("state"), false);
  assert.equal(next.get("status"), "settled");
  assert.equal(next.get("flag"), "security");
  assert.deepEqual(statusFilter(of(next.toString())), statusFilter(browse));
});

test("values outside their contract stay in the URL and are reported as not applied", () => {
  const browse = of("state=pending&kind=epic&phase=Nope&label=chore&status=mystery&flag=urgent&sort=random&mode=advanced&ticket=ABC-9");
  assert.equal(browse.state, "open");
  assert.equal(browse.kind, undefined);
  assert.equal(browse.phase, undefined);
  assert.deepEqual(browse.labels, []);
  assert.deepEqual(browse.status, []);
  assert.deepEqual(browse.flags, []);
  const reported = compatExtras(browse);
  const keys = reported.map((extra) => extra.key);
  for (const key of ["state", "kind", "phase", "label", "status", "flag", "sort", "mode", "ticket"]) assert.ok(keys.includes(key), key);
  assert.ok(reported.every((extra) => extra.applied === false));
  assert.deepEqual(browse.unknown, [["ticket", "ABC-9"]]);
  assert.equal(reported.find((extra) => extra.key === "mode")?.value, "advanced");
  assert.equal(isActive(browse), false);
});

test("the legacy /items/filters alias keeps every key but phase and lands in the one browser", () => {
  assert.equal(aliasHref("?status=unsettled&state=all&repo=a,b&q=x&ticket=9"), "/items?status=unsettled&state=all&repo=a%2Cb&q=x&ticket=9");
  assert.equal(aliasHref("?phase=Fixing&status=settled&label=bugfix"), "/items?status=settled&label=bugfix");
  assert.equal(aliasHref("?phase=Fixing"), "/items");
  assert.equal(aliasHref(""), "/items");
});

test("clear phase returns in place to regular filtering and keeps the shared filters", () => {
  // Piece 2: ending the phase context closes the inline selection with the other filters.
  assert.deepEqual(clearPhasePatch(), { phase: null, state: null, label: null, status: null, flag: null, offset: null, open: null, peek: null });
  const patch = clearPhasePatch();
  for (const key of ["q", "kind", "repo", "discord"]) assert.equal(Object.hasOwn(patch, key), false, key);
});

test("reset clears every filter key this browser owns", () => {
  const patch = resetPatch();
  for (const key of ["q", "state", "kind", "repo", "phase", "label", "status", "flag", "author", "since", "discord", "flow", "run", "sort", "desc", "limit", "offset", "mode", "peek"]) {
    assert.equal(patch[key], null, key);
  }
});

test("page size and offset stay finite and integral before they reach the server", () => {
  assert.equal(itemPageSize(undefined), 50);
  assert.equal(itemPageSize("25"), 25);
  assert.equal(itemPageSize("0"), 50);
  assert.equal(itemPageSize("-4"), 1);
  assert.equal(itemPageSize("9999"), 100);
  assert.equal(itemPageSize("2.7"), 2);
  assert.equal(itemPageSize("abc"), 50);
  assert.equal(itemOffset(undefined), 0);
  assert.equal(itemOffset("-1"), 0);
  assert.equal(itemOffset("1.5"), 0);
  assert.equal(itemOffset("100"), 100);
  assert.equal(itemOffset("1e30"), 0);
  // The chips show the value that is really submitted, not the raw link text.
  const clamped = of("limit=9999&offset=25");
  assert.equal(itemFilter(clamped).limit, 100);
  const chip = appliedConstraints(clamped).find((c) => c.key === "limit");
  assert.equal(chip?.value, "100");
  assert.equal(appliedConstraints(clamped).find((c) => c.key === "offset")?.value, "25");
});

test("the phone Filters count and summary match the approved hierarchy", () => {
  const browse = of("status=settled&label=bugfix&repo=photocraft&q=x");
  assert.equal(hiddenFilterCount(browse, true), 3);
  assert.equal(hiddenFilterCount(browse, false), 1);
  assert.deepEqual(secondarySummary(browse), ["Classification: Settled", "Label: bugfix", "Repository: photocraft"]);
  assert.equal(hiddenFilterCount(of("phase=Fixing&repo=a"), true), 2);
  assert.equal(hiddenFilterCount(of("phase=Fixing&repo=a"), false), 2);
});

test("the filtered-view bar appears for a search, a facet or a phase, not for the default", () => {
  assert.equal(isActive(of("")), false);
  assert.equal(isActive(of("q=x")), true);
  assert.equal(isActive(of("kind=pr")), true);
  assert.equal(isActive(of("status=settled")), true);
  assert.equal(isActive(of("phase=Triage")), true);
  const browse = of("kind=pr&flag=security&repo=a,b&status=waiting");
  assert.equal(filterCount(browse), 4);
});

test("default sorts are omitted exactly where the API cannot honour them", () => {
  assert.equal(itemFilter(of("sort=relevance")).sort, undefined);
  assert.equal(itemFilter(of("q=x&sort=relevance")).sort, "relevance");
  assert.equal(itemFilter(of("sort=merged&state=open")).sort, undefined);
  assert.equal(itemFilter(of("sort=merged&state=merged-by-us")).sort, "merged");
  assert.equal(itemFilter(of("desc=0")).desc, false);
  // An inapplicable or invalid sort is a visible not-applied chip, never a false "applied".
  assert.equal(appliedConstraints(of("sort=relevance")).some((c) => c.key === "sort"), false);
  assert.equal(ignoredConstraints(of("sort=relevance")).find((c) => c.key === "sort")?.value, "Relevance");
  assert.equal(ignoredConstraints(of("sort=random")).find((c) => c.key === "sort")?.value, "random");
});

test("the preview key only accepts a repo#number ref", () => {
  assert.deepEqual(previewRef("photocraft#4127"), { repo: "photocraft", number: 4127 });
  assert.equal(previewRef("photocraft#0"), null);
  assert.equal(previewRef("photocraft"), null);
  assert.equal(previewRef(undefined), null);
  assert.equal(previewRef("a b#1"), null);
});

/* ---- round-1 review regressions: applied truth (F1, F2, F3, F5) ---- */

test("F1: constraints that live outside the toolbar are applied, visible and resettable", () => {
  for (const [search, key, value] of [["author=lina", "author", "lina"], ["since=2026-01-01", "since", "2026-01-01"], ["discord=1", "discord", "yes"], ["flow=review.take-fix", "flow", "review.take-fix"], ["run=org-1102", "run", "org-1102"]] as const) {
    const browse = of(search);
    assert.equal(isActive(browse), true, search);
    assert.equal(itemFilter(browse)[key], key === "discord" ? true : value, search);
    const applied = appliedConstraints(browse);
    assert.ok(applied.some((c) => c.key === key && c.applied), search);
    assert.ok(appliedDetail(browse).some((line) => line.startsWith(`${applied.find((c) => c.key === key)!.label}:`)), search);
    // The closed More filters line can name it even when the list has no rows.
    assert.ok(compatExtras(browse).some((c) => c.key === key && c.applied), search);
  }
  assert.equal(isActive(of("author=lina&peek=x#1")), true);
});

test("F2: flow and run are applied on the list endpoint and not applied under a phase", () => {
  const list = of("flow=review.take-fix&run=org-1102");
  assert.equal(itemFilter(list).flow, "review.take-fix");
  assert.equal(itemFilter(list).run, "org-1102");
  const applied = appliedConstraints(list).map((c) => c.key);
  assert.ok(applied.includes("flow") && applied.includes("run"));
  assert.ok(compatExtras(list).filter((c) => c.key === "flow" || c.key === "run").every((c) => c.applied));
  const phase = of("phase=Fixing&flow=review.take-fix&run=org-1102");
  const ignored = ignoredConstraints(phase).map((c) => c.key);
  assert.ok(ignored.includes("flow") && ignored.includes("run"));
  assert.equal(Object.hasOwn(statusFilter(phase), "flow"), false);
});

test("F3: a comma label list applies only its first value and marks the rest", () => {
  const browse = of("label=bugfix,performance");
  assert.equal(itemFilter(browse).label, "bugfix");
  const applied = appliedConstraints(browse).filter((c) => c.key === "label");
  assert.deepEqual(applied.map((c) => c.value), ["bugfix"]);
  const ignored = ignoredConstraints(browse).filter((c) => c.key === "label");
  assert.deepEqual(ignored.map((c) => c.value), ["performance"]);
  assert.equal(primarySelects(browse, REPOS).label.value, "bugfix");
  assert.deepEqual(secondarySummary(browse), ["Label: bugfix"]);
  assert.equal(hiddenFilterCount(browse, true), 1);
  // The raw value is preserved until the user edits or removes it.
  assert.equal(browse.labelsRaw.join(","), "bugfix,performance");
});

test("F3: mixed valid and invalid CSV status/flag entries separate applied from not applied", () => {
  const browse = of("status=settled,mystery,waiting&flag=security,urgent");
  assert.deepEqual(itemFilter(browse).status, ["settled", "waiting"]);
  assert.deepEqual(itemFilter(browse).flag, ["security"]);
  assert.deepEqual(appliedConstraints(browse).filter((c) => c.key === "status").map((c) => c.value), ["Settled", "Waiting for a second opinion"]);
  assert.deepEqual(ignoredConstraints(browse).filter((c) => c.key === "status").map((c) => c.value), ["mystery"]);
  assert.deepEqual(ignoredConstraints(browse).filter((c) => c.key === "flag").map((c) => c.value), ["urgent"]);
  // A multi-value scope is shown as its applied values, never as "Any".
  assert.equal(primarySelects(browse, REPOS).classification.value, "settled,waiting");
  assert.equal(primarySelects(browse, REPOS).classification.options[0][1], "Settled + Waiting for a second opinion");
  assert.deepEqual(secondarySummary(browse), ["Classification: Settled + Waiting for a second opinion", "Flag: Security"]);
});

test("F3: multiple repositories stay applied and are shown as their values", () => {
  const browse = of("repo=photocraft,deckcraft");
  assert.deepEqual(itemFilter(browse).repo, ["photocraft", "deckcraft"]);
  assert.equal(primarySelects(browse, REPOS).repository.value, "photocraft,deckcraft");
  assert.equal(primarySelects(browse, REPOS).repository.options[0][1], "photocraft + deckcraft");
  assert.deepEqual(secondarySummary(browse), ["Repository: photocraft + deckcraft"]);
  assert.equal(hiddenFilterCount(browse, false), 1);
});

test("F5: under a phase the disabled scopes read their defaults, and the link's values are chips", () => {
  const browse = of("phase=Waiting for a person&status=settled&label=bugfix&flag=security&state=merged");
  const selects = primarySelects(browse, REPOS);
  assert.equal(selects.state.value, "phase");
  assert.equal(selects.classification.value, "");
  assert.equal(selects.label.value, "");
  assert.equal(selects.flag.value, "");
  assert.equal(selects.repository.value, "");
  const chips = compatExtras(browse);
  for (const key of ["state", "label", "status", "flag"]) {
    assert.ok(chips.some((c) => c.key === key && !c.applied), key);
  }
  // No applied chip for a primary value the disabled control cannot show.
  assert.deepEqual(chips.filter((c) => c.applied).map((c) => c.key), ["discord"].filter(() => false));
  assert.equal(isActive(browse), true);
  assert.equal(appliedDetail(browse).length, 0);
});

test("removing one chip drops only its own CSV value", () => {
  const browse = of("label=bugfix,performance,infra&status=settled,waiting&flag=security&repo=a,b&author=ana");
  assert.deepEqual(removeValuePatch(browse, "label", "performance"), { label: "bugfix,infra" });
  assert.deepEqual(removeValuePatch(browse, "status", "waiting"), { status: "settled" });
  assert.deepEqual(removeValuePatch(browse, "flag", "security"), { flag: null });
  assert.deepEqual(removeValuePatch(browse, "repo", "a"), { repo: "b" });
  assert.deepEqual(removeValuePatch(browse, "author", "ana"), { author: null });
});

test("phase compatibility chips remove raw status and flag values without changing their display labels", () => {
  const browse = of("phase=Review&status=settled,waiting,mystery&flag=security,needs%20decision,urgent&repo=photocraft");
  const chips = compatExtras(browse);
  const cases = [
    ["status", "settled", "Settled", "waiting,mystery"],
    ["status", "waiting", "Waiting for a second opinion", "settled,mystery"],
    ["flag", "security", "Security", "needs decision,urgent"],
    ["flag", "needs decision", "Needs a decision", "security,urgent"],
  ] as const;
  for (const [key, raw, display, remaining] of cases) {
    const chip = chips.find((entry) => entry.key === key && entry.rawValue === raw);
    assert.ok(chip, raw);
    assert.equal(chip.value, display);
    assert.equal(chip.applied, false);
    const patch = removeValuePatch(browse, chip.key, chip.rawValue);
    assert.deepEqual(patch, { [key]: remaining });
    const next = new URLSearchParams(browse.search);
    for (const [name, value] of Object.entries(patch)) value === null ? next.delete(name) : next.set(name, value);
    // Removing an ignored chip does not retarget the phase request or erase other raw values.
    assert.deepEqual(statusFilter(of(next.toString())), statusFilter(browse));
    assert.equal(next.get(key === "status" ? "flag" : "status"), new URLSearchParams(browse.search).get(key === "status" ? "flag" : "status"));
  }
});

test("the primary selects always name the applied value, never 'Any' for an applied scope", () => {
  assert.equal(primarySelects(of(""), REPOS).classification.value, "");
  assert.equal(primarySelects(of("status=unsettled"), REPOS).classification.value, "unsettled");
  assert.equal(primarySelects(of("status=unsettled"), REPOS).classification.options[0][1], "Waiting or disagreeing");
  assert.equal(primarySelects(of("repo=deckcraft"), REPOS).repository.value, "deckcraft");
  assert.equal(primarySelects(of(""), REPOS).repository.value, "");
  assert.equal(primarySelects(of("label=chore,infra"), REPOS).label.value, "infra");
  assert.deepEqual(ignoredConstraints(of("label=chore,infra")).filter((c) => c.key === "label").map((c) => c.value), ["chore"]);
});

test("F7: discrete Items actions push one history entry; typing and the alias replace", () => {
  // The approved reference pushes a select's URL (`go()`, app.js:2294-2300), a row toggle (:2233) and
  // Reset (:2242), and replaces the URL while the search input is typed (:2316). The alias redirect
  // replaces (:501). Nothing else may add an entry.
  assert.deepEqual(HISTORY_ENTRY, {
    filter: "push",
    phase: "push",
    "clear-phase": "push",
    reset: "push",
    remove: "push",
    paging: "push",
    preview: "push",
    open: "push",
    search: "replace",
    author: "replace",
    alias: "replace",
  });
  for (const action of ["filter", "phase", "clear-phase", "reset", "remove", "paging", "preview", "open"] as const) {
    assert.deepEqual(historyOptions(action), { replace: false }, action);
  }
  for (const action of ["search", "author", "alias"] as const) {
    assert.deepEqual(historyOptions(action), { replace: true }, action);
  }
  // A reset push also drops the selection, so Back restores a filtered list *with* its preview state.
  assert.equal(resetPatch().peek, null);
});
