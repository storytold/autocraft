// A started item never waits on a person unasked (src/workflow/ask.ts): each person wait of its plan, and an approver who lost access, comes
// back as one question; a yes to it runs something and does not bring the same question back.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { needsQuestion } from "../src/core/codes.ts";
import { decidePr, worksOn } from "../src/core/decide.ts";
import { startAttempt } from "../src/data/implement/index.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { textHash } from "../src/core/open-prs.ts";
import type { PrChecks } from "../src/review/checks.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { noteMergeable, unknownOf } from "../src/merge/mergeable.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { questionFor, waitCloses } from "../src/workflow/ask.ts";
import { parse } from "../src/workflow/parse.ts";
import { resolve } from "../src/workflow/resolve.ts";
import { yesClause } from "../src/workflow/status.ts";
import { eventsOf, liveWorkflow } from "../src/workflow/store.ts";
import type { ItemWorkflow } from "../src/workflow/types.ts";
import { legWait } from "../src/workflow/waits.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import { setFeature } from "../src/build/features.ts";
import { savePremerge } from "../src/premerge/store.ts";
import { factsOf, prng, randomPrRows, rnd } from "./random-pr.ts";
import { OPERATOR, T0, T1, untilQuiet, world, type World } from "./world-db.ts";

const MAINT = "mira", ANN = "ann";
let current: World | undefined;
afterEach(() => current?.close());

const pause = () => new Promise((r) => setTimeout(r, 5));
const say = async (w: World, text: string, by = MAINT, number = 1) => {
  await pause();
  const actor: Actor = { login: by, canWrite: async () => true };
  const o = (await runCommand(w.db, actor, "github", { parsed: parse(text), items: [{ repo: "app", number }] })).items[0]!;
  assert.equal(o.outcome, "run", o.line);
  return o.line;
};
const settle = (w: World) => untilQuiet(w.db, [() => advanceWorkflows(w.db), () => advancePreapprovals(w.db)], 5);
const wf = async (w: World, number = 1) => (await liveWorkflow(w.db, "app", number))!;
const leg = async (w: World) => (await w.rows("SELECT state FROM preapprovals ORDER BY id DESC"))[0]?.state;
const shown = async (w: World, number = 1) => { const x = await wf(w, number); return [x.state, x.blockerParams?.code ?? null, x.approvedBy]; };
const actions = async (w: World) => (await w.prPlan(1)).actions.map((a) => a.kind);

/** A PR with a take review, green CI and a clean pre-merge review, `text` said on it by MAINT. */
async function started(text: string, o: { review?: boolean } = {}, author?: string): Promise<World> {
  const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT, ANN);
  if (author) await w.db.run(w.db.k.insertInto("settings").values({ key: "pipeline_login", value: author }));
  await w.pr(1, { label: "feature", ...(author ? { author } : {}) });
  await (await w.verified(1)).premerge(1, "clean");
  await say(w, text);
  if (o.review !== false) {
    await w.review(1);
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }));
  }
  await settle(w);
  return w;
}
const loseAccess = async (w: World, login = MAINT) =>
  void await w.db.run(w.db.k.updateTable("main.repo_permissions").set({ permission: "read", checked_at: new Date().toISOString() }).where("login", "=", login));

test("a person wait of a started PR has a question that a yes runs, unless its person acts elsewhere", () => {
  const seed = process.env.INVARIANT_SEED ? Number(process.env.INVARIANT_SEED) : (Date.now() & 0x7fffffff);
  const x = rnd(prng(seed));
  let asked = 0;
  for (let i = 0; i < 6_000; i++) {
    const rows = randomPrRows(x), f = factsOf(rows);
    const w = f.may.workflow;
    if (!f.workflow || w?.state !== "running" || !f.inScope || f.ghState !== "OPEN") continue;
    const p = decidePr(f), approved = w.approvedBy !== null;
    const q = questionFor(f, p, { approved, review: null, parts: [], conflict: null });
    const at = `INVARIANT_SEED=${seed}: ${JSON.stringify({ code: p.waitCode, who: p.waitKind, state: p.state, approved, q })}`;
    const refused = (a: (typeof p.actions)[number]) => (a.permission && !a.permission.ok ? a.permission.why : null);
    const busy = p.actions.some((a) => worksOn(a) && (refused(a)?.who !== "person" || refused(a)?.code === "blocked"));
    const gone = f.standing?.merge?.standing === "no" || f.standing?.work?.standing === "no" || !!f.mergeLacksAccess;
    const own = p.waitCode === "implement-stuck" || p.waitCode === "implement-question" || (approved && p.state === "opus-hold");
    if (!gone && !busy && !own && p.waitCode && needsQuestion(p.waitCode, p.waitKind!, approved)) assert.ok(q, at);
    if (!q) continue;
    asked++;
    if (!gone && p.state !== "opus-close" && p.state !== "opus-hold") assert.ok(p.waitCode && needsQuestion(p.waitCode, p.waitKind!, approved) && !busy, at);
    assert.ok(yesClause(q.rec), at);
    assert.equal(approved && !q.rec.merges, false, at);
    // Asking stops an approved PR's merge leg: a question kept with only its wait may close then only where the plan, with the leg gone
    // and the question closed, would come back with that same wait; else the leg starts again without a yes and asks again, in a loop.
    if (approved && q.rec.cause?.code === "wait") {
      const wait = q.rec.cause.wait, after = factsOf({ ...rows, legs: [], workflow: { ...rows.workflow!, state: "running", blocker: null } });
      const again = questionFor(after, decidePr(after), { approved, review: null, parts: [], conflict: null });
      assert.ok(again?.params.code === wait || !waitCloses(wait, true), at);
    }
    const row = { entry: w.entry, state: approved ? "blocked" : "recommending", approvedBy: w.approvedBy, plan: [], rec: q.rec, blocker: q.blocker } as unknown as ItemWorkflow;
    const r = resolve({ kind: "yes", items: [] }, { kind: "pr", workflow: row });
    assert.ok(r.kind === "run" && (r.run.again || r.run.merges || r.run.goesOn || r.run.end || r.run.fix.length), at);
  }
  assert.ok(asked > 50, `only ${asked} questions came up`);
});

test("an approver who lost access is asked for, wherever the merge is; another maintainer's yes takes their place", async () => {
  for (const at of ["review", "ci", "queued"] as const) {
    const w = await started("review and merge", { review: at !== "review" });
    if (at === "ci") {
      await w.db.run(w.db.k.updateTable("main.preapprovals").set({ state: "ci" }));
      await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "pending" }));
    }
    assert.equal(await leg(w), at);
    await loseAccess(w);
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", "actor-gone", MAINT], at);
    assert.match((await wf(w)).rec!.text, new RegExp(MAINT));
    assert.equal(await leg(w), "cancelled", at);
    await say(w, "yes", ANN);
    await settle(w);
    assert.deepEqual(await shown(w), ["running", null, ANN], at);
    assert.equal(await leg(w), at, at);
    w.close();
  }
});

test("a merge that could not be made as its approver is asked for, and their own yes tries it again; one that waits for a sign-in is not", async () => {
  for (const [state, code] of [["waiting-permission", "actor-gone"], ["waiting-token", null]] as const) {
    const w = await started("review and merge");
    assert.equal(await leg(w), "queued");
    const row = await wf(w), at = new Date().toISOString();
    await w.db.run(w.db.k.insertInto("main.workflow_actions").values({ workflow_id: row.id, repo: "app", number: 1, kind: "merge", by: MAINT, head: "sha1", state, reason: "no write access", created_at: at, updated_at: at }));
    await settle(w);
    assert.deepEqual(await shown(w), [code ? "blocked" : "running", code, MAINT]);
    if (code) {
      await say(w, "yes");
      await settle(w);
      assert.deepEqual(await shown(w), ["running", null, MAINT]);
      assert.ok((await actions(w)).includes("merge"));
    }
    w.close();
  }
});

test("started work whose person lost access is asked for before anything merges, and goes on for whoever says yes", async () => {
  const w = await started("fix-up", { review: false });
  await loseAccess(w);
  await settle(w);
  const x = await wf(w);
  assert.deepEqual([x.state, x.rec?.merges, x.rec?.goes], ["recommending", false, "on"]);
  await say(w, "yes", ANN);
  await settle(w);
  assert.deepEqual([(await wf(w)).state, (await wf(w)).approvedBy], ["running", null]);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "review" && a.permission?.ok));
});

test("a PR that failed alone in a batch is not merged until a yes, which merges it without asking again; screenshots that show a regression get a fix-up instead", async () => {
  for (const what of ["batch-failed", "screenshots"] as const) {
    const w = await started("review and merge");
    assert.equal(await leg(w), "queued");
    await pause();
    const at = new Date().toISOString();
    if (what === "batch-failed") {
      const id = Number((await w.db.get(w.db.k.insertInto("main.merge_batches").values({ repo: "app", branch: "b", base_sha: "b", commit_sha: "c", state: "failed", summary: "a test fails", created_at: at, updated_at: at }).returning("id")))!.id);
      await w.db.run(w.db.k.insertInto("main.merge_batch_prs").values({ batch_id: id, number: 1, head_oid: "sha1", position: 0 }));
    } else await w.db.run(w.db.k.insertInto("main.screenshot_runs").values({ repo: "app", number: 1, head_sha: "sha1", state: "compared", verdict: "regression", clear: 1, held: 1, comparison: "The handles moved.", created_at: at, finished_at: at }));
    assert.ok(!(await actions(w)).includes("merge"), what);
    if (what === "screenshots") assert.equal((await mergeVerdicts(w.db, "app", [{ number: 1, head: "sha1" }], { batch: true })).get(1)!.ok, false, "a batch that holds it goes on without it");
    await settle(w);
    if (what === "screenshots") {
      assert.deepEqual([(await wf(w)).state, (await wf(w)).rec], ["running", null], "no question");
      assert.ok((await w.rows("SELECT instructions FROM operator_fixups WHERE number = 1")).some((r) => /regression/.test(String(r.instructions))));
      assert.ok(!(await actions(w)).includes("merge"));
      w.close();
      continue;
    }
    assert.deepEqual(await shown(w), ["blocked", what, MAINT]);
    await say(w, "yes", ANN);
    await settle(w);
    assert.deepEqual([...await shown(w), await leg(w)], ["running", null, MAINT, "queued"], what);
    assert.ok((await actions(w)).includes("merge"), what);
    w.close();
  }
});

test("a regression in the screenshots keeps a PR nobody started off the merge rule", async () => {
  const w = current = await (await world()).repo();
  await (await (await (await w.pr(1)).review(1)).verified(1)).premerge(1, "clean");
  assert.ok((await actions(w)).includes("merge"));
  await w.db.run(w.db.k.insertInto("main.screenshot_runs").values({ repo: "app", number: 1, head_sha: "sha1", state: "compared", verdict: "regression", clear: 1, held: 1, comparison: "The handles moved.", created_at: T1, finished_at: T1 }));
  const p = await w.prPlan(1);
  assert.deepEqual([p.actions.some((a) => a.kind === "merge"), p.waitCode, p.waitKind], [false, "screenshots", "person"]);
});

const checks = (w: World, set: { overall?: string; mergeable?: string }) => w.db.run(w.db.k.updateTable("main.pr_checks").set(set).where("number", "=", 1));
/** What a person settles on GitHub: how it comes about, and how it is settled there. */
const ON_GITHUB = {
  "base-off-default": {
    cause: async (w: World) => {
      await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "release" }).where("number", "=", 1));
      await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ base_ref: "release" }));
    },
    settle: (w: World) => w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1)),
  },
  "no-ci": { cause: (w: World) => checks(w, { overall: "none" }), settle: (w: World) => checks(w, { overall: "success" }) },
  "mergeable-stuck": {
    cause: async (w: World) => {
      await checks(w, { mergeable: "UNKNOWN" });
      await w.db.run(w.db.k.insertInto("main.merge_state").values({ repo: "app", number: 1, head: "sha1", since: T0, reads: 9, rereads: 3, stuck: 1 }));
    },
    settle: (w: World) => checks(w, { mergeable: "MERGEABLE" }),
  },
  "ci-approval-failed": {
    cause: (w: World) => w.db.run(w.db.k.insertInto("main.ci_run_approvals").values({ repo: "app", number: 1, head_oid: "sha1", cross_repo: 1, runs: JSON.stringify([{ id: 7, event: "pull_request" }]), approved: "[]", failed: JSON.stringify({ 7: 99 }), checked_at: T1 })),
    settle: (w: World) => w.db.run(w.db.k.updateTable("main.ci_run_approvals").set({ runs: "[]" })),
  },
} as const;

test("what a person settles on GitHub is asked about; a yes looks again, and once it is settled the question closes by itself and the approved merge goes on", async () => {
  for (const code of Object.keys(ON_GITHUB) as (keyof typeof ON_GITHUB)[]) {
    const w = await started("review and merge");
    await ON_GITHUB[code].cause(w);
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", code, MAINT]);
    assert.notEqual(await leg(w), "queued", code);
    await say(w, "yes");
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", code, MAINT], `${code}: nothing changed`);
    await ON_GITHUB[code].settle(w);
    await settle(w);
    assert.deepEqual(await shown(w), ["running", null, MAINT], code);
    assert.ok(["review", "ci", "queued"].includes(String(await leg(w))), code);
    assert.match(String((await eventsOf(w.db, "app", 1)).at(-1)!.line), /closed without an answer/, code);
    w.close();
  }
});

test("a conflict on an approved PR that a person has to resolve is asked about while it conflicts, and the question closes by itself once GitHub says it merges; so does one kept with only the wait that asked it", async () => {
  for (const kept of ["conflict", "wait"] as const) {
    const w = await started("review and merge");
    await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main", mergeable: "CONFLICTING", maintainer_can_modify: 0 }).where("number", "=", 1));
    await checks(w, { mergeable: "CONFLICTING" });
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ maintainer_can_modify: 0 }));
    await w.db.run(w.db.k.insertInto("main.conflict_merges").values({ repo: "app", number: 1, from_head: "sha1", to_head: null, base_sha: "base", state: "asked", attempt: 1, created_at: new Date().toISOString() }));
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", "conflict-person", MAINT], kept);
    if (kept === "wait") {
      const row = await wf(w);
      await w.db.run(w.db.k.updateTable("main.item_workflows").set({ rec: JSON.stringify({ ...row.rec, cause: { code: "wait", wait: "conflict-person" } }) }).where("id", "=", row.id));
    }
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", "conflict-person", MAINT], `${kept}: it still conflicts`);
    await w.db.run(w.db.k.updateTable("main.items").set({ mergeable: "MERGEABLE" }).where("number", "=", 1));
    await checks(w, { mergeable: "MERGEABLE" });
    await settle(w);
    assert.deepEqual(await shown(w), ["running", null, MAINT], kept);
    assert.ok(["review", "ci", "queued"].includes(String(await leg(w))), `${kept}: ${await leg(w)}`);
    assert.ok((await eventsOf(w.db, "app", 1)).some((e) => /closed without an answer/.test(String(e.line))), kept);
    w.close();
  }
});

test("a question whose cause went does not close by itself where the author pushed meanwhile: the commits go to the review round", async () => {
  const w = await started("review and merge");
  await checks(w, { overall: "none" });
  await settle(w);
  await w.synced(1, "theirs");
  await settle(w);
  const x = await wf(w);
  assert.deepEqual([x.state, x.blocker, x.step, x.approvedBy], ["running", null, "review new commits", MAINT]);
  assert.doesNotMatch(String((await eventsOf(w.db, "app", 1)).at(-1)?.line ?? ""), /closed without an answer/);
});

test("an approver who can act again goes on with their approval, unasked; where the merge itself was refused for their access, once it is to be tried again", async () => {
  for (const lane of [false, true]) {
    const w = await started("review and merge");
    const row = await wf(w), at = new Date().toISOString();
    const access = (permission: string) => w.db.run(w.db.k.updateTable("main.repo_permissions").set({ permission, checked_at: new Date().toISOString() }).where("login", "=", MAINT));
    await w.db.run(w.db.k.insertInto("main.workflow_actions").values({ workflow_id: row.id, repo: "app", number: 1, kind: "merge", by: MAINT, head: "sha1", state: "waiting-permission", reason: "no write access", created_at: at, updated_at: at }));
    if (!lane) await access("read");
    await settle(w);
    assert.deepEqual(await shown(w), ["blocked", "actor-gone", MAINT]);
    await access("write");
    await settle(w);
    if (lane) {
      assert.equal((await wf(w)).state, "blocked", "their access was never in doubt here");
      await w.db.run(w.db.k.updateTable("main.workflow_actions").set({ state: "pending" }));
      await settle(w);
    }
    assert.deepEqual([...await shown(w), await leg(w)], ["running", null, MAINT, "queued"]);
    assert.ok((await actions(w)).includes("merge"));
    w.close();
  }
});

test("a pre-merge stop of an approved PR with no fix round left gets a fix-up of its defects as the approver, with no question", async () => {
  const w = current = await (await (await world()).repo()).acting(MAINT, ANN);
  await w.pr(1, { label: "feature" });
  await (await w.verified(1)).premerge(1, "defect", false);
  await w.premergeRoundsSpent(1);
  await say(w, "review and merge");
  await w.review(1);
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }));
  await settle(w);
  assert.deepEqual([(await wf(w)).state, (await wf(w)).rec, await leg(w)], ["running", null, "fixup"]);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.params?.source === "operator"));
});

test("a merge entry whose verification failed gets a fix-up after its pre-merge review, with no question, and merges nothing before it", async () => {
  for (const [found, fixable] of [["clean", true], ["defect", true], ["defect", false]] as const) {
    const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT, ANN);
    await w.pr(1, { label: "feature" });
    await say(w, "merge");
    await pause();
    await w.verified(1, "error");
    await w.db.run(w.db.k.updateTable("main.verifications").set({ finished_at: new Date().toISOString() }));
    await settle(w);
    assert.deepEqual([await actions(w), (await wf(w)).state], [["premerge"], "running"]);
    await w.premerge(1, found, fixable);
    if (found === "defect" && !fixable) await w.premergeRoundsSpent(1);
    await settle(w);
    const x = await wf(w);
    assert.deepEqual([x.state, x.rec], ["running", null], `${found} ${fixable}`);
    const due = (await w.prPlan(1)).actions;
    assert.ok(due.some((a) => a.kind === "fixup") && !due.some((a) => a.kind === "merge"), `${found} ${fixable}: ${JSON.stringify(due.map((a) => a.kind))}`);
    w.close();
  }
});

test("the word merge past a pre-merge review that failed for good hands the approved PR over, which merges once verified on green CI", async () => {
  const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT, ANN);
  await w.pr(1, { label: "feature" });
  await say(w, "review and merge");
  await w.review(1);
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }));
  await settle(w);
  await savePremerge(w.db, { repo: "app", number: 1, head: "sha1", at: new Date().toISOString(), error: "no answer", final: true });
  await settle(w);
  assert.equal((await wf(w)).state, "blocked");
  await pause();
  await say(w, "merge");
  await settle(w);
  assert.equal(await leg(w), "queued");
  assert.deepEqual((await actions(w)).filter((a) => a === "verify" || a === "merge"), ["verify"]);
  await w.verified(1);
  assert.ok((await actions(w)).includes("merge"));
});

/** `text` said, and the review at sha1 (or a new one) failed for good. */
async function reviewFailed(text: string, set?: (w: World) => Promise<unknown>): Promise<World> {
  const w = await started(text, { review: false });
  await pause();
  await set?.(w);
  await w.db.run(w.db.k.updateTable("main.review_state").set({ fail_head: "sha1", fail_count: 9, fail_at: new Date().toISOString() }));
  await settle(w);
  return w;
}
const sendAs = async (w: World, text: string, number = 1, login = ANN) => {
  await pause();
  return (await runCommand(w.db, { login, canWrite: async () => true }, "github", { parsed: parse(text), items: [{ repo: "app", number }] })).items[0]!;
};

test("where its review failed for good, the word merge starts it at the merge queue, by whoever says it, approved before or not", async () => {
  for (const start of ["review and merge", "review"]) {
    const w = await reviewFailed(start);
    const asked = await wf(w);
    assert.equal(asked.rec?.again, "review");
    assert.match(await say(w, "merge", ANN), /without the review/);
    await settle(w);
    const now = await wf(w);
    assert.notEqual(now.id, asked.id);
    assert.deepEqual([now.entry, now.state, now.startedBy, now.approvedBy, now.baseHead, await leg(w)], ["merge", "running", ANN, ANN, "sha1", "queued"], start);
    assert.deepEqual(await w.rows(`SELECT state, stopped_by FROM item_workflows WHERE id = ${asked.id}`), [{ state: "stopped", stopped_by: ANN }]);
    assert.ok((await actions(w)).includes("merge"));
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "failure" }));
    assert.ok(!(await actions(w)).includes("merge"), "not on red CI");
    await w.db.run(w.db.k.insertInto("main.push_outcomes").values({ at: new Date().toISOString(), stage: "cifix", action: "cifix-push", repo: "app", number: 1, from_oid: "sha1", to_oid: "sha1b", before_res: "unknown" }));
    await w.synced(1, "sha1b");
    await settle(w);
    assert.deepEqual([await leg(w), await actions(w)], ["review", ["review"]], "a push of ours owes a review");
    w.close();
  }
});

test("a merge that skips the failed review ends at a later review of it, and at the author's commits", async () => {
  const w = await reviewFailed("review and merge");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "pending" }));
  await say(w, "merge", ANN);
  await settle(w);
  await say(w, "review", MAINT);
  await w.db.run(w.db.k.updateTable("main.review_state").set({ fail_head: null, fail_count: 0 }));
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "success" }));
  await settle(w);
  assert.deepEqual(await actions(w), ["review"]);
  w.close();

  const v = await reviewFailed("review and merge");
  const asked = await wf(v);
  await v.synced(1, "theirs");
  const o = await sendAs(v, "merge");
  assert.deepEqual([o.outcome, (await wf(v)).id], ["refused", asked.id], o.line);
  assert.match(o.line, /pushed commits after the question/);
});

test("where a commit of AutoCraft's came after the failed review's question, the word merge approves it as it is: that commit is reviewed", async () => {
  const w = await reviewFailed("review and merge");
  const asked = await wf(w);
  await w.db.run(w.db.k.insertInto("main.push_outcomes").values({ at: new Date().toISOString(), stage: "cifix", action: "cifix-push", repo: "app", number: 1, from_oid: "sha1", to_oid: "sha1b", before_res: "unknown" }));
  await w.synced(1, "sha1b");
  assert.doesNotMatch(await say(w, "merge", ANN), /without the review/);
  await settle(w);
  assert.equal((await wf(w)).id, asked.id);
  assert.deepEqual([await leg(w), await actions(w)], ["review", ["review"]]);
});

test("an earlier review of the commit whose review failed is named, and the word merge has what it asks done first", async () => {
  const earlier = async (x: World) => {
    await x.review(1, { verdict: "take-fix", fixes: [{ file: "src/a.rs", change: "rename a" }, { file: "src/b.rs", change: "rename b" }] });
    await say(x, "review", MAINT);
  };
  for (const [text, fixed] of [["merge", "1,2"], ["drop 1, merge", "2"]] as const) {
    const w = await reviewFailed("review and merge", earlier);
    assert.match((await wf(w)).rec!.text, /asks to fix 1 and 2/);
    assert.doesNotMatch((await wf(w)).rec!.text, /Write merge/);
    const o = await sendAs(w, text);
    assert.equal(o.outcome, "run", o.line);
    assert.deepEqual([(await wf(w)).entry, (await wf(w)).rec], ["review", null], text);
    assert.match(o.line, new RegExp(`fixing ${fixed.replace(",", " and ")}, then merging`, "i"), o.line);
    w.close();
  }
  const w = await reviewFailed("review and merge", earlier);
  assert.match(await say(w, "drop 1 and 2, merge", ANN), /dropping 1 and 2.*without the review/i);
  assert.equal((await wf(w)).entry, "merge");
  w.close();

  const v = await reviewFailed("review and merge", async (x) => { await x.review(1, { verdict: "hold" }); await say(x, "review", MAINT); });
  assert.match((await wf(v)).rec!.text, /says to hold it/);
  const o = await sendAs(v, "merge");
  assert.equal(o.outcome, "run", o.line);
  assert.deepEqual([(await wf(v)).entry, (await wf(v)).rec], ["review", null], "the review is made again before the merge");
});

/** Issue 7 implemented by PR 1, whose review failed for good at sha1; `before` runs before that question is answered. */
async function implementedFailed(): Promise<World> {
  const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT, ANN);
  await w.issue(7);
  await setFeature(w.db, "implement", true, MAINT, "app");
  await say(w, "implement and merge", MAINT, 7);
  await w.pr(1, { label: "feature" });
  await (await w.verified(1)).premerge(1, "clean");
  await w.db.run(w.db.k.insertInto("main.implementations").values({ repo: "app", number: 7, queued_by: MAINT, state: "pr-opened", attempt: 1, text_hash: "x7", pr_number: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
  await w.db.run(w.db.k.updateTable("main.item_workflows").set({ accepted_head: "sha1" }));
  await settle(w);
  await w.db.run(w.db.k.insertInto("main.review_state").values({ repo: "app", number: 1, fail_head: "sha1", fail_count: 9, fail_at: new Date().toISOString() }).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet({ fail_head: "sha1", fail_count: 9, fail_at: new Date().toISOString() })));
  await settle(w);
  return w;
}

test("an implementation whose review failed for good goes to the merge queue as its pull request; queued fix-ups end with the work it replaces", async () => {
  const w = await implementedFailed();
  const asked = await wf(w, 7);
  assert.deepEqual([asked.state, asked.rec?.again], ["blocked", "review"]);
  await w.db.run(w.db.k.insertInto("main.operator_fixups").values({ repo: "app", number: 1, from_head: "sha1", instructions: "x", by: MAINT, at: T0 }));
  await say(w, "merge", ANN, 7);
  assert.deepEqual((await w.rows("SELECT state FROM operator_fixups")).map((x) => x.state), ["ended"]);
  await settle(w);
  const now = await wf(w);
  assert.deepEqual([now.kind, now.entry, now.approvedBy, await leg(w)], ["pr", "merge", ANN, "queued"]);
  assert.equal(await liveWorkflow(w.db, "app", 7), null);
  // GitHub's unknown merge state of it is followed.
  const row = { repo: "app", number: 1, head_oid: "sha1", state: "OPEN", overall: "success", mergeable: "UNKNOWN" } as unknown as PrChecks;
  await noteMergeable(w.db, [row], T1);
  assert.ok(await unknownOf(w.db, "app", 1, "sha1"));
});

test("hold, close and backlog on the issue reach its pull request's own work; resume there goes on with what the hold ended, and is refused while that work runs", async () => {
  for (const by of ["merge", "hand"] as const) {
    const w = await implementedFailed();
    if (by === "merge") await say(w, "merge", ANN, 7);
    else { await say(w, "stop", MAINT, 7); await say(w, "merge", ANN, 1); }
    await settle(w);
    for (const text of ["resume", "yes"]) {
      const o = await sendAs(w, text, 7);
      assert.deepEqual([o.outcome, o.workflowId], ["refused", (await wf(w)).id], o.line);
      assert.match(o.line, /Send the command on \S*app#1\./);
    }
    assert.match(await say(w, "stop", MAINT, 7), /On hold/);
    assert.equal(await liveWorkflow(w.db, "app", 1), null, by);
    await settle(w);
    assert.ok(!(await actions(w)).includes("merge"), by);
    assert.match(await say(w, "resume", MAINT, 7), /app#1/);
    await settle(w);
    assert.deepEqual([(await wf(w)).entry, await leg(w)], ["merge", "queued"], by);
    assert.equal(await liveWorkflow(w.db, "app", 7), null);
    assert.match(await say(w, "backlog", MAINT, 7), /backlog/);
    assert.equal(await liveWorkflow(w.db, "app", 1), null, by);
    w.close();
  }
  const w = await implementedFailed();
  await say(w, "merge", ANN, 7);
  assert.match(await say(w, "close", MAINT, 7), /app#7 closes; \S*app#1 stays open/);
  assert.equal(await liveWorkflow(w.db, "app", 1), null);
  assert.deepEqual(await w.rows("SELECT number, kind FROM workflow_actions"), [{ number: 7, kind: "comment-close" }]);
});

test("the word merge where the review failed for good waits for the mirror to show a push of ours", async () => {
  const w = await implementedFailed();
  await w.db.run(w.db.k.insertInto("main.push_outcomes").values({ at: new Date().toISOString(), stage: "cifix", action: "cifix-push", repo: "app", number: 1, from_oid: "sha1", to_oid: "sha1x", before_res: "unknown" }));
  const o = await sendAs(w, "merge", 7);
  assert.equal(o.outcome, "refused", o.line);
  assert.match(o.line, /changed after the command was written/);
  assert.equal((await wf(w, 7)).kind, "issue");
});

test("the word merge on red CI that nothing repairs runs the recommendation", async () => {
  const w = await started("review and merge");
  await pause();
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "failure", checks: JSON.stringify([{ name: "test", state: "failure" }]) }));
  await w.db.run(w.db.k.insertInto("main.ci_fixes").values({ repo: "app", number: 1, head: "sha1", kind: "test", state: "push-denied", attempt: 1, created_at: new Date().toISOString() }));
  await settle(w);
  assert.deepEqual(await shown(w), ["blocked", "ci-fix-failed", MAINT]);
  const asked = await wf(w);
  await pause();
  assert.equal(asked.rec?.again, "review");
  const o = (await runCommand(w.db, { login: ANN, canWrite: async () => true }, "github", { parsed: parse("merge"), items: [{ repo: "app", number: 1 }] })).items[0]!;
  assert.equal(o.outcome, "run", o.line);
  assert.deepEqual([(await wf(w)).state, (await wf(w)).rec], ["running", null]);
});

test("red CI that ended the merge leg is one question: green CI closes it and a new leg starts", async () => {
  for (const own of [false, true]) {
    const w = await started("review and merge", {}, own ? "op-bot" : undefined);
    if (!own) await setCommentApproval(w.db, OPERATOR, "app", false);
    await pause();
    await w.db.run(w.db.k.updateTable("main.preapprovals").set({ state: "ci" }));
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "failure", checks: JSON.stringify([{ name: "test", state: "failure" }]) }));
    await w.db.run(w.db.k.insertInto("main.ci_fixes").values({ repo: "app", number: 1, head: "sha1", kind: "code", state: "capped", attempt: 1, created_at: new Date().toISOString() }));
    await settle(w);
    const asked = await wf(w), blocked = async () => (await eventsOf(w.db, "app", 1)).filter((e) => e.kind === "blocked").length;
    // The approver is asked as soon as the CI fix gives up; the question's block ends the leg.
    assert.deepEqual([asked.state, asked.rec?.cause?.code, await leg(w), await blocked()], ["blocked", "red-ci", "cancelled", 1], `own: ${own}`);
    await pause();
    await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "success", checks: "[]" }));
    await settle(w);
    assert.deepEqual([...await shown(w), await leg(w), await blocked()], ["running", null, MAINT, "queued", 1], `own: ${own}`);
    w.close();
  }
});

test("the word merge on a merge entry's red CI runs the recommendation", async () => {
  const w = await started("merge", { review: false });
  await pause();
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "failure", checks: JSON.stringify([{ name: "test", state: "failure" }]) }));
  await w.db.run(w.db.k.insertInto("main.ci_fixes").values({ repo: "app", number: 1, head: "sha1", kind: "test", state: "push-denied", attempt: 1, created_at: new Date().toISOString() }));
  await settle(w);
  const asked = await wf(w);
  assert.equal(asked.rec?.cause?.code, "red-ci");
  const o = await sendAs(w, "merge");
  assert.deepEqual([o.outcome, (await wf(w)).rec], ["run", null], o.line);
});

test("a quiet pull request whose fixes nobody can make or be asked for comes back, also where its merge is not approved", async () => {
  const w = await started("fix-up", { review: false });
  await w.review(1, { verdict: "take-fix", fixes: [{ file: "src/a.rs", change: "rename a" }] });
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }));
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ maintainer_can_modify: 0 }));
  const f = { ...(await w.plan()).prs.find((p) => p.facts.number === 1)!.facts, quiet: true };
  assert.equal(f.fixup?.fixes, 1);
  const q = questionFor(f, decidePr(f), { approved: false, review: { verdict: "take-fix", sure: true, rec: null }, parts: [{ n: 1, title: "rename a", source: "review", state: "planned" }], conflict: null });
  assert.deepEqual([q?.rec.parts, q?.rec.author, q?.rec.goes], [{ fix: [], drop: [] }, undefined, "look"], "nobody can be asked on it: a person makes the fix on its branch");
});

test("fixes nobody can make that block the merge are never dropped: the author is asked, after a yes where the merge is approved, at once where it is not", async () => {
  const cases: Record<string, (w: World) => Promise<unknown>> = {
    protected: (w) => w.review(1, { verdict: "take-fix", fixes: [{ file: ".git/config", change: "drop the hook path" }, { file: "../deny.toml", change: "allow the licence" }] }),
    "cannot run": async (w) => {
      await w.db.run(w.db.k.updateTable("main.pr_checks").set({ maintainer_can_modify: 0 }));
      await setCommentApproval(w.db, OPERATOR, "app", false);
      await w.review(1, { verdict: "take-fix", fixes: [{ file: "src/a.rs", change: "rename a" }, { file: "src/b.rs", change: "rename b" }] });
    },
  };
  for (const [name, set] of Object.entries(cases)) for (const start of ["review and merge", "review"]) {
    const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT, ANN);
    await w.pr(1, { label: "feature" });
    await (await w.verified(1)).premerge(1, "clean");
    await say(w, start);
    await set(w);
    await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }));
    await settle(w);
    const x = await wf(w), at = `${name}, ${start}: ${x.rec?.text}`;
    if (start === "review") {
      assert.deepEqual([x.state, !!x.blockerParams?.author], ["waiting", true], at);
      w.close();
      continue;
    }
    assert.deepEqual([x.state, x.rec?.parts, x.rec?.author], ["blocked", { fix: [], drop: [] }, "ask"], at);
    assert.match(x.rec!.text, /could not make fix 1 .*fix 2.*Ask the author/, at);
    await say(w, "yes", ANN);
    await settle(w);
    assert.deepEqual([(await wf(w)).state, (await wf(w)).approvedBy !== null], ["waiting", true], at);
    w.close();
  }
});

test("a merge refused for good is asked about, and a yes tries it again", async () => {
  const w = await started("review and merge");
  await pause();
  await w.db.run(w.db.k.insertInto("main.merges").values({ repo: "app", number: 1, head_oid: "sha1", run_id: "r", at: new Date().toISOString(), path: "operator", method: "squash", outcome: "refused", reason: "safe-merge: a workflow file may not be changed", ci: "success", mergeable: "MERGEABLE" }));
  await settle(w);
  const x = await wf(w);
  assert.deepEqual([x.state, x.approvedBy, /workflow file/.test(x.rec!.text)], ["blocked", MAINT, true]);
  await say(w, "yes", ANN);
  await settle(w);
  assert.deepEqual([(await wf(w)).state, await leg(w)], ["running", "queued"]);
  assert.ok((await actions(w)).includes("merge"));
});

test("CI fixes that failed twice on a PR approved for merge come back to a person, and the contributor is not asked", async () => {
  const w = await started("review and merge");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "failure", checks: JSON.stringify([{ name: "test", state: "failure" }]) }).where("number", "=", 1));
  for (const attempt of [1, 2]) await w.db.run(w.db.k.insertInto("main.ci_fixes").values({ repo: "app", number: 1, head: "sha1", kind: "test", state: "rejected", reason: "the patch check refused it", attempt, created_at: new Date(Date.now() + 1000).toISOString() }));
  await settle(w);
  assert.ok(!(await w.prPlan(1)).actions.some((a) => a.kind === "cifix"));
  const x = await wf(w);
  // The question names the failing check and the CI fix's last try.
  assert.deepEqual([x.state, /`test`/.test(x.rec?.text ?? ""), /patch check refused it/.test(x.rec?.text ?? "")], ["blocked", true, true]);
});

test("an implementation that ended without a pull request is asked about, and a yes implements the issue again", async () => {
  const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT, ANN);
  await w.issue(7);
  await setFeature(w.db, "implement", true, MAINT, "app");
  await say(w, "implement", MAINT, 7);
  await pause();
  await startAttempt(w.db, { repo: "app", number: 7, textHash: textHash("Panic when the slice is empty", "first() indexes element 0."), queuedBy: MAINT });
  // It ended while the pass that asks was reading: after the pass began.
  await w.db.run(w.db.k.updateTable("main.implementations").set({ state: "failed", updated_at: new Date(Date.now() + 1000).toISOString() }));
  await settle(w);
  const x = await wf(w, 7);
  assert.deepEqual([x.state, x.rec?.goes], ["recommending", "on"]);
  await say(w, "yes", MAINT, 7);
  assert.deepEqual(implementStep((await loadItemFact(w.db, "app", 7))!), { bucket: "plan" });
  await settle(w);
  assert.equal((await wf(w, 7)).state, "running");
});
