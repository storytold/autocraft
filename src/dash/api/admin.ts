// Contributors (the whitelist), tracked repos and the access list over JSON.
// Reads of contributors are open to anyone signed in; operators and
// maintainers also see override notes. The access list and every write here
// are for operators. The server has already checked the Origin, the CSRF
// header and the body size on POSTs.
import { filtered, isHiddenRepo, listAuditPage, loadStepApprovals, loadTrackedRepos, setPipelineFlags, type HiddenRepos } from "../../data/control/index.ts";
import { endSessionById, listSessions, loadOverrides } from "../../data/access/index.ts";
import { mayRunRepo } from "../repo-access.ts";
import type {
  AccessOverview, AuditEntry, AuditPage, Contributor, ContributorList, ContributorSort, RulePreview, RepoApproval, Tier, TrackedRepo, WhitelistRule,
} from "../../../web/src/api/types.ts";
import { AccessError, addLogin, getAccess, isRole, LOGIN, listAccess, removeLogin, ROLES, setRole } from "../../access.ts";
import { setApproval } from "../../labels/approval.ts";
import { setCommentApproval } from "../../act/approval.ts";
import { setPushApproval } from "../../fixup/approval.ts";
import { setFixIssueApproval } from "../../implement/approval.ts";
import { setMergeApproval } from "../../merge/approval.ts";
import { setCiApproval } from "../../merge/ci-approval.ts";
import { optionalChecksOf, seenChecksOf, setOptionalCheck } from "../../optional-checks.ts";
import { setMainFixApproval } from "../../mainfix/approval.ts";
import { setStatusApproval } from "../../prstatus/approval.ts";
import { setWorkspaceExcluded, workspaceExcluded } from "../../sandbox/workspace.ts";
import { setSingleMergeMax, singleMergeMax } from "../../merge/single.ts";
import { isFeature, repoSwitches, shownFeatures } from "../../build/features.ts";
import { switchFeature } from "./build.ts";
import { countPlan, planLabelsOf } from "../../labels/plan.ts";
import { listAll, RepoError, trackRepoChecked, untrackRepo } from "../../repos.ts";
import { contributors, getRule, OVERRIDE_LOGIN, setOverride, setRule, tierOf, type Contributor as Row, type Rule } from "../../whitelist.ts";
import { audit } from "../audit.ts";
import { dropSessionTokens } from "../server/user-tokens.ts";
import { endTokens, listAllTokens, revokeAnyToken } from "../mcp/tokens.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import type { Step } from "../../data/control/types.ts";
import { hiddenRepos, visibleRepos } from "./visible.ts";
import { canSeeInternals } from "./staff.ts";
import type { Db } from "../../db/index.ts";
import { setting } from "../../data/control/index.ts";

const NOTE_MAX = 300;
const ACCESS_NOTE_MAX = 500;
const AUDIT_PAGE = 50;
// Accounts and access (who can sign in, sessions), the abuse protections and the instance identity are audited for operators only.
export const operatorOnly = (a: string) => a.startsWith("access-") || a.startsWith("github-app-") || a.startsWith("github-mention-") || a.startsWith("app-") || a.startsWith("account-") || a.startsWith("mcp-token-") || a.startsWith("runner-") || ["session-revoke", "sign-in", "sign-in-refused", "usage-reserve", "my-repos", "max-calls", "interactive-slots", "manual-only", "transcript-store",
    "abuse-limits", "outside-release", "outside-release-author", "stage-trip", "github-identity", "env-rotate-key"].includes(a);
export const AUDIT_ACTIONS = [
  "answer", "undo", "dispute", "dispute-resolve", "answer-sweep", "adopt", "opinion", "opinion-retract", "comment", "override", "rule", "access-add", "access-remove", "access-role",
  "session-revoke", "mcp-token-create", "mcp-token-revoke", "app-owner-allow", "app-owner-remove", "app-install-removed", "webhook-redeliver", "app-foreign-install-ack", "runner-migrate", "runner-approve", "runner-deny", "runner-revoke", "runner-scopes", "runner-rename", "usage-reserve", "my-repos", "max-calls", "interactive-slots", "manual-only", "runner-private", "remote-pick", "remote-unpick", "remote-pick-minutes", "sign-in", "sign-in-refused", "account-add", "account-change", "account-login-start", "account-login-code", "account-login-cancel", "account-token-start", "account-token-code", "account-token-cancel", "account-token-set", "account-token-remove", "account-sign-out", "account-refresh", "repo-track", "repo-untrack", "reference-import", "labels-approve", "labels-revoke", "labels-apply", "merge-approve", "merge-revoke", "comment-approve", "comment-revoke", "act-comment", "act-close", "act-reopen", "act-open-issue", "discord-issue-open", "discord-issue-bot", "discord-issue-label", "act-unlabel", "act-transfer", "act-request-reviewers", "act-skip", "push-approve", "push-revoke", "fixup-push", "fixup-comment", "fixup-comment-edit", "fixissue-approve", "fixissue-revoke", "prstatus-approve", "prstatus-revoke", "pr-status-comment", "pr-status-comment-edit", "pr-status-ping", "mainfix-approve", "mainfix-revoke", "optional-check-add", "optional-check-remove", "fixissue-push", "fixissue-pr", "fixissue-comment", "implement-push", "implement-pr", "implement-comment",
  "job-request", "job-cancel", "security-scan-start", "security-scan-stop", "security-finding-dismiss", "security-finding-backlog", "security-finding-reopen", "security-finding-fix", "security-finding-land", "security-finding-advisory", "security-finding-publish", "security-land-push", "security-land", "security-land-opened", "security-landed", "security-advisory", "security-advisory-fork", "security-advisory-push", "security-advisory-pr", "security-advisory-ready", "security-publish", "security-published", "security-cve", "pipeline-switch", "stage-limit", "limit-reset", "pilot-set", "pilot-clear", "repo-pipeline", "github-identity", "review-post", "review-edit", "batch-again", "reopen", "backlog-bulk", "withdraw",
  "single-merge-max", "merge-train-depth", "merge-train-note", "merge-train-depth", "merge-train-note", "label-create", "batch-pr-close", "fork-create", "assign", "unassign", "merge", "batch-push", "batch-pr", "shared-repos",
  "fasttrack-add", "fasttrack-remove", "fasttrack-weight", "abuse-limits", "outside-release", "outside-release-author", "merge-hold", "merge-release", "batch-remove", "batch-stop", "areas-edit", "areas-accept", "prompt-edit", "prompt-rollback", "ci-approve", "ci-revoke", "ci-run-approve", "ci-rerun", "cifix-push", "cifix-comment", "cifix-check", "postmerge-file", "eval-issue", "eval-comment", "eval-repo", "postmerge-file-one", "nightly-issue", "nightly-select", "postmerge-review", "postmerge-backfill",
  "act-group-applied", "answer-used", "base-changed", "batch-end-too-late", "batch-hold", "batch-blame", "batch-rerun", "batch-merged-after-end", "batch-start", "carry-queued", "classify-run", "compare-again", "conflict-comment", "conflict-comment-edit", "conflict-push", "conversation-card", "conversation-card-dismiss", "conversation-card-edit", "decision-withdrawn", "duplicate-answer", "duplicate-group-ended", "duplicate-member-released", "duplicate-superseded", "env-change", "env-create", "env-rotate-key", "fix-again", "fixissue-check", "fixissue-claim", "fixissue-unclaim", "fixup-check", "item-gone", "merge-answer-superseded", "merge-held-for-discussion", "merge-question-withdrawn", "merge-refused", "preapproval", "github-app-register", "github-app-register-failed", "github-app-remove", "github-app-login-mode", "github-mention-set", "github-mention-clear", "github-app-link-create", "github-app-link-revoke", "github-app-link-use", "github-app-manager", "operator-fixup", "review-again", "scope-answer-lapsed", "task-cancel", "verify-again", "workspace-exclude", "transcript-store",
];

const isOperator = (req: Req): boolean => req.user.role === "operator";

function requireOperator(req: Req, what: string): void {
  if (!isOperator(req)) throw new HttpError(403, `only operators ${what}`);
}

// An operator, or a maintainer with GitHub write permission on the repo, runs it; the rule is mayRunRepo.
async function requireRunRepo(req: Req, repo: string): Promise<void> {
  if (!await mayRunRepo(req.user, repo)) throw new HttpError(403, "only an operator, or a maintainer with write access to the repo, changes its settings");
}

function body(req: Req): Record<string, unknown> {
  const b = req.json;
  if (b === undefined) return {};
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
}

function text(v: unknown, max: number, what: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${what} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${what} is longer than ${max} characters`);
  return t || null;
}

const required = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${what} is required`);
  return v.trim();
};

// Library errors (AccessError, RepoError, setRule's range checks) are messages
// for the operator.
async function refused<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof AccessError || e instanceof RepoError) throw new HttpError(400, e.message);
    throw e;
  }
}

async function refusedAsync<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof AccessError || e instanceof RepoError) throw new HttpError(400, e.message);
    throw e;
  }
}

// ---- contributors ----------------------------------------------------------

const TIER: Record<Row["tier"], Tier> = { whitelisted: "whitelisted", not: "not", allow: "override-allow", deny: "override-deny" };
const TIERS = Object.values(TIER);

function toContributor(c: Row, rule: Rule, operator: boolean): Contributor {
  const out: Contributor = {
    login: c.login, tier: TIER[c.tier], autoTier: tierOf(c.merged, c.closed, null, rule) === "whitelisted" ? "whitelisted" : "not",
    override: c.override, overrideInEffect: c.override_in_effect, overrideBy: c.override_by, overrideAt: c.override_at,
    merged: c.merged, closedUnmerged: c.closed, open: c.open, mergeRate: c.rate, lastMerge: c.last_merge,
    repos: c.repos.split(",").filter(Boolean),
  };
  if (operator) out.overrideNote = c.note;
  return out;
}

const SORTS: Record<ContributorSort, (a: Row, b: Row) => number> = {
  login: (a, b) => a.login.localeCompare(b.login),
  tier: (a, b) => a.tier.localeCompare(b.tier),
  merged: (a, b) => a.merged - b.merged,
  closed: (a, b) => a.closed - b.closed,
  open: (a, b) => a.open - b.open,
  rate: (a, b) => (a.rate ?? -1) - (b.rate ?? -1),
  last: (a, b) => (a.last_merge ?? "").localeCompare(b.last_merge ?? ""),
  repos: (a, b) => a.repos.split(",").length - b.repos.split(",").length,
};

function int(v: string | null, def: number, min: number, max: number, what: string): number {
  if (v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${what} must be a whole number from ${min} to ${max}`);
  return n;
}

// The whole-mirror aggregate is reused for at least a minute, and after that
// until the next sync moves the high water. An override or rule change drops it.
const CONTRIBUTORS_TTL = 60_000;
const contributorCache = new WeakMap<Db, Map<string, { at: number; hw: string | null; rows: Row[] }>>();
export function clearContributorCache(db: Db): void {
  contributorCache.delete(db);
}
async function cachedContributors(db: Db, repo: string | undefined): Promise<Row[]> {
  const hw = (await setting(db, "org_high_water")) ?? null;
  const byRepo = contributorCache.get(db) ?? new Map<string, { at: number; hw: string | null; rows: Row[] }>();
  contributorCache.set(db, byRepo);
  const key = repo ?? "";
  const hit = byRepo.get(key);
  const now = Date.now();
  if (hit && (now - hit.at < CONTRIBUTORS_TTL || hit.hw === hw)) return hit.rows.map((r) => ({ ...r }));
  const rows = await contributors(db, { repo });
  byRepo.set(key, { at: now, hw, rows });
  return rows.map((r) => ({ ...r }));
}

// Rows of repos the viewer may not see are cut after the cache: the repo list of each
// contributor loses them, and a contributor seen only there is left out.
function withoutHidden(rows: Row[], hidden: HiddenRepos): Row[] {
  if (!filtered(hidden)) return rows;
  const out: Row[] = [];
  for (const r of rows) {
    const repos = (r.repos ?? "").split(",").filter(Boolean);
    const kept = repos.filter((x) => !isHiddenRepo(hidden, x));
    if (repos.length && !kept.length) continue;
    out.push({ ...r, repos: kept.join(",") });
  }
  return out;
}

export async function listContributors(db: Db, req: Req): Promise<ContributorList> {
  const q = req.query;
  const repo = q.get("repo") || undefined;
  const tier = q.get("tier") || undefined;
  if (tier !== undefined && !TIERS.includes(tier as Tier)) throw new HttpError(400, `tier must be one of ${TIERS.join(", ")}`);
  const sortKey = (q.get("sort") || "merged") as ContributorSort;
  const sort = SORTS[sortKey];
  if (!sort) throw new HttpError(400, `sort must be one of ${Object.keys(SORTS).join(", ")}`);
  const desc = q.get("desc") === null ? sortKey !== "login" : q.get("desc") === "1";
  const limit = int(q.get("limit"), 50, 1, 500, "limit");
  const offset = int(q.get("offset"), 0, 0, 1e9, "offset");
  const needle = (q.get("q") ?? "").trim().toLowerCase().slice(0, 100);

  const rule = await getRule(db);
  const hidden = await hiddenRepos(db, req);
  let rows = (repo !== undefined && isHiddenRepo(hidden, repo)) ? [] : withoutHidden(await cachedContributors(db, repo), hidden);
  if (needle) rows = rows.filter((c) => c.login.toLowerCase().includes(needle));
  const byTier = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  for (const c of rows) byTier[TIER[c.tier]]++;
  if (tier) rows = rows.filter((c) => TIER[c.tier] === tier);
  rows.sort((a, b) => (desc ? -sort(a, b) : sort(a, b)) || a.login.localeCompare(b.login));
  const operator = canSeeInternals(req);
  return { rule, total: rows.length, byTier, contributors: rows.slice(offset, offset + limit).map((c) => toContributor(c, rule, operator)) };
}

function ruleOf(v: Record<string, unknown>): WhitelistRule {
  const minMerged = Number(v.minMerged);
  const minRate = Number(v.minRate);
  if (!Number.isInteger(minMerged) || minMerged < 0 || minMerged > 100_000) throw new HttpError(400, "minMerged must be a whole number of at least 0");
  if (!(minRate >= 0 && minRate <= 1)) throw new HttpError(400, "minRate must be between 0 and 1");
  return { minMerged, minRate };
}

export async function previewRule(db: Db, req: Req): Promise<RulePreview> {
  requireOperator(req, "change the whitelist rule");
  const next = ruleOf({ minMerged: req.query.get("minMerged"), minRate: req.query.get("minRate") });
  const now = await getRule(db);
  const rows = (await contributors(db)).sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login));
  const allowed = (c: Row, r: Rule) => {
    const t = tierOf(c.merged, c.closed, c.override_in_effect ? c.override : null, r);
    return t === "whitelisted" || t === "allow";
  };
  const gained: string[] = [], lost: string[] = [];
  let allowedNow = 0, allowedAfter = 0;
  for (const c of rows) {
    const a = allowed(c, now), b = allowed(c, next);
    if (a) allowedNow++;
    if (b) allowedAfter++;
    if (b && !a) gained.push(c.login);
    if (a && !b) lost.push(c.login);
  }
  return {
    rule: next, authors: rows.length, allowedNow, allowedAfter,
    gained: { count: gained.length, logins: gained.slice(0, 20) }, lost: { count: lost.length, logins: lost.slice(0, 20) },
  };
}

export async function saveRule(db: Db, req: Req): Promise<WhitelistRule> {
  requireOperator(req, "change the whitelist rule");
  const r = ruleOf(body(req));
  await setRule(db, r, req.user.login);
  clearContributorCache(db);
  return await getRule(db);
}

export async function override(db: Db, req: Req, lookup: GithubUserLookup): Promise<Contributor> {
  requireOperator(req, "change the whitelist");
  const login = req.params.login!;
  const b = body(req);
  const status = b.status;
  if (status !== "allow" && status !== "deny" && status !== null) throw new HttpError(400, "status must be allow, deny or null");
  if (!OVERRIDE_LOGIN.test(login)) throw new HttpError(400, `not a GitHub login: ${login}`);
  // Without a note field the override keeps the note it has.
  const kept = async () => (await loadOverrides(db, [login])).get(login.toLowerCase())?.note ?? null;
  const note = status === null ? null : b.note === undefined ? await kept() : text(b.note, NOTE_MAX, "note");
  // An allow belongs to the account that holds the login now; a deny holds for any account, so it does not wait for GitHub.
  let id: number | null = null;
  if (status !== null) {
    try {
      id = await lookup(login);
    } catch {
      if (status === "allow") throw new HttpError(502, "GitHub could not be reached to look up that login. Try again.");
    }
    if (id === null && status === "allow") throw new HttpError(400, `${login} is not a GitHub user`);
  }
  try {
    await setOverride(db, login, status, note, req.user.login, id);
    clearContributorCache(db);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const rule = await getRule(db);
  const c = (await contributors(db, { login })).find((x) => x.login === login);
  return c ? toContributor(c, rule, true) : {
    login, tier: "not", autoTier: "not", override: null, overrideInEffect: false, overrideNote: null, overrideBy: null, overrideAt: null,
    merged: 0, closedUnmerged: 0, open: 0, mergeRate: null, lastMerge: null, repos: [],
  };
}

// ---- tracked repos ---------------------------------------------------------

export async function allRepos(db: Db, req: Req): Promise<TrackedRepo[]> {
  if (!canSeeInternals(req)) throw new HttpError(403, "only operators and maintainers read the repo settings");
  return await repoRows(db, req);
}

/** Every known repo, or the named one, with its settings: one wave whatever the number of repos (and one before it for the tracked names outside a read request, which shares them). */
async function repoRows(db: Db, req: Req, only?: string): Promise<TrackedRepo[]> {
  const tracked = [...(await loadTrackedRepos(db, only === undefined ? undefined : [only])).keys()];
  const [rows, approvals, plans, optional, seen, shown, switches] = await db.together(() => Promise.all([
    listAll(db), loadStepApprovals(db, tracked), planLabelsOf(db, tracked), optionalChecksOf(db), seenChecksOf(db, tracked), shownFeatures(db), repoSwitches(db),
  ]));
  return await Promise.all(rows.filter((r) => only === undefined || r.name === only).map(async (r): Promise<TrackedRepo> => {
    const t = !!r.tracked;
    const of = approvals.get(r.name) ?? {};
    const approval = (step: Step): RepoApproval | null => t ? { approved: !!of[step], approvedBy: of[step]?.by ?? null, approvedAt: of[step]?.at ?? null } : null;
    const c = countPlan(plans.get(r.name) ?? []);
    const labels = approval("labels");
    const canSwitch = t && await maySwitch(req, r.name);
    return {
      name: r.name, owner: r.owner, tracked: t, openPrs: r.open_prs, openIssues: r.open_issues, mirrored: r.rows, syncedAt: r.synced_at,
      labels: labels && { ...labels, toAdd: c.toAdd, skipped: c.already + c.unsettled, conflicts: c.conflicts },
      merging: approval("merge"), pushing: approval("push"), commenting: approval("comment"), fixing: approval("fixissue"), mainFixing: approval("mainfix"), ciApproving: approval("ci"), statusComments: approval("prstatus"),
      optionalChecks: t ? optional(r.name) : [], seenChecks: t ? seen.get(r.name) ?? [] : [],
      pipeline: t && !!r.pipeline,
      canSwitch,
      canManage: canSwitch,
      buildFeatures: t ? shown.map((feature) => ({ feature, on: switches(feature, r.name) })) : [],
    };
  }));
}

// One repo, for the endpoints that change a single repo's settings: the web patches it into its list, so the answer skips every other repo's label plan.
async function oneRepo(db: Db, req: Req, name: string): Promise<TrackedRepo> {
  const [r] = await repoRows(db, req, name);
  if (!r) throw new HttpError(404, `${name} is not a known repo`);
  return r;
}

// An operator, or a maintainer with write access to the repo, lets the Label stage write to a repo on GitHub.
export async function labelsApproval(db: Db, req: Req, approved: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  await requireRunRepo(req, name);
  const changed = await refused(async () => {
    try {
      return await setApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${name} is ${approved ? "already" : "not"} approved for labelling`);
  return await oneRepo(db, req, name);
}

// An operator, or a maintainer with write access to the repo, lets the pipeline merge pull requests in a repo.
export async function mergeApproval(db: Db, req: Req, approved: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  await requireRunRepo(req, name);
  const changed = await refused(async () => {
    try {
      return await setMergeApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${name} is ${approved ? "already" : "not"} approved for merging`);
  return await oneRepo(db, req, name);
}

// An operator, or a maintainer with write access to the repo, lets the pipeline approve the CI runs GitHub holds for outside contributors' PRs in a repo.
export async function ciApproval(db: Db, req: Req, approved: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  await requireRunRepo(req, name);
  const changed = await refused(async () => {
    try {
      return await setCiApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${name} is ${approved ? "already" : "not"} approved for approving CI runs`);
  return await oneRepo(db, req, name);
}

export async function workspaceInfo(db: Db, req: Req): Promise<{ excluded: string[] }> {
  const visible = new Set(await visibleRepos(db, req));
  return { excluded: (await workspaceExcluded(db)).filter((r) => visible.has(r)) };
}

// Only an operator changes which tracked repositories Opus calls cannot read.
export async function setWorkspaceInfo(db: Db, req: Req): Promise<{ excluded: string[] }> {
  requireOperator(req, "change the workspace");
  try {
    return { excluded: await setWorkspaceExcluded(db, body(req).excluded, req.user.login) };
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

export const singleMerge = async (db: Db): Promise<{ max: number }> => ({ max: await singleMergeMax(db) });

// Only an operator changes how many ready PRs merge one at a time.
export async function setSingleMerge(db: Db, req: Req): Promise<{ max: number }> {
  requireOperator(req, "change the single-merge limit");
  try {
    return { max: await setSingleMergeMax(db, body(req).max, req.user.login) };
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

// An operator, or a maintainer with write access to the repo, lets the pipeline comment on and close items in a repo.
export async function commentApproval(db: Db, req: Req, approved: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  await requireRunRepo(req, name);
  const changed = await refused(async () => {
    try {
      return await setCommentApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${name} is ${approved ? "already" : "not"} approved for commenting`);
  return await oneRepo(db, req, name);
}

// An operator, or a maintainer with write access to the repo, lets the pipeline push fix-up commits to contributors' branches in a repo.
export async function pushApproval(db: Db, req: Req, approved: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  await requireRunRepo(req, name);
  const changed = await refused(async () => {
    try {
      return await setPushApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${name} is ${approved ? "already" : "not"} approved for pushing`);
  return await oneRepo(db, req, name);
}

// An operator, or a maintainer with write access to the repo, lets the pipeline open fix PRs for issues in a repo.
export async function fixIssueApproval(db: Db, req: Req, approved: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  await requireRunRepo(req, name);
  const changed = await refused(async () => {
    try {
      return await setFixIssueApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${name} is ${approved ? "already" : "not"} approved for fixing issues`);
  return await oneRepo(db, req, name);
}

// An operator, or a maintainer with write permission on the repo (read live from GitHub), switches the pipeline stages on or off for it (off: sync only).
const maySwitch = async (req: Req, repo: string): Promise<boolean> => await mayRunRepo(req.user, repo);

/** One repo's build feature switch (src/dash/api/build.ts switchFeature holds the rule). */
export async function buildFeatureSwitch(db: Db, req: Req): Promise<TrackedRepo> {
  const b = body(req);
  const name = required(b.name, "name");
  if (!isFeature(b.feature)) throw new HttpError(400, "feature is not a build feature");
  if (typeof b.on !== "boolean") throw new HttpError(400, "on must be true or false");
  await switchFeature(db, req, b.feature, b.on, name);
  return await oneRepo(db, req, name);
}

export async function pipelineSwitch(db: Db, req: Req, on: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  if (!await maySwitch(req, name)) throw new HttpError(403, "only an operator, or a maintainer with write access to the repo, switches its pipeline");
  const changed = await refused(async () => {
    try {
      return (await setPipelineFlags(db, [{ repo: name, on }], req.user.login)).changed.length > 0;
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `the pipeline is already ${on ? "on" : "off"} for ${name}`);
  return await oneRepo(db, req, name);
}

export async function track(db: Db, req: Req, on: boolean): Promise<TrackedRepo[]> {
  requireOperator(req, "manage tracked repos");
  const name = required(body(req).name, "name");
  const changed = await refusedAsync(async () => (on ? trackRepoChecked : untrackRepo)(db, req.user.login, name));
  if (!changed) throw new HttpError(409, `${name} is ${on ? "already" : "not"} tracked`);
  clearContributorCache(db);
  return await allRepos(db, req);
}

// ---- access, sessions, audit -----------------------------------------------

export async function accessOverview(db: Db, req: Req): Promise<AccessOverview> {
  requireOperator(req, "manage access");
  const nowMs = Date.now();
  const sessions = await listSessions(db, nowMs);
  const perLogin = new Map<string, number>();
  for (const s of sessions) perLogin.set(s.login.toLowerCase(), (perLogin.get(s.login.toLowerCase()) ?? 0) + 1);
  return {
    entries: (await listAccess(db)).map((r) => ({
      login: r.login, role: r.role, addedBy: r.added_by, addedAt: r.added_at, note: r.note, sessions: perLogin.get(r.login.toLowerCase()) ?? 0,
    })),
    sessions: sessions.map((s) => ({
      id: s.rowid, login: s.login, createdAt: s.created_at, lastSeen: s.last_seen, expiresAt: s.expires_at,
      userAgent: s.user_agent ? s.user_agent.slice(0, 200) : null, current: s.csrf === req.csrf,
    })),
    tokens: await listAllTokens(db),
  };
}

const roleOf = (v: unknown) => {
  if (!isRole(v)) throw new HttpError(400, `role must be ${ROLES.join(", ")}`);
  return v;
};

/** The numeric GitHub id of a login: null when GitHub has no such user; throws when GitHub can't be reached. */
export type GithubUserLookup = (login: string) => Promise<number | null>;

export async function accessAdd(db: Db, req: Req, lookup: GithubUserLookup): Promise<AccessOverview> {
  requireOperator(req, "manage access");
  const b = body(req);
  const login = required(b.login, "login");
  const role = roleOf(b.role);
  const note = text(b.note, ACCESS_NOTE_MAX, "note");
  // Validates and rejects duplicates before GitHub is asked.
  await refused(async () => {
    if (!LOGIN.test(login)) throw new AccessError(`not a GitHub login: ${JSON.stringify(login)}`);
    if (await getAccess(db, login)) throw new AccessError(`${login} is already on the access list`);
  });
  let id: number | null;
  try {
    id = await lookup(login);
  } catch {
    throw new HttpError(502, "GitHub could not be reached to look up that login. Try again.");
  }
  if (id === null) throw new HttpError(400, `${login} is not a GitHub user`);
  await refused(async () => await addLogin(db, req.user.login, login, role, note, id));
  return await accessOverview(db, req);
}

export async function accessRemove(db: Db, req: Req): Promise<AccessOverview> {
  requireOperator(req, "manage access");
  await refused(async () => await removeLogin(db, req.user.login, required(body(req).login, "login"), { keepOperator: true }));
  return await accessOverview(db, req);
}

export async function accessRole(db: Db, req: Req): Promise<AccessOverview> {
  requireOperator(req, "manage access");
  const b = body(req);
  const login = required(b.login, "login");
  const changed = await refused(async () => await setRole(db, req.user.login, login, roleOf(b.role), { keepOperator: true }));
  if (!changed) throw new HttpError(409, `${login} already has that role`);
  return await accessOverview(db, req);
}

export async function revokeSession(db: Db, req: Req): Promise<AccessOverview> {
  requireOperator(req, "manage access");
  const id = body(req).id;
  if (!Number.isInteger(id)) throw new HttpError(400, "id must be a session id");
  const s = await endSessionById(db, id as number);
  if (!s) throw new HttpError(404, "that session has already ended");
  // Revoking a session cuts off the login's agent tokens too: they act with that login's permissions.
  const mcpTokens = await endTokens(db, s.login);
  // ...and the GitHub App token this session signed in with, but not the login's authorization: its other sign-ins keep working.
  const userTokens = await dropSessionTokens(db, s.login, s.idHash, s.sealed);
  await audit(db, req.user.login, "session-revoke", s.login, { created_at: s.createdAt, ...(mcpTokens ? { mcpTokens } : {}), ...(userTokens ? { userTokens } : {}) });
  return await accessOverview(db, req);
}

export async function revokeAgentToken(db: Db, req: Req): Promise<AccessOverview> {
  requireOperator(req, "manage access");
  const id = body(req).id;
  if (!Number.isInteger(id)) throw new HttpError(400, "id must be a token id");
  const gone = await revokeAnyToken(db, id as number);
  if (!gone) throw new HttpError(404, "that token has already ended");
  await audit(db, req.user.login, gone.kind === "runner" ? "runner-revoke" : "mcp-token-revoke", gone.login, { id, kind: gone.kind });
  return await accessOverview(db, req);
}

export async function auditLog(db: Db, req: Req): Promise<AuditPage> {
  if (!canSeeInternals(req)) throw new HttpError(403, "only operators and maintainers read the audit log");
  const q = req.query;
  const login = (q.get("login") ?? "").trim().slice(0, 100);
  const action = q.get("action") ?? "";
  const operator = isOperator(req);
  // Maintainers see only listed actions that are not operator-only; an action nobody listed stays hidden.
  const actions = operator ? AUDIT_ACTIONS : AUDIT_ACTIONS.filter((a) => !operatorOnly(a));
  if (action && !actions.includes(action)) throw new HttpError(400, "unknown action");
  const limit = int(q.get("limit"), AUDIT_PAGE, 1, 500, "limit");
  const offset = int(q.get("offset"), 0, 0, 1e9, "offset");
  // Security rows name their repo first in the target (`<repo>:scan:<id>`, `<repo>:finding:<n>`); a maintainer sees those of repos they can see.
  // Every other row that names a repo in its target is left out for a maintainer who cannot see the repo.
  const [visible, hidden] = operator ? [[], []] : await Promise.all([visibleRepos(db, req), hiddenRepos(db, req)]);
  const { total, rows } = await listAuditPage(db, { login: login || undefined, action: action || undefined, limit, offset, ...(operator ? {} : { visible, hidden: [...hidden], actions }) });
  const entries: AuditEntry[] = rows.map((r) => ({ at: r.at, login: r.login, action: r.action, target: r.target, details: r.details }));
  return { entries, total, actions };
}

// An operator, or a maintainer with write access to the repo, sets the checks whose failure does not stop a merge.
export async function optionalCheck(db: Db, req: Req, on: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  await requireRunRepo(req, name);
  const check = required(body(req).check, "check");
  const changed = await refused(async () => {
    try {
      return await setOptionalCheck(db, req.user.login, name, check, on);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${check} is ${on ? "already" : "not"} an optional check of ${name}`);
  return await oneRepo(db, req, name);
}

// An operator, or a maintainer with write access to the repo, switches the PR status comment on or off for a repo.
export async function statusApproval(db: Db, req: Req, approved: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  await requireRunRepo(req, name);
  const changed = await refused(async () => {
    try {
      return await setStatusApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `PR status comments are already ${approved ? "on" : "off"} for ${name}`);
  return await oneRepo(db, req, name);
}

// An operator, or a maintainer with write access to the repo, lets the pipeline act on a red default branch in a repo: rerun failed jobs, and open an issue on an operator's answer.
export async function mainFixApproval(db: Db, req: Req, approved: boolean): Promise<TrackedRepo> {
  const name = required(body(req).name, "name");
  await requireRunRepo(req, name);
  const changed = await refused(async () => {
    try {
      return await setMainFixApproval(db, req.user.login, name, approved);
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
  });
  if (!changed) throw new HttpError(409, `${name} is ${approved ? "already" : "not"} approved for fixing a red main`);
  return await oneRepo(db, req, name);
}
