// Evidence — pure projections and the bounded OPEN-id set transition.
//
// Everything here is plain data in, plain data out: the module holds NO collection, NO cache and NO subscription.
// The React owner (`ReaderEvidence` in DecisionEvidence.tsx) keeps the mutable OPEN set in `useState` and calls
// `changeEvidenceOpen` for every update, so the rules below are the ones the UI actually uses.

import type { Classification, Decision, ItemPageData, OpusReviewEntry } from "../../api/types.ts";

/** The most OPEN Decision identities one reader's mounted Evidence owner can remember. */
export { DISCLOSURE_OPEN_LIMIT as EVIDENCE_OPEN_LIMIT, changeDisclosureOpen as changeEvidenceOpen } from "../../ui/disclosureState.ts";

/**
 * Immutable transition for the OPEN-id set: never mutates `ids`, never stores an empty id, keeps the SAME reference
 * for a redundant open (insertion age is not refreshed) and for closing an id that is not open, and evicts the
 * OLDEST open id when an open would exceed `EVIDENCE_OPEN_LIMIT`.
 */

/** What the selected decision itself contributes, all of it already in the DTO the list loaded. */
export interface DecisionEvidenceModel {
  id: string;
  summary: { text: string; by: string; at: string } | null;
  context: string[];
  /** Merge?/Close? risks only, in native order. */
  risks: string[];
  /** Facts from original position 2 onward (the surface shows positions 0 and 1), in native order. */
  facts: string[];
  /** Every supplied classification, in native order, each with its source position as its key. */
  classifiers: { key: string; classifier: string; typeLabel: string; want: string; reason: string }[];
  asked: { by: string; at: string } | null;
  docket: string | null;
  /** True when there is something to show at all. */
  present: boolean;
}

const wantsLabel = (want: Classification["want"]) => `want ${want}`;

export function decisionEvidenceModel(d: Decision): DecisionEvidenceModel {
  const facts = (d.facts ?? []).slice(2);
  const risks = d.kind === "merge" || d.kind === "close" ? (d.risks ?? []) : [];
  const context = d.context ?? [];
  const classifiers = (d.classifications ?? []).map((c, i) => ({
    // Source position, because classifier+at is not unique (a tie run can produce both).
    key: `${c.classifier}|${c.at}|${i}`,
    classifier: c.classifier,
    typeLabel: c.typeLabel,
    want: wantsLabel(c.want),
    reason: c.reason,
  }));
  const summary = d.summary ? { text: d.summary, by: d.summaryBy, at: d.summaryAt } : null;
  const asked = d.askedBy || d.askedAt ? { by: d.askedBy, at: d.askedAt } : null;
  const present = !!(summary || context.length || risks.length || facts.length || classifiers.length || asked || d.docket);
  return { id: d.id, summary, context, risks, facts, classifiers, asked, docket: d.docket, present };
}

/** The rich item read, already masked for the reader. Nothing here is invented from fact strings or the docket. */
export interface ItemEvidenceModel {
  review: { verdict: string; head: string; current: boolean; at: string; trigger: string; summary: string | null; why: string | null; risks: string[] } | null;
  checks: { name: string; state: string }[];
  syncedAt: string | null;
  /** "pr" | "issue" from the payload, never the decision's question kind. */
  kind: "pr" | "issue" | "unknown";
  /** True when an issue has no PR review to speak of (honest wording, not an error). */
  notApplicable: boolean;
}

const VERDICT_TEXT: Record<string, string> = { take: "Take", "take-fix": "Take with fixes", hold: "Hold", close: "Close" };
const TRIGGER_TEXT: Record<string, string> = { "new-head": "new head", discussion: "discussion", operator: "asked by an operator", "model-change": "model change" };

export function itemEvidenceModel(data: ItemPageData | undefined, staff: boolean): ItemEvidenceModel | null {
  if (!data) return null;
  const kind: ItemEvidenceModel["kind"] = data.kind === "pr" ? "pr" : data.kind === "issue" ? "issue" : "unknown";
  // Only a VERIFIED PR payload may render a PR review/checks snapshot: an issue (or an unknown kind) never does,
  // even when the payload happens to carry review rows.
  const r: OpusReviewEntry | null = kind === "pr" ? (data.reviews?.latest ?? null) : null;
  const review = r
    ? {
        verdict: VERDICT_TEXT[r.verdict] ?? String(r.verdict),
        head: r.head,
        current: !!r.current,
        at: r.at,
        trigger: TRIGGER_TEXT[r.trigger] ?? String(r.trigger),
        // Staff-only fields: the server already redacts them, and the UI masks again for the unredacted mock.
        summary: staff ? r.summary || null : null,
        why: staff ? r.why || null : null,
        risks: staff ? (r.risks ?? []) : [],
      }
    : null;
  const checks = kind === "pr" ? (data.github?.checks ?? []).map((c) => ({ name: c.name, state: c.state })) : [];
  return { review, checks, syncedAt: kind === "pr" ? (data.github?.syncedAt ?? null) : null, kind, notApplicable: kind === "issue" };
}

/** Who sees the item review's staff-only fields: an operator, or a maintainer — independent of the write flag. */
export function evidenceStaff(role: string, _maintainerWrites?: boolean): boolean {
  return role === "operator" || role === "maintainer";
}

export { checkStateText } from "../../lib/status.ts";

/** The single honest message for a rejected read and for the hook's thrown `unchanged` result. */
export const EVIDENCE_READ_ERROR = "Could not read the item evidence.";
