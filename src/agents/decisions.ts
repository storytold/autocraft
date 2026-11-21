// Jev's typed decisions, answered by a Decisions API endpoint: one request carries the text and every question, and the
// answer holds one typed result per question (a predicate's probability, a choice's label with its distribution, a
// score's level). The request and answer are mapped to Jev's own shapes here, so every parser, threshold and stored row
// above this file is unchanged.
//
//   POST ${AUTOCRAFT_DECISIONS_BASE_URL}/decisions
//   {"model": "...", "input": "<the item>", "questions": [{"type": "predicate" | "choice", "name", "instructions", ...}]}
//   {"answers": [{"type", "name", "probability"} | {"type", "name", "choice", "confidence", "probabilities"}]}
//
// Configuration, like the compatible provider (src/agents/compatible.ts), is by environment variables that name a file:
//
//   AUTOCRAFT_CLASSIFIER_PROVIDER=decisions     the typed decisions go to this endpoint
//   AUTOCRAFT_DECISIONS_BASE_URL                the API root (default https://api.openai.com/v1; https, http on loopback)
//   AUTOCRAFT_DECISIONS_KEY_FILE                the key (default: AUTOCRAFT_COMPATIBLE_KEY_FILE)
//   AUTOCRAFT_DECISIONS_MODEL                   the model (default: the one the Decisions API serves today)
import { envVar } from "../env.ts";
import { checkBaseUrl, CompatibleError, readKey } from "./compatible.ts";
import type { JevProc } from "./jev-cloudflare.ts";

/** The model the Decisions API serves today; an operator may name another. */
export const DEFAULT_DECISIONS_MODEL = "gpt-6-luna";
/** The endpoint's default root: the Decisions API's home. Another root that speaks the same shape works. */
export const DEFAULT_DECISIONS_BASE_URL = "https://api.openai.com/v1";

export type DecisionsConfig = { baseUrl: string; keyFile: string; model: string };

/** What the environment says, or the reason it cannot be used. Never the key or a default that hides a mistake. */
export function decisionsConfig(env: NodeJS.ProcessEnv = process.env): { config: DecisionsConfig } | { problem: string } {
  const raw = (envVar("DECISIONS_BASE_URL", env) ?? "").trim() || (envVar("COMPATIBLE_BASE_URL", env) ?? "").trim() || DEFAULT_DECISIONS_BASE_URL;
  const base = checkBaseUrl(raw);
  if ("problem" in base) return { problem: base.problem };
  const keyFile = (envVar("DECISIONS_KEY_FILE", env) ?? "").trim() || (envVar("COMPATIBLE_KEY_FILE", env) ?? "").trim();
  if (!keyFile) return { problem: "no key file: set AUTOCRAFT_DECISIONS_KEY_FILE" };
  const model = (envVar("DECISIONS_MODEL", env) ?? "").trim() || DEFAULT_DECISIONS_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model)) return { problem: "AUTOCRAFT_DECISIONS_MODEL is not a model id" };
  return { config: { baseUrl: base.url, keyFile, model } };
}

/** One question of a Jev request: `choice` with its criteria, or `noul` (a probability that the answer is yes). */
type JevQuestion = { type?: string; instructions?: string; criteria?: Record<string, string> };
export type DecisionsWireQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] };

/** Jev's questions object as the endpoint's list, in the same order. */
export function wireQuestions(questions: Record<string, JevQuestion>): DecisionsWireQuestion[] {
  return Object.entries(questions).map(([name, q]) => {
    const instructions = typeof q.instructions === "string" ? q.instructions : "";
    if (q.type === "choice") {
      return { type: "choice" as const, name, instructions, choices: Object.entries(q.criteria ?? {}).map(([value, description]) => ({ value, description })) };
    }
    return { type: "predicate" as const, name, instructions };
  });
}

type WireAnswer = {
  type?: unknown; name?: unknown;
  probability?: unknown; choice?: unknown; confidence?: unknown;
  probabilities?: { value?: unknown; label?: unknown; probability?: unknown }[];
};

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1 ? x : null);

/** One choice's distribution as Jev's `{label: probability}` object. */
function distribution(a: WireAnswer): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of Array.isArray(a.probabilities) ? a.probabilities : []) {
    const key = typeof p.value === "string" ? p.value : typeof p.label === "string" ? p.label : null;
    const v = num(p.probability);
    if (key !== null && v !== null) out[key] = v;
  }
  return out;
}

/**
 * The endpoint's answers as Jev's answers object: a choice is `{choice, confidence, probabilities}`, a predicate is
 * `{noul: probability}`. A refusal, a missing answer or a choice outside the asked values is left out, so the existing
 * parser sees no valid answer for that question and the step treats it as it treats Jev being unsure.
 */
export function jevAnswers(questions: DecisionsWireQuestion[], answers: WireAnswer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Named answers are matched by name and only by name: falling back to the answer at the same position would hand one
  // question's probability to another when the endpoint leaves one out. Positional matching is only for an endpoint that
  // names none of them.
  const named = new Map<string, WireAnswer>();
  for (const a of answers) if (typeof a?.name === "string") named.set(a.name, a);
  const anyNamed = named.size > 0;
  questions.forEach((q, i) => {
    const a = anyNamed ? named.get(q.name) : answers[i];
    if (!a || a.type === "refusal") return;
    if (q.type === "predicate") {
      const p = num(a.probability);
      if (p !== null) out[q.name] = { noul: p };
      return;
    }
    const choice = typeof a.choice === "string" && q.choices.some((c) => c.value === a.choice) ? a.choice : null;
    if (choice === null) return;
    out[q.name] = { choice, ...(num(a.confidence) !== null && { confidence: num(a.confidence)! }), probabilities: distribution(a) };
  });
  return out;
}

/** The request body of one decisions call: the item as input, and every question of the Jev request. */
export function decisionsBody(cfg: DecisionsConfig, body: string): { model: string; input: string; questions: DecisionsWireQuestion[] } {
  let parsed: { state?: unknown; questions?: Record<string, JevQuestion> } | null = null;
  try { parsed = JSON.parse(body) as { state?: unknown; questions?: Record<string, JevQuestion> }; } catch { parsed = null; }
  if (!parsed || !parsed.questions) throw new CompatibleError("call", "the classifier request is not JSON");
  const state = typeof parsed.state === "string" ? parsed.state : JSON.stringify(parsed.state ?? "");
  return { model: cfg.model, input: state, questions: wireQuestions(parsed.questions) };
}

const fail = (status: number | null, message: string): JevProc => ({ code: 1, stdout: "", stderr: `classifier: ${status === null ? "" : `API error status=${status}: `}${message}\n` });

/**
 * One typed-decision request to the endpoint, in the shape `jev ask` prints (`{"answers": ...}`) and with a stderr line
 * `jevFailure` reads. The Decisions API does not report tokens, so no usage is claimed.
 */
export async function askDecisionsClassifier(cfg: DecisionsConfig, body: string, timeoutMs: number, base = cfg.baseUrl): Promise<JevProc> {
  let request: { model: string; input: string; questions: DecisionsWireQuestion[] };
  let key: string;
  try { request = decisionsBody(cfg, body); } catch (e) { return fail(null, (e as Error).message); }
  try { key = readKey(cfg.keyFile); } catch (e) { return fail(null, (e as Error).message); }
  let res: Response, text: string;
  try {
    res = await fetch(`${base}/decisions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    const name = (e as Error).name;
    return fail(null, name === "TimeoutError" || name === "AbortError" ? `the request timed out after ${Math.round(timeoutMs / 1000)} s` : `the request failed: ${name || "network error"}`);
  }
  if (!res.ok) {
    let detail = "";
    try { const j = JSON.parse(text) as { error?: { message?: unknown } }; detail = typeof j.error?.message === "string" ? j.error.message : ""; } catch { /* not JSON */ }
    return fail(res.status, (detail || text.trim() || res.statusText).slice(0, 200));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { code: 1, stdout: text, stderr: "classifier: unreadable answer: the reply is not JSON\n" }; }
  const answers = (parsed && typeof parsed === "object" ? (parsed as { answers?: unknown }).answers : null);
  // A refusal of the whole request (a policy object rather than an answers list) is an unreadable answer too: code 0
  // here means "answered", so this cannot be reported as one.
  if (!Array.isArray(answers)) return { code: 1, stdout: text, stderr: "classifier: unreadable answer: the reply has no answers list\n" };
  return { code: 0, stdout: JSON.stringify({ answers: jevAnswers(request.questions, answers as WireAnswer[]) }), stderr: "" };
}
