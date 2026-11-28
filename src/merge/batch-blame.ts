// Which PR of a red integration batch broke it, read from the failure itself: no model. A compiler error
// (`error...` followed by `--> file:line`) or a panic (`panicked at file:line`) names a line; `git blame` at the
// batch tip says which commit wrote it, and the member whose commits include it is the suspect. A named file that
// only one member changed points at that member. Nothing clear: no suspect, and the batch is rerun or split.
//
// The log is the PR's own CI output, so it is untrusted: only paths that look like plain repo paths are used
// (failureLocations in src/core/failure-locations.ts), always after `--`, and nothing of the text goes anywhere but these git calls and a short reason line.
import type { BatchGit } from "./batch-git.ts";
import type { BatchMember } from "./batch-store.ts";

import type { Location } from "../core/failure-locations.ts";

/** Locations read from a failure; more than this many are not followed. */
export const MAX_LOCATIONS = 10;
/** More suspects than this is no trace: the batch is split as before. */
export const MAX_SUSPECTS = 3;

/**
 * The members of the batch the failure points at, each with the reason in one line. A location blamed to a commit
 * of exactly one member counts for it; failing that, a located file changed by exactly one member does. A git
 * error for one location (a file not in the tree, a line past its end) just skips that location.
 */
export async function suspects(git: BatchGit, b: { base_sha: string; commit_sha: string }, members: BatchMember[], locations: Location[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (members.length < 2 || !locations.length) return out;
  const commits = new Map<number, Set<string>>();
  const files = new Map<number, Set<string>>();
  for (const m of members) {
    const revs = await git.git(["rev-list", `${b.base_sha}..${m.head_oid}`]);
    commits.set(m.number, new Set(revs.code === 0 ? revs.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : []));
    const diff = await git.git(["diff", "--name-only", "--no-renames", `${b.base_sha}...${m.head_oid}`]);
    files.set(m.number, new Set(diff.code === 0 ? diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : []));
  }
  for (const l of locations) {
    const where = `${l.file}:${l.line}`;
    const blame = await git.git(["blame", "--porcelain", "-L", `${l.line},${l.line}`, b.commit_sha, "--", l.file]);
    const sha = blame.code === 0 ? /^([0-9a-f]{40})\s/.exec(blame.stdout)?.[1] : undefined;
    const byCommit = sha ? members.filter((m) => commits.get(m.number)!.has(sha)) : [];
    if (byCommit.length === 1) {
      const n = byCommit[0]!.number;
      if (!out.has(n)) out.set(n, `the ${l.what} at ${where} is in its commit ${sha!.slice(0, 7)}`);
      continue;
    }
    const byFile = members.filter((m) => files.get(m.number)!.has(l.file));
    if (byFile.length === 1) {
      const n = byFile[0]!.number;
      if (!out.has(n)) out.set(n, `the ${l.what} is in ${where}, a file only it changed`);
    }
  }
  return out;
}
