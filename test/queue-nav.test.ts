// An item opened from Needs you steps through the queue that was loaded there, and going back selects where it stopped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromState, queuePosition, readFrom, stepFrom } from "../web/src/lib/links.ts";

const row = (id: string, number: number | null) => ({ id, repo: "deckcraft", number, items: number === null ? [] : undefined });
const rows = [row("a", 1), row("batch", null), row("b", 2), row("c", 3)];

test("opening sets the selected decision and keeps only decisions with an item", () => {
  const { from } = fromState("/needs?kind=merge&peek=a", rows[0], rows);
  assert.equal(from.url, "/needs?kind=merge&decision=a");
  assert.deepEqual(from.queue?.map((e) => e.id), ["a", "b", "c"]);
  assert.equal(from.queue?.[1]?.path, "/items/deckcraft/2#decision-b");
  assert.deepEqual(queuePosition(from), { at: 1, of: 3 });
});

test("stepping moves the selection, keeps the other params and stops at the ends", () => {
  const { from } = fromState("/needs?kind=merge", rows[2], rows);
  assert.deepEqual(queuePosition(from), { at: 2, of: 3 });
  const next = stepFrom(from, 1)!;
  assert.equal(next.path, "/items/deckcraft/3#decision-c");
  assert.equal(next.state.from.url, "/needs?kind=merge&decision=c");
  assert.equal(stepFrom(next.state.from, 1), null);
  assert.equal(stepFrom(stepFrom(from, -1)!.state.from, -1), null);
});

test("a decision outside the queue, or no queue, shows no position", () => {
  assert.equal(queuePosition(fromState("/needs?decision=zzz", undefined, rows).from), null);
  assert.equal(queuePosition(fromState("/needs", rows[0]).from), null);
});

test("history state keeps the queue only when every entry is an item path", () => {
  const good = fromState("/needs", rows[0], rows);
  assert.deepEqual(readFrom(good), good.from);
  const bad = { from: { url: "/needs", queue: [{ id: "a", path: "https://evil.example" }] } };
  assert.deepEqual(readFrom(bad), { url: "/needs" });
  assert.deepEqual(readFrom({ from: { url: "/needs", queue: "x" } }), { url: "/needs" });
});
