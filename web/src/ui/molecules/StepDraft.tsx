import type { ReactNode } from "react";
import { Button } from "../atoms/Button";

/**
 * A step's editable draft under its line: a label row carrying the Edit / Cancel edit control, then the preview or the
 * editor at full width. The control never sits stranded under a tall field and never takes width from it. Props only.
 */
export function StepDraft({ editing, onToggle, disabled, readOnly, label, preview, editor }: { editing: boolean; onToggle: () => void; disabled?: boolean; /** Shows the draft without the Edit button. */ readOnly?: boolean; /** Names the draft above it (the editor keeps its own accessible name). */ label?: ReactNode; preview: ReactNode; editor: ReactNode }) {
  return (
    <div className="mb-1 mt-1">
      {/* No label and no control means no header at all: otherwise a read-only draft carried an empty 4 px row. */}
      {(label || !readOnly) && (
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="min-w-0 text-2xs font-medium text-ink/60">{label}</div>
          {!readOnly && (
            <Button size="sm" variant="secondary" className="shrink-0 max-md:h-11" disabled={disabled} onClick={onToggle}>
              {editing ? "Cancel edit" : "Edit"}
            </Button>
          )}
        </div>
      )}
      {editing ? editor : preview}
    </div>
  );
}
