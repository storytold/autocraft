// Opus conversations: card validation, Do it runs once (commands through the workflow, comments and labels through fake writers), and
// viewers cannot write. GitHub is a fake querier.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import { setApproval as setLabelApproval } from "../src/labels/approval.ts";
import { applicableSteps, cleanComment, headline, isRegistry, loadCardFacts, parseReply, type NewCard } from "../src/conversations/cards.ts";
import { cardOf, doCard } from "../src/conversations/act.ts";
import { addMessage, claimPending, ConversationError, ensureConversation, insertTurn, loadStale, refreshItem, turnsOf } from "../src/conversations/store.ts";
import { answerPending } from "../src/conversations/run.ts";
import { cleanReason } from "../src/act/templates.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import * as conv from "../src/dash/api/conversations.ts";
import { postChat, postChatWithdraw } from "../src/dash/api/item-chat.ts";
import { HttpError } from "../src/dash/server/util.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { allocation } from "../src/agents/call.ts";
import { setEnabled } from "../src/runner/autopilot.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const quiet = () => {};
const T0 = "2026-01-01T00:00:00Z";

async function fresh(): Promise<Db> {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "conv-test-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  const item = async (number: number, kind: string, title: string, head_oid: string | null) =>
    await db.run(db.k.insertInto("items").values({ repo: "app", number, kind, state: "OPEN", title, body: "Body text", author: "someone", head_oid, created_at: T0, updated_at: T0, labels: "[]" }));
  await item(1, "issue", "Issue 1", null);
  await item(2, "pr", "PR 2", "sha2");
  await item(3, "issue", "Issue 3", null);
  await setCommentApproval(db, "op", "app", true);
  return db;
}

describe("cards", () => {
  test("comment text loses entities that hide mentions, HTML, images and links", () => {
    assert.equal(cleanComment("Thanks &#64;bob and &commat;amy and &amp;#x40;cy"), "Thanks bob and amy and cy");
    assert.equal(cleanComment("See [the docs](https://x.test/a) <b>now</b> ![img](https://x.test/i.png) https://y.test/z"), "See the docs now");
    assert.equal(cleanComment("Line one\n\n\n\nLine two @team"), "Line one\n\nLine two team");
  });






  const block = (cards: unknown[]) => `Text.\n\`\`\`actions\n${JSON.stringify(cards)}\n\`\`\``;
  const R = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ kind: "resolution", steps, ...extra });
  /** What each card is: its command, its label, or "comment". */
  const kinds = (cards: NewCard[]) => cards.map(({ params: p }) => (p.kind === "command" ? (isRegistry(p.command) ? p.command.text : p.command.word) : p.kind === "label" ? `${p.remove ? "-" : "+"}${p.label}` : "comment"));

  test("each step becomes its own card; invalid steps drop the resolution with a note", async () => {
    const db = await fresh();
    const p = (await parseReply(db, "app", 2, block([
      { kind: "delete-everything" },
      R([{ kind: "label", label: "my own label" }]),
      R([{ kind: "command", text: "merge and file an issue" }]),
      R([{ kind: "command", text: "implement" }]),
      R([{ kind: "command", text: "merge: app#3" }]),
      R([{ kind: "command", text: "drop 2" }]),
      R([{ kind: "comment" }, { kind: "label", label: "Plugin Candidate" }, { kind: "command", text: "fix-up and merge, high" }], { text: "Thanks @bob, see the pack." }),
      R([{ kind: "comment" }, { kind: "comment" }], { text: "Twice." }),
      R([{ kind: "comment" }], { text: "" }),
      R([{ kind: "command", text: "close" }, { kind: "comment" }], { text: "Done." }),
      R([{ kind: "duplicate", of: 99 }]),
    ])))!;
    assert.deepEqual(kinds(p.cards), ["comment", "+plugin candidate", "fix-up, merge, high", "comment", "close"]);
    assert.equal(p.cards[0]!.text, "Thanks bob, see the pack.");
    assert.equal(p.notes.length, 9);
    assert.equal(await parseReply(db, "app", 1, "```actions\n[]\n```"), null, "no text, no reply");
    assert.equal((await parseReply(db, "app", 1, "Hi\n```actions\nnot json\n```"))!.notes.length, 1);
  });

  test("the steps of earlier replies map to commands; a duplicate close names the original", async () => {
    const db = await fresh();
    const of = async (n: number, card: unknown) => kinds((await parseReply(db, "app", n, block([card])))!.cards);
    assert.deepEqual(await of(2, R([{ kind: "fixup", instructions: "Rename it.", merge: true }])), ["fix-up, merge"]);
    assert.deepEqual(await of(2, R([], { settle: { kind: "answer", option: "merge" } })), ["merge"]);
    assert.deepEqual(await of(1, R([], { settle: { kind: "backlog" } })), ["backlog"]);
    assert.deepEqual(await of(1, R([{ kind: "close", reason: "completed" }])), ["close as completed"]);
    assert.deepEqual(await of(1, R([{ kind: "review" }])), ["review"], "an issue is reviewed through the issue review");
    assert.deepEqual(await of(1, R([{ kind: "assign", login: "someone" }])), ["assign"]);
    const dup = (await parseReply(db, "app", 1, block([R([{ kind: "comment" }, { kind: "duplicate", of: 3 }], { text: "Thanks." })])))!.cards;
    assert.deepEqual(kinds(dup), ["comment", "close as duplicate of #3"]);
    assert.equal(dup[0]!.text, "Thanks.", "the close posts the line that names the original");
    assert.equal(headline(dup[1]!.params), "Close as duplicate of #3");
    assert.deepEqual(await of(1, R([{ kind: "command", text: "close as duplicate of #3" }])), ["close as duplicate of #3"]);
    assert.deepEqual(await of(1, R([{ kind: "command", text: "close as duplicate of #99" }])), [], "not in the mirror");
    assert.deepEqual(await of(1, R([{ kind: "command", text: "close as duplicate of #1" }])), [], "itself");
  });

  test("an issue is held for the merge only by a command that merges", async () => {
    const db = await fresh();
    await db.run(db.k.insertInto("tracked_repos").values({ name: "lib", added_by: "op", added_at: T0, pipeline: 1 }));
    const issue = { kind: "open_issue", repo: "lib", title: "Follow up", body: "Check the edge case." };
    const [held] = (await parseReply(db, "app", 2, block([R([issue, { kind: "command", text: "merge" }])])))!.cards;
    assert.equal(held!.params.kind === "command" && isRegistry(held!.params.command) && held!.params.command.followups?.[0]?.repo, "lib");
    assert.match(held!.description, /After the merge: open an issue in lib/);
    assert.deepEqual(kinds((await parseReply(db, "app", 2, block([R([issue, { kind: "command", text: "review" }])])))!.cards), ["review", "open_issue"]);
  });

  test("a quiet pull request gets no card that posts model-written text", async () => {
    const db = await fresh();
    const reply = block([R([{ kind: "label", label: "bugfix" }]), R([{ kind: "comment" }], { text: "Which version?" })]);
    assert.deepEqual(kinds((await parseReply(db, "app", 2, reply))!.cards), ["+bugfix", "comment"]);
    await db.run(db.k.insertInto("security_scans").values({ id: 900, repo: "app", state: "done", started_by: "op", started_at: T0 }));
    await db.run(db.k.insertInto("security_findings").values({ repo: "app", number: 900, scan_id: 900, area: "a", title: "t", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "fp900", fix_pr: 2, created_at: T0, updated_at: T0 }));
    const p = (await parseReply(db, "app", 2, reply))!;
    assert.deepEqual(kinds(p.cards), ["+bugfix"]);
    assert.equal(p.notes.length, 1);
    assert.ok(!applicableSteps(await loadCardFacts(db, "app", 2)).some((k) => k === "comment" || k === "open_issue"));
  });

  test("the steps that apply follow the item, and a message repeats them when they changed", async () => {
    const db = await fresh();
    const steps = async (n: number) => applicableSteps(await loadCardFacts(db, "app", n));
    assert.ok((await steps(2)).includes("request_reviewers") && !(await steps(3)).includes("request_reviewers"));
    assert.ok((await steps(3)).includes("transfer") && !(await steps(2)).includes("transfer"));
    await ensureConversation(db, "app", 3, "op");
    await addMessage(db, "app", 3, { login: "op", kind: "operator" }, "Same steps", undefined, false);
    assert.ok(!(await turnsOf(db, "app", 3)).at(-1)!.block.includes("<steps>"));
    await db.run(db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app").where("number", "=", 3));
    await addMessage(db, "app", 3, { login: "op", kind: "operator" }, "Now?", undefined, false);
    assert.ok((await turnsOf(db, "app", 3)).at(-1)!.block.includes('"reopen"'));
    assert.ok((await turnsOf(db, "app", 3)).at(-2)!.body.includes("(state)"), "the change comes before the message");
  });
});

describe("Do it", () => {
  const github = (failLabel = false) => {
    const sent: string[] = [];
    const querier = { query: async (q: string) => {
      sent.push(q.includes("addComment") ? "comment" : q.includes("addLabelsToLabelable") ? "label" : q.includes("issueOrPullRequest") ? "read" : "other");
      if (q.includes("issueOrPullRequest")) return { repository: { issueOrPullRequest: { __typename: "Issue", id: "I_1", state: "OPEN" } } };
      if (q.includes("addComment")) return { addComment: { commentEdge: { node: { url: "https://x.test/c" } } } };
      if (q.includes("repository(")) return { repository: { id: "R_1", l0: { id: "L_1", name: "bugfix" }, l1: null } };
      if (failLabel) throw new Error("label add failed");
      return { m0: { clientMutationId: null } };
    } };
    return { sent, querier };
  };

  /** Stores an Opus turn with the one card of `steps` (as a reply would) and returns the card's id. */
  const propose = async (db: Db, n: number, steps: unknown[], text?: string) => {
    await ensureConversation(db, "app", n, "op");
    const p = (await parseReply(db, "app", n, `Text.\n\`\`\`actions\n${JSON.stringify([{ kind: "resolution", steps, ...(text && { text }) }])}\n\`\`\``))!;
    assert.equal(p.cards.length, 1, p.notes.join("; "));
    const turn = await insertTurn(db, "app", n, { kind: "opus", login: "opus", body: "Text.", block: "x", cards: p.cards });
    return Number((await db.get(db.k.selectFrom("conversation_cards").select("id").where("turn_id", "=", turn)))!.id);
  };
  const stateOf = async (db: Db, id: number) => (await db.get(db.k.selectFrom("conversation_cards").select("state").where("id", "=", id)))!.state;
  const lastTurn = async (db: Db, n: number) => (await turnsOf(db, "app", n)).at(-1)!;
  /** The app identity, so commands run as the person, and a maintainer. */
  const commandsRun = async (db: Db) => {
    await db.run(db.k.insertInto("settings").values({ key: "github_identity", value: "app" }));
    await db.run(db.k.insertInto("access").values({ login: "mira", role: "maintainer" }));
  };

  test("a comment and a label go through the GitHub writer, with the note on the thread; a failure is stored on the card", async () => {
    const db = await fresh();
    await setLabelApproval(db, "op", "app", true);
    const g = github();
    const done = (await doCard(db, await propose(db, 1, [{ kind: "comment" }], "Thanks."), "op", { querier: g.querier as never, note: "Because of the pack" })).card;
    assert.equal(done.state, "done", done.error ?? "");
    const turn = await lastTurn(db, 1);
    assert.ok(turn.body.endsWith("Note: Because of the pack") && turn.block.includes("Thanks."));
    assert.equal((await doCard(db, await propose(db, 1, [{ kind: "label", label: "bugfix" }]), "op", { querier: g.querier as never })).card.state, "done");
    assert.deepEqual(g.sent.filter((x) => x === "comment" || x === "label"), ["comment", "label"]);
    const failed = (await doCard(db, await propose(db, 1, [{ kind: "label", label: "bugfix" }]), "op", { querier: github(true).querier as never })).card;
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /label add failed/);
  });

  test("a command card runs the command as the presser; one the workflow refuses stays proposed", async () => {
    const db = await fresh();
    const id = await propose(db, 2, [{ kind: "command", text: "review, high" }]);
    await assert.rejects(() => doCard(db, id, "mira", { canWrite: async () => true }), (e) => e instanceof ConversationError && e.status === 409);
    assert.equal(await stateOf(db, id), "proposed");
    await commandsRun(db);
    const r = await doCard(db, id, "mira", { canWrite: async () => true });
    assert.equal(r.card.state, "done", r.card.error ?? "");
    const w = (await db.get(db.k.selectFrom("item_workflows").select(["entry", "started_by", "started_via", "weight"]).where("number", "=", 2)))!;
    assert.deepEqual({ ...w }, { entry: "review", started_by: "mira", started_via: "dashboard", weight: 8 });
    assert.equal((await doCard(db, id, "mira", { canWrite: async () => true })).ran, false, "a second press does nothing");
    assert.match((await lastTurn(db, 2)).body, /^mira ran the card/);
  });

  test("a command that names parts refuses once another recommendation is open", async () => {
    const db = await fresh();
    await commandsRun(db);
    const plan = JSON.stringify([{ n: 1, title: "Off by one", source: "review", state: "planned" }, { n: 2, title: "Naming", source: "review", state: "planned" }]);
    const rec = JSON.stringify({ text: "Fix both.", parts: { fix: [1, 2], drop: [] }, merges: false });
    await db.run(db.k.insertInto("item_workflows").values({ repo: "app", number: 2, kind: "pr", entry: "review", weight: 5, state: "recommending", started_by: "mira", started_at: T0, started_via: "github", plan, rec, rec_at: T0, rec_head: "sha2", updated_at: T0 } as never));
    const id = await propose(db, 2, [{ kind: "command", text: "drop 2" }]);
    const shown = async () => await conv.cardView(db, (await cardOf(db, id))!);
    assert.deepEqual([(await shown()).command, (await shown()).refusal], ["drop 2", undefined]);
    await db.run(db.k.updateTable("item_workflows").set({ rec_at: "2026-01-02T00:00:00Z" }));
    assert.match((await shown()).refusal ?? "", /plan changed/);
    await assert.rejects(() => doCard(db, id, "mira", { canWrite: async () => true }), /plan changed/);
    assert.equal(await stateOf(db, id), "proposed");
  });

  test("the GitHub actions without a command run through the writer as the presser", async () => {
    const db = await fresh();
    await db.run(db.k.insertInto("tracked_repos").values({ name: "lib", added_by: "op", added_at: T0, pipeline: 1 }));
    await setCommentApproval(db, "op", "lib", true);
    await db.run(db.k.insertInto("items").values({ repo: "app", number: 4, kind: "issue", state: "CLOSED", title: "Issue 4", author: "someone", created_at: T0, updated_at: T0, labels: "[]" }));
    await db.run(db.k.insertInto("repo_permissions").values({ login: "rev", repo: "app", permission: "write", checked_at: T0 } as never));
    const sent: [string, Record<string, unknown>][] = [];
    let permission = "WRITE";
    const querier = { query: async (q: string, v: Record<string, unknown>) => {
      const m = /(addAssignees|reopenIssue|transferIssue|requestReviews)/.exec(q);
      if (m) { sent.push([m[1]!, v]); return m[1] === "transferIssue" ? { transferIssue: { issue: { url: "https://x.test/lib/9", number: 9 } } } : {}; }
      if (q.includes("collaborators")) return { repository: { collaborators: { edges: [{ permission, node: { login: v.login } }] } } };
      if (q.includes("issueOrPullRequest")) return { repository: { issueOrPullRequest: v.n === 2 ? { __typename: "PullRequest", id: "P_2", state: "OPEN", headRefOid: "sha2" } : { __typename: "Issue", id: `I_${v.n}`, state: v.n === 4 ? "CLOSED" : "OPEN" } } };
      if (q.includes("user(login")) return { user: { id: `U_${v.login}`, login: v.login } };
      if (q.includes("repository(")) return { repository: { id: `R_${v.name}` } };
      throw new Error(`unexpected query ${q}`);
    } };
    const gh: string[][] = [];
    const exec = async (_cmd: string, args: readonly string[]) => { gh.push([...args]); return { code: 0, stdout: "https://github.com/storytold/lib/issues/12\n", stderr: "" }; };
    const press = async (n: number, steps: unknown[]) => (await doCard(db, await propose(db, n, steps), "op", { querier: querier as never, exec: exec as never })).card;
    const ok = async (n: number, step: unknown) => { const c = await press(n, [step]); assert.equal(c.state, "done", c.error ?? ""); return c; };
    await ok(1, { kind: "assign", login: "someone" });
    await ok(2, { kind: "request_reviewers", logins: ["rev"] });
    await ok(4, { kind: "reopen" });
    assert.equal((await ok(3, { kind: "transfer", to: "lib" })).result_url, "https://x.test/lib/9");
    const opened = await ok(1, { kind: "open_issue", repo: "lib", title: "Split out", body: "The second half." });
    assert.match(opened.result ?? "", /Opened lib#12/);
    assert.deepEqual(sent.map(([m, v]) => [m, v.id, v.user ?? v.users ?? v.repo ?? null]), [
      ["addAssignees", "I_1", "U_someone"], ["requestReviews", "P_2", ["U_rev"]], ["reopenIssue", "I_4", null], ["transferIssue", "I_3", "R_lib"],
    ]);
    assert.ok(gh.length > 0);
    const audited = await db.all(db.k.selectFrom("audit").select(["login", "action"]).where("action", "in", ["assign", "act-request-reviewers", "act-reopen", "act-transfer", "act-open-issue"]));
    assert.equal(audited.length, 5);
    assert.ok(audited.every((a) => a.login === "op"));
    // GitHub's answer now decides, not the cached permission; a repo not approved for comments refuses the press.
    permission = "READ";
    assert.match((await press(2, [{ kind: "request_reviewers", logins: ["rev"] }])).error ?? "", /does not have write access/);
    await setCommentApproval(db, "op", "lib", false);
    await assert.rejects(() => press(1, [{ kind: "open_issue", repo: "lib", title: "Another", body: "More." }]), /Comments in lib are not approved/);
  });

  test("a card of the retired decision system refuses and runs nothing", async () => {
    const db = await fresh();
    const old = Number((await db.get(db.k.insertInto("conversation_cards").values({ turn_id: 0, repo: "app", number: 1, kind: "answer", params: JSON.stringify({ kind: "answer", decision: "app#1:scope", option: "take" }), description: "answer" }).returning("id")))!.id);
    await assert.rejects(() => doCard(db, old, "op"), /question that no longer exists/);
    assert.equal((await conv.cardView(db, (await cardOf(db, old))!, { login: "op", role: "operator" })).canSettle, false);
  });

  test("a later reply replaces drafts, and a PR change refuses the cards that rest on the code", async () => {
    const db = await fresh();
    await setLabelApproval(db, "op", "app", true);
    const g = github();
    const ask = await propose(db, 3, [{ kind: "comment" }], "Which version?");
    await propose(db, 3, [{ kind: "comment" }], "Which OS?");
    await assert.rejects(() => doCard(db, ask, "op"), /replaced by a later reply/);
    assert.equal(await stateOf(db, ask), "replaced");

    const light = await propose(db, 2, [{ kind: "label", label: "bugfix" }]);
    await db.run(db.k.updateTable("items").set({ head_oid: "sha3" }).where("number", "=", 2));
    assert.equal((await doCard(db, light, "op", { querier: g.querier as never })).card.state, "done");
    for (const [steps, text] of [[[{ kind: "comment" }], "Thanks."], [[{ kind: "command", text: "merge" }], undefined]] as const) {
      await db.run(db.k.updateTable("items").set({ head_oid: "sha3" }).where("number", "=", 2));
      await refreshItem(db, "app", 2);
      const card = await propose(db, 2, [...steps], text);
      await db.run(db.k.updateTable("items").set({ head_oid: "sha4" }).where("number", "=", 2));
      await assert.rejects(() => doCard(db, card, "op", { querier: g.querier as never }), /PR changed since/);
      assert.equal((await conv.cardView(db, (await cardOf(db, card))!)).stale, "pr-changed");
    }
  });

  test("a card's buttons stay while a stored write permission has aged: reading the card reads it from GitHub, and an operator keeps them without an answer", async () => {
    const db = await fresh();
    const id = await propose(db, 1, [{ kind: "comment" }], "Which version?");
    await db.run(db.k.insertInto("settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
    const people = [["op", "operator"], ["maint", "maintainer"], ["out", "maintainer"], ["view", "viewer"]] as const;
    await db.run(db.k.insertInto("access").values(people.map(([login, role]) => ({ login, role }))).onConflict((oc) => oc.column("login").doNothing()));
    const age = async (at: string) => {
      for (const [login] of people)
        await db.run(db.k.insertInto("repo_permissions").values({ login, repo: "app", permission: "write", checked_at: at }).onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet({ permission: "write", checked_at: at })));
    };
    /** The person's GET, where GitHub answers `permission`, or nothing. */
    const settles = async (login: string, role: "operator" | "maintainer" | "viewer", permission: string | null) => {
      const canWrite = async (repo: string) => {
        if (permission !== null) await db.run(db.k.updateTable("repo_permissions").set({ permission, checked_at: new Date().toISOString() }).where("login", "=", login).where("repo", "=", repo));
        return permission === "write";
      };
      return (await conv.cardView(db, (await cardOf(db, id))!, { login, role, canWrite })).canSettle;
    };
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    await age(hourAgo);
    assert.equal(await settles("op", "operator", "write"), true);
    assert.equal(await settles("maint", "maintainer", "write"), true);
    assert.equal(await settles("out", "maintainer", "read"), false, "GitHub's answer decides");
    assert.equal(await settles("view", "viewer", "write"), false);
    await age(hourAgo);
    assert.equal(await settles("op", "operator", null), true);
    assert.equal(await settles("op", "operator", "read"), false);
  });
});

function req(role: "operator" | "viewer", params: Record<string, string>, json?: unknown): Req {
  return { method: "POST", path: "", params, query: new URLSearchParams(), form: new URLSearchParams(), json, csrf: "", nonce: "",
    user: { login: role === "operator" ? "op" : "view", role, canWrite: async () => role === "operator", canRead: async () => true } };
}

describe("access", () => {
  test("a viewer cannot write; no chat route is operator-only; a second question while Opus has not answered the first is refused", async () => {
    const db = await fresh();
    const say = (role: "operator" | "viewer", text: string) => postChat(db, req(role, { repo: "app", n: "1" }, { conversation: "main", text }));
    await assert.rejects(() => say("viewer", "Hi?"), (e) => e instanceof HttpError && e.status === 403);
    const writes = apiRoutes().filter((r) => r.method === "POST" && /\/chat/.test(r.pattern));
    assert.equal(writes.length, 2);
    // No route is operator-only: messages and withdrawals check who may write in the handler (refused for the viewer above).
    assert.deepEqual(writes.filter((r) => r.operator === true).map((r) => r.pattern), []);
    assert.deepEqual((await say("operator", "ask why")).lines, []);
    assert.equal((await say("operator", "ask again")).lines.length, 1, "the second question gets the refusal and asks nothing");
  });
});

describe("maintainers talk to Opus", () => {
  test("a maintainer asks Opus only with write access, with the pipeline on and a ready runner of theirs", async () => {
    const db = await fresh();
    const maint = (write: boolean, text: string): Req => ({ ...req("viewer", { repo: "app", n: "1" }, { conversation: "main", text }), user: { login: "maint", role: "maintainer", canWrite: async () => write, canRead: async () => true } });
    const refusal = async (write: boolean) => (await postChat(db, maint(write, "ask is this in scope"))).lines.join(" ");
    await assert.rejects(() => postChat(db, maint(false, "Hi?")), (e) => e instanceof HttpError && e.status === 403);
    assert.match(await refusal(true), /pipeline is off/);
    await setEnabled(db, true, "test");
    assert.match(await refusal(true), /Task Runner must be connected and ready/);
    const turns = await db.all(db.k.selectFrom("conversation_turns").select("id").where("number", "=", 1));
    assert.equal(turns.length, 0, "a refused question asks nothing");
  });
});

describe("maintainers' messages wait and are withdrawn", () => {
  test("a maintainer's message no runner of theirs took in time waits again, uncounted; they or an operator withdraw one, another maintainer cannot", async () => {
    const db = await fresh();
    await db.run(db.k.insertInto("access").values({ login: "maint", role: "maintainer" }));
    const token = (await createToken(db, "maint", "runner", { kind: "runner" })).row.id;
    await storeStatus(db, token, "maint", parseStatus({ slots: 2, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
    await addMessage(db, "app", 1, { login: "maint", kind: "maintainer" }, "Is this in scope?");
    const turn = async () => (await db.get(db.k.selectFrom("conversation_turns").select(["status", "error"]).where("number", "=", 1).where("kind", "=", "maintainer").orderBy("id", "desc").limit(1)))!;
    let handled = 0;
    const was = allocation.pollMs;
    allocation.pollMs = 10;
    try {
      assert.equal(await answerPending(db, { kind: "maintainer", ownWaitMs: 50, checkout: async () => null, usageRun: "t", log: quiet, onHandled: () => void handled++ }), 0);
    } finally {
      allocation.pollMs = was;
    }
    assert.equal((await turn()).status, "pending");
    assert.equal(handled, 0, "a message given back is no work done");
    const as = (login: string, role: "maintainer" | "operator"): Req => ({ ...req("viewer", { repo: "app", n: "1" }), user: { login, role, canWrite: async () => true, canRead: async () => true } });
    await assert.rejects(() => postChatWithdraw(db, as("someone", "maintainer")), (e) => e instanceof HttpError && e.status === 403);
    await postChatWithdraw(db, as("maint", "maintainer"));
    assert.match((await turn()).error ?? "", /withdrawn by maint/);
    await addMessage(db, "app", 1, { login: "maint", kind: "maintainer" }, "And now?");
    await postChatWithdraw(db, as("op", "operator"));
    assert.equal((await turn()).status, "failed");
    await assert.rejects(() => postChatWithdraw(db, as("op", "operator")), (e) => e instanceof HttpError && e.status === 409, "nothing waits any more");
  });

  test("withdrawing a turn that is being answered withdraws its model call", async () => {
    const db = await fresh();
    await db.run(db.k.insertInto("access").values({ login: "maint", role: "maintainer" }));
    await addMessage(db, "app", 1, { login: "maint", kind: "maintainer" }, "Is this in scope?");
    const { withdrawTurn } = await import("../src/conversations/store.ts");
    assert.ok(await claimPending(db, "app", 1));
    const call = (id: number, forLogin: string, number: number) => ({ id, step: "conversation", stage: 0, max_attempts: 1, timeout_ms: 1, prompt_id: "conversation.turn", prompt_version: "1", tier: "top", effort: "medium", asked_model: "opus", bundle: "{}", state: "leased", items: JSON.stringify([{ repo: "app", number }]), repo: "app", class: 0, level: 0, since: 1, seen_at: 1, for_login: forLogin });
    await db.run(db.k.insertInto("main.remote_calls").values([call(901, "Maint", 1), call(902, "other", 1), call(903, "maint", 2)] as never));
    await db.run(db.k.insertInto("main.remote_call_items").values([[901, 1], [902, 1], [903, 2]].map(([call_id, number]) => ({ call_id: call_id!, pos: 0, repo: "app", number: number! }))));
    await withdrawTurn(db, "app", 1, { login: "maint", operator: false });
    const state = async (id: number) => (await db.get(db.k.selectFrom("main.remote_calls").select("state").where("id", "=", id)))!.state;
    assert.equal(await state(901), "failed");
    assert.equal(await state(902), "leased", "another login's call is left");
    assert.equal(await state(903), "leased", "another item's call is left");
  });
});

describe("stale cards", () => {
  test("review bots and our own note-line posts do not make a card stale; a person's comment does", async () => {
    const db = await fresh();
    const add = async (id: string, at: string, author: string, body: string) =>
      await db.run(db.k.insertInto("comments").values({ repo: "app", number: 1, id, kind: "comment", author, created_at: at, body }));
    await add("c1", "2026-01-02T00:00:00Z", "alice", "first");
    const seen = JSON.stringify({ head: null, last_comment: "c1" });
    const stale = async () => (await loadStale(db, [{ id: 1, repo: "app", number: 1, seen }])).get(1);
    assert.equal(await stale(), undefined);
    await add("c2", "2026-01-02T01:00:00Z", "coderabbitai", "review summary");
    await add("c3", "2026-01-02T02:00:00Z", "alice", "_AI-generated review (Opus). Not a maintainer decision._\n\nLooks fine");
    await add("c4", "2026-01-02T03:00:00Z", "alice", "_Automated message. Not a maintainer decision._\n\nHello");
    assert.equal(await stale(), undefined);
    await add("c5", "2026-01-02T04:00:00Z", "bob", "what about X?");
    assert.equal(await stale(), "new-comments");
  });
});

describe("cleanReason", () => {
  test("cuts at a sentence end or a word boundary, never inside a word", () => {
    const long = "The change reworks the fonts toast and a Save As filename field in ways nobody asked for. It also touches the layout of the panel and renames several unrelated helper functions across the code base without tests";
    const a = cleanReason(long)!;
    assert.equal(a, "The change reworks the fonts toast and a Save As filename field in ways nobody asked for.");
    const b = cleanReason(long.replace(/\. /, ", "))!;
    assert.ok(b.length <= 200 && b.endsWith("…"), b);
    assert.ok(long.replace(/\. /, ", ").includes(b.slice(0, -1)));
    assert.match(long, new RegExp(`${b.slice(0, -1).split(" ").pop()}\\b`));
    assert.equal(cleanReason("short one"), "short one.");
  });
});

describe("card headline", () => {
  test("names the action with its key parameter", async () => {
    const of = (c: import("../src/conversations/cards.ts").Command) => headline({ kind: "command", command: c });
    assert.equal(of({ text: "close" }), "Close issue");
    assert.equal(of({ text: "close", pr: true }), "Close PR");
    assert.equal(of({ text: "close as duplicate of #12" }), "Close as duplicate of #12");
    assert.equal(of({ text: "close as not planned" }), "Close issue as not planned");
    assert.equal(of({ text: "fix 1, drop 2, merge" }), "fix 1, drop 2, merge");
    assert.equal(of({ word: "transfer", to: "storytold/x" }), "Move issue to storytold/x");
  });
});
