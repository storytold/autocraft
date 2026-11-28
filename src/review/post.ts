// Stage 5, Review, last part: posts the final Opus review of a PR as one pull request
// review (event COMMENT: never an approval or a change request) in repos approved for
// comments. One review per PR: a later Opus review at a new head edits it.
//
//   autocraft-server review-post --repo R [--limit N] [--apply]
//
// Without --apply it is a dry run: it reads the local tables only and lists what would be posted.
import { type Note, editReview, postReview, type Writer } from "../github/write.ts";
import { guard } from "../core/guard.ts";
import { auditIdentity, githubIdentity } from "../github/identity.ts";
import { ownerOf } from "../owners.ts";
import { planned, runnable } from "../core/select.ts";
import { isQueueState, type PrFacts } from "../core/plan.ts";
import { fixesToMake, followUpClaims, outsideText, reviewFollowUps } from "../core/review-blocking.ts";
import { claimFindings } from "../premerge/parse.ts";
import { mayRun } from "../core/authority.ts";
import { partTitle } from "../workflow/work.ts";
import { CLI_BY, mergeAllowed, pushAllowed, type By } from "../core/gates.ts";
import { Client, GithubError, type Querier } from "../mirror.ts";
import { prInfo } from "../merge/index.ts";
import { postSourcesOf, type PostSource } from "./post-source.ts";
import { loadPosts, saveReviewPosts } from "../data/review/index.ts";
import { reviewBody, recommendation } from "./post-template.ts";
import { jobItem } from "../runner/job-items.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

const ACTOR = "review-post";
const REVIEW_NOTE = (c: { model: string | null }): Note => ({ by: "model", kind: "review", model: c.model });

export type PostCandidate = {
  repo: string; number: number; head_oid: string; body: string;
  /** The model of the Opus review the body describes (named in the note line). */
  model: string | null;
  /** The id of our earlier review of this PR (at another head), to edit; null for a first post. */
  editId: string | null;
  /** The `at` of the Opus review the body describes. */
  opusAt: string;
};
export type PostSummary = { repo: string; dryRun: boolean; candidates: number; posted: string[]; edited: string[]; skipped: { ref: string; reason: string }[]; failed: { ref: string; reason: string }[]; note: string | null };
/** `approved`: only PRs a person started or approved for merge (the step's approved lane), or only the others; absent: every PR. `number`: only this PR. */
export type PostParams = { repo: string; limit?: number; approved?: boolean; number?: number; dryRun?: boolean; onHandled?: (n: number) => void; by?: By };
export type PostDeps = { querier: Querier; now: () => Date };

export const defaultPostDeps = (): PostDeps => ({ querier: new Client(1000), now: () => new Date() });

/**
 * Open PRs of `repo` whose Plan holds a `post-review` action: an Opus review (with public text unless it edits an earlier post) at
 * their current head that no review of ours describes yet. The Plan leaves out PRs by the pipeline's own account, batch PRs,
 * items outside the pipeline's scope.
 */
export const postCandidates = async (db: Db, repo: string, by: By = CLI_BY): Promise<PostCandidate[]> => (await postsDue(db, repo, by)).due;

/** postCandidates (of one lane and PR, as PostParams says), and why the other reviews to post are held back (null: none is). */
async function postsDue(db: Db, repo: string, by: By, only: Pick<PostParams, "approved" | "number"> = {}): Promise<{ due: PostCandidate[]; held: string | null }> {
  // A review is edited only by the lane that posted it: a NULL `posted_as` is a row from before it was recorded, written by the box account.
  const lane = (as: string | null | undefined): "legacy" | "app" => (as && as !== "legacy" ? "app" : "legacy");
  const nowLane = await githubIdentity(db) === "app" ? "app" : "legacy";
  const out: PostCandidate[] = [];
  const due = (await planned(db, "post-review", { repo, refused: true, ...(only.approved !== undefined ? { approved: only.approved } : {}) })).filter((p) => only.number === undefined || p.facts.number === only.number);
  const { may: rows, held } = runnable(due, by);
  const refs = rows.map((p) => ({ repo, number: p.facts.number }));
  const [posts, source] = await Promise.all([loadPosts(db, refs), postSourcesOf(db, refs.map((r) => `${r.repo}#${r.number}`))]);
  for (const { facts: f, plan, action } of rows) {
    const head = action.head!;
    const o = await source(repo, f.number, head);
    if (!o) continue;
    // A newer review with no public text still edits an earlier post, so the verdict line stays current.
    const pub = o.public;
    if (!pub) continue;
    const prev = posts.get(`${repo}#${f.number}`);
    const editId = prev && lane(prev.posted_as) === nowLane ? prev.review_id ?? null : null;
    const fu = postFollowUps(o, f);
    out.push({
      repo, number: f.number, head_oid: head, editId, opusAt: o.at, model: o.model,
      body: reviewBody({
        verdict: o.sourceVerdict, sure: o.sure, summary: pub.summary, points: pub.points, claims: o.claims, head: o.reviewedAt, owner: ownerOf(repo), fixedIn: o.fixedIn, followUps: fu,
        recommendation: recommendation({
          verdict: o.verdict, queue: o.verdict === "take" && isQueueState(plan.state) ? { path: plan.path, state: plan.state } : null, mergeApproved: mergeAllowed(f), canPush: f.pushable && pushAllowed(f, "fixup"),
          followUps: fu ? { blocking: fu.fixes.length, later: fu.later.length, filed: !fu.notFiled } : null,
        }),
      }),
    });
  }
  return { due: out, held };
}

/**
 * On a PR approved for merge, what the review's post lists apart: the fixes made before the merge, and the fixes, hold and claims
 * covered only in part that do not block it and are filed as a follow-up issue (src/core/review-blocking.ts). Null elsewhere, or when nothing is filed.
 */
function postFollowUps(o: PostSource, f: PrFacts): { fixes: string[]; later: string[]; notFiled: string | null } | null {
  if (!f.workflow?.approved) return null;
  const fu = reviewFollowUps({ verdict: o.sourceVerdict, fixes: o.fixes, hold: o.hold, blockedBy: o.blockedBy, outside: o.outside }, f.workflow.dropped);
  const claims = claimFindings(followUpClaims({ ...o, verdict: o.sourceVerdict }, f.review?.verdict === "take" || f.review?.verdict === "take-fix"), []).map((x) => x.title);
  const later = [...fu.fixes.map(partTitle), ...(fu.hold ? [fu.hold] : []), ...(fu.outside ? [outsideText(fu.outside)] : []), ...claims];
  if (!later.length) return null;
  // The same gate as the filing itself (src/core/decide.ts reviewFollowUpsDue): a refused one says why.
  const may = mayRun({ facts: f, action: { kind: "followups", head: f.head } }, "pipeline");
  return { fixes: fixesToMake(o.fixes, f.workflow.dropped, true).map(partTitle), later, notFiled: may.ok ? null : may.why.text };
}

/** Whether an edit failed because the review no longer exists or the token may not edit it. */
function reviewUneditable(e: unknown): boolean {
  if (e instanceof GithubError && (e.type === "NOT_FOUND" || e.type === "FORBIDDEN")) return true;
  return /Could not resolve to a node|NOT_FOUND|FORBIDDEN/.test(String((e as Error)?.message ?? e));
}

const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export async function runReviewPost(db: Db, params: PostParams, log: (line: string) => void = console.log, deps?: PostDeps): Promise<PostSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const s: PostSummary = { repo, dryRun, candidates: 0, posted: [], edited: [], skipped: [], failed: [], note: null };
  const { due, held } = await postsDue(db, repo, params.by ?? CLI_BY, params);
  if (held) {
    s.note = held;
    log(`review-post ${repo}: ${held}`);
  }
  let todo = due;
  s.candidates = todo.length;
  if (params.limit !== undefined) todo = todo.slice(0, params.limit);
  if (dryRun) {
    for (const c of todo) log(`  would ${c.editId ? "edit the review of" : "review"} ${refOf(c)} at ${c.head_oid.slice(0, 7)}:\n${c.body.replace(/^/gm, "    ")}`);
    log(`review-post ${repo}: dry run, ${todo.length} of ${s.candidates} candidates, nothing called or written`);
    return s;
  }
  const d = deps ?? defaultPostDeps();
  const w: Writer = { db, login: ACTOR };
  let handled = 0;
  for (const c of todo) {
    const skip = async (reason: string) => { s.skipped.push({ ref: refOf(c), reason }); await jobItem(db, c.repo, c.number, `skipped: ${reason}`, log); };
    try {
      const live = await prInfo(d.querier, repo, c.number);
      if (!live) { await skip("not found on GitHub"); continue; }
      if (live.state !== "OPEN") { await skip(`now ${live.state}`); continue; }
      if (live.head !== c.head_oid) { await skip(`head moved to ${live.head.slice(0, 7)}`); continue; }
      const g = await guard(db, { repo, number: c.number }, { kind: "post-review", head: c.head_oid }, params.by ?? CLI_BY);
      if ("refused" in g) { await skip(g.refused); continue; }
      const at = d.now().toISOString();
      const as = await auditIdentity(db, g);
      let edited = false;
      if (c.editId) {
        try {
          await editReview(w, d.querier, g, c.editId, REVIEW_NOTE(c), c.body);
          await saveReviewPosts(db, [{ kind: "edited", repo, number: c.number, head: c.head_oid, edited_at: at, opus_at: c.opusAt, posted_as: as }]);
          s.edited.push(refOf(c));
          edited = true;
        } catch (e) {
          // The review is gone, or this token may not edit it: post a fresh one and replace the row.
          if (!reviewUneditable(e)) throw e;
        }
      }
      if (!edited) {
        const id = await postReview(w, d.querier, g, live.id, REVIEW_NOTE(c), c.body);
        if (!id) throw new Error("GitHub returned no review");
        // Every column is written: a fresh post clears the edit time of the review it replaces.
        await saveReviewPosts(db, [{ kind: "posted", repo, number: c.number, review_id: id, head: c.head_oid, posted_at: at, edited_at: null, opus_at: c.opusAt, posted_as: as }]);
        s.posted.push(refOf(c));
      }
      await jobItem(db, c.repo, c.number, `${edited ? "edited" : "posted"} review at ${c.head_oid.slice(0, 7)}`, log);
      params.onHandled?.(++handled);
    } catch (e) {
      const reason = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);
      s.failed.push({ ref: refOf(c), reason });
      await jobItem(db, c.repo, c.number, `failed: ${reason}`, log);
    }
  }
  log(`review-post ${repo}: ${s.posted.length} posted, ${s.edited.length} edited, ${s.skipped.length} skipped, ${s.failed.length} failed`);
  return s;
}

export const commands = {
  "review-post": {
    summary: "review-post --repo R [--limit N] [--apply]: post the final Opus reviews as PR reviews (dry run without --apply)",
    async run(args: string[]): Promise<void> {
      let repo: string | undefined, limit: number | undefined, apply = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--apply") apply = true;
        else if (a === "--dry-run") apply = false;
        else if (a === "--repo") repo = args[++i];
        else if (a === "--limit") limit = Number(args[++i]);
        else throw new Error(`unknown option ${a}; options: --repo R --limit N --apply --dry-run`);
      }
      if (!repo) throw new Error("missing --repo");
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit is a positive whole number");
      await runReviewPost(await openDb(), { repo, limit, dryRun: !apply });
    },
  },
};
