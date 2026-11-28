// The switch to the maintainer workflow on a database an older release wrote: what it keeps, what it starts, and that running
// it again changes nothing. Runs on either engine (connectDb).
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { STATE_COPY_DONE } from "../src/db/state-copy.ts";
import { SWITCH_KEY, switchOver } from "../src/db/switch-over.ts";
import { loadActivityRound } from "../src/data/views/activity.ts";
import { loadImplementFacts } from "../src/data/implement/index.ts";
import { attemptNow } from "../src/implement/attempt.ts";
import { opensAsDraft } from "../src/implement/stuck.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { openQuestionOf, viewOf } from "../src/workflow/question.ts";
import { countEventsSince, loadEvents, loadLastEventKinds } from "../src/data/workflow/index.ts";

const COPIED = "2026-11-20T00:00:00.000Z", BEFORE = "2026-11-19T00:00:00.000Z", AFTER = "2026-11-20T01:00:00.000Z", NOW = "2026-11-20T02:00:00.000Z";

async function insert(db: Db, table: string, row: Record<string, string | number | null>): Promise<void> {
  const cols = Object.keys(row);
  await db.prepare(`INSERT INTO main.${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
}
const setting = (db: Db, key: string, value: string) =>
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
const item = (db: Db, number: number, kind: string, state = "OPEN") => insert(db, "items", { repo: "demo", number, kind, state, title: `t${number}`, head_oid: kind === "pr" ? `h${number}` : null, updated_at: BEFORE });
const decision = (db: Db, id: string, x: Record<string, string | number | null>) => insert(db, "decisions", {
  id, kind: "merge", repo: "demo", number: null, question: `Question ${id}?`, options: JSON.stringify([{ key: "take", label: "Take it" }, { key: "backlog", label: "Backlog" }]), asked_at: BEFORE, ...x,
});

async function legacy(): Promise<Db> {
  const db = await connectDb(":memory:");
  await db.prepare("DELETE FROM main.tracked_repos").run();
  await insert(db, "tracked_repos", { name: "demo", workflow: "legacy" });
  await insert(db, "tracked_repos", { name: "pilot", workflow: "new" });
  await setting(db, STATE_COPY_DONE, COPIED);
  await setting(db, "runner_heartbeat", AFTER);
  await setting(db, "github_identity", "app");
  for (const [login, role, permission] of [["alice", "maintainer", "write"], ["frank", "maintainer", "read"], ["gone", "viewer", "write"]] as const) {
    await insert(db, "access", { login, role, added_by: "op", added_at: BEFORE });
    await insert(db, "repo_permissions", { login, repo: "demo", permission, checked_at: BEFORE });
  }
  for (const [n, kind, state] of [[1, "issue"], [2, "pr"], [3, "issue", "CLOSED"], [4, "pr"], [5, "pr"], [6, "issue"], [7, "pr"], [8, "issue"], [9, "pr"], [10, "pr"], [11, "pr", "MERGED"], [12, "pr"]] as [number, string, string?][]) await item(db, n, kind, state);

  await decision(db, "answered", { number: 2, answer: "take", answered_by: "alice", answered_at: AFTER });
  await decision(db, "open", { number: 2 });
  await decision(db, "open~2", { number: 2, question: "Question open?" });
  await decision(db, "withdrawn", { number: 2, answer: "withdrawn", answered_by: "pipeline", answered_at: AFTER });
  await decision(db, "superseded", { number: 2, answer: "superseded", answered_by: "dupes", answered_at: AFTER });
  await decision(db, "closed", { number: 2, answer: "take", answered_by: "pipeline", answered_at: AFTER });
  await decision(db, "batch", { items: JSON.stringify([{ repo: "demo", number: 2 }, { repo: "demo", number: 7 }]), exceptions: JSON.stringify([{ repo: "demo", number: 7, answer: "other" }]), answer: "take", answered_by: "bob", answered_at: AFTER });
  await decision(db, "no-item", { kind: "other", answer: "take", answered_by: "alice", answered_at: AFTER });
  await decision(db, "parked", { kind: "scope", number: 6, answer: "backlog", answered_by: "carol", answered_at: AFTER });
  await decision(db, "parked-fast", { kind: "scope", number: 8, answer: "backlog", answered_by: "carol", answered_at: AFTER });
  await insert(db, "actions", { decision_id: "answered", repo: "demo", number: 2, kind: "comment-close", state: "done", comment_url: "https://example.test/c", created_at: AFTER });

  const fast = (number: number, weight: number) => insert(db, "fast_track", { repo: "demo", number, added_by: "dave", added_at: BEFORE, weight });
  for (const [n, w] of [[2, 5], [1, 8], [3, 5], [4, 5], [8, 5], [9, 5], [10, 7]] as const) await fast(n, w);
  await insert(db, "implementations", { repo: "demo", number: 1, queued_by: "dave", state: "pr", attempt: 1, text_hash: "x", pr_number: 9, created_at: BEFORE, updated_at: BEFORE });

  const workflow = async (id: number, number: number, state: string) =>
    await insert(db, "item_workflows", { id, repo: "demo", number, kind: "pr", entry: "fixup", state, started_by: "erin", started_at: BEFORE, started_via: "github", approved_by: "erin", approved_at: BEFORE, updated_at: BEFORE });
  await workflow(1001, 4, "running");
  await workflow(1002, 5, "running");
  const leg = (number: number, state: string, workflow_id: number | null, updated_at: string, head: string | null = null) =>
    insert(db, "preapprovals", { repo: "demo", number, by: "erin", at: BEFORE, instructions: "", state, from_head: "h", head, reason: "CI failed", updated_at, workflow_id });
  await leg(5, "asked", 1002, AFTER);
  // Pre-approved merges in progress: a fast-tracked PR's, the PR's of issue 1, a merged PR's, and one a person stopped since.
  await leg(10, "queued", null, AFTER, "h10");
  await leg(9, "fixup", null, AFTER);
  await leg(11, "queued", null, AFTER, "h11");
  await leg(12, "review", null, AFTER, "h12");
  await workflow(1003, 12, "stopped");
  await db.prepare("UPDATE main.item_workflows SET stopped_at = ? WHERE id = 1003").run(AFTER);
  // Answered after it stopped: the workflow goes on.
  await leg(4, "asked", 1001, BEFORE);
  await insert(db, "workflow_events", { workflow_id: 1001, repo: "demo", number: 4, login: "erin", via: "github", kind: "answered", at: AFTER });
  await insert(db, "workflow_events", { workflow_id: 1002, repo: "demo", number: 2, login: "erin", via: "github", kind: "ambiguous", at: AFTER });
  await insert(db, "opus_reviews", { repo: "demo", number: 5, head_oid: "h5", at: BEFORE, mode: "full", verdict: "take-fix", sure: 1, workflow: JSON.stringify({ outside_purpose: null, recommendation: { text: "Fix 1, then merge it.", fix: [1], merge: true } }) });
  await insert(db, "user_settings", { login: "alice", key: "task_items", value: "fast", updated_at: BEFORE });

  // Approvals: granted on an older dashboard after the copy, revoked there, granted on a new one, revoked on a new one.
  await setting(db, "merge_approved:demo", JSON.stringify({ by: "op", at: AFTER }));
  await insert(db, "repo_step_approvals", { repo: "demo", step: "push", by: "op", at: BEFORE });
  await insert(db, "repo_step_approvals", { repo: "demo", step: "labels", by: "op", at: AFTER });
  await setting(db, "comment_approved:demo", JSON.stringify({ by: "op", at: BEFORE }));
  // The older runner went on after the copy.
  await setting(db, "pipeline_fp:review|demo", JSON.stringify({ fp: "later", job: 7 }));
  await insert(db, "lane_state", { kind: "fp", step: "review", repo: "demo", value: "earlier", job_id: 1, at: COPIED });
  await insert(db, "lane_state", { kind: "fp", step: "gone", repo: "demo", value: "x", job_id: 1, at: COPIED });
  await setting(db, "review_stale:demo#2", BEFORE);
  await insert(db, "review_state", { repo: "demo", number: 2, stale_at: AFTER });
  await insert(db, "classify_state", { kind: "jev_failed", repo: "demo", number: 1, value: "old", at: COPIED });
  await db.prepare("UPDATE main.items SET jev_failed_hash = 'new' WHERE repo = 'demo' AND number = 7").run();
  await setting(db, "limit_reset_at:merge", AFTER);
  const run = (id: number) => insert(db, "agent_runs", { id, step: "review", stage: 1, prompt_id: "p", prompt_version: "1", provider: "claude", model: "m", state: "done", started_at: AFTER });
  await run(900);
  await insert(db, "agent_run_items", { run_id: 900, repo: "demo", number: 7 });
  await insert(db, "dupe_groups", { decision_id: "demo:dupegroup:1", repo: "demo", source: "model" });
  await insert(db, "discord_alert_msgs", { decision_id: `wf:1002:${BEFORE}`, user_hash: "u", sent_at: AFTER });
  return db;
}

const TABLES = ["workflow_events", "item_workflows", "preapprovals", "tracked_repos", "user_settings", "repo_step_approvals", "lane_state", "review_state", "classify_state", "stage_limits", "agent_runs", "dupe_groups", "discord_alert_msgs"];
const snapshot = async (db: Db) => {
  const out: Record<string, string[]> = {};
  for (const t of TABLES) out[t] = (await db.prepare(`SELECT * FROM main.${t}`).all()).map((r) => JSON.stringify(r)).sort();
  out.audit = (await db.prepare("SELECT login, target FROM main.audit WHERE action = 'decision-archived'").all()).map((r) => JSON.stringify(r));
  return out;
};
const rows = (db: Db, text: string) => db.prepare(text).all();

test("the switch keeps the answers as history, starts fast-tracked items and carries over what older processes wrote", async () => {
  const db = await legacy();
  const r = (await switchOver(db, { now: NOW, perDay: {} }))!;

  const ref = (number: number) => ({ repo: "demo", number });
  const events = await loadEvents(db, [ref(2), ref(7)], { archived: true });
  const archived = (n: number) => events.get(`demo#${n}`)!.filter((e) => e.kind === "archived").map((e) => [e.login, e.at, e.line]);
  assert.deepEqual(archived(2).sort(), [
    ["alice", AFTER, "Comment and close: done https://example.test/c"],
    ["alice", AFTER, "Question answered? Answer: Take it."],
    ["bob", AFTER, "Question batch? Answer: Take it."],
    ["pipeline", NOW, "Question open? Withdrawn at the switch to the maintainer workflow."],
  ]);
  assert.deepEqual(archived(7), [["bob", AFTER, "Question batch? Answer: other."]]);
  assert.equal((await rows(db, "SELECT target FROM main.audit WHERE action = 'decision-archived'"))[0]!.target, "decision:no-item");
  assert.equal((await loadLastEventKinds(db, [ref(2)])).get("demo#2"), "started", "an archived row is never an item's latest event");
  const live = [...(await loadEvents(db, [ref(2), ref(7)])).values()].flat();
  assert.deepEqual([...new Set(live.map((e) => e.kind))].sort(), ["ambiguous", "started"]);
  assert.equal(await countEventsSince(db, { login: "alice", via: "cli", since: BEFORE }), 0, "an archived answer is no command of the person's");
  const feed = await loadActivityRound(db, { staff: true, operator: true, hidden: [], own: new Set(), repos: ["demo"] }, { kinds: new Set(["decision"]), only: false, repo: null, limit: 100, before: null, writeActions: null });
  assert.deepEqual([...new Set(feed.bySource.flatMap((s) => s.rows.map((x) => x.kind)))].sort(), ["answered", "started"], "the feed shows no archived line");

  const wf = await rows(db, "SELECT number, kind, entry, weight, state, started_by, base_head FROM main.item_workflows WHERE id < 1000 OR id > 1003 ORDER BY number");
  assert.deepEqual(wf.map((w) => ({ ...w })), [
    { number: 1, kind: "issue", entry: "implement", weight: 8, state: "running", started_by: "dave", base_head: "h" },
    { number: 2, kind: "pr", entry: "review", weight: 5, state: "running", started_by: "dave", base_head: "h2" },
    { number: 6, kind: "issue", entry: "implement", weight: 5, state: "backlog", started_by: "carol", base_head: null },
    { number: 8, kind: "issue", entry: "implement", weight: 5, state: "backlog", started_by: "carol", base_head: null },
    { number: 10, kind: "pr", entry: "merge", weight: 7, state: "running", started_by: "erin", base_head: "h10" },
  ]);
  assert.deepEqual(r.fastTrackSkipped.map((s) => s.item).sort(), ["demo#10", "demo#4", "demo#8", "demo#9"], "a live workflow, a later Backlog, and the PR of an issue that starts");
  // A pre-approved merge keeps its approval: in a workflow of its own, or in that of the issue its PR implements.
  const bound = await rows(db, `SELECT p.number, w.number AS item, w.approved_by, w.approved_at FROM main.preapprovals p JOIN main.item_workflows w ON w.id = p.workflow_id
    WHERE p.state IN ('fixup', 'review', 'ci', 'queued') ORDER BY p.number`);
  assert.deepEqual(bound.map((b) => ({ ...b })), [
    { number: 9, item: 1, approved_by: "erin", approved_at: BEFORE },
    { number: 10, item: 10, approved_by: "erin", approved_at: BEFORE },
  ]);
  assert.deepEqual(r.legs.map((l) => l.item).sort(), ["demo#10", "demo#9"]);
  assert.deepEqual(r.legsSkipped.map((l) => l.item), ["demo#11", "demo#12"]);
  assert.deepEqual(await rows(db, "SELECT DISTINCT workflow FROM main.tracked_repos").then((x) => x.map((y) => y.workflow)), ["new"]);
  assert.equal((await rows(db, "SELECT value FROM main.user_settings WHERE key = 'task_items'"))[0]!.value, "fast", "the older release reads it");

  assert.deepEqual((await rows(db, "SELECT state FROM main.item_workflows WHERE id IN (1001, 1002)")).map((w) => w.state), ["running", "running"]);
  assert.equal((await rows(db, "SELECT count(*) AS n FROM main.preapprovals WHERE state = 'asked'"))[0]!.n, 0);

  assert.deepEqual((await rows(db, "SELECT step FROM main.repo_step_approvals WHERE repo = 'demo' ORDER BY step")).map((x) => x.step), ["labels", "merge"]);
  assert.deepEqual((await rows(db, "SELECT key FROM main.settings WHERE key LIKE '%approved:demo' ORDER BY key")).map((x) => x.key), ["labels_approved:demo", "merge_approved:demo"]);
  assert.deepEqual((await rows(db, "SELECT step, value FROM main.lane_state WHERE kind = 'fp'")).map((x) => [x.step, x.value]), [["review", "later"]]);
  assert.equal((await rows(db, "SELECT stale_at FROM main.review_state WHERE number = 2"))[0]!.stale_at, AFTER);
  assert.deepEqual((await rows(db, "SELECT number, value FROM main.classify_state WHERE kind = 'jev_failed'")).map((x) => [x.number, x.value]), [[7, "new"]]);
  assert.equal((await rows(db, "SELECT reset_at FROM main.stage_limits WHERE step = 'merge'"))[0]!.reset_at, AFTER);
  assert.equal((await rows(db, "SELECT first_number FROM main.agent_runs WHERE id = 900"))[0]!.first_number, 7);
  assert.equal((await rows(db, "SELECT id FROM main.dupe_groups"))[0]!.id, "demo:dupegroup:1");
  assert.equal((await rows(db, "SELECT workflow_id FROM main.discord_alert_msgs"))[0]!.workflow_id, 1002);
  assert.equal((await rows(db, "SELECT count(*) AS n FROM main.decisions"))[0]!.n, 10, "the old tables keep their rows for a rollback");
  await db.close();
});

test("a second run, and a run after one that was cut short, change nothing; an older release that ran again is switched again", async () => {
  const db = await legacy();
  await switchOver(db, { now: NOW });
  const after = await snapshot(db);
  assert.equal(await switchOver(db, { now: "2026-11-21T00:00:00.000Z" }), null);
  // Cut short before its last transaction, the switch runs whole again.
  await db.prepare("DELETE FROM main.settings WHERE key = ?").run(SWITCH_KEY);
  await switchOver(db, { now: "2026-11-21T00:00:00.000Z" });
  assert.deepEqual(await snapshot(db), after);

  await setting(db, "runner_heartbeat", "2026-11-22T00:00:00.000Z");
  await db.prepare("UPDATE main.decisions SET answer = 'take', answered_by = 'alice', answered_at = '2026-11-22T00:00:00.000Z' WHERE id = 'open'").run();
  const again = (await switchOver(db, { now: "2026-11-23T00:00:00.000Z" }))!;
  assert.deepEqual([again.archived.answered, again.archived.withdrawn, again.archived.actions, again.fastTrack.length], [1, 0, 0, 0]);
  await db.close();
});

test("a started pull request whose pre-approved merge had stopped comes back with a recommendation a yes can run, and no new merge starts", async () => {
  const db = await legacy();
  // Stopped at a hold while it conflicts: its findings cannot be fixed before the base is merged.
  await db.prepare("UPDATE main.preapprovals SET reason = 'the review says hold' WHERE workflow_id = 1002").run();
  await db.prepare("UPDATE main.opus_reviews SET verdict = 'hold', model = 'm', fixes = ? WHERE number = 5").run(JSON.stringify([{ file: "a.ts", anchor: "x", change: "Check the length." }]));
  await insert(db, "pr_checks", { repo: "demo", number: 5, head_oid: "h5", state: "OPEN", overall: "success", checks: "[]", mergeable: "CONFLICTING", fetched_at: AFTER });
  await switchOver(db, { now: NOW });
  await advanceWorkflows(db);
  const w = (await rows(db, "SELECT state, approved_by, rec, rec_head FROM main.item_workflows WHERE id = 1002"))[0]!;
  const rec = JSON.parse(w.rec as string) as { parts: { fix: number[] }; merges: boolean; again?: string; waits?: string };
  // The merge stays approved and waits for a person to resolve the conflict; the held head is not reviewed again.
  assert.deepEqual([w.state, w.approved_by, w.rec_head, rec.parts.fix, rec.merges, rec.again, rec.waits], ["blocked", "erin", "h5", [], true, undefined, "person"]);
  assert.deepEqual((await rows(db, "SELECT state FROM main.preapprovals WHERE number = 5")).map((l) => l.state), ["cancelled"]);
  await db.close();
});

test("a stopped merge whose reason was cut comes back with a sentence that shows the cut", async () => {
  const db = await legacy();
  const quote = "Scope is settled. ".padEnd(152, "word ") + "referen";
  await db.prepare("UPDATE main.preapprovals SET reason = ? WHERE workflow_id = 1002").run(`the review says take-fix: ${quote.padEnd(160, "c")}`);
  await switchOver(db, { now: NOW });
  await advanceWorkflows(db);
  const w = (await rows(db, "SELECT blocker, rec FROM main.item_workflows WHERE id = 1002"))[0]!;
  assert.equal(w.blocker, "other");
  assert.match((JSON.parse(w.rec as string) as { text: string }).text, / word…$/);
  await db.close();
});

test("a pull request of an earlier attempt goes with no later workflow of its issue, one the workflow's own attempt opened does", async () => {
  const db = await legacy();
  const START = "2026-11-20T00:30:00.000Z";
  const implement = async (number: number, attempts: [pr: number, state: string, created: string][]) => {
    await item(db, number, "issue");
    await insert(db, "item_workflows", { id: 2000 + number, repo: "demo", number, kind: "issue", entry: "implement", state: "running", started_by: "dave", started_at: START, started_via: "github", updated_at: START });
    for (const [pr, state, created_at] of attempts) {
      await item(db, pr, "pr");
      await insert(db, "implementations", { id: pr, repo: "demo", number, queued_by: "dave", state, attempt: pr, text_hash: `x${pr}`, pr_number: pr, created_at, updated_at: AFTER });
      await insert(db, "preapprovals", { repo: "demo", number: pr, by: "erin", at: AFTER, instructions: "", state: "ci", from_head: `h${pr}`, updated_at: AFTER });
    }
  };
  // The end of the first attempt was recorded after the workflow started, which made a second one.
  await implement(40, [[41, "closed", BEFORE], [42, "pr", AFTER]]);
  await implement(45, [[46, "closed", BEFORE]]);
  await db.prepare("DELETE FROM main.preapprovals WHERE number = 42").run();
  await switchOver(db, { now: NOW });
  const legs = await rows(db, "SELECT p.number, w.number AS item FROM main.preapprovals p JOIN main.item_workflows w ON w.id = p.workflow_id WHERE p.number > 40 ORDER BY p.number");
  assert.deepEqual(legs.map((l) => [l.number, l.item]), [[41, 41], [46, 45]]);
  assert.deepEqual((await rows(db, "SELECT number, approved_by FROM main.item_workflows WHERE number IN (40, 45) ORDER BY number")).map((w) => [w.number, w.approved_by]), [[40, null], [45, "erin"]]);
  await db.close();
});

const attempt = async (db: Db, id: number, state: string, x: Record<string, string | number | null> = {}) => {
  await item(db, id, "issue");
  await insert(db, "implementations", { id, repo: "demo", number: id, queued_by: "dave", state, attempt: 1, text_hash: `x${id}`, created_at: BEFORE, updated_at: BEFORE, ...x });
};
const question = (db: Db, id: number, result: object) => insert(db, "implementation_rounds", { implementation_id: id, kind: "question", result: JSON.stringify(result), at: BEFORE });
const options = (...keys: string[]) => JSON.stringify(keys.map((k) => ({ key: k, label: `Label ${k}`, hint: "h" })));
const answerBy = (login: string, answer: string, at = AFTER) => ({ answer, answered_by: login, answered_at: at });

test("an implementation that waited for a maintainer when the switch ran still asks, and an answer nothing acted on is kept", async () => {
  const db = await legacy();
  // Stuck with its decision, after a plan question that was answered; stuck without one; stuck on its PR, answered.
  await decision(db, "demo#21:implement", { number: 21, options: options("try-again", "draft-pr", "close-issue", "backlog") });
  await attempt(db, 21, "stuck", { decision_id: "demo#21:implement", reason: "The session finished without changing anything" });
  await question(db, 21, { audience: "maintainer", text: "Globally?", decisionId: "demo#21:implement-q1-1" });
  await attempt(db, 22, "stuck", { reason: "The plan call failed: no reply" });
  await decision(db, "demo#23:implement", { number: 23, options: options("try-again", "close-pr", "backlog"), answer: "try-again", answer_note: "use the cache", answered_by: "alice", answered_at: AFTER });
  await attempt(db, 23, "stuck", { decision_id: "demo#23:implement", pr_number: 30, reason: "The pull request went back to the session too many times" });
  // Asked two questions at once: the decision's options belong to the first.
  await decision(db, "demo#24:implement-q1-1", { number: 24, question: "Globally or per file?", options: options("o1", "o2", "backlog"), recommended: "o2" });
  await attempt(db, 24, "asked", { decision_id: "demo#24:implement-q1-1" });
  await question(db, 24, { audience: "maintainer", text: "Globally or per file?", decisionId: "demo#24:implement-q1-1" });
  await question(db, 24, { audience: "maintainer", text: "Which icon?", decisionId: "demo#24:implement-q1-1" });

  const ask = async () => {
    const facts = (await loadImplementFacts(db, [21, 22, 23, 24].map((number) => ({ repo: "demo", number })), { withPlans: true })).byIssue;
    return [21, 22, 23, 24].map((n) => {
      const a = facts.get(`demo#${n}`)!, q = openQuestionOf(a);
      return { asks: a.question?.text, answer: a.answer && [a.answer.by, a.answer.option, a.answer.text, a.answer.question === a.question?.round], yes: q && viewOf(a, q, [], false).rec.answer?.option, parts: q && viewOf(a, q, [], false).plan.map((p) => p.option) };
    });
  };
  const r = (await switchOver(db, { now: NOW }))!;
  assert.deepEqual(r.questions, ["demo#21 stuck", "demo#22 stuck", "demo#23 stuck", "demo#24 asked"]);
  const first = await ask();
  assert.deepEqual(first, [
    { asks: "The implementation is stuck: The session finished without changing anything.", answer: null, yes: "try-again", parts: ["try-again", "draft-pr"] },
    { asks: "The implementation is stuck: The plan call failed: no reply.", answer: null, yes: "try-again", parts: ["try-again"] },
    { asks: "The implementation is stuck: The pull request went back to the session too many times.", answer: ["alice", "try-again", "use the cache", true], yes: null, parts: null },
    { asks: "Globally or per file?", answer: null, yes: "o2", parts: ["o1", "o2"] },
  ]);
  assert.deepEqual(r.unapplied.filter((id) => id.includes(":implement")), [], "a carried answer is acted on");
  const lines = [...(await loadEvents(db, [{ repo: "demo", number: 21 }], { archived: true })).values()].flat().map((e) => e.line);
  assert.deepEqual(lines, ["Question demo#21:implement? The implementation still asks it."]);
  await setting(db, "runner_heartbeat", "2026-11-22T00:00:00.000Z");
  assert.deepEqual((await switchOver(db, { now: "2026-11-23T00:00:00.000Z" }))!.questions, [], "a second run carries nothing again");
  assert.deepEqual(await ask(), first);
  // An older release ran again and two people answered there.
  for (const [id, answer] of [["demo#21:implement", "draft-pr"], ["demo#24:implement-q1-1", "o1"]]) {
    await db.prepare("UPDATE main.decisions SET answer = ?, answered_by = 'alice', answered_at = '2026-11-23T10:00:00.000Z' WHERE id = ?").run(answer, id);
  }
  for (const n of [1, 2]) {
    await setting(db, "runner_heartbeat", `2026-11-23T0${n}:00:00.000Z`);
    await switchOver(db, { now: `2026-11-24T0${n}:00:00.000Z` });
    assert.deepEqual((await ask()).map((a) => a.answer?.[1] ?? null), ["draft-pr", null, "try-again", "o1"]);
  }
  await db.close();
});

test("an answer nobody may act on leaves the question open, Backlog ends the workflow and a draft stays a draft", async () => {
  const db = await legacy();
  const stuck = async (id: number, x: Record<string, string | number | null>, state = "stuck") => {
    await decision(db, `demo#${id}:implement`, { number: id, options: options("try-again", "draft-pr", "backlog"), ...x });
    await attempt(db, id, state, { decision_id: `demo#${id}:implement`, reason: "The plan call failed: no reply" });
  };
  await stuck(31, { ...answerBy("alice", "try-again"), exec_state: "disputed", dispute_by: "erin" });
  await stuck(32, { ...answerBy("alice", "try-again"), exec_state: "waiting-token" });
  await stuck(33, answerBy("frank", "try-again"));
  await stuck(34, answerBy("gone", "try-again"));
  await stuck(35, answerBy("alice", "try-again"));
  await stuck(36, answerBy("alice", "backlog"));
  await stuck(37, answerBy("alice", "backlog", BEFORE));
  await stuck(38, { ...answerBy("alice", "draft-pr"), applied_at: AFTER }, "opening");
  await stuck(39, {});
  // Nobody started it.
  await stuck(40, answerBy("alice", "backlog"));
  await insert(db, "workspaces", { id: 1, repo: "demo", base_sha: "b", env_id: "e", state: "parked", state_at: BEFORE, created_at: BEFORE, updated_at: BEFORE });
  await insert(db, "remote_calls", { id: 1, step: "implement", stage: 1, prompt_id: "p", prompt_version: "1", tier: "top", effort: "medium", asked_model: "m", bundle: "{}", state: "queued", since: 0, seen_at: 0, max_attempts: 1, timeout_ms: 1 });
  await insert(db, "remote_call_items", { call_id: 1, pos: 0, repo: "demo", number: 36 });
  await db.prepare("UPDATE main.implementations SET workspace_id = 1 WHERE id = 36").run();
  const rec = (id: number) => JSON.stringify({ text: "Start it again.", parts: { fix: [], drop: [] }, merges: true, answer: { decision: `demo#${id}:implement`, option: "try-again" }, question: `demo#${id}:implement` });
  for (const [id, at] of [[36, BEFORE], [37, AFTER], [39, BEFORE]] as const) {
    await insert(db, "item_workflows", { id: 2000 + id, repo: "demo", number: id, kind: "issue", entry: "implement", state: "blocked", started_by: "erin", started_at: at, started_via: "github", approved_by: "erin", approved_at: at, blocker: "failed-twice", rec: rec(id), rec_at: AFTER, updated_at: AFTER });
  }
  const state = async () => {
    const numbers = [31, 32, 33, 34, 35, 38, 39];
    const facts = (await loadImplementFacts(db, numbers.map((number) => ({ repo: "demo", number })), { withPlans: true })).byIssue;
    return {
      answers: numbers.map((n) => [n, facts.get(`demo#${n}`)!.answer?.option ?? null]),
      workflows: (await rows(db, "SELECT number, state, rec, rec_at FROM main.item_workflows WHERE number IN (36, 37, 39) ORDER BY number")).map((w) => ({ ...w })),
      asks39: openQuestionOf(facts.get("demo#39")!),
      attempts: (await rows(db, "SELECT id, state, reason FROM main.implementations WHERE id IN (36, 37, 40) ORDER BY id")).map((x) => ({ ...x })),
      rounds: (await rows(db, "SELECT * FROM main.implementation_rounds ORDER BY id")).map((x) => JSON.stringify(x)),
    };
  };
  await switchOver(db, { now: NOW });
  const first = await state();
  assert.deepEqual(first.answers, [[31, null], [32, null], [33, null], [34, null], [35, "try-again"], [38, "draft-pr"], [39, null]], "disputed, waiting, no write access, no role");
  assert.deepEqual(first.workflows.map((w) => [w.number, w.state]), [[36, "backlog"], [37, "blocked"], [39, "blocked"]], "a start after the Backlog answer stands");
  const ended = { state: "cancelled", reason: "moved to the backlog by alice" };
  assert.deepEqual(first.attempts, [{ id: 36, ...ended }, { id: 37, state: "stuck", reason: "The plan call failed: no reply" }, { id: 40, ...ended }], "a later implement makes a new attempt");
  assert.equal((await rows(db, "SELECT state FROM main.item_workflows WHERE number = 40"))[0]!.state, "backlog");
  assert.equal((await rows(db, "SELECT state FROM main.workspaces"))[0]!.state, "ended");
  assert.equal((await rows(db, "SELECT state FROM main.remote_calls"))[0]!.state, "failed");
  const back = first.workflows[2]!;
  assert.equal(back.rec_at, AFTER, "the same question does not come back as a new one");
  assert.deepEqual([JSON.parse(back.rec as string).question, JSON.parse(back.rec as string).answer.question], [first.asks39, first.asks39]);
  assert.ok(opensAsDraft((await attemptNow(db, { id: 38, repo: "demo", number: 38 }))!.rounds));
  await db.prepare("DELETE FROM main.settings WHERE key = ?").run(SWITCH_KEY);
  await switchOver(db, { now: "2026-11-21T00:00:00.000Z" });
  assert.deepEqual(await state(), first);
  await db.close();
});
