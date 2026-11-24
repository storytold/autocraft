// Opus review prompt input and reply validation. No I/O and no Node imports: the
// prompt registry (also loaded by the web mockup) imports this file.
import { wholeReplyJson } from "../core/reply-json.ts";
import { VERDICTS, type DiscussionEntry, type ReviewVerdict } from "./parse.ts";
import { firstSentence, oneSentence, proseField, SUMMARY_MAX_WORDS, WHY_MAX_WORDS, wordCount } from "../prose.ts";
import type { PostmergeReviewRow, RelatedItem } from "../postmerge/parse.ts";
import type { LintProblem } from "../replylint.ts";
import { safePath } from "../fixup/patch.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { codeParts, dropMarkup } from "./public-text.ts";

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
  title: string;
  body: string;
  author_association: string | null;
  size: string;
  lines_changed: number;
  ci: string;
  mergeable: string | null;
  files: string[];
  tests_omitted: string[];
  lockfiles_omitted: string[];
  /** full: the whole diff of the PR. delta: only the changes since `earlier_opus.head`. */
  mode: "full" | "delta";
  earlier_opus: EarlierOpus | null;
  /** Present only when an earlier take-fix's fixes were never applied; the reply must keep or explain each. */
  unapplied_fixes?: UnappliedFix[];
  /** Present only when a person's keep-in-core scope answer stands for this PR: the review does not reopen scope. */
  scope_settled?: { answer: string; by: string | null; note: string | null };
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
  fixes: { file: string; change: string }[];
  risks: string[];
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
/** What a contradicted or unverified claim means for the merge: the code is wrong, only the description is stale, or the model cannot tell. */
export type ClaimImpact = "code-wrong" | "description-only" | "unknown";
export type Claim = { claim: string; status: ClaimStatus; evidence: string; impact?: ClaimImpact; fix?: { file: string; change: string } };

export const MAX_CLAIMS = 12;
export const CLAIM_CHARS = 300;
export const CLAIM_EVIDENCE_CHARS = 600;
// Without a delimiter, require a directory, a recognizable root filename, or a known changed file.
// A code span delimits paths with spaces or punctuation without guessing where the prose ends.
const PATH_CHAR = String.raw`[\p{L}\p{M}\p{N}_@+.-]`;
const PATH_WORD = String.raw`${PATH_CHAR}+`;
const PATH_PART = String.raw`${PATH_WORD}(?: +${PATH_WORD})*`;
const ROOT_EXTENSION = "ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|h|cpp|cs|rb|php|sql|json|toml|ya?ml|md|css|html|sh";
const NESTED_OR_DOT_PATH = String.raw`/?${PATH_WORD}/(?:${PATH_PART}/)*${PATH_PART}|/?\.[\p{L}_]${PATH_CHAR}*`;
// With a checkout, the filesystem can distinguish an unfamiliar extension from a missing file.
const FILE_EXTENSION = String.raw`[\p{L}][\p{L}\p{M}\p{N}_-]*`;
const LINE_TOKEN = String.raw`[+-]?\d+(?:\.\d+|[\p{L}\p{M}_][\p{L}\p{M}\p{N}_]*)?`;
type ClaimLocation = { path: string; line: number };
export type ClaimLocationCheck = (location: ClaimLocation) => boolean;

const MAX_CITATION_SCAN_CHARS = 16_000;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function citation(path: string, line: string): ClaimLocation {
  return { path: path.replace(/^\/repo\//, ""), line: /^\d+$/.test(line) ? Number(line) : NaN };
}

function* evidenceLocations(evidence: string, files: readonly string[], withCheckout = false): Generator<ClaimLocation, void> {
  // An overlong reply remains unverified. Scanning only a prefix could miss a citation.
  if (evidence.length > MAX_CITATION_SCAN_CHARS) return;
  const known = files.filter((path) => evidence.includes(`${path}:`))
    .sort((a, b) => b.length - a.length)
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const extension = withCheckout ? FILE_EXTENSION : ROOT_EXTENSION;
  const rootPath = String.raw`/?${PATH_WORD}\.(?:${extension})`;
  const bare = [...known, NESTED_OR_DOT_PATH, rootPath].join("|");
  const pattern = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}_@+./:-])(${bare}):(${LINE_TOKEN})`, "gu");

  for (const [i, part] of codeParts(evidence).entries()) {
    if (i % 2 === 1) {
      // Code fences are examples. An inline code span is one literal path:line candidate.
      if (/^ {0,3}(?:`{3,}|~{3,})[^\n]*\n/.test(part)) continue;
      const ticks = /^`+/.exec(part)?.[0].length ?? 0;
      const text = part.slice(ticks, -ticks).trim();
      const colon = text.lastIndexOf(":");
      if (colon < 0 || URL_SCHEME.test(text)) continue;
      const line = text.slice(colon + 1);
      if (/^[+-]?\d/.test(line)) yield citation(text.slice(0, colon), line);
      continue;
    }

    // The Markdown parser leaves an unclosed span in prose. Its contents should not become bare citations.
    const unclosed = /(?:^|[^\\])(?:\\\\)*`/.exec(part);
    const end = unclosed ? unclosed.index + unclosed[0].length - 1 : part.length;
    for (const match of part.slice(0, end).matchAll(pattern)) yield citation(match[1]!, match[2]!);
    if (unclosed && /:[+-]?\d/.test(part.slice(end))) yield { path: "", line: NaN };
  }
}

/** The first repository-relative citation, including changed files without a familiar extension. */
function evidenceAt(evidence: string, files: readonly string[] = []): ClaimLocation | null {
  const first = evidenceLocations(evidence, files).next();
  return first.done ? null : first.value;
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
  /** The location for a pre-merge finding, in the same order as claims. */
  findingLocations: (ClaimLocation | null)[];
  /** Entries that are not a claim (no text, unknown status, not an object) and entries past MAX_CLAIMS: the claims list was not fully read. */
  rejected: number;
  /** Claim fixes withheld because their citations did not resolve. */
  withheldFixes: NonNullable<Claim["fix"]>[];
};

/**
 * The `claims` of a reply, or null when it is not an array. Every valid entry is returned, so each one reaches the verdict:
 * it needs a claim and a status. Entries that are not valid, and those past MAX_CLAIMS, are counted in `rejected`.
 * Every claim needs file:line evidence: without it a "verified" counts as unverified and any impact is "unknown", so a claim is
 * only settled when the model points at code. With a checkout, every citation must also resolve there.
 * A contradicted or unverified claim carries the model's `impact` judgment; a missing
 * or invalid one is "unknown". Status and impact are judged on the evidence as written; the returned texts are the ones that
 * are stored and posted: a text that mentions the reference documentation or is in `drop` is replaced by a neutral line
 * (`keep`: leave them, for the lint). Evidence and fix files are repo-relative; a fix with an unsafe path is dropped.
 */
export function parseClaims(v: unknown, drop: ReadonlySet<string> = new Set(), keep = false, files: readonly string[] = [], checkLocation?: ClaimLocationCheck): ParsedClaims | null {
  if (!Array.isArray(v)) return null;
  const out: ParsedClaims = { claims: [], indexes: [], findingLocations: [], rejected: Math.max(0, v.length - MAX_CLAIMS), withheldFixes: [] };
  v.slice(0, MAX_CLAIMS).forEach((x, index) => {
    const o = x as Record<string, unknown> | null;
    const text = o && typeof o === "object" && typeof o.claim === "string" ? squashText(stripSandboxPath(o.claim)).slice(0, CLAIM_CHARS) : "";
    if (!o || !text || (o.status !== "verified" && o.status !== "contradicted" && o.status !== "unverified")) { out.rejected++; return; }
    const fullProof = typeof o.evidence === "string" ? o.evidence : "";
    const displayProof = squashText(stripSandboxPath(fullProof));
    const prefix = displayProof.slice(0, CLAIM_EVIDENCE_CHARS);
    // A clipped line number can look like a different, valid location.
    const proof = /\S/.test(displayProof[CLAIM_EVIDENCE_CHARS] ?? "") ? prefix.replace(/\S+$/, "").trimEnd() : prefix;
    const claim = !keep && (REFERENCE_LEAK.test(text) || drop.has(text)) ? NEUTRAL_CLAIM : text;
    const evidence = !keep && (REFERENCE_LEAK.test(proof) || drop.has(proof)) ? NEUTRAL_EVIDENCE : proof;
    const locations = evidenceLocations(checkLocation ? fullProof : proof, files, !!checkLocation);
    const first = locations.next();
    const supported = !first.done && (checkLocation
      ? checkLocation(first.value) && [...locations].every(checkLocation)
      : safePath(first.value.path) && Number.isSafeInteger(first.value.line) && first.value.line > 0);
    const status: ClaimStatus = !supported && (o.status === "verified" || checkLocation) ? "unverified" : o.status;
    const f = o.fix as { file?: unknown; change?: unknown } | null | undefined;
    const file = f && typeof f === "object" && typeof f.file === "string" ? fixFile(f.file) : "";
    const fix = f && typeof f === "object" && typeof f.change === "string" && f.change.trim() && !drop.has(f.change) && safePath(file) && !REFERENCE_LEAK.test(file + f.change)
      ? { file: file.slice(0, 200), change: f.change.trim().slice(0, 800) } : undefined;
    if (checkLocation && !supported && o.status !== "verified" && o.impact === "code-wrong" && fix) out.withheldFixes.push(fix);
    out.indexes.push(index);
    const impact: ClaimImpact = supported && (o.impact === "code-wrong" || o.impact === "description-only") ? o.impact : "unknown";
    let findingLocation: ClaimLocation | null = null;
    if (status !== "verified" && impact === "code-wrong" && evidence !== NEUTRAL_EVIDENCE) {
      const at = checkLocation && !first.done ? first.value : evidenceAt(evidence, files);
      if (at && safePath(at.path) && !REFERENCE_LEAK.test(at.path) && dropMarkup(at.path) === at.path) findingLocation = at;
    }
    out.findingLocations.push(findingLocation);
    if (status === "verified") { out.claims.push({ claim, status, evidence }); return; }
    out.claims.push(fix && impact === "code-wrong" ? { claim, status, evidence, impact, fix } : { claim, status, evidence, impact });
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

export const OPUS_REASON_WORDS = 60;
export const OPUS_MAX_FIXES = 20;
const fixFile = (file: string): string => stripSandboxPath(file.trim()).replace(/^\.\//, "");
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
 * take-fix when every such claim names a fix, hold otherwise. "description-only" changes nothing. An "unknown" impact, or no
 * `claims` list for a PR with a body (`body`), makes a take or take-fix unsure.
 * `files`: the PR's changed files, accepted as evidence paths. `drop`: see parsePublic. `keepLeaky`: keep fixes that mention the reference (the lint checks validity this way, so the fix turn can handle them; the stored review always drops them).
 */
export function parseOpusReply(text: string, ref: string, last = true, drop: ReadonlySet<string> = new Set(), keepLeaky = false, known: readonly OwnerStatement[] = [], body = "", files: readonly string[] = [], checkLocation?: ClaimLocationCheck): OpusReview | null {
  const o = replyObject(text);
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.ref !== ref) return null;
  const verdict = r.verdict;
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) return null;
  if (typeof r.reason !== "string" || !r.reason.trim() || typeof r.sure !== "boolean") return null;
  const parsed = parseClaims(r.claims, drop, keepLeaky, files, checkLocation), listed = parsed?.claims ?? [];
  const fixes = (Array.isArray(r.fixes) ? r.fixes : [])
    .map((f) => (f && typeof f.file === "string" && typeof f.change === "string" ? { file: fixFile(f.file), change: f.change } : null))
    .filter((f): f is { file: string; change: string } => !!f && safePath(f.file) && !!f.change.trim() && !drop.has(f.change) && (keepLeaky || (!REFERENCE_LEAK.test(f.file) && !REFERENCE_LEAK.test(f.change))))
    .slice(0, OPUS_MAX_FIXES)
    .filter((f) => !parsed?.withheldFixes.some((fix) => fix.file === f.file.slice(0, 200) && fix.change === f.change.trim().slice(0, 800)))
    .map((f) => ({ file: f.file.slice(0, 200), change: f.change.slice(0, 800) }));
  const risks = Array.isArray(r.risks) ? r.risks.filter((x): x is string => typeof x === "string").slice(0, 8).map((x) => x.slice(0, 300)) : [];
  const summary = proseField(r.summary, SUMMARY_MAX_WORDS, last), why = proseField(r.why, WHY_MAX_WORDS, last);
  if (!summary.ok || !why.ok) return null;
  // Every valid claim reaches the verdict; only the texts stored and posted are cleaned. A list that was not fully read leaves the review unsure.
  const bad = listed.filter((c) => c.impact === "code-wrong"), unknownClaim = listed.find((c) => c.impact === "unknown");
  // A take-fix needs a fix. If citation checking withheld it, keep the review for an operator.
  const noFix = verdict === "take-fix" && !fixes.length && !(bad.length && bad.every((c) => c.fix));
  if (noFix && !parsed?.withheldFixes.length) return null;
  const unproven = parsed === null ? !!body.trim() : parsed.rejected > 0 || !!unknownClaim;
  let outVerdict = (noFix ? "take" : verdict) as ReviewVerdict, outFixes = verdict === "take-fix" ? fixes : [], outReason = r.reason, sure = r.sure;
  const notes: string[] = [];
  if (bad.length && (outVerdict === "take" || outVerdict === "take-fix")) {
    const withFix = bad.filter((c) => c.fix);
    if (withFix.length === bad.length) { outVerdict = "take-fix"; outFixes = [...withFix.map((c) => c.fix!), ...outFixes].slice(0, OPUS_MAX_FIXES); }
    else { outVerdict = "hold"; outFixes = []; }
    outReason = `Claim shows wrong code: ${bad[0]!.claim} ${r.reason}`;
    notes.push(...bad.map((c) => `claim ${c.status}, code wrong: ${c.claim}: ${c.evidence}`.slice(0, 300)));
  }
  if (unproven && (outVerdict === "take" || outVerdict === "take-fix")) {
    sure = false;
    notes.push(parsed === null ? "the PR description's claims were not checked" : unknownClaim ? `claim ${unknownClaim.status}, impact unknown: ${unknownClaim.claim}`.slice(0, 300) : `${parsed.rejected} entries of the claims list were not read`);
  }
  return { ref, verdict: outVerdict, sure, reason: words(outReason, OPUS_REASON_WORDS), fixes: outFixes, risks: [...risks, ...notes], summary: summary.text, why: oneSentence(why.text), public: parsePublic(r.public, drop), conflicts: parseStatementConflicts(r.conflicts, known), claims: listed, blocked_by: outVerdict === "hold" ? parseBlockedBy(r.blocked_by, ref) : [] };
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
export function lintOpusReply(text: string, ref: string, unapplied: readonly UnappliedFix[] = [], body = ""): LintProblem[] | null {
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
  (Array.isArray(r.fixes) ? r.fixes : []).forEach((f: { file?: unknown; change?: unknown }, i) => {
    for (const k of ["file", "change"] as const) if (typeof f?.[k] === "string" && REFERENCE_LEAK.test(f[k] as string)) out.push({ field: `fixes[${i}].${k}`, message: "mentions the reference folder or one of its pages; state the behaviour in your own words" });
  });
  if (typeof r.summary === "string" && wordCount(r.summary) > SUMMARY_MAX_WORDS) out.push({ field: "summary", message: `has ${wordCount(r.summary)} words; at most ${SUMMARY_MAX_WORDS}, in 2 or 3 sentences` });
  if (typeof r.why === "string" && squash(r.why)) {
    if (wordCount(r.why) > WHY_MAX_WORDS) out.push({ field: "why", message: `has ${wordCount(r.why)} words; at most ${WHY_MAX_WORDS}, in one sentence` });
    else if (firstSentence(r.why) !== squash(r.why)) out.push({ field: "why", message: "has more than one sentence; write one" });
  }
  return out;
}

/**
 * The texts of a reply that can reach GitHub, for the reference and owner-statement checks, with the field each is in (the
 * index is the position in the reply's array): public text and claims are posted with the review, and a fix's change is
 * posted in the comment that lists the fixes when they cannot be pushed.
 */
export function publicTexts(text: string): { field: string; text: string }[] {
  const r = replyObject(text) as { public?: { summary?: unknown; points?: unknown }; claims?: unknown; fixes?: unknown } | null;
  const pc = parseClaims(r?.claims, new Set(), true);
  const claimTexts = (pc?.claims ?? []).flatMap((c, k) => { const i = pc!.indexes[k]!; return [{ field: `claims[${i}].claim`, text: c.claim }, ...(c.evidence ? [{ field: `claims[${i}].evidence`, text: c.evidence }] : [])]; });
  const claimFixes = (Array.isArray(r?.claims) ? r.claims : []).flatMap((c: { fix?: { change?: unknown } } | null, i) => (typeof c?.fix?.change === "string" && c.fix.change.trim() ? [{ field: `claims[${i}].fix.change`, text: c.fix.change }] : []));
  const fixes = (Array.isArray(r?.fixes) ? r.fixes : []).flatMap((f: { change?: unknown } | null, i) => (typeof f?.change === "string" && f.change.trim() ? [{ field: `fixes[${i}].change`, text: f.change }] : [])).slice(0, OPUS_MAX_FIXES);
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
