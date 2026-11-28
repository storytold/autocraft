// The model-step runner: every model call goes through runModelStep (one step) or runTiered (Jev first, Haiku
// where Jev is unsure or unavailable). A step is declared once (src/agents/steps.ts) with its parser, retries,
// lint and fallbacks; the runner does the calls, retries, lint and fix turn (askClaude), the Jev reply parse, the
// usage rows and the error result.
import { ItemWithdrawnError, NoTakerError, poolRoom, repoBatches } from "./call.ts";
import { jevAvailable } from "./jev.ts";
import { add, askClaude, askJev, pool, promptVersion, saveUsages, type AskOptions, type UsageRow, type LintedReply, type Usage } from "../classify/run.ts";
import { CLAUDE_PROMPTS, JEV_PROMPTS, JEV_USD_PER_INPUT_TOKEN, renderJev, type ClaudePromptId, type JevPromptId } from "../prompts/index.ts";
import type { DupeAsk, DupePair } from "../dupes/pair.ts";
import type { Item } from "../classify/parse.ts";
import type { Lint, LintProblem } from "../replylint.ts";
import type { Db } from "../db/index.ts";
import { loadLiveConfig, loadTrackedRepos } from "../data/control/index.ts";
import { keepEarlierUsage, loadUnsure, pruneUnsure, saveUnsure } from "../data/inference/index.ts";
import { lostCallError } from "../data/jobs/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { ensurePrompts } from "../data/prompts/index.ts";
import { createHash } from "node:crypto";

/** What a parser knows about the reply it reads. */
export type ParseCtx = {
  /** 0-based attempt number and whether this is the last one the step allows. */
  attempt: number;
  last: boolean;
  /** Claude: what the lint still found after the fix turn (absent without lint); true when a fix turn ran. */
  problems?: LintProblem[];
  fixTurn?: boolean;
  /** Jev: the exit code of `jev ask`. */
  code?: number | null;
};

/** `value` is what the reply answered; `rest` is the part of the input without a valid answer, asked again on the next attempt (absent: done). */
export type Parsed<I, V> = { value: V; rest?: I };

type StepBase<I, _V> = {
  /** Items in an input, for the usage row's item count; default: its length for a list, else 1. */
  size?: (input: I) => number;
  /** Attempts per call; default: the prompt's registered `limits.attempts`. */
  attempts?: number;
  /** Wait before each retry, in ms; default 0. */
  backoffMs?: number;
};

export type ClaudeStep<I, V, C = void> = StepBase<I, V> & {
  provider: "claude";
  id: ClaudePromptId;
  /** Default: the prompt's first registered model. */
  model?: string;
  /** The input as `askClaude` takes it (a list of the prompt's inputs); default: the input itself. */
  toPrompt?: (input: I) => unknown[];
  /** Text of the reply; null is a parse error (the call is repeated). */
  parse: (text: string, input: I, ctx: ParseCtx, c: C) => Promise<Parsed<I, V> | null>;
  /** Lint of the parsed reply, with the fields it covers. Problems after the fix turn go to `parse` in `ctx.problems`; `onFail: "retry"` treats them as a parse error instead. The fix turn itself is the prompt's `lint` registration (src/prompts). */
  lint?: { fields: string[]; make: (input: I, c: C) => Lint; onFail?: "accept" | "retry" };
  /** The value to use when every attempt failed to parse and this returns one for the first reply that did not (a lenient reading of the reply). */
  fallback?: (text: string, input: I, ctx: ParseCtx, c: C) => V | null;
};

export type JevStep<I, V, C = void> = StepBase<I, V> & {
  provider: "jev";
  id: JevPromptId;
  /** The item the run records and the request body (default body: the registered request for the item). */
  request: (input: I, ctx: C) => { item: Item | DupePair | DupeAsk | { ref: string }; body?: string };
  /** `answers` of Jev's JSON reply; null is a parse error. Not called when the reply was not JSON. */
  parse: (answers: unknown, input: I, ctx: ParseCtx, c: C) => Parsed<I, V> | null;
};

/** One `token_usage` row for a step call, saved after the last attempt. */
export type UsageSave = {
  run: string;
  agent: string;
  stage: string;
  /** Default: the prompt's first registered model. */
  model?: string;
  /** Items answered; default: the input size minus `rest` (1 for a single input). */
  items?: (answered: boolean, inputSize: number, restSize: number) => number;
  /** Rows of an earlier pass under the same agent name are renamed first, so the replace does not overwrite their cost. */
  keepEarlier?: boolean;
  /** No row when the step got no usage at all (Jev: no reply with a usage field). */
  skipWhen?: (r: { ok: boolean }) => Promise<boolean>;
  /** Jev: also save the row (with zero tokens) when no reply carried a usage field. */
  withoutUsage?: boolean;
  /** Collect the row here instead of saving it, for the caller to save a chunk of rows in one write (saveUsages). */
  sink?: UsageRow[];
};

export type StepOpts<I, C = void> = Omit<AskOptions, "lint"> & {
  /** Claude: a model other than the prompt's first registered one. */
  model?: string;
  /** Jev: what `request` needs besides the input. */
  ctx?: C;
  usage?: UsageSave;
  cancelled?: () => Promise<boolean>;
  /** Jev: whether Jev may be called, in place of reading the stored state before every attempt. */
  available?: () => Promise<boolean>;
  /** The call itself, in place of the real model call (tests, injected dependencies). Gets the lint the step declares. */
  ask?: (input: I, lint: Lint | undefined) => Promise<LintedReply | null>;
  /** Called before each call with the input still to answer (the first call included). */
  onAttempt?: (input: I, attempt: number) => void;
  /** Called with each Claude reply before it is parsed (log the lint outcome, read `turns`). */
  onReply?: (reply: LintedReply) => void;
  /** Jev: called with each finished `jev ask` (its exit code and stderr), before it is parsed. */
  onJevProc?: (p: { code: number | null; stderr: string }) => void;
};

export type StepResult<I, V> =
  | { ok: true; value: V; values: V[]; rest?: I; usage: Usage; runId: string | undefined; /** The model id that gave the last answer, when the harness reported one (user-local calls); otherwise absent. */ model?: string }
  | { ok: false; error: string; usage: Usage; runId: string | undefined; /** The last attempt's call ended without a reply because it was lost (lostCallError), not for the model's work. */ lost?: true };

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sizeOf = <I,>(step: { size?: (i: I) => number }, x: I) => step.size ? step.size(x) : Array.isArray(x) ? x.length : 1;

type Reply = { text: string; usage: Usage; problems?: LintProblem[]; fixTurn?: boolean; model?: string } | { answers: unknown; usage: Usage; code: number | null; json: boolean };

/**
 * Runs one declared step on `input`: the call, the parse, up to `attempts` calls (a parse error or a failed call repeats
 * the call; a parser that returns `rest` repeats it for the rest only), the usage row, and the error result. A call the
 * model's safety filter declined, which the queue already ran once more elsewhere, ends the attempts with its error.
 * Values of every answered attempt are in `values`, in order; `rest` is what no attempt answered. A call withdrawn for lack of
 * a taker (NoTakerError) ends the attempts: with earlier answers they are returned with the rest unanswered, as when the
 * attempts run out; without, the usage of what ran is saved and the error is thrown. A call withdrawn for its item
 * (ItemWithdrawnError) is thrown the same way, earlier answers or not.
 */
export async function runModelStep<I, V, C = void>(db: Db, step: ClaudeStep<I, V, C> | JevStep<I, V, C>, input: I, opts: StepOpts<I, C> = {}): Promise<StepResult<I, V>> {
  const reg = step.provider === "jev" ? JEV_PROMPTS[step.id] : CLAUDE_PROMPTS[step.id];
  const attempts = step.attempts ?? reg.limits.attempts;
  const start = new Date().toISOString();
  const values: V[] = [];
  let usage = zero();
  let todo: I | undefined = input, rest: I | undefined = input;
  let fallback: V | null = null, error = "no answer", sawUsage = false;
  let ran: string | undefined, untaken: NoTakerError | undefined, lost = false;
  for (let attempt = 0; attempt < attempts && todo !== undefined; attempt++) {
    if (await opts.cancelled?.()) break;
    if (step.provider === "jev" && !await (opts.available ?? (() => jevAvailable(db)))()) { error = "jev unavailable"; break; }
    if (attempt > 0 && step.backoffMs) await sleep(step.backoffMs);
    opts.onAttempt?.(todo, attempt);
    let r: Reply | null;
    let refusal: string | null = null, failed: string | null = null;
    try { r = await call(db, step, todo, { ...opts, onRefused: (e) => { refusal = e; opts.onRefused?.(e); }, onFailed: (e) => { failed = e; opts.onFailed?.(e); } }); } catch (e) {
      if (!(e instanceof NoTakerError)) throw e;
      // A call withdrawn for its item ends the item's work, earlier answers included.
      if (!values.length || e instanceof ItemWithdrawnError) untaken = e;
      break;
    }
    if (!r && refusal !== null) { error = refusal; break; }
    lost = !r && failed !== null && lostCallError(failed);
    if (!r) { error = "no answer"; continue; }
    usage = add(usage, r.usage);
    if ("text" in r) opts.onReply?.(r as LintedReply);
    if ("answers" in r ? r.json : true) sawUsage = true;
    const ctx: ParseCtx = { attempt, last: attempt === attempts - 1, ...("text" in r ? { problems: r.problems, fixTurn: r.fixTurn } : { code: r.code }) };
    if ("answers" in r && !r.json) { error = "unreadable answer"; continue; }
    const reply = ("text" in r ? r.text : r.answers) as never;
    let parsed = await (step as { parse: (a: never, i: I, c: ParseCtx, x: C) => Parsed<I, V> | null | Promise<Parsed<I, V> | null> }).parse(reply, todo, ctx, opts.ctx as C);
    if (parsed && "text" in r && r.problems?.length && (step as ClaudeStep<I, V>).lint?.onFail === "retry") parsed = null;
    if (!parsed) {
      error = "no valid answer";
      fallback ??= (step as { fallback?: (a: never, i: I, c: ParseCtx, x: C) => V | null }).fallback?.(reply, todo, ctx, opts.ctx as C) ?? null;
      continue;
    }
    values.push(parsed.value);
    if ("text" in r && r.model) ran = r.model;
    todo = rest = parsed.rest;
  }
  if (!untaken && !values.length && fallback !== null) { values.push(fallback); rest = undefined; }
  const ok = values.length > 0;
  if (opts.usage && !(await opts.usage.skipWhen?.({ ok }) ?? false) && (sawUsage || opts.usage.withoutUsage)) {
    const u = opts.usage;
    const total = sizeOf(step, input);
    const items = u.items ? u.items(ok, total, rest === undefined ? 0 : sizeOf(step, rest)) : total - (rest === undefined ? 0 : sizeOf(step, rest));
    const model = u.model ?? reg.models[0]!;
    const saved = step.provider === "jev" ? { ...usage, cost: usage.input * JEV_USD_PER_INPUT_TOKEN } : usage;
    const row = { runId: u.run, agent: u.agent, stage: u.stage, model, items, u: saved, start, end: new Date().toISOString() };
    if (u.sink) {
      if (u.keepEarlier) await keepEarlierUsage(db, u.run, [u.agent]);
      u.sink.push(row);
    } else if (u.keepEarlier) {
      // The rename and the new row commit together: a crash between them would leave the old row renamed and no new one.
      await db.write(async () => { await keepEarlierUsage(db, u.run, [u.agent]); await saveUsages(db, [row]); });
    } else await saveUsages(db, [row]);
  }
  if (untaken) throw untaken;
  const runId = opts.usage?.run;
  if (!ok) return { ok: false, error, usage, runId, ...(lost && error === "no answer" ? { lost: true as const } : {}) };
  return { ok: true, value: values[values.length - 1]!, values, ...(rest !== undefined && { rest }), usage, runId, ...(ran && { model: ran }) };
}

async function call<I, V, C>(db: Db, step: ClaudeStep<I, V, C> | JevStep<I, V, C>, input: I, opts: StepOpts<I, C>): Promise<Reply | null> {
  if (step.provider === "claude") {
    const lint = step.lint?.make(input, opts.ctx as C);
    const { ctx: _c, usage: _u, cancelled: _x, ask, model: m, onAttempt: _a, onReply: _r, onJevProc: _p, ...ask_ } = opts;
    const model = m ?? step.model ?? CLAUDE_PROMPTS[step.id].models[0]!;
    return ask ? ask(input, lint) : askClaude(step.id, model, (step.toPrompt ? step.toPrompt(input) : input) as never, db, { ...ask_, ...(lint && { lint }) });
  }
  // The request is rendered after the prompt cache is up to date, so its text and recorded version are the same revision.
  await ensurePrompts(db);
  const { item, body } = step.request(input, opts.ctx as C);
  const p = await askJev(step.id, item as never, db, { body: body ?? renderJev(step.id, item as Item | DupeAsk), version: promptVersion(step.id) }, opts.usage === undefined);
  opts.onJevProc?.(p);
  type Json = { answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
  let parsed: unknown = null;
  try { parsed = JSON.parse(p.stdout); } catch { /* the step reports an unreadable answer */ }
  const j = parsed !== null && typeof parsed === "object" ? parsed as Json : null;
  const usage: Usage = { input: j?.usage?.input_tokens ?? 0, output: j?.usage?.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0, cost: null };
  return { answers: j?.answers, usage, code: p.code, json: j !== null };
}

/**
 * A Jev step with its Haiku fallback. Jev answers each item; Haiku answers (in batches) the items Jev is not sure about. An unsure
 * answer whose Haiku batch no Task Runner could take is kept (jev_unsure) and stands in for Jev's answer while the item's Jev
 * request is unchanged, so later passes ask only Haiku.
 */
export type TieredStep<It, JV, HV, C = void, B = It[]> = {
  jev: JevStep<It, JV, C>;
  /** Haiku answers a batch; its value is `[ref, answer]` pairs, and `rest` the batch items without one. */
  haiku: ClaudeStep<B, [string, HV][], C>;
  /** The Haiku input for a batch of items (default: the list). */
  batch?: (items: It[], ctx: C) => B;
  ref: (item: It) => string;
  /** The item's repo: the model queue's room is asked for the repos of the next batch. */
  repo: (item: It) => string;
  /** The item itself, for the runners that take only some items (src/remote/task-items.ts). */
  item: (item: It) => { repo: string; number: number };
  /** Jev's answer settles the item: it is not sent to Haiku. */
  sure: (jev: JV) => boolean;
  /** An item Jev gave no valid answer for goes to Haiku: always, or only when Jev is unavailable (a failure with Jev up leaves the item for the next pass). */
  onJevFailure: "haiku" | "haiku-when-unavailable";
};

export type TieredOpts<It, C, JV = unknown> = {
  ctx?: C;
  /** Jev call width (default: the Jev parallelism setting). */
  jevWidth?: number | (() => Promise<number>);
  jevUsage?: (item: It) => UsageSave;
  /** Haiku batch size; default: the prompt's `perCall`. */
  perCall?: number;
  haikuUsage?: (batch: It[], n: number) => UsageSave;
  /** Start the first Haiku batch alone (a failure that stops all calls then shows early). */
  first?: boolean;
  cancelled?: () => Promise<boolean>;
  /** Jev answers already given by ref (asked in another request: src/classify/run.ts runJev); these items are not sent to Jev. */
  given?: ReadonlyMap<string, JV>;
};

export type TieredResult<JV, HV> = {
  /** Jev's answer per ref, asked, given or kept from an earlier pass (null: none, or Jev was not asked). */
  jev: Map<string, JV | null>;
  haiku: Map<string, HV>;
  /** Items Jev could not be asked or answer because it is unavailable, so Haiku decided alone. */
  alone: Set<string>;
  /** Items sent to Haiku. */
  asked: Set<string>;
  /** Items Haiku was to answer whose batch did not run: no Task Runner may take its repo. */
  skipped: Set<string>;
  /** Items whose Jev answer was kept from an earlier pass (jev_unsure), not asked now. */
  kept: Set<string>;
};

export async function runTiered<It, JV, HV, C = void, B = It[]>(db: Db, tier: TieredStep<It, JV, HV, C, B>, items: It[], opts: TieredOpts<It, C, JV> = {}): Promise<TieredResult<JV, HV>> {
  const out: TieredResult<JV, HV> = { jev: new Map(), haiku: new Map(), alone: new Set(), asked: new Set(), skipped: new Set(), kept: new Set() };
  for (const x of items) if (opts.given?.has(tier.ref(x))) out.jev.set(tier.ref(x), opts.given.get(tier.ref(x))!);
  const kept = await keptUnsure(db, tier, items, opts.ctx as C);
  for (const x of items) { const k = kept.rows.get(tier.ref(x)); if (k !== undefined && !out.jev.has(tier.ref(x)) && k.hash === kept.hashOf(x)) { out.jev.set(tier.ref(x), k.answer); out.kept.add(tier.ref(x)); } }
  const toJev = items.filter((x) => !out.jev.has(tier.ref(x)));
  if (toJev.length && await jevAvailable(db)) {
    await pool(toJev.map((x) => async () => {
      if (!await jevAvailable(db)) return;
      const r = await runModelStep(db, tier.jev, x, { ctx: opts.ctx, usage: opts.jevUsage?.(x), cancelled: opts.cancelled });
      out.jev.set(tier.ref(x), r.ok ? r.value : null);
    }), opts.jevWidth ?? (async () => (await loadLiveConfig(db)).jevParallel));
  }
  const down = !await jevAvailable(db);
  const ask: It[] = [];
  for (const x of items) {
    const jv = out.jev.get(tier.ref(x)) ?? null;
    if (jv !== null && tier.sure(jv)) continue;
    if (jv === null && !down && tier.onJevFailure === "haiku-when-unavailable") continue;
    if (jv === null && down) out.alone.add(tier.ref(x));
    ask.push(x);
  }
  if (!ask.length) { await keepUnsure(db, tier, items, out, kept, down); return out; }
  if (await opts.cancelled?.()) return out;
  const per = opts.perCall ?? CLAUDE_PROMPTS[tier.haiku.id].limits.perCall;
  const batches = await repoBatches(db, ask, per, tier.repo, (x) => [tier.item(x)]);
  await pool(batches.map((batch, n) => async () => {
    for (const x of batch) out.asked.add(tier.ref(x));
    const r = await runModelStep(db, tier.haiku, tier.batch ? tier.batch(batch, opts.ctx as C) : (batch as unknown as B), {
      ctx: opts.ctx, usage: opts.haikuUsage?.(batch, n), cancelled: opts.cancelled });
    if (r.ok) for (const v of r.values) for (const [ref, a] of v) out.haiku.set(ref, a);
  }), poolRoom(db, (i) => [...new Set(batches[i]!.map(tier.repo))], (i) => batches[i]!.map(tier.item), { promptId: tier.haiku.id }), { first: opts.first, skipped: (i) => {
    for (const x of batches[i]!) { out.skipped.add(tier.ref(x)); out.alone.delete(tier.ref(x)); }
  } });
  await keepUnsure(db, tier, items, out, kept, down);
  return out;
}

/** The hash a kept Jev answer (jev_unsure) is valid for: the request's body, with the prompt's version and the parser that made the value. */
export function jevRequestHash<I, V, C>(step: JevStep<I, V, C>, input: I, ctx: C): string {
  const { item, body } = step.request(input, ctx);
  return createHash("sha256").update(`${promptVersion(step.id)}\n${String(step.parse)}\n${body ?? renderJev(step.id, item as Item | DupeAsk)}`).digest("hex");
}

type Kept<It, JV> = { rows: Map<string, { hash: string; answer: JV | null }>; hashOf: (x: It) => string };

/** The unsure Jev answers kept for `items` (jev_unsure), and the hash of each item's Jev request they are valid for. */
async function keptUnsure<It, JV, HV, C, B>(db: Db, tier: TieredStep<It, JV, HV, C, B>, items: It[], ctx: C): Promise<Kept<It, JV>> {
  await ensurePrompts(db);
  const hashes = new Map<It, string>();
  const hashOf = (x: It): string => {
    let h = hashes.get(x);
    if (h === undefined) hashes.set(x, h = jevRequestHash(tier.jev, x, ctx));
    return h;
  };
  const rows = new Map<string, { hash: string; answer: JV | null }>();
  if (!items.length) return { rows, hashOf };
  for (const [ref, r] of await loadUnsure(db, tier.jev.id, items.map(tier.ref))) {
    try { rows.set(ref, { hash: r.hash, answer: JSON.parse(r.answer) as JV }); } catch { /* asked again */ }
  }
  return { rows, hashOf };
}

/** Whether a kept Jev answer with `hash` is for the item's current request: its next call is then Haiku's, not Jev's. */
export async function keptIsCurrent<It, JV, HV, C, B>(db: Db, tier: TieredStep<It, JV, HV, C, B>, item: It, hash: string, ctx: C): Promise<boolean> {
  return (await keptUnsure(db, tier, [], ctx)).hashOf(item) === hash;
}

/**
 * Keeps the unsure Jev answer (or that Jev, while up, gave none) of each item whose Haiku batch no Task Runner could take, so the next pass
 * asks only Haiku while the Jev request is unchanged; drops the kept answers of the other items (settled, or sent to Haiku).
 */
async function keepUnsure<It, JV, HV, C, B>(db: Db, tier: TieredStep<It, JV, HV, C, B>, items: It[], out: TieredResult<JV, HV>, kept: Kept<It, JV>, down: boolean): Promise<void> {
  const at = new Date().toISOString();
  const keep = items.flatMap((x) => {
    const ref = tier.ref(x), jv = out.jev.get(ref) ?? null;
    if (!out.skipped.has(ref) || (jv === null && (down || !out.jev.has(ref)))) return [];
    const hash = kept.hashOf(x);
    return kept.rows.get(ref)?.hash === hash ? [] : [{ ref, hash, answer: JSON.stringify(jv), at }];
  });
  const drop = [...kept.rows.keys()].filter((ref) => !out.skipped.has(ref));
  await saveUnsure(db, { promptId: tier.jev.id, keep, drop });
}

/** The items a kept answer's ref names: `repo#n`, or both items of a pair `repo#a~b` (src/dupes/pair.ts). */
const refItems = (ref: string): { repo: string; number: number }[] => {
  const i = ref.lastIndexOf("#");
  return ref.slice(i + 1).split("~").map((n) => ({ repo: ref.slice(0, i), number: Number(n) }));
};

/** Drops kept unsure Jev answers older than the keep time and those with no item that is open in a tracked repo. */
export async function pruneJevUnsure(db: Db, nowMs: number = Date.now()): Promise<number> {
  return await pruneUnsure(db, nowMs, async (refs) => {
    const keys = refs.flatMap(refItems);
    const [items, tracked] = await db.together(() => Promise.all([loadItems(db, keys, "card"), loadTrackedRepos(db, [...new Set(keys.map((k) => k.repo))])]));
    const open = new Set([...items].filter(([, i]) => i.state === "OPEN" && tracked.has(i.repo)).map(([k]) => k));
    return new Set(refs.filter((ref) => refItems(ref).some((k) => open.has(`${k.repo}#${k.number}`))));
  });
}
