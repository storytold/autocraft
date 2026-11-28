// Ends integration batches for the merge controls: take one PR out of its batch, or end a batch. Holding the PRs is the workflow's
// (src/workflow/batch.ts). Both close the batch's integration PR through src/github/write.ts (audited, on the GitHub activity page);
// the exec that runs `gh` is injectable.
import { guardRepo } from "../core/guard.ts";
import { repoInScope } from "../core/scope.ts";
import { type Exec, exec as defaultExec } from "../fixup/git.ts";
import { ghClosePr } from "../github/write.ts";
import { ACTIVE_BATCH, cancelBuild } from "./batch-store.ts";
import { slugOf } from "../owners.ts";
import { addAudit } from "../data/control/index.ts";
import { endBatches, getBatch, loadBatchRun, updateBatches } from "../data/merge/index.ts";
import type { BatchView } from "../data/merge/types.ts";
import { loadPrWorkflows, loadRepoScopes } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

export class ControlError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

const refOf = (repo: string, number: number): string => `${repo}#${number}`;

/** What becomes of pull requests whose batch closes, as a sentence of its closing comment: in a repo whose Pipeline is off only started ones go on. `others`: the batch had more. */
export async function afterBatch(db: Db, repo: string, numbers: readonly number[], others: boolean): Promise<string> {
  if (!numbers.length) return "";
  const rebuilt = `${others ? "The other pull requests" : "The pull requests"} are rebuilt in a new batch.`;
  const [scopes, live] = await db.together(() => Promise.all([loadRepoScopes(db, [repo]), loadPrWorkflows(db, numbers.map((number) => ({ repo, number })))]));
  const idle = repoInScope(scopes.get(repo), "builds") ? [] : numbers.filter((n) => !live.has(refOf(repo, n)));
  if (!idle.length) return ` ${rebuilt}`;
  const wait = `The repo's pipeline is off, so ${idle.map((n) => `#${n}`).join(", ")} ${idle.length === 1 ? "waits until someone starts it" : "wait until someone starts them"} or the pipeline is on again`;
  return ` ${wait}${idle.length < numbers.length ? "; the others are rebuilt in a new batch" : ""}.`;
}

/** The active merge train cars built on `id`, directly or on one built on it. */
function carsAbove(active: readonly BatchView[], id: number): BatchView[] {
  const out: BatchView[] = [];
  for (let level = [id]; level.length;) {
    const next = active.filter((b) => b.below_id !== null && b.below_id !== undefined && level.includes(b.below_id) && !out.includes(b));
    out.push(...next);
    level = next.map((b) => b.id);
  }
  return out;
}

/**
 * Marks the batch superseded and closes its integration PR, when it has one; the row goes back to its state if the close fails, so a later
 * Stop, Remove or merge run retries. The merge train cars built on it end in the same write, so none of them can land on a car that
 * will not, and their PRs are closed after the batch's. The PRs go back to the queue; the next merge run builds batches from what is eligible.
 */
async function endBatch(db: Db, by: string, id: number, why: string, comment: string, run: Exec, after = ""): Promise<{ closed: number | null }> {
  const b = (await getBatch(db, id))!;
  const above = carsAbove((await loadBatchRun(db, b.repo)).active, id);
  for (const x of [b, ...above]) await cancelBuild(db, x, by);
  const now = new Date().toISOString();
  const aboveWhy = `the car below it, ${b.branch}, was ended: ${why}`;
  await updateBatches(db, [{ id, at: now, set: { state: "superseded", summary: why } }, ...above.map((x) => ({ id: x.id, at: now, set: { state: "superseded" as const, summary: aboveWhy } }))]);
  const restore = async () => await updateBatches(db, [b, ...above].map((x) => ({ id: x.id, at: new Date().toISOString(), set: { state: x.state, summary: x.summary } })));
  const closeAbove = async () => {
    const open = above.filter((x) => x.pr_number !== null);
    if (!open.length) return;
    const g = await guardRepo(db, b.repo, null, { operator: by });
    if ("refused" in g) return;
    for (const x of open) await ghClosePr({ db, login: by }, g, run, { repo: b.repo, number: x.pr_number! }, { by: "fixed-operator" }, `Closing: ${aboveWhy}. Its pull requests go back to the queue.`, { batch: x.branch });
  };
  if (b.pr_number === null) { await closeAbove(); return { closed: null }; }
  const g = await guardRepo(db, b.repo, null, { operator: by });
  const r = "refused" in g ? { code: 1, stdout: "", stderr: g.refused }
    : await ghClosePr({ db, login: by }, g, run, { repo: b.repo, number: b.pr_number }, { by: "fixed-operator" }, `Closing: ${comment}.${after}`, { batch: b.branch });
  if (r.code !== 0) {
    const state = await run("gh", ["pr", "view", String(b.pr_number), "--repo", `${slugOf(b.repo)}`, "--json", "state", "--jq", ".state"]);
    if (state.code === 0 && state.stdout.trim() === "MERGED") {
      // The merge went through while the batch was being ended: the merge bookkeeping records it.
      const at = new Date().toISOString();
      await endBatches(db, [{
        id, state: "merged", summary: null,
        stage: b.members.map((m) => ({ repo: b.repo, number: m.number, stage: "merged", at, actor: by, note: `merge in ${b.branch} at ${m.head_oid.slice(0, 7)}` })),
        audit: [{ at, actor: by, action: "batch-end-too-late", target: `${b.repo}:${b.branch}`, details: { pr: b.pr_number } }],
      }]);
      // The cars above stand on a car that landed: they go on.
      if (above.length) await updateBatches(db, above.map((x) => ({ id: x.id, at: new Date().toISOString(), set: { state: x.state, summary: x.summary } })));
      return { closed: null };
    }
    await restore();
    throw new ControlError(`the batch PR #${b.pr_number} could not be closed: ${r.stderr.replace(/\s+/g, " ").trim().slice(0, 200)}`, 502);
  }
  await closeAbove();
  return { closed: b.pr_number };
}

/** The batch, which must be in flight. */
export async function activeBatch(db: Db, id: number) {
  const b = Number.isInteger(id) ? await getBatch(db, id) : undefined;
  if (!b) throw new ControlError(`no batch ${id}`, 404);
  if (!ACTIVE_BATCH.includes(b.state)) throw new ControlError(`batch ${b.branch} is ${b.state}, not in flight`);
  return b;
}

/** The batch in flight that holds the PR. */
export async function batchOf(db: Db, repo: string, number: number) {
  const b = (await loadBatchRun(db, repo)).active.find((x) => x.members.some((m) => m.number === number));
  if (!b) throw new ControlError(`${refOf(repo, number)} is not in a batch in flight`);
  return b;
}

/** Ends the batch a person stopped, whose PRs are held: closes its integration PR. */
export async function endStoppedBatch(db: Db, by: string, b: { id: number; repo: string; branch: string }, prs: readonly number[], run: Exec = defaultExec): Promise<{ closed: number | null }> {
  await addAudit(db, [{ login: by, action: "batch-stop", target: `${b.repo}:${b.branch}`, details: { prs } }]);
  return await endBatch(db, by, b.id, `stopped in AutoCraft by ${by}`, `the batch was stopped in AutoCraft by ${by}. Its pull requests are on hold`, run);
}

/** Ends the PR's batch: the others go back to the queue, and the next merge run builds a batch of those it works. A hold has ended the PR's workflow before, so that batch leaves it out. */
export async function removeFromBatch(db: Db, by: string, repo: string, number: number, run: Exec = defaultExec): Promise<{ batch: string; closed: number | null }> {
  const b = await batchOf(db, repo, number);
  await addAudit(db, [{ login: by, action: "batch-remove", target: refOf(repo, number), details: { batch: b.branch } }]);
  const after = await afterBatch(db, repo, b.members.map((m) => m.number).filter((n) => n !== number), true);
  const { closed } = await endBatch(db, by, b.id, `${refOf(repo, number)} was removed in AutoCraft by ${by}`, `${refOf(repo, number)} was removed from the batch in AutoCraft by ${by}`, run, after);
  return { batch: b.branch, closed };
}
