// @AutoCraft commands in a channel: a reply to a message that names items acts on all of them or on the one named, answers in a
// thread, a sender with no linked login runs nothing, and `ask <question>` is answered by Opus on the asker's own Task Runner as a
// reply to the question.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AtCommands } from "../src/discord/at-commands.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { createLinkCode, redeemLinkCode } from "../src/discord/links.ts";
import { Pings } from "../src/discord/pings.ts";
import type { CommandDef, DiscordRest, EditBody, MessageBody } from "../src/discord/rest.ts";
import type { Search } from "../src/discord/search.ts";
import { handleDispatch } from "../src/discord/store.ts";
import { followOf, threadTarget } from "../src/discord/threads.ts";
import { DiscordAnswers } from "../src/discord/answers.ts";
import { answerPending } from "../src/conversations/run.ts";
import { setUserInteractiveSlots } from "../src/remote/interactive-slots.ts";
import { setEnabled } from "../src/runner/autopilot.ts";
import { fakeTaskRunner } from "./fake-runner.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-at-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

class FakeRest implements DiscordRest {
  sent: { channelId: string; body: MessageBody }[] = [];
  threads: { channelId: string; messageId: string; name: string; id: string }[] = [];
  async createMessage(channelId: string, body: MessageBody) { this.sent.push({ channelId, body }); return { id: `r${this.sent.length}` }; }
  async startThread(channelId: string, messageId: string, name: string) { const id = `t${this.threads.length + 1}`; this.threads.push({ channelId, messageId, name, id }); return { id }; }
  async editMessage() {}
  async deleteMessage() {}
  async interactionCallback() {}
  async editInteractionResponse(_a: string, _t: string, _b: EditBody) {}
  async overwriteGuildCommands(_a: string, _g: string, _c: CommandDef[]) {}
}

const rest = new FakeRest();
const pings = new Pings({ db, keys, rest, search: {} as Search, log: (l) => assert.fail(l), commands: new AtCommands({ db, keys, rest, log: (l) => assert.fail(l) }) });
const say = async (id: string, user: string, content: string, repliesTo?: { id: string; author: string }) => {
  const m = {
    id, channel_id: "c1", guild_id: "g1", content, type: repliesTo ? 19 : 0, author: { id: user },
    ...(repliesTo ? { message_reference: { message_id: repliesTo.id }, referenced_message: { author: { id: repliesTo.author } } } : {}),
  };
  await handleDispatch(db, keys, "MESSAGE_CREATE", m);
  await pings.dispatch("MESSAGE_CREATE", m);
  await pings.idle();
};
const started = async (): Promise<string[]> =>
  (await db.all(db.k.selectFrom("main.item_workflows").select(["repo", "number"]))).map((r) => `${r.repo}#${r.number}`).sort();

before(async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", owner: "storytold", visibility: "public" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("discord_channels").values([{ channel_id: "c1", guild_id: "g1", guild_name: "G", name: "dev", watched: 1 }]));
  for (const n of [4, 7]) {
    await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: n, kind: "pr", state: "OPEN", title: `Fix ${n}`, body: "", url: `https://github.com/storytold/photocraft/pull/${n}` }));
  }
  await db.run(db.k.insertInto("main.access").values({ login: "nora", role: "maintainer" }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: "nora", repo: "photocraft", permission: "write", checked_at: new Date().toISOString() }));
  const { code } = await createLinkCode(db, keys, "nora");
  assert.equal(await redeemLinkCode(db, keys, code, "u70"), "nora");
  await pings.dispatch("READY", { user: { id: "100" } });
  await say("m1", "u2", "both of these: photocraft#4 and photocraft#7");
});

test("a reply to a message that names items runs on the one named, then on all of them, and answers in a thread", async () => {
  await say("c-one", "u70", "<@100> review photocraft#7", { id: "m1", author: "u2" });
  assert.deepEqual(await started(), ["photocraft#7"]);
  assert.equal(rest.threads.at(-1)!.messageId, "c-one");
  assert.match(rest.threads.at(-1)!.name, /^review · photocraft#7$/);

  await say("c-all", "u70", "<@100> review all", { id: "m1", author: "u2" });
  assert.deepEqual(await started(), ["photocraft#4", "photocraft#7"]);
  const thread = rest.threads.at(-1)!;
  assert.equal(thread.messageId, "c-all");
  // The confirmation lines go into the thread, mention nobody, and the thread follows the items that ran.
  const posted = rest.sent.filter((s) => s.channelId === thread.id);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0]!.body.allowed_mentions, { parse: [] });
  assert.ok((await followOf(db, keys, threadTarget(keys, thread.id)))!.items.some((i) => i.number === 4));
  // The command is a message in each item's chat, linked to the event it wrote, and keyed so the chat leaves out its mention line.
  const said = await db.all(db.k.selectFrom("main.chat_messages as m").innerJoin("main.chat_conversations as c", "c.id", "m.conversation_id")
    .select(["c.number", "m.author", "m.via", "m.body", "m.payload", "m.workflow_event_id"]).where("m.body", "=", "review all"));
  assert.deepEqual(said.map((m) => Number(m.number)).sort(), [4, 7]);
  for (const m of said) {
    assert.equal(m.author, "nora");
    assert.equal(m.via, "discord");
    assert.ok(m.workflow_event_id);
    assert.equal(JSON.parse(String(m.payload)).msgHash, keys.hash("message", "c-all"));
  }
});

test("a sender with no linked login gets one short reply and nothing runs", async () => {
  const before = await started();
  const sent = rest.sent.length;
  await say("u-1", "u99", "<@100> merge photocraft#4");
  await say("u-2", "u99", "<@100> merge photocraft#4");
  assert.deepEqual(await started(), before);
  assert.equal(rest.sent.length, sent + 1);
  assert.match(rest.sent.at(-1)!.body.content!, /\/autocraft account action:link/);
});

test("an item of a private repo shows a status line and its link, never the recommendation", async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "hidden" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([{ name: "hidden", owner: "storytold", visibility: "private" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("items").values({ repo: "hidden", number: 3, kind: "pr", state: "OPEN", title: "Fix 3", body: "", url: "https://github.com/storytold/hidden/pull/3" }));
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: "nora", repo: "hidden", permission: "write", checked_at: new Date().toISOString() }));
  const at = new Date().toISOString();
  const rec = JSON.stringify({ text: "SECRETPLAN rewrite the vault code.", parts: { fix: [1], drop: [] }, merges: false });
  await db.run(db.k.insertInto("item_workflows").values({ repo: "hidden", number: 3, kind: "pr", entry: "review", weight: 5, state: "recommending", started_by: "nora", started_at: at, started_via: "github", plan: "[]", rec, rec_at: at, rec_head: "sha1", updated_at: at } as never));
  const sent = rest.sent.length;
  await say("p-1", "u70", "<@100> merge hidden#3");
  const posted = rest.sent.slice(sent).map((s) => s.body.content ?? "").join("\n");
  assert.ok(posted.includes("hidden#3"), posted);
  assert.ok(posted.includes("https://github.com/storytold/hidden/pull/3"), posted);
  assert.ok(!posted.includes("SECRETPLAN"), posted);
});

test("text that starts with a command word but reads as ambiguous goes to search, not the link refusal", async () => {
  const sent = rest.sent.length;
  const searched: string[] = [];
  const own = new Pings({ db, keys, rest, search: { allow: () => true, find: async (q: string) => { searched.push(q); return { matches: [] }; } } as unknown as Search, log: () => {}, commands: new AtCommands({ db, keys, rest, log: () => {} }) });
  await own.dispatch("READY", { user: { id: "100" } });
  const m = { id: "s-1", channel_id: "c1", guild_id: "g1", content: "<@100> stop button does nothing on the export panel", type: 0, author: { id: "u99" } };
  await handleDispatch(db, keys, "MESSAGE_CREATE", m);
  await own.dispatch("MESSAGE_CREATE", m);
  await own.idle();
  assert.equal(searched.length, 1);
  assert.ok(!rest.sent.slice(sent).some((s) => /\/autocraft account action:link/.test(s.body.content ?? "")));
});

test("a replayed message runs its command once", async () => {
  const sent = rest.sent.length;
  await say("dup-1", "u70", "<@100> review photocraft#4");
  const first = rest.sent.length;
  assert.ok(first > sent);
  await say("dup-1", "u70", "<@100> review photocraft#4");
  assert.equal(rest.sent.length, first);
});

test("a write permission cached over a minute ago is read again through the GitHub App, which decides", async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "texturecraft" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([{ name: "texturecraft", owner: "storytold", visibility: "public" }]).onConflict((oc) => oc.doNothing()));
  for (const n of [1, 2]) {
    await db.run(db.k.insertInto("items").values({ repo: "texturecraft", number: n, kind: "pr", state: "OPEN", title: `Fix ${n}`, body: "", url: `https://github.com/storytold/texturecraft/pull/${n}` }));
  }
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: "nora", repo: "texturecraft", permission: "admin", checked_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
  let answer = "admin";
  const asked: string[] = [];
  const own = new Pings({ db, keys, rest, search: {} as Search, log: (l) => assert.fail(l), commands: new AtCommands({ db, keys, rest, log: (l) => assert.fail(l), permission: async (_d, login, repo) => { asked.push(`${login} ${repo}`); return { kind: "ok", permission: answer }; } }) });
  await own.dispatch("READY", { user: { id: "100" } });
  const send = async (id: string, content: string) => {
    const m = { id, channel_id: "c1", guild_id: "g1", content, type: 0, author: { id: "u70" } };
    await handleDispatch(db, keys, "MESSAGE_CREATE", m);
    await own.dispatch("MESSAGE_CREATE", m);
    await own.idle();
  };
  await send("w-1", "<@100> review texturecraft#1");
  assert.ok(asked.length > 0, "the stale row is not trusted");
  assert.ok((await started()).includes("texturecraft#1"));

  answer = "read";
  const sent = rest.sent.length;
  await send("w-2", "<@100> review texturecraft#2");
  assert.ok(!(await started()).includes("texturecraft#2"));
  assert.match(rest.sent.slice(sent).map((s) => s.body.content ?? "").join("\n"), /no write access to texturecraft/);
});

test("`status` in reply to a message that links a pull request answers with that pull request only, not search results", async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "texturecraft" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([{ name: "texturecraft", owner: "storytold", visibility: "public" }]).onConflict((oc) => oc.doNothing()));
  for (const n of [763, 764, 765, 775]) {
    await db.run(db.k.insertInto("items").values({ repo: "texturecraft", number: n, kind: "pr", state: n === 775 ? "OPEN" : "MERGED", title: `Change ${n}`, body: "", url: `https://github.com/storytold/texturecraft/pull/${n}` }));
  }
  const merged = [763, 764, 765].map((n) => ({ repo: "texturecraft", number: n, title: `Change ${n}`, url: `https://github.com/storytold/texturecraft/pull/${n}`, closed: true, pr: true, merged: true }));
  const own = new Pings({ db, keys, rest, search: { allow: () => true, find: async () => ({ matches: merged }) } as unknown as Search, log: (l) => assert.fail(l), commands: new AtCommands({ db, keys, rest, log: (l) => assert.fail(l) }) });
  await own.dispatch("READY", { user: { id: "100" } });
  const quoted = { id: "tx-q", channel_id: "c1", guild_id: "g1", type: 0, author: { id: "u2" }, content: "…I pushed the coderabbit response, needs your final merge. https://github.com/storytold/texturecraft/pull/775" };
  await handleDispatch(db, keys, "MESSAGE_CREATE", quoted);
  const m = { id: "tx-s", channel_id: "c1", guild_id: "g1", type: 19, author: { id: "u5" }, content: "<@100> status", message_reference: { message_id: quoted.id }, referenced_message: { author: quoted.author, content: quoted.content } };
  await handleDispatch(db, keys, "MESSAGE_CREATE", m);
  const sent = rest.sent.length;
  await own.dispatch("MESSAGE_CREATE", m);
  await own.idle();
  const answers = rest.sent.slice(sent);
  assert.equal(answers.length, 1);
  const shown = JSON.stringify(answers[0]!.body);
  assert.ok(shown.includes("texturecraft#775"), shown);
  assert.ok(![763, 764, 765].some((n) => shown.includes(`#${n}`)), shown);
});

test("`fix and merge <item>` to the bot's role starts the fix-up with the merge approved, as it does to the bot", async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "texturecraft" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([{ name: "texturecraft", owner: "storytold", visibility: "public" }]).onConflict((oc) => oc.doNothing()));
  for (const n of [850, 851]) {
    await db.run(db.k.insertInto("items").values({ repo: "texturecraft", number: n, kind: "pr", state: "OPEN", title: `Change ${n}`, body: "", head_oid: `sha${n}`, url: `https://github.com/storytold/texturecraft/pull/${n}` }));
  }
  // No Task Runner reads the text: the parser alone must read it.
  const own = new Pings({ db, keys, rest, search: {} as Search, log: (l) => assert.fail(l), commands: new AtCommands({ db, keys, rest, log: (l) => assert.fail(l), read: { translate: async () => null }, permission: async () => ({ kind: "ok", permission: "write" }) }) });
  await own.dispatch("READY", { user: { id: "100" } });
  await own.dispatch("GUILD_CREATE", { id: "g1", roles: [{ id: "1569325571970965618", tags: { bot_id: "100" } }] });
  const outcome: string[] = [];
  for (const [id, n, content] of [["fm-role", 850, "<@&1569325571970965618> fix and merge texturecraft#850"], ["fm-user", 851, "<@100> fix and merge texturecraft#851"]] as const) {
    const m = { id, channel_id: "c1", guild_id: "g1", content, type: 0, author: { id: "u70" } };
    await handleDispatch(db, keys, "MESSAGE_CREATE", m);
    const sent = rest.sent.length;
    await own.dispatch("MESSAGE_CREATE", m);
    await own.idle();
    const wf = await db.get(db.k.selectFrom("main.item_workflows").select(["entry", "approved_by"]).where("repo", "=", "texturecraft").where("number", "=", n));
    const reply = rest.sent.slice(sent).map((s) => s.body.content ?? "").join("\n").replaceAll(String(n), "N");
    outcome.push(JSON.stringify([wf?.entry, wf?.approved_by, reply]));
  }
  assert.deepEqual(JSON.parse(outcome[0]!).slice(0, 2), ["fixup", "nora"]);
  assert.equal(outcome[1], outcome[0]);
});

test("a maintainer's @AutoCraft ask queues an Interactive call bound to their Task Runner and the answer replies to the question", async () => {
  await setEnabled(db, true, "test");
  await setUserInteractiveSlots(db, "nora", "maintainer", 1);
  const ANSWER = "The preview encoder converts to RGB before it writes the PNG.";
  const runner = await fakeTaskRunner(db, (call) => (call.promptId === "interactive.conversation-turn" ? ANSWER : undefined), "nora", "maintainer");
  try {
    const sent = rest.sent.length;
    await say("q-1", "u70", "<@100> ask photocraft#4 why does the preview lose the alpha channel");
    const ack = rest.sent.slice(sent);
    assert.equal(ack.length, 1);
    assert.equal(ack[0]!.body.message_reference?.message_id, "q-1");
    assert.match(ack[0]!.body.content ?? "", /Asked Opus/);
    assert.ok(!rest.threads.some((th) => th.messageId === "q-1"), "a question starts no thread");

    await answerPending(db, { kind: "maintainer", checkout: async () => null, usageRun: "t", log: () => {} });
    const call = await db.get(db.k.selectFrom("main.remote_calls").select(["prompt_id", "for_login"]).where("prompt_id", "like", "%conversation%"));
    assert.equal(call?.prompt_id, "interactive.conversation-turn", "a Discord question takes Interactive slots");
    assert.equal(call?.for_login, "nora", "it runs only on the asker's own Task Runner");

    const answers = new DiscordAnswers({ db, keys, rest, log: (l) => assert.fail(l) });
    await answers.sync();
    await answers.sync();
    const posted = rest.sent.slice(sent + 1);
    assert.equal(posted.length, 1, "the answer is posted once");
    assert.equal(posted[0]!.channelId, "c1");
    assert.equal(posted[0]!.body.message_reference?.message_id, "q-1");
    assert.ok(posted[0]!.body.content?.includes(ANSWER), posted[0]!.body.content ?? "");
    assert.deepEqual(posted[0]!.body.allowed_mentions, { parse: [] });
  } finally {
    await runner.stop();
  }
});
