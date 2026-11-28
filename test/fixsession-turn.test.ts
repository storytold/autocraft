// A fix session's change is gated by its step on the diff read from the pod: a change outside what the step allows gets one undo
// turn and is then refused, and the refused edits it left in the pod never reach the next step, whose turn starts from a reseeded
// tree. The pod runs the real workspace helper on a scratch /work; only the model and AutoCraft's checks are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";
import { createEnv } from "../src/build/envs.ts";
import type { KubeApi } from "../src/build/kube-api.ts";
import type { WorkspaceCallRequest } from "../src/build/workspace-call.ts";
import { WS_POD_PATH } from "../src/build/workspace.ts";
import { createWorkspace, moveWorkspace } from "../src/build/workspaces.ts";
import type { CheckRound } from "../src/implement/checks.ts";
import type { Outcome } from "../src/remote/calls.ts";
import type { StepGate } from "../src/fixsession/gates.ts";
import type { StepTurn } from "../src/fixsession/messages.ts";
import { ensureSession, loadSessions, turnsOf, updateSession, type FixSessionKind } from "../src/fixsession/store.ts";
import { prStep, runStep, type StepEnv, type StepSpec } from "../src/fixsession/turn.ts";

const top = join(SCRATCH, "fix-turn");
process.env.AUTOCRAFT_FIXUP_DIR = join(top, "fixups");
const helper = new URL("../deploy/container/ws", import.meta.url).pathname;
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

  // One scratch /work per workspace, seeded at the head.
  const roots = new Map<number, string>();
  const seed = (ws: number): string => {
    const root = join(top, `pod-${ws}`);
    for (const d of ["src", "home", ".ws/calls"]) mkdirSync(join(root, d), { recursive: true });
    const seeded = spawnSync("sh", [helper, "untar"], { env: { ...process.env, WS_ROOT: root }, input: execFileSync("git", ["archive", head], { cwd: work }) });
    roots.set(ws, root);
    return seeded.stdout.toString().trim().split(" ")[2]!;
  };
  const api = {
    listPods: async (_ns: string, selector: string) => {
      const id = /craft\.build\/workspace=(\d+)/.exec(selector)![1]!;
      return [{ metadata: { name: `ws-${id}`, labels: { "craft.build/workspace": id } }, status: { phase: "Running" } }];
    },
    exec: async (_ns: string, pod: string, _c: string, argv: string[], o: { stdin?: Buffer | AsyncIterable<Buffer> }) => {
      const root = roots.get(Number(pod.slice(3)))!;
      const local = (a: string) => a.replace(/\/work(?=\/|$|\s|")/g, root);
      const [cmd, ...args] = argv[0] === WS_POD_PATH ? ["sh", helper, ...argv.slice(1)] : argv;
      const p = spawn(cmd!, args.map(local), { env: { ...process.env, WS_ROOT: root } });
      const out: Buffer[] = [];
      p.stdout.on("data", (b: Buffer) => out.push(b));
      if (o.stdin && !Buffer.isBuffer(o.stdin)) for await (const chunk of o.stdin) p.stdin.write(chunk);
      p.stdin.end(Buffer.isBuffer(o.stdin) ? o.stdin : undefined);
      const code = await new Promise<number | null>((r) => p.on("close", r));
      return { exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.alloc(0), truncated: false };
    },
  } as unknown as KubeApi;

  const db = (await world()).db;
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, settings: { image: "autocraft:test" } }, "op");

  // The model: each call writes the files the case gives it into the pod's tree, then replies with the report.
  const queued: WorkspaceCallRequest[] = [];
  let edits: (r: WorkspaceCallRequest) => Record<string, string> = () => ({});
  let report: Record<string, unknown> = { status: "done", summary: "Made the change." };
  const env: StepEnv = {
    db, api, log: () => {}, by: "op",
    agents: async () => "Build with cargo build --offline.\n",
    checks: async (_pod, o) => ({ round: o.round, base: o.base, diffStat: "", files: [], crates: [], findings: [], notes: [], noVerdict: [], diffHash: "", needsDependency: false, clean: true } as unknown as CheckRound),
    calls: {
      async queue(_db, r) {
        queued.push(r);
        const id = 5000 + queued.length, now = Date.now();
        await db.run(db.k.insertInto("main.remote_calls").values({
          id, step: "fixup", stage: 0, prompt_id: r.promptId, prompt_version: r.promptVersion, tier: r.tier, effort: r.effort, asked_model: r.model, bundle: JSON.stringify({ system: r.system }),
          state: "queued", since: now, seen_at: now, max_attempts: 2, timeout_ms: 1000, parent_id: r.parentId ?? null,
        } as never));
        return id;
      },
      async await(_db, id): Promise<Outcome> {
        const r = queued[id - 5001]!, root = roots.get(r.workspaceId)!;
        for (const [p, text] of Object.entries(edits(r))) { mkdirSync(dirname(join(root, "src", p)), { recursive: true }); writeFileSync(join(root, "src", p), text); }
        return { state: "done", text: JSON.stringify(report), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as never, byModel: null, costUsd: 0.5, turns: 3, sessionId: "s", runId: null };
      },
    },
  };

  /** A live session of `kind` on item `n` with a ready workspace at the head. */
  const session = async (kind: FixSessionKind, n: number) => {
    const ws = await createWorkspace(db, { repo: "app", baseSha: head, envId: "pods", owner: "test" });
    await moveWorkspace(db, ws, ["requested"], "ready", { pod: `ws-${ws}`, base_commit: seed(ws) });
    const s = await ensureSession(db, kind, "app", n);
    assert.ok("session" in s);
    await updateSession(db, s.session.id, { workspaceId: ws, head });
    return (await loadSessions(db, [s.session.id])).get(s.session.id)!;
  };
  return {
    db, env, head, queued, session,
    model(f: typeof edits, r: Record<string, unknown> = { status: "done", summary: "Made the change." }) { edits = f; report = r; },
    /** The workspace's scratch /work. */
    root: (ws: number) => roots.get(ws)!,
  };
}

// Both tests share one repo, pod and database; each works on its own items.
let shared: ReturnType<typeof setup> | undefined;
const ready = () => (shared ??= setup());

const base = (head: string) => ({ ref: "app#9", title: "Fix a", head });
const fixupTurn = (head: string): StepTurn => ({ ...base(head), step: "fixup", reason: "a returns the wrong value", fixes: [{ file: LIB, change: "return 1" }], allowed: [LIB], newFilesIn: ["crates/app"], diff: "" });
const cifixTurn = (head: string): StepTurn => ({ ...base(head), step: "cifix", failure: [{ check: "ci", steps: [{ job: "test", step: "cargo test", log: `error[E0308] at ${LIB}:1` }] }], allowed: [LIB] });
const fixupGate = (): StepGate => ({ step: "fixup", allowed: [LIB], newFilesIn: ["crates/app"], scripts: null });
const cifixGate = (): StepGate => ({ step: "cifix", allowed: [LIB], scripts: null });

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
