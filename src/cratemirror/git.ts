// Read-only git smart HTTP for an allowlist of GitHub repositories, served from bare mirrors.
// Clients may only run upload-pack (fetch/clone); every other path is 404.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Log, Slots } from "./store.ts";

export const GITHUB = "https://github.com";
const SEG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_ADVERTISE_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10 * 60_000;
// upload-pack sends keepalives every 5 s while it computes a pack, so silence this long means the client stopped reading.
const STALL_MS = 60_000;
// How long an info/refs request waits for a fetch when a mirror already exists; after that it serves the mirror as it is.
const FETCH_WAIT_MS = 15_000;

/** "owner/repo" in lower case, from a list entry ("storytold/craft-libs", "https://github.com/storytold/craft-libs.git"), or undefined. */
export function normalizeRepo(entry: string): string | undefined {
  const s = entry.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/i, "");
  const [owner, repo, ...rest] = s.split("/");
  if (rest.length || !owner || !repo || !SEG.test(owner) || !SEG.test(repo) || repo.includes("..")) return undefined;
  return `${owner}/${repo}`.toLowerCase();
}

/**
 * Repos from a list file (one per line, `#` comments), the derived list file AutoCraft writes in the same form
 * (src/build/mirror-sources.ts) and an inline list (comma or whitespace separated); undefined when a file cannot be read.
 * A derived file that does not exist counts as empty: its ConfigMap is optional.
 */
export function readAllowlist(file: string | undefined, inline: string | undefined, log: Log, derived?: string): Set<string> | undefined {
  const out = new Set<string>();
  const add = (text: string, from: string): void => {
    for (const raw of text.split(/[\s,]+/)) {
      if (!raw) continue;
      const r = normalizeRepo(raw);
      if (r) out.add(r);
      else log("git-allowlist-skip", { from, entry: raw.slice(0, 120) });
    }
  };
  if (inline) add(inline, "env");
  for (const [path, from] of [[file, "file"], [derived, "derived"]] as const) {
    if (!path) continue;
    try {
      add(readFileSync(path, "utf8").split("\n").map((l) => l.replace(/#.*/, "")).join("\n"), from);
    } catch (e) {
      if (from === "derived" && (e as NodeJS.ErrnoException).code === "ENOENT") continue;
      log("git-allowlist-error", { from, error: (e as Error).message });
      return undefined;
    }
  }
  return out;
}

/** A git smart-HTTP route: repo ("owner/repo", lower case) and which endpoint. */
export function gitRoute(path: string): { repo: string; endpoint: "info/refs" | "git-upload-pack" } | undefined {
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack)$/.exec(path);
  if (!m) return undefined;
  const repo = normalizeRepo(`${m[1]}/${m[2]}`);
  return repo ? { repo, endpoint: m[3] as "info/refs" | "git-upload-pack" } : undefined;
}

type RunResult = { code: number | null; stdout: Buffer; stderr: string };

export type GitOpts = {
  dir: string;
  /** Undefined when the list cannot be read: the previous one stays in force. */
  allowlist: () => Set<string> | undefined;
  /** Bounds git processes serving clients at once. */
  slots: Slots;
  log: Log;
  upstream?: string;
  fetchEveryMs?: number;
  freshMs?: number;
  gcEveryMs?: number;
  maxResponseBytes?: number;
};

export type GitAnswer =
  | { status: 200; contentType: string; body: Buffer }
  | { status: 200; contentType: string; stream: NodeJS.ReadableStream; done: Promise<void>; kill: () => void }
  | { status: 400 | 404 | 408 | 413 | 415 | 502 | 503 };

export class GitMirrors {
  #dir: string;
  #allowlist: () => Set<string> | undefined;
  #slots: Slots;
  #allowed = new Set<string>();
  #log: Log;
  #upstream: string;
  #fetchEvery: number;
  #fresh: number;
  #gcEvery: number;
  #maxResponse: number;
  #lastFetch = new Map<string, number>();
  #inflight = new Map<string, Promise<void>>();
  #timer: NodeJS.Timeout | undefined;
  #syncing: Promise<void> | undefined;

  constructor(o: GitOpts) {
    this.#dir = o.dir;
    this.#allowlist = o.allowlist;
    this.#slots = o.slots;
    this.#log = o.log;
    this.#upstream = o.upstream ?? GITHUB;
    this.#fetchEvery = o.fetchEveryMs ?? 2 * 60_000;
    this.#fresh = o.freshMs ?? 30_000;
    this.#gcEvery = o.gcEveryMs ?? 7 * 24 * 3600_000;
    this.#maxResponse = o.maxResponseBytes ?? 4 * 1024 ** 3;
    mkdirSync(this.#dir, { recursive: true });
    this.#allowed = this.#allowlist() ?? new Set();
  }

  get repos(): number { return this.#allowed.size; }

  /** Syncs now, then every `fetchEveryMs`. */
  start(): void {
    void this.sync();
    this.#timer = setInterval(() => void this.sync(), this.#fetchEvery);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await this.#syncing;
    await Promise.allSettled([...this.#inflight.values()]);
  }

  /** Rereads the allowlist, fetches every listed repo, gc's those due and deletes mirrors no longer listed. */
  sync(): Promise<void> {
    this.#syncing ??= (async () => {
      const next = this.#allowlist();
      if (next) this.#allowed = next;
      for (const repo of this.#allowed) {
        try {
          await this.#ensure(repo, 0);
          await this.#gcIfDue(repo);
        } catch { /* logged by #ensure */ }
      }
      // Without a readable list nothing is known to be removed.
      if (!next) return;
      for (const owner of readdirSync(this.#dir, { withFileTypes: true })) {
        if (!owner.isDirectory()) continue;
        for (const name of readdirSync(join(this.#dir, owner.name))) {
          const repo = `${owner.name}/${name.replace(/\.git(\.tmp)?$/, "")}`;
          if (this.#inflight.has(repo)) continue;
          if (!this.#allowed.has(repo) || name.endsWith(".tmp")) {
            rmSync(join(this.#dir, owner.name, name), { recursive: true, force: true });
            this.#lastFetch.delete(repo);
            this.#log("git-removed", { repo });
          }
        }
      }
    })().finally(() => { this.#syncing = undefined; });
    return this.#syncing;
  }

  #path(repo: string): string { return join(this.#dir, `${repo}.git`); }

  #run(args: string[], o: { input?: Buffer; protocol?: string; maxOut?: number } = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: this.#dir, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
      for (const k of ["SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[k]) env[k] = process.env[k];
      if (o.protocol) env.GIT_PROTOCOL = o.protocol;
      const child = spawn("git", args, { env, stdio: ["pipe", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = "";
      child.stdout.on("data", (c: Buffer) => {
        outBytes += c.length;
        if (outBytes > (o.maxOut ?? MAX_ADVERTISE_BYTES)) child.kill();
        else out.push(c);
      });
      child.stderr.on("data", (c: Buffer) => { if (err.length < 4000) err += c.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err.trim() }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(o.input);
    });
  }

  async #git(args: string[]): Promise<Buffer> {
    const r = await this.#run(args);
    if (r.code !== 0) throw new Error(`git ${args[0] === "-C" ? args[2] : args[0]} exited ${r.code}: ${r.stderr.split("\n").pop() ?? ""}`);
    return r.stdout;
  }

  /** Fetches `repo` unless the last fetch is younger than `maxAgeMs`; creates the mirror first if needed. Throws only when no mirror exists afterwards. */
  #ensure(repo: string, maxAgeMs: number): Promise<void> {
    const last = this.#lastFetch.get(repo);
    if (last !== undefined && Date.now() - last < maxAgeMs) return Promise.resolve();
    let p = this.#inflight.get(repo);
    if (!p) {
      p = this.#fetch(repo).finally(() => this.#inflight.delete(repo));
      this.#inflight.set(repo, p);
    }
    return p;
  }

  async #fetch(repo: string): Promise<void> {
    const dest = this.#path(repo);
    const fresh = !existsSync(dest);
    const dir = fresh ? `${dest}.tmp` : dest;
    const started = Date.now();
    try {
      if (fresh) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        await this.#git(["init", "--quiet", "--bare", dir]);
        await this.#git(["-C", dir, "config", "remote.origin.url", `${this.#upstream}/${repo}.git`]);
        await this.#git(["-C", dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
        await this.#git(["-C", dir, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
      }
      await this.#git(["-C", dir, "fetch", "--quiet", "--prune", "origin"]);
      const head = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\tHEAD$/m.exec((await this.#git(["-C", dir, "ls-remote", "--symref", "origin", "HEAD"])).toString());
      if (head) await this.#git(["-C", dir, "symbolic-ref", "HEAD", head[1]!]);
      if (fresh) renameSync(dir, dest);
      this.#lastFetch.set(repo, Date.now());
      this.#log("git-fetch", { repo, ms: Date.now() - started, created: fresh || undefined });
    } catch (e) {
      // The attempt counts as the last fetch, so requests in the next `freshMs` serve the mirror without trying again.
      this.#lastFetch.set(repo, Date.now());
      this.#log("upstream-error", { host: "github.com", repo, error: (e as Error).message });
      if (fresh) {
        rmSync(dir, { recursive: true, force: true });
        throw e;
      }
    }
  }

  async #gcIfDue(repo: string): Promise<void> {
    const dir = this.#path(repo);
    const last = Number((await this.#run(["-C", dir, "config", "autocraft.lastgc"])).stdout.toString().trim() || 0);
    if (Date.now() - last * 1000 < this.#gcEvery) return;
    await this.#git(["-C", dir, "gc", "--quiet"]);
    await this.#git(["-C", dir, "config", "autocraft.lastgc", String(Math.floor(Date.now() / 1000))]);
    this.#log("git-gc", { repo });
  }

  /** Allowed and mirrored, fetched first when the last fetch is older than `freshMs`; or why not. */
  async #ready(repo: string, fetchIfOld: boolean): Promise<404 | 502 | undefined> {
    if (!this.#allowed.has(repo)) return 404;
    const fetching = this.#ensure(repo, fetchIfOld ? this.#fresh : Infinity);
    if (existsSync(this.#path(repo))) {
      // A mirror exists: wait a little for fresh refs, then serve it as it is while the fetch goes on.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([fetching.catch(() => undefined), new Promise<void>((r) => { timer = setTimeout(r, FETCH_WAIT_MS); })]);
      clearTimeout(timer);
      return undefined;
    }
    try {
      await fetching;
    } catch {
      return 502;
    }
    return existsSync(this.#path(repo)) ? undefined : 502;
  }

  static protocol(header: string | string[] | undefined): string | undefined {
    const v = Array.isArray(header) ? header[0] : header;
    return v === "version=2" || v === "version=1" ? v : undefined;
  }

  /** GET info/refs?service=git-upload-pack. */
  async advertise(repo: string, query: URLSearchParams, gitProtocol: string | undefined): Promise<GitAnswer> {
    if (query.get("service") !== "git-upload-pack") return { status: 404 };
    const bad = await this.#ready(repo, true);
    if (bad) return { status: bad };
    const release = await this.#slots.take();
    if (!release) return { status: 503 };
    let r: RunResult;
    try {
      r = await this.#run(["-c", "uploadpack.allowReachableSHA1InWant=true", "upload-pack", "--strict", "--stateless-rpc", "--advertise-refs", this.#path(repo)], { protocol: gitProtocol });
    } finally {
      release();
    }
    if (r.code !== 0) {
      this.#log("git-error", { repo, error: r.stderr.split("\n").pop() });
      return { status: 502 };
    }
    // Protocol v2 answers start with the capability list; v0/v1 need the service line first.
    const head = gitProtocol === "version=2" ? Buffer.alloc(0) : Buffer.from("001e# service=git-upload-pack\n0000");
    return { status: 200, contentType: "application/x-git-upload-pack-advertisement", body: Buffer.concat([head, r.stdout]) };
  }

  /**
   * POST git-upload-pack. The repo, content type and encoding are checked before `readBody` reads
   * the client's body (at most MAX_REQUEST_BYTES, else 413; 408 when it arrives too slowly).
   */
  async uploadPack(repo: string, contentType: string | undefined, encoding: string | undefined, readBody: () => Promise<Buffer | 408 | 413>, gitProtocol: string | undefined): Promise<GitAnswer> {
    if (!this.#allowed.has(repo)) return { status: 404 };
    if (contentType !== "application/x-git-upload-pack-request") return { status: 415 };
    if (encoding !== undefined && encoding !== "gzip" && encoding !== "identity") return { status: 415 };
    const raw = await readBody();
    if (typeof raw === "number") return { status: raw };
    let input: Buffer;
    try {
      input = encoding === "gzip" ? gunzipSync(raw, { maxOutputLength: MAX_REQUEST_BYTES }) : raw;
    } catch {
      return { status: encoding === "gzip" ? 413 : 400 };
    }
    const bad = await this.#ready(repo, false);
    if (bad) return { status: bad };
    const release = await this.#slots.take();
    if (!release) return { status: 503 };
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: this.#dir, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;
    const child = spawn("git", ["-c", "uploadpack.allowReachableSHA1InWant=true", "upload-pack", "--strict", "--stateless-rpc", this.#path(repo)], { env, stdio: ["pipe", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
    let err = "";
    let bytes = 0;
    // No output for STALL_MS: the client stopped reading (the pipe is paused) or git hangs. Either way the process goes.
    let stall: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        this.#log("git-error", { repo, error: `no progress for ${STALL_MS / 1000} s` });
        child.kill("SIGKILL");
      }, STALL_MS);
    };
    arm();
    child.stderr.on("data", (c: Buffer) => { if (err.length < 4000) err += c.toString(); });
    child.stdout.on("data", (c: Buffer) => {
      arm();
      bytes += c.length;
      if (bytes > this.#maxResponse) {
        this.#log("git-error", { repo, error: `response larger than ${this.#maxResponse} bytes` });
        child.kill("SIGKILL");
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    const done = new Promise<void>((resolve) => child.on("close", (code) => {
      clearTimeout(stall);
      release();
      if (code !== 0) this.#log("git-error", { repo, error: err.trim().split("\n").pop() ?? `exit ${code}` });
      resolve();
    }));
    child.on("error", (e) => this.#log("git-error", { repo, error: e.message }));
    return { status: 200, contentType: "application/x-git-upload-pack-result", stream: child.stdout, done, kill: () => child.kill("SIGKILL") };
  }
}

export const MAX_GIT_REQUEST_BYTES = MAX_REQUEST_BYTES;
