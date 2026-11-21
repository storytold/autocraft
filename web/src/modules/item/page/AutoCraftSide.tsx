// The AutoCraft side: answer first, then one open history with its composer.
import { useEffect } from "react";
import { localActions, useLocal } from "../../decisions/state";
import { useQuery } from "../../../api/client";
import type { ItemPageData } from "../../../api/types";
import { useUser } from "../../../shell/UserContext";
import { canAct, canComment } from "../../../registry/permissions";
import { HeldAnswers } from "../../decisions/AnswerHold";
import { OpenQuestions, useItemDecisions } from "../ItemDecisions";
import { ActionCard } from "../OpusCards";
import { Composer } from "../Composer";
import { DisclosurePanel } from "../../../ui/molecules/DisclosurePanel";
import { ErrorLine } from "../../../ui/atoms/ErrorLine";
import { ItemEvidence } from "./ItemEvidence";
import { Story } from "./Story";

export function AutoCraftSide({ d, flash }: { d: ItemPageData; flash: string | null }) {
  const user = useUser();
  const { data: ds, error: decisionError } = useItemDecisions(d.repo, d.number);
  const { data: conv, error: conversationError } = useQuery(`conversation:${d.repo}#${d.number}`, (a) => a.conversations.get(d.repo, d.number), { pollMs: (x) => (x?.pending ? 4000 : false) });
  const choices = conv ? (conv.choices ?? null) : undefined;
  // A running pre-approved merge is the answer to the merge question: nobody is needed until it stops.
  const pre = d.header.preapproval;
  const settled = pre !== null && ["fixup", "review", "ci", "queued"].includes(pre.state);
  const open = (ds ?? []).filter((x) => !x.answer && !(settled && x.kind === "merge"));
  const item = `${d.repo}#${d.number}`;
  const updating = useLocal().updating[item];
  const opusTurns = conv?.turns.filter((t) => t.kind === "opus").length ?? 0;
  // The folded choices come back once Opus's reply (new choices, a reply without any, or a failure) is in.
  useEffect(() => {
    if (!updating || !conv || conv.pending) return;
    const failed = [...conv.turns].reverse().find((t) => t.kind === "operator")?.status === "failed";
    if (opusTurns > updating.opusTurns || conv.choices?.id !== updating.choicesId || failed) localActions.stopUpdating(item);
  }, [updating, conv, opusTurns, item]);
  // Only the newest Opus turn's cards are live: a card that leaves the question open is a suggested reply.
  const lastOpus = conv ? [...conv.turns].reverse().find((t) => t.kind === "opus") : undefined;
  const suggestions = lastOpus?.actions.filter((a) => a.settles === undefined && !a.fromChoice && ["proposed", "queued", "running", "failed"].includes(a.state) && a.canSettle) ?? [];
  const historyCount = d.timeline.length;
  return (
    <div className="space-y-5 px-4 md:space-y-6 md:px-8" data-task-body>
      <HeldAnswers ds={(ds ?? []).filter((x) => x.dispute || x.orphaned)} />
      <ErrorLine error={decisionError?.message} />
      {!ds && !decisionError && <p className="text-sm text-ink/50" role="status">Loading questions…</p>}
      <OpenQuestions ds={(ds ?? []).filter((x) => x.answer || open.includes(x))} choices={choices} updating={updating?.decisionId} evidence={<ItemEvidence d={d} />} />
      <HeldAnswers ds={(ds ?? []).filter((x) => !x.dispute && !x.orphaned)} />
      {ds && open.length === 0 && !decisionError && <p className="text-sm text-ink/60">No open question needs your answer right now.</p>}
      {!updating && suggestions.length > 0 && (
        <section className="space-y-3" aria-label="Suggested follow-up">
          {suggestions.map((a) => <ActionCard key={a.id} a={a} operator={canAct(user, [d.repo])} editInstructions={user.role === "operator"} className="" item={{ repo: d.repo, number: d.number }} />)}
        </section>
      )}
      {open.length === 0 && <DisclosurePanel title="Evidence" summary="Review, checks and related items"><ItemEvidence d={d} /></DisclosurePanel>}
      <DisclosurePanel title="History" summary={conv?.pending ? "Opus is replying" : `${historyCount} ${historyCount === 1 ? "event" : "events"}`} defaultOpen>
        <Story d={d} flash={flash} conv={conv} />
        <div className="px-4 pb-4 md:px-5">
          <ErrorLine error={conversationError?.message} />
          {conv && <Composer flush repo={d.repo} number={d.number} operator={user.role === "operator"} commenter={canComment(user)} exists={conv.exists} pending={conv.pending} feedbackOn={open.length === 1 ? open[0] : undefined} choices={choices} opusTurns={opusTurns} />}
        </div>
      </DisclosurePanel>
    </div>
  );
}
