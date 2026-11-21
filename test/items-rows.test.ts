// Items rows: the approved compact row, the open=repo#number selection and every fact the inline
// expansion may show. These pin the mapping from the real DTOs, including what it must not invent.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Classification, Item, ItemListRow, ItemStatusRow, Settled, TimelineEntry } from "../web/src/api/types.ts";
import {
  aliasToOpenHref, classificationDetail, classificationToken, decisionReceipt, detailFacts, factsFromListRow, factsFromStatusRow,
  answerFacts, answerQueueText, conflictNote, effectiveSettled, lastEvents, parseRef, parseSelection, pipelineRead, receipt, refKey,
  rowWord, scopedPayload, selectionPatch, selectionProblem, statusWord,
} from "../web/src/modules/items/rows.ts";

const settled = (over: Partial<Settled> = {}): Settled => ({ status: "settled", label: "bugfix", source: "jev", confidence: 0.62, jevLabel: "bugfix", haikuLabel: null, flags: [], referee: null, ...over });

function listRow(over: Partial<ItemListRow> = {}): ItemListRow {
  return {
    repo: "photocraft", number: 4127, kind: "pr", state: "open", title: "Add Wave", author: "pixel-wrangler",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z", comments: 2, discord: 3, settled: settled(), stage: "needs-decision", snippet: null, queue: { stage: "Review", tab: "review", place: 2 }, mergedHow: null, mergedAt: null, ...over,
  };
}
const statusRow = (over: Partial<ItemStatusRow> = {}): ItemStatusRow => ({ repo: "wordcraft", number: 2231, kind: "pr", state: "open", title: "Keep the hyperlink", author: null, status: { phase: "Fixing", waiting: "waiting for fix-up round 2", next: "review of the new head", since: "2026-01-05T00:00:00Z" }, updatedAt: "2026-01-05T01:00:00Z", ...over });

test("a selection parses open=repo#number and reports what it cannot use", () => {
  assert.deepEqual(parseRef("photocraft#4127"), { repo: "photocraft", number: 4127 });
  assert.equal(parseRef("photocraft#0"), null);
  assert.equal(parseRef("nope"), null);
  assert.equal(refKey({ repo: "a", number: 2 }), "a#2");
  const open = parseSelection("open=photocraft%234127&state=open");
  assert.deepEqual(open.open, { repo: "photocraft", number: 4127 });
  assert.equal(open.aliasPeek, undefined);
  assert.equal(parseSelection("open=nope").openRaw, "nope");
  assert.equal(parseSelection("open=nope").open, null);
});

test("a legacy peek link is the same selection under its old name", () => {
  const alias = parseSelection("peek=photocraft%234127&q=wave");
  assert.deepEqual(alias.open, null);
  assert.deepEqual(alias.aliasPeek, { repo: "photocraft", number: 4127 });
  // Both keys, same row: still just an alias.
  assert.deepEqual(parseSelection("open=photocraft%234127&peek=photocraft%234127").aliasPeek, { repo: "photocraft", number: 4127 });
  // Both keys, different rows: open wins and the ignored peek is kept for the note.
  const conflict = parseSelection("open=photocraft%234127&peek=deckcraft%23360");
  assert.deepEqual(conflict.open, { repo: "photocraft", number: 4127 });
  assert.equal(conflict.ignoredPeek, "deckcraft#360");
  assert.equal(parseSelection("peek=nope").malformedPeek, "nope");
  assert.equal(aliasToOpenHref("?peek=photocraft%234127&q=wave", { repo: "photocraft", number: 4127 }), "/items?q=wave&open=photocraft%234127");
});

test("toggling the row writes or clears only the selection keys", () => {
  assert.deepEqual(selectionPatch({ repo: "a", number: 1 }), { open: "a#1", peek: null });
  assert.deepEqual(selectionPatch(null), { open: null, peek: null });
});

test("an unusable selection is described, never turned into a row", () => {
  const keys = ["photocraft#4127"];
  assert.equal(selectionProblem(parseSelection("open=photocraft%234127"), keys), null);
  const outside = selectionProblem(parseSelection("open=deckcraft%23360"), keys);
  assert.equal(outside?.title, "That item is not in these results");
  assert.equal(outside?.href, "/items/deckcraft/360");
  assert.equal(selectionProblem(parseSelection("open=nope"), keys)?.title, "This item link is invalid");
  assert.equal(selectionProblem(parseSelection("peek=nope"), keys)?.title, "The old preview link is invalid");
  assert.equal(selectionProblem(parseSelection(""), keys), null);
});







test("last events keep the latest supplied subset and display it oldest first", () => {
  const at = (iso: string, text: string): TimelineEntry => ({ id: text, at: iso, kind: "harness", actor: "AutoCraft", icon: "job", text, tone: "neutral", costUsd: null, major: true, jobId: null, reviewId: null, githubId: null, commit: null, preapproval: null, calls: [], body: null, markdown: false, lines: [], feedback: null });
  const timeline = [at("2026-01-01T00:00:00Z", "oldest"), at("2026-01-03T00:00:00Z", "newest"), at("2026-01-02T00:00:00Z", "middle"), at("2026-01-04T00:00:00Z", "latest")];
  assert.deepEqual(lastEvents(timeline).map((entry) => entry.text), ["middle", "newest", "latest"]);
  assert.deepEqual(lastEvents(timeline, 2).map((entry) => entry.text), ["newest", "latest"]);
  assert.deepEqual(lastEvents(undefined), []);
});



const cls = (classifier: Classification["classifier"], at: string, reason: string, typeLabel: Classification["typeLabel"] = "bugfix"): Classification => ({ classifier, at, typeLabel, want: "yes", reference: null, reason, dupOf: null });
const itemWith = (classifications: Classification[], over: Partial<Item> = {}): Item => ({ classifications, ...over } as Item);











test("F4: a canonical open wins by presence, including when it is empty or malformed", () => {
  const validPeek = "peek=vectorcraft%234464";
  // Absent open: the legacy peek is the alias.
  assert.deepEqual(parseSelection(validPeek).aliasPeek, { repo: "vectorcraft", number: 4464 });
  // Present but malformed open: it stays primary, the peek is not used and no alias is scheduled.
  const malformed = parseSelection("open=not-a-ref&" + validPeek);
  assert.equal(malformed.open, null);
  assert.equal(malformed.aliasPeek, undefined);
  assert.equal(malformed.ignoredPeek, undefined);
  assert.equal(selectionProblem(malformed, ["vectorcraft#4464"])?.title, "This item link is invalid");
  // Present but empty open: same rule.
  const empty = parseSelection("open=&" + validPeek);
  assert.equal(empty.openRaw, "");
  assert.equal(empty.aliasPeek, undefined);
  assert.equal(selectionProblem(empty, [])?.title, "This item link is invalid");
  // Same row in both keys still normalises; a different valid pair keeps open and names the peek.
  assert.deepEqual(parseSelection("open=vectorcraft%234464&" + validPeek).aliasPeek, { repo: "vectorcraft", number: 4464 });
  assert.equal(parseSelection("open=vectorcraft%234464&peek=deckcraft%23360").ignoredPeek, "deckcraft#360");
});

test("F5: an out-of-cohort selection is explicit even when the cohort is empty", () => {
  const problem = selectionProblem(parseSelection("open=vectorcraft%234464"), []);
  assert.equal(problem?.title, "That item is not in these results");
  assert.equal(problem?.href, "/items/vectorcraft/4464");
  assert.equal(selectionProblem(parseSelection(""), []), null);
});

test("F7: a receipt is only usable when it is settled, un-failed and for this row", () => {
  const ref = { repo: "photocraft", number: 4127 };
  const good = { repo: "photocraft", number: 4127, title: "x" };
  assert.deepEqual(receipt(good, { loading: false }, ref), good);
  // Previous-key data kept by keepPreviousData is not a receipt while the new key loads or fails.
  assert.equal(receipt(good, { loading: true }, ref), null);
  assert.equal(receipt(good, { loading: false, error: "boom" }, ref), null);
  assert.equal(receipt({ repo: "photocraft", number: 1 }, { loading: false }, ref), null);
  assert.equal(receipt(undefined, { loading: false }, ref), null);
  // Decisions: the row's own, or a batch decision (number null) the endpoint resolved by membership.
  assert.deepEqual(decisionReceipt({ repo: "photocraft", number: 4127 }, { loading: false }, ref), { repo: "photocraft", number: 4127 });
  assert.deepEqual(decisionReceipt({ repo: "photocraft", number: null }, { loading: false }, ref), { repo: "photocraft", number: null });
  assert.equal(decisionReceipt({ repo: "other", number: 2 }, { loading: false }, ref), null);
  assert.equal(decisionReceipt({ repo: "photocraft", number: 4127 }, { loading: true }, ref), null);
  assert.equal(decisionReceipt({ repo: "photocraft", number: 4127 }, { loading: false, error: "x" }, ref), null);
  assert.equal(decisionReceipt(null, { loading: false }, ref), null);
});




test("F7: a list payload renders only for the reader it was fetched for", () => {
  const payload = { rows: [], total: 0 };
  // Same reader (including a filter change): the payload is usable, so previous rows stay visible.
  assert.deepEqual(scopedPayload({ scope: "ana:viewer", payload }, "ana:viewer"), payload);
  // A changed login or role discards the previous receipt, even for the same filter key.
  assert.equal(scopedPayload({ scope: "ana:operator", payload }, "ana:viewer"), undefined);
  assert.equal(scopedPayload({ scope: "ana:viewer", payload }, "bob:viewer"), undefined);
  assert.equal(scopedPayload(undefined, "ana:viewer"), undefined);
});

test("N2: a disputed, unapplied answer is held ahead of any exec write state", () => {
  const dispute = { by: "kiri-n", reason: "this touches the release notes", at: "2026-11-16T02:30:00Z" };
  const answered = { id: "d", answer: "merge", exec: null, appliedAt: null } as const;
  // No execution record + dispute: held, with the dispute's own reason.
  assert.deepEqual(answerFacts({ ...answered, dispute }), { state: "Answer held", tone: "warn", reason: "this touches the release notes", appliedAt: null, disputed: true });
  assert.equal(answerQueueText(answerFacts({ ...answered, dispute })!), "Held — disputed");
  // A pending write the pipeline is ignoring is still held, not pending.
  assert.deepEqual(answerFacts({ ...answered, exec: { state: "pending", reason: null }, dispute }), { state: "Answer held", tone: "warn", reason: "this touches the release notes", appliedAt: null, disputed: true });
  assert.equal(answerQueueText(answerFacts({ ...answered, exec: { state: "pending", reason: null }, dispute })!), "Held — disputed");
  // A redacted or empty dispute reason stays honest.
  assert.equal(answerFacts({ ...answered, dispute: { ...dispute, reason: "" } })?.reason, null);
  // Applied stays authoritative even with a later dispute.
  assert.equal(answerFacts({ ...answered, appliedAt: "2026-11-16T03:05:00Z", dispute })?.state, "Answer applied");
  // No answer is never turned into an answer just because dispute metadata exists.
  assert.equal(answerFacts({ ...answered, answer: null, dispute }), null);
  // A queued-card dispute is a different field and does not make the answer held.
  assert.equal(answerFacts(answered)?.state, "Answer recorded, not applied yet");
  assert.equal(answerQueueText(answerFacts(answered)!), "Answer recorded, not applied yet");
});






test("Items reader receipts reject prior project rows while the new project has no receipt", () => {
  const a = JSON.stringify(["anna", "operator", "deckcraft"]);
  const b = JSON.stringify(["anna", "operator", "photocraft"]);
  const old = { scope: a, payload: [listRow()] };
  assert.equal(scopedPayload(old, b), undefined);
  assert.equal(scopedPayload(undefined, b), undefined);
  const own = { scope: b, payload: [] };
  assert.deepEqual(scopedPayload(own, b), []); // A real empty receipt is different from loading.
});
