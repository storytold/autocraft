import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeftIcon, CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { queuePosition, readFrom, stepFrom, type From } from "../../lib/links";
import { useHotkeys, useShortcutHelp } from "../../shell/keyboard";
import type { Command } from "../../registry/types";

/**
 * The item page's way back: the Needs you queue it was opened from, with its filters and selection, or Items. Opened
 * from the queue, previous and next step through the decisions that were loaded there.
 */
export function BackLink({ className }: { className: string }) {
  const from = readFrom(useLocation().state);
  return <>
    <Link to={from?.url ?? "/items"} className={className}><ArrowLeftIcon aria-hidden /> {from ? t("Needs you") : t("Items")}</Link>
    {from && <QueueNav from={from} />}
  </>;
}

const SHORTCUTS: Command[] = [
  { id: "q-prev", keys: "[", label: "Previous decision from Needs you", group: "Item" },
  { id: "q-next", keys: "]", label: "Next decision from Needs you", group: "Item" },
];

function QueueNav({ from }: { from: From }) {
  const navigate = useNavigate();
  const pos = queuePosition(from);
  const prev = stepFrom(from, -1);
  const next = stepFrom(from, 1);
  const go = (step: typeof prev) => step && navigate(step.path, { state: step.state });
  useShortcutHelp(pos ? SHORTCUTS : []);
  useHotkeys({ "[": () => go(prev), "]": () => go(next) }, !!pos);
  if (!pos) return null;
  const button = "inline-flex size-7 items-center justify-center rounded text-ink/70 hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent max-md:size-11";
  return <nav aria-label={t("Decisions from Needs you")} className="inline-flex items-center gap-0.5 text-xs text-ink/60">
    <button type="button" aria-label={t("Previous decision")} disabled={!prev} onClick={() => go(prev)} className={button}><CaretLeftIcon aria-hidden /></button>
    <span className="num tabular-nums">{t("{at} of {of}", pos)}</span>
    <button type="button" aria-label={t("Next decision")} disabled={!next} onClick={() => go(next)} className={button}><CaretRightIcon aria-hidden /></button>
  </nav>;
}
