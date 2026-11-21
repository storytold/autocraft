/** Needs controls: the decision View and the inline scope panel. Pure helpers only; the page owns
    the URL, the reads and the list. */
import type { DecisionFilter, DecisionKind } from "../../api/types.ts";

export type DecisionView = NonNullable<DecisionFilter["status"]>;

/** Native View options in display order. */
export const VIEW_OPTIONS: { value: DecisionView; label: string }[] = [
  { value: "open", label: "Waiting" },
  { value: "answered", label: "Answered" },
  { value: "backlog", label: "Backlog" },
  { value: "snoozed", label: "Snoozed" },
  { value: "opinions", label: "With opinions" },
];

export const VIEW_LABEL: Record<DecisionView, string> = Object.fromEntries(VIEW_OPTIONS.map((o) => [o.value, o.label])) as Record<DecisionView, string>;

/** The reference offers these; the API takes any whole number of days. */
export const AGE_VALUES = [1, 3, 7] as const;

/** `all` is the server's "every open question" switch; it only applies to those two views. */
export const ALL_SCOPE_VIEWS: DecisionView[] = ["open", "opinions"];

export interface Scope {
  repo: string[];
  kind: DecisionKind[];
  /** The effective age the server applies: positive fractional days too, capped at 36500. */
  minAge?: number;
  all: boolean;
  /** Values the API cannot use: kept in the link and reported, never applied or mislabelled. */
  unusedKinds: string[];
  unusedAge?: string;
  /** The raw age when the server's cap changes it (e.g. Infinity or 99999 -> 36500). */
  cappedAge?: string;
  /** Every raw value the link carries, applied or not, for individual removal and Clean up. */
  raw: { repo: string[]; kind: string[]; age?: string };
}

const csv = (value: string | null) => (value ? value.split(",").map((v) => v.trim()).filter(Boolean) : []);

/** Parse the scope keys exactly as the server reads them (`repo`/`kind` CSV, `age` days, `all=1`). */
export function parseScope(search: string, kinds: readonly string[]): Scope {
  const params = new URLSearchParams(search);
  const repoRaw = csv(params.get("repo"));
  const kindRaw = csv(params.get("kind"));
  const ageRaw = params.get("age");
  // The server's own arithmetic (src/dash/api/decisions.ts:404-407): minAge = min(Number(age), 36500),
  // applied only when > 0. Number("") is 0, NaN compares false (so non-numeric is ignored), positive
  // fractions are real filters, and Infinity becomes the cap. The UI and the request share this.
  const days = Number(ageRaw ?? 0);
  const effectiveAge = Math.min(days, 36500);
  const appliesAge = effectiveAge > 0; // false for NaN, 0 and negatives
  return {
    repo: repoRaw,
    kind: kindRaw.filter((k): k is DecisionKind => kinds.includes(k)),
    minAge: appliesAge ? effectiveAge : undefined,
    all: params.get("all") === "1",
    unusedKinds: kindRaw.filter((k) => !kinds.includes(k)),
    unusedAge: ageRaw !== null && !appliesAge ? ageRaw : undefined,
    cappedAge: appliesAge && ageRaw !== null && Number(ageRaw) !== effectiveAge ? ageRaw : undefined,
    raw: { repo: repoRaw, kind: kindRaw, age: ageRaw ?? undefined },
  };
}

/**
 * The Filters badge counts applied scope DIMENSIONS once each (repo, kind, age, all), not the number
 * of CSV values, and only counts `all` when the current view actually applies it. Values the API will
 * not use are never counted.
 */
export function scopeCount(scope: Scope, view: DecisionView): number {
  return [scope.repo.length > 0, scope.kind.length > 0, !!scope.minAge, scope.all && ALL_SCOPE_VIEWS.includes(view)].filter(Boolean).length;
}

/** Clear scope: the four scope keys go, the View (status), the tab and unknown keys stay. */
export function clearScopePatch(): Record<string, null> {
  return { repo: null, kind: null, age: null, all: null, peek: null };
}

/** The View select's value, validated like the server's status. */
export function viewOf(status: string | undefined): DecisionView {
  return VIEW_OPTIONS.some((o) => o.value === status) ? (status as DecisionView) : "open";
}

/**
 * The age select's options: Any/1/3/7 presets, plus the link's own older value (the previous
 * rail offered 2 days) so an existing choice is shown truthfully instead of mislabelled or dropped.
 */
export function ageOptions(minAge: number | undefined): { value: string; label: string }[] {
  const options = [{ value: "", label: "Any age" }];
  for (const days of [...AGE_VALUES].sort((a, b) => a - b)) options.push({ value: String(days), label: `${days} ${days === 1 ? "day" : "days"}` });
  if (minAge && !(AGE_VALUES as readonly number[]).includes(minAge)) options.push({ value: String(minAge), label: `${minAge} days · from this link` });
  return options;
}

export interface CompatValue { key: "repo" | "kind" | "age"; value: string; label: string }

/**
 * Values that a single native select cannot show: multiple repositories or kinds, an age outside the
 * preset options, and values the API will not use. The panel lists them with a remove action so
 * no applied constraint is invisible and nothing unused is presented as applied.
 */
export function compatValues(scope: Scope): CompatValue[] {
  const out: CompatValue[] = [];
  if (scope.repo.length > 1) for (const repo of scope.repo) out.push({ key: "repo", value: repo, label: repo });
  if (scope.kind.length > 1) for (const kind of scope.kind) out.push({ key: "kind", value: kind, label: kind });
  if (scope.minAge && !(AGE_VALUES as readonly number[]).includes(scope.minAge)) out.push({ key: "age", value: String(scope.minAge), label: `${scope.minAge} days${scope.cappedAge ? ` (${scope.cappedAge} in the link, capped)` : ""}` });
  for (const kind of scope.unusedKinds) out.push({ key: "kind", value: kind, label: `${kind} (not applied)` });
  if (scope.unusedAge) out.push({ key: "age", value: scope.unusedAge, label: `${scope.unusedAge} (not applied)` });
  return out;
}

/** Any raw scope value at all, applied or not: the direct cleanup path must exist whenever this is true. */
export function hasRawScope(scope: Scope): boolean {
  return scope.raw.repo.length + scope.raw.kind.length + (scope.raw.age !== undefined ? 1 : 0) > 0;
}

/**
 * Remove ONE raw value from the link, preserving every other raw value (valid or not) and every
 * unknown key. It edits the CSV as the link wrote it, never a valid-only rebuild.
 */
export function removeRawScopePatch(search: string, key: "repo" | "kind", value: string): Record<string, string | null> {
  const params = new URLSearchParams(search);
  const remaining = csv(params.get(key)).filter((entry) => entry !== value);
  return { [key]: remaining.length ? remaining.join(",") : null, peek: null };
}

/** Remove the raw age, whatever it is (applied, capped or unusable). */
export function removeRawAgePatch(): Record<string, string | null> {
  return { age: null, peek: null };
}

/** The select's value for a multi-value scope: the values together, never a false "All". */
export function multiSelectValue(values: string[], none = ""): string {
  return values.length ? values.join(",") : none;
}

/** The label of a multi-value option ("a + b"), so the control names what it applies. */
export const multiLabel = (values: string[]): string => values.join(" + ");

/** `/needs?tab=…` with compatible scope retained. */
export function needsTabsHref(tab: "decisions" | "feedback" | "stopped", search: string): string {
  const params = new URLSearchParams(search);
  // A queue-tab link is a cohort change: it drops the preview and the selected decision too.
  params.delete("peek");
  params.delete("decision");
  if (tab === "decisions") params.delete("tab");
  else params.set("tab", tab);
  const query = params.toString();
  return `/needs${query ? `?${query}` : ""}`;
}
