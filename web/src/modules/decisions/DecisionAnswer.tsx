// Answering stays in the native item form so prepared cores, extra actions, public text,
// confirmation and the existing Undo path cannot be bypassed from the queue.
import type { Decision, User } from "../../api/types.ts";
import { Button } from "../../ui/atoms/Button.tsx";
import { canActOn } from "./access.ts";

interface ReviewFacts {
  user: User;
  scopeKey: string;
  requestedIdentity: string;
  row: Decision | undefined;
  loading: boolean;
  error: string | undefined;
}

export interface AnswerFacts extends ReviewFacts {
  /** Re-read the live URL, reader and guarded row at the explicit handoff boundary. */
  readCurrentFacts: () => ReviewFacts & { coherent: boolean };
}

export function DecisionAnswer({ facts, onReview }: { facts: AnswerFacts; onReview: () => void }) {
  const { row, user } = facts;
  if (!row || row.answer) return null;
  const settling = !!row.preparing || !!row.queued || !!row.settling;
  const canReview = canActOn(user, [row]) && !settling;
  const unavailable = facts.loading || !!facts.error;
  const review = () => {
    // A stale queue must not claim or open a different reader's, scope's or selection's item.
    const live = facts.readCurrentFacts();
    if (!live.coherent || live.loading || live.error || live.row?.id !== row.id) return;
    if (live.scopeKey !== facts.scopeKey || live.requestedIdentity !== facts.requestedIdentity) return;
    if (live.user.login !== user.login || live.user.role !== user.role) return;
    // A rendered Review action cannot survive revoked permissions or a newly busy/answered decision.
    if (canReview && (!canActOn(live.user, [live.row]) || live.row.answer || live.row.preparing || live.row.queued || live.row.settling)) return;
    onReview();
  };
  return <section aria-label="Answer" className="mt-6 rounded-md border border-line-strong bg-raised px-4 py-3">
    <h3 className="text-sm font-semibold">Answer</h3>
    <Button variant={canReview ? "primary" : "secondary"} className="mt-3 max-[860px]:min-h-11" disabled={unavailable} onClick={review}>
      {canReview ? "Review and answer" : "Open"}
    </Button>
    {settling && <p className="mt-2 text-sm text-ink/55">This decision is being prepared or settled; answering is not available yet.</p>}
  </section>;
}
