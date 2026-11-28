// Random pull requests for test/invariants.test.ts: the rows behind a PR (its commits, workflow, merge leg, requests, approvals, review,
// checks, patch rows), and the facts src/core/facts.ts would build from them. The facts are made from the rows alone, so a row can be
// changed (a repo approval taken away) and the facts built again.
import { conflictAskRetryAtOf, conflictBucketOf, attemptsIn, cifixAt, fixupAtHead, lintOf, operatorTriesIn, premergeFixRunningIn, premergeFixUsedIn, pushChainOf } from "../src/data/changes/index.ts";
import type { CifixRow, ConflictRow, FixupRow, PatchFacts, PushEdge, TaskStates } from "../src/data/changes/types.ts";
import { pushAllowed } from "../src/core/gates.ts";
import { ownPushes, neededReview } from "../src/core/evidence.ts";
import { workflowGate } from "../src/core/may.ts";
import type { EndedWorkflow, PrFacts, StandingFact } from "../src/core/plan.ts";
import { FIXUP_MAX_ATTEMPTS, sizeOf } from "../src/core/rules.ts";
import type { ImplementationState } from "../src/implement/types.ts";
import type { Blocker, ItemWorkflow } from "../src/workflow/types.ts";
import { NOW } from "./world.ts";

export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rnd = { bool: (p?: number) => boolean; pick: <T>(xs: readonly T[]) => T; int: (n: number) => number };
export const rnd = (r: () => number): Rnd => ({
  bool: (p = 0.5) => r() < p,
  pick: (xs) => xs[Math.floor(r() * xs.length)]!,
  int: (n) => Math.floor(r() * n),
});

const at = (hhmm: string): string => `2026-11-04T${hhmm}:00.000Z`;
const ref = "app#1";
/** The author's accounts and ours. */
const AUTHOR = "dev", OURS = "bot";

type CommitBy = "author" | "fixup" | "fixup-premerge" | "fixup-operator" | "cifix" | "conflict" | "revision" | "repin";
export type Leg = { state: "fixup" | "review" | "ci" | "queued"; head: string | null; fromHead: string; workflow: number; updatedAt: string; fixId: number | null };
export type WorkflowRow = {
  id: number; kind: "pr" | "issue"; entry: "review" | "fixup" | "implement" | "merge"; state: "running" | "waiting" | "blocked" | "recommending";
  approvedBy: string | null; baseHead: string | null; blocker: Blocker | null;
};

export type PrRows = {
  approvals: { merge: boolean; push: boolean; comment: boolean; ci: boolean; fixissue: boolean };
  pipelineOn: boolean; pipelineRepo: boolean; outsideHold: boolean; tripped: PrFacts["tripped"]; noCi: boolean; implementOn: boolean; publicRepo: boolean;
  /** Oldest first; the last one is the head. `at`: when an autorepin or a revision was pushed (the others have a patch row). */
  commits: { sha: string; by: CommitBy; at?: string }[];
  /** We pushed off the head and the mirror does not show it yet. */
  pushedOff: boolean;
  ghState: "OPEN" | "MERGED" | "CLOSED"; draft: boolean; /** The checks already say it is not open. */ gone: boolean; ours: boolean; mainFix: boolean; tier: PrFacts["tier"]; lines: number; label: string | null; labelUnsure: boolean; needsDecision: boolean;
  duplicates: boolean; ruledOut: boolean; integration: boolean; quiet: boolean;
  workflow: WorkflowRow | null;
  /** Without a live workflow: how the latest ended, and whether that was the PR's own or its issue's. */
  ended: EndedWorkflow | null; endedOwn: boolean;
  legs: Leg[]; request: { from: string; by: string; id: number } | null; mergeWaits: boolean;
  implementation: { state: ImplementationState; revised: boolean; /** Whether the person its workflow runs for may act on the repo. */ standing?: "yes" | "no" | "unknown" } | null;
  review: { head: string; verdict: "take" | "take-fix" | "hold" | "close"; sure: boolean; fixes: number; stale: boolean; capped: boolean; blockedBy: "open" | "asked" | "settled" | null } | null;
  gate: "failed" | "failing" | "requested" | "cap" | "interval" | null; carried: boolean; posted: boolean;
  checks: { head: string; overall: "success" | "failure" | "pending" | "none"; approvedRuns: boolean };
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"; unknownStuck: boolean; pushable: boolean;
  runs: { waiting: number; approvable: number } | null; brokeByUs: boolean;
  attempt: PrFacts["lastMerge"]; runsApprovedAfterMerge: boolean;
  verification: { state: string; finishedAt: string } | null;
  premerge: { findings: boolean; tries: number; at: string; unsure: boolean; defects: number; fixable: boolean; safe: boolean } | null;
  patches: PatchFacts; tasks: TaskStates;
  batch: PrFacts["batch"]; changesRequested: boolean; baseOffDefault: boolean; baseOk: boolean; sensitive: string[] | null; diffPending: boolean; conflictsWithStatement: boolean;
  assignedToUs: boolean;
  /** Whether the people the workflow acts for count on the repo; null: not loaded. */
  standing: { merge: StandingFact["standing"] | "box"; work: StandingFact["standing"] | "box" } | null;
};

export const headOf = (w: PrRows): string => w.commits.at(-1)!.sha;
const isOurs = (c: { by: CommitBy }): boolean => c.by !== "author";
/** Whether only our own commits lead from `base` to `head`. */
export function reached(w: PrRows, base: string | null, head: string): boolean {
  const b = w.commits.findIndex((c) => c.sha === base), h = w.commits.findIndex((c) => c.sha === head);
  return b >= 0 && h >= b && w.commits.slice(b + 1, h + 1).every(isOurs);
}

const row = (id: number, createdAt: string) => ({ id, repo: "app", number: 1, createdAt, reason: null, attempt: 1 });
const FIXUPS: readonly string[][] = [[], [], [], ["failed"], ["failed", "failed"], ["failed", "refused", "asked"], ["too-large"], ["too-large", "asked"], ["cannot-push"], ["cannot-push", "asked"], ["push-denied"], ["linting"], ["pushing"], ["comment-failed"], ["comment-unsent"], ["comment-unsent", "comment-unsent", "comment-unsent"]];
const CIFIXES: readonly string[][] = [[], [], [], ["infra"], ["infra", "rerun"], ["formatting"], ["linting"], ["failed"], ["failed", "rejected"], ["failed", "rejected", "asked"], ["capped"], ["capped", "asked"], ["skipped"], ["cannot-push"], ["push-denied"], ["comment-failed"], ["comment-unsent"], ["pushing"]];
const CONFLICTS: readonly string[][] = [[], [], [], ["asked"], ["linting"], ["failed"], ["failed", "rejected"], ["failed", "rejected", "asked"], ["skipped"], ["skipped", "asked"], ["push-denied"], ["cannot-push"], ["comment-failed"], ["comment-unsent"]];

/** The patch rows of the PR: the pushes its commits came from, and what the steps recorded at the head. */
function randomPatches(x: Rnd, w: Pick<PrRows, "commits" | "checks" | "mergeable" | "review" | "request">): { patches: PatchFacts; tasks: TaskStates } {
  const fixups: FixupRow[] = [], cifixes: CifixRow[] = [], conflicts: ConflictRow[] = [];
  const tasks = new Map<number, { state: "done" | "running"; step: string; endedAt: string | null }>();
  let id = 0;
  const task = (): number => { const t = ++id; const done = x.bool(); tasks.set(t, { state: done ? "done" : "running", step: "lint", endedAt: done ? at("11:30") : null }); return t; };
  const addFixup = (fromHead: string, toHead: string | null, state: string, source: FixupRow["source"], when: string): void =>
    void fixups.push({ ...row(++id, when), fromHead, toHead, state, source, lintTask: state === "linting" ? task() : null, lintState: null, operatorFix: source === "operator" ? w.request?.id ?? 99 : null });
  const addCifix = (head: string, toHead: string | null, state: string, when: string): void =>
    void cifixes.push({ ...row(++id, when), head, toHead, kind: state === "infra" ? "infra" : "code", state, files: [], taskId: state === "formatting" ? task() : null, lintTask: state === "linting" ? task() : null, runs: state === "infra" ? [1] : null });
  const addConflict = (fromHead: string, toHead: string | null, state: string, when: string): void =>
    void conflicts.push({ ...row(++id, when), fromHead, toHead, baseSha: "b1", state, lintTask: state === "linting" ? task() : null, ownDiff: toHead ? x.pick(["same", "changed"] as const) : null });
  // Some of them after the start (09:00).
  const when = (i: number): string => (x.bool(0.6) ? `2026-11-0${1 + i}T08:00:00.000Z` : x.bool() ? at(`09:${20 + i}`) : at(`0${i}:00`));
  w.commits.forEach((c, i) => {
    const from = w.commits[i - 1]?.sha;
    if (!from) return;
    if (c.by === "fixup") addFixup(from, c.sha, "pushed", null, when(i));
    else if (c.by === "fixup-premerge") addFixup(from, c.sha, "pushed", "premerge", when(i));
    else if (c.by === "fixup-operator") addFixup(from, c.sha, "pushed", "operator", when(i));
    else if (c.by === "cifix") addCifix(from, c.sha, "pushed", when(i));
    else if (c.by === "conflict") addConflict(from, c.sha, "merged", when(i));
  });
  const head = w.commits.at(-1)!.sha;
  const late = (): string => x.pick([at("11:58"), at("11:00"), at("09:00")]);
  if (w.review?.verdict === "take-fix" && w.review.head === head) for (const s of x.pick(FIXUPS)) addFixup(head, null, s, null, late());
  if (w.review?.verdict === "take" && x.bool(0.1)) addFixup(head, null, x.pick(["failed", "linting", "refused"]), "premerge", late());
  if (w.request?.from === head && x.bool(0.3)) addFixup(head, null, x.pick(["linting", "pushing"]), "operator", late());
  if (w.checks.head === head && w.checks.overall === "failure") for (const s of x.pick(CIFIXES)) addCifix(head, null, s, s === "rerun" ? x.pick([at("10:00"), at("11:50")]) : at("09:30"));
  if (w.mergeable === "CONFLICTING") for (const s of x.pick(CONFLICTS)) addConflict(head, null, s, late());
  const pushes: PushEdge[] = [
    ...fixups.filter((r) => r.toHead).map((r): PushEdge => ({ kind: "fixup", id: r.id, from: r.fromHead, to: r.toHead!, state: "pushed", source: r.source, reason: null, at: r.createdAt })),
    ...cifixes.filter((r) => r.toHead).map((r): PushEdge => ({ kind: "cifix", id: r.id, from: r.head, to: r.toHead!, state: "pushed", source: null, reason: null, at: r.createdAt })),
    ...conflicts.filter((r) => r.toHead).map((r): PushEdge => ({ kind: "conflict", id: r.id, from: r.fromHead, to: r.toHead!, state: "merged", source: null, ownDiff: r.ownDiff, reason: null, at: r.createdAt })),
  ];
  return { patches: { fixups, cifixes, conflicts, pushes }, tasks };
}

export function randomPrRows(x: Rnd): PrRows {
  const impl = x.bool(0.15), mainFix = !impl && x.bool(0.05), ours = impl || mainFix;
  const commits: PrRows["commits"] = [{ sha: "c0", by: ours ? "revision" : "author" }];
  for (let i = 1; i < 1 + x.int(4); i++) commits.push({ sha: `c${i}`, by: x.pick(["author", "fixup", "fixup", "fixup-premerge", "fixup-operator", "cifix", "conflict", "repin", ...(impl ? ["revision" as const] : [])] as const), at: x.bool() ? at(`09:${20 + i}`) : at(`0${i}:00`) });
  const head = commits.at(-1)!.sha, some = (p = 0.85): string => (x.bool(p) ? head : x.pick(commits).sha);

  // Its workflow: none, its own, or (an implementation PR) its issue's.
  const kind = x.bool(0.35) ? null : impl && x.bool(0.8) ? "issue" : "pr";
  let workflow: WorkflowRow | null = null;
  // The oldest commit our own pushes alone lead from to the head.
  const owns = commits.findLastIndex((c) => c.by === "author");
  const baseOf = (): string => (x.bool(0.85) ? commits[Math.max(0, owns) + x.int(commits.length - Math.max(0, owns))]!.sha : x.pick(commits).sha);
  if (kind) {
    const entry = kind === "issue" ? "implement" as const : x.pick(["review", "review", "fixup", "merge"] as const);
    // The merge entry implies the approval; an item back with its end recommendation is one nobody approved, an issue also one whose implementation asks.
    const state = x.pick(["running", "running", "running", "waiting", "blocked", ...(entry === "merge" ? [] : ["recommending" as const])] as const);
    const approvedBy = entry === "merge" || ((state !== "recommending" || kind === "issue") && x.bool(0.6)) ? "mira" : null;
    workflow = {
      id: 7, kind, entry, state, approvedBy, baseHead: kind === "issue" && x.bool(0.5) ? null : baseOf(),
      blocker: state === "blocked" ? (approvedBy ? x.pick(["author-commits", "failed-twice", "other"] as const) : "failed-twice") : null,
    };
  }
  const ended = workflow ? null : x.pick([null, null, null, "stopped", "backlog", "closed", "done"] as const);

  const requested = !!workflow && workflow.state !== "recommending" && x.bool(0.15);
  const request = requested ? { from: some(), by: "noor", id: 41 } : null;
  // Its merge leg: one runs only for an approved item; a blocker cancels it, except one an integration batch holds.
  const legs: Leg[] = [];
  let inBatch = false;
  if (workflow?.approvedBy && workflow.state !== "recommending") {
    // It is at the head, or (for a moment after someone else's push) at the head the workflow accepted. A leg at a head the workflow
    // did not accept should not exist; the merge must be refused all the same.
    const ok = workflow.baseHead === null || reached({ commits } as PrRows, workflow.baseHead, head);
    const at0 = workflow.baseHead ?? head;
    const state = x.pick(["review", "ci", "queued", "queued", "queued", null] as const);
    const leg = (s: Leg["state"], h: string | null): Leg => ({ state: s, head: h, fromHead: at0, workflow: 7, updatedAt: x.pick([at("10:20"), at("10:20"), at("09:50")]), fixId: null });
    if (workflow.state === "blocked") { if (x.bool(0.2)) { legs.push(leg("queued", ok ? head : at0)); inBatch = true; } }
    else if (request && request.from === head && x.bool(0.5)) legs.push({ ...leg("fixup", null), fixId: request.id });
    else if (state) legs.push(leg(state, x.bool(ok ? 0.9 : 0.3) ? head : at0));
  } else if (workflow && x.bool(0.05)) legs.push({ state: "queued", head, fromHead: head, workflow: 7, updatedAt: at("10:20"), fixId: null });
  const review: PrRows["review"] = x.bool(0.08) || workflow?.entry === "merge" && x.bool() ? null : {
    head: some(0.88), verdict: x.pick(["take", "take", "take", "take", "take-fix", "take-fix", "hold", "close"] as const), sure: x.bool(0.8), fixes: x.int(3), stale: x.bool(0.06), capped: x.bool(0.2),
    blockedBy: x.pick([null, "open", "asked", "settled"] as const),
  };
  const checks: PrRows["checks"] = { head: some(0.93), overall: x.pick(["success", "success", "success", "success", "failure", "failure", "pending", "none"] as const), approvedRuns: x.bool(0.05) };
  const mergeable = x.pick(["MERGEABLE", "MERGEABLE", "MERGEABLE", "MERGEABLE", "MERGEABLE", "CONFLICTING", "UNKNOWN"] as const);
  const lastBy = commits.at(-1)!.by;
  return {
    approvals: { merge: x.bool(0.6), push: x.bool(0.6), comment: x.bool(0.7), ci: x.bool(0.7), fixissue: x.bool(0.5) },
    pipelineOn: x.bool(0.93), pipelineRepo: x.bool(0.8), outsideHold: x.bool(0.03), noCi: x.bool(0.1), implementOn: x.bool(0.8), publicRepo: x.bool(0.85),
    tripped: x.bool(0.07) ? { [x.pick(["fixup", "cifix", "implement", "merge"] as const)]: "2 of the last 10 pushes broke a required check" } : {},
    commits, pushedOff: x.bool(0.03), ghState: x.pick(["OPEN", "OPEN", "OPEN", "OPEN", "OPEN", "OPEN", "OPEN", "OPEN", "MERGED", "CLOSED"] as const), draft: x.bool(0.05), gone: x.bool(0.01), ours, mainFix,
    tier: x.pick(["whitelisted", "whitelisted", "allow", "not", "deny"] as const), lines: x.pick([20, 20, 120, 900]), label: x.pick(["bugfix", "bugfix", "bugfix", "infra", "performance", null]), labelUnsure: x.bool(0.05), needsDecision: x.bool(0.05),
    duplicates: !workflow && x.bool(0.1), ruledOut: x.bool(0.05), integration: !workflow && x.bool(0.02), quiet: x.bool(0.03),
    workflow, ended, endedOwn: ended !== null && !(impl && x.bool(0.7)), legs, request, mergeWaits: x.bool(0.06),
    implementation: impl ? { state: x.pick(["pr-opened", "pr-opened", "pr-opened", "revising", "stuck", "closed", "cancelled"] as const), revised: x.bool(0.3), standing: x.pick(["yes", "yes", "yes", "no", "unknown"] as const) } : null,
    review, gate: x.pick([null, null, null, null, null, null, "failed", "failing", "requested", "cap", "interval"] as const), carried: x.bool(0.3), posted: x.bool(0.7),
    checks, mergeable, unknownStuck: x.bool(0.3), pushable: ours || x.bool(0.7), runs: x.bool(0.1) ? { waiting: 1 + x.int(2), approvable: x.int(2) } : null, brokeByUs: lastBy !== "author" && x.bool(0.3),
    attempt: x.bool(0.85) ? null : {
      outcome: "refused", reason: x.pick(["not ready at merge time: CI pending", "the PR touches a protected file", "gateway timed out"]), ci: x.pick(["success", "pending", null]), mergeable: x.pick(["MERGEABLE", "UNKNOWN", null]), refusals: 1 + x.int(2),
    },
    runsApprovedAfterMerge: x.bool(0.1),
    verification: x.bool(0.1) ? null : { state: x.pick(["passed", "passed", "passed", "passed", "ci-enough", "ci-enough", "failed", "error", "running", "planned", "stale", "unavailable"]), finishedAt: x.pick([at("10:10"), at("10:30")]) },
    premerge: x.bool(0.2) ? null : { findings: x.bool(0.9), tries: 1 + x.int(3), at: x.pick([at("11:40"), at("09:40")]), unsure: x.bool(0.15), defects: x.pick([0, 0, 0, 0, 1, 2]), fixable: x.bool(0.7), safe: x.bool(0.8) },
    ...randomPatches(x, { commits, checks, mergeable, review, request }),
    batch: inBatch ? "in-batch" : x.pick([null, null, null, null, null, null, null, "batch-checking", "in-batch", "batch-failed"] as const),
    changesRequested: x.bool(0.05), baseOffDefault: x.bool(0.08), baseOk: x.bool(0.95), sensitive: x.pick([[], [], [], [], [], ["changes the README"], null]), diffPending: x.bool(0.05), conflictsWithStatement: x.bool(0.04),
    assignedToUs: x.bool(0.5),
    standing: x.bool(0.3) ? null : { merge: x.pick(["yes", "yes", "yes", "yes", "yes", "no", "unknown", "box"] as const), work: x.pick(["yes", "yes", "yes", "yes", "yes", "no", "unknown", "box"] as const) },
  };
}

/** A started PR that its approver's leg handed to the merge queue, with everything green, and the given rows instead. */
export function greenRows(over: Partial<PrRows> = {}): PrRows {
  return {
    approvals: { merge: true, push: true, comment: true, ci: true, fixissue: true }, pipelineOn: true, pipelineRepo: true, outsideHold: false, tripped: {}, noCi: false, implementOn: true, publicRepo: true,
    commits: [{ sha: "c0", by: "author" }], pushedOff: false, ghState: "OPEN", draft: false, gone: false, ours: false, mainFix: false, tier: "whitelisted", lines: 20, label: "bugfix", labelUnsure: false, needsDecision: false,
    duplicates: false, ruledOut: false, integration: false, quiet: false, workflow: startedAs("fixup"), ended: null, endedOwn: false,
    legs: [{ state: "queued", head: "c0", fromHead: "c0", workflow: 7, updatedAt: at("10:20"), fixId: null }], request: null, mergeWaits: false, implementation: null,
    review: reviewed("take"), gate: null, carried: false, posted: true, checks: { head: "c0", overall: "success", approvedRuns: false }, mergeable: "MERGEABLE", unknownStuck: false, pushable: true, runs: null, brokeByUs: false,
    attempt: null, runsApprovedAfterMerge: false, verification: { state: "passed", finishedAt: at("10:10") }, premerge: { findings: true, tries: 1, at: at("10:15"), unsure: false, defects: 0, fixable: true, safe: true },
    patches: { fixups: [], cifixes: [], conflicts: [], pushes: [] }, tasks: new Map(), batch: null, changesRequested: false, baseOffDefault: false, baseOk: true, sensitive: [], diffPending: false, conflictsWithStatement: false,
    assignedToUs: true, standing: { merge: "yes", work: "yes" }, ...over,
  };
}
export const startedAs = (entry: WorkflowRow["entry"], over: Partial<WorkflowRow> = {}): WorkflowRow => ({ id: 7, kind: "pr", entry, state: "running", approvedBy: "mira", baseHead: "c0", blocker: null, ...over });
export const reviewed = (verdict: NonNullable<PrRows["review"]>["verdict"], head = "c0"): NonNullable<PrRows["review"]> =>
  ({ head, verdict, sure: true, fixes: verdict === "take-fix" ? 2 : 0, stale: false, capped: false, blockedBy: null });

const APPROVAL = { by: "op", at: "2026-11-01T00:00:00.000Z" };

/** The live workflow as the store reads it. */
const itemWorkflow = (w: WorkflowRow): ItemWorkflow => ({
  id: w.id, repo: "app", number: w.kind === "pr" ? 1 : 5, kind: w.kind, entry: w.entry, weight: 5, state: w.state, startedBy: "mira", startedAt: at("09:00"), startedVia: "github",
  baseHead: w.baseHead, acceptedHead: null, approvedBy: w.approvedBy, approvedAt: w.approvedBy ? at("09:00") : null, blocker: w.blocker,
} as unknown as ItemWorkflow);

/** Why the review of the head waits (src/review/gate.ts holdsFrom). */
function reviewHoldOf(w: PrRows, head: string): PrFacts["reviewHold"] {
  if (w.gate === "failed") return { kind: "failed", wait: "its review failed 4 times at this commit; a new commit, a Review again press or a maintainer's comment gives it one more try" };
  if (w.gate === "failing") return { kind: "failed", wait: "the review after 1 failed try at this commit, from 12:05", until: NOW + 300_000 };
  if (w.legs.some((l) => l.state === "review" && l.head === head && (l.fixId !== null || l.head !== l.fromHead))) return undefined;
  const last = w.review;
  if (last && w.gate === "requested") return undefined;
  if (last?.verdict === "hold" && (last.blockedBy === "open" || last.blockedBy === "asked")) return { kind: "blocked", wait: "app#9, which blocks its review", ...(last.blockedBy === "asked" ? { person: true } : {}) };
  const ci = w.checks.head === head ? w.checks.overall : "unknown";
  if (ci === "pending") return { kind: "ci", wait: "CI on the latest commit to finish" };
  if (ci === "failure" && last && !(last.verdict === "hold" && last.blockedBy === "settled")) return { kind: "ci", wait: "CI on the latest commit to pass", red: true };
  if (last && last.head !== head && reached(w, last.head, head)) return undefined;
  if (w.gate === "cap") return { kind: "cap", wait: "review cap for today reached; next on a maintainer's request or tomorrow", until: NOW + 12 * 3600_000 };
  if (w.gate === "interval") return { kind: "interval", wait: "next review after 13:00", until: NOW + 3600_000 };
  return undefined;
}

const standingOf = (s: StandingFact["standing"] | "box"): StandingFact => ({ login: "mira", standing: s === "box" ? "unknown" : s, ...(s === "box" ? { boxIdentity: true as const } : {}) });

/** The PR's facts, as src/core/facts.ts builds them from its rows. */
export function factsOf(w: PrRows): PrFacts {
  const head = headOf(w), open = w.ghState === "OPEN";
  const live = w.workflow;
  const heldBacklog = !live && w.ended === "backlog";
  const inScope = !!live || (w.pipelineRepo && !w.outsideHold && !(w.endedOwn && w.ended !== null && w.ended !== "done"));
  const requests = w.request ? [w.request] : [];
  const legRows = w.legs.map((l) => ({ workflow_id: l.workflow, state: l.state, from_head: l.fromHead, head: l.head }));
  const wfRow = live ? itemWorkflow(live) : null;
  const outEdge = w.pushedOff ? [{ from: head, to: "next" }] : [];
  // Revisions of our implementation are recorded with the push outcomes, autorepins with their requests, the other pushes by their patch rows.
  const made = (by: CommitBy) => w.commits.flatMap((c, i) => (i > 0 && c.by === by ? [{ from: w.commits[i - 1]!.sha, to: c.sha, at: c.at ?? at("08:00") }] : []));
  const ours = ownPushes([], w.patches.pushes, [...made("revision").map((p) => ({ ...p, action: "implement-push" })), ...outEdge.map((e) => ({ ...e, action: "fixup-push", at: at("11:50") }))], made("repin"));
  const moves = ours.map(({ from, to }) => ({ from, to }));
  const needed = open && live?.entry === "merge" ? neededReview({ entry: "merge", startedAt: at("09:00"), since: at("09:00"), reviewAskedAt: null }, ours, head, w.review ? [{ head: w.review.head, at: at("10:00") }] : []) : null;
  const owed = needed !== null;
  const ownCommit = (h: string): boolean => w.commits.some((c) => c.sha === h && isOurs(c));
  const ownHead = pushChainOf(moves, head).some((h) => ownCommit(h) && !moves.some((m) => m.to === h && m.from !== h));
  const f: PrFacts = {
    repo: "app", number: 1, now: NOW, ...(owed ? { reviewOwed: true } : {}), ...(w.pushedOff && open && !w.integration ? { pushedOff: true } : {}), assignment: { login: OURS, assignees: [w.assignedToUs ? OURS : AUTHOR], ours: w.assignedToUs },
    pipelineOn: w.pipelineOn, tripped: w.tripped, ghState: w.ghState, head, draft: w.draft || w.gone, ...(w.gone ? { gone: true as const } : {}), author: w.ours ? OURS : AUTHOR, authorIsPipeline: w.ours, tier: "not", lines: w.lines, size: sizeOf(w.lines),
    label: null, needsDecisionFlag: false, inScope: w.integration ? w.pipelineRepo : inScope, ...(w.outsideHold ? { outsideHold: { reason: "limit", author: AUTHOR, kind: "pr", limit: 5 } as const } : {}),
    integration: w.integration, batchPr: w.integration, heldBacklog, quiet: w.quiet, score: 1,
    repoFacts: { commentApproved: w.approvals.comment, ciApproved: w.approvals.ci, noCi: w.noCi, implementOn: w.implementOn },
    review: null, post: { postable: false, posted: null }, checksHere: false, checksOpen: false, ci: "unknown", vsMain: null, mergeable: w.mergeable, unknown: null, runs: null, lastMerge: null, runsApprovedAfterMerge: false,
    verifyOverride: false, verification: null, verifyUnavailable: null, handOver: false, mergeWaiting: false, premerge: null, premergeFixUsed: false, sensitive: null, statementConflicts: [], pushable: false, pushChain: [],
    conflict: null, inActiveBatch: w.batch === "in-batch" || w.batch === "batch-checking", fixup: null, lint: [], cifix: null, postmerge: null, batch: null, mainFix: false, baseOffDefault: false,
    changesRequested: null, gateFailureNote: null,
    may: {
      repoMerge: w.approvals.merge ? APPROVAL : null, repoPush: w.approvals.push ? APPROVAL : null, workflow: workflowGate(wfRow, { legs: legRows }),
      ended: w.ended, pushes: moves, ownHead, fixupBy: w.request?.from === head ? w.request.by : null,
    },
    inFlight: open && !w.integration && w.mainFix,
    implementation: w.implementation ? { issue: 5, state: w.implementation.state, revisedHeads: w.implementation.revised ? [head] : [], queuedBy: live?.kind === "issue" ? "mira" : null, standing: live?.kind === "issue" ? w.implementation.standing ?? "yes" : "no" } : null,
    workflow: live ? { entry: live.entry, state: live.state, approved: live.approvedBy !== null, startedBy: "mira", startedAt: at("09:00"), own: live.kind === "pr" } : null,
    endedWorkflow: w.ended,
    ...(w.standing ? { standing: { merge: live?.approvedBy ? standingOf(w.standing.merge) : null, work: live ? standingOf(w.standing.work) : null } } : {}),
  };
  if (w.integration || !f.inScope) return f;
  if (open && w.duplicates) f.duplicates = { of: [3], compared: true };
  if (open) f.baseOffDefault = w.baseOffDefault;
  if (open && (w.ruledOut || w.baseOffDefault)) f.ruledOut = [...(w.ruledOut ? ["changes the README"] : []), ...(w.baseOffDefault ? ["its base is not the default branch"] : [])];
  f.label = w.label; f.labelUnsure = w.labelUnsure; f.needsDecisionFlag = w.needsDecision;
  f.tier = w.tier === "not" && w.ours && ownHead ? "whitelisted" : w.tier;
  const mx = open && live?.entry === "merge" && !owed, r = needed?.from != null && at("10:00") <= needed.from ? null : w.review;
  const fresh = w.checks.head === (mx ? head : r?.head ?? head);
  f.mergeable = fresh ? w.mergeable : w.mergeable === "CONFLICTING" ? "CONFLICTING" : "UNKNOWN";
  f.pushable = w.pushable;
  if (open && (w.legs.length || requests.length)) {
    f.operator = {
      fix: w.request?.from === head ? { attempts: operatorTriesIn(w.patches.fixups) } : null,
      hold: w.legs.some((l) => l.state !== "queued"), premerge: w.legs.some((l) => l.state === "ci" && l.head === head),
    };
    if (f.operator.fix && !heldBacklog && !f.draft && f.mergeable !== "CONFLICTING" && f.pushable && pushAllowed(f, "fixup", true) && operatorTriesIn(w.patches.fixups) < FIXUP_MAX_ATTEMPTS) f.operator.hold = true;
  }
  const lintAt = (qh: string, cifixHead: string) => lintOf(w.patches, qh, { cifixHead, operatorHead: head, tasks: w.tasks });
  if (f.operator && open) for (const l of lintAt(head, head)) if (l.source === "operator") f.lint.push({ step: "fixup", source: "operator", ended: l.ended });
  if (open && !f.draft) { const hold = reviewHoldOf(w, head); if (hold) f.reviewHold = hold; }
  if (!mx && !r) return f;
  const qh = mx ? head : r!.head, qAt = mx ? at("09:00") : at("10:00");
  const handed = live && (live.approvedBy !== null || live.entry === "merge") ? w.legs.find((l) => l.state === "queued" && l.head === qh && l.workflow === live.id) : undefined;
  f.handOver = handed !== undefined;
  // The leg went on past a hold or close review: the person answered after it.
  const wentOn = !mx && (r!.verdict === "hold" || r!.verdict === "close") && !!live && w.legs.some((l) => (l.state === "ci" || l.state === "queued") && l.head === qh && l.workflow === live.id && l.updatedAt > qAt);
  const verdict = wentOn ? "take" as const : r?.verdict;
  f.mergeWaiting = !!handed && w.mergeWaits;
  const take = mx || verdict === "take" || verdict === "take-fix";
  const chain = take ? pushChainOf(w.patches.pushes, qh) : [qh];
  if (!mx) {
    f.review = { head: qh, at: qAt, verdict: verdict!, unsure: take && !r!.sure, reason: "because", fixes: r!.fixes, followUps: 0, filingHead: qh, leadsToHead: true, stale: r!.stale, staleActionable: r!.stale && !r!.capped };
    const last = w.commits.at(-1)!;
    if (w.carried && head !== qh && take && reached(w, qh, head) && (last.by === "fixup" || last.by === "conflict") && !r!.stale) f.carriable = true;
  }
  f.pushChain = chain;
  if (open && (chain.length > 1 || ownCommit(head))) f.inFlight = true;
  f.sensitive = w.diffPending ? [...(w.sensitive ?? []), "waits for its extras"] : w.sensitive;
  if (w.diffPending) f.diffPending = { lastRead: NOW - 600_000 };
  f.post = { postable: true, posted: w.posted ? { head: qh, at: at("10:01"), opusAt: at("10:00") } : null };
  if (w.conflictsWithStatement) f.statementConflicts = [{ id: 3, where: "app", text: "t", reason: "r" }];
  const cifixOf = (h: string): NonNullable<PrFacts["cifix"]> => ({ ...cifixAt(w.patches.cifixes, h, NOW, w.tasks), checksAt: at("11:00"), running: false, failing: [] });
  const redNow = w.checks.head === head && w.checks.overall === "failure";
  if (!take && open && head !== qh && f.reviewHold?.kind === "ci" && f.reviewHold.red && redNow) { f.ci = "failure"; f.gateRed = true; f.cifix = cifixOf(head); }
  if (!take) return f;
  f.checksHere = w.checks.head === qh;
  f.checksOpen = f.checksHere && open && !f.draft;
  f.ci = f.checksHere ? (w.checks.approvedRuns ? "pending" : w.checks.overall) : "unknown";
  f.runs = w.runs && { waiting: w.runs.waiting, reread: false, crossRepo: !w.ours, approvable: w.runs.approvable, blocked: !w.approvals.ci ? "off" : w.ours ? "unsupported" : w.runs.approvable ? null : "failed" };
  f.brokeByUs = w.brokeByUs && redNow;
  f.gateRed = !f.brokeByUs && !!f.reviewHold?.red && head !== qh && redNow;
  if (w.attempt && !(handed && handed.updatedAt > at("10:05"))) { f.lastMerge = w.attempt; f.runsApprovedAfterMerge = w.runsApprovedAfterMerge; }
  f.verification = w.verification && { state: w.verification.state, kind: "build", summary: "what it found", note: null };
  f.verifyOverride = !!handed && !!w.verification && (w.verification.state === "failed" || w.verification.state === "error") && w.verification.finishedAt <= handed.updatedAt;
  if (!f.verification || f.verification.state === "stale") f.verifyUnavailable = w.publicRepo ? null : "the repo is private";
  if (open && f.mergeable === "UNKNOWN") f.unknown = { since: at("11:00"), reads: 4, rereads: w.unknownStuck ? 1 : 0, stuck: w.unknownStuck };
  if (!open) return f;
  const pm = w.premerge;
  if (pm) {
    const defects = pm.findings ? pm.defects : 0;
    f.premerge = { head: qh, at: pm.at, tries: pm.tries, hasFindings: pm.findings, unsure: pm.findings && pm.unsure, defects, followUps: 0, fixesSafe: (pm.fixable && pm.safe) || !defects, minor: 0, error: pm.findings ? null : "no answer" };
    if (defects) {
      f.premergeFixUsed = premergeFixUsedIn(w.patches.fixups);
      if (premergeFixRunningIn(w.patches.fixups, qh, w.pushedOff)) f.premergeFixRunning = true;
    }
  }
  if (f.mergeable === "CONFLICTING") {
    const bucket = conflictBucketOf(w.patches.conflicts, { head: qh, pushable: f.pushable, gone: qh === head && !f.pushedOff, uncapped: !!w.workflow?.approvedBy }, { push: pushAllowed(f, "conflict"), comment: w.approvals.comment && !f.quiet }, NOW);
    const until = bucket === "capped" ? NOW + 12 * 3600_000 : bucket === "ask-retry" ? conflictAskRetryAtOf(w.patches.conflicts, qh, NOW) : undefined;
    f.conflict = { bucket, base: "main", baseOk: w.baseOk, ...(until !== undefined ? { until } : {}) };
  }
  if (!mx && verdict === "take-fix") f.fixup = { fixes: r!.fixes, attempts: attemptsIn(w.patches.fixups), ...fixupAtHead(w.patches.fixups, qh, NOW) };
  for (const l of lintAt(qh, f.brokeByUs || f.gateRed ? head : qh)) if (l.source === "review" || l.source === "premerge") f.lint.push({ step: l.step, source: l.source, ended: l.ended });
  if (f.lint.length) f.inFlight = true;
  if (f.ci === "failure" || f.brokeByUs || f.gateRed) f.cifix = cifixOf(f.brokeByUs || f.gateRed || head !== qh ? head : qh);
  f.batch = w.batch;
  f.mainFix = w.mainFix && ownHead;
  f.changesRequested = w.changesRequested ? { why: "ana asked for changes", live: true } : null;
  return f;
}

