// Act stage: carries out what people told AutoCraft to close, and posts the comments that ask a pull request's author for more work. A close command, on any surface, queues a person action
// (`workflow_actions`, kinds close and comment-close; src/workflow/effects.ts). The planner lists the item for this step while the
// action is due (core/decide-item.ts), and the step posts one short comment from a fixed template (close: none) and closes the item.
//
// Under the app's identity the close is made as the person, with their own token (src/github/user-lane.ts); the comment is the
// app's. A person with no usable sign-in, or no write access, leaves the action waiting until they sign in. The item is read live
// first: one that is closed already ends the action as done, and a pull request that got commits after the command is left open. A
// later stop, backlog or start command takes the action back, also between the two writes. Only in repos approved for comments. Merges
// made as a person are the merge stage's (src/merge). No model calls.
//
// The same job runs the queued presses of conversation cards and files the issues held until their pull request merged.
//
//   autocraft-server act --repo R [--limit N] [--apply]
//   autocraft-server comment-approval [--repo R]
import { CLI_BY, type By } from "../core/gates.ts";
import { guardItem } from "../core/guard.ts";
import { actRoom } from "../conversations/queue.ts";
import { addAudit, loadTrackedRepos } from "../data/control/index.ts";
import { applyLocal } from "../data/mirror/index.ts";
import { addStageEvents } from "../data/planner/index.ts";
import { listWorkflows, loadActions, loadActionsDue, saveActions, type ActionState, type DueAction } from "../data/workflow/index.ts";
import { authorAsk, type AuthorAsk } from "../workflow/types.ts";
import { authorUnaskableOf } from "../workflow/effects.ts";
import { authorNotAsked } from "../workflow/advance.ts";
import { chainsOwn } from "../core/evidence.ts";
import { loadOwnPushes } from "../data/views/own-pushes.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import type { Exec } from "../fixup/git.ts";
import { authFailure, laneForAction, noWriteReason, setExecState, SIGN_IN_REASON, type LaneDeps } from "../github/user-lane.ts";
import { closeItem, commentOn, duplicateClose, UnsettledError, WritePacedError, type CloseHow, type Writer } from "../github/write.ts";
import { Client, Transient, type Querier } from "../mirror.ts";
import { jobItem } from "../runner/job-items.ts";
import { commentApprovalOf } from "./approval.ts";
import { CLOSE_KINDS } from "./gone.ts";
import { readLive, type Live } from "./live.ts";
import { stillActs } from "./still.ts";
import type { RefreshDeps } from "../preapproval/permissions.ts";
import { closeComment, duplicateComment } from "./templates.ts";

const ACTOR = "act";

export type ActDeps = { querier: Querier; now: () => Date; /** The user lane's token source and transports; default: the secrets file's app. */ lane?: LaneDeps; /** Replaces the app lane's token minter and client (tests). */ app?: Pick<Writer, "mint" | "appClient">; /** Stands in for the GitHub App's read of the person's write permission (tests). */ permission?: RefreshDeps["permission"]; /** Runs `gh` for the held follow-up issues (tests). */ exec?: Exec };
export const defaultDeps = (): ActDeps => ({ querier: new Client(1000), now: () => new Date() });

export type ActParams = {
  repo: string;
  /** Most items to attempt in this run. */
  limit?: number;
  /** Default true: only `dryRun: false` comments or closes. */
  dryRun?: boolean;
  onHandled?: (n: number) => void;
  /** Who asked; default: an operator at the command line. */
  by?: By;
};

export type ActSummary = {
  repo: string; dryRun: boolean;
  done: string[]; skipped: { ref: string; reason: string }[]; failed: { ref: string; reason: string }[];
  /** Queued card presses carried out by this run. */
  cards?: number;
  /** Follow-up issues held until the merge that this run filed or dropped (src/conversations/held.ts). */
  held?: number;
  /** The write pacing's message when it held back a write. */
  paced?: string;
  note: string | null;
};

/** A close that fails this many times (not for a missing sign-in or access) has failed: the person sends the command again. */
export const ACT_MAX_ATTEMPTS = 3;

const refOf = (e: { repo: string; number: number }) => `${e.repo}#${e.number}`;
const short = (sha: string | null) => (sha ?? "none").slice(0, 7);
const oneLine = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 300);

/** The item a duplicate close names, from the action's `close_as`. */
export function duplicateOf(closeAs: string | null): { repo: string; number: number } | null {
  const m = /^duplicate ([\w.-]+)#(\d+)$/.exec(closeAs ?? "");
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

/** The action is still to be carried out: nobody took it back. */
const stands = async (db: Db, a: DueAction): Promise<boolean> =>
  [...(await loadActions(db, { refs: [{ repo: a.repo, number: a.number }], kinds: CLOSE_KINDS, states: ["pending"] })).values()].flat().some((x) => x.id === a.id);

/** An error that points at GitHub or the network, not at the target: a 5xx status, a timeout, a dropped connection or a rate limit. */
export function githubWide(e: unknown): boolean {
  if (e instanceof Transient) return true;
  if (e instanceof UnsettledError) return githubWide(e.cause);
  const status = Number((e as { status?: unknown })?.status ?? 0);
  if (status >= 500 || status === 429) return true;
  return /\b(HTTP|status)\s*:?\s*5\d\d\b|timed? ?out|ETIMEDOUT|ECONN\w*|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|rate.?limit|abuse detection|bad gateway|service unavailable/i.test(String((e as Error)?.message ?? e));
}

export async function runAct(db: Db, params: ActParams, log: (line: string) => void = console.log, deps?: ActDeps): Promise<ActSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const d = deps ?? defaultDeps();
  const now = () => d.now();
  const summary: ActSummary = { repo, dryRun, done: [], skipped: [], failed: [], note: null };
  let cardWrites = 0;
  if (!dryRun) {
    // Queued card presses run first, from the same shared daily count: they were pressed before this run, and each is held to the presser's current access.
    const { drainQueuedCards } = await import("../conversations/act.ts");
    const drained = await drainQueuedCards(db, { now: deps?.now, querier: deps?.querier, permission: deps?.permission }, params.limit === undefined ? {} : { writes: params.limit });
    cardWrites = drained.writes;
    summary.cards = drained.ran;
    if (drained.ran) log(`act: ${drained.ran} queued card press${drained.ran === 1 ? "" : "es"} carried out`);
    // Issues the cards held until the PR merged: filed once it merged, dropped once it closed or its merge path ended. Each guards the repo it opens in.
    const { fileHeldFollowups } = await import("../conversations/held.ts");
    const held = await fileHeldFollowups(db, repo, { now: deps?.now, exec: deps?.exec, permission: deps?.permission }, params.limit === undefined ? {} : { writes: Math.max(0, params.limit - cardWrites) });
    cardWrites += held.writes;
    summary.held = held.filed + held.dropped;
    summary.failed.push(...held.failed);
    if (held.paced) summary.paced = held.paced;
    if (held.filed || held.dropped) log(`act: ${held.filed} held follow-up issue${held.filed === 1 ? "" : "s"} filed, ${held.dropped} dropped`);
    if (held.unknown) log(`act: a held follow-up issue was being created when the answer was lost; it may exist, check GitHub`);
  }
  // Each close is a person's command, which is its approval in any repo (gates); they must still be able to act on it.
  // Heaviest workflow first, then in the order of the commands.
  let todo = await loadActionsDue(db, { repos: [repo], kinds: [...CLOSE_KINDS, "ask-author"] });
  if (params.limit !== undefined) todo = todo.slice(0, Math.max(0, params.limit - cardWrites));
  if (dryRun) {
    for (const a of todo) log(a.kind === "ask-author" ? `  would ask the author of ${refOf(a)}` : `  would close ${refOf(a)}${a.close_as ? ` (${a.close_as})` : ""} as ${a.by}`);
    log(`act ${repo}: dry run, nothing called or written`);
    summary.done = todo.map(refOf);
    return summary;
  }

  let handled = 0;
  for (const a of todo) {
    // The daily count is shared with card presses; one close is one count.
    if (!await actRoom(db, 1, now().getTime())) { summary.note = "the daily limit is reached"; break; }
    const o = { deps: d, by: params.by ?? CLI_BY, log, started: () => { handled++; params.onHandled?.(handled); } };
    const r = a.kind === "ask-author" ? await askOne(db, a, o) : await closeOne(db, a, o);
    if (r.kind === "done") summary.done.push(refOf(a));
    else if (r.kind === "skipped") summary.skipped.push({ ref: refOf(a), reason: r.reason });
    else if (r.kind === "failed") summary.failed.push({ ref: refOf(a), reason: r.reason });
    else if (r.kind === "stop") { summary.failed.push({ ref: refOf(a), reason: r.reason }); break; }
    else if (r.kind === "paced") { summary.paced = r.reason; break; }
  }
  log(`act ${repo}: ${summary.done.length} closed, ${summary.skipped.length} skipped, ${summary.failed.length} failed`);
  return summary;
}

/** `left`: not carried out now, and not this run's failure. `stop` and `paced` end the run. */
type Ended = { kind: "done" | "left" } | { kind: "skipped" | "failed" | "stop" | "paced"; reason: string };

async function closeOne(db: Db, a: DueAction, o: { deps: ActDeps; by: By; log: (line: string) => void; started: () => void }): Promise<Ended> {
  const { deps: d, log } = o;
  const at = () => d.now().toISOString();
  const say = (text: string) => jobItem(db, a.repo, a.number, text, log);
  const save = (state: ActionState, reason: string | null, more: { commentUrl?: string; attempts?: number } = {}, from?: ActionState[]) =>
    saveActions(db, [{ id: a.id, state, reason, at: at(), ...more }], from ? { from } : {});
  const end = async (state: "done" | "skipped" | "stopped", reason: string): Promise<Ended> => {
    await db.write(async () => {
      await save(state, reason, {}, ["pending"]);
      await addAudit(db, [{ login: ACTOR, action: "act-skip", target: refOf(a), details: { action: a.id, by: a.by, reason } }]);
    });
    await say(`${state === "done" ? "nothing to close" : "not closed"}: ${reason}`);
    return { kind: "skipped", reason };
  };
  const left = async (text: string): Promise<Ended> => { await say(text); return { kind: "left" }; };

  const lr = await laneForAction(db, d.lane, a, [a.repo]);
  if (lr && !("lane" in lr)) {
    if ("transient" in lr) return left(`not closed yet: ${lr.transient}`);
    await setExecState(db, a.id, lr.state, lr.reason, at());
    return left(`waiting: ${lr.reason}`);
  }
  // Counted once the close has a lane: a waiting or transient one is not work done, so the planner can settle.
  o.started();
  const lane = lr?.lane ?? null;
  const q = lane?.querier ?? d.querier;
  const w: Writer = { db, login: ACTOR, ...d.app };
  // Only a read or the close itself goes out with the person's token; the comment is the app's.
  let asPerson = lane !== null;
  let commentUrl = a.comment_url;
  try {
    const may = await stillActs(db, a.by, [a.repo], { live: lane !== null, permission: d.permission });
    if (!may.ok) return may.standing === "no" ? await end("stopped", `${a.by} may no longer act on ${a.repo}`) : await left(`not closed yet: GitHub has not answered on ${a.by}'s access to ${a.repo}`);
    const live = await readLive(q, a.repo, a.number);
    if (!live) return await end("skipped", "GitHub returned no such item");
    if (live.state !== "OPEN") return await end("done", `already ${live.state.toLowerCase()} on GitHub`);
    if (live.type === "PullRequest" && live.head !== a.head) return await end("skipped", `the pull request changed after the command (${short(a.head)} → ${short(live.head)})`);
    const dup = duplicateOf(a.close_as);
    const original = dup ? await readLive(q, dup.repo, dup.number) : null;
    if (dup && !original) return await end("skipped", `GitHub returned no ${dup.repo}#${dup.number}`);

    const g = await guardItem(db, { repo: a.repo, number: a.number }, { kind: "act", bucket: "close", id: a.id }, o.by, a.by);
    if ("refused" in g) return await left(`not closed: ${g.refused}`);
    const source = { action: a.id, workflow: a.workflow_id, by: a.by };
    // Read again after every await above: a stop that landed meanwhile keeps the write from being made.
    if (!await stands(db, a)) return await left("not closed: the close was taken back");
    if (a.kind === "comment-close" && commentUrl === null) {
      asPerson = false;
      commentUrl = await commentOn(w, g, q, "act-comment", { repo: a.repo, number: a.number, id: live.id }, { by: "fixed-operator" }, commentFor(a, live, dup, original), source);
      asPerson = lane !== null;
      // Saved before the close so a retry after a failed close does not comment twice.
      await save("pending", "comment posted; close not done yet", { commentUrl }, ["pending"]);
      if (!await stands(db, a)) return await left("not closed: the close was taken back");
    }
    await closeItem(w, g, q, { repo: a.repo, number: a.number, id: live.id, pr: live.type === "PullRequest" }, { ...source, head: live.head }, closeHow(a.close_as, dup, original));
    await db.write(async () => {
      await save("done", null);
      await applyLocal(db, [{ kind: "state", repo: a.repo, number: a.number, state: "CLOSED", at: at() }]);
      await addStageEvents(db, [{ repo: a.repo, number: a.number, stage: "closed", at: at(), actor: ACTOR, note: `closed as ${a.by} asked` }]);
    });
    await say(a.kind === "close" ? "closed" : "commented and closed");
    return { kind: "done" };
  } catch (e) {
    const why = oneLine(e);
    if (e instanceof WritePacedError) return { kind: "paced", reason: why };
    const denied = asPerson ? authFailure(e) : null;
    if (denied === "transient") return await left(`not closed yet: ${why}`);
    if (denied) {
      // The person's token may not do this write: wait for access instead of failing, and write nothing as anyone else.
      await save(denied, denied === "waiting-token" ? SIGN_IN_REASON : noWriteReason(a.repo), {}, ["pending"]);
      return await left(`waiting: ${why}`);
    }
    // An error of GitHub itself (a server error, timeout, network failure, rate limit) says nothing about this item: the run stops, no try is counted,
    // and the job ends as failed so the registered failure backoff applies.
    if (githubWide(e)) {
      await say(`GitHub is failing, stopping: ${why}`);
      return { kind: "stop", reason: why };
    }
    // The comment of a retry that already posted it is not repeated. After ACT_MAX_ATTEMPTS failed tries the close has failed; the
    // others go on. The job ends as failed (see the step), so the registered failure backoff spaces the tries.
    const attempts = a.attempts + 1;
    const last = attempts >= ACT_MAX_ATTEMPTS;
    const shown = last ? `stopped after ${attempts} failed tries: ${why}` : why;
    await db.write(async () => {
      await save(last ? "failed" : "pending", shown, { attempts }, ["pending"]);
      if (last) await addAudit(db, [{ login: ACTOR, action: "act-stopped", target: refOf(a), details: { action: a.id, by: a.by, reason: why, attempts } }]);
    });
    await say(`failed: ${shown}`);
    return { kind: "failed", reason: shown };
  }
}

/**
 * Posts the comment of a workflow's author ask (src/workflow/effects.ts queueAuthorAsk) as the app: only while the workflow still waits
 * for the author at the head it was asked at (or our own pushes on top of it), and the PR is open there. A person's command is its
 * approval; an ask the review made acts for the person who started the work (core/gates.ts). An ask that ends without its comment, while
 * the workflow still waits with it, brings the workflow back to the person with the reason (authorNotAsked): it never waits for a
 * comment nobody got. A bot, AutoCraft itself or a quiet PR's author is never asked.
 */
async function askOne(db: Db, a: DueAction, o: { deps: ActDeps; by: By; log: (line: string) => void; started: () => void }): Promise<Ended> {
  const { deps: d, log } = o;
  const at = () => d.now().toISOString();
  const say = (text: string) => jobItem(db, a.repo, a.number, text, log);
  const pr = { repo: a.repo, number: a.number };
  /** `back`: the ask the workflow still waits with, which comes back to the person; `again`: their yes asks the author again. */
  const end = async (reason: string, back: AuthorAsk | null, again = true): Promise<Ended> => {
    await saveActions(db, [{ id: a.id, state: "skipped", reason, at: at() }], { from: ["pending"] });
    await say(`author not asked: ${reason}`);
    if (back && await authorNotAsked(db, a.workflow_id, back, reason, again, at())) await say("the question comes back to the person");
    return { kind: "skipped", reason };
  };
  o.started();
  const ask = authorAsk((await listWorkflows(db, { ids: [a.workflow_id] }))[0] ?? null);
  if (!ask || ask.head !== a.head) return await end("the work no longer waits for the author there", null);
  const no = await authorUnaskableOf(db, pr);
  if (no) return await end(no, ask, false);
  try {
    const live = await readLive(d.querier, a.repo, a.number);
    if (!live) return await end("GitHub returned no such item", ask);
    // A merged or closed PR ends its workflow (src/workflow/advance.ts): nothing comes back.
    if (live.state !== "OPEN") return await end(`already ${live.state.toLowerCase()} on GitHub`, null);
    if (live.head !== a.head && !(a.head && live.head && chainsOwn((await loadOwnPushes(db, [pr])).get(`${a.repo}#${a.number}`) ?? [], a.head, live.head))) {
      return await end(`the pull request changed after the ask (${short(a.head)} → ${short(live.head)})`, ask);
    }
    const g = await guardItem(db, pr, { kind: "act", bucket: "close", id: a.id }, o.by, a.by);
    if ("refused" in g) { await say(`author not asked yet: ${g.refused}`); return { kind: "left" }; }
    if (authorAsk((await listWorkflows(db, { ids: [a.workflow_id] }))[0] ?? null)?.at !== ask.at) return await end("the ask changed", null);
    const w: Writer = { db, login: ACTOR, ...d.app };
    const url = await commentOn(w, g, d.querier, "act-comment", { ...pr, id: live.id }, ask.auto ? { by: "fixed" } : { by: "fixed-operator" }, ask.text, { action: a.id, workflow: a.workflow_id, by: a.by, head: a.head });
    await saveActions(db, [{ id: a.id, state: "done", reason: null, commentUrl: url, at: at() }], { from: ["pending"] });
    await say("asked the author");
    return { kind: "done" };
  } catch (e) {
    const why = oneLine(e);
    if (e instanceof WritePacedError) return { kind: "paced", reason: why };
    if (githubWide(e)) { await say(`GitHub is failing, stopping: ${why}`); return { kind: "stop", reason: why }; }
    const attempts = a.attempts + 1, last = attempts >= ACT_MAX_ATTEMPTS;
    const shown = last ? `stopped after ${attempts} failed tries: ${why}` : why;
    await saveActions(db, [{ id: a.id, state: last ? "failed" : "pending", reason: shown, attempts, at: at() }], { from: ["pending"] });
    await say(`author not asked: ${shown}`);
    if (last && await authorNotAsked(db, a.workflow_id, ask, shown, true, at())) await say("the question comes back to the person");
    return { kind: "failed", reason: shown };
  }
}

const commentFor = (a: DueAction, live: Live, dup: { repo: string; number: number } | null, original: Live | null): string =>
  dup && original
    ? duplicateComment({ repo: a.repo, original: `${dup.repo}#${dup.number}`, closed: original.state !== "OPEN" })
    : closeComment({ pr: live.type === "PullRequest", as: a.close_as });

/** GitHub's reason for the close; an issue closed without one gets GitHub's default. */
function closeHow(closeAs: string | null, dup: { repo: string; number: number } | null, original: Live | null): CloseHow | undefined {
  if (dup && original) return duplicateClose({ id: original.id, pr: original.type === "PullRequest" }, `${dup.repo}#${dup.number}`);
  return closeAs === "completed" ? "COMPLETED" : closeAs === "not-planned" ? "NOT_PLANNED" : undefined;
}

// ---- CLI -----------------------------------------------------------------------

function parseArgs(args: string[]): { repo: string; limit?: number; apply: boolean } {
  let repo: string | undefined, limit: number | undefined, apply = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo") repo = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else throw new Error(`unknown option ${a}; options: --repo R --limit N --apply --dry-run`);
  }
  if (!repo) throw new Error("missing --repo");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new Error("--limit is a whole number");
  return { repo, limit, apply };
}

export const commands = {
  act: {
    summary: "act --repo R [--limit N] [--apply]: comment on and close the items people told AutoCraft to close, as them (dry run unless --apply)",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runAct(await openDb(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  "comment-approval": {
    summary: "comment-approval [--repo R]: which repos an operator approved for comments and closes",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--repo");
      const db = await openDb();
      const repos = i >= 0 ? [args[i + 1]!] : [...(await loadTrackedRepos(db)).keys()].sort();
      for (const r of repos) {
        const a = await commentApprovalOf(db, r);
        console.log(`${r}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};
