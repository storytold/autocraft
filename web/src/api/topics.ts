/**
 * Which server topics each query reads. The server bumps a topic when a table
 * behind it changes (src/live.ts: TOPIC_TABLES); a query is refetched when one of
 * its topics changes. The first matching prefix wins, longest prefix first.
 * A key that matches nothing is refetched on every change, so a new query is
 * correct before it is listed here.
 */
export type Topic =
  | "repos" | "sync" | "items" | "ranks" | "stages" | "checks" | "classify" | "dupes" | "reviews" | "queue" | "workflows" | "workflow-events" | "jobs" | "usage" | "agents"
  | "envs" | "tasks" | "workspaces" | "actions" | "fixes" | "verify" | "postmerge" | "access" | "settings" | "trace" | "github" | "outside" | "plans" | "conversations" | "steps" | "mainci" | "limits" | "preapprovals" | "security" | "discord" | "discord-links" | "downloads" | "build-features" | "pr-builds" | "nightly" | "remote-helpers" | "remote-queue" | "chat";

/** What moves an item's queue position (src/rank/position.ts), for every query that carries the badge. */
const withSlot = (...topics: Topic[]): Topic[] => [...new Set<Topic>([...topics, "steps", "repos"])];

/** Everything an item page shows about a pull request. */
const ITEM: Topic[] = withSlot("discord", "items", "stages", "classify", "ranks", "workflows", "reviews", "verify", "fixes", "postmerge", "actions", "checks", "preapprovals", "pr-builds", "build-features");

const TRACE: Topic[] = withSlot("items", "stages", "workflows", "workflow-events", "reviews", "verify", "fixes", "postmerge", "actions", "plans", "tasks", "conversations", "queue", "access", "checks", "trace", "preapprovals", "pr-builds", "build-features", "github");

const RULES: [prefix: string, topics: Topic[]][] = [
  ["health", ["jobs", "envs", "sync", "settings", "repos", "mainci", "limits", "access", "plans", "actions"]],
  ["progress", ["items", "stages", "repos", "mainci"]],
  ["main-ci", ["mainci", "repos"]],
  ["stuck", ["plans", "items"]],
  // The trace reads most tables behind an item page plus model calls, jobs and GitHub detail. The `trace` topic leaves out a running call's progress lines; the page also asks the server `since` its last stamp.
  ["item-trace:", TRACE],
  // The item page is the trace plus the header (labels, Discord, holds) and the GitHub side; it also asks `since` its last stamp.
  ["item-page:", [...new Set<Topic>([...TRACE, "discord", "ranks"])]],
  // The item chat: messages, AutoCraft's replies and work, GitHub and Discord lines; it also asks `since` its last stamp.
  ["item-chat:", [...new Set<Topic>([...TRACE, "chat", "conversations", "workflows", "discord"])]],
  // The Live board: jobs, model calls (their progress lines too), build tasks (each step's log) and integration batches.
  ["live", ["jobs", "agents", "tasks", "queue", "remote-helpers"]],
  ["maintain-asked", ["workflows", "workflow-events", "chat"]],
  ["maintain-queue", ["workflows", "items", "repos"]],
  // The item page: the workflow row and its events, signals, findings, holds and breakers.
  ["maintain-item:", ["workflows", "trace", "items", "workflow-events", "dupes", "security", "outside", "plans", "limits", "preapprovals", "access", "settings", "repos"]],
  ["maintain-repos", ["workflows", "items", "repos", "limits", "settings", "access"]],
  ["maintain-stats:", withSlot("items", "stages", "reviews", "usage", "repos")],
  // The list of the pull requests AutoCraft merged: each merge moves the queue topic.
  ["maintain-items:merged:", ["queue", "access", "repos"]],
  ["maintain-browse:", ["workflows", "workflow-events", "items", "checks", "ranks", "classify", "dupes", "discord", "reviews", "outside", "access", "security", "repos"]],
  ["author-stats:", ["items", "access", "repos"]],
  ["maintain-items:", ["workflows", "workflow-events", "items", "plans", "ranks", "classify", "dupes", "outside", "access", "security", "repos"]],
  ["maintain-home", ["workflows", "workflow-events", "chat", "items", "remote-helpers", "access", "settings", "plans", "jobs", "limits", "security", "repos", "actions", "outside", "mainci", "envs", "sync"]],
  // One opened event row: its detail reads what the timeline does; the run and the task behind it read one table each.
  ["item-trace-detail:", TRACE],
  ["item-trace-run:", ["agents"]],
  ["item-trace-task:", ["tasks"]],
  ["activity:", withSlot("items", "stages", "workflows", "workflow-events", "reviews", "verify", "fixes", "postmerge", "actions", "plans", "tasks", "conversations", "queue", "access", "checks", "trace", "agents", "jobs", "github")],
  ["item:", ITEM],
  ["discord-setup", ["discord", "discord-links"]],
  ["discord-account", ["discord-links"]],
  ["downloads", ["downloads", "items"]],
  ["cost:", ["usage", "agents"]],
  ["rates-", ["usage", "agents"]],
  // A card's refusal follows the item's recommendation.
  ["conversation:", ["conversations", "workflows"]],
  // A scan page also shows each running call's progress line, which arrives through `agents`.
  ["security:scan:", ["security", "agents"]],
  ["security", ["security"]],
  ["repos", ["repos"]],
  ["repo-admin", ["repos", "sync", "settings", "build-features", "envs"]],
  ["cls:", ["classify", "items"]],
  ["dis:", ["dupes", "items"]],
  ["contributors:", ["items", "settings"]],
  ["access", ["access"]],
  // Making and revoking a token writes an audit row.
  ["mcp-tokens", ["access"]],
  // Approving and revoking a runner writes an audit row.
  ["runners", ["remote-helpers", "access"]],
  ["runner-pending:", ["access"]],
  ["model-queue", ["remote-queue"]],
  ["audit:", ["access"]],
  ["prompts", []],
  ["pipeline-state", ["settings", "jobs", "limits", "outside"]],
  ["outside-held", ["outside", "items", "repos"]],
  ["pipeline-jobs:", ["jobs", "usage"]],
  ["pipeline-job:", ["jobs", "usage", "agents"]],
  ["pipeline", ["jobs", "settings", "repos", "sync"]],
  ["agents-steps", ["jobs", "settings", "repos"]],
  ["agents-repos", ["repos"]],
  ["agents-running", ["agents"]],
  ["agents-recent:", ["agents"]],
  ["agent-", ["agents"]],
  ["mention", ["settings"]],
  ["next-page", ["plans", "jobs", "settings", "repos", "items", "ranks", "usage", "stages", "tasks"]],
  ["batch:", ["queue", "tasks", "items", "checks", "access"]],
  ["queue-page:", ["queue", "preapprovals", "plans", "ranks", "items", "checks", "classify", "reviews", "verify", "fixes", "tasks", "settings", "repos", "pr-builds", "build-features"]],
  ["envs-repos", ["repos"]],
  ["nightly", ["nightly", "repos"]],
  ["build-features", ["build-features", "repos"]],
  ["screenshot-setup", ["build-features"]],
  ["areas:", ["classify", "jobs"]],
  // The workspace pages read only their own tables; a settled call's output never changes.
  ["workspaces", ["workspaces"]],
  ["workspace:", ["workspaces"]],
  ["workspace-output:", []],
  // The caches report: the runner's node reads (envs), warm tasks, default-branch heads and the warm producer's settings.
  // The person's own settings: their own changes come back with the write; the repo choices follow tracked repos and access.
  ["my-settings", ["repos", "access"]],
  ["envs-caches", ["envs", "tasks", "mainci", "settings"]],
  ["envs", ["envs", "tasks"]],
  ["tasks:", ["tasks", "envs"]],
  ["task-", ["tasks", "envs"]],
].sort((a, b) => b[0].length - a[0].length) as [string, Topic[]][];

/** Topics a query key reads, or null for "any change". */
export function topicsFor(key: string): Topic[] | null {
  return RULES.find(([p]) => key.startsWith(p))?.[1] ?? null;
}
