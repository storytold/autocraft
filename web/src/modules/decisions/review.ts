// One explicit handoff to the native item form. A claim is presence only and must never block navigation.
import type { Decision, User } from "../../api/types.ts";
import { decisionPath } from "../../lib/links.ts";
import { canComment } from "../../registry/roles.ts";

export function reviewDecision(d: Decision, user: User, claim: (id: string) => Promise<unknown>, navigate: (to: string) => void): void {
  if (!d.answer && canComment(user)) void claim(d.id).catch(() => undefined);
  navigate(decisionPath(d));
}
