// CI on the default branch: the state of a head from its checks, the culprit and red_since from the heads seen,
// and what the branch counts as while its newest head's checks run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classify, derive, prNumberOf, type HeadRow, type MainCheck } from "../src/mainci/classify.ts";
import { mainCiRepos, pollMainCi, redMainHolds, redMainRepos } from "../src/mainci/index.ts";
import { loadTrip, loadTrips, tripMergeBreakers, tripStage } from "../src/data/control/index.ts";
import type { Querier } from "../src/mirror.ts";
import { saveMainHeads } from "../src/data/mirror/mainci.ts";
import { decidePr } from "../src/core/decide.ts";
import { prFacts } from "./world.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

const c = (name: string, state: MainCheck["state"]): MainCheck => ({ name, state, url: null });

test("classify: gate failures are red, optional failures are not, pending is running", () => {
  assert.equal(classify([]), "none");
  assert.equal(classify([c("gate / test", "success"), c("lint", "skipped")]), "green");
  assert.equal(classify([c("gate / test", "failure"), c("lint", "success")]), "red");
  assert.equal(classify([c("gate / test", "success"), c("sonar", "failure")]), "optional");
  assert.equal(classify([c("gate / test", "pending"), c("sonar", "failure")]), "running");
  assert.equal(classify([c("gate / test", "failure"), c("other", "pending")]), "red");
  assert.equal(classify([c("build", "failure")]), "red", "no gate check: any failure counts");
  assert.equal(classify([c("build", "success"), c("sonar", "failure")], ["sonar"]), "optional");
  assert.equal(classify([c("build", "failure"), c("sonar", "failure")], ["sonar"]), "red");
  assert.equal(classify([c("build", "success"), c("sonarcloud / SonarCloud Scan", "failure")], ["sonarcloud / SonarCloud Scan"]), "optional", "no gate check: only listed checks failed");
  assert.equal(classify([c("build", "success"), c("sonarcloud / SonarCloud Scan", "failure")]), "red", "unlisted");
});

test("prNumberOf reads merge commits and squash titles", () => {
  assert.equal(prNumberOf("Merge pull request #412 from fork/x"), 412);
  assert.equal(prNumberOf("Fix export (#88)"), 88);
  assert.equal(prNumberOf("Bump version"), null);
});

const row = (sha: string, state: HeadRow["state"], at: string): HeadRow => ({ sha, state, committedAt: at, headline: `Change ${sha} (#${sha.length})`, firstSeenAt: at, stateChangedAt: at });

test("derive: the culprit is the first red head after the last green one", () => {
  const d = derive([row("a", "green", "2026-01-01"), row("b", "running", "2026-01-02"), row("c", "red", "2026-01-03"), row("d", "red", "2026-01-04")])!;
  assert.equal(d.current.sha, "d");
  assert.equal(d.lastGreenSha, "a");
  assert.equal(d.culprit?.sha, "c");
  assert.equal(d.redSince, "2026-01-03");
  assert.equal(d.culprit?.pr, 1);
});

test("derive: a green head ends the red run; with no green head the oldest red head is the culprit", () => {
  const green = derive([row("a", "red", "2026-01-01"), row("b", "green", "2026-01-02")])!;
  assert.equal(green.redSince, null);
  assert.equal(green.culprit, null);
  assert.equal(green.lastGreenSha, "b");
  const never = derive([row("a", "red", "2026-01-01"), row("b", "red", "2026-01-02")])!;
  assert.equal(never.culprit?.sha, "a");
  assert.equal(never.lastGreenSha, null);
  assert.equal(derive([]), null);
});

test("a red branch stays red while a head's checks run, also a rerun of the red head, and holds a ready PR until a head goes green", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "main-ci-")), "t.db"));
  const at = (min: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + min * 60_000).toISOString();
  const ms = (min: number) => Date.parse(at(min));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: at(0), pipeline: 1 }));
  // A poll reading `sha` (committed at `committed`) in `state` at minute `min`.
  const poll = async (sha: string, committed: number, state: string, min: number, failing: string[] = []) => await saveMainHeads(db, [{
    repo: "app", sha, branch: "main", state, failing: JSON.stringify(failing.map((name) => ({ name, url: null }))), checks: "[]", committed_at: at(committed), headline: `Change ${sha}`,
  }], at(min));
  const held = async (nowMs: number) => {
    const p = decidePr(prFacts({ repoFacts: { mainRed: (await redMainRepos(db, nowMs)).has("app") } }));
    return p.state === "waiting-main-ci" && p.actions.length === 0;
  };
  const row = async (nowMs: number) => (await mainCiRepos(db, [], nowMs))[0]!;

  await poll("a", 0, "green", 0);
  await poll("b", 10, "red", 10, ["gate / test"]);
  // The red head's failed jobs are rerun: the same head runs again.
  await poll("b", 10, "running", 12);
  assert.equal(await held(ms(13)), true);
  assert.deepEqual([(await row(ms(13))).state, (await row(ms(13))).headState, (await row(ms(13))).culprit?.sha], ["red", "running", "b"]);
  await poll("b", 10, "red", 14, ["gate / test"]);

  await poll("c", 20, "running", 20);
  await poll("d", 30, "running", 30);
  assert.equal(await held(ms(35)), true);
  const r = await row(ms(35));
  assert.deepEqual([r.state, r.headState, r.headSha, r.culprit?.sha, r.failing.map((f) => f.name)], ["red", "running", "d", "b", ["gate / test"]]);

  // A head without checks may still be registering them; past that it is a repo without CI and holds nothing.
  await poll("e", 40, "none", 40);
  assert.equal(await held(ms(45)), true);
  const until = (await redMainHolds(db, ms(45))).get("app");
  assert.ok(until && until > ms(45) && until <= ms(60), "the hold names when its grace ends");
  assert.equal(await held(ms(60)), false);

  await poll("f", 70, "green", 70);
  assert.equal(await held(ms(75)), false);
  assert.equal((await row(ms(75))).culprit, null);
});

test("a merge breaker a red main tripped resumes once main passes again; one with a post-merge defect, also one added while main was red, stays", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "main-ci-")), "t.db"));
  const t = (min: number) => new Date(Date.now() - 60 * 60_000 + min * 60_000).toISOString();
  for (const name of ["app", "lib", "svc"]) {
    await db.run(db.k.insertInto("tracked_repos").values({ name, added_by: "op", added_at: t(0), pipeline: 1 }));
    await db.run(db.k.insertInto("repos").values({ name, visibility: "public", synced_at: t(0) }));
  }
  for (const repo of ["app", "svc"]) await db.run(db.k.insertInto("merges").values({ repo, number: 7, head_oid: "h7", at: t(1), run_id: "r", path: "rule", outcome: "merged" }));
  // What GitHub answers for each repo's default branch: its head, the PR its headline names, and its gate check.
  let heads: Record<string, { sha: string; pr: number; gate: "SUCCESS" | "FAILURE" }> = {};
  const client: Querier = {
    spent: 0, remaining: null,
    query: async (_q, vars) => Object.fromEntries(Object.entries(vars).map(([k, owner], i) => {
      const repo = Object.keys(heads)[i]!, h = heads[repo]!;
      return [k.replace("o", "r"), { defaultBranchRef: { name: "main", target: { oid: h.sha, committedDate: new Date().toISOString(), messageHeadline: `Merge pull request #${h.pr} from ${owner}/x`,
        statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "gate / test", status: "COMPLETED", conclusion: h.gate, detailsUrl: null }] } } } } }];
    })) as never,
  };
  const active = async () => [...(await loadTrips(db)).keys()].sort();

  heads = { app: { sha: "a1", pr: 7, gate: "FAILURE" }, lib: { sha: "l1", pr: 3, gate: "SUCCESS" }, svc: { sha: "s1", pr: 7, gate: "FAILURE" } };
  await pollMainCi(db, client);
  await tripStage(db, [{ key: "merge:lib", reason: "the post-merge review of lib#3 found 1 defect", evidence: ["lib#3"], at: t(2) }]);
  // The post-merge review of the PR that broke svc's main finds a defect while the red main holds the breaker.
  await tripMergeBreakers(db, [{ repo: "svc", number: 7, mergedAt: t(1), reason: "the post-merge review of svc#7 found 1 defect", evidence: ["svc#7"] }]);
  assert.deepEqual(await active(), ["merge:app", "merge:lib", "merge:svc"]);
  assert.match((await loadTrip(db, "merge:svc"))!.reason, /post-merge review/);

  // Still red on a later head: nothing resumes.
  heads = { app: { sha: "a2", pr: 8, gate: "FAILURE" }, lib: { sha: "l2", pr: 4, gate: "SUCCESS" }, svc: { sha: "s2", pr: 8, gate: "FAILURE" } };
  await pollMainCi(db, client);
  assert.deepEqual(await active(), ["merge:app", "merge:lib", "merge:svc"]);

  heads = { app: { sha: "a3", pr: 9, gate: "SUCCESS" }, lib: { sha: "l3", pr: 5, gate: "SUCCESS" }, svc: { sha: "s3", pr: 9, gate: "SUCCESS" } };
  await pollMainCi(db, client);
  assert.deepEqual(await active(), ["merge:lib", "merge:svc"]);
  assert.equal((await loadTrip(db, "merge:app"))?.clearedBy, "pipeline");
});
