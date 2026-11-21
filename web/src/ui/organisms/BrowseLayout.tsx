import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { Button } from "../atoms/Button";
import { Dialog } from "../molecules/Dialog";
import { cn } from "../cn";

/** Props-only browse workspace. Breakpoints follow available content width, not the screen behind the app rail.
    `filters` is optional: a view whose filters live in its own toolbar (Items) gets the preview without a rail. */
export function BrowseLayout({ filters, children, preview, onClosePreview, filterTitle = "Filters", activeFilters = 0, fill = false }: { filters?: ReactNode; children: ReactNode; preview?: ReactNode; onClosePreview?: () => void; filterTitle?: string; activeFilters?: number; fill?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const showingPreview = !!preview;
  useLayoutEffect(() => {
    if (showingPreview) {
      const active = document.activeElement;
      previewTrigger.current = active instanceof HTMLElement && container.current?.contains(active) ? active : container.current;
    }
  }, [showingPreview]);
  const inlineFilters = !!filters && width >= 900;
  const inlinePreview = width >= 1120;
  useEffect(() => { if (inlineFilters) setFiltersOpen(false); }, [inlineFilters]);
  const sideClass = fill ? "min-h-0 overflow-y-auto overscroll-contain" : "sticky top-0 max-h-[calc(100dvh-140px)] overflow-y-auto overscroll-contain";
  const columns = [inlineFilters ? "208px" : null, "minmax(0,1fr)", preview && inlinePreview ? "340px" : null].filter(Boolean).join(" ");
  return <div ref={container} tabIndex={-1} data-browse-layout className={cn("flex min-w-0 flex-col gap-4", fill && "h-full min-h-0")}>
    {filters && !inlineFilters && <div className={cn("flex shrink-0 items-center gap-3", fill && "px-4 pt-3")}><Button ref={filterTrigger} icon={SlidersHorizontalIcon} onClick={() => setFiltersOpen(true)} className="max-md:h-11">Filters{activeFilters > 0 && <span className="num rounded bg-accent/10 px-1.5 text-xs text-accent-ink">{activeFilters}</span>}</Button><span className="text-xs text-ink/50">{activeFilters ? "Filtered view" : "All filters available"}</span></div>}
    <div className={cn("grid min-w-0 gap-4", fill ? "min-h-0 flex-1" : "items-start")} style={{ gridTemplateColumns: columns }}>
      {inlineFilters && <aside aria-label={filterTitle} className={cn(sideClass, "min-w-0 border-r border-line pr-4", fill && "pl-4 pt-3")}><h2 className="mb-5 text-sm font-semibold">{filterTitle}</h2>{filters}</aside>}
      <div className={cn("min-w-0", fill && "min-h-0")}>{children}</div>
      {preview && inlinePreview && <aside aria-label="Preview sidebar" className={sideClass}>{preview}</aside>}
    </div>
    {filters && !inlineFilters && <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} title={filterTitle} variant="side" returnFocusRef={filterTrigger}>{filters}</Dialog>}
    {!inlinePreview && <Dialog open={!!preview} onClose={() => onClosePreview?.()} title="Item preview" variant="side" flush hideHeader returnFocusRef={previewTrigger}>{preview}</Dialog>}
  </div>;
}
