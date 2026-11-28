import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { runText, type ReadDeps } from "../src/workflow/read.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { actor, unstarted } from "./workflow-start-world.ts";
import type { World } from "./world-db.ts";

const item = { repo: "app", number: 1 };
const send = async (w: World, text: string, deps: ReadDeps) => {
  const parsed = parse(text, { repo: "app" });
  assert.equal(parsed.kind, "ambiguous", text);
  return (await runText(w.db, actor, "github", { parsed, items: [item] }, { text, own: [item], named: false, parse: { repo: "app" }, deps })).items[0]!;
};
const reads = (command: string, confidence: number, jev: number | null): ReadDeps => ({ choose: async () => null, translate: async () => ({ command, confidence }), score: async () => jev });

test("a message the parser cannot read runs the command a model reads in it only on a clear Jev score, and is proposed otherwise", async () => {
  const w = await unstarted();
  const text = "could you take a look at this one for me";

  const unsure = await send(w, text, reads("review", 0.95, 0.6));
  assert.equal(unsure.outcome, "ambiguous");
  assert.match(unsure.line, /`review`/);
  const noJev = await send(w, text, reads("review", 0.99, null));
  assert.equal(noJev.outcome, "ambiguous", "Haiku's own confidence only proposes");
  const hedged = await send(w, "take a look at this one later", reads("review", 0.95, 0.95));
  assert.equal(hedged.outcome, "ambiguous");
  const carved = await send(w, "yes except merge", reads("yes", 0.99, 0.99));
  assert.equal(carved.outcome, "ambiguous", "an exception is never run from a reading");
  assert.equal(await liveWorkflow(w.db, "app", 1), null);

  const clear = await send(w, text, reads("review", 0.5, 0.95));
  assert.equal(clear.outcome, "run", clear.line);
  assert.match(clear.line, /`review`/);
  assert.equal((await liveWorkflow(w.db, "app", 1))?.entry, "review");
});

test("a reading that names other items than the ones the message was written on, or only some of them, is only proposed", async () => {
  const w = await unstarted();
  await w.pr(2);
  const other = await send(w, "app#2 is the better one, could you get that in for me", reads("merge app#2", 0.99, 0.99));
  assert.equal(other.outcome, "ambiguous", other.line);
  assert.match(other.line, /`merge app#2`/);
  assert.equal(await liveWorkflow(w.db, "app", 1), null);
  assert.equal(await liveWorkflow(w.db, "app", 2), null);

  // A list of two selected items, and a reading that names one of them.
  const text = "app#1 is the better one, could you get that in for me";
  const parsed = parse(text);
  assert.equal(parsed.kind, "ambiguous");
  const both = [item, { repo: "app", number: 2 }];
  const part = await runText(w.db, actor, "dashboard", { parsed, items: both }, { text, own: both, named: false, deps: reads("merge: app#1", 0.99, 0.99) });
  assert.ok(part.items.every((o) => o.outcome === "ambiguous"), part.lines.join(" "));
  assert.equal(await liveWorkflow(w.db, "app", 1), null);
  assert.equal(await liveWorkflow(w.db, "app", 2), null);
});

test("with no reading (no Task Runner took the call), the reply is the parser's own", async () => {
  const w = await unstarted();
  const text = "could you take a look at this one for me";
  const own = (await runCommand(w.db, actor, "github", { parsed: parse(text, { repo: "app" }), items: [item] })).items[0]!;
  const none = await send(w, text, { translate: async () => null });
  assert.deepEqual({ outcome: none.outcome, line: none.line }, { outcome: own.outcome, line: own.line });
});

test("Jev's choice among the item's commands runs only when it is sure and well ahead, is proposed otherwise, and Haiku reads it when Jev gives no answer", async () => {
  const w = await unstarted();
  const text = "could you take a look at this one for me";
  const labels: string[][] = [];
  const choose = (score: number, second: number): ReadDeps["choose"] => async (_db, a) => {
    labels.push(a.candidates.map((c) => c.label));
    return { label: "review", score, second: { label: "merge", score: second } };
  };
  let translated = 0;
  const haiku: ReadDeps = { translate: async () => { translated++; return { command: "review", confidence: 0.5 }; }, score: async () => 0.95 };

  const unsure = await send(w, text, { choose: choose(0.85, 0.3), ...haiku });
  assert.equal(unsure.outcome, "ambiguous", unsure.line);
  assert.match(unsure.line, /`review`/);
  assert.match(unsure.line, /`merge`/, "the next choice is proposed too");
  const close = await send(w, text, { choose: choose(0.92, 0.8), ...haiku });
  assert.equal(close.outcome, "ambiguous", "a choice with a close second is only proposed");
  assert.equal(translated, 0, "Haiku is not asked when Jev answers");
  assert.equal(await liveWorkflow(w.db, "app", 1), null);
  assert.ok(labels[0]!.includes("review") && labels[0]!.includes("none of these"), labels[0]!.join(", "));

  const sure = await send(w, text, { choose: choose(0.95, 0.3), ...haiku });
  assert.equal(sure.outcome, "run", sure.line);
  assert.equal((await liveWorkflow(w.db, "app", 1))?.entry, "review");

  const w2 = await unstarted();
  const fallback = (await runText(w2.db, actor, "github", { parsed: parse(text, { repo: "app" }), items: [item] }, { text, own: [item], named: false, parse: { repo: "app" }, deps: { choose: async () => null, ...haiku } })).items[0]!;
  assert.equal(translated, 1, "with no answer from Jev, Haiku reads the text");
  assert.equal(fallback.outcome, "run", fallback.line);
});
