// The instructions a person started an issue's implementation with ("implement: store the setting per document", "fix the crash on
// empty files"): the words after fix in the started event of the issue's live workflow. The plan call and the implementation session read
// them whole, as that person's guidance, in every attempt of the workflow.
import { listWorkflows, loadEvents } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

export type StartGuidance = { by: string; at: string; text: string };

export async function startGuidance(db: Db, repo: string, number: number): Promise<StartGuidance | null> {
  const wf = (await listWorkflows(db, { live: true, refs: [{ repo, number }] }))[0];
  if (!wf || wf.kind !== "issue" || wf.entry !== "implement") return null;
  const started = ((await loadEvents(db, [{ repo, number }])).get(`${repo}#${number}`) ?? []).find((e) => e.workflowId === wf.id && e.kind === "started");
  const p = started?.parsed;
  if (!started || p?.kind !== "commands") return null;
  for (const x of p.parts) if (x.word === "fix" && typeof x.part === "string" && x.text) return { by: started.login, at: started.at, text: x.text };
  return null;
}
