// Post-merge review: Opus reads what a pipeline merge landed, with the pipeline's own commits and reviews of the PR, and
// lists defects and minor findings. One review per merged PR. Reads GitHub (the merged diff); writes only to the local
// database. Filing the defects is src/postmerge/file.ts.
import { poolRoom, takersCut } from "../agents/call.ts";
import { pool } from "../classify/run.ts";
import { runModelStep } from "../agents/step.ts";
import { POSTMERGE_OPUS } from "../agents/steps.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, type SemanticDeps } from "../reference-lint.ts";
import { codeDiff, ghMerged, type MergedFetcher } from "../review/diff.ts";
import { MAX_DIFF_CHARS } from "../review/opus.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForCommit, checkoutForPr } from "../sandbox/index.ts";
import { MAX_MERGED_DIFF_CHARS, type FiledBefore, type Finding, type PostmergeCommit, type PostmergePr } from "./parse.ts";
import { relatedOpen, reviewHistory } from "./related.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { planned } from "../core/select.ts";
import { mergedPr, selectPostmerge, type MergedPr } from "./select.ts";
import { jobItem } from "../runner/job-items.ts";
import { flatMapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { addAudit, tripMergeBreakers, writeSetting } from "../data/control/index.ts";
import { loadPushEdges } from "../data/changes/index.ts";
import { loadMergedInfo } from "../data/merge/index.ts";
import { loadItems, loadShown } from "../data/mirror/index.ts";
import { loadFollowups, savePostmerge } from "../data/review/index.ts";

const PROMPT = CLAUDE_PROMPTS["postmerge.opus"];
const now = () => new Date().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export type PostmergeParams = {
  repo: string; limit?: number;
  /** Review these PRs of the repo whether or not they have a review (the `--again` command). */
  only?: number[];
  onHandled?: (n: number) => void;
  /** Who asked; a command-line run is an operator's. */
  by?: By;
};
export type PostmergeDeps = {
  fetchMerged: MergedFetcher; model: string; maxChars: number;
  /** Host directory with a read-only checkout of `sha` for a sandboxed call, or null to ask without tools. Absent: no tools. `head` is the PR's last head, the fallback when GitHub names no merge commit. */
  checkout?: (repo: string, number: number, sha: string | null, head: string) => Promise<string | null>;
  semantic?: SemanticDeps;
};
export type PostmergeSummary = { runId: string; repo: string; candidates: number; reviewed: number; findings: number; defects: number; failed: string[] };

export function defaultPostmergeDeps(db: Db): PostmergeDeps {
  return {
    fetchMerged: ghMerged, model: PROMPT.models[0]!, maxChars: Math.min(MAX_DIFF_CHARS, MAX_MERGED_DIFF_CHARS),
    checkout: async (repo, number, sha, head) => {
      if (!sha) return checkoutForPr(repo, number, head, console.log);
      const { branchOf } = await import("../github/fork.ts");
      return checkoutForCommit(repo, await branchOf(db, repo), sha, console.log);
    },
  };
}

/** Commits the pipeline added to the PR: conflict merges, fix-ups and CI fixes that moved its head, oldest first. */
async function pipelineCommits(db: Db, repo: string, number: number): Promise<PostmergeCommit[]> {
  const KIND = { conflict: ["conflict-merge", "merged the base branch into the PR"], fixup: ["fix-up", "pushed the fixes of the review"], cifix: ["ci-fix", "pushed a fix for the failing CI check"] } as const;
  const edges = (await loadPushEdges(db, [{ repo, number }])).get(`${repo}#${number}`) ?? [];
  return edges.filter((e) => e.state === "pushed" || e.state === "merged")
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((e) => ({ kind: KIND[e.kind][0], sha: e.to, note: e.reason ?? KIND[e.kind][1] }));
}

/** Follow-up issues earlier reviews of the PR filed, with their current state; one still in `filing` has an unknown outcome. */
export async function filedBefore(db: Db, repo: string, number: number): Promise<FiledBefore[]> {
  const filed = ((await loadFollowups(db, [{ repo, number }])).get(`${repo}#${number}`) ?? []).filter((f) => f.state === "filed" || f.state === "filing");
  const shown = await loadShown(db, filed.flatMap((f) => (f.issue_number === null ? [] : [{ repo, number: f.issue_number }])));
  return filed.map((f) => {
    const it = f.issue_number === null ? undefined : shown.get(`${repo}#${f.issue_number}`);
    return { number: f.issue_number, state: f.state === "filing" ? "unknown" as const : it?.state === "open" || !it ? "open" as const : "closed" as const, title: f.title };
  });
}

type Prepared = { kind: "ready"; input: PostmergePr; sha: string | null } | { kind: "error"; error: string };

async function prepare(db: Db, c: MergedPr, deps: PostmergeDeps): Promise<Prepared> {
  const d = await deps.fetchMerged(c.repo, c.number, { batch: c.batch === 1 });
  if (!d.ok) return { kind: "error", error: d.tooLarge ? "held: too large to review automatically" : `retry: no merged diff: ${d.error}` };
  let cd = codeDiff(d.text);
  if (!cd.files.length && cd.testsOmitted.length) cd = codeDiff(d.text, true);
  if (!cd.files.length) return { kind: "error", error: "held: the merge changed no code files" };
  if (cd.text.length > deps.maxChars) return { kind: "error", error: "held: too large to review automatically" };
  const it = (await loadItems(db, [{ repo: c.repo, number: c.number }], "text")).get(refOf(c));
  const input: PostmergePr = {
    ref: refOf(c), title: it?.title ?? "", body: it?.body ?? "", author: it?.author ?? null, merge_sha: d.sha ?? c.head_oid, method: c.method,
    files: cd.files, tests_omitted: cd.testsOmitted, lockfiles_omitted: cd.lockfilesOmitted,
    pipeline_commits: await pipelineCommits(db, c.repo, c.number), review_history: await reviewHistory(db, c.repo, c.number),
    related_open: await relatedOpen(db, c.repo, c.number, cd.files), filed_before: await filedBefore(db, c.repo, c.number), diff: cd.text,
  };
  return { kind: "ready", input, sha: d.sha };
}

/**
 * Stores the review and one `postmerge_followups` row for each finding that is never filed: a minor one (skipped-minor)
 * or a defect another item already covers (skipped-duplicate). A review that replaces an earlier one keeps the earlier
 * one's follow-up rows, so the PR's filed follow-ups stay known. A `retry:` error is stored as held at the third try.
 */
export async function saveReview(db: Db, c: { repo: string; number: number }, r: { sha: string; runId: string | null; model: string | null; findings: Finding[] | null; error: string | null; at?: string }): Promise<void> {
  const ref = refOf(c);
  const merged = (await loadMergedInfo(db, [c])).get(ref);
  await db.write(async () => {
    const { defects } = await savePostmerge(db, [{ repo: c.repo, number: c.number, merge_sha: r.sha, at: r.at ?? now(), model: r.model, run_id: r.runId, findings: r.findings as never, error: r.error }]);
    const n = defects.get(ref) ?? 0;
    if (n > 0 && merged) {
      await tripMergeBreakers(db, [{ repo: c.repo, number: c.number, mergedAt: merged.lastAt, reason: `the post-merge review of ${ref} found ${n} defect${n === 1 ? "" : "s"}`, evidence: [ref] }]);
    }
  });
}

export async function runPostmerge(db: Db, params: PostmergeParams, log: (line: string) => void = console.log, deps: PostmergeDeps = defaultPostmergeDeps(db)): Promise<PostmergeSummary> {
  const { repo } = params;
  const runId = `postmerge-${repo}-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  let cands: MergedPr[] = params.only ? await flatMapSeq(params.only, async (n) => { const m = await mergedPr(db, repo, n); return m ? [m] : []; }) : await selectPostmerge(db, repo, undefined, undefined, undefined, params.by);
  const s: PostmergeSummary = { runId, repo, candidates: cands.length, reviewed: 0, findings: 0, defects: 0, failed: [] };
  cands = await takersCut(db, cands, params.limit, repo, (c) => c.number);
  if (!cands.length) { log(`postmerge ${repo}: nothing to review`); return s; }
  let handled = 0;
  await pool(cands.map((c) => async () => {
    const p = await prepare(db, c, deps);
    if (p.kind === "error") {
      await jobItem(db, repo, c.number, p.error, log);
      await saveReview(db, c, { sha: c.head_oid, runId, model: null, findings: null, error: p.error });
      params.onHandled?.(++handled);
      return;
    }
    const { input } = p;
    const checkout = (await deps.checkout?.(repo, c.number, p.sha, c.head_oid)) ?? undefined;
    if (checkout) input.repo_dir = REPO_PATH;
    const dir = referenceDir(repo);
    const semantic = dir ? deps.semantic ?? defaultSemanticDeps(db, input.ref) : undefined;
    const r = await runModelStep(db, POSTMERGE_OPUS, input, {
      model: deps.model, checkout, reference: checkout ? dir : undefined, ctx: { dir, semantic },
      usage: { run: runId, agent: `postmerge-${refOf(c).replace("#", "-")}`, stage: "postmerge", items: (ok) => (ok ? 1 : 0) },
      onReply: (reply) => { if (reply.fixTurn) log(`  ${refOf(c)}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`); },
    });
    const got: Finding[] | null = r.ok ? r.value : null;
    if (got) {
      await saveReview(db, c, { sha: input.merge_sha, runId, model: (r.ok && r.model) || deps.model, findings: got, error: null });
      await jobItem(db, repo, c.number, `post-merge review: ${got.length} findings`, log);
      s.reviewed++; s.findings += got.length; s.defects += got.filter((f) => f.severity === "defect").length;
    } else {
      await jobItem(db, repo, c.number, "no valid post-merge review", log);
      await saveReview(db, c, { sha: input.merge_sha, runId, model: deps.model, findings: null, error: "retry: no valid reply from the model" });
      s.failed.push(refOf(c));
    }
    params.onHandled?.(++handled);
  }), poolRoom(db, () => [repo], (i) => [{ repo, number: cands[i]!.number }]));
  log(`postmerge ${repo}: ${s.reviewed} reviewed, ${s.findings} findings (${s.defects} defects), ${s.failed.length} without an answer`);
  return s;
}

/** A backfill reaching further back than this needs the operator's confirmation. */
export const BACKFILL_FREE_DAYS = 14;

export async function queueBackfill(db: Db, by: string, since: string, o: { yes?: boolean; now?: number } = {}): Promise<number> {
  const iso = new Date(since).toISOString();
  const days = ((o.now ?? Date.now()) - Date.parse(iso)) / 86400_000;
  if (days > BACKFILL_FREE_DAYS && !o.yes) throw new Error(`--since is ${Math.floor(days)} days back; every PR merged since then that needs a post-merge review gets a model review and its defects are filed publicly. Add --yes to confirm`);
  await db.write(async () => {
    await writeSetting(db, "postmerge_since", iso);
    await addAudit(db, [{ login: by, action: "postmerge-backfill", target: null, details: { since: iso, confirmed: o.yes === true } }]);
  });
  return (await planned(db, "postmerge", { now: o.now ?? Date.now(), by: CLI_BY })).length;
}

export { RELATED_CLOSED_DAYS, relatedOpen } from "./related.ts";
