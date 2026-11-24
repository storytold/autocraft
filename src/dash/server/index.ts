// HTTP server: sign-in, sessions, CSRF, rate limits, security headers and
// routing for the dashboard. Handlers only ever see authenticated requests.
import { AppKeys, bindSecrets, useAppKeys } from "../../github/app-keys.ts";
import { maintainerWritesOn } from "../../settlers.ts";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { LOGIN, checkGithubId, getAccess } from "../../access.ts";
import { audit, auditRefusedSignIn } from "../audit.ts";
import type { Res, Role, Route } from "../types.ts";
import { isLoopbackHost, type Config } from "./config.ts";
import { resealLegacyValues } from "./reseal.ts";
import { pkceChallenge, randomToken, safeEqual, TokenBox } from "./crypto.ts";
import { ImageIndex } from "./image-index.ts";
import { visibleTo } from "../api/visible.ts";
import { allowedImage, ImageProxy, imageTokenSource, registerImageRepos } from "./images.ts";
import { TokenBucket } from "./limits.ts";
import { dbReady, serveHealth } from "../../health.ts";
import { serveChecks } from "../../health-checks.ts";
import { discordPrivacyPage, DISCORD_PRIVACY_PATH } from "./discord-privacy.ts";
import { reporterSignIn, REPORTER_CALLBACK_PATH, REPORTER_START_PATH } from "./reporter-signin.ts";
import { FILING_IN_DISCORD } from "../../discord/file-issue.ts";
import { discordTermsPage, DISCORD_TERMS_PATH } from "./discord-terms.ts";
import { contactOf } from "../api/discord.ts";
import { LiveHub, type LiveOptions } from "./live.ts";
import { finishRegistration, githubAppRoutes, startRegistration } from "./github-app.ts";
import { OrgSetup } from "./github-setup.ts";
import { Vault } from "../../github/vault.ts";
import { githubIdentity } from "../../github/identity.ts";
import { saveUserTokens } from "./user-tokens.ts";
import { FakeProvider, WRITE_PERMISSIONS, GitHubProvider, oauthProviderFor, providerFor, type GithubUser, type Provider, type Tokens } from "./provider.ts";
import { retryWaiting } from "../../github/user-lane.ts";
import { appPermission } from "../../remote/permission.ts";
import { cachedWrite, createSession, deleteSession, loadSession, makeUser, PERM_READ_TTL, pruneExpired, SESSION_TTL, userForLogin, type Session } from "./sessions.ts";
import { readSettingsSnapshot, withSettingsSnapshot, type SettingsSnapshot } from "../../settings-read.ts";
import { answering, handleMcp, mcpReply, writes as mcpWrites, type Msg as McpMsg, type Reply as McpReply } from "../mcp/index.ts";
import { loadToken, pruneTokens, type McpCaller } from "../mcp/tokens.ts";
import { sha256hex } from "./crypto.ts";
import * as remote from "../../remote/calls.ts";
import { sweepTakers } from "../../remote/takers.ts";
import { ClaimWaits, heldMsOf } from "../../remote/claim-wait.ts";
import { scaled, TIME_SCALE } from "../../remote/time-scale.ts";
import { isBusy } from "../../db.ts";
import { inferenceMode } from "../../remote/mode.ts";
import { hasFreshRunner, parseStatus, storeStatus } from "../../remote/helpers.ts";
import { addressKey, parseLoginStart, pollLogin, startLogin } from "../../remote/device-login.ts";
import { ENCODINGS, ROUTES, toolContent, type ClaimReply, type LoginPollReply, type LoginStartReply, type StatusReply, type ToolReply } from "../../remote/protocol.ts";
import { userReserve } from "../../remote/reserve.ts";
import { startLiveness } from "../../remote/liveness.ts";
import { WORKSPACE_SERVER } from "../../build/workspace-tools.ts";
import { archiveOf, callTaskTool, LeaseGone, runnerUrl, TASK_TOOLS, taskLease, type TaskLease, type ToolResult } from "../../remote/tools.ts";
import { useRunnerClient } from "../../remote/runner-client.ts";
import { handleDelivery, WEBHOOK_BODY_LIMIT, WEBHOOK_PATH } from "../../github/webhooks.ts";
import { esc, HttpError, parseCookies, plainPage, previewTags, RateLimiter, safeReturnTo, share, shareRate } from "./util.ts";
import { exclusive } from "../../async-seq.ts";
import { refreshReadIdentity } from "../../github/read.ts";
import type { Db } from "../../db/index.ts";

export const SESSION_COOKIE = "__Host-craft_session";
/** `oauth_states.return_to` of an "act as you" authorization, which the shared sign-in callback tells apart from a sign-in by this prefix. */
const AUTHORIZE_PREFIX = "authorize:";
const STATE_COOKIE = "__Host-craft_oauth";
const BODY_LIMIT = 64 * 1024;
/** A helper's submit carries the whole reply (a patch can be large). */
const SUBMIT_BODY_LIMIT = 8 * 1024 * 1024;
/** A task tool call: a `check` call carries the whole patch, as the local bridge allows. */
const TOOL_BODY_LIMIT = 2 * 1024 * 1024;
/** A workspace `write` carries a file of up to 2 MiB, which JSON escaping can make several times larger. */
const WORKSPACE_BODY_LIMIT = 12 * 1024 * 1024;
const toolBodyLimit = (server: string): number => (server === WORKSPACE_SERVER ? WORKSPACE_BODY_LIMIT : TOOL_BODY_LIMIT);
const HELPER_FILE = new URL("../../../worker/autocraft.mjs", import.meta.url);
const PUBLIC_FILES = new Set(["/artcraft-mark.svg", "/artcraft-mark.png"]);
const FILE_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml",
  png: "image/png", ico: "image/x-icon", woff2: "font/woff2", json: "application/json",
  txt: "text/plain; charset=utf-8", webmanifest: "application/manifest+json",
};

// The one inline style the frontend needs: react-remove-scroll-bar (under
// Radix Dialog and DropdownMenu) injects a <style> while a modal is open. Its
// text depends only on the page scrollbar's width and the body's margins,
// which the app's CSS fixes at 0 (body has no margin and overflow: hidden),
// so the text is always the same. Recompute the hash if that package changes
// the text; Chrome's console names the expected hash on a violation.
const RADIX_SCROLL_LOCK_STYLE = "'sha256-nzTgYzXYDNe6BAHiiI7NNlfK8n/auuOAhh2t92YvuXo='";

// The React app (web/): scripts and styles from this origin only, no nonce.
export const APP_CSP = [
  "default-src 'none'", "script-src 'self'", `style-src 'self' ${RADIX_SCROLL_LOCK_STYLE}`,
  "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "form-action 'self'",
  "base-uri 'none'", "frame-ancestors 'none'",
].join("; ");

/** Seconds a helper waits before retrying a request that found the database busy. */
const BUSY_RETRY_S = 5;

export type AppOptions = {
  config: Config;
  db: Db;
  // The connection of the helper routes and the remote maintenance: a short busy timeout, so a locked database answers 503 at
  // once instead of holding the event loop for the 30-second timeout of `db`. Default: `db`.
  remoteDb?: Db;
  provider?: Provider;
  routes?: Route[];          // default: the JSON API
  images?: ImageProxy;       // default: fetches with global fetch and the bot's gh token
  live?: LiveOptions;        // GET /api/live timing; defaults suit production
  // Opinions and comments per login per hour. The dashboard's routes and the MCP server's feedback must share one instance.
  feedbackLimiter?: RateLimiter;
  githubUserId?: (login: string) => Promise<number | null>; // numeric GitHub id of a login for new access entries; default: GitHub's API
  githubApi?: string;        // base URL of the GitHub API for the GitHub App calls; default: api.github.com
};

type Compiled = Route & { parts: string[] };


export async function defaultRoutes(feedbackLimiter?: RateLimiter, githubUserId?: AppOptions["githubUserId"]): Promise<Route[]> {
  const { apiRoutes } = await import("../api/index.ts");
  return apiRoutes({ limiter: feedbackLimiter, ...(githubUserId && { githubUserId }) });
}

function compile(routes: Route[]): Compiled[] {
  return routes.map((r) => ({ ...r, parts: r.pattern.split("/").filter(Boolean) }));
}

function match(routes: Compiled[], method: string, path: string): { route?: Compiled; params?: Record<string, string>; other: boolean } {
  const segs = path.split("/").filter(Boolean);
  let other = false;
  for (const r of routes) {
    if (r.parts.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segs.length && ok; i++) {
      const p = r.parts[i]!;
      if (p.startsWith(":")) {
        try {
          params[p.slice(1)] = decodeURIComponent(segs[i]!);
        } catch {
          ok = false;
        }
      } else ok = p === segs[i];
    }
    if (!ok) continue;
    if (r.method === method) return { route: r, params, other };
    other = true;
  }
  return { other };
}

async function readRaw(req: IncomingMessage, limit: number = BODY_LIMIT): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "Request too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "Request too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const contentType = (req: IncomingMessage): string => (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readRaw(req);
  if (raw.length === 0) return new URLSearchParams();
  if (contentType(req) !== "application/x-www-form-urlencoded") throw new HttpError(415, "Forms must be sent as application/x-www-form-urlencoded");
  return new URLSearchParams(raw.toString("utf8"));
}

/** An MCP message's body cap: start_build and workspace_open take a patch of up to 1 MiB, which JSON escaping can grow. */
const MCP_BODY_LIMIT = 4 * 1024 * 1024;

async function readJson(req: IncomingMessage, limit: number = BODY_LIMIT): Promise<unknown> {
  const raw = await readRaw(req, limit);
  if (raw.length === 0) return undefined;
  if (contentType(req) !== "application/json") throw new HttpError(415, "Send the body as application/json");
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "The body is not valid JSON");
  }
}

const gunzipAsync = promisify(gunzip);
/** Compressed bodies up to this size are inflated on the event loop. */
const SYNC_GUNZIP_MAX = 16 * 1024;

/**
 * readJson for the Task Runner routes: the body may also come as an Envelope (src/remote/protocol.ts ENCODINGS), an object
 * with exactly `encoding` (one of ENCODINGS) and `body` (strings); any other body is plain JSON; its uncompressed body has the same `limit`.
 */
async function readRemoteJson(req: IncomingMessage, limit: number = BODY_LIMIT): Promise<unknown> {
  const json = await readJson(req, limit);
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const keys = Object.keys(json);
  const env = json as { encoding?: unknown; body?: unknown };
  if (keys.length !== 2 || typeof env.encoding !== "string" || typeof env.body !== "string" || !(ENCODINGS as readonly string[]).includes(env.encoding)) return json;
  let raw: Buffer;
  try {
    // A small body under the default limit (status, heartbeat, claim) inflates in microseconds, less than a round trip
    // through the thread pool. Submits may inflate to megabytes, so they stay off the event loop.
    const gz = Buffer.from(env.body, "base64");
    raw = gz.length <= SYNC_GUNZIP_MAX && limit <= BODY_LIMIT ? gunzipSync(gz, { maxOutputLength: limit }) : await gunzipAsync(gz, { maxOutputLength: limit });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new HttpError(413, "Request too large");
    throw new HttpError(400, `The body is not valid ${env.encoding}`);
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "The encoded body is not valid JSON");
  }
}

// API clients send the session's CSRF token in this header; every /api/
// response carries it, so the client reads it from GET /api/me.
export const CSRF_HEADER = "x-csrf-token";
/** The web app's project: one repo name a `scoped` route narrows its list to, or absent for every repo. */
export const SCOPE_HEADER = "x-autocraft-scope";
const scopeOf = (req: IncomingMessage): string | null => {
  const v = req.headers[SCOPE_HEADER];
  return typeof v === "string" && v ? v : null;
};

function cookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export async function createApp(opts: AppOptions & { routes: Route[] }) {
  const { config, db } = opts;
  const rdb = opts.remoteDb ?? db;
  const provider = opts.provider ?? providerFor(config, async () => await githubIdentity(db));
  // The org setup link signs in with the OAuth App even when dashboard sign-in uses the GitHub App.
  const setupProvider = opts.provider ?? (config.devAuth ? provider : oauthProviderFor(config));
  const box = new TokenBox(config.secrets.sessionKey);
  const resealed = await resealLegacyValues(db, box);
  const resealedTotal = Object.values(resealed).reduce((a, b) => a + b, 0);
  if (resealedTotal) console.log(`re-sealed ${resealedTotal} stored token values under the current key (${Object.entries(resealed).map(([t, n]) => `${t} ${n}`).join(", ")})`);
  // The GitHub App's keys live in the database, imported once from the secrets file; `config.secrets.app` reads them.
  const dbAppKeys = await new AppKeys(db, box, config.secretsFile).load();
  bindSecrets(config.secrets, dbAppKeys);
  useAppKeys(dbAppKeys);
  // Without the runner's disk, build artifacts and the Claude accounts are asked of the runner (src/remote/runner-client.ts).
  const runnerBase = runnerUrl();
  useRunnerClient(runnerBase ? { url: runnerBase, sessionKey: config.secrets.sessionKey } : null);
  // The GitHub App's own provider: it signs users in under login=github-app, and always makes and refreshes their user tokens (the "act as you" authorization).
  // Read at each use: registering or removing the app takes effect without a restart.
  const appProviderNow = (): Provider | null => {
    const appKeys = config.secrets.app;
    return opts.provider ?? (config.devAuth ? provider : appKeys ? new GitHubProvider(appKeys.clientId, appKeys.clientSecret) : null);
  };
  const vault = new Vault(db, box, () => appProviderNow() ?? provider);
  const appDeps = { apiBase: opts.githubApi };
  const routes = compile([...opts.routes, ...githubAppRoutes(config, appDeps)]);
  const signinLimit = new RateLimiter(share(60), 10 * 60_000);
  const writeLimitSession = new RateLimiter(share(60), 60_000);
  const writeLimitIp = new RateLimiter(share(300), 60_000);
  const imageIndex = new ImageIndex(db);
  registerImageRepos(async (href) => await imageIndex.reposOf(href));
  const images = opts.images ?? new ImageProxy({
    cacheDir: config.imageCacheDir, repos: async (href) => await imageIndex.reposOf(href),
    token: imageTokenSource(process.env),
  });
  const imageLimit = new RateLimiter(share(120), 60_000);    // upstream fetches per session; cache hits are free
  const imageLimitIp = new RateLimiter(share(240), 60_000);  // and per client address
  // GET endpoints that aggregate the mirror or run the embedder: a burst, then 30 a minute, per session.
  const expensiveGets = new TokenBucket(share(20), shareRate(0.5));
  const live = new LiveHub(db, opts.live);
  // The Inbox MCP server (POST /mcp): calls per login and failed authentications per client address, and feedback posts per login as on the dashboard.
  const mcpLimitToken = new RateLimiter(share(120), 60_000);
  const mcpLimitIp = new RateLimiter(share(300), 60_000);
  // Per helper token, sized for a helper with 16 slots and its fast-lane slot: each idle slot claims every CLAIM_RETRY_S
  // and again at once after a call ends, with retries on errors; status reports come on every change.
  const remoteClaimLimit = new RateLimiter(share(600), 60_000);
  const claimWaits = new ClaimWaits(rdb);
  const remoteStatusLimit = new RateLimiter(share(120), 60_000);
  // Bundle, heartbeat, release and submit of one lease: a heartbeat every 30 seconds and retries.
  const remoteLeaseLimit = new RateLimiter(share(120), 60_000);
  // Tool calls of one remote call (item, reference and check tools together).
  const remoteToolLimit = new RateLimiter(share(300), 60_000);
  const remoteArchiveLimit = new RateLimiter(share(20), 60_000); // tarball fetches per lease
  // Task Runner device logins: starts per client address, polls per credential (one every 5 seconds, with slack).
  const loginStartLimit = new RateLimiter(share(10), 10 * 60_000);
  const loginPollLimit = new RateLimiter(share(30), 60_000);
  const webhookLimitIp = new RateLimiter(share(5000), 60_000);  // flood guard only; the periodic sync still runs. Before the body is read or the signature checked
  // Feedback shares the dashboard's limiter, so the two doors together stay within one budget per login.
  const mcpFeedback = opts.feedbackLimiter ?? new RateLimiter(share(60), 3600_000);
  // list_repos, list_fixups and list_merge_queue aggregate the mirror like the dashboard's expensive GETs: a burst, then 30 a minute, per login.
  const mcpExpensive = new TokenBucket(share(20), shareRate(0.5));
  const callbackUrl = `${config.baseUrl ?? ""}/auth/callback`;
  let lastPrune = 0;

  // The client address for the per-address limits. Each of the `trustProxy` proxies in front of the server appends the
  // address it was reached from to X-Forwarded-For, so the client is that many entries from the end; entries further left
  // came from the client and are not trusted. A proxy that replaces the header with a CDN's client header counts as one.
  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy > 0) {
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[Math.max(0, xff.length - config.trustProxy)]!;
    }
    return req.socket.remoteAddress ?? "?";
  }

  // Ended remote calls, finished check relays and the status of deleted tokens, once a minute; a busy database skips a round.
  // The same pass withdraws queued calls no Task Runner has been able to take for a while and marks repos without one (takers.ts).
  const maintain = exclusive(async () => {
    try {
      await remote.pruneRemote(rdb);
      await sweepTakers(rdb);
      // The live hub refreshes it only while a page is open.
      await refreshReadIdentity(rdb);
    } catch (e) {
      if (!isBusy(e)) console.log(`remote maintenance failed: ${(e as Error).message}`);
    }
  });
  const maintenance = setInterval(() => void maintain.skip(), scaled(60_000));
  maintenance.unref();

  function secure(headers: Record<string, string | string[]>, csp: string): Record<string, string | string[]> {
    headers["content-security-policy"] = csp;
    headers["x-frame-options"] = "DENY";
    headers["referrer-policy"] = "same-origin";
    headers["x-content-type-options"] = "nosniff";
    headers["cross-origin-opener-policy"] = "same-origin";
    headers["cross-origin-resource-policy"] = "same-origin";
    headers["permissions-policy"] = "camera=(), microphone=(), geolocation=()";
    if (config.baseUrl?.startsWith("https:")) headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
    return headers;
  }

  function send(res: ServerResponse, nonce: string, r: Res, extraCookies: string[] = []): void {
    const status = r.status ?? (r.redirect ? 303 : 200);
    const headers: Record<string, string | string[]> = { ...r.headers };
    headers["cache-control"] ??= "no-store";
    // A handler may set its own policy (artifact downloads use `sandbox`).
    const csp = headers["content-security-policy"] as string | undefined;
    delete headers["content-security-policy"];
    secure(headers, csp ?? [
      "default-src 'none'", `script-src 'self' 'nonce-${nonce}'`, `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "form-action 'self'",
      "base-uri 'none'", "frame-ancestors 'none'",
    ].join("; "));
    if (extraCookies.length) headers["set-cookie"] = extraCookies;
    let body: string | Buffer = "";
    if (r.redirect) headers.location = r.redirect;
    if (r.html !== undefined) {
      headers["content-type"] ??= "text/html; charset=utf-8";
      body = r.html;
    } else if (r.body !== undefined) {
      body = r.body;
    } else if (r.json !== undefined) {
      headers["content-type"] ??= "application/json; charset=utf-8";
      body = JSON.stringify(r.json);
    }
    res.writeHead(status, headers);
    res.end(body);
  }

  const errorPage = (nonce: string, status: number, title: string, text: string): Res =>
    ({ status, html: plainPage(nonce, title, `<p>${esc(text)}</p><p><a href="/">Dashboard</a></p>`) });
  const apiError = (status: number, error: string): Res => ({ status, json: { error } });

  // A browser sends Origin on every POST it makes with fetch, and
  // Sec-Fetch-Site on current engines; either one from another site is refused.
  // Clients that send neither still need the CSRF header.
  function sameOrigin(req: IncomingMessage): boolean {
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    const expected = config.baseUrl ?? `http://${req.headers.host ?? ""}`;
    try {
      return origin === new URL(expected).origin;
    } catch {
      return false;
    }
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, nonce: string, session: Session, snapshot?: Promise<SettingsSnapshot>): Promise<void> {
    const method = req.method;
    const out = (r: Res, cookies?: string[]) =>
      send(res, nonce, { ...r, headers: { ...r.headers, [CSRF_HEADER]: session.csrf } }, cookies);
    if (method !== "GET" && method !== "POST" && method !== "PUT" && method !== "DELETE") return out(apiError(405, "method not allowed"));
    const writes = method !== "GET";
    let json: unknown;
    if (writes) {
      if (!sameOrigin(req)) return out(apiError(403, "cross-origin request refused"));
      if (!writeLimitSession.allow(session.idHash) || !writeLimitIp.allow(clientIp(req))) return out(apiError(429, "too many requests; wait a minute"));
      json = await readJson(req);
      if (!safeEqual(String(req.headers[CSRF_HEADER] ?? ""), session.csrf)) return out(apiError(403, "missing or wrong CSRF token"));
      if (url.pathname === "/api/signout") {
        await deleteSession(db, parseCookies(req.headers.cookie).get(SESSION_COOKIE)!);
        return send(res, nonce, { status: 204 }, [cookie(SESSION_COOKIE, "", 0)]);
      }
    }
    const { route, params, other } = match(routes, method, url.pathname);
    if (!route) return out(other ? apiError(405, "method not allowed") : apiError(404, "not found"));
    // Decided on the matched route, so every spelling of its path spends the same budget.
    if (!writes && route.expensive && (route.expensive === true || route.expensive(url.searchParams))) {
      const wait = expensiveGets.take(session.idHash);
      if (wait) return out({ status: 429, json: { error: "too many requests; wait a moment" }, headers: { "retry-after": String(wait) } });
    }
    if (route.operator && session.role !== "operator") return out(apiError(403, "operators only"));
    const run = async (): Promise<Res> => await route.handler(db, {
      method, path: url.pathname, params: params!, query: url.searchParams, form: new URLSearchParams(), json,
      user: makeUser(db, box, provider, session, writes, await githubIdentity(db) === "app"),
      scope: route.scoped && !writes ? scopeOf(req) : null,
      csrf: session.csrf, ip: clientIp(req), nonce,
    });
    // A read request takes its settings from one reading of the table, as a planner pass does, and its parts share the
    // rows they read alike (the item row, the repo lists), so each costs one round trip.
    const res2 = writes ? await run() : await db.shareReads(async () => await withSettingsSnapshot(db, run, snapshot));
    // The writer sees its own change at once; other processes' writes arrive on the watcher's next read.
    if (writes) await live.poke();
    return out(res2);
  }

  // GET /api/live: same session as /api, but no rate limit and no request timeout.
  async function handleLive(req: IncomingMessage, res: ServerResponse, nonce: string, session: Session): Promise<void> {
    if (live.full) return send(res, nonce, apiError(503, "too many live connections"));
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    const cookieId = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const headers = secure({
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no",
      [CSRF_HEADER]: session.csrf,
    }, "default-src 'none'");
    res.writeHead(200, headers);
    await live.add(res, async () => await loadSession(db, cookieId) !== null, session.idHash);
  }

  /** Under the app identity with no app keys, sign-in has nothing to go through: it is refused, never sent to the OAuth App. */
  const signInBlocked = async (): Promise<boolean> => await githubIdentity(db) === "app" && !opts.provider && !config.devAuth && !config.secrets.app;
  const noAppPage = (nonce: string): Res => errorPage(nonce, 503, "Sign-in unavailable", "GitHub sign-in is set to the GitHub App, but no app keys are available. An operator must restore the app's keys or switch the GitHub identity back to the box account.");

  async function startOAuth(returnTo: string, selectAccount: boolean, scopes?: string[], p: Provider = provider): Promise<{ r: Res; cookies: string[] }> {
    const state = randomToken(24), verifier = randomToken(48);
    await db.run(db.k.insertInto("oauth_states")
      .values({ state, verifier, return_to: returnTo, identity: await githubIdentity(db), created_at: new Date().toISOString() }));
    return {
      r: { redirect: await p.authorizeUrl(state, pkceChallenge(verifier), callbackUrl, selectAccount, scopes) },
      cookies: [cookie(STATE_COOKIE, state, 600)],
    };
  }

  const setup = new OrgSetup({
    db, config, deps: appDeps, provider: setupProvider,
    startOAuth: async (returnTo, scopes) => await startOAuth(returnTo, true, scopes, setupProvider),
    sameOrigin: (req) => sameOrigin(req),
    readForm: readBody,
  });

  async function auth(req: IncomingMessage, url: URL, nonce: string, cookies: Map<string, string>): Promise<{ r: Res; cookies?: string[] }> {
    const ip = clientIp(req);
    const path = url.pathname;
    if (path.startsWith("/auth/setup") || path === "/auth/github-app/setup" || (path === "/auth/github-app/callback" && await setup.ownsState(url.searchParams.get("state") ?? ""))) {
      if (!signinLimit.allow(ip)) return { r: errorPage(nonce, 429, "Too many attempts", "Wait a few minutes and try again.") };
      const out = await setup.handle(req, url, nonce, cookies, (await loadSession(db, cookies.get(SESSION_COOKIE)))?.role === "operator");
      if (out) return out;
    }
    if (req.method === "GET" && path === "/auth/signin") {
      if (!signinLimit.allow(ip)) return { r: errorPage(nonce, 429, "Too many attempts", "Wait a few minutes and try again.") };
      const returnTo = safeReturnTo(url.searchParams.get("return_to"));
      if (await loadSession(db, cookies.get(SESSION_COOKIE))) return { r: { redirect: returnTo } };
      if (await signInBlocked()) return { r: noAppPage(nonce) };
      return await startOAuth(returnTo, url.searchParams.get("select") === "1");
    }
    if (req.method === "GET" && path === "/auth/authorize-app") {
      if (!signinLimit.allow(ip)) return { r: errorPage(nonce, 429, "Too many attempts", "Wait a few minutes and try again.") };
      const returnTo = safeReturnTo(url.searchParams.get("return_to"));
      const s = await loadSession(db, cookies.get(SESSION_COOKIE));
      if (!s) return { r: { redirect: `/auth/signin?${new URLSearchParams({ return_to: `/auth/authorize-app?${new URLSearchParams({ return_to: returnTo })}` })}` } };
      if (s.role !== "operator") return { r: errorPage(nonce, 403, "Not authorised", "Only operators authorize AutoCraft to act as them.") };
      const appProvider = appProviderNow();
      if (!appProvider) return { r: errorPage(nonce, 409, "No GitHub App", "No GitHub App is registered, so there is nothing to authorize.") };
      return await startOAuth(`${AUTHORIZE_PREFIX}${returnTo}`, false, undefined, appProvider);
    }
    if (req.method === "GET" && path === "/auth/callback") {
      if (!signinLimit.allow(ip)) return { r: errorPage(nonce, 429, "Too many attempts", "Wait a few minutes and try again.") };
      const clear = [cookie(STATE_COOKIE, "", 0)];
      if (url.searchParams.get("error")) {
        return { r: errorPage(nonce, 400, "Sign-in cancelled", "GitHub sign-in did not complete."), cookies: clear };
      }
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      const row = await db.get(db.k.selectFrom("oauth_states").select(["verifier", "return_to", "identity", "created_at"]).where("state", "=", state));
      const cookieState = cookies.get(STATE_COOKIE) ?? "";
      const stateOk = !!row && safeEqual(cookieState, state);
      if (stateOk) await db.run(db.k.deleteFrom("oauth_states").where("state", "=", state));
      if (!row || !code || !stateOk || Date.now() - Date.parse(row.created_at) > 600_000) {
        return { r: errorPage(nonce, 400, "Sign-in expired", "Start again from the sign-in link."), cookies: clear };
      }
      const plainSignIn = !row.return_to?.startsWith("setup:") && !row.return_to?.startsWith(AUTHORIZE_PREFIX);
      // A sign-in finishes under the identity it started with; if that is no longer the current one, it starts again.
      const startedAs: "box" | "app" = row.identity === "app" ? "app" : row.identity === "box" ? "box" : await githubIdentity(db);
      const changed = async (): Promise<boolean> => plainSignIn && startedAs !== await githubIdentity(db);
      if (plainSignIn && await signInBlocked()) return { r: noAppPage(nonce), cookies: clear };
      if (await changed()) return { r: errorPage(nonce, 400, "Sign-in failed", "The GitHub identity changed during sign-in. Start again."), cookies: clear };
      let tokens: Tokens | null, who: GithubUser | null;
      try {
        const p = row.return_to?.startsWith("setup:") ? setupProvider : row.return_to?.startsWith(AUTHORIZE_PREFIX) ? (appProviderNow() ?? provider) : opts.provider || config.devAuth ? provider : providerFor(config, async () => startedAs);
        tokens = await p.exchange(code, row.verifier, callbackUrl);
        who = tokens ? await p.identity(tokens.access) : null;
      } catch (e) {
        console.error(`sign-in: ${(e as Error).message}`);
        return { r: errorPage(nonce, 502, "Sign-in failed", "GitHub did not answer. Try again in a minute."), cookies: clear };
      }
      if (!tokens || !who) {
        return { r: errorPage(nonce, 400, "Sign-in failed", "GitHub did not accept the sign-in. Start again."), cookies: clear };
      }
      if (row.return_to?.startsWith("setup:")) {
        const out = await setup.signedIn(row.return_to, tokens, who, nonce, cookies);
        return { r: out.r, cookies: [...clear, ...(out.cookies ?? [])] };
      }
      if (row.return_to?.startsWith(AUTHORIZE_PREFIX)) {
        // "Act as you": only the user token is stored. The session and the sign-in are untouched.
        const s = await loadSession(db, cookies.get(SESSION_COOKIE));
        if (!s || s.role !== "operator" || s.login.toLowerCase() !== who.login.toLowerCase() || await checkGithubId(db, s.login, who.id) === "mismatch") {
          // The token belongs to an account that may not act here: end it before answering.
          void (appProviderNow() ?? provider).revoke(tokens.access).catch(() => {});
          return { r: errorPage(nonce, 403, "Not authorised", "Sign in to the dashboard as the GitHub account you authorize, then try again."), cookies: clear };
        }
        await saveUserTokens(db, box, s.login, who.id, tokens);
        await retryWaiting(db, s.login);
        await audit(db, s.login, "github-app-authorize", s.login, { ip });
        return { r: { redirect: safeReturnTo(row.return_to.slice(AUTHORIZE_PREFIX.length)) }, cookies: clear };
      }
      const login = who.login;
      const access = await getAccess(db, login);
      if (!access) {
        await auditRefusedSignIn(db, login, { ip });
        return { r: errorPage(nonce, 403, "Not authorised", `The GitHub account ${login} is not on this dashboard's access list.`), cookies: clear };
      }
      if (await checkGithubId(db, access.login, who.id) === "mismatch") {
        await auditRefusedSignIn(db, login, { ip, reason: "github-id-mismatch" });
        return { r: errorPage(nonce, 403, "Not authorised", `The GitHub account ${login} is not the account that was added to this dashboard's access list.`), cookies: clear };
      }
      if (await changed()) return { r: errorPage(nonce, 400, "Sign-in failed", "The GitHub identity changed during sign-in. Start again."), cookies: clear };
      const id = await createSession(db, box, access.login, tokens, req.headers["user-agent"]);
      if (startedAs === "app") { await saveUserTokens(db, box, access.login, who.id, tokens); await retryWaiting(db, access.login); }
      await audit(db, access.login, "sign-in", access.login, { ip });
      return {
        r: { redirect: safeReturnTo(row.return_to) },
        cookies: [...clear, cookie(SESSION_COOKIE, id, SESSION_TTL / 1000)],
      };
    }
    if (req.method === "POST" && path === "/auth/github-app/start") {
      if (!signinLimit.allow(ip)) return { r: errorPage(nonce, 429, "Too many attempts", "Wait a few minutes and try again.") };
      if (!sameOrigin(req)) return { r: errorPage(nonce, 403, "Refused", "This form was sent from another site.") };
      const form = await readBody(req);
      const s = await loadSession(db, cookies.get(SESSION_COOKIE));
      if (!s) return { r: { redirect: `/auth/signin?${new URLSearchParams({ return_to: "/admin/github-app" })}` } };
      if (!safeEqual(form.get("csrf") ?? "", s.csrf)) return { r: errorPage(nonce, 403, "Refused", "The form expired. Reload the page and try again.") };
      return { r: await startRegistration(db, config, req, form, nonce, s) };
    }
    if (req.method === "GET" && path === "/auth/github-app/callback") {
      if (!signinLimit.allow(ip)) return { r: errorPage(nonce, 429, "Too many attempts", "Wait a few minutes and try again.") };
      const s = await loadSession(db, cookies.get(SESSION_COOKIE));
      if (!s) return { r: { redirect: `/auth/signin?${new URLSearchParams({ return_to: "/admin/github-app" })}` } };
      return { r: await finishRegistration(db, config, appDeps, url, nonce, s) };
    }
    if (req.method === "POST" && path === "/auth/signout") {
      if (!sameOrigin(req)) return { r: errorPage(nonce, 403, "Refused", "This form was sent from another site.") };
      const form = await readBody(req);
      const id = cookies.get(SESSION_COOKIE);
      const s = await loadSession(db, id);
      if (s) {
        if (!safeEqual(form.get("csrf") ?? "", s.csrf)) return { r: errorPage(nonce, 403, "Refused", "The form expired. Reload the page and try again.") };
        await deleteSession(db, id!);
      }
      return { r: { redirect: "/auth/signed-out" }, cookies: [cookie(SESSION_COOKIE, "", 0)] };
    }
    if (req.method === "GET" && path === "/auth/signed-out") {
      return { r: { html: plainPage(nonce, "Signed out", `<p class="muted">You are signed out of the dashboard on this device.</p><p><a class="button" href="/auth/signin?select=1">Sign in again</a></p>`) } };
    }
    if (req.method === "GET" && path === "/auth/dev/authorize" && provider instanceof FakeProvider) {
      const q = url.searchParams;
      if (q.get("redirect_uri") !== callbackUrl) return { r: errorPage(nonce, 400, "Bad request", "Unknown redirect_uri.") };
      const login = q.get("login");
      if (login !== null) {
        if (!LOGIN.test(login)) return { r: errorPage(nonce, 400, "Bad request", "Not a GitHub login.") };
        const code = provider.issueCode(login, q.get("code_challenge") ?? "", callbackUrl);
        return { r: { redirect: `${callbackUrl}?${new URLSearchParams({ code, state: q.get("state") ?? "" })}` } };
      }
      const hidden = ["state", "code_challenge", "redirect_uri"]
        .map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k))}">`).join("");
      return {
        r: {
          html: plainPage(nonce, "Development sign-in", `<p class="muted">Fake GitHub sign-in. Development only.</p>
<form method="get" action="/auth/dev/authorize">${hidden}<label>GitHub login <input name="login" required autofocus></label> <button>Sign in</button></form>`),
        },
      };
    }
    return { r: errorPage(nonce, 404, "Not found", "No such page.") };
  }

  /** A request with an operator's or maintainer's session: /healthz/checks gives them its times and counts. */
  const staffCaller = async (req: IncomingMessage): Promise<boolean> => {
    const role = (await loadSession(db, parseCookies(req.headers.cookie).get(SESSION_COOKIE)))?.role;
    return role === "operator" || role === "maintainer";
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (await serveHealth(req, res, async () => await dbReady(db)) || await serveChecks(req, res, db, Date.now(), 5_000, staffCaller)) return;
    const nonce = randomToken(16);
    try {
      if (Date.now() - lastPrune > 3_600_000) {
        lastPrune = Date.now();
        await pruneExpired(db);
        await pruneTokens(db);
        void vault.sweepRevocations().catch(() => {});
      }
      // A revoked session's token is revoked at once, not at the next hourly sweep; failures are retried by that sweep. The check
      // runs alongside the session read; routes that return before it leave it running on its own.
      const revocations = db.get(db.k.selectFrom("user_token_revocations").select("id").where("attempts", "=", 0).limit(1))
        .then((r) => { if (r) void vault.sweepRevocations(true).catch(() => {}); });
      revocations.catch(() => {});
      // Dev auth lets anyone who reaches the port sign in as any login, so
      // a request that came through a proxy or under a public name is refused.
      if (config.devAuth && (req.headers["x-forwarded-for"] !== undefined || !isLoopbackHost(req.headers.host))) {
        return send(res, nonce, errorPage(nonce, 403, "Refused", "Development sign-in answers only on localhost."));
      }
      const url = new URL(req.url ?? "/", "http://dashboard.invalid");
      const cookies = parseCookies(req.headers.cookie);
      if (url.pathname.startsWith("/auth/")) {
        const { r, cookies: set } = await auth(req, url, nonce, cookies);
        return send(res, nonce, r, set);
      }
      if (url.pathname === "/mcp") return await handleMcpHttp(req, res);
      // The Task Runner routes, never with the session cookie; the Connect page's runner routes are /api/runners.
      if (url.pathname.startsWith("/api/remote/")) return await handleRemoteHttp(req, res, url);
      if (url.pathname.startsWith(`${ROUTES.mcp}/`)) return await handleTaskMcp(req, res, url);
      // Public: the helper script, which a maintainer downloads before having any credential.
      if (url.pathname === ROUTES.helper || url.pathname === ROUTES.legacyHelper) return await sendHelper(req, res);
      if (url.pathname === WEBHOOK_PATH) return await handleWebhook(req, res);
      const method = req.method;
      // Public: the Discord bot's privacy notice must be readable by people who are not dashboard users.
      if (method === "GET" && url.pathname === DISCORD_PRIVACY_PATH) return send(res, nonce, { html: discordPrivacyPage(nonce, await contactOf(db)) });
      // Public: a Discord reporter's GitHub sign-in for filing issues (no dashboard session).
      if (FILING_IN_DISCORD && method === "GET" && (url.pathname === REPORTER_START_PATH || url.pathname === REPORTER_CALLBACK_PATH)) {
        if (!signinLimit.allow(clientIp(req))) return send(res, nonce, errorPage(nonce, 429, "Too many attempts", "Wait a few minutes and try again."));
        const out = await reporterSignIn({ db, box, provider: appProviderNow(), baseUrl: config.baseUrl }, url, cookies, nonce);
        if (out) return send(res, nonce, out.r, out.cookies);
      }
      if (method === "GET" && url.pathname === DISCORD_TERMS_PATH) return send(res, nonce, { html: discordTermsPage(nonce, await contactOf(db)) });
      // Public: the favicon and the preview image, which sign-in pages and link-preview crawlers load without a session.
      if (method === "GET" && PUBLIC_FILES.has(url.pathname)) return await sendWeb(res, nonce, url.pathname);
      // A read request's settings snapshot is read with the session (handleApi).
      const snapshot = method === "GET" && url.pathname.startsWith("/api/") && url.pathname !== "/api/live" ? readSettingsSnapshot(db) : undefined;
      snapshot?.catch(() => {});
      const [session] = await Promise.all([loadSession(db, cookies.get(SESSION_COOKIE)), revocations, snapshot]);
      if (!session) {
        const wantsPage = method === "GET" && /text\/html/.test(String(req.headers.accept ?? ""));
        if (wantsPage) {
          // A page with preview tags that moves on to sign-in at once: link-preview crawlers read the tags and stop here,
          // where a redirect would take them to the identity provider's page and its preview.
          const to = `/auth/signin?${new URLSearchParams({ return_to: url.pathname + url.search })}`;
          return send(res, nonce, { html: plainPage(nonce, "Sign in", `<p><a class="button" href="${esc(to)}">Sign in with GitHub</a></p>`,
            `<meta http-equiv="refresh" content="0;url=${esc(to)}">${previewTags(config.baseUrl, url.pathname)}`) });
        }
        return send(res, nonce, { status: 401, json: { error: "sign-in required" } });
      }
      if (method === "GET" && url.pathname === "/api/live") return await handleLive(req, res, nonce, session);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, nonce, session, snapshot);
      if (url.pathname === "/img") return await sendImage(req, res, url, session);
      // Every other address belongs to the React app, which routes on the client.
      if (method === "GET") return await sendWeb(res, nonce, url.pathname);
      return send(res, nonce, errorPage(nonce, 405, "Not allowed", "This address does not accept that request."));
    } catch (e) {
      const api = (req.url ?? "").startsWith("/api/");
      if (e instanceof HttpError) return send(res, nonce, api ? apiError(e.status, e.message) : errorPage(nonce, e.status, "Request refused", e.message));
      // The database stayed locked past the connection's busy timeout (the helper routes wait only briefly): try again shortly.
      if (isBusy(e)) {
        if (res.headersSent) return void res.destroy();
        res.writeHead(503, secure({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "retry-after": String(BUSY_RETRY_S) }, "default-src 'none'"));
        return void res.end(JSON.stringify({ error: "the database is busy; try again shortly" }));
      }
      console.error(`${req.method} ${(req.url ?? "").split("?")[0]}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(res, nonce, api ? apiError(500, "server error; it is logged") : errorPage(nonce, 500, "Something went wrong", "The error is logged on the server."));
      else res.destroy();
    }
  }

  // POST /mcp: one JSON-RPC message, authenticated by an agent token (Authorization: Bearer), never by the session
  // cookie, so a browser page cannot make a signed-in user's browser call it. A request from a browser
  // context on another site (Origin or Sec-Fetch-Site) is refused, which also covers DNS rebinding.
  // GitHub App deliveries: no session and no CSRF check; the HMAC signature over the raw body is the authentication.
  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, allow?: string): void => {
      res.writeHead(status, secure({ "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", ...(allow ? { allow } : {}) }, "default-src 'none'"));
      res.end("");
    };
    if (req.method !== "POST") return reply(405, "POST");
    if (!webhookLimitIp.allow(clientIp(req))) return reply(429);
    let raw: Buffer;
    try {
      raw = await readRaw(req, WEBHOOK_BODY_LIMIT);
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status);
      throw e;
    }
    const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
    const v = await handleDelivery(db, config.secrets.app?.webhookSecret ?? null, { signature: one(req.headers["x-hub-signature-256"]), event: one(req.headers["x-github-event"]) }, raw, safeEqual, config.secrets.app?.slug ?? null);
    return reply(v.status);
  }

  async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, secure({ "cache-control": "no-store", ...(body === null ? {} : { "content-type": "application/json; charset=utf-8" }), ...headers }, "default-src 'none'"));
      res.end(body === null ? "" : JSON.stringify(body));
    };
    const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", id: null, error: { code, message } });
    if (req.method !== "POST") return reply(405, rpcError(-32000, "POST one JSON-RPC message; this server has no event stream"), { allow: "POST" });
    if (!sameOrigin(req)) return reply(403, rpcError(-32000, "cross-origin request refused"));
    const auth = String(req.headers.authorization ?? "");
    const caller = await loadToken(db, /^Bearer\s+(\S+)$/i.exec(auth)?.[1]);
    // The per-address limit counts failed authentications only: behind a proxy every client shares one address.
    if (!caller && !mcpLimitIp.allow(clientIp(req))) return reply(429, rpcError(-32000, "too many requests; wait a minute"), { "retry-after": "60" });
    if (!caller) return reply(401, rpcError(-32001, "a valid AutoCraft agent token is required (Authorization: Bearer <token>); make one on the dashboard's Connect page"), { "www-authenticate": 'Bearer realm="autocraft"' });
    if (!caller.canAgent) return reply(403, rpcError(-32001, "this Task Runner has no agent access; tick Agent access for it on the dashboard's Connect page"));
    if (!mcpLimitToken.allow(caller.login.toLowerCase())) return reply(429, rpcError(-32000, "too many requests for this login; wait a minute"), { "retry-after": "60" });
    let msg: unknown;
    try {
      msg = await readJson(req, MCP_BODY_LIMIT);
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, rpcError(e.status === 400 ? -32700 : -32600, e.message));
      throw e;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return reply(400, rpcError(-32600, "send one JSON-RPC message as an object; batches are not supported"));
    const m = msg as McpMsg;
    // A tool call may wait minutes (a workspace's shell command): its reply keeps the request open with leading spaces.
    const waiting = m.method === "tools/call" ? waitingJson(res) : null;
    const out = await handleMcp({
      db, baseUrl: config.baseUrl, limiter: mcpFeedback, expensive: () => mcpExpensive.take(caller.login.toLowerCase()), canAnswer: answering.enabled && caller.canAnswer && (caller.role === "operator" || (caller.role === "maintainer" && await maintainerWritesOn(db))),
      user: async (forWrite) => await userForLogin(db, box, provider, caller.login, caller.role, forWrite),
      // The task tools are offered while one of the login's Task Runners reports in; they never lease.
      ...(await inferenceMode(db) === "user-local" && { userLocal: true, ...(await hasFreshRunner(db, caller.login) && { run: { canWrite: (await claimPermission(caller.login, caller.role)).canWrite } }) }),
      ...(waiting && { wait: waiting.opts }),
    }, m);
    if (mcpWrites(m)) await live.poke();
    if (waiting && res.headersSent) return waiting.send(out ?? { jsonrpc: "2.0", id: null, result: {} });
    // A notification or a response from the client: accepted, nothing to say.
    if (!out) return reply(202, null);
    return reply(200, out);
  }

  // A claim hands out work on the repo: the write permission it checks is at most a minute old, read through the GitHub App
  // when it is installed for the repo's owner (no dashboard session needed), else from the login's session. While GitHub cannot be
  // asked, a write permission confirmed within PERM_READ_TTL still counts, so a GitHub failure does not stall the helpers;
  // past that the call is passed over and `errors` says why.
  // Claims are helper routes: the permission reads and writes use their short busy timeout (rdb).
  async function claimPermission(login: string, role: Role): Promise<{ canWrite: (repo: string) => Promise<boolean>; errors: Map<string, string> }> {
    const user = await userForLogin(rdb, box, provider, login, role, true);
    const errors = new Map<string, string>();
    return {
      errors,
      canWrite: async (repo) => {
        const app = await appPermission(rdb, login, repo);
        if (app.kind === "ok") return WRITE_PERMISSIONS.has(app.permission);
        if (app.kind === "error") {
          if (await cachedWrite(rdb, login, repo, PERM_READ_TTL)) return true;
          errors.set(repo, app.why);
          return false;
        }
        if (await user.canWrite(repo)) return true;
        const why = await user.permissionError?.(repo);
        if (!why) return false;
        if (await cachedWrite(rdb, login, repo, PERM_READ_TTL)) return true;
        errors.set(repo, why);
        return false;
      },
    };
  }

  // The routes of the Task Runner (src/remote/protocol.ts ROUTES): login start with no credential, login poll with the pending
  // credential, claim and status with a runner credential, the others with the lease secret of one call. Never the session
  // cookie; a browser request from another site is refused.
  async function handleRemoteHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, secure({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers }, "default-src 'none'"));
      res.end(JSON.stringify(body));
    };
    if (!sameOrigin(req)) return reply(403, { error: "cross-origin request refused" });
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    const path = url.pathname;
    const method = path === ROUTES.bundle || path === ROUTES.tarball ? "GET" : "POST";
    if (req.method !== method) return reply(405, { error: `use ${method}` }, { allow: method });
    const tooMany = (): void => reply(429, { error: "too many requests; wait a minute" }, { "retry-after": "60" });
    const db = rdb;
    /** The runner credential's caller, or null once the refusal is sent. */
    const runner = async (): Promise<McpCaller | null> => {
      const caller = await loadToken(db, bearer);
      if (!caller) {
        if (!mcpLimitIp.allow(clientIp(req))) tooMany();
        else reply(401, { error: "a valid Task Runner credential is required (Authorization: Bearer <credential>); run autocraft login" }, { "www-authenticate": 'Bearer realm="autocraft"' });
        return null;
      }
      if (caller.kind === "runner") return caller;
      reply(403, { error: "MCP Connector tokens cannot run tasks; log the Task Runner in with autocraft login" });
      return null;
    };
    try {
      if (path === ROUTES.loginStart) {
        const ip = clientIp(req);
        if (!loginStartLimit.allow(addressKey(ip))) return reply(429, { error: "too many logins from this address; wait a few minutes" }, { "retry-after": "600" });
        const start = parseLoginStart(await readRemoteJson(req));
        return reply(200, await startLogin(db, start, ip, config.baseUrl ?? `http://${req.headers.host ?? "localhost"}`) satisfies LoginStartReply);
      }
      if (path === ROUTES.loginPoll) {
        if (!bearer || bearer.length > 200) return reply(401, { error: "send the credential the login was started with (Authorization: Bearer <credential>)" }, { "www-authenticate": 'Bearer realm="autocraft"' });
        if (!loginPollLimit.allow(sha256hex(bearer))) return reply(429, { error: "polled too often" }, { "retry-after": "5" });
        const out = await pollLogin(db, bearer);
        if (!out && !mcpLimitIp.allow(clientIp(req))) return tooMany();
        return out ? reply(200, out satisfies LoginPollReply) : reply(401, { error: "no login was started with this credential" }, { "www-authenticate": 'Bearer realm="autocraft"' });
      }
      if (path === ROUTES.claim) {
        const caller = await runner();
        if (!caller) return;
        if (!remoteClaimLimit.allow(String(caller.tokenId))) return tooMany();
        // A held claim whose client leaves stops waiting; a reply already written does not count as leaving. Listened for
        // before the body is read, so a client that leaves while it is sent is never held.
        const gone = new AbortController();
        res.once("close", () => { if (!res.writableEnded) gone.abort(); });
        if (req.socket.destroyed) gone.abort();
        const claim = remote.parseClaim(await readRemoteJson(req));
        // The permission reader's session read runs with the claim's first reads, which also read the mode: in the server mode the claim takes nothing.
        let errors: Map<string, string> | null = null;
        const perm = claimPermission(caller.login, caller.role).then((p) => (errors = p.errors, p));
        void perm.catch(() => {});
        const canWrite = async (repo: string): Promise<boolean> => await (await perm).canWrite(repo);
        const out = await remote.claimCall(db, caller, claim, canWrite, Date.now(), { waits: claimWaits, signal: gone.signal, blocked: () => (errors?.size ?? 0) > 0 }, { userLocalOnly: true });
        // Calls passed over because GitHub could not confirm the permission: the helper logs why it gets nothing.
        const failed = errors as Map<string, string> | null;
        if (!out.lease && out.reason === undefined && failed?.size) out.reason = [...failed.values()][0];
        // How long the claim waited for a call, so a latency measurement can leave it out.
        return reply(200, { ...out, encodings: [...ENCODINGS], ...(await servedHelperVersion().then((v) => v && { currentHelper: v }, () => undefined)) } satisfies ClaimReply, { "x-held-ms": String(heldMsOf(out)) });
      }
      if (path === ROUTES.status) {
        const caller = await runner();
        if (!caller) return;
        if (!remoteStatusLimit.allow(String(caller.tokenId))) return tooMany();
        await storeStatus(db, caller.tokenId, caller.login, parseStatus(await readRemoteJson(req)));
        return reply(200, { ok: true, reserve: await userReserve(db, caller.login), encodings: [...ENCODINGS] } satisfies StatusReply);
      }
      const tool = path.startsWith(`${ROUTES.tool}/`) ? /^([a-z][a-z0-9_-]{0,40})\/([a-z][a-z0-9_]{0,60})$/.exec(path.slice(ROUTES.tool.length + 1)) : null;
      if (![ROUTES.bundle, ROUTES.heartbeat, ROUTES.submit, ROUTES.release, ROUTES.tarball].includes(path as never) && !tool) return reply(404, { error: "not found" });
      // An unknown secret counts against the address; a known one whose lease ended or went back to the queue is answered 410.
      const state = await remote.leaseState(db, bearer);
      if (!state) {
        if (!mcpLimitIp.allow(clientIp(req))) return tooMany();
        return reply(401, { error: "a lease secret is required (Authorization: Bearer <secret>)" }, { "www-authenticate": 'Bearer realm="autocraft"' });
      }
      if (path !== ROUTES.tarball && !tool && !remoteLeaseLimit.allow(String(state.id))) return tooMany();
      const gone = (): void => reply(410, { error: "the lease is gone (expired, withdrawn or already submitted)" });
      if (path === ROUTES.bundle) {
        const b = await remote.bundleOf(db, bearer);
        return b ? reply(200, b) : gone();
      }
      if (path === ROUTES.heartbeat) return await remote.heartbeat(db, bearer, await readRemoteJson(req)) ? reply(200, { ok: true }) : gone();
      if (path === ROUTES.release) return await remote.releaseCall(db, bearer, await readRemoteJson(req)) ? reply(200, { ok: true }) : gone();
      if (path === ROUTES.submit) {
        const out = await remote.submitCall(db, bearer, await readRemoteJson(req, SUBMIT_BODY_LIMIT));
        return out ? reply(200, out) : gone();
      }
      const lease = await taskLease(db, bearer);
      if (!lease) return gone();
      if (path === ROUTES.tarball) {
        if (!remoteArchiveLimit.allow(String(lease.id))) return tooMany();
        return await sendArchive(res, lease, bearer!, url.searchParams.get("repo") ?? "", url.searchParams.get("sha") ?? "");
      }
      const [, server, name] = tool!;
      if (!TASK_TOOLS[server!] || !lease.servers.includes(server!)) return reply(403, { error: `this call has no ${server} tools` });
      if (!remoteToolLimit.allow(String(lease.id))) return tooMany();
      const args = await readRemoteJson(req, toolBodyLimit(server!));
      const w = waitingJson(res);
      const r = await callTaskTool(db, lease, bearer!, server!, name, args, w.opts);
      return w.send({ content: toolContent(r), ...(r.isError && { isError: true }) } satisfies ToolReply);
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.message });
      throw e;
    }
  }

  /**
   * A JSON reply that may take minutes (a relayed `check`): while waiting, `tick` sends the headers and then a space, so
   * clients and proxies with idle timeouts keep the request open; JSON allows the leading whitespace. `signal` is the
   * client going away.
   */
  function waitingJson(res: ServerResponse): { opts: { signal: AbortSignal; tick: () => void }; send: (body: unknown) => void } {
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const headers = (): Record<string, string | string[]> => secure({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8" }, "default-src 'none'");
    return {
      opts: { signal: ac.signal, tick: () => { if (!res.headersSent) res.writeHead(200, headers()); res.write(" "); } },
      send: (body) => { if (!res.headersSent) res.writeHead(200, headers()); res.end(JSON.stringify(body)); },
    };
  }

  // POST /mcp/task/<server>: the tools of one server of a remote call as a Streamable HTTP MCP server (one JSON-RPC message
  // per request, a JSON reply, no event stream), authenticated by the call's lease secret, for harnesses that take tools through MCP.
  async function handleTaskMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, secure({ "cache-control": "no-store", ...(body === null ? {} : { "content-type": "application/json; charset=utf-8" }), ...headers }, "default-src 'none'"));
      res.end(body === null ? "" : JSON.stringify(body));
    };
    const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", id: null, error: { code, message } });
    const db = rdb;
    if (req.method !== "POST") return reply(405, rpcError(-32000, "POST one JSON-RPC message; this server has no event stream"), { allow: "POST" });
    if (!sameOrigin(req)) return reply(403, rpcError(-32000, "cross-origin request refused"));
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!await remote.leaseState(db, bearer)) {
      if (!mcpLimitIp.allow(clientIp(req))) return reply(429, rpcError(-32000, "too many requests; wait a minute"), { "retry-after": "60" });
      return reply(401, rpcError(-32001, "a lease secret is required (Authorization: Bearer <secret>)"), { "www-authenticate": 'Bearer realm="autocraft"' });
    }
    const lease = await taskLease(db, bearer);
    if (!lease) return reply(410, rpcError(-32001, "the lease is gone (expired, withdrawn or already submitted)"));
    const server = url.pathname.slice(ROUTES.mcp.length + 1);
    const tools = TASK_TOOLS[server];
    if (!tools || !lease.servers.includes(server)) return reply(403, rpcError(-32001, `this call has no ${server} tools`));
    if (!remoteToolLimit.allow(String(lease.id))) return reply(429, rpcError(-32000, "too many requests; wait a minute"), { "retry-after": "60" });
    let msg: unknown;
    try {
      msg = await readJson(req, toolBodyLimit(server));
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, rpcError(e.status === 400 ? -32700 : -32600, e.message));
      throw e;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return reply(400, rpcError(-32600, "send one JSON-RPC message as an object; batches are not supported"));
    const w = waitingJson(res);
    const call = (name: unknown, args: unknown): Promise<ToolResult> => callTaskTool(db, lease, bearer!, server, name, args, w.opts);
    const out: McpReply | null = await mcpReply({ name: `autocraft-${server}`, title: `AutoCraft ${server}`, tools, call }, msg as McpMsg);
    if (!out) return reply(202, null);
    return w.send(out);
  }

  /** Streams the tar archive of one tarball mount of the lease's bundle. */
  async function sendArchive(res: ServerResponse, lease: TaskLease, secret: string, repo: string, sha: string): Promise<void> {
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    let tar: Awaited<ReturnType<typeof archiveOf>>;
    try {
      tar = await archiveOf(lease, repo, sha, { secret, signal: ac.signal });
    } catch (e) {
      if (!(e instanceof LeaseGone)) throw e;
      res.writeHead(410, secure({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8" }, "default-src 'none'"));
      return void res.end(JSON.stringify({ error: "the lease is gone (expired, withdrawn or already submitted)" }));
    }
    if (!tar) {
      res.writeHead(404, secure({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8" }, "default-src 'none'"));
      return void res.end(JSON.stringify({ error: "the call has no such tarball" }));
    }
    res.writeHead(200, secure({ "cache-control": "no-store", "content-type": "application/x-tar" }, "default-src 'none'"));
    // The stream ends normally only when the archive is complete: a failed archive cuts the response, so the helper sees an error rather than a short tree.
    tar.on("error", () => res.destroy());
    res.on("close", () => tar.destroy());
    tar.pipe(res);
  }

  /** The version in the helper script this server serves (read again when the file changes), or null. */
  let helperVersionCache: { mtimeMs: number; version: string | null } | null = null;
  async function servedHelperVersion(): Promise<string | null> {
    const { mtimeMs } = await stat(HELPER_FILE);
    if (helperVersionCache?.mtimeMs !== mtimeMs) helperVersionCache = { mtimeMs, version: /export const HELPER_VERSION = "([^"]+)"/.exec(await readFile(HELPER_FILE, "utf8"))?.[1] ?? null };
    return helperVersionCache.version;
  }

  /** GET or HEAD of the helper script. */
  async function sendHelper(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, secure({ allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "default-src 'none'"));
      return void res.end("method not allowed");
    }
    const body = await readFile(HELPER_FILE);
    res.writeHead(200, secure({ "content-type": "text/javascript; charset=utf-8", "content-length": String(body.length), "cache-control": "no-cache" }, "default-src 'none'"));
    res.end(req.method === "HEAD" ? undefined : body);
  }

  async function sendImage(req: IncomingMessage, res: ServerResponse, url: URL, session: Session): Promise<void> {
    if (req.method !== "GET") {
      res.writeHead(405, secure({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "default-src 'none'"));
      return void res.end("method not allowed");
    }
    const ip = clientIp(req);
    // An image is served only when one of the repos whose text contains it is visible to this user.
    const raw = url.searchParams.get("u") ?? "";
    const href = allowedImage(raw)?.href;
    const owners = href ? await imageIndex.reposOf(href) : [];
    if (owners.length) {
      const visible = new Set(await visibleTo(db, makeUser(db, box, provider, session, false, await githubIdentity(db) === "app")));
      if (!owners.some((o) => visible.has(o))) {
        res.writeHead(404, secure({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "default-src 'none'"));
        return void res.end("not an image of a tracked repo");
      }
    }
    const r = await images.get(raw, () => imageLimit.allow(session.idHash) && imageLimitIp.allow(ip));
    if (r.status !== 200) {
      const retry: Record<string, string> = r.status === 429 ? { "retry-after": "10" } : {};
      res.writeHead(r.status, secure({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...retry }, "default-src 'none'"));
      return void res.end(r.error ?? "");
    }
    return sendFile(res, r.type!, "private, max-age=86400", "default-src 'none'", r.data!);
  }

  function sendFile(res: ServerResponse, type: string, cache: string, csp: string, data: Buffer): void {
    res.writeHead(200, secure({ "content-type": type, "cache-control": cache }, csp));
    res.end(data);
  }

  async function readDist(rel: string[]): Promise<Buffer | null> {
    const full = resolve(config.webDist, ...rel);
    const r = relative(config.webDist, full);
    if (!r || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) return null;
    try {
      const real = await realpath(full);
      const root = await realpath(config.webDist);
      const rr = relative(root, real);
      if (!rr || rr === ".." || rr.startsWith(`..${sep}`) || isAbsolute(rr)) return null;
      return await readFile(real);
    } catch {
      return null;    // missing, or a directory
    }
  }

  // The frontend's build output: hashed files under /assets/ are cached for a
  // year; any other path gets index.html, never cached, so a new build is
  // picked up on the next load.
  async function sendWeb(res: ServerResponse, nonce: string, pathname: string): Promise<void> {
    const notFound = () => send(res, nonce, errorPage(nonce, 404, "Not found", "No such file."));
    const rel: string[] = [];
    for (const raw of pathname.split("/")) {
      let seg: string;
      try {
        seg = decodeURIComponent(raw);
      } catch {
        return notFound();
      }
      if (seg === "") continue;
      if (seg === "." || seg === ".." || /[\\/\0]/.test(seg)) return notFound();
      rel.push(seg);
    }
    const ext = rel.length ? /\.([a-z0-9]+)$/.exec(rel[rel.length - 1]!)?.[1] : undefined;
    if (rel[0] === "assets") {
      const data = ext && FILE_TYPES[ext] ? await readDist(rel) : null;
      if (!data) return notFound();
      return sendFile(res, FILE_TYPES[ext!]!, "private, max-age=31536000, immutable", "default-src 'none'", data);
    }
    if (rel.length === 1 && ext && FILE_TYPES[ext]) {
      const data = await readDist(rel);
      if (data) return sendFile(res, FILE_TYPES[ext]!, "private, max-age=3600", "default-src 'none'", data);
    }
    const index = await readDist(["index.html"]);
    if (!index) {
      return send(res, nonce, {
        status: 503,
        html: plainPage(nonce, "Frontend not built", `<p>The dashboard's frontend is not built: there is no <code>index.html</code> in the directory <code>AUTOCRAFT_WEB_DIST</code> names (default <code>web/dist</code> in the repo).</p>
<p>Build it with <code>pnpm -C web install</code> and <code>pnpm -C web build</code>, then reload.</p>`),
      });
    }
    return sendFile(res, "text/html; charset=utf-8", "no-store", APP_CSP, index);
  }

  // Shutting down answers the held claims at once, each with its own short retry, and holds no new ones.
  return { handle, routes: opts.routes, provider, live, close: () => { clearInterval(maintenance); claimWaits.close(); live.close(); } };
}

export async function startServer(opts: AppOptions): Promise<{ server: Server; url: string; app: Awaited<ReturnType<typeof createApp>>; close(): Promise<void> }> {
  const feedbackLimiter = opts.feedbackLimiter ?? new RateLimiter(share(60), 3600_000);
  const app = await createApp({ ...opts, feedbackLimiter, routes: opts.routes ?? (await defaultRoutes(feedbackLimiter, opts.githubUserId)) });
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => void app.handle(req, res));
  // Job processes expire user-local leases only while this process stamps that it serves (src/remote/liveness.ts). The
  // stamp uses the helper routes' short busy timeout: a busy database skips a tick rather than stalling the event loop.
  if (TIME_SCALE !== 1) console.log(`WARNING: AUTOCRAFT_REMOTE_TIME_SCALE=${TIME_SCALE}: user-local time windows are shortened (test only)`);
  const stopLiveness = await startLiveness(opts.remoteDb ?? opts.db);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.config.port, opts.config.host, resolve);
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    server, app,
    url: `http://${host}:${addr.port}`,
    // The held claims' replies are written first; connections still open after a short flush wait (SSE streams) are cut.
    close: () => new Promise<void>((resolve) => {
      stopLiveness();
      app.close();
      // A keep-alive connection turns idle only once its reply is out, after close() looked at it.
      const idle = setInterval(() => server.closeIdleConnections(), 25);
      const cut = setTimeout(() => server.closeAllConnections(), 500);
      server.close(() => { clearInterval(idle); clearTimeout(cut); resolve(); });
    }),
  };
}
