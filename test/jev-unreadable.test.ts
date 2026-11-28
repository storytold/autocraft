import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { JEV_RETRY_MS, JEV_UNREADABLE_LIMIT, jevAvailable, jevOutage } from "../src/agents/jev.ts";
import { askJev, promptVersion, setRunner } from "../src/classify/run.ts";
import { connectDb } from "../src/db/open.ts";
import { SCRATCH } from "./scratch.ts";

test("repeated unreadable Jev answers mark Jev unavailable until a readable answer arrives", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "jevunread-")), "t.db"));
  let body = "not json";
  const restore = setRunner(async () => ({ code: 0, stderr: "", stdout: body }));
  const item = { ref: "a#1" };
  const ask = async () => { await askJev("classify.jev", item, db, { body: "{}", version: promptVersion("classify.jev") }); };
  try {
    for (let i = 0; i < JEV_UNREADABLE_LIMIT - 1; i++) await ask();
    assert.equal(await jevAvailable(db), true);
    await ask();
    assert.equal(await jevAvailable(db), false);
    assert.match((await jevOutage(db))!.reason, /could not be read/);
    // After the retry delay one probe is allowed; a readable answer ends the outage.
    const later = Date.now() + JEV_RETRY_MS + 1000;
    assert.equal(await jevAvailable(db, later), true);
    body = JSON.stringify({ answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
    await ask();
    assert.equal(await jevOutage(db), null);
    assert.equal(await jevAvailable(db), true);
  } finally { restore(); }
});
