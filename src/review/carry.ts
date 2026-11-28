// A take or take-fix verdict carries over our own checked pushes: when the only change since a review is our commits, each one a fix-up
// whose patch the patch check approved (and whose lint passed, since it was pushed) or a merge of the base branch that left the PR's own
// diff unchanged, the new head gets the verdict without an Opus call. On a PR a person approved for merge the pre-merge review carries the
// same way (carriedPremerges): it is read again only where a later head got a review that counts (src/core/evidence.ts premergeSource).
import { ourPathIn, type OurCommit } from "./ours.ts";
import type { OpusReview, ReviewFix } from "./opus-parse.ts";
import { reviewAfterBaseMerge } from "./own-diff.ts";
import { mergeApprovalsIn, mergeApprovedIn } from "../core/author-round.ts";
import { askedParts, beyondPlanned, partsBeside, premergeSource, type ChainReview } from "../core/evidence.ts";
import { findingsOf } from "../premerge/store.ts";
import { notBlocking, stoppingDefects } from "../premerge/types.ts";
import { partTitle } from "../workflow/work.ts";
import type { Db } from "../db/index.ts";
import { loadFixupPushes, loadFixupVerdicts, loadPushEdges, type PushEdge } from "../data/changes/index.ts";
import { loadItems, loadRepos } from "../data/mirror/index.ts";
import { loadPremerge, loadReviewRows, loadReviewTexts, type PremergeSave, type ReviewRow } from "../data/review/index.ts";

export const CARRIED = "carried";

export type Carried = { review: OpusReview; from: string; seen: string; hash: string | null; baseRef: string | null };
type Cand = { repo: string; number: number; head_oid: string };

/** What carrying reads about a PR's fix-ups: the patch check verdict at the head each was made on, and what each changed and was asked to. */
type FixupFacts = { verdicts: Map<string, "approve" | "reject">; pushes: Map<string, { files: string[]; instructions: string | null }> };

/** A commit of ours a review carries over; `asked`: the lower-case titles of the parts an operator's fix-up was asked to make. */
type Step = { kind: OurCommit["kind"]; asked?: string[] };

/** The fix-up commits of a path, to load their facts. */
const fixupKeys = (ref: string, commits: readonly OurCommit[]) => commits.filter((c) => c.kind !== "base merge" && c.kind !== "CI fix").map((c) => ({ ref, from: c.from, to: c.sha }));

async function loadFixupFacts(db: Db, keys: { ref: string; from: string; to: string }[]): Promise<FixupFacts> {
  const [verdicts, pushes] = await db.together(() => Promise.all([loadFixupVerdicts(db, keys.map(({ ref, from }) => ({ ref, subject: from }))), loadFixupPushes(db, keys)]));
  return { verdicts, pushes };
}

/**
 * The commit as a review carries it, or null when it owes the head a model's reading: a CI fix of ours (it writes code no patch check
 * saw), a base merge that changed the PR's own diff, a fix-up the patch check did not approve, and an operator's fix-up of parts alone
 * that changed a file none of its parts names. An operator's fix-up of a person's own words carries: the patch check judged it against
 * them, and it is the work they approved (which files their words reach only they know); it made the parts named beside them.
 */
function carriable(key: string, c: OurCommit, edges: readonly PushEdge[], f: FixupFacts): Step | null {
  if (c.kind === "CI fix") return null;
  if (c.kind === "base merge") {
    const m = edges.find((x) => x.kind === "conflict" && x.to === c.sha && x.state === "merged");
    return m && reviewAfterBaseMerge(m.ownDiff ?? null) === "carry" ? { kind: c.kind } : null;
  }
  if (f.verdicts.get(`${key}@${c.from}`) !== "approve") return null;
  if (c.kind !== "operator fix-up") return { kind: c.kind };
  const row = f.pushes.get(`${key}@${c.from}>${c.sha}`);
  if (!row?.instructions) return null;
  const parts = askedParts(row.instructions);
  if (!parts) return { kind: c.kind, asked: partsBeside(row.instructions).map((p) => p.title.toLowerCase()) };
  if (!row.files.length || parts.some((p) => !p.file) || beyondPlanned(row.files, parts.map((p) => p.file!)).length) return null;
  return { kind: c.kind, asked: parts.map((p) => p.title.toLowerCase()) };
}

const PHRASE: Record<OurCommit["kind"], string> = {
  "fix-up": "our checked fix-up",
  "base merge": "our merge of the base branch, and the PR's own diff is unchanged",
  "pre-merge fix": "our checked fix-up of the pre-merge review's defects",
  "operator fix-up": "our checked fix-up of what a person asked for",
  "CI fix": "our CI fix",
};

/**
 * The review to record at each `c.head_oid` as carried from the latest earlier review, with that review's discussion mark; a PR that does not carry has no entry.
 * `stale` is the set of "repo#n@head" whose review is stale (staleReviews): a review that has not read the discussion as it is now is not carried,
 * and a head that already has a review (stale, being reviewed again) is never carried from an earlier one. A review read against
 * another base branch than the PR has now is not carried either; a carried review keeps the base its source read.
 *
 * A PR approved for merge carries over any number of our carriable commits, and from an unsure review too (the approval says the change is
 * wanted; the carried row keeps the source's `sure`). Any other PR carries over one commit, from a sure review: our merge of the base branch,
 * or a fix-up of the review's own fixes.
 */
export async function carriedReviews(db: Db, cs: Cand[], stale: Set<string> = new Set()): Promise<Map<string, Carried>> {
  const out = new Map<string, Carried>();
  if (!cs.length) return out;
  const refs = cs.map((c) => ({ repo: c.repo, number: c.number }));
  const [rows, items, repos, edges, approvals] = await db.together(() => Promise.all([
    loadReviewRows(db, refs), loadItems(db, refs, "pr"), loadRepos(db, { names: [...new Set(cs.map((c) => c.repo))] }), loadPushEdges(db, refs), mergeApprovalsIn(db, refs),
  ]));
  const approved = new Set(approvals.keys());
  type Pick = { c: Cand; e: ReviewRow; baseRef: string | null; key: string; commits: OurCommit[] };
  const picked: Pick[] = [];
  for (const c of cs) {
    const key = `${c.repo}#${c.number}`, all = rows.get(key) ?? [], mine = approved.has(key);
    const e = all.find((r) => r.head !== c.head_oid && r.model !== null);
    if (all.some((r) => r.head === c.head_oid)) continue;
    if (!e || stale.has(`${key}@${e.head}`) || (e.verdict !== "take" && e.verdict !== "take-fix") || (!e.sure && !mine)) continue;
    const baseRef = e.base_ref ?? repos.get(c.repo)?.default_branch ?? null;
    const liveBase = items.get(key)?.base_ref ?? null;
    if (baseRef && liveBase && baseRef !== liveBase) continue;
    const path = ourPathIn(edges.get(key) ?? [], e.head, c.head_oid);
    if (!path.complete || !path.commits.length) continue;
    // Off the approval only one commit carries: the review's own fix-up, or a base merge.
    if (!mine && (path.commits.length > 1 || (path.commits[0]!.kind !== "fix-up" && path.commits[0]!.kind !== "base merge"))) continue;
    picked.push({ c, e, baseRef, key, commits: path.commits });
  }
  if (!picked.length) return out;
  const [texts, facts] = await db.together(() => Promise.all([
    loadReviewTexts(db, picked.map((p) => ({ repo: p.c.repo, number: p.c.number, head: p.e.head }))), loadFixupFacts(db, picked.flatMap((p) => fixupKeys(p.key, p.commits))),
  ]));
  for (const { e, baseRef, key, commits } of picked) {
    const steps = commits.map((x) => carriable(key, x, edges.get(key) ?? [], facts));
    if (steps.some((s) => s === null)) continue;
    const t = texts.get(`${key}@${e.head}`);
    // Our fix-ups made the review's fixes, or the ones a person named; a base merge and a fix-up of the pre-merge review's defects leave them.
    // A fix-up started after the merge approval made only the review's blocking fixes: the others stay, to be filed as follow-ups.
    const approvedAt = approvals.get(key);
    const startedAt = (x: OurCommit) => (edges.get(key) ?? []).find((p) => p.kind === "fixup" && p.from === x.from && p.to === x.sha)?.at;
    let verdict = e.verdict as "take" | "take-fix", fixes = e.fixes as unknown as ReviewFix[], made = false;
    for (const [i, s] of (steps as Step[]).entries()) {
      if (s.kind === "fix-up") {
        const at = startedAt(commits[i]!);
        const left = approvedAt !== undefined && at !== undefined && approvedAt <= at ? fixes.filter(notBlocking) : [];
        made ||= verdict === "take-fix";
        fixes = left;
        if (!fixes.length) verdict = "take";
      }
      if (s.kind === "operator fix-up") {
        const left = fixes.filter((x) => !s.asked!.includes(partTitle(x).toLowerCase()));
        if (left.length < fixes.length) { made ||= verdict === "take-fix"; fixes = left; }
        if (!fixes.length) verdict = "take";
      }
    }
    const kinds = commits.map((x) => PHRASE[x.kind]);
    out.set(key, {
      review: {
        ref: key, summary: t?.summary ?? null, risks: e.risks, conflicts: e.conflicts as unknown as OpusReview["conflicts"], claims: [], blocked_by: [], public: null,
        verdict, sure: e.sure, fixes,
        // A take-fix review's reason names the fixes our fix-up has since made; the carried verdict's reason is the carry itself.
        why: made ? null : t?.why ?? null,
        reason: `carried from ${e.head.slice(0, 7)}: ${kinds.length === 1 ? `the only change is ${kinds[0]}` : `the only changes are ${kinds.join(", then ")}`}`,
      },
      from: e.head, seen: e.seen_at ?? e.at, hash: e.disc_hash, baseRef,
    });
  }
  return out;
}

/**
 * The pre-merge row to store, with no model call, at each head of a PR approved for merge that owes no pre-merge review of its own
 * (premergeSource); key is `repo#number@head`, and a head a model must read has none. The row is clean where nothing since the full
 * review owes one. Otherwise it repeats the nearest earlier pre-merge row, so its follow-ups are known as filed, less the defects that stop
 * the merge which our pushes since were asked to fix: all of them for a fix-up of the pre-merge review's defects, the named ones for an
 * operator's fix-up. A defect nothing fixed still stops the merge.
 */
export async function carriedPremerges(db: Db, cs: { repo: string; number: number; head: string }[], runId: string, at: string): Promise<Map<string, PremergeSave>> {
  const out = new Map<string, PremergeSave>();
  if (!cs.length) return out;
  const approved = await mergeApprovedIn(db, cs);
  const due = cs.filter((c) => approved.has(`${c.repo}#${c.number}`));
  if (!due.length) return out;
  const [rows, edges] = await db.together(() => Promise.all([loadReviewRows(db, due), loadPushEdges(db, due)]));

  // Each head's chain of reviews back to a full one, with the commits of ours between each review's head and the head it reads from
  // (a full review: the latest review made before it); null where someone else's commits lie between.
  type Link = { head: string; r: ReviewRow; path: OurCommit[] | null };
  const chains = due.map((c) => {
    const key = `${c.repo}#${c.number}`, all = (rows.get(key) ?? []).filter((r) => r.model !== null), pe = edges.get(key) ?? [];
    const byHead = new Map(all.map((r) => [r.head, r]));
    const links: Link[] = [];
    for (let h: string | null = c.head; h !== null && !links.some((l) => l.head === h); ) {
      const r = byHead.get(h);
      if (!r) break;
      const from = r.mode === "full" ? all.find((x) => x.head !== r.head && x.at < r.at)?.head ?? null : r.base_head;
      const p = from === null ? null : ourPathIn(pe, from, r.head);
      links.push({ head: h, r, path: p ? (p.complete ? p.commits : null) : [] });
      h = r.mode === "full" ? null : r.base_head;
    }
    return { c, key, pe, links };
  });
  const [facts, pmRows] = await db.together(() => Promise.all([
    loadFixupFacts(db, chains.flatMap(({ key, links }) => links.flatMap((l) => fixupKeys(key, l.path ?? [])))),
    loadPremerge(db, chains.flatMap(({ c, links }) => links.map((l) => ({ repo: c.repo, number: c.number, head: l.head })))),
  ]));

  for (const { c, key, pe, links } of chains) {
    const reviews = new Map<string, ChainReview>(links.map((l) => [l.head, {
      mode: l.r.mode, base: l.r.base_head,
      // Pushes of ours that owe no reading (a CI fix, a carriable commit) between the heads do not count; someone else's commits do.
      counts: l.r.mode !== "carried" && (l.path === null || (l.path.length > 0 && !l.path.every((x) => x.kind === "CI fix" || carriable(key, x, pe, facts) !== null))),
    }]));
    const premerged = new Set(links.map((l) => l.head).filter((h) => pmRows.get(`${key}@${h}`)?.findings != null));
    const src = premergeSource(c.head, reviews, premerged);
    if (!src) continue;
    const base = { repo: c.repo, number: c.number, head: c.head, at, runId, model: CARRIED, searched: null };
    if (src.from === null) { out.set(`${key}@${c.head}`, { ...base, findings: [] }); continue; }
    const row = pmRows.get(`${key}@${src.from}`)!;
    const all = findingsOf(row), stops = new Set(stoppingDefects(all, true));
    const steps = ourPathIn(pe, src.from, c.head).commits.map((x) => (x.kind === "pre-merge fix" || x.kind === "operator fix-up" ? carriable(key, x, pe, facts) : null));
    const fixedAll = steps.some((s) => s?.kind === "pre-merge fix"), asked = new Set(steps.flatMap((s) => s?.asked ?? []));
    const kept = all.filter((x) => !stops.has(x) || !(fixedAll || asked.has(x.title.toLowerCase())));
    out.set(`${key}@${c.head}`, { ...base, findings: kept, unsure: row.unsure === 1, baseRef: row.base_ref ?? null });
  }
  return out;
}
