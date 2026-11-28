// A remote call whose session works in a workspace: Claude Code with its own tools off and the `work` MCP server
// (src/build/workspace-relay.ts) beside any other per-lease servers, bound to the workspace so the dashboard routes the
// session's tool calls to it and the job that waits for the call (awaitCall) serves them.
import type { ItemRef } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import { ITEM_SERVER } from "../itemtools/index.ts";
import { REFERENCE_SERVER } from "../remote/bundle.ts";
import { enqueueCall } from "../remote/calls.ts";
import { callLevel } from "../remote/level.ts";
import { bindWorkspaceCall, loadWorkspaces, loadWorkspaceCallSince, WorkspaceError } from "../data/build/index.ts";
import type { TaskBundle, Tier } from "../remote/protocol.ts";
import { MCP_PATH, mcpTools } from "../sandbox/agents.ts";
import { BuildError } from "./envs.ts";
import { OWN_CALLS, WORKSPACE_SERVER } from "./workspace-tools.ts";
import { diffStat, LIVE_STATES } from "./workspaces.ts";

/** Servers a workspace session may have beside `workspace`. A function: these modules import each other, so a constant could be read before its module ran. */
const extraServer = (name: string): boolean => name === ITEM_SERVER || name === REFERENCE_SERVER;

export type WorkspaceCallRequest = {
  workspaceId: number;
  promptId: string;
  promptVersion: string;
  model: string;
  tier: Tier;
  effort: TaskBundle["effort"];
  stdin: string;
  /** Replaces Claude Code's system prompt when given. */
  system?: string | null;
  timeoutSeconds: number;
  maxTurns: number;
  items: ItemRef[];
  level?: number;
  maxAttempts?: number;
  /** Other per-lease servers: items, reference (with `referenceRepo`). */
  servers?: string[];
  referenceRepo?: string;
  /** Keep the harness session so a follow-up turn (`parentId`) can continue it. */
  keepSession?: boolean;
  parentId?: number;
  /** Only this user's own Task Runners take the call (calls.ts NewCall.forLogin); a follow-up keeps its parent's. */
  forLogin?: string;
  /** With forLogin: the call runs in one of that user's Task Runner slots, not their own lane (NewCall.boundSlot). */
  boundSlot?: boolean;
};

/** The `claude` arguments of a workspace session: no built-in tools, only the listed MCP servers' tools, allowed without asking. */
export function workspaceClaudeArgs(r: Pick<WorkspaceCallRequest, "model" | "effort" | "maxTurns" | "system" | "keepSession">, servers: string[]): string[] {
  return ["-p", "--model", r.model, "--effort", r.effort, "--output-format", "stream-json", "--verbose", "--tools", "", "--allowedTools", mcpTools(servers).join(","),
    "--permission-mode", "dontAsk", "--permission-prompts", "none", "--restricted", ...(r.system ? ["--system-prompt", r.system] : []),
    "--mcp-config", MCP_PATH, "--strict-mcp-config", "--disable-slash-commands", ...(r.keepSession ? [] : ["--no-session-persistence"]), "--max-turns", String(r.maxTurns)];
}

/**
 * Queues a remote call for a session in workspace `workspaceId` and binds the workspace to it, in one transaction, so no
 * Task Runner can lease the call before its tool calls have a workspace to go to. Refused while another call bound to the
 * workspace is queued or leased, unless it is the new call's parent. Returns the call id; the caller waits with
 * awaitCall, which serves the session's tool calls meanwhile.
 */
export async function queueWorkspaceCall(db: Db, r: WorkspaceCallRequest): Promise<number> {
  const extra = [...new Set(r.servers ?? [])];
  const bad = extra.find((s) => !extraServer(s));
  if (bad) throw new BuildError(400, `a workspace session cannot have the ${bad} server`);
  if (extra.includes(REFERENCE_SERVER) && !r.referenceRepo) throw new BuildError(400, "the reference server needs referenceRepo");
  const servers = [WORKSPACE_SERVER, ...extra].sort();
  const level = r.level ?? await callLevel(db, r.items[0]);
  return await db.write(async () => {
    const id = await enqueueCall(db, {
      promptId: r.promptId, promptVersion: r.promptVersion, tier: r.tier, effort: r.effort, askedModel: r.model, items: r.items, level, maxAttempts: r.maxAttempts ?? 1,
      ...(r.parentId !== undefined && { parentId: r.parentId }), ...(r.referenceRepo && extra.includes(REFERENCE_SERVER) && { referenceRepo: r.referenceRepo }),
      ...(r.forLogin !== undefined && { forLogin: r.forLogin, boundSlot: r.boundSlot === true }),
      bundle: {
        promptId: r.promptId, promptVersion: r.promptVersion, tier: r.tier, effort: r.effort, timeoutSeconds: r.timeoutSeconds, maxTurns: r.maxTurns,
        stdin: r.stdin, system: r.system ?? null, mounts: [], mcpServers: servers, keepSession: r.keepSession === true,
        ...(r.parentId !== undefined && { resume: { parentCallId: r.parentId } }),
        hints: { claude: { args: workspaceClaudeArgs(r, servers) } },
      },
    });
    // Bound after the enqueue: a resumed job adopts its earlier call, which is then the one bound already.
    await bindWorkspaceCall(db, r.workspaceId, id, r.parentId === undefined ? {} : { parentId: r.parentId }).catch((e: unknown) => {
      throw e instanceof WorkspaceError ? new BuildError(e.status, e.message) : e;
    });
    return id;
  });
}

const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;

/**
 * A workspace session's prompt for its next lease, from `base`, the stdin as queued: with a note when an earlier lease of
 * the call already worked in the workspace (its Task Runner was lost). The note says what the workspace kept, from what the
 * last resume did, and the changes as of the last checkpoint, which the launcher takes when the call goes back to the queue.
 */
export async function resumePrompt(db: Db, callId: number, base: string): Promise<string> {
  const w = [...(await loadWorkspaces(db, { remoteCallIds: [callId] }, { checkpoint: true })).values()].find((x) => (LIVE_STATES as readonly string[]).includes(x.state));
  if (!w) return base;
  const { firstWorkAt } = await loadWorkspaceCallSince(db, w.id, callId, OWN_CALLS);
  if (firstWorkAt === null) return base;
  const worked = { created_at: firstWorkAt };
  const r = w.restored_at !== null && w.restored_at > worked.created_at ? w.restored : null;
  const kept = r === null ? "The workspace kept its tree: /work/src holds the earlier session's changes, and commands it started may still run or have ended."
    : r === "kept" ? "The workspace was started again on its volume: /work/src holds the earlier session's changes, and the commands it started were stopped."
    : r === "reseed" ? "The workspace was set to a new commit: the earlier session's changes were dropped, and the commands it started were stopped."
    : r === "patch" ? "The workspace was put back to its base commit plus AutoCraft's stored patch: changes the earlier session made after that patch were lost, and the commands it started were stopped."
    : r.startsWith("checkpoint ") ? `The workspace was rebuilt from the base commit and a checkpoint of its changes taken at ${hhmm(r.slice(11))}: changes made after that were lost, and the commands it started were stopped.`
    : "The workspace was rebuilt from the base commit with no checkpoint: the earlier session's changes were lost.";
  const stat = w.checkpoint?.length && w.checkpoint_at ? `Its changes against the base commit as of ${hhmm(w.checkpoint_at)} (the last checkpoint):\n${diffStat(w.checkpoint)}\n` : "";
  return `${base}\n\n---\nNote from AutoCraft: an earlier session on this task was cut off before it finished. ${kept}\n${stat}Check the current state with \`git status\` and \`git diff --stat\` in /work/src before you continue.\n`;
}
