import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useHref, useSearchParams } from "react-router-dom";

/**
 * Runs a write and keeps its error message for display. `latestOnly`: when writes overlap, only the latest one started sets or
 * clears the error and the busy key, so an older write that fails after a newer one started does not leave its error behind.
 */
export function useWrite({ latestOnly = false }: { latestOnly?: boolean } = {}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const run = useCallback(async (key: string, f: () => Promise<unknown>) => {
    const n = ++seq.current;
    const mine = () => !latestOnly || n === seq.current;
    setBusy(key);
    setError(null);
    try {
      await f();
      return true;
    } catch (e) {
      if (mine()) setError((e as Error).message);
      return false;
    } finally {
      if (mine()) setBusy(null);
    }
  }, [latestOnly]);
  return { busy, error, setError, run };
}

const URL_PATCH_EVENT = "autocraft:url-patch";

/** Read the router's live query, including the hash-router used only by the published demo. */
function liveSearch(hashRouter: boolean): string {
  if (!hashRouter) return window.location.search;
  const path = window.location.hash.slice(1);
  const query = path.indexOf("?");
  if (query < 0) return "";
  const fragment = path.indexOf("#", query);
  return path.slice(query, fragment < 0 ? undefined : fragment);
}

function subscribeUrl(listener: () => void) {
  window.addEventListener(URL_PATCH_EVENT, listener);
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  return () => {
    window.removeEventListener(URL_PATCH_EVENT, listener);
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
  };
}

/** Read at action time, before React Router's render may catch up with navigation. */
export function useLiveLocation() {
  const hashRouter = useHref("/").startsWith("#");
  return useCallback(() => ({
    pathname: hashRouter ? window.location.hash.slice(1).split(/[?#]/, 1)[0] || "/" : window.location.pathname,
    search: liveSearch(hashRouter),
  }), [hashRouter]);
}

/** URL-only view state. Patches read the live location, not a render that may precede another patch.
 * Replacing stays the default for existing callers; discrete navigation may explicitly push. */
export function useUrlState() {
  const [sp, setSp] = useSearchParams();
  const readLocation = useLiveLocation();
  const search = useSyncExternalStore(subscribeUrl, () => readLocation().search, () => sp.toString());
  const state = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const update = useCallback((patch: Record<string, string | null | undefined>, options?: { replace?: boolean }) => {
    const next = new URLSearchParams(readLocation().search);
    for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key);
    setSp(next, { replace: options?.replace ?? true });
    // History changes synchronously; React Router may publish its context in a transition.
    // All view owners see the same snapshot immediately, without a module-global history or timer.
    window.dispatchEvent(new Event(URL_PATCH_EVENT));
  }, [readLocation, setSp]);
  return { state, update, search };
}
