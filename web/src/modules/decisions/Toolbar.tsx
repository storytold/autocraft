import { UnlessProject } from "../../shell/ScopePicker";
// Needs controls: the decision View (a native select) and the Filters disclosure, both inside the
// queue card's header. One surface at every
// width — no rail, no drawer, no modal. Scope lives in the URL; this file only draws it, from the
// same effective projection the list request uses.
import { useMemo, useState } from "react";
import { useQuery } from "../../api/client";
import { Select } from "../../ui/atoms/Select";
import { cn } from "../../ui/cn";
import {
  ALL_SCOPE_VIEWS, VIEW_OPTIONS, ageOptions, clearScopePatch, compatValues, hasRawScope, multiLabel, multiSelectValue,
  parseScope, removeRawAgePatch, removeRawScopePatch, scopeCount, viewOf, type CompatValue,
} from "./needs-controls";
import { ASKED_KINDS, KIND_LABEL, KINDS, useDecisionFilter } from "./state";

/** How many applied scope dimensions are on, for the Filters badge (the View is not a scope). */
export function activeFilterCount(): number {
  const { filter, search } = useDecisionFilter();
  return scopeCount(parseScope(search, KINDS), viewOf(filter.status));
}

/** Compact labels for the four kinds the reference names; every other real kind keeps its own label. */
const COMPACT_KIND: Partial<Record<string, string>> = { scope: "Scope", merge: "Merge", duplicate: "Duplicates", close: "Close" };
const kindLabel = (kind: string): string => COMPACT_KIND[kind] ?? KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind;

/** The View select and the inline Filters panel for the decisions queue. */
export function NeedsControls() {
  const { filter, setFilter, search, update } = useDecisionFilter();
  const scope = useMemo(() => parseScope(search, KINDS), [search]);
  const [open, setOpen] = useState(false);
  const view = viewOf(filter.status);
  const active = scopeCount(scope, view);
  const repos = useQuery("repos", (api) => api.repos());
  const patch = (value: Record<string, string | null>) => setFilter(value, { replace: false });
  const chips = compatValues(scope);
  const kind = scope.kind;
  const repo = scope.repo;
  const kindValue = multiSelectValue(kind);
  const repoValue = multiSelectValue(repo);
  const kindOptions: [string, string][] = [["", "Any kind"], ...ASKED_KINDS.map((k) => [k, kindLabel(k)] as [string, string])];
  const repoOptions: [string, string][] = [["", "All repos"], ...(repos.data ?? []).map((r) => [r, r] as [string, string])];
  const withCurrent = (options: [string, string][], value: string, label: string): [string, string][] =>
    value && !options.some(([v]) => v === value) ? [[value, label], ...options] : options;
  const remove = (chip: CompatValue) => update(chip.key === "age" ? removeRawAgePatch() : removeRawScopePatch(search, chip.key, chip.value), { replace: false });
  // Full-width scope rows keep labels left and a natural-width
  // native select at the right capped at 190px. Not a grid filler and not a fixed screenshot width.
  const row = "flex w-full items-center justify-between gap-2.5";
  const control = "h-[34px] min-w-0 max-w-[190px] px-2 py-1.5 text-[12.5px] max-md:h-11 max-md:text-[12.5px]";
  return <div className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label className="inline-flex min-w-0 items-center gap-2 text-xs text-ink/85">
        <span>View</span>
        <Select aria-label="Decision view" value={view} onChange={(event) => patch({ tab: event.target.value === "open" ? null : event.target.value })} className="h-[34px] w-[114px] text-xs max-md:h-11">
          {VIEW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </label>
      <button type="button" aria-expanded={open} aria-controls="needs-filters-panel" onClick={() => setOpen((was) => !was)}
        className="inline-flex h-9 shrink-0 items-center justify-center rounded border border-line-strong bg-raised px-3 text-[13px] text-ink/80 hover:bg-ink/[0.06] max-md:h-11">
        Filters{active ? ` (${active})` : ""}
      </button>
    </div>
    <div id="needs-filters-panel" hidden={!open} className="mt-3 border-t border-line pt-2.5">
      <div className="grid gap-2">
        <UnlessProject><div className={row}><span className="text-xs text-ink/70">Repo</span>
          <Select aria-label="Repo scope" value={repoValue} onChange={(event) => patch({ repo: event.target.value || null })} className={control}>
            {withCurrent(repoOptions, repoValue, multiLabel(repo)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </div></UnlessProject>
        <div className={row}><span className="text-xs text-ink/70">Kind</span>
          <Select aria-label="Kind scope" value={kindValue} onChange={(event) => patch({ kind: event.target.value || null })} className={control}>
            {withCurrent(kindOptions, kindValue, multiLabel(kind.map(kindLabel))).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </div>
        <div className={row}><span className="text-xs text-ink/70">Waiting at least</span>
          <Select aria-label="Waiting at least" value={scope.minAge ? String(scope.minAge) : ""} onChange={(event) => patch({ age: event.target.value || null })} className={control}>
            {ageOptions(scope.minAge).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={scope.all} onClick={() => patch({ all: scope.all ? null : "1" })}
          className={cn("inline-flex h-[34px] items-center rounded-full border px-3 text-xs max-md:h-11", scope.all ? "border-accent/30 bg-accent/[0.08] text-accent-ink" : "border-line-strong text-ink/80 hover:bg-ink/[0.04]")}>
          All questions
        </button>
        {(active > 0 || hasRawScope(scope)) && <button type="button" onClick={() => setFilter(clearScopePatch(), { replace: false })} className="text-xs text-accent-ink hover:underline max-md:min-h-11">
          Clear scope{active ? ` (${active})` : ""}
        </button>}
      </div>
      <p className="mb-0 mt-2 text-2xs leading-4 text-ink/50">
        All questions applies to {ALL_SCOPE_VIEWS.map((v) => VIEW_OPTIONS.find((o) => o.value === v)!.label.toLowerCase()).join(" and ")}; the other views ignore it. Age is counted from when the question was asked; above 36500 days is capped.
      </p>
      {chips.length > 0 && <ul aria-label="Scope values from this link" className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0">
        {chips.map((chip) => <li key={`${chip.key}:${chip.value}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-[11px] leading-4 text-ink/70">
          <span className="min-w-0 break-words">{chip.label}</span>
          <button type="button" aria-label={`Remove ${chip.label} from the scope`} onClick={() => remove(chip)} className="shrink-0 px-0.5 text-ink/50 hover:text-ink">×</button>
        </li>)}
      </ul>}
    </div>
  </div>;
}
