// The Needs queue's row-external capabilities: one default-closed disclosure, mounted only when the
// reader opens it. Everything shown comes from the already-loaded Decision (no read), and every control
// is the same component the row used to carry: the item links, the queue badge, opinions, the claim,
// the dispute, the write's state, Undo, Preview and the explicit Review-and-answer CTA.
import type { Decision, User } from "../../api/types";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { QueueBadge } from "../../ui/molecules/QueueBadge";
import { Button } from "../../ui/atoms/Button";
import { EyeIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { ClaimPill } from "./parts";
import { ExecLine } from "./ExecLine";
import { KIND_TEXT, ageTitle, compactAge } from "./rows";
import { localActions, useLocal, useUndo } from "./state";
import { canActOn, canTakeBack } from "./access";
import { cn } from "../../ui/cn";

export function DecisionTools({ id, d, loaded, user, onPreview, onReview, onClose, peeked, allowBatch = true }: {
  id: string;
  d: Decision;
  /** Every loaded decision, for the batch picker (all loaded, never just the checked ones). */
  loaded: Decision[];
  user: User;
  onPreview: () => void;
  onReview: () => void;
  onClose: () => void;
  peeked: boolean;
  allowBatch?: boolean;
}) {
  const loc = useLocal();
  const undo = useUndo();
  const undoError = loc.undoError?.id === d.id ? loc.undoError : null;
  const canUndo = canTakeBack(user, d);
  const canReview = canActOn(user, [d]) && !d.answer && !d.preparing && !d.queued && !d.settling;
  const mine = d.opinions.find((o) => o.login === user.login)?.option;
  const checked = new Set(loc.checked);
  return <div id={id} className="shrink-0 border-b border-line bg-sunken/60 px-3.5 py-3 text-xs">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-ink/80">
        {d.number !== null
          ? <ItemRef repo={d.repo} number={d.number} kind={d.shown?.kind} state={d.shown?.state} title={null} />
          : <span className="code">{d.repo} · {d.items.length} {d.items.length === 1 ? "item" : "items"}</span>}
      </span>
      <span className="text-ink/50">{KIND_TEXT[d.kind]}</span>
      <span className="text-ink/50" title={ageTitle(d.askedAt)}>{compactAge(d.askedAt)}</span>
      {d.number !== null && <QueueBadge slot={d.queue} />}
      {d.opinions.length > 0 && (
        <span className={cn("inline-flex items-center gap-1", mine ? "text-accent-ink" : "text-ink/55")} title={`picked by ${d.opinions.length}${mine ? ", including you" : ""}`}>
          {d.opinions.length} {d.opinions.length === 1 ? "opinion" : "opinions"}{mine ? " (yours included)" : ""}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" variant="ghost" icon={EyeIcon} aria-pressed={peeked} onClick={onPreview} className="max-md:min-h-11">
          Preview
        </Button>
        {d.answer && d.undoable && canUndo && (
          <Button size="sm" variant="ghost" onClick={() => void undo(d.id)} className="max-md:min-h-11">Undo</Button>
        )}
        <Button size="sm" variant="primary" icon={ArrowSquareOutIcon} onClick={onReview} data-decision-action className="max-md:min-h-11">
          {canReview ? "Review and answer" : "Open"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} className="max-md:min-h-11">Close</Button>
      </div>
    </div>
    {undoError && <p className="mb-0 mt-1.5 text-bad">{undoError.message}</p>}
    {d.claim && <p className="mb-0 mt-1.5"><ClaimPill claim={d.claim} /></p>}
    {d.dispute && <p className="mb-0 mt-1.5 break-words text-warn">{d.dispute.by} disputed {d.answeredBy}&rsquo;s answer: {d.dispute.reason}</p>}
    <ExecLine d={d} canRetry={canUndo} />
    {allowBatch && <div className="mt-2.5 border-t border-line pt-2.5">
      <p className="mb-1.5 text-ink/55">Batch answer · select any loaded decision</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {loaded.map((row) => (
          <li key={row.id}>
            <label className="flex cursor-pointer items-center gap-2 py-0.5">
              <input type="checkbox" checked={checked.has(row.id)} onChange={() => localActions.toggle(row.id)} className="size-3.5 accent-accent" aria-label={`Select ${row.title} for a batch answer`} />
              <span className={cn("min-w-0 truncate", row.id === d.id ? "text-ink" : "text-ink/75")}>{row.title}</span>
              <span className="code ml-auto shrink-0 text-ink/45">{row.number === null ? `${row.repo} · ${row.items.length}` : `${row.repo}#${row.number}`}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>}
  </div>;
}
