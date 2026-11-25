// One explicit handoff to the native item form. A claim is presence only and must never block navigation.
import type { Decision, User } from "../../api/types.ts";
import { decisionPath, fromState } from "../../lib/links.ts";
import { canComment } from "../../registry/roles.ts";

/** `queueUrl` is the Needs you URL the item page's back link returns to; `rows` the loaded queue it steps through. */
export function reviewDecision(d: Decision, user: User, claim: (id: string) => Promise<unknown>, navigate: (to: string, options: { state: unknown }) => void, queueUrl: string, rows: Decision[]): void {
  if (!d.answer && canComment(user)) void claim(d.id).catch(() => undefined);
  navigate(decisionPath(d), { state: fromState(queueUrl, d, rows) });
}
