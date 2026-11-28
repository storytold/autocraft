// A complete default PrFacts for decision tests: an open take PR that was started and approved, on the rule path with everything green (state ready, due: merge).
import type { ItemFacts, PrFacts } from "../src/core/plan.ts";

export const NOW = Date.parse("2026-11-04T12:00:00Z");
export const HEAD = "h1";
export const REVIEW_AT = "2026-11-04T10:00:00.000Z";

type Override = { [K in keyof PrFacts]?: PrFacts[K] extends object | null ? Partial<NonNullable<PrFacts[K]>> | null : PrFacts[K] };

const base = (): Omit<PrFacts, "may"> => ({
  repo: "app", number: 1, assignment: { login: "bot", assignees: ["dev"], ours: false }, now: NOW, pipelineOn: true, ghState: "OPEN", head: HEAD, draft: false,
  author: "dev", authorIsPipeline: false, tier: "whitelisted", lines: 20, size: "S", label: "bugfix", needsDecisionFlag: false,
  inScope: true, integration: false, batchPr: false, heldBacklog: false, score: 100,
  repoFacts: { commentApproved: true, ciApproved: true, noCi: false, implementOn: true },
  review: { head: HEAD, at: REVIEW_AT, verdict: "take", unsure: false, reason: "ok", fixes: 0, followUps: 0, filingHead: HEAD, leadsToHead: true, stale: false, staleActionable: false },
  post: { postable: true, posted: { head: HEAD, at: "2026-11-04T10:01:00.000Z", opusAt: REVIEW_AT } },
  checksHere: true, checksOpen: true, ci: "success", vsMain: null, mergeable: "MERGEABLE", unknown: null, runs: null,
  lastMerge: null, runsApprovedAfterMerge: false, verifyOverride: false,
  verification: { state: "passed", kind: "build", summary: null, note: null }, verifyUnavailable: null,
  handOver: false, mergeWaiting: false,
  workflow: { entry: "review", approved: true, startedBy: "maint", startedAt: "2026-11-04T09:00:00.000Z", own: true },
  premerge: { head: HEAD, at: "2026-11-04T10:30:00.000Z", tries: 0, hasFindings: true, unsure: false, defects: 0, followUps: 0, fixesSafe: true, minor: 0, error: null },
  premergeFixUsed: false, sensitive: [], statementConflicts: [], pushable: true, pushChain: [HEAD], conflict: null, inActiveBatch: false, fixup: null, lint: [], cifix: null, postmerge: null, batch: null, mainFix: false, baseOffDefault: false, changesRequested: null, gateFailureNote: null,
});

const REPO_APPROVAL = { by: "op", at: "2026-11-01T00:00:00.000Z" };

/** The approval inputs that go with the other facts: the repo approves merges and pushes, and a live workflow accepted the head and was approved by whoever started it. */
function mayOf(f: Omit<PrFacts, "may">): PrFacts["may"] {
  const w = f.workflow;
  return {
    repoMerge: REPO_APPROVAL, repoPush: REPO_APPROVAL, ended: f.endedWorkflow ?? null, pushes: [], ownHead: false, fixupBy: f.operator?.fix ? "maint" : null,
    workflow: w ? {
      live: true, entry: w.entry === "fixup" ? "fix-up" : w.entry, state: "running", startedBy: w.startedBy, approvedBy: w.approved ? w.startedBy : null,
      approvedAt: w.approved ? w.startedAt : null, blocker: null, baseHead: f.head,
      leg: f.handOver ? { state: "queued", head: f.head } : f.operator?.hold ? { state: "ci", head: f.head } : null,
    } : null,
  };
}

/** The default facts with the given fields replaced. Object fields (review, repoFacts, may, ...) are merged one level deep; null replaces the whole object. */
export function prFacts(over: Override = {}): PrFacts {
  const f = base() as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const cur = f[k];
    f[k] = v !== null && typeof v === "object" && !Array.isArray(v) && cur !== null && typeof cur === "object" && !Array.isArray(cur) ? { ...cur, ...v } : v;
  }
  return { ...f, may: { ...mayOf(f as Omit<PrFacts, "may">), ...over.may } } as PrFacts;
}

// ---- items (issues and PRs) in the triage steps

const itemBase = (): ItemFacts => ({
  repo: "app", number: 1, kind: "issue", open: true, assignment: { login: "bot", assignees: ["dev"], ours: false }, now: NOW, pipelineOn: true, draft: false, inScope: true, integration: false, held: null, score: 100,
  repoFacts: { labelsApproved: true, commentApproved: true }, run: "run1",
  classification: {
    status: "settled", label: "bugfix", flags: [], jevLabel: "bugfix", haikuLabel: null, referee: null,
    jev: { at: "2026-11-04T08:00:00.000Z", changed: false, unsure: false }, haiku: null,
  },
  embedHash: "e1", embeddedHash: "e1", priorityHash: "e1", scannedHash: "e1", pairsToCheck: 0, inCompareSet: false,
  labels: { existing: ["bugfix"], labeledNote: null },
  close: null,
  openPr: null,
  implement: { queuedBy: null, standing: "no", featureOn: false, row: null, liveInRepo: 0 },
});

/** The default facts of an open issue with nothing due (backlog priority, so no fix, classified bugfix, labelled, embedded, scanned, prioritized), with the given fields replaced. Object fields are merged one level deep; null replaces the whole object. */
export function itemFacts(over: { [K in keyof ItemFacts]?: ItemFacts[K] extends object | null ? Partial<NonNullable<ItemFacts[K]>> | null : ItemFacts[K] } = {}): ItemFacts {
  const f = itemBase() as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const cur = f[k];
    f[k] = v !== null && typeof v === "object" && !Array.isArray(v) && cur !== null && typeof cur === "object" && !Array.isArray(cur) ? { ...cur, ...v } : v;
  }
  return f as ItemFacts;
}
