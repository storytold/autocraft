// The crate mirror's derived git allowlist: a git source on a tracked repo's default-branch Cargo.lock reaches the mirror
// when its owner is a tracked or hand-listed one, and never when it is not.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MirrorAllowlistWriter, refreshMirrorSources } from "../src/build/mirror-sources.ts";
import type { KConfigMap } from "../src/build/kube-api.ts";
import { readAllowlist } from "../src/cratemirror/git.ts";
import type { Querier } from "../src/mirror.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

const lock = (sources: string[]) => sources.map((s, i) => `[[package]]\nname = "p${i}"\nversion = "0.1.0"\nsource = "${s}"\n`).join("\n");

test("derived git allowlist: new default-branch git sources of allowed owners reach the mirror, others do not", async () => {
  const db = await connectDb(":memory:");
  await db.script(`INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1), ('tool', 1), ('gone', 1), ('folder', 1);
    INSERT INTO repos (name, owner, visibility) VALUES ('app', 'storytold', 'public'), ('tool', 'storytold', 'private'), ('gone', 'storytold', 'public'), ('folder', 'storytold', 'public')`);
  const locks: Record<string, string> = {
    app: lock([
      "git+https://github.com/storytold/harfbuzz?branch=main#0123456789abcdef",
      "git+https://github.com/Listed-Org/widgets.git?rev=abc#abc",
      "git+https://github.com/outsider/payload?branch=main#fedcba",
      "git+https://github.com/storytold/secret-dep?branch=main#1",
      "git+https://gitlab.com/storytold/elsewhere#123",
      "registry+https://github.com/rust-lang/crates.io-index",
    ]),
    tool: lock(["git+https://github.com/storytold/tool?branch=main#1"]),
  };
  const visibility: Record<string, string> = { "storytold/secret-dep": "PRIVATE" };
  let reads = 0;
  const client: Querier = {
    spent: 0, remaining: null,
    query: async (_q, vars) => {
      reads++;
      const v = vars as Record<string, string>;
      const js = Object.keys(v).filter((k) => k.startsWith("n")).map((k) => k.slice(1));
      // GitHub fails the whole query when one alias names a repo it cannot read.
      if (js.some((j) => v[`n${j}`] === "gone")) throw new Error("graphql error: NOT_FOUND");
      return Object.fromEntries(js.map((j) => {
        const name = v[`n${j}`]!;
        if (!v[`e${j}`]) return [`a${j}`, { visibility: visibility[`${v[`o${j}`]}/${name}`] ?? "PUBLIC" }];
        return [`a${j}`, { object: name === "folder" ? { __typename: "Tree" } : name in locks ? { __typename: "Blob", text: locks[name], isTruncated: false } : null }];
      })) as never;
    },
  };
  const head = (repo: string, sha: string) => ({ repo, branch: "main", sha, committedAt: null, headline: null, checks: [] });
  const heads = [head("app", "a1"), head("tool", "t1"), head("gone", "g1"), head("folder", "f1")];
  const lines: string[] = [];
  await refreshMirrorSources(db, client, heads, (l) => lines.push(l));
  const after = reads;
  await refreshMirrorSources(db, client, heads);
  assert.equal(reads, after, "an unmoved head is not read again");
  assert.ok(lines.some((l) => /folder@f1: Cargo\.lock is a tree, not a file/.test(l)), "a Cargo.lock that is not a file gets its own note");

  const maps = new Map<string, KConfigMap>([
    ["crate-mirror-git-allowlist", { metadata: { name: "crate-mirror-git-allowlist" }, data: { "allowlist.txt": "storytold/craft-libs\nlisted-org/base\n" } }],
    ["crate-mirror-git-derived", { metadata: { name: "crate-mirror-git-derived" }, data: { "allowlist.txt": "" } }],
  ]);
  const writer = new MirrorAllowlistWriter({
    getConfigMap: async (_ns, name) => maps.get(name) ?? null,
    patchConfigMap: async (_ns, name, patch) => void maps.set(name, { ...maps.get(name)!, data: (patch as { data: Record<string, string> }).data }),
  }, { namespace: "craft-cache", now: () => 0, log: () => {} });
  await writer.pass(db);
  assert.equal(writer.note, null);

  const dir = mkdtempSync(join(SCRATCH, "mirror-sources-"));
  const staticFile = join(dir, "allowlist.txt"), derivedFile = join(dir, "derived.txt");
  writeFileSync(staticFile, maps.get("crate-mirror-git-allowlist")!.data!["allowlist.txt"]!);
  writeFileSync(derivedFile, maps.get("crate-mirror-git-derived")!.data!["allowlist.txt"]!);
  const served = readAllowlist(staticFile, undefined, () => {}, derivedFile)!;
  assert.ok(served.has("storytold/harfbuzz"), "a tracked owner's new git source is served, although another repo in the same query could not be read");
  assert.ok(!served.has("storytold/secret-dep"), "an untracked source GitHub shows as private is not served");
  assert.ok(served.has("listed-org/widgets"), "a hand-listed owner's new git source is served");
  assert.ok(!served.has("outsider/payload"), "an unlisted owner's git source is not");
  assert.ok(!served.has("storytold/elsewhere"), "only github.com sources count");
  assert.ok(!served.has("storytold/tool"), "a tracked private repo is not served: the mirror fetches without credentials");
  assert.ok(served.has("storytold/craft-libs"), "the hand-kept list stays");
  assert.deepEqual([...readAllowlist(staticFile, undefined, () => {}, join(dir, "absent.txt"))!].sort(), ["listed-org/base", "storytold/craft-libs"], "a missing derived file is an empty list");
});
