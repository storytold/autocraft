import { useState } from "react";
import type { Decision } from "../../api/types";
import { useItemPreview } from "../../lib/useItemPreview";
import { clock, when } from "../../lib/format";
import { formatCost } from "../../lib/trace";
import { useUser } from "../../shell/UserContext";
import { DisclosurePanel } from "../../ui/molecules/DisclosurePanel";
import {
  changeTimelineOpen, timelineModel, timelineReadState, timelineReference,
  TIMELINE_EVENT_LIMIT, TIMELINE_READ_ERROR, type TimelineReference,
} from "./timeline";

/** The only timeline observer: mounted only for an open disclosure with a valid own item. */
function ItemTimelineRead({ reference }: { reference: TimelineReference }) {
  const item = useItemPreview(reference);
  const user = useUser();
  const state = timelineReadState(reference, item);
  // The native hook hides wrong-ref responses as loading. This is not proof a request is still pending.
  if (state === "waiting") return <p role="status" className="text-sm text-ink/55">Waiting for item timeline data…</p>;
  if (state === "error") return <p className="text-sm text-ink/55">{TIMELINE_READ_ERROR}</p>;

  // Matching cache data can coexist with a defined error; the gate above rejects it before projection.
  const model = timelineModel(item.data!.timeline);
  if (model.empty) return <p className="text-sm text-ink/55">No item events recorded.</p>;
  return (
    <ol className="space-y-3">
      {model.rows.map((row) => {
        const validTime = Number.isFinite(Date.parse(row.at));
        const cost = user.role === "viewer" ? null : formatCost(row.costUsd);
        return (
          <li key={row.key} className="min-w-0 [overflow-wrap:anywhere]">
            <p className="whitespace-pre-wrap text-sm leading-6 text-ink/85">
              <strong className="font-medium">{row.text.trim() ? row.text : "Event text unavailable"}</strong>
            </p>
            <p className="mt-0.5 text-xs text-ink/50">
              <span className="whitespace-pre-wrap">{row.actor.trim() ? row.actor : "Actor unavailable"}</span>
              <span aria-hidden="true"> · </span>
              {validTime ? <time dateTime={row.at} title={when(row.at)} aria-label={when(row.at)}>{clock(row.at)}</time> : <span>Time unavailable</span>}
              {cost && <><span aria-hidden="true"> · </span><span className="num">{cost}</span></>}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/** Open-only body: no reference inference or projection happens in the folded disclosure. */
function TimelineBody({ decision }: { decision: Decision }) {
  const reference = timelineReference(decision);
  return (
    <div className="min-w-0 space-y-3 px-4 py-4">
      {reference ? <ItemTimelineRead reference={reference} /> : (
        <p className="text-sm text-ink/55">This decision has no single item reference, so no item timeline is shown.</p>
      )}
    </div>
  );
}

/** One mounted reader's independent, bounded OPEN ids; selecting A→B→A restores A. */
function ReaderTimeline({ decision }: { decision: Decision }) {
  const user = useUser();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const open = openIds.has(decision.id);
  return (
    <DisclosurePanel
      title="Item timeline"
      summary={`Latest recorded item events · up to ${TIMELINE_EVENT_LIMIT}`}
      open={open}
      onOpenChange={(next) => setOpenIds((ids) => changeTimelineOpen(ids, decision.id, next))}
    >
      {open ? <TimelineBody key={JSON.stringify([user.login, user.role, decision.id, decision.repo, decision.number])} decision={decision} /> : null}
    </DisclosurePanel>
  );
}

/** Cheap reader boundary: no item hook, model projection, persistence or global state. */
export function DecisionTimeline({ decision }: { decision: Decision }) {
  const user = useUser();
  return <ReaderTimeline key={JSON.stringify([user.login, user.role])} decision={decision} />;
}
