// Build environments and tasks over JSON. Everyone signed in reads (tasks of repos
// the viewer cannot see are left out); only operators register or change an
// environment, rotate its key or cancel a task, all audited. A worker key is
// returned once, on creation and rotation. Whatever a worker reported is data:
// viewers get neither logs, patches nor artifact downloads; the page shows it as text and artifacts download with `attachment` (PNG inline),
// `nosniff` and `Content-Security-Policy: sandbox`.
import { filterSeq } from "../../async-seq.ts";
import { mayRunRepo } from "../repo-access.ts";
import { readFileSync } from "node:fs";
import type { BuildEnv, BuildFeatureState, ScreenshotSetups, BuildFeatures, BuildSummary, BuildTask, BuildTaskDetail, TaskFilter, TaskPage, TaskState } from "../../../web/src/api/types.ts";
import { absolute, implementationShotPath, SHOT_FILE } from "../../build/artifacts.ts";
import { callRunner, runnerClient, RunnerError } from "../../remote/runner-client.ts";
import { BuildError, createEnv, listEnvs, rotateKey, updateEnv } from "../../build/envs.ts";
import { PRIVATE_STEPS, cancelTask, getTaskDetail, listTasks, summary } from "../../build/tasks.ts";
import { BUILD_FEATURES, REPO_SCOPED, featureStates, shownFeatures, isFeature, setFeature, type BuildFeature } from "../../build/features.ts";
import { ScreenshotConfigError, deleteConfig, listConfigs, putConfig } from "../../verify/screenshot-config.ts";
import { audit } from "../audit.ts";
import { scopeOf, perDayOf, setScope, setPerDay } from "../../prbuild/select.ts";
import type { CacheReport, PrBuildScope } from "../../../web/src/api/types.ts";
import { cacheReport } from "../../build/caches.ts";
import { HttpError } from "../server/util.ts";
import type { Req, Res } from "../types.ts";
import { hiddenRepos, needVisible, visibleRepos } from "./visible.ts";
import { canSeeInternals } from "./staff.ts";
import { isHiddenRepo } from "../../hidden-sql.ts";
import type { Db } from "../../db/index.ts";

const wrap = async <T>(f: () => Promise<T | Promise<T>>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof BuildError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

/** The warm caches; keys of repositories the reader cannot see are left out. */
export const caches = async (db: Db, req: Req): Promise<CacheReport> => await cacheReport(db, await hiddenRepos(db, req));

/** Operators see every environment; others only the enabled ones. */
export const envs = async (db: Db, req: Req): Promise<BuildEnv[]> => (await listEnvs(db)).filter((e) => e.enabled || canSeeInternals(req));

export const postEnv = async (db: Db, req: Req) => wrap(async () => await createEnv(db, req.json, req.user.login));
export const putEnv = async (db: Db, req: Req) => wrap(async () => await updateEnv(db, req.params.id, req.json, req.user.login));
export const postRotate = async (db: Db, req: Req) => wrap(async () => await rotateKey(db, req.params.id, req.user.login));

function intParam(req: Req, name: string): number | undefined {
  const v = req.query.get(name);
  if (v === null || v === "") return undefined;
  if (!/^\d{1,4}$/.test(v)) throw new HttpError(400, `${name} must be a whole number`);
  return Number(v);
}

export const tasks = async (db: Db, req: Req): Promise<TaskPage> => wrap(async () => {
  const q = (k: string) => req.query.get(k) || undefined;
  const repo = q("repo");
  const hidden = await hiddenRepos(db, req);
  if (repo && isHiddenRepo(hidden, repo)) throw new HttpError(404, `${repo} is not a tracked repo`);
  const f: TaskFilter = { state: q("state") as TaskState | "active" | undefined, env: q("env"), repo, cursor: q("cursor"), limit: intParam(req, "limit") };
  return await listTasks(db, f, hidden, canSeeInternals(req));
});

async function visibleTask(db: Db, req: Req): Promise<BuildTaskDetail> {
  if (!/^\d{1,15}$/.test(req.params.id ?? "")) throw new HttpError(400, "not a task id");
  const t = await getTaskDetail(db, Number(req.params.id));
  // The same answer for a task that does not exist and one of a repo the viewer cannot see.
  if (!t || isHiddenRepo(await hiddenRepos(db, req), t.repo) || (PRIVATE_STEPS.includes(t.step) && !canSeeInternals(req))) throw new HttpError(404, "no such task");
  return t;
}

/** Viewers get the task without its log and patch. */
export const task = async (db: Db, req: Req) => wrap(async (): Promise<BuildTaskDetail> => {
  const t = await visibleTask(db, req);
  const canCancel = await mayRunRepo(req.user, t.repo);
  return canSeeInternals(req) ? { ...t, canCancel } : { ...t, canCancel, logTail: null, logBytes: 0, logTruncated: false, patch: null };
});

export const cancel = async (db: Db, req: Req): Promise<BuildTask> => wrap(async () => {
  const t = await visibleTask(db, req);
  await needRunRepo(req, t.repo);
  return await cancelTask(db, req.params.id, req.user.login);
});

export const buildSummary = async (db: Db, req: Req): Promise<BuildSummary> => await summary(db, await hiddenRepos(db, req), canSeeInternals(req));

async function featuresOf(db: Db, req: Req): Promise<BuildFeatures> {
  const tracked = new Set((await db.all(db.k.selectFrom("main.tracked_repos").select("name"))).map((r) => r.name));
  const repos = (await visibleRepos(db, req)).filter((r) => tracked.has(r)).sort();
  const shown = new Set(repos);
  const visible = await shownFeatures(db);
  const features: BuildFeatureState[] = (await featureStates(db)).map((s) => ({ ...s, repoScoped: REPO_SCOPED[s.feature], shown: visible.includes(s.feature), repos: s.repos.filter((r) => shown.has(r)) }));
  const scopes: Record<string, PrBuildScope> = {};
  for (const r of repos) scopes[r] = await scopeOf(db, r);
  const manageable = await filterSeq(repos, async (r) => await mayRunRepo(req.user, r));
  return { features, repos, manageable, prBuilds: { scopes, perDay: await perDayOf(db) } };
}

export const features = async (db: Db, req: Req): Promise<BuildFeatures> => {
  if (!canSeeInternals(req)) throw new HttpError(403, "only operators and maintainers read the build features");
  return featuresOf(db, req);
};

/**
 * Switches a feature for one repo. A shown feature (shownFeatures) goes to an operator or a maintainer with write access to
 * the repo; a hidden one, and scan-tests' instance-wide switch, only to an operator.
 */
export async function switchFeature(db: Db, req: Req, feature: BuildFeature, on: boolean, repo: unknown): Promise<void> {
  if (REPO_SCOPED[feature]) {
    if (typeof repo !== "string" || !repo) throw new HttpError(400, `${feature} is switched per repo: repo is required`);
    const shown = (await shownFeatures(db)).includes(feature);
    if (shown ? !await mayRunRepo(req.user, repo) : req.user.role !== "operator") {
      throw new HttpError(403, shown ? "only an operator, or a maintainer with write access to the repo, switches its build features" : "only an operator switches this build feature");
    }
    await trackedRepo(db, repo);
    await setFeature(db, feature, on, req.user.login, repo);
    return;
  }
  if (repo !== undefined && repo !== null) throw new HttpError(400, `${feature} has no per-repo switch`);
  if (req.user.role !== "operator") throw new HttpError(403, "only an operator switches this build feature");
  await setFeature(db, feature, on, req.user.login);
}

export const postFeature = async (db: Db, req: Req): Promise<BuildFeatures> => {
  const b = (req.json ?? {}) as { feature?: unknown; on?: unknown; repo?: unknown; scope?: unknown; perDay?: unknown };
  if (!isFeature(b.feature)) throw new HttpError(400, `feature must be one of ${BUILD_FEATURES.join(", ")}`);
  if (b.on !== undefined && typeof b.on !== "boolean") throw new HttpError(400, "on must be true or false");
  if (b.on === undefined && b.scope === undefined && b.perDay === undefined) throw new HttpError(400, "on must be true or false");
  // Every field is checked before anything is written.
  if (b.scope !== undefined || b.perDay !== undefined) {
    if (req.user.role !== "operator") throw new HttpError(403, "only an operator changes the PR build scope and daily cap");
    if (b.feature !== "pr-builds") throw new HttpError(400, "only pr-builds has a scope and a daily cap");
    if (b.scope !== undefined && b.scope !== "outside" && b.scope !== "all") throw new HttpError(400, "scope must be outside or all");
    if (b.scope !== undefined && typeof b.repo !== "string") throw new HttpError(400, "repo must be a tracked repo");
    if (b.scope !== undefined) await trackedRepo(db, b.repo as string);
    if (b.perDay !== undefined && (typeof b.perDay !== "number" || !Number.isInteger(b.perDay) || b.perDay < 0 || b.perDay > 1000)) throw new HttpError(400, "perDay must be a whole number from 0 to 1000");
  }
  if (typeof b.on === "boolean") await switchFeature(db, req, b.feature, b.on, b.repo);
  if (b.scope !== undefined && await scopeOf(db, b.repo as string) !== b.scope) { await setScope(db, b.repo as string, b.scope as PrBuildScope); await audit(db, req.user.login, "build-feature", "pr-builds", { feature: "pr-builds", scope: b.scope, repo: b.repo }); }
  if (b.perDay !== undefined && await perDayOf(db) !== b.perDay) { await setPerDay(db, b.perDay as number); await audit(db, req.user.login, "build-feature", "pr-builds", { feature: "pr-builds", perDay: b.perDay }); }
  return featuresOf(db, req);
};

async function screenshotSetups(db: Db, req: Req): Promise<ScreenshotSetups> {
  const shown = new Set(await visibleRepos(db, req));
  const manageable = await filterSeq([...shown].sort(), async (r) => await mayRunRepo(req.user, r));
  return { setups: (await listConfigs(db)).filter((c) => shown.has(c.repo)).map(({ repo, updatedBy, updatedAt, ...config }) => ({ repo, config, updatedBy, updatedAt })), manageable };
}

/** An operator, or a maintainer with write access to the repo, changes its build settings. */
async function needRunRepo(req: Req, repo: string | undefined): Promise<void> {
  if (!repo || !await mayRunRepo(req.user, repo)) throw new HttpError(403, "only an operator, or a maintainer with write access to the repo, changes its build settings");
}

async function trackedRepo(db: Db, repo: string): Promise<string> {
  if (!await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo))) throw new HttpError(400, "repo must be a tracked repo");
  return repo;
}

export const screenshots = async (db: Db, req: Req): Promise<ScreenshotSetups> => {
  if (!canSeeInternals(req)) throw new HttpError(403, "only operators and maintainers read the screenshot setup");
  return screenshotSetups(db, req);
};

export const putScreenshots = async (db: Db, req: Req): Promise<ScreenshotSetups> => {
  await needRunRepo(req, req.params.repo);
  const repo = await trackedRepo(db, req.params.repo);
  try {
    await putConfig(db, req.user.login, repo, req.json);
  } catch (e) {
    if (e instanceof ScreenshotConfigError) throw new HttpError(400, e.message);
    throw e;
  }
  return screenshotSetups(db, req);
};

export const deleteScreenshots = async (db: Db, req: Req): Promise<ScreenshotSetups> => {
  await needRunRepo(req, req.params.repo);
  if (!await deleteConfig(db, req.user.login, req.params.repo)) throw new HttpError(404, "no screenshot setup for that repo");
  return screenshotSetups(db, req);
};

/** An artifact's bytes: from the artifact directory when it is on this disk, otherwise from the runner, which stored them. */
export async function artifactBytes(db: Db, taskId: number, name: string, login: string): Promise<Buffer> {
  const c = runnerClient();
  if (c) {
    try {
      return Buffer.from(await (await callRunner(c, "GET", `/internal/artifacts/${taskId}/${encodeURIComponent(name)}`, login)).arrayBuffer());
    } catch (e) {
      if (e instanceof RunnerError && e.status === 404) throw new HttpError(404, e.message);
      throw e;
    }
  }
  const row = await db.get(db.k.selectFrom("build_artifacts").select("file").where("task_id", "=", taskId).where("name", "=", name));
  const path = row && absolute(row.file);
  if (!path) throw new HttpError(404, "no such artifact");
  try {
    return readFileSync(path);
  } catch {
    throw new HttpError(404, "the artifact file is gone");
  }
}

/** A screenshot an implementation session took (src/implement/session.ts storeShot), for operators and maintainers of its repo. */
export async function implementationShot(db: Db, req: Req): Promise<Res> {
  try {
    if (!canSeeInternals(req)) throw new HttpError(403, "only operators and maintainers see implementation screenshots");
    const id = Number(req.params.id), file = req.params.file ?? "";
    if (!Number.isSafeInteger(id) || !SHOT_FILE.test(file)) throw new HttpError(404, "no such screenshot");
    const row = await db.get(db.k.selectFrom("main.implementations").select("repo").where("id", "=", id));
    if (!row) throw new HttpError(404, "no such screenshot");
    await needVisible(db, req, row.repo);
    let data: Buffer;
    const c = runnerClient();
    if (c) {
      try {
        data = Buffer.from(await (await callRunner(c, "GET", `/internal/implementation-shots/${id}/${file}`, req.user.login)).arrayBuffer());
      } catch (e) {
        if (e instanceof RunnerError && e.status === 404) throw new HttpError(404, e.message);
        throw e;
      }
    } else {
      try { data = readFileSync(implementationShotPath(id, file)); } catch { throw new HttpError(404, "the screenshot file is gone"); }
    }
    return { body: data, headers: { "content-type": "image/png", "content-disposition": "inline", "content-security-policy": "sandbox", "cache-control": "private, max-age=3600" } };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    throw e;
  }
}

export async function artifact(db: Db, req: Req): Promise<Res> {
  try {
    if (!canSeeInternals(req)) throw new HttpError(403, "only operators and maintainers download artifacts");
    const t = await visibleTask(db, req);
    const a = t.artifacts.find((x) => x.name === req.params.name);
    if (!a) throw new HttpError(404, "no such artifact");
    const data = await artifactBytes(db, t.id, a.name, req.user.login);
    return {
      body: data,
      headers: {
        "content-type": a.contentType === "image/png" ? "image/png" : `${a.contentType}; charset=utf-8`,
        "content-disposition": `${a.contentType === "image/png" ? "inline" : "attachment"}; filename="${a.name.replace(/[^A-Za-z0-9._-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(a.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        "content-security-policy": "sandbox",
        "cache-control": "private, max-age=300",
      },
    };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    throw e;
  }
}
