// The Markdown review the review-post step posts on a pull request. Fixed layout:
// the variable parts are the verdict wording (with the fix-up's head after a carried take-fix review), the review's own text
// (cleaned: it is untrusted model output) and the short head commit. No Node imports:
// the Prompts page lists the template through src/act/templates.ts.

import { dropMarkup, outsideCode, scrubMarkdown, type ScrubOptions } from "./public-text.ts";
import type { MergePath } from "../core/plan.ts";

export { outsideCode };

export const REVIEW_BODY_MAX = 6000;
const ITEM_MAX = 600;
const MAX_POINTS = 8;
const MAX_CLAIM_LINES = 12;
/** Room kept for the note line the posting wrapper adds. */
const NOTE_RESERVE = 100;

/**
 * The display name of a model id. A prompt's alias names the family ("opus" -> "Opus"); a full id names the product and
 * version ("claude-opus-5-5" -> "Claude Opus 5.5", "claude-opus-4-1-20250805" -> "Claude Opus 4.1", "gpt-6.2-astra" ->
 * "Codex Astra 6.2"). Other ids are returned as they are.
 */
export function modelLabel(id: string | null | undefined): string {
  const t = (id ?? "").trim();
  const m = /^(claude-)?(opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(?:\[[^\]]*\])?$/i.exec(t);
  if (m) {
    const name = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1).toLowerCase();
    const version = m[3] ? ` ${m[3]}${m[4] ? `.${m[4]}` : ""}` : "";
    return `${m[1] ? "Claude " : ""}${name}${version}`;
  }
  const a = /^(?:gpt-(\d+(?:\.\d+)?)-)?astra$/i.exec(t);
  if (a) return `Codex Astra${a[1] ? ` ${a[1]}` : ""}`;
  return t || "unknown model";
}

/** Characters of one fix or follow-up title line. */
const PART_LINE_MAX = 200;

const VERDICT_LINE: Record<string, string> = {
  take: "No blocking problems found.",
  "take-fix": "Small fixes needed:",
  hold: "Changes needed:",
  close: "Significant problems found:",
};

/** The unsure note goes inside the line, so it can't read as the first of the needed changes. */
function verdictLine(verdict: string, sure: boolean, override?: string): string {
  const line = override ?? VERDICT_LINE[verdict] ?? "Review:";
  return sure ? line : `${line.slice(0, -1)} (not certain)${line.slice(-1)}`;
}

/** One line of plain text: no mentions (nobody gets pinged), no raw HTML tags outside code, cut to `max` characters. */
export function cleanLine(s: string | null | undefined, max = ITEM_MAX): string {
  const t = dropMarkup((s ?? "").replace(/\s+/g, " ")).trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const SAME_OWNER_HOSTS = new Set(["github.com", "www.github.com"]);

/** The link as it is posted when it is one the text may keep: https or http to github.com under `owner`, written by the URL parser. */
function keptLink(url: string, owner: string | undefined): string | null {
  if (!owner) return null;
  try {
    const u = new URL(url);
    const ok = (u.protocol === "https:" || u.protocol === "http:") && SAME_OWNER_HOSTS.has(u.hostname.toLowerCase())
      && u.pathname.split("/")[1]?.toLowerCase() === owner.toLowerCase();
    return ok && !/[`\\[\]<>]/.test(u.href) ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Review text without links, except links to github.com under `owner`. A markdown link elsewhere becomes its text; a bare
 * URL elsewhere becomes "(link removed)"; an issue or PR reference ("#12", "GH-12", "owner/repo#12"), which would link or
 * notify another thread, reads "issue 12". Code keeps its text (colours, anchors). What is left of the link syntax is
 * escaped (see scrubMarkdown).
 */
export function stripLinks(s: string, owner?: string, o?: ScrubOptions): string {
  return scrubMarkdown(s, (t, keep) => t
    .replace(/(^|\n)[ \t>]*\[[^\]]*\]:[^\n]*/g, "$1")
    .replace(/!?\[([^[\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/!?\[([^[\]]*)\]\(\s*<?([^\s)>]*)>?[^)]*\)/g, (_all, text: string, url: string) => {
      const href = keptLink(url, owner);
      return href ? keep(`[${text.replace(/[`\\[\]<>@&]/g, "")}](${href})`) : text;
    })
    .replace(/(?<![A-Za-z0-9])(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, (url) => {
      const tail = /[.,;:!?]+$/.exec(url)?.[0] ?? "";
      const href = keptLink(tail ? url.slice(0, -tail.length) : url, owner);
      return href ? `${keep(href)}${tail}` : `(link removed)${tail}`;
    })
    .replace(/(?<![A-Za-z0-9])GH-(\d{1,7})(?![A-Za-z0-9])/gi, "issue $1")
    .replace(/(?<![A-Za-z0-9/&])(?:[\w.-]+\/[\w.-]+)?#(\d{1,7})(?![A-Za-z0-9])/g, "issue $1"), o);
}

/** What the pipeline will do next with the PR, as far as the posting moment shows. */
export type RecommendInput = {
  verdict: string;
  /** The PR's merge queue entry (take and take-fix reviews only), or null when it has none. */
  queue: { path: MergePath; state: string } | null;
  /** A person or the repo approved the merge (src/core/may.ts). */
  mergeApproved: boolean;
  /** Our pushes to the PR are approved and its branch accepts them. */
  canPush: boolean;
  /** On a PR approved for merge whose review found what does not block it: how many fixes still block it, how many points are follow-ups, and whether they will be filed. */
  followUps?: { blocking: number; later: number; filed: boolean } | null;
};

const WAIT = "Recommendation: wait for maintainer feedback.";

/** The closing line of the review. Plain wording only: no rule details, tiers or account names. */
export function recommendation(r: RecommendInput): string {
  const fu = r.followUps?.later ? r.followUps : null;
  if (fu) {
    const filed = fu.filed ? (fu.blocking ? "; the follow-ups will be filed as an issue" : "; the follow-ups above will be filed as an issue") : "";
    if (!fu.blocking) return `Recommendation: merge after CI and checks pass${filed}.`;
    return r.canPush ? `Recommendation: merge after the fixes above, which may be pushed to this branch${filed}.` : `Recommendation: merge after the fixes above${filed}.`;
  }
  switch (r.verdict) {
    case "take":
      if (!r.queue || r.queue.state === "merged") return WAIT;
      return r.queue.path !== null && r.mergeApproved
        ? "Recommendation: merge after CI and checks pass."
        : "Recommendation: merge, after a maintainer's decision.";
    case "take-fix":
      return r.canPush
        ? "Recommendation: merge after the fixes above; they may be pushed to this branch."
        : "Recommendation: merge after the fixes above.";
    case "hold":
      return "Recommendation: update the pull request; it will be reviewed again.";
    default:
      return WAIT;
  }
}

export type ReviewPostInput = {
  verdict: string;
  sure: boolean;
  /** The Opus `public` field: the only review text that is posted. */
  summary: string;
  points: string[];
  /** The head the review was written at. */
  head: string;
  /** Owner (org or user) of the reviewed repo: links to github.com under it stay in the posted text. */
  owner?: string;
  /** The short head of the commit our fix-up pushed after the review; set only for a carried review. */
  fixedIn?: string | null;
  /** The claims of the title and body that the review checked, listed after the points. */
  claims?: { claim: string; status: string; evidence: string }[];
  /** The closing `Recommendation: …` line (see `recommendation`). */
  recommendation: string;
  /**
   * On a PR approved for merge whose review found what does not block it: the titles of the fixes made before the merge, and of the
   * points filed as a follow-up issue instead (`notFiled`: why they will not be). With no fix left the verdict line says that nothing blocks the approved merge.
   */
  followUps?: { fixes: string[]; later: string[]; notFiled?: string | null } | null;
};

export function reviewBody(r: ReviewPostInput): string {
  const short = (h: string) => (/^[0-9a-f]+$/i.test(h) ? h.slice(0, 7) : h);
  const fixedIn = r.fixedIn ? short(r.fixedIn) : null;
  const fu = r.followUps?.later.length ? r.followUps : null;
  const head = verdictLine(r.verdict, r.sure, fu && !fu.fixes.length ? "Nothing found that blocks the approved merge:" : fixedIn && r.verdict === "take-fix" ? `Small fixes needed, made in ${fixedIn}:` : undefined);
  const foot = `Reviewed at ${short(r.head)}.${fixedIn ? ` Fixes pushed in ${fixedIn}.` : ""}`;
  // One line first: the code spans and escapes stripLinks sees are the ones the posted line has.
  const clean = (t: string, max?: number): string => cleanLine(stripLinks(t.replace(/\s+/g, " "), r.owner), max);
  const summary = clean(r.summary);
  const items: string[] = [];
  for (const p of r.points.slice(0, MAX_POINTS)) {
    const line = clean(p);
    if (line) items.push(`- ${line}`);
  }
  const claims = (r.claims ?? []).slice(0, MAX_CLAIM_LINES).flatMap((c) => {
    const line = clean(`${c.claim} (${c.evidence})`, 300);
    return line ? [`- ${c.status}: ${line}`] : [];
  });
  const rec = r.recommendation;
  const claimBlock = claims.length ? `Claims checked:\n${claims.join("\n")}\n\n` : "";
  const list = (title: string, xs: readonly string[]): string => {
    const lines = xs.slice(0, MAX_POINTS).flatMap((x) => { const line = clean(x, PART_LINE_MAX); return line ? [`- ${line}`] : []; });
    return lines.length ? `${title}\n${lines.join("\n")}\n\n` : "";
  };
  const fuBlock = fu ? list("Fixes before the merge:", fu.fixes) + list(fu.notFiled ? "Follow-ups (not filed by AutoCraft):" : "Follow-ups, to be filed as an issue:", fu.later) : "";
  const fixed = NOTE_RESERVE + head.length + rec.length + foot.length + summary.length + claimBlock.length + fuBlock.length + 8;
  const kept: string[] = [];
  let used = fixed;
  for (const line of items) {
    if (used + line.length + 1 > REVIEW_BODY_MAX) {
      kept.push("- …");
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return `${head}\n\n${summary ? `${summary}\n\n` : ""}${kept.length ? `${kept.join("\n")}\n\n` : ""}${claimBlock}${fuBlock}${foot}\n\n${rec}`;
}
