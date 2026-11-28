// Stage 6, Integrate (first part): merges the queued PRs that may merge, one at a time, through the configured
// merge command. No model calls.
//
//   autocraft-server merge --repo R [--limit N] [--apply]
//
// Without --apply it is a dry run: it reads the local tables only, calls nothing and writes nothing.
import { baseRefusal, recordLiveBase } from "./base.ts";
import { inRepoScope } from "../runner/scope.ts";
import { mergeVerdicts } from "./approval.ts";
import { DRAFT_REFUSAL } from "./safe-merge.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mayRun } from "../core/authority.ts";
import { ciAt, type CiState } from "../core/evidence.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { guard, guardRepo, liveOf } from "../core/guard.ts";
import { planned } from "../core/select.ts";
import { NO_WORKFLOW_SCORE } from "../core/work-score.ts";
import { claimForWork } from "../github/claim.ts";
import { pipelineMe } from "../github/pipeline-account.ts";
import { mergeViaCommand, MERGE_RECORDED_ENV, type Writer } from "../github/write.ts";
import { Client, type Querier } from "../mirror.ts";
import { refreshChecks, type PrChecks } from "../review/checks.ts";
import { readGate } from "./changes-requested.ts";
import { liveGateChecked } from "../review/discussion.ts";
import { buildQueue, countStates, QUEUE_STATES, ciAllows, verifyAllows, type QueueEntry } from "./queue.ts";

export { buildQueue, countStates, QUEUE_STATES, type QueueEntry, type QueueState } from "./queue.ts";
import { envVar } from "../env.ts";
import { optionalChecks } from "../optional-checks.ts";
import { mainsFailuresAt } from "../mainci/no-new.ts";
import { jobItem } from "../runner/job-items.ts";
import { authFailure, laneForOperator, noWriteReason, SIGN_IN_REASON, type Lane, type LaneDeps } from "../github/user-lane.ts";
import { ownerOf } from "../owners.ts";
import { readEnvFor } from "../github/read.ts";
import { addAudit } from "../data/control/index.ts";
import { loadRunApprovals, recordAttempts, verificationOf } from "../data/merge/index.ts";
import type { AttemptInput } from "../data/merge/types.ts";
import { addStageEventsOnce } from "../data/planner/index.ts";
import { loadActions, loadPrWorkflows, loadWorkScores, queueActions, saveActions, type ActionState } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

/** Name of the built-in guarded merge (`autocraft-server safe-merge`); any other `$AUTOCRAFT_MERGE_CMD` is run as an external command that must accept `--head <sha>` and refuse when the PR head differs. */
export const DEFAULT_MERGE_COMMAND = "safe-merge";

/**
 * `--allow-failed` for each optional check of the repo and each check of PR `at` that fails only where the red default branch fails
 * (src/mainci/no-new.ts), only for the built-in command (another command may not know the flag).
 */
export async function allowFailedArgs(db: Db, repo: string, cmd: string, at: { number: number; head: string }): Promise<string[]> {
  return cmd === DEFAULT_MERGE_COMMAND ? (await allowedFailures(db, repo, at.number, at.head)).flatMap((n) => ["--allow-failed", n]) : [];
}

/** The checks whose failure does not stop PR `number` at `head`: the repo's optional checks and those that fail only where the red main fails. */
async function allowedFailures(db: Db, repo: string, number: number, head: string): Promise<string[]> {
  const [optional, mains] = await db.together(() => Promise.all([optionalChecks(db, repo), mainsFailuresAt(db, repo, number, head)]));
  return [...new Set([...optional, ...mains])];
}
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const ACTOR = "merge";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type MergeDeps = {
  querier: Querier;
  /** Runs the merge command; throws only when it can't be started. */
  run: (cmd: string, args: string[], env?: Record<string, string>) => Promise<CommandResult>;
  now: () => Date;
  /** The user lane's token source and transports; default: the secrets file's app. */
  lane?: LaneDeps;
  /** `$AUTOCRAFT_MERGE_CMD`, default the built-in `safe-merge`. */
  mergeCommand: string;
};

export type MergeParams = {
  repo: string;
  /** Most merges to attempt in this run. */
  limit?: number;
  /** Default true: only `dryRun: false` merges, assigns or asks. */
  dryRun?: boolean;
  /** Only PRs this accepts are merged. */
  only?: (e: QueueEntry) => boolean;
  /** Only the PRs whose merge action is single-only are merged (the rest are left to the integration batches). */
  singleOnly?: boolean;
  /** Stop at the first PR that is refused; the rest wait for the next round. */
  stopOnRefusal?: boolean;
  /** Called with the running count of PRs merged, after each merge. */
  onMerged?: (merged: number) => void;
  /** Who asked; default: an operator at the command line. */
  by?: By;
};

export type MergeSummary = {
  runId: string; repo: string; dryRun: boolean;
  states: Record<string, number>;
  /** PRs tried (or, in a dry run, that would be). */
  attempted: string[]; merged: string[]; refused: { ref: string; reason: string }[];
};

export async function spawnRun(cmd: string, args: string[], env?: Record<string, string>, replaceEnv = false): Promise<CommandResult> {
  // Without an environment of its own, a gh command reads and writes as the current identity (the app's token under `app`).
  const own = env ? undefined : await readEnvFor(cmd, args);
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: own ?? (env ? (replaceEnv ? env : { ...process.env, ...env }) : process.env) });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Runs the merge command; the built-in name runs `autocraft-server safe-merge` from this checkout. */
export function mergeRun(cmd: string, args: string[], env?: Record<string, string>): Promise<CommandResult> {
  // With `env` (a user's token set) the child gets exactly that environment: no box token is left in it.
  return cmd === DEFAULT_MERGE_COMMAND ? spawnRun(process.execPath, ["--no-warnings", CLI, "safe-merge", ...args], { ...env, [MERGE_RECORDED_ENV]: "1" }, !!env) : spawnRun(cmd, args, env, !!env);
}

export function defaultDeps(): MergeDeps {
  return { querier: new Client(1000), run: mergeRun, now: () => new Date(), mergeCommand: envVar("MERGE_CMD") || DEFAULT_MERGE_COMMAND };
}

const refOf = (e: { repo: string; number: number }) => `${e.repo}#${e.number}`;
const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);

// ---- GitHub reads ----

export type PrInfo = { id: string; head: string; state: string; assignees: string[]; authors: number; commits: number; baseRef: string };

export const PR_INFO_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      id headRefOid baseRefName state
      assignees(first: 10) { nodes { login } }
      commits(first: 100) { totalCount nodes { commit { authors(first: 10) { nodes { email name user { login } } } } } }
    }
  }
}`;

type InfoNode = {
  id: string; headRefOid: string; baseRefName: string; state: string; assignees?: { nodes?: { login: string }[] };
  commits?: { totalCount: number; nodes?: { commit?: { authors?: { nodes?: { email?: string | null; name?: string | null; user?: { login: string } | null }[] } } }[] };
};

export async function prInfo(q: Querier, repo: string, n: number): Promise<PrInfo | null> {
  const d = await q.query(PR_INFO_QUERY, { owner: ownerOf(repo), name: repo, n }) as { repository?: { pullRequest?: InfoNode | null } };
  const p = d.repository?.pullRequest;
  if (!p) return null;
  const who = new Set<string>();
  for (const c of p.commits?.nodes ?? [])
    for (const a of c.commit?.authors?.nodes ?? []) who.add(a.user?.login ? `@${a.user.login}` : (a.email || a.name || "?").toLowerCase());
  return {
    id: p.id, head: p.headRefOid, state: p.state, assignees: (p.assignees?.nodes ?? []).map((a) => a.login),
    authors: who.size, commits: p.commits?.totalCount ?? 0, baseRef: p.baseRefName,
  };
}

/** Squash keeps one author; a PR with commits by several (or more commits than we can read) is merged as is. */
export const methodOf = (info: PrInfo): "squash" | "merge" => (info.authors > 1 || info.commits > 100 ? "merge" : "squash");


/**
 * CI of a PR whose checks were just read, by the planner's rule (ciAt): without the repo's optional checks and the checks that fail only
 * where the red main fails, and pending while runs we approved are unfinished.
 */
export async function ciNow(db: Db, repo: string, ch: PrChecks): Promise<CiState> {
  const [optional, runs] = await db.together(() => Promise.all([allowedFailures(db, repo, ch.number, ch.head_oid), loadRunApprovals(db, [{ repo, number: ch.number }])]));
  return ciAt(ch, ch.head_oid, { optional, approvedRuns: runs.get(`${repo}#${ch.number}@${ch.head_oid}`)?.approved.length ?? 0 });
}

// ---- the step ----------------------------------------------------------------

export async function runMerge(db: Db, params: MergeParams, log: (line: string) => void = console.log, deps?: MergeDeps): Promise<MergeSummary> {
  const { repo } = params;
  const w: Writer = { db, login: ACTOR };
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const runId = `merge-${repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`;
  if (!await inRepoScope(db, repo, "work")) {
    log(`merge ${repo}: not in the pipeline scope; nothing done`);
    return { runId, repo, dryRun, states: {}, attempted: [], merged: [], refused: [] };
  }
  const d = deps ?? defaultDeps();
  // A PR in changes-requested is read live again each run: the mirror alone can block wrongly (the association is relative to the viewer) and a blocked PR never reaches the merge-time read.
  if (!dryRun) for (const e of await buildQueue(db, { repo, merged: "exclude" })) if (e.state === "changes-requested") await readGate(db, d.querier, ownerOf(repo), repo, e.number, log);
  const queue = await buildQueue(db, { repo });
  const open = queue.filter((e) => e.state !== "merged");
  const states = countStates(queue);
  const by = params.by ?? CLI_BY;
  const mays = (await planned(db, "merge", { repo, refused: true })).map((p) => ({ p, may: mayRun(p, by) }));
  const due = mays.flatMap(({ p, may }) => (may.ok ? [p] : []));
  const mergeDue = new Map(due.map((p) => [p.facts.number, { singleOnly: p.action.params?.singleOnly === true, verifyOverride: p.facts.verifyOverride }]));
  const scores = await loadWorkScores(db, open.map((e) => ({ repo, number: e.number })));
  const score = (e: QueueEntry) => scores.get(refOf(e)) ?? NO_WORKFLOW_SCORE;
  // In work order (src/core/work-score.ts), unstarted PRs by number.
  let picks = open.filter((e) => mergeDue.has(e.number) && (!params.only || params.only(e)) && (!params.singleOnly || mergeDue.get(e.number)!.singleOnly))
    .sort((a, b) => score(b) - score(a) || a.number - b.number);
  if (params.limit !== undefined) picks = picks.slice(0, params.limit);
  const summary: MergeSummary = { runId, repo, dryRun, states, attempted: [], merged: [], refused: [] };
  log(`merge ${repo}: ${queue.length} in the queue (${QUEUE_STATES.filter((s) => states[s]).map((s) => `${states[s]} ${s}`).join(", ") || "none"})`);
  for (const { p, may } of mays) if (!may.ok) log(`  ${refOf(p.facts)}: left out: ${may.why.text}`);

  if (dryRun) {
    summary.attempted = picks.map(refOf);
    for (const e of picks) log(`  would merge ${refOf(e)} at ${short(e.head)} (${e.path === "rule" ? "by the rule" : "approved by a person"})`);
    log(`merge ${repo}: dry run, nothing called or written`);
    return summary;
  }

  // Every taken PR in the queue gets one `batched` stage row per head.
  const now = at();
  await addStageEventsOnce(db, open.map((e) => ({ repo: e.repo, number: e.number, stage: "batched", at: now, actor: ACTOR, note: `queued at ${short(e.head)}: ${e.state}`, notePrefix: `queued at ${short(e.head)}` })));

  // What GitHub reported for the PR being tried, once known; a refusal records it so the autopilot retries only when it changes.
  let seen: { ci: string; mergeable: string } | null = null;
  const attempt = (e: QueueEntry, method: string | null, outcome: "merged" | "refused", reason: string | null): AttemptInput => ({
    repo: e.repo, number: e.number, head: e.head, runId, at: at(), path: e.path === "rule" ? "rule" : "maintainer", method, outcome, reason,
    ci: seen?.ci ?? e.ci, mergeable: seen?.mergeable ?? e.mergeable,
    ...(outcome === "merged" ? { note: `${method ?? "merge"} at ${short(e.head)}${e.path === "rule" ? "" : ", approved by a person"}` } : {}),
  });
  const refuse = async (e: QueueEntry, method: string | null, reason: string) => {
    // A refusal for `action_required` also marks the head for a read of its workflow runs.
    await recordAttempts(db, [attempt(e, method, "refused", reason)]);
    summary.refused.push({ ref: refOf(e), reason });
    log(`  ${refOf(e)}: refused: ${reason}`);
  };

  // One PR at a time; any error that isn't a refusal stops the run.
  for (const e of picks) {
    if (params.stopOnRefusal && summary.refused.length) break;
    // Asked again now: a repo switch turned off or a workflow that stopped since the plan was made leaves the PR alone.
    const may = (await mergeVerdicts(db, repo, [{ number: e.number, head: e.head }])).get(e.number)!;
    if (!may.ok) { log(`  ${refOf(e)}: not merged: ${may.why.text}`); continue; }
    // A merge a person approved is made as that person, with their token, in a repo on the app's identity.
    let lane: Lane | null = null;
    if (may.as !== "app") {
      const approver = may.as.slice("user:".length);
      const lr = await laneForOperator(db, d.lane, approver, [repo]);
      if (lr && !("lane" in lr)) {
        if (!("transient" in lr)) await noteMergeAction(db, repo, e, approver, lr.state, lr.reason);
        log(`  ${refOf(e)}: ${"transient" in lr ? `not merged yet: ${lr.transient}` : `waiting: ${lr.reason}`}`);
        continue;
      }
      if (lr) { lane = lr.lane; await noteMergeAction(db, repo, e, approver, "pending", null); }
    }
    summary.attempted.push(refOf(e));
    seen = null;
    const [ch] = await refreshChecks(db, d.querier, repo, [e.number]);
    // GitHub often has no mergeable state yet right after a merge: end the round without a refusal on record.
    if (params.stopOnRefusal && summary.merged.length && ch?.state === "OPEN" && ch.mergeable === "UNKNOWN") { log(`  ${refOf(e)}: GitHub has not computed its mergeable state yet; left for the next round`); summary.attempted.pop(); break; }
    if (!ch) { await refuse(e, null, "GitHub returned no such PR"); continue; }
    const ci = await ciNow(db, repo, ch);
    seen = { ci, mergeable: ch.mergeable ?? "UNKNOWN" };
    if (ch.state !== "OPEN") { await refuse(e, null, `no longer open on GitHub (${ch.state.toLowerCase()})`); continue; }
    if (ch.head_oid !== e.head) { await refuse(e, null, `head moved from ${short(e.head)} to ${short(ch.head_oid)} since the review`); continue; }
    // Not a refusal: the PR goes on once it is marked ready for review.
    if (ch.is_draft) { log(`  ${refOf(e)}: a draft; not merged until it is marked ready for review`); continue; }
    const ver = await verificationOf(db, repo, e.number, ch.head_oid);
    if (!verifyAllows(e.path, ver?.state, mergeDue.get(e.number)!.verifyOverride)) { await refuse(e, null, `verification at ${short(ch.head_oid)} is ${ver?.state ?? "missing"}, not passed`); continue; }
    if (!ciAllows(ci) || ch.mergeable !== "MERGEABLE") {
      await refuse(e, null, `not ready at merge time: CI ${ci}, mergeable ${(ch.mergeable ?? "unknown").toLowerCase()}`);
      continue;
    }
    const info = await prInfo(d.querier, repo, e.number);
    if (!info) { await refuse(e, null, "GitHub returned no such PR"); continue; }
    if (info.head !== e.head) { await refuse(e, null, `head moved from ${short(e.head)} to ${short(info.head)} since the review`); continue; }
    const baseWhy = await baseRefusal(db, repo, e.head, e.number, info.baseRef);
    // A retargeted PR is not a refusal either: the mirror takes the live base. A review that read another one is stale then and made again;
    // off the default branch the PR waits for a person.
    if (baseWhy) { await recordLiveBase(db, repo, e.number, e.head, info.baseRef); log(`  ${refOf(e)}: ${baseWhy}; not merged`); continue; }
    // Not a refusal: no merges row, so the queue keeps the PR and takes it up again once it is reviewed again.
    // The same read checks for a maintainer's changes-requested review, whatever merge command runs next.
    const gate = await liveGateChecked(db, d.querier, repo, e.number, e.head, log);
    if (gate === null) continue;
    if (gate.blocked) { log(`  ${refOf(e)}: ${gate.blocked}; not merged`); continue; }
    if (gate.moved) {
      await addAudit(db, [{ login: ACTOR, action: "merge-held-for-discussion", target: refOf(e), details: { run: runId, head: e.head, path: e.path } }]);
      log(`  ${refOf(e)}: new comments or reviews since the final review; not merged, it is reviewed again first`);
      continue;
    }
    const ag = await guardRepo(db, repo, "merge", by, undefined, { members: [may] });
    if ("refused" in ag) log(`  ${refOf(e)}: not assigned: ${ag.refused}`);
    else await claimForWork(w, ag, d.querier, repo, e.number, "pr", () => pipelineMe(log), { run: runId }, log);
    const method = methodOf(info);
    const g = await guard(db, { repo, number: e.number }, { kind: "merge", head: e.head }, by, liveOf(db, d.querier));
    if ("refused" in g) {
      // Not recorded as a merge attempt: the PR is tried again once the reason is gone.
      summary.refused.push({ ref: refOf(e), reason: g.refused });
      log(`  ${refOf(e)}: not merged: ${g.refused}`);
      continue;
    }
    // The merge's own audit row is written by mergeViaCommand.
    const r = await mergeViaCommand(w, d.run, d.mergeCommand, g, { method, extra: await allowFailedArgs(db, repo, d.mergeCommand, { number: e.number, head: e.head }) }, { run: runId, head: e.head, path: e.path }, undefined, lane?.env);
    if (r.code !== 0) {
      const why = oneLine(r.stderr) || oneLine(r.stdout) || `exit code ${r.code}`;
      const denied = lane ? authFailure(new Error(why)) : null;
      if (denied) {
        // The approver's token may not merge (or GitHub answered with a transient error): no refusal is recorded, so the PR stays queued.
        if (denied !== "transient" && lane) await noteMergeAction(db, repo, e, lane.login, denied, denied === "waiting-token" ? SIGN_IN_REASON : noWriteReason(repo));
        log(`  ${refOf(e)}: ${denied === "transient" ? "not merged yet" : "waiting"}: ${why}`);
        summary.attempted.pop();
        continue;
      }
      if (why.includes(DRAFT_REFUSAL)) { log(`  ${refOf(e)}: turned into a draft; not merged`); continue; }
      await refuse(e, method, `${d.mergeCommand}: ${why}`);
      continue;
    }
    // The attempt row, the mirror's merged state and the `merged` stage row are written together. The merge already happened on
    // GitHub, so a failed write is tried once more before the error stops the run (a lost row would repeat the merge command, which `--head` guards).
    const landed = attempt(e, method, "merged", null);
    await recordAttempts(db, [landed]).catch(async (err) => {
      log(`  ${refOf(e)}: merged, but recording it failed (${oneLine(String((err as Error).message ?? err))}); trying again`);
      await recordAttempts(db, [landed]);
    });
    if (lane) await noteMergeAction(db, repo, e, lane.login, "done", null);
    await jobItem(db, e.repo, e.number, `merged by ${method} at ${short(e.head)}`, log);
    summary.merged.push(refOf(e));
    params.onMerged?.(summary.merged.length);
    log(`  ${refOf(e)}: merged (${method})`);
  }
  log(`merge ${repo}: ${summary.merged.length} merged, ${summary.refused.length} refused; run ${runId}`);
  return summary;
}

/**
 * The merge made as its approver, as the workflow's person action: it waits while the approver has no usable sign-in or no write
 * access (the workflow's state line shows it), and a waiting row goes back to pending once the lane opens and to done after the merge.
 * Only a wait creates the row; the other states update an existing one.
 */
async function noteMergeAction(db: Db, repo: string, e: QueueEntry, by: string, state: ActionState, reason: string | null): Promise<void> {
  const ref = { repo, number: e.number };
  const [workflows, actions] = await db.together(() => Promise.all([loadPrWorkflows(db, [ref]), loadActions(db, { refs: [ref] })]));
  const wf = workflows.get(`${repo}#${e.number}`);
  if (!wf) return;
  const at = new Date().toISOString();
  const row = actions.get(`${repo}#${e.number}`)?.find((a) => a.kind === "merge" && a.workflow_id === wf.id);
  if (state === "waiting-token" || state === "waiting-permission") {
    await db.write(async () => {
      // A row of an earlier head, approver or approval is stopped first, so the upsert takes it over.
      if (row && (row.head !== e.head || row.by !== by || row.updated_at < (wf.approvedAt ?? ""))) await saveActions(db, [{ id: row.id, state: "stopped", at }]);
      const id = (await queueActions(db, [{ workflowId: wf.id, repo, number: e.number, kind: "merge", by, head: e.head, state, at }])).get(`${repo}#${e.number}:merge`);
      if (id !== undefined) await saveActions(db, [{ id, state, reason, at }]);
    });
  } else if (row && row.state !== state && row.state !== "done") {
    await saveActions(db, [{ id: row.id, state, reason, at }]);
  }
}

function parseArgs(args: string[]): { repo: string; limit?: number; apply: boolean } {
  let repo: string | undefined, limit: number | undefined, apply = false, dry = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo") repo = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") dry = true;
    else throw new Error(`unknown option ${a}; options: --repo R --limit N --apply --dry-run`);
  }
  if (!repo) throw new Error("missing --repo");
  if (apply && dry) throw new Error("--apply and --dry-run exclude each other");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new Error("--limit is a whole number");
  return { repo, limit, apply };
}

export const commands = {
  merge: {
    summary: "merge --repo R [--limit N] [--apply]: merge queued PRs that may merge (dry run unless --apply)",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runMerge(await openDb(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  queue: {
    summary: "queue [--repo R]: the merge queue with each PR's state and verification",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo");
      const q = await buildQueue(await openDb(), { repo: i >= 0 ? args[i + 1] : undefined });
      const c = countStates(q);
      console.log(QUEUE_STATES.map((s) => `${s}: ${c[s]}`).join(", "));
      for (const e of q) console.log(`${refOf(e)}\t${e.state}\t${e.verdict}\t${e.size}\t${e.label ?? "-"}\t${e.ci}\t${e.mergeable}\t${e.verify?.state ?? "-"}\t${e.refusedReason ?? e.outsideRule.join("; ")}`);
    },
  },
};
