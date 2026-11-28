// Mirror of every issue and PR of the tracked owners (storytold and any other owner of a tracked repo) into SQLite, via `gh api graphql`.
import { isCounted } from "./review/discussion.ts";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { reloadRepoOwners, trackedNames } from "./repos.ts";
import { hashColumns } from "./itemhash.ts";
import { textRefs } from "./core/open-prs.ts";
import { syncActivity } from "./activity.ts";
import { mentionNames, rememberSlug } from "./github/slugs.ts";
import { appSlug } from "./github/identity.ts";
import { envVar } from "./env.ts";
import { markUnsent } from "./github/unsent.ts";
import { AppReadError, ownerOfVariables, readEnv, resolveOwner } from "./github/read.ts";
import { DEFAULT_OWNER, ownerOf, slugOf } from "./owners.ts";
import { classifyFailure, clearRepoFailure, recordRepoFailure } from "./sync-errors.ts";
import { exclusive } from "./async-seq.ts";
import { isFenced } from "./db/fence.ts";
import type { Db } from "./db/index.ts";
import { closeDb, dbLockName, openDb, setDbRole } from "./db/open.ts";
import { loadTrackedRepos, readSettingsSnapshot, withSettingsSnapshot } from "./data/control/index.ts";
import { effect } from "./db/effects.ts";
import {
  advanceOrgHighWater, advanceRepoHighWater, applyLocal, clearRepoFailures, closeGoneItems, countItemsByRepo, finishSyncRun, listItems, loadItemReads, loadRepos, loadSyncPlan,
  markReposReconciled, markReposRead, markReposSyncedByError, saveItems, saveRepoList, saveSyncState, startSyncRun,
  type CommentInsert, type ItemEntry, type ItemRowInput, type SyncPlan, type SyncState,
} from "./data/mirror/index.ts";


const OVERLAP_MS = 10 * 60 * 1000;
const FULL_PAGE = 30;
const LIGHT_PAGE = 100;
const MIN_PAGE = 10;

type Kind = "issue" | "pr";
type Detail = "full" | "light";
// GraphQL nodes are untyped JSON; fields are read by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export const REPOS_QUERY = `
query($login: String!, $after: String) {
  rateLimit { cost remaining resetAt }
  repositoryOwner(login: $login) {
    repositories(first: 100, after: $after, isArchived: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name visibility defaultBranchRef { name }
        pullRequests(states: OPEN) { totalCount }
        issues(states: OPEN) { totalCount }
      }
    }
  }
}`;

export const COMMON = `number title body url author { login __typename ... on User { databaseId } ... on Bot { databaseId } } authorAssociation createdAt updatedAt closedAt state
  labels(first: 10) { nodes { name } } assignees(first: 5) { nodes { login } }
  commentCount: comments { totalCount } reactionCount: reactions { totalCount }`;
export const COMMENTS = "comments(last: 20) { nodes { id author { login __typename } authorAssociation createdAt body url } }";
export const PR_EXTRA = `isDraft mergedAt mergedBy { login } additions deletions changedFiles
  headRefName headRefOid headRepository { nameWithOwner } baseRefName
  closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }`;
export const PR_FULL = `maintainerCanModify mergeable reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviews(last: 10) { nodes { id author { login __typename } authorAssociation createdAt body url state commit { oid } comments { totalCount } } }`;

export function itemsQuery(kind: Kind, detail: Detail): string {
  const [conn, stateType] = kind === "issue" ? ["issues", "IssueState"] : ["pullRequests", "PullRequestState"];
  let fields = `${COMMON} ${kind === "issue" ? "stateReason" : PR_EXTRA}`;
  if (detail === "full") fields += ` ${COMMENTS}${kind === "pr" ? ` ${PR_FULL}` : ""}`;
  return `
query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [${stateType}!]) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    ${conn}(first: $first, after: $after, states: $states,
            orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${fields} }
    }
  }
}`;
}

export class Transient extends Error {}

/** A GitHub call that failed with a structured answer: the HTTP status gh reports (0 when none) and the GraphQL error `type` (FORBIDDEN, NOT_FOUND, …). */
export class GithubError extends Error {
  readonly status: number;
  readonly type: string | null;
  constructor(message: string, status: number, type: string | null) { super(message); this.status = status; this.type = type; }
}
/** The status of gh's own "(HTTP 403)" line. */
export const httpStatusOf = (stderr: string): number => Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1] ?? 0);


export class Client {
  reserve: number;
  remaining: number | null = null;
  resetAt: Date | null = null;
  spent = 0;

  /** The child's whole environment when set (the app lane's token); otherwise it is the read environment of the current identity. */
  private env: Record<string, string> | undefined;
  /** Rate figures per account: "" for the box account or a fixed env, else the installation's owner. `remaining`/`resetAt` are the current key's. */
  private rates = new Map<string, { remaining: number | null; resetAt: Date | null }>();
  private rateKey = "";

  constructor(reserve: number, env?: Record<string, string>) {
    this.reserve = reserve;
    this.env = env;
  }

  async sleepUntilReset(why: string): Promise<void> {
    const ms = this.resetAt ? Math.max(5_000, this.resetAt.getTime() - Date.now() + 5_000) : 60_000;
    console.log(`  ${why}: sleeping ${Math.round(ms / 1000)}s until rate limit reset`);
    await sleep(ms);
    this.remaining = null;
  }

  /**
   * The environment of the next gh child and the key of its rate figures: the fixed one, else the app's installation
   * token of the owner (under `app`; rate limits belong to the installation) or gh's own login (`box`, key "").
   */
  private async childEnv(owner?: string): Promise<{ env: Record<string, string> | undefined; key: string }> {
    if (this.env) return { env: this.env, key: "" };
    let env: Record<string, string> | undefined;
    try {
      env = await readEnv(owner);
    } catch (e) {
      // A token that cannot be minted now may be minted later; a missing installation is final.
      if (e instanceof AppReadError && !e.notInstalled) throw new Transient(e.message);
      throw e;
    }
    return { env, key: env ? (await resolveOwner(owner)).toLowerCase() : "" };
  }

  /** Makes the rate figures those of `key` (an installation, or the box account). */
  private useRate(key: string): void {
    if (key === this.rateKey) return;
    this.rates.set(this.rateKey, { remaining: this.remaining, resetAt: this.resetAt });
    const r = this.rates.get(key);
    this.remaining = r?.remaining ?? null;
    this.resetAt = r?.resetAt ?? null;
    this.rateKey = key;
  }

  /** Runs gh without blocking the event loop (the runner's tick must keep its heartbeat and cancels). A timeout or spawn error is Transient. */
  private async run(query: string, variables: object, env: Record<string, string> | undefined): Promise<{ data?: Node; errors: Node[]; text: string; failed: boolean; stderr: string }> {
    const p = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve, reject) => {
      const child = spawn("gh", ["api", "graphql", "--input", "-"], { stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const fail = (): void => { clearTimeout(timer); child.kill("SIGKILL"); reject(new Transient("timeout")); };
      const timer = setTimeout(fail, 120_000);
      child.stdout.on("data", (c: Buffer) => { size += c.length; if (size > (256 << 20)) fail(); else out.push(c); });
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", fail);
      child.on("close", (status) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), status }); });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ query, variables }));
    });
    let json: Node = {};
    try {
      json = JSON.parse(p.stdout);
    } catch {
      // gh prints errors on stderr when there is no JSON body
    }
    // Never the data: it holds text people wrote. gh writes GitHub's error message to stderr.
    const errors: Node[] = json.errors ?? [];
    const text = `${p.stderr}${errors.length ? JSON.stringify(errors) : ""}`.toLowerCase();
    return { data: json.data, errors, text, failed: p.status !== 0, stderr: p.stderr };
  }

  /** The `owner/name` GitHub's REST endpoint redirects a moved repo to, or null when it does not answer with another name. */
  async repoMovedTo(owner: string, name: string): Promise<string | null> {
    const { env } = await this.childEnv(owner);
    const p = spawnSync("gh", ["api", `repos/${owner}/${name}`, "--jq", ".full_name"], { encoding: "utf8", timeout: 30_000, ...(env ? { env } : {}) });
    const full = p.status === 0 ? p.stdout.trim() : "";
    return full && full.toLowerCase() !== `${owner}/${name}`.toLowerCase() ? full : null;
  }

  async query(query: string, variables: object): Promise<Node> {
    // Mutations are counted where they are recorded (src/github/write.ts).
    if (!/^\s*mutation\b/.test(query)) effect("github-read");
    const { env, key } = await this.childEnv(ownerOfVariables(variables)).catch((e) => { throw markUnsent(e); });
    this.useRate(key);
    if (this.remaining !== null && this.remaining < this.reserve) {
      await this.sleepUntilReset(`${this.remaining} points left, reserve ${this.reserve}`);
    }
    const r = await this.run(query, variables, env);
    if ((r.failed || r.errors.length > 0) && (r.text.includes("secondary rate limit") || r.text.includes("abuse"))) {
      console.log("  secondary rate limit: sleeping 90s");
      await sleep(90_000);
      throw new Transient("secondary");
    }
    if (r.errors.some((e: Node) => e.type === "RATE_LIMITED") || (r.failed && r.text.includes("rate limit"))) {
      await this.sleepUntilReset("rate limit exhausted");
      throw new Transient("rate limited");
    }
    // An org search also lists items of repos the app cannot read (one it is not installed on): GitHub nulls those results
    // and reports each beside them. Dropping them keeps the page; a tracked repo without access shows on the app-coverage check.
    const refused = r.data?.search?.nodes ? refusedSearchNodes(r.errors) : null;
    if (refused) {
      for (const i of refused) r.data.search.nodes[i] = null;
      console.warn(`  skipped ${refused.size} search result${refused.size === 1 ? "" : "s"} GitHub refused for lack of access`);
    }
    if (r.errors.length && !r.data?.repository && !r.data?.repositoryOwner && !r.data?.search) {
      if (/node_limit|resource_limits|timeout|something went wrong/.test(r.text)) throw new Transient("query too heavy");
      const typed = r.errors.find((e: Node) => e.type === "FORBIDDEN" || e.type === "NOT_FOUND") ?? r.errors[0];
      throw new GithubError(`graphql error: ${JSON.stringify(r.errors).slice(0, 500)}`, httpStatusOf(r.stderr), typeof typed?.type === "string" ? typed.type : null);
    }
    // A deleted or transferred item is a NOT_FOUND error beside a null field, and gh exits non-zero; with the repository
    // present the answer is that null field, which callers handle.
    const missingOnly = (r.errors.length > 0 && r.errors.every((e: Node) => e.type === "NOT_FOUND") && !!r.data?.repository) || refused !== null;
    if (r.failed && !missingOnly) {
      if (/502|503|504|timeout|eof|connection|unexpected end of json/.test(r.text)) throw new Transient(r.stderr.trim().slice(0, 200));
      throw new GithubError(`gh failed: ${r.stderr.trim().slice(0, 500)}`, httpStatusOf(r.stderr), null);
    }
    const rl = r.data.rateLimit; // absent in mutation responses
    if (rl) {
      this.remaining = rl.remaining;
      this.spent += rl.cost;
      this.resetAt = new Date(rl.resetAt);
    }
    return r.data;
  }
}

// Newest first, lazily: stopping early saves requests. Halves the page size on transient errors.
async function* fetchPages(client: Querier, kind: Kind, detail: Detail, name: string, states: string[]): AsyncGenerator<Node[]> {
  const query = itemsQuery(kind, detail);
  let size = detail === "full" ? FULL_PAGE : LIGHT_PAGE;
  let cursor: string | null = null;
  let failures = 0;
  for (;;) {
    let data: Node;
    try {
      data = await client.query(query, { owner: ownerOf(name), name, first: size, after: cursor, states });
    } catch (e) {
      if (!(e instanceof Transient)) throw e;
      if (size > MIN_PAGE) {
        size = Math.max(MIN_PAGE, size >> 1);
        console.log(`  ${e.message}: page size ${size}`);
      } else if (++failures > 6) {
        throw e;
      } else {
        await sleep(Math.min(30_000 * failures, 300_000));
      }
      continue;
    }
    failures = 0;
    const conn: Node = data.repository[kind === "issue" ? "issues" : "pullRequests"];
    yield conn.nodes;
    if (!conn.pageInfo.hasNextPage) return;
    cursor = conn.pageInfo.endCursor;
  }
}

// Passes pages through, dropping items updated before cutoff and ending at the first such item.
export async function* untilCutoff(pages: AsyncIterable<Node[]>, cutoff: string | null): AsyncGenerator<Node[]> {
  for await (const page of pages) {
    const keep = page.filter((n) => cutoff === null || n.updatedAt >= cutoff);
    if (keep.length) yield keep;
    if (keep.length < page.length) return;
  }
}

const login = (n: Node): string | null => n?.login ?? null;

function toRow(repo: string, kind: Kind, n: Node, detail: Detail): ItemRowInput {
  const r = baseRow(repo, kind, n, detail);
  Object.assign(r, hashColumns(r));
  // Numbers a pull request's text closes or mentions; the writer stores them with the row.
  if (kind === "pr") r.text_refs = textRefs(r.title, r.body);
  return r;
}

/** True when `nameWithOwner` is the repo of the item at `url` (https://github.com/<owner>/<repo>/...). */
const sameRepo = (nameWithOwner: unknown, url: unknown): boolean =>
  typeof nameWithOwner === "string" && typeof url === "string" && url.toLowerCase().startsWith(`https://github.com/${nameWithOwner.toLowerCase()}/`);

function baseRow(repo: string, kind: Kind, n: Node, detail: Detail): ItemRowInput {
  const r = {} as Record<string, unknown> as ItemRowInput;
  Object.assign(r, {
    repo, number: n.number, kind, state: n.state, title: n.title, body: n.body, url: n.url,
    author: login(n.author), author_type: n.author?.__typename ?? null, author_id: typeof n.author?.databaseId === "number" ? n.author.databaseId : null, author_association: n.authorAssociation,
    created_at: n.createdAt, updated_at: n.updatedAt, closed_at: n.closedAt,
    labels: JSON.stringify((n.labels?.nodes ?? []).filter(Boolean).map((x: Node) => x.name)),
    assignees: JSON.stringify((n.assignees?.nodes ?? []).filter(Boolean).map((x: Node) => x.login)),
    comments_count: n.commentCount?.totalCount ?? 0, reactions_count: n.reactionCount?.totalCount ?? null, detail_level: detail,
  });
  if (kind === "issue") {
    r.state_reason = n.stateReason;
    return r;
  }
  Object.assign(r, {
    is_draft: Number(n.isDraft), merged_at: n.mergedAt, merged_by: login(n.mergedBy),
    additions: n.additions, deletions: n.deletions, changed_files: n.changedFiles,
    head_ref: n.headRefName, head_oid: n.headRefOid, head_repo: n.headRepository?.nameWithOwner ?? null,
    base_ref: n.baseRefName,
    // Numbers only, so an issue of another repo would read as this repo's: those are left out.
    closing_issues: JSON.stringify((n.closingIssuesReferences?.nodes ?? []).filter((x: Node) => x && (!x.repository || sameRepo(x.repository.nameWithOwner, n.url))).map((x: Node) => x.number)),
  });
  if (detail === "full") {
    Object.assign(r, {
      maintainer_can_modify: Number(n.maintainerCanModify), mergeable: n.mergeable,
      review_decision: n.reviewDecision, ci_state: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    });
  }
  return r;
}

/** 1 when the body names the pipeline login; the needs page lists such comments through an index. */
const mentions = (body: unknown, names: string[]): number => {
  if (typeof body !== "string") return 0;
  const b = body.toLowerCase();
  return names.some((n) => n && b.includes(`@${n.toLowerCase()}`)) ? 1 : 0;
};

function commentRows(repo: string, kind: Kind, n: Node, own: string[]): CommentInsert[] {
  // `counted`: whether the entry counts as new discussion for the review stage (src/review/discussion.ts).
  const counted = (c: Node) => Number(isCounted({ author: login(c.author), association: c.authorAssociation, bot: c.author?.__typename === "Bot", prAuthor: login(n.author), state: c.state, body: c.body, inline: c.comments?.totalCount }));
  const rows: CommentInsert[] = (n.comments?.nodes ?? []).filter(Boolean).map((c: Node) =>
    ({ repo, number: n.number, id: c.id, kind: "comment", author: login(c.author), created_at: c.createdAt, body: c.body, review_state: null, commit_oid: null, counted: counted(c), author_association: c.authorAssociation ?? null, mentions_pipeline: mentions(c.body, own), url: c.url ?? null }));
  if (kind === "pr") {
    for (const c of (n.reviews?.nodes ?? []).filter(Boolean)) {
      // A review without a body still counts: its inline threads are the discussion, and it makes earlier reviews stale.
      rows.push({ repo, number: n.number, id: c.id, kind: "review", author: login(c.author), created_at: c.createdAt, body: c.body, review_state: c.state, commit_oid: c.commit?.oid ?? null, counted: counted(c), author_association: c.authorAssociation ?? null, mentions_pipeline: mentions(c.body, own), url: c.url ?? null });
    }
  }
  return rows;
}

/** One item read: its repo, kind and detail level, and the node GitHub returned. */
type NodeWrite = { repo: string; kind: Kind; detail: Detail; n: Node; /** When this node's own read started, if not the call's. */ readAt?: string };

/** `force` rewrites an item and its comments even when the row is unchanged (a comment edit leaves the item row as it was). */
/**
 * `readAt` is when the read of these nodes started (before its first GitHub request), stored as `item_reads.synced_at`, so a
 * read that began before a change never passes for one made after it (src/github/commands.ts compares it with a comment's time).
 */
async function writePage(db: Db, repo: string, kind: Kind, detail: Detail, nodes: Node[], force = false, readAt: string = iso(new Date())): Promise<void> {
  await writeNodes(db, nodes.map((n) => ({ repo, kind, detail, n })), { force, readAt });
}

/**
 * Writes items of any repos, kinds and detail levels in one write transaction. `inside` runs last in that transaction, also
 * when nothing needed writing, so what it records commits with the items or not at all.
 */
async function writeNodes(db: Db, nodes: readonly NodeWrite[], opts: { force?: boolean; readAt?: string; inside?: () => Promise<void> } = {}): Promise<void> {
  const readAt = opts.readAt ?? iso(new Date());
  const live = appSlug();
  if (live) { try { await rememberSlug(db, live); } catch { /* read-only connection */ } }
  const own = await mentionNames(db, live);
  // Rows are built before the write lock. An item read twice keeps its last read (the writer also keeps one entry per item).
  const entries: ItemEntry[] = nodes.map((w) => ({
    repo: w.repo, kind: w.kind, detail: w.detail, row: toRow(w.repo, w.kind, w.n, w.detail), comments: w.detail === "full" ? commentRows(w.repo, w.kind, w.n, own) : [], ...(w.readAt !== undefined && { readAt: w.readAt }),
  }));
  if (!entries.length && !opts.inside) return;
  await db.write(async () => {
    if (entries.length) await saveItems(db, entries, { readAt, force: opts.force });
    if (opts.inside) await opts.inside();
  });
}

// `repositoryOwner` serves organizations and users alike.
async function listRepos(client: Querier, login: string): Promise<Node[]> {
  const repos: Node[] = [];
  let after: string | null = null;
  for (;;) {
    const conn: Node = (await client.query(REPOS_QUERY, { login, after })).repositoryOwner.repositories;
    repos.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return repos;
    after = conn.pageInfo.endCursor;
  }
}

/** False for a node of a repo with the tracked name but another owner (names are unique across tracked repos). */
const ownedBy = (n: Node, name: string): boolean => {
  const login = n.repository?.owner?.login;
  return !login || login.toLowerCase() === ownerOf(name).toLowerCase();
};

const iso = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "Z");

// Reads a repo's items, newest first, down to `cutoff` (everything when null). Moves no high water.
async function readRepoSince(db: Db, client: Querier, name: string, cutoff: string | null): Promise<{ count: number; newest: string }> {
  // Before the first request: every page of this read counts as read from here on (never later than its own request).
  const startedAt = iso(new Date());
  let newest = "";
  let count = 0;
  for (const kind of ["issue", "pr"] as const) {
    const passes: [Detail, string[]][] = [["full", ["OPEN"]], ["light", kind === "issue" ? ["CLOSED"] : ["CLOSED", "MERGED"]]];
    for (const [detail, states] of passes) {
      for await (const nodes of untilCutoff(fetchPages(client, kind, detail, name, states), cutoff)) {
        await noteMissed(db, nodes.map((n: Node) => ({ repo: name, n })));
        await writePage(db, name, kind, detail, nodes, false, startedAt);
        count += nodes.length;
        for (const n of nodes) if (n.updatedAt > newest) newest = n.updatedAt;
      }
    }
  }
  return { count, newest };
}

// high_water (`high` as the run began) is written only when the whole repo finished, so a crash leaves the repo incomplete.
// `inside` runs in that write.
async function syncRepo(db: Db, client: Querier, name: string, full: boolean, high: string | null, inside: () => Promise<void>): Promise<number> {
  // synced_at is the start of the sync: every item the sync read is at least as new as it (the pre-approved merge compares it with a push).
  const startedAt = iso(new Date());
  const cutoff = high && !full ? iso(new Date(new Date(high).getTime() - OVERLAP_MS)) : null;
  const read = await readRepoSince(db, client, name, cutoff);
  const count = read.count;
  const newest = read.newest > (high ?? "") ? read.newest : (high ?? "");
  // The writer moves the high water only forward: an incremental sync may have moved it further while a full pass ran.
  await db.write(async () => {
    await markReposRead(db, [{ name, syncedAt: startedAt, highWater: newest || null }]);
    await inside();
  });
  return count;
}

// Which repos get their items synced: --repo names (any repo), else every repo
// with --all, else the tracked ones. `listed` is every non-archived org repo.
export function selectSyncRepos(listed: string[], tracked: string[], opts: { only: string[]; all: boolean }): string[] {
  if (opts.only.length) {
    const missing = opts.only.filter((n) => !listed.includes(n));
    if (missing.length) throw new Error(`unknown or archived repos: ${missing.join(", ")}`);
    return listed.filter((n) => opts.only.includes(n));
  }
  return opts.all ? listed : listed.filter((n) => tracked.includes(n));
}

// GitHub's search index can lag several minutes, so every search starts 10 minutes before the high
// water, and once an hour it also re-reads the 6 hours before it.
const SEARCH_OVERLAP_MS = 10 * 60 * 1000;
const CATCHUP_EVERY_MS = 60 * 60 * 1000;
const CATCHUP_SPAN_MS = 6 * 60 * 60 * 1000;
// Each tracked repo's open items are listed and reconciled with the mirror once a day (by the runner: reconcileNext).
export const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;
const SEARCH_PAGE = 20;
const SEARCH_CAP = 1000;
// Rate-limit points a full re-sync leaves for the minute sync.
const FULL_KEEP = 2500;
const META_REFRESH_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 6 * 3600 * 1000;

// Webhooks first: GitHub App webhooks queue a re-read of each item they name (src/github/webhooks.ts), so the org-wide poll is
// a backstop. A sync run polls when pollReason gives a reason, and otherwise runs only its chores.
/** Longest time between two polls while the webhooks bring the changes. */
export const BACKSTOP_MS = 15 * 60_000;
/** After a poll found changes that no webhook brought, every run polls for this long. */
const MISS_HOLD_MS = 30 * 60_000;
/** A change younger than this when the poll starts may still be on its way through the webhook and its re-read. */
const MISS_GRACE_MS = 2 * 60_000;

/** What the webhooks look like to a sync run. `deliveries` is GitHub's delivery list check (src/github/deliveries.ts), "error" when it failed. */
export type PollInputs = { webhooks: boolean; unread: boolean; deliveries: { failed: number; covered: boolean } | "error" | null };

/** Why this run polls GitHub, or null when the webhooks bring the changes and the backstop is not due. */
export function pollReason(state: Pick<SyncState, "webhook_at" | "webhook_started_at" | "polled_at" | "poll_missed_at" | "poll_missed">, now: number, o: PollInputs): string | null {
  if (!o.webhooks) return "webhooks are not set up";
  if (o.unread) return "a tracked repo was never read in full";
  if (!state.webhook_at) return "no webhook delivery yet";
  if (!state.polled_at) return "first poll";
  if (now - Date.parse(state.polled_at) >= BACKSTOP_MS - 5_000) return "backstop";
  // Deliveries sent while the receiver was down are lost unless GitHub's list shows them failed.
  if (state.webhook_started_at && state.webhook_started_at > state.polled_at) return "the webhook receiver restarted";
  if (state.poll_missed_at && now - Date.parse(state.poll_missed_at) < MISS_HOLD_MS) return `a poll found changes no webhook brought (${(state.poll_missed ?? "").slice(0, 120)})`;
  if (o.deliveries === "error") return "GitHub's list of webhook deliveries could not be read";
  if (o.deliveries?.failed) return `${o.deliveries.failed} webhook deliveries failed`;
  if (o.deliveries && !o.deliveries.covered) return "more webhook deliveries than one check reads";
  return null;
}

/** The poll in progress counts the changes its reads find that no read since them had brought (noteMissed). */
let pollSeen: { before: string; count: number; refs: string[] } | null = null;

/** Counts the items of a page that changed before the grace time and were last read before that change. */
async function noteMissed(db: Db, nodes: { repo: string; n: Node }[]): Promise<void> {
  const seen = pollSeen;
  if (!seen) return;
  const old = nodes.filter((w) => typeof w.n?.updatedAt === "string" && w.n.updatedAt < seen.before);
  if (!old.length) return;
  const reads = await loadItemReads(db, old.map((w) => ({ repo: w.repo, number: w.n.number })));
  for (const w of old) {
    const key = `${w.repo}#${w.n.number}`;
    const at = reads.get(key);
    if (at && at >= w.n.updatedAt) continue;
    seen.count++;
    if (seen.refs.length < 10) seen.refs.push(key);
  }
}

/** Indexes of search results GitHub refused for lack of access, when every error of the answer is one; else null. */
export function refusedSearchNodes(errors: Node[]): Set<number> | null {
  if (!errors.length) return null;
  const out = new Set<number>();
  for (const e of errors) {
    const p = e.path;
    const refusal = e.type === "FORBIDDEN" || /not accessible by integration/i.test(String(e.message ?? ""));
    if (!refusal || !Array.isArray(p) || p[0] !== "search" || p[1] !== "nodes" || typeof p[2] !== "number") return null;
    out.add(p[2]);
  }
  return out;
}

export const SEARCH_QUERY = `
query($q: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue { repository { name owner { login } } ${COMMON} stateReason ${COMMENTS} }
      ... on PullRequest { repository { name owner { login } } ${COMMON} ${PR_EXTRA} ${COMMENTS} ${PR_FULL} }
    }
  }
}`;

// The index lags, so each query starts before the newest updatedAt stored.
export function searchSince(orgHighWater: string): string {
  return iso(new Date(new Date(orgHighWater).getTime() - SEARCH_OVERLAP_MS));
}

export type Querier = { query(query: string, variables: object): Promise<Node>; spent: number; remaining: number | null; resetAt?: Date | null; repoMovedTo?(owner: string, name: string): string | null | Promise<string | null> };

/** Skips a repo that cannot be read: logs and records why, with the new name when GitHub redirects. The run goes on with the other repos. */
async function failRepo(db: Db, client: Querier, name: string, e: unknown): Promise<void> {
  let moved: string | null = null;
  if ((e as { type?: string })?.type === "NOT_FOUND") {
    try { moved = (await client.repoMovedTo?.(ownerOf(name), name)) ?? null; } catch { /* the plain NOT_FOUND is recorded */ }
  }
  await recordRepoFailure(db, name, e, moved);
  console.warn(`${slugOf(name)}: not synced: ${(e as Error).message}${moved ? ` (moved to ${moved})` : ""}`);
}

/**
 * How far a page of a slice `..to` searched in updatedAt order lets the org high water move once it is stored, or null.
 * A finished slice is stored up to its newest item (at most `to`: later slices are unread). Mid-slice, search sorts on
 * the time the index holds, which lags a recent change: only items last updated before `settledBefore` (the page's
 * request time less the index lag bound) sort at their updatedAt. Every unread item sorts after them, so the mark is the
 * newest of them. They must be in order on the page and not older than `prev`, the newest such item of the slice's
 * earlier pages; otherwise (the sort not applied) the page moves nothing until its slice is finished.
 */
export function pageMark(nodes: readonly { updatedAt: string }[], o: { to: string; done: boolean; sliceNewest: string | null; settledBefore: string; prev: string | null }): string | null {
  const cap = (t: string | null) => (t === null ? null : t < o.to ? t : o.to);
  if (o.done) return cap(o.sliceNewest);
  const settled = settledTimes(nodes, o.settledBefore);
  if (!settled.length || (o.prev !== null && settled[0] < o.prev) || settled.some((t, i) => i > 0 && t < settled[i - 1])) return null;
  return cap(settled[settled.length - 1]);
}

const settledTimes = (nodes: readonly { updatedAt: string }[], before: string): string[] => nodes.map((n) => n.updatedAt).filter((t) => t < before);

// Search returns at most SEARCH_CAP results per query. A window with more matches is cut in half
// (`updated:A..B` is inclusive, in whole seconds) until every slice fits. A one-second slice with
// more matches than the cap cannot be read by search; the tracked repos are listed for that
// second instead.
/** `mark`: how far pages without items settled the window past the last mark recorded; the caller records it. */
export type SearchResult = { count: number; newest: string | null; slices: number; fallbacks: number; mark: string | null };

/**
 * Writes the items in one transaction. When it fails for another reason than the fence, they are written one by one, so every item that
 * can be stored is, and the first error is thrown after.
 */
async function writeEach(db: Db, items: NodeWrite[], o: { readAt?: string; inside?: () => Promise<void> } = {}): Promise<void> {
  try {
    await writeNodes(db, items, o);
  } catch (e) {
    if (isFenced(e) || items.length < 2) throw e;
    console.warn(`  ${items.length} items failed to write in one transaction (${(e as Error).message}): writing them one by one`);
    let first: unknown = null;
    for (const w of items) {
      try { await writeNodes(db, [w], { readAt: o.readAt }); } catch (e1) {
        if (isFenced(e1)) throw e1;
        first ??= e1;
        console.warn(`  ${w.repo}#${w.n.number}: not stored: ${(e1 as Error).message}`);
      }
    }
    if (first) throw first;
    if (o.inside) await db.write(o.inside);
  }
}

// Everything updated from `since` to `until`, oldest slice first, each slice in updatedAt order. `newest` is the largest
// updatedAt returned (tracked repos or not), the next sync's starting point; null when nothing matched.
// `progress(t)` runs in the write transaction of a page once every item updated before `t` is stored (see pageMark), so
// a stopped run keeps what it finished.
export async function syncBySearch(db: Db, client: Querier, tracked: string[], since: string, until: string, closing: (() => Promise<void>)[], progress?: (t: string) => Promise<void>): Promise<SearchResult> {
  const trackedSet = new Set(tracked);
  // Before the first request: the read start every page of this run is stored with (see writePage).
  const startedAt = iso(new Date());
  // Search covers the default org only; repos of other owners are read one by one after it.
  const scope = `org:${DEFAULT_OWNER}`;
  // Applied once every window has been read, so a failed run leaves the repos' high water alone.
  const repoNewest = new Map<string, string>();
  let size = SEARCH_PAGE;
  let failures = 0;
  const out: SearchResult = { count: 0, newest: null, slices: 0, fallbacks: 0, mark: null };

  async function page(q: string, cursor: string | null): Promise<Node> {
    for (;;) {
      try {
        return (await client.query(SEARCH_QUERY, { q, first: size, after: cursor })).search;
      } catch (e) {
        if (!(e instanceof Transient)) throw e;
        if (size > MIN_PAGE) size = Math.max(MIN_PAGE, size >> 1);
        else if (++failures > 6) throw e;
        else await sleep(Math.min(30_000 * failures, 300_000));
      }
    }
  }

  // One write transaction per page; when an item cannot be stored the run fails with the page's mark unrecorded (writeEach).
  async function write(nodes: Node[], mark: string | null): Promise<void> {
    const items: NodeWrite[] = [];
    for (const n of nodes) {
      if (n?.updatedAt && n.updatedAt > (out.newest ?? "")) out.newest = n.updatedAt;
      // Untracked repos are dropped here, before anything else is done with the node.
      if (!n?.repository || !trackedSet.has(n.repository.name) || !ownedBy(n, n.repository.name)) continue;
      items.push({ repo: n.repository.name, kind: n.__typename === "PullRequest" ? "pr" : "issue", detail: n.state === "OPEN" ? "full" : "light", n });
    }
    // A page with nothing to store writes nothing: its mark goes with the next page's items, or to the caller.
    const settled = mark ?? out.mark;
    out.mark = settled;
    if (!items.length) return;
    out.mark = null;
    const inside = settled && progress ? () => progress(settled) : undefined;
    await noteMissed(db, items);
    await writeEach(db, items, { readAt: startedAt, inside });
    out.count += items.length;
    for (const w of items) if (w.n.updatedAt > (repoNewest.get(w.repo) ?? "")) repoNewest.set(w.repo, w.n.updatedAt);
  }

  async function window(from: Date, to: Date): Promise<void> {
    const q = `${scope} updated:${iso(from)}..${iso(to)} sort:updated-asc`;
    let askedAt = Date.now();
    let conn = await page(q, null);
    const seconds = Math.floor((to.getTime() - from.getTime()) / 1000);
    if (conn.issueCount > SEARCH_CAP && seconds >= 1) {
      const mid = new Date(from.getTime() + Math.floor(seconds / 2) * 1000);
      await window(from, mid);
      await window(new Date(mid.getTime() + 1000), to);
      return;
    }
    if (conn.issueCount > SEARCH_CAP) {
      console.warn(`  warning: ${conn.issueCount} items updated in ${iso(from)}, more than search returns: listing the tracked repos for it`);
      out.fallbacks++;
      for (const name of tracked) {
        try {
          const r = await readRepoSince(db, client, name, iso(from));
          await clearRepoFailure(db, name);
          out.count += r.count;
          if (r.newest > (repoNewest.get(name) ?? "")) repoNewest.set(name, r.newest);
          if (r.newest > (out.newest ?? "")) out.newest = r.newest;
        } catch (e) {
          await failRepo(db, client, name, e);
        }
      }
      return;
    }
    out.slices++;
    let sliceNewest: string | null = null;
    let prev: string | null = null;
    for (;;) {
      const nodes: Node[] = conn.nodes.filter((n: Node) => n?.updatedAt);
      for (const n of nodes) if (n.updatedAt > (sliceNewest ?? "")) sliceNewest = n.updatedAt;
      const done = !conn.pageInfo.hasNextPage;
      // The search overlap is the bound on how far the index lags (see searchSince).
      const settledBefore = iso(new Date(askedAt - SEARCH_OVERLAP_MS));
      await write(conn.nodes, pageMark(nodes, { to: iso(to), done, sliceNewest, settledBefore, prev }));
      if (done) return;
      for (const t of settledTimes(nodes, settledBefore)) if (t > (prev ?? "")) prev = t;
      askedAt = Date.now();
      conn = await page(q, conn.pageInfo.endCursor);
    }
  }

  const from = new Date(since);
  await window(from, new Date(Math.max(from.getTime(), new Date(until).getTime())));
  const others = tracked.filter((n) => ownerOf(n) !== DEFAULT_OWNER);
  const rows = await loadRepos(db, { names: others });
  for (const name of others) {
    try {
      // A repo that failed for a while has its own high water behind the window: read from there.
      const hw = rows.get(name)?.high_water;
      const own = hw ? new Date(new Date(hw).getTime() - OVERLAP_MS) : null;
      const r = await readRepoSince(db, client, name, iso(own && own < from ? own : from));
      await clearRepoFailure(db, name);
      out.count += r.count;
      if (r.newest > (repoNewest.get(name) ?? "")) repoNewest.set(name, r.newest);
    } catch (e) {
      await failRepo(db, client, name, e);
    }
  }
  if (repoNewest.size) closing.push(() => advanceRepoHighWater(db, [...repoNewest].map(([name, t]) => ({ name, t }))));
  return out;
}

// True when the lock file names a live process and is not stale.
export function lockHeld(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    const fresh = Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS;
    if (!(pid > 0 && fresh)) return false;
    // A file naming this very process is left over from an earlier run whose pid was reused (a container's init gives every start the same pid).
    if (pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false; // vanished or unreadable: treat as stale
  }
}

// A lock file with the owner's pid. Returns a release function, or null when another live run holds it.
export function acquireLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (lockHeld(path)) return null;
    try {
      unlinkSync(path);
    } catch {
      // another run removed it first
    }
  }
  return null;
}

function lockDir(): string {
  return envVar("LOCK_DIR") ?? join(homedir(), ".cache/autocraft-logs");
}

// The incremental sync's lock.
export function lockPath(): string {
  return join(lockDir(), `sync-${dbLockName()}.lock`);
}

// A full re-sync has its own lock, so it never blocks the incremental sync.
export function fullLockPath(): string {
  return join(lockDir(), `sync-full-${dbLockName()}.lock`);
}

// Wraps a client for a full re-sync, which runs beside the incremental sync and gives way to it:
// before each request it waits while `busy()` (an incremental sync is running) and, when fewer than
// `minRemaining` rate-limit points are left, sleeps until the limit resets so the incremental
// sync keeps a budget.
export type LowPriorityOpts = {
  busy: () => boolean; minRemaining: number; pollMs?: number;
  wait?: (ms: number) => Promise<void>; pause?: () => Promise<void>;
};
export function lowPriority(inner: Client, o: LowPriorityOpts): Querier {
  const wait = o.wait ?? ((ms: number) => sleep(ms));
  return {
    get spent() { return inner.spent; },
    get remaining() { return inner.remaining; },
    async query(query: string, variables: object): Promise<Node> {
      while (o.busy()) await wait(o.pollMs ?? 2000);
      if (inner.remaining !== null && inner.remaining < o.minRemaining) {
        await (o.pause ?? (() => inner.sleepUntilReset(`${inner.remaining} points left, full re-sync keeps ${o.minRemaining} for the minute sync`)))();
      }
      return inner.query(query, variables);
    },
  };
}

type SyncOpts = { only: string[]; all: boolean; full: boolean; perRepo: boolean };

export const REPO_QUERY = `
query($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    name owner { login } visibility defaultBranchRef { name }
    pullRequests(states: OPEN) { totalCount }
    issues(states: OPEN) { totalCount }
  }
}`;

// Lists the default org's repos. Repos of other owners are tracked one by one by name, never listed;
// a failure reading one is logged and leaves the rest of the sync alone.
async function refreshRepoList(db: Db, client: Querier, tracked: string[], failing: Set<string>): Promise<string[]> {
  const fail = async (name: string, e: unknown): Promise<void> => {
    failing.add(name);
    await failRepo(db, client, name, e);
  };
  const repos: (Node & { owner: string })[] = [];
  for (const r of await listRepos(client, DEFAULT_OWNER)) repos.push({ ...r, owner: DEFAULT_OWNER });
  for (const name of tracked.filter((n) => ownerOf(n) !== DEFAULT_OWNER)) {
    const owner = ownerOf(name);
    try {
      const r = (await client.query(REPO_QUERY, { owner, name })).repository;
      if (r && r.owner?.login?.toLowerCase() === owner.toLowerCase()) repos.push({ ...r, owner });
      else await fail(name, new GithubError("graphql error: repository not found under this owner", 0, "NOT_FOUND"));
    } catch (e) {
      await fail(name, e);
    }
  }
  // A tracked repo of the default org missing from the listing is archived, or moved or deleted: only the last two are errors.
  const listedNames = new Set(repos.map((r) => r.name as string));
  for (const name of tracked.filter((n) => ownerOf(n) === DEFAULT_OWNER && !listedNames.has(n))) {
    try {
      const r = (await client.query(REPO_QUERY, { owner: DEFAULT_OWNER, name })).repository;
      if (!r || r.owner?.login?.toLowerCase() !== DEFAULT_OWNER.toLowerCase()) throw new GithubError("graphql error: repository not found under this owner", 0, "NOT_FOUND");
    } catch (e) {
      if (e instanceof GithubError && e.type === "NOT_FOUND") await fail(name, e);
      else console.warn(`  ${slugOf(name)}: ${(e as Error).message}`);
    }
  }
  // Names are unique across owners: a repo already known under another owner is left alone. The writer also clears the not-found record of every repo it wrote.
  const written = new Set(await db.write(async () => {
    await saveSyncState(db, { repos_refreshed_at: iso(new Date()) });
    return await saveRepoList(db, repos.map((r) => ({
      name: r.name, owner: r.owner, visibility: r.visibility.toLowerCase(), default_branch: r.defaultBranchRef?.name ?? null, open_prs: r.pullRequests.totalCount, open_issues: r.issues.totalCount,
    })));
  }));
  for (const r of repos) {
    if (!written.has(r.name)) await fail(r.name, new GithubError(`the name is known under another owner than ${r.owner}`, 0, "NOT_FOUND"));
  }
  await reloadRepoOwners(db);
  return [...new Set(repos.map((r: Node) => r.name as string))];
}

/** Repos the last per-repo pass skipped; the org high water waits for them. */
let syncFailures = 0;

async function syncPerRepo(db: Db, client: Querier, opts: SyncOpts, tracked: string[], plan: SyncPlan): Promise<number> {
  const listed = await refreshRepoList(db, client, tracked, plan.failing);
  const names = selectSyncRepos(listed, tracked, opts);
  const gone = opts.only.length || opts.all ? [] : tracked.filter((n) => !listed.includes(n));
  if (gone.length) console.log(`tracked but not in the org (archived or renamed): ${gone.join(", ")}`);
  // A full re-sync goes through the repos in name order and records the last one finished,
  // so a stopped run continues after it. The cursor belongs to one scope (tracked repos or all).
  const resumable = opts.full && !opts.only.length;
  const scope = opts.all ? "all" : "tracked";
  const saved = resumable ? plan.state.full_sync_cursor : null;
  const after = saved?.startsWith(`${scope}|`) ? saved.slice(scope.length + 1) : null;
  const todo = after === null ? names : names.filter((n) => n > after);
  if (after !== null) console.log(`resuming the full re-sync after ${after}: ${todo.length} of ${names.length} repos left`);
  let total = 0;
  let failed = 0;
  let lastError: unknown;
  let transientRun = 0;
  for (const name of todo) {
    const before = client.spent;
    let count: number;
    try {
      count = await syncRepo(db, client, name, opts.full, plan.repos.get(name)?.high_water ?? null, async () => {
        if (plan.failing.has(name)) await clearRepoFailure(db, name);
        // The cursor stops at the first failure so the next full run redoes that repo.
        if (resumable && !failed) await saveSyncState(db, { full_sync_cursor: `${scope}|${name}` });
      });
    } catch (e) {
      await failRepo(db, client, name, e);
      failed++;
      lastError = e;
      // A GitHub outage or an exhausted rate limit fails every repo after long backoffs: end the run instead.
      transientRun = classifyFailure(e) === "transient" ? transientRun + 1 : 0;
      if (transientRun >= 3 || /rate limit|secondary/i.test((e as Error).message)) throw e;
      continue;
    }
    transientRun = 0;
    total += count;
    console.log(`${name}: ${count} items, ${client.spent - before} points used, ${client.remaining} left`);
  }
  if (resumable && !failed) await saveSyncState(db, { full_sync_cursor: null });
  // One broken repo does not fail the run; all of them failing does.
  if (failed > 0 && failed === todo.length) throw lastError;
  syncFailures = failed;
  return total;
}

// One item by number, any state, for the daily reconcile. A deleted or transferred item comes back null.
export const ONE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { repository { name owner { login } } ${COMMON} stateReason ${COMMENTS} }
      ... on PullRequest { repository { name owner { login } } ${COMMON} ${PR_EXTRA} ${COMMENTS} ${PR_FULL} }
    }
  }
}`;

/** Writes one item read by number (a webhook re-read) like the sync does. False for a null, deleted or transferred item: the daily reconcile handles those. */
/** `readAt`: when the request for `n` was sent (see writePage); default now. */
export async function writeItemNode(db: Db, repo: string, n: Node | null | undefined, readAt?: Date): Promise<boolean> {
  if (!n || n.repository?.name !== repo || !ownedBy(n, repo)) return false;
  await writePage(db, repo, n.__typename === "PullRequest" ? "pr" : "issue", n.state === "OPEN" ? "full" : "light", [n], true, iso(readAt ?? new Date()));
  return true;
}

// Lists a repo's open issues and PRs and reconciles the mirror with them. Mirror rows that are
// open here but not listed as open on GitHub are read one by one: closed or merged ones are
// updated, deleted or transferred ones (not found, or found in another repo) are marked CLOSED
// (no consumer reads a state other than OPEN, CLOSED and MERGED) and audited.
export async function reconcileRepo(db: Db, client: Querier, name: string, now: Date = new Date()): Promise<{ open: number; updated: number; gone: number }> {
  const listed = new Set<string>();
  const startedAt = iso(new Date());
  for (const kind of ["issue", "pr"] as const) {
    for await (const nodes of fetchPages(client, kind, "full", name, ["OPEN"])) {
      await writePage(db, name, kind, "full", nodes, false, startedAt);
      for (const n of nodes) listed.add(`${kind}\t${n.number}`);
    }
  }
  const stale = (await listItems(db, { repos: [name], states: ["OPEN"] }, "ref")).filter((r) => !listed.has(`${r.kind}\t${r.number}`)).sort((a, b) => a.number - b.number);
  let updated = 0;
  const goneRefs: string[] = [];
  // Every item is stored with the time its own request was sent; a page's worth shares one write.
  const read: (NodeWrite & { readAt: string })[] = [];
  const store = async (): Promise<void> => { if (read.length) await writeEach(db, read.splice(0)); };
  let failed: unknown = null;
  const attempt = async (f: () => Promise<void>): Promise<void> => {
    try { await f(); } catch (e) {
      if (isFenced(e)) throw e;
      failed ??= e;
    }
  };
  // A read that fails ends the reading; what the reads before it found is stored all the same, and the caller then gets the first failure.
  await attempt(async () => {
    for (const r of stale) {
      const sentAt = iso(new Date());
      const n: Node = (await client.query(ONE_QUERY, { owner: ownerOf(name), name, number: r.number })).repository?.issueOrPullRequest;
      if (n && n.repository?.name === name && ownedBy(n, name)) {
        read.push({ repo: name, kind: n.__typename === "PullRequest" ? "pr" : "issue", detail: n.state === "OPEN" ? "full" : "light", n, readAt: sentAt });
        updated++;
        if (read.length >= FULL_PAGE) await attempt(store);
      } else goneRefs.push(`${name}#${r.number}`);
    }
  });
  await attempt(store);
  // Deleted or transferred items are marked CLOSED (no consumer reads a state other than OPEN, CLOSED and MERGED) and audited.
  const gone = await closeGoneItems(db, goneRefs, iso(now));
  if (failed) throw failed;
  await markReposReconciled(db, [{ name, at: iso(now) }]);
  return { open: listed.size, updated, gone };
}

// Of the tracked repos the sync has read in full, the one whose last reconcile is oldest, when it is over a day old (never: first).
export async function reconcileDue(db: Db, tracked: string[], now: Date): Promise<string | null> {
  const at = new Map([...(await loadRepos(db, { names: tracked })).values()].filter((r) => r.synced_at !== null && r.high_water !== null).map((r) => [r.name, r.reconciled_at ?? ""]));
  const oldest = [...tracked].filter((n) => at.has(n)).sort((a, b) => at.get(a)!.localeCompare(at.get(b)!))[0];
  if (oldest === undefined) return null;
  const last = at.get(oldest)!;
  return !last || now.getTime() - new Date(last).getTime() >= RECONCILE_EVERY_MS ? oldest : null;
}

/** Reconciles the repo that is due, if any, and returns its name. A failure is recorded and still moves `reconciled_at`, so a failing repo does not keep first place. */
export async function reconcileNext(db: Db, client: Querier, now: Date = new Date(), log: (line: string) => void = console.log): Promise<string | null> {
  const due = await reconcileDue(db, await trackedNames(db), now);
  if (!due) return null;
  try {
    const c = await reconcileRepo(db, client, due, now);
    await clearRepoFailure(db, due);
    log(`reconcile ${due}: ${c.open} open, ${c.updated} re-read, ${c.gone} gone`);
  } catch (e) {
    await failRepo(db, client, due, e);
    await markReposReconciled(db, [{ name: due, at: iso(now) }]);
  }
  return due;
}

// Runs one sync. `org_high_water` is the newest updatedAt stored, so the next search starts ten
// minutes before it; a search run moves it page by page as it stores them (syncBySearch). It does not move for --repo
// runs, and a full re-sync leaves an existing one alone.
export async function runSync(db: Db, client: Querier, opts: SyncOpts, now: Date = new Date()): Promise<{ mode: string; items: number }> {
  const [tracked, plan, settings] = await db.together(() => Promise.all([trackedNames(db), loadSyncPlan(db), readSettingsSnapshot(db)]));
  // The run reads its settings (the names comments address the app by, for every page) once.
  return await withSettingsSnapshot(db, () => syncWith(db, client, opts, now, tracked, plan), Promise.resolve(settings));
}

async function syncWith(db: Db, client: Querier, opts: SyncOpts, now: Date, tracked: string[], plan: SyncPlan): Promise<{ mode: string; items: number }> {
  const started = iso(now);
  const orgHigh = plan.state.org_high_water;
  // A repo that cannot be read has no synced_at and would keep every run per-repo.
  // Only a repo that cannot be read at all (not found, no access) is passed over; others are retried per repo for their first full read.
  const { synced, broken } = plan;
  const wantsSearch = !opts.only.length && !opts.all && !opts.full && !opts.perRepo && orgHigh !== null
    && tracked.every((n) => synced.has(n) || broken.has(n));
  const spent0 = client.spent;
  let mode = "per-repo";
  let items: number;
  // What the run records once it has read everything, in one write.
  let closing: (() => Promise<void>)[] = [];
  const state: Partial<SyncState> = {};
  const close = async (): Promise<void> => {
    const writes = closing;
    closing = [];
    if (!writes.length && !Object.keys(state).length) return;
    await db.write(async () => {
      for (const w of writes) await w();
      await saveSyncState(db, state);
    });
  };
  // Only a poll of every tracked repo tells the webhooks' coverage.
  const polls = !opts.only.length && !opts.full;
  if (polls && wantsSearch) pollSeen = { before: iso(new Date(now.getTime() - MISS_GRACE_MS)), count: 0, refs: [] };
  try {
    if (wantsSearch) {
      // Runs inside each page's transaction; a compare-and-set, so a rolled-back page leaves nothing to remember.
      const progress = async (t: string) => { await advanceOrgHighWater(db, t); };
      const r = await syncBySearch(db, client, tracked, searchSince(orgHigh as string), started, closing, progress);
      mode = "search";
      items = r.count;
      const high = r.newest && r.newest > (orgHigh as string) ? r.newest : (orgHigh as string);
      const reached = r.mark && r.mark > high ? r.mark : high;
      if (reached > (orgHigh as string)) closing.push(async () => void await advanceOrgHighWater(db, reached));
      const last = plan.state.search_catchup_at;
      if (!last || now.getTime() - new Date(last).getTime() >= CATCHUP_EVERY_MS) {
        const c = await syncBySearch(db, client, tracked, iso(new Date(new Date(high).getTime() - CATCHUP_SPAN_MS)), iso(new Date(high)), closing);
        items += c.count;
        state.search_catchup_at = started;
      }
      // One org-wide search covers every tracked repo, so each counts as synced now.
      // The search read every default-org repo, so errors of earlier runs other than not-found are stale; a failure of this run (at >= started) stays.
      if (plan.failing.size) closing.push(() => clearRepoFailures(db, tracked.filter((x) => ownerOf(x) === DEFAULT_OWNER), { kinds: ["transient", "error"], before: started }));
      // Not the repos that were never read in full (no high water) or that cannot be read.
      closing.push(() => markReposSyncedByError(db, tracked, started));
      console.log(`search: ${r.slices} slice${r.slices === 1 ? "" : "s"}${r.fallbacks ? `, ${r.fallbacks} listed per repo` : ""}`);
      if (polls && pollSeen) {
        state.polled_at = started;
        if (pollSeen.count) {
          state.poll_missed_at = started;
          state.poll_missed = `${pollSeen.count} ${pollSeen.refs.join(" ")}`;
          console.log(`poll: ${pollSeen.count} change${pollSeen.count === 1 ? "" : "s"} no webhook brought: ${pollSeen.refs.join(" ")}`);
        }
      }
      const at = plan.state.repos_refreshed_at;
      if (!at || now.getTime() - new Date(at).getTime() >= META_REFRESH_MS) {
        // First: a repo the listing finds gone was synced until now.
        await close();
        await refreshRepoList(db, client, tracked, plan.failing);
      }
    } else {
      syncFailures = 0;
      items = await syncPerRepo(db, client, opts, tracked, plan);
      if (!opts.only.length && !syncFailures && (orgHigh === null || !opts.full)) state.org_high_water = started;
      if (polls && !syncFailures) state.polled_at = started;
    }
  } finally {
    pollSeen = null;
    // The dashboard can show the rate budget from these.
    state[opts.full ? "full_points_last_run" : "points_last_run"] = client.spent - spent0;
    if (client.remaining !== null) state.rate_remaining = client.remaining;
    if (client.resetAt) state.rate_reset_at = client.resetAt.toISOString();
    await close();
  }
  // History written before ids were bound: one batched pass, nothing when every login is bound.
  if (opts.full || (!opts.only.length && plan.state.author_ids_backfilled_at === null)) {
    try {
      const { backfillAuthorIds } = await import("./author-ids.ts");
      const bound = await backfillAuthorIds(db, client);
      if (bound) console.log(`bound ${bound} author account id${bound === 1 ? "" : "s"}`);
      await saveSyncState(db, { author_ids_backfilled_at: iso(new Date()), author_ids_error: null });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      console.log(`author ids: ${msg}`);
      await saveSyncState(db, { author_ids_error: `${iso(new Date())} ${(e as { type?: string })?.type ?? ""} ${msg}` });
    }
  }
  return { mode, items };
}

/**
 * Why this run polls GitHub (pollReason), or null. Reads GitHub's list of the app's webhook deliveries first, which also asks
 * for the failed ones again.
 */
async function whyPoll(db: Db, now = Date.now()): Promise<string | null> {
  const { readAppSecrets } = await import("./github/install-token.ts");
  const app = readAppSecrets();
  const webhooks = !!app?.webhookSecret;
  let deliveries: PollInputs["deliveries"] = null;
  if (app && webhooks) {
    try {
      deliveries = await (await import("./github/deliveries.ts")).checkDeliveries(db, app, now);
    } catch (e) {
      console.log(`webhook deliveries: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      deliveries = "error";
    }
  }
  const [tracked, plan] = await db.together(() => Promise.all([trackedNames(db), loadSyncPlan(db)]));
  const unread = plan.state.org_high_water === null || tracked.some((n) => !plan.synced.has(n) && !plan.broken.has(n));
  return pollReason(plan.state, now, { webhooks, unread, deliveries });
}

/** How often a mirror run checks whether the default-branch poll is due (src/mainci POLL_EVERY_MS). */
const MAIN_CI_CHECK_MS = 30_000;

/** The GitHub rate the sync leaves for everything else: it waits for the reset below this many points; the diff re-reads use the same floor. */
export const SYNC_RESERVE = 1000;

async function sync(args: string[]): Promise<void> {
  const opts: SyncOpts = { only: [], all: false, full: false, perRepo: false };
  let reserve = SYNC_RESERVE;
  let keep = FULL_KEEP;
  let restart = false;
  let poll = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") opts.only.push(args[++i]);
    else if (args[i] === "--poll") poll = true;
    else if (args[i] === "--full") opts.full = true;
    else if (args[i] === "--all") opts.all = true;
    else if (args[i] === "--per-repo") opts.perRepo = true;
    else if (args[i] === "--reserve") reserve = Number(args[++i]);
    else if (args[i] === "--restart") restart = true;
    else if (args[i] === "--keep") keep = Number(args[++i]);
    else throw new Error(`unknown argument ${args[i]}\nusage: sync [--repo NAME ...] [--all] [--full] [--per-repo] [--poll] [--reserve N] [--keep N] [--restart]`);
  }
  const release = acquireLock(opts.full ? fullLockPath() : lockPath());
  if (!release) return;
  // Chores still running past their limit; the process cannot wait for them to end on their own.
  const stuck: string[] = [];
  try {
    // The periodic container runs this command in a loop.
    setDbRole("periodic");
    const db = await openDb();
    const client = new Client(reserve);
    if (restart) await saveSyncState(db, { full_sync_cursor: null });
    const querier = opts.full ? lowPriority(client, { busy: () => lockHeld(lockPath()), minRemaining: keep }) : client;
    // Each run leaves a row for the Pipeline page; rows older than two days go.
    const row = await startSyncRun(db, iso(new Date()));
    // The default-branch poll, and the warm builds it queues, keep their own cadence while a long pass runs. Its own client:
    // a client's rate figures follow one request at a time.
    const mainCi = exclusive(async () => {
      try {
        await (await import("./mainci/index.ts")).pollMainCiIfDue(db, new Client(reserve));
      } catch (e) {
        // A failed read of the default branches must not fail the mirror run; the next check asks again.
        console.log(`main-ci: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    });
    const pollsMainCi = !opts.full && !opts.only.length;
    const mainCiTimer = pollsMainCi ? setInterval(() => void mainCi.skip(), MAIN_CI_CHECK_MS) : undefined;
    mainCiTimer?.unref();
    try {
      const asked = poll || opts.full || opts.all || opts.perRepo || opts.only.length > 0;
      const reason = asked ? "asked" : await whyPoll(db);
      if (reason) {
        const { mode, items } = await runSync(db, querier, opts).finally(() => clearInterval(mainCiTimer));
        await finishSyncRun(db, row, { endedAt: iso(new Date()), mode, items });
        console.log(`sync: mode=${mode} items=${items} points=${client.spent} left=${client.remaining} (${reason})`);
      } else {
        // The webhooks' re-reads keep the mirror current; the chores below still run on their own schedules.
        await finishSyncRun(db, row, { endedAt: iso(new Date()), mode: "webhooks", items: 0 });
        console.log("sync: mode=webhooks, no poll due");
      }
      const chores = !opts.full && !opts.only.length;
      // Files, commits and label events of the items that changed; a failed read leaves them for the next run.
      if (chores) {
        await chore("activity", async () => {
          const n = await syncActivity(db, querier);
          if (n) console.log(`activity: ${n} items read, ${client.remaining} points left`);
        }, stuck);
      }
      if (pollsMainCi) await chore("main-ci", () => mainCi.run(), stuck);
      // Release download and star counts for the Downloads report; one failing repo is logged and skipped.
      if (chores) await chore("releases", async () => void await (await import("./downloads/poll.ts")).pollReleasesIfDue(db, undefined, Date.now(), (l) => console.log(l)), stuck);
      // Implement breakers that failures of AutoCraft's own tripped lift themselves after their backoff.
      if (chores) {
        await chore("implement: breaker lift", async () => {
          const lifted = await (await import("./implement/stuck.ts")).liftOwnTrips(db);
          if (lifted.length) console.log(`implement: lifted ${lifted.join(", ")}`);
        }, stuck);
      }
      // GitHub App installations on accounts that are not allowed owners.
      if (chores) await chore("github app: sweep", async () => void await (await import("./github/allowed-owners.ts")).sweepInstallationsIfDue(db), stuck);
      // Findings whose fix is landing: a merged pull request, or a fix that reached the default branch through an advisory.
      if (chores) {
        await chore("security", async () => {
          const { exec, fixupDir } = await import("./fixup/git.ts");
          await (await import("./security/land.ts")).pollLandingIfDue(db, { exec, root: fixupDir(), log: (l) => console.log(l) });
        }, stuck, async () => `at ${(await import("./security/land.ts")).landingStage()}`);
      }
    } catch (e) {
      await finishSyncRun(db, row, { endedAt: iso(new Date()), error: String((e as Error)?.message ?? e).slice(0, 300) });
      throw e;
    }
  } finally {
    release();
  }
  await endRun(stuck.length ? 1 : 0);
}

/** How long the end of a sync run waits for the database handle to close. */
const CLOSE_MS = 5_000;

/**
 * Ends the sync process once its run is done. Whatever still holds the event loop is logged first: nothing should, so a
 * line here names a handle some code left open. A chore left running past its limit is one of them.
 */
async function endRun(code: number): Promise<never> {
  const open = process.getActiveResourcesInfo();
  if (open.length) console.log(`sync: open at the end of the run: ${open.join(", ")}`);
  let t: NodeJS.Timeout | undefined;
  await Promise.race([closeDb().catch(() => undefined), new Promise((r) => { t = setTimeout(r, CLOSE_MS); })]);
  clearTimeout(t);
  process.exit(code);
}

/** Longest a chore after the mirror run may take before the run goes on without it. */
const CHORE_MS = 15 * 60_000;

/**
 * Runs one chore after the mirror run. Its failure is logged under `name` and does not fail the run; one still running after
 * `ms` is logged with `where` it is and the process's open resources, added to `stuck` and left behind.
 */
async function chore(name: string, fn: () => Promise<void>, stuck: string[], where?: () => Promise<string>, ms = CHORE_MS): Promise<void> {
  let t: NodeJS.Timeout | undefined;
  const late = new Promise<false>((r) => { t = setTimeout(() => r(false), ms); });
  const run = fn().then(() => true, (e: unknown) => {
    console.log(`${name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return true;
  });
  try {
    if (await Promise.race([run, late])) return;
    stuck.push(name);
    const place = where ? ` (${await where()})` : "";
    console.log(`${name}: still running after ${Math.round(ms / 60_000)} min${place}; the run goes on without it; open resources: ${process.getActiveResourcesInfo().join(", ")}`);
  } finally {
    clearTimeout(t);
  }
}

async function syncStatus(): Promise<void> {
  const db = await openDb();
  const [repos, tracked, counts] = await db.together(() => Promise.all([loadRepos(db, { all: true }), loadTrackedRepos(db), countItemsByRepo(db)]));
  const rows = [...repos.values()].map((r) => ({ name: r.name, open_prs: r.open_prs, open_issues: r.open_issues, synced_at: r.synced_at, tracked: tracked.has(r.name), n: counts.get(r.name) ?? 0 }));
  console.log(`${"repo".padEnd(28)} ${"tracked".padEnd(7)} ${"open PRs".padStart(8)} ${"open iss".padStart(8)} ${"mirrored".padStart(8)}  synced_at`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(28)} ${(r.tracked ? "yes" : "-").padEnd(7)} ${String(r.open_prs).padStart(8)} ${String(r.open_issues).padStart(8)} ${String(r.n).padStart(8)}  ${r.synced_at ?? "-"}`);
  }
}

export const commands = {
  sync: { summary: "mirror issues and PRs of the tracked owners: [--repo NAME ...] [--all] [--full] [--per-repo] [--poll] [--reserve N] [--keep N] [--restart] (default: org-wide search for changes when a poll is due, a backstop to the GitHub App webhooks; --poll polls now; --full runs beside it and resumes after the last finished repo)", run: sync },
  "sync-status": { summary: "per repo: open PRs, open issues, mirrored rows, synced_at", run: syncStatus },
};

/** Marks a PR we just merged as merged in the mirror, so counts don't wait for the next sync; the sync later fills in what GitHub reports. */
export async function markMerged(db: Db, repo: string, number: number, at: string): Promise<void> {
  await applyLocal(db, [{ kind: "merged", repo, number, at }]);
}
