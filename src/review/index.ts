// Stage 5, Review: CI refresh and the operator's `review again`. The review itself is
// the Opus pass in opus.ts. Reads GitHub (checks, and failure logs while main is red); never writes to it.
//
//   autocraft-server checks --repo R
//   autocraft-server review again REPO#N
import { Client, type Querier } from "../mirror.ts";
import { refreshChecks } from "./checks.ts";
import { rereadUnknown } from "../merge/mergeable.ts";
import { markReviewsStale, withRetry } from "./discussion.ts";
import type { Db } from "../db/index.ts";
import { listItems } from "../data/mirror/index.ts";
import { openDb } from "../db/open.ts";
import { compareRepo } from "../mainci/no-new.ts";
import { ghExec, type Gh } from "../merge/safe-merge.ts";

export type ChecksParams = { repo: string };

/** For the runner: refreshes CI and merge state of every open PR of the repo. */
export async function runChecks(db: Db, params: ChecksParams, log: (line: string) => void = console.log, querier: Querier = new Client(1000), gh: Gh = ghExec): Promise<{ prs: number }> {
  const rows = await withRetry(() => refreshChecks(db, querier, params.repo, undefined, log));
  await rereadUnknown(db, querier, params.repo, log);
  // While main is red, PRs whose CI fails only on checks main fails are compared with main's failures (no model call).
  await compareRepo(db, gh, params.repo, rows, log);
  return { prs: rows.length };
}

function parseArgs(args: string[], allowed: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const n = args[i]!.replace(/^--/, "");
    if (!allowed.includes(n)) throw new Error(`unknown option ${args[i]}; options: ${allowed.map((a) => "--" + a).join(" ")}`);
    const v = args[++i];
    if (v === undefined) throw new Error(`--${n} needs a value`);
    out[n] = v;
  }
  return out;
}

export const commands = {
  review: {
    summary: "review again REPO#N [--by LOGIN]: review a PR again (Opus)",
    async run(args: string[]): Promise<void> {
      const m = /^([\w.-]+)#(\d+)$/.exec(args[1] ?? "");
      const by = args[2] === "--by" && args[3] ? args[3] : "cli";
      if (args[0] !== "again" || !m || args.length !== (args[2] ? 4 : 2)) throw new Error("usage: autocraft-server review again <repo>#<number> [--by <login>]");
      const db = await openDb();
      const open = await listItems(db, { repos: [m[1]!], numbers: [Number(m[2])], kind: "pr", states: ["OPEN"] }, "ref");
      if (!open.length) throw new Error(`${args[1]} is not an open pull request in the mirror`);
      await markReviewsStale(db, by, m[1]!, Number(m[2]));
      console.log(`${args[1]}: its review is stale; Opus reviews it again`);
    },
  },
  checks: {
    summary: "checks --repo R: refresh CI status and mergeability of the repo's open PRs",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args, ["repo"]);
      if (typeof f.repo !== "string") throw new Error("missing --repo");
      await runChecks(await openDb(), { repo: f.repo });
    },
  },
};
