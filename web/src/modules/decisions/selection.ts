// Needs-local selection state: the URL value, the O(1) bookmark (anchor identity + coordinate + fallback
// offset + capture epoch), and the independent FOCUS intent clock. Pure: no React, no data access.
import { scopeString, type ListScope } from "./list-scope.ts";

/** Every relative coordinate is paired with the row identity measured in the SAME read, plus its absolute
 *  fallback offset from that read (so a lost row restores the real scroll, never 0 by fabrication). */
export type Anchor =
  | { kind: "row"; id: string; relTop: number; fallbackOffset: number; measuredEpoch: number }
  | { kind: "offset"; offset: number; measuredEpoch: number };

/** The bookmark. `captureVersion` is the bookmark identity only; `captureEpoch` is the layout epoch read at
 *  the producer's DOM measurement. */
export interface Snapshot {
  scope: string;
  chosenId: string | undefined;
  captureVersion: number;
  captureEpoch: number;
  anchor: Anchor;
}

/** Focus has its own monotonic clock: bookmark captures never advance it. */
export interface FocusIntent {
  focusIntentVersion: number;
  intentScope: string;
  intentUriId: string | undefined;
  targetOwnerId: string;
}

export interface QueueHandle {
  capture(): Snapshot | undefined;
  restore(snapshot: Snapshot): void;
  focusRow(id: string | undefined, reveal: boolean): boolean;
}

export type RequestedDecision =
  | { kind: "none" }
  | { kind: "requested"; id: string }
  | { kind: "unavailable"; raw: string; reason: "empty" | "duplicate" | "malformed" };

/** Canonical opaque parsing: one non-empty value requests it; empty/duplicate/malformed stay honest. */
export function readDecisionParam(search: string): RequestedDecision {
  const values = new URLSearchParams(search).getAll("decision");
  if (values.length === 0) return { kind: "none" };
  if (values.length > 1) return { kind: "unavailable", raw: values[values.length - 1]!, reason: "duplicate" };
  const raw = values[0] ?? "";
  if (raw.length === 0) return { kind: "unavailable", raw, reason: "empty" };
  if (/\s/.test(raw)) return { kind: "unavailable", raw, reason: "malformed" };
  return { kind: "requested", id: raw };
}

/** The live primary URI id, read from the browser at mutation time (never a cached render value). */
export const liveDecisionId = (search: string): string | undefined => {
  const parsed = readDecisionParam(search);
  return parsed.kind === "requested" ? parsed.id : undefined;
};

export const scopeOf = (scope: ListScope): string => scopeString(scope);

/** The list's projected search: peek and the selection are not filters. */
export const projectedSearch = (search: string): string => {
  const q = new URLSearchParams(search);
  q.delete("peek");
  q.delete("decision");
  return q.toString();
};

/** The LIVE canonical scope, read from the browser at mutation time (never a render-time ref). */
export const liveScopeOf = (search: string, login: string, role: string, project: string | null = null): string =>
  scopeOf({ login, role, search: projectedSearch(search), project });

export const clamp = (value: number, range: number): number => {
  const max = Number.isFinite(range) && range > 0 ? range : 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.round(value)), max);
};

/** Capture validity is state: current receipt, visible and laid out, not a transition capture, current epoch. */
export function acceptCapture(state: {
  ready: boolean; currentScope: boolean; visible: boolean; laidOut: boolean; transition: boolean;
  captureEpoch: number; layoutEpoch: number;
}): boolean {
  return !!(state.ready && state.currentScope && state.visible && state.laidOut && !state.transition && state.captureEpoch === state.layoutEpoch);
}

/** Restore follows the ANCHOR row by identity; when it is gone the anchor's own fallback offset is clamped. */
export function resolveRestore(snapshot: Snapshot, rows: ReadonlyMap<string, unknown>, range: number):
  { kind: "row"; id: string; relTop: number } | { kind: "offset"; offset: number } | null {
  if (!snapshot) return null;
  const { anchor } = snapshot;
  if (anchor.kind === "row") {
    const row = rows.get(anchor.id);            // O(1) ref lookup: no scan of loaded rows
    if (row) return { kind: "row", id: anchor.id, relTop: anchor.relTop };
    return { kind: "offset", offset: clamp(anchor.fallbackOffset, range) };
  }
  return { kind: "offset", offset: clamp(anchor.offset, range) };
}

export function resolveActive(requested: RequestedDecision, rows: { id: string }[], cursorId: string | undefined): string | undefined {
  if (requested.kind === "requested") return rows.some((r) => r.id === requested.id) ? requested.id : undefined;
  if (requested.kind === "unavailable") return undefined;
  if (cursorId && rows.some((r) => r.id === cursorId)) return cursorId;
  return rows[0]?.id;
}

export const commitChangesId = (previous: string | undefined, next: string | undefined): boolean => previous !== next;

/* One latest-scope bookmark only (O(1), no maps/history). */
let latest: Snapshot | undefined;
let version = 0;

export function captureSnapshot(snapshot: Omit<Snapshot, "captureVersion">): Snapshot {
  version += 1;
  latest = { ...snapshot, captureVersion: version };
  return latest;
}

/** Choosing a row bumps the bookmark version only; the anchor is never rewritten. */
export function commitChosen(snapshot: Snapshot, chosenId: string | undefined): Snapshot {
  version += 1;
  return { ...snapshot, chosenId, captureVersion: version };
}

export function snapshotFor(scope: string): Snapshot | undefined {
  return latest && latest.scope === scope ? latest : undefined;
}

export function clearSnapshotFor(scope: string): void {
  if (latest && latest.scope !== scope) latest = undefined;
}

export const peekSnapshot = (): Snapshot | undefined => latest;
export const resetSnapshots = (): void => { latest = undefined; version = 0; };

/** A scroll/geometry capture must not clock focus: this mirrors the two independent counters. */
export const bookmarkAdvanceKeepsFocus = (before: number, after: number): boolean => before === after;

/** Mutation-time focus decision: owned OUTER root by element identity, live scope/URI, focus clock, owner target. */
export function focusAllows(
  intent: FocusIntent,
  live: {
    eventTarget: Element | null; ownedOuterRoot: Element | null; ownedInnerPage: Element | null;
    liveScope: string; liveUriId: string | undefined; currentFocusVersion: number;
    targetInsideOwner: boolean; targetOwnerId: string;
  },
): boolean {
  if (!intent || !live.eventTarget || live.eventTarget !== live.ownedOuterRoot) return false;
  if (live.eventTarget === live.ownedInnerPage) return false;
  if (live.liveScope !== intent.intentScope) return false;
  if (live.liveUriId !== intent.intentUriId) return false;
  if (live.currentFocusVersion !== intent.focusIntentVersion) return false;
  if (!live.targetInsideOwner) return false;
  return live.targetOwnerId === intent.targetOwnerId;
}

/** LOGIN/ROLE clears the LOCAL cursor/bookmark/intents and keeps the raw decision URI. */
export const nextIdentityState = (rawDecisionUri: string) => ({ cursor: undefined, bookmark: undefined, intents: 0, rawDecisionUri });
