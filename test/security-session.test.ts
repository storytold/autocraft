// A security fix round in a fix session, through runFix with the switch on: a change that adds a second new file is refused, goes
// back once as an undo turn, and the corrected change passes validateFixPatch into a stored round that waits for its builds. The
// session's calls and workspace session name only the finding's security pseudo repo item. Real git and the real workspace helper;
// the model and AutoCraft's checks in the pod are fakes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createEnv } from "../src/build/envs.ts";
import { exec } from "../src/fixup/git.ts";
import { setFixSessions } from "../src/fixsession/switch.ts";
import { runFix, type FixDeps } from "../src/security/fix.ts";
import { FIX_RUN_BASE, securityRepo } from "../src/security/rules.ts";
import { regressionName } from "../src/verify/types.ts";
import { callId, fixPod } from "./helpers/fix-pod.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "security-session-"));
const cache = join(dir, "cache");
process.env.AUTOCRAFT_FIXUP_DIR = cache;
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const SRC = "crates/psd/src/lib.rs", EXTRA = "crates/psd/tests/extra.rs";
const FILES: Record<string, string> = { "crates/psd/Cargo.toml": '[package]\nname = "psd"\nversion = "0.1.0"\n', [SRC]: "pub fn read(n: usize) -> usize { n }\n" };
const FIXED = "pub fn read(n: usize) -> usize { n.min(64) }\n";
const TEST = "#[test]\nfn bounded() { assert_eq!(psd::read(100), 64); }\n";

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("a security session's change with a second new file gets one undo turn, and the corrected change is stored as a round waiting for its builds", async () => {
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  for (const [p, text] of Object.entries(FILES)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), text); }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  const sha = git(work, "rev-parse", "HEAD");
  git(dir, "clone", "-q", "--bare", work, join(cache, "photocraft"));

  const db = await connectDb(join(dir, "t.db"));
  // A confidential build environment that has reported (the round's builds), and a confidential kubernetes one (the session's workspace).
  await db.prepare("INSERT INTO build_envs (id, label, kind, slots, key_hash, confidential, confidential_since, confidential_online_at, created_at) VALUES ('vault', 'vault', 'remote', 1, 'x', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run();
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, confidential: true, settings: { image: "autocraft:test" } }, "op");
  await setFixSessions(db, { steps: ["security"], repos: null }, "op");
  await db.run(db.k.insertInto("security_scans").values({ id: 1, repo: "photocraft", state: "done", started_by: "op", started_at: T0, commit_sha: sha }));
  const n = 3;
  await db.run(db.k.insertInto("security_findings").values({
    repo: "photocraft", number: n, scan_id: 1, area: "psd", title: "Length trusted", severity: "high", urgent: 0, state: "fixing", refs: JSON.stringify([{ path: SRC, line: 1, claim: "" }]),
    reach: "open file", impact: "reads past the end", fingerprint: "fp", created_at: T0, updated_at: T0,
  }));
  const testPath = `crates/psd/tests/${regressionName(createHash("sha256").update(`photocraft#${n}`).digest("hex").slice(0, 10))}.rs`;

  const pod = fixPod(db, { top: dir, src: work, head: sha, repo: "photocraft" });
  await pod.session("security", n);
  // The first turn writes the fix, the test and a second new file; the undo turn takes the extra file back.
  pod.model((r): Record<string, string | null> => (r.parentId === undefined ? { [SRC]: FIXED, [testPath]: TEST, [EXTRA]: "#[test]\nfn more() {}\n" } : { [EXTRA]: null }),
    { status: "done", title: "Bound the read length", summary: "read returns at most 64." });
  const log: string[] = [];
  const d: FixDeps = {
    exec, root: cache, log: (l) => log.push(l), cancelled: async () => false,
    fetchCrates: async () => ({ ok: true, rust: true, crates: [{ name: "psd", dir: "crates/psd" }] }) as never,
    checkout: async () => null,
    who: async () => ({ login: "pipeline-bot", email: "bot@example.com" }),
    ask: async () => { throw new Error("the patch path is not used with fix sessions on"); },
    fixSession: () => pod.deps,
  };

  assert.match(await runFix(db, "photocraft", n, d), /round 1 queued for build/, log.join("\n"));
  assert.equal(pod.queued.length, 2);
  const [first, undo] = pod.queued;
  assert.equal(undo!.parentId, callId(1), "the undo turn continues the session");
  assert.match(undo!.stdin, /extra\.rs: a security fix adds only/);
  const round = (await db.all(db.k.selectFrom("security_fix_rounds").select(["round", "state", "patch", "test_patch", "title", "session_turn"]).where("number", "=", n)))[0]!;
  assert.equal(round.state, "building");
  assert.ok(round.session_turn !== null, "the round names the turn that wrote it");
  assert.ok(round.patch.includes(`+++ b/${SRC}`) && round.patch.includes(`+++ b/${testPath}`));
  assert.ok(!round.patch.includes("extra.rs"), "the refused file is not in the stored round");
  assert.equal(round.title, "Bound the read length");
  // Confidential: the calls and the workspace session name the security pseudo repo's item, never the repo's own items.
  const item = { repo: securityRepo("photocraft"), number: FIX_RUN_BASE + n };
  for (const q of pod.queued) assert.deepEqual(q.items, [item]);
  assert.equal(first!.promptId, "security.session");
  const sessions = await db.all(db.k.selectFrom("workspace_sessions").select(["repo", "item"]));
  assert.ok(sessions.length > 0 && sessions.every((s) => s.repo === item.repo && s.item === item.number));
});
