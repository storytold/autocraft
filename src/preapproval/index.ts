// The fix-up a person asks for, and the pre-approved merge it or an approval can start.
//
// A pre-approved merge is the merge leg of a person's workflow: the merge they approved, worked through a fix-up, its review, CI
// and the pre-merge review. States (see Preapproval in web/src/api/types.ts):
//   fixup   -> the fix-up step works the operator's instructions (source 'operator' in its fixups rows)
//   review  -> the fix-up pushed; waiting for the Opus review of the pushed head. A row with no fix-up (the merge of an approved workflow) starts
//              here at its head. A merge-queue entry waits here only for a review it owes (src/core/evidence.ts neededReview).
//   ci      -> that review says take (sure or unsure, not stale); waiting for CI of the pushed head, then for a clean pre-merge review of it.
//              A take-fix review keeps the row in review while the pipeline's fix-up of its fixes runs; that push is reviewed again. The
//              pre-merge review's defects get up to three fix-up rounds, and fixes or red CI the pipeline cannot repair wait for the contributor.
//   queued  -> CI is green and the pre-merge review is clean: the merge queue merges it as the person who approved the workflow
//              (src/core/may.ts mayMerge), with every check it always makes (safe-merge included). It goes back
//              to review when a new review asks for fixes; what only a person's answer settles is the workflow's question (src/workflow/ask.ts).
// A push of ours (whatever step made it) never ends the row: in every state it goes on at the new head, through the review, CI and the
// pre-merge review that head needs, and a row in fixup takes its request there. Someone else's push cancels it.
//   merged / cancelled / failed end it, the last two with a Stop: its text and its code. A stop ends the leg failed; the workflow then stops
//   at the blocker of the code with its recommendation. A leg whose people no longer count on the repo waits; the workflow asks.
// Every transition is a pure reaction to rows other steps write (fixups, opus_reviews, pr_checks, items, merges), evaluated by
// advancePreapprovals on each runner tick: no timer and no wait of its own; the one time comparison (the start of the mirror's last sync against the push) is made when the tick runs anyway. Merging itself is never called from here.
import type { Preapproval } from "../../web/src/api/types.ts";
import { systemBlock } from "../conversations/store.ts";
import type { Params, Stop, StopCode } from "../core/codes.ts";
import { byHand, conflictPath, decidePr, fixAllowed, fixupOf, isDraft as draftPr, mergeOwned, notStarted, premergeFix } from "../core/decide.ts";
import { pushRefusal } from "../core/gates.ts";
import { draftOf, loadPrFact, loadPrFacts } from "../core/facts.ts";
import { askedParts, chainsOwn, ciAt, neededReview, type HeadReview, type RecordedPush } from "../core/evidence.ts";
import { PREMERGE_MAX_TRIES } from "../core/rules.ts";
import { mayPush } from "../core/may.ts";
import { standingFor } from "../core/standing.ts";
import { ensureAuthorWrites } from "../fixup/author-permission.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { repoHasNoCi } from "../merge/no-ci.ts";
import { optionalChecksOf } from "../optional-checks.ts";
import { findingsOf, premergeAt } from "../premerge/store.ts";
import { stoppingDefects } from "../premerge/types.ts";
import { removeFromBatch } from "../merge/controls.ts";
import type { Exec } from "../fixup/git.ts";
import { staleReviews } from "../review/discussion.ts";
import { reviewHold } from "../review/gate.ts";
import type { PrFacts } from "../core/plan.ts";
import { fixPath, redCiPath, redCiStopReason, revisesNow } from "./paths.ts";
import { operatorTriesLeft, queuedOperatorFix } from "./state.ts";
import { refreshSettlers, type RefreshDeps } from "./permissions.ts";
import { addAudit, listAudit, loadAuditActions, withConfig } from "../data/control/index.ts";
import { loadChecks, loadItems, loadRepos, type PrChecksView } from "../data/mirror/index.ts";
import { getBatch, loadBatchByBranch, loadBatchMembership, loadMergeFacts, type MergeFacts } from "../data/merge/index.ts";
import { loadOperatorFixResults } from "../data/changes/index.ts";
import { loadOwnPushes } from "../data/views/own-pushes.ts";
import { loadMergeEntryReviews, loadReviewsAt, type ReviewFinding } from "../data/review/index.ts";
import { verdictToAct } from "../core/review-blocking.ts";
import type { Blocking } from "../premerge/types.ts";
import { isRunning } from "../data/jobs/index.ts";
import { permKey, standings, type Standing } from "../data/access/index.ts";
import { githubIdentity } from "../github/identity.ts";
import { addTurns } from "../data/conversations/index.ts";
import {
  addFixupRequests, addLegs, adoptLegs, endFixupRequests, listWorkflows, loadFixupRequests, loadLegPass, loadLegs, loadWorkflowFacts, moveFixupRequests, moveLegs, relinkLegFix,
  type LegContext, type LegMove, type LegPass, type LegRow, type LegState, type WorkflowFact,
} from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { asSentence, clipText } from "../prose.ts";
import { INPUT_TOPICS } from "../runner/autopilot.ts";

const ACTOR = "pipeline";
export const INSTRUCTIONS_MAX = 1500;
const ACTIVE: readonly LegState[] = ["fixup", "review", "ci", "queued"];
/** Plan states in which the PR gets no review, so a pre-approved merge cannot go on. A label never stops one: a live pre-approval lifts the label gate (src/core/decide.ts); a draft waits to be marked ready. */
const NOT_REVIEWABLE = ["out-of-scope", "integration", "backlog"];
const short = (sha: string | null) => (sha ?? "").slice(0, 7);
const oneLine = (s: string, n = 200) => clipText(s, n);
const refOf = (repo: string, n: number) => `${repo}#${n}`;

type Row = LegRow;
type PrRow = { state: string; head_oid: string | null; kind: string; head_repo: string | null; head_ref: string | null; is_draft: number | null; updated_at: string | null };

const prRow = async (db: Db, repo: string, n: number): Promise<PrRow | undefined> =>
  (await loadItems(db, [{ repo, number: n }], "pr")).get(refOf(repo, n));

const toView = (r: Row): Preapproval => ({ id: r.id, by: r.by, at: r.at, instructions: r.instructions, state: r.state, fromHead: r.from_head, head: r.head, reason: r.reason, updatedAt: r.updated_at });

/** The newest pre-approved merge of the PR, or null. */
export async function preapprovalOf(db: Db, repo: string, n: number): Promise<Preapproval | null> {
  const r = (await loadLegs(db, [{ repo, number: n }], { latestOnly: true })).get(refOf(repo, n))?.at(-1);
  return r ? toView(r) : null;
}

/** Every pre-approved merge of the PR, oldest first. */
export async function preapprovalsOf(db: Db, repo: string, n: number): Promise<Preapproval[]> {
  return ((await loadLegs(db, [{ repo, number: n }])).get(refOf(repo, n)) ?? []).map(toView);
}

/** The system lines of the items' threads (items with no conversation are skipped). */
async function sayAll(db: Db, lines: { repo: string; number: number; text: string }[]): Promise<void> {
  if (!lines.length) return;
  await addTurns(db, lines.map((l) => ({ ref: refOf(l.repo, l.number), kind: "system", login: "system", body: l.text, block: systemBlock(l.text), onlyIfThread: true })));
}
export const say = async (db: Db, repo: string, n: number, text: string): Promise<void> => await sayAll(db, [{ repo, number: n, text }]);

/** The ends that leave nobody anything to settle. */
const SETTLED: ReadonlySet<StopCode> = new Set(["workflow-ended", "pr-gone", "pr-closed", "pr-merged"]);
/** Why a leg ends: `text` is stored as its reason and shown, `code` stands for its blocker (src/workflow/blockers.ts legBlocker). */
const stopOf = (code: StopCode, text: string, params?: Params): Stop => ({ code, who: SETTLED.has(code) ? "system" : "person", ...(params ? { params } : {}), text });

type Moved = { head?: string | null; stop?: Stop; by?: string; via?: string };

/** Moves the row to `to` when it is still in its state; the module audits the transition (the trace shows it). Joins a caller's transaction. */
async function moveRaw(db: Db, p: Row, to: LegState, o: Moved): Promise<boolean> {
  const m: LegMove = {
    id: p.id, from: p.state, to, ...(o.head != null ? { head: o.head } : {}), reason: o.stop?.text ?? null,
    ...(o.stop ? { code: o.stop.code } : {}), ...(o.stop?.params ? { params: o.stop.params } : {}), ...(o.by ? { by: o.by } : {}), ...(o.via ? { via: o.via } : {}),
  };
  return (await moveLegs(db, [m])).length === 1;
}

/** `moveRaw`, then says it in the thread. */
async function move(db: Db, p: Row, to: LegState, o: Moved & { line: string }): Promise<boolean> {
  if (!await moveRaw(db, p, to, o)) return false;
  await say(db, p.repo, p.number, o.line);
  return true;
}

/** The PR's newest merge attempt at `head` merged it. */
const mergedAt = (m: MergeFacts, repo: string, n: number, head: string | null): boolean => !!head && m.attempts.get(`${refOf(repo, n)}@${head}`)?.outcome === "merged";

/** Why a cancel of the leg can no longer stop its merge, past the guard of the merge queue: a batch holds the PR, or it is merged. Null while it can. */
export async function pastCancel(db: Db, p: Pick<Row, "repo" | "number" | "state" | "head">): Promise<string | null> {
  if (p.state !== "queued") return null;
  const [batched, merging, merges] = await db.together(() => Promise.all([inActiveBatch(db, p.repo, p.number), mergeRunning(db, p.repo), loadMergeFacts(db, [{ repo: p.repo, number: p.number }])]));
  if (batched) return "the PR is still in an integration batch";
  if (merging) return "a merge of the repo is running: it may be merging this PR";
  return mergedAt(merges, p.repo, p.number, p.head) ? "the PR is already merged" : null;
}

/** Cancels the row in one transaction, whatever state the caller read. False when the row had ended meanwhile. */
async function cancelRow(db: Db, leg: { id: number; repo: string; number: number }, by: string, stop: Stop, line: string, guard = false, via?: string): Promise<boolean> {
  // Nothing is written before an early return, so committing leaves the database as a rollback would.
  const p = await db.write(async () => {
    const p = (await loadLegs(db, [{ repo: leg.repo, number: leg.number }], { activeOnly: true })).get(refOf(leg.repo, leg.number))?.find((r) => r.id === leg.id);
    if (!p || !ACTIVE.includes(p.state)) return null;
    const late = guard ? await pastCancel(db, p) : null;
    if (late !== null) throw new Error(late);
    return await moveRaw(db, p, "cancelled", { by, stop, via }) ? p : null;
  });
  if (!p) return false;
  await say(db, p.repo, p.number, line);
  return true;
}

// ---- starting a step ----------------------------------------------------------------------------------------------------

/**
 * A step whose checks passed. `write` makes its rows in the caller's transaction, for the live workflow it belongs to, and returns its merge
 * leg (null for a fix-up alone): the workflow may be written in that same transaction, so no check here reads it.
 */
export type CheckedStep = { write: (workflowId: number) => Promise<number | null> };

/** A step's refusal by rule (the PR or its state); other errors may pass on a later try. `active`: a merge leg is in progress already. `draft`: it waits for the PR to be marked ready. */
export class PreapprovalRefused extends Error {
  readonly active: boolean;
  readonly draft: boolean;
  constructor(message: string, why: "active" | "draft" | null = null) { super(message); this.active = why === "active"; this.draft = why === "draft"; }
}

/**
 * A person dropped plan parts (`titles`): the parts-only fix-up requests of the PR (src/core/evidence.ts askedParts) lose them, as the
 * person's word wins over the fix-up AutoCraft asked for. A request is never changed under a try that may be reading it: it is withdrawn,
 * and one with parts left is asked again with those, at the same head and for the same merge leg. What a withdrawn try made is not pushed
 * (src/fixup/index.ts checks the request right before the push; its lint run takes no withdrawn request). A leg whose request is withdrawn
 * with no part left goes back to review at the head it was at, so the merge goes on there.
 */
export async function dropFixParts(db: Db, o: { repo: string; number: number; titles: readonly string[]; by: string }): Promise<void> {
  const dropped = new Set(o.titles.map((x) => x.toLowerCase()));
  if (!dropped.size) return;
  const requests = (await loadFixupRequests(db, { refs: [{ repo: o.repo, number: o.number }], anyMaker: true })).filter((r) => r.state === "queued");
  const changed: { id: number; by: string; head: string; instructions: string | null }[] = [];
  for (const r of requests) {
    const parts = askedParts(r.instructions);
    if (!parts) continue;
    const kept = parts.map((p, i) => ({ p, i })).filter(({ p }) => !dropped.has(p.title.toLowerCase()));
    if (kept.length === parts.length) continue;
    const [first, ...lines] = r.instructions.split("\n");
    changed.push({ id: r.id, by: r.by, head: r.from_head, instructions: kept.length ? [first, ...kept.map(({ i }) => lines[i]!)].join("\n") : null });
  }
  if (!changed.length) return;
  await db.write(async () => {
    const ended = new Set(await endFixupRequests(db, changed.map((c) => ({ id: c.id, reason: `${o.by} dropped ${c.instructions === null ? "every part" : "parts"} it fixes` }))));
    const legs = (await loadLegs(db, [{ repo: o.repo, number: o.number }], { activeOnly: true })).get(refOf(o.repo, o.number)) ?? [];
    for (const c of changed) {
      if (!ended.has(c.id)) continue;
      const leg = legs.find((l) => l.state === "fixup" && l.fix_id === c.id);
      if (c.instructions !== null) {
        const made = (await addFixupRequests(db, [{ repo: o.repo, number: o.number, fromHead: c.head, instructions: c.instructions, by: c.by, merge: false }])).get(refOf(o.repo, o.number));
        if (leg && made) await relinkLegFix(db, leg.id, made.requestId);
      } else if (leg) {
        await move(db, leg, "review", { head: leg.from_head, line: `${o.by} dropped every part the fix-up of ${short(leg.from_head)} was to fix: it is withdrawn, and the merge goes on at ${short(leg.from_head)}.` });
      }
    }
  });
}

/** A refusal that a moment may lift: GitHub has not answered yet on what the step needs. */
export class NotYet extends Error {}

/** Why a leg pinned to a head (a command's) was refused: the PR has another head now. */
export const HEAD_CHANGED = "the PR changed after your comment; comment again";

const busy = (ref: string) => new PreapprovalRefused(`${ref} already has a pre-approved merge in progress`, "active");
const hasLeg = async (db: Db, repo: string, number: number): Promise<boolean> => (await loadLegs(db, [{ repo, number }], { activeOnly: true })).size > 0;

/** The open PR with its head; refused otherwise. */
async function openPr(db: Db, repo: string, number: number): Promise<PrRow> {
  const it = await prRow(db, repo, number);
  if (!it || it.kind !== "pr") throw new PreapprovalRefused(`${refOf(repo, number)} is not a pull request`);
  if (it.state !== "OPEN") throw new PreapprovalRefused(`${refOf(repo, number)} is not open`);
  return it;
}
const needHead = (it: PrRow, ref: string): string => {
  if (!it.head_oid) throw new Error(`${ref} has no head commit in the mirror yet`);
  return it.head_oid;
};
const outOfScope = (ref: string) => new PreapprovalRefused(`${ref} is outside the pipeline's scope`);
const isDraft = (ref: string) => new PreapprovalRefused(`${ref} cannot be reviewed yet: it is a draft`, "draft");

/**
 * Checks a fix-up of the PR's current head with these instructions, made as `by`; with `merge`, its merge leg goes on after it. The PR has a
 * live workflow. Reads the author's permission on GitHub when it has to. `afterBase`: the conflict step merges the base branch into the PR once
 * the merge is approved (conflictPath), and the fix-up is made at the head that merge leaves.
 */
export async function checkFixup(db: Db, o: { repo: string; number: number; by: string; instructions: string; merge: boolean; afterBase?: boolean }): Promise<CheckedStep> {
  const { repo, number, by, merge } = o;
  const ref = refOf(repo, number);
  const it = await openPr(db, repo, number);
  // The fix-up step and the review of its push only see PRs the planner works, which an integration PR is not. The workflow puts the PR in scope.
  const fact = await loadPrFact(db, repo, number);
  if (!fact || fact.integration) throw outOfScope(ref);
  if (merge && fact.draft) throw isDraft(ref);
  const instructions = o.instructions.trim();
  if (!instructions) throw new Error("the fix-up needs instructions");
  if (instructions.length > INSTRUCTIONS_MAX) throw new Error(`the instructions are over ${INSTRUCTIONS_MAX} characters`);
  const head = needHead(it, ref);
  const checks = (await loadChecks(db, [{ repo, number }])).get(ref) as PrChecksView | undefined;
  if (fact.mergeable === "CONFLICTING" && !o.afterBase) throw new Error(`${ref} conflicts with its base branch: the conflict merge comes first`);
  // A person's fix-up runs as that person (mayPush, src/core/may.ts); the repo's push approval is for pushes nobody asked for.
  const may = mayPush({ kind: "fixup", repoApproval: null, workflow: null, operatorFix: true, by });
  if (!may.ok) throw new Error(may.why);
  const writes = await ensureAuthorWrites(db, repo, number, it.head_repo);
  if (writes === "unknown") throw new NotYet("the author's permission on the repository could not be read yet; try again");
  if (!pushable(it.head_repo, repo, checks?.head_oid === head ? checks.maintainer_can_modify : null, it.head_ref, await longLivedOf(db, repo), false, writes === "yes")) throw new Error("can't push to the contributor's branch");
  if (!await operatorTriesLeft(db, repo, number, fact.workflow?.since)) throw new Error("the fix-up tries for this PR are used up");
  if (await queuedOperatorFix(db, repo, number, head)) throw new Error(`a fix-up of ${ref} is already queued`);
  if (merge && await hasLeg(db, repo, number)) throw busy(ref);
  return {
    write: async (workflowId) => {
      if (merge && await hasLeg(db, repo, number)) throw busy(ref);
      const made = (await addFixupRequests(db, [{ repo, number, fromHead: head, instructions, by, merge, ...(merge ? { workflowId } : {}) }])).get(ref);
      await say(db, repo, number, merge
        ? `${by} approved a merge after a fix-up: a fix-up of ${short(head)} is queued; if its review says take and CI is green, the PR goes to the merge queue.`
        : `${by} queued a fix-up of ${short(head)}.`);
      return made?.legId ?? null;
    },
  };
}

/**
 * Checks a merge leg with no fix-up: it starts in `review` at the current head, so the PR merges only after a take review, a clean
 * pre-merge review and green CI there. The approval says the change is wanted, so an unsure review does not stop it, and a take-fix
 * review's fixes are made by the pipeline's fix-up, whose push is reviewed again; a review that says hold or close, a pre-merge defect past its
 * fix-up rounds or a failed verification stops the leg and the workflow has it fixed (src/workflow/advance.ts fixFirst); a red head the CI fix
 * cannot repair or a fix-up that cannot run stops the leg and the workflow asks.
 *
 * The workflow the leg belongs to puts the PR in the pipeline's scope and is its merge approval, so neither is checked. `head`, when
 * given, is the only head it may start at: the one the person saw (a command's comment-time head). `fromHead`: the head the person
 * approved, when pushes of ours lead from it to the PR's head.
 */
export async function checkMergeLeg(db: Db, o: { repo: string; number: number; by: string; via?: string; head?: string; fromHead?: string }): Promise<CheckedStep> {
  const { repo, number, by, via } = o;
  const ref = refOf(repo, number);
  const it = await openPr(db, repo, number);
  const fact = await loadPrFact(db, repo, number);
  if (!fact || fact.integration) throw outOfScope(ref);
  if (fact.draft) throw isDraft(ref);
  const head = needHead(it, ref);
  if (o.head !== undefined && head !== o.head) throw new Error(HEAD_CHANGED);
  if (await hasLeg(db, repo, number)) throw busy(ref);
  return {
    write: async (workflowId) => {
      // The insert refuses a second active leg itself (the partial unique index).
      const made = (await addLegs(db, [{ repo, number, by, workflowId, head, ...(o.fromHead ? { fromHead: o.fromHead } : {}), state: "review", ...(via ? { via } : {}) }])).get(ref);
      if (made === undefined || made === "active") throw busy(ref);
      await say(db, repo, number, `${by} added the PR to the merge queue at ${short(head)}: it merges once the review there says take, the pre-merge review is clean and CI is green.`);
      return made;
    },
  };
}

/**
 * Starts the merge leg (`checkMergeLeg`) of the live workflow that works on the PR: its own, or the one of the issue it implements.
 * Refused when there is none, or when it is not the one the caller names.
 */
export async function preapproveMerge(db: Db, o: { repo: string; number: number; by: string; via?: string; head?: string; fromHead?: string; workflowId?: number }): Promise<void> {
  const { repo, number } = o;
  const ref = refOf(repo, number);
  const facts = await loadWorkflowFacts(db, [{ repo, number }]);
  const id = (facts.live.get(ref) ?? facts.ofPr.get(ref))?.id;
  if (id === undefined) throw new PreapprovalRefused(`${ref} is not started`);
  if (o.workflowId !== undefined && o.workflowId !== id) throw new PreapprovalRefused(`another workflow works on ${ref}`);
  const leg = await checkMergeLeg(db, o);
  await db.write(async () => {
    if (!(await listWorkflows(db, { ids: [id], live: true })).length) throw new PreapprovalRefused(`the workflow of ${ref} ended a moment ago`);
    await leg.write(id);
  });
}

// ---- the state machine ---------------------------------------------------------------------------------------------------

/**
 * What the thread calls the row's head: the fix-up's push; for a row without a fix-up, the pipeline's push it went on with or, for one added to the merge queue and not pushed to since, the PR's own head.
 */
function headName(p: Row): string {
  return p.fix_id !== null ? "the pushed head" : p.head !== p.from_head ? "the new head" : "the PR's head";
}

/** What one advance pass reads of the legs' PRs, loaded in one wave for every active leg. */
type PassFacts = {
  items: Map<string, PrRow>;
  checks: Map<string, PrChecksView>;
  syncedAt: Map<string, string | null>;
  merge: MergeFacts;
  fixResults: Map<number, { state: string; fromHead: string; toHead: string | null; reason: string | null }>;
  /** Every push of ours to each PR. */
  pushes: Map<string, RecordedPush[]>;
  workflows: Map<number, WorkflowFact>;
  /** Who each of the workflows acts for, newest first. */
  actors: Map<number, string[]>;
  /** The reviewed heads of merge entries. */
  mergeEntryReviews: Map<string, HeadReview[]>;
  reviews: Map<string, { verdict: string; sure: boolean; reason: string; at: string; fixes: ReviewFinding[]; hold: Blocking | null; blockedBy: string[] }>;
  /** Who still counts on the repo, of the people the legs act for, keyed by permKey. */
  stands: Map<string, Standing>;
  /** The repo's optional checks. */
  optional: (repo: string) => string[];
  /** The repo's stale reviews, read once per pass; `refresh`: when that answer changes with the clock alone, per PR. */
  stale: (repo: string) => Promise<{ heads: Set<string>; refresh: Map<string, number> }>;
};

/**
 * Whether the people the leg acts for count on the repo: up to the hand-over it is work on the item, after it the approver's merge. A merge
 * nobody is recorded to have approved is the leg maker's.
 */
function standsOf(p: Row, leg: LegContext, pf: PassFacts): Standing {
  const of = (login: string): Standing => pf.stands.get(permKey(login, p.repo)) ?? "unknown";
  const w = pf.workflows.get(leg.workflowId);
  return standingFor(w ? { ...w, actors: pf.actors.get(w.id) ?? [] } : null, p.state === "queued" ? "merge" : "work", of)?.standing ?? of(p.by);
}

async function loadPassFacts(db: Db, { rows, context }: LegPass): Promise<PassFacts> {
  const refs = [...new Map(rows.map((r) => [refOf(r.repo, r.number), { repo: r.repo, number: r.number }])).values()];
  const repos = [...new Set(rows.map((r) => r.repo))];
  const heads = rows.flatMap((r) => (r.head ? [{ repo: r.repo, number: r.number, head: r.head }] : []));
  const fixIds = rows.flatMap((r) => (r.fix_id !== null ? [r.fix_id] : []));
  const [items, checks, repoRows, merge, fixResults, pushes, wfFacts, reviews, identity, mergeEntryReviews, optional] = await db.together(() => Promise.all([
    loadItems(db, refs, "pr"), loadChecks(db, refs), loadRepos(db, { names: repos }), loadMergeFacts(db, refs), loadOperatorFixResults(db, fixIds),
    loadOwnPushes(db, refs), loadWorkflowFacts(db, refs), loadReviewsAt(db, heads), githubIdentity(db), loadMergeEntryReviews(db, refs), optionalChecksOf(db),
  ]));
  const acting = rows.flatMap((r) => { const c = context.get(r.id); return [r.by, ...(typeof c === "object" ? wfFacts.actors.get(c.workflowId) ?? [] : [])].map((login) => ({ login, repo: r.repo })); });
  const stands = await standings(db, acting, { identity });
  const staleReads = new Map<string, ReturnType<PassFacts["stale"]>>();
  const readStale: PassFacts["stale"] = async (repo) => {
    const refresh = new Map<string, number>();
    return { heads: await staleReviews(db, repo, false, { refresh: (r, at) => void refresh.set(r, Math.min(at, refresh.get(r) ?? at)) }), refresh };
  };
  const stale: PassFacts["stale"] = (repo) => {
    let read = staleReads.get(repo);
    if (!read) staleReads.set(repo, read = readStale(repo));
    return read;
  };
  const workflows = new Map<number, WorkflowFact>();
  for (const f of [...wfFacts.live.values(), ...wfFacts.ofPr.values()]) workflows.set(f.id, f);
  return {
    items, checks, merge, fixResults, pushes, mergeEntryReviews, workflows, actors: wfFacts.actors, stands, optional, stale,
    syncedAt: new Map(repos.map((r) => [r, repoRows.get(r)?.synced_at ?? null])),
    reviews: new Map([...reviews].map(([k, v]) => [k, { verdict: v.verdict, sure: v.sure, reason: v.reason, at: v.at, fixes: v.fixes, hold: v.workflow?.hold ?? null, blockedBy: v.blocked_by }])),
  };
}

const verifyFailed = (p: Row): Stop => stopOf("verification-failed", `verification failed at ${headName(p)}`);

/** Why a failed verification of the head stops the leg; null without one, and when the person answered after it. */
function verifyStop(p: Row, head: string, pf: PassFacts, leg: LegContext | null): Stop | null {
  const v = pf.merge.verifications.get(`${refOf(p.repo, p.number)}@${head}`);
  return v && (v.state === "failed" || v.state === "error") && !(leg && v.finishedAt && v.finishedAt <= leg.since) ? verifyFailed(p) : null;
}

type Hand = { done: true } | { gone: true } | { wait: true } | { stop: Stop };

/** Moves the row from ci to queued: the merge queue merges it as the workflow's approver from here. Idempotent. */
async function handOver(db: Db, p: Row, head: string, pf: PassFacts, leg: LegContext | null, unsure = false, past: "overruled" | "premerge-failed" | null = null): Promise<Hand> {
  // A hand-over waits for a running verification, and goes on over a failed one only when the person answered after it.
  const v = pf.merge.verifications.get(`${refOf(p.repo, p.number)}@${head}`);
  if (v && (v.state === "planned" || v.state === "running")) return { wait: true };
  const failed = verifyStop(p, head, pf, leg);
  if (failed) return { stop: failed };
  if (!await moveRaw(db, p, "queued", { head })) return { gone: true };
  await say(db, p.repo, p.number, past === "premerge-failed"
    ? "CI is green, and the merge goes on without the pre-merge review that failed, as a maintainer answered: the PR is in the merge queue, which checks it as for any approved merge."
    : past === "overruled"
      ? "CI is green, and a maintainer dropped the pre-merge review's findings that blocked the merge: the PR is in the merge queue, which checks it as for any approved merge."
      : unsure
        ? "CI is green and the pre-merge review found no defect, though it could not verify every claim of the description: the merge was approved, so the PR is in the merge queue, which checks it as for any approved merge."
        : "CI is green and the pre-merge review is clean: the PR is in the merge queue, which checks it as for any approved merge.");
  return { done: true };
}

/**
 * The leg's PR conflicts with its base branch: the leg waits where it is, as the plan does. The conflict step's base merge is a head it goes on
 * with; a conflict only a person can resolve is not a question, and their push ends the leg.
 */
async function onConflict(db: Db, p: Row, head: string, f: PrFacts | null): Promise<void> {
  const path = conflictPath(f);
  if (byHand(path)) await noteOnce(db, p, head, "conflict", `The PR conflicts with its base branch: the merge stays approved and waits for ${path === "contributor" ? "the contributor" : "a person"} to resolve the conflict.`);
}

/**
 * The verdict of the Opus review at `head` the merge acts on, stale or not; null with no review there. Without the fixes a person dropped, and,
 * as the merge is approved, without the fixes that do not block it; a hold that does not block it goes on.
 */
function keptVerdict(p: Row, head: string, pf: PassFacts, approval = true): string | null {
  const r = pf.reviews.get(`${refOf(p.repo, p.number)}@${head}`);
  const w = p.workflow_id === null ? undefined : pf.workflows.get(p.workflow_id);
  return r ? verdictToAct(r.verdict, r.fixes, w?.dropped, approval && (w ? w.approved : true), r.hold, r.blockedBy) : null;
}

type ReviewRead = { kind: "none" | "stale" | "take" | "takefix"; unsure: boolean; at?: string; /** A take-fix or hold whose findings do not block the approved merge: they are filed as follow-ups. */ followUps?: true } | { kind: "bad"; stop: Stop; unsure: boolean; at: string };

/**
 * The Opus review at `head`. A take or take-fix that is not stale goes on, sure or unsure: the merge approval says the change is wanted,
 * so a take-fix is the pipeline's own fix-up to make and the pre-approval goes on with its push; one whose fixes a person all dropped is a
 * take. Any other verdict stops it.
 */
async function reviewAt(p: Row, leg: LegContext | null, head: string, pf: PassFacts, wake?: Wake): Promise<ReviewRead> {
  const r = pf.reviews.get(`${refOf(p.repo, p.number)}@${head}`);
  const from = neededAt(leg, pf, refOf(p.repo, p.number), head)?.from ?? null;
  if (!r || (from !== null && r.at <= from)) return { kind: "none", unsure: false };
  const ref = refOf(p.repo, p.number);
  const stale = await pf.stale(p.repo);
  const at = stale.refresh.get(ref);
  if (at !== undefined) wake?.(at);
  if (stale.heads.has(`${ref}@${head}`)) return { kind: "stale", unsure: false };
  const unsure = !r.sure;
  const verdict = keptVerdict(p, head, pf);
  if (verdict === "take") return { kind: "take", unsure, at: r.at, ...(keptVerdict(p, head, pf, false) !== "take" ? { followUps: true as const } : {}) };
  if (verdict === "take-fix") return { kind: "takefix", unsure, at: r.at };
  const text = `the review says ${r.verdict}${unsure ? " (unsure)" : ""}${r.reason ? `: ${oneLine(r.reason, 160)}` : ""}`;
  return { kind: "bad", stop: stopOf(r.verdict === "close" ? "review-close" : "review-hold", text), unsure, at: r.at };
}

/** Why an unsure review or a take-fix does not stop the row, for its thread line. */
const approvedAhead = (p: Row) => (p.fix_id !== null ? "the merge was approved with a fix-up" : "the PR was queued to merge");

/** Says `line` in the thread once per row, head and note (the audit entry is the memory): for a wait that moves the row nowhere. */
async function noteOnce(db: Db, p: Row, head: string, note: string, line: string): Promise<void> {
  const ref = refOf(p.repo, p.number);
  const seen = ((await loadAuditActions(db, [ref], ["preapproval"])).get(ref) ?? [])
    .some((a) => a.details?.id === p.id && a.details?.note === note && a.details?.head === head);
  if (seen) return;
  await addAudit(db, [{ login: ACTOR, action: "preapproval", target: ref, details: { id: p.id, head, note } }]);
  await say(db, p.repo, p.number, line);
}

/** What AutoCraft's push to `cur` was when our own pushes alone lead there from `from`; null for a head someone else pushed, or pushed under ours. */
function ownPush(pf: PassFacts, ref: string, from: string | null, cur: string): string | null {
  const pushes = pf.pushes.get(ref) ?? [];
  return from !== null && from !== cur && chainsOwn(pushes, from, cur) ? pushes.find((x) => x.to === cur)?.what ?? null : null;
}

/** The Opus review the leg's head needs, as the planner judges it. */
const neededAt = (leg: LegContext | null, pf: PassFacts, ref: string, head: string): { from: string | null } | null =>
  (leg ? neededReview(leg, pf.pushes.get(ref) ?? [], head, pf.mergeEntryReviews.get(ref) ?? []) : { from: null });
/** The leg's head needs an Opus review. */
const needsReview = (leg: LegContext | null, pf: PassFacts, ref: string, head: string): boolean => neededAt(leg, pf, ref, head) !== null;

/** A push of ours moved the PR off the head the mirror shows, until a sync that began after the push has finished: no step works the old head any more, and the new one is not here yet. */
export function mirrorBehind(pushes: readonly RecordedPush[], head: string | null, syncedAt: string | null): boolean {
  return pushes.some((x) => x.landed && x.from === head && x.to !== head && (syncedAt === null || syncedAt <= x.at));
}

/** Why the planner does not list the operator's fix-up for the PR now; null when it does, or when it will after the conflict with the base branch. */
async function whyNotPlanned(db: Db, f: PrFacts): Promise<string | null> {
  if (decidePr(f).actions.some((a) => a.kind === "fixup" && a.params?.source === "operator")) return null;
  if (f.draft) return "the PR is a draft";
  if (f.heldBacklog) return "the PR is held in the backlog";
  // It is made once the conflict is gone, at the head that leaves; nobody's fix-up gets there while only a person could merge the base in. The
  // request itself lets the base in first, also on a PR whose review holds it (decide.ts conflictWanted).
  if (f.mergeable === "CONFLICTING") return (fixAllowed(f) || !!f.operator?.fix) && conflictPath(f) !== "person" ? null : "the PR conflicts with its base branch";
  if (!f.pushable) return "the PR's branch cannot be pushed to";
  if (!f.inScope) return "the PR is out of the pipeline's scope";
  if (notStarted(f)) return "nobody started the PR";
  const refused = pushRefusal(f, "fixup", true);
  if (refused) return `the push is not approved: ${refused.replace(/\.$/, "")}`;
  if (!await operatorTriesLeft(db, f.repo, f.number, f.workflow?.since)) return "the fix-up tries are used up";
  return "the pipeline does not plan the fix-up";
}

const FAILED_FIXUP = ["failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed", "superseded"];

/**
 * One merge leg: reads what the other steps recorded and makes at most one transition. A stop ends the leg failed: the workflow stops at a
 * blocker and gives its recommendation (src/workflow/advance.ts). A merge-queue entry has no Opus review to wait for, and a review the
 * person answered after (a yes past a major finding) counts as a take.
 */
async function advance(db: Db, p: Row, ctx: LegContext | "ended" | "unlinked", pf: PassFacts, factOf: () => Promise<PrFacts | null>, wake: Wake): Promise<void> {
  // A row no workflow owns waits for one to start on its PR (stop, backlog and close cancel it by its PR).
  if (ctx === "unlinked") return;
  const ref = refOf(p.repo, p.number);
  const it = pf.items.get(ref);
  const cancel = async (code: StopCode, text: string, params?: Params) => void await cancelRow(db, p, ACTOR, stopOf(code, text, params), `The pre-approved merge was cancelled: ${text}.`);
  const cur = it?.head_oid ?? null;
  const mergedByQueue = mergedAt(pf.merge, p.repo, p.number, p.head);
  if (p.state === "queued" && (it?.state === "MERGED" || mergedByQueue)) return void await move(db, p, "merged", { line: "The pre-approved merge went through: the PR is merged." });
  if (ctx === "ended") {
    // The workflow of a merged PR ends before this pass sees the merge: a queued leg whose merge is under way is left for merge detection,
    // so its history shows the merge and not a cancel.
    if (p.state === "queued" && it?.state === "OPEN" && await mergeRunning(db, p.repo)) return;
    if (it?.state !== "MERGED") return cancel("workflow-ended", "its workflow ended");
  }
  const leg = ctx === "ended" ? null : ctx;
  const stop = async (why: Stop) => void await move(db, p, "failed", { stop: why, line: asSentence(`The pre-approved merge stopped: ${why.text}`) });
  // A review the person had seen when they last answered: they chose to go on.
  const accepted = (r: ReviewRead): ReviewRead => (leg && r.kind === "bad" && r.at <= leg.since ? { kind: "take", unsure: r.unsure, at: r.at } : r);
  if (!it) return cancel("pr-gone", "the PR is gone");
  if (it.state === "MERGED") return cancel("pr-merged", p.fix_id !== null ? "the PR was merged before the fix-up finished" : "the PR was merged before the pre-approved merge reached the merge queue");
  if (it.state !== "OPEN") return cancel("pr-closed", "the PR was closed");

  // Nothing moves for people who no longer count: the workflow asks another maintainer, whose answer the leg goes on for. Nor while GitHub has
  // not answered on them (refreshSettlers reads it again and wakes the next pass).
  if (leg && standsOf(p, leg, pf) !== "yes") return;

  // A draft gets no work and no merge: the leg waits where it is, and the plan says for what.
  const draft = draftPr(draftOf(it, pf.checks.get(ref)));
  const behind = mirrorBehind(pf.pushes.get(ref) ?? [], cur, pf.syncedAt.get(p.repo) ?? null);

  if (p.state === "fixup") {
    // A try at a head the request has moved on from says nothing about the request, unless it pushed.
    const tried = p.fix_id !== null ? pf.fixResults.get(p.fix_id) : undefined;
    const fx = tried && (tried.fromHead === p.from_head || tried.state === "pushed") ? tried : undefined;
    if (fx?.state === "pushed" && fx.toHead) return void await move(db, p, "review", { head: fx.toHead, line: `The fix-up pushed ${short(fx.toHead)}; Opus reviews it next.` });
    // A push written before it ran: when the head is its commit, it landed.
    if (fx?.state === "pushing" && fx.toHead && cur === fx.toHead) return void await move(db, p, "review", { head: fx.toHead, line: `The fix-up pushed ${short(fx.toHead)}; Opus reviews it next.` });
    if (cur !== null && cur !== p.from_head && cur !== fx?.toHead) {
      // Another push of ours came first, which ends a try at the old head: the fix-up is made on top of it.
      const own = ownPush(pf, ref, p.from_head, cur);
      if (own) {
        if ((await moveFixupRequests(db, [{ id: p.fix_id!, from: p.from_head, to: cur }])).length) await say(db, p.repo, p.number, `The ${own} pushed ${short(cur)}; the fix-up is made there.`);
        return;
      }
    }
    // A try that another push overtook: the request follows that push once the mirror shows it.
    if (fx?.state === "superseded" && behind) return;
    if (fx && FAILED_FIXUP.includes(fx.state)) {
      return await stop(stopOf(fx.state === "too-large" ? "fix-too-large" : "fix-failed", `the fix-up ${fx.state}${fx.reason ? `: ${oneLine(fx.reason, 120)}` : ""}`, { state: fx.state }));
    }
    // Whatever the fix-up row says (none yet, linting, pushing), a head that is neither its start nor its push is someone else's.
    if (cur !== null && cur !== p.from_head && cur !== fx?.toHead) return cancel("author-push", `another push moved the head to ${short(cur)}`, { to: cur });
    // No try yet and the planner would not work the request (not pushable, conflicting, a draft, ...): it would wait for ever.
    if (!fx && !draft && !behind) {
      const f = await factOf();
      const why = f ? await whyNotPlanned(db, f) : null;
      if (why) await stop(stopOf("fix-cannot-run", `the fix-up cannot run: ${why}`));
      else if (f?.mergeable === "CONFLICTING") await onConflict(db, p, p.from_head, f);
    }
    return;
  }

  // Every later state: the head is the fix-up's push (or, with no fix-up, the row's starting head). Until a review exists at it, the mirror may still show the head the push started from, for a short time.
  const head = p.head!;
  if (cur !== null && cur !== head) {
    // The mirror row shows the old head until a sync that started after the push has finished (synced_at is the sync's start; the row's state entry follows the push); a review at the pushed head also shows the mirror saw it.
    const synced = pf.syncedAt.get(p.repo) ?? null;
    const lag = p.state === "review" && cur === p.from_head && (synced === null || synced <= p.updated_at) && !pf.reviews.has(`${ref}@${head}`);
    if (!lag) {
      // A push of ours carries the approval on, after the hand-over too: the new head needs green CI, and a review of what changed unless our push carries the earlier one.
      const own = ownPush(pf, ref, head, cur);
      const needs = needsReview(leg, pf, ref, cur)
        ? "green CI and, unless the push is a checked fix-up or a base merge that left the PR's own diff unchanged, a review of what changed"
        : "a clean pre-merge review and green CI";
      if (own) return void await move(db, p, "review", { head: cur, line: `The ${own} pushed ${short(cur)}; the approval stands, and it needs ${needs} before the PR ${p.state === "queued" ? "goes back" : "goes"} to the merge queue.` });
    }
    if (!lag) return cur === p.from_head ? cancel("head-back", `the head went back to ${short(cur)}`, { to: cur }) : cancel("author-push", `another push moved the head to ${short(cur)}`, { to: cur });
  }

  if (draft || behind) return;

  const reviewed = needsReview(leg, pf, ref, head);
  if (p.state === "review" && !reviewed) {
    return void await move(db, p, "ci", { line: `In the merge queue at ${short(head)} with no review; waiting for CI and a clean pre-merge review.` });
  }
  if (p.state === "review") {
    const r = accepted(await reviewAt(p, leg, head, pf, wake));
    if (r.kind === "stale") return;
    if (r.kind === "none") {
      // No review is coming for a PR the planner does not review (a backlog item, say).
      const f = cur === head ? await factOf() : null;
      const state = f ? decidePr(f).state : null;
      if (state && NOT_REVIEWABLE.includes(state)) return await stop(stopOf("not-reviewable", `${headName(p)} cannot be reviewed (${state})`, { state }));
      // The gate lifts every hold for a pre-approved head except a review that failed for good, which only a new request or push ends.
      const hold = cur === head ? await reviewHold(db, p.repo, p.number, head) : null;
      if (hold?.kind === "failed" && hold.until === undefined) return await stop(stopOf("review-failed", `the review of ${headName(p)} waits on ${hold.wait}`));
      return;
    }
    if (r.kind === "bad") return await stop(r.stop);
    const name = p.fix_id !== null ? "the fix-up" : headName(p);
    if (r.kind === "take") {
      return void await move(db, p, "ci", { line: r.followUps ? `The review of ${name} finds nothing that blocks the approved merge; what it found goes to a follow-up issue: waiting for CI.`
        : r.unsure ? `The review of ${name} says take but is unsure; ${approvedAhead(p)}, so it goes on: waiting for CI.` : `The review of ${name} says take; waiting for CI.` });
    }
    // The planner's fix-up of the review's fixes runs next, sure or unsure (fixupOf). Its push is our own (ownPush), so the row stays and the new head is reviewed.
    // Fixes we cannot make are the contributor's, whose push brings the workflow back; when they cannot be asked either, a person decides.
    const f = cur === head ? await factOf() : null;
    if (f?.mergeable === "CONFLICTING") return await onConflict(db, p, head, f);
    // Our implementation PR goes back to the session that wrote it instead; its push is our own as well.
    if (f && revisesNow(f)) return await noteOnce(db, p, head, "review-revise", `The review of ${name} ${r.unsure ? "is unsure and asks" : "asks"} for fixes; ${approvedAhead(p)}, so the implementation session makes them.`);
    const path = f && fixPath(f);
    if (path === "fix") return await noteOnce(db, p, head, "review-fixup", `The review of ${name} ${r.unsure ? "is unsure and asks" : "asks"} for fixes; ${approvedAhead(p)}, so the fix-up runs.`);
    if (path === "contributor") return await noteOnce(db, p, head, "review-ask", `The review of ${name} ${r.unsure ? "is unsure and asks" : "asks"} for fixes the pipeline cannot make: the merge stays approved and waits for the contributor, who is asked for them.`);
    const bucket = f ? fixupOf(f)?.bucket : undefined;
    return await stop(stopOf("fix-cannot-run", `the review of ${name} asks for fixes and its fix-up cannot run${bucket ? ` (${bucket})` : ""}`, bucket ? { bucket } : undefined));
  }

  // A leg is its person's approval while its workflow lives: the head rules above say which heads it may merge, and a blocker of the workflow ends it.
  if (!leg || !pf.workflows.has(leg.workflowId)) return p.state === "queued" ? cancel("approval-gone", "merging is no longer approved") : await stop(stopOf("approval-gone", "merging is no longer approved"));

  if (p.state === "ci") {
    // A re-review since the move to ci counts: the hand-over needs a take at this head now.
    const r: ReviewRead = !reviewed ? { kind: "take", unsure: false } : accepted(await reviewAt(p, leg, head, pf, wake));
    if (r.kind === "none" || r.kind === "stale") return void await move(db, p, "review", { line: `The review of ${headName(p)} is out of date; Opus reviews it again.` });
    if (r.kind === "takefix") return void await move(db, p, "review", { line: `The review of ${headName(p)} now asks for fixes; the pipeline's fix-up comes first.` });
    if (r.kind === "bad") return await stop(r.stop);
    const c = pf.checks.get(ref);
    // CI as the planner and the merge step judge it.
    const ci = ciAt(c, head, { optional: pf.optional(p.repo), approvedRuns: pf.merge.runs.get(`${ref}@${head}`)?.approved.length ?? 0 });
    if (ci === "unknown") return;
    // CI at this head decides nothing: nothing fixes it before the base is merged in.
    if (c!.mergeable === "CONFLICTING") return await onConflict(db, p, head, await factOf());
    if (ci === "pending") return;
    if (ci === "failure") {
      // The CI fix step works the red head as it would for any PR, and the leg goes on with its push. What it gives up on is the contributor's, whose push brings the workflow back.
      const f = await factOf();
      const path = redCiPath(f);
      if (path === "fix") return;
      if (path === "contributor") {
        const line = f && mergeOwned(f) ? `CI failed at ${headName(p)} and the CI fix posted its patch as a comment, as it cannot push to the branch: the merge stays approved and waits for the contributor to apply it.`
          : `CI failed at ${headName(p)} and the CI fix did not repair it: the merge stays approved and waits for the contributor, who is asked to fix it.`;
        return await noteOnce(db, p, head, "ci-ask", line);
      }
      return await stop(stopOf("ci-failed", redCiStopReason(f, headName(p))));
    }
    // Nothing merges without CI, so a repo that never runs any has nothing to wait for.
    if (ci === "none") {
      if (await repoHasNoCi(db, p.repo)) await stop(stopOf("no-ci", "the repo has no CI, and nothing is merged without it"));
      return;
    }
    // The pre-merge review of this head must be clean; the planner runs it (src/core/decide.ts) and retries a failed one.
    const pm = await premergeAt(db, p.repo, p.number, head);
    if (!pm || (pm.findings === null && pm.tries < PREMERGE_MAX_TRIES)) return;
    if (pm.findings === null) {
      // A person who answered after it failed for good went on without it (the word merge; a yes gave it one more try, so it waits above).
      // An answer is what moves `since` past the start: one given before the failure, or no answer at all, stops here and asks.
      const without = leg.since > leg.startedAt && pm.at <= leg.since;
      if (!without) return await stop(stopOf("premerge-failed", `the pre-merge review of ${headName(p)} failed`));
      const h = await handOver(db, p, head, pf, leg, false, "premerge-failed");
      if ("stop" in h) await stop(h.stop);
      return;
    }
    const all = findingsOf(pm);
    // On the leg of a PR approved for merge only blocking defects stop it; the others are filed as follow-ups (core/decide.ts) and it merges.
    // A defect a person dropped from the workflow's plan at this head, or at one our own pushes led here from, stops nothing: they overruled it.
    const wf = all.some((x) => x.severity === "defect") ? (await factOf())?.workflow : undefined;
    const overruled = wf?.overruled?.length ? stoppingDefects(all, !!wf.approved).length - stoppingDefects(all, !!wf.approved, wf.overruled).length : 0;
    const defects = all.some((x) => x.severity === "defect") ? stoppingDefects(all, !!wf?.approved, wf?.overruled).length : 0;
    if (defects) {
      const found = `the pre-merge review found ${defects} defect${defects === 1 ? "" : "s"}`;
      // Safe fixes get up to PREMERGE_FIX_ROUNDS fix-up rounds, whose pushes are our own; a defect that comes back or what is left after the last round is a person's.
      const f = await factOf();
      if (f && f.head !== head) return;
      const round = f && premergeFix(f);
      if (round === "fix" || round === "running") {
        // Where a person has to have the defects fixed, the failed verification is no question of its own: the fix is a head verified anew.
        const failed = verifyStop(p, head, pf, leg);
        if (failed) return await stop(failed);
        return await noteOnce(db, p, head, "premerge-fixup", `${found[0]!.toUpperCase()}${found.slice(1)}; the merge was approved, so the fix-up runs.`);
      }
      return await stop(stopOf("premerge-defect", found, { defects }));
    }
    // The merge approval says the change is wanted: an unsure pre-merge review (a claim of the description it could not verify) with
    // no defect goes on to the merge queue; only a defect, or another blocker, brings the item back.
    const h = await handOver(db, p, head, pf, leg, pm.unsure === 1, overruled ? "overruled" : null);
    if ("stop" in h) await stop(h.stop);
    return;
  }
  // queued: the merge queue owns it. A new review that asks for fixes, sure or not, of a PR approved for merge: the pipeline's fix-up runs under
  // that approval, and its push is the leg's own again. A new review that says hold or close takes it back to review, which stops for its fix
  // (src/workflow/advance.ts fixFirst). A batch that holds the PR, or a merge of the repo under way, goes first.
  if (!reviewed) return;
  const r = keptVerdict(p, head, pf) === "take" ? null : accepted(await reviewAt(p, leg, head, pf, wake));
  if (r?.kind !== "takefix" && r?.kind !== "bad") return;
  const left = await db.write(async () => !await inActiveBatch(db, p.repo, p.number) && !await mergeRunning(db, p.repo) && await moveRaw(db, p, "review", {}));
  if (left) await say(db, p.repo, p.number, r.kind === "takefix" ? `The review of ${headName(p)} now asks for fixes; the pipeline's fix-up comes first.` : `The review of ${headName(p)} now asks for changes before the merge; they are fixed first.`);
}

/** Ends fix-up requests the planner can no longer work (someone else's push moved the PR's head, it closed, the push is not possible), with the reason in the thread. Requests of a pre-approved merge end with it. */
async function endStaleRequests(db: Db, wake: Wake): Promise<void> {
  const now = Date.now();
  // A request whose maker may no longer act on the repo (a demotion, a write permission gone) is dropped before the planner can push it. One
  // whose maker's access GitHub has not answered on waits: the planner does not work it meanwhile.
  const [all, live, dropped] = await db.together(() => Promise.all([
    loadFixupRequests(db, { anyMaker: true, nowMs: now }), loadFixupRequests(db, { nowMs: now }), loadFixupRequests(db, { raced: true, nowMs: now }),
  ]));
  // Requests whose try was dropped at their head, of the work that is under way: an older one was overtaken by what a person said since.
  const started = dropped.length ? await loadWorkflowFacts(db, dropped) : null;
  const raced = dropped.filter((o) => {
    const w = started?.live.get(refOf(o.repo, o.number)) ?? started?.ofPr.get(refOf(o.repo, o.number));
    return w !== undefined && o.at >= w.since;
  });
  const makers = await standings(db, all.map((o) => ({ login: o.by, repo: o.repo })), { identity: await githubIdentity(db), now });
  const gone = all.filter((o) => o.preapproval_id === null && makers.get(permKey(o.by, o.repo)) === "no");
  const ended = new Set(await endFixupRequests(db, gone.map((o) => ({ id: o.id, reason: "the requester may no longer act here" }))));
  await sayAll(db, gone.filter((o) => ended.has(o.id)).map((o) => ({ repo: o.repo, number: o.number, text: `The queued fix-up of ${short(o.from_head)} was dropped: ${o.by} no longer may act on ${o.repo}.` })));
  const ends: { id: number; reason: string; repo: string; number: number; head: string }[] = [];
  const alone = [...live.filter((o) => o.preapproval_id === null && !ended.has(o.id)), ...raced];
  const [results, pushes, repos] = await db.together(() => Promise.all([
    loadOperatorFixResults(db, alone.map((o) => o.id)), loadOwnPushes(db, alone), loadRepos(db, { names: [...new Set(alone.map((o) => o.repo))] }),
  ]));
  for (const o of alone) {
    const f = await loadPrFact(db, o.repo, o.number);
    if (f?.refreshAt !== undefined) wake(f.refreshAt);
    // A push of ours moved the head: the request goes with it.
    if (f?.head && f.head !== o.from_head && chainsOwn(pushes.get(refOf(o.repo, o.number)) ?? [], o.from_head, f.head)) {
      await moveFixupRequests(db, [{ id: o.id, from: o.from_head, to: f.head }]);
      continue;
    }
    if (f && mirrorBehind(pushes.get(refOf(o.repo, o.number)) ?? [], f.head, repos.get(o.repo)?.synced_at ?? null)) continue;
    const tried = results.get(o.id);
    const why = !f ? "the PR is no longer open" : f.head !== o.from_head ? `the head moved to ${short(f.head)}`
      : tried?.fromHead !== o.from_head ? await whyNotPlanned(db, f) : tried.state === "superseded" ? tried.reason ?? "its try was dropped" : null;
    if (why) ends.push({ id: o.id, reason: why, repo: o.repo, number: o.number, head: o.from_head });
  }
  const done = new Set(await endFixupRequests(db, ends.map((e) => ({ id: e.id, reason: e.reason }))));
  await sayAll(db, ends.filter((e) => done.has(e.id)).map((e) => ({ repo: e.repo, number: e.number, text: `The queued fix-up of ${short(e.head)} was dropped: ${e.reason}.` })));
}

/** A cancel that came too late for a merge already past its guard: the merge row that appears at the head turns the row into merged. */
async function settleCancelled(db: Db): Promise<void> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const targets = [...new Set((await listAudit(db, { actions: ["preapproval"], since, where: { state: "cancelled" } })).flatMap((a) => (a.target ? [a.target] : [])))];
  const refs = targets.flatMap((t) => { const m = /^(.+)#(\d+)$/.exec(t); return m ? [{ repo: m[1]!, number: Number(m[2]) }] : []; });
  if (!refs.length) return;
  const [legs, merges] = await db.together(() => Promise.all([loadLegs(db, refs, { latestOnly: true }), loadMergeFacts(db, refs)]));
  for (const p of [...legs.values()].flat()) {
    if (p.state !== "cancelled" || !p.head || p.updated_at <= since) continue;
    const a = merges.attempts.get(`${refOf(p.repo, p.number)}@${p.head}`);
    if (a?.outcome === "merged" && a.at >= p.at) await move(db, p, "merged", { line: "The merge went through before the cancel took effect: the PR is merged." });
  }
}

/** Told each time at which a pass's answer changes with the clock alone. */
export type Wake = (at: number) => void;

/**
 * What advancePreapprovals reads, as change markers: the planner's input topics (the PR facts and most rows the pass reads) and `access`
 * (roles, and the audit table: the GitHub writes that follow a base merge's own-diff mark, which no other topic watches). A pass whose
 * markers are the ones it read before and whose wake time (`Wake`) has not come would move nothing.
 */
export function preapprovalInputs(seqs: Record<string, number>): string {
  return [...INPUT_TOPICS, "access", "auto-stops"].map((t) => seqs[t] ?? 0).join(",");
}

/**
 * Moves each merge leg that other steps' rows have carried to a new state; the runner tick runs it when its inputs changed
 * (preapprovalInputs) or a time `wake` was told has come. A leg of a workflow in `held` (its blockers could not be checked) stays where it is. Writes nothing when nothing moved, except the maintainers' write permissions it
 * reads again first (refreshSettlers). A failure tells `wake` the pass's own time, so the next tick runs it again.
 */
export async function advancePreapprovals(db: Db, log: (line: string) => void = () => {}, deps: RefreshDeps = {}, wake: Wake = () => {}, held: { has(workflowId: number): boolean } = new Set<number>()): Promise<number> {
  const t = Date.now();
  try {
    await refreshSettlers(db, log, deps, wake);
  } catch (e) {
    log(`preapproval permissions: ${(e as Error).message}`);
    wake(t);
  }
  try {
    await endStaleRequests(db, wake);
    await settleCancelled(db);
  } catch (e) {
    log(`preapproval requests: ${(e as Error).message}`);
    wake(t);
  }
  const pass = await loadLegPass(db);
  // A leg no workflow owns is linked to the live workflow of its PR.
  const adopt = pass.rows.flatMap((r) => { const c = pass.context.get(r.id); return r.workflow_id === null && c && typeof c !== "string" ? [{ id: r.id, workflowId: c.workflowId }] : []; });
  if (adopt.length) await adoptLegs(db, adopt);
  if (!pass.rows.length) return 0;
  const pf = await loadPassFacts(db, pass);
  // The facts of the legs' PRs, loaded together when a leg first needs its PR's, with the settings read once for the load as in a planner pass.
  let facts: Map<string, PrFacts> | null = null;
  const failed = new Set<number>();
  const refs = pass.rows.map((r) => refOf(r.repo, r.number));
  for (const p of pass.rows) {
    const c = pass.context.get(p.id);
    if (c && typeof c !== "string" && held.has(c.workflowId)) continue;
    const factOf = async (): Promise<PrFacts | null> => {
      if (!facts) {
        const loaded = await withConfig(db, () => loadPrFacts(db, { refs }));
        for (const f of loaded) if (f.refreshAt !== undefined) wake(f.refreshAt);
        facts = new Map(loaded.map((f) => [refOf(f.repo, f.number), f]));
      }
      return facts.get(refOf(p.repo, p.number)) ?? null;
    };
    try {
      await advance(db, p, c ?? "unlinked", pf, factOf, wake);
    } catch (e) {
      failed.add(p.id);
      wake(t);
      const msg = oneLine(String((e as Error).message ?? e), 300);
      const ref = refOf(p.repo, p.number);
      log(`preapproval ${ref}: ${msg}`);
      // Runs every tick: the item's trace gets the error once, not once per tick.
      try {
        const last = ((await loadAuditActions(db, [ref], ["preapproval-error"])).get(ref) ?? []).reduce<{ rowid: number; details: Record<string, unknown> | null } | null>((a, b) => (!a || b.rowid > a.rowid ? b : a), null);
        if (!last || last.details?.error !== msg) await addAudit(db, [{ login: ACTOR, action: "preapproval-error", target: ref, details: { id: p.id, state: p.state, error: msg } }]);
      } catch { /* the log line above stands */ }
    }
  }
  const now = new Map([...(await loadLegs(db, pass.rows.map(({ repo, number }) => ({ repo, number })), { ids: pass.rows.map((p) => p.id) })).values()].flat().map((p) => [p.id, p.state]));
  return pass.rows.filter((p) => !failed.has(p.id) && now.get(p.id) !== p.state).length;
}

export const mergeRunning = async (db: Db, repo: string): Promise<boolean> => (await isRunning(db, [{ step: "merge", repo }])).size > 0;
export const inActiveBatch = async (db: Db, repo: string, n: number): Promise<boolean> => (await loadBatchMembership(db, [{ repo, number: n }])).has(refOf(repo, n));

/**
 * A person cancels the PR's pre-approved merge before the merge queue has merged it. A queued PR in an integration batch is first
 * removed from the batch (the batch PR is closed) unless the merge is running.
 * Throws when there is none or the queue is past stopping it.
 */
export async function cancelPreapproval(db: Db, by: string, repo: string, n: number, run?: Exec, via?: string): Promise<Preapproval> {
  const p = (await loadLegs(db, [{ repo, number: n }], { activeOnly: true })).get(refOf(repo, n))?.at(-1);
  if (!p) throw new Error(`${repo}#${n} has no pre-approved merge in progress`);
  const finish = async () => {
    if (!await cancelRow(db, p, by, stopOf("person", `cancelled by ${by}`), `${by} cancelled the pre-approved merge.`, true, via)) throw new Error("the pre-approved merge changed a moment ago");
  };
  if (p.state === "queued" && await inActiveBatch(db, repo, n)) {
    if (await mergeRunning(db, repo)) throw new Error("a merge of the repo is running: it may be merging this PR");
    const r = await removeFromBatch(db, by, repo, n, run);
    const id = await loadBatchByBranch(db, repo, r.batch);
    if (id !== undefined && (await getBatch(db, id))?.state === "merged") throw new Error("the PR is already merged: its batch merged");
    // A merge run that took the PR into a new batch meanwhile makes this throw (pastCancel): the cancel is asked for again.
    await finish();
  } else await finish();
  return (await preapprovalOf(db, repo, n))!;
}
