import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setCommentApproval } from "../src/act/approval.ts";
import { runFixup } from "../src/fixup/index.ts";
import { viewFile } from "../src/fixup/excerpt.ts";
import { validatePatch } from "../src/fixup/patch.ts";
import { REPO_PATH } from "../src/sandbox/command.ts";
import { fresh, T1, world } from "./helpers/fixup-world.ts";
import type { Db } from "./helpers/raw-db.ts";
import * as kx from "../src/db/kx.ts";

describe("candidate selection", () => {




});

const hunk = (file: string, body = "-a\n+b\n", counts = "-1 +1") =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ ${counts} @@\n${body}`;

describe("patch validation", () => {
  test("accepts a content edit to a named file, also inside a fence", () => {
    const ok = validatePatch(hunk("src/lib.rs"), ["src/lib.rs"]);
    assert.ok(ok.ok && ok.changed === 2 && ok.files[0] === "src/lib.rs");
    assert.ok(validatePatch("```diff\n" + hunk("src/lib.rs") + "```", ["src/lib.rs"]).ok);
  });

  test("refuses a file the fixes do not name, or an unsafe path", () => {
    assert.match(String((validatePatch(hunk("src/other.rs"), ["src/lib.rs"]) as { reason: string }).reason), /not a file named/);
    assert.equal(validatePatch(hunk("../x"), ["../x"]).ok, false);
  });

  test("refuses more than 300 changed lines", () => {
    const body = Array.from({ length: 151 }, (_, i) => `-o${i}\n+n${i}\n`).join("");
    const r = validatePatch(hunk("src/lib.rs", body, "-1,151 +1,151"), ["src/lib.rs"]);
    assert.ok(!r.ok && /302 changed lines/.test(r.reason));
  });

  test("refuses mode, new, deleted, rename, symlink and binary changes", () => {
    const f = "src/lib.rs";
    const cases = [
      `diff --git a/${f} b/${f}\nold mode 100644\nnew mode 100755\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`,
      `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+b\n`,
      `diff --git a/${f} b/${f}\ndeleted file mode 100644\n--- a/${f}\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n`,
      `diff --git a/${f} b/${f}\nindex 1234567..89abcde 120000\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`,
      `diff --git a/${f} b/${f}\nindex 1234567..89abcde 100644\nBinary files a/${f} and b/${f} differ\n`,
      `diff --git a/${f} b/${f}\nGIT binary patch\nliteral 1\n`,
    ];
    for (const c of cases) assert.equal(validatePatch(c, [f]).ok, false, c.split("\n")[1]);
  });

  test("refuses text that is not a diff and a hunk longer than its header", () => {
    assert.equal(validatePatch("I fixed it.", ["a"]).ok, false);
    assert.equal(validatePatch(hunk("a", "-a\n+b\n+c\n"), ["a"]).ok, false);
  });
});

const spreadDiff = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` + Array.from({ length: 24 }, (_, i) => 1 + i * 250).map((n) => `@@ -${n} +${n} @@\n-x\n+fn f${n}() {}\n`).join("");
const fixupRows = async (db: Db, from?: string) => await db.all(db.k.selectFrom("fixups").select(["state", "reason"]).$if(!!from, (q) => q.where("from_head", "=", from!)).orderBy(kx.rowid("fixups")));

describe("fixup step", () => {


















  test("a push that another one overtook is no try of the fix-up", async () => {
    const file = "GUIDE.md";
    const w = world({ pushError: "! [rejected] fix -> fix (stale info)", reply: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n # Plan\n-- one\n+- two\n`, diff: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n # Plan\n-- zero\n+- one\n` });
    const db = await fresh(w.head);
    await db.run(db.k.updateTable("opus_reviews").set({ fixes: JSON.stringify([{ file, change: "say two" }]) }));
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.deepEqual((await fixupRows(db)).map((r) => r.state), ["superseded"]);
    assert.deepEqual(await db.all(db.k.selectFrom("own_pushes").select(["from_oid", "action", "landed_at"])), [{ from_oid: w.head, action: "fixup-push", landed_at: null }]);
  });

  test("a file over the size limit is held without a checkout and listed by path alone with one", async () => {
    const lib = Array.from({ length: 6000 }, (_, i) => `fn f${i}() {}`).join("\n") + "\n";
    const held = world({ lib, diff: spreadDiff("src/lib.rs") });
    const db1 = await fresh(held.head);
    await runFixup(db1, { repo: "app", dryRun: false }, () => {}, held.deps);
    assert.equal(held.asked.length, 0);
    assert.equal((await fixupRows(db1))[0]!.state, "too-large");

    const w = world({ lib, diff: spreadDiff("src/lib.rs") });
    w.deps.checkout = async () => "/checkout";
    await runFixup(await fresh(w.head), { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(w.asked.length, 1);
    assert.deepEqual(w.asked[0]!.files, [{ path: "src/lib.rs" }]);
    assert.equal(w.asked[0]!.repo_dir, REPO_PATH);
  });

  test("a PR diff over the cap is held without a checkout and trimmed to the named files with one", async () => {
    const other = `diff --git a/src/other.rs b/src/other.rs\n--- a/src/other.rs\n+++ b/src/other.rs\n@@ -1 +1,4000 @@\n${Array.from({ length: 4000 }, (_, i) => `+fn z${i}() { /* padding */ }`).join("\n")}\n`;
    const diff = hunk("src/lib.rs", "-fn a() {}\n+fn a() { }\n") + other;
    const held = world({ diff });
    const db0 = await fresh(held.head);
    await runFixup(db0, { repo: "app", dryRun: false }, () => {}, held.deps);
    assert.equal(held.asked.length, 0);
    assert.deepEqual(await fixupRows(db0), [{ state: "too-large", reason: "the PR diff is over the 60000 character limit" }]);

    // A checkout that could not be made this run holds nothing: the PR is tried again.
    const missed = world({ diff });
    missed.deps.checkout = async () => null;
    const db1 = await fresh(missed.head);
    await runFixup(db1, { repo: "app", dryRun: false }, () => {}, missed.deps);
    assert.equal(missed.asked.length, 0);
    assert.deepEqual(await fixupRows(db1), []);

    const w = world({ diff });
    w.deps.checkout = async () => "/checkout";
    const checked: string[] = [];
    const check = w.deps.check;
    w.deps.check = async (db, input, checkout) => { checked.push(input[0]!.diff); return await check(db, input, checkout); };
    const db = await fresh(w.head);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal(w.asked.length, 1);
    const shown = w.asked[0]!.diff;
    assert.ok(shown.length < diff.length);
    assert.match(shown, /^diff --git a\/src\/lib\.rs /m);
    assert.doesNotMatch(shown, /^diff --git a\/src\/other\.rs /m);
    assert.match(shown, /src\/other\.rs/);
    assert.deepEqual(checked, [shown]);
    assert.notEqual((await fixupRows(db))[0]!.state, "too-large");
  });

  describe("a patch on a large file with a duplicated block", () => {
    const dup = (i: number) => (i >= 100 && i < 103) || (i >= 2500 && i < 2503) ? `dup ${i < 200 ? i - 100 : i - 2500}` : `fn f${i}() {}`;
    const lib = Array.from({ length: 3000 }, (_, i) => dup(i)).join("\n") + "\n";
    const diff = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1000,1 +1000,1 @@\n-x\n+fn f999() {}\n";
    const patch = (start: number) => `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -${start},3 +${start},3 @@\n dup 0\n-dup 1\n+dup one\n dup 2\n`;
    const run = async (start: number) => {
      const w = world({ lib, diff, reply: patch(start) });
      const db = await fresh(w.head);
      const s = await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
      return { s, reason: String((await fixupRows(db))[0]?.reason), log: w.log };
    };



  });

  test("lines are cited as line N, lines N-M, LN and path:N, and a column after a path is not a line", () => {
    const body = Array.from({ length: 1000 }, (_, i) => `fn f${i}() {}`).join("\n") + "\n";
    const regions = (cue: string) => {
      const v = viewFile("src/x.rs", body, [cue], "", 10_000);
      const f = v.ok ? v.file : null;
      return f?.excerpt ? f.excerpt.regions.map((r) => [r.from, r.to]) : null;
    };
    assert.deepEqual(regions("src/x.rs:500:3"), [[350, 650]]);
    assert.deepEqual(regions("line 20, lines 800-810 and L900"), [[1, 170], [650, 1000]]);
  });













});

describe("review of a moved head", () => {
});

describe("fixup repost", () => {

});

describe("a second ask on a PR we already asked", () => {
  const H2 = "b".repeat(40);
  /** Asks at the world's head, then moves the PR to H2 with a review there and asks again. */
  async function twice(push: "none" | "ours") {
    const w = world({ canModify: false });
    const db = await fresh(w.head, { canModify: false });
    await setCommentApproval(db, "op", "app", true);
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    assert.equal((await fixupRows(db))[0]!.state, "asked");
    for (const r of await db.all(db.k.selectFrom("audit").select([kx.rowid("audit").as("id"), "details"]).where("action", "=", "fixup-comment"))) {
      await db.run(db.k.updateTable("audit").set({ details: JSON.stringify({ ...JSON.parse(r.details!), url: "https://github.com/o/app/pull/7#issuecomment-55" }) }).where(kx.rowid("audit"), "=", r.id));
    }
    if (push === "ours") {
      await db.run(db.k.insertInto("audit").values({ at: T1, login: "cifix", action: "cifix-push", target: "app#7", details: JSON.stringify({ state: "done", from: w.head, to: H2 }) }));
    }
    await db.run(db.k.updateTable("items").set({ head_oid: H2 }).where("repo", "=", "app"));
    await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 7, head_oid: H2, run_id: "rv2", at: T1, model: "m", verdict: "take-fix", reason: "nearly right", fixes: JSON.stringify([{ file: "src/lib.rs", change: "rename a to c" }]), sure: 1, mode: "full" }));
    await db.run(db.k.updateTable("pr_checks").set({ head_oid: H2 }).where("repo", "=", "app").where("number", "=", 7));
    const q = w.deps.querier;
    w.deps.querier = { ...q, query: async (s: string, v?: Record<string, unknown>) => { const r = await q.query(s, v as Record<string, unknown>) as { repository?: { pullRequest?: { headRefOid: string } } }; if (r.repository?.pullRequest) r.repository.pullRequest.headRefOid = H2; return r; } } as typeof q;
    const calls: string[] = [];
    const run = w.deps.exec;
    w.deps.exec = async (cmd, args, o) => { if (cmd === "gh" && args[0] !== "api") calls.push("comment"); if (cmd === "gh" && args[0] === "api" && args.includes("PATCH")) calls.push(`edit ${args.join(" ")}`); return run(cmd, args, o); };
    await runFixup(db, { repo: "app", dryRun: false }, () => {}, w.deps);
    return { calls, db };
  }

  test("our own push in between: the earlier ask comment is edited", async () => {
    const { calls, db } = await twice("ours");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /^edit .*issues\/comments\/55/);
    assert.equal((await fixupRows(db, H2))[0]!.state, "asked");
  });

  test("no push of ours in between: a new comment", async () => {
    const { calls } = await twice("none");
    assert.deepEqual(calls, ["comment"]);
  });
});
