// A stop on a failure of AutoCraft's own (a workspace that did not start, a lost session) is AutoCraft's to retry, not a person's
// decision: the attempt waits on a backoff and goes on, it does not count toward the repo's Implement breaker, and only the stop
// after the retries asks a maintainer. A stop on the item's own cause asks at once and counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import type { ItemFacts } from "../src/core/plan.ts";
import { loadTrip } from "../src/data/control/trips.ts";
import { startFailed } from "../src/implement/plan.ts";
import { IMPLEMENT_RETRIES, IMPLEMENT_START_RETRIES } from "../src/implement/start-retry.ts";
import { markStuck, STUCK_IN_A_ROW } from "../src/implement/stuck.ts";
import type { PlanReply } from "../src/implement/types.ts";
import { currentImplementation, roundsOf, setImplementationState, startImplementation } from "./implement-rows.ts";
import { OPERATOR, world } from "./world-db.ts";

const ENV_ERROR = "2 kubernetes environments are enabled; implementations need exactly one";
const LATER = 24 * 3600_000;

test("AutoCraft's own stops retry on a backoff without asking or counting toward the breaker; the item's own stops ask and count", async () => {
  let w = await (await world()).repo();
  for (const n of [7, 9, 11, 13, 15]) w = await w.issue(n);
  const db = w.db;
  // Facts as a queued issue in scope sees them, at `ms`.
  const step = async (n: number, ms?: number) => {
    const f = (await loadItemFact(db, "app", n))!;
    const queued: ItemFacts = { ...f, inScope: true, now: ms ?? f.now, implement: { ...f.implement, queuedBy: OPERATOR, standing: "yes", featureOn: true } };
    return implementStep(queued);
  };
  const waitWho = (s: Awaited<ReturnType<typeof step>>) => (s && "wait" in s ? s.wait.who : null);
  const asked = async (id: number) => (await roundsOf(db, id)).some((r) => r.kind === "question");
  const tripped = async () => (await loadTrip(db, "implement:app"))?.active === true;

  // A workspace that did not start: fast start retries, then the slower retries of a stop of our own.
  const started = await startImplementation(db, { repo: "app", number: 7, queuedBy: OPERATOR, textHash: "h" });
  await startFailed(db, started, ENV_ERROR);
  assert.equal((await currentImplementation(db, "app", 7))?.state, "planning");
  assert.equal(waitWho(await step(7)), "system", "the start retry waits on its backoff");
  assert.deepEqual(await step(7, Date.now() + LATER), { bucket: "plan" }, "after the backoff the plan runs again");
  for (let i = 0; i < IMPLEMENT_START_RETRIES; i++) await startFailed(db, started, ENV_ERROR);
  assert.equal((await currentImplementation(db, "app", 7))?.state, "planning", "the failure after the start retries is retried too");
  assert.ok(!await asked(started.id), "nothing is asked");
  assert.equal(waitWho(await step(7)), "system");

  // A session the Task Runner kept losing: the attempt starts the session over after the backoff, without asking.
  const lost = await startImplementation(db, { repo: "app", number: 9, queuedBy: OPERATOR, textHash: "h" });
  const plan = { summary: "Return None for an empty slice" } as unknown as PlanReply;
  const stopAt = async (cause: "session-lost" | "no-report") => {
    await setImplementationState(db, lost.id, "implementing", { planCallId: 41, plan, workspaceId: null });
    return await markStuck(db, (await currentImplementation(db, "app", 9))!, cause, "the session started over 2 times");
  };
  for (let i = 1; i <= IMPLEMENT_RETRIES; i++) {
    const end = await stopAt("session-lost");
    assert.equal(end.retry?.n, i);
    assert.equal((await currentImplementation(db, "app", 9))?.state, "planned", "the session starts over from the plan");
    assert.ok(!await asked(lost.id), "nothing is asked");
    assert.equal(waitWho(await step(9)), "system", "the retry waits on its backoff");
    assert.deepEqual(await step(9, Date.now() + LATER), { bucket: "build" }, "after the backoff the build runs again");
  }
  assert.ok((await stopAt("no-report")).retry, "a failure that is not the Task Runner's has retries of its own");
  assert.equal((await stopAt("session-lost")).retry, null, "the stop after the retries is not retried");
  assert.equal((await currentImplementation(db, "app", 9))?.state, "stuck");
  assert.equal(waitWho(await step(9, Date.now() + LATER)), "person", "it asks a maintainer");

  // Failing checks are the item's own stop: asked at once. Our own stop neither counts toward the breaker nor breaks the row.
  for (const n of [11, 13, 15]) {
    assert.ok(!await tripped(), "no breaker before the item's own stops are in a row");
    const impl = await startImplementation(db, { repo: "app", number: n, queuedBy: OPERATOR, textHash: "h" });
    await setImplementationState(db, impl.id, "checking", { planCallId: 41, plan });
    const end = await markStuck(db, (await currentImplementation(db, "app", n))!, "checks-failing", "2 findings");
    assert.equal(end.retry, null);
    assert.equal(waitWho(await step(n)), "person", "failing checks ask a maintainer");
  }
  assert.ok(await tripped(), `${STUCK_IN_A_ROW} stops on the item's own cause in a row trip the breaker`);
});
