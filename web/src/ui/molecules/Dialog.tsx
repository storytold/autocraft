import { Dialog as D } from "radix-ui";
import { XIcon } from "@phosphor-icons/react";
import type { ReactNode, RefObject } from "react";
import { IconButton } from "../atoms/Button";
import { cn } from "../cn";

/** A bounded modal or side inspector; narrow screens use a scrollable bottom sheet. */
export function Dialog({ open, onClose, title, children, size = "md", variant = "modal", flush = false, hideHeader = false, returnFocusRef }: { open: boolean; onClose: () => void; title: string; children: ReactNode; size?: "md" | "lg"; variant?: "modal" | "side"; flush?: boolean; hideHeader?: boolean; returnFocusRef?: RefObject<HTMLElement> }) {
  return <D.Root open={open} onOpenChange={(o) => !o && onClose()}><D.Portal>
    <D.Overlay className="fixed inset-0 z-50 bg-black/50 animate-fadeIn" />
    <D.Content aria-describedby={undefined} onCloseAutoFocus={(event) => { const target = returnFocusRef?.current; if (target?.isConnected) { event.preventDefault(); target.focus({ preventScroll: true }); } }} className={cn("fixed z-50 flex max-h-[calc(100dvh-16px)] min-w-0 flex-col border border-line-strong bg-raised shadow-[0_12px_32px_rgba(0,0,0,0.28)] animate-rise max-md:inset-x-0 max-md:bottom-0 max-md:rounded-t-lg max-md:pb-[env(safe-area-inset-bottom)]", variant === "side" ? "md:inset-y-0 md:right-0 md:max-h-none md:w-[360px] md:max-w-[calc(100vw-24px)] md:rounded-l-md" : size === "lg" ? "md:left-1/2 md:top-[10vh] md:w-[min(760px,calc(100vw-4rem))] md:max-h-[80dvh] md:-translate-x-1/2 md:rounded-md" : "md:left-1/2 md:top-1/2 md:w-[420px] md:max-w-[calc(100vw-32px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-md")}>
      {hideHeader ? <D.Title className="sr-only">{title}</D.Title> : <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2"><D.Title className="text-sm font-semibold">{title}</D.Title><D.Close asChild><IconButton label="Close" className="ml-auto max-md:size-11"><XIcon /></IconButton></D.Close></div>}
      <div className={cn("min-h-0 overflow-y-auto overscroll-contain", !flush && "p-4")}>{children}</div>
    </D.Content>
  </D.Portal></D.Root>;
}
