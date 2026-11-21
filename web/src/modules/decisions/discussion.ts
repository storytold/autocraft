// Discussion — pure projections for the read-only Discussion disclosure.
//
// Plain data in, plain data out: the module holds no collection, no cache and no subscription. The React owner in
// DecisionDiscussion.tsx keeps the mutable OPEN set in `useState` and calls `changeDiscussionOpen` for every update.

import type { Decision, DecisionComment } from "../../api/types.ts";

/** The most OPEN decision identities one reader's mounted Discussion owner can remember. */
export { DISCLOSURE_OPEN_LIMIT as DISCUSSION_OPEN_LIMIT, changeDisclosureOpen as changeDiscussionOpen } from "../../ui/disclosureState.ts";

/** The single honest message for a failed or unusable thread read (never an answer/draft failure). */
export const DISCUSSION_READ_ERROR = "Could not read the decision comments.";


export interface DiscussionOpinionRow {
  key: string;
  login: string;
  at: string;
  optionKey: string | null;
  optionLabel: string | null;
  note: string | null;
  noteUnavailable: boolean;
  permission: string;
  permissionLabel: string;
  permissionGranted: boolean;
  viaMcp: boolean;
}

export interface DiscussionCommentRow {
  key: string;
  login: string;
  at: string;
  body: string;
  unavailable: boolean;
  viaMcp: boolean;
}

export interface DiscussionModel {
  opinions: DiscussionOpinionRow[];
  comments: DiscussionCommentRow[];
  empty: boolean;
}

const isBlank = (text: string | null | undefined) => text === null || text === undefined || text.trim() === "";

/**
 * Pure projection of what the frame already holds plus the thread result. No viewer argument: server-side redaction is
 * authoritative and the DTO carries no hidden-reason flag.
 */
export function discussionModel(decision: Decision, comments: readonly DecisionComment[]): DiscussionModel {
  // One local first-match lookup over the current options: O(options), not O(opinions × options).
  const labels = new Map<string, string>();
  for (const option of decision.options ?? []) if (!labels.has(option.key)) labels.set(option.key, option.label);

  const opinions = (decision.opinions ?? []).map((o, i): DiscussionOpinionRow => {
    const optionKey = o.option ?? null;
    const permission = o.permission;
    return {
      key: `opinion|${o.id}|${i}`,
      login: o.login,
      at: o.at,
      optionKey,
      optionLabel: optionKey !== null ? (labels.get(optionKey) ?? null) : null,
      note: o.note ?? null,
      noteUnavailable: o.note !== null && o.note !== undefined && isBlank(o.note),
      permission,
      permissionLabel: permission === "write" ? "GitHub write" : permission === "none" ? "No GitHub write recorded" : `Permission: ${String(permission)}`,
      permissionGranted: permission === "write",
      viaMcp: o.via === "mcp",
    };
  });

  const rows = comments.map((c, i): DiscussionCommentRow => ({
    key: `comment|${c.id}|${i}`,
    login: c.login,
    at: c.at,
    body: typeof c.body === "string" ? c.body : "",
    unavailable: isBlank(c.body),
    viaMcp: c.via === "mcp",
  }));

  return { opinions, comments: rows, empty: opinions.length === 0 && rows.length === 0 };
}
