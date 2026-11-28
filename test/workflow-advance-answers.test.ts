// The advance pass of the maintainer workflow (src/workflow/advance.ts) with the merge leg (src/preapproval): blockers stop an
// approved item and keep its approval, a yes resumes it, and an approved review entry with minor findings is fixed, then merged.
// An implement issue's plan question comes back as its recommendation, and answers on the issue reach its implementation PR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { runText } from "../src/workflow/read.ts";
import { eventsOf, liveWorkflow } from "../src/workflow/store.ts";
import { type World } from "./world-db.ts";
import { actor, answer, ANSWERS, approvedReview, asked, askedReview, authorPushed, later, leg2, legState, MAINT, ownPush, pause, planned2, pushNow, review2, reviewNow, ticks } from "./workflow-advance-world.ts";

/** Two failed fix-up tries of PR 2 at `head`: a step that failed twice. */
const failedTwice = async (w: World, head = "sha2") => {
  for (const [state, attempt] of [["failed", 1], ["refused", 2]] as const) await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 2, from_head: head, to_head: null, state, reason: null, files: "[]", attempt, created_at: new Date().toISOString(), source: "review" }));
};
/** PR 2 runs with no question, and a fix-up was asked for as the approver for each of `heads`. */
const fixedFirst = async (w: World, heads: string[]) => {
  const wf = (await liveWorkflow(w.db, "app", 2))!;
  assert.deepEqual([wf.state, wf.rec, wf.approvedBy], ["running", null, MAINT], "no question");
  assert.deepEqual((await w.rows("SELECT by, from_head FROM operator_fixups WHERE number = 2 ORDER BY id")).map((r) => [r.by, r.from_head]), heads.map((h) => [MAINT, h]));
};

test("a plain approval does not accept a hold review nobody was shown: the hold is fixed before the merge", async () => {
  const w = await approvedReview();
  const db = w.db;
  await w.pr(2, { label: "feature" });
  await runCommand(db, actor, "dashboard", { parsed: parse("review"), items: [{ repo: "app", number: 2 }] });
  await db.run(db.k.insertInto("main.opus_reviews").values({ repo: "app", number: 2, head_oid: "sha2", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "hold", sure: 1, reason: "r" }));
  await runCommand(db, actor, "dashboard", { parsed: parse("merge"), items: [{ repo: "app", number: 2 }], at: new Date(Date.now() + 10_000).toISOString() });
  await advanceWorkflows(db);
  await advancePreapprovals(db);
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 2))!;
  assert.deepEqual([wf.state, wf.rec], ["running", null]);
  assert.deepEqual((await w.rows("SELECT state FROM preapprovals WHERE number = 2 ORDER BY id")).map((r) => r.state), ["failed", "fixup"], "the hold stops the leg, and its fix-up comes first");
});

test("an answer is for the head its question showed: after an author push it approves nothing, and the question is asked again at the new head", async () => {
  for (const [via, text] of ANSWERS) {
    const w = await askedReview();
    await w.synced(2, "theirs");
    const early = await answer(w, text, via);
    assert.equal(early.outcome, "refused", via);
    assert.match(early.line, /author pushed commits/, via);
    await advanceWorkflows(w.db);
    assert.equal((await liveWorkflow(w.db, "app", 2))!.rec, null, "no question stands on the old head");
    assert.notEqual((await answer(w, "yes", via)).outcome, "run", "a late yes answers nothing");

    await review2(w, "theirs");
    await advanceWorkflows(w.db);
    const asked = (await liveWorkflow(w.db, "app", 2))!;
    assert.deepEqual([asked.state, asked.recHead, asked.approvedBy], ["recommending", "theirs", null], via);
    assert.match(asked.rec!.text, /author pushed/);
    await advanceWorkflows(w.db);
    assert.equal((await liveWorkflow(w.db, "app", 2))!.recAt, asked.recAt, "asked once at that head");

    assert.equal((await answer(w, text, via)).outcome, "run", via);
    const on = (await liveWorkflow(w.db, "app", 2))!;
    assert.deepEqual([on.approvedBy, on.baseHead, on.state], [MAINT, "theirs", "running"], via);
    w.close();
  }
});

test("our own push leaves the question as it is, and an answer accepts it; not once it lies on the author's commits", async () => {
  for (const [via, text] of ANSWERS) {
    const w = await askedReview();
    const asked = (await liveWorkflow(w.db, "app", 2))!;
    await ownPush(w, "sha2", "ours");
    await advanceWorkflows(w.db);
    const now = (await liveWorkflow(w.db, "app", 2))!;
    assert.deepEqual([now.state, now.recHead, now.recAt, now.rec], [asked.state, asked.recHead, asked.recAt, asked.rec], via);
    if (via === "dashboard") {
      await ownPush(w, "theirs", "ours on theirs");
      assert.equal((await answer(w, text, via)).outcome, "refused");
      await w.synced(2, "ours");
    }
    const o = await answer(w, text, via);
    assert.equal(o.outcome, "run", o.line);
    const on = (await liveWorkflow(w.db, "app", 2))!;
    assert.deepEqual([on.approvedBy, on.baseHead], [MAINT, "ours"], via);
    w.close();
  }
});

test("a resume accepts no pushes: a hold and a resume keep the workflow and its approval, whatever our pushes changed", async () => {
  const w = await approvedReview();
  await w.pr(2, { label: "feature" });
  assert.equal((await answer(w, "merge")).outcome, "run");
  await pause();
  await pushNow(w, "sha2", "ours", 300);
  await advanceWorkflows(w.db);
  const before = (await liveWorkflow(w.db, "app", 2))!;
  assert.equal(before.state, "running");
  for (const text of ["hold", "resume"]) { assert.equal((await answer(w, text)).outcome, "run"); await pause(); }
  await pushNow(w, "ours", "ours2", 300);
  await advanceWorkflows(w.db);
  const now = (await liveWorkflow(w.db, "app", 2))!;
  assert.deepEqual([now.id, now.state, now.blocker, now.approvedAt], [before.id, "running", null, before.approvedAt]);
  w.close();
});

test("after an author push a yes to a recommended close closes nothing; the word close does", async () => {
  const w = await askedReview("close");
  await w.synced(2, "theirs");
  assert.equal((await answer(w, "yes")).outcome, "refused");
  assert.equal((await liveWorkflow(w.db, "app", 2))!.state, "recommending");
  assert.equal((await answer(w, "close")).outcome, "run");
  assert.equal(await liveWorkflow(w.db, "app", 2), null);
});

test("a blocked item asks again at each head the author pushes, once, and goes on from the one a person answered at", async () => {
  for (const entry of ["merge", "review and merge"]) {
    const w = await approvedReview();
    const db = w.db;
    await w.pr(2, { label: "feature" });
    assert.equal((await answer(w, entry)).outcome, "run");
    if (entry === "merge") { await w.synced(2, "theirs1"); await w.outOfScope(2, "theirs1"); }
    else await failedTwice(w);
    await advanceWorkflows(db);
    const first = (await liveWorkflow(db, "app", 2))!;
    assert.deepEqual([first.state, first.blocker], ["blocked", entry === "merge" ? "author-commits" : "failed-twice"]);

    await w.synced(2, "theirs2");
    await w.outOfScope(2, "theirs2");
    assert.equal((await answer(w, "yes")).outcome, "refused", entry);
    for (let i = 0; i < 2; i++) await advanceWorkflows(db);
    const again = (await liveWorkflow(db, "app", 2))!;
    assert.deepEqual([again.state, again.blocker, again.recHead, again.approvedBy], ["blocked", "author-commits", "theirs2", MAINT], entry);
    assert.match(again.rec!.text, /author pushed/);
    assert.equal((await eventsOf(db, "app", 2)).filter((e) => e.kind === "blocked").length, 2, "one question per head");

    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await answer(w, "yes")).outcome, "run", entry);
    const on = (await liveWorkflow(db, "app", 2))!;
    assert.deepEqual([on.state, on.baseHead], ["running", "theirs2"], entry);
    w.close();
  }
});

test("the author's commits on a merge entry are reviewed in the round before the merge queue takes them; a hold of the round is fixed first; past a finding beyond the approval, merge goes on", async () => {
  for (const verdict of ["take", "hold"]) {
    const w = await approvedReview();
    await w.pr(2, { label: "feature" });
    assert.equal((await answer(w, "merge")).outcome, "run");
    await w.synced(2, "theirs");
    await ticks(w);
    const round = (await liveWorkflow(w.db, "app", 2))!;
    assert.deepEqual([round.state, round.blocker, round.step], ["running", null, "review new commits"]);
    assert.ok((await planned2(w)).includes("review"));
    await reviewNow(w, "theirs", verdict);
    await ticks(w);
    if (verdict === "hold") {
      await fixedFirst(w, ["theirs"]);
      assert.ok(!(await planned2(w)).includes("merge"));
      w.close();
      continue;
    }
    assert.deepEqual([(await leg2(w)).state, (await liveWorkflow(w.db, "app", 2))!.state], ["queued", "running"], verdict);
    assert.ok((await planned2(w)).includes("merge"), verdict);
    w.close();
  }
  const w = await authorPushed();
  assert.equal((await answer(w, "merge")).outcome, "run");
  await ticks(w);
  assert.ok(!(await planned2(w)).includes("review"));
  await (await w.verified(2)).premerge(2, "clean");
  await ticks(w);
  assert.equal((await leg2(w)).state, "queued");
});

test("a merge entry is reviewed again when a person asks for it, whatever an older review said", async () => {
  const w = await approvedReview();
  await w.pr(2, { label: "feature" });
  await reviewNow(w, "sha2", "hold");
  assert.equal((await answer(w, "merge")).outcome, "run");
  await ticks(w);
  assert.equal((await leg2(w)).state, "queued", "a merge entry needs no review");
  await pause();
  assert.equal((await answer(w, "review")).outcome, "run");
  await ticks(w);
  assert.deepEqual([(await planned2(w)).includes("review"), (await planned2(w)).includes("merge")], [true, false]);
  // The review that was asked for.
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }).where("number", "=", 2));
  await w.db.run(w.db.k.deleteFrom("main.review_state").where("number", "=", 2));
  await pause();
  await ticks(w);
  await fixedFirst(w, ["sha2"]);
});

test("what came between a question and its answer was not seen: our push owes its review, a hold is fixed first", async () => {
  // A merge entry: the word merge goes on past the author's commits, not past our push on them.
  let w = await authorPushed();
  await pushNow(w, "theirs", "ours");
  assert.equal((await answer(w, "merge")).outcome, "run");
  await ticks(w);
  assert.deepEqual([(await leg2(w)).state, (await leg2(w)).from_head], ["review", "theirs"]);
  assert.ok((await planned2(w)).includes("review"));
  w.close();

  // So too when its review was made before the answer.
  w = await authorPushed();
  await pushNow(w, "theirs", "ours");
  await reviewNow(w, "ours", "hold");
  assert.equal((await answer(w, "merge")).outcome, "run");
  await ticks(w);
  await fixedFirst(w, ["ours"]);
  w.close();

  // A reviewed PR: a hold at a head the person was not shown is fixed, not merged past.
  w = await approvedReview();
  await w.pr(2, { label: "feature" });
  assert.equal((await answer(w, "review and merge")).outcome, "run");
  await pause();
  await pushNow(w, "sha2", "ours");
  await reviewNow(w, "ours", "hold");
  await advancePreapprovals(w.db);
  assert.notEqual((await leg2(w)).state, "ci", "the leg goes past no review the person was not shown");
  await ticks(w);
  await fixedFirst(w, ["ours"]);
  w.close();
});

test("the merge leg a question ended is no reason to ask again after an answer that starts none", async () => {
  const w = await approvedReview();
  await w.pr(2, { label: "feature" });
  assert.equal((await answer(w, "review and merge")).outcome, "run");
  await pause();
  await review2(w, "sha2");
  await ticks(w);
  await failedTwice(w);
  await pause();
  await advanceWorkflows(w.db);
  const asked = (await liveWorkflow(w.db, "app", 2))!;
  assert.deepEqual([asked.blocker, (await leg2(w)).state], ["failed-twice", "cancelled"]);
  await pause();
  const o = await answer(w, "yes");
  assert.equal(o.outcome, "run", o.line);
  await advanceWorkflows(w.db);
  const on = (await liveWorkflow(w.db, "app", 2))!;
  assert.deepEqual([on.state, on.blocker], ["running", null]);
});

test("no answer ends the review a push of ours owes a merge entry: past a failing step, or the author's commits on top, whose round reviews it", async () => {
  const started = async () => {
    const w = await approvedReview();
    await w.pr(2, { label: "feature" });
    assert.equal((await answer(w, "merge")).outcome, "run");
    await pause();
    return w;
  };
  const owes = async (w: World, what: string) => {
    await (await w.verified(2)).premerge(2, "clean");
    await ticks(w);
    assert.deepEqual([(await leg2(w)).state, (await planned2(w)).includes("review"), (await planned2(w)).includes("merge")], ["review", true, false], what);
    const head = String((await leg2(w)).head);
    await w.db.run(w.db.k.insertInto("main.opus_reviews").values({ repo: "app", number: 2, head_oid: head, run_id: "rv", at: new Date().toISOString(), model: "m", mode: "full", verdict: "take", sure: 1, reason: "r" }));
    await w.db.run(w.db.k.deleteFrom("main.review_state").where("number", "=", 2));
    await pause();
    await ticks(w);
    assert.deepEqual([(await leg2(w)).state, (await planned2(w)).includes("merge")], ["queued", true], what);
    w.close();
  };

  let w = await started();
  await pushNow(w, "sha2", "ours");
  for (const n of [1, 2]) await w.db.run(w.db.k.insertInto("main.ci_fixes").values({ repo: "app", number: 2, head: "ours", kind: "patch", state: "failed", attempt: n, created_at: new Date().toISOString() }));
  await pause();
  await advanceWorkflows(w.db);
  assert.equal((await liveWorkflow(w.db, "app", 2))!.blocker, "failed-twice");
  await pause();
  assert.equal((await answer(w, "yes")).outcome, "run");
  await owes(w, "failing step");

  w = await started();
  await pushNow(w, "sha2", "ours");
  await w.synced(2, "theirs");
  await w.outOfScope(2, "theirs");
  await advanceWorkflows(w.db);
  assert.equal((await liveWorkflow(w.db, "app", 2))!.blocker, "author-commits");
  await pause();
  assert.equal((await answer(w, "merge")).outcome, "run");
  // The review round's review at the author's head read our push under it: that is the review it owes.
  await (await w.verified(2)).premerge(2, "clean");
  await ticks(w);
  assert.deepEqual([(await leg2(w)).state, (await leg2(w)).head, (await planned2(w)).includes("review")], ["queued", "theirs", false], "under the author's commits");
  w.close();
});

test("a head the author restores is the approved one: the merge goes on and nobody is asked", async () => {
  const w = await approvedReview();
  await w.synced(1, "theirs");
  await advanceWorkflows(w.db);
  const round = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([round.state, round.blocker, round.step], ["running", null, "review new commits"]);
  await w.synced(1, "sha1");
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([wf.state, wf.rec, wf.baseHead, wf.approvedBy, await legState(w)], ["running", null, "sha1", MAINT, "review"]);
});

test("an answer to a question that was asked anew since is refused and shows the new one; a surface that does not say which it showed answers the open one", async () => {
  for (const via of ["dashboard", "agent", "discord", "github"] as const) {
    for (const text of ["yes", "merge"]) {
      const w = await authorPushed();
      const first = (await liveWorkflow(w.db, "app", 2))!;
      await w.synced(2, "theirs2");
      await w.outOfScope(2, "theirs2");
      await advanceWorkflows(w.db);
      const second = (await liveWorkflow(w.db, "app", 2))!;
      assert.equal(second.recHead, "theirs2");
      const send = async (asked: string | null) => (await runCommand(w.db, actor, via, { parsed: parse(text), items: [{ repo: "app", number: 2 }], ...(via === "github" ? { head: "theirs2" } : {}), asked: () => asked })).items[0]!;
      const late = await send(first.recAt);
      assert.equal(late.outcome, "refused", via);
      assert.match(late.line, /A new question follows\. Recommendation: The author pushed/, via);
      assert.deepEqual([(await liveWorkflow(w.db, "app", 2))!.baseHead, late.question], [first.baseHead, { workflowId: second.id, recAt: second.recAt }]);
      assert.equal((await send(text === "yes" ? second.recAt : null)).outcome, "run", via);
      assert.equal((await liveWorkflow(w.db, "app", 2))!.baseHead, "theirs2");
      w.close();
    }
  }
});

test("a fix with the person's words on an approved PR: the fix-up does what they say, as theirs, and the merge stays approved; a model reading gets there too", async () => {
  const item = { repo: "app", number: 2 };
  for (const [text, translated, instruction] of [
    ["fix the UV seam shading with the importer's smooth normals, then merge", null, "the UV seam shading with the importer's smooth normals"],
    ["can you sort out the seam shading the review found and then land it", "fix the seam shading the review found, then merge", "the seam shading the review found"],
  ] as const) {
    const w = await approvedReview();
    await w.pr(2, { label: "feature" });
    assert.equal((await answer(w, "review and merge")).outcome, "run");
    await pause();
    await reviewNow(w, "sha2", "hold");
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ public_review: JSON.stringify({ summary: "Exports recompute normals without welding the vertices split at UV seams.", points: [] }) }).where("number", "=", 2));
    await advanceWorkflows(w.db);
    assert.equal((await liveWorkflow(w.db, "app", 2))!.rec, null);

    const parsed = parse(text, { repo: "app" });
    assert.equal(parsed.kind, translated ? "ambiguous" : "commands", text);
    const o = (await runText(w.db, actor, "dashboard", { parsed, items: [item] }, {
      text, own: [item], named: false, parse: { repo: "app" },
      deps: { translate: async () => (translated ? { command: translated, confidence: 0.9 } : null), score: async () => 0.95 },
    })).items[0]!;
    assert.equal(o.outcome, "run", o.line);
    assert.ok(o.line.includes(`Fixing “${instruction}”, then merging when CI is green`), o.line);
    const made = await w.rows("SELECT instructions, by FROM operator_fixups WHERE number = 2");
    assert.deepEqual(made.map((r) => [r.instructions, r.by]), [[instruction, MAINT]]);
    const now = (await liveWorkflow(w.db, "app", 2))!;
    assert.deepEqual([now.state, now.approvedBy, now.blocker], ["running", MAINT, null]);
    w.close();
  }
});

/** PR 2, nobody started: the person's instructions are pushed as their checked fix-up, sha2 to sha3, and sync sees the push with green CI. */
async function instructed(text: string): Promise<{ w: World; line: string }> {
  const w = await approvedReview();
  await w.pr(2, { label: "feature" });
  const o = await answer(w, text);
  assert.equal(o.outcome, "run", o.line);
  const [fix] = await w.rows("SELECT id, instructions, by FROM operator_fixups WHERE number = 2");
  assert.deepEqual([fix?.instructions, fix?.by], ["the export normals and add a test for empty meshes", MAINT], "the fix-up gets the words as the person's own");
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 2, from_head: "sha2", to_head: "sha3", state: "pushed", files: '["src/export.rs","tests/empty.rs"]', attempt: 1, created_at: later(), source: "operator", operator_fix: fix!.id as number }));
  await w.db.run(w.db.k.insertInto("main.push_outcomes").values({ at: later(), stage: "fixup", action: "fixup-push", repo: "app", number: 2, from_oid: "sha2", to_oid: "sha3", before_res: "green" }));
  await w.synced(2, "sha3");
  await pause();
  return { w, line: o.line };
}

test("fix with instructions on a PR nobody started makes that fix, then merges on green CI with no review of it and no question", async () => {
  const { w, line } = await instructed("fix the export normals and add a test for empty meshes");
  assert.ok(line.includes("then merging when CI is green"), line);
  await ticks(w);
  await (await w.verified(2)).premerge(2, "clean");
  await ticks(w);
  const wf = (await liveWorkflow(w.db, "app", 2))!;
  assert.deepEqual([wf.state, wf.approvedBy, wf.blocker, wf.rec], ["running", MAINT, null, null], "the instructions approved the merge, and nothing asks");
  assert.equal((await leg2(w)).state, "queued", "green CI and a clean pre-merge check at the fixed head hand it to the merge queue");
  assert.ok((await planned2(w)).includes("merge"), "it merges");
  assert.ok(!(await planned2(w)).includes("review"), "the person's checked fix gets no review before the merge");
});

test("fix with instructions but don't merge makes the fix and comes back to the person after its review", async () => {
  const { w, line } = await instructed("fix the export normals and add a test for empty meshes, but don't merge");
  assert.ok(line.includes("then coming back with a recommendation"), line);
  await reviewNow(w, "sha3", "take");
  await ticks(w);
  const wf = (await liveWorkflow(w.db, "app", 2))!;
  assert.deepEqual([wf.state, wf.approvedBy], ["recommending", null], "nobody approved the merge, so it asks");
  assert.ok(!(await planned2(w)).includes("merge"));
});
