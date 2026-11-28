// A person's command is the approval of what it starts: it works in a repo with no merge or push approval, with the pipeline off and
// on an item someone stopped, and a refusal writes nothing. Through the command entry point every surface uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setFeature } from "../src/build/features.ts";
import { recordSteps, startAttempt } from "../src/data/implement/index.ts";
import { loadPrFact } from "../src/core/facts.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { statusDue } from "../src/prstatus/index.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { eventsOf, insertWorkflow, liveWorkflow, updateWorkflow, workflowHistory } from "../src/workflow/store.ts";
import { loadPrWorkflows } from "../src/data/workflow/index.ts";
import { implementMay, implementRefusal, moveTurns } from "../src/implement/gate.ts";
import { setMergeApproval } from "../src/merge/approval.ts";
import { LANES, planCtx } from "../src/runner/autopilot.ts";
import { T0, T1 } from "./world-db.ts";
import { actor, before, fails, implementing, implementJobs, legs8, MAINT, reviewed, run, send, settle, steps, unstarted } from "./workflow-start-world.ts";

test("stop on the PR of an implement workflow halts the issue's workflow, its merge leg and what is queued on the PR, on every surface", async () => {
  for (const via of ["github", "discord", "dashboard", "agent"] as const) {
    const w = await implementing("implement and merge");
    await w.db.run(w.db.k.insertInto("main.operator_fixups").values({ repo: "app", number: 8, from_head: "sha8", instructions: "x", by: MAINT, at: T0 }));
    const r = await runCommand(w.db, actor, via, { parsed: parse(via === "discord" ? "stop: app#8" : "stop"), items: via === "discord" ? [] : [{ repo: "app", number: 8 }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
    assert.match(r.lines[0]!, /app#7: On hold/);
    const [wf] = await workflowHistory(w.db, "app", 7);
    assert.deepEqual([wf!.state, wf!.stoppedBy], ["stopped", MAINT]);
    assert.deepEqual((await legs8(w)).map((l) => l.state), ["cancelled"]);
    assert.deepEqual((await w.rows("SELECT state FROM operator_fixups")).map((x) => x.state), ["ended"]);
    const e = (await eventsOf(w.db, "app", 7)).at(-1)!;
    assert.deepEqual([e.kind, e.workflowId, e.via], ["stopped", wf!.id, via]);
    assert.match(e.line!, /app#8/, "where it was said");
    await w.db.run(w.db.k.updateTable("main.items").set({ url: "https://github.com/storytold/app/issues/7" }).where("number", "=", 7));
    assert.match((await statusDue(w.db, "app")).find((d) => d.number === 7)!.line, /Held by mira/, "the issue's status comment says so");
    assert.deepEqual(await workflowHistory(w.db, "app", 8), [], "the PR gets no workflow");
    assert.equal((await send(w, "stop", 8)).outcome, "refused", "nothing is left running");
    w.close();
  }
});

test("a stop halts the issue's workflow and the one its PR has of its own, from either item", async () => {
  for (const number of [8, 7]) {
    const w = await implementing("implement and merge");
    await insertWorkflow(w.db, { repo: "app", number: 8, kind: "pr", entry: "review", state: "running", startedBy: MAINT, startedAt: T0, startedVia: "dashboard" });
    const o = await send(w, "stop", number);
    assert.equal(o.outcome, "run", o.line);
    assert.match(o.line, new RegExp(`app#${15 - number} is held too`));
    for (const n of [7, 8]) {
      assert.deepEqual((await workflowHistory(w.db, "app", n)).map((x) => x.state), ["stopped"]);
      assert.equal((await eventsOf(w.db, "app", n)).at(-1)!.kind, "stopped");
    }
    assert.deepEqual((await legs8(w)).map((l) => l.state), ["cancelled"]);
    w.close();
  }
});

test("a list that names the issue and its PR stops them once", async () => {
  const w = await implementing("implement and merge");
  const r = await runCommand(w.db, actor, "agent", { parsed: parse("stop: app#8 app#7"), items: [] });
  assert.deepEqual(r.items.map((o) => o.outcome), ["run", "refused"], r.lines.join("\n"));
});

test("an answer, the approval, the weight and a drop on the PR act on the issue's workflow", async () => {
  const w = await implementing("implement");
  const wf = async () => (await liveWorkflow(w.db, "app", 7))!;
  await run(w, "urgent", 8);
  assert.equal((await wf()).weight, 10);
  const rec = { text: "Merge it.", parts: { fix: [], drop: [] }, merges: true };
  await updateWorkflow(w.db, (await wf()).id, { state: "recommending", rec, recAt: T0, recHead: "sha8", plan: [{ n: 1, title: "typo", source: "review", state: "planned" }] });
  const unclear = await send(w, "maybe", 8);
  assert.equal(unclear.outcome, "ambiguous");
  assert.equal((await eventsOf(w.db, "app", 7)).at(-1)!.kind, "ambiguous", "it waits for a clear answer on the issue");
  await run(w, "drop 1, merge", 8);
  const on = await wf();
  assert.deepEqual([on.state, on.rec, on.approvedBy, on.plan[0]!.state], ["running", null, MAINT, "dropped"]);
  assert.deepEqual((await legs8(w)).map((l) => [l.state, l.workflow_id]), [["review", on.id]]);
  assert.equal((await eventsOf(w.db, "app", 7)).at(-1)!.kind, "answered");
  const again = await send(w, "merge", 8);
  assert.deepEqual([again.outcome, /app#7: Already approved/.test(again.line)], ["refused", true], again.line);
});

test("a yes on the PR answers the issue's recommendation, at the head it was made for", async () => {
  const w = await implementing("implement");
  const id = (await liveWorkflow(w.db, "app", 7))!.id;
  const rec = { text: "Merge it.", parts: { fix: [], drop: [] }, merges: true };
  await updateWorkflow(w.db, id, { state: "recommending", rec, recAt: T0, recHead: "older" });
  assert.equal((await send(w, "yes", 8, "sha8")).outcome, "refused");
  await updateWorkflow(w.db, id, { recHead: "sha8" });
  const o = await send(w, "yes", 8, "sha8");
  assert.equal(o.outcome, "run", o.line);
  assert.match(o.line, /app#7: Merging/);
  assert.deepEqual([(await liveWorkflow(w.db, "app", 7))!.approvedBy, (await legs8(w)).map((l) => l.state)], [MAINT, ["review"]]);
});

test("close on the PR of an implement workflow closes the PR and ends the issue's workflow; a stop on either takes the close back", async () => {
  for (const number of [8, 7]) {
    const w = await implementing("implement and merge");
    await run(w, "close", 8);
    assert.deepEqual((await workflowHistory(w.db, "app", 7)).map((x) => x.state), ["closed"]);
    assert.deepEqual((await legs8(w)).map((l) => l.state), ["cancelled"]);
    const closes = async () => (await w.rows("SELECT number, head, state FROM workflow_actions")).map((x) => [x.number, x.head, x.state === "stopped" ? "stopped" : "open"]);
    assert.deepEqual(await closes(), [[8, "sha8", "open"]]);
    await run(w, "stop", number);
    assert.deepEqual(await closes(), [[8, "sha8", "stopped"]]);
    w.close();
  }
});

test("a command resolved on a workflow the pass changed meanwhile runs on what it is now", async () => {
  const w = await unstarted();
  await run(w, "review");
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  const rec = { text: "Merge it.", parts: { fix: [], drop: [] }, merges: true };
  // The pass comes back with a recommendation after the command read the workflow and before it writes.
  before(w.db, () => updateWorkflow(w.db, wf.id, { state: "recommending", rec, recAt: T0, recHead: "sha1" }));
  await run(w, "merge");
  const now = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([now.state, now.rec, now.approvedBy], ["running", null, MAINT]);
  assert.equal((await eventsOf(w.db, "app", 1)).at(-1)!.kind, "answered", "the approval answers the recommendation");
});

test("the PR of a stopped implementation, started on its own, gets the normal fix-up and CI fix; while the issue's work is live its session makes them", async () => {
  const w = await implementing("implement");
  await setFeature(w.db, "implement", true, MAINT, "app");
  await reviewed(w, 8, { verdict: "take-fix" });
  assert.deepEqual(await steps(w, 8), ["implement:revise"]);
  await run(w, "stop", 7);
  await run(w, "fix-up and merge", 8);
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 2000).toISOString() }).where("number", "=", 8));
  assert.deepEqual(await steps(w, 8), ["fixup:fix"]);
  await settle(w);
  assert.deepEqual([(await liveWorkflow(w.db, "app", 8))!.state, (await legs8(w)).at(-1)!.state], ["running", "review"]);

  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ verdict: "take", fixes: null }).where("number", "=", 8));
  await fails(w, 8);
  assert.deepEqual(await steps(w, 8), ["cifix:work"]);
});

test("a revision runs for whoever last answered, approved or started the issue's work and may act; one nobody may run waits visibly and hides no other work", async () => {
  const w = await (await implementing("implement and merge")).issue(9);
  await setFeature(w.db, "implement", true, MAINT, "app");
  await w.acting("ann");
  await reviewed(w, 8, { verdict: "take-fix" });
  const ann: Actor = { login: "ann", canWrite: async () => true };
  const say = async (text: string, number: number) => {
    const o = (await runCommand(w.db, ann, "github", { parsed: parse(text), items: [{ repo: "app", number }] })).items[0]!;
    assert.equal(o.outcome, "run", o.line);
  };
  await say("implement", 9);
  assert.deepEqual(await implementJobs(w), [[7, "revise"], [9, "plan"]], "each issue of the repo has a job of its own");

  await w.db.run(w.db.k.updateTable("main.repo_permissions").set({ permission: "read", checked_at: new Date().toISOString() }).where("login", "=", MAINT));
  assert.deepEqual(await steps(w, 8), []);
  const plan = await w.prPlan(8);
  assert.deepEqual([plan.waitKind, plan.wait?.includes(MAINT)], ["person", true], plan.wait ?? "");
  const issue = implementStep((await loadItemFact(w.db, "app", 7))!);
  assert.ok(issue && "wait" in issue && issue.wait.text.includes(MAINT), JSON.stringify(issue));
  assert.deepEqual(await implementJobs(w), [[9, "plan"]]);

  // The plans may be older than the access they were made on: the job that may not run is passed over.
  const ctx = await planCtx(w.db);
  const p8 = ctx.plans!.prs.find((p) => p.facts.number === 8)!;
  p8.plan.actions.push({ kind: "implement", head: p8.plan.head, params: { bucket: "revise", issue: 7 } });
  assert.deepEqual((await LANES.find((l) => l.name === "implement")!.detect(w.db, ctx)).map((c) => c.params.number), [9]);

  // Another maintainer's yes frees it: the revision, the approval and the next turns are theirs.
  await settle(w);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.state, "blocked");
  await say("yes", 7);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.approvedBy, "ann");
  assert.deepEqual(await steps(w, 8), ["implement:revise"]);
  assert.deepEqual(await implementJobs(w), [[7, "revise"], [9, "plan"]]);
  assert.equal(await implementRefusal(w.db, "app", 7), null);
  assert.deepEqual(await implementMay(w.db, "app", 7), { ok: true, as: "person", by: "ann" });
  await moveTurns(w.db, "app", 7);
  assert.deepEqual(await w.rows("SELECT queued_by FROM implementations"), [{ queued_by: "ann" }]);
});

test("implementing again leaves the PR of stopped work stopped, reopened or not", async () => {
  const w = await implementing("implement");
  await setMergeApproval(w.db, MAINT, "app", true);
  await run(w, "stop", 7);
  // The work ran, was stopped and its PR closed before the next start.
  await w.db.run(w.db.k.updateTable("main.item_workflows").set({ started_at: T0 }).where("number", "=", 7));
  const pr = async (state: string, closed_at: string | null) => void await w.db.run(w.db.k.updateTable("main.items").set({ state, closed_at }).where("number", "=", 8));
  await pr("CLOSED", T1);
  const [a] = await w.rows("SELECT id FROM implementations");
  await recordSteps(w.db, [{ id: Number(a!.id), to: "closed" }], T1);
  const stopped = async () => (await mergeVerdicts(w.db, "app", [{ number: 8, head: "sha8" }])).get(8)!;
  await pr("OPEN", null);
  const was = await stopped();
  assert.equal(was.ok, false);
  await pr("CLOSED", T1);
  await run(w, "implement", 7);
  await pr("OPEN", null);
  assert.deepEqual(await stopped(), was);
  assert.equal((await loadPrFact(w.db, "app", 8))!.endedWorkflow, "stopped");
});

test("a PR whose attempt's end was recorded after the next start is no work of that start once it has its own attempt", async () => {
  const w = await implementing("implement");
  await run(w, "stop", 7);
  await w.db.run(w.db.k.updateTable("main.items").set({ state: "CLOSED", closed_at: T0 }).where("number", "=", 8));
  await run(w, "implement", 7);
  const [a] = await w.rows("SELECT id FROM implementations");
  await recordSteps(w.db, [{ id: Number(a!.id), to: "closed" }]);
  await startAttempt(w.db, { repo: "app", number: 7, queuedBy: MAINT, textHash: "h" });
  await w.db.run(w.db.k.updateTable("main.items").set({ state: "OPEN", closed_at: null }).where("number", "=", 8));
  assert.equal((await loadPrWorkflows(w.db, [{ repo: "app", number: 8 }])).size, 0);
  await run(w, "review", 8);
});

test("a command that names parts by number is not carried out on a plan that was renumbered meanwhile", async () => {
  const w = await unstarted();
  await run(w, "review");
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  const part = (n: number, title: string) => ({ n, title, source: "review" as const, state: "planned" as const });
  await updateWorkflow(w.db, wf.id, { plan: [part(1, "typo"), part(2, "rename")] });
  before(w.db, () => updateWorkflow(w.db, wf.id, { plan: [part(1, "rename"), part(2, "unsound cast")] }));
  const o = await send(w, "drop 2");
  assert.equal(o.outcome, "refused", o.line);
  assert.deepEqual((await liveWorkflow(w.db, "app", 1))!.plan.map((p) => p.state), ["planned", "planned"]);
});

test("an approval on the PR of an implement workflow is not given to a head pushed meanwhile", async () => {
  const w = await implementing("implement");
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  before(w.db, async () => {
    await w.synced(8, "sha8b");
    await updateWorkflow(w.db, wf.id, { weight: 6 });
  });
  const o = await send(w, "merge", 8);
  assert.equal(o.outcome, "refused", o.line);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.approvedBy, null);
});
