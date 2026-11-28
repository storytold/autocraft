// GET /api/maintain/browse: the Items browser. `q` is the search text with its qualifiers (src/core/item-query.ts); the server
// filters, sorts and pages over the repos the reader may see, narrowed to the picked project. `presets=1` also counts every preset
// view and lists the quick-filter values, which the page asks for with its first page only.
import type { BrowseResult, BrowseRow, BrowseStepState, PriorityLevel } from "../../../web/src/api/types.ts";
import { forReader, KIND_NAMES, parseItemQuery, PRESETS, stepValueOf } from "../../core/item-query.ts";
import { countPresets, loadBrowsePage, loadFacets, type BrowseItem, type BrowseScope } from "../../data/views/items-browse.ts";
import { loadInsiders } from "../../data/intake/index.ts";
import { WEIGHT_NORMAL } from "../../workflow/types.ts";
import type { Db } from "../../db/index.ts";
import type { Req } from "../types.ts";
import { itemState } from "./shown.ts";
import { canSeeInternals } from "./staff.ts";
import { hiddenRepos, visibleRepos } from "./visible.ts";
import { HttpError } from "../server/util.ts";
import { loadLivenessOf } from "../../data/planner/index.ts";
import { waitFor } from "./reader.ts";

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;
const OFFSET_MAX = 100_000;
const REFS_MAX = 100;
const CI: Record<string, BrowseRow["ci"]> = { SUCCESS: "green", FAILURE: "red", ERROR: "red", PENDING: "pending", EXPECTED: "pending" };

function labelsOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const STEP_STATES: readonly string[] = ["running", "waiting", "answer", "stopped"] satisfies BrowseStepState[];

/** The row's step; none for a step name this version does not know. */
function stepOf(r: BrowseItem): BrowseRow["step"] {
  const name = stepValueOf(r.step);
  return name && r.step_state && STEP_STATES.includes(r.step_state) ? { name, state: r.step_state as BrowseStepState } : null;
}

const rowOf = (r: BrowseItem): BrowseRow => ({
  repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", state: itemState(r.state), draft: Number(r.is_draft) === 1,
  title: r.title || `${r.repo}#${r.number}`, author: r.author, outside: Number(r.outside) === 1, team: Number(r.team) === 1, labels: labelsOf(r.labels),
  priority: (r.priority as PriorityLevel | null) ?? null, size: (r.size as BrowseRow["size"]) ?? null, classified: r.classified ? KIND_NAMES[r.classified] ?? r.classified : null,
  area: r.area, comments: Number(r.comments), reactions: Number(r.reactions), discord: Number(r.discord), linked: r.linked === null ? null : Number(r.linked),
  ci: r.kind === "pr" ? CI[r.ci_state ?? ""] ?? null : null, autocraft: r.autocraft as BrowseRow["autocraft"], step: stepOf(r), asksYou: Number(r.asks_me) === 1,
  approved: Number(r.approved) === 1, duplicate: Number(r.duplicate) === 1, createdAt: r.created_at ?? "", updatedAt: r.updated_at ?? "",
});

export async function browse(db: Db, req: Req): Promise<BrowseResult> {
  const staff = canSeeInternals(req);
  const query = forReader(parseItemQuery(req.query.get("q") ?? ""), staff);
  const limit = Math.min(LIMIT_MAX, Math.max(1, Number(req.query.get("limit")) || LIMIT_DEFAULT));
  const offset = Math.min(OFFSET_MAX, Math.max(0, Math.floor(Number(req.query.get("offset")) || 0)));
  const withPresets = req.query.get("presets") === "1";
  const refs = req.query.has("refs") ? (req.query.get("refs") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, REFS_MAX) : undefined;
  if (refs?.some((r) => !/^[^#\s]+#\d+$/.test(r))) throw new HttpError(400, "refs must be repo#number");
  // Viewers see the team as GitHub's associations say: AutoCraft's roles are not theirs to learn.
  const [repos, hidden, insiders] = await Promise.all([visibleRepos(db, req), hiddenRepos(db, req), staff ? loadInsiders(db) : Promise.resolve(new Set<string>())]);
  const scope: BrowseScope = { repos, hidden, staff, login: req.user.login || null, insiders: [...insiders] };
  const presets = PRESETS.map((p) => ({ id: p.id, query: forReader(parseItemQuery(p.query), staff) }));
  const [page, counts, facets] = await db.together(() => Promise.all([
    loadBrowsePage(db, scope, query, { offset, limit, normalWeight: WEIGHT_NORMAL, ...(refs && { refs }) }),
    withPresets ? countPresets(db, scope, presets) : Promise.resolve(null),
    withPresets ? loadFacets(db, scope) : Promise.resolve(null),
  ]));
  const rows = page.rows.map(rowOf);
  // A list of stuck or stale items says why each one is flagged, as the liveness check stored it.
  if (staff && query.terms.some((t) => t.key === "flag" && !t.not && t.values.some((v) => v === "stuck" || v === "stale")) && rows.length) {
    const live = await loadLivenessOf(db, rows.map((r) => `${r.repo}#${r.number}`));
    for (const r of rows) {
      const l = live.get(`${r.repo}#${r.number}`);
      if (l) r.liveness = { cause: l.cause, wait: waitFor({ hidden }, l.wait), since: l.since };
    }
  }
  return { rows, total: page.total, offset, limit, unknown: query.unknown, presets: counts, facets };
}
