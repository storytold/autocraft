// A fix session's report is the only thing read from the model's reply: it is read strictly, so a reply that bends the
// format is refused (and asked for again) rather than guessed at.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFixReport, parseSecurityReport } from "../src/fixsession/report.ts";

const ok = { status: "done", summary: "Checked the stride.", changes: ["Use checked_mul"], tests_run: [{ command: "cargo test -p codecs", exit: 0 }] };
const read = (v: unknown) => parseFixReport(typeof v === "string" ? v : JSON.stringify(v));

test("a fix session's report is read only when it keeps the format", () => {
  const good = read(ok);
  assert.ok("report" in good && good.report.status === "done" && good.report.changes.length === 1);
  const fenced = read(`I made the fix.\n\n\`\`\`json\n${JSON.stringify({ status: "none", summary: "Already fixed." })}\n\`\`\``);
  assert.ok("report" in fenced && fenced.report.status === "none");

  for (const bad of [
    { ...ok, status: "partial" },
    { ...ok, summary: " " },
    { status: "blocked", summary: "No tools." },
    { ...ok, deviations: ["none"] },
    { ...ok, tests_run: [{ command: "cargo test" }] },
  ]) assert.ok("error" in read(bad), JSON.stringify(bad));
  assert.ok("error" in read(`${JSON.stringify(ok)}\n${JSON.stringify({ ...ok, status: "none" })}`), "two reports");

  // A security fix needs its pull request title when done, and has no status none.
  assert.ok("error" in parseSecurityReport(JSON.stringify(ok)));
  assert.ok("error" in parseSecurityReport(JSON.stringify({ ...ok, status: "none", title: "Check layer lengths" })));
  const sec = parseSecurityReport(JSON.stringify({ ...ok, title: "Check layer lengths" }));
  assert.ok("report" in sec && sec.report.title === "Check layer lengths");
  assert.ok("error" in read({ ...ok, title: "Check layer lengths" }), "title is a security key only");
});
