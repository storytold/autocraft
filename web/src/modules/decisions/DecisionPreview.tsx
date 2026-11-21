// One decision, read-only, beside the list. The item page comes from the existing preview GET
// (lib/useItemPreview); the question comes from the list the page already read. Only a linked id the
// loaded list does not hold asks for one more read. Nothing here claims, answers or opens a form.
import type { ReactNode } from "react";
import { useQuery } from "../../api/client";
import type { Decision } from "../../api/types";
import { decisionPath } from "../../lib/links";
import { useItemPreview } from "../../lib/useItemPreview";
import { useUser } from "../../shell/UserContext";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { ItemPreview } from "../../ui/organisms/ItemPreview";
import { DecisionSummary } from "./DecisionBlocks";
import { ClaimPill, Facts, KindTag } from "./parts";
import { Refs } from "./Refs";
import type { DecisionListQuery } from "./state";

/** The option label of an answered decision, or the raw key when the options no longer list it. */
function answerLabel(d: Decision): string {
  return d.options.find((o) => o.key === d.answer)?.label ?? d.answer ?? "";
}

/** What the pipeline is doing with this question right now, in words; none of it is an action. */
function stateNotes(d: Decision): { text: ReactNode; tone: "warn" | "muted" }[] {
  const notes: { text: ReactNode; tone: "warn" | "muted" }[] = [];
  if (d.preparing) notes.push({ tone: "muted", text: "Opus is preparing new options for this question. The stored recommendation is held back until they arrive." });
  if (d.queued) {
    const place = d.queued.place ? ` It is ${d.queued.place} in line.` : "";
    notes.push({ tone: "warn", text: `${d.queued.by} pressed an answer; it waits: ${d.queued.reason}.${place}` });
    if (d.queued.dispute) notes.push({ tone: "warn", text: `${d.queued.dispute.by} disputed that press: ${d.queued.dispute.reason}` });
  }
  if (d.settling && !d.queued) notes.push({ tone: "warn", text: `${d.settling} is applying their answer; nobody else may answer meanwhile.` });
  if (d.snoozed) notes.push({ tone: "muted", text: `Snoozed by ${d.snoozed.by} until new activity on the item.` });
  if (d.dispute) notes.push({ tone: "warn", text: `${d.dispute.by} disputed this answer: ${d.dispute.reason}` });
  if (d.orphaned) notes.push({ tone: "warn", text: "The answerer can no longer settle this item, so an operator has to reassign it." });
  if (d.answer && d.exec && d.exec.state !== "done") {
    const why = d.exec.reason ? `: ${d.exec.reason}` : "";
    const text =
      d.exec.state === "failed"
        ? `The GitHub write failed${why}`
        : d.exec.state === "waiting-token"
          ? "The GitHub write waits for the answering operator to sign in."
          : d.exec.state === "waiting-permission"
            ? `The GitHub write waits for permission${d.exec.approvalsRepo ? ` on ${d.exec.approvalsRepo}` : ""}${why}`
            : `The GitHub write is pending${why}`;
    notes.push({ tone: d.exec.state === "failed" ? "warn" : "muted", text });
  }
  return notes;
}

/** The read-only question block shown inside the item preview. */
function DecisionPeek({ d }: { d: Decision }) {
  const notes = stateNotes(d);
  // The stored recommendation is only current while nothing is preparing or applying a new answer.
  const current = !d.preparing && !d.queued && !d.settling;
  const rec = current && d.recommended ? d.options.find((o) => o.key === d.recommended) : undefined;
  const facts = d.facts.slice(0, 4);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
        <KindTag kind={d.kind} batch={d.number === null ? d.items.length : undefined} />
        <span>
          asked <TimeAgo iso={d.askedAt} />
        </span>
        <ClaimPill claim={d.claim} compact />
      </div>
      {notes.length > 0 && (
        <ul className="space-y-1 text-xs leading-5">
          {notes.map((n, i) => (
            <li key={i} className={n.tone === "warn" ? "text-warn" : "text-ink/60"}>
              {n.text}
            </li>
          ))}
        </ul>
      )}
      <p className="text-pretty text-base font-semibold leading-6">
        <Refs text={d.question} repo={d.repo} />
      </p>
      {rec && (
        <p className="text-sm leading-5 text-ink/85">
          <span className="font-medium text-accent-ink">Recommended:</span> {rec.label}
          {d.recommendedReason ? ` — ${d.recommendedReason}` : ""}
        </p>
      )}
      {d.answer && (
        <p className="text-sm leading-5 text-ink/85">
          <span className="font-medium">Answered:</span> {answerLabel(d)}
          {d.answeredBy ? ` by ${d.answeredBy}` : ""}
          {d.appliedAt ? " · applied" : d.undoable ? " · undoable" : ""}
          {d.answeredAt ? <> · <TimeAgo iso={d.answeredAt} /></> : null}
        </p>
      )}
      {d.number === null && (
        <section>
          <h3 className="text-xs font-semibold text-ink/60">Items in this batch</h3>
          <ul className="mt-1.5 space-y-1">
            {d.items.map((it) => (
              <li key={`${it.repo}#${it.number}`} className="min-w-0">
                <ItemRef repo={it.repo} number={it.number} kind={it.kind} state={it.state} title={it.title} size="sm" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {facts.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-ink/60">Key facts</h3>
          <div className="mt-1.5">
            <Facts facts={facts} repo={d.repo} />
          </div>
        </section>
      )}
      <DecisionSummary d={d} />
      {d.number === null && <p className="text-xs leading-5 text-ink/50">The full task answer covers all {d.items.length} items.</p>}
    </>
  );
}

/**
 * The preview for `peek` (a decision id). The decision comes from the list the page already read;
 * only an id that list does not hold asks for one read-only GET. Neither path trusts a payload while
 * the list is loading a new key (another role or filter): that placeholder belongs to the old view.
 */
export function DecisionPreview({ peek, query, onClose }: { peek: string; query: DecisionListQuery; onClose: () => void }) {
  const user = useUser();
  const decisions = query.loading ? undefined : query.data?.decisions;
  const fromList = decisions?.find((d) => d.id === peek);
  const missing = !query.loading && !!query.data && !fromList;
  // gcTime 0: this read-only lookup is for one preview; a browsed-away decision should not keep its
  // payload cached for the default five minutes.
  const one = useQuery(`decision:preview:${user.login}:${user.role}:${peek}`, (api) => api.decisions.get(peek), { enabled: missing, gcTime: 0 });
  const fetched = missing && !one.loading && !one.error && one.data?.id === peek ? one.data : undefined;
  const d = fromList ?? fetched;
  const loading = !d && !one.error && (query.loading || missing);
  const selection = d && d.number !== null ? { repo: d.repo, number: d.number } : null;
  const item = useItemPreview(selection);
  return (
    <ItemPreview
      data={item.data}
      loading={item.loading}
      error={item.error}
      href={d ? decisionPath(d) : undefined}
      label={d ? (d.number === null ? `${d.repo} · ${d.items.length} items` : `${d.repo}#${d.number}`) : undefined}
      onClose={onClose}
    >
      {d ? (
        <DecisionPeek d={d} />
      ) : loading ? (
        <p role="status" className="text-sm text-ink/55">
          Loading decision…
        </p>
      ) : one.error ? (
        <ErrorLine error={`Could not load this decision: ${one.error.message}`} />
      ) : query.error ? (
        <ErrorLine error={`Could not load the decision list: ${query.error.message}`} />
      ) : (
        // No link exists to a decision that could not be read, so this says only what is true.
        <p className="text-sm text-ink/55">This decision is not available here.</p>
      )}
    </ItemPreview>
  );
}
