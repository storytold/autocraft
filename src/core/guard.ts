// The guard: the only way to get a `Guarded` value, which every PR write in github/write.ts requires.
// Right before a write it reloads the facts (with a live read of head, state and mergeable for merges and pushes),
// runs decide() again, and passes only when the Plan still holds the same action at the same head and its permission lets it run.
import type { Querier } from "../mirror.ts";
import { refreshChecks } from "../review/checks.ts";
import { decidePr } from "./decide.ts";
import { verifyAllows } from "./rules.ts";
import { loadPass, loadPrFact } from "./facts.ts";
import { loadRepoGuards } from "../data/control/index.ts";
import { decideItem } from "./decide-item.ts";
import { mayRun, repoPermission } from "./authority.ts";
import { approvalOf, type By, type RepoApprovals, type RepoNeed, type Want } from "./gates.ts";
import { ownImplementation } from "./implementation.ts";
import { loadItemFact } from "./issue-facts.ts";
import type { Action, ActionKind, Permission, Plan, PrFacts } from "./plan.ts";
import type { Identity } from "../github/identity.ts";
import type { RefusalCode } from "./codes.ts";
import { botRepo } from "../discord/filing-repos.ts";
import type { Db } from "../db/index.ts";

declare const guarded: unique symbol;

/** What the guard let through: the action (its kind is part of the type, so a write takes only the grants made for it), the reviewed head it holds at, and the PR. Only `guard` makes one. */
export type Guarded<K extends ActionKind = ActionKind> = { readonly [guarded]: true; readonly scope: "pr"; readonly action: Want<K>; readonly head: string; readonly repo: string; readonly number: number; /** Who the write is made as, once its repo leaves the box account (src/github/identity.ts). */ readonly as: Identity };
/** What the guard let through for an issue or PR in its item steps (labels, act, fix issue). Only `guardItem` makes one. */
export type GuardedItem = { readonly [guarded]: true; readonly scope: "item"; readonly action: ItemWant; readonly repo: string; readonly number: number; readonly as: Identity };
/** What the guard let through for a repo-level write (a label set, a fork, an issue, a batch branch): the approval and the global switch held. Only `guardRepo` makes one. */
export type GuardedRepo = { readonly [guarded]: true; readonly scope: "repo"; readonly need: RepoNeed; readonly repo: string; readonly as: Identity };
/** "Submit for me" on Discord: one new issue, and its label, in `owner/repo` as the GitHub App. Only guardBotFiling makes one and only createBotIssue and labelBotIssue take it, so a filing-only repo gets no other write. */
export type GuardedFiling = { readonly [guarded]: true; readonly scope: "filing"; readonly owner: string; readonly repo: string; readonly as: "app" };
/** What an item or repo write accepts. A PR grant is left out: no caller writes with one, and a merge or CI grant must not type-check there. */
export type Grant = GuardedItem | GuardedRepo;
/** `code`: the gate rule that refused it, where one did (src/core/codes.ts). */
export type Refused = { refused: string; code?: RefusalCode };
/** An item action to guard: the Plan must hold the kind with the bucket, person action and source given. */
export type ItemWant = Want & { id?: number; source?: string };
/** The action to guard: `head` is the head the caller reviewed or worked on. `batch`: a member of a merge batch, which is in its batch state, not ready. */
export type Ask<K extends ActionKind = ActionKind> = Want<K> & { head: string; batch?: boolean; /** Fix-up: the Plan action's source (review, premerge or carry). */ source?: string };
export type Ref = { repo: string; number: number };

export type LiveRead = { state: "OPEN" | "MERGED" | "CLOSED"; head: string; draft: boolean; mergeable: string };
export type Live = (repo: string, number: number) => Promise<LiveRead | null>;

/** The live read of the merge step: fetches the PR's checks (and stores them), which carry head, state, draft and mergeable. */
export function liveOf(db: Db, q: Querier): Live {
  return async (repo, number) => {
    const [c] = await refreshChecks(db, q, repo, [number]);
    return c ? { state: c.state as LiveRead["state"], head: c.head_oid, draft: c.is_draft, mergeable: c.mergeable ?? "UNKNOWN" } : null;
  };
}

const short = (s: string | null): string => (s ?? "none").slice(0, 7);
const BATCH_STATES: readonly string[] = ["batch-checking", "in-batch"];

/** Merges and pushes read GitHub first: the head must not have moved. */
const needsLive = (a: Want): boolean =>
  a.kind === "merge" || (a.kind === "fixup" && a.bucket === "fix") || (a.kind === "conflict" && a.bucket === "merge")
  || (a.kind === "cifix" && (a.bucket === "work" || a.bucket === "collect" || a.bucket === "ask")) || a.kind === "lint";

const make = <K extends ActionKind>(ref: Ref, a: Want<K>, head: string, as: Identity = "app"): Guarded<K> => ({ scope: "pr", action: a, head, repo: ref.repo, number: ref.number, as }) as unknown as Guarded<K>;

/** Why a PR cannot be in an integration batch at its head, whoever approved it; a merge on its own waits for the same. */
export function memberRefusal(f: PrFacts): string | null {
  if (f.draft) return "it is a draft";
  if (f.screenshots) return "its screenshots show a regression nobody has answered yet";
  if (f.mergeWaiting) return "its merge waits for the sign-in or access of the person who approved it";
  return ownImplementation(f)?.state === "revising" ? "its implementation session is revising it" : null;
}

/** The action as one of a Plan, for its permission when the Plan does not hold it. */
const asAction = (a: Want & { source?: string }, head: string | null): Action =>
  ({ kind: a.kind, head, params: { ...(a.bucket !== undefined ? { bucket: a.bucket } : {}), ...(a.source !== undefined ? { source: a.source } : {}) } });

const other = (text: string): Permission => ({ ok: false, why: { code: "other", who: "system", text } });
const actionsOf = (p: Pick<Plan, "wait"> & { actions: readonly Action[] }): string =>
  `actions: ${p.actions.map((x) => x.kind + (typeof x.params?.bucket === "string" ? `:${x.params.bucket}` : "")).join(", ") || "none"}`;

/** Whether the write may be made on these facts: the Plan decided on them holds the action at the head asked for, and it may run. Pure. */
export function allows(f: PrFacts, a: Ask, by: By): Permission {
  const plan = decidePr(f, loadPass());
  const due = plan.head !== a.head ? undefined : plan.actions.find((x) => x.kind === a.kind && x.head === a.head
    && (a.bucket === undefined || x.params?.bucket === a.bucket) && (a.source === undefined || x.params?.source === a.source));
  // Why the action may not run says more than the state of a Plan without it, so it is asked first.
  const may = mayRun({ facts: f, action: due ?? asAction(a, a.head) }, by);
  if (!may.ok) return may;
  const out = a.batch ? memberRefusal(f) : null;
  if (out) return other(out);
  // A batch member is in its batch state, not ready; it must still pass what a single merge needs apart from CI and mergeable.
  const inBatch = a.batch === true && a.kind === "merge" && plan.head === a.head && BATCH_STATES.includes(plan.state) && plan.path !== null && verifyAllows(plan.path, f.verification?.state, f.verifyOverride);
  return due || inBatch ? may
    : other(`the plan no longer has ${a.kind}${a.bucket ? `:${a.bucket}` : ""} at ${short(a.head)} (state ${plan.state}, head ${short(plan.head)}, ${actionsOf(plan)}${plan.wait ? `, waiting for ${plan.wait}` : ""})`);
}

async function check(db: Db, ref: Ref, a: Ask, by: By, live?: Live): Promise<{ as: Identity } | Refused> {
  const name = `${ref.repo}#${ref.number}`;
  let read: LiveRead | null = null;
  if (needsLive(a)) {
    if (!live) return { refused: `${name}: no live read of the PR before the write` };
    try {
      read = await live(ref.repo, ref.number);
    } catch (e) {
      return { refused: `${name}: live read failed: ${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}` };
    }
    if (!read) return { refused: `${name}: GitHub returned no such PR` };
    if (read.state !== "OPEN") return { refused: `${name}: no longer open on GitHub (${read.state.toLowerCase()})` };
    if (read.head !== a.head) return { refused: `${name}: head moved from ${short(a.head)} to ${short(read.head)} since the review` };
  }
  let f = await loadPrFact(db, ref.repo, ref.number);
  if (!f) return { refused: `${name}: not an open PR the pipeline tracks` };
  if (read) f = { ...f, ghState: read.state, head: read.head, draft: read.draft, mergeable: read.mergeable };
  const may = allows(f, a, by);
  return may.ok ? { as: may.as } : { refused: `${name}: ${may.why.text}` };
}

/** Lets one PR write through, or says why not. Call it right before the write. */
export async function guard<K extends ActionKind>(db: Db, ref: Ref, action: Ask<K>, by: By, live?: Live): Promise<Guarded<K> | Refused> {
  const r = await check(db, ref, action, by, live);
  return "refused" in r ? r : make(ref, action, action.head, r.as);
}

/**
 * Lets the merge of a batch PR through: every member must pass the guard at its batched head, and the batch PR must
 * still be open at the batch tip. The returned value is for the batch PR.
 */
export async function guardBatchMerge(db: Db, batch: Ref & { head: string }, members: { number: number; head: string }[], by: By, live: Live): Promise<Guarded<"merge"> | Refused> {
  for (const m of members) {
    const r = await guard(db, { repo: batch.repo, number: m.number }, { kind: "merge", head: m.head, batch: true }, by, live);
    if ("refused" in r) return r;
  }
  const name = `${batch.repo}#${batch.number}`;
  let read: LiveRead | null;
  try {
    read = await live(batch.repo, batch.number);
  } catch (e) {
    return { refused: `${name}: live read failed: ${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}` };
  }
  if (!read) return { refused: `${name}: GitHub returned no such PR` };
  if (read.state !== "OPEN") return { refused: `${name}: no longer open on GitHub (${read.state.toLowerCase()})` };
  if (read.head !== batch.head) return { refused: `${name}: the batch branch moved from ${short(batch.head)} to ${short(read.head)}` };
  return make(batch, { kind: "merge" }, batch.head);
}

export async function guardItem(db: Db, ref: Ref, action: ItemWant, by: By, login?: string): Promise<GuardedItem | Refused> {
  const name = `${ref.repo}#${ref.number}`;
  const f = await loadItemFact(db, ref.repo, ref.number);
  if (!f) return { refused: `${name}: not an open item the pipeline tracks`, code: "untracked" };
  const plan = decideItem(f);
  const due = plan.actions.find((x) => x.kind === action.kind
    && (action.bucket === undefined || x.params?.bucket === action.bucket)
    && (action.id === undefined || x.params?.id === action.id)
    && (action.source === undefined || x.params?.source === action.source));
  const may = mayRun({ facts: f, action: due ?? asAction(action, null) }, by);
  if (!may.ok) return { refused: `${name}: ${may.why.text}`, code: may.why.code };
  if (!due) return { refused: `${name}: the plan no longer has ${action.kind}${action.bucket ? `:${action.bucket}` : ""} (state ${plan.state}, ${actionsOf(plan)})`, code: "unplanned" };
  return { scope: "item", action, repo: ref.repo, number: ref.number, as: login ? `user:${login}` : "app" } as unknown as GuardedItem;
}

/** The approvals of a repo and the global switch, read now (never from a settings snapshot). */
export async function repoApprovals(db: Db, repo: string): Promise<RepoApprovals> {
  const g = (await loadRepoGuards(db, [repo])).get(repo);
  const a = g?.approvals ?? {};
  return {
    merge: !!a.merge, push: !!a.push, comment: !!a.comment, ci: !!a.ci, labels: !!a.labels, "fix-issue": !!a.fixissue, "main-fix": !!a.mainfix, status: !!a.prstatus,
    pipelineOn: g?.pipelineOn ?? false,
  };
}

/**
 * Lets a repo-level write through (no item behind it): the repo approval it needs (null: none) and, for the pipeline's own writes, the global switch.
 * `members`: the verdicts of the items the write serves: the merge's (src/merge/approval.ts) of the PRs a batch carries, or the
 * implementation's, or whether a person started or approved each item whose status comment it writes. A "merge", "fix-issue" or "status"
 * write passes without the repo's approval when every one of them passes, so a batch of PRs people approved one by one, an issue a person
 * queued, or the status comments of items people started, need no repo switch.
 */
export async function guardRepo(db: Db, repo: string, need: RepoNeed, by: By, login?: string, o: { members?: readonly { ok: boolean }[] } = {}): Promise<GuardedRepo | Refused> {
  const why = repoPermission(await repoApprovals(db, repo), need, by, repo, o.members);
  // `login`: the person pressing the button right now (a conversation card), who acts as themselves.
  return why ? { refused: `${repo}: ${why.text}` } : ({ scope: "repo", need, repo, as: login ? `user:${login}` : "app" } as unknown as GuardedRepo);
}

/** Lets a stage that starts work on a PR take it (the pipeline's account is assigned): the action the work ends in may run. */
export async function guardClaim(db: Db, ref: Ref, action: Want, by: By): Promise<GuardedRepo | Refused> {
  const f = await loadPrFact(db, ref.repo, ref.number);
  if (!f) return { refused: `${ref.repo}#${ref.number}: not an open PR the pipeline tracks`, code: "untracked" };
  const may = mayRun({ facts: f, action: asAction(action, f.head) }, by);
  return may.ok ? ({ scope: "repo", need: approvalOf(f, action), repo: ref.repo, as: "app" } as unknown as GuardedRepo) : { refused: `${ref.repo}#${ref.number}: ${may.why.text}` };
}

/**
 * Lets the Discord bot's issue for a reporter through: a repo the bot offers (public and tracked, or filing-only), with its
 * owner. Filing for a reporter is not a pipeline action, so neither the repo's approvals nor its Pipeline switch apply.
 */
export async function guardBotFiling(db: Db, repo: string): Promise<GuardedFiling | Refused> {
  const r = await botRepo(db, repo);
  return r ? ({ scope: "filing", owner: r.owner, repo: r.name, as: "app" } as unknown as GuardedFiling) : { refused: `${repo}: not open for filing from Discord` };
}
