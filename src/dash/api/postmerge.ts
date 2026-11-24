// The post-merge review of a merged PR as the item page shows it.
import type { ItemPostmerge, PostmergeEarlier, PostmergeFiling, PostmergeFinding } from "../../../web/src/api/types.ts";
import { followupsOf, heldReason, reviewOf, type Followup } from "../../postmerge/select.ts";
import { itemState } from "./decisions.ts";
import { mapSeq } from "../../async-seq.ts";
import type { Db } from "../../db/index.ts";

/** `staff`: operators and maintainers, who also read which stage missed a finding and why. */
export async function postmergeOf(db: Db, repo: string, n: number, staff: boolean): Promise<ItemPostmerge | null> {
  const r = await reviewOf(db, repo, n);
  if (!r) return null;
  const all = await followupsOf(db, repo, n);
  const follow = all.filter((f) => f.review_at === r.at);
  const filedIssue = async (row: Followup) => {
    const it = await db.get(db.k.selectFrom("items").select(["state", "title"]).where("repo", "=", repo).where("number", "=", row.issue_number!));
    return { number: row.issue_number!, url: row.url, state: it ? itemState(it.state) : null, title: it?.title ?? row.title };
  };
  const held = await heldReason(db, repo, n, r.at);
  const findings = await mapSeq(r.findings, async (f, i): Promise<PostmergeFinding> => {
    const row = follow.find((x) => x.finding === i);
    let filing: PostmergeFiling;
    if (row?.state === "filed" && row.issue_number !== null) filing = { state: "filed", issue: await filedIssue(row) };
    else if (row?.state === "filing") filing = { state: "unknown" };
    else if (f.severity === "minor") filing = { state: "minor" };
    else if (row?.state === "skipped-duplicate" || f.duplicate_of !== null) filing = { state: "duplicate", duplicateOf: row?.duplicate_of ?? f.duplicate_of! };
    else if (row?.state === "skipped-stale") filing = { state: "stale" };
    else if (row?.state === "skipped-text") filing = { state: "refused" };
    else if (row?.state === "failed") filing = { state: "failed", attempts: row.attempts };
    else if (f.citationUnverified) filing = { state: "unverified-citation" };
    else if (held) filing = { state: "held", reason: held };
    else filing = row?.state === "skipped-limit" ? { state: "limit" } : { state: "pending" };
    return {
      severity: f.severity, title: f.title, body: f.body, file: f.file, line: f.line, filing,
      ...(staff ? { missedBy: f.missed_by || null, missedWhy: f.missed_why || null } : {}),
    };
  });
  // Follow-ups of earlier reviews of the PR (`--again` replaces the review): a filed issue never shows as not filed.
  const earlier = await mapSeq(all.filter((f) => f.review_at !== r.at && (f.state === "filed" || f.state === "filing")), async (f): Promise<PostmergeEarlier> =>
    f.state === "filed" && f.issue_number !== null ? { state: "filed", title: f.title, issue: await filedIssue(f) } : { state: "unknown", title: f.title });
  return { at: r.at, model: r.model, mergeSha: r.merge_sha, error: r.error ? r.error.replace(/^(retry|held):\s*/, "") : null, findings, earlier };
}
