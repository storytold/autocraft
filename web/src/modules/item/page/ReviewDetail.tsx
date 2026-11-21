import type { OpusReviewEntry, ReviewVerdict } from "../../../api/types";
import { Badge } from "../../../ui/atoms/Badge";
import { ItemRef } from "../../../ui/molecules/ItemRef";
import { ExpandableText } from "../../../ui/molecules/ExpandableText";
import { githubBlobUrl } from "../../../lib/links";
const TRIGGER: Record<string, string> = { "new-head": "new head", discussion: "discussion", operator: "asked by an operator", base: "base branch changed", "model-change": "model change" };

const VERDICT_LABEL: Record<ReviewVerdict, string> = { take: "Take", "take-fix": "Take with fixes", hold: "Hold", close: "Close" };

export function ReviewDetail({ repo, r, viewer }: { repo: string; r: OpusReviewEntry; viewer: boolean }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
        <Badge>{VERDICT_LABEL[r.verdict]}</Badge>
        <span>of <span className="code">{r.head}</span> ({r.current ? "current head" : "head has moved"})</span>
        {r.why && <span>· {r.why} ({TRIGGER[r.trigger]})</span>}
      </p>
      {r.summary && <ExpandableText text={r.summary} />}
      {r.blockedBy.length > 0 && (
        <div>
          <div className="text-xs font-medium text-ink/65">Must land first</div>
          <ul className="mt-1 space-y-1">{r.blockedBy.map((b) => <li key={`${b.repo}#${b.number}`}><ItemRef repo={b.repo} number={b.number} title={null} size="sm" /></li>)}</ul>
        </div>
      )}
      {!viewer && r.fixes.length > 0 && <List title="Fixes" items={r.fixes} />}
      {!viewer && r.risks.length > 0 && <List title="Risks" items={r.risks} />}
      {!viewer && r.claims.length > 0 && (
        <ul className="space-y-1.5">
          {r.claims.map((c) => (
            <li key={`${c.path}:${c.line}`} className="text-xs leading-5">
              <a href={githubBlobUrl(repo, r.head, c.path, c.line)} target="_blank" rel="noopener noreferrer" className="code break-all text-accent-ink hover:underline">{c.path}:{c.line}</a>
              <span className="text-ink/65"> {c.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const List = ({ title, items }: { title: string; items: string[] }) => (
  <div>
    <div className="text-xs font-medium text-ink/65">{title}</div>
    <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-ink/85">{items.map((i) => <li key={i}>{i}</li>)}</ul>
  </div>
);
