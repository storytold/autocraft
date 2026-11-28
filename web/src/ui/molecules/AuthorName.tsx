// An author's name as a link to their page, with a hover card of their item counts. The card opens on hover and on keyboard focus,
// closes on Escape and when the pointer or focus leaves, and never takes focus; on touch screens a tap follows the link. The counts
// are read when a card first opens (api.authorStats) and shared by every name of that author.
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { HoverCard } from "radix-ui";
import { UsersThreeIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { useQuery } from "../../api/client";
import type { AuthorStats } from "../../api/types";
import { num } from "../../lib/format";
import { authorPath } from "../../lib/links";
import { Avatar } from "../atoms/Avatar";
import { cn } from "../cn";

/** GitHub logins, with an app's `[bot]` suffix; other names are shown as plain text. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/** The counts of an author's pull requests and issues, as their page and the hover card show them. */
export function authorCountLines(s: AuthorStats): { label: string; text: string }[] {
  return [
    { label: t("Pull requests"), text: [t("{n} opened", { n: num(s.prs.opened) }), t("{n} merged", { n: num(s.prs.merged) }), t("{n} rejected", { n: num(s.prs.rejected) }), t("{n} open", { n: num(s.prs.open) })].join(" · ") },
    { label: t("Issues"), text: [t("{n} opened", { n: num(s.issues.opened) }), t("{n} open", { n: num(s.issues.open) }), t("{n} closed", { n: num(s.issues.closed) })].join(" · ") },
  ];
}

/** The author's counts; `project: null` keeps one cache entry per author on every page. */
export const useAuthorStats = (login: string, enabled = true) => useQuery(`author-stats:${login.toLowerCase()}`, (a) => a.authorStats(login), { project: null, enabled });

function CardBody({ login }: { login: string }) {
  const { data, error } = useAuthorStats(login);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Avatar login={login} size={18} />
        <span className="font-semibold text-ink">{data?.login ?? login}</span>
        {data?.team && (
          <span role="img" aria-label={t("On the team")} title={t("On the team")} className="inline-flex text-accent-ink">
            <UsersThreeIcon weight="bold" />
          </span>
        )}
      </div>
      {data ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          {authorCountLines(data).map((l) => (
            <div key={l.label} className="contents">
              <dt className="text-ink/60">{l.label}</dt>
              <dd className="num">{l.text}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <span className="text-ink/60">{error ? t("Could not read the counts.") : t("Reading…")}</span>
      )}
      <Link to={authorPath(login)} className="text-accent-ink hover:underline">
        {t("All items by {login}", { login: data?.login ?? login })}
      </Link>
    </div>
  );
}

/** `login` as a link to the author's page with their hover card; `children` replaces the shown text (such as `@login`). */
export function AuthorName({ login, children, className }: { login: string; children?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!LOGIN.test(login)) return <span className={className}>{children ?? login}</span>;
  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={300} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <Link to={authorPath(login)} aria-describedby={open ? id : undefined} className={cn("relative z-10 rounded-sm hover:underline", className)}>
          {children ?? login}
        </Link>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          id={id}
          role="tooltip"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-max max-w-[min(340px,calc(100vw-16px))] rounded-md border border-line-strong bg-raised px-3 py-2 text-xs leading-snug text-ink shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
        >
          <CardBody login={login} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
