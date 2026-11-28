// The instructions a person started an issue's implementation with ("implement: store the setting per document", "fix the crash on
// empty files"): the words after fix in the started event of the issue's live workflow. A resume starts a new workflow with a resumed
// event, so a workflow without a start of its own goes back to the held one its resume went on with. The plan call and the
// implementation session read them whole, as that person's guidance, in every attempt of the workflow.
import { listWorkflows, loadEvents } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

export type StartGuidance = { by: string; at: string; text: string };

export async function startGuidance(db: Db, repo: string, number: number): Promise<StartGuidance | null> {
  const wf = (await listWorkflows(db, { live: true, refs: [{ repo, number }] }))[0];
  if (!wf || wf.kind !== "issue" || wf.entry !== "implement") return null;
  const events = (await loadEvents(db, [{ repo, number }])).get(`${repo}#${number}`) ?? [];
  let id = wf.id;
  // Events come in the order they were written; a resume goes on with the latest hold before it of another workflow.
  for (let hops = 0; hops <= events.length; hops++) {
    const started = events.find((e) => e.workflowId === id && e.kind === "started");
    if (started) {
      const p = started.parsed;
      if (p?.kind !== "commands") return null;
      for (const x of p.parts) if (x.word === "fix" && typeof x.part === "string" && x.text) return { by: started.login, at: started.at, text: x.text };
      return null;
    }
    const resumed = events.findIndex((e) => e.workflowId === id && e.kind === "resumed");
    if (resumed < 0) return null;
    const held = events.slice(0, resumed).findLast((e) => e.kind === "stopped" && e.workflowId !== null && e.workflowId !== id);
    if (!held) return null;
    id = held.workflowId!;
  }
  return null;
}
