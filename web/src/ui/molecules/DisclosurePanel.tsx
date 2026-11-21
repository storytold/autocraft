import { useState, type ReactNode } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "../cn";

/** Native disclosure: children stay mounted so folding a panel never discards a draft. */
export function DisclosurePanel({ title, summary, children, defaultOpen = false, open, onOpenChange, id, className }: {
  title: ReactNode; summary?: ReactNode; children: ReactNode; defaultOpen?: boolean;
  open?: boolean; onOpenChange?: (open: boolean) => void; id?: string; className?: string;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  return (
    <details id={id} open={open ?? expanded} onToggle={(e) => {
      const next = e.currentTarget.open;
      setExpanded(next);
      onOpenChange?.(next);
    }} className={cn("group/disclosure min-w-0 rounded-lg border border-line bg-raised", className)}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm font-semibold outline-none hover:bg-ink/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden">
        <CaretRightIcon aria-hidden="true" className="shrink-0 text-ink/45 transition-transform group-open/disclosure:rotate-90" />
        <span>{title}</span>
        {summary && <span className="ml-auto min-w-0 text-right text-xs font-normal text-ink/50">{summary}</span>}
      </summary>
      <div className="min-w-0 border-t border-line">{children}</div>
    </details>
  );
}
