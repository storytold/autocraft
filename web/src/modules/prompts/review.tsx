// What a prompt edit and a repo's guidance share: the review step before a save (problems, diff, note), the note dialog of a
// rollback or a release switch, and the revision list.
import { useState, type FormEvent } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { useQuery } from "../../api/client";
import type { PromptCheckReply, PromptDiffLine, PromptRevisionInfo, PromptSaveReply } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Textarea } from "../../ui/atoms/Textarea";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Dialog } from "../../ui/molecules/Dialog";
import { DisclosureButton } from "../../ui/molecules/DisclosureButton";
import { LineDiff } from "../../ui/molecules/LineDiff";
import { useWrite } from "../../lib/hooks";

export const NOTE_MAX = 300;

/** The server refused a save because another revision became active since the edit started. */
export const isConflict = (e: unknown): boolean => (e as { status?: number } | null)?.status === 409;

/** A rollback's or a release switch's reply as an error when the server refused it, so the dialog shows why. */
export function savedOrThrow(r: PromptSaveReply): PromptSaveReply {
  if (!r.ok) throw new Error(r.problems.map((p) => p.message).join("; ") || t("The server refused the change."));
  return r;
}

export function NoteField({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink/60">
      {t("Note")}
      <Textarea autoFocus={autoFocus} required value={value} maxLength={NOTE_MAX} rows={2} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/**
 * The check's result for the edit: its problems, the diff from the active text and the note. The check runs before the note
 * is written, so its note problem is left to the field; any other problem keeps Save off.
 */
export function ReviewStep({ reply, onBack, onSave, busy, error }: {
  reply: PromptCheckReply; onBack: () => void; onSave: (note: string) => void; busy: boolean; error: string | null;
}) {
  const [note, setNote] = useState("");
  const problems = reply.problems.filter((p) => p.where !== "note");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!problems.length && note.trim()) onSave(note.trim());
  };
  return (
    <form onSubmit={submit} aria-label={t("Review changes")} className="flex flex-col gap-3">
      {problems.length > 0 && (
        <ul aria-label={t("Problems")} role="alert" className="m-0 flex list-none flex-col gap-1 rounded border border-bad/40 bg-bad/5 p-3 text-sm">
          {problems.map((p, i) => (
            <li key={i} className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-medium text-bad">{p.where}:</span> {p.message}
            </li>
          ))}
        </ul>
      )}
      <LineDiff lines={reply.diff} label={t("Changes")} />
      {!problems.length && <NoteField value={note} onChange={setNote} autoFocus />}
      <ErrorLine error={error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onBack} className="max-md:h-11">{t("Back to editing")}</Button>
        {!problems.length && <Button type="submit" variant="primary" disabled={!note.trim()} loading={busy} className="max-md:h-11">{t("Save")}</Button>}
      </div>
    </form>
  );
}

/** A write that needs only a note: a rollback or the switch to the release version. */
export function NoteDialog({ title, action, onClose, onConfirm }: { title: string; action: string; onClose: () => void; onConfirm: (note: string) => Promise<unknown> }) {
  const [note, setNote] = useState("");
  const write = useWrite();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    void write.run("go", () => onConfirm(note.trim())).then((ok) => { if (ok) onClose(); });
  };
  return (
    <Dialog open onClose={onClose} title={title}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <NoteField value={note} onChange={setNote} autoFocus />
        <ErrorLine error={write.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} className="max-md:h-11">{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!note.trim()} loading={write.busy === "go"} className="max-md:h-11">{action}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function kindLabel(r: PromptRevisionInfo): string {
  switch (r.kind) {
    case "release": return t("Release default");
    case "use-release": return t("Release version");
    case "rollback": return r.fromRev === null ? t("Rollback") : t("Rollback to r{rev}", { rev: r.fromRev });
    case "edit": return t("Edit");
  }
}

/** The changes a revision made to the one before it. */
function RevisionDiff({ queryKey, load }: { queryKey: string; load: () => Promise<PromptDiffLine[]> }) {
  const { data, error } = useQuery(queryKey, () => load());
  if (!data) return <p className="text-xs text-ink/60">{error ? error.message : t("Loading.")}</p>;
  return <LineDiff lines={data} label={t("Changes")} />;
}

/**
 * Revisions newest first. `diff` loads a revision's changes against the previous one (none for the first). `rollback`, for
 * whoever may edit, makes a new revision with an older one's text.
 */
export function RevisionList({ idBase, revisions, diff, rollback }: {
  idBase: string;
  revisions: PromptRevisionInfo[];
  diff?: (rev: number) => { key: string; load: () => Promise<PromptDiffLine[]> };
  rollback?: (rev: number, note: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [rollTo, setRollTo] = useState<number | null>(null);
  if (!revisions.length) return <p className="py-2 text-sm text-ink/60">{t("No revisions yet.")}</p>;
  return (
    <>
      <ol aria-label={t("Revisions")} className="m-0 list-none p-0">
        {revisions.map((r, i) => {
          const prev = revisions[i + 1];
          const region = `${idBase}-r${r.rev}-diff`;
          const d = prev && diff ? diff(r.rev) : null;
          return (
            <li key={r.rev} className="border-t border-line py-2 first:border-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="num w-8 shrink-0 font-mono text-xs text-ink/60">r{r.rev}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{kindLabel(r)}</span>
                    {r.active && <Badge tone="accent">{t("Active")}</Badge>}
                  </span>
                  {r.kind !== "release" && <span className="mt-0.5 block break-words text-xs text-ink/75">{r.note}</span>}
                  <span className="mt-0.5 block text-xs text-ink/60">{r.author} · <TimeAgo iso={r.at} /></span>
                </span>
                {rollback && !r.active && (
                  <Button size="sm" icon={ArrowCounterClockwiseIcon} onClick={() => setRollTo(r.rev)} className="max-md:h-11" aria-label={t("Roll back to r{rev}", { rev: r.rev })}>
                    {t("Roll back")}
                  </Button>
                )}
              </div>
              {d && (
                <div className="mt-1">
                  <DisclosureButton open={open === r.rev} onToggle={(o) => setOpen(o ? r.rev : null)} controls={region} className="min-h-9 px-0 max-md:min-h-11">
                    {t("Changes from r{rev}", { rev: prev!.rev })}
                  </DisclosureButton>
                  {open === r.rev && <div id={region}><RevisionDiff queryKey={d.key} load={d.load} /></div>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {rollTo !== null && rollback && (
        <NoteDialog title={t("Roll back to r{rev}", { rev: rollTo })} action={t("Roll back")} onClose={() => setRollTo(null)} onConfirm={(note) => rollback(rollTo, note)} />
      )}
    </>
  );
}
