// Home: what needs me, is anything broken, is it moving.
import { ProjectMergeQueue } from "./live";
import { LiveBoard } from "./LiveBoard";
import { ALL } from "../../api/scope";
import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, CaretRightIcon, GitMergeIcon, ProhibitIcon, ChatTeardropTextIcon, ShieldWarningIcon, WarningCircleIcon, XCircleIcon, type Icon } from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import type { HomeDone, HomeNeed, ItemPhase, NeedKind } from "../../api/types";
import { Pending } from "../../ui/atoms/Pending";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Section } from "../../ui/molecules/Section";
import { WorkableGroup, WorkableRow, WorkableTable, type WorkableColumn } from "../../ui/organisms/Workable";
import { cn } from "../../ui/cn";
import { num } from "../../lib/format";
import { itemPath } from "../../lib/links";
import { useUser } from "../../shell/UserContext";
import { PageTitle } from "../../shell/PageHeader";
import { KIND_ICON } from "../decisions/parts";
import type { ViewProps } from "../../registry/types";

const NEED_LABEL: Record<NeedKind, string> = { merge: "Merge?", scope: "Scope", duplicate: "Duplicates", close: "Close", hold: "Hold", split: "Split", other: "Other", backlog: "Backlog", security: "Security", feedback: "Feedback", stopped: "Stopped" };
const NEED_ICON: Record<NeedKind, Icon> = { ...KIND_ICON, security: ShieldWarningIcon, feedback: ChatTeardropTextIcon, stopped: XCircleIcon };
const KIND_ORDER: NeedKind[] = ["merge", "security", "scope", "duplicate", "close", "hold", "split", "other", "feedback", "stopped"];
const NEED_TO: Partial<Record<NeedKind, string>> = { security: "/security", feedback: "/needs?tab=feedback", stopped: "/needs?tab=stopped" };
const SHOWN: ItemPhase[] = ["Triage", "Waiting for a person", "Review", "Fixing", "Verifying", "In queue", "Merged", "Closed"];
const PHASE_LABEL: Partial<Record<ItemPhase, string>> = { "Waiting for a person": "Waiting", Merged: "Merged today", Closed: "Closed today" };
const DONE_LABEL: Record<HomeDone["what"], string> = { merged: "Merged", closed: "Closed", "review posted": "Review posted" };
const DONE_ICON: Record<HomeDone["what"], Icon> = { merged: GitMergeIcon, closed: ProhibitIcon, "review posted": ChatTeardropTextIcon };

const NEED_COLUMNS: WorkableColumn[] = [
  { id: "rec", label: "Recommended", width: "280px", mdWidth: "200px", hint: "The answer the pipeline recommends" },
  { id: "asked", label: "Asked", width: "110px", mdWidth: "96px", align: "end" },
];

/** One open question: its item (a security finding by its number), what the pipeline recommends and when it was asked; the title opens the question. */
function NeedRow({ n, canOpen }: { n: HomeNeed; canOpen: boolean }) {
  const finding = n.kind === "security" || n.number === null;
  return (
    <WorkableRow
      item={{
        repo: n.repo, number: n.number ?? 0, kind: finding ? "finding" : n.itemKind, state: "open", title: n.title, to: n.to,
        id: finding ? <span className="code text-ink/60">finding {n.number ?? ""}</span> : undefined,
      }}
      cells={{
        rec: n.recommendation && canOpen ? <span className="text-xs text-ink/80">{n.recommendation}</span> : undefined,
        asked: <TimeAgo iso={n.askedAt} className="num text-xs text-ink/50" />,
      }}
    />
  );
}

/** A project's page: the home view for one repo, or for every repo when the project is `all`. */
export function HomeView(_: ViewProps) {
  const user = useUser();
  const { repo: param } = useParams();
  const repo = param && param !== ALL ? param : undefined;
  // The page's path names its project, so every request on it is that project's.
  const { data, error } = useQuery("home", (a) => a.home());
  const repos = useQuery("repos", (a) => a.repos());
  // Links to other pages carry the project as their repo filter.
  const scoped = (to: string) => (repo ? `${to}${to.includes("?") ? "&" : "?"}repo=${encodeURIComponent(repo)}` : to);
  // The server ignores a project the user cannot see, so its page would show every repo under that name.
  if (repo && repos.data && !repos.data.includes(repo)) return <div className="p-8 text-ink/60">Nothing here.</div>;
  if (!data) return <Pending error={error} />;
  const { needs, problems, phases, progress, done } = data;
  const kinds = KIND_ORDER.filter((k) => needs.byKind[k]);
  const max = Math.max(...progress.perHour, 1);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-7 px-4 pb-10 pt-5 md:px-6">
        <ProjectHeader repo={repo} />
        <LiveBoard to={scoped("/now")} />
        {problems.length > 0 && (
          <Section title="Problems" count={problems.length}>
            <ul>
              {problems.map((p) => (
                <li key={`${p.kind}${p.to}${p.title}`} className="relative flex items-start gap-3 border-t border-line py-2.5 hover:bg-ink/[0.025] max-md:py-3">
                  {p.kind === "stopped" ? <XCircleIcon weight="fill" className="mt-[3px] shrink-0 text-bad" /> : <WarningCircleIcon weight="fill" className="mt-[3px] shrink-0 text-warn" />}
                  <div className="min-w-0 flex-1">
                    <Link to={p.to} className="text-sm font-medium after:absolute after:inset-0 hover:underline">{p.title}</Link>
                    <div className="mt-0.5 text-xs text-ink/60">{p.detail}</div>
                  </div>
                  <CaretRightIcon className="mt-1 shrink-0 text-ink/30" />
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="Needs you" count={needs.total} to={scoped("/needs")} linkLabel="All decisions">
          {needs.total === 0 ? (
            <p className="border-t border-line py-3 text-sm text-ink/55">Nothing is waiting for a person.</p>
          ) : (
            <WorkableTable columns={NEED_COLUMNS} label="Needs you">
              {kinds.map((k) => {
                const Ico = NEED_ICON[k];
                return (
                  <WorkableGroup
                    key={k}
                    title={
                      <span className="inline-flex items-center gap-1.5">
                        <Ico className="text-ink/50" aria-hidden />
                        {NEED_LABEL[k]}
                      </span>
                    }
                    count={needs.byKind[k]}
                    aside={
                      <Link to={scoped(NEED_TO[k] ?? `/needs?kind=${k}`)} className="text-xs text-accent-ink hover:underline max-md:inline-flex max-md:h-11 max-md:items-center">
                        Open all
                      </Link>
                    }
                  >
                    {needs.oldest.filter((n) => n.kind === k).map((n) => <NeedRow key={n.id} n={n} canOpen={user.role !== "viewer"} />)}
                  </WorkableGroup>
                );
              })}
            </WorkableTable>
          )}
        </Section>
        <ProjectMergeQueue repo={repo} />

        <Section title="Pipeline">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-4 lg:grid-cols-8">
            {SHOWN.map((p) => (
              <Link key={p} to={scoped(`/items?phase=${encodeURIComponent(p)}`)} className="flex min-h-[60px] flex-col justify-center bg-panel px-3 py-2 hover:bg-ink/[0.04]">
                <span className="num text-xl font-semibold leading-6">{num(phases[p])}</span>
                <span className={cn("text-xs", p === "Waiting for a person" ? "text-warn" : "text-ink/60")}>{PHASE_LABEL[p] ?? p}</span>
              </Link>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink/55">Running: {data.running}</p>
        </Section>

        <div className="grid gap-7 md:grid-cols-2">
          <Section title="Progress" to="/progress" linkLabel="Report">
            <dl className="grid grid-cols-3 gap-3 border-t border-line pt-3">
              <Stat label="Open now" value={num(progress.openNow)} sub={`${num(progress.openAtStart)} at start`} />
              <Stat label="Done in 24 h" value={num(progress.done24h)} sub={`${progress.byAutoCraftPct}% by AutoCraft`} />
              <Stat label="Spend today" value={`$${progress.spendTodayUsd.toFixed(2)}`} />
            </dl>
            <div className="mt-4 flex h-12 items-end gap-[3px]" role="img" aria-label="Items done per hour, last 24 hours">
              {progress.perHour.map((v, i) => (
                <span key={i} className="flex-1 rounded-t-[2px] bg-c1" style={{ height: `${Math.max(6, (v / max) * 100)}%` }} />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-2xs text-ink/45"><span>24 h ago</span><span>now</span></div>
          </Section>
          <Section title="Done today" to={scoped("/activity")} linkLabel="All activity">
            {done.length === 0 && <p className="border-t border-line py-3 text-sm text-ink/55">Nothing done today.</p>}
            <ul>
              {done.map((d) => {
                const Ico = DONE_ICON[d.what];
                return (
                  <li key={`${d.repo}${d.number}${d.what}${d.at}`} className="relative flex items-start gap-2.5 border-t border-line py-2 text-sm hover:bg-ink/[0.025] max-md:py-3">
                    <TimeAgo iso={d.at} className="num w-14 shrink-0 pt-px text-xs text-ink/50" />
                    <Ico className="mt-[3px] shrink-0 text-accent-ink" />
                    <span className="min-w-0 flex-1 text-ink/70">
                      {DONE_LABEL[d.what]}{" "}
                      <Link to={itemPath(d.repo, d.number)} className="after:absolute after:inset-0 hover:underline"><span className="code text-ink/60">{d.repo}#{d.number}</span> <span className="text-ink">{d.title}</span></Link>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-xs text-ink/55">{label}</dt>
      <dd className="num text-xl font-semibold leading-7">{value}</dd>
      {sub && <dd className="text-xs text-ink/50">{sub}</dd>}
    </div>
  );
}

/** The project page's title row: which project, the way back to the overview, and the pages it filters. */
function ProjectHeader({ repo }: { repo: string | undefined }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-ink/60 hover:text-ink max-md:h-11">
        <ArrowLeftIcon size={14} /> Projects
      </Link>
      <PageTitle title={repo ?? "All projects"} />
    </div>
  );
}
