// Opus review prompt input and reply validation. No I/O and no Node imports: the
// prompt registry (also loaded by the web mockup) imports this file.
import { wholeReplyJson } from "../core/reply-json.ts";
import { VERDICTS, type DiscussionEntry, type ReviewVerdict } from "./parse.ts";
import { firstSentence, oneSentence, proseField, SUMMARY_MAX_WORDS, WHY_MAX_WORDS, wordCount } from "../prose.ts";
import type { PostmergeReviewRow, RelatedItem } from "../postmerge/parse.ts";
import type { LintProblem } from "../replylint.ts";
import { safePath } from "../fixup/patch.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { dropMarkup } from "./public-text.ts";
import { BLOCKING_CLASSES, blockingOf, type Blocking } from "../premerge/types.ts";
import type { ReviewRecommendation } from "../data/review/types.ts";

export type EarlierOpus = { head: string; verdict: string; sure: boolean; reason: string; fixes: { file: string; change: string }[] };

/** A change an earlier review asked for (a take-fix at `head`) that was never made or posted. */
export type UnappliedFix = { head: string; file: string; change: string };

/** Something an owner said earlier about related work (table owner_statements), as the review prompt shows it. */
export type OwnerStatement = { id: number; where: string; kind: string; title: string; at: string; text: string };
/** A statement a review says the PR goes against, with a one-line reason. */
export type StatementConflict = { id: number; reason: string };

export const CONFLICT_REASON_CHARS = 300;
export const STATEMENT_PROMPT_CHARS = 800;

/** The `conflicts` of a reply: entries naming one of `known` (others are dropped), one per id, with a reason of text. Anything else gives an empty list. */
export function parseStatementConflicts(v: unknown, known: readonly { id: number }[] = []): StatementConflict[] {
  if (!Array.isArray(v)) return [];
  const ids = new Set(known.map((d) => d.id)), seen = new Set<number>(), out: StatementConflict[] = [];
  for (const x of v) {
    const o = x as { id?: unknown; reason?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.id !== "number" || !ids.has(o.id) || seen.has(o.id)) continue;
    const reason = typeof o.reason === "string" ? o.reason.replace(/\s+/g, " ").trim().slice(0, CONFLICT_REASON_CHARS) : "";
    if (!reason || REFERENCE_LEAK.test(reason)) continue;
    seen.add(o.id);
    out.push({ id: o.id, reason });
  }
  return out;
}

/**
 * The statements as the prompt shows them: a JSON array with `<` escaped, since the item title is written by the item's
 * author and an operator's text can quote anyone, so neither can close the block or pose as prompt text.
 */
export const statementsList = (d: readonly OwnerStatement[] | undefined): string => (d?.length
  ? JSON.stringify(d.map((x) => ({ id: x.id, where: x.where, kind: x.kind, item_title: x.title, date: x.at.slice(0, 10), text: x.text.replace(/\s+/g, " ").trim().slice(0, STATEMENT_PROMPT_CHARS) })), null, 1).replace(/</g, "\\u003c")
  : "(none)");

/** One PR as the Opus prompt shows it. Every string field is untrusted or derived from untrusted text. */
export type OpusPr = {
  ref: string;
  /** Where the call may read the repository inside the sandbox; not part of the quoted JSON. */
  repo_dir?: string;
  /** Set when the repo's reference folder is mounted at /reference; not part of the quoted JSON. */
  reference?: boolean;
  /** Set for an item on the maintainer workflow: the prompt asks for titled parts, `major`, `outside_purpose` and `recommendation`. Not part of the quoted JSON. */
  workflow?: boolean;
  /** Set when a maintainer approved the PR for merge: a delta after only our own commits looks for blocking problems only. Not part of the quoted JSON. */
  merge_approved?: boolean;
  title: string;
  body: string;
  author_association: string | null;
  size: string;
  lines_changed: number;
  ci: string;
  /** Present only when CI is red: the required checks that fail at the reviewed head. */
  failing_checks?: string[];
  mergeable: string | null;
  files: string[];
  tests_omitted: string[];
  lockfiles_omitted: string[];
  /** full: the whole diff of the PR. delta: only the changes since `earlier_opus.head`. */
  mode: "full" | "delta";
  earlier_opus: EarlierOpus | null;
  /** Present only when an earlier take-fix's fixes were never applied; the reply must keep or explain each. */
  unapplied_fixes?: UnappliedFix[];
  /** Present only when a person settled that the change belongs in the app (src/review/opus.ts scopeSettled): the review does not reopen scope. */
  scope_settled?: { answer: string; by: string | null; note: string | null };
  /**
   * Present only when the PR's author pushed commits after a person approved its merge: the head they approved and the head under review; the
   * reply then says whether the new commits stay within the approval. `separated`: the new commits were told apart from the rest of the PR
   * (the delta of the PR's own diffs, base-branch changes left out) and `files` lists the files they touch; false: the diff is the whole PR.
   */
  author_commits?: { approved_head: string; new_head: string; separated?: boolean; files?: string[] };
  /** Present only when our pipeline pushed commits to the PR since `earlier_opus`'s head: kind, sha, note and the fixes each was meant to make. */
  pipeline_commits?: { kind: string; sha: string; note: string; fixes_meant: string[] }[];
  diff: string;
  /** Issues and PRs that mention this PR or its files, open or closed in the last 30 days (number, kind, state, title); the reviewer checks which of them the PR fixes. */
  related_open?: RelatedItem[];
  /** Pre-merge review only: what the first review concluded, for the second reviewer to check. */
  review_history?: PostmergeReviewRow[];
  /** What others wrote on the PR; shown in its own block after the diff, not inside the PR's JSON. */
  discussion?: DiscussionEntry[];
  /** Earlier owner statements about related work; shown in their own block after the PR, not inside the PR's JSON. */
  statements?: OwnerStatement[];
};

/** "repo#n", "#n" (a PR of the same repo) or "owner/repo#n" (the owner is dropped). */
const BLOCKER_REF = /^(?:[\w.-]+\/)?([\w.-]*)#(\d+)$/;

/** The `blocked_by` of a reply: refs normalised to "repo#n", other than the PR itself, one each, at most 5. Whether they are tracked is checked against the database (openBlockers). */
export function parseBlockedBy(v: unknown, self: string): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const m = BLOCKER_REF.exec(typeof x === "string" ? x.trim() : "");
    if (!m) continue;
    const ref = `${m[1] || self.split("#")[0]}#${m[2]}`;
    if (ref !== self && !out.includes(ref)) out.push(ref);
  }
  return out.slice(0, 5);
}

export type OpusReview = {
  ref: string;
  verdict: ReviewVerdict;
  sure: boolean;
  reason: string;
  fixes: ReviewFix[];
  risks: string[];
  /** What a review of an item on the maintainer workflow adds; absent or null when the reply had neither field. */
  workflow?: ReviewWorkflow | null;
  /** Two or three plain sentences for the person who decides; null when the reply had none. */
  summary: string | null;
  /** One short sentence: why the verdict, for a recommendation; null when the reply had none. */
  why: string | null;
  /** The text written for the PR author; null when the reply had none or it was malformed. */
  public: PublicReview | null;
  /** The statements of `OpusPr.statements` that the PR goes against. */
  conflicts: StatementConflict[];
  /** The behavioural claims of the title and body, each checked against the code. */
  claims: Claim[];
  /** Refs ("repo#n") of other items the hold is waiting for; empty unless the verdict is hold. Checked against the tracked open items when stored. */
  blocked_by: string[];
};

export type ClaimStatus = "verified" | "contradicted" | "unverified";
/**
 * What a contradicted or unverified claim means for the merge: the PR's own change is wrong; the claim holds in the code the PR changes
 * but other paths or edge cases do not follow (not blocking: a follow-up); only the description is stale; or the model cannot tell.
 */
export type ClaimImpact = "code-wrong" | "code-incomplete" | "description-only" | "unknown";
const CLAIM_IMPACTS: readonly string[] = ["code-wrong", "code-incomplete", "description-only"];
/** A claim impact that comes with a fix to make. */
const fixable = (i: ClaimImpact) => i === "code-wrong" || i === "code-incomplete";
export type Claim = { claim: string; status: ClaimStatus; evidence: string; impact?: ClaimImpact; fix?: { file: string; change: string } };

export const MAX_CLAIMS = 12;
export const CLAIM_CHARS = 300;
export const CLAIM_EVIDENCE_CHARS = 600;
/**
 * A claim's evidence names code as `path:line`. The path is repo-relative with a directory or has a known source extension, and
 * does not follow a scheme or a `/` ("v2.0:1" and URLs do not count). Groups: path, line.
 */
export const EVIDENCE_AT = /(?<![\w./:-])((?:[\w.-]+\/)+[\w.-]+\.\w+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|h|cpp|cs|rb|php|sql|json|toml|ya?ml|md|css|html|sh)):(\d+)/;
/** The `path:line` an evidence text names, or null: a path of EVIDENCE_AT, or one of the PR's changed `files` (which may have no directory or listed extension). */
export function evidenceAt(evidence: string, files: readonly string[] = []): { path: string; line: number } | null {
  const m = EVIDENCE_AT.exec(evidence);
  if (m) return { path: m[1]!, line: Number(m[2]) };
  for (const f of files) {
    const k = new RegExp(`(?<![\\w./:-])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(evidence);
    if (k) return { path: f, line: Number(k[1]) };
  }
  return null;
}
const SANDBOX_PREFIX = new RegExp(`(^|[^\\w./-])${REPO_PATH}/`, "g");
/** The model reads the repository at the sandbox path; the posted text names repo-relative paths. */
export const stripSandboxPath = (s: string): string => s.replace(SANDBOX_PREFIX, "$1");
/** One line of plain text for a posted claim: no mentions, no raw HTML tags. */
const squashText = (s: string) => dropMarkup(s.replace(/\s+/g, " ")).trim();
/** What a posted claim says in place of a text that mentions the reference documentation. */
export const NEUTRAL_CLAIM = "a claim of the description";
export const NEUTRAL_EVIDENCE = "withheld";

export type ParsedClaims = {
  claims: Claim[];
  /** The position of each claim in the reply's array. */
  indexes: number[];
  /** Entries that are not a claim (no text, unknown status, not an object) and entries past MAX_CLAIMS: the claims list was not fully read. */
  rejected: number;
};

/**
 * The `claims` of a reply, or null when it is not an array. Every valid entry is returned, so each one reaches the verdict:
 * it needs a claim and a status. Entries that are not valid, and those past MAX_CLAIMS, are counted in `rejected`.
 * Every claim needs file:line evidence: without it a "verified" counts as unverified and any impact is "unknown", so a claim is
 * only settled when the model points at code. A contradicted or unverified claim carries the model's `impact` judgment; a missing
 * or invalid one is "unknown". Status and impact are judged on the evidence as written; the returned texts are the ones that
 * are stored and posted: a text that mentions the reference documentation or is in `drop` is replaced by a neutral line
 * (`keep`: leave them, for the lint). Evidence and fix files are repo-relative; a fix with an unsafe path is dropped.
 */
export function parseClaims(v: unknown, drop: ReadonlySet<string> = new Set(), keep = false, files: readonly string[] = []): ParsedClaims | null {
  if (!Array.isArray(v)) return null;
  const out: ParsedClaims = { claims: [], indexes: [], rejected: Math.max(0, v.length - MAX_CLAIMS) };
  v.slice(0, MAX_CLAIMS).forEach((x, index) => {
    const o = x as Record<string, unknown> | null;
    const text = o && typeof o === "object" && typeof o.claim === "string" ? squashText(stripSandboxPath(o.claim)).slice(0, CLAIM_CHARS) : "";
    if (!o || !text || (o.status !== "verified" && o.status !== "contradicted" && o.status !== "unverified")) { out.rejected++; return; }
    const proof = typeof o.evidence === "string" ? squashText(stripSandboxPath(o.evidence)).slice(0, CLAIM_EVIDENCE_CHARS) : "";
    const claim = !keep && (REFERENCE_LEAK.test(text) || drop.has(text)) ? NEUTRAL_CLAIM : text;
    const evidence = !keep && (REFERENCE_LEAK.test(proof) || drop.has(proof)) ? NEUTRAL_EVIDENCE : proof;
    const status: ClaimStatus = o.status === "verified" && !evidenceAt(proof, files) ? "unverified" : o.status;
    const f = o.fix as { file?: unknown; change?: unknown } | null | undefined;
    const file = f && typeof f === "object" && typeof f.file === "string" ? stripSandboxPath(f.file.trim()) : "";
    const fix = f && typeof f === "object" && typeof f.change === "string" && f.change.trim() && !drop.has(f.change) && safePath(file) && !REFERENCE_LEAK.test(file + f.change)
      ? { file: file.slice(0, 200), change: f.change.trim().slice(0, 800) } : undefined;
    out.indexes.push(index);
    if (status === "verified") { out.claims.push({ claim, status, evidence }); return; }
    const impact = (evidenceAt(proof, files) && typeof o.impact === "string" && CLAIM_IMPACTS.includes(o.impact) ? o.impact : "unknown") as ClaimImpact;
    out.claims.push(fix && fixable(impact) ? { claim, status, evidence, impact, fix } : { claim, status, evidence, impact });
  });
  return out;
}

/** The claims of a stored review: already checked and cleaned when stored, so only their shape is read again. */
export function storedClaims(v: unknown): Claim[] {
  return (Array.isArray(v) ? v : []).filter((c): c is Claim => !!c && typeof c === "object" && typeof c.claim === "string" && typeof c.evidence === "string" && typeof c.status === "string" && !REFERENCE_LEAK.test(c.claim + c.evidence));
}

export type PublicReview = { summary: string; points: string[] };

export const OPUS_PUBLIC_POINTS = 8;

/** Text that points at the private reference folder; such public text is dropped. */
export const REFERENCE_LEAK = /\/reference\b|\/repo-docs\b|\bAGENTS\.txt\b|\bp\d{4}\.txt\b/i;

/** `drop`: texts the reply lint still flagged after the fix turn (a reference mention, a quote, a reference to outside documentation); they are left out like a reference mention. */
export function parsePublic(v: unknown, drop: ReadonlySet<string> = new Set()): PublicReview | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.summary !== "string" || !o.summary.trim() || !Array.isArray(o.points)) return null;
  if (REFERENCE_LEAK.test(o.summary) || drop.has(o.summary)) { console.log("public review dropped: its summary mentions the reference documentation"); return null; }
  const kept = o.points.filter((x): x is string => typeof x === "string" && !!x.trim());
  const points = kept.slice(0, OPUS_PUBLIC_POINTS).filter((x) => !REFERENCE_LEAK.test(x) && !drop.has(x)).map((x) => x.trim().slice(0, 600));
  if (points.length < kept.length) console.log("public review: dropped a point that mentions the reference documentation");
  return { summary: o.summary.trim().slice(0, 600), points };
}

/**
 * A fix of the review. On the maintainer workflow it is a numbered plan part: `title` names it in a few words, `major` marks a finding a person must see before a merge.
 * `blocking`: whether it stops the merge of a PR a maintainer approved (class null: it does not, and is filed as a follow-up instead of made); absent counts as blocking.
 */
export type ReviewFix = { file: string; change: string; title?: string; major?: boolean; blocking?: Blocking };
export type { ReviewRecommendation };
/** Lines the change has outside what the pull request sets out to do, and the review's one recommendation. */
export type ReviewWorkflow = {
  /** `checked`: the note passed the reference and reply checks when it was parsed; a note stored without it is never filed. */
  outside_purpose: { lines: number; note: string; checked?: true } | null; recommendation: ReviewRecommendation | null;
  /** Asked only when the author pushed after a person approved the merge (`OpusPr.author_commits`): whether those commits stay within what was approved. */
  author_commits?: AuthorCommits | null;
  /** A hold's blocking class: whether its reason stops the merge of a PR a maintainer approved (class null: it does not, and the reason is filed as a follow-up). Absent counts as blocking. */
  hold?: Blocking | null;
};
export type AuthorCommits = { in_scope: boolean; note: string };

export const PART_TITLE_CHARS = 80;
export const OUTSIDE_NOTE_CHARS = 200;
export const RECOMMENDATION_CHARS = 300;

/**
 * The maintainer-workflow fields of a reply; null when it has neither. Anything malformed reads as absent. `partOf` maps a fix number of
 * the model's own list to its number in the stored fixes (null when that fix was left out); `keepRec` is false when the verdict was
 * rewritten. A recommendation that names a fix that was left out, that came with a rewritten verdict, or whose yes would run nothing is
 * dropped (the workflow builds one from the verdict). When the stored numbers differ from the model's, `text` is empty: the sentence
 * named other numbers, so the workflow writes it again.
 */
export function parseReviewWorkflow(r: Record<string, unknown>, partOf: (n: number) => number | null = (n) => n, keepRec = true, hold?: Blocking, drop: ReadonlySet<string> = new Set()): ReviewWorkflow | null {
  const o = r.outside_purpose as { lines?: unknown; note?: unknown } | null | undefined;
  const lines = o && typeof o === "object" && typeof o.lines === "number" && Number.isFinite(o.lines) && o.lines > 0 ? Math.round(o.lines) : 0;
  // The note may be filed in the PR's public follow-up issue: one that leaks the reference or that the reply checks flagged (`drop`) is not kept.
  const note = lines && typeof o!.note === "string" && !REFERENCE_LEAK.test(o!.note) && !drop.has(o!.note) ? o!.note : "";
  const outside = lines ? { lines, note: note.replace(/\s+/g, " ").trim().slice(0, OUTSIDE_NOTE_CHARS), checked: true as const } : null;
  const x = r.recommendation as { text?: unknown; fix?: unknown; merge?: unknown; close?: unknown; backlog?: unknown; author?: unknown; scope?: unknown } | null | undefined;
  const text = x && typeof x === "object" && typeof x.text === "string" && x.text.trim() && !REFERENCE_LEAK.test(x.text) ? firstSentence(x.text.replace(/\s+/g, " ").trim()).slice(0, RECOMMENDATION_CHARS) : null;
  const named = text && Array.isArray(x!.fix) ? [...new Set(x!.fix)] : [];
  const fix = named.map((n) => (Number.isInteger(n) ? partOf(n as number) : null));
  const close = !!text && x!.close === true && !named.length;
  const backlog = !!text && !close && x!.backlog === true && !named.length;
  // The author's turn runs no fix and no merge of ours; a scope question about it goes to a maintainer first.
  const asks = !!text && !close && !backlog && x!.author === true && !named.length;
  const scope = asks && x!.scope === true;
  const merge = !!text && !close && !backlog && !asks && x!.merge === true;
  const usable = keepRec && !!text && fix.every((n) => n !== null) && (fix.length > 0 || merge || close || backlog || asks);
  const exact = fix.every((n, i) => n === named[i]);
  const rec = usable ? { text: exact ? text! : "", fix: fix as number[], merge, close, ...(backlog ? { backlog: true as const } : {}), ...(asks ? { author: true as const } : {}), ...(scope ? { scope: true as const } : {}) } : null;
  const a = r.author_commits as { in_scope?: unknown; note?: unknown } | null | undefined;
  const author = a && typeof a === "object" && typeof a.in_scope === "boolean"
    ? { in_scope: a.in_scope, note: typeof a.note === "string" ? a.note.replace(/\s+/g, " ").trim().slice(0, OUTSIDE_NOTE_CHARS) : "" } : null;
  return outside || rec || author || hold ? { outside_purpose: outside, recommendation: rec, ...(author ? { author_commits: author } : {}), ...(hold ? { hold } : {}) } : null;
}

/** The class of a fix or hold the claims rule makes from a claim that shows wrong code: the PR does not do what it says. */
const CLAIM_BLOCKING: Blocking = { class: "off-purpose", why: "The pull request does not do what its title or description says." };
/** The class of a fix the claims rule makes from a claim that holds in the code the PR changes but not on every path: a follow-up. */
export const CLAIM_INCOMPLETE: Blocking = { class: null, why: "The change does what the pull request says where it changes the code; other paths or cases do not follow yet." };

export const OPUS_REASON_WORDS = 60;
export const OPUS_MAX_FIXES = 20;
const words = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(" ");

/** The reply's one JSON object (a one-element array is read too), or null. */
function replyObject(text: string): unknown {
  const v = wholeReplyJson(text);
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The one review for `ref` in a reply, or null. The reply must be one JSON value
 * (a one-element array is read too); take-fix needs at least one fix.
 * A summary or why over its word cap fails the reply unless `last`, which keeps its first sentence.
 * Claims rule: the code is what merges, not the description. A claim with impact "code-wrong" means the PR is not a take:
 * take-fix when every such claim names a fix, hold otherwise. A "code-incomplete" claim's fix is added as a fix that does not block (a take
 * becomes take-fix); one without a fix is a risk note. "description-only" changes nothing. An "unknown" impact, or no
 * `claims` list for a PR with a body (`body`), makes a take or take-fix unsure.
 * `files`: the PR's changed files, accepted as evidence paths. `drop`: see parsePublic. `keepLeaky`: keep fixes that mention the reference (the lint checks validity this way, so the fix turn can handle them; the stored review always drops them).
 */
export function parseOpusReply(text: string, ref: string, last = true, drop: ReadonlySet<string> = new Set(), keepLeaky = false, known: readonly OwnerStatement[] = [], body = "", files: readonly string[] = []): OpusReview | null {
  const o = replyObject(text);
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.ref !== ref) return null;
  const verdict = r.verdict;
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) return null;
  if (typeof r.reason !== "string" || !r.reason.trim() || typeof r.sure !== "boolean") return null;
  // `src`: the model's own number of each kept fix, for the recommendation's fix numbers.
  const kept = (Array.isArray(r.fixes) ? r.fixes : [])
    .map((f, i) => (f && typeof f.file === "string" && typeof f.change === "string" ? { file: stripSandboxPath(f.file.trim()).replace(/^\.\//, ""), change: f.change, title: f.title, major: f.major, blocking: blockingOf(f.blocking), src: i + 1 } : null))
    .filter((f): f is { file: string; change: string; title: unknown; major: unknown; blocking: Blocking | undefined; src: number } => !!f && safePath(f.file) && !!f.change.trim() && !drop.has(f.change) && (keepLeaky || (!REFERENCE_LEAK.test(f.file) && !REFERENCE_LEAK.test(f.change))))
    .slice(0, OPUS_MAX_FIXES);
  const src = kept.map((f) => f.src);
  const fixes = kept.map((f): ReviewFix => {
      const title = typeof f.title === "string" && f.title.trim() && !REFERENCE_LEAK.test(f.title) && !drop.has(f.title) ? f.title.replace(/\s+/g, " ").trim().slice(0, PART_TITLE_CHARS) : null;
      // A reason the checks did not clear is left out; the class still counts.
      const blocking = f.blocking && (REFERENCE_LEAK.test(f.blocking.why) || drop.has(f.blocking.why)) ? { ...f.blocking, why: "" } : f.blocking;
      return { file: f.file.slice(0, 200), change: f.change.slice(0, 800), ...(title ? { title } : {}), ...(f.major === true ? { major: true } : {}), ...(blocking ? { blocking } : {}) };
    });
  const risks = Array.isArray(r.risks) ? r.risks.filter((x): x is string => typeof x === "string").slice(0, 8).map((x) => x.slice(0, 300)) : [];
  const summary = proseField(r.summary, SUMMARY_MAX_WORDS, last), why = proseField(r.why, WHY_MAX_WORDS, last);
  if (!summary.ok || !why.ok) return null;
  const parsed = parseClaims(r.claims, drop, keepLeaky, files), listed = parsed?.claims ?? [];
  // Every valid claim reaches the verdict; only the texts stored and posted are cleaned. A list that was not fully read leaves the review unsure.
  const bad = listed.filter((c) => c.impact === "code-wrong"), unknownClaim = listed.find((c) => c.impact === "unknown");
  const incomplete = listed.filter((c) => c.impact === "code-incomplete"), incompleteFixes = incomplete.filter((c) => c.fix).map((c) => ({ ...c.fix!, blocking: CLAIM_INCOMPLETE }));
  // A take-fix needs a fix: its own list, the fix of every claim that shows wrong code, or the fix of an incomplete claim.
  if (verdict === "take-fix" && !fixes.length && !(bad.length ? bad.every((c) => c.fix) : incompleteFixes.length)) return null;
  const unproven = parsed === null ? !!body.trim() : parsed.rejected > 0 || !!unknownClaim;
  let outVerdict = verdict as ReviewVerdict, outFixes: ReviewFix[] = verdict === "take-fix" ? fixes : [], outReason = r.reason, sure = r.sure, shift = 0;
  const notes: string[] = [];
  if (bad.length && (outVerdict === "take" || outVerdict === "take-fix")) {
    const withFix = bad.filter((c) => c.fix);
    if (withFix.length === bad.length) { outVerdict = "take-fix"; shift = withFix.length; outFixes = [...withFix.map((c) => ({ ...c.fix!, blocking: CLAIM_BLOCKING })), ...outFixes].slice(0, OPUS_MAX_FIXES); }
    else { outVerdict = "hold"; outFixes = []; }
    outReason = `Claim shows wrong code: ${bad[0]!.claim} ${r.reason}`;
    notes.push(...bad.map((c) => `claim ${c.status}, code wrong: ${c.claim}: ${c.evidence}`.slice(0, 300)));
  }
  if (incomplete.length && (outVerdict === "take" || outVerdict === "take-fix")) {
    // After the code-wrong fixes, before the model's own: `shift` keeps the recommendation's fix numbers on the model's fixes.
    const at = outVerdict === "take-fix" ? shift : 0;
    if (incompleteFixes.length) { outFixes = [...outFixes.slice(0, at), ...incompleteFixes, ...outFixes.slice(at)].slice(0, OPUS_MAX_FIXES); shift = at + incompleteFixes.length; outVerdict = "take-fix"; }
    notes.push(...incomplete.map((c) => `claim ${c.status}, change incomplete: ${c.claim}: ${c.evidence}`.slice(0, 300)));
  }
  if (unproven && (outVerdict === "take" || outVerdict === "take-fix")) {
    sure = false;
    notes.push(parsed === null ? "the PR description's claims were not checked" : unknownClaim ? `claim ${unknownClaim.status}, impact unknown: ${unknownClaim.claim}`.slice(0, 300) : `${parsed.rejected} entries of the claims list were not read`);
  }
  // A take that only code-incomplete fixes made a take-fix keeps the model's recommendation: those fixes do not block.
  // A hold the claims rule made is off-purpose; the model's own hold carries the class it gave, or none (blocking).
  const holdClass = outVerdict !== "hold" ? undefined : verdict === "hold" ? blockingOf(r.blocking) : CLAIM_BLOCKING;
  const hold = holdClass && (REFERENCE_LEAK.test(holdClass.why) || drop.has(holdClass.why)) ? { ...holdClass, why: "" } : holdClass;
  return { ref, verdict: outVerdict, sure, reason: words(outReason, OPUS_REASON_WORDS), fixes: outFixes, risks: [...risks, ...notes], workflow: parseReviewWorkflow(r, (n) => {
    const i = verdict === "take-fix" ? src.indexOf(n) : -1;
    return i < 0 || i + shift >= outFixes.length ? null : i + shift + 1;
  }, outVerdict === verdict || !bad.length, hold, drop), summary: summary.text, why: oneSentence(why.text), public: parsePublic(r.public, drop), conflicts: parseStatementConflicts(r.conflicts, known), claims: listed, blocked_by: outVerdict === "hold" ? parseBlockedBy(r.blocked_by, ref) : [] };
}

/** The reply's reason before the word cut that the stored review applies. */
export function rawReason(text: string): string | null {
  const o = replyObject(text) as { reason?: unknown } | null;
  return typeof o?.reason === "string" ? o.reason : null;
}

/** How a review treats an earlier fix: kept in its fix list, explained in its reason (which names the file), or neither. Pass the uncut reason. */
export function carriedOutcome(r: { verdict: string; reason: string; fixes: { file: string }[] }, fix: { file: string }): "kept" | "explained" | "unaddressed" {
  if (!fix.file.trim()) return "unaddressed";
  if (r.verdict === "take-fix" && r.fixes.some((f) => f.file === fix.file)) return "kept";
  const reason = r.reason.toLowerCase(), path = fix.file.toLowerCase(), base = path.slice(path.lastIndexOf("/") + 1);
  const word = base ? new RegExp(`(?<![\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`) : null;
  return reason.includes(path) || (word?.test(reason) ?? false) ? "explained" : "unaddressed";
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The problems of a reply that the model can fix itself: a reference mention in a fix, a summary or why over its cap,
 * a why of more than one sentence, an unapplied fix a take ignores. Null when the reply is not a valid review (the whole call is asked again then).
 */
/** `classed`: the prompt asked for blocking classes (the maintainer-workflow rule was sent), so a missing one is a problem. */
export function lintOpusReply(text: string, ref: string, unapplied: readonly UnappliedFix[] = [], body = "", classed = false): LintProblem[] | null {
  const parsed = parseOpusReply(text, ref, true, new Set(), true);
  if (!parsed) return null;
  const r = replyObject(text) as Record<string, unknown>;
  const out: LintProblem[] = [];
  if (body.trim() && !Array.isArray(r.claims)) out.push({ field: "claims", message: "is missing; list every behavioural claim of the title and body with its status and file:line evidence" });
  // A take-fix keeps the list the model chose; a hold or close makes the old fixes moot. Only a take that ignores them is a problem.
  if (parsed.verdict === "take" && !parsed.fixes.length) {
    unapplied.forEach((u, i) => {
      if (carriedOutcome({ ...parsed, reason: String(r.reason) }, u) === "unaddressed") {
        out.push({ field: `unapplied_fixes[${i}]`, message: `(${u.file}) is neither in fixes nor explained in reason; if the change is still needed, answer take-fix and list it; otherwise say in reason why it is no longer needed`, fix: ["verdict", "fixes", "reason"] });
      }
    });
  }
  const classes = `{"class": ${BLOCKING_CLASSES.map((c) => `"${c}"`).join(" | ")} | null, "why": "<one sentence>"}`;
  (Array.isArray(r.fixes) ? r.fixes : []).forEach((f: { file?: unknown; change?: unknown; blocking?: unknown }, i) => {
    for (const k of ["file", "change"] as const) if (typeof f?.[k] === "string" && REFERENCE_LEAK.test(f[k] as string)) out.push({ field: `fixes[${i}].${k}`, message: "mentions the reference folder or one of its pages; state the behaviour in your own words" });
    if (classed && parsed.verdict === "take-fix" && f && typeof f === "object" && !blockingOf(f.blocking)) out.push({ field: `fixes[${i}].blocking`, message: `is missing; give ${classes}` });
  });
  if (classed && parsed.verdict === "hold" && r.verdict === "hold" && !blockingOf(r.blocking)) out.push({ field: "blocking", message: `is missing for the hold; give ${classes}` });
  if (typeof r.summary === "string" && wordCount(r.summary) > SUMMARY_MAX_WORDS) out.push({ field: "summary", message: `has ${wordCount(r.summary)} words; at most ${SUMMARY_MAX_WORDS}, in 2 or 3 sentences` });
  if (typeof r.why === "string" && squash(r.why)) {
    if (wordCount(r.why) > WHY_MAX_WORDS) out.push({ field: "why", message: `has ${wordCount(r.why)} words; at most ${WHY_MAX_WORDS}, in one sentence` });
    else if (firstSentence(r.why) !== squash(r.why)) out.push({ field: "why", message: "has more than one sentence; write one" });
  }
  return out;
}

/**
 * The texts of a reply that can reach GitHub, for the reference and owner-statement checks, with the field each is in (the
 * index is the position in the reply's array): public text and claims are posted with the review, a fix's change is
 * posted in the comment that lists the fixes when they cannot be pushed, and a title, blocking reason and outside-purpose note in the review post and the follow-up issue.
 */
export function publicTexts(text: string): { field: string; text: string }[] {
  const r = replyObject(text) as { public?: { summary?: unknown; points?: unknown }; claims?: unknown; fixes?: unknown; outside_purpose?: { note?: unknown } | null } | null;
  const pc = parseClaims(r?.claims, new Set(), true);
  const claimTexts = (pc?.claims ?? []).flatMap((c, k) => { const i = pc!.indexes[k]!; return [{ field: `claims[${i}].claim`, text: c.claim }, ...(c.evidence ? [{ field: `claims[${i}].evidence`, text: c.evidence }] : [])]; });
  const claimFixes = (Array.isArray(r?.claims) ? r.claims : []).flatMap((c: { fix?: { change?: unknown } } | null, i) => (typeof c?.fix?.change === "string" && c.fix.change.trim() ? [{ field: `claims[${i}].fix.change`, text: c.fix.change }] : []));
  // A blocking reason as the parse keeps it (one line, cut), so a text the lint flags is the text the parse matches.
  const whyOf = (b: unknown): string => blockingOf(b)?.why ?? "";
  const fixes = (Array.isArray(r?.fixes) ? r.fixes : []).slice(0, OPUS_MAX_FIXES).flatMap((f: { change?: unknown; title?: unknown; blocking?: unknown } | null, i) => [
    ...(typeof f?.change === "string" && f.change.trim() ? [{ field: `fixes[${i}].change`, text: f.change }] : []),
    // A title is posted with the review of a PR approved for merge, and in its follow-up issue.
    ...(typeof f?.title === "string" && f.title.trim() ? [{ field: `fixes[${i}].title`, text: f.title }] : []),
    // A reason that does not block is filed in the follow-up issue.
    ...(whyOf(f?.blocking) ? [{ field: `fixes[${i}].blocking.why`, text: whyOf(f?.blocking) }] : []),
  ]);
  const hw = whyOf((r as { blocking?: unknown } | null)?.blocking);
  if (hw) fixes.push({ field: "blocking.why", text: hw });
  // The note of lines outside the purpose is filed in the follow-up issue.
  const on = r?.outside_purpose && typeof r.outside_purpose === "object" ? r.outside_purpose.note : undefined;
  if (typeof on === "string" && on.trim()) fixes.push({ field: "outside_purpose.note", text: on });
  const p = r?.public;
  if (!p || typeof p !== "object") return [...claimTexts, ...claimFixes, ...fixes];
  return [
    ...(typeof p.summary === "string" && p.summary.trim() ? [{ field: "public.summary", text: p.summary }] : []),
    ...claimTexts,
    // Only the points parsePublic keeps (the first OPUS_PUBLIC_POINTS non-empty ones), so a long list makes no extra checks.
    ...(Array.isArray(p.points) ? p.points.flatMap((x, i) => (typeof x === "string" && x.trim() ? [{ field: `public.points[${i}]`, text: x }] : [])).slice(0, OPUS_PUBLIC_POINTS) : []),
    ...claimFixes, ...fixes,
  ];
}
