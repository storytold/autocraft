// A person's command is the approval of what it starts: it works in a repo with no merge or push approval, with the pipeline off and
// on an item someone stopped, and a refusal writes nothing. Through the command entry point every surface uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recommendationText } from "../src/workflow/status.ts";
import { liveWorkflow, updateWorkflow } from "../src/workflow/store.ts";
import { selectFixups } from "../src/fixup/select.ts";
import { T0 } from "./world-db.ts";
import { acts, baseMerged, conflicting, conflictRow, MAINT, mergesAsPerson, pushRecorded, reviewed, run, send, settle, unstarted } from "./workflow-start-world.ts";

test("an approved start of a conflicting PR says who settles the conflict, before any review of it", async () => {
  for (const [canModify, text] of [[false, /until (the contributor|someone) resolves the conflict/], [true, /AutoCraft merges that branch into it first/]] as const) {
    for (const start of ["merge", "review and merge", "fix-up and merge"]) {
      const w = await unstarted(false);
      await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main", mergeable: "CONFLICTING", maintainer_can_modify: canModify ? 1 : 0 }).where("number", "=", 1));
      await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING", maintainer_can_modify: canModify ? 1 : 0 }));
      const o = await send(w, start);
      assert.equal(o.outcome, "run", o.line);
      assert.match(o.line, text, start);
      w.close();
    }
    // Nothing to say without the approval.
    const w = await unstarted(false);
    await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main", mergeable: "CONFLICTING" }).where("number", "=", 1));
    assert.doesNotMatch((await send(w, "review")).line, /conflict/);
    w.close();
  }
});

test("the recommendation on a conflicting PR runs on a yes: the merge is approved, the base is merged in, then the fixes nobody dropped are made", async () => {
  const fixes = [{ file: "src/lib.rs", change: "rename a to b", title: "rename a" }, { file: "src/lib.rs", change: "drop the copy", title: "drop the copy" }];
  for (const text of ["yes", "fix 1, drop 2, merge", "fix-up and merge", "drop 2"]) {
    const w = await unstarted(false);
    await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1));
    await run(w, "review");
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING" }));
    await reviewed(w, 1, { verdict: "take-fix", fixes });
    await settle(w);
    const rec = (await liveWorkflow(w.db, "app", 1))!;
    assert.equal(rec.state, "recommending");
    assert.match(rec.rec!.text, /conflicts/);
    await run(w, text);
    await settle(w);
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.approvedBy], ["running", MAINT], `${text}: ${JSON.stringify(wf.rec)}`);
    assert.ok((await acts(w, 1)).includes("conflict:merge"), `${text}: ${await acts(w, 1)}`);
    assert.deepEqual((await w.rows("SELECT state FROM preapprovals")).map((l) => l.state), ["review"], text);

    // The base is merged in; the review of the new head asks for the same.
    await w.db.run(w.db.k.insertInto("main.conflict_merges").values({ repo: "app", number: 1, from_head: "sha1", to_head: "sha1b", base_sha: "base", state: "merged", attempt: 1, created_at: new Date().toISOString(), own_diff: "same" }));
    await pushRecorded(w);
    // The mirror does not show the push yet: the leg waits for it.
    await settle(w);
    assert.deepEqual([(await liveWorkflow(w.db, "app", 1))!.state, ...(await w.rows("SELECT state FROM preapprovals")).map((l) => l.state)], ["running", "review"], text);
    await w.synced(1, "sha1b");
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ fetched_at: new Date().toISOString() }));
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: T0 }));
    await w.review(1, { verdict: "take-fix", fixes, head: "sha1b" });
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 1000).toISOString() }).where("head_oid", "=", "sha1b"));
    await settle(w);
    assert.deepEqual(await acts(w, 1), ["fixup:fix"], text);
    const drop = text.includes("drop");
    assert.deepEqual((await selectFixups(w.db, "app")).fix.map((c) => c.fixes.map((f) => f.change)), [fixes.slice(0, drop ? 1 : 2).map((f) => f.change)], text);

    if (drop) {
      // With every fix dropped the review asks for nothing more.
      await updateWorkflow(w.db, wf.id, { plan: (await liveWorkflow(w.db, "app", 1))!.plan.map((p) => ({ ...p, state: "dropped" as const })) });
      await settle(w);
      assert.deepEqual(await acts(w, 1).then((a) => a.filter((x) => x.startsWith("fixup"))), []);
      assert.equal((await w.rows("SELECT state FROM preapprovals"))[0]!.state, "ci");
    }
    w.close();
  }
});

test("a yes on a conflicting PR with nothing to fix approves the merge, and the leg goes on until the base is merged in, whatever CI says", async () => {
  for (const ci of ["success", "pending", "failure", "none"]) {
    const w = await unstarted(false);
    await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1));
    await run(w, "review");
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING", overall: ci }));
    await reviewed(w, 1, { verdict: "take" });
    await settle(w);
    assert.equal((await liveWorkflow(w.db, "app", 1))!.rec?.text, "It conflicts with its base branch. Merge it.", ci);
    await run(w, "yes");
    await settle(w);
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.approvedBy], ["running", MAINT], `${ci}: ${wf.rec?.text}`);
    assert.deepEqual((await w.rows("SELECT state, reason FROM preapprovals")).map((l) => l.state), ["ci"], ci);
    assert.ok((await acts(w, 1)).includes("conflict:merge"), `${ci}: ${await acts(w, 1)}`);
    await w.db.run(w.db.k.insertInto("main.conflict_merges").values({ repo: "app", number: 1, from_head: "sha1", to_head: "sha1b", base_sha: "base", state: "merged", attempt: 1, created_at: new Date().toISOString(), own_diff: "same" }));
    await pushRecorded(w);
    await settle(w);
    assert.deepEqual([(await liveWorkflow(w.db, "app", 1))!.state, ...(await w.rows("SELECT state FROM preapprovals")).map((l) => l.state)], ["running", "ci"], ci);
    await w.synced(1, "sha1b");
    await settle(w);
    assert.deepEqual(await w.rows("SELECT state, head FROM preapprovals"), [{ state: "review", head: "sha1b" }], ci);
    w.close();
  }
});

test("a recommendation on a conflicting PR offers nothing that is refused", async () => {
  for (const verdict of ["take-fix", "hold"] as const) {
    const w = await unstarted(false);
    await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1));
    await run(w, "review");
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING" }));
    await reviewed(w, 1, { verdict, fixes: [{ file: "src/lib.rs", change: "rename a to b" }] });
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ workflow: JSON.stringify({ outside_purpose: null, recommendation: { text: "Fix 1 first.", fix: [1], merge: false, close: false } }) }));
    await settle(w);
    const { rec, state } = (await liveWorkflow(w.db, "app", 1))!;
    assert.equal(state, "recommending", verdict);
    // A hold's fix is made on a yes, with the base merged in first: never another review of the same head.
    assert.deepEqual([rec!.parts.fix, rec!.merges, rec!.again ?? null], verdict === "hold" ? [[1], false, null] : [[1], true, null], rec!.text);
    assert.equal(rec!.text.match(/conflicts with its base branch/g)?.length, 1, rec!.text);
    await run(w, "yes");
    await settle(w);
    assert.ok((await acts(w, 1)).includes("conflict:merge"), `${verdict}: ${await acts(w, 1)}`);
    w.close();
  }
});

test("a yes on a conflict only the contributor can resolve approves the merge and waits for it to be resolved: it claims no merge, asks nothing again and goes on once the conflict is gone", async () => {
  for (const verdict of ["take", "take-fix"] as const) for (const asked of [false, true]) {
    const w = await conflicting({ verdict, canModify: false, before: async (w) => { if (asked) await conflictRow(w, "sha1", "asked"); } });
    const rec = (await liveWorkflow(w.db, "app", 1))!;
    assert.equal(rec.state, "recommending");
    assert.match(recommendationText(rec.rec!), /contributor has to resolve.*the merge is approved and waits/);
    const yes = await send(w, "yes");
    assert.equal(yes.outcome, "run", yes.line);
    assert.match(yes.line, /until the contributor resolves the conflict/);
    assert.doesNotMatch(yes.line, /merging when|fixing/i);
    await settle(w);
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.approvedBy, wf.rec], ["running", MAINT, null], verdict);
    const legs = await w.rows("SELECT state FROM preapprovals");
    assert.deepEqual(legs.map((l) => l.state), [verdict === "take" ? "ci" : "review"], verdict);
    // The merge is approved: a person settles the conflict, and the approver, who answered at this head, is asked nothing again.
    if (asked) assert.equal((await w.prPlan(1)).waitCode, "conflict-person");
    else assert.ok((await acts(w, 1)).includes("conflict:ask"));

    // The base branch no longer conflicts: the approval stands and the leg goes on.
    if (verdict === "take") {
      await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "MERGEABLE" }));
      await settle(w);
      await mergesAsPerson(w);
    }
    w.close();
  }
});

test("on a conflicting PR whose base merges of today are used up, a yes approves the merge, which lifts the daily cap: the base is merged in at once", async () => {
  const now = new Date().toISOString();
  const w = await conflicting({ verdict: "take-fix", before: async (w) => { for (const from of ["old1", "old2"]) await conflictRow(w, from, "merged", { to_head: `${from}b`, at: now }); } });
  assert.doesNotMatch((await liveWorkflow(w.db, "app", 1))!.rec!.text, /tomorrow/);
  assert.doesNotMatch((await send(w, "yes")).line, /tomorrow/);
  await settle(w);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  assert.ok((await acts(w, 1)).includes("conflict:merge"));
});

test("the fix-up of the pre-merge review's findings AutoCraft asked for on a PR that comes to conflict is kept: the base is merged in, then the fix-up is made at the new head", async () => {
  const w = await conflicting({ verdict: "take" });
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "MERGEABLE" }));
  await w.db.run(w.db.k.deleteFrom("main.premerge_reviews"));
  await w.premerge(1, "defect");
  // The fix-up rounds of the pre-merge review are spent.
  await w.premergeRoundsSpent(1);
  await run(w, "merge");
  await settle(w);
  const fixing = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([fixing.state, fixing.rec], ["running", null], "the approved merge asks nothing: the fix-up is asked for");
  assert.deepEqual((await w.rows("SELECT from_head, state FROM operator_fixups")).map((r) => [r.from_head, r.state]), [["sha1", "queued"]]);
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING" }));
  await settle(w);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  assert.deepEqual(await acts(w, 1), ["conflict:merge"]);

  await baseMerged(w);
  await settle(w);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  assert.deepEqual((await w.rows("SELECT from_head, state FROM operator_fixups")).map((r) => [r.from_head, r.state]), [["sha1b", "queued"]]);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.head === "sha1b" && a.params?.source === "operator"), JSON.stringify(await w.prPlan(1)));
  assert.match(String((await w.rows("SELECT instructions FROM operator_fixups"))[0]!.instructions), /off by one/);
});

test("a yes to fix a major finding on a conflicting PR is not asked again when the review of the merged head names it too", async () => {
  const fixes = [{ file: "src/lib.rs", change: "check the bound", title: "check the bound", major: true }];
  const w = await conflicting({ verdict: "take-fix", fixes });
  await run(w, "yes");
  await settle(w);
  assert.deepEqual(await acts(w, 1), ["conflict:merge"]);
  await baseMerged(w);
  await w.review(1, { verdict: "take-fix", fixes, head: "sha1b" });
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 2000).toISOString() }).where("head_oid", "=", "sha1b"));
  await settle(w);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.equal(wf.state, "running", wf.rec?.text ?? "");
  assert.deepEqual((await w.rows("SELECT from_head, state FROM operator_fixups")).map((r) => [r.from_head, r.state]), [["sha1b", "queued"]]);
  assert.deepEqual(await acts(w, 1), ["fixup:fix"]);
});
