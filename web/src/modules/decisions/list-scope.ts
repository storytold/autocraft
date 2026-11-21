// Needs-local list scope and private cursor codecs. Pure, no React, no client changes.
//
// The query key MUST keep the `decisions?` prefix: `api/topics.ts` matches that prefix to decide which
// live events invalidate the list, so a key like `decisions:<reader>` would silently stop invalidating.
// The reader and filter scope rides in the key's query string instead, and the pagination cursor handed
// to the shared paged hook is a private JSON tuple [scope, serverCursor] so its kept-page map (keyed by
// cursor) can never hand one reader's or filter's page to another.
//
// Continuation semantics (actual server, src/dash/api/decisions.ts): a page's `next` is either a
// NON-EMPTY opaque keyset cursor or null. An absent/empty `after` selects the first page, so a decoded
// empty continuation is NOT a valid continuation: it fails closed here, before any request, and the
// hook never mints or loads one.

/** The scope a list page was fetched for: the reader and the filter/search (which already excludes `peek`). */
export type ListScope = { login: string; role: string; search: string; project?: string | null };

/** The canonical scope string: a JSON tuple so a delimiter in a login or a search value cannot collide. */
export function scopeString(scope: ListScope): string {
  return JSON.stringify([scope.login, scope.role, scope.search, scope.project ?? null]);
}

/** The query key: the live-topic prefix `decisions?` plus the scope. */
export function scopedListKey(scope: ListScope): string {
  return `decisions?scope=${encodeURIComponent(scopeString(scope))}`;
}

/** An internal cursor for one scope: `[scope, serverCursor]`. Never sent to the API. */
export function privateCursor(scopeStringValue: string, serverCursor: string): string {
  return JSON.stringify([scopeStringValue, serverCursor]);
}

export type CursorResult = { ok: true; cursor: string | undefined } | { ok: false; reason: "malformed" | "scope" | "empty" };

/**
 * Unwrap an internal cursor for the current scope. `undefined` is the first page and stays distinct from
 * a decoded value (an empty or non-string continuation is invalid and fails closed). Anything malformed
 * or of another scope fails closed too, so the caller never issues a request with it.
 */
export function unwrapCursor(raw: string | undefined, scopeStringValue: string): CursorResult {
  if (raw === undefined) return { ok: true, cursor: undefined };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: "malformed" }; }
  if (!Array.isArray(parsed) || parsed.length !== 2) return { ok: false, reason: "malformed" };
  const [scope, cursor] = parsed;
  if (scope !== scopeStringValue) return { ok: false, reason: "scope" };
  if (typeof cursor !== "string") return { ok: false, reason: "malformed" };
  if (cursor.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, cursor };
}

/** The next internal cursor for a page: only a real, non-empty server cursor is minted; null/empty end. */
export function nextCursor(scopeStringValue: string, page: { next: string | null }): string | null {
  const next = page.next;
  return typeof next === "string" && next.length > 0 ? privateCursor(scopeStringValue, next) : null;
}

/** True when the page carries a usable continuation (the server's non-empty keyset cursor). */
export const hasContinuation = (page: { next: string | null } | undefined): boolean =>
  !!page && typeof page.next === "string" && page.next.length > 0;

/** True when every loaded page belongs to this scope; a mixed set is never exposed. */
export function pagesForScope<P extends { scope: string }>(pages: P[] | undefined, scopeStringValue: string): P[] | undefined {
  if (!pages || pages.length === 0) return undefined;
  return pages.every((page) => page.scope === scopeStringValue) ? pages : undefined;
}
