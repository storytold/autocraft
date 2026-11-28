// The fix-session command: `fix-session try` runs one step of a PR's fix session and stores and pushes nothing.
import { openDb } from "../db/open.ts";

/** The steps `fix-session try` runs. */
export const TRY_STEPS = ["fixup", "cifix", "conflict", "maintainer"] as const;
export type TryStep = (typeof TRY_STEPS)[number];

const USAGE = `usage: autocraft-server fix-session try <repo>#<n> --step ${TRY_STEPS.join("|")} [--instructions <text>]`;

export const commands = {
  "fix-session": {
    summary: `fix-session try <repo>#<n> --step ${TRY_STEPS.join("|")} [--instructions <text>]: runs one step of the PR's fix session (workspace at the PR head, the session's turns, AutoCraft's checks in the pod, the diff and the step's gates) and prints the report, the gate result and the diff stat; records no step row and pushes nothing`,
    async run(args: string[]): Promise<void> {
      const m = /^([^#\s]+)#(\d+)$/.exec(args[1] ?? "");
      if (args[0] !== "try" || !m) throw new Error(USAGE);
      let step: TryStep | null = null, instructions: string | null = null;
      for (let i = 2; i < args.length; i++) {
        const a = args[i];
        if (a === "--step" && (TRY_STEPS as readonly string[]).includes(args[i + 1] ?? "")) step = args[++i] as TryStep;
        else if (a === "--instructions" && args[i + 1] !== undefined) instructions = args[++i]!;
        else throw new Error(USAGE);
      }
      if (!step) throw new Error(USAGE);
      process.exitCode = await (await import("./try.ts")).runSessionTry(await openDb(), m[1]!, Number(m[2]), step, instructions);
    },
  },
};
