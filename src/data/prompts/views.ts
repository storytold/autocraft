// What the dashboard, the MCP tools and the server CLI show of stored prompt revisions: a prompt's edit state, its
// revisions, the text at a revision, diffs and dry-run checks, and a repository's guidance. Permissions are the caller's.
import type { PromptCheckReply, PromptEditState, PromptRevisionInfo, PromptSaveReply, RepoGuidance } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";
import { checkEdit, normaliseBody } from "../../prompts/checks.ts";
import { lineDiff, type DiffLine } from "../../prompts/diff.ts";
import { BASE_SCOPE, CLAUDE_PROMPTS, GUIDANCE_PROMPTS, GUIDANCE_PROMPT_ID, JEV_PROMPTS, bodyVersion, codeBody, codeDefault, codeEditState, jevRequestWith, sameTemplateOf, type ClaudePromptId, type JevPromptId } from "../../prompts/index.ts";
import { mergeEdit, stripLocks } from "../../prompts/locks.ts";
import { sha256Hex } from "../../prompts/sha256.ts";
import { activeRow } from "./active.ts";
import type { SaveResult } from "./ops.ts";
import { listRevisions } from "./revisions.ts";
import type { PromptRevision } from "./types.ts";

export const isClaudePrompt = (id: string): id is ClaudePromptId => Object.hasOwn(CLAUDE_PROMPTS, id);
export const isJevPrompt = (id: string): id is JevPromptId => Object.hasOwn(JEV_PROMPTS, id);

/** A prompt that may be edited: a Claude prompt that runs its own text (an interactive one is changed on the prompt it repeats), or a Jev prompt (checkJevEdit). */
export const isEditable = (id: string): boolean => (isClaudePrompt(id) && sameTemplateOf(id) === null) || isJevPrompt(id);

export const revisionInfo = (r: PromptRevision): PromptRevisionInfo =>
  ({ rev: r.rev, kind: r.kind, version: r.version, author: r.author, at: r.at, note: r.note, fromRev: r.fromRev, active: r.active });

/** A prompt's edit state from the revisions last ensured (ensurePrompts); `mayEdit`: the user may change the instance-wide prompts. */
export function editState(id: string, mayEdit: boolean): PromptEditState {
  const target = isClaudePrompt(id) ? sameTemplateOf(id) ?? id : id;
  const row = activeRow(target, BASE_SCOPE);
  const edited = !!row && !row.follows;
  return {
    ...codeEditState(id),
    rev: row?.rev ?? null,
    following: !edited,
    newerDefault: edited && (isClaudePrompt(target) || isJevPrompt(target)) && row.defaultHash !== codeDefault(target).version,
    structureChanged: edited && (isClaudePrompt(target) ? mergeEdit(codeBody(target), row.body) === null : isJevPrompt(target) && jevRequestWith(target, row.body) === null),
    mayEdit: mayEdit && isEditable(id),
  };
}

/** A body as it reads in a diff: a Claude prompt's text without markers, a Jev body as indented JSON, guidance as it is. */
function shown(id: string, body: string): string {
  if (isClaudePrompt(id)) return stripLocks(body);
  if (!isJevPrompt(id)) return body;
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

/** The text form that runs for the active revision `active` (null: none stored). */
function runningOf(id: string, active: PromptRevision | null): string {
  if (id === GUIDANCE_PROMPT_ID) return active?.body ?? "";
  const d = codeDefault(id as ClaudePromptId | JevPromptId).body;
  if (!active || active.follows) return d;
  return isClaudePrompt(id) ? mergeEdit(codeBody(id), active.body) ?? d : active.body;
}

export class PromptViewError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The text form of a prompt in a scope at `at`: a revision number, "active" (what runs now) or "release" (the running
 * release's default; guidance has none, so ""). Read from the database, so it is accurate right after a save.
 */
export async function textAt(db: Db, id: string, scope: string, at: string, revs?: PromptRevision[]): Promise<string> {
  const rows = revs ?? await listRevisions(db, id, scope);
  if (at === "active") return runningOf(id, rows.find((r) => r.active) ?? null);
  if (at === "release") return id === GUIDANCE_PROMPT_ID ? "" : codeDefault(id as ClaudePromptId | JevPromptId).body;
  const n = Number(at);
  if (!Number.isInteger(n) || n < 1) throw new PromptViewError(400, `"${at}" is not a revision: give its number, active or release`);
  const r = rows.find((x) => x.rev === n);
  // With no revision stored, the release default is revision 1.
  if (!r && n === 1 && !rows.length) return textAt(db, id, scope, "release", rows);
  if (!r) throw new PromptViewError(404, `there is no revision ${n}`);
  return r.body;
}

/** The lines that turn the text at `from` into the text at `to` (see textAt). */
export async function promptDiff(db: Db, id: string, scope: string, from: string, to: string): Promise<DiffLine[]> {
  const revs = await listRevisions(db, id, scope);
  return lineDiff(shown(id, await textAt(db, id, scope, from, revs)), shown(id, await textAt(db, id, scope, to, revs)));
}

/** A save's dry run: the problems that would refuse it (the revision it started from included), its change against what runs, and the version it would record. */
export async function checkSave(db: Db, o: { id: string; scope: string; body: string; note: string; baseRev: number | null }): Promise<PromptCheckReply> {
  const body = normaliseBody(o.body);
  const revs = await listRevisions(db, o.id, o.scope);
  const active = revs.find((r) => r.active) ?? null;
  const problems = (active?.rev ?? 1) !== (o.baseRev ?? 1) ? [{ where: "rev", message: `the prompt changed since revision ${o.baseRev ?? 1}: revision ${active?.rev ?? 1} is active now` }] : [];
  problems.push(...checkEdit(o.id, o.scope, body, o.note, active ? { rev: active.rev, body: active.body, follows: active.follows } : null));
  const ok = problems.length === 0;
  const version = !ok ? null : o.id === GUIDANCE_PROMPT_ID ? (body ? sha256Hex(body).slice(0, 6) : "") : bodyVersion(body);
  return { ok, problems, diff: lineDiff(shown(o.id, runningOf(o.id, active)), shown(o.id, body)), version };
}

/** A write's result as the API replies it. */
export const saveReply = (r: SaveResult): PromptSaveReply => (r.ok ? { ok: true, problems: [], rev: r.rev, version: r.version } : { ok: false, problems: r.problems, rev: null, version: null });

/** A repository's guidance with its history, read from the database. */
export async function repoGuidance(db: Db, repo: string, mayEdit: boolean): Promise<RepoGuidance> {
  const revs = await listRevisions(db, GUIDANCE_PROMPT_ID, repo);
  const a = revs.find((r) => r.active) ?? null;
  return {
    repo, text: a?.body ?? "", rev: a?.rev ?? null, author: a?.author ?? null, at: a?.at ?? null, note: a?.note ?? null,
    prompts: [...GUIDANCE_PROMPTS], mayEdit, history: revs.map(revisionInfo),
  };
}
