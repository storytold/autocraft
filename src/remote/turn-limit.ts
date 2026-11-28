// The retry of a call whose model used every turn without an answer: the same limit would most likely end it the same way.
import type { TaskBundle } from "./protocol.ts";

/** The harness's result subtype for a run that used every turn (Submit `subtype`, helpers from 1.4.3). */
export const TURN_LIMIT_SUBTYPE = "error_max_turns";

/**
 * The bundle a call stopped at its turn limit goes back to the queue with: twice its turns, in `maxTurns` and in the `claude`
 * hints' `--max-turns` (which the helper runs as given), and twice the task budget it had (its own, else `promptBudget`, the
 * prompt's budget with tools), so the budget does not cut the longer run instead. Null for a call without a turn limit.
 */
export function moreTurns(b: Omit<TaskBundle, "callId">, promptBudget: number | undefined): Omit<TaskBundle, "callId"> | null {
  if (typeof b.maxTurns !== "number" || !(b.maxTurns > 0)) return null;
  const maxTurns = b.maxTurns * 2;
  const budget = b.taskBudget ?? promptBudget;
  const claude = b.hints.claude;
  const i = claude ? claude.args.indexOf("--max-turns") : -1;
  const args = claude && i >= 0 ? claude.args.map((a, j) => (j === i + 1 ? String(maxTurns) : a)) : claude?.args;
  return { ...b, maxTurns, ...(budget !== undefined && { taskBudget: budget * 2 }), hints: { ...b.hints, ...(claude && args && { claude: { ...claude, args } }) } };
}
