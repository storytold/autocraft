// The live topic this module's table feeds (src/db/live.ts). A save notifies every process's prompt cache (active.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("prompts",
  { table: "prompt_revisions" },
);
