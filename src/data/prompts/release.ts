// The release flag of an edited prompt, computed when it is read and never stored: whether the running release's default
// differs from the one the active edit was made against, whether the edit still fits the release's structure, and what the
// release changed in the default since the edit.
import type { Db } from "../../db/index.ts";
import { lineDiff, type DiffLine } from "../../prompts/diff.ts";
import { BASE_SCOPE, CLAUDE_PROMPTS, codeBody, codeDefault, type ClaudePromptId, type JevPromptId } from "../../prompts/index.ts";
import { mergeEdit, stripLocks } from "../../prompts/locks.ts";
import { listRevisions } from "./revisions.ts";

export type ReleaseFlag = {
  /** The active revision is an edit made against an older default than the running release's. */
  newerDefault: boolean;
  /** The edit no longer fits the release's locked blocks or placeholders, so the release's own text runs. */
  structureChanged: boolean;
  /** From the default the edit was made against to the running one; null without a newer default or when that default's text is not stored. */
  diff: DiffLine[] | null;
};

/** How a body reads in a diff: a Claude prompt's text without markers, a Jev body as indented JSON. */
const shown = (id: string, body: string): string => {
  if (id in CLAUDE_PROMPTS) return stripLocks(body);
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
};

/** The release flag of a base prompt, read from the database (not the process cache), so it is accurate right after a save. */
export async function releaseFlag(db: Db, id: ClaudePromptId | JevPromptId): Promise<ReleaseFlag> {
  const revs = await listRevisions(db, id, BASE_SCOPE);
  const active = revs.find((r) => r.active);
  if (!active || active.follows) return { newerDefault: false, structureChanged: false, diff: null };
  const now = codeDefault(id);
  const structureChanged = id in CLAUDE_PROMPTS && mergeEdit(codeBody(id as ClaudePromptId), active.body) === null;
  const newerDefault = active.defaultHash !== now.version;
  const base = newerDefault ? revs.find((r) => r.follows && r.version === active.defaultHash) : undefined;
  return { newerDefault, structureChanged, diff: base ? lineDiff(shown(id, base.body), shown(id, now.body)) : null };
}
