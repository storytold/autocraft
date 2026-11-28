// Editing a base Claude prompt: its locked blocks stay read-only in place, its editable text is edited in fields, and a
// save goes through the server's check (problems and diff) and a note.
import { useState } from "react";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { useApi } from "../../api/client";
import type { PromptCheckReply, PromptInfo, PromptSegment } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Textarea } from "../../ui/atoms/Textarea";
import { useWrite } from "../../lib/hooks";
import { carryDrafts, draftsChanged, editedBody, type Drafts } from "../../lib/prompt-segments";
import { ReviewStep, isConflict } from "./review";

/** Locked blocks longer than this many lines start folded. */
const FOLD_LINES = 6;

function LockedBlock({ s }: { s: PromptSegment }) {
  const lines = s.text.replace(/^\n+|\n+$/g, "").split("\n");
  const long = lines.length > FOLD_LINES;
  const [open, setOpen] = useState(false);
  const shown = long && !open ? lines.slice(0, 3).join("\n") : lines.join("\n");
  return (
    <div role="group" aria-label={t("Locked: {name}", { name: s.name ?? "" })} className="min-w-0 rounded border border-dashed border-line-strong bg-sunken/60 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-2xs text-ink/60">
        <LockSimpleIcon aria-hidden />
        <span>{s.name}</span>
        {long && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="ml-auto rounded px-1 text-accent-ink hover:underline max-md:min-h-11">
            {open ? t("Show less") : t("Show all {count} lines", { count: lines.length })}
          </button>
        )}
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink/75 [overflow-wrap:anywhere]">{shown}{long && !open ? "\n…" : ""}</pre>
    </div>
  );
}

/** The editor in place of the template. Live updates leave the draft alone; a save made meanwhile answers 409 and the draft moves onto it. */
export function PromptEditor({ p, onClose }: { p: PromptInfo; onClose: () => void }) {
  const api = useApi();
  const write = useWrite();
  const [base, setBase] = useState({ segs: p.segments ?? [], rev: p.edit?.rev ?? null });
  const [drafts, setDrafts] = useState<Drafts>({});
  const [reply, setReply] = useState<PromptCheckReply | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const body = editedBody(base.segs, drafts);
  const changed = draftsChanged(base.segs, drafts);
  let editable = 0;

  const review = () => void write.run("check", async () => {
    if (body === null) return;
    setNotice(null);
    setReply(await api.prompt.check(p.id, { body, note: "", baseRev: base.rev }));
  });
  const save = (note: string) => void write.run("save", async () => {
    if (body === null) return;
    try {
      await api.prompt.save(p.id, { body, note, baseRev: base.rev });
      onClose();
    } catch (e) {
      if (!isConflict(e)) throw e;
      const fresh = await api.prompt.get(p.id);
      const segs = fresh.segments ?? [];
      setDrafts(carryDrafts(base.segs, segs, drafts));
      setBase({ segs, rev: fresh.edit?.rev ?? null });
      setReply(null);
      setNotice(t("Someone saved r{rev} meanwhile. Review your changes against it.", { rev: fresh.edit?.rev ?? "" }));
    }
  });

  if (reply) return <ReviewStep reply={reply} onBack={() => setReply(null)} onSave={save} busy={write.busy === "save"} error={write.error} />;
  return (
    <div className="flex flex-col gap-2">
      {notice && <p role="alert" className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-sm">{notice}</p>}
      {base.segs.map((s, i) => {
        if (s.locked) return <LockedBlock key={i} s={s} />;
        // Whitespace between two locked blocks stays as it is.
        if (!s.text.trim()) return null;
        const n = ++editable;
        const value = drafts[i] ?? s.text;
        return (
          <Textarea
            key={i}
            aria-label={t("Editable text {n}", { n })}
            value={value}
            rows={Math.max(2, value.split("\n").length)}
            onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
            className="resize-y [field-sizing:content]"
          />
        );
      })}
      <ErrorLine error={write.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose} className="max-md:h-11">{t("Cancel")}</Button>
        <Button variant="primary" disabled={!changed} loading={write.busy === "check"} onClick={review} className="max-md:h-11">{t("Review changes")}</Button>
      </div>
    </div>
  );
}
