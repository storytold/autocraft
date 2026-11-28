// A fix session's change is gated by its step on the diff read from the pod: a change outside what the step allows gets one undo
// turn and is then refused, and the refused edits it left in the pod never reach the next step, whose turn starts from a reseeded
// tree. The pod runs the real workspace helper on a scratch /work; only the model and AutoCraft's checks are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";
import { fixPod } from "./helpers/fix-pod.ts";
import { createEnv } from "../src/build/envs.ts";
import { runGate, type StepGate } from "../src/fixsession/gates.ts";
import type { StepTurn } from "../src/fixsession/messages.ts";
import { loadSessions, turnsOf, type FixSessionKind } from "../src/fixsession/store.ts";
import { prStep, runStep, type StepEnv, type StepSpec } from "../src/fixsession/turn.ts";

const top = join(SCRATCH, "fix-turn");
process.env.AUTOCRAFT_FIXUP_DIR = join(top, "fixups");
const LIB = "crates/app/src/lib.rs", UTIL = "crates/app/src/util.rs", IT = "crates/app/tests/it.rs";
const ORIGINAL: Record<string, string> = { "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n', [LIB]: "pub fn a() -> u8 { 0 }\n", [UTIL]: "pub fn u() {}\n", [IT]: "#[test]\nfn t() {}\n" };

async function setup() {
  const work = join(top, "work");
  mkdirSync(work, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: work, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [p, text] of Object.entries(ORIGINAL)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), text); }
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const head = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", "--bare", work, join(top, "fixups/app")]);

  const db = (await world()).db;
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, settings: { image: "autocraft:test" } }, "op");
  const pod = fixPod(db, { top, src: work, head });
  const env: StepEnv = { db, log: () => {}, by: "op", ...pod.deps };
  return { db, env, head, queued: pod.queued, session: pod.session, model: pod.model, root: pod.root };
}

// Both tests share one repo, pod and database; each works on its own items.
let shared: ReturnType<typeof setup> | undefined;
const ready = () => (shared ??= setup());

const base = (head: string) => ({ ref: "app#9", title: "Fix a", head });
const fixupTurn = (head: string): StepTurn => ({ ...base(head), step: "fixup", reason: "a returns the wrong value", fixes: [{ file: LIB, change: "return 1" }], allowed: [LIB], newFilesIn: ["crates/app"], diff: "" });
const cifixTurn = (head: string): StepTurn => ({ ...base(head), step: "cifix", failure: [{ check: "ci", steps: [{ job: "test", step: "cargo test", log: `error[E0308] at ${LIB}:1` }] }], allowed: [LIB] });
const fixupGate = (): StepGate => ({ step: "fixup", allowed: [LIB], newFilesIn: ["crates/app"], packages: ["crates/app"], scripts: null });
const cifixGate = (): StepGate => ({ step: "cifix", allowed: [LIB], scripts: null, guard: async () => null });

test("a change outside what its step allows gets one undo turn and is then refused, for a fix-up, a CI fix and a security fix", async () => {
  const s = await ready();
  const securitySpec: StepSpec = {
    step: "security", head: s.head, promptId: "security.session",
    task: async () => ({ system: "Fix one defect.", stdin: "The finding.", version: "v1" }),
    message: () => "The finding again.",
    gate: () => ({ step: "security", allowed: [LIB], testPath: "crates/app/tests/regress.rs", crateDir: "crates/app", testName: "regress", scripts: null }),
  };
  const cases: { name: string; kind: FixSessionKind; spec: StepSpec; edits: Record<string, string>; report?: Record<string, unknown>; refused: RegExp }[] = [
    { name: "a fix-up touching a file the fixes do not name", kind: "pr", spec: prStep(s.db, fixupTurn(s.head), fixupGate), edits: { [LIB]: "pub fn a() -> u8 { 1 }\n", [UTIL]: "pub fn u() { let _ = 1; }\n" }, refused: /util\.rs is not a file named in the review's fixes/ },
    { name: "a CI fix editing a test", kind: "pr", spec: prStep(s.db, cifixTurn(s.head), cifixGate), edits: { [LIB]: "pub fn a() -> u8 { 1 }\n", [IT]: "#[test]\nfn t() { assert!(true); }\n" }, refused: /it\.rs is a test file/ },
    {
      name: "a security fix adding a second new file", kind: "security", spec: securitySpec,
      edits: { [LIB]: "pub fn a() -> u8 { 1 }\n", "crates/app/tests/regress.rs": "#[test]\nfn regress() { assert_eq!(app::a(), 1); }\n", "crates/app/tests/extra.rs": "#[test]\nfn extra() {}\n" },
      report: { status: "done", title: "Return one from a", summary: "a returns one." }, refused: /extra\.rs: a security fix adds only/,
    },
  ];
  for (const [i, c] of cases.entries()) {
    const session = await s.session(c.kind, 20 + i);
    const before = s.queued.length;
    s.model(() => c.edits, c.report);
    const out = await runStep(s.env, session, c.spec);
    assert.equal(out.kind, "refused", `${c.name}: ${"reason" in out ? out.reason : ""}`);
    assert.ok(out.kind === "refused");
    assert.ok(out.problems.some((p) => c.refused.test(p)), `${c.name}: ${out.problems.join("; ")}`);
    const sent = s.queued.slice(before);
    assert.equal(sent.length, 2, `${c.name}: the task and one undo turn`);
    assert.equal(sent[1]!.parentId, 5000 + before + 1, `${c.name}: the undo turn goes on the same session`);
    assert.match(sent[1]!.stdin, c.refused, `${c.name}: the undo turn names the refused change`);
    assert.deepEqual((await turnsOf(s.db, session.id)).map((t) => t.purpose), ["start", "undo"]);
  }
});

test("a refused fix-up edit left in the pod never reaches the next step: the CI fix's turn starts from a reseeded tree", async () => {
  const s = await ready();
  const session = await s.session("pr", 9);
  const before = s.queued.length;
  s.model(() => ({ [LIB]: "pub fn a() -> u8 { 1 }\n", [UTIL]: "pub fn u() { let _ = 1; }\n" }));
  const fixup = await runStep(s.env, session, prStep(s.db, fixupTurn(s.head), fixupGate));
  assert.equal(fixup.kind, "refused");
  const root = s.root(session.workspaceId!);
  const tree = (p: string) => readFileSync(join(root, "src", p), "utf8");
  assert.notEqual(tree(UTIL), ORIGINAL[UTIL], "the refused edit is still in the pod");

  s.model((r) => {
    assert.equal(tree(UTIL), ORIGINAL[UTIL], "the CI fix's turn starts on a clean tree");
    assert.match(r.stdin, /Edits from your earlier tasks that were not pushed are gone/);
    return { [LIB]: "pub fn a() -> u8 { 2 }\n" };
  });
  const live = (await loadSessions(s.db, [session.id])).get(session.id)!;
  const cifix = await runStep(s.env, live, prStep(s.db, cifixTurn(s.head), cifixGate));
  assert.equal(cifix.kind, "ok", cifix.kind === "refused" ? cifix.problems.join("; ") : cifix.kind);
  assert.ok(cifix.kind === "ok");
  assert.deepEqual(cifix.gate.files, [LIB]);
  assert.doesNotMatch(cifix.diff, /util\.rs|AGENTS/);
  assert.equal(s.queued.at(-1)!.parentId, 5000 + before + 2, "the CI fix continues the session of the fix-up's last turn");
  assert.ok(existsSync(join(root, "repo-docs/AGENTS.txt")), "the default branch's AGENTS.md is in the workspace, outside the tree");
});

test("a fix-up's pod diff keeps its CRLF lines as written, and a new file belongs to its innermost package", async () => {
  const crlf = `diff --git a/${LIB} b/${LIB}\nindex 1111111..2222222 100644\n--- a/${LIB}\n+++ b/${LIB}\n@@ -1 +1 @@\n-pub fn a() -> u8 { 0 }\r\n+pub fn a() -> u8 { 1 }\r\n`;
  const gate: StepGate = { step: "fixup", allowed: [LIB], newFilesIn: ["crates/app"], packages: ["crates/app", "crates/app/inner"], scripts: null };
  const ok = await runGate(gate, crlf, null);
  assert.ok(ok.ok);
  assert.equal(ok.patch, crlf, "the patch is the diff as git wrote it");
  const nested = `diff --git a/crates/app/inner/src/new.rs b/crates/app/inner/src/new.rs\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/crates/app/inner/src/new.rs\n@@ -0,0 +1 @@\n+pub fn n() {}\n`;
  const refused = await runGate(gate, nested, null);
  assert.ok(!refused.ok && refused.problems.some((p) => p.includes("inner/src/new.rs")), "a file inside another package is not the PR's crate's");
  assert.ok((await runGate({ ...gate, newFilesIn: ["crates/app/inner"] }, nested, null)).ok);
});
