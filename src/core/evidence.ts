// What the rows say about a head of a pull request, one rule per question: the planner, the workflow pass, the merge legs and the merge
// itself ask here. Pure.
import type { PushEdge } from "../data/changes/types.ts";
import type { LandedWhy } from "./plan.ts";

/** A push of ours that moved a PR's head: the head it was made on and its commit. */
export type OwnPush = { from: string; to: string };

/** What a push of ours was. */
export type PushWhat = "fix-up" | "CI fix" | "base merge" | "implementation session's revision" | "autorepin";
/**
 * A recorded push. `lines`: the changed lines of the push; null when they were not recorded. `landed`: git reported the push
 * done, so the branch had its commit; one a crash came before landed as well when a head shows its commit. `small`: it changed
 * nothing of the PR that a model wrote (a base merge that left the PR's own diff the same, an autorepin), so it owes no review.
 */
export type RecordedPush = OwnPush & { what: PushWhat; at: string; lines: number | null; landed: boolean; small: boolean };

/** A row of `push_outcomes` that names the head it was made on. */
export type OutcomePush = OwnPush & { action: string; at: string };
/** A row of `own_pushes`: a push recorded right before it was made. */
export type MadePush = OwnPush & { action: string; at: string; lines: number | null; landed: boolean };
/** The commit of an autorepin (src/repin) and the head it was made on. */
export type RepinPush = OwnPush & { at: string };

const WHAT: Record<PushEdge["kind"], PushWhat> = { fixup: "fix-up", cifix: "CI fix", conflict: "base merge" };
const ACTION: Record<string, PushWhat> = { "fixup-push": "fix-up", "cifix-push": "CI fix", "conflict-push": "base merge", "implement-push": "implementation session's revision", "autorepin-push": "autorepin" };

/**
 * Every push AutoCraft made to one PR: the fix-ups of any source, CI fixes, base merges, revisions of its implementations and autorepins.
 * `made` has each one, recorded before the push; the patch rows say what a merge did to the PR's diff. Pushes older than `made` are in their
 * patch rows, the push outcomes and the autorepins' rows alone. A commit that never landed is no PR's head, so its row leads nowhere.
 */
export function ownPushes(made: readonly MadePush[], edges: readonly PushEdge[], outcomes: readonly OutcomePush[], repins: readonly RepinPush[]): RecordedPush[] {
  const out = new Map<string, RecordedPush>();
  const key = (p: OwnPush): string => `${p.from} ${p.to}`;
  for (const e of edges) {
    const was = out.get(key(e));
    const small = e.kind === "conflict" && e.state === "merged" && e.ownDiff === "same";
    if (!was || small) out.set(key(e), { from: e.from, to: e.to, what: WHAT[e.kind], at: e.at, lines: null, landed: false, small });
  }
  for (const o of outcomes) {
    const was = out.get(key(o));
    if (was) { was.landed = true; if (o.at > was.at) was.at = o.at; } else out.set(key(o), { from: o.from, to: o.to, what: ACTION[o.action] ?? "fix-up", at: o.at, lines: null, landed: true, small: false });
  }
  for (const r of repins) if (!out.has(key(r))) out.set(key(r), { from: r.from, to: r.to, what: "autorepin", at: r.at, lines: null, landed: false, small: true });
  for (const m of made) {
    const was = out.get(key(m));
    // A patch row is as old as the patch, this one as the push.
    if (was) { was.lines = m.lines; was.landed ||= m.landed; if (m.at > was.at) was.at = m.at; } else out.set(key(m), { from: m.from, to: m.to, what: ACTION[m.action] ?? "fix-up", at: m.at, lines: m.lines, landed: m.landed, small: m.action === "autorepin-push" });
  }
  return [...out.values()];
}

/**
 * Whether a push is ours: `head` is `base`, or is reached from it through our own pushes alone, step by step. A head whose parent is not
 * recorded, or whose chain passes through a commit we did not push, is not: someone else's commits are under it.
 */
export const chainsOwn = (pushes: readonly OwnPush[], base: string, head: string): boolean => ownHeads(pushes, head).has(base);

/** The head and the heads our own pushes alone moved it from. */
function ownHeads(pushes: readonly OwnPush[], head: string): Set<string> {
  const reached = new Set([head]);
  for (const h of reached) for (const p of pushes) if (p.to === h) reached.add(p.from);
  return reached;
}

/** Our pushes that lead to `head`, made after `since` (up to when a person has seen the PR and chose to go on with it), newest first. */
export function pushesSince(pushes: readonly RecordedPush[], head: string, since: string): RecordedPush[] {
  const out: RecordedPush[] = [], reached = new Set([head]);
  for (const h of reached) for (const p of pushes) if (p.to === h && p.from !== h && p.at > since) { out.push(p); reached.add(p.from); }
  return out;
}

/** The head the person chose to go on with: `head` without our pushes since. */
export const approvedHead = (pushes: readonly RecordedPush[], head: string, since: string): string => pushesSince(pushes, head, since).at(-1)?.from ?? head;

/**
 * Our pushes after `since` that changed more than a checked merge does and that the head holds (`reached`: its ownHeads): the ones it was
 * reached through, and those under someone else's commits. One that never landed, or is gone from the branch again, is not.
 */
const codePushes = (pushes: readonly RecordedPush[], reached: ReadonlySet<string>, since: string): RecordedPush[] =>
  pushes.filter((p) => !p.small && p.from !== p.to && p.at > since && (reached.has(p.to) || (p.landed && !reached.has(p.from))));

/** Up to when a person accepted a PR's code: an approval that answers no question (made after they last started or answered it, `said`) accepts what was pushed before it, else what they had seen (`since`). */
export const agreedAt = (w: { approvedAt: string | null; since: string; said: string }): string => (w.approvedAt !== null && w.approvedAt > w.said ? w.approvedAt : w.since);

/** A started PR as its person last left it. `since`: up to when they have seen it. `reviewAskedAt`: they asked for a model review newer than this of a PR that merges without one. */
export type GoneOnPr = { entry: string; startedAt: string; since: string; reviewAskedAt: string | null };
/** A head a model reviewed, and when. */
export type HeadReview = { head: string; at: string };

/**
 * The review a started PR's head merges after, null when it needs none; `from`: only one made after this counts (null: any). Every entry
 * needs one but the merge entry, which needs:
 * - the one a person asked for;
 * - one at every push of ours since its start that changed more than a checked merge does, or at a later head of ours. No answer ends that.
 *   A push under someone else's commits (its chain to the head is cut) needs one at what followed them;
 * - then what such a review says, until the person has been asked about it.
 */
export function neededReview(w: GoneOnPr, pushes: readonly RecordedPush[], head: string, reviews: readonly HeadReview[]): { from: string | null } | null {
  if (w.entry !== "merge") return { from: null };
  const reached = ownHeads(pushes, head);
  const made = reviews.filter((r) => reached.has(r.head));
  let from = w.since, owed = false, reviewed = w.reviewAskedAt !== null || w.since > w.startedAt;
  const owe = (at: string): void => { owed = true; if (at > from) from = at; };
  if (w.reviewAskedAt !== null && !made.some((r) => r.at > w.reviewAskedAt!)) owe(w.reviewAskedAt);
  for (const p of codePushes(pushes, reached, w.startedAt)) {
    const on = reached.has(p.to);
    reviewed = true;
    // A head on the push was reviewed after it, whatever the times say; one that followed someone else's commits goes by them.
    if (!made.some((r) => (on ? chainsOwn(pushes, p.to, r.head) : r.at > p.at))) owe(on ? w.since : p.at);
  }
  return owed || (reviewed && made.some((r) => r.at > w.since)) ? { from } : null;
}

// ---- the review after a merge

/** A person's approval of a merge. `since`: up to when they accepted the PR's code (agreedAt). `prOpenedAt`: an implementation's PR, when it was opened. */
export type LandedApproval = { approvedAt: string; since: string; prOpenedAt: string | null };

/** Why the merge of `head` gets a review of what it landed; null when it merged as a person approved it. */
export function landedWhy(m: { head: string; approval: LandedApproval | null; pushes: readonly RecordedPush[] }): LandedWhy | null {
  const a = m.approval;
  if (!a) return "rule";
  if (a.prOpenedAt !== null && Date.parse(a.prOpenedAt) > Date.parse(a.approvedAt)) return "implementation";
  return codePushes(m.pushes, ownHeads(m.pushes, m.head), a.since).length ? "push" : null;
}

// ---- CI

export type CiState = "success" | "failure" | "pending" | "none" | "unknown";
type CheckLike = { name: string; state: string };

/**
 * The CI state merging acts on: the repo's optional checks read as if they had not run, failed or still running
 * (success when nothing else is pending or failing and some other check succeeded). The stored `overall` and
 * `checks` stay as GitHub reported them.
 */
function effectiveOverall(overall: string, checks: CheckLike[], optional: readonly string[]): string {
  if ((overall !== "failure" && overall !== "pending") || !optional.length) return overall;
  const opt = checks.filter((c) => optional.includes(c.name));
  if (!opt.some((c) => c.state === overall)) return overall;
  const rest = checks.filter((c) => !optional.includes(c.name)).map((c) => c.state);
  if (rest.includes("failure")) return "failure";
  if (rest.includes("pending")) return "pending";
  return rest.includes("success") ? "success" : overall === "pending" ? "pending" : "none";
}

/** effectiveOverall with the repo's optional list and the PR's stored checks (JSON text or parsed). */
function effectiveCiWith(optional: readonly string[], overall: string, checks: string | CheckLike[] | null | undefined): string {
  if (overall !== "failure" && overall !== "pending") return overall;
  let list: CheckLike[] = [];
  try { list = typeof checks === "string" ? (JSON.parse(checks) as CheckLike[]) : checks ?? []; } catch { /* unreadable: stays as reported */ }
  return effectiveOverall(overall, list, optional);
}

/**
 * CI at `head` from the stored checks of the PR: "unknown" when they describe another head or none were read, "pending" while workflow
 * runs we approved there have not finished (`approvedRuns`), else what the checks say without the repo's optional ones.
 */
export function ciAt(
  c: { head_oid: string | null; overall: string | null; checks: string | CheckLike[] | null } | null | undefined, head: string, o: { optional: readonly string[]; approvedRuns?: number },
): CiState {
  if (!c || c.head_oid !== head) return "unknown";
  if (o.approvedRuns) return "pending";
  return effectiveCiWith(o.optional, c.overall ?? "none", c.checks) as CiState;
}

// ---- the heads a person accepted

/**
 * The heads of the workflow's PR that a person accepted (our own pushes on top of them are accepted too, `isAccepted`). A PR's is its base head,
 * which every release writes. An issue's is the accepted head of its implementation PR; a row without one says it with the base head and the
 * heads its merge legs (`legs`: the workflow's, of any state) started from and were at.
 */
export function acceptedHeads(
  w: { kind: "pr" | "issue"; baseHead: string | null; acceptedHead: string | null }, legs: readonly { from_head: string | null; head: string | null }[],
): string[] {
  const heads = w.kind === "pr" ? [w.baseHead ?? w.acceptedHead] : w.acceptedHead !== null ? [w.acceptedHead] : [w.baseHead, ...legs.flatMap((l) => [l.from_head, l.head])];
  return heads.filter((h) => h !== null);
}

/**
 * The head a person accepted when someone else's commits lead from it to `head`, on a PR approved for merge: the author's new commits,
 * which Opus reviews before the merge goes on (the review round, src/workflow/advance.ts). Null when the head is the accepted one or our own pushes on top of it.
 */
export function authorRound(w: { approved: boolean; baseHead: string | null } | null | undefined, pushes: readonly OwnPush[], head: string | null): string | null {
  if (!w?.approved || w.baseHead == null || head === null || chainsOwn(pushes, w.baseHead, head)) return null;
  return w.baseHead;
}

/** Whether `head` is one of `heads` or our own pushes on top of one. */
export const isAccepted = (heads: readonly string[], pushes: readonly OwnPush[], head: string): boolean => heads.some((h) => chainsOwn(pushes, h, head));

// ---- the files a fix-up of ours was asked to change

/** Lockfiles a fix-up may touch as a side effect of its change: never beyond what was agreed. */
export const LOCKFILE = /(^|\/)(Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/;

/** The files a fix-up changed that no planned file names; lockfiles never count. */
export const beyondPlanned = (files: readonly string[], planned: readonly string[]): string[] => files.filter((f) => !LOCKFILE.test(f) && !planned.includes(f));

/** The first line of a fix-up request that names parts of the plan and nothing else (src/workflow/effects.ts fixInstructions). */
export const PARTS_ONLY = "Fix these findings of the review, and nothing else:";
/** A part's line in a fix-up request. A title that ends in parentheses and names no file gets empty ones, so its own are not read as a file. */
export const partLine = (p: { n: number; title: string; file?: string | null }): string => `${p.n}. ${p.title}${p.file ? ` (${p.file})` : p.title.endsWith(")") ? " ()" : ""}`;

/**
 * The parts a fix-up request names, when it names parts of the plan and nothing else: their titles and files. Null for a request with a
 * person's own words or a review's finding in it, which may ask for anything.
 */
export function askedParts(instructions: string): { title: string; file: string | null }[] | null {
  const [first, ...lines] = instructions.split("\n");
  if (first !== PARTS_ONLY || !lines.length) return null;
  const out: { title: string; file: string | null }[] = [];
  for (const l of lines) {
    const m = /^\d+\. (.+?)(?: \(([^()]*)\))?$/.exec(l);
    if (!m) return null;
    out.push({ title: m[1]!, file: m[2] || null });
  }
  return out;
}

// ---- the pre-merge review of a PR approved for merge

/**
 * A head's review as the pre-merge rule reads it. `counts`: the review read code that makes a new pre-merge review due (premergeSource):
 * a delta review, or a full one made after a review of an earlier head, unless all that lies between is pushes of ours that owe none.
 */
export type ChainReview = { mode: "full" | "delta" | "carried"; base: string | null; counts: boolean };

/**
 * Where the pre-merge review of `head`, on a PR a person approved for merge, comes from. Null: a model reads the head. Otherwise the head
 * owes none, and its row is carried from `from`, the nearest earlier head with a pre-merge review; `from` null: nothing since the full
 * review owes one, and the row is clean.
 *
 * The approval's full review is the one full reading. A head owes a pre-merge review only when, since that review or the last pre-merge
 * review on its chain, some head got a review that `counts` (the author's commits, a base merge that changed the PR's own diff, an
 * operator's fix-up of files beyond its parts). A chain of carried heads, or of delta reviews that do not count (a CI fix of ours), owes
 * none. A head with no review the chain can be followed through owes one.
 */
export function premergeSource(head: string, reviews: ReadonlyMap<string, ChainReview>, premerged: ReadonlySet<string>): { from: string | null } | null {
  let h = head;
  for (let i = 0; i < 50; i++) {
    if (h !== head && premerged.has(h)) return { from: h };
    const r = reviews.get(h);
    if (!r || (r.mode !== "carried" && r.counts)) return null;
    if (r.mode === "full") return { from: null };
    if (r.base === null) return null;
    h = r.base;
  }
  return null;
}
