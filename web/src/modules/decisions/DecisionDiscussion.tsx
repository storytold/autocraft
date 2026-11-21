import { useState } from "react";
import type { Decision, DecisionComment } from "../../api/types";
import { useQuery } from "../../api/client";
import { useUser } from "../../shell/UserContext";
import { DisclosurePanel } from "../../ui/molecules/DisclosurePanel";
import { changeDiscussionOpen, discussionModel, DISCUSSION_READ_ERROR } from "./discussion";

// Read-only Discussion for the SELECTED decision — the supplied opinions plus the decision's own comment thread.
// It never writes, adopts, replies, polls or retries; the closed disclosure does no projection and mounts no hook.

const rowCls = "min-w-0 break-words";
const headCls = "text-xs font-semibold uppercase tracking-wide text-ink/45";
const metaCls = "text-xs text-ink/45";

/** Private envelope: the full request key is echoed so a mismatched response can never be shown. */
interface ThreadEnvelope {
  requestKey: string;
  comments: DecisionComment[];
}

/** The lazy half: mounted ONLY while open, keyed by the reader+decision identity. */
function DiscussionBody({ decision }: { decision: Decision }) {
  const user = useUser();
  // Capture the scalars and the key together, before the request can resolve.
  const captured = { login: user.login, role: user.role, id: decision.id };
  const capturedKey = "thread:discussion:" + JSON.stringify([captured.login, captured.role, captured.id]);
  const q = useQuery<ThreadEnvelope>(capturedKey, async (api) => ({
    requestKey: capturedKey,
    comments: await api.decisions.thread(captured.id),
  }), { gcTime: 0 });

  // A placeholder or another key's data is never shown; a failure is one honest message.
  const currentKey = "thread:discussion:" + JSON.stringify([user.login, user.role, decision.id]);
  const envelope = q.data;
  const usable = !!envelope && !q.loading && !q.error && envelope.requestKey === currentKey;
  const model = discussionModel(decision, usable ? envelope!.comments : []);

  return (
    <div className="grid min-w-0 gap-4 px-4 py-4">
      <div className="min-w-0">
        <h4 className={headCls}>Opinions ({model.opinions.length})</h4>
        {model.opinions.length === 0 ? (
          <p className="mt-1 text-sm text-ink/55">No opinions yet.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {model.opinions.map((o) => (
              <li key={o.key} className={rowCls}>
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium text-ink/85">{o.login}</span>
                  <span className={metaCls}>{o.permissionLabel}</span>
                  {o.viaMcp && <span className={metaCls}>· via an agent</span>}
                  <span className={metaCls}>· {o.at}</span>
                </div>
                {o.optionKey !== null && (
                  <p className="mt-0.5 text-sm text-ink/80">
                    {o.optionLabel !== null
                      ? <>suggests “{o.optionLabel}”</>
                      : <>suggests the option <span className="code">{o.optionKey}</span></>}
                  </p>
                )}
                {o.noteUnavailable ? (
                  <p className="mt-0.5 text-sm text-ink/50">Text unavailable</p>
                ) : o.note !== null ? (
                  <p className="mt-0.5 whitespace-pre-wrap text-sm leading-6 text-ink/80">{o.note}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-w-0">
        <h4 className={headCls}>Decision comments ({usable ? model.comments.length : "…"})</h4>
        {q.loading && <p className="mt-1 text-sm text-ink/55">Reading the discussion…</p>}
        {/* S1: a completed-but-unusable result (a mismatched request key) is a cache fault, not an empty thread. */}
        {!q.loading && (q.error || (!!envelope && envelope.requestKey !== currentKey)) && (
          <p className="mt-1 text-sm text-ink/55">{DISCUSSION_READ_ERROR}</p>
        )}
        {usable && model.comments.length === 0 && <p className="mt-1 text-sm text-ink/55">No decision comments yet.</p>}
        {usable && model.comments.length > 0 && (
          <ul className="mt-1 space-y-2">
            {model.comments.map((c) => (
              <li key={c.key} className={rowCls}>
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium text-ink/85">{c.login}</span>
                  {c.viaMcp && <span className={metaCls}>· via an agent</span>}
                  <span className={metaCls}>· {c.at}</span>
                </div>
                {c.unavailable ? (
                  <p className="mt-0.5 text-sm text-ink/50">Text unavailable</p>
                ) : (
                  <p className="mt-0.5 whitespace-pre-wrap text-sm leading-6 text-ink/80">{c.body}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One reader's Discussion: the OPEN-id set lives HERE in React state and survives A→B→A while mounted. */
function ReaderDiscussion({ decision }: { decision: Decision }) {
  const user = useUser();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const open = openIds.has(decision.id);
  const identity = `${user.login}|${user.role}|${decision.id}`;
  return (
    <DisclosurePanel
      title="Discussion"
      summary="opinions, comments"
      open={open}
      onOpenChange={(next) => setOpenIds((ids) => changeDiscussionOpen(ids, decision.id, next))}
    >
      {open ? <DiscussionBody key={identity} decision={decision} /> : null}
    </DisclosurePanel>
  );
}

/** Cheap outer: no projection, no reads; a reader change replaces the subtree and drops the OPEN flags. */
export function DecisionDiscussion({ decision }: { decision: Decision }) {
  const user = useUser();
  return <ReaderDiscussion key={JSON.stringify([user.login, user.role])} decision={decision} />;
}
