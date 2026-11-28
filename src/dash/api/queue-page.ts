// The Queue page: tabs All, Review, Fix, Verify and Merge over one repo filter, ordered by workflow weight, plus
// the hold and batch controls. Reads are for anyone signed in, limited to the repos the
// requester may see; every write is for operators (the route says so) and audited.
import { canSeeInternals } from "./staff.ts";
import type { ItemPrBuild, MergeWait, NextMerge, QueueMergeRow, QueueOrigin, QueuePage, QueuePendingRow, QueueRepos, QueueTab, QueueWorkRow, TypeLabel, WeightPlace } from "../../../web/src/api/types.ts";
import type { CachedEntry } from "../../data/views/merge-queue.ts";
import { closingOf, loadQueuePage, type QueuePageFacts } from "../../data/views/queue.ts";
import { loadPrBuildViews, type PrBuildView } from "../../data/merge/index.ts";
import { loadOpenPrLinks } from "../../data/mirror/index.ts";
import { featureOn } from "../../build/features.ts";
import { ownerOf } from "../../owners.ts";
import type { Exec } from "../../fixup/git.ts";
import { ControlError } from "../../merge/controls.ts";
import { holdBatched, stopBatch } from "../../workflow/batch.ts";
import { actorOf } from "./commands.ts";
import { loadBatches } from "../../data/merge/index.ts";
import type { Preapproval } from "../../data/workflow/index.ts";
import { NO_WORKFLOW_SCORE } from "../../core/work-score.ts";
import { mergeOrder, queueSlots } from "../../rank/position.ts";
import { classifyListOf, NOT_PLANNED } from "../../rank/next.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { toBatch, toRow } from "./queue.ts";
import { needVisible, visibleRepos } from "./visible.ts";
import { mayRunRepo } from "../repo-access.ts";
import { readerOf, veiledFor } from "./reader.ts";
import { stageById } from "../../stages/registry.ts";
import type { Db } from "../../db/index.ts";

export const TABS: QueueTab[] = ["all", "review", "fix", "verify", "merge"];
const NEXT_LIMIT = 10;

/** The tab a work row belongs to besides All, from its next step. */
export function tabOfNext(next: string): QueueTab | null {
  if (next === stageById("review").title) return "review";
  if (next.startsWith("Fix") || next.startsWith("Implement")) return "fix";
  if (next.startsWith("Verify")) return "verify";
  return null;
}

const WAITS: Record<string, [MergeWait, string, number]> = {
  ready: ["ready", "Ready", 0],
  "decision-answered-merge": ["ready", "Merge approved", 0],
  refused: ["refused", "Refused; tried again when GitHub reports something new", 1],
  "in-batch": ["batch-ci", "In a batch; waiting for the batch PR's CI", 1],
  "batch-checking": ["batch-check", "In a batch; checked in the sandbox", 1],
  "waiting-ci": ["ci", "Waiting for CI", 2],
  "ci-approval": ["ci", "Waiting for CI run approval", 2],
  "waiting-verify": ["verify", "Waiting for Verify", 2],
  "waiting-premerge": ["premerge", "Waiting for the pre-merge review", 2],
};

/** What merges next and what each PR waits for, from the queue states (src/merge/queue.ts). By weight, then by what it waits for. */
export function nextMerges(entries: CachedEntry[], places: Map<string, WeightPlace>, batchOf: Map<string, { id: number; branch: string }>, scores: Map<string, number>): NextMerge[] {
  const items = entries.flatMap((e) => {
    const w = e.state === "ci-approval" && e.runsBlocked ? WAITS[e.state]!.map((x, k) => (k === 1 ? "CI runs need a person to approve" : x)) as [MergeWait, string, number] : WAITS[e.state];
    return w ? [{ e, w }] : [];
  });
  items.sort((a, b) => {
    const fa = places.get(`${a.e.repo}#${a.e.number}`)?.position ?? Infinity, fb = places.get(`${b.e.repo}#${b.e.number}`)?.position ?? Infinity;
    return fa - fb || a.w[2] - b.w[2]
      || (scores.get(`${b.e.repo}#${b.e.number}`) ?? -1) - (scores.get(`${a.e.repo}#${a.e.number}`) ?? -1) || a.e.repo.localeCompare(b.e.repo) || a.e.number - b.e.number;
  });
  return items.slice(0, NEXT_LIMIT).map(({ e, w }) => ({
    repo: e.repo, number: e.number, title: e.title, waitsFor: w[0], label: w[1], batch: batchOf.get(`${e.repo}#${e.number}`) ?? null,
  }));
}

const refText = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;

/** `repo#number` of the item held by a feature switch row: PR builds are shown only where the repo has the switch on. */
async function prBuildsOf(db: Db, entries: CachedEntry[], internals: boolean): Promise<Map<string, ItemPrBuild>> {
  const repos = [...new Set(entries.map((e) => e.repo))];
  const on = new Set((await Promise.all(repos.map(async (r) => ((await featureOn(db, "pr-builds", r)) ? [r] : [])))).flat());
  const views = await loadPrBuildViews(db, entries.filter((e) => on.has(e.repo)).map((e) => ({ ref: refText(e), head: e.head })));
  return new Map(entries.flatMap((e): [string, ItemPrBuild][] => {
    const v = views.get(refText(e));
    return v ? [[refText(e), prBuildOf(v, e.head, internals)]] : [];
  }));
}

/** The build of the PR's current head, else the newest one. `internals` false: states only, no failure text. */
function prBuildOf(r: PrBuildView, head: string | null, internals: boolean): ItemPrBuild {
  const state = r.state === "queued" ? (r.taskState === "claimed" || r.taskState === "running" ? "running" : "queued") : r.state;
  return { headSha: r.headSha, current: r.headSha === head, state: state as ItemPrBuild["state"], summary: internals ? r.summary : null, disagree: r.disagree, ci: r.ciOverall as ItemPrBuild["ci"], createdAt: r.createdAt, finishedAt: r.finishedAt };
}

/** Rows a page holds at most. */
const PAGE_MAX = 500;

export async function queuePage(db: Db, req: Req): Promise<QueuePage> {
  const tab = (req.query.get("tab") || "all") as QueueTab;
  if (!TABS.includes(tab)) throw new HttpError(400, `tab must be one of ${TABS.join(", ")}`);
  const reposParam = (req.query.get("repos") || "pipeline") as QueueRepos;
  const limit = Math.min(Math.max(Number(req.query.get("limit")) || 100, 1), PAGE_MAX);
  const offset = Math.max(Number(req.query.get("offset")) || 0, 0);
  const [visible, reader] = await Promise.all([visibleRepos(db, req), readerOf(db, req)]);
  const visibleSet = new Set(visible);
  if (reposParam !== "pipeline" && reposParam !== "all" && !visibleSet.has(reposParam)) throw new HttpError(404, `${reposParam} is not a tracked repo`);
  const internals = canSeeInternals(req);
  // A linked item (`item=repo:number`) comes with the first page: it is cut long enough to include the item.
  const item = req.query.get("item");
  const sizeFor = (at: number | null): number => (at === null || offset > 0 ? limit : Math.min(PAGE_MAX, Math.max(limit, Math.ceil((at + 1) / 100) * 100)));
  const itemRef = (): { repo: string; number: number } | null => {
    const i = item?.lastIndexOf(":") ?? -1, number = Number(item?.slice(i + 1));
    return i > 0 && Number.isSafeInteger(number) && `${item!.slice(0, i)}:${number}` === item ? { repo: item.slice(0, i), number } : null;
  };
  // The page's reads do not depend on each other, so they run together. The default view is the pipeline's scope (src/rank/position.ts), the same one the position badges count.
  const pipeline = reposParam === "pipeline";
  const [facts, slots] = await db.together(() => Promise.all([
    loadQueuePage(db, {
      pipelineScope: pipeline, merge: tab === "merge", visible, hidden: reader.hidden,
      list: { repos: pipeline || reposParam === "all" ? visible : [reposParam], scope: pipeline, top: tab === "merge" ? 1 : item && offset === 0 ? PAGE_MAX : offset + limit, item: tab === "merge" ? null : itemRef() },
    }),
    queueSlots(db, visible),
  ]));
  const { scope: scoped, closes: closesOf, positions } = facts;
  const allEntries = facts.entries;
  const places = new Map<string, WeightPlace>([...positions].filter(([k]) => visibleSet.has(k.slice(0, k.lastIndexOf("#")))).map(([k, p]) => [k, { position: p.position, of: p.of, weight: p.weight }]));
  const inScope = (repo: string, number: number): boolean =>
    reposParam === "all" ? visibleSet.has(repo) : pipeline ? visibleSet.has(repo) && scoped!.has(`${repo}#${number}`) : repo === reposParam;

  // Merge queue rows
  const entries = allEntries.filter((e) => e.state !== "merged" && visibleSet.has(e.repo) && inScope(e.repo, e.number));
  const originOf = queueOriginOf(facts, internals);
  const builds = tab === "merge" ? await prBuildsOf(db, entries, internals) : new Map<string, ItemPrBuild>();
  const asRow = (e: CachedEntry): QueueMergeRow => ({ ...toRow(e, reader), place: places.get(refText(e)) ?? null, prBuild: builds.get(refText(e)) ?? null, closes: closesOf.get(refText(e)) ?? [], added: originOf(e) });
  // Tabs come from the stored next step; the text is veiled afterwards, so a quiet pull request stays in its tab.
  const inTab = (next: string | null, t: QueueTab): boolean => t === "all" || tabOfNext(next ?? NOT_PLANNED) === t;
  const veilNext = (w: QueueWorkRow): QueueWorkRow => (veiledFor(reader, w.repo, w.number) ? { ...w, next: "" } : w);
  const pending = pendingRows(facts, entries, inScope, originOf);
  const total = (t: QueueTab): number => facts.work.steps.reduce((n, s) => (inTab(s.next, t) ? n + s.count : n), 0);
  const count = (t: QueueTab): number => (t === "merge" ? entries.length + pending.length : total(t));
  const counts = { all: count("all"), review: count("review"), fix: count("fix"), verify: count("verify"), merge: count("merge") };

  const out: QueuePage = { tab, repos: reposParam, counts, rows: [], mergeRows: [], nextMerges: [], batches: [], total: 0, next: null };
  if (tab !== "merge") {
    const steps = facts.work.steps.filter((s) => inTab(s.next, tab));
    out.itemIndex = steps.some((s) => s.hasItem) ? steps.reduce((n, s) => n + s.before!, 0) : null;
    out.rows = facts.work.rows.filter((r) => inTab(r.next, tab)).slice(offset, offset + sizeFor(out.itemIndex)).map((r): QueueWorkRow => veilNext({
      repo: r.repo, number: r.number, kind: r.kind, title: r.title, score: r.score, level: r.breakdown.level, size: r.breakdown.size, breakdown: r.breakdown,
      label: r.label as TypeLabel | null, next: r.next ?? NOT_PLANNED, nextHref: r.itemState === "referee-due" ? classifyListOf(r.repo) : null,
      queue: slots.get(refText(r)) ?? null,
    }));
    out.total = total(tab);
    out.next = offset + out.rows.length < out.total ? offset + out.rows.length : null;
    return out;
  }
  const rows = entries.map((e) => [e, asRow(e)] as const);
  const ordered = mergeOrder(entries, (e) => facts.workScores.get(refText(e)) ?? facts.scores.get(refText(e)) ?? NO_WORKFLOW_SCORE);
  const active = facts.batches.filter((b) => (b.state === "checking" || b.state === "open") && b.members.some((p) => inScope(b.repo, p.number)));
  const rowOfEntry = new Map(rows);
  const rowOf = new Map(rows.map(([e, r]) => [`${e.repo}#${e.number}`, r]));
  const batchOf = new Map(active.flatMap((b) => b.members.map((p) => [`${b.repo}#${p.number}`, { id: b.id, branch: b.branch }] as const)));
  // The merge rows are the ones built above, in merge order.
  const free = ordered.map((e) => rowOfEntry.get(e)!);
  const at = item ? free.findIndex((r) => `${r.repo}:${r.number}` === item) : -1;
  out.itemIndex = at < 0 ? null : at;
  out.mergeRows = free.slice(offset, offset + sizeFor(out.itemIndex));
  out.total = free.length;
  out.next = offset + out.mergeRows.length < free.length ? offset + out.mergeRows.length : null;
  out.nextMerges = nextMerges(entries, places, batchOf, facts.scores);
  out.batches = active.map((b) => toBatch(b, reader, b.members.flatMap((p) => rowOf.get(`${b.repo}#${p.number}`) ?? [])));
  out.pending = pending;
  return out;
}

/**
 * Open PRs approved for merge that are no merge queue row yet: no take review at their head, so they wait for
 * the fix-up or the review first. `entries` are the queue rows the view shows and `want` is the view's scope, so a PR is in exactly one
 * group. Oldest first.
 */
function pendingRows(f: QueuePageFacts, entries: CachedEntry[], want: (repo: string, number: number) => boolean, originOf: (e: Pick<CachedEntry, "repo" | "number" | "reviewedAt">) => QueueOrigin): QueuePendingRow[] {
  const queued = new Set(entries.map((e) => `${e.repo}#${e.number}`));
  const seen = new Set<string>();
  const out: QueuePendingRow[] = [];
  for (const p of f.legs) {
    const k = `${p.repo}#${p.number}`;
    if (p.state !== "fixup" && p.state !== "review" && p.state !== "ci") continue;
    const it = f.pending.get(k);
    if (!it || it.state !== "OPEN" || it.kind !== "pr" || seen.has(k) || queued.has(k) || !want(p.repo, p.number)) continue;
    seen.add(k);
    out.push({
      repo: p.repo, number: p.number, kind: "pr", title: it.title ?? "", author: it.author ?? "", size: f.ranks.get(k)?.breakdown.size ?? null, step: p.state,
      added: originOf({ repo: p.repo, number: p.number, reviewedAt: "" }),
    });
  }
  return out;
}

/**
 * How each PR came into the merge queue, and who put it there: an active merge approval (with or without a fix-up), else the take review itself. Operator logins are shown to staff only.
 */
export function queueOriginOf(f: Pick<QueuePageFacts, "legs" | "carried">, staff: boolean): (e: Pick<CachedEntry, "repo" | "number" | "reviewedAt">) => QueueOrigin {
  const pre = new Map<string, Preapproval>();
  for (const p of f.legs) pre.set(`${p.repo}#${p.number}`, p);
  // A Merge answer carried to a new head is audited as such when its row is made.
  const carried = (target: string, id: number): boolean => (f.carried.get(target) ?? []).some((a) => a.details?.id === id && a.details?.carried != null);
  const who = (login: string | null | undefined) => (staff ? login || null : null);
  return (e) => {
    const p = pre.get(`${e.repo}#${e.number}`);
    if (p) return { how: p.instructions ? "preapproved" : carried(`${p.repo}#${p.number}`, p.id) ? "answer" : "queued", by: who(p.by), at: p.at };
    return { how: "review", by: null, at: e.reviewedAt };
  };
}

// ---- merge holds and batch controls --------------------------------

/** `https://github.com/<owner>/<repo>/pull/<n>` (or `/issues/<n>`), `<repo>#<n>` or `<owner>/<repo>#<n>`. */
export function parseItemRef(input: unknown): { repo: string; number: number } {
  const t = typeof input === "string" ? input.trim() : "";
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(t)
    ?? /^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(t);
  if (!m) throw new Error("not an item: use a GitHub URL, repo#number or owner/repo#number");
  if (m[1] && m[1].toLowerCase() !== ownerOf(m[2]!).toLowerCase()) throw new Error(`${m[1]}/${m[2]} is not a tracked repo of ${m[1]}`);
  return { repo: m[2]!, number: Number(m[3]) };
}

function item(req: Req): { repo: string; number: number } {
  const b = req.json;
  const text = b && typeof b === "object" && !Array.isArray(b) ? (b as { item?: unknown }).item : undefined;
  try {
    return parseItemRef(text);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** Hold and the batch controls are for whoever runs the repo (src/dash/repo-access.ts). */
async function needRunner(req: Req, repo: string): Promise<void> {
  if (!(await mayRunRepo(req.user, repo))) throw new HttpError(403, "no write access to this repo");
}

/** Runs a library call, turning its errors into HTTP ones. */
async function guarded<T>(f: () => Promise<Promise<T> | T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ControlError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** The open PRs of `repo` that close issue `issue` when they merge (GitHub's closing references, from the mirror), in number order. */
export async function openPrsClosing(db: Db, repo: string, issue: number): Promise<number[]> {
  return (closingIndex(await loadOpenPrLinks(db, [repo])).get(`${repo}#${issue}`) ?? []);
}

/** The open PRs that close each issue, by `repo#issue`, in number order. */
function closingIndex(links: Awaited<ReturnType<typeof loadOpenPrLinks>>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [pr, issues] of closingOf(links)) {
    const repo = pr.slice(0, pr.lastIndexOf("#"));
    const n = Number(pr.slice(pr.lastIndexOf("#") + 1));
    for (const i of new Set(issues)) out.set(`${repo}#${i}`, [...(out.get(`${repo}#${i}`) ?? []), n]);
  }
  for (const l of out.values()) l.sort((a, b) => a - b);
  return out;
}

export async function batchRemovePr(db: Db, req: Req, run?: Exec): Promise<{ batch: string; line: string }> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await needRunner(req, r.repo);
  return guarded(async () => holdBatched(db, actorOf(req), "dashboard", r.repo, r.number, run));
}

export async function batchStop(db: Db, req: Req, run?: Exec): Promise<{ batch: string; prs: number[]; held: number[]; closed: number | null }> {
  const id = Number(req.params.id);
  const repo = Number.isInteger(id) ? (await loadBatches(db, [id])).get(id)?.repo : undefined;
  if (!repo) throw new HttpError(404, `no batch ${req.params.id}`);
  await needVisible(db, req, repo);
  await needRunner(req, repo);
  return guarded(async () => stopBatch(db, actorOf(req), "dashboard", id, run));
}
