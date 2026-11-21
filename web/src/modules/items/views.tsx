// Items: one browser, one compact row per item, one inline expansion. The list endpoint serves the
// default view, the status endpoint only a phase link; both render the same row hierarchy and the
// same read-only detail. No table, no cards switch, no right-hand preview.
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useQuery } from "../../api/client";
import type { ViewProps } from "../../registry/types";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Button } from "../../ui/atoms/Button";
import { Pager } from "../../ui/molecules/Pager";
import { Page } from "../../ui/organisms/Page";
import { num } from "../../lib/format";
import { useMedia } from "../../shell/useMedia";
import { useUser } from "../../shell/UserContext";
import { usePageProject } from "../../api/scope";
import { useUrlState } from "../../lib/hooks";
import { BrowserChrome, EmptyResults, type BrowserProps } from "./ItemFilters";
import { ItemRow, OpenRowDetail, SelectionUnavailable } from "./ItemRows";
import { PhaseItems } from "./StatusItems";
import { useRowContinuity, useDisplayRows } from "./rowContinuity";
import { useDraftField } from "./useDraftField";
import {
  aliasHref, clearPhasePatch, historyOptions, isActive, itemFilter, parseBrowse, removeValuePatch, resetPatch,
} from "./browseState";
import {
  conflictNote, factsFromListRow, parseSelection, refKey, scopedPayload, selectionPatch, selectionProblem, type OpenRef,
} from "./rows";

/** Old links land in the one browser; the alias is not a second view. */
export function ItemsFiltersAlias() {
  const { search } = useLocation();
  return <Navigate replace to={aliasHref(search)} />;
}

export function ItemsView(_: ViewProps) {
  const { update, search: liveSearch } = useUrlState();
  const [resetVersion, setResetVersion] = useState(0);
  // A popstate (Back/Forward) is the only thing that may replace a typed draft: a router's
  // navigation type can still read "POP" for a moment after a push, which would drop live typing.
  const [pops, setPops] = useState(0);
  useEffect(() => {
    const onPop = () => setPops((count) => count + 1);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const browse = useMemo(() => parseBrowse(liveSearch), [liveSearch]);
  const selection = useMemo(() => parseSelection(liveSearch), [liveSearch]);
  const user = useUser();
  const project = usePageProject();
  const continuity = useRowContinuity(JSON.stringify([user, project, browse.repos]));
  // Scoped to the link's own selection: the ignored peek is only named while that open row is the
  // one on screen, so a later row, close, filter, reset, paging or typing never inherits the note.
  const [conflict, setConflict] = useState<{ peek: string; openKey: string } | null>(null);
  const phone = useMedia("(max-width: 860px)");
  const resetKey = `${resetVersion}:${pops}`;

  // A legacy peek link is the same selection under its old name: replace it with `open` (no extra
  // history) and keep every other key; a conflicting peek is dropped and named in the open row.
  useEffect(() => {
    if (selection.aliasPeek) update(selectionPatch(selection.aliasPeek), historyOptions("alias"));
    else if (selection.ignoredPeek && selection.open) {
      setConflict({ peek: selection.ignoredPeek, openKey: refKey(selection.open) });
      update({ peek: null }, historyOptions("alias"));
    }
  }, [selection.aliasPeek, selection.ignoredPeek, selection.open, update]);
  const selectionNote = conflict && selection.open && refKey(selection.open) === conflict.openKey
    ? conflictNote(conflict.peek)
    : undefined;

  const closesSelection = { open: null, peek: null };
  const onPatch = (patch: Record<string, string | null>) => {
    const leavesPhase = browse.phase !== undefined && ["state", "label", "status", "flag"].some((key) => key in patch);
    update({ ...patch, offset: patch.offset ?? null, peek: null, open: null, ...(leavesPhase ? { phase: null } : {}) }, historyOptions("filter"));
  };
  const onToggleRow = (ref: OpenRef) => {
    const same = selection.open && refKey(selection.open) === refKey(ref);
    update(selectionPatch(same ? null : ref), historyOptions("open"));
  };
  const onCloseSelection = () => update(closesSelection, historyOptions("open"));
  const onOffset = (offset: string | null) => update({ offset, ...closesSelection }, historyOptions("paging"));
  const onSearch = (q: string) => update({ q: q || null, sort: null, offset: null, ...closesSelection }, historyOptions("search"));
  const onAuthor = (author: string | null) => update({ author, offset: null, ...closesSelection }, historyOptions("author"));
  const onClearPhase = () => update(clearPhasePatch(), historyOptions("clear-phase"));
  const onReset = () => { setResetVersion((version) => version + 1); update(resetPatch(), historyOptions("reset")); };
  const onRemove = (key: string, value: string) => update({ ...removeValuePatch(browse, key, value), offset: null, ...closesSelection }, historyOptions("remove"));

  const searchDraft = useDraftField({ value: browse.q ?? "", commit: onSearch, resolveKey: resetKey });
  const authorDraft = useDraftField({ value: browse.author ?? "", commit: onAuthor, resolveKey: resetKey });
  const props: Omit<BrowserProps, "browse"> = {
    continuity, phone, onPatch, onOffset, search: searchDraft, author: authorDraft,
    onClearPhase, onReset, onRemove, selection, onToggleRow, onCloseSelection, selectionNote, resetKey,
  };
  return browse.phase ? <PhaseItems browse={browse} {...props} /> : <ListItems browse={browse} {...props} />;
}

/** Default mode: the list endpoint's rows, one inline expansion for the selected item. */
function ListItems({ browse, phone, onPatch, onOffset, search, author, onClearPhase, onReset, onRemove, selection, onToggleRow, onCloseSelection, selectionNote, resetKey, continuity }: BrowserProps) {
  const user = useUser();
  // The list payload carries the classification's provenance, including the referee's reason the
  // server redacts per role. The cache key therefore names the reader as well as the filter, and a
  // payload is rendered only when it arrived for *this* reader: a filter change keeps the previous
  // rows (same scope), a login/role change shows the rows again only once its own receipt lands.
  const project = usePageProject();
  const scope = JSON.stringify([user.login, user.role, project]);
  const filter = useMemo(() => itemFilter(browse), [browse]);
  const queryScope = JSON.stringify([scope, filter]);
  // The receipt carries the reader it was fetched for: a payload from another scope is discarded,
  // so the previous reader's rows — and the redacted-per-role provenance in them — never render.
  const { data: receipt, error, loading, refetch } = useQuery(
    `items:${queryScope}`,
    async (api) => ({ scope: queryScope, payload: await api.items(filter) }),
    { gcTime: 0 },
  );
  const data = error ? undefined : scopedPayload(receipt, queryScope);
  const ready = !!data;
  const { data: repos } = useQuery("repos", (api) => api.repos());
  const rows = ready ? data?.rows ?? [] : [];
  const facts = useMemo(() => rows.map(factsFromListRow), [rows]);
  const display = useDisplayRows(facts, ready, loading, error, continuity);
  // Once the current results are settled, a selection that cannot open stays explicit — including
  // when the cohort is empty. Loading, a previous cohort and errors are not called "not found".
  const settled = ready && !!data && !loading && !error;
  const problem = settled ? selectionProblem(selection, facts.map((row) => row.key)) : null;
  const bar = isActive(browse) && data && !loading
    ? <>Filtered view · {num(data.total)} {data.total === 1 ? "item" : "items"}{browse.status.length ? ` of ${num(Object.values(data.byStatus).reduce((sum, count) => sum + count, 0))}` : ""} · {num(data.byStatus.settled)} settled, {num(data.byStatus.waiting)} waiting for a second opinion, {num(data.byStatus.disagree)} disagreements, {num(data.byStatus.unclassified)} not classified{data.run ? ` (run ${data.run})` : ""}</>
    : undefined;
  return <Page title="Items" sub={ready && data && !loading ? `${num(data.total)} ${data.total === 1 ? "item" : "items"}` : undefined}>
    <BrowserChrome browse={browse} repos={repos ?? []} phone={phone} onPatch={onPatch} search={search} author={author} onClearPhase={onClearPhase} onReset={onReset} onRemove={onRemove} resetKey={resetKey} bar={bar} hasRows={display.rows.length > 0}>
      {error && <div className="flex items-center gap-2 px-4 py-3" role="alert"><ErrorLine error={error.message || "Could not read these items."} /><Button variant="ghost" size="sm" onClick={refetch}>Retry</Button></div>}
      {!ready && !error && !display.retained && <p role="status" className="px-4 py-6 text-sm text-ink/50">Loading items…</p>}
      {display.retained && <p role="status" className="sr-only">Loading items…</p>}
      {problem && <SelectionUnavailable {...problem} onClose={onCloseSelection} />}
      {data && !rows.length && !problem && <EmptyResults onReset={onReset} />}
      {display.rows.length > 0 && <ul aria-label="Items" aria-busy={!ready || loading} ref={(node) => { if (node) node.inert = display.retained; }} className="m-0 list-none p-0">
        {display.rows.map((row) => <ItemRow key={row.key} facts={row} open={!display.retained && !!selection.open && refKey(selection.open) === row.key} onToggle={() => { if (!display.retained && ready) onToggleRow({ repo: row.repo, number: row.number }); }}>
          {!display.retained && selection.open && refKey(selection.open) === row.key && <OpenRowDetail facts={row} note={selectionNote} />}
        </ItemRow>)}
      </ul>}
      {data && <Pager offset={filter.offset ?? 0} limit={filter.limit ?? 50} total={data.total} onOffset={(offset) => onOffset(offset ? String(offset) : null)} />}
    </BrowserChrome>
  </Page>;
}
