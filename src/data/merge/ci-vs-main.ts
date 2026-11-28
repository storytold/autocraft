// PR heads' failing checks compared with the red default branch's (`ci_vs_main`), and the failing tests and locations of the
// default branch's red heads they are compared with (`main_ci_failures`). The rule is src/mainci/no-new.ts.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { headOf } from "./read.ts";
import type { HeadRef } from "./types.ts";

export type VsMainState = "not-new" | "new" | "unread" | "unparsed" | "early";
/** One PR head against the default branch's red head `mainHead`; `checks` are the failing checks found not new, `failing` those it judged. */
export type VsMainRow = { repo: string; number: number; head: string; mainHead: string; state: VsMainState; checks: string[]; failing: string[]; reason: string | null; reads: number; firstAt: string; readAt: string };
/** One failed check of a head as a comparison reads it (src/mainci/no-new.ts). */
export type CheckFailures = { steps: { step: string; keys: string[] }[]; tests: string[]; summary: string[] | null; bad: string | null; startedAt: string | null };
/** The failures of a red default-branch head, per failed check (`keys`); unread while a log could not be read, gone when GitHub no longer serves one. */
export type MainFailures = { repo: string; headSha: string; state: "read" | "unread" | "gone"; keys: Record<string, CheckFailures>; reason: string | null; readAt: string };

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  try { return text ? (JSON.parse(text) as T) : fallback; } catch { return fallback; }
};

const toRow = (r: { repo: string; number: number; head: string; main_head: string; state: string; checks: string; failing: string; reason: string | null; reads: number; first_at: string; read_at: string }): VsMainRow => ({
  repo: r.repo, number: r.number, head: r.head, mainHead: r.main_head, state: r.state as VsMainState, checks: parse<string[]>(r.checks, []), failing: parse<string[]>(r.failing, []),
  reason: r.reason, reads: Number(r.reads), firstAt: r.first_at, readAt: r.read_at,
});

/** The comparison rows of the items in `keys`, per head. 1 statement. */
export async function loadVsMain(db: Db, keys: KeySource): Promise<Map<HeadRef, VsMainRow>> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("ci_vs_main as v")
    .innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "v.repo").onRef("kk.number", "=", "v.number"))
    .select(["v.repo", "v.number", "v.head", "v.main_head", "v.state", "v.checks", "v.failing", "v.reason", "v.reads", "v.first_at", "v.read_at"])) as Parameters<typeof toRow>[0][];
  return new Map(rows.map((r) => [headOf(r.repo, r.number, r.head), toRow(r)]));
}

/** The comparison row of one PR head, or null. */
export async function loadVsMainAt(db: Db, repo: string, number: number, head: string): Promise<VsMainRow | null> {
  return (await loadVsMain(db, [{ repo, number }])).get(headOf(repo, number, head)) ?? null;
}

/** Stores the row of a PR head, replacing the one there (an earlier main head's or an earlier read's). */
export async function saveVsMain(db: Db, r: VsMainRow): Promise<void> {
  const q = queryDb(db);
  const values = { repo: r.repo, number: r.number, head: r.head, main_head: r.mainHead, state: r.state, checks: JSON.stringify(r.checks), failing: JSON.stringify(r.failing), reason: r.reason, reads: r.reads, first_at: r.firstAt, read_at: r.readAt };
  await db.write(async () => {
    await q.run(q.k.insertInto("ci_vs_main").values(values).onConflict((oc) => oc.columns(["repo", "number", "head"]).doUpdateSet((eb) => ({
      main_head: eb.ref("excluded.main_head"), state: eb.ref("excluded.state"), checks: eb.ref("excluded.checks"), failing: eb.ref("excluded.failing"), reason: eb.ref("excluded.reason"),
      reads: eb.ref("excluded.reads"), first_at: eb.ref("excluded.first_at"), read_at: eb.ref("excluded.read_at"),
    }))));
  });
}

/** The stored failures of a default-branch head, or null when none were read. */
export async function loadMainFailures(db: Db, repo: string, headSha: string): Promise<MainFailures | null> {
  const q = queryDb(db);
  const r = (await q.all(q.k.selectFrom("main_ci_failures as f").select(["f.repo", "f.head_sha", "f.state", "f.keys", "f.reason", "f.read_at"])
    .where("f.repo", "=", repo).where("f.head_sha", "=", headSha)))[0];
  return r ? { repo: r.repo, headSha: r.head_sha, state: r.state as MainFailures["state"], keys: parse<Record<string, CheckFailures>>(r.keys, {}), reason: r.reason, readAt: r.read_at } : null;
}

/** Stores the failures of a default-branch head; rows of the repo's heads main_ci no longer keeps go. */
export async function saveMainFailures(db: Db, f: MainFailures): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.insertInto("main_ci_failures").values({ repo: f.repo, head_sha: f.headSha, state: f.state, keys: JSON.stringify(f.keys), reason: f.reason, read_at: f.readAt })
      .onConflict((oc) => oc.columns(["repo", "head_sha"]).doUpdateSet((eb) => ({ state: eb.ref("excluded.state"), keys: eb.ref("excluded.keys"), reason: eb.ref("excluded.reason"), read_at: eb.ref("excluded.read_at") }))));
    await q.run(q.k.deleteFrom("main_ci_failures").where("repo", "=", f.repo)
      .where((eb) => eb.not(eb.exists(eb.selectFrom("main_ci as m").select(eb.lit(1).as("one")).where("m.repo", "=", f.repo).whereRef("m.head_sha", "=", "main_ci_failures.head_sha")))));
  });
}
