// Conflicts in a fix session: a file resolved in place gives back the answers it was spliced from, and a conflict step on the PR's
// session goes from the workspace's resolved file through the gates and the lint task to the pushed merge commit. Real git and the
// real workspace helper; the model, the network and AutoCraft's checks in the pod are fakes.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createEnv } from "../src/build/envs.ts";
import { setFixSessions } from "../src/fixsession/switch.ts";
import { runFixup } from "../src/fixup/index.ts";
import { answersFromFile, conflictView, spliceSections } from "../src/fixup/patch.ts";
import { conflictRef } from "../src/fixup/conflict-session.ts";
import { fixPod } from "./helpers/fix-pod.ts";
import { endLint, fresh, gitWorld, quiet, sh } from "./journeys-world.ts";
import type { Db } from "./helpers/raw-db.ts";

test("a file resolved in place gives back the answers it was spliced from; an edit outside the sections or a section with four new lines is refused", () => {
  const content = "fn a() {}\n<<<<<<< ours\nlet x = 1;\n=======\nlet x = 2;\n>>>>>>> theirs\n}\nfn b() {}\n<<<<<<< ours\n/// One.\n=======\n/// Two.\n>>>>>>> theirs\nfn c() {}\n";
  const view = conflictView("src/lib.rs", content, 1)!;
  const answers = ["let x = 1;\nlet y = 2;\n", "/// Two.\n/// One.\n"];
  const file = spliceSections(content, answers, "src/lib.rs")!;
  assert.ok(file, "the answers keep the section rules");
  const back = answersFromFile(content, view, file);
  assert.ok(back.ok, back.ok ? "" : back.reason);
  assert.deepEqual(view.sections.map((s) => back.sections.get(s.id)), answers);
  assert.equal(spliceSections(content, view.sections.map((s) => back.sections.get(s.id)!), "src/lib.rs"), file, "the same file again");

  const outside = answersFromFile(content, view, file.replace("fn b() {}", "fn b() { todo!() }"));
  assert.ok(!outside.ok && /outside the conflict sections/.test(outside.reason));
  const longer = answersFromFile(content, view, file.replace("let y = 2;\n", "let y = 2;\nlet p = 3;\nlet q = 4;\nlet r = 5;\nlet s = 6;\n"));
  assert.ok(!longer.ok && /neither side/.test(longer.reason));

  // Hostile sizes: a long piece between the sections repeated through a 1 MiB file, and many short pieces inside a section.
  const piece = "fn x() {}\n".repeat(200);
  const wide = `fn a() {}\n<<<<<<< ours\nlet x = 1;\n=======\nlet x = 2;\n>>>>>>> theirs\n${piece}<<<<<<< ours\n/// One.\n=======\n/// Two.\n>>>>>>> theirs\nfn c() {}\n`;
  const wideView = conflictView("src/lib.rs", wide, 1)!;
  const huge = answersFromFile(wide, wideView, `fn a() {}\n${piece.repeat(Math.ceil((1 << 20) / piece.length))}/// Two.\nfn c() {}\n`);
  assert.ok(!huge.ok && /size limit/.test(huge.reason));
  const tight = `fn a() {}\n<<<<<<< ours\n}\n=======\n}\n>>>>>>> theirs\n}\n<<<<<<< ours\n}\n=======\n}\n>>>>>>> theirs\nfn c() {}\n`;
  const many = answersFromFile(tight, conflictView("src/lib.rs", tight, 1)!, `fn a() {}\n${"}\n".repeat(50_000)}fn c() {}\n`);
  assert.ok(!many.ok);
});

test("with fix sessions on for conflicts, the session's resolved file goes through the gates and the lint task to the merge commit", async () => {
  const git = gitWorld(1, undefined, true);
  const w = await (await (await (await fresh()).pr(1, { head: git.head, mergeable: "CONFLICTING" })).review(1, { verdict: "take" })).verified(1);
  const db = w.db as unknown as Db;
  await w.db.run(w.db.k.updateTable("items").set({ base_ref: "main" }).where("repo", "=", "app").where("number", "=", 1));
  const deps = git.deps(w);
  process.env.AUTOCRAFT_FIXUP_DIR = deps.root;
  deps.resolve = async () => { throw new Error("the resolver is not asked in a fix session"); };
  await setFixSessions(db, { steps: ["conflict"], repos: null }, "op");
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, settings: { image: "autocraft:test" } }, "op");
  const work = join(git.fork, "..", "work");
  const pod = fixPod(db, { top: join(git.fork, ".."), src: work, head: git.head, repo: "app" });
  deps.fixSession = () => pod.deps;
  const session = await pod.session("pr", 1);
  const resolved = "fn a() {}\n// both\nfn main() { a(); b(); }\n";
  pod.model(() => ({ "src/lib.rs": resolved }), { status: "done", summary: "Kept both calls." });
  const run = () => runFixup(w.db, { repo: "app", dryRun: false }, process.env.DBG ? console.log : quiet, deps);

  assert.deepEqual((await run()).pushed, []);
  assert.equal(pod.queued.length, 1);
  assert.match(pod.queued[0]!.stdin, /merge of main into the pull request's branch, with its conflict markers/);
  assert.match(pod.queued[0]!.stdin, /"path": "src\/lib.rs"/);
  const [stored] = await w.db.all(w.db.k.selectFrom("conflict_merges").select(["state", "session_turn"]));
  assert.equal(stored?.state, "linting");
  assert.ok(stored?.session_turn != null, "the stored resolution names the turn that wrote it");
  // The workspace was seeded from the merge with its markers, kept under our ref.
  const seed = sh(join(deps.root, "app"), "rev-parse", conflictRef("app", 1));
  assert.equal(sh(join(deps.root, "app"), "rev-parse", `${seed}^1`), git.head);
  assert.match(sh(join(deps.root, "app"), "show", `${seed}:src/lib.rs`), /^<{7}/m);
  assert.equal((await w.db.get(w.db.k.selectFrom("workspaces").select("base_sha").where("id", "=", session.workspaceId!)))?.base_sha, seed);

  const task = (await w.db.get(w.db.k.selectFrom("build_tasks").select("id").orderBy("id", "desc").limit(1)))!.id;
  await endLint(w, Number(task));
  assert.deepEqual((await run()).pushed, ["app#1"]);
  const pushed = git.branchHead();
  assert.equal(sh(git.fork, "show", `${pushed}:src/lib.rs`), resolved.trimEnd());
  assert.deepEqual(sh(git.fork, "rev-list", "--parents", "-n1", pushed).split(" ").slice(1), [git.head, sh(git.fork, "rev-parse", "main")], "a merge of the head and the base");
  assert.deepEqual(await w.db.all(w.db.k.selectFrom("conflict_merges").select(["state", "to_head"])), [{ state: "merged", to_head: pushed }]);
  assert.equal(pod.queued.length, 1, "no second turn");
  assert.equal((await w.db.get(w.db.k.selectFrom("workspaces").select("state").where("id", "=", session.workspaceId!)))?.state, "parked", "the step's pod is parked when it ends");
});
