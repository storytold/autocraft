// JSON API for the dashboard frontend (web/src/api/client.ts `Api`). The
// server has already checked the session, and on POSTs the Origin, the CSRF
// header and the per-session limits; these handlers check roles and GitHub
// permissions themselves. Item and comment text is returned as data only.
import { live } from "./live.ts";
import { mayRunRepo } from "../repo-access.ts";
import { isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import { prBuildView } from "../../prbuild/view.ts";
import { loadItems, loadComments, loadFiles, loadChecks, loadRepos, loadSyncState, listItems } from "../../data/mirror/index.ts";
import { loadStageLog, loadStageFacts, loadStageVersion } from "../../data/planner/index.ts";
import { loadTrackedRepos } from "../../data/control/index.ts";
import { loadReviewRecord } from "../../data/review/index.ts";
import type { ReviewRecord } from "../../data/review/index.ts";
import type { PatchTimelineRow } from "../../data/changes/index.ts";
import type { VerificationView } from "../../data/merge/index.ts";
import { loadPatchTimeline } from "../../data/changes/index.ts";
import { loadLatestVerification } from "../../data/merge/index.ts";
import { loadStatementViews } from "../../data/conversations/index.ts";
import { checksOf } from "../../patchcheck/index.ts";
import { priorityOf } from "../../priority/read.ts";
import { preapprovalOf } from "../../preapproval/index.ts";
import type {
  CiState, Done, Funnel, Item, ItemComment, ItemFixup, ItemPremerge, ItemReviews, ItemState, ItemVerification, ReviewSide, Mergeable, Progress, RepoProgress, Tier, User,
} from "../../../web/src/api/types.ts";
import { trackedNames } from "../../repos.ts";
import { hiddenRepos, allVisibleRepos, needVisible, repoOwners, visibleRepos } from "./visible.ts";
import { contributors } from "../../whitelist.ts";
import { doneByRepo, funnelByRepo, trackingStart, trend, type DoneRow, type FunnelRow } from "./stats.ts";
import { HttpError } from "../server/util.ts";
import type { Req, Res, Route } from "../types.ts";
import * as adm from "./admin.ts";
import { githubUserId } from "../../github/users.ts";
import * as discord from "./discord.ts";
import * as agents from "./agents.ts";
import * as build from "./build.ts";
import * as workspaces from "./workspaces.ts";
import * as mcp from "./mcp.ts";
import * as userSettings from "./user-settings.ts";
import * as maintain from "./maintain.ts";
import * as itemsBrowse from "./items-browse.ts";
import * as authors from "./authors.ts";
import * as maintainItem from "./maintain-item.ts";
import * as runners from "./runners.ts";
import * as modelQueue from "./model-queue.ts";
import * as areas from "./areas.ts";
import * as security from "./security.ts";
import * as securityPage from "./security-page.ts";
import * as insight from "./insight.ts";
import * as pipeline from "./pipeline.ts";
import * as outside from "./outside.ts";
import { prompts } from "./prompts.ts";
import { next } from "./next.ts";
import { health } from "./health.ts";
import { queueSlots } from "../../rank/position.ts";
import * as items from "./items.ts";
import { activity } from "./activity.ts";
import { downloads } from "./downloads.ts";
import { itemPage } from "./item-page.ts";
import { itemChat, postChat, postChatWithdraw } from "./item-chat.ts";
import { trace as itemTrace, traceDetail as itemTraceDetail } from "./trace.ts";
import { mergedAsApproved, postmergeOf } from "./postmerge.ts";
import * as nightly from "./nightly.ts";
import { canSeeInternals } from "./staff.ts";
import * as operator from "./operator.ts";
import { actionsOf as releasesOf } from "../../operator-actions.ts";
import { settle, unflagged } from "../../classify/settled.ts";
import { classifyRun, loadItemAreas, loadSettled } from "../../data/triage/index.ts";
import { loadQuiet } from "../../data/security/index.ts";
import { classificationsOf, relatedOf } from "./related.ts";
import { itemState } from "./shown.ts";
import * as sim from "./similar.ts";
import * as inference from "./inference.ts";
import { localEmbedder, type Embedder } from "../../embed/model.ts";
import type { Exec } from "../../fixup/git.ts";
import { batchOne } from "./batch-page.ts";
import { batchRemovePr, batchStop, queuePage } from "./queue-page.ts";
import { VectorIndex } from "../../embed/vectors.ts";
import { mainCiRepos, summarize } from "../../mainci/index.ts";
import * as commands from "./commands.ts";
import type { Db } from "../../db/index.ts";

export type ApiOptions = {
  // Embeds search queries and items without a stored vector; default: the local model, loaded on first use.
  embedder?: Embedder;
  // Runs `gh` for the batch controls that close a PR; default: the real one. Tests fake it.
  exec?: Exec;
  // Looks up a login's numeric GitHub id when an access entry is added; default: GitHub's API. Tests fake it.
  githubUserId?: adm.GithubUserLookup;
};

const ok = (fn: (db: Db, req: Req) => Promise<unknown>) => async (db: Db, req: Req): Promise<Res> => {
  try {
    const v = await fn(db, req);
    return v === undefined ? { status: 204 } : { json: v };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    throw e;
  }
};

async function writeRepos(db: Db, req: Req): Promise<string[]> {
  const repos = await allVisibleRepos(db, req);
  const ok = await Promise.all(repos.map((r) => req.user.canWrite(r).catch(() => false)));
  return repos.filter((_, i) => ok[i]);
}

/** The visible repos this user runs (src/dash/repo-access.ts): the web reads it instead of the role for per-repo and per-item actions. */
async function runRepos(db: Db, req: Req): Promise<string[]> {
  const repos = await allVisibleRepos(db, req);
  const ok = await Promise.all(repos.map((r) => mayRunRepo(req.user, r)));
  return repos.filter((_, i) => ok[i]);
}

async function me(db: Db, req: Req): Promise<User> {
  return {
    login: req.user.login,
    role: req.user.role,
    writeRepos: await writeRepos(db, req),
    runRepos: await runRepos(db, req),
  };
}

// ---- items and search ------------------------------------------------------

const CI: Record<string, CiState> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };
const MERGEABLE: Record<string, Mergeable> = { MERGEABLE: "clean", CONFLICTING: "conflicts" };
const TIER: Record<string, Tier> = { whitelisted: "whitelisted", not: "not", allow: "override-allow", deny: "override-deny" };

export async function itemCore(db: Db, req: Req): Promise<Item> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  const ref = `${repo}#${n}`;
  // The visibility check decides first: an item of a hidden repo is a 404 for its repo whether or not the mirror has it.
  await needVisible(db, req, repo);
  const it = (await loadItems(db, [{ repo, number: n }], "full")).get(ref);
  if (!it) throw new HttpError(404, `no item ${repo}#${n} in the mirror`);
  let labels: string[] = [];
  try {
    const l = JSON.parse(it.labels ?? "[]") as unknown;
    if (Array.isArray(l)) labels = l.filter((x): x is string => typeof x === "string");
  } catch { /* malformed: no labels */ }
  const internals = canSeeInternals(req);
  const pr = it.kind === "pr";
  const key = [{ repo, number: n }];
  // The parts read independently, so they run together.
  const [c, stageLog, commentRows, quiet, files, checkRows, tracked, related, classifications, area, discordOf, settled, priority, checks, record, timeline, verification, postmerge, asApproved, releases, slots, preapproval, hidden] = await db.together(() => Promise.all([
    it.author ? contributors(db, { login: it.author }).then((cs) => cs.find((x) => x.login === it.author)) : undefined,
    loadStageLog(db, [ref]),
    loadComments(db, key, { order: "created", body: true }),
    loadQuiet(db, [`${repo}#${n}`]).then((q) => q.size > 0),
    pr ? loadFiles(db, key) : new Map<string, never[]>(),
    pr ? loadChecks(db, key) : new Map<string, never>(),
    loadTrackedRepos(db, [repo]),
    relatedOf(db, repo, n), classificationsOf(db, repo, n), loadItemAreas(db, key).then((m) => m.get(ref)?.area ?? null), discord.discordOf(db, repo, n), classifyRun(db).then((run) => loadSettled(db, key, run)).then((m) => m.get(ref) ?? settle(null, null)), priorityOf(db, repo, n),
    checksOf(db, repo, n),
    pr ? loadReviewRecord(db, key) : new Map<string, ReviewRecord>(),
    pr ? loadPatchTimeline(db, key, { internals }) : new Map(),
    pr ? loadLatestVerification(db, key) : new Map(),
    pr ? postmergeOf(db, repo, n, internals) : null,
    pr ? mergedAsApproved(db, repo, n) : false,
    releasesOf(db, repo, n),
    visibleRepos(db, req).then((v) => queueSlots(db, v)),
    pr ? preapprovalOf(db, repo, n) : null,
    pr ? hiddenRepos(db, req) : [],
  ]));
  const rec = record.get(ref);
  const [work, reviews] = pr ? await Promise.all([
    prWork(db, repo, n, it.head_oid, internals, timeline.get(ref) ?? [], verification.get(ref)),
    reviewsOf(db, rec, it.head_oid, internals, hidden),
  ]) : [{ verification: null, fixups: [], prBuild: null }, null];
  const premerge = pr ? premergeOf(rec) : [];
  // The quiet pull request of a security fix: viewers get none of the model text about it.
  const veil = !internals && quiet;
  const out: Item = {
    repo, number: n, kind: it.kind === "pr" ? "pr" : "issue",
    title: it.title ?? "", body: it.body ?? "", state: itemState(it.state), author: it.author ?? "",
    tier: TIER[c?.tier ?? "not"] ?? "not", authorMerged: c?.merged ?? 0, authorClosedUnmerged: c?.closed ?? 0,
    additions: it.additions ?? 0, deletions: it.deletions ?? 0,
    changedFiles: it.kind === "pr" ? it.changed_files : null,
    // Per-check states of the head come from pr_checks and per-file rows from pr_files (src/activity.ts).
    files: (files.get(ref) ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })), ciChecks: ciChecksOf(it.head_oid, checkRows.get(ref)),
    ci: it.kind === "pr" ? (CI[it.ci_state ?? ""] ?? "none") : "none",
    mergeable: MERGEABLE[it.mergeable ?? ""] ?? "unknown",
    labels, createdAt: it.created_at ?? "", updatedAt: it.updated_at ?? "",
    closedAt: it.closed_at, mergedAt: it.merged_at, mergedBy: it.merged_by,
    pipelineOn: tracked.get(repo)?.pipeline === true,
    related, classifications, area,
    // Stage notes quote review reasons, verification summaries and fix-up reasons: staff only.
    stages: (stageLog.get(ref) ?? []).map((s) => ({ stage: s.stage as Item["stages"][number]["stage"], at: s.at, by: s.actor ?? "", note: internals ? s.note : null })),
    discord: discordOf,
    comments: (commentRows.get(ref) ?? []).filter((x) => !(x.kind === "review" && (x.body ?? "").trim() === "")).map((x) => ({
      id: x.id, author: x.author ?? "", at: x.created_at, body: x.body ?? "", kind: x.kind as ItemComment["kind"] | null, reviewState: x.review_state,
    })),
    settled: unflagged(settled, quiet, !veil) as Item["settled"], priority,
    ...work,
    // The reviewer's reasons quote the patch, so viewers get the verdict only.
    patchChecks: checks.map(({ kind, subject, patchHash, round, verdict, reasons, problems, model, createdAt }) =>
      ({ kind, subject, patchHash, round, verdict, reasons: internals ? reasons : "", problems: internals ? problems : [], model, createdAt })),
    reviews,
    premerge,
    postmerge, ...(asApproved && { mergedAsApproved: true }),
    releases,
    queue: slots.get(`${repo}#${n}`) ?? null,
    // The operator's instructions are shown to those who see the internals only.
    ...(pr ? { preapproval: preapproval && !internals ? { ...preapproval, instructions: "" } : preapproval } : {}),
  };
  if (!veil) return out;
  return {
    ...out,
    classifications: out.classifications.map((c) => ({ ...c, reason: "" })),
    priority: out.priority && { ...out.priority, reason: null },
    premerge: out.premerge?.map((p) => ({ ...p, findings: [] })),
    reviews: out.reviews && { ...out.reviews, conflicts: out.reviews.conflicts.map((c) => ({ ...c, reason: "" })) },
  };
}

/** The head's check contexts as the checks sync stored them; empty when they belong to an older head. */
function ciChecksOf(head: string | null, row: { head_oid: string | null; checks: string | null } | undefined): Item["ciChecks"] {
  if (!row || (head !== null && head !== row.head_oid)) return [];
  let list: unknown = [];
  try { list = JSON.parse(row.checks ?? "[]"); } catch { /* malformed: none */ }
  return (Array.isArray(list) ? (list as ({ name?: unknown; state?: unknown } | null)[]) : []).flatMap((c) =>
    c && typeof c.name === "string" ? [{ name: c.name, state: CI[typeof c.state === "string" ? c.state.toUpperCase() : ""] ?? "none", minutes: null }] : []);
}

const jsonList = <T>(s: string | null | undefined): T[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? (v as T[]) : []; } catch { return []; } };

/** Pre-merge review rows of the PR, newest first. */
function premergeOf(rec: ReviewRecord | undefined): ItemPremerge[] {
  return [...(rec?.premerge ?? [])].sort((a, b) => (a.at === b.at ? (a.head_oid < b.head_oid ? 1 : -1) : a.at < b.at ? 1 : -1))
    .map((r) => ({ head: r.head_oid, at: r.at, model: r.model, findings: jsonList<ItemPremerge["findings"][number]>(r.findings), searched: r.searched, error: r.error, tries: r.tries }));
}

/**
 * The owner statements the Opus or the pre-merge review at the head named as conflicts, with the reviews' reasons and the item each
 * was said about. A statement made in a repo hidden from the reader is left out; viewers (`internals` false) get no excerpt or reason.
 */
async function conflictsNamed(db: Db, rec: ReviewRecord, head: string, internals: boolean, hidden: HiddenRepos): Promise<ItemReviews["conflicts"]> {
  const stored: { id?: unknown; reason?: unknown }[][] = [
    rec.latest?.conflicts ?? [],
    jsonList(rec.premerge.find((p) => p.head_oid === head)?.conflicts),
  ];
  const named = stored.flat().filter((h): h is { id: number; reason?: unknown } => typeof h?.id === "number");
  const statements = await loadStatementViews(db, named.map((h) => h.id));
  const out: ItemReviews["conflicts"] = [];
  for (const h of named) {
    if (out.some((d) => d.id === h.id)) continue;
    const d = statements.get(h.id);
    if (!d || isHiddenRepo(hidden, d.repo)) continue;
    out.push({
      id: h.id, repo: d.repo, number: d.number as number, kind: d.kind as "pr" | "issue" | null, state: d.state ? (d.state.toLowerCase() as ItemState) : null, title: d.title,
      excerpt: internals ? d.text.replace(/\s+/g, " ").trim().slice(0, 200) : "", reason: internals && typeof h.reason === "string" ? h.reason : "",
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** `internals` false (viewers): the verdict only; the reviewer's reason, fixes and risks quote the patch. */
async function reviewsOf(db: Db, rec: ReviewRecord | undefined, head: string | null, internals: boolean, hidden: HiddenRepos): Promise<ItemReviews | null> {
  const o = rec?.latest;
  if (!rec || !o) return null;
  return {
    head: o.head, current: o.head === head, conflicts: await conflictsNamed(db, rec, o.head, internals, hidden),
    opus: { verdict: o.verdict as ReviewSide["verdict"], reason: internals ? o.reason : "", fixes: internals ? o.fixes as unknown as ReviewSide["fixes"] : [], risks: internals ? o.risks : [], at: o.at, sure: o.sure, mode: o.mode as "full" | "delta", baseHead: o.base_head },
    final: { verdict: o.verdict as ReviewSide["verdict"], reason: internals ? o.reason : "", decided: true },
  };
}

/** `internals` false (viewers): states only, without job errors or model output. */
async function prWork(db: Db, repo: string, n: number, head: string | null, internals: boolean, timeline: PatchTimelineRow[], latest: { head: string; view: VerificationView } | undefined): Promise<Pick<Item, "verification" | "fixups" | "prBuild">> {
  const v = latest?.view ?? null;
  const plan = (v?.plan ?? null) as Record<string, unknown> | null;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  // Fix-ups and CI fix tries are listed together, oldest first.
  const fixups = timeline.filter((r) => r.kind === "fixup" || r.kind === "cifix").map((f): ItemFixup => ({
    ...(f.kind === "cifix" ? { kind: "ci-fix" as const } : {}),
    fromHead: f.head, toHead: f.toHead, state: f.state as ItemFixup["state"], reason: internals ? f.reason : null, files: internals ? f.files : [], attempt: f.attempt, createdAt: f.createdAt,
  }));
  return {
    fixups,
    prBuild: await prBuildView(db, repo, n, head, internals),
    verification: !v ? null : {
      headSha: v.headSha, baseSha: v.baseSha, current: v.headSha === head, kind: v.kind as ItemVerification["kind"], reason: internals ? v.reason : "",
      plan: !plan ? null : { crates: plan.crate ? [String(plan.crate)] : strings(plan.crates), tests: strings(plan.tests), testLines: typeof plan.test_lines === "number" ? plan.test_lines : null },
      state: v.state, summary: internals ? v.summary : null, note: internals ? v.note : null, createdAt: v.createdAt, finishedAt: v.finishedAt,
      tasks: v.tasks.map((t) => ({ id: t.id, role: t.role, state: t.state, results: internals ? t.results : [], endedAt: t.endedAt })),
    },
  };
}

// ---- progress ----------------------------------------------------------------

const toFunnel = (r: FunnelRow | undefined): Funnel => ({
  open: r?.open ?? 0, classified: r?.classified ?? 0, secondOpinion: r?.second_opinion ?? 0, disagreement: r?.disagreement ?? 0, reviewed: r?.reviewed ?? 0, take: r?.take ?? 0,
  hold: r?.hold ?? 0, close: r?.close ?? 0, waiting: r?.needs_decision ?? 0, batched: r?.batched ?? 0,
});
const toDone = (r: DoneRow | undefined): Done => ({
  mergedByPipeline: r?.merged_pipeline ?? 0, closedByPipeline: r?.closed_pipeline ?? 0, closedByOthers: r?.closed_others ?? 0,
});
const sum = <T extends object>(xs: T[], zero: T): T => {
  const out = { ...zero } as Record<string, number>;
  for (const x of xs) for (const [k, v] of Object.entries(x)) out[k] = (out[k] ?? 0) + (v as number);
  return out as T;
};

type Heavy = Omit<Progress, "mainCi">;
// One entry per set of hidden repos (nearly always the operator's empty set and one other).
const progressCache = new WeakMap<Db, Map<string, { key: string; at: number; value: Heavy }>>();
const PROGRESS_MAX_AGE = 60_000;

// The item-based part of Progress: scans most of the mirror, so it is kept until
// the mirror, the stages or the tracked repos change, or for a minute at most
// (classifier verdicts and the hourly counts show within that minute).
async function progressItems(db: Db, hidden: HiddenRepos): Promise<Heavy> {
  const [repoRows, sync, stages, trackedRepos] = await db.together(() => Promise.all([loadRepos(db, { all: true }), loadSyncState(db), loadStageVersion(db), loadTrackedRepos(db)]));
  const sig = {
    synced: [...repoRows.values()].reduce<string | null>((m, r) => (r.synced_at !== null && (m === null || r.synced_at > m) ? r.synced_at : m), null),
    hw: sync.org_high_water, st_count: stages.count, st_max: stages.maxRowid, tr: [...trackedRepos.keys()].sort().join(","),
  };
  const key = JSON.stringify(sig);
  const cache = progressCache.get(db) ?? progressCache.set(db, new Map()).get(db)!;
  const slot = JSON.stringify([hidden, hidden.visible ?? null]);
  const hit = cache.get(slot);
  if (hit && hit.key === key && Date.now() - hit.at < PROGRESS_MAX_AGE) return hit.value;
  const start = await trackingStart(db);
  const now = Date.now();
  const funnels = new Map((await funnelByRepo(db)).filter((r) => !isHiddenRepo(hidden, r.repo)).map((r) => [r.repo, r]));
  const done = new Map((await doneByRepo(db, start)).filter((r) => !isHiddenRepo(hidden, r.repo)).map((r) => [r.repo, r]));
  const perHour = new Array<number>(24).fill(0);
  const perHourPipeline = new Array<number>(24).fill(0);
  const since = now - 24 * 3600_000;
  const closed = await listItems(db, { repos: [...trackedRepos.keys()], states: ["CLOSED", "MERGED"], closedBetween: [new Date(since).toISOString(), new Date(now + 3600_000).toISOString()], hidden }, "card");
  const latest = await loadStageFacts(db, closed.map((r) => ({ repo: r.repo, number: r.number })));
  for (const r of closed.map((i) => ({ closed_at: i.closed_at!, ours: ["merged", "closed", "fixed-by-us"].includes(latest.get(`${i.repo}#${i.number}`)?.stage ?? "") }))) {
    const h = Math.floor((Date.parse(r.closed_at) - since) / 3600_000);
    if (h >= 0 && h < 24) {
      perHour[h]!++;
      if (r.ours) perHourPipeline[h]!++;
    }
  }
  const names = [...new Set([...await trackedNames(db), ...funnels.keys(), ...done.keys()])].filter((n) => !isHiddenRepo(hidden, n)).sort();
  const { series } = await trend(db, start, new Map(names.map((n) => [n, funnels.get(n)?.open ?? 0])));
  const repos: RepoProgress[] = names.map((repo) => ({
    repo, funnel: toFunnel(funnels.get(repo)), done: toDone(done.get(repo)),
    openTrend: series.get(repo)!,
  }));
  const value: Heavy = {
    trackingSince: start, now: new Date(now).toISOString(),
    funnel: sum(repos.map((r) => r.funnel), toFunnel(undefined)),
    done: sum(repos.map((r) => r.done), toDone(undefined)),
    perHour, perHourPipeline, repos,
  };
  cache.set(slot, { key, at: now, value });
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return value;
}

async function progress(db: Db, hidden: HiddenRepos): Promise<Progress> {
  const [heavy, ci] = await Promise.all([progressItems(db, hidden), mainCiRepos(db, hidden)]);
  return { ...heavy, mainCi: summarize(ci) };
}

// ---- routes --------------------------------------------------------------

export function apiRoutes(opts: ApiOptions = {}): Route[] {
  const vectors = new VectorIndex(opts.embedder ?? localEmbedder({ threads: 2 }));
  const get = (pattern: string, fn: (db: Db, req: Req) => Promise<unknown>): Route => ({ method: "GET", pattern, handler: ok(fn) });
  const post = (pattern: string, fn: (db: Db, req: Req) => Promise<unknown>): Route => ({ method: "POST", pattern, handler: ok(fn) });
  const heavy = (r: Route, when?: (q: URLSearchParams) => boolean): Route => ({ ...r, expensive: when ?? true });
  // The lists the web app's project picker narrows; pages reached by their own link, writes, search and settings see every repo.
  const scoped = (r: Route): Route => ({ ...r, scoped: true });
  return [
    get("/api/me", me),
    get("/api/repos", allVisibleRepos),
    get("/api/repos/owners", repoOwners),
    // The maintainer workflow's commands and controls (src/workflow/apply.ts).
    post("/api/items/:repo/:n/command", commands.itemCommand),
    get("/api/mention", (db) => commands.mention(db)),
    post("/api/commands", commands.listCommand),
    post("/api/controls", commands.control),
    get("/api/mcp/tokens", mcp.tokens),
    post("/api/mcp/tokens", mcp.create),
    post("/api/mcp/tokens/revoke", mcp.revoke),
    scoped(get("/api/maintain/home", maintain.home)),
    get("/api/maintain/asked", maintain.asked),
    get("/api/maintain/queue", maintain.queueMeta),
    scoped(get("/api/maintain/stats", maintain.stats)),
    // The Items page: three lists of the open items, the Backlog or the closed items, with filters and search.
    scoped(get("/api/maintain/items", maintain.items)),
    // The Items browser: one page of the items matching a search with qualifiers, presets and quick-filter values.
    scoped(get("/api/maintain/browse", itemsBrowse.browse)),
    get("/api/maintain/items/:repo/:n", maintainItem.item),
    // An author's item counts, for their page and the hover card on their name.
    get("/api/authors/:login", authors.stats),
    get("/api/maintain/repos", maintain.repos),
    get("/api/me/settings", userSettings.settings),
    { method: "PUT", pattern: "/api/me/settings", handler: ok(userSettings.setSettings) },
    get("/api/runners", runners.list),
    get("/api/runners/pending", runners.pending),
    post("/api/runners/approve", runners.approve),
    post("/api/runners/deny", runners.deny),
    post("/api/runners/revoke", runners.revoke),
    post("/api/runners/scopes", runners.scopes),
    post("/api/runners/rename", runners.rename),
    get("/api/model-queue", modelQueue.get),
    post("/api/model-queue/:id/pick", modelQueue.pick),
    post("/api/model-queue/:id/unpick", modelQueue.unpick),
    get("/api/items/:repo/:n", itemCore),
    get("/api/items/:repo/:n/page", itemPage),
    get("/api/items/:repo/:n/chat", itemChat),
    post("/api/items/:repo/:n/chat", postChat),
    post("/api/items/:repo/:n/chat/withdraw", postChatWithdraw),
    get("/api/items/:repo/:n/peek", items.peek),
    scoped(get("/api/activity", activity)),
    get("/api/downloads", downloads),
    get("/api/items/:repo/:n/trace", itemTrace),
    get("/api/items/:repo/:n/trace/event", itemTraceDetail),
    { method: "POST", pattern: "/api/items/:repo/:n/preapproval/cancel", handler: ok(operator.cancelItemPreapproval) },
    { method: "POST", pattern: "/api/items/:repo/:n/preapproval/retry", handler: ok(operator.retryItemPreapproval) },
    { method: "POST", pattern: "/api/items/:repo/:n/review-again", handler: ok(operator.reviewItemAgain) },
    { method: "POST", pattern: "/api/items/:repo/:n/verify-again", handler: ok(operator.verifyItemAgain) },
    { method: "POST", pattern: "/api/items/:repo/:n/stop-fix", handler: ok(operator.stopFixItem) },
    get("/api/areas/:repo", areas.repoAreas),
    { method: "POST", pattern: "/api/areas/:repo/edit", handler: ok(areas.edit) },
    { method: "POST", pattern: "/api/areas/:repo/run", handler: ok(areas.run) },
    { method: "POST", pattern: "/api/area-proposals/:id/accept", handler: ok(areas.acceptProposalApi) },
    { method: "POST", pattern: "/api/area-proposals/:id/dismiss", handler: ok(areas.dismiss) },
    { method: "POST", pattern: "/api/items/:repo/:n/batch-again", handler: ok(operator.batchItemAgain) },
    heavy(get("/api/search", async (db, req) => req.query.get("mode") === "semantic" ? sim.semanticSearch(db, req, vectors) : items.quickSearch(db, req)), (q) => q.get("mode") === "semantic"),
    get("/api/progress", async (db, req) => await progress(db, await hiddenRepos(db, req))),
    get("/api/main-ci", async (db, req) => {
      const repos = await mainCiRepos(db, await hiddenRepos(db, req));
      return { summary: summarize(repos), repos };
    }),
    get("/api/main-ci/summary", async (db, req) => summarize(await mainCiRepos(db, await hiddenRepos(db, req)))),
    heavy(get("/api/contributors", adm.listContributors)),
    heavy(get("/api/contributors/rule-preview", adm.previewRule)),
    post("/api/contributors/rule", adm.saveRule),
    post("/api/contributors/:login/override", async (db, req) => adm.override(db, req, opts.githubUserId ?? githubUserId)),
    get("/api/repos/all", adm.allRepos),
    post("/api/repos/track", async (db, req) => adm.track(db, req, true)),
    post("/api/repos/untrack", async (db, req) => adm.track(db, req, false)),
    post("/api/repos/labels-approve", async (db, req) => await adm.labelsApproval(db, req, true)),
    post("/api/repos/labels-revoke", async (db, req) => await adm.labelsApproval(db, req, false)),
    post("/api/repos/merge-approve", async (db, req) => await adm.mergeApproval(db, req, true)),
    post("/api/repos/merge-revoke", async (db, req) => await adm.mergeApproval(db, req, false)),
    post("/api/repos/ci-approve", async (db, req) => await adm.ciApproval(db, req, true)),
    post("/api/repos/ci-revoke", async (db, req) => await adm.ciApproval(db, req, false)),
    get("/api/sandbox/workspace", adm.workspaceInfo),
    { method: "GET", pattern: "/api/admin/discord", operator: true, handler: ok(discord.setup) },
    { method: "PUT", pattern: "/api/admin/discord/channel", operator: true, handler: ok(discord.putChannel) },
    { method: "PUT", pattern: "/api/admin/discord/channel-repo", operator: true, handler: ok(discord.putChannelRepo) },
    { method: "POST", pattern: "/api/admin/discord/unlink", operator: true, handler: ok(discord.removeLink) },
    { method: "POST", pattern: "/api/admin/discord/filing-repos/add", operator: true, handler: ok(discord.addFiling) },
    { method: "POST", pattern: "/api/admin/discord/filing-repos/remove", operator: true, handler: ok(discord.removeFiling) },
    { method: "POST", pattern: "/api/admin/discord/offer", operator: true, handler: ok(discord.setOffer) },
    get("/api/account/discord", discord.account),
    post("/api/account/discord/unlink", discord.unlinkOwn),
    post("/api/account/discord/code", discord.linkCode),
    { method: "PUT", pattern: "/api/admin/discord/contact", operator: true, handler: ok(discord.putContact) },
    { method: "PUT", pattern: "/api/admin/discord/react", operator: true, handler: ok(discord.putReact) },
    { method: "PUT", pattern: "/api/admin/discord/role-panel", operator: true, handler: ok(discord.putRolePanel) },
    { method: "PUT", pattern: "/api/sandbox/workspace", operator: true, handler: ok(adm.setWorkspaceInfo) },
    get("/api/merge/single", adm.singleMerge),
    { method: "PUT", pattern: "/api/merge/single", operator: true, handler: ok(adm.setSingleMerge) },
    { method: "GET", pattern: "/api/settings/inference", operator: true, handler: ok(inference.get) },
    { method: "PUT", pattern: "/api/settings/inference", operator: true, handler: ok(inference.put) },
    { method: "GET", pattern: "/api/settings/jev", operator: true, handler: ok(inference.getJev) },
    { method: "PUT", pattern: "/api/settings/jev", operator: true, handler: ok(inference.putJev) },
    post("/api/repos/comment-approve", async (db, req) => await adm.commentApproval(db, req, true)),
    post("/api/repos/comment-revoke", async (db, req) => await adm.commentApproval(db, req, false)),
    post("/api/repos/push-approve", async (db, req) => await adm.pushApproval(db, req, true)),
    post("/api/repos/push-revoke", async (db, req) => await adm.pushApproval(db, req, false)),
    post("/api/repos/fixissue-approve", async (db, req) => await adm.fixIssueApproval(db, req, true)),
    post("/api/repos/fixissue-revoke", async (db, req) => await adm.fixIssueApproval(db, req, false)),
    post("/api/repos/prstatus-approve", async (db, req) => await adm.statusApproval(db, req, true)),
    post("/api/repos/prstatus-revoke", async (db, req) => await adm.statusApproval(db, req, false)),
    post("/api/repos/mainfix-approve", async (db, req) => await adm.mainFixApproval(db, req, true)),
    post("/api/repos/mainfix-revoke", async (db, req) => await adm.mainFixApproval(db, req, false)),
    post("/api/repos/optional-check-add", async (db, req) => await adm.optionalCheck(db, req, true)),
    post("/api/repos/optional-check-remove", async (db, req) => await adm.optionalCheck(db, req, false)),
    post("/api/repos/pipeline-on", async (db, req) => await adm.pipelineSwitch(db, req, true)),
    post("/api/repos/pipeline-off", async (db, req) => await adm.pipelineSwitch(db, req, false)),
    post("/api/repos/build-feature", adm.buildFeatureSwitch),
    { method: "GET", pattern: "/api/access", operator: true, handler: ok(adm.accessOverview) },
    { method: "POST", pattern: "/api/access/add", operator: true, handler: ok(async (db, req) => adm.accessAdd(db, req, opts.githubUserId ?? githubUserId)) },
    { method: "POST", pattern: "/api/access/remove", operator: true, handler: ok(adm.accessRemove) },
    { method: "POST", pattern: "/api/access/role", operator: true, handler: ok(adm.accessRole) },
    { method: "POST", pattern: "/api/access/sessions/revoke", operator: true, handler: ok(adm.revokeSession) },
    { method: "POST", pattern: "/api/access/tokens/revoke", operator: true, handler: ok(adm.revokeAgentToken) },
    get("/api/audit", adm.auditLog),
    get("/api/classifiers", insight.classifiersReport),
    get("/api/classifiers/disagreements", insight.disagreements),
    get("/api/cost", insight.cost),
    get("/api/pipeline", pipeline.overview),
    get("/api/pipeline/jobs", pipeline.jobs),
    get("/api/pipeline/jobs/:id", pipeline.job),
    { method: "POST", pattern: "/api/pipeline/jobs", operator: true, handler: ok(pipeline.request) },
    { method: "POST", pattern: "/api/pipeline/jobs/:id/cancel", handler: ok(pipeline.cancel) },
    get("/api/pipeline/state", pipeline.state),
    { method: "PUT", pattern: "/api/pipeline/state", operator: true, handler: ok(pipeline.putState) },
    { method: "PUT", pattern: "/api/pipeline/limits/:step", operator: true, handler: ok(pipeline.putLimit) },
    { method: "POST", pattern: "/api/pipeline/limits/:step/reset", operator: true, handler: ok(pipeline.resetLimit) },
    { method: "POST", pattern: "/api/pipeline/steps/:step/deadline-ack", operator: true, handler: ok(pipeline.ackStepDeadline) },
    { method: "POST", pattern: "/api/pipeline/trips/:stage/resume", handler: ok(pipeline.resumeTrip) },
    { method: "PUT", pattern: "/api/pipeline/outside-limits", operator: true, handler: ok(outside.putLimits) },
    { method: "GET", pattern: "/api/pipeline/outside/held", operator: true, handler: ok(outside.held) },
    { method: "POST", pattern: "/api/pipeline/outside/release", operator: true, handler: ok(outside.releaseAll) },
    { method: "POST", pattern: "/api/items/:repo/:n/release-outside", handler: ok(outside.release) },
    get("/api/prompts", prompts),
    get("/api/agents", agents.list),
    get("/api/agents/refusals", agents.refusals),
    get("/api/agents/:id", agents.detail),
    // A transcript is read from the store and inflated (up to RAW_MAX): each read spends the expensive-GET budget.
    heavy({ method: "GET", pattern: "/api/agents/:id/transcripts/:tid", external: true, handler: ok(agents.transcript) }),
    heavy({ method: "GET", pattern: "/api/agents/:id/transcripts/:tid/download", external: true, handler: agents.transcriptDownload }),
    { method: "GET", pattern: "/api/admin/transcript-store", operator: true, handler: ok(agents.storeGet) },
    { method: "PUT", pattern: "/api/admin/transcript-store", operator: true, handler: ok(agents.storePut) },
    { method: "DELETE", pattern: "/api/admin/transcript-store", operator: true, handler: ok(agents.storeClear) },
    { method: "POST", pattern: "/api/admin/transcript-store/test", operator: true, external: true, handler: ok(agents.storeTest) },
    get("/api/rates", agents.rates),
    get("/api/envs", build.envs),
    get("/api/envs/caches", build.caches),
    { method: "POST", pattern: "/api/envs", operator: true, handler: ok(build.postEnv) },
    { method: "PUT", pattern: "/api/envs/:id", operator: true, handler: ok(build.putEnv) },
    { method: "POST", pattern: "/api/envs/:id/rotate-key", operator: true, handler: ok(build.postRotate) },
    get("/api/workspaces", workspaces.list),
    get("/api/workspaces/:id", workspaces.detail),
    get("/api/workspaces/:id/calls", workspaces.calls),
    get("/api/workspaces/:id/calls/:call", workspaces.output),
    { method: "GET", pattern: "/api/workspaces/:id/calls/:call/image", handler: workspaces.image },
    get("/api/tasks", build.tasks),
    get("/api/tasks/:id", build.task),
    { method: "POST", pattern: "/api/tasks/:id/cancel", handler: ok(build.cancel) },
    { method: "GET", pattern: "/api/tasks/:id/artifacts/:name", external: true, handler: build.artifact },
    { method: "GET", pattern: "/api/implementations/:id/shots/:file", external: true, handler: build.implementationShot },
    get("/api/nightly", nightly.grid),
    get("/api/nightly/bench/:repo/:bench", nightly.series),
    { method: "POST", pattern: "/api/nightly/select", handler: ok(nightly.select) },
    { method: "POST", pattern: "/api/nightly/issue", handler: ok((db, req) => nightly.openIssue(db, req)) },
    get("/api/build/summary", build.buildSummary),
    get("/api/build/features", build.features),
    { method: "POST", pattern: "/api/build/features", handler: ok(build.postFeature) },
    get("/api/build/screenshots", build.screenshots),
    { method: "PUT", pattern: "/api/build/screenshots/:repo", handler: ok(build.putScreenshots) },
    { method: "DELETE", pattern: "/api/build/screenshots/:repo", handler: ok(build.deleteScreenshots) },
    scoped(get("/api/next", next)),
    get("/api/batches/:id", batchOne),
    scoped(get("/api/queue/page", queuePage)),
    { method: "POST", pattern: "/api/merge/batch-remove", handler: ok(async (db, req) => batchRemovePr(db, req, opts.exec)) },
    { method: "POST", pattern: "/api/queue/batches/:id/stop", handler: ok(async (db, req) => batchStop(db, req, opts.exec)) },
    get("/api/repos/:repo/security", security.security),
    post("/api/repos/:repo/security/scans", security.startScan),
    get("/api/security/scans", security.scans),
    get("/api/security/scans/:id", security.scanOf),
    post("/api/security/scans/:id/stop", security.stopScan),
    post("/api/security/scans/:id/continue", security.continueScan),
    get("/api/security/findings/:repo/:n", security.finding),
    post("/api/security/findings/:repo/:n", security.actOnFinding),
    scoped(get("/api/live-board", live)),
    get("/api/health", health),
    heavy(get("/api/similar/:repo/:n", async (db, req) => sim.similar(db, req, vectors))),
    get("/api/security/findings", securityPage.securityFindings),
    get("/api/security/findings/:repo/:n/page", securityPage.findingPage),
  ];
}
