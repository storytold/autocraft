// Wire types for the dashboard API. They mirror the server's tables
// (docs/dashboard-spec.md, Data) in camelCase.

import type { UserSettings, UserSettingsReply } from "../../../src/remote/protocol.ts";
import type { StepValue } from "../../../src/core/item-query.ts";
export type RepoName = string;

export interface ItemRef {
  repo: RepoName;
  number: number;
}

export type ItemKind = "pr" | "issue";

/** What an item reference shows next to `repo#number`; null when the item is not in the mirror. */
export interface ItemShown {
  kind: ItemKind | null;
  state: ItemState | null;
  title: string | null;
}

export type Relation = "duplicate-of" | "duplicated-by" | "links" | "overlaps" | "fixes";

export interface RelatedItem extends ItemRef {
  relation: Relation;
  title: string;
  state: ItemState;
  kind: ItemKind;
}

export type Classifier = "haiku" | "jev" | "sonnet" | "owner";
export type TypeLabel = "bugfix" | "performance" | "missing feature" | "small extra" | "plugin candidate" | "infra";
export type Want = "yes" | "no" | "unclear";

export interface Classification {
  classifier: Classifier;
  at: string;
  typeLabel: TypeLabel;
  want: Want;
  reference: string | null;
  reason: string;
  dupOf: number | null;
}

export type ItemState = "open" | "merged" | "closed";
export type CiState = "passing" | "failing" | "pending" | "none";
export type Mergeable = "clean" | "conflicts" | "unknown";
export type Tier = "whitelisted" | "not" | "override-allow" | "override-deny";
export type Stage =
  | "classified"
  | "labeled"
  | "reviewed"
  | "take"
  | "hold"
  | "close"
  | "needs-decision"
  | "batched"
  | "merged"
  | "closed"
  | "fixed-by-us"
  | "verify-planned"
  | "verify-ci-enough"
  | "verify-error"
  | "verify-unavailable"
  | "verified"
  | "verify-failed";

export interface StageEntry {
  stage: Stage;
  at: string;
  by: string;
  note: string | null;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

/** A GitHub comment or review on an item, from the mirror. Untrusted text: render as Markdown, never as HTML. */
export interface ItemComment {
  id: string;
  author: string;
  /** Null when the mirror has no creation time for it. */
  at: string | null;
  body: string;
  /** Null when the mirror did not record the kind. */
  kind: "comment" | "review" | null;
  /** reviews: APPROVED | CHANGES_REQUESTED | COMMENTED */
  reviewState: string | null;
}

/** Priority level, P0 (critical) to P4 (backlog). */
export type PriorityLevel = "P0" | "P1" | "P2" | "P3" | "P4";

/** Priority level of an item (src/priority). `model`: jev, haiku or jev-unsure. */
export interface PriorityInfo {
  level: PriorityLevel;
  model: string;
  reason: string | null;
}

export interface Item extends ItemRef {
  kind: ItemKind;
  title: string;
  body: string;
  state: ItemState;
  author: string;
  tier: Tier;
  authorMerged: number;
  authorClosedUnmerged: number;
  additions: number;
  deletions: number;
  /** PRs: how many files the PR changes, from the mirror; null when unknown. */
  changedFiles: number | null;
  /** Per-file changes; read per head by the activity sync; empty until it has read the PR (at most 100 files). */
  files: ChangedFile[];
  /** "none" also when the mirror has no check data for the item. */
  ci: CiState;
  ciChecks: { name: string; state: CiState; minutes: number | null }[];
  mergeable: Mergeable;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergedBy: string | null;
  /** Whether the repo's pipeline is switched on; absent in mocks that do not say. */
  pipelineOn?: boolean;
  related: RelatedItem[];
  classifications: Classification[];
  /** The item's area; null when it has none, absent in mocks. */
  area?: string | null;
  stages: StageEntry[];
  comments: ItemComment[];
  /** Explicit mentions in watched Discord channels; absent in mocks that have none. */
  discord?: DiscordInfo;
  /** For the latest classification run. */
  settled: Settled;
  /** PRs: the Verify stage's result for the newest head it looked at; null when none. */
  verification: ItemVerification | null;
  /** PRs: our own build of the newest head; null when the pr-builds switch is off or there is none. Absent in mocks without one. */
  prBuild?: ItemPrBuild | null;
  /** PRs: the Fix-up step's tries, oldest first. */
  fixups: ItemFixup[];
  /** PRs the pipeline merged: the post-merge review; null or absent when there is none. */
  postmerge?: ItemPostmerge | null;
  /** AutoCraft merged it as a person approved it, so there is no post-merge review to come. */
  mergedAsApproved?: boolean;
  /** PRs: the pre-merge review of every reviewed head, newest first; absent in mocks without one. */
  premerge?: ItemPremerge[];
  /** Opus checks of the patches we wrote for this item (Fix-up, Fix), oldest first. */
  patchChecks?: ItemPatchCheck[];
  /** PRs: the Opus review of the newest reviewed head, and the verdict later stages use; null before the first review. */
  reviews: ItemReviews | null;
  /** The Act step's GitHub writes after an operator's answer, oldest first. */
  /** Releases an operator can use on this item now (the item waits for a person). */
  releases: ItemReleases;
  /** null or absent before the item was rated. */
  priority?: PriorityInfo | null;
  /** Place in line for the item's next queued stage; null or absent when not queued. */
  queue?: QueueSlot | null;
  /** PRs: the newest pre-approved merge ("Fix-up for … then merge"); null or absent when there is none. */
  preapproval?: Preapproval | null;
}

/**
 * A merge approval given ahead of a fix-up: the fix-up runs with the approver's instructions, a fresh review and CI
 * follow, and the PR goes to the merge queue only if the review says take and CI is green. Any other outcome comes back with a recommendation.
 * States: "fixup" (fix-up running or queued), "review" (waiting for the review of the fix-up's head), "ci" (review take, waiting for CI),
 * "queued" (in the merge queue), "merged", "asked" (review or CI did not pass: a new question was asked), "cancelled" (someone else
 * pushed, the PR closed, or an operator cancelled), "failed" (the fix-up could not push).
 */
export interface Preapproval {
  id: number;
  by: string;
  at: string;
  instructions: string;
  state: "fixup" | "review" | "ci" | "queued" | "merged" | "asked" | "cancelled" | "failed";
  /** The head the fix-up started from, and the head it pushed (null until it pushed). */
  fromHead: string;
  head: string | null;
  /** Why it ended in asked, cancelled or failed, one plain sentence. */
  reason: string | null;
  updatedAt: string;
}

export type VerificationKind = "ci-enough" | "tests" | "regression" | "error" | "unavailable";
export type VerificationState = "planned" | "running" | "passed" | "failed" | "error" | "ci-enough" | "stale" | "unavailable";
export interface ItemVerification {
  headSha: string;
  baseSha: string | null;
  /** False when the PR has a newer head than the one verified. */
  current: boolean;
  kind: VerificationKind;
  reason: string;
  /** Crates and test filters (kind tests), or the crate and size of the added regression test. */
  plan: { crates: string[]; tests: string[]; testLines: number | null } | null;
  state: VerificationState;
  summary: string | null;
  note: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Head task first, then the base task of a regression. */
  tasks: { id: number; role: "head" | "base"; state: TaskState; results: TaskResult[]; endedAt: string | null }[];
}

/** Our own workspace build of a PR head: a second opinion beside upstream CI, never a merge gate. `disagree`: it failed while CI passed at the same head. */
export interface ItemPrBuild {
  headSha: string;
  /** False when the PR has a newer head than the one built. */
  current: boolean;
  state: "queued" | "running" | "passed" | "failed" | "error" | "stale";
  /** The failing step and exit code, or the error; null for viewers and for a pass. */
  summary: string | null;
  disagree: boolean;
  ci: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type ReviewVerdictName = "take" | "take-fix" | "hold" | "close";

/** One reviewer's verdict on a head commit. */
export interface ReviewSide {
  verdict: ReviewVerdictName;
  reason: string;
  fixes: { file: string; change: string }[];
  risks: string[];
  at: string;
}

/**
 * The Opus review of a PR head. `opus` is null while the head has not been reviewed. `final` is the verdict every
 * later stage reads: Opus's. An unsure take or take-fix stays take or take-fix and never merges without an operator's answer.
 */
export interface ItemReviews {
  head: string;
  /** The head is the PR's current head. */
  current: boolean;
  opus: (ReviewSide & { sure: boolean; mode: "full" | "delta"; baseHead: string | null }) | null;
  final: { verdict: ReviewVerdictName; reason: string; decided: boolean };
  /** Earlier owner statements that the Opus or the pre-merge review at this head says the PR goes against. Such a PR is never merged without an operator's answer. */
  conflicts: {
    id: number; repo: RepoName; number: number | null; kind: ItemKind | null; state: ItemState | null;
    /** Title of the item the statement was said about; null when unknown. */
    title: string | null;
    /** The start of what was said. */
    excerpt: string;
    reason: string;
  }[];
}

export type PostmergeSeverity = "defect" | "minor";

/** What became of one finding: filed as an issue, or why it was not. */
export type PostmergeFiling =
  | { state: "filed"; issue: { number: number; url: string | null; state: ItemState | null; title: string | null } }
  | { state: "duplicate"; duplicateOf: number }
  | { state: "limit" }
  | { state: "minor" }
  | { state: "pending" }
  /** `gh issue create` was started and its answer is not recorded: the issue may exist. */
  | { state: "unknown" }
  | { state: "failed"; attempts: number }
  /** The file the finding cites is no longer on the default branch. */
  | { state: "stale" }
  /** The text names the product or the pipeline's account. */
  | { state: "refused" }
  /** Never filed automatically: `earlier` follow-ups of the PR exist, or `fix`: the PR itself fixes a follow-up issue. */
  | { state: "held"; reason: "earlier" | "fix" };

/** A follow-up issue filed for the PR by an earlier review of it. */
export type PostmergeEarlier =
  | { state: "filed"; title: string; issue: { number: number; url: string | null; state: ItemState | null; title: string | null } }
  | { state: "unknown"; title: string };

export interface PostmergeFinding {
  severity: PostmergeSeverity;
  title: string;
  /** Markdown, written for the public issue. */
  body: string;
  file: string | null;
  line: number | null;
  filing: PostmergeFiling;
  /** Internal notes: the stage that should have caught it and why it did not. Present only for operators and maintainers. */
  missedBy?: string | null;
  missedWhy?: string | null;
}

/** The post-merge review of a PR the pipeline merged. */
export interface ItemPostmerge {
  at: string;
  model: string | null;
  /** The commit the review read. */
  mergeSha: string;
  /** Why there is no review yet (for example too large to review); null when there is one. */
  error: string | null;
  findings: PostmergeFinding[];
  /** Follow-ups of earlier reviews of the PR. */
  earlier: PostmergeEarlier[];
}

/** One finding of the pre-merge review. */
export interface PremergeFinding {
  severity: "defect" | "minor";
  file: string;
  line: number;
  title: string;
  /** The input and the wrong result it leads to. */
  scenario: string;
  fix?: { file: string; change: string };
}

/** The pre-merge review of one PR head. */
export interface ItemPremerge {
  head: string;
  at: string;
  model: string | null;
  findings: PremergeFinding[];
  searched: string | null;
  /** Why the last try stored no review; null once a review is stored. */
  error: string | null;
  tries: number;
}

export type FixupState = "pushed" | "failed" | "refused" | "cannot-push" | "too-large" | "asked" | "rejected" | "push-denied" | "superseded" | "infra" | "rerun" | "rerunning" | "formatting" | "pushing" | "skipped" | "capped" | "comment-failed" | "comment-unsent" | "unread";

/** Operator releases that apply to an item right now. */
export interface ItemReleases {
  /** A hold review at the current head can be cleared so the head is reviewed again. */
  reviewAgain: boolean;
  /** A failed or errored verification at the current head can be planned again. */
  verifyAgain: boolean;
  /** A skipped or failed fix attempt can be tried again. */
  /** A PR held by a failed single-PR batch at its current head can go through a batch again. */
  batchAgain: boolean;
}

export interface ItemPatchCheck {
  kind: "fixup" | "fixissue";
  /** The commit the patch applies to. */
  subject: string;
  patchHash: string;
  round: number;
  verdict: "approve" | "reject";
  reasons: string;
  problems: string[];
  model: string;
  createdAt: string;
}

export interface ItemFixup {
  /** ci-fix: a try of the CI fix kind (the head is the one whose check failed); absent for a review fix-up. */
  kind?: "ci-fix";
  fromHead: string;
  toHead: string | null;
  state: FixupState;
  reason: string | null;
  files: string[];
  attempt: number;
  createdAt: string;
}

/**
 * Settled type label for one classification run: Jev's label when its top
 * probability is at least 0.9, else Haiku's when Haiku agrees with Jev.
 * `waiting`: Jev unsure, Haiku hasn't answered; `disagree`: Haiku gave another label and the Sonnet referee is unsure or has not answered yet; a referee that is sure settles it.
 */
export type SettledStatus = "settled" | "waiting" | "disagree" | "unclassified";

export interface Settled {
  status: SettledStatus;
  /** Set only when `status` is `settled`. */
  label: TypeLabel | null;
  source: "jev" | "haiku" | "sonnet" | null;
  /** Jev's top probability. */
  confidence: number | null;
  jevLabel: TypeLabel | null;
  haikuLabel: TypeLabel | null;
  /** Jev's flags when Jev is sure, otherwise every flag either classifier raised. */
  flags: string[];
  /** The Sonnet referee's answer to a Jev/Haiku disagreement; settles the item when `sure`, else a person decides. */
  referee: { label: TypeLabel; sure: boolean; reason: string } | null;
}

export interface SearchHit extends ItemRef {
  kind: ItemKind;
  title: string;
  author: string;
  state: ItemState;
}

export interface Done {
  mergedByPipeline: number;
  closedByPipeline: number;
  closedByOthers: number;
}

export interface Funnel {
  open: number;
  /** Settled type label (see `Settled`). */
  classified: number;
  /** Jev unsure, Haiku hasn't answered yet. */
  secondOpinion: number;
  /** Jev unsure and Haiku gave another label. */
  disagreement: number;
  reviewed: number;
  take: number;
  hold: number;
  close: number;
  waiting: number;
  batched: number;
}

export interface RepoProgress {
  repo: RepoName;
  funnel: Funnel;
  done: Done;
  /** open items at the end of each day since tracking began */
  openTrend: number[];
}

export interface Progress {
  /** When tracking began; done counts and trends start here. */
  trackingSince: string;
  now: string;
  funnel: Funnel;
  done: Done;
  /** items closed or merged per hour by anyone, oldest first, last 24 h */
  perHour: number[];
  /** the same, by the pipeline only */
  perHourPipeline: number[];
  repos: RepoProgress[];
  /** Repos per CI state of the default branch; the top bar shows it. */
  mainCi: MainCiSummary;
}

/** CI on a repo's default branch: red = a gate check failed; optional = only optional checks failed; none = no checks. */
export type MainCiState = "green" | "red" | "optional" | "running" | "none";
export type MainCiSummary = Record<MainCiState, number>;
export interface MainCiRepo {
  repo: RepoName;
  /** What the branch counts as: red also while the newest head's checks run after a red head. */
  state: MainCiState;
  /** The newest head's own state. */
  headState: MainCiState;
  branch: string;
  headSha: string;
  headline: string | null;
  committedAt: string | null;
  /** The checks that failed at the head `state` comes from; url is the run's page. */
  failing: { name: string; url: string | null }[];
  /** When the culprit head turned red; null unless the branch is red. */
  redSince: string | null;
  lastGreenSha: string | null;
  /** The first red head after the last green one, with the PR its message names. */
  culprit: { sha: string; headline: string | null; pr: number | null } | null;
  updatedAt: string;
  /** What AutoCraft is doing about the red head ("rerunning failed jobs", "asked an operator", "needs a fix", ...); null when nothing. */
  autocraft: string | null;
}
/** GET /api/main-ci: red first, then optional, running, none, green; each group by name. */
export interface MainCi {
  summary: MainCiSummary;
  repos: MainCiRepo[];
}

export type Role = "operator" | "maintainer" | "viewer";

export interface User {
  login: string;
  role: Role;
  /** repos where GitHub grants write, maintain or admin */
  writeRepos: RepoName[];
  /** repos the user runs: an operator on every repo, a maintainer where GitHub grants write; per-repo and per-item actions (commands, hold, releases, areas) show for these */
  runRepos: RepoName[];
}
export type InferenceTier = "top" | "mid" | "small";
export type InferenceEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type InferenceSettings = { /** Accepted model families per tier. */ models: Record<InferenceTier, string[]>; /** The lowest effort a helper may declare per tier; a tier without one takes any. */ minEffort: Partial<Record<InferenceTier, InferenceEffort>> };

// ---- Contributors, Repos and Access (docs/dashboard-spec.md, Pages) ----

export type OverrideStatus = "allow" | "deny";

export interface WhitelistRule {
  minMerged: number;
  /** 0 to 1 */
  minRate: number;
}

export interface Contributor {
  login: string;
  /** Effective status: an override wins over the automatic tier. */
  tier: Tier;
  /** From merge history under the current rule, ignoring any override. */
  autoTier: "whitelisted" | "not";
  override: OverrideStatus | null;
  /** False for an allow given to another GitHub account than the one the login is bound to now (or to no recorded account). */
  overrideInEffect: boolean;
  /** Operators only; absent for everyone else. */
  overrideNote?: string | null;
  overrideBy: string | null;
  overrideAt: string | null;
  merged: number;
  closedUnmerged: number;
  open: number;
  /** merged / (merged + closed unmerged); null with no finished PRs */
  mergeRate: number | null;
  lastMerge: string | null;
  repos: RepoName[];
}

export type ContributorSort = "login" | "tier" | "merged" | "closed" | "open" | "rate" | "last" | "repos";

export interface ContributorFilter {
  /** part of the login */
  q?: string;
  tier?: Tier;
  repo?: RepoName;
  sort?: ContributorSort;
  desc?: boolean;
  /** page size (server default 50, at most 500) and offset */
  limit?: number;
  offset?: number;
}

export interface ContributorList {
  rule: WhitelistRule;
  /** rows matching every filter */
  total: number;
  /** authors matching `q` and `repo`, per effective tier (before the tier filter) */
  byTier: Record<Tier, number>;
  contributors: Contributor[];
}

/** What a whitelist rule would do, before it is saved. Counts are of every author. */
export interface RulePreview {
  rule: WhitelistRule;
  authors: number;
  /** allowed under the current rule: whitelisted by the rule or by an allow override */
  allowedNow: number;
  allowedAfter: number;
  /** status changes; overrides never change; at most 20 logins each, most merged first */
  gained: { count: number; logins: string[] };
  lost: { count: number; logins: string[] };
}

export interface OverrideInput {
  /** null clears the override */
  status: OverrideStatus | null;
  /** private note, at most 300 characters */
  note?: string;
}

/** The Label stage for one repo: approval and what the plan holds. */
export interface RepoApproval {
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface RepoLabels {
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  /** open items that would get labels */
  toAdd: number;
  /** open items with nothing to add: already labelled or not settled */
  skipped: number;
  /** open items with a different type label set by a person */
  conflicts: number;
}

export interface TrackedRepo {
  name: RepoName;
  /** GitHub org or user that owns the repo */
  owner: string;
  tracked: boolean;
  openPrs: number | null;
  openIssues: number | null;
  /** issue and PR rows in the mirror */
  mirrored: number;
  syncedAt: string | null;
  /** null for repos that are not tracked */
  labels: RepoLabels | null;
  /** Whether the pipeline may merge pull requests here; null for repos that are not tracked */
  merging: RepoApproval | null;
  /** Whether the Fix-up step may push to contributor branches here; null for repos that are not tracked */
  pushing: RepoApproval | null;
  /** Whether the Act step may comment on and close items here; null for repos that are not tracked */
  commenting: RepoApproval | null;
  /** Fix issues: pushes to the pipeline's fork and opens PRs and comments for issue fixes. */
  fixing: RepoApproval | null;
  /** Fix red main: reruns flaky failed jobs on a red default branch and opens an issue on an operator's answer. */
  mainFixing: RepoApproval | null;
  /** CI runs: approves the runs GitHub holds for reviewed outside pull requests. */
  ciApproving: RepoApproval | null;
  /** PR status comments: one status comment per pull request, edited in place. */
  statusComments: RepoApproval | null;
  /** Checks whose failure does not stop a merge or turn main red; set by operators. Empty for repos that are not tracked. */
  optionalChecks: string[];
  /** Check names seen on the repo's recent PRs and default-branch heads. */
  seenChecks: string[];
  /** Whether the pipeline stages run on this repo; off means sync only. False for repos that are not tracked. */
  pipeline: boolean;
  /** Whether the viewer may switch this repo's pipeline: an operator, or a maintainer with write access to the repo. */
  canSwitch: boolean;
  /** The caller may change the repo's GitHub-write approvals, optional checks and build features (the same rule as canSwitch). */
  canManage: boolean;
  /** The build features shown for the repo, each with its switch; empty for repos that are not tracked. */
  buildFeatures: RepoBuildFeature[];
}

export type RepoBuildFeature = { feature: BuildFeatureName; on: boolean };

export interface AccessEntry {
  login: string;
  role: Role;
  addedBy: string | null;
  addedAt: string | null;
  note: string | null;
  /** active sessions */
  sessions: number;
}

export interface SessionInfo {
  id: number;
  login: string;
  createdAt: string;
  lastSeen: string;
  expiresAt: string;
  userAgent: string | null;
  /** the session making this request */
  current: boolean;
}

/** Messages that name the item. Links need the server's key file; the count does not. */
export interface DiscordInfo {
  count: number;
  links: { url: string; at: string }[];
  /** Messages that asked for attention on the item; the links are the same messages, newest first. */
  signals?: number;
  signalLinks?: { url: string; at: string }[];
}

export interface DiscordChannel {
  channelId: string;
  guildId: string;
  guildName: string | null;
  name: string | null;
  watched: boolean;
  /** Tracked repo whose new-issue page the bot's "File a new issue" button opens; null uses the top search result's repo. */
  defaultRepo: string | null;
  /** Name of the category the channel sits in; null when it has none. The list arrives in Discord's sidebar order. */
  category: string | null;
}

/** The answer to adding a filing-only repo: the setup, and how the bot files into the repo just added. */
export type DiscordFilingAdded = DiscordSetup & { added: { owner: string; name: string; mode: "submit" | "link"; why: string | null } };

export interface DiscordSetup {
  /** `off` while the runner has not started the gateway client (no token file). */
  state: "off" | "connecting" | "connected" | "reconnecting" | "failed";
  detail: string | null;
  at: string | null;
  channels: DiscordChannel[];
  /** Tracked repos a channel's default can be. */
  repos: string[];
  /** Public repos of any owner the bot offers without tracking them. `mode`: "submit" when the GitHub App covers the repo (Submit for me), else "link" (only the GitHub link), with `why`. */
  filingRepos: { owner: string; name: string; addedBy: string; addedAt: string; mode: "submit" | "link"; why: string | null }[];
  /** Every public tracked repo with whether the bot offers it in its repo select; `used` of `max` places are filled (offered repos plus filing-only ones). */
  offer: { repos: { name: string; label: string; offered: boolean }[]; used: number; max: number };
  contact: string;
  /** Whether the bot adds a reaction to messages it recorded against items. */
  reactOn: boolean;
  /** A custom emoji name (resolved per server) or one Unicode emoji. */
  reactEmoji: string;
  /** The public privacy page. */
  privacyPath: string;
  /** Linked Discord accounts: the opaque row id, the dashboard login and when. */
  links: { id: string; login: string; linkedAt: string }[];
  usage: DiscordUsage;
  rolePanel: DiscordRolePanel;
}

/** The contributor role panel: the channel its Verify button is posted in and the role it gives (null when off). `posted` is what the runner last did there. */
export interface DiscordRolePanel {
  channelId: string | null;
  roleId: string | null;
  guildId: string | null;
  posted: { messageId: string | null; error: string | null; at: string } | null;
}

/** What the public issue bot did, for the Discord page. */
export interface DiscordUsage {
  /** Events over the last 24 hours and 7 days: reports started, refused as junk, filed by the bot, sent to GitHub after the bot refused, offered only the link by the filing limits. */
  counts: Record<"started" | "junk" | "filed" | "link" | "limits", { day: number; week: number }>;
  /** Model calls and cost of each discord.* prompt. */
  prompts: { prompt: string; day: { calls: number; usd: number }; week: { calls: number; usd: number } }[];
  /** Issues filed from Discord in the last 24 hours, newest first. `githubUrl`: the issue on GitHub for a filing-only repo (no item page); null for a tracked repo. */
  filed: { repo: string; number: number; login: string; at: string; githubUrl: string | null }[];
  /** Whether a Task Runner takes Discord calls now, and why not; null when Discord calls do not use Task Runners. */
  capacity: { ready: boolean; why: string | null } | null;
}

/** A single-use code to type into the bot in Discord, and when it stops working. */
export interface DiscordLinkCode {
  code: string;
  expiresAt: string;
}

/** Whether the signed-in user has linked a Discord account. */
export interface DiscordAccount {
  linked: boolean;
  at: string | null;
  /** False when the server cannot make link codes, so the menu hides "Link Discord". */
  configured: boolean;
}

/** A live agent token of any login (operators see all of them). */
export type AccessToken = McpToken & { login: string };
export interface GithubAppStatus {
  /** The app's keys are stored and readable. */
  configured: boolean;
  /** The instance-wide GitHub identity: the box account, or the GitHub App (writes and dashboard sign-in). */
  identity: "box" | "app";
  /** False when the server has nowhere to keep the keys. */
  canRegister: boolean;
  /** Stored keys exist that this process cannot open (sealed with another session_key); registering needs the replace confirmation. */
  keysUnreadable: boolean;
  defaultName: string;
  /** The session's CSRF token, for the registration form. */
  csrf: string;
  /** The signed-in operator has let the app act as them; null when no app is registered. */
  authorized: boolean | null;
  app: { id: string; slug: string; mention: string | null; name: string | null; installUrl: string; transferUrl: string } | null;
  /** Each account the app is installed on, with the repos it covers; `allowed`: the account is on the allowed owners list; `protected`: it owns a tracked or filing-only repo or the app, so its installation is never removed. */
  installations: { id: number; owner: string; type: "User" | "Organization" | null; selection: "all" | "selected"; repos: string[]; createdAt: string | null; allowed: boolean; protected: boolean }[];
  /** Accounts the app may be installed on; empty: any account, nothing is removed. `kept`: why the account cannot be taken off the list. */
  allowedOwners: { login: string; addedBy: string; addedAt: string; kept: string | null }[];
  /** Org setup links that can still be used. */
  links: GithubSetupLink[];
  /** Set when GitHub could not be read. */
  error: string | null;
}

/** A one-time link for an organization's owner to set the app up; the link's URL is shown once, when it is created. */
export interface GithubSetupLink {
  id: string;
  org: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface AccessOverview {
  entries: AccessEntry[];
  sessions: SessionInfo[];
  tokens: AccessToken[];
}

export interface AuditEntry {
  at: string;
  login: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export interface AuditFilter {
  /** the actor or the target */
  login?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

// ---- classifiers ----------------------------------------------------------

/** One run in which at least two classifiers judged the same items. */
export interface ClassifierRun {
  id: string;
  at: string;
  /** Pairs with items in both, `a` being the one with probabilities when only one has them. */
  pairs: { a: string; b: string; items: number }[];
}

export interface Agreement {
  n: number;
  agree: number;
}

export interface ConfidenceBand {
  /** Label such as "≥0.99" or "0.95–0.99". */
  band: string;
  n: number;
  agree: number;
  /** Items at or above this band's lower bound, and those that agree. */
  cumN: number;
  cumAgree: number;
}

export interface FlagAgreement {
  flag: string;
  n: number;
  agree: number;
  both: number;
  onlyA: number;
  onlyB: number;
}

export interface ClassifierReport {
  runs: ClassifierRun[];
  run: string;
  a: string;
  b: string;
  labels: string[];
  items: number;
  overall: Agreement;
  byKind: { pr: Agreement; issue: Agreement };
  /** Grouped by classifier `a`'s label. */
  byLabel: ({ label: string } & Agreement)[];
  byRepo: ({ repo: string } & Agreement)[];
  /** `confusion[i][j]`: `a` said labels[i], `b` said labels[j]. */
  confusion: number[][];
  /** Bands of classifier `a`'s top-label probability; empty when `a` recorded none. */
  bands: ConfidenceBand[];
  flags: FlagAgreement[];
}

export interface Disagreement {
  repo: string;
  number: number;
  kind: ItemKind;
  state: ItemState | null;
  title: string;
  a: { label: string | null; prob: number | null };
  b: { label: string | null; prob: number | null };
}

export interface DisagreementList {
  total: number;
  rows: Disagreement[];
}

export interface DisagreementFilter {
  run: string;
  a: string;
  b: string;
  /** Either classifier's label. */
  label?: string;
  /** A band label from `ClassifierReport.bands`. */
  band?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  /** every action the log knows, for the filter */
  actions: string[];
}

// ---- run and cost ---------------------------------------------------------

export interface UsageTotals {
  calls: number;
  items: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of the costs agents reported; null when none did. */
  usd: number | null;
  /** First start to last end, in seconds. */
  wallSeconds: number;
}

export interface CostReport {
  runs: { id: string; from: string; to: string }[];
  /** A run id, or "" for all runs. */
  run: string;
  total: UsageTotals;
  /** Distinct items with a classification in the run (or all runs); `total.items` counts an item once per model. */
  itemsClassified: number;
  stages: ({ stage: string; model: string } & UsageTotals)[];
  repos: ({ repo: string } & UsageTotals)[];
  /** Calls run by users' helpers, per user (user-local mode); `login` is null for calls on server accounts. */
  users: ({ login: string | null } & UsageTotals)[];
  /** Spend per time bucket; `bucket` is an ISO hour or day. */
  series: { bucket: string; tokens: number; usd: number | null }[];
  bucketSize: "hour" | "day";
}

// ---- pipeline (runner jobs, steps, the on/off switch and stage limits) ------------------------------

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

/** A step parameter. Only enums, tracked repos, bounded whole numbers and run ids: never free text. */
export type StepParam =
  | { name: string; label: string; help?: string; required: boolean; kind: "enum"; options: string[]; default?: string }
  | { name: string; label: string; help?: string; required: boolean; kind: "repo"; options: string[] }
  | { name: string; label: string; help?: string; required: boolean; kind: "int"; min: number; max: number; default?: number }
  | { name: string; label: string; help?: string; required: boolean; kind: "run-id"; default?: string };

export type JobParams = Record<string, string | number>;

export interface JobUsage {
  /** Model calls (token_usage rows) made by the job. */
  calls: number;
  input: number;
  output: number;
  /** Sum of reported costs; null when no call reported one. */
  costUsd: number | null;
}

export interface Job {
  id: number;
  step: string;
  params: JobParams;
  /** A login, `pipeline` (the autopilot) or `cli`. */
  requestedBy: string;
  requestedAt: string;
  state: JobState;
  startedAt: string | null;
  endedAt: string | null;
  progress: string | null;
  summary: string | null;
  error: string | null;
  cancelRequested: boolean;
  usage: JobUsage | null;
  /** Models the job's step uses, e.g. ["jev", "haiku"]; known before any call is made. */
  models: string[];
  /** Why the queued job does not start, e.g. "No Task Runner takes photocraft"; null otherwise. */
  waiting: string | null;
}

/** An item a job handled and what happened to it. */
export interface JobItem extends ItemRef, ItemShown {
  outcome: string | null;
}

export interface JobDetail extends Job {
  /** The caller may cancel the job: an operator, or a maintainer with write access to its repo. The server sets it per request. */
  canCancel: boolean;
  /** The items the job handled, in the order it handled them; hidden repos left out. */
  items: JobItem[];
  /** The end of the job's log, with anything token-like replaced; null for viewers. */
  log: string | null;
  logTruncated: boolean;
}

export interface JobList {
  jobs: Job[];
  total: number;
}

export interface JobFilter {
  step?: string;
  state?: JobState;
  limit?: number;
  offset?: number;
}

/**
 * A stage's circuit breaker that tripped: on one repo (the stage works no item there until an operator, or a maintainer with write
 * access to the repo, resumes it), or on every repo (`repo` null: broken pushes on several repos; an operator resumes it).
 */
export type StageTrip = { /** The breaker as resume takes it: `<stage>:<repo>` (implement:deckcraft), or `<stage>` for every repo. */ key: string; repo: RepoName | null; reason: string; since: string; /** Whether the viewer may resume it. */ canResume: boolean };
export type StageLimit = { step: string; title: string; perDay: number | null; usedToday: number; pausedReason: string | null;
  /** Where the step's push stage (fixup, cifix, implement, merge) tripped, oldest first: per repo (the step goes on for every other repo), or on every repo. */
  trips?: StageTrip[];
  /** What the stage is doing when nothing pauses it: "running", "queued", or why it is not starting ("nothing to do", "waiting for CI on 3 PRs in x"). */
  status?: string | null };
export type PipelineState = { enabled: boolean; /** Switched to drain: no new jobs, jobs already running keep their writes; shown as "Draining". Never true with enabled. */ draining: boolean; changedBy: string | null; changedAt: string | null; heartbeat: string | null; limits: StageLimit[]; outside: OutsideState };

export interface PipelineStep {
  name: string;
  title: string;
  description: string;
  stage: number;
  requires: "operator";
  params: StepParam[];
  /** null when the step can run; otherwise why not. */
  unavailable: string | null;
  lastJob: Job | null;
}

export interface PipelineStage {
  n: number;
  name: string;
  /** How the stage runs today. */
  mode: "automatic" | "steps" | "planned";
  steps: string[];
  state: "running" | "queued" | "ok" | "failed" | "idle" | "planned";
}

export interface SyncRun {
  startedAt: string;
  endedAt: string | null;
  mode: string | null;
  items: number | null;
  error: string | null;
}

export interface PipelineOverview {
  stages: PipelineStage[];
  steps: PipelineStep[];
  runner: { lastSeen: string | null; alive: boolean };
  sync: { lastFinishedAt: string | null; runs: SyncRun[] };
  counts: { queued: number; running: number };
}

// ---- prompts ----------------------------------------------------------------

/** One registered model prompt (src/prompts), as the Prompts page shows it. */
export interface PromptInfo {
  id: string;
  stage: string;
  purpose: string;
  /** The first is the default. */
  models: string[];
  runner: "claude" | "jev";
  /** The command line, as a shell would show it; the prompt or request goes on stdin. */
  command: string;
  settings: { label: string; value: string }[];
  /** Items per call, attempts per item and the time limit per call. */
  limits: { perCall: number; attempts: number; timeoutSeconds: number };
  /** Static text with `{{name}}` placeholders; for Jev, the request body. */
  template: string;
  /** Claude without tools: the fixed text sent as `--system-prompt`; null when the call keeps the CLI's own system prompt (sandboxed) or is a Jev request. */
  system: string | null;
  placeholders: { name: string; meaning: string }[];
  /** Jev only: every question with its type and criteria. */
  questions: { id: string; type: string; instructions: string; criteria: Record<string, string> | null }[];
  output: string;
  validation: string;
  /** Exactly what would be sent on stdin for `exampleItems` (made-up items). */
  example: string;
  exampleItems: string[];
}

export interface PromptsReport {
  /** Git commit the server runs, or null when unknown. */
  commit: string | null;
  prompts: PromptInfo[];
  /** Comments the pipeline posts on GitHub; fixed text, no model. */
  comments: CommentTemplate[];
}

export interface CommentTemplate {
  id: string;
  stage: string;
  purpose: string;
  /** The text with `{{name}}` placeholders. */
  text: string;
  placeholders: { name: string; meaning: string }[];
  /** The text for made-up values. */
  example: string;
}

// ---- merge queue ------------------------------------------------------------

/**
 * Where a taken PR stands in the merge queue:
 * ready (may merge by the rule now), decision-answered-merge (a person approved the merge),
 * refused (the merge command or a pre-merge check said no; tried again next run),
 * waiting-ci (CI pending or none, or GitHub still computing mergeability), ci-failed, conflict,
 * needs-fix-up (take-fix), waiting-premerge (rule-path PRs waiting for the pre-merge review), waiting-verify (no passed verification at the head yet), verify-failed, verify-error,
 * needs-decision (outside the rule and not approved: waits for a maintainer), merged, held-backlog (sent to the backlog),
 * batch-checking (in an integration batch whose combined tree is being checked), in-batch (the batch PR is open),
 * batch-failed (failed alone in a batch: on hold until a new head), changes-requested (a maintainer's
 * changes-requested review stands), waiting-main-ci (ready, but the repo's main CI is red; AutoCraft's main-fix PRs are not held).
 */
export type QueueState =
  | "ready"
  | "decision-answered-merge"
  | "refused"
  | "waiting-ci"
  | "ci-failed"
  | "conflict"
  | "needs-fix-up"
  | "waiting-premerge"
  | "waiting-verify"
  | "verify-failed"
  | "verify-error"
  | "needs-decision"
  | "merged"
  | "held-backlog"
  | "batch-checking"
  | "in-batch"
  | "batch-failed"
  | "ci-approval"
  | "changes-requested"
  | "waiting-main-ci";

/** An integration batch: PRs landed together through one integration branch and one PR. */
export type BatchState = "checking" | "open" | "merged" | "failed" | "split" | "superseded";

export interface QueueBatch {
  id: number;
  repo: RepoName;
  branch: string;
  /** `<owner>/<repo>` the branch was pushed to; null while the batch is being checked. */
  fork: string | null;
  state: BatchState;
  /** Default-branch commit the batch was built on. */
  baseSha: string;
  /** How many PRs the batch took; `prs` lists those still in the queue view. */
  size: number;
  /** The member PRs in batch order, as queue rows. */
  prs: QueueRow[];
  /** The members' areas, each once, in batch order; the first is the area the batch was filled around. Absent in older mocks. */
  areas?: string[];
  /** The batch's own PR on the storytold repo, once opened. */
  prNumber: number | null;
  prUrl: string | null;
  /** Why it failed or was replaced; the failure summary of a held PR. */
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a member PR did in its batch: `in` (still part of it, or carried to a later batch), `removed` (an operator took it out or stopped the batch), `merged`, `failed` (it failed alone and is on hold). */
export type BatchMemberState = "in" | "removed" | "merged" | "failed";

export interface BatchMemberDetail {
  repo: RepoName;
  number: number;
  /** Null when the mirror has no row for the PR. */
  title: string | null;
  /** The PR's own state on GitHub. */
  itemState: ItemState | null;
  headOid: string;
  state: BatchMemberState;
  /** Why it left (removed, failed); null for the other states. */
  reason: string | null;
}

export type BatchEventKind = "opened" | "task" | "push" | "pr" | "ci" | "removed" | "stopped" | "failed" | "split" | "superseded" | "merged";

/** One step of the batch's own history, from its row, its sandbox task and the audit log. `by` is the operator behind a control, shown to staff only. */
export interface BatchEvent {
  id: string;
  at: string;
  kind: BatchEventKind;
  summary: string;
  by: string | null;
  /** Another batch (parent or child) or the batch's sandbox task, when the event names one. */
  batchId?: number;
  taskId?: number;
  /** A member PR the event is about. */
  number?: number;
}

/** The batch PR's CI at its head: the checks sync's last read. */
export interface BatchCi {
  state: "success" | "failure" | "pending" | "none";
  fetchedAt: string;
  checks: { name: string; state: "success" | "failure" | "pending" | "skipped"; url: string }[];
}

export interface BatchDetail {
  id: number;
  repo: RepoName;
  branch: string;
  fork: string | null;
  state: BatchState;
  baseSha: string;
  /** Head of the integration branch. */
  commitSha: string;
  parentId: number | null;
  childIds: number[];
  prNumber: number | null;
  prUrl: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the batch PR landed; null unless merged. */
  mergedAt: string | null;
  taskId: number | null;
  /** Build batches: null when the batch was not built; skipped means the PR opened without a passed build. */
  buildState: "pending" | "passed" | "failed" | "skipped" | null;
  buildTries: number;
  /** Why the build was skipped; null otherwise. */
  buildSkipped: string | null;
  /** Merge commit of the batch PR; null until merged and for batches merged before it was recorded. */
  mergeSha: string | null;
  ci: BatchCi | null;
  members: BatchMemberDetail[];
  /** Oldest first. */
  events: BatchEvent[];
}

export interface QueueRow {
  repo: RepoName;
  number: number;
  title: string;
  author: string;
  tier: Tier;
  /** Head commit the review is for. */
  head: string;
  size: "S" | "M" | "L";
  label: TypeLabel | null;
  /** Null for a PR a maintainer put straight into the merge queue, which has no review. */
  verdict: "take" | "take-fix" | null;
  reason: string;
  fixes: number;
  /** CI at the reviewed head: success | failure | pending | none, or unknown before checks were fetched for it. */
  ci: "success" | "failure" | "pending" | "none" | "unknown";
  mergeable: Mergeable;
  state: QueueState;
  /** How it may merge: by the rule, by the operator's answer, on the approval of the maintainer who queued it, or not yet. */
  path: "rule" | "operator" | "maintainer" | null;
  /** Why the merge-without-asking rule doesn't cover it. */
  outsideRule: string[];
  refusedReason: string | null;
  /** Why a maintainer's review blocks the PR, or that its reviews cannot be read; null otherwise. */
  note: string | null;
  reviewedAt: string;
  /** The Verify stage's result at the reviewed head; null when none. `summary` is the failure or error text, or the plan's reason. */
  verify: { state: string; kind: string | null; summary: string | null; note: string | null } | null;
  /** For a conflicting PR: what Fix-up does about it, e.g. "conflict: merging main". */
  conflictNote?: string | null;
  /** Issues in the same repo the PR closes when it merges (GitHub's closing references); empty or absent when none are known. */
  closes?: number[];
  /** Our own build of the PR head; absent when the switch is off or there is none. */
  prBuild?: ItemPrBuild | null;
}

export interface WorkBreakdown {
  /** The level used for the order, after the security raise. */
  level: PriorityLevel;
  /** The stored level, null when the item has not been rated (P2 counts). */
  rated: PriorityLevel | null;
  security: boolean;
  type: string | null;
  size: "S" | "M" | "L" | "XL";
  /** lines (PR), triage (issue, from Fix triage) or default (not known yet). */
  sizeSource: "lines" | "triage" | "default";
  /** 0 to 99, breaks ties inside a level. */
  reach: number;
}

export interface WorkRow {
  repo: RepoName;
  number: number;
  kind: ItemKind;
  title: string;
  /** Sort key (see src/rank/score.ts); for a tooltip only. */
  score: number;
  level: PriorityLevel;
  size: "S" | "M" | "L" | "XL";
  breakdown: WorkBreakdown;
  label: TypeLabel | null;
  /** The pipeline step the item waits for, in words. */
  next: string;
  /** App path of the list where a person resolves what the item waits for, or null. */
  nextHref: string | null;
}

/** A search hit ranked by embedding similarity (`/api/similar`, `/api/search?mode=semantic`). */
export interface SimilarHit extends SearchHit {
  /** Cosine similarity of the two embeddings; near-duplicates score about 0.9 and up. */
  score: number;
  /** How a closed issue was closed. */
  stateReason: "completed" | "not-planned" | "duplicate" | null;
  /** The item's settled type label (see src/classify/settled.ts); null while unsettled. */
  label: string | null;
  labelBy: string | null;
}

// ---- Jev, agent runs and rates -------------------------------------------------------------

/** Whether Jev is in use; `unavailable` says why not (Haiku then does its work) and since when. */
export type JevStatus = { enabled: boolean; unavailable: { reason: string; since: string } | null };

export type AgentRunState = "running" | "done" | "failed";
export type AgentRun = {
  id: number;
  jobId: number | null;
  step: string;              // runner step name
  stage: number;             // stage number from docs/pipeline.md
  promptId: string;          // prompt registry id
  promptVersion: string;     // registry version or content hash
  provider: "claude" | "jev";
  model: string;             // e.g. "sonnet", "haiku", "jev"
  items: (ItemRef & ItemShown)[];   // at most 50
  itemCount: number;         // all items in the call
  state: AgentRunState;
  startedAt: string;
  endedAt: string | null;
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
  costUsd: number | null;    // USD; Jev is input tokens at the flat price; null for runs from before costs were stored
  summary: string | null;    // one line: verdict counts, error class
  progress?: string;         // running calls with tools: the latest thing the model is doing
  via?: RemoteVia;           // user-local mode: who ran the call and with what
  refusal?: AgentRunRefusal; // operators and maintainers: the model's safety filter declined this run
};
/**
 * A run the model's safety filter declined. `outcome`: the call was `retried` on another Task Runner or tier, or `failed` because
 * nothing else could take it. `retry`: the call's last later run, null while none ran or for refusals recorded before runs kept their call.
 */
export type AgentRunRefusal = { outcome: "retried" | "failed"; retry: { id: number; state: AgentRunState } | null };
/**
 * A model call run by a user's helper: their login, the harness (claude, codex) and the model it reported. `runner`: the Task Runner's
 * label, absent when the reader may not see it (another person's private runner, a label that is the machine's hostname).
 */
export type RemoteVia = { login: string; harness: string; model: string; runner?: string };
export type AgentRunDetail = AgentRun & {
  prompt: string | null;     // rendered prompt; null once past retention (ten years)
  output: string | null;     // raw model output, same retention
  error: string | null;
  tools: AgentRunTool[];     // tool uses in order
  textsHidden?: boolean;     // prompt, output and tool arguments are withheld from this user (viewers)
  transcripts?: AgentRunTranscript[]; // full transcripts, one per Task Runner attempt; absent for viewers
  transcriptsOff?: boolean;  // this instance has no transcript store (operators and maintainers only)
};
/** A stored full transcript of one attempt of a call: its summary; the events are read with `agents.transcript`. */
export type AgentRunTranscript = {
  id: number;
  attempt: number;
  outcome: "done" | "failed" | "refused";
  bytes: number;             // stored (gzip) size
  rawBytes: number;
  lines: number;             // events
  toolCount: number;
  lastTool: string | null;
  createdAt: string;
};
/** One readable piece of a transcript: a model message, thinking, a tool call and its result, or another harness event. */
export type TranscriptEntry = {
  at: string | null;         // arrival of the event on the Task Runner
  kind: "system" | "user" | "text" | "thinking" | "tool" | "result" | "final" | "event";
  name?: string;             // tool: the tool's name
  text: string;              // capped; `truncated` counts the characters left out
  truncated?: number;
  isError?: boolean;
  sub?: boolean;             // from a subagent (the explorer)
};
export type TranscriptView = { runId: number; transcript: AgentRunTranscript; entries: TranscriptEntry[]; omitted: number };
/** Where transcripts are stored; `active` null: transcripts are off. `source`: the admin setting or the environment. */
export type TranscriptStoreStatus = {
  active: { kind: "local" | "s3"; source: "settings" | "environment"; dir: string | null; endpoint: string | null; bucket: string | null; prefix: string; accessKeyId: string | null } | null;
  saved: { kind: "local" | "s3"; endpoint: string; bucket: string; prefix: string; accessKeyId: string; secretSet: boolean } | null;
  environment: boolean;      // a bucket is configured in the environment
  problem: string | null;
};
export type TranscriptStoreInput = { kind: "local" } | { kind: "s3"; endpoint: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey?: string };
export type AgentRunTool = {
  seq: number;
  tool: string;              // e.g. "Read", "mcp__build__check"
  args: string | null;       // scrubbed JSON, capped; null for viewers without text access; results are never stored
  resultBytes: number | null;
  isError: boolean;
  startedAt: string | null;  // null when the call's output was not streamed
  endedAt: string | null;
  check: { id: number; command: string; crate: string | null; testName: string | null; outcome: string | null } | null;
};
export type AgentRunPage = { runs: AgentRun[]; nextCursor: string | null };
/**
 * `finished`: done or failed; `recent`: every state. `person` (the login whose Task Runner ran the call), `runner` (a Task Runner's label),
 * `refused` and `window` (runs started in the last 24 hours, 7 days or 30 days) are for operators and maintainers.
 */
export type AgentRunFilter = { state?: AgentRunState | "finished" | "recent"; step?: string; repo?: string; person?: string; runner?: string; cursor?: string; limit?: number; refused?: boolean; window?: RefusalWindow };
export type RefusalWindow = "24h" | "7d" | "30d";
/** Refused runs in a time range per prompt, repo (a run's first item), model and Task Runner user; `failed`: those nothing else could take. `key` null: none (no item, no user). */
export type RefusalGroup = { key: string | null; n: number; failed: number };
/** `capped`: more refused runs than the server counts; the counts cover the newest ones. */
export type RefusalBreakdown = { window: RefusalWindow; total: number; failed: number; capped: boolean; byPrompt: RefusalGroup[]; byRepo: RefusalGroup[]; byModel: RefusalGroup[]; byLogin: RefusalGroup[] };

export type RateBucket = { t: string; items: number; runs: number; failed: number };
export type Rates = {
  window: "24h" | "7d"; bucket: "hour" | "day";
  stages: { step: string; title: string; buckets: RateBucket[] }[];
};

// ---- Build environments and tasks -----------------------------------------------------------------------

export type Capabilities = {
  os: "linux" | "macos" | "windows";
  arch: "x86_64" | "aarch64";
  cpus: number; memGb: number; diskGb: number;
  display: boolean;          // can render UI (Xvfb or real) for screenshots
  gpu: boolean;
  toolchains: string[];      // e.g. ["rust-stable", "node-24"]
  warmSigner?: boolean;      // holds the warm-snapshot signing key; takes no PR-code tasks
  warm?: WarmLine[];         // kubernetes: warm keys the cluster's nodes hold (src/build/warm-status.ts)
  warmErrors?: string[];     // kubernetes: nodes whose warm-sync agent cannot work, as "node: why"
};
/** A warm key's newest version on the cluster's nodes: held by `nodes` of the `of` nodes that report. */
export type WarmLine = { key: string; commit: string; nodes: number; of: number };

/**
 * The warm caches (GET /api/envs/caches, `envs caches`): what each node's warm-sync agent reports, where the runner placed
 * each key, the warm producer's state per repository, and the crate mirror's git allowlist. Node data is the runner's last
 * read of the status ConfigMaps (src/build/caches.ts). `repo` is null for a key no tracked repository maps to.
 */
export type CacheReport = {
  /** When the runner last read the nodes' status ConfigMaps; null before it has. */
  readAt: string | null;
  nodes: CacheNode[];
  /** The placement in force; null without one (every node then keeps every key warm-assign lists). */
  placement: CachePlaced[] | null;
  /** Why the runner could not place keys; null when it could. */
  placementNote: string | null;
  /** The environment warm builds run on and their toolchain image; null without an enabled warm writer. */
  writer: { env: string; image: string | null } | null;
  repos: CacheRepo[];
  /** Null when the runner has not read the allowlist (no Kubernetes environment, or a runner without the reporter). */
  mirror: CacheMirror | null;
};
export type CacheNode = {
  node: string;
  /** When the node's agent last wrote its status, by the node's clock. */
  updated: string;
  /** Written within the last 15 minutes; a stale node counts as not warm. */
  fresh: boolean;
  fs: { sizeBytes: number; usedBytes: number; usedPct: number } | null;
  /** Bytes of the versions keys are current at, and of replaced versions still in their grace period. */
  warmBytes: { current: number; grace: number } | null;
  keys: CacheHeld[];
  pending: { key: string; repo: string | null; why: string }[];
  badBlobs: { key: string; repo: string | null; count: number }[];
  /** Why the agent cannot work at all; null when it can. */
  error: string | null;
};
export type CacheHeld = {
  key: string; repo: string | null; commit: string; bytes: number; image: string | null;
  /** When the version was published, and when this node finished syncing it. */
  stored: string; synced: string;
  /** The key's newest version: the last successful warm build's commit, else the newest any fresh node holds. */
  newest: boolean;
  /** Placed on this node; null without a placement. */
  placed: boolean | null;
};
export type CachePlaced = { key: string; repo: string | null; nodes: { node: string; fresh: boolean; holds: "newest" | "older" | "none" }[] };
/** `current`: the published version is of the current head and toolchain image; `behind`: of an older head; `image`: of another toolchain image; `never`: nothing published. */
export type CacheFreshness = "current" | "behind" | "image" | "never";
export type CacheRepo = {
  repo: string; key: string;
  /** Whether the warm producer builds the repo: as a pipeline repo, added by an operator, excluded, or not at all. */
  coverage: "pipeline" | "added" | "excluded" | "none";
  freshness: CacheFreshness;
  /** The default-branch head the latest main-CI poll saw. */
  head: string | null;
  /** The newest warm task, in any state. */
  last: { id: number; state: TaskState; summary: string | null; headSha: string; endedAt: string | null } | null;
  /** The newest successful warm task: what the store holds for the key. */
  published: { id: number; headSha: string; image: string | null; endedAt: string | null } | null;
  warmTarget: "tmpfs" | "pvc" | "none"; warmTargetSource: "operator" | "auto";
  /** Bytes of the last published version. */
  bytes: number | null;
  /** Fresh nodes that hold the published version, of the fresh nodes. */
  nodes: number; of: number;
};
export type CacheMirror = {
  /** The repositories the mirror serves over git; null when the ConfigMap could not be read. */
  allowlist: string[] | null;
  error: string | null;
  readAt: string;
  /** Environments whose pods fetch through the mirror. */
  envs: string[];
};
export type Requires = Partial<Pick<Capabilities, "os" | "arch" | "display" | "gpu">> & {
  toolchains?: string[]; minMemGb?: number; minDiskGb?: number;
};
export type EnvKind = "local-sandbox" | "remote" | "kubernetes";
export type EnvTask = { id: number; step: string; repo: RepoName; number: number | null; current: string | null; startedAt: string };
export type BuildEnv = {
  id: string; label: string; kind: EnvKind;
  enabled: boolean; online: boolean; lastSeenAt: string | null;
  slots: number; running: number;
  /** The claimed and running tasks, oldest first: what the busy slots are doing. */
  tasks: EnvTask[];
  capabilities: Capabilities | null;   // as last reported by the worker
  version: string | null;              // worker software version
  pausedReason: string | null;         // e.g. "disk 12 GB free (needs 20)"
  /** Set by an operator: the only environments that take the security lane's private tasks, and they take no PR code. */
  confidential: boolean;
  /** A kubernetes environment's settings; null for the other kinds. */
  settings: KubeSettings | null;
};
/** A kubernetes environment: where and how the runner starts a task's build pods (src/build/pods.ts). */
export type KubeSettings = {
  namespace: string;
  /** The AutoCraft image for the task, source and upload pods; null: the runner's own (AUTOCRAFT_IMAGE). */
  image: string | null;
  /** Toolchain name → image the steps run in. Empty until a toolchain image is published; the environment then takes no task that names a toolchain. */
  toolchainImages: Record<string, string>;
  workerUrl: string;
  /** Each step container's CPU; the task, source and upload pods take a fixed small share. */
  cpuRequest: string; cpuLimit: string;
  /** Each step container's memory for a repository without its own size (src/build/sizing.ts). */
  memoryRequest: string; memoryLimit: string;
  ephemeralRequest: string; ephemeralLimit: string;
  /** No step pod's memory request or limit goes above this, also after OOM raises. */
  maxPodMemory: string;
  /** `cluster`: the runner takes as many tasks as the nodes have room for, up to the slots; `fixed`: exactly the slots. */
  capacity: "cluster" | "fixed";
  /** CPU and memory per node that capacity leaves free for others. */
  nodeReserveCpu: string; nodeReserveMemory: string;
  /** The priority class of every build pod; null: the cluster's default. */
  priorityClassName: string | null;
  /** Size and storage class of the task's volume. */
  storage: string; storageClass: string;
  /** Longest a task may take from its first pod to its last. */
  deadlineSec: number;
  /** Longest one step may run, below its own limit. */
  maxStepSec: number;
  runtimeClassName: string | null;
  arch: "x86_64" | "aarch64";
  /** Workspace pods: how many run at once in the environment, and each one's resources and volume size. */
  workspaceSlots: number;
  workspaceCpuRequest: string; workspaceCpuLimit: string;
  workspaceMemoryRequest: string; workspaceMemoryLimit: string;
  workspaceEphemeralRequest: string; workspaceEphemeralLimit: string;
  workspaceStorage: string;
  /** Read-only WebDAV endpoint of the CI runners' compile cache (sccache) that offline Rust steps read; null: no cache. */
  sccacheUrl: string | null;
  /**
   * The warm producer: the environment builds only default-branch heads (step `warm` tasks), writes the compile cache and
   * publishes the warm store. Needs cacheWriteUrl, writerSecret, signingSecret and sccacheUrl.
   */
  warmWriter: boolean;
  /** The toolchain images carry Mesa software Vulkan (lavapipe), so the environment takes tasks that require `display`; steps get the software-render env and no display server. */
  display: boolean;
  /** Read-write WebDAV endpoint of the compile cache and warm store (warm producer only). */
  cacheWriteUrl: string | null;
  /** Secret in the namespace with `username` and `password` for cacheWriteUrl. */
  writerSecret: string | null;
  /** Secret in the namespace with the warm store's signing key, `private.pem`. */
  signingSecret: string | null;
  /** ClusterIP of the crate mirror; `mirror` steps reach crates.io and GitHub only through it. null: no mirror. */
  crateMirror: string | null;
};
export type EnvInput = { label?: string; enabled?: boolean; slots?: number; confidential?: boolean; settings?: Partial<KubeSettings> };
export type EnvCreate = { id: string; label: string; kind: EnvKind; slots: number; confidential?: boolean; settings?: Partial<KubeSettings> };
export type TaskStep = {
  name: string;                         // "fetch deps", "build", "test", "screenshot"
  cmd: string[];                        // argv, run inside the container
  network: "fetch" | "none" | "mirror"; // "fetch": registry/GitHub egress allowed; "none": no network; "mirror": crates.io and GitHub through the crate mirror only
  timeoutSec: number;
  artifacts?: string[];                 // globs under /out to return
  bare?: boolean;                       // run without the /target and /cache mounts
};
export type TaskState = "queued" | "claimed" | "running" | "done" | "failed" | "cancelled" | "lost";
export type TaskResult = { step: string; exitCode: number | null; durationMs: number; timedOut: boolean; peakMemBytes?: number; oomKilled?: boolean };
export type TaskArtifact = { name: string; bytes: number; contentType: string };
export type BuildTask = {
  id: number; jobId: number | null; step: string;   // pipeline step that created it
  repo: RepoName; number: number | null;            // PR
  headSha: string; baseSha: string | null;
  requires: Requires; priority: number;
  plan: TaskStep[];
  state: TaskState; envId: string | null; envLabel: string | null;
  cancelRequested: boolean;
  queuedAt: string; claimedAt: string | null; startedAt: string | null; endedAt: string | null;
  heartbeatAt: string | null;
  results: TaskResult[];
  artifacts: TaskArtifact[];
  summary: string | null;
  /** Bytes of the unified diff applied to the checkout before the plan; null when the task has none. */
  patchBytes: number | null;
  /** Shared build cache: `build` fills it, `use` reads it. */
  warm: { key: string; role: "use" | "build" } | null;
  /** The integration batch this task checks (step merge-batch); null for other tasks. */
  batch: TaskBatch | null;
  /** Kind, state and title of the PR in `number`; null with `number` null. */
  item: ItemShown | null;
  /** Set for a build of the default branch head with no PR and no patch (warm and baseline runs). */
  baseline: { branch: string | null } | null;
  /** The environment the worker ran the steps in; null until the task finishes, or when it failed before the steps. */
  sandbox: SandboxEnv | null;
};
/** `fork` is the `<owner>/<repo>` the batch branch was pushed to; null before the push. `shown` lists kind, state and title of each of `prs`, in order. `commitSha` is the integration commit, `baseSha` the default branch head it was built on. */
export type TaskBatch = { id: number; branch: string; fork: string | null; commitSha: string; baseSha: string; prs: number[]; shown: ItemShown[] };
/** Image and CI-gate inputs a task ran with. Worker-sent: shown as plain text only. */
export type SandboxEnv = { image: string; baseImage: string; packages: string[]; craftFontsRef: string | null; craftI18nRev: string | null };
/** Worker-sent text: shown as plain text only, never as markup. */
export type BuildTaskDetail = BuildTask & { /** null (with the patch) for viewers: staff only. */ logTail: string | null; logBytes: number; logTruncated: boolean; patch: string | null; /** The caller may cancel the task: an operator, or a maintainer with write access to its repo. The server sets it per request. */ canCancel: boolean };
export type TaskFilter = { state?: TaskState | "active"; env?: string; repo?: string; cursor?: string; limit?: number };
export type TaskPage = { tasks: BuildTask[]; next: string | null };
/** Queued and running tasks and the slots left over the online, enabled environments (the flowchart's Verify node). */
export type BuildFeatureName = "screenshots" | "push-tests" | "batch-build" | "scan-tests" | "nightly" | "pr-builds" | "implement";
/**
 * `repos` lists the repos whose switch is on; `on` is scan-tests' instance-wide switch (false for the per-repo features).
 * `shown`: the dashboard shows the feature's switch (its builds run on the cluster's build pods today).
 */
export type BuildFeatureState = { feature: BuildFeatureName; on: boolean; repoScoped: boolean; shown: boolean; repos: string[] };
export type PrBuildScope = "outside" | "all";
/** `repos` is every tracked repo the viewer can see. `prBuilds`: the scope of each of those repos and the builds a repo may start a day. */
/** `manageable`: the repos whose shown feature switches the viewer may flip (operators: all; maintainers: those they can write to). */
export type BuildFeatures = { features: BuildFeatureState[]; repos: string[]; manageable: string[]; prBuilds: { scopes: Record<string, PrBuildScope>; perDay: number } };
/** `on` switches the feature for `repo` (scan-tests: instance-wide, no repo); `scope` (with `repo`, pr-builds only) and `perDay` (pr-builds only) set the build scope and the daily cap. At least one of the three. */
export type BuildFeatureInput = { feature: BuildFeatureName; on?: boolean; repo?: string; scope?: PrBuildScope; perDay?: number };

/** Validator of one screenshot command parameter: a fixed set of values, an integer range, or an anchored regular expression. */
export type ScreenshotParam = { enum: string[] } | { int: [number, number] } | { chars: string; min: number; max: number };
export type ScreenshotCommand = { doc: string; params: Record<string, ScreenshotParam>; argv?: string[]; line?: Record<string, string | number | boolean>; capture?: boolean };
/** The operator-edited setup of one repo; also the body of PUT /api/build/screenshots/:repo. */
export type ScreenshotConfigJson = { package: string; example: string; driver: "args" | "jsonl"; commands: Record<string, ScreenshotCommand>; ui_paths: string[]; size?: string };
export type ScreenshotSetup = { repo: string; config: ScreenshotConfigJson; updatedBy: string; updatedAt: string };
/** `manageable`: the repos whose setup the caller may change (an operator, or a maintainer with write access). */
export type ScreenshotSetups = { setups: ScreenshotSetup[]; manageable: string[] };
// ---- Nightly page (/api/nightly) ---------------------------------------------

export type NightlyState = "queued" | "pass" | "fail" | "error" | "skipped" | "warn";
/** One check on one night; `taskId` links to the build task, null while nothing ran (skipped). */
export type NightlyCell = { state: NightlyState; taskId: number | null; summary: string | null; issueNumber: number | null };
/** `cells` align with the repo's `nights`, newest first; null where the check had no result that night. */
export type NightlyCheckRow = {
  id: string; label: string; enabled: boolean; experimental: boolean; needs: "fuzz-dir" | "benches" | null;
  /** Which selection inputs the check takes. */
  takes: "crates" | "targets" | null;
  crates: string[]; targets: string[]; cells: (NightlyCell | null)[];
  /** The issue opened for the failing streak the check is in. */
  issue: number | null;
  /** The caller may open an issue for the failing streak. */
  canOpenIssue: boolean;
};
export type NightlyBench = { name: string; unit: string; latest: number; /** Latest against the median of the 7 nights before it, in percent (positive = slower); null with too little history. */ deltaPct: number | null; points: number[]; at: string };
export type NightlyRepo = { repo: string; on: boolean; /** The caller may change the repo's nightly checks. */ canSelect: boolean; nights: { runId: number; startedAt: string; sha: string }[]; checks: NightlyCheckRow[]; benches: NightlyBench[] };
export type NightlyGrid = { repos: NightlyRepo[] };
export type NightlySeries = { repo: string; bench: string; unit: string; points: { sha: string; at: string; value: number }[] };
export type NightlySelectInput = { repo: string; check: string; enabled: boolean; crates?: string[]; targets?: string[] };

export type BuildSummary = { queued: number; running: number; slots: number; free: number; online: number };

// ---- Queue page (/api/queue/page) -------------------------------------------

export type QueueTab = "all" | "review" | "fix" | "verify" | "merge";

/** An item's place in line for its next queued stage (src/rank/position.ts), 1-based among the visible items with the same next stage. */
export interface QueueSlot {
  /** Stage name as shown: Review, Opus review, Fix, Fix-up, Verify, Merge. */
  stage: string;
  /** The Queue tab that lists the stage. */
  tab: Exclude<QueueTab, "all"> | "act";
  place: number;
}

/** Place of an item with a live workflow among all of them, in weight order. */
export interface WeightPlace {
  /** From 1. */
  position: number;
  of: number;
  /** 1 to 10: heavier items go first. */
  weight: number;
}

/** One row of the All, Review, Fix and Verify tabs: a work row with its place in line. */
export interface QueueWorkRow extends WorkRow {
  queue?: QueueSlot | null;
}

/**
 * How a PR came into the merge queue: `review` (a take review the merge rule covers), `answer` (an approval carried to a new head),
 * `queued` (a maintainer queued it), `preapproved` (the merge was approved with a fix-up). `by` is who, null for `review` and for anyone but staff; `at` is when.
 */
export interface QueueOrigin {
  how: "review" | "answer" | "queued" | "preapproved";
  by: string | null;
  at: string | null;
}

/** One row of the Merge tab: a merge queue row with its place by weight and how it came in. */
export interface QueueMergeRow extends QueueRow {
  /** Null when no workflow is live for the PR. */
  place: WeightPlace | null;
  added?: QueueOrigin;
}

/**
 * A PR approved for merge that is no merge queue row yet: `fixup` (the operator's fix-up runs first), `review`
 * (waits for a take review at its head), `ci` (reviewed take; becomes a queue row on the next plan).
 * Or a started issue whose PR is not in the queue: `implement` (its attempt), `build`, `pr` (open PRs close it, none queued), `next` (`next` says what is).
 */
export interface QueuePendingRow {
  repo: RepoName;
  number: number;
  kind: "pr" | "issue";
  title: string;
  author: string;
  size: "S" | "M" | "L" | "XL" | null;
  step: "fixup" | "review" | "ci" | "build" | "pr" | "next" | "implement";
  /** An issue AutoCraft implements: the attempt's state, what it does in words, and what it waits for. */
  implement?: { state: ImplementationStateName; text: string; wait: string | null };
  added: QueueOrigin;
  /** An issue: the open PRs that close it. */
  prs?: number[];
  /** An issue: the planner's next step for it, as the reader may see it. */
  next?: string | null;
}

/** What a PR waits for before it merges. */
export type MergeWait = "ready" | "refused" | "ci" | "premerge" | "verify" | "re-review" | "batch-check" | "batch-ci";

/** A PR in "Next merges", in the order it merges. */
export interface NextMerge {
  repo: RepoName;
  number: number;
  title: string;
  waitsFor: MergeWait;
  /** The wait in words. */
  label: string;
  /** The integration batch the PR is in, if any. */
  batch: { id: number; branch: string } | null;
}

export interface QueuePageCounts {
  all: number;
  review: number;
  fix: number;
  verify: number;
  merge: number;
}

/** `pipeline`: repos with the pipeline on; `all`: every repo; otherwise one repo. */
export type QueueRepos = "pipeline" | "all" | RepoName;

export interface QueuePageFilter {
  tab?: QueueTab;
  repos?: QueueRepos;
  /** `repo:number`: the first page is cut long enough to include this item. */
  item?: string;
  limit?: number;
  offset?: number;
}

export interface QueuePage {
  tab: QueueTab;
  /** Index of the requested `item` in this tab's list (rows or merge rows), or null when the tab does not list it. */
  itemIndex?: number | null;
  repos: QueueRepos;
  counts: QueuePageCounts;
  /** All, Review, Fix, Verify tabs (empty on Merge). */
  rows: QueueWorkRow[];
  /** Merge tab only: open PRs that are not in a batch in flight. */
  mergeRows: QueueMergeRow[];
  /** Merge tab only: up to ten PRs in merge order. */
  nextMerges: NextMerge[];
  /** Merge tab only: batches in flight, with their PRs. */
  batches: QueueBatch[];
  /** Merge tab only: PRs approved for merge that wait for their fix-up or review before they join the queue. */
  pending?: QueuePendingRow[];
  /** Rows matching the tab, every page. */
  total: number;
  /** `offset` of the next page, or null on the last one. */
  next: number | null;
}

// ---- conversations with Opus (src/dash/api/conversations.ts) ----

/** "replaced": a later Opus reply proposed a new set; the card can no longer run. */
export type ConversationCardState = "proposed" | "queued" | "running" | "done" | "failed" | "dismissed" | "replaced";

/**
 * An action Opus proposed. `title` is written by the server from the card's parameters; `text` is the card's editable comment.
 * A command card runs a command as the person who presses it; a comment or label card writes that one thing.
 */
export interface ConversationCard {
  id: number;
  /** Digest of the card's text and parameters: a press sends it back, so it runs only the card as shown. */
  digest: string;
  /** "command", "comment" or "label". A card of a retired kind arrives as "comment" with canSettle false. */
  kind: "command" | "comment" | "label";
  title: string;
  /** The viewer may press, edit and dismiss this card (the act rule, over every repo the card writes to). */
  canSettle: boolean;
  /** A command card: what a press runs, as a person would type it (e.g. "fix-up and merge"). Absent: an action without a registered command. */
  command?: string;
  /** What runs, in order, one plain line each (e.g. "Fix up the PR, then merge it if the review and CI pass"). */
  steps: string[];
  /** Why a press would run nothing (an action without a registered command). Absent: it can be pressed. */
  refusal?: string;
  /** Why a proposed card may be out of date: "pr-changed" (a push since it was proposed; it refuses to run) or "new-comments" (GitHub comments since; it still runs). */
  stale?: "pr-changed" | "new-comments";
  /** The primary button: the action in a few words, written by the server from the card's parameters. */
  label: string;
  /** The card's first line: the action with its key parameter, e.g. "Fix up and merge", "Close as duplicate of #12". */
  headline: string;
  /** One line under the headline, e.g. "Comment: …". Absent: the card has no text. */
  preview?: string;
  /** A comment card's text. */
  text?: string;
  /** What the command leads to on GitHub, e.g. "closes the PR on GitHub". The button asks for a second press. */
  writes?: string;
  state: ConversationCardState;
  /** Set when state is queued: the press found no room under the daily GitHub write limit; `place` counts from 1 in the order the cards run. */
  queued?: { place: number | null; reason: string };
  /** Set when state is done; `link` is empty when the action wrote nothing on GitHub. */
  done?: { at: string; link: string; label: string };
  /** Set when state is failed. */
  error?: string;
  /** Who pressed the button or dismissed the card, and when. */
  by?: string;
  at?: string;
  edited?: boolean;
  editedBy?: string;
}

export interface ConversationTurn {
  id: number;
  kind: "operator" | "maintainer" | "opus" | "system";
  /** The writer's login, "opus" or "system". */
  login: string;
  at: string;
  body: string;
  /** Opus turns: the cards, in the order Opus proposed them. */
  actions: ConversationCard[];
  /** Opus turns: why proposed cards were dropped. */
  notes: string[];
  /** Operator and maintainer turns: pending while Opus has not answered, failed when it gave no usable reply. */
  status?: "pending" | "answered" | "failed";
  error?: string;
}

export interface Conversation {
  repo: RepoName;
  number: number;
  /** False when the item has no conversation yet; turns is then empty. */
  exists: boolean;
  /** A person's message waits for Opus's reply. */
  pending: boolean;
  /** The viewer may write to Opus here: an operator, or a maintainer with write access to the repo (their messages run on their own Task Runner). */
  canTalk: boolean;
  /** A maintainer's message waits for Opus and the viewer may withdraw it: an operator, or the maintainer who wrote it. */
  canWithdraw: boolean;
  /** While a reply is being written: what Opus did last, up to five plain lines, newest last. */
  progress?: string[];
  startedBy: string | null;
  turns: ConversationTurn[];
}

// ---- Areas -------------------------------------------------------------------

export interface AreaDef {
  name: string;
  description: string;
}
export interface AreaProposalArea extends AreaDef {
  state: "open" | "accepted" | "ignored";
}
/** A model's proposal waiting for an operator: kind "propose" is a whole list, "suggest" is areas to add. */
export interface AreaProposal {
  id: number;
  kind: "propose" | "suggest";
  areas: AreaProposalArea[];
  createdAt: string;
  createdBy: string | null;
}
export interface RepoAreas {
  repo: RepoName;
  /** null until a list is saved. */
  version: number | null;
  areas: AreaDef[];
  savedAt: string | null;
  savedBy: string | null;
  /** Open items without an area (never asked, none of these, or unassigned by a removed area). */
  unassigned: number;
  /** Open items per area, most first; areas without open items are left out. */
  counts: { area: string; open: number }[];
  versions: { version: number; at: string; by: string | null; note: string | null }[];
  proposals: AreaProposal[];
}
export type AreaEditBody =
  | { op: "add"; name: string; description: string }
  | { op: "rename"; from: string; to: string }
  | { op: "merge"; from: string; into: string }
  | { op: "remove"; name: string }
  | { op: "describe"; name: string; description: string };
/** Which model step to queue: propose a list, suggest new areas, or re-scan the unassigned items. */
export type AreaStep = "propose" | "suggest" | "rescan";

// ---- Item trace ----------------------------------------------------------------

export type TraceKind = "github" | "plan" | "job" | "model-call" | "check" | "review" | "decision" | "write" | "step" | "conversation" | "discord";
export type TraceActor = { type: "person" | "step" | "model"; name: string };
/** Ids needed to fetch an event's details: runs and tasks have their own endpoints; the rest use the trace detail endpoint. */
export type TraceRef = {
  runId?: number; /** A review's model calls, oldest first (a fix turn or repeat adds one). */ runIds?: number[]; jobId?: number; taskId?: number; checkId?: number; auditRowid?: number;
  reviewId?: string; commentId?: string; head?: string; toHead?: string;
  /** A Discord mention: the link that opens the message in Discord. */
  url?: string;
  /** The integration batch the event belongs to (merge, hold and batch writes). */
  batchId?: number;
};
export type TraceEvent = {
  /** Stable across fetches, for example "run:123". */
  id: string;
  kind: TraceKind;
  at: string;
  /** Commit the event belongs to, when known; the page groups by it. */
  head: string | null;
  actor: TraceActor;
  summary: string;
  /** GitHub comments and reviews: the text as Markdown, cut at 20,000 characters (`bodyCut` then true). */
  body?: string;
  bodyCut?: boolean;
  ref: TraceRef;
  /** A review's summed model-call cost; null when none of its calls has a recorded cost. */
  costUsd?: number | null;
  /** Model calls only. */
  call?: {
    /** The prompt the call ran; calls of one step and prompt family are grouped on the item page. */
    promptId?: string; /** The step's display name. */ step?: string;
    model: string; provider: string; state: string;
    inputTokens: number | null; outputTokens: number | null; costUsd: number | null; toolCalls: number; endedAt: string | null; via?: RemoteVia;
  };
};
export type ItemTraceHeader = {
  now: { state: string | null; head: string | null; plannedAt: string | null; text: string; waitsOn: string | null; reasons: string[]; note: string | null };
  /** The plan's due actions in order. */
  next: { kind: string; head: string | null }[];
  who: {
    assignees: string[]; autocraftAssigned: boolean;
    holds: { by: string; at: string }[];
  };
};
export type ItemTrace = { header: ItemTraceHeader; events: TraceEvent[]; nextCursor: string | null; stamp: string };
/** The answer to `since=<stamp>` when nothing the first page or the header shows has changed. */
export type ItemTraceUnchanged = { unchanged: true; stamp: string };
export type ItemTraceQuery = { kinds?: TraceKind[]; autocraftOnly?: boolean; cursor?: string; limit?: number; since?: string };
/** The item an activity event belongs to, for an ItemRef; null fields when the mirror lacks the item. */
export type ActivityItem = { repo: string; number: number; kind: ItemKind | null; state: ItemState | null; title: string | null };
export type ActivityEvent = TraceEvent & { item: ActivityItem };
export type ActivityPage = { events: ActivityEvent[]; nextCursor: string | null; stamp: string };
export type ActivityQuery = { kinds?: TraceKind[]; repo?: string; autocraftOnly?: boolean; cursor?: string; limit?: number; since?: string };
export type ItemTraceDetail = { id: string; kind: TraceKind; at: string; summary: string; fields: Record<string, unknown> };

// ---- Next page -------------------------------------------------------------------

export interface NextItem extends ItemRef, ItemShown {
  /** The plan action that makes the item due, and its bucket. */
  action: string;
  bucket: string | null;
  /** The item's next-step text from the planner. */
  why: string;
  rank: number | null;
  inFlight: boolean;
  /** The step's next job covers this item. */
  next: boolean;
  /** Why the guard would refuse the item's write, or null. */
  blocked: string | null;
}

export interface NextStep {
  lane: string;
  title: string;
  stage: string;
  steps: string[];
  canRun: boolean;
  kind: "ok" | "running" | "off" | "breaker" | "limit" | "backoff" | "approval";
  /** Why the step cannot run now, or null. */
  why: string | null;
  /** The planner's last reading of the step, when it holds back. */
  note: string | null;
  /** Items due for the step; `items` may hold fewer. */
  total: number;
  /** In the order the step takes them. */
  items: NextItem[];
}

export interface NextWaiting extends ItemRef, ItemShown {
  wait: string;
  why: string | null;
}

export interface NextPage {
  steps: NextStep[];
  waiting: NextWaiting[];
  waitingTotal: number;
}
// ---- Health (GET /api/health) ---------------------------------------------------

/** A thing that needs attention; `to` is the page where it is fixed. `info` problems do not break "all healthy". */
export type HealthProblem = { id: string; area: "pipeline" | "runner" | "workers" | "breaker" | "limit" | "account" | "jev" | "main-ci" | "jobs" | "sync" | "deadline" | "liveness" | "database"; tone: "bad" | "warn"; text: string; to: string; since: string | null; /** Set on a job stopped for running past its step's limit: the step an operator acknowledges to clear the warning. */ ackStep?: string; /** Another warning an operator clears by acknowledging it. */ ack?: "app-foreign-install"; /** `to` is a server page (an authorization flow), opened with a full page load that returns here. */ fullPage?: true };
export type Health = {
  pipeline: { enabled: boolean; by: string | null; at: string | null };
  problems: HealthProblem[];
};
/** How long the same kind of work took before: median, the 90th percentile ("late") and how many runs that is, in milliseconds. */
export interface LiveEstimate { median: number; p90: number; samples: number }
/** What a stretch of a lane's time went to: a model call, or one step of a build task (setup, build, tests, lint, other). */
export type LiveOpKind = "model" | "setup" | "build" | "tests" | "lint" | "other";
export interface LiveOp {
  kind: LiveOpKind;
  label: string;
  /** The model and account, or the build step's command name. */
  detail: string | null;
  start: string;
  /** Null while it runs. */
  end: string | null;
  /** For a running op: how long the same work took before. */
  estimate: LiveEstimate | null;
  failed?: boolean;
}
/** One unit of the pipeline's work on the Live board: a job (with its model calls and build tasks) or a build task or call of its own. */
export interface LiveLane {
  key: string;
  title: string;
  state: "running" | "queued" | "done" | "failed";
  /** Started (or queued, while queued). */
  start: string;
  end: string | null;
  /** The latest progress line while running, or the outcome once ended. */
  line: string | null;
  item: (ItemRef & ItemShown) | null;
  itemCount: number;
  repo: string | null;
  /** The job, call or task page. */
  detail: string;
  /** How long this step took before, for a running lane. */
  estimate: LiveEstimate | null;
  ops: LiveOp[];
}
/** One model call on a worker's row of the Live board. */
export interface LiveWorkerCall {
  /** The agent run; its page is `/agents/<id>`. */
  id: number;
  /** The step's name, which picks its colour. */
  step: string;
  /** The step's title, e.g. "Review pull requests". */
  title: string;
  model: string;
  item: (ItemRef & ItemShown) | null;
  itemCount: number;
  start: string;
  /** Null while it runs. */
  end: string | null;
  failed?: boolean;
  /** Input, output and cache tokens of a finished call; null while it runs or when not recorded. */
  tokens: number | null;
  /** For a running call: how long the same step and model took before. */
  estimate: LiveEstimate | null;
}
/**
 * Who does the model calls, one row each on the Live board's worker view: a person's Task Runner (with their own tokens), the runners
 * their owners keep private (one row, no owner), or Jev. For operators and maintainers.
 */
export interface LiveWorker {
  /** "runner:<token id>", "login:<login>" (a runner no longer known), "private" or "jev". */
  key: string;
  kind: "runner" | "private" | "jev";
  /** The runner's label ("Task Runner" without one), "Private Task Runner", or "Jev". */
  name: string;
  /** A runner's owner. */
  login: string | null;
  /** A runner's harness ("claude", "codex"). */
  harness: string | null;
  /** online: takes calls; held: online but not taking any (`note` says why); offline: no fresh status. */
  status: "online" | "held" | "offline";
  note: string | null;
  /** Calls running now, against `slots` (null when not known). */
  busy: number;
  slots: number | null;
  /** The models a shared runner with a fresh status offers. */
  models: string[];
  /** The calls that ran in the board's last hour, oldest first. */
  calls: LiveWorkerCall[];
}
/** `GET /api/live-board`: running and queued work and what ended in the last minutes, for the Live timeline on Home. `workers` only for staff. */
export interface LiveBoard { lanes: LiveLane[]; workers?: LiveWorker[] }

// ---- security deep scan (operators and maintainers only; viewers get 404) ----------------------------------

/** A scan is active in `modeling` (including while it waits in the job queue), `scanning` and `verifying`. */
export type ScanState = "modeling" | "scanning" | "verifying" | "done" | "stopped" | "capped" | "failed";
export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingState = "new" | "dismissed" | "backlog" | "fixing" | "ready" | "landing" | "landed" | "advisory" | "awaiting-admin" | "published";
export type FindingAction = "fix" | "dismiss" | "backlog" | "reopen" | "land" | "advisory" | "publish";

export interface ScanView {
  /** The caller may stop the scan and decide its findings (continuing stays with operators); the server sets it per request. */
  canAct: boolean;
  /** The caller may continue a capped scan with a new cap (same rule as starting one). */
  canContinue: boolean;
  id: number;
  repo: string;
  /** The pinned commit of the default branch; null before the scan has fetched it. */
  commit: string | null;
  state: ScanState;
  /** The spend cap in dollars; null means none. */
  capUsd: number | null;
  costUsd: number;
  /** Estimated total cost, recorded after the threat model; null before. */
  estimateUsd: number | null;
  areasTotal: number;
  areasDone: number;
  /** Findings that survived verification so far. */
  findingCount: number;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface FindingSummary {
  repo: string;
  number: number;
  /** `<repo>:finding:<n>` */
  key: string;
  scanId: number;
  title: string;
  severity: FindingSeverity;
  /** The model judged that it needs an immediate release. */
  urgent: boolean;
  /** Name of the scanned area. */
  area: string;
  state: FindingState;
  createdAt: string;
  updatedAt: string;
  /** State of the finding's scan test; absent when it has none. */
  scanTest?: ScanTestState;
}

/** building: the test is being built and run; confirmed: it fails on the pinned commit; not-shown: it passes there; could-not-build: it did not build or run. */
export type ScanTestState = "building" | "confirmed" | "not-shown" | "could-not-build";
/** A test the scan wrote for the finding and ran in the build worker on the pinned commit. */
export interface FindingScanTest { state: ScanTestState; detail: string | null; path: string; source: string }

export interface FindingRef { path: string; line: number; /** What the line shows; empty when the model gave none. */ claim: string }
export interface FindingVerification { kind: "test" | "reasoning"; result: string; notes: string; /** Verify score, 1 to 10; null for a finding that was not verified. */ score: number | null; /** A failing test the model proposed; the scan does not run it. */ proposedTest: string | null }
/** One event of the finding's scan that concerns it: the threat model, its area's scan, its verification (model calls, with cost), or a later scan that found it again (`duplicate`, no cost). */
export interface FindingCall { kind: "model" | "area" | "verify" | "test" | "fix" | "review" | "duplicate"; at: string; endedAt: string | null; ok: boolean; costUsd: number | null }

export interface FindingView extends FindingSummary {
  refs: FindingRef[];
  reach: string;
  impact: string;
  verification: FindingVerification | null;
  scanTestResult: FindingScanTest | null;
  /** The unified diff of the private fix, once there is one. */
  fixDiff: string | null;
  fixPr: number | null;
  /** Link to the fix pull request: the public one for a quiet landing, the one inside the advisory's private fork for the advisory route. */
  fixPrUrl: string | null;
  ghsaId: string | null;
  /** Link to the draft or published advisory. */
  advisoryUrl: string | null;
  /** One line: why the last fix attempt failed, or what a repository admin must do. */
  note: string | null;
  /** The reason given when dismissing. */
  reason: string | null;
  decidedBy: string | null;
  timeline: FindingCall[];
}

export interface SecurityOverview {
  /** The caller may start a scan on this repo (maintainers need a spend cap). */
  canStart: boolean;
  scans: ScanView[];
  findings: FindingSummary[];
}

export type ScanAreaState = "pending" | "running" | "done" | "failed";
export interface ScanArea { idx: number; name: string; risk: number; why: string | null; paths: string[]; state: ScanAreaState; costUsd: number }
export interface ScanEntryPoint { name: string; kind: string; where: string }
export type ScanCallState = "running" | "done" | "failed";
/** One model call of a scan, in order. `runId` links the agent run holding its prompt and output (null for a call that made none). */
export interface ScanCall {
  id: number;
  kind: FindingCall["kind"];
  areaName: string | null;
  findingNumber: number | null;
  state: ScanCallState;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  runId: number | null;
  /** The latest line of what a running call is doing. */
  progress: string | null;
}
export interface ScanDetail {
  scan: ScanView;
  summary: string | null;
  entryPoints: ScanEntryPoint[];
  areas: ScanArea[];
  calls: ScanCall[];
  findings: FindingSummary[];
}

/** One of the signed-in user's agent tokens for the MCP Connector; the token itself is shown only when made. `canAnswer`: the token's agent may send commands. */
export type McpToken = { id: number; label: string | null; /** `connector`: the MCP Connector; `runner`: a Task Runner credential. */ kind: "connector" | "runner"; canAnswer: boolean; /** The token's helper may claim model calls in the user-local inference mode. */ canRun: boolean; createdAt: string; lastUsedAt: string | null; expiresAt: string };
/** The user's live tokens, the most they may hold, and the server's MCP path (on the dashboard's own origin). */
export type McpTokens = { tokens: McpToken[]; max: number; path: string; /** Whether a token that sends commands can be made. */ answering: boolean };
/** After making a token: the list, the new token's id, and its value, shown this once. */
export type McpTokenCreated = McpTokens & { id: number; token: string };

/** The signed-in user's own settings, and their user-local helpers as the server last saw them (src/remote/protocol.ts). */
export type { HelperInfo as RemoteHelper, Readiness as HelperReadiness, UsageWindow, Machine, RunnerInfo, RunnersReply, PendingRunnerLogin, LoginScopes } from "../../../src/remote/protocol.ts";
/**
 * `manualOnly`: the user's Task Runners take only the calls the user picked and follow-ups of their own sessions. `tasks`: the
 * ids of `taskChoices` the runners take from the queue; every one unless the user unticked some. A choice's `about` says what
 * the task does, `models` which Claude models its calls ask for.
 */
/**
 * `taskItems`: the items the runners take work on: every item, started items only, or items the user started.
 * `runnerPrivate`: the Live board shows the runners' calls to others under one "Private Task Runner" row, without the user's login,
 * the runners' labels, slots or models.
 */
export type TaskItems = "all" | "started" | "mine";
/** `setupDismissed`: the person dismissed the setup banner (web/src/shell/SetupBanner.tsx). */
export type MySettings = UserSettingsReply & { manualOnly: boolean; tasks: string[]; taskChoices: { id: string; title: string; about: string; models: string[] }[]; taskItems: TaskItems; runnerPrivate: boolean; setupDismissed: boolean; };
export type MySettingsChange = UserSettings & { manualOnly: boolean; tasks: string[]; taskItems: TaskItems; runnerPrivate: boolean; setupDismissed: boolean; };

/** Why a queued model call waits, most specific first: picked by a user; waiting for the runner that holds its session; no runner ready for its tier; every ready runner is Manual only; every runner that may take it is busy; no ready runner's user can take calls on its repo; calls ahead of it. */
export type ModelQueueWhyCode = "picked" | "session" | "bound" | "bound-off" | "owner" | "owner-off" | "login" | "no-runner" | "manual-only" | "busy" | "no-repo-access" | "task-off" | "items-off" | "behind";

/** One queued model call of the user-local inference mode, as GET /api/model-queue shows it to the signed-in user's role. */
export interface ModelQueueCall {
  id: number;
  items: (ItemRef & ItemShown)[];
  /** The runner step's name, and its title. */
  step: string;
  kind: string;
  tier: InferenceTier;
  model: string;
  /** Median cost of the prompt's recent finished runs; null without history. */
  estCostUsd: number | null;
  waitedMs: number;
  why: { code: ModelQueueWhyCode; text: string };
  /** Null when no live pick holds it; `login` only for maintainers and operators. */
  picked: { login?: string } | null;
  /** Whether the signed-in user may pick it now. */
  pickable: boolean;
  /** A gating call: the fast lane may take it. */
  gating: boolean;
  followUp: boolean;
  /** Maintainers and operators: the last attempt's error, when it had one. */
  lastError?: string;
}

/** GET /api/model-queue narrowed: `person` and `runner` (a Task Runner's label: its owners) keep the calls picked by or bound to them; staff only. */
export type ModelQueueFilter = { repo?: string; step?: string; person?: string; runner?: string };

/** GET /api/model-queue. `runners`: fresh ready runners taking calls on their own and Manual only ones (`manualLogins` for maintainers and operators). `me.picks` of `me.pickMax`: the user's live picks and the most they may hold. */
export interface ModelQueue {
  calls: ModelQueueCall[];
  runners: { autopilot: number; manual: number; manualLogins?: string[] };
  me: { canPick: boolean; manualOnly: boolean; picks: number; pickMax: number };
}

// ---- redesign: one status per item, Home, the two-sided item page, findings as items ----------------------------

export type ItemPhase = "Triage" | "Waiting for a person" | "Review" | "Fixing" | "Verifying" | "In queue" | "Merged" | "Closed" | "Held" | "Out of scope" | "Pipeline off";

/** Where an item is, what it waits for and what happens next; every page draws the same line. */
export interface ItemStatus {
  phase: ItemPhase;
  /** What it waits for, in words ("CI on a1b2c3d", "a maintainer"); null when it does not wait. */
  waiting: string | null;
  /** What happens when the wait ends. */
  next: string | null;
  /** When the item entered this state. */
  since: string;
  /** Held for model work because its author is outside the team: over the daily limit or in a surge. */
  outside?: OutsideHold;
}

/** Why an outside author's item waits for model work. `limit` is the author's daily limit for the item's kind. */
export type OutsideHold = { reason: "limit" | "surge"; author: string; kind: "pr" | "issue"; limit: number };
/** The outside-author protections: the three numbers (0 turns one off) and how many items are held now. */
export type OutsideState = { prsPerDay: number; issuesPerDay: number; surgePerHour: number; heldByLimit: number; heldBySurge: number; authors: number; /** The surge breaker while it is tripped. */ tripped: { reason: string; since: string } | null };
/** One item held for its author, in the group row of Needs you. */
/** One outside author with held items (GET /api/pipeline/outside/held); `surge`: at least one is held by the surge breaker. */
export type HeldAuthor = { author: string; prs: number; issues: number; /** When the oldest of them was opened. */ oldest: string | null; surge: boolean };

export type ProblemKind = "stopped" | "health" | "stuck" | "gave-up";
/** What a Needs attention row lets the reader do there; the server sends it only to readers allowed to run it. */
export type HomeAction =
  | { kind: "resume-breaker"; key: string }
  | { kind: "release-author"; author: string }
  | { kind: "ack-deadline"; step: string }
  | { kind: "ack-foreign-install" };
/** A Needs attention row; `to` opens what it names: the item beside the Items list, an Items filter, or the page that holds it. */
export interface HomeProblem { kind: ProblemKind; title: string; detail: string; to: string; action?: HomeAction }

export type ReviewTrigger = "new-head" | "discussion" | "operator" | "base" | "model-change";
export type ReviewVerdict = "take" | "take-fix" | "hold" | "close";
export interface ReviewClaim { path: string; line: number; text: string }
/** One Opus review of a head. On GitHub the reviews are one comment, edited in place. */
export interface OpusReviewEntry {
  id: string;
  head: string;
  /** The PR's head is still this commit. */
  current: boolean;
  at: string;
  trigger: ReviewTrigger;
  /** Why it ran, in a sentence ("Two new commits since the last review"). */
  why: string;
  verdict: ReviewVerdict;
  sure: boolean;
  summary: string;
  fixes: string[];
  risks: string[];
  claims: ReviewClaim[];
  /** Items this review says must land first; empty when none. */
  blockedBy: ItemRef[];
  costUsd: number;
}
export interface ReviewHistory { latest: OpusReviewEntry | null; earlier: OpusReviewEntry[] }

export type HistoryKind = "model" | "write" | "decision" | "event";
export interface HistoryCall { label: string; kind: "model" | "tool"; costUsd: number | null; via?: RemoteVia; runId?: number }
export interface HistoryEntry {
  id: string;
  at: string;
  step: string;
  outcome: string;
  /** Model that ran the step, if any. */
  model: string | null;
  costUsd: number | null;
  kind: HistoryKind;
  calls: HistoryCall[];
  /** The GitHub write this row made; links to the same write on the GitHub side. */
  writeId: string | null;
}

export type GithubTab = "conversation" | "commits" | "checks" | "files";
export interface GithubEvent {
  id: string;
  type: "opened" | "comment" | "review" | "label" | "push" | "merged" | "closed";
  at: string;
  actor: string;
  body: string | null;
  /** Set for AutoCraft's own writes: the identity it wrote as and the history row that made it. */
  autocraft: { as: string; historyId: string } | null;
}
export interface GithubSide {
  description: string;
  events: GithubEvent[];
  checks: { name: string; state: CiState }[];
  commits: { sha: string; message: string; author: string; at: string; byAutoCraft: boolean }[];
  files: { path: string; additions: number; deletions: number }[];
  url: string;
  /** When AutoCraft last read the item from GitHub. */
  syncedAt: string | null;
}

/** What the item page header and its overflow menu need: labels, people, queue place and the operator's controls. */
export interface ItemPageHeader {
  labels: string[];
  assignees: string[];
  autocraftAssigned: boolean;
  pipelineOn: boolean;
  discord: DiscordInfo | null;
  queue: QueueSlot | null;
  held: boolean;
  preapproval: Preapproval | null;
  releases: ItemReleases;
  tier: Tier;
  /** PRs: size from changed lines; null for issues. */
  size: "S" | "M" | "L" | "XL" | null;
  /** `held`: a Backlog answer holds the item; `canSettle`: the viewer may put it on the Backlog. */
  backlog: { held: boolean; canSettle: boolean };
}

export type ItemBarTone = "running" | "queued" | "waiting" | "failed" | "done" | "idle";
export interface ItemBarHeadline {
  tone: ItemBarTone;
  /** What is happening, without the model and the elapsed time of a running job. */
  text: string;
  /** What happens next, in words; null when nothing is known. */
  next: string | null;
  /** Running: the model of the job's call in flight. */
  model: string | null;
  /** Running: when the job started; the page counts the elapsed time from it. */
  startedAt: string | null;
  /** The job behind the headline (running, queued or failed), when there is one. */
  jobId: number | null;
  /** Held for model work because its author is outside the team; operators get a Release button. */
  outside?: OutsideHold;
}
export interface ItemBarStep {
  /** Registry stage id. */
  stage: string;
  title: string;
  /** `not-needed`: the post-merge review of a PR that merged as a person approved it. */
  state: "done" | "current" | "failed" | "next" | "not-needed";
  /** The current stage has a job running (animated); otherwise it is waiting. */
  running: boolean;
  /** When a done or failed stage ended. */
  at: string | null;
  costUsd: number | null;
  jobId: number | null;
}
export interface ItemBar { headline: ItemBarHeadline; steps: ItemBarStep[] }

export type TimelineTone = "ok" | "warn" | "bad" | "neutral";
export type TimelineIcon = "review" | "fixup" | "merge" | "push" | "github" | "check" | "job" | "chat" | "person";
/** One line of the item's story: a turn of a person or Opus, or a line of the harness's work (`kind: "harness"`; the page folds runs of the minor ones). */
export interface TimelineEntry {
  /** Stable across fetches. */
  id: string;
  at: string;
  kind: "person" | "opus" | "harness";
  /** A login, "Opus" or "AutoCraft". */
  actor: string;
  icon: TimelineIcon;
  text: string;
  tone: TimelineTone;
  costUsd: number | null;
  /** Shown on its own; the other harness lines fold into runs. */
  major: boolean;
  jobId: number | null;
  /** The review's id in `reviews`. */
  reviewId: string | null;
  /** The GitHub-side write this line made, to jump there. */
  githubId: string | null;
  /** A pushed commit's short sha. */
  commit: string | null;
  /** The pre-approved merge this line belongs to, for Try again and Cancel. */
  preapproval: { id: number; state: Preapproval["state"]; latest: boolean } | null;
  calls: HistoryCall[];
  /** The longer text of the line: a message, a note, instructions. Markdown when `markdown`. */
  body: string | null;
  markdown: boolean;
  /** More detail, one per line: reasons, files, findings. */
  lines: string[];
}
/** The screenshot run of a pull request's latest head: images at the base ("before") and at the head ("after"), served by the task artifact route. */
export interface ScreenshotRun {
  head: string;
  /** Whether `head` is still the PR's head. */
  current: boolean;
  state: "planned" | "running" | "rendered" | "compared" | "error" | "stale" | "skipped";
  verdict: "unchanged" | "as-claimed" | "unrelated" | "unclear" | "regression" | null;
  clear: boolean | null;
  comparison: string | null;
  /** The run's clear regression holds the merge. */
  held: boolean;
  /** The planner's reason, or the error text of a run in state error. */
  reason: string | null;
  model: string | null;
  at: string;
  shots: { name: string; before: { taskId: number; name: string }; after: { taskId: number; name: string } }[];
}
export type ImplementationStateName =
  | "planning" | "asked" | "planned" | "implementing" | "checking" | "fixing" | "opening" | "pr-opened" | "revising" | "stuck"
  | "merged" | "closed" | "failed" | "cancelled";
/** One model call of an implementation: its agent run, cost and, for a session turn, the workspace tool calls it made. */
export interface ImplementationCall {
  at: string;
  /** plan, or the session turn's purpose: start, retry, fresh, findings, report, lint */
  purpose: string;
  /** queued, done, failed, unclaimed, withdrawn */
  outcome: string;
  /** The session's report status; null for the plan or without a report. */
  status: "done" | "blocked" | null;
  /** Staff: the report's or the plan's summary. */
  summary: string | null;
  /** Staff: why a turn failed or its reply is not the report. */
  error: string | null;
  turns: number | null;
  toolCalls: number;
  shellMs: number;
  costUsd: number | null;
  runId: number | null;
  via?: RemoteVia;
}
export interface ImplementationCheckPart { ran: boolean; exit: number | null; findings: number; noVerdict: boolean; note: string | null }
/** One round of AutoCraft's own checks in the workspace. */
export interface ImplementationCheckRound {
  at: string;
  round: number;
  diffStat: string;
  crates: string[];
  fmt: ImplementationCheckPart;
  clippy: ImplementationCheckPart;
  tests: ImplementationCheckPart;
  clean: boolean;
  /** Staff: the findings sent back to the session. */
  findings: { check: "fmt" | "clippy" | "test"; file: string; line: number; message: string }[];
  /** Staff: why a check gave no verdict or passed only on a rerun. */
  notes: string[];
}
export interface ImplementationQuestion {
  at: string;
  audience: "author" | "maintainer";
  text: string;
  /** The answer, or the first reply on the issue after an author question. */
  answer: { by: string; at: string; text: string } | null;
}
/** The plan call's reply. */
export interface ImplementationPlan {
  ready: boolean;
  kind: "bugfix" | "feature" | "change";
  size: "S" | "M" | "L" | "XL";
  summary: string;
  markdown: string;
  acceptance: string[];
  tests: string[];
  app: string | null;
  risks: string[];
}
/**
 * The issue's current (or newest ended) implementation attempt. Viewers get the state, the PR, the change size, the check
 * outcomes and the cost; the plan, questions, screenshots, call summaries, findings and the reason's detail are for staff.
 */
export interface ItemImplementation {
  id: number;
  attempt: number;
  /** Attempts made on the issue, this one included. */
  attempts: number;
  state: ImplementationStateName;
  /** Staff: who queued it; its model calls run on their Task Runner. */
  queuedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Why it is stuck or ended; viewers get the cause without its detail. */
  reason: string | null;
  plan: ImplementationPlan | null;
  questions: ImplementationQuestion[];
  calls: ImplementationCall[];
  checks: ImplementationCheckRound[];
  diffStat: string | null;
  pr: (ItemRef & ItemShown & { url: string | null }) | null;
  /** Screenshots the session took, copied out by AutoCraft. */
  shots: { n: number; what: string; url: string; width: number; height: number }[];
  costUsd: number;
}
export interface ItemPageData {
  repo: RepoName;
  number: number;
  kind: ItemKind;
  state: ItemState;
  /** PRs: a draft on GitHub; false for issues. */
  draft: boolean;
  title: string;
  author: string;
  /** Changes when anything the page shows changes; send it back as `since`. */
  stamp: string;
  header: ItemPageHeader;
  status: ItemStatus;
  /** The live status bar: what is happening to the item now and its path through the pipeline. */
  bar: ItemBar;
  costUsd: number;
  /** Opus's reviews, newest first: the detail of the review lines of the timeline. */
  reviews: ReviewHistory;
  /** The item's story, oldest first (last 200 lines). */
  timeline: TimelineEntry[];
  github: GithubSide;
  /** PRs: our own build of the newest head; null or absent when the pr-builds switch is off or there is none. */
  prBuild?: ItemPrBuild | null;
  /** The latest head's screenshot run, for operators and maintainers; empty otherwise. */
  screenshots: ScreenshotRun[];
  /** Issues: the implementation attempt AutoCraft works or worked on; null or absent when there is none. */
  implementation?: ItemImplementation | null;
}
/** The answer to `since=<stamp>` when nothing on the item page has changed. */
export type ItemPageUnchanged = { unchanged: true; stamp: string };

/** An item in brief, for the hover card on its number: what it is and where it stands. */
export interface ItemPeek {
  repo: RepoName;
  number: number;
  kind: ItemKind;
  state: ItemState;
  title: string;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  labels: string[];
  status: ItemStatus;
  /** PRs: the issues it closes when it merges. */
  closes: number[];
}
/** An author's items in the repos the reader may see (GET /api/authors/<login>). Rejected: pull requests closed without a merge. */
export interface AuthorStats {
  /** The login as GitHub spells it. */
  login: string;
  /** On the team, as Items rows mark it. */
  team: boolean;
  prs: { opened: number; merged: number; rejected: number; open: number };
  issues: { opened: number; open: number; closed: number };
}
/** A PR's merge checks as the merge queue shows them. */
export type ItemChecks = Pick<QueueRow, "verdict" | "ci" | "mergeable" | "verify" | "size" | "prBuild">;

/** A finding's status line, on the shape items use. */
export interface FindingRow { repo: RepoName; number: number; title: string; severity: FindingSeverity; state: FindingState; urgent: boolean; area: string; status: ItemStatus; attempts: number; updatedAt: string }
export type SecurityGroup = "Needs a person" | "Fixing" | "Ready to land" | "Landing" | "Landed or published" | "Dismissed or backlog";
export interface SecurityList { groups: { group: SecurityGroup; rows: FindingRow[] }[] }
export interface FixRound { round: number; outcome: "passed" | "failed"; why: string; at: string; costUsd: number }
/** What a person can do with a finding in its state. `canAct`: the viewer may (they run the repo). A press with `writes` writes to GitHub; `note` says whether it takes a reason. */
export interface FindingQuestion { text: string; canAct: boolean; actions: { action: FindingAction; label: string; does: string; writes: boolean; note: "required" | "optional" }[] }
export interface FindingPageData { finding: FindingView; question: FindingQuestion | null; status: ItemStatus; /** Fix attempts so far. */ attempts: number; rounds: FixRound[]; history: HistoryEntry[]; costUsd: number }

export type DownloadsRange = "all" | "today" | "yesterday" | "7d" | "30d" | "90d" | "12m" | "1h" | "3h" | "6h" | "12h";

export interface DownloadsBar { key: string; label: string; count: number }

export interface DownloadsReport {
  range: DownloadsRange;
  from: string | null;
  to: string;
  /** First recorded poll; ranges starting earlier only count from here. Null before the first poll. */
  historyFrom: string | null;
  apps: { repo: string; name: string }[];
  totals: { downloads: number; issuesOpened: number; issuesClosed: number; prsMerged: number; stars: number; issuesPer1k: number | null };
  /** `stars` is gained in the range, or the total for "all". */
  byApp: { repo: string; name: string; downloads: number; stars: number }[];
  platforms: DownloadsBar[];
  processors: DownloadsBar[];
  formats: DownloadsBar[];
  /** Top 7 releases ("<App> v<x>") and "Other versions". */
  versions: DownloadsBar[];
  /** Newest 50. */
  releases: { repo: string; app: string; tag: string; publishedAt: string; latest: boolean; downloads: number; issues: number; per1k: number | null }[];
}

// ---- Workspaces ----------------------------------------------------------------------------------------------

export type WorkspaceState = "requested" | "starting" | "seeding" | "ready" | "parked" | "ended" | "failed";
export type WorkspaceCallState = "queued" | "running" | "done" | "failed";

/** One workspace in the list (GET /api/workspaces). Without `canSee`, the error and cost are left out. */
export type WorkspaceSummary = {
  id: number;
  repo: RepoName;
  baseSha: string;
  app: string | null;
  state: WorkspaceState;
  stateAt: string;
  node: string | null;
  /** How the target started: the warm version copied, or "started cold: <why>"; null when the workspace has no warm target. */
  warm: string | null;
  createdAt: string;
  endedAt: string | null;
  /** The issue or PR of the workspace's first session; null when no session names one. */
  item: number | null;
  sessions: number;
  /** Cost of the sessions' model calls; null when none reported one or the reader may not see it. */
  costUsd: number | null;
  /** Operators and maintainers with write on the repo read errors, calls, prompts and replies. */
  canSee: boolean;
};
export type WorkspacePage = { workspaces: WorkspaceSummary[]; next: string | null };

export type WorkspaceSession = {
  id: number;
  kind: string | null;
  item: number;
  state: "queued" | "starting" | "running" | "done" | "failed";
  /** Left out for readers who may not see the workspace's content. */
  outcome: string | null;
  forLogin: string | null;
  requestedBy: string | null;
  createdAt: string;
  endedAt: string | null;
  costUsd: number | null;
  /** The model's final reply; operators and maintainers only. */
  reply: string | null;
  /** The text the session was asked to work on; operators and maintainers only. */
  prompt: string | null;
  jobId: number | null;
};

export type WorkspaceDetail = WorkspaceSummary & {
  /** The fields below are null or empty for readers who may not see the workspace's content. */
  error: string | null;
  pod: string | null;
  env: string | null;
  layout: number | null;
  sessionList: WorkspaceSession[];
};

/** A call's metadata; its output is read when the row opens (WorkspaceCallOutput), its image from the image endpoint. */
export type WorkspaceCall = {
  id: number;
  /** The `ws run` number; null for other calls. */
  n: number | null;
  tool: string;
  /** The command (shell), the path (read, write, edit, glob, grep), the app (app_start) or the binary. */
  summary: string;
  state: WorkspaceCallState;
  isError: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The call has settled with a result to read. */
  hasOutput: boolean;
  images: number;
  /** The image's bytes are gone: its size, hash and why (the session's image limit, or the time after the workspace ended); null while they are kept. */
  notKept: { bytes: number; sha256: string; note: string | null } | null;
};
/** Calls oldest first; `older` is the cursor of the earlier page (the id to pass as `before`). */
export type WorkspaceCalls = { calls: WorkspaceCall[]; older: string | null };
/** Untrusted text, shown as text: the first 4000 and the last 20000 characters of a longer output; `chars` is the full length. */
export type WorkspaceCallOutput = { output: string | null; chars: number };

/** One started item on Home (GET /api/maintain/home), from its live workflow row (src/workflow/). */
export interface MaintainRow {
  repo: RepoName;
  number: number;
  kind: "pr" | "issue";
  title: string;
  author: string | null;
  entry: "review" | "fixup" | "implement" | "merge";
  /** The open recommendation, a note that the last answer was unclear, or where the item stands; already translated. */
  line: string;
  /** Waiting for an answer: an open recommendation or an unclear answer. */
  waits: boolean;
  /** Stopped at a blocker. */
  blocked: boolean;
  /** The weight word or `weight n`; null for the normal weight. */
  weight: string | null;
  startedBy: string;
  approvedBy: string | null;
  stoppedBy: string | null;
  updatedAt: string;
  /** Set once the item is merged or closed. */
  state?: "merged" | "closed";
  /** The conversation's last message; `question`: an open question addressed to the reader. */
  last?: { by: string; text: string; question: boolean };
}

/** Where a person's message to AutoCraft was written. */
export type ChatVia = "dashboard" | "github" | "discord" | "agent" | "cli";
export interface ChatFinding { n: number; title: string; file: string | null; major: boolean }
/** One Discord mention of the item: the link opens the message in Discord; `channel` is null for a channel the bot cannot name. */
export interface ChatDiscordLink { url: string; at: string; channel: string | null }
/** One picture of a screenshot run: a build task's artifact, served at /api/tasks/:taskId/artifacts/:name. */
export interface ChatShot { label: string; taskId: number; name: string }
/**
 * One entry of an item conversation, oldest first. `work` is something AutoCraft did; `github` stands for GitHub activity not addressed
 * to AutoCraft between two other entries (`count` events in all; `lines` and `eventIds` keep the last 5); `discord` for mentions of the
 * item on Discord, folded the same way. On a quiet pull request a viewer gets who and when, without bodies, findings or outcomes.
 */
export type ChatEntry =
  | { t: "said"; id: string; at: string; login: string; via: ChatVia; body: string; url: string | null; /** Waiting for Opus's answer. */ pending?: boolean; /** Why the message got no answer, or what a command answered when no reply entry carries it; one line per answer line. */ refusal?: string | null; /** Who withdrew the message before Opus answered. */ withdrawnBy?: string; /** The reader may withdraw it while it waits: an operator, or the maintainer who wrote it. */ canWithdraw?: boolean }
  | { t: "reply"; id: string; at: string; body: string; findings: ChatFinding[]; ask: { to: string[]; question: string } | null }
  | { t: "work"; id: string; at: string; state: "done" | "running" | "failed"; title: string; model: string | null; seconds: number | null; costUsd: number | null; outcome: string | null; detail: [string, string][]; eventId: string | null; /** A screenshot run's pictures, base then head per screen. */ shots?: ChatShot[] }
  | { t: "github"; id: string; at: string; lines: string[]; count?: number; eventIds?: string[] }
  | { t: "discord"; id: string; at: string; links: ChatDiscordLink[] };
export interface ItemConversation {
  id: string;
  title: string;
  /** The item the conversation is about. */
  item: { repo: RepoName; number: number } | null;
  entries: ChatEntry[];
  /** The open question: who it asks. */
  open: { to: string[]; question: string } | null;
  canReply: boolean;
  /** AutoCraft is working: the running step's line. */
  working: string | null;
  /** Work about the item that is queued, oldest first (the main conversation only). */
  queued: ChatQueued[];
  /** The reader's Task Runner on the item's live work (the main conversation only); null when there is nothing to show. */
  runner?: ChatRunner | null;
}
/**
 * `action`: the button the reader may press, "take" (run the queued work on their own Task Runner too) or "release"; null for none.
 * `on`: the logins whose Task Runners were taken onto the work, for operators and maintainers; empty for others.
 */
export interface ChatRunner { action: "take" | "release" | null; on: string[] }
/** A queued job or model call about the item: `why` is the one line that says what holds it back, null when nothing known does. */
export interface ChatQueued { id: string; title: string; since: string; why: string | null }
/** Where AutoCraft is with an item, for the item header. */
export type ItemChatState = "running" | "waiting" | "held" | "done" | "idle";
/** `status` is the one line the item header shows; `next` is what follows (null when nothing does). `stamp` as for `ItemTrace`. */
export interface ItemChat { repo: RepoName; number: number; stamp: string; status: string; state: ItemChatState; next: string | null; conversations: ItemConversation[] }
export type ItemChatUnchanged = { unchanged: true; stamp: string };

/** The reader's Task Runner line: their own runners (fresh status = online) and other users' ready runners that take shared work. */
export interface MaintainRunnerLine {
  mine: { name: string; online: boolean; running: number }[];
  others: number;
}

/**
 * Home. `needs` holds items waiting for an answer on repos the reader may act on (operators: every repo; maintainers:
 * repos with GitHub write; viewers: none). Viewers get `waiting` (every waiting item) and `running`; others get `mine` (items
 * they started, approved or stopped). `runner` is null for viewers and when model calls run on the server's own accounts.
 */
/** One tracked repo on the Repos page: its counts, whether automatic work is on, and the breakers that paused a step. */
export interface MaintainRepo {
  name: RepoName;
  automatic: boolean;
  /** The reader runs the repo: an operator, or a maintainer with write access. */
  canRun: boolean;
  open: number;
  started: number;
  waiting: number;
  mergedWeek: number;
  trips: { key: string; text: string; since: string; canResume: boolean }[];
}

export interface MaintainHome {
  /** The reader's items (up to 8, newest conversation entry first); `mineTotal` counts them all. */
  mine: MaintainRow[];
  mineTotal: number;
  /** Viewers only: the newest updated items in the repos they can see. */
  recent: MaintainRow[];
  runner: MaintainRunnerLine | null;
  attention: HomeProblem[];
}

/** GET /api/maintain/queue: who approved each started item for merge (`repo#number` to login). */
export interface MaintainQueueMeta {
  approvedBy: Record<string, string>;
  /** Items someone holds: open, with no work until they are resumed. `line`: who holds it, and since when. */
  held: { repo: RepoName; number: number; kind: "pr" | "issue"; title: string; line: string }[];
}

/** GET /api/maintain/stats: headline numbers for the last 7 or 30 days and merges per UTC day (today last). Backlog change is items opened minus items closed in the period. */
export interface MaintainStats {
  period: "7d" | "30d";
  merged: number;
  implemented: number;
  reviewed: number;
  backlog: number;
  backlogChange: number;
  /** USD, whole dollars, where the model call reported a cost. */
  spend: number;
  perDay: { day: string; n: number }[];
}

// ---- the Items page (GET /api/maintain/items) ----

/**
 * Which list an item is in: `started` (a live workflow, or an unclear last answer), `automatic`
 * (AutoCraft works it without anyone picking it: review, fix, verify or merge queue), `rest` (open, nothing running), `backlog`
 * (open, nothing planned) and `done` (merged or closed).
 */
export type MaintainItemGroup = "started" | "automatic" | "rest" | "backlog" | "done";
/** `merged`: the pull requests AutoCraft merged (its merge step or a merged batch), newest merge first. */
export type MaintainItemsShow = "open" | "backlog" | "closed" | "merged";
/** `security` and `stuck` are for operators and maintainers. */
export type MaintainItemsFilter = "security" | "outside" | "stuck" | "duplicates" | "mine";

export interface MaintainItemRow {
  repo: RepoName;
  number: number;
  kind: "pr" | "issue";
  state: ItemState;
  title: string;
  author: string | null;
  group: MaintainItemGroup;
  /** A started item's line (the open recommendation, an unclear-answer note or where it stands), already translated; null otherwise. */
  line: string | null;
  /** The pipeline's status line of an item nobody started; null for a started item. */
  status: ItemStatus | null;
  blocked: boolean;
  /** When the open question was asked, sent back with an answer; null when none is open. */
  asked: string | null;
  /** The weight word or `weight n`; null for the normal weight. */
  weight: string | null;
  startedBy: string | null;
  approvedBy: string | null;
  stoppedBy: string | null;
  duplicate: boolean;
  /** Held for model work because its author is outside the team. */
  outside: boolean;
  /** Nothing moves it (the liveness check); always false for viewers. */
  stuck: boolean;
  area: string | null;
  /** The reader may send commands on its repo. */
  may: boolean;
  updatedAt: string;
  /** When and how AutoCraft merged it: by the merge rule, on a person's approval, or with an integration batch. In the `merged` list only. */
  merged?: { at: string; how: "rule" | "approval" | "batch" };
}

export interface MaintainItemsQuery {
  show?: MaintainItemsShow;
  filters?: MaintainItemsFilter[];
  areas?: string[];
  q?: string;
  /** `repo#n` of semantic search hits, best first: only these, in this order within each group. */
  refs?: string[];
  sort?: "priority" | "updated";
  /** Rows per group at most. */
  limit?: number;
}

/** Rows in group order (started, automatic, rest; or backlog; or done), each group cut at the query's limit; `counts` has every match. */
export interface MaintainItems {
  rows: MaintainItemRow[];
  counts: Record<MaintainItemGroup, number>;
}

/** AutoCraft's part in an item, in one word: working on it, waiting for a person, held, in the Backlog, done, or never started. */
/** `stopped`: only the automatic merge rule started it and it stopped; it asks nobody until a maintainer takes it over. */
export type BrowseAutocraft = "running" | "waiting" | "author" | "stopped" | "held" | "backlog" | "done" | "none";
/**
 * How a live workflow stands at its step: `running`, `waiting` (on something that moves by itself, such as CI), `answer` (back with its
 * question or recommendation), `stopped` (at a blocker, or the automatic merge rule stopped it and asks nobody).
 */
export type BrowseStepState = "running" | "waiting" | "answer" | "stopped";

/** One row of the Items browser. */
export interface BrowseRow {
  repo: RepoName;
  number: number;
  kind: ItemKind;
  state: ItemState;
  draft: boolean;
  title: string;
  author: string | null;
  /** The author is outside the team: not an owner, member or collaborator of the repo, nor an operator, maintainer or own login. */
  outside: boolean;
  /** The author is on the team: an owner, member or collaborator of the repo, an operator, maintainer or own login, and no bot. */
  team: boolean;
  /** GitHub label names. */
  labels: string[];
  priority: PriorityLevel | null;
  /** A pull request's size by changed lines; issues have none. */
  size: "S" | "M" | "L" | "XL" | null;
  /** Classification by its short name (bug, feature, perf, extra, plugin, infra). */
  classified: string | null;
  area: string | null;
  comments: number;
  reactions: number;
  /** Mentions in watched Discord channels. */
  discord: number;
  /** A PR's first closing issue, or the lowest-numbered open or merged PR that closes an issue. */
  linked: number | null;
  ci: "green" | "red" | "pending" | null;
  autocraft: BrowseAutocraft;
  /** The step its live workflow is at (a `step:` value of src/core/item-query.ts) and how it stands there; null with no live workflow. */
  step: { name: StepValue; state: BrowseStepState } | null;
  /** The open question of its workflow is addressed to the reader. */
  asksYou: boolean;
  approved: boolean;
  duplicate: boolean;
  createdAt: string;
  updatedAt: string;
  /** Staff, on a list filtered by `is:stuck` or `is:stale`: why the liveness check flags the item, what its plan waits for and since when. */
  liveness?: { cause: string; wait: string | null; since: string };
}

export interface BrowseQuery {
  /** The search text with its qualifiers (src/core/item-query.ts). */
  q: string;
  offset?: number;
  limit?: number;
  /** Only these items (`repo#number`), in this order: the hits of a search by meaning. */
  refs?: string[];
  /** Also count every preset and list the quick-filter values. */
  presets?: boolean;
}

export interface BrowseResult {
  rows: BrowseRow[];
  /** Matches of the query, whatever the page cuts. */
  total: number;
  offset: number;
  limit: number;
  /** Qualifiers that were not applied: unknown, a bad value, or not allowed for the reader. */
  unknown: string[];
  /** Matches per preset id, when asked. */
  presets: Record<string, number> | null;
  /** Labels, authors and areas of the open items of the repos shown, most used first, when asked. */
  facets: { labels: string[]; authors: string[]; areas: string[] } | null;
}

/** What a command did to each item, and the lines to show the sender (confirmation, ambiguity or refusal). */
export interface MaintainCommandResult {
  items: { repo: string; number: number; outcome: "run" | "ambiguous" | "refused"; line: string; workflowId: number | null }[];
  lines: string[];
}
/** One step of a started item: the name and note already translated. */
export interface MaintainStep { label: string; state: "done" | "running" | "waiting" | "stopped" | "next" }
/** A numbered part of the item's plan: a review finding, a separate change, or a piece of an implementation. */
export interface MaintainPart { n: number; title: string; source: "review" | "change" | "implement"; file: string | null; major: boolean; state: "planned" | "dropped" | "fixed" }
/** A workflow event, oldest first: who sent what, where, and the line AutoCraft answered. */
export interface MaintainEvent { id: number; at: string; login: string; via: "github" | "discord" | "agent" | "dashboard" | "cli"; kind: string; line: string | null }

/** Where a started item stands (src/workflow/status.ts builds every line). */
export interface MaintainItemStatus {
  /** The state line: "Running: fix-up: 1 and 2", "Waiting for an answer", "Held by …". */
  headline: string;
  live: boolean;
  /** Someone holds it: nothing runs until it is resumed. */
  held?: boolean;
  entry: "review" | "fixup" | "implement" | "merge";
  /** Started by, approved for merge by, answered by, held by. */
  lines: string[];
  approved: boolean;
  weight: string | null;
  blocker: string | null;
  /** Null when nothing runs any more (stopped, closed, backlog). */
  steps: MaintainStep[] | null;
  parts: MaintainPart[];
  /** The open recommendation, one sentence; null when none is open. */
  rec: string | null;
  /** When the open question was asked, sent back with an answer; null when none is open. */
  asked: string | null;
  /** Who the open question goes to: the item's starter and approver. Empty when none is open, and for an item only the automatic merge rule started, which asks nobody. */
  to: string[];
  /** The last answer was unclear: who wrote it and what AutoCraft replied. */
  unclear: { by: string; at: string; line: string } | null;
  /** The confirmation line of the last accepted command. */
  confirm: string | null;
  /** "Not posted on GitHub: <why>": the review of the item's PR may not be posted; null when nothing is held back. */
  notPosted: string | null;
}

/** A security finding fixed by this pull request: operators and maintainers only. */
export interface MaintainFinding { number: number; title: string; severity: FindingSeverity; state: FindingState }
/** An item a duplicate check found to be the same as this one. */
export interface MaintainDuplicate { repo: RepoName; number: number; kind: "pr" | "issue"; state: ItemState; title: string; canonical: boolean }
/** A question set aside when the repo moved to the maintainer workflow; its findings stay readable. Operators and maintainers only. */

/**
 * The item page's AutoCraft side (GET /api/maintain/items/:repo/:n). `canAct`: the reader may send commands and controls here (operators, and
 * maintainers with GitHub write on the repo). Viewers get no security findings.
 */
export interface MaintainItem {
  repo: RepoName;
  number: number;
  kind: "pr" | "issue";
  canAct: boolean;
  /** Null until someone starts the item. */
  status: MaintainItemStatus | null;
  events: MaintainEvent[];
  duplicates: MaintainDuplicate[];
  security: MaintainFinding[];
  /** Held for model work because its author is outside the team. */
  outside: { reason: "limit" | "surge"; author: string; canRelease: boolean } | null;
  /** Breakers that pause a step of this item's repo; only those the reader may resume carry `canResume`. */
  breakers: { key: string; reason: string; since: string; canResume: boolean }[];
}
/** The answer to a command or a control: the lines every surface shows. `ok` false when nothing ran. */
export interface MaintainReply { ok: boolean; lines: string[] }
