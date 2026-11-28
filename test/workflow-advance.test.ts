// The advance pass of the maintainer workflow (src/workflow/advance.ts) with the merge leg (src/preapproval): blockers stop an
// approved item and keep its approval, a yes resumes it, and an approved review entry with minor findings is fixed, then merged,
// also past changes outside the PR's purpose.
// An implement issue's plan question comes back as its recommendation, and answers on the issue reach its implementation PR.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeChecks } from "../src/health-checks.ts";
import { Runner } from "../src/runner/runner.ts";
import { SCRATCH } from "./scratch.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { parseOpusReply } from "../src/review/opus-parse.ts";
import { advanceWorkflows, type FailedCheck } from "../src/workflow/advance.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { eventsOf, liveWorkflow, workflowHistory } from "../src/workflow/store.ts";
import { legWait } from "../src/workflow/waits.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { SNAPSHOT_CACHE_MS } from "../src/data/runners/snapshot-cache.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import type { Blocker } from "../src/workflow/types.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { T0, T1, untilQuiet, world, type World } from "./world-db.ts";
import { currentAttempt, writeStep } from "../src/implement/attempt.ts";
import { openQuestion } from "../src/implement/questions.ts";
import { recordSteps, startAttempt } from "../src/data/implement/index.ts";
import { recordEvents, saveWorkflows } from "../src/data/workflow/index.ts";
import { applyStuckAnswer, markStuck } from "../src/implement/stuck.ts";
import { resumeRetiredStops } from "../src/workflow/retired-stops.ts";
import { actor, approvedReview, asked, ASKS, fixup, implementationOpened, implementIssue, keep, labelOf, later, leg8, legState, MAINT, nextStep, ownPush, pause, review, review8, say, ticks } from "./workflow-advance-world.ts";
import { decidePr } from "../src/core/decide.ts";
import { loadPrFact } from "../src/core/facts.ts";

test("each blocker stops an approved item and keeps its approval", async () => {
  const cases: [Blocker, (w: World) => Promise<unknown>][] = [
    ["author-commits", async (w) => { await w.synced(1, "sha9"); await w.outOfScope(1, "sha9"); }],
    ["failed-twice", async (w) => { await fixup(w, { state: "failed" }); await fixup(w, { state: "refused" }); }],
  ];
  for (const [blocker, evidence] of cases) {
    const w = await approvedReview();
    await evidence(w);
    await advanceWorkflows(w.db);
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.blocker, wf.approvedBy], ["blocked", blocker, MAINT], blocker);
    assert.ok(wf.rec?.text, `${blocker}: one recommendation`);
    assert.notEqual(await legState(w), "review", `${blocker}: the merge leg stops`);
    w.close();
  }
});

test("jobs of an approved PR's own lane that fail before they record a try stop nothing, and a stop an earlier release made for them closes by itself", async () => {
  const w = await approvedReview();
  const db = w.db;
  for (const id of [901, 902]) await db.run(db.k.insertInto("main.jobs").values({ id, step: "opus-review", params: JSON.stringify({ repo: "app", number: 1, lane: "approved", limit: 10 }), requested_by: "pipeline", requested_at: later(), state: "failed", started_at: later(), ended_at: later(), error: "reply could not be read", repo: "app" }));
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([wf.state, wf.blocker], ["running", null]);
  assert.equal(await legState(w), "review", "the merge leg goes on");
  await db.run(db.k.updateTable("main.item_workflows").where("number", "=", 1).set({
    state: "blocked", blocker: "failed-twice", blocker_params: JSON.stringify({ step: "review", count: 2 }), rec_at: later(), rec_head: "sha1",
    rec: JSON.stringify({ text: "The review failed twice. Review it again, then merge.", parts: { fix: [], drop: [] }, merges: true, again: "review" }),
  }));
  await advanceWorkflows(db);
  const resumed = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([resumed.state, resumed.blocker, resumed.rec, resumed.approvedBy], ["running", null, null, MAINT]);
  assert.match(String((await eventsOf(db, "app", 1)).at(-1)?.line), /closed without an answer/);
});

test("an approved PR that failed alone in a merge batch stays at its question until a yes: stopping its merge leg does not close it, and nothing goes back to the merge queue", async () => {
  const w = await (await (await world()).repo(["merge", "push"])).acting("mira", "ann");
  const db = w.db, by = { login: "mira", canWrite: async () => true };
  await w.pr(1, { label: "feature" });
  await (await w.verified(1)).premerge(1, "clean");
  await pause();
  await runCommand(db, by, "github", { parsed: parse("review and merge"), items: [{ repo: "app", number: 1 }] });
  await w.review(1, { verdict: "close" });
  await db.run(db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }));
  await untilQuiet(db, [() => advanceWorkflows(db), () => advancePreapprovals(db)], 5);
  await pause();
  await runCommand(db, by, "github", { parsed: parse("merge"), items: [{ repo: "app", number: 1 }] });
  for (let i = 0; i < 4; i++) { await advanceWorkflows(db); await advancePreapprovals(db); await pause(); }
  assert.equal(await legState(w), "queued");
  const at = new Date().toISOString();
  const batch = Number((await db.get(db.k.insertInto("main.merge_batches").values({ repo: "app", branch: "b", base_sha: "b", commit_sha: "c", state: "failed", summary: "a test fails", created_at: at, updated_at: at }).returning("id")))!.id);
  await db.run(db.k.insertInto("main.merge_batch_prs").values({ batch_id: batch, number: 1, head_oid: "sha1", position: 0 }));
  const legs = async () => (await w.rows("SELECT id FROM preapprovals WHERE number = 1")).length;
  await advanceWorkflows(db);
  const before = await legs();
  for (let i = 0; i < 6; i++) {
    await advancePreapprovals(db);
    await pause();
    await advanceWorkflows(db);
    const wf = (await liveWorkflow(db, "app", 1))!;
    assert.deepEqual([wf.state, wf.blockerParams?.code], ["blocked", "batch-failed"], `pass ${i}`);
  }
  assert.equal(await legs(), before, "no new merge leg without a yes");
  assert.ok(!(await eventsOf(db, "app", 1)).some((e) => /closed without an answer/.test(String(e.line))));
  await runCommand(db, by, "github", { parsed: parse("yes"), items: [{ repo: "app", number: 1 }] });
  await ticks(w);
  assert.equal((await liveWorkflow(db, "app", 1))!.state, "running");
  assert.ok(await legs() > before, "a yes starts a new merge leg");
  w.close();
});

test("four jobs of an approved PR's own lane that fail in a row at its head ask once, and close once one runs through; four that an outage failed ask nothing", async () => {
  for (const error of ["stopped: ran past its deadline of 30 min", "connect ECONNRESET 10.0.0.1:443"]) {
    const w = await approvedReview();
    const db = w.db;
    const job = (id: number, state: string, err: string | null) => db.run(db.k.insertInto("main.jobs").values({ id, step: "opus-review", params: JSON.stringify({ repo: "app", number: 1, lane: "approved", limit: 10, head: "sha1" }), requested_by: "pipeline", requested_at: later(), state, started_at: later(), ended_at: later(), error: err, repo: "app" }));
    // A job queued before jobs named their head never counts.
    await db.run(db.k.insertInto("main.jobs").values({ id: 900, step: "opus-review", params: JSON.stringify({ repo: "app", number: 1, lane: "approved", limit: 10 }), requested_by: "pipeline", requested_at: later(), state: "failed", started_at: later(), ended_at: later(), error, repo: "app" }));
    for (const id of [901, 902, 903]) await job(id, "failed", error);
    await advanceWorkflows(db);
    assert.equal((await liveWorkflow(db, "app", 1))!.state, "running", `${error}: three count`);
    await job(904, "failed", error);
    await advanceWorkflows(db);
    await advanceWorkflows(db);
    const wf = (await liveWorkflow(db, "app", 1))!;
    const blocked = (await eventsOf(db, "app", 1)).filter((e) => e.kind === "blocked").length;
    if (error.includes("ECONNRESET")) {
      assert.equal(wf.state, "running", "an outage is no failure of the item");
      assert.equal(blocked, 0);
    } else {
      assert.deepEqual([wf.state, wf.blocker, wf.rec?.cause?.code], ["blocked", "failed-twice", "lane-failed"]);
      assert.equal(blocked, 1, "asked once");
      await pause();
      await job(905, "done", null);
      await advanceWorkflows(db);
      assert.deepEqual([(await liveWorkflow(db, "app", 1))!.state, (await liveWorkflow(db, "app", 1))!.approvedBy], ["running", MAINT]);
    }
    w.close();
  }
});

test("a merge leg a fix-up try ended stops the approved PR while that try stands; once it is superseded the question closes by itself and a new leg starts", async () => {
  const w = await approvedReview();
  const db = w.db;
  const [legRow] = await w.rows("SELECT id FROM preapprovals WHERE number = 1");
  await db.run(db.k.insertInto("main.operator_fixups").values({ repo: "app", number: 1, from_head: "sha1", instructions: "Keep the box centred.", by: MAINT, at: new Date().toISOString(), state: "queued", preapproval_id: Number(legRow!.id) }));
  const [req] = await w.rows("SELECT id FROM operator_fixups WHERE number = 1");
  await db.run(db.k.updateTable("main.preapprovals").set({ state: "fixup", fix_id: Number(req!.id), from_head: "sha1" }).where("id", "=", Number(legRow!.id)));
  await db.run(db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: null, state: "too-large", reason: "the PR diff is over the 60000 character limit", files: "[]", attempt: 1, created_at: new Date().toISOString(), source: "operator", operator_fix: Number(req!.id) }));
  await untilQuiet(db, [() => advancePreapprovals(db)], 3);
  await advanceWorkflows(db);
  const asked = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([asked.state, asked.blocker], ["blocked", "failed-twice"]);
  await advanceWorkflows(db);
  assert.equal((await liveWorkflow(db, "app", 1))!.state, "blocked", "the try still stands");

  await db.run(db.k.updateTable("main.fixups").set({ state: "superseded" }).where("number", "=", 1));
  await advanceWorkflows(db);
  const resumed = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([resumed.state, resumed.rec, resumed.approvedBy], ["running", null, MAINT]);
  assert.notEqual(await legState(w), "failed", "a new merge leg");
});

test("an approved workflow an earlier release stopped at a stop that no longer stops an approved merge resumes with its approval; one stopped for another reason waits", async () => {
  const w = await approvedReview();
  await w.pr(2, { label: "feature" });
  assert.equal((await runCommand(w.db, actor, "dashboard", { parsed: parse("review and merge"), items: [{ repo: "app", number: 2 }] })).items[0]!.outcome, "run");
  await w.pr(3, { label: "feature" });
  assert.equal((await runCommand(w.db, actor, "dashboard", { parsed: parse("review and merge"), items: [{ repo: "app", number: 3 }] })).items[0]!.outcome, "run");
  const stop = (n: number, blocker: string, params: object = {}) => w.db.run(w.db.k.updateTable("main.item_workflows").where("number", "=", n)
    .set({ state: "blocked", blocker, blocker_params: JSON.stringify(params), rec: JSON.stringify({ text: "Fix 1, then merge.", parts: { fix: [1], drop: [] }, merges: true }), rec_at: later(), rec_head: "sha1" }));
  await stop(1, "major-finding");
  await stop(2, "failed-twice", { step: "fix-up" });
  await stop(3, "other", { code: "answer", reason: "a maintainer's answer" });
  assert.deepEqual(await resumeRetiredStops(w.db), ["app#1", "app#3"]);
  const [one, two, three] = [(await liveWorkflow(w.db, "app", 1))!, (await liveWorkflow(w.db, "app", 2))!, (await liveWorkflow(w.db, "app", 3))!];
  assert.deepEqual([one.state, one.blocker, one.rec, one.approvedBy], ["running", null, null, MAINT]);
  assert.deepEqual([three.state, three.rec], ["running", null]);
  assert.deepEqual([two.state, two.blocker], ["blocked", "failed-twice"]);
  w.close();
});

test("however much our own pushes change, they never stop an approved item", async () => {
  for (const extra of ["cifix", "merge"] as const) {
    const w = await approvedReview();
    const made = (action: string, from_oid: string, to_oid: string, lines: number, at: string, landed_at: string | null = at) =>
      w.db.run(w.db.k.insertInto("main.own_pushes").values({ repo: "app", number: 1, action, from_oid, to_oid, lines, at, landed_at }));
    const push = async (action: string, from: string, to: string, lines: number) => {
      await made(action, from, to, lines, later());
      await w.synced(1, to);
      await advanceWorkflows(w.db);
    };
    // Before the approval: what the person saw.
    await made("fixup-push", "sha0", "sha1", 900, "2020-01-01T00:00:00Z");
    // Recorded, and never landed.
    await made("fixup-push", "sha1", "lost", 900, later(), null);
    await push("fixup-push", "sha1", "sha1b", 250);
    assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
    await (extra === "cifix" ? push("cifix-push", "sha1b", "sha1c", 250) : push("conflict-push", "sha1b", "sha1c", 0));
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.blocker], ["running", null], extra);
    w.close();
  }
});

test("an approved PR whose review has a major finding, or says hold, gets a fix-up as the approver and merges without a question", async () => {
  for (const kind of ["major", "hold"] as const) {
    const w = await approvedReview();
    const db = w.db;
    const pass = async () => { await advanceWorkflows(db); await untilQuiet(db, [() => advancePreapprovals(db)], 3); await advanceWorkflows(db); };
    const asks = async () => { const wf = (await liveWorkflow(db, "app", 1))!; return [wf.state, wf.rec, wf.approvedBy]; };
    if (kind === "major") await review(w, { head: "sha1", verdict: "take-fix", at: new Date().toISOString(), fixes: [{ file: "src/lib.rs", change: "check the bound before the read", title: "out-of-bounds read", major: true }] });
    else await review(w, { head: "sha1", verdict: "hold", at: new Date().toISOString() });
    await pass();
    assert.deepEqual(await asks(), ["running", null, MAINT], `${kind}: no question`);
    if (kind === "hold") {
      const asked = await w.rows("SELECT by, from_head FROM operator_fixups WHERE number = 1");
      assert.deepEqual(asked.map((r) => [r.by, r.from_head]), [[MAINT, "sha1"]], "the fix-up is asked for as the approver");
      assert.equal(await legState(w), "fixup", "a new merge leg waits for its push");
      w.close();
      continue;
    }
    assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.params?.source === "review"), "the review's fix-up runs");
    await fixup(w, { state: "pushed", files: ["src/lib.rs"], patch: "+b\n-a", to: "sha2" });
    await db.run(db.k.insertInto("main.push_outcomes").values({ at: later(), stage: "fixup", action: "fixup-push", repo: "app", number: 1, from_oid: "sha1", to_oid: "sha2", before_res: "green" }));
    await w.synced(1, "sha2");
    await pass();
    await review(w, { head: "sha2", verdict: "take", at: new Date().toISOString() });
    await (await w.premerge(1, "clean")).verified(1);
    await pass();
    assert.deepEqual(await asks(), ["running", null, MAINT]);
    assert.equal(await legState(w), "queued");
    assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "merge"), "the merge queue merges it");
    w.close();
  }
});

test("an approved PR whose blocking fix the fix-up refused for its size asks to make it again, never to drop it, and makes it by itself once that refusal is superseded", async () => {
  const w = await approvedReview();
  const db = w.db;
  const pass = async () => { await advanceWorkflows(db); await untilQuiet(db, [() => advancePreapprovals(db)], 3); await advanceWorkflows(db); };
  await review(w, { head: "sha1", verdict: "take-fix", at: new Date().toISOString(), fixes: [
    { file: "src/alt.rs", change: "keep the text box centred", title: "alt text box regression", blocking: { class: "regression", why: "the box worked on main" } },
    { file: "src/alt.rs", change: "rename the helper", title: "helper name", blocking: { class: null, why: "naming only" } },
  ] });
  await pass();
  // The merge leg sees the refusal first and stops at it.
  await db.run(db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: null, state: "too-large", reason: "the PR diff is over the 60000 character limit", files: "[]", attempt: 1, created_at: new Date().toISOString(), source: null }));
  await untilQuiet(db, [() => advancePreapprovals(db)], 3);
  await advanceWorkflows(db);
  const asked = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([asked.state, asked.approvedBy], ["blocked", MAINT]);
  assert.doesNotMatch(asked.rec!.text, /Drop/);
  assert.match(asked.rec!.text, /could not make fix 1 \(alt text box regression\): .*size limit.* Make it again, then merge\./);
  assert.deepEqual(asked.rec!.parts.fix, [1], "a yes makes the blocking fix; the minor one is a follow-up");

  await db.run(db.k.updateTable("main.fixups").set({ state: "superseded" }).where("number", "=", 1).where("state", "=", "too-large"));
  await pass();
  const resumed = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([resumed.state, resumed.rec, resumed.approvedBy], ["running", null, MAINT], "the question closes by itself");
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.params?.source === "review"), "the fix-up runs again");
  assert.notEqual(await legState(w), "cancelled", "a new merge leg waits for it");
  w.close();
});

test("a hold the fix-ups do not resolve asks, after the tries, to try the fix-up again; the word merge merges past the review the person was shown", async () => {
  const w = await approvedReview();
  const db = w.db;
  const pass = async () => { await advanceWorkflows(db); await untilQuiet(db, [() => advancePreapprovals(db)], 3); await advanceWorkflows(db); };
  const hold = (head: string) => review(w, { head, verdict: "hold", at: new Date().toISOString() });
  // The fix-up asked for at `from` pushes `to`, which the review holds again.
  const pushes = async (from: string, to: string) => {
    const [req] = await w.rows("SELECT id FROM operator_fixups WHERE number = 1 AND from_head = ?", from);
    assert.ok(req, `a fix-up is asked for at ${from}`);
    await db.run(db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: from, to_head: to, state: "pushed", reason: null, files: "[]", attempt: 1, created_at: new Date().toISOString(), source: "operator", operator_fix: Number(req!.id) }));
    await db.run(db.k.insertInto("main.push_outcomes").values({ at: new Date().toISOString(), stage: "fixup", action: "fixup-push", repo: "app", number: 1, from_oid: from, to_oid: to, before_res: "green" }));
    await w.synced(1, to);
    await pass();
    await pause();
    await hold(to);
    await pass();
  };
  await hold("sha1");
  await pass();
  await pushes("sha1", "sha2");
  assert.deepEqual([(await liveWorkflow(db, "app", 1))!.state, (await liveWorkflow(db, "app", 1))!.rec], ["running", null], "the second hold gets its fix-up too");
  await pushes("sha2", "sha3");
  const asked = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([asked.state, asked.blocker, asked.approvedBy], ["blocked", "failed-twice", MAINT]);
  assert.match(asked.rec!.text, /could not fix .* in 2 tries\. Try the fix-up again, then merge\./);
  assert.equal((await w.rows("SELECT id FROM operator_fixups WHERE number = 1 AND from_head = 'sha3'")).length, 0, "no third try");

  await pause();
  const r = await runCommand(db, actor, "dashboard", { parsed: parse("merge"), items: [{ repo: "app", number: 1 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  await pass();
  assert.deepEqual([(await liveWorkflow(db, "app", 1))!.state, await legState(w)], ["running", "ci"], "the leg goes past the hold the person was shown");
  await (await w.premerge(1, "clean")).verified(1);
  await pass();
  assert.equal(await legState(w), "queued");
});

test("a fix-up of a screenshot regression that ends without a push asks to try it again, naming its last try", async () => {
  const w = await approvedReview();
  const db = w.db;
  const pass = async () => { await advanceWorkflows(db); await untilQuiet(db, [() => advancePreapprovals(db)], 3); await advanceWorkflows(db); };
  await review(w, { head: "sha1", verdict: "take", at: new Date().toISOString() });
  await (await w.premerge(1, "clean")).verified(1);
  await pass();
  await pause();
  const at = new Date().toISOString();
  await db.run(db.k.insertInto("main.screenshot_runs").values({ repo: "app", number: 1, head_sha: "sha1", state: "compared", verdict: "regression", clear: 1, held: 1, comparison: "The handles moved.", created_at: at, finished_at: at }));
  await pass();
  const [req] = await w.rows("SELECT id FROM operator_fixups WHERE number = 1 AND from_head = 'sha1'");
  assert.ok(req, "the regression gets a fix-up");
  await db.run(db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: null, state: "failed", reason: "the model gave no answer", files: "[]", attempt: 1, created_at: new Date().toISOString(), source: "operator", operator_fix: Number(req!.id) }));
  await pass();
  const wf = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([wf.state, wf.blocker], ["blocked", "failed-twice"]);
  assert.match(wf.rec!.text, /the model gave no answer.*Try the fix-up again/);
});

test("a hold written without a model call on an approved PR stops it at once as other, with no fix-up", async () => {
  const w = await approvedReview();
  await review(w, { head: "sha1", verdict: "hold", at: new Date().toISOString() });
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ model: null, reason: "too large" }).where("number", "=", 1));
  await advanceWorkflows(w.db);
  await untilQuiet(w.db, [() => advancePreapprovals(w.db)], 3);
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([wf.state, wf.blocker], ["blocked", "other"]);
  assert.deepEqual(await w.rows("SELECT id FROM operator_fixups WHERE number = 1"), []);
});

test("a lasting refusal after the hand-over asks once, and a yes goes on past it; a failed verification gets a fix-up instead", async () => {
  for (const what of ["verification", "refusal"] as const) {
    const w = await approvedReview();
    const db = w.db;
    const pass = async () => { await advanceWorkflows(db); await untilQuiet(db, [() => advancePreapprovals(db)], 3); await advanceWorkflows(db); };
    const plansMerge = async () => (await w.prPlan(1)).actions.some((a) => a.kind === "merge");
    await review(w, { head: "sha1", verdict: "take", at: new Date().toISOString() });
    await w.premerge(1, "clean");
    if (what === "refusal") await w.verified(1);
    await pass();
    assert.equal(await legState(w), "queued");
    await new Promise((r) => setTimeout(r, 5));
    const at = new Date().toISOString();
    if (what === "verification") {
      await w.verified(1, "failed");
      await db.run(db.k.updateTable("main.verifications").set({ finished_at: at }));
    } else {
      await db.run(db.k.insertInto("main.merges").values({ repo: "app", number: 1, head_oid: "sha1", run_id: "r", at, path: "operator", method: "squash", outcome: "refused", reason: "safe-merge: a workflow file may not be changed", ci: "success", mergeable: "MERGEABLE" }));
    }
    await pass();
    const wf = (await liveWorkflow(db, "app", 1))!;
    if (what === "verification") {
      assert.deepEqual([wf.state, wf.rec, wf.approvedBy], ["running", null, MAINT], "no question");
      const asked = await w.rows("SELECT by, instructions FROM operator_fixups WHERE number = 1");
      assert.ok(asked.length === 1 && asked[0]!.by === MAINT && /verification/.test(String(asked[0]!.instructions)), JSON.stringify(asked));
      assert.equal(await plansMerge(), false, "nothing merges before the fix");
      w.close();
      continue;
    }
    assert.deepEqual([wf.state, wf.approvedBy], ["blocked", MAINT], what);
    assert.ok(wf.rec?.text, what);
    assert.equal(await plansMerge(), false, what);

    await new Promise((r) => setTimeout(r, 5));
    const r = await runCommand(db, actor, "dashboard", { parsed: parse("yes"), items: [{ repo: "app", number: 1 }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
    await pass();
    await pass();
    assert.equal((await liveWorkflow(db, "app", 1))!.state, "running", what);
    assert.equal(await legState(w), "queued", what);
    assert.equal(await plansMerge(), true, `${what}: the merge is tried`);
    w.close();
  }
});

test("an answer that runs nothing leaves the PR alone until someone starts it; an issue's workflow that ended as its PR merged leaves its other PRs as they were", async () => {
  const w = keep(await (await (await world()).repo()).acting());
  const db = w.db;
  for (const n of [1, 2]) await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
  const merges = async (n: number): Promise<boolean> => (await w.prPlan(n)).actions.some((a) => a.kind === "merge") && (await mergeVerdicts(db, "app", [{ number: n, head: `sha${n}` }])).get(n)!.ok;
  assert.deepEqual([await merges(1), await merges(2)], [true, true], "the merge rule takes both");
  const ended = (number: number, kind: "pr" | "issue", entry: "review" | "implement") =>
    db.run(db.k.insertInto("main.item_workflows").values({ repo: "app", number, kind, entry, state: "done", started_by: MAINT, started_at: T0, started_via: "dashboard", plan: "[]", updated_at: T0 }));
  await ended(1, "pr", "review");
  assert.equal((await w.prPlan(1)).state, "not-started");
  assert.equal((await mergeVerdicts(db, "app", [{ number: 1, head: "sha1" }])).get(1)!.ok, false);

  // Issue 9's workflow: while its PR 2 is open an answer ended it, and once another PR of it merged the merge did.
  await w.issue(9);
  await ended(9, "issue", "implement");
  const attempt = (number: number, state: string) =>
    db.run(db.k.insertInto("main.implementations").values({ repo: "app", number: 9, queued_by: MAINT, state, attempt: 1, text_hash: `x${number}`, pr_number: number, created_at: T0, updated_at: T0 }));
  await attempt(2, "cancelled");
  assert.equal(await merges(2), false);
  await w.pr(3);
  await attempt(3, "merged");
  await db.run(db.k.updateTable("main.items").set({ state: "MERGED", closed_at: T1 }).where("number", "=", 3));
  assert.equal(await merges(2), true);
});

test("an approved review entry with minor findings and changes outside its purpose is fixed, reviewed again and handed to the merge queue as the approver", async () => {
  const w = await approvedReview();
  const db = w.db;
  // Reviews in the order a real run makes them: this one, the next at the pushed head, then the hand-over's Merge answer.
  await review(w, { head: "sha1", verdict: "take-fix", sure: false, at: new Date().toISOString(), outside: 60, fixes: [{ file: "src/lib.rs", change: "rename a to b", title: "clearer name", major: false }] });
  await advanceWorkflows(db);
  assert.deepEqual([(await liveWorkflow(db, "app", 1))!.state, (await liveWorkflow(db, "app", 1))!.blocker], ["running", null], "neither a minor finding of an unsure review nor lines outside the purpose stop an approved item");
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.params?.source === "review"), "the review's fix-up runs");

  // The fix-up pushes; our own push moves the head the workflow accepted.
  await fixup(w, { state: "pushed", files: ["src/lib.rs"], patch: "+b\n-a", to: "sha2" });
  await db.run(db.k.insertInto("main.push_outcomes").values({ at: later(), stage: "fixup", action: "fixup-push", repo: "app", number: 1, from_oid: "sha1", to_oid: "sha2", before_res: "green" }));
  await w.synced(1, "sha2");
  await advanceWorkflows(db);
  assert.deepEqual([(await liveWorkflow(db, "app", 1))!.state, (await liveWorkflow(db, "app", 1))!.baseHead], ["running", "sha2"]);
  await advancePreapprovals(db);
  assert.equal(await legState(w), "review");

  await review(w, { head: "sha2", verdict: "take", at: new Date().toISOString() });
  await w.premerge(1, "clean");
  await advanceWorkflows(db);
  await untilQuiet(db, [() => advancePreapprovals(db)], 3);
  assert.equal(await legState(w), "queued");
  const leg = (await db.get(db.k.selectFrom("main.preapprovals").select(["by", "workflow_id"]).where("number", "=", 1).orderBy("id", "desc").limit(1)))!;
  assert.equal(leg.by, MAINT, "the merge is made as the approver");
  assert.equal((await liveWorkflow(db, "app", 1))!.approvedBy, MAINT);
  await w.verified(1);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "merge"), "the merge queue merges it once verified");

  await db.run(db.k.updateTable("main.items").set({ state: "MERGED" }).where("number", "=", 1));
  await advanceWorkflows(db);
  assert.equal(await liveWorkflow(db, "app", 1), null);
});

test("a queued merge leg whose workflow ended with the merge is recorded merged, not cancelled", async () => {
  const w = await approvedReview();
  const db = w.db;
  await review(w, { head: "sha1", verdict: "take" });
  await w.premerge(1, "clean");
  await advanceWorkflows(db);
  await untilQuiet(db, [() => advancePreapprovals(db)], 3);
  assert.equal(await legState(w), "queued");
  // The merge lands and the workflow ends on it before the leg's pass sees the merge.
  await db.run(db.k.updateTable("main.items").set({ state: "MERGED" }).where("number", "=", 1));
  await advanceWorkflows(db);
  assert.equal(await liveWorkflow(db, "app", 1), null);
  await advancePreapprovals(db);
  assert.equal(await legState(w), "merged");
});

test("an approved merge goes on past an unsure pre-merge review with no defect; a defect past its fix-up rounds gets a fix-up as the approver", async () => {
  for (const kind of ["clean", "defect"] as const) {
    const w = await approvedReview();
    const db = w.db;
    await review(w, { head: "sha1", verdict: "take", at: new Date().toISOString() });
    if (kind === "clean") {
      // Waiting in ci for a pre-merge check no Task Runner can take: the state line says so.
      for (let i = 0; i < 2; i++) await advancePreapprovals(db);
      assert.equal(await legState(w), "ci");
      assert.equal(await legWait(db, (await liveWorkflow(db, "app", 1))!), "Waiting for the pre-merge check: no Task Runner can take it");
      // The approver's runner takes it: the state line names it while it cannot claim, and goes back to the steps once it can.
      const token = (await createToken(db, MAINT, "runner", { kind: "runner" })).row.id;
      // Read past the window the runner snapshot is kept for, so the new credential shows.
      const line = async () => await legWait(db, (await liveWorkflow(db, "app", 1))!, Date.now() + 2 * SNAPSHOT_CACHE_MS);
      assert.equal(await line(), "Waiting for mira's Task Runner (offline)");
      const report = (readiness: string) => storeStatus(db, token, MAINT, parseStatus({ slots: 1, busy: 0, readiness, harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
      await report("quota-held");
      assert.equal(await line(), "Waiting for mira's Task Runner (usage limit)");
      await report("ready");
      assert.equal(await line(), null);
    }
    await w.premerge(1, kind, false);
    if (kind === "defect") await w.premergeRoundsSpent(1);
    await db.run(db.k.updateTable("main.premerge_reviews").set({ unsure: 1 }).where("number", "=", 1));
    await untilQuiet(db, [() => advanceWorkflows(db), () => advancePreapprovals(db)], 3);
    await advanceWorkflows(db);
    const wf = (await liveWorkflow(db, "app", 1))!;
    if (kind === "clean") assert.deepEqual([await legState(w), wf.state], ["queued", "running"], "unsure with no finding: the merge queue has it");
    else {
      assert.deepEqual([wf.state, wf.rec, await legState(w)], ["running", null, "fixup"], "no question; a new leg waits for the fix");
      assert.deepEqual((await w.rows("SELECT by FROM operator_fixups WHERE number = 1")).map((r) => r.by), [MAINT]);
    }
    w.close();
  }
});

test("a started PR that is not approved comes back with the review's recommendation and its numbered plan", async () => {
  const w = await approvedReview();
  const db = w.db;
  await w.pr(2, { label: "feature" });
  assert.equal((await runCommand(db, actor, "dashboard", { parsed: parse("review"), items: [{ repo: "app", number: 2 }] })).items[0]!.outcome, "run");
  await db.run(db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 2, head_oid: "sha2", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "take-fix", sure: 1, reason: "r",
    fixes: JSON.stringify([{ file: "src/a.rs", change: "x", title: "guard empty input" }, { file: "src/b.rs", change: "y", title: "typo" }]),
    workflow: JSON.stringify({ outside_purpose: null, recommendation: { text: "Fix 1, then merge.", fix: [1], merge: true, close: false } }),
  }));
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 2))!;
  assert.deepEqual([wf.state, wf.rec?.text, wf.rec?.parts.fix, wf.rec?.merges, wf.plan.map((p) => p.title)], ["recommending", "Fix 1, then merge.", [1], true, ["guard empty input", "typo"]]);
});

test("a started review whose hold finds the PR incomplete asks its author at once and waits; the author's push ends the wait and their commits are reviewed", async () => {
  const w = await approvedReview();
  const db = w.db;
  await w.pr(2, { label: "feature", author: "octo-dev" });
  assert.equal((await runCommand(db, actor, "dashboard", { parsed: parse("review"), items: [{ repo: "app", number: 2 }] })).items[0]!.outcome, "run");
  await db.run(db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 2, head_oid: "sha2", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "hold", sure: 1, reason: "r",
    public_review: JSON.stringify({ summary: "The group editor the description promises has no caller.", points: [] }),
    workflow: JSON.stringify({ outside_purpose: null, recommendation: { text: "Ask the author to wire in the group editor.", fix: [], merge: false, close: false, author: true }, hold: { class: "off-purpose", why: "Most of the promised UI is missing." } }),
  }));
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 2))!;
  assert.deepEqual([wf.state, wf.rec], ["waiting", null], "no question comes back first");
  const asks = await db.all(db.k.selectFrom("main.workflow_actions").select(["kind", "state", "head"]).where("number", "=", 2));
  assert.deepEqual(asks, [{ kind: "ask-author", state: "pending", head: "sha2" }]);
  const ask = (wf.blockerParams as { author: { text: string; auto?: true } }).author;
  assert.ok(ask.auto && ask.text.startsWith("@octo-dev") && ask.text.includes("group editor"), ask.text);
  await w.synced(2, "sha9");
  await advanceWorkflows(db);
  assert.equal((await liveWorkflow(db, "app", 2))!.state, "running");
  assert.ok(decidePr((await loadPrFact(db, "app", 2))!).actions.some((a) => a.kind === "review" && a.head === "sha9"), "the author's push is reviewed");
});

test("a hold review never asks the author by itself when it has no blocking class, was read again after a question closed by itself or the person went on, or the author is a bot: the person gets the question", async () => {
  const w = await approvedReview();
  const db = w.db;
  const send = async (text: string, n: number) => { const r = (await runCommand(db, actor, "dashboard", { parsed: parse(text), items: [{ repo: "app", number: n }] })).items[0]!; assert.equal(r.outcome, "run", JSON.stringify(r)); };
  const asks = async () => (await db.all(db.k.selectFrom("main.workflow_actions").select("number"))).map((r) => Number(r.number));
  const blocking = { class: "off-purpose", why: "Most of the promised UI is missing." };
  // 2: a review stored before holds were classed; 3: a blocking hold, which asks; 4: a bot's PR.
  const cases: [number, string, object | null][] = [[2, "octo-dev", null], [3, "octo-dev", { hold: blocking }], [4, "dependabot[bot]", { hold: blocking }]];
  for (const [n, author, wf] of cases) {
    await w.pr(n, { label: "feature", author });
    await send("review", n);
    await db.run(db.k.insertInto("main.opus_reviews").values({
      repo: "app", number: n, head_oid: `sha${n}`, run_id: "rv", at: new Date().toISOString(), model: "m", mode: "full", verdict: "hold", sure: 1, reason: "r",
      workflow: wf && JSON.stringify({ outside_purpose: null, recommendation: null, ...wf }),
    }));
  }
  await advanceWorkflows(db);
  const states = async () => await Promise.all([2, 3, 4].map(async (n) => { const wf = (await liveWorkflow(db, "app", n))!; return [wf.state, wf.rec?.author ?? (wf.rec?.backlog ? "backlog" : null)]; }));
  assert.deepEqual(await states(), [["recommending", "scope"], ["waiting", null], ["recommending", "backlog"]]);
  assert.deepEqual(await asks(), [3]);
  // A question made after that review closes by itself (its cause went: GitHub says whether it can be merged): the review, read again, comes back as the
  // question instead of asking the author.
  await db.run(db.k.deleteFrom("main.workflow_actions"));
  const asked3 = (await liveWorkflow(db, "app", 3))!;
  const shownAt = new Date(Date.now() + 500).toISOString();
  const stuck = { text: "GitHub does not say whether it can be merged.", parts: { fix: [], drop: [] }, merges: false, cause: { code: "mergeable-stuck" as const } };
  await saveWorkflows(db, [{ id: asked3.id, patch: { state: "recommending", rec: stuck, recAt: shownAt, recHead: "sha3", blocker: null, blockerParams: null }, at: shownAt }]);
  await advanceWorkflows(db);
  assert.deepEqual((await states())[1], ["recommending", "ask"]);
  assert.deepEqual(await asks(), []);
  // The person went on after that review (an answer, as when a question's cause went): the same review, read again, comes back as the
  // question instead of asking again.
  await db.run(db.k.deleteFrom("main.workflow_actions"));
  const wf3 = (await liveWorkflow(db, "app", 3))!;
  const at = new Date(Date.now() + 1_000).toISOString();
  await saveWorkflows(db, [{ id: wf3.id, patch: { state: "running", blocker: null, blockerParams: null }, at }]);
  await recordEvents(db, [{ workflowId: wf3.id, repo: "app", number: 3, login: MAINT, via: "dashboard", kind: "answered", line: "yes", at }]);
  await advanceWorkflows(db);
  assert.deepEqual((await states())[1], ["recommending", "ask"]);
  assert.deepEqual(await asks(), []);
});

/** PR 2, conflicting with its base branch, started with `start`, and a hold review at sha2 with one fix and no recommendation. */
async function heldConflicting(start: string): Promise<World> {
  const w = await approvedReview();
  const db = w.db;
  await w.pr(2, { label: "feature" });
  await db.run(db.k.updateTable("main.items").set({ base_ref: "main", mergeable: "CONFLICTING" }).where("number", "=", 2));
  await db.run(db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING" }).where("number", "=", 2));
  assert.equal((await runCommand(db, actor, "dashboard", { parsed: parse(start), items: [{ repo: "app", number: 2 }] })).items[0]!.outcome, "run");
  await db.run(db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 2, head_oid: "sha2", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "hold", sure: 1, reason: "r",
    fixes: JSON.stringify([{ file: "src/a.rs", change: "x", title: "wire in the group editor" }]), workflow: JSON.stringify({ outside_purpose: null, recommendation: null }),
  }));
  return w;
}

test("a hold with fixes on a PR that conflicts with its base branch recommends the fixes after the base merge, never the backlog", async () => {
  const w = await heldConflicting("review");
  await advanceWorkflows(w.db);
  const rec = (await liveWorkflow(w.db, "app", 2))!.rec!;
  assert.ok(/conflicts/.test(rec.text) && !/again|backlog/i.test(rec.text), rec.text);
  assert.deepEqual([rec.again, rec.backlog, rec.parts.fix], [undefined, undefined, [1]]);
});

test("an approved PR whose review holds it and that conflicts merges the base branch and asks for the fix-up, with no backlog", async () => {
  const w = await heldConflicting("review and merge");
  const db = w.db;
  await ticks(w);
  const wf = (await liveWorkflow(db, "app", 2))!;
  assert.ok(wf.state !== "blocked" && !wf.rec, JSON.stringify(wf.rec));
  const fixups = await db.all(db.k.selectFrom("main.operator_fixups").select(["from_head", "state"]).where("number", "=", 2));
  assert.deepEqual(fixups, [{ from_head: "sha2", state: "queued" }], "the fix-up is asked for as the approver");
  const plan = decidePr((await loadPrFact(db, "app", 2))!).actions;
  assert.ok(plan.some((a) => a.kind === "conflict"), JSON.stringify(plan));
});

test("a recommendation's fix numbers follow the stored fixes, not the model's list", () => {
  const reply = JSON.stringify({
    ref: "app#1", verdict: "take-fix", sure: true, reason: "two fixes", risks: [],
    fixes: [{ file: "src/a.rs", change: "guard a" }, { file: "src/b.rs", change: "guard b" }],
    claims: [{ claim: "handles empty input", status: "contradicted", evidence: "src/c.rs:3 indexes element 0", impact: "code-wrong", fix: { file: "src/c.rs", change: "check the length" } }],
    recommendation: { text: "Fix 2, then merge.", fix: [2], merge: true, close: false },
  });
  const r = parseOpusReply(reply, "app#1", true, new Set(), false, [], "Handles empty input.", ["src/a.rs", "src/b.rs", "src/c.rs"])!;
  assert.deepEqual([r.fixes.map((f) => f.file), r.workflow?.recommendation?.fix], [["src/c.rs", "src/a.rs", "src/b.rs"], [3]], "the claim's fix goes first, so the model's 2 is the stored 3");
});

test("an implement question comes back as one recommendation, and a yes answers it so the implementation plans again", async () => {
  const w = await asked(ASKS);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.rec?.text], ["recommending", ASKS.workflow!.recommendation]);
  assert.deepEqual(wf.plan.map((p) => [p.n, p.title]), [[1, "Globally"], [2, "Per document"]]);
  assert.ok("wait" in (await nextStep(w))!, "the implementation waits for the answer");

  const r = await say(w, "yes");
  assert.equal(r.outcome, "run", r.line);
  assert.match(r.line, /Per document/);
  assert.equal(await labelOf(w), "Per document");
  assert.equal(openQuestion((await currentAttempt(w.db, "app", 7))!.rounds).answer?.by, MAINT);
  assert.deepEqual(await nextStep(w), { bucket: "plan" });
  await advanceWorkflows(w.db);
  const on = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([on.state, on.rec, on.plan], ["running", null, []]);
});

test("an option's number or its words answer an implement question; a reply that names none or several runs nothing", async () => {
  for (const [text, label] of [["1", "Globally"], ["fix 1", "Globally"], ["go with per document", "Per document"], ["not per document", undefined], ["3", undefined], ["1 or 2", undefined]] as const) {
    const w = await asked(ASKS);
    const r = await say(w, text);
    assert.equal(r.outcome, label ? "run" : "ambiguous", `${text}: ${r.line}`);
    assert.equal(await labelOf(w), label, text);
    w.close();
  }
});

test("a question set aside elsewhere takes its recommendation with it, and a late yes answers nothing", async () => {
  const w = await asked(ASKS);
  const at = (await currentAttempt(w.db, "app", 7))!;
  // A comment on the issue answered it: the implementation plans again.
  await writeStep(w.db, at.impl, { to: "planning" });
  const r = await say(w, "yes");
  assert.equal(r.outcome, "refused", r.line);
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.rec], ["running", null]);
});

test("a stuck implementation comes back with Try again, and a yes starts it again", async () => {
  for (const approved of [false, true]) {
    const w = await implementIssue();
    const db = w.db;
    if (approved) await say(w, "merge");
    await markStuck(db, (await currentAttempt(db, "app", 7))!.impl, "blocked", null);
    await advanceWorkflows(db);
    const wf = (await liveWorkflow(db, "app", 7))!;
    assert.deepEqual([wf.state, wf.blocker, wf.rec?.merges], approved ? ["blocked", "failed-twice", true] : ["recommending", null, false]);
    assert.ok("wait" in (await nextStep(w))!);

    const r = await say(w, "yes");
    assert.equal(r.outcome, "run", r.line);
    assert.deepEqual(await nextStep(w), { bucket: "build" });
    assert.match((await applyStuckAnswer(db, (await currentAttempt(db, "app", 7))!))!.did, /attempt 2 started/);
    await advanceWorkflows(db);
    const on = (await liveWorkflow(db, "app", 7))!;
    assert.deepEqual([on.state, on.blocker, on.approvedBy], ["running", null, approved ? MAINT : null]);
    w.close();
  }
});

test("an answer on an implement issue queues a fix-up of the named part on its implementation PR", async () => {
  const w = await implementIssue();
  const db = w.db;
  await w.pr(8, { author: "craft-bot" });
  const im = (await currentAttempt(db, "app", 7))!.impl;
  await writeStep(db, im, { to: "pr-opened", patch: { branch: "fix-8", prNumber: 8, prUrl: "https://example.invalid/8" } });
  await db.run(db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 8, head_oid: "sha8", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "take-fix", sure: 1, reason: "r",
    fixes: JSON.stringify([{ file: "src/export.rs", change: "store the folder on the document", title: "folder per document" }]),
  }));
  await advanceWorkflows(db);
  assert.deepEqual((await liveWorkflow(db, "app", 7))!.plan.map((p) => p.title), ["folder per document"]);

  const r = await runCommand(db, actor, "dashboard", { parsed: parse("fix 1"), items: [{ repo: "app", number: 7 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  const fx = await db.all(db.k.selectFrom("main.operator_fixups").select(["number", "state", "instructions"]).where("repo", "=", "app"));
  assert.equal(fx.length, 1);
  assert.equal(fx[0]!.number, 8);
  assert.match(fx[0]!.instructions ?? "", /folder per document/);
});

test("an approved implementation that changed files its plan does not name goes on to its merge without asking", async () => {
  const w = await implementationOpened(["src/a.rs", "src/zzz.rs", "Cargo.lock"], true);
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.rec, wf.approvedBy, await leg8(w)], ["running", null, MAINT, "review"]);
});

test("an implementation inside its plan merges without asking; one beyond it names the files in the end recommendation", async () => {
  const inside = await implementationOpened(["src/a.rs"], true);
  await advanceWorkflows(inside.db);
  assert.deepEqual([(await liveWorkflow(inside.db, "app", 7))!.state, await leg8(inside)], ["running", "review"]);
  inside.close();
  const w = await implementationOpened(["src/a.rs", "src/zzz.rs"], false);
  await review8(w, "take");
  await w.verified(8);
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.equal(wf.state, "recommending");
  assert.match(wf.rec!.text, /src\/zzz\.rs/);
});

test("the other blockers stop an approved implementation too", async () => {
  const cases: [Blocker, (w: World) => Promise<unknown>][] = [
    ["author-commits", (w) => w.synced(8, "theirs")],
    ["failed-twice", async (w) => { for (const state of ["failed", "rejected"]) await w.db.run(w.db.k.insertInto("main.ci_fixes").values({ repo: "app", number: 8, head: "sha8", kind: "patch", state, attempt: state === "failed" ? 1 : 2, created_at: later() })); }],
  ];
  for (const [blocker, evidence] of cases) {
    const w = await implementationOpened(["src/a.rs"], true);
    await advanceWorkflows(w.db);
    assert.equal(await leg8(w), "review");
    await evidence(w);
    await advanceWorkflows(w.db);
    const wf = (await liveWorkflow(w.db, "app", 7))!;
    assert.deepEqual([wf.state, wf.blocker, wf.approvedBy], ["blocked", blocker, MAINT], blocker);
    assert.equal(await leg8(w), "cancelled", blocker);
    w.close();
  }
});

test("an implementation's question is for the head it showed: our push leaves it, someone else's refuses the answer and is asked about", async () => {
  const w = await implementationOpened(["src/a.rs"], true);
  await advanceWorkflows(w.db);
  for (const state of ["failed", "rejected"]) await w.db.run(w.db.k.insertInto("main.ci_fixes").values({ repo: "app", number: 8, head: "sha8", kind: "patch", state, attempt: state === "failed" ? 1 : 2, created_at: later() }));
  await advanceWorkflows(w.db);
  const asked = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([asked.blocker, asked.recHead], ["failed-twice", "sha8"]);
  await ownPush(w, "sha8", "ours8", 8);
  await advanceWorkflows(w.db);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.recAt, asked.recAt);

  await w.synced(8, "theirs");
  assert.equal((await say(w, "yes")).outcome, "refused");
  await advanceWorkflows(w.db);
  const again = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([again.state, again.blocker, again.recHead], ["blocked", "author-commits", "theirs"]);
  assert.match(again.rec!.text, /author pushed/);

  await ownPush(w, "theirs", "ours9", 8);
  const o = await say(w, "yes");
  assert.equal(o.outcome, "run", o.line);
});

test("a person's stop, approval or drop during the pass wins over what the pass writes", async () => {
  for (const text of ["stop", "merge", "drop 1", "stop, then review"]) {
    const w = await approvedReview();
    const db = w.db;
    await w.pr(2, { label: "feature" });
    const say2 = async (t: string) => { const o = (await runCommand(db, actor, "dashboard", { parsed: parse(t), items: [{ repo: "app", number: 2 }] })).items[0]!; assert.equal(o.outcome, "run", o.line); };
    await say2("review");
    await db.run(db.k.insertInto("main.opus_reviews").values({ repo: "app", number: 2, head_oid: "sha2", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "take-fix", sure: 1, reason: "r", fixes: JSON.stringify([{ file: "a", change: "x", title: "one" }]) }));
    await db.run(db.k.updateTable("main.item_workflows").set({ plan: JSON.stringify([{ n: 1, title: "one", source: "review", state: "planned" }]) }).where("number", "=", 2));
    // Another process handles the command between the pass's reads and its write.
    const write = db.write;
    db.write = (async (f: () => Promise<unknown>, o?: never) => {
      db.write = write;
      for (const t of text.split(", then ")) await say2(t);
      return await write.call(db, f, o);
    }) as typeof write;
    await advanceWorkflows(db);
    const wf = (await workflowHistory(db, "app", 2)).map((x) => [x.state, x.approvedBy, x.rec]);
    const want = { stop: [["stopped", null, null]], merge: [["running", MAINT, null]], "drop 1": [["running", null, null]], "stop, then review": [["stopped", null, null], ["running", null, null]] }[text];
    assert.deepEqual(wf, want, text);
    if (text === "drop 1") assert.equal((await liveWorkflow(db, "app", 2))!.plan[0]!.state, "dropped");
    w.close();
  }
});

test("one workflow's change that cannot be stored loses no other's, and the pass is told to run again", async () => {
  const w = await approvedReview();
  const db = w.db;
  for (const number of [2, 3]) {
    await w.pr(number, { label: "feature" });
    await runCommand(db, actor, "dashboard", { parsed: parse("review"), items: [{ repo: "app", number }] });
    await db.run(db.k.insertInto("main.opus_reviews").values({ repo: "app", number, head_oid: `sha${number}`, run_id: "rv", at: later(), model: "m", mode: "full", verdict: "hold", sure: 1, reason: "r" }));
  }
  const write = db.write;
  // The joint write fails, then the first workflow's own.
  let failures = 2;
  // The earliest time the pass asked to run again: a failure asks at once, a timed check of the facts no sooner than the facts say.
  let woken = Infinity;
  const pass = async () => {
    db.write = (async (f: () => Promise<unknown>, o?: never) => {
      const joint = /moveWorkflows/.test(String(f));
      if (joint && failures > 0) { failures--; throw new Error("not stored"); }
      return await write.call(db, f, o);
    }) as typeof write;
    woken = Infinity;
    try { await advanceWorkflows(db, () => {}, (at) => { woken = Math.min(woken, at); }); } finally { db.write = write; }
    return (await Promise.all([2, 3].map((n) => liveWorkflow(db, "app", n)))).map((x) => x!.state).sort();
  };
  // A hold with no recommendation and no class of its own comes back to the person first.
  assert.deepEqual(await pass(), ["recommending", "running"]);
  assert.ok(woken <= Date.now() + 1_000, "the failed one is tried again at once");
  assert.deepEqual(await pass(), ["recommending", "recommending"]);
  assert.ok(woken > Date.now() + 120_000, "nothing failed: no retry");
});

test("a workflow whose change cannot be stored keeps its merge leg where it is, shows on its item and in the health check after three failures and is not tried on every tick; the others go on", async () => {
  const w = await approvedReview();
  const db = w.db;
  await w.pr(2, { label: "feature" });
  await runCommand(db, actor, "dashboard", { parsed: parse("review and merge"), items: [{ repo: "app", number: 2 }] });
  const lines: string[] = [];
  const runner = new Runner({ db, logs: mkdtempSync(join(SCRATCH, "workflow-runner-")), log: (l) => lines.push(l), detect: async () => ({ proposals: [], logs: [] }) });
  const legs = async () => (await db.all(db.k.selectFrom("main.preapprovals").select(["number", "state"]).orderBy("number"))).map((l) => `${l.number} ${l.state}`);
  const row = async () => (await liveWorkflow(db, "app", 1))!.updatedAt;
  const checks = async () => (await computeChecks(db)).filter((c) => c.group === "workflows");
  for (let i = 0; i < 2; i++) await runner.tick();
  assert.deepEqual(await legs(), ["1 review", "2 review"]);
  for (const number of [1, 2]) await db.run(db.k.insertInto("main.opus_reviews").values({ repo: "app", number, head_oid: `sha${number}`, run_id: "rv", at: later(), model: "m", mode: "full", verdict: "take", sure: 1, reason: "r",
    fixes: JSON.stringify([{ title: "A typo", file: "src/a.rs", change: "fix it", severity: "minor" }]) }));
  const write = db.write;
  const was = await row();
  db.write = (async (f: () => Promise<unknown>, o?: never) => await write.call(db, async () => {
    const r = await f();
    if (await row() !== was) throw new Error("bad row");
    return r;
  }, o)) as typeof write;
  const tries = () => lines.filter((l) => l === "workflow app#1: bad row").length;
  for (let i = 0; i < 3; i++) await runner.tick();
  assert.deepEqual(await legs(), ["1 review", "2 ci"], lines.join("\n"));
  assert.deepEqual((await checks()).map((c) => c.state), ["ok"], "two failures in a row do not show yet");
  // The backoff has passed, and the pass runs again on new input: the third failure in a row shows.
  for (const f of (runner as unknown as { failedWorkflows: Map<number, FailedCheck> }).failedWorkflows.values()) f.until = 0;
  await review(w, { head: "sha-old", verdict: "take", at: "2026-01-01T00:00:00Z" });
  await runner.tick();
  const [bad, ...others] = await checks();
  assert.deepEqual([bad!.state, bad!.repo, others.length], ["warn", "app", 0]);
  assert.match(bad!.text, /app#1.*: bad row/);
  assert.match((await legWait(db, (await liveWorkflow(db, "app", 1))!))!, /failed to check/);
  const before = tries();
  // The inputs of the pass change on every tick.
  for (let i = 0; i < 4; i++) { await review(w, { head: `sha-old${i}`, verdict: "take", at: "2026-01-01T00:00:00Z" }); await runner.tick(); }
  assert.equal(tries(), before);
  assert.deepEqual(await legs(), ["1 review", "2 ci"]);
  // The write works again: a person's command on the item does not wait for the backoff.
  db.write = write;
  await runCommand(db, actor, "dashboard", { parsed: parse("urgent"), items: [{ repo: "app", number: 1 }] });
  for (let i = 0; i < 3; i++) await runner.tick();
  assert.deepEqual(await legs(), ["1 ci", "2 ci"], lines.join("\n"));
  assert.deepEqual((await checks()).map((c) => c.state), ["ok"]);
  assert.doesNotMatch((await legWait(db, (await liveWorkflow(db, "app", 1))!)) ?? "", /failed to check/);
  await runner.stop();
  await db.close();
});

test("the third attempt on an issue text offers no Try again, whatever became of the first two", async () => {
  const w = await implementIssue();
  const db = w.db;
  for (const end of ["cancelled", "closed"] as const) {
    const im = (await currentAttempt(db, "app", 7))!.impl;
    await recordSteps(db, [{ id: im.id, to: end }]);
    await startAttempt(db, { repo: "app", number: 7, queuedBy: MAINT, textHash: im.textHash });
  }
  await markStuck(db, (await currentAttempt(db, "app", 7))!.impl, "blocked", null);
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 7))!;
  assert.deepEqual([wf.state, wf.rec?.answer], ["recommending", undefined]);
});
