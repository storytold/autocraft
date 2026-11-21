/** Ephemeral open identities for one mounted disclosure owner, never event bodies or global state. */
export const DISCLOSURE_OPEN_LIMIT = 512;

/** Immutable transition; redundant opens keep their insertion age and oldest opens leave at the cap. */
export function changeDisclosureOpen(ids: ReadonlySet<string>, id: string, open: boolean): ReadonlySet<string> {
  if (!id || ids.has(id) === open) return ids;
  const next = new Set(ids);
  if (open) {
    if (next.size >= DISCLOSURE_OPEN_LIMIT) next.delete(next.values().next().value!);
    next.add(id);
  } else next.delete(id);
  return next;
}
