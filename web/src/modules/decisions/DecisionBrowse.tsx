// The Decisions surface of Needs you: the queue card, the selected-decision frame, ONE surface keyboard
// controller and the native preview. One list observer; the frame is list-backed and passive. The surface is the
// single bookmark owner (capture producer behind the child's handle, one restore per READY) and owns the FOCUS
// clock, which is independent of bookmark captures.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useLiveLocation } from "../../lib/hooks";
import type { ViewProps } from "../../registry/types";
import { useMedia } from "../../shell/useMedia";
import { useUser } from "../../shell/UserContext";
import type { Decision } from "../../api/types";
import { BrowseLayout } from "../../ui/organisms/BrowseLayout";
import { DecisionDetail } from "./DecisionDetail";
import { DecisionAnswer } from "./DecisionAnswer";
import { getScope, projectOf, usePageProject } from "../../api/scope";
import { reviewDecision } from "./review.ts";
import { useApi } from "../../api/client.ts";
import { DecisionPreview } from "./DecisionPreview";
import { InboxList, type ControlledQueue } from "./InboxList";
import { NeedsControls } from "./Toolbar";
import { localActions, useDecisionFilter, useDecisionList, useLocal, useUndo } from "./state";
import { MultiAnswer } from "./MultiAnswer";
import {
  acceptCapture, captureSnapshot, clearSnapshotFor, commitChangesId, focusAllows, liveDecisionId, liveScopeOf, readDecisionParam, resolveActive, scopeOf,
  snapshotFor, type FocusIntent, type QueueHandle, type Snapshot,
} from "./selection";
import { useNeedsQueueKeys } from "./useNeedsQueueKeys";

const supportsCqh = () => typeof CSS !== "undefined" && !!CSS.supports && CSS.supports("container-type", "size") && CSS.supports("height", "100cqh");

type FocusTarget = { kind: "row"; id: string; reveal: boolean } | { kind: "title"; whenHidden: boolean } | { kind: "nativeView" };

export function DecisionBrowse({ phone, ...props }: ViewProps & { phone?: boolean }) {
  const user = useUser();
  const api = useApi();
  const navigate = useNavigate();
  const readLocation = useLiveLocation();
  const undo = useUndo();
  const { peek, setPeek, decision, setDecision, clearPeek, update, filter, search } = useDecisionFilter();
  const query = useDecisionList();
  const queueError = query.error ? query.error.message || "Could not read this queue." : undefined;
  const loc = useLocal();
  // Failed receipts confer no selection, keyboard or review authority, just as in the queue.
  const rows = query.error ? [] : query.data?.decisions ?? [];
  const requested = decision;
  const project = usePageProject();
  const scopeKey = scopeOf({ login: user.login, role: user.role, search, project });
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  // The CURRENT reader (login/role) as a live ref: intent arming and execution must both read it, so a genuine
  // reader change never leaves a mount-time reader in a pending intent.
  const readerRef = useRef({ login: user.login, role: user.role });
  // The handoff reads current identity and guarded rows, never a stale queue callback's snapshot.
  const fullUserRef = useRef(user); fullUserRef.current = user;
  const receiptRef = useRef({ rows, loading: query.loading, error: queueError });
  receiptRef.current = { rows, loading: query.loading, error: queueError };
  const cursorRef = useRef<string | undefined>(undefined);
  readerRef.current = { login: user.login, role: user.role };
  // Mutation-time facts: the LIVE canonical scope (projected with the CURRENT reader) and primary id, plus receipt.
  const liveFacts = useCallback(() => {
    const reader = readerRef.current;
    const { pathname, search } = readLocation();
    return {
      scope: liveScopeOf(search, reader.login, reader.role, projectOf(pathname, search, getScope())),
      id: liveDecisionId(search),
    };
  }, [readLocation]);
  const receipt = useRef({ rows, loading: query.loading });
  receipt.current = { rows, loading: query.loading };

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const activeId = resolveActive(requested, rows, cursor);
  cursorRef.current = cursor;
  const selected = rows.find((r) => r.id === activeId);
  const narrow = useMedia("(max-width: 860px)");
  // An unloaded bookmark must leave pagination reachable; it becomes a detail once its page arrives.
  const queueHidden = narrow && !peek && (requested.kind === "unavailable" || (requested.kind === "requested" && !!selected));
  const queueHiddenRef = useRef(false);
  queueHiddenRef.current = queueHidden;

  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (page.current) ownedOuterRoot.current = page.current.closest("[data-browse-layout]") ?? ownedOuterRoot.current; }, []);
  const queueHandle = useRef<QueueHandle | null>(null);
  const restoredFor = useRef<string | null>(null);
  const [readyTick, setReadyTick] = useState(0);
  const [titleTick, setTitleTick] = useState(0);
  /** The single pending restoration (armed only when a commit unmounts the queue). */
  const pendingRestore = useRef<Snapshot | null>(null);
  /** The layout epoch the surface last saw from READY; captures compare against it. */
  const layoutEpoch = useRef(0);
  /** A viewport transition (resize) is event-driven: resize starts it, the owner's ResizeObserver settles it. */
  const resizing = useRef(false);

  // FOCUS clock: monotonic and entirely separate from the bookmark's captureVersion.
  const focusVersion = useRef(0);
  const intent = useRef<(FocusIntent & { target: FocusTarget }) | null>(null);
  const ownedOuterRoot = useRef<Element | null>(null);
  // Owned identity is the EXACT cached element captured at mount: an ancestor that merely contains the private
  // page is not it, and the event target is never passed as its own "owned" root.
  const isOwnedRoot = (target: Element | null): target is Element => !!target && target === ownedOuterRoot.current;

  /** Resolve only the current scope's row before explicitly opening the native item form. */
  const readCurrentFacts = useCallback(() => {
    const currentUser = fullUserRef.current;
    const { pathname, search: liveSearch } = readLocation();
    const liveScope = liveScopeOf(liveSearch, currentUser.login, currentUser.role, projectOf(pathname, liveSearch, getScope()));
    const parsed = readDecisionParam(liveSearch);
    const state = receiptRef.current;
    const coherent = liveScope === scopeKeyRef.current;
    const currentRows = coherent ? state.rows : [];
    const selectedId = resolveActive(parsed, currentRows, cursorRef.current);
    return {
      user: currentUser, scopeKey: liveScope, requestedIdentity: JSON.stringify(parsed),
      row: currentRows.find((row) => row.id === selectedId),
      loading: state.loading, error: state.error, coherent,
    };
  }, [readLocation]);
  const focusTitle = useCallback(() => {
    const owner = page.current;
    const title = owner?.querySelector<HTMLElement>("#detail-title") ?? owner?.querySelector<HTMLElement>("[data-detail-title]") ?? null;
    title?.focus({ preventScroll: true });
  }, []);
  const openItem = useCallback((d: Decision | undefined) => {
    if (!d) return;
    const live = readCurrentFacts();
    if (!live.coherent || live.loading || live.error || live.row?.id !== d.id) return;
    if (live.scopeKey !== scopeKey || live.requestedIdentity !== JSON.stringify(requested)) return;
    if (live.user.login !== user.login || live.user.role !== user.role) return;
    reviewDecision(live.row, live.user, (id) => api.decisions.claim(id), navigate);
  }, [api, navigate, user, scopeKey, requested, readCurrentFacts]);

  const cancelIntent = useCallback(() => {
    focusVersion.current += 1;
    intent.current = null;
  }, []);

  const armIntent = useCallback((target: FocusTarget) => {
    focusVersion.current += 1;
    const live = liveFacts();
    intent.current = {
      target,
      focusIntentVersion: focusVersion.current,
      intentScope: live.scope,
      intentUriId: live.id,
      targetOwnerId: "needs-decisions",
    };
  }, [liveFacts]);

  // A reader/filter change clears a bookmark and intents from another scope (local state only; the raw URI stays).
  useEffect(() => { clearSnapshotFor(scopeKey); cancelIntent(); }, [scopeKey, cancelIntent]);

  /** The primary commit. */
  const commit = useCallback((id: string, reason: "activate" | "arrow") => {
    const snapshot = queueHandle.current?.capture();
    if (snapshot) {
      // The anchor and its identity are captured together; only the chosen id is ours to set.
      const chosen: Snapshot = { ...snapshot, chosenId: id };
      captureSnapshot({ scope: chosen.scope, chosenId: id, captureEpoch: chosen.captureEpoch, anchor: chosen.anchor });
      // A compact commit unmounts the queue: that is the only case that arms a restoration.
      pendingRestore.current = narrow ? chosen : null;
    }
    const uriId = liveFacts().id;
    if (commitChangesId(uriId, id)) setDecision(id, { clearPeek: true, replace: reason === "arrow" });
    else if (peek) clearPeek();
    setCursor(id);
    if (reason === "activate" || narrow) { armIntent({ kind: "title", whenHidden: false }); setTitleTick((n) => n + 1); }
    else armIntent({ kind: "row", id, reveal: true });
  }, [narrow, peek, clearPeek, setDecision, armIntent, liveFacts]);

  /** Close: a known row returns to it; an unavailable selection falls back to the native Decision view. */
  const closeSelection = useCallback(() => {
    const id = activeId;
    const live = queueHandle.current?.capture();
    const known = live ?? snapshotFor(scopeKey);
    if (known) {
      pendingRestore.current = queueHidden ? known : null;
      captureSnapshot({ scope: known.scope, chosenId: known.chosenId, captureEpoch: known.captureEpoch, anchor: known.anchor });
    }
    if (requested.kind !== "none") setDecision(null);
    armIntent(id ? { kind: "row", id, reveal: true } : { kind: "nativeView" });
  }, [activeId, requested, queueHidden, setDecision, armIntent, scopeKey]);

  const closePeek = useCallback(() => {
    // Arm BEFORE the native dialog unmounts: its return-focus event can be delivered during that unmount,
    // before a passive effect would run. The guard then validates the owned root, the live URI and the
    // focus clock before touching focus.
    if (narrow && requested.kind !== "none") {
      armIntent({ kind: "title", whenHidden: true });
      setTitleTick((n) => n + 1);
    }
    setPeek(null);
  }, [narrow, requested, armIntent, setPeek]);
  // After an explicit peek close the native dialog returns focus to the owned outer root; the guard redirects
  // exactly that event to the title, while the intent is still current.
  const prevPeek = useRef<string | null>(peek);
  useEffect(() => {
    const was = prevPeek.current;
    prevPeek.current = peek;
    if (!was || peek) return;
    if (!narrow || requested.kind === "none") return;
    // Fallback for a close that did not go through closePeek (e.g. a route-driven close).
    if (!intent.current) armIntent({ kind: "title", whenHidden: true });
    setTitleTick((n) => n + 1);
  }, [peek, narrow, requested, armIntent]);

  const controller = useNeedsQueueKeys({
    rows,
    activeId,
    cursorId: cursor ?? activeId,
    active: true,
    previewOpen: !!peek,
    onCursor: setCursor,
    onCommit: commit,
    previewAt: (id) => setPeek(id),
    onOpenItem: (id) => openItem(rows.find((r) => r.id === id)),
    onToggleCheck: () => { if (activeId) localActions.toggle(activeId); },
    onUndo: () => { void undo(); },
    onViewAnswered: () => update({ tab: filter.status === "answered" ? null : "answered", peek: null }),
    onEscape: () => {
      if (peek) { closePeek(); return; }                            // the native preview owns Escape first (REPLACE)
      if (requested.kind !== "none") { closeSelection(); return; }    // then the decision (PUSH)
      localActions.clearChecked();                                   // only then the batch checks
    },
  });

  // The SINGLE restore owner, once per mount/scope, on a READY naming the CURRENT scope.
  const onReady = useCallback((handle: QueueHandle, readyScope: string) => {
    queueHandle.current = handle;
    ownedOuterRoot.current = page.current?.closest("[data-browse-layout]") ?? ownedOuterRoot.current;
    layoutEpoch.current += 1;
    setReadyTick((n) => n + 1);
    if (readyScope !== scopeKey) return;
    if (restoredFor.current === scopeKey) return;
    restoredFor.current = scopeKey;
    // Restore ignores epochs: a same-scope bookmark stays valid across a layoutEpoch change.
    const snapshot = pendingRestore.current?.scope === scopeKey ? pendingRestore.current : snapshotFor(scopeKey);
    pendingRestore.current = null;
    if (!snapshot) { setCursor(activeId); return; }
    handle.restore(snapshot);
    const id = snapshot.chosenId && rows.some((r) => r.id === snapshot.chosenId) ? snapshot.chosenId : activeId;
    setCursor(id);
  }, [scopeKey, activeId, rows]);

  // The single focus runner, driven by explicit intents and READY/title changes (no timing loops).
  const runIntent = useCallback(() => {
    const pending = intent.current;
    if (!pending) return;
    const live = liveFacts();
    if (pending.intentScope !== live.scope) { intent.current = null; return; }
    if (pending.intentUriId !== live.id) { intent.current = null; return; }
    const target = pending.target;
    if (target.kind === "title") {
      if (target.whenHidden && !queueHidden) return;
      // The title belongs to the current readable receipt; an unavailable close has no title target.
      if (!pending.intentUriId || !receipt.current.rows.some((r) => r.id === pending.intentUriId)) { intent.current = null; return; }
      const title = page.current?.querySelector<HTMLElement>("#detail-title");
      if (!title) return;
      // Only take focus from the owned surface itself (or nothing): never from an unrelated user target.
      const active = document.activeElement as Element | null;
      const fromOwnSurface = !active || active === document.body || isOwnedRoot(active) || active === title ||
        !!page.current?.contains(active);
      if (!fromOwnSurface) return;   // an unrelated user target keeps its focus; the intent simply waits
      title.focus({ preventScroll: true });
      // The intent stays armed: the native dialog may return focus to the owned root right after this frame.
      return;
    }
    if (target.kind === "nativeView") {
      const native = page.current?.querySelector<HTMLElement>('select[aria-label="Decision view"]') ?? null;
      if (native && !queueHidden) { native.focus({ preventScroll: true }); intent.current = null; }
      return;
    }
    if (queueHidden) return;
    if (queueHandle.current?.focusRow(target.id, target.reveal)) intent.current = null;
  }, [queueHidden, liveFacts]);
  useEffect(() => {
    const raf = requestAnimationFrame(runIntent);
    return () => cancelAnimationFrame(raf);
  }, [runIntent, activeId, cursor, readyTick, titleTick]);

  // Owned-root focus guard: only the OUTER element identity, only while the intent is current, live URI matches.
  useEffect(() => {
    const root = ownedOuterRoot.current;
    if (!root) return;
    const onFocusIn = (event: Event) => {
      const pending = intent.current;
      if (!pending) return;
      const target = event.target as Element | null;
      if (!isOwnedRoot(target)) return;
      const live = liveFacts();
      const inReceipt = !!pending.intentUriId && receipt.current.rows.some((r) => r.id === pending.intentUriId);
      const allowed = focusAllows(pending, {
        eventTarget: target,
        ownedOuterRoot: root,                       // the cached element, never the event target
        ownedInnerPage: page.current,
        liveScope: live.scope,                      // the LIVE projected URL scope
        liveUriId: live.id,
        currentFocusVersion: focusVersion.current,
        targetInsideOwner: !!page.current?.querySelector("#detail-title") && inReceipt,
        targetOwnerId: "needs-decisions",
      });
      if (!allowed) return;
      focusTitle();
      if (focusVersion.current === pending.focusIntentVersion) intent.current = null;
    };
    // An OWNED-ROOT listener (the exact cached element), not a document-global focus interception.
    root.addEventListener("focusin", onFocusIn as EventListener);
    return () => root.removeEventListener("focusin", onFocusIn as EventListener);
  }, [focusTitle, readyTick, user.login, user.role, liveFacts]);
  // Any real input disarms a pending focus intent (read-only observation; no global redirection).
  useEffect(() => {
    const disarm = () => { focusVersion.current += 1; intent.current = null; };
    document.addEventListener("keydown", disarm, true);
    document.addEventListener("pointerdown", disarm, true);
    return () => { document.removeEventListener("keydown", disarm, true); document.removeEventListener("pointerdown", disarm, true); };
  }, [scopeKey]);

  // The page owner: cqh mechanism when supported; otherwise an actual-height fallback (ResizeObserver).
  const [fallbackHeight, setFallbackHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (supportsCqh()) { setFallbackHeight(null); return; }
    const owner = page.current;
    if (!owner) return;
    const measure = () => setFallbackHeight(owner.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(owner);
    return () => ro.disconnect();
  }, [rows.length]);
  // Resize transition: starts on resize, ends when the owner's own size settles (event-driven, no timers).
  useEffect(() => {
    const onResize = () => { resizing.current = true; };
    window.addEventListener("resize", onResize);
    const owner = page.current;
    let ro: ResizeObserver | undefined;
    if (owner) { ro = new ResizeObserver(() => { resizing.current = false; }); ro.observe(owner); }
    return () => { window.removeEventListener("resize", onResize); ro?.disconnect(); };
  }, []);

  const controlled: ControlledQueue = {
    scope: scopeKey,
    layoutEpoch: layoutEpoch.current,
    cursorId: cursor ?? activeId ?? (requested.kind !== "none" ? rows[0]?.id : undefined),
    activeId,
    explicitSelection: requested.kind !== "none",
    onCursor: setCursor,
    onActivate: (id) => commit(id, "activate"),
    // Continuous capture while the queue is visible (wide detail included). Validity is state, not the offset
    // value: a genuine settled zero replaces the bookmark; a transition or a pending restoration does not.
    onVisibleListScroll: (snapshot: Omit<Snapshot, "captureVersion">) => {
      if (resizing.current || pendingRestore.current) return;
      if (!acceptCapture({ ready: !query.loading, currentScope: true, visible: true, laidOut: true, transition: false, captureEpoch: snapshot.captureEpoch, layoutEpoch: layoutEpoch.current })) return;
      captureSnapshot({ scope: snapshot.scope, chosenId: snapshot.chosenId, captureEpoch: snapshot.captureEpoch, anchor: snapshot.anchor });
    },
    onReady,
    onDetach: (snapshot) => {
      if (snapshot && !pendingRestore.current && !resizing.current) {
        captureSnapshot({ scope: snapshot.scope, chosenId: snapshot.chosenId, captureEpoch: snapshot.captureEpoch, anchor: snapshot.anchor });
      }
      restoredFor.current = null;
    },
    onQueueKeyDown: controller.onQueueKeyDown,
    onOpenItem: (id) => openItem(rows.find((r) => r.id === id)),
  };

  const checkedHere = rows.filter((r) => loc.checked.has(r.id));
  const answerFacts = selected ? {
    user, scopeKey, requestedIdentity: JSON.stringify(requested),
    row: selected, loading: query.loading, error: queueError,
    readCurrentFacts,
  } : undefined;
  const detail = <DecisionDetail
    decision={selected}
    requested={requested.kind}
    reason={requested.kind === "unavailable" ? requested.reason : selected ? undefined : "not-loaded"}
    raw={requested.kind === "unavailable" ? requested.raw : undefined}
    loading={query.loading}
    error={queueError}
    hasRows={rows.length > 0}
    compact={narrow}
    onClose={closeSelection}
    onOpenItem={() => openItem(selected)}
    answer={answerFacts ? <DecisionAnswer facts={answerFacts} onReview={() => openItem(selected)} /> : undefined}
  />;

  return <BrowseLayout
    fill
    preview={peek ? <DecisionPreview peek={peek} query={query} onClose={closePeek} /> : undefined}
    onClosePreview={closePeek}
  >
    <div className="flex h-full min-h-0 flex-col">
      <div ref={page} className="min-h-0 flex-1 overflow-y-auto [container-type:size]">
        <div className="grid min-h-full items-start gap-x-5 min-[861px]:grid-cols-[auto_minmax(0,1fr)]">
          {!queueHidden && (
            <div className="min-w-0 w-full [height:100cqh] min-[861px]:w-[300px] min-[1101px]:w-[340px] min-[861px]:sticky min-[861px]:top-0"
              style={fallbackHeight !== null ? ({ height: fallbackHeight } as CSSProperties) : undefined}>
              <InboxList {...props} phone={phone} query={query} header={<NeedsControls />} controlled={controlled} />
            </div>
          )}
          {!peek && (!narrow || queueHidden) && <div className="min-w-0">{detail}</div>}
        </div>
      </div>
      {!phone && checkedHere.length > 1 && (
        <div className="max-h-[60%] min-h-0 shrink-0 overflow-y-auto border-t border-line-strong bg-panel">
          <MultiAnswer ds={checkedHere} user={user} />
        </div>
      )}
    </div>
  </BrowseLayout>;
}
