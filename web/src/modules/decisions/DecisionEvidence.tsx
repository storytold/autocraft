import { useState } from "react";
import type { Decision } from "../../api/types";
import { useItemPreview } from "../../lib/useItemPreview";
import { useUser } from "../../shell/UserContext";
import { DisclosurePanel } from "../../ui/molecules/DisclosurePanel";
import { changeEvidenceOpen, checkStateText, decisionEvidenceModel, evidenceStaff, EVIDENCE_READ_ERROR, itemEvidenceModel } from "./evidence";

// Read-only Evidence for the SELECTED decision, after the Open-item action. Everything it shows comes from the
// decision the frame already resolved, plus — only while the disclosure is open, and only for a verified single PR
// item — the existing item-page read through `useItemPreview`. It never writes, claims, polls or retries, and the
// closed disclosure does no projection work at all.

const rowCls = "min-w-0 break-words";
const headCls = "text-xs font-semibold uppercase tracking-wide text-ink/45";

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="min-w-0">
      <h4 className={headCls}>{title}</h4>
      <ul className="mt-1 space-y-1 text-sm leading-6 text-ink/80">
        {items.map((text, i) => <li key={i} className={rowCls}>{text}</li>)}
      </ul>
    </div>
  );
}

/** A verified single PR item: the ONLY place an item-page observer may exist. Mounted only while open. */
function ItemReview({ repo, number, staff }: { repo: string; number: number; staff: boolean }) {
  const item = useItemPreview({ repo, number });
  // A background failure can keep matching data while `error` is set: never show a snapshot that is not current.
  const rich = item.loading || item.error ? null : itemEvidenceModel(item.data, staff);
  return (
    <div className="min-w-0">
      <h4 className={headCls}>Latest item review</h4>
      {item.loading && <p className="mt-1 text-sm text-ink/55">Reading the item…</p>}
      {!item.loading && item.error && <p className="mt-1 text-sm text-ink/55">{EVIDENCE_READ_ERROR}</p>}
      {rich && rich.kind === "issue" && (
        <p className="mt-1 text-sm text-ink/55">This item is an issue, so it has no pull-request review or checks.</p>
      )}
      {rich && rich.kind === "unknown" && (
        <p className="mt-1 text-sm text-ink/55">This item&rsquo;s kind could not be read, so no review or checks are shown.</p>
      )}
      {rich && rich.kind === "pr" && !rich.review && (
        <p className="mt-1 text-sm text-ink/55">No item review recorded yet.</p>
      )}
      {rich?.review && (
        <div className="mt-1 space-y-1 text-sm text-ink/80">
          <p className={rowCls}>
            <span className="font-medium">{rich.review.verdict}</span> of <span className="code">{rich.review.head}</span>{" "}
            ({rich.review.current ? "current head" : "head has moved"}) · {rich.review.at} · {rich.review.trigger}
          </p>
          {rich.review.why && <p className={`${rowCls} text-ink/60`}>{rich.review.why}</p>}
          {rich.review.summary && <p className={rowCls}>{rich.review.summary}</p>}
          <List title="Latest item review risks" items={rich.review.risks} />
        </div>
      )}
      {rich && rich.kind === "pr" && (
        <div className="mt-3 min-w-0">
          <h4 className={headCls}>Checks</h4>
          <p className="mt-1 text-xs text-ink/45">
            Checks as last read from GitHub{rich.syncedAt ? ` · synced ${rich.syncedAt}` : " · GitHub sync time unavailable"}
          </p>
          {rich.checks.length > 0 ? (
            <ul className="mt-1 space-y-1 text-sm text-ink/80">
              {rich.checks.map((c, i) => <li key={`${c.name}|${i}`} className={rowCls}>{c.name} · {checkStateText(c.state)}</li>)}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-ink/55">No checks recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The lazy half: mounted ONLY while open, and the only place the decision projection runs. */
function EvidenceBody({ decision, staff }: { decision: Decision; staff: boolean }) {
  const model = decisionEvidenceModel(decision);
  // Rich read only for a verified single PR item: a positive INTEGER number, and the payload kind must be "pr".
  const single = Number.isInteger(decision.number) && (decision.number as number) > 0 ? { repo: decision.repo, number: decision.number as number } : null;
  return (
    <div className="grid min-w-0 gap-4 px-4 py-4 @[860px]:grid-cols-2">
      {model.summary && (
        <div className="min-w-0">
          <h4 className={headCls}>Summary</h4>
          <p className={`mt-1 text-sm leading-6 text-ink/85 ${rowCls}`}>{model.summary.text}</p>
          <p className="mt-1 text-xs text-ink/45">Summary by {model.summary.by}, {model.summary.at}</p>
        </div>
      )}
      <List title="Context" items={model.context} />
      <List title="Decision risks" items={model.risks} />
      <List title="More facts" items={model.facts} />
      {model.classifiers.length > 0 && (
        <div className="min-w-0">
          <h4 className={headCls}>Classifiers ({model.classifiers.length})</h4>
          <dl className="mt-1 grid gap-2 text-sm">
            {model.classifiers.map((c) => (
              <div key={c.key} className="min-w-0">
                <dt className={`${rowCls} text-ink/80`}>
                  <span className="font-medium">{c.classifier}</span> · {c.typeLabel} · {c.want}
                </dt>
                <dd className={`${rowCls} text-ink/60`}>{c.reason}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {(model.asked || model.docket) && (
        <div className="min-w-0">
          <h4 className={headCls}>Provenance</h4>
          <dl className="mt-1 space-y-1 text-sm text-ink/70">
            {model.asked && <div><dt className="inline text-ink/50">Asked by </dt><dd className="inline">{model.asked.by || "unknown"}, {model.asked.at}</dd></div>}
            {model.docket && <div><dt className="inline text-ink/50">Docket </dt><dd className="inline break-words">{model.docket}</dd></div>}
          </dl>
        </div>
      )}
      {single ? (
        <ItemReview repo={single.repo} number={single.number} staff={staff} />
      ) : (
        <div className="min-w-0">
          <h4 className={headCls}>Latest item review</h4>
          <p className="mt-1 text-sm text-ink/55">This decision covers several items or none, so it has no single item review or checks.</p>
        </div>
      )}
    </div>
  );
}

/** One reader's Evidence: the OPEN-id set lives HERE, in React state, and survives A→B→A while mounted. */
function ReaderEvidence({ decision }: { decision: Decision }) {
  const user = useUser();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const staff = evidenceStaff(user.role, user.maintainerWrites);
  const open = openIds.has(decision.id);
  const identity = `${user.login}|${user.role}|${decision.id}`;
  return (
    <DisclosurePanel
      title="Evidence"
      summary="review, checks, classifiers, provenance"
      open={open}
      onOpenChange={(next) => setOpenIds((ids) => changeEvidenceOpen(ids, decision.id, next))}
    >
      {open ? <EvidenceBody key={identity} decision={decision} staff={staff} /> : null}
    </DisclosurePanel>
  );
}

/** Cheap outer: no projection, no traversal; a reader change replaces the subtree and drops the OPEN flags. */
export function DecisionEvidence({ decision }: { decision: Decision }) {
  const user = useUser();
  return <ReaderEvidence key={JSON.stringify([user.login, user.role])} decision={decision} />;
}
