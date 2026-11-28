// Whether AutoCraft may address a PR's author in a comment. Pure, so the PR facts (src/core/facts.ts) and the workflow use one rule.
import { t } from "../i18n/index.ts";
import { isBotLogin } from "../review/bots.ts";

/**
 * Why AutoCraft does not ask the PR's author, or null when it may: GitHub names none, the author is a bot or AutoCraft itself, or the PR
 * is quiet (a security fix nothing is posted about). `own`: AutoCraft's own logins, lower case (loadOwnLogins).
 */
export function authorUnaskable(o: { login: string | null | undefined; type?: string | null; quiet: boolean; own: ReadonlySet<string> }): string | null {
  if (o.quiet) return t("nothing is posted about this pull request");
  if (!o.login) return t("GitHub names no author of this pull request");
  if (o.type === "Bot" || isBotLogin(o.login)) return t("its author is a bot");
  if (o.own.has(o.login.toLowerCase())) return t("AutoCraft opened it");
  return null;
}
