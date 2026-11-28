// No new failures (src/mainci/no-new.ts): while main is red, a PR whose failing check fails only on main's failing tests merges, and one
// whose same check fails on another test waits as red CI does.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { saveMainHeads } from "../src/data/mirror/index.ts";
import { runChecks } from "../src/review/index.ts";
import { CHECK, T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => { current?.close(); current = null; });

const MAIN = "main-red";
/** A `gh run view --log-failed` log of the test job where `tests` panicked. */
const log = (tests: string[]): string => tests.map((t, i) => `test\tRun cargo test\t2026-01-01T00:00:0${i}.0000000Z thread '${t}' panicked at crates/core/src/lib.rs:${10 + i}:5:`).join("\n") + "\n";

test("while main is red, a PR failing only where main fails is planned to merge and one with a new failing test waits", async () => {
  const w = current = await (await (await (await world()).repo()).pr(1, { ci: "failure" })).pr(2, { ci: "failure" });
  for (const n of [1, 2]) { await w.review(n); await w.verified(n); await w.premerge(n, "clean"); }
  await saveMainHeads(w.db, [{ repo: "app", sha: MAIN, branch: "main", state: "red", failing: JSON.stringify([{ name: CHECK, url: null }]), checks: "[]", committed_at: T0, headline: "Change" }], T0);
  // Main fails tests::a; PR 1 fails tests::a too, PR 2 fails tests::b.
  const logs: Record<string, string[]> = { [MAIN]: ["tests::a"], sha1: ["tests::a"], sha2: ["tests::a", "tests::b"] };
  const runs: Record<string, string> = { [MAIN]: "100", sha1: "101", sha2: "102" };
  const gh = async (args: string[]): Promise<string> => {
    const sha = /commits\/([^/]+)\/check-runs/.exec(args[1] ?? "")?.[1];
    if (sha) return JSON.stringify({ check_runs: [{ id: 1, name: CHECK, status: "completed", conclusion: "failure", details_url: `https://github.com/o/app/actions/runs/${runs[sha]}/job/1` }] });
    if (args[0] === "run") return log(logs[Object.keys(runs).find((k) => runs[k] === args[2])!]!);
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const before = await w.prPlan(1);
  assert.equal(before.state, "waiting-ci", "a red head is compared with main's before anything else happens to it");
  await runChecks(w.db, { repo: "app" }, () => {}, w.gh.querier, gh);
  // Each PR's other check passed.
  await w.db.run(w.db.k.updateTable("pr_checks").set({ checks: JSON.stringify([{ name: CHECK, state: "failure" }, { name: "gate / lint", state: "success" }]) }));
  const [one, two] = [await w.prPlan(1), await w.prPlan(2)];
  assert.ok(one.actions.some((a) => a.kind === "merge"), `PR 1 merges past main's failure: ${one.state} ${JSON.stringify(one.actions)}`);
  assert.match(one.note ?? "", /fails only where main fails/);
  assert.equal(two.state, "ci-failed");
  assert.ok(!two.actions.some((a) => a.kind === "merge"));
});
