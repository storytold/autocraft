// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("checks",
  { table: "ci_run_approvals" },
  { table: "ci_vs_main" },
);

registerTriggerSource("queue",
  { table: "merges" },
  { table: "merge_batches" },
  { table: "merge_batch_prs" },
);

// The build feature switches (settings rows `build_feature:*`); not planner input.
registerTriggerSource("build-features",
  { table: "screenshot_config" },
);

// Our workspace builds of PR heads (pr-builds feature); read by the item page and queue cards, not planner input.
registerTriggerSource("pr-builds",
  { table: "pr_builds" },
);

registerTriggerSource("verify",
  { table: "verifications" },
);
