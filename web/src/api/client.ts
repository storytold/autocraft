import { keepPreviousData, useInfiniteQuery, useQuery as useTanstackQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useRef } from "react";
import { topicsFor } from "./topics";
import { usePageProject, withProject } from "./scope";
import type { WorkspaceCallOutput, WorkspaceCalls, WorkspaceDetail, WorkspacePage, TranscriptStoreInput, TranscriptStoreStatus, TranscriptView } from "./types";
import type {
  CacheReport,
  DiscordAccount,
  InferenceEffort,
  InferenceSettings,
  InferenceTier,
  MySettings,
  MySettingsChange,
  ModelQueue,
  ModelQueueFilter,
  LoginScopes,
  PendingRunnerLogin,
  RunnersReply,
  DiscordLinkCode,
  DiscordFilingAdded,
  DiscordSetup,
  Health,
  MaintainHome,
  MaintainRepo,
  MaintainQueueMeta,
  MaintainStats,
  MaintainItems,
  MaintainItemsQuery,
  BrowseQuery,
  BrowseResult,
  MaintainCommandResult,
  MaintainItem,
  MaintainReply,
  ItemPageData,
  ItemPeek,
  AuthorStats,
  LiveBoard,
  SecurityList,
  FindingPageData,
  NextPage,
  AccessOverview,
  McpTokenCreated,
  McpTokens,
  GithubAppStatus,
  GithubSetupLink,
  AgentRunDetail,
  ActivityPage,
  ActivityQuery,
  ItemTrace,
  ItemTraceDetail,
  ItemTraceQuery,
  ItemTraceUnchanged,
  ItemPageUnchanged,
  ItemChat,
  ItemChatUnchanged,
  AgentRunFilter,
  RefusalBreakdown,
  RefusalWindow,
  AgentRunPage,
  JevStatus,
  Rates,
  AuditFilter,
  AuditPage,
  HeldAuthor,
  OutsideState,
  Contributor,
  ContributorFilter,
  ContributorList,
  ClassifierReport,
  CostReport,
  DownloadsReport,
  DownloadsRange,
  RepoAreas,
  DisagreementFilter,
  DisagreementList,
  Item,
  OverrideInput,
  MainCi,
  Progress,
  PromptsReport,
  BatchDetail,
  QueuePage,
  QueuePageFilter,
  RepoName,
  Role,
  RulePreview,
  SearchHit,
  SimilarHit,
  TrackedRepo,
  FindingAction,
  FindingView,
  ScanDetail,
  ScanView,
  SecurityOverview,
  User,
  WhitelistRule,
  Job,
  JobDetail,
  JobFilter,
  JobList,
  JobParams,
  PipelineOverview,
  PipelineState,
  StageLimit,
  BuildEnv,
  BuildFeatureInput,
  BuildFeatureName,
  BuildFeatures,
  ScreenshotConfigJson,
  ScreenshotSetups,
  NightlyGrid,
  NightlySeries,
  NightlySelectInput,
  BuildTask,
  BuildTaskDetail,
  EnvCreate,
  EnvInput,
  TaskFilter,
  TaskPage,
  AreaDef,
  AreaEditBody,
  AreaStep,
} from "./types";

/** The dashboard API as the frontend sees it. The mock and the HTTP client both implement it. */
export interface Api {
  /** The signed-in user; `settings` holds their own settings (maintainers and operators). */
  me: {
    (): Promise<User>;
    settings: {
      get(): Promise<MySettings>;
      put(body: Partial<MySettingsChange>): Promise<MySettings>;
    };
  };
  repos(): Promise<RepoName[]>;
  /** Owners of the visible repos that are not storytold's, by repo name. */
  repoOwners(): Promise<Record<string, string>>;
  /** A repo's area list. Reading is for everyone who sees the repo; every write is for whoever runs the repo (operator, or maintainer with write). */
  areas: {
    get(repo: RepoName): Promise<RepoAreas>;
    /** Each edit saves a new list version and returns the repo's areas. Adding or removing an area also queues a re-scan. */
    edit(repo: RepoName, edit: AreaEditBody): Promise<RepoAreas>;
    /** Queues the model step; returns the job id. */
    run(repo: RepoName, step: AreaStep): Promise<{ jobId: number }>;
    /** A "propose" proposal: accepts the stored list or the edited `areas`. A "suggest" proposal: accepts the named areas and ignores the others in `ignore`. Starts a re-scan when a version was saved. */
    accept(id: number, body?: { areas?: AreaDef[]; accept?: string[]; ignore?: string[] }): Promise<RepoAreas>;
    dismiss(id: number): Promise<void>;
  };
  /** What needs attention on the instance. */
  health(): Promise<Health>;
  /** Running and queued work and what ended lately, on one time axis with estimates (the Live board on Home). */
  live(): Promise<LiveBoard>;
  item(repo: RepoName, number: number): Promise<Item>;
  /**
   * Every event of the item, oldest first, with the header (now, next, who). `since` is the `stamp` of an earlier answer:
   * when nothing in the header or the first page changed, the answer is `{ unchanged: true, stamp }`.
   */
  itemTrace(repo: RepoName, number: number, q?: ItemTraceQuery): Promise<ItemTrace | ItemTraceUnchanged>;
  /** What the list leaves out of an event whose kind has no detail endpoint of its own (plan, job, review, check, step, write). */
  itemTraceDetail(repo: RepoName, number: number, id: string): Promise<ItemTraceDetail>;
  /** Every item's trace events in one stream, newest first; `since` as for `itemTrace`. */
  activity(q?: ActivityQuery): Promise<ActivityPage | ItemTraceUnchanged>;
  /** Top bar: jumps by number, logins, words in titles and bodies. */
  search(q: string): Promise<SearchHit[]>;
  progress(): Promise<Progress>;
  maintain: {
    /** Home: what waits for the reader's answer, what they started, their Task Runner line and problems; the page's project narrows it. */
    home(): Promise<MaintainHome>;
    /** Work queue: who approved each started item for merge. */
    queue(): Promise<MaintainQueueMeta>;
    /** Stats: headline numbers and merges per day for 7 or 30 days. */
    stats(period: "7d" | "30d"): Promise<MaintainStats>;
    /** Items: three lists of the open items (or the Backlog, or the closed items) with filters, search and the priority order; the page's project narrows it. */
    items(query: MaintainItemsQuery): Promise<MaintainItems>;
    /** The Items browser: one page of the items matching a search with qualifiers; the page's project narrows it. */
    browse(query: BrowseQuery): Promise<BrowseResult>;
    /**
     * Sends a command written in the dashboard's box for `items` (repo#number), or for the items its list form (`merge:` then items)
     * names. `asked`: the `asked` of the rows shown, by repo#number.
     */
    command(text: string, opts?: { items?: string[]; asked?: Record<string, string> }): Promise<MaintainCommandResult>;
    /** Repos: every tracked repo the reader may see with its counts, Automatic state and paused steps. */
    repos(): Promise<MaintainRepo[]>;
    /** Per visible repo, the started items that wait for an answer; repos with none are left out. */
    /** Open questions addressed to the reader. */
    asked(): Promise<{ count: number }>;
    /** A registered workflow control (resume a breaker, switch Automatic); answers with the line every surface shows. */
    control(input: { control: "resume-breaker"; key: string } | { control: "set-automatic"; repo: RepoName; on: boolean }): Promise<{ ok: boolean; line: string }>;
  };
  /** The item page: the item's workflow read, its command box and its controls. */
  maintainItem: {
    get(repo: RepoName, number: number): Promise<MaintainItem>;
    /** A command written on the item; the reply is the confirmation, or what was understood when nothing ran. */
    /** `asked`: the `asked` of the status shown. */
    command(repo: RepoName, number: number, text: string, asked?: string | null): Promise<MaintainReply>;
    /** A registered control on the item: release an outside hold, or resume a breaker by its key. */
    control(body: { control: "release-outside"; repo: RepoName; number: number } | { control: "resume-breaker"; key: string }): Promise<MaintainReply>;
  };
  /** The item page's AutoCraft and GitHub sides: status, reviews with earlier ones, result cards, history, GitHub's own sections. `since` as for `itemTrace`. */
  itemPage(repo: RepoName, number: number, since?: string): Promise<ItemPageData | ItemPageUnchanged>;
  /** The item's conversations with AutoCraft: what people said, AutoCraft's replies and work, GitHub and Discord activity folded into lines. `since` as for `itemTrace`. */
  itemChat: {
    get(repo: RepoName, number: number, since?: string): Promise<ItemChat | ItemChatUnchanged>;
    /** Posts the reader's message to one conversation; `lines` is what AutoCraft understood or why nothing ran. */
    send(repo: RepoName, number: number, conversation: string, text: string): Promise<{ chat: ItemChat; lines: string[] }>;
    /** Withdraws the message that waits for Opus (a said entry's canWithdraw). */
    withdraw(repo: RepoName, number: number): Promise<ItemChat>;
  };
  /** The item in brief, for the hover card on its number. */
  itemPeek(repo: RepoName, number: number): Promise<ItemPeek>;
  /** An author's item counts in the repos the reader may see, for their page and the hover card on their name. */
  authorStats(login: string): Promise<AuthorStats>;
  /** Staff: all findings grouped by what they need. */
  securityList(): Promise<SecurityList>;
  /** Staff: a finding with its status, fix rounds and history. */
  findingPage(repo: RepoName, number: number): Promise<FindingPageData>;
  /** CI on the default branch of every synced repo the viewer may see. */
  mainCi(): Promise<MainCi>;
  /** Anyone signed in reads; writes and the preview are for operators. Override notes come only to operators. */
  contributors: {
    list(filter: ContributorFilter): Promise<ContributorList>;
    previewRule(rule: WhitelistRule): Promise<RulePreview>;
    setRule(rule: WhitelistRule): Promise<WhitelistRule>;
    override(login: string, input: OverrideInput): Promise<Contributor>;
  };
  /** Security deep scan. Reading is for operators and maintainers (viewers get 404); the writes are operator only and may answer with the server's error message. */
  security: {
    overview(repo: RepoName): Promise<SecurityOverview>;
    startScan(repo: RepoName, capUsd: number | null): Promise<ScanView>;
    stopScan(id: number): Promise<ScanView>;
    /** Continues a scan that stopped at its cap, with a new cap (null = none) above what it has spent. */
    continueScan(id: number, capUsd: number | null): Promise<ScanView>;
    /** Scans newest first, of one repo or all the reader can see. */
    scans(repo?: RepoName): Promise<ScanView[]>;
    scan(id: number): Promise<ScanDetail>;
    finding(repo: RepoName, number: number): Promise<FindingView>;
    act(repo: RepoName, number: number, action: FindingAction, reason?: string): Promise<FindingView>;
  };
  /** Operator only: every org repo and whether it is tracked. */
  repoAdmin: {
    list(): Promise<TrackedRepo[]>;
    track(name: RepoName): Promise<TrackedRepo[]>;
    untrack(name: RepoName): Promise<TrackedRepo[]>;
    /** Lets the Label stage write labels to this repo on GitHub, or stops it. */
    approveLabels(name: RepoName, approved: boolean): Promise<TrackedRepo>;
    /** Lets the pipeline merge pull requests in this repo, or stops it. */
    approveMerging(name: RepoName, approved: boolean): Promise<TrackedRepo>;
    /** Lets the Fix-up step push commits to contributor branches here, or stops it. */
    approvePushing(name: RepoName, approved: boolean): Promise<TrackedRepo>;
    /** Lets the Act step comment on and close items here, or stops it. */
    approveCommenting(name: RepoName, approved: boolean): Promise<TrackedRepo>;
    /** Lets the Implement step push implementations, open pull requests and comment on issues here, or stops it. */
    approveFixing(name: RepoName, approved: boolean): Promise<TrackedRepo>;
    approveStatusComments(name: RepoName, approved: boolean): Promise<TrackedRepo>;
    /** Lets the Fix red main step rerun failed jobs on a red default branch here and open an issue on an operator's answer, or stops it. */
    approveMainFixing(name: RepoName, approved: boolean): Promise<TrackedRepo>;
    /** Lets the CI-approve step approve the CI runs GitHub holds for reviewed outside pull requests here, or stops it. */
    approveCiRuns(name: RepoName, approved: boolean): Promise<TrackedRepo>;
    setOptionalCheck(name: RepoName, check: string, on: boolean): Promise<TrackedRepo>;
    /** Switches the pipeline stages on or off for this repo (off: sync only). */
    setPipeline(name: RepoName, on: boolean): Promise<TrackedRepo>;
    /** Switches one build feature for this repo. */
    setBuildFeature(name: RepoName, feature: BuildFeatureName, on: boolean): Promise<TrackedRepo>;
  };
  /** Operator only: the model families each tier accepts, and the Jev switch. */
  inference: {
    get(): Promise<InferenceSettings>;
    put(body: { models?: Record<InferenceTier, string[]>; /** A tier to its lowest effort, or null for none. */ minEffort?: Partial<Record<InferenceTier, InferenceEffort | null>> }): Promise<InferenceSettings>;
    jev(): Promise<JevStatus>;
    setJev(enabled: boolean): Promise<JevStatus>;
  };
  /** The signed-in user's own MCP Connector tokens: maintainers and operators make them; anyone lists and revokes their own. */
  mcp: {
    tokens(): Promise<McpTokens>;
    /** `answer`: the token's agent may also send commands, and it lasts 7 days. */
    create(label: string, answer?: boolean): Promise<McpTokenCreated>;
    revoke(id: number): Promise<McpTokens>;
  };
  /** The signed-in user's Task Runners in the user-local inference mode, and the device logins they approve. */
  runners: {
    list(): Promise<RunnersReply>;
    /** A login waiting for approval under this user code, or null when none is (404). */
    pending(code: string): Promise<PendingRunnerLogin | null>;
    /**
     * `label`: the name the runner is listed under, when the user changed it; `scopes`: the ticks the user approved.
     * `otherMachine`: the user says they started the login on another machine; required when it came from another address
     * (409 otherwise).
     */
    approve(code: string, label: string | undefined, scopes: LoginScopes, otherMachine?: boolean): Promise<unknown>;
    deny(code: string): Promise<unknown>;
    revoke(id: number): Promise<unknown>;
    /** Sets one of the user's runners' agent access and answering. */
    setScopes(id: number, scopes: LoginScopes): Promise<unknown>;
    /** Renames one of the user's runners (operators: anyone's); 1 to 64 characters. */
    rename(id: number, label: string): Promise<unknown>;
  };
  /** The queued model calls of the user-local inference mode; maintainers and operators pick calls for their own Task Runners. */
  modelQueue: {
    get(filter?: ModelQueueFilter): Promise<ModelQueue>;
    pick(id: number): Promise<unknown>;
    /** The user's own pick; operators clear anyone's. */
    unpick(id: number): Promise<unknown>;
  };
  /** Operator only. */
  access: {
    overview(): Promise<AccessOverview>;
    add(input: { login: string; role: Role; note?: string }): Promise<AccessOverview>;
    remove(login: string): Promise<AccessOverview>;
    setRole(login: string, role: Role): Promise<AccessOverview>;
    revokeSession(id: number): Promise<AccessOverview>;
    revokeToken(id: number): Promise<AccessOverview>;
    audit(filter: AuditFilter): Promise<AuditPage>;
  };
  /** Operator only. */
  githubApp: {
    status(): Promise<GithubAppStatus>;
    /** The link's URL is in this answer only; it is a path when the server has no base URL. */
    createLink(org: string): Promise<{ link: GithubSetupLink; url: string }>;
    revokeLink(id: string): Promise<{ links: GithubSetupLink[] }>;
    /** Clears the app's keys; `settingsUrl` is where to delete the app on GitHub. */
    remove(): Promise<{ settingsUrl: string }>;
    /** Sets the instance-wide GitHub identity. `app` is refused (with the uncovered repos in the message) unless the app is registered and covers every tracked repo. Every session ends; `signIn` is where to go next. */
    setIdentity(identity: "box" | "app"): Promise<{ identity: "box" | "app"; signIn: string }>;
    /** Puts an account on the allowed owners list; the first one also lists the accounts that must stay allowed. */
    allowOwner(login: string): Promise<{ ok: true }>;
    /** Takes an account off the list; refused, with the reason, for an account that owns a tracked or filing-only repo or the app. */
    removeOwner(login: string): Promise<{ ok: true }>;
    /** Clears the warning about installations removed from accounts that are not allowed owners. */
    ackForeignInstalls(): Promise<{ ok: true }>;
  };
  /** Optional Discord mention counting. Operators change it; everyone signed in may read it. */
  discord: {
    setup(): Promise<DiscordSetup>;
    setChannel(channelId: string, watched: boolean): Promise<DiscordSetup>;
    setChannelRepo(channelId: string, repo: string | null): Promise<DiscordSetup>;
    setContact(contact: string): Promise<DiscordSetup>;
    setReact(on: boolean): Promise<DiscordSetup>;
    setReactEmoji(emoji: string): Promise<DiscordSetup>;
    /** Sets the contributor role panel's channel and role, or turns it off (null). */
    setRolePanel(panel: { channelId: string; roleId: string } | null): Promise<DiscordSetup>;
    removeLink(id: string): Promise<DiscordSetup>;
    /** `added` says whether the repo is link-only, and why. */
    addFilingRepo(repo: string): Promise<DiscordFilingAdded>;
    removeFilingRepo(repo: string): Promise<DiscordSetup>;
    setOffer(repo: string, on: boolean): Promise<DiscordSetup>;
    account(): Promise<DiscordAccount>;
    unlinkOwn(): Promise<DiscordAccount>;
    linkCode(): Promise<DiscordLinkCode>;
  };
  classifiers: {
    /** `run`, `a` and `b` default to the latest run and its first pair. */
    report(sel: { run?: string; a?: string; b?: string }): Promise<ClassifierReport>;
    disagreements(filter: DisagreementFilter): Promise<DisagreementList>;
  };
  /** Token use and spend for one run, or all runs when `run` is empty. */
  cost(run?: string): Promise<CostReport>;
  /** Release downloads, issues, PRs and stars over a range; `app` is a repo name or "all". */
  downloads(range: DownloadsRange, app: string): Promise<DownloadsReport>;
  /** Per pipeline step, the items its next job takes, in order, and what each step waits on. */
  next(): Promise<NextPage>;
  /** The name to type to address the app in a GitHub comment; null when no app is registered. */
  mention(): Promise<{ mention: string | null }>;
  /** One integration batch with its members, CI and history. */
  batch(id: number): Promise<BatchDetail>;
  /** Steps, jobs, the on/off switch and the stage limits: everyone reads; run, cancel, switch and limits are for operators. */
  pipeline: {
    overview(): Promise<PipelineOverview>;
    jobs(filter: JobFilter): Promise<JobList>;
    job(id: number): Promise<JobDetail>;
    run(step: string, params: JobParams): Promise<Job>;
    cancel(id: number): Promise<Job>;
    state(): Promise<PipelineState>;
    setEnabled(enabled: boolean): Promise<PipelineState>;
    setLimit(step: string, limit: { perDay: number | null }): Promise<StageLimit>;
    /** Counts the stage's items today from zero again; `all` resets every stage. */
    resetLimit(step: string): Promise<PipelineState>;
    /** Clears a stage the circuit breaker paused. */
    resumeTrip(stage: string): Promise<PipelineState>;
    /** Operator only: outside authors with held items. */
    heldAuthors(): Promise<HeldAuthor[]>;
    /** Operator only: lets every item now held for the author through. */
    releaseAuthor(author: string): Promise<{ released: number }>;
    setOutsideLimits(input: Partial<Pick<OutsideState, "prsPerDay" | "issuesPerDay" | "surgePerHour">>): Promise<Pick<OutsideState, "prsPerDay" | "issuesPerDay" | "surgePerHour">>;
    /** Operator only: clears the warning about jobs of a step the runner stopped for running past their limit. */
    ackDeadline(step: string): Promise<{ ok: true }>;
    /** Operator only: the two blocker thresholds (changed lines). */
  };

  /** Agent runs (one model call each): keyset-paged, filtered on the server. */
  agents: {
    list(filter: AgentRunFilter): Promise<AgentRunPage>;
    get(id: number): Promise<AgentRunDetail>;
    /** Operators and maintainers. */
    refusals(window: RefusalWindow): Promise<RefusalBreakdown>;
    /** One full transcript of a run; operators and maintainers only. */
    transcript(runId: number, id: number): Promise<TranscriptView>;
  };
  /** Operator only: where model-call transcripts are stored. `test` without input checks the active store. */
  transcriptStore: {
    status(): Promise<TranscriptStoreStatus>;
    save(input: TranscriptStoreInput): Promise<TranscriptStoreStatus>;
    clear(): Promise<TranscriptStoreStatus>;
    test(input?: TranscriptStoreInput): Promise<{ ok: boolean; detail: string }>;
  };
  /** Build environments (workers that run untrusted code) and their tasks. Everyone reads; operators write. A worker key is returned once. */
  envs: {
    list(): Promise<BuildEnv[]>;
    create(input: EnvCreate): Promise<{ env: BuildEnv; key: string }>;
    update(id: string, input: EnvInput): Promise<BuildEnv>;
    rotateKey(id: string): Promise<{ key: string }>;
    /** Warm versions per node, placement, warm state per repo and the crate mirror's allowlist. Everyone reads. */
    caches(): Promise<CacheReport>;
  };
  /** The build feature switches. Anyone who sees internals reads; operators write. */
  buildFeatures: {
    list(): Promise<BuildFeatures>;
    set(input: BuildFeatureInput): Promise<BuildFeatures>;
  };
  /** Nightly checks: the grid, one benchmark series, and (operators) the per-repo selection. */
  nightly: {
    grid(): Promise<NightlyGrid>;
    series(repo: string, bench: string): Promise<NightlySeries>;
    select(input: NightlySelectInput): Promise<NightlyGrid>;
    /** Opens the issue of a failing check. */
    openIssue(input: { repo: string; check: string }): Promise<NightlyGrid>;
  };
  /** The per-repo screenshot setup. Anyone who sees internals reads; operators write. */
  screenshotSetup: {
    list(): Promise<ScreenshotSetups>;
    put(repo: string, config: ScreenshotConfigJson): Promise<ScreenshotSetups>;
    remove(repo: string): Promise<ScreenshotSetups>;
  };
  tasks: {
    list(filter: TaskFilter): Promise<TaskPage>;
    get(id: number): Promise<BuildTaskDetail>;
    cancel(id: number): Promise<BuildTask>;
  };
  /** Workspace pods, their sessions and call logs. Operators and maintainers of the repo read calls and screenshots. */
  workspaces: {
    list(f: { state: "live" | "all"; cursor?: string }): Promise<WorkspacePage>;
    get(id: number): Promise<WorkspaceDetail>;
    /** The newest calls (oldest first), the page `before` a call id, or the calls after `after` plus the `running` ones again. */
    calls(id: number, q?: { before?: string; after?: number; running?: number[] }): Promise<WorkspaceCalls>;
    /** One settled call's output. */
    output(id: number, call: number): Promise<WorkspaceCallOutput>;
    /** Where the first image of a call is served. */
    imageUrl(id: number, call: number): string;
  };
  /** Items moved per stage and account use over time. */
  rates(window: "24h" | "7d"): Promise<Rates>;
  /** Every registered model prompt, with the server's commit. */
  prompts(): Promise<PromptsReport>;
  signOut(): Promise<void>;
  /** Called after any write so open views can refetch. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
  /** Search by meaning: the query's embedding against every item's. */
  semanticSearch(q: string): Promise<SimilarHit[]>;
  /** One tab of the Queue page over a repo filter. */
  queuePage(filter: QueuePageFilter): Promise<QueuePage>;
  /** Operator controls of the Queue page; items are `repo#number`. */
  queueControl: {
    batchRemove(item: string): Promise<void>;
    stopBatch(id: number): Promise<void>;
  };
  /** A registered workflow control (src/workflow/apply.ts `runControl`): hold or release a merge. The reply is the line every surface shows. */
  controls: { run(input: { control: "resume-breaker"; key: string }): Promise<{ ok: boolean; line: string }> };
}

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("ApiContext missing");
  return api;
}

export interface Query<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  refetch: () => void;
}

/**
 * A server view in the shared cache. `key` identifies the view (it must contain every input of `fn`);
 * the topics it reads come from api/topics.ts, and the server's change events refetch it. The
 * previous data stays while a refetch is in flight so lists don't flash. `pollMs` is for views that
 * change without a database write (a log file being written); it runs only while the tab is visible.
 */
export function useQuery<T>(key: string, fn: (api: Api) => Promise<T>, opts: { pollMs?: number | false | ((data: T | undefined) => number | false); enabled?: boolean; project?: string | null; gcTime?: number } = {}): Query<T> {
  const api = useApi();
  // The project (the page's unless `project` is given) is part of the key: the same view of another project is another entry.
  const page = usePageProject();
  const project = opts.project === undefined ? page : opts.project;
  const q = useTanstackQuery<T, Error>({
    queryKey: [key, project],
    queryFn: () => withProject(project, () => fn(api)),
    meta: { topics: topicsFor(key) },
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
    ...(opts.gcTime !== undefined ? { gcTime: opts.gcTime } : {}),
    refetchInterval: typeof opts.pollMs === "function" ? (query) => (opts.pollMs as (d: T | undefined) => number | false)(query.state.data) : opts.pollMs || false,
  });
  const { refetch } = q;
  const again = useCallback(() => void refetch(), [refetch]);
  // A pushed refetch replaces the data in place; only a first load or a new key (data shown is the old key's) counts as loading.
  return { data: q.data, error: q.error ?? undefined, loading: q.isPending || q.isPlaceholderData, refetch: again };
}

export interface PagedQuery<P> {
  /** Every loaded page, first to last; undefined until the first one arrives. */
  pages?: P[];
  error?: Error;
  /** True while the first page loads, or while a new key's pages load over the old key's; pushed refetches don't count. */
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

/**
 * A cursor-paged list in the shared cache. A change event refetches every loaded page in order, so
 * "Show more" keeps its place. `next` gives the cursor of the page after `page`, or null on the last one.
 */
export function usePagedQuery<P>(key: string, fn: (api: Api, cursor: string | undefined) => Promise<P>, next: (page: P) => string | null | undefined, opts: { keepPageMs?: number } = {}): PagedQuery<P> {
  const api = useApi();
  // With `keepPageMs`, a change event refetches the first page only; a later page is read again when its cursor changed or its copy is older than that.
  const kept = useRef(new Map<string, { page: P; at: number }>());
  const project = usePageProject();
  const q = useInfiniteQuery<P, Error, { pages: P[] }, (string | null)[], string | undefined>({
    queryKey: [key, project],
    queryFn: async ({ pageParam }) => {
      const keep = opts.keepPageMs;
      const read = () => withProject(project, () => fn(api, pageParam));
      if (!keep || pageParam === undefined) return read();
      const at = `${project ?? ""} ${pageParam}`;
      const hit = kept.current.get(at);
      if (hit && Date.now() - hit.at < keep) return hit.page;
      const page = await read();
      for (const [k, v] of kept.current) if (Date.now() - v.at >= keep) kept.current.delete(k);
      kept.current.set(at, { page, at: Date.now() });
      return page;
    },
    initialPageParam: undefined,
    getNextPageParam: (last) => next(last) ?? undefined,
    meta: { topics: topicsFor(key) },
    placeholderData: keepPreviousData,
  });
  const { refetch, fetchNextPage } = q;
  return {
    pages: q.data?.pages,
    error: q.error ?? undefined,
    loading: q.isPending || q.isPlaceholderData,
    hasMore: !!q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: useCallback(() => void fetchNextPage(), [fetchNextPage]),
    refetch: useCallback(() => void refetch(), [refetch]),
  };
}
