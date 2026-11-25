/** A normal setter, or removal of one exact entry without replacing its other values. */
export type UrlPatch = Record<string, string | null | undefined | { removeValue: string }>;

/** Apply edits to the action-time query, preserving unrelated entries and their order. */
export function patchSearch(search: string, patch: UrlPatch): URLSearchParams {
  let next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object") {
      let removed = false;
      next = new URLSearchParams([...next].filter(([entryKey, entryValue]) => {
        if (!removed && entryKey === key && entryValue === value.removeValue) {
          removed = true;
          return false;
        }
        return true;
      }));
    } else if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}
