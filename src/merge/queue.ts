// The merge queue as a view of Plans: every PR with a take or take-fix review at its current head commit, with the fields the
// dashboard and the merge executors show. Nothing here decides: state, path, reasons and notes come from
// decidePr (src/core/decide.ts); the rest is read from the facts. Reads only local tables; no GitHub calls.
import { decidePr, mergeEntry, queueEntry } from "../core/decide.ts";
import { loadPass, loadPrFacts } from "../core/facts.ts";
import { isQueueState, QUEUE_STATES, type MergePath, type PrFacts, type QueueState } from "../core/plan.ts";
import { claimsOf, findingsOf, type PremergeFinding } from "../premerge/store.ts";
import { followUpDefects, stoppingDefects } from "../premerge/types.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadPremerge } from "../data/review/index.ts";
import type { PremergeRow } from "../data/review/types.ts";
import type { Claim } from "../review/opus-parse.ts";
import type { Tier } from "../whitelist.ts";
import type { Db } from "../db/index.ts";

export { QUEUE_STATES, type QueueState };
export {
  RULE_LABELS, RULE_SIZES, RULE_TIERS, UNSURE_REASON, PREMERGE_DEFECT_REASON, PREMERGE_UNSURE_REASON, PREMERGE_FAILED_REASON, VERIFY_OK, verifyOk, VERIFY_UNAVAILABLE, verifyAllows, ciAllows,
  PIPELINE_LOGIN_KEY,
} from "../core/rules.ts";
export { NO_CI_SAMPLE, repoHasNoCi } from "./no-ci.ts";
export { headWasUnsure, ownFixPrs } from "../core/facts.ts";
export { countStates } from "../core/plan-read.ts";

export type QueueEntry = {
  repo: string; number: number; title: string; author: string | null; tier: Tier;
  head: string; size: string; label: string | null; /** Null for a merge-entry PR, which has no review. */ verdict: "take" | "take-fix" | null;
  reason: string; fixes: number; ci: string; mergeable: string;
  state: QueueState;
  /** The merge rule or an operator's answer lets it merge now (a refused PR still counts while its retry waits for a change). */
  eligible: boolean;
  /** How the PR may merge: by the rule, by an operator's answer, or not yet. */
  path: MergePath;
  /** Why the rule doesn't cover it; empty when it does. */
  outsideRule: string[];
  /** Actions runs at the reviewed head that wait for a maintainer's approval (see ci-approval.ts); 0 when none or unknown. */
  runsWaiting: number;
  /** Why the pipeline does not approve them: the repo's CI approval is off, approving failed twice, or they are not runs it approves (not a fork's pull_request); null when it will. */
  runsBlocked: "off" | "failed" | "unsupported" | null;
  /** The repo has no CI at all (not just no checks on this PR yet). */
  noCi: boolean;
  refusedReason: string | null;
  reviewedAt: string;
  /** A line on the state: why a maintainer's review blocks it, or that its reviews cannot be read. */
  note: string | null;
  /** The block (state changes-requested) comes from a live read newer than the PR's last update, not from the mirrored reviews alone. */
  blockedLive: boolean;
  /** The verification of the PR's current head, or null when there is none. */
  verify: { state: string; kind: string | null; summary: string | null; note: string | null } | null;
  /** For a conflicting PR: what Fix-up does about it ("conflict: merging main", "conflict: asked the contributor", "conflict: held"), or null. */
  conflictNote?: string | null;
  /** The PR is one AutoCraft opened to fix main CI (branch prefix MAIN_FIX_BRANCH_PREFIX); it merges alone. */
  mainFix?: boolean;
  /** The pre-merge review of the head, read for open PRs the rule would otherwise merge; null when not read (outside the rule, or an operator's Merge answer). fix: every defect has a fix and a fix-up may apply them; defect: a defect to decide on; failed: three tries failed; retry: a try failed, more are left. */
  premerge: { state: "none" | "clean" | "fix" | "defect" | "unsure" | "failed" | "retry"; defects: PremergeFinding[]; /** Claims of the description the review could not settle (unknown impact, or unverified). */ unknownClaims: Claim[]; /** On a PR approved for merge, the defects that do not stop it: filed as follow-ups. */ followUps: PremergeFinding[]; minor: number; error: string | null } | null;
};

/** True when the PR may be merged now (ready, approved, or retried after a refusal). */
export const eligible = (e: Pick<QueueEntry, "eligible">): boolean => e.eligible;

export type QueueOptions = {
  repo?: string;
  /** Which PRs by GitHub state: open ones only, merged ones only, or both (default). */
  merged?: "exclude" | "only" | "all";
  /** Keyset page: entries after this PR in (repo, number) order, at most `limit` of them. */
  after?: { repo: string; number: number };
  limit?: number;
  /** Repos left out. */
  exclude?: string[];
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
  /** The classification run for labels, resolved once by the caller (default: latestRun). */
  run?: string | null;
};

/** The queue row of a PR whose Plan is in a queue state; `premergeRow` is the pre-merge review at its head, when one was loaded. */
function entryOf(f: PrFacts, plan: ReturnType<typeof decidePr>, title: string, premergeRow: PremergeRow | null): QueueEntry {
  // A merge-entry PR is queued at its own head without a review; it joined the queue when its workflow started.
  const r = mergeEntry(f) ? null : f.review!;
  const head = headOf(f);
  const merged = plan.state === "merged";
  const x = queueEntry(f, merged, !merged);
  let premerge: QueueEntry["premerge"] = null;
  if (x.premerge) {
    const all = findingsOf(premergeRow);
    const approved = !!f.workflow?.approved;
    const defects = stoppingDefects(all, approved, f.workflow?.overruled), followUps = approved ? followUpDefects(all) : [];
    premerge = { state: x.premerge, defects, unknownClaims: claimsOf(premergeRow).filter((c) => c.impact === "unknown"), followUps, minor: all.length - defects.length - followUps.length, error: premergeRow?.error ?? null };
  }
  return {
    repo: f.repo, number: f.number, title, author: f.author, tier: f.tier, head, size: f.size, label: f.label,
    verdict: r ? r.verdict as "take" | "take-fix" : null, reason: r?.reason ?? "", fixes: r?.fixes ?? 0, ci: f.ci, mergeable: f.mergeable,
    state: plan.state as QueueState, eligible: plan.eligible, path: plan.path, outsideRule: plan.reasons,
    runsWaiting: f.runs?.waiting ?? 0, runsBlocked: f.runs?.blocked ?? null, noCi: x.noCi, refusedReason: x.refusedReason,
    reviewedAt: r?.at ?? f.workflow?.startedAt ?? "", note: plan.note, blockedLive: plan.state === "changes-requested" && !!f.changesRequested?.live,
    verify: f.verification, ...(plan.conflictNote !== null ? { conflictNote: plan.conflictNote } : {}), ...(f.mainFix ? { mainFix: true } : {}), premerge,
  };
}

const headOf = (f: PrFacts): string => (mergeEntry(f) ? null : f.review!)?.head ?? f.head ?? "";

export async function buildQueue(db: Db, opts: QueueOptions = {}): Promise<QueueEntry[]> {
  const which = opts.merged ?? "all";
  const picked: { f: PrFacts; plan: ReturnType<typeof decidePr> }[] = [];
  const pass = loadPass();
  for (const f of await loadPrFacts(db, { ...(opts.repo ? { repo: opts.repo } : {}), ...(opts.refs ? { refs: opts.refs } : {}), ...(opts.run !== undefined ? { run: opts.run } : {}) })) {
    if (opts.exclude?.includes(f.repo)) continue;
    if (which === "exclude" ? f.ghState !== "OPEN" : which === "only" ? f.ghState !== "MERGED" : f.ghState === "CLOSED") continue;
    if (opts.after && (f.repo < opts.after.repo || (f.repo === opts.after.repo && f.number <= opts.after.number))) continue;
    const plan = decidePr(f, pass);
    if (!isQueueState(plan.state)) continue;
    picked.push({ f, plan });
    if (opts.limit && picked.length >= Math.floor(opts.limit)) break;
  }
  if (!picked.length) return [];
  // Titles of every entry and the pre-merge reviews of the entries that show one, in one wave.
  const reviewed = picked.filter((p) => queueEntry(p.f, p.plan.state === "merged", p.plan.state !== "merged").premerge);
  const [items, premerge] = await db.together(() => Promise.all([
    loadItems(db, picked.map((p) => ({ repo: p.f.repo, number: p.f.number })), "card"),
    loadPremerge(db, reviewed.map((p) => ({ repo: p.f.repo, number: p.f.number, head: headOf(p.f) }))),
  ]));
  return picked.map(({ f, plan }) => entryOf(f, plan, items.get(`${f.repo}#${f.number}`)?.title ?? "", premerge.get(`${f.repo}#${f.number}@${headOf(f)}`) ?? null));
}
