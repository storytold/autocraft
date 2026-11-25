// Readable URLs for decisions and items, and the rules that turn a decision route back into a lookup.
// No framework imports: the server shares `pickDecision` and the tests load this file directly.
import type { Decision, ItemKind } from "../api/types.ts";

/** The owner of repos the API does not list as owned by someone else. */
export const GITHUB_ORG = "storytold";

// Owners of the repos that are not storytold's, from `/api/repos/owners`, set before the app renders and after a repo is tracked. Repo names are unique across owners.
let owners: Record<string, string> = {};
export const setRepoOwners = (next: Record<string, string>): void => { owners = next; };
export const ownerOfRepo = (repo: string): string => (repo.includes("/") ? repo.slice(0, repo.indexOf("/")) : owners[repo] ?? GITHUB_ORG);
/** `owner/name` of a repo given bare or as `owner/name`. */
export const repoSlug = (repo: string): string => `${ownerOfRepo(repo)}/${shortRepo(repo)}`;

/** The issue or PR on GitHub. Without a known `kind` the issue URL is used; GitHub redirects /issues/N to the PR when N is one. */
export const githubItemUrl = (repo: string, number: number, kind?: ItemKind | null): string =>
  `https://github.com/${ownerOfRepo(repo)}/${encodeURIComponent(shortRepo(repo))}/${kind === "pr" ? "pull" : "issues"}/${number}`;

const KIND_ORDER = ["scope", "duplicate", "close", "merge", "hold", "split", "other", "backlog"];

/** `/items/<repo>/<n>`; the repo is the short name the dashboard shows. */
export const itemPath = (repo: string, number: number): string => `/items/${encodeURIComponent(shortRepo(repo))}/${number}`;

/** One decision of the queue an item page steps through, and the page that answers it. */
export type QueueEntry = { id: string; path: string };
/**
 * Where an item page came from, carried in history state: the Needs you queue URL its back link returns to, with
 * `decision=` naming the open decision, and the loaded queue it steps through.
 */
export type From = { url: string; queue?: QueueEntry[] };

/** `url` with `decision=id` and no preview, so going back selects that decision. */
function withDecision(url: string, id: string): string {
  const at = url.indexOf("?");
  const params = new URLSearchParams(at < 0 ? "" : url.slice(at));
  params.set("decision", id);
  params.delete("peek");
  return `${at < 0 ? url : url.slice(0, at)}?${params}`;
}

/** History state for an item opened from the queue at `url`: decision `d`, stepping through the loaded `rows`. */
export function fromState(url: string, d?: DecisionRef, rows?: DecisionRef[]): { from: From } {
  const queue = rows?.filter((r) => r.number != null).map((r) => ({ id: r.id, path: decisionPath(r) }));
  return { from: { url: d ? withDecision(url, d.id) : url, ...(queue && { queue }) } };
}

/** The `from` of history state, or null. State is untrusted (any script can push it): only a Needs you URL and item paths are taken. */
export function readFrom(state: unknown): From | null {
  const from = (state as { from?: { url?: unknown; queue?: unknown } } | null | undefined)?.from;
  const url = from?.url;
  if (typeof url !== "string" || !/^\/needs(?:[?#]|$)/.test(url)) return null;
  const queue = from?.queue;
  const valid = Array.isArray(queue) && queue.every((e) => typeof e?.id === "string" && typeof e?.path === "string" && e.path.startsWith("/items/"));
  return valid ? { url, queue: queue as QueueEntry[] } : { url };
}

/** Where the open decision sits in the queue (1-based), or null when the queue does not hold it. */
export function queuePosition(from: From): { at: number; of: number } | null {
  const id = new URLSearchParams(from.url.slice(from.url.indexOf("?") + 1 || from.url.length)).get("decision");
  const index = from.queue?.findIndex((e) => e.id === id) ?? -1;
  return index < 0 ? null : { at: index + 1, of: from.queue!.length };
}

/** The neighbour's page and the state to open it with, or null at either end. */
export function stepFrom(from: From, dir: 1 | -1): { path: string; state: { from: From } } | null {
  const pos = queuePosition(from);
  const target = pos && from.queue![pos.at - 1 + dir];
  return target ? { path: target.path, state: { from: { ...from, url: withDecision(from.url, target.id) } } } : null;
}

/** `/batches/<id>`: the detail page of an integration batch. */
export const batchPath = (id: number): string => `/batches/${id}`;

/**
 * `photocraft#15343` for a GitHub issue or PR link such as `https://github.com/storytold/photocraft/pull/15343/files#r1`,
 * so a pasted link searches like a typed ref. Anything else comes back unchanged.
 */
export function githubUrlToRef(text: string): string {
  const m = /^\s*(?:https?:\/\/)?(?:www\.)?github\.com\/[^/\s]+\/([^/\s]+)\/(?:pull|issues)\/(\d+)(?:[/?#]\S*)?\s*$/i.exec(text);
  return m ? `${m[1]}#${m[2]}` : text;
}

/** `owner/designcraft` and `designcraft` name the same repo. */
export const shortRepo = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1);

type DecisionRef = Pick<Decision, "id" | "repo" | "number"> & { items?: { repo: string; number: number }[] };

/**
 * The link to a decision: the page of its item, scrolled to the decision's block. A batch opens its first item.
 * Only a decision without any item uses the id form, which `/needs/decisions/:id` resolves.
 */
export function decisionPath(d: DecisionRef | undefined): string {
  if (!d) return "/needs";
  const anchor = `#decision-${encodeURIComponent(d.id)}`;
  if (d.number != null) return `${itemPath(d.repo, d.number)}${anchor}`;
  const first = d.items?.[0];
  return first ? `${itemPath(first.repo, first.number)}${anchor}` : `/needs/decisions/${encodeURIComponent(d.id)}`;
}

export type DecisionRoute = { by: "id"; id: string } | { by: "item"; repo: string; number: number; kind?: string } | { by: "none" };

/** What a `decisions/:id?`, `decisions/:repo/:n` or `decisions/:repo/:n/:kind` route asks for. */
export function parseDecisionRoute(p: { id?: string; repo?: string; n?: string; kind?: string }): DecisionRoute {
  if (p.repo !== undefined && p.n !== undefined) {
    const number = Number(p.n);
    return Number.isInteger(number) && number > 0 ? { by: "item", repo: shortRepo(decodeURIComponent(p.repo)), number, ...(p.kind ? { kind: p.kind } : {}) } : { by: "none" };
  }
  return p.id ? { by: "id", id: decodeURIComponent(p.id) } : { by: "none" };
}

/** The decision a readable link opens: the first open one in inbox order (kind, then oldest), else the most recently asked. */
export function pickDecision<T extends Pick<Decision, "kind" | "answer" | "askedAt">>(ds: T[]): T | undefined {
  const open = ds.filter((d) => !d.answer).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.askedAt.localeCompare(b.askedAt));
  return open[0] ?? [...ds].sort((a, b) => b.askedAt.localeCompare(a.askedAt))[0];
}

/** A commit as shown inside the PR on GitHub. */
export const githubCommitUrl = (repo: string, number: number, sha: string): string => `${githubItemUrl(repo, number, "pr")}/commits/${encodeURIComponent(sha)}`;

/** A file at a commit on GitHub, at the given line. */
export const githubBlobUrl = (repo: string, sha: string, path: string, line?: number): string =>
  `https://github.com/${encodeURIComponent(ownerOfRepo(repo))}/${encodeURIComponent(shortRepo(repo))}/blob/${encodeURIComponent(sha)}/${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;

/** `/security/scans` or `/security/scans/<id>`: the deep scan list and one scan. */
export const scanPath = (id?: number): string => (id === undefined ? "/security/scans" : `/security/scans/${id}`);

/** `/security/<repo>/<n>`: the page of one security finding. */
export const findingPath = (repo: string, number: number): string => `/security/${encodeURIComponent(shortRepo(repo))}/${number}`;
