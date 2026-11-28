// The wire format between the server and the Task Runner `autocraft` (`worker/autocraft.mjs`) in the
// `user-local` inference mode: model calls run in a harness on a maintainer's own machine, under their
// own subscription; everything else (planner, gates, GitHub writes, builds) stays on the server.
// No Node imports: the helper keeps its own copy of these shapes and the dashboard build may import this file.

/** Bumped on any change to these shapes; the server refuses a claim from a helper of a version outside ACCEPTED_PROTOCOLS. */
export const PROTOCOL_VERSION = 5;
/**
 * The protocol versions the server answers. 3 is a helper without long-polling claims (no `Claim.wait`); its claims are
 * answered at once. 4 is a helper that reads only the text of a `ToolReply`; `autocraft tool` of such a helper prints no
 * image (a harness on MCP reads the server's replies itself, whatever the helper's version).
 */
export const ACCEPTED_PROTOCOLS: readonly number[] = [3, 4, 5];

/**
 * API routes on the dashboard origin. Runner routes take `Authorization: Bearer <Task Runner credential>` (an MCP Connector
 * token is refused with 403); lease routes take `Authorization: Bearer <lease secret>`.
 */
export const ROUTES = {
  /** Runner credential. Body `Claim`, reply `ClaimReply`. */
  claim: "/api/remote/claim",
  /** Lease secret. Reply `TaskBundle`. */
  bundle: "/api/remote/bundle",
  /** Runner credential. Body `HelperStatus`, reply `StatusReply`: the helper's readiness, sent on every change and at least every STATUS_EVERY_S while it runs. */
  status: "/api/remote/status",
  /** Lease secret. Body `Heartbeat`, reply `{ ok: true }`, or 410 when the lease is gone (expired, cancelled, re-queued). Every lease route answers 410 for an ended lease, never 401. */
  heartbeat: "/api/remote/heartbeat",
  /** Lease secret. Body `Submit`, reply `SubmitReply`. */
  submit: "/api/remote/submit",
  /** Lease secret of an attempt just submitted. Body `TranscriptUpload`, reply `{ ok: true }`, or 410 when no transcript is awaited for it (none asked, already sent, or past TRANSCRIPT_WAIT_S). */
  transcript: "/api/remote/transcript",
  /** Lease secret. Body `Release`, reply `{ ok: true }`: the call goes back to the queue without using an attempt (the helper is too old, or its platform or harness login is missing). */
  release: "/api/remote/release",
  /** Lease secret. A private repo's checkout or a workspace entry as a tar stream: `?repo=<name>&sha=<sha>`. */
  tarball: "/api/remote/tarball",
  /** Lease secret. One tool call of a server the bundle lists, without MCP: `POST ${tool}/<server>/<tool>`, body the tool's arguments, reply `ToolReply`. A long call (`check`, the workspace tools) sends whitespace before the JSON while it runs. */
  tool: "/api/remote/tool",
  /** Lease secret. Streamable HTTP MCP servers with only this call's tools, one per server name: `/mcp/task/<name>` (items, build, reference, workspace). */
  mcp: "/mcp/task",
  /** No credential. Body `LoginStart`, reply `LoginStartReply`: a Task Runner asks to have the credential it made approved by a signed-in user. */
  loginStart: "/api/remote/login/start",
  /** `Authorization: Bearer <the pending credential>`. Body `{}`, reply `LoginPollReply`, or 429 with `Retry-After` when polled too often. */
  loginPoll: "/api/remote/login/poll",
  /** The helper itself, a single file. */
  helper: "/worker/autocraft.mjs",
  /** The helper's earlier path, which helpers up to 1.2.0 download in `update`. */
  legacyHelper: "/worker/autocraft-task.mjs",
} as const;

export type Tier = "top" | "mid" | "small";
/** The effort ladder, lowest first; a harness without the top levels maps them to its own highest (Codex: max to xhigh). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export type HarnessId = "claude" | "codex";

/** What a helper offers when it asks for work. */
export type Claim = {
  protocol: number;
  helperVersion: string;
  harness: HarnessId;
  harnessVersion: string;
  /** Tiers this helper takes, each with the model its harness runs for it: an alias (opus, sonnet, haiku) or a full model id. The server accepts a tier only when the model belongs to a family accepted for it, and matches models by family. */
  tiers: Partial<Record<Tier, string>>;
  /** The highest effort the helper passes to its harness per tier (for Claude the prompt's effort as given, for Codex the reasoning effort its adapter maps to). The server offers a tier only when this meets the tier's minimum effort; a tier without it meets no minimum. */
  efforts?: Partial<Record<Tier, Effort>>;
  /** Only calls on these repos, within the repos the user picked on the Connect page; absent means any the user may take. */
  repos?: string[];
  /** A follow-up turn for a session this helper still holds: the server offers follow-ups for these call ids first. */
  sessions?: number[];
  /**
   * A directory the helper places the sandbox paths below, when its sandbox cannot place them at the filesystem root
   * (macOS: sandbox-exec confines paths but cannot remap them). The bundle's text and `claude` hints then name
   * `<root>/repo`, `<root>/repos/<name>`, `<root>/repo-docs`, `<root>/mcp.json` and `<root>/agents.json`, and the reply's
   * paths are read back without it. Absolute, letters, digits and `. _ + @ -`, no `.` or `..` component. Absent: the fixed paths.
   */
  root?: string;
  /**
   * Unique per claim attempt (8 to 64 characters of letters, digits, `-` and `_`). A claim repeated with the same id within
   * CLAIM_ID_TTL_S gets the same reply, so a helper whose reply was lost (reset, proxy error, timeout) retries safely.
   */
  requestId: string;
  /** The claim comes from the helper's fast-lane slot: the server offers it only follow-ups of its sessions, gating calls and small-tier calls. */
  fastLane?: boolean;
  /**
   * The claim comes from the helper's own lane, beside its slots: the server offers it only calls bound to the helper's user (a
   * maintainer's own conversation turn) and their follow-ups, which count toward no slot or Max calls at once.
   */
  ownLane?: boolean;
  /**
   * The claim comes from one of the helper's interactive slots (the user's Interactive slots setting): the server offers it only
   * interactive calls (discord.* prompts), which count toward no slot or Max calls at once. Other claims are offered none.
   */
  interactiveLane?: boolean;
  /** A claim from a slot or the fast lane of a helper that also runs an own lane: the calls bound to its user are left to that lane. */
  withOwnLane?: boolean;
  /**
   * The room left on the helper's harness login before its refresh, in seconds: no call may run longer. With enough room the
   * server leases a longer call with its bundle's `timeoutSeconds` cut to the room (calls.ts LOGIN_CUT_MIN_MS); with less it
   * leases only calls that fit. Absent: any timeout. A server without the field offers any call, and the helper gives back one that does not fit.
   */
  maxTimeoutSeconds?: number;
  /**
   * Protocol 4 only: how long the server may hold the claim open when nothing is queued for it, in whole seconds (0 to 30).
   * A call queued meanwhile is leased at once; when none comes, the empty reply has `retryAfter: 1`. Absent or 0: answered at once.
   */
  wait?: number;
};

/** How long the server remembers a claim's `requestId` and its reply. */
export const CLAIM_ID_TTL_S = 300;

/**
 * The plan usage a helper keeps in reserve, per window: it claims only while the remaining percent (100 - used) of every
 * window is above it. Set per user on the dashboard (0 to 90, default 20); a helper's local setting may only raise it.
 */
export type Reserve = { fiveHour: number; weekly: number };

/**
 * Body encodings the server accepts on every POST route of the Task Runner, besides plain JSON. `gzip+base64`: the body is
 * `Envelope`, whose `body` is base64 of the gzip of the plain JSON body, sent as application/json. A CDN or web application
 * firewall in front of the dashboard then never sees model text, which its content rules may take for an attack. The
 * uncompressed body has the route's size limit (413 above it).
 */
export const ENCODINGS = ["gzip+base64"] as const;
export type Encoding = (typeof ENCODINGS)[number];
export type Envelope = { encoding: Encoding; body: string };

export type ClaimReply = ({ lease: null; /** Seconds to wait before the next claim when nothing is queued. */ retryAfter: number; reserve: Reserve; /** Present while the token gets no calls: why (repeated lost leases, the user's limit of calls at once), and with a cool-off when it may claim again (ms since epoch). `retryAfter` then runs to `until`. */ reason?: string; until?: number; /** The body encodings the server accepts (ENCODINGS); absent from a server that takes plain JSON only. */ encodings?: Encoding[]; /** The server answered the claim's `ownLane`; a server without it ignores the field and leaves this out. */ ownLane?: true; /** On an interactive-lane claim: the user's Interactive slots; a server without the lane leaves it out. */ interactiveSlots?: number }
  | { lease: { id: number; secret: string; /** One line: prompt id and the item, e.g. "review.opus on designcraft#1502". */ title: string; requiredHelper: string }; reserve: Reserve; encodings?: Encoding[]; ownLane?: true; /** On an interactive-lane claim: the user's Interactive slots; a server without the lane leaves it out. */ interactiveSlots?: number }) & { /** The version of the Task Runner this server serves; a runner older than it may update itself. */ currentHelper?: string };

/**
 * Whether a helper takes calls now. `ready`: it claims. `quota-held`: a plan window is at or below the reserve, its usage
 * could not be read, or the provider refused a run for its limit. `paused`: its user paused it until a reset. `cooled-off`: the
 * server gives the login, across all its helpers and tokens, no calls for a while after repeated lost leases or failed
 * replies (ClaimReply `reason`, `until`; src/remote/cooloff.ts). `failing`: the helper's last 5 calls failed or were given
 * back in a row; it claims again at `until` if its checks pass (`reason` names the last error). `login-refresh`: no call fits
 * before the helper has its harness refresh the login, at `until`; it claims again once the login is refreshed. A server
 * without it answers 400, and the helper reports `harness-missing` with the same reason instead. The rest need the user:
 * the sandbox check failed, the server refused the helper's version, or the harness or its login is missing.
 */
export type Readiness = "ready" | "quota-held" | "paused" | "cooled-off" | "sandbox-failed" | "version-refused" | "harness-missing" | "failing" | "login-refresh";
export const READINESS: readonly Readiness[] = ["ready", "quota-held", "paused", "cooled-off", "sandbox-failed", "version-refused", "harness-missing", "failing", "login-refresh"];
/** The longest time between two status reports of a running helper. */
export const STATUS_EVERY_S = 300;

/** One plan window as the helper last read it: percent used (0-100) and when it resets (ISO time, null when unknown). */
export type UsageWindow = { usedPercent: number; resetsAt: string | null };
/** The plan usage behind a status; `at` is when it was read. A window is null when the provider reported none. */
export type UsageReading = { fiveHour: UsageWindow | null; weekly: UsageWindow | null; at: string };

export type HelperStatus = {
  readiness: Readiness;
  /** When a hold or pause ends (ISO time); absent when it ends only when usage is read again or the user acts. */
  until?: string;
  /** One line on why the helper is not ready. */
  reason?: string;
  harness: HarnessId;
  /** The model the helper runs for each tier. */
  models: Partial<Record<Tier, string>>;
  /** The reserve the helper enforces: the user's, raised by its local setting. */
  reserve: Reserve;
  usage?: UsageReading;
  /** Calls the helper runs at once: its `--parallel` slots plus the fast lane. */
  slots: number;
  /** Slots running a call now. */
  busy: number;
  /** The helper's last error talking to the server or running a call, until it recovers: what failed, in one line, and when (ISO time). */
  lastError?: { text: string; at: string };
  /** The helper's own version (`HELPER_VERSION`). */
  helperVersion?: string;
  /** The machine the helper runs on. */
  machine?: Machine;
};
/** The user's reserve, so a helper knows it before its first claim. */
export type StatusReply = { ok: true; reserve: Reserve; /** As in ClaimReply. */ encodings?: Encoding[] };

/** One of the user's helpers (Task Runner credentials), for the Connect page and my_work: the session route GET /api/runners replies with these and more per runner. */
export type HelperInfo = {
  tokenId: number;
  label: string | null;
  /** Null when the helper has never reported a status. */
  readiness: Readiness | null;
  until: string | null;
  reason: string | null;
  /** Whether the last status is recent enough to count (STATUS_EVERY_S and some slack); a stale `ready` helper gets no calls. */
  fresh: boolean;
  /** The last status report or claim (ISO time), null when the token was never used by a helper. */
  lastSeen: string | null;
  harness: HarnessId | null;
  models: Partial<Record<Tier, string>>;
  reserve: Reserve | null;
  usage: UsageReading | null;
  slots: number | null;
  busy: number | null;
  lastError: { text: string; at: string } | null;
};

/** One of the signed-in user's Task Runners: GET /api/runners (session route) replies `RunnersReply`. */
export type RunnerInfo = HelperInfo & {
  /** The machine the runner named at login or in its latest status; null for a runner from before logins carried it. */
  machine: Machine | null;
  /** The runner's version from its latest status or claim; null when it never reported one. */
  helperVersion: string | null;
  /** When the credential was made (ISO time). */
  createdAt: string;
  /** When the credential expires unless used (ISO time); each use moves it on. */
  expiresAt: string;
  /** Agent access: the credential may also use /mcp (its tools). */
  agent: boolean;
  /** The credential may send commands on /mcp (with agent access, while the user may act). */
  answer: boolean;
};
/** `answering`: whether the signed-in user may let a runner send commands. */
export type RunnersReply = { runners: RunnerInfo[]; answering: boolean };

/** GET /api/runners/pending?code=<user code> (session route): a device login waiting for approval, or 404. Times are ISO. */
export type PendingRunnerLogin = {
  label: string;
  machine: Machine;
  /** The address the runner's login came from. */
  ip: string;
  /** This browser's address, as the server sees it. */
  yourIp: string;
  startedAt: string;
  helperVersion: string;
  expiresAt: string;
  /** The scopes the runner asked for (LoginStart.scopes); the approver sets the final ones. */
  scopes: LoginScopes;
};

/**
 * GET and PUT /api/me/settings (session routes): the signed-in user's own settings. `repos`: the repos their helpers take calls
 * from, empty for every repo. A PUT sends any of the fields.
 */
export type UserSettings = { reserve: Reserve; repos: string[]; /** Calls the user's helpers may hold on the interactive lane together (0 to 4). */ interactiveSlots: number; /** The most calls the user's helpers run at once, all helpers together; null for no limit. */ maxCalls: number | null };
/** The settings with `repoChoices`: the tracked repos with the pipeline on where the user has write permission, sorted. */
export type UserSettingsReply = UserSettings & { repoChoices: string[] };

/** A directory the harness reads, at a fixed path inside the sandbox. */
export type Mount =
  /** A public repo at a commit: the helper fetches `sha` from GitHub (`ref`, e.g. refs/pull/12/head, when the SHA is not on a branch) into its bare-clone cache and checks it out without instruction files. */
  | { kind: "git"; path: string; owner: string; repo: string; sha: string; ref?: string }
  /** A private repo or anything else from the server: GET ROUTES.tarball. */
  | { kind: "tarball"; path: string; repo: string; sha: string }
  /** Small files sent inline (repo docs, screenshots as base64, logs). */
  | { kind: "files"; path: string; /** `name` is a relative path below `path`, possibly with subdirectories; never absolute, never with `..`. */ files: { name: string; base64: string }[] };

export type TaskBundle = {
  callId: number;
  promptId: string;
  promptVersion: string;
  tier: Tier;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Wall-clock limit for the whole harness run: the call's own, or the lease's when cut to the claim's login room. */
  timeoutSeconds: number;
  maxTurns: number | null;
  /** The task budget of a call retried after it used every turn (src/remote/turn-limit.ts), in place of its prompt's; the `claude` hints carry it as they would the prompt's. */
  taskBudget?: number;
  /** The text sent on stdin. */
  stdin: string;
  /** The system prompt for a call without a sandbox; null when the harness's own system prompt is kept. */
  system: string | null;
  /** Read-only mounts. Paths are the fixed sandbox paths (/repo, /repos/<name>, /repo-docs, /reference, /agents.json), below the claim's `root` when it has one. Empty for a call without tools. */
  mounts: Mount[];
  /** MCP servers the call may use, each served at `${ROUTES.mcp}/<name>` with this lease's secret; the names give the tool names (`mcp__<name>__*`). */
  mcpServers: string[];
  /** Whether the helper keeps the harness session after the call: a follow-up turn (lint fix, check reminder, resume) may continue it. */
  keepSession: boolean;
  /** The server stores the call's full session, set only on an instance with a transcript store: whatever the outcome, once the submit is accepted the helper sends it to ROUTES.transcript (helpers from 1.5.2). */
  transcriptAfter?: boolean;
  /** A follow-up turn: resume this helper's session of the parent call instead of starting one. The helper resumes with the session id it recorded; the hints never carry `--resume`. */
  resume?: { parentCallId: number };
  /** Exact arguments for adapters that can use them; an adapter without hints builds its own from the fields above. */
  hints: {
    /** `claude` arguments as the server would run them (src/prompts `claudeArgs`), for the fixed sandbox paths or below the claim's `root`, with the prompt's `--task-budget` added at lease time only when the claim's Claude Code is at least the first that takes it. The model name is replaced by the claim's model for the tier. */
    claude?: { args: string[]; /** The `--agents` file content when the call has the explorer. */ agents?: string };
  };
};

/**
 * Sent every HEARTBEAT_S from the claim until the submit or release. `preparing`: fetching the bundle and the code; the
 * call's time limit has not started, but preparing may take at most PREPARE_MAX_S. `running`: the harness runs; the first
 * `running` heartbeat starts the time limit.
 */
export type Heartbeat = { phase: "preparing" | "running"; /** The harness's last progress line, shown on the run. */ progress?: string };
export const HEARTBEAT_S = 30;
export const PREPARE_MAX_S = 15 * 60;

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/** One tool use of the call, as the harness recorded it: the same fields a local run stores (src/agents/tools.ts). */
export type SubmitTool = { name: string; /** The input as JSON, at most 4000 characters. */ args: string; /** Size of the result; null when no result came back. */ resultBytes: number | null; isError: boolean; startedAt?: string; endedAt?: string };

/**
 * The full session, for the call's transcript (src/transcripts): gzip of JSONL, base64. Each line is `{"at": <ISO time the
 * line arrived>, "event": <one JSON event the harness streamed>}`, in order; a helper that had to cut a long session
 * keeps its start and end and puts `{"at", "omitted": <events left out>}` between them. At most TRANSCRIPT_MAX characters.
 * Helpers 1.5.0 and 1.5.1 send it in `Submit.transcript`, which the server still stores when the submit fits its limit.
 */
export const TRANSCRIPT_MAX = 16 * 1024 * 1024;
export type TranscriptUpload = { transcript: string };
/** How long after an accepted submit the server takes the attempt's transcript. */
export const TRANSCRIPT_WAIT_S = 10 * 60;

export type Submit =
  | { ok: true; text: string; /** The full model id the harness reported (e.g. from the CLI's result); matched by family against the claim's model for the tier. */ model: string; usage: Usage; /** Per model id, subagents (the explorer) included; `usage` is the whole call when this is absent. */ modelUsage?: Record<string, Usage>; /** The harness's cost for the whole call at list price, when it reports one (the Claude CLI's `total_cost_usd`). */ costUsd?: number; turns?: number; /** The harness session id, kept by the helper for follow-ups. */ sessionId?: string; /** Tool uses in order, subagents included. */ tools?: SubmitTool[]; transcript?: string; durationMs: number }
  | { ok: false; /** What went wrong, with the harness's own refusal or error text. */ error: string; /** The tokens the run used before it stopped. */ usage?: Usage; durationMs: number; transcript?: string; /** The model's safety filter declined the request: the server runs the call once more on another Task Runner or a lower tier, without using an attempt. */ refused?: boolean;
      /** Why the harness's last model turn stopped, as it reports it (Claude: the result's `stop_reason`, such as refusal or max_tokens); helpers from 1.4.3. */ stopReason?: string; /** The harness's kind of result (Claude: the result's `subtype`, such as error_max_turns or error_during_execution); helpers from 1.4.3. */ subtype?: string };

export type SubmitReply = { accepted: boolean; reason?: string };

/** A tool's result, as an MCP tools/call result carries it. */
/** One entry of a tool reply's content. Protocol 5: a tool result's images (base64) follow its text. */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolReply = { content: ToolContent[]; isError?: boolean };

/** The content of a tool result, as a ToolReply and an MCP tools/call reply carry it: the text, then the images. */
export const toolContent = (r: { text: string; images?: readonly { data: string; mimeType: string }[] }): ToolContent[] =>
  [{ type: "text", text: r.text }, ...(r.images ?? []).map((i): ToolContent => ({ type: "image", data: i.data, mimeType: i.mimeType }))];

export type Release = {
  /** Why the helper gives the lease back, shown on the call. */ reason: string;
  /** Setting up the call's files or slot failed on the helper (a fetch, git, disk): the same login may take the call again after SETUP_RETRY_MS instead of RELEASE_SKIP_MS (src/remote/calls.ts). */ setup?: boolean;
  /** The helper process is stopping (a signal, a restart): the call goes back with no skip of its login, so any of that login's runners may take it again at once; helpers from 1.5.5. */ stopped?: boolean;
};

/** The machine a Task Runner runs on, as Node's `os.hostname()`, `process.platform` and `process.arch` give it. */
export type Machine = { hostname: string; platform: string; arch: string };

/**
 * Device-style login: the runner makes its own credential (`acrun_` + 32 random bytes, base64url), keeps it, and sends only
 * its hash, lowercase hex SHA-256 of the whole credential string. A signed-in user approves the shown `userCode` on the dashboard.
 */
/** `agent`: the credential may also use /mcp; `answer`: it may send commands there. */
export type LoginScopes = { agent: boolean; answer: boolean };
/** `scopes`: what the runner asks for; `agent` counts as true and `answer` as false when left out. */
export type LoginStart = { credentialHash: string; /** The name the runner is listed under; the approving user may change it. */ label: string; machine: Machine; helperVersion: string; scopes?: Partial<LoginScopes> };
export type LoginStartReply = {
  /** 8 characters from BCDFGHJKLMNPQRSTVWXZ as "BCDF-GHJK"; compared without case or hyphen. */
  userCode: string;
  /** The dashboard page that approves this login: `<base>/connect?runner=<userCode>`. */
  verifyUrl: string;
  /** Seconds between two polls. */
  interval: number;
  /** Seconds until the login expires unapproved. */
  expiresIn: number;
};
/** `approved`: the credential works on the runner routes as it is. `denied` and `expired` are final; the runner starts a new login. */
export type LoginState = "pending" | "approved" | "denied" | "expired";
export type LoginPollReply = { state: LoginState };
