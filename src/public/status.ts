// The public status layer: the only source of what anonymous people (the Discord bot, a PR status comment) may learn about an
// item or about the pipeline. It names an item's place on a fixed list of steps and gives counts. It never carries hold
// reasons, prompts, model output, account data or anything about a security fix, and it knows only public tracked repos.
import type { Db } from "../db/index.ts";
import { loadPublicRepoNames, loadPublicStats, loadPublicStatusRows, PUBLIC_QUEUED } from "../data/views/public-status.ts";
import { NO_WORKFLOW_SCORE } from "../core/work-score.ts";
import type { PublicStatusRow, QueueMember } from "../data/views/types.ts";

export const STEPS = ["New", "Triaged", "In review", "Waiting for CI", "Fix-up in progress", "Needs a maintainer decision", "In the merge queue", "Merged", "Closed"] as const;
export type PublicStep = (typeof STEPS)[number];

export type PublicStatus = {
  ref: string; title: string; url: string; kind: "issue" | "pr";
  state: "open" | "merged" | "closed";
  step: PublicStep;
  /** Only for step "In the merge queue": the place among the repo's PRs that will merge next, and how many there are. */
  queue?: { position: number; of: number };
};

// Mapping from stored data to a step (first match wins; open items only):
//
//   items.state MERGED / CLOSED                                   -> Merged / Closed
//   a workflow waiting for an answer (recommending, or at a
//     blocker)                                                     -> Needs a maintainer decision
//   issue: no item_stage row                                      -> New
//   issue: any other                                              -> Triaged
//   PR plan state in-batch, batch-checking, ready,
//     decision-answered-merge                                     -> In the merge queue (#n of m)
//   PR plan state needs-fix-up, or view.fixup = fix,
//     or view.cifix = cifix-queued | cifix-rerun                  -> Fix-up in progress
//   PR plan state waiting-ci, waiting-premerge, waiting-verify,
//     ci-approval                                                 -> Waiting for CI
//   PR with no item_stage row                                     -> New
//   PR never reviewed (item_stage.reviewed = 0, no queue state)   -> Triaged
//   PR any other (reviewed: held, refused, conflict, changes
//     requested, stale ... all look the same)                     -> In review
//
// Held and refused states are deliberately folded into "In review": the reason is not public.
const FIXING = ["needs-fix-up"];
const WAITING = ["waiting-ci", "waiting-premerge", "waiting-verify", "ci-approval"];
const NEVER_REVIEWED = ["not-reviewed", "out-of-scope", "draft", "not-started"];

/** True for a repo that is tracked and public. */
export const isPublicRepo = async (db: Db, repo: string): Promise<boolean> => (await loadPublicRepoNames(db)).includes(repo);

/** Names of the tracked repos that are public. */
export const publicRepoNames = async (db: Db): Promise<string[]> => await loadPublicRepoNames(db);

/** The step of one item (see the mapping above). `place`: its place in the merge queue, null when it is not in it. */
function statusOf(repo: string, row: PublicStatusRow, place: () => { position: number; of: number } | null): PublicStatus | null {
  if (!row.url) return null;
  const number = row.number;
  const kind = row.kind === "pr" ? "pr" : "issue";
  const base = { ref: `${repo}#${number}`, title: row.title ?? "", url: row.url, kind } as const;
  if (row.state === "MERGED") return { ...base, state: "merged", step: "Merged" };
  if (row.state === "CLOSED") return { ...base, state: "closed", step: "Closed" };
  const open = { ...base, state: "open" } as const;
  if (row.needsPerson) return { ...open, step: "Needs a maintainer decision" };
  if (kind === "issue") return { ...open, step: row.stage === null ? "New" : "Triaged" };
  let view: { fixup?: string; cifix?: string; queue?: { held?: boolean } } = {};
  try {
    const v: unknown = row.view ? JSON.parse(row.view) : {};
    if (v && typeof v === "object") view = v;
  } catch {
    // An unreadable cached view counts as no view.
  }
  const plan = row.planState ?? "";
  if (PUBLIC_QUEUED.includes(plan) ) {
    const q = place();
    if (q) return { ...open, step: "In the merge queue", queue: q };
  }
  if (FIXING.includes(plan) || view.fixup === "fix" || view.cifix === "cifix-queued" || view.cifix === "cifix-rerun") return { ...open, step: "Fix-up in progress" };
  if (WAITING.includes(plan)) return { ...open, step: "Waiting for CI" };
  if (row.stage === null) return { ...open, step: "New" };
  if (!row.reviewed && (NEVER_REVIEWED.includes(plan) || plan === "")) return { ...open, step: "Triaged" };
  return { ...open, step: "In review" };
}

export async function publicStatus(db: Db, repo: string, number: number): Promise<PublicStatus | null> {
  if (!await isPublicRepo(db, repo)) return null;
  const { rows, queue } = await loadPublicStatusRows(db, [{ repo, number }], [repo], { withHidden: false });
  const row = rows[0];
  if (!row || row.hidden) return null;
  return statusOf(repo, row, () => queuePlace(queueOrder(queue), number));
}

/**
 * The statuses of PRs, by "repo#number", for the PR status comment (src/prstatus), which the PR's own readers see on GitHub:
 * private repos too, and the security cases `publicStatus` leaves out get the same steps and places as any PR (the queue
 * counts them here), so their comment does not single them out. The queue is read once.
 */
export async function commentStatuses(db: Db, refs: readonly { repo: string; number: number }[]): Promise<Map<string, PublicStatus>> {
  const out = new Map<string, PublicStatus>();
  const { rows, queue } = await loadPublicStatusRows(db, refs, [...new Set(refs.map((r) => r.repo))], { withHidden: true });
  const orders = new Map<string, number[]>();
  const orderOf = (repo: string): number[] => orders.get(repo) ?? orders.set(repo, queueOrder(queue.filter((m) => m.repo === repo))).get(repo)!;
  for (const row of rows) {
    const s = statusOf(row.repo, row, () => queuePlace(orderOf(row.repo), row.number));
    if (s) out.set(`${row.repo}#${row.number}`, s);
  }
  return out;
}

/**
 * Open PRs of a repo that are queued to merge, in merge order: members of an integration batch first (they merge before
 * anything else), then in work order (src/core/work-score.ts), unstarted ones by work rank and number. A PR waiting on a maintainer decision is left out.
 */
const queueOrder = (queue: QueueMember[]): number[] =>
  [...queue].sort((a, b) => Number(b.batched) - Number(a.batched) || (b.work ?? NO_WORKFLOW_SCORE) - (a.work ?? NO_WORKFLOW_SCORE) || (b.score ?? -1) - (a.score ?? -1) || a.number - b.number).map((m) => m.number);

const queuePlace = (order: number[], number: number): { position: number; of: number } | null => {
  const at = order.indexOf(number);
  return at < 0 ? null : { position: at + 1, of: order.length };
};

export type PublicStats = {
  repo: string | null;
  openIssues: number; openPrs: number;
  mergedLast7Days: number; mergedByAutoCraftLast7Days: number;
  reviewsPostedLast7Days: number;
  /** Median hours from opening to merge over PRs merged in the last 30 days; null with none. */
  medianOpenToMergeHours30Days: number | null;
  queueLength: number;
};

const DAY = 86_400_000;

/** Counts for one public tracked repo, or all of them (`repo` omitted). null when `repo` is not public and tracked. */
export async function publicStats(db: Db, repo?: string, now = Date.now()): Promise<PublicStats | null> {
  if (repo !== undefined && !await isPublicRepo(db, repo)) return null;
  const repos = repo !== undefined ? [repo] : await loadPublicRepoNames(db);
  const out: PublicStats = { repo: repo ?? null, openIssues: 0, openPrs: 0, mergedLast7Days: 0, mergedByAutoCraftLast7Days: 0, reviewsPostedLast7Days: 0, medianOpenToMergeHours30Days: null, queueLength: 0 };
  const since7 = new Date(now - 7 * DAY).toISOString(), since30 = new Date(now - 30 * DAY).toISOString();
  const facts = await loadPublicStats(db, repos, { since7, since30 });
  for (const o of facts.open) if (o.kind === "pr") out.openPrs += o.n; else out.openIssues += o.n;
  for (const r of facts.reviews) out.reviewsPostedLast7Days += r.n;
  for (const r of facts.queues) out.queueLength += r.n;
  const hours: number[] = [];
  for (const m of facts.merged) {
    const dur = m.openedAt ? Date.parse(m.mergedAt) - Date.parse(m.openedAt) : NaN;
    if (dur >= 0) hours.push(dur / 3_600_000);
    if (m.mergedAt >= since7) {
      out.mergedLast7Days++;
      if (m.ours) out.mergedByAutoCraftLast7Days++;
    }
  }
  if (hours.length) {
    hours.sort((a, b) => a - b);
    const mid = hours.length >> 1;
    out.medianOpenToMergeHours30Days = Math.round((hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2) * 10) / 10;
  }
  return out;
}
