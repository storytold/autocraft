// GitHub in a repo on the maintainer workflow: answers need the app's mention, strangers with write access get one "link your
// account" answer a week, a quiet PR's status comment says nothing about findings or the recommendation, a status comment's new
// question pings its asked people once, an implementation's question is answered on its issue, and `ask <question>` is answered in
// a reply once the asker's own Task Runner has answered it.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { safeEqual } from "../src/dash/server/crypto.ts";
import { recordSteps, startAttempt } from "../src/data/implement/index.ts";
import { drainCommands, type CommandDeps, type CommentNow } from "../src/github/commands.ts";
import { handleDelivery, signatureOf } from "../src/github/webhooks.ts";
import { runPrStatus, statusDue } from "../src/prstatus/index.ts";
import type { Exec } from "../src/fixup/git.ts";
import type { Querier } from "../src/mirror.ts";
import { recordPlan } from "../src/implement/plan.ts";
import type { PlanReply } from "../src/implement/types.ts";
import { loadImplementFacts } from "../src/data/implement/index.ts";
import { openQuestionOf, viewOf } from "../src/workflow/question.ts";
import { textHash } from "../src/core/open-prs.ts";
import { roundsOf, startImplementation } from "./implement-rows.ts";
import type { AppPermission } from "../src/remote/permission.ts";
import { insertWorkflow, liveWorkflow, updateWorkflow } from "../src/workflow/store.ts";
import { OPERATOR, T0, T1, world, type World } from "./world-db.ts";
import { askedQuestion, commentQuestion, parse } from "../src/workflow/parse.ts";
import { answerPending } from "../src/conversations/run.ts";
import { setEnabled } from "../src/runner/autopilot.ts";
import { fakeTaskRunner } from "./fake-runner.ts";

const SLUG = "autocraft-bot";
const SECRET = "hook-secret";
const OP_ID = 101;

let current: World | undefined;
afterEach(() => current?.close());

/** The repo "app" on the maintainer workflow, with the app identity and the operator bound to a GitHub id. */
async function newRepo(): Promise<World> {
  const w = current = await (await world()).repo();
  const db = w.db;
  await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.updateTable("main.access").set({ github_id: OP_ID }).where("login", "=", OPERATOR));
  return w;
}

const bodies = new Map<number, string>();
let nextComment = 7000;
async function comment(w: World, body: string, o: { login?: string; id?: number; number?: number; issue?: true } = {}): Promise<number> {
  const id = nextComment++;
  bodies.set(id, body);
  const p = {
    action: "created", repository: { full_name: "storytold/app", name: "app" }, issue: { number: o.number ?? 1, ...(o.issue ? {} : { pull_request: { url: "x" } }) },
    comment: { id, body, created_at: new Date().toISOString(), user: { login: o.login ?? OPERATOR, id: o.id ?? OP_ID, type: "User" } },
  };
  const raw = Buffer.from(JSON.stringify(p));
  await handleDelivery(w.db, SECRET, { event: "issue_comment", signature: signatureOf(SECRET, raw) }, raw, safeEqual, SLUG);
  return id;
}

const PERM: Record<"write" | "read", AppPermission> = { write: { kind: "ok", permission: "write" }, read: { kind: "ok", permission: "read" } };
/** Drains after the re-reads, with GitHub answering: the comment as written, each PR unchanged at its mirror head. */
async function drain(w: World, perm: "write" | "read" = "write") {
  const db = w.db;
  for (const { number } of await db.all(db.k.selectFrom("main.github_commands").select("number").distinct())) {
    await db.run(db.k.insertInto("main.item_reads").values({ repo: "app", number, synced_at: new Date(Date.now() + 1000).toISOString() })
      .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet({ synced_at: new Date(Date.now() + 1000).toISOString() })));
  }
  const deps: CommandDeps = {
    querier: w.gh.querier, permission: async () => PERM[perm], slug: SLUG,
    comment: async (_repo, id): Promise<CommentNow> => {
      const r = (await db.get(db.k.selectFrom("main.github_commands").select("github_id").where("comment_id", "=", id)))!;
      return { kind: "ok", authorId: r.github_id, body: bodies.get(id)! };
    },
    pr: async (_q, _repo, n) => ({ head: (await db.get(db.k.selectFrom("main.items").select("head_oid").where("repo", "=", "app").where("number", "=", n)))!.head_oid!, opened: T0, changed: false }),
  };
  return await drainCommands(db, deps);
}
const commands = async (w: World) => await w.db.all(w.db.k.selectFrom("main.github_commands").select(["comment_id", "command", "state", "result", "reply"]).orderBy("comment_id"));

test("a comment without the app's mention runs nothing; the same words with it start the item", async () => {
  const w = await newRepo();
  await w.pr(1);
  await comment(w, "fix-up and merge");
  await comment(w, `Looks good, please ask @${SLUG} review`);
  await comment(w, `> @${SLUG} review`);
  await drain(w);
  assert.deepEqual(await commands(w), [], "nothing is queued");
  assert.equal(await liveWorkflow(w.db, "app", 1), null);

  await comment(w, `@${SLUG} review`);
  await drain(w);
  const [r] = await commands(w);
  assert.equal(r?.command, "answer");
  assert.equal(r?.state, "done", r?.result ?? "");
  assert.match(r!.result!, /Reviewing/);
  assert.notEqual(r!.reply, "none", "the confirmation is answered in the thread");
  assert.equal((await liveWorkflow(w.db, "app", 1))?.entry, "review");
});

test("a commenter with write access but no bound AutoCraft login gets one link-your-account answer a week; one without write gets none", async () => {
  const w = await newRepo();
  await w.pr(1);
  const answered = async () => (await commands(w)).filter((r) => r.reply !== "none").length;

  await comment(w, `@${SLUG} review`, { login: "reader", id: 300 });
  await drain(w, "read");
  assert.equal(await answered(), 0, "no write access: no answer");

  await comment(w, `@${SLUG} review`, { login: "stranger", id: 301 });
  await drain(w);
  assert.equal(await answered(), 1);
  assert.match((await commands(w)).at(-1)!.result!, /sign in/i);

  await comment(w, `@${SLUG} merge`, { login: "stranger", id: 301 });
  await drain(w);
  assert.equal(await answered(), 1, "a second comment in the same week gets no answer");
  assert.equal(await liveWorkflow(w.db, "app", 1), null, "nothing ran");

  await w.db.run(w.db.k.updateTable("main.github_link_nudges").set({ at: new Date(Date.now() - 8 * 86400_000).toISOString() }));
  await comment(w, `@${SLUG} merge`, { login: "stranger", id: 301 });
  await drain(w);
  assert.equal(await answered(), 2, "after a week the next comment is answered again");
});

test("a quiet PR's status comment carries no findings or recommendation text", async () => {
  const w = await newRepo();
  const db = w.db;
  await w.pr(1);
  await w.pr(2);
  await db.run(db.k.updateTable("main.items").set({ url: "https://github.com/storytold/app/pull/1" }).where("number", "=", 1));
  await db.run(db.k.updateTable("main.items").set({ url: "https://github.com/storytold/app/pull/2" }).where("number", "=", 2));
  const rec = { text: "Fix the bounds check in the token parser, then merge.", parts: { fix: [1], drop: [] }, merges: true };
  const plan = [{ n: 1, title: "Token parser reads past the buffer", source: "review" as const, major: true, state: "planned" as const }];
  for (const n of [1, 2]) {
    const id = await insertWorkflow(db, { repo: "app", number: n, kind: "pr", entry: "review", state: "running", startedBy: OPERATOR, startedAt: T0, startedVia: "github" }, T0);
    await updateWorkflow(db, id, { state: "recommending", rec, recAt: T0, plan }, T0);
  }
  await db.run(db.k.insertInto("main.security_findings").values({ repo: "app", number: 1, scan_id: 900, area: "a", title: "t", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "fp1", created_at: T0, updated_at: T0, fix_pr: 1 }));

  const due = new Map((await statusDue(db, "app")).map((d) => [d.number, d.line]));
  const quiet = due.get(1)!, open = due.get(2)!;
  assert.ok(quiet && open, "both started PRs get a comment");
  for (const secret of [rec.text, plan[0]!.title]) {
    assert.ok(open.includes(secret), "an ordinary PR shows it");
    assert.ok(!quiet.includes(secret), "the quiet PR does not");
  }
  assert.doesNotMatch(quiet, /finding/i);
});

test("a stop comment on the pull request of an implementation halts the issue's work and answers in the thread", async () => {
  const w = await newRepo();
  await w.acting(OPERATOR);
  await w.issue(7);
  await w.pr(8, { author: "craft-bot" });
  const id = await insertWorkflow(w.db, { repo: "app", number: 7, kind: "issue", entry: "implement", state: "running", startedBy: OPERATOR, startedAt: T0, startedVia: "github" });
  const im = (await startAttempt(w.db, { repo: "app", number: 7, queuedBy: OPERATOR, textHash: "h" }))!;
  await recordSteps(w.db, [{ id: im.id, to: "pr-opened", patch: { prNumber: 8, branch: "fix-8", prUrl: "https://example.invalid/8" } }]);
  await comment(w, `@${SLUG} review`, { number: 8 });
  await comment(w, `@${SLUG} stop`, { number: 8 });
  await drain(w);
  const [review, stop] = await commands(w);
  assert.deepEqual([review!.state, stop!.state], ["refused", "done"], `${review!.result} / ${stop!.result}`);
  assert.match(stop!.result!, /app#7: On hold \(held by /);
  assert.equal(await liveWorkflow(w.db, "app", 7), null);
  assert.equal((await w.db.get(w.db.k.selectFrom("main.item_workflows").select("stopped_by").where("id", "=", id)))!.stopped_by, OPERATOR);
});

test("a question on a started issue's status comment pings its asked people once per question; once the implementation's PR exists, the PR's comment asks", async () => {
  const w = await newRepo();
  const db = w.db;
  await w.issue(7);
  await w.pr(8, { author: "craft-bot" });
  for (const [n, kind] of [[7, "issues"], [8, "pull"]] as const) await db.run(db.k.updateTable("main.items").set({ url: `https://github.com/storytold/app/${kind}/${n}` }).where("number", "=", n));
  const id = await insertWorkflow(db, { repo: "app", number: 7, kind: "issue", entry: "implement", state: "running", startedBy: OPERATOR, startedAt: T0, startedVia: "github" }, T0);
  const ask = async (text: string, at: string) => await updateWorkflow(db, id, { state: "recommending", rec: { text, parts: { fix: [], drop: [] }, merges: false }, recAt: at }, at);

  let next = 5000, refusePing = false;
  const writes: { args: string[]; body: string }[] = [];
  const exec: Exec = async (_cmd, args, opts) => {
    writes.push({ args, body: opts?.input ?? "" });
    if (refusePing && args[0] === "issue" && !(opts?.input ?? "").includes("autocraft:pr-status")) return { code: 1, stdout: "", stderr: "HTTP 502" };
    if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ html_url: "x" }), stderr: "" };
    return { code: 0, stdout: `https://github.com/storytold/app/issues/${args[2]}#issuecomment-${next++}\n`, stderr: "" };
  };
  const none = { comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] } };
  const querier: Querier = { spent: 0, remaining: 5000, query: async () => ({ repository: { issue: none, pullRequest: none } }) as never };
  const run = async () => { const from = writes.length; const r = await runPrStatus(db, { repo: "app", by: "pipeline", runId: "t", limit: 10, exec, querier, base: null, mint: async () => "installation-token" }); return { r, made: writes.slice(from) }; };
  const pings = (made: typeof writes) => made.filter((x) => x.args[0] === "issue" && !x.body.includes("autocraft:pr-status"));

  await ask("Split it into two pull requests.", T0);
  const first = await run();
  assert.deepEqual([first.r.posted, first.r.pinged], [["app#7"], ["app#7"]]);
  const [ping] = pings(first.made);
  assert.match(ping!.body, new RegExp(`@${OPERATOR} Recommendation: Split it into two pull requests\\.`));
  assert.match(ping!.body, /issues\/7#issuecomment-5000/, "it links the status comment");
  assert.equal((await run()).made.length, 0, "the same question is not pinged again");

  await ask("Keep it in one pull request.", T1);
  refusePing = true;
  const refused = await run();
  assert.deepEqual([refused.r.edited, refused.r.failed, refused.r.pingFailed], [["app#7"], [], ["app#7"]], "a failed ping does not fail the comment's edit");
  const row = async () => (await db.get(db.k.selectFrom("main.pr_status_comments").select(["pinged", "retry_at"]).where("number", "=", 7)))!;
  assert.equal((await row()).retry_at, null, "nor holds up its next edit");
  assert.ok(!(await row()).pinged!.endsWith(T1), "the question is not counted as pinged");
  refusePing = false;
  const second = await run();
  assert.deepEqual([second.r.edited, second.r.pinged], [[], ["app#7"]], "the ping is tried again, without an edit");

  await updateWorkflow(db, id, { state: "running", rec: null, recAt: null });
  const answered = await run();
  assert.deepEqual([answered.r.edited, answered.r.pinged], [["app#7"], []]);
  assert.doesNotMatch(answered.made[0]!.body, /Recommendation/);

  await db.run(db.k.updateTable("main.item_workflows").set({ pr_number: 8 }).where("id", "=", id));
  await ask("Merge it as it is.", "2026-01-03T00:00:00Z");
  const opened = await run();
  assert.deepEqual([opened.r.edited, opened.r.posted, opened.r.pinged], [["app#7"], ["app#8"], ["app#8"]], "the PR's comment asks and pings; the issue's names the PR");
  const issueBody = opened.made.find((x) => x.args[0] === "api")!.body;
  assert.match(issueBody, /Implementation: #8/);
  assert.doesNotMatch(issueBody, /Recommendation/);
});

test("an implementation's question is answered by a comment on its issue, by option number or by yes", async () => {
  const w = await newRepo();
  const db = w.db;
  await w.acting(OPERATOR);
  const reply = (recommended: string | null): PlanReply => ({
    ready: false, kind: "feature", summary: "Export layers as separate files.", plan: "The export writes one file today.", acceptance: [], verification: { tests: [], app: null }, size: "L", risks: [],
    questions: [{ audience: "maintainer", text: "One file per layer, or one archive?", options: [{ label: "One file per layer", hint: "" }, { label: "One archive", hint: "" }], recommended }],
  });
  const asked = async (n: number) => {
    await w.issue(n);
    const it = (await db.get(db.k.selectFrom("main.items").select(["title", "body"]).where("repo", "=", "app").where("number", "=", n)))!;
    const impl = await startImplementation(db, { repo: "app", number: n, queuedBy: OPERATOR, textHash: textHash(it.title ?? "", it.body ?? "") });
    await recordPlan(db, impl, { callId: n, reply: reply("One file per layer") }, { commentsApproved: false, postComment: async () => null, log: () => {} });
    const id = await insertWorkflow(db, { repo: "app", number: n, kind: "issue", entry: "implement", state: "running", startedBy: OPERATOR, startedAt: T0, startedVia: "github" }, T0);
    const a = (await loadImplementFacts(db, [{ repo: "app", number: n }])).byIssue.get(`app#${n}`)!;
    const v = viewOf(a, openQuestionOf(a)!, [], false);
    await updateWorkflow(db, id, { state: "recommending", rec: v.rec, recAt: T0, plan: v.plan });
    return impl.id;
  };
  const answer = async (impl: number) => (await roundsOf(db, impl)).filter((r) => r.kind === "answer").map((r) => (r.result as { option: string }).option);

  const byNumber = await asked(7), byYes = await asked(9), byQuestion = await asked(11);
  await comment(w, `@${SLUG} 2`, { number: 7, issue: true });
  await comment(w, `@${SLUG} yes`, { number: 9, issue: true });
  await comment(w, `@${SLUG} one file per layer?`, { number: 11, issue: true });
  await drain(w);
  assert.deepEqual((await commands(w)).slice(0, 2).map((c) => c.state), ["done", "done"], JSON.stringify(await commands(w)));
  assert.deepEqual(await answer(byNumber), ["o2"], "the named option answers");
  assert.deepEqual(await answer(byYes), ["o1"], "a yes answers with the recommended option");
  assert.deepEqual(await answer(byQuestion), [], "an option named in a question answers nothing");
});

test("ask <question> is a question, ask author stays the command, a bare question or command is no ask", () => {
  assert.equal(askedQuestion("ask why does the preview lose alpha"), "why does the preview lose alpha");
  assert.equal(askedQuestion(`@${SLUG} ask: is this in scope?`, { slug: SLUG }), "is this in scope?");
  for (const text of ["ask author", "ask the author to wire the group editor in", "ask-author", "ask", "why does the preview lose alpha?", "merge"]) assert.equal(askedQuestion(text), null, text);
  assert.equal(parse("ask the author to wire the group editor in").kind, "commands");
  assert.equal(parse("merge").kind, "commands");
  assert.equal(parse("why does the preview lose alpha?").kind, "ambiguous", "a bare question is left to the model reading");
  assert.equal(commentQuestion(`Thanks!\n@${SLUG} ask does the export\nkeep 16-bit depth?`, SLUG), "does the export\nkeep 16-bit depth?");
});

test("a maintainer's @app ask queues a call bound to their Task Runner and the answer is posted as a reply when it returns", async () => {
  const w = await newRepo();
  const db = w.db;
  await w.pr(1);
  await setEnabled(db, true, "test");
  await db.run(db.k.insertInto("main.access").values({ login: "maint", role: "maintainer", github_id: 202 }));
  const ANSWER = "The preview encoder converts to RGB before it writes the PNG.";
  const runner = await fakeTaskRunner(db, (call) => (call.promptId === "conversation.turn" ? ANSWER : undefined), "maint", "maintainer");
  try {
    await comment(w, `@${SLUG} ask why does the preview lose the alpha channel`, { login: "maint", id: 202 });
    await drain(w);
    const [asked] = await commands(w);
    assert.equal(asked?.state, "asked", asked?.result ?? "");
    assert.equal(asked?.reply, "none", "nothing is posted before the answer");

    await answerPending(db, { kind: "maintainer", checkout: async () => null, usageRun: "t", log: () => {} });
    const call = await db.get(db.k.selectFrom("main.remote_calls").select(["prompt_id", "for_login"]).where("prompt_id", "=", "conversation.turn"));
    assert.equal(call?.for_login, "maint", "the call runs only on the asker's own Task Runner");

    const posted: string[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      if (cmd === "gh" && args.includes("comment")) { posted.push(String(opts?.input ?? "")); return { code: 0, stdout: "https://github.com/storytold/app/pull/1#issuecomment-1\n", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    };
    await drainCommands(db, { querier: w.gh.querier, permission: async () => PERM.write, slug: SLUG, exec, mint: async () => "token" });
    assert.equal(posted.length, 1);
    assert.ok(posted[0]!.includes("@maint") && posted[0]!.includes(ANSWER), posted[0]);
    const [done] = await commands(w);
    assert.equal(done?.state, "done");
    assert.equal(done?.reply, "posted");
  } finally {
    await runner.stop();
  }
});
