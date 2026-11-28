// CI on the default branch of every synced repo: one GraphQL query reads each head commit and its checks,
// main_ci keeps one row per head seen, and the dashboard shows the state of each repo and when it turned red.
// Read-only: nothing is written to GitHub.
import type { Querier } from "../mirror.ts";
import { contextState, type CheckState } from "../review/checks.ts";
import { trackedNames } from "../repos.ts";
import { optionalChecks, optionalChecksOf } from "../optional-checks.ts";
import { loadTrips, resumeTripsIf, tripMergeBreakers } from "../data/control/index.ts";
import type { TripRow } from "../data/control/types.ts";
import { tripKey } from "../core/push-outcome.ts";
import { loadMergedInfo } from "../data/merge/index.ts";
import { autocraftTexts } from "../mainfix/status.ts";
import { classify, derive, type Culprit, type HeadRow, type MainCheck, type MainCiState } from "./classify.ts";
import { ownerOf } from "../owners.ts";
import type { HiddenRepos } from "../hidden-sql.ts";
import { loadDecidingHeads, loadRepos, loadSyncState, saveMainHeads, saveSyncState, type MainHeadSummary } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { warmPass } from "../build/warm-queue.ts";
import { refreshMirrorSources } from "../build/mirror-sources.ts";
import type { RedMain } from "./no-new.ts";

/** Branch prefix of the PRs AutoCraft opens to fix a red main. */
export const MAIN_FIX_BRANCH_PREFIX = "autocraft/main-ci-";

/**
 * Repos whose default branch counts as red (derive()), also while its newest head's checks run after a red result: the settled red
 * head and the checks that failed there, which a PR's failures are compared with (src/mainci/no-new.ts), when it was seen red, and
 * the time it stops counting as red when nothing new is read (derive()'s `until`; null: only a new result ends it).
 */
export async function redMainHeads(db: Db, nowMs: number = Date.now()): Promise<Map<string, RedMain>> {
  const out = new Map<string, RedMain>();
  for (const [repo, heads] of await loadDecidingHeads(db, [])) {
    const at = currentHead(heads, nowMs);
    if (at?.d.state !== "red") continue;
    let failing: string[] = [];
    try { failing = (JSON.parse(at.settled.failing) as { name?: string }[]).map((f) => f.name ?? "").filter(Boolean); } catch { /* malformed: nothing fails by name */ }
    // When the head was seen red: the change to red when it is red now, else (its checks rerun) when it was first seen.
    const redAt = at.settled.state === "red" ? at.settled.state_changed_at : at.settled.first_seen_at;
    out.set(repo, { sha: at.settled.head_sha, failing, until: at.d.until, redAt });
  }
  return out;
}

/** The repo's current head and the head its state comes from among its stored ones, and what derive() says of them; null when they name none. */
function currentHead<H extends MainHeadSummary>(heads: readonly H[], nowMs: number): { cur: H; settled: H; d: NonNullable<ReturnType<typeof derive>> } | null {
  const d = derive(heads.map((h): HeadRow => ({ sha: h.head_sha, state: h.state as MainCiState, settledState: h.settled_state as MainCiState | null, committedAt: h.committed_at, headline: h.headline, firstSeenAt: h.first_seen_at, stateChangedAt: h.state_changed_at })), nowMs);
  return d ? { cur: heads.find((h) => h.head_sha === d.current.sha)!, settled: heads.find((h) => h.head_sha === d.settled.sha)!, d } : null;
}

/** Least time between two polls. */
export const POLL_EVERY_MS = 2 * 60_000;
/** Repos per query: 100 check contexts each keeps a query well under GitHub's node limit. */
const REPOS_PER_QUERY = 30;

export { optionalChecks };

/** The owner variables of mainCiQuery. */
export const mainCiVars = (repos: string[]): Record<string, string> => Object.fromEntries(repos.map((r, i) => [`o${i}`, ownerOf(r)]));

export function mainCiQuery(repos: string[]): string {
  const parts = repos.map((r, i) => `
    r${i}: repository(owner: $o${i}, name: ${JSON.stringify(r)}) {
      defaultBranchRef { name target { ... on Commit {
        oid committedDate messageHeadline
        statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name conclusion status detailsUrl }
          ... on StatusContext { context state targetUrl }
        } } }
      } } }
    }`).join("");
  return `query(${repos.map((_, i) => `$o${i}: String!`).join(", ")}) {
  rateLimit { cost remaining resetAt }${parts}
}`;
}

type Ctx = { __typename?: string; name?: string; status?: string; conclusion?: string | null; detailsUrl?: string | null; context?: string; state?: string; targetUrl?: string | null };
type RepoNode = {
  defaultBranchRef?: { name: string; target?: { oid?: string; committedDate?: string; messageHeadline?: string; statusCheckRollup?: { contexts?: { nodes?: (Ctx | null)[] } } | null } | null } | null;
} | null;

export type Head = { repo: string; branch: string; sha: string; committedAt: string | null; headline: string | null; checks: MainCheck[] };

/** The heads of a reply to mainCiQuery; a repo that is gone or has no default branch is left out. */
export function parseHeads(repos: string[], data: Record<string, RepoNode | undefined>): Head[] {
  const out: Head[] = [];
  repos.forEach((repo, i) => {
    const ref = data[`r${i}`]?.defaultBranchRef;
    const t = ref?.target;
    if (!ref || !t?.oid) return;
    const checks = (t.statusCheckRollup?.contexts?.nodes ?? []).filter((c): c is Ctx => !!c).map((c) => ({
      name: c.name ?? c.context ?? "?", state: contextState(c) as CheckState, url: c.detailsUrl ?? c.targetUrl ?? null,
    }));
    out.push({ repo, branch: ref.name, sha: t.oid, committedAt: t.committedDate ?? null, headline: t.messageHeadline ?? null, checks });
  });
  return out;
}

/** Stores heads: a new row, or the row of a head seen before with its current checks; state_changed_at moves only when the state does. Returns the state of each head, keyed `repo@sha`. */
export async function saveHeads(db: Db, heads: Head[], at: string): Promise<Map<string, MainCiState>> {
  const optional = await optionalChecksOf(db);
  const saved = await saveMainHeads(db, heads.map((h) => ({
    repo: h.repo, sha: h.sha, branch: h.branch, state: classify(h.checks, optional(h.repo)),
    failing: JSON.stringify(h.checks.filter((c) => c.state === "failure").map((c) => ({ name: c.name, url: c.url }))),
    checks: JSON.stringify(h.checks), committed_at: h.committedAt, headline: h.headline,
  })), at);
  return saved as Map<string, MainCiState>;
}

/** Reads the default-branch heads of the synced repos (or of `only`) and stores them. */
export async function pollMainCi(db: Db, client: Querier, only?: string, log: (line: string) => void = () => {}): Promise<{ repos: number; heads: number }> {
  const [known, tracked] = await db.together(() => Promise.all([loadRepos(db), trackedNames(db)]));
  const repos = tracked.filter((r) => known.get(r)?.synced_at != null && (!only || r === only));
  let heads = 0;
  for (let i = 0; i < repos.length; i += REPOS_PER_QUERY) {
    const chunk = repos.slice(i, i + REPOS_PER_QUERY);
    // The time the read started: a head counts as newer than what was read from GitHub before that (src/verify/results.ts).
    const at = new Date().toISOString();
    const data = await client.query(mainCiQuery(chunk), mainCiVars(chunk));
    const parsed = parseHeads(chunk, data as Record<string, RepoNode>);
    await saveHeads(db, parsed, at);
    heads += parsed.length;
    // A moved head may name new git dependencies the crate mirror has to serve; a failed read is retried on the next poll.
    try {
      await refreshMirrorSources(db, client, parsed, log);
    } catch (e) {
      log(`crate mirror: git sources: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  // A red head whose culprit is a PR we merged stops the merge path.
  const rows = await mainCiRepos(db);
  const red = rows.flatMap((r) => (r.state === "red" && r.culprit?.pr ? [{ repo: r.repo, number: r.culprit.pr, sha: r.culprit.sha }] : []));
  if (red.length) {
    const merged = await loadMergedInfo(db, red.map((r) => ({ repo: r.repo, number: r.number })));
    await tripMergeBreakers(db, red.flatMap((r) => {
      const m = merged.get(`${r.repo}#${r.number}`);
      return m?.lastAt ? [{ repo: r.repo, number: r.number, mergedAt: m.lastAt, reason: `main CI of ${r.repo} is red after our merge of #${r.number}`, evidence: [mainCiEvidence(r.repo, r.number, r.sha)] }] : [];
    }));
  }
  await resumeMainCiTrips(db, rows, log);
  if (!only) await saveSyncState(db, { main_ci_polled_at: new Date().toISOString() });
  // A new head, or a new toolchain image of the warm producer, queues the repo's warm build.
  const warm = await warmPass(db);
  log(`main-ci: ${heads} heads of ${repos.length} repos${warm ? `; ${warm} warm build${warm === 1 ? "" : "s"} queued` : ""}`);
  return { repos: repos.length, heads };
}

/** Marks the evidence a red main trips a merge breaker with; no other trip writes it. */
export const MAIN_CI_EVIDENCE = "main-ci:";

/** The evidence a red main trips a merge breaker with: our merged PR and the red head of main, behind MAIN_CI_EVIDENCE. */
const mainCiEvidence = (repo: string, number: number, sha: string): string => `${MAIN_CI_EVIDENCE}${repo}#${number}@${sha.slice(0, 8)}`;

const escaped = (repo: string): string => repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether every cause on a merge breaker is a red main: each evidence entry is a main-CI entry of the repo. A trip without
 * the marker (a post-merge defect, also one added while main was red, or a main-CI trip from before the marker) is a person's.
 */
export function redMainOnly(t: Pick<TripRow, "evidence">, repo: string): boolean {
  const form = new RegExp(`^${escaped(MAIN_CI_EVIDENCE)}${escaped(repo)}#\\d+@[0-9a-f]+$`);
  return t.evidence.length > 0 && t.evidence.every((e) => form.test(e));
}

/**
 * Resumes, as the pipeline, each merge breaker that a red main tripped once that main counts as green (or failing only optional
 * checks) again: the state comes from the newest head, so from the red head the trip names rerun green or from a later head that
 * holds it. The check is made again in the write that clears the trip, so a cause added meanwhile keeps it. A merge breaker with
 * any other cause stays for a person.
 */
async function resumeMainCiTrips(db: Db, rows: MainCiRepoRow[], log: (line: string) => void): Promise<void> {
  const passing = rows.filter((r) => r.state === "green" || r.state === "optional");
  if (!passing.length) return;
  const trips = await loadTrips(db, { keys: passing.map((r) => tripKey("merge", r.repo)) });
  const due = passing.filter((r) => { const t = trips.get(tripKey("merge", r.repo)); return !!t && redMainOnly(t, r.repo); });
  if (!due.length) return;
  const repoOf = new Map(due.map((r) => [tripKey("merge", r.repo), r.repo]));
  const resumed = await resumeTripsIf(db, [...repoOf.keys()], "pipeline", (t) => redMainOnly(t, repoOf.get(t.stage)!));
  for (const t of resumed) log(`main-ci: resumed ${t.key}: main CI passes again (${t.reason})`);
}

/** Polls when the last full poll is older than POLL_EVERY_MS; the sync run calls it, so it runs with the pipeline on or off. */
export async function pollMainCiIfDue(db: Db, client: Querier, now = Date.now()): Promise<boolean> {
  const at = (await loadSyncState(db)).main_ci_polled_at;
  if (at && now - Date.parse(at) < POLL_EVERY_MS - 5_000) return false;
  await pollMainCi(db, client);
  return true;
}

/**
 * `state`: what the branch counts as (derive()); `headState`: the newest head's own state, which differs while that head's checks
 * run after a red head. `failing` are the checks that failed at the head `state` comes from.
 */
export type MainCiRepoRow = {
  repo: string; state: MainCiState; headState: MainCiState; branch: string; headSha: string; headline: string | null; committedAt: string | null;
  failing: { name: string; url: string | null }[]; redSince: string | null; lastGreenSha: string | null; culprit: Culprit | null; updatedAt: string;
  /** What AutoCraft is doing about the red head (src/mainfix); null when nothing. */
  autocraft: string | null;
};

/** One entry per repo with stored heads, red first, then by name. `hidden` repos are left out. */
export async function mainCiRepos(db: Db, hidden: HiddenRepos = [], nowMs: number = Date.now()): Promise<MainCiRepoRow[]> {
  const by = await loadDecidingHeads(db, hidden);
  const out: MainCiRepoRow[] = [];
  /** The head each row's state comes from: what AutoCraft does about a red branch is recorded at its red head. */
  const from = new Map<string, MainHeadSummary>();
  for (const [repo, heads] of by) {
    const at = currentHead(heads, nowMs);
    if (!at) continue;
    const { cur, settled, d } = at;
    let failing: { name: string; url: string | null }[] = [];
    try { failing = JSON.parse(settled.failing) as typeof failing; } catch { /* malformed: none shown */ }
    from.set(repo, settled);
    out.push({ repo, state: d.state, headState: cur.state as MainCiState, branch: cur.branch, headSha: cur.head_sha, headline: cur.headline, committedAt: cur.committed_at, failing, redSince: d.redSince, lastGreenSha: d.lastGreenSha, culprit: d.culprit, updatedAt: cur.updated_at, autocraft: null });
  }
  const texts = await autocraftTexts(db, out.map((r) => ({ repo: r.repo, headSha: from.get(r.repo)!.head_sha, state: from.get(r.repo)!.state })));
  for (const r of out) r.autocraft = texts.get(`${r.repo}\0${from.get(r.repo)!.head_sha}`) ?? null;
  const weight: Record<MainCiState, number> = { red: 0, optional: 1, running: 2, none: 3, green: 4 };
  return out.sort((a, b) => weight[a.state] - weight[b.state] || a.repo.localeCompare(b.repo));
}

export function summarize(rows: { state: MainCiState }[]): Record<MainCiState, number> {
  const s: Record<MainCiState, number> = { green: 0, red: 0, optional: 0, running: 0, none: 0 };
  for (const r of rows) s[r.state]++;
  return s;
}

async function show(args: string[]): Promise<void> {
  let only: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") only = args[++i];
    else throw new Error(`unknown argument ${args[i]}\nusage: main-ci [--repo R]`);
  }
  const rows = (await mainCiRepos(await openDb())).filter((r) => !only || r.repo === only);
  console.log(`${"repo".padEnd(28)} ${"state".padEnd(12)} ${"head".padEnd(9)} ${"red since".padEnd(21)} failing`);
  for (const r of rows) {
    console.log(`${r.repo.padEnd(28)} ${(r.state === r.headState ? r.state : `${r.state}/${r.headState}`).padEnd(12)} ${r.headSha.slice(0, 8).padEnd(9)} ${(r.redSince ?? "-").padEnd(21)} ${r.failing.map((f) => f.name).join(", ") || "-"}${r.culprit ? `  culprit ${r.culprit.sha.slice(0, 8)}${r.culprit.pr ? ` #${r.culprit.pr}` : ""}` : ""}`);
  }
}

export const commands = {
  "main-ci": { summary: "CI state of each synced repo's default branch: [--repo R]", run: show },
};
