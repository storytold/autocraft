// The fix_sessions setting: which fix steps work in fix sessions, and with `review` whether the Opus reviews of a PR run in
// workspaces of their own (src/fixsession/review.ts), optionally only in some repos. Off (no steps) by default.
import type { Db } from "../db/index.ts";
import { loadTrackedRepos, saveSettings, setting, SETTINGS, type FixSessionsSetting } from "../data/control/index.ts";
import { FIX_SESSION_SWITCHES, type FixSessionSwitch } from "../data/fixsession/index.ts";

export const FIX_SESSIONS_KEY = "fix_sessions";

export async function fixSessionsSetting(db: Db): Promise<FixSessionsSetting> {
  return SETTINGS.fixSessions.read(await setting(db, FIX_SESSIONS_KEY));
}

/** Whether `step` works in a fix session on `repo` (`review`: whether the Opus reviews of its PRs run in workspaces of their own). */
export async function fixSessionsOn(db: Db, step: FixSessionSwitch, repo: string): Promise<boolean> {
  const s = await fixSessionsSetting(db);
  return s.steps.includes(step) && (s.repos === null || s.repos.includes(repo));
}

/** Sets the steps (empty: off) and the repos (null: every repo; each must be tracked); audited as `fix-sessions`. */
export async function setFixSessions(db: Db, next: { steps: string[]; repos: string[] | null }, by: string): Promise<FixSessionsSetting> {
  const unknown = next.steps.filter((s) => !(FIX_SESSION_SWITCHES as readonly string[]).includes(s));
  if (unknown.length) throw new Error(`unknown step ${unknown.join(", ")}: the steps are ${FIX_SESSION_SWITCHES.join(", ")}`);
  if (next.repos !== null) {
    const tracked = await loadTrackedRepos(db, next.repos);
    const missing = next.repos.filter((r) => !tracked.has(r));
    if (missing.length) throw new Error(`not a tracked repo: ${missing.join(", ")}`);
  }
  const value: FixSessionsSetting = { steps: FIX_SESSION_SWITCHES.filter((s) => next.steps.includes(s)), repos: next.repos === null ? null : [...new Set(next.repos)].sort() };
  const was = await fixSessionsSetting(db);
  if (JSON.stringify(value) !== JSON.stringify(was)) await saveSettings(db, [{ key: FIX_SESSIONS_KEY, value: JSON.stringify(value) }], by, { action: "fix-sessions", target: "pipeline", details: { ...value, was } });
  return value;
}

/** One line for the CLI. */
export const fixSessionsText = (s: FixSessionsSetting): string =>
  `fix_sessions ${s.steps.length ? s.steps.join(",") : "none"}${s.steps.length ? ` on ${s.repos === null ? "every repo" : s.repos.length ? s.repos.join(",") : "no repo"}` : ""}`;
