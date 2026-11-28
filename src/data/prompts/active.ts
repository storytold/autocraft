// The process cache of the active prompt revisions, which the prompt registry reads through setPromptSource (src/prompts).
// Postgres: invalidated by the `prompts` notification topic plus a 10 s safety re-read. SQLite: the `prompts` counter is
// read on each ensure and the rows only when it moved. Every process (dashboard, runner jobs, Discord, periodic) calls
// ensurePrompts before it renders a prompt, so a save reaches the next call in any of them.
import type { Db, Subscription } from "../../db/index.ts";
import { BASE_SCOPE, GUIDANCE_PROMPT_ID, setPromptSource } from "../../prompts/index.ts";
import { loadActive } from "./revisions.ts";
import type { PromptRevision } from "./types.ts";

const SAFETY_MS = 10_000;

type Held = {
  db: Db;
  base: Map<string, PromptRevision>;
  guidance: Map<string, PromptRevision>;
  /** SQLite: the `prompts` counter the rows were read at. */
  seq: number | null;
  /** Postgres: when the rows were read; 0: invalidated. */
  at: number;
};
let held: Held | null = null;
let watching: { db: Db; sub: Subscription | null } | null = null;
let inflight: Promise<void> | null = null;
/** Bumped by every notification, so a read that began before it is not kept as fresh. */
let invalidations = 0;

setPromptSource({
  base: (id) => {
    const r = held?.base.get(id);
    return r ? { body: r.body, rev: r.rev, follows: r.follows } : null;
  },
  guidance: (repo) => held?.guidance.get(repo)?.body ?? "",
});

async function retried<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) { last = e; }
  }
  throw new Error(`cannot read the prompt revisions: ${String((last as Error)?.message ?? last).slice(0, 120)}`);
}

function hold(db: Db, rows: PromptRevision[], seq: number | null, at: number): void {
  const base = new Map<string, PromptRevision>(), guidance = new Map<string, PromptRevision>();
  for (const r of rows) {
    if (r.scope === BASE_SCOPE) base.set(r.promptId, r);
    else if (r.promptId === GUIDANCE_PROMPT_ID) guidance.set(r.scope, r);
  }
  held = { db, base, guidance, seq, at };
}

async function refresh(db: Db): Promise<void> {
  if (db.dialect === "postgres") {
    const startedAt = Date.now(), inv = invalidations;
    const rows = await retried(() => loadActive(db));
    hold(db, rows, null, inv === invalidations ? startedAt : 0);
    return;
  }
  // The counter is read before the rows, so a save between the two only makes the next ensure read again.
  const seq = (await retried(() => db.seqs(["prompts"]))).prompts ?? 0;
  if (held?.db === db && held.seq === seq) return;
  hold(db, await retried(() => loadActive(db)), seq, 0);
}

/** Subscribes the cache to the `prompts` topic through `db` (Postgres); one watch at a time, moved to the handle last ensured. */
function watch(db: Db): void {
  if (watching?.db === db) return;
  watching?.sub?.off();
  const sub = db.listen("prompts", () => { invalidations++; if (held) held.at = 0; }, { background: true });
  watching = { db, sub };
}

function fresh(db: Db): boolean {
  if (held?.db !== db) return false;
  if (db.dialect !== "postgres") return false;
  return held.at > 0 && Date.now() - held.at < SAFETY_MS && watching?.sub?.listening() === true;
}

/**
 * Brings the cache up to date for `db`: on Postgres no statement between notifications (a re-read every 10 s and while the
 * listening connection is down); on SQLite one counter read, and the rows only when it moved. Throws when the revisions
 * cannot be read: a prompt never runs as its code default because the read failed.
 */
export async function ensurePrompts(db: Db): Promise<void> {
  watch(db);
  if (fresh(db)) return;
  const p = (inflight ??= refresh(db).finally(() => { inflight = null; }));
  await p;
  // A read for another handle was under way: read again for this one.
  if (held?.db !== db) await ensurePrompts(db);
}

/** The active revision of a prompt in a scope ("base", or a repo for its guidance), as last ensured. */
export function activeRow(promptId: string, scope: string): PromptRevision | null {
  return (scope === BASE_SCOPE ? held?.base.get(promptId) : promptId === GUIDANCE_PROMPT_ID ? held?.guidance.get(scope) : undefined) ?? null;
}

/** A repository's guidance text, as last ensured; "" for none. */
export const guidanceOf = (repo: string): string => held?.guidance.get(repo)?.body ?? "";
