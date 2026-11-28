// Stage 6, Integrate (batches): lands the merge-eligible PRs of a repo together. A batch is built from the
// default branch by merging each PR head with a merge commit (so GitHub marks every contributor PR merged when
// the batch lands), pushed to the pipeline account's fork, opened as a PR at once and merged through the merge
// command once upstream CI on the batch PR is green. Upstream CI is the only check of the combined tree.
//
//   autocraft-server merge-batches --repo R [--limit N]    (the runner's merge step calls runBatches)
//
// One run advances every batch of the repo in flight, then starts the next batch when none is left. A red batch is
// worked out without a model, cheapest first: checks that were red on the default branch at the base too blame no PR
// (the batch is rebuilt on a newer head, or waits); a failure the log traces to members (batch-blame.ts) tests those
// alone and rebuilds the rest without them; otherwise the failed runs are rerun once (a flake); then the batch is
// split in half and each half retried. A single PR still red goes on hold. When the default branch moves, the batch
// is rebuilt on the new head. Every rebuild also takes the PRs a new batch would take now, and a batch whose CI
// started less than TOPUP_WINDOW_MS ago is rebuilt once to take those that became eligible since. Every GitHub write
// goes through `exec` / `run`.
import { ownPrSelect } from "../github/adopt.ts";
import { standsLive, type RefreshDeps } from "../preapproval/permissions.ts";
import { mkdirSync } from "node:fs";
import { cloneTask, createTask, getTask, MAX_PATCH_BYTES, TERMINAL, warmKeyOf } from "../build/tasks.ts";
import { featureOn } from "../build/features.ts";
import { failureTail } from "../build/rounds.ts";
import { outcomeOf } from "../verify/results.ts";
import { scrub } from "../runner/scrub.ts";
import { rustPlan } from "../worker/rust.ts";
import type { RefusalCode } from "../core/codes.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guard, guardBatchMerge, guardRepo, liveOf, type GuardedRepo } from "../core/guard.ts";
import { repoInScope } from "../core/scope.ts";
import { claimForWork } from "../github/claim.ts";
import { ghClosePr, ghOpenPr, ghRerunMainFailed, mergeViaCommand, pushOwnBranch, type Writer } from "../github/write.ts";
import { readFailure } from "../cifix/logs.ts";
import type { CiFailure } from "../cifix/types.ts";
import { MAX_LOCATIONS, MAX_SUSPECTS, suspects } from "./batch-blame.ts";
import { failureLocations } from "../core/failure-locations.ts";
import { type Exec, exec, fixupDir } from "../fixup/git.ts";
import { whoAmI } from "../fixup/index.ts";
import { setPipelineLogin } from "../github/pipeline-account.ts";
import { commitIdentity, type Identity } from "../github/identity.ts";
import { branchOf, forkOf, mainHeadOf } from "../github/fork.ts";
import type { Querier } from "../mirror.ts";
import { refreshChecks, type PrChecks } from "../review/checks.ts";
import { BatchGit } from "./batch-git.ts";
import { ACTIVE_BATCH, BLOCKED_BY_REVIEW, CLOSED_BY_PERSON, MAX_PUBLISH_FAILURES, PUBLISH_FAILED, RUNS_WAIT_NOTE, BUILD_MAX_MS, MAX_BUILD_TRIES, admits, cancelBuild, retryDelayMs, getBatch, publishBackoffs, publishDelayMs, updateBatch, type BatchMember, type BatchView } from "./batch-store.ts";
import { firstRefusal, mergeVerdicts } from "./approval.ts";
import { baseRefusal, recordLiveBase } from "./base.ts";
import { allowFailedArgs, ciNow, commandNote, prInfo, mergeRun, DEFAULT_MERGE_COMMAND, type CommandResult } from "./index.ts";
import { liveGateChecked } from "../review/discussion.ts";
import { baseRed, judgeHead, vsMainStatus } from "../mainci/no-new.ts";
import { optionalChecks } from "../optional-checks.ts";
import { buildQueue, type QueueEntry } from "./queue.ts";
import { planned } from "../core/select.ts";
import { NO_WORKFLOW_SCORE } from "../core/work-score.ts";
import { envVar } from "../env.ts";
import { jobItem } from "../runner/job-items.ts";
import { leaseItem } from "../runner/leases.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { addAudit } from "../data/control/index.ts";
import { loadBatchRun, loadBatchSizes, loadRunApprovals, loadVsMainAt, openBatch, recordLanded as saveLanded, updateBatches, type VsMainRow } from "../data/merge/index.ts";
import type { StageRow } from "../data/merge/types.ts";
import { loadItems, loadMainCiAt } from "../data/mirror/index.ts";
import { sizeOf } from "../core/rules.ts";
import { addStageEvents } from "../data/planner/index.ts";
import { loadItemAreas } from "../data/triage/index.ts";
import { loadPrWorkflows, loadRepoScopes, loadWorkScores } from "../data/workflow/index.ts";
import { afterBatch } from "./controls.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

const ACTOR = "batch";
/** How long the one rerun of a red batch PR gets to report new results before the batch is split anyway. */
export const RERUN_WAIT_MS = 45 * 60_000;
/** How long after its PR opened a batch is still rebuilt once to take PRs that became eligible since: its CI has not got far. */
export const TOPUP_WINDOW_MS = 15 * 60_000;
/** Refusals of a member's merge that say nothing about the PR: the batch waits for them, as a single merge does. Any other leaves the member out. */
const WAITED_FOR: ReadonlySet<RefusalCode> = new Set(["breaker", "actor-unknown"]);
/** Batches in flight per repo at most; a split or a trace starts no more. */
const MAX_ACTIVE = 8;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)$/;

export type BatchDeps = {
  /** Every git and gh command. */
  exec: Exec;
  querier: Querier;
  /** Runs the merge command (`$AUTOCRAFT_MERGE_CMD`, default safe-merge). */
  run: (cmd: string, args: string[], appEnv?: Record<string, string>) => Promise<CommandResult>;
  mergeCommand: string;
  /** The head commit of the repo's default branch, or null. */
  mainHead: (repo: string, branch: string) => Promise<string | null>;
  now: () => Date;
  /** Directory holding one bare cache repository per repo. */
  root: string;
  /** Reads a maintainer's write permission through the GitHub App (default `appPermission`). */
  permission?: RefreshDeps["permission"];
};

export type BatchParams = {
  repo: string;
  /** Most PRs this run may start or land (the stage's daily limit left). */
  limit?: number;
  /** Called with the running count of PRs merged. */
  onMerged?: (merged: number) => void;
  /** Who asked; default: an operator at the command line. */
  by?: By;
};

export type BatchSummary = { runId: string; repo: string; started: string[]; published: string[]; merged: number[]; failed: number[]; split: string[]; superseded: string[]; waiting: string[] };

const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Why a text diff cannot be applied by a build task, or "". */
const diffProblem = (patch: string): string =>
  Buffer.byteLength(patch) > MAX_PATCH_BYTES ? "larger than the task limit" : /^Binary files |^GIT binary patch/m.test(patch) ? "binary" : "";

type Cand = { number: number; head: string; size: string; lines: number };
/** PRs a batch takes after its own members, and the batch size they fill up to. */
type Extra = { cands: Cand[]; max: number };
/** A batch built in the cache but not opened: its base and each PR's merge commit; `extra`: the PR came from an Extra. */
type Chain = { base: string; chain: { cand: Cand; commit: string; extra: boolean }[] };

/**
 * Candidates in the order a new batch takes them: the top-ranked PR, then the other PRs of its area in rank order, then
 * the rest in rank order. Only the order changes, so a ready PR is never left out for an area match; a PR with no area
 * matches nothing and comes in through the rank-order fill.
 */
export function areaFirst<T extends { number: number }>(ranked: readonly T[], areaOf: (n: number) => string | null): T[] {
  const area = ranked.length ? areaOf(ranked[0]!.number) : null;
  if (area === null) return [...ranked];
  const same = ranked.filter((c) => areaOf(c.number) === area);
  return [...same, ...ranked.filter((c) => areaOf(c.number) !== area)];
}

export async function defaultBatchDeps(): Promise<BatchDeps> {
  const { Client } = await import("../mirror.ts");
  return {
    exec, querier: new Client(1000), run: mergeRun, mergeCommand: envVar("MERGE_CMD") || DEFAULT_MERGE_COMMAND,
    mainHead: mainHeadOf, now: () => new Date(), root: fixupDir(),
  };
}

export async function runBatches(db: Db, params: BatchParams, log: (line: string) => void = console.log, deps?: BatchDeps): Promise<BatchSummary> {
  const d = deps ?? await defaultBatchDeps();
  const { repo } = params;
  const at = () => d.now().toISOString();
  const runId = `batch-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  const s: BatchSummary = { runId, repo, started: [], published: [], merged: [], failed: [], split: [], superseded: [], waiting: [] };
  const scope = (await loadRepoScopes(db, [repo])).get(repo);
  if (!repoInScope(scope, "cleanup")) { log(`batch ${repo}: not tracked; nothing done`); return s; }
  // With the repo's pipeline off only batches made of PRs with a live workflow are worked; the others are closed.
  const fullScope = repoInScope(scope, "builds");
  /** The repo's active batches, split into those this run works and those whose PRs left the scope. */
  const batchesNow = async (): Promise<{ mine: BatchView[]; outside: BatchView[] }> => {
    const active = (await loadBatchRun(db, repo)).active;
    if (fullScope) return { mine: active, outside: [] };
    const refs = active.flatMap((b) => b.members.map((m) => ({ repo, number: m.number })));
    const live = await loadPrWorkflows(db, refs);
    const isMine = (b: BatchView) => b.members.every((m) => live.has(`${repo}#${m.number}`));
    return { mine: active.filter(isMine), outside: active.filter((b) => !isMine(b)) };
  };
  const activeCount = async (): Promise<number> => (await loadBatchRun(db, repo)).active.length;
  mkdirSync(d.root, { recursive: true });
  const git = new BatchGit(d.exec, d.root, repo);
  const stageRow = (number: number, stage: StageRow["stage"], note: string): StageRow => ({ repo, number, stage, at: at(), actor: ACTOR, note });
  const audit = async (action: string, target: string, details: Record<string, unknown>): Promise<void> => await addAudit(db, [{ login: ACTOR, action, target, details }]);
  let landed = 0;
  /** PRs this run may still start or land under the stage's daily limit. */
  const left = () => (params.limit === undefined ? Infinity : params.limit - landed);

  const w: Writer = { db, login: ACTOR };
  const by = params.by ?? CLI_BY;
  const liveRead = liveOf(db, d.querier);
  const refOf = (n: number) => `${repo}#${n}`;
  const branch = await branchOf(db, repo);
  /**
   * The batch's repo-level writes (its branch, its PR, the reruns) need every member's merge to be permitted (mergeVerdicts):
   * with no repo approval a batch holds only PRs people approved one by one. `members` null: a write
   * that only ends the batch (closing its PR), which needs the pipeline alone.
   */
  const grant = async (members: { number: number; head_oid: string }[] | null): Promise<GuardedRepo | null> => {
    const verdicts = members ? await mergeVerdicts(db, repo, members.map((m) => ({ number: m.number, head: m.head_oid }))) : null;
    const why = verdicts && firstRefusal(verdicts, repo);
    if (why) { log(`  ${why}`); return null; }
    const g = await guardRepo(db, repo, members ? "merge" : null, by, undefined, { members: verdicts ? [...verdicts.values()] : [] });
    if ("refused" in g) { log(`  ${g.refused}`); return null; }
    return g;
  };
  const closePr = async (b: BatchView, why: string) => {
    if (b.pr_number === null) return;
    const g = await grant(null);
    if (!g) return;
    const r = await ghClosePr(w, g, d.exec, { repo, number: b.pr_number }, { by: "fixed" }, why, { run: runId, batch: b.branch });
    if (r.code !== 0) log(`  ${b.branch}: could not close the batch PR: ${oneLine(r.stderr)}`);
  };

  /**
   * Members whose merge is a person's (`as`) who no longer has write access to the repo. The batch PR is merged without the user lane,
   * so the permission is read now (standsLive, once per approver) rather than trusted from the cache. `unsure`: GitHub could not answer
   * for one.
   */
  async function approversGone(members: { number: number; as: Identity }[]): Promise<{ gone: { number: number; why: string }[]; unsure: boolean }> {
    const byLogin = new Map<string, number[]>();
    for (const m of members) if (m.as !== "app") { const by = m.as.slice("user:".length); byLogin.set(by, [...(byLogin.get(by) ?? []), m.number]); }
    const gone: { number: number; why: string }[] = [];
    let unsure = false;
    for (const [login, numbers] of byLogin) {
      const v = await standsLive(db, login, repo, d.permission ? { permission: d.permission } : {});
      if (v === "unknown") unsure = true;
      if (v === "no") for (const number of numbers) gone.push({ number, why: `${login} no longer has write access to ${repo}, so their approval no longer counts` });
    }
    return { gone, unsure };
  }

  /**
   * Builds a batch of the candidates, in order, from the current head of the default branch (or `onBase`, a head the caller
   * fetched for several batches that must share it); null when no PR could be merged. `extra`: candidates taken after
   * them while the batch has room under `extra.max`. `toppedUp`: the batch is a top-up and gets none of its own.
   */
  async function startBatch(cands: Cand[], max: number, parentId: number | null, opts: { onBase?: string; extra?: Extra; toppedUp?: boolean } = {}): Promise<number | null> {
    const built = await chainOf(cands, max, opts);
    return built.chain.length ? openChain(built, parentId, opts) : null;
  }

  /** The merge commits of the candidates that go into a batch, in order, on `base`; `extra` marks a PR from `opts.extra`. Writes nothing but the cache. */
  async function chainOf(cands: Cand[], max: number, opts: { onBase?: string; extra?: Extra } = {}): Promise<Chain> {
    const base = opts.onBase ?? await git.fetchMain(ownerOf(repo), repo, branch);
    const who = await whoAmI(d.exec);
    const author = await commitIdentity(db, repo, async () => who);
    await setPipelineLogin(db, who.login);
    const chain: Chain["chain"] = [];
    let cur = base;
    const takes = [...cands.map((c) => ({ c, max })), ...(opts.extra?.cands ?? []).map((c) => ({ c, max: opts.extra!.max }))];
    for (const { c, max } of takes) {
      if (chain.length && !admits(chain.map((x) => x.cand), c, max)) continue;
      const sha = await git.fetchPr(ownerOf(repo), repo, c.number);
      if (sha !== c.head) { log(`  ${refOf(c.number)}: head moved to ${short(sha)}; left out`); continue; }
      // A batch is built on the default branch: a PR aimed at another base would bring that base's commits along.
      const info = await prInfo(d.querier, repo, c.number);
      if (!info || info.baseRef !== branch) {
        if (info) await recordLiveBase(db, repo, c.number, c.head, info.baseRef);
        log(`  ${refOf(c.number)}: left out: its base branch is ${info?.baseRef ?? "unknown"}, not ${branch}`);
        continue;
      }
      // The review must have read the diff against the default branch too, or the batch would bring in commits no review read.
      const baseWhy = await baseRefusal(db, repo, c.head, c.number, info.baseRef);
      if (baseWhy) { log(`  ${refOf(c.number)}: left out: ${baseWhy}`); continue; }
      const g = await guard(db, { repo, number: c.number }, { kind: "merge", head: c.head, batch: true }, by, liveRead);
      if ("refused" in g) { log(`  ${refOf(c.number)}: left out: ${g.refused}`); continue; }
      const approvers = await approversGone([{ number: c.number, as: g.as }]);
      if (approvers.gone.length) { log(`  ${refOf(c.number)}: left out: ${approvers.gone[0]!.why}`); continue; }
      if (approvers.unsure) { log(`  ${refOf(c.number)}: left out: GitHub could not confirm the write permission of who approved it`); continue; }
      const tree = await git.mergeTree(cur, sha);
      if (!tree) { log(`  ${refOf(c.number)}: conflicts with the batch so far; waits for the next one`); continue; }
      cur = await git.mergeCommit(tree, [cur, sha], `Merge pull request #${c.number}`, { name: author.name, email: author.email });
      chain.push({ cand: c, commit: cur, extra: !cands.includes(c) });
    }
    return { base, chain };
  }

  /**
   * Opens the batch of a chain: its row (as a rebuild of `parentId`, carrying the parent's top-up mark and first PR
   * opening), its build task or its PR at once.
   */
  async function openChain({ base, chain }: Chain, parentId: number | null, opts: { toppedUp?: boolean } = {}): Promise<number> {
    const who = await whoAmI(d.exec);
    const parent = parentId === null ? null : await getBatch(db, parentId);
    const toppedUp = !!opts.toppedUp || Number(parent?.topped_up ?? 0) === 1;
    const tip = chain[chain.length - 1]!.commit;
    // With Build batches on, a build task checks the combined tree before the batch PR opens. Any trouble queueing it
    // opens the PR as usual: upstream CI stays the authority.
    let taskId: number | null = null;
    let skipped = "";
    if (fullScope && await featureOn(db, "batch-build", repo)) {
      try {
        const patch = await git.diffText(base, tip);
        skipped = diffProblem(patch) && `the combined diff is ${diffProblem(patch)}`;
        if (!skipped) {
          taskId = await createTask(db, {
            step: "merge-batch", repo, headSha: base, baseSha: base, requires: { os: "linux", toolchains: ["rust-stable"] },
            plan: rustPlan({ cargoArgs: ["--workspace"] }), patch, warm: { key: warmKeyOf(repo), role: "use" },
          });
        }
      } catch (e) { skipped = `the build could not be queued: ${oneLine(String((e as Error).message ?? e), 120)}`; }
    }
    const members: BatchMember[] = chain.map((x) => ({ number: x.cand.number, head_oid: x.cand.head }));
    // The batch row, its members and the `batch-start` audit row in one write.
    const { id, branch: name } = await openBatch(db, {
      repo, baseSha: base, commitSha: tip, parentId, taskId, members, at: at(), build: taskId !== null ? "pending" : skipped ? "skipped" : null, runId, prs: members.map((m) => m.number),
      ...(toppedUp ? { toppedUp: true } : {}), ...(parent?.opened_at ? { openedAt: parent.opened_at } : {}),
    });
    if (taskId === null && skipped) await skipBuild(await getBatch(db, id), skipped, false);
    s.started.push(name);
    const ag = await grant(members);
    if (ag) for (const m of members) await claimForWork(w, ag, d.querier, repo, m.number, "pr", { id: who.nodeId, login: who.login }, { run: runId, batch: name }, log);
    const joined = chain.filter((x) => x.extra).length;
    log(`  ${name}: ${members.length} PR${members.length === 1 ? "" : "s"} (${members.map((m) => `#${m.number}`).join(", ")}) on ${short(base)}${joined ? `, ${joined} of them newly eligible` : ""}; ${taskId === null ? "opening the batch PR" : `building and testing it in task #${taskId} first`}`);
    if (taskId === null) await publish(await getBatch(db, id), members);
    return id;
  }

  /** The batch PR opens without a passed build: records why (`set` false: the row already says skipped). */
  async function skipBuild(b: BatchView, why: string, set = true): Promise<void> {
    if (set) await updateBatch(db, b.id, at(), { build_state: "skipped" });
    await audit("batch-build-skip", `${repo}:${b.branch}`, { run: runId, reason: oneLine(why, 200) });
    log(`  ${b.branch}: build skipped: ${why}`);
  }

  const asCands = (ms: BatchMember[]): Cand[] => ms.map((m) => ({ number: m.number, head: m.head_oid, size: "S", lines: 0 }));
  /** Members as candidates with the size the mirror gives them, so the PRs that join them count them against the line cap and an L-size PR stays alone. */
  async function sizedCands(ms: BatchMember[]): Promise<Cand[]> {
    const items = await loadItems(db, ms.map((m) => ({ repo, number: m.number })), "pr");
    return ms.map((m) => {
      const i = items.get(refOf(m.number));
      const lines = (i?.additions ?? 0) + (i?.deletions ?? 0);
      return { number: m.number, head: m.head_oid, size: sizeOf(lines), lines };
    });
  }

  /**
   * The PRs a new batch would take now, in the order it takes them, and how many it takes (the repo's batch size within the
   * daily limit, less `reserved`: the PRs of the repo's other active batches, which land under the same limit); none while
   * the repo has no work scope or the limit is used up. `taken`: PRs already batched, left out. `backoff`: the repo waits
   * out its publish backoff until then, and nothing is taken.
   */
  async function eligibleNow(taken: ReadonlySet<number>, reserved = 0): Promise<{ cands: Cand[]; max: number; due: number; backoff: number | null }> {
    const none = { cands: [], max: 0, due: 0, backoff: null };
    const room = left() - reserved;
    if (!repoInScope(scope, "work") || room <= 0) return none;
    // PRs in a repo Verify cannot build are left to the single-PR merge (the plan's merge action is not batchable).
    const due = (await planned(db, "merge", { repo, by })).filter((p) => p.action.params?.batchable && !taken.has(p.facts.number));
    if (!due.length) return none;
    const backoff = (await publishBackoffs(db, d.now(), [repo])).get(repo);
    if (backoff !== undefined && backoff > d.now().getTime()) return { ...none, due: due.length, backoff };
    const keys = due.map((p) => ({ repo, number: p.facts.number }));
    const [scores, sizes, areas] = await db.together(() => Promise.all([loadWorkScores(db, keys), loadBatchSizes(db, [repo]), loadItemAreas(db, keys)]));
    const score = (n: number) => scores.get(refOf(n)) ?? NO_WORKFLOW_SCORE;
    const ranked = due.sort((a, b) => score(b.facts.number) - score(a.facts.number) || a.facts.number - b.facts.number)
      .map((p): Cand => ({ number: p.facts.number, head: p.action.head!, size: p.facts.size, lines: p.facts.lines }));
    return { cands: areaFirst(ranked, (n) => areas.get(refOf(n))?.area ?? null), max: Math.min(sizes.get(repo)!, room), due: due.length, backoff: null };
  }

  /** The PRs to leave out of a fill: `also` and every PR in an active batch of the repo; `reserved`: how many of those are in active batches other than `except`. */
  async function batched(also: BatchMember[], except: number | null = null): Promise<{ taken: Set<number>; reserved: number }> {
    const taken = new Set(also.map((m) => m.number));
    let reserved = 0;
    for (const b of (await loadBatchRun(db, repo)).active) {
      if (b.id === except) continue;
      reserved += b.members.length;
      for (const m of b.members) taken.add(m.number);
    }
    return { taken, reserved };
  }

  /**
   * Rebuilds `keep` as a new batch that also takes the PRs a new batch would take now, as far as it has room. `old`: the
   * members of the batches this rebuild replaces, which stay out of the fill (they return to the queue, or go to their own batch).
   */
  async function rebuild(keep: BatchMember[], max: number, parentId: number, old: BatchMember[], opts: { onBase?: string; toppedUp?: boolean } = {}): Promise<number | null> {
    const { taken, reserved } = await batched([...keep, ...old]);
    const pool = await eligibleNow(taken, reserved);
    if (!pool.cands.length) return startBatch(asCands(keep), max, parentId, opts);
    return startBatch(await sizedCands(keep), max, parentId, { ...opts, extra: { cands: pool.cands, max: pool.max } });
  }

  /** Closes the batch; `keep` is rebuilt on the current default branch head. `named`: the members its closing comment speaks of. */
  async function supersede(b: BatchView, keep: BatchMember[], why: string, named = keep, next?: Chain): Promise<void> {
    // A control may have ended the batch while the caller's GitHub calls ran.
    if (!ACTIVE_BATCH.includes((await getBatch(db, b.id)).state)) return;
    await cancelBuild(db, b, ACTOR);
    await updateBatch(db, b.id, at(), { state: "superseded", summary: why });
    await closePr(b, `Closing: ${why}.${await afterBatch(db, repo, named.map((m) => m.number), named.length < b.members.length)}`);
    s.superseded.push(b.branch);
    log(`  ${b.branch}: ${why}`);
    if (next) await openChain(next, b.id, { toppedUp: true });
    else if (keep.length && left() > 0) await rebuild(keep, left(), b.id, b.members);
  }

  /** Why the batch must be rebuilt because the default branch moved, or null: a move that merges cleanly with the batch tip does not matter (GitHub and upstream CI re-check the batch PR). */
  async function movedAway(b: BatchView): Promise<string | null> {
    const head = await d.mainHead(repo, branch);
    if (!head || head === b.base_sha) return null;
    try {
      const now = await git.fetchMain(ownerOf(repo), repo, branch);
      if (await git.mergeTree(now, b.commit_sha)) return null;
    } catch { /* the batch commit is gone from the cache: rebuild */ }
    return `${branch} moved to ${short(head)} and conflicts with the batch`;
  }

  /** A failed batch: several PRs split in half and each half retried; one PR goes on hold. */
  async function fail(b: BatchView, why: string): Promise<void> {
    const members = b.members;
    await closePr(b, "Closing: the batch failed. Its PRs are retried in smaller batches or held.");
    if (members.length === 1) {
      const m = members[0]!;
      const summary = why;
      // The batch row, the repo's smaller batch size, the hold stage row and the audit row in one write.
      await db.write(async () => {
        await updateBatches(db, [{ id: b.id, at: at(), set: { state: "failed", summary: oneLine(summary, 400) }, size: "shrink" }]);
        await addStageEvents(db, [stageRow(m.number, "hold", `batch failed at ${short(m.head_oid)}: ${oneLine(summary, 200)}`)]);
        await audit("batch-hold", refOf(m.number), { run: runId, batch: b.branch, summary: oneLine(summary, 200) });
      });
      s.failed.push(m.number);
      log(`  ${b.branch}: ${refOf(m.number)} failed alone; on hold: ${oneLine(summary, 120)}`);
      return;
    }
    await updateBatches(db, [{ id: b.id, at: at(), set: { state: "split", summary: oneLine(why, 400) }, size: "shrink" }]);
    s.split.push(b.branch);
    log(`  ${b.branch}: ${why}; splitting ${members.length} PRs in half`);
    const mid = Math.ceil(members.length / 2);
    // The PRs that became eligible meanwhile join the second half; the first is built of members only.
    const [one, two] = [members.slice(0, mid), members.slice(mid)];
    if (await activeCount() >= MAX_ACTIVE || left() <= 0) return;
    await startBatch(asCands(one), left(), b.id);
    if (await activeCount() >= MAX_ACTIVE || left() <= 0) return;
    await rebuild(two, left(), b.id, members);
  }

  /**
   * The failure points at `traced` (fewer than all members): each of them is tested alone in a batch of its own, which
   * holds it only if it is red there too, and the others are rebuilt without them. The batch size stays: the batch
   * was not too big, one PR broke it.
   */
  async function drop(b: BatchView, members: BatchMember[], traced: Map<number, string>, why: string): Promise<void> {
    // A control may have ended the batch while the caller's GitHub calls ran.
    if (!ACTIVE_BATCH.includes((await getBatch(db, b.id)).state)) return;
    await cancelBuild(db, b, ACTOR);
    const list = [...traced].map(([n, w]) => `#${n} (${w})`).join("; ");
    await updateBatch(db, b.id, at(), { state: "split", summary: oneLine(`${why}; traced to ${list}: tested alone, the rest rebuilt without`, 400) });
    await closePr(b, `Closing: the batch failed and its failure points at ${[...traced.keys()].map((n) => `#${n}`).join(", ")}. Those are tested alone; the other PRs are rebuilt without them.`);
    await addAudit(db, [...traced].map(([n, w]) => ({ login: ACTOR, action: "batch-blame", target: refOf(n), details: { run: runId, batch: b.branch, reason: oneLine(w, 200) } })));
    s.split.push(b.branch);
    log(`  ${b.branch}: ${why}; traced to ${list}`);
    // Every batch started here is built on one head, so a suspect alone is never red from a change the others did not have.
    const base = await git.fetchMain(ownerOf(repo), repo, branch);
    // The suspects go first: their tests alone are what the trace asks for. A rest that finds no room returns to the queue
    // and is batched again later; nothing of it is lost.
    for (const m of members.filter((x) => traced.has(x.number))) {
      if (left() <= 0 || await activeCount() >= MAX_ACTIVE) break;
      await startBatch(asCands([m]), 1, b.id, { onBase: base });
    }
    // The PRs that became eligible meanwhile join the rest; a suspect is tested alone.
    const rest = members.filter((m) => !traced.has(m.number));
    if (rest.length && left() > 0 && await activeCount() < MAX_ACTIVE) await rebuild(rest, left(), b.id, [...b.members, ...members], { onBase: base });
  }

  /** The members a failure's log text points at, when that is a trace worth following (some, not all, and few). */
  async function traceOf(b: BatchView, members: BatchMember[], text: string): Promise<Map<number, string> | null> {
    if (members.length < 2) return null;
    try {
      const found = await suspects(git, b, members, failureLocations(text, MAX_LOCATIONS));
      return found.size && found.size < members.length && found.size <= MAX_SUSPECTS ? found : null;
    } catch (e) {
      log(`  ${b.branch}: the failure could not be traced: ${oneLine(String((e as Error).message ?? e), 120)}`);
      return null;
    }
  }

  const gh = async (args: string[]): Promise<string> => {
    const r = await d.exec("gh", args);
    if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout || `gh exited ${r.code}`));
    return r.stdout;
  };

  /** The failed checks of the batch tip with their log tails, or null when they cannot be read. Read-only. */
  async function readBatchFailure(b: BatchView): Promise<CiFailure | null> {
    try {
      const r = await readFailure(gh, repo, b.commit_sha, await optionalChecks(db, repo));
      // A log not readable yet still names the failed checks and their runs: the batch traces nothing in it and reruns or waits.
      return r.kind === "skip" ? null : r.failure;
    } catch {
      return null;
    }
  }

  /** The gate checks that failed on the default branch at `sha`, from the main CI poll; null when that head was not polled. */
  async function redOnMainAt(sha: string): Promise<Set<string> | null> {
    const row = (await loadMainCiAt(db, [{ repo, sha }])).get(`${repo}@${sha}`);
    if (!row) return null;
    try {
      return new Set((JSON.parse(row.failing) as { name?: string }[]).map((f) => f.name ?? "").filter(Boolean));
    } catch {
      return null;
    }
  }

  /**
   * Upstream CI failed on the batch PR. In order: checks red on the default branch at the base too blame no PR; a
   * failure the log traces drops those PRs (tested alone); otherwise the failed runs are rerun once; then the batch fails.
   */
  async function red(b: BatchView, members: BatchMember[], names: string[], vs: VsMainRow | null): Promise<void> {
    const optional = new Set(await optionalChecks(db, repo));
    const failing = names.filter((n) => !optional.has(n));
    const why = `upstream CI failed on the batch PR${failing.length ? `: ${vs?.state === "new" && vs.reason ? vs.reason : failing.join(", ")}` : ""}`;
    // A failure the comparison with main's found new is some member's: the base does not excuse it.
    const atBase = vs?.state === "new" ? null : await redOnMainAt(b.base_sha);
    if (atBase && failing.length && failing.every((n) => atBase.has(n))) {
      const head = await d.mainHead(repo, branch);
      if (head && head !== b.base_sha) return supersede(b, members, `${failing.join(", ")} failed on ${branch} at the base too; rebuilt on ${short(head)}`);
      const note = `${failing.join(", ")} failed on ${branch} at the base too; waits for ${branch} to change`;
      if (b.summary !== note) { await updateBatch(db, b.id, at(), { summary: note }); log(`  ${b.branch}: ${note}`); }
      s.waiting.push(b.branch);
      return;
    }
    const failure = await readBatchFailure(b);
    if (b.ci_reruns && b.ci_rerun_at) {
      // Only results from after the rerun say it failed again; older ones are what the rerun replaces. Results that cannot
      // be read are not fresh either: a GitHub hiccup must not split or hold before the wait is over.
      const fresh = !!failure && failure.checks.every((c) => !!c.completedAt && Date.parse(c.completedAt) > Date.parse(b.ci_rerun_at!));
      if (!fresh && d.now().getTime() < Date.parse(b.ci_rerun_at) + RERUN_WAIT_MS) { s.waiting.push(b.branch); return; }
    }
    const traced = failure && await traceOf(b, members, failure.checks.flatMap((c) => c.steps.map((x) => x.tail)).join("\n"));
    // A control may have ended the batch while the log and trace reads ran.
    const active = async (): Promise<boolean> => ACTIVE_BATCH.includes((await getBatch(db, b.id)).state);
    if (!await active()) return;
    if (traced) return drop(b, members, traced, why);
    if (!b.ci_reruns) {
      const runs = [...new Set((failure?.checks ?? []).filter((c) => c.conclusion === "failure" && c.runId !== null).map((c) => c.runId!))];
      const g = runs.length ? await grant(members) : null;
      if (g) {
        // GitHub's rollup is red as soon as one job fails, while the run's other jobs go on, and it refuses to rerun the
        // failed jobs of a run in progress: the one rerun waits until every failed check's run is completed.
        if (await anyRunInProgress(runs)) {
          if (!await active()) return;
          const note = `${why}; waiting for the failed CI runs to finish before the one rerun`;
          if (b.summary !== note) { await updateBatch(db, b.id, at(), { summary: oneLine(note, 400) }); log(`  ${b.branch}: ${note}`); }
          s.waiting.push(b.branch);
          return;
        }
        if (!await active()) return;
        // Recorded before the calls: one rerun per batch, also when this process dies in the middle of them.
        await updateBatch(db, b.id, at(), { ci_reruns: 1, ci_rerun_at: at(), summary: oneLine(`${why}; no PR traced, rerunning the failed runs once`, 400) });
        let refused = 0;
        for (const id of runs) if ((await ghRerunMainFailed(w, g, d.exec, { repo, head: b.commit_sha, runId: id }, { batch: b.branch })).code !== 0) refused++;
        await audit("batch-rerun", `${repo}:${b.branch}`, { run: runId, runs, refused });
        log(`  ${b.branch}: ${why}; no PR traced, reran ${runs.length} failed run${runs.length === 1 ? "" : "s"} once${refused ? ` (${refused} refused)` : ""}`);
        // Every call refused: no rerun is under way, so there is nothing to wait for.
        if (runs.length && refused === runs.length) return await active() ? fail(b, why) : undefined;
        s.waiting.push(b.branch);
        return;
      }
    }
    if (!await active()) return;
    return fail(b, why);
  }

  /** Whether any of the Actions runs is known to be not completed. A run that cannot be read counts as completed: the rerun is refused if it is not. */
  async function anyRunInProgress(runs: number[]): Promise<boolean> {
    for (const id of runs) {
      try {
        const r = await d.exec("gh", ["api", `repos/${slugOf(repo)}/actions/runs/${id}`]);
        if (r.code !== 0) continue;
        const st = (JSON.parse(r.stdout) as { status?: string }).status;
        if (st && st !== "completed") return true;
      } catch { /* unreadable: treated as completed */ }
    }
    return false;
  }

  /** A push or PR creation failed: the error is kept on the batch, the next try waits longer, and the fifth failure ends the batch so its PRs go back to the queue; the repo's next batch waits (publishBackoffMs). */
  async function publishFailed(b: BatchView, error: string): Promise<void> {
    const failures = b.retries + 1;
    log(`  ${b.branch}: ${error}`);
    if (failures >= MAX_PUBLISH_FAILURES) {
      await updateBatch(db, b.id, at(), { state: "failed", retries: failures, summary: oneLine(`${PUBLISH_FAILED} after ${failures} tries: ${error}`, 400) });
      s.failed.push(...b.members.map((m) => m.number));
      return;
    }
    await updateBatch(db, b.id, at(), { retries: failures, summary: oneLine(error, 400) });
    s.waiting.push(b.branch);
  }

  /**
   * The members with who each one's merge is made as, when every member may merge now. Null: the batch was rebuilt without the members
   * that may not, or it waits.
   */
  async function mayLand(b: BatchView, members: BatchMember[]): Promise<{ number: number; as: Identity }[] | null> {
    const verdicts = await mergeVerdicts(db, repo, members.map((m) => ({ number: m.number, head: m.head_oid })), { batch: true });
    const ok: { number: number; as: Identity }[] = [], out: string[] = [];
    let why = "", waits = "";
    for (const m of members) {
      const v = verdicts.get(m.number)!;
      if (v.ok) ok.push({ number: m.number, as: v.as });
      else if (WAITED_FOR.has(v.why.code)) waits ||= `${refOf(m.number)}: ${v.why.text}`;
      else { out.push(refOf(m.number)); why ||= v.why.text; }
    }
    if (out.length) { await supersede(b, members.filter((m) => !out.includes(refOf(m.number))), `${out.join(", ")} left the batch: ${why}`); return null; }
    if (waits) { log(`  ${b.branch}: waits: ${waits}`); s.waiting.push(b.branch); return null; }
    return ok;
  }

  async function publish(b: BatchView, members: BatchMember[]): Promise<void> {
    const moved = await movedAway(b);
    if (moved) return supersede(b, members, moved);
    // Time passes between building and pushing (and between retries of a failed push): the members must still be open at the batched heads.
    const checks = await refreshChecks(db, d.querier, repo, members.map((m) => m.number));
    const live = members.filter((m) => checks.some((c) => c.number === m.number && c.state === "OPEN" && !c.is_draft && c.head_oid === m.head_oid));
    if (live.length < members.length) return supersede(b, live, "a PR in the batch was closed, merged, pushed to or turned into a draft");
    // An operator may have stopped the batch while the checks were read.
    if ((await getBatch(db, b.id)).state !== "checking") return;
    if (!await mayLand(b, members)) return;
    const who = await whoAmI(d.exec);
    const g = await grant(members);
    if (!g) return publishFailed(b, "not approved or the pipeline is off");
    const fork = await forkOf(w, g, d.exec, who.login, repo, { run: runId });
    const push = await pushOwnBranch(w, g, git, "batch-push", { repo, remote: fork, branch: b.branch, sha: b.commit_sha }, { run: runId, fork });
    if (push.code !== 0) return publishFailed(b, `push failed: ${oneLine(push.stderr)}`);
    await updateBatch(db, b.id, at(), { fork });
    const links = members.map((m) => `- [${repo}#${m.number}](https://github.com/${slugOf(repo)}/pull/${m.number})`).join("\n");
    const body = `Lands ${members.length} reviewed and verified pull request${members.length === 1 ? "" : "s"} together. Each one is merged with its own commits.\n\n${links}\n`;
    // A crash after `gh pr create` leaves a PR for this branch: adopt it instead of failing on "already exists".
    const owner = fork.split("/")[0]!;
    const sel = await ownPrSelect(db, repo, [owner], branch);
    const found = await d.exec("gh", ["pr", "list", "--repo", `${slugOf(repo)}`, "--state", "open", "--head", b.branch, "--json", sel.json, "--jq", sel.jq]);
    const existing = found.code === 0 ? found.stdout.trim().split("\n")[0] ?? "" : "";
    const pr = PR_URL.test(existing) ? { code: 0, stdout: existing, stderr: "" }
      : await ghOpenPr(w, g, d.exec, "batch-pr", { repo, target: `${repo}:${b.branch}`, base: branch, head: `${owner}:${b.branch}`, title: `Integration batch ${b.branch}`, body }, { by: "fixed" }, { run: runId });
    const url = pr.stdout.trim().split("\n").pop() ?? "";
    const m = url.match(PR_URL);
    if (pr.code !== 0 || !m) return publishFailed(b, `batch PR not opened: ${oneLine(pr.stderr || pr.stdout)}`);
    if ((await getBatch(db, b.id)).state !== "checking") {
      // Ended while the PR was being opened: close it again and leave the row as it is.
      const closed = await ghClosePr(w, g, d.exec, { repo, number: Number(m[1]) }, { by: "fixed-operator" }, "Closing: the batch was ended by an operator.", { run: runId, batch: b.branch });
      if (closed.code !== 0) {
        // Keep the PR on the row so a later control or run can close it.
        await updateBatch(db, b.id, at(), { pr_number: Number(m[1]), pr_url: url });
        log(`  ${b.branch}: ended while its PR was opened; could not close ${url}: ${oneLine(closed.stderr)}`);
        return;
      }
      log(`  ${b.branch}: ended while its PR was opened; closed ${url}`);
      return;
    }
    await updateBatch(db, b.id, at(), { state: "open", pr_number: Number(m[1]), pr_url: url, ...(b.opened_at ? {} : { opened_at: at() }) });
    s.published.push(b.branch);
    log(`  ${b.branch}: opened ${url}`);
  }

  /** Bookkeeping once the batch PR is merged, whoever merged it: one write records the batch, its members' attempts, the mirror, stage and audit rows. */
  async function bookLanded(b: BatchView, members: BatchMember[], q: QueueEntry[], mergeSha: string | null = null): Promise<void> {
    // A control may have ended the batch while the merge ran: the merge still happened, so the row says so and the audit shows the order of events.
    await saveLanded(db, {
      batchId: b.id, runId, at: at(), mergeSha: mergeSha ?? "", by: ACTOR,
      members: members.map((m) => {
        const e = q.find((x) => x.number === m.number);
        return { number: m.number, head: m.head_oid, path: e?.path === "rule" || !e ? "rule" : "maintainer", ci: e?.ci ?? null, mergeable: e?.mergeable ?? null };
      }),
    });
    for (const m of members) {
      await jobItem(db, repo, m.number, `merged in batch ${b.branch}`, log);
      s.merged.push(m.number);
    }
    landed += members.length;
    params.onMerged?.(landed);
    log(`  ${b.branch}: merged ${members.length} PR${members.length === 1 ? "" : "s"}`);
  }

  /**
   * The batch PR's red CI against main at the batch's base (src/mainci/no-new.ts), read now when due: the comparison row, null when none
   * applies (that head is not red with the failing checks), or "wait" while a log is read again after its backoff.
   */
  async function vsMain(b: BatchView, ch: PrChecks): Promise<VsMainRow | null | "wait"> {
    const red = await baseRed(db, repo, b.base_sha);
    const optional = await optionalChecks(db, repo);
    const failing = ch.checks.filter((c) => c.state === "failure" && !optional.includes(c.name)).map((c) => c.name);
    const prev = await loadVsMainAt(db, repo, ch.number, ch.head_oid);
    const st = vsMainStatus({ failing, red, row: prev, now: d.now().getTime() });
    if (st.skip) return null;
    const row = st.due ? (await judgeHead(db, gh, { repo, number: ch.number, head: ch.head_oid, failing, red: red!, prev, now: d.now() })).row : st.row;
    if (row && row.state !== "unread") log(`  ${b.branch}: CI compared with ${branch}'s at the base: ${row.state}${row.reason ? ` (${row.reason})` : ""}`);
    return !row || row.state === "unread" ? "wait" : row;
  }

  async function land(b: BatchView, members: BatchMember[], q: QueueEntry[]): Promise<void> {
    // One query for the batch PR and its members: the members must still be open at the head that was batched.
    const checks = await refreshChecks(db, d.querier, repo, [b.pr_number!, ...members.map((m) => m.number)]);
    const ch = checks.find((c) => c.number === b.pr_number);
    if (!ch) { s.waiting.push(b.branch); return; }
    if (ch.state === "MERGED") return await bookLanded(b, members, q);
    // A control (stop, remove) may have ended the batch while the checks were read; it closes the PR itself.
    if ((await getBatch(db, b.id)).state !== "open") { log(`  ${b.branch}: ended meanwhile; left alone`); return; }
    if (ch.state === "CLOSED") {
      // Our own closes mark the batch first, so a closed active batch was closed by a person: hold its PRs for their current heads.
      await db.write(async () => {
        await updateBatch(db, b.id, at(), { state: "failed", summary: CLOSED_BY_PERSON });
        await addStageEvents(db, members.map((m) => stageRow(m.number, "hold", `the batch PR ${b.branch} was closed; held at ${short(m.head_oid)}`)));
      });
      s.failed.push(...members.map((m) => m.number));
      log(`  ${b.branch}: the batch PR was closed; its PRs are held until they change`);
      return;
    }
    const live = members.filter((m) => checks.some((c) => c.number === m.number && c.state === "OPEN" && !c.is_draft && c.head_oid === m.head_oid));
    if (live.length < members.length) return supersede(b, live, "a PR in the batch was closed, merged, pushed to or turned into a draft");
    let ci = await ciNow(db, repo, ch, b.base_sha);
    let vs: VsMainRow | null = null;
    if (ci === "failure") {
      // While main is red, the batch PR's failing checks are compared with main's: failures only where main fails let it merge.
      const judged = await vsMain(b, ch);
      if (judged === "wait") { s.waiting.push(b.branch); return; }
      vs = judged;
      if (vs?.state === "not-new") ci = await ciNow(db, repo, ch, b.base_sha);
    }
    if (ci === "failure") return red(b, members, ch.checks.filter((c) => c.state === "failure").map((c) => c.name), vs);
    if (ch.mergeable === "CONFLICTING") return supersede(b, members, `the batch PR conflicts with ${branch}`);
    const moved = await movedAway(b);
    if (moved) return supersede(b, members, moved);
    if (members.length > left()) { log(`  ${b.branch}: ${members.length} PRs exceed the ${Math.max(left(), 0)} left of the daily limit; waits`); s.waiting.push(b.branch); return; }
    // CI still running (neither red nor green): the PRs that became eligible since it started may join, once.
    if (ci !== "success" && await topUp(b)) return;
    if (ci !== "success" || ch.mergeable !== "MERGEABLE") {
      // A fork's runs wait for a maintainer's approval; the ci-approve step does it where the repo allows, and the note says so until the runs started.
      const waiting = (await loadRunApprovals(db, [{ repo, number: b.pr_number! }])).get(`${repo}#${b.pr_number}@${b.commit_sha}`);
      const note = waiting && (waiting.runs.length || waiting.reread) ? RUNS_WAIT_NOTE : null;
      if ((b.summary ?? null) !== note) await updateBatch(db, b.id, at(), { summary: note });
      s.waiting.push(b.branch);
      return;
    }
    const info = await prInfo(d.querier, repo, b.pr_number!);
    if (!info) { s.waiting.push(b.branch); return; }
    if (info.head !== b.commit_sha) { log(`  ${b.branch}: the batch branch moved from ${short(b.commit_sha)} to ${short(info.head)}; not merged`); s.waiting.push(b.branch); return; }
    if (info.baseRef !== branch) { log(`  ${b.branch}: the batch PR's base is ${info.baseRef}, not ${branch}; not merged`); s.waiting.push(b.branch); return; }
    // The batch PR is ours but a maintainer may review it too.
    const own = await liveGateChecked(db, d.querier, repo, b.pr_number!, "", log);
    if (own === null) { s.waiting.push(b.branch); return; }
    if (own.blocked) {
      if ((await getBatch(db, b.id)).state !== "open") { log(`  ${b.branch}: ended meanwhile; left alone`); return; }
      // Rebuilding would only open a new PR around the review: the batch fails and its PRs wait for a new head.
      await db.write(async () => {
        await updateBatch(db, b.id, at(), { state: "failed", summary: BLOCKED_BY_REVIEW });
        await addStageEvents(db, members.map((m) => stageRow(m.number, "hold", `the batch PR ${b.branch} has changes requested; held at ${short(m.head_oid)}`)));
      });
      await closePr(b, `Closing: ${own.blocked}. The PRs in it are held until they change.`);
      s.failed.push(...members.map((m) => m.number));
      log(`  ${b.branch}: ${own.blocked}; its PRs are held until they change`);
      return;
    }
    const mirror = await loadItems(db, members.map((m) => ({ repo, number: m.number })), "pr");
    for (const m of members) {
      // A member retargeted or reviewed again against another base since the batch was built: what lands is no longer what its review read.
      const mirrored = mirror.get(refOf(m.number))?.base_ref ?? branch;
      const baseWhy = mirrored !== branch ? `its base branch is ${mirrored}, not ${branch}` : await baseRefusal(db, repo, m.head_oid, m.number, branch);
      if (baseWhy) return supersede(b, members.filter((x) => x !== m), `${refOf(m.number)} left the batch: ${baseWhy}`);
      const gate = await liveGateChecked(db, d.querier, repo, m.number, m.head_oid, log);
      if (gate === null) { s.waiting.push(b.branch); return; }
      if (gate.blocked) return supersede(b, members.filter((x) => x !== m), `a PR in the batch has a review: ${gate.blocked}`);
      if (gate.moved) return supersede(b, members.filter((x) => x !== m), "a PR in the batch has new comments or reviews to be reviewed first");
    }
    const mays = await mayLand(b, members);
    if (!mays) return;
    // A member a person approved needs that person's write access, read now.
    const approvers = await approversGone(mays);
    if (approvers.gone.length) {
      if ((await getBatch(db, b.id)).state !== "open") { log(`  ${b.branch}: ended meanwhile; left alone`); return; }
      await addAudit(db, approvers.gone.map((x) => ({ login: ACTOR, action: "batch-remove", target: refOf(x.number), details: { run: runId, batch: b.branch, reason: x.why } })));
      return supersede(b, members.filter((m) => !approvers.gone.some((x) => x.number === m.number)), `${approvers.gone.map((x) => refOf(x.number)).join(", ")} left the batch: ${approvers.gone[0]!.why}`);
    }
    if (approvers.unsure) { log(`  ${b.branch}: GitHub could not confirm the write permission of who approved a PR in it; not merged this pass`); s.waiting.push(b.branch); return; }
    // A control may have ended the batch during the calls above: look again right before merging.
    if ((await getBatch(db, b.id)).state !== "open") { log(`  ${b.branch}: ended meanwhile; not merged`); return; }
    // A fix-up or CI fix pushing to a member would move its head under the merge: hold the members' leases until it ends.
    const leases: (() => Promise<void>)[] = [];
    for (const m of members) {
      const release = await leaseItem(db, `pr:${repo}#${m.number}`, log);
      if (!release) { for (const f of leases) await f(); log(`  ${b.branch}: a PR in the batch is being worked; not merged this pass`); s.waiting.push(b.branch); return; }
      leases.push(release);
    }
    try {
      let after: Awaited<ReturnType<typeof refreshChecks>>[number] | undefined;
      // Every member must still hold at its batched head, and the batch PR at the batch tip.
      const g = await guardBatchMerge(db, { repo, number: b.pr_number!, head: b.commit_sha }, members.map((m) => ({ number: m.number, head: m.head_oid })), by, liveRead);
      if ("refused" in g) { log(`  ${b.branch}: not merged: ${g.refused}`); s.waiting.push(b.branch); return; }
      const r = await mergeViaCommand(w, d.run, d.mergeCommand, g, { method: "merge", extra: await allowFailedArgs(db, repo, d.mergeCommand, { number: b.pr_number!, head: b.commit_sha, base: b.base_sha }) }, { run: runId, head: b.commit_sha, batch: b.branch }, async () => {
        after = (await refreshChecks(db, d.querier, repo, [b.pr_number!]))[0];
        return after?.state === "MERGED";
      });
      if (r.code !== 0) {
        // The merge may have gone through although the command failed afterwards.
        if (after?.state === "MERGED") return await bookLanded(b, members, q);
        const why = (oneLine(r.stderr) || oneLine(r.stdout) || `exit code ${r.code}`) + await commandNote(db, repo, d.mergeCommand, { number: b.pr_number!, head: b.commit_sha, base: b.base_sha });
        await updateBatch(db, b.id, at(), { summary: `${d.mergeCommand}: ${why}`.slice(0, 400) });
        log(`  ${b.branch}: refused: ${why}`);
        s.waiting.push(b.branch);
        return;
      }
      // The merge command prints `<repo>#<pr> MERGED <merge commit>`.
      await bookLanded(b, members, q, /\bMERGED ([0-9a-f]{7,40})\b/.exec(r.stdout)?.[1] ?? null);

    } finally {
      for (const f of leases) await f();
    }
  }

  /** Reads the build task of a batch that has no PR yet: opens the PR when it passed, fails the batch when the tree is red, waits or fails open otherwise. */
  async function readBuild(b: BatchView, members: BatchMember[]): Promise<void> {
    const open = async (why?: string) => { if (why) await skipBuild(b, why); return publish(await getBatch(db, b.id), members); };
    const task = b.task_id === null ? null : await getTask(db, b.task_id);
    if (!task) return open("the build task is gone");
    if (!TERMINAL.includes(task.state)) {
      if (d.now().getTime() - Date.parse(task.queuedAt) <= BUILD_MAX_MS) { s.waiting.push(b.branch); return; }
      await cancelBuild(db, b, ACTOR);
      return open("the build took longer than 3 hours");
    }
    const out = outcomeOf(task);
    const tries = b.build_tries ?? 0;
    if (out.kind === "pass") {
      await updateBatch(db, b.id, at(), { build_state: "passed" });
      return open();
    }
    if (out.kind === "fail") {
      // One rerun of a failed test step tells a flake from a red tree.
      if (out.step === "test" && tries < 2) {
        await updateBatch(db, b.id, at(), { task_id: await cloneTask(db, task.id), build_tries: tries + 1 });
        log(`  ${b.branch}: the test step failed; queued the build again to rule out a flake`);
        s.waiting.push(b.branch);
        return;
      }
      await updateBatch(db, b.id, at(), { build_state: "failed" });
      const text = scrub(await failureTail(db, task.id, out.step));
      const traced = await traceOf(b, members, text);
      if (traced) return drop(await getBatch(db, b.id), members, traced, `the combined tree failed at ${out.step}`);
      const tail = oneLine(text, 150);
      return fail(await getBatch(db, b.id), `the combined tree failed at ${out.step}${tail ? `: ${tail}` : ""}`);
    }
    // A build-environment error says nothing about the PRs: try again with growing waits, then open the PR anyway; never split or hold.
    if (tries >= MAX_BUILD_TRIES) return open(`${out.reason} (${tries} tries)`);
    if (d.now().getTime() - Date.parse(b.updated_at) < retryDelayMs(tries - 1)) { s.waiting.push(b.branch); return; }
    await updateBatch(db, b.id, at(), { task_id: await cloneTask(db, task.id), build_tries: tries + 1 });
    log(`  ${b.branch}: ${out.reason}; queued the build again (try ${tries + 1})`);
    s.waiting.push(b.branch);
  }

  /**
   * Called by `land` while the open batch's CI runs (neither red nor green): when the batch's first PR opened less than
   * TOPUP_WINDOW_MS ago, the batch is rebuilt with the PRs a new batch would take now, if it really grows by one. At most
   * once per lineage: the batch a top-up builds, and every rebuild of it, is marked. A passed build or a publish that had
   * to be retried is not thrown away for it. True: the batch was replaced.
   */
  async function topUp(b: BatchView): Promise<boolean> {
    if (Number(b.topped_up ?? 0) === 1 || !b.opened_at || b.build_state === "passed" || b.retries > 0) return false;
    if (d.now().getTime() - Date.parse(b.opened_at) >= TOPUP_WINDOW_MS) return false;
    const { taken, reserved } = await batched(b.members, b.id);
    const pool = await eligibleNow(taken, reserved);
    if (!pool.cands.length) return false;
    const members = await sizedCands(b.members);
    if (!pool.cands.some((c) => admits(members, c, pool.max))) return false;
    const next = await chainOf(members, left() - reserved, { extra: { cands: pool.cands, max: pool.max } });
    // Every member must still go in, and at least one new PR, or the open batch is left as it is.
    if (!next.chain.some((x) => x.extra) || next.chain.filter((x) => !x.extra).length < b.members.length) return false;
    await supersede(b, b.members, `rebuilt to take the PRs that became eligible in the first ${TOPUP_WINDOW_MS / 60_000} minutes of its CI`, b.members, next);
    return true;
  }

  async function advance(id: number, q: QueueEntry[]): Promise<void> {
    const b = await getBatch(db, id);
    if (!ACTIVE_BATCH.includes(b.state)) return;
    const members = b.members;
    // The batch state overrides a PR's own only while it would still be mergeable (see BATCHABLE), and its merge path must still exist.
    const keep = members.filter((m) => q.some((e) => e.number === m.number && e.head === m.head_oid && e.path !== null && (e.state === "batch-checking" || e.state === "in-batch")));
    if (keep.length < members.length) return supersede(b, keep, "a PR in the batch changed or is no longer ready");
    if (b.state === "open") return land(b, members, q);
    if (b.state === "checking" && b.build_state === "pending") {
      if (await featureOn(db, "batch-build", repo)) return readBuild(b, members);
      // The switch went off while the build was in flight: the PR opens without it.
      await cancelBuild(db, b, ACTOR);
      await skipBuild(b, "Build batches was switched off");
      return publish(await getBatch(db, b.id), members);
    }
    // A checking batch has no PR yet: its push or PR creation failed earlier, so it is tried again once the wait is over.
    if (d.now().getTime() - Date.parse(b.updated_at) < publishDelayMs(b.retries)) { s.waiting.push(b.branch); return; }
    return publish(b, members);
  }

  const first = await batchesNow();
  // One queue read for the run: each batch's effects re-read its own row before they write.
  if (first.mine.length) {
    const q = await buildQueue(db, { repo, merged: "exclude" });
    for (const b of first.mine) await advance(b.id, q);
  }
  // A batch in a repo whose pipeline is off loses its place when a PR in it has no live workflow any more: it is only closed, never advanced, also in a repo with no work left.
  for (const b of first.outside) await supersede(b, [], "a PR in the batch has no live workflow and the repo's pipeline is off", b.members);

  if (!(await batchesNow()).mine.length) {
    const pool = await eligibleNow(new Set());
    if (pool.backoff !== null) {
      log(`merge ${repo}: ${pool.due} PRs may merge; the next batch starts after ${new Date(pool.backoff).toISOString()}, as the last batches could not be published`);
    } else if (pool.cands.length) {
      log(`merge ${repo}: ${pool.cands.length} PRs may merge; batch of up to ${pool.max}`);
      await startBatch(pool.cands, pool.max, null);
    }
  }
  log(`merge ${repo}: ${s.merged.length} merged, ${s.started.length} batches started, ${s.published.length} opened, ${s.split.length} split, ${s.superseded.length} rebuilt, ${s.waiting.length} waiting; run ${runId}`);
  return s;
}

export const commands = {
  "merge-batches": {
    summary: "merge-batches --repo R [--limit N]: advance the repo's integration batches and start the next one (each PR needs merge approval)",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo"), l = args.indexOf("--limit");
      if (i < 0 || !args[i + 1]) throw new Error("missing --repo");
      await runBatches(await openDb(), { repo: args[i + 1]!, ...(l >= 0 ? { limit: Number(args[l + 1]) } : {}) });
    },
  },
};
