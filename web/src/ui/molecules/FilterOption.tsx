import type { ReactNode } from "react";
import { Button } from "../atoms/Button";
import { cn } from "../cn";

/** One filter choice. A missing count stays missing, never a fabricated zero. */
export function FilterOption({ active, onClick, count, disabled, children }: { active: boolean; onClick: () => void; count?: number; disabled?: boolean; children: ReactNode }) {
  return <Button variant="ghost" aria-pressed={active} disabled={disabled} onClick={onClick} className={cn("h-auto min-h-9 w-full justify-between gap-3 whitespace-normal px-2.5 py-2 text-left text-sm max-md:min-h-11", active && "border-accent/20 bg-accent/[0.08] text-accent-ink")}><span className="min-w-0 break-words">{children}</span>{count !== undefined && <span className="num shrink-0 text-xs opacity-60">{count.toLocaleString()}</span>}</Button>;
}
