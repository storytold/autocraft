// Items with a phase: the same browser, scoped to the status endpoint (phase, q, kind,
// repositories, Discord, cursor). State, classification, label and flag are locked, not faked.
// The rows are the same compact rows as the normal list; the expansion states what this payload
// does not carry instead of inventing a classification.
import { useMemo } from "react";
import { usePagedQuery, useQuery } from "../../api/client";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Button } from "../../ui/atoms/Button";
import { Page } from "../../ui/organisms/Page";
import { num } from "../../lib/format";
import { useUser } from "../../shell/UserContext";
import { usePageProject } from "../../api/scope";
import { BrowserChrome, EmptyResults, type BrowserProps } from "./ItemFilters";
import { ItemRow, OpenRowDetail, SelectionUnavailable } from "./ItemRows";
import { factsFromStatusRow, refKey, selectionProblem } from "./rows";
import { useDisplayRows } from "./rowContinuity";
import { statusFilter } from "./browseState";

/** Phase mode: the status endpoint behind the same toolbar, rows and inline expansion. */
export function PhaseItems({ browse, phone, onPatch, search, author, onClearPhase, onReset, onRemove, selection, onToggleRow, onCloseSelection, selectionNote, resetKey, continuity }: BrowserProps) {
  const user = useUser();
  const project = usePageProject();
  const scope = JSON.stringify([user.login, user.role, project]);
  const filter = statusFilter(browse);
  const queryScope = JSON.stringify([scope, filter]);
  const { pages: receipts, error, loading, refetch, hasMore, loadingMore, loadMore } = usePagedQuery(
    `items-status:${queryScope}`,
    async (api, cursor) => ({ scope: queryScope, page: await api.itemStatusList({ ...filter, cursor }) }),
    (receipt) => receipt.page.nextCursor,
  );
  const { data: repoOptions } = useQuery("repos", (api) => api.repos());
  // Every loaded page must carry this reader's scope; anything else is the previous reader's data.
  const pages = !error && receipts && receipts.every((receipt) => receipt.scope === queryScope) ? receipts.map((receipt) => receipt.page) : undefined;
  const firstPage = pages?.[0];
  const ready = !!firstPage;
  const first = firstPage;
  const rows = ready ? pages?.flatMap((page) => page.rows) ?? [] : [];
  const facts = useMemo(() => rows.map(factsFromStatusRow), [rows]);
  const display = useDisplayRows(facts, ready, loading, error, continuity);
  const total = first && browse.phase ? first.byPhase[browse.phase] : undefined;
  const settled = ready && !!first && !loading && !error;
  const problem = settled ? selectionProblem(selection, facts.map((row) => row.key)) : null;
  const bar = ready && !loading && total !== undefined
    ? <>Filtered view · {num(total)} {total === 1 ? "item" : "items"} in {browse.phase} · counts include the search, type and repository filters</>
    : undefined;
  return <Page title="Items" sub={ready && !loading && total !== undefined ? `${num(total)} ${total === 1 ? "item" : "items"}` : undefined}>
    <BrowserChrome browse={browse} repos={repoOptions ?? []} phone={phone} phaseCounts={first?.byPhase} onPatch={onPatch} search={search} author={author} onClearPhase={onClearPhase} onReset={onReset} onRemove={onRemove} resetKey={resetKey} bar={bar} hasRows={display.rows.length > 0}>
      {error && <div className="flex items-center gap-2 px-4 py-3" role="alert"><ErrorLine error={error.message || "Could not read these items."} /><Button variant="ghost" size="sm" onClick={refetch}>Retry</Button></div>}
      {!ready && !error && !display.retained && <p role="status" className="px-4 py-6 text-sm text-ink/50">Loading items…</p>}
      {display.retained && <p role="status" className="sr-only">Loading items…</p>}
      {!loading && first && !rows.length && !error && !problem && <EmptyResults onReset={onReset} />}
      {problem && <SelectionUnavailable {...problem} onClose={onCloseSelection} />}
      {display.rows.length > 0 && <>
        <ul aria-label="Items" aria-busy={!ready || loading} ref={(node) => { if (node) node.inert = display.retained; }} className="m-0 list-none p-0">
          {display.rows.map((row) => <ItemRow key={row.key} facts={row} open={!display.retained && !!selection.open && refKey(selection.open) === row.key} onToggle={() => { if (!display.retained && ready) onToggleRow({ repo: row.repo, number: row.number }); }}>
            {!display.retained && selection.open && refKey(selection.open) === row.key && <OpenRowDetail facts={row} note={selectionNote} />}
          </ItemRow>)}
        </ul>
        {!display.retained && ready && <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2 text-xs text-ink/55"><span className="num">{rows.length} of {num(total ?? rows.length)}</span>{hasMore && <Button loading={loadingMore} onClick={loadMore} className="max-md:h-11">Load more</Button>}</div>}
      </>}
    </BrowserChrome>
  </Page>;
}
