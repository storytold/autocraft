// A stuck implementation is a workflow blocker (a step failing twice): the attempt moves to `stuck` with a `question` round
// that says why and what AutoCraft can do next: Try again (a new attempt; on our open PR, the same revision again) and Open as
// draft PR (only when the change passes the PR step's diff check). Try again is recommended when it is offered. A maintainer's
// answer is an `answer` round after it, which the next build job carries out (applyStuckAnswer); closing the issue or PR,
// stopping and the backlog are commands of their own. Three attempts per issue text version at most get Try again.
//
// A stop on a failure of AutoCraft's own (OWN) asks nobody at first: the attempt goes back to where its step starts again and
// runs after a backoff (start-retry.ts), and only the stop after the retries asks. Three implementations in a row on a repo
// that end stuck on the item's own cause, or failed without a PR, trip the repo's Implement breaker (`implement:<repo>`); a stop
// of our own neither counts nor breaks the row.
import type { Db } from "../db/index.ts";
import { addAudit, loadTrip, tripStage } from "../data/control/index.ts";
import { loadImplementFacts, loadStuckStreaks, restartAttempt, retryRevision } from "../data/implement/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { endWorkspace } from "../build/workspaces.ts";
import { tripKey } from "../core/push-outcome.ts";
import { textHash } from "../core/open-prs.ts";
import { queuerOf } from "./gate.ts";
import { addRounds, attemptNow, writeStep, type Attempt, type NewRound } from "./attempt.ts";
import { IMPLEMENT_RETRIES, ownRetries, ownRetryOf } from "./start-retry.ts";
import { IMPLEMENT_ASKER, openQuestion, type QuestionOption } from "./questions.ts";
import { ENDED_STATES, IMPLEMENTATION_STATES, type Implementation, type ImplementationRound, type ImplementationState, type QuestionRound, type RetryRound } from "./types.ts";

const ACTOR = IMPLEMENT_ASKER;
const OPEN_STATES = IMPLEMENTATION_STATES.filter((s) => !ENDED_STATES.has(s));

/** Why an implementation got stuck, and the line the blocker and the row's reason start with. */
export const STUCK_CAUSES = {
  "plan-unparseable": "The plan call's reply could not be read, twice",
  "plan-failed": "The plan call failed",
  "plan-flagged": "The plan still mentions or quotes the reference documentation",
  "question-failed": "The plan's questions could not be posted or asked",
  "reset-failed": "The workspace tree could not be reset after the plan",
  "session-failed": "The implementation session failed twice",
  "session-lost": "The Task Runner kept losing the session before the checks",
  "no-report": "The session did not reply with its report",
  blocked: "The session could not finish",
  "needs-dependency": "The change needs a dependency the workspace does not have",
  "checks-failing": "AutoCraft's checks still fail after three follow-up rounds",
  "checks-no-verdict": "AutoCraft's checks gave no verdict twice (timeout, killed or did not run)",
  "no-change": "The session finished without changing anything",
  "diff-refused": "The change touches what an implementation may not change",
  "push-failed": "Pushing the branch failed repeatedly",
  "workspace-lost": "The workspace could not be started again",
  "revision-limit": "The pull request went back to the session too many times",
} as const;
export type StuckCause = keyof typeof STUCK_CAUSES;

/**
 * Whose failure each stop is: `ours` when AutoCraft's own machinery failed (a model or Task Runner call, the workspace, the checks
 * harness, a push or a GitHub write), which a later run may get past by itself; `theirs` when the item's change or the session's
 * judgement stopped it, which needs a person.
 */
export const STUCK_SIDE = {
  "plan-unparseable": "ours", "plan-failed": "ours", "question-failed": "ours", "reset-failed": "ours", "session-failed": "ours",
  "session-lost": "ours", "no-report": "ours", "checks-no-verdict": "ours", "push-failed": "ours", "workspace-lost": "ours",
  "plan-flagged": "theirs", blocked: "theirs", "needs-dependency": "theirs", "checks-failing": "theirs", "no-change": "theirs",
  "diff-refused": "theirs", "revision-limit": "theirs",
} as const satisfies Record<StuckCause, "ours" | "theirs">;
export const OWN_CAUSES = (Object.keys(STUCK_SIDE) as StuckCause[]).filter((c) => STUCK_SIDE[c] === "ours");

/** Attempts per issue text version that may end stuck and still be offered Try again. */
export const MAX_ATTEMPTS_PER_TEXT = 3;
/** Implementations in a row on a repo that end stuck on the item's own cause, or failed without a PR, before the repo's Implement breaker trips. */
export const STUCK_IN_A_ROW = 3;

export const STUCK_OPTIONS = {
  tryAgain: { key: "try-again", label: "Try again", hint: "Plan and implement it again in a new attempt. Text you add goes to the model as guidance." },
  draft: { key: "draft-pr", label: "Open as draft PR", hint: "Open the change as it is as a draft pull request for a person to finish." },
  reviseAgain: { key: "try-again", label: "Try again", hint: "Send the pull request back to the session for the same revision. Text you add goes to the model as guidance." },
} as const satisfies Record<string, QuestionOption>;

/** The `question` round of a stuck attempt: the blocker's options, and why it stopped. */
/** `retried`: AutoCraft's own retries of the stop's kind before it asked (a stop of our own only). */
export type StuckQuestion = QuestionRound & { stuck: true; cause: StuckCause; facts: string[]; retried?: number };
export const isStuckQuestion = (r: ImplementationRound | null | undefined): boolean => r?.kind === "question" && (r.result as Partial<StuckQuestion> | null)?.stuck === true;

/**
 * Whether the attempt's change would pass the PR step's diff check (validateImplementation), so Open as draft PR can be offered.
 * The PR step provides it; without one the option is never offered.
 */
export type DiffCheck = (db: Db, impl: Implementation) => Promise<{ ok: boolean; reason?: string }>;
export const noDiffCheck: DiffCheck = async () => ({ ok: false, reason: "the diff check is not available" });

/** The hash of the issue's current title and body (or the attempt's when the issue is not in the mirror), and the attempts made on it. */
async function textTries(db: Db, impl: Implementation): Promise<{ hash: string; tries: number }> {
  const ref = `${impl.repo}#${impl.number}` as const;
  const [facts, items] = await db.together(() => Promise.all([loadImplementFacts(db, [impl]), loadItems(db, [impl], "text")]));
  const it = items.get(ref);
  const hash = it ? textHash(it.title ?? "", it.body ?? "") : impl.textHash;
  // The loader leaves out an only attempt that is not stuck yet: it is the one try.
  const counts = facts.byIssue.get(ref)?.textCounts ?? {};
  const tries = Object.keys(counts).length ? counts[hash] ?? 0 : impl.textHash === hash ? 1 : 0;
  return { hash, tries };
}

/** The blocker's question: the options that can be carried out for this attempt now, Try again recommended when offered. */
async function stuckQuestion(db: Db, impl: Implementation, cause: StuckCause, reason: string, diffCheck: DiffCheck, head?: string): Promise<StuckQuestion> {
  // A revision of our open PR is tried again on the same PR; the PR stays open, so there is no draft.
  const revising = impl.prNumber !== null;
  const { tries } = revising ? { tries: 0 } : await textTries(db, impl);
  const draft = revising || cause === "diff-refused" || cause === "no-change" ? { ok: false } : await diffCheck(db, impl);
  const options: QuestionOption[] = revising ? [STUCK_OPTIONS.reviseAgain] : [
    ...(tries < MAX_ATTEMPTS_PER_TEXT ? [STUCK_OPTIONS.tryAgain] : []),
    ...(draft.ok ? [STUCK_OPTIONS.draft] : []),
  ];
  const facts = revising ? [`revising pull request #${impl.prNumber}`, ...(impl.diffStat ? [`change: ${impl.diffStat}`] : [])] : [
    `attempt ${impl.attempt}; ${tries} of ${MAX_ATTEMPTS_PER_TEXT} on this issue text`,
    ...(impl.diffStat ? [`change: ${impl.diffStat}`] : []),
    ...(tries >= MAX_ATTEMPTS_PER_TEXT ? [`no Try again: ${MAX_ATTEMPTS_PER_TEXT} attempts were made on this issue text; editing the issue allows more`] : []),
  ];
  const text = `${head ? `${head}. ` : ""}The implementation is stuck: ${reason}.${impl.report?.summary ? ` The session's last report: ${impl.report.summary}` : ""}`.slice(0, 2000);
  return { audience: "maintainer", text, options, recommended: options.some((o) => o.key === STUCK_OPTIONS.tryAgain.key) ? STUCK_OPTIONS.tryAgain.key : null, stuck: true, cause, facts };
}

/**
 * How markStuck ended the attempt's step: the reason, AutoCraft's own retry when it goes on by itself instead of asking, and
 * whether the attempt had left its step meanwhile (a cancel, its PR merged), so nothing was written.
 */
export type StuckEnd = { reason: string; retry: { n: number; of: number; at: string } | null; left?: true };

/** The stop as a job's summary line: stuck, the retry AutoCraft makes itself, or an attempt that ended meanwhile. */
export const stuckLine = (cause: StuckCause, end: StuckEnd): string => (end.left
  ? `stopped (${cause}: ${end.reason}); the attempt left its step meanwhile, so nothing was recorded`
  : end.retry
  ? `stopped (${cause}: ${end.reason}); AutoCraft tries again at ${end.retry.at.slice(11, 16)} UTC (retry ${end.retry.n} of ${end.retry.of})`
  : `stuck (${cause}: ${end.reason})`);

/**
 * Where an attempt stopped by a failure of our own starts its step again, or null when it cannot (a revision that had not
 * started yet). Plan causes, and any stop before a plan is stored, plan again. Checks without a verdict run again, and a failed
 * push opens the PR again, on the same change; any other stop of the session starts it over from the plan in a new workspace,
 * whose `workspace` round ends the turns and checks of the stopped one. A revision in progress runs its checks or its push again
 * on the same change; after any other stop it starts over from a copy of its `revise` round on a tree reset to the change last
 * pushed (`reset`, which the revise job carries out before its first turn), without the session of the stopped turns.
 */
function restartOf(impl: Implementation, cause: StuckCause, rounds: readonly ImplementationRound[]): { to: ImplementationState; fresh: boolean; reset?: true; rounds: NewRound[] } | null {
  if (impl.prNumber !== null) {
    if (impl.state !== "revising") return null;
    if (cause === "checks-no-verdict" || cause === "push-failed") return { to: "revising", fresh: false, rounds: [] };
    const last = rounds.filter((r) => r.kind === "revise").at(-1);
    return last ? { to: "revising", fresh: false, reset: true, rounds: [{ kind: "revise", result: last.result }] } : null;
  }
  if (impl.state === "planning" || impl.state === "asked" || !impl.plan || ["plan-unparseable", "plan-failed", "question-failed", "reset-failed"].includes(cause)) return { to: "planning", fresh: false, rounds: [] };
  if (cause === "checks-no-verdict" && impl.state === "checking") return { to: "checking", fresh: false, rounds: [] };
  if (cause === "push-failed" && impl.state === "opening") return { to: "opening", fresh: false, rounds: [] };
  return { to: "planned", fresh: true, rounds: [] };
}

/**
 * A stop of our own with retries left: the attempt goes back to where its step starts again with a `retry` round, and its bucket
 * runs after the backoff (start-retry.ts). Otherwise the stop asks: the retries are used up (`retried` says how many were made), or
 * the step cannot start again.
 */
async function retryOwn(db: Db, impl: Implementation, cause: StuckCause, reason: string, runner: boolean, at: string): Promise<NonNullable<StuckEnd["retry"]> | "left" | { retried: number }> {
  const rounds = (await attemptNow(db, impl))?.rounds ?? [];
  const retried = ownRetries(rounds, runner);
  const restart = retried < IMPLEMENT_RETRIES ? restartOf(impl, cause, rounds) : null;
  if (!restart) return { retried };
  const retry: RetryRound = { cause, detail: reason, runner, from: impl.state, to: restart.to, ...(restart.reset && { reset: true }) };
  const w = await db.write(async () => {
    // A fresh start keeps the attempt's workspace id: the build makes the ended workspace again in the same environment.
    const w = await writeStep(db, impl, {
      to: restart.to, expect: OPEN_STATES, at,
      ...((restart.fresh || restart.reset) && { patch: { sessionCallId: null } }),
      rounds: [{ kind: "retry", result: retry }, ...restart.rounds],
    });
    if (w) await addAudit(db, [{ login: ACTOR, action: "implement-self-retry", target: `${impl.repo}#${impl.number}`, details: { implementation: impl.id, cause, reason, runner, to: restart.to }, at }]);
    return w;
  });
  // An attempt that ended meanwhile (a cancel, its PR merged) keeps its end.
  if (!w) return "left";
  if (restart.fresh && impl.workspaceId !== null) await endWorkspace(db, impl.workspaceId);
  const due = ownRetryOf([...rounds, { kind: "retry", at, result: retry }])!;
  return { n: due.n, of: IMPLEMENT_RETRIES, at: new Date(due.dueAt).toISOString() };
}

/**
 * Ends the attempt's step on a stop. A stop of our own (OWN) with retries left goes on by itself after a backoff; any other moves
 * the attempt to `stuck` with its blocker question, records it, and, for a stop on the item's own cause, checks the repo's breaker.
 * `runner` says a Task Runner lost the call, which is counted apart from other failures of ours. `retry: false` asks at once: a
 * stop of our own that a later run cannot get past (the base commit gone, our PR closed, a refused write).
 */
export async function markStuck(db: Db, impl: Implementation, cause: StuckCause, detail: string | null, o: { diffCheck?: DiffCheck; at?: string; runner?: boolean; retry?: boolean } = {}): Promise<StuckEnd> {
  const at = o.at ?? new Date().toISOString();
  const reason = `${STUCK_CAUSES[cause]}${detail ? `: ${detail}` : ""}`.replace(/\s+/g, " ").slice(0, 300);
  const ours = STUCK_SIDE[cause] === "ours";
  let head: string | undefined, retried = 0;
  if (ours && o.retry !== false) {
    const retry = await retryOwn(db, impl, cause, reason, o.runner ?? cause === "session-lost", at);
    if (retry === "left") return { reason, retry: null, left: true };
    if ("n" in retry) return { reason, retry };
    retried = retry.retried;
    if (retried) head = `AutoCraft tried again ${retried} ${retried === 1 ? "time" : "times"} on its own`;
  }
  const q: StuckQuestion = { ...await stuckQuestion(db, impl, cause, reason, o.diffCheck ?? noDiffCheck, head), ...(ours && { retried }) };
  const moved = await db.write(async () => {
    // An attempt that ended meanwhile (a cancel, its PR merged) keeps its end.
    if (!await writeStep(db, impl, { to: "stuck", patch: { reason }, expect: OPEN_STATES, rounds: [{ kind: "question", result: q }], at })) return false;
    await addAudit(db, [{ login: ACTOR, action: "implement-stuck", target: `${impl.repo}#${impl.number}`, details: { implementation: impl.id, cause, reason }, at }]);
    return true;
  });
  if (moved && !ours) await tripIfStuckInARow(db, impl.repo, at);
  if (moved && ours && retried >= IMPLEMENT_RETRIES) await tripIfOwnInARow(db, impl.repo, at);
  return moved ? { reason, retry: null } : { reason, retry: null, left: true };
}

/**
 * Trips `implement:<repo>` when the repo's last STUCK_IN_A_ROW finished implementations since its last resume all ended stuck or
 * failed without a PR. One whose last stop was of our own (OWN) is left out of the row.
 */
export async function tripIfStuckInARow(db: Db, repo: string, at = new Date().toISOString()): Promise<boolean> {
  const key = tripKey("implement", repo);
  const t = await loadTrip(db, key);
  if (t?.active) return false;
  const rows = (await loadStuckStreaks(db, new Map([[repo, t?.clearedAt ?? ""]]), STUCK_IN_A_ROW, OWN_CAUSES)).get(repo) ?? [];
  if (rows.length < STUCK_IN_A_ROW || rows.some((r) => r.prNumber !== null)) return false;
  const tripped = await tripStage(db, [{ key, reason: `${STUCK_IN_A_ROW} implementations in a row in ${repo} ended stuck or failed without a PR`, evidence: rows.map((r) => `${repo}#${r.number} attempt ${r.attempt}`), at }]);
  return tripped.length > 0;
}

/**
 * Trips `implement:<repo>` when the repo's last STUCK_IN_A_ROW finished implementations since its last resume all stopped on a
 * failure of our own after using up their own retries: AutoCraft's own machinery is broken on the repo, and every further
 * attempt would run its sessions for nothing. A stop on the item's own cause is left out of this row; a PR breaks it.
 */
export async function tripIfOwnInARow(db: Db, repo: string, at = new Date().toISOString()): Promise<boolean> {
  const key = tripKey("implement", repo);
  const t = await loadTrip(db, key);
  if (t?.active) return false;
  const theirs = (Object.keys(STUCK_SIDE) as StuckCause[]).filter((c) => STUCK_SIDE[c] === "theirs");
  const rows = (await loadStuckStreaks(db, new Map([[repo, t?.clearedAt ?? ""]]), STUCK_IN_A_ROW, theirs)).get(repo) ?? [];
  const usedUp = (r: (typeof rows)[number]) => r.prNumber === null && r.stuck !== null && STUCK_SIDE[r.stuck.cause as StuckCause] === "ours" && (r.stuck.retried ?? 0) >= IMPLEMENT_RETRIES;
  if (rows.length < STUCK_IN_A_ROW || !rows.every(usedUp)) return false;
  const tripped = await tripStage(db, [{ key, reason: `${STUCK_IN_A_ROW} implementations in a row in ${repo} stopped on failures of AutoCraft's own after their retries`, evidence: rows.map((r) => `${repo}#${r.number} attempt ${r.attempt}: ${r.stuck!.cause}`), at }]);
  return tripped.length > 0;
}

/** A Try again note for the attempt: who answered, when, and the text. */
export type AttemptGuidance = { by: string | null; at: string; text: string };

/** The guidance people gave the attempt (Try again notes) with who gave it, oldest first. */
export function attemptGuidance(rounds: readonly ImplementationRound[]): AttemptGuidance[] {
  return rounds.filter((r) => r.kind === "guidance").flatMap((r) => {
    const g = r.result as { text?: unknown; by?: unknown } | null;
    return typeof g?.text === "string" && g.text.trim() ? [{ by: typeof g.by === "string" ? g.by : null, at: r.at, text: g.text.trim() }] : [];
  });
}

/** The PR step opens the attempt's PR as a draft: its stuck blocker was answered Open as draft PR. */
export function opensAsDraft(rounds: readonly ImplementationRound[]): boolean {
  const { question, answer } = openQuestion(rounds);
  return isStuckQuestion(question) && answer?.option === STUCK_OPTIONS.draft.key;
}

export type StuckOutcome = { did: string; next: Implementation | null };

/**
 * Carries out the answer to a stuck attempt's blocker: Try again ends the attempt and starts a new one (the answer's words become
 * the new attempt's guidance), or sends our open PR's revision back to the session; Open as draft PR hands the attempt to the PR
 * step. An answer that cannot be carried out is asked again with the reason (a new question round, so the answer no longer
 * stands). Returns null when there is no answer to carry out.
 */
export async function applyStuckAnswer(db: Db, a: Attempt, o: { at?: string } = {}): Promise<StuckOutcome | null> {
  const at = o.at ?? new Date().toISOString();
  const impl = a.impl, ref = `${impl.repo}#${impl.number}`;
  if (impl.state !== "stuck") return null;
  const { question, answer } = openQuestion(a.rounds);
  if (!question || !isStuckQuestion(question) || !answer) return null;
  const q = question.result as StuckQuestion;
  const offered = (key: string) => (q.options ?? []).some((x) => x.key === key);
  const note = answer.text?.trim();
  const guidance = note ? { by: answer.by, text: note } : undefined;
  const again = async (why: string): Promise<StuckOutcome> => {
    const next = await stuckQuestion(db, impl, q.cause, impl.reason ?? STUCK_CAUSES[q.cause], noDiffCheck, `Not carried out: ${why}`.replace(/\s+/g, " ").slice(0, 400));
    // Open as draft PR stays offered when it was: the diff check that allowed it ran on the same change.
    const keep = offered(STUCK_OPTIONS.draft.key) && !next.options!.some((x) => x.key === STUCK_OPTIONS.draft.key) ? [...next.options!, STUCK_OPTIONS.draft] : next.options!;
    await db.write(async () => {
      await addRounds(db, impl.id, [{ kind: "question", result: { ...next, options: keep } satisfies StuckQuestion }], at);
      await addAudit(db, [{ login: ACTOR, action: "implement-reask", target: ref, details: { implementation: impl.id, answer: answer.option ?? null, by: answer.by, why }, at }]);
    });
    return { did: `not carried out (${why}); asked again`, next: null };
  };
  if (answer.option === STUCK_OPTIONS.tryAgain.key && offered(answer.option) && impl.prNumber !== null) {
    const ok = await db.write(async () => {
      if (!await retryRevision(db, { id: impl.id, guidance, at })) return false;
      await addAudit(db, [{ login: ACTOR, action: "implement-retry", target: ref, details: { from: impl.id, to: impl.id, pr: impl.prNumber, by: answer.by }, at }]);
      return true;
    });
    return ok ? { did: `revision of #${impl.prNumber} started again`, next: null } : await again("the attempt has no revision to try again");
  }
  if (answer.option === STUCK_OPTIONS.tryAgain.key && offered(answer.option)) {
    const { hash, tries } = await textTries(db, impl);
    if (tries >= MAX_ATTEMPTS_PER_TEXT) return await again(`${MAX_ATTEMPTS_PER_TEXT} attempts were made on this issue text, so Try again is not available; editing the issue allows more`);
    const queuedBy = await queuerOf(db, impl.repo, impl.number) ?? impl.queuedBy;
    const next = await db.write(async () => {
      const n = await restartAttempt(db, { id: impl.id, reason: impl.reason ?? "stuck", queuedBy, textHash: hash, guidance, at });
      await addAudit(db, [{ login: ACTOR, action: "implement-retry", target: ref, details: { from: impl.id, to: n.id, by: answer.by }, at }]);
      return n;
    });
    return { did: `attempt ${next.attempt} started`, next };
  }
  if (answer.option === STUCK_OPTIONS.draft.key && offered(answer.option)) {
    if (!await writeStep(db, impl, { to: "opening", expect: ["stuck"], at })) return { did: "left stuck meanwhile", next: null };
    return { did: "handed to the PR step as a draft", next: null };
  }
  return await again(answer.option ? `${answer.option} is not one of its options` : "the answer names none of its options");
}
