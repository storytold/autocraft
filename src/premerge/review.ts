// Pre-merge review: Opus reads, independently of the first review, the head commit of each PR the merge rule would merge
// without a person, and lists defects and minor findings. One call per PR head; on a PR a person approved for merge, only at a head
// some review since the full one read new code at (src/review/carry.ts carriedPremerges stores the others' rows with no call).
// Reads GitHub (the diff); writes only to the local database. What the findings do to the PR is the merge queue (src/merge/queue.ts)
// and the fix-up route.
import { poolRoom, takersCut } from "../agents/call.ts";
import { pool } from "../classify/run.ts";
import { runModelStep } from "../agents/step.ts";
import { REFUSED_PREFIX } from "../remote/calls.ts";
import { PREMERGE_OPUS } from "../agents/steps.ts";
import { buildQueue } from "../merge/queue.ts";
import { workflowOf } from "../core/decide.ts";
import { mergePermission } from "../core/authority.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { laneMismatch, notDue, planned, planNow } from "../core/select.ts";
import { EXTRAS_PENDING_REASON } from "../core/sensitive.ts";
import { loadPass } from "../core/facts.ts";
import type { PlanSet } from "../core/plan-set.ts";
import type { PrFacts } from "../core/plan.ts";
import { premergeRetryAt, RETRY_AFTER_MS } from "../core/rules.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, type SemanticDeps } from "../reference-lint.ts";
import { defaultOpusDeps, prepareOpusInput, type OpusDeps } from "../review/opus.ts";
import { REREADS_PER_HOUR, coreRate, pauseRereads, rereadDiff, takeRereadSlot } from "../review/diff.ts";
import { SYNC_RESERVE } from "../mirror.ts";
import { ownerOf } from "../owners.ts";
import { recordLiveBase } from "../merge/base.ts";
import { carriedPremerges } from "../review/carry.ts";
import { opusCandidateOf, type OpusCandidate } from "../review/opus-candidates.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { type PremergeReview } from "./parse.ts";
import { notBlocking } from "./types.ts";
import { loadItems } from "../data/mirror/index.ts";
import { savePremerge as saveReviews } from "../data/review/index.ts";
import { jobItem } from "../runner/job-items.ts";
import { leaseItem } from "../runner/leases.ts";
import type { Db } from "../db/index.ts";

const PROMPT = CLAUDE_PROMPTS["premerge.opus"];
const now = () => new Date().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export type PremergeParams = {
  repo: string; limit?: number;
  /** Only this PR (the `--number` option). */
  number?: number;
  dryRun?: boolean;
  onHandled?: (n: number) => void;
  /** Who asked; a command-line run is an operator's. */
  by?: By;
  /** Only PRs approved for merge (the step's approved job), or only the others; absent: every PR. */
  approved?: boolean;
};
export type PremergeDeps = Pick<OpusDeps, "fetchDiff" | "model" | "maxChars" | "checkout" | "semantic"> & { now?: () => number };
export type PremergeSummary = { runId: string; repo: string; candidates: string[]; reviewed: number; /** Rows stored with no model call (carriedPremerges). */ carried: number; findings: number; /** Defects that block, or carry no class (which blocks). */ defects: number; /** Defects classed as not blocking: on a PR approved for merge they are filed as follow-ups. */ notBlocking: number; failed: string[]; moved: string[]; /** PRs that left the path that asked for the review (their diff keeps them outside the merge rule, or the plan changed): no model call. */ off: string[] };

export function defaultPremergeDeps(): PremergeDeps {
  const d = defaultOpusDeps();
  return { fetchDiff: d.fetchDiff, model: PROMPT.models[0]!, maxChars: d.maxChars, checkout: (r, n, h) => checkoutForPr(r, n, h, console.log) };
}

/** A PR due its pre-merge review: the head to review and the facts it was planned from. */
export type PremergeItem = { repo: string; number: number; head: string; facts: PrFacts };

/**
 * The PRs whose Plan holds a `premerge` action (the queue holds them in waiting-premerge and the head is due a try), in selection order.
 * `wake` collects when the failed tries are due again (ms): nothing in the data changes then, so the planner must be told.
 */
export async function premergeCandidates(db: Db, opts: { repo?: string; at?: number; wake?: number[]; run?: string | null; plans?: PlanSet; by?: By; approved?: boolean } = {}): Promise<PremergeItem[]> {
  const { wake, at, by = CLI_BY, ...rest } = opts;
  const pace = wake ? (opts.plans?.pass ?? loadPass(at)).rereadPaceAt : 0;
  return (await planned(db, "premerge", {
    ...rest, by, ...(at !== undefined ? { now: at } : {}),
    onPlan: wake ? (f, plan) => {
      const pm = f.premerge;
      const due = pm && !pm.hasFindings ? premergeRetryAt(pm) : null;
      if ((plan.state === "waiting-premerge" || f.operator?.premerge) && mergePermission(f).ok && due !== null) wake.push(due);
      if (f.diffPending) {
        const t = Math.max(f.diffPending.lastRead != null ? f.diffPending.lastRead + RETRY_AFTER_MS : 0, pace);
        if (t > f.now) wake.push(t);
      }
    } : undefined,
  })).map((p) => ({ repo: p.facts.repo, number: p.facts.number, head: p.action.head!, facts: p.facts }));
}

/** The Opus candidate of a due PR: its title, body, size and author association. */
export const candidateOf = async (db: Db, e: PremergeItem): Promise<OpusCandidate> => await opusCandidateOf(db, e.facts, e.head);

/** True while the queue still lists the PR at this head, open and not yet reviewed. */
const stillHead = async (db: Db, repo: string, number: number, head: string): Promise<boolean> =>
  (await buildQueue(db, { repo, refs: [`${repo}#${number}`], merged: "exclude" })).some((e) => e.head === head);

export async function runPremerge(db: Db, params: PremergeParams, log: (line: string) => void = console.log, deps: PremergeDeps = defaultPremergeDeps()): Promise<PremergeSummary> {
  const { repo } = params;
  const runId = `premerge-${repo}-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  let cands = await premergeCandidates(db, { repo, at: deps.now?.() ?? Date.now(), ...(params.by ? { by: params.by } : {}), ...(params.approved !== undefined ? { approved: params.approved } : {}) });
  if (params.number !== undefined) cands = cands.filter((e) => e.number === params.number);
  const s: PremergeSummary = { runId, repo, candidates: cands.map(refOf), reviewed: 0, carried: 0, findings: 0, defects: 0, notBlocking: 0, failed: [], moved: [], off: [] };
  cands = await takersCut(db, cands, params.limit, repo, (e) => e.number);
  if (params.dryRun || !cands.length) {
    log(`premerge ${repo}: ${s.candidates.length} candidates${params.dryRun ? "; dry run, nothing fetched or asked" : ""}`);
    return s;
  }
  const opusDeps: OpusDeps = { ...deps, fetchDelta: async () => ({ ok: false, tooLarge: false, error: "not used" }) };
  let handled = 0;
  const bases = await loadItems(db, cands.filter((e) => e.facts.diffPending).map((e) => ({ repo, number: e.number })), "pr");
  const carried = await carriedPremerges(db, cands.filter((e) => !e.facts.diffPending).map((e) => ({ repo, number: e.number, head: e.head })), runId, now());
  // Read once per pass, before the first re-read.
  let rateLowP: Promise<boolean> | undefined;
  // A job of one lane (src/runner/concurrency.ts) reviews a PR under the step's lease: the other lane's job of the repo may hold it.
  const leased = async (e: PremergeItem, fn: () => Promise<void>): Promise<void> => {
    if (params.approved === undefined) return await fn();
    const release = await leaseItem(db, `premerge:${refOf(e)}`, log);
    if (!release) return;
    try { await fn(); } finally { await release(); }
  };
  await pool(cands.map((e) => async () => await leased(e, async () => {
    const ref = refOf(e), head = e.head;
    const fail = async (error: string, final = false, lost = false) => {
      await jobItem(db, repo, e.number, error, log);
      await saveReviews(db, [{ repo, number: e.number, head, at: now(), runId, model: deps.model, error, final, ...(lost ? { lost } : {}) }]);
      s.failed.push(ref);
    };
    // A diff that waits for what the merge rule reads beside it is read again, with no model call, within the hour's re-reads
    // and only while the token keeps the sync's reserve of its core rate.
    if (e.facts.diffPending) {
      rateLowP ??= coreRate(ownerOf(repo)).then((rate) => {
        const low = !!rate && rate.remaining < SYNC_RESERVE;
        if (rate && low) pauseRereads(rate.resetAt);
        return low;
      });
      const rateLow = await rateLowP;
      if (rateLow || !takeRereadSlot(deps.now?.() ?? Date.now())) {
        await jobItem(db, repo, e.number, rateLow ? "diff re-read waits for GitHub's rate limit reset" : `diff re-read waits: ${REREADS_PER_HOUR} re-reads this hour`, log);
        params.onHandled?.(++handled);
        return;
      }
      const liveBase = bases.get(ref)?.base_ref;
      const d = await rereadDiff(db, repo, e.number, head, deps.fetchDiff, liveBase, deps.now?.() ?? Date.now());
      if (d.ok && d.base && liveBase !== undefined && d.base !== liveBase) await recordLiveBase(db, repo, e.number, head, d.base, { by: "premerge", keepDiff: true });
      await jobItem(db, repo, e.number, d.ok ? "diff read again for the merge rule" : `diff not read again: ${d.error}`, log);
      params.onHandled?.(++handled);
      return;
    }
    // A head of a PR approved for merge that owes no reading of its own gets its row without a model call.
    const kept = carried.get(`${ref}@${head}`);
    if (kept) {
      await saveReviews(db, [kept]);
      const n = kept.findings?.length ?? 0;
      await jobItem(db, repo, e.number, n ? `pre-merge review carried from an earlier head, no model call: ${n} findings` : "pre-merge review not owed since the full review: clean, no model call", log);
      s.carried++;
      params.onHandled?.(++handled);
      return;
    }
    // A person's approval does not read the diff's facts: only the merge rule's own merges wait for what they read beside the diff.
    const off = async (): Promise<string | null> => {
      const p = await planNow(db, repo, e.number, deps.now?.());
      return notDue(p, "premerge", head) ?? (params.approved !== undefined ? laneMismatch(p!.facts, params.approved) : null) ?? (p!.facts.diffPending && !workflowOf(p!.facts) ? EXTRAS_PENDING_REASON : null);
    };
    const p = await prepareOpusInput(db, repo, await candidateOf(db, e), opusDeps, log, { independent: true, off });
    if (p.kind === "off") {
      await jobItem(db, repo, e.number, `no pre-merge review: ${p.why}`, log);
      s.off.push(ref);
    } else if (p.kind === "no-diff") await fail(`retry: no diff: ${p.error}`);
    else if (p.kind === "large") await fail("too large to review automatically", true);
    else if (p.kind === "no-threads") await fail(`retry: ${p.error}`);
    else {
      const { input } = p;
      const checkout = (await deps.checkout?.(repo, e.number, head)) ?? undefined;
      if (checkout) input.repo_dir = REPO_PATH;
      const dir = referenceDir(repo);
      const semantic: SemanticDeps | undefined = dir ? deps.semantic ?? defaultSemanticDeps(db, ref) : undefined;
      const r = await runModelStep(db, PREMERGE_OPUS, input, {
        model: deps.model, checkout, reference: checkout ? dir : undefined, ctx: { dir, semantic },
        usage: { run: runId, agent: `premerge-${ref.replace("#", "-")}`, stage: "premerge", items: (ok) => (ok ? 1 : 0) },
        onReply: (reply) => { if (reply.fixTurn) log(`  ${ref}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`); },
      });
      const got: PremergeReview | null = r.ok ? r.value : null;
      // The call takes minutes: a push or a merge meanwhile makes the review one of a head nobody will merge.
      if (!await stillHead(db, repo, e.number, head)) {
        await jobItem(db, repo, e.number, "the head moved during the review; not stored", log);
        s.moved.push(ref);
      } else if (got) {
        await saveReviews(db, [{ repo, number: e.number, head, at: now(), runId, model: (r.ok && r.model) || deps.model, findings: got.findings, searched: got.searched, conflicts: got.conflicts, unsure: got.unsure, claims: got.claims, baseRef: p.baseRef }]);
        await jobItem(db, repo, e.number, `pre-merge review: ${got.findings.length} findings`, log);
        s.reviewed++; s.findings += got.findings.length; s.defects += got.findings.filter((f) => f.severity === "defect" && !notBlocking(f)).length; s.notBlocking += got.findings.filter((f) => f.severity === "defect" && notBlocking(f)).length;
      } else if (!r.ok && r.lost) await fail("retry: the call ended without a reply", false, true);
      else await fail(!r.ok && r.error.startsWith(REFUSED_PREFIX) ? `retry: ${r.error}` : "retry: no valid reply from the model");
    }
    params.onHandled?.(++handled);
  })), poolRoom(db, () => [repo], (i) => [{ repo, number: cands[i]!.number }]));
  log(`premerge ${repo}: ${s.reviewed} reviewed, ${s.carried} carried, ${s.findings} findings (${s.defects} blocking defects, ${s.notBlocking} not blocking), ${s.failed.length} without an answer, ${s.off.length} off the path, ${s.moved.length} moved`);
  return s;
}
