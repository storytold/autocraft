import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Whether work may run is decided in src/core (an action's `permission`, and src/core/repo-approvals.ts for work of a repo as a whole), from facts the data layer loads. A file elsewhere that reads a
// repo's step approvals, or a workflow's approver, starter, blocker or head, can decide the same question by itself: the lists name every
// file that reads them today. A file leaves its list when it reads permission instead; none joins.

const ROOT = new URL("..", import.meta.url).pathname;
/** Where the rules and the loads are. */
const HOME = ["src/core/", "src/data/", "src/db/", "src/db.ts"];

const READS = {
  approvals: /\b(?:loadStepApprovals|repoStepApproval|loadRepoGuards|repoApprovals|loadActBlocked|mainFixApprovals|approvalOf|(?:mainFix|fixIssue|comment|status|ci)ApprovalOf)\(|\b(?:commentApproved|ciApproved|labelsApproved)\b/,
  workflow: /(?<!\.\.)\.(?:approvedBy|startedBy|blocker|baseHead|acceptedHead)\b|\{[^{}\n]*\b(?:approvedBy|startedBy|blocker|baseHead|acceptedHead)\b[^{}:\n]*\}\s*=/,
} as const;
type Kind = keyof typeof READS;

/** The files that decide with what they read: the workflow's own, which store it and run a person's command on it. */
const DECIDES: Record<Kind, readonly string[]> = {
  approvals: [],
  workflow: [
    "src/workflow/advance.ts",
    "src/workflow/apply.ts",
    "src/workflow/resolve.ts",
    "src/workflow/retired-stops.ts",
    "src/workflow/store.ts",
  ],
};
/** The files that only read for showing, on a page, in a command's output, a comment or a model's context. */
const SHOWS: Record<Kind, readonly string[]> = {
  approvals: [
    "src/act/approval.ts",
    "src/act/index.ts",
    "src/dash/api/admin.ts",
    "src/fixup/index.ts",
    "src/implement/approval.ts",
    "src/implement/cli.ts",
    "src/labels/approval.ts",
    "src/labels/index.ts",
    "src/mainfix/approval.ts",
    "src/mainfix/index.ts",
    "src/mainfix/status.ts",
    "src/merge/ci-approval.ts",
  ],
  workflow: [
    "src/conversations/store.ts",
    "src/dash/api/maintain-item.ts",
    "src/dash/api/maintain.ts",
    "src/dash/mcp/index.ts",
    "src/discord/alerts.ts",
    "src/eval/detect.ts",
    "src/workflow/asked.ts",
    "src/workflow/cli.ts",
    "src/workflow/read.ts",
    "src/workflow/recommend.ts",
    "src/workflow/status.ts",
  ],
};

/** The files that read each kind, without their comments. */
function readers(): Record<Kind, string[]> {
  const out: Record<Kind, string[]> = { approvals: [], workflow: [] };
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const file = relative(ROOT, p);
      if (!p.endsWith(".ts") || HOME.some((h) => file.startsWith(h))) continue;
      const text = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|(?<=^|\s)\/\/.*$/gm, "");
      for (const kind of Object.keys(READS) as Kind[]) if (READS[kind].test(text)) out[kind].push(file);
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

test("outside src/core and src/data only the listed files read step approvals and workflow approval fields, and no list is out of date", () => {
  const found = readers();
  for (const kind of Object.keys(READS) as Kind[]) {
    assert.deepEqual([...DECIDES[kind], ...SHOWS[kind]].sort(), found[kind].sort(), `${kind}: a file that reads them is not listed, or a listed one reads them no more`);
  }
});
