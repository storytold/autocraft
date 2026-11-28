// The only module that writes to GitHub. Every function performs the write
// and records it in the audit table itself, failed attempts included, so a
// caller cannot write without leaving a record. Writes to a pull request take a
// `Guarded` value that only core/guard.ts makes, so the compiler enforces that the
// guard ran right before. Transports (querier, exec, git, merge command) stay
// injected so tests fake them and assert the rows.
import type { Grant, Guarded, GuardedFiling, GuardedItem, GuardedRepo } from "../core/guard.ts";
import { auditIdentity, githubIdentity, identityFor, isOwnLogin, type WriteKind } from "./identity.ts";

/** The PR steps that push to a contributor's branch or ask on the PR where it is closed to us (`lint`: the collect step of a stored patch). */
export type AskKind = "fixup" | "conflict" | "cifix" | "lint";
/** What a comment write takes: a PR step's grant for its own kinds, or an item or repo grant (never a merge or CI grant). */
export type CommentGrant = Guarded<AskKind> | GuardedItem | GuardedRepo;
import type { Exec, ExecResult, Git } from "../fixup/git.ts";
import { Client, type Querier } from "../mirror.ts";
import { appChildEnv, AppNotInstalledError, installationToken, RepoNotInInstallationError, type TokenScope } from "./install-token.ts";
import { type Note, withNote } from "./note.ts";
import { isUnsent, markUnsent, rateLimited, refusedWrite, unclearWrite } from "./unsent.ts";
import { advisoryMade, byUs, commentMade, issueMade, nodeCommentMade, reviewMade, reviewReads, type GhRead } from "./made.ts";
import { scrub } from "../runner/scrub.ts";
import { ownerOf, slugOf, splitSlug } from "../owners.ts";
import { AppError, appJwt, call, GITHUB_API } from "./app.ts";
import type { AppOwner, AppSecrets } from "../dash/server/config.ts";
import { currentJobId } from "../agents/call.ts";
import { resumedRun } from "../runner/resuming.ts";
import { createHash } from "node:crypto";
import { giveaway } from "../security/rules.ts";
import { filterSeq, forEachSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { abandonWrites, addOwnCommits, addOwnPush, addPushOutcomes, beginWrite, finishWrite, landOwnPush, loadMadeBefore, loadPaceWaits, loadTakenWrites, loadWriteTries } from "../data/control/index.ts";
import { openDb } from "../db/open.ts";
import { effect } from "../db/effects.ts";

export { GITHUB_ACTIONS } from "./actions.ts";
export { unclearWrite } from "./unsent.ts";
export type { Note } from "./note.ts";

/** Who writes (the audit login: the stage name, or the operator for manual actions) and where the row goes. */
export type Writer = { db: Db; login: string; /** Replaces the clock (tests). */ now?: () => number; /** Replaces the pacing sleep (tests). */ sleep?: (ms: number) => Promise<void>; /** Replaces the installation-token minter (tests). */ mint?: (owner: string, repo: string, scope?: TokenScope) => Promise<string>; /** Replaces the app lane's GraphQL client (tests). */ appClient?: (env: Record<string, string>) => Pick<Querier, "query"> };
type Details = Record<string, unknown>;
type Retry = <T>(f: () => Promise<T>) => Promise<T>;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const direct: Retry = (f) => f();
/** The bare repo name of a `owner/repo` slug, as audit targets and items name it. */
const repoName = (slug: string): string => splitSlug(slug).name;
const refOf = (repo: string, number: number): string => `${repo}#${number}`;

/** Every grant a write takes; a filing grant only createBotIssue and labelBotIssue take. */
type AnyGrant = Guarded | Grant | GuardedFiling;

/** A grant covers writes to its own repo (and, for a PR or item grant, its own number); a write elsewhere is a bug. */
function covers(g: AnyGrant, repo: string, number?: number): void {
  if (g.repo !== repo || (number !== undefined && "number" in g && g.number !== number)) throw new Error(`the guard covers ${g.repo}${"number" in g ? `#${g.number}` : ""}, not ${repo}${number === undefined ? "" : `#${number}`}`);
}

/** A push to the pipeline's own branch and a new PR are made only under the grants of the steps that open the pipeline's own PRs. */
function opensOwnPr(g: Grant | Guarded<"implement">, repo: string): void {
  covers(g, repo);
  const ok = g.scope === "repo" ? g.need === "main-fix" || g.need === "merge" || g.need === "security" : g.action.kind === "implement";
  if (!ok) throw new Error(`a ${g.scope === "repo" ? `grant for ${g.need ?? "no approval"}` : `${g.action.kind} grant`} does not allow a push to a new branch or a new pull request`);
}

/**
 * Who a write is made as, for the audit row's `identity`: `legacy` while the grant's repo is on the box account, else
 * the grant's identity (src/github/identity.ts). Every write takes it from its grant, so none goes unmapped.
 */
const idOf = async (w: Writer, g: AnyGrant, kind: WriteKind = "other"): Promise<string> => await auditIdentity(w.db, g, kind);

/** The text a write puts on GitHub: the note line and the text, with anything that looks like a credential hidden. */
const posted = (note: Note, text: string): string => withNote(note, scrub(text));

// ---- identity lanes -------------------------------------------------------------
// A write made under a grant `as: "app"` while the GitHub identity is `app` runs with an installation token: gh and
// git children get a replaced environment (the box account's tokens are not in it) and GraphQL goes through a client
// with that environment. Every other write is unchanged: the box account's own credentials.
// A merge or close for a grant `as: user:<login>` belongs to the user lane (the person's own token): it never gets the
// app token, and the caller supplies the person's transport. Every other write of such a grant is the app's
// (`actsAsPerson` in identity.ts), whatever transport the caller passes.

/** Read before the request a lane is chosen for, so a failure of it sent nothing. */
const inAppLane = async (w: Writer, g: AnyGrant, kind: WriteKind = "other"): Promise<boolean> =>
  await githubIdentity(w.db).catch((e) => { throw markUnsent(e); }) === "app" && identityFor(g, kind) === "app";

/**
 * The child environment for a grant's repo, holding an installation token that reaches that repo only (and `scope`'s).
 * Never falls back to the box account: a failure is a clear error.
 */
async function appEnv(w: Writer, g: AnyGrant, scope?: TokenScope): Promise<Record<string, string>> {
  // A filing grant names its owner: a filing-only repo has no `repos` row.
  const owner = g.scope === "filing" ? g.owner : ownerOf(g.repo);
  try {
    return appChildEnv(await (w.mint ?? installationToken)(owner, g.repo, scope));
  } catch (e) {
    const fix = "install it on the repository or set the repository's identity back to legacy";
    if (e instanceof AppNotInstalledError) throw markUnsent(new AppNoAccessError(`app identity: the GitHub App is not installed on ${owner}; ${fix}`));
    if (e instanceof RepoNotInInstallationError) throw markUnsent(new AppNoAccessError(`app identity: ${owner}/${g.repo} is not in the GitHub App's installation; ${fix}`));
    throw markUnsent(new Error(`app identity: no installation token for ${owner}/${g.repo}: ${oneLine(String((e as Error).message ?? e))}`));
  }
}

/** The GitHub App's installation does not reach the repo (not installed on its owner, or the repo left out). */
export class AppNoAccessError extends Error {}

/** A failed command result for a mint failure: callers already handle a non-zero exit. No request went out, so it is marked not sent. */
const failedResult = (e: unknown): ExecResult => ({ code: 1, stdout: "", stderr: String((e as Error).message ?? e), sent: false });

async function laneExec(w: Writer, g: AnyGrant, exec: Exec, kind: WriteKind = "other"): Promise<Exec> {
  if (!await inAppLane(w, g, kind)) return exec;
  return async (cmd, args, opts) => {
    let env: Record<string, string>;
    try { env = await appEnv(w, g); } catch (e) { return failedResult(e); }
    return exec(cmd, args, { ...opts, env, replaceEnv: true });
  };
}

async function laneGit(w: Writer, g: Guarded | Grant, git: Pick<Git, "git">, scope?: TokenScope): Promise<Pick<Git, "git">> {
  if (!await inAppLane(w, g)) return git;
  return {
    git: async (args, opts) => {
      let env: Record<string, string>;
      try { env = await appEnv(w, g, scope); } catch (e) { return failedResult(e); }
      return git.git(args, { ...opts, app: { env } });
    },
  };
}

async function laneQuery(w: Writer, g: Guarded | Grant, q: Querier, kind: WriteKind = "other", scope?: TokenScope): Promise<Querier> {
  if (!await inAppLane(w, g, kind)) return q;
  return {
    query: async (query, variables) => (w.appClient ?? ((env) => new Client(0, env)))(await appEnv(w, g, scope)).query(query, variables),
    get spent() { return q.spent; },
    get remaining() { return q.remaining; },
  };
}

// ---- write pacing -----------------------------------------------------------
// GitHub limits content-creating requests per account (about 80 a minute, 500 an hour). Writes are paced per
// (identity, repo owner) under a margin, inside begin(), so every write path is covered. Operator presses (`user:`
// identities) are exempt.
export const PACE_PER_MINUTE = 60;
/** Bulk writes (the label writes of the labels-apply step, the PR status comments) start only while the key has used less than a share of each limit, so they leave room for the writes that move PRs. */
const BULK_ACTIONS = new Set(["labels-apply", "pr-status-comment", "pr-status-comment-edit"]);
/** The longest a write waits for the budget; past it the write is refused as paced and the caller retries later. */
export const PACE_MAX_WAIT_MS = 15_000;

/** The write was held back by pacing for longer than the bound and nothing was written or recorded. Retry later. */
export class WritePacedError extends Error {
  readonly retryable = true;
  readonly key: string;
  readonly waitMs: number;
  constructor(key: string, waitMs: number) {
    super(`write paced: the GitHub write budget for ${key} is used up; retry in ${Math.ceil(waitMs / 1000)} s`);
    this.name = "WritePacedError";
    this.key = key;
    this.waitMs = waitMs;
  }
}

/**
 * The key's owner: the owner of the repo the audit target names (`repo#number`, `repo:branch`, or an org name). The
 * box account (`legacy`) has one key for all owners, since GitHub limits a user token per account.
 */
function paceOwner(identity: string, target: string, owner?: string): string {
  if (identity === "legacy") return "";
  const name = target.split(/[#:]/)[0]!;
  return owner ?? (ownerOf(name) || name);
}

/**
 * How long the pipeline's write of `action` on each of `repos` (made as the app, or the box account while writes use it) waits for
 * the budget now; 0 when it may start. The planner reads it so it does not queue a job whose writes would be refused as paced.
 */
export async function pipelineWriteWaits(db: Db, action: string, repos: readonly string[], now: number = Date.now()): Promise<Map<string, number>> {
  if (!repos.length) return new Map();
  const identity = await githubIdentity(db) === "box" ? "legacy" : "app";
  const owners = new Map(repos.map((r) => [r, paceOwner(identity, r)] as const));
  const waits = await loadPaceWaits(db, [...new Set(owners.values())].map((owner) => ({ action, identity, owner })), now);
  return new Map(repos.map((r) => [r, waits.get(`${action}\t${identity}\t${owners.get(r)!}`) ?? 0]));
}

/** Adds the `started` row when the key is under budget (the module counts the key's rows of the last hour under the writer lock); else how long to wait before the window frees. */
async function tryBegin(w: Writer, action: string, target: string, details: Details, now: number, ownerArg?: string): Promise<{ id: number; paceOwner: string | null } | { wait: number }> {
  const identity = String(details.identity ?? "");
  const pace = identity.startsWith("user:") ? null : { identity, owner: paceOwner(identity, target, ownerArg), bulk: BULK_ACTIONS.has(action) };
  return await beginWrite(w.db, { at: new Date(now).toISOString(), login: w.login, action, target, details, pace });
}

/** The running job's id, joined to the audit row so a write can be traced to its job. Absent outside a job. */
const jobOf = (): { jobId?: number } => { const j = currentJobId(); return j === null ? {} : { jobId: j }; };

/** Audit rows of writes this process has begun and not yet finished, with what resolves when they finish. */
const inFlight = new Map<number, { done: Promise<void>; end: () => void; owner: string | null }>();
let stoppedWhy: string | null = null;
/**
 * Writes that finished whose caller has not asked for another write since: it may still be recording what the write did
 * (a review's row, a push's outcome). A stopping process waits a little for them (stopWrites).
 */
let owed = 0;
let wake: (() => void) | null = null;

/** How long a stopping process waits, once its writes in flight finished, for their callers to record what they did. */
const BOOKKEEPING_MS = 1000;

/**
 * Refuses writes from now on: a write asked for now is not made and its caller waits until the process exits (park), so no
 * caller records it as failed, and a resumed run makes it. Waits up to `ms` for the writes in flight to finish and be
 * recorded, so a stopped job leaves no write with an unknown outcome, then up to BOOKKEEPING_MS more for their callers'
 * bookkeeping, cut short once each has asked for its next write or `ended` resolves (the job's step returned). Returns how
 * many writes are still in flight.
 */
export async function stopWrites(why: string, ms: number, ended?: Promise<unknown>): Promise<number> {
  stoppedWhy = why;
  const end = Date.now() + ms;
  const until = async (p: Promise<unknown>, by: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([p, new Promise<void>((r) => { timer = setTimeout(r, Math.max(0, by - Date.now())); })]);
    clearTimeout(timer);
  };
  while (inFlight.size && Date.now() < end) await until(Promise.all([...inFlight.values()].map((f) => f.done)), end);
  if (inFlight.size) return inFlight.size;
  let over = false;
  void ended?.then(() => { over = true; wake?.(); });
  const quietBy = Math.min(end, Date.now() + BOOKKEEPING_MS);
  while (owed > 0 && !over && Date.now() < quietBy) await until(new Promise<void>((r) => { wake = r; }), quietBy);
  wake = null;
  return inFlight.size;
}

/** For tests: writes start again after stopWrites. */
export function resumeWritesForTests(): void {
  stoppedWhy = null;
  owed = 0;
}

/** Never settles: the write is not made, and its caller waits here until the stopping process exits. `cleanup` runs first. */
async function park(cleanup?: () => Promise<void>): Promise<never> {
  if (cleanup) await cleanup();
  return await new Promise<never>(() => {});
}

function track(id: number, owner: string | null): void {
  let end = (): void => {};
  const done = new Promise<void>((r) => { end = r; });
  inFlight.set(id, { done, end, owner });
}

function untrack(id: number): void {
  inFlight.get(id)?.end();
  inFlight.delete(id);
}

/**
 * Adds the row before the write, so a crash during the call leaves a "started" row: an unknown outcome. Paces the write;
 * throws WritePacedError when the wait would pass the bound. After stopWrites it parks instead, once `beforePark` has undone
 * what the caller began (the rows of a batch it added before this one).
 */
async function begin(w: Writer, action: string, target: string, details: Details, owner?: string, beforePark?: () => Promise<void>): Promise<number> {
  // The caller is past the bookkeeping of its earlier write.
  owed = Math.max(0, owed - 1);
  wake?.();
  const clock = w.now ?? Date.now;
  const sleep = w.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = clock();
  for (;;) {
    if (stoppedWhy !== null) return await park(beforePark);
    const now = clock();
    const r = await tryBegin(w, action, target, details, now, owner);
    if ("id" in r) {
      // Checked and tracked in one turn of the event loop: stopWrites either waits for this write, or it is not made.
      const id = r.id;
      if (stoppedWhy !== null) return await park(async () => { await abandonWrites(w.db, [id]); await beforePark?.(); });
      track(id, r.paceOwner);
      return id;
    }
    if (now - t0 + r.wait > PACE_MAX_WAIT_MS) throw new WritePacedError(`${String(details.identity)} on ${paceOwner(String(details.identity), target, owner) || "all owners"}`, r.wait);
    await sleep(r.wait);
  }
}

/** Marks the row done or failed. `owes`: the caller may record what the write did next (false for all but the last row of a batch). */
async function finish(w: Writer, id: number, details: Details, error?: string, owes = true): Promise<void> {
  const d = error === undefined ? { ...details, state: "done" } : { ...details, state: "failed", error };
  // The pacing key's owner, set by begin(), stays on the row.
  const owner = inFlight.get(id)?.owner ?? null;
  try {
    await finishWrite(w.db, id, owner === null ? d : { ...d, paceOwner: owner });
  } finally {
    if (owes) owed++;
    untrack(id);
  }
}

/**
 * A creating write is made once, also when the job resumed after a restart (src/runner/resuming.ts) or a later run tries it again: `key`
 * tells this write from the other writes of the same action on the same target (a hash of the text, a run id, a commit), and `replay`
 * rebuilds the result from the row of the earlier write. `lasting`: the key names one write for good (it holds the id of the card,
 * command or call the write carries out), so an earlier done row of any run is that write; without it only a done row of this job's own
 * earlier run is. `find` looks on GitHub for a write begun at `since` whose outcome was never learned, whichever run began it, leaving out
 * `taken`: what other writes are recorded to have made. Its details complete that row. Without `find` GitHub itself refuses a repeat (one open PR per head, a push over a moved branch) or the repeat does
 * no harm (a rerun).
 */
type Once<T> = { key: string; also?: string[]; lasting?: boolean; replay: (d: Details) => T; find?: (since: string, taken: ReadonlySet<string>) => Promise<Details | null> };

/** An earlier write's outcome is unknown and could not be settled (`cause`: GitHub could not be read, or what it shows not recorded): the write was not made again. */
export class UnsettledError extends Error {}

/** The key of a write made once: a hash of what tells it apart. */
const onceKey = (...parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

/** What tells two comments with the same text apart: what they answer (a decision, card, comment, command, action, call or repin), or the commit they are about: the `head` an ask is made at, the commit a push note reports (`to`). */
const answered = (d: Details): unknown[] => ["decision", "card", "comment", "command", "action", "call", "repin", "head", "to"].map((k) => d[k] ?? null);
/** Whether the details name by id what the comment answers: a comment with the same text and id is then the same one. */
const answersOne = (d: Details): boolean => ["decision", "card", "comment", "action", "call", "repin"].some((k) => d[k] !== undefined && d[k] !== null);

const earlier = new WeakMap<Db, Map<string, Promise<Awaited<ReturnType<typeof loadMadeBefore>>>>>();
/** A resumed job's rows from before its run started: they cannot change while it runs, so every write of the run shares one read. */
const earlierWrites = (db: Db, job: number, before: string): Promise<Awaited<ReturnType<typeof loadMadeBefore>>> => {
  const byJob = earlier.get(db) ?? earlier.set(db, new Map()).get(db)!;
  const key = `${job}@${before}`;
  return byJob.get(key) ?? byJob.set(key, loadMadeBefore(db, job, before).catch((e) => { byJob.delete(key); throw e; })).get(key)!;
};

type Tried = { id: number; at: string; details: Details };
/**
 * The details of the write when an earlier run made it, or the row of a try whose outcome is unknown (the run was stopped before
 * recording it, or its request went out and failed without GitHub refusing it) with the time of the earliest such try. Null when there is neither.
 */
async function madeBefore(w: Writer, action: string, target: string, once: Pick<Once<unknown>, "key" | "also" | "lasting" | "find">): Promise<{ done: Details } | { unknown: Tried } | null> {
  const keys = [once.key, ...once.also ?? []];
  const open = (rows: Tried[]): { unknown: Tried } | null => {
    const list = rows.filter((r) => unclearWrite(r.details));
    const row = list.find((r) => r.details.state === "started") ?? list[0];
    return row ? { unknown: { ...row, at: list[list.length - 1]!.at } } : null;
  };
  const job = currentJobId();
  const run = job === null ? null : await resumedRun(w.db, job);
  const mine = job !== null && run ? (await earlierWrites(w.db, job, run.startedAt)).get(`${action}\t${target}`)?.filter((r) => typeof r.details.writeKey === "string" && keys.includes(r.details.writeKey)) ?? [] : [];
  const made = mine.find((r) => r.details.state === "done");
  if (made) return { done: made.details };
  if (once.find) {
    const tries = await loadWriteTries(w.db, { action, target, keys });
    const at = tries.findIndex((r) => r.details.state === "done");
    if (once.lasting && at >= 0) return { done: tries[at]!.details };
    // A try older than a done one was settled by it: the same text may be posted again later.
    const left = open(at < 0 ? tries : tries.slice(0, at));
    if (left) return left;
  }
  return open(mine);
}

/**
 * What comes before a write's request: the result of the earlier run that made it (`was`), or the row of the write now begun. It sends
 * nothing, so an error of it leaves nothing made by this call; an UnsettledError leaves open what the earlier run made.
 */
async function started<T>(w: Writer, identity: string, action: string, target: string, details0: Details, once?: Once<T>, owner?: string): Promise<{ was: T } | { id: number; details: Details }> {
  let repeats: number | undefined;
  if (once) {
    const before = await madeBefore(w, action, target, once);
    if (before && "done" in before) {
      console.log(`${action} on ${target}: made by an earlier run, not made again`);
      return { was: once.replay(before.done) };
    }
    if (before && once.find) {
      try {
        const found = await once.find(before.unknown.at, await loadTakenWrites(w.db, { target, action, since: before.unknown.at }));
        if (found) {
          const { error: _, ...was } = before.unknown.details;
          const d = { ...was, ...found, state: "done" };
          await finishWrite(w.db, before.unknown.id, d);
          console.log(`${action} on ${target}: made by an earlier run (found on GitHub), not made again`);
          return { was: once.replay(d) };
        }
      } catch (e) {
        throw new UnsettledError(`${action} on ${target} may have been made by an earlier run and its outcome could not be read: ${oneLine(String((e as Error).message ?? e))}`, { cause: e });
      }
    }
    if (before && before.unknown.details.state === "started") {
      repeats = before.unknown.id;
      console.log(`${action} on ${target}: an earlier run began it with an unknown outcome (audit row ${repeats}); made again`);
    }
  }
  const details = { ...details0, identity, ...jobOf(), ...(once && { writeKey: once.key }), ...(repeats !== undefined && { repeats }) };
  effect("github-write");
  return { id: await begin(w, action, target, details, owner), details };
}

/**
 * Records the row first, runs the write, then marks the row done with `view`'s extra details or failed with the error.
 * With `once`, a write the job's earlier run made is not made again: its recorded result, or what GitHub shows of it, is returned.
 * An error from before the request is marked unsent; one of the bookkeeping after it is not.
 */
async function recorded<T>(w: Writer, identityOf: string | Promise<string>, action: string, target: string, details0: Details, f: () => Promise<T>, view?: (r: T) => Details, failure?: (r: T) => string | null, once?: Once<T>, /** The pacing key's owner when the target's repo has no `repos` row. */ owner?: string): Promise<T> {
  let begun: Awaited<ReturnType<typeof started<T>>>;
  try {
    begun = await started(w, await identityOf, action, target, details0, once, owner);
  } catch (e) {
    throw e instanceof UnsettledError ? e : markUnsent(e);
  }
  if ("was" in begun) return begun.was;
  const { id, details } = begun;
  let r: T;
  try {
    r = await f();
  } catch (e) {
    await finish(w, id, isUnsent(e) ? { ...details, sent: false } : details, oneLine(String((e as Error).message ?? e)));
    throw e;
  }
  const bad = failure?.(r) ?? null;
  // What is known not to have gone out is recorded as such: a later run makes the write without looking for it.
  if (bad !== null) await finish(w, id, (r as { sent?: false } | undefined)?.sent === false ? { ...details, sent: false } : details, bad);
  else await finish(w, id, { ...details, ...view?.(r) });
  return r;
}

// ---- GraphQL mutations ------------------------------------------------------

const ADD_COMMENT = `mutation($id: ID!, $body: String!) {
  addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { url } } }
}`;
const CLOSE_ISSUE = `mutation($id: ID!) { closeIssue(input: { issueId: $id }) { clientMutationId } }`;
const CLOSE_ISSUE_AS = `mutation($id: ID!, $reason: IssueClosedStateReason!) { closeIssue(input: { issueId: $id, stateReason: $reason }) { clientMutationId } }`;
const CLOSE_ISSUE_DUPLICATE = `mutation($id: ID!, $reason: IssueClosedStateReason!, $dup: ID!) { closeIssue(input: { issueId: $id, stateReason: $reason, duplicateIssueId: $dup }) { clientMutationId } }`;
const CLOSE_PR = `mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }`;
const ASSIGN = `mutation($id: ID!, $user: ID!) {
  addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: [$user] }) { clientMutationId }
}`;
const UNASSIGN = `mutation($id: ID!, $user: ID!) {
  removeAssigneesFromAssignable(input: { assignableId: $id, assigneeIds: [$user] }) { clientMutationId }
}`;
const REOPEN_ISSUE = `mutation($id: ID!) { reopenIssue(input: { issueId: $id }) { clientMutationId } }`;
const REOPEN_PR = `mutation($id: ID!) { reopenPullRequest(input: { pullRequestId: $id }) { clientMutationId } }`;
const REMOVE_LABEL = `mutation($id: ID!, $label: ID!) { removeLabelsFromLabelable(input: { labelableId: $id, labelIds: [$label] }) { clientMutationId } }`;
const TRANSFER_ISSUE = `mutation($id: ID!, $repo: ID!) { transferIssue(input: { issueId: $id, repositoryId: $repo }) { issue { url number } } }`;
const REQUEST_REVIEWS = `mutation($id: ID!, $users: [ID!]!) {
  requestReviews(input: { pullRequestId: $id, userIds: $users, union: true }) { clientMutationId }
}`;
const ADD_REVIEW = `mutation($pr: ID!, $oid: GitObjectID!, $body: String!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $oid, body: $body, event: COMMENT }) { pullRequestReview { id } }
}`;
const EDIT_REVIEW = `mutation($id: ID!, $body: String!) {
  updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) { pullRequestReview { id } }
}`;
const CREATE_LABEL = `mutation($input: CreateLabelInput!) { createLabel(input: $input) { label { id } } }`;

/** One aliased `addLabelsToLabelable` per item, with variables `i<k>` (node id) and `l<k>` (label ids). */
export function addLabelsMutation(count: number): string {
  const ks = Array.from({ length: count }, (_, k) => k);
  const decl = ks.flatMap((k) => [`$i${k}: ID!`, `$l${k}: [ID!]!`]);
  const body = ks.map((k) => `m${k}: addLabelsToLabelable(input: {labelableId: $i${k}, labelIds: $l${k}}) { clientMutationId }`);
  return `mutation(${decl.join(", ")}) { ${body.join("\n")} }`;
}

export type ItemRef = { repo: string; number: number; id: string };

/** Posts a comment on an issue or PR; returns the comment's URL. `details` is the source (run or decision) and any context. */
export async function commentOn(w: Writer, g: Grant, q: Querier, action: string, item: ItemRef, note: Note, text: string, details: Details = {}): Promise<string> {
  covers(g, item.repo, item.number);
  q = await laneQuery(w, g, q);
  const body = posted(note, text);
  const r = await recorded(w, idOf(w, g), action, refOf(item.repo, item.number), { ...details, text: body },
    () => q.query(ADD_COMMENT, { id: item.id, body }) as Promise<{ addComment?: { commentEdge?: { node?: { url?: string } } } }>,
    (x) => ({ url: x.addComment?.commentEdge?.node?.url ?? undefined }), undefined,
    { key: onceKey(body, ...answered(details)), lasting: answersOne(details), replay: (d) => ({ addComment: { commentEdge: { node: { url: typeof d.url === "string" ? d.url : "" } } } }),
      find: async (since, taken) => { const url = await nodeCommentMade(q, { id: item.id, body, since, mine: await byUs(w.db), taken }); return url === null ? null : { url }; } });
  return r.addComment?.commentEdge?.node?.url ?? "";
}

export type CloseReason = "COMPLETED" | "NOT_PLANNED" | "DUPLICATE";
export type CloseHow = CloseReason | { reason: CloseReason; /** Node id of the kept issue (DUPLICATE only). */ duplicateOf?: string; /** Ref of the kept item, recorded in the audit details. */ keptRef?: string };

/** The reason for closing a duplicate of `kept`: GitHub links duplicates to issues only, so a kept PR gives NOT_PLANNED. */
export function duplicateClose(kept: { id: string; pr: boolean }, keptRef?: string): CloseHow {
  return kept.pr ? "NOT_PLANNED" : { reason: "DUPLICATE", duplicateOf: kept.id, keptRef };
}

/** Closes an issue or PR. Issues get a state reason; a DUPLICATE close that GitHub rejects is retried once as NOT_PLANNED. */
export async function closeItem(w: Writer, g: Grant, q: Querier, item: ItemRef & { pr: boolean }, details: Details = {}, how?: CloseHow): Promise<void> {
  covers(g, item.repo, item.number);
  q = await laneQuery(w, g, q, "close");
  const o = typeof how === "string" ? { reason: how } as Exclude<CloseHow, string> : how;
  // GitHub has a state reason for issues only.
  const reason = o && !item.pr ? o.reason : undefined;
  const duplicateOf = reason === "DUPLICATE" ? o?.duplicateOf : undefined;
  const d0 = reason ? { ...details, reason, ...(o?.keptRef ? { kept: o.keptRef } : {}) } : details;
  let fellBack = false;
  await recorded(w, idOf(w, g, "close"), "act-close", refOf(item.repo, item.number), d0, async () => {
    if (item.pr) return q.query(CLOSE_PR, { id: item.id });
    if (!reason) return q.query(CLOSE_ISSUE, { id: item.id });
    if (reason !== "DUPLICATE") return q.query(CLOSE_ISSUE_AS, { id: item.id, reason });
    try {
      return await q.query(duplicateOf ? CLOSE_ISSUE_DUPLICATE : CLOSE_ISSUE_AS, duplicateOf ? { id: item.id, reason, dup: duplicateOf } : { id: item.id, reason });
    } catch (e) {
      if (!/validat|stateReason|duplicateIssueId|IssueClosedStateReason|argument/i.test(String((e as Error).message ?? e))) throw e;
      fellBack = true;
      return q.query(CLOSE_ISSUE_AS, { id: item.id, reason: "NOT_PLANNED" });
    }
  }, () => (fellBack ? { reason: "NOT_PLANNED", requestedReason: "DUPLICATE", fallback: "GitHub rejected DUPLICATE" } : {}));
}

export async function assignTo(w: Writer, g: Grant, q: Querier, item: ItemRef, user: { id: string; login: string }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  q = await laneQuery(w, g, q);
  await recorded(w, idOf(w, g), "assign", refOf(item.repo, item.number), { ...details, assignee: user.login }, () => q.query(ASSIGN, { id: item.id, user: user.id }));
}

export async function unassignFrom(w: Writer, g: Grant, q: Querier, item: ItemRef, user: { id: string; login: string }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  q = await laneQuery(w, g, q);
  await recorded(w, idOf(w, g), "unassign", refOf(item.repo, item.number), { ...details, assignee: user.login }, () => q.query(UNASSIGN, { id: item.id, user: user.id }));
}

export async function reopenItem(w: Writer, g: Grant, q: Querier, item: ItemRef & { pr: boolean }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  q = await laneQuery(w, g, q);
  await recorded(w, idOf(w, g), "act-reopen", refOf(item.repo, item.number), details, () => q.query(item.pr ? REOPEN_PR : REOPEN_ISSUE, { id: item.id }));
}

export async function removeLabel(w: Writer, g: Grant, q: Querier, item: ItemRef, label: { id: string; name: string }, details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  q = await laneQuery(w, g, q);
  await recorded(w, idOf(w, g), "act-unlabel", refOf(item.repo, item.number), { ...details, label: label.name }, () => q.query(REMOVE_LABEL, { id: item.id, label: label.id }));
}

/** Moves an issue to another repository of the organisation (`to.id` is its node id). The grant `gTo` must cover the target repo; returns the issue's new URL. */
export async function transferIssue(w: Writer, g: Grant, gTo: Grant, q: Querier, item: ItemRef, to: { repo: string; id: string }, details: Details = {}): Promise<string> {
  covers(g, item.repo, item.number);
  covers(gTo, to.repo);
  // The move needs both repositories.
  q = await laneQuery(w, g, q, "other", { also: [to.repo] });
  const r = await recorded(w, idOf(w, g), "act-transfer", refOf(item.repo, item.number), { ...details, to: to.repo },
    () => q.query(TRANSFER_ISSUE, { id: item.id, repo: to.id }) as Promise<{ transferIssue?: { issue?: { url?: string } } }>,
    (x) => ({ url: x.transferIssue?.issue?.url ?? undefined }), undefined,
    { key: onceKey(to.repo), replay: (d) => ({ transferIssue: { issue: { url: typeof d.url === "string" ? d.url : "" } } }) });
  return r.transferIssue?.issue?.url ?? "";
}

/** Requests reviews from users (added to the reviewers already requested). */
export async function requestReviewers(w: Writer, g: Grant, q: Querier, item: ItemRef, users: { id: string; login: string }[], details: Details = {}): Promise<void> {
  covers(g, item.repo, item.number);
  q = await laneQuery(w, g, q);
  await recorded(w, idOf(w, g), "act-request-reviewers", refOf(item.repo, item.number), { ...details, reviewers: users.map((u) => u.login) },
    () => q.query(REQUEST_REVIEWS, { id: item.id, users: users.map((u) => u.id) }));
}

/** Posts a review as a plain comment review on the commit; returns the review id (null when GitHub returned none). */
export async function postReview(w: Writer, q: Querier, g: Guarded<"post-review">, nodeId: string, note: Note, text: string, details: Details = {}): Promise<string | null> {
  q = await laneQuery(w, g, q);
  const body = posted(note, text);
  const r = await recorded(w, idOf(w, g), "review-post", refOf(g.repo, g.number), { ...details, head: g.head },
    () => q.query(ADD_REVIEW, { pr: nodeId, oid: g.head, body }) as Promise<{ addPullRequestReview?: { pullRequestReview?: { id?: string } | null } | null }>,
    (x) => ({ review: x.addPullRequestReview?.pullRequestReview?.id ?? undefined }),
    (x) => (x.addPullRequestReview?.pullRequestReview?.id ? null : "GitHub returned no review"),
    { key: onceKey(g.head, body), replay: (d) => ({ addPullRequestReview: { pullRequestReview: { id: typeof d.review === "string" ? d.review : undefined } } }),
      find: async (since, taken) => { const review = await reviewMade(q, { id: nodeId, head: g.head, body, since, mine: await byUs(w.db), taken }); return review === null ? null : { review }; } });
  return r.addPullRequestReview?.pullRequestReview?.id ?? null;
}

export async function editReview(w: Writer, q: Querier, g: Guarded<"post-review">, reviewId: string, note: Note, text: string, details: Details = {}): Promise<void> {
  q = await laneQuery(w, g, q);
  const body = posted(note, text);
  // An edit whose answer was lost may have gone through: one that would change nothing is not made.
  if (await reviewReads(q, reviewId, body)) return;
  await recorded(w, idOf(w, g), "review-edit", refOf(g.repo, g.number), { ...details, head: g.head, review: reviewId }, () => q.query(EDIT_REVIEW, { id: reviewId, body }));
}

export async function createLabel(w: Writer, g: GuardedRepo, q: Querier, repo: string, repoId: string, label: { name: string; color: string; description: string }, retry: Retry = direct, details: Details = {}): Promise<void> {
  covers(g, repo);
  q = await laneQuery(w, g, q);
  await recorded(w, idOf(w, g), "label-create", repo, { ...details, name: label.name }, () => retry(() => q.query(CREATE_LABEL, { input: { repositoryId: repoId, ...label } })));
}

export type LabelWrite = { number: number; id: string; labelIds: string[]; names: string[]; /** The guard that let this item's labels through (an item grant, or the repo grant of a conversation card). */ g: GuardedItem | GuardedRepo };

/** Adds labels to several items in one request. One row per item: labelled with the names, or the failure. Returns the numbers that succeeded. */
export async function addLabels(w: Writer, q: Querier, repo: string, items: LabelWrite[], retry: Retry = direct, details: Details = {}): Promise<number[]> {
  for (const it of items) covers(it.g, repo, it.number);
  // Items of different lanes go out in separate requests, each with its own token.
  const app = await filterSeq(items, async (it) => await inAppLane(w, it.g));
  if (app.length > 0 && app.length < items.length) {
    const first = await addLabels(w, q, repo, app, retry, details);
    return [...first, ...(await addLabels(w, q, repo, await filterSeq(items, async (it) => !await inAppLane(w, it.g)), retry, details))];
  }
  if (app.length > 0) q = await laneQuery(w, items[0]!.g, q);
  const vars: Record<string, unknown> = {};
  items.forEach((it, k) => { vars[`i${k}`] = it.id; vars[`l${k}`] = it.labelIds; });
  const det = async (it: LabelWrite): Promise<Details> => ({ ...details, labels: it.names, identity: await idOf(w, it.g), ...jobOf() });
  const ids: number[] = [];
  // Paced or stopped partway: the rows already added were never sent.
  const unsent = async (): Promise<void> => {
    for (const id of ids) untrack(id);
    await abandonWrites(w.db, ids);
  };
  try {
    effect("github-write");
    for (const it of items) ids.push(await begin(w, "labels-apply", refOf(repo, it.number), await det(it), undefined, unsent));
  } catch (e) {
    await unsent();
    throw e;
  }
  let d: Record<string, unknown> | null;
  try {
    d = await retry(() => q.query(addLabelsMutation(items.length), vars));
  } catch (e) {
    const msg = oneLine(String((e as Error).message ?? e));
    await forEachSeq(items, async (it, k) => await finish(w, ids[k]!, await det(it), msg, k === items.length - 1));
    throw e;
  }
  const done: number[] = [];
  await forEachSeq(items, async (it, k) => {
    if (d && d[`m${k}`] !== null && d[`m${k}`] !== undefined) {
      done.push(it.number);
      await finish(w, ids[k]!, await det(it), undefined, k === items.length - 1);
    } else await finish(w, ids[k]!, await det(it), "GitHub did not apply the labels", k === items.length - 1);
  });
  return done;
}

// ---- gh commands -------------------------------------------------------------

const GH_URL = /https:\/\/github\.com\/\S+/;

/** The result of a gh write the job made before it resumed: success, with the URL gh printed. */
const ghReplay = (d: Details): ExecResult => ({ code: 0, stdout: typeof d.url === "string" ? `${d.url}\n` : "", stderr: "" });

/** `gh` as a read that throws when it fails. */
const ghRead = (exec: Exec): GhRead => async (args) => {
  const r = await exec("gh", args);
  if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout) || `exit code ${r.code}`);
  return r.stdout;
};

/** `once`: the key of a creating write, made once per job (Once), with other keys the earlier run may have made it under, or how to find it on GitHub. */
async function viaGh(w: Writer, identity: string | Promise<string>, exec: Exec, action: string, target: string, details: Details, args: string[], input?: string, once?: string | Pick<Once<ExecResult>, "key" | "also" | "lasting" | "find">): Promise<ExecResult> {
  return recorded(w, identity, action, target, details, async () => {
    const legacy = await identity === "legacy";
    return exec("gh", args, input === undefined && !legacy ? undefined : { ...(input === undefined ? {} : { input }), ...(legacy ? { inherit: true } : {}) });
  },
    (r) => ({ url: r.stdout.match(GH_URL)?.[0] }),
    (r) => (r.code === 0 ? null : oneLine(r.stderr || r.stdout) || `exit code ${r.code}`),
    once === undefined ? undefined : typeof once === "string" ? { key: once, replay: ghReplay } : { ...once, replay: ghReplay });
}

/** Asks a contributor on their PR (fix-up, conflict or CI fix where the branch is closed to us); `action` is the audit action of the caller's stage. */
export function ghAskComment(w: Writer, exec: Exec, action: string, g: Guarded<AskKind>, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  return ghComment(w, g, exec, action, { repo: g.repo, number: g.number, pr: true }, note, text, details);
}

/** `action` is the audit action of the caller's stage (act, fixup or implement comment). Not for asks: those use ghAskComment. */
export async function ghComment(w: Writer, g: CommentGrant, exec: Exec, action: string, o: { repo: string; number: number; pr: boolean }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  exec = await laneExec(w, g, exec);
  const body = posted(note, text);
  return viaGh(w, idOf(w, g), exec, action, refOf(o.repo, o.number), { ...details, text: body },
    [o.pr ? "pr" : "issue", "comment", String(o.number), "--repo", `${slugOf(o.repo)}`, "--body-file", "-"], body,
    { key: onceKey(body, ...answered(details)), lasting: answersOne(details), find: async (since, taken) => { const url = await commentMade(ghRead(exec), { repo: o.repo, number: o.number, body, since, mine: await byUs(w.db), taken }); return url === null ? null : { url }; } });
}

/** Adds the follow-ups of a later head of a PR approved for merge to the PR's follow-up issue (`issue`), as a comment there. Audited as `premerge-followup`, aimed at the PR. */
export async function ghFollowupComment(w: Writer, g: Guarded<"followups">, exec: Exec, o: { issue: number }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, g.repo, g.number);
  exec = await laneExec(w, g, exec);
  const body = posted(note, text);
  return viaGh(w, idOf(w, g), exec, "premerge-followup", refOf(g.repo, g.number), { ...details, issue: o.issue, text: body },
    ["issue", "comment", String(o.issue), "--repo", `${slugOf(g.repo)}`, "--body-file", "-"], body,
    { key: onceKey(body, String(o.issue)), find: async (since, taken) => { const url = await commentMade(ghRead(exec), { repo: g.repo, number: o.issue, body, since, mine: await byUs(w.db), taken }); return url === null ? null : { url }; } });
}

/** Replaces the body of a comment we posted (`commentId` is the number in its `#issuecomment-` URL). */
export async function ghEditComment(w: Writer, g: CommentGrant, exec: Exec, action: string, o: { repo: string; number: number; commentId: string }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  exec = await laneExec(w, g, exec);
  const body = posted(note, text);
  return viaGh(w, idOf(w, g), exec, action, refOf(o.repo, o.number), { ...details, text: body, comment: o.commentId },
    ["api", "-X", "PATCH", `repos/${slugOf(o.repo)}/issues/comments/${o.commentId}`, "-F", "body=@-"], body);
}

/**
 * Deletes a comment of ours (`commentId` is the number in its `#issuecomment-` URL). The comment's author must be one of
 * `logins` (the box account and the app's bot names, lower case); a comment that is already gone counts as done (the audit row carries `gone: true`).
 */
export async function ghDeleteComment(w: Writer, g: CommentGrant, exec: Exec, action: string, o: { repo: string; number: number; commentId: string; logins: ReadonlySet<string> }, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  exec = await laneExec(w, g, exec);
  const path = `repos/${slugOf(o.repo)}/issues/comments/${o.commentId}`;
  const gone = (r: ExecResult): boolean => r.code !== 0 && /404|not found/i.test(`${r.stderr} ${r.stdout}`);
  const goneResult: ExecResult = { code: 0, stdout: "gone", stderr: "" };
  return recorded(w, idOf(w, g), action, refOf(o.repo, o.number), { ...details, comment: o.commentId },
    async () => {
      const author = await exec("gh", ["api", path, "--jq", ".user.login"]);
      if (gone(author)) return goneResult;
      if (author.code !== 0) return author;
      if (!isOwnLogin(o.logins, author.stdout.trim())) return { code: 1, stdout: "", stderr: "the comment is not ours" };
      const del = await exec("gh", ["api", "-X", "DELETE", path]);
      return gone(del) ? goneResult : del;
    },
    (r) => (r.stdout === "gone" ? { gone: true } : {}),
    (r) => (r.code === 0 ? null : oneLine(r.stderr || r.stdout) || `exit code ${r.code}`));
}

/** Opens a PR from the pipeline's own branch; `draft` opens it as a draft. */
export async function ghOpenPr(w: Writer, g: Grant, exec: Exec, action: string, o: { repo: string; target: string; base: string; head: string; title: string; body: string; draft?: boolean }, note: Note, details: Details = {}): Promise<ExecResult> {
  opensOwnPr(g, o.repo);
  exec = await laneExec(w, g, exec);
  const body = posted(note, o.body);
  // GitHub keeps one open PR per head and base: a resumed job's PR is the one its earlier run opened, whatever the text.
  return viaGh(w, idOf(w, g), exec, action, o.target, { ...details, text: body, ...(o.draft && { draft: true }) },
    ["pr", "create", "--repo", `${slugOf(o.repo)}`, "--base", o.base, "--head", o.head, "--title", scrub(o.title), "--body-file", "-", ...(o.draft ? ["--draft"] : [])], body, onceKey(o.repo, o.base, o.head));
}

export async function ghClosePr(w: Writer, g: Grant, exec: Exec, o: { repo: string; number: number }, note: Note, text: string, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo, o.number);
  exec = await laneExec(w, g, exec, "close");
  const comment = posted(note, text);
  return viaGh(w, idOf(w, g, "close"), exec, "batch-pr-close", refOf(o.repo, o.number), { ...details, text: comment },
    ["pr", "close", String(o.number), "--repo", `${slugOf(o.repo)}`, "--comment", comment], undefined, onceKey(comment));
}

/** Creates the pipeline account's fork of `repo` when it has none. */
export async function ghFork(w: Writer, g: GuardedRepo, exec: Exec, repo: string, details: Details = {}): Promise<ExecResult> {
  covers(g, repo);
  // An app has no account to own a fork: its branches go to the base repository (forkOf returns it), so no fork is made.
  if (await inAppLane(w, g)) return Promise.resolve({ code: 1, stdout: "", stderr: "app identity: the app has no fork; push to the base repository" });
  return viaGh(w, idOf(w, g), exec, "fork-create", repo, details, ["repo", "fork", `${slugOf(repo)}`, "--clone=false"]);
}

/** `clear`: GitHub refused the request or it never went out, so no issue can exist. Otherwise the outcome is unknown (a timeout, a lost response, a success without a URL, an answer that could not be recorded). */
export class IssueError extends Error {
  clear: boolean;
  /** Nothing was made and a later run may simply try again: the write pacing (WritePacedError) or a rate limit of GitHub held the create back, or it failed before its request. */
  later: boolean;
  /** Nothing was sent: something before the request failed (`noAccess`: the installation does not reach the repo), or GitHub's rate limit refused it. */
  unsent: boolean;
  noAccess: boolean;
  /** This call sent nothing: whether an earlier try made the issue is not known (UnsettledError). */
  unsettled: boolean;
  constructor(message: string, clear: boolean, later = false, o: { unsent?: boolean; noAccess?: boolean; unsettled?: boolean } = {}) {
    super(message); this.clear = clear; this.later = later; this.unsent = o.unsent ?? false; this.noAccess = o.noAccess ?? false; this.unsettled = o.unsettled ?? false;
  }
}

/**
 * What a create that threw says about the issue. Only an error from before the request (marked unsent, the pacing's included) shows that this
 * call made none: anything else may have come after GitHub made it, a failed write of the audit row included.
 */
function issueErrorOf(e: unknown): IssueError {
  const unsent = isUnsent(e), unsettled = e instanceof UnsettledError;
  return new IssueError(oneLine(String((e as Error).message ?? e)), unsent, unsent && !(e instanceof AppNoAccessError), { unsent, noAccess: (unsettled ? e.cause : e) instanceof AppNoAccessError, unsettled });
}

/** The same of a create whose command failed. */
function issueFailed(r: ExecResult): IssueError {
  const m = oneLine(r.stderr || r.stdout) || `exit code ${r.code}`;
  const unsent = r.sent === false || rateLimited(m);
  return new IssueError(m, unsent || refusedWrite(m), rateLimited(m), { unsent });
}

/**
 * Opens an issue; returns its number and URL. Throws an IssueError when `gh` fails or prints no issue URL; `clear` tells
 * whether the failure certainly left no issue behind. `target` is the item the issue follows up.
 */
export async function createIssue(w: Writer, g: Grant | Guarded<"followups">, exec: Exec, o: { repo: string; target: string; title: string; body: string; /** The audit action; the post-merge step's by default. */ action?: string; /** Labels the issue gets; each must exist in the repo (ensureLabel). */ labels?: string[] }, note: Note, details: Details = {}): Promise<{ number: number; url: string }> {
  covers(g, o.repo);
  const body = posted(note, o.body);
  let r: ExecResult;
  try {
    const run = await laneExec(w, g, exec);
    r = await viaGh(w, idOf(w, g), run, o.action ?? "postmerge-file", o.target, { ...details, title: scrub(o.title), text: body },
      ["issue", "create", "--repo", `${slugOf(o.repo)}`, "--title", scrub(o.title), ...(o.labels ?? []).flatMap((l) => ["--label", l]), "--body-file", "-"], body,
      { key: onceKey(o.repo, scrub(o.title), body), find: async (since, taken) => { const made = await issueMade(ghRead(run), { repo: o.repo, title: scrub(o.title), body, since, mine: await byUs(w.db), taken }); return made === null ? null : { url: made.url }; } });
  } catch (e) {
    throw issueErrorOf(e);
  }
  const url = r.stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/);
  if (r.code !== 0) throw issueFailed(r);
  if (!url) throw new IssueError(oneLine(r.stderr || r.stdout) || "gh printed no issue URL", false);
  return { number: Number(url[1]), url: url[0] };
}

/** Creates a label in the repo, or updates its colour and description when it exists (`gh label create --force`); audited as `label-create`. Throws when gh fails. */
export async function ensureLabel(w: Writer, g: GuardedRepo, exec: Exec, o: { repo: string; name: string; color: string; description: string }): Promise<void> {
  covers(g, o.repo);
  const run = await laneExec(w, g, exec);
  const r = await viaGh(w, idOf(w, g), run, "label-create", o.repo, { name: o.name },
    ["label", "create", o.name, "--repo", `${slugOf(o.repo)}`, "--color", o.color, "--description", o.description, "--force"]);
  if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout) || `exit code ${r.code}`);
}

/** `found`: an earlier press made the issue and lost its answer; when that press's write began. */
export type FiledIssue = { number: number; url: string; found?: string };

/**
 * Opens an issue as a Discord reporter (the person's own token is in `exec`'s environment): audited under their GitHub
 * login as `discord-issue-open`, with the URL and number but not the text. Throws an IssueError like createIssue.
 */
/** Files an issue with a Discord reporter's own token; `w.login` is the reporter's GitHub login. */
export async function createReporterIssue(w: Writer, exec: Exec, o: { repo: string; title: string; body: string }): Promise<FiledIssue> {
  let r: ExecResult;
  let found: string | undefined;
  try {
    r = await recorded(w, `user:${w.login}`, "discord-issue-open", o.repo, {}, () => exec("gh", ["issue", "create", "--repo", slugOf(o.repo), "--title", o.title, "--body-file", "-"], { input: o.body }),
      (x) => { const m = x.stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/); return m ? { url: m[0], number: Number(m[1]) } : {}; },
      (x) => (x.code === 0 && /https:\/\/github\.com\/\S+\/issues\/\d+/.test(x.stdout) ? null : oneLine(x.stderr || x.stdout) || `exit code ${x.code}`),
      { key: onceKey(o.repo, w.login, o.title, o.body), replay: ghReplay, find: async (since, taken) => {
        const made = await issueMade(ghRead(exec), { repo: o.repo, title: o.title, body: o.body, since, mine: (login) => login?.toLowerCase() === w.login.toLowerCase(), taken });
        if (made) found = since;
        return made;
      } });
  } catch (e) {
    throw issueErrorOf(e);
  }
  const url = r.stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/);
  if (r.code !== 0) throw issueFailed(r);
  if (!url) throw new IssueError(oneLine(r.stderr || r.stdout) || "gh printed no issue URL", false);
  return { number: Number(url[1]), url: url[0], ...(found !== undefined && { found }) };
}

/** Adds a label to an issue a Discord reporter filed, with their token; audited as `discord-issue-label`. A refusal is recorded and returned as false, never thrown. */
export async function labelReporterIssue(w: Writer, exec: Exec, o: { repo: string; number: number; label: string }): Promise<boolean> {
  try {
    const r = await recorded(w, `user:${w.login}`, "discord-issue-label", refOf(o.repo, o.number), { label: o.label },
      () => exec("gh", ["issue", "edit", String(o.number), "--repo", slugOf(o.repo), "--add-label", o.label]), undefined, (x) => (x.code === 0 ? null : oneLine(x.stderr || x.stdout) || `exit code ${x.code}`));
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Runs `gh` under the grant's app lane; a not-sent failure when the write would not be the GitHub App's (the instance writes as the box account). Never the box account. */
async function asBot(w: Writer, g: GuardedFiling, exec: Exec, args: string[], input?: string): Promise<ExecResult> {
  if (!await inAppLane(w, g)) return { code: 1, stdout: "", stderr: "app identity: the instance writes as the box account, not the GitHub App", sent: false };
  let env: Record<string, string>;
  // Lost access is thrown, so the caller can tell it from a failure to reach GitHub.
  try { env = await appEnv(w, g); } catch (e) { if (e instanceof AppNoAccessError) throw e; return failedResult(e); }
  return exec("gh", args, { ...(input === undefined ? {} : { input }), env, replaceEnv: true });
}

/**
 * Opens an issue as the GitHub App for a Discord reporter who chose "Submit for me": audited as `discord-issue-bot`
 * with the grant's identity, with the URL and number but not the text. Throws an IssueError like createIssue.
 */
export async function createBotIssue(w: Writer, g: GuardedFiling, exec: Exec, o: { repo: string; title: string; body: string }, note: Note): Promise<FiledIssue> {
  covers(g, o.repo);
  const body = posted(note, o.body);
  const title = scrub(o.title);
  let r: ExecResult;
  let found: string | undefined;
  try {
    r = await recorded(w, idOf(w, g), "discord-issue-bot", o.repo, {}, () => asBot(w, g, exec, ["issue", "create", "--repo", `${g.owner}/${g.repo}`, "--title", title, "--body-file", "-"], body),
      (x) => { const m = x.stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/); return m ? { url: m[0], number: Number(m[1]) } : {}; },
      (x) => (x.code === 0 && /https:\/\/github\.com\/\S+\/issues\/\d+/.test(x.stdout) ? null : oneLine(x.stderr || x.stdout) || `exit code ${x.code}`),
      { key: onceKey(o.repo, title, body), replay: ghReplay, find: async (since, taken) => {
        const made = await issueMade(ghRead((_cmd, args) => asBot(w, g, exec, args)), { repo: o.repo, title, body, since, mine: await byUs(w.db), taken });
        if (made) found = since;
        return made;
      } }, g.owner);
  } catch (e) {
    throw issueErrorOf(e);
  }
  const url = r.stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/);
  if (r.code !== 0) throw issueFailed(r);
  if (!url) throw new IssueError(oneLine(r.stderr || r.stdout) || "gh printed no issue URL", false);
  return { number: Number(url[1]), url: url[0], ...(found !== undefined && { found }) };
}

/** Adds a label to an issue the GitHub App filed for a Discord reporter; audited as `discord-issue-label` with the grant's identity. A refusal is recorded and returned as false, never thrown. */
export async function labelBotIssue(w: Writer, g: GuardedFiling, exec: Exec, o: { repo: string; number: number; label: string }): Promise<boolean> {
  try {
    covers(g, o.repo);
    const r = await recorded(w, idOf(w, g), "discord-issue-label", refOf(o.repo, o.number), { label: o.label },
      () => asBot(w, g, exec, ["issue", "edit", String(o.number), "--repo", `${g.owner}/${g.repo}`, "--add-label", o.label]), undefined, (x) => (x.code === 0 ? null : oneLine(x.stderr || x.stdout) || `exit code ${x.code}`), undefined, g.owner);
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Approves one Actions run that waits for a maintainer's approval (a run from an outside contributor's PR). */
export async function ghApproveRun(w: Writer, exec: Exec, g: Guarded<"approve-ci">, runId: number, details: Details = {}): Promise<ExecResult> {
  exec = await laneExec(w, g, exec);
  return viaGh(w, idOf(w, g), exec, "ci-run-approve", refOf(g.repo, g.number), { ...details, run: runId },
    ["api", "-X", "POST", `repos/${slugOf(g.repo)}/actions/runs/${runId}/approve`], undefined, onceKey(runId));
}

/**
 * Reads the run a rerun is asked for. Refuses (as a failed result) a run that does not belong to the commit: the run id comes
 * from a check's link, which the PR's own CI can set. Otherwise the rerun's once-per-job key (Once): the run and its
 * attempt, as one job may rerun a run again once the rerun failed too. A run still going whose earlier attempt this job
 * reran is the job's own rerun, made before it resumed.
 */
async function rerunOf(identity: string, exec: Exec, repo: string, runId: number, head: string): Promise<{ off: ExecResult } | { key: string; also: string[] }> {
  const fail = (why: string): { off: ExecResult } => ({ off: { code: 1, stdout: "", stderr: `run ${runId} not rerun: ${why}` } });
  try {
    const r = await exec("gh", ["api", `repos/${slugOf(repo)}/actions/runs/${runId}`], identity === "legacy" ? { inherit: true } : undefined);
    // A read that never went out (no installation token) says so: the caller asks again instead of counting a refusal.
    if (r.code !== 0) return r.sent === false ? { off: { ...fail(`the run could not be read: ${oneLine(r.stderr).slice(0, 120)}`).off, sent: false } } : fail("the run could not be read");
    const run = JSON.parse(r.stdout) as { head_sha?: string; run_attempt?: number; status?: string };
    if (run.head_sha !== head) return fail("it belongs to another commit");
    const attempt = typeof run.run_attempt === "number" ? run.run_attempt : 1;
    return { key: onceKey(runId, attempt), also: run.status !== "completed" && attempt > 1 ? [onceKey(runId, attempt - 1)] : [] };
  } catch {
    return fail("the run could not be read");
  }
}

/** Reruns the failed jobs of one Actions run of a PR's head commit. */
export async function ghRerunFailed(w: Writer, exec: Exec, g: Guarded<"cifix">, runId: number, details: Details = {}): Promise<ExecResult> {
  exec = await laneExec(w, g, exec);
  const run = await rerunOf(await idOf(w, g), exec, g.repo, runId, g.head);
  if ("off" in run) return run.off;
  return viaGh(w, idOf(w, g), exec, "ci-rerun", refOf(g.repo, g.number), { ...details, run: runId },
    ["run", "rerun", String(runId), "--failed", "--repo", `${slugOf(g.repo)}`], undefined, run);
}

/** Reruns the failed jobs of one Actions run on a head that belongs to no item (a default-branch head, or an integration batch tip): the audit target names the repo and the commit. */
export async function ghRerunMainFailed(w: Writer, g: GuardedRepo, exec: Exec, o: { repo: string; head: string; runId: number }, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo);
  exec = await laneExec(w, g, exec);
  const run = await rerunOf(await idOf(w, g), exec, o.repo, o.runId, o.head);
  if ("off" in run) return run.off;
  return viaGh(w, idOf(w, g), exec, "ci-rerun", `${o.repo}:${o.head.slice(0, 8)}`, { ...details, run: o.runId },
    ["run", "rerun", String(o.runId), "--failed", "--repo", `${slugOf(o.repo)}`], undefined, run);
}

// ---- git pushes ---------------------------------------------------------------

/** Pushes `sha` to a PR's branch `branch` of `remote` (owner/name); refused by git when the branch is no longer at the guarded head. */
export function pushBranch(w: Writer, git: Pick<Git, "git">, action: string, g: Guarded<AskKind>, o: { remote: string; branch: string; sha: string }, details: Details = {}): Promise<ExecResult> {
  const b = g.action.bucket;
  // The remote is the PR's head repository, which is a fork for an outside PR: only its shape can be checked here.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(o.remote) || o.branch.startsWith("-") || !/^[0-9a-f]{40,64}$/.test(o.sha)) throw new Error("the push target is not a repository and branch");
  if ((g.action.kind === "fixup" && b === "ask") || (g.action.kind === "cifix" && b === "rerun")) throw new Error(`a ${g.action.kind}:${b} grant does not allow a push`);
  return pushed(w, g, git, action, refOf(g.repo, g.number), o, `--force-with-lease=refs/heads/${o.branch}:${g.head}`, details, { repo: g.repo, number: g.number });
}

/**
 * Pushes an autorepin commit (src/repin) to a PR's branch: `sha` on top of `head`, the head the commit was made on, which git
 * refuses when the branch has moved. Under a repo grant for pushes, made for the person who asked for the repin.
 */
export function pushRepin(w: Writer, g: GuardedRepo, git: Pick<Git, "git">, o: { repo: string; number: number; remote: string; branch: string; head: string; sha: string }, details: Details = {}): Promise<ExecResult> {
  covers(g, o.repo);
  if (g.need !== "push") throw new Error(`a grant for ${g.need ?? "no approval"} does not allow a push`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(o.remote) || o.branch.startsWith("-") || !/^[0-9a-f]{40,64}$/.test(o.sha) || !/^[0-9a-f]{40,64}$/.test(o.head)) throw new Error("the push target is not a repository and branch");
  return pushed(w, g, git, "autorepin-push", refOf(o.repo, o.number), o, `--force-with-lease=refs/heads/${o.branch}:${o.head}`, { ...details, from: o.head }, { repo: o.repo, number: o.number });
}

/**
 * Pushes `sha` to `branch` of the pipeline's own fork, replacing the branch. Under a PR grant (a revision of our open PR, whose
 * push outcome this is) the commit goes on top of the guarded head, and git refuses the push when the branch has moved since
 * (a base merge or someone else's push).
 */
export function pushOwnBranch(w: Writer, g: Grant | Guarded<"implement">, git: Pick<Git, "git">, action: string, o: { repo: string; number?: number; remote: string; branch: string; sha: string }, details: Details = {}, /** The push needs the box account whatever the repo's identity (an advisory's private fork, which the app cannot reach). */ asBox = false): Promise<ExecResult> {
  opensOwnPr(g, o.repo);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(o.remote) || o.branch.startsWith("-") || !/^[0-9a-f]{40,64}$/.test(o.sha)) throw new Error("the push target is not a repository and branch");
  const lease = g.scope === "pr" ? `--force-with-lease=refs/heads/${o.branch}:${g.head}` : "--force";
  // A new branch has no PR yet: its outcome is matched to the PR by commit once the PR's checks arrive.
  return pushed(w, g, git, action, o.number === undefined ? `${o.repo}:${o.branch}` : refOf(o.repo, o.number), o, lease, details, { repo: o.repo, number: g.scope === "pr" ? g.number : null }, asBox).then(async (r) => {
    // Without this row the pipeline's own PR at this commit is not counted as its own (a person is asked), so a failed write only holds it.
    if (r.code === 0) try { await addOwnCommits(w.db, [{ repo: o.repo, sha: o.sha, action }]); } catch (e) { console.error(`own commit not recorded: ${oneLine(String((e as Error).message ?? e))}`); }
    return r;
  });
}

async function pushed(w: Writer, g: Guarded | Grant, git: Pick<Git, "git">, action: string, target: string, o: { remote: string; branch: string; sha: string }, lease: string, details: Details, pr: { repo: string; number: number | null }, asBox = false): Promise<ExecResult> {
  // A contributor's fork is outside the installation: that push keeps the installation-wide token.
  if (!asBox) git = await laneGit(w, g, git, o.remote.toLowerCase() === slugOf(g.repo).toLowerCase() ? undefined : { wide: true });
  // A box-account push (an advisory's private fork) is audited as legacy whatever the repo's identity.
  const identity = asBox ? "legacy" : idOf(w, g);
  const own = typeof details.from === "string" && pr.number !== null
    ? { repo: pr.repo, number: pr.number, from: details.from, to: o.sha, action, lines: typeof details.changed === "number" ? details.changed : null } : null;
  const r = await recorded(w, identity, action, target, { ...details, branch: o.branch, remote: o.remote, commit: o.sha },
    async () => {
      // Without this row the new head would look like someone else's push, so a push that cannot be recorded is not made.
      if (own) try { await addOwnPush(w.db, own); } catch (e) { throw markUnsent(e); }
      return await git.git(["push", "--quiet", lease, `https://github.com/${o.remote}.git`, `${o.sha}:refs/heads/${o.branch}`]);
    },
    undefined,
    (r) => (r.code === 0 ? null : oneLine(r.stderr) || `exit code ${r.code}`),
    { key: onceKey(o.remote, o.branch, o.sha), replay: () => ({ code: 0, stdout: "", stderr: "" }) });
  // Also for a push the job's earlier run made: that run may have stopped before recording it (a push is recorded once).
  if (r.code === 0) {
    // The push stands even when its bookkeeping cannot be written; the outcome stays unknown then.
    if (own) try { await landOwnPush(w.db, own); } catch (e) { console.error(`push not recorded as done: ${oneLine(String((e as Error).message ?? e))}`); }
    try { await addPushOutcomes(w.db, [{ action, ...pr, from: typeof details.from === "string" ? details.from : null, to: o.sha, base: typeof details.base === "string" ? details.base : null }]); } catch (e) { console.error(`push outcome not recorded: ${oneLine(String((e as Error).message ?? e))}`); }
  }
  return r;
}

// ---- security fixes ------------------------------------------------------------
// Rows of these actions are not in GITHUB_ACTIONS: no feed, activity page or live topic shows them to viewers.

/** What a quiet pull request may say: refuses any text that names the problem. Checked here, so no caller can skip it. */
function assertQuiet(...texts: string[]): void {
  for (const t of texts) {
    const w = giveaway(t);
    if (w) throw new Error(`a landing write may not mention "${w}"`);
  }
}

/** The HTTP status in gh's error text, or null. */
export const httpStatus = (r: ExecResult): number | null => {
  const text = `${r.stderr} ${r.stdout}`;
  // gh prints "HTTP 403"; git prints "The requested URL returned error: 403" or "Permission to <repo> denied".
  const m = /HTTP (\d{3})/.exec(text) ?? /returned error: (\d{3})/.exec(text);
  return m ? Number(m[1]) : /Permission to .* denied/i.test(text) ? 403 : /not found/i.test(text) ? 404 : null;
};

/** Pushes the fix commit to the pipeline's fork under a neutral branch name: the quiet landing's push. */
export async function ghLandPush(w: Writer, g: Grant, git: Pick<Git, "git">, o: { repo: string; fork: string; branch: string; sha: string; base: string; key: string }): Promise<ExecResult> {
  // The pushed commit is public with its branch: its message is checked as well as the branch name.
  const message = await git.git(["log", "-1", "--format=%B", o.sha]);
  if (message.code !== 0) throw new Error("the commit message could not be read");
  assertQuiet(o.branch, message.stdout);
  return pushOwnBranch(w, g, git, "security-land-push", { repo: o.repo, remote: o.fork, branch: o.branch, sha: o.sha }, { base: o.base, finding: o.key });
}

/** Opens the quiet pull request: plain title and body, neutral branch. */
export function ghLandPr(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; base: string; head: string; title: string; body: string }, note: Note): Promise<ExecResult> {
  assertQuiet(o.head, o.title, o.body);
  return ghOpenPr(w, g, exec, "security-land", { repo: o.repo, target: o.key, base: o.base, head: o.head, title: o.title, body: o.body }, note, {});
}

const json = (v: unknown): string => JSON.stringify(v);

/** Creates the repository's draft advisory (private to admins and security managers). The text is not kept in the audit row. */
export async function ghAdvisoryCreate(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; summary: string; description: string; severity: "critical" | "high" | "medium" | "low"; range: string; patched?: string | null }): Promise<{ ghsa: string | null; result: ExecResult }> {
  covers(g, o.repo);
  const body = json({ summary: o.summary, description: o.description, severity: o.severity, vulnerabilities: [{ package: { ecosystem: "other", name: o.repo }, vulnerable_version_range: o.range, patched_versions: o.patched ?? null }] });
  const result = await recorded(w, "legacy", "security-advisory", o.key, { repo: o.repo },
    () => exec("gh", ["api", "-X", "POST", `repos/${slugOf(o.repo)}/security-advisories`, "--input", "-", "--jq", ".ghsa_id"], { input: body, inherit: true }),
    (r) => ({ ghsa: r.stdout.trim() || undefined }),
    (r) => (r.code === 0 && r.stdout.trim() ? null : oneLine(r.stderr || r.stdout) || `exit code ${r.code}`),
    // One draft advisory per finding.
    { key: onceKey(o.repo), lasting: true, replay: (d) => ({ code: 0, stdout: typeof d.ghsa === "string" ? d.ghsa : "", stderr: "" }),
      find: async (since, taken) => { const ghsa = await advisoryMade(ghRead((cmd, args) => exec(cmd, args, { inherit: true })), { repo: o.repo, summary: o.summary, description: o.description, since, taken }); return ghsa === null ? null : { ghsa }; } });
  return { ghsa: result.code === 0 ? result.stdout.trim() || null : null, result };
}

/** Creates the advisory's temporary private fork; returns its owner/name. */
export async function ghAdvisoryFork(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; ghsa: string }): Promise<{ fork: string | null; result: ExecResult }> {
  covers(g, o.repo);
  const result = await recorded(w, "legacy", "security-advisory-fork", o.key, { repo: o.repo, ghsa: o.ghsa },
    () => exec("gh", ["api", "-X", "POST", `repos/${slugOf(o.repo)}/security-advisories/${o.ghsa}/forks`, "--jq", ".full_name"], { inherit: true }),
    (r) => ({ fork: r.stdout.trim() || undefined }),
    (r) => (r.code === 0 && r.stdout.trim() ? null : oneLine(r.stderr || r.stdout) || `exit code ${r.code}`),
    { key: onceKey(o.ghsa), replay: (d) => ({ code: 0, stdout: typeof d.fork === "string" ? d.fork : "", stderr: "" }) });
  return { fork: result.code === 0 ? result.stdout.trim() || null : null, result };
}

/** Pushes the fix to the advisory's private fork with the box user's token: the GitHub App cannot reach these forks. */
export function ghAdvisoryPush(w: Writer, g: Grant, git: Pick<Git, "git">, o: { repo: string; fork: string; branch: string; sha: string; key: string }): Promise<ExecResult> {
  return pushOwnBranch(w, g, git, "security-advisory-push", { repo: o.repo, remote: o.fork, branch: o.branch, sha: o.sha }, { finding: o.key }, true);
}

/** Opens the fix pull request inside the private fork. */
export function ghAdvisoryPr(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; fork: string; base: string; head: string; title: string; body: string }): Promise<ExecResult> {
  covers(g, o.repo);
  return viaGh(w, "legacy", exec, "security-advisory-pr", o.key, { repo: o.repo, fork: o.fork },
    ["pr", "create", "--repo", o.fork, "--base", o.base, "--head", o.head, "--title", scrub(o.title), "--body-file", "-"], scrub(o.body), onceKey(o.fork, o.base, o.head));
}

/** Sets the affected version range of a draft that has none (GitHub refuses to publish without one). Does nothing, and writes nothing, when the draft has a range. */
export async function ghAdvisoryRange(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; ghsa: string; range: () => Promise<string> }): Promise<ExecResult | null> {
  covers(g, o.repo);
  const url = `repos/${slugOf(o.repo)}/security-advisories/${o.ghsa}`;
  const cur = await exec("gh", ["api", url, "--jq", "[.vulnerabilities[]?.vulnerable_version_range // empty | select(. != \"\")] | length"], { inherit: true });
  if (cur.code === 0 && cur.stdout.trim() !== "0") return null;
  const range = await o.range();
  return viaGh(w, "legacy", exec, "security-advisory-range", o.key, { repo: o.repo, ghsa: o.ghsa },
    ["api", "-X", "PATCH", url, "--input", "-"], json({ vulnerabilities: [{ package: { ecosystem: "other", name: o.repo }, vulnerable_version_range: range, patched_versions: null }] }));
}

/** Publishes the draft advisory; a published advisory deletes its private fork. */
export function ghAdvisoryPublish(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; ghsa: string }): Promise<ExecResult> {
  covers(g, o.repo);
  return viaGh(w, "legacy", exec, "security-publish", o.key, { repo: o.repo, ghsa: o.ghsa },
    ["api", "-X", "PATCH", `repos/${slugOf(o.repo)}/security-advisories/${o.ghsa}`, "--input", "-"], json({ state: "published" }));
}

/** Requests a CVE for the advisory (public repositories only). */
export function ghAdvisoryCve(w: Writer, g: Grant, exec: Exec, o: { repo: string; key: string; ghsa: string }): Promise<ExecResult> {
  covers(g, o.repo);
  return viaGh(w, "legacy", exec, "security-cve", o.key, { repo: o.repo, ghsa: o.ghsa }, ["api", "-X", "POST", `repos/${slugOf(o.repo)}/security-advisories/${o.ghsa}/cve`], undefined, onceKey(o.ghsa));
}

// ---- merges ---------------------------------------------------------------------

export type CommandResult = { code: number; stdout: string; stderr: string };

/** Set on the child that `mergeViaCommand` starts, so the child does not record the same merge again. */
export const MERGE_RECORDED_ENV = "AUTOCRAFT_MERGE_RECORDED";

/**
 * Runs the merge command for the guarded PR and records the merge or the refusal. The command gets
 * `OWNER/REPO PR --squash|--merge <extra> --head <guarded head>`, and must refuse when GitHub's head
 * differs from that head. Every merge command, the built-in safe-merge and any `$AUTOCRAFT_MERGE_CMD`, takes `--head` as part of this contract.
 * `env`, when given, is the command's whole environment (a user's token replaces the box's).
 */
export async function mergeViaCommand(w: Writer, run: (cmd: string, args: string[], env?: Record<string, string>) => Promise<CommandResult>, cmd: string, g: Guarded<"merge">, o: { method: "squash" | "merge"; extra?: string[] }, details: Details = {}, landed?: () => Promise<boolean>, env?: Record<string, string>): Promise<CommandResult> {
  const args = [`${slugOf(g.repo)}`, String(g.number), `--${o.method}`, ...(o.extra ?? []), "--head", g.head];
  const repo = g.repo;
  const method: string = o.method;
  const base = { ...details, method, identity: await idOf(w, g, "merge"), ...jobOf() };
  const target = refOf(repo, g.number);
  effect("github-write");
  const id = await begin(w, "merge", target, base);
  let r: CommandResult;
  try {
    if (await inAppLane(w, g, "merge")) {
      // The merge command runs with the installation token as its whole environment.
      try { r = await run(cmd, args, await appEnv(w, g)); } catch (e) { if (!String((e as Error).message).startsWith("app identity:")) throw e; r = failedResult(e); }
    } else r = await run(cmd, args, env);
  } catch (e) {
    await finish(w, id, base, oneLine(String((e as Error).message ?? e)));
    throw e;
  }
  if (r.code === 0) {
    await finish(w, id, { ...base, commit: r.stdout.match(/\bMERGED ([0-9a-f]{7,40})\b/)?.[1] });
    return r;
  }
  // The command can fail after GitHub merged (the check afterwards), so the caller may confirm the merge landed.
  if (await landed?.().catch(() => false)) await finish(w, id, { ...base, note: "landed after the command reported an error" });
  else await finish(w, id, base, oneLine(r.stderr || r.stdout) || `exit code ${r.code}`);
  return r;
}

/**
 * The merge itself: `gh pr merge` pinned to `head`. `record` starts the activity row and returns the function that
 * finishes it; it is absent when a parent process already records the merge.
 */
export async function ghMergePr(gh: (args: string[]) => Promise<string>, repo: string, pr: string, method: "--squash" | "--merge", head: string, record?: () => Promise<(error?: string) => void>): Promise<void> {
  const end = await record?.();
  try {
    await gh(["pr", "merge", pr, "-R", repo, method, "--match-head-commit", head]);
  } catch (e) {
    end?.(oneLine(String((e as Error).message ?? e)));
    throw e;
  }
  end?.();
}

/** Records a merge made from the command line, in the database `connect()` opens, under the login `cli`. */
export function cliMergeRecorder(repoSlug: string, pr: string, method: string, head: string): () => Promise<(error?: string) => Promise<void>> {
  return async () => {
    const w: Writer = { db: await openDb(), login: "cli" };
    // The command line runs as the box account whatever the repo's setting.
    const details = { method: method.slice(2), head, identity: "legacy" };
    let id: number;
    try {
      id = await begin(w, "merge", `${repoName(repoSlug)}#${Number(pr)}`, details, splitSlug(repoSlug).owner);
    } catch (e) {
      await w.db.close();
      throw e;
    }
    return async (error) => {
      try {
        await finish(w, id, details, error);
      } finally {
        await w.db.close();
      }
    };
  };
}

// ---- Organization roles -----------------------------------------------------

/**
 * Gives `user` an organization role with the org owner's own token (GitHub
 * documents this only for OAuth tokens with admin:org). The token goes to the
 * call and nowhere else: the audit row names the org, user and role.
 */
export function grantOrgRole(w: Writer, o: { org: string; user: string; role: { id: number; name: string }; token: string; apiBase?: string }): Promise<void> {
  return recorded(w, `user:${w.login}`, "github-app-manager", o.org, { user: o.user, role: o.role.name, roleId: o.role.id },
    () => call(o.apiBase ?? GITHUB_API, `/orgs/${encodeURIComponent(o.org)}/organization-roles/users/${encodeURIComponent(o.user)}/${o.role.id}`, o.token, "PUT").then(() => undefined));
}

// ---- GitHub App installations ------------------------------------------------

/**
 * Uninstalls the GitHub App from one account with the app's own JWT; src/github/allowed-owners.ts decides which. Made
 * as the app itself, which no grant names; audited as `app-install-removed` on the account's login, with the
 * installation id, the account's id and what found it (`webhook` or `sweep`). GitHub's 404 means it is gone already:
 * recorded done with `already`, and the answer is true.
 */
export function removeInstallation(w: Writer, o: { app: Pick<AppSecrets, "clientId" | "privateKey">; installationId: number; account: string; accountId: number | null; found: "webhook" | "sweep"; apiBase?: string }): Promise<boolean> {
  const identity = "app";
  const gone = (e: unknown): boolean => { if (e instanceof AppError && e.status === 404) return true; throw e; };
  return recorded(w, identity, "app-install-removed", o.account, { installation: o.installationId, account: o.account, accountId: o.accountId, found: o.found },
    () => call(o.apiBase ?? GITHUB_API, `/app/installations/${o.installationId}`, appJwt(o.app), "DELETE").then(() => false, gone), (already) => (already ? { already: true } : {}), undefined, undefined, o.account);
}

/**
 * Asks GitHub to send a webhook delivery that failed again (`POST /app/hook/deliveries/{id}/attempts`), as the app itself; audited as
 * `webhook-redeliver` on the delivery's GUID. A redelivery is safe to receive twice: it queues re-reads, and a comment's command once.
 */
export function redeliverWebhook(w: Writer, o: { app: Pick<AppSecrets, "clientId" | "privateKey"> & { owner?: AppOwner | null }; id: string; guid: string; event: string; apiBase?: string }): Promise<void> {
  const identity = "app";
  return recorded(w, identity, "webhook-redeliver", o.guid, { delivery: o.id, event: o.event },
    () => call(o.apiBase ?? GITHUB_API, `/app/hook/deliveries/${o.id}/attempts`, appJwt(o.app), "POST").then(() => undefined), undefined, undefined, undefined, o.app.owner?.login);
}
