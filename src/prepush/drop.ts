import { TERMINAL, loadTaskStates } from "../data/build/index.ts";
import { COMMENT_UNSENT_DELAYS_MS } from "../core/rules.ts";
import { loadLintingRows, supersedePatches, type LintingRow, type PatchKind } from "../data/changes/index.ts";
import { repoItemKeys } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";

/**
 * Stored patches of `kind` in the repo whose Plan no longer lists the push (head moved, a Hold or Close answer, approval revoked) are
 * superseded, unless their lint task still runs. `keep` holds the ids of the rows the Plan lists. Returns the rows superseded.
 */
export async function dropUnlistedPatches(db: Db, kind: PatchKind, repo: string, keep: ReadonlySet<number>): Promise<LintingRow[]> {
  const rows = (await loadLintingRows(db, repoItemKeys({ repos: [repo], kind: "pr" }))).filter((r) => r.kind === kind && !keep.has(r.id));
  const tasks = await loadTaskStates(db, rows.flatMap((r) => (r.lintTask === null ? [] : [r.lintTask])));
  // A CI fix whose comment did not reach GitHub is kept until its retries are used: the plan lists it again when its backoff ends.
  const drop = rows.filter((r) => {
    const t = r.lintTask === null ? undefined : tasks.get(r.lintTask);
    if (t && !TERMINAL.includes(t.state)) return false;
    return !(r.unsentSibling > 0 && r.unsentSibling <= COMMENT_UNSENT_DELAYS_MS.length);
  });
  await supersedePatches(db, drop, "the plan no longer lists the push of the stored patch");
  return drop;
}
