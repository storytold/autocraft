// Crate and git mirror for build pods without public egress. Clients keep the public URLs
// (index.crates.io, static.crates.io, github.com) and reach this server through host aliases and a
// private CA, so cargo's registry and git checkout paths stay the same as with direct access.
// See docs/operations.md, "Crate mirror".
import { readFileSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createSecureServer, type Http2SecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createSecureContext, type SecureContext, type TLSSocket } from "node:tls";
import { envVar } from "../env.ts";
import { startHealthServer } from "../health.ts";
import { CrateStore, IndexCache, downloadTarget, indexName } from "./crates.ts";
import { GitMirrors, MAX_GIT_REQUEST_BYTES, gitRoute, readAllowlist } from "./git.ts";
import { Slots, jsonLog, type Log } from "./store.ts";

export const MIRROR_HOSTS = ["index.crates.io", "static.crates.io", "github.com", "api.github.com"] as const;
const GiB = 1024 ** 3;
const CERT_RELOAD_MS = 5 * 60_000;
// Limits for clients. Build pods open a handful of connections each; these bound what a broken or hostile one can hold.
const MAX_CONNECTIONS = 1024;
const MAX_STREAMS = 100;
const IDLE_MS = 120_000;
const BODY_MS = 30_000;
const GIT_SLOTS = 8;
// Requests past the slots wait in line: cargo's sparse index fetch sends hundreds at once.
const QUEUE = 2_000;
const QUEUE_WAIT_MS = 60_000;

export type MirrorConfig = {
  /** host:port of the TLS listener. */
  listen: string;
  /** host:port of the plain-HTTP probe listener; omitted = none. */
  healthListen?: string;
  dataDir: string;
  /** Holds `<host>.crt` and `<host>.key` for every host in MIRROR_HOSTS. */
  tlsDir: string;
  gitAllowlistFile?: string;
  /** The list AutoCraft derives from the tracked repos' Cargo.lock files (src/build/mirror-sources.ts); a missing file is an empty list. */
  gitDerivedFile?: string;
  gitRepos?: string;
  crateCapBytes: number;
  indexCapBytes: number;
  /** Upstream requests (index refreshes and crate downloads) at once; default 64. */
  upstreamSlots?: number;
};

/** Upstream bases and timings; the defaults are the public services. Tests point them at fakes. */
export type MirrorDeps = {
  log?: Log;
  fetch?: typeof fetch;
  indexUpstream?: string;
  staticUpstream?: string;
  gitUpstream?: string;
  indexTtlMs?: number;
  indexMaxBytes?: number;
  crateMaxBytes?: number;
  minFreeBytes?: number;
  now?: () => number;
};

type Req = (IncomingMessage | Http2ServerRequest) & AsyncIterable<Buffer>;
// HTTP/1.1 requests arrive as http.ServerResponse; both share the writeHead/end/pipe surface used here.
type Res = Http2ServerResponse;

function loadContexts(dir: string): { contexts: Map<string, SecureContext>; stamp: string } {
  const contexts = new Map<string, SecureContext>();
  const stamps: number[] = [];
  for (const host of MIRROR_HOSTS) {
    const cert = join(dir, `${host}.crt`);
    const key = join(dir, `${host}.key`);
    stamps.push(statSync(cert).mtimeMs, statSync(key).mtimeMs);
    contexts.set(host, createSecureContext({ cert: readFileSync(cert), key: readFileSync(key), minVersion: "TLSv1.2" }));
  }
  return { contexts, stamp: stamps.join(",") };
}

function stampOf(dir: string): string {
  return MIRROR_HOSTS.flatMap((h) => [statSync(join(dir, `${h}.crt`)).mtimeMs, statSync(join(dir, `${h}.key`)).mtimeMs]).join(",");
}

function tlsName(req: Req): string | undefined {
  const sock = "stream" in req ? req.stream.session?.socket : req.socket;
  const name = (sock as TLSSocket | undefined)?.servername;
  return typeof name === "string" ? name.toLowerCase() : undefined;
}

function hostHeader(headers: IncomingHttpHeaders): string | undefined {
  const h = headers[":authority"] ?? headers.host;
  return typeof h === "string" ? h.replace(/:\d+$/, "").toLowerCase() : undefined;
}

const SECURITY_HEADERS = { "x-content-type-options": "nosniff" };

function send(res: Res, method: string, status: number, body: Buffer | string = "", headers: Record<string, string | number> = {}): void {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  const h: Record<string, string | number> = { ...SECURITY_HEADERS, "content-length": buf.length, ...headers };
  if (!("content-type" in headers) && buf.length) h["content-type"] = "text/plain; charset=utf-8";
  res.writeHead(status, h);
  if (method === "HEAD") res.end();
  else res.end(buf);
}

/** The request body, 413 past `max` bytes, 408 when it has not arrived within BODY_MS. */
async function readBody(req: Req, max: number): Promise<Buffer | 408 | 413> {
  const chunks: Buffer[] = [];
  let n = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    req.destroy();
  }, BODY_MS);
  try {
    for await (const c of req) {
      n += c.length;
      if (n > max) return 413;
      chunks.push(c);
    }
  } catch (e) {
    if (timedOut) return 408;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return timedOut ? 408 : Buffer.concat(chunks, n);
}

function failed(res: Res, method: string, status: number): void {
  const text: Record<number, string> = { 404: "not found\n", 502: "upstream unavailable\n", 503: "busy\n" };
  send(res, method, status, text[status] ?? "", status === 503 ? { "retry-after": 5 } : {});
}

export type Mirror = { port: number; healthUrl?: string; git: GitMirrors; close: () => Promise<void> };

/** Starts the TLS listener (and the probe listener when configured). */
export async function startMirror(cfg: MirrorConfig, deps: MirrorDeps = {}): Promise<Mirror> {
  const log = deps.log ?? jsonLog;
  let tls = loadContexts(cfg.tlsDir);
  const reload = setInterval(() => {
    try {
      if (stampOf(cfg.tlsDir) !== tls.stamp) {
        tls = loadContexts(cfg.tlsDir);
        log("tls-reloaded", {});
      }
    } catch (e) {
      log("tls-reload-error", { error: (e as Error).message });
    }
  }, CERT_RELOAD_MS);
  reload.unref();

  const queue = { queue: QUEUE, waitMs: QUEUE_WAIT_MS };
  const slots = new Slots(cfg.upstreamSlots ?? 64, queue);
  const index = new IndexCache({ dir: join(cfg.dataDir, "index"), capBytes: cfg.indexCapBytes, upstream: deps.indexUpstream, ttlMs: deps.indexTtlMs, maxBytes: deps.indexMaxBytes, fetch: deps.fetch, log, now: deps.now, slots });
  const crates = new CrateStore({ dir: join(cfg.dataDir, "crates"), capBytes: cfg.crateCapBytes, indexUpstream: deps.indexUpstream, staticUpstream: deps.staticUpstream, maxBytes: deps.crateMaxBytes, minFreeBytes: deps.minFreeBytes, fetch: deps.fetch, log, slots });
  const git = new GitMirrors({ dir: join(cfg.dataDir, "git"), upstream: deps.gitUpstream, allowlist: () => readAllowlist(cfg.gitAllowlistFile, cfg.gitRepos, log, cfg.gitDerivedFile), slots: new Slots(GIT_SLOTS, queue), log });

  async function handle(req: Req, res: Res): Promise<void> {
    const started = Date.now();
    const method = req.method ?? "";
    const url = new URL(req.url ?? "/", "https://mirror.invalid");
    const host = tlsName(req);
    const path = url.pathname;
    const done = (status: number, fields: Record<string, unknown> = {}): void => log("request", { host, method, path, status, ms: Date.now() - started, ...fields });
    if (!host || hostHeader(req.headers) !== host) {
      send(res, method, 421, "misdirected request\n");
      return done(421);
    }
    if ((req.url ?? "").length > 2048) {
      send(res, method, 414);
      return done(414);
    }
    const isUploadPack = host === "github.com" && method === "POST";
    if (method !== "GET" && method !== "HEAD" && !isUploadPack) {
      send(res, method, 405, "", { allow: "GET, HEAD" });
      return done(405);
    }

    if (host === "index.crates.io") {
      const name = indexName(path);
      if (!name) {
        send(res, method, 404, "not found\n");
        return done(404);
      }
      const a = await index.get(path);
      if (a.status !== 200) {
        failed(res, method, a.status);
        return done(a.status, a.status === 404 && a.source ? { cache: a.source } : {});
      }
      const headers = { etag: a.etag, "cache-control": "max-age=0", "content-type": name === "config.json" ? "application/json" : "text/plain; charset=utf-8" };
      if (req.headers["if-none-match"] === a.etag) {
        res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
        res.end();
        return done(304, { cache: a.source });
      }
      send(res, method, 200, a.body, headers);
      return done(200, { cache: a.source, bytes: a.body.length });
    }

    if (host === "static.crates.io") {
      const t = downloadTarget(path);
      if (!t) {
        send(res, method, 404, "not found\n");
        return done(404);
      }
      // The file is opened before the answer starts, so an eviction in between costs a refetch, not a broken response.
      let a = await crates.get(t.name, t.version);
      let fh: FileHandle | undefined;
      for (let i = 0; i < 2 && a.status === 200 && !fh; i++) {
        try {
          fh = await open(a.path, "r");
        } catch {
          crates.forget(t.name, t.version);
          a = await crates.get(t.name, t.version);
        }
      }
      if (a.status !== 200 || !fh) {
        const status = a.status === 200 ? 503 : a.status;
        failed(res, method, status);
        return done(status);
      }
      const size = (await fh.stat()).size;
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/gzip", "content-length": size, "cache-control": "public, max-age=31536000, immutable" });
      if (method === "HEAD") {
        await fh.close();
        res.end();
      } else await pipeline(fh.createReadStream(), res);
      return done(200, { cache: a.source, bytes: size });
    }

    if (host === "github.com") {
      const route = gitRoute(path);
      const want = route?.endpoint === "info/refs" ? method !== "POST" : method === "POST";
      if (!route || !want) {
        send(res, method, 404, "not found\n");
        return done(404);
      }
      const protocol = GitMirrors.protocol(req.headers["git-protocol"]);
      let a;
      if (route.endpoint === "info/refs") a = await git.advertise(route.repo, url.searchParams, protocol);
      else {
        const enc = req.headers["content-encoding"];
        a = await git.uploadPack(route.repo, req.headers["content-type"], typeof enc === "string" ? enc : undefined, () => readBody(req, MAX_GIT_REQUEST_BYTES), protocol);
      }
      if (a.status !== 200) {
        failed(res, method, a.status);
        return done(a.status);
      }
      const headers = { ...SECURITY_HEADERS, "content-type": a.contentType, "cache-control": "no-cache" };
      if ("body" in a) {
        send(res, method, 200, a.body, headers);
        return done(200, { bytes: a.body.length });
      }
      res.writeHead(200, headers);
      try {
        await pipeline(a.stream, res);
      } catch (e) {
        a.kill();
        throw e;
      }
      await a.done;
      return done(200);
    }

    // api.github.com: cargo asks it whether a git dependency changed; a 404 makes it fetch instead.
    send(res, method, 404, "not found\n");
    return done(404);
  }

  const server: Http2SecureServer = createSecureServer({
    allowHTTP1: true,
    minVersion: "TLSv1.2",
    handshakeTimeout: 10_000,
    settings: { maxConcurrentStreams: MAX_STREAMS },
    // No default certificate: a client that sends no known server name fails the handshake.
    SNICallback: (name, cb) => {
      const ctx = tls.contexts.get(name.toLowerCase());
      if (ctx) cb(null, ctx);
      else cb(new Error("unknown server name"));
    },
  }, (req, res) => {
    void handle(req as Req, res).catch((e: unknown) => {
      log("error", { path: (req.url ?? "").split("?")[0], error: (e as Error).message });
      if (!res.headersSent) send(res, req.method ?? "", 500);
      else res.destroy?.();
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  // HTTP/1.1 clients (allowHTTP1): time to send the headers and the whole request.
  // Node's HTTP/1.1 fallback reads these from the server; @types/node lists them only on http.Server.
  Object.assign(server, { headersTimeout: 10_000, requestTimeout: 60_000, connectionsCheckingInterval: 5_000 });
  // Idle HTTP/2 sessions and HTTP/1.1 sockets are closed.
  server.setTimeout(IDLE_MS);
  server.on("timeout", (s?: { destroy?: () => void }) => s?.destroy?.());
  const sockets = new Set<TLSSocket>();
  server.on("secureConnection", (sock: TLSSocket) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
  });
  server.on("tlsClientError", () => undefined);
  server.on("sessionError", () => undefined);

  const listen = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(cfg.listen);
  if (!listen) throw new Error(`listen address must be host:port, got ${JSON.stringify(cfg.listen)}`);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(listen[3]), listen[1] ?? listen[2], resolve);
  });
  const port = (server.address() as { port: number }).port;
  git.start();
  const health = cfg.healthListen
    ? await startHealthServer(cfg.healthListen, () => Promise.resolve(server.listening), () => `crates ${crates.count} files ${(crates.bytes / GiB).toFixed(2)} GiB, index ${(index.bytes / GiB).toFixed(2)} GiB, git ${git.repos} repos`)
    : undefined;
  log("listening", { port, git: git.repos });
  return {
    port,
    healthUrl: health?.url,
    git,
    close: async () => {
      clearInterval(reload);
      await health?.close();
      const closed = new Promise<void>((r) => server.close(() => r()));
      for (const sock of sockets) sock.destroy();
      await closed;
      await git.stop();
    },
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function gib(v: string | undefined, def: number, what: string): number {
  const n = v === undefined ? def : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what} must be a positive number of GiB`);
  return n * GiB;
}

function count(v: string | undefined, def: number, what: string): number {
  const n = v === undefined ? def : Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a positive whole number`);
  return n;
}

/** Config from flags, then AUTOCRAFT_MIRROR_* variables, then defaults. */
export function mirrorConfig(args: string[], env: NodeJS.ProcessEnv = process.env): MirrorConfig {
  const v = (f: string, e: string): string | undefined => flag(args, f) ?? envVar(e, env);
  return {
    listen: v("--listen", "MIRROR_LISTEN") ?? "0.0.0.0:8443",
    healthListen: v("--health-listen", "MIRROR_HEALTH_LISTEN") ?? "0.0.0.0:8080",
    dataDir: v("--data-dir", "MIRROR_DIR") ?? "/data",
    tlsDir: v("--tls-dir", "MIRROR_TLS_DIR") ?? "/tls",
    gitAllowlistFile: v("--git-allowlist", "MIRROR_GIT_ALLOWLIST"),
    gitDerivedFile: v("--git-derived", "MIRROR_GIT_DERIVED"),
    gitRepos: v("--git-repos", "MIRROR_GIT_REPOS"),
    crateCapBytes: gib(v("--crate-cap-gb", "MIRROR_CRATE_CAP_GB"), 50, "crate cap"),
    indexCapBytes: gib(v("--index-cap-gb", "MIRROR_INDEX_CAP_GB"), 2, "index cap"),
    upstreamSlots: count(v("--upstream-slots", "MIRROR_UPSTREAM_SLOTS"), 64, "upstream slots"),
  };
}

export const commands = {
  "crate-mirror": {
    summary: "serve the crates.io and GitHub git mirror for build pods (crate-mirror serve)",
    async run(args: string[]): Promise<void> {
      if (args[0] !== "serve") {
        console.error("usage: autocraft-server crate-mirror serve [--listen host:port] [--health-listen host:port] [--data-dir DIR] [--tls-dir DIR] [--git-allowlist FILE] [--git-derived FILE] [--git-repos LIST] [--crate-cap-gb N] [--index-cap-gb N] [--upstream-slots N]");
        process.exit(1);
      }
      const m = await startMirror(mirrorConfig(args.slice(1)));
      const stop = (): void => void m.close().then(() => process.exit(0));
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    },
  },
};
