// Our implementation PRs go back to their session: a take-fix review and red CI plan implement{revise} for the PR's issue
// instead of the fix-up and the CI fix; a conflict still goes to the conflict step, and a head is revised once. While the repo's
// Implement feature is off the PR waits on it, and a PR that closed ends its attempt from the PR side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePr, implementOffWait } from "../src/core/decide.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { prFacts } from "./world.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { setFeature } from "../src/build/features.ts";
import { exec as realExec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { DIFF_FLAGS } from "../src/implement/diff.ts";
import { lastPush, openImplementationPr } from "../src/implement/pr.ts";
import { pushRevision, runRevise, type ReviseDeps } from "../src/implement/revise.ts";
import { implementationById, roundsOf, setImplementationState, startImplementation } from "./implement-rows.ts";
import type { Implementation, RetryRound, ReviseRound } from "../src/implement/types.ts";
import type { BuildRun } from "../src/implement/build.ts";
import { addRounds } from "../src/implement/attempt.ts";
import { retryRevision } from "../src/data/implement/index.ts";
import { createEnv } from "../src/build/envs.ts";
import { createWorkspace, moveWorkspace } from "../src/build/workspaces.ts";

/** The live implement workflow of the PR's issue. */
const ISSUES = { entry: "implement", approved: true, startedBy: "op", startedAt: "2026-11-04T09:00:00.000Z", own: false } as const;
const kinds = (f: Parameters<typeof prFacts>[0]) =>
  decidePr(prFacts(f)).actions.filter((a) => a.kind !== "unassign").map((a) => `${a.kind}${a.params?.bucket ? `:${a.params.bucket}` : ""}${a.params?.issue ? `#${a.params.issue}` : ""}`);

test("an implementation PR's review fixes and red CI go to its session; a conflict goes to the conflict step", () => {
  const ours = { workflow: ISSUES, implementation: { issue: 7, state: "pr-opened", revisedHeads: [] as string[], queuedBy: "op", standing: "yes" as const } };
  const takeFix = { review: { verdict: "take-fix" as const, fixes: 2 }, fixup: { fixes: 2, attempts: 0, recorded: [] as string[] } };
  const red = { ci: "failure" as const, cifix: { states: [] as string[], tries: 0, rerunAt: null, infraRuns: null, formattingTask: null, formatterEnded: true, totalPushes: 0, totalTries: 0, skipReason: null, checksAt: null } };

  // A contributor's PR gets the fix-up and the CI fix; ours gets the revision instead.
  assert.ok(kinds(takeFix).includes("fixup:fix"));
  assert.deepEqual(kinds({ ...takeFix, ...ours }).filter((k) => /^(fixup|cifix|implement)/.test(k)), ["implement:revise#7"]);
  assert.ok(kinds(red).some((k) => k.startsWith("cifix")));
  assert.deepEqual(kinds({ ...red, ...ours }).filter((k) => /^(fixup|cifix|implement)/.test(k)), ["implement:revise#7"]);

  // A conflict is merged away by the conflict step first.
  const conflict = kinds({ ...takeFix, ...ours, mergeable: "CONFLICTING", conflict: { bucket: "merge", base: "main", baseOk: true } });
  assert.ok(conflict.includes("conflict:merge"), conflict.join());
  assert.ok(!conflict.some((k) => k.startsWith("implement")), conflict.join());

  // A head the session already revised waits for its push, a revision that started goes on from the PR (its issue may be
  // closed or held), and a stuck one plans nothing new.
  assert.ok(!kinds({ ...takeFix, ...ours, implementation: { ...ours.implementation, revisedHeads: ["h1"] } }).some((k) => /^(fixup|implement)/.test(k)));
  assert.deepEqual(kinds({ ...takeFix, ...ours, implementation: { ...ours.implementation, state: "revising", revisedHeads: ["h1"] } }).filter((k) => /^(fixup|implement)/.test(k)), ["implement:revise#7"]);
  assert.ok(!kinds({ ...takeFix, ...ours, implementation: { ...ours.implementation, state: "stuck" } }).some((k) => /^(fixup|implement)/.test(k)));
});

test("an implementation PR waits on the Implement switch while it is off, and on a revision in progress instead of merging", () => {
  const takeFix = { review: { verdict: "take-fix" as const, fixes: 2 }, fixup: { fixes: 2, attempts: 0, recorded: [] as string[] } };
  const off = decidePr(prFacts({ ...takeFix, workflow: ISSUES, implementation: { issue: 7, state: "pr-opened", revisedHeads: [], queuedBy: "op", standing: "yes" }, repoFacts: { implementOn: false } }));
  assert.ok(!off.actions.some((a) => a.kind === "implement"), JSON.stringify(off.actions));
  assert.equal(off.wait, implementOffWait("app"));
  // A ready PR whose session is revising it is not merged meanwhile: it waits on the revision.
  const revising = decidePr(prFacts({ workflow: ISSUES, implementation: { issue: 7, state: "revising", revisedHeads: ["h1"], queuedBy: "op", standing: "yes" } }));
  assert.ok(!revising.eligible && !revising.actions.some((a) => a.kind === "merge"), JSON.stringify(revising.actions));
  assert.match(revising.wait ?? "", /revision for #7/);
});

test("a closed, unmerged implementation PR whose issue is closed too still ends its attempt, with Implement off", async () => {
  const w = await (await (await (await world()).repo()).pr(1)).issue(2);
  const impl = await startImplementation(w.db, { repo: "app", number: 2, queuedBy: "op", textHash: "t" });
  await setImplementationState(w.db, impl.id, "pr-opened", { prNumber: 1 });
  await w.db.run(w.db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app").where("number", "in", [1, 2]));
  const f = (await loadPrFacts(w.db)).find((x) => x.number === 1);
  assert.ok(f, "the closed PR of a live implementation is loaded");
  assert.ok(decidePr(f).actions.some((a) => a.kind === "implement" && a.params?.bucket === "revise" && a.params?.issue === 2));
});

test("a revision after a base merge keeps main's change, also in the revision after it and with the cache made again", async () => {
  const LOGIN = "pipeline-bot";
  const dir = mkdtempSync(join(SCRATCH, "impl-revise-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }).trim();
  const work = join(dir, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "src/lib.rs"), "pub fn a() {}\n");
  writeFileSync(join(work, "src/other.rs"), "pub fn b() {}\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  const base = git(work, "rev-parse", "HEAD");
  const upstream = join(dir, "upstream.git"), fork = join(dir, "fork.git");
  git(dir, "clone", "-q", "--bare", work, upstream);
  git(dir, "init", "-q", "--bare", fork);
  const diffFor = (lib: string) => {
    writeFileSync(join(work, "src/lib.rs"), lib);
    return execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", ...DIFF_FLAGS.split(" "), base], { cwd: work, encoding: "utf8" });
  };

  const w = await (await (await (await world()).repo()).acting()).issue(5, { title: "Crash on start" });
  const db = w.db;
  await insertWorkflow(db, { repo: "app", number: 5, kind: "issue", entry: "implement", state: "running", startedBy: "op", startedAt: "2026-01-01T00:00:00.000Z", startedVia: "dashboard" });
  await setFeature(db, "implement", true, "op", "app");
  const started = await startImplementation(db, { repo: "app", number: 5, queuedBy: "op", textHash: "h", baseSha: base });
  await setImplementationState(db, started.id, "opening", { plan: { kind: "bugfix", summary: "Return 1.", plan: "1. Return 1." } as Implementation["plan"] });

  let branch = "";
  const ok = (stdout = "", code = 0): ExecResult => ({ code, stdout, stderr: code ? "failed" : "" });
  const exec: Exec = async (cmd, args, opt = {}) => {
    if (cmd === "gh") {
      const path = args[0] === "api" ? args[1]! : "";
      if (path === "user") return ok(JSON.stringify({ login: LOGIN, id: 42, node_id: "U42" }));
      if (path === `repos/${LOGIN}/app`) return ok("storytold/app\n");
      if (path === "repos/storytold/app/issues/5") return ok("open\n");
      if (path === "repos/storytold/app/pulls/12") return ok(args.includes(".head.sha") ? `${git(fork, "rev-parse", `refs/heads/${branch}`)}\n` : "open\n");
      if (args[0] === "pr" && args[1] === "list") return ok("");
      if (args[0] === "pr" && args[1] === "create") {
        branch = args[args.indexOf("--head") + 1]!.split(":")[1]!;
        await w.pr(12, { head: git(fork, "rev-parse", `refs/heads/${branch}`), author: LOGIN, authorId: null });
        return ok("https://github.com/storytold/app/pull/12\n");
      }
      if (args[0] === "issue" && args[1] === "comment") return ok("https://github.com/storytold/app/issues/5#issuecomment-1\n");
      return ok("", 1);
    }
    const at = args.findIndex((a) => a.startsWith("https://github.com/"));
    if (at < 0) return realExec(cmd, args, opt);
    const target = args[at]!.includes("/storytold/") && !args.includes("push") && !args.some((a) => a.includes("refs/heads/autocraft/")) ? upstream : fork;
    return realExec(cmd, args.map((a, i) => (i === at ? target : a)).filter((a, i, all) => a !== "protocol.file.allow=never" && !(a === "-c" && all[i + 1] === "protocol.file.allow=never")), opt);
  };
  const opened = await openImplementationPr(db, { implementation: (await implementationById(db, started.id))!, diff: diffFor("pub fn a() -> u8 { 1 }\n"), base, model: "claude-opus-5-5", checks: [], by: "pipeline" }, { exec, root: join(dir, "cache"), log: () => {}, mint: async () => "installation-token" });
  assert.ok(opened.ok, opened.ok ? "" : opened.reason);

  // The conflict step merges main, which changed another file, into the PR's branch.
  const clone = join(dir, "clone");
  git(dir, "clone", "-q", fork, clone, "-b", branch);
  git(clone, "fetch", "-q", upstream, "main");
  writeFileSync(join(clone, "src/other.rs"), "pub fn b() -> u8 { 2 }\n");
  git(clone, "commit", "-q", "-am", "main's change");
  const mainChange = git(clone, "rev-parse", "HEAD");
  git(clone, "reset", "-q", "--hard", "HEAD~1");
  git(clone, "merge", "-q", "--no-edit", mainChange);
  git(clone, "push", "-q", "origin", branch);

  const revise = async (lib: string, root: string) => {
    const impl = (await implementationById(db, started.id))!;
    const from = (await lastPush(db, impl, branch))!.commit;
    const head = git(fork, "rev-parse", `refs/heads/${branch}`);
    // The PR's plan has the revision: a take-fix review at its head.
    await w.synced(12, head);
    await w.review(12, { verdict: "take-fix" });
    const req: ReviseRound = { prNumber: 12, head, from, review: true, ci: false, message: "fix" };
    const r = await pushRevision(db, { exec, root, mint: async () => "installation-token", gh: (args: string[]) => exec("gh", args).then((x) => x.stdout) } as unknown as ReviseDeps, impl, req, diffFor(lib), "pipeline", () => {});
    assert.ok(r.ok, r.ok ? "" : r.reason);
    const at = (path: string) => git(fork, "show", `refs/heads/${branch}:${path}`);
    assert.equal(at("src/other.rs"), "pub fn b() -> u8 { 2 }", "main's change stays");
    assert.equal(at("src/lib.rs"), lib.trim());
  };
  await revise("pub fn a() -> u8 { 3 }\n", join(dir, "cache"));
  await revise("pub fn a() -> u8 { 4 }\n", join(dir, "cache"));
  await revise("pub fn a() -> u8 { 5 }\n", join(dir, "cache-again"));
});

test("a revision whose tree reset failed resets again after Try again, and never revises or pushes a tree without the pushed change", async () => {
  const w = await (await (await (await world()).repo()).pr(12)).issue(5);
  const db = w.db;
  const base = "a".repeat(40);
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2, settings: { image: "autocraft:test" } }, "op");
  const ws = await createWorkspace(db, { repo: "app", baseSha: base, envId: "pods", owner: "test" });
  await moveWorkspace(db, ws, ["requested"], "ready", { pod: "ws-1", base_commit: base });
  const impl = await startImplementation(db, { repo: "app", number: 5, queuedBy: "op", textHash: "h", baseSha: base });
  await setImplementationState(db, impl.id, "revising", { prNumber: 12, branch: "autocraft/app-5", workspaceId: ws, diffHash: "d".repeat(64) });
  const req: ReviseRound = { prNumber: 12, head: "b".repeat(40), from: "c".repeat(40), review: true, ci: false, message: "fix" };
  // A stop of AutoCraft's own started the revision over, on a tree to be reset to the change last pushed.
  const retry: RetryRound = { cause: "session-lost", detail: null, runner: true, from: "revising", to: "revising", reset: true };
  await addRounds(db, impl.id, [{ kind: "revise", result: req }, { kind: "retry", result: retry }, { kind: "revise", result: req }]);

  let touched = 0;
  const deps = {
    // The cache answers every git command, but the base commit is not in it, so the change cannot be rebuilt.
    exec: async (_cmd: string, args: string[]): Promise<ExecResult> => ({ code: args.includes("cat-file") ? 1 : 0, stdout: "", stderr: "" }),
    root: mkdtempSync(join(SCRATCH, "impl-reset-")),
    api: () => { touched++; throw new Error("the workspace tree is read or changed"); },
    pod: () => { touched++; throw new Error("a session turn or the checks run"); },
  } as unknown as ReviseDeps;
  const run = { db, log: () => {}, progress: async () => {}, cancelled: async () => false, stopping: async () => false, startedMs: Date.now(), by: "pipeline" } as unknown as BuildRun;
  const stuckOn = async () => {
    const now = (await implementationById(db, impl.id))!;
    const q = (await roundsOf(db, impl.id)).filter((r) => r.kind === "question").at(-1)?.result as { cause?: string } | undefined;
    return now.state === "stuck" ? q?.cause : now.state;
  };

  await runRevise(run, "app", 5, deps);
  assert.equal(await stuckOn(), "workspace-lost", "a tree that cannot be reset asks");
  assert.ok(await retryRevision(db, { id: impl.id }), "Try again starts the revision again");
  await runRevise(run, "app", 5, deps);
  assert.equal(await stuckOn(), "workspace-lost", "the reset is still due after Try again, and asks again when it still fails");
  assert.equal(touched, 0, "no turn ran and nothing reached the workspace without the reset");
});
