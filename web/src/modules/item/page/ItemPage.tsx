// The current question and one history beside GitHub on desktop, stacked on compact screens.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeftIcon, ArrowSquareOutIcon, ChatsCircleIcon } from "@phosphor-icons/react";
import { useQuery } from "../../../api/client";
import type { ItemPageData, Tier } from "../../../api/types";
import type { ViewProps } from "../../../registry/types";
import { Pending } from "../../../ui/atoms/Pending";
import { Badge, type Tone } from "../../../ui/atoms/Badge";
import { ItemIcon } from "../../../ui/atoms/ItemIcon";
import { QueueBadge } from "../../../ui/molecules/QueueBadge";
import { PageTitle } from "../../../shell/PageHeader";
import { useUser } from "../../../shell/UserContext";
import { AutoCraftSide } from "./AutoCraftSide";
import { GithubSide } from "./GithubSide";
import { revealWhenReady } from "../../../lib/revealElement";
import { ItemMenu } from "./ItemMenu";
import { StatusBar } from "./StatusBar";
import { safeHref } from "../../../ui/safeHref";

type Side = "autocraft" | "github";

/** Cross-links between the sides: a write on the GitHub side opens its run in History, and the other way round. */
interface Jump { to: (side: Side, anchor: string) => void; request: { side: Side; anchor: string } | null }
const JumpContext = createContext<Jump>({ to: () => {}, request: null });
export const useJump = () => useContext(JumpContext);

const STATE_LABEL = { open: "Open", closed: "Closed", merged: "Merged" } as const;
const TIER: Record<Tier, [string, Tone]> = { whitelisted: ["Whitelisted", "ok"], not: ["Not whitelisted", "neutral"], "override-allow": ["Override: allow", "accent"], "override-deny": ["Override: deny", "bad"] };
const STATE_TONE = { open: "ok", closed: "neutral", merged: "merged" } as const;

export function ItemPageView({ params }: ViewProps) {
  const repo = params.repo!;
  const number = Number(params.number);
  const user = useUser();
  // A `since` that still matches returns the last page, so a pushed refresh of an unchanged item costs one small reply.
  const key = `item-page:${repo}#${number}`;
  const last = useRef<{ key: string; page: ItemPageData } | null>(null);
  const { data, error } = useQuery<ItemPageData>(key, async (a) => {
    const prev = last.current?.key === key ? last.current.page : null;
    const r = await a.itemPage(repo, number, prev?.stamp);
    if ("unchanged" in r && prev) return prev;
    if ("unchanged" in r) throw new Error("unexpected empty answer");
    last.current = { key, page: r };
    return r;
  });
  const [flash, setFlash] = useState<string | null>(null);
  const [request, setRequest] = useState<Jump["request"]>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelReveal = useRef<(() => void) | null>(null);
  const to = useCallback((side: Side, target: string) => {
    timers.current.forEach(clearTimeout);
    cancelReveal.current?.();
    setRequest({ side, anchor: target });
    setFlash(target);
    cancelReveal.current = revealWhenReady(() => document.getElementById(target), { block: target.startsWith("decision-") ? "start" : "center" });
    timers.current = [setTimeout(() => setFlash(null), 2200)];
  }, []);
  useEffect(() => {
    setFlash(null);
    setRequest(null);
    return () => { timers.current.forEach(clearTimeout); cancelReveal.current?.(); };
  }, [repo, number, user.login, user.role]);
  // Old decision and activity links reveal their supporting panel once the target exists.
  const { hash, key: navigationKey } = useLocation();
  let anchor: string | null = null;
  if (/^#(?:decision-|hist-|gh-)/.test(hash)) {
    try { anchor = decodeURIComponent(hash.slice(1)); } catch { /* An invalid fragment is not a page error. */ }
  }
  const dataMatches = data?.repo === repo && data?.number === number;
  useEffect(() => {
    if (!anchor || !dataMatches) return;
    cancelReveal.current?.();
    setFlash(anchor);
    setRequest({ side: anchor.startsWith("gh-") ? "github" : "autocraft", anchor });
    // A full answer form can be taller than the viewport: reveal its question, not its middle.
    const cancel = revealWhenReady(() => document.getElementById(anchor), { block: anchor.startsWith("decision-") ? "start" : "center" });
    cancelReveal.current = cancel;
    return cancel;
  }, [anchor, dataMatches, repo, number, navigationKey, user.login, user.role]);
  // Query placeholders must never expose the previous item's question or action form at a new route.
  if (!data || data.repo !== repo || data.number !== number) return <Pending error={error} />;
  return (
    <JumpContext.Provider value={{ to, request }}>
      <div className="h-full min-h-0 overflow-y-auto" data-task-page data-flash={flash ?? undefined}>
        <div className="w-full pb-12 md:pb-16">
          <PageTitle title={`${repo}#${number}`} />
          <Header d={data} />
          <div key={`${user.login}:${user.role}:${repo}#${number}`} className="grid min-w-0 grid-cols-1 lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]">
            <section className="min-w-0" aria-label="In AutoCraft">
              <AutoCraftSide d={data} flash={flash} />
            </section>
            <section className="mt-5 min-w-0 border-t border-line bg-bg/40 lg:mt-0 lg:border-l lg:border-t-0" aria-label="On GitHub">
              <GithubSide d={data} flash={flash} />
            </section>
          </div>
        </div>
      </div>
    </JumpContext.Provider>
  );
}

function Header({ d }: { d: ItemPageData }) {
  const user = useUser();
  const h = d.header;
  return (
    <header className="px-4 pb-5 pt-4 md:px-8 md:pb-6 md:pt-6">
      <div className="flex items-center gap-2 text-xs text-ink/60">
        <Link to="/items" className="inline-flex h-7 items-center gap-1 hover:text-ink max-md:h-11"><ArrowLeftIcon /> Items</Link>
      </div>
      <div className="mt-1 flex flex-wrap items-start gap-3">
        <div className="min-w-0 basis-full md:basis-0 md:flex-1">
          <h2 className="break-words text-xl font-semibold leading-7 md:text-2xl md:leading-8">
            <ItemIcon kind={d.kind} state={d.state} className="mr-2 inline-block align-[-2px]" />
            <span className="code mr-2 text-base font-normal text-ink/55 [overflow-wrap:anywhere] md:text-lg">{d.repo}#{d.number}</span>
            {d.title}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
            <Badge tone={STATE_TONE[d.state]}>{STATE_LABEL[d.state]}</Badge>
            <span>by {d.author}</span>
            {h.assignees.length > 0 && <span>assigned to {h.assignees.join(", ")}</span>}
            <QueueBadge slot={h.queue} />
            {h.size && <Badge>{h.size}</Badge>}
            {h.tier !== "not" && <Badge tone={TIER[h.tier][1]}>{TIER[h.tier][0]}</Badge>}
            {h.autocraftAssigned && <Badge tone="accent">Assigned to AutoCraft</Badge>}
            {!h.pipelineOn && <Badge>Pipeline off</Badge>}
            {h.discord && h.discord.count > 0 && (
              <Badge icon={<ChatsCircleIcon className="text-[12px]" />}>
                {h.discord.links[0] ? <a href={safeHref(h.discord.links[0].url)} target="_blank" rel="noopener noreferrer" className="hover:underline">Discord {h.discord.count}</a> : <>Discord {h.discord.count}</>}
              </Badge>
            )}
            {h.discord && !!h.discord.signals && (
              <Badge tone="accent" icon={<ChatsCircleIcon className="text-[12px]" />}>
                {h.discord.signalLinks?.[0] ? <a href={safeHref(h.discord.signalLinks[0].url)} target="_blank" rel="noopener noreferrer" className="hover:underline">Asked about on Discord ×{h.discord.signals}</a> : <>Asked about on Discord ×{h.discord.signals}</>}
              </Badge>
            )}
          </div>
          {h.labels.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">{h.labels.map((l) => <Badge key={l}>{l}</Badge>)}</div>}
        </div>
        <a href={safeHref(d.github.url)} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-line-strong bg-raised px-2.5 text-xs font-medium hover:bg-ink/[0.06] max-md:h-11">
          See in GitHub <ArrowSquareOutIcon />
        </a>
        {(user.role === "operator" || h.backlog.canSettle) && <ItemMenu d={d} />}
      </div>
      <StatusBar d={d} />
    </header>
  );
}
