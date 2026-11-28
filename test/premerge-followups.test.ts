// An approved merge with green CI stops only at a blocking pre-merge defect; the others become one follow-up issue and the PR merges.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runPremergeFollowups } from "../src/premerge/followups.ts";
import { recommendation, reviewBody } from "../src/review/post-template.ts";
import { runCarry } from "../src/review/carry-step.ts";
import { appLane } from "./acting.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import type { World } from "./world-db.ts";
import { mergesAsPerson, review, reviewed, run, settle, unstarted } from "./workflow-start-world.ts";

const NOT_BLOCKING = { class: null, why: "The empty list fails the same way on the base branch." } as const;
const kinds = async (w: World) => (await w.prPlan(1)).actions.map((a) => (a.kind === "fixup" ? `fixup:${a.params?.source}` : a.kind));
const fixRound = async (w: World) => (await kinds(w)).includes("fixup:premerge");

async function approvedWith(blocking?: { class: "regression" | null; why: string }): Promise<World> {
  const w = await unstarted(false);
  await w.db.run(w.db.k.deleteFrom("main.premerge_reviews"));
  await run(w, "merge");
  await w.premerge(1, "defect", true, "off by one", blocking);
  await settle(w);
  return w;
}

test("a defect that does not block is filed in one follow-up issue before the merge, with no fix-up round or question", async () => {
  const w = await approvedWith(NOT_BLOCKING);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  const due = await kinds(w);
  assert.ok(due.includes("followups") && !due.includes("merge") && !due.includes("fixup:premerge"), due.join(", "));
  const made: string[][] = [];
  const exec = async (_c: string, args: string[]) => { made.push(args); return { code: 0, stdout: args[1] === "create" ? "https://github.com/storytold/app/issues/77\n" : "", stderr: "" }; };
  const deps = { exec, now: () => new Date(), lane: appLane(w.gh.querier) };
  const s = await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps);
  assert.deepEqual(s.filed, ["app#1"]);
  assert.match(made.find((a) => a[1] === "create")!.join(" "), /Follow-ups from #1/);
  // Filed once per head: a second run opens nothing, and the merge goes on as the approver.
  assert.deepEqual((await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps)).filed, []);
  await settle(w);
  await mergesAsPerson(w);
  w.close();
});

test("a filing whose write sends nothing holds the merge for two retries, at 10 and 60 minutes, then fails and the PR merges", async () => {
  const w = await approvedWith(NOT_BLOCKING);
  let tries = 0;
  const exec = async () => { tries++; return { code: 1, stdout: "", stderr: "API rate limit exceeded for installation" }; };
  const deps = { exec, now: () => new Date(), lane: appLane(w.gh.querier) };
  const row = async () => (await w.db.all(w.db.k.selectFrom("main.premerge_followups").select(["state", "note"])))[0];
  // The tries were made `ms` earlier.
  const age = async (ms: number) => {
    const r = (await row())!;
    const shifted = (JSON.parse(r.note!) as string[]).map((t) => new Date(Date.parse(t) - ms).toISOString());
    await w.db.run(w.db.k.updateTable("main.premerge_followups").set({ note: JSON.stringify(shifted), at: shifted.at(-1)! }));
  };
  for (const [wait, n] of [[10, 1], [60, 2]] as const) {
    assert.deepEqual((await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps)).failed, []);
    assert.equal((await row())!.state, "unsent");
    await settle(w);
    const plan = await w.prPlan(1);
    assert.ok(!plan.actions.some((a) => a.kind === "followups" || a.kind === "merge"), `try ${n}: nothing runs during the backoff`);
    assert.equal(plan.waitCode, "followups");
    assert.match(plan.wait ?? "", /did not reach GitHub/);
    await age((wait - 1) * 60_000);
    assert.ok(!(await kinds(w)).includes("followups"), `try ${n}: not before ${wait} minutes`);
    await age(2 * 60_000);
    assert.ok((await kinds(w)).includes("followups"), `try ${n}: due after ${wait} minutes`);
  }
  assert.equal((await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps)).failed.length, 1);
  assert.deepEqual([(await row())!.state, tries], ["failed", 3]);
  await settle(w);
  await mergesAsPerson(w);
  w.close();
});

test("a filing row a restart left in `filing` is tried again after its lease, not counted as filed", async () => {
  const w = await approvedWith(NOT_BLOCKING);
  const head = (await w.prPlan(1)).actions.find((a) => a.kind === "followups")!.head!;
  const left = (at: Date) => w.db.run(w.db.k.insertInto("main.premerge_followups").values({ repo: "app", number: 1, head_oid: head, issue_number: null, url: null, state: "filing", at: at.toISOString(), note: null })
    .onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doUpdateSet({ at: at.toISOString() })));
  await left(new Date());
  await settle(w);
  assert.ok(!(await kinds(w)).includes("followups"), "a filing inside its lease is left alone");
  await left(new Date(Date.now() - 20 * 60_000));
  await settle(w);
  assert.ok((await kinds(w)).includes("followups"), "a filing past its lease is due again");
  const exec = async (_c: string, args: string[]) => ({ code: 0, stdout: args[1] === "create" ? "https://github.com/storytold/app/issues/78\n" : "", stderr: "" });
  const s = await runPremergeFollowups(w.db, { repo: "app" }, () => {}, { exec, now: () => new Date(), lane: appLane(w.gh.querier) });
  assert.deepEqual(s.filed, ["app#1"]);
  w.close();
});

test("a blocking defect, or one stored before defects were classed, gets the automatic fix-up round and files nothing", async () => {
  for (const blocking of [{ class: "regression" as const, why: "Lists that load on the base branch panic." }, undefined]) {
    const w = await approvedWith(blocking);
    assert.equal(await fixRound(w), true, JSON.stringify(blocking));
    assert.equal((await kinds(w)).includes("followups"), false);
    w.close();
  }
});

test("a later head of ours with the same follow-up posts nothing, and its merge goes on", async () => {
  const w = await approvedWith(NOT_BLOCKING);
  const made: string[][] = [];
  const exec = async (_c: string, args: string[]) => { made.push(args); return { code: 0, stdout: args[1] === "create" ? "https://github.com/storytold/app/issues/77\n" : "", stderr: "" }; };
  const deps = { exec, now: () => new Date(), lane: appLane(w.gh.querier) };
  assert.deepEqual((await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps)).filed, ["app#1"]);
  // A push of ours (a base update) moves the head; the new head's pre-merge review finds the same defect.
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: "sha2", state: "pushed", attempt: 1, created_at: new Date().toISOString(), source: "premerge" }));
  await w.synced(1, "sha2");
  await review(w, "sha2");
  await (await w.verified(1)).premerge(1, "defect", true, "off by one", NOT_BLOCKING);
  await settle(w);
  assert.ok((await kinds(w)).includes("followups"));
  const posts = made.length;
  const s = await runPremergeFollowups(w.db, { repo: "app" }, () => {}, deps);
  assert.deepEqual([s.repeated, made.length], [["app#1"], posts]);
  await settle(w);
  await mergesAsPerson(w, "sha2");
  w.close();
});

type Fix = { file: string; change: string; title: string; major?: boolean; blocking: { class: "regression" | null; why: string } };
const NOT_BLOCKING_FIX: Fix = { file: "src/lib.rs", change: "rename a to b", title: "Clearer name", major: true, blocking: { class: null, why: "The old name works the same as on the base branch." } };
const BLOCKING_FIX: Fix = { file: "src/io.rs", change: "check the bound", title: "Bound check", blocking: { class: "regression", why: "Empty lists that load on the base branch panic." } };

/** A review-and-merge start whose review at `head` is the one given (newer than the start). */
async function approvedReview(o: { head?: string; verdict: "take-fix" | "hold"; fixes?: Fix[]; hold?: string; blockedBy?: string[]; w?: World }): Promise<World> {
  let w = o.w;
  if (!w) {
    w = await unstarted(false);
    await run(w, "review and merge");
    await settle(w);
  }
  const head = o.head ?? "sha1";
  await reviewed(w, 1, { head, verdict: o.verdict, sure: false, fixes: o.fixes ?? [] });
  const workflow = { outside_purpose: null, recommendation: null, ...(o.hold ? { hold: { class: null, why: o.hold } } : {}) };
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ workflow: JSON.stringify(workflow), blocked_by: JSON.stringify(o.blockedBy ?? []) }).where("head_oid", "=", head));
  await settle(w);
  return w;
}

/** Runs the follow-up step once; returns its summary and the bodies it posted. */
async function file(w: World) {
  const bodies: string[] = [];
  const exec = async (_c: string, args: string[], o?: { input?: string }) => { bodies.push(o?.input ?? ""); return { code: 0, stdout: args[1] === "create" ? "https://github.com/storytold/app/issues/77\n" : "", stderr: "" }; };
  const s = await runPremergeFollowups(w.db, { repo: "app" }, () => {}, { exec, now: () => new Date(), lane: appLane(w.gh.querier) });
  return { s, posted: bodies.join("\n") };
}

/** Our own push of the review's fix-up, from `from` to `to`. */
async function ourPush(w: World, from: string, to: string): Promise<void> {
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: from, to_head: to, state: "pushed", attempt: 1, created_at: new Date().toISOString(), source: "review" }));
  await w.synced(1, to);
  await settle(w);
}

test("on an approved PR, a review whose fixes all do not block runs no fix-up and stops nothing: the fixes are filed and the PR merges", async () => {
  const w = await approvedReview({ verdict: "take-fix", fixes: [NOT_BLOCKING_FIX] });
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  const due = await kinds(w);
  assert.ok(due.includes("followups") && !due.includes("fixup:review") && !due.includes("merge"), due.join(", "));
  const { s, posted } = await file(w);
  assert.deepEqual(s.filed, ["app#1"]);
  assert.match(posted, /Clearer name/);
  await settle(w);
  await mergesAsPerson(w);
  w.close();
});

test("on an approved PR, a blocking fix runs the fix-up, and the fix beside it is filed once that push moved the head", async () => {
  const w = await approvedReview({ verdict: "take-fix", fixes: [BLOCKING_FIX, NOT_BLOCKING_FIX] });
  assert.ok((await kinds(w)).includes("fixup:review"), (await kinds(w)).join(", "));
  // The fix-up pushes before the follow-up step runs; the new head is not reviewed yet.
  await ourPush(w, "sha1", "sha2");
  const plan = await w.prPlan(1);
  assert.ok(plan.actions.some((a) => a.kind === "followups" && a.head === "sha2" && a.params?.reviewHead === "sha1"), JSON.stringify(plan.actions));
  const { s, posted } = await file(w);
  assert.deepEqual(s.filed, ["app#1"]);
  assert.match(posted, /Clearer name/);
  assert.doesNotMatch(posted, /Bound check/);
  assert.equal((await kinds(w)).includes("followups"), false);
  w.close();
});

/** Our checked fix-up of the review's fixes, sha1 to sha2, started at `at`, and the carry it allows, dated after the review. */
async function carriedFixup(w: World, at = new Date().toISOString()): Promise<void> {
  await w.db.run(w.db.k.insertInto("main.patch_checks").values({ kind: "fixup", repo: "app", number: 1, subject: "sha1", patch_hash: "x", round: 1, verdict: "approve", reasons: "", problems: "[]", model: "m", created_at: at }));
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: "sha2", state: "pushed", attempt: 1, created_at: at, source: "review" }));
  await w.synced(1, "sha2");
  await settle(w);
  assert.equal(await runCarry(w.db, "app", () => {}), 1);
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 2000).toISOString() }).where("head_oid", "=", "sha2"));
  await settle(w);
}

test("the fix that does not block beside a blocking one is filed when the carry wrote the fix-up's head before the filing ran, unless the fix-up started before the approval", async () => {
  const w = await approvedReview({ verdict: "take-fix", fixes: [BLOCKING_FIX, NOT_BLOCKING_FIX] });
  await carriedFixup(w);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "followups" && a.params?.reviewHead === "sha2"), (await kinds(w)).join(", "));
  const { s, posted } = await file(w);
  assert.deepEqual(s.filed, ["app#1"]);
  assert.match(posted, /Clearer name/);
  assert.doesNotMatch(posted, /Bound check/);
  await settle(w);
  assert.equal((await kinds(w)).includes("followups"), false);
  w.close();

  // A fix-up started before the approval made every fix: nothing is left to file.
  const early = await approvedReview({ verdict: "take-fix", fixes: [BLOCKING_FIX, NOT_BLOCKING_FIX] });
  await carriedFixup(early, "2026-01-01T00:00:00.000Z");
  assert.equal((await kinds(early)).includes("followups"), false);
  early.close();
});

test("a filing that sent nothing before the carry is tried again at the reviewed head after its backoff, and the carried head owes none after it", async () => {
  const w = await approvedReview({ verdict: "take-fix", fixes: [BLOCKING_FIX, NOT_BLOCKING_FIX] });
  const unsent = async () => ({ code: 1, stdout: "", stderr: "API rate limit exceeded for installation" });
  await runPremergeFollowups(w.db, { repo: "app" }, () => {}, { exec: unsent, now: () => new Date(), lane: appLane(w.gh.querier) });
  await carriedFixup(w);
  assert.equal((await kinds(w)).includes("followups"), false, "not before the backoff");
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  await w.db.run(w.db.k.updateTable("main.review_followups").set({ note: JSON.stringify([old]), at: old }));
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "followups" && a.params?.reviewHead === "sha1"), (await kinds(w)).join(", "));
  const { s, posted } = await file(w);
  assert.deepEqual(s.filed, ["app#1"]);
  assert.match(posted, /Clearer name/);
  await settle(w);
  assert.equal((await kinds(w)).includes("followups"), false);
  w.close();
});

test("each hold that does not block an approved PR is filed with its own reason, and one that waits for another item stops it", async () => {
  const w = await approvedReview({ verdict: "hold", hold: "Whether the menu should keep its old order is a design choice." });
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  assert.match((await file(w)).posted, /old order/);
  await ourPush(w, "sha1", "sha2");
  await approvedReview({ w, head: "sha2", verdict: "hold", hold: "The shortcut label is not translated yet." });
  const second = await file(w);
  assert.deepEqual(second.s.commented, ["app#1"]);
  assert.match(second.posted, /shortcut label/);

  const blocked = await approvedReview({ verdict: "hold", hold: "Stacked on another pull request.", blockedBy: ["app#2"] });
  const due = await kinds(blocked);
  assert.ok(!due.includes("followups") && !due.includes("merge"), due.join(", "));
  w.close();
  blocked.close();
});

test("the posted review of an approved PR tells the fixes made before the merge from the follow-ups, and with none to make says nothing blocks it", () => {
  const post = (fixes: string[]) => {
    const followUps = { fixes, later: ["Clearer name"] };
    const rec = recommendation({ verdict: "take-fix", queue: null, mergeApproved: true, canPush: false, followUps: { blocking: fixes.length, later: 1, filed: true } });
    return reviewBody({ verdict: "take-fix", sure: true, summary: "S.", points: ["P."], head: "abc1234", recommendation: rec, followUps });
  };
  const none = post([]), some = post(["Check the bound"]);
  assert.match(none, /^Nothing found that blocks the approved merge:/);
  assert.doesNotMatch(none, /Small fixes needed|after the fixes above/);
  assert.match(none, /Follow-ups, to be filed as an issue:\n- Clearer name[\s\S]*\nRecommendation: merge after CI and checks pass/);
  assert.match(some, /^Small fixes needed:[\s\S]*Fixes before the merge:\n- Check the bound\n\nFollow-ups, to be filed as an issue:\n- Clearer name[\s\S]*\nRecommendation: merge after the fixes above; the follow-ups/);
});

test("an approved PR with a carried pre-merge review files the review's code-incomplete claim that no fix covers, and not the one our fix-up made", async () => {
  const w = await unstarted(false);
  await run(w, "fix-up");
  await settle(w);
  // The review at sha1: one claim names no fix; the other's fix is the review's own fix, which our fix-up makes before the approval.
  const made = { file: "src/open.rs", change: "queue the panel's documents too" };
  const claim = (text: string, fix?: typeof made) => ({ claim: text, status: "contradicted", evidence: "src/open.rs:88 orders the queue", impact: "code-incomplete", ...(fix ? { fix } : {}) });
  const fixes: Fix[] = [{ ...made, title: "Queue the panel", blocking: { class: null, why: "The other paths open as on the base branch." } }];
  await reviewed(w, 1, { head: "sha1", verdict: "take-fix", fixes });
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ claims: JSON.stringify([claim("documents open in request order"), claim("the panel keeps the order", made)]) }));
  await settle(w);
  await ourPush(w, "sha1", "sha2");
  // The verdict carries over the checked fix-up, and so does the pre-merge review: no model reads sha2.
  await w.db.run(w.db.k.insertInto("main.opus_reviews").values({ repo: "app", number: 1, head_oid: "sha2", run_id: "carry", at: new Date(Date.now() + 2000).toISOString(), model: "carried", mode: "carried", base_head: "sha1", verdict: "take", reason: "carried from sha1", sure: 1 }));
  await (await w.verified(1)).premerge(1, "clean");
  await w.db.run(w.db.k.updateTable("main.premerge_reviews").set({ model: "carried" }).where("head_oid", "=", "sha2"));
  await settle(w);
  await run(w, "merge");
  await settle(w);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "followups" && a.params?.source === "review"), (await kinds(w)).join(", "));
  const { s, posted } = await file(w);
  assert.deepEqual(s.filed, ["app#1"]);
  assert.match(posted, /documents open in request order/);
  assert.doesNotMatch(posted, /panel keeps the order/);
  await settle(w);
  assert.equal((await kinds(w)).includes("followups"), false);
  await mergesAsPerson(w, "sha2");
  w.close();
});
