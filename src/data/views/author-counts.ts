// reads: mirror.items
// An author's items in the repos a reader may see, counted in one statement: pull requests opened, merged, closed without a merge
// and open; issues opened, open and closed. The mirror keeps who merged a pull request but not who closed one, so a pull request
// closed without a merge counts as rejected whoever closed it.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { hiddenRepos } from "../control/fragments.ts";
import type { Scope } from "./types.ts";

const MAINTAINER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

export type AuthorCountsRow = {
  /** The login as the mirror spells it; null when the author has no item in the scope. */
  login: string | null;
  prs: number; merged: number; rejected: number; openPrs: number; issues: number; openIssues: number;
  /** Some item of theirs carries an owner, member or collaborator association. */
  member: boolean;
  /** GitHub marks the author as a bot. */
  bot: boolean;
};

export async function loadAuthorCounts(db: Db, scope: Pick<Scope, "repos" | "hidden">, login: string): Promise<AuthorCountsRow> {
  const none: AuthorCountsRow = { login: null, prs: 0, merged: 0, rejected: 0, openPrs: 0, issues: 0, openIssues: 0, member: false, bot: false };
  if (!scope.repos.length) return none;
  const qd = queryDb(db);
  const k = qd.k as any;
  const count = (eb: any, when: any) => eb.fn.sum(eb.case().when(when).then(1).else(0).end());
  const row = (await qd.get(k.selectFrom("main.items as i")
    .where((eb: any) => eb.and([kx.nocaseEq(db, "i.author", eb.val(login)), kx.inList(db, "i.repo", scope.repos), hiddenRepos(db, "i.repo", scope.hidden)]))
    .select((eb: any) => {
      const pr = eb("i.kind", "=", "pr");
      const issue = eb("i.kind", "=", "issue");
      return [
        eb.fn.min("i.author").as("login"),
        count(eb, pr).as("prs"),
        count(eb, eb.and([pr, eb("i.state", "=", "MERGED")])).as("merged"),
        count(eb, eb.and([pr, eb("i.state", "=", "CLOSED")])).as("rejected"),
        count(eb, eb.and([pr, eb("i.state", "=", "OPEN")])).as("open_prs"),
        count(eb, issue).as("issues"),
        count(eb, eb.and([issue, eb("i.state", "=", "OPEN")])).as("open_issues"),
        eb.fn.max(eb.case().when(eb(eb.fn.coalesce("i.author_association", eb.val("")), "in", MAINTAINER_ASSOCIATIONS)).then(1).else(0).end()).as("member"),
        eb.fn.max(eb.case().when(eb(eb.fn.coalesce("i.author_type", eb.val("")), "=", "Bot")).then(1).else(0).end()).as("bot"),
      ];
    }))) as Record<string, unknown> | undefined;
  if (!row?.login) return none;
  const n = (v: unknown) => Number(v ?? 0);
  return {
    login: String(row.login), prs: n(row.prs), merged: n(row.merged), rejected: n(row.rejected), openPrs: n(row.open_prs), issues: n(row.issues),
    openIssues: n(row.open_issues), member: n(row.member) === 1, bot: n(row.bot) === 1,
  };
}
