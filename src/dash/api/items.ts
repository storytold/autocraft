// Items API: the top-bar search and the hover card.
import type { ItemPeek, ItemStatus, SearchHit } from "../../../web/src/api/types.ts";
import { loadItemPeek, loadQuickSearch } from "../../data/views/items.ts";
import { statusFromItem } from "../../core/item-status.ts";
import type { PlanView } from "../../core/plan-cache.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { itemState } from "./shown.ts";
import { readerOf, statusFor } from "./reader.ts";
import { needVisible, hiddenRepos } from "./visible.ts";
import type { Db } from "../../db/index.ts";

/** Top-bar search: `repo#n`, `#n` and bare numbers jump by number; a word may be an author's login; text goes through the full-text index. */
export async function quickSearch(db: Db, req: Req): Promise<SearchHit[]> {
  const rows = await loadQuickSearch(db, { hidden: await hiddenRepos(db, req) }, req.query.get("q") ?? "", { limit: 20 });
  return rows.map((r) => ({ repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", author: r.author ?? "", state: itemState(r.state) }));
}

/** The issue numbers in an item's stored closing list; a malformed list counts as none. */
export function closesOf(json: string | null): number[] {
  if (!json) return [];
  try { return (JSON.parse(json) as unknown[]).filter((x): x is number => typeof x === "number"); } catch { return []; }
}

/** `GET /api/items/:repo/:n/peek`: the item in brief for the hover card on its number; the status text is veiled as in the lists. */
export async function peek(db: Db, req: Req): Promise<ItemPeek> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  const r = await loadItemPeek(db, { repo, number: n });
  if (!r) throw new HttpError(404, `no item ${repo}#${n} in the mirror`);
  const reader = await readerOf(db, req);
  let status: ItemStatus | undefined;
  try { status = r.view ? (JSON.parse(r.view) as PlanView).status : undefined; } catch { /* a malformed view counts as none */ }
  let labels: string[] = [];
  try { labels = (JSON.parse(r.labels ?? "[]") as unknown[]).filter((x): x is string => typeof x === "string"); } catch { /* none */ }
  return {
    repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", state: itemState(r.state), title: r.title ?? "", author: r.author ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, labels,
    status: status ? statusFor(reader, r.repo, r.number, status) : statusFromItem(r, r.updated_at ?? ""),
    closes: r.kind === "pr" ? closesOf(r.closing_issues) : [],
  };
}
