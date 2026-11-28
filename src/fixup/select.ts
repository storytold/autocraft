// The PRs the fix-up and conflict steps work on: those whose Plan holds a `fixup` or `conflict` action.
import { ownLane, planned } from "../core/select.ts";
import { mayRun } from "../core/authority.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import type { PrFacts } from "../core/plan.ts";
import type { PlanSet } from "../core/plan-set.ts";
import { findingsOf, premergeAt } from "../premerge/store.ts";
import { defectFix, stoppingDefects } from "../premerge/types.ts";
import { type Fix, type FixCandidate, type FixSelection, parseFixes } from "./candidates.ts";
import { loadPatchFacts, loadStoredPatches, type PatchFacts, type StoredPatch } from "../data/changes/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadReviewsAt } from "../data/review/index.ts";
import { triesIn, type ConflictCandidate, type ConflictRow } from "./conflict-state.ts";
import { queuedOperatorFix } from "../preapproval/state.ts";
import type { Db } from "../db/index.ts";
import { fixesToMake } from "../core/review-blocking.ts";

type Planned = Awaited<ReturnType<typeof planned>>;
type FixReads = {
  titles: Map<string, string>;
  conflictRows: Map<string, ConflictRow[]>;
  reviews: Map<string, { fixes: string | null; model: string | null }>;
  stored: StoredPatch[];
};

const refsOf = (...lists: Planned[]) => lists.flatMap((l) => l.map((p) => ({ repo: p.facts.repo, number: p.facts.number })));
const headsOf = (l: Planned) => l.map((p) => ({ repo: p.facts.repo, number: p.facts.number, head: p.action.head! }));

/**
 * The reads of selectFixups for the given candidates in one wave: conflict titles and merge rows, the take-fix reviews at the
 * fix-up heads, and the stored patches whose lint task ended. Keyed by `repo#number` (reviews by `repo#number@head`).
 */
async function fixReads(db: Db, conflicts: Planned, fixups: Planned, lintFixups: Planned, lintConflicts: Planned): Promise<FixReads> {
  const titleRefs = refsOf(conflicts, lintConflicts), lintRefs = refsOf(lintFixups, lintConflicts);
  const [items, facts, atHeads, stored] = await db.together(() => Promise.all([
    titleRefs.length ? loadItems(db, titleRefs, "card") : new Map<string, { title: string }>(),
    conflicts.length ? loadPatchFacts(db, refsOf(conflicts)) : new Map<string, PatchFacts>(),
    loadReviewsAt(db, [...headsOf(fixups), ...headsOf(lintFixups)]),
    lintRefs.length ? loadStoredPatches(db, lintRefs, ["fixup", "conflict"]) : [] as StoredPatch[],
  ]));
  const titles = new Map([...items].map(([k, r]) => [k, r.title ?? ""]));
  const conflictRows = new Map([...facts].map(([k, f]) => [k, f.conflicts]));
  const reviews = new Map<string, { fixes: string | null; model: string | null }>();
  for (const [k, r] of atHeads) if (r.verdict === "take-fix") reviews.set(k, { fixes: JSON.stringify(r.fixes), model: r.model });
  return { titles, conflictRows, reviews, stored };
}

/** fixReads for every repo's candidates of a planner pass's Plans, read on first use and kept with them. */
const passFixReads = new WeakMap<PlanSet, Promise<FixReads>>();
function passReads(db: Db, plans: PlanSet, run: string | null | undefined): Promise<FixReads> {
  let r = passFixReads.get(plans);
  if (!r) {
    const o = { ...(run !== undefined ? { run } : {}), plans, refused: true };
    passFixReads.set(plans, (r = (async () => await fixReads(db, await planned(db, "conflict", o), await planned(db, "fixup", o), await planned(db, "lint", { ...o, bucket: "fixup" }), await planned(db, "lint", { ...o, bucket: "conflict" })))()));
    void r.catch(() => { if (passFixReads.get(plans) === r) passFixReads.delete(plans); });
  }
  return r;
}

/** Why the PR's conflict is resolved, for the models: its review's reason, or the approval that stands in for one. */
const wantedFor = (f: PrFacts): string => f.review?.reason ?? "a maintainer approved the merge; it has no review";

/** A review's fixes that nobody dropped from the PR's workflow; on a PR approved for merge only the blocking ones. */
const reviewFixes = (f: PrFacts, stored: string | null | undefined): Fix[] => fixesToMake(parseFixes(stored ?? null), f.workflow?.dropped, !!f.workflow?.approved);

/** The selection cut to one PR (`number`), stored patches still all listed; the whole selection without `number`. */
export function onlyPr(sel: FixSelection, number: number | undefined): FixSelection {
  if (number === undefined) return sel;
  const one = <T extends { number: number }>(l: T[]): T[] => l.filter((c) => c.number === number);
  return { ...sel, fix: one(sel.fix), cannotPush: one(sel.cannotPush), ask: one(sel.ask), lint: one(sel.lint), conflictMerge: one(sel.conflictMerge), conflictAsk: one(sel.conflictAsk) };
}

/** The work that may run for `by` (mayRun); `approved`: only the PRs approved for merge, or only the others (the step's two jobs). */
export async function selectFixups(db: Db, repo: string, run?: string | null, plans?: PlanSet, by: By = CLI_BY, approved?: boolean): Promise<FixSelection> {
  const opts = { repo, by, ...(run !== undefined ? { run } : {}), ...(plans ? { plans } : {}) };
  const out: FixSelection = { fix: [], cannotPush: [], ask: [], lint: [], listed: [], conflictListed: [], conflictMerge: [], conflictAsk: [] };
  const conflicts = await planned(db, "conflict", opts), fixups = await planned(db, "fixup", opts);
  const lintFixups = await planned(db, "lint", { ...opts, bucket: "fixup", refused: true }), lintConflicts = await planned(db, "lint", { ...opts, bucket: "conflict", refused: true });
  // Read once for the repo, or with a planner pass's Plans once for every repo of the pass.
  const reads = plans ? await passReads(db, plans, run) : await fixReads(db, conflicts, fixups, lintFixups, lintConflicts);
  const titleOf = (n: number) => (reads.titles.get(`${repo}#${n}`) ?? "").slice(0, 300);
  for (const { facts: f, action } of conflicts) {
    const c: ConflictCandidate = {
      repo, number: f.number, head: action.head!, base: f.conflict!.base, title: titleOf(f.number),
      reason: wantedFor(f), attempt: triesIn(reads.conflictRows.get(`${repo}#${f.number}`) ?? [], action.head!) + 1, pushable: f.pushable,
    };
    (action.params?.bucket === "merge" ? out.conflictMerge : out.conflictAsk).push(c);
  }
  const fix: FixCandidate[] = [];
  for (const { facts: f, action } of fixups) {
    const head = action.head!, bucket = action.params?.bucket;
    if (action.params?.source === "operator") {
      const o = await queuedOperatorFix(db, repo, f.number, head);
      if (o) fix.push({ repo, number: f.number, head, reason: "an operator's instructions", fixes: [], attempt: (f.operator?.fix?.attempts ?? 0) + 1, model: null, source: "operator", operator: { id: o.id, instructions: o.instructions } });
    } else if (action.params?.source === "premerge") {
      // Only a branch we can push to gets a pre-merge round; otherwise the step leaves it alone.
      if (!f.pushable) continue;
      const row = await premergeAt(db, repo, f.number, head);
      const defects = stoppingDefects(findingsOf(row), !!f.workflow?.approved, f.workflow?.overruled);
      fix.push({ repo, number: f.number, head, reason: "pre-merge review", fixes: parseFixes(JSON.stringify(defects.map(defectFix))), attempt: 1, model: row?.model ?? null, source: "premerge" });
    } else {
      const r = reads.reviews.get(`${repo}#${f.number}@${head}`);
      const c: FixCandidate = { repo, number: f.number, head, reason: f.review!.reason, fixes: reviewFixes(f, r?.fixes), attempt: f.fixup!.attempts + 1, model: r?.model ?? null };
      if (bucket === "ask") out.ask.push(c);
      else if (bucket === "cannot-push") out.cannotPush.push(c);
      else if (bucket === "fix") fix.push(c);
    }
  }
  // Stored patches (review, pre-merge and operator sources) whose lint task ended.
  const seenLint = new Set<string>();
  for (const { facts: f, action } of lintFixups) {
    const may = mayRun({ facts: f, action }, by).ok;
    const list = (c: FixCandidate) => { out.listed.push(c.lint!.rowid); if (may) out.lint.push(c); };
    const head = action.head!, source = String(action.params?.source ?? "review");
    // Several lint actions of one PR (one per stored row) would otherwise list every row of the key again.
    const key = `${f.number} ${head} ${source}`;
    if (seenLint.has(key)) continue;
    seenLint.add(key);
    for (const w of reads.stored) {
      if (w.kind !== "fixup" || w.repo !== repo || w.number !== f.number || w.head !== head || w.source !== source) continue;
      const lint = { rowid: w.id, round: w.lintRound, task: w.lintTask, state: w.lintState, patch: w.patch, session: w.session, sessionTurn: w.sessionTurn, changes: w.changes };
      if (source === "operator") {
        const o = await queuedOperatorFix(db, repo, f.number, head);
        if (o && w.operatorFix === o.id) list({ repo, number: f.number, head, reason: "an operator's instructions", fixes: [], attempt: w.attempt, model: null, source: "operator", operator: { id: o.id, instructions: o.instructions }, lint });
      } else if (source === "premerge") {
        const pm = await premergeAt(db, repo, f.number, head);
        const defects = stoppingDefects(findingsOf(pm), !!f.workflow?.approved, f.workflow?.overruled);
        list({ repo, number: f.number, head, reason: "pre-merge review", fixes: parseFixes(JSON.stringify(defects.map(defectFix))), attempt: w.attempt, model: pm?.model ?? null, source: "premerge", lint });
      } else {
        const r = reads.reviews.get(`${repo}#${f.number}@${head}`);
        if (f.review) list({ repo, number: f.number, head, reason: f.review.reason, fixes: reviewFixes(f, r?.fixes), attempt: w.attempt, model: r?.model ?? null, lint });
      }
    }
  }
  // Stored conflict resolutions whose lint task ended: collected by the conflict step.
  for (const { facts: f, action } of lintConflicts) {
    const head = action.head!;
    const may = mayRun({ facts: f, action }, by).ok;
    for (const w of reads.stored) {
      if (w.kind !== "conflict" || w.repo !== repo || w.number !== f.number || w.head !== head || !w.baseSha) continue;
      out.conflictListed.push(w.id);
      if (!may) continue;
      out.conflictMerge.unshift({
        repo, number: f.number, head, base: f.conflict!.base, title: titleOf(f.number),
        reason: wantedFor(f), attempt: w.attempt, pushable: f.pushable,
        lint: { rowid: w.id, round: w.lintRound, task: w.lintTask, baseSha: w.baseSha, resolved: w.patch, files: w.files, session: w.session, sessionTurn: w.sessionTurn },
      });
    }
  }
  out.fix.push(...fix);
  if (approved === undefined) return out;
  // Every stored patch stays listed, so neither job drops the other one's.
  const lane = new Set([...conflicts, ...fixups, ...lintFixups, ...lintConflicts].filter((p) => ownLane(p.facts) === approved).map((p) => p.facts.number));
  const mine = <T extends { number: number }>(l: T[]): T[] => l.filter((c) => lane.has(c.number));
  return { ...out, fix: mine(out.fix), cannotPush: mine(out.cannotPush), ask: mine(out.ask), lint: mine(out.lint), conflictMerge: mine(out.conflictMerge), conflictAsk: mine(out.conflictAsk) };
}
