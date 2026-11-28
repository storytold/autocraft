// The Items browser's query: qualifiers combine, negation and sort apply, pages of one order never overlap, and hits by meaning keep their order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectDb } from "./helpers/raw-db.ts";
import { forReader, parseItemQuery, PRESETS } from "../src/core/item-query.ts";
import { countPresets, loadBrowsePage, loadFacets } from "../src/data/views/items-browse.ts";
import { loadAuthorCounts } from "../src/data/views/author-counts.ts";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const at = (h: number) => new Date(NOW - h * 3600_000).toISOString();

test("label, Discord and sort qualifiers combine, negation and paging hold, presets count", async () => {
  const db = await connectDb(":memory:");
  try {
    const item = (repo: string, number: number, o: Record<string, unknown> = {}) => ({
      repo, number, kind: "issue", state: "OPEN", title: `t${number}`, author: "ann", author_association: "MEMBER", labels: "[]", comments_count: 0, created_at: at(number), updated_at: at(number), ...o,
    });
    await db.run(db.k.insertInto("main.items").values([
      item("app", 1, { labels: '["Bug","ui"]', comments_count: 9 }),
      item("app", 2, { labels: '["bug"]', comments_count: 2, author: "eve", author_association: "NONE" }),
      item("app", 3, { labels: '["bug"]', comments_count: 5 }),
      item("app", 4, { labels: '["docs"]' }),
      item("app", 5, { kind: "pr", closing_issues: "[3]", labels: '["bug"]', ci_state: "SUCCESS" }),
      item("app", 6, { state: "CLOSED", labels: '["bug"]' }),
      item("other", 1, { labels: '["bug"]' }),
      ...Array.from({ length: 12 }, (_, n) => item("app", 100 + n, { updated_at: at(1) })),
    ]));
    const mention = (number: number, msg: string) => ({ msg_hash: msg, channel_hash: "c", repo: "app", number, sealed: "x" });
    await db.run(db.k.insertInto("main.discord_mentions").values([mention(1, "m1"), mention(3, "m2"), mention(3, "m3"), mention(4, "m4")]));
    const scope = { repos: ["app"], hidden: Object.assign(["other"], { visible: ["app"] }), staff: false, login: "ann" };
    const page = async (q: string, offset = 0, limit = 50) => (await loadBrowsePage(db, scope, parseItemQuery(q), { offset, limit, normalWeight: 5 }));
    const numbers = async (q: string, offset = 0, limit = 50) => (await page(q, offset, limit)).rows.map((r) => Number(r.number));

    // Labels match without case; Discord narrows to mentioned items; the most mentioned comes first; the other repo stays out.
    assert.deepEqual(await numbers("is:open label:bug discord:mentioned sort:discord"), [3, 1]);
    assert.deepEqual(await numbers("is:open label:bug -discord:mentioned sort:comments"), [2, 5]);
    assert.deepEqual(await numbers("is:issue is:open label:bug no:pr sort:comments"), [1, 2]);
    assert.deepEqual(await numbers("is:open is:outside no:response"), [2]);
    const pr = (await page("is:pr")).rows[0]!;
    assert.equal(Number(pr.linked), 3);
    assert.equal(pr.ci_state, "SUCCESS");

    // Twelve items share one update time: pages of five cover them all, each once.
    const q = "is:open sort:updated";
    const all = await numbers(q);
    const paged = [...await numbers(q, 0, 5), ...await numbers(q, 5, 5), ...await numbers(q, 10, 5), ...await numbers(q, 15, 5)];
    assert.deepEqual(paged, all);
    assert.equal(new Set(paged).size, paged.length);
    assert.equal((await page(q, 0, 5)).total, all.length);

    // Hits of a search by meaning keep their order; qualifiers still filter them.
    const hits = await loadBrowsePage(db, scope, parseItemQuery("is:open"), { offset: 0, limit: 50, normalWeight: 5, refs: ["app#4", "app#6", "app#2", "other#1"] });
    assert.deepEqual(hits.rows.map((r) => Number(r.number)), [4, 2]);

    const counts = await countPresets(db, scope, PRESETS.map((p) => ({ id: p.id, query: parseItemQuery(p.query) })));
    assert.equal(counts.open, all.length);
    assert.equal(counts.discord, 3);
    assert.equal(counts.outside, 1);
    const facets = await loadFacets(db, scope);
    assert.equal(facets.labels[0], "bug");
    assert.ok(facets.authors.includes("eve"));

    // A row only the automatic merge rule started asks nobody: it is stopped, not waiting on a person.
    const wf = (number: number, startedBy: string) => ({ repo: "app", number, kind: "issue", entry: "review", state: "recommending", started_by: startedBy, started_at: at(1), started_via: "github", updated_at: at(1) });
    await db.run(db.k.insertInto("main.item_workflows").values([wf(2, "automatic merge rule"), wf(3, "ann")] as never));
    assert.deepEqual(await numbers("autocraft:waiting"), [3]);
    assert.deepEqual(await numbers("autocraft:stopped"), [2]);
  } finally {
    await db.close?.();
  }
});

test("viewers cannot filter by review verdict or staff-only flags: those terms are reported as not applied", () => {
  const viewer = forReader(parseItemQuery("is:open review:clean -is:security"), false);
  assert.deepEqual(viewer.terms.map((x) => x.key), ["state"]);
  assert.deepEqual(viewer.unknown, ["review:clean", "-is:security"]);
  assert.equal(forReader(parseItemQuery("review:clean"), true).terms.length, 1, "staff keep the filter");
});

test("is:draft matches only open draft pull requests, is:ready only open non-draft pull requests", async () => {
  const db = await connectDb(":memory:");
  try {
    const item = (number: number, o: Record<string, unknown>) => ({
      repo: "app", number, kind: "pr", state: "OPEN", is_draft: 0, title: `t${number}`, author: "ann", author_association: "MEMBER", labels: "[]", comments_count: 0, created_at: at(number), updated_at: at(number), ...o,
    });
    await db.run(db.k.insertInto("main.items").values([
      item(1, { is_draft: 1 }), item(2, {}), item(3, { is_draft: 1, state: "CLOSED" }), item(4, { state: "MERGED" }), item(5, { kind: "issue" }),
    ]));
    const scope = { repos: ["app"], hidden: Object.assign([], { visible: ["app"] }), staff: false, login: "ann" };
    const numbers = async (q: string) => (await loadBrowsePage(db, scope, parseItemQuery(q), { offset: 0, limit: 50, normalWeight: 5 })).rows.map((r) => Number(r.number)).sort();
    assert.deepEqual(await numbers("is:draft"), [1]);
    assert.deepEqual(await numbers("draft:true"), [1]);
    assert.deepEqual(await numbers("is:ready"), [2]);
    assert.deepEqual(await numbers("draft:false"), [2]);
  } finally {
    await db.close();
  }
});

test("items: lists exactly the named items of tracked repos; another owner's repo of that name and unknown items match nothing", async () => {
  const db = await connectDb(":memory:");
  try {
    const item = (repo: string, number: number) => ({
      repo, number, kind: "issue", state: "OPEN", title: `t${number}`, author: "ann", author_association: "NONE", labels: "[]", comments_count: 0, created_at: at(number), updated_at: at(number),
    });
    await db.run(db.k.insertInto("main.items").values([
      item("app", 1), item("app", 2), item("app", 3), item("app", 4), item("app", 5), item("other", 1),
      // Synced before the author type was stored: a collaborator, and a bot known only by its login.
      { ...item("app", 6), author: "cleo", author_association: "COLLABORATOR", author_type: null },
      { ...item("app", 7), author: "renovate[bot]", author_association: "NONE", author_type: null },
    ]));
    const scope = { repos: ["app"], hidden: Object.assign(["other"], { visible: ["app"] }), staff: false, login: "ann" };
    const numbers = async (q: string, s: typeof scope & { insiders?: string[] } = scope) =>
      (await loadBrowsePage(db, s, parseItemQuery(q), { offset: 0, limit: 50, normalWeight: 5 })).rows.map((r) => `${r.repo}#${Number(r.number)}`).sort();
    assert.deepEqual(await numbers("items:app/2,storytold/app/4,someone-else/app/5,app/999,missing/1,other/1"), ["app#2", "app#4"]);
    // A pasted list keeps the items that read; only the others are not applied.
    const mixed = parseItemQuery("items:app/2,not-a-ref,app/3");
    assert.deepEqual(mixed.terms[0]?.values, ["app/2", "app/3"]);
    assert.deepEqual(mixed.unknown, ["items:not-a-ref"]);
    const team = async (n: number, s: typeof scope & { insiders?: string[] } = scope) =>
      Number((await loadBrowsePage(db, s, parseItemQuery(`items:app/${n}`), { offset: 0, limit: 50, normalWeight: 5 })).rows[0]?.team);
    assert.equal(await team(6), 1, "a collaborator with no stored author type is on the team");
    assert.equal(await team(7), 0, "a bot is not");
    assert.deepEqual(await numbers("is:outside items:app/6,app/7"), [], "neither is outside");
    // Operators and maintainers are on the team whatever GitHub's association says.
    assert.equal((await numbers("is:outside items:app/1")).length, 1);
    assert.deepEqual(await numbers("is:outside items:app/1", { ...scope, insiders: ["ann"] }), []);
  } finally {
    await db.close();
  }
});

test("step: matches the step a live workflow's advance pass recorded while it is one of its steps; negation keeps items with no live workflow", async () => {
  const db = await connectDb(":memory:");
  try {
    const item = (number: number, kind = "pr") => ({ repo: "app", number, kind, state: "OPEN", title: `t${number}`, author: "ann", labels: "[]", created_at: at(number), updated_at: at(number) });
    await db.run(db.k.insertInto("main.items").values([1, 2, 3, 4, 5, 7, 8].map((n) => item(n)).concat([item(6, "issue")])));
    const wf = (number: number, o: Record<string, unknown>) => ({ repo: "app", number, kind: "pr", entry: "fixup", state: "running", started_by: "ann", started_at: at(1), started_via: "github", updated_at: at(1), ...o });
    await db.run(db.k.insertInto("main.item_workflows").values([
      wf(1, { step: "fix-up" }),
      wf(2, { step: "merge", state: "blocked", approved_by: "ann" }),
      wf(3, { entry: "merge", step: "update from main" }),
      wf(4, { step: "recommend", state: "recommending" }),
      wf(5, { step: "fix-up", state: "done" }),
      wf(6, { kind: "issue", entry: "implement", state: "waiting", step: "implement" }),
      wf(7, {}),
      wf(8, { step: "recommend", approved_by: "ann" }),
    ] as never));
    const scope = (staff: boolean) => ({ repos: ["app"], hidden: Object.assign([], { visible: ["app"] }), staff, login: "ann" });
    const page = async (q: string, staff = true) => (await loadBrowsePage(db, scope(staff), parseItemQuery(q), { offset: 0, limit: 50, normalWeight: 5 })).rows;
    const numbers = async (q: string) => (await page(q)).map((r) => Number(r.number)).sort();

    assert.deepEqual(await numbers("step:fix-up"), [1], "a finished workflow is at no step");
    assert.deepEqual(await numbers("step:merge,update"), [2, 3]);
    assert.deepEqual(await numbers("step:recommend"), [4], "a recommend step recorded before the merge was approved is no step of the workflow");
    assert.deepEqual(await numbers("step:implement"), [6]);
    assert.deepEqual(await numbers("-step:fix-up"), [2, 3, 4, 5, 6, 7, 8]);
    for (const staff of [true, false]) {
      const states = Object.fromEntries((await page("", staff)).map((r) => [Number(r.number), r.step === null ? null : `${r.step}/${r.step_state}`]));
      assert.equal(states[2], "merge/stopped", "a blocker reads stopped for every reader");
      assert.equal(states[4], "recommend/answer");
      assert.equal(states[6], "implement/waiting");
      assert.equal(states[5], null);
      assert.equal(states[7], null, "before its first pass a workflow is at no step");
    }
  } finally {
    await db.close?.();
  }
});

test("an author's counts match their page's tab queries, ignore the login's case and leave hidden repos out", async () => {
  const db = await connectDb(":memory:");
  try {
    const item = (repo: string, number: number, kind: string, state: string, author = "Ann") => ({
      repo, number, kind, state, title: `t${number}`, author, author_association: "NONE", labels: "[]", comments_count: 0, created_at: at(number), updated_at: at(number),
    });
    await db.run(db.k.insertInto("main.items").values([
      item("app", 1, "pr", "MERGED"), item("app", 2, "pr", "CLOSED"), item("app", 3, "pr", "OPEN"), item("app", 4, "pr", "MERGED"),
      item("app", 5, "issue", "OPEN"), item("app", 6, "issue", "CLOSED"), item("app", 7, "pr", "OPEN", "eve"),
      item("other", 1, "pr", "CLOSED"), item("other", 2, "issue", "OPEN"),
    ]));
    const scope = { repos: ["app"], hidden: Object.assign(["other"], { visible: ["app"] }), staff: false, login: "eve" };
    const c = await loadAuthorCounts(db, scope, "ann");
    const total = async (q: string) => (await loadBrowsePage(db, scope, parseItemQuery(`author:ann ${q}`), { offset: 0, limit: 50, normalWeight: 5 })).total;
    assert.equal(c.login, "Ann");
    assert.equal(c.prs + c.issues, await total(""));
    assert.equal(c.merged, await total("is:merged"));
    assert.equal(c.rejected, await total("is:pr is:closed"));
    assert.equal(c.openPrs + c.openIssues, await total("is:open"));
    assert.ok(c.rejected > 0 && c.rejected < c.prs - c.merged);
    assert.equal((await loadAuthorCounts(db, scope, "nobody")).login, null);
  } finally {
    await db.close?.();
  }
});
