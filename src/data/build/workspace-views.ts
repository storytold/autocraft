// Workspace read models (package build-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { SECURITY_PREFIX } from "../../security/rules.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { loadWarmReport } from "./build-state.ts";
import { headOf } from "./main-head.ts";
import type { CacheReportInputs, CacheTaskRow, CallPage, ViewScope, WorkspaceListPage, WorkspaceQuery } from "./types.ts";
import { LIVE_STATES, SECURITY_WORKSPACE_OWNER, WARM_STEP } from "./types.ts";

const filtered = (h: ViewScope["hiddenRepos"]): boolean => !!h.visible || h.length > 0;

/** The repo a workspace is listed under: its repo's security pseudo repo for a security fix session's workspace (isSecurityWorkspace). */
const listedRepo = (db: Db, eb: kx.AnyEb) =>
  eb.case().when(kx.like(db, "owner", eb.val(`${SECURITY_WORKSPACE_OWNER} %`))).then(kx.concat(eb.val(SECURITY_PREFIX), "repo")).else(eb.ref("repo")).end();

/** The Workspaces list: newest first, keyset-paged by id; `state: "live"` leaves out ended and failed ones. Sessions and costs come from the views module. 1 statement. */
export async function loadWorkspacePage(db: Db, q: WorkspaceQuery, scope: ViewScope): Promise<WorkspaceListPage> {
  const d = queryDb(db);
  let b = d.k.selectFrom("main.workspaces").select(["id", "repo", "base_sha", "app", "state", "state_at", "node", "warm", "owner", "created_at", "ended_at"])
    .orderBy("id", "desc").limit(q.limit + 1);
  if (filtered(scope.hiddenRepos)) b = b.where((eb) => hiddenRepos(db, listedRepo(db, eb as unknown as kx.AnyEb), scope.hiddenRepos));
  if (q.state === "live") b = b.where("state", "in", LIVE_STATES);
  if (q.cursor) b = b.where("id", "<", Number(q.cursor));
  const rows = await d.all(b);
  const page = rows.slice(0, q.limit);
  return { rows: page.map((r) => ({ ...r, id: Number(r.id) })), next: rows.length > q.limit ? String(page[page.length - 1]!.id) : null };
}

/**
 * A workspace's calls other than `ownTools`, metadata only (never output text or image data); two json fields are read in SQL.
 * Default: the newest page, oldest first, with `more` when older calls exist. `before`: the page before a call id. `after` (with
 * `running`, the call ids the page still shows as running): the calls past `after` and those again, for a live refresh. 1 statement.
 */
export async function loadWorkspaceCalls(db: Db, w: number, q: { before?: number; after?: number; running?: number[]; limit: number; ownTools: readonly string[] }): Promise<CallPage> {
  const d = queryDb(db);
  let b = d.k.selectFrom("main.workspace_calls")
    .select((eb) => ["id", "n", "tool", "args", "state", "created_at", "started_at", "finished_at", eb.case().when("result", "is not", null).then(1).else(0).end().as("has_result"),
      kx.jsonBool(db, "result", "$.isError").as("is_error"), kx.jsonNum(db, "result", "$.acct.images").as("images"),
      kx.jsonType(db, "result", "$.images[0].data").as("image_data"), kx.jsonNum(db, "result", "$.images[0].bytes").as("image_bytes"),
      kx.jsonText(db, "result", "$.images[0].sha256").as("image_sha"), kx.jsonText(db, "result", "$.images[0].note").as("image_note")] as const)
    .where("workspace_id", "=", w).where(kx.inList(db, "tool", q.ownTools, "text", true));
  const running = q.running ?? [];
  if (q.after !== undefined) {
    const after = q.after;
    b = b.where((eb) => eb.or([eb("id", ">", after), ...(running.length ? [eb("id", "in", running)] : [])])).orderBy("id", "asc").limit(200);
    return { rows: (await d.all(b)).map((r) => ({ ...r, id: Number(r.id) })), more: false };
  }
  b = b.orderBy("id", "desc").limit(q.limit + 1);
  if (q.before !== undefined) b = b.where("id", "<", q.before);
  const rows = await d.all(b);
  return { rows: rows.slice(0, q.limit).reverse().map((r) => ({ ...r, id: Number(r.id) })), more: rows.length > q.limit };
}

/** One call's output: the result's text, else its error; null for no such call of the workspace. `alone`. */
export async function loadCallOutput(db: Db, w: number, id: number, ownTools: readonly string[]): Promise<{ output: string | null } | null> {
  const d = queryDb(db);
  const r = await d.get(d.k.selectFrom("main.workspace_calls")
    .select((eb) => {
      const res = eb.case().when(kx.jsonValid(db, "result")).then(eb.ref("result")).end();
      return [kx.jsonText(db, res, "$.text").as("text"), kx.jsonText(db, res, "$.error").as("error")] as const;
    })
    .where("workspace_id", "=", w).where("id", "=", id).where(kx.inList(db, "tool", ownTools, "text", true)), { alone: true });
  return r ? { output: r.text ?? r.error } : null;
}

/** One call's first image as stored (base64 `data`, null once it was not kept; its `mime` and `sha`); null for no such call. `alone`. */
export async function loadCallImage(db: Db, w: number, id: number): Promise<{ data: string | null; mime: string | null; sha: string | null } | null> {
  const d = queryDb(db);
  const r = await d.get(d.k.selectFrom("main.workspace_calls")
    .select((eb) => {
      const res = eb.case().when(kx.jsonValid(db, "result")).then(eb.ref("result")).end();
      return [kx.jsonText(db, res, "$.images[0].data").as("data"), kx.jsonText(db, res, "$.images[0].mimeType").as("mime"), kx.jsonText(db, res, "$.images[0].sha256").as("sha")] as const;
    })
    .where("workspace_id", "=", w).where("id", "=", id), { alone: true });
  return r ?? null;
}

const WARM_COLUMNS = ["id", "repo", "state", "summary", "head_sha", "ended_at", "sandbox_env", "warm_image"] as const;

/**
 * What the Caches page combines with the stored node reports, in one wave of 8 statements: the stored report, the repos that have
 * warm tasks, each repo's newest warm task and newest finished one, every `warm_bytes` row, every repo's explicit warm target, the
 * current main head of `repos` and of the repos with warm tasks, and the enabled Kubernetes environments. Repos the viewer may not see
 * are left out of the task, target and head sets. The caller adds the coverage (control settings, workflow scope) and the node view.
 */
export async function loadCacheReport(db: Db, repos: string[], scope: ViewScope): Promise<CacheReportInputs> {
  const d = queryDb(db), { k } = d;
  const visible = filtered(scope.hiddenRepos);
  const seen = (col: string) => (visible ? hiddenRepos(db, col, scope.hiddenRepos) : undefined);
  const newest = (done: boolean) => k.selectFrom(k.selectFrom("main.build_tasks as t")
      .select((eb) => [...WARM_COLUMNS.map((c) => `t.${c}` as const), eb.fn.agg<number>("row_number").over((o) => o.partitionBy("t.repo").orderBy("t.id", "desc")).as("rn")])
    .where("t.step", "=", WARM_STEP).$if(done, (b) => b.where("t.state", "=", "done")).$if(visible, (b) => b.where(seen("t.repo")!)).as("n"))
    .select(WARM_COLUMNS.map((c) => `n.${c}` as const)).where("n.rn", "=", 1);
  const names = k.selectFrom(kx.valuesTable(db, [...new Set(repos)].map((repo) => ({ repo })), { repo: "text" }, "rv")).select("rv.repo as repo")
    .union(k.selectFrom("main.build_tasks").select("repo").distinct().where("step", "=", WARM_STEP));
  const [stored, taskRepos, last, done, bytes, targets, heads, envs] = await db.together(() => Promise.all([
    loadWarmReport(db),
    d.all(k.selectFrom("main.build_tasks").select("repo").distinct().where("step", "=", WARM_STEP).$if(visible, (b) => b.where(seen("repo")!)).orderBy("repo")),
    d.all(newest(false)), d.all(newest(true)),
    d.all(k.selectFrom("main.build_state").select(["key", "value"]).where((eb) => kx.like(db, "key", eb.val("warm\\_bytes:%"), "\\"))),
    d.all(k.selectFrom("main.build_sizes").select(["repo", "warm_target"]).$if(visible, (b) => b.where(seen("repo")!))),
    d.all(k.selectFrom(names.as("rr")).select((eb) => ["rr.repo as repo", headOf(eb, "rr.repo").as("head")]).$if(visible, (b) => b.where(seen("rr.repo")!))),
    d.all(k.selectFrom("main.build_envs").select(["id", "settings"]).where("kind", "=", "kubernetes").where("enabled", "=", 1).orderBy("id")),
  ]));
  const bytesOf = new Map<string, number>();
  for (const r of bytes) {
    const n = Number(r.value);
    if (Number.isSafeInteger(n) && n > 0) bytesOf.set(r.key.slice("warm_bytes:".length), n);
  }
  return {
    stored, taskRepos: taskRepos.map((r) => r.repo),
    last: new Map(last.map((r) => [r.repo, r as CacheTaskRow])), done: new Map(done.map((r) => [r.repo, r as CacheTaskRow])),
    bytes: bytesOf, warmTargets: new Map(targets.filter((r) => r.warm_target).map((r) => [r.repo, r.warm_target])),
    heads: new Map(heads.flatMap((r) => (r.head ? [[r.repo, r.head as string] as const] : []))), kubeEnvs: envs,
  };
}
