// The prompt registry (src/prompts) and its stored revisions (src/data/prompts) over JSON: everyone signed in reads the
// prompts, their history and diffs; operators and maintainers with write access on a tracked repo with the pipeline on
// change the instance-wide prompts; a repo's guidance is read by everyone who may see the repo and changed by its
// maintainers with write access (and operators). Every write is one revision with its audit row (src/data/prompts/ops.ts).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PromptCheckReply, PromptDiffReply, PromptGuidanceList, PromptHistory, PromptInfo, PromptSaveBody, PromptSaveReply, PromptsReport, RepoGuidance } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";
import {
  PromptViewError, activeRow, checkSave, editStates, ensurePrompts, isClaudePrompt, isJevPrompt, listRevisions, promptDiff, repoGuidance, revisionInfo,
  rollback, saveEdit, saveReply, useRelease, type SaveResult,
} from "../../data/prompts/index.ts";
import { BASE_SCOPE, GUIDANCE_PROMPTS, GUIDANCE_PROMPT_ID, promptInfo, promptsReport } from "../../prompts/index.ts";
import { mayEditBasePrompts, mayRunRepo } from "../repo-access.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { allVisibleRepos, needVisible } from "./visible.ts";

// Read when the server loads its code, so a later checkout without a restart
// does not change what the page claims.
const COMMIT = ((): string | null => {
  try {
    const cwd = fileURLToPath(new URL("../../..", import.meta.url));
    // A deployed release has no .git; the deploy hook writes the commit here.
    try {
      const stamped = readFileSync(`${cwd}/.source-commit`, "utf8").trim();
      if (/^[0-9a-f]{40}$/.test(stamped)) return stamped;
    } catch {}
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
})();

const BASE_EDITORS = "only operators, and maintainers with write access on a tracked repo with the pipeline on, change prompts";

async function viewed<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof PromptViewError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** A registered model prompt, or 404. */
function basePromptId(req: Req): string {
  const id = req.params.id!;
  if (!isClaudePrompt(id) && !isJevPrompt(id)) throw new HttpError(404, `${id} is not a model prompt`);
  return id;
}

/**
 * The prompt and scope a read names: a model prompt in the instance-wide scope, or repo.guidance with `?repo=` (the repo
 * must be visible to the caller).
 */
async function scopeOf(db: Db, req: Req): Promise<{ id: string; scope: string }> {
  const repo = req.query.get("repo");
  if (req.params.id === GUIDANCE_PROMPT_ID) {
    if (!repo) throw new HttpError(400, `${GUIDANCE_PROMPT_ID} belongs to one repository: add ?repo=`);
    await needVisible(db, req, repo);
    return { id: GUIDANCE_PROMPT_ID, scope: repo };
  }
  if (repo) throw new HttpError(400, `a repository has one guidance text, ${GUIDANCE_PROMPT_ID}; ${req.params.id} is instance-wide`);
  return { id: basePromptId(req), scope: BASE_SCOPE };
}

async function needBaseEditor(db: Db, req: Req): Promise<void> {
  if (!(await mayEditBasePrompts(db, req.user))) throw new HttpError(403, BASE_EDITORS);
}

/** The repo of a guidance route, visible to the caller; with `write`, one they may run (an operator, or a maintainer with write). */
async function guidanceRepo(db: Db, req: Req, write: boolean): Promise<string> {
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  if (write && !(await mayRunRepo(req.user, repo))) throw new HttpError(403, "no write access to this repo");
  return repo;
}

const body = (req: Req): Record<string, unknown> => {
  if (!req.json || typeof req.json !== "object" || Array.isArray(req.json)) throw new HttpError(400, "the body must be a JSON object");
  return req.json as Record<string, unknown>;
};
const text = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new HttpError(400, `${what} must be text`);
  return v;
};
const revOf = (v: unknown, what: string): number => {
  if (!Number.isInteger(v) || (v as number) < 1) throw new HttpError(400, `${what} must be a revision number`);
  return v as number;
};

function saveBody(req: Req): PromptSaveBody {
  const b = body(req);
  for (const k of Object.keys(b)) if (!["body", "note", "baseRev"].includes(k)) throw new HttpError(400, `unknown field ${k}`);
  return { body: text(b.body, "body"), note: text(b.note ?? "", "note"), baseRev: b.baseRev === undefined || b.baseRev === null ? null : revOf(b.baseRev, "baseRev") };
}

/** A write's reply; a save that started from a revision that is no longer active is a 409, so the editor reloads. */
function replyOf(r: SaveResult): PromptSaveReply {
  if (!r.ok && r.stale) throw new HttpError(409, r.problems[0]?.message ?? "the prompt changed since the edit started");
  return saveReply(r);
}

// ---- reads ------------------------------------------------------------------

/** GET /api/prompts: every prompt with its edit state for the caller. */
export async function prompts(db: Db, req: Req): Promise<PromptsReport> {
  await ensurePrompts(db);
  return promptsReport(COMMIT, await editStates(db, await mayEditBasePrompts(db, req.user)));
}

/** GET /api/prompts/:id */
export async function prompt(db: Db, req: Req): Promise<PromptInfo> {
  await ensurePrompts(db);
  const p = promptInfo(req.params.id!, await editStates(db, await mayEditBasePrompts(db, req.user)));
  if (!p) throw new HttpError(404, `${req.params.id} is not a prompt of the Prompts page`);
  return p;
}

/** GET /api/prompts/:id/history[?repo=] */
export async function history(db: Db, req: Req): Promise<PromptHistory> {
  const { id, scope } = await scopeOf(db, req);
  return { id, scope, revisions: (await listRevisions(db, id, scope)).map(revisionInfo) };
}

/** GET /api/prompts/:id/diff?from=&to=[&repo=]: `from` and `to` are revision numbers, "release" or "active" (to defaults to active). */
export async function diff(db: Db, req: Req): Promise<PromptDiffReply> {
  const { id, scope } = await scopeOf(db, req);
  const from = req.query.get("from"), to = req.query.get("to") ?? "active";
  if (!from) throw new HttpError(400, "from is required: a revision number, release or active");
  return { id, scope, from, to, diff: await viewed(() => promptDiff(db, id, scope, from, to)) };
}

/** GET /api/prompt-guidance: the visible repos that have guidance. */
export async function guidanceList(db: Db, req: Req): Promise<PromptGuidanceList> {
  await ensurePrompts(db);
  const repos = (await allVisibleRepos(db, req)).filter((r) => activeRow(GUIDANCE_PROMPT_ID, r)?.body);
  return { prompts: [...GUIDANCE_PROMPTS], repos: await Promise.all(repos.map(async (r) => repoGuidance(db, r, await mayRunRepo(req.user, r)))) };
}

/** GET /api/repos/:repo/guidance */
export async function guidance(db: Db, req: Req): Promise<RepoGuidance> {
  const repo = await guidanceRepo(db, req, false);
  return await repoGuidance(db, repo, await mayRunRepo(req.user, repo));
}

// ---- writes -----------------------------------------------------------------

/** POST /api/prompts/:id/check: a save's dry run; nothing is stored. */
export async function check(db: Db, req: Req): Promise<PromptCheckReply> {
  const id = basePromptId(req);
  await needBaseEditor(db, req);
  return await checkSave(db, { id, scope: BASE_SCOPE, ...saveBody(req) });
}

/** POST /api/prompts/:id {body, note, baseRev}: stores an edit as the active revision. */
export async function save(db: Db, req: Req): Promise<PromptSaveReply> {
  const id = basePromptId(req);
  await needBaseEditor(db, req);
  return replyOf(await saveEdit(db, { id, scope: BASE_SCOPE, ...saveBody(req), by: req.user.login }));
}

/** POST /api/prompts/:id/rollback {rev, note}: an earlier revision's text again, as a new revision. */
export async function rollbackPrompt(db: Db, req: Req): Promise<PromptSaveReply> {
  const id = basePromptId(req);
  await needBaseEditor(db, req);
  const b = body(req);
  return replyOf(await rollback(db, { id, scope: BASE_SCOPE, rev: revOf(b.rev, "rev"), note: text(b.note ?? "", "note"), by: req.user.login }));
}

/** POST /api/prompts/:id/use-release {note}: the release default again, as a new revision by the caller. */
export async function useReleasePrompt(db: Db, req: Req): Promise<PromptSaveReply> {
  const id = basePromptId(req);
  await needBaseEditor(db, req);
  return replyOf(await useRelease(db, { id, note: text(body(req).note ?? "", "note"), by: req.user.login }));
}

/** POST /api/repos/:repo/guidance/check */
export async function checkGuidance(db: Db, req: Req): Promise<PromptCheckReply> {
  const repo = await guidanceRepo(db, req, true);
  return await checkSave(db, { id: GUIDANCE_PROMPT_ID, scope: repo, ...saveBody(req) });
}

/** POST /api/repos/:repo/guidance {body, note, baseRev}; an empty body removes the guidance (a revision too). */
export async function saveGuidance(db: Db, req: Req): Promise<PromptSaveReply> {
  const repo = await guidanceRepo(db, req, true);
  return replyOf(await saveEdit(db, { id: GUIDANCE_PROMPT_ID, scope: repo, ...saveBody(req), by: req.user.login }));
}

/** POST /api/repos/:repo/guidance/rollback {rev, note} */
export async function rollbackGuidance(db: Db, req: Req): Promise<PromptSaveReply> {
  const repo = await guidanceRepo(db, req, true);
  const b = body(req);
  return replyOf(await rollback(db, { id: GUIDANCE_PROMPT_ID, scope: repo, rev: revOf(b.rev, "rev"), note: text(b.note ?? "", "note"), by: req.user.login }));
}
