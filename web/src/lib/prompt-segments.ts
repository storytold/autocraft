// Editing a prompt's text form in the dashboard: drafts replace the text of editable segments only, and the body sent to
// the server is the segments joined back with their lock markers (src/prompts/locks.ts).
import { joinSegments } from "../../../src/prompts/locks.ts";
import type { PromptSegment } from "../api/types.ts";

/** The edited text of editable segments, by the segment's index. */
export type Drafts = Record<number, string>;

/** The segments with the drafts applied; null when a draft names a locked or missing segment. */
export function applyDrafts(segs: readonly PromptSegment[], drafts: Drafts): PromptSegment[] | null {
  for (const k of Object.keys(drafts)) {
    const s = segs[Number(k)];
    if (!s || s.locked) return null;
  }
  return segs.map((s, i) => (drafts[i] === undefined ? s : { ...s, text: drafts[i]! }));
}

/** The body to check and save, with the lock markers; null as for applyDrafts. */
export function editedBody(segs: readonly PromptSegment[], drafts: Drafts): string | null {
  const out = applyDrafts(segs, drafts);
  return out && joinSegments(out);
}

/** A draft differs from its segment's text. */
export const draftsChanged = (segs: readonly PromptSegment[], drafts: Drafts): boolean => Object.entries(drafts).some(([k, v]) => segs[Number(k)]?.text !== v);

/** The locked blocks' names in order, which two revisions must share for drafts to carry from one to the other. */
const shape = (segs: readonly PromptSegment[]): string => segs.map((s) => (s.locked ? `L:${s.name}` : "E")).join(",");

/**
 * Drafts made against `from`, moved onto `to` (a revision someone saved meanwhile): kept by index when both have the same
 * segments, else dropped.
 */
export const carryDrafts = (from: readonly PromptSegment[], to: readonly PromptSegment[], drafts: Drafts): Drafts => (shape(from) === shape(to) ? drafts : {});
