// Recently merged: the pull requests AutoCraft merged lately (its merge step or a merged batch) in the project or in every repo, newest first.
import { useQuery } from "../../api/client";
import type { MaintainItemRow } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { WorkableRow, WorkableTable, type WorkableColumn } from "../../ui/organisms/Workable";
import { num } from "../../lib/format";
import { ErrorLine } from "../admin/parts";
import { AuthorName } from "../../ui/molecules/AuthorName";

const LIMIT = 50;

const HOW: Record<NonNullable<MaintainItemRow["merged"]>["how"], [string, string]> = {
  rule: ["By rule", "Covered by the merge rule"],
  approval: ["On approval", "A person approved the merge"],
  batch: ["In a batch", "Landed with an integration batch"],
};

const COLUMNS: WorkableColumn[] = [
  { id: "how", label: "How", width: "120px", hint: "How AutoCraft merged it" },
  { id: "author", label: "Author", width: "140px" },
  { id: "merged", label: "Merged", width: "116px" },
];

export function RecentlyMerged({ repo }: { repo: string | null }) {
  const { data, error } = useQuery(`maintain-items:merged:${repo ?? ""}`, (a) => a.maintain.items({ show: "merged", limit: LIMIT }), { project: repo });
  const total = data?.counts.done ?? 0;
  return (
    <>
      <ErrorLine error={error?.message} className="mt-3" />
      {data && (
        <p className="mt-4 text-sm text-ink/60">
          {total === 0 ? "AutoCraft has not merged a PR here yet." : <>The PRs AutoCraft merged, newest first{total > data.rows.length ? `: the last ${num(data.rows.length)} of ${num(total)}` : ""}.</>}
        </p>
      )}
      {data && data.rows.length > 0 && (
        <WorkableTable columns={COLUMNS} label="Recently merged" className="mt-4">
          {data.rows.map((r) => {
            const how = r.merged && HOW[r.merged.how];
            return (
              <WorkableRow
                key={`${r.repo}#${r.number}`}
                item={{ repo: r.repo, number: r.number, kind: r.kind, state: r.state, title: r.title }}
                cells={{
                  how: how && (
                    <span title={how[1]}>
                      <Badge tone="merged">{how[0]}</Badge>
                    </span>
                  ),
                  author: <span className="block truncate text-xs text-ink/70">{r.author ? <AuthorName login={r.author} /> : "unknown"}</span>,
                  merged: r.merged && <TimeAgo iso={r.merged.at} className="num text-xs text-ink/50" />,
                }}
              />
            );
          })}
        </WorkableTable>
      )}
    </>
  );
}
