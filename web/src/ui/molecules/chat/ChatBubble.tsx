import { ArrowCounterClockwiseIcon, CircleNotchIcon, DiscordLogoIcon, GithubLogoIcon, MonitorIcon, RobotIcon, TerminalWindowIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import type { ChatEntry, ChatVia } from "../../../api/types";
import { Avatar } from "../../atoms/Avatar";
import { AuthorName } from "../AuthorName";
import { MessageTime } from "../../atoms/MessageTime";
import { messageTime } from "../../../lib/format";
import { safeHref } from "../../safeHref";

type Said = Extract<ChatEntry, { t: "said" }>;

const VIA: Record<ChatVia, [string, typeof GithubLogoIcon]> = {
  dashboard: [t("Dashboard"), MonitorIcon],
  github: [t("GitHub comment"), GithubLogoIcon],
  discord: [t("Discord"), DiscordLogoIcon],
  agent: [t("Agent"), RobotIcon],
  cli: [t("Command line"), TerminalWindowIcon],
};

/** Shown where a viewer of a quiet security pull request gets who and when but not the words. */
export const VEILED = () => t("Hidden for viewers");

/** One accessible name per chat entry, starting with what the entry shows first. */
export const clipName = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A person's message to AutoCraft, on the right: who, when and where they wrote it, then the text and, under it, AutoCraft's refusal
 * or answer lines. `answer`: the lines a command just answered with, while the conversation has no entry that carries them.
 * `onWithdraw`: the reader may withdraw it while it waits for Opus.
 */
export function ChatBubble({ e, answer, onWithdraw }: { e: Said; answer?: string[]; onWithdraw?: () => void }) {
  const [where, Icon] = VIA[e.via];
  const label = (
    <span className="inline-flex items-center gap-1">
      <Icon aria-hidden /> {where}
    </span>
  );
  const lines = e.refusal ? e.refusal.split("\n").filter((l) => l.trim()) : (answer ?? []);
  return (
    <li aria-label={t("{login}, {time}, {surface}: {text}", { login: e.login, time: messageTime(e.at), surface: where, text: clipName(e.body || VEILED()) })} className="flex flex-col items-end gap-1.5 pl-10 md:pl-28">
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-xs text-ink/70">
        <Avatar login={e.login} size={18} />
        <AuthorName login={e.login} className="font-semibold text-ink">@{e.login}</AuthorName>
        <MessageTime iso={e.at} />
        {e.url ? (
          <a href={safeHref(e.url)} target="_blank" rel="noopener noreferrer" className="rounded hover:text-ink hover:underline">
            {label}
          </a>
        ) : (
          label
        )}
      </div>
      {e.body ? (
        <div className="max-w-full whitespace-pre-wrap rounded-bubble rounded-tr-md bg-bubble px-4 py-2.5 text-md leading-6 text-ink [overflow-wrap:anywhere]">{e.body}</div>
      ) : (
        <div className="max-w-full rounded-bubble rounded-tr-md bg-bubble px-4 py-2.5 text-sm italic leading-6 text-ink/70">{VEILED()}</div>
      )}
      {e.pending && (
        <p className="inline-flex items-center gap-1.5 text-xs text-ink/70">
          <CircleNotchIcon aria-hidden className="animate-spin" />
          {t("Waiting for the answer")}
          {onWithdraw && (
            <button type="button" onClick={onWithdraw} className="ml-1 inline-flex min-h-11 items-center rounded px-2 font-medium text-accent-ink hover:underline focus-visible:ring-2 focus-visible:ring-accent/60 md:min-h-0">
              {t("Withdraw message")}
            </button>
          )}
        </p>
      )}
      {e.withdrawnBy && (
        <p className="inline-flex items-center gap-1.5 text-xs text-ink/70">
          <ArrowCounterClockwiseIcon aria-hidden />
          {t("Withdrawn by {login}.", { login: e.withdrawnBy })}
        </p>
      )}
      {lines.length > 0 && (
        <div className="flex max-w-full flex-col items-end gap-0.5 text-sm text-bad">
          {lines.map((l, i) => (
            <p key={i} className="inline-flex items-start gap-1.5 text-right [overflow-wrap:anywhere]">
              <WarningCircleIcon aria-hidden weight="bold" className="mt-[3px] shrink-0" />
              {l}
            </p>
          ))}
        </div>
      )}
    </li>
  );
}
