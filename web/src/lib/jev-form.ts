// Editing a Jev prompt in the dashboard: drafts hold the editable text of each question (its instructions after the
// locked opening, and its criteria text), and the body sent to the server is src/prompts/jev-body.ts's form.
import { jevBodyOf } from "../../../src/prompts/jev-body.ts";
import type { PromptInfo } from "../api/types";

export type JevFormQuestion = PromptInfo["questions"][number];
/** The editable text of one question. */
export type JevDraft = { instructions: string; criteria: Record<string, string> };
export type JevDrafts = Record<string, JevDraft>;

const editableOf = (q: JevFormQuestion): string => (q.instructions.startsWith(q.lead) ? q.instructions.slice(q.lead.length) : q.instructions);

/** The drafts of a prompt as it runs: what an edit starts from. */
export const jevDrafts = (questions: readonly JevFormQuestion[]): JevDrafts =>
  Object.fromEntries(questions.map((q) => [q.id, { instructions: editableOf(q), criteria: { ...(q.criteria ?? {}) } }]));

/** The body to check and save: every question with its draft text (the lead is added back by the server). */
export function jevEditedBody(questions: readonly JevFormQuestion[], drafts: JevDrafts): string {
  return jevBodyOf(Object.fromEntries(questions.map((q) => {
    const d = drafts[q.id];
    const criteria = q.criteria && Object.fromEntries(Object.keys(q.criteria).map((l) => [l, d?.criteria[l] ?? q.criteria![l]!]));
    return [q.id, { instructions: q.lead + (d?.instructions ?? editableOf(q)), lead: q.lead, criteria }];
  })));
}

/** Whether any draft differs from the text that runs. */
export const jevDraftsChanged = (questions: readonly JevFormQuestion[], drafts: JevDrafts): boolean =>
  jevEditedBody(questions, drafts) !== jevEditedBody(questions, jevDrafts(questions));
