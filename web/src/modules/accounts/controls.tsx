// Claude account controls: usage bars, pause levels, the classifier and model lines, and the label and concurrency form.
import { useEffect, useState } from "react";
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { ClaudeAccount, JevStatus, ProviderStatus, UsagePause } from "../../api/types";
import { clock, nowMs, span } from "../../lib/format";
import { Button } from "../../ui/atoms/Button";
import { cn } from "../../ui/cn";
import { ErrorLine, TextInput, useWrite } from "../admin/parts";
import { useNow } from "../../lib/useNow";

/** One usage bar: width is the share used; the colour warns from 75 % and goes critical from 90 %. */
export function UsageBar({ label, pct, resetsAt }: { label: string; pct: number | null; resetsAt: string | null }) {
  useNow();
  const tone = pct === null ? "bg-ink/20" : pct >= 90 ? "bg-bad" : pct >= 75 ? "bg-warn" : "bg-c1";
  const resets = resetsAt ? Date.parse(resetsAt) - nowMs() : null;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="whitespace-nowrap text-ink/60">
          {label} <span className="num font-medium text-ink">{pct === null ? "no reading" : `${pct} %`}</span>
        </span>
        {resets !== null && <span className="num whitespace-nowrap text-ink/50">{resets > 0 ? `resets in ${span(resets)}` : "reset due"}</span>}
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-sm bg-ink/[0.07]" role="img" aria-label={`${label}: ${pct === null ? "no reading" : `${pct} percent used`}`}>
        <div className={cn("h-full rounded-sm", tone)} style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}

const usePause = () => useQuery<UsagePause>("accounts-pause", (a) => a.accounts.pause());

const validLevel = (v: string) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 100;

export function PauseLevels({ operator }: { operator: boolean }) {
  const api = useApi();
  const write = useWrite();
  const q = usePause();
  const [editing, setEditing] = useState(false);
  const [five, setFive] = useState("");
  const [week, setWeek] = useState("");
  useEffect(() => {
    if (q.data) {
      setFive(String(q.data.fiveHour));
      setWeek(String(q.data.weekly));
    }
  }, [q.data]);
  if (!q.data) return <ErrorLine error={q.error?.message} />;
  return (
    <div className="mb-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-ink/60">
          Pauses at 5-hour use <span className="num font-medium text-ink">{q.data.fiveHour} %</span>
        </span>
        <span className="text-ink/60">
          weekly use <span className="num font-medium text-ink">{q.data.weekly} %</span>
        </span>
        {operator && (
          <button onClick={() => setEditing(!editing)} aria-label="Edit pause levels" className="flex size-7 items-center justify-center text-ink/50 hover:bg-ink/[0.06] hover:text-ink max-md:size-11">
            <PencilSimpleIcon className="text-[14px]" />
          </button>
        )}
      </div>
      {operator && editing && (
        <form
          className="mt-2 flex flex-wrap items-end gap-3 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void write.run("pause", () => api.accounts.setPause({ fiveHour: Number(five), weekly: Number(week) })).then((ok) => {
              if (ok) {
                setEditing(false);
                q.refetch();
              }
            });
          }}
        >
          <label className="flex flex-col gap-1 text-ink/60">
            5-hour (1 to 100)
            <TextInput inputMode="numeric" value={five} onChange={(e) => setFive(e.target.value)} className="w-24 text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-ink/60">
            Weekly (1 to 100)
            <TextInput inputMode="numeric" value={week} onChange={(e) => setWeek(e.target.value)} className="w-24 text-ink" />
          </label>
          <Button type="submit" variant="primary" size="sm" disabled={!validLevel(five) || !validLevel(week)} loading={write.busy === "pause"} className="max-md:h-11">
            Save
          </Button>
          <ErrorLine error={write.error} className="basis-full" />
        </form>
      )}
    </div>
  );
}

/**
 * The classifier line: Jev, or the model of the compatible provider that answers its typed decisions instead. The switch
 * turns the classifier off in either case, and the fallback model then decides alone; the line says so rather than
 * looking healthy.
 */
export function JevLine({ operator }: { operator: boolean }) {
  const api = useApi();
  const write = useWrite();
  const q = useQuery<JevStatus>("accounts-jev", (a) => a.accounts.jev());
  if (!q.data) return <ErrorLine error={q.error?.message} />;
  const { enabled, unavailable, provider, model, problem } = q.data;
  const who = provider === "jev" || provider === "invalid" ? "Jev" : (model ?? "a configured model");
  const kind = provider === "compatible" ? " (the compatible classifier)" : provider === "decisions" ? " (the decisions endpoint)" : "";
  const line = provider === "invalid"
    ? `The classifier cannot run: ${problem ?? "its configuration is incomplete"} — the fallback model does that work`
    : unavailable
    ? `${who} is unavailable (${unavailable.reason}) since ${clock(unavailable.since)} — the fallback model does that work`
    : provider === "jev" ? "Jev in use" : `${who} answers the typed decisions${kind}`;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="text-ink/60">
        {line}
      </span>
      {operator && (
        <Button variant="secondary" size="sm" loading={write.busy === "jev"} onClick={() => void write.run("jev", () => api.accounts.setJev({ enabled: !enabled })).then((ok) => ok && q.refetch())} className="max-md:h-11">
          {enabled ? `Turn ${provider === "jev" ? "Jev" : "the classifier"} off` : `Turn ${provider === "jev" ? "Jev" : "the classifier"} on`}
        </Button>
      )}
      <ErrorLine error={write.error} className="basis-full" />
    </div>
  );
}

/**
 * Which provider makes this host's model calls, and the classifier's, as its environment configures them. A compatible
 * provider with a problem (an unreadable key file, an invalid base URL) says so here: without a line, a call would only
 * fail later, in a job log an operator may not read.
 */
export function ProviderLine() {
  const q = useQuery<ProviderStatus>("accounts-providers", (a) => a.accounts.providers());
  if (!q.data) return <ErrorLine error={q.error?.message} />;
  const { mode, model, classifier } = q.data;
  const modelLine = mode === "user-local"
    ? "Model calls run on maintainers' Task Runners (the user-local inference mode); the model provider below is not used"
    : model.provider === "compatible"
    ? `Model calls run on the compatible provider: ${model.models.top}, ${model.models.mid} and ${model.models.small} for the top, mid and small tiers${model.problem ? ` — ${model.problem}` : ""}`
    : model.provider === "invalid" ? `Model calls cannot run: ${model.reason}` : "Model calls run on Claude accounts";
  return (
    <div className="mb-3 space-y-1 text-xs text-ink/60">
      <p>{modelLine}</p>
      {classifier.provider === "invalid" && <p>The typed decisions cannot run: {classifier.reason}</p>}
    </div>
  );
}

export function EditForm({ a, onDone }: { a: ClaudeAccount; onDone: () => void }) {
  const api = useApi();
  const write = useWrite();
  const [label, setLabel] = useState(a.label);
  const [enabled, setEnabled] = useState(a.enabled);
  const [max, setMax] = useState(String(a.maxConcurrent));
  useEffect(() => {
    setLabel(a.label);
    setEnabled(a.enabled);
    setMax(String(a.maxConcurrent));
  }, [a]);
  const valid = label.trim() !== "" && /^\d{1,3}$/.test(max) && Number(max) >= 1 && Number(max) <= 100;
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void write.run("save", () => api.accounts.update(a.id, { label: label.trim(), enabled, maxConcurrent: Number(max) })).then((ok) => ok && onDone());
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-ink/60">
        Label
        <TextInput value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} className="w-48 text-ink" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink/60">
        Max concurrent (1 to 100)
        <TextInput inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} className="w-24 text-ink" />
      </label>
      <label className="flex h-8 items-center gap-2 text-sm max-md:h-11">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4" />
        Enabled
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!valid} loading={write.busy === "save"} className="max-md:h-11">
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} className="max-md:h-11">
          Cancel
        </Button>
      </div>
      <ErrorLine error={write.error} className="basis-full" />
    </form>
  );
}
