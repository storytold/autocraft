// What an approved workflow's merge leg waits for when nothing can move it on: the app identity (as an implement workflow does
// from its start), without which nobody's started work counts; the merge, made as the approver, waiting for them
// to sign in; or the pre-merge check of the PR's head, due once the leg is in `ci`, or the model step of the item's first due action,
// with no Task Runner that may take a call about the item, or only the own runners of the people whose work it is, none of which can
// claim now (src/remote/takers.ts waitingOn). For a closed workflow: what keeps the
// close from being made. A merge refused for its approver's access is no wait but a question (ask.ts), which an answer closes, or the
// approver's next sign-in (src/github/user-lane.ts retryWaiting). A contributor, or a person on GitHub, whom the item waits for without a question. The status comment, the item page and the agent show it as the state line.
import { loadFollowupRows, loadPremerge, loadPremergeFollowups, PREMERGE_MAX_TRIES } from "../data/review/index.ts";
import { loadShown } from "../data/mirror/index.ts";
import { loadActions, loadLegs, loadLinks, type WorkflowAction } from "../data/workflow/index.ts";
import { loadPlans } from "../data/planner/index.ts";
import { loadWorkflowFailures } from "../data/jobs/index.ts";
import type { RefusalCode, WaitCode } from "../core/codes.ts";
import type { ActionKind } from "../core/plan.ts";
import type { Db } from "../db/index.ts";
import { githubIdentity } from "../github/identity.ts";
import { t, tk } from "../i18n/index.ts";
import { hiddenWaitText, loginWaitIn, takerTestIn, waitingOnIn, type RunnerHold } from "../remote/takers.ts";
import { loadQueue } from "../data/runners/index.ts";
import { loadView } from "../remote/view.ts";
import type { ItemWorkflow } from "./types.ts";

/** What became of a close that is not made: it waits for its person, for the Act step, or it did not run. Null once it is made. */
function closeWait(a: WorkflowAction | undefined): string | null {
  switch (a?.state) {
    case "pending": return t("Closing as {login}", { login: a.by });
    case "waiting-token": return t("Waiting for {login} to sign in to AutoCraft, so the close runs as them", { login: a.by });
    case "waiting-permission": return t("Not closed: {login} has no write access here", { login: a.by });
    case "failed": case "skipped": case "stopped": return t("Not closed: {why}", { why: a.reason ?? a.state });
    default: return null;
  }
}

type Waiter = Pick<ItemWorkflow, "id" | "repo" | "number" | "kind" | "state">;

/** legWaits() of one workflow. */
export const legWait = async (db: Db, wf: Waiter, nowMs: number = Date.now(), o: WaitReader = {}): Promise<string | null> => (await legWaits(db, [wf], nowMs, o)).get(wf.id) ?? null;

/** `shown`: the reader may see whose Task Runner the work waits for and why (operators and maintainers); false gives "Waiting for a Task Runner". Left out: shown. */
export type WaitReader = { shown?: boolean };

/**
 * Per workflow id the state line of a workflow whose started work waits for the app identity, whose merge leg waits for its approver's
 * sign-in, or for a pre-merge check or the model step of its first due action that no Task Runner can take, or that only the own runners of the people whose work it is take while
 * none of them can claim (offline, held for its usage, cooling off) or each leaves its queued call until its harness login renews, or for the contributor or a person on GitHub, or whose close is not made,
 * and the line of a done workflow whose PR merged with follow-ups filed or not posted; the others are absent. A live workflow whose check
 * failed several passes in a row shows that instead. A reader who may not see whose Task Runner it is (`o.shown` false) reads "Waiting for a Task Runner".
 */
export async function legWaits(db: Db, wfs: readonly Waiter[], nowMs: number = Date.now(), o: WaitReader = {}): Promise<Map<number, string>> {
  const out = await legLines(db, wfs, nowMs, o.shown ?? true), failing = wfs.length ? await loadWorkflowFailures(db) : [];
  // A workflow whose check keeps failing stands still whatever else it waits for (src/workflow/advance.ts FAILING_SHOWN); the error is in the health checks.
  const ids = new Set(wfs.map((w) => w.id));
  for (const f of failing) if (ids.has(f.id)) out.set(f.id, t("AutoCraft has failed to check this item since {time} UTC and keeps trying", { time: f.since.slice(11, 16) }));
  return out;
}

async function legLines(db: Db, wfs: readonly Waiter[], nowMs: number, shown: boolean): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const closed = wfs.filter((w) => w.state === "closed"), moving = wfs.filter((w) => w.state === "running" || w.state === "waiting");
  const ofPrs = moving.filter((w) => w.kind === "pr").map((w) => ({ repo: w.repo, number: w.number }));
  const issues = moving.filter((w) => w.kind !== "pr").map((w) => w.id);
  const [identity, closes, actions, links, prLegs] = await db.together(() => Promise.all([
    moving.length ? githubIdentity(db) : "app",
    closed.length ? loadActions(db, { workflowIds: closed.map((w) => w.id), kinds: ["close", "comment-close"] }) : new Map<string, WorkflowAction[]>(),
    moving.length ? loadActions(db, { workflowIds: moving.map((w) => w.id) }) : new Map<string, WorkflowAction[]>(),
    loadLinks(db, { workflowIds: issues }), loadLegs(db, ofPrs, { activeOnly: true, latestOnly: true }),
  ]));
  const add = (id: number, line: string | null): void => { if (line !== null) out.set(id, line); };
  const byWorkflow = (m: ReadonlyMap<string, WorkflowAction[]>): Map<number, WorkflowAction[]> => {
    const by = new Map<number, WorkflowAction[]>();
    for (const a of [...m.values()].flat()) (by.get(a.workflow_id) ?? by.set(a.workflow_id, []).get(a.workflow_id)!).push(a);
    return by;
  };
  const closesOf = byWorkflow(closes), actionsOf = byWorkflow(actions);
  for (const w of closed) add(w.id, closeWait(closesOf.get(w.id)?.at(-1)));
  for (const [id, line] of await followUpLines(db, wfs.filter((w) => w.state === "done"))) add(id, line);
  // The PR the workflow's merge leg is on: the item, or the PR an implement workflow works on.
  const linked = new Map(links.map((l) => [l.workflowId, l.pr]));
  const prOf = (w: Waiter): number | null => (w.kind === "pr" ? w.number : linked.get(w.id) ?? null);
  const implPrs = moving.flatMap((w) => { const pr = w.kind === "pr" ? null : prOf(w); return pr === null ? [] : [{ repo: w.repo, number: pr }]; });
  const planned = moving.map((w) => ({ repo: w.repo, number: prOf(w) ?? w.number }));
  const [implLegs, plans] = await db.together(() => Promise.all([loadLegs(db, implPrs, { activeOnly: true, latestOnly: true }), loadPlans(db, planned)]));
  const legs = new Map([...prLegs, ...implLegs]);
  moving.forEach((w, i) => {
    const p = plans.get(`${w.repo}#${planned[i]!.number}`);
    const code = p?.view.waitCode, line = code && (BY_OTHERS[code] ?? OWN_STEPS[code]);
    if (line && !(code === "implement-question" && p!.view.waitKind !== "contributor")) add(w.id, t(line));
  });
  const inCi: { w: Waiter; pr: number; head: string }[] = [];
  for (const w of moving) {
    const pr = prOf(w);
    const p = pr === null ? undefined : legs.get(`${w.repo}#${pr}`)?.find((l) => l.workflow_id === w.id);
    if (identity !== "app" && (p || w.kind === "issue")) { add(w.id, t("Waiting for an operator to switch AutoCraft to its GitHub App: started work acts as the person, which only the app does")); continue; }
    if (pr === null || !p?.head || (p.state !== "ci" && p.state !== "queued")) continue;
    const merge = actionsOf.get(w.id)?.find((a) => a.kind === "merge" && a.number === pr && a.head === p.head && a.state === "waiting-token");
    if (merge) add(w.id, t("Waiting for {login} to sign in to AutoCraft, so the merge runs as them", { login: merge.by }));
    else if (p.state === "ci" && !out.has(w.id)) inCi.push({ w, pr, head: p.head });
  }
  const premerge = await loadPremerge(db, inCi.map((x) => ({ repo: x.w.repo, number: x.pr, head: x.head })));
  const unread = inCi.filter((x) => { const pm = premerge.get(`${x.w.repo}#${x.pr}@${x.head}`); return !(pm && (pm.findings !== null || pm.tries >= PREMERGE_MAX_TRIES)); });
  // The other items: the step of the plan's first due action, when it calls a model.
  const due = moving.flatMap((w, i) => {
    if (out.has(w.id) || unread.some((x) => x.w.id === w.id)) return [];
    const number = planned[i]!.number, kind = plans.get(`${w.repo}#${number}`)?.actions.find((a) => !a.refused)?.kind;
    const step = kind === undefined ? undefined : ACTION_STEP[kind];
    return step ? [{ w, step, number }] : [];
  });
  if (!unread.length && !due.length) return out;
  const view = await loadView(db, nowMs), takes = takerTestIn(view);
  // Items with a queued call, read only while some runner waits for its login's renewal: a call already running waits for nothing.
  const queued = view.snapshot.runners.some((r) => (r.loginRenewsAt ?? 0) > nowMs)
    ? new Set((await loadQueue(db, nowMs)).calls.flatMap((c) => c.refs.map((i) => `${i.repo}#${i.number}`))) : new Set<string>();
  for (const { w, step, number } of [...unread.map((x) => ({ w: x.w, step: "premerge", number: x.pr })), ...due]) {
    const call = { prompt_id: "", repos: [w.repo], step, refs: [{ repo: w.repo, number }] };
    if (!takes(call)) { add(w.id, t("Waiting for the {step}: no Task Runner can take it", { step: t(STEP_WORD[step]!) })); continue; }
    const [first] = waitingOnIn(view, call);
    if (first) { add(w.id, shown ? t("Waiting for {login}'s Task Runner ({why})", { login: first.login, why: t(HOLD_WORD[first.hold]) }) : hiddenWaitText(first)); continue; }
    const renew = queued.has(`${w.repo}#${number}`) ? loginWaitIn(view, call) : null;
    if (renew) add(w.id, shown ? t("Waiting for {login}'s Task Runner (login renews at {time} UTC)", { login: renew.login, time: new Date(renew.at).toISOString().slice(11, 16) }) : t("Waiting for a Task Runner"));
  }
  return out;
}

/** The step that works an item's due action, for the actions whose step calls a model. */
const ACTION_STEP: Partial<Record<ActionKind, string>> = { review: "opus-review", fixup: "fixup", conflict: "fixup", cifix: "cifix", premerge: "premerge", verify: "verify", implement: "implement" };
/** Each ACTION_STEP step as the wait line names it. */
const STEP_WORD: Record<string, string> = {
  "opus-review": tk("review"), fixup: tk("fix-up"), cifix: tk("CI fix"), premerge: tk("pre-merge check"), verify: tk("verification"), implement: tk("implementation"),
};

/** Per workflow id, the line of a done workflow whose PR merged with follow-ups filed in its follow-up issue, or with follow-ups whose filing failed (src/premerge/followups.ts). */
async function followUpLines(db: Db, done: readonly Waiter[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!done.length) return out;
  const linked = new Map((await loadLinks(db, { workflowIds: done.filter((w) => w.kind !== "pr").map((w) => w.id) })).map((l) => [l.workflowId, l.pr]));
  const prs = done.flatMap((w) => { const pr = w.kind === "pr" ? w.number : linked.get(w.id); return pr == null ? [] : [{ w, repo: w.repo, number: pr }]; });
  const [filed, reviewed, shown] = await db.together(() => Promise.all([loadPremergeFollowups(db, prs), loadFollowupRows(db, prs, "review"), loadShown(db, prs)]));
  for (const { w, repo, number } of prs) {
    const ref = `${repo}#${number}`;
    if (shown.get(ref)?.state !== "merged") continue;
    const rows = [...filed.get(ref) ?? [], ...reviewed.get(ref) ?? []].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const issue = rows.findLast((r) => r.issue_number !== null)?.issue_number;
    if (rows.at(-1)?.state === "failed") out.set(w.id, t("Merged; follow-ups not posted on GitHub"));
    else if (issue != null) out.set(w.id, t("Merged; follow-ups filed in #{issue}", { issue }));
  }
  return out;
}

/** The state line of an item that waits, with no question open, for someone outside AutoCraft. */
const BY_OTHERS: Partial<Record<WaitCode, string>> = {
  "ci-contributor": tk("Waiting for the contributor to fix CI"),
  "fix-contributor": tk("Waiting for the contributor's fixes"),
  "conflict-contributor": tk("Waiting for the contributor to resolve the conflict with the base branch"),
  "conflict-person": tk("Waiting for someone to resolve the conflict with the base branch"),
  "changes-requested": tk("Waiting for the maintainer who asked for changes"),
  "repo-approval": tk("Waiting for the repo's approval of the next step, on the Repos page"),
  breaker: tk("Waiting for someone to resume the next step, which stopped itself here"),
  draft: tk("Waiting for the pull request to be marked ready for review"),
  "implement-question": tk("Waiting for the author's answer"),
  "issue-reporter": tk("Waiting for the reporter's answer"),
  "author-ask": tk("Waiting for the author's push"),
};

/** The state line of an item whose merge waits for a step of AutoCraft's own that the plan names by its wait code. */
const OWN_STEPS: Partial<Record<WaitCode, string>> = { followups: tk("Filing follow-ups before the merge") };

const HOLD_WORD: Record<RunnerHold, string> = { offline: tk("offline"), "usage-limit": tk("usage limit"), "cooling-off": tk("cooling off"), "not-ready": tk("not ready") };

/** Why the review post of a started item may not run, by the refusal's code: the stored plan keeps the code only. */
const NOT_POSTED: Partial<Record<RefusalCode, string>> = {
  "repo-approval": tk("comments in {repo} are not approved, and the automatic merge rule started this item"),
  "actor-gone": tk("the person this item acts for can no longer act on {repo}"),
  "actor-unknown": tk("GitHub has not answered on the access of the person this item acts for"),
  "box-identity": tk("AutoCraft writes as its own account; an operator switches it to its GitHub App"),
};

/**
 * Per workflow id, the line saying the Opus review of the item's PR (an implement workflow's: its PR's) or its follow-up issue is not on
 * GitHub, and why: the stored plan holds the review post or the filing refused, or GitHub refused the filing. The others are absent. The item page, the Discord thread, the agent and the CLI show it
 * beside the state line.
 */
export async function notPostedLines(db: Db, wfs: readonly Waiter[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!wfs.length) return out;
  const issues = wfs.filter((w) => w.kind !== "pr").map((w) => w.id);
  const linked = new Map((await loadLinks(db, { workflowIds: issues })).map((l) => [l.workflowId, l.pr]));
  const prs = wfs.flatMap((w) => { const pr = w.kind === "pr" ? w.number : linked.get(w.id); return pr == null ? [] : [{ w, repo: w.repo, number: pr }]; });
  const [plans, filed] = await db.together(() => Promise.all([loadPlans(db, prs.map(({ repo, number }) => ({ repo, number }))), loadPremergeFollowups(db, prs)]));
  for (const { w, repo, number } of prs) {
    const actions = plans.get(`${repo}#${number}`)?.actions ?? [];
    const code = actions.find((a) => a.kind === "post-review")?.refused, fu = actions.find((a) => a.kind === "followups")?.refused;
    const last = filed.get(`${repo}#${number}`)?.at(-1), failed = last?.state === "failed" ? last.note : null;
    const why = code ? (NOT_POSTED[code] ? t(NOT_POSTED[code], { repo }) : t("the review post may not run ({code})", { code }))
      : fu ? (NOT_POSTED[fu] ? t(NOT_POSTED[fu], { repo }) : t("the follow-up issue may not be filed ({code})", { code: fu }))
      : failed ? t("the follow-up issue: {reason}", { reason: failed }) : null;
    if (why) out.set(w.id, t("Not posted on GitHub: {why}", { why }));
  }
  return out;
}

/** notPostedLines() of one workflow. */
export const notPostedLine = async (db: Db, wf: Waiter): Promise<string | null> => (await notPostedLines(db, [wf])).get(wf.id) ?? null;
