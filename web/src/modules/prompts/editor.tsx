// Editing a base prompt: a Claude prompt's locked blocks stay read-only in place and its editable text is edited in fields;
// a Jev prompt is edited with the Jev form. Either save goes through the server's check (problems and diff) and a note.
import { useState } from "react";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { useApi } from "../../api/client";
import type { PromptCheckReply, PromptInfo, PromptProblem, PromptSegment } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Textarea } from "../../ui/atoms/Textarea";
import { useWrite } from "../../lib/hooks";
import { carryDrafts, draftsChanged, editedBody, type Drafts } from "../../lib/prompt-segments";
import { jevDrafts, jevDraftsChanged, jevEditedBody, type JevDrafts } from "../../lib/jev-form";
import { JevForm } from "./jev-form";
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

/**
 * The check, the review and the save of an edit that started from revision `rev`. A refused save shows its problems in the
 * review; a save made meanwhile answers 409, and `onConflict` moves the draft onto the prompt as it is now.
 */
function useSaveFlow(p: PromptInfo, rev: number | null, body: string | null, onClose: () => void, onConflict: (fresh: PromptInfo) => void) {
  const api = useApi();
  const write = useWrite();
  const [reply, setReply] = useState<PromptCheckReply | null>(null);
  const [problems, setProblems] = useState<PromptProblem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const review = () => void write.run("check", async () => {
    if (body === null) return;
    setNotice(null);
    const r = await api.prompt.check(p.id, { body, note: "", baseRev: rev });
    setProblems(r.problems.filter((x) => x.where !== "note"));
    setReply(r);
  });
  const save = (note: string) => void write.run("save", async () => {
    if (body === null) return;
    try {
      const r = await api.prompt.save(p.id, { body, note, baseRev: rev });
      if (!r.ok) {
        setProblems(r.problems.filter((x) => x.where !== "note"));
        setReply((old) => ({ ok: false, problems: r.problems, diff: old?.diff ?? [], version: null }));
        return;
      }
      onClose();
    } catch (e) {
      if (!isConflict(e)) throw e;
      const fresh = await api.prompt.get(p.id);
      onConflict(fresh);
      setReply(null);
      setNotice(t("Someone saved r{rev} meanwhile. Review your changes against it.", { rev: fresh.edit.rev ?? "" }));
    }
  });
  const reviewStep = reply && <ReviewStep reply={reply} onBack={() => setReply(null)} onSave={save} busy={write.busy === "save"} error={write.error} />;
  const noticeLine = notice && <p role="alert" className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-sm">{notice}</p>;
  const actions = (changed: boolean) => (
    <>
      <ErrorLine error={write.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose} className="max-md:h-11">{t("Cancel")}</Button>
        <Button variant="primary" disabled={!changed} loading={write.busy === "check"} onClick={review} className="max-md:h-11">{t("Review changes")}</Button>
      </div>
    </>
  );
  return { reviewStep, noticeLine, actions, problems };
}

/** The editor in place of the template. Live updates leave the draft alone; a save made meanwhile answers 409 and the draft moves onto it. */
export function PromptEditor({ p, onClose }: { p: PromptInfo; onClose: () => void }) {
  return p.runner === "jev" ? <JevEditor p={p} onClose={onClose} /> : <ClaudeEditor p={p} onClose={onClose} />;
}

function ClaudeEditor({ p, onClose }: { p: PromptInfo; onClose: () => void }) {
  const [base, setBase] = useState({ segs: p.segments, rev: p.edit.rev });
  const [drafts, setDrafts] = useState<Drafts>({});
  const body = editedBody(base.segs, drafts);
  const flow = useSaveFlow(p, base.rev, body, onClose, (fresh) => {
    setDrafts(carryDrafts(base.segs, fresh.segments, drafts));
    setBase({ segs: fresh.segments, rev: fresh.edit.rev });
  });
  let editable = 0;
  if (flow.reviewStep) return flow.reviewStep;
  return (
    <div className="flex flex-col gap-2">
      {flow.noticeLine}
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
      {flow.actions(draftsChanged(base.segs, drafts))}
    </div>
  );
}

/** A Jev prompt's questions in the Jev form; keys, types, labels and opening sentences stay the code's, so a draft carries over a save made meanwhile. */
function JevEditor({ p, onClose }: { p: PromptInfo; onClose: () => void }) {
  const [base, setBase] = useState({ questions: p.questions, rev: p.edit.rev });
  const [drafts, setDrafts] = useState<JevDrafts>(() => jevDrafts(p.questions));
  const body = jevEditedBody(base.questions, drafts);
  const flow = useSaveFlow(p, base.rev, body, onClose, (fresh) => setBase({ questions: fresh.questions, rev: fresh.edit.rev }));
  if (flow.reviewStep) return flow.reviewStep;
  return (
    <div className="flex flex-col gap-2">
      {flow.noticeLine}
      <JevForm questions={base.questions} drafts={drafts} onChange={setDrafts} problems={flow.problems} />
      {flow.actions(jevDraftsChanged(base.questions, drafts))}
    </div>
  );
}
