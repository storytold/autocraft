// Claude accounts: which ones an operator enabled, how busy and how full they
// are, and the choice of an account for the next model call.
//
// Only accounts present in the box config (box.ts) are listed. Their config
// directories stay in this process: nothing here returns one.
import type { AccountAuth, AccountInput, ClaudeAccount } from "../../web/src/api/types.ts";
import { audit } from "../dash/audit.ts";
import { JEV_PARALLEL_DEFAULT } from "../prompts/index.ts";
import { loginInfo } from "./login.ts";
import { credentialsNearExpiry, tokenView } from "./token.ts";
import { boxAccounts, iso, readUsage, type BoxAccount, type Reading } from "./box.ts";
import { setting } from "../settings-read.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";

export const USAGE_PAUSE_KEY = "usage_pause";
export type UsagePause = { fiveHour: number; weekly: number };
export const USAGE_PAUSE_DEFAULT: UsagePause = { fiveHour: 80, weekly: 80 };
/** A reading older than this counts as unknown, and unknown is allowed. */
export const STALE_MS = 30 * 60_000;
/** A run still "running" after this long belongs to a process that is gone; it no longer takes a slot. */
export const RUN_SLOT_MS = 60 * 60_000;
export const MAX_CONCURRENT_LIMIT = 100;
export const LABEL_MAX = 40;

export class AccountError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function validLabel(v: unknown): string {
  if (typeof v !== "string") throw new AccountError(400, "label must be text");
  const l = v.trim();
  if (!l || l.length > LABEL_MAX || /[\u0000-\u001f<>@]/.test(l)) throw new AccountError(400, `label must be 1 to ${LABEL_MAX} characters without @, < or > (never an email address)`);
  return l;
}

type Row = { id: string; label: string; enabled: number; max_concurrent: number };

/** Adds a row (disabled, labelled with its id) for each account of the box config that has none. */
export async function syncAccounts(db: Db, box?: BoxAccount[]): Promise<void> {
  box ??= await boxAccounts(db);
  for (const a of box) await db.run(db.k.insertInto("claude_accounts").values({ id: a.id, label: a.id }).onConflict((oc) => oc.doNothing()));
}

const fresh = (r: Reading | null, nowMs: number): Reading | null => (r && nowMs - r.writtenAt * 1000 <= STALE_MS ? r : null);

const validPct = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100;

/** The usage levels at which an account stops taking calls; absent or unreadable gives the defaults. */
export async function usagePause(db: Db): Promise<UsagePause> {
  const value = await setting(db, USAGE_PAUSE_KEY);
  if (value === undefined) return USAGE_PAUSE_DEFAULT;
  try {
    const v = JSON.parse(value) as Partial<UsagePause> | null;
    return v && validPct(v.fiveHour) && validPct(v.weekly) ? { fiveHour: v.fiveHour, weekly: v.weekly } : USAGE_PAUSE_DEFAULT;
  } catch {
    return USAGE_PAUSE_DEFAULT;
  }
}

export async function usagePauseInfo(db: Db, accountId: string): Promise<{ limits: UsagePause; custom: boolean }> {
  const value = await setting(db, `${USAGE_PAUSE_KEY}:${accountId}`);
  if (value !== undefined) {
    try {
      const v = JSON.parse(value) as Partial<UsagePause> | null;
      if (v && validPct(v.fiveHour) && validPct(v.weekly)) {
        return { limits: { fiveHour: v.fiveHour, weekly: v.weekly }, custom: true };
      }
    } catch { /* fall back to global */ }
  }
  return { limits: await usagePause(db), custom: false };
}

export async function usagePauseFor(db: Db, accountId: string): Promise<UsagePause> {
  return (await usagePauseInfo(db, accountId)).limits;
}

export async function setUsagePause(db: Db, input: unknown, by: string): Promise<UsagePause> {
  const v = input as Partial<UsagePause> | null;
  if (!v || typeof v !== "object" || !validPct(v.fiveHour) || !validPct(v.weekly)) throw new AccountError(400, "pause levels must be whole numbers from 1 to 100");
  const was = await usagePause(db);
  const next = { fiveHour: v.fiveHour, weekly: v.weekly };
  await db.run(db.k.insertInto("settings").values({ key: USAGE_PAUSE_KEY, value: JSON.stringify(next) }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  if (next.fiveHour !== was.fiveHour || next.weekly !== was.weekly) await audit(db, by, "account-change", "usage-pause", { ...next, was });
  return next;
}

/** Why a fresh reading blocks new calls at the given levels, or null. */
export function headroomReason(r: Reading | null, limits: UsagePause, nowMs: number = Date.now()): string | null {
  const f = fresh(r, nowMs);
  if (!f) return null;
  if (f.fiveHour && f.fiveHour.pct >= limits.fiveHour) return `5-hour use ${Math.round(f.fiveHour.pct)} % (pauses at ${limits.fiveHour} %)`;
  if (f.weekly && f.weekly.pct >= limits.weekly) return `weekly use ${Math.round(f.weekly.pct)} % (pauses at ${limits.weekly} %)`;
  return null;
}

async function runningCounts(db: Db, nowMs: number): Promise<Map<string, number>> {
  const since = new Date(nowMs - RUN_SLOT_MS).toISOString();
  const rows = await db.all(db.k.selectFrom("agent_runs").select((eb) => ["account_id as id", eb.fn.countAll<number>().as("n")])
    .where("state", "=", "running").where("account_id", "is not", null).where("started_at", ">=", since).groupBy("account_id")
    .$narrowType<{ id: string }>());
  return new Map(rows.map((r) => [r.id, r.n]));
}

async function rows(db: Db, box: BoxAccount[]): Promise<Row[]> {
  if (!box.length) return [];
  const all = await db.all(db.k.selectFrom("claude_accounts").select(["id", "label", "enabled", "max_concurrent"]));
  const byId = new Map(all.map((r) => [r.id, r]));
  return box.flatMap((b) => (byId.has(b.id) ? [byId.get(b.id)!] : []));
}

async function authOf(db: Db, id: string): Promise<AccountAuth> {
  const s = await db.get(db.k.selectFrom("claude_account_status").select(["logged_in", "method", "plan", "login_expires_at", "checked_at"]).where("account_id", "=", id));
  return s
    ? { loggedIn: s.logged_in === 1, method: s.method, plan: s.plan, expiresAt: s.login_expires_at, checkedAt: s.checked_at }
    : { loggedIn: null, method: null, plan: null, expiresAt: null, checkedAt: null };
}

function toAccount(r: Row, token: ClaudeAccount["token"], running: number, reading: Reading | null, nowMs: number, auth: AccountAuth, pauseInfo: { limits: UsagePause; custom: boolean }): ClaudeAccount {
  const limits = pauseInfo.limits;
  return {
    auth, login: loginInfo(r.id), token,
    id: r.id, label: r.label, enabled: r.enabled === 1, maxConcurrent: r.max_concurrent, running,
    pause: limits,
    pauseCustom: pauseInfo.custom,
    usage: {
      fiveHourPct: reading?.fiveHour?.pct ?? null,
      fiveHourResetsAt: reading?.fiveHour?.resetsAt != null ? iso(reading.fiveHour.resetsAt) : null,
      weeklyPct: reading?.weekly?.pct ?? null,
      weeklyResetsAt: reading?.weekly?.resetsAt != null ? iso(reading.weekly.resetsAt) : null,
      readAt: reading ? iso(reading.writtenAt) : null,
    },
    pausedReason: r.enabled === 1 ? headroomReason(reading, limits, nowMs) : null,
  };
}

/** Every account of the box config, enabled or not, in config order. With `sync` false nothing is written: accounts without a stored row are left out. */
export async function listAccounts(db: Db, nowMs: number = Date.now(), sync = true): Promise<ClaudeAccount[]> {
  const box = await boxAccounts(db);
  if (sync) await syncAccounts(db, box);
  const counts = await runningCounts(db, nowMs);
  return await mapSeq((await rows(db, box)), async (r) => toAccount(r, await tokenView(db, r.id, box.find((b) => b.id === r.id)!.configDir), counts.get(r.id) ?? 0, readUsage(r.id), nowMs, await authOf(db, r.id), await usagePauseInfo(db, r.id)));
}

export async function updateAccount(db: Db, id: unknown, input: unknown, by: string): Promise<ClaudeAccount> {
  const box = await boxAccounts(db);
  if (typeof id !== "string" || !box.some((b) => b.id === id)) throw new AccountError(404, "no such account");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AccountError(400, "the body must be a JSON object");
  const o = input as Record<string, unknown>;
  const bad = Object.keys(o).find((k) => !["label", "enabled", "maxConcurrent", "pause"].includes(k));
  if (bad) throw new AccountError(400, `${bad} cannot be set`);
  if (o.label !== undefined) {
    o.label = validLabel(o.label);
  }
  if (o.enabled !== undefined && typeof o.enabled !== "boolean") throw new AccountError(400, "enabled must be true or false");
  if (o.maxConcurrent !== undefined && (typeof o.maxConcurrent !== "number" || !Number.isInteger(o.maxConcurrent) || o.maxConcurrent < 1 || o.maxConcurrent > MAX_CONCURRENT_LIMIT)) {
    throw new AccountError(400, `maxConcurrent must be a whole number from 1 to ${MAX_CONCURRENT_LIMIT}`);
  }
  let nextPause: UsagePause | null | undefined = undefined;
  if (o.pause !== undefined) {
    if (o.pause === null) {
      nextPause = null;
    } else {
      const p = o.pause as Partial<UsagePause>;
      if (typeof o.pause !== "object" || Array.isArray(o.pause) || !validPct(p.fiveHour) || !validPct(p.weekly)) {
        throw new AccountError(400, "pause levels must be whole numbers from 1 to 100");
      }
      nextPause = { fiveHour: p.fiveHour, weekly: p.weekly };
    }
  }
  await syncAccounts(db, box);
  const before = (await rows(db, box)).find((r) => r.id === id)!;
  const beforePause = await usagePauseInfo(db, id);
  const next = {
    label: (o.label as string | undefined) ?? before.label,
    enabled: (o.enabled as boolean | undefined) ?? before.enabled === 1,
    maxConcurrent: (o.maxConcurrent as number | undefined) ?? before.max_concurrent,
  };
  await db.run(db.k.updateTable("claude_accounts")
    .set({ label: next.label, enabled: next.enabled ? 1 : 0, max_concurrent: next.maxConcurrent, updated_by: by, updated_at: new Date().toISOString() })
    .where("id", "=", id));
  const pauseKey = `${USAGE_PAUSE_KEY}:${id}`;
  if (nextPause === null) {
    await db.run(db.k.deleteFrom("settings").where("key", "=", pauseKey));
  } else if (nextPause !== undefined) {
    await db.run(db.k.insertInto("settings").values({ key: pauseKey, value: JSON.stringify(nextPause) }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  }
  const afterPause = await usagePauseInfo(db, id);
  const pauseChanged = beforePause.custom !== afterPause.custom || beforePause.limits.fiveHour !== afterPause.limits.fiveHour || beforePause.limits.weekly !== afterPause.limits.weekly;
  await audit(db, by, "account-change", `account:${id}`, {
    ...(next.label !== before.label && { label: next.label, was: before.label }),
    ...(next.enabled !== (before.enabled === 1) && { enabled: next.enabled }),
    ...(next.maxConcurrent !== before.max_concurrent && { maxConcurrent: next.maxConcurrent }),
    ...(pauseChanged && { pause: afterPause.custom ? afterPause.limits : null, wasPause: beforePause.custom ? beforePause.limits : null }),
  });
  return (await listAccounts(db)).find((a) => a.id === id)!;
}

export type Choice =
  | { account: { id: string; configDir: string } }
  | { wait: string }          // enabled accounts exist, none can take a call now
  | { none: true };           // no account is enabled

/**
 * The enabled account with a free slot and headroom that has the lowest weekly use.
 * With `minTokenMs`, an account whose login token expires within that many ms is not eligible
 * (a sandboxed call cannot refresh the token); it is named in the wait reason instead.
 * With `ignoreSlots`, full accounts count as available: whether a call could run once a slot frees, used for a waiter's eligibility in the call queue.
 */
export async function chooseAccount(db: Db, nowMs: number = Date.now(), minTokenMs?: number, ignoreSlots = false): Promise<Choice> {
  const box = await boxAccounts(db);
  await syncAccounts(db, box);
  const enabled = (await rows(db, box)).filter((r) => r.enabled === 1);
  if (!enabled.length) return { none: true };
  const counts = await runningCounts(db, nowMs);
  const reasons: string[] = [];
  const ok: { r: Row; weekly: number; running: number }[] = [];
  for (const r of enabled) {
    const reading = readUsage(r.id), running = counts.get(r.id) ?? 0;
    const why = headroomReason(reading, await usagePauseFor(db, r.id), nowMs);
    if (why) reasons.push(`${r.label}: ${why}`);
    else if (!ignoreSlots && running >= r.max_concurrent) reasons.push(`${r.label}: ${running} of ${r.max_concurrent} slots in use`);
    else if (minTokenMs !== undefined && await credentialsNearExpiry(db, r.id, box.find((b) => b.id === r.id)!.configDir, nowMs, minTokenMs)) reasons.push(`${r.label}: login token expires within ${Math.ceil(minTokenMs / 60_000)} min; waiting for its refresh`);
    else ok.push({ r, weekly: fresh(reading, nowMs)?.weekly?.pct ?? 0, running });
  }
  if (!ok.length) return { wait: reasons.join("; ") };
  ok.sort((a, b) => a.weekly - b.weekly || a.running - b.running || a.r.id.localeCompare(b.r.id));
  const pick = ok[0]!.r;
  return { account: { id: pick.id, configDir: box.find((b) => b.id === pick.id)!.configDir } };
}

/** Whether the given account is still enabled, has headroom and a free slot (a follow-up on its session may start). */
export async function accountHasRoom(db: Db, accountId: string, nowMs: number = Date.now()): Promise<boolean> {
  const box = await boxAccounts(db);
  await syncAccounts(db, box);
  const r = (await rows(db, box)).find((x) => x.id === accountId);
  if (!r || r.enabled !== 1 || headroomReason(readUsage(r.id), await usagePauseFor(db, r.id), nowMs)) return false;
  return ((await runningCounts(db, nowMs)).get(r.id) ?? 0) < r.max_concurrent;
}

/** Calls the enabled accounts with headroom can take right now: the sum of their free slots. */
export async function freeSlots(db: Db, nowMs: number = Date.now()): Promise<number> {
  const box = await boxAccounts(db);
  await syncAccounts(db, box);
  const counts = await runningCounts(db, nowMs);
  let free = 0;
  for (const r of await rows(db, box)) {
    if (r.enabled !== 1 || headroomReason(readUsage(r.id), await usagePauseFor(db, r.id), nowMs)) continue;
    free += Math.max(0, r.max_concurrent - (counts.get(r.id) ?? 0));
  }
  return free;
}

export const JEV_PARALLEL_KEY = "jev_parallel";
export { JEV_PARALLEL_DEFAULT };
export const JEV_PARALLEL_MAX = 100;

/** Jev calls at once (Jev has no accounts, so no slots limit it). */
export async function jevParallel(db: Db): Promise<number> {
  const v = Number(await setting(db, JEV_PARALLEL_KEY));
  return Number.isInteger(v) && v >= 1 && v <= JEV_PARALLEL_MAX ? v : JEV_PARALLEL_DEFAULT;
}

export async function setJevParallel(db: Db, n: unknown, by: string): Promise<number> {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > JEV_PARALLEL_MAX) throw new AccountError(400, `Jev calls at once must be a whole number from 1 to ${JEV_PARALLEL_MAX}`);
  const was = await jevParallel(db);
  await db.run(db.k.insertInto("settings").values({ key: JEV_PARALLEL_KEY, value: String(n) }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  if (n !== was) await audit(db, by, "account-change", "jev", { jevParallel: n, was });
  return n;
}

/**
 * Why Claude-model stages are paused, or null: no account is enabled, or every
 * enabled account is out of headroom. A busy account is not a pause; calls wait for a slot.
 */
export async function claudePauseReason(db: Db, nowMs: number = Date.now()): Promise<string | null> {
  const box = await boxAccounts(db);
  await syncAccounts(db, box);
  const enabled = (await rows(db, box)).filter((r) => r.enabled === 1);
  if (!enabled.length) return "paused: no Claude account is enabled";
  const reasons: string[] = [];
  for (const r of enabled) {
    const why = headroomReason(readUsage(r.id), await usagePauseFor(db, r.id), nowMs);
    if (!why) return null;
    reasons.push(`${r.label}: ${why}`);
  }
  return `paused: no Claude account has headroom (${reasons.join("; ")})`;
}

// ---- usage samples ---------------------------------------------------------------

export const SAMPLE_KEEP_MS = 30 * 86_400_000;

/** Records each account's current reading once (keyed by the reading's time). Returns how many were new. */
export async function recordUsageSamples(db: Db, nowMs: number = Date.now()): Promise<number> {
  let n = 0;
  for (const a of await boxAccounts(db)) {
    const r = readUsage(a.id);
    if (!r) continue;
    n += Number((await db.run(db.k.insertInto("account_usage_samples")
      .values({ account_id: a.id, t: iso(r.writtenAt), five_hour_pct: r.fiveHour?.pct ?? null, weekly_pct: r.weekly?.pct ?? null })
      .onConflict((oc) => oc.doNothing()))).changes);
  }
  await db.run(db.k.deleteFrom("account_usage_samples").where("t", "<", new Date(nowMs - SAMPLE_KEEP_MS).toISOString()));
  return n;
}
