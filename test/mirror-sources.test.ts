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
  await db.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1), ('tool', 1); INSERT INTO repos (name, owner, visibility) VALUES ('app', 'storytold', 'public'), ('tool', 'storytold', 'private')");
  const locks: Record<string, string> = {
    app: lock([
      "git+https://github.com/storytold/harfbuzz?branch=main#0123456789abcdef",
      "git+https://github.com/Listed-Org/widgets.git?rev=abc#abc",
      "git+https://github.com/outsider/payload?branch=main#fedcba",
      "git+https://gitlab.com/storytold/elsewhere#123",
      "registry+https://github.com/rust-lang/crates.io-index",
    ]),
    tool: lock(["git+https://github.com/storytold/tool?branch=main#1"]),
  };
  let reads = 0;
  const client: Querier = {
    spent: 0, remaining: null,
    query: async (_q, vars) => {
      reads++;
      const v = vars as Record<string, string>;
      return Object.fromEntries(Object.keys(v).filter((k) => k.startsWith("e")).map((k) => {
        const repo = ({ "a1:Cargo.lock": "app", "t1:Cargo.lock": "tool" } as Record<string, string>)[v[k]!]!;
        return [`r${k.slice(1)}`, { object: { text: locks[repo], isTruncated: false } }];
      })) as never;
    },
  };
  const heads = [{ repo: "app", branch: "main", sha: "a1", committedAt: null, headline: null, checks: [] }, { repo: "tool", branch: "main", sha: "t1", committedAt: null, headline: null, checks: [] }];
  await refreshMirrorSources(db, client, heads);
  await refreshMirrorSources(db, client, heads);
  assert.equal(reads, 1, "an unmoved head is not read again");

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
  assert.ok(served.has("storytold/harfbuzz"), "a tracked owner's new git source is served");
  assert.ok(served.has("listed-org/widgets"), "a hand-listed owner's new git source is served");
  assert.ok(!served.has("outsider/payload"), "an unlisted owner's git source is not");
  assert.ok(!served.has("storytold/elsewhere"), "only github.com sources count");
  assert.ok(!served.has("storytold/tool"), "a tracked private repo is not served: the mirror fetches without credentials");
  assert.ok(served.has("storytold/craft-libs"), "the hand-kept list stays");
  assert.deepEqual([...readAllowlist(staticFile, undefined, () => {}, join(dir, "absent.txt"))!].sort(), ["listed-org/base", "storytold/craft-libs"], "a missing derived file is an empty list");
});
