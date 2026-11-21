import { Link } from "react-router-dom";
import type { ViewProps } from "../../registry/types";
import { useUrlState } from "../../lib/hooks";
import { Workspace } from "../../shell/Workspace";
import { PageTitleRegion } from "../../shell/PageHeader";
import { decisionsView } from "../decisions";
import { needsTabsHref } from "../decisions/needs-controls";
import { FeedbackTab } from "./FeedbackTab";
import { StoppedTab } from "./StoppedTab";
import { useSummary } from "./state";

type Tab = "decisions" | "feedback" | "stopped";
const TABS: Tab[] = ["decisions", "feedback", "stopped"];
const LABEL: Record<Tab, string> = { decisions: "Decisions", feedback: "Feedback", stopped: "Stopped" };

/** The tab comes from the live query, not the router's committed copy, so a fast facet change is not lost. */
function useTab(): Tab {
  const { state } = useUrlState();
  const t = state.tab;
  return TABS.includes(t as Tab) ? (t as Tab) : "decisions";
}

/**
 * The three work queues: underline tabs with the real queue counts. They are
 * the page's primary switch; a decision's View is the separate native select below. Counts are the
 * person's own queue (needs().counts) and are not affected by the scope controls.
 */
export function NeedsTabs() {
  const tab = useTab();
  const { search } = useUrlState();
  const { data } = useSummary();
  return <nav aria-label="Work queues" className="mb-4 flex flex-wrap items-center gap-x-1 border-b border-line">
    {TABS.map((key) => <Link key={key} aria-current={tab === key ? "page" : undefined} to={needsTabsHref(key, search)}
      className={`-mb-px inline-flex min-h-10 items-center gap-1.5 border-b-2 px-3 py-2 text-sm max-md:min-h-11 ${tab === key ? "border-accent font-[650] text-accent-ink" : "border-transparent text-ink/70 hover:text-ink"}`}>
      {LABEL[key]}
      {data?.counts[key] !== undefined && <span className="num text-xs opacity-60">{data.counts[key]}{key === "decisions" ? " waiting" : ""}</span>}
    </Link>)}
  </nav>;
}

/** Keep the Decisions list height bounded; each other tab owns its existing page scroller. */
export function PhoneBody(props: ViewProps) {
  return <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1 overflow-hidden"><PageTitleRegion primary><Body {...props} /></PageTitleRegion></div>
  </div>;
}

export function Body(props: ViewProps) {
  const tab = useTab();
  // The tabs belong to the page body, so every queue shows them once.
  // The Decisions queue is a 366/296px card at 390/320, which is a 12px page inset there; the other
  // queues keep their existing 16px child inset, restored locally.
  return <div className="flex h-full min-h-0 flex-col px-3 pb-4 pt-3 md:px-6">
    <NeedsTabs />
    <div className="min-h-0 flex-1 overflow-hidden">
      {tab === "feedback" ? <div className="h-full min-h-0 px-1 md:px-0"><FeedbackTab /></div> : tab === "stopped" ? <div className="h-full min-h-0 px-1 md:px-0"><StoppedTab /></div> : <Workspace view={decisionsView} props={props} />}
    </div>
  </div>;
}
