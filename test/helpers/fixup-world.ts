// The fix-up step against real git with the network replaced: a contributor's fork, a querier that answers the PR query, gh faked,
// and a database with one take-fix PR (#7) started with fix-up.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Querier } from "../../src/mirror.ts";
import { setPushApproval } from "../../src/fixup/approval.ts";
import { exec, type Exec, type ExecResult } from "../../src/fixup/git.ts";
import type { FixupDeps } from "../../src/fixup/index.ts";
import type { FixupPr } from "../../src/fixup/patch.ts";
import type { FixupCheckInput } from "../../src/patchcheck/types.ts";
import { insertWorkflow } from "../../src/workflow/store.ts";
import { acting, appLane } from "../acting.ts";
import { reportingTaskRunner } from "../fake-runner.ts";
import { validating } from "../gql.ts";
import { SCRATCH } from "../scratch.ts";
import { connectDb, type Db } from "./raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
export const dir = mkdtempSync(join(SCRATCH, "fixup-test-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
export const T0 = "2026-01-01T00:00:00Z";
export const T1 = "2026-01-02T00:00:00Z";
export const FIXES = JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]);

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export type Opts = { canModify?: boolean; approved?: boolean; mergeable?: string; verdict?: string; reviewHead?: string };

/** One take-fix PR (#7) at `head`, started with fix-up. */
export async function fresh(head: string, o: Opts = {}): Promise<Db> {
  const db = await connectDb(join(mkdtempSync(join(dir, "db-")), "t.db"));
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 7, kind: "pr", state: "OPEN", title: "Fix a thing", author: "someone", additions: 5, deletions: 0, head_oid: head, created_at: T0, updated_at: T0 }));
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 7, head_oid: o.reviewHead ?? head, run_id: "rv", at: T0, model: "m", verdict: o.verdict ?? "take-fix", reason: "nearly right", fixes: FIXES, sure: 1, mode: "full" }));
  await db.run(db.k.insertInto("pr_checks").values({ repo: "app", number: 7, head_oid: head, state: "OPEN", is_draft: 0, overall: "success", checks: "[]", mergeable: o.mergeable ?? "MERGEABLE", maintainer_can_modify: o.canModify === false ? 0 : 1, fetched_at: T1 }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }).onConflict((oc) => oc.doNothing()));
  if (o.approved !== false) await setPushApproval(db, "op", "app", true);
  await insertWorkflow(db, { repo: "app", number: 7, kind: "pr", entry: "fixup", state: "running", startedBy: "op", startedAt: T0, startedVia: "dashboard" });
  await acting(db, ["op"]);
  await reportingTaskRunner(db);
  return db;
}

// ---- the whole step against real git, with the network replaced ------------

export type World = { asked: FixupPr[]; /** The patch checks asked: the input, and the workspace a check in a fix session's workspace works in. */ checked: { input: FixupCheckInput; workspaceId: number | null }[]; assigned: string[]; fork: string; base: string; head: string; log: string[]; deps: FixupDeps; movedBeforePush?: boolean };

/** A fork repository with branch `fix` at `head`, standing in for both the base repo's pull ref and the contributor's fork. */
export const APPROVE = JSON.stringify({ verdict: "approve", reasons: "matches the listed fix", problems: [] });

export function world(opts: { check?: string | null; reply?: string | null; moveBranch?: boolean; assignees?: string[]; canModify?: boolean; pushError?: string; lib?: string; diff?: string; /** The contributor's tree in place of the default files. */ files?: Record<string, string> } = {}): World {
  const root = mkdtempSync(join(dir, "w-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "fix");
  const files = opts.files ?? { "src/lib.rs": opts.lib ?? "fn a() {}\nfn main() { a(); }\n", "src/other.rs": "fn z() {}\n", "ROADMAP.md": "# Plan\n- one\n", "GUIDE.md": "# Plan\n- one\n" };
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), text); }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "contributor");
  const head = git(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  git(root, "clone", "-q", "--bare", work, fork);
  git(fork, "update-ref", "refs/pull/7/head", head);
  const log: string[] = [];
  const w: World = { asked: [], checked: [], assigned: [...(opts.assignees ?? [])], fork, base: root, head, log, deps: undefined as never };
  const good = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { a(); }\n+fn b() {}\n+fn main() { b(); }\n";
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(q: string) {
      if (q.startsWith("mutation")) {
        const adding = q.includes("addAssignees");
        log.push(adding ? "assign" : "unassign");
        w.assigned = adding ? [...w.assigned, "pipeline-bot"] : w.assigned.filter((l) => l !== "pipeline-bot");
        return {};
      }
      log.push("pr-info");
      return { repository: { pullRequest: {
        id: "PR7", number: 7, state: "OPEN", isDraft: false, headRefOid: head, headRefName: "fix", maintainerCanModify: opts.canModify !== false, mergeable: "MERGEABLE",
        headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: w.assigned.map((login) => ({ login })) },
      } } };
    },
  });
  // Real git on local repositories; gh and the two GitHub URLs are faked.
  const run: Exec = async (cmd, args, o = {}): Promise<ExecResult> => {
    if (cmd === "gh") {
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
      log.push(`comment: ${o.input}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    const net = args.findIndex((a) => a.startsWith("https://github.com/"));
    const sub = net >= 0 ? args.map((a) => (a.startsWith("https://github.com/") ? fork : a)) : args;
    const sub2 = sub.filter((a, i) => !(a === "-c" && sub[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
    const verb = args.find((a) => ["fetch", "push"].includes(a));
    if (verb === "push") {
      log.push(`push ${args.filter((a) => a.startsWith("--force-with-lease") || /^[0-9a-f]{40}:/.test(a)).join(" ")}`);
      if (opts.pushError) return { code: 1, stdout: "", stderr: opts.pushError };
      if (opts.moveBranch) { git(fork, "update-ref", "refs/heads/fix", git(fork, "commit-tree", "-p", head, "-m", "moved", `${head}^{tree}`)); }
    }
    return exec("git", net >= 0 ? sub2 : args, { ...o });
  };
  w.deps = {
    querier, lane: appLane(querier), exec: run, now: () => new Date(T1), root: join(root, "cache"),
    fetchDiff: async () => ({ ok: true, text: opts.diff ?? "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+fn a() {}\n" }),
    ask: async (_db, input) => { log.push("model"); w.asked.push(...input); return opts.reply === undefined ? good : opts.reply; },
    check: async (_db, input, _checkout, ws) => {
      log.push("check");
      w.checked.push({ input: input[0]!, workspaceId: ws?.workspaceId ?? null });
      // A check in a fix session's workspace reads the change there; any other gets it inline.
      if (ws) assert.equal(input[0]!.patch, "");
      else assert.match(input[0]!.patch, /^diff --git/);
      return opts.check === undefined ? APPROVE : opts.check;
    },
  };
  return w;
}
