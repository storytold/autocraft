// A PR's merge checks (Review, CI, Verify, Merge, our own Build) and its size as Workable columns: one narrow column per check with its
// name written up the header, an icon in each cell and the state and its detail in the tip. The merge queue and Items share them.
import type { ReactNode } from "react";
import { CheckCircleIcon, CircleNotchIcon, ClockIcon, MinusCircleIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import type { ItemChecks, QueueRow } from "../../api/types";
import type { Tone } from "../../ui/atoms/Badge";
import { TipLines, Tooltip } from "../../ui/atoms/Tooltip";
import { useWorkableLayout, type WorkableColumn } from "../../ui/organisms/Workable";
import { CI_TONE, MERGEABLE, V_LABEL, V_TONE } from "./mergeParts";

const CHECK = (id: string, label: string, hint: string): WorkableColumn => ({ id, label, hint, width: "20px", align: "center", vertical: true, blank: true });

export const CHECK_COLUMNS: WorkableColumn[] = [
  CHECK("review", "Review", "Opus review verdict"),
  CHECK("ci", "CI", "Upstream CI at the head"),
  CHECK("verify", "Verify", "Build and tests at the reviewed head"),
  CHECK("merge", "Merge", "Mergeability against the base branch"),
  CHECK("build", "Build", "Our own build of the PR"),
];
export const SIZE_COLUMN: WorkableColumn = { id: "size", label: "Size", width: "40px", mdWidth: "32px" };

const CHECK_ICON: Record<Tone, ReactNode> = {
  ok: <CheckCircleIcon weight="fill" className="text-ok" />,
  bad: <XCircleIcon weight="fill" className="text-bad" />,
  warn: <WarningCircleIcon weight="fill" className="text-warn" />,
  accent: <CircleNotchIcon weight="bold" className="text-accent-ink" />,
  neutral: <MinusCircleIcon className="text-ink/35" />,
  merged: <CheckCircleIcon weight="fill" className="text-merged" />,
};

const TONE_TEXT: Record<Tone, string> = { ok: "text-ok", bad: "text-bad", warn: "text-warn", accent: "text-accent-ink", neutral: "text-ink/70", merged: "text-merged" };

/** One check as an icon; the column header names it, so the label shows only on a phone, where there is no header. The tip has the state and its detail. */
function Check({ label, tone, state, details = [] }: { label: string; tone: Tone; state: string; details?: (string | null | undefined)[] }) {
  const phone = useWorkableLayout() === "phone";
  return (
    <Tooltip
      title={
        <>
          {label}: <span className={TONE_TEXT[tone]}>{state}</span>
        </>
      }
      content={details.some(Boolean) ? <TipLines lines={details} /> : undefined}
    >
      <span tabIndex={0} className="relative z-10 inline-flex items-center gap-1 rounded-sm text-2xs text-ink/65 outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
        <span className="text-sm leading-none" aria-hidden>
          {tone === "neutral" && state.startsWith("pending") ? <ClockIcon className="text-ink/45" /> : CHECK_ICON[tone]}
        </span>
        <span className={phone ? undefined : "sr-only"}>{label}</span>
        <span className="sr-only">{`: ${[state, ...details].filter(Boolean).join(", ")}`}</span>
      </span>
    </Tooltip>
  );
}

type Build = NonNullable<QueueRow["prBuild"]>["state"];
const BUILD_TONE: Record<Build, Tone> = { queued: "neutral", running: "accent", passed: "ok", failed: "bad", error: "warn", stale: "neutral" };

/** The check cells by column id; a PR without checks (not in the merge queue) leaves them empty. */
export function checkCells(c: ItemChecks | null | undefined): Record<string, ReactNode> {
  if (!c) return {};
  const verify = c.verify;
  const inconclusive = verify?.regressionInconclusive;
  return {
    review: <Check label="Review" tone={c.verdict === "take" ? "ok" : c.verdict === null ? "neutral" : "warn"} state={c.verdict ?? "none"} />,
    ci: <Check label="CI" tone={CI_TONE[c.ci]} state={c.ci} />,
    verify: <Check label="Verify" tone={inconclusive ? "warn" : verify ? V_TONE[verify.state] ?? "neutral" : "neutral"} state={inconclusive ? "Head passed, regression inconclusive" : verify ? V_LABEL[verify.state] ?? verify.state : "none"} details={[verify?.summary, verify?.note]} />,
    merge: <Check label="Merge" tone={MERGEABLE[c.mergeable][1]} state={MERGEABLE[c.mergeable][0]} />,
    build: c.prBuild ? <Check label="Build" tone={BUILD_TONE[c.prBuild.state]} state={c.prBuild.state} details={[c.prBuild.current ? null : "At an older head", c.prBuild.summary]} /> : undefined,
  };
}

export const Size = ({ size }: { size: string }) => <span className="num text-xs text-ink/70">{size}</span>;
