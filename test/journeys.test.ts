// Journeys: a PR or issue goes through the real planner pass, the real executors and the real guard, with GitHub and the
// models faked (test/world-db.ts). Each test asserts outcomes: rows in the database and the writes that reached GitHub.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CLI_BY } from "../src/core/gates.ts";
import { guard, liveOf } from "../src/core/guard.ts";
import { runFixup } from "../src/fixup/index.ts";
import { runBatches } from "../src/merge/batch.ts";
import { runMerge } from "../src/merge/index.ts";
import { refreshChecks } from "../src/review/checks.ts";
import { prepareOpusInput, type OpusDeps } from "../src/review/opus.ts";
import { runPremerge } from "../src/premerge/review.ts";
import type { LaneDeps } from "../src/github/user-lane.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { OPERATOR, untilQuiet } from "./world-db.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { excluded } from "../src/db/kx.ts";
import { DIFF, endLint, fresh, gitWorld, merged, premergeDeps, premergeReply, quiet, sh } from "./journeys-world.ts";

describe("PR journeys", () => {
  test("a whitelisted bugfix PR goes from review to merge, and the merge gets the reviewed head", async () => {
    const w = await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).models(() => premergeReply(1));
    assert.equal((await w.prPlan(1)).state, "waiting-premerge");
    const s = await runPremerge(w.db, { repo: "app" }, quiet, premergeDeps);
    assert.equal(s.reviewed, 1);
    assert.equal((await w.prPlan(1)).state, "ready");

    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, ["app#1"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => [x.number, x.head]), [[1, "sha1"]]);
    assert.deepEqual(await merged(w), [{ number: 1, head_oid: "sha1", outcome: "merged" }]);
    assert.equal((await w.prPlan(1)).state, "merged");
  });

  test("both Opus inputs carry the open items that mention the PR's files; the pre-merge input also carries the first review", async () => {
    const w = await (await (await (await fresh()).pr(1)).review(1)).issue(9, { title: "Dropping a file still replaces the frame", body: "Seen in src/lib.rs" });
    const deps: OpusDeps = { fetchDiff: async () => ({ ok: true, text: DIFF }), fetchDelta: async () => ({ ok: false, tooLarge: false, error: "unused" }), model: "opus", maxChars: 120_000 };
    const c = { repo: "app", number: 1, title: "PR 1", body: "b", author_association: null, head_oid: "sha1", lines_changed: 20, size: "S" as const, score: null };
    for (const independent of [false, true]) {
      const p = await prepareOpusInput(w.db, "app", c, deps, quiet, { independent });
      assert.equal(p.kind, "ready");
      if (p.kind !== "ready") continue;
      assert.deepEqual(p.input.related_open?.map((r) => [r.number, r.state]), [[9, "open"]]);
      assert.equal(p.input.review_history !== undefined, independent);
    }
  });

  test("a head that moves after the plan is refused, by the merge step and by the guard", async () => {
    const w = await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean");
    assert.equal((await w.prPlan(1)).actions[0]!.kind, "merge");
    w.gh.live(1, { head: "sha1-moved" });

    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, []);
    assert.equal(w.gh.writesOf("merge").length, 0);

    const g = await guard(w.db, { repo: "app", number: 1 }, { kind: "merge", head: "sha1" }, CLI_BY, liveOf(w.db, w.gh.querier));
    assert.ok("refused" in g && /head moved/.test(g.refused), JSON.stringify(g));
    assert.equal(w.gh.writesOf("merge").length, 0);
  });

  test("an unsure review of a started PR comes back with a recommendation; answered with merge, it is merged as recommended, as the person who answered", async () => {
    const w = await (await (await (await (await (await fresh()).acting("mira")).pr(1)).workflow(1, { by: "mira", approved: false })).review(1, { sure: false })).verified(1);
    await w.premerge(1, "clean");
    const lane: LaneDeps = { vault: { userToken: async (login) => ({ ok: true, access: login === "mira" ? "user-token" : "other" }) }, permission: async () => "write" };
    const tokens: (string | undefined)[] = [];
    const deps = w.gh.mergeDeps();
    const run: typeof deps.run = async (cmd, args, env) => { tokens.push(env?.GH_TOKEN); return await deps.run(cmd, args, env); };
    const merge = () => runMerge(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, { ...deps, run, lane });
    await advanceWorkflows(w.db);
    assert.equal((await liveWorkflow(w.db, "app", 1))?.state, "recommending");
    assert.deepEqual((await merge()).merged, []);
    assert.deepEqual(w.gh.writes, []);

    const answer = await runCommand(w.db, { login: "mira", canWrite: async () => true }, "dashboard", { parsed: parse("merge"), items: [{ repo: "app", number: 1 }] });
    assert.equal(answer.items[0]!.outcome, "run", answer.lines.join());
    const advance = () => untilQuiet(w.db, [() => advanceWorkflows(w.db), () => advancePreapprovals(w.db)], 3);
    await advance();
    // The person's merge is the judgement the unsure review could not make: the same head is not reviewed again.
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => a.kind), ["merge"], "merge runs the recommendation: the merge");
    assert.deepEqual((await merge()).merged, ["app#1"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => [x.number, x.head]), [[1, "sha1"]]);
    assert.deepEqual(tokens, ["user-token"], "the merge ran with the token of the person who answered");
  });

  test("a PR a person stopped is not merged by the rule", async () => {
    const w = await (await (await (await (await (await fresh()).acting()).pr(1)).review(1)).verified(1)).premerge(1, "clean");
    assert.equal((await w.prPlan(1)).state, "ready");
    await w.workflow(1, { approved: false });
    const r = await runCommand(w.db, { login: OPERATOR, canWrite: async () => true }, "dashboard", { parsed: parse("stop"), items: [{ repo: "app", number: 1 }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join());
    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, []);
    assert.deepEqual(w.gh.writes, []);
  });

  test("with the pipeline switched off the pipeline's own run writes nothing", async () => {
    const w = await (await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pipeline(false);
    const m = await runMerge(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, []);
    assert.deepEqual(w.gh.writes, []);
    assert.deepEqual(await merged(w), []);
    // An operator's own run is not stopped by the switch.
    assert.deepEqual((await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps())).merged, ["app#1"]);
  });

  test("a batch of two PRs is built, published as one PR and lands together", async () => {
    const w = await (await (await (await (await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pr(2)).review(2)).verified(2)).premerge(2, "clean");
    const deps = w.gh.batchDeps();
    const built = await runBatches(w.db, { repo: "app" }, quiet, deps);
    assert.equal(built.published.length, 1);
    assert.deepEqual(w.gh.writesOf("pr").map((x) => x.number), [900]);
    assert.deepEqual((await w.prPlan(1)).state, "in-batch");
    assert.deepEqual((await w.prPlan(2)).state, "in-batch");
    assert.ok(!(await w.prPlan(1)).actions.some((a) => a.kind === "merge" && a.params?.singleOnly), "a member is not merged alone");

    const done = await runBatches(w.db, { repo: "app" }, quiet, deps);
    assert.deepEqual(done.merged, [1, 2]);
    // Only the batch PR was merged, at the tip that was pushed; the members got merge records.
    assert.deepEqual(w.gh.writesOf("merge").map((x) => x.number), [900]);
    assert.equal(w.gh.writesOf("merge")[0]!.head, w.gh.writesOf("push")[0]!.head);
    assert.deepEqual((await merged(w)).map((r) => [r.number, r.head_oid, r.outcome]), [[1, "sha1", "merged"], [2, "sha2", "merged"]]);
  });

  test("the batch PR's runs are approved at the batch tip when people started its members in a repo whose pipeline is off", async () => {
    const w = await (await (await (await (await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pr(2)).review(2)).verified(2)).premerge(2, "clean");
    await runBatches(w.db, { repo: "app" }, quiet, w.gh.batchDeps());
    const tip = (await w.db.get(w.db.k.selectFrom("merge_batches").select("commit_sha as c").where("pr_number", "=", 900)))!.c;
    await w.db.run(w.db.k.insertInto("ci_run_approvals").values({ repo: "app", number: 900, head_oid: tip, runs: "[]", approved: "[]", reread: 1, failed: "{}", checked_at: "2026-01-02T00:00:00Z" }));
    await w.db.run(w.db.k.insertInto("settings").values({ key: "pipeline_login", value: "bot" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    await w.db.run(w.db.k.insertInto("items").values({ repo: "app", number: 900, kind: "pr", state: "OPEN", title: "batch", author: "bot", additions: 1, deletions: 0,
      head_oid: "mirror-lag", head_ref: "batch", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
    const plan = async () => await w.prPlan(900);
    assert.deepEqual((await plan()).actions.map((a) => [a.kind, a.head]), [["approve-ci", tip]]);
    await w.db.run(w.db.k.updateTable("tracked_repos").set({ pipeline: 0 }).where("name", "=", "app"));
    assert.equal((await plan()).state, "out-of-scope");
    for (const n of [1, 2]) await w.workflow(n);
    assert.deepEqual((await plan()).actions.map((a) => [a.kind, a.head]), [["approve-ci", tip]]);
  });

  test("the batch PR's runs are approved for members approved for merge without a take review: a merge entry, and one answered past a hold", async () => {
    const w = await (await (await (await (await (await fresh()).acting()).pr(1)).pr(2)).pr(3)).review(1);
    await w.review(3, { verdict: "hold" });
    await (await w.workflow(2, { entry: "merge" })).workflow(3);
    for (const n of [1, 2, 3]) await (await w.verified(n)).premerge(n, "clean");
    for (const n of [2, 3]) await w.handedOver(n);
    await runBatches(w.db, { repo: "app" }, quiet, w.gh.batchDeps());
    assert.deepEqual((await w.db.all(w.db.k.selectFrom("merge_batch_prs").select("number").orderBy("number"))).map((x) => Number(x.number)), [1, 2, 3]);
    // The batch PR is open (the app identity of this world cannot open it).
    await w.db.run(w.db.k.updateTable("merge_batches").set({ state: "open", pr_number: 900, fork: "bot/app" }));
    const tip = (await w.db.get(w.db.k.selectFrom("merge_batches").select("commit_sha as c").where("pr_number", "=", 900)))!.c;
    await w.db.run(w.db.k.insertInto("ci_run_approvals").values({ repo: "app", number: 900, head_oid: tip, runs: "[]", approved: "[]", reread: 1, failed: "{}", checked_at: "2026-01-02T00:00:00Z" }));
    await w.db.run(w.db.k.insertInto("settings").values({ key: "pipeline_login", value: "bot" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    await w.db.run(w.db.k.insertInto("items").values({ repo: "app", number: 900, kind: "pr", state: "OPEN", title: "batch", author: "bot", additions: 1, deletions: 0,
      head_oid: tip, head_ref: "batch", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
    const approves = async () => (await w.prPlan(900)).actions.some((a) => a.kind === "approve-ci");
    assert.equal(await approves(), true);
    const findings = (await w.db.get(w.db.k.selectFrom("premerge_reviews").select("findings").where("number", "=", 2)))!.findings;
    await w.premerge(2, "defect");
    assert.equal(await approves(), false, "a defect of the pre-merge review");
    await w.db.run(w.db.k.updateTable("premerge_reviews").set({ findings }).where("number", "=", 2));
    assert.equal(await approves(), true);
    await w.db.run(w.db.k.updateTable("preapprovals").set({ state: "cancelled" }).where("number", "=", 3));
    assert.equal(await approves(), false, "a member whose approval for merge no longer stands");
  });

  test("a draft is not merged, alone or in a batch, and no refusal is recorded; it goes on once it is ready for review", async () => {
    const one = await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean");
    one.gh.live(1, { draft: true });
    const merge = async () => await runMerge(one.db, { repo: "app", dryRun: false }, quiet, one.gh.mergeDeps());
    assert.deepEqual((await merge()).merged, []);
    assert.deepEqual(await one.rows("SELECT * FROM merges"), []);
    const plan = await one.prPlan(1);
    assert.deepEqual([plan.state, plan.waitKind, plan.actions.map((a) => a.kind)], ["draft", "contributor", []]);
    one.gh.live(1, { draft: false });
    await refreshChecks(one.db, one.gh.querier, "app", [1]);
    assert.deepEqual((await merge()).merged, ["app#1"]);

    const w = await (await (await (await (await (await (await (await (await fresh()).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pr(2)).review(2)).verified(2)).premerge(2, "clean");
    const deps = w.gh.batchDeps();
    assert.equal((await runBatches(w.db, { repo: "app" }, quiet, deps)).published.length, 1);
    w.gh.live(2, { draft: true });
    const done = await runBatches(w.db, { repo: "app" }, quiet, deps);
    assert.deepEqual([done.merged, done.superseded.length], [[], 1]);
    const newest = (await w.db.get(w.db.k.selectFrom("merge_batches").select(["id", "state"]).orderBy("id", "desc").limit(1)))!;
    assert.deepEqual((await w.db.all(w.db.k.selectFrom("merge_batch_prs").select("number").where("batch_id", "=", newest.id))).map((x) => Number(x.number)), [1]);
    assert.deepEqual(w.gh.writesOf("merge"), []);
  });

  test("a take-fix patch is linted before the push: clippy findings go back to the model, the clean patch is pushed with the format changes folded in", async () => {
    const git = gitWorld(1);
    const w = await (await (await fresh()).pr(1, { head: git.head })).review(1, { verdict: "take-fix" });
    await reportingTaskRunner(w.db);
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket, a.head]), [["fixup", "fix", git.head]]);
    const edit = (to: string) => `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { a(); }\n${to}`;
    const asked: { previous?: { findings: string[] } }[] = [];
    const deps = git.deps(w);
    deps.ask = async (_db, input) => {
      asked.push(input[0] as (typeof asked)[number]);
      return asked.length === 1 ? git.patch : edit("+fn b() {  }\n+fn main() { b(); }\n");
    };

    // Round 1: the patch is stored, not pushed.
    const first = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    assert.deepEqual(first.pushed, []);
    assert.deepEqual(git.pushes, []);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("fixups").select(["state", "lint_round", "lint_state"])), [{ state: "linting", lint_round: 1, lint_state: "pending" }]);
    assert.deepEqual((await w.prPlan(1)).actions, []);
    const t1 = (await w.rows("SELECT id, state FROM build_tasks"))[0] as { id: number; state: string };
    assert.equal(t1.state, "queued");

    // Clippy finds something on a line the patch changed: the model is asked again with the finding.
    await endLint(w, t1.id, { diagnostics: [{ line: 1 }] });
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket]), [["lint", "fixup"]]);
    const second = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    assert.deepEqual(second.pushed, []);
    assert.equal(asked.length, 2);
    assert.match(asked[1]!.previous!.findings[0]!, /needless at line 1/);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("fixups").select(["state", "lint_round"])), [{ state: "linting", lint_round: 2 }]);

    // Round 2 is clean; rustfmt wants `{}`: one push whose commit has the format change.
    const t2 = ((await w.rows("SELECT id FROM build_tasks ORDER BY id DESC LIMIT 1"))[0] as { id: number }).id;
    assert.notEqual(t2, t1.id);
    await endLint(w, t2, { format: "diff -uN a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\t2026-01-01\n+++ b/src/lib.rs\t2026-01-01\n@@ -1,2 +1,2 @@\n-fn b() {  }\n+fn b() {}\n fn main() { b(); }\n" });
    const third = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    assert.deepEqual(third.pushed, ["app#1"]);
    const pushed = git.branchHead();
    assert.deepEqual(git.pushes, [{ lease: git.head, to: pushed }]);
    assert.equal(sh(git.fork, "show", `${pushed}:src/lib.rs`), "fn b() {}\nfn main() { b(); }");
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("fixups").select(["state", "from_head", "to_head"])), [{ state: "pushed", from_head: git.head, to_head: pushed }]);
    assert.equal(w.gh.writesOf("comment").length, 1);

    // Sync sees the new head; it is reviewed, verified and pre-merge reviewed like any head.
    await w.synced(1, pushed);
    assert.equal((await w.prPlan(1)).actions.some((a) => a.kind === "merge"), false);
    await (await (await w.review(1, { head: pushed })).verified(1)).premerge(1, "clean");
    const m = await runMerge(w.db, { repo: "app", dryRun: false }, quiet, w.gh.mergeDeps());
    assert.deepEqual(m.merged, ["app#1"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => x.head), [pushed]);
  });
});
