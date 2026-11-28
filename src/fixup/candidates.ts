// What the fix-up step works on (the PRs come from their Plans, fixup/select.ts): candidate shapes, fix lists and tries.
import { safePath } from "./patch.ts";
import { attemptsIn, loadPatchFacts } from "../data/changes/index.ts";
import type { ConflictCandidate } from "./conflict-state.ts";
import { FIXUP_MAX_ATTEMPTS } from "../core/rules.ts";
import type { Db } from "../db/index.ts";

/** Fix-up tries per PR (pushed, failed, refused or rejected) before the step leaves it to a person. */
export const MAX_ATTEMPTS = FIXUP_MAX_ATTEMPTS;

export type Fix = { file: string; change: string };
/** `model` wrote the text the ask comment carries: the Opus review's fix list. */
export type FixCandidate = { repo: string; number: number; head: string; reason: string; fixes: Fix[]; attempt: number; model: string | null;
  /** `premerge`: the fixes are the pre-merge review's defect fixes; a pre-merge round (up to PREMERGE_FIX_ROUNDS per PR), apart from the take-fix tries. */
  source?: "premerge" | "operator";
  /** An operator's fix-up (source `operator`): the instructions replace the fix list; the files are the PR's own changed files. */
  operator?: { id: number; instructions: string };
  /** A stored model patch whose lint task ended: the collect step pushes it with the format changes folded in, or asks the model again with the findings. */
  lint?: LintWork };
/** The fixups row of a stored patch: `lint_state` is `pending` (first task) or `requeued` (the lost task was queued once more). */
export type LintWork = { rowid: number; round: number; task: number | null; state: string; patch: string; /** The kept model session that wrote the patch (src/prepush/resume.ts). */ session: string | null; /** The fix session turn (fix_session_turns.id) that wrote the patch; null for a patch of the patch path. */ sessionTurn: number | null; /** An operator fix-up model's list of what the patch changes. */ changes: string[] };
export type FixSelection = {
  /** Take-fix PRs we may push to, with our push approved. */
  fix: FixCandidate[];
  /** Take-fix PRs we can't push to that have no hold row at this head yet. */
  cannotPush: FixCandidate[];
  /** Take-fix PRs we can't push to, in a repo with comment approval, with no comment at this head yet. */
  ask: FixCandidate[];
  /** Stored patches whose lint task ended (the Plan's `lint` action, step fixup). */
  lint: FixCandidate[];
  /** The rowids of every stored patch the Plan lists, also those that may not be pushed now: they are kept. */
  listed: number[];
  /** The rowids of every stored conflict resolution the Plan lists, also those that may not be pushed now: they are kept. */
  conflictListed: number[];
  /** Conflicted take / take-fix PRs we may push to: the default branch is merged in. */
  conflictMerge: ConflictCandidate[];
  /** Conflicted PRs we can't push to, in a repo with comment approval, with no comment at this head yet. */
  conflictAsk: ConflictCandidate[];
};

export function parseFixes(s: string | null): Fix[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((f): f is Fix => !!f && typeof f.file === "string" && typeof f.change === "string" && safePath(f.file)) : [];
  } catch { return []; }
}

export const FIXUP_STATES = ["pushing", "pushed", "failed", "refused", "rejected", "cannot-push", "too-large", "asked", "comment-failed", "comment-unsent", "push-denied", "superseded"] as const;
export type FixupState = (typeof FIXUP_STATES)[number];

export { attemptsIn } from "../data/changes/index.ts";

/** Refusals for a wrong hunk header count (fixed by recounting since) are not tries. Pre-merge rounds have their own budget. */
export async function attemptsOf(db: Db, repo: string, number: number): Promise<number> {
  return attemptsIn((await loadPatchFacts(db, [{ repo, number }])).get(`${repo}#${number}`)?.fixups ?? []);
}
