// Native item/GitHub links and a separate Details button with row facts.
// Expansions are read-only and use two columns where space permits.
import { useId, type ReactNode } from "react";
import { useQuery } from "../../api/client";
import { useUser } from "../../shell/UserContext";
import { useItemPreview } from "../../lib/useItemPreview";
import { Link } from "react-router-dom";
import { CaretDownIcon, GithubLogoIcon } from "@phosphor-icons/react";
import type { Decision, Item, ItemPageData } from "../../api/types";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { formatCost } from "../../lib/trace";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { CHECK_COLUMNS, checkCells, Size } from "../queue/checks";
import { cn } from "../../ui/cn";
import { decisionPath, githubItemUrl, itemPath } from "../../lib/links";
import { clock, when, eventTime } from "../../lib/format";
import {
  QUEUE_TEXT, answerFacts, answerQueueText, classificationDetail, classificationToken, decisionReceipt, detailFacts, effectiveSettled,
  eventDateTime, lastEvents, pipelineRead, receipt, rowWord, statusWord, type RowFacts,
} from "./rows";

const TONE: Record<string, Tone> = { ok: "ok", warn: "warn", bad: "bad", neutral: "neutral" };

/** Native item links and a separate button for the read-only inline detail. */
export function ItemRow({ facts, open, onToggle, children }: { facts: RowFacts; open: boolean; onToggle: () => void; children?: ReactNode }) {
  const panel = useId();
  const token = facts.settled ? classificationToken(facts.settled) : null;
  return <li className={cn("border-b border-line last:border-0", open && "bg-bg")}>
    <div className="grid gap-1.5 px-4 py-3">
      <div className="relative min-h-8 max-md:min-h-11">
        <ItemRef repo={facts.repo} number={facts.number} kind={facts.kind} state={facts.state} title={facts.title} stretch className="font-medium" />
      </div>
      <Button type="button" variant="ghost" size="sm"
        aria-expanded={open} aria-controls={open ? panel : undefined} onClick={onToggle}
        className="h-auto min-h-7 w-full flex-wrap justify-start whitespace-normal px-0 py-1 text-left font-normal max-md:min-h-11">
        {token ? <Badge tone={TONE[token.tone] ?? "neutral"}>{token.text}</Badge> : facts.status ? <Badge tone="neutral">{facts.status.phase}</Badge> : null}
        {facts.flags.includes("security") && <Badge tone="bad">Security</Badge>}
        {rowWord(facts) && <span className="min-w-0 break-words text-ink/60">{rowWord(facts)}</span>}
        <span className="ml-auto shrink-0 text-ink/60"><TimeAgo iso={facts.updatedAt} /></span>
        <span className="inline-flex items-center gap-1">Details<span className="sr-only"> for {facts.repo}#{facts.number}</span> <CaretDownIcon aria-hidden className={cn("transition-transform duration-150", open && "rotate-180")} /></span>
      </Button>
    </div>
    {open && <div id={panel} className="border-t border-dashed border-line px-4 pb-4 pt-1">{children}</div>}
  </li>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0">
    <h4 className="text-[13.5px] font-semibold leading-5">{title}</h4>
    <div className="mt-2 min-w-0 text-[12.5px] leading-[1.5] text-ink/75">{children}</div>
  </section>;
}

const fullHref = (facts: RowFacts) => itemPath(facts.repo, facts.number);

/**
 * The open row's detail. `detail` is the selected item's existing itemPage GET (null until it
 * arrives, guarded by useItemPreview); the classification and the retained metadata come from the
 * row's own endpoint, so this never invents a fact the payload does not carry.
 */
export function ItemExpansion({ facts, detail, loading, error, item, itemLoading, itemError, decision }: {
  facts: RowFacts;
  detail: ItemPageData | null;
  loading: boolean;
  error?: string;
  /** The selected row's own item GET: the classification record used by the reasoning section. */
  item: Item | null;
  itemLoading: boolean;
  itemError?: string;
  decision: Decision | null | undefined;
}) {
  const viewer = useUser().role === "viewer";
  const events = lastEvents(detail?.timeline);
  const settled = effectiveSettled(facts, item);
  const read = pipelineRead(item, settled);
  const answer = answerFacts(decision);
  const details = detailFacts(facts, item);
  const checks = checkCells(facts.checks);
  return <div className="grid min-w-0 gap-[22px] pt-2 min-[1101px]:grid-cols-2">
    <div className="min-w-0 space-y-4">
      <Section title="What the pipeline read">
        {itemLoading && !item ? <p role="status" className="m-0 text-ink/50">Loading the classifier's reasoning…</p> : null}
        {itemError ? <p className="m-0 text-bad">The classifier's reasoning could not be read: {itemError}</p> : null}
        {!itemLoading && !itemError && read && read.text ? <>
          <p className="m-0">{read.text}</p>
          <p className="mb-0 mt-1.5 text-[11.5px] text-ink/50">{read.classifier} · {eventTime(read.at)}{read.matchedSource ? "" : " · latest record available"}</p>
        </> : null}
        {!itemLoading && !itemError && read && !read.text ? <>
          <p className="m-0 text-ink/55">No classifier reason recorded.</p>
          <p className="mb-0 mt-1.5 text-[11.5px] text-ink/50">{read.classifier} · {eventTime(read.at)}{read.matchedSource ? "" : " · latest record available"}</p>
        </> : null}
        {!itemLoading && !itemError && !read ? <p className="m-0 text-ink/55">No classifier has run for this item.</p> : null}
      </Section>
      <Section title="Classification">
        {settled ? <>
          <p className="m-0 flex flex-wrap items-center gap-2"><Badge tone={TONE[classificationToken(settled).tone] ?? "neutral"}>{classificationToken(settled).text}</Badge></p>
          <p className="mb-0 mt-1.5 text-ink/65">{classificationDetail(settled, item?.classifications.length ?? 0)}</p>
          {answer && <p className="mb-0 mt-2 text-[11.5px] leading-5 text-ink/60">
            Execution: <Badge tone={TONE[answer.tone] ?? "neutral"}>{answer.state}</Badge>.
            {answer.reason ? <span className="block">{answer.reason}</span> : null}
            {answer.appliedAt ? <span className="block">Applied {when(answer.appliedAt)}</span> : null}
          </p>}
        </> : itemLoading ? <p role="status" className="m-0 text-ink/50">Loading classification…</p>
          : itemError ? <p className="m-0 text-bad">Classification could not be read: {itemError}</p>
            : <p className="m-0 text-ink/65">This item has no classification record. <Link className="text-accent-ink hover:underline" to={fullHref(facts)}>Open the full task</Link> to see it.</p>}
      </Section>
    </div>
    <div className="min-w-0 space-y-4">
      <Section title="Queue place">
        {answer && <p className="m-0">Answer exists · {answerQueueText(answer)}</p>}
        <p className="m-0">{facts.queue ? QUEUE_TEXT(facts.queue) : facts.status ? facts.status.waiting ?? facts.status.next ?? "No wait recorded" : "Not queued"}</p>
        <p className="mb-0 mt-1.5 text-ink/60">
          {facts.status
            ? <>{facts.status.phase}{facts.status.waiting ? ` · ${facts.status.waiting}` : ""}{facts.status.next ? ` · next: ${facts.status.next}` : ""} · since {eventTime(facts.status.since)}</>
            : statusWord(facts)}
        </p>
        {detail && <p className="mb-0 mt-1.5 text-ink/60"><span className="text-ink/45">Now: </span>{detail.bar.headline.text}{detail.bar.headline.next ? ` · next: ${detail.bar.headline.next}` : ""}</p>}
        {loading && <p role="status" className="mb-0 mt-1.5 text-ink/50">Loading the live status…</p>}
        <ErrorLine error={error} className="mt-2" />
      </Section>
      {facts.checks && <Section title="Merge checks">
        <dl className="m-0 flex flex-wrap gap-x-4 gap-y-2">
          {CHECK_COLUMNS.map((column) => <div key={column.id} className="flex items-center gap-1.5"><dt>{column.label}</dt><dd className="m-0">{checks[column.id] ?? "Not recorded"}</dd></div>)}
          <div className="flex items-center gap-1.5"><dt>Size</dt><dd className="m-0"><Size size={facts.checks.size} /></dd></div>
        </dl>
      </Section>}
      {!!facts.closes?.length && <Section title="Closes">
        <ul className="m-0 list-none space-y-1 p-0">{facts.closes.map((number) => <li key={number}><ItemRef repo={facts.repo} number={number} kind="issue" title={null} size="sm" /></li>)}</ul>
      </Section>}
      <Section title="Last events">
        {loading && !detail ? <p role="status" className="m-0 text-ink/50">Loading events…</p> : null}
        {detail && events.length === 0 ? <p className="m-0 text-ink/55">No events recorded for this item.</p> : null}
        {events.length > 0 && <ul className="m-0 list-none divide-y divide-line p-0">
          {events.map((event) => <li key={event.id} className="py-2 first:pt-0 last:pb-0">
            <strong className="font-semibold text-ink/85">{event.text}</strong>
            <span className="text-ink/55"> · <time dateTime={eventDateTime(event.at)} title={eventDateTime(event.at) ? when(event.at) : undefined} aria-label={eventDateTime(event.at) ? when(event.at) : undefined}>{eventDateTime(event.at) ? clock(event.at) : "Time unknown"}</time></span>
            {!viewer && formatCost(event.costUsd) && <span className="num text-ink/55"> · {formatCost(event.costUsd)}</span>}
          </li>)}
        </ul>}
      </Section>
      <Section title="Links">
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link className="text-accent-ink hover:underline" to={fullHref(facts)}>Full item</Link>
          {decision ? <Link className="text-accent-ink hover:underline" to={decisionPath(decision)}>Open decision</Link> : null}
          <a className="inline-flex items-center gap-1 text-accent-ink hover:underline" href={githubItemUrl(facts.repo, facts.number, facts.kind)} target="_blank" rel="noopener noreferrer nofollow">
            <GithubLogoIcon aria-hidden /> GitHub
          </a>
        </p>
      </Section>
    </div>
    {details.length > 0 && <section className="min-w-0 min-[1101px]:col-span-2">
      <h4 className="text-[11.5px] font-semibold uppercase tracking-[.04em] text-ink/60">Details</h4>
      <dl className="mt-1.5 grid gap-x-6 gap-y-1 text-[11.5px] text-ink/65 min-[1101px]:grid-cols-2">
        {details.map((fact) => <div key={fact.label} className="flex min-w-0 gap-2"><dt className="shrink-0 text-ink/45">{fact.label}</dt><dd className="m-0 min-w-0 break-words">{fact.value}</dd></div>)}
      </dl>
    </section>}
  </div>;
}

/** A selection that cannot be opened: explicit, closeable, and never a fabricated matching row. */
export function SelectionUnavailable({ title, message, onClose, href }: { title: string; message: string; onClose: () => void; href?: string }) {
  return <div role="status" className="grid place-content-center justify-items-center gap-1 px-4 py-8 text-center">
    <strong className="text-sm">{title}</strong>
    <p className="mb-3 mt-0.5 max-w-[52ch] text-xs text-ink/60">{message}</p>
    <p className="m-0 flex flex-wrap items-center justify-center gap-3 text-xs">
      <button type="button" onClick={onClose} className="max-md:min-h-11 text-accent-ink hover:underline">Close</button>
      {href && <Link to={href} className="max-md:min-h-11 text-accent-ink hover:underline">Full item</Link>}
    </p>
  </div>;
}

/**
 * The selected row's read-only detail: the existing itemPage GET through useItemPreview (identity
 * and role guards, no retention) plus the item's decision from its existing GET. Mounted only for
 * the open row, so opening a row issues exactly those two reads and closing issues none.
 */
export function OpenRowDetail({ facts, note }: { facts: RowFacts; note?: string }) {
  const user = useUser();
  const ref = { repo: facts.repo, number: facts.number };
  const preview = useItemPreview(ref);
  // The item's own record: classification reasons, settled state and the metadata a phase row
  // lacks. Selected row only, keyed by ref + login + role with no retention. The shared query
  // deliberately keeps a previous key's data while the new one loads (keepPreviousData), so this
  // row accepts a payload only through `receipt`: not loading, not failed, and naming this row.
  const itemQuery = useQuery<Item>(
    `item:row:${user.login}:${user.role}:${facts.key}`,
    (api) => api.item(ref.repo, ref.number),
    { gcTime: 0 },
  );
  const item = receipt(itemQuery.data, { loading: itemQuery.loading, error: itemQuery.error?.message }, ref);
  const decisionQuery = useQuery<Decision | null>(
    `decision:for-item:${user.login}:${user.role}:${facts.key}`,
    (api) => api.decisions.forItem(ref.repo, ref.number),
    { gcTime: 0 },
  );
  const decision = decisionReceipt(decisionQuery.data, { loading: decisionQuery.loading, error: decisionQuery.error?.message }, ref);
  return <>
    <ItemExpansion
      facts={facts}
      detail={(preview.data as ItemPageData | undefined) ?? null}
      loading={preview.loading}
      error={preview.error}
      item={item}
      itemLoading={itemQuery.loading}
      itemError={itemQuery.error?.message}
      decision={decision as Decision | null}
    />
    {note && <p className="mb-0 mt-3 text-[11px] text-ink/45">{note}</p>}
  </>;
}
