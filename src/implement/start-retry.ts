// AutoCraft's own retries of an implementation, for failures on our side that need no person's judgement.
//
// A workspace that did not start before the plan call (the environment set-up, a pod that did not come up): the attempt stays in
// `planning` with a `start-failed` round, and the plan bucket runs again after a failure backoff (the Implement stage's registry
// wait "Implementation start retry"). The failure after IMPLEMENT_START_RETRIES retries is a stop of our own (workspace-lost).
//
// A stop of our own (stuck.ts OWN: a failed or unreadable plan call, a lost session, no report, checks without a verdict, a failed
// push, a lost workspace): the attempt goes back to where the step starts again with a `retry` round, and its bucket runs after
// the registry wait "Implementation retry". Task Runner losses and other failures each get IMPLEMENT_RETRIES retries in a row;
// the next stop of that kind asks a maintainer. A person's answer or guidance starts the count again.
import { implementRetryDelayMs, implementStartDelayMs, IMPLEMENT_RETRIES, IMPLEMENT_START_RETRIES } from "../core/backoff.ts";
import type { ImplementationState, OwnRetry, RetryRound, RoundKind } from "../data/implement/types.ts";

export { IMPLEMENT_RETRIES, IMPLEMENT_START_RETRIES };

type R = { kind: RoundKind; at: string; result?: unknown };

/**
 * The rounds after the newest question, answer or guidance round, or a person's Try again (a `retry` round with `person`): what
 * AutoCraft did on its own since a person last spoke.
 */
const sincePerson = <T extends R>(rounds: readonly T[]): T[] => {
  let from = 0;
  rounds.forEach((r, i) => { if (r.kind === "question" || r.kind === "answer" || r.kind === "guidance" || (r.kind === "retry" && retryOf(r).person === true)) from = i + 1; });
  return rounds.slice(from);
};

/** The rounds after the newest `retry` round: the step as it ran again. */
export const sinceRetry = <T extends { kind: RoundKind }>(rounds: readonly T[]): T[] => rounds.slice(rounds.map((r) => r.kind).lastIndexOf("retry") + 1);

/** When the start failures in a row failed: the `start-failed` rounds after the newest question, answer, guidance or retry round. */
export function startFailureTimes(rounds: readonly R[]): string[] {
  return sinceRetry(sincePerson(rounds)).filter((r) => r.kind === "start-failed").map((r) => r.at);
}

/** The retry due for an attempt in `planning` after start failures: when the newest one's backoff ends. Null when none is due. */
export function startRetryOf(o: { state: ImplementationState; rounds: readonly R[] }): { failures: number; dueAt: number } | null {
  if (o.state !== "planning") return null;
  const times = startFailureTimes(o.rounds);
  if (!times.length || times.length > IMPLEMENT_START_RETRIES) return null;
  return { failures: times.length, dueAt: Date.parse(times.at(-1)!) + implementStartDelayMs(times.length) };
}

const retryOf = (r: R): Partial<RetryRound> => (r.result ?? {}) as Partial<RetryRound>;

/** Retries AutoCraft made itself since a person last spoke, of Task Runner losses (`runner`) or of every other failure. */
export const ownRetries = (rounds: readonly R[], runner: boolean): number => sincePerson(rounds).filter((r) => r.kind === "retry" && (retryOf(r).runner === true) === runner).length;

/** The newest retry since a person last spoke: its cause, its number in its count and when its backoff ends. Null when there is none. */
export function ownRetryOf(rounds: readonly R[]): OwnRetry | null {
  const own = sincePerson(rounds);
  const last = own.filter((r) => r.kind === "retry").at(-1);
  if (!last) return null;
  const x = retryOf(last);
  const n = own.filter((r) => r.kind === "retry" && (retryOf(r).runner === true) === (x.runner === true)).length;
  return { cause: typeof x.cause === "string" ? x.cause : "", n, dueAt: Date.parse(last.at) + implementRetryDelayMs(n) };
}
