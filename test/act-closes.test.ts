// The Act step: a close command is carried out as the person who sent it, with the app's comment first. It waits for their sign-in,
// leaves an item alone that closed or moved meanwhile, is taken back by a stop, and stops after repeated failures.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { endGoneCloses } from "../src/act/gone.ts";
import { runAct } from "../src/act/index.ts";
import { guardItem } from "../src/core/guard.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { plannedItems } from "../src/core/select-items.ts";
import * as kx from "../src/db/kx.ts";
import { loadActBlocked } from "../src/data/control/index.ts";
import { loadActions, queueActions, startWorkflows } from "../src/data/workflow/index.ts";
import { setGithubIdentity } from "../src/github/identity.ts";
import { authFailure, retryWaiting, type LaneDeps } from "../src/github/user-lane.ts";
import { detectAutopilot, LANES, planCtx } from "../src/runner/autopilot.ts";
import { checkRequest } from "../src/runner/jobs.ts";
import { scopeRepos } from "../src/runner/scope.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { stateLine } from "../src/workflow/status.ts";
import { legWait } from "../src/workflow/waits.ts";
import { OPERATOR, T0, T1, world, type World } from "./world-db.ts";

const quiet = (l: string) => { if (process.env.DBG) console.error(l); };
const MIRA = "mira";
let current: World | null = null;
afterEach(() => { current?.close(); current = null; });

/** The tracked repo under the app's identity with a maintainer. `signedIn`: the maintainer has a stored token. */
async function fresh(o: { signedIn?: boolean; off?: Parameters<World["repo"]>[0] } = {}): Promise<World> {
  const w = current = await (await world()).repo(o.off ?? []);
  await w.db.prepare("INSERT INTO access (login, role) VALUES (?, 'maintainer')").run(MIRA);
  await setGithubIdentity(w.db, OPERATOR, "app");
  if (o.signedIn ?? true) await w.db.prepare("INSERT INTO user_tokens (login, github_id, token_enc, updated_at) VALUES (?, 5, 'x', ?)").run(MIRA, T0);
  return w;
}
const send = async (w: World, text: string, n: number) =>
  (await runCommand(w.db, { login: MIRA, canWrite: async () => true }, "dashboard", { parsed: parse(text, { repo: "app" }), items: [{ repo: "app", number: n }] })).items[0]!;

type Sent = { lane: "person" | "app"; what: string; vars: Record<string, unknown> };
/** The world answers every item it tracks as a pull request; #8 is the only one. */
async function readItem(w: World, q: string, vars: Record<string, unknown>, states: Record<number, string> = {}): Promise<any> {
  const r = await w.gh.querier.query(q, vars) as { repository: { issueOrPullRequest: { __typename: string; state: string; headRefOid?: string } } };
  const x = r.repository.issueOrPullRequest, n = vars.n as number;
  if (n !== 8) { x.__typename = "Issue"; delete x.headRefOid; }
  if (states[n]) x.state = states[n];
  return r;
}

/** The person's and the app's transports over the world's GitHub; `fail` throws for a write, `before` runs ahead of it. */
function github(w: World, o: { signedIn?: () => boolean; states?: Record<number, string>; fail?: (s: Sent) => Error | null; before?: (s: Sent) => Promise<void> } = {}) {
  const sent: Sent[] = [];
  const through = (lane: Sent["lane"]) => ({ spent: 0, remaining: null as number | null, query: async (q: string, v?: object): Promise<any> => {
    const vars = (v ?? {}) as Record<string, unknown>;
    const s: Sent = { lane, what: q.includes("addComment") ? "comment" : /closeIssue|closePullRequest/.test(q) ? "close" : "read", vars };
    if (q.includes("issueOrPullRequest")) return await readItem(w, q, vars, o.states);
    if (s.what !== "read") {
      await o.before?.(s);
      const e = o.fail?.(s);
      if (e) throw e;
      sent.push(s);
    }
    return await w.gh.querier.query(q, vars);
  } });
  const lane: LaneDeps = {
    vault: { userToken: async () => ((o.signedIn?.() ?? true) ? { ok: true, access: "t" } : { ok: false, needsSignIn: true, why: "no-token" }) } as LaneDeps["vault"],
    permission: async () => "write",
    transports: () => ({ querier: through("person"), exec: async () => ({ code: 0, stdout: "", stderr: "" }) }),
  };
  const deps = { querier: { ...w.gh.querier, query: async () => { throw new Error("the box's transport was used"); } }, now: () => new Date(T1), lane, app: { mint: async () => "app-token", appClient: () => through("app") } };
  return { sent, deps: deps as never, what: () => sent.map((s) => `${s.lane}:${s.what}`) };
}
const run = (w: World, g: { deps: never }, o: { onHandled?: (n: number) => void } = {}) => runAct(w.db, { repo: "app", dryRun: false, ...o }, quiet, g.deps);
const actionOf = async (w: World, n: number) => (await loadActions(w.db, { refs: [{ repo: "app", number: n }] })).get(`app#${n}`)!.at(-1)!;
const due = async (w: World) => (await plannedItems(w.db, "act", { repo: "app" })).map((p) => p.facts.number);
const line = async (w: World, n: number) => {
  const a = await actionOf(w, n);
  return await legWait(w.db, { id: a.workflow_id, repo: "app", number: n, kind: "issue", state: "closed" });
};

describe("a close command", () => {
  test("is planned, commented as the app and closed as the person, with the reason it names", async () => {
    const w = await fresh();
    await (await (await (await w.issue(5)).issue(6)).issue(7)).pr(8);
    assert.match((await send(w, "close as not planned", 5)).line, /^Closing as not planned \(by mira, /);
    await send(w, "close as duplicate of #5", 6);
    await send(w, "close", 7);
    await send(w, "close", 8);
    assert.deepEqual((await due(w)).sort(), [5, 6, 7, 8]);
    assert.ok((await scopeRepos(w.db)).has("app"));
    const g = github(w);
    let handled = 0;
    const r = await run(w, g, { onHandled: (n) => { handled = n; } });
    assert.deepEqual(r.done, ["app#5", "app#6", "app#7", "app#8"]);
    assert.equal(handled, 4);
    assert.deepEqual(g.what(), Array.from({ length: 4 }, () => ["app:comment", "person:close"]).flat());
    const closes = g.sent.filter((s) => s.what === "close").map((s) => [s.vars.id, s.vars.reason, s.vars.dup]);
    assert.deepEqual(closes, [["P5", "NOT_PLANNED", undefined], ["P6", "DUPLICATE", "P5"], ["P7", undefined, undefined], ["P8", undefined, undefined]]);
    const texts = g.sent.filter((s) => s.what === "comment").map((s) => String(s.vars.body).split("\n").at(-1));
    assert.deepEqual(texts, ["Closing this issue as not planned.", "Duplicate of #5.", "Closing this issue.", "Closing this pull request."]);
    assert.equal((await actionOf(w, 5)).state, "done");
    assert.deepEqual(await due(w), []);
    assert.equal(await line(w, 5), null);
    const rows = await w.db.all(w.db.k.selectFrom("audit").select(["action", "details"]).where("action", "in", ["act-close", "act-comment"]).where("target", "=", "app#5").orderBy(kx.rowid("audit"))) as { action: string; details: string }[];
    assert.deepEqual(rows.map((x) => [x.action, (JSON.parse(x.details) as { identity: string }).identity]), [["act-comment", "app"], ["act-close", `user:${MIRA}`]]);
    assert.deepEqual((await run(w, g)).done, [], "carried out once");
  });

  test("a duplicate GitHub does not link is closed as not planned", async () => {
    const w = await fresh();
    await (await w.issue(5)).issue(6);
    await send(w, "close duplicate of #5", 6);
    const g = github(w, { fail: (s) => (s.vars.reason === "DUPLICATE" ? new Error("Variable $reason: argument validation failed") : null) });
    assert.deepEqual((await run(w, g)).done, ["app#6"]);
    assert.deepEqual(g.sent.filter((s) => s.what === "close").map((s) => s.vars.reason), ["NOT_PLANNED"]);
    const [a] = await w.rows("SELECT details FROM audit WHERE action = 'act-close'") as { details: string }[];
    assert.match(a!.details, /"requestedReason":"DUPLICATE"/);
  });

  test("a duplicate must name another item AutoCraft has read", async () => {
    const w = await fresh();
    await w.issue(5);
    for (const text of ["close as duplicate of #5", "close as duplicate of #77", "close as duplicate of other/thing#1"]) assert.equal((await send(w, text, 5)).outcome, "refused", text);
    assert.equal((await loadActions(w.db, {})).size, 0);
  });

  test("a person's close runs in a repo with no approvals, and only theirs: the guard needs the close to be due", async () => {
    const w = await fresh({ off: ["merge", "push", "comment", "ci", "fixissue"] });
    await (await w.issue(5)).issue(6);
    const grant = (n: number, id: number) => guardItem(w.db, { repo: "app", number: n }, { kind: "act", bucket: "close", id }, "pipeline", MIRA);
    const jobs = async () => await LANES.find((l) => l.name === "act")!.detect(w.db, await planCtx(w.db));
    assert.deepEqual(await jobs(), []);
    await send(w, "close", 5);
    const a = await actionOf(w, 5);
    assert.ok(!("refused" in await grant(5, a.id)));
    // Nobody told AutoCraft to close #6.
    assert.match((await grant(6, a.id) as { refused: string }).refused, /Comments in app are not approved/);
    const found = await jobs();
    assert.deepEqual(found.map((c) => [c.step, c.params.repo]), [["act", "app"]]);
    await checkRequest(w.db, found[0]!.step, found[0]!.params);
    await send(w, "stop", 5);
    assert.ok("refused" in await grant(5, a.id));
    assert.deepEqual(await jobs(), []);
    await send(w, "close", 5);
    const g = github(w);
    assert.deepEqual((await run(w, g)).done, ["app#5"]);
    assert.deepEqual(g.sent.map((s) => s.what), ["comment", "close"]);
  });
});

describe("a close that is not made", () => {
  test("waits for the person's sign-in, is no work meanwhile, and runs after it", async () => {
    const w = await fresh({ signedIn: false });
    await w.issue(5);
    await send(w, "close", 5);
    assert.equal((await actionOf(w, 5)).state, "waiting-token");
    assert.match(await line(w, 5) ?? "", /Waiting for mira to sign in/);
    assert.deepEqual(await due(w), []);
    // Their token turns out unusable when the close runs: it waits again, and the run counts nothing.
    await retryWaiting(w.db, MIRA);
    let signedIn = false, handled = 0;
    const g = github(w, { signedIn: () => signedIn });
    await run(w, g, { onHandled: (n) => { handled = n; } });
    assert.deepEqual([(await actionOf(w, 5)).state, handled, g.sent.length], ["waiting-token", 0, 0]);
    signedIn = true;
    assert.equal(await retryWaiting(w.db, MIRA), 1);
    assert.deepEqual((await run(w, g)).done, ["app#5"]);
  });

  test("an item closed already, seen live or by the sync, ends as done with nothing written", async () => {
    const w = await fresh();
    await (await w.issue(5)).issue(6);
    await send(w, "close", 5);
    await send(w, "close", 6);
    const g = github(w, { states: { 5: "CLOSED" } });
    await w.db.prepare("UPDATE items SET state = 'CLOSED' WHERE repo = 'app' AND number = 6").run();
    assert.equal(await endGoneCloses(w.db), 1);
    assert.deepEqual((await run(w, g)).skipped, [{ ref: "app#5", reason: "already closed on GitHub" }]);
    assert.deepEqual([(await actionOf(w, 5)).state, (await actionOf(w, 6)).state, g.sent.length], ["done", "done", 0]);
  });

  test("a pull request that got commits after the command stays open, and the item says so", async () => {
    const w = await fresh();
    await w.pr(8);
    await send(w, "close", 8);
    w.gh.live(8, { head: "moved" });
    const g = github(w);
    await run(w, g);
    assert.deepEqual([(await actionOf(w, 8)).state, g.sent.length], ["skipped", 0]);
    assert.match(await line(w, 8) ?? "", /Not closed: the pull request changed/);
  });

  test("a stop takes it back, also between the comment and the close; started work does too", async () => {
    const w = await fresh();
    await (await (await w.issue(5)).issue(6)).pr(8);
    await send(w, "close", 5);
    assert.equal((await send(w, "stop", 5)).outcome, "run");
    assert.equal((await actionOf(w, 5)).state, "stopped");
    assert.equal((await send(w, "stop", 5)).outcome, "refused", "nothing is left to stop");
    await send(w, "close", 6);
    const g = github(w, { before: async (s) => { if (s.what === "comment") await send(w, "stop", 6); } });
    await run(w, g);
    assert.deepEqual(g.what(), ["app:comment"]);
    assert.equal((await actionOf(w, 6)).state, "stopped");
    await send(w, "close", 8);
    await send(w, "review", 8);
    assert.equal((await actionOf(w, 8)).state, "stopped");
  });

  test("a person who lost their role ends it", async () => {
    const w = await fresh();
    await w.issue(5);
    await send(w, "close", 5);
    await w.db.prepare("DELETE FROM access WHERE login = ?").run(MIRA);
    const g = github(w);
    await run(w, g);
    assert.deepEqual([(await actionOf(w, 5)).state, g.sent.length], ["stopped", 0]);
  });

  test("a close that fails three times has failed without blocking the others; the comment is posted once and a new command closes", async () => {
    const w = await fresh();
    await (await w.issue(5)).issue(6);
    await send(w, "close", 5);
    await send(w, "close", 6);
    let broken = true;
    const g = github(w, { fail: (s) => (broken && s.what === "close" && s.vars.id === "P5" ? new Error("GitHub refused the close") : null) });
    const first = await run(w, g);
    assert.deepEqual([first.done, first.failed.length], [["app#6"], 1]);
    assert.deepEqual([(await actionOf(w, 5)).state, (await actionOf(w, 5)).attempts], ["pending", 1]);
    for (let i = 0; i < 3; i++) await run(w, g);
    const a = await actionOf(w, 5);
    assert.deepEqual([a.state, a.attempts], ["failed", 3]);
    assert.match(a.reason!, /stopped after 3 failed tries/);
    assert.equal(g.sent.filter((s) => s.what === "comment" && s.vars.id === "P5").length, 1);
    assert.deepEqual(await due(w), []);
    broken = false;
    await send(w, "close", 5);
    assert.deepEqual((await run(w, g)).done, ["app#5"]);
  });

  test("a GitHub server error stops the run without counting a try; a missing permission waits", async () => {
    const w = await fresh();
    await (await w.issue(5)).issue(6);
    await send(w, "close", 5);
    await send(w, "close", 6);
    const down = await run(w, github(w, { fail: (s) => (s.what === "comment" ? new Error("HTTP 502 Bad Gateway") : null) }));
    assert.deepEqual([down.done.length, down.failed.length, (await actionOf(w, 5)).attempts], [0, 1, 0]);
    await run(w, github(w, { fail: (s) => (s.what === "close" && s.vars.id === "P5" ? new Error("gh failed: Resource not accessible (HTTP 403)") : null) }));
    assert.deepEqual([(await actionOf(w, 5)).state, (await actionOf(w, 6)).state], ["waiting-permission", "done"]);
  });
});

test("an ask of the author is posted once at its head, its status names what holds it back until then; one the author's push overtook brings the workflow back as a question", async () => {
  const w = await fresh();
  await w.pr(8, { author: "octo-dev" });
  const line = async () => stateLine((await liveWorkflow(w.db, "app", 8))!);
  // While the pipeline is off the ask is not posted, and the status says so rather than that the author was asked.
  await w.pipeline(false);
  assert.equal((await send(w, "ask author to wire the group editor", 8)).outcome, "run");
  assert.match(await line(), /^Waiting to ask octo-dev: the pipeline is off/i);
  // The ask reads the PR through the step's own querier: its comment is the app's, with no person's lane.
  const reading = <G extends { deps: never }>(g: G): G => { (g.deps as { querier: unknown }).querier = { ...w.gh.querier, query: async (q: string, v?: object) => await readItem(w, q, (v ?? {}) as Record<string, unknown>) }; return g; };
  const g0 = reading(github(w));
  await runAct(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, g0.deps);
  assert.deepEqual([(await actionOf(w, 8)).state, g0.sent.length], ["pending", 0]);
  assert.match(await line(), /^Waiting to ask octo-dev: the pipeline is off/i);
  await w.pipeline(true);
  const g = reading(github(w));
  assert.deepEqual((await run(w, g)).asked, ["app#8"]);
  assert.deepEqual([(await actionOf(w, 8)).state, g.what()], ["done", ["app:comment"]]);
  assert.match(String(g.sent[0]!.vars.body), /@octo-dev[\s\S]*wire the group editor/);
  assert.equal((await liveWorkflow(w.db, "app", 8))!.state, "waiting");
  assert.match(await line(), /^Waiting for octo-dev: /);
  // A new ask, and a push of the author's before it is posted: nothing is posted, and the person gets the question again.
  assert.equal((await send(w, "ask author to cover split panes", 8)).outcome, "run");
  w.gh.live(8, { head: "moved" });
  const g2 = reading(github(w));
  await run(w, g2);
  const wf = (await liveWorkflow(w.db, "app", 8))!;
  assert.deepEqual([(await actionOf(w, 8)).state, g2.sent.length, wf.state, wf.rec?.author, wf.recHead], ["skipped", 0, "recommending", "scope", "sha8"]);
});

test("a close is planned for an item outside the pipeline's scope, and by the box account only for an operator", async () => {
  const w = await fresh();
  await w.issue(5);
  await setGithubIdentity(w.db, OPERATOR, "box");
  await w.db.prepare("UPDATE tracked_repos SET pipeline = 0 WHERE name = 'app'").run();
  const start = async (by: string) => {
    const id = (await startWorkflows(w.db, [{ repo: "app", number: 5, kind: "issue", entry: "implement", weight: 5, startedBy: by, startedVia: "cli", baseHead: null, at: T0 }])).get("app#5")!;
    await w.db.prepare("UPDATE item_workflows SET state = 'closed' WHERE id = ?").run(id);
    await queueActions(w.db, [{ workflowId: id, repo: "app", number: 5, kind: "close", by, head: null, at: T0 }]);
  };
  await start(MIRA);
  // The close is the act step's alone: no other step works the repo.
  assert.deepEqual([[...await scopeRepos(w.db)], [...await scopeRepos(w.db, { for: "cards" })], (await loadActBlocked(w.db, ["app"])).get("app")], [[], ["app"], null]);
  assert.deepEqual((await detectAutopilot(w.db)).proposals.filter((p) => p.params.repo === "app").map((p) => p.step), ["act"]);
  const box = w.gh.actDeps();
  const g = { deps: { ...box, querier: { ...box.querier, query: async (q: string, v?: object) => (q.includes("issueOrPullRequest") ? await readItem(w, q, v as Record<string, unknown>) : await box.querier.query(q, v ?? {})) } } as never };
  await run(w, g);
  assert.deepEqual([(await actionOf(w, 5)).state, w.gh.writes.length], ["waiting-permission", 0]);
  await start(OPERATOR);
  assert.equal((await loadItemFact(w.db, "app", 5))?.inScope, false);
  await run(w, g);
  assert.deepEqual(w.gh.writes.map((x) => x.kind), ["close"], "a close without a comment");
});

test("a rate limit is transient and a 403 or 404 status is no access; words and numbers in the text decide nothing", () => {
  assert.equal(authFailure(new Error("gh failed: You have exceeded a secondary rate limit (HTTP 403)")), "transient");
  assert.equal(authFailure(new Error("gh failed: Resource not accessible by integration (HTTP 403)")), "waiting-permission");
  assert.equal(authFailure(new Error("gh failed: Bad credentials (HTTP 401)")), "waiting-token");
  assert.equal(authFailure(new Error("refused: app#403 not found, bad credentials in the title")), null);
});
