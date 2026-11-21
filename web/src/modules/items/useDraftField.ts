import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A debounced text draft that survives the browser's phase/list switch. The draft lives here, in
 * the page that stays mounted, not inside the toolbar that unmounts when a phase context starts or
 * ends; otherwise a click inside the 300 ms window would throw the typed text away. A URL change or a popstate replaces the draft, and a
 * pending timer is cancelled rather than writing text that was abandoned.
 */
export function useDraftField({ value, commit, resolveKey, delay = 300 }: {
  /** The URL's value for this field. */
  value: string;
  /** Writes a settled draft to the URL (Items uses a replace for typing). */
  commit: (value: string) => void;
  /** Changes when the draft must be replaced (reset or a real popstate). */
  resolveKey: string;
  delay?: number;
}) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(commit);
  useLayoutEffect(() => { latest.current = commit; }, [commit]);
  useEffect(() => setDraft(value), [value, resolveKey]);
  useEffect(() => {
    if (draft.trim() === value) return;
    const timer = setTimeout(() => latest.current(draft.trim()), delay);
    return () => clearTimeout(timer);
  }, [draft, value, resolveKey, delay]);
  return {
    value: draft,
    onChange: setDraft,
    /** Enter: apply the draft now, without waiting for the debounce. */
    onSubmit: () => latest.current(draft.trim()),
  };
}
