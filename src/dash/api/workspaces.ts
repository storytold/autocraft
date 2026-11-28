// Workspaces over JSON: the list, one workspace with its sessions, its call log and the screenshots of its calls. Everyone
// signed in sees a workspace of a repo they can see (repo, state, node, times); a security fix session's workspace only those who
// see the repo's security pseudo repo (operators, and maintainers who can see the repo). Operators and maintainers with write on
// the repo also read errors, sessions' prompts, replies and outcomes, call arguments, outputs and screenshots (the rule for job
// logs and model outputs). Everything a pod or a model wrote is text, never HTML; images are served with a sandbox policy.
import type { WorkspaceCall, WorkspaceCallOutput, WorkspaceCalls, WorkspaceDetail, WorkspacePage, WorkspaceSession, WorkspaceState, WorkspaceSummary } from "../../../web/src/api/types.ts";
import { OWN_CALLS } from "../../build/workspace-tools.ts";
import { warmOf } from "../../build/workspace-layout.ts";
import { isSecurityWorkspace, loadCallImage, loadCallOutput, loadWorkspaceCalls, loadWorkspacePage, loadWorkspaces } from "../../data/build/index.ts";
import { loadSessionCosts, loadSessionDetails } from "../../data/views/workspace-sessions.ts";
import { isHiddenRepo } from "../../data/control/index.ts";
import { securityRepo } from "../../security/rules.ts";
import type { Db } from "../../db/index.ts";
import { mayRunRepo } from "../repo-access.ts";
import { HttpError } from "../server/util.ts";
import type { Req, Res } from "../types.ts";
import { hiddenRepos } from "./visible.ts";
import { canSeeInternals } from "./staff.ts";

const PAGE = 30;
const CALL_PAGE = 60;
const HEAD_CHARS = 4_000;
const TAIL_CHARS = 20_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const idOf = (v: string | undefined, what: string): number => {
  if (!/^\d{1,15}$/.test(v ?? "")) throw new HttpError(400, `not a ${what} id`);
  return Number(v);
};

const limitOf = (req: Req, def: number, max: number): number => {
  const v = req.query.get("limit");
  if (v === null || v === "") return def;
  if (!/^\d{1,4}$/.test(v) || Number(v) < 1) throw new HttpError(400, "limit must be a positive whole number");
  return Math.min(max, Number(v));
};

/** The cost a model call reported (remote_calls.usage), null when it has none. */
function costOf(usage: string | null): number | null {
  try {
    const c = (JSON.parse(usage ?? "null") as { costUsd?: unknown } | null)?.costUsd;
    return typeof c === "number" && Number.isFinite(c) ? c : null;
  } catch {
    return null;
  }
}

const warmText = (w: { warm: string | null }): string | null => {
  const warm = warmOf(w);
  if (!warm) return null;
  if (warm.note) return warm.note;
  if (warm.use) return `copied ${warm.use.key}@${warm.use.commit.slice(0, 12)} on ${warm.use.node}`;
  return warm.why ? `started cold: ${warm.why}` : null;
};

type Row = { id: number; repo: string; base_sha: string; app: string | null; state: string; state_at: string; node: string | null; warm: string | null; created_at: string; ended_at: string | null; error?: string | null };

async function summaries(db: Db, req: Req, rows: Row[]): Promise<WorkspaceSummary[]> {
  const repos = [...new Set(rows.map((r) => r.repo))];
  const [sessions, allowed] = await Promise.all([loadSessionCosts(db, rows.map((r) => r.id)), Promise.all(repos.map((repo) => mayRunRepo(req.user, repo)))]);
  const can = new Map(repos.map((repo, i) => [repo, allowed[i]!]));
  return rows.map((r) => {
    const mine = sessions.get(r.id) ?? [];
    const costs = mine.map((s) => costOf(s.usage)).filter((c): c is number => c !== null);
    const canSee = can.get(r.repo) === true;
    return {
      id: r.id, repo: r.repo, baseSha: r.base_sha, app: r.app, state: r.state as WorkspaceState, stateAt: r.state_at, node: r.node, warm: warmText(r),
      createdAt: r.created_at, endedAt: r.ended_at, item: mine[0]?.item ?? null, sessions: mine.length,
      costUsd: canSee && costs.length ? costs.reduce((a, b) => a + b, 0) : null, canSee,
    };
  });
}

/** Newest first, keyset-paged by id; `state=live` (default) leaves out ended and failed ones. */
export async function list(db: Db, req: Req): Promise<WorkspacePage> {
  const state = req.query.get("state") || "live";
  if (state !== "live" && state !== "all") throw new HttpError(400, "state is live or all");
  const cursor = req.query.get("cursor");
  if (cursor && !/^\d{1,15}$/.test(cursor)) throw new HttpError(400, "bad cursor");
  const limit = limitOf(req, PAGE, 100);
  const page = await loadWorkspacePage(db, { state, cursor: cursor || undefined, limit }, { hiddenRepos: await hiddenRepos(db, req), staff: canSeeInternals(req) });
  return { workspaces: await summaries(db, req, page.rows), next: page.next };
}

async function visibleWorkspace(db: Db, req: Req, id: number) {
  const w = (await loadWorkspaces(db, { ids: [id] })).get(id);
  // The list's rule: the same answer for a workspace that does not exist and one of a repo the viewer cannot see.
  if (!w || isHiddenRepo(await hiddenRepos(db, req), isSecurityWorkspace(w) ? securityRepo(w.repo) : w.repo)) throw new HttpError(404, "no such workspace");
  return w;
}

export async function detail(db: Db, req: Req): Promise<WorkspaceDetail> {
  const w = await visibleWorkspace(db, req, idOf(req.params.id, "workspace"));
  const [s] = await summaries(db, req, [w]);
  const see = s!.canSee;
  const sessionList: WorkspaceSession[] = !see ? [] : (await loadSessionDetails(db, w.id)).map((r) => ({
    id: r.id, kind: r.kind, item: r.item, state: r.state as WorkspaceSession["state"], forLogin: r.forLogin, requestedBy: r.requestedBy,
    outcome: r.outcome, createdAt: r.createdAt, endedAt: r.endedAt, costUsd: costOf(r.usage), reply: r.reply, prompt: r.prompt, jobId: r.jobId,
  }));
  return { ...s!, error: see ? w.error : null, pod: see ? w.pod : null, env: see ? w.env_id : null, layout: see ? w.layout : null, sessionList };
}

const argsOf = (json: string): Record<string, unknown> => {
  try {
    const o = JSON.parse(json) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

/** The one-line argument of a call: the command, the path, the app or the binary. */
function summaryOf(tool: string, a: Record<string, unknown>): string {
  const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const s = tool === "shell" ? text(a.command) : tool === "app_start" ? text(a.binary) : tool === "app_stop" || tool === "screenshot" ? (a.app !== undefined ? `app ${text(a.app)}` : "") : tool === "shell_status" || tool === "shell_kill" ? text(a.id) && `command ${text(a.id)}` : tool === "grep" || tool === "glob" ? [text(a.pattern), text(a.path)].filter(Boolean).join(" in ") : text(a.path);
  return s.slice(0, 2000);
}

/** A stored result's text; the head and tail of a long one. */
function cutOutput(text: string): { output: string; chars: number } {
  return text.length <= HEAD_CHARS + TAIL_CHARS ? { output: text, chars: text.length } : { output: `${text.slice(0, HEAD_CHARS)}\n[${text.length - HEAD_CHARS - TAIL_CHARS} characters left out]\n${text.slice(-TAIL_CHARS)}`, chars: text.length };
}

async function seenWorkspace(db: Db, req: Req) {
  const w = await visibleWorkspace(db, req, idOf(req.params.id, "workspace"));
  if (!(await mayRunRepo(req.user, w.repo))) throw new HttpError(403, "only operators and maintainers of the repo read a workspace's calls");
  return w;
}

/**
 * Call metadata, never output text or image data. Two json fields are read in SQL (isError and the image count, one parse each);
 * the result is not read as a whole. Default: the newest page, oldest first. `before`: the page before a call id. `after` (with
 * `running`, call ids the page still shows as running): the calls past `after` and those again, for a live refresh.
 */
export async function calls(db: Db, req: Req): Promise<WorkspaceCalls> {
  const w = await seenWorkspace(db, req);
  const num = (name: string): number | null => {
    const v = req.query.get(name);
    if (v === null || v === "") return null;
    if (!/^\d{1,15}$/.test(v)) throw new HttpError(400, `bad ${name}`);
    return Number(v);
  };
  const before = num("before"), after = num("after");
  const runningParam = req.query.get("running") ?? "";
  if (runningParam && !/^\d{1,15}(,\d{1,15}){0,49}$/.test(runningParam)) throw new HttpError(400, "bad running");
  const running = runningParam ? runningParam.split(",").map(Number) : [];
  const limit = limitOf(req, CALL_PAGE, 200);
  const got = await loadWorkspaceCalls(db, w.id, { before: before ?? undefined, after: after ?? undefined, running, limit, ownTools: OWN_CALLS });
  const page = got.rows;
  return {
    older: after === null && got.more ? String(page[0]!.id) : null,
    calls: page.map((r): WorkspaceCall => ({
      id: r.id, n: r.n, tool: r.tool, summary: summaryOf(r.tool, argsOf(r.args)), state: r.state as WorkspaceCall["state"], isError: r.state === "failed" || Number(r.is_error) === 1,
      createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, hasOutput: Number(r.has_result) === 1, images: Number(r.images ?? 0),
      notKept: r.image_data !== "text" && r.image_sha ? { bytes: Number(r.image_bytes ?? 0), sha256: r.image_sha, note: r.image_note } : null,
    })),
  };
}

/** One call's output text (the result's text, or its error), cut in the middle when long. */
export async function output(db: Db, req: Req): Promise<WorkspaceCallOutput> {
  const w = await seenWorkspace(db, req);
  const r = await loadCallOutput(db, w.id, idOf(req.params.call, "call"), OWN_CALLS);
  if (!r) throw new HttpError(404, "no such call");
  const text = r.output;
  if (text === null) return { output: null, chars: 0 };
  const cut = cutOutput(text);
  return { output: cut.output, chars: cut.chars };
}

/** The image of a call (its first), for operators and maintainers of the repo. */
export async function image(db: Db, req: Req): Promise<Res> {
  try {
    const w = await visibleWorkspace(db, req, idOf(req.params.id, "workspace"));
    if (!(await mayRunRepo(req.user, w.repo))) throw new HttpError(403, "only operators and maintainers of the repo see a workspace's screenshots");
    const row = await loadCallImage(db, w.id, idOf(req.params.call, "call"));
    if (!row?.data && row?.sha) throw new HttpError(404, "this screenshot was not kept");
    if (!row?.data || !row.mime || !IMAGE_TYPES.has(row.mime)) throw new HttpError(404, "no such screenshot");
    return { body: Buffer.from(row.data, "base64"), headers: { "content-type": row.mime, "content-disposition": "inline", "content-security-policy": "sandbox", "x-content-type-options": "nosniff", "cache-control": "private, no-cache" } };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    throw e;
  }
}

