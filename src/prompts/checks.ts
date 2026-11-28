// The checks a prompt edit or a repository's guidance passes before it is stored (AUTO-157). An edit keeps every locked
// block of the code's text form as it is, adds no placeholder and no control character, stays within a size, carries no
// credential and comes with a note. Server-only (the credential shapes live with the runner's scrubber).
import { hasFixedCredential } from "../runner/scrub.ts";
import { harnessSpans } from "./harness.ts";
import { CLAUDE_PROMPTS, GUIDANCE_PROMPT_ID, JEV_PROMPTS, BASE_SCOPE, codeBody, jevPromptOf, jevRequestWith, sameTemplateOf, type ClaudePromptId, type JevPromptId } from "./index.ts";
import { criteriaLabels, jevLead } from "./jev-body.ts";
import { mergeEdit, segments, stripLocks, type Segment } from "./locks.ts";
import { DATA_LOCK, HARNESS_LOCK } from "./template-locks.ts";

export type Problem = { where: string; message: string };

/** The largest stored body. */
export const BODY_MAX_BYTES = 100_000;
/** A repository's guidance, in characters. */
export const GUIDANCE_MAX = 4000;
export const NOTE_MAX = 300;
/** A Jev instruction or criterion text, in characters, or twice the release's text where that is longer. */
export const JEV_TEXT_MAX = 1000;
/** Editable text may grow to twice the code default's, plus this much. */
const GROWTH = 2000;

/** The active revision an edit is checked against: its number, body and whether it follows the release. */
export type ActiveRevision = { rev: number; body: string; follows: boolean } | null;

/** Control characters (C0 but tab and newline, DEL, C1), zero-width characters, bidirectional overrides and isolates, and the byte-order mark. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const TOKEN = /\b(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/i;
const MARKER = /[⟦⟧]/;

/** A body as it is checked and stored: Windows line endings become newlines. */
export const normaliseBody = (body: string): string => body.replace(/\r\n/g, "\n");

const hasCredential = (text: string): boolean => hasFixedCredential(text) || TOKEN.test(text);

function textProblems(where: string, text: string): Problem[] {
  const out: Problem[] = [];
  if (text.includes("{{")) out.push({ where, message: "editable text cannot hold {{: placeholders are filled by code and stay in their locked blocks" });
  if (MARKER.test(text)) out.push({ where, message: "editable text cannot hold the lock brackets ⟦ ⟧" });
  if (CONTROL.test(text)) out.push({ where, message: "editable text cannot hold control characters" });
  if (hasCredential(text)) out.push({ where, message: "the text holds what looks like a credential" });
  return out;
}

/** The problems of a revision's note: required, at most NOTE_MAX characters, no control characters, no credential. */
export function noteProblems(note: string): Problem[] {
  const n = note.trim();
  if (!n) return [{ where: "note", message: "a note saying why is required" }];
  if (n.length > NOTE_MAX) return [{ where: "note", message: `the note is longer than ${NOTE_MAX} characters` }];
  if (CONTROL.test(n)) return [{ where: "note", message: "the note cannot hold control characters" }];
  if (hasCredential(n)) return [{ where: "note", message: "the note holds what looks like a credential" }];
  return [];
}

const editable = (segs: readonly Segment[]): string => segs.filter((s) => !s.locked).map((s) => s.text).join("");

/** The text that runs for the active revision of a Claude prompt: the code's when none is active or it follows the release, else the edit with the code's locks. */
const runningText = (id: ClaudePromptId, active: ActiveRevision): string => {
  const code = codeBody(id);
  return stripLocks(active && !active.follows ? mergeEdit(code, active.body) ?? code : code);
};

/** Each harness lock must still be read as harness text in place: editable text next to a sandbox path can change how it matches. */
function harnessProblems(segs: readonly Segment[]): Problem[] {
  const text = segs.map((s) => s.text).join("");
  const spans = harnessSpans(text);
  const out: Problem[] = [];
  let at = 0;
  for (const s of segs) {
    if (s.locked && s.name === HARNESS_LOCK && !spans.some(([a, b]) => a === at && b === at + s.text.length)) {
      out.push({ where: `locked block ${s.name}`, message: `the text around "${s.text.trim().slice(0, 40)}" changes how it is read; leave a space or punctuation next to it` });
    }
    at += s.text.length;
  }
  return out;
}

function claudeProblems(id: ClaudePromptId, body: string, active: ActiveRevision): Problem[] {
  if (Buffer.byteLength(body) > BODY_MAX_BYTES) return [{ where: "body", message: `the prompt is larger than ${BODY_MAX_BYTES / 1000} KB` }];
  const segs = segments(body);
  if (!segs) return [{ where: "body", message: "the lock markers do not pair up: a locked block was opened, closed or nested where it cannot be" }];
  const code = segments(codeBody(id))!;
  const mine = segs.filter((s) => s.locked), theirs = code.filter((s) => s.locked);
  const out: Problem[] = [];
  if (mine.length !== theirs.length || mine.some((s, i) => s.name !== theirs[i]!.name)) {
    out.push({ where: "locked blocks", message: `the locked blocks must stay as the release has them, in order: ${theirs.map((s) => s.name).join(", ")}` });
  } else {
    mine.forEach((s, i) => { if (s.text !== theirs[i]!.text) out.push({ where: `locked block ${s.name} (${i + 1})`, message: "a locked block cannot be changed" }); });
  }
  const placeholders = (t: string): string => [...stripLocks(t).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort().join(",");
  if (placeholders(body) !== placeholders(codeBody(id))) out.push({ where: "body", message: "the prompt must hold the same placeholders as the release, each in its locked block" });
  const last = segs.at(-1);
  if (theirs.at(-1)?.name === DATA_LOCK && !(last?.locked && last.name === DATA_LOCK)) out.push({ where: "body", message: "nothing can follow the data block, which ends the prompt" });
  segs.forEach((s, i) => { if (!s.locked) out.push(...textProblems(`editable text ${i + 1}`, s.text)); });
  const limit = 2 * editable(code).length + GROWTH;
  if (editable(segs).length > limit) out.push({ where: "body", message: `the editable text is longer than ${limit} characters, twice the release's plus ${GROWTH}` });
  if (!out.length) out.push(...harnessProblems(segs));
  if (!out.length && stripLocks(body) === runningText(id, active)) out.push({ where: "body", message: "the text is the same as the active revision's" });
  return out;
}

function guidanceProblems(body: string, active: ActiveRevision): Problem[] {
  if (body.length > GUIDANCE_MAX) return [{ where: "guidance", message: `guidance is at most ${GUIDANCE_MAX} characters` }];
  const out = textProblems("guidance", body);
  if (!out.length && body.trim() === (active?.body ?? "").trim()) out.push({ where: "guidance", message: "the guidance is the same as the active revision's" });
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One instruction or criterion text of a Jev edit: a non-empty string within its limit, with the checks of any editable text. */
function jevTextProblems(where: string, v: unknown, code: string): Problem[] {
  if (typeof v !== "string" || !v.trim()) return [{ where, message: "the text cannot be empty" }];
  const limit = Math.max(JEV_TEXT_MAX, 2 * code.length);
  if (v.length > limit) return [{ where, message: `the text is longer than ${limit} characters` }];
  return textProblems(where, v);
}

/**
 * The problems of a Jev prompt's edit (src/prompts/jev-body.ts): the same question keys, no type, model or state, the same
 * criteria labels for each question, and only text that passes the checks of editable text. Code reads the answers by
 * key and label (classify/parse.ts, priority/score.ts, the merged classify request), so those never change.
 */
export function checkJevEdit(id: JevPromptId, body: string, active: ActiveRevision): Problem[] {
  if (Buffer.byteLength(body) > BODY_MAX_BYTES) return [{ where: "body", message: `the prompt is larger than ${BODY_MAX_BYTES / 1000} KB` }];
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return [{ where: "body", message: "the body is not JSON of the questions' text" }]; }
  if (!isRecord(parsed) || !isRecord(parsed.questions)) return [{ where: "body", message: "the body holds the questions' text as {\"questions\": {key: {\"instructions\", \"criteria\"}}}" }];
  const out: Problem[] = [];
  const extra = Object.keys(parsed).filter((k) => k !== "questions");
  if (extra.length) out.push({ where: "body", message: `only the questions' text can change, not ${extra.join(", ")}` });
  const code = jevPromptOf(id).request.questions, given = parsed.questions;
  for (const k of Object.keys(given)) if (!(k in code)) out.push({ where: `question ${k}`, message: `${k} is not a question of this prompt; its questions are ${Object.keys(code).join(", ")}` });
  for (const [k, q] of Object.entries(code)) {
    const e = given[k], where = `question ${k}`;
    if (e === undefined) { out.push({ where, message: "the question is missing: every question stays, under its key" }); continue; }
    if (!isRecord(e)) { out.push({ where, message: "the question holds {\"instructions\", \"criteria\"}" }); continue; }
    for (const f of Object.keys(e)) {
      if (f === "type") out.push({ where, message: "the type of a question is fixed" });
      else if (f !== "instructions" && f !== "criteria") out.push({ where, message: `only instructions and criteria can change, not ${f}` });
    }
    const lead = jevLead(q.instructions);
    out.push(...jevTextProblems(`${where} instructions`, e.instructions, q.instructions.slice(lead.length)));
    if (lead && typeof e.instructions === "string" && e.instructions.trimStart().startsWith(lead.trim())) out.push({ where: `${where} instructions`, message: "leave out the opening sentence: it stays as the release has it and is added in front" });
    const labels = criteriaLabels(q.criteria);
    const crit = e.criteria === undefined ? {} : e.criteria;
    if (!isRecord(crit)) { out.push({ where: `${where} criteria`, message: "criteria are {label: text}" }); continue; }
    if (!labels.length && Object.keys(crit).length) { out.push({ where: `${where} criteria`, message: "this question has no criteria to edit" }); continue; }
    const got = criteriaLabels(crit as Record<string, string>);
    if (got.join("\n") !== labels.join("\n")) { out.push({ where: `${where} criteria`, message: `the labels are fixed: ${labels.join(", ")}` }); continue; }
    for (const l of labels) out.push(...jevTextProblems(`${where} criterion ${l}`, crit[l], q.criteria![l]!));
  }
  if (out.length) return out;
  const running = (active && !active.follows && jevRequestWith(id, active.body)) || jevPromptOf(id).request;
  if (JSON.stringify(jevRequestWith(id, body)) === JSON.stringify(running)) return [{ where: "body", message: "the text is the same as the active revision's" }];
  return [];
}

/**
 * The problems that keep an edit from being stored, [] when it may be. `id` is a Claude prompt in the base scope,
 * a Jev prompt in the base scope (checkJevEdit), or repo.guidance in a repo's scope. The active revision's number is
 * compared by the save itself, inside its write.
 */
export function checkEdit(id: string, scope: string, raw: string, note: string, active: ActiveRevision): Problem[] {
  const body = normaliseBody(raw);
  const out: Problem[] = [];
  if (id === GUIDANCE_PROMPT_ID) {
    if (scope === BASE_SCOPE) return [{ where: "scope", message: "guidance belongs to one repository" }];
    out.push(...guidanceProblems(body, active));
  } else if (scope !== BASE_SCOPE) {
    return [{ where: "scope", message: "a prompt is edited for the whole instance; a repository adds guidance instead" }];
  } else if (id in JEV_PROMPTS) {
    out.push(...checkJevEdit(id as JevPromptId, body, active));
  } else if (id in CLAUDE_PROMPTS) {
    const same = sameTemplateOf(id as ClaudePromptId);
    if (same) return [{ where: "prompt", message: `this prompt runs the text of ${same}; edit that one` }];
    out.push(...claudeProblems(id as ClaudePromptId, body, active));
  } else {
    return [{ where: "prompt", message: `${id} is not an editable prompt` }];
  }
  return [...out, ...noteProblems(note)];
}
