// The new Home's and Items page's mock reads: started items of several repos, so each role sees what it may act on.
import { heldItems } from "./heldMock";
import { browseFor } from "./browseMock";
import type { Api } from "../client";
import type { ItemPhase, MaintainCommandResult, MaintainHome, MaintainItemGroup, MaintainItemRow, MaintainItems, MaintainItemsQuery, MaintainRepo, MaintainRow, MaintainStats, User } from "../types";
import { requestProject } from "../scope";
import { NOW } from "./fixtures";
import { itemsListPath, itemsPath } from "../../lib/links";

const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const row = (r: Partial<MaintainRow> & Pick<MaintainRow, "repo" | "number" | "title" | "line">): MaintainRow => ({
  kind: "pr", author: "pixel-wrangler", entry: "review", waits: false, blocked: false, weight: null, startedBy: "kiri-n", approvedBy: null, stoppedBy: null, updatedAt: ago(5), ...r,
});

type HomeSeed = MaintainRow & { asks?: string[]; lastBy?: string; lastText?: string; done?: "merged" | "closed" };
const ROWS: HomeSeed[] = [
  row({ repo: "deckcraft", number: 77, kind: "issue", title: "Export speaker notes", author: "brushstroke42", line: "Running the full test suite in the workspace", entry: "implement", weight: "high", startedBy: "ochre-fox", updatedAt: ago(6) }),
  row({ repo: "photocraft", number: 798, title: "Layer panel keeps the selection after undo", author: "quietgrid", line: "The author pushed 2 commits after your approval. Review them, fix what it finds, then merge?", waits: true, blocked: true, approvedBy: "ochre-fox", updatedAt: ago(9) }),
  { ...row({ repo: "designcraft", number: 455, title: "Snap guides ignore hidden layers", author: "sable-ui", line: "Fix the hidden-group case, then merge, rename included?", waits: true, startedBy: "kiri-n", updatedAt: ago(26) }), asks: ["kiri-n", "ochre-fox"] },
  row({ repo: "photocraft", number: 840, title: "Selection tools: four changes", author: "pixel-wrangler", line: "Waiting for CI in batch #41", entry: "merge", startedBy: "ochre-fox", approvedBy: "ochre-fox", updatedAt: ago(30) }),
  row({ repo: "wordcraft", number: 233, title: "Tracked changes lose the author on paste", author: "rhea-m", line: "Merge as it is?", waits: true, startedBy: "ochre-fox", updatedAt: ago(40) }),
  { ...row({ repo: "craft-libs", number: 517, title: "Improve startup time", author: "wren-lat", line: "I understood “merge” but not “after the release”. Merge both changes as they are?", waits: true, startedBy: "kiri-n", updatedAt: ago(20) }), asks: ["kiri-n"] },
  { ...row({ repo: "gridcraft", number: 977, title: "Range spill: keep neighbouring cells when a formula grows", author: "saltmarsh-ink", line: "Held by ochre-fox", startedBy: "ochre-fox", stoppedBy: "ochre-fox", updatedAt: ago(170) }), lastBy: "ochre-fox", lastText: "hold" },
  row({ repo: "designcraft", number: 1484, title: "Add Hungarian spellchecking and nonstandard hyphenation", author: "rhea-m", line: "Merge with the dictionary, or drop it and load the language pack?", waits: true, entry: "fixup", startedBy: "kiri-n", updatedAt: ago(190) }),
];
/** Finished items for Home's own-items list (the Items page lists them under Done). */
const DONE_ROWS: HomeSeed[] = [
  { ...row({ repo: "photocraft", number: 812, title: "Crop handles snap past the canvas edge", author: "larkspur-dev", line: "Merged into main with both fixes. The post-merge review of my changes found nothing.", startedBy: "ochre-fox", approvedBy: "ochre-fox", updatedAt: ago(211) }), done: "merged" },
  { ...row({ repo: "designcraft", number: 390, title: "Ruler units follow the document setting", author: "sable-ui", line: "Merged into main.", startedBy: "kiri-n", approvedBy: "ochre-fox", updatedAt: ago(22 * 60) }), done: "merged" },
];
/** The reader's own items for Home: newest conversation entry first, each with its last line. */
function ownRows(login: string, repo: string | null): MaintainRow[] {
  const lastOf = (r: HomeSeed): MaintainRow => {
    const { asks, lastBy, lastText, done, ...out } = r;
    return { ...out, ...(done && { state: done }), last: { by: lastBy ?? "AutoCraft", text: lastText ?? r.line ?? "", question: !!asks?.includes(login) || (r.waits && !asks && involves(r, login)) } };
  };
  return [...ROWS, ...DONE_ROWS].filter((r) => (!repo || r.repo === repo) && involves(r, login)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(lastOf);
}
const involves = (r: { startedBy?: string | null; approvedBy?: string | null; stoppedBy?: string | null; asks?: string[] }, login: string) =>
  r.startedBy === login || r.approvedBy === login || r.stoppedBy === login || !!r.asks?.includes(login);

// ---- Items ----

type ItemSeed = Partial<MaintainItemRow> & Pick<MaintainItemRow, "repo" | "number" | "title" | "group"> & { phase?: ItemPhase; waiting?: string | null; next?: string | null; rank?: number; sec?: boolean; asks?: string[] };
const item = (s: ItemSeed): ItemSeed => s;
const ITEMS: ItemSeed[] = [
  ...ROWS.map(({ lastBy: _l, lastText: _t, done: _d, ...r }, i) => item({ ...r, group: "started", asked: r.waits ? r.updatedAt : null, rank: 40 - i })),
  item({ repo: "photocraft", number: 812, title: "Crop handles snap past the canvas edge", author: "larkspur-dev", group: "done", state: "merged", phase: "Merged", rank: 0, startedBy: "ochre-fox", approvedBy: "ochre-fox", updatedAt: ago(211), merged: { at: ago(219), how: "approval" } }),
  item({ repo: "photocraft", number: 851, title: "Brush size slider jumps on high-DPI screens", author: "larkspur-dev", group: "automatic", phase: "In queue", waiting: "CI on the PR (4 of 5 checks done)", next: "merge when CI is green", area: "Canvas", rank: 30 }),
  item({ repo: "designcraft", number: 461, title: "Guides menu shows twice after reload", author: "sable-ui", group: "automatic", phase: "Review", waiting: null, next: "review the PR", area: "Canvas", rank: 22 }),
  item({ repo: "pdfcraft", number: 1204, kind: "issue", title: "Crash when placing an encrypted PDF page", author: "brushstroke42", group: "automatic", phase: "Fixing", waiting: null, next: "write the fix", area: "PDF import", rank: 35, sec: true }),
  item({ repo: "photocraft", number: 866, kind: "issue", title: "Exported PNG loses the colour profile", author: "night-owl-77", group: "rest", phase: "Triage", rank: 28, area: "Export" }),
  item({ repo: "photocraft", number: 867, kind: "issue", title: "Exported PNG drops the embedded colour profile", author: "palette-jo", group: "rest", phase: "Triage", duplicate: true, area: "Export", rank: 27 }),
  item({ repo: "wordcraft", number: 241, title: "Add a word count to the status bar", author: "first-timer-9", group: "rest", phase: "Held", waiting: "the author's daily limit", outside: true, area: "Text", rank: 12 }),
  item({ repo: "filmcraft", number: 318, title: "Timeline thumbnails flicker while scrubbing", author: "quietgrid", group: "rest", phase: "Waiting for a person", waiting: "a person, nobody is asked", stuck: true, rank: 18 }),
  item({ repo: "deckcraft", number: 90, kind: "issue", title: "Speaker view should show the next slide", author: "rhea-m", group: "rest", phase: "Triage", rank: 8 }),
  item({ repo: "vectorcraft", number: 512, title: "Boolean union leaves a hairline gap", author: "pixel-wrangler", group: "rest", phase: "Pipeline off", rank: 15, area: "Canvas" }),
  item({ repo: "photocraft", number: 702, kind: "issue", title: "Support JPEG XL import", author: "brushstroke42", group: "backlog", phase: "Held", waiting: "the Backlog", rank: 5 }),
  item({ repo: "designcraft", number: 390, title: "Ruler units follow the document setting", author: "sable-ui", group: "done", state: "merged", phase: "Merged", rank: 0, startedBy: "kiri-n", approvedBy: "ochre-fox", merged: { at: ago(300), how: "approval" } }),
  item({ repo: "photocraft", number: 779, title: "Clone stamp keeps its source when the tool changes", author: "larkspur-dev", group: "done", state: "merged", phase: "Merged", rank: 0, merged: { at: ago(45), how: "rule" } }),
  item({ repo: "wordcraft", number: 219, title: "Paragraph spacing survives a paste from another document", author: "rhea-m", group: "done", state: "merged", phase: "Merged", rank: 0, merged: { at: ago(130), how: "batch" } }),
  item({ repo: "deckcraft", number: 61, title: "Slide numbers restart in each section", author: "brushstroke42", group: "done", state: "closed", phase: "Closed", rank: 0 }),
];

const ZERO: Record<MaintainItemGroup, number> = { started: 0, automatic: 0, rest: 0, backlog: 0, done: 0 };
const ORDER: MaintainItemGroup[] = ["started", "automatic", "rest", "backlog", "done"];
const WEIGHTS: Record<string, number> = { urgent: 10, high: 8, low: 2 };

function itemsFor(me: User, query: MaintainItemsQuery): MaintainItems {
  const repo = requestProject();
  const show = query.show ?? "open";
  const staff = me.role !== "viewer";
  if (!staff && query.filters?.some((f) => f === "security" || f === "stuck")) throw new Error("only operators and maintainers filter by security findings or stuck items");
  const text = query.q?.trim().toLowerCase();
  const hits = query.refs;
  const shown = ITEMS.filter((s) => {
    if (repo && s.repo !== repo) return false;
    if (show === "merged" ? !s.merged : show === "closed" ? s.group !== "done" : show === "backlog" ? s.group !== "backlog" : s.group === "done" || s.group === "backlog") return false;
    if (text && !`${s.repo}#${s.number} ${s.title}`.toLowerCase().includes(text)) return false;
    if (hits && !hits.includes(`${s.repo}#${s.number}`)) return false;
    for (const f of query.filters ?? []) {
      if (f === "security" && !s.sec) return false;
      if (f === "outside" && !s.outside) return false;
      if (f === "stuck" && !s.stuck) return false;
      if (f === "duplicates" && !s.duplicate) return false;
    }
    if (query.areas?.length && !query.areas.some((a) => (a === "none" ? !s.area : a === s.area))) return false;
    return true;
  });
  const weight = (s: ItemSeed) => (s.weight ? (WEIGHTS[s.weight] ?? 5) : 5);
  const order = (a: ItemSeed, b: ItemSeed) =>
    show === "merged" ? b.merged!.at.localeCompare(a.merged!.at) :
    query.sort === "updated" ? (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") : weight(b) - weight(a) || (b.rank ?? 0) - (a.rank ?? 0);
  const counts = { ...ZERO };
  for (const s of shown) counts[s.group]++;
  const limit = query.limit ?? 50;
  const rows = ORDER.flatMap((g) => shown.filter((s) => s.group === g).sort(order).slice(0, limit)).map((s): MaintainItemRow => {
    const started = s.group === "started";
    const { phase, waiting, next, rank: _r, sec: _s, asks: _a, merged, ...rest } = s;
    return {
      kind: "pr", state: "open", author: null, line: null, status: null, blocked: false, asked: null, weight: null, startedBy: null, approvedBy: null, stoppedBy: null,
      duplicate: false, outside: false, area: null, updatedAt: ago(60 + (s.number % 300)), ...rest,
      ...(started ? {} : { status: { phase: phase ?? "Triage", waiting: staff ? (waiting ?? null) : null, next: next ?? null, since: ago(90) } }),
      stuck: staff && !!s.stuck, ...(show === "merged" && { merged }),
      may: me.runRepos.includes(s.repo),
    };
  });
  return { rows, counts };
}

function commandFor(me: User, text: string, ticked: string[] = []): MaintainCommandResult {
  const m = ticked.length ? null : /^([^:\n]+):([\s\S]*)$/.exec(text.trim());
  const refs = ticked.length ? ticked : m ? m[2]!.split(/[\s,]+/).filter(Boolean) : [];
  const words = (m ? m[1]! : text).trim();
  if (!refs.length || !/^(review|fix-up|implement|merge|backlog|close|hold|resume|stop)\b/i.test(words)) {
    const line = `Not run: "${text.trim().split("\n")[0]}" is not clear. Write a command, then a colon and the items, e.g. "merge: photocraft#123".`;
    return { items: [], lines: [line] };
  }
  const items = refs.map((ref) => {
    const [repo, n] = ref.split("#");
    const ok = me.runRepos.includes(repo ?? "");
    const line = ok ? (/^review and merge\b/i.test(words) ? `Reviewing, then merging when CI is green, by ${me.login} at 14:05. Reply hold to halt.` : `${words} by ${me.login} at 14:05.`) : `${me.login} has no write access to ${repo}.`;
    return { repo: repo ?? "", number: Number(n), outcome: ok ? ("run" as const) : ("refused" as const), line, workflowId: ok ? 1 : null };
  });
  return { items, lines: items.map((i) => `${i.repo}#${i.number}: ${i.line}`) };
}

const REPOS: MaintainRepo[] = [
  { name: "photocraft", automatic: true, canRun: false, open: 186, started: 9, waiting: 3, mergedWeek: 31, trips: [{ key: "cifix:photocraft", text: "CI fixes paused on photocraft: failed 5 times in an hour", since: ago(95), canResume: false }] },
  { name: "designcraft", automatic: true, canRun: false, open: 94, started: 3, waiting: 1, mergedWeek: 12, trips: [] },
  { name: "wordcraft", automatic: false, canRun: false, open: 41, started: 0, waiting: 0, mergedWeek: 6, trips: [] },
  { name: "deckcraft", automatic: false, canRun: false, open: 32, started: 1, waiting: 0, mergedWeek: 3, trips: [] },
];

export function createMaintainMock(me: User): Pick<Api, "maintain"> {
  const repos = structuredClone(REPOS);
  return {
    maintain: {
      async queue() {
        return { approvedBy: { "designcraft#307": "ochre-fox", "designcraft#744": "kiri-n", "designcraft#779": "ochre-fox" },
          held: [...heldItems].map(([ref, h]) => ({ repo: ref.split("#")[0]!, number: Number(ref.split("#")[1]), ...h })),
        };
      },
      async stats(period): Promise<MaintainStats> {
        const n = period === "30d" ? 30 : 7;
        const perDay = Array.from({ length: n }, (_, i) => ({ day: new Date(Date.now() - (n - 1 - i) * 86400_000).toISOString().slice(0, 10), n: [14, 22, 9, 17, 25, 6, 3, 19, 21, 12][i % 10]! }));
        const merged = perDay.reduce((a, d) => a + d.n, 0);
        return new Promise((r) => setTimeout(() => r({ period, merged, implemented: Math.round(merged / 6), reviewed: Math.round(merged * 1.4), backlog: 25308, backlogChange: period === "30d" ? -212 : -48, spend: period === "30d" ? 412 : 96, perDay }), 60));
      },
      items: (query) => new Promise((r, j) => setTimeout(() => { try { r(structuredClone(itemsFor(me, query))); } catch (e) { j(e); } }, 60)),
      browse: (query) => new Promise((r) => setTimeout(() => r(structuredClone(browseFor(me, query))), 60)),
      command: (text, opts) => new Promise((r) => setTimeout(() => r(commandFor(me, text, opts?.items)), 120)),
      async repos(): Promise<MaintainRepo[]> {
        const mine = repos.map((r) => ({ ...r, canRun: me.runRepos.includes(r.name), trips: r.trips.map((t) => ({ ...t, canResume: me.runRepos.includes(r.name) })) }));
        return new Promise((res) => setTimeout(() => res(structuredClone(mine)), 60));
      },
      async asked() {
        return { count: ownRows(me.login, null).filter((r) => r.last?.question).length };
      },
      async control(input) {
        if (input.control === "set-automatic") {
          const r = repos.find((x) => x.name === input.repo);
          if (r) r.automatic = input.on;
          return { ok: true, line: `Automatic work is ${input.on ? "on" : "off"} for ${input.repo}.` };
        }
        for (const r of repos) r.trips = r.trips.filter((t) => t.key !== input.key);
        return { ok: true, line: `Resumed ${input.key}.` };
      },
      async home(): Promise<MaintainHome> {
        const repo = requestProject();
        const rows = ROWS.filter((r) => !repo || r.repo === repo);
        const own = ownRows(me.login, repo);
        const staff = me.role !== "viewer", operator = me.role === "operator";
        const all: (MaintainHome["attention"][number] & { repo?: string })[] = [
          { kind: "stopped", repo: "photocraft", title: "Merge queued pull requests in photocraft", detail: staff ? "the post-merge review of photocraft#8455 found 1 defect" : "", to: itemsListPath([{ repo: "photocraft", number: 8455 }]),
            ...(me.runRepos.includes("photocraft") && { action: { kind: "resume-breaker", key: "merge:photocraft" } as const }) },
          { kind: "stopped", title: "first-timer-9", detail: staff ? "2 PRs, 1 issue waiting for the author's daily limit" : "", to: itemsPath("is:outside-held author:first-timer-9"),
            ...(operator && { action: { kind: "release-author", author: "first-timer-9" } as const }) },
          { kind: "health", title: "5 open items have not changed for days", detail: "", to: itemsPath("is:stale") },
          { kind: "stuck", title: "Review was stopped (job 91234: ran past its 40 minute limit)", detail: "", to: "/pipeline/91234", ...(operator && { action: { kind: "ack-deadline", step: "review" } as const }) },
          ...(staff ? [{ kind: "gave-up" as const, repo: "designcraft", title: "designcraft#1855: CI fix gave up", detail: "Bump the PDF writer to the new font subsetter", to: itemsListPath([{ repo: "designcraft", number: 1855 }]) }] : []),
        ];
        const attention: MaintainHome["attention"] = all.filter((p) => !repo || !p.repo || p.repo === repo).map(({ repo: _r, ...p }) => p);
        const home: MaintainHome =
          me.role === "viewer"
            ? { mine: [], mineTotal: 0, recent: [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8), runner: null, attention }
            : {
                mine: own.slice(0, 8),
                mineTotal: own.length,
                recent: [],
                runner: me.role === "operator" ? { mine: [{ name: "desk-1", online: true, running: 1 }], others: 2 } : { mine: [], others: 3 },
                attention,
              };
        return new Promise((r) => setTimeout(() => r(structuredClone(home)), 60));
      },
    },
  };
}
