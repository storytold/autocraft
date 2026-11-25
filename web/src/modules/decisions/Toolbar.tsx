import { UnlessProject } from "../../shell/ScopePicker";
// Needs controls: the decision View (a native select) and the Filters disclosure, both inside the
// queue card's header. One surface at every
// width — no rail, no drawer, no modal. Scope lives in the URL; this file only draws it, from the
// same effective projection the list request uses.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "../../api/client";
import { useScope } from "../../api/scope";
import { useUrlState } from "../../lib/hooks";
import { useUser } from "../../shell/UserContext";
import { Select } from "../../ui/atoms/Select";
import { Switch } from "../../ui/atoms/Switch";
import { RepoFilter } from "../../ui/molecules/RepoFilter";
import { loadScope, restorePatch, saveScope, scopeOf } from "./savedScope";
import {
  ALL_SCOPE_VIEWS, VIEW_LABEL, VIEW_OPTIONS, ageOptions, clearScopePatch, compatValues, hasRawScope, multiLabel, multiSelectValue,
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

/**
 * Saves the View and scope after a change made with these controls (`changed()` marks one). Any other arrival at a URL
 * without either (the nav link, Back) brings the saved ones back, replacing the entry; a shared link is never saved
 * until it is changed. With a pick the shell first writes the pick's `repo`; restoring waits for it, so neither write
 * overwrites the other.
 */
function useSavedScope(): () => void {
  const { login } = useUser();
  const pick = useScope();
  const { search, update } = useUrlState();
  const dirty = useRef(false);
  useLayoutEffect(() => {
    if (dirty.current) {
      dirty.current = false;
      saveScope(login, scopeOf(search, pick));
      return;
    }
    if (pick && !new URLSearchParams(search).has("repo")) return;
    const patch = restorePatch(search, loadScope(login), pick);
    if (patch) update(patch, { replace: true });
  }, [search, login, pick, update]);
  return () => void (dirty.current = true);
}

/** The View select and the inline Filters panel for the decisions queue. */
export function NeedsControls() {
  const changed = useSavedScope();
  const { filter, setFilter: setFilterNow, search, update: updateNow } = useDecisionFilter();
  const setFilter: typeof setFilterNow = (...args) => (changed(), setFilterNow(...args));
  const update: typeof updateNow = (...args) => (changed(), updateNow(...args));
  const scope = useMemo(() => parseScope(search, KINDS), [search]);
  const [open, setOpen] = useState(false);
  const view = viewOf(filter.status);
  const active = scopeCount(scope, view);
  const repos = useQuery("repos", (api) => api.repos());
  const patch = (value: Record<string, string | null>) => setFilter(value, { replace: false });
  const chips = compatValues(scope);
  const kind = scope.kind;
  const kindValue = multiSelectValue(kind);
  const kindOptions: [string, string][] = [["", "Any kind"], ...ASKED_KINDS.map((k) => [k, kindLabel(k)] as [string, string])];
  const withCurrent = (options: [string, string][], value: string, label: string): [string, string][] =>
    value && !options.some(([v]) => v === value) ? [[value, label], ...options] : options;
  const remove = (chip: CompatValue) => update(chip.key === "age" ? removeRawAgePatch() : removeRawScopePatch(search, chip.key, chip.value), { replace: false });
  // Each control stacks under its label at the column's full width, so the panel has one edge and one rhythm.
  const label = "text-xs font-semibold text-ink/80";
  const control = "h-9 w-full px-2 py-1.5 text-xs max-md:h-11";
  return <div className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label className="inline-flex min-w-0 items-center gap-2 text-xs text-ink/85">
        <span>View</span>
        <Select aria-label="Decision view" value={view} onChange={(event) => patch({ tab: event.target.value === "open" ? null : event.target.value })} className="h-9 w-28 text-xs max-md:h-11">
          {VIEW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </label>
      <button type="button" aria-expanded={open} aria-controls="needs-filters-panel" onClick={() => setOpen((was) => !was)}
        className="inline-flex h-9 shrink-0 items-center justify-center rounded border border-line-strong bg-raised px-3 text-sm text-ink/80 hover:bg-ink/[0.06] max-md:h-11">
        Filters{active ? ` (${active})` : ""}
      </button>
    </div>
    <div id="needs-filters-panel" hidden={!open} className="mt-3 border-t border-line pt-3">
      <div className="grid gap-3">
        <UnlessProject>
          <RepoFilter options={repos.data ?? []} value={scope.repo} loading={repos.loading} onChange={(next) => patch({ repo: next.length ? next.join(",") : null })} />
        </UnlessProject>
        <label className="grid gap-1.5"><span className={label}>Kind</span>
          <Select value={kindValue} onChange={(event) => patch({ kind: event.target.value || null })} className={control}>
            {withCurrent(kindOptions, kindValue, multiLabel(kind.map(kindLabel))).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
        <label className="grid gap-1.5"><span className={label}>Waiting at least</span>
          <Select value={scope.minAge ? String(scope.minAge) : ""} onChange={(event) => patch({ age: event.target.value || null })} className={control}>
            {ageOptions(scope.minAge).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </label>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className={label}>Include all questions</span>
            <p className="m-0 text-2xs leading-4 text-ink/60">{ALL_SCOPE_VIEWS.map((v) => VIEW_LABEL[v]).join(" and ")} only</p>
          </div>
          <Switch on={scope.all} onChange={(on) => patch({ all: on ? "1" : null })} label="Include all questions" />
        </div>
        {chips.length > 0 && <ul aria-label="Scope values from this link" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {chips.map((chip) => <li key={`${chip.key}:${chip.value}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-2xs text-ink/70">
            <span className="min-w-0 break-words">{chip.label}</span>
            <button type="button" aria-label={`Remove ${chip.label} from the scope`} onClick={() => remove(chip)} className="shrink-0 px-0.5 text-ink/60 hover:text-ink">×</button>
          </li>)}
        </ul>}
      </div>
      {(active > 0 || hasRawScope(scope)) && <div className="mt-3 border-t border-line pt-2.5">
        <button type="button" onClick={() => setFilter(clearScopePatch(), { replace: false })} className="text-xs text-accent-ink hover:underline max-md:min-h-11">
          Clear scope{active ? ` (${active})` : ""}
        </button>
      </div>}
    </div>
  </div>;
}
