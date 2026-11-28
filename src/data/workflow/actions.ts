// Person actions: `workflow_actions` (M11 workflow-b).
// reads: mirror.items
import type { Db, Param } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { ActionKind, ActionState, DueAction, NewAction, RefKey, WorkflowAction } from "./types.ts";
import { groupBy, patchRows } from "./update.ts";

const T = "main.workflow_actions";
const RESETS = ["failed", "stopped"];
const WAITING = ["waiting-token", "waiting-permission"];
const refKey = (r: { repo: string; number: number }): RefKey => `${r.repo}#${r.number}`;

/**
 * Batched upsert; an existing `failed` or `stopped` row goes back to the new request (`pending`, or the given state) with attempts 0
 * and its reason, comment and end time cleared; any other existing row is left as it is. Returns the row id per `repo#number:kind`.
 */
export async function queueActions(db: Db, rows: NewAction[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = new Map(rows.map((r) => [`${r.workflowId}:${r.kind}:${r.repo}#${r.number}`, r]));
  if (!unique.size) return out;
  const q = queryDb(db);
  const now = new Date().toISOString();
  await db.write(async () => {
    for (const part of kx.batches([...unique.values()])) {
      const got = await q.all(q.k.insertInto(T).values(part.map((r) => ({
        workflow_id: r.workflowId, repo: r.repo, number: r.number, kind: r.kind, by: r.by, head: r.head, state: r.state ?? "pending", attempts: 0, close_as: r.closeAs ?? null,
        created_at: r.at ?? now, updated_at: r.at ?? now,
      }))).onConflict((oc) => oc.columns(["workflow_id", "kind", "repo", "number"]).doUpdateSet((eb) => {
        // A new ask of the author takes the place of the one before, whatever became of it.
        const resets = eb.or([eb(`${T}.state` as any, "in", RESETS), eb(`${T}.kind` as any, "=", "ask-author")]);
        const reset = (col: string, value: any) => eb.case().when(resets).then(value).else(eb.ref(`${T}.${col}` as any)).end();
        return {
          by: reset("by", eb.ref("excluded.by")), head: reset("head", eb.ref("excluded.head")), state: reset("state", eb.ref("excluded.state")),
          attempts: reset("attempts", eb.lit(0)), reason: reset("reason", eb.lit(null)), comment_url: reset("comment_url", eb.lit(null)),
          done_at: reset("done_at", eb.lit(null)), close_as: reset("close_as", eb.ref("excluded.close_as")), updated_at: reset("updated_at", eb.ref("excluded.updated_at")),
        } as any;
      })).returning(["id", "repo", "number", "kind"]));
      for (const g of got) out.set(`${refKey(g)}:${g.kind}`, g.id);
    }
  });
  return out;
}

/** `pending` rows with the workflow's weight and the item's open state and head, by weight (highest first) then `created_at`. */
export async function loadActionsDue(db: Db, f?: { repos?: string[]; kinds?: ActionKind[]; refs?: { repo: string; number: number }[] }): Promise<DueAction[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workflow_actions as a")
    .leftJoin("main.item_workflows as w", "w.id", "a.workflow_id")
    .leftJoin("main.items as i", (j) => j.onRef("i.repo", "=", "a.repo").onRef("i.number", "=", "a.number"))
    .select(kx.cols(T, "a"))
    .select((eb) => [eb.fn.coalesce("w.weight", eb.lit(5)).as("weight"), "i.state as itemState", "i.head_oid as itemHead"])
    .where("a.state", "=", "pending")
    .$if(!!f?.repos, (b) => b.where(kx.inList(db, "a.repo", f!.repos!)))
    .$if(!!f?.kinds, (b) => b.where(kx.inList(db, "a.kind", f!.kinds!)))
    .$if(!!f?.refs, (b) => b.where(kx.refIn(db, "a", f!.refs!.map((r): [string, number] => [r.repo, r.number]))))
    .orderBy("weight", "desc").orderBy("a.created_at").orderBy("a.id"));
  return rows as unknown as DueAction[];
}

/**
 * Batched update that writes only when the state or, when given, the reason, the comment or the tries differ from the stored row, so a
 * repeated waiting state wakes nothing. `done` also sets `done_at`. `from`: only rows still in one of these states.
 */
export async function saveActions(db: Db, rows: { id: number; state: ActionState; reason?: string | null; commentUrl?: string | null; attempts?: number; at: string }[], o: { from?: readonly ActionState[] } = {}): Promise<void> {
  const last = [...new Map(rows.map((r) => [r.id, r])).values()];
  if (!last.length) return;
  const shape = (r: (typeof rows)[number]) => [r.reason !== undefined, r.commentUrl !== undefined, r.attempts !== undefined, r.state === "done"] as const;
  await db.write(async () => {
    for (const group of groupBy(last, (r) => shape(r).join())) {
      const [reason, url, attempts, done] = shape(group[0]);
      const set: Record<string, kx.ElemType> = { state: "text", updated_at: "text", ...(reason ? { reason: "text" } : {}), ...(url ? { comment_url: "text" } : {}), ...(attempts ? { attempts: "bigint" } : {}), ...(done ? { done_at: "text" } : {}) };
      const values = group.map((r): Record<string, Param> => ({
        id: r.id, state: r.state, updated_at: r.at, ...(reason ? { reason: r.reason ?? null } : {}), ...(url ? { comment_url: r.commentUrl ?? null } : {}),
        ...(attempts ? { attempts: r.attempts! } : {}), ...(done ? { done_at: r.at } : {}),
      }));
      await patchRows(db, T, { id: "bigint" }, set, values, {
        when: (eb) => eb.and([
          eb.or([
            eb(`${T}.state`, "is distinct from", eb.ref("v.state")),
            ...(reason ? [eb(`${T}.reason`, "is distinct from", eb.ref("v.reason"))] : []),
            ...(url ? [eb(`${T}.comment_url`, "is distinct from", eb.ref("v.comment_url"))] : []),
            ...(attempts ? [eb(`${T}.attempts`, "is distinct from", eb.ref("v.attempts"))] : []),
          ]),
          ...(o.from ? [eb(`${T}.state`, "in", [...o.from])] : []),
        ]),
      });
    }
  });
}

/** Actions per item (oldest first), for items, workflows, kinds, states, or the rows waiting for one login's token or permission. With no filter, every action. */
export async function loadActions(db: Db, f: { refs?: { repo: string; number: number }[]; workflowIds?: number[]; waitingFor?: string; kinds?: readonly ActionKind[]; states?: readonly ActionState[] }): Promise<Map<RefKey, WorkflowAction[]>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workflow_actions as a").select(kx.cols(T, "a"))
    .$if(!!f.refs, (b) => b.where(kx.refIn(db, "a", f.refs!.map((r): [string, number] => [r.repo, r.number]))))
    .$if(!!f.workflowIds, (b) => b.where(kx.inList(db, "a.workflow_id", f.workflowIds!, "bigint")))
    .$if(!!f.kinds, (b) => b.where(kx.inList(db, "a.kind", [...f.kinds!])))
    .$if(!!f.states, (b) => b.where(kx.inList(db, "a.state", [...f.states!])))
    .$if(f.waitingFor !== undefined, (b) => b.where("a.state", "in", WAITING).where((eb) => kx.ciEq(db, "a.by", eb.val(f.waitingFor!))))
    .orderBy("a.id"));
  const out = new Map<RefKey, WorkflowAction[]>();
  for (const r of rows as unknown as WorkflowAction[]) (out.get(refKey(r)) ?? out.set(refKey(r), []).get(refKey(r))!).push(r);
  return out;
}

/** Returns `waiting-token` and `waiting-permission` rows of `login` (any case), and the rows `ids` names when waiting or `failed`, to `pending` with attempts 0 and no reason. Returns the rows moved. */
export async function retryActions(db: Db, f: { login?: string; ids?: number[] }): Promise<number> {
  if (f.login === undefined && !f.ids?.length) return 0;
  const q = queryDb(db);
  return await db.write(async () => Number((await q.run(q.k.updateTable(T)
    .set({ state: "pending", attempts: 0, reason: null, updated_at: new Date().toISOString() })
    .where((eb) => eb.or([
      ...(f.login !== undefined ? [eb.and([eb("state", "in", WAITING), kx.ciEq(db, "by", eb.val(f.login))])] : []),
      ...(f.ids?.length ? [eb.and([kx.inList(db, "id", f.ids, "bigint"), eb("state", "in", [...WAITING, "failed"])])] : []),
    ])))).changes));
}
