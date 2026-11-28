#!/usr/bin/env node
// Each module exports commands: { name: { summary, run(args) } }.
import { openDb } from "./db/open.ts";
type Command = { summary: string; run: (args: string[]) => Promise<void> | void };
type Module = { commands: Record<string, Command> };

const MODULES = ["./mirror.ts", "./whitelist.ts", "./access.ts", "./repos.ts", "./classify/index.ts", "./labels/index.ts", "./review/index.ts", "./merge/index.ts", "./merge/single.ts", "./dash/index.ts", "./runner/index.ts", "./worker/index.ts", "./embed/index.ts", "./agents/index.ts", "./build/cli.ts", "./act/index.ts", "./fixup/index.ts", "./postmerge/index.ts", "./premerge/index.ts", "./verify/index.ts", "./priority/index.ts", "./dupes/index.ts", "./rank/index.ts", "./review/opus.ts", "./merge/batch.ts", "./merge/safe-merge.ts", "./review/post.ts", "./operator-actions.ts", "./dupes/compare.ts", "./sandbox/workspace.ts", "./workflow/batch.ts", "./conversations/index.ts", "./itemtools/index.ts", "./areas/index.ts", "./merge/ci-approval.ts", "./reference.ts", "./cifix/index.ts", "./prepush/cli.ts", "./mainci/index.ts", "./mainfix/index.ts", "./optional-checks.ts", "./github/app-cli.ts", "./security/cli.ts", "./discord/index.ts", "./liveness.ts", "./remote/cli.ts", "./db/cli.ts", "./periodic.ts", "./cratemirror/server.ts", "./warm/cli.ts", "./implement/cli.ts", "./fixsession/cli.ts", "./workflow/cli.ts", "./eval/index.ts"];

async function main(): Promise<void> {
  const commands: Record<string, Command> = {};
  for (const path of MODULES) {
    try {
      Object.assign(commands, ((await import(path)) as Module).commands);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e;
    }
  }
  const [name, ...args] = process.argv.slice(2);
  const cmd = name ? commands[name] : undefined;
  if (!cmd) {
    console.log("usage: autocraft-server <command> [args]\n");
    for (const [n, c] of Object.entries(commands)) console.log(`  ${n.padEnd(14)} ${c.summary}`);
    process.exit(name ? 1 : 0);
  }
  // Commands that run a pipeline step go through the job path (gates, limits, a jobs row); see src/runner/cli-job.ts.
  const { loadSteps } = await import("./runner/steps.ts");
  const { cliRequest, runCliJob } = await import("./runner/cli-job.ts");
  const req = cliRequest(name!, args, await loadSteps());
  if (req) {
    const { scopeToTracked } = await import("./repos.ts");
    const db = await openDb();
    await scopeToTracked(db);
    process.exit(await runCliJob(db, req));
  }
  await cmd.run(args);
}

await main();
