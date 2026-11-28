// The Jev form (AUTO-157): a Jev prompt's questions with their key, type, labels and opening sentence read-only, and
// the rest of each instruction and each criterion's text editable. The editor that mounts it runs the check, the diff,
// the note and the save with jevEditedBody (web/src/lib/jev-form.ts).
import { LockSimpleIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { Badge } from "../../ui/atoms/Badge";
import { Textarea } from "../../ui/atoms/Textarea";
import { cn } from "../../ui/cn";
import type { JevDraft, JevDrafts, JevFormQuestion } from "../../lib/jev-form";

/** A check's problem; those whose `where` names a question (`question <key> …`) show under it. */
export type JevFormProblem = { where: string; message: string };

/** Rows for browsers without field-sizing: the text's lines at `perLine` characters, within 2 to 14. */
const rowsFor = (text: string, perLine: number): number => Math.min(14, Math.max(2, Math.ceil(text.length / perLine) + text.split("\n").length));

function Locked({ text, name }: { text: string; name: string }) {
  return (
    <p role="note" aria-label={t("Locked: {name}", { name })} className="flex min-w-0 items-start gap-1.5 rounded border border-dashed border-line bg-sunken/60 px-2.5 py-1.5 text-sm text-ink/70">
      <LockSimpleIcon aria-hidden className="mt-0.5 shrink-0" size={14} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  );
}

function Field({ label, value, readOnly, invalid, perLine, onChange }: { label: string; value: string; readOnly: boolean; invalid: boolean; perLine: number; onChange: (v: string) => void }) {
  if (readOnly) return <p className="min-w-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{value}</p>;
  return <Textarea aria-label={label} value={value} rows={rowsFor(value, perLine)} invalid={invalid} className="max-h-96 min-h-[3.25rem] [field-sizing:content]" onChange={(e) => onChange(e.target.value)} />;
}

function Question({ q, draft, readOnly, problems, onChange }: { q: JevFormQuestion; draft: JevDraft; readOnly: boolean; problems: JevFormProblem[]; onChange: (d: JevDraft) => void }) {
  const at = (where: string): boolean => problems.some((p) => p.where === where);
  const labels = Object.keys(q.criteria ?? {});
  return (
    <li className="min-w-0 rounded border border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs font-semibold">{q.id}</code>
        <Badge>{q.type}</Badge>
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="text-xs font-medium text-ink/60">{t("Instructions")}</div>
        {q.lead && <Locked text={q.lead.trim()} name={t("opening sentence of {key}", { key: q.id })} />}
        <Field label={t("Instructions of {key}", { key: q.id })} value={draft.instructions} readOnly={readOnly} perLine={60} invalid={at(`question ${q.id} instructions`) || at(`question ${q.id}`)} onChange={(v) => onChange({ ...draft, instructions: v })} />
      </div>
      {labels.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-medium text-ink/60">{t("Criteria")}</div>
          {labels.map((l) => (
            <div key={l} className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[10rem_1fr] sm:gap-3">
              <div className="flex min-w-0 items-start gap-1 pt-1.5 font-mono text-xs">
                <LockSimpleIcon aria-hidden className="mt-0.5 shrink-0 text-ink/50" size={12} />
                <span className="sr-only">{t("Locked label:")} </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{l}</span>
              </div>
              <Field
                label={t("Criterion {label} of {key}", { label: l, key: q.id })}
                value={draft.criteria[l] ?? ""}
                readOnly={readOnly}
                perLine={36}
                invalid={at(`question ${q.id} criterion ${l}`) || at(`question ${q.id} criteria`)}
                onChange={(v) => onChange({ ...draft, criteria: { ...draft.criteria, [l]: v } })}
              />
            </div>
          ))}
        </div>
      )}
      {problems.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-bad" aria-live="polite">
          {problems.map((p, i) => <li key={i}>{p.message}</li>)}
        </ul>
      )}
    </li>
  );
}

/**
 * The questions of a Jev prompt. `drafts` (from jevDrafts) hold the editable text; with `readOnly` (a viewer, or no edit
 * started) the text shows as text. `problems`: the last check's, shown under the question each names.
 */
export function JevForm({ questions, drafts, onChange, readOnly = false, problems = [], className }: {
  questions: readonly JevFormQuestion[];
  drafts: JevDrafts;
  onChange?: (d: JevDrafts) => void;
  readOnly?: boolean;
  problems?: readonly JevFormProblem[];
  className?: string;
}) {
  const of = (key: string): JevFormProblem[] => problems.filter((p) => p.where === `question ${key}` || p.where.startsWith(`question ${key} `));
  return (
    <ul className={cn("space-y-3", className)}>
      {questions.map((q) => (
        <Question
          key={q.id}
          q={q}
          draft={drafts[q.id] ?? { instructions: "", criteria: {} }}
          readOnly={readOnly || !onChange}
          problems={of(q.id)}
          onChange={(d) => onChange?.({ ...drafts, [q.id]: d })}
        />
      ))}
    </ul>
  );
}
