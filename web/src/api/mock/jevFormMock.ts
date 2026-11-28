// Mock data for the Jev form: classify.jev's questions as the registry has them, a draft with one edited instruction and
// criterion, and the problems a check names for an emptied criterion.
import { promptsReport } from "../../../../src/prompts/index.ts";
import { jevDrafts, type JevDrafts, type JevFormQuestion } from "../../lib/jev-form";

export const JEV_FORM_PROMPT = "classify.jev";

export const jevFormQuestions = (): JevFormQuestion[] => promptsReport(null).prompts.find((p) => p.id === JEV_FORM_PROMPT)?.questions ?? [];

/** A draft that tightens the security question and leaves the infra criterion empty. */
export function jevFormDraft(): JevDrafts {
  const d = jevDrafts(jevFormQuestions());
  const security = d.security, type = d.type;
  if (security) security.instructions = `${security.instructions} A missing permission check on a write counts as a hole.`;
  if (type) type.criteria = { ...type.criteria, infra: "" };
  return d;
}

export const JEV_FORM_PROBLEMS = [{ where: "question type criterion infra", message: "the text cannot be empty" }];
