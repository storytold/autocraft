import { useId, useState } from "react";
import { useQuery } from "../../../api/client";
import type { AgentRunDetail, HistoryCall } from "../../../api/types";
import { formatCost } from "../../../lib/trace";
import { useUser } from "../../../shell/UserContext";
import { Button } from "../../../ui/atoms/Button";
import { ErrorLine } from "../../../ui/atoms/ErrorLine";
import { DisclosurePanel } from "../../../ui/molecules/DisclosurePanel";
import { RemoteVia } from "../../../ui/molecules/RemoteVia";
import { ModelCallDetail } from "../../../ui/organisms/ModelCallDetail";

type Props = { call: HistoryCall; repo: string; number: number };

/** Reader/item/run changes close the disclosure before any prior detail can be rendered. */
export function HistoryCallDetail(props: Props) {
  const user = useUser();
  if (user.role === "viewer") return null;
  const scope = JSON.stringify([user.login, user.role, props.repo, props.number, props.call.runId]);
  return <CallDisclosure key={scope} call={props.call} scope={scope} />;
}

function CallDisclosure({ call, scope }: { call: HistoryCall; scope: string }) {
  const [open, setOpen] = useState(false);
  const title = <span className="break-words">{call.label}{call.via && <RemoteVia via={call.via} className="ml-2" />}</span>;
  const cost = formatCost(call.costUsd);
  const runId = call.runId;
  if (call.kind !== "model" || typeof runId !== "number" || !Number.isSafeInteger(runId) || runId <= 0) {
    return <div className="flex gap-2"><span className="min-w-0 flex-1">{title}</span>{cost && <span className="num">{cost}</span>}</div>;
  }
  return (
    <DisclosurePanel title={title} summary={cost} open={open} onOpenChange={setOpen} className="bg-transparent">
      {/* Native disclosures keep children mounted: the explicit call toggle owns this GET. */}
      {open ? <RunRead scope={scope} runId={runId} /> : null}
    </DisclosurePanel>
  );
}

function RunRead({ scope, runId }: { scope: string; runId: number }) {
  // Each mount gets a fresh receipt, even if a closed read has not yet been garbage-collected.
  const readId = useId();
  const requestKey = `item-trace-run:history:${JSON.stringify([scope, readId])}`;
  const q = useQuery<{ requestKey: string; run: AgentRunDetail }>(requestKey, async (api) => ({
    requestKey, run: await api.agents.get(runId),
  }), { gcTime: 0 });
  let error = q.error ? q.error.message || "Could not load call details." : undefined;
  if (!q.error && !q.loading && (!q.data || q.data.requestKey !== requestKey || q.data.run?.id !== runId)) {
    error = "The call details do not match this history entry.";
  }
  if (error !== undefined) return (
    <div className="space-y-2 px-4 py-3">
      <ErrorLine error={error} />
      <Button variant="secondary" size="sm" onClick={q.refetch}>Retry</Button>
    </div>
  );
  if (q.loading || !q.data) return <p role="status" className="px-4 py-3 text-sm text-ink/55">Loading call details…</p>;
  const run = q.data.run;
  const call = {
    model: run.model, provider: run.provider, account: run.accountLabel, state: run.state,
    inputTokens: run.inputTokens, outputTokens: run.outputTokens, costUsd: run.costUsd,
    toolCalls: run.tools.length, endedAt: run.endedAt, via: run.via,
  };
  return <div className="px-4 py-3"><ModelCallDetail call={call} runId={runId} run={run} /></div>;
}
