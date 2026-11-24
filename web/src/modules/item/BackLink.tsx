import { Link, useLocation } from "react-router-dom";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { readFrom } from "../../lib/links";

/** The item page's way back: the Needs you queue it was opened from, with its filters and selection, or Items. */
export function BackLink({ className }: { className: string }) {
  const from = readFrom(useLocation().state);
  return <Link to={from?.url ?? "/items"} className={className}><ArrowLeftIcon aria-hidden /> {from ? t("Needs you") : t("Items")}</Link>;
}
