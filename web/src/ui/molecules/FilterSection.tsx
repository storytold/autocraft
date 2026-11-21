import type { ReactNode } from "react";

/** A named facet group; counts and values belong to the page that supplied them. */
export function FilterSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <fieldset className="min-w-0 space-y-2 border-0 p-0"><legend className="mb-2 text-xs font-semibold text-ink/80">{title}</legend>{hint && <p className="text-xs leading-5 text-ink/50">{hint}</p>}<div className="space-y-1">{children}</div></fieldset>;
}
