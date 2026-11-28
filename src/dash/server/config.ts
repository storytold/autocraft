import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileTooOpen } from "../../permcheck.ts";
import { randomToken } from "./crypto.ts";
import { dbTarget } from "../../db/open.ts";
import { defaultImageCacheDir } from "./images.ts";
import { envVar } from "../../env.ts";
import { dashReplicas } from "./util.ts";

// The GitHub App that AutoCraft registered through the manifest flow. The
// private key and client secret leave this object only to sign a JWT or to
// sign a user in; the webhook secret is stored but unused (webhooks are off).
export type AppSecrets = {
  id: string; slug: string; privateKey: string; clientId: string; clientSecret: string; webhookSecret: string | null;
  /** Who owns the app on GitHub (a user or an organization); null when unknown. */
  owner: AppOwner | null;
};
export type AppOwner = { login: string; type: "User" | "Organization" };
export type Secrets = { githubClientId: string; githubClientSecret: string; sessionKey: string; app: AppSecrets | null };

function configuredDb(env: NodeJS.ProcessEnv): string {
  try {
    return dbTarget(env);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}

export type Config = {
  host: string;
  port: number;
  baseUrl: string | null;          // null only with dev auth, where every URL the server builds is relative
  dbTarget: string;                // a SQLite path or a postgres:// URL (dbTarget())
  webDist: string;                 // the frontend's build output (web/dist)
  devAuth: boolean;
  devPermsFile: string | null;
  devTokenTtlMs: number | null;    // fake provider's access-token lifetime
  trustProxy: number;              // proxies in front of the server that append to X-Forwarded-For; 0: use the socket address
  imageCacheDir: string | null;    // the image proxy's disk cache; null: none
  secrets: Secrets;
  secretsFile: string | null;      // the secrets file; its GitHub App keys are imported into the database once (src/github/app-keys.ts)
};

export const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../../web/dist", import.meta.url));

export class ConfigError extends Error {}

// Dev auth signs in as any login typed on a form, so it is for this machine
// only. Its default port differs from the real dashboard's, so a dev server
// never answers on the port a reverse proxy forwards to.
export const DEFAULT_LISTEN = "127.0.0.1:8993";
export const DEV_LISTEN = "127.0.0.1:8994";

export function parseListen(value: string): { host: string; port: number } {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(value);
  if (!m) throw new ConfigError(`AUTOCRAFT_LISTEN must be host:port, got ${JSON.stringify(value)}`);
  const port = Number(m[3]);
  if (port > 65535) throw new ConfigError("AUTOCRAFT_LISTEN: port out of range");
  return { host: m[1] ?? m[2]!, port };
}

export function isLoopback(host: string): boolean {
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  if (isIP(host) === 6) return host === "::1" || /^::ffff:127\./i.test(host);
  return false;
}

/** True when a Host header names this machine (with or without a port). */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\[\]]+))(?::\d{1,5})?$/.exec(hostHeader.trim());
  return !!m && isLoopback(m[1] ?? m[2]!);
}

/** Refuses a secrets file that is missing or open to anyone but its owner: the POSIX mode bits, or on Windows the file's ACL (src/permcheck.ts). Every reader of the file checks it first. */
export function checkSecretsFileMode(path: string): void {
  const why = fileTooOpen(path);
  if (why === "not found") throw new ConfigError("secrets file not found");
  if (why) throw new ConfigError(`secrets file ${why}`);
}

export function readSecrets(path: string | undefined): Secrets {
  if (!path) throw new ConfigError("AUTOCRAFT_SECRETS_FILE is not set");
  checkSecretsFileMode(path);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError("secrets file is not valid JSON");
  }
  const get = (k: string, min = 1): string => {
    const v = raw?.[k];
    if (typeof v !== "string" || v.length < min) throw new ConfigError(`secrets file: ${k} is missing or too short`);
    return v;
  };
  return {
    githubClientId: get("github_client_id"),
    githubClientSecret: get("github_client_secret"),
    sessionKey: get("session_key", 32),
    app: appSecretsOf(raw),
  };
}

/** The app's keys from a parsed secrets file; null unless all required ones are present. */
export function appSecretsOf(raw: Record<string, unknown>): AppSecrets | null {
  const opt = (k: string): string | null => (typeof raw?.[k] === "string" && (raw[k] as string).length > 0 ? (raw[k] as string) : null);
  const id = opt("github_app_id"), slug = opt("github_app_slug"), privateKey = opt("github_app_private_key");
  const clientId = opt("github_app_client_id"), clientSecret = opt("github_app_client_secret");
  if (!id || !slug || !privateKey || !clientId || !clientSecret) return null;
  const o = raw.github_app_owner as { login?: unknown; type?: unknown } | undefined;
  const owner: AppOwner | null = typeof o?.login === "string" && o.login && (o.type === "User" || o.type === "Organization") ? { login: o.login, type: o.type } : null;
  return { id, slug, privateKey, clientId, clientSecret, webhookSecret: opt("github_app_webhook_secret"), owner };
}

let devSessionKey: string | undefined;

/** The session_key of a dev secrets file, when it has one long enough. */
function devFileKey(file: string | undefined): string | null {
  if (!file) return null;
  try {
    const k = (JSON.parse(readFileSync(file, "utf8")) as { session_key?: unknown }).session_key;
    return typeof k === "string" && k.length >= 32 ? k : null;
  } catch {
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { host, port } = parseListen(envVar("LISTEN", env) ?? (envVar("DEV_AUTH", env) === "1" ? DEV_LISTEN : DEFAULT_LISTEN));
  const devAuth = envVar("DEV_AUTH", env) === "1";
  let secrets: Secrets;
  let baseUrl: string | null = null;
  if (devAuth) {
    if (!isLoopback(host)) throw new ConfigError("AUTOCRAFT_DEV_AUTH=1 is allowed only on a loopback listen address");
    // Dev sessions don't survive a restart: the key lives only in this process.
    // A dev secrets file's session_key keeps what is sealed with it (the GitHub App's keys) readable after a restart.
    secrets = { githubClientId: "dev", githubClientSecret: "dev", sessionKey: devFileKey(envVar("SECRETS_FILE", env)) ?? (devSessionKey ??= randomToken()), app: null };
  } else {
    secrets = readSecrets(envVar("SECRETS_FILE", env));
  }
  const secretsFile = envVar("SECRETS_FILE", env) ?? null;
  // A dev server reads the app's keys from a secrets file when one is given, so registration can be tried locally.
  if (devAuth && secretsFile) {
    let loose = false;
    try { loose = (statSync(secretsFile).mode & 0o077) !== 0; } catch { /* no file */ }
    if (loose) throw new ConfigError("secrets file is readable or writable by group or others; chmod 600 it");
  }
  const rawBaseUrl = envVar("BASE_URL", env);
  if (rawBaseUrl) {
    let u: URL;
    try {
      u = new URL(rawBaseUrl);
    } catch {
      throw new ConfigError("AUTOCRAFT_BASE_URL is not a URL");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError("AUTOCRAFT_BASE_URL must be http(s)");
    if (devAuth && (u.protocol !== "http:" || (u.hostname !== "localhost" && u.hostname !== "127.0.0.1"))) {
      throw new ConfigError("AUTOCRAFT_DEV_AUTH=1 allows AUTOCRAFT_BASE_URL only as an http://localhost or http://127.0.0.1 URL");
    }
    baseUrl = u.origin + u.pathname.replace(/\/+$/, "");
    if (baseUrl !== u.origin) throw new ConfigError("AUTOCRAFT_BASE_URL must not have a path");
  } else if (!devAuth) {
    throw new ConfigError("AUTOCRAFT_BASE_URL is not set");
  }
  try { dashReplicas(env); } catch (e) { throw new ConfigError((e as Error).message); }
  const webDistEnv = envVar("WEB_DIST", env);
  const trustRaw = envVar("TRUST_PROXY", env) || "0";
  if (!/^[0-9]$/.test(trustRaw)) throw new ConfigError("AUTOCRAFT_TRUST_PROXY must be the number of trusted proxies in front of the server, 0 to 9");
  return {
    host, port, baseUrl, devAuth, secrets, secretsFile,
    dbTarget: configuredDb(env),
    webDist: webDistEnv ? resolve(webDistEnv) : DEFAULT_WEB_DIST,
    devPermsFile: devAuth ? (envVar("DEV_PERMS", env) ?? null) : null,
    devTokenTtlMs: devAuth && envVar("DEV_TOKEN_TTL", env) ? Number(envVar("DEV_TOKEN_TTL", env)) * 1000 || null : null,
    trustProxy: Number(trustRaw),
    imageCacheDir: envVar("IMG_CACHE", env) === "" ? null : defaultImageCacheDir(env),
  };
}
