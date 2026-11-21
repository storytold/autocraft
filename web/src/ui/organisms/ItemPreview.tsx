import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRightIcon, XIcon } from "@phosphor-icons/react";
import type { ItemPageData } from "../../api/types";
import { IconButton } from "../atoms/Button";
import { ErrorLine } from "../atoms/ErrorLine";
import { ItemRef } from "../molecules/ItemRef";
import { StatusLine } from "../molecules/StatusLine";
import { ExpandableText } from "../molecules/ExpandableText";

/** A passive inspector. Only supplied data and links: no queries, claims, answer fields or action components. */
export function ItemPreview({ data, loading, error, href, label, onClose, children }: { data?: ItemPageData; loading?: boolean; error?: string; href?: string; label?: string; onClose: () => void; children?: ReactNode }) {
  return <section aria-label="Item preview" className="flex min-h-0 min-w-0 flex-col rounded-md border border-line bg-panel">
    <header className="sticky top-0 z-20 flex min-h-12 bg-panel shrink-0 items-center gap-3 border-b border-line px-4 py-2"><h2 className="min-w-0 flex-1 text-sm font-semibold">Preview</h2><IconButton label="Close preview" onClick={onClose} className="max-md:size-11"><XIcon /></IconButton></header>
    <div className="min-h-0 space-y-5 overflow-y-auto p-4">
      {data ? <><ItemRef repo={data.repo} number={data.number} kind={data.kind} state={data.state} title={data.title} className="font-medium" /><p className="text-xs text-ink/50">By {data.author} · {data.state}</p></> : label && <p className="code break-words text-sm [overflow-wrap:anywhere]">{label}</p>}
      {loading && <p role="status" className="text-sm text-ink/55">Loading preview…</p>}
      <ErrorLine error={error} />
      {children}
      {data && <><div className="space-y-1.5"><h3 className="text-xs font-semibold text-ink/60">Workflow</h3><StatusLine status={data.status} /></div><div className="space-y-2"><h3 className="text-xs font-semibold text-ink/60">Description</h3>{data.github.description ? <ExpandableText key={`${data.repo}#${data.number}`} text={data.github.description} markdown limit={650} /> : <p className="text-sm text-ink/50">No description.</p>}</div></>}
    </div>
    <footer className="shrink-0 space-y-2 border-t border-line px-4 py-3"><p className="text-xs leading-5 text-ink/50">Read-only preview. Open the full task to answer or take action.</p>{href && <Link to={href} className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-accent-ink hover:underline max-md:min-h-11">Open full task <ArrowUpRightIcon /></Link>}</footer>
  </section>;
}
