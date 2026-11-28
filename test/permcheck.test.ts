// The SID comparison of src/permcheck.ts: the suite runs on Linux, where the Windows ACL
// tool is absent, so these tests cover the pure part with fictional SIDs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACL_SCRIPT, tooOpenSids } from "../src/permcheck.ts";

const me = "S-1-5-21-111111111-222222222-333333333-1001";
const allowed = ["S-1-5-18", "S-1-5-32-544", me];

test("an ACL that grants only the current account, SYSTEM and Administrators is private", () => {
  assert.deepEqual(tooOpenSids([me, "S-1-5-18", "S-1-5-32-544"], allowed), []);
});

test("every other SID is named, an unresolved one too", () => {
  assert.deepEqual(tooOpenSids(["S-1-5-18", "S-1-5-32-545", "UNRESOLVED", "S-1-5-21-111111111-222222222-333333333-1002"], allowed), [
    "S-1-5-32-545",
    "UNRESOLVED",
    "S-1-5-21-111111111-222222222-333333333-1002",
  ]);
});

test("an account that shares a name is still its own SID: the comparison is by identity", () => {
  // OTHERMACHINE\operator and CORP\operator are distinct principals with SIDs of their own;
  // sharing the current account's display name grants nothing.
  const sameNameElsewhere = "S-1-5-21-444444444-555555555-666666666-1001";
  assert.deepEqual(tooOpenSids([sameNameElsewhere, me], allowed), [sameNameElsewhere]);
});

test("the comparison ignores SID letter case", () => {
  assert.deepEqual(tooOpenSids(["s-1-5-18", me.toLowerCase()], allowed), []);
});

test("the path reaches PowerShell as an environment variable, never as script text", () => {
  assert.ok(ACL_SCRIPT.includes("Get-Acl -LiteralPath $env:AUTOCRAFT_ACL_PATH"));
  // No quoted-path form remains, so a filename's characters - the curly apostrophes included
  // that PowerShell 5.1 also treats as quote delimiters - are data, not syntax.
  assert.ok(!ACL_SCRIPT.includes("LiteralPath '"));
  assert.ok(!ACL_SCRIPT.includes(String.fromCharCode(0x2018)));
  assert.ok(!ACL_SCRIPT.includes(String.fromCharCode(0x2019)));
});

test("a file owned by another account is refused even when the ACL grants only allowed identities", () => {
  // The owner travels in the validated collection with the grantees: on Windows an owner can
  // rewrite a clean ACL (implicit write-DAC), so an owner outside the allowed identities is access.
  const otherOwner = "S-1-5-21-444444444-555555555-666666666-1002";
  assert.deepEqual(tooOpenSids([otherOwner, "S-1-5-18", "S-1-5-32-544", me], allowed), [otherOwner]);
});

test("only Allow rules name grantees: a Deny rule excludes a trustee rather than granting it", () => {
  assert.ok(ACL_SCRIPT.includes("Where-Object { $_.AccessControlType -eq 'Allow' }"));
});
