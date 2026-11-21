import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface TitleRegistration { scope: string; owner: symbol; title: string }
interface HeaderContextValue {
  scope: string;
  title: string;
  publish: (scope: string, owner: symbol, title: string) => void;
  clear: (scope: string, owner: symbol) => void;
}
const HeaderContext = createContext<HeaderContextValue | null>(null);
const PrimaryTitleContext = createContext(true);

/** One current-page registration; old-route effects and secondary panels cannot own the shell title. */
export function PageHeaderProvider({ scope, fallback, children }: { scope: string; fallback: string; children: ReactNode }) {
  const [registration, setRegistration] = useState<TitleRegistration | null>(null);
  const publish = useCallback((nextScope: string, owner: symbol, title: string) => {
    setRegistration((current) => current?.scope === nextScope && current.owner === owner && current.title === title ? current : { scope: nextScope, owner, title });
  }, []);
  const clear = useCallback((oldScope: string, owner: symbol) => {
    setRegistration((current) => current?.scope === oldScope && current.owner === owner ? null : current);
  }, []);
  const title = registration?.scope === scope ? registration.title : fallback;
  const value = useMemo(() => ({ scope, title, publish, clear }), [scope, title, publish, clear]);
  useEffect(() => { document.title = `${title} · AutoCraft`; }, [title]);
  return <HeaderContext.Provider value={value}>{children}</HeaderContext.Provider>;
}

/** Secondary inspectors keep section labels but never replace the route's page identity. */
export function PageTitleRegion({ primary, children }: { primary: boolean; children: ReactNode }) {
  const parent = useContext(PrimaryTitleContext);
  return <PrimaryTitleContext.Provider value={parent && primary}>{children}</PrimaryTitleContext.Provider>;
}

/** Declare a page name without adding a duplicate body h1. Disable stale-data declarations during transitions. */
export function PageTitle({ title, enabled = true }: { title: string; enabled?: boolean }) {
  const header = useContext(HeaderContext);
  const primary = useContext(PrimaryTitleContext);
  const owner = useRef(Symbol("page-title"));
  const scope = header?.scope;
  const publish = header?.publish;
  const clear = header?.clear;
  useLayoutEffect(() => {
    if (!primary || !enabled || !scope || !publish || !clear) return;
    const id = owner.current;
    publish(scope, id, title);
    return () => clear(scope, id);
  }, [primary, enabled, scope, publish, clear, title]);
  if (!enabled) return null;
  if (!primary) return <h2 className="text-lg font-semibold">{title}</h2>;
  // Isolated component previews remain labelled even without the application shell.
  return header ? null : <h1 className="text-xl font-semibold">{title}</h1>;
}

export function ShellPageTitle() {
  const header = useContext(HeaderContext);
  return <h1 id="page-title" className="min-w-0 break-words text-pretty text-base font-semibold leading-5 text-ink md:text-lg md:leading-6" title={header?.title}>{header?.title ?? "AutoCraft"}</h1>;
}
