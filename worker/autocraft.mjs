#!/usr/bin/env node
// @ts-check
// autocraft: the AutoCraft Task Runner. It runs AutoCraft model calls on a maintainer's own machine, under their own harness
// subscription. It claims a call, fetches its bundle (prompt, checkouts, MCP servers), runs the harness in a read-only
// sandbox confined to the task directory, sends heartbeats and submits the reply. Planner, gates, GitHub writes and builds
// stay on the server.
//
// One file, only `node:` imports, Node 22 or later. The dashboard serves it at /worker/autocraft.mjs.
// The harness runs inside bubblewrap on Linux and WSL, inside sandbox-exec on macOS.
//
//   autocraft login <server-url> [--label X] [--no-wait] [--answer] [--no-agent]  makes a credential and has it approved on the dashboard
//   autocraft login --wait                 waits for the approval of a login started with --no-wait (at most 9 minutes)
//   autocraft login <server-url> --stdin   stores a Task Runner credential given on stdin
//   autocraft harness claude [--keychain]  a `claude setup-token` token on stdin, or (macOS) Claude Code's own login from the Keychain
//   autocraft harness claude --config-dir [<dir>]  the login of a Claude config directory, read at each call (Linux)
//   autocraft harness codex [--device-auth]  logs Codex in to the runner's own CODEX_HOME
//   autocraft setup [<url>] [--yes]   installs what is missing (bubblewrap, git, tar, AppArmor rule, Claude Code, logins), asking first
//   autocraft doctor                  checks platform, sandbox, harness, login and server
//   autocraft update                  replaces this file with the server's current runner
//   autocraft service install | uninstall | status  runs `work` as a systemd user unit or launchd agent
//   autocraft runner status | logs | pause | resume | reserve  readiness and plan usage, the service log, pausing, the usage reserve
//   autocraft inbox | queue | calls | settings | repos | fixups ...  the server's tools as commands (MCP over HTTP); `call <tool>` reaches any tool
//   autocraft work [--parallel N] [--no-auto-update]  claims, runs and submits in a loop; updates itself when the server has a newer runner
//   autocraft claim                   claims one call; prints its lease id
//   autocraft run [--detach] [<lease>]  runs a claimed lease (claims one when none is given)
//   autocraft wait <lease>            waits for a detached run (at most 9 minutes)
//   autocraft try <bundle.json>       runs a bundle from a file without a server (testing)
//   autocraft mcp <server> <lease>    stdio-to-HTTP proxy for one of the lease's MCP servers
//   autocraft tool <server> <tool> [<json>] [<lease>]  one tool call without MCP; prints the result
//   autocraft migrate                 moves an autocraft-task 1.2.0 install over (directories, credential, binary, service)

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, chmodSync, closeSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const HELPER_VERSION = "1.5.0";

// ---------------------------------------------------------------------------
// Wire format: a copy of src/remote/protocol.ts (the helper is served alone, so it keeps its own).

/**
 * The server refuses a claim of a protocol it does not accept; a server not yet updated is asked again with the older
 * protocols (claimRequest). 5: a tool reply's content may hold images after the text.
 */
export const PROTOCOL_VERSION = 5;
/** The protocols a claim falls back to, newest first: 4 and 3 differ from 5 only in what the server sends, 3 also has no held wait. */
const OLDER_PROTOCOLS = [4, 3];

export const ROUTES = {
  claim: "/api/remote/claim",
  status: "/api/remote/status",
  bundle: "/api/remote/bundle",
  heartbeat: "/api/remote/heartbeat",
  submit: "/api/remote/submit",
  release: "/api/remote/release",
  tarball: "/api/remote/tarball",
  tool: "/api/remote/tool",
  mcp: "/mcp/task",
  loginStart: "/api/remote/login/start",
  loginPoll: "/api/remote/login/poll",
  helper: "/worker/autocraft.mjs",
  legacyHelper: "/worker/autocraft-task.mjs",
};

/** @typedef {"top" | "mid" | "small"} Tier */
/** @typedef {"claude" | "codex"} HarnessId */
/**
 * @typedef {object} Claim
 * @property {number} protocol
 * @property {string} helperVersion
 * @property {HarnessId} harness
 * @property {string} harnessVersion
 * @property {Partial<Record<Tier, string>>} tiers
 * @property {Partial<Record<Tier, "low" | "medium" | "high" | "xhigh" | "max">>} [efforts]
 * @property {string[]} [repos]
 * @property {number[]} [sessions]
 * @property {string} [root]
 * @property {string} requestId
 * @property {boolean} [fastLane]
 * @property {boolean} [interactiveLane]  an interactive slot: only interactive calls (the user's Interactive slots)
 * @property {boolean} [ownLane]  the own lane: only calls bound to this user and their follow-ups
 * @property {boolean} [withOwnLane]  a slot's or the fast lane's claim while an own lane runs beside them
 * @property {number} [wait]  protocol 4: seconds the server may hold the claim open when nothing is queued (0 to 30)
 * @property {number} [maxTimeoutSeconds]  only calls of at most this timeout: the harness login is refreshed before a longer one could finish
 */
/** @typedef {{ fiveHour: number, weekly: number }} Reserve  percent of each plan window kept free */
/** Body encodings besides plain JSON; a server lists the ones it accepts in its claim and status replies. */
export const ENCODINGS = /** @type {const} */ (["gzip+base64"]);
/** @typedef {(typeof ENCODINGS)[number]} Encoding */
/** @typedef {{ encoding: Encoding, body: string }} Envelope  `body`: base64 of the gzip of the plain JSON body */
/** @typedef {({ lease: null, retryAfter: number, reserve: Reserve, reason?: string, until?: number, encodings?: Encoding[], ownLane?: true, interactiveSlots?: number } | { lease: { id: number, secret: string, title: string, requiredHelper: string }, reserve: Reserve, encodings?: Encoding[], ownLane?: true, interactiveSlots?: number }) & { currentHelper?: string }} ClaimReply */
/** @typedef {"ready" | "quota-held" | "paused" | "cooled-off" | "sandbox-failed" | "version-refused" | "harness-missing" | "failing" | "login-refresh"} Readiness */
/** @typedef {{ usedPercent: number, resetsAt: string | null }} UsageWindow */
/** @typedef {{ fiveHour: UsageWindow | null, weekly: UsageWindow | null, at: string }} UsageReading */
/**
 * @typedef {object} HelperStatus
 * @property {Readiness} readiness
 * @property {string} [until]
 * @property {string} [reason]
 * @property {HarnessId} harness
 * @property {Partial<Record<Tier, string>>} models
 * @property {Reserve} reserve
 * @property {UsageReading} [usage]
 * @property {number} slots
 * @property {number} busy
 * @property {{ text: string, at: string }} [lastError]
 * @property {string} [helperVersion]
 * @property {Machine} [machine]
 */
/** @typedef {{ ok: true, reserve: Reserve, encodings?: Encoding[] }} StatusReply */
/** @typedef {{ hostname: string, platform: string, arch: string }} Machine */
/** @typedef {{ credentialHash: string, label: string, machine: Machine, helperVersion: string, scopes?: { agent?: boolean, answer?: boolean } }} LoginStart */
/** @typedef {{ userCode: string, verifyUrl: string, interval: number, expiresIn: number }} LoginStartReply */
/** @typedef {"pending" | "approved" | "denied" | "expired"} LoginState */
/** @typedef {{ state: LoginState }} LoginPollReply */
/** The machine this runner runs on, for the login and status reports. @returns {Machine} */
const machine = () => ({ hostname: hostname(), platform: process.platform, arch: process.arch });

/** The calls this process runs at once and how many run now, for status reports (set by `work`). */
const capacity = { slots: 1, busy: 0 };
/**
 * @typedef {{ kind: "git", path: string, owner: string, repo: string, sha: string, ref?: string }
 *   | { kind: "tarball", path: string, repo: string, sha: string }
 *   | { kind: "files", path: string, files: { name: string, base64: string }[] }} Mount  a `files` name is a relative path, possibly with subdirectories
 */
/**
 * @typedef {object} TaskBundle
 * @property {number} callId
 * @property {string} promptId
 * @property {string} promptVersion
 * @property {Tier} tier
 * @property {"low" | "medium" | "high" | "xhigh" | "max"} effort
 * @property {number} timeoutSeconds
 * @property {number | null} maxTurns
 * @property {string} stdin
 * @property {string | null} system
 * @property {Mount[]} mounts
 * @property {string[]} mcpServers
 * @property {boolean} keepSession  keep the harness session after the call, for follow-up turns
 * @property {{ parentCallId: number }} [resume]
 * @property {{ claude?: { args: string[], agents?: string } }} hints
 */
/**
 * Test-only: AUTOCRAFT_REMOTE_TIME_SCALE (0.01 to 1, unset = 1) multiplies every time window of the helper, as it does on
 * the server (src/remote/time-scale.ts), so the load rig runs in minutes. The protocol constants below keep their production
 * values; the scale applies where they are used.
 */
const TIME_SCALE = (() => {
  const raw = process.env.AUTOCRAFT_REMOTE_TIME_SCALE;
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.01 || n > 1) throw new Error(`AUTOCRAFT_REMOTE_TIME_SCALE must be a number from 0.01 to 1 (test only), got "${raw}"`);
  return n;
})();
/** @param {number} ms @returns {number} */
const scaled = (ms) => (TIME_SCALE === 1 ? ms : Math.max(1, Math.round(ms * TIME_SCALE)));
/** @typedef {{ phase: "preparing" | "running", progress?: string }} Heartbeat  `preparing` from the claim until the harness spawns */
export const HEARTBEAT_S = 30;
/** The longest a lease may stay in `preparing`. */
export const PREPARE_MAX_S = 15 * 60;
/** How long the server remembers a claim's `requestId` and its reply. */
export const CLAIM_ID_TTL_S = 300;
const HEARTBEAT_MS = scaled(HEARTBEAT_S * 1000), PREPARE_MAX_MS = scaled(PREPARE_MAX_S * 1000), CLAIM_ID_TTL_MS = scaled(CLAIM_ID_TTL_S * 1000);
/** @typedef {{ inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number }} Usage */
/** @typedef {{ name: string, args: string, resultBytes: number | null, isError: boolean, startedAt?: string, endedAt?: string }} SubmitTool */
/**
 * @typedef {{ ok: true, text: string, model: string, usage: Usage, modelUsage?: Record<string, Usage>, costUsd?: number, turns?: number, sessionId?: string, tools?: SubmitTool[], durationMs: number }
 *   | { ok: false, error: string, usage?: Usage, durationMs: number, refused?: boolean }} Submit
 */
/** @typedef {{ accepted: boolean, reason?: string }} SubmitReply */
/** @typedef {{ reason: string }} Release */

// ---------------------------------------------------------------------------
// Harness adapters: `claudeAdapter` and `codexAdapter`, listed in ADAPTERS.

/**
 * What an adapter gets for one run.
 * @typedef {object} AdapterTask
 * @property {TaskBundle} bundle
 * @property {string} model      the model this helper runs for the bundle's tier
 * @property {string} bin        resolved harness binary on the host
 * @property {string} token      the harness credential (environment only, never argv): a token, or for codex the helper's own CODEX_HOME
 * @property {{ host: string, path: string }[]} mounts   prepared read-only mounts, `path` inside the sandbox
 * @property {string} taskDir    host directory for generated files (MCP config, agents file)
 * @property {string} mcpFile    host file with the MCP config, or "" when the call has no MCP servers
 * @property {{ server: string, secret: string }} lease  for adapters that configure the MCP servers themselves
 * @property {{ url: string, token: string }} [files]  the helper's file tools for this run, for an adapter with `fileTools`
 * @property {string} [sessionDir]  writable host directory for the harness's session store
 * @property {string} [resumeId]    harness session id to continue
 * @property {{ root: string, profile: string, install: { argv: string[] } }} [mac]  macOS: the slot (mounts, MCP config and agents file are in it) and the sandbox-exec profile
 */
/**
 * @typedef {object} Reply
 * @property {boolean} ok
 * @property {string} text
 * @property {string} model
 * @property {Usage | undefined} usage  the requested model's
 * @property {Record<string, Usage>} [modelUsage]  per model id, subagents included
 * @property {number} [costUsd]  the whole call's cost as the harness reports it
 * @property {number} [turns]
 * @property {string} [sessionId]
 * @property {string} [error]
 * @property {boolean} [refused]  the model's safety filter declined the request
 */
/**
 * @typedef {object} Adapter
 * @property {HarnessId} id
 * @property {(cfg: Config) => { bin: string | null, version: string | null, loggedIn: boolean }} detect
 * @property {(task: AdapterTask) => { cmd: string, args: string[], env: Record<string, string> }} command  the sandboxed process
 * @property {(stdout: string, model: string) => Reply} parse
 * @property {(args: string[], sessionId: string) => string[]} resume  harness arguments for a follow-up turn
 * @property {(line: string) => string | null} progress  a progress line from one output line, or null
 * @property {(cfg: Config) => string | undefined} token  the stored harness credential
 * @property {(cfg: Config, timeoutSeconds: number) => { token: string } | { problem: string }} [tokenFor]  the credential for a call of this timeout, or why the call can't run now (released, not failed)
 * @property {(cfg: Config) => { room: number, refreshAt: number } | null} [loginRoom]  the longest call timeout a claim may take before the login's refresh point (`refreshAt`, ms since epoch), or null when the login sets no limit
 * @property {Partial<Record<Tier, string>>} defaultTiers  empty when the user must name every tier's model
 * @property {"high" | "xhigh" | "max"} maxEffort  the highest level of the effort ladder the harness is given; a bundle's higher effort is passed as this
 * @property {(bin: string) => { cmd: string, args: string[], env: Record<string, string> }} versionInSandbox  the harness's version command inside the sandbox (doctor, Linux)
 * @property {(bin: string) => { argv: string[], files: string[], dirs: string[] }} install  macOS: what runs the harness and what of its install the profile lets it read
 * @property {(bin: string, token: string) => string | null} [preflight]  prepares the harness's files before every call; why it must not run, or null
 * @property {boolean} [exclusive]  one call at a time per helper (the harness refreshes a shared login)
 * @property {boolean} [fileTools]  the run gets the helper's read-only file tools (its own read tool can't be confined)
 * @property {(version: string) => string | null} [unaudited]  why this harness version must not run calls, or null
 * @property {(line: string, servers: string[]) => string | null} [guard]  an output line showing a tool the call may not use, or that one of its MCP servers is missing: the run is stopped at once
 * @property {(o: { token: string, sessionId: string | undefined, servers: string[], keep: boolean }) => { problem: string | null, tools?: SubmitTool[] }} [verify]  after the run, from the harness's own record: a tool the call may not use (or null), and the tool uses
 * @property {(stdout: string, stamps: string[]) => SubmitTool[]} [tools]  the tool uses from the output; `stamps` holds the arrival time of each complete output line
 * @property {(line: string) => string | null} compact  the part of one output line that `parse` and `tools` read, or null: the run keeps only these
 */

// ---------------------------------------------------------------------------
// Pure functions (exported for tests).

const INSTRUCTION_FILES = new Set(["claude.md", "claude.local.md", "agents.md"]);

/** True for a path claude could load as instructions or settings: CLAUDE.md, CLAUDE.local.md, AGENTS.md at any depth, or anything under a `.claude` directory (case-insensitive). Same rule as src/sandbox/instruction-paths.ts. */
export function isInstructionPath(/** @type {string} */ p) {
  return p.split("/").some((c) => INSTRUCTION_FILES.has(c.toLowerCase()) || c.toLowerCase() === ".claude");
}

/** Removes every instruction file and `.claude` directory under `root`; returns the removed paths relative to it. Symlinks are removed, never followed. */
export function removeInstructionFiles(/** @type {string} */ root) {
  /** @type {string[]} */
  const removed = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (isInstructionPath(e.name)) { rmSync(join(root, r), { recursive: true, force: true }); removed.push(r); }
      else if (e.isDirectory()) walk(r);
    }
  };
  walk("");
  return removed.sort();
}

export const CLAUDE_LOGIN_EXPIRES = "Claude login expires soon; run claude once to refresh it";

/** Seconds a call needs to spare before the login's refresh point beyond its timeout: the harness's stop after the timeout, clock drift. */
const LOGIN_CALL_SLACK_S = 60;
/** Seconds a claim keeps back for the call's preparation (bundle, files) before its timeout starts. */
const LOGIN_PREPARE_S = 60;
/** The shortest timeout the server gives a call: with less room before the refresh point, no call fits. */
const SHORTEST_CALL_S = 120;

/**
 * The access token of a Claude login (the `claudeAiOauth` entry of its `.credentials.json`), only when a call of this
 * timeout started now ends before the login's refresh point (claudeRefreshAt): the sandboxed claude gets the token as
 * CLAUDE_CODE_OAUTH_TOKEN and can't refresh it, and no call runs while the user's own claude refreshes the login.
 * @param {any} creds @param {number} timeoutSeconds @param {number} [now]
 * @returns {{ token: string } | { problem: string }}
 */
export function claudeLoginToken(creds, timeoutSeconds, now = Date.now()) {
  const o = creds?.claudeAiOauth;
  if (typeof o?.accessToken !== "string" || !o.accessToken || typeof o.expiresAt !== "number") return { problem: "no Claude login in the configured directory; run claude and log in" };
  if (claudeRefreshAt(o.expiresAt) < now + (timeoutSeconds + LOGIN_CALL_SLACK_S) * 1000) return { problem: CLAUDE_LOGIN_EXPIRES };
  return { token: o.accessToken };
}

/**
 * The longest call timeout (seconds) a claim may take now so that the call, prepared and run, ends before the login's
 * refresh point, and that point; null without an expiring Claude login.
 * @param {any} creds @param {number} [now] @returns {{ room: number, refreshAt: number } | null}
 */
export function claudeLoginRoom(creds, now = Date.now()) {
  const e = creds?.claudeAiOauth?.expiresAt;
  if (typeof e !== "number" || e >= Number.MAX_SAFE_INTEGER) return null;
  const refreshAt = claudeRefreshAt(e);
  return { room: Math.floor((refreshAt - now) / 1000) - LOGIN_CALL_SLACK_S - LOGIN_PREPARE_S, refreshAt };
}

/** Whether a login with this much room takes calls: the shortest call fits. @param {{ room: number } | null} r */
export const loginTakesCalls = (r) => r === null || r.room >= SHORTEST_CALL_S;

/** Why `--config-dir` does not apply on macOS. */
const CLAUDE_CONFIG_DIR_MACOS = "on macOS Claude Code keeps its login in the Keychain, not in a config directory: use `autocraft harness claude --keychain`, or store a setup-token";

/**
 * The Claude login the config names, in the `.credentials.json` shape: the Keychain item on macOS with `claudeAuth`
 * "keychain", the config directory's file elsewhere; null for a setup-token or no login.
 * @param {Config} cfg @returns {any}
 */
function claudeCredential(cfg) {
  if (cfg.claudeAuth === "keychain") {
    const k = keychainCredential(keychainItemOf(cfg));
    return k ? { claudeAiOauth: { accessToken: k.token, expiresAt: k.expiresAt ?? Number.MAX_SAFE_INTEGER } } : null;
  }
  return cfg.claudeConfigDir && process.platform !== "darwin" ? readClaudeCredentials(cfg.claudeConfigDir) : null;
}

/**
 * Claude Code refreshes its login only within 5 minutes of its expiry, under its own lock in the config directory, and
 * rotates the refresh token while doing so. The helper never refreshes the login itself: inside that window it runs the
 * user's own claude once, outside the sandbox with the login's own config directory or Keychain item, and lets it refresh.
 */
const CLAUDE_REFRESH_WINDOW_MS = 4 * 60_000;
/** When the Task Runner has claude refresh a login that ends at `expiresAt`; no call runs past it. @param {number} expiresAt */
const claudeRefreshAt = (expiresAt) => expiresAt - CLAUDE_REFRESH_WINDOW_MS;
const CLAUDE_REFRESH_RETRY_MS = 90_000;
// The smallest request that goes through Claude Code's login check: no tools, settings, hooks, MCP servers or session file.
const CLAUDE_REFRESH_ARGS = ["-p", "ok", "--model", "haiku", "--max-turns", "1", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"];
/** @type {{ at: number, run: Promise<boolean> | null }} */
const claudeRefresh = { at: 0, run: null };

/**
 * The environment under which the user's own claude finds the login the config names, or null when the helper can't
 * have it refreshed: a setup-token (it doesn't expire this way), or a Keychain item of another config directory.
 * @param {Config} cfg @returns {Record<string, string> | null}
 */
export function claudeRefreshEnv(cfg, platform = process.platform) {
  const env = { PATH: process.env.PATH ?? "/usr/bin", HOME: homedir(), LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1" };
  if (cfg.claudeAuth === "keychain") return keychainItemOf(cfg).service === "Claude Code-credentials" ? env : null;
  return cfg.claudeConfigDir && platform !== "darwin" ? { ...env, CLAUDE_CONFIG_DIR: cfg.claudeConfigDir } : null;
}

/**
 * Has the user's claude refresh the login when it ends within CLAUDE_REFRESH_WINDOW_MS (or has ended), at most once per
 * CLAUDE_REFRESH_RETRY_MS; concurrent callers share one run. True when the login now outlives the window.
 * @param {Config} cfg @param {string} bin @returns {Promise<boolean>}
 */
async function refreshClaudeLogin(cfg, bin) {
  const env = claudeRefreshEnv(cfg);
  const expiresAt = () => claudeCredential(cfg)?.claudeAiOauth?.expiresAt;
  const e = expiresAt();
  if (!env || typeof e !== "number" || e > Date.now() + CLAUDE_REFRESH_WINDOW_MS) return false;
  if (claudeRefresh.run) return claudeRefresh.run;
  if (Date.now() - claudeRefresh.at < CLAUDE_REFRESH_RETRY_MS) return false;
  claudeRefresh.at = Date.now();
  claudeRefresh.run = (async () => {
    const dir = mkdtempSync(join(privateDir(cacheDir()), "login-refresh-"));
    try {
      const code = await new Promise((done) => {
        const p = spawn(bin, CLAUDE_REFRESH_ARGS, { cwd: dir, env, stdio: "ignore", timeout: 60_000 });
        p.on("error", () => done(-1));
        p.on("exit", (c) => done(c ?? -1));
      });
      const after = expiresAt();
      const ok = typeof after === "number" && after > Date.now() + CLAUDE_REFRESH_WINDOW_MS;
      console.log(ok ? "Claude login refreshed" : `Claude login refresh did not take (claude exit ${code}); trying again in ${CLAUDE_REFRESH_RETRY_MS / 1000} s`);
      return ok;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      claudeRefresh.run = null;
    }
  })();
  return claudeRefresh.run;
}

/** The arguments with the model replaced (`--model x` or `--model=x`), or added after `-p` when absent. */
export function withModel(/** @type {string[]} */ args, /** @type {string} */ model) {
  const out = [...args];
  const i = out.indexOf("--model");
  if (i >= 0 && i + 1 < out.length) { out[i + 1] = model; return out; }
  const j = out.findIndex((a) => a.startsWith("--model="));
  if (j >= 0) { out[j] = `--model=${model}`; return out; }
  const p = out.indexOf("-p");
  out.splice(p + 1, 0, "--model", model);
  return out;
}

/** The arguments without any `--resume <id>`. */
export function withoutResume(/** @type {string[]} */ args) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") { i++; continue; }
    if (args[i].startsWith("--resume=")) continue;
    out.push(args[i]);
  }
  return out;
}

/** @param {string} m */
const family = (m) => /haiku/i.test(m) ? "haiku" : /sonnet/i.test(m) ? "sonnet" : /opus/i.test(m) ? "opus" : m;

/** @param {string} stdout @returns {any[]} */
function events(stdout) {
  try {
    const j = JSON.parse(stdout);
    return Array.isArray(j) ? j : [j];
  } catch {
    return stdout.split("\n").filter((l) => l.startsWith("{")).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }
}

/** The CLI's text for a request the model's safety filter declined (as src/remote/calls.ts SAFETY_REFUSAL). */
const SAFETY_REFUSAL = /safeguards flagged this message|appears to violate our usage policy/i;

/**
 * Reads `claude -p` output (stream-json, or the json event list): the result text, the called model's usage
 * (cache tokens included; with `modelUsage` only the requested model's family, so explorer subagent tokens
 * are left out), the model id it reported, the session id and the turns. Same reading as src/classify/run.ts.
 * @param {string} stdout @param {string} model the requested model or alias
 * @returns {Reply}
 */
export function parseClaudeOutput(stdout, model) {
  const evs = events(stdout);
  const result = evs.findLast((e) => e && e.type === "result");
  const init = evs.find((e) => e && e.type === "system" && typeof e.model === "string");
  const sessionId = [result, ...evs].find((e) => e && typeof e.session_id === "string")?.session_id;
  /** @type {[string, any][]} */
  const per = Object.entries(result?.modelUsage ?? {});
  const mine = per.filter(([m]) => family(m) === family(model));
  const reported = (mine.length ? mine : per).sort(([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))[0]?.[0] ?? init?.model ?? model;
  /** @type {Usage | undefined} */
  let usage;
  if (mine.length) {
    usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const [, x] of mine) {
      usage.inputTokens += x.inputTokens ?? 0; usage.outputTokens += x.outputTokens ?? 0;
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (x.cacheReadInputTokens ?? 0); usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (x.cacheCreationInputTokens ?? 0);
    }
  } else if (result?.usage) {
    const u = result.usage;
    usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 };
  } else {
    // No result (killed or timed out): the tokens of the assistant messages seen so far, each message once.
    const seen = new Map();
    for (const e of evs) if (e?.type === "assistant" && e.message?.usage) seen.set(e.message.id ?? `#${seen.size}`, e.message.usage);
    if (seen.size) {
      usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const u of seen.values()) {
        usage.inputTokens += u.input_tokens ?? 0; usage.outputTokens += u.output_tokens ?? 0;
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0); usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    }
  }
  /** @type {Record<string, Usage>} */
  const modelUsage = Object.fromEntries(per.map(([m, x]) => [m, { inputTokens: x.inputTokens ?? 0, outputTokens: x.outputTokens ?? 0, cacheReadTokens: x.cacheReadInputTokens ?? 0, cacheWriteTokens: x.cacheCreationInputTokens ?? 0 }]));
  const base = { model: reported, usage, ...(per.length > 0 && { modelUsage }), ...(typeof result?.total_cost_usd === "number" && { costUsd: result.total_cost_usd }),
    ...(typeof result?.num_turns === "number" && { turns: result.num_turns }), ...(sessionId && { sessionId }) };
  if (!result) return { ok: false, text: "", ...base, error: evs.length ? "no result" : "unreadable output" };
  if (result.subtype === "error_max_turns") return { ok: false, text: "", ...base, error: "turn limit: the model used every turn the prompt allows without an answer" };
  if (result.is_error || typeof result.result !== "string") {
    const said = typeof result.result === "string" ? result.result : "";
    const refused = result.stop_reason === "refusal" || SAFETY_REFUSAL.test(said);
    return { ok: false, text: "", ...base, error: `model error ${said}`.trim().slice(0, 400), ...(refused && { refused: true }) };
  }
  return { ok: true, text: result.result, ...base };
}

const TOOL_ARGS_MAX = 4000;
const MAX_TOOLS = 1000;

/** Bytes of a tool result: text blocks by their text, anything else as JSON (as src/agents/tools.ts counts them). @param {unknown} c */
const resultSize = (c) => {
  if (typeof c === "string") return Buffer.byteLength(c);
  if (Array.isArray(c)) return c.reduce((n, b) => n + (typeof b?.text === "string" ? Buffer.byteLength(b.text) : Buffer.byteLength(JSON.stringify(b ?? null))), 0);
  return c === undefined || c === null ? 0 : Buffer.byteLength(JSON.stringify(c));
};

/** A tool's input as stored: JSON, secrets redacted, capped. @param {unknown} input */
const toolArgs = (input) => redact(JSON.stringify(input ?? null) ?? "null").slice(0, TOOL_ARGS_MAX);

/**
 * The tool uses of `claude -p` stream-json output, in order and paired with their results by id, subagents included:
 * the same reading as src/agents/tools.ts `toolUses`. `stamps[i]` is the arrival time of output line i.
 * @param {string} stdout @param {string[]} [stamps]
 * @returns {SubmitTool[]}
 */
export function claudeTools(stdout, stamps = []) {
  /** @type {Map<string, SubmitTool>} */
  const byId = new Map();
  stdout.split("\n").forEach((line, i) => {
    if (!line.startsWith("{") || !line.includes("tool_")) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (!Array.isArray(e?.message?.content)) return;
    const at = stamps[i];
    for (const b of e.message.content) {
      if (e.type === "assistant" && b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string" && byId.size < MAX_TOOLS) {
        byId.set(b.id, { name: b.name.slice(0, 100), args: typeof b.args === "string" ? b.args : toolArgs(b.input), resultBytes: null, isError: false, ...(at && { startedAt: at }) });
      } else if (e.type === "user" && b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const u = byId.get(b.tool_use_id);
        if (u) { u.resultBytes = typeof b.bytes === "number" ? b.bytes : resultSize(b.content); u.isError = b.is_error === true; if (at) u.endedAt = at; }
      }
    }
  });
  return [...byId.values()];
}

/**
 * The part of one `claude -p` output line that parseClaudeOutput and claudeTools read, or null: the init's model and
 * session, the result whole, an assistant message's id, usage and tool uses (their stored arguments, not the input), and a
 * tool result's size. A `--output-format json` event list is kept whole.
 * @param {string} line @returns {string | null}
 */
export function claudeCompact(line) {
  if (line.startsWith("[")) return line;
  if (!line.startsWith("{")) return null;
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  const sid = typeof e?.session_id === "string" ? { session_id: e.session_id } : {};
  if (e?.type === "result") return line;
  if (e?.type === "system") return typeof e.model === "string" || sid.session_id ? JSON.stringify({ type: "system", ...(typeof e.model === "string" && { model: e.model }), ...sid }) : null;
  /** @type {any[]} */
  const content = Array.isArray(e?.message?.content) ? e.message.content : [];
  if (e?.type === "assistant") {
    const uses = content.filter((b) => b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string").map((b) => ({ type: "tool_use", id: b.id, name: b.name, args: toolArgs(b.input) }));
    if (!uses.length && !e.message?.usage) return null;
    return JSON.stringify({ type: "assistant", ...sid, message: { ...(e.message.id !== undefined && { id: e.message.id }), ...(e.message.usage && { usage: e.message.usage }), content: uses } });
  }
  if (e?.type === "user") {
    const results = content.filter((b) => b?.type === "tool_result" && typeof b.tool_use_id === "string").map((b) => ({ type: "tool_result", tool_use_id: b.tool_use_id, is_error: b.is_error === true, bytes: resultSize(b.content) }));
    return results.length ? JSON.stringify({ type: "user", ...sid, message: { content: results } }) : null;
  }
  return null;
}

/** @param {unknown} v @param {number} [n] */
const clean = (v, n = 80) => {
  const t = (typeof v === "string" ? v : "").replace(/[^\P{C}]|\s+/gu, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** @param {unknown} p */
const rel = (p) => { const s = clean(p, 200); for (const r of ["/repo/", "/repos/"]) if (s.startsWith(r)) return s.slice(r.length); return s; };
/** @param {Record<string, unknown>} i */
const itemRef = (i) => `${clean(i.repo, 40)}#${typeof i.number === "number" ? i.number : clean(i.number, 10)}`;

/** The progress line for one tool call, or null; same wording as src/classify/progress.ts. @param {string} name @param {unknown} input */
export function toolLine(name, input) {
  const i = /** @type {Record<string, unknown>} */ (input && typeof input === "object" ? input : {});
  if (["Read", "Grep", "Glob"].includes(name) && [i.file_path, i.path, i.pattern].some((v) => typeof v === "string" && v.includes("/reference"))) return "Checking reference documentation";
  switch (name) {
    case "Read": return `Reading ${rel(i.file_path)}`;
    case "Grep": return `Searching for "${clean(i.pattern, 50)}"${i.path ? ` in ${rel(i.path)}` : ""}`;
    case "Glob": return `Listing ${clean(i.pattern, 60)}${i.path ? ` in ${rel(i.path)}` : ""}`;
    case "Agent": return `Asking the explorer: ${clean(i.description, 80)}`;
    case "mcp__items__item": return `Looking up ${itemRef(i)}`;
    case "mcp__items__similar_items": return `Looking for items similar to ${itemRef(i)}`;
    case "mcp__items__search_items": return `Searching items for "${clean(i.query, 50)}"`;
    case "mcp__items__pr_diff": return `Reading the diff of ${itemRef(i)}`;
    default: return null;
  }
}

/** The last progress line of one stream-json output line, or null. @param {string} raw */
export function claudeProgress(raw) {
  if (!raw.startsWith("{")) return null;
  try {
    const e = JSON.parse(raw);
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) return null;
    const prefix = typeof e.parent_tool_use_id === "string" ? "Explorer: " : "";
    let last = null;
    for (const b of e.message.content) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      const l = toolLine(b.name, b.input);
      if (l) last = (prefix + l).slice(0, 120);
    }
    return last;
  } catch { return null; }
}

const MOUNT_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/;
/** Paths the sandbox itself uses; a bundle mount may not sit on or under them. */
const FIXED_PATHS = ["/usr", "/lib", "/lib64", "/bin", "/etc", "/proc", "/dev", "/tmp", "/home", "/work", "/opt", "/mcp.json", "/agents.json", "/codex-home"];

/** Throws unless `p` is a safe absolute mount point inside the sandbox. @param {string} p */
export function checkMountPath(p) {
  if (!MOUNT_PATH.test(p) || p.split("/").some((c) => c === "..") || p === "/" || FIXED_PATHS.some((f) => p === f || p.startsWith(`${f}/`))) throw new Error(`unsafe mount path: ${p}`);
  return p;
}

const SANDBOX_HOME = "/home/sandbox";
const SANDBOX_CONFIG = `${SANDBOX_HOME}/.claude`;
const SANDBOX_CLAUDE = "/opt/claude/claude";
const WORK_PATH = "/work";
export const BWRAP = "/usr/bin/bwrap";

/**
 * The bwrap command for `claude`, the same sandbox as src/sandbox/command.ts `sandboxCommand`: fixed
 * paths, empty home, the binary read-only, every mount read-only, network shared, everything else a new
 * namespace. `env` is the process's whole environment; the token is only there, never in `args`.
 * Every `--add-dir` the arguments name exists, empty when nothing is mounted there.
 * @param {{ claudeBin: string, oauthToken?: string, claudeArgs: string[], mounts: { host: string, path: string }[], agentsFile?: string, mcpFile?: string, sessionDir?: string }} s
 */
export function claudeSandbox(s) {
  const mounts = s.mounts.map((m) => ({ host: m.host, path: checkMountPath(m.path) }));
  const addDirs = s.claudeArgs.flatMap((a, i) => (a === "--add-dir" && s.claudeArgs[i + 1] ? [s.claudeArgs[i + 1]] : []));
  const empty = addDirs.filter((d) => !mounts.some((m) => m.path === d)).map(checkMountPath);
  // Parents of nested mounts (`/repos` for `/repos/<name>`) exist even when the arguments do not name them.
  const parents = [...new Set(mounts.map((m) => dirname(m.path)).filter((d) => d !== "/" && !mounts.some((m) => m.path === d)))];
  const env = { HOME: SANDBOX_HOME, CLAUDE_CONFIG_DIR: SANDBOX_CONFIG, PATH: "/usr/bin", LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1" };
  const repo = mounts.filter((m) => m.path === "/repo"), rest = mounts.filter((m) => m.path !== "/repo");
  const args = [
    "--unshare-all", "--share-net", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
    "--ro-bind", "/etc/ssl", "/etc/ssl", "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--tmpfs", SANDBOX_HOME, "--tmpfs", SANDBOX_CONFIG,
    ...(s.sessionDir ? ["--bind", s.sessionDir, `${SANDBOX_CONFIG}/projects`] : []),
    "--ro-bind", s.claudeBin, SANDBOX_CLAUDE,
    "--tmpfs", WORK_PATH,
    ...repo.flatMap((m) => ["--ro-bind", m.host, m.path]),
    ...[...new Set([...empty, ...parents])].flatMap((d) => ["--dir", d]),
    ...rest.flatMap((m) => ["--ro-bind", m.host, m.path]),
    ...(s.agentsFile ? ["--ro-bind", s.agentsFile, "/agents.json"] : []),
    ...(s.mcpFile ? ["--ro-bind", s.mcpFile, "/mcp.json"] : []),
    "--chdir", WORK_PATH,
    SANDBOX_CLAUDE, ...s.claudeArgs,
  ];
  return { cmd: BWRAP, args, env: { ...env, ...(s.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: s.oauthToken } : {}) } };
}

/** The MCP config for the lease's servers: each a streamable HTTP server on our dashboard, authorized by the lease secret. */
export function mcpConfig(/** @type {string} */ server, /** @type {string[]} */ names, /** @type {string} */ secret) {
  return { mcpServers: Object.fromEntries(names.map((n) => [n, { type: "http", url: `${server}${ROUTES.mcp}/${n}`, headers: { Authorization: `Bearer ${secret}` } }])) };
}

/** Negative when version `a` is older than `b` (dotted numbers). */
export function compareVersions(/** @type {string} */ a, /** @type {string} */ b) {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0), pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** @param {Usage | undefined} u */
const tokensOf = (u) => (u ? u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0);
/** @param {number} n */
const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// ---------------------------------------------------------------------------
// The Claude Code adapter.

/** @param {Config} cfg */
function resolveClaudeBin(cfg) {
  const given = process.env.AUTOCRAFT_RUNNER_CLAUDE_BIN || process.env.AUTOCRAFT_TASK_CLAUDE_BIN || cfg.claudeBin;
  const candidates = given ? [given] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "claude"));
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); return realpathSync(c); } catch { /* next */ }
  }
  return null;
}

/** MCP server states of Claude Code's init event under which the server's tools are, or will be, there. */
const CLAUDE_MCP_UP = new Set(["connected", "pending"]);

/**
 * A `claude` stream-json init event that lacks one of the call's MCP servers: the reason, or null. Claude Code drops a
 * server it cannot load (a reserved name, a failed connection) and runs on without its tools, so the run is stopped here
 * rather than left to answer without them.
 * @param {string} raw @param {string[]} servers
 */
export function claudeMcpProblem(raw, servers) {
  if (!servers.length || !raw.startsWith('{"type":"system"')) return null;
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (e?.type !== "system" || e.subtype !== "init" || !Array.isArray(e.mcp_servers)) return null;
  for (const n of servers) {
    const status = e.mcp_servers.find((/** @type {any} */ m) => m?.name === n)?.status;
    if (!CLAUDE_MCP_UP.has(status)) return `the harness has no ${n} tools: MCP server ${n} ${typeof status === "string" ? clean(status, 30) : "was not loaded"}`;
  }
  return null;
}

/** @param {string[]} args @param {string} sessionId */
const claudeResume = (args, sessionId) => [...withoutResume(args), "--resume", sessionId];

/** @type {Adapter} */
const claudeAdapter = {
  id: "claude",
  token: (cfg) => claudeCredential(cfg)?.claudeAiOauth?.accessToken ?? (cfg.claudeConfigDir || cfg.claudeAuth === "keychain" ? undefined : cfg.claudeToken),
  tokenFor(cfg, timeoutSeconds) {
    if (process.platform === "darwin" && cfg.claudeConfigDir) return { problem: CLAUDE_CONFIG_DIR_MACOS };
    if (cfg.claudeAuth === "keychain") {
      const creds = claudeCredential(cfg);
      return creds ? claudeLoginToken(creds, timeoutSeconds) : { problem: "no Claude Code login in the Keychain: sign in to Claude Code, or store a setup-token" };
    }
    if (!cfg.claudeConfigDir) return cfg.claudeToken ? { token: cfg.claudeToken } : { problem: "no Claude token stored" };
    return claudeLoginToken(readClaudeCredentials(cfg.claudeConfigDir), timeoutSeconds);
  },
  loginRoom: (cfg) => claudeLoginRoom(claudeCredential(cfg)),
  defaultTiers: { top: "opus", mid: "sonnet", small: "haiku" },
  maxEffort: "max",
  detect(cfg) {
    const bin = resolveClaudeBin(cfg);
    let version = null;
    if (bin) {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin", HOME: homedir(), DISABLE_AUTOUPDATER: "1" } });
      version = r.status === 0 ? (r.stdout.trim().split(/\s+/)[0] || null) : null;
    }
    return { bin, version, loggedIn: !!this.token(cfg) };
  },
  command(t) {
    const hint = t.bundle.hints.claude;
    if (!hint) throw new Error("the bundle has no claude arguments");
    let args = withoutResume(withModel(hint.args, t.model));
    if (t.resumeId) args = claudeResume(args, t.resumeId);
    // macOS: the session store is the whole config directory (a resume finds its session there); otherwise one under tmp/.
    if (t.mac) return macCommand({ profile: t.mac.profile, root: t.mac.root, argv: [...t.mac.install.argv, ...args], env: { CLAUDE_CONFIG_DIR: t.sessionDir ?? `${t.mac.root}/tmp/home/.claude`, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_OAUTH_TOKEN: t.token } });
    const agentsFile = hint.agents !== undefined ? join(t.taskDir, "agents.json") : undefined;
    if (agentsFile) writeFileSync(agentsFile, hint.agents ?? "", { mode: 0o600 });
    return claudeSandbox({ claudeBin: t.bin, oauthToken: t.token, claudeArgs: args, mounts: t.mounts, agentsFile, mcpFile: t.mcpFile || undefined, sessionDir: t.sessionDir });
  },
  parse: parseClaudeOutput,
  guard: claudeMcpProblem,
  tools: claudeTools,
  compact: claudeCompact,
  resume: (args, sessionId) => claudeResume(args, sessionId),
  progress: claudeProgress,
  versionInSandbox: (bin) => claudeSandbox({ claudeBin: bin, claudeArgs: ["--version"], mounts: [] }),
  install: (bin) => macInstall(bin, nodeOnPath()),
};

// ---------------------------------------------------------------------------
// Read-only file tools, for a harness whose own read tool can't be confined to the task (Codex: its shell would see
// everything in the sandbox, its login included). The helper process serves them to that one run as a streamable
// HTTP MCP server on 127.0.0.1 with a per-run bearer token. Paths are sandbox paths (/repo/..., /repos/<name>/...);
// each resolves inside one prepared mount and never past it: symlinks are resolved and checked, and grep walks
// without following them.

const FILE_TOOLS_SERVER = "files";
const READ_LINES = 2000;
const READ_MAX_BYTES = 256 * 1024;
const GREP_MAX_LINES = 200;
const GLOB_MAX = 500;
const LINE_MAX = 300;

const FILE_TOOLS = [
  { name: "read_file", description: "Reads a text file: numbered lines, at most 2000 from `offset` (1-based).", inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute path of a file in a directory the prompt names" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: READ_LINES } }, required: ["path"] } },
  { name: "grep", description: "Searches files under a directory for an extended regular expression; prints path:line:text, at most 200 lines.", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "Directory or file; default the repository" }, glob: { type: "string", description: "Only file names matching this, e.g. *.rs" }, ignore_case: { type: "boolean" } }, required: ["pattern"] } },
  { name: "glob", description: "Lists files whose path below `path` matches a glob (** any depth, * and ? within a name), at most 500.", inputSchema: { type: "object", properties: { pattern: { type: "string", description: "e.g. **/*.rs" }, path: { type: "string", description: "Directory; default the repository" } }, required: ["pattern"] } },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

/**
 * The host path of a sandbox path inside one of the mounts, symlinks resolved; throws when the path is outside every
 * mount or resolves outside its mount.
 * @param {{ host: string, path: string }[]} mounts @param {unknown} p
 */
export function hostPath(mounts, p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) throw new Error("path must be an absolute path such as /repo/src/main.rs");
  const parts = p.split("/").filter((c) => c && c !== ".");
  if (parts.includes("..")) throw new Error("path may not contain ..");
  const norm = `/${parts.join("/")}`;
  const m = [...mounts].sort((a, b) => b.path.length - a.path.length).find((x) => norm === x.path || norm.startsWith(`${x.path}/`));
  if (!m) throw new Error(`no such path: ${norm} (readable: ${mounts.map((x) => x.path).join(", ")})`);
  const root = realpathSync(m.host);
  let real;
  try { real = realpathSync(join(m.host, norm.slice(m.path.length))); } catch { throw new Error(`no such file: ${norm}`); }
  if (real !== root && !real.startsWith(`${root}/`)) throw new Error(`${norm} points outside ${m.path}`);
  return { real, root, mount: m };
}

/** A glob over `/`-separated relative paths as a RegExp: `**` any depth, `*` and `?` within one name. @param {string} g */
export function globRegex(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Files below `dir` (relative paths), not following symlinks, at most `max`. @param {string} dir @param {number} max */
function walkFiles(dir, max) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    if (out.length >= max) return;
    let entries;
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== ".git") walk(r); }
      else if (e.isFile()) out.push(r);
      if (out.length >= max) return;
    }
  };
  walk("");
  return out;
}

/** The item's checkout, where a search without a path looks: /repo, or <root>/repo on macOS. @param {{ path: string }[]} mounts */
const defaultPath = (mounts) => mounts.map((m) => m.path).filter((p) => p === "/repo" || p.endsWith("/repo")).sort((a, b) => a.length - b.length)[0] ?? "/repo";

/** The sandbox path of a host path below a mount. @param {{ path: string }} mount @param {string} root @param {string} host */
const sandboxPathOf = (mount, root, host) => (host === root ? mount.path : `${mount.path}${host.slice(root.length)}`);

/**
 * Runs one file tool; the text it returns, or throws with a message for the model.
 * @param {{ host: string, path: string }[]} mounts @param {string} name @param {Record<string, unknown>} a
 */
export function runFileTool(mounts, name, a) {
  const cut = (/** @type {string} */ l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l);
  if (name === "read_file") {
    const { real } = hostPath(mounts, a.path);
    if (!statSync(real).isFile()) throw new Error(`${a.path} is not a file`);
    const buf = readFileSync(real);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${a.path} is a binary file`);
    const lines = buf.subarray(0, READ_MAX_BYTES * 8).toString("utf8").split("\n");
    const from = Math.max(1, Number.isInteger(a.offset) ? Number(a.offset) : 1), n = Math.min(READ_LINES, Number.isInteger(a.limit) ? Number(a.limit) : READ_LINES);
    let out = "", i = from;
    for (; i < from + n && i <= lines.length; i++) {
      const l = `${String(i).padStart(6)}\t${cut(lines[i - 1] ?? "")}\n`;
      if (out.length + l.length > READ_MAX_BYTES) break;
      out += l;
    }
    return out + (i <= lines.length ? `(${lines.length} lines; continue with offset ${i})\n` : "");
  }
  if (name === "glob") {
    if (typeof a.pattern !== "string" || !a.pattern) throw new Error("pattern is required");
    const { real, root, mount } = hostPath(mounts, a.path ?? defaultPath(mounts));
    const re = globRegex(a.pattern);
    const base = sandboxPathOf(mount, root, real);
    const hits = walkFiles(real, 50_000).filter((r) => re.test(r));
    return hits.length ? hits.slice(0, GLOB_MAX).map((r) => `${base}/${r}`).join("\n") + (hits.length > GLOB_MAX ? `\n(${hits.length} files; narrow the pattern)` : "") : "no files match";
  }
  if (name === "grep") {
    if (typeof a.pattern !== "string" || !a.pattern) throw new Error("pattern is required");
    const { real, root, mount } = hostPath(mounts, a.path ?? defaultPath(mounts));
    const args = ["-rnIE", "--exclude-dir=.git", ...(a.ignore_case === true ? ["-i"] : []), ...(typeof a.glob === "string" && a.glob ? [`--include=${a.glob}`] : []), "-e", a.pattern, "--", real];
    const r = spawnSync("grep", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C.UTF-8" } });
    if (r.error) throw new Error(`grep failed: ${r.error.message.includes("ETIMEDOUT") ? "timed out" : r.error.message}`);
    if (r.status === 2) throw new Error(`grep: ${(r.stderr ?? "").replaceAll(root, mount.path).trim().slice(0, 300)}`);
    const lines = (r.stdout ?? "").split("\n").filter(Boolean);
    if (!lines.length) return "no matches";
    const shown = lines.slice(0, GREP_MAX_LINES).map((l) => cut(l.startsWith(root) ? sandboxPathOf(mount, root, l.slice(0, root.length)) + l.slice(root.length) : l));
    return shown.join("\n") + (lines.length > GREP_MAX_LINES ? `\n(${lines.length} matching lines; narrow the pattern or path)` : "");
  }
  throw new Error(`unknown tool ${name}`);
}

/**
 * One JSON-RPC message to the file tools' MCP server: the reply, or null for a notification.
 * @param {{ host: string, path: string }[]} mounts @param {any} m
 */
export function fileToolsMessage(mounts, m) {
  if (!m || typeof m !== "object" || typeof m.method !== "string") return m?.id !== undefined ? { jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "invalid request" } } : null;
  if (m.id === undefined) return null;
  const ok = (/** @type {unknown} */ result) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": return ok({ protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: FILE_TOOLS_SERVER, version: HELPER_VERSION } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: FILE_TOOLS });
    case "tools/call": {
      const name = m.params?.name, args = m.params?.arguments && typeof m.params.arguments === "object" ? m.params.arguments : {};
      try { return ok({ content: [{ type: "text", text: runFileTool(mounts, String(name), args) }] }); }
      catch (e) { return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true }); }
    }
    default: return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method ${m.method} not found` } };
  }
}

/**
 * Serves the file tools for one run on 127.0.0.1; `close` stops it.
 * @param {{ host: string, path: string }[]} mounts @returns {Promise<{ url: string, token: string, close: () => void }>}
 */
function serveFileTools(mounts) {
  const token = randomBytes(24).toString("hex");
  const want = Buffer.from(`Bearer ${token}`);
  const server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== want.length || !timingSafeEqual(auth, want)) { res.writeHead(401).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const replies = (Array.isArray(m) ? m : [m]).map((x) => fileToolsMessage(mounts, x)).filter((x) => x !== null);
      if (!replies.length) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Array.isArray(m) ? replies : replies[0]));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      const port = a && typeof a === "object" ? a.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, token, close: () => server.close() });
    });
  });
}

// ---------------------------------------------------------------------------
// The Codex adapter. What it relies on, from the Codex CLI source at tag rust-v0.170.0
// (github.com/openai/codex, paths under codex-rs/) and its docs (non-interactive mode, auth):
// - `codex exec` flags --json, --color, --skip-git-repo-check, --ignore-user-config, --ignore-rules, --ephemeral, -C, the
//   prompt from stdin with `-`, and `exec resume <id>` taking the same flags: exec/src/cli.rs. Exec always runs with the
//   approval policy "never": exec/src/lib.rs. A resume id that matches no thread starts a new one, so only the thread
//   UUID the first run reported is passed.
// - JSONL events thread.started {thread_id}, item.started/item.completed {item: agent_message | mcp_tool_call | error |
//   ...}, turn.completed {usage}, turn.failed {error}, error: exec/src/exec_events.rs. Usage is the thread total;
//   input_tokens includes cached_input_tokens and output_tokens includes reasoning: exec/src/event_processor_with_jsonl_output.rs,
//   protocol/src/protocol.rs (TokenUsage). No event names the model except an error item "model rerouted: A -> B (...)",
//   so the reply reports the configured model, or the model it was rerouted to.
// - `-c key=value` values are TOML (utils/cli/src/config_override.rs) and keys split at every "." (config/src/overrides.rs):
//   tables go in as inline tables. Keys used: model, model_reasoning_effort (protocol/src/openai_models.rs),
//   developer_instructions, project_doc_max_bytes, web_search, agents, features, cli_auth_credentials_store,
//   shell_environment_policy, default_permissions, permissions, mcp_servers: config/src/config_toml.rs, features/src/lib.rs.
// - MCP: streamable HTTP servers with url and bearer_token_env_var (an inline bearer_token is refused);
//   default_tools_approval_mode = "approve" lets exec call their tools under approval "never": config/src/mcp_types.rs,
//   core/src/mcp_tool_call.rs. The model sees them as mcp__<server>__<tool>: codex-mcp/src/tools.rs.
// - The credential. Codex's own sandbox does not keep the model's shell commands away from CODEX_HOME on Linux:
//   read-only mode grants read on the whole root (protocol/src/permissions.rs:597-604, read_only_file_system_entries),
//   Codex adds CODEX_HOME to the sandbox policy only on Windows (sandboxing/src/manager.rs:726-760), and nothing in
//   linux-sandbox/src names CODEX_HOME or auth.json. A permission profile with a "deny" entry would mask it, but when
//   Codex cannot mount a fresh /proc it silently keeps the outer one (linux-sandbox/src/linux_run_main.rs:395-415,
//   run_bwrap_with_proc_fallback), and /proc/<codex pid>/root then reaches CODEX_HOME past the entry. So the shell is
//   turned off (features shell_tool and unified_exec: core/src/tools/spec_plan.rs:1289-1296, add_shell_tools), with the
//   other built-in tools that act outside the task (browser, computer use, apps, plugins, hooks, image generation,
//   subagents, web search), and the model reads through the helper's file tools above, which the codex process reaches
//   over HTTP. What is left reads through Codex's sandbox (view_image: core/src/tools/handlers/view_image.rs), which a
//   permission profile extending ":read-only" (no writes, no network: protocol/src/models.rs:494-500) with CODEX_HOME
//   denied confines: config/src/permissions_toml.rs:113-119, exec/tests/suite/seatbelt.rs:305-311. `--sandbox` is never
//   passed, as it would replace the profile (config/src/permission_config.rs:46-48). shell_environment_policy sets the
//   whole environment of any command (protocol/src/shell_environment.rs, populate_env), so no secret from the codex
//   process's environment reaches one.
// - The login. A separate CODEX_HOME is a separate login with its own refresh token. Refresh tokens rotate with reuse
//   detection, Codex writes the new tokens back to auth.json, and two processes refreshing one auth.json race
//   (login/src/auth/manager.rs, login/src/auth/storage.rs). So the helper keeps its own CODEX_HOME (`harness codex` runs
//   `codex login` in it), binds it writable, never copies the user's ~/.codex, and runs one Codex call at a time.
// - Instructions and config. $CODEX_HOME/AGENTS.md (or AGENTS.override.md) and $CODEX_HOME/.env are read even with
//   --ignore-user-config (codex-home/src/instructions/mod.rs, arg0/src/lib.rs), so the helper removes them, and any config.toml, from its home;
//   project_doc_max_bytes = 0 turns off AGENTS.md from the working directory (core/src/agents_md.rs); /etc/codex is not
//   in the sandbox.
// - Audited versions only. The confinement above rests on the built-in tools of the versions in CODEX_AUDITED; earlier
//   versions had model-gated file tools (read_file, list_dir, grep_files) that read in the codex process. In 0.170
//   no such handler exists (core/src/tools/handlers/), and experimental_supported_tools, which comes with the model
//   catalogue and can't be set by -c, gates only web search's literature search (ext/web-search/src/extension.rs:157-161).
//   Any other version is refused, and every run is checked twice: the --json stream stops the run at the first tool
//   item other than an MCP call to the call's own servers; it does not show every tool (view_image, dynamic and
//   extension tools map to nothing: exec/src/event_processor_with_jsonl_output.rs:144-324), so after the run the
//   thread's rollout ($CODEX_HOME/sessions/.../rollout-*-<thread>.jsonl, every model tool call as a response_item:
//   history/src/rollout_payload.rs, protocol/src/models.rs ResponseItem) must hold no call but those MCP tools and
//   view_image. A missing rollout fails the call too. Either way the reply is not submitted.
// - view_image stays: with a profile that lacks full read access its reads go through Codex's sandboxed filesystem
//   helper (exec-server/src/local_file_system.rs:91, file-system/src/lib.rs:395), and bytes that are not an image are
//   refused before they reach the model (core/src/tools/handlers/view_image.rs:178), so even the /proc fallback above
//   cannot turn it into a text reader.
// Codex has no turn limit: the bundle's wall-clock limit bounds the call.

const SANDBOX_CODEX = "/opt/codex/codex";
const CODEX_HOME_PATH = "/codex-home";
const CODEX_PROFILE = "autocraft";
const LEASE_ENV = "AUTOCRAFT_RUNNER_LEASE_SECRET";
const FILES_ENV = "AUTOCRAFT_RUNNER_FILES_TOKEN";
/** Files Codex reads from CODEX_HOME whatever the flags say. */
const CODEX_HOME_INSTRUCTIONS = ["AGENTS.md", "AGENTS.override.md", ".env", "config.toml"];
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Codex versions (major.minor) whose built-in tools were audited for the confinement above. */
export const CODEX_AUDITED = ["0.170"];
/** Rollout item types that are model tool calls (protocol/src/models.rs ResponseItem). */
const CODEX_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call", "tool_search_call", "web_search_call", "image_generation_call"]);

/** Why a Codex version may not run calls, or null. @param {string} version */
export function codexUnaudited(version) {
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  if (m && CODEX_AUDITED.includes(`${Number(m[1])}.${Number(m[2])}`)) return null;
  return `codex ${version} is not a version this helper has audited (${CODEX_AUDITED.map((v) => `${v}.x`).join(", ")}): its built-in tools may read past the task's files. Install an audited version or update the helper.`;
}

/** The MCP servers a Codex call may call: the helper's file tools and the bundle's. @param {string[]} servers */
const allowedServers = (servers) => new Set([FILE_TOOLS_SERVER, ...servers]);

/** A `codex exec --json` line that shows a tool the call may not use: the reason, or null. @param {string} raw @param {string[]} servers */
export function codexStreamProblem(raw, servers) {
  if (!raw.startsWith("{")) return null;
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!["item.started", "item.updated", "item.completed"].includes(e?.type)) return null;
  const i = e.item ?? {};
  if (["agent_message", "reasoning", "error"].includes(i.type)) return null;
  if (i.type === "mcp_tool_call" && allowedServers(servers).has(i.server)) return null;
  return `unexpected tool: ${clean(i.type === "mcp_tool_call" ? `MCP server ${i.server}` : i.type, 60)}`;
}

/** The tool name of a rollout call: namespace and name joined as the model saw it (core/src/tools/mod.rs flat_tool_name). @param {any} p */
const flatName = (p) => {
  const name = typeof p.name === "string" ? p.name : "", ns = typeof p.namespace === "string" ? p.namespace : "";
  return !ns ? name : ns.endsWith("__") ? `${ns}${name}` : `${ns}__${name}`;
};

/** A rollout's first tool call the call may not use: the reason, or null. @param {string} text @param {string[]} servers */
export function codexRolloutProblem(text, servers) {
  const ok = allowedServers(servers);
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e?.type === "response_item" ? e.payload : null;
    if (!p || !CODEX_CALLS.has(p.type)) continue;
    const name = p.type === "function_call" ? flatName(p) : "";
    const mcp = /^mcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_]+$/.exec(name);
    if (name === "view_image" || (mcp && ok.has(mcp[1]))) continue;
    return `unexpected tool: ${clean(name || p.type, 80)}`;
  }
  return null;
}

/** The helper's file tools as the item page names them for Claude: Read, Grep, Glob with Claude's argument names. @param {string} name @param {any} a */
function codexToolName(name, a) {
  if (name === `mcp__${FILE_TOOLS_SERVER}__read_file`) return { name: "Read", input: { file_path: a?.path } };
  if (name === `mcp__${FILE_TOOLS_SERVER}__grep`) return { name: "Grep", input: { pattern: a?.pattern, path: a?.path } };
  if (name === `mcp__${FILE_TOOLS_SERVER}__glob`) return { name: "Glob", input: { pattern: a?.pattern, path: a?.path } };
  return { name, input: a };
}

/**
 * The tool uses a Codex rollout records, in order and paired with their outputs by call id, timed by the rollout's
 * line timestamps. An MCP result's isError comes from its content.
 * @param {string} text
 * @returns {SubmitTool[]}
 */
export function codexRolloutTools(text) {
  /** @type {Map<string, SubmitTool>} */
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e?.type === "response_item" ? e.payload : null;
    if (!p || typeof p.call_id !== "string") continue;
    const at = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (CODEX_CALLS.has(p.type) && byId.size < MAX_TOOLS) {
      let a = p.arguments ?? p.input ?? p.action ?? null;
      if (typeof a === "string") { try { a = JSON.parse(a); } catch { /* raw text input */ } }
      const t = codexToolName(p.type === "function_call" ? flatName(p) : p.type, a);
      byId.set(p.call_id, { name: t.name.slice(0, 100), args: toolArgs(t.input), resultBytes: null, isError: false, ...(at && { startedAt: at }) });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const u = byId.get(p.call_id);
      if (!u) continue;
      const out = p.output;
      let parsed = out;
      if (typeof out === "string") { try { parsed = JSON.parse(out); } catch { parsed = out; } }
      u.resultBytes = resultSize(typeof out === "string" ? out : out?.content ?? out);
      u.isError = parsed?.isError === true || parsed?.success === false || out?.success === false;
      if (at) u.endedAt = at;
    }
  }
  return [...byId.values()];
}

/** Files below `dir`, recursively (no symlinks followed). @param {string} dir @returns {string[]} */
function filesBelow(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesBelow(p)); else if (e.isFile()) out.push(p);
  }
  return out;
}
/** Built-in Codex features turned off: the shell, and every tool that reaches past the task directory or the call's MCP servers. */
const CODEX_FEATURES_OFF = ["shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "computer_use", "apps", "plugins", "remote_plugin", "tool_suggest", "skill_search", "skill_mcp_dependency_install", "hooks", "image_generation", "multi_agent", "goals", "workspace_dependencies"];

/** A TOML basic string: JSON's escapes are TOML's, except that TOML also forbids a raw DEL. @param {string} v */
const toml = (v) => JSON.stringify(v).replace(/\u007f/g, "\\u007F");

const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];
/** The effort passed to a harness: `effort`, or the harness's highest level when that is lower. @param {string} effort @param {string} max */
export const harnessEffort = (effort, max) => (EFFORT_LADDER.indexOf(effort) > EFFORT_LADDER.indexOf(max) ? max : effort);

/**
 * `codex` arguments for one call: exec (or exec resume) reading the prompt on stdin, the model and effort, no shell,
 * the call's MCP servers on our dashboard and the helper's file tools (tokens from the environment), and none of the
 * user's config or instructions.
 * `paths`: where the run's working directory, home and Codex home are (macOS: in the slot and the helper's Codex home);
 * the bwrap paths by default.
 * @param {{ model: string, effort: string, system: string | null, server: string, servers: string[], files: string, keepSession: boolean, resumeId?: string, toolTimeoutSec: number, paths?: { work: string, home: string, codexHome: string } }} o
 */
export function codexArgs(o) {
  const paths = o.paths ?? { work: WORK_PATH, home: SANDBOX_HOME, codexHome: CODEX_HOME_PATH };
  if (o.resumeId !== undefined && !THREAD_ID.test(o.resumeId)) throw new Error(`not a Codex thread id: ${o.resumeId}`);
  const http = (/** @type {string} */ name, /** @type {string} */ url, /** @type {string} */ env, /** @type {number} */ timeout) =>
    `${name}={url=${toml(url)}, bearer_token_env_var="${env}", default_tools_approval_mode="approve", startup_timeout_sec=30, tool_timeout_sec=${timeout}}`;
  const mcp = o.servers.map((n) => {
    if (!NAME.test(n) || n.includes(".") || n === FILE_TOOLS_SERVER) throw new Error(`bad MCP server name ${n}`);
    return http(n, `${o.server}${ROUTES.mcp}/${n}`, LEASE_ENV, Math.max(60, Math.round(o.toolTimeoutSec)));
  });
  return ["exec", "--json", "--color", "never", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-C", paths.work,
    "-c", `model=${toml(o.model)}`, "-c", `model_reasoning_effort=${toml(o.effort)}`,
    "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"', "-c", "agents={enabled=false}", "-c", 'cli_auth_credentials_store="file"',
    "-c", `features={${CODEX_FEATURES_OFF.map((f) => `${f}=false`).join(", ")}}`,
    "-c", `shell_environment_policy={inherit="none", set={PATH="/usr/bin", HOME=${toml(paths.home)}, LANG="C.UTF-8"}}`,
    "-c", `default_permissions="${CODEX_PROFILE}"`,
    "-c", `permissions={${CODEX_PROFILE}={extends=":read-only", filesystem={${toml(paths.codexHome)}="deny"}}}`,
    "-c", `mcp_servers={${[http(FILE_TOOLS_SERVER, o.files, FILES_ENV, 60), ...mcp].join(", ")}}`,
    ...(o.system ? ["-c", `developer_instructions=${toml(o.system)}`] : []),
    ...(o.resumeId ? ["resume", o.resumeId] : []),
    "-"];
}

/**
 * The bwrap command for `codex`: the same outer sandbox as `claudeSandbox` (fixed paths, empty home, the binary
 * read-only, every mount read-only, network shared), with the helper's CODEX_HOME bound writable at /codex-home so
 * Codex can refresh its login and keep sessions. Tokens are only in `env`, never in `args`.
 * @param {{ codexBin: string, codexHome: string, codexArgs: string[], mounts: { host: string, path: string }[], env?: Record<string, string> }} s
 */
export function codexSandbox(s) {
  const mounts = s.mounts.map((m) => ({ host: m.host, path: checkMountPath(m.path) }));
  const parents = [...new Set(mounts.map((m) => dirname(m.path)).filter((d) => d !== "/" && !mounts.some((m) => m.path === d)))];
  const repo = mounts.filter((m) => m.path === "/repo"), rest = mounts.filter((m) => m.path !== "/repo");
  const args = [
    "--unshare-all", "--share-net", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
    "--ro-bind", "/etc/ssl", "/etc/ssl", "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--tmpfs", SANDBOX_HOME,
    "--bind", s.codexHome, CODEX_HOME_PATH,
    "--ro-bind", s.codexBin, SANDBOX_CODEX,
    "--tmpfs", WORK_PATH,
    ...repo.flatMap((m) => ["--ro-bind", m.host, m.path]),
    ...parents.flatMap((d) => ["--dir", d]),
    ...rest.flatMap((m) => ["--ro-bind", m.host, m.path]),
    "--chdir", WORK_PATH,
    SANDBOX_CODEX, ...s.codexArgs,
  ];
  return { cmd: BWRAP, args, env: { HOME: SANDBOX_HOME, CODEX_HOME: CODEX_HOME_PATH, PATH: "/usr/bin", LANG: "C.UTF-8", ...s.env } };
}

/** @param {unknown} u @returns {Usage | undefined} */
function codexUsage(u) {
  if (!u || typeof u !== "object") return undefined;
  const x = /** @type {Record<string, unknown>} */ (u);
  const n = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const cached = n(x.cached_input_tokens);
  return { inputTokens: Math.max(0, n(x.input_tokens) - cached), outputTokens: n(x.output_tokens), cacheReadTokens: cached, cacheWriteTokens: n(x.cache_write_input_tokens) };
}

/**
 * Reads `codex exec --json` output: the last agent message of the completed turn, the usage it reported, the thread
 * id for a resume, the tool calls as turns, and the model (the configured one, or the one a reroute named).
 * @param {string} stdout @param {string} model the configured model
 * @returns {Reply}
 */
export function parseCodexOutput(stdout, model) {
  /** @type {any[]} */
  const evs = stdout.split("\n").filter((l) => l.startsWith("{")).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const sessionId = evs.find((e) => e?.type === "thread.started" && typeof e.thread_id === "string")?.thread_id;
  const items = evs.filter((e) => e?.type === "item.completed" && e.item && typeof e.item === "object").map((e) => e.item);
  const rerouted = items.map((i) => (i.type === "error" && typeof i.message === "string" ? /^model rerouted: \S+ -> (\S+)/.exec(i.message)?.[1] : undefined)).filter(Boolean).at(-1);
  const done = evs.findLast((e) => e?.type === "turn.completed");
  const failed = evs.findLast((e) => e?.type === "turn.failed" || e?.type === "error");
  const base = { model: rerouted ?? model, usage: codexUsage(done?.usage), ...(sessionId && { sessionId }) };
  if (!done) {
    const why = typeof failed?.error?.message === "string" ? failed.error.message : typeof failed?.message === "string" ? failed.message : "";
    return { ok: false, text: "", ...base, error: failed ? `model error ${why}`.trim().slice(0, 400) : evs.length ? "no result" : "unreadable output" };
  }
  const text = items.findLast((i) => i.type === "agent_message" && typeof i.text === "string")?.text;
  if (text === undefined) return { ok: false, text: "", ...base, error: "no reply message" };
  return { ok: true, text, ...base, turns: items.filter((i) => i.type === "mcp_tool_call").length + 1 };
}

/**
 * The part of one `codex exec --json` line that parseCodexOutput reads, or null: the thread, the turn's end or failure, and
 * each completed item's type, with an agent message's text and an error's message.
 * @param {string} line @returns {string | null}
 */
export function codexCompact(line) {
  if (!line.startsWith("{")) return null;
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  if (e?.type === "thread.started" || e?.type === "turn.completed" || e?.type === "turn.failed" || e?.type === "error") return line;
  const i = e?.type === "item.completed" && e.item && typeof e.item === "object" ? e.item : null;
  if (!i) return null;
  return JSON.stringify({ type: e.type, item: i.type === "agent_message" ? { type: i.type, text: i.text } : i.type === "error" ? { type: i.type, message: i.message } : { type: i.type } });
}

/** The progress line of one `codex exec --json` line, or null. @param {string} raw */
export function codexProgress(raw) {
  if (!raw.startsWith("{")) return null;
  try {
    const e = JSON.parse(raw);
    const i = e.type === "item.started" ? e.item : null;
    if (i?.type !== "mcp_tool_call" || typeof i.server !== "string" || typeof i.tool !== "string") return null;
    const a = i.arguments && typeof i.arguments === "object" ? i.arguments : {};
    if (i.server === FILE_TOOLS_SERVER) {
      if (i.tool === "read_file") return toolLine("Read", { file_path: a.path });
      if (i.tool === "grep") return toolLine("Grep", { pattern: a.pattern, path: a.path });
      if (i.tool === "glob") return toolLine("Glob", { pattern: a.pattern, path: a.path });
    }
    return toolLine(`mcp__${i.server}__${i.tool}`, a);
  } catch { return null; }
}

/** The native codex binary: given, or `codex` on PATH; the npm package's launcher script is followed to its vendored binary. @param {Config} cfg */
function resolveCodexBin(cfg) {
  const given = process.env.AUTOCRAFT_RUNNER_CODEX_BIN || process.env.AUTOCRAFT_TASK_CODEX_BIN || cfg.codexBin;
  const candidates = given ? [given] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "codex"));
  const mac = process.platform === "darwin";
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${mac ? "apple-darwin" : "unknown-linux-musl"}`;
  const pkgArch = `${mac ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  for (const c of candidates) {
    let p;
    try { accessSync(c, constants.X_OK); p = realpathSync(c); } catch { continue; }
    if (!isScript(p)) return p;
    // npm: <pkg>/bin/codex.js runs <platform pkg>/vendor/<triple>/bin/codex, or <pkg>/vendor/<triple>/bin/codex.
    const pkg = dirname(dirname(p));
    for (const v of [join(pkg, "node_modules", "@openai", `codex-${pkgArch}`, "vendor"), join(dirname(pkg), `codex-${pkgArch}`, "vendor"), join(pkg, "vendor")]) {
      const bin = join(v, triple, "bin", "codex");
      try { accessSync(bin, constants.X_OK); return realpathSync(bin); } catch { /* next */ }
    }
  }
  return null;
}

/** The helper's own Codex login and sessions: never the user's ~/.codex. */
const codexHome = () => join(configDir(), "codex-home");

/** @type {Adapter} */
const codexAdapter = {
  id: "codex",
  token: () => (existsSync(join(codexHome(), "auth.json")) ? codexHome() : undefined),
  // Codex model ids change often and the operators accept them by name: every tier's model comes from the config.
  defaultTiers: {},
  maxEffort: "xhigh",
  exclusive: true,
  fileTools: true,
  unaudited: codexUnaudited,
  guard: codexStreamProblem,
  verify({ token, sessionId, servers, keep }) {
    if (!sessionId || !THREAD_ID.test(sessionId)) return { problem: "unexpected tool: no thread id, so no record of the tools used" };
    const file = filesBelow(join(token, "sessions")).find((f) => f.endsWith(`-${sessionId}.jsonl`));
    if (!file) return { problem: "unexpected tool: no rollout, so no record of the tools used" };
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { return { problem: "unexpected tool: the rollout is unreadable" }; }
    // The rollout is the session: kept for a follow-up, else removed now.
    if (!keep) rmSync(file, { force: true });
    return { problem: codexRolloutProblem(text, servers), tools: codexRolloutTools(text) };
  },
  detect(cfg) {
    const bin = resolveCodexBin(cfg);
    let version = null;
    if (bin) {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin", HOME: homedir(), CODEX_HOME: codexHome() } });
      version = r.status === 0 ? (r.stdout.trim().split(/\s+/).at(-1) || null) : null;
    }
    return { bin, version, loggedIn: !!this.token(cfg) };
  },
  preflight(_bin, home) {
    for (const f of CODEX_HOME_INSTRUCTIONS) rmSync(join(home, f), { force: true });
    // Rollouts of sessions no follow-up can reach any more.
    for (const f of filesBelow(join(home, "sessions"))) {
      try { if (Date.now() - statSync(f).mtimeMs > SESSION_TTL_MS) rmSync(f, { force: true }); } catch { /* gone */ }
    }
    return null;
  },
  command(t) {
    if (!t.files) throw new Error("the file tools are not running");
    // macOS: Codex runs under the helper's profile only. Its shell is off, so it starts no command and never nests its own
    // seatbelt inside ours; its permission profile still denies its home to the tools that read through it (view_image).
    const paths = t.mac ? { work: `${t.mac.root}/work`, home: `${t.mac.root}/tmp/home`, codexHome: t.token } : undefined;
    const args = codexArgs({ model: t.model, effort: harnessEffort(t.bundle.effort, codexAdapter.maxEffort), system: t.bundle.system, server: t.lease.server, servers: t.bundle.mcpServers, files: t.files.url, keepSession: t.bundle.keepSession, ...(t.resumeId && { resumeId: t.resumeId }), toolTimeoutSec: t.bundle.timeoutSeconds, ...(paths && { paths }) });
    if (t.mac) return macCommand({ profile: t.mac.profile, root: t.mac.root, argv: [...t.mac.install.argv, ...args], env: { CODEX_HOME: t.token, [FILES_ENV]: t.files.token, ...(t.bundle.mcpServers.length && { [LEASE_ENV]: t.lease.secret }) } });
    return codexSandbox({ codexBin: t.bin, codexHome: t.token, codexArgs: args, mounts: t.mounts, env: { [FILES_ENV]: t.files.token, ...(t.bundle.mcpServers.length && { [LEASE_ENV]: t.lease.secret }) } });
  },
  parse: parseCodexOutput,
  resume: (args, sessionId) => {
    if (!THREAD_ID.test(sessionId)) throw new Error(`not a Codex thread id: ${sessionId}`);
    const out = args.slice(0, -1).filter((a, i, all) => a !== "resume" && all[i - 1] !== "resume");
    return [...out, "resume", sessionId, "-"];
  },
  progress: codexProgress,
  compact: codexCompact,
  versionInSandbox: (bin) => codexSandbox({ codexBin: bin, codexHome: codexHome(), codexArgs: ["--version"], mounts: [] }),
  install: (bin) => ({ argv: [bin], files: [bin], dirs: [dirname(bin)] }),
};

// ---------------------------------------------------------------------------
// macOS: sandbox-exec. Seatbelt confines paths but cannot remap them, so the sandbox paths live below one directory per
// parallel slot, the path root the claim names (protocol.ts Claim.root): the server words the bundle's text and claude
// arguments for it and reads the reply's paths back without it. The root is in the per-user cache directory
// (`getconf DARWIN_USER_CACHE_DIR`, /private/var/folders/...), which holds no account name, so the prompts the server
// stores and shows name none; and it is the same for every call of the slot, so prompt prefixes cache. A slot holds
//   repo/ repos/<name>/ repo-docs/   clonefile copies (`cp -c`) of the cached trees, kept while the next call needs the same tree
//   mcp.json agents.json             the call's MCP config and explorer definition
//   work/                            the harness's empty working directory
//   tmp/                             the only writable place besides the session store: HOME, the temp config, TMPDIR
// Copies, not symlinks into the tree cache: with copies the profile lets the harness read the slot and never the cache,
// which holds other calls' trees, private ones included; Claude Code checks its Read rules against a symlink's resolved
// path, which lies outside every --add-dir; and ripgrep (its Grep) does not follow the symlinks it meets under /repos. A
// symlink inside a tree is copied as a symlink, and Seatbelt checks the resolved path, so it reads nothing the profile denies.
// A follow-up turn runs in the slot that holds its session (the claim offers only that slot's sessions): the session's
// earlier turns name that slot's paths.
//
// The profile denies by default and allows the slot, the harness install, system libraries and frameworks, and the platform
// services a process needs to start and reach the network. Its rules follow Codex's seatbelt policies (github.com/openai/codex,
// codex-rs/sandboxing/src/seatbelt_base_policy.sbpl, seatbelt_network_policy.sbpl, seatbelt_read_only_platform_defaults.sbpl),
// which descend from Chrome's. Seatbelt applies the last rule that matches, so the named secrets (~/.ssh, ~/.aws, the
// Keychains, ~/.claude*, ~/.codex, the helper's own config and cache) are denied before the narrow allows; only those may
// re-open a path below them (a harness installed in ~/.claude/local, the helper's Codex home and session stores).

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAC_MAX_SLOTS = 16;

/** Platform files every process reads: libraries, frameworks, zoneinfo, certificates and configuration in /etc. */
const MAC_SYSTEM = ["/usr/lib", "/usr/share", "/usr/libexec", "/usr/bin", "/usr/sbin", "/bin", "/sbin", "/System/Library", "/System/Cryptexes", "/System/Volumes/Preboot/Cryptexes", "/System/iOSSupport", "/Library/Apple", "/Library/Preferences", "/Library/Filesystems/NetFSPlugins", "/private/etc", "/private/var/db"];
/** Software installed for all users (Homebrew, MacPorts, Nix): a Node-based harness and the libraries it links. Not Homebrew's etc or var, which may hold user data. */
const MAC_SOFTWARE = [...["/opt/homebrew", "/usr/local"].flatMap((p) => ["Cellar", "Caskroom", "opt", "lib", "libexec", "bin"].map((d) => `${p}/${d}`)), "/opt/local/lib", "/opt/local/libexec", "/opt/local/bin", "/nix/store"];
/** Code the loader maps. */
const MAC_EXEC = ["/usr/lib", "/System/Library", "/System/Cryptexes", "/System/Volumes/Preboot/Cryptexes", "/System/iOSSupport", "/Library/Apple"];
/** Mach services: directory and user lookups, logging, power, TLS trust, network configuration and DNS. */
const MAC_SERVICES = ["com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership", "com.apple.system.DirectoryService.libinfo_v1", "com.apple.bsd.dirhelper", "com.apple.secinitd",
  "com.apple.logd", "com.apple.logd.events", "com.apple.system.logger", "com.apple.diagnosticd", "com.apple.analyticsd", "com.apple.system.notification_center", "com.apple.PowerManagement.control",
  // TLS certificate checks of harnesses that use the system's trust store; the Keychain files themselves are denied.
  "com.apple.SecurityServer", "com.apple.trustd", "com.apple.trustd.agent", "com.apple.ocspd", "com.apple.networkd",
  "com.apple.SystemConfiguration.DNSConfiguration", "com.apple.SystemConfiguration.configd"];

/** An SBPL string literal. @param {string} s */
function sbStr(s) {
  if (!s.startsWith("/") || /[\u0000-\u001f\u007f]/.test(s)) throw new Error(`unsafe path for the sandbox profile: ${JSON.stringify(s)}`);
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}
/** A path filter: `subpath` for a directory, a regex for a name prefix (`~/.claude*`: the directory and ~/.claude.json). @param {string} p */
function sbPath(p) {
  if (!p.endsWith("*")) return `(subpath ${sbStr(p)})`;
  const base = p.slice(0, -1);
  sbStr(base);
  if (/["\\]/.test(base)) throw new Error(`unsafe path for the sandbox profile: ${JSON.stringify(p)}`);
  return `(regex #"^${base.replace(/[.^$|?*+()[\]{}]/g, "\\$&")}")`;
}

/** The secrets the profile names as denied (everything else in the home is denied by default). @param {string} home */
export const macDenied = (home) => [`${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`, `${home}/.netrc`, `${home}/Library/Keychains`, `${home}/.claude*`, `${home}/.codex`, `${home}/.config`, configDir(), cacheDir(), legacyConfigDir(), legacyCacheDir()];

/**
 * The sandbox-exec profile of one run. The slot (`ROOT`, read-only) and its temp directory (`TMP`, writable) come as
 * parameters (`-D ROOT=... -D TMP=...`); the other paths are written in.
 * @param {{ deny: string[], files?: string[], dirs?: string[], writes?: string[] }} p
 *   deny: paths (a trailing `*` for a name prefix) never readable or writable; files: single files to read and run (a native
 *   harness binary); dirs: directories to read and map code from (a harness package and the Node it runs on); writes:
 *   directories to read and write (the session store, the helper's Codex home)
 */
export function macProfile(p) {
  const list = (/** @type {string} */ rule, /** @type {string[]} */ filters) => (filters.length ? [`(${rule}\n  ${filters.join("\n  ")})`] : []);
  const files = p.files ?? [], dirs = p.dirs ?? [], writes = p.writes ?? [];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
    "(allow ipc-posix-sem)",
    '(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))',
    ...list("allow mach-lookup", MAC_SERVICES.map((s) => `(global-name ${JSON.stringify(s)})`)),
    '(allow system-mac-syscall (mac-policy-name "vnguard"))',
    '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
    "; devices",
    '(allow file-read* file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))',
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/autofs_nowait"))',
    '(allow file-read-data file-write-data file-test-existence (subpath "/dev/fd"))',
    '(allow file-read-metadata (literal "/dev"))',
    "; resolving the root, the standard symlinks and the parents of firmlinks",
    '(allow file-read* file-test-existence (literal "/"))',
    '(allow file-read-metadata file-test-existence (literal "/etc") (literal "/tmp") (literal "/var") (literal "/private") (literal "/System") (literal "/System/Volumes") (literal "/System/Volumes/Data") (literal "/Users") (subpath "/private/var"))',
    "; system files and software installed for all users",
    ...list("allow file-read* file-test-existence", [...MAC_SYSTEM, ...MAC_SOFTWARE].map((d) => `(subpath ${sbStr(d)})`)),
    ...list("allow file-map-executable", [...MAC_EXEC, ...MAC_SOFTWARE].map((d) => `(subpath ${sbStr(d)})`)),
    "; network: outbound only, DNS through mDNSResponder",
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-outbound (literal "/private/var/run/mDNSResponder") (literal "/private/var/run/syslog"))',
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "; secrets: denied before the allows below, the only rules that may re-open a path under them",
    ...list("deny file-read* file-write*", p.deny.map(sbPath)),
    "; the call: its slot read-only, the slot's temp directory writable",
    '(allow file-read* file-test-existence (subpath (param "ROOT")))',
    '(allow file-read* file-write* file-test-existence (subpath (param "TMP")))',
    // A harness may unpack native addons into its temp directory and load them.
    '(allow file-map-executable (subpath (param "TMP")))',
    "; the harness install, the session store and the helper's Codex home",
    ...list("allow file-read* file-test-existence file-map-executable", [...files.map((f) => `(literal ${sbStr(f)})`), ...dirs.map((d) => `(subpath ${sbStr(d)})`)]),
    ...list("allow file-read* file-write* file-test-existence", writes.map((d) => `(subpath ${sbStr(d)})`)),
    ...list("allow file-read-metadata file-test-existence", [...files, ...dirs, ...writes].map((x) => `(path-ancestors ${sbStr(x)})`)),
    "",
  ].join("\n");
}

/** Whether a file starts with `#!` (a script such as the npm `claude` or `codex` launcher). @param {string} p */
function isScript(p) {
  try { const fd = openSync(p, "r"); const b = Buffer.alloc(2); readSync(fd, b, 0, 2, 0); closeSync(fd); return b.toString("latin1") === "#!"; } catch { return false; }
}

/** The package directory of a file inside an npm package: the nearest parent with a package.json. @param {string} file */
function packageDir(file) {
  for (let d = dirname(file), i = 0; i < 8 && d !== dirname(d); d = dirname(d), i++) if (existsSync(join(d, "package.json"))) return d;
  return dirname(file);
}

/**
 * What runs a harness on macOS and what the profile lets it read: a native binary runs as itself; a Node script (an npm
 * install of claude) runs on the Node found on PATH, with its package and that Node's install readable.
 * @param {string} bin resolved harness binary @param {string | null} [node] resolved node binary
 * @returns {{ argv: string[], files: string[], dirs: string[] }}
 */
export function macInstall(bin, node = null) {
  if (!isScript(bin)) return { argv: [bin], files: [bin], dirs: [] };
  if (!node) throw new Error(`${bin} is a Node script and node was not found on PATH`);
  return { argv: [node, bin], files: [], dirs: [packageDir(bin), dirname(dirname(node))] };
}

/** The resolved `node` on PATH, or null. */
function nodeOnPath() {
  for (const d of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try { accessSync(join(d, "node"), constants.X_OK); return realpathSync(join(d, "node")); } catch { /* next */ }
  }
  return null;
}

/** The per-user cache directory of macOS, resolved (/private/var/folders/<..>/C). */
function darwinCacheDir() {
  const r = spawnSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8", timeout: 10_000 });
  const d = r.status === 0 ? r.stdout.trim() : "";
  if (!d) throw new Error("getconf DARWIN_USER_CACHE_DIR gave no directory");
  return realpathSync(d);
}
/** The directory the slots live in (macOS): <per-user cache>/autocraft-runner. */
const slotBase = () => privateDir(join(darwinCacheDir(), RUNNER_DIR));
/** @param {string} base @param {number} n */
export const slotRoot = (base, n) => `${base}/slot-${n}`;

/**
 * Takes slot `n`'s lock (a file naming a live process); the release function, or null when another run holds it. A harness
 * process group that a crashed holder left in the slot is stopped first.
 * @param {string} base @param {number} n
 */
function takeSlot(base, n) {
  const release = takeLockFile(`${slotRoot(base, n)}.lock`);
  if (release) stopOrphan(slotRoot(base, n));
  return release;
}

/** Waits `ms` without returning to the event loop (a sync caller). @param {number} ms */
const blockFor = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Stops the harness process group a run recorded in `<slot>.harness` and did not remove: its helper died while the harness
 * ran. The group is signalled only while its leader is gone or has the recorded start time, so a reused pid is left alone.
 * @param {string} root the slot's root
 */
function stopOrphan(root) {
  const file = `${root}.harness`;
  /** @type {{ pgid?: unknown, started?: unknown } | null} */
  const rec = readJson(file);
  if (!rec) return;
  try {
    const pgid = Number(rec.pgid);
    if (!Number.isInteger(pgid) || pgid <= 1) return;
    const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid=,lstart="], { encoding: "utf8", timeout: 10_000 });
    if (ps.status !== 0) return;
    const rows = ps.stdout.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(l)).filter((m) => m !== null && Number(m[2]) === pgid);
    const leader = rows.find((m) => Number(m?.[1]) === pgid);
    if (!rows.length || (leader && leader[3] !== rec.started)) return;
    const signalGroup = (/** @type {NodeJS.Signals | 0} */ sig) => { try { process.kill(-pgid, sig); return true; } catch { return false; } };
    signalGroup("SIGTERM");
    for (let i = 0; i < 25 && signalGroup(0); i++) blockFor(200);
    signalGroup("SIGKILL");
  } finally {
    rmSync(file, { force: true });
  }
}

/** The lowest free slot, held until `release`. @param {string} base @returns {{ n: number, release: () => void }} */
function holdSlot(base) {
  for (let n = 0; n < MAC_MAX_SLOTS; n++) { const release = takeSlot(base, n); if (release) return { n, release }; }
  throw new Error(`all ${MAC_MAX_SLOTS} slots are busy`);
}

/** A slot for a lease that another process runs later (`claim`, `run --detach`): free now and named by no claimed lease. @param {string} base */
function pickSlot(base) {
  const dir = join(configDir(), "leases");
  const named = new Set(existsSync(dir) ? readdirSync(dir).map((f) => readJson(join(dir, f))?.slot).filter((n) => Number.isInteger(n)) : []);
  for (let n = 0; n < MAC_MAX_SLOTS; n++) {
    if (named.has(n)) continue;
    const release = takeSlot(base, n);
    if (release) { release(); return n; }
  }
  throw new Error(`all ${MAC_MAX_SLOTS} slots are busy or hold claimed leases`);
}

/** The values a flag takes in an argument list. @param {string[]} args @param {string} flag */
const argValues = (args, flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));

/**
 * Where a call's files go in a slot: each prepared mount at its fixed sandbox path below the root, an empty directory for
 * each rooted --add-dir without a mount and for the parents of nested mounts (`<root>/repos`), and the mounts as the
 * harness and the file tools see them.
 * @param {string} root @param {{ host: string, path: string }[]} mounts prepared mounts at fixed sandbox paths @param {string[]} [addDirs] rooted --add-dir values
 */
export function slotPlan(root, mounts, addDirs = []) {
  const copies = mounts.map((m) => ({ src: m.host, dst: `${root}${checkMountPath(m.path)}` }));
  const empty = addDirs.filter((d) => d.startsWith(`${root}/`)).map((d) => `${root}${checkMountPath(d.slice(root.length))}`);
  const parents = copies.map((c) => dirname(c.dst)).filter((d) => d !== root);
  const dirs = [...new Set([...empty, ...parents])].filter((d) => !copies.some((c) => c.dst === d));
  return { copies, dirs, mounts: copies.map((c) => ({ host: c.dst, path: c.dst })) };
}

/** Entries of a slot no call replaces. */
const SLOT_FIXED = new Set(["work", "tmp"]);

/** Copies a tree with clonefile where the filesystem has it (APFS), as a plain copy elsewhere. @param {string} src @param {string} dst */
async function cloneTree(src, dst) {
  const tmp = `${dst}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  let r = await run("cp", process.platform === "darwin" ? ["-c", "-R", src, tmp] : ["-R", "--reflink=auto", src, tmp]);
  if (r.code !== 0 && process.platform === "darwin") { rmSync(tmp, { recursive: true, force: true }); r = await run("cp", ["-R", src, tmp]); }
  if (r.code !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`copying ${src}: ${r.stderr.trim().slice(0, 200)}`); }
  renameSync(tmp, dst);
}

/**
 * Fills a slot for one call: removes what the call does not use, copies each tree that differs from what the slot holds
 * (recorded beside the slot, not in it), makes the empty directories, writes the call's files and empties tmp/.
 * @param {string} root @param {ReturnType<typeof slotPlan>} plan @param {{ name: string, content: string }[]} files written at the slot's top level, mode 0600
 */
export async function fillSlot(root, plan, files) {
  const recordFile = `${root}.json`;
  /** @type {Record<string, string>} */
  const record = readJson(recordFile) ?? {};
  privateDir(root);
  const wanted = new Set([...plan.copies.map((c) => c.dst), ...plan.dirs, ...files.map((f) => `${root}/${f.name}`)]);
  /** @param {string} p */
  const drop = (p) => {
    rmSync(p, { recursive: true, force: true });
    for (const k of Object.keys(record)) if (k === p || k.startsWith(`${p}/`)) delete record[k];
  };
  /** Removes what the call does not use below `dir`; an empty directory of the plan keeps only the copies inside it. @param {string} dir */
  const prune = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (dir === root && SLOT_FIXED.has(e.name)) continue;
      if (plan.dirs.includes(p)) { if (record[p] !== undefined || !e.isDirectory()) drop(p); else prune(p); }
      else if (wanted.has(p)) continue;
      else if (e.isDirectory() && [...wanted].some((w) => w.startsWith(`${p}/`))) prune(p);
      else drop(p);
    }
  };
  prune(root);
  for (const c of plan.copies) {
    if (record[c.dst] === c.src && existsSync(c.dst)) continue;
    rmSync(c.dst, { recursive: true, force: true });
    delete record[c.dst];
    mkdirSync(dirname(c.dst), { recursive: true });
    await cloneTree(c.src, c.dst);
    record[c.dst] = c.src;
  }
  for (const d of plan.dirs) mkdirSync(d, { recursive: true });
  for (const f of files) {
    if (!/^[a-z][a-z0-9.-]*$/.test(f.name)) throw new Error(`bad slot file name ${f.name}`);
    writeFileSync(`${root}/${f.name}`, f.content, { mode: 0o600 });
  }
  mkdirSync(`${root}/work`, { recursive: true });
  rmSync(`${root}/tmp`, { recursive: true, force: true });
  for (const d of ["tmp/home", "tmp/t"]) mkdirSync(`${root}/${d}`, { recursive: true, mode: 0o700 });
  writePrivate(recordFile, record);
}

/**
 * The sandbox-exec command of one run: the profile file, the slot and its temp directory as parameters, the harness, its
 * working directory in the slot. `env` is the process's whole environment.
 * @param {{ profile: string, root: string, argv: string[], env: Record<string, string> }} s
 */
export function macCommand(s) {
  const tmp = `${s.root}/tmp`;
  return {
    cmd: SANDBOX_EXEC, args: ["-f", s.profile, "-D", `ROOT=${s.root}`, "-D", `TMP=${tmp}`, ...s.argv], cwd: `${s.root}/work`,
    // Claude Code keeps its own temp dir at /tmp/claude-<uid> unless CLAUDE_CODE_TMPDIR is set; on a Mac that has run Claude Code that
    // dir already exists outside the profile, and the mkdir fails.
    env: { HOME: `${tmp}/home`, TMPDIR: `${tmp}/t/`, CLAUDE_CODE_TMPDIR: `${tmp}/t`, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", ...s.env },
  };
}

/** The Keychain item the config recorded, or (configs from before it was recorded) the one the current environment names. @param {Config} cfg */
const keychainItemOf = (cfg) => cfg.claudeKeychain ?? claudeKeychainItem();

/**
 * The Keychain item of Claude Code's login on macOS, as Claude Code names it: service "Claude Code-credentials" (with the
 * first 8 hex digits of the SHA-256 of CLAUDE_CONFIG_DIR appended when that is set), account the user name.
 * @param {Record<string, string | undefined>} [env]
 */
export function claudeKeychainItem(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR;
  let user = env.USER;
  if (!user) try { user = userInfo().username; } catch { user = ""; }
  return {
    service: `Claude Code-credentials${dir ? `-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}` : ""}`,
    account: user && /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user",
  };
}

/**
 * The access token of the user's own Claude Code login, read from the Keychain outside the sandbox with `security`, and
 * when it expires. The helper never refreshes it: a refresh rotates the login and would sign Claude Code out.
 * @returns {{ token: string, expiresAt: number | null } | null}
 */
/** @param {{ service: string, account: string }} [item]  the item recorded at `harness claude --keychain` time */
function keychainCredential(item = claudeKeychainItem()) {
  if (process.platform !== "darwin") return null;
  const { service, account } = item;
  const r = spawnSync("/usr/bin/security", ["find-generic-password", "-a", account, "-w", "-s", service], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) return null;
  try {
    const o = JSON.parse(r.stdout.trim())?.claudeAiOauth;
    return typeof o?.accessToken === "string" && o.accessToken ? { token: o.accessToken, expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null } : null;
  } catch { return null; }
}

/**
 * The canary, run by Node inside the profile: it must read the slot and write its temp directory, and must not read a file
 * the helper planted in the home, list the home, ~/.ssh or the Keychains, or write the home or the slot. Prints one JSON line.
 */
const CANARY = `const fs = require("node:fs");
const [slotFile, tmp, planted, home, ssh, keychains, root] = process.argv.slice(1);
const t = (f) => { try { f(); return { ok: true }; } catch (e) { return { ok: false, code: e.code || String(e) }; } };
console.log(JSON.stringify({
  readSlot: t(() => fs.readFileSync(slotFile)), writeTmp: t(() => fs.writeFileSync(tmp + "/w", "x")),
  readPlanted: t(() => fs.readFileSync(planted)), listHome: t(() => fs.readdirSync(home)), listSsh: t(() => fs.readdirSync(ssh)),
  listKeychains: t(() => fs.readdirSync(keychains)), writeHome: t(() => fs.writeFileSync(planted + ".w", "x")), writeSlot: t(() => fs.writeFileSync(root + "/w", "x")),
}));`;

/** What each canary probe must give. */
const CANARY_WANT = { readSlot: true, writeTmp: true, readPlanted: false, listHome: false, listSsh: false, listKeychains: false, writeHome: false, writeSlot: false };

/**
 * Reads the canary's output: ok only when every probe gave what it must, with one line per probe.
 * @param {string} stdout @returns {{ ok: boolean, lines: string[] }}
 */
export function canaryVerdict(stdout) {
  let r;
  try { r = JSON.parse(stdout.trim().split("\n").at(-1) ?? ""); } catch { return { ok: false, lines: ["the canary printed no result"] }; }
  const lines = [], bad = [];
  for (const [k, want] of Object.entries(CANARY_WANT)) {
    const got = r?.[k]?.ok === true;
    lines.push(`${got === want ? "ok  " : "FAIL"} ${k}: ${got ? "allowed" : `denied (${r?.[k]?.code ?? "?"})`}${got === want ? "" : `, must be ${want ? "allowed" : "denied"}`}`);
    if (got !== want) bad.push(k);
  }
  return { ok: bad.length === 0, lines };
}

/** A sandbox run outside any slot (canary, doctor): its own root beside the slots, emptied first. @param {string} name */
function scratchSlot(name) {
  const root = `${slotBase()}/${name}`;
  rmSync(root, { recursive: true, force: true });
  for (const d of ["work", "tmp/home", "tmp/t"]) mkdirSync(`${root}/${d}`, { recursive: true, mode: 0o700 });
  return root;
}

/**
 * Runs the canary inside the profile the harness runs in, with Node as the harness, in a scratch slot of this process.
 * Throws nothing.
 * @returns {{ ok: boolean, lines: string[], at: number }}
 */
function macCanary() {
  const r = canaryRun();
  return { ...r, at: Date.now() };
}

/** @returns {{ ok: boolean, lines: string[] }} */
function canaryRun() {
  let planted = "", root = "";
  try {
    const home = realpathSync(homedir());
    root = scratchSlot(`canary-${process.pid}`);
    writeFileSync(`${root}/slot.txt`, "slot");
    planted = join(home, `.autocraft-canary-${randomBytes(6).toString("hex")}`);
    writeFileSync(planted, "planted", { mode: 0o600 });
    const node = realpathSync(process.execPath);
    const profile = `${root}.sb`;
    writeFileSync(profile, macProfile({ deny: macDenied(home), files: [node], dirs: [dirname(dirname(node))] }), { mode: 0o600 });
    const c = macCommand({ profile, root, argv: [node, "-e", CANARY, `${root}/slot.txt`, `${root}/tmp`, planted, home, join(home, ".ssh"), join(home, "Library", "Keychains"), root], env: {} });
    const r = spawnSync(c.cmd, c.args, { cwd: c.cwd, env: c.env, encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return { ok: false, lines: [`the canary did not run (exit ${r.status}): ${(r.stderr || String(r.error ?? "")).trim().slice(0, 300)}`] };
    return canaryVerdict(r.stdout);
  } catch (e) {
    return { ok: false, lines: [`the canary could not be set up: ${msg(e)}`] };
  } finally {
    if (planted) { rmSync(planted, { force: true }); rmSync(`${planted}.w`, { force: true }); }
    if (root) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.sb`, { force: true }); }
  }
}

const CANARY_RETRY_MS = 10 * 60_000;
/** @type {{ ok: boolean, lines: string[], at: number } | null} */
let canaryResult = null;
/** Throws unless the canary passed in this process: run before the first claim, and again CANARY_RETRY_MS after a failure. */
function requireCanary() {
  if (process.platform !== "darwin") return;
  if (!canaryResult || (!canaryResult.ok && Date.now() - canaryResult.at >= CANARY_RETRY_MS)) canaryResult = macCanary();
  if (!canaryResult.ok) throw new Error(`the macOS sandbox canary failed, so no call is claimed:\n  ${canaryResult.lines.join("\n  ")}`);
}

/** @type {Record<HarnessId, Adapter>} */
const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter };

// ---------------------------------------------------------------------------
// Files: config and lease secrets under the config directory (mode 0700/0600), everything else in the cache.

/**
 * @typedef {object} Config
 * @property {string} [server]
 * @property {string} [agentToken]  the agent token of autocraft-task 1.2.0, read until the migration moves it into credentials.json
 * @property {HarnessId} [harness]
 * @property {string} [claudeToken]  a `claude setup-token` token
 * @property {string} [claudeConfigDir]  a Claude config directory whose login the helper uses instead (read only, never mounted; Linux: on macOS Claude Code keeps its login in the Keychain)
 * @property {"keychain"} [claudeAuth]  macOS: the helper uses the access token of the user's own Claude Code login in the Keychain instead
 * @property {{ service: string, account: string }} [claudeKeychain]  the Keychain item chosen at `harness claude --keychain` time
 * @property {string} [claudeBin]
 * @property {string} [codexBin]
 * @property {Partial<Record<Tier, string>>} [tiers]  model per tier; defaults are the adapter's
 * @property {string[]} [repos]
 * @property {Reserve} [reserve]  the local usage reserve: it only raises the server's, window by window
 * @property {number} [treeCacheGb]  the cap of the cached trees in GB (default TREE_CACHE_GB)
 * @property {boolean} [autoUpdate]  false: `work` never replaces this file by itself (default true)
 */

/** The runner's directory name under the config and cache directories. Not `autocraft`: a machine running the server keeps its data there. */
const RUNNER_DIR = "autocraft-runner";
/** The directory name of autocraft-task up to 1.2.0, which `migrateLegacy` moves over. */
const LEGACY_DIR = "autocraft-task";
const xdgConfig = () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const xdgCache = () => process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const legacyConfigDir = () => join(xdgConfig(), LEGACY_DIR);
const legacyCacheDir = () => join(xdgCache(), LEGACY_DIR);
/** A directory, not a symlink to one. @param {string} p */
const realDir = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
/** The runner's directory under `base`; until the migration moved a 1.2.0 install over, its directory `legacy`. @param {string} base @param {string} legacy */
const runnerDir = (base, legacy) => { const d = join(base, RUNNER_DIR); return !existsSync(d) && realDir(legacy) ? legacy : d; };
const configDir = () => runnerDir(xdgConfig(), legacyConfigDir());
const cacheDir = () => runnerDir(xdgCache(), legacyCacheDir());
const SESSION_TTL_MS = 3 * 3600_000;
const TREE_TTL_MS = 3 * 24 * 3600_000;
/** A tree used this recently may be mounted by a running call: the size cap leaves it. */
const TREE_BUSY_MS = 6 * 3600_000;
/** The tree cache's default cap (config `treeCacheGb`). */
const TREE_CACHE_GB = 20;
const BARE_TTL_MS = 7 * 24 * 3600_000;
const GC_EVERY_MS = 24 * 3600_000;
const PRUNE_EVERY_MS = 10 * 60_000;
const WAIT_MS = 9 * 60_000;

/** @param {string} p */
function privateDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  chmodSync(p, 0o700);
  return p;
}

/** Writes `data` as JSON with mode 0600, atomically. @param {string} file @param {unknown} data */
function writePrivate(file, data) {
  privateDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** A Claude config directory's `.credentials.json`, read only. @param {string} dir @returns {any} */
const readClaudeCredentials = (dir) => readJson(join(dir, ".credentials.json"));

/** @returns {Config} */
const loadConfig = () => readJson(join(configDir(), "config.json")) ?? {};
/** @param {Config} c */
const saveConfig = (c) => writePrivate(join(configDir(), "config.json"), c);

/**
 * The runner's credential, in a file apart from config.json so a pasted config leaks nothing. The top level holds an
 * approved credential; `pending` a login waiting for its approval (`autocraft login`), which replaces it once approved.
 * @typedef {object} Credentials
 * @property {string} [server]
 * @property {string} [credential]
 * @property {"approved"} [state]
 * @property {number} [id]
 * @property {string} [login]
 * @property {string} [label]
 * @property {PendingLogin} [pending]
 */
/** @typedef {{ server: string, credential: string, label: string, userCode?: string, verifyUrl?: string, interval?: number, expiresAt?: number }} PendingLogin */
const credentialsFile = () => join(configDir(), "credentials.json");
/** @returns {Credentials} */
const loadCredentials = () => readJson(credentialsFile()) ?? {};
/** @param {Credentials} c */
const saveCredentials = (c) => writePrivate(credentialsFile(), c);
/** The bearer of the agent-token routes: the approved credential, else the agent token of a 1.2.0 config. @param {Config} cfg */
const credentialOf = (cfg) => { const c = loadCredentials(); return (c.state === "approved" && c.credential) || cfg.agentToken || null; };

/** `slot` and `root`: the macOS slot the claim named. @typedef {{ secret: string, title: string, requiredHelper: string, server: string, claimedAt: number, slot?: number, root?: string }} LeaseRecord */
/** @param {number | string} id */
const leaseFile = (id) => join(configDir(), "leases", `${Number(id)}.json`);
/** @param {number | string} id @returns {LeaseRecord | null} */
const readLease = (id) => readJson(leaseFile(id));
/** @param {number | string} id */
const dropLease = (id) => rmSync(leaseFile(id), { force: true });

/**
 * `hold`: the helper can take no call for a while (`ms`; null: until it is restarted), shown as `readiness`.
 * @typedef {{ readiness: Readiness, ms: number | null }} RunHold
 * `noStrike`: a release that says nothing about the helper's health (a call too long for its login), so it does not count toward `failing`.
 * @typedef {{ state: "running" | "submitted" | "failed" | "lost" | "released", line: string, pid?: number, at: number, hold?: RunHold, noStrike?: boolean }} RunStatus
 */
/** A run's hold for a missing harness, login or sandbox: they need the user, so they are checked again only after a while. */
const STOP_HOLD_MS = 10 * 60_000;
/** A run's hold for a login that could not be read: Claude Code rewrites its credentials in place, a Keychain read can fail once. */
const TOKEN_HOLD_MS = 30_000;
/** @param {number | string} id */
const statusFile = (id) => join(cacheDir(), "runs", `${Number(id)}.json`);
/** @param {number | string} id @param {RunStatus} s */
function writeStatus(id, s) {
  privateDir(dirname(statusFile(id)));
  writeFileSync(`${statusFile(id)}.tmp`, JSON.stringify(s), { mode: 0o600 });
  renameSync(`${statusFile(id)}.tmp`, statusFile(id));
}

/** Secrets never appear in printed or submitted text. @param {string} s */
function redact(s) {
  let out = s;
  const cfg = loadConfig();
  const creds = loadCredentials();
  for (const k of [cfg.agentToken, creds.credential, creds.pending?.credential, cfg.claudeToken, ...secretsInUse]) if (k && k.length >= 8) out = out.split(k).join("[redacted]");
  return out;
}
/** @type {Set<string>} */
const secretsInUse = new Set();

/** @param {unknown} e */
const msg = (e) => redact(e instanceof Error ? e.message : String(e));

// Session stores: sessions/<callId>.json names the store directory, the harness session id and, on macOS, the slot whose
// paths the session read; stores live in sessions/store-*.
const sessionsDir = () => join(cacheDir(), "sessions");
/** @param {number} callId @returns {{ sessionId: string, dir: string, at: number, slot?: number } | null} */
function readSession(callId) {
  const s = readJson(join(sessionsDir(), `${callId}.json`));
  return s && Date.now() - s.at < SESSION_TTL_MS && existsSync(s.dir) ? s : null;
}
/** Call ids whose session store this helper still holds; on macOS only those of slot `slot`. @param {number} [slot] */
function heldSessions(slot) {
  if (!existsSync(sessionsDir())) return [];
  return readdirSync(sessionsDir()).flatMap((f) => { const m = /^(\d+)\.json$/.exec(f); const s = m ? readSession(Number(m[1])) : null; return s && s.slot === slot ? [Number(m?.[1])] : []; });
}

let prunedAt = 0;

/**
 * Removes expired session stores, status files, lease files and task directories a crash left behind; bare repos unused for
 * BARE_TTL_MS; cached trees unused for TREE_TTL_MS, then the least recently used ones while all of them exceed the size cap.
 * Runs at most every PRUNE_EVERY_MS per process.
 */
function prune() {
  const now = Date.now();
  if (now - prunedAt < PRUNE_EVERY_MS) return;
  prunedAt = now;
  /** @param {string} p */
  const age = (p) => { try { return now - statSync(p).mtimeMs; } catch { return 0; } };
  const sd = sessionsDir();
  if (existsSync(sd)) {
    const live = new Set();
    for (const f of readdirSync(sd)) {
      if (!f.endsWith(".json")) continue;
      const s = readJson(join(sd, f));
      if (!s || now - s.at >= SESSION_TTL_MS) rmSync(join(sd, f), { force: true });
      else live.add(s.dir);
    }
    for (const d of readdirSync(sd)) if (d.startsWith("store-") && !live.has(join(sd, d)) && age(join(sd, d)) > SESSION_TTL_MS) rmSync(join(sd, d), { recursive: true, force: true });
  }
  const tasks = join(cacheDir(), "tasks");
  if (existsSync(tasks)) for (const d of readdirSync(tasks)) if (age(join(tasks, d)) > 24 * 3600_000) rmSync(join(tasks, d), { recursive: true, force: true });
  const trees = join(cacheDir(), "trees");
  /** @type {{ p: string, at: number, bytes: number }[]} */
  const kept = [];
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir)) {
      const p = join(dir, d);
      if (depth > 0) walk(p, depth - 1);
      else if (d.endsWith(".size")) { if (!existsSync(p.slice(0, -5))) rmSync(p, { force: true }); }
      else if (age(p) > TREE_TTL_MS) { rmSync(p, { recursive: true, force: true }); rmSync(`${p}.size`, { force: true }); }
      else if (!d.includes(".tmp-")) {
        let bytes = Number.parseInt((() => { try { return readFileSync(`${p}.size`, "utf8"); } catch { return ""; } })(), 10);
        if (!(bytes >= 0)) { bytes = treeBytes(p); try { writeFileSync(`${p}.size`, String(bytes)); } catch { /* counted anyway */ } }
        kept.push({ p, at: now - age(p), bytes });
      }
    }
  };
  walk(join(trees, "git"), 2);
  walk(join(trees, "tarball"), 1);
  const capGb = loadConfig().treeCacheGb;
  const cap = (typeof capGb === "number" && capGb > 0 ? capGb : TREE_CACHE_GB) * 1e9;
  let total = kept.reduce((n, t) => n + t.bytes, 0);
  for (const t of kept.sort((a, b) => a.at - b.at)) {
    if (total <= cap || now - t.at < TREE_BUSY_MS) break;
    rmSync(t.p, { recursive: true, force: true }); rmSync(`${t.p}.size`, { force: true });
    total -= t.bytes;
  }
  const git = join(cacheDir(), "git");
  if (existsSync(git)) for (const owner of readdirSync(git)) {
    const od = join(git, owner);
    let repos = [];
    try { repos = readdirSync(od); } catch { continue; }
    for (const r of repos) {
      const bare = join(od, r);
      if (!r.endsWith(".git") || age(bare) <= BARE_TTL_MS) continue;
      const release = takeLockFile(`${bare}.lock`, FETCH_LOCK_STALE_MS);
      if (!release) continue;
      try { rmSync(bare, { recursive: true, force: true }); } finally { release(); }
    }
  }
  const runs = join(cacheDir(), "runs");
  if (existsSync(runs)) for (const f of readdirSync(runs)) if (age(join(runs, f)) > 24 * 3600_000) rmSync(join(runs, f), { force: true });
  const leases = join(configDir(), "leases");
  if (existsSync(leases)) for (const f of readdirSync(leases)) if (age(join(leases, f)) > 24 * 3600_000) rmSync(join(leases, f), { force: true });
}

// ---------------------------------------------------------------------------
// HTTP.

class Gone extends Error {}

/** A reply other than 2xx and 410. `retryAfterMs`: the reply's Retry-After, or null. */
export class HttpError extends Error {
  /** @param {string} route @param {number} status @param {string} text @param {number | null} retryAfterMs */
  constructor(route, status, text, retryAfterMs) {
    super(`${route}: HTTP ${status} ${redact(text).slice(0, 300)}`.trim());
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * An HTML reply with a 4xx status other than 404 and 410: a CDN, web application firewall or other proxy in front of the
 * server refused the request (the server answers JSON). Retried like a network error, never taken for a refused credential.
 */
export class ProxyBlocked extends HttpError {
  /** @param {string} route @param {number} status @param {number | null} retryAfterMs */
  constructor(route, status, retryAfterMs) {
    super(route, status, "", retryAfterMs);
    this.message = `${route}: blocked by a proxy in front of the server (HTTP ${status}, HTML reply)`;
  }
}

/** A Retry-After header as milliseconds (delta seconds or an HTTP date); null when absent or unreadable. @param {string | null} v */
export function retryAfterMs(v, now = Date.now()) {
  if (!v) return null;
  if (/^\s*\d+\s*$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

const NET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/**
 * Whether one request's error is worth trying again: 408, 429, 5xx, a proxy's refusal (ProxyBlocked), a network error (reset,
 * refused, DNS), a request timeout or a reply cut off. A 410, any other 4xx and the caller's own abort are final.
 * @param {unknown} e @param {AbortSignal} [signal]
 */
export function transient(e, signal) {
  if (signal?.aborted || e instanceof Gone) return false;
  if (e instanceof ProxyBlocked) return true;
  if (e instanceof HttpError) return e.status === 408 || e.status === 429 || e.status >= 500;
  if (!e || typeof e !== "object") return false;
  // fetch rejects with a TypeError ("fetch failed", "terminated" for a body cut off); JSON.parse of a cut-off body with a SyntaxError.
  if (e instanceof TypeError || e instanceof SyntaxError) return true;
  const x = /** @type {{ name?: string, code?: string, cause?: { code?: string } }} */ (e);
  return x.name === "TimeoutError" || NET_CODES.has(x.code ?? "") || NET_CODES.has(x.cause?.code ?? "");
}

/** Servers whose tool calls run commands and writes that must not run twice: a request that may have reached the server is not sent again. */
const ONCE_SERVERS = new Set(["work"]);
/** Codes of a connection that was never made, so the request reached nobody. */
const UNSENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * Whether a failed request certainly did not run on the server: refused for the rate (429, answered before the body is
 * read) or never connected.
 * @param {unknown} e
 */
export function notRun(e) {
  if (e instanceof HttpError) return e.status === 429;
  const x = /** @type {{ code?: string, cause?: { code?: string } } | null} */ (e && typeof e === "object" ? e : null);
  return UNSENT_CODES.has(x?.code ?? "") || UNSENT_CODES.has(x?.cause?.code ?? "");
}

/** The error for a cut-off call of a ONCE_SERVERS server. @param {unknown} e */
const mayHaveRun = (e) => new Error(`${msg(e)}; the call may have run in the workspace and is not sent again: look with shell_status or read before you repeat it`);

/** The wait before retry `attempt` (0 first): exponential from `baseMs` up to 30 s with jitter, at least the server's Retry-After. @param {number} attempt @param {number | null} retryAfter */
export function backoffMs(attempt, retryAfter, baseMs = scaled(1000)) {
  const exp = Math.min(scaled(30_000), baseMs * 2 ** attempt);
  const wait = exp / 2 + (Math.random() * exp) / 2;
  return retryAfter === null ? wait : Math.max(wait, retryAfter + Math.random() * baseMs);
}

/**
 * Runs `fn` until it succeeds, fails for good (`transient` says no, or `again` when given) or runs out of time (`deadline`,
 * ms since epoch) or of `tries`; then throws its last error. `signal` ends the waits between tries.
 * @template T @param {() => Promise<T>} fn @param {{ deadline: number, tries?: number, signal?: AbortSignal, baseMs?: number, again?: (e: unknown) => boolean }} o
 * @returns {Promise<T>}
 */
export async function withRetry(fn, o) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!transient(e, o.signal) || (o.again && !o.again(e)) || (o.tries !== undefined && attempt + 1 >= o.tries)) throw e;
      const wait = backoffMs(attempt, e instanceof HttpError ? e.retryAfterMs : null, o.baseMs);
      if (Date.now() + wait >= o.deadline) throw e;
      try { await sleep(wait, undefined, o.signal && { signal: o.signal }); } catch { throw e; }
    }
  }
}

/**
 * Servers whose latest claim or status reply listed the `gzip+base64` encoding: POST bodies to them go as an Envelope, so
 * a CDN or web application firewall in front of the server never matches its content rules against model text.
 * @type {Set<string>}
 */
const envelopeServers = new Set();

/** A JSON body as an Envelope. @param {unknown} body @returns {Envelope} */
export function envelope(body) {
  return { encoding: "gzip+base64", body: gzipSync(JSON.stringify(body)).toString("base64") };
}

/**
 * One request; `body` makes it a POST, a null `bearer` sends no credential. Throws Gone on 410, ProxyBlocked on an HTML 4xx,
 * HttpError on any other non-2xx. A claim or status reply tells whether later bodies to `server` go as an Envelope.
 * @param {string} server @param {string} route @param {string | null} bearer @param {unknown} [body] @param {{ signal?: AbortSignal, timeoutMs?: number }} [o]
 * @returns {Promise<any>}
 */
export async function api(server, route, bearer, body, o = {}) {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 60_000);
  const res = await fetch(`${server}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(bearer !== null && { Authorization: `Bearer ${bearer}` }), ...(body !== undefined && { "Content-Type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(envelopeServers.has(server) ? envelope(body) : body) }),
    signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
  });
  if (res.status === 410) throw new Gone("the lease is gone");
  const text = await res.text();
  if (!res.ok) {
    const after = retryAfterMs(res.headers.get("retry-after"));
    const html = /html/i.test(res.headers.get("content-type") ?? "") || /^\s*</.test(text);
    if (html && res.status >= 400 && res.status < 500 && res.status !== 404) throw new ProxyBlocked(route, res.status, after);
    throw new HttpError(route, res.status, text, after);
  }
  const out = text.trim() ? JSON.parse(text) : {};
  if (route === ROUTES.claim || route === ROUTES.status) {
    if (Array.isArray(out?.encodings) && out.encodings.includes("gzip+base64")) envelopeServers.add(server);
    else envelopeServers.delete(server);
  }
  return out;
}

/** The server ends a lease this long after the call's time limit, or after its last heartbeat (docs/operations.md, Leases). */
const LEASE_GRACE_MS = scaled(120_000);
/** Retries of a lease route stop this long before the lease's server deadline. */
const RETRY_MARGIN_MS = scaled(90_000);
/**
 * A finished reply's submit keeps trying this long past the helper's own deadline: after an outage of the dashboard the
 * server moves its lease deadlines forward by the gap (src/remote/liveness.ts), which the helper cannot see.
 */
const SUBMIT_OUTAGE_MS = scaled(30 * 60_000);
/** Retries of a tool call made from inside the sandbox, where the lease's deadline is unknown. */
const TOOL_RETRY_MS = scaled(3 * 60_000);

/**
 * The heartbeats of one lease, from the claim until `stop`: phase `preparing`, then `running` from `running()` on (sent at
 * once; the server's time limit starts with it). Each beat is retried until the next is due; a 410 aborts `gone`.
 * @param {LeaseRecord} lease
 */
function heartbeats(lease) {
  const goneAc = new AbortController(), stopAc = new AbortController();
  /** @type {Heartbeat["phase"]} */
  let phase = "preparing";
  let progress = "", sent = "", wake = () => {};
  /** @type {number | null} */
  let runStart = null;
  const send = () => withRetry(() => api(lease.server, ROUTES.heartbeat, lease.secret, /** @type {Heartbeat} */ ({ phase, ...(progress && { progress }) }), { signal: stopAc.signal, timeoutMs: 20_000 }), { deadline: Date.now() + HEARTBEAT_S * 1000 - 2000, signal: stopAc.signal });
  void (async () => {
    while (!stopAc.signal.aborted) {
      sent = phase;
      try { await send(); clearError("server"); } catch (e) { if (e instanceof Gone) { goneAc.abort(); return; } if (!stopAc.signal.aborted) noteError(msg(e), "server"); }
      try { await keepStatusFresh(); } catch { /* next beat */ }
      if (sent === phase && !stopAc.signal.aborted) await new Promise((r) => { const t = setTimeout(r, HEARTBEAT_MS); wake = () => { clearTimeout(t); r(undefined); }; });
    }
  })();
  return {
    gone: goneAc.signal,
    get runStart() { return runStart; },
    /** The harness spawns now. */
    running() { if (runStart !== null) return; runStart = Date.now(); phase = "running"; wake(); },
    /** @param {string} p the harness's last progress line */
    progress(p) { progress = p; },
    stop() { stopAc.abort(); wake(); },
  };
}

// ---------------------------------------------------------------------------
// Plan usage and readiness. Before every claim the helper reads its harness's plan usage and claims only while every
// window keeps more than the reserve free (the user's, from the server, raised by the local `config reserve`). Anything
// it cannot read for sure holds: no reading, a failed or unparseable one, one older than USAGE_STALE_MS, or a window kind
// this helper does not know. A user's pause outranks recovered headroom; a run the provider refused for its limit parks
// the helper until the reset the provider named. The helper reports its readiness to the server (ROUTES.status) on every
// change and at least every STATUS_EVERY_MS, and keeps it in a 0600 status file.

export const USAGE_STALE_MS = 5 * 60_000;
/** A reading this young is used again instead of asking the provider (claims come every 15 s). */
const USAGE_REUSE_MS = scaled(60_000);
/** While held, the helper reads its usage again about this often (jittered, and not the reuse interval, so slots do not wake together). */
export const HOLD_RETRY_MS = scaled(45_000);
/** @param {() => number} [rand] @returns {number} HOLD_RETRY_MS within plus or minus 20% */
export const holdRetryDelay = (rand = Math.random) => Math.round(HOLD_RETRY_MS * (0.8 + 0.4 * rand()));
/** An error reading is shared with other processes for this long before the provider is asked again (a provider's own wait overrides it). */
const USAGE_ERROR_RETRY_MS = scaled(30_000);
/** The last good reading keeps counting this long when a new read fails or is refused, while every window keeps the reserve plus LAST_GOOD_MARGIN free. */
export const LAST_GOOD_MS = 15 * 60_000;
export const LAST_GOOD_MARGIN = 10;
/** The longest a process waits for another process's usage read. */
const USAGE_LOCK_WAIT_MS = 20_000;
export const STATUS_EVERY_MS = scaled(5 * 60_000);
/** The longest a provider's refusal parks the helper: its reset time is text the helper cannot check. */
export const PARK_CAP_MS = 7 * 24 * 3600_000;
/** A refusal that names no reset parks for this long; the hold comes back if the usage still says so. */
const PARK_FALLBACK_MS = 15 * 60_000;
/** Added to a parsed reset so the first claim after it is not early. */
const PARK_GRACE_MS = 60_000;
/** A server that refused the helper's version is asked again after this long. */
const REFUSED_RETRY_MS = 10 * 60_000;
export const DEFAULT_RESERVE = { fiveHour: 20, weekly: 20 };
/** The window kinds the helper knows; any other kind in a reading holds. */
const WINDOW_KINDS = /** @type {const} */ (["five_hour", "weekly"]);
const RESERVE_OF = /** @type {const} */ ({ five_hour: "fiveHour", weekly: "weekly" });

/** @typedef {{ kind: string, usedPercent: number, resetsAt: number | null }} QuotaWindow  `kind` is five_hour, weekly, or the provider's name of a window the helper does not know; times in ms */
/** `lastGood`: the reading is an earlier good one standing in for a read that failed (the failure's text); it keeps its own `at`. @typedef {{ at: number, windows: QuotaWindow[], blocked?: string, lastGood?: string } | { at: number, error: string }} QuotaReading */
/** @typedef {{ ok: true } | { ok: false, until: number | null, reason: string }} QuotaVerdict */
/** @typedef {{ until: number | null, at: number }} Pause  until: the reset it was taken at; null: until `resume` */
/** @typedef {{ until: number | null, at: number, reason: string }} Park  until null: the provider named no trusted time; a passing reading taken after `at` ends it */

/** The reserve the helper enforces: per window the larger of the server's (the default before it has sent one) and the local one. @param {Reserve | undefined} server @param {Reserve | undefined} local @returns {Reserve} */
export function effectiveReserve(server, local) {
  const s = server ?? DEFAULT_RESERVE;
  return { fiveHour: Math.max(s.fiveHour, local?.fiveHour ?? 0), weekly: Math.max(s.weekly, local?.weekly ?? 0) };
}

/** @param {number | null} t */
const clock = (t) => (t === null ? "" : new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
/** @param {string} kind */
const windowName = (kind) => (kind === "five_hour" ? "5-hour" : kind === "weekly" ? "weekly" : kind);

/**
 * Whether a reading lets the helper claim under `reserve`: every window's remaining percent (100 - used) above its reserve.
 * A hold names the windows that bind and lasts until the latest of their resets (null when one has none).
 * @param {QuotaReading | null} reading @param {Reserve} reserve @param {number} [now] @returns {QuotaVerdict}
 */
export function quotaVerdict(reading, reserve, now = Date.now()) {
  if (!reading) return { ok: false, until: null, reason: "no usage reading" };
  if ("error" in reading) return { ok: false, until: null, reason: `usage unknown: ${reading.error}` };
  if (reading.lastGood !== undefined) {
    if (!(now - reading.at <= LAST_GOOD_MS)) return { ok: false, until: null, reason: `usage unknown: ${reading.lastGood}; the last good reading is ${Math.round((now - reading.at) / 60_000)} min old` };
    const thin = reading.windows.find((w) => {
      const r = reserve[RESERVE_OF[/** @type {"five_hour" | "weekly"} */ (w.kind)]];
      return typeof r !== "number" || !(100 - w.usedPercent >= r + LAST_GOOD_MARGIN);
    });
    if (thin) return { ok: false, until: null, reason: `usage unknown: ${reading.lastGood}; the last good reading is too close to the reserve to rely on (${windowName(thin.kind)} window ${Math.round(thin.usedPercent)}% used)` };
  } else if (!(now - reading.at <= USAGE_STALE_MS)) return { ok: false, until: null, reason: `the usage reading is ${Math.round((now - reading.at) / 60_000)} min old` };
  if (!reading.windows.length) return { ok: false, until: null, reason: "usage unknown: the reading has no plan window" };
  /** @type {QuotaWindow[]} */
  const binding = [];
  for (const w of reading.windows) {
    const known = /** @type {readonly string[]} */ (WINDOW_KINDS).includes(w.kind);
    if (!known) return { ok: false, until: null, reason: `usage unknown: a plan window of a kind this helper does not know (${w.kind})` };
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return { ok: false, until: null, reason: `usage unknown: the ${windowName(w.kind)} window has no percentage` };
    if (100 - w.usedPercent <= reserve[RESERVE_OF[/** @type {"five_hour" | "weekly"} */ (w.kind)]]) binding.push(w);
  }
  const latest = (/** @type {QuotaWindow[]} */ ws) => (ws.some((w) => w.resetsAt === null) ? null : Math.max(...ws.map((w) => /** @type {number} */ (w.resetsAt))));
  if (reading.blocked) return { ok: false, until: latest(reading.windows.filter((w) => w.usedPercent >= 100).length ? reading.windows.filter((w) => w.usedPercent >= 100) : reading.windows), reason: reading.blocked };
  if (!binding.length) return { ok: true };
  const what = binding.map((w) => `${windowName(w.kind)} window ${Math.round(w.usedPercent)}% used (reserve ${reserve[RESERVE_OF[/** @type {"five_hour" | "weekly"} */ (w.kind)]]}% free)`).join(", ");
  return { ok: false, until: latest(binding), reason: what };
}

/**
 * The helper's quota readiness from its pause, its park and the usage verdict: a pause first, then a park, then the usage.
 * `dropPark`: the park is over (its time passed, or a passing reading came after it).
 * @param {{ pause?: Pause | null, park?: Park | null, verdict: QuotaVerdict, readingAt: number | null, now?: number }} o
 * @returns {{ readiness: "ready" | "quota-held" | "paused", until: number | null, reason?: string, dropPause?: boolean, dropPark?: boolean }}
 */
export function quotaReadiness({ pause, park, verdict, readingAt, now = Date.now() }) {
  let dropPause = false, dropPark = false;
  if (pause && pause.until !== null && now >= pause.until) { dropPause = true; pause = null; }
  if (park && (park.until !== null ? now >= park.until : verdict.ok && readingAt !== null && readingAt > park.at)) { dropPark = true; park = null; }
  const drops = { ...(dropPause && { dropPause }), ...(dropPark && { dropPark }) };
  if (pause) return { readiness: "paused", until: pause.until, reason: pause.until === null ? "by the user, until `autocraft runner resume`" : "by the user, until the plan window resets", ...drops };
  if (park) return { readiness: "quota-held", until: park.until, reason: park.reason, ...drops };
  if (!verdict.ok) return { readiness: "quota-held", until: verdict.until, reason: verdict.reason, ...drops };
  return { readiness: "ready", until: null, ...drops };
}

/** @param {unknown} v @returns {number | null} */
const timeOf = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** Whether a model scope (a display name such as "Opus", or a model id) is one of the models this helper runs. @param {any} model @param {string[]} models */
function runsModel(model, models) {
  const names = [model?.id, typeof model?.display_name === "string" ? model.display_name.split(/\s+/)[0] : null].filter((x) => typeof x === "string" && x).map((x) => x.toLowerCase());
  if (!names.length) return true;
  return models.some((m) => names.some((n) => m.toLowerCase().includes(n) || n.includes(m.toLowerCase())));
}

/**
 * Claude Code's plan usage (GET https://api.anthropic.com/api/oauth/usage, as Claude Code 2.1 reads it for /usage) as
 * windows. `limits` lists them with a kind and a group: session (the 5-hour window), weekly_all, and weekly_scoped for one
 * model (`scope.model`), which counts only when the helper runs that model. A reply without `limits` gives the named
 * windows five_hour, seven_day and the per-model seven_day_opus / seven_day_sonnet (utilization in percent).
 * @param {any} body @param {string[]} models the models the helper runs @param {number} [now] @returns {QuotaReading}
 */
export function parseClaudeUsage(body, models, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { at: now, error: "unreadable usage reply" };
  /** @type {QuotaWindow[]} */
  const windows = [];
  if (Array.isArray(body.limits)) {
    for (const l of body.limits) {
      if (!l || typeof l !== "object" || typeof l.kind !== "string") return { at: now, error: "unreadable usage reply: a limit without a kind" };
      const w = { usedPercent: l.percent, resetsAt: timeOf(l.resets_at) };
      if (l.kind === "weekly_scoped" && l.scope?.model && !runsModel(l.scope.model, models)) continue;
      const kind = l.kind === "session" ? "five_hour" : l.kind === "weekly_all" || l.kind === "weekly_scoped" ? "weekly"
        : l.group === "session" ? "five_hour" : l.group === "weekly" ? "weekly" : l.kind;
      windows.push({ kind, ...w });
    }
  } else {
    for (const [key, kind, model] of [["five_hour", "five_hour", null], ["seven_day", "weekly", null], ["seven_day_opus", "weekly", "opus"], ["seven_day_sonnet", "weekly", "sonnet"]]) {
      const w = body[/** @type {string} */ (key)];
      if (!w || typeof w !== "object") continue;
      if (model && !runsModel({ display_name: model }, models)) continue;
      windows.push({ kind: /** @type {string} */ (kind), usedPercent: w.utilization, resetsAt: timeOf(w.resets_at) });
    }
  }
  return { at: now, windows };
}

/**
 * The Codex app-server's `account/rateLimits/read` reply (codex-rs app-server-protocol v2 GetAccountRateLimitsResponse) as
 * windows: the default bucket (`rateLimits`) and the buckets of `rateLimitsByLimitId` whose normal model is one the helper
 * runs, each with a primary and a secondary window. A window of 300 minutes is the 5-hour one, 10080 the weekly one; any
 * other length is a kind the helper does not know. `ordinaryUsageAllowed: false` or a bucket's `rateLimitReachedType` blocks.
 * @param {any} res @param {string[]} models @param {number} [now] @returns {QuotaReading}
 */
export function parseCodexRateLimits(res, models, now = Date.now()) {
  if (!res || typeof res !== "object" || !res.rateLimits || typeof res.rateLimits !== "object") return { at: now, error: "unreadable rate-limit reply" };
  const buckets = [res.rateLimits];
  if (res.rateLimitsByLimitId && typeof res.rateLimitsByLimitId === "object") {
    for (const b of Object.values(res.rateLimitsByLimitId)) if (b && typeof b === "object" && typeof b.normalModelSlug === "string" && models.includes(b.normalModelSlug)) buckets.push(b);
  }
  /** @type {QuotaWindow[]} */
  const windows = [];
  let blocked;
  for (const b of buckets) {
    for (const w of [b.primary, b.secondary]) {
      if (!w) continue;
      if (typeof w !== "object") return { at: now, error: "unreadable rate-limit window" };
      const mins = w.windowDurationMins;
      windows.push({ kind: mins === 300 ? "five_hour" : mins === 10080 ? "weekly" : `${mins ?? "unknown"}-minute`, usedPercent: w.usedPercent, resetsAt: timeOf(w.resetsAt) });
    }
    if (typeof b.rateLimitReachedType === "string") blocked = `the provider reports its limit reached (${b.rateLimitReachedType})`;
  }
  if (res.ordinaryUsageAllowed === false) blocked = "the provider reports that the plan's usage is used up";
  return { at: now, windows, ...(blocked && { blocked }) };
}

/** Reads Claude Code's plan usage with the harness credential: no model call. @param {string} token @param {string[]} models @returns {Promise<{ reading: QuotaReading, retryAt?: number }>} */
async function claudeQuota(token, models) {
  const now = Date.now();
  let res;
  try {
    res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json", "User-Agent": `autocraft/${HELPER_VERSION}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { reading: { at: now, error: `the usage endpoint did not answer (${msg(e)})` } };
  }
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after"));
    return { reading: { at: now, error: "the usage endpoint asked the helper to wait" }, retryAt: now + Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 5 * 60_000, 3600_000) };
  }
  if (res.status === 401 || res.status === 403) {
    const cfg = loadConfig();
    const hint = cfg.claudeToken && !cfg.claudeConfigDir && cfg.claudeAuth !== "keychain" ? "; a `claude setup-token` token may not read plan usage: use `harness claude --config-dir` (Linux) or `--keychain` (macOS)" : "; run claude once to refresh its login";
    return { reading: { at: now, error: `this Claude login may not read plan usage (HTTP ${res.status})${hint}` }, retryAt: now + 5 * 60_000 };
  }
  if (!res.ok) return { reading: { at: now, error: `the usage endpoint answered HTTP ${res.status}` } };
  let body;
  try { body = await res.json(); } catch { return { reading: { at: now, error: "unreadable usage reply" } }; }
  return { reading: parseClaudeUsage(body, models, now) };
}

/**
 * Asks the Codex app-server (`codex app-server`, JSON-RPC lines on stdio) for `account/rateLimits/read`, with the helper's
 * own CODEX_HOME. It may refresh the login, so it holds the Codex lock that calls hold; while a call runs there is no reading.
 * @param {string} bin @param {string} home @param {string[]} models @returns {Promise<{ reading: QuotaReading }>}
 */
async function codexQuota(bin, home, models) {
  const now = Date.now();
  const unlock = takeHarnessLock("codex");
  if (!unlock) return { reading: { at: now, error: "a Codex call is running on this helper" } };
  try {
    for (const f of CODEX_HOME_INSTRUCTIONS) rmSync(join(home, f), { force: true });
    const result = await new Promise((done) => {
      const p = spawn(bin, ["-c", 'cli_auth_credentials_store="file"', "app-server"], { env: { PATH: process.env.PATH ?? "/usr/bin", HOME: homedir(), CODEX_HOME: home, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "ignore"] });
      let buf = "", settled = false;
      /** @param {any} v */
      const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); p.stdin.end(); p.kill("SIGTERM"); done(v); };
      const timer = setTimeout(() => finish({ error: "the Codex app-server did not answer in 20 s" }), 20_000);
      /** @param {unknown} m */
      const send = (m) => p.stdin.write(`${JSON.stringify(m)}\n`);
      p.stdin.on("error", () => {});
      p.on("error", (e) => finish({ error: `the Codex app-server did not start (${e.message})` }));
      p.on("close", () => finish({ error: "the Codex app-server stopped before answering" }));
      p.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          let m;
          try { m = JSON.parse(l); } catch { continue; }
          if (m?.id === 1) {
            if (m.error) return finish({ error: `the Codex app-server refused to start a session (${String(m.error.message ?? "").slice(0, 200)})` });
            send({ method: "initialized" });
            send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
          } else if (m?.id === 2) {
            return finish(m.error ? { error: `account/rateLimits/read failed (${String(m.error.message ?? "").slice(0, 200)})` } : { result: m.result });
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "autocraft", title: null, version: HELPER_VERSION } } });
    });
    const r = /** @type {{ error?: string, result?: unknown }} */ (result);
    return { reading: r.error ? { at: now, error: r.error } : parseCodexRateLimits(r.result, models, now) };
  } finally {
    unlock();
  }
}

const usageFile = () => join(cacheDir(), "usage.json");
const usageLockFile = () => join(cacheDir(), "usage.lock");

/** The last good reading standing in for a failed one, or the failure itself. @param {QuotaReading} failed @param {QuotaReading | undefined} good @param {number} now @returns {QuotaReading} */
function withLastGood(failed, good, now) {
  if (!("error" in failed) || !good || "error" in good || now - good.at > LAST_GOOD_MS || now < good.at) return failed;
  return { ...good, lastGood: failed.error };
}

/** @typedef {{ harness: string, models: string[], reading: QuotaReading, good?: QuotaReading, retryAt?: number }} UsageCache */

/** The usage cache when it belongs to this harness and these models. @param {Adapter} adapter @param {string[]} models @returns {UsageCache | null} */
function usageCache(adapter, models) {
  /** @type {UsageCache | null} */
  const c = readJson(usageFile());
  return c && c.harness === adapter.id && JSON.stringify(c.models) === JSON.stringify(models) && c.reading ? c : null;
}

/** What the cache answers without asking the provider, or null when a new read is due. @param {UsageCache | null} c @param {number} now @returns {QuotaReading | null} */
function usageFromCache(c, now) {
  if (!c) return null;
  if (c.retryAt && now < c.retryAt) return withLastGood({ at: now, error: `${"error" in c.reading ? c.reading.error : "the provider asked to wait"}; asking again after ${clock(c.retryAt)}` }, c.good, now);
  const age = now - c.reading.at;
  if (age < 0) return null;
  if ("error" in c.reading) return age < USAGE_ERROR_RETRY_MS ? withLastGood(c.reading, c.good, now) : null;
  return age < USAGE_REUSE_MS ? c.reading : null;
}

/** Takes the machine-wide lock for a usage read; null while a live process holds it. @returns {(() => void) | null} */
function takeUsageLock() {
  privateDir(cacheDir());
  const file = usageLockFile();
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rmSync(file, { force: true });
    } catch {
      const pid = Number.parseInt((() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })(), 10);
      let young = false;
      try { young = Date.now() - statSync(file).mtimeMs < 60_000; } catch { /* gone */ }
      if (pid > 0 && alive(pid) && young) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

/** @type {Map<string, Promise<QuotaReading>>} */
const usageFlights = new Map();

/**
 * The harness's plan usage, one read at a time per machine: slots of this process share one promise, other processes a
 * lock file and the cached reading. A reading of the last USAGE_REUSE_MS is reused; a failed or refused read is shared
 * only for USAGE_ERROR_RETRY_MS (or the provider's own wait), and the last good reading stands in for it for LAST_GOOD_MS.
 * @param {Config} cfg @param {Adapter} adapter @param {string} bin @param {string[]} models @returns {Promise<QuotaReading>}
 */
export function readQuota(cfg, adapter, bin, models) {
  const key = `${adapter.id}:${models.join(",")}`;
  let p = usageFlights.get(key);
  if (!p) {
    p = readQuotaShared(cfg, adapter, bin, models).finally(() => usageFlights.delete(key));
    usageFlights.set(key, p);
  }
  return p;
}

/** @param {Config} cfg @param {Adapter} adapter @param {string} bin @param {string[]} models @returns {Promise<QuotaReading>} */
async function readQuotaShared(cfg, adapter, bin, models) {
  const hit = usageFromCache(usageCache(adapter, models), Date.now());
  if (hit) return hit;
  let unlock = takeUsageLock();
  for (const started = Date.now(); !unlock && Date.now() - started < USAGE_LOCK_WAIT_MS; unlock = takeUsageLock()) {
    await new Promise((r) => setTimeout(r, 500));
    const again = usageFromCache(usageCache(adapter, models), Date.now());
    if (again) return again;
  }
  if (!unlock) return { at: Date.now(), error: "another helper process is reading the usage" };
  try {
    const now = Date.now();
    const prev = usageCache(adapter, models);
    const raced = usageFromCache(prev, now);
    if (raced) return raced;
    const good = prev && !("error" in prev.reading) ? prev.reading : prev?.good;
    /** @type {{ reading: QuotaReading, retryAt?: number }} */
    let r;
    if (adapter.id === "claude") {
      const token = adapter.token(cfg);
      r = token ? await claudeQuota(token, models) : { reading: { at: now, error: "no Claude login" } };
    } else r = await codexQuota(bin, codexHome(), models);
    const keep = "error" in r.reading ? good : r.reading;
    writePrivate(usageFile(), { harness: adapter.id, models, reading: r.reading, ...(keep && { good: keep }), ...(r.retryAt && { retryAt: r.retryAt }) });
    return withLastGood(r.reading, good, Date.now());
  } finally {
    unlock();
  }
}

/** The wire form of a reading: the most-used window of each kind. @param {QuotaReading | null} r @returns {UsageReading | undefined} */
export function usageOfReading(r) {
  if (!r || "error" in r) return undefined;
  /** @param {string} kind @returns {UsageWindow | null} */
  const top = (kind) => {
    const ws = r.windows.filter((w) => w.kind === kind && Number.isFinite(w.usedPercent)).sort((a, b) => b.usedPercent - a.usedPercent);
    return ws[0] ? { usedPercent: Math.min(100, Math.max(0, ws[0].usedPercent)), resetsAt: ws[0].resetsAt === null ? null : new Date(ws[0].resetsAt).toISOString() } : null;
  };
  return { fiveHour: top("five_hour"), weekly: top("weekly"), at: new Date(r.at).toISOString() };
}

// Control (config dir, the user's): the pause and the park. Status (cache): the last readiness, what the server last said.
const controlFile = () => join(configDir(), "control.json");
/** @returns {{ pause?: Pause, park?: Park }} */
const readControl = () => readJson(controlFile()) ?? {};
/** @param {{ pause?: Pause, park?: Park }} c */
const writeControl = (c) => writePrivate(controlFile(), c);
const helperStatusFile = () => join(cacheDir(), "status.json");

/**
 * The status file: the last readiness and its reading, the server's reserve, and when the server last got a status.
 * @typedef {object} StatusFile
 * @property {Readiness} [readiness]
 * @property {number | null} [until]
 * @property {string} [reason]
 * @property {UsageReading} [usage]
 * @property {Reserve} [reserve]  the effective reserve
 * @property {Reserve} [serverReserve]
 * @property {{ version: string, at: number, reason: string }} [refused]  the server refused this helper version
 * @property {{ at: number, from: string, to: string }} [update]  the last update `work` or `update` made
 * @property {{ version: string, at: number, reason: string }} [updateAvailable]  a newer runner exists that `work` did not apply (git checkout, opt-out) or is about to
 * @property {{ until: number, reason: string }} [cooloff]  the server gives this token no calls until then (repeated lost leases)
 * @property {Hold} [hold]  a `work` process holds its claims: a run's stop, or calls failed in a row
 * @property {number} [at]
 * @property {number} [sentAt]
 * @property {string} [sentKey]
 * @property {HelperStatus} [sent]
 */
/** @returns {StatusFile} */
const readHelperStatus = () => readJson(helperStatusFile()) ?? {};
/** @param {(s: StatusFile) => StatusFile} f */
const updateHelperStatus = (f) => writePrivate(helperStatusFile(), f(readHelperStatus()));

/**
 * A hold the `work` process `pid` put on its claims, shown as the helper's readiness while that process lives and until
 * `until` (null: until it is restarted). `resume` ends it.
 * @typedef {{ pid: number, readiness: Readiness, reason: string, until: number | null }} Hold
 */
/** @param {Readiness} readiness @param {string} reason @param {number | null} until */
const setHold = (readiness, reason, until) => updateHelperStatus((s) => ({ ...s, hold: { pid: process.pid, readiness, reason: redact(reason).slice(0, 300), until } }));
/** Ends this process's hold; with `readiness`, only a hold of that kind. @param {Readiness} [readiness] */
const clearHold = (readiness) => updateHelperStatus(({ hold, ...s }) => (hold && (readiness === undefined || hold.readiness === readiness) ? s : { ...s, ...(hold && { hold }) }));
/** The hold in force now, or null. @param {StatusFile} s @param {number} now */
const holdNow = (s, now) => (s.hold && alive(s.hold.pid) && (s.hold.until === null || now < s.hold.until) ? s.hold : null);

/**
 * @typedef {object} Ready
 * @property {Readiness} readiness
 * @property {number | null} until
 * @property {string} [reason]
 * @property {Reserve} reserve
 * @property {QuotaReading | null} reading
 * @property {Adapter} [adapter]
 * @property {{ bin: string, version: string }} [detected]
 * @property {Partial<Record<Tier, string>>} models
 * @property {boolean} [quotaReady]  cooled off, but the usage would let it claim: the claim asks the server whether the cool-off still holds (an operator may end it)
 * @property {number} [maxTimeoutSeconds]  claims take only calls of at most this timeout (Claim.maxTimeoutSeconds)
 */

/**
 * Works out whether the helper may claim now, keeps it in the status file and reports it to the server when it changed or
 * the last report is STATUS_EVERY_MS old.
 * @param {Config} cfg @param {{ send?: boolean }} [opt] @returns {Promise<Ready>}
 */
async function checkReady(cfg, opt = {}) {
  const now = Date.now();
  const prev = readHelperStatus();
  const reserve = effectiveReserve(prev.serverReserve, cfg.reserve);
  /** @type {Ready} */
  let st;
  /** @type {Adapter | undefined} */
  let adapter;
  try { adapter = adapterOf(cfg); } catch { /* reported below */ }
  const models = adapter ? { ...adapter.defaultTiers, ...cfg.tiers } : { ...cfg.tiers };
  const base = { reserve, reading: null, models, ...(adapter && { adapter }) };
  const problem = platformProblem();
  const hold = holdNow(prev, now);
  if (prev.refused?.version === HELPER_VERSION && now - prev.refused.at < REFUSED_RETRY_MS) st = { ...base, readiness: "version-refused", until: null, reason: `${prev.refused.reason}; update with: ${UPDATE_COMMAND}` };
  else if (hold) st = { ...base, readiness: hold.readiness, until: hold.until, reason: hold.reason };
  else if (!adapter) st = { ...base, readiness: "harness-missing", until: null, reason: `no adapter for harness ${cfg.harness}` };
  else if (problem) st = { ...base, readiness: "sandbox-failed", until: null, reason: problem };
  else {
    const d = adapter.detect(cfg);
    const old = d.version ? adapter.unaudited?.(d.version) : null;
    let canary = null;
    try { requireCanary(); } catch (e) { canary = msg(e); }
    if (!d.bin || !d.version) st = { ...base, readiness: "harness-missing", until: null, reason: `${adapter.id} not found or not runnable` };
    else if (!d.loggedIn) st = { ...base, readiness: "harness-missing", until: null, reason: `no ${adapter.id} login: run \`autocraft harness ${adapter.id}\`` };
    else if (old) st = { ...base, readiness: "harness-missing", until: null, reason: old };
    else if (!Object.keys(models).length) st = { ...base, readiness: "harness-missing", until: null, reason: `no model is set for any tier ("tiers" in ${join(configDir(), "config.json")})` };
    else if (canary) st = { ...base, readiness: "sandbox-failed", until: null, reason: canary.split("\n")[0] ?? canary };
    else if (!loginTakesCalls(adapter.loginRoom?.(cfg) ?? null) && !(adapter.id === "claude" && await refreshClaudeLogin(cfg, d.bin))) {
      // No call fits before the refresh point. The Task Runner refreshes the login itself when it can; otherwise the user must.
      const refreshAt = adapter.loginRoom?.(cfg)?.refreshAt ?? 0;
      st = adapter.id === "claude" && claudeRefreshEnv(cfg) && Date.now() < refreshAt
        ? { ...base, readiness: "login-refresh", until: refreshAt, reason: `no call fits before the Claude login is refreshed: the Task Runner has claude refresh it ${CLAUDE_REFRESH_WINDOW_MS / 60_000} minutes before it ends` }
        : { ...base, readiness: "harness-missing", until: null, reason: claudeRefreshEnv(cfg) ? `the Claude login expires soon and claude did not refresh it (tried again every ${CLAUDE_REFRESH_RETRY_MS / 1000} s); run claude to refresh it` : "the Claude login expires soon; run claude to refresh it" };
    }
    else {
      const control = readControl();
      const cooloff = prev.cooloff && now < prev.cooloff.until && !(control.pause && (control.pause.until === null || now < control.pause.until)) ? prev.cooloff : null;
      // A pause needs no reading; without one the provider is asked only when the answer matters.
      const reading = control.pause && (control.pause.until === null || now < control.pause.until) ? null : await readQuota(cfg, adapter, d.bin, [...new Set(Object.values(models))]);
      const q = quotaReadiness({ pause: control.pause, park: control.park, verdict: quotaVerdict(reading, reserve, Date.now()), readingAt: reading && !("error" in reading) && reading.lastGood === undefined ? reading.at : null });
      if (q.dropPause || q.dropPark) {
        const c = readControl();
        if (q.dropPause) delete c.pause;
        if (q.dropPark) delete c.park;
        writeControl(c);
      }
      // Read after a refresh above: the room of the login the claims will use.
      const room = adapter.loginRoom?.(cfg)?.room;
      const fit = room !== undefined && { maxTimeoutSeconds: Math.max(1, room) };
      st = cooloff
        ? { ...base, readiness: "cooled-off", until: cooloff.until, reason: cooloff.reason, reading, detected: { bin: d.bin, version: d.version }, quotaReady: q.readiness === "ready", ...fit }
        : { ...base, readiness: q.readiness, until: q.until, ...(q.reason && { reason: q.reason }), reading, detected: { bin: d.bin, version: d.version }, ...fit };
    }
  }
  const usage = usageOfReading(st.reading) ?? prev.usage;
  updateHelperStatus((s) => ({ ...s, readiness: st.readiness, until: st.until, reason: st.reason, reserve, at: now, ...(usage ? { usage } : {}) }));
  if (opt.send !== false) await sendStatus(cfg, adapter?.id ?? "claude", st, usage);
  return st;
}

/**
 * The helper's last failure: a server request that failed after its retries, or a failed call's reason. It stays until a
 * later success of the same kind clears it, and goes to the server with each status report.
 * @type {{ text: string, at: string, source: "server" | "call" } | null}
 */
let lastError = null;

/** @param {string} text @param {"server" | "call"} source */
function noteError(text, source) {
  const first = source === "server" && lastError?.source !== "server";
  lastError = { text: redact(text).replace(/\s+/g, " ").trim().slice(0, 300), at: new Date().toISOString(), source };
  if (first) console.error(`autocraft: the server is not answering: ${lastError.text}`);
}

/** @param {"server" | "call"} source */
function clearError(source) {
  if (lastError?.source !== source) return;
  lastError = null;
  if (source === "server") console.error("autocraft: the server answers again");
}

/** The error as the status body carries it. */
const errorField = () => (lastError ? { lastError: { text: lastError.text, at: lastError.at } } : {});

/**
 * A status report, retried like the lease routes (withRetry) up to 4 tries within a minute; the next check or heartbeat
 * sends it again after that.
 * @param {string} server @param {string} route @param {string} bearer @param {unknown} body
 */
const apiRetrying = (server, route, bearer, body) => withRetry(() => api(server, route, bearer, body), { tries: 4, deadline: Date.now() + 60_000, baseMs: 2000 });

/**
 * Reports a status to the server when it differs from the last one sent, or the last report is STATUS_EVERY_MS old; keeps
 * the user's reserve from the reply. A failed report is tried again with the next check.
 * @param {Config} cfg @param {HarnessId} harness @param {{ readiness: Readiness, until: number | null, reason?: string, reserve: Reserve, models: Partial<Record<Tier, string>> }} st @param {UsageReading | undefined} usage
 */
async function sendStatus(cfg, harness, st, usage) {
  const token = credentialOf(cfg);
  if (!cfg.server || !token) return;
  /** @type {HelperStatus} */
  const body = { readiness: st.readiness, ...(st.until !== null && { until: new Date(st.until).toISOString() }), ...(st.reason && { reason: redact(st.reason).slice(0, 300) }), harness, models: st.models, reserve: st.reserve, ...(usage && { usage }), slots: capacity.slots, busy: capacity.busy, ...errorField(), helperVersion: HELPER_VERSION, machine: machine() };
  const key = JSON.stringify({ ...body, usage: undefined });
  const prev = readHelperStatus();
  if (prev.sentKey === key && prev.sentAt !== undefined && Date.now() - prev.sentAt < STATUS_EVERY_MS) return;
  try {
    /** @type {StatusReply} */
    let r;
    let sent = body;
    try { r = await apiRetrying(cfg.server, ROUTES.status, token, body); } catch (e) {
      // A server older than `login-refresh` refuses it: the closest readiness it knows, with the same reason.
      if (!(e instanceof HttpError && e.status === 400 && body.readiness === "login-refresh")) throw e;
      sent = { ...body, readiness: "harness-missing" };
      r = await apiRetrying(cfg.server, ROUTES.status, token, sent);
    }
    updateHelperStatus((s) => ({ ...s, sentAt: Date.now(), sentKey: key, sent, ...(r?.reserve && { serverReserve: r.reserve }) }));
    clearError("server");
  } catch (e) { noteError(msg(e), "server"); /* the next check sends it again */ }
}

/** During a long run: the last status again once it is STATUS_EVERY_MS old, so the server knows the helper is alive. */
async function keepStatusFresh() {
  const cfg = loadConfig(), s = readHelperStatus(), token = credentialOf(cfg);
  if (!cfg.server || !token || !s.sent || (s.sentAt !== undefined && Date.now() - s.sentAt < STATUS_EVERY_MS)) return;
  try {
    const { lastError: _e, ...sent } = s.sent;
    await apiRetrying(cfg.server, ROUTES.status, token, { ...sent, slots: capacity.slots, busy: capacity.busy, ...errorField(), helperVersion: HELPER_VERSION, machine: machine() });
    updateHelperStatus((x) => ({ ...x, sentAt: Date.now() }));
    clearError("server");
  } catch (e) { noteError(msg(e), "server"); /* next heartbeat */ }
}

/** One line for a readiness that is not `ready`. @param {{ readiness: Readiness, until: number | null, reason?: string }} st */
const heldLine = (st) => `${st.readiness}${st.reason ? `: ${st.reason}` : ""}${st.until !== null ? `; until ${clock(st.until)}` : ""}`;

const LIMIT_RE = /you(?:'|’)ve hit your (?:[a-z0-9-]+ )?limit|usage limit reached/i;
const UNIT_MS = /** @type {const} */ ({ d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 });

/** The offset of time zone `zone` from UTC at `ms`, in ms; null for an unknown zone. @param {number} ms @param {string} zone */
function zoneOffset(ms, zone) {
  let parts;
  try { parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms)); } catch { return null; }
  const n = (/** @type {string} */ t) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(ms / 1000) * 1000;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A provider's refusal for its usage limit in a failed run's error text, with the reset it names: an epoch
 * ("usage limit reached|1767225600"), a duration ("resets in 4h42m", "try again in 2 days 3 hours"), or a clock time with a
 * time zone ("resets 3pm (Europe/Berlin)", "resets Nov 21, 3:30pm (UTC)"), capped at PARK_CAP_MS. A clock time without a
 * zone is not trusted (`until` null); no stated time parks for PARK_FALLBACK_MS. Null when the text is no such refusal.
 * @param {string} text @param {number} [now] @returns {{ until: number | null, line: string } | null}
 */
export function parseRefusal(text, now = Date.now()) {
  const m = LIMIT_RE.exec(text);
  if (!m) return null;
  const line = (text.slice(m.index).split("\n")[0] ?? "").trim().slice(0, 200);
  const cap = (/** @type {number} */ t) => Math.min(t, now + PARK_CAP_MS);
  const epoch = /\|(\d{10,13})\b/.exec(text);
  if (epoch) {
    const t = timeOf(Number(epoch[1]));
    if (t !== null && t > now) return { until: cap(t + PARK_GRACE_MS), line };
  }
  const dur = /(?:resets?|try again)\s+in\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (dur) {
    let ms = 0;
    for (const p of (dur[1] ?? "").matchAll(/(\d+)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)/gi)) ms += Number(p[1]) * UNIT_MS[/** @type {"d" | "h" | "m" | "s"} */ ((p[2] ?? "s")[0]?.toLowerCase() ?? "s")];
    if (ms > 0) return { until: cap(now + ms + PARK_GRACE_MS), line };
  }
  const at = /(?:resets?|try again at)\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i.exec(text)
    ?? /(?:resets?|try again at)\s+(?:at\s+)?()()()(\d{1,2}):(\d{2})()(?:\s*\(([^)]+)\))?/i.exec(text);
  if (at) {
    const zone = at[7];
    if (!zone || zoneOffset(now, zone) === null) return { until: null, line };
    let hour = Number(at[4]) % (at[6] ? 12 : 24);
    if (at[6]?.toLowerCase() === "p") hour += 12;
    const minute = Number(at[5] || 0);
    const off = /** @type {number} */ (zoneOffset(now, zone));
    const wall = new Date(now + off);
    const month = at[1] ? MONTHS.indexOf(at[1].toLowerCase()) : wall.getUTCMonth();
    if (month < 0) return { until: null, line };
    const day = at[2] ? Number(at[2]) : wall.getUTCDate();
    const year = at[3] ? Number(at[3]) : wall.getUTCFullYear();
    /** @param {number} addDays */
    const local = (addDays) => {
      const guess = Date.UTC(year, month, day + addDays, hour, minute);
      const o = zoneOffset(guess, zone) ?? 0;
      return guess - (zoneOffset(guess - o, zone) ?? o);
    };
    let t = local(0);
    if (t <= now && !at[1]) t = local(1);
    else if (t <= now && !at[3]) t = Date.UTC(year + 1, month, day, hour, minute) - off;
    if (t > now) return { until: cap(t + PARK_GRACE_MS), line };
    return { until: null, line };
  }
  return { until: now + PARK_FALLBACK_MS, line };
}

// ---------------------------------------------------------------------------
// Mounts.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REF = /^refs\/[A-Za-z0-9._/-]{1,200}$/;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** @param {string} cmd @param {string[]} args @returns {Promise<{ code: number | null, stdout: string, stderr: string }>} */
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { if (stderr.length < 8000) stderr += d; });
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Extracts a tar stream into `dir` with tar. `feed` writes the stream and resolves when its producer
 * finished cleanly, so a failed producer never leaves a partial tree that looks complete.
 * @param {string} dir @param {(stdin: import("node:stream").Writable) => Promise<void>} feed
 */
async function untar(dir, feed) {
  const t = spawn("tar", ["-x", "--no-same-owner", "--no-same-permissions", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  t.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
  t.stdin.on("error", () => {});
  const extracted = new Promise((resolve, reject) => {
    t.on("error", reject);
    t.on("close", (code) => (code === 0 ? resolve(undefined) : reject(new Error(`tar: ${err.trim().slice(0, 300)}`))));
  });
  await Promise.all([feed(t.stdin), extracted]);
}

/**
 * Builds a tree once: into a temporary directory, instruction files removed, then renamed into place, its size in `<dir>.size`
 * for the cache cap. Reused while it exists; each use touches it.
 * @param {string} dir @param {(tmp: string) => Promise<void>} fill
 */
async function cachedTree(dir, fill) {
  if (existsSync(dir)) { const t = new Date(); utimesSync(dir, t, t); return dir; }
  mkdirSync(dirname(dir), { recursive: true });
  const tmp = mkdtempSync(`${dir}.tmp-`);
  try {
    await fill(tmp);
    removeInstructionFiles(tmp);
    const bytes = treeBytes(tmp);
    try { renameSync(tmp, dir); writeFileSync(`${dir}.size`, String(bytes)); } catch (e) { if (!existsSync(dir)) throw e; }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dir;
}

/** Bytes of the files below `dir` (symlinks not followed). @param {string} dir */
function treeBytes(dir) {
  let n = 0;
  /** @param {string} d */
  const walk = (d) => {
    let names;
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else try { n += lstatSync(p).size; } catch { /* gone */ }
    }
  };
  walk(dir);
  return n;
}

/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();
/** Runs `fn` after every earlier call with the same key (one fetch per bare repo at a time). @template T @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>} */
function serial(key, fn) {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/** A public repo at a commit, from GitHub through the bare-clone cache. @param {{ owner: string, repo: string, sha: string, ref?: string }} m */
async function gitTree(m) {
  if (!NAME.test(m.owner) || !NAME.test(m.repo) || !SHA.test(m.sha) || (m.ref !== undefined && (!REF.test(m.ref) || m.ref.includes("..")))) throw new Error(`bad git mount ${m.owner}/${m.repo}@${m.sha}`);
  const bare = join(cacheDir(), "git", m.owner, `${m.repo}.git`);
  const tree = join(cacheDir(), "trees", "git", m.owner, m.repo, m.sha);
  if (existsSync(tree)) return cachedTree(tree, async () => {});
  mkdirSync(dirname(bare), { recursive: true });
  // One fetch per bare repo at a time, in this process (serial) and across the user's helper processes (the lock file).
  await serial(bare, () => withLockFile(`${bare}.lock`, async () => {
    if (!existsSync(join(bare, "HEAD"))) {
      mkdirSync(bare, { recursive: true });
      const init = await run("git", ["init", "--bare", "-q", bare]);
      if (init.code !== 0) throw new Error(`git init: ${init.stderr.trim()}`);
      await run("git", ["-C", bare, "remote", "add", "origin", `https://github.com/${m.owner}/${m.repo}.git`]);
    }
    // The bare repo's time is its last use: prune removes repos unused for BARE_TTL_MS.
    const now = new Date();
    utimesSync(bare, now, now);
    const has = async () => (await run("git", ["-C", bare, "cat-file", "-e", `${m.sha}^{commit}`])).code === 0;
    if (await has()) return;
    const bySha = await run("git", ["-C", bare, "fetch", "-q", "--depth", "1", "origin", m.sha]);
    if (bySha.code !== 0 && m.ref) await run("git", ["-C", bare, "fetch", "-q", "--depth", "1", "origin", m.ref]);
    if (!(await has())) throw new Error(`could not fetch ${m.owner}/${m.repo}@${m.sha.slice(0, 12)}: ${bySha.stderr.trim().slice(0, 200)}`);
    // Each fetch adds a pack; `gc --auto` packs them once enough piled up, checked at most once a day per repo.
    const stamp = join(bare, "autocraft-gc");
    let gcAt = 0;
    try { gcAt = statSync(stamp).mtimeMs; } catch { /* never */ }
    if (Date.now() - gcAt > GC_EVERY_MS) { await run("git", ["-C", bare, "gc", "--auto", "--quiet"]); writeFileSync(stamp, ""); }
  }));
  return cachedTree(tree, (tmp) => untar(tmp, (stdin) => new Promise((resolve, reject) => {
    const a = spawn("git", ["-C", bare, "archive", "--format=tar", m.sha], { env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] });
    a.stdout.pipe(stdin);
    a.on("error", reject);
    a.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git archive ${m.owner}/${m.repo}@${m.sha.slice(0, 12)} failed`))));
  })));
}

/**
 * A tree from the server's tarball route. A transient failure (5xx, reset, a stream cut off) starts the download again in a
 * fresh directory, until shortly before the preparation cap; `signal` ends it.
 * @param {string} server @param {string} secret @param {{ repo: string, sha: string }} m @param {AbortSignal} [signal]
 */
async function tarballTree(server, secret, m, signal) {
  if (!NAME.test(m.repo) || !SHA.test(m.sha)) throw new Error(`bad tarball mount ${m.repo}@${m.sha}`);
  const tree = join(cacheDir(), "trees", "tarball", m.repo, m.sha);
  const route = `${ROUTES.tarball}?repo=${encodeURIComponent(m.repo)}&sha=${m.sha}`;
  return withRetry(() => cachedTree(tree, async (tmp) => {
    const timeout = AbortSignal.timeout(10 * 60_000);
    const res = await fetch(`${server}${route}`, { headers: { Authorization: `Bearer ${secret}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (res.status === 410) throw new Gone("the lease is gone");
    if (!res.ok || !res.body) throw new HttpError(`tarball ${m.repo}`, res.status, res.ok ? "no body" : await res.text().catch(() => ""), retryAfterMs(res.headers.get("retry-after")));
    const body = /** @type {any} */ (res.body);
    await untar(tmp, (stdin) => pipeline(Readable.fromWeb(body), stdin));
  }), { deadline: Date.now() + PREPARE_MAX_MS - RETRY_MARGIN_MS, ...(signal && { signal }) });
}

/** Inline files into a fresh directory of the task. @param {string} dir @param {{ name: string, base64: string }[]} files */
function filesTree(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const parts = f.name.split("/");
    if (!f.name || f.name.startsWith("/") || parts.some((c) => c === "" || c === "." || c === "..")) throw new Error(`bad file name in bundle: ${f.name}`);
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...parts), Buffer.from(f.base64, "base64"));
  }
  return dir;
}

/** @param {string} server @param {string} secret @param {TaskBundle} b @param {string} taskDir @param {AbortSignal} [signal] */
async function prepareMounts(server, secret, b, taskDir, signal) {
  return Promise.all(b.mounts.map(async (m, i) => {
    checkMountPath(m.path);
    const host = m.kind === "git" ? await gitTree(m) : m.kind === "tarball" ? await tarballTree(server, secret, m, signal) : m.kind === "files" ? filesTree(join(taskDir, "files", String(i)), m.files) : null;
    if (!host) throw new Error(`unknown mount kind ${/** @type {any} */ (m).kind}`);
    return { host, path: m.path };
  }));
}

// ---------------------------------------------------------------------------
// Platform.

/** Why model calls can't run here, or null. */
function platformProblem() {
  if (process.platform === "darwin") return existsSync(SANDBOX_EXEC) ? null : `sandbox-exec is missing (${SANDBOX_EXEC})`;
  if (process.platform !== "linux") return "autocraft runs model calls only on Linux, WSL and macOS: it confines the harness with bubblewrap or sandbox-exec.";
  if (!existsSync(BWRAP)) return `bubblewrap is missing (${BWRAP}); install the bubblewrap package.`;
  return null;
}

/** @param {Config} cfg */
function adapterOf(cfg) {
  const a = ADAPTERS[cfg.harness ?? "claude"];
  if (!a) throw new Error(`no adapter for harness ${cfg.harness}`);
  return a;
}

/** @param {Config} cfg */
function needLogin(cfg) {
  const agentToken = credentialOf(cfg);
  if (cfg.server && agentToken) return { server: cfg.server, agentToken };
  const p = loadCredentials().pending;
  if (p?.verifyUrl) throw new Error(`the login waits for approval at ${p.verifyUrl} (code ${p.userCode}): approve it there, then \`autocraft login --wait\``);
  throw new Error("not logged in: run `autocraft login <server-url>`");
}

// ---------------------------------------------------------------------------
// Claiming and running.

const newClaimId = () => randomBytes(16).toString("hex");

/** Seconds a protocol 4 claim lets the server hold it open while nothing is queued (Claim.wait). */
export const CLAIM_WAIT_S = 25;
/** How long a server that refused the current protocol is asked with an older one before the current one is tried again. */
const PROTOCOL_FALLBACK_MS = 3600_000;
/** The older protocol the server accepted after it answered 409 to the current one (a server not yet updated), and until when claims use it. */
let fallback = { protocol: PROTOCOL_VERSION, until: 0 };

/**
 * Sends a claim: with the current protocol, or with the older one the server accepted while it refuses the current one.
 * A 409 is asked again at once with each older protocol in turn (a held wait from 4 on); only a 409 to the oldest is a
 * refusal of this runner.
 * `signal` (a `work` stopping) ends a held claim.
 * @param {string} server @param {string} token @param {Omit<Claim, "protocol" | "wait">} base @param {AbortSignal} [signal] @returns {Promise<ClaimReply>}
 */
export async function claimRequest(server, token, base, signal) {
  const send = (/** @type {number} */ protocol) => {
    const hold = protocol >= 4 ? CLAIM_WAIT_S : 0;
    /** @type {Claim} */
    const claim = { ...base, protocol, ...(hold && { wait: hold }) };
    // Retries resend the same request id, so a claim whose reply was lost gets its lease back instead of leaving it to expire.
    return withRetry(() => api(server, ROUTES.claim, token, claim, { timeoutMs: scaled(hold * 1000) + 30_000, ...(signal && { signal }) }), { tries: 5, deadline: Date.now() + scaled(hold * 1000) + Math.min(scaled(60_000), CLAIM_ID_TTL_MS / 2), ...(signal && { signal }) });
  };
  if (Date.now() < fallback.until) return send(fallback.protocol);
  const tries = [PROTOCOL_VERSION, ...OLDER_PROTOCOLS];
  for (let i = 0; ; i++) {
    try {
      const reply = await send(tries[i]);
      if (i > 0) fallback = { protocol: tries[i], until: Date.now() + PROTOCOL_FALLBACK_MS };
      return reply;
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409) || i === tries.length - 1) throw e;
    }
  }
}

/** The lane fields of a claim. The server rejects interactiveLane together with any other lane field, so an interactive claim carries only that one. @param {boolean} fastLane @param {boolean} ownLane @param {boolean} withOwnLane @param {boolean} interactiveLane */
export function claimLaneFlags(fastLane, ownLane, withOwnLane, interactiveLane) {
  if (interactiveLane) return { interactiveLane: true };
  return { ...(fastLane && { fastLane: true }), ...(ownLane && { ownLane: true }), ...(withOwnLane && !ownLane && { withOwnLane: true }) };
}

/**
 * Claims one call when the helper is ready (checkReady); otherwise claims nothing and says why (`held`). On macOS the claim
 * names the path root of slot `slot` (a free one when not given), which the lease keeps, and offers only that slot's sessions.
 * A lease that comes back with a higher reserve than the one checked, which the usage no longer allows, is released.
 * `fastLane`: the claim comes from the fast-lane slot (Claim.fastLane); `ownLane`: from the own lane (Claim.ownLane). `requestId`:
 * a caller whose last claim failed in transit passes that claim's id again, so the server answers with the lease it may have taken.
 * @param {Config} cfg @param {number} [slot] @param {boolean} [fastLane] @param {string} [requestId] @param {AbortSignal} [signal] @param {boolean} [ownLane] @param {boolean} [withOwnLane] @param {boolean} [interactiveLane] @returns {Promise<ClaimReply | { held: Ready }>}
 */
async function claimOnce(cfg, slot, fastLane = false, requestId = newClaimId(), signal = undefined, ownLane = false, withOwnLane = false, interactiveLane = false) {
  const { server, agentToken } = needLogin(cfg);
  const ready = await checkReady(cfg);
  const cooled = ready.readiness === "cooled-off" && ready.quotaReady === true;
  if ((ready.readiness !== "ready" && !cooled) || !ready.adapter || !ready.detected) return { held: ready };
  const adapter = ready.adapter, d = ready.detected, tiers = ready.models;
  const mac = process.platform === "darwin";
  const n = mac ? slot ?? pickSlot(slotBase()) : undefined;
  const root = n === undefined ? undefined : slotRoot(slotBase(), n);
  const claim = { requestId, helperVersion: HELPER_VERSION, harness: adapter.id, harnessVersion: d.version, tiers, efforts: Object.fromEntries(Object.keys(tiers).map((t) => [t, adapter.maxEffort])), ...(cfg.repos && { repos: cfg.repos }), sessions: heldSessions(n), ...(root && { root }), ...claimLaneFlags(fastLane, ownLane, withOwnLane, interactiveLane), ...(ready.maxTimeoutSeconds !== undefined && { maxTimeoutSeconds: ready.maxTimeoutSeconds }) };
  /** @type {ClaimReply} */
  let reply;
  try {
    reply = await claimRequest(server, agentToken, claim, signal);
  } catch (e) {
    // Another protocol version, or a helper older than the server accepts: nothing runs until the helper is updated.
    if (e instanceof HttpError && e.status === 409) {
      updateHelperStatus((s) => ({ ...s, refused: { version: HELPER_VERSION, at: Date.now(), reason: msg(e).slice(0, 300) } }));
      await checkReady(cfg);
    }
    throw e;
  }
  const raised = reply.reserve && JSON.stringify(effectiveReserve(reply.reserve, cfg.reserve)) !== JSON.stringify(ready.reserve);
  if (reply.reserve) updateHelperStatus((s) => ({ ...s, serverReserve: reply.reserve }));
  if (reply.lease) {
    /** @type {LeaseRecord} */
    const rec = { secret: reply.lease.secret, title: reply.lease.title, requiredHelper: reply.lease.requiredHelper, server, claimedAt: Date.now(), ...(root && { slot: n, root }) };
    writePrivate(leaseFile(reply.lease.id), rec);
    if (raised) {
      const again = await checkReady(cfg);
      if (again.readiness !== "ready") {
        /** @type {Release} */
        const body = { reason: `the user's usage reserve rose: ${heldLine(again)}`.slice(0, 300) };
        try { await withRetry(() => api(server, ROUTES.release, reply.lease.secret, body), { deadline: rec.claimedAt + LEASE_GRACE_MS - HEARTBEAT_MS }); } catch { /* the lease expires on its own */ }
        dropLease(reply.lease.id);
        return { held: again };
      }
    }
  } else if (reply.until !== undefined && reply.until > Date.now()) {
    // A cool-off: the helper says so in its readiness and asks again with each hold check (an operator may end it early).
    const until = reply.until;
    updateHelperStatus((s) => ({ ...s, cooloff: { until, reason: reply.reason ?? "the server gives this helper no calls for a while" } }));
    return { held: await checkReady(cfg) };
  }
  if (cooled) {
    updateHelperStatus(({ cooloff: _c, ...s }) => s);
    await checkReady(cfg);
  } else if (raised && !reply.lease) await checkReady(cfg);
  return reply;
}

/**
 * Runs one claimed lease to its end: heartbeats from the start, bundle, mounts, sandboxed harness, submit.
 * Returns the status line; never throws. `slotHeld`: the caller holds the lease's slot (macOS).
 * Anything that goes wrong before the harness spawns gives the call back (no attempt used); only a run's failure is
 * reported as `ok: false`. Every report is retried until shortly before the lease's deadline, and recorded as submitted,
 * failed or released only once the server accepted it.
 * @param {Config} cfg @param {number} id @param {{ signal?: AbortSignal, slotHeld?: boolean }} [opt]
 * @returns {Promise<RunStatus>}
 */
async function runLease(cfg, id, opt = {}) {
  const lease = readLease(id);
  /** @param {RunStatus["state"]} state @param {string} line @param {RunHold} [hold] @param {boolean} [noStrike] @returns {RunStatus} */
  const end = (state, line, hold, noStrike) => { /** @type {RunStatus} */ const s = { state, line: redact(line), at: Date.now(), ...(hold && { hold }), ...(noStrike && { noStrike: true }) }; writeStatus(id, s); if (state !== "running") dropLease(id); return s; };
  if (!lease) return end("failed", `failed: no lease ${id} was claimed on this machine`);
  secretsInUse.add(lease.secret);
  writeStatus(id, { state: "running", line: `running: ${lease.title}`, pid: process.pid, at: Date.now() });
  const started = Date.now();
  const beat = heartbeats(lease);
  const prepareEnd = lease.claimedAt + PREPARE_MAX_MS;
  // The preparation stops early enough that its release still has the full retry margin before the server's cap.
  const prepTimeout = AbortSignal.timeout(Math.max(1, prepareEnd - 2 * RETRY_MARGIN_MS - Date.now()));
  // Ends the preparation's requests: Ctrl-C, the lease gone, or the preparation cap.
  const prep = AbortSignal.any([beat.gone, prepTimeout, ...(opt.signal ? [opt.signal] : [])]);
  let timeoutSeconds = 0;
  // The server's deadline: the preparation cap, then the call's time limit from the first `running` heartbeat.
  const deadline = () => (beat.runStart === null ? prepareEnd : beat.runStart + timeoutSeconds * 1000 + LEASE_GRACE_MS) - RETRY_MARGIN_MS;
  /** @param {string} route @param {unknown} [body] @param {AbortSignal} [signal] */
  const call = (route, body, signal) => withRetry(() => api(lease.server, route, lease.secret, body, signal && { signal }), { deadline: deadline(), ...(signal && { signal }) });
  const lost = () => end("lost", `lost: ${lease.title}: the lease was withdrawn`);
  /** @param {string} what @param {unknown} e */
  const undelivered = (what, e) => (e instanceof Gone ? lost() : end("lost", `lost: ${lease.title}: ${what} did not reach the server: ${msg(e)}`));
  /** @param {string} error @param {Usage} [usage] @param {boolean} [refused] */
  const fail = async (error, usage, refused) => {
    /** @type {Submit} */
    const body = { ok: false, error: redact(error).slice(0, 2000), ...(usage && { usage }), durationMs: Date.now() - started, ...(refused && { refused: true }) };
    try { await call(ROUTES.submit, body); } catch (e) { return undelivered(`the failure (${error})`, e); }
    noteError(`${lease.title}: ${error}`, "call");
    return end("failed", `failed: ${lease.title}: ${error}`);
  };
  /**
   * The helper's own fault, not the call's: the call goes back to the queue without using an attempt.
   * @param {string} reason @param {RunHold} [hold] the helper can take no call for a while @param {boolean} [noStrike] RunStatus.noStrike
   */
  const giveBack = async (reason, hold, noStrike) => {
    /** @type {Release} */
    const body = { reason: redact(reason).slice(0, 300) };
    try { await call(ROUTES.release, body); } catch (e) { return undelivered(`the release (${reason})`, e); }
    return end("released", `released: ${lease.title}: ${reason}`, hold, noStrike);
  };
  /** Why the preparation stopped, when one of its signals did. */
  const prepStopped = () => (opt.signal?.aborted ? "stopped on the helper" : prepTimeout.aborted ? `preparing took longer than ${(PREPARE_MAX_MS - 2 * RETRY_MARGIN_MS) / 60_000} min` : null);
  /** @type {string[]} */
  const tokens = [];
  let releaseSlot = () => {};
  let taskDir = "", unlock = () => {};
  try {
    if (compareVersions(HELPER_VERSION, lease.requiredHelper) < 0) return await giveBack(`helper ${HELPER_VERSION} is older than the required ${lease.requiredHelper}; update with: ${UPDATE_COMMAND}, then restart the helper`, { readiness: "version-refused", ms: null });
    const problem = platformProblem();
    if (problem) return await giveBack(problem, { readiness: "sandbox-failed", ms: STOP_HOLD_MS });
    if (process.platform === "darwin") {
      if (lease.root === undefined || lease.slot === undefined) return await giveBack("the lease was claimed without a slot");
      if (!opt.slotHeld) {
        const r = takeSlot(slotBase(), lease.slot);
        if (!r) return await giveBack(`slot ${lease.slot} is busy with another run`);
        releaseSlot = r;
      }
    }
    try { prune(); } catch { /* best effort */ }
    const adapter = adapterOf(cfg);
    const d = adapter.detect(cfg);
    // A login read can miss once (a credentials file rewritten in place, a failed Keychain read): read it again first.
    let token = adapter.token(cfg) ?? "";
    if (!token) { await sleep(2000); token = adapter.token(cfg) ?? ""; }
    if (!d.bin) return await giveBack(`${adapter.id} binary missing on the helper`, { readiness: "harness-missing", ms: STOP_HOLD_MS });
    if (!token) return await giveBack(`the ${adapter.id} login could not be read`, { readiness: "harness-missing", ms: TOKEN_HOLD_MS });
    tokens.push(token); secretsInUse.add(token);
    if (adapter.exclusive) {
      const release = takeHarnessLock(adapter.id);
      if (!release) return await giveBack(`another ${adapter.id} call is running on this helper, and they share one login`);
      unlock = release;
    }
    const old = d.version && adapter.unaudited?.(d.version);
    if (old) return await giveBack(old, { readiness: "harness-missing", ms: STOP_HOLD_MS });
    const unsafe = adapter.preflight?.(d.bin, token);
    if (unsafe) return await giveBack(unsafe, { readiness: "harness-missing", ms: STOP_HOLD_MS });
    /** @type {TaskBundle} */
    const b = await call(ROUTES.bundle, undefined, prep);
    // A bundle of the wrong shape is the server's fault, the same for every helper: the call fails rather than circling.
    if (typeof b?.callId !== "number" || typeof b.stdin !== "string" || !Array.isArray(b.mounts) || !Array.isArray(b.mcpServers)) return await fail("unreadable bundle");
    timeoutSeconds = b.timeoutSeconds;
    const model = { ...adapter.defaultTiers, ...cfg.tiers }[b.tier];
    if (!model) return await giveBack(`no ${adapter.id} model is set for the ${b.tier} tier ("tiers" in the config)`);
    let runToken = token;
    if (adapter.tokenFor) {
      let t = adapter.tokenFor(cfg, b.timeoutSeconds);
      if ("problem" in t && t.problem !== CLAUDE_LOGIN_EXPIRES) { await sleep(2000); t = adapter.tokenFor(cfg, b.timeoutSeconds); }
      // A call too long for the login goes back without a hold: shorter calls still fit, and readiness says when none does.
      if ("problem" in t) return t.problem === CLAUDE_LOGIN_EXPIRES ? await giveBack(t.problem, undefined, true) : await giveBack(t.problem, { readiness: "harness-missing", ms: TOKEN_HOLD_MS });
      runToken = t.token;
    }
    tokens.push(runToken); secretsInUse.add(runToken);
    privateDir(join(cacheDir(), "tasks"));
    taskDir = mkdtempSync(join(cacheDir(), "tasks", `${b.callId}-`));
    const late = adapter.tokenFor && (() => { const t = adapter.tokenFor?.(cfg, b.timeoutSeconds); return t && "problem" in t && t.problem === CLAUDE_LOGIN_EXPIRES ? t.problem : null; });
    const out = await execute(b, { adapter, bin: d.bin, token: runToken, model, taskDir, lease, root: lease.root ?? "", ...(lease.slot !== undefined && { slot: lease.slot }), ...(opt.signal && { signal: opt.signal }), prep, beat, ...(late && { late }) });
    if ("giveBack" in out) { const stopped = prepStopped(); return await giveBack(stopped ?? out.giveBack, undefined, !stopped && out.noStrike); }
    if ("fail" in out) return await fail(out.fail, out.usage);
    const { r, reply, tools } = out;
    if (r.gone) return lost();
    if (r.timedOut) return await fail(`timed out after ${b.timeoutSeconds} s`, reply.usage);
    if (r.stopped) return await giveBack("stopped on the helper");
    if (!reply.ok) {
      // The provider's usage limit: the call goes back without using an attempt, and the helper parks until the reset.
      const refusal = parseRefusal(`${reply.error ?? ""}\n${r.stderr}`);
      if (refusal) {
        const c = readControl();
        writeControl({ ...c, park: { until: refusal.until, at: Date.now(), reason: `the provider refused a run: ${refusal.line}` } });
        try { await checkReady(cfg); } catch { /* reported with the next check */ }
        return await giveBack(`the provider refused the run for its usage limit: ${refusal.line}`);
      }
      return await fail(`${reply.error ?? "no result"} (exit ${r.code}) ${r.stderr.trim().slice(-300)}`.trim(), reply.usage, reply.refused);
    }
    const usage = reply.usage ?? { inputTokens: 0, outputTokens: 0 };
    /** @type {Submit} */
    const body = { ok: true, text: reply.text, model: reply.model, usage, ...(reply.modelUsage && { modelUsage: reply.modelUsage }), ...(reply.costUsd !== undefined && { costUsd: reply.costUsd }), ...(reply.turns !== undefined && { turns: reply.turns }), ...(reply.sessionId && { sessionId: reply.sessionId }), ...(tools.length > 0 && { tools }), durationMs: Date.now() - started };
    /** @type {SubmitReply} */
    let s;
    // A finished reply is never turned into a failure: the same body is retried until the server answers it (accepted, 410
    // or another final 4xx), through an outage of the server up to SUBMIT_OUTAGE_MS past the lease's deadline.
    // A proxy's refusal is said once and retried like an outage.
    let blockedSaid = false;
    const submit = () => api(lease.server, ROUTES.submit, lease.secret, body).catch((e) => {
      if (e instanceof ProxyBlocked && !blockedSaid) { blockedSaid = true; console.log(`${lease.title}: ${msg(e)}; retrying the reply`); }
      throw e;
    });
    try { s = await withRetry(submit, { deadline: deadline() + SUBMIT_OUTAGE_MS }); } catch (e) { return undelivered("the reply", e); }
    if (!s.accepted) return end("failed", `rejected: ${lease.title}: ${s.reason ?? "no reason given"}`);
    clearError("call");
    return end("submitted", `submitted: ${lease.title}, ${kTokens(tokensOf(usage))} tokens`);
  } catch (e) {
    if (e instanceof Gone || beat.gone.aborted) return lost();
    if (beat.runStart === null) return await giveBack(prepStopped() ?? `preparing failed: ${msg(e)}`);
    return await fail(msg(e));
  } finally {
    beat.stop();
    unlock();
    releaseSlot();
    if (taskDir) rmSync(taskDir, { recursive: true, force: true });
    secretsInUse.delete(lease.secret);
    for (const t of tokens) secretsInUse.delete(t);
  }
}

/**
 * Runs one bundle in the sandbox: its files (in the slot on macOS), the session store, the file tools and the harness.
 * Private trees and MCP servers need the lease; `try` runs without one. With a lease, `prep` ends the preparation's requests
 * and `beat` carries its heartbeats; nothing spawns once either ended or `signal` aborted.
 * @param {TaskBundle} b
 * `late`: why the call may no longer start once its files are ready (its login no longer outlasts it), or null.
 * @param {{ adapter: Adapter, bin: string, token: string, model: string, taskDir: string, lease: LeaseRecord | null, root: string, slot?: number, signal?: AbortSignal, prep?: AbortSignal, beat?: ReturnType<typeof heartbeats>, late?: () => string | null }} x
 * @returns {Promise<{ giveBack: string, noStrike?: boolean } | { fail: string, usage?: Usage } | { r: Awaited<ReturnType<typeof harness>>, reply: Reply, tools: SubmitTool[] }>}
 */
async function execute(b, x) {
  const { adapter } = x;
  const server = x.lease?.server ?? "", secret = x.lease?.secret ?? "";
  let mounts;
  try { mounts = await prepareMounts(server, secret, b, x.taskDir, x.prep); } catch (e) {
    if (e instanceof Gone || x.prep?.aborted) throw e;
    return { giveBack: `setting up the files failed: ${msg(e)}` };
  }
  for (const n of b.mcpServers) if (!NAME.test(n)) return { fail: `bad MCP server name ${n}` };
  const mcp = b.mcpServers.length ? JSON.stringify(mcpConfig(server, b.mcpServers, secret)) : "";
  // Session store: a follow-up continues its parent's; a call whose arguments keep the session gets a new one.
  let sessionDir, resumeId;
  if (b.resume) {
    const parent = readSession(b.resume.parentCallId);
    if (!parent || parent.slot !== x.slot) return { fail: `the session of call ${b.resume.parentCallId} is no longer held by this helper${parent ? " in this slot" : ""}` };
    sessionDir = parent.dir; resumeId = parent.sessionId;
  } else if (b.keepSession) {
    privateDir(sessionsDir());
    sessionDir = mkdtempSync(join(sessionsDir(), "store-"));
  }
  let mcpFile = "";
  /** @type {AdapterTask["mac"]} */
  let mac;
  if (x.root) {
    const hint = b.hints.claude;
    const plan = slotPlan(x.root, mounts, argValues(hint?.args ?? [], "--add-dir"));
    await fillSlot(x.root, plan, [...(mcp ? [{ name: "mcp.json", content: mcp }] : []), ...(adapter.id === "claude" && hint?.agents !== undefined ? [{ name: "agents.json", content: hint.agents }] : [])]);
    mounts = plan.mounts;
    if (mcp) mcpFile = `${x.root}/mcp.json`;
    const install = adapter.install(x.bin);
    const writes = [...(sessionDir ? [realpathSync(sessionDir)] : []), ...(adapter.id === "codex" ? [realpathSync(x.token)] : [])];
    const profile = join(x.taskDir, "profile.sb");
    writeFileSync(profile, macProfile({ deny: macDenied(realpathSync(homedir())), files: install.files, dirs: install.dirs, writes }), { mode: 0o600 });
    mac = { root: x.root, profile, install };
  } else if (mcp) {
    mcpFile = join(x.taskDir, "mcp.json");
    writeFileSync(mcpFile, mcp, { mode: 0o600 });
  }
  let files = /** @type {{ url: string, token: string, close: () => void } | null} */ (null);
  try {
    if (adapter.fileTools) files = await serveFileTools(mounts);
    if (x.beat?.gone.aborted || x.prep?.aborted || x.signal?.aborted) {
      if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
      throw x.beat?.gone.aborted ? new Gone("the lease is gone") : new Error("stopped before the run");
    }
    const late = x.late?.();
    if (late) {
      if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
      return { giveBack: late, noStrike: true };
    }
    const c = adapter.command({ bundle: b, model: x.model, bin: x.bin, token: x.token, mounts, taskDir: x.taskDir, mcpFile, sessionDir, resumeId, lease: { server, secret }, ...(files && { files: { url: files.url, token: files.token } }), ...(mac && { mac }) });
    const r = await harness(c, b, x.beat ?? null, x.signal, adapter, x.root);
    const reply = adapter.parse(r.stdout, x.model);
    if (r.gone) {
      if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
      return { r, reply, tools: [] };
    }
    // A tool the call may not use: the reply never leaves this machine, and the session is not kept. Codex's rollout is in
    // its home (the helper's own, on macOS too), which `token` names.
    /** @type {{ problem: string | null, tools?: SubmitTool[] } | undefined} */
    const checked = r.unexpected ? { problem: r.unexpected } : adapter.verify?.({ token: x.token, sessionId: reply.sessionId, servers: b.mcpServers, keep: !!sessionDir });
    const tools = checked?.tools ?? adapter.tools?.(r.stdout, r.stamps) ?? [];
    if (checked?.problem) {
      if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
      return { fail: checked.problem, ...(reply.usage && { usage: reply.usage }) };
    }
    if (sessionDir && reply.sessionId) writePrivate(join(sessionsDir(), `${b.callId}.json`), { sessionId: reply.sessionId, dir: sessionDir, at: Date.now(), ...(x.slot !== undefined && { slot: x.slot }) });
    else if (sessionDir && !resumeId) rmSync(sessionDir, { recursive: true, force: true });
    return { r, reply, tools };
  } finally {
    files?.close();
  }
}

/** Bytes of the harness's plain-text output (lines that are no event) kept for the error line. */
const STDOUT_TAIL = 4000;

/**
 * Runs the sandboxed harness: stdin in, stopped at the bundle's timeout, when the lease is gone or when `signal` aborts.
 * With a lease, the spawn moves its heartbeats to `running` (the time limit counts from there, here and on the server)
 * and they carry the last progress line. Progress lines name paths without the slot's root. Of the output it keeps only
 * what the adapter reads (`compact`), and the tail of plain-text lines, which goes with stderr.
 * On macOS the harness runs in its own process group, recorded beside the slot, so a helper that crashed leaves a group
 * the next taker of the slot can stop (stopOrphan).
 * @param {{ cmd: string, args: string[], env: Record<string, string>, cwd?: string }} c @param {TaskBundle} b @param {ReturnType<typeof heartbeats> | null} beat @param {AbortSignal | undefined} signal @param {Adapter} adapter @param {string} root
 */
function harness(c, b, beat, signal, adapter, root) {
  return new Promise((resolve) => {
    const group = process.platform === "darwin" && !!root;
    const p = spawn(c.cmd, c.args, { env: c.env, stdio: ["pipe", "pipe", "pipe"], ...(c.cwd && { cwd: c.cwd }), ...(group && { detached: true }) });
    beat?.running();
    const groupFile = `${root}.harness`;
    if (group && p.pid) {
      const started = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(p.pid)], { encoding: "utf8", timeout: 10_000 }).stdout?.trim();
      try { writeFileSync(groupFile, JSON.stringify({ pgid: p.pid, started }), { mode: 0o600 }); } catch { /* the slot lock still guards the slot */ }
    }
    let stderr = "", partial = "", tail = "", gone = false, timedOut = false, stopped = false, settled = false;
    /** @type {string[]} the compacted output lines */
    const kept = [];
    /** @type {string[]} the arrival time of each kept line */
    const stamps = [];
    /** @type {string | undefined} */
    let unexpected;
    /** @param {NodeJS.Signals} sig */
    const signalRun = (sig) => { try { if (group && p.pid) process.kill(-p.pid, sig); else p.kill(sig); } catch { /* gone */ } };
    const kill = () => { signalRun("SIGTERM"); setTimeout(() => signalRun("SIGKILL"), 5000).unref(); };
    /** @param {string} l @param {string} at */
    const keep = (l, at) => {
      const k = adapter.compact(l);
      if (k !== null) { kept.push(k); stamps.push(at); }
      else if (!l.startsWith("{") && l.trim()) tail = `${tail}${l}\n`.slice(-STDOUT_TAIL);
    };
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => {
      const lines = (partial + d).split("\n");
      partial = lines.pop() ?? "";
      const at = new Date().toISOString();
      for (const l of lines) {
        keep(l, at);
        const x = adapter.progress(root ? l.split(root).join("") : l);
        if (x) beat?.progress(x);
        const bad = !unexpected && adapter.guard?.(l, b.mcpServers);
        if (bad) { unexpected = bad; kill(); }
      }
    });
    p.stderr.on("data", (d) => { if (stderr.length < 16_000) stderr += d; });
    p.stdin.on("error", () => {});
    p.stdin.end(b.stdin);
    const timer = setTimeout(() => { timedOut = true; kill(); }, b.timeoutSeconds * 1000);
    const onAbort = () => { stopped = true; kill(); };
    const onGone = () => { gone = true; kill(); };
    signal?.addEventListener("abort", onAbort);
    beat?.gone.addEventListener("abort", onGone);
    /** @param {number | null} code */
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort); beat?.gone.removeEventListener("abort", onGone);
      if (group) rmSync(groupFile, { force: true });
      if (partial) keep(partial, new Date().toISOString());
      const text = tail ? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}stdout: ${tail}` : stderr;
      resolve({ code, stdout: kept.join("\n"), stamps, stderr: redact(text), gone, timedOut, stopped, unexpected });
    };
    p.on("error", (e) => { stderr += String(e); done(-1); });
    p.on("close", done);
  });
}

// ---------------------------------------------------------------------------
// Commands.

/** Reads one secret from stdin; on a terminal the input is not echoed. @param {string} prompt @returns {Promise<string>} */
async function readSecret(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let s = "";
    for await (const chunk of stdin) s += chunk;
    return s.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let s = "";
    /** @param {string} d */
    const on = (d) => {
      for (const ch of d) {
        if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", on); process.stderr.write("\n"); resolve(s.trim()); return; }
        if (ch === "\u0003") { stdin.setRawMode(false); process.stderr.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1); else s += ch;
      }
    };
    stdin.on("data", on);
  });
}

/** @param {string} url */
function serverUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("the server URL must be https (http only for localhost)");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** A new Task Runner credential: `acrun_` and 32 random bytes. */
const newCredential = () => `acrun_${randomBytes(32).toString("base64url")}`;
/** What the server keeps of a credential: lowercase hex SHA-256 of the whole string. @param {string} c */
export const credentialHash = (c) => createHash("sha256").update(c).digest("hex");

/** The error of a login route that a server from before Task Runner logins does not have. @param {string} server */
const loginMissing = (server) => new Error(`${server} does not offer Task Runner logins yet (its AutoCraft is older): store a credential from its Connect page with \`autocraft login ${server} --stdin\``);

/**
 * `login <server-url> [--label X] [--no-wait]`: makes a credential, keeps it, and asks the server to have it approved;
 * `login --wait`: waits for that approval; `login <server-url> --stdin`: stores a credential given on stdin.
 * Exit codes: 0 approved (or started, with --no-wait), 3 still waiting after --wait, 1 denied, expired or failed.
 * @param {string[]} argv
 */
async function cmdLogin(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const label = argValues(argv, "--label")[0];
  const url = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--label");
  const usage = "usage: autocraft login <server-url> [--label <name>] [--no-wait] [--answer] [--no-agent] | login --wait | login <server-url> --stdin";
  for (const f of flags) if (!["--label", "--no-wait", "--wait", "--stdin", "--answer", "--no-agent"].includes(f)) throw new Error(usage);
  if (flags.has("--wait")) {
    if (url || flags.has("--stdin") || flags.has("--no-wait")) throw new Error(usage);
    const p = loadCredentials().pending;
    if (!p) throw new Error("no login waits for approval: run `autocraft login <server-url>`");
    return awaitApproval(p, Date.now() + WAIT_MS);
  }
  if (!url) throw new Error(usage);
  const server = serverUrl(url);
  if (flags.has("--stdin")) {
    const credential = await readSecret("Task Runner credential: ");
    if (!credential || /\s/.test(credential)) throw new Error("no credential on stdin");
    approve({ server, credential, label: label ?? "" });
    console.log(`logged in to ${server}`);
    return 0;
  }
  const name = (label ?? `${hostname()}`).trim().slice(0, 100) || "Task Runner";
  /** @type {PendingLogin} */
  const p = { server, credential: newCredential(), label: name };
  // Kept before the server hears of it, so a login cut off here leaves nothing usable behind on the server.
  saveCredentials({ ...loadCredentials(), pending: p });
  /** @type {LoginStart} */
  const body = { credentialHash: credentialHash(p.credential), label: name, machine: machine(), helperVersion: HELPER_VERSION, scopes: { agent: !flags.has("--no-agent"), answer: flags.has("--answer") } };
  /** @type {LoginStartReply} */
  let r;
  try { r = await withRetry(() => api(server, ROUTES.loginStart, null, body), { tries: 4, deadline: Date.now() + 60_000, baseMs: 2000 }); }
  catch (e) {
    const { pending: _p, ...rest } = loadCredentials();
    saveCredentials(rest);
    throw e instanceof HttpError && e.status === 404 ? loginMissing(server) : e;
  }
  Object.assign(p, { userCode: r.userCode, verifyUrl: r.verifyUrl, interval: r.interval, expiresAt: Date.now() + r.expiresIn * 1000 });
  saveCredentials({ ...loadCredentials(), pending: p });
  console.log(`To add this Task Runner, open ${r.verifyUrl}`);
  console.log(`and check that it shows the code ${r.userCode} (valid for ${Math.round(r.expiresIn / 60)} minutes).`);
  if (flags.has("--no-wait")) { console.log("then run: autocraft login --wait"); return 0; }
  return awaitApproval(p, p.expiresAt ?? Date.now() + WAIT_MS);
}

/** Stores `p` as the approved credential, and its server as the config's. @param {{ server: string, credential: string, label: string }} p */
function approve(p) {
  const { pending: _p, ...rest } = loadCredentials();
  saveCredentials({ ...(rest.server === p.server && { id: rest.id, login: rest.login }), server: p.server, credential: p.credential, label: p.label, state: "approved" });
  const { agentToken: _a, ...cfg } = loadConfig();
  saveConfig({ ...cfg, server: p.server });
}

/**
 * Polls the server for the approval of login `p` until it is decided or `until` passes; follows the server's interval and
 * Retry-After. Returns the exit code (0 approved, 3 still pending, 1 denied or expired).
 * @param {PendingLogin} p @param {number} until
 */
async function awaitApproval(p, until) {
  if (p.expiresAt !== undefined && Date.now() >= p.expiresAt) return loginEnded(p, "expired");
  let wait = Math.max(1, p.interval ?? 5) * 1000;
  for (;;) {
    /** @type {LoginPollReply | null} */
    let r = null;
    try { r = await api(p.server, ROUTES.loginPoll, p.credential, {}); }
    catch (e) {
      if (e instanceof HttpError && e.status === 404) throw loginMissing(p.server);
      if (!transient(e)) throw e;
      if (e instanceof HttpError && e.retryAfterMs !== null) wait = Math.max(wait, e.retryAfterMs);
    }
    if (r?.state === "approved") {
      approve(p);
      console.log(`approved: logged in to ${p.server} as Task Runner "${p.label}"`);
      return 0;
    }
    if (r && r.state !== "pending") return loginEnded(p, r.state);
    if (Date.now() + wait >= until) {
      if (p.expiresAt !== undefined && Date.now() + wait >= p.expiresAt) return loginEnded(p, "expired");
      console.log(`still waiting for approval at ${p.verifyUrl}; wait again: autocraft login --wait`);
      return 3;
    }
    await sleep(wait);
  }
}

/** A login that can no longer be approved: forgets it. @param {PendingLogin} p @param {LoginState} state */
function loginEnded(p, state) {
  const c = loadCredentials();
  if (c.pending?.credential === p.credential) { const { pending: _p, ...rest } = c; saveCredentials(rest); }
  console.log(`the login was ${state === "denied" ? "denied" : "not approved in time"}; start a new one: autocraft login ${p.server}`);
  return 1;
}

/** @param {string[]} argv */
async function cmdHarness(argv) {
  const id = argv[0];
  if (id === "codex") return codexLogin(argv.slice(1));
  if (id !== "claude") throw new Error("usage: autocraft harness claude [--keychain]  (a `claude setup-token` token on stdin)\n       autocraft harness claude --config-dir [<dir>]\n       autocraft harness codex [--device-auth]");
  const { claudeToken: _t, claudeConfigDir: _d, claudeAuth: _a, claudeKeychain: _k, ...rest } = loadConfig();
  if (argv.includes("--keychain")) {
    // macOS: the access token of the user's own Claude Code login, read from the Keychain before each call.
    if (process.platform !== "darwin") throw new Error("--keychain reads Claude Code's login from the macOS Keychain; elsewhere use --config-dir or a setup-token");
    const item = claudeKeychainItem();
    if (!keychainCredential()) throw new Error(`no Claude Code login in the Keychain item "${item.service}" (account ${item.account}): sign in to Claude Code first`);
    // The item is recorded now: a later shell with another CLAUDE_CONFIG_DIR must not switch to a different login.
    saveConfig({ ...rest, harness: "claude", claudeAuth: "keychain", claudeKeychain: item });
    console.log(`the helper reads the Claude login from the Keychain item "${item.service}" before each call; it never refreshes it, so use Claude Code now and then, or store a setup-token instead`);
    return;
  }
  const at = argv.indexOf("--config-dir");
  if (at >= 0) {
    if (process.platform === "darwin") throw new Error(CLAUDE_CONFIG_DIR_MACOS);
    const given = argv[at + 1];
    const dir = resolve(given && !given.startsWith("-") ? given : process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    const o = readClaudeCredentials(dir)?.claudeAiOauth;
    if (typeof o?.accessToken !== "string" || typeof o.expiresAt !== "number") throw new Error(`no Claude login in ${dir}/.credentials.json: run claude with CLAUDE_CONFIG_DIR=${dir} and log in`);
    saveConfig({ ...rest, harness: "claude", claudeConfigDir: dir });
    const d = claudeAdapter.detect(loadConfig());
    console.log(`using the Claude login in ${dir} (its access token is valid for ${Math.max(0, Math.round((o.expiresAt - Date.now()) / 60_000))} more minutes; claude refreshes it whenever it runs)${d.bin ? `; claude ${d.version ?? "(version unknown)"} at ${d.bin}` : "; claude was not found on PATH"}`);
    return;
  }
  const token = await readSecret("Claude token (from `claude setup-token`): ");
  if (!token || /\s/.test(token)) throw new Error("no token on stdin");
  saveConfig({ ...rest, harness: "claude", claudeToken: token });
  const d = claudeAdapter.detect(loadConfig());
  console.log(d.bin ? `stored the Claude token; claude ${d.version ?? "(version unknown)"} at ${d.bin}` : "stored the Claude token; claude was not found on PATH");
}

/**
 * Logs Codex in to the helper's own CODEX_HOME, a login separate from the user's ~/.codex with its own refresh token,
 * so the helper's refreshes never invalidate the user's session. `--device-auth` for a machine without a browser.
 * @param {string[]} argv
 */
async function codexLogin(argv) {
  const extra = argv.filter((a) => a === "--device-auth");
  const bin = resolveCodexBin(loadConfig());
  if (!bin) throw new Error("codex was not found on PATH (or set codexBin in the config)");
  privateDir(codexHome());
  const r = spawnSync(bin, ["-c", 'cli_auth_credentials_store="file"', "login", ...extra], { stdio: "inherit", env: { ...process.env, CODEX_HOME: codexHome() } });
  if (r.status !== 0) throw new Error(`codex login failed (exit ${r.status})`);
  saveConfig({ ...loadConfig(), harness: "codex" });
  const tiers = loadConfig().tiers ?? {};
  console.log(`logged Codex in for the helper (its own login in ${codexHome()}); harness set to codex${Object.keys(tiers).length ? "" : `. Set "tiers" in ${join(configDir(), "config.json")}: the Codex model id for top, mid and small`}`);
}

async function cmdClaim() {
  const problem = platformProblem();
  if (problem) throw new Error(problem);
  const r = await claimOnce(loadConfig());
  if ("held" in r) { console.log(`not claiming: ${heldLine(r.held)}`); return null; }
  if (!r.lease) { console.log(r.reason ? `no calls for this helper: ${r.reason}${r.until ? ` (until ${new Date(r.until).toLocaleString()})` : ""}` : `no task queued; claim again in ${r.retryAfter} s`); return null; }
  console.log(`lease ${r.lease.id}: ${r.lease.title}`);
  return r.lease.id;
}

/** @param {string} id */
function leaseId(id) {
  if (!/^\d+$/.test(id ?? "")) throw new Error(`not a lease id: ${id}`);
  return Number(id);
}

/** @param {string[]} argv */
async function cmdRun(argv) {
  const detach = argv.includes("--detach");
  const pos = argv.filter((a) => !a.startsWith("--"));
  const problem = platformProblem();
  if (problem) throw new Error(problem);
  const cfg = loadConfig();
  requireCanary();
  let id;
  // macOS: a run in this process holds its slot from the claim to the end; a detached run's child takes it.
  const held = !pos[0] && !detach && process.platform === "darwin" ? holdSlot(slotBase()) : null;
  try {
    if (pos[0]) id = leaseId(pos[0]);
    else {
      const r = await claimOnce(cfg, held?.n);
      if ("held" in r) { console.log(`not claiming: ${heldLine(r.held)}`); return 0; }
      if (!r.lease) { console.log(r.reason ? `no calls for this helper: ${r.reason}${r.until ? ` (until ${new Date(r.until).toLocaleString()})` : ""}` : `no task queued; try again in ${r.retryAfter} s`); return 0; }
      id = r.lease.id;
    }
    return await runOrDetach(cfg, id, detach, held !== null);
  } finally {
    held?.release();
  }
}

/** @param {Config} cfg @param {number} id @param {boolean} detach @param {boolean} slotHeld */
async function runOrDetach(cfg, id, detach, slotHeld) {
  const lease = readLease(id);
  if (!lease) throw new Error(`no lease ${id} was claimed on this machine`);
  if (detach) {
    mkdirSync(join(cacheDir(), "runs"), { recursive: true });
    const log = openSync(join(cacheDir(), "runs", `${id}.log`), "a", 0o600);
    writeStatus(id, { state: "running", line: `running: ${lease.title}`, at: Date.now() });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", String(id)], { detached: true, stdio: ["ignore", log, log] });
    closeSync(log);
    writeStatus(id, { state: "running", line: `running: ${lease.title}`, pid: child.pid, at: Date.now() });
    child.unref();
    console.log(`started lease ${id}: ${lease.title}; wait with: autocraft wait ${id}`);
    return 0;
  }
  const ac = new AbortController();
  for (const sig of STOP_SIGNALS) process.once(sig, () => ac.abort());
  const s = await runLease(cfg, id, { signal: ac.signal, slotHeld });
  console.log(s.line);
  return s.state === "submitted" ? 0 : 1;
}

/** @param {string[]} argv */
async function cmdWait(argv) {
  const id = leaseId(argv[0]);
  const until = Date.now() + WAIT_MS;
  for (;;) {
    /** @type {RunStatus | null} */
    const s = readJson(statusFile(id));
    if (!s) { console.log(`no run of lease ${id} on this machine`); return 1; }
    if (s.state !== "running") { console.log(s.line); return s.state === "submitted" ? 0 : 1; }
    if (s.pid && !alive(s.pid)) { console.log(`failed: the helper process of lease ${id} stopped`); return 1; }
    if (Date.now() >= until) { console.log(`${s.line}; still running, wait again: autocraft wait ${id}`); return 3; }
    await sleep(1000);
  }
}

/** @param {number} pid */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
}

/**
 * Takes a lock file naming this process; the release function, or null while a live process holds it. A lock of a dead
 * process, or one not touched for `staleMs` (its holder refreshes it), is taken over.
 * @param {string} file @param {number} [staleMs]
 */
function takeLockFile(file, staleMs = Infinity) {
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rmSync(file, { force: true });
    } catch (e) {
      if (/** @type {any} */ (e).code !== "EEXIST") throw e;
      const pid = Number.parseInt((() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })(), 10);
      let touched = Date.now();
      try { touched = statSync(file).mtimeMs; } catch { /* just released */ }
      if (pid > 0 && alive(pid) && Date.now() - touched < staleMs) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

/** Takes the helper-wide lock of one harness; the release function, or null when another process holds it. @param {string} id */
function takeHarnessLock(id) {
  privateDir(configDir());
  return takeLockFile(join(configDir(), `${id}.lock`));
}

const FETCH_LOCK_STALE_MS = 5 * 60_000;

/**
 * Runs `fn` while holding `file`, waiting while another process holds it (one git fetch per bare repo across processes).
 * The lock is touched every minute, so a holder that hangs or died with its pid reused is taken over after FETCH_LOCK_STALE_MS.
 * @template T @param {string} file @param {() => Promise<T>} fn @returns {Promise<T>}
 */
async function withLockFile(file, fn) {
  let release;
  while (!(release = takeLockFile(file, FETCH_LOCK_STALE_MS))) await sleep(500);
  const touch = setInterval(() => { try { const t = new Date(); utimesSync(file, t, t); } catch { /* released */ } }, 60_000);
  try { return await fn(); } finally { clearInterval(touch); release(); }
}

/** The signals that stop a run or `work` like Ctrl-C (a service manager's stop, a closed terminal), with their exit codes. */
const STOP_SIGNALS = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** The waits before the next claim after 1, 2, 3 and 4 or more calls failed in a row. */
const FAILURE_WAITS_MS = [60_000, 120_000, 300_000, 600_000].map(scaled);
/** After this many failed calls in a row the helper holds (`failing`) until its wait ends and its checks pass again. */
export const FAILURES_TO_HOLD = 5;
/** How long `work` waits before its next claim after `n` calls failed (or were given back) in a row. @param {number} n */
export const failureWait = (n) => (n <= 0 ? 0 : FAILURE_WAITS_MS[Math.min(n, FAILURE_WAITS_MS.length) - 1] ?? 0);

/** A lease with no live run is given back on start once it is this old (the server expires it after 2 minutes anyway). */
const ORPHAN_AFTER_MS = scaled(5 * 60_000);

/**
 * Gives back, with a reason, the leases of runs whose process died (a crash, a kill, a reboot): a running status names its
 * pid. A lease claimed and never started, or started without a pid, counts once it is ORPHAN_AFTER_MS old. Returns their ids.
 * @param {number} [now]
 */
export async function releaseOrphans(now = Date.now()) {
  const dir = join(configDir(), "leases");
  if (!existsSync(dir)) return [];
  /** @type {number[]} */
  const out = [];
  for (const f of readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(f);
    const id = m ? Number(m[1]) : NaN;
    const lease = m ? readLease(id) : null;
    if (!lease) continue;
    /** @type {RunStatus | null} */
    const s = readJson(statusFile(id));
    if (s && s.state !== "running") { dropLease(id); continue; }
    const dead = s ? (s.pid ? !alive(s.pid) : now - s.at > ORPHAN_AFTER_MS) : now - lease.claimedAt > ORPHAN_AFTER_MS;
    if (!dead) continue;
    const reason = "the helper process that ran it stopped";
    /** @type {Release} */
    const body = { reason };
    try { await api(lease.server, ROUTES.release, lease.secret, body); } catch { /* gone, or the server expires it */ }
    dropLease(id);
    writeStatus(id, { state: "released", line: `released: ${lease.title}: ${reason}`, at: Date.now() });
    out.push(id);
  }
  return out;
}

/** A `work` whose credential the server refuses (revoked, expired) claims again this often. */
const REVOKED_RETRY_MS = scaled(10 * 60_000);

/** `--parallel N` of `work` (1 when absent). @param {string[]} argv */
function parallelOf(argv) {
  const i = argv.indexOf("--parallel");
  const n = i >= 0 ? Number(argv[i + 1]) : 1;
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("--parallel takes a number from 1 to 16");
  return n;
}

/** @param {string[]} argv */
async function cmdWork(argv) {
  const n = parallelOf(argv);
  if (migrateAtStart()) {
    // This process started the autocraft service and asked its own (old) service to stop: it claims nothing meanwhile.
    console.log(`waiting for the ${LEGACY_SERVICE} service to stop; the ${SERVICE_NAME} service takes over`);
    const stoppedBy = await new Promise((done) => {
      const t = setTimeout(() => done(null), SWITCH_STOP_WAIT_MS);
      for (const sig of STOP_SIGNALS) process.once(sig, () => { clearTimeout(t); done(sig); });
    });
    if (stoppedBy) return 0;
    console.log(`the ${LEGACY_SERVICE} service did not stop; claiming as it is`);
  }
  const exclusive = adapterOf(loadConfig());
  if (exclusive.exclusive && n > 1) throw new Error(`${exclusive.id} runs one call at a time: its login refreshes in place and must not be shared by parallel calls`);
  const problem = platformProblem();
  if (problem) throw new Error(problem);
  // A failed canary holds the helper (sandbox-failed, see checkReady) and runs again after a while; the process stays up.
  try { requireCanary(); } catch (e) { console.log(msg(e)); }
  // One more slot beside the N that takes only short calls and the follow-ups of this helper's sessions, so a lint check or a
  // fix turn never waits for a long run to end. Not for a harness that runs one call at a time, nor past the macOS slots.
  const fast = !exclusive.exclusive && !(process.platform === "darwin" && n >= MAC_MAX_SLOTS);
  // And one beside them that takes only calls bound to this user (their own conversation turns and those calls' follow-ups),
  // which the server counts toward no slot: they run while the slots are busy. Not for a harness that runs one call at a time,
  // nor past the macOS slots. It is not reported as a slot.
  const own = !exclusive.exclusive && !(process.platform === "darwin" && n + (fast ? 1 : 0) >= MAC_MAX_SLOTS);
  // Whether the own lane runs: the slots then leave the bound calls to it (Claim.withOwnLane). It stops against a server without it.
  let ownLaneOn = own;
  // The interactive lanes run where the own lane does (same slot limits).
  const interactiveOn = own;
  const ac = new AbortController();
  // Self-update: a newer runner on the server is downloaded and checked, then claiming stops, running calls finish, and the
  // file is replaced before the process exits (the service starts it again).
  const autoUpdate = loadConfig().autoUpdate !== false && !argv.includes("--no-auto-update");
  const gitInstall = inGitCheckout(self);
  /** @type {{ version: string, staged: string } | null} */
  let updating = /** @type {{ version: string, staged: string } | null} */ (null);
  const wake = new AbortController();
  let updateCheckAt = 0, updateChecking = false, updateFailures = 0, updateSaid = "";
  /** @param {string | undefined} hint the server's runner version when a reply carried it; absent after a refusal */
  const checkUpdate = async (hint) => {
    if (updating || updateChecking || ac.signal.aborted || Date.now() < updateCheckAt) return;
    if (hint !== undefined && compareVersions(hint, HELPER_VERSION) <= 0) return;
    if (hint !== undefined && selfUpdateDecision({ current: HELPER_VERSION, served: hint, inGit: gitInstall, enabled: autoUpdate }) === "available") {
      const why = gitInstall ? "this install is a git checkout: update it with git" : "automatic updates are off";
      if (updateSaid !== hint) { updateSaid = hint; console.log(`autocraft ${hint} is available (running ${HELPER_VERSION}); ${why}, or run: ${UPDATE_COMMAND}`); }
      updateHelperStatus((s) => ({ ...s, updateAvailable: { version: hint, at: Date.now(), reason: why } }));
      return;
    }
    if (hint === undefined && (gitInstall || !autoUpdate)) {
      if (updateSaid !== "refused") { updateSaid = "refused"; console.log(`the server needs a newer runner than ${HELPER_VERSION}; ${gitInstall ? "this install is a git checkout: update it with git" : "automatic updates are off"}, or run: ${UPDATE_COMMAND}`); }
      return;
    }
    updateChecking = true;
    try {
      const server = loadConfig().server;
      if (!server) return;
      const got = await downloadHelper(server);
      if (selfUpdateDecision({ current: HELPER_VERSION, served: got.version, inGit: false, enabled: true }) !== "update") { updateCheckAt = Date.now() + SELF_UPDATE_RECHECK_MS; return; }
      const staged = stageHelper(got.text);
      updateFailures = 0;
      updateHelperStatus((s) => ({ ...s, updateAvailable: { version: got.version, at: Date.now(), reason: "updating after the running calls finish" } }));
      console.log(`autocraft ${got.version} is available (running ${HELPER_VERSION}): not claiming; running calls finish, then it updates and restarts`);
      updating = { version: got.version, staged };
      wake.abort();
    } catch (e) {
      updateFailures++;
      updateCheckAt = Date.now() + Math.min(SELF_UPDATE_RECHECK_MS, SELF_UPDATE_RETRY_MS * 2 ** (updateFailures - 1));
      console.log(`update check failed: ${msg(e)}; keeping ${HELPER_VERSION}, trying again in ${Math.round((updateCheckAt - Date.now()) / 60_000)} min`);
    } finally { updateChecking = false; }
  };
  for (const sig of STOP_SIGNALS) {
    process.on(sig, () => {
      if (ac.signal.aborted) process.exit(SIGNAL_EXIT[sig]);
      console.log(`stopping (${sig}): running calls are stopped and given back; ${sig === "SIGINT" ? "press Ctrl-C" : "signal"} again to quit at once`);
      ac.abort();
    });
  }
  // A hold of an earlier process (its pid may be ours now) ends with it.
  updateHelperStatus(({ hold, ...s }) => (hold && hold.pid !== process.pid && alive(hold.pid) ? { ...s, hold } : s));
  for (const id of await releaseOrphans()) console.log(`gave back lease ${id}: the helper process that ran it stopped`);
  // Status reports carry these (sendStatus); the loops below count busy around each run.
  capacity.slots = n + (fast ? 1 : 0);
  capacity.busy = 0;
  let idleSaid = "", heldSaid = "", failures = 0, notBefore = 0;
  /** @param {number} ms */
  const pause = (ms) => sleep(ms, undefined, { signal: AbortSignal.any([ac.signal, wake.signal]) }).catch(() => {});
  /** @param {Readiness} readiness @param {string} reason @param {number | null} until */
  const hold = (readiness, reason, until) => {
    setHold(readiness, reason, until);
    heldSaid = heldLine({ readiness, reason, until });
    console.log(`not claiming: ${heldSaid}; running calls finish`);
  };
  /** @param {boolean} fastLane @param {boolean} [ownLane] @param {boolean} [interactiveLane] */
  const loop = async (fastLane, ownLane = false, interactiveLane = false) => {
    // macOS: each loop holds one slot for its lifetime, so its claims name that slot's root and sessions.
    const held = process.platform === "darwin" ? holdSlot(slotBase()) : null;
    try { await claimLoop(held?.n, fastLane, ownLane, interactiveLane); } finally { held?.release(); }
  };
  // Interactive lanes (Claim.interactiveLane): one loop runs from the start and the server's reply tells how many the user's
  // Interactive slots allow; the rest start then. A loop beyond the slots, or with 0, waits quietly.
  let interactiveLoops = interactiveOn ? 1 : 0;
  /** @type {Promise<void>[]} */
  const interactiveRuns = [];
  /** @param {number} want */
  const startInteractive = (want) => { while (interactiveLoops < want) { interactiveLoops++; interactiveRuns.push(loop(false, false, true).then(() => {})); } };
  /** @param {number | undefined} slot @param {boolean} fastLane @param {boolean} ownLane @param {boolean} [interactiveLane] */
  const claimLoop = async (slot, fastLane, ownLane, interactiveLane = false) => {
    let claimId = newClaimId();
    let blockedRun = 0;
    while (!ac.signal.aborted && !updating) {
      if (Date.now() < notBefore) { await pause(notBefore - Date.now()); continue; }
      let r;
      try { r = await claimOnce(loadConfig(), slot, fastLane, claimId, ac.signal, ownLane, ownLaneOn, interactiveLane); claimId = newClaimId(); blockedRun = 0; } catch (e) {
        if (ac.signal.aborted) break;
        // A claim lost in transit may have leased a call: the next try sends the same id and gets that lease back.
        if (!transient(e)) claimId = newClaimId();
        if (e instanceof HttpError && e.status === 409) void checkUpdate(undefined);
        blockedRun = e instanceof ProxyBlocked ? blockedRun + 1 : 0;
        if (blockedRun >= 10) {
          if (blockedRun === 10) console.log("the server's replies are blocked by a proxy, or the credential was revoked; run autocraft login if this persists");
          await pause(REVOKED_RETRY_MS); continue;
        }
        if (e instanceof HttpError && !(e instanceof ProxyBlocked) && (e.status === 401 || e.status === 403)) {
          // A revoked or expired credential: the process stays up (no restart loop of its service) and looks again now and then.
          const line = `credential revoked or expired (${msg(e)}); run \`autocraft login <server-url>\``;
          if (line !== heldSaid) { console.log(`not claiming: ${line}; checking again every ${Math.round(REVOKED_RETRY_MS / 60_000)} min`); heldSaid = line; idleSaid = ""; }
          await pause(REVOKED_RETRY_MS); continue;
        }
        console.log(`claim failed: ${msg(e)}; retrying in ${Math.round(scaled(60_000) / 1000)} s`); await pause(scaled(60_000)); continue;
      }
      if ("held" in r) {
        // An external wait on this machine: the usage is read again every minute, and the status kept fresh.
        const line = heldLine(r.held);
        if (line !== heldSaid) { console.log(`not claiming: ${line}`); heldSaid = line; idleSaid = ""; }
        await pause(holdRetryDelay());
        continue;
      }
      if (heldSaid) { console.log("ready again"); heldSaid = ""; }
      if (r.currentHelper) void checkUpdate(r.currentHelper);
      // A server older than the own lane ignores the field and offers any call: the lane runs what it got and then stops.
      const ownLaneUnknown = ownLane && r.ownLane !== true;
      if (ownLaneUnknown) ownLaneOn = false;
      if (ownLaneUnknown && !r.lease) { console.log("the server has no own lane for calls bound to you; that lane stops"); return; }
      // A server older than the interactive lane ignores the field and offers any call: the lane runs what it got and then stops.
      const interactiveUnknown = interactiveLane && typeof r.interactiveSlots !== "number";
      if (interactiveLane && !interactiveUnknown) startInteractive(r.interactiveSlots ?? 0);
      if (interactiveUnknown && !r.lease) { console.log("the server has no interactive lane; that lane stops"); return; }
      if (!r.lease) {
        if (interactiveLane) { await pause(Math.max(TIME_SCALE, r.retryAfter) * 1000); continue; }
        // The own lane waits quietly: the slots' loops say what the helper is doing.
        if (ownLane) { await pause(Math.max(TIME_SCALE, r.retryAfter) * 1000); continue; }
        const say = r.reason ? `no calls for this helper: ${r.reason}${r.until ? ` (until ${new Date(r.until).toLocaleString()})` : ""}` : `no task queued; claiming again in ${r.retryAfter} s`;
        if (idleSaid !== say) { console.log(say); idleSaid = say; }
        await pause(Math.max(TIME_SCALE, r.retryAfter) * 1000);
        continue;
      }
      idleSaid = "";
      console.log(`lease ${r.lease.id}${fastLane ? " (fast lane)" : interactiveLane ? " (interactive lane)" : ownLane ? " (own lane)" : ""}: ${r.lease.title}`);
      const counted = !ownLane && !interactiveLane;
      if (counted) capacity.busy++;
      let s;
      try { s = await runLease(loadConfig(), r.lease.id, { signal: ac.signal, slotHeld: slot !== undefined }); } finally { if (counted) capacity.busy--; }
      console.log(s.line);
      if (ownLaneUnknown) { console.log("the server has no own lane for calls bound to you; that lane stops"); return; }
      if (interactiveUnknown) { console.log("the server has no interactive lane; that lane stops"); return; }
      if (s.hold) {
        hold(s.hold.readiness, s.line, s.hold.ms === null ? null : Date.now() + s.hold.ms);
        if (s.hold.readiness === "version-refused") void checkUpdate(undefined);
      } else if (s.state === "submitted") {
        if (failures >= FAILURES_TO_HOLD) clearHold("failing");
        failures = 0; notBefore = 0;
      } else if ((s.state === "failed" || s.state === "released") && !s.noStrike && !ac.signal.aborted) {
        // A broken helper fails every call: it waits longer after each failure in a row, and holds after FAILURES_TO_HOLD.
        // A released call also goes back to the queue, and claiming at once would likely hand it straight back.
        failures++;
        const wait = failureWait(failures);
        notBefore = Math.max(notBefore, Date.now() + wait);
        if (failures >= FAILURES_TO_HOLD) hold("failing", `${failures} calls failed in a row; the last: ${s.line}`, Date.now() + wait);
        else console.log(`${failures === 1 ? "the call did not finish" : `${failures} calls in a row did not finish`}; claiming again in ${wait / 60_000} min`);
      }
    }
  };
  await Promise.all([...Array.from({ length: n }, () => loop(false)), ...(fast ? [loop(true)] : []), ...(own ? [loop(false, true)] : []), ...(interactiveOn ? [loop(false, false, true)] : [])]);
  await Promise.all(interactiveRuns);
  if (updating && !ac.signal.aborted) {
    const { version, staged } = updating;
    const status = installStaged(staged);
    updateHelperStatus(({ updateAvailable: _u, ...s }) => ({ ...s, update: { at: Date.now(), from: HELPER_VERSION, to: version } }));
    const supervised = process.platform === "darwin" ? process.env.XPC_SERVICE_NAME === SERVICE_NAME : !!process.env.INVOCATION_ID;
    console.log(`autocraft updated from ${HELPER_VERSION} to ${version}; ${supervised ? "restarting" : "start `autocraft work` again"}`);
    return status;
  }
  if (updating) rmSync(updating.staged, { force: true });
  return 0;
}

/** Prints whether the helper takes calls now, with the usage, reserve and pause behind it. */
async function cmdStatus() {
  const cfg = loadConfig();
  const st = await checkReady(cfg);
  const s = readHelperStatus(), c = readControl();
  console.log(st.readiness === "ready" ? "ready: claims calls" : heldLine(st));
  const u = s.usage;
  /** @param {string} name @param {UsageWindow | null | undefined} w */
  const win = (name, w) => (w ? `${name} ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${clock(Date.parse(w.resetsAt))}` : ""}` : `${name} not reported`);
  if (u) console.log(`usage: ${win("5-hour", u.fiveHour)}; ${win("weekly", u.weekly)} (read ${clock(Date.parse(u.at))})`);
  const server = s.serverReserve;
  console.log(`reserve kept free: 5-hour ${st.reserve.fiveHour}%, weekly ${st.reserve.weekly}% (server ${server ? `${server.fiveHour}%/${server.weekly}%` : "not heard yet, default 20%/20%"}${cfg.reserve ? `, local ${cfg.reserve.fiveHour}%/${cfg.reserve.weekly}%` : ""})`);
  if (s.update) console.log(`updated from ${s.update.from} to ${s.update.to} at ${clock(s.update.at)}`);
  if (s.updateAvailable) console.log(`update to ${s.updateAvailable.version} pending: ${s.updateAvailable.reason}`);
  if (c.pause) console.log(`paused ${c.pause.until === null ? "until `autocraft runner resume`" : `until ${clock(c.pause.until)}`}`);
  if (c.park) console.log(`held after a refusal ${c.park.until === null ? "until a usage reading shows headroom" : `until ${clock(c.park.until)}`}: ${c.park.reason}`);
  console.log(`status file: ${helperStatusFile()}`);
  return st.readiness === "ready" ? 0 : 3;
}

/** Pauses the helper until the reset of the window that holds it (the 5-hour window when none does), or until `resume` when no reset is known. */
async function cmdPause() {
  const cfg = loadConfig();
  const st = await checkReady(cfg, { send: false });
  const r = st.reading;
  const fiveHour = r && !("error" in r) ? r.windows.filter((w) => w.kind === "five_hour" && w.resetsAt !== null).map((w) => /** @type {number} */ (w.resetsAt)).sort((a, b) => b - a)[0] : undefined;
  const until = st.readiness === "quota-held" && st.until !== null ? st.until : st.readiness === "paused" ? (readControl().pause?.until ?? null) : fiveHour ?? null;
  writeControl({ ...readControl(), pause: { until, at: Date.now() } });
  await checkReady(cfg);
  console.log(until === null ? "paused until `autocraft runner resume` (no reset time is known)" : `paused until ${clock(until)}, or \`autocraft runner resume\``);
}

/** Ends a pause, a hold after a provider's refusal, and a `work` process's hold; the usage still decides. */
async function cmdResume() {
  const { pause: _p, park: _k, ...rest } = readControl();
  writeControl(rest);
  clearHold();
  const st = await checkReady(loadConfig());
  console.log(st.readiness === "ready" ? "resumed: ready" : `resumed; ${heldLine(st)}`);
}

/** @param {string[]} argv */
async function cmdConfig(argv) {
  if (argv[0] !== "reserve") throw new UsageError("usage: autocraft runner reserve <5h> <weekly> | off");
  const { reserve: _r, ...rest } = loadConfig();
  if (argv[1] === "off") { saveConfig(rest); console.log("the server's reserve applies"); return; }
  const n = argv.slice(1, 3).map((v) => (/^\d{1,3}$/.test(v ?? "") ? Number(v) : NaN));
  if (n.length !== 2 || !n.every((v) => v >= 0 && v <= 100)) throw new UsageError("usage: autocraft runner reserve <5h> <weekly>  (percent of each window kept free, 0 to 100), or off");
  const local = { fiveHour: /** @type {number} */ (n[0]), weekly: /** @type {number} */ (n[1]) };
  saveConfig({ ...rest, reserve: local });
  const server = readHelperStatus().serverReserve;
  const eff = effectiveReserve(server, local);
  console.log(`reserve kept free: 5-hour ${eff.fiveHour}%, weekly ${eff.weekly}%${eff.fiveHour > local.fiveHour || eff.weekly > local.weekly ? ` (the server's ${server ? `${server.fiveHour}%/${server.weekly}%` : "default 20%/20%"} is higher where the local value is lower: a local reserve only raises it)` : ""}`);
}

/**
 * Runs a bundle from a file in the sandbox without a server and prints the reply: for testing the sandbox and a harness.
 * Its mounts must be git or files mounts and it may name no MCP servers. On macOS it runs in slot `--slot` (0), and the
 * bundle's paths must already be below that slot's root (scripts/remote-bundle.ts --root).
 * @param {string[]} argv
 */
async function cmdTry(argv) {
  const i = argv.indexOf("--slot");
  const file = argv.find((a, k) => !a.startsWith("--") && argv[k - 1] !== "--slot");
  if (!file) throw new Error("usage: autocraft try <bundle.json> [--slot N]");
  const problem = platformProblem();
  if (problem) throw new Error(problem);
  requireCanary();
  /** @type {TaskBundle} */
  const b = JSON.parse(readFileSync(file, "utf8"));
  if (b.mcpServers?.length) throw new Error("try runs without a server: the bundle may name no MCP servers");
  const cfg = loadConfig();
  const adapter = adapterOf(cfg);
  const d = adapter.detect(cfg);
  const t = adapter.tokenFor ? adapter.tokenFor(cfg, b.timeoutSeconds) : { token: adapter.token(cfg) ?? "" };
  if ("problem" in t) throw new Error(t.problem);
  const token = t.token;
  if (!d.bin || !token) throw new Error(`${adapter.id} binary or login missing`);
  const model = { ...adapter.defaultTiers, ...cfg.tiers }[b.tier];
  if (!model) throw new Error(`no ${adapter.id} model is set for the ${b.tier} tier`);
  const mac = process.platform === "darwin";
  const held = mac ? (() => { const n = i >= 0 ? Number(argv[i + 1]) : 0; const r = Number.isInteger(n) ? takeSlot(slotBase(), n) : null; if (!r) throw new Error(`slot ${argv[i + 1] ?? 0} is busy or not a slot number`); return { n, release: r }; })() : null;
  const root = held ? slotRoot(slotBase(), held.n) : "";
  if (root && !JSON.stringify(b.hints).includes(root)) console.error(`warning: the bundle's arguments do not name ${root}; build it with --root ${root}`);
  privateDir(join(cacheDir(), "tasks"));
  const taskDir = mkdtempSync(join(cacheDir(), "tasks", "try-"));
  secretsInUse.add(token);
  try {
    const out = await execute({ ...b, callId: 0, resume: undefined }, { adapter, bin: d.bin, token, model, taskDir, lease: null, root, ...(held && { slot: held.n }) });
    if ("giveBack" in out || "fail" in out) { console.log(JSON.stringify(out)); return 1; }
    console.log(redact(JSON.stringify({ exit: out.r.code, timedOut: out.r.timedOut, ...out.reply, tools: out.tools.length, stderr: out.r.stderr.trim().slice(-2000) }, null, 2)));
    return out.reply.ok ? 0 : 1;
  } finally {
    held?.release();
    rmSync(taskDir, { recursive: true, force: true });
    secretsInUse.delete(token);
  }
}

async function cmdDoctor() {
  let bad = 0;
  /** @param {boolean} ok @param {string} line */
  const check = (ok, line) => { console.log(`${ok ? "ok  " : "FAIL"} ${line}`); if (!ok) bad++; };
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 22, `node ${process.versions.node}${major >= 22 ? "" : " (22 or later needed)"}`);
  const problem = platformProblem();
  const mac = process.platform === "darwin";
  check(!problem, problem ?? (mac ? `platform darwin, sandbox-exec at ${SANDBOX_EXEC}` : `platform ${process.platform}, bubblewrap at ${BWRAP}`));
  if (problem) { console.log("`autocraft setup` offers to install what is missing."); return 1; }
  if (mac) {
    canaryResult = macCanary();
    check(canaryResult.ok, canaryResult.ok ? `the sandbox canary passed; slot 0 is ${slotRoot(slotBase(), 0)}` : "the sandbox canary failed: no call will be claimed");
    for (const l of canaryResult.lines) console.log(`       ${l}`);
  } else {
    const ns = sandboxProbe();
    check(ns.ok, ns.ok ? "a sandbox starts" : `a sandbox does not start: ${ns.error.slice(0, 200)}`);
  }
  for (const tool of ["git", "tar"]) { const r = spawnSync(tool, ["--version"], { encoding: "utf8" }); check(r.status === 0, r.status === 0 ? `${tool} found` : `${tool} not found`); }
  const cfg = loadConfig();
  const adapter = adapterOf(cfg);
  const d = adapter.detect(cfg);
  check(!!d.bin && !!d.version, d.bin ? `${adapter.id} ${d.version ?? "(no version)"} at ${d.bin}` : `${adapter.id} not found on PATH`);
  if (d.version && adapter.unaudited) { const old = adapter.unaudited(d.version); check(!old, old ?? `${adapter.id} ${d.version} is an audited version`); }
  if (d.bin) {
    const c = mac ? macVersion(adapter, d.bin) : adapter.versionInSandbox(d.bin);
    const r = spawnSync(c.cmd, c.args, { env: c.env, encoding: "utf8", timeout: 30_000, ...("cwd" in c && { cwd: c.cwd }) });
    check(r.status === 0, r.status === 0 ? `${adapter.id} runs inside the sandbox` : `${adapter.id} does not run inside the sandbox: ${redact((r.stderr || "").trim()).slice(0, 200)}`);
  }
  if (adapter.id === "claude" && cfg.claudeAuth === "keychain") {
    const item = keychainItemOf(cfg), k = keychainCredential(item);
    const left = k?.expiresAt ? Math.round((k.expiresAt - Date.now()) / 60_000) : null;
    check(!!k && (left === null || left > 0), k ? `claude login from the Keychain (${item.service}), access token ${left === null ? "without an expiry" : left > 0 ? `valid for ${left} min` : "expired: use Claude Code once to refresh it"}` : `no Claude login in the Keychain item "${item.service}" (account ${item.account}): sign in to Claude Code, or store a setup-token`);
  } else if (adapter.id === "claude" && cfg.claudeConfigDir && mac) check(false, CLAUDE_CONFIG_DIR_MACOS);
  else {
    check(d.loggedIn, d.loggedIn ? `${adapter.id} login stored` : `no ${adapter.id} login: run \`autocraft harness ${adapter.id}\``);
    if (adapter.id === "claude" && cfg.claudeConfigDir && d.loggedIn) {
      const t = claudeLoginToken(readClaudeCredentials(cfg.claudeConfigDir), 0);
      check("token" in t, "token" in t ? `uses the Claude login in ${cfg.claudeConfigDir}` : t.problem);
    }
  }
  if (adapter.id === "codex" && d.bin && d.loggedIn) {
    const r = spawnSync(d.bin, ["login", "status"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "/usr/bin", HOME: homedir(), CODEX_HOME: codexHome() } });
    check(r.status === 0, r.status === 0 ? `codex: ${(r.stderr || r.stdout).trim().split("\n")[0]}` : "codex login status: not logged in; run `autocraft harness codex`");
  }
  const token = credentialOf(cfg);
  check(!!cfg.server && !!token, cfg.server ? `server ${cfg.server}${token ? ", credential stored" : ", no credential: run `autocraft login <server-url>`"}` : "not logged in: run `autocraft login <server-url>`");
  if (cfg.server) {
    try {
      const res = await fetch(`${cfg.server}${ROUTES.helper}`, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      check(res.ok, res.ok ? "server reachable" : `server answered HTTP ${res.status}`);
    } catch (e) { check(false, `server unreachable: ${msg(e)}`); }
  }
  const tiers = Object.entries({ ...adapter.defaultTiers, ...cfg.tiers });
  check(tiers.length > 0, tiers.length ? `tiers: ${tiers.map(([t, m]) => `${t}=${m}`).join(", ")}` : `no tiers set: add "tiers" with ${adapter.id} model ids to the config`);
  if (!mac && existsSync(systemdUnitFile(SERVICE_NAME)) && lingerOff()) console.log(`warn ${LINGER_HINT}`);
  if (bad) console.log("`autocraft setup` offers to install what is missing.");
  return bad ? 1 : 0;
}

/** Whether a bubblewrap sandbox starts here, and bubblewrap's error when it does not. */
function sandboxProbe() {
  const r = spawnSync(BWRAP, ["--unshare-all", "--share-net", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"], { encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? { ok: true, error: "" } : { ok: false, error: (r.stderr || String(r.error ?? `exit code ${r.status}`)).trim() };
}

// ---------------------------------------------------------------------------
// Setup: what this machine lacks for running calls, each with the command that adds it, run only after the user agrees.

/**
 * What `setup` found on this machine.
 * @typedef {object} SetupFacts
 * @property {string} platform  process.platform
 * @property {boolean} root  running as root (no sudo needed)
 * @property {"apt" | "dnf" | "pacman" | "zypper" | "apk" | null} pkg  the system's package manager (Linux)
 * @property {string[]} missing  system packages to install: bubblewrap, git, tar, and curl and bash when Claude Code's installer must run
 * @property {"ok" | "failed" | null} sandbox  whether a bubblewrap sandbox starts (null: not tried, bubblewrap is missing or not Linux)
 * @property {string} sandboxError  bubblewrap's error when it does not start
 * @property {boolean} userns  the kernel restricts unprivileged user namespaces through AppArmor (Ubuntu 23.10 on)
 * @property {boolean} bwrapProfile  /etc/apparmor.d/bwrap-userns-restrict exists
 * @property {"claude" | "codex"} harness
 * @property {boolean} harnessBin  the harness binary is found
 * @property {string | null} claudeBin  the Claude Code binary found (also outside PATH, through claudeBin or the environment)
 * @property {string | null} claudeDir  the Claude config directory the runner is set to read, when it is not the default one
 * @property {string | null} otherClaude  a Claude Code binary that is not on PATH and not usable as it is (snap, VS Code's own copy)
 * @property {"set" | "available" | "none"} harnessLogin  the runner has a harness login / one can be taken over (~/.claude, the Keychain) / none
 * @property {"token" | "config-dir" | "keychain" | null} claudeLogin  the kind of Claude login the runner is set to (a stored setup-token counts as "token" whatever else is set)
 * @property {boolean} loggedIn  the runner has an approved server credential (for `server`, when that is given)
 * @property {string | null} loggedInTo  the dashboard the runner's credential belongs to
 * @property {string | null} server  the dashboard URL given to setup
 * @property {string} me  the shell words that run this runner
 */

/**
 * One step of `setup`: a problem and how to fix it; `cmd` is a shell command, absent when only the user can fix it.
 * `defaultNo`: the command runs sudo or downloads and runs an installer, so only a typed yes runs it.
 * @typedef {{ id: string, problem: string, fix: string, cmd?: string, defaultNo?: boolean }} SetupStep
 */

/** The install command of each package manager, for the packages given. */
const PKG_INSTALL = {
  apt: (/** @type {string} */ p) => `apt-get update && apt-get install -y ${p}`, dnf: (/** @type {string} */ p) => `dnf install -y ${p}`,
  pacman: (/** @type {string} */ p) => `pacman -Sy --needed --noconfirm ${p}`, zypper: (/** @type {string} */ p) => `zypper --non-interactive install ${p}`,
  apk: (/** @type {string} */ p) => `apk add ${p}`,
};
const BWRAP_PROFILE = "/etc/apparmor.d/bwrap-userns-restrict";
/** Ubuntu's copy of the profile (apparmor 4.x, package apparmor-profiles); newer releases install it in /etc/apparmor.d themselves. */
const BWRAP_PROFILE_SHIPPED = "/usr/share/apparmor/extra-profiles/bwrap-userns-restrict";
/**
 * Ubuntu's bwrap-userns-restrict profile, written when the system has no copy of it: bubblewrap may create user namespaces
 * and use capabilities inside them, and everything it starts runs stacked under unpriv_bwrap, which denies every
 * capability. A process can then get a sandbox through bwrap, but never a privileged namespace of its own.
 */
const BWRAP_USERNS_RESTRICT = (() => {
  const common = ["allow file rwlkm /{**,},", "allow network,", "allow unix,", "allow ptrace,", "allow signal,", "allow mqueue,", "allow io_uring,", "allow userns,", "allow mount,", "allow umount,", "allow pivot_root,", "allow dbus,"];
  return [
    "abi <abi/4.0>,",
    "include <tunables/global>",
    `profile bwrap ${BWRAP} flags=(attach_disconnected,mediate_deleted) {`,
    ...["allow capability,", ...common, "allow pix /** -> &bwrap//&unpriv_bwrap,", "include if exists <local/bwrap-userns-restrict>"].map((l) => `  ${l}`),
    "}",
    "profile unpriv_bwrap flags=(attach_disconnected,mediate_deleted) {",
    ...[...common, "allow pix /** -> &unpriv_bwrap,", "audit deny capability,", "include if exists <local/unpriv_bwrap>"].map((l) => `  ${l}`),
    "}",
  ];
})();
/** The installer is downloaded whole before bash runs it, so a broken download never runs in part. */
const CLAUDE_INSTALL = `bash -c "$(curl -fsSL https://claude.ai/install.sh)"`;
/**
 * Writes BWRAP_PROFILE and loads it: a copy of BWRAP_PROFILE_SHIPPED when the system has it, else the lines given as
 * arguments. The text goes to a temporary file first, which a hard link then makes the profile: `ln` fails when a profile
 * exists (one that appeared meanwhile is never overwritten), and a write that fails never leaves a profile behind. Only a
 * profile this run linked is removed again when it does not load, so the next setup offers it once more.
 */
const APPARMOR_SCRIPT = `set -e; f=${BWRAP_PROFILE}; s=${BWRAP_PROFILE_SHIPPED}; t=$(mktemp "$f.XXXXXX"); trap 'rm -f "$t"' EXIT; if [ -r "$s" ]; then cat "$s" > "$t"; else printf '%s\\n' "$@" > "$t"; fi; chmod 644 "$t"; ln "$t" "$f"; apparmor_parser -r "$f" || { rm -f "$f"; exit 1; }`;
/** @param {string} s */
const shq = (s) => /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The steps that make this machine able to run calls, first to fix first; empty when nothing is missing.
 * @param {SetupFacts} f
 * @returns {SetupStep[]}
 */
export function setupSteps(f) {
  /** @type {SetupStep[]} */
  const out = [];
  const linux = f.platform === "linux", mac = f.platform === "darwin";
  if (!linux && !mac) return [{ id: "platform", problem: `${f.platform} cannot run calls: the harness runs in bubblewrap or sandbox-exec`, fix: "Install and run autocraft inside WSL (Ubuntu) on Windows, or on Linux or macOS." }];
  const sudo = f.root ? "" : "sudo ";
  if (f.missing.length) {
    const what = f.missing.join(", ");
    if (mac) out.push({ id: "packages", problem: `${what} not found`, fix: "Install the Xcode command line tools.", cmd: "xcode-select --install", defaultNo: true });
    else if (f.pkg) out.push({ id: "packages", problem: `${what} not found`, fix: `Install ${f.missing.length > 1 ? "them" : "it"} with ${f.pkg}${sudo ? " (asks for your password)" : ""}.`, cmd: `${sudo}sh -c ${shq(PKG_INSTALL[f.pkg](f.missing.join(" ")))}`, defaultNo: true });
    else out.push({ id: "packages", problem: `${what} not found`, fix: "Install them with your system's package manager." });
  }
  if (linux && f.sandbox === "failed") {
    if (f.userns && !f.bwrapProfile) {
      out.push({
        id: "apparmor", problem: `a sandbox does not start: AppArmor restricts unprivileged user namespaces (${f.sandboxError.slice(0, 120)})`,
        fix: `Load Ubuntu's bwrap-userns-restrict AppArmor profile as ${BWRAP_PROFILE} (a copy of ${BWRAP_PROFILE_SHIPPED} when it exists, else the same rules). It lets any program on this machine run ${BWRAP} to create user namespaces; everything bwrap starts runs without capabilities. To undo it: sudo apparmor_parser -R ${BWRAP_PROFILE}, then delete the file.`,
        cmd: `${sudo}sh -c ${shq(APPARMOR_SCRIPT)} sh ${BWRAP_USERNS_RESTRICT.map(shq).join(" ")}`, defaultNo: true,
      });
    } else if (f.userns) out.push({ id: "sandbox", problem: `a sandbox does not start: ${f.sandboxError.slice(0, 200)}`, fix: `${BWRAP_PROFILE} exists but may not be loaded; load it.`, cmd: `${sudo}apparmor_parser -r ${BWRAP_PROFILE}`, defaultNo: true });
    else out.push({ id: "sandbox", problem: `a sandbox does not start: ${f.sandboxError.slice(0, 200)}`, fix: "bubblewrap needs unprivileged user namespaces; check the kernel settings (user.max_user_namespaces, kernel.unprivileged_userns_clone) and AppArmor." });
  }
  if (!f.harnessBin) {
    if (f.harness === "codex") out.push({ id: "harness-bin", problem: "codex not found on PATH", fix: `Install Codex ${CODEX_AUDITED.map((v) => `${v}.x`).join(" or ")} (npm install -g @openai/codex@<version>), or set codexBin in the config.` });
    else {
      const why = f.otherClaude ? ` (${f.otherClaude} cannot be used: it is not a standalone binary at a fixed path)` : "";
      out.push({ id: "harness-bin", problem: `claude not found on PATH${why}`, fix: "Download Claude Code's native installer from claude.ai and run it; it installs into ~/.local/bin (no sudo).", cmd: CLAUDE_INSTALL, defaultNo: true });
    }
  } else if (f.harnessLogin === "available") {
    out.push(mac
      ? { id: "harness-login", problem: "no harness login chosen", fix: "Use Claude Code's own login from the Keychain.", cmd: `${f.me} harness claude --keychain` }
      : { id: "harness-login", problem: "no harness login chosen", fix: "Use the Claude login in your Claude config directory, read before each call.", cmd: `${f.me} harness claude --config-dir` });
  } else if (f.harnessLogin === "none") {
    if (f.harness === "codex") out.push({ id: "harness-login", problem: "Codex is not logged in for the runner", fix: "Log Codex in to the runner's own CODEX_HOME.", cmd: `${f.me} harness codex` });
    // A stored setup-token, or a config directory on macOS (which keeps the login in the Keychain), is replaced only by
    // `harness claude`; signing in to Claude Code again would not change it.
    else if (f.claudeLogin === "token" || (mac && f.claudeLogin === "config-dir")) out.push({
      id: "harness-token", problem: f.claudeLogin === "token" ? "the stored Claude setup-token gives no login" : "the runner is set to a Claude config directory, which macOS does not use",
      fix: "Paste a new token from `claude setup-token`.", cmd: `${f.me} harness claude`,
    });
    else out.push({ id: "claude-signin", problem: "Claude Code is not signed in", fix: "Start Claude Code, sign in, then type /exit; setup goes on.", cmd: `${f.claudeDir ? `CLAUDE_CONFIG_DIR=${shq(f.claudeDir)} ` : ""}${shq(f.claudeBin ?? "claude")}` });
  }
  if (!f.loggedIn) {
    const other = f.server && f.loggedInTo && f.loggedInTo !== f.server;
    if (f.server) out.push({ id: "login", problem: other ? `logged in to ${f.loggedInTo}, not to ${f.server}` : "not logged in to a dashboard", fix: `Log in to ${f.server}${other ? ` (this replaces the login to ${f.loggedInTo})` : ""}, then approve the code on its Connect page.`, cmd: `${f.me} login ${shq(f.server)}` });
    else out.push({ id: "login", problem: "not logged in to a dashboard", fix: "Run `autocraft setup <dashboard URL>`, or `autocraft login <dashboard URL>`." });
  }
  return out;
}

/** @param {string} bin */
function onPath(bin) {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).some((d) => { try { accessSync(join(d, bin), constants.X_OK); return true; } catch { return false; } });
}

/**
 * macOS without the developer tools still has /usr/bin/git, a stub that only offers to install them: it counts as missing.
 */
function gitStub() {
  if (process.platform !== "darwin") return false;
  const git = (process.env.PATH ?? "").split(delimiter).map((p) => join(p, "git")).find((f) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } });
  if (!git) return false;
  let real = git;
  try { real = realpathSync(git); } catch { /* as found */ }
  return appleGitStub(real, () => spawnSync("xcode-select", ["-p"], { encoding: "utf8", timeout: 10_000 }).status === 0);
}

/**
 * Whether the git that PATH resolves to (symlinks followed) is macOS's stub: /usr/bin/git without the developer tools.
 * @param {string} resolved @param {() => boolean} toolsInstalled
 */
export const appleGitStub = (resolved, toolsInstalled) => resolved === "/usr/bin/git" && !toolsInstalled();

/** Whether Claude Code's Keychain item exists; its secret is not read. */
function keychainItemExists(item = claudeKeychainItem()) {
  return process.platform === "darwin" && spawnSync("/usr/bin/security", ["find-generic-password", "-a", item.account, "-s", item.service], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

/** @param {string | null} server @returns {SetupFacts} */
function setupFacts(server) {
  const cfg = loadConfig();
  const linux = process.platform === "linux";
  const pkgs = /** @type {const} */ (["apt", "dnf", "pacman", "zypper", "apk"]);
  const pkg = linux ? pkgs.find((p) => onPath(p === "apt" ? "apt-get" : p)) ?? null : null;
  const adapter = adapterOf(cfg);
  const d = adapter.detect(cfg);
  // Claude Code's installer needs curl and bash; macOS has both.
  const installer = linux && adapter.id === "claude" && !d.bin ? ["curl", "bash"] : [];
  const missing = [...(linux && !existsSync(BWRAP) ? ["bubblewrap"] : []), ...["git", "tar", ...installer].filter((t) => !onPath(t) || (t === "git" && gitStub()))];
  const probe = linux && existsSync(BWRAP) ? sandboxProbe() : null;
  /** @param {string} f */
  const read = (f) => { try { return readFileSync(f, "utf8").trim(); } catch { return ""; } };
  let otherClaude = null;
  if (adapter.id === "claude" && !d.bin) {
    if (existsSync("/snap/bin/claude-code")) otherClaude = "the snap claude-code";
    else {
      const vsc = join(homedir(), ".vscode-server", "extensions");
      try { if (readdirSync(vsc).some((e) => e.startsWith("anthropic.claude-code-"))) otherClaude = "VS Code's own Claude Code"; } catch { /* none */ }
    }
  }
  /** @type {SetupFacts["harnessLogin"]} */
  let harnessLogin = "none";
  // A login chosen before counts only while it still gives a token (its credentials file or Keychain item may be gone).
  if (adapter.id === "codex") harnessLogin = d.loggedIn ? "set" : "none";
  else if (cfg.claudeConfigDir || cfg.claudeAuth === "keychain" || cfg.claudeToken) harnessLogin = d.loggedIn ? "set" : "none";
  else if (process.platform === "darwin" ? keychainItemExists() : typeof readClaudeCredentials(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"))?.claudeAiOauth?.accessToken === "string") harnessLogin = "available";
  return {
    platform: process.platform, root: process.getuid?.() === 0, pkg, missing,
    sandbox: probe ? (probe.ok ? "ok" : "failed") : null, sandboxError: probe?.error ?? "",
    userns: read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1", bwrapProfile: existsSync(BWRAP_PROFILE),
    harness: adapter.id === "codex" ? "codex" : "claude", harnessBin: !!d.bin, otherClaude, harnessLogin,
    claudeLogin: cfg.claudeToken ? "token" : cfg.claudeConfigDir ? "config-dir" : cfg.claudeAuth === "keychain" ? "keychain" : null,
    claudeBin: adapter.id === "claude" ? d.bin : null,
    claudeDir: cfg.claudeConfigDir && resolve(cfg.claudeConfigDir) !== resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")) ? cfg.claudeConfigDir : null,
    loggedIn: !!cfg.server && !!credentialOf(cfg) && (!server || cfg.server === server), loggedInTo: cfg.server && credentialOf(cfg) ? cfg.server : null, server,
    me: `${shq(process.execPath)} ${shq(realpathSync(self))}`,
  };
}

/**
 * Asks a yes/no question on the terminal; an empty answer is `dflt`. What was typed before the question shows (answers
 * typed ahead, input left over from the step before) is read in raw mode and dropped first, so it never answers it.
 * @param {string} q @param {boolean} dflt
 */
async function confirm(q, dflt) {
  const stdin = process.stdin;
  const drop = () => {};
  stdin.setRawMode(true);
  stdin.on("data", drop);
  stdin.resume();
  await sleep(50);
  stdin.off("data", drop);
  stdin.pause();
  stdin.setRawMode(false);
  const rl = createInterface({ input: stdin, output: process.stdout });
  try {
    const a = (await new Promise((r) => rl.question(q, r))).trim();
    return a ? /^(y|yes)$/i.test(a) : dflt;
  } finally { rl.close(); }
}

/**
 * `setup [<dashboard URL>] [--yes]`: finds what this machine lacks (bubblewrap, git, tar, the AppArmor rule bubblewrap needs on
 * Ubuntu, Claude Code, its login, the dashboard login), shows the command that adds each and runs it when the user agrees
 * (`--yes`: without asking), then runs doctor. Without a terminal and without --yes it only lists the commands.
 * @param {string[]} argv
 */
async function cmdSetup(argv) {
  const usage = "usage: autocraft setup [<dashboard URL>] [--yes]";
  for (const a of argv) if (a.startsWith("-") && a !== "--yes" && a !== "-y") throw new UsageError(usage);
  const urls = argv.filter((a) => !a.startsWith("-"));
  if (urls.length > 1) throw new UsageError(usage);
  const server = urls[0] ? serverUrl(urls[0]) : null;
  const yes = argv.includes("--yes") || argv.includes("-y");
  const ask = !yes && !!process.stdin.isTTY && !!process.stdout.isTTY;
  // The native Claude installer puts claude into ~/.local/bin; look there too after it ran.
  const local = join(homedir(), ".local", "bin");
  const pathHad = (process.env.PATH ?? "").split(delimiter).includes(local);
  if (!pathHad) process.env.PATH = [process.env.PATH, local].filter(Boolean).join(delimiter);
  // Each step is offered once; after it ran (or was declined) the next one is computed from a fresh look at the machine.
  const done = new Set();
  let listed = 0;
  for (;;) {
    const step = setupSteps(setupFacts(server)).find((s) => !done.has(s.id));
    if (!step) break;
    done.add(step.id);
    listed++;
    console.log(`\nmissing: ${step.problem}\n  ${step.fix}`);
    if (!step.cmd) continue;
    console.log(`  $ ${step.cmd}`);
    if (!yes && !(ask && await confirm(`  Run it now? ${step.defaultNo ? "[y/N]" : "[Y/n]"} `, !step.defaultNo))) continue;
    const r = spawnSync("sh", ["-c", step.cmd], { stdio: "inherit" });
    if (r.status !== 0) console.log(`  that ended with exit code ${r.status ?? r.signal}`);
  }
  if (!listed) console.log("nothing is missing");
  else if (!yes && !ask) console.log("\nNo terminal to ask on: run the commands above yourself, or `autocraft setup --yes` to run them.");
  if (!pathHad) console.log(`\nnote: ${local} is not on your PATH; add it in your shell's profile (for example: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc) so autocraft and claude are found.`);
  console.log("");
  return cmdDoctor();
}

/**
 * The harness's version command inside the macOS profile, in a scratch slot.
 * @param {Adapter} adapter @param {string} bin
 */
function macVersion(adapter, bin) {
  const root = scratchSlot("doctor");
  const install = adapter.install(bin);
  const profile = `${root}.sb`;
  const codex = adapter.id === "codex" && existsSync(codexHome());
  writeFileSync(profile, macProfile({ deny: macDenied(realpathSync(homedir())), files: install.files, dirs: install.dirs, ...(codex && { writes: [realpathSync(codexHome())] }) }), { mode: 0o600 });
  return macCommand({ profile, root, argv: [...install.argv, "--version"], env: adapter.id === "codex" ? { CODEX_HOME: codexHome() } : { CLAUDE_CONFIG_DIR: `${root}/tmp/home/.claude`, DISABLE_AUTOUPDATER: "1" } });
}

/**
 * Proxies stdio MCP (one JSON-RPC message per line) to the lease's streamable HTTP server `name`.
 * The secret comes from the lease store, or from AUTOCRAFT_RUNNER_LEASE_SECRET and AUTOCRAFT_RUNNER_SERVER inside a sandbox.
 * @param {string[]} argv
 */
async function cmdMcp(argv) {
  const [name, id] = argv;
  if (!name || !NAME.test(name) || !id) throw new Error("usage: autocraft mcp <server-name> <lease>");
  const { secret, server } = leaseAccess(id);
  const url = `${server}${ROUTES.mcp}/${name}`;
  let session = "", version = "";
  /** @param {unknown} m */
  const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  /** @param {string} line */
  const forward = async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    // A tool call of a server whose calls must not run twice is sent again only when it certainly did not run.
    const once = ONCE_SERVERS.has(name) && m?.method === "tools/call";
    try {
      // Retried until the server answers with a status that is not transient; a reply's body, once read, is not.
      const res = await withRetry(async () => {
        const res = await fetch(url, { method: "POST", body: line, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session && { "Mcp-Session-Id": session }), ...(version && { "MCP-Protocol-Version": version }) } });
        if (res.status === 410) throw new Gone("the lease is gone");
        if (!res.ok && res.status !== 202) throw new HttpError(`${ROUTES.mcp}/${name}`, res.status, await res.text().catch(() => ""), retryAfterMs(res.headers.get("retry-after")));
        return res;
      }, { deadline: Date.now() + TOOL_RETRY_MS, ...(once && { again: notRun }) });
      const sid = res.headers.get("mcp-session-id");
      if (sid) session = sid;
      if (res.status === 202) return;
      /** @param {any} x */
      const emit = (x) => { if (x?.result?.protocolVersion && m?.method === "initialize") version = x.result.protocolVersion; out(x); };
      if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
        let buf = "";
        for await (const chunk of /** @type {any} */ (res.body)) {
          buf += Buffer.from(chunk).toString("utf8");
          let k;
          while ((k = buf.indexOf("\n\n")) >= 0) {
            const ev = buf.slice(0, k); buf = buf.slice(k + 2);
            const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (data) try { emit(JSON.parse(data)); } catch { /* not JSON */ }
          }
        }
      } else {
        const text = await res.text();
        if (text) { const j = JSON.parse(text); for (const x of Array.isArray(j) ? j : [j]) emit(x); }
      }
    } catch (e) {
      const why = once && !(e instanceof Gone) && !notRun(e) ? msg(mayHaveRun(e)) : msg(e);
      if (m && m.id !== undefined && m.method) out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `autocraft proxy: ${why}` } });
    }
  };
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const p = forward(line).finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
  return 0;
}

/**
 * The secret and server of a lease: from the lease store, or from AUTOCRAFT_RUNNER_LEASE_SECRET and AUTOCRAFT_RUNNER_SERVER inside a sandbox.
 * @param {string | undefined} id
 */
function leaseAccess(id) {
  const lease = id === undefined ? null : readLease(leaseId(id));
  const secret = lease?.secret ?? process.env.AUTOCRAFT_RUNNER_LEASE_SECRET;
  const server = lease?.server ?? process.env.AUTOCRAFT_RUNNER_SERVER ?? loadConfig().server;
  if (!secret || !server) throw new Error(id === undefined ? "no lease: give its id or set AUTOCRAFT_RUNNER_LEASE_SECRET" : `no lease ${id} on this machine`);
  secretsInUse.add(secret);
  return { secret: /** @type {string} */ (secret), server: /** @type {string} */ (server) };
}

/**
 * One tool call of a lease's server without MCP, for harnesses that take tools as commands: prints the result's text, exit 1 for an
 * error result. A `check` call can take minutes; the server keeps the request alive meanwhile.
 * @param {string[]} argv
 */
async function cmdTool(argv) {
  const [name, tool, json, id] = argv;
  if (!name || !NAME.test(name) || !tool || !/^[a-z][a-z0-9_]{0,60}$/.test(tool)) throw new Error("usage: autocraft tool <server-name> <tool> [<json arguments>] [<lease>]");
  let args;
  try { args = JSON.parse(json ?? "{}"); } catch { throw new Error("the tool arguments must be JSON"); }
  const { secret, server } = leaseAccess(id);
  // A `check` streams whitespace while it runs; a reply cut off or a 5xx runs the call again, except for a server whose calls must not run twice.
  const once = ONCE_SERVERS.has(name);
  /** @type {{ content?: { type?: string, text?: string }[], isError?: boolean }} */
  let r;
  try {
    r = await withRetry(() => api(server, `${ROUTES.tool}/${name}/${tool}`, secret, args, { timeoutMs: 60 * 60_000 }), { deadline: Date.now() + TOOL_RETRY_MS, ...(once && { again: notRun }) });
  } catch (e) {
    if (once && !(e instanceof Gone) && !notRun(e)) throw mayHaveRun(e);
    throw e;
  }
  console.log(contentText(r.content));
  return r.isError ? 1 : 0;
}

/**
 * The text of a tool reply's content, with a line for each image, which a command cannot show.
 * @param {{ type?: string, text?: string }[] | undefined} content
 */
export function contentText(content) {
  const c = content ?? [];
  const texts = c.filter((x) => x.type !== "image").map((x) => x.text ?? "");
  const images = c.length - texts.length;
  return [...texts, ...(images ? [`[${images} image${images === 1 ? "" : "s"} not shown: this command prints text only]`] : [])].join("\n");
}

// ---------------------------------------------------------------------------
// Service: `work` under the user's own service manager, started at login and restarted whenever it ends. No root.

const SERVICE_NAME = "autocraft";
/** Passed on to the service when set: PATH finds git, tar and the harness; the others name the helper's and Claude's directories. */
const SERVICE_ENV = ["PATH", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR"];

/**
 * A systemd user unit that runs `argv` and restarts it whenever it ends. A stop signals the helper alone (KillMode=mixed),
 * so it gives its running calls back before the rest of the unit is killed.
 * @param {{ argv: string[], env: Record<string, string> }} s
 */
export function systemdUnit(s) {
  const q = (/** @type {string} */ v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  return [
    "[Unit]",
    "Description=AutoCraft Task Runner (autocraft work)",
    "",
    "[Service]",
    `ExecStart=${s.argv.map((a) => q(a).replace(/\$/g, "$$$$")).join(" ")}`,
    ...Object.entries(s.env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`),
    "Restart=always",
    "RestartSec=30",
    "KillMode=mixed",
    "TimeoutStopSec=90",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * A launchd agent that runs `argv` at login and again whenever it ends, its output appended to `log`.
 * @param {{ label: string, argv: string[], env: Record<string, string>, log: string }} s
 */
export function launchdPlist(s) {
  const x = (/** @type {string} */ v) => `<string>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${x(s.label)}
  <key>ProgramArguments</key>
  <array>
${s.argv.map((a) => `    ${x(a)}`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(s.env).map(([k, v]) => `    <key>${k}</key>${x(v)}`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>90</integer>
  <key>StandardOutPath</key>${x(s.log)}
  <key>StandardErrorPath</key>${x(s.log)}
</dict>
</plist>
`;
}

const LINGER_HINT = "The service stops when you log out. To keep it running: loginctl enable-linger";

/** True when systemd reports lingering off for this user; false when it is on or `loginctl` is missing or fails. */
function lingerOff() {
  const r = spawnSync("loginctl", ["show-user", userInfo().username, "--property=Linger", "--value"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 && r.stdout.trim() === "no";
}

/** `service install [--parallel N] | uninstall | status`. @param {string[]} argv */
async function cmdService(argv) {
  const [action, ...rest] = argv;
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") throw new Error("service runs on Linux (a systemd user unit) and macOS (a launchd agent)");
  const file = mac ? launchdPlistFile(SERVICE_NAME) : systemdUnitFile(SERVICE_NAME);
  const log = join(cacheDir(), "service.log");
  const job = `gui/${userInfo().uid}/${SERVICE_NAME}`;
  const logLine = mac ? `log: tail -f ${log}` : `log: journalctl --user -u ${SERVICE_NAME} -f`;
  if (action === "install") {
    parallelOf(rest);
    needLogin(loadConfig());
    const run = [process.execPath, realpathSync(self), "work", ...rest];
    const env = Object.fromEntries(SERVICE_ENV.flatMap((k) => (process.env[k] ? [[k, String(process.env[k])]] : [])));
    mkdirSync(dirname(file), { recursive: true });
    if (mac) {
      privateDir(cacheDir());
      writeFileSync(file, launchdPlist({ label: SERVICE_NAME, argv: run, env, log }), { mode: 0o644 });
      sys("/bin/launchctl", ["bootout", job]);
      must("/bin/launchctl", ["bootstrap", `gui/${userInfo().uid}`, file]);
    } else {
      writeFileSync(file, systemdUnit({ argv: run, env }), { mode: 0o644 });
      must("systemctl", ["--user", "daemon-reload"]);
      must("systemctl", ["--user", "enable", SERVICE_NAME]);
      must("systemctl", ["--user", "restart", SERVICE_NAME]);
    }
    // The service of autocraft-task up to 1.2.0 would run a second `work` beside this one.
    const legacy = mac ? launchdPlistFile(LEGACY_SERVICE) : systemdUnitFile(LEGACY_SERVICE);
    if (existsSync(legacy)) {
      if (mac) sys("/bin/launchctl", ["bootout", `gui/${userInfo().uid}/${LEGACY_SERVICE}`]);
      else sys("systemctl", ["--user", "disable", "--now", LEGACY_SERVICE]);
      rmSync(legacy, { force: true });
      if (!mac) sys("systemctl", ["--user", "daemon-reload"]);
      console.log(`removed the ${LEGACY_SERVICE} service`);
    }
    console.log(`installed ${file}: \`autocraft ${run.slice(2).join(" ")}\` runs ${mac ? "at login" : "with your user session"} and restarts whenever it ends`);
    console.log(logLine);
    if (!mac && lingerOff()) console.log(LINGER_HINT);
    return 0;
  }
  if (action === "uninstall") {
    if (!existsSync(file)) { console.log("no service installed"); return 0; }
    if (mac) sys("/bin/launchctl", ["bootout", job]);
    else sys("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
    rmSync(file, { force: true });
    if (!mac) sys("systemctl", ["--user", "daemon-reload"]);
    console.log(`removed ${file}; the helper no longer runs as a service`);
    return 0;
  }
  if (action === "status") {
    if (!existsSync(file)) { console.log("no service installed: autocraft service install [--parallel N]"); return 3; }
    const r = mac ? sys("/bin/launchctl", ["print", job]) : sys("systemctl", ["--user", "status", SERVICE_NAME, "--no-pager", "--lines", "10"]);
    const out = mac ? r.out.split("\n").filter((l) => /^\s*(state|pid|last exit code|runs) =/.test(l)).map((l) => l.trim()).join("\n") : r.out;
    console.log(r.ok || out ? out || "loaded" : "installed, not loaded");
    console.log(logLine);
    return r.ok ? 0 : 3;
  }
  throw new Error("usage: autocraft service install [--parallel N] | uninstall | status");
}

// ---------------------------------------------------------------------------
// Moving an autocraft-task 1.2.0 install over: its directories, agent token, installed binary and service.

/** The service and launchd label of autocraft-task up to 1.2.0. */
const LEGACY_SERVICE = "autocraft-task";
/** A migration that failed is tried again at a `work` start this long after. */
const MIGRATE_RETRY_MS = 24 * 3600_000;
/** After switching services from inside the old one, how long `work` waits for the old one's stop before it claims anyway. */
const SWITCH_STOP_WAIT_MS = 2 * 60_000;

/** @param {string} name */
const systemdUnitFile = (name) => join(xdgConfig(), "systemd", "user", `${name}.service`);
/** @param {string} name */
const launchdPlistFile = (name) => join(homedir(), "Library", "LaunchAgents", `${name}.plist`);

/** @param {string} cmd @param {string[]} args */
function sys(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() };
}
/** @param {string} cmd @param {string[]} args */
function must(cmd, args) {
  const r = sys(cmd, args);
  if (!r.ok) throw new Error(`${cmd} ${args.join(" ")}: ${r.out.slice(0, 300)}`);
}

/** The pid a lock file names, when that process lives and is not this one. @param {string} file */
function lockHolder(file) {
  const pid = Number.parseInt((() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })(), 10);
  return pid > 0 && pid !== process.pid && alive(pid) ? pid : null;
}
/** @param {string} dir @param {RegExp} re */
const filesIn = (dir, re) => { try { return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f)); } catch { return []; } };

/**
 * Whether another process runs calls from the legacy directories: a slot lock (macOS), a harness lock or a running run
 * that names a live process other than this one.
 */
export function legacyBusy() {
  if (process.platform === "darwin") {
    let base = null;
    try { base = join(darwinCacheDir(), LEGACY_DIR); } catch { /* no per-user cache directory */ }
    if (base && filesIn(base, /^slot-\d+\.lock$/).some(lockHolder)) return true;
  }
  if (realDir(legacyConfigDir()) && filesIn(legacyConfigDir(), /\.lock$/).some(lockHolder)) return true;
  if (!realDir(legacyCacheDir())) return false;
  return filesIn(join(legacyCacheDir(), "runs"), /^\d+\.json$/).some((f) => {
    const r = readJson(f);
    return r?.state === "running" && Number.isInteger(r.pid) && r.pid !== process.pid && alive(r.pid);
  });
}

/**
 * Moves directory `from` to `to` and leaves a symlink at `from`. When `to` exists, the entries of `from` move into it;
 * an entry both have keeps the one in `to` (config.json: merged, `to`'s fields win).
 * @param {string} from @param {string} to @returns {boolean} whether anything moved
 */
function moveDir(from, to) {
  if (!realDir(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  if (!existsSync(to)) renameSync(from, to);
  else {
    for (const e of readdirSync(from)) {
      const a = join(from, e), b = join(to, e);
      if (!existsSync(b)) renameSync(a, b);
      else if (e === "config.json") { writePrivate(b, { ...readJson(a), ...readJson(b) }); rmSync(a, { force: true }); }
      else rmSync(a, { recursive: true, force: true });
    }
    rmSync(from, { recursive: true, force: true });
  }
  symlinkSync(to, from);
  return true;
}

/**
 * Unquotes the words of a unit's ExecStart (`exec`) or Environment line as systemdUnit writes them (bare words too).
 * @param {string} line @param {boolean} exec
 */
export function unitWords(line, exec) {
  /** @type {string[]} */
  const out = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const w = (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]).replace(/%%/g, "%");
    out.push(exec ? w.replace(/\$\$/g, "$") : w);
  }
  return out;
}

/** The command and environment of an installed service of autocraft-task, or null when it has none. @param {string} file @param {boolean} mac */
export function legacyService(file, mac) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  /** @type {string[]} */
  let argv = [];
  /** @type {Record<string, string>} */
  const env = {};
  if (mac) {
    const unx = (/** @type {string} */ v) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
    argv = [...args.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unx(m[1]));
    const vars = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "";
    for (const m of vars.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) env[unx(m[1])] = unx(m[2]);
  } else {
    for (const line of text.split("\n")) {
      const exec = /^ExecStart=(.*)$/.exec(line);
      if (exec) argv = unitWords(exec[1], true);
      const e = /^Environment=(.*)$/.exec(line);
      if (e) for (const w of unitWords(e[1], false)) { const i = w.indexOf("="); if (i > 0) env[w.slice(0, i)] = w.slice(i + 1); }
    }
  }
  return { argv, env };
}

/** The old service's command with this file in place of its script: the same `work` arguments. @param {string[]} argv @param {string} file */
export function movedCommand(argv, file) {
  const w = argv.indexOf("work");
  if (w < 1) return [process.execPath, file, "work"];
  return [...argv.slice(0, w - 1), file, ...argv.slice(w)];
}

/**
 * Moves an install of autocraft-task (up to 1.2.0) over, once, under a lock; best effort, throws what failed.
 * 1. The legacy config and cache directories move to the runner's (symlinks left behind), when no other process uses them;
 *    the agent token of config.json moves into credentials.json.
 * 2. An installed copy named `autocraft-task` is renamed `autocraft`, with an `autocraft-task` symlink left as an alias.
 * 3. The legacy service is replaced by an `autocraft` one with the same `work` arguments and environment: from inside the
 *    old service (which then stops this process: `switched`), or run by hand (`manual`) while it runs no call. The old
 *    service is disabled and removed only once the new one has started; a failed start throws and leaves it as it was.
 * Returns what it did, one line each, and whether this process now waits for its service's stop.
 * @param {{ manual?: boolean, cgroup?: string }} [o] `cgroup`: the file naming this process's control group (Linux)
 * @returns {{ lines: string[], switched: boolean }}
 */
export function migrateLegacy(o = {}) {
  const mac = process.platform === "darwin";
  const oldFile = mac ? launchdPlistFile(LEGACY_SERVICE) : systemdUnitFile(LEGACY_SERVICE);
  const installed = basename(realpathSync(self)) === LEGACY_SERVICE;
  /** @type {string[]} */
  const lines = [];
  const legacyDirs = realDir(legacyConfigDir()) || realDir(legacyCacheDir());
  if (!legacyDirs && !installed && !existsSync(oldFile) && !loadConfig().agentToken) return { lines, switched: false };
  mkdirSync(xdgConfig(), { recursive: true });
  const unlock = takeLockFile(`${legacyConfigDir()}.migrate.lock`);
  if (!unlock) return { lines: ["another process moves autocraft-task over now"], switched: false };
  try {
    const inUnit = mac ? process.env.XPC_SERVICE_NAME === LEGACY_SERVICE
      : (() => { try { return /\/autocraft-task\.service(\/|$)/m.test(readFileSync(o.cgroup ?? "/proc/self/cgroup", "utf8")); } catch { return false; } })();
    const old = existsSync(oldFile) ? legacyService(oldFile, mac) : null;
    const job = `gui/${userInfo().uid}/${LEGACY_SERVICE}`;
    // Run by hand while the old service holds no call: it stops first, so nothing uses the directories while they move.
    let stopped = false;
    if (old && o.manual && !inUnit) {
      if (legacyBusy()) lines.push(`the ${LEGACY_SERVICE} service is running calls; it switches at its next restart`);
      else { if (mac) sys("/bin/launchctl", ["bootout", job]); else sys("systemctl", ["--user", "stop", LEGACY_SERVICE]); stopped = true; }
    }
    // 1. Directories and the agent token.
    const dirsFree = !legacyDirs || !legacyBusy();
    if (dirsFree) {
      for (const [from, to] of [[legacyConfigDir(), join(xdgConfig(), RUNNER_DIR)], [legacyCacheDir(), join(xdgCache(), RUNNER_DIR)]]) {
        if (moveDir(from, to)) lines.push(`moved ${from} to ${to}`);
      }
      // Session records name their store by path; sandbox-exec matches resolved paths, so they name the moved one.
      for (const f of filesIn(sessionsDir(), /^\d+\.json$/)) {
        const rec = readJson(f), prefix = `${legacyCacheDir()}/`;
        if (typeof rec?.dir === "string" && rec.dir.startsWith(prefix)) writePrivate(f, { ...rec, dir: join(xdgCache(), RUNNER_DIR, rec.dir.slice(prefix.length)) });
      }
      const cfg = loadConfig(), c = loadCredentials();
      if (cfg.agentToken && !(c.state === "approved" && c.credential)) {
        saveCredentials({ ...c, server: cfg.server, credential: cfg.agentToken, label: "", state: "approved" });
        lines.push("moved the agent token into credentials.json");
      }
    } else lines.push("another autocraft-task process uses its directories; they move at its next restart");
    // 2. The installed binary.
    let file = realpathSync(self);
    if (installed) {
      const to = join(dirname(file), "autocraft");
      if (!existsSync(to)) {
        renameSync(file, to);
        symlinkSync("autocraft", file);
        lines.push(`renamed ${file} to ${to}; ${LEGACY_SERVICE} stays as an alias`);
      }
      file = to;
    }
    // 3. The service.
    let switched = false;
    if (old && dirsFree && (inUnit || stopped)) {
      const argv = movedCommand(old.argv, file);
      const newFile = mac ? launchdPlistFile(SERVICE_NAME) : systemdUnitFile(SERVICE_NAME);
      const wrote = !existsSync(newFile);
      if (wrote) {
        mkdirSync(dirname(newFile), { recursive: true });
        writeFileSync(newFile, mac ? launchdPlist({ label: SERVICE_NAME, argv, env: old.env, log: join(xdgCache(), RUNNER_DIR, "service.log") }) : systemdUnit({ argv, env: old.env }), { mode: 0o644 });
      }
      if (mac) {
        must("/bin/launchctl", ["bootstrap", `gui/${userInfo().uid}`, newFile]);
        rmSync(oldFile, { force: true });
        // Last: from inside the old agent this stops this process, so the lock goes first.
        unlock();
        if (!stopped) sys("/bin/launchctl", ["bootout", job]);
      } else {
        // The old unit stays installed and enabled until the new one has started, so a failed start leaves a working runner.
        try {
          must("systemctl", ["--user", "daemon-reload"]);
          must("systemctl", ["--user", "enable", SERVICE_NAME]);
          must("systemctl", ["--user", "start", SERVICE_NAME]);
        } catch (e) {
          sys("systemctl", ["--user", "disable", SERVICE_NAME]);
          if (wrote) rmSync(newFile, { force: true });
          sys("systemctl", ["--user", "daemon-reload"]);
          if (stopped) sys("systemctl", ["--user", "start", LEGACY_SERVICE]);
          throw new Error(`the ${SERVICE_NAME} service did not start; ${LEGACY_SERVICE} stays: ${msg(e)}`);
        }
        sys("systemctl", ["--user", "disable", LEGACY_SERVICE]);
        rmSync(oldFile, { force: true });
        sys("systemctl", ["--user", "daemon-reload"]);
        // Last: from inside the old unit this stops this process, which holds no lease yet. The stop skips the `finally` below.
        unlock();
        if (inUnit) sys("systemctl", ["--user", "--no-block", "stop", LEGACY_SERVICE]);
      }
      switched = inUnit;
      lines.push(`the ${SERVICE_NAME} service replaces ${LEGACY_SERVICE}: ${argv.slice(1).join(" ")}`);
    } else if (stopped) {
      // The directories could not move: the old service goes on as it was.
      if (mac) sys("/bin/launchctl", ["bootstrap", `gui/${userInfo().uid}`, oldFile]); else sys("systemctl", ["--user", "start", LEGACY_SERVICE]);
    } else if (old && !inUnit && !o.manual) lines.push(`the ${LEGACY_SERVICE} service switches to ${SERVICE_NAME} at its next restart, or with \`autocraft migrate\``);
    // The agent token leaves config.json once no 1.2.0 service may still read it there (through the symlink).
    const cfg = loadConfig();
    if (dirsFree && cfg.agentToken && !existsSync(oldFile) && loadCredentials().credential) {
      const { agentToken: _a, ...rest } = cfg;
      saveConfig(rest);
    }
    return { lines, switched };
  } finally { unlock(); }
}

/** `migrate`: moves an autocraft-task install over now. */
function cmdMigrate() {
  const r = migrateLegacy({ manual: true });
  for (const l of r.lines) console.log(l);
  if (!r.lines.length) console.log("nothing to move: no autocraft-task install found");
  return 0;
}

/**
 * At a `work` start: the migration, unless one failed in the last day. A failure is logged and the runner goes on as it is.
 * True when this process switched services from inside the old one and should only wait for its stop.
 */
function migrateAtStart() {
  const file = join(configDir(), "migrate.json");
  const failedAt = readJson(file)?.failedAt;
  if (typeof failedAt === "number" && Date.now() - failedAt < MIGRATE_RETRY_MS) return false;
  try {
    const r = migrateLegacy();
    for (const l of r.lines) console.log(`migrate: ${l}`);
    return r.switched;
  } catch (e) {
    console.log(`migrate: moving autocraft-task over failed: ${msg(e)}; the runner goes on as it is and tries again in a day`);
    try { writePrivate(join(configDir(), "migrate.json"), { failedAt: Date.now(), error: msg(e).slice(0, 300) }); } catch { /* next start tries again */ }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Server commands: the server's MCP tools (/mcp, Streamable HTTP, JSON-RPC) behind command groups (inbox, queue, calls, ...),
// with the runner's own credential. CLI_COMMANDS maps each command to its tool; `call` reaches any tool by its name.
// Arguments are typed by the tool's inputSchema.

/** A wrong command line: exit code 2. */
class UsageError extends Error {}

/** @param {Set<string>} has */
const answerWhy = (has) => (has.has("set_weight")
  ? "this Task Runner cannot approve merges: tick \"Can answer decisions and approve merges\" for it on the Connect page (the server must offer answering)"
  : "only operators, and maintainers who answer decisions (an answering Task Runner while maintainer writes are on), approve merges");
/** Withdrawing an approved merge stays with operators, also where a maintainer may approve one. @param {Set<string>} has */
const cancelWhy = (has) => (has.has("set_weight") ? answerWhy(has) : "only operators withdraw an approved merge");
const WS_WHY = "only operators, and maintainers with write access to the repo, open workspaces, and only where a kubernetes environment takes them";
const LOCAL_WHY = "model calls run on the server's accounts here: the server is not in the user-local inference mode";
/** @param {Set<string>} has */
const pickWhy = (has) => (has.has("list_model_calls") ? "only maintainers and operators pick model calls" : LOCAL_WHY);

/**
 * A server command. `args`: the tool arguments its positional words fill, in order; `flags`: CLI flag → tool argument;
 * `why`: one line on why the credential is not offered the tool. Options not named here pass through as `--<argument>`.
 * @typedef {{ path: string[], tool: string, usage: string, summary: string, args?: string[], flags?: Record<string, string>, why?: (has: Set<string>) => string }} CliCommand
 */
/** @type {readonly CliCommand[]} */
export const CLI_COMMANDS = [
  { path: ["inbox"], tool: "list_inbox", usage: "[--repo R] [--kind K] [--limit N] [--cursor C]", summary: "open decisions, oldest first" },
  { path: ["inbox", "show"], tool: "get_inbox_item", args: ["id"], usage: "<id>", summary: "one decision: question, options, summary, item text, feedback" },
  { path: ["inbox", "feedback"], tool: "send_feedback", args: ["id"], flags: { pick: "option", note: "text" }, usage: "<id> --pick <key> --note \"...\"", summary: "your pick of one option and/or a note; an operator answers" },
  { path: ["queue"], tool: "list_merge_queue", usage: "[--repo R] [--limit N] [--cursor C]", summary: "each PR's state, weight and what it waits for" },
  { path: ["queue", "add"], tool: "queue_pr", args: ["item"], usage: "<pr> [--weight N]", summary: "approve a PR's merge ahead and fast-track it", why: answerWhy },
  { path: ["queue", "weight"], tool: "set_weight", args: ["item", "weight"], usage: "<item> <N>", summary: "set an item's fast-track weight; --remove takes it off", why: () => "only operators steer the merge queue" },
  { path: ["queue", "remove"], tool: "cancel_queued", args: ["item"], usage: "<pr>", summary: "withdraw a PR's approved merge", why: cancelWhy },
  { path: ["calls"], tool: "list_model_calls", usage: "", summary: "model calls waiting for a Task Runner, and why each waits", why: () => LOCAL_WHY },
  { path: ["calls", "pick"], tool: "pick_model_call", args: ["id"], usage: "<id>", summary: "reserve a call for your own Task Runners", why: pickWhy },
  { path: ["calls", "unpick"], tool: "unpick_model_call", args: ["id"], usage: "<id>", summary: "end a pick", why: pickWhy },
  { path: ["calls", "mine"], tool: "my_work", usage: "", summary: "today's calls on your machine, and your Task Runners", why: () => "needs one of your Task Runners reporting in, while the server is in the user-local inference mode" },
  { path: ["settings"], tool: "my_settings", usage: "", summary: "your reserve, repos, calls at once and interactive slots", why: () => "only maintainers and operators have settings" },
  { path: ["settings", "set"], tool: "set_my_settings", usage: "[--reserve <5h> <weekly>] [--max-calls N | --no-max-calls] [--repos <a,b>|all] [--interactive-slots N]", summary: "change them, as the Connect page does", why: () => "only maintainers and operators have settings" },
  { path: ["build"], tool: "list_builds", usage: "[--repo R] [--all] [--mine] [--limit N]", summary: "queued and running builds (--all adds ended ones)", why: () => "only operators, and maintainers with write access to the repo, start builds" },
  { path: ["build", "base"], tool: "build_base", args: ["repo"], usage: "<repo>", summary: "the default-branch commit a build starts from", why: () => "only operators, and maintainers with write access to the repo, start builds" },
  { path: ["build", "status"], tool: "build_status", args: ["id"], usage: "<id> [--log-lines N]", summary: "a build's phase, each line's state and exit code, and the end of its log", why: () => "only operators, and maintainers with write access to the repo, start builds" },
  { path: ["build", "cancel"], tool: "cancel_build", args: ["id"], usage: "<id>", summary: "stop a queued or running build", why: () => "only operators, and maintainers with write access to the repo, start builds" },
  { path: ["workspace"], tool: "list_workspaces", usage: "[--repo R] [--all] [--mine] [--limit N]", summary: "live workspaces opened through the agent tools (--all adds ended ones)", why: () => WS_WHY },
  { path: ["workspace", "open"], tool: "workspace_open", args: ["repo"], usage: "<repo> [--base SHA] [--hours N] [--env ID]", summary: "open a workspace on a default-branch commit (an agent sends a patch with it)", why: () => WS_WHY },
  { path: ["workspace", "status"], tool: "workspace_status", args: ["workspace"], usage: "<id>", summary: "a workspace's state, patch and last calls", why: () => WS_WHY },
  { path: ["workspace", "diff"], tool: "workspace_diff", args: ["workspace"], usage: "<id> [--format json]", summary: "its changes against the base, as a patch", why: () => WS_WHY },
  { path: ["workspace", "close"], tool: "workspace_close", args: ["workspace"], usage: "<id>", summary: "end it; what workspace diff did not save is lost", why: () => WS_WHY },
  { path: ["repos"], tool: "list_repos", usage: "", summary: "tracked repositories with their open decisions and fix-ups" },
  { path: ["fixups"], tool: "list_fixups", usage: "[--repo R] [--limit N]", summary: "PRs whose review fixes the pipeline could not apply" },
];

/**
 * Server tools without a command: the task tools tell an MCP agent to run this runner's own commands, and answering is
 * the operator's call on the dashboard until it opens to agents, start_build takes a patch and command lines, which an
 * agent or a script sends better than a command line, build_artifact returns images, which a terminal does not show, and the
 * workspace tools are an agent's working tools, whose results (images among them) an agent reads. `autocraft call <tool>` still reaches each one.
 */
export const MCP_ONLY = ["next_task", "task_status", "answer_decision", "undo_answer", "start_build", "build_artifact", "workspace_result",
  ...["shell", "shell_status", "shell_kill", "read", "write", "edit", "glob", "grep", "app_start", "app_stop", "screenshot", "fetch_dependencies"].map((t) => `workspace_${t}`)];

const SERVER_GROUPS = new Set(CLI_COMMANDS.map((c) => c.path[0]));

const MCP_PROTOCOL = "2025-06-18";
/** Tool names compare with dashes and underscores alike. @param {string} s */
const toolKey = (s) => s.replace(/-/g, "_");

/**
 * The text of an MCP reply body: a JSON message, or an event stream whose `data:` lines hold it.
 * @param {string} text @param {string} contentType @param {number} id
 * @returns {any}
 */
export function mcpMessage(text, contentType, id) {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  /** @type {any} */
  let found;
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data.trim()) continue;
    let m;
    try { m = JSON.parse(data); } catch { continue; }
    if (m && m.id === id && (m.result !== undefined || m.error !== undefined)) found = m;
  }
  if (!found) throw new Error("the server's event stream held no reply");
  return found;
}

/** One MCP session over HTTP. @param {string} server @param {string} credential */
export function mcpClient(server, credential) {
  let nextId = 1;
  /** @type {string | undefined} */
  let session;
  /** @param {string} method @param {unknown} [params] @param {boolean} [notify] @returns {Promise<any>} */
  async function send(method, params, notify = false) {
    const id = notify ? undefined : nextId++;
    const res = await fetch(`${server}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json",
        ...(session && { "Mcp-Session-Id": session, "MCP-Protocol-Version": MCP_PROTOCOL }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined && { id }), method, ...(params !== undefined && { params }) }),
      // A workspace tool call may wait up to 15 minutes on the server (wait_sec) while it keeps the reply open.
      signal: AbortSignal.timeout(16 * 60_000),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 410 && (/html/i.test(res.headers.get("content-type") ?? "") || /^\s*</.test(text))) {
        throw new ProxyBlocked("/mcp", res.status, retryAfterMs(res.headers.get("retry-after")));
      }
      let reason = "";
      try { reason = JSON.parse(text)?.error?.message ?? ""; } catch { reason = text.slice(0, 300); }
      if (res.status === 401) throw new Error(`the server refused the credential (revoked or expired): run \`autocraft login ${server}\``);
      // A server from before agent access answers a runner credential with its connector message.
      if (res.status === 403) throw new Error(reason && !/MCP Connector/.test(reason) ? redact(reason) : "this Task Runner has no agent access; tick Agent access for it on the Connect page");
      throw new HttpError("/mcp", res.status, reason || text, retryAfterMs(res.headers.get("retry-after")));
    }
    if (notify || !text.trim()) return undefined;
    const m = mcpMessage(text, res.headers.get("content-type") ?? "", /** @type {number} */ (id));
    if (m.error) throw new Error(`${method}: ${redact(String(m.error.message ?? JSON.stringify(m.error)))}`);
    return m.result;
  }
  /** @param {string} method @param {unknown} [params] */
  const read = (method, params) => withRetry(() => send(method, params), { tries: 3, deadline: Date.now() + 30_000 });
  return {
    /** @returns {Promise<{ instructions?: string }>} */
    async initialize() {
      const r = await read("initialize", { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "autocraft-runner", version: HELPER_VERSION } });
      await send("notifications/initialized", undefined, true).catch(() => {});
      return r ?? {};
    },
    /** @returns {Promise<any[]>} */
    async tools() { return (await read("tools/list"))?.tools ?? []; },
    /** @param {string} name @param {Record<string, unknown>} args @returns {Promise<{ content?: { type?: string, text?: string }[], isError?: boolean, structuredContent?: unknown }>} */
    call(name, args) { return send("tools/call", { name, arguments: args }); },
  };
}

/** A connected client with its initialize result, for the credential of this machine. */
async function agentSession() {
  const { server, agentToken } = needLogin(loadConfig());
  const client = mcpClient(server, agentToken);
  const init = await client.initialize();
  return { client, init, server };
}

/** @param {any} s the type of a schema property: its first non-null type */
const typeOf = (s) => (Array.isArray(s?.type) ? s.type.find((/** @type {string} */ t) => t !== "null") : s?.type) ?? (s?.enum ? "string" : undefined);
/** @param {string} s */
const firstLine = (s) => (String(s ?? "").split("\n").find((l) => l.trim()) ?? "").trim();

/** The tool named `name` (dashes or underscores). @param {any[]} tools @param {string} name */
function findTool(tools, name) {
  const t = tools.find((x) => toolKey(x.name) === toolKey(name));
  if (!t) throw new UsageError(`no tool ${name}: \`autocraft call\` lists them (a tool you cannot use is not listed)`);
  return t;
}

/** The command of a tool, as a command line without arguments. @param {string} name */
const commandOf = (name) => {
  const c = CLI_COMMANDS.find((x) => x.tool === name);
  return c ? `autocraft ${[...c.path, c.usage].filter(Boolean).join(" ")}` : null;
};

/** `call <tool> --help`: the description and the arguments of its schema. @param {any} tool */
function toolHelp(tool) {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const cmd = commandOf(tool.name);
  const lines = [`autocraft call ${tool.name} [args]${cmd ? `  (command: ${cmd})` : ""}`, "", String(tool.description ?? "").trim(), ""];
  const names = Object.keys(props);
  lines.push(names.length ? "Arguments:" : "No arguments.");
  for (const k of names) {
    const p = props[k], t = typeOf(p);
    const bits = [t === "array" ? `${typeOf(p.items) ?? "value"}, repeat or comma-separate` : t === "object" ? "JSON" : t ?? "value"];
    if (p.enum) bits.push(`one of ${p.enum.join(", ")}`);
    else if (p.items?.enum) bits.push(`each one of ${p.items.enum.join(", ")}`);
    if (p.minimum !== undefined) bits.push(`min ${p.minimum}`);
    if (p.maximum !== undefined) bits.push(`max ${p.maximum}`);
    if (p.default !== undefined) bits.push(`default ${JSON.stringify(p.default)}`);
    lines.push(`  --${k.replace(/_/g, "-")}${t === "boolean" ? "/--no-" + k.replace(/_/g, "-") : ""}  (${bits.join("; ")})${required.has(k) ? " required" : ""}${p.description ? ": " + String(p.description).replace(/\s+/g, " ").trim() : ""}`);
  }
  const pos = positionalOf(tool.inputSchema);
  if (pos) lines.push("", `${pos} may be given without its flag: autocraft call ${tool.name} <${pos}>`);
  lines.push("", "Add --json to print the raw result.");
  return lines.join("\n");
}

/** The one required string argument a tool takes positionally, if it has exactly one. @param {any} schema */
function positionalOf(schema) {
  const req = schema?.required ?? [];
  return req.length === 1 && typeOf(schema.properties?.[req[0]]) === "string" ? /** @type {string} */ (req[0]) : null;
}

/**
 * Tool arguments from a command line, typed by the tool's schema. `cmd` is the server command it runs for: its positional
 * words fill `cmd.args` in order and its flags name tool arguments; without it the one required string argument may be
 * positional (`call`).
 * @param {any} tool @param {string[]} argv @param {CliCommand} [cmd]
 * @returns {{ args: Record<string, unknown>, json: boolean }}
 */
export function parseToolArgs(tool, argv, cmd) {
  const props = tool.inputSchema?.properties ?? {};
  const flags = cmd?.flags ?? {};
  const shownAs = new Map(Object.entries(flags).map(([f, k]) => [k, f]));
  const byFlag = new Map(Object.keys(props).map((k) => [toolKey(k), k]));
  for (const [f, k] of Object.entries(flags)) byFlag.set(toolKey(f), k);
  const name = cmd ? cmd.path.join(" ") : tool.name;
  const flagOf = (/** @type {string} */ k) => `--${(shownAs.get(k) ?? k).replace(/_/g, "-")}`;
  const valid = () => Object.keys(props).filter((k) => !cmd?.args?.includes(k)).map(flagOf).join(", ") || "(none)";
  const usage = cmd ? `usage: autocraft ${[...cmd.path, cmd.usage].filter(Boolean).join(" ")}` : null;
  /** @type {Record<string, unknown>} */
  const args = {};
  let json = false;
  /** @type {string[]} */
  const positional = [];
  /** @param {string} key @param {string} raw */
  const typed = (key, raw) => {
    const p = props[key], t = typeOf(p);
    const bad = (/** @type {string} */ why) => new UsageError(`${cmd?.args?.includes(key) ? `<${key}>` : flagOf(key)}: ${why}`);
    /** @param {any} spec @param {string} v */
    const one = (spec, v) => {
      const st = typeOf(spec);
      /** @type {any} */
      let out = v;
      if (st === "integer" || st === "number") {
        if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v.trim())) throw bad(`${JSON.stringify(v)} is not a number`);
        out = Number(v);
        if (st === "integer" && !Number.isInteger(out)) throw bad(`${v} is not an integer`);
        if (spec.minimum !== undefined && out < spec.minimum) throw bad(`${v} is below the minimum ${spec.minimum}`);
        if (spec.maximum !== undefined && out > spec.maximum) throw bad(`${v} is above the maximum ${spec.maximum}`);
      } else if (st === "boolean") {
        if (!/^(true|false)$/.test(v)) throw bad(`${JSON.stringify(v)} is not true or false`);
        out = v === "true";
      } else if (st === "object" || st === "array") {
        try { out = JSON.parse(v); } catch { throw bad("not valid JSON"); }
      }
      if (spec?.enum && !spec.enum.includes(out)) throw bad(`${JSON.stringify(v)} is not one of ${spec.enum.join(", ")}`);
      return out;
    };
    if (t === "array") {
      const item = p.items ?? {};
      if (raw.trim().startsWith("[")) { try { const a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch { /* a plain value */ } }
      return (typeOf(item) === "object" ? [raw] : raw.split(",").map((s) => s.trim()).filter((s) => s !== "")).map((v) => one(item, v));
    }
    return one(p, raw);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (a === "--json") { json = true; continue; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    let flag = a.slice(2, eq < 0 ? undefined : eq);
    let inline = eq < 0 ? undefined : a.slice(eq + 1);
    let key = byFlag.get(toolKey(flag));
    if (!key && flag.startsWith("no-") && inline === undefined) {
      const k = byFlag.get(toolKey(flag.slice(3)));
      if (k && typeOf(props[k]) === "boolean") { args[k] = false; continue; }
    }
    if (!key) throw new UsageError(`unknown option ${a.slice(0, eq < 0 ? undefined : eq)} for ${name}; valid: ${valid()}`);
    const t = typeOf(props[key]);
    if (t === "boolean") {
      if (inline === undefined && /^(true|false)$/.test(argv[i + 1] ?? "")) inline = argv[++i];
      args[key] = inline === undefined ? true : typed(key, inline);
      continue;
    }
    if (inline === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`--${flag} needs a value`);
      inline = argv[++i];
    }
    const v = typed(key, inline);
    args[key] = t === "array" ? [...(Array.isArray(args[key]) ? /** @type {unknown[]} */ (args[key]) : []), ...v] : v;
  }
  if (cmd) {
    const names = cmd.args ?? [];
    if (positional.length > names.length) throw new UsageError(`${name} takes ${names.length ? names.map((k) => `<${k}>`).join(" ") : "no argument"}; quote a value with spaces (${usage})`);
    positional.forEach((v, i) => {
      const k = /** @type {string} */ (names[i]);
      if (args[k] !== undefined) throw new UsageError(`${name}: <${k}> is given twice`);
      args[k] = typed(k, v);
    });
  } else if (positional.length) {
    const pos = positionalOf(tool.inputSchema);
    if (!pos || args[pos] !== undefined) throw new UsageError(`${tool.name} takes no positional argument${pos ? ` besides --${pos.replace(/_/g, "-")}` : ""}; valid options: ${valid()}`);
    if (positional.length > 1) throw new UsageError(`${tool.name} takes one positional argument (${pos}); quote a value with spaces`);
    args[pos] = positional[0];
  }
  const missing = (tool.inputSchema?.required ?? []).filter((/** @type {string} */ k) => args[k] === undefined);
  if (missing.length) throw new UsageError(usage ?? `${tool.name} needs ${missing.map((/** @type {string} */ k) => `--${k.replace(/_/g, "-")}`).join(", ")}; see \`autocraft call ${tool.name} --help\``);
  return { args, json };
}

/** Prints a tool's result; the exit code. @param {Awaited<ReturnType<ReturnType<typeof mcpClient>["call"]>>} r @param {boolean} json */
function printResult(r, json) {
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    const text = contentText(r?.content) || (r?.structuredContent !== undefined ? JSON.stringify(r.structuredContent, null, 2) : "");
    (r?.isError ? console.error : console.log)(text);
  }
  return r?.isError ? 1 : 0;
}

/** `inbox`, `queue`, `calls`, `repos`, `fixups` and their subcommands. @param {string} group @param {string[]} argv */
async function cmdServer(group, argv) {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(groupHelp(group)); return 0; }
  const sub = CLI_COMMANDS.find((c) => c.path[0] === group && c.path[1] !== undefined && c.path[1] === argv[0]);
  const cmd = sub ?? /** @type {CliCommand} */ (CLI_COMMANDS.find((c) => c.path.length === 1 && c.path[0] === group));
  if (!sub && argv[0] !== undefined && !argv[0].startsWith("-") && CLI_COMMANDS.some((c) => c.path[0] === group && c.path.length > 1)) {
    throw new UsageError(`no command ${group} ${argv[0]}: \`autocraft ${group} --help\` lists them`);
  }
  if (!cmd) throw new UsageError(`autocraft ${group} needs a command: \`autocraft ${group} --help\` lists them`);
  const { client } = await agentSession();
  const tools = await client.tools();
  const tool = tools.find((t) => t.name === cmd.tool);
  if (!tool) {
    const has = new Set(tools.map((t) => String(t.name)));
    console.error(`autocraft ${cmd.path.join(" ")}: ${cmd.why ? cmd.why(has) : `the server does not offer ${cmd.tool} to this credential`}`);
    return 1;
  }
  const { args, json } = parseToolArgs(tool, sub ? argv.slice(1) : argv, cmd);
  return printResult(await client.call(tool.name, args), json);
}

/** `call`: lists the tools; `call --guide`: the server's instructions; `call <tool> [args]`: calls it. @param {string[]} argv */
async function cmdCall(argv) {
  const { client, init } = await agentSession();
  if (argv[0] === "--guide") { console.log(init.instructions ?? "the server gives no instructions"); return 0; }
  const tools = await client.tools();
  if (argv[0] === undefined) {
    const w = Math.max(0, ...tools.map((t) => t.name.length));
    for (const t of tools) console.log(`${t.name.padEnd(w)}  ${firstLine(t.description).slice(0, 110)}`);
    return 0;
  }
  if (argv[0].startsWith("-")) throw new UsageError("usage: autocraft call [<tool> [args] | --guide]");
  const tool = findTool(tools, argv[0]);
  if (argv.includes("--help")) { console.log(toolHelp(tool)); return 0; }
  const { args, json } = parseToolArgs(tool, argv.slice(1));
  return printResult(await client.call(tool.name, args), json);
}

/** `runner status | logs | pause | resume | reserve`. @param {string[]} argv */
async function cmdRunner(argv) {
  const [action, ...rest] = argv;
  switch (action) {
    case "status": return await cmdStatus();
    case "logs": return cmdLogs(rest);
    case "pause": await cmdPause(); return 0;
    case "resume": await cmdResume(); return 0;
    case "reserve": await cmdConfig(["reserve", ...rest]); return 0;
    case undefined: case "--help": case "-h": console.log(groupHelp("runner")); return 0;
    default: throw new UsageError(`no command runner ${action}: \`autocraft runner --help\` lists them`);
  }
}

/** `runner logs [-n N] [-f]`: the service's log, from the journal (Linux) or its log file (macOS). @param {string[]} argv */
function cmdLogs(argv) {
  let lines = 50, follow = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--follow") follow = true;
    else if ((a === "-n" || a === "--lines") && /^\d{1,6}$/.test(argv[i + 1] ?? "")) lines = Number(argv[++i]);
    else throw new UsageError("usage: autocraft runner logs [-n N] [-f]");
  }
  const tailArgs = ["-n", String(lines), ...(follow ? ["-f"] : [])];
  /** @type {[string, string[]]} */
  let run;
  if (process.platform === "linux") run = ["journalctl", ["--user", "-u", SERVICE_NAME, "--no-pager", ...tailArgs]];
  else if (process.platform === "darwin") {
    const log = join(cacheDir(), "service.log");
    if (!existsSync(log)) throw new Error(`no service log at ${log}: the runner logs there once \`autocraft service install\` runs it`);
    run = ["tail", [...tailArgs, log]];
  } else throw new Error("runner logs reads the service's log on Linux and macOS");
  const r = spawnSync(run[0], run[1], { stdio: "inherit" });
  if (r.error) throw new Error(`${run[0]}: ${msg(r.error)}`);
  return r.status ?? 1;
}

/** @typedef {[string, string]} HelpLine  command, what it does */

/** @type {HelpLine[]} */
const SETUP_HELP = [
  ["autocraft login <url> [--label X] [--answer] [--no-agent] [--no-wait]", "make a credential and wait for its approval on the dashboard"],
  ["autocraft login --wait", "wait for a login started with --no-wait (at most 9 minutes)"],
  ["autocraft login <url> --stdin", "store a Task Runner credential read from stdin"],
  ["autocraft harness claude [--keychain]", "store a `claude setup-token` token from stdin; --keychain: Claude Code's login (macOS)"],
  ["autocraft harness claude --config-dir [<dir>]", "use a Claude config directory's login (default ~/.claude; Linux)"],
  ["autocraft harness codex [--device-auth]", "log Codex in to the runner's own CODEX_HOME (not your ~/.codex)"],
  ["autocraft setup [<url>] [--yes]", "find what this machine lacks and install it, asking first; then doctor"],
  ["autocraft doctor", "check platform, sandbox, harness, login and server"],
  ["autocraft update", "replace this file with the server's current runner"],
  ["autocraft service install [--parallel N] | uninstall | status", "run `work` as a systemd user unit (Linux) or launchd agent (macOS)"],
];

/** @type {HelpLine[]} */
const RUNNER_HELP = [
  ["autocraft runner status", "whether the runner claims now, with plan usage, reserve and pause"],
  ["autocraft runner logs [-n N] [-f]", "the service's log (journalctl on Linux, service.log on macOS)"],
  ["autocraft runner pause | resume", "claim nothing until the plan window resets; resume ends a pause or a hold"],
  ["autocraft runner reserve <5h> <weekly> | off", "keep more of each plan window free than the server's reserve (percent); the server's reserve is set with `settings set --reserve`"],
];

/** @type {HelpLine[]} */
const CALL_HELP = [
  ["autocraft call [<tool> [args] | --guide]", "raw access to any server tool: alone it lists them; `call <tool> --help` shows its arguments; --guide prints the server's instructions"],
];

/** @type {HelpLine[]} */
const TASK_HELP = [
  ["autocraft work [--parallel N] [--no-auto-update]", "claim, run and submit in a loop (what the service runs); updates itself when the server has a newer runner"],
  ["autocraft claim", "claim one call; prints its lease id"],
  ["autocraft run [--detach] [<lease>]", "run a claimed lease, or claim and run one"],
  ["autocraft wait <lease>", "wait for a detached run (returns after at most 9 minutes)"],
  ["autocraft try <bundle.json> [--slot N]", "run a bundle from a file without a server and print the reply (testing)"],
  ["autocraft mcp <server-name> <lease>", "stdio-to-HTTP proxy for one of the lease's MCP servers"],
  ["autocraft tool <server-name> <tool> [<json>] [<lease>]", "one tool call of a lease's server without MCP; prints the result"],
  ["autocraft migrate", "move an autocraft-task install over"],
  ["autocraft status | pause-until-reset | resume", "runner status, pause and resume"],
  ["autocraft config reserve <5h> <weekly> | off", "runner reserve"],
];

const GROUP_TITLES = /** @type {const} */ ({ inbox: "Inbox", queue: "Merge queue", calls: "Model calls", settings: "Settings", build: "Builds", workspace: "Workspaces" });

/** @param {string} group @returns {HelpLine[]} */
const serverHelp = (group) => CLI_COMMANDS.filter((c) => c.path[0] === group).map((c) => [`autocraft ${[...c.path, c.usage].filter(Boolean).join(" ")}`, c.summary]);

/** The help sections in order. @param {boolean} all @returns {[string, HelpLine[]][]} */
const helpSections = (all) => [
  ["Setup", SETUP_HELP], ["Runner", RUNNER_HELP],
  ...Object.entries(GROUP_TITLES).map(([g, title]) => /** @type {[string, HelpLine[]]} */ ([title, serverHelp(g)])),
  ["Other", [...serverHelp("repos"), ...serverHelp("fixups"), ...CALL_HELP]],
  ...(all ? [/** @type {[string, HelpLine[]]} */ (["Task commands (used by the service and by agents)", TASK_HELP])] : []),
];

const HELP_COLUMN = 46, HELP_WIDTH = 120;
/** `s` in lines of at most `width` characters, broken at spaces. @param {string} s @param {number} width */
const wrap = (s, width) => s.split(" ").reduce((/** @type {string[]} */ out, w) => {
  const last = out[out.length - 1];
  if (last !== undefined && last.length + 1 + w.length <= width) out[out.length - 1] = `${last} ${w}`;
  else out.push(w);
  return out;
}, []);
/** @param {string} title @param {HelpLine[]} lines */
const section = (title, lines) => [title, ...lines.map(([c, s]) => {
  const pad = `\n  ${" ".repeat(HELP_COLUMN)}`;
  const text = wrap(s, HELP_WIDTH - HELP_COLUMN - 2).join(pad);
  return c.length < HELP_COLUMN ? `  ${c.padEnd(HELP_COLUMN)}${text}` : `  ${c}${pad}${text}`;
})].join("\n");

const SERVER_NOTE = `Inbox, merge queue, model call and other server commands need Agent access for this Task Runner (the dashboard's Connect page).
Options of a command's tool that are not shown pass through as --<argument>; \`autocraft call <tool> --help\` lists them.
Add --json for the raw result. Exit 0 done, 1 refused or failed, 2 wrong command line.`;

/** `help [--all]`: the groups and two lines; `--all` adds the task commands and the details. @param {boolean} all */
function helpText(all) {
  const intro = `autocraft ${HELPER_VERSION}: the AutoCraft Task Runner runs AutoCraft model calls under your own harness subscription,
and gives you AutoCraft's inbox, merge queue and model calls on the command line.`;
  const sections = helpSections(all).map(([t, l]) => section(t, l));
  if (!all) return [intro, ...sections, "Server commands need Agent access for this Task Runner (Connect page).\n--json prints the raw result; `autocraft help --all` lists everything."].join("\n\n");
  return [intro, ...sections,
    `login --answer also asks to answer decisions and approve merges; --no-agent asks for no agent access.
${SERVER_NOTE}`,
    `The runner claims only while every plan window keeps more than the reserve free (set per user on the
dashboard, default 20%), and holds whenever it cannot read the usage.

Config: ${"$XDG_CONFIG_HOME"}/autocraft-runner/config.json, the credential in credentials.json beside it (mode 0600);
"tiers" maps top/mid/small to models (Claude defaults to opus, sonnet and haiku; Codex has no defaults).`,
  ].join("\n\n");
}

/** `<group> --help` and `help <group>`. @param {string} group */
function groupHelp(group) {
  if (group === "runner") return section("Runner", RUNNER_HELP);
  if (group in GROUP_TITLES) return `${section(GROUP_TITLES[/** @type {keyof typeof GROUP_TITLES} */ (group)], serverHelp(group))}\n\n${SERVER_NOTE}`;
  if (group === "repos" || group === "fixups" || group === "call") return `${section("Other", [...serverHelp("repos"), ...serverHelp("fixups"), ...CALL_HELP])}\n\n${SERVER_NOTE}`;
  return helpText(false);
}

/** The command that replaces this runner; version refusals print it. */
const UPDATE_COMMAND = `node ${realpathSync(fileURLToPath(import.meta.url))} update`;

/** Downloads the server's current runner. A server from before the rename serves it only at its earlier path. @param {string} server */
async function downloadHelper(server) {
  let res = await fetch(`${server}${ROUTES.helper}`, { signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) res = await fetch(`${server}${ROUTES.legacyHelper}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status}`);
  const text = await res.text();
  const version = /export const HELPER_VERSION = "([^"]+)"/.exec(text)?.[1];
  if (!version) throw new Error("the download is not an AutoCraft Task Runner");
  return { text, version };
}

/** Writes `text` beside this file and checks that it parses; returns the staged path (the caller renames or removes it). @param {string} text */
function stageHelper(text) {
  const target = realpathSync(self);
  const tmp = join(dirname(target), `.autocraft-update-${process.pid}.mjs`);
  try {
    writeFileSync(tmp, text, { mode: 0o700 });
    const c = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    if (c.status !== 0) throw new Error(`the download does not parse: ${(c.stderr || "").split("\n").find((l) => l.trim()) ?? "node --check failed"}`);
    chmodSync(tmp, statSync(target).mode & 0o777);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
  return tmp;
}

/** Replaces this file with the staged one in one rename and runs `migrate` from it; returns migrate's exit code. @param {string} tmp */
function installStaged(tmp) {
  const target = realpathSync(self);
  try { renameSync(tmp, target); } finally { rmSync(tmp, { force: true }); }
  return spawnSync(process.execPath, [target, "migrate"], { stdio: "inherit" }).status ?? 1;
}

/** Whether the file lives in a git checkout (a `.git` in any parent directory): such an install updates by git. @param {string} file */
export function inGitCheckout(file) {
  let d = dirname(realpathSync(file));
  for (;;) {
    if (existsSync(join(d, ".git"))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

/**
 * What `work` does about the server's runner version `served`: "update" replaces the file and restarts, "available" only
 * reports it (opt-out or git checkout), "current" does nothing (the same or an older version is never installed).
 * @param {{ current: string, served: string, inGit: boolean, enabled: boolean }} o
 * @returns {"update" | "available" | "current"}
 */
export function selfUpdateDecision(o) {
  if (compareVersions(o.served, o.current) <= 0) return "current";
  return o.enabled && !o.inGit ? "update" : "available";
}

/** `work` asks the server again this long after finding no newer runner, and at most this long after a failed download. */
const SELF_UPDATE_RECHECK_MS = scaled(3600_000);
const SELF_UPDATE_RETRY_MS = scaled(5 * 60_000);

/**
 * Downloads the current runner from the server of the login, checks that it parses, replaces this file in one rename, and
 * runs `migrate` from the new file.
 */
async function cmdUpdate() {
  const cfg = loadConfig();
  if (!cfg.server) throw new Error("not logged in: run `autocraft login <server-url>` first");
  const { text, version } = await downloadHelper(cfg.server);
  const status = installStaged(stageHelper(text));
  if (version !== HELPER_VERSION) updateHelperStatus(({ updateAvailable: _u, ...s }) => ({ ...s, update: { at: Date.now(), from: HELPER_VERSION, to: version } }));
  console.log(version === HELPER_VERSION ? `autocraft ${version} is already the current version (file replaced)` : `autocraft updated from ${HELPER_VERSION} to ${version}`);
  return status;
}

/** @param {string[]} argv */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "login": return await cmdLogin(rest);
      case "harness": await cmdHarness(rest); return 0;
      case "claim": await cmdClaim(); return 0;
      case "run": return await cmdRun(rest);
      case "wait": return await cmdWait(rest);
      case "work": return await cmdWork(rest);
      case "service": return await cmdService(rest);
      case "doctor": return await cmdDoctor();
      case "setup": return await cmdSetup(rest);
      case "try": return await cmdTry(rest);
      case "mcp": return await cmdMcp(rest);
      case "tool": return await cmdTool(rest);
      case "runner": return await cmdRunner(rest);
      case "update": return await cmdUpdate();
      case "migrate": return cmdMigrate();
      case "version": case "--version": console.log(HELPER_VERSION); return 0;
      case "call": return await cmdCall(rest);
      // Kept for scripts and agents: `runner status`, `runner pause`, `runner resume` and `runner reserve`.
      case "status": return await cmdStatus();
      case "pause-until-reset": await cmdPause(); return 0;
      case "resume": await cmdResume(); return 0;
      case "config": await cmdConfig(rest); return 0;
      case undefined: case "help": case "--help": case "-h":
        console.log(rest[0] && !rest[0].startsWith("-") ? groupHelp(rest[0]) : helpText(rest.includes("--all")));
        return 0;
      default:
        if (SERVER_GROUPS.has(cmd)) return await cmdServer(cmd, rest);
        throw new UsageError(`no command ${cmd}: \`autocraft help\` lists them`);
    }
  } catch (e) {
    console.error(`autocraft: ${msg(e)}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

const self = fileURLToPath(import.meta.url);
let direct = false;
try { direct = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self); } catch { /* imported */ }
if (direct) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
