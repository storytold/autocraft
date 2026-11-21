/** Items browser state. One URL, two existing server contracts chosen by `phase`; no key
    from one endpoint is ever sent to the other. Every label, chip, badge, summary and bar in the
    UI is derived from `constraints()` — what the chosen endpoint actually receives — so an applied
    filter is never invisible and a value that is not sent is never shown as applied. */
import type { ItemFilter, ItemKind, ItemPhase, ItemSort, ItemStatusFilter, SettledStatus, StatusFilter, TypeLabel } from "../../api/types.ts";

export const PHASES: ItemPhase[] = ["Triage", "Waiting for a person", "Review", "Fixing", "Verifying", "In queue", "Merged", "Closed", "Held", "Out of scope", "Pipeline off"];

/** The state select's own scopes, in the order the approved toolbar lists them. */
export const STATE_OPTIONS: [string, string][] = [["open", "Open"], ["merged", "Merged"], ["closed", "Closed"], ["merged-by-us", "Merged by AutoCraft"], ["all", "Any state"]];
const APPLIED_STATES: NonNullable<ItemFilter["state"]>[] = ["open", "merged", "closed", "merged-by-us", "all"];

export const KIND_OPTIONS: [string, string][] = [["", "All types"], ["pr", "Pull requests"], ["issue", "Issues"]];

export const LABELS: TypeLabel[] = ["bugfix", "performance", "missing feature", "small extra", "plugin candidate", "infra"];

export const CLASSIFICATIONS: [string, string][] = [["", "Any classification"], ["settled", "Settled"], ["waiting", "Waiting for a second opinion"], ["disagree", "Classifiers disagree"], ["unclassified", "Not classified"]];
const STATUS_KEYS: SettledStatus[] = ["settled", "waiting", "disagree", "unclassified"];

export const FLAGS: [string, string][] = [["", "Any flag"], ["security", "Security"], ["needs decision", "Needs a decision"]];
const FLAG_KEYS = FLAGS.map(([key]) => key).filter(Boolean);

export const SORTS: [ItemSort, string][] = [["relevance", "Relevance"], ["updated", "Updated"], ["created", "Created"], ["number", "Number"], ["merged", "Merged"], ["discord", "Discord mentions"]];
const SORT_KEYS = SORTS.map(([key]) => key);

/** Every key this browser knows, applied or not; anything else in the URL is only carried. */
export const KNOWN_KEYS = ["q", "state", "kind", "repo", "phase", "label", "status", "flag", "author", "since", "discord", "flow", "run", "sort", "desc", "limit", "offset", "open", "peek", "mode"] as const;

/** A key the phase endpoint cannot read. Selecting a phase never sends them (filter-contracts §3). */
export const PHASE_UNSUPPORTED = ["state", "label", "status", "flag", "author", "since", "flow", "sort", "desc", "limit", "offset", "run", "mode"] as const;

export interface BrowseState {
  search: string;
  q?: string;
  /** Applied state, default `open`; a value outside the contract stays in the URL and is reported instead. */
  state: NonNullable<ItemFilter["state"]>;
  stateRaw?: string;
  kind?: ItemKind;
  kindRaw?: string;
  /** Repositories, in URL order. The toolbar's select writes one; older comma lists stay applied. */
  repos: string[];
  phase?: ItemPhase;
  phaseRaw?: string;
  labels: TypeLabel[];
  labelsRaw: string[];
  status: StatusFilter[];
  statusRaw: string[];
  flags: string[];
  flagsRaw: string[];
  author?: string;
  since?: string;
  discord: boolean;
  flow?: string;
  run?: string;
  sort?: ItemSort;
  desc: boolean;
  limit: number;
  offset: number;
  peek?: string;
  /** URL keys no control owns. They survive edits and are listed, never applied. */
  unknown: [string, string][];
}

const csv = (value: string | undefined) => (value ? value.split(",").map((v) => v.trim()).filter(Boolean) : []);

/** Pagination stays finite and integral before it reaches the server or the range label. */
export function itemPageSize(value: string | undefined): number {
  const number = Number(value);
  return Number.isFinite(number) && number !== 0 ? Math.min(100, Math.max(1, Math.floor(number))) : 50;
}
export function itemOffset(value: string | undefined): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function previewRef(value: string | undefined): { repo: string; number: number } | null {
  const match = /^([a-zA-Z0-9_.-]+)#([1-9][0-9]*)$/.exec(value ?? "");
  if (!match) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) ? { repo: match[1]!, number } : null;
}

/** Parse once per URL; every applied value is validated against the contract it is sent to. */
export function parseBrowse(search: string): BrowseState {
  const params = new URLSearchParams(search);
  const read = (key: string) => params.get(key) ?? undefined;
  const stateRaw = read("state");
  const kindRaw = read("kind");
  const phaseRaw = read("phase");
  const labelRaw = csv(read("label"));
  const statusRaw = csv(read("status"));
  const flagRaw = csv(read("flag"));
  const sortRaw = read("sort");
  const sinceRaw = read("since");
  const labels = labelRaw.filter((label): label is TypeLabel => LABELS.includes(label as TypeLabel));
  const status = statusRaw.filter((value): value is StatusFilter => value === "unsettled" || STATUS_KEYS.includes(value as SettledStatus));
  const flags = flagRaw.filter((value) => FLAG_KEYS.includes(value));
  const phase = PHASES.find((p) => p === phaseRaw);
  return {
    search,
    q: read("q")?.trim() || undefined,
    state: APPLIED_STATES.includes(stateRaw as NonNullable<ItemFilter["state"]>) ? (stateRaw as NonNullable<ItemFilter["state"]>) : "open",
    stateRaw,
    kind: kindRaw === "pr" || kindRaw === "issue" ? kindRaw : undefined,
    kindRaw,
    repos: csv(read("repo")),
    phase,
    phaseRaw,
    labels,
    labelsRaw: labelRaw,
    status,
    statusRaw,
    flags,
    flagsRaw: flagRaw,
    author: read("author")?.trim() || undefined,
    since: /^\d{4}-\d{2}-\d{2}$/.test(sinceRaw ?? "") ? sinceRaw : undefined,
    discord: read("discord") === "1",
    flow: /^[a-z]+\.[a-z-]+$/.test(read("flow") ?? "") ? read("flow") : undefined,
    run: read("run")?.trim() || undefined,
    sort: SORT_KEYS.find((key) => key === sortRaw),
    desc: read("desc") !== "0",
    limit: itemPageSize(read("limit")),
    offset: itemOffset(read("offset")),
    peek: read("peek"),
    unknown: [...params.entries()].filter(([key]) => !(KNOWN_KEYS as readonly string[]).includes(key)),
  };
}

/** The list endpoint's filter, built only from keys it serves. Phase is never included. */
export function itemFilter(browse: BrowseState): ItemFilter {
  return {
    q: browse.q,
    repo: browse.repos.length ? browse.repos : undefined,
    kind: browse.kind,
    state: browse.state,
    label: browse.labels[0],
    status: browse.status.length ? browse.status : undefined,
    flag: browse.flags.length ? browse.flags : undefined,
    author: browse.author,
    since: browse.since,
    discord: browse.discord || undefined,
    flow: browse.flow,
    sort: (browse.sort === "relevance" && !browse.q) || (browse.sort === "merged" && browse.state !== "merged-by-us") ? undefined : browse.sort,
    desc: browse.desc,
    limit: browse.limit,
    offset: browse.offset,
    run: browse.run,
  };
}

/** The phase endpoint's filter: q, phase, kind, repo and discord only, with a cursor. */
export function statusFilter(browse: BrowseState): ItemStatusFilter {
  return {
    q: browse.q,
    phase: browse.phase,
    kind: browse.kind,
    repo: browse.repos.length ? browse.repos : undefined,
    discord: browse.discord || undefined,
  };
}

const stateLabel = (state: string) => STATE_OPTIONS.find(([key]) => key === state)?.[1] ?? state;
const statusLabel = (value: string) => (value === "unsettled" ? "Waiting or disagreeing" : CLASSIFICATIONS.find(([key]) => key === value)?.[1] ?? value);
const flagLabel = (value: string) => (value === "needs decision" ? "Needs a decision" : value === "security" ? "Security" : value);
const sortLabel = (value: string) => SORTS.find(([key]) => key === value)?.[1] ?? value;

/** One line of the effective filter state: a value the endpoint receives (`applied`) or a URL
    value it does not receive, kept in the link and shown as not applied. */
export interface Constraint { key: string; label: string; value: string; applied: boolean; rawValue?: string }

/**
 * The single truth behind the toolbar, the bar, the phone summary and the compatibility chips.
 * `applied` is decided by the same builders that send the request, never by a separate list.
 */
export function constraints(browse: BrowseState): Constraint[] {
  const out: Constraint[] = [];
  const add = (key: string, label: string, value: string | undefined, applied: boolean, rawValue?: string) => {
    if (value) out.push({ key, label, value, applied, rawValue });
  };
  const phase = browse.phase !== undefined;
  const status = statusFilter(browse);
  const list = itemFilter(browse);
  if (phase) {
    add("q", "Search", status.q, true);
    add("phase", "Phase", browse.phase, true);
    add("kind", "Type", status.kind === "pr" ? "Pull requests" : status.kind === "issue" ? "Issues" : undefined, !!status.kind);
    add("repo", "Repository", status.repo?.join(" + "), !!status.repo?.length);
    add("discord", "Seen on Discord", status.discord ? "yes" : undefined, true);
    // Kept in the link, never sent: these values remain visibly unapplied in phase mode.
    add("state", "State", browse.stateRaw ? stateLabel(browse.stateRaw) : undefined, false, browse.stateRaw);
    for (const value of browse.labelsRaw) add("label", "Type label", value, false);
    for (const value of browse.statusRaw) add("status", "Classification", statusLabel(value), false, value);
    for (const value of browse.flagsRaw) add("flag", "Flag", flagLabel(value), false, value);
    add("author", "Author", browse.author, false);
    add("since", "Updated since", browse.since, false);
    add("flow", "Pipeline branch", browse.flow, false);
    add("run", "Classification run", browse.run, false);
    add("sort", "Sort", browse.sort ? sortLabel(browse.sort) : new URLSearchParams(browse.search).get("sort") ?? undefined, false);
    add("desc", "Direction", browse.desc ? undefined : "Oldest first", false);
    add("limit", "Page size", browse.limit !== 50 ? String(browse.limit) : undefined, false);
    add("offset", "Page offset", browse.offset ? String(browse.offset) : undefined, false);
  } else {
    add("q", "Search", list.q, true);
    if (list.state !== "open") add("state", "State", stateLabel(list.state!), true);
    if (browse.stateRaw && list.state === "open" && browse.stateRaw !== "open") add("state", "State", browse.stateRaw, false);
    add("kind", "Type", list.kind === "pr" ? "Pull requests" : list.kind === "issue" ? "Issues" : undefined, !!list.kind);
    if (browse.kindRaw && !list.kind) add("kind", "Type", browse.kindRaw, false);
    if (browse.phaseRaw && !browse.phase) add("phase", "Phase", browse.phaseRaw, false);
    add("repo", "Repository", list.repo?.join(" + "), !!list.repo?.length);
    // The endpoint takes one type label: the first valid value is applied, the rest stay in the link.
    if (list.label) add("label", "Type label", list.label, true);
    for (const value of browse.labelsRaw) if (value !== list.label) add("label", "Type label", value, false);
    for (const value of list.status ?? []) add("status", "Classification", statusLabel(value), true);
    for (const value of browse.statusRaw) if (value !== "unsettled" && !STATUS_KEYS.includes(value as SettledStatus)) add("status", "Classification", value, false);
    for (const value of list.flag ?? []) add("flag", "Flag", flagLabel(value), true);
    for (const value of browse.flagsRaw) if (!FLAG_KEYS.includes(value)) add("flag", "Flag", value, false);
    add("author", "Author", list.author, true);
    add("since", "Updated since", list.since, true);
    add("discord", "Seen on Discord", list.discord ? "yes" : undefined, true);
    add("flow", "Pipeline branch", list.flow, true);
    add("run", "Classification run", list.run, true);
    add("sort", "Sort", list.sort ? sortLabel(list.sort) : undefined, !!list.sort);
    const rawSort = new URLSearchParams(browse.search).get("sort");
    if (rawSort && !list.sort) add("sort", "Sort", sortLabel(rawSort), false);
    if (!list.desc) add("desc", "Direction", "Oldest first", true);
    if (list.limit !== 50) add("limit", "Page size", String(list.limit), true);
    if ((list.offset ?? 0) > 0) add("offset", "Page offset", String(list.offset), true);
  }
  const mode = new URLSearchParams(browse.search).get("mode");
  if (mode) add("mode", "Old link mode", mode, false);
  for (const [key, value] of browse.unknown) add(key, `“${key}”`, value, false);
  return out;
}

export function appliedConstraints(browse: BrowseState): Constraint[] {
  return constraints(browse).filter((constraint) => constraint.applied);
}

export function ignoredConstraints(browse: BrowseState): Constraint[] {
  return constraints(browse).filter((constraint) => !constraint.applied);
}

/** A phase link that also carries state/classification keys: reported, not applied. */
export function ignoredPhaseScopes(browse: BrowseState): boolean {
  if (!browse.phase) return false;
  return ["state", "label", "status", "flag"].some((key) => new URLSearchParams(browse.search).has(key));
}

/** Reference-count parity: state, kind, repository, label, classification, flag. */
export function filterCount(browse: BrowseState): number {
  const applied = appliedConstraints(browse);
  return ["state", "kind", "repo", "label", "status", "flag"].filter((key) => applied.some((constraint) => constraint.key === key)).length;
}

export function isActive(browse: BrowseState): boolean {
  return appliedConstraints(browse).length > 0;
}

/** The phone Filters button count: the controls that leave the primary row, plus a phase context. */
export function hiddenFilterCount(browse: BrowseState, phone: boolean): number {
  const applied = appliedConstraints(browse);
  const has = (key: string) => applied.some((constraint) => constraint.key === key);
  return [has("repo"), !!browse.phase, ...(phone ? [has("status"), has("label"), has("flag")] : [])].filter(Boolean).length;
}

/** What the phone shows when its secondary controls are folded away: only values that apply. */
export function secondarySummary(browse: BrowseState): string[] {
  const applied = appliedConstraints(browse);
  const values = (key: string) => applied.filter((constraint) => constraint.key === key).map((constraint) => constraint.value);
  return [
    values("status").length ? `Classification: ${values("status").join(" + ")}` : "",
    values("label").length ? `Label: ${values("label").join(" + ")}` : "",
    values("flag").length ? `Flag: ${values("flag").join(" + ")}` : "",
    values("repo").length ? `Repository: ${values("repo").join(" + ")}` : "",
  ].filter(Boolean);
}

/** The applied filter values that no primary control shows, named for the closed `More filters` line. */
export function appliedDetail(browse: BrowseState): string[] {
  const primary = new Set(["q", "phase", "state", "kind", "repo", "label", "status", "flag"]);
  return appliedConstraints(browse).filter((constraint) => !primary.has(constraint.key)).map((constraint) => `${constraint.label}: ${constraint.value}`);
}

export interface CompatExtra { key: string; label: string; value: string; rawValue: string; applied: boolean }

/** The chips of the compatibility detail: everything the primary controls cannot show, plus
    every URL value the endpoint does not receive. `value` is display text; `rawValue` removes the URL entry. */
export function compatExtras(browse: BrowseState): CompatExtra[] {
  const primary = new Set(["q", "phase", "state", "kind", "repo"]);
  return constraints(browse)
    // A primary key keeps its chip only while it is *not* applied: an ignored phase or state
    // must still be visible and removable, while an applied one is already in its control.
    .filter((constraint) => !(constraint.applied && primary.has(constraint.key)))
    .filter((constraint) => !(constraint.applied && ["label", "status", "flag"].includes(constraint.key)))
    .map(({ key, label, value, rawValue, applied }) => ({ key, label, value, rawValue: rawValue ?? value, applied }));
}

/** Values present in the URL that the chosen endpoint does not receive. */
export function unappliedCount(browse: BrowseState): number {
  return ignoredConstraints(browse).length;
}

export interface SelectState { value: string; options: [string, string][] }

/** The value of a multi-value CSV select: the applied values together, so it never reads "Any". */
function multiSelect(applied: string[], base: [string, string][], labelOf: (value: string) => string = (value) => value): SelectState {
  if (!applied.length) return { value: "", options: base };
  const value = applied.join(",");
  const options: [string, string][] = [...base];
  if (!options.some(([key]) => key === value)) {
    const label = applied.map(labelOf).join(" + ");
    options.unshift([value, label]);
  }
  return { value, options };
}

/** Exactly what each primary field displays, including the values the endpoint cannot take. */
export function primarySelects(browse: BrowseState, repos: string[]): { state: SelectState; kind: SelectState; classification: SelectState; repository: SelectState; label: SelectState; flag: SelectState } {
  const phase = browse.phase !== undefined;
  const state: SelectState = phase ? { value: "phase", options: [["phase", "By phase"]] } : { value: browse.state, options: STATE_OPTIONS };
  const classification = phase ? { value: "", options: CLASSIFICATIONS } : multiSelect(browse.status, CLASSIFICATIONS, statusLabel);
  const repository = multiSelect(browse.repos, [["", "All repos"], ...repos.map((repo) => [repo, repo] as [string, string])]);
  const label: SelectState = phase
    ? { value: "", options: [["", "Any label"], ...LABELS.map((value) => [value, value] as [string, string])] }
    : { value: browse.labels[0] ?? "", options: [["", "Any label"], ...LABELS.map((value) => [value, value] as [string, string])] };
  const flag = phase ? { value: "", options: FLAGS } : multiSelect(browse.flags, FLAGS, flagLabel);
  return {
    state,
    kind: { value: browse.kind ?? "", options: KIND_OPTIONS },
    classification,
    repository,
    label,
    flag,
  };
}

/** Every filter key, for Reset. `peek` is not a filter; unknown keys still survive a reset. */
export function resetPatch(): Record<string, null> {
  return Object.fromEntries(["q", "state", "kind", "repo", "phase", "label", "status", "flag", "author", "since", "discord", "flow", "run", "sort", "desc", "limit", "offset", "mode", "open", "peek"].map((key) => [key, null]));
}

/** Clear phase in place: the ignored scopes go with it, shared filters stay, state returns to its default. */
export function clearPhasePatch(): Record<string, null> {
  return { phase: null, state: null, label: null, status: null, flag: null, offset: null, open: null, peek: null };
}

/** Discrete Items controls push history; typing and alias redirects replace the current entry. */
export type HistoryAction = "filter" | "phase" | "clear-phase" | "reset" | "remove" | "paging" | "preview" | "open" | "search" | "author" | "alias";
export const HISTORY_ENTRY: Record<HistoryAction, "push" | "replace"> = {
  filter: "push",
  phase: "push",
  "clear-phase": "push",
  reset: "push",
  remove: "push",
  paging: "push",
  preview: "push",
  open: "push",
  search: "replace",
  author: "replace",
  alias: "replace",
};
export function historyOptions(action: HistoryAction): { replace: boolean } {
  return { replace: HISTORY_ENTRY[action] === "replace" };
}

/** `/items/filters` is an alias of the unified browser, not a second view. */
export function aliasHref(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("phase");
  const query = params.toString();
  return `/items${query ? `?${query}` : ""}`;
}

/** Removing one chip: a comma list loses only that value; a scalar key is deleted. */
export function removeValuePatch(browse: BrowseState, key: string, value: string): Record<string, string | null> {
  const listKeys: Record<string, string[]> = { repo: browse.repos, label: browse.labelsRaw, status: browse.statusRaw, flag: browse.flagsRaw };
  const list = listKeys[key];
  if (!list) return { [key]: null };
  const next = list.filter((entry) => entry !== value);
  return { [key]: next.length ? next.join(",") : null };
}
