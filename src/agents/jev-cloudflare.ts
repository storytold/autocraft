// Jev through Cloudflare Workers AI, for deployments without the `jev` command (containers).
// Used for every Jev call when AUTOCRAFT_JEV_CLOUDFLARE_ACCOUNT and AUTOCRAFT_JEV_CLOUDFLARE_TOKEN_FILE are set.
// The result has the shape of a finished `jev ask` process, so callers parse it as they parse the CLI's output:
// stdout is `{"answers": ..., "usage": ...}`, and a failure prints `jev: API error status=<N> ...` on stderr (see jevFailure).
import { readFileSync, statSync } from "node:fs";
import { envVar } from "../env.ts";

export const JEV_CLOUDFLARE_MODEL = "typesafe/jev-1.14.0";

export type JevCloudflareConfig = { account: string; tokenFile: string; model: string };
export type JevProc = { code: number | null; stdout: string; stderr: string };

export function jevCloudflareConfig(env: NodeJS.ProcessEnv = process.env): JevCloudflareConfig | null {
  const account = envVar("JEV_CLOUDFLARE_ACCOUNT", env)?.trim();
  const tokenFile = envVar("JEV_CLOUDFLARE_TOKEN_FILE", env)?.trim();
  if (!account || !tokenFile) return null;
  return { account, tokenFile, model: envVar("JEV_CLOUDFLARE_MODEL", env)?.trim() || JEV_CLOUDFLARE_MODEL };
}

/** The token from its file; refuses a file that group or others can access. Throws a message without the token. */
function readToken(path: string): string {
  let mode: number;
  try { mode = statSync(path).mode; } catch { throw new Error("api key file not found"); }
  if (mode & 0o077) throw new Error("api key file is readable or writable by group or others; chmod 600 it");
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error("api key file is empty");
  return token;
}

const fail = (code: number, status: number | null, message: string): JevProc => ({ code, stdout: "", stderr: `jev: ${status === null ? "" : `API error status=${status}: `}${message}\n` });

/** Sends a request in the `jev ask` format (`{state, questions, model?}` as JSON text) to Workers AI. */
export async function askJevCloudflare(cfg: JevCloudflareConfig, body: string, timeoutMs: number, base = "https://api.cloudflare.com"): Promise<JevProc> {
  let token: string;
  try { token = readToken(cfg.tokenFile); } catch (e) { return fail(1, null, (e as Error).message); }
  let input: { state?: unknown; questions?: unknown };
  try {
    const { state, questions } = JSON.parse(body) as { state?: unknown; questions?: unknown };
    input = { state, questions };
  } catch { return fail(1, null, "unreadable request"); }
  let res: Response;
  try {
    res = await fetch(`${base}/client/v4/accounts/${encodeURIComponent(cfg.account)}/ai/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Timeouts and network errors: a failed call, not an outage (code -1 is never an outage unless the command is missing).
    return fail(-1, null, `request failed: ${(e as Error).name}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = "";
    try { detail = ((JSON.parse(text) as { errors?: { message?: string }[] }).errors ?? []).map((x) => x.message).filter(Boolean).join("; "); } catch { /* no detail */ }
    return fail(1, res.status, detail.slice(0, 200) || res.statusText);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { code: 0, stdout: text, stderr: "" }; }
  const env = parsed as { result?: unknown; success?: boolean; errors?: { message?: string }[] } | null;
  if (env && typeof env === "object" && "success" in env && env.success === false) return fail(1, res.ok ? null : res.status, (env.errors ?? []).map((x) => x.message).filter(Boolean).join("; ").slice(0, 200) || "request failed");
  const outer = env && typeof env === "object" && "result" in env && env.result && typeof env.result === "object" ? env.result as Record<string, unknown> : parsed as Record<string, unknown>;
  // Workers AI may wrap the model's own reply in a second envelope, `{ state, result: { answers, usage } }`.
  const inner = "state" in outer && outer.result && typeof outer.result === "object" ? outer.result as Record<string, unknown> : outer;
  if ("state" in outer && outer.state !== "Completed") return fail(1, null, `run ${String(outer.state).slice(0, 40)}`);
  // The answers come under `answers`, as in the CLI's output.
  return { code: 0, stdout: JSON.stringify(inner), stderr: "" };
}
