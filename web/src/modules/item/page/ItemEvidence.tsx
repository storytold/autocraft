import type { ItemPageData } from "../../../api/types";
import { checkStateText } from "../../../lib/status";
import { useUser } from "../../../shell/UserContext";
import { Badge } from "../../../ui/atoms/Badge";
import { PrBuildLine } from "../../../ui/molecules/PrBuildLine";
import { ReviewDetail } from "./ReviewDetail";
import { ScreenshotCard } from "./ScreenshotCard";
import { SimilarCard } from "./SimilarCard";

/** Only source-backed evidence: the server's currentness markers and original review/check data. */
export function ItemEvidence({ d }: { d: ItemPageData }) {
  const viewer = useUser().role === "viewer";
  return (
    <div className="min-w-0 divide-y divide-line">
      {d.kind === "pr" && (
        <section aria-label="Latest review" className="space-y-3 px-4 py-4 md:px-5">
          <h3 className="text-sm font-semibold">Latest review</h3>
          {d.reviews.latest ? <ReviewDetail repo={d.repo} r={d.reviews.latest} viewer={viewer} /> : <p className="text-sm text-ink/50">No review recorded.</p>}
        </section>
      )}
      {d.kind === "pr" && (
        <section aria-label="GitHub checks" className="space-y-3 px-4 py-4 md:px-5">
          <h3 className="text-sm font-semibold">GitHub checks</h3>
          {d.github.checks.length ? <ul className="space-y-2">{d.github.checks.map((c) => <li key={c.name} className="flex min-w-0 items-start gap-3 text-sm"><span className="min-w-0 flex-1 break-words">{c.name}</span><Badge tone={c.state === "passing" ? "ok" : c.state === "failing" ? "bad" : "neutral"}>{checkStateText(c.state)}</Badge></li>)}</ul> : <p className="text-sm text-ink/50">No checks recorded.</p>}
          <PrBuildLine b={d.prBuild} />
        </section>
      )}
      {d.screenshots.map((r) => <ScreenshotCard key={r.head} run={r} />)}
      <SimilarCard repo={d.repo} number={d.number} />
    </div>
  );
}
