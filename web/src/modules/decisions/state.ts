import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { hasContinuation, nextCursor, pagesForScope, scopeString, scopedListKey, unwrapCursor } from "./list-scope";
import { useApi, usePagedQuery, useQuery } from "../../api/client";
import { usePageProject } from "../../api/scope";
import { useUrlState } from "../../lib/hooks";
import { readDecisionParam } from "./selection";
import { parseScope } from "./needs-controls";
import { useUser } from "../../shell/UserContext";
import type { Decision, DecisionFilter, DecisionKind } from "../../api/types";

export const KIND_LABEL: Record<DecisionKind, string> = {
  scope: "Scope check",
  duplicate: "Duplicates",
  close: "Close approval",
  merge: "Merge approval",
  hold: "Hold",
  split: "Split",
  other: "Question",
  backlog: "Backlog",
};
export const KINDS = Object.keys(KIND_LABEL) as DecisionKind[];
/** The kinds the pipeline asks: a `backlog` decision is only ever answered, so it has no inbox filter. */
export const ASKED_KINDS = KINDS.filter((k) => k !== "backlog");

/**
 * Filters live in the URL so a link reproduces the view; `peek` is the preview selection, never part
 * of the list's query key. Reads go through the shared live-URL hook (`lib/hooks.ts`), so a control
 * follows the click rather than the router's transition, and the URL stays the one source of truth.
 */
/** The URL keys that are a cohort/filter change; a patch touching one also clears the selection. */
const DOMAIN_KEYS = ["repo", "kind", "age", "all", "tab"] as const;

export function useDecisionFilter() {
  const { search: live, update: rawUpdate } = useUrlState();
  // One Needs-local cleanup owner: a recognised domain change appends decision:null, peek:null in the SAME
  // transaction and passes the caller's options through unchanged. Selection/preview patches are not domain.
  const update = useCallback((patch: Record<string, string | null>, opts?: { replace?: boolean }) => {
    const domain = DOMAIN_KEYS.some((key) => key in patch);
    rawUpdate(domain ? { ...patch, decision: null, peek: null } : patch, opts);
  }, [rawUpdate]);
  const params = useMemo(() => new URLSearchParams(live), [live]);
  // ONE effective model for the request and for what the controls draw: the server's own arithmetic
  // (positive fractional days apply, Infinity/number above the cap becomes 36500, NaN/non-positive is
  // ignored, kinds are whitelisted). Invalid raw values stay in the URL but are never sent.
  const filter: DecisionFilter = useMemo(() => {
    const scope = parseScope(live, KINDS);
    return {
      repo: scope.repo.length ? scope.repo : undefined,
      kind: scope.kind.length ? scope.kind : undefined,
      minAge: scope.minAge,
      all: scope.all,
      status: params.get("tab") === "answered" ? "answered" : params.get("tab") === "backlog" ? "backlog" : params.get("tab") === "snoozed" ? "snoozed" : params.get("tab") === "opinions" ? "opinions" : "open",
    };
  }, [live, params]);
  // Every URL key but `peek`: choosing a preview is not a filter, so it must not invalidate the list
  // query, refetch its pages or reset "Load more".
  // The list's query projection excludes the preview AND the selected decision: neither is a filter, so
  // a selection must not refetch the list, reset its pages or add an observer.
  const search = useMemo(() => {
    const q = new URLSearchParams(params);
    q.delete("peek");
    q.delete("decision");
    return q.toString();
  }, [params]);
  const peek = params.get("peek");
  const setPeek = useCallback((id: string | null) => rawUpdate({ peek: id }), [rawUpdate]);
  // The selected decision (a real opaque Decision.id). The raw URL value stays until the user closes it.
  const decision = useMemo(() => readDecisionParam(live), [live]);
  // Explicit activation/close pushes (Back reopens the detail); keyboard movement replaces. Clearing a
  // lingering peek belongs to the SAME transaction, never a second decision entry.
  const setDecision = useCallback((id: string | null, opts?: { clearPeek?: boolean; replace?: boolean }) => {
    rawUpdate(opts?.clearPeek ? { decision: id, peek: null } : { decision: id }, { replace: opts?.replace ?? false });
  }, [rawUpdate]);
  const clearPeek = useCallback(() => rawUpdate({ peek: null }, { replace: true }), [rawUpdate]);
  // A filter change: the open preview belongs to the old filter, so it closes with the change.
  // Needs' View and scope controls push, so Back/Forward restore them; the
  // shared hook's default stays replace for every other caller.
  const setFilter = useCallback((patch: Record<string, string | null>, opts?: { replace?: boolean }) => update({ ...patch, peek: null }, opts), [update]);
  return { filter, update, setFilter, search, peek, setPeek, decision, setDecision, clearPeek };
}

/** The loaded pages of the list; `loadMore` appends the next one. A change refetches every loaded page. */
export type DecisionListQuery = ReturnType<typeof useDecisionList>;

export function useDecisionList() {
  const { filter, search } = useDecisionFilter();
  const user = useUser();
  // The reader is part of what a page means: the same filter asked by another login or role is another
  // list. The key keeps the `decisions?` prefix so live-topic invalidation still matches (api/topics.ts),
  // and each loaded page carries a client-only receipt naming the scope it was fetched for.
  const project = usePageProject();
  const scope = useMemo(() => scopeString({ login: user.login, role: user.role, search, project }), [user.login, user.role, search, project]);
  const q = usePagedQuery(
    scopedListKey({ login: user.login, role: user.role, search, project }),
    async (a, after) => {
      // `undefined` is the first page. Anything else must be a continuation this scope minted: a
      // malformed, foreign-scope or empty continuation fails closed HERE, before any request, so no
      // other reader's or filter's page is read and no empty continuation is ever sent as a cursor.
      const unwrapped = unwrapCursor(after, scope);
      if (!unwrapped.ok) throw new Error(`invalid continuation (${unwrapped.reason})`);
      const page = await a.decisions.list({ ...filter, after: unwrapped.cursor });
      return { scope, page };
    },
    // Only a real, non-empty server cursor becomes a continuation; null/empty ends the list.
    (receipt) => nextCursor(scope, receipt.page),
    { keepPageMs: 30_000 },
  );
  // Only this scope's pages are exposed: a placeholder from the previous reader or filter is never shown,
  // and nothing derived from it (counts, hasMore, actions) leaks while the new scope is unsettled.
  const receipts = pagesForScope(q.pages, scope);
  const pages = useMemo(() => receipts?.map((r) => r.page), [receipts]);
  const all = useMemo(() => pages?.flatMap((p) => p.decisions), [pages]);
  const decisions = useFolded(all);
  const last = pages?.[pages.length - 1];
  const data = last && { ...last, decisions: decisions ?? [] };
  const settled = pages !== undefined && !q.error;
  const more = settled && hasContinuation(last);
  return {
    data,
    readReceipts: receipts,
    error: q.error,
    loading: q.loading,
    refetch: q.refetch,
    hasMore: more,
    // Gated on the CURRENT settled scope with a real continuation: no old/failed/placeholder page can
    // start a fetch, and an empty or invalid continuation never reaches the API.
    loadMore: useCallback(() => { if (more && !q.loadingMore) q.loadMore(); }, [more, q.loadingMore, q.loadMore]),
    loadingMore: q.loadingMore,
  };
}

// ---- view-local state shared by the list, detail and thread panels ----

export interface AnswerEntry {
  id: string;
  label: string;
  ref: string;
  /** From the answer's response; the live value comes from the decision itself. */
  undoable: boolean;
}

const NOTICE_MS = 8000;
const ERROR_MS = 4000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let errorTimer: ReturnType<typeof setTimeout> | undefined;

interface Local {
  checked: Set<string>;
  /** The latest answer, shown as a short notice with Undo; it expires after `NOTICE_MS` or at the next answer. */
  justAnswered: AnswerEntry[];
  /** The server's refusal of the last Undo, shown briefly next to the decision it concerns. */
  undoError: { id: string; message: string } | null;
  notes: Record<string, string>;
  /** The option picked in the Workflow box, by decision id (checked batches: ids joined with +). */
  picks: Record<string, string>;
  overrides: Record<string, Record<string, string>>;
  /** The answer the server accepted, shown at once until the refetched decision carries it (dropped on Undo). */
  folded: Record<string, FoldedAnswer>;
  /** Items whose message to Opus is out: its choices are about to be replaced, so they are folded until the new set (or Opus's failure) arrives. By "repo#number". */
  updating: Record<string, Updating>;
}
/** `choicesId`: the set that was current when the message went out; `opusTurns`: Opus's turns so far. */
export interface Updating {
  decisionId: string;
  choicesId: string;
  opusTurns: number;
}
type FoldedAnswer = Pick<Decision, "answer" | "answerNote" | "answeredBy" | "answeredAt" | "undoable">;
let local: Local = { checked: new Set(), justAnswered: [], undoError: null, notes: {}, picks: {}, overrides: {}, folded: {}, updating: {} };
const subs = new Set<() => void>();
const set = (fn: (l: Local) => Local) => {
  local = fn(local);
  subs.forEach((f) => f());
};
export const useLocal = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => local,
  );
export const localActions = {
  toggle(id: string) {
    set((l) => {
      const checked = new Set(l.checked);
      checked.has(id) ? checked.delete(id) : checked.add(id);
      return { ...l, checked };
    });
  },
  clearChecked: () => set((l) => ({ ...l, checked: new Set() })),
  setPick: (key: string, option: string | null) =>
    set((l) => {
      const picks = { ...l.picks };
      option ? (picks[key] = option) : delete picks[key];
      return { ...l, picks };
    }),
  setNote: (id: string, note: string) => set((l) => ({ ...l, notes: { ...l.notes, [id]: note } })),
  setOverride: (id: string, ref: string, answer: string | null) =>
    set((l) => {
      const cur = { ...(l.overrides[id] ?? {}) };
      answer ? (cur[ref] = answer) : delete cur[ref];
      return { ...l, overrides: { ...l.overrides, [id]: cur } };
    }),
  answered(entries: AnswerEntry[]) {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => set((l) => ({ ...l, justAnswered: [] })), NOTICE_MS);
    set((l) => ({ ...l, justAnswered: entries, undoError: null, checked: new Set() }));
  },
  startUpdating(item: string, u: Updating) {
    // A reply that never comes must not keep the choices folded for good.
    setTimeout(() => localActions.stopUpdating(item), 5 * 60_000);
    set((l) => ({ ...l, updating: { ...l.updating, [item]: u } }));
  },
  stopUpdating: (item: string) => set((l) => (item in l.updating ? { ...l, updating: Object.fromEntries(Object.entries(l.updating).filter(([k]) => k !== item)) } : l)),
  fold: (id: string, a: FoldedAnswer) => set((l) => ({ ...l, folded: { ...l.folded, [id]: a } })),
  unfold: (ids: string[]) =>
    set((l) => (ids.some((id) => id in l.folded) ? { ...l, folded: Object.fromEntries(Object.entries(l.folded).filter(([id]) => !ids.includes(id))) } : l)),
  forget: (id: string) =>
    set((l) => ({ ...l, justAnswered: l.justAnswered.filter((x) => x.id !== id), folded: Object.fromEntries(Object.entries(l.folded).filter(([k]) => k !== id)) })),
  /** Shows the refusal, then drops it and the notice of that decision. */
  undoFailed(id: string, message: string) {
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => set((l) => ({ ...l, undoError: null, justAnswered: l.justAnswered.filter((x) => x.id !== id) })), ERROR_MS);
    set((l) => ({ ...l, undoError: { id, message } }));
  },
};

/** The decisions as answered where an answer was just accepted, so every view folds the form into the answer before the refetch lands. */
export function useFolded<T extends Decision>(ds: T[] | undefined): T[] | undefined {
  const { folded } = useLocal();
  useEffect(() => {
    const done = ds?.filter((d) => d.answer && d.id in folded).map((d) => d.id) ?? [];
    if (done.length) localActions.unfold(done);
  }, [ds, folded]);
  return useMemo(() => ds?.map((d) => (!d.answer && folded[d.id] ? { ...d, ...folded[d.id] } : d)), [ds, folded]);
}
export function useFoldedOne<T extends Decision>(d: T | undefined): T | undefined {
  const one = useMemo(() => (d ? [d] : undefined), [d]);
  return useFolded(one)?.[0];
}

export const refOf = (d: Pick<Decision, "repo" | "number" | "items">) => (d.number === null ? `${d.repo} · ${d.items.length} items` : `${d.repo}#${d.number}`);

/** Answer one or more decisions and remember them for undo. */
export function useAnswer() {
  const api = useApi();
  const login = useUser().login;
  return useCallback(
    async (ds: Decision[], key: string) => {
      const entries = [];
      for (const d of ds) {
        const overrides = local.overrides[d.id] ?? {};
        const res = await api.decisions.answer(d.id, {
          answer: key,
          textsHash: d.optionTexts?.find((t) => t.option === key)?.hash,
          note: local.notes[d.id] || undefined,
          exceptions: Object.entries(overrides).map(([ref, answer]) => {
            const [repo, n] = ref.split("#");
            return { repo, number: Number(n), answer };
          }),
        });
        const undoable = res?.undoable ?? true;
        entries.push({ id: d.id, ref: refOf(d), label: d.options.find((o) => o.key === key)?.label ?? key, undoable });
        localActions.fold(d.id, { answer: key, answerNote: local.notes[d.id] || null, answeredBy: login, answeredAt: new Date().toISOString(), undoable });
      }
      localActions.answered(entries);
    },
    [api, login],
  );
}

export function useUndo() {
  const api = useApi();
  return useCallback(
    async (id?: string) => {
      const target = id ?? local.justAnswered[0]?.id;
      if (!target) return;
      try {
        await api.decisions.undo(target);
        localActions.forget(target);
      } catch (e) {
        localActions.undoFailed(target, e instanceof Error ? e.message : "Could not undo");
      }
    },
    [api],
  );
}

/** Whether Undo still works for a decision: the live decision when loaded, else what the answer returned. */
export function useUndoable(id: string, fallback: boolean): boolean {
  const d = useQuery(`decision:${id}`, (a) => a.decisions.get(id)).data;
  return d && d.id === id ? d.undoable : fallback;
}

/** The option key waiting for its confirming pick; it lapses after four seconds. */
export function useArmed() {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return [armed, setArmed] as const;
}
