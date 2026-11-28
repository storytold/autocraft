// Commands to the GitHub App in a GitHub comment. A comment line that starts with `@<app-slug>` is an answer: the text after the
// mention is read by the workflow parser (src/workflow/parse.ts parseComment) and run by the command core (src/workflow/apply.ts
// runCommand, via github), the same words as on every other surface (`@<app-slug> fix-up and merge`, `@<app-slug> yes`,
// `@<app-slug> drop 2`, `@<app-slug> autorepin <pull request>`). `merge queue` is read as `merge`. A comment acts on the item it is
// written on: a list naming another item, or several, runs nothing. The app answers in the thread with the confirmation line, or
// with what it understood when the text was not clear. A comment without the mention runs nothing.
//
// `@<app-slug> ask <question>` (and a comment a model reads as only a question) is no command: the question goes to Opus as the
// commenter's message on the item (src/conversations/ask.ts), from an operator or a maintainer with write access, and the command waits
// (state `asked`) until the answer settles it; the drain then posts the answer as the reply.
//
// The webhook keeps only the fields of github_commands (the parsed result, never the comment's text), and nothing of it reaches a
// prompt. The runner carries the command out: the commenter must have an AutoCraft login with the GitHub id bound to it, the
// comment must still exist with the same command in it, and then the act rule applies (actRefusal in src/github/identity.ts), with the write
// permission read from GitHub through the app now. A viewer gets no answer. A commenter without a bound AutoCraft login gets at
// most one "link your account" answer a week, and only when GitHub reports write access on the repo, so a stranger cannot make the
// app write. Answers go through write.ts.
import { actorOf, type AccessRow } from "../data/access/index.ts";
import { requestReadsAfter } from "../data/mirror/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import {
  loadCommandWork, loadNudges, markQuestionShown, pruneCommands as pruneCommandRows, queueCommands, recordNudges, saveCommandProgress, settleCommands, type CommandRow, type CommandState,
} from "../data/workflow/index.ts";
import { guardRepo } from "../core/guard.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import type { Querier } from "../mirror.ts";
import { LOGIN } from "../access.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { appPermission, type AppPermission } from "../remote/permission.ts";
import { AppError, call, GITHUB_API } from "./app.ts";
import { actRefusal, appSlug, isOwnLogin, ownLogins } from "./identity.ts";
import { commentNames } from "./slugs.ts";
import { installationToken } from "./install-token.ts";
import { ghComment, WritePacedError, type Writer } from "./write.ts";
import { envVar } from "../env.ts";
import { t } from "../i18n/index.ts";
import { runCommand, type Actor, type CommandResult } from "../workflow/apply.ts";
import { namesOption, READ_BACKGROUND_WAIT_MS, runText, type ReadDeps } from "../workflow/read.ts";
import { commentLines } from "./comment-lines.ts";
import { commentCondition, commentQuestion, parseComment, withoutMention } from "../workflow/parse.ts";
import { linkAskTurn, linkingComment, recordSaid } from "../workflow/said.ts";
import { askQuestion, sweepAskedCommands } from "../conversations/ask.ts";
import type { ItemRef, Parsed } from "../workflow/types.ts";
import type { Db } from "../db/index.ts";

/** A command not carried out before this long has passed is dropped (the runner was down, or GitHub could not be read). */
const EXPIRE_MS = 3600_000;
/** A comment older than this when its delivery arrives is a redelivery of an old comment: no command is queued. */
export const STALE_MS = 5 * 60_000;
/** A command whose GitHub reads could not be settled is tried again after this long. */
const RETRY_MS = 60_000;
/** Rows a drain reads at most; `limit` bounds the ones that call GitHub. */
const DRAIN_ROWS = 500;
const AUDIT_LOGIN = "github-command";
const NO_ACCESS_READ = "could not check your access; comment again";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/**
 * Queues the command of a new `issue_comment` in a tracked repo (`repo`, as webhooks.ts resolved it). A redelivery of the same
 * comment adds nothing, and a comment written more than STALE_MS before the delivery queues nothing. Comments by bots and apps are
 * left alone, and so are AutoCraft's own accounts' (the box account, the app's bot), so no answer it posts is ever read as a command.
 * Returns true when a command was queued.
 */
export async function queueCommand(db: Db, repo: string, event: string, payload: unknown, slug: string | null | undefined, now: Date = new Date()): Promise<boolean> {
  if (event !== "issue_comment" || !slug) return false;
  const p = obj(payload);
  if (p.action !== "created") return false;
  const comment = obj(p.comment), user = obj(comment.user), issue = obj(p.issue);
  if (user.type !== "User" || comment.performed_via_github_app) return false;
  const login = typeof user.login === "string" && LOGIN.test(user.login) ? user.login : null;
  if (login && isOwnLogin(await ownLogins(db, repo, slug), login)) return false;
  const githubId = posInt(user.id), commentId = posInt(comment.id), number = posInt(issue.number);
  const created = typeof comment.created_at === "string" ? Date.parse(comment.created_at) : NaN;
  if (!login || !githubId || !commentId || !number || !Number.isFinite(created)) return false;
  if (now.getTime() - created > STALE_MS) return false;
  const parsed = parseComment(comment.body, await commentNames(db, slug), { repo });
  if (!parsed) return false;
  const url = typeof comment.html_url === "string" && comment.html_url.startsWith("https://") ? comment.html_url : undefined;
  await recordSaid(db, { login, via: "github", text: typeof comment.body === "string" ? comment.body.slice(0, 65_536) : "", items: [{ repo, number }], by: null, githubCommentId: commentId, ...(url ? { payload: { url } } : {}) });
  return await queueCommands(db, [{
    comment_id: commentId, repo, number, pr: issue.pull_request ? 1 : 0, login, github_id: githubId,
    created_at: new Date(created).toISOString(), requested_at: now.toISOString(), parsed: JSON.stringify(parsed),
  }]) > 0;
}

type Row = CommandRow;

/** The comment as GitHub has it now: `gone` when it was deleted. */
export type CommentNow = { kind: "ok"; authorId: number | null; body: string } | { kind: "gone" };

/** A PR as GitHub has it now: its head, when it was opened and whether its head changed after a given time. */
export type PrNow = { head: string; opened: string; changed: boolean };

export type CommandDeps = {
  /** Reads the PRs' heads from GitHub. */
  querier: Querier;
  /** Runs `gh` for the answer. */
  exec?: Exec;
  /** Stands in for `appPermission`, which reads the live permission through the app installation and writes it to repo_permissions. */
  permission?: (db: Db, login: string, repo: string) => Promise<AppPermission>;
  /** Reads the comment again by its id (default: REST through the app installation). Throws when GitHub cannot be read. */
  comment?: (repo: string, id: number) => Promise<CommentNow>;
  /** Reads a PR's head and its changes since a time (default: `prSince`). Null: no such PR. Throws when GitHub cannot be read. */
  pr?: (q: Querier, repo: string, number: number, since: string) => Promise<PrNow | null>;
  /** The app's slug the comment is parsed again with (default: the app's). */
  slug?: string | null;
  /** Replaces the installation-token minter of the app identity (tests). */
  mint?: Writer["mint"];
  now?: () => Date;
  log?: (l: string) => void;
  limit?: number;
  /** Replaces the model reading's calls (tests); null turns the reading off. */
  read?: ReadDeps | null;
};

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300).replace(/[.\s]+$/, "");
const refOf = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;

type OpenPrsClosing = (db: Db, repo: string, issue: number) => Promise<number[]>;
/** One drain: where each settled row went (its state, result and whether an answer is to post), and the closing-PR reader. */
type Drain = { settled: Map<number, Row>; closing: OpenPrsClosing };

/** Write access from the app's answer; "transient" when GitHub could not answer or the app cannot ask (the command is tried again until it expires). */
async function liveWrite(db: Db, r: Row, deps: CommandDeps): Promise<"ok" | "no" | "transient"> {
  const p = await (deps.permission ?? ((d, login, repo) => appPermission(d, login, repo)))(db, r.login, r.repo).catch(() => ({ kind: "error" as const }));
  return p.kind === "ok" ? (WRITE_PERMISSIONS.has(p.permission) ? "ok" : "no") : "transient";
}

async function restComment(repo: string, id: number): Promise<CommentNow> {
  const token = await installationToken(ownerOf(repo));
  try {
    const c = obj(await call(GITHUB_API, `/repos/${slugOf(repo)}/issues/comments/${id}`, token));
    return { kind: "ok", authorId: posInt(obj(c.user).id), body: typeof c.body === "string" ? c.body : "" };
  } catch (e) {
    if (e instanceof AppError && (e.status === 404 || e.status === 410)) return { kind: "gone" };
    throw e;
  }
}

const PR_SINCE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      createdAt headRefOid
      timelineItems(last: 20, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { createdAt } } }
      commits(last: 100) { nodes { commit { oid committedDate checkSuites(first: 20) { nodes { createdAt } } } } }
    }
  }
}`;

type PrNode = {
  createdAt: string; headRefOid: string;
  timelineItems: { nodes: ({ createdAt?: string } | null)[] };
  commits: { nodes: ({ commit: { oid: string; committedDate: string; checkSuites: { nodes: ({ createdAt: string } | null)[] } | null } } | null)[] };
};

/**
 * A PR's head now and whether it changed after `since` (a comment's creation time). GitHub keeps no push time for a commit, so three
 * signals are read: a force push (HeadRefForcePushedEvent, stamped by GitHub), a commit dated later (the committer date, which the
 * pusher sets, so a back-dated commit passes this one) and the head's first check suite created later (stamped by GitHub when a
 * push starts CI; a merge needs green CI at the head, so the head of a mergeable PR has one). Throws while the head has no check
 * suite and no other signal shows a change: the push time cannot be told yet.
 */
export async function prSince(q: Querier, repo: string, number: number, since: string): Promise<PrNow | null> {
  const data = await q.query(PR_SINCE, { owner: ownerOf(repo), name: repo, number }) as { repository?: { pullRequest?: PrNode | null } | null };
  const pr = data.repository?.pullRequest;
  if (!pr?.headRefOid) return null;
  const t = Date.parse(since);
  const after = (s: string | undefined | null): boolean => !!s && Date.parse(s) > t;
  const commits = pr.commits.nodes.flatMap((n) => (n ? [n.commit] : []));
  const head = commits.find((c) => c.oid === pr.headRefOid);
  const suites = (head?.checkSuites?.nodes ?? []).flatMap((s) => (s ? [Date.parse(s.createdAt)] : []));
  const changed = pr.timelineItems.nodes.some((n) => after(n?.createdAt)) || commits.some((c) => after(c.committedDate));
  if (changed) return { head: pr.headRefOid, opened: pr.createdAt, changed };
  // Without a check suite the head's push time is unknown: a back-dated commit pushed after the comment would pass the other
  // signals, so the command waits (tried again) until CI has registered the head.
  if (!suites.length) throw new Error("the head has no check suite yet");
  return { head: pr.headRefOid, opened: pr.createdAt, changed: Math.min(...suites) > t };
}

/** Settles a command. `reply`: the app answers in the thread; `allowed`: the commenter may act there, so the answer needs no comment approval. */
async function settle(db: Db, d: Drain, r: Row, state: CommandState, result: string | null, at: Date, o: { reply?: boolean; allowed?: boolean } = {}): Promise<void> {
  await settleCommands(db, [{ commentId: Number(r.comment_id), state, result, reply: !!o.reply, allowed: !!o.allowed, at: at.toISOString() }]);
  d.settled.set(Number(r.comment_id), { ...r, state, result, done_at: at.toISOString(), reply: o.reply ? null : "none", allowed: o.allowed ? 1 : 0 });
}

/** Any of the items the command touches is a quiet pull request (a security fix not yet published): nothing is said there. */
const quietFor = async (db: Db, d: Drain, r: Row): Promise<boolean> => {
  const numbers = [r.number, ...(r.pr ? [] : await d.closing(db, r.repo, r.number))];
  return (await loadQuiet(db, numbers.map((number) => `${r.repo}#${number}`))).size > 0;
};

/** The access row of `login` while it is bound to the GitHub id `github_id`; a login never bound counts as unknown. */
export async function boundAccess(db: Db, r: { login: string; github_id: number }): Promise<AccessRow | null> {
  return await actorOf(db, r.login, Number(r.github_id));
}

/**
 * The commenter's access row, read now, or null after settling the command without an answer: no AutoCraft login, a login never
 * bound to a GitHub account or bound to another one (`ignored`), a viewer, or anyone but an operator on a quiet pull request (`refused`).
 */
async function knownCommenter(db: Db, d: Drain, r: Row, now: Date): Promise<AccessRow | null> {
  const access = await boundAccess(db, r);
  if (!access) { await settle(db, d, r, "ignored", null, now); return null; }
  if (access.role !== "operator" && access.role !== "maintainer") { await settle(db, d, r, "refused", "viewers cannot queue items", now); return null; }
  if (access.role !== "operator" && await quietFor(db, d, r)) { await settle(db, d, r, "refused", "the pull request is quiet until its fix is published", now); return null; }
  return access;
}

/**
 * Drops a command that ran out of time. One whose GitHub reads kept failing is answered once, so the commenter knows to comment
 * again; one that only waited (the runner was down, the item was not read again) ends silently.
 */
async function expire(db: Db, d: Drain, r: Row, now: Date): Promise<void> {
  const role = (await boundAccess(db, r))?.role;
  const answer = r.retries > 0 && (role === "operator" || role === "maintainer") && !await quietFor(db, d, r);
  await settle(db, d, r, "expired", answer ? NO_ACCESS_READ : null, now, { reply: answer });
}

/** The refusal of a question from someone the act rule refuses on the repo. */
const ASK_NOT_ALLOWED = t("Only operators, and maintainers with write access to the repository, ask Opus.");

/** Puts the comment's question to Opus as the commenter's message on its item, and links the comment's stored message to that turn. */
async function putQuestion(db: Db, r: Row, operator: boolean, question: string): Promise<{ turnId: number } | { refusal: string }> {
  return await askQuestion(db, { login: r.login, operator }, r.repo, r.number, question, {
    limit: true, linked: async (turnId) => await linkAskTurn(db, { repo: r.repo, number: r.number, login: r.login, via: "github", turnId, commentId: Number(r.comment_id) }),
  });
}

/** `reading`: a model reads the comment in the background (readInBackground), which settles and answers it. */
type Outcome = "settled" | "retry" | "wait" | "reading";

/** The least time between two "link your account" answers to one login. */
export const NUDGE_EVERY_MS = 7 * 86400_000;
const NOT_RUN = t("Nothing ran: the command could not be carried out.");

const parsedOf = (r: Row): Parsed | null => {
  try {
    return r.parsed ? JSON.parse(r.parsed) as Parsed : null;
  } catch {
    return null;
  }
};

/**
 * The command as the two texts are compared: one queued by a release that calls a hold `stop`, or that does not note a yes beside the commands,
 * is the same command. A release before this one that reads a queued `hold` settles it unanswered; it is sent again.
 */
const commandKey = (p: Parsed): string =>
  JSON.stringify(p.kind === "commands" ? { items: p.items, parts: p.parts.map((x) => ((x.word as string) === "stop" ? { ...x, word: "hold" } : x)) } : p);

/** Words that start, run or approve work: carried out only at the head the comment was written at. */
const HEAD_WORDS = new Set(["review", "fix-up", "implement", "merge", "fix", "drop"]);
/** An answer on a PR that may run work there is pinned to the PR's head when it was written; stop, close, backlog, weight and autorepin are not. */
export const pinsHead = (r: { pr: number; parsed: string | null }): boolean => {
  if (!r.pr) return false;
  const p = parsedOf(r as Row);
  return p?.kind === "yes" || (p?.kind === "commands" && p.parts.some((x) => HEAD_WORDS.has(x.word)));
};

/** The written item is the comment's own: `name#n` or `owner/name#n` for the tracked repo `repo`. */
const isOwnItem = (i: ItemRef, repo: string, number: number): boolean => {
  if (i.number !== number) return false;
  if (i.repo === repo) return true;
  const [owner, name] = i.repo.includes("/") ? i.repo.split("/", 2) as [string, string] : [null, i.repo];
  return name === repo && (owner === null || owner.toLowerCase() === ownerOf(repo).toLowerCase());
};

/**
 * The commenter has no AutoCraft login bound to this GitHub account. Settled without an answer, except once a week per login when
 * GitHub reports write access on the repo: then the answer says how to link the account. That answer needs the repo's comment
 * approval. No GitHub call is made for a login answered within the week.
 */
async function nudge(db: Db, d: Drain, r: Row, deps: CommandDeps, now: Date): Promise<Outcome> {
  const last = (await loadNudges(db, [r.login])).get(r.login);
  if (last && now.getTime() - Date.parse(last) < NUDGE_EVERY_MS) { await settle(db, d, r, "ignored", null, now); return "settled"; }
  if (await quietFor(db, d, r) || await liveWrite(db, r, deps) !== "ok") { await settle(db, d, r, "ignored", null, now); return "settled"; }
  const base = envVar("BASE_URL")?.replace(/\/+$/, "") || null;
  const text = base
    ? t("To send commands to AutoCraft, sign in at {url} with this GitHub account.", { url: base })
    : t("To send commands to AutoCraft, sign in to AutoCraft with this GitHub account.");
  await recordNudges(db, [{ login: r.login, at: now.toISOString() }]);
  await settle(db, d, r, "ignored", text, now, { reply: true });
  return "settled";
}

/**
 * Carries out an answer in a repo on the maintainer workflow through the command core. Who may act is decided there (actRefusal);
 * this settles what a comment adds: who the commenter is, that the comment still says the same, the head it was written at for
 * an answer that may run work on a PR, and that it acts on its own item. "retry" when GitHub could not be read, "wait" while the
 * PR needs a read since the comment.
 */
async function carryOutAnswer(db: Db, d: Drain, r: Row, deps: CommandDeps, now: Date): Promise<Outcome> {
  const clock = deps.now ?? (() => new Date());
  if (!await boundAccess(db, r)) return await nudge(db, d, r, deps, now);
  if (!await knownCommenter(db, d, r, now)) return "settled";
  const parsed = parsedOf(r);
  if (!parsed) { await settle(db, d, r, "ignored", null, now); return "settled"; }
  let c: CommentNow;
  try {
    c = await (deps.comment ?? restComment)(r.repo, r.comment_id);
  } catch {
    return "retry";
  }
  const slug = deps.slug === undefined ? appSlug() : deps.slug;
  const names = await commentNames(db, slug);
  const mentionName = names[0];
  const again = c.kind === "ok" && c.authorId === Number(r.github_id) ? parseComment(c.body, names, { repo: r.repo }) : null;
  if (!again || commandKey(again) !== commandKey(parsed)) {
    await settle(db, d, r, "ignored", c.kind === "gone" ? "the comment was deleted" : "the comment no longer holds the command", clock());
    return "settled";
  }
  let head: string | null | undefined;
  if (pinsHead(r)) {
    let p: PrNow | null;
    try {
      p = await (deps.pr ?? prSince)(deps.querier, r.repo, r.number, r.created_at);
    } catch {
      return "retry";
    }
    head = !p || p.changed ? null : p.head;
  }
  const perm = await liveWrite(db, r, deps);
  if (perm === "transient") return "retry";
  now = clock();
  if (now.getTime() - Date.parse(r.requested_at) >= EXPIRE_MS) { await expire(db, d, r, now); return "settled"; }
  const access = await knownCommenter(db, d, r, now);
  if (!access) return "settled";
  if (head !== undefined && await waitsForRead(db, r, now)) return "wait";
  const actor: Actor = { login: r.login, canWrite: async (repo) => repo === r.repo && perm === "ok", githubId: Number(r.github_id) };
  // An answer from someone the act rule refuses is answered under the repo's comment approval, as the queue rule's refusals are.
  const allowed = !await actRefusal(db, actor, r.repo);
  const reply = !await quietFor(db, d, r);
  const ref = refOf(r);
  const question = c.kind === "ok" ? commentQuestion(c.body, names) : null;
  if (question !== null) {
    // A question on a quiet pull request is not answered there (only an operator gets this far).
    const a = !allowed ? { refusal: ASK_NOT_ALLOWED } : !reply ? { refusal: "" } : await putQuestion(db, r, access.role === "operator", question);
    if ("turnId" in a) await settle(db, d, r, "asked", null, now);
    else await settle(db, d, r, "refused", a.refusal || null, now, { reply: reply && !!a.refusal, allowed });
    return "settled";
  }
  const items = again.kind !== "ambiguous" ? again.items ?? [] : [];
  if (items.length === 1 && !isOwnItem(items[0]!, r.repo, r.number)) {
    await settle(db, d, r, "refused", t("On GitHub a command acts on the item it is written on. Send it there, or from the dashboard, Discord or your agent."), now, { reply, allowed });
    return "settled";
  }
  if (head === null) {
    await settle(db, d, r, "refused", t("{ref} changed after the command was written. Send it again.", { ref: `${slugOf(r.repo)}#${r.number}` }), now, { reply, allowed });
    return "settled";
  }
  // An option of the open question named on its own runs as typed, pinned to the head like any typed command: no model reading.
  if (again.kind === "ambiguous" && allowed && deps.read !== null && !await namesOption(db, [{ repo: r.repo, number: r.number }], again)) {
    const body = c.kind === "ok" ? c.body : "";
    readInBackground(db, d, r, deps, { actor, again, names, text: addressedText(body, names), condition: commentCondition(body, names) !== null, mention: mentionName, reply, allowed, operator: access.role === "operator" });
    return "reading";
  }
  try {
    const own: Parsed = again.kind === "ambiguous" || items.length !== 1 ? again : { ...again, items: [] };
    const res = await linkingComment(db, Number(r.comment_id), r.login, () => runCommand(db, actor, "github", { parsed: own, items: [{ repo: r.repo, number: r.number }], ...(head ? { head } : {}), ...(mentionName ? { mention: mentionName } : {}), at: now.toISOString(), asked: () => r.created_at }));
    const o = res.items[0];
    if (o?.question && reply) await markQuestionShown(db, r.repo, r.number, `${o.question.workflowId}:${o.question.recAt}`, now.toISOString());
    await settle(db, d, r, o?.outcome === "run" ? "done" : "refused", o?.line ?? (res.lines.join(" ") || NOT_RUN), now, { reply, allowed });
  } catch (e) {
    deps.log?.(`github command ${ref}: ${oneLine(String((e as Error)?.message ?? e))}`);
    await settle(db, d, r, "refused", NOT_RUN, now, { reply, allowed });
  }
  return "settled";
}

/** The comment was deleted, or no longer holds the command, by the time a reading's command would run. */
class CommentChanged extends Error {}
/** GitHub could not give the comment again just before a reading's command would run. */
class CommentUnread extends Error {}

/** Comments a model is reading or has read in this process, with when it started: the drain leaves them to readInBackground. */
const reading = new Map<number, number>();
/** The background readings still running, for tests to wait on. */
const readings = new Set<Promise<void>>();
export const readingsDone = async (): Promise<void> => { await Promise.all([...readings]); };

/** The comment from its first line addressed to the app on, without quoted, fenced or hidden lines: what the model reads. */
function addressedText(body: string, names: readonly string[]): string {
  const lines = commentLines(body.slice(0, 65_536));
  const at = lines.findIndex((l) => names.some((n) => l.toLowerCase().startsWith(`@${n.toLowerCase()}`)));
  return lines.slice(Math.max(at, 0)).join("\n").trim();
}

/**
 * Reads an answer the parser could not read with a model (src/workflow/read.ts runText), off the drain, which would otherwise wait for the
 * call; then settles the command and posts its answer. Just before a command the reading runs, the comment is read again, as a typed one
 * is: deleted or changed meanwhile, the command ends unanswered; when GitHub cannot give it, the command stays queued and is tried again. It is pinned to the PR's head at the comment, as a typed one is. The row
 * stays queued meanwhile, and the drain passes over it (`reading`); after a restart the drain reads it again.
 */
function readInBackground(db: Db, d: Drain, r: Row, deps: CommandDeps, o: { actor: Actor; again: Parsed; names: readonly string[]; text: string; condition: boolean; mention: string | undefined; reply: boolean; allowed: boolean; operator: boolean }): void {
  const id = Number(r.comment_id);
  const clock = deps.now ?? (() => new Date());
  const nowMs = Date.now();
  for (const [k, at] of reading) if (nowMs - at >= EXPIRE_MS) reading.delete(k);
  reading.set(id, nowMs);
  const pin = async (p: Parsed): Promise<{ head?: string } | string> => {
    const c = await (deps.comment ?? restComment)(r.repo, r.comment_id).catch(() => null);
    if (!c) throw new CommentUnread();
    const now = c.kind === "ok" && c.authorId === Number(r.github_id) ? parseComment(c.body, o.names, { repo: r.repo }) : null;
    if (!now || commandKey(now) !== commandKey(o.again)) throw new CommentChanged(c.kind === "gone" ? "the comment was deleted" : "the comment no longer holds the command");
    if (!pinsHead({ pr: r.pr, parsed: JSON.stringify(p) })) return {};
    const p2 = await (deps.pr ?? prSince)(deps.querier, r.repo, r.number, r.created_at).catch(() => undefined);
    return p2 && !p2.changed ? { head: p2.head } : t("{ref} changed after the command was written. Send it again.", { ref: `${slugOf(r.repo)}#${r.number}` });
  };
  // A reading of the comment as only a question puts it to Opus; the command then waits for the answer.
  let asked = false;
  const ask = async (question: string): Promise<CommandResult> => {
    // The model read the addressed text, which starts with the mention.
    const own = withoutMention(question, o.names).trim();
    // The comment is read again first, as before any command the reading runs: changed or deleted meanwhile, nothing is asked.
    if (o.reply) await pin(o.again);
    const a = o.reply ? await putQuestion(db, r, o.operator, own || question) : { refusal: t("Nothing is said on a quiet pull request.") };
    if ("turnId" in a) asked = true;
    const line = "turnId" in a ? "" : a.refusal;
    return { items: [{ repo: r.repo, number: r.number, outcome: "turnId" in a ? "run" : "refused", line, workflowId: null }], lines: line ? [line] : [] };
  };
  const job = (async () => {
    let state: CommandState = "refused", line = NOT_RUN;
    try {
      const res = await linkingComment(db, id, r.login, () => runText(db, o.actor, "github", { parsed: o.again, items: [{ repo: r.repo, number: r.number }], ...(o.mention ? { mention: o.mention } : {}), at: clock().toISOString(), asked: () => r.created_at },
        { text: o.text, own: [{ repo: r.repo, number: r.number }], named: false, condition: o.condition, waitMs: READ_BACKGROUND_WAIT_MS, parse: { repo: r.repo }, pin, ask, ...(deps.read ? { deps: deps.read } : {}) }));
      if (asked) { await settle(db, d, r, "asked", null, clock()); return; }
      const out = res.items[0];
      if (out?.question && o.reply) await markQuestionShown(db, r.repo, r.number, `${out.question.workflowId}:${out.question.recAt}`, clock().toISOString());
      state = out?.outcome === "run" ? "done" : "refused";
      line = out?.line ?? (res.lines.join(" ") || NOT_RUN);
    } catch (e) {
      if (e instanceof CommentChanged) {
        await settle(db, d, r, "ignored", e.message, clock());
        return;
      }
      if (e instanceof CommentUnread) {
        // Tried again after RETRY_MS, as a typed command whose comment GitHub could not give; the expiry still counts from requested_at.
        await saveCommandProgress(db, [{ commentId: id, triedAt: clock().toISOString(), retryInc: true }]);
        reading.delete(id);
        return;
      }
      deps.log?.(`github command ${refOf(r)}: ${oneLine(String((e as Error)?.message ?? e))}`);
    }
    await settle(db, d, r, state, line, clock(), { reply: o.reply, allowed: o.allowed });
    const row = d.settled.get(id)!;
    // A paced answer is left to the next drain, which posts settled rows.
    if (row.reply === null && (await answer(db, d, row, deps)) === "paced") reading.delete(id);
  })().catch((e) => {
    deps.log?.(`github command ${refOf(r)}: ${oneLine(String((e as Error)?.message ?? e))}`);
    reading.delete(id);
  });
  readings.add(job);
  void job.finally(() => readings.delete(job));
}

/**
 * True while the PR has no read from GitHub since the comment: the webhook's re-read, or the poll after a failed one. A request row
 * that is gone proves nothing, since a failed re-read drops it too. The read must have started strictly after the comment
 * (`synced_at` is cut to the second, so one in the same instant may have started before it). A stale PR with no read queued gets
 * one, at most once a minute (tried_at), so the command does not wait for a poll that may never read it again.
 */
async function waitsForRead(db: Db, r: Row, now: Date): Promise<boolean> {
  const { stale, asked } = await requestReadsAfter(db, [{ ref: refOf(r), after: r.requested_at }], now.toISOString());
  if (!stale.length) return false;
  // Only the drain that queued the read sets the command back: one waiting for a read already queued is looked at on every drain.
  if (asked.length) await saveCommandProgress(db, [{ commentId: Number(r.comment_id), triedAt: now.toISOString() }]);
  return true;
}

/** The answer posted on GitHub for a carried-out command. */
export function answerText(r: { login: string; state: string; result: string | null; command?: string }): string {
  return r.state === "done" || r.command === "answer" ? `@${r.login} ${r.result}` : `@${r.login} ${r.command === "autorepin" ? "Autorepin not changed" : "Not added to the merge queue"}: ${r.result}.`;
}

/**
 * Posts the answer. An answer to someone who may queue on the repo needs no comment approval there; any other needs it. A paced write
 * leaves it for the next drain; any other failure is recorded (write.ts audits it) and not retried. Nothing is posted on an item that
 * became quiet since the command was settled. Text a model wrote (a question's answer, `model` set) carries the AI note naming the model.
 */
async function answer(db: Db, d: Drain, r: Row, deps: CommandDeps): Promise<"posted" | "failed" | "paced" | "none"> {
  if (await quietFor(db, d, r)) {
    await saveCommandProgress(db, [{ commentId: Number(r.comment_id), reply: "none" }]);
    return "none";
  }
  // An ignored command with an answer is the "link your account" answer to someone AutoCraft does not know: written as the app, not as them.
  const stranger = r.state === "ignored";
  const g = stranger
    ? await guardRepo(db, r.repo, "comment", { operator: AUDIT_LOGIN })
    : await guardRepo(db, r.repo, r.allowed ? null : "comment", { operator: r.login }, r.login);
  let reply: "posted" | "failed";
  if ("refused" in g) {
    deps.log?.(`github command ${refOf(r)}: no answer: ${g.refused}`);
    reply = "failed";
  } else {
    try {
      const out = await ghComment({ db, login: stranger ? AUDIT_LOGIN : r.login, mint: deps.mint }, g, deps.exec ?? defaultExec, "github-command-reply", { repo: r.repo, number: r.number, pr: r.pr === 1 }, r.model ? { by: "model", kind: "answer", model: r.model } : { by: "fixed-operator" }, answerText(r), { comment: Number(r.comment_id), command: r.command });
      reply = out.code === 0 ? "posted" : "failed";
      if (out.code !== 0) deps.log?.(`github command ${refOf(r)}: the answer failed: ${oneLine(out.stderr || out.stdout)}`);
    } catch (e) {
      if (e instanceof WritePacedError) return "paced";
      deps.log?.(`github command ${refOf(r)}: the answer failed: ${oneLine(String((e as Error)?.message ?? e))}`);
      reply = "failed";
    }
  }
  await saveCommandProgress(db, [{ commentId: Number(r.comment_id), reply }]);
  return reply;
}

/**
 * Carries out the queued commands, oldest first, and posts their answers. Run after the webhook's re-reads, so the item is in the
 * mirror at its current head. Returns how many commands were settled.
 */
export async function drainCommands(db: Db, deps: CommandDeps): Promise<number> {
  const clock = deps.now ?? (() => new Date());
  const t0 = clock();
  // Rows that wait for a re-read or a retry are passed over without a GitHub call, so they never keep a newer command out. `limit`
  // bounds the rows that call GitHub in one drain. Rows never tried come first, oldest first, then retries by their last try, so due
  // retries cannot fill the limit drain after drain either.
  // Questions whose answer never came back are settled first, so this drain posts them.
  await sweepAskedCommands(db, t0.getTime()).catch((e: Error) => deps.log?.(`github command: asked sweep failed: ${oneLine(e.message)}`));
  const rows = await loadCommandWork(db, { limit: DRAIN_ROWS, retryBefore: new Date(t0.getTime() - RETRY_MS).toISOString() });
  const { openPrsClosing } = await import("../dash/api/queue-page.ts");
  const d: Drain = { settled: new Map(), closing: openPrsClosing };
  let settled = 0, calls = 0;
  for (const r0 of rows) {
    if (calls >= (deps.limit ?? 10)) break;
    if (reading.has(Number(r0.comment_id))) continue;
    const now = clock();
    let r = r0;
    if (r.state === "queued") {
      if (now.getTime() - Date.parse(r.requested_at) >= EXPIRE_MS) await expire(db, d, r, now);
      // No GitHub call while the PR waits for a read since the comment (see waitsForRead); a command that pins no head does not wait.
      else if (pinsHead(r) && await waitsForRead(db, r, now)) continue;
      else {
        calls++;
        const out = await carryOutAnswer(db, d, r, deps, now);
        if (out === "wait" || out === "reading") continue;
        if (out === "retry") {
          // GitHub could not be read: retried after RETRY_MS; the expiry still counts from requested_at.
          await saveCommandProgress(db, [{ commentId: Number(r.comment_id), triedAt: clock().toISOString(), retryInc: true }]);
          continue;
        }
      }
      settled++;
      r = d.settled.get(Number(r.comment_id)) ?? r;
      if (r.state === "queued" || r.reply !== null) continue;
    } else calls++;
    if ((await answer(db, d, r, deps)) === "paced") break;
  }
  return settled;
}

/** Deletes settled commands older than the keep time. */
export async function pruneCommands(db: Db, nowMs: number = Date.now()): Promise<number> {
  return await pruneCommandRows(db, nowMs);
}
