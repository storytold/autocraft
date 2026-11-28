// Pure functions over loaded patch facts; no handle. Rows arrive ordered by id; each helper applies the order its caller had before.
import { PREMERGE_FIX_ROUNDS, CIFIX_ASK_REASON, CIFIX_NO_LOG_REASON, CIFIX_PUSH_STATES, CIFIX_TRY_STATES, CIFIX_UNREAD_DELAYS_MS, CONFLICT_MAX_MERGES_PER_PR_PER_DAY, unsentAsk } from "../../core/rules.ts";
import type {
  CifixFacts, CifixRow, ConflictBucket, ConflictRow, FixupAtHead, FixupRow, LintFactOf, MadeBy, OutcomeRow, PatchFacts, PatchKind, PushEdge, TaskStates, UnsentAsk,
} from "./types.ts";

/** Fix-up states that count as a try; a row left in `pushing` by a crash counts too. */
const FIXUP_TRY_STATES = ["pushing", "pushed", "failed", "refused", "rejected"];
/** Refusal reasons a wrong hunk header line count alone produces; recounting removes them, so such rows are not tries. */
const FORMAT_REASONS = ["hunk longer than its header", "truncated hunk"];
/** Merge tries per head (pushed, failed, refused or rejected) before the PR is left to a person. */
export const MAX_CONFLICT_TRIES = 2;
const CONFLICT_TRY_STATES = ["pushing", "merged", "failed", "refused", "rejected"];
/** Fix-up states whose rows are the recorded outcome at a head. */
const FIXUP_RECORDED_STATES = ["pushed", "cannot-push", "too-large", "asked", "comment-failed", "push-denied", "linting", "comment-unsent"];
/** Fix-up states that hold a head without a try. */
const FIXUP_HOLD_STATES = ["too-large", "cannot-push", "push-denied"];
/** Fix-up and CI fix states of a try that failed. */
const FAILED_TRY = ["failed", "refused", "rejected", "cannot-push", "push-denied"];
const TASK_ENDED = ["done", "failed", "cancelled", "lost"];

const byCreated = <T extends { createdAt: string; id: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
const byId = <T extends { id: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => a.id - b.id);
const unsentOf = (ats: string[], now: number): { unsent?: UnsentAsk } => { const u = unsentAsk(ats, now); return u === null ? {} : { unsent: u }; };
const taskEnded = (tasks: TaskStates, id: number | null): boolean => { const t = id === null ? undefined : tasks.get(id); return !t || TASK_ENDED.includes(t.state); };

/** Review fix-up tries (source null, try states, minus hunk-header refusals; the reason match ignores ASCII case), made after `since` when given. */
export function attemptsIn(rows: readonly FixupRow[], since?: string): number {
  return rows.filter((r) => r.source === null && FIXUP_TRY_STATES.includes(r.state) && (since === undefined || r.createdAt > since)
    && !(r.state === "refused" && FORMAT_REASONS.some((f) => (r.reason ?? "").toLowerCase().startsWith(f)))).length;
}
/** `source = 'operator'` rows in try states, after `since` when given (on a PR approved for merge: since its person last went on with it). */
export function operatorTriesIn(rows: readonly FixupRow[], since?: string): number {
  return rows.filter((r) => r.source === "operator" && FIXUP_TRY_STATES.includes(r.state) && (since === undefined || r.createdAt > since)).length;
}
/** Pre-merge fix rounds the PR has had (rows with source premerge, pushed or not). */
export function premergeFixRoundsIn(rows: readonly FixupRow[]): number {
  return rows.filter((r) => r.source === "premerge" && r.state !== "linting" && r.state !== "superseded").length;
}
/** The pre-merge fix rounds are used up: the limit is reached, or a defect came back (`stalled`). */
export function premergeFixUsedIn(rows: readonly FixupRow[], stalled = false): boolean {
  return stalled || premergeFixRoundsIn(rows) >= PREMERGE_FIX_ROUNDS;
}
/** The pre-merge review at `head`, which our own pre-merge fix-up pushed, reports a defect (same file and title) of the review that fix-up answered: the fix did not take. */
export function premergeStalledIn(rows: readonly FixupRow[], head: string, defectsAt: (head: string) => readonly { file: string; title: string }[] | null): boolean {
  const now = defectsAt(head);
  if (!now?.length) return false;
  return rows.some((r) => {
    if (r.source !== "premerge" || r.toHead !== head || (r.state !== "pushed" && r.state !== "pushing")) return false;
    const before = defectsAt(r.fromHead);
    return !!before && now.some((d) => before.some((b) => b.file === d.file && b.title === d.title));
  });
}
/** The pre-merge fix round made on `head` is being pushed, or was pushed off it (`pushedOff`: the mirror does not show our push yet). */
export function premergeFixRunningIn(rows: readonly FixupRow[], head: string, pushedOff: boolean): boolean {
  return rows.some((r) => r.source === "premerge" && r.fromHead === head && (r.state === "pushing" || (r.state === "pushed" && pushedOff)));
}

/** Conflict merge tries at a head. */
export function triesIn(rows: readonly ConflictRow[], head: string): number {
  return rows.filter((r) => r.fromHead === head && CONFLICT_TRY_STATES.includes(r.state)).length;
}
/** Conflict merges pushed (or pushing) since the start of the UTC day of `now`, over all the PR's heads. */
export function mergesToday(rows: readonly ConflictRow[], now: number): number {
  const day = new Date(now).toISOString().slice(0, 10);
  return rows.filter((r) => (r.state === "merged" || r.state === "pushing") && r.createdAt >= day).length;
}
const unsentConflictAsk = (rows: readonly ConflictRow[], head: string, now: number) =>
  unsentAsk(rows.filter((r) => r.fromHead === head && r.state === "comment-unsent").map((r) => r.createdAt), now);
/** When an ask-retry bucket's comment is due again (ms), or undefined. */
export function conflictAskRetryAtOf(rows: readonly ConflictRow[], head: string, now: number): number | undefined {
  const u = unsentConflictAsk(rows, head, now);
  return u !== null && u !== "final" ? u.until : undefined;
}
/** The conflict-merge bucket of a PR at `p.head` from its rows. `p.uncapped`: a PR approved for merge or a merge-queue entry has no daily cap on base merges. `p.gone`: a merge pushed from that head is off the branch again (the PR is back at the head, or never left it), so it is due again. */
export function conflictBucketOf(rows: readonly ConflictRow[], p: { head: string; pushable: boolean; gone?: boolean; uncapped?: boolean }, approvals: { push: boolean; comment: boolean }, now: number): ConflictBucket {
  const here = new Set(rows.filter((r) => r.fromHead === p.head).map((r) => r.state));
  if (here.has("merged") && !p.gone) return "done";
  // Nothing more a merge can do at this head: the contributor is asked once (a comment needs approval). A comment that failed is
  // final too (GitHub may have posted it); one that never reached GitHub is asked again after a backoff and is final after the last.
  const stuck = (): ConflictBucket => {
    if (here.has("asked")) return "asked";
    const unsent = unsentConflictAsk(rows, p.head, now);
    if (here.has("comment-failed") || unsent === "final" || !approvals.comment) return "held";
    return unsent ? "ask-retry" : "ask";
  };
  if (here.has("skipped") || here.has("push-denied")) return stuck();
  if (here.has("linting")) return "linting";
  if (!p.pushable || here.has("cannot-push")) return stuck();
  if (triesIn(rows, p.head) >= MAX_CONFLICT_TRIES) return stuck();
  if (!p.uncapped && mergesToday(rows, now) >= CONFLICT_MAX_MERGES_PER_PR_PER_DAY) return "capped";
  return approvals.push ? "merge" : "unapproved";
}

/** The CI fix state at one head from the PR's rows and the already-loaded task states. No query inside. */
export function cifixAt(rows: readonly CifixRow[], head: string, now: number, tasks: TaskStates): CifixFacts {
  // A failure log that could not be read was no try; older rows recorded it as a failed one.
  const all = byCreated(rows).filter((x) => !(x.state === "failed" && x.reason === CIFIX_NO_LOG_REASON));
  const prior = all.filter((x) => x.head === head);
  const formatting = prior.find((x) => x.state === "formatting");
  const infra = prior.find((x) => x.state === "infra");
  const isTry = (x: CifixRow): boolean => CIFIX_TRY_STATES.includes(x.state);
  const unread = prior.filter((x) => x.state === "unread").map((x) => x.createdAt);
  const readWait = unsentAsk(unread, now, CIFIX_UNREAD_DELAYS_MS);
  return {
    states: prior.map((x) => x.state), tries: prior.filter(isTry).length,
    rerunAt: prior.find((x) => x.state === "rerun" || x.state === "rerunning")?.createdAt ?? null,
    infraRuns: infra ? infra.runs ?? [] : null,
    formattingTask: formatting?.taskId ?? null, formatterEnded: taskEnded(tasks, formatting?.taskId ?? null),
    totalPushes: all.filter((x) => CIFIX_PUSH_STATES.includes(x.state)).length, totalTries: all.filter(isTry).length,
    skipReason: [...prior].reverse().find((x) => x.state === "skipped")?.reason ?? null,
    lastTry: [...prior].reverse().find((x) => isTry(x) || x.state === "capped")?.reason ?? null,
    askedPatch: prior.some((x) => x.state === "asked" && x.reason !== CIFIX_ASK_REASON),
    unreads: unread.length,
    ...(readWait && readWait !== "final" ? { readAgainAt: readWait.until } : {}),
    ...unsentOf(prior.filter((x) => x.state === "comment-unsent").map((x) => x.createdAt), now),
  };
}

/** The recorded final states of the review's fix-ups at a head and the unsent-comment backoff. */
export function fixupAtHead(rows: readonly FixupRow[], head: string, now: number): FixupAtHead {
  const at = byCreated(rows).filter((r) => r.source === null && r.fromHead === head && FIXUP_RECORDED_STATES.includes(r.state));
  const held = at.filter((r) => FIXUP_HOLD_STATES.includes(r.state)).at(-1)?.reason;
  return { recorded: at.filter((r) => r.state !== "comment-unsent").map((r) => r.state), ...unsentOf(at.filter((r) => r.state === "comment-unsent").map((r) => r.createdAt), now), ...(held ? { held } : {}) };
}

/**
 * The `base.lint` list: one entry per `linting` row, in the order the planner lists them (operator fix-ups first, then the review's
 * and pre-merge fix-ups, CI fixes, conflict merges). An operator's fix-up works the current head, so its rows are read at
 * `opts.operatorHead` (default `head`); `ended` comes from the loaded task state.
 */
export function lintOf(facts: PatchFacts, head: string, opts: { cifixHead: string; operatorHead?: string; tasks: TaskStates }): LintFactOf[] {
  const out: LintFactOf[] = [];
  const fixups = byId(facts.fixups).filter((r) => r.state === "linting");
  for (const r of fixups) if (r.source === "operator" && r.fromHead === (opts.operatorHead ?? head)) out.push({ step: "fixup", source: "operator", ended: taskEnded(opts.tasks, r.lintTask) });
  for (const r of fixups) if (r.source !== "operator" && r.fromHead === head) out.push({ step: "fixup", source: r.source === "premerge" ? "premerge" : "review", ended: taskEnded(opts.tasks, r.lintTask) });
  for (const r of byId(facts.cifixes)) if (r.state === "linting" && r.head === opts.cifixHead) out.push({ step: "cifix", source: "review", ended: taskEnded(opts.tasks, r.lintTask) });
  for (const r of byId(facts.conflicts)) if (r.state === "linting" && r.fromHead === head) out.push({ step: "conflict", source: "review", ended: taskEnded(opts.tasks, r.lintTask) });
  return out;
}

/** The head and the earlier heads our pushes moved it from, newest first. Takes one PR's edges. */
export function pushChainOf(edges: readonly Pick<PushEdge, "from" | "to">[], head: string): string[] {
  const from = new Map<string, string[]>();
  for (const e of edges) {
    const list = from.get(e.to) ?? from.set(e.to, []).get(e.to)!;
    if (!list.includes(e.from)) list.push(e.from);
  }
  for (const list of from.values()) list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const chain = [head];
  for (let k = 0; k < chain.length; k++) for (const f of from.get(chain[k]!) ?? []) if (!chain.includes(f)) chain.push(f);
  return chain;
}

const newest = (edges: readonly PushEdge[], keep: (e: PushEdge) => boolean): PushEdge | undefined =>
  edges.filter(keep).reduce<PushEdge | undefined>((best, e) => (!best || e.id > best.id ? e : best), undefined);

/** The commit of ours that made `head`: the newest pushed fix-up, else CI fix, else base merge; null for a contributor's commit. */
export function madeBy(edges: readonly PushEdge[], head: string): MadeBy | null {
  for (const [kind, state] of [["fixup", "pushed"], ["cifix", "pushed"], ["conflict", "merged"]] as const) {
    const e = newest(edges, (x) => x.kind === kind && x.to === head && x.state === state);
    if (e) return { kind, from: e.from, id: e.id, source: e.source, reason: e.reason, ciKind: e.ciKind ?? null };
  }
  return null;
}

/** Our conflict merge to `to` kept the PR's own diff the same. */
export function sameDiffMerge(edges: readonly PushEdge[], to: string): boolean {
  return edges.some((e) => e.kind === "conflict" && e.to === to && e.state === "merged" && e.ownDiff === "same");
}
/** `to` is the head of one of our plain fix-ups (source null, pushed). */
export function ourPlainFixup(edges: readonly PushEdge[], to: string): boolean {
  return edges.some((e) => e.kind === "fixup" && e.to === to && e.state === "pushed" && e.source === null);
}

/** Rows in failed-try states created after `since`, counted per step. */
export function failuresSince(facts: PatchFacts, since: string): { step: "fix-up" | "CI fix"; count: number }[] {
  const n = (rows: readonly { state: string; createdAt: string }[]) => rows.filter((r) => FAILED_TRY.includes(r.state) && r.createdAt > since).length;
  return [{ step: "fix-up", count: n(facts.fixups) }, { step: "CI fix", count: n(facts.cifixes) }];
}

/** Added and removed lines of a unified diff. */
export function patchLines(patch: string | null): number {
  return (patch ?? "").split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")).length;
}

/**
 * The item bar's rows of `kind`, newest first by (created, id), without superseded rows. `unsent` counts the `comment-unsent` rows
 * at the same head (fix-ups: of the same source).
 */
export function outcomeRows(facts: PatchFacts, kind: PatchKind): OutcomeRow[] {
  type R = { id: number; state: string; reason: string | null; createdAt: string; head: string; source?: string | null };
  const rows: R[] = kind === "fixup" ? facts.fixups.map((r) => ({ ...r, head: r.fromHead }))
    : kind === "cifix" ? facts.cifixes : facts.conflicts.map((r) => ({ ...r, head: r.fromHead }));
  const unsent = (x: R) => rows.filter((u) => u.state === "comment-unsent" && u.head === x.head && (kind !== "fixup" || (u.source ?? null) === (x.source ?? null))).length;
  return byCreated(rows).reverse().filter((r) => r.state !== "superseded")
    .map((r) => ({ kind, state: r.state, reason: r.reason, createdAt: r.createdAt, unsent: unsent(r) }));
}
