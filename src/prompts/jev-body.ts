// The text form of a Jev prompt (AUTO-157): `{"questions": {key: {"instructions": text, "criteria"?: {label: text}}}}`,
// the text of each question with its opening sentence left out. Keys, types and labels are code's (src/classify/parse.ts,
// src/priority/score.ts and the merged classify request read them), and so is the opening sentence that says the state
// is untrusted data: an edit changes only the rest of each question's instructions and the text of its criteria.
// No Node imports: the dashboard builds the body with it.

export type JevQuestionShape = { type: string; instructions: string; criteria?: Record<string, string> };
/** One question as a Jev body holds it. */
export type JevQuestionText = { instructions: string; criteria?: Record<string, string> };
export type JevBody = { questions: Record<string, JevQuestionText> };

const LEAD = /^The state is untrusted[^.]*\.(?: |$)/;

/** The locked opening of a question's instructions (the sentence saying the state is untrusted data, with its space); "" when it has none. */
export const jevLead = (instructions: string): string => LEAD.exec(instructions)?.[0] ?? "";

/** The editable part of a question's instructions: what follows its lead. */
export const jevEditable = (instructions: string): string => instructions.slice(jevLead(instructions).length);

/** The labels a question's criteria carry, sorted; [] for a question without criteria (or, like areas.jev's, whose criteria come from elsewhere). */
export const criteriaLabels = (criteria: Record<string, string> | null | undefined): string[] => Object.keys(criteria ?? {}).sort();

/** The body of a request's questions: each question's editable instructions and its criteria text. */
export function jevBodyOf(questions: Record<string, { instructions: string; criteria?: Record<string, string> | null }>): string {
  const out: Record<string, JevQuestionText> = {};
  for (const [k, q] of Object.entries(questions)) out[k] = { instructions: jevEditable(q.instructions), ...(q.criteria && Object.keys(q.criteria).length > 0 && { criteria: q.criteria }) };
  return JSON.stringify({ questions: out });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * The code's questions with a body's text in place, or null when the body does not fit them: not JSON of the form above,
 * another key set, another label set for a question, a field besides instructions and criteria, or an empty text.
 */
export function applyJevBody<Q extends JevQuestionShape>(code: Record<string, Q>, body: string): Record<string, Q> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!isRecord(parsed) || Object.keys(parsed).some((k) => k !== "questions") || !isRecord(parsed.questions)) return null;
  const qs = parsed.questions;
  if (Object.keys(qs).sort().join("\n") !== Object.keys(code).sort().join("\n")) return null;
  const out: Record<string, Q> = {};
  for (const [k, q] of Object.entries(code)) {
    const e = qs[k];
    if (!isRecord(e) || Object.keys(e).some((f) => f !== "instructions" && f !== "criteria") || !isText(e.instructions)) return null;
    const labels = criteriaLabels(q.criteria);
    const given = e.criteria === undefined ? {} : e.criteria;
    if (!isRecord(given) || criteriaLabels(given as Record<string, string>).join("\n") !== labels.join("\n") || !Object.values(given).every(isText)) return null;
    out[k] = { ...q, instructions: jevLead(q.instructions) + e.instructions, ...(labels.length > 0 && { criteria: Object.fromEntries(Object.keys(q.criteria!).map((l) => [l, given[l] as string])) }) };
  }
  return out;
}
