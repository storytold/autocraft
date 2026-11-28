// The crate mirror's derived git allowlist. Workspace and build pods fetch git dependencies only through the mirror, which
// serves only the repositories on its allowlist (src/cratemirror/git.ts). Besides the hand-kept list (ConfigMap
// MIRROR_ALLOWLIST_CONFIGMAP), the mirror reads MIRROR_DERIVED_CONFIGMAP, which this module keeps: the GitHub repositories
// named as git sources by the root Cargo.lock on the default branch of every tracked repo.
//  - The sync's default-branch poll (src/mainci pollMainCi) reads a repo's Cargo.lock when its head moved and stores the
//    sources it names (build_state rows; no live topic, so nothing is planned from them).
//  - The runner writes the ConfigMap when the list changed. It never creates it: the cluster's configuration does, once.
// Only default branches count, so a source added by an unmerged pull request is never served. A derived entry must be on
// github.com (the only host the mirror fetches from), belong to the owner of a tracked repo or of a hand-listed one, and
// not be a tracked private repo (the mirror fetches without credentials).
import type { Db } from "../db/index.ts";
import { normalizeRepo } from "../cratemirror/git.ts";
import { loadMirrorSources, saveMirrorSources, type MirrorSources } from "../data/build/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { envVar } from "../env.ts";
import { loadRepos } from "../data/mirror/index.ts";
import type { Head } from "../mainci/index.ts";
import type { Querier } from "../mirror.ts";
import { DEFAULT_OWNER } from "../owners.ts";
import { MIRROR_ALLOWLIST_CONFIGMAP, MIRROR_ALLOWLIST_DATA_KEY, MIRROR_DERIVED_CONFIGMAP, parseAllowlist } from "./caches.ts";
import type { ConfigMapApi } from "./kube-api.ts";

export { MIRROR_DERIVED_CONFIGMAP };
/** The runner compares the list with the ConfigMap at most this often. */
export const WRITE_EVERY_MS = 60_000;
/** Cargo.lock blobs per query: they can be several hundred KB each. */
const LOCKS_PER_QUERY = 10;

/** The GitHub repositories (`owner/repo`, lower case) that a Cargo.lock names as git sources, sorted. */
export function cargoLockGitRepos(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^source = "git\+https:\/\/github\.com\/([^"?#]+)/gm)) {
    const r = normalizeRepo(m[1]!);
    if (r) out.add(r);
  }
  return [...out].sort();
}

type BlobNode = { object?: { text?: string | null; isTruncated?: boolean } | null } | null;

/** Reads the Cargo.lock of every head whose sha differs from the one its stored sources were read at, and stores what it names. Returns the repos read. */
export async function refreshMirrorSources(db: Db, client: Querier, heads: Head[], log: (line: string) => void = () => {}): Promise<number> {
  if (!heads.length) return 0;
  const [stored, rows] = await db.together(() => Promise.all([loadMirrorSources(db, heads.map((h) => h.repo)), loadRepos(db, { names: heads.map((h) => h.repo), all: true })]));
  const due = heads.filter((h) => stored.get(h.repo)?.sha !== h.sha);
  for (let i = 0; i < due.length; i += LOCKS_PER_QUERY) {
    const chunk = due.slice(i, i + LOCKS_PER_QUERY);
    const vars: Record<string, string> = {};
    const parts = chunk.map((h, j) => {
      vars[`o${j}`] = rows.get(h.repo)?.owner ?? DEFAULT_OWNER;
      vars[`e${j}`] = `${h.sha}:Cargo.lock`;
      return `r${j}: repository(owner: $o${j}, name: ${JSON.stringify(h.repo)}) { object(expression: $e${j}) { ... on Blob { text isTruncated } } }`;
    });
    const query = `query(${chunk.map((_, j) => `$o${j}: String!, $e${j}: String!`).join(", ")}) {\n  rateLimit { cost remaining resetAt }\n  ${parts.join("\n  ")}\n}`;
    const data = await client.query(query, vars) as Record<string, BlobNode | undefined>;
    const save: { repo: string; sources: MirrorSources }[] = [];
    chunk.forEach((h, j) => {
      const obj = data[`r${j}`]?.object;
      const was = stored.get(h.repo);
      let sources: MirrorSources;
      if (!obj) sources = { sha: h.sha, repos: [], note: null };
      else if (typeof obj.text !== "string" || obj.isTruncated) sources = { sha: h.sha, repos: was?.repos ?? [], note: "the Cargo.lock is too large to read" };
      else sources = { sha: h.sha, repos: cargoLockGitRepos(obj.text), note: null };
      if (sources.note && sources.note !== was?.note) log(`crate mirror: ${h.repo}@${h.sha.slice(0, 8)}: ${sources.note}`);
      const before = new Set(was?.repos ?? []);
      const added = sources.repos.filter((r) => !before.has(r));
      if (added.length) log(`crate mirror: ${h.repo}@${h.sha.slice(0, 8)} names git source${added.length === 1 ? "" : "s"} ${added.join(", ")}`);
      save.push({ repo: h.repo, sources });
    });
    await saveMirrorSources(db, save);
  }
  return due.length;
}

/** The derived allowlist: the stored git sources of the tracked repos that pass the owner and visibility rules, sorted. `listed`: the hand-kept list. */
export async function derivedAllowlist(db: Db, listed: Iterable<string>): Promise<string[]> {
  const tracked = [...(await loadTrackedRepos(db)).keys()];
  const [sources, rows] = await db.together(() => Promise.all([loadMirrorSources(db, tracked), loadRepos(db, { names: tracked, all: true })]));
  const owners = new Set<string>();
  const privateRepos = new Set<string>();
  for (const name of tracked) {
    const row = rows.get(name);
    const full = `${row?.owner ?? DEFAULT_OWNER}/${name}`.toLowerCase();
    owners.add(full.split("/")[0]!);
    if (row?.visibility?.toLowerCase() === "private") privateRepos.add(full);
  }
  for (const r of listed) owners.add(r.split("/")[0]!.toLowerCase());
  const out = new Set<string>();
  for (const s of sources.values()) for (const r of s.repos) if (owners.has(r.split("/")[0]!) && !privateRepos.has(r)) out.add(r);
  return [...out].sort();
}

/** The ConfigMap text of a derived list, read back by parseAllowlist and the mirror's readAllowlist. */
export const derivedText = (repos: string[]): string =>
  `# Written by AutoCraft: the git sources named by the default-branch Cargo.lock of the tracked repos.\n${repos.map((r) => `${r}\n`).join("")}`;

/** The runner's half: writes MIRROR_DERIVED_CONFIGMAP when the derived list differs from what it holds. */
export class MirrorAllowlistWriter {
  private at = -Infinity;
  private lastNote: string | null = null;
  /** Why the last pass could not write (null when it could). */
  note: string | null = null;
  private readonly api: Pick<ConfigMapApi, "getConfigMap" | "patchConfigMap">;
  private readonly o: { namespace: string; now: () => number; log: (line: string) => void };
  constructor(api: Pick<ConfigMapApi, "getConfigMap" | "patchConfigMap">, o: { namespace: string; now: () => number; log: (line: string) => void }) {
    this.api = api;
    this.o = o;
  }

  private warn(m: string) {
    if (m !== this.lastNote) this.o.log(`crate mirror: ${m}`);
    this.lastNote = m;
    this.note = m;
  }

  async pass(db: Db): Promise<void> {
    if (this.o.now() - this.at < WRITE_EVERY_MS) return;
    this.at = this.o.now();
    const ns = this.o.namespace;
    try {
      const listed = (await this.api.getConfigMap(ns, envVar("MIRROR_ALLOWLIST_CONFIGMAP") ?? MIRROR_ALLOWLIST_CONFIGMAP))?.data?.[MIRROR_ALLOWLIST_DATA_KEY];
      const repos = await derivedAllowlist(db, parseAllowlist(listed ?? ""));
      const cm = await this.api.getConfigMap(ns, MIRROR_DERIVED_CONFIGMAP);
      if (!cm) return this.warn(`ConfigMap ${MIRROR_DERIVED_CONFIGMAP} is missing in ${ns}, so the mirror serves only its hand-kept git allowlist`);
      const was = cm.data?.[MIRROR_ALLOWLIST_DATA_KEY];
      const next = derivedText(repos);
      if (next !== was) {
        await this.api.patchConfigMap(ns, MIRROR_DERIVED_CONFIGMAP, { data: { [MIRROR_ALLOWLIST_DATA_KEY]: next } });
        const before = new Set(parseAllowlist(was ?? ""));
        const now = new Set(repos);
        const added = repos.filter((r) => !before.has(r)), removed = [...before].filter((r) => !now.has(r));
        this.o.log(`crate mirror: derived git allowlist${added.length ? ` added ${added.join(", ")}` : ""}${removed.length ? ` removed ${removed.join(", ")}` : ""}`);
      }
      this.lastNote = null;
      this.note = null;
    } catch (e) {
      this.warn((e as Error).message.slice(0, 300));
    }
  }
}
