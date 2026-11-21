import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { usePageProject } from "../../api/scope";
import { Button } from "../../ui/atoms/Button";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { useApi } from "../../api/client";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { Decision, DecisionList } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { cn } from "../../ui/cn";
import { ago } from "../../lib/format";
import { DecisionTools } from "./DecisionTools";
import { AnswerNotice } from "./AnswerNotice";
import { KIND_LABEL, KINDS, useDecisionFilter, useLocal, type DecisionListQuery } from "./state";
import { ageTitle, compactAge, metaFacts, refText, selectedFor, stepIndex } from "./rows";
import { clamp, resolveRestore, type QueueHandle, type Snapshot } from "./selection";
import { useNow } from "../../lib/useNow";
import { decisionPath } from "../../lib/links";
import { canComment } from "../../registry/permissions";

export function summaryLine(data: DecisionList | undefined) {
  if (!data) return "";
  const parts = KINDS.filter((k) => data.byKind[k]).map((k) => `${data.byKind[k]} ${KIND_LABEL[k].toLowerCase()}`);
  return parts.join(" · ");
}

/** Scroll offset of the phone list, kept while a decision is open on top of it. */
let phoneListScroll = 0;
/** The row the reader last chose on a phone, so returning from the workflow lands on it. */
let phoneSelected: string | undefined;

export interface ControlledQueue {
  /** The full collision-safe scope the surface renders (login, role and the projected list search). */
  scope: string;
  /** The parent-owned cursor (the row the keyboard is on). */
  cursorId: string | undefined;
  /** The active decision: the requested id when loaded, else the retained/first cursor. */
  activeId: string | undefined;
  /** An explicit selection request exists (valid or not): aria-current follows activeId only. */
  explicitSelection: boolean;
  onCursor: (id: string) => void;
  onActivate: (id: string) => void;
  onVisibleListScroll: (snapshot: Omit<Snapshot, "captureVersion">) => void;
  onReady: (handle: QueueHandle, readyScope: string) => void;
  onDetach: (snapshot: Snapshot | undefined) => void;
  onQueueKeyDown: (event: React.KeyboardEvent) => void;
  /** The surface-owned layout epoch the producer copies into every capture. */
  layoutEpoch: number;
  onOpenItem: (id: string) => void;
}

export function InboxList({ user, phone, query, header, controlled }: ViewProps & { phone?: boolean; query: DecisionListQuery; /** Optional header content (the Needs controls) drawn inside the queue card's header block. */ header?: ReactNode; controlled?: ControlledQueue }) {
  useNow();
  const { data: rawData, loading, hasMore, loadMore, loadingMore, error, refetch } = query;
  const failed = error !== undefined && error !== null;
  const data = failed ? undefined : rawData;
  const navigate = useNavigate();
  const api = useApi();
  const { peek, setPeek, filter, search } = useDecisionFilter();
  const loc = useLocal();
  const list = data?.decisions ?? [];
  const project = usePageProject();
  // One committed display snapshot, never query receipts, cursors or selection authority.
  // Changing reader capabilities or repository context clears it before it can render.
  const displayOwner = JSON.stringify([user, project, filter.repo ?? []]);
  const previousRows = useRef<{ owner: string; rows: Decision[] } | null>(null);
  if (previousRows.current?.owner !== displayOwner) previousRows.current = null;
  useLayoutEffect(() => {
    if (failed) previousRows.current = null;
    else if (data && !loading) previousRows.current = { owner: displayOwner, rows: data.decisions };
  }, [displayOwner, data, loading, failed]);
  const pending = !data && !failed;
  const showPrevious = pending && previousRows.current?.owner === displayOwner && previousRows.current.rows.length > 0;
  const displayList = showPrevious ? previousRows.current!.rows : list;
  const [internalId, setId] = useState<string | undefined>(phone ? phoneSelected : undefined);
  const id = controlled ? controlled.cursorId : internalId;
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const summaryRef = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const latest = useRef(controlled);
  latest.current = controlled;   // the handle and READY always read the CURRENT controlled context
  // it once mounted, so an unmounted queue is never asked for state (the parent keeps the snapshot).
  // The surface's latest controlled props: the handle must capture the CURRENT scope/cursor, never the
  // mount-time closure.
  const handle = useRef<QueueHandle>(null as unknown as QueueHandle);
  if (!handle.current) {
    handle.current = {
      capture: () => {
        const el = scroller.current;
        const current = latest.current;
        if (!el || !current) return undefined;
        // Bounded O(1) read: the known cursor row's identity + its relative position + the absolute offset,
        // all measured in this one read, with the layout epoch the producer currently has.
        const cursorId = current.cursorId;
        const row = cursorId ? rowRefs.current.get(cursorId) : undefined;
        const offset = toolsOpenRef.current ? anchor.current : el.scrollTop;
        const relTop = row ? (row.closest("li") ?? row).getBoundingClientRect().top - el.getBoundingClientRect().top : 0;
        return {
          scope: current.scope,
          chosenId: cursorId,
          captureEpoch: latest.current?.layoutEpoch ?? 0,
          anchor: row && cursorId && !toolsOpenRef.current
            ? { kind: "row", id: cursorId, relTop, fallbackOffset: offset, measuredEpoch: latest.current?.layoutEpoch ?? 0 }
            : { kind: "offset", offset, measuredEpoch: latest.current?.layoutEpoch ?? 0 },
        } as Snapshot;
      },
      restore: (snapshot: Snapshot) => {
        const el = scroller.current;
        if (!el) return;
        const target = resolveRestore(snapshot, rowRefs.current as unknown as Map<string, unknown>, el.scrollHeight - el.clientHeight);
        if (!target) return;
        if (target.kind === "offset") { el.scrollTop = target.offset; return; }
        const row = rowRefs.current.get(target.id);
        if (!row) { el.scrollTop = clamp(snapshot.anchor.kind === "row" ? snapshot.anchor.fallbackOffset : snapshot.anchor.offset, el.scrollHeight - el.clientHeight); return; }
        const delta = (row.closest("li") ?? row).getBoundingClientRect().top - el.getBoundingClientRect().top - target.relTop;
        el.scrollTop = clamp(el.scrollTop + delta, el.scrollHeight - el.clientHeight);
      },
      focusRow: (rowId: string | undefined, reveal: boolean) => {
        const row = rowId ? rowRefs.current.get(rowId) : undefined;
        if (!row) return false;
        row.focus({ preventScroll: true });
        if (reveal) (row.closest("li") ?? row).scrollIntoView({ block: "nearest" });
        return true;
      },
    };
  }
  // Controlled: aria-current follows the parent’s active id (undefined for an unavailable request).
  // Uncontrolled (kept for other hosts): the first/retained row.
  const selected = controlled ? controlled.activeId : selectedFor(list, internalId);
  const decision = list.find((d) => d.id === selected);
  // The panel is bound to the row and scope it was opened for, computed in render: a changed row,
  // cohort or reader simply stops matching and the panel closes — it can never be briefly retargeted.
  const [toolsFor, setToolsFor] = useState<string | null>(null);
  const phoneRestore = useRef({ top: phoneListScroll, done: false });

  // Default the selection to the current cohort's first row, but never steal focus or scroll.
  useEffect(() => {
    if (selected && selected !== id) setId(selected);
  }, [selected, id]);

  // The panel is bound to the row and scope it was opened for, computed in render: a changed row,
  // cohort or reader stops matching and the panel closes, so open write controls can never retarget.
  const anchor = useRef(0);
  const toolsOpenRef = useRef(false);
  const scopeKey = `${user.login}:${user.role}:${search}`;
  const token = `${selected ?? ""}|${scopeKey}`;
  const toolsOpen = toolsFor !== null && toolsFor === token;
  // The anchor is captured by the explicit open (before any layout shifts), never by an effect.
  const setToolsOpen = (open: boolean) => {
    if (open && !toolsOpen) anchor.current = scroller.current?.scrollTop ?? 0;
    setToolsFor(open ? token : null);
  };
  const wasOpen = useRef(false);
  useEffect(() => { toolsOpenRef.current = toolsOpen; }, [toolsOpen]);

  // An explicit move focuses the chosen row AND reveals it inside the bounded scroller (focus alone,
  // with preventScroll, leaves an off-screen End/Home/j-k selection invisible). The passive default
  // never focuses or scrolls.
  const reveal = (nextId: string) => {
    const row = rowRefs.current.get(nextId);
    if (!row) return;
    row.focus({ preventScroll: true });
    (row.closest("li") ?? row).scrollIntoView({ block: "nearest" });
  };
  const select = (nextId: string, focus = true) => {
    if (controlled) { controlled.onActivate(nextId); return; }
    setId(nextId);
    if (phone) phoneSelected = nextId;
    if (focus) requestAnimationFrame(() => reveal(nextId));
  };
  const onListKey = (event: React.KeyboardEvent) => {
    if (controlled) { controlled.onQueueKeyDown(event); return; }
    const key = event.key;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    if (list.length === 0) return;
    event.preventDefault();
    const index = Math.max(0, list.findIndex((d) => d.id === selected));
    const next = list[stepIndex(list, index, key)];
    if (next) select(next.id);
  };

  // The old row activation, preserved exactly, reached only from the explicit Review-and-answer CTA.
  const open = (d: Decision) => {
    if (controlled) { controlled.onOpenItem(d.id); return; }
    if (!d.answer && canComment(user)) void api.decisions.claim(d.id).catch(() => undefined);
    navigate(decisionPath(d));
  };


  useLayoutEffect(() => {
    // Legacy phone restore is skipped in controlled mode: the surface owns one bridge.
    if (controlled) return;
    // The first page may arrive after mount. Restore only once, after rows can own the offset, and put
    // the remembered phone row back without focusing it (the reader is returning, not navigating).
    if (!phone || !data || loading || !scroller.current || phoneRestore.current.done) return;
    if (phoneSelected && id !== phoneSelected && list.some((d) => d.id === phoneSelected)) setId(phoneSelected);
    scroller.current.scrollTop = phoneRestore.current.top;
    phoneRestore.current.done = true;
  }, [phone, data, loading, id, list, controlled]);
  // Opening the tools keeps the list anchor, then brings the panel's TOP action block into the scroller
  // viewport (a tall panel scrolled with "nearest" can leave the Review CTA off-screen).
  useEffect(() => {
    if (toolsOpen) {
      wasOpen.current = true;
      requestAnimationFrame(() => {
        const panel = document.getElementById("decision-tools");
        const box = scroller.current;
        if (!panel || !box) return;
        // Geometry, not offsetTop: the panel's offset parent is not necessarily the scroller.
        const portTop = box.getBoundingClientRect().top;
        box.scrollTop += panel.getBoundingClientRect().top - portTop;
        // The panel top is preferred, but in a short port (a phone with the native Filters open) the
        // header pushes the action below it. Then bring the actual action block — marked in
        // DecisionTools — fully inside this same scroller, without touching focus or activating it.
        const action = panel.querySelector<HTMLElement>("[data-decision-action]");
        if (!action) return;
        const boxRect = box.getBoundingClientRect();
        const r = action.getBoundingClientRect();
        if (r.top >= boxRect.top && r.bottom <= boxRect.bottom) return;
        box.scrollTop += r.top - boxRect.top;
      });
      return;
    }
    // Closing (manual or a selection/cohort/reader change) restores the usable list anchor — but only
    // after the panel was actually open, so mounting never scrolls the list on its own.
    if (wasOpen.current) {
      wasOpen.current = false;
      if (scroller.current) scroller.current.scrollTop = anchor.current;
    }
  }, [toolsOpen]);
  const closeTools = () => {
    setToolsOpen(false);
    // Focus the summary without letting it move the list, then put the captured anchor back.
    requestAnimationFrame(() => {
      summaryRef.current?.focus({ preventScroll: true });
      if (scroller.current) scroller.current.scrollTop = anchor.current;
    });
  };
  // On a phone the list can stay mounted under the item page; when it becomes visible again at the
  // Needs route, put the bookmark back (the reader is returning, not navigating).
  const route = useLocation();
  useEffect(() => {
    if (controlled || !phone || !data || !scroller.current) return;
    if (route.pathname === "/needs" && phoneListScroll > 0 && scroller.current.scrollTop === 0) scroller.current.scrollTop = phoneListScroll;
  }, [controlled, phone, data, route.pathname]);
  // The surface learns the queue is READY once per scope, after the current receipt settled and rows exist.
  const readyScope = useRef<string | null>(null);
  const readyScheduled = useRef<string | null>(null);
  const readyFrame = useRef<number | null>(null);
  const mounted = useRef(false);
  const readyReceipt = useRef({ scope: controlled?.scope, settled: !!data && !loading && !error });
  readyReceipt.current = { scope: controlled?.scope, settled: !!data && !loading && !error };
  useEffect(() => {
    if (!controlled || !data || loading || error) return;
    if (readyScheduled.current === controlled.scope) return;
    if (readyFrame.current !== null) cancelAnimationFrame(readyFrame.current);
    readyScheduled.current = controlled.scope;
    // Re-renders keep the scheduled frame; only a newer scope or an unmount cancels it.
    const scope = controlled.scope;
    readyFrame.current = requestAnimationFrame(() => {
      readyFrame.current = null;
      const current = latest.current;
      const receipt = readyReceipt.current;
      if (!mounted.current || !scroller.current?.isConnected || !current || current.scope !== scope || !receipt.settled || receipt.scope !== scope) {
        if (readyScheduled.current === scope) readyScheduled.current = null;
        return;
      }
      readyScope.current = scope;
      current.onReady(handle.current, scope);
    });
  }, [controlled, data, loading, error]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (readyFrame.current !== null) cancelAnimationFrame(readyFrame.current);
      readyFrame.current = null;
      readyScheduled.current = null;
      // Layout cleanup runs before the scroller ref is detached, while a final capture is still possible.
      latest.current?.onDetach(handle.current.capture());
    };
  }, []);
  const oldest = data?.oldestAskedAt;
  // The header's fallback copy: a real summary wins (a valid same-scope snapshot keeps its counts);
  // otherwise a failed read is named as a failure — not as an empty match set — and only a settled,
  // successful, empty cohort reads "nothing matches".
  const summaryText = summaryLine(data) || (failed ? "could not read this queue" : pending ? (showPrevious ? "" : "loading…") : "nothing matches");
  const listLabel = filter.status === "answered" ? "Answered decisions" : filter.status === "backlog" ? "Backlog decisions" : filter.status === "snoozed" ? "Snoozed decisions" : filter.status === "opinions" ? "Decisions with opinions" : "Decisions waiting for you";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-line bg-panel">
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-line px-3.5 py-3.5">
        {header}
        <div className="flex min-h-6 items-center gap-2 text-xs">
          <span className="num shrink-0 whitespace-nowrap font-semibold text-ink">{data?.total ?? "–"} matches</span>
          <span className="truncate text-ink/50">{summaryText}</span>

          {oldest && <span className="ml-auto shrink-0 text-ink/50">oldest {ago(oldest)}</span>}
        </div>
      </div>
      {/* The persistent band: the tools summary, below the accepted header and above the scroller. */}
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-line px-3.5 text-xs">
        <button ref={summaryRef} type="button" aria-expanded={toolsOpen} aria-controls="decision-tools" disabled={!decision}
          onClick={() => setToolsOpen(!toolsOpen)}
          className="inline-flex min-h-8 items-center gap-1.5 rounded px-1 text-left text-ink/80 hover:text-ink disabled:opacity-50 max-md:min-h-11">
          <CaretRightIcon aria-hidden className={cn("text-xs transition-transform", toolsOpen && "rotate-90")} />
          Decision tools{decision ? ` · ${refText(decision)}` : ""}
        </button>
        {decision && <span className="truncate text-ink/45">{KIND_LABEL[decision.kind]}</span>}
      </div>
      {loc.justAnswered.map((a) => (
        <AnswerNotice key={a.id} entry={a} className="shrink-0 border-b border-line" />
      ))}
      {failed && <div className="shrink-0 border-b border-line bg-bad/[0.06] px-3.5 py-2 text-xs text-bad" role="alert">
        This list could not be read: {error?.message || "No error details were recorded."}
        <button type="button" onClick={() => refetch()} className="ml-2 underline underline-offset-2 hover:text-ink">Retry</button>
      </div>}
      <div ref={scroller} onScroll={(e) => { if (toolsOpenRef.current) return; const top = e.currentTarget.scrollTop; if (phone) phoneListScroll = top; controlled?.onVisibleListScroll({ scope: controlled.scope, chosenId: controlled.cursorId, captureEpoch: controlled.layoutEpoch, anchor: { kind: "offset", offset: top, measuredEpoch: controlled.layoutEpoch } }); }} className="min-h-0 flex-1 overflow-y-auto">
        {toolsOpen && decision && (
          <DecisionTools id="decision-tools" d={decision} loaded={list} user={user} peeked={peek === decision.id} allowBatch={!phone}
            onPreview={() => setPeek(peek === decision.id ? null : decision.id)} onReview={() => { setToolsOpen(false); open(decision); }} onClose={closeTools} />
        )}
        <ul aria-label={listLabel} aria-busy={loading} ref={(node) => { if (node) node.inert = showPrevious; }} onKeyDown={onListKey} className="m-0 list-none p-1.5">
          {displayList.map((d) => {
            const isSelected = !showPrevious && d.id === selected;
            const facts = metaFacts(d).filter((fact) => d.number === null || fact.key !== "ref");
            return <li key={d.id} className={cn("grid gap-1 rounded p-2.5", isSelected && "bg-raised shadow-[inset_2px_0_0_rgb(var(--st-accent-rgb))] ring-1 ring-line", peek === d.id && !showPrevious && "outline outline-1 -outline-offset-1 outline-accent/30")}>
              <div className="relative min-h-8 max-md:min-h-11">
                {d.number !== null
                  ? <ItemRef repo={d.repo} number={d.number} kind={d.shown?.kind} state={d.shown?.state} title={d.shown?.title ?? d.title} stretch className="font-medium" />
                  : <Link to={decisionPath(d)} className="break-words text-sm font-medium text-ink hover:underline">{d.title}</Link>}
              </div>
              <Button type="button" variant="ghost" size="sm" aria-current={isSelected ? "true" : undefined}
                disabled={showPrevious} tabIndex={!showPrevious && (controlled ? (controlled.cursorId ?? controlled.activeId) === d.id : isSelected) ? 0 : -1}
                ref={(node) => { if (node && !showPrevious) rowRefs.current.set(d.id, node); else rowRefs.current.delete(d.id); }}
                onClick={() => { if (!showPrevious) select(d.id); }}
                className="h-auto min-h-7 w-full flex-wrap justify-start whitespace-normal px-0 py-1 text-left font-normal max-md:min-h-11">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-ink/70">
                  {facts.map((fact, i) => <span key={fact.key} className="inline-flex min-w-0 items-center gap-1.5">
                    {i > 0 && <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-current opacity-60" />}
                    <span title={fact.title} className={cn("min-w-0 break-words", fact.key === "ref" && "font-mono text-2xs", fact.key === "answer" && fact.tone === "bad" && "font-medium text-bad", fact.key === "answer" && fact.tone === "warn" && "text-warn", fact.key === "answer" && fact.tone === "ok" && "text-ok")}>{fact.text}</span>
                  </span>)}
                </span>
                <span className="ml-auto shrink-0 text-ink/60" title={ageTitle(d.askedAt)}>{compactAge(d.askedAt)}</span>
                <span className="inline-flex items-center gap-1">Details<span className="sr-only"> for {refText(d)}</span> <CaretRightIcon aria-hidden /></span>
              </Button>
            </li>;
          })}
        </ul>
        {pending && !displayList.length && <p className="px-4 py-6 text-sm text-ink/50" role="status">Loading decisions…</p>}
        {data && !loading && !list.length && !error && <p className="px-4 py-16 text-center text-sm text-ink/60">Nothing waiting.</p>}
        {!data && error && <p className="px-4 py-16 text-center text-sm text-bad">No decisions could be read.</p>}
        {hasMore && data && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-ink/55">
            <span className="num">
              {data.decisions.length} of {data.total}
            </span>
            <button className="chip" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
