// Default-branch fix rows (`main_fixes`).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { itemNotMirrored, openItem } from "../mirror/fragments.ts";
import { num, push, refKey, rowsOf } from "./rows.ts";
import type { MainFixRow, MainFixVerdict, RefKey } from "./types.ts";

type Head = { repo: string; headSha: string };
type MainFixDue = { rows: { check: string; state: string; updatedAt: string }[]; lintingHeads: { headSha: string; lintTask: number | null }[]; staleNeedsFix: boolean; /** The repo holds an `issue-opening` row at any head. */ opening: boolean };

const COLS = ["repo", "head_sha", "check", "verdict", "state", "reason", "run_id", "run_url", "excerpt", "issue_number", "pr_number", "pr_url", "patch", "files", "lint_task", "lint_round", "lint_state", "session", "created_at", "updated_at"] as const;

const rowOf = (r: any): MainFixRow => ({
  repo: r.repo, headSha: r.head_sha, check: r.check, verdict: r.verdict as MainFixVerdict, state: r.state, reason: r.reason, runId: num(r.run_id), runUrl: r.run_url, excerpt: r.excerpt,
  issueNumber: num(r.issue_number), prNumber: num(r.pr_number), prUrl: r.pr_url, patch: r.patch, files: r.files, lintTask: num(r.lint_task), lintRound: num(r.lint_round), lintState: r.lint_state,
  session: r.session, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Rows at the given heads (by repo, head, check), or a repo's rows in `states` (optionally of one verdict or head; by created time,
 * head, check). 1 statement per 10,000 heads.
 */
export async function loadMainFixes(db: Db, q: { heads: Head[] } | { repo: string; states: string[]; verdict?: string; head?: string }): Promise<MainFixRow[]> {
  const k = queryDb(db).k as any;
  if ("heads" in q) {
    const out: MainFixRow[] = [];
    for (const part of kx.chunks(q.heads)) {
      out.push(...(await rowsOf<any>(db, k.selectFrom("main.main_fixes").select([...COLS]).where(kx.tupleIn(db, ["repo", "head_sha"], part.map((h) => [h.repo, h.headSha]), ["text", "text"]))
        .orderBy("repo").orderBy("head_sha").orderBy("check"))).map(rowOf));
    }
    return out;
  }
  if (!q.states.length) return [];
  let sel = k.selectFrom("main.main_fixes").select([...COLS]).where("repo", "=", q.repo).where(kx.inList(db, "state", q.states));
  if (q.verdict !== undefined) sel = sel.where("verdict", "=", q.verdict);
  if (q.head !== undefined) sel = sel.where("head_sha", "=", q.head);
  return (await rowsOf<any>(db, sel.orderBy("created_at").orderBy("head_sha").orderBy("check"))).map(rowOf);
}

/**
 * What `mainFixDue` and `lintReady` need for every red head at once; key is `repo@headSha`. 3 statements in one wave: the rows at the
 * heads, the repos' `linting` rows, the repos that hold a `needs-fix` or `issue-opening` row at any head. `staleNeedsFix` is true when the repo has such
 * a row and the head is not running (a row left at needs-fix by an older head is closed by the next run).
 */
export async function loadMainFixDue(db: Db, heads: (Head & { running: boolean })[]): Promise<Map<string, MainFixDue>> {
  const out = new Map<string, MainFixDue>();
  if (!heads.length) return out;
  const k = queryDb(db).k as any;
  const repos = [...new Set(heads.map((h) => h.repo))];
  const [rows, linting, needs] = await db.together(() => Promise.all([
    rowsOf<any>(db, k.selectFrom("main.main_fixes").select(["repo", "head_sha", "check", "state", "updated_at"]).where(kx.tupleIn(db, ["repo", "head_sha"], heads.map((h) => [h.repo, h.headSha]), ["text", "text"]))
      .orderBy("repo").orderBy("head_sha").orderBy("check")),
    rowsOf<any>(db, k.selectFrom("main.main_fixes").select(["repo", "head_sha", "lint_task"]).where(kx.inList(db, "repo", repos)).where("state", "=", "linting").orderBy("created_at").orderBy("head_sha").orderBy("check")),
    rowsOf<any>(db, k.selectFrom("main.main_fixes").select(["repo", "state"]).distinct().where(kx.inList(db, "repo", repos)).where("state", "in", ["needs-fix", "issue-opening"])),
  ]));
  const withState = (state: string) => new Set(needs.filter((r) => r.state === state).map((r) => r.repo as string));
  const needing = withState("needs-fix"), opening = withState("issue-opening");
  const lintingBy = new Map<string, { headSha: string; lintTask: number | null }[]>();
  for (const r of linting) push(lintingBy, r.repo, { headSha: r.head_sha, lintTask: num(r.lint_task) });
  const rowsBy = new Map<string, { check: string; state: string; updatedAt: string }[]>();
  for (const r of rows) push(rowsBy, `${r.repo}@${r.head_sha}`, { check: r.check, state: r.state, updatedAt: r.updated_at });
  for (const h of heads) out.set(`${h.repo}@${h.headSha}`, { rows: rowsBy.get(`${h.repo}@${h.headSha}`) ?? [], lintingHeads: lintingBy.get(h.repo) ?? [], staleNeedsFix: !h.running && needing.has(h.repo), opening: opening.has(h.repo) });
  return out;
}

/** The fix PRs of ours that exist, as refs (`repo#number`), of `repos` or of every repo. 1 statement. */
export async function loadMainFixPrs(db: Db, repos?: string[]): Promise<Set<RefKey>> {
  if (repos && !repos.length) return new Set();
  const k = queryDb(db).k as any;
  let sel = k.selectFrom("main.main_fixes").select(["repo", "pr_number"]).distinct().where("pr_number", "is not", null);
  if (repos) sel = sel.where(kx.inList(db, "repo", repos));
  return new Set((await rowsOf<any>(db, sel)).map((r) => refKey(r.repo, Number(r.pr_number))));
}

/**
 * The lowest number of our own fix PR for the repo that is still open and was updated at or after `since`, or null. A PR the
 * mirror has no row of counts as open: it was just opened.
 */
export async function loadOpenFixPr(db: Db, repo: string, since: string): Promise<number | null> {
  const k = queryDb(db).k as any;
  const r = (await rowsOf<any>(db, k.selectFrom("main.main_fixes as f").select((eb: any) => eb.fn.min("f.pr_number").as("n"))
    .where("f.repo", "=", repo).where("f.state", "=", "pr-opened").where("f.pr_number", "is not", null).where("f.updated_at", ">=", since)
    // reads: mirror.items (open item fragment)
    .where((eb: any) => eb.or([openItem(eb, "f.repo", "f.pr_number"), itemNotMirrored(eb, "f.repo", "f.pr_number")]))))[0];
  return r?.n === null || r?.n === undefined ? null : Number(r.n);
}

/** Rows in a state, optionally only those created at or after `since`. */
export async function countMainFixes(db: Db, f: { state: string; since?: string }): Promise<number> {
  const k = queryDb(db).k as any;
  let sel = k.selectFrom("main.main_fixes").select((eb: any) => eb.fn.countAll().as("n")).where("state", "=", f.state);
  if (f.since !== undefined) sel = sel.where("created_at", ">=", f.since);
  const r = (await rowsOf<any>(db, sel))[0];
  return Number(r?.n ?? 0);
}

/** Removes the rows of one head and check. 1 statement. */
export async function dropMainFix(db: Db, key: Head & { check: string }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run((q.k as any).deleteFrom("main.main_fixes").where("repo", "=", key.repo).where("head_sha", "=", key.headSha).where("check", "=", key.check));
  });
}

/**
 * Multi-row upsert keyed by (repo, head, check): 1 statement per 500 rows. A row that exists keeps its `created_at`; every other
 * column takes the new value and `updated_at` is `at`. Callers collect the rows of a head and write once.
 */
export async function saveMainFixes(db: Db, rows: MainFixRow[], at: string): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(rows)) {
      await q.run((q.k as any).insertInto("main_fixes")
        .values(part.map((r) => ({
          repo: r.repo, head_sha: r.headSha, check: r.check, verdict: r.verdict, state: r.state, reason: r.reason, run_id: r.runId, run_url: r.runUrl, excerpt: r.excerpt, issue_number: r.issueNumber,
          pr_number: r.prNumber, pr_url: r.prUrl, patch: r.patch, files: r.files, lint_task: r.lintTask, lint_round: r.lintRound, lint_state: r.lintState, session: r.session, created_at: r.createdAt, updated_at: at,
        })))
        .onConflict((oc: any) => oc.columns(["repo", "head_sha", "check"]).doUpdateSet(kx.excluded([
          "verdict", "state", "reason", "run_id", "run_url", "excerpt", "issue_number", "pr_number", "pr_url", "patch", "files", "lint_task", "lint_round", "lint_state", "session", "updated_at",
        ]))));
    }
  });
}
