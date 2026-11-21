// Pure facts for the compact Needs queue rows: the metadata line, the answer word, the age
// label and roving selection. No React, no data access beyond the Decision it is given.
import type { Decision, DecisionKind } from "../../api/types.ts";
import { nowMs, when } from "../../lib/format.ts";

export const KIND_TEXT: Record<DecisionKind, string> = {
  scope: "Scope",
  duplicate: "Duplicates",
  close: "Close approval",
  merge: "Merge approval",
  hold: "Hold",
  split: "Split",
  other: "Question",
  backlog: "Backlog",
};

/** `repo#number`, or the truthful batch form `repo · N items` — never a made-up repo#number. */
export function refText(d: Pick<Decision, "repo" | "number" | "items">): string {
  if (d.number !== null) return `${d.repo}#${d.number}`;
  const n = d.items?.length ?? 0;
  return `${d.repo} · ${n} ${n === 1 ? "item" : "items"}`;
}

export type AnswerWord = { text: string; tone: "bad" | "warn" | "ok" | "neutral" };

/**
 * The compact answer/execution word from real fields only: a disputed, unapplied answer is
 * held (no `held` enum exists; `Decision.dispute` is the field); then the write's own state; then an
 * applied answer; then a plain answer; otherwise nothing. `queued`, `preparing` and `orphaned` are
 * never reported as applied.
 */
export function answerWord(d: Pick<Decision, "answer" | "appliedAt" | "exec" | "dispute">): AnswerWord | null {
  const exec = d.exec?.state;
  // Without an answer or an applied write there is nothing to report: a stray exec or dispute on an
  // unanswered decision is a contradiction, not an answer state.
  if (!d.answer && !d.appliedAt) return null;
  if (d.dispute && !d.appliedAt) return { text: "held", tone: "warn" };
  if (exec === "failed") return { text: "failed", tone: "bad" };
  if (exec === "pending") return { text: "pending", tone: "warn" };
  if (exec === "waiting-token" || exec === "waiting-permission") return { text: "waiting", tone: "warn" };
  if (d.appliedAt || exec === "done") return { text: "applied", tone: "ok" };
  if (d.answer) return { text: "answered", tone: "neutral" };
  return null;
}

/** A compact relative age from the given clock; the absolute time is the caller's accessible title. */
export function compactAge(askedAt: string, now = nowMs()): string {
  const t = Date.parse(askedAt);
  if (!Number.isFinite(t)) return "unknown";
  const future = t > now;
  const secs = Math.abs(now - t) / 1000;
  const text = secs < 60 ? "now"
    : secs < 3600 ? `${Math.floor(secs / 60)}m`
    : secs < 86_400 ? `${Math.floor(secs / 3600)}h`
    : secs < 604_800 ? `${Math.floor(secs / 86_400)}d`
    : secs < 2_592_000 ? `${Math.floor(secs / 604_800)}w`
    : secs < 31_536_000 ? `${Math.floor(secs / 2_592_000)}mo`
    : `${Math.floor(secs / 31_536_000)}y`;
  return future ? `in ${text}` : text;
}

/** The accessible title for an age: the absolute time, or an honest note when it is not a date. */
export function ageTitle(askedAt: string): string {
  return Number.isFinite(Date.parse(askedAt)) ? `asked ${when(askedAt)}` : "asked time unknown";
}

export interface MetaFact { key: "ref" | "kind" | "claim" | "answer"; text: string; tone?: AnswerWord["tone"]; title?: string }

/**
 * The metadata order, omitting what the DTO does not carry. A claim carries its elapsed time
 * ("on it · reader · 12m") with the absolute moment in the accessible title; a claim
 * without a valid `since` shows the reader and says the time is unknown rather than inventing one.
 */
export function metaFacts(d: Decision, now = nowMs()): MetaFact[] {
  const facts: MetaFact[] = [
    { key: "ref", text: refText(d) },
    { key: "kind", text: KIND_TEXT[d.kind] },
  ];
  if (d.claim?.login) {
    const since = d.claim.since;
    const elapsed = since && Number.isFinite(Date.parse(since)) ? compactAge(since, now) : null;
    facts.push({
      key: "claim",
      text: elapsed ? `on it · ${d.claim.login} · ${elapsed}` : `on it · ${d.claim.login}`,
      title: elapsed ? `claimed ${when(since!)}` : "claim time unknown",
    });
  }
  const word = answerWord(d);
  if (word) facts.push({ key: "answer", text: word.text, tone: word.tone });
  return facts;
}

/** Roving selection: the retained id when it is in this cohort, otherwise the first row (or none). */
export function selectedFor(list: { id: string }[], retained: string | undefined): string | undefined {
  if (retained && list.some((row) => row.id === retained)) return retained;
  return list[0]?.id;
}

/** The index a selection key moves to, clamped; Home/End jump to the ends. */
export function stepIndex(list: unknown[], index: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
  if (list.length === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return list.length - 1;
  const next = key === "ArrowDown" ? index + 1 : index - 1;
  return Math.min(Math.max(next, 0), list.length - 1);
}
