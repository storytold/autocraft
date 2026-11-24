// Whether Jev can be used right now. When it cannot, Haiku does Jev's work (classify, priority, duplicates).
//
// - Switched off (settings.jev_enabled = 'no'): stays off until an operator turns it on.
// - Not installed (the `jev` command cannot start): checked on every pass, cheap, until the command exists.
// - The account fails (out of credit, missing or rejected key): tried again on the first pass an hour after the last failure.
//
// - Answers cannot be read (JEV_UNREADABLE_LIMIT in a row, counted from the recorded Jev runs): same hourly retry; one readable answer ends it.
//
// The state is one settings row, settings.jev_unavailable, shown on the Accounts page.
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { jevCloudflareConfig } from "./jev-cloudflare.ts";
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { deleteSetting, setting, writeSetting } from "../settings-read.ts";

export const JEV_ENABLED_KEY = "jev_enabled";
export const JEV_UNAVAILABLE_KEY = "jev_unavailable";
/** How long after the last account failure the next pass tries Jev again. */
export const JEV_RETRY_MS = 5 * 60_000;

/** Consecutive Jev runs recorded as an unreadable answer that count as an outage. */
export const JEV_UNREADABLE_LIMIT = 20;
export const JEV_UNREADABLE_SUMMARY = "unreadable answer";

export type JevOutage = { kind: "off" | "missing" | "account" | "format"; reason: string; since: string; at: string };

// Through settings-read, so a planner pass reads them from its snapshot.
const get = setting;
const put = writeSetting;

export const jevEnabled = async (db: Db): Promise<boolean> => await get(db, JEV_ENABLED_KEY) !== "no";

export async function jevOutage(db: Db): Promise<JevOutage | null> {
  try {
    const o = JSON.parse(await get(db, JEV_UNAVAILABLE_KEY) ?? "null") as JevOutage | null;
    return o && typeof o.since === "string" && typeof o.reason === "string" ? o : null;
  } catch { return null; }
}

const clear = async (db: Db): Promise<void> => await deleteSetting(db, JEV_UNAVAILABLE_KEY);

/** True when Jev can be reached: Cloudflare Workers AI is configured, or an executable `jev` is on PATH. */
export function jevInstalled(): boolean {
  if (jevCloudflareConfig()) return true;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, "jev"), constants.X_OK); return true; } catch { /* next directory */ }
  }
  return false;
}

// Search path, home, locale, temp and cache directories, TLS and proxy settings, and Jev's own (TYPESAFE_*, JEV_*) and its launcher's (UV_*) variables.
const JEV_ENV_KEYS = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]);
const JEV_ENV_PREFIXES = ["TYPESAFE_", "JEV_", "UV_"];

/** The whole environment of a `jev` child: the variables it needs to start and reach its API. The runner's GitHub and Claude tokens are not among them. */
export function jevEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (JEV_ENV_KEYS.has(k) || JEV_ENV_PREFIXES.some((p) => k.startsWith(p)))) out[k] = v;
  return out;
}

/** Turns Jev on or off; turning it on also forgets an earlier failure so the next pass tries it. */
export async function setJevEnabled(db: Db, on: boolean, by: string): Promise<void> {
  const was = await jevEnabled(db);
  await put(db, JEV_ENABLED_KEY, on ? "yes" : "no");
  if (on) await clear(db);
  else await put(db, JEV_UNAVAILABLE_KEY, JSON.stringify({ kind: "off", reason: "switched off", since: new Date().toISOString(), at: new Date().toISOString() } satisfies JevOutage));
  if (on !== was) await audit(db, by, "account-change", "jev", { jevEnabled: on, was });
}

/** Whether a pass may call Jev now, without writing: for readers such as the planner. */
export async function jevUsable(db: Db, nowMs: number = Date.now()): Promise<boolean> {
  if (!await jevEnabled(db)) return false;
  const o = await jevOutage(db);
  if (!o) return true;
  if (o.kind === "missing") return jevInstalled();
  if (o.kind === "account" || o.kind === "format") return nowMs - Date.parse(o.at) >= JEV_RETRY_MS;
  return true;
}

/** Whether a pass may call Jev now. Also keeps the stored state in step with the switch and the installed command. */
export async function jevAvailable(db: Db, nowMs: number = Date.now()): Promise<boolean> {
  if (!await jevEnabled(db)) {
    if ((await jevOutage(db))?.kind !== "off") await put(db, JEV_UNAVAILABLE_KEY, JSON.stringify({ kind: "off", reason: "switched off", since: new Date(nowMs).toISOString(), at: new Date(nowMs).toISOString() } satisfies JevOutage));
    return false;
  }
  const usable = await jevUsable(db, nowMs), o = await jevOutage(db);
  // A switch turned back on or a command installed since the outage was recorded ends it; an account or format outage ends with a call that works.
  if (usable && o && o.kind !== "account" && o.kind !== "format") await clear(db);
  return usable;
}

/** Records a failure; `since` stays at the first failure of an outage. */
export async function markJevUnavailable(db: Db, kind: "missing" | "account" | "format", reason: string, nowMs: number = Date.now()): Promise<void> {
  const prev = await jevOutage(db);
  const at = new Date(nowMs).toISOString();
  await put(db, JEV_UNAVAILABLE_KEY, JSON.stringify({ kind, reason, since: prev?.kind === kind ? prev.since : at, at } satisfies JevOutage));
}

/** A call that started at `startedMs` went through: an earlier outage is over. An outage recorded after the call started (by a parallel call) stays. */
export async function markJevWorking(db: Db, startedMs: number): Promise<void> {
  const o = await jevOutage(db);
  if (o && o.kind !== "off" && Date.parse(o.at) < startedMs) await clear(db);
}

/**
 * Marks Jev unavailable when the latest JEV_UNREADABLE_LIMIT finished Jev runs (any process) were all unreadable answers.
 * Call after the run is recorded. Returns whether it marked.
 */
export async function markJevUnreadable(db: Db, nowMs: number = Date.now()): Promise<boolean> {
  const rows = await db.all(db.k.selectFrom("agent_runs").select("summary").where("provider", "=", "jev").where("state", "!=", "running")
    .orderBy("id", "desc").limit(JEV_UNREADABLE_LIMIT));
  if (rows.length < JEV_UNREADABLE_LIMIT || rows.some((r) => r.summary !== JEV_UNREADABLE_SUMMARY)) return false;
  await markJevUnavailable(db, "format", `Jev answers could not be read (${JEV_UNREADABLE_LIMIT} in a row)`, nowMs);
  return true;
}

/**
 * Whether a finished `jev` process failed because Jev is unavailable (as opposed to a timeout, a server error or a bad answer,
 * which are retried): the command is missing, or the API refused the account.
 * The CLI prints `jev: API error status=<N> request_id=...: <message>` or `jev: <message>` on stderr.
 */
export function jevFailure(r: { code: number | null; stderr: string }): { kind: "missing" | "account"; reason: string } | null {
  if (r.code === -1 && /ENOENT/.test(r.stderr)) return { kind: "missing", reason: "not installed" };
  // The jev script exits 127 when the interpreter it starts through is missing.
  if (r.code === 127 && /no such file or directory|not found/i.test(r.stderr)) return { kind: "missing", reason: "not installed" };
  if (r.code === 0 || r.code === null || r.code === -1) return null;
  const line = r.stderr.split("\n").find((l) => l.startsWith("jev: ")) ?? "";
  const status = /API error status=(\d+)/.exec(line)?.[1];
  // With a status, the status decides: a 429 "quota" or a 503 "insufficient capacity" is not an account problem.
  if (status !== undefined && !/^2\d\d$/.test(status)) return status === "402" ? { kind: "account", reason: "out of credit" } : status === "401" || status === "403" ? { kind: "account", reason: "key rejected" } : null;
  if (/rate.?limit|too many requests|quota exceeded|insufficient capacity/i.test(line)) return null;
  if (/\b(out of credits?|insufficient (credit|credits|balance|funds)|billing|payment required)\b/i.test(line)) {
    return { kind: "account", reason: line.replace(/^jev:\s*/i, "").slice(0, 120) || "out of credit" };
  }
  if (/api key/i.test(line)) return { kind: "account", reason: "key rejected" };
  return null;
}
