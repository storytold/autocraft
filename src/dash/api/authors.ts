// GET /api/authors/:login: an author's item counts in the repos the reader may see, for the author page and the hover card on
// author names. The team mark follows the Items rows (src/data/views/items-browse.ts): a repo association of owner, member or
// collaborator, and for operators and maintainers also AutoCraft's operators, maintainers and own logins; bots have none.
import type { AuthorStats } from "../../../web/src/api/types.ts";
import { loadAuthorCounts } from "../../data/views/author-counts.ts";
import { loadInsiders } from "../../data/intake/index.ts";
import { isBotLogin } from "../../review/bots.ts";
import type { Db } from "../../db/index.ts";
import type { Req } from "../types.ts";
import { HttpError } from "../server/util.ts";
import { canSeeInternals } from "./staff.ts";
import { hiddenRepos, visibleRepos } from "./visible.ts";

/** GitHub logins, with an app's `[bot]` suffix. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

export async function stats(db: Db, req: Req): Promise<AuthorStats> {
  const login = req.params.login ?? "";
  if (!LOGIN.test(login)) throw new HttpError(400, "not a GitHub login");
  const staff = canSeeInternals(req);
  const [repos, hidden, insiders] = await Promise.all([visibleRepos(db, req), hiddenRepos(db, req), staff ? loadInsiders(db) : Promise.resolve(new Set<string>())]);
  const c = await loadAuthorCounts(db, { repos, hidden }, login);
  const name = c.login ?? login;
  const bot = c.bot || name.endsWith("[bot]") || isBotLogin(name) || name.toLowerCase() === "github-actions";
  return {
    login: name,
    team: !bot && (c.member || insiders.has(name.toLowerCase())),
    prs: { opened: c.prs, merged: c.merged, rejected: c.rejected, open: c.openPrs },
    issues: { opened: c.issues, open: c.openIssues, closed: c.issues - c.openIssues },
  };
}
