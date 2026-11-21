// Read-only item-timeline projection and reader-local OPEN transitions.
// No cache, collection, subscription or permission policy lives at module scope.
import type { Decision, ItemPageData, TimelineEntry } from "../../api/types.ts";

export { DISCLOSURE_OPEN_LIMIT as TIMELINE_OPEN_LIMIT, changeDisclosureOpen as changeTimelineOpen } from "../../ui/disclosureState.ts";
export const TIMELINE_EVENT_LIMIT = 4;
export const TIMELINE_READ_ERROR = "Could not read the item timeline.";

export interface TimelineReference {
  repo: string;
  number: number;
}

export interface TimelineReadSnapshot {
  data: ItemPageData | undefined;
  loading: boolean;
  error: string | undefined;
}

export interface TimelineRow {
  key: string;
  text: string;
  actor: string;
  at: string;
  costUsd: number | null;
}

export interface TimelineModel {
  rows: TimelineRow[];
  empty: boolean;
}


/** Only the supplied own item reference; never infer a member from a batch or group. */
export function timelineReference(d: Pick<Decision, "repo" | "number">): TimelineReference | null {
  const { repo, number } = d;
  if (typeof repo !== "string" || repo.trim() === "" || typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  return { repo, number };
}

/** Gate the native hook's PUBLIC snapshot, without inventing inaccessible fetch/completion flags. */
export function timelineReadState(ref: TimelineReference, snapshot: TimelineReadSnapshot): "waiting" | "error" | "ready" {
  if (snapshot.error !== undefined) return "error";
  if (snapshot.loading) return "waiting";
  const data = snapshot.data;
  return data && data.repo === ref.repo && data.number === ref.number && Array.isArray(data.timeline) ? "ready" : "error";
}

/** Latest supplied positions, oldest first, including authorized conversations without mutating. */
export function timelineModel(entries: readonly TimelineEntry[]): TimelineModel {
  const rows: TimelineRow[] = [];
  const stop = Math.max(0, entries.length - TIMELINE_EVENT_LIMIT);
  for (let index = stop; index < entries.length; index++) {
    const entry = entries[index]!;
    rows.push({ key: JSON.stringify([index, entry.id]), text: entry.text, actor: entry.actor, at: entry.at, costUsd: entry.costUsd });
  }
  return { rows, empty: rows.length === 0 };
}
