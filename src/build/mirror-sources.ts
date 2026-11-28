// The crate mirror's derived git allowlist. Workspace and build pods fetch git dependencies only through the mirror, which
// serves only the repositories on its allowlist (src/cratemirror/git.ts). Besides the hand-kept list (ConfigMap
// MIRROR_ALLOWLIST_CONFIGMAP), the mirror reads MIRROR_DERIVED_CONFIGMAP, which this module keeps: the GitHub repositories
// named as git sources by the root Cargo.lock on the default branch of every tracked repo.
//  - The sync's default-branch poll (src/mainci pollMainCi) reads a repo's Cargo.lock when its head moved and stores the
//    sources it names (build_state rows; no live topic, so nothing is planned from them).
//  - The runner writes the ConfigMap when the list changed. It never creates it: the cluster's configuration does, once.
// Only default branches count, so a source added by an unmerged pull request is never served. A derived entry must be on
// github.com (the only host the mirror fetches from), belong to the owner of a tracked repo or of a hand-listed one, and be
// public (the mirror fetches without credentials): a source's visibility is checked when a Cargo.lock first names it, and a
// tracked repo whose `repos` row is private or internal is left out.
import type { Db } from "../db/index.ts";
import { normalizeRepo } from "../cratemirror/git.ts";
import { loadMirrorSources, saveMirrorSources } from "../data/build/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { envVar } from "../env.ts";
import { loadRepos } from "../data/mirror/index.ts";
import type { Head } from "../mainci/index.ts";
import { Transient, type Querier } from "../mirror.ts";
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

/** Repositories per visibility query. */
const REPOS_PER_QUERY = 30;

/** One aliased field: its variables (renamed per alias), their declarations and the field, both naming the variables `$<name>`. */
type Field = { vars: Record<string, string>; decl: string; body: string };
type Answer = { node: Record<string, unknown> | null } | { error: string };

const message = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 200);

/**
 * Asks each field under its own alias in one query. GitHub fails the whole query when one alias cannot be read (a repo that
 * is gone or that AutoCraft may not read), so then each field is asked alone and one that still fails answers its error.
 * Rate limits and other transient failures are thrown.
 */
async function perAlias(client: Querier, fields: Field[]): Promise<Answer[]> {
  const ask = async (fs: Field[]): Promise<Answer[]> => {
    const vars: Record<string, string> = {};
    const decl: string[] = [], parts: string[] = [];
    fs.forEach((f, j) => {
      const rename = (t: string) => t.replace(/\$([a-z]+)\b/g, (_m, v: string) => `$${v}${j}`);
      for (const [k, v] of Object.entries(f.vars)) vars[`${k}${j}`] = v;
      decl.push(rename(f.decl));
      parts.push(`a${j}: ${rename(f.body)}`);
    });
    const data = await client.query(`query(${decl.join(", ")}) {\n  rateLimit { cost remaining resetAt }\n  ${parts.join("\n  ")}\n}`, vars) as Record<string, Record<string, unknown> | null | undefined>;
    return fs.map((_, j) => ({ node: data[`a${j}`] ?? null }));
  };
  try {
    return await ask(fields);
  } catch (e) {
    if (e instanceof Transient) throw e;
    if (fields.length === 1) return [{ error: message(e) }];
  }
  const out: Answer[] = [];
  for (const f of fields) {
    try {
      out.push(...await ask([f]));
    } catch (e) {
      if (e instanceof Transient) throw e;
      out.push({ error: message(e) });
    }
  }
  return out;
}

type LockObject = { __typename?: string; text?: string | null; isTruncated?: boolean } | null | undefined;

/** The sources a Cargo.lock answer names, or why it could not be read (the older sources are then kept). */
function lockSources(a: Answer): { repos: string[] } | { note: string } {
  if ("error" in a) return { note: `the repository could not be read: ${a.error}` };
  if (!a.node) return { note: "the repository could not be read" };
  const obj = a.node.object as LockObject;
  if (!obj) return { repos: [] };
  if (obj.__typename !== "Blob") return { note: `Cargo.lock is a ${obj.__typename?.toLowerCase() ?? "path"}, not a file` };
  if (obj.isTruncated) return { note: "the Cargo.lock is too large to read" };
  if (typeof obj.text !== "string") return { note: "the Cargo.lock is not text" };
  return { repos: cargoLockGitRepos(obj.text) };
}

/**
 * Of `repos`, those the mirror can fetch: public on GitHub. A repo with a `repos` row takes the visibility stored there; any
 * other is asked from GitHub, and one GitHub does not show (gone, or private to AutoCraft) is left out.
 */
async function publicRepos(db: Db, client: Querier, repos: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!repos.length) return out;
  const known = new Map<string, string | null>();
  for (const r of (await loadRepos(db, { all: true })).values()) known.set(`${r.owner ?? DEFAULT_OWNER}/${r.name}`.toLowerCase(), r.visibility?.toLowerCase() ?? null);
  const ask: string[] = [];
  for (const r of repos) {
    const v = known.get(r);
    if (v === "public") out.add(r);
    else if (v == null) ask.push(r);
  }
  for (let i = 0; i < ask.length; i += REPOS_PER_QUERY) {
    const chunk = ask.slice(i, i + REPOS_PER_QUERY);
    const answers = await perAlias(client, chunk.map((r) => {
      const [owner, name] = r.split("/") as [string, string];
      return { vars: { o: owner, n: name }, decl: "$o: String!, $n: String!", body: "repository(owner: $o, name: $n) { visibility }" };
    }));
    chunk.forEach((r, j) => {
      const a = answers[j]!;
      if ("node" in a && a.node?.visibility === "PUBLIC") out.add(r);
    });
  }
  return out;
}

/** Reads the Cargo.lock of every head whose sha differs from the one its stored sources were read at, and stores the public git sources it names. Returns the repos read. */
export async function refreshMirrorSources(db: Db, client: Querier, heads: Head[], log: (line: string) => void = () => {}): Promise<number> {
  if (!heads.length) return 0;
  const [stored, rows] = await db.together(() => Promise.all([loadMirrorSources(db, heads.map((h) => h.repo)), loadRepos(db, { names: heads.map((h) => h.repo), all: true })]));
  const due = heads.filter((h) => stored.get(h.repo)?.sha !== h.sha);
  for (let i = 0; i < due.length; i += LOCKS_PER_QUERY) {
    const chunk = due.slice(i, i + LOCKS_PER_QUERY);
    const answers = await perAlias(client, chunk.map((h) => ({
      vars: { o: rows.get(h.repo)?.owner ?? DEFAULT_OWNER, n: h.repo, e: `${h.sha}:Cargo.lock` },
      decl: "$o: String!, $n: String!, $e: String!",
      body: "repository(owner: $o, name: $n) { object(expression: $e) { __typename ... on Blob { text isTruncated } } }",
    })));
    const read = chunk.map((h, j) => ({ h, was: stored.get(h.repo), got: lockSources(answers[j]!) }));
    // A source already stored was public when it was first named; only new ones are checked.
    const fresh = [...new Set(read.flatMap(({ was, got }) => ("repos" in got ? got.repos.filter((r) => !was?.repos.includes(r)) : [])))];
    const open = await publicRepos(db, client, fresh);
    const save = read.map(({ h, was, got }) => {
      const at = `${h.repo}@${h.sha.slice(0, 8)}`;
      if ("note" in got) {
        if (got.note !== was?.note) log(`crate mirror: ${at}: ${got.note}`);
        return { repo: h.repo, sources: { sha: h.sha, repos: was?.repos ?? [], note: got.note } };
      }
      const keep = got.repos.filter((r) => was?.repos.includes(r) || open.has(r));
      const added = keep.filter((r) => !was?.repos.includes(r));
      const closed = got.repos.filter((r) => !keep.includes(r));
      if (added.length) log(`crate mirror: ${at} names git source${added.length === 1 ? "" : "s"} ${added.join(", ")}`);
      if (closed.length) log(`crate mirror: ${at} names git source${closed.length === 1 ? "" : "s"} the mirror cannot fetch (not public): ${closed.join(", ")}`);
      return { repo: h.repo, sources: { sha: h.sha, repos: keep, note: null } };
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
    if (row?.visibility && row.visibility.toLowerCase() !== "public") privateRepos.add(full);
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
