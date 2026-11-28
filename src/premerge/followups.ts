// The follow-up issue of a PR a maintainer approved for merge: what its reviews found that does not stop the merge, filed so that a
// maintainer finds it in the item queue like any issue. Two sources: the Opus review's fixes and hold that do not block
// (src/core/review-blocking.ts), which are not made, its changes outside the PR's purpose, with its code-incomplete claims that no fix covers (followUpClaims), and the
// pre-merge review's defects that do not block (src/premerge/types.ts followUpDefects). One issue per PR, opened by the first filing; a later head's or source's follow-ups are a comment on it. Runs the
// Plan's `followups` actions (src/core/decide.ts followUpsDue, reviewFollowUpsDue); the PR's merge waits for the try, not for its success.
//
// A head's row (premerge_followups for the pre-merge review's head, review_followups for the reviewed head) is written in state
// `filing` before the write, so a head is filed once. A write GitHub refused is recorded
// `failed` with its reason, and the merge goes on. One that sent nothing (no app token, write pacing, GitHub's rate limit) is
// recorded `unsent` with the times of such tries and tried again after the backoff of src/core/rules.ts unsentAsk (10, then
// 60 minutes); the try after those is `failed`, "not posted on GitHub", and the merge goes on. A head whose follow-ups an
// earlier row filed already (same file and title) is recorded `filed` without a post.
import { guard } from "../core/guard.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { planned } from "../core/select.ts";
import { claimFollowup, deferFollowup, loadFollowupRows, loadPremerge, loadReviewsAt, settleFollowup, unsentTries, type FollowupSource, type ReviewRow } from "../data/review/index.ts";
import { FILING_LEASE_MS, unsentAsk } from "../core/rules.ts";
import { followUpClaims, reviewFollowUps } from "../core/review-blocking.ts";
import { partTitle } from "../workflow/work.ts";
import { loadShown } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";
import { exec, type Exec } from "../fixup/git.ts";
import { createIssue, ghFollowupComment, IssueError, type Writer } from "../github/write.ts";
import { isUnsent, rateLimited } from "../github/unsent.ts";
import { issueText, issueTitle, refusal } from "../postmerge/template.ts";
import { CARRIED } from "../review/carry.ts";
import { postSourcesOf, type PostSource } from "../review/post-source.ts";
import { pipelineLogin } from "../review/discussion.ts";
import { jobItem } from "../runner/job-items.ts";
import { findingsOf, premergeAt } from "./store.ts";
import { claimFindings } from "./parse.ts";
import { followUpDefects, type PremergeFinding } from "./types.ts";

export const ACTOR = "premerge-followup";
/** The title of a hold's follow-up, which names no file. */
const HOLD_TITLE = "Open question from the review";
/** The title of the follow-up for changes outside the PR's purpose, which names no file: a PR files it once. */
const OUTSIDE_TITLE = "Changes outside the pull request's purpose";
const SHORT_TITLE = 80;

export type FollowupsParams = { repo: string; limit?: number; onHandled?: (n: number) => void; by?: By };
export type FollowupsDeps = { exec: Exec; now: () => Date; /** The app lane's token source; default: the secrets file's app. */ lane?: Pick<Writer, "mint" | "appClient"> };
export type FollowupsSummary = { repo: string; filed: string[]; commented: string[]; /** Heads whose follow-ups were all filed before: recorded, nothing posted. */ repeated: string[]; failed: { ref: string; reason: string }[]; skipped: { ref: string; reason: string }[] };

export const defaultFollowupsDeps = (): FollowupsDeps => ({ exec, now: () => new Date() });

const oneLine = (e: unknown): string => String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);

/** "Follow-ups from #12: <the PR's title, cut short>". */
export function followupTitle(pr: number, title: string): string {
  // Only the PR's own title is cleaned: the prefix keeps its #number, which links the PR.
  const t = issueTitle(title);
  return `Follow-ups from #${pr}: ${t.length > SHORT_TITLE ? `${t.slice(0, SHORT_TITLE - 1).trimEnd()}…` : t}`;
}

/** Untrusted model text on one line, cleaned as a public issue's text is (no mentions, URLs, raw HTML or issue references). */
const line = (t: string): string => issueText(t).replace(/\s*\n\s*/g, " ");

/** One follow-up: its title, where (file and line; empty for a hold), what to change or what goes wrong, and why it does not stop the merge. */
export type FollowupEntry = { title: string; where: string; text: string; why: string };

/** The pre-merge review's defects that do not stop the merge. */
const premergeEntries = (fs: readonly PremergeFinding[]): FollowupEntry[] =>
  followUpDefects(fs).map((f) => ({ title: f.title, where: `${f.file}${f.line ? `:${f.line}` : ""}`, text: f.scenario, why: f.blocking?.why ?? "" }));

/** The Opus review's fixes that do not block the merge and nobody dropped (`dropped`), the reason of its hold when that does not block it, and its lines outside the PR's purpose. */
export const reviewEntries = (r: Pick<ReviewRow, "verdict" | "fixes" | "workflow" | "blocked_by">, dropped: readonly string[] | undefined): FollowupEntry[] => {
  const { fixes, hold, outside } = reviewFollowUps({ ...r, hold: r.workflow?.hold, blockedBy: r.blocked_by, outside: r.workflow?.outside_purpose }, dropped);
  return [
    ...fixes.map((x) => ({ title: partTitle(x), where: x.file, text: x.change, why: x.blocking?.why ?? "" })),
    ...(hold ? [{ title: HOLD_TITLE, where: "", text: hold, why: "" }] : []),
    ...(outside ? [{ title: OUTSIDE_TITLE, where: "", text: `${outside.lines} changed lines: ${outside.note.trim()}`, why: "" }] : []),
  ];
};

/**
 * The Opus review's code-incomplete claims that it did not turn into a fix (src/core/review-blocking.ts followUpClaims), worded as the
 * pre-merge review words the same claim, so a gap both reviews raised is listed once. `src`: the review at the head, or the one a carried
 * review came from; `goesOn`: the pipeline acts on the review as a take or take-fix. These are filed whether or not a pre-merge call ran: a carried pre-merge review reads no claims.
 */
const claimEntries = (src: PostSource | null, goesOn: boolean): FollowupEntry[] => (src ? premergeEntries(claimFindings(followUpClaims({ ...src, verdict: src.sourceVerdict }, goesOn), [])) : []);

/** The follow-ups of one head, numbered: where, what to change or what goes wrong, and why it does not stop the merge. */
export function followupBody(pr: number, head: string, source: FollowupSource, fs: readonly FollowupEntry[], first: boolean): string {
  const found = source === "review" ? "found these changes to make" : "found these defects";
  const what = source === "review" ? "the review" : "the pre-merge review";
  const lead = first
    ? `${what[0]!.toUpperCase()}${what.slice(1)} of #${pr} at ${head.slice(0, 7)} ${found}. A maintainer approved #${pr} for merge, and none of them stops it, so they are listed here to fix separately.`
    : `${what[0]!.toUpperCase()}${what.slice(1)} of #${pr} at ${head.slice(0, 7)} ${found}. None of them stops the merge.`;
  const items = fs.map((f, i) => [
    `${i + 1}. **${issueTitle(f.title)}**${f.where ? ` (\`${f.where.replace(/`/g, "")}\`)` : ""}`,
    `   ${line(f.text)}`,
    ...(f.why ? [`   Not blocking: ${line(f.why)}`] : []),
  ].join("\n"));
  return `${lead}\n\n${items.join("\n\n")}\n`;
}

/** A follow-up as the "comes back" check of the fix-up rounds matches a finding: same place and title. A hold has neither, so its reason keys it. */
const entryKey = (f: FollowupEntry): string => (f.title === HOLD_TITLE && !f.where ? `\u0000hold\u0000${f.text}` : `${f.where.replace(/:\d+$/, "")}\u0000${f.title}`);

/** Runs the repo's due `followups` actions: one issue per PR, a comment on it for a later head. */
export async function runPremergeFollowups(db: Db, params: FollowupsParams, log: (line: string) => void = console.log, deps: FollowupsDeps = defaultFollowupsDeps()): Promise<FollowupsSummary> {
  const { repo } = params, by = params.by ?? CLI_BY;
  const s: FollowupsSummary = { repo, filed: [], commented: [], repeated: [], failed: [], skipped: [] };
  const due = await planned(db, "followups", { repo, by });
  const login = await pipelineLogin(db);
  const w: Writer = { db, login: ACTOR, ...deps.lane };
  let handled = 0;
  for (const { facts: f, action } of due) {
    if (params.limit !== undefined && handled >= params.limit) break;
    const number = f.number, head = action.head!, ref = `${repo}#${number}`;
    const source: FollowupSource = action.params?.source === "review" ? "review" : "premerge";
    // A review's follow-ups are of its own head, which leads to the PR's head through our own pushes; its row is keyed by it.
    const rowHead = source === "review" && typeof action.params?.reviewHead === "string" ? action.params.reviewHead : head;
    const dropped = f.workflow?.dropped;
    const skip = async (reason: string) => { s.skipped.push({ ref, reason }); await jobItem(db, repo, number, `follow-ups not filed: ${reason}`, log); };
    const rv = source === "review" ? [...(await loadReviewsAt(db, [{ repo, number, head: rowHead }])).values()][0] ?? null : null;
    const pm = source === "premerge" ? await premergeAt(db, repo, number, head) : null;
    const row = rv ?? pm;
    const sources = await postSourcesOf(db, [ref]);
    const goesOn = f.review?.verdict === "take" || f.review?.verdict === "take-fix";
    const claimsAt = async (h: string) => claimEntries(await sources(repo, number, h), goesOn);
    const all = rv ? [...reviewEntries(rv, dropped), ...await claimsAt(rowHead)] : pm ? premergeEntries(findingsOf(pm)) : [];
    if (!all.length) { await skip(`the ${source === "review" ? "review" : "pre-merge review"} at the head has none`); continue; }
    const g = await guard(db, { repo, number }, { kind: "followups", head, source }, by);
    if ("refused" in g) { await skip(g.refused); continue; }
    const [pmRows, rvRows] = await Promise.all([loadFollowupRows(db, [{ repo, number }], "premerge"), loadFollowupRows(db, [{ repo, number }], "review")]);
    const mine = (source === "review" ? rvRows : pmRows).get(ref) ?? [], other = (source === "review" ? pmRows : rvRows).get(ref) ?? [];
    // What earlier rows of either table filed (or may have filed) is not posted again: a new head repeats the same findings after every push of ours.
    const kept = (x: { state: string }) => x.state !== "failed" && x.state !== "unsent";
    const earlierOwn = mine.filter((x) => x.head_oid !== rowHead && kept(x)), earlierOther = other.filter(kept);
    const [pmBefore, rvBefore] = source === "review" ? [earlierOther, earlierOwn] : [earlierOwn, earlierOther];
    const [earlierPm, earlierRv] = await Promise.all([
      loadPremerge(db, pmBefore.map((x) => ({ repo, number, head: x.head_oid }))),
      loadReviewsAt(db, rvBefore.map((x) => ({ repo, number, head: x.head_oid }))),
    ]);
    const earlierClaims = (await Promise.all(rvBefore.map((x) => claimsAt(x.head_oid)))).flat();
    const sent = new Set([...[...earlierPm.values()].flatMap((r) => premergeEntries(findingsOf(r))), ...[...earlierRv.values()].flatMap((r) => reviewEntries(r, dropped)), ...earlierClaims].map(entryKey));
    const fs = all.filter((x) => !sent.has(entryKey(x)));
    const prev = [...mine, ...other].filter((x) => x.issue_number !== null && x.url !== null).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).at(-1);
    const shown = await loadShown(db, [{ repo, number }, ...(prev ? [{ repo, number: prev.issue_number! }] : [])]);
    // The issue a later head comments on must still be open; a closed one gets a new issue for what is new.
    const issue = prev && shown.get(`${repo}#${prev.issue_number}`)?.state !== "closed" ? { number: prev.issue_number!, url: prev.url! } : null;
    const title = followupTitle(number, shown.get(ref)?.title ?? "");
    const body = followupBody(number, rowHead, source, fs, !issue);
    const at = () => deps.now().toISOString();
    const bad = refusal([title, body], login);
    const unsentBefore = unsentTries(mine.find((x) => x.head_oid === rowHead));
    if (!await claimFollowup(db, { repo, number, source, head: rowHead, at: at(), staleBefore: new Date(deps.now().getTime() - FILING_LEASE_MS).toISOString() })) continue;
    handled++;
    params.onHandled?.(handled);
    if (!fs.length) {
      // Nothing new: the head counts as filed, and its merge goes on.
      await settleFollowup(db, { repo, number, source, head: rowHead, at: at(), state: "filed", issue: prev ? { number: prev.issue_number!, url: prev.url! } : null });
      s.repeated.push(ref);
      continue;
    }
    if (bad) {
      await settleFollowup(db, { repo, number, source, head: rowHead, at: at(), state: "failed", note: bad });
      s.failed.push({ ref, reason: bad });
      continue;
    }
    // A carried row's findings were written at an earlier head; the note then names no model rather than the carry.
    const note = { by: "model" as const, kind: "issue", model: row?.model === CARRIED ? null : row?.model ?? null };
    try {
      let made: { number: number; url: string };
      if (issue) {
        const r = await ghFollowupComment(w, g, deps.exec, { issue: issue.number }, note, body, { head });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit code ${r.code}`);
        made = issue;
        s.commented.push(ref);
      } else {
        made = await createIssue(w, g, deps.exec, { repo, target: ref, title, body, action: ACTOR }, note, { head });
        s.filed.push(ref);
      }
      await settleFollowup(db, { repo, number, source, head: rowHead, at: at(), state: "filed", issue: made });
      await jobItem(db, repo, number, `follow-ups filed in ${made.url}`, log);
    } catch (e) {
      const reason = oneLine(e);
      // Nothing was sent: the head is tried again after a backoff, and the try after the last one fails it.
      if (isUnsent(e) || rateLimited(reason) || (e instanceof IssueError && (e.later || e.unsettled))) {
        const now = at(), tries = [...unsentBefore, now];
        if (unsentAsk(tries, Date.parse(now)) !== "final") {
          await deferFollowup(db, { repo, number, source, head: rowHead, at: now, tries });
          s.skipped.push({ ref, reason });
          await jobItem(db, repo, number, `follow-ups not sent, tried again later: ${reason}`, log);
          continue;
        }
        await settleFollowup(db, { repo, number, source, head: rowHead, at: now, state: "failed", note: `not sent ${tries.length} times: ${reason}` });
        s.failed.push({ ref, reason });
        await jobItem(db, repo, number, `follow-ups not posted on GitHub: ${reason}`, log);
        continue;
      }
      // An outcome that is not known keeps the `filing` row: the issue may exist, and it is not opened twice.
      if (e instanceof IssueError && !e.clear) { s.failed.push({ ref, reason: `outcome unknown: ${reason}` }); continue; }
      await settleFollowup(db, { repo, number, source, head: rowHead, at: at(), state: "failed", issue, note: reason });
      s.failed.push({ ref, reason });
      await jobItem(db, repo, number, `follow-ups not posted on GitHub: ${reason}`, log);
    }
  }
  log(`premerge-followups ${repo}: ${s.filed.length} issues opened, ${s.commented.length} comments, ${s.repeated.length} with nothing new, ${s.failed.length} failed, ${s.skipped.length} skipped`);
  return s;
}
