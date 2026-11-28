// An author's page, `/authors/<login>`: who they are, the counts of their pull requests and issues in the repos the reader may
// see, and their items in tabs (All, Merged, Rejected, Open). Each tab is an Items query (`author:<login>` and its state terms),
// drawn with the Items rows; on desktop a row opens the item beside the list (`open=<repo>/<n>`), as on the Items page.
// `?tab=` and `?offset=` keep the place.
import { useMemo, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Panel, PanelGroup } from "react-resizable-panels";
import { UsersThreeIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import { useQuery } from "../../../api/client";
import type { AuthorStats } from "../../../api/types";
import { num } from "../../../lib/format";
import { githubProfileUrl } from "../../../lib/links";
import type { ViewProps } from "../../../registry/types";
import { useShortcutHelp } from "../../../shell/keyboard";
import { layoutStorage } from "../../../shell/layoutStorage";
import { useIsPhone } from "../../../shell/useMedia";
import { Avatar } from "../../../ui/atoms/Avatar";
import { GithubButton } from "../../../ui/atoms/GithubButton";
import { Pending } from "../../../ui/atoms/Pending";
import { ResizeHandle } from "../../../ui/atoms/ResizeHandle";
import { authorCountLines, useAuthorStats } from "../../../ui/molecules/AuthorName";
import { Pager } from "../../../ui/molecules/Pager";
import { Tabs } from "../../../ui/molecules/Tabs";
import { ItemPanel } from "./ItemPanel";
import { OPEN_PARAM, parseOpenItem, readableSearch, useOpenItem } from "./openItem";
import { ItemRow, listKey, PANEL_WIDTH, ROW_HINT, ROW_KEYS } from "./views";

const PAGE = 50;
type Tab = "all" | "merged" | "rejected" | "open";
const TABS: Tab[] = ["all", "merged", "rejected", "open"];
/** Each tab's terms beside `author:<login>`. Rejected: pull requests closed without a merge. */
const TAB_TERMS: Record<Tab, string> = { all: "", merged: "is:merged", rejected: "is:pr is:closed", open: "is:open" };
const TAB_LABEL: Record<Tab, string> = { all: "All", merged: "Merged", rejected: "Rejected", open: "Open" };
const tabCount = (s: AuthorStats, tab: Tab): number =>
  tab === "all" ? s.prs.opened + s.issues.opened : tab === "merged" ? s.prs.merged : tab === "rejected" ? s.prs.rejected : s.prs.open + s.issues.open;
const refOf = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;
const ID = "author-items";

export function AuthorView(props: ViewProps) {
  const login = useParams().login ?? "";
  const loc = useLocation();
  const navigate = useNavigate();
  const phone = useIsPhone();
  const params = useMemo(() => new URLSearchParams(loc.search), [loc.search]);
  const tab = (TABS as string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "all";
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const opened = parseOpenItem(params.get(OPEN_PARAM));
  const heading = useRef<HTMLHeadingElement>(null);
  useShortcutHelp(phone ? [] : ROW_KEYS);
  const storage = useMemo(() => layoutStorage(props.user.login), [props.user.login]);
  const savedWidth = Number(storage.getItem(PANEL_WIDTH));
  const panelWidth = savedWidth >= 28 && savedWidth <= 64 ? savedWidth : 42;

  const { data: stats, error: statsError } = useAuthorStats(login);
  const q = `author:${login} ${TAB_TERMS[tab]}`.trim();
  const { data, error } = useQuery(`maintain-browse:author:${q}:${offset}`, (a) => a.maintain.browse({ q, offset, limit: PAGE }));
  const name = stats?.login ?? login;

  const go = (next: { tab?: Tab; offset?: number }) => {
    const p = new URLSearchParams(loc.search);
    const nt = next.tab ?? tab;
    if (nt === "all") p.delete("tab");
    else p.set("tab", nt);
    if (next.offset) p.set("offset", String(next.offset));
    else p.delete("offset");
    const s = readableSearch(p);
    navigate({ pathname: loc.pathname, search: s ? `?${s}` : "" });
  };
  const openItem = useOpenItem();
  const openRow = phone ? null : (ref: string, keyboard = true) => openItem(ref.slice(0, ref.lastIndexOf("#")), Number(ref.slice(ref.lastIndexOf("#") + 1)), { keyboard });

  const list = (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="mx-auto flex max-w-[880px] flex-col gap-3 px-4 pb-6 pt-5 md:px-6">
        <header className="flex items-center gap-3">
          <Avatar login={name} size={40} />
          <h1 ref={heading} tabIndex={-1} className="flex min-w-0 flex-1 items-center gap-2 text-xl font-semibold outline-none">
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{name}</span>
            {stats?.team && (
              <span role="img" aria-label={t("On the team")} title={t("On the team")} className="inline-flex shrink-0 text-base text-accent-ink">
                <UsersThreeIcon weight="bold" />
              </span>
            )}
          </h1>
          <GithubButton href={githubProfileUrl(name)} label={t("Open {login} on GitHub", { login: name })} className="my-0" />
        </header>

        {stats ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {authorCountLines(stats).map((l) => (
              <div key={l.label} className="contents">
                <dt className="text-ink/60">{l.label}</dt>
                <dd className="num min-w-0">{l.text}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <Pending error={statsError} />
        )}

        <Tabs
          value={tab}
          idBase={ID}
          label={t("Items by {login}", { login: name })}
          options={TABS.map((v) => ({ value: v, label: t(TAB_LABEL[v]), ...(stats && { count: tabCount(stats, v) }) }))}
          onChange={(v) => go({ tab: v })}
        />

        <div id={`${ID}-panel-${tab}`} role="tabpanel" aria-labelledby={`${ID}-tab-${tab}`}>
          {!data ? (
            <Pending error={error} />
          ) : data.rows.length === 0 ? (
            <div className="rounded-lg border border-line px-4 py-6 text-md">{t("No items match.")}</div>
          ) : (
            <div className="rounded-lg border border-line bg-panel">
              {openRow && (
                <span id={ROW_HINT} hidden>
                  {t("Enter opens it beside the list")}
                </span>
              )}
              <ul className="divide-y divide-line" aria-label={t(TAB_LABEL[tab])} onKeyDown={(e) => listKey(e, openRow)}>
                {data.rows.map((r) => (
                  <ItemRow
                    key={refOf(r)}
                    r={r}
                    opened={!phone && !!opened && opened.repo === r.repo && opened.number === r.number}
                    byCreated={false}
                    picking={false}
                    picked={false}
                    may={false}
                    onPick={() => {}}
                    onOpen={openRow && ((keyboard) => openRow(refOf(r), keyboard))}
                    phone={phone}
                  />
                ))}
              </ul>
              <Pager offset={data.offset} limit={data.limit} total={data.total} onOffset={(o) => go({ offset: o })} />
            </div>
          )}
          {data && data.total > 0 && <p className="sr-only" aria-live="polite">{data.total === 1 ? t("1 item") : t("{n} items", { n: num(data.total) })}</p>}
        </div>
      </div>
    </div>
  );
  if (phone) return list;
  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel id="list" order={0} minSize={36} className="min-w-0">
        {list}
      </Panel>
      {opened && (
        <>
          <ResizeHandle label={t("Resize item panel")} />
          <Panel id="item" order={1} defaultSize={panelWidth} minSize={28} maxSize={64} onResize={(size) => storage.setItem(PANEL_WIDTH, String(Math.round(size * 10) / 10))} className="min-w-0 border-l border-line">
            <ItemPanel {...props} />
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
