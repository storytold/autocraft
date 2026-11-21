import { useState } from "react";
import { useApi } from "../../api/client";
import type { Decision } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { Select } from "../../ui/atoms/Select";
import { Textarea } from "../../ui/atoms/Textarea";

/** The one feedback box: free text and an optional pick among the decision's options. It never answers. */
export function FeedbackBox({ d, className }: { d: Decision; className?: string }) {
  const api = useApi();
  const [text, setText] = useState("");
  const [option, setOption] = useState("");
  const [busy, setBusy] = useState(false);
  const canPick = !d.answer;
  const ready = !!text.trim() || (canPick && !!option);
  const send = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api.decisions.feedback(d.id, { option: canPick && option ? option : null, text: text.trim() || undefined });
      setText("");
      setOption("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={className}>
      <label className="block">
        <span className="mb-1 block text-2xs font-medium text-ink/60">Feedback</span>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          rows={3}
          placeholder="What should change?"
          aria-label="Feedback"
          className="resize-none"
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canPick && (
          <Select value={option} onChange={(e) => setOption(e.target.value)} aria-label="Option" className="min-w-0 text-xs">
            <option value="">No option</option>
            {d.options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
        <Button size="sm" variant="secondary" className="ml-auto max-md:h-11" loading={busy} disabled={!ready} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </div>
  );
}
