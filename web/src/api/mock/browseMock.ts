// The Items browser's mock: about fifty items of several repos, matched by the same query grammar the server parses.
import { forReader, itemOfValue, KINDS, parseItemQuery, PRESETS, type ItemQuery, type QueryTerm } from "../../../../src/core/item-query.ts";
import type { AuthorStats, BrowseQuery, BrowseResult, BrowseRow, User } from "../types";
import { requestProject } from "../scope";
import { NOW } from "./fixtures";

const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
type Seed = Partial<BrowseRow> & Pick<BrowseRow, "repo" | "number" | "title"> & { mine?: boolean; replied?: boolean; text?: string; held?: boolean; verdict?: "stuck" | "stale" };
const s = (x: Seed): Seed => x;

const SEEDS: Seed[] = [
  s({ repo: "photocraft", number: 8533, kind: "issue", title: "Terminated by signal SIGSEGV when opening a large TIFF", author: "liimed", outside: true, labels: ["bug", "priority: critical", "needs info"], priority: "P0", classified: "bug", area: "Import", comments: 7, reactions: 4, discord: 3, updated: 0.4 } as Seed),
  s({ repo: "photocraft", number: 8538, kind: "pr", title: "Keep the brush preview inside the canvas bounds", author: "quietgrid", labels: ["bug"], priority: "P2", size: "S", classified: "bug", area: "Brushes", comments: 1, ci: "green", autocraft: "stopped", updated: 0.8 } as Seed),
  s({ repo: "photocraft", number: 8540, kind: "pr", title: "Guard the TIFF strip reader against a zero row count", author: "kiri-n", labels: ["bug"], priority: "P0", size: "S", classified: "bug", area: "Import", comments: 2, linked: 8533, ci: "green", autocraft: "running", updated: 0.6 } as Seed),
  s({ repo: "photocraft", number: 8521, kind: "pr", title: "Crop handles snap past the canvas edge", author: "larkspur-dev", outside: true, labels: ["bug", "canvas"], priority: "P1", size: "M", classified: "bug", area: "Canvas", comments: 5, ci: "green", autocraft: "waiting", asksYou: true, approved: true, mine: true, updated: 1.1 } as Seed),
  s({ repo: "photocraft", number: 8519, kind: "pr", title: "Layer panel keeps the selection after undo", author: "quietgrid", labels: ["bug"], priority: "P1", size: "S", classified: "bug", area: "Layers", comments: 3, ci: "green", autocraft: "running", approved: true, updated: 1.5, ready: true } as Seed),
  s({ repo: "photocraft", number: 8517, kind: "issue", title: "Exported PNG loses the colour profile", author: "night-owl-77", outside: true, labels: [], priority: "P2", classified: "bug", area: "Export", comments: 0, updated: 2 } as Seed),
  s({ repo: "photocraft", number: 8516, kind: "issue", title: "Exported PNG drops the embedded colour profile", author: "palette-jo", outside: true, labels: [], priority: "P2", classified: "bug", area: "Export", comments: 1, duplicate: true, updated: 2.2 } as Seed),
  s({ repo: "photocraft", number: 8510, kind: "issue", title: "Brush size slider jumps on high-DPI screens", author: "brushstroke42", outside: true, labels: ["bug", "hidpi"], priority: "P1", classified: "bug", area: "Canvas", comments: 12, reactions: 9, discord: 5, replied: true, updated: 3 } as Seed),
  s({ repo: "photocraft", number: 8502, kind: "pr", title: "Selection tools: four changes", author: "pixel-wrangler", labels: ["enhancement"], priority: "P2", size: "L", classified: "feature", area: "Selection", comments: 9, ci: "red", autocraft: "running", mine: true, updated: 4 } as Seed),
  s({ repo: "photocraft", number: 8498, kind: "issue", title: "Support JPEG XL import", author: "brushstroke42", outside: true, labels: ["enhancement", "file-compat"], priority: "P3", classified: "feature", area: "Import", comments: 21, reactions: 30, discord: 2, autocraft: "backlog", replied: true, updated: 6 } as Seed),
  s({ repo: "photocraft", number: 8490, kind: "issue", title: "Clone stamp keeps its source when the tool changes", author: "larkspur-dev", labels: ["bug"], priority: "P2", classified: "bug", area: "Tools", comments: 4, linked: 8491, replied: true, updated: 8 } as Seed),
  s({ repo: "photocraft", number: 8491, kind: "pr", title: "Reset the clone source on tool change", author: "larkspur-dev", labels: ["bug"], priority: "P2", size: "S", classified: "bug", area: "Tools", comments: 1, linked: 8490, ci: "pending", autocraft: "running", updated: 7.5 } as Seed),
  s({ repo: "photocraft", number: 8480, kind: "issue", title: "Healing brush leaves a seam on 16-bit images", author: "first-timer-9", outside: true, labels: ["bug"], priority: "P1", classified: "bug", area: "Tools", comments: 0, held: true, updated: 30 } as Seed),
  s({ repo: "photocraft", number: 8477, kind: "pr", title: "Add a word for the curve presets in the Levels dialog", author: "first-timer-9", outside: true, draft: true, labels: [], priority: "P4", size: "S", classified: "extra", comments: 0, ci: "pending", held: true, updated: 40 } as Seed),
  s({ repo: "photocraft", number: 8470, kind: "issue", title: "Gradient tool dithering looks banded on wide-gamut screens", author: "hue-shift", outside: true, labels: ["bug", "color"], priority: "P2", classified: "bug", area: "Color", comments: 3, reactions: 2, updated: 50 } as Seed),
  s({ repo: "photocraft", number: 8462, kind: "issue", title: "Plugin API: expose the active layer's mask", author: "plugin-smith", outside: true, labels: ["plugins"], priority: "P3", classified: "plugin", comments: 6, discord: 1, replied: true, updated: 70 } as Seed),
  s({ repo: "photocraft", number: 8455, kind: "pr", title: "Speed up the histogram for large documents", author: "kiri-n", labels: ["performance"], priority: "P2", size: "M", classified: "perf", area: "Canvas", comments: 2, ci: "green", autocraft: "done", state: "merged", updated: 20 } as Seed),
  s({ repo: "photocraft", number: 8431, kind: "pr", title: "Draw the histogram on the GPU", author: "kiri-n", labels: ["performance"], priority: "P3", size: "L", classified: "perf", area: "Canvas", comments: 6, ci: "red", state: "closed", updated: 60 } as Seed),
  s({ repo: "photocraft", number: 8402, kind: "issue", title: "Histogram ignores the selection on 16-bit images", author: "kiri-n", labels: ["bug"], priority: "P2", classified: "bug", area: "Canvas", comments: 2, state: "closed", updated: 120 } as Seed),
  s({ repo: "photocraft", number: 8440, kind: "issue", title: "Crash on paste from a remote desktop clipboard", author: "remote-ray", outside: true, labels: [], priority: "P1", classified: "bug", area: "Clipboard", comments: 0, updated: 90 } as Seed),
  s({ repo: "designcraft", number: 1882, kind: "issue", title: "Documents cannot be reopened after saving only as IDML", author: "kicrows", outside: true, labels: ["priority: critical", "file-compat", "needs info"], priority: "P0", classified: "bug", area: "Files", comments: 8, reactions: 3, discord: 4, duplicate: false, replied: true, updated: 1.2 } as Seed),
  s({ repo: "designcraft", number: 1880, kind: "pr", title: "Keep the native document beside an IDML export", author: "ochre-fox", labels: ["bug"], priority: "P0", size: "M", classified: "bug", area: "Files", comments: 4, linked: 1882, ci: "green", autocraft: "waiting", approved: false, mine: true, updated: 1.4 } as Seed),
  s({ repo: "designcraft", number: 1873, kind: "issue", title: "Snap guides ignore hidden layers", author: "sable-ui", labels: ["bug", "guides"], priority: "P2", classified: "bug", area: "Canvas", comments: 2, updated: 5 } as Seed),
  s({ repo: "designcraft", number: 1870, kind: "pr", title: "Guides menu shows twice after reload", author: "sable-ui", labels: ["bug"], priority: "P2", size: "S", classified: "bug", area: "Canvas", comments: 1, ci: "green", autocraft: "running", approved: true, updated: 5.5, ready: true } as Seed),
  s({ repo: "designcraft", number: 1866, kind: "issue", title: "Text frames overflow when the font is missing", author: "type-nerd", outside: true, labels: ["text"], priority: "P2", classified: "bug", area: "Text", comments: 0, updated: 26 } as Seed),
  s({ repo: "designcraft", number: 1860, kind: "issue", title: "Ruler units should follow the document setting", author: "sable-ui", labels: ["enhancement"], priority: "P3", classified: "feature", area: "Canvas", comments: 3, autocraft: "held", updated: 33 } as Seed),
  s({ repo: "designcraft", number: 1855, kind: "pr", title: "Bump the PDF writer to the new font subsetter", author: "deps-bot", labels: ["dependencies"], priority: "P3", size: "S", classified: "infra", comments: 0, ci: "red", updated: 48 } as Seed),
  s({ repo: "designcraft", number: 1851, kind: "issue", title: "Master pages: allow a different margin on facing pages", author: "layout-lu", outside: true, labels: ["enhancement"], priority: "P3", classified: "feature", area: "Pages", comments: 14, reactions: 11, discord: 6, replied: true, updated: 60 } as Seed),
  s({ repo: "designcraft", number: 1840, kind: "issue", title: "Table cell strokes double when exporting to PDF", author: "grid-gal", outside: true, labels: [], priority: "P1", classified: "bug", area: "Tables", comments: 0, verdict: "stale", updated: 120 } as Seed),
  s({ repo: "wordcraft", number: 233, kind: "pr", title: "Tracked changes lose the author on paste", author: "rhea-m", labels: ["bug", "track-changes"], priority: "P1", size: "M", classified: "bug", area: "Review", comments: 6, ci: "green", autocraft: "waiting", asksYou: true, mine: true, updated: 2.5 } as Seed),
  s({ repo: "wordcraft", number: 241, kind: "pr", title: "Add a word count to the status bar", author: "first-timer-9", outside: true, labels: [], priority: "P4", size: "S", classified: "extra", area: "Text", comments: 0, ci: "green", held: true, updated: 18 } as Seed),
  s({ repo: "wordcraft", number: 238, kind: "issue", title: "Footnotes renumber wrongly after a section break", author: "foot-note", outside: true, labels: ["bug"], priority: "P1", classified: "bug", area: "Text", comments: 3, reactions: 5, discord: 2, updated: 9 } as Seed),
  s({ repo: "wordcraft", number: 230, kind: "issue", title: "Spell check ignores words with apostrophes", author: "lexi-k", outside: true, labels: ["bug", "spelling"], priority: "P2", classified: "bug", area: "Proofing", comments: 2, replied: true, updated: 15 } as Seed),
  s({ repo: "wordcraft", number: 226, kind: "issue", title: "Styles pane: search by style name", author: "rhea-m", labels: ["enhancement"], priority: "P3", classified: "feature", area: "Styles", comments: 1, updated: 44 } as Seed),
  s({ repo: "wordcraft", number: 219, kind: "pr", title: "Paragraph spacing survives a paste from another document", author: "rhea-m", labels: ["bug"], priority: "P2", size: "S", classified: "bug", area: "Text", comments: 2, ci: "green", autocraft: "done", state: "merged", updated: 22 } as Seed),
  s({ repo: "wordcraft", number: 212, kind: "issue", title: "Comments sidebar overlaps the page at 125% zoom", author: "zoom-zoe", outside: true, labels: [], priority: null, comments: 0, verdict: "stuck", updated: 100 } as Seed),
  s({ repo: "deckcraft", number: 1987, kind: "issue", title: "Presentation mode crashes at 2x HiDPI on XWayland", author: "mathias-dw", outside: true, labels: ["bug", "priority: critical", "linux"], priority: "P0", classified: "bug", area: "Presenter", comments: 5, reactions: 6, discord: 7, replied: true, updated: 3.5 } as Seed),
  s({ repo: "deckcraft", number: 77, kind: "issue", title: "Export speaker notes", author: "brushstroke42", outside: true, labels: ["enhancement"], priority: "P2", classified: "feature", area: "Export", comments: 4, autocraft: "running", mine: true, updated: 12 } as Seed),
  s({ repo: "deckcraft", number: 90, kind: "issue", title: "Speaker view should show the next slide", author: "rhea-m", labels: ["enhancement"], priority: "P3", classified: "feature", area: "Presenter", comments: 2, updated: 28 } as Seed),
  s({ repo: "deckcraft", number: 61, kind: "pr", title: "Slide numbers restart in each section", author: "brushstroke42", outside: true, labels: ["bug"], priority: "P2", size: "S", classified: "bug", comments: 3, state: "closed", ci: "red", updated: 80 } as Seed),
  s({ repo: "deckcraft", number: 95, kind: "issue", title: "Transitions stutter on the first slide", author: "anim-andy", outside: true, labels: [], priority: "P2", classified: "perf", area: "Presenter", comments: 0, verdict: "stale", updated: 140 } as Seed),
  s({ repo: "pdfcraft", number: 1204, kind: "issue", title: "Crash when placing an encrypted PDF page", author: "brushstroke42", outside: true, labels: ["bug", "security"], priority: "P0", classified: "bug", area: "PDF import", comments: 2, autocraft: "running", updated: 2.8 } as Seed),
  s({ repo: "pdfcraft", number: 1199, kind: "issue", title: "Annotations vanish after a save as PDF/A", author: "archivist", outside: true, labels: ["bug", "pdf-a"], priority: "P1", classified: "bug", area: "Export", comments: 6, reactions: 2, discord: 1, replied: true, updated: 10 } as Seed),
  s({ repo: "pdfcraft", number: 1195, kind: "pr", title: "Read cross-reference streams with a missing trailer", author: "kiri-n", labels: ["bug"], priority: "P1", size: "M", classified: "bug", area: "PDF import", comments: 3, ci: "green", autocraft: "running", approved: true, updated: 11, ready: true } as Seed),
  s({ repo: "pdfcraft", number: 1190, kind: "issue", title: "Form fields: tab order follows the creation order", author: "form-fan", outside: true, labels: [], priority: "P3", classified: "feature", area: "Forms", comments: 0, verdict: "stuck", updated: 160 } as Seed),
  s({ repo: "pdfcraft", number: 1185, kind: "issue", title: "Redaction tool leaves the text layer under the box", author: "priv-pat", outside: true, labels: ["bug"], priority: "P0", classified: "bug", area: "Redaction", comments: 1, updated: 36 } as Seed),
  s({ repo: "filmcraft", number: 318, kind: "pr", title: "Timeline thumbnails flicker while scrubbing", author: "quietgrid", labels: ["bug"], priority: "P2", size: "M", classified: "bug", area: "Timeline", comments: 4, ci: "pending", autocraft: "held", updated: 14 } as Seed),
  s({ repo: "filmcraft", number: 23, kind: "issue", title: "ALSA audio error on startup", author: "artemis-arrow", outside: true, labels: [], priority: "P1", classified: "bug", area: "Audio", comments: 6, reactions: 1, verdict: "stale", updated: 220 } as Seed),
  s({ repo: "filmcraft", number: 106, kind: "issue", title: "Underrun on RHEL 10.2 with PipeWire", author: "ripvoltage", outside: true, labels: [], priority: "P2", classified: "bug", area: "Audio", comments: 1, discord: 1, verdict: "stale", updated: 200 } as Seed),
  s({ repo: "filmcraft", number: 330, kind: "issue", title: "Proxy files for 8K footage", author: "cine-cat", outside: true, labels: ["enhancement"], priority: "P3", classified: "feature", area: "Media", comments: 10, reactions: 14, discord: 3, replied: true, updated: 16 } as Seed),
  s({ repo: "vectorcraft", number: 512, kind: "pr", title: "Boolean union leaves a hairline gap", author: "pixel-wrangler", labels: ["bug"], priority: "P2", size: "S", classified: "bug", area: "Paths", comments: 2, ci: "green", updated: 19 } as Seed),
  s({ repo: "vectorcraft", number: 509, kind: "issue", title: "Offset path creates self-intersections on tight curves", author: "bezier-bo", outside: true, labels: ["bug", "geometry"], priority: "P1", classified: "bug", area: "Paths", comments: 3, updated: 24 } as Seed),
  s({ repo: "vectorcraft", number: 505, kind: "issue", title: "SVG import drops gradient transforms", author: "svg-sam", outside: true, labels: [], priority: "P2", classified: "bug", area: "Import", comments: 0, verdict: "stale", updated: 180 } as Seed),
  s({ repo: "vectorcraft", number: 514, kind: "pr", title: "Draft: snap anchor points to the pixel grid", author: "ochre-fox", draft: true, labels: ["enhancement", "snapping"], priority: "P3", size: "XL", classified: "feature", area: "Paths", comments: 3, ci: "red", updated: 0.9 } as Seed),
  s({ repo: "vectorcraft", number: 500, kind: "pr", title: "CI: cache the font corpus between jobs", author: "ochre-fox", labels: ["ci"], priority: "P4", size: "S", classified: "infra", comments: 0, ci: "green", autocraft: "done", state: "merged", updated: 66 } as Seed),
];

type Extra = { mine: boolean; replied: boolean; ready: boolean; held: boolean; verdict: "stuck" | "stale" | null };
const ROWS: (BrowseRow & Extra)[] = SEEDS.map((x) => {
  const r = x as Seed & { updated?: number; ready?: boolean };
  const h = r.updated ?? 10;
  return {
    kind: "issue", state: "open", draft: false, author: null, outside: false, team: !r.outside && !!r.author && !r.author.endsWith("-bot"), labels: [], priority: null, size: null, classified: null, area: null,
    comments: 0, reactions: 0, discord: 0, linked: null, ci: null, autocraft: "none", asksYou: false, approved: false, duplicate: false,
    ...r, createdAt: ago(h * 3 + r.number % 17), updatedAt: ago(h), mine: !!r.mine, replied: !!r.replied, ready: !!r.ready, held: !!r.held, verdict: r.verdict ?? null,
  } as BrowseRow & Extra;
});

type Row = (typeof ROWS)[number];

function termHolds(r: Row, t: QueryTerm): boolean {
  const any = (f: (v: string) => boolean) => t.values.some(f);
  switch (t.key) {
    case "type": return any((v) => r.kind === v);
    case "state": return any((v) => r.state === v);
    case "label": return any((v) => r.labels.some((l) => l.toLowerCase() === v.toLowerCase()));
    case "priority": return any((v) => r.priority === v);
    case "size": return any((v) => r.size === v);
    case "kind": return any((v) => r.classified === v || KINDS[v] === r.classified);
    case "repo": return any((v) => r.repo === v);
    case "author": return any((v) => (r.author ?? "").toLowerCase() === v.toLowerCase());
    case "area": return any((v) => (v === "none" ? r.area === null : (r.area ?? "").toLowerCase() === v.toLowerCase()));
    case "discord": return r.discord > 0;
    case "ci": return any((v) => r.ci === v);
    case "review": return r.ready;
    case "autocraft": return any((v) => r.autocraft === v);
    case "items": return any((v) => {
      const i = itemOfValue(v);
      return !!i && i.repo === r.repo && i.number === r.number && (!i.owner || i.owner === "storytold");
    });
    case "has": return any((v) => v === "pr" ? r.linked !== null : v === "label" ? r.labels.length > 0 : v === "priority" ? r.priority !== null : v === "area" ? r.area !== null
      : v === "kind" ? r.classified !== null : v === "discord" ? r.discord > 0 : r.replied);
    case "flag": return t.values.every((v) => v === "draft" ? r.kind === "pr" && r.state === "open" && r.draft : v === "ready" ? r.kind === "pr" && r.state === "open" && !r.draft : v === "outside" ? r.outside : v === "mine" ? r.mine : v === "asked" ? r.asksYou
      : v === "approved" ? r.approved : v === "duplicate" ? r.duplicate : v === "security" ? r.labels.includes("security") : v === "outside-held" ? r.held : v === "stuck" || v === "stale" ? r.verdict === v : false);
  }
}

const matches = (r: Row, q: ItemQuery, repo: string | null): boolean => {
  if (repo && r.repo !== repo) return false;
  if (q.numbers.length && !q.numbers.includes(r.number)) return false;
  if (q.text && !q.text.toLowerCase().split(/\s+/).every((w) => r.title.toLowerCase().includes(w.replace(/"/g, "")))) return false;
  return q.terms.every((t) => termHolds(r, t) !== t.not);
};

const WEIGHT: Record<string, number> = { P0: 5, P1: 4, P2: 3, P3: 2, P4: 1 };
function sorted(rows: Row[], q: ItemQuery): Row[] {
  const key = (r: Row): number | string => {
    switch (q.sort.by) {
      case "created": return r.createdAt;
      case "comments": return r.comments + r.reactions;
      case "discord": return r.discord;
      case "priority": return WEIGHT[r.priority ?? ""] ?? 0;
      default: return r.updatedAt;
    }
  };
  const dir = q.sort.asc ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir || (a.updatedAt < b.updatedAt ? 1 : -1);
  });
}

export function browseFor(me: User, query: BrowseQuery): BrowseResult {
  const staff = me.role !== "viewer";
  const repo = requestProject();
  const q = forReader(parseItemQuery(query.q), staff);
  const hit = (r: Row) => !query.refs || query.refs.includes(`${r.repo}#${r.number}`);
  const found = ROWS.filter((r) => hit(r) && matches(r, q, repo));
  const livenessShown = staff && q.terms.some((t) => t.key === "flag" && !t.not && t.values.some((v) => v === "stuck" || v === "stale"));
  const all = query.refs ? found.sort((a, b) => query.refs!.indexOf(`${a.repo}#${a.number}`) - query.refs!.indexOf(`${b.repo}#${b.number}`)) : sorted(found, q);
  const offset = query.offset ?? 0, limit = query.limit ?? 50;
  const open = ROWS.filter((r) => r.state === "open" && (!repo || r.repo === repo));
  const top = (vs: string[]) => [...vs.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
  return {
    rows: all.slice(offset, offset + limit).map(({ mine: _m, replied: _r, ready: _x, held: _h, verdict: l, ...row }) =>
      (l && livenessShown ? { ...row, liveness: l === "stuck" ? { cause: "no-plan", wait: null, since: row.updatedAt } : { cause: "external", wait: "CI on the new head", since: row.updatedAt } } : row)),
    total: all.length, offset, limit, unknown: q.unknown,
    presets: query.presets ? Object.fromEntries(PRESETS.map((p) => [p.id, ROWS.filter((r) => matches(r, forReader(parseItemQuery(p.query), staff), repo)).length])) : null,
    facets: query.presets ? { labels: top(open.flatMap((r) => r.labels)), authors: top(open.flatMap((r) => (r.author ? [r.author] : []))), areas: top(open.flatMap((r) => (r.area ? [r.area] : []))) } : null,
  };
}

/** An author's counts over every mock item, as GET /api/authors/<login> counts them; the team mark as the rows show it. */
export function authorStatsFor(login: string): AuthorStats {
  const mine = ROWS.filter((r) => (r.author ?? "").toLowerCase() === login.toLowerCase());
  const prs = mine.filter((r) => r.kind === "pr");
  const issues = mine.filter((r) => r.kind === "issue");
  return {
    login: mine[0]?.author ?? login,
    team: mine.some((r) => r.team),
    prs: { opened: prs.length, merged: prs.filter((r) => r.state === "merged").length, rejected: prs.filter((r) => r.state === "closed").length, open: prs.filter((r) => r.state === "open").length },
    issues: { opened: issues.length, open: issues.filter((r) => r.state === "open").length, closed: issues.filter((r) => r.state !== "open").length },
  };
}
