// The reuse key of a remote call: a resumed job adopts a call of its earlier run with the same key instead of asking again
// (src/data/runners/calls-queue.ts). The key covers what the model is asked about: the prompt, the items, the text and the
// checkouts the call names (the item's own checkout at /repo is the head under review). It leaves out the context that moves
// while the question stays the same: the workspace checkouts at /repos/<name> follow every tracked repo's default branch and
// start empty after a restart, and the MCP servers follow whether the item snapshot exists yet.
import { createHash } from "node:crypto";
import type { ItemRef } from "../../web/src/api/types.ts";
import { REPOS_ROOT } from "../sandbox/command.ts";
import type { TaskBundle } from "./protocol.ts";

/** JSON with object keys sorted, so equal values give equal text. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const inWorkspace = (path: string): boolean => path.startsWith(`${REPOS_ROOT}/`);

/**
 * The `claude` hints without what follows the snapshot and the workspace: the directory, agents and MCP configuration arguments and
 * the allowed-tool entries that name an MCP tool or a workspace path. The other arguments (tools, effort, permissions, system prompt)
 * say what the call may do, so a call asked again with other ones is a different call.
 */
function askedHints(hints: TaskBundle["hints"] | undefined): unknown {
  const c = hints?.claude;
  if (!c) return null;
  const args: string[] = [];
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i]!;
    if (a === "--add-dir" || a === "--agents" || a === "--mcp-config") { i++; continue; }
    if (a === "--allowedTools" && i + 1 < c.args.length) {
      args.push(a, c.args[++i]!.split(",").filter((t) => !t.startsWith("mcp__") && !t.includes(`${REPOS_ROOT}/`)).join(","));
      continue;
    }
    args.push(a);
  }
  return { args };
}

/** The reuse key of a call with `bundle` naming `items` (in any order). */
export function reuseKey(bundle: Omit<TaskBundle, "callId">, items: readonly ItemRef[]): string {
  const { mcpServers: _servers, hints, mounts, ...asked } = bundle;
  const refs = [...new Set(items.map((i) => `${i.repo}#${i.number}`))].sort();
  const key = { ...asked, hints: askedHints(hints), mounts: (mounts ?? []).filter((m) => !inWorkspace(m.path)), items: refs };
  return createHash("sha256").update(canonicalJson(key)).digest("hex");
}
