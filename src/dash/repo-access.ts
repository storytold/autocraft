// Who may run a repo: an operator, or a maintainer with GitHub write permission on it (read live, cached per session).
// Per-repo and per-item actions use this; instance-wide AutoCraft internals stay operator-only.
import type { Db } from "../db/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import type { User } from "./types.ts";

export async function mayRunRepo(user: Pick<User, "role" | "canWrite">, repo: string): Promise<boolean> {
  if (user.role === "operator") return true;
  return user.role === "maintainer" && await user.canWrite(repo).catch(() => false);
}

/**
 * Who may change the instance-wide prompts: an operator, or a maintainer with write permission on at least one tracked
 * repo with the pipeline on. A repo's guidance is per repo instead (mayRunRepo).
 */
export async function mayEditBasePrompts(db: Db, user: Pick<User, "role" | "canWrite">): Promise<boolean> {
  if (user.role === "operator") return true;
  if (user.role !== "maintainer") return false;
  for (const r of (await loadTrackedRepos(db)).values()) if (r.pipeline && await user.canWrite(r.name).catch(() => false)) return true;
  return false;
}
