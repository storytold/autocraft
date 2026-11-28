// The Items browser's search grammar, shared by the server (src/data/views/items-browse.ts), the web page and its mock.
// A query is words and qualifiers, GitHub style: `is:pr is:open label:bug sort:updated crash`. A qualifier is `key:value`, a
// comma list of values matches any of them, a leading `-` negates it, and `"quoted text"` keeps spaces in a value or a phrase.
// Words that are no qualifier are the full-text search; `#123` matches the number. `items:craft-libs/3217,designcraft/12` lists
// items by `[owner/]repo/number`: exactly those items, and none for a repo that is not tracked. Qualifiers this file does not know
// are returned in `unknown`, so the page can say they were not applied.
import type { StepName } from "../workflow/status.ts";

export type QueryKey =
  | "type" | "state" | "label" | "priority" | "area" | "author" | "repo" | "kind" | "size" | "discord" | "has" | "ci" | "review" | "autocraft" | "step" | "flag" | "items";

/** One qualifier: all its values are alternatives; `not` negates the whole term. Values are normalised (see VALUES). */
export type QueryTerm = { key: QueryKey; values: string[]; not: boolean };
export type SortKey = "updated" | "created" | "comments" | "priority" | "discord";
export type ItemQuery = { terms: QueryTerm[]; text: string; numbers: number[]; sort: { by: SortKey; asc: boolean }; unknown: string[] };

export const SORTS: readonly SortKey[] = ["updated", "created", "comments", "priority", "discord"];
export const DEFAULT_SORT: SortKey = "updated";

/** `is:` flags beyond type and state. `draft`: an open draft pull request; `ready`: an open pull request that is not a draft (`draft:true` and `draft:false` are the same terms); `outside`: the author is not an owner, member or collaborator; `mine`: I started, approved, held or answered it; `stuck` and `stale`: the liveness check's verdicts (src/liveness.ts). */
export const FLAGS = ["draft", "ready", "outside", "mine", "asked", "approved", "duplicate", "security", "stuck", "stale", "outside-held"] as const;
/** Flags only operators and maintainers may filter by. */
export const STAFF_FLAGS: readonly string[] = ["security", "stuck", "stale"];
/** Qualifiers only operators and maintainers may filter by: a review verdict says something about a quiet security pull request. */
export const STAFF_KEYS: readonly QueryKey[] = ["review"];

/**
 * `q` as a reader sees it: for viewers, the terms they may not filter by move to `unknown`, so the page shows them as not
 * applied. Used by the server and the mock alike.
 */
export function forReader(q: ItemQuery, staff: boolean): ItemQuery {
  if (staff) return q;
  const barred = (t: QueryTerm) => STAFF_KEYS.includes(t.key) || (t.key === "flag" && t.values.some((v) => STAFF_FLAGS.includes(v)));
  const text = (t: QueryTerm) => `${t.not ? "-" : ""}${t.key === "flag" ? "is" : t.key}:${t.values.join(",")}`;
  return { ...q, terms: q.terms.filter((t) => !barred(t)), unknown: [...q.unknown, ...q.terms.filter(barred).map(text)] };
}
/** `has:` / `no:` facts. `response`: a comment by a maintainer of the repo. */
export const HAS = ["pr", "label", "priority", "area", "kind", "discord", "response"] as const;
/** Classification labels by their short name. */
export const KINDS: Record<string, string> = {
  bug: "bugfix", perf: "performance", feature: "missing feature", extra: "small extra", plugin: "plugin candidate", infra: "infra",
};
export const KIND_NAMES: Record<string, string> = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));
export const AUTOCRAFT_STATES = ["running", "waiting", "stopped", "held", "backlog", "done", "none"] as const;
/**
 * `step:` values: the step a live workflow is at, by a short name, and the step as the workflow stores it (src/workflow/status.ts
 * StepName). `recommend` is an item back with its recommendation.
 */
export const STEPS = {
  implement: "implement", review: "review", "fix-up": "fix-up", "review-again": "review again", update: "update from main", "fix-ci": "fix CI and conflicts",
  batch: "batch", merge: "merge", recommend: "recommend", "new-commits": "review new commits",
} as const satisfies Record<string, StepName>;
export type StepValue = keyof typeof STEPS;
/** The `step:` value of a stored step name; null for a name it does not know. */
export const stepValueOf = (name: string | null): StepValue | null =>
  (Object.keys(STEPS) as StepValue[]).find((k) => STEPS[k] === name) ?? null;
export const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const;
export const SIZES = ["S", "M", "L", "XL"] as const;
export const CI_STATES = ["green", "red", "pending"] as const;

const MAX_VALUES = 20;
/** Items one `items:` term lists: as many as one command takes. */
export const MAX_ITEMS = 100;
const MAX_TOKENS = 40;
const OWNER_PART = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";
const ITEM_VALUE = new RegExp(`^(?:(${OWNER_PART})/)?([A-Za-z0-9._-]{1,100})[/#](\\d{1,9})$`);

/** An `items:` value as its parts: `owner/repo/12`, `repo/12` (owner null), or the same with `#`; null for anything else. */
export function itemOfValue(v: string): { owner: string | null; repo: string; number: number } | null {
  const m = ITEM_VALUE.exec(v.trim());
  const number = m ? Number(m[3]) : 0;
  return m && number > 0 ? { owner: m[1] ?? null, repo: m[2]!, number } : null;
}

/** The longest query the parser reads. */
export const QUERY_MAX = 4000;

/**
 * The `items:` term of these items (`repo` may carry its owner, `owner/repo`): at most MAX_ITEMS of them and no longer than a
 * query can be. An owner that is the repo's own (`ownerOf`) is left out, so the term stays short.
 */
export function itemsTerm(items: readonly { repo: string; number: number }[], ownerOf?: (repo: string) => string): string {
  const out: string[] = [];
  let length = "items:".length;
  for (const i of items.slice(0, MAX_ITEMS)) {
    const slash = i.repo.lastIndexOf("/");
    const name = i.repo.slice(slash + 1);
    const own = slash > 0 && ownerOf && ownerOf(name).toLowerCase() === i.repo.slice(0, slash).toLowerCase();
    const v = `${own ? name : i.repo}/${i.number}`;
    if (length + v.length + 1 > QUERY_MAX) break;
    out.push(v);
    length += v.length + 1;
  }
  return `items:${out.join(",")}`;
}

/** Validates and normalises one value of `key`; null when it is not a value of that key. */
function value(key: QueryKey, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  switch (key) {
    case "type": return lower === "pr" || lower === "issue" ? lower : null;
    case "state": return ["open", "closed", "merged"].includes(lower) ? lower : null;
    case "priority": {
      const p = /^p?([0-4])$/i.exec(v);
      return p ? `P${p[1]}` : null;
    }
    case "size": return (SIZES as readonly string[]).includes(v.toUpperCase()) ? v.toUpperCase() : null;
    case "kind": return KINDS[lower] ? lower : KIND_NAMES[lower] ?? null;
    case "discord": return lower === "mentioned" ? lower : null;
    case "has": return (HAS as readonly string[]).includes(lower) ? lower : null;
    case "ci": return (CI_STATES as readonly string[]).includes(lower) ? lower : lower === "success" ? "green" : lower === "failure" ? "red" : null;
    case "review": return lower === "clean" ? lower : null;
    case "autocraft": return (AUTOCRAFT_STATES as readonly string[]).includes(lower) ? lower : null;
    case "step": return Object.hasOwn(STEPS, lower) ? lower : lower === "fixup" ? "fix-up" : null;
    case "flag": return (FLAGS as readonly string[]).includes(lower) ? lower : null;
    case "area": return lower === "none" ? "none" : v;
    case "items": {
      const i = itemOfValue(v);
      return i ? `${i.owner ? `${i.owner}/` : ""}${i.repo}/${i.number}` : null;
    }
    default: return v;
  }
}

/** The tokens of `q`: words, `key:value` with quoted values, quoted phrases, each with its leading `-`. */
export function tokens(q: string): string[] {
  const out: string[] = [];
  const re = /-?(?:[A-Za-z-]+:)?"[^"]*"?|\S+/g;
  const s = q.slice(0, QUERY_MAX);
  for (let m = re.exec(s); m && out.length < MAX_TOKENS; m = re.exec(s)) out.push(m[0]);
  return out;
}

const unquote = (s: string) => s.replace(/^"/, "").replace(/"$/, "");

/** `is:` values that are a type or a state; the rest are flags. */
function isTerm(v: string): { key: QueryKey; value: string } | null {
  const lower = v.toLowerCase();
  if (lower === "pr" || lower === "issue") return { key: "type", value: lower };
  if (lower === "open" || lower === "closed" || lower === "merged") return { key: "state", value: lower };
  return (FLAGS as readonly string[]).includes(lower) ? { key: "flag", value: lower } : null;
}

const ALIASES: Record<string, QueryKey> = {
  type: "type", state: "state", label: "label", priority: "priority", area: "area", author: "author", repo: "repo", kind: "kind", size: "size",
  discord: "discord", has: "has", ci: "ci", review: "review", autocraft: "autocraft", step: "step", items: "items",
};

export function parseItemQuery(q: string): ItemQuery {
  const terms: QueryTerm[] = [];
  const words: string[] = [];
  const numbers: number[] = [];
  const unknown: string[] = [];
  let sort: ItemQuery["sort"] = { by: DEFAULT_SORT, asc: false };
  for (const tok of tokens(q)) {
    const not = tok.startsWith("-") && tok.length > 1;
    const body = not ? tok.slice(1) : tok;
    const colon = body.indexOf(":");
    const num = /^#(\d{1,9})$/.exec(body);
    if (num && !not) {
      numbers.push(Number(num[1]));
      continue;
    }
    if (colon <= 0 || body.startsWith('"')) {
      words.push(tok);
      continue;
    }
    const name = body.slice(0, colon).toLowerCase();
    const raw = unquote(body.slice(colon + 1));
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, name === "items" ? MAX_ITEMS : MAX_VALUES);
    if (name === "sort" && !not) {
      const m = /^([a-z]+)(-asc|-desc)?$/.exec(raw.toLowerCase());
      if (m && (SORTS as readonly string[]).includes(m[1]!)) sort = { by: m[1] as SortKey, asc: m[2] === "-asc" };
      else unknown.push(tok);
      continue;
    }
    if (name === "is") {
      const got = parts.map(isTerm);
      if (!got.length || got.some((g) => !g) || new Set(got.map((g) => g!.key)).size > 1) {
        unknown.push(tok);
        continue;
      }
      terms.push({ key: got[0]!.key, values: got.map((g) => g!.value), not });
      continue;
    }
    if (name === "draft") {
      const v = raw.toLowerCase();
      if (v === "true" || v === "false") terms.push({ key: "flag", values: [v === "true" ? "draft" : "ready"], not });
      else unknown.push(tok);
      continue;
    }
    if (name === "no") {
      const vs = parts.map((p) => value("has", p));
      if (!vs.length || vs.some((v) => !v)) unknown.push(tok);
      else terms.push({ key: "has", values: vs as string[], not: !not });
      continue;
    }
    const key = ALIASES[name];
    if (key === "items") {
      // A pasted list keeps the items that read; only the others are not applied.
      const good = parts.map((p) => value("items", p));
      const bad = parts.filter((_, i) => good[i] === null);
      const vs = [...new Set(good.filter((v): v is string => v !== null))];
      if (vs.length) terms.push({ key, values: vs, not });
      if (bad.length || !vs.length) unknown.push(`${not ? "-" : ""}items:${(bad.length ? bad : parts).join(",")}`);
      continue;
    }
    const vs = key ? parts.map((p) => value(key, p)) : [];
    if (!key || !vs.length || vs.some((v) => v === null)) {
      unknown.push(tok);
      continue;
    }
    terms.push({ key, values: [...new Set(vs as string[])], not });
  }
  return { terms, text: words.join(" ").trim(), numbers, sort, unknown };
}

/** `q` split into its search words and the rest (qualifiers and `#123`), for a search by meaning that embeds only the words. */
export function splitWords(q: string): { words: string; rest: string } {
  const words: string[] = [], rest: string[] = [];
  for (const tok of tokens(q)) {
    const body = tok.startsWith("-") ? tok.slice(1) : tok;
    (body.indexOf(":") > 0 && !body.startsWith('"')) || /^#\d+$/.test(body) ? rest.push(tok) : words.push(tok);
  }
  return { words: words.join(" "), rest: rest.join(" ") };
}

/** The values of the first plain (not negated) term of `key` in `q`, or [] when it has none. */
export function termValues(q: string, key: QueryKey): string[] {
  return parseItemQuery(q).terms.find((t) => t.key === key && !t.not)?.values ?? [];
}

/** Whether a token of `q` is a plain term of `key` (`is:open` is a state term). */
function tokenKey(tok: string): QueryKey | "sort" | null {
  if (tok.startsWith("-")) return null;
  const colon = tok.indexOf(":");
  if (colon <= 0) return null;
  const name = tok.slice(0, colon).toLowerCase();
  if (name === "sort") return "sort";
  if (name === "is") {
    const key = isTerm(unquote(tok.slice(colon + 1)).split(",")[0] ?? "")?.key;
    return key === "type" || key === "state" ? key : null;
  }
  return ALIASES[name] ?? null;
}

const quoteValue = (v: string) => (/[\s,"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

/**
 * `q` with its plain `key` terms replaced by one term of `values` (none: removed). Type and state are written as `is:`;
 * the other words and qualifiers keep their place.
 */
export function withTerm(q: string, key: QueryKey | "sort", values: readonly string[]): string {
  const kept = tokens(q).filter((t) => tokenKey(t) !== key);
  if (values.length) {
    const term = key === "type" || key === "state" ? values.map((v) => `is:${v}`).join(" ") : `${key}:${values.map(quoteValue).join(",")}`;
    // Type and state lead, as GitHub writes them; the rest follow the other qualifiers.
    if (key === "type" || key === "state") kept.unshift(term);
    else kept.push(term);
  }
  return kept.join(" ");
}

/** `q` with the flag `is:<flag>` added or removed. */
export function withFlag(q: string, flag: string, on: boolean): string {
  const kept = tokens(q).filter((t) => t.toLowerCase() !== `is:${flag}`);
  return (on ? [...kept, `is:${flag}`] : kept).join(" ");
}

export type Preset = { id: string; label: string; query: string };

/** The page's views: each sets the whole query. The first is the page's default. Labels are English keys for t(). */
export const PRESETS: readonly Preset[] = [
  { id: "open", label: "Open", query: "is:open" },
  { id: "new", label: "New, no labels", query: "is:open no:label sort:created" },
  { id: "hot", label: "Most discussed", query: "is:open sort:comments" },
  { id: "discord", label: "On Discord", query: "is:open discord:mentioned sort:discord" },
  { id: "bugs", label: "Bugs to fix", query: "is:issue is:open kind:bug priority:P0,P1 no:pr sort:priority" },
  { id: "ready", label: "Ready to merge", query: "is:pr is:open ci:green review:clean is:approved" },
  { id: "running", label: "AutoCraft working", query: "is:open autocraft:running" },
  { id: "waiting", label: "Waiting on a person", query: "is:open autocraft:waiting" },
  { id: "outside", label: "Outside contributors waiting", query: "is:open is:outside no:response sort:created-asc" },
  { id: "duplicates", label: "Duplicates", query: "is:open is:duplicate" },
  { id: "mine", label: "Mine", query: "is:mine" },
];
export const DEFAULT_QUERY = PRESETS[0]!.query;

/** The preset whose query is `q`, word for word apart from spacing. */
export function presetOf(q: string): Preset | null {
  const norm = tokens(q).join(" ");
  return PRESETS.find((p) => p.query === norm) ?? null;
}
