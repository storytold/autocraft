// Reads of prompt_revisions.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import type { PromptRevision, PromptRevisionKind } from "./types.ts";

type Row = {
  id: number | string; prompt_id: string; scope: string; rev: number | string; kind: string; body: string; version: string; default_hash: string | null;
  follows: number | string; from_rev: number | string | null; active: number | string; author: string; at: string; note: string;
};

const COLUMNS = ["id", "prompt_id", "scope", "rev", "kind", "body", "version", "default_hash", "follows", "from_rev", "active", "author", "at", "note"] as const;

const toRevision = (r: Row): PromptRevision => ({
  id: Number(r.id), promptId: r.prompt_id, scope: r.scope, rev: Number(r.rev), kind: r.kind as PromptRevisionKind, body: r.body, version: r.version,
  defaultHash: r.default_hash, follows: Number(r.follows) === 1, fromRev: r.from_rev === null ? null : Number(r.from_rev), active: Number(r.active) === 1,
  author: r.author, at: r.at, note: r.note,
});

/** Every active revision, of every prompt and scope. 1 statement. */
export async function loadActive(db: Db): Promise<PromptRevision[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("prompt_revisions").select([...COLUMNS]).where("active", "=", 1))).map(toRevision);
}

/** One revision of a prompt in a scope, or null. */
export async function loadRevision(db: Db, promptId: string, scope: string, rev: number): Promise<PromptRevision | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("prompt_revisions").select([...COLUMNS]).where("prompt_id", "=", promptId).where("scope", "=", scope).where("rev", "=", rev));
  return r ? toRevision(r) : null;
}

/** The latest revision of a prompt whose version is `version` (any scope), or null. */
export async function loadByVersion(db: Db, promptId: string, version: string): Promise<PromptRevision | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("prompt_revisions").select([...COLUMNS]).where("prompt_id", "=", promptId).where("version", "=", version).orderBy("id", "desc").limit(1));
  return r ? toRevision(r) : null;
}

/** The revisions of a prompt in a scope, newest first. */
export async function listRevisions(db: Db, promptId: string, scope: string): Promise<PromptRevision[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("prompt_revisions").select([...COLUMNS]).where("prompt_id", "=", promptId).where("scope", "=", scope).orderBy("rev", "desc"))).map(toRevision);
}
