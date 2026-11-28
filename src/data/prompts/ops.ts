// Writes of prompt_revisions: an edit, a rollback to an earlier revision, and a switch back to the release default. Each is
// one db.write that reads the active revision, checks, inserts the new active revision and records its audit row, so two
// saves from the same starting revision cannot both land. Nothing here runs a model.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "../control/audit.ts";
import { NOTE_MAX, checkEdit, type ActiveRevision, type Problem } from "../../prompts/checks.ts";
import { BASE_SCOPE, CLAUDE_PROMPTS, GUIDANCE_PROMPT_ID, JEV_PROMPTS, bodyVersion, codeBody, codeDefault, type ClaudePromptId, type JevPromptId } from "../../prompts/index.ts";
import { mergeEdit } from "../../prompts/locks.ts";
import { sha256Hex } from "../../prompts/sha256.ts";
import { listRevisions } from "./revisions.ts";
import type { PromptRevision, PromptRevisionKind } from "./types.ts";

/** A stored revision, or why nothing was stored; `stale`: the active revision is no longer the one the edit started from. */
export type SaveResult = { ok: true; rev: number; version: string } | { ok: false; problems: Problem[]; stale?: true };

/** The author of the revisions that hold a release default. */
export const RELEASE_AUTHOR = "release";

const isGuidance = (id: string): boolean => id === GUIDANCE_PROMPT_ID;
const isBasePrompt = (id: string): id is ClaudePromptId | JevPromptId => id in CLAUDE_PROMPTS || id in JEV_PROMPTS;

/** The version a revision's body runs at now: a Claude edit with the code's locked blocks (the code's text when it no longer fits), guidance by its own hash. */
function versionOf(id: string, body: string, follows: boolean): string {
  if (isGuidance(id)) return body ? sha256Hex(body).slice(0, 6) : "";
  if (follows || !(id in CLAUDE_PROMPTS)) return codeDefault(id as ClaudePromptId | JevPromptId).version;
  const code = codeBody(id as ClaudePromptId);
  return bodyVersion(mergeEdit(code, body) ?? code);
}

const activeOf = (revs: PromptRevision[]): PromptRevision | null => revs.find((r) => r.active) ?? null;
const asActive = (r: PromptRevision | null): ActiveRevision => (r ? { rev: r.rev, body: r.body, follows: r.follows } : null);

type NewRow = { kind: PromptRevisionKind; body: string; version: string; defaultHash: string | null; follows: boolean; fromRev: number | null; author: string; note: string };

/** Makes `row` the active revision: the next rev number, the earlier active one switched off first (one active row per prompt and scope). */
async function insertActive(db: Db, id: string, scope: string, revs: PromptRevision[], rows: NewRow[]): Promise<number> {
  const q = queryDb(db), at = new Date().toISOString();
  if (activeOf(revs)) await q.run(q.k.updateTable("prompt_revisions").set({ active: 0 }).where("prompt_id", "=", id).where("scope", "=", scope).where("active", "=", 1));
  let rev = revs.reduce((m, r) => Math.max(m, r.rev), 0);
  for (const [i, r] of rows.entries()) {
    rev++;
    await q.run(q.k.insertInto("prompt_revisions").values({
      prompt_id: id, scope, rev, kind: r.kind, body: r.body, version: r.version, default_hash: r.defaultHash, follows: r.follows ? 1 : 0,
      from_rev: r.fromRev, active: i === rows.length - 1 ? 1 : 0, author: r.author, at, note: r.note,
    }));
  }
  return rev;
}

/**
 * The release row an edit is made against, when none holds the current default yet: rev 1 on the first save (the code
 * default no row stood for), and after a release that changed the default, a row with its text, so the release flag can
 * later show what a newer release changed since the edit. Guidance has no release text: its first save starts at an empty rev 1.
 */
function releaseRow(id: string, revs: PromptRevision[]): NewRow | null {
  if (isGuidance(id)) return revs.length ? null : { kind: "release", body: "", version: "", defaultHash: null, follows: true, fromRev: null, author: RELEASE_AUTHOR, note: "no guidance" };
  const d = codeDefault(id as ClaudePromptId | JevPromptId);
  if (revs.some((r) => r.follows && r.version === d.version)) return null;
  return { kind: "release", body: d.body, version: d.version, defaultHash: d.version, follows: true, fromRev: null, author: RELEASE_AUTHOR, note: "the release default" };
}

const target = (id: string, scope: string, rev: number): string => `${id}@${scope} r${rev}`;
const refused = (problems: Problem[]): SaveResult => ({ ok: false, problems });

/**
 * Stores an edit of a Claude prompt (scope "base") or of a repository's guidance (repo.guidance, scope = the repo) as the new
 * active revision. `baseRev`: the active revision the editor started from (null or 1 for a prompt that has no rows yet).
 */
export async function saveEdit(db: Db, o: { id: string; scope: string; body: string; note: string; by: string; baseRev: number | null }): Promise<SaveResult> {
  return await db.write(async () => {
    const revs = await listRevisions(db, o.id, o.scope);
    const active = activeOf(revs);
    if ((active?.rev ?? 1) !== (o.baseRev ?? 1)) return { ok: false, stale: true, problems: [{ where: "rev", message: `the prompt changed since revision ${o.baseRev ?? 1}: revision ${active?.rev ?? 1} is active now` }] };
    const problems = checkEdit(o.id, o.scope, o.body, o.note, asActive(active));
    if (problems.length) return refused(problems);
    const release = releaseRow(o.id, revs);
    const version = versionOf(o.id, o.body, false);
    const defaultHash = isGuidance(o.id) ? null : codeDefault(o.id as ClaudePromptId).version;
    const rev = await insertActive(db, o.id, o.scope, revs, [...(release ? [release] : []), { kind: "edit", body: o.body, version, defaultHash, follows: false, fromRev: active?.rev ?? null, author: o.by, note: o.note.trim() }]);
    await addAudit(db, [{ login: o.by, action: "prompt-edit", target: target(o.id, o.scope, rev), details: { kind: "edit", version, fromRev: active?.rev ?? null } }]);
    return { ok: true, rev, version };
  });
}

/** Makes an earlier revision's text the active one again, as a new revision (kind rollback); a release revision follows the running release again. */
export async function rollback(db: Db, o: { id: string; scope: string; rev: number; by: string; note: string }): Promise<SaveResult> {
  if (!isGuidance(o.id) && !(isBasePrompt(o.id) && o.scope === BASE_SCOPE)) return refused([{ where: "prompt", message: `${o.id} has no revisions in ${o.scope}` }]);
  const note = o.note.trim();
  if (!note || note.length > NOTE_MAX) return refused([{ where: "note", message: `a note of 1 to ${NOTE_MAX} characters saying why is required` }]);
  return await db.write(async () => {
    const revs = await listRevisions(db, o.id, o.scope);
    const from = revs.find((r) => r.rev === o.rev), active = activeOf(revs);
    if (!from) return refused([{ where: "rev", message: `there is no revision ${o.rev}` }]);
    if (active && (from.rev === active.rev || (from.follows && active.follows))) return refused([{ where: "rev", message: `revision ${o.rev} is what runs already` }]);
    const body = from.follows && !isGuidance(o.id) ? codeDefault(o.id as ClaudePromptId).body : from.body;
    const version = versionOf(o.id, body, from.follows);
    const defaultHash = isGuidance(o.id) ? null : from.follows ? version : from.defaultHash;
    const rev = await insertActive(db, o.id, o.scope, revs, [{ kind: "rollback", body, version, defaultHash, follows: from.follows, fromRev: from.rev, author: o.by, note }]);
    await addAudit(db, [{ login: o.by, action: "prompt-rollback", target: target(o.id, o.scope, rev), details: { kind: "rollback", version, fromRev: from.rev } }]);
    return { ok: true, rev, version };
  });
}

/**
 * Switches an edited prompt to the release default: a new revision with the code's text that follows the running release,
 * attributed to the maintainer who switched. The edit stays in the history.
 */
export async function useRelease(db: Db, o: { id: string; by: string; note: string }): Promise<SaveResult> {
  if (!isBasePrompt(o.id)) return refused([{ where: "prompt", message: `${o.id} has no release default` }]);
  const note = o.note.trim();
  if (!note || note.length > NOTE_MAX) return refused([{ where: "note", message: `a note of 1 to ${NOTE_MAX} characters saying why is required` }]);
  return await db.write(async () => {
    const revs = await listRevisions(db, o.id, BASE_SCOPE);
    const active = activeOf(revs);
    if (!active || active.follows) return refused([{ where: "prompt", message: "the prompt runs the release default already" }]);
    const d = codeDefault(o.id as ClaudePromptId | JevPromptId);
    const rev = await insertActive(db, o.id, BASE_SCOPE, revs, [{ kind: "use-release", body: d.body, version: d.version, defaultHash: d.version, follows: true, fromRev: active.rev, author: o.by, note }]);
    await addAudit(db, [{ login: o.by, action: "prompt-edit", target: target(o.id, BASE_SCOPE, rev), details: { kind: "use-release", version: d.version, fromRev: active.rev } }]);
    return { ok: true, rev, version: d.version };
  });
}
