// What AutoCraft is doing about a red default branch, in words for the Main CI page. Read-only.
import { mainFixApprovals } from "./approval.ts";
import type { Db } from "../db/index.ts";
import { loadMainFixStates } from "../data/changes/index.ts";

/** Shown first when a head has rows in several states: what needs a person comes before what is running. */
const ORDER = ["unreadable", "fix-failed", "needs-fix", "linting", "pr-opened", "rerun-requested", "issue-opening", "issue-opened", "issue-failed", "declined", "nothing-to-do", "rerun-passed"] as const;

const TEXT: Record<(typeof ORDER)[number], string> = {
  unreadable: "needs a person: the failure log cannot be read",
  "fix-failed": "needs a person",
  "pr-opened": "opened fix PR",
  "needs-fix": "needs a fix",
  linting: "checking a fix",
  "rerun-requested": "rerunning failed jobs",
  "issue-opening": "opening an issue",
  "issue-opened": "opened an issue",
  "issue-failed": "could not open an issue",
  declined: "nothing to do: infra",
  "nothing-to-do": "nothing to do",
  "rerun-passed": "rerun passed",
};

/** Null when the repo has no approval and nothing was done at this head. */
export async function autocraftText(db: Db, repo: string, headSha: string, state: string): Promise<string | null> {
  return (await autocraftTexts(db, [{ repo, headSha, state }])).get(`${repo}\0${headSha}`) ?? null;
}

/** `autocraftText` of many heads in two reads, by repo and head joined by a NUL. */
export async function autocraftTexts(db: Db, heads: { repo: string; headSha: string; state: string }[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!heads.length) return out;
  const fixes = await loadMainFixStates(db, heads.map((h) => ({ repo: h.repo, headSha: h.headSha })));
  const first = (h: { repo: string; headSha: string }) => { const states = new Set(fixes.get(`${h.repo}@${h.headSha}`)?.states ?? []); return ORDER.find((s) => states.has(s)); };
  const approvals = await mainFixApprovals(db, [...new Set(heads.filter((h) => h.state === "red" && !first(h)).map((h) => h.repo))]);
  for (const h of heads) {
    const k = `${h.repo}\0${h.headSha}`;
    const f = first(h);
    if (f === "pr-opened") {
      const n = fixes.get(`${h.repo}@${h.headSha}`)?.prNumber;
      out.set(k, n ? `${TEXT[f]} #${n}` : TEXT[f]);
    } else if (f === "unreadable") {
      const why = fixes.get(`${h.repo}@${h.headSha}`)?.unreadable;
      out.set(k, why ? `needs a person: ${why}` : TEXT[f]);
    } else if (f) out.set(k, TEXT[f]);
    else out.set(k, h.state === "red" && approvals.get(h.repo) ? "reading the failure" : null);
  }
  return out;
}
