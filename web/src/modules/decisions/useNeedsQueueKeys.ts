// The single Needs-surface keyboard controller. It lives in DecisionBrowse, which stays mounted while the
// queue unmounts, so j/k/p/o/x/u/g a/Escape never vanish with the queue. InboxList only reports its own
// DOM arrow keys through `onQueueKeyDown`; it registers no global hotkeys.
import { useCallback } from "react";
import type { Decision } from "../../api/types";
import { useHotkeys, useShortcutHelp } from "../../shell/keyboard";
import type { Command } from "../../registry/types";

const SHORTCUTS: Command[] = [
  { id: "d-next", keys: "j", label: "Next decision", group: "Decisions" },
  { id: "d-prev", keys: "k", label: "Previous decision", group: "Decisions" },
  { id: "d-check", keys: "x", label: "Check the selected decision for a batch answer", group: "Decisions" },
  { id: "d-undo", keys: "u", label: "Undo last answer", group: "Decisions" },
  { id: "d-open", keys: "o", label: "Open the selected decision's item page", group: "Decisions" },
  { id: "d-preview", keys: "p", label: "Preview the selected decision (read only)", group: "Decisions" },
  { id: "d-tab", keys: "g a", label: "Answered / waiting view", group: "Decisions" },
];

export interface QueueKeys {
  /** The current readable decision rows (the current receipt only). */
  rows: Decision[];
  /** The active decision (the requested id when loaded, else the retained/first cursor). */
  activeId: string | undefined;
  /** The row the keyboard is on; inspector moves step from here, never from the pinned URI id. */
  cursorId: string | undefined;
  /** Whether the surface is showing the Decisions queue (not another tab/task). */
  active: boolean;
  /** A native preview is open: inspector mode. */
  previewOpen: boolean;
  onCursor: (id: string) => void;
  /** Primary commit: movement replaces, explicit activation pushes; unchanged/clamped ids do nothing. */
  onCommit: (id: string, reason: "activate" | "arrow") => void;
  /** `p` / inspector movement: SET the preview for this row (never a toggle, never a decision change). */
  previewAt: (id: string) => void;
  onOpenItem: (id: string) => void;
  onToggleCheck: () => void;
  onUndo: () => void;
  onViewAnswered: () => void;
  onEscape: () => void;
}

/** Moves from the active row; returns undefined at a clamped end (no commit, no history). */
function neighbour(rows: Decision[], activeId: string | undefined, step: 1 | -1 | "home" | "end"): string | undefined {
  if (rows.length === 0) return undefined;
  if (step === "home") return rows[0]!.id;
  if (step === "end") return rows[rows.length - 1]!.id;
  const index = Math.max(0, rows.findIndex((r) => r.id === activeId));
  const next = Math.min(Math.max(index + step, 0), rows.length - 1);
  return rows[next]!.id;
}

export function useNeedsQueueKeys(keys: QueueKeys) {
  const { rows, activeId, cursorId, previewOpen } = keys;
  useShortcutHelp(SHORTCUTS);

  const move = useCallback((step: 1 | -1 | "home" | "end") => {
    // Inspector browsing steps from its own cursor (an explicit URI stays latent); primary steps from the active row.
    const base = previewOpen ? (cursorId ?? activeId) : activeId;
    const next = neighbour(rows, base, step);
    if (!next || next === base) return;                           // clamped or unchanged: nothing to do
    if (previewOpen) { keys.onCursor(next); keys.previewAt(next); return; } // inspector: cursor + peek REPLACE
    keys.onCommit(next, "arrow");                                  // primary: commit + REPLACE
  }, [rows, activeId, cursorId, previewOpen, keys]);

  useHotkeys({
    j: () => move(1),
    k: () => move(-1),
    // p is preview-only: it SETS the peek for the CURRENT inspector cursor (the latent URI id only when no
    // cursor is known) and never activates the primary pane, toggles or rewinds.
    p: () => { const id = cursorId ?? activeId; if (id) keys.previewAt(id); },
    o: () => { if (activeId) keys.onOpenItem(activeId); },
    x: () => { if (activeId) keys.onToggleCheck(); },
    u: () => keys.onUndo(),
    "g a": () => keys.onViewAnswered(),
    escape: () => keys.onEscape(),
  }, keys.active);

  /** Queue DOM arrows only: the detail page keeps native Arrow/Home/End scrolling. */
  const onQueueKeyDown = useCallback((event: React.KeyboardEvent) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? "home" : event.key === "End" ? "end" : null;
    if (step === null || rows.length === 0) return;
    event.preventDefault();
    move(step);
  }, [rows.length, move]);

  return { onQueueKeyDown };
}
