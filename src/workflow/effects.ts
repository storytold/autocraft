// What a maintainer's command does to the machinery that already works: the review-again mark, operator fix-ups, pre-approved
// merges (the merge leg, owned through preapprovals.workflow_id), the close made as the person (a `workflow_actions` row the
// action executor carries out), autorepin and the end of every queued step. A start, an answer and a close check first and return
// what they write; the command core (apply.ts) writes that in one transaction with the workflow row, so no check reads state the
// command itself creates and a refusal leaves nothing behind. Nothing here touches item_workflows.
import { endWorkspace } from "../build/workspaces.ts";
import { resumeStage, setPipelineFlags } from "../data/control/index.ts";
import { cancelUnopened } from "../data/implement/index.ts";
import { releaseHeld } from "../data/intake/index.ts";
import { loadChecks, loadItems, loadRepoCiSignals, loadRepos } from "../data/mirror/index.ts";
import { queueIssueReviews } from "../data/issuereview/index.ts";
import { withdrawItemCalls, withdrawUnownedItemCalls } from "../data/runners/index.ts";
import { adoptLegs, endFixupRequests, listWorkflowLegs, listWorkflows, loadActions, loadFixupRequests, loadLegs, queueActions, saveActions, type CloseAs, type Preapproval } from "../data/workflow/index.ts";
import { loadOwnLogins } from "../data/access/index.ts";
import { loadQuiet } from "../data/security/quiet.ts";
import { loadReviewsAt, type ReviewRow } from "../data/review/index.ts";
import { headRef } from "../data/review/rows.ts";
import { authorAskComment } from "../act/templates.ts";
import { REFERENCE_LEAK } from "../review/opus-parse.ts";
import { clipText, firstSentence } from "../prose.ts";
import type { Db } from "../db/index.ts";
import type { Exec } from "../fixup/git.ts";
import { queueLaneActions } from "../github/user-lane.ts";
import { t } from "../i18n/index.ts";
import { removeFromBatch } from "../merge/controls.ts";
import { conflictAhead } from "../core/conflict-ahead.ts";
import { PARTS_ONLY, partLine } from "../core/evidence.ts";
import { byHand, conflictPath, type ConflictPath } from "../core/decide.ts";
import { loadPrFact } from "../core/facts.ts";
import { cancelPreapproval, checkFixup, checkMergeLeg, inActiveBatch, INSTRUCTIONS_MAX, NotYet, PreapprovalRefused, type CheckedStep } from "../preapproval/index.ts";
import { parseBranch, parsePrRef } from "../repin/manifest.ts";
import { requestRepin } from "../repin/index.ts";
import { markReviewsStale } from "../review/discussion.ts";
import { LANE_STEPS } from "./blockers.ts";
import { authorUnaskable } from "./unaskable.ts";
import { actBlocked } from "../core/repo-approvals.ts";
import { RULE_STARTER, type AuthorAsk, type ItemKind, type ItemWorkflow, type PlanPart, type Surface } from "./types.ts";

/** A legacy step refused the command; its message says why, translated (`effectText`). `later`: a moment may lift it (src/preapproval NotYet). */
export class EffectError extends Error {
  readonly later: boolean;
  constructor(message: string, later = false) { super(message); this.later = later; }
}

/**
 * The refusals of the legacy steps a command runs on, as translated text. The steps write English for logs and the classic pages; a
 * refusal this table does not know stays as written.
 */
const LEGACY_TEXT: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(\S+#\d+) is not a pull request$/, (m) => t("{ref} is not a pull request.", { ref: m[1]! })],
  [/^(\S+#\d+) is not open$/, (m) => t("{ref} is not open.", { ref: m[1]! })],
  [/^(\S+#\d+) is outside the pipeline's scope/, (m) => t("{ref} is outside the pipeline's scope.", { ref: m[1]! })],
  [/^(\S+#\d+) cannot be reviewed yet: it is a draft$/, (m) => t("{ref} is a draft, so it cannot be reviewed yet.", { ref: m[1]! })],
  [/^(\S+#\d+) has no head commit in the mirror yet$/, (m) => t("AutoCraft has not read the head commit of {ref} yet.", { ref: m[1]! })],
  [/^the PR changed after your comment; comment again$/, () => t("The pull request changed after the command was written. Send it again.")],
  [/^pushing is not approved for (\S+)$/, (m) => t("Pushing is not approved for {repo}. An operator or a maintainer of the repo can turn it on, on the Repos page.", { repo: m[1]! })],
  [/^(\S+#\d+) already has a pre-approved merge in progress$/, (m) => t("{ref} is already on its way to a merge.", { ref: m[1]! })],
  [/^(\S+#\d+) conflicts with its base branch/, (m) => t("{ref} conflicts with its base branch: the conflict merge comes first.", { ref: m[1]! })],
  [/^can't push to the contributor's branch$/, () => t("AutoCraft can't push to the contributor's branch.")],
  [/^the fix-up tries for this PR are used up$/, () => t("The fix-up tries for this pull request are used up.")],
  [/^a fix-up of (\S+#\d+) is already queued$/, (m) => t("A fix-up of {ref} is already queued.", { ref: m[1]! })],
  [/^the instructions are over (\d+) characters$/, (m) => t("The fix-up instructions are over {n} characters.", { n: m[1]! })],
  [/^the author's permission on the repository could not be read yet/, () => t("The author's permission on the repository could not be read yet. Try again.")],
  [/^(\S+#\d+) has no pre-approved merge in progress$/, (m) => t("{ref} is not on its way to a merge.", { ref: m[1]! })],
];

/** A legacy step's refusal as translated text; unknown text stays as written. */
export function effectText(message: string): string {
  for (const [re, text] of LEGACY_TEXT) {
    const m = re.exec(message);
    if (m) return text(m);
  }
  return message;
}

export type Target = { repo: string; number: number; kind: ItemKind; head: string | null };
/** `workflowId`: the item's live workflow, whose merge legs (possibly on another item: an issue's implementation PR) a hold ends. `keepBatch`: the caller ends the batch the PR is in, and its merge leg. */
export type Ctx = { db: Db; by: string; via: Surface; at: string; item: Target; exec?: Exec; workflowId?: number; keepBatch?: boolean; /** The head of the question it answers, when pushes of ours lead from it to the item's. */ shown?: string };

const ref = (t: { repo: string; number: number }): string => `${t.repo}#${t.number}`;

/** Turns a refusal of an existing step into an EffectError, so the item's line says why and the other items go on. */
async function step<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof EffectError ? e : new EffectError(effectText((e as Error).message), e instanceof NotYet);
  }
}

/** The PR's active merge leg. */
const activeLeg = async (db: Db, t: Target): Promise<Preapproval | null> =>
  (await loadLegs(db, [{ repo: t.repo, number: t.number }], { activeOnly: true })).get(ref(t))?.at(-1) ?? null;

// ---- starts --------------------------------------------------------------------------------------------------------------

/** What a checked command writes, in the caller's transaction, for the workflow: a refusal rolls it back. */
export type Write = (workflowId: number) => Promise<void>;
const nothing: Write = async () => {};

const writeOf = (s: CheckedStep): Write => async (id) => {
  try {
    await s.write(id);
  } catch (e) {
    throw e instanceof PreapprovalRefused ? new EffectError(effectText(e.message)) : e;
  }
};

/** The merge leg: a pre-approved merge at the current head, or the one already in progress (`had`). */
async function mergeLeg(c: Ctx, had: Preapproval | null): Promise<Write> {
  if (had === null) return writeOf(await step(() => checkMergeLeg(c.db, { repo: c.item.repo, number: c.item.number, by: c.by, via: c.via, ...(c.item.head ? { head: c.item.head } : {}), ...(c.shown ? { fromHead: c.shown } : {}) })));
  const owner = had.workflow_id;
  if (owner === null) return async (id) => void await adoptLegs(c.db, [{ id: had.id, workflowId: id }]);
  // A merge is made through its own workflow's leg. One of another live workflow (the PR's issue) is already at work; one whose workflow
  // ended is cancelled by the pre-approval pass, and this workflow's leg starts after it (src/workflow/advance.ts).
  if (owner !== c.workflowId && (await listWorkflows(c.db, { ids: [owner], live: true })).length) throw new EffectError(t("{ref} is already on its way to a merge.", { ref: ref(c.item) }));
  return nothing;
}

/** Refuses a merge that no approval can make: of a PR that is not aimed at the default branch, or in a repo without CI. */
export async function checkMerges({ db, item }: Ctx): Promise<void> {
  const { repo, number } = item, pr = item.kind === "pr" ? [{ repo, number }] : [];
  const [items, checks, repos, ci] = await db.together(() => Promise.all([
    pr.length ? loadItems(db, pr, "pr") : new Map(), pr.length ? loadChecks(db, pr) : new Map(), loadRepos(db, { names: [repo] }), loadRepoCiSignals(db, [repo]),
  ]));
  const base = items.get(ref(item))?.base_ref, main = repos.get(repo)?.default_branch, overall = checks.get(ref(item))?.overall;
  if (base && main && base !== main) throw new EffectError(t("{ref} is aimed at {base}, and AutoCraft merges only into {main}. Change its base branch first.", { ref: ref(item), base, main }));
  if (ci.get(repo)?.noCi && (!overall || overall === "none")) throw new EffectError(t("{repo} has no CI, and AutoCraft merges only on green CI.", { repo }));
}

/** What a confirmation says of a PR's conflict with its base branch once the merge is approved. */
type ConflictSaid = { note?: string; waits?: "contributor" | "person" };

function conflictSaid(item: Target, path: ConflictPath | null): ConflictSaid {
  if (byHand(path)) return { waits: path, note: t("New commits come back to you.") };
  if (path === "merge") return { note: t("{ref} conflicts with its base branch: AutoCraft merges that branch into it first.", { ref: ref(item) }) };
  return {};
}

/**
 * Starts the item at `entry`. Review and Fix-up mark the PR for a review of its current head (the fix-up follows from what the
 * review finds); the merge queue pre-approves the merge; an implement start is the workflow row itself, an issue's review a request row. An approved PR gets its
 * merge leg at once, and what is said of a conflict with its base branch names who settles it.
 */
export async function start(c: Ctx, entry: ItemWorkflow["entry"], approved: boolean, instruction: Instruction | null = null, o: { thenImplement?: boolean } = {}): Promise<{ write: Write } & ConflictSaid> {
  const { db, by, item } = c;
  const merges = approved || entry === "merge";
  if (merges) await checkMerges(c);
  if (entry === "implement") return { write: nothing };
  // An issue's review is a request row the issue review step takes (src/issuereview).
  if (item.kind === "issue") return { write: (id) => queueIssueReviews(db, [{ workflowId: id, repo: item.repo, number: item.number, by, at: c.at, thenImplement: !!o.thenImplement }]) };
  // A fix-up start with the person's words makes that fix first; its push is reviewed as any push of ours is, and carries the merge leg.
  if (instruction && item.kind === "pr") {
    const had = merges ? await activeLeg(db, item) : null;
    const f = merges ? await loadPrFact(db, item.repo, item.number) : null;
    const path = conflictPath(f);
    if (byHand(path)) throw new EffectError(t("{ref} conflicts with its base branch, which someone has to resolve before AutoCraft can fix it.", { ref: ref(item) }));
    const fix = writeOf(await step(() => checkFixup(db, { repo: item.repo, number: item.number, by, instructions: fixInstructions([], [], instruction), merge: merges && had === null, afterBase: path !== null })));
    const leg = merges && had !== null ? await mergeLeg(c, had) : nothing;
    return { ...(merges ? conflictSaid(item, await conflictAhead(db, item, f)) : {}), write: async (id) => { await leg(id); await fix(id); } };
  }
  const leg = merges ? await mergeLeg(c, await activeLeg(db, item)) : nothing;
  return {
    ...(merges ? conflictSaid(item, await conflictAhead(db, item)) : {}),
    write: async (id) => {
      await leg(id);
      if (entry !== "merge") await markReviewsStale(db, by, item.repo, item.number);
    },
  };
}

// ---- answers on a started item -------------------------------------------------------------------------------------------

/** What the fix-up is to do beyond the plan's parts: a person's own words, or the finding of a review that lists no fix (`review`). */
export type Instruction = { text: string; review?: true };

/**
 * The fix-up instructions: the person's words or the review's finding, and the named parts of the plan; the latest review's fixes when
 * neither names anything.
 */
export function fixInstructions(plan: readonly PlanPart[], fix: readonly number[], instruction: Instruction | null = null): string {
  const parts = plan.filter((p) => fix.includes(p.n));
  const said = instruction ? (instruction.review ? `Fix what the latest review of this pull request found:\n${instruction.text}` : instruction.text) : null;
  if (!parts.length) return said ?? "Make the fixes the latest review of this pull request lists.";
  // A request of parts alone is one the review carries over once its check passed (src/review/carry.ts reads it with askedParts).
  let out = said ? `${said}\n\nAlso fix these findings of the review:` : PARTS_ONLY;
  for (const p of parts) {
    const line = `\n${partLine(p)}`;
    if (out.length + line.length > INSTRUCTIONS_MAX) break;
    out += line;
  }
  return out;
}

/**
 * What runs again on a started PR: a review of the current head, or a fix-up of the named parts. With `merges`, the fix-up
 * carries the merge (a new pre-approval in `fixup`), unless a pre-approved merge is already in progress; a PR with no fix-up
 * this time gets its merge leg when it has none. No fix-up can be made on a PR that conflicts with its base branch (conflictPath). Where the
 * pipeline merges the base into an approved PR, the fix-up follows that merge (`note` says so): the pipeline makes a take-fix review's
 * minor fixes itself, and any other fix-up waits as a request. Where a person has to resolve the conflict, only the merge leg starts, and
 * waits for them (`waits`). `says`: the person said merge, which is refused where none can be made, and whose confirmation names who
 * settles a conflict.
 */
export async function again(c: Ctx, o: { again: "review" | "fixup" | null; plan: readonly PlanPart[]; fix: readonly number[]; merges: boolean; says?: boolean; instruction?: Instruction | null }): Promise<{ write: Write } & ConflictSaid> {
  const { db, by, item } = c;
  if (o.says) await checkMerges(c);
  if (item.kind !== "pr") return { write: nothing };
  const had = o.merges ? await activeLeg(db, item) : null;
  const f = o.merges ? await loadPrFact(db, item.repo, item.number) : null;
  const path = conflictPath(f);
  if (byHand(path) && o.again !== "review") return { write: await mergeLeg(c, had), waits: path, note: t("New commits come back to you.") };
  const first = path === "merge" ? t("{ref} conflicts with its base branch: that merge comes first, then the review's fixes.", { ref: ref(item) }) : null;
  const note = first !== null && o.again === "fixup" ? { note: first } : {};
  const said = o.says ? conflictSaid(item, await conflictAhead(db, item, f)) : {};
  // A major finding the person said to fix would come back as a question at the next head; their request is the answer to it.
  const major = o.plan.some((p) => p.major && o.fix.includes(p.n));
  if (o.again === "fixup" && path !== null && f?.review?.verdict === "take-fix" && !major && !o.instruction) return { write: await mergeLeg(c, had), ...note };
  if (o.again === "fixup") {
    const merge = o.merges && had === null;
    const fix = writeOf(await step(() => checkFixup(db, { repo: item.repo, number: item.number, by, instructions: fixInstructions(o.plan, o.fix, o.instruction ?? null), merge, afterBase: path !== null })));
    const leg = o.merges && !merge ? await mergeLeg(c, had) : nothing;
    return { write: async (id) => { await leg(id); await fix(id); }, ...note };
  }
  const leg = o.merges ? await mergeLeg(c, had) : nothing;
  return {
    ...note, ...(byHand(path) ? { waits: path } : {}), ...said,
    write: async (id) => {
      await leg(id);
      if (o.again === "review") await markReviewsStale(db, by, item.repo, item.number);
    },
  };
}

// ---- hold, backlog, close ------------------------------------------------------------------------------------------------

/** The fix-ups asked for on the PR that were not made yet. */
export const askedFixes = async (db: Db, pr: { repo: string; number: number }): Promise<{ instructions: string; head: string }[]> =>
  (await loadFixupRequests(db, { open: true, refs: [pr], anyMaker: true })).filter((r) => r.state === "queued").map((r) => ({ instructions: r.instructions, head: r.from_head }));

/**
 * Asks again, as the person, for the fix-ups a hold ended: the ones asked for at the PR's head. A push since then was one of them, or the
 * author's. With `merges`, a fix-up carries the merge unless a merge leg works already.
 */
export async function askFixes(c: Ctx, fixes: readonly { instructions: string; head: string }[], merges: boolean): Promise<Write> {
  const { db, by, item } = c;
  const left = item.kind === "pr" ? fixes.filter((f) => f.head === item.head) : [];
  const last = left.at(-1);
  if (!last) return nothing;
  const f = await loadPrFact(db, item.repo, item.number);
  const merge = merges && (await activeLeg(db, item)) === null;
  return writeOf(await step(() => checkFixup(db, { repo: item.repo, number: item.number, by, instructions: last.instructions, merge, afterBase: conflictPath(f) !== null })));
}

/**
 * Stops everything that runs or waits for the item: its pre-approved merge (out of its batch first), queued fix-ups, its place in
 * an integration batch, queued model calls made for it alone, the implementation attempt of an issue that has no PR yet, and the
 * merge legs of the workflow's implementation PRs, and a close nobody made yet. Leased calls finish; nothing acts on their result once the workflow ended.
 * The caller has ended the workflow's row, so the queue takes none of it up again. Every part runs; the ones that could not stop are returned.
 */
export async function stopAll(c: Ctx): Promise<string[]> {
  const { db, by, item, at } = c;
  const why = `ended by ${by}`;
  const failed: string[] = [];
  const attempt = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { failed.push(effectText((e as Error).message)); }
  };
  const one = [{ repo: item.repo, number: item.number }];
  await stopCloses(c);
  if (item.kind === "pr") {
    const [active, requests, batched] = await db.together(() => Promise.all([
      activeLeg(db, item), loadFixupRequests(db, { open: true, refs: one, anyMaker: true }), inActiveBatch(db, item.repo, item.number),
    ]));
    if (active !== null && !(batched && c.keepBatch)) await attempt(() => endLeg(c, item));
    await endFixupRequests(db, requests.filter((r) => r.state === "queued").map((r) => ({ id: r.id, reason: why })));
    if (batched && !c.keepBatch && await inActiveBatch(db, item.repo, item.number)) await attempt(() => removeFromBatch(db, by, item.repo, item.number, c.exec));
  } else {
    for (const w of await cancelUnopened(db, [{ ...one[0]!, reason: why }], by, at)) {
      if (w.workspaceId !== null) await endWorkspace(db, w.workspaceId);
    }
  }
  // The workflow's merge legs on other items: an issue's implementation PRs.
  if (c.workflowId !== undefined && item.kind === "issue") {
    for (const p of await listWorkflowLegs(db, [c.workflowId])) {
      await attempt(() => endLeg(c, p));
    }
  }
  await withdrawItemCalls(db, ref(item), why);
  return failed;
}

/**
 * A person started or approved work on the item: the automatic path's queued calls for it alone are withdrawn, as the person's lane works it
 * from now on. A leased call finishes, and its result applies.
 */
export async function takeOver(c: Pick<Ctx, "db" | "by">, item: { repo: string; number: number }): Promise<void> {
  if (c.by === RULE_STARTER) return;
  // The steps with an approved lane: their jobs outside it are the automatic path's work on a PR.
  await withdrawUnownedItemCalls(c.db, { ref: ref(item), steps: Object.keys(LANE_STEPS), reason: `a workflow ${c.by} started or approved works it` });
}

/** Cancels the PR's merge leg, out of its batch first. The pre-approval pass may have ended it a moment ago, with its workflow. */
export async function endLeg(c: Ctx, pr: { repo: string; number: number }): Promise<void> {
  try {
    await cancelPreapproval(c.db, c.by, pr.repo, pr.number, c.exec, c.via);
  } catch (e) {
    if (!/has no pre-approved merge in progress$|changed a moment ago$/.test((e as Error).message) || await activeLeg(c.db, { ...pr, kind: "pr", head: null }) !== null) throw e;
  }
}

/** Takes back the closes and the comment to the author of the item, and those its workflow made of other items, that are still to be made: queued, or waiting for their person's sign-in or access. */
export async function stopCloses(c: Ctx): Promise<void> {
  const open = ["pending", "waiting-token", "waiting-permission"] as const;
  const of = { kinds: ["close", "comment-close", "ask-author"], states: open } as const;
  const maps = await c.db.together(() => Promise.all([
    loadActions(c.db, { refs: [{ repo: c.item.repo, number: c.item.number }], ...of }), ...(c.workflowId === undefined ? [] : [loadActions(c.db, { workflowIds: [c.workflowId], ...of })]),
  ]));
  const rows = maps.flatMap((m) => [...m.values()].flat());
  await saveActions(c.db, rows.map((a) => ({ id: a.id, state: "stopped", reason: `ended by ${c.by}`, at: c.at })), { from: open });
}

/**
 * Queues the close of the item as the person: a close action the action executor carries out (a comment as the app, then the close
 * through the user lane). A PR's action names its current head, so a push after the command stops the close. Everything that runs is
 * stopped first (`stopAll`), so no fix-up pushes to an item about to close.
 */
export async function queueClose(c: Ctx, workflowId: number, item: Target, closeAs: CloseAs | null = null): Promise<void> {
  const { db, by, at } = c;
  await queueLaneActions(db, [{ workflowId, repo: item.repo, number: item.number, kind: "comment-close", by, head: item.kind === "pr" ? item.head : null, at, closeAs }]);
}

// ---- the author's turn ---------------------------------------------------------------------------------------------------

/** Characters of the one line the item's status shows for an author ask. */
const ASK_LINE_CHARS = 160;

/** Why AutoCraft does not ask the author of the PR (authorUnaskable), read from the mirror; null when it may. */
export async function authorUnaskableOf(db: Db, pr: { repo: string; number: number }): Promise<string | null> {
  const [items, quiet, own] = await db.together(() => Promise.all([loadItems(db, [pr], "pr"), loadQuiet(db, [`${pr.repo}#${pr.number}`]), loadOwnLogins(db)]));
  const i = items.get(`${pr.repo}#${pr.number}`);
  return authorUnaskable({ login: i?.author, type: i?.author_type, quiet: quiet.size > 0, own });
}

/**
 * What AutoCraft asks a PR's author (`login`) for, at `head`: the comment, built from the review of that head (its public summary, and its
 * fixes nobody dropped from `plan`, by title and file) and the person's own `words`, and the line the status shows. Text that points at
 * the private reference is left out; the rest of the review's text is what passed its reply checks when it was parsed
 * (review/opus-parse.ts publicTexts), so no model call is needed here. `conflict`: the base branch the PR conflicts with, which the
 * comment asks the author to merge in or rebase on. `auto`: the review's recommendation asks, with no person's question first.
 */
export function authorAskFor(o: { login: string | null; head: string; review: ReviewRow | null; plan: readonly PlanPart[]; words: string | null; by: string; at: string; conflict?: string | null; auto?: boolean; unsent?: string | null }): AuthorAsk {
  const dropped = new Set(o.plan.filter((p) => p.state === "dropped").map((p) => p.title.toLowerCase()));
  const clean = (x: string | null | undefined): string | null => (x?.trim() && !REFERENCE_LEAK.test(x) ? x.trim() : null);
  const summary = clean(o.review?.public_summary);
  const fixes = (o.review?.fixes ?? []).flatMap((f) => (f.title && clean(f.title) && !dropped.has(f.title.toLowerCase()) ? [{ title: f.title, file: REFERENCE_LEAK.test(f.file) ? "" : f.file }] : []));
  const words = o.words?.trim() || null;
  const text = authorAskComment({ login: o.login, summary, fixes, words, from: words && !o.auto ? o.by : null, conflict: o.conflict ?? null });
  const line = clipText(firstSentence(words ?? summary ?? fixes[0]?.title ?? t("finish the pull request")).replace(/\s+/g, " "), ASK_LINE_CHARS);
  return { login: o.login, head: o.head, text, line, by: o.by, at: o.at, ...(o.auto ? { auto: true as const } : {}), ...(o.unsent ? { unsent: o.unsent } : {}) };
}

/** The author ask a person's command makes on the PR `c.item` at its head: its author and its review there are read. */
export async function authorAskOf(c: Ctx, words: string | null, plan: readonly PlanPart[]): Promise<AuthorAsk> {
  const { db, item } = c;
  if (item.kind !== "pr") throw new EffectError(t("ask author is for pull requests."));
  if (!item.head) throw new EffectError(t("AutoCraft has not read the head commit of {ref} yet.", { ref: `${item.repo}#${item.number}` }));
  const ref = `${item.repo}#${item.number}`;
  const [items, reviews, quiet, own] = await db.together(() => Promise.all([
    loadItems(db, [{ repo: item.repo, number: item.number }], "pr"), loadReviewsAt(db, [{ repo: item.repo, number: item.number, head: item.head! }]), loadQuiet(db, [ref]), loadOwnLogins(db),
  ]));
  const i = items.get(ref);
  const no = authorUnaskable({ login: i?.author, type: i?.author_type, quiet: quiet.size > 0, own });
  if (no) throw new EffectError(t("AutoCraft does not ask the author of {ref}: {why}.", { ref, why: no }));
  const conflict = i?.mergeable === "CONFLICTING" ? i.base_ref : null;
  return authorAskFor({ login: i?.author ?? null, head: item.head, review: reviews.get(headRef(item.repo, item.number, item.head)) ?? null, plan, words, by: c.by, at: c.at, conflict, unsent: await actBlocked(db, item.repo) });
}

/**
 * Queues the comment of the workflow's author ask: the act step posts it as the app (src/act), once, while the workflow still waits for
 * the author at that head. A new ask of the same workflow takes the place of the one before.
 */
export async function queueAuthorAsk(db: Db, workflowId: number, pr: { repo: string; number: number }, ask: AuthorAsk): Promise<void> {
  await queueActions(db, [{ workflowId, repo: pr.repo, number: pr.number, kind: "ask-author", by: ask.by, head: ask.head, at: ask.at }]);
}

// ---- autorepin -----------------------------------------------------------------------------------------------------------

/** The existing autorepin command, unchanged: `<pull request> [via <branch>]` or `off`. The caller has applied the act rule. */
export async function autorepin(c: Ctx, args: string, githubId: number | null): Promise<string> {
  const m = /^(\S+)(?:\s+via\s+(\S+))?$/i.exec(args.trim());
  if (!m) throw new EffectError(t("autorepin needs a pull request, or off."));
  const off = m[1]!.toLowerCase() === "off";
  const prRef = off ? null : parsePrRef(m[1]!);
  if (!off && !prRef) throw new EffectError(t("{ref} is not a pull request.", { ref: m[1]! }));
  if (githubId === null) throw new EffectError(t("AutoCraft has no GitHub id for {login} yet. Sign in to the dashboard once.", { login: c.by }));
  return await step(() => requestRepin(c.db, {
    login: c.by, githubId, role: "", canWrite: true, authorized: true, repo: c.item.repo, number: c.item.number, pr: c.item.kind === "pr",
    ref: prRef, branch: m[2] ? parseBranch(m[2]) : null, at: new Date(c.at),
  }));
}

// ---- controls ------------------------------------------------------------------------------------------------------------

export const releaseHeldItem = async (c: Ctx): Promise<void> => { await step(() => releaseHeld(c.db, c.by, [{ repo: c.item.repo, number: c.item.number }])); };
export const resumeBreaker = (db: Db, by: string, key: string): Promise<void> => step(() => resumeStage(db, key, by));
/** The repo's Automatic switch: whether AutoCraft works its items without a person picking them (the per-repo Pipeline switch). */
export const setAutomatic = async (db: Db, by: string, repo: string, on: boolean): Promise<boolean> => (await step(() => setPipelineFlags(db, [{ repo, on }], by))).changed.length > 0;
