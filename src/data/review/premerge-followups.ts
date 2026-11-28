// premerge_followups and review_followups: the follow-up issue of a PR approved for merge. One row per PR head whose pre-merge review
// (premerge) or Opus review (review) found something that does not stop the merge; both tables have the same columns.
import type { Selectable } from "kysely";
import type { Db } from "../../db/index.ts";
import type { DB } from "../../db/types.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { noKeys, pushTo, refKey } from "./rows.ts";
import type { RefKey } from "./types.ts";

export type PremergeFollowupRow = Selectable<DB["premerge_followups"]>;
/** What a follow-up row files: the Opus review's fixes and hold that do not block, or the pre-merge review's defects that do not block. */
export type FollowupSource = "review" | "premerge";

// The tables have the same columns, so one typing serves both.
const tableOf = (s: FollowupSource) => (s === "review" ? "main.review_followups" : "main.premerge_followups") as "main.premerge_followups";
const colsOf = (s: FollowupSource) => kx.cols(s === "review" ? "review_followups" : "premerge_followups", "f") as ReturnType<typeof kx.cols<"premerge_followups", "f">>;

/** The rows of each PR of one source, oldest first. */
export async function loadFollowupRows(db: Db, keys: KeySource, source: FollowupSource): Promise<Map<RefKey, PremergeFollowupRow[]>> {
  const out = new Map<RefKey, PremergeFollowupRow[]>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(`${tableOf(source)} as f`).innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "f.repo").onRef("kk.number", "=", "f.number"))
    .select(colsOf(source)).orderBy("f.at").orderBy("f.head_oid"));
  for (const r of rows) pushTo(out, refKey(r.repo, r.number), { ...r, number: Number(r.number), issue_number: r.issue_number === null ? null : Number(r.issue_number) });
  return out;
}

/** The pre-merge rows of each PR, oldest first. */
export const loadPremergeFollowups = (db: Db, keys: KeySource): Promise<Map<RefKey, PremergeFollowupRow[]>> => loadFollowupRows(db, keys, "premerge");

/**
 * The times of a head's tries that sent nothing (no app token, write pacing, GitHub's rate limit): an `unsent` row keeps them in `note`
 * as a JSON list, and keeps them while its retry is `filing`. Empty for any other row.
 */
export function unsentTries(r: Pick<PremergeFollowupRow, "state" | "note"> | undefined): string[] {
  if (!r || (r.state !== "unsent" && r.state !== "filing") || !r.note?.startsWith("[")) return [];
  try {
    const v = JSON.parse(r.note) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/** Writes a head's row in state `filing`, or takes over its `unsent` row, or its `filing` row left before `staleBefore` (ISO) by a job that ended, for the retry (keeping its tries); false when the head has another (filed, failed, or being filed). */
export async function claimFollowup(db: Db, r: { repo: string; number: number; source: FollowupSource; head: string; at: string; staleBefore: string }): Promise<boolean> {
  const q = queryDb(db);
  const got = await q.all(q.k.insertInto(tableOf(r.source))
    .values({ repo: r.repo, number: r.number, head_oid: r.head, issue_number: null, url: null, state: "filing", at: r.at, note: null })
    .onConflict((oc) => oc.columns(["repo", "number", "head_oid"]).doUpdateSet({ state: "filing", at: r.at }).where((eb) => eb.or([eb(`${tableOf(r.source)}.state`, "=", "unsent"), eb.and([eb(`${tableOf(r.source)}.state`, "=", "filing"), eb(`${tableOf(r.source)}.at`, "<", r.staleBefore)])])))
    .returning(["head_oid"]));
  return got.length > 0;
}

/** Settles a head's row: filed with the issue it opened or commented on, or failed with GitHub's reason. */
export async function settleFollowup(db: Db, r: { repo: string; number: number; source: FollowupSource; head: string; at: string; state: "filed" | "failed"; issue?: { number: number; url: string } | null; note?: string | null }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable(tableOf(r.source))
    .set({ state: r.state, at: r.at, issue_number: r.issue?.number ?? null, url: r.issue?.url ?? null, note: r.note ?? null })
    .where("repo", "=", r.repo).where("number", "=", r.number).where("head_oid", "=", r.head));
}

/** Records a head's `filing` row as `unsent` after a write that sent nothing, with the times of all such tries (`tries`), so it is tried again after a backoff. */
export async function deferFollowup(db: Db, r: { repo: string; number: number; source: FollowupSource; head: string; at: string; tries: readonly string[] }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable(tableOf(r.source)).set({ state: "unsent", at: r.at, note: JSON.stringify(r.tries) })
    .where("repo", "=", r.repo).where("number", "=", r.number).where("head_oid", "=", r.head).where("state", "=", "filing"));
}
