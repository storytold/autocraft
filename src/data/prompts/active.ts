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
  base: Map<string, PromptRevision>;
  guidance: Map<string, PromptRevision>;
  /** SQLite: the `prompts` counter the rows were read at. */
  seq: number | null;
  /** Postgres: when the rows were read; 0: invalidated. */
  at: number;
};
/**
 * The cache of one handle: the rows read through it, its subscription and its read under way. A process reads through one
 * handle; an ensure through another starts a new cache on it, so rows, counter and notifications always come from one handle.
 */
type Cache = {
  db: Db;
  sub: Subscription | null;
  held: Held | null;
  inflight: Promise<void> | null;
  /** Bumped by every notification, so a read that began before it is not kept as fresh. */
  invalidations: number;
};
let cache: Cache | null = null;
/**
 * The rows prompts render from: the current cache's once its first read succeeded, until then the rows of the handle before
 * it, so a render during a switch of handles never falls back to the code defaults.
 */
let served: Held | null = null;

setPromptSource({
  base: (id) => {
    const r = served?.base.get(id);
    return r ? { body: r.body, rev: r.rev, follows: r.follows } : null;
  },
  guidance: (repo) => served?.guidance.get(repo)?.body ?? "",
});

/** The waits before the second and third try of a read. */
const RETRY_MS = [100, 300];

async function retried<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= RETRY_MS.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, RETRY_MS[i - 1]));
    try {
      return await fn();
    } catch (e) { last = e; }
  }
  throw new Error(`cannot read the prompt revisions: ${String((last as Error)?.message ?? last).slice(0, 120)}`);
}

function hold(c: Cache, rows: PromptRevision[], seq: number | null, at: number): void {
  const base = new Map<string, PromptRevision>(), guidance = new Map<string, PromptRevision>();
  for (const r of rows) {
    if (r.scope === BASE_SCOPE) base.set(r.promptId, r);
    else if (r.promptId === GUIDANCE_PROMPT_ID) guidance.set(r.scope, r);
  }
  c.held = { base, guidance, seq, at };
  if (cache === c) served = c.held;
}

/**
 * A failed read keeps the rows held when nothing says they changed (a Postgres safety re-read without a notification, a
 * SQLite counter that could not be read), and is tried again on the next ensure. It throws when no rows are held or a save
 * is known to have changed them.
 */
async function refresh(c: Cache): Promise<void> {
  const db = c.db;
  const keep = (e: unknown): void => {
    console.log(`prompt revisions: ${(e as Error).message}; the rows read earlier stay in use`);
  };
  if (db.dialect === "postgres") {
    const startedAt = Date.now(), inv = c.invalidations;
    try {
      hold(c, await retried(() => loadActive(db)), null, inv === c.invalidations ? startedAt : 0);
    } catch (e) {
      if (!c.held || c.held.at === 0) throw e;
      keep(e);
    }
    return;
  }
  // The counter is read before the rows, so a save between the two only makes the next ensure read again.
  let seq: number;
  try {
    seq = (await retried(() => db.seqs(["prompts"]))).prompts ?? 0;
  } catch (e) {
    if (!c.held) throw e;
    keep(e);
    return;
  }
  if (c.held?.seq === seq) return;
  hold(c, await retried(() => loadActive(db)), seq, 0);
}

/** The cache for `db`, subscribed to the `prompts` topic through it (Postgres); a cache on another handle is dropped. */
function cacheFor(db: Db): Cache {
  if (cache?.db === db) return cache;
  cache?.sub?.off();
  const c: Cache = { db, sub: null, held: null, inflight: null, invalidations: 0 };
  c.sub = db.listen("prompts", () => { c.invalidations++; if (c.held) c.held.at = 0; }, { background: true });
  cache = c;
  return c;
}

function fresh(c: Cache): boolean {
  if (c.db.dialect !== "postgres" || !c.held) return false;
  return c.held.at > 0 && Date.now() - c.held.at < SAFETY_MS && c.sub?.listening() === true;
}

/**
 * Brings the cache up to date for `db`: on Postgres no statement between notifications (a re-read every 10 s and while the
 * listening connection is down); on SQLite one counter read, and the rows only when it moved. Throws when the revisions
 * cannot be read: a prompt never runs as its code default because the read failed.
 */
export async function ensurePrompts(db: Db): Promise<void> {
  const c = cacheFor(db);
  if (fresh(c)) return;
  await (c.inflight ??= refresh(c).finally(() => { c.inflight = null; }));
}

/** The active revision of a prompt in a scope ("base", or a repo for its guidance), as last ensured. */
export function activeRow(promptId: string, scope: string): PromptRevision | null {
  return (scope === BASE_SCOPE ? served?.base.get(promptId) : promptId === GUIDANCE_PROMPT_ID ? served?.guidance.get(scope) : undefined) ?? null;
}

/** A repository's guidance text, as last ensured; "" for none. */
export const guidanceOf = (repo: string): string => served?.guidance.get(repo)?.body ?? "";
