// The GitHub side, drawn like GitHub's own sections. AutoCraft's writes carry a brand-blue edge, the identity they were made as, and a link to the run.
import { useState } from "react";
import { CheckCircleIcon, CircleNotchIcon, GitCommitIcon, GitMergeIcon, TagIcon, XCircleIcon, ChatCircleIcon, UploadSimpleIcon, EyeIcon, CircleIcon } from "@phosphor-icons/react";
import type { CiState, GithubEvent, GithubTab, ItemPageData } from "../../api/types";
import { Avatar } from "../atoms/Avatar";
import { AuthorName } from "../molecules/AuthorName";
import { MessageTime } from "../atoms/MessageTime";
import { PrBuildLine } from "../molecules/PrBuildLine";
import { Markdown } from "../molecules/Markdown";
import { cn } from "../cn";
import { Tabs } from "../molecules/Tabs";
import { clock, num } from "../../lib/format";

const TABS: [GithubTab, string][] = [["conversation", "Conversation"], ["commits", "Commits"], ["checks", "Checks"], ["files", "Files"]];
const EVENT_ICON: Record<GithubEvent["type"], typeof TagIcon> = { opened: CircleIcon, comment: ChatCircleIcon, review: EyeIcon, label: TagIcon, push: UploadSimpleIcon, merged: GitMergeIcon, closed: XCircleIcon };

export function GithubSide({ d }: { d: ItemPageData }) {
  const g = d.github;
  const [tab, setTab] = useState<GithubTab>("conversation");
  const isPr = d.kind === "pr";
  const tabs = TABS.filter(([k]) => isPr || k === "conversation");
  const counts: Record<GithubTab, number> = { conversation: g.events.length, commits: g.commits.length, checks: g.checks.length, files: g.files.length };
  return (
    <div className="pb-8">
      {isPr && (
        <Tabs
          idBase="github"
          label="GitHub"
          value={tab}
          onChange={setTab}
          className="px-2 pt-1"
          options={tabs.map(([k, l]) => ({ value: k, label: l, count: k === "conversation" ? undefined : counts[k] }))}
        />
      )}
      <div id={`github-panel-${tab}`} role={isPr ? "tabpanel" : undefined} aria-labelledby={isPr ? `github-tab-${tab}` : undefined} className="px-3 pt-3">
        {g.syncedAt && <p className="num mb-2 text-xs text-ink/70">Updated {clock(g.syncedAt)}</p>}
        {tab === "conversation" && <Conversation d={d} />}
        {tab === "commits" && (
          <ul className="overflow-hidden rounded-md border border-line">
            {g.commits.map((c) => (
              <li key={c.sha} className={cn("flex items-center gap-2.5 border-t border-line px-3 py-2 text-sm first:border-t-0", c.byAutoCraft && "border-l-2 border-l-accent")}>
                <GitCommitIcon className="shrink-0 text-ink/70" />
                <span className="min-w-0 flex-1 break-words">{c.message}<span className="block text-xs text-ink/70">{c.byAutoCraft ? "AutoCraft" : <AuthorName login={c.author} />} · <MessageTime iso={c.at} /></span></span>
                <span className="code text-ink/70">{c.sha}</span>
              </li>
            ))}
          </ul>
        )}
        {tab === "checks" && (
          <ul className="overflow-hidden rounded-md border border-line">
            {g.checks.map((c) => <li key={c.name} className="flex items-center gap-2.5 border-t border-line px-3 py-2 text-sm first:border-t-0"><CiIcon s={c.state} /><span className="flex-1">{c.name}</span><span className="text-xs text-ink/70">{c.state === "passing" ? "Passed" : c.state === "pending" ? "Running" : "Failed"}</span></li>)}
          </ul>
        )}
        {tab === "files" && (
          <ul className="overflow-hidden rounded-md border border-line">
            {g.files.map((f) => <li key={f.path} className="flex items-center gap-3 border-t border-line px-3 py-2 text-sm first:border-t-0"><span className="code min-w-0 flex-1 break-all">{f.path}</span><span className="num text-xs text-ok">+{num(f.additions)}</span><span className="num text-xs text-bad">-{num(f.deletions)}</span></li>)}
          </ul>
        )}
        {tab === "conversation" && isPr && g.checks.length > 0 && (
          <p className="mt-4 text-xs text-ink/70">
            Checks: {g.checks.filter((c) => c.state === "passing").length} passed{g.checks.some((c) => c.state === "pending") && `, ${g.checks.filter((c) => c.state === "pending").length} pending`}{g.checks.some((c) => c.state === "failing") && `, ${g.checks.filter((c) => c.state === "failing").length} failed`}
          </p>
        )}
        {tab === "conversation" && isPr && <PrBuildLine b={d.prBuild} className="mt-2" />}
      </div>
    </div>
  );
}

function CiIcon({ s }: { s: CiState }) {
  return s === "passing" ? <CheckCircleIcon weight="fill" className="text-ok" /> : s === "failing" ? <XCircleIcon weight="fill" className="text-bad" /> : <CircleNotchIcon className="text-warn" />;
}

function Conversation({ d }: { d: ItemPageData }) {
  const g = d.github;
  const [first, ...rest] = g.events;
  return (
    <ol className="space-y-3">
      {first && (
        <li>
          <Box actor={first.actor} at={first.at} verb="opened this">
            <Markdown source={g.description} />
          </Box>
        </li>
      )}
      {rest.map((e) => {
        const Ico = EVENT_ICON[e.type];
        if (e.autocraft)
          return (
            <li key={e.id} className="rounded-md border border-line border-l-[3px] border-l-accent bg-accent/[0.04]">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs">
                <Ico className="text-accent-ink" />
                <span className="font-medium text-accent-ink">AutoCraft</span>
                <span className="text-ink/70">as {e.autocraft.as}</span>
                <MessageTime iso={e.at} className="num text-ink/70" />
              </div>
              {e.body && <div className="px-3 pb-2.5 text-sm"><Markdown source={e.body} /></div>}
            </li>
          );
        if (e.type === "push" || e.type === "label" || e.type === "merged" || e.type === "closed")
          return <li key={e.id} className="flex items-center gap-2 px-1 text-xs text-ink/60"><Ico className="shrink-0" /> <span><AuthorName login={e.actor} className="font-medium text-ink/80" /> {e.body} <MessageTime iso={e.at} className="text-ink/70" /></span></li>;
        return <li key={e.id}><Box actor={e.actor} at={e.at}><Markdown source={e.body ?? ""} /></Box></li>;
      })}
    </ol>
  );
}

function Box({ actor, at, verb, children }: { actor: string; at: string; verb?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line bg-ink/[0.03] px-3 py-2 text-xs">
        <Avatar login={actor} size={18} />
        <AuthorName login={actor} className="font-medium text-ink" />
        <span className="text-ink/70">{verb}</span>
        <MessageTime iso={at} className="num text-ink/70" />
      </div>
      <div className="px-3 py-2.5 text-sm">{children}</div>
    </div>
  );
}
