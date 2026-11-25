// The decision queue's last View and scope, kept per person in the browser so `/needs` opens as they left it.
// lean: localStorage, so it is per device; a `needsFilters` key in /api/me/settings would make it follow the person.
// No framework imports: the tests load this file directly.

const KEYS = ["tab", "repo", "kind", "age", "all"] as const;
type Key = (typeof KEYS)[number];
export type SavedScope = Partial<Record<Key, string>>;

/** The `tab` values that are a decision View; `feedback` and `stopped` are other queues, never saved. */
const VIEW_TABS = ["answered", "backlog", "snoozed", "opinions"];

const storageKey = (login: string) => `autocraft:${login}:needs-filters`;

/** The saved part of a Needs URL. With a project pick the `repo` is the pick's, so it is not saved. */
export function scopeOf(search: string, pick: string | null): SavedScope {
  const params = new URLSearchParams(search);
  const out: SavedScope = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (!value || (key === "tab" && !VIEW_TABS.includes(value)) || (key === "repo" && pick)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The URL patch that brings `saved` back, or null. A URL that names any View or scope key wins and restores nothing.
 * With a pick, the URL's `repo` is the pick's (the shell writes it) and saved repos are dropped.
 */
export function restorePatch(search: string, saved: SavedScope, pick: string | null): SavedScope | null {
  const params = new URLSearchParams(search);
  if (KEYS.some((key) => !(key === "repo" && pick) && params.has(key))) return null;
  const patch: SavedScope = { ...saved };
  if (pick) delete patch.repo;
  return Object.keys(patch).length ? patch : null;
}

/** The saved scope, or nothing when storage is blocked or holds anything but string values of known keys. */
export function loadScope(login: string): SavedScope {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(login)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: SavedScope = {};
    for (const key of KEYS) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "string" && v) out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveScope(login: string, saved: SavedScope): void {
  try {
    if (Object.keys(saved).length) localStorage.setItem(storageKey(login), JSON.stringify(saved));
    else localStorage.removeItem(storageKey(login));
  } catch {
    /* storage blocked: the scope lasts for this page only */
  }
}
