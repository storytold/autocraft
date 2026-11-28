// The shared database builder for journeys: a temp database filled through the same writes sync and the stages make, a fake
// GitHub that answers live reads and records writes, and a fake Task Runner with canned replies.
//
//   const w = world().repo().pr(1).review(1).verified(1).premerge(1, "clean");
//   w.gh.writes            // what reached GitHub: { kind, number, head?, ... }
//   w.gh.live(1, { head }) // GitHub's own state of the PR, apart from the database
//   w.models((input) => reply | undefined)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acting } from "./acting.ts";
import { fakeTaskRunner } from "./fake-runner.ts";
import { PREMERGE_FIX_ROUNDS } from "../src/core/rules.ts";
import { loadPlanSet, type PlanSet } from "../src/core/plan-set.ts";
import { diffCacheDir, recordDiffFacts } from "../src/review/diff.ts";
import { savePermissions } from "../src/data/access/index.ts";
import type { ActDeps } from "../src/act/index.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import { setFixIssueApproval } from "../src/implement/approval.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { setMergeApproval } from "../src/merge/approval.ts";
import { listWorkflows, startWorkflows } from "../src/data/workflow/index.ts";
import { checkFixup } from "../src/preapproval/index.ts";
import { setCiApproval } from "../src/merge/ci-approval.ts";
import type { BatchDeps } from "../src/merge/batch.ts";
import type { CommandResult, MergeDeps } from "../src/merge/index.ts";
import type { Querier } from "../src/mirror.ts";
import { savePremerge } from "../src/premerge/store.ts";
import type { PremergeFinding } from "../src/premerge/types.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

export const T0 = "2026-01-01T00:00:00Z";
export const T1 = "2026-01-02T00:00:00Z";
/** Before T0: a workflow started then has seen nothing the stages wrote. */
const BEFORE = "2025-12-31T00:00:00Z";
export const OPERATOR = "op";
/** The one CI check of every PR. */
export const CHECK = "gate / test";

/** What reached GitHub. `head` is the head the write was for, where the write names one. */
export type Write = { kind: "merge" | "assign" | "comment" | "close" | "pr" | "push"; number: number; head?: string; detail?: string };
type Live = { head: string; state: string; draft?: boolean; mergeable: string; ci: string; authors: string[]; assignees: string[] };

/**
 * Runs `passes` in turn, up to `most` rounds, until each has run and written nothing since the last write: a pass reads the
 * database and the clock, so it would decide the same again. It does not wait for the permission reads advancePreapprovals starts and
 * leaves running (refreshSettlers): without an injected `permission` there is no app token and they write nothing; a test that injects
 * one waits for its answer itself.
 */
export async function untilQuiet(db: Db, passes: (() => Promise<unknown>)[], most: number): Promise<void> {
  let wrote = false;
  const stop = db.observe((e) => { wrote ||= e.kind === "write-lock" || /\binsert\b|\breplace\s+into\b|\bupdate\b|\bdelete\s+from\b/i.test(e.sql); });
  try {
    for (let i = 0, quiet = 0; i < most * passes.length && quiet < passes.length; i++) {
      wrote = false;
      await passes[i % passes.length]!();
      quiet = wrote ? 0 : quiet + 1;
    }
  } finally {
    stop();
  }
}

mkdirSync(SCRATCH, { recursive: true });
export const tmpdir = (name: string): string => mkdtempSync(join(SCRATCH, `${name}-`));

/** `authorId`: the author's GitHub account id (default: the allowed "regular" account for "regular", none for others). */
export type PrOpts = { author?: string; authorId?: number | null; lines?: number; label?: string; head?: string; mergeable?: string; ci?: "success" | "failure" | "pending"; canModify?: boolean; flags?: string[] };
/** The GitHub account of the allowed author "regular". */
export const REGULAR_ID = 7;
export type ReviewOpts = { verdict?: "take" | "take-fix" | "hold" | "close"; head?: string; sure?: boolean; fixes?: { file: string; change: string }[]; reason?: string };
export type IssueOpts = { label?: string; flags?: string[]; title?: string; body?: string; impact?: string };

export async function world() {
  const db: Db = await connectDb(join(tmpdir("world"), "t.db"));
  process.env.AUTOCRAFT_ARTIFACT_DIR = tmpdir("artifacts");
  const restore: (() => void)[] = [];
  const live = new Map<number, Live>();
  const writes: Write[] = [];
  const headOf = async (n: number): Promise<string> => (await db.prepare("SELECT head_oid FROM items WHERE repo = 'app' AND number = ?").get(n))?.head_oid as string;

  // ---- fake GitHub ----
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      const v = vars as { n?: number; id?: string; body?: string };
      if (query.includes("reviewThreads")) return { repository: { pullRequest: { author: null, comments: { nodes: [] }, reviews: { nodes: [] }, formal: { nodes: [] }, reviewThreads: { nodes: [] } } } };
      if (query.includes("latestOpinionatedReviews")) return { repository: { pullRequest: { reviewDecision: null, latestOpinionatedReviews: { nodes: [] } } } };
      if (query.includes("viewer")) return { viewer: { login: "pipeline-bot", id: "U1" } };
      if (query.startsWith("mutation")) {
        const n = Number(String(v.id ?? "").replace(/\D/g, ""));
        if (query.includes("addComment")) { writes.push({ kind: "comment", number: n, detail: v.body }); return { addComment: { commentEdge: { node: { url: `https://x/${v.id}#c` } } } }; }
        if (query.includes("addAssignees")) { writes.push({ kind: "assign", number: n }); live.get(n)?.assignees.push("pipeline-bot"); return { addAssigneesToAssignable: { clientMutationId: null } }; }
        writes.push({ kind: "close", number: n, ...(live.get(n) ? { head: live.get(n)!.head } : {}) });
        return {};
      }
      if (query.includes("issueOrPullRequest")) {
        const n = v.n!, l = live.get(n);
        const state = (l?.state ?? "OPEN").toUpperCase();
        return { repository: { issueOrPullRequest: l ? { __typename: "PullRequest", id: `P${n}`, state, headRefOid: l.head } : { __typename: "Issue", id: `I${n}`, state } } };
      }
      if (v.n !== undefined) {
        const l = live.get(v.n)!;
        return { repository: { pullRequest: {
          id: `P${v.n}`, headRefOid: l.head, baseRefName: "main", state: l.state, assignees: { nodes: l.assignees.map((login) => ({ login })) },
          commits: { totalCount: l.authors.length, nodes: l.authors.map((login) => ({ commit: { authors: { nodes: [{ email: `${login}@x`, name: login, user: { login } }] } } })) },
        } } };
      }
      const nums = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      return { repository: Object.fromEntries(nums.map((x) => {
        const l = live.get(x)!;
        const done = l.ci !== "pending";
        return [`pr${x}`, {
          number: x, state: l.state, isDraft: l.draft ?? false, headRefOid: l.head, mergeable: l.mergeable, maintainerCanModify: true,
          commits: { nodes: [{ commit: { oid: l.head, statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: CHECK, status: done ? "COMPLETED" : "IN_PROGRESS", conclusion: done ? l.ci.toUpperCase() : null }] } } } }] },
        }];
      })) };
    },
  });
  const runMergeCommand = async (_cmd: string, args: string[]): Promise<CommandResult> => {
    const head = args[args.indexOf("--head") + 1];
    writes.push({ kind: "merge", number: Number(args[1]), ...(head && args.includes("--head") ? { head } : {}), detail: args.find((a) => a === "--squash" || a === "--merge") });
    return { code: 0, stdout: "merged", stderr: "" };
  };

  const w = {
    db,
    gh: {
      writes,
      writesOf: (kind: Write["kind"]) => writes.filter((x) => x.kind === kind),
      querier,
      /** GitHub's own state of a PR (its head, mergeable state, CI), which the database learns only from a fetch. */
      live: (n: number, patch: Partial<Live> = {}) => { Object.assign(live.get(n)!, patch); return w; },
      mergeDeps: (): MergeDeps => ({ querier, run: runMergeCommand, now: () => new Date(T1), mergeCommand: "safe-merge" }),
      /** Everyone has write access, as far as this GitHub is asked. */
      actDeps: (): ActDeps => ({ querier, now: () => new Date(T1), permission: async (d, login, repo) => {
        await savePermissions(d, [{ login, repo, permission: "write", checkedAt: new Date().toISOString() }]);
        return { kind: "ok", permission: "write" };
      } }),
      /**
       * Deps of the batch stage over a fake git: a batch branch is "pushed", its PR is #900 and merges with the merge command. `cars`:
       * each batch PR gets a number of its own from #900 up, at the tip it was opened with and CI `cars.ci`.
       */
      batchDeps: (o: { ci?: () => string; cars?: { ci: Live["ci"] } } = {}): BatchDeps => {
        const MAIN = "a".repeat(40);
        let commits = 0, tip = "none", next = 900;
        const carTips = new Map<string, string>();
        if (!o.cars) live.set(900, { head: "none", state: "OPEN", mergeable: "MERGEABLE", ci: "success", authors: ["bot"], assignees: [] });
        const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
        return {
          querier, root: tmpdir("batch"), mergeCommand: "safe-merge", now: () => new Date(T1), mainHead: async () => MAIN,
          run: async (cmd, args) => {
            const r = await runMergeCommand(cmd, args);
            if (r.code === 0 && Number(args[1]) >= 900 && live.has(Number(args[1]))) live.get(Number(args[1]))!.state = "MERGED";
            return r;
          },
          exec: async (cmd, args, opts) => {
            const a = [...args];
            if (cmd === "git") {
              while (a[0] === "-c") a.splice(0, 2);
              if (a[0] === "rev-parse" && a[1] === "--git-dir") return ok(".\n");
              if (a[0] === "fetch") return ok();
              if (a[0] === "rev-parse") return ok((a[1] === "refs/batch/main" ? MAIN : await headOf(Number(a[1]!.split("pr-")[1]))) + "\n");
              if (a[0] === "merge-tree") return ok(`tree-${a.at(-1)}\n`);
              if (a[0] === "commit-tree") { tip = `${"b".repeat(39)}${++commits}`; if (!o.cars) live.get(900)!.head = tip; return ok(`${tip}\n`); }
              if (a[0] === "diff") return ok("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
              if (a[0] === "push") {
                // `<sha>:refs/heads/<branch>`: the branch's tip, for the PR opened from it.
                const spec = a.find((x) => x.includes(":refs/heads/"));
                if (spec) carTips.set(spec.split(":refs/heads/")[1]!, spec.split(":")[0]!);
                writes.push({ kind: "push", number: 900, head: tip });
                return ok();
              }
              if (a[0] === "update-ref" || a[0] === "cat-file") return ok();
              if (a[0] === "for-each-ref") return ok("");
            }
            if (cmd === "gh") {
              if (a[0] === "api" && a[1] === "user") return ok(JSON.stringify({ login: "bot", id: 7, node_id: "N7" }));
              if (a[0] === "api") return ok("storytold/app\n");
              if (a[0] === "pr" && a[1] === "list") return ok("");
              if (a[0] === "pr" && a[1] === "create" && o.cars) {
                const n = next++;
                const head = a[a.indexOf("--head") + 1]!.split(":")[1]!;
                live.set(n, { head: carTips.get(head) ?? tip, state: "OPEN", mergeable: "MERGEABLE", ci: o.cars.ci, authors: ["bot"], assignees: [] });
                writes.push({ kind: "pr", number: n, head: live.get(n)!.head, detail: opts?.input });
                return ok(`https://github.com/storytold/app/pull/${n}\n`);
              }
              if (a[0] === "pr" && a[1] === "create") { writes.push({ kind: "pr", number: 900, head: tip, detail: opts?.input }); return ok("https://github.com/storytold/app/pull/900\n"); }
              if (a[0] === "pr" && a[1] === "close") { if (o.cars && live.has(Number(a[2]))) { live.get(Number(a[2]))!.state = "CLOSED"; writes.push({ kind: "close", number: Number(a[2]) }); } return ok(); }
            }
            throw new Error(`unexpected ${cmd} ${a.join(" ")}`);
          },
        };
      },
    },

    // ---- tracked repo, operators, switch ----
    /** The tracked repo "app" with the pipeline on for it, an operator, and the repo approvals (all on unless named in `off`). */
    async repo(off: ("merge" | "push" | "comment" | "ci" | "fixissue")[] = []) {
      await db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', ?, ?, 1)").run(OPERATOR, T0);
      await db.prepare("UPDATE tracked_repos SET pipeline = 1 WHERE name = 'app'").run();
      await db.prepare("INSERT OR IGNORE INTO repos (name, visibility, default_branch) VALUES ('app', 'public', 'main')").run();
      await db.prepare("INSERT OR IGNORE INTO access (login, role) VALUES (?, 'operator')").run(OPERATOR);
      await db.prepare("INSERT OR IGNORE INTO whitelist_overrides (login, status, by, at, github_id) VALUES ('regular', 'allow', ?, ?, ?)").run(OPERATOR, T0, REGULAR_ID);
      const on = (k: string) => !off.includes(k as never);
      await setMergeApproval(db, OPERATOR, "app", on("merge"));
      await setPushApproval(db, OPERATOR, "app", on("push"));
      await setCommentApproval(db, OPERATOR, "app", on("comment"));
      await setCiApproval(db, OPERATOR, "app", on("ci"));
      await setFixIssueApproval(db, OPERATOR, "app", on("fixissue"));
      return await w.pipeline(true);
    },
    /** The app identity, and the people who may act on the repo: write permission on it, read just now. */
    async acting(...logins: string[]) {
      await acting(db, logins.length ? logins : [OPERATOR]);
      return w;
    },
    /** A running workflow of the PR, started (and by default approved for merge) before anything the stages write (T0). */
    async workflow(n: number, o: { entry?: "review" | "fixup" | "merge"; by?: string; approved?: boolean } = {}) {
      const by = o.by ?? OPERATOR;
      await startWorkflows(db, [{ repo: "app", number: n, kind: "pr", entry: o.entry ?? "review", weight: 5, startedBy: by, startedVia: "dashboard", baseHead: await headOf(n), at: BEFORE, ...(o.approved === false ? {} : { approvedBy: by, approvedVia: "dashboard" as const }) }]);
      return w;
    },
    /** The merge leg of the PR's live workflow, handed over to the merge queue at its head after anything the stages wrote. */
    async handedOver(n: number) {
      const wf = (await listWorkflows(db, { live: true, refs: [{ repo: "app", number: n }] }))[0]!;
      await db.run(db.k.insertInto("preapprovals").values({ repo: "app", number: n, by: wf.startedBy, at: T1, instructions: "", state: "queued", from_head: await headOf(n), head: await headOf(n), updated_at: T1, workflow_id: wf.id }));
      return w;
    },
    /** The operator's fix-up of the PR's head ("rename a to b"), with the merge leg of its live workflow unless `merge` is false. */
    async fixup(n: number, merge = true) {
      const step = await checkFixup(db, { repo: "app", number: n, by: OPERATOR, instructions: "rename a to b", merge });
      const id = (await listWorkflows(db, { live: true, refs: [{ repo: "app", number: n }] }))[0]?.id;
      if (merge && id === undefined) throw new Error(`app#${n} has no live workflow`);
      await db.write(() => step.write(id ?? 0));
      return w;
    },
    /** The global pipeline switch. */
    async pipeline(on: boolean) {
      await db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_enabled', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(on ? "1" : "0");
      return w;
    },

    // ---- what sync writes ----
    /** An open PR with its classification and its checks at its head. */
    async pr(n: number, o: PrOpts = {}) {
      const head = o.head ?? `sha${n}`;
      const author = o.author ?? "regular";
      await db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, author_id, additions, deletions, head_oid, head_ref, created_at, updated_at)
        VALUES ('app', ?, 'pr', 'OPEN', ?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(n, `PR ${n}`, author, o.authorId !== undefined ? o.authorId : author === "regular" ? REGULAR_ID : null, o.lines ?? 20, head, `fix-${n}`, T0, T0);
      await db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', ?, ?, ?, '{"top":0.95}')`)
        .run(n, T0, o.label ?? "bugfix", JSON.stringify(o.flags ?? []));
      await db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
        VALUES ('app', ?, ?, 'OPEN', 0, ?, ?, ?, ?, ?)`).run(n, head, o.ci ?? "success", o.ci === "failure" ? JSON.stringify([{ name: CHECK, state: "failure" }]) : "[]", o.mergeable ?? "MERGEABLE", o.canModify === false ? 0 : 1, T1);
      live.set(n, { head, state: "OPEN", mergeable: o.mergeable ?? "MERGEABLE", ci: o.ci ?? "success", authors: [o.author ?? "regular"], assignees: [] });
      return w;
    },
    /** Sync saw a push: the PR has a new head, with green checks at it. */
    async synced(n: number, head: string) {
      await db.prepare("UPDATE items SET head_oid = ? WHERE repo = 'app' AND number = ?").run(head, n);
      await db.prepare("UPDATE pr_checks SET head_oid = ?, overall = 'success', mergeable = 'MERGEABLE', fetched_at = ? WHERE repo = 'app' AND number = ?").run(head, T1, n);
      live.get(n)!.head = head;
      return w;
    },
    /** An open issue with its classification. */
    async issue(n: number, o: IssueOpts = {}) {
      await db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('app', ?, 'issue', 'OPEN', ?, ?, 'someone', ?, ?)")
        .run(n, o.title ?? "Panic when the slice is empty", o.body ?? "first() indexes element 0.", T0, T0);
      await db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', ?, ?, ?, ?)`)
        .run(n, T0, o.label ?? "bugfix", JSON.stringify(o.flags ?? []), JSON.stringify({ top: 0.97, ...(o.flags?.includes("needs decision") ? { needs_decision: 0.9 } : {}) }));
      if (o.impact) await db.prepare("INSERT INTO item_priority (repo, number, text_hash, impact, score, model, at) VALUES ('app', ?, 'h', ?, 0, 'jev', ?)").run(n, o.impact, T0);
      live.set(n, { head: "", state: "OPEN", mergeable: "UNKNOWN", ci: "success", authors: [], assignees: [] });
      return w;
    },

    // ---- what the stages write ----
    /** The Opus review of the PR (at its head by default). */
    async review(n: number, o: ReviewOpts = {}) {
      const verdict = o.verdict ?? "take";
      const fixes = o.fixes ?? (verdict === "take-fix" ? [{ file: "src/lib.rs", change: "rename a to b" }] : []);
      await db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', ?, ?, 'rv', ?, 'm', ?, ?, ?, ?, 'full')`)
        .run(n, o.head ?? await headOf(n), T0, verdict, o.reason ?? "looks right", fixes.length ? JSON.stringify(fixes) : null, o.sure === false ? 0 : 1);
      return w;
    },
    /** A review at `head` that finds the author's new commits beyond what was approved (the review round, src/workflow/advance.ts). */
    async outOfScope(n: number, head: string) {
      await db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, sure, mode, workflow, public_review) VALUES ('app', ?, ?, 'rv', ?, 'm', 'take', 'r', 1, 'full', ?, ?)`)
        .run(n, head, new Date().toISOString(), JSON.stringify({ outside_purpose: null, recommendation: null, author_commits: { in_scope: false, note: "adds an exporter" } }), JSON.stringify({ summary: "The new commits add a file exporter.", points: [] }));
      return w;
    },
    /** The verification result at the head. */
    async verified(n: number, state = "passed") {
      await db.prepare("INSERT INTO verifications (repo, number, head_sha, kind, reason, state, created_at) VALUES ('app', ?, ?, 'tests', 'r', ?, ?)").run(n, await headOf(n), state, T0);
      return w;
    },
    /** The pre-merge review at the head: clean, or with one defect (a fix when `fixable`; without `blocking` it is unclassed, as rows stored before the class). */
    async premerge(n: number, kind: "clean" | "defect", fixable = true, title = "off by one", blocking?: PremergeFinding["blocking"]) {
      const findings: PremergeFinding[] = kind === "clean" ? [] : [{ severity: "defect", file: "src/lib.rs", line: 3, title, scenario: "an empty list panics", ...(fixable ? { fix: { file: "src/lib.rs", change: "check the bound" } } : {}), ...(blocking ? { blocking } : {}) }];
      await savePremerge(db, { repo: "app", number: n, head: await headOf(n), at: T0, runId: "pm", model: "test", findings, searched: "" });
      // The real pre-merge review caches the diff it read; the merge rule reads it from there.
      mkdirSync(join(diffCacheDir(), "app"), { recursive: true });
      writeFileSync(join(diffCacheDir(), "app", `${n}-${await headOf(n)}.diff`), "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+y\n");
      await recordDiffFacts(db, "app", n, await headOf(n));
      return w;
    },
    /** The PR's automatic pre-merge fix-up rounds are used up (PREMERGE_FIX_ROUNDS failed rows). */
    async premergeRoundsSpent(n: number) {
      for (let i = 0; i < PREMERGE_FIX_ROUNDS; i++) await db.run(db.k.insertInto("main.fixups").values({ repo: "app", number: n, from_head: `spent${i}`, state: "failed", attempt: 1, created_at: T0, source: "premerge" }));
      return w;
    },
    // ---- models ----
    /** Starts a fake Task Runner (test/fake-runner.ts): it gets each call's prompt text and returns the reply text, or undefined for "no reply". */
    async models(reply: (input: string) => string | undefined) {
      const runner = await fakeTaskRunner(db, (c) => reply(c.stdin));
      restore.push(() => void runner.stop());
      return w;
    },

    // ---- reading back ----
    /** The planner's pass: every PR and item decided once. */
    async plan(): Promise<PlanSet> { return await loadPlanSet(db); },
    /** The Plan of one PR. */
    async prPlan(n: number) { return (await loadPlanSet(db)).prs.find((p) => p.facts.number === n)!.plan; },
    rows: async (sql: string, ...args: (string | number)[]) => (await db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({ ...r })),
    close() { for (const r of restore.splice(0)) r(); },
  };
  return w;
}
export type World = Awaited<ReturnType<typeof world>>;
