import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { tasksFor } from "../src/verify/tasks.ts";

test("focused Rust verification requires a test to run across all targets", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "focused-tests-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "cargo"), `#!/bin/sh
[ "$*" = "test --offline --locked -p example -- module::tests::selected" ] || exit 2
printf 'running 0 tests\\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out\\n'
case "$TEST_OUTCOME" in
  success) printf 'running 1 test\\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\\n' ;;
  failure) exit 101 ;;
esac
`, { mode: 0o755 });
  const [task] = tasksFor({ kind: "tests", crates: ["example"], tests: ["module::tests::selected"], reason: "Verify the change" },
    { repo: "example", number: 1, head: "head", base: "base" });
  const [command, ...args] = task!.plan.find((s) => s.name === "test")!.cmd;
  const run = (outcome: string) => spawnSync(command!, args, {
    env: { ...process.env, PATH: dir + delimiter + process.env.PATH, TEST_OUTCOME: outcome }, encoding: "utf8",
  });
  const empty = run("empty");
  assert.notEqual(empty.status, 0, empty.stdout);
  assert.match(empty.stderr, /No tests ran/);
  assert.match(empty.stdout, /0 passed/);
  const passed = run("success");
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /1 passed/);
  assert.equal(run("failure").status, 101);
});

const hasCargo = spawnSync("cargo", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;

test("a missing filter in a real Rust crate fails while a matching filter passes", { skip: hasCargo ? false : "Cargo is unavailable" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "focused-rust-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A synthetic crate with one test and no dependencies, written for this test.
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "lib.rs"\n');
  writeFileSync(join(dir, "Cargo.lock"), 'version = 3\n\n[[package]]\nname = "example"\nversion = "0.1.0"\n');
  writeFileSync(join(dir, "lib.rs"), "#[test]\nfn selected() {}\n");
  const run = (filter: string) => {
    const [task] = tasksFor({ kind: "tests", crates: ["example"], tests: [filter], reason: "Verify the change" },
      { repo: "example", number: 1, head: "head", base: "base" });
    const [command, ...args] = task!.plan.find((s) => s.name === "test")!.cmd;
    return spawnSync(command!, args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
  };
  const empty = run("does_not_exist");
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /No tests ran/, empty.stderr);
  const passed = run("selected");
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /1 passed/);
  assert.match(passed.stdout, /0 passed/);
});
