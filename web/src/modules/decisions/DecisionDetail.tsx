// The selected decision's passive primary context, list-backed only: everything here comes from the
// Decision the current guarded list receipt holds. The native-form handoff is explicit;
// evidence, discussion and timeline stay read-only and permission-guarded.
import type { ReactNode } from "react";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import type { Decision } from "../../api/types";
import { KIND_TEXT } from "./rows";
import { ageTitle, answerWord, compactAge, refText } from "./rows";
import { cn } from "../../ui/cn";
import { DecisionDiscussion } from "./DecisionDiscussion";
import { DecisionEvidence } from "./DecisionEvidence";
import { DecisionTimeline } from "./DecisionTimeline";

export interface DetailContext {
  decision: Decision | undefined;
  /** "none" shows the desktop default context; "requested" a real id; "unavailable" an explicit bad value. */
  requested: "none" | "requested" | "unavailable";
  reason?: "empty" | "duplicate" | "malformed" | "not-loaded";
  raw?: string;
  /** The list receipt state for honest loading/error wording. */
  loading: boolean;
  error: string | undefined;
  hasRows: boolean;
  /** The surface is single-column (<=860): compact typography, padding and the mobile backlink. */
  compact: boolean;
  /** The explicit handoff to the native answer form. */
  answer?: ReactNode;
  onClose: () => void;
  onOpenItem: (id: string) => void;
}

const PAD = "px-4 pb-[22px] pt-4 min-[861px]:px-[26px] min-[861px]:pb-[26px] min-[861px]:pt-[22px]";

export function DecisionDetail(ctx: DetailContext) {
  const { decision: d, requested, reason, raw, loading, error, hasRows, compact, onClose, onOpenItem } = ctx;
  // Evidence eligibility: a real settled decision, never while the existing flags say loading/error/unavailable.
  const eligible = !!(d && !loading && !error && requested !== "unavailable");
  const evidence = eligible ? <DecisionEvidence decision={d!} /> : undefined;
  const discussion = eligible ? <DecisionDiscussion decision={d!} /> : undefined;
  const timeline = d && !loading && error === undefined && requested !== "unavailable" ? <DecisionTimeline decision={d} /> : undefined;
  return <section aria-label="Selected decision" className="min-w-0">
    {compact && (
      <button type="button" onClick={onClose} className="mb-3 inline-flex min-h-11 items-center gap-1.5 rounded px-1 text-sm text-ink/75 hover:text-ink">
        <ArrowLeftIcon aria-hidden /> All decisions
      </button>
    )}
    <div className={PAD}>
      {d ? <Body d={d} onOpenItem={onOpenItem} answer={ctx.answer} evidence={evidence} discussion={discussion} timeline={timeline} /> : requested === "unavailable" || (requested === "requested" && !loading && !error) ? (
        <Unavailable reason={reason ?? "not-loaded"} raw={raw} loading={loading} error={error} hasRows={hasRows} />
      ) : loading ? (
        <p role="status" className="text-sm text-ink/55">Loading this decision…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-bad">This list could not be read: {error}</p>
      ) : hasRows ? (
        <p className="text-sm text-ink/55">Select a decision in the queue.</p>
      ) : (
        <p className="text-sm text-ink/55">No decisions are waiting here.</p>
      )}
      {!d && ctx.answer}
    </div>
  </section>;
}

function Body({ d, onOpenItem, answer, evidence, discussion, timeline }: { d: Decision; onOpenItem: (id: string) => void; answer?: ReactNode; evidence?: ReactNode; discussion?: ReactNode; timeline?: ReactNode }) {
  const word = answerWord(d);
  const rec = recommendation(d);
  const facts = (d.facts ?? []).slice(0, 2);
  const claim = d.claim?.login
    ? `on it · ${d.claim.login}${Number.isFinite(Date.parse(d.claim.since)) ? ` · ${compactAge(d.claim.since)}` : ""}`
    : null;
  return <>
    <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
      <span className="font-mono text-2xs">{refText(d)}</span>
      <span aria-hidden>·</span>
      <span>{KIND_TEXT[d.kind]}</span>
      <span aria-hidden>·</span>
      <span title={ageTitle(d.askedAt)}>asked {compactAge(d.askedAt)}</span>
      {claim && <><span aria-hidden>·</span><span title={`claimed ${d.claim!.since}`}>{claim}</span></>}
    </p>
    <h2 id="detail-title" tabIndex={-1} className={cn("m-0 break-words font-bold text-ink", "text-xl")}>{d.title}</h2>
    <p className={cn("mt-1 break-words font-semibold text-ink/85", "text-md min-[861px]:text-lg")}>{d.question}</p>
    {word && <p className="mt-2 text-xs text-ink/60">Answer · {word.text}{d.answer && d.options.find((o) => o.key === d.answer) ? ` · ${d.options.find((o) => o.key === d.answer)!.label}` : ""}</p>}
    {facts.length > 0 && <ul className="mt-3 space-y-1 text-sm leading-6 text-ink/80">{facts.map((f, i) => <li key={i} className="break-words">{f}</li>)}</ul>}
    {rec && <p className="mt-3 break-words text-sm text-ink/80"><strong className="font-semibold">{rec.label}</strong>{rec.reason && <> — {rec.reason}</>}</p>}
    {answer}
    {d.number === null && <p className="mt-2 text-xs text-ink/55">{d.repo} · {d.items.length} {d.items.length === 1 ? "item" : "items"}</p>}
    <button type="button" onClick={() => onOpenItem(d.id)} className="mt-4 inline-flex min-h-11 items-center rounded px-1 text-sm text-accent-ink hover:underline">
      Open the item
    </button>
        {evidence}
        {discussion}
        {timeline}
  </>;
}

/** The usable recommendation: only while nothing is preparing/queued/settling and the key is a real option. */
export function recommendation(d: Decision): { label: string; reason: string } | null {
  if (d.preparing || d.queued || d.settling || !d.recommended) return null;
  const option = d.options.find((o) => o.key === d.recommended);
  if (!option) return null;
  return { label: `Recommended ${option.label}`, reason: d.recommendedReason?.trim() || "" };
}

function Unavailable({ reason, raw, loading, error, hasRows }: { reason: string; raw?: string; loading: boolean; error?: string; hasRows: boolean }) {
  const text = loading ? "This decision is not loaded yet." : error ? `This list could not be read: ${error}` : !hasRows ? "This decision is not in the loaded queue: no decisions are waiting here." : "This decision is not in the loaded queue.";
  const why = reason === "duplicate" ? "The link names more than one decision." : reason === "empty" ? "The link names an empty decision." : reason === "malformed" ? "The link's decision value cannot be used." : raw ? `Requested: ${raw}` : "";
  return <>
    <p role="status" className="text-sm text-ink/70">{text}</p>
    {why && <p className="mt-1 text-xs text-ink/50">{why}</p>}
  </>;
}
