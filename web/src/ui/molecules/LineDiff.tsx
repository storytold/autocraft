import type { PromptDiffLine as DiffLine } from "../../api/types";
import { t } from "../../../../src/i18n/index.ts";
import { cn } from "../cn";

/** A line diff (src/prompts/diff.ts): added and removed lines carry a sign and a spoken name as well as their colour. */
export function LineDiff({ lines, label, className }: { lines: DiffLine[]; label: string; className?: string }) {
  if (!lines.length) return <p className={cn("text-sm text-ink/60", className)}>{t("No changes.")}</p>;
  return (
    <div role="group" aria-label={label} className={cn("min-w-0 overflow-hidden rounded border border-line bg-sunken font-mono text-xs leading-relaxed", className)}>
      {lines.map((l, i) =>
        l.kind === "skip" ? (
          <div key={i} className="border-y border-line px-3 py-0.5 text-ink/50 first:border-t-0 last:border-b-0">
            {t("{count} unchanged lines", { count: l.count })}
          </div>
        ) : (
          <div key={i} className={cn("flex min-w-0 gap-2 px-3", l.kind === "add" && "bg-ok/10", l.kind === "del" && "bg-bad/10")}>
            <span aria-hidden className={cn("w-3 shrink-0 select-none", l.kind === "add" ? "text-ok" : l.kind === "del" ? "text-bad" : "text-ink/35")}>
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            </span>
            {l.kind !== "same" && <span className="sr-only">{l.kind === "add" ? t("Added:") : t("Removed:")}</span>}
            <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]")}>{l.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}
