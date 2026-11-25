// The new item page (ui_v2): a header, then "In AutoCraft" beside "On GitHub" (a segmented control on phones). The AutoCraft side
// holds the status (steps, numbered parts, the recommendation), the command box and the controls, then signals, security,
// implementation and screenshots, the conversation with the model and the history. Items of a repo still on the decision
// pipeline get the classic page: commands are refused there and their questions are answered through its forms.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowSquareOutIcon, CheckCircleIcon, CircleNotchIcon, ClockIcon, XCircleIcon } from "@phosphor-icons/react";
import { t, tk } from "../../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../../api/client";
import type { ItemPageData, MaintainItem, MaintainItemStatus, MaintainReply, MaintainStep } from "../../../api/types";
import type { ViewProps } from "../../../registry/types";
import { useIsPhone } from "../../../shell/useMedia";
import { useUser } from "../../../shell/UserContext";
import { canComment } from "../../../registry/permissions";
import { Badge } from "../../../ui/atoms/Badge";
import { Button } from "../../../ui/atoms/Button";
import { ErrorLine } from "../../../ui/atoms/ErrorLine";
import { ItemIcon } from "../../../ui/atoms/ItemIcon";
import { Pending } from "../../../ui/atoms/Pending";
import { TimeAgo } from "../../../ui/atoms/TimeAgo";
import { cn } from "../../../ui/cn";
import { DisclosurePanel } from "../../../ui/molecules/DisclosurePanel";
import { ItemRef } from "../../../ui/molecules/ItemRef";
import { Markdown } from "../../../ui/molecules/Markdown";
import { Segmented } from "../../../ui/molecules/Segmented";
import { safeHref } from "../../../ui/safeHref";
import { Composer } from "../../item/Composer";
import { BackLink } from "../../item/BackLink";
import { GithubSide } from "../../item/page/GithubSide";
import { ImplementationPanel } from "../../item/page/ImplementationPanel";
import { ItemPageView } from "../../item/page/ItemPage";
import { ScreenshotCard } from "../../item/page/ScreenshotCard";
import { CommandBox } from "./CommandBox";
import { History } from "./History";

type Side = "autocraft" | "github";

/** The classic page read: header facts, the GitHub side, screenshots and the implementation. A matching `since` costs one small reply. */
function usePage(repo: string, number: number) {
  const key = `item-page:v2:${repo}#${number}`;
  const last = useRef<{ key: string; page: ItemPageData } | null>(null);
  return useQuery<ItemPageData>(key, async (a) => {
    const prev = last.current?.key === key ? last.current.page : null;
    const r = await a.itemPage(repo, number, prev?.stamp);
    if ("unchanged" in r && prev) return prev;
    if ("unchanged" in r) throw new Error("unexpected empty answer");
    last.current = { key, page: r };
    return r;
  });
}

export function ItemView(props: ViewProps) {
  const repo = props.params.repo!;
  const number = Number(props.params.number);
  const { data: m, error } = useQuery(`maintain-item:${repo}#${number}`, (a) => a.maintainItem.get(repo, number));
  if (!m || m.repo !== repo || m.number !== number) return <Pending error={error} />;
  if (!m.workflowRepo) return <ItemPageView {...props} />;
  return <WorkflowPage m={m} />;
}

function WorkflowPage({ m }: { m: MaintainItem }) {
  const user = useUser();
  const phone = useIsPhone();
  const { data: d, error } = usePage(m.repo, m.number);
  const [side, setSide] = useState<Side>(user.role === "viewer" ? "github" : "autocraft");
  useEffect(() => setSide(user.role === "viewer" ? "github" : "autocraft"), [m.repo, m.number, user.role]);
  if (!d || d.repo !== m.repo || d.number !== m.number) return <Pending error={error} />;
  const auto = <AutoCraftSide m={m} d={d} />;
  const gh = <GithubSide d={d} flash={null} />;
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <article className="w-full pb-12 md:pb-16">
        <Header m={m} d={d} />
        {phone ? (
          <>
            <div className="sticky top-0 z-20 mb-4 border-b border-line bg-panel px-4 py-2">
              <Segmented label={t("Side")} value={side} onChange={setSide} className="[&>button]:h-11 [&>button]:flex-1" options={[{ value: "autocraft", label: "AutoCraft" }, { value: "github", label: "GitHub" }]} />
            </div>
            <section aria-label={side === "autocraft" ? t("In AutoCraft") : t("On GitHub")}>{side === "autocraft" ? auto : gh}</section>
          </>
        ) : (
          <div className="grid min-w-0 grid-cols-1 lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]">
            <section aria-label={t("In AutoCraft")} className="min-w-0">
              {auto}
            </section>
            <section aria-label={t("On GitHub")} className="mt-5 min-w-0 border-t border-line bg-bg/40 lg:mt-0 lg:border-l lg:border-t-0">
              {gh}
            </section>
          </div>
        )}
      </article>
    </div>
  );
}

const STATE_TONE = { open: "ok", closed: "neutral", merged: "merged" } as const;
const STATE_LABEL = { open: tk("Open"), closed: tk("Closed"), merged: tk("Merged") } as const;

function Header({ m, d }: { m: MaintainItem; d: ItemPageData }) {
  const weight = m.status?.live ? m.status.weight : null;
  return (
    <header className="px-4 pb-5 pt-4 md:px-8 md:pb-6 md:pt-6">
      <div className="flex items-center gap-2">
        <BackLink className="inline-flex h-7 items-center gap-1 rounded text-xs text-ink/70 hover:text-ink max-md:h-11" />
      </div>
      <div className="mt-1 flex flex-wrap items-start gap-3">
        <div className="min-w-0 basis-full md:basis-0 md:flex-1">
          <h1 className="break-words text-xl font-semibold leading-7 md:text-2xl md:leading-8">
            <ItemIcon kind={d.kind} state={d.state} className="mr-2 inline-block align-[-2px]" />
            <span className="code mr-2 text-base font-normal text-ink/60 [overflow-wrap:anywhere] md:text-lg">
              {d.repo}#{d.number}
            </span>
            {d.title}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/70">
            <Badge tone={STATE_TONE[d.state]}>{t(STATE_LABEL[d.state])}</Badge>
            <span>{t("by {login}", { login: d.author })}</span>
            {weight && <Badge tone={weight === "urgent" ? "bad" : weight === "low" ? "neutral" : "warn"}>{weight}</Badge>}
            {m.duplicates.length > 0 && <Badge tone="warn">{m.duplicates.length === 1 ? t("1 duplicate") : t("{n} duplicates", { n: m.duplicates.length })}</Badge>}
            {m.outside && <Badge tone="warn">{t("Held: outside author")}</Badge>}
          </div>
        </div>
        <a href={safeHref(d.github.url)} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-line-strong bg-raised px-2.5 text-xs font-medium hover:bg-ink/[0.06] max-md:h-11">
          {t("See in GitHub")} <ArrowSquareOutIcon aria-hidden />
        </a>
      </div>
    </header>
  );
}

const STEP_LOOK: Record<MaintainStep["state"], [typeof CheckCircleIcon | null, string]> = {
  done: [CheckCircleIcon, "text-ok"],
  running: [CircleNotchIcon, "text-accent-ink"],
  waiting: [ClockIcon, "text-warn"],
  stopped: [XCircleIcon, "text-bad"],
  next: [null, "text-ink/70"],
};
const STEP_WORD: Record<MaintainStep["state"], string> = { done: tk("done"), running: tk("running"), waiting: tk("waiting"), stopped: tk("stopped"), next: tk("next") };

function Steps({ steps }: { steps: MaintainStep[] }) {
  return (
    <ol aria-label={t("Steps")} className="flex flex-col gap-1">
      {steps.map((s, i) => {
        const [Icon, tone] = STEP_LOOK[s.state];
        const now = s.state === "running" || s.state === "waiting" || s.state === "stopped";
        return (
          <li key={i} className={cn("flex items-start gap-2 text-sm", s.state === "done" && "text-ink/70", now && "font-semibold")}>
            <span className="code w-4 shrink-0 pt-px text-right text-ink/70">{i + 1}</span>
            <span className="min-w-0 flex-1">{s.label}</span>
            <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", tone)}>
              {Icon && <Icon aria-hidden className={s.state === "running" ? "animate-spin" : undefined} />}
              {t(STEP_WORD[s.state])}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Parts({ s }: { s: MaintainItemStatus }) {
  return (
    <section aria-label={t("Parts")} className="flex flex-col gap-1">
      <h2 className="text-xs font-semibold text-ink/70">{t("Parts")}</h2>
      <ol className="flex flex-col gap-1.5 text-sm">
        {s.parts.map((p) => (
          <li key={p.n} className="flex gap-2">
            <span className="code w-4 shrink-0 text-right font-semibold">{p.n}</span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span className={cn(p.state === "dropped" && "text-ink/70 line-through")}>{p.title || t("Part {n}", { n: p.n })}</span>
              {p.major && <Badge tone="bad" className="ml-1.5">{t("major")}</Badge>}
              {p.state !== "planned" && <span className="text-ink/70"> · {p.state === "fixed" ? t("fixed") : t("dropped")}</span>}
              {p.file && <span className="code block text-xs text-ink/70">{p.file}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Example commands, by what the item waits for. */
function examples(m: MaintainItem): string {
  const s = m.status;
  if (s?.live && (s.rec || s.unclear)) return t("yes · fix 1 and merge · drop 2 · stop");
  if (s?.live) return s.approved ? t("urgent · stop") : t("merge · urgent · stop");
  return m.kind === "issue" ? t("implement · implement and merge · backlog · close") : t("review · fix-up and merge · merge, urgent · backlog");
}

function StatusCard({ m, d }: { m: MaintainItem; d: ItemPageData }) {
  const s = m.status;
  const open = d.state === "open";
  const headline = s ? s.headline : open ? t("Not started") : d.state === "merged" ? t("Merged") : t("Closed");
  return (
    <section aria-label={t("Status")} className="flex flex-col gap-3 rounded-lg border border-line-strong bg-raised p-4">
      <div className="flex flex-col gap-0.5">
        <p className="text-md font-semibold">{headline}</p>
        {s?.lines.map((l) => (
          <p key={l} className="text-sm text-ink/80">
            {l}
          </p>
        ))}
        {s && s.live && !s.approved && <p className="text-sm text-ink/80">{t("Not approved for merge")}</p>}
      </div>
      {s?.blocker && (
        <p className="rounded border border-bad/50 bg-bad/10 px-3 py-2 text-sm">
          <span className="font-semibold">{t("Blocker:")}</span> {s.blocker}
        </p>
      )}
      {s?.steps && <Steps steps={s.steps} />}
      {s && s.parts.length > 0 && <Parts s={s} />}
      {s?.unclear && (
        <div className="flex flex-col gap-1 border-l-2 border-accent/60 pl-3 text-sm">
          <p>
            <span className="font-semibold">{s.unclear.by}</span> <TimeAgo iso={s.unclear.at} className="num text-xs text-ink/70" />
          </p>
          <p>
            <span className="font-semibold">AutoCraft</span> {s.unclear.line}
          </p>
        </div>
      )}
      {s?.rec && <p className="rounded border border-accent/60 bg-accent/10 px-3 py-2 text-lg font-semibold leading-snug">{s.rec}</p>}
      {s?.confirm && s.live && !s.rec && !s.unclear && <p className="text-sm text-ink/80">{s.confirm}</p>}
      {m.canAct && open && <CommandBox repo={m.repo} number={m.number} placeholder={examples(m)} />}
      <Controls m={m} />
    </section>
  );
}

/** Release from an outside-author hold and resume a breaker: registered controls, shown to those who may use them. */
function Controls({ m }: { m: MaintainItem }) {
  const api = useApi();
  const [reply, setReply] = useState<MaintainReply | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, body: Parameters<typeof api.maintainItem.control>[0]) => {
    setBusy(id);
    try {
      setReply(await api.maintainItem.control(body));
    } catch (e) {
      setReply({ ok: false, lines: [e instanceof Error ? e.message : String(e)] });
    } finally {
      setBusy(null);
    }
  };
  if (!m.outside && !m.breakers.length && !reply) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      {m.outside && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1">
            {m.outside.reason === "surge"
              ? t("Held: {author} is outside the team and opened this during a surge.", { author: m.outside.author })
              : t("Held: {author} is outside the team and over the daily limit.", { author: m.outside.author })}
          </span>
          {m.outside.canRelease && (
            <Button size="lg" loading={busy === "outside"} onClick={() => void run("outside", { control: "release-outside", repo: m.repo, number: m.number })}>
              {t("Release")}
            </Button>
          )}
        </div>
      )}
      {m.breakers.map((b) => (
        <div key={b.key} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1">
            {b.reason ? t("Paused by the {key} breaker: {reason}", { key: b.key, reason: b.reason }) : t("Paused by the {key} breaker", { key: b.key })}
          </span>
          {b.canResume && (
            <Button size="lg" loading={busy === b.key} onClick={() => void run(b.key, { control: "resume-breaker", key: b.key })}>
              {t("Resume")}
            </Button>
          )}
        </div>
      ))}
      <div aria-live="polite">
        {reply?.lines.map((l) => (
          <p key={l} className={cn("text-sm", reply.ok ? "text-ink/80" : "text-bad")}>
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

function Signals({ m }: { m: MaintainItem }) {
  if (!m.duplicates.length && !m.withdrawn.length) return null;
  const summary = [
    m.duplicates.length ? (m.duplicates.length === 1 ? t("1 duplicate") : t("{n} duplicates", { n: m.duplicates.length })) : null,
    m.withdrawn.length ? (m.withdrawn.length === 1 ? t("1 withdrawn question") : t("{n} withdrawn questions", { n: m.withdrawn.length })) : null,
  ].filter(Boolean).join(" · ");
  return (
    <DisclosurePanel title={t("Signals")} summary={summary} defaultOpen>
      <div className="flex flex-col gap-4 px-4 pb-4">
        {m.duplicates.length > 0 && (
          <section aria-label={t("Duplicates")} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-ink/70">{t("Duplicates")}</h3>
            <ul className="flex flex-col gap-2">
              {m.duplicates.map((x) => (
                <li key={x.number} className="relative flex flex-col gap-0.5 text-sm">
                  <ItemRef repo={x.repo} number={x.number} kind={x.kind} state={x.state} title={x.title} stretch />
                  {x.canonical && <span className="pl-6 text-xs text-ink/70">{t("kept as the main item")}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {m.withdrawn.length > 0 && (
          <section aria-label={t("Withdrawn questions")} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-ink/70">{t("Withdrawn when the repo moved to commands")}</h3>
            <ul className="flex flex-col gap-2 text-sm">
              {m.withdrawn.map((w) => (
                <li key={w.id} className="flex flex-col gap-0.5">
                  <Link to={`/needs/decisions/${encodeURIComponent(w.id)}`} className="font-medium text-accent-ink hover:underline">
                    {w.question}
                  </Link>
                  {w.summary && <span className="text-ink/80">{w.summary}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </DisclosurePanel>
  );
}

const SEVERITY_TONE = { critical: "bad", high: "bad", medium: "warn", low: "neutral" } as const;

function Security({ m }: { m: MaintainItem }) {
  if (!m.security.length) return null;
  return (
    <DisclosurePanel title={t("Security")} summary={String(m.security.length)}>
      <ul className="flex flex-col gap-2 px-4 pb-4 text-sm">
        {m.security.map((f) => (
          <li key={f.number} className="flex flex-wrap items-baseline gap-x-1.5">
            <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
            <Link to={`/security/${encodeURIComponent(m.repo)}/${f.number}`} className="text-accent-ink hover:underline">
              {f.title}
            </Link>
            <span className="text-ink/70">· {f.state}</span>
          </li>
        ))}
      </ul>
    </DisclosurePanel>
  );
}

function Conversation({ m }: { m: MaintainItem }) {
  const user = useUser();
  const { data: conv, error } = useQuery(`conversation:${m.repo}#${m.number}`, (a) => a.conversations.get(m.repo, m.number), { pollMs: (x) => (x?.pending ? 4000 : false) });
  if (!conv) return error ? <ErrorLine error={error.message} /> : null;
  if (!conv.exists && !conv.canTalk) return null;
  const turns = conv.turns.filter((x) => x.kind !== "system");
  return (
    <DisclosurePanel title={t("Conversation with the model")} summary={conv.pending ? t("The model is replying") : turns.length === 1 ? t("1 message") : t("{n} messages", { n: turns.length })}>
      <div className="flex flex-col gap-3 px-4 pb-4">
        {turns.map((x) => (
          <div key={x.id} className={cn("rounded-md border px-3 py-2", x.kind === "opus" ? "border-accent/40 bg-accent/[0.04]" : "border-line bg-panel")}>
            <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-ink/70">
              <span className={cn("font-medium", x.kind === "opus" ? "text-accent-ink" : "text-ink")}>{x.kind === "opus" ? t("Model") : x.login}</span>
              <TimeAgo iso={x.at} className="num" />
              {x.status === "failed" && <span className="text-bad">{t("no reply")}</span>}
            </div>
            <Markdown source={x.body} />
          </div>
        ))}
        {conv.progress && conv.pending && <p className="text-sm text-ink/70" role="status">{conv.progress[conv.progress.length - 1]}</p>}
        <Composer flush repo={m.repo} number={m.number} talk={conv.canTalk} withdrawable={conv.canWithdraw} operator={user.role === "operator"} commenter={canComment(user)} exists={conv.exists} pending={conv.pending} />
      </div>
    </DisclosurePanel>
  );
}

function Fold({ title, summary, children }: { title: string; summary?: string; children: ReactNode }) {
  return (
    <DisclosurePanel title={title} summary={summary}>
      <div className="divide-y divide-line">{children}</div>
    </DisclosurePanel>
  );
}

function AutoCraftSide({ m, d }: { m: MaintainItem; d: ItemPageData }) {
  return (
    <div className="flex flex-col gap-4 px-4 pb-6 pt-1 md:px-8">
      <StatusCard m={m} d={d} />
      <Signals m={m} />
      <Security m={m} />
      {d.implementation && <ImplementationPanel m={d.implementation} />}
      {d.screenshots.length > 0 && (
        <Fold title={t("Screenshots")} summary={String(d.screenshots.reduce((n, r) => n + r.shots.length, 0))}>
          {d.screenshots.map((r) => (
            <ScreenshotCard key={r.head} run={r} />
          ))}
        </Fold>
      )}
      <Conversation m={m} />
      <DisclosurePanel title={t("History")} defaultOpen>
        <History repo={m.repo} number={m.number} kind={m.kind} said={m.events} />
      </DisclosurePanel>
    </div>
  );
}
