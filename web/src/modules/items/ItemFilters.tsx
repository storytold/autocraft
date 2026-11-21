// The Items browser chrome: one compact toolbar, a phase context
// row, a phone Filters disclosure and an honest count bar. Props only; views.tsx owns the URL.
// Every label here comes from browseState's effective constraints, so an applied filter is never
// invisible and a URL value the endpoint does not receive is always marked not applied.
import { useEffect, useId, useState, type ReactNode } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Button } from "../../ui/atoms/Button";
import { Input } from "../../ui/atoms/Input";
import { Select } from "../../ui/atoms/Select";
import { CheckRow } from "../../ui/molecules/CheckRow";
import { useContainerWidth } from "../../lib/useContainerWidth";
import { UnlessProject } from "../../shell/ScopePicker";
import { FilterField } from "./FilterField";
import type { useDraftField } from "./useDraftField";
import {
  PHASES, SORTS, appliedDetail, compatExtras, hiddenFilterCount, isActive, itemFilter,
  primarySelects, secondarySummary, type BrowseState, type CompatExtra,
} from "./browseState";
import type { ItemPhase } from "../../api/types";
import type { RowContinuity } from "./rowContinuity";
import type { OpenRef, Selection } from "./rows";

export type DraftField = ReturnType<typeof useDraftField>;

/** What both result views give the shared chrome. `onPatch` is a filter change (it resets
    pagination and the preview); `onPeek` only moves the passive preview; `onRemove` drops one
    compatibility value from the link. */
export interface BrowserProps {
  continuity: RowContinuity;
  browse: BrowseState;
  /** The approved 860 px phone breakpoint, where the secondary controls fold into Filters. */
  phone: boolean;
  onPatch: (patch: Record<string, string | null>) => void;
  /** Offset paging on the list endpoint; the phase endpoint pages by cursor instead. */
  onOffset: (offset: string | null) => void;
  onClearPhase: () => void;
  onReset: () => void;
  onRemove: (key: string, value: string) => void;
  /** The open row (approved `open=repo#number`) and the handlers that move it. */
  selection: Selection;
  onToggleRow: (ref: OpenRef) => void;
  onCloseSelection: () => void;
  /** A legacy peek value the link carried and `open` superseded. */
  selectionNote?: string;
  /** Controlled drafts, owned by the page so they survive a phase/list switch. */
  search: DraftField;
  author: DraftField;
  /** Replaces drafts after a reset or a popstate (unused for display; kept for parity). */
  resetKey: string;
}

export interface ChromeProps {
  browse: BrowseState;
  repos: string[];
  phone: boolean;
  phaseCounts?: Record<ItemPhase, number>;
  onPatch: (patch: Record<string, string | null>) => void;
  onClearPhase: () => void;
  onReset: () => void;
  onRemove: (key: string, value: string) => void;
  search: DraftField;
  author: DraftField;
  resetKey: string;
  /** The real count scope, or its pending text. */
  bar?: ReactNode;
  hasRows: boolean;
  children: ReactNode;
}

/** Empty result: no rows, a reason, and the one action that changes it. */
export function EmptyResults({ onReset }: { onReset: () => void }) {
  return <div className="grid min-h-[230px] place-content-center justify-items-center gap-1 px-4 text-center">
    <strong className="text-sm">No matching items</strong>
    <p className="mb-3 mt-0.5 text-xs text-ink/55">Try another search or widen the filters.</p>
    <Button onClick={onReset} className="max-md:h-11">Reset filters</Button>
  </div>;
}

/* The six-column toolbar needs 1010 px of columns, 50 px of gaps and 28 px of padding. */
const SIX_COLUMNS = 1088;
/* Three columns need 440 px of columns, 20 px of gaps and 28 px of padding. */
const THREE_COLUMNS = 488;

export function BrowserChrome({ browse, repos, phone, phaseCounts, onPatch, search, author, onClearPhase, onReset, onRemove, bar, hasRows, children }: ChromeProps) {
  const [expanded, setExpanded] = useState(false);
  const { ref: gridRef, width } = useContainerWidth<HTMLDivElement>();
  const panel = useId();
  useEffect(() => { if (!phone) setExpanded(false); }, [phone]);
  const phase = browse.phase !== undefined;
  const hidden = hiddenFilterCount(browse, phone);
  const summary = secondarySummary(browse);
  const detail = appliedDetail(browse);
  const disabledHint = "Clear the phase to use this filter";
  const phaseOption = (p: ItemPhase) => `${p}${phaseCounts ? ` · ${phaseCounts[p] ?? 0}` : ""}`;
  const selects = primarySelects(browse, repos);
  const extras = compatExtras(browse);
  // Only the width of this toolbar decides how its fixed columns wrap: the preview panel takes
  // 340 px from the same row, and the six-column band clips below 1088 px.
  const columns = phone ? "repeat(2, minmax(0, 1fr))" : width >= SIX_COLUMNS ? "170px 140px minmax(210px,1fr) 160px 170px 160px" : width >= THREE_COLUMNS ? "minmax(130px,1fr) minmax(110px,0.85fr) minmax(200px,1.25fr)" : "repeat(2, minmax(0, 1fr))";

  const stateField = <FilterField label="State" value={selects.state.value} options={selects.state.options} disabled={phase} disabledHint={disabledHint} onChange={(value) => onPatch({ state: value === "open" ? null : value, sort: null })} />;
  const typeField = <FilterField label="Type" value={selects.kind.value} options={selects.kind.options} onChange={(value) => onPatch({ kind: value || null })} />;
  const classificationField = <FilterField label="Classification" className="max-[860px]:col-span-2" value={selects.classification.value} options={selects.classification.options} disabled={phase} disabledHint={disabledHint} onChange={(value) => onPatch({ status: value || null })} />;
  const repoField = <UnlessProject><FilterField label="Repository" className="max-[860px]:col-span-2" value={selects.repository.value} options={selects.repository.options} onChange={(value) => onPatch({ repo: value || null })} /></UnlessProject>;
  const labelField = <FilterField label="Type label" value={selects.label.value} options={selects.label.options} disabled={phase} disabledHint={disabledHint} onChange={(value) => onPatch({ label: value || null })} />;
  const flagField = <FilterField label="Flag" value={selects.flag.value} options={selects.flag.options} disabled={phase} disabledHint={disabledHint} onChange={(value) => onPatch({ flag: value || null })} />;
  const phaseField = <FilterField label="Phase" className="max-[860px]:col-span-2 min-[861px]:w-[220px] min-[861px]:flex-none" value={browse.phase ?? "all"} options={[["all", "No phase"], ...PHASES.map((p) => [p, phaseOption(p)] as [string, string])]} onChange={(value) => (value === "all" ? onClearPhase() : onPatch({ phase: value, peek: null }))} />;

  return <section aria-label="Item browser" className="min-w-0 overflow-hidden rounded-md border border-line bg-panel">
    <div ref={gridRef} className="grid grid-cols-2 gap-2 border-b border-line p-3 min-[861px]:gap-2.5 min-[861px]:p-3.5" style={{ gridTemplateColumns: columns }}>
      <div className="min-w-0 flex-none basis-full" style={{ gridColumn: "1 / -1" }}>
        <div className="flex min-w-0 items-stretch gap-2">
          <SearchInput field={search} />
          {phone && <Button variant="secondary" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded} aria-controls={panel} className="min-h-[52px] px-3 text-xs">Filters{hidden ? ` · ${hidden}` : ""}</Button>}
        </div>
      </div>
      {stateField}
      {typeField}
      {!phone && classificationField}
      {!phone && repoField}
      {!phone && labelField}
      {!phone && flagField}
    </div>

    {(!phone || phase) && <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3.5 py-2.5">
      {phone ? <strong className="text-sm">{browse.phase}</strong> : phaseField}
      {phase && <button type="button" onClick={onClearPhase} className="inline-flex items-center whitespace-nowrap text-xs text-accent-ink hover:underline max-md:min-h-11">Clear phase</button>}
    </div>}

    {phone && <div id={panel} hidden={!expanded} className="border-b border-line bg-bg">
      <div role="group" aria-label="More item filters" className="grid grid-cols-2 gap-2 p-3">
        {classificationField}
        {labelField}
        {flagField}
        {repoField}
        {phaseField}
      </div>
    </div>}

    {phone && !expanded && summary.length > 0 && <div aria-label="Active secondary filters" className="flex flex-wrap gap-x-3 gap-y-1 border-b border-line px-3.5 py-2 text-[11.5px]">
      {summary.map((text) => <span key={text} className="break-words text-ink/70">{text}</span>)}
    </div>}

    <MoreFilters browse={browse} phase={phase} detail={detail} onPatch={onPatch} author={author} onRemove={onRemove} extras={extras} />

    {bar && hasRows && <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3.5 py-2 text-[11.5px]">
      <span className="min-w-0 text-ink/65">{bar}</span>
      {isActive(browse) && <button type="button" onClick={onReset} className="whitespace-nowrap text-accent-ink hover:underline max-md:min-h-11">Reset filters</button>}
    </div>}

    {children}
  </section>;
}

/** The search box: controlled by the page's draft, applied on Enter or by that draft's debounce. */
function SearchInput({ field }: { field: DraftField }) {
  return <label className="relative flex h-[52px] min-w-0 flex-1 items-center rounded-md border border-line-strong bg-sunken focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
    <MagnifyingGlassIcon aria-hidden className="pointer-events-none absolute left-3 text-ink/40" />
    <input type="search" aria-label="Search items" placeholder="Search items…" title="All words must match. Use “a phrase”, prefix*, -word or OR. Search titles, descriptions and comments." value={field.value} onChange={(event) => field.onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); field.onSubmit(); } }} className="h-full w-full min-w-0 rounded-md bg-transparent pl-10 pr-3 text-[13px] leading-5 outline-none placeholder:text-ink/40 max-md:text-[16px]" />
  </label>;
}

/** The direction wording follows the field being sorted, as the older rail did. */
function directionLabel(sort: string | undefined, q: string | undefined, desc: boolean): string {
  if (sort === "discord") return desc ? "Most mentions first" : "Fewest mentions first";
  if (sort === "number") return desc ? "Highest number first" : "Lowest number first";
  if (sort === "relevance" || (!sort && q)) return desc ? "Best matches first" : "Weakest matches first";
  return desc ? "Newest first" : "Oldest first";
}

/** Everything the approved toolbar does not carry: older links and bookmarks keep working,
    and the closed summary names every applied value that the primary controls cannot show. */
function MoreFilters({ browse, phase, detail, onPatch, author, onRemove, extras }: {
  browse: BrowseState;
  phase: boolean;
  detail: string[];
  onPatch: (patch: Record<string, string | null>) => void;
  author: DraftField;
  onRemove: (key: string, value: string) => void;
  extras: CompatExtra[];
}) {
  const sort = itemFilter(browse).sort ?? (browse.q ? "relevance" : browse.state === "merged-by-us" ? "merged" : "updated");
  const sorts = SORTS.filter(([key]) => (key !== "relevance" || browse.q) && (key !== "merged" || browse.state === "merged-by-us"));
  return <details className="border-b border-line px-3.5 py-2 [&[open]]:pb-3">
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink/55 hover:text-ink">
      <span className="shrink-0">More filters{extras.length > 0 ? ` · ${extras.length}` : ""}</span>
      {detail.length > 0
        ? <span className="min-w-0 break-words text-ink/70">{detail.join(" · ")}</span>
        : <span className="text-ink/40">from older links and bookmarks{phase ? "" : " · Author, date, sort, page size, Discord"}</span>}
    </summary>
    {!phase && <div className="mt-2 grid gap-2 min-[861px]:grid-cols-3">
      <label className="min-w-0 space-y-1 text-2xs text-ink/60"><span className="block">Author</span><Input aria-label="Author" placeholder="GitHub login" value={author.value} onChange={(event) => author.onChange(event.target.value)} className="w-full" /></label>
      <label className="min-w-0 space-y-1 text-2xs text-ink/60"><span className="block">Updated since</span><Input aria-label="Updated since" type="date" value={browse.since ?? ""} onChange={(event) => onPatch({ since: event.target.value || null, offset: null, peek: null })} className="w-full" /></label>
      <div className="min-w-0 space-y-1 text-2xs text-ink/60"><span className="block">Sort</span><div className="flex gap-1.5"><Select aria-label="Sort" value={sort} onChange={(event) => onPatch({ sort: event.target.value, offset: null, peek: null })} className="min-w-0 flex-1">{sorts.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select><Select aria-label="Sort direction" value={browse.desc ? "desc" : "asc"} onChange={(event) => onPatch({ desc: event.target.value === "asc" ? "0" : null, offset: null, peek: null })} className="w-[86px]"><option value="desc">{directionLabel(sort, browse.q, true)}</option><option value="asc">{directionLabel(sort, browse.q, false)}</option></Select></div></div>
      <label className="min-w-0 space-y-1 text-2xs text-ink/60"><span className="block">Page size</span><Select aria-label="Page size" value={String(browse.limit)} onChange={(event) => onPatch({ limit: event.target.value === "50" ? null : event.target.value, offset: null, peek: null })} className="w-full">{[...new Set([25, 50, 100, browse.limit])].sort((a, b) => a - b).map((size) => <option key={size} value={size}>{size} per page</option>)}</Select></label>
      <div className="min-w-0 text-2xs text-ink/60"><span className="mb-1 block">Source</span><CheckRow checked={browse.discord} onChange={(on) => onPatch({ discord: on ? "1" : null, offset: null, peek: null })} title="Seen on Discord" /></div>
    </div>}
    {phase && <div className="min-w-0 text-2xs text-ink/60"><span className="mb-1 mt-2 block">Source</span><CheckRow checked={browse.discord} onChange={(on) => onPatch({ discord: on ? "1" : null, offset: null, peek: null })} title="Seen on Discord" /></div>}
    {extras.length > 0 && <><ul aria-label="Filters from this link" className="mt-2 flex flex-wrap gap-1.5">
      {extras.map((extra) => <li key={`${extra.key}:${extra.rawValue}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-[11px] leading-4 text-ink/70">
        <span className="min-w-0 break-words">{extra.label}: {extra.value}</span>
        {!extra.applied && <span className="shrink-0 text-warn">not applied</span>}
        <button type="button" aria-label={`Remove ${extra.label} ${extra.value} from this link`} onClick={() => onRemove(extra.key, extra.rawValue)} className="shrink-0 px-0.5 text-ink/50 hover:text-ink">×</button>
      </li>)}
    </ul>
    </>}
  </details>;
}
