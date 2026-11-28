import type { RemoteVia as Via } from "../../api/types";
import { Avatar } from "../atoms/Avatar";
import { AuthorName } from "./AuthorName";
import { cn } from "../cn";

/** Who ran a model call in the user-local mode: "via @login · runner · harness · reported model"; `compact` (a list column) shows the user and the runner. */
export function RemoteVia({ via, compact, className }: { via: Via; compact?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-x-1 text-xs text-ink/65", compact ? "flex-nowrap" : "flex-wrap", className)}>
      {!compact && <span>via</span>}
      <Avatar login={via.login} size={14} />
      <AuthorName login={via.login} className="font-medium text-ink/80">@{via.login}</AuthorName>
      {via.runner && <span className="min-w-0 truncate">· {via.runner}</span>}
      {!compact && (via.harness || via.model) && <span>· {[via.harness, via.model].filter(Boolean).join(" · ")}</span>}
    </span>
  );
}
