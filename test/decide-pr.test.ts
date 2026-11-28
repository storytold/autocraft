// The decision table for open PRs, review to merge: facts overrides in, state, path and due actions out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINTAINER_ANSWER_WAIT, NOT_STARTED_WAIT, decidePr } from "../src/core/decide.ts";
import { PREMERGE_DEFECT_REASON, PREMERGE_FAILED_REASON, PREMERGE_UNSURE_REASON, UNSURE_REASON } from "../src/core/rules.ts";
import type { WaitCode, Who } from "../src/core/codes.ts";
import { QUEUE_STATES, type Plan, type PrFacts } from "../src/core/plan.ts";
import { NOW, REVIEW_AT, prFacts } from "./world.ts";

type Over = Parameters<typeof prFacts>[0];
type Row = { name: string; facts: Over; expect: { state?: string; path?: "rule" | "operator" | "maintainer" | null; actions?: string[]; reasons?: string[]; eligible?: boolean; note?: string | null; conflictNote?: string | null; wait?: string | null; code?: WaitCode | null; who?: Who } };

const tokens = (p: Plan): string[] => p.actions.map((a) => {
  const bucket = typeof a.params?.bucket === "string" ? a.params.bucket : null;
  if (a.kind === "fixup") return a.params?.source === "premerge" ? "fixup:premerge" : `fixup:${bucket}`;
  return bucket ? `${a.kind}:${bucket}` : a.kind;
}).sort();
const SIZE_L = { size: "L", lines: 900 } as const;
/** Nobody started it. */
const UNSTARTED = { workflow: null } as const;
const MERGE_ENTRY = { entry: "merge", approved: true, startedBy: "maint", startedAt: "2026-11-04T09:00:00.000Z", own: true } as const;
const HANDED = { handOver: true } as const;
/** The merge leg of an approved PR waits in `ci`: for CI, then the pre-merge review. */
const IN_CI = { operator: { fix: null, hold: true, premerge: true } } as const;
const BLOCKED_GATE = { live: true, entry: "review", state: "blocked", startedBy: "maint", approvedBy: "maint", approvedAt: "2026-11-04T09:00:00.000Z", blocker: "other", baseHead: "h1", leg: null } as const;
const premerge = (o: Partial<NonNullable<PrFacts["premerge"]>>) => ({ at: "2026-11-04T10:30:00.000Z", tries: 0, hasFindings: true, unsure: false, defects: 0, minor: 0, error: null, ...o });
const TAKE_FIX = { review: { verdict: "take-fix" } } as const;
const fixup = (o: Partial<NonNullable<PrFacts["fixup"]>> = {}) => ({ fixes: 2, attempts: 0, recorded: [] as string[], ...o });
const conflicting = (o: Partial<NonNullable<PrFacts["conflict"]>> = {}) => ({ mergeable: "CONFLICTING", conflict: { bucket: "merge", base: "main", baseOk: true, ...o } });
const CI_FAIL = { ci: "failure" } as const;
/** Started at the fix-up, merge not approved: the CI fix runs, and what it gives up on is the contributor's. */
const FIXUP_ONLY = { workflow: { entry: "fixup", approved: false, startedBy: "maint", startedAt: "2026-11-04T09:00:00.000Z", own: true } } as const;
const cifix = (o: Partial<NonNullable<PrFacts["cifix"]>> = {}) => ({ states: [] as string[], tries: 0, rerunAt: null, infraRuns: null, formattingTask: null, formatterEnded: true, totalPushes: 0, totalTries: 0, checksAt: "2026-11-04T11:00:00.000Z", ...o });
const merged = (o: Partial<NonNullable<PrFacts["postmerge"]>> = {}) => ({ mergedAt: "2026-11-04T09:00:00.000Z", head: "h1", why: "rule" as const, since: "2026-11-01T00:00:00.000Z", review: null, ...o });
const runs = (o: Partial<NonNullable<PrFacts["runs"]>> = {}) => ({ waiting: 1, reread: false, crossRepo: true, approvable: 1, blocked: null, ...o });

const rows: Row[] = [
  // ---- the rule path
  { name: "clean rule PR is ready and merges", facts: UNSTARTED, expect: { state: "ready", path: "rule", actions: ["merge"], reasons: [], eligible: true } },
  { name: "an approved PR the rule would merge waits for its hand-over", facts: {}, expect: { state: "ready", path: "maintainer", actions: [], eligible: false } },
  { name: "an approved PR the rule would merge, handed over, merges", facts: HANDED, expect: { state: "ready", path: "rule", actions: ["merge"] } },
  { name: "take-fix goes to fix-up, outside the rule", facts: { review: { verdict: "take-fix" } }, expect: { state: "needs-fix-up", path: null, actions: [], reasons: ["review asks for fixes"] } },
  { name: "size L is outside the rule", facts: SIZE_L, expect: { state: "needs-decision", path: null, actions: [], reasons: ["size L"] } },
  { name: "a conflict with an owner statement keeps a clean PR off the rule", facts: { statementConflicts: [{ id: 3, where: "designcraft#1484", text: "Hyphenation and dictionaries belong in craft-libs", reason: "adds a hyphenation table" }] }, expect: { state: "needs-decision", path: null, actions: [], reasons: ["conflicts with designcraft#1484: \"Hyphenation and dictionaries belong in craft-libs\" (adds a hyphenation table)"] } },
  { name: "a conflict does not stop a hand-over", facts: { statementConflicts: [{ id: 3, where: "app#2", text: "t", reason: "r" }], ...HANDED }, expect: { state: "decision-answered-merge", path: "operator", actions: ["merge"] } },
  { name: "no conflict leaves the rule path alone", facts: { ...UNSTARTED, statementConflicts: [] }, expect: { state: "ready", path: "rule", actions: ["merge"], reasons: [] } },
  { name: "a README or brand change keeps a clean PR off the rule", facts: { sensitive: ["changes the README"] }, expect: { state: "needs-decision", path: null, actions: [], reasons: ["changes the README"] } },
  { name: "an uncached diff keeps a clean PR off the rule", facts: { sensitive: null }, expect: { state: "needs-decision", path: null, actions: [], reasons: ["diff not checked for README or third-party links"] } },
  { name: "other label", facts: { label: "performance" }, expect: { state: "needs-decision", reasons: ["label performance"], actions: [] } },
  { name: "no settled label", facts: { label: null }, expect: { state: "needs-decision", reasons: ["no settled label"], actions: [] } },
  { name: "tier not on the whitelist", facts: { tier: "not" }, expect: { state: "needs-decision", reasons: ["author not on the whitelist"] } },
  { name: "unknown author", facts: { tier: "not", author: null }, expect: { state: "needs-decision", reasons: ["author unknown"] } },
  { name: "allow tier counts as whitelisted", facts: { ...UNSTARTED, tier: "allow" }, expect: { state: "ready", path: "rule" } },
  { name: "verification unavailable puts it outside the rule", facts: { verification: { state: "unavailable", summary: "the repo is private" } }, expect: { state: "needs-decision", reasons: ["not verified: the repo is private"], actions: [] } },
  { name: "no CI in the repo puts it outside the rule", facts: { ci: "none", repoFacts: { noCi: true } }, expect: { state: "needs-decision", reasons: ["the repo has no CI checks"] } },
  { name: "several reasons keep the queue's order", facts: { ...SIZE_L, label: "infra", tier: "not", review: { verdict: "take-fix" } }, expect: { state: "needs-fix-up", reasons: ["review asks for fixes", "size L", "author not on the whitelist"] } },

  // ---- an approved merge on its way to the hand-over
  { name: "a merge approved past the rule waits for its leg, not for an answer", facts: { ...SIZE_L, ci: "pending", operator: { fix: null, hold: true, premerge: false } }, expect: { state: "needs-decision", code: "leg", who: "system" } },
  { name: "before the workflow's next pass starts the leg too", facts: SIZE_L, expect: { state: "needs-decision", code: "leg", who: "system" } },
  { name: "a blocked workflow's approved merge waits for the answer", facts: { ...SIZE_L, may: { workflow: BLOCKED_GATE } }, expect: { state: "needs-decision", code: "answer", who: "person" } },
  { name: "a merge nobody approved waits for the answer", facts: { ...SIZE_L, workflow: { entry: "review", approved: false, startedBy: "maint", startedAt: "2026-11-04T09:00:00.000Z", own: true } }, expect: { state: "needs-decision", code: "answer", who: "person" } },
  { name: "a merge state that stays unknown is a person's, before the hand-over too", facts: { mergeable: "UNKNOWN", unknown: { since: "2026-11-04T02:00:00.000Z", reads: 6, rereads: 1, stuck: true } }, expect: { state: "needs-decision", code: "mergeable-stuck", who: "person" } },
  { name: "a merge entry aimed off the default branch waits on a person", facts: { workflow: MERGE_ENTRY, baseOffDefault: true }, expect: { code: "base-off-default", who: "person" } },
  { name: "signing in does not help a merge aimed off the default branch", facts: { ...SIZE_L, ...HANDED, mergeWaiting: true, baseOffDefault: true }, expect: { actions: [], code: "base-off-default", who: "person" } },

  // ---- a review that waits
  ...([
    ["its review failed for good", { kind: "failed", wait: "its review failed 4 times at this commit" }, "review-failed", "person"],
    ["its review is tried again later", { kind: "failed", wait: "the review after 1 failed try at this commit, from 12:05", until: NOW + 300_000 }, "review-failed", "system"],
    ["another item blocks it", { kind: "blocked", wait: "app#9, which blocks its review" }, "review-hold", "system"],
    ["the item that blocks it has an open question", { kind: "blocked", wait: "app#9, which blocks its review", person: true }, "review-hold", "person"],
    ["CI runs", { kind: "ci", wait: "CI on the latest commit to finish" }, "ci", "system"],
  ] as const).map(([name, reviewHold, code, who]): Row => ({ name: `a review waits: ${name}`, facts: { review: null, reviewHold }, expect: { actions: [], code, who } })),

  // ---- nothing to do and somebody to wait for
  { name: "a draft is not merged, also handed over", facts: { ...HANDED, draft: true }, expect: { state: "draft", actions: [], eligible: false, wait: "the pull request to be marked ready for review", code: "draft" } },
  { name: "an implementation PR whose issue's work was closed is not taken up", facts: { ...UNSTARTED, endedWorkflow: "closed" }, expect: { state: "not-started", actions: [] } },
  { name: "a stale review at its daily cap waits for tomorrow", facts: { review: { stale: true, staleActionable: false } }, expect: { state: "review-stale", actions: [], wait: "review cap for today reached; next on a maintainer's request or tomorrow", code: "review-cap" } },
  { name: "a review that asks for fixes and lists none waits for an answer", facts: { ...TAKE_FIX, fixup: fixup({ fixes: 0 }) }, expect: { actions: [], wait: "a maintainer's answer", code: "answer" } },
  { name: "a CI fix that could not push waits on a person", facts: { ...CI_FAIL, cifix: cifix({ states: ["push-denied"] }) }, expect: { actions: [], wait: "a person to fix CI: the CI fix could not push", code: "ci-fix-failed" } },
  { name: "a formatter run is waited for", facts: { ...CI_FAIL, cifix: cifix({ states: ["formatting"], formattingTask: 4, formatterEnded: false }) }, expect: { actions: [], wait: "the formatter or lint run of the CI fix", code: "ci-running" } },
  { name: "a conflict of a batch member waits for its batch", facts: { ...conflicting(), inActiveBatch: true }, expect: { actions: [], wait: "its batch", code: "batch" } },
  { name: "without merge approval the pre-merge review waits for it", facts: { ...UNSTARTED, premerge: null, may: { repoMerge: null } }, expect: { state: "waiting-premerge", actions: [], wait: "merge approval for the repo", code: "repo-approval" } },

  // ---- unsure heads and operator answers
  { name: "unsure head does not merge by rule", facts: { review: { unsure: true } }, expect: { state: "needs-decision", path: null, actions: [], reasons: [UNSURE_REASON] } },
  { name: "a handed-over merge waiting for its person's sign-in proposes no merge", facts: { ...SIZE_L, ...HANDED, mergeWaiting: true }, expect: { state: "decision-answered-merge", path: "operator", actions: [], wait: "the sign-in or access of the person who approved the merge", code: "sign-in" } },
  { name: "the same merge runs once the sign-in arrived", facts: { ...SIZE_L, ...HANDED }, expect: { state: "decision-answered-merge", path: "operator", actions: ["merge"] } },
  { name: "unsure head, handed over, merges as its approver", facts: { review: { unsure: true }, ...HANDED }, expect: { state: "decision-answered-merge", path: "operator", actions: ["merge"], reasons: [UNSURE_REASON] } },
  { name: "a handed-over large PR merges as its approver", facts: { ...SIZE_L, ...HANDED }, expect: { state: "decision-answered-merge", path: "operator", actions: ["merge"], eligible: true } },
  { name: "a hand-over does not merge without CI", facts: { ...SIZE_L, ci: "none", repoFacts: { noCi: true }, ...HANDED }, expect: { state: "needs-decision", actions: [], eligible: false, reasons: ["size L", "the repo has no CI checks"] } },
  { name: "a handed-over PR of an unverifiable repo merges", facts: { verification: { state: "unavailable", summary: "x" }, ...HANDED }, expect: { state: "decision-answered-merge", actions: ["merge"] } },

  // ---- order of the state rules
  { name: "conflicting PR", facts: { ...UNSTARTED, mergeable: "CONFLICTING", conflict: { bucket: "merge", base: "main", baseOk: true } }, expect: { state: "conflict", path: "rule", actions: ["conflict:merge"], note: null, conflictNote: "conflict: merging main" } },
  { name: "failed CI", facts: { ci: "failure" }, expect: { state: "ci-failed", actions: [] } },
  { name: "conflict outranks failed CI", facts: { ci: "failure", mergeable: "CONFLICTING" }, expect: { state: "conflict" } },
  { name: "failed CI on a PR outside the rule", facts: { ...SIZE_L, ci: "failure" }, expect: { state: "ci-failed", actions: [] } },
  { name: "runs waiting for approval", facts: { runs: runs({ waiting: 2 }) }, expect: { state: "ci-approval", actions: ["approve-ci"] } },
  { name: "CI pending", facts: { ci: "pending" }, expect: { state: "waiting-ci", actions: [] } },
  { name: "mergeable not computed yet", facts: { mergeable: "UNKNOWN" }, expect: { state: "waiting-ci", actions: [] } },
  { name: "checks of another head: CI unknown", facts: { ci: "unknown", checksHere: false }, expect: { state: "waiting-ci" } },
  { name: "no verification yet", facts: { ...UNSTARTED, verification: null }, expect: { state: "waiting-verify", path: "rule", actions: ["verify:plan"] } },
  { name: "stale verification is verified again", facts: { verification: { state: "stale" } }, expect: { state: "waiting-verify", actions: ["verify:plan"] } },
  { name: "failed verification", facts: { verification: { state: "failed", summary: "tests fail" } }, expect: { state: "needs-decision", actions: [] } },
  { name: "verification error", facts: { verification: { state: "error", summary: "no build" } }, expect: { state: "needs-decision", actions: [] } },
  { name: "an approval given after the failed verification merges over it", facts: { ...HANDED, verification: { state: "failed", summary: "tests fail" }, verifyOverride: true }, expect: { state: "decision-answered-merge", actions: ["merge"] } },
  { name: "an approval given before the failed verification does not", facts: { ...HANDED, verification: { state: "failed", summary: "tests fail" } }, expect: { state: "verify-failed", actions: [] } },
  { name: "CI is enough counts as verified", facts: { ...UNSTARTED, verification: { state: "ci-enough" } }, expect: { state: "ready", actions: ["merge"] } },
  { name: "outside the rule, not verified yet: no question before the result", facts: { ...SIZE_L, verification: null }, expect: { state: "waiting-verify", actions: ["verify:plan"] } },
  { name: "unavailable repo is Verify's second bucket", facts: { verification: null, verifyUnavailable: "the repo is private" }, expect: { state: "waiting-verify", actions: ["verify:unavailable"] } },

  // ---- pre-merge review
  { name: "no pre-merge review yet", facts: { ...UNSTARTED, premerge: null }, expect: { state: "waiting-premerge", path: "rule", actions: ["premerge"] } },
  { name: "no pre-merge review, merging not approved in the repo", facts: { ...UNSTARTED, premerge: null, may: { repoMerge: null } }, expect: { state: "waiting-premerge", actions: [] } },
  { name: "pre-merge review with an unverified claim goes to a person, not the rule", facts: { premerge: premerge({ unsure: true }) }, expect: { state: "needs-decision", reasons: [PREMERGE_UNSURE_REASON], actions: [] } },
  { name: "failed try waits for its backoff", facts: { premerge: premerge({ hasFindings: false, tries: 1, at: new Date(NOW - 600_000).toISOString() }) }, expect: { state: "waiting-premerge", actions: [] } },
  { name: "failed try is due after the backoff", facts: { premerge: premerge({ hasFindings: false, tries: 1, at: new Date(NOW - 3_700_000).toISOString() }) }, expect: { state: "waiting-premerge", actions: ["premerge"] } },
  { name: "after the quick tries the next one waits 6 hours", facts: { premerge: premerge({ hasFindings: false, tries: 3, at: new Date(NOW - 3_700_000).toISOString() }) }, expect: { state: "waiting-premerge", actions: [] } },
  { name: "a call without a reply uses no try and waits apart", facts: { premerge: premerge({ hasFindings: false, tries: 6, lost: 1, at: new Date(NOW - 700_000).toISOString() }) }, expect: { state: "waiting-premerge", actions: ["premerge"] } },
  { name: "seven failed tries: outside the rule", facts: { premerge: premerge({ hasFindings: false, tries: 7 }) }, expect: { state: "needs-decision", reasons: [PREMERGE_FAILED_REASON], actions: [] } },
  { name: "fixable defects go to fix-up", facts: { ...UNSTARTED, premerge: premerge({ defects: 2 }) }, expect: { state: "needs-fix-up", path: "rule", actions: ["fixup:premerge"], note: "pre-merge review: 2 defects to fix" } },
  { name: "one fixable defect is singular", facts: { premerge: premerge({ defects: 1 }) }, expect: { state: "needs-fix-up", note: "pre-merge review: 1 defect to fix" } },
  { name: "fix-up already used: defect", facts: { premerge: premerge({ defects: 1 }), premergeFixUsed: true }, expect: { state: "needs-decision", reasons: [PREMERGE_DEFECT_REASON] } },
  { name: "no push approval: defect", facts: { ...UNSTARTED, premerge: premerge({ defects: 1 }), may: { repoPush: null } }, expect: { state: "needs-decision", reasons: [PREMERGE_DEFECT_REASON] } },
  { name: "branch not pushable: defect", facts: { premerge: premerge({ defects: 1 }), pushable: false }, expect: { state: "needs-decision", reasons: [PREMERGE_DEFECT_REASON] } },
  { name: "minor findings do not block", facts: { ...UNSTARTED, premerge: premerge({ minor: 3 }) }, expect: { state: "ready", actions: ["merge"] } },
  { name: "a PR outside the rule skips the pre-merge review", facts: { ...SIZE_L, premerge: null }, expect: { state: "needs-decision", actions: [] } },

  // ---- merge, refusal, holds, batches, main CI
  { name: "refused PR with changed CI is retried", facts: { ...UNSTARTED, lastMerge: { outcome: "refused", reason: "x", ci: "pending", mergeable: "MERGEABLE" } }, expect: { state: "refused", path: "rule", actions: ["merge"], eligible: true } },
  { name: "refused PR in the same state waits, on every path", facts: { ...UNSTARTED, lastMerge: { outcome: "refused", reason: "not ready at merge time: CI pending", ci: "success", mergeable: "MERGEABLE" } }, expect: { state: "refused", actions: [], eligible: true } },
  { name: "refused PR waits also when it merges alone", facts: { verification: { state: "unavailable", summary: "s" }, ...HANDED, lastMerge: { outcome: "refused", reason: "x", ci: "success", mergeable: "MERGEABLE" } }, expect: { state: "refused", actions: [] } },
  { name: "refusal without a recorded CI state waits", facts: { lastMerge: { outcome: "refused", reason: "not ready at merge time: CI pending", ci: null, mergeable: null } }, expect: { state: "refused", actions: [] } },
  { name: "approved runs after a refusal release it", facts: { ...UNSTARTED, lastMerge: { outcome: "refused", reason: "x", ci: "success", mergeable: "MERGEABLE" }, runsApprovedAfterMerge: true }, expect: { state: "refused", actions: ["merge"] } },
  { name: "batch state replaces ready", facts: { batch: "in-batch" }, expect: { state: "in-batch", actions: [], code: "batch", who: "system" } },
  { name: "batch state replaces waiting-ci", facts: { batch: "batch-checking", ci: "pending" }, expect: { state: "batch-checking" } },
  { name: "a failed batch waits on a person", facts: { ...HANDED, batch: "batch-failed" }, expect: { state: "batch-failed", actions: [], code: "batch-failed", who: "person" } },
  { name: "a failed batch, verification or merge is the leg's to carry on until it hands the merge over", facts: { batch: "batch-failed" }, expect: { state: "batch-failed", actions: [], code: "leg", who: "system" } },
  { name: "batch does not take a rule PR without a clean pre-merge review", facts: { batch: "in-batch", premerge: null }, expect: { state: "waiting-premerge" } },
  { name: "batch takes a handed-over PR", facts: { ...SIZE_L, ...HANDED, batch: "in-batch", premerge: null }, expect: { state: "in-batch" } },
  { name: "red main holds a ready PR", facts: { repoFacts: { mainRed: true } }, expect: { state: "waiting-main-ci", actions: [] } },
  { name: "red main does not hold the PR that fixes it", facts: { ...UNSTARTED, repoFacts: { mainRed: true }, mainFix: true }, expect: { state: "ready", actions: ["merge"] } },
  { name: "batch members keep the batch state while main is red", facts: { repoFacts: { mainRed: true }, batch: "in-batch" }, expect: { state: "in-batch" } },
  { name: "main fix merges alone", facts: { ...UNSTARTED, mainFix: true }, expect: { state: "ready", actions: ["merge"] } },

  // ---- changes requested, held, merged
  { name: "changes requested blocks a ready PR", facts: { changesRequested: { why: "changes requested by a maintainer (ana)", live: true } }, expect: { state: "changes-requested", path: null, actions: [], note: "changes requested by a maintainer (ana)" } },
  { name: "changes requested blocks a hand-over", facts: { ...SIZE_L, ...HANDED, changesRequested: { why: "w", live: false } }, expect: { state: "changes-requested", actions: [] } },
  { name: "changes requested blocks the question", facts: { ...SIZE_L, changesRequested: { why: "w", live: false } }, expect: { state: "changes-requested", actions: [] } },
  { name: "failed review reads give a note", facts: { gateFailureNote: "reviews could not be read from GitHub 3 times in a row", ...SIZE_L }, expect: { state: "needs-decision", note: "reviews could not be read from GitHub 3 times in a row" } },
  { name: "backlog hold wins over the rule", facts: { heldBacklog: true }, expect: { state: "held-backlog", actions: [] } },
  { name: "merged PR", facts: { ghState: "MERGED" }, expect: { state: "merged", actions: [] } },
  { name: "PR merged by us before the mirror noticed", facts: { lastMerge: { outcome: "merged", reason: null, ci: "success", mergeable: "MERGEABLE" } }, expect: { state: "merged", actions: [] } },

  // ---- open PRs outside the queue
  { name: "not reviewed yet", facts: { review: null }, expect: { state: "not-reviewed", path: null, actions: ["review"] } },
  { name: "review at an older head", facts: { head: "h2" }, expect: { state: "review-stale", actions: ["review"] } },
  { name: "review made stale by the discussion", facts: { review: { stale: true, staleActionable: true } }, expect: { state: "review-stale", actions: ["review"] } },
  { name: "stale review at the daily re-review cap waits", facts: { review: { stale: true, staleActionable: false } }, expect: { state: "review-stale", actions: [] } },
  { name: "a stale take is never verified or merged", facts: { review: { stale: true, staleActionable: true }, verification: null }, expect: { state: "review-stale", actions: ["review"] } },
  { name: "draft without a review", facts: { review: null, draft: true }, expect: { state: "draft", actions: [] } },
  { name: "a draft with a take review does not merge: it waits to be ready for review", facts: { draft: true }, expect: { state: "draft", path: null, actions: [], eligible: false } },
  { name: "a draft that was handed over does not merge", facts: { ...HANDED, draft: true }, expect: { state: "draft", actions: [] } },
  { name: "Opus said hold", facts: { review: { verdict: "hold" } }, expect: { state: "opus-hold", actions: [] } },
  { name: "Opus said close", facts: { review: { verdict: "close" } }, expect: { state: "opus-close", actions: [] } },
  { name: "backlog without a review", facts: { review: null, heldBacklog: true }, expect: { state: "backlog", actions: [] } },
  { name: "outside the scope", facts: { inScope: false }, expect: { state: "out-of-scope", actions: [] } },
  { name: "integration PR with runs to read", facts: { integration: true, runs: runs({ reread: true }) }, expect: { state: "integration", actions: ["approve-ci"] } },
  { name: "integration PR of a repo out of scope", facts: { integration: true, inScope: false, runs: runs({ reread: true }) }, expect: { state: "out-of-scope", actions: [] } },
  { name: "runs wait at the reviewed head but the PR moved on: not approved", facts: { head: "h2", runs: runs() }, expect: { actions: ["review"] } },
  { name: "integration PR without runs", facts: { integration: true }, expect: { state: "integration", actions: [] } },

  // ---- other actions
  { name: "review not posted yet", facts: { ...UNSTARTED, post: { posted: null } }, expect: { state: "ready", actions: ["merge", "post-review"] } },
  { name: "newer review than the post is posted again", facts: { ...UNSTARTED, post: { posted: { head: "h1", at: "2026-11-04T09:00:00.000Z", opusAt: "2026-11-04T09:00:00.000Z" } } }, expect: { state: "ready", actions: ["merge", "post-review"] } },
  { name: "no public text, nothing posted", facts: { ...UNSTARTED, post: { postable: false, posted: null } }, expect: { state: "ready", actions: ["merge"] } },
  { name: "the pipeline's own PR gets no posted review", facts: { ...UNSTARTED, post: { posted: null }, authorIsPipeline: true }, expect: { state: "ready", actions: ["merge"] } },
  { name: "waiting runs of a fork PR are approved", facts: { runs: runs(), ci: "pending" }, expect: { state: "ci-approval", actions: ["approve-ci"], code: "ci-approval", who: "system" } },
  { name: "runs that failed twice are left to a person", facts: { runs: runs({ approvable: 0, blocked: "failed" }) }, expect: { state: "ci-approval", actions: [], code: "ci-approval-failed", who: "person" } },
  { name: "runs of a same-repo PR are not approved", facts: { runs: runs({ crossRepo: false, blocked: "unsupported" }) }, expect: { state: "ci-approval", actions: [], code: "ci-approval-failed", who: "person" } },
  { name: "runs wait for the repo's CI approval while it is off", facts: { runs: runs({ blocked: "off" }), repoFacts: { ciApproved: false } }, expect: { state: "ci-approval", code: "repo-approval", who: "person" } },
  { name: "checks of another head: nothing to approve", facts: { runs: runs(), checksHere: false, ci: "unknown" }, expect: { state: "ci-approval", actions: [] } },
  { name: "failing CI is not verified", facts: { ci: "failure", verification: null }, expect: { state: "ci-failed", actions: [] } },
  // ---- operator Hold and Close decline on the rule path too
  { name: "a handed-over rule PR still merges by the rule", facts: { ...HANDED }, expect: { state: "ready", path: "rule", actions: ["merge"] } },

  // ---- fix-up of a take-fix review
  { name: "fix-up: pushable branch with approval", facts: { ...TAKE_FIX, fixup: fixup() }, expect: { state: "needs-fix-up", actions: ["fixup:fix"] } },
  { name: "fix-up: no push approval waits", facts: { ...UNSTARTED, ...TAKE_FIX, fixup: fixup(), may: { repoPush: null } }, expect: { state: "needs-fix-up", actions: [] } },
  { name: "fix-up: branch not pushable, comments approved: ask", facts: { ...FIXUP_ONLY, ...TAKE_FIX, fixup: fixup(), pushable: false }, expect: { state: "needs-fix-up", actions: ["fixup:ask"] } },
  { name: "fix-up: branch not pushable, no comment approval: cannot-push row due", facts: { ...FIXUP_ONLY, ...TAKE_FIX, fixup: fixup(), pushable: false, repoFacts: { commentApproved: false } }, expect: { state: "needs-fix-up", actions: ["fixup:cannot-push"] } },
  { name: "fix-up: a PR approved for merge is not handed to its contributor", facts: { ...TAKE_FIX, fixup: fixup(), pushable: false }, expect: { state: "needs-fix-up", actions: [] } },
  { name: "fix-up: already asked at this head", facts: { ...TAKE_FIX, fixup: fixup({ recorded: ["asked"] }), pushable: false }, expect: { actions: [] } },
  { name: "fix-up: asked earlier but now pushable: pushed instead", facts: { ...TAKE_FIX, fixup: fixup({ recorded: ["asked"] }) }, expect: { actions: ["fixup:fix"] } },
  { name: "fix-up: pushed head is held", facts: { ...TAKE_FIX, fixup: fixup({ recorded: ["pushed"] }) }, expect: { actions: [] } },
  { name: "fix-up: recorded cannot-push becomes an ask once comments are approved", facts: { ...FIXUP_ONLY, ...TAKE_FIX, fixup: fixup({ recorded: ["cannot-push"] }), pushable: false }, expect: { actions: ["fixup:ask"] } },
  { name: "fix-up: recorded cannot-push without comment approval is final", facts: { ...TAKE_FIX, fixup: fixup({ recorded: ["cannot-push"] }), pushable: false, repoFacts: { commentApproved: false } }, expect: { actions: [] } },
  { name: "fix-up: too-large becomes an ask once comments are approved", facts: { ...FIXUP_ONLY, ...TAKE_FIX, fixup: fixup({ recorded: ["too-large"] }) }, expect: { actions: ["fixup:ask"] } },
  { name: "fix-up: too-large and asked is final", facts: { ...TAKE_FIX, fixup: fixup({ recorded: ["too-large", "asked"] }) }, expect: { actions: [] } },
  { name: "fix-up: too-large without comment approval is final", facts: { ...TAKE_FIX, fixup: fixup({ recorded: ["too-large"] }), repoFacts: { commentApproved: false } }, expect: { actions: [] } },
  { name: "a label settled by an unsure referee keeps a clean PR off the rule", facts: { labelUnsure: true }, expect: { state: "needs-decision", path: null, actions: [], reasons: ["label settled by an unsure referee"] } },
  { name: "fix-up: two tries used are followed by an ask", facts: { ...FIXUP_ONLY, ...TAKE_FIX, fixup: fixup({ attempts: 2 }) }, expect: { actions: ["fixup:ask"] } },
  { name: "fix-up: two tries used on a PR approved for merge go back to its approver", facts: { ...TAKE_FIX, fixup: fixup({ attempts: 2 }) }, expect: { actions: [] } },
  { name: "fix-up: two tries used and asked is final", facts: { ...TAKE_FIX, fixup: fixup({ attempts: 2, recorded: ["asked"] }) }, expect: { actions: [] } },
  { name: "fix-up: one try used, one left", facts: { ...TAKE_FIX, fixup: fixup({ attempts: 1 }) }, expect: { actions: ["fixup:fix"] } },
  { name: "fix-up: a review with no usable fixes", facts: { ...TAKE_FIX, fixup: fixup({ fixes: 0 }) }, expect: { actions: [] } },
  { name: "fix-up: conflicting PRs are not fixed up", facts: { ...TAKE_FIX, fixup: fixup(), mergeable: "CONFLICTING" }, expect: { actions: [] } },
  { name: "fix-up: a draft is not fixed up", facts: { ...TAKE_FIX, fixup: fixup(), draft: true }, expect: { actions: [] } },
  { name: "fix-up: review made stale waits for the new review", facts: { ...TAKE_FIX, fixup: fixup(), review: { stale: true, staleActionable: true } }, expect: { state: "review-stale", actions: ["review"] } },
  { name: "lint: a stored fix-up patch whose task ended is collected, and holds the fix-up meanwhile", facts: { ...TAKE_FIX, fixup: fixup({ recorded: ["linting"] }), lint: [{ step: "fixup", source: "review", ended: true }] }, expect: { actions: ["lint:fixup"] } },
  { name: "lint: a task still running is waited for", facts: { ...TAKE_FIX, fixup: fixup({ recorded: ["linting"] }), lint: [{ step: "fixup", source: "review", ended: false }] }, expect: { actions: [] } },
  { name: "lint: a stored patch is not pushed while a maintainer requested changes", facts: { ...TAKE_FIX, fixup: fixup({ recorded: ["linting"] }), lint: [{ step: "fixup", source: "review", ended: true }], changesRequested: { why: "w", live: false } }, expect: { state: "changes-requested", actions: [] } },
  { name: "lint: a patch a person asked for is pushed while a maintainer requested changes", facts: { lint: [{ step: "fixup", source: "operator", ended: true }], operator: { fix: { attempts: 0 }, hold: true, premerge: false }, changesRequested: { why: "w", live: false } }, expect: { state: "changes-requested", actions: ["lint:fixup"] } },
  { name: "lint: revoked push approval drops the stored patch's push", facts: { ...UNSTARTED, ...TAKE_FIX, fixup: fixup({ recorded: ["linting"] }), lint: [{ step: "fixup", source: "review", ended: true }], may: { repoPush: null } }, expect: { actions: [] } },
  { name: "lint: a stored CI fix patch whose task ended is collected", facts: { ...CI_FAIL, cifix: cifix({ states: ["linting"] }), lint: [{ step: "cifix", source: "review", ended: true }] }, expect: { actions: ["lint:cifix"] } },
  { name: "lint: a stored CI fix patch of our own breakage is collected at the pushed head", facts: { head: "pushed1", ci: "unknown", brokeByUs: true, cifix: cifix({ states: ["linting"] }), lint: [{ step: "cifix", source: "review", ended: true }] }, expect: { actions: ["lint:cifix", "review"] } },
  { name: "lint: a stored pre-merge patch is collected and the pre-merge fix-up waits", facts: { premerge: premerge({ defects: 1 }), lint: [{ step: "fixup", source: "premerge", ended: true }] }, expect: { state: "needs-fix-up", actions: ["lint:fixup"] } },
  { name: "pre-merge fix-up of a rule PR", facts: { premerge: premerge({ defects: 1 }) }, expect: { state: "needs-fix-up", actions: ["fixup:premerge"] } },
  { name: "pre-merge fix-up of an approved PR outside the rule comes before its verification, which runs once, at the head it merges", facts: { ...SIZE_L, ...IN_CI, premerge: premerge({ defects: 2 }), verification: null }, expect: { state: "needs-fix-up", path: null, actions: ["fixup:premerge"], note: "pre-merge review: 2 defects to fix" } },
  { name: "pre-merge fix-up of a merge entry", facts: { workflow: MERGE_ENTRY, premerge: premerge({ defects: 1 }) }, expect: { state: "needs-fix-up", actions: ["fixup:premerge"] } },
  { name: "pre-merge fix-up outside the rule: one round", facts: { ...SIZE_L, ...IN_CI, premerge: premerge({ defects: 1 }), premergeFixUsed: true }, expect: { state: "needs-decision", actions: [], reasons: ["size L"] } },
  { name: "pre-merge fix-up not once handed over", facts: { ...SIZE_L, ...HANDED, premerge: premerge({ defects: 1 }) }, expect: { state: "decision-answered-merge", actions: ["merge"] } },
  { name: "pre-merge fix-up not for a PR nobody approved", facts: { ...SIZE_L, ...IN_CI, workflow: { ...MERGE_ENTRY, entry: "review", approved: false }, premerge: premerge({ defects: 1 }) }, expect: { state: "needs-decision", actions: [] } },
  { name: "the pre-merge fix-up being pushed is waited for", facts: { ...SIZE_L, ...IN_CI, premerge: premerge({ defects: 1 }), premergeFixUsed: true, premergeFixRunning: true }, expect: { state: "needs-fix-up", actions: [], wait: "the review's fixes to be applied" } },
  { name: "pre-merge fix-up needs safe fix paths", facts: { premerge: premerge({ defects: 1, fixesSafe: false }) }, expect: { state: "needs-decision", actions: [], reasons: [PREMERGE_DEFECT_REASON], wait: "its pre-approved merge", code: "leg" } },
  { name: "pre-merge fix-up not for a conflicting PR", facts: { premerge: premerge({ defects: 1 }), mergeable: "CONFLICTING" }, expect: { state: "conflict", actions: [] } },


  // ---- conflicts
  { name: "conflict: merge the base branch", facts: conflicting(), expect: { state: "conflict", actions: ["conflict:merge"] } },
  { name: "conflict: ask the contributor", facts: conflicting({ bucket: "ask" }), expect: { state: "conflict", actions: ["conflict:ask"] } },
  { name: "conflict: a stored resolution is collected while the PR still conflicts, and waits for its lint task", facts: { ...conflicting({ bucket: "linting" }), lint: [{ step: "conflict", source: "review", ended: true }] }, expect: { state: "conflict", actions: ["lint:conflict"] } },
  { name: "conflict: a resolution whose lint task still runs is waited for", facts: { ...conflicting({ bucket: "linting" }), lint: [{ step: "conflict", source: "review", ended: false }] }, expect: { actions: [] } },
  { name: "conflict: already asked, held or unapproved", facts: conflicting({ bucket: "asked" }), expect: { actions: [] } },
  { name: "conflict: held bucket", facts: { ...FIXUP_ONLY, ...conflicting({ bucket: "held" }), repoFacts: { commentApproved: false } }, expect: { actions: [], wait: "comment approval for the repo", code: "repo-approval" } },
  { name: "conflict: asked waits on the contributor", facts: { ...FIXUP_ONLY, ...conflicting({ bucket: "asked" }) }, expect: { wait: "the contributor to resolve the conflict", code: "conflict-contributor" } },
  { name: "conflict: asked on a PR approved for merge waits on a person", facts: conflicting({ bucket: "asked" }), expect: { code: "conflict-person", who: "person" } },
  { name: "conflict: unapproved bucket", facts: conflicting({ bucket: "unapproved" }), expect: { actions: [] } },
  { name: "conflict: base branch name not allowed", facts: conflicting({ baseOk: false }), expect: { actions: [] } },
  { name: "conflict: no base merge while a maintainer requested changes", facts: { ...conflicting(), changesRequested: { why: "w", live: false } }, expect: { state: "changes-requested", actions: [], wait: "the maintainer's review" } },
  { name: "conflict: a stored resolution is not pushed while a maintainer requested changes", facts: { ...conflicting({ bucket: "linting" }), lint: [{ step: "conflict", source: "review", ended: true }], changesRequested: { why: "w", live: false } }, expect: { state: "changes-requested", actions: [], wait: "the maintainer's review" } },
  { name: "conflict: member of an active batch", facts: { ...conflicting(), inActiveBatch: true }, expect: { actions: [] } },
  { name: "conflict: stale review", facts: { ...conflicting(), review: { stale: true, staleActionable: true } }, expect: { state: "review-stale", actions: ["review"] } },
  { name: "conflict: take-fix PR also merges the base", facts: { ...conflicting(), ...TAKE_FIX, fixup: fixup() }, expect: { state: "needs-fix-up", actions: ["conflict:merge"] } },
  { name: "conflict: a draft is left alone", facts: { ...conflicting(), draft: true }, expect: { actions: [] } },
  { name: "conflict note is kept apart from the queue note", facts: conflicting(), expect: { state: "conflict", note: null } },

  // ---- CI fixes
  { name: "cifix: failing CI is worked on", facts: { ...CI_FAIL, cifix: cifix() }, expect: { state: "ci-failed", actions: ["cifix:work"] } },
  { name: "cifix: no push approval", facts: { ...UNSTARTED, ...CI_FAIL, cifix: cifix(), may: { repoPush: null } }, expect: { actions: [], wait: "push approval for the repo", code: "repo-approval" } },
  { name: "cifix: not pushable, comments approved: work (comment route)", facts: { ...CI_FAIL, cifix: cifix(), pushable: false }, expect: { actions: ["cifix:work"] } },
  { name: "cifix: not pushable, no comment approval", facts: { ...CI_FAIL, cifix: cifix(), pushable: false, repoFacts: { commentApproved: false } }, expect: { actions: [] } },
  { name: "cifix: formatter task running", facts: { ...CI_FAIL, cifix: cifix({ states: ["formatting"], formattingTask: 7, formatterEnded: false, tries: 1 }) }, expect: { actions: [] } },
  { name: "cifix: formatter task ended is collected", facts: { ...CI_FAIL, cifix: cifix({ states: ["formatting"], formattingTask: 7, formatterEnded: true, tries: 1 }) }, expect: { actions: ["cifix:collect"] } },
  { name: "cifix: PR at its push limit goes back to the person who approved the merge", facts: { ...CI_FAIL, cifix: cifix({ totalPushes: 2 }) }, expect: { actions: ["cifix:capped"], wait: "a person to look at the red CI", code: "ci-fix-failed" } },
  { name: "cifix: PR nobody approved for merge at its push limit asks the contributor", facts: { ...CI_FAIL, ...FIXUP_ONLY, cifix: cifix({ totalPushes: 2 }) }, expect: { actions: ["cifix:ask"], wait: "the contributor to fix CI", code: "ci-contributor" } },
  { name: "cifix: a quiet PR at its push limit asks nobody", facts: { ...CI_FAIL, cifix: cifix({ totalPushes: 2 }), quiet: true }, expect: { actions: ["cifix:capped"] } },
  { name: "cifix: a quiet PR with both tries used waits for a person", facts: { ...CI_FAIL, cifix: cifix({ tries: 2, states: ["failed", "failed"] }), quiet: true }, expect: { actions: [], wait: "a person to look at the red CI", code: "ci-fix-failed" } },
  { name: "cifix: a quiet PR whose branch is closed to us gets no patch as a comment", facts: { ...CI_FAIL, cifix: cifix(), pushable: false, quiet: true }, expect: { actions: [], wait: "a person to look at the red CI", code: "ci-fix-failed" } },
  { name: "cifix: PR at its push limit, no comment approval: a capped note", facts: { ...CI_FAIL, cifix: cifix({ totalPushes: 2 }), repoFacts: { commentApproved: false } }, expect: { actions: ["cifix:capped"] } },
  { name: "cifix: PR at its try limit", facts: { ...CI_FAIL, cifix: cifix({ totalTries: 4 }) }, expect: { actions: ["cifix:capped"] } },
  { name: "cifix: two tries at this head", facts: { ...CI_FAIL, cifix: cifix({ tries: 2, states: ["failed", "failed"] }) }, expect: { actions: [], wait: "a person to look at the red CI", code: "ci-fix-failed" } },
  { name: "cifix: two tries at this head of a PR nobody approved for merge", facts: { ...CI_FAIL, ...FIXUP_ONLY, cifix: cifix({ tries: 2, states: ["failed", "failed"] }) }, expect: { actions: ["cifix:ask"] } },
  { name: "cifix: the checks of the head still run", facts: { ...CI_FAIL, cifix: cifix({ running: true }) }, expect: { actions: [], code: "ci-running" } },
  { name: "cifix: two tries at this head, no comment approval: waits on approval", facts: { ...CI_FAIL, ...FIXUP_ONLY, cifix: cifix({ tries: 2, states: ["failed", "failed"] }), repoFacts: { commentApproved: false } }, expect: { actions: [], wait: "comment approval for the repo", code: "repo-approval" } },
  { name: "cifix: our own breakage is not asked", facts: { ...CI_FAIL, brokeByUs: true, cifix: cifix({ totalTries: 4 }) }, expect: { actions: ["cifix:capped"] } },
  { name: "cifix: asked at this head: waits on the contributor", facts: { ...CI_FAIL, ...FIXUP_ONLY, cifix: cifix({ tries: 2, states: ["failed", "failed", "asked"] }) }, expect: { actions: [], wait: "the contributor to fix CI", code: "ci-contributor" } },
  { name: "cifix: a contributor asked on a PR approved for merge: the approver is asked instead", facts: { ...CI_FAIL, cifix: cifix({ tries: 2, states: ["failed", "failed", "asked"] }) }, expect: { actions: [], wait: "a person to look at the red CI", code: "ci-fix-failed" } },
  { name: "cifix: infra failure is rerun once", facts: { ...CI_FAIL, cifix: cifix({ states: ["infra"], infraRuns: [11] }) }, expect: { actions: ["cifix:rerun"] } },
  { name: "cifix: rerun needs CI run approval in the repo", facts: { ...CI_FAIL, cifix: cifix({ states: ["infra"], infraRuns: [11] }), repoFacts: { ciApproved: false } }, expect: { actions: [] } },
  { name: "cifix: rerun done, checks not read since", facts: { ...CI_FAIL, cifix: cifix({ states: ["infra", "rerun"], infraRuns: [11], rerunAt: "2026-11-04T11:30:00.000Z" }) }, expect: { actions: [] } },
  { name: "cifix: rerun done, checks read after it: fix", facts: { ...CI_FAIL, cifix: cifix({ states: ["infra", "rerun"], infraRuns: [11], rerunAt: "2026-11-04T10:30:00.000Z" }) }, expect: { actions: ["cifix:work"] } },
  { name: "cifix: a push or comment at this head ends the work", facts: { ...CI_FAIL, cifix: cifix({ states: ["pushed"], tries: 1 }) }, expect: { actions: [] } },
  { name: "cifix: not while a maintainer requested changes", facts: { ...CI_FAIL, cifix: cifix(), changesRequested: { why: "w", live: false } }, expect: { state: "changes-requested", actions: [] } },
  { name: "cifix: a take-fix PR goes through the fix-up first", facts: { ...CI_FAIL, ...TAKE_FIX, fixup: fixup(), cifix: cifix() }, expect: { actions: ["fixup:fix"] } },
  { name: "cifix: a take-fix PR with its fix-up done is fixed", facts: { ...CI_FAIL, ...TAKE_FIX, fixup: fixup({ recorded: ["pushed"] }), cifix: cifix() }, expect: { actions: ["cifix:work"] } },
  { name: "cifix: not when CI passes", facts: { ...UNSTARTED, cifix: cifix() }, expect: { state: "ready", actions: ["merge"] } },

  // ---- our push broke the checks: the head is the pushed one, reviewed only at the head before
  { name: "broke: the CI fix works on the pushed head without a review of it", facts: { head: "pushed1", ci: "unknown", brokeByUs: true, cifix: cifix() }, expect: { actions: ["cifix:work", "review"] } },
  { name: "broke: a formatter result is collected the same way", facts: { head: "pushed1", ci: "unknown", brokeByUs: true, cifix: cifix({ states: ["formatting"], formattingTask: 7, formatterEnded: true, tries: 1 }) }, expect: { actions: ["cifix:collect", "review"] } },
  { name: "broke: without it, a pushed head waits for its review", facts: { head: "pushed1", ci: "unknown", cifix: cifix() }, expect: { actions: ["review"] } },

  // ---- a verdict carried over our own checked fix-up
  { name: "carried: a review recorded as carried at the head needs no review and the merge path continues", facts: { ...UNSTARTED, review: { verdict: "take" } }, expect: { state: "ready", path: "rule", actions: ["merge"] } },
  { name: "carried: a contributor commit after our fix-up leaves the reviewed head behind: review again", facts: { head: "contributor1", review: { verdict: "take" } }, expect: { actions: ["review"] } },

  // ---- post-merge review
  { name: "postmerge: merged by the pipeline, no review stored", facts: { ghState: "MERGED", postmerge: merged() }, expect: { state: "merged", actions: ["postmerge"] } },
  { name: "postmerge: merged as approved", facts: { ghState: "MERGED", postmerge: merged({ why: null }) }, expect: { state: "merged", actions: [] } },
  { name: "postmerge: merged outside the scope", facts: { ghState: "MERGED", inScope: false, postmerge: merged({ why: "push" }) }, expect: { state: "closed", actions: ["postmerge"] } },
  { name: "postmerge: merged before the cut-off", facts: { ghState: "MERGED", postmerge: merged({ since: "2026-11-04T10:00:00.000Z" }) }, expect: { state: "merged", actions: [] } },
  { name: "postmerge: review stored", facts: { ghState: "MERGED", postmerge: merged({ review: { at: "2026-11-04T09:30:00.000Z", error: null } }) }, expect: { actions: [] } },
  { name: "postmerge: failed review waits an hour", facts: { ghState: "MERGED", postmerge: merged({ review: { at: new Date(NOW - 600_000).toISOString(), error: "retry: no diff" } }) }, expect: { actions: [] } },
  { name: "postmerge: failed review is due after an hour", facts: { ghState: "MERGED", postmerge: merged({ review: { at: new Date(NOW - 3_700_000).toISOString(), error: "retry: no diff" } }) }, expect: { actions: ["postmerge"] } },
  { name: "postmerge: final error is not retried", facts: { ghState: "MERGED", postmerge: merged({ review: { at: new Date(NOW - 7_200_000).toISOString(), error: "too large" } }) }, expect: { actions: [] } },
  { name: "postmerge: outside the queue", facts: { ghState: "CLOSED", review: null, postmerge: merged() }, expect: { state: "closed", actions: ["postmerge"] } },
  { name: "postmerge: nothing for a closed PR the pipeline did not merge", facts: { ghState: "CLOSED", review: null }, expect: { state: "closed", actions: [] } },

  // ---- started, unstarted and merge-entry PRs
  { name: "an unstarted PR off the auto path plans no model work", facts: { ...UNSTARTED, review: null, label: "missing feature" }, expect: { state: "not-started", actions: [], wait: NOT_STARTED_WAIT, code: "not-started" } },
  { name: "an unstarted reviewed PR off the auto path is neither merged nor asked about", facts: { ...UNSTARTED, ...SIZE_L }, expect: { state: "not-started", actions: [] } },
  { name: "a stopped auto-eligible PR is left alone", facts: { ...UNSTARTED, endedWorkflow: "stopped" }, expect: { state: "not-started", actions: [] } },
  { name: "an auto-eligible PR is reviewed", facts: { ...UNSTARTED, review: null }, expect: { state: "not-reviewed", actions: ["review"] } },
  { name: "an auto-eligible PR whose diff the rule leaves to a person is not reviewed", facts: { ...UNSTARTED, review: null, ruledOut: ["changes the README"] }, expect: { state: "not-started", actions: [], wait: "changes the README; waits for a maintainer", code: "not-started" } },
  { name: "a started PR is reviewed whatever its diff holds", facts: { review: null, ruledOut: ["changes the README"] }, expect: { state: "not-reviewed", actions: ["review"] } },
  { name: "a reviewed auto-path PR whose diff the rule leaves to a person asks for an answer", facts: { ...UNSTARTED, sensitive: ["changes the README"], ruledOut: ["changes the README"] }, expect: { state: "needs-decision", actions: [] } },
  { name: "our push that broke CI on an auto-path PR is repaired, whatever its diff holds", facts: { ...UNSTARTED, head: "pushed1", ci: "unknown", brokeByUs: true, cifix: cifix(), reviewHold: { kind: "ci", wait: "CI", red: true }, ruledOut: ["changes the README"] }, expect: { actions: ["cifix:work"] } },
  { name: "an auto-eligible PR merges by rule", facts: UNSTARTED, expect: { state: "ready", path: "rule", actions: ["merge"], eligible: true } },
  { name: "merge entry is verified without a review", facts: { ...SIZE_L, workflow: MERGE_ENTRY, review: null, verification: null, premerge: null }, expect: { state: "waiting-verify", path: "maintainer", actions: ["verify:plan"] } },
  { name: "merge entry gets its pre-merge review, not an Opus review", facts: { ...SIZE_L, workflow: MERGE_ENTRY, review: null, premerge: null }, expect: { state: "waiting-premerge", path: "maintainer", actions: ["premerge"], eligible: false } },
];

test("broke: the CI fix comes first among the PR's actions", () => {
  const p = decidePr(prFacts({ head: "pushed1", ci: "unknown", brokeByUs: true, cifix: cifix() }));
  assert.equal(p.actions[0]?.kind, "cifix");
});

for (const row of rows) {
  test(row.name, () => {
    const p = decidePr(prFacts(row.facts));
    if (row.expect.state !== undefined) assert.equal(p.state, row.expect.state);
    if (row.expect.path !== undefined) assert.equal(p.path, row.expect.path);
    if (row.expect.actions) assert.deepEqual(tokens(p), [...row.expect.actions].sort());
    if (row.expect.reasons) assert.deepEqual(p.reasons, row.expect.reasons);
    if (row.expect.eligible !== undefined) assert.equal(p.eligible, row.expect.eligible);
    if (row.expect.note !== undefined) assert.equal(p.note, row.expect.note);
    if (row.expect.wait !== undefined) assert.equal(p.wait, row.expect.wait);
    if (row.expect.code !== undefined) assert.equal(p.waitCode, row.expect.code);
    if (row.expect.who !== undefined) assert.equal(p.waitKind, row.expect.who);
    if (row.expect.conflictNote !== undefined) assert.equal(p.conflictNote, row.expect.conflictNote);
  });
}

// ---- safety rules, checked over many fact sets

const merges = (f: PrFacts): boolean => decidePr(f).actions.some((a) => a.kind === "merge");

test("a rule PR without a clean pre-merge review never gets merge", () => {
  for (const pm of [null, premerge({ hasFindings: false, tries: 1 }), premerge({ hasFindings: false, tries: 3 }), premerge({ defects: 1 })]) {
    assert.equal(merges(prFacts({ ...UNSTARTED, premerge: pm })), false, JSON.stringify(pm));
  }
  assert.equal(merges(prFacts({ ...UNSTARTED, premerge: premerge({}) })), true);
});

test("an unsure head merges only on a hand-over", () => {
  assert.equal(merges(prFacts({ review: { unsure: true } })), false);
  assert.equal(merges(prFacts({ review: { unsure: true }, ...HANDED })), true);
});

test("without CI, and off the default branch, nothing merges and a person is asked, whoever approved it", () => {
  for (const [code, never] of [["no-ci", { ci: "none", repoFacts: { noCi: true } }], ["base-off-default", { baseOffDefault: true }]] as const) {
    for (const over of [UNSTARTED, {}, HANDED, { ...SIZE_L, ...HANDED }, { workflow: MERGE_ENTRY }, { workflow: MERGE_ENTRY, premerge: null }, { workflow: MERGE_ENTRY, ...HANDED }]) {
      const p = decidePr(prFacts({ ...over, ...never }));
      assert.deepEqual([p.state, p.path, p.eligible, p.actions.filter((a) => a.kind === "merge" || a.kind === "premerge"), p.waitKind, p.waitCode], ["needs-decision", null, false, [], "person", code], JSON.stringify({ ...over, ...never }));
    }
  }
});

test("changes requested blocks every action that moves the PR toward a merge", () => {
  for (const over of [{}, { ...SIZE_L, ...HANDED }, { ...SIZE_L }, { premerge: null }, { verification: null }, { runs: runs() }]) {
    const p = decidePr(prFacts({ ...over, changesRequested: { why: "w", live: false } }));
    assert.equal(p.state, "changes-requested");
    assert.deepEqual(p.actions.filter((a) => ["merge", "premerge"].includes(a.kind)), []);
  }
});

test("a PR in a batch keeps the batch state", () => {
  for (const batch of ["batch-checking", "in-batch", "batch-failed"] as const) {
    assert.equal(decidePr(prFacts({ batch })).state, batch);
    assert.equal(decidePr(prFacts({ batch, ci: "pending" })).state, batch);
    assert.equal(decidePr(prFacts({ batch, repoFacts: { mainRed: true } })).state, batch);
    assert.equal(merges(prFacts({ batch })), false);
  }
});

test("a PR in needs-fix-up with no action due names who it waits on", () => {
  const cases: Over[] = [
    { ...TAKE_FIX, fixup: fixup({ recorded: ["too-large", "asked"] }) },
    { ...TAKE_FIX, fixup: fixup({ recorded: ["too-large"] }), repoFacts: { commentApproved: false } },
    { ...TAKE_FIX, fixup: fixup({ attempts: 2, recorded: ["asked"] }) },
    { ...TAKE_FIX, fixup: fixup({ attempts: 2 }), repoFacts: { commentApproved: false } },
    { ...TAKE_FIX, fixup: fixup({ recorded: ["pushed"] }) },
    { ...UNSTARTED, ...TAKE_FIX, fixup: fixup(), may: { repoPush: null } },
    { ...TAKE_FIX, fixup: fixup(), mergeable: "CONFLICTING", conflict: { bucket: "held", base: "main", baseOk: true } },
  ];
  for (const over of cases) {
    const p = decidePr(prFacts(over));
    assert.equal(p.state, "needs-fix-up");
    assert.deepEqual(p.actions.filter((a) => a.kind !== "unassign"), []);
    assert.ok(p.wait, JSON.stringify(over));
  }
});

test("a PR our push moved off its mirrored head is left alone and stays assigned", () => {
  const stale = { ...TAKE_FIX, pushedOff: true } as const;
  const p = decidePr(prFacts(stale));
  assert.equal(p.state, "pushed");
  assert.deepEqual(p.actions, []);
  assert.ok(p.wait);
  assert.equal(decidePr(prFacts({ ...stale, pushedOff: false })).state, "needs-fix-up");
});

test("every plan state is one of the declared states", () => {
  const all = new Set<string>([...QUEUE_STATES, "out-of-scope", "integration", "pushed", "backlog", "draft", "opus-hold", "opus-close", "review-stale", "not-reviewed", "not-started", "closed"]);
  for (const row of rows) assert.ok(all.has(decidePr(prFacts(row.facts)).state), row.name);
  assert.equal(REVIEW_AT.length > 0, true);
});

test("a started PR nobody approved waits for a green main while main is red too; what its review asks for is a person's at once", () => {
  const started = { workflow: { entry: "review", approved: false, startedBy: "maint", startedAt: "2026-11-04T09:00:00.000Z", own: true } } as const;
  const red = { ...started, ...CI_FAIL, cifix: cifix(), repoFacts: { mainRed: true } };
  const wait = (o: Over) => { const p = decidePr(prFacts(o)); return [p.wait, p.waitKind]; };
  assert.deepEqual(wait(red), ["a green main", "system"]);
  for (const o of [{ ...red, repoFacts: { mainRed: false } }, { ...red, ...TAKE_FIX, fixup: fixup() }, { ...red, mainFix: true }]) assert.deepEqual(wait(o), [MAINTAINER_ANSWER_WAIT, "person"], JSON.stringify(o));
});
