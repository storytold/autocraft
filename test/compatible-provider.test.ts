// The compatible provider (src/agents/compatible.ts, src/agents/model-call.ts, src/agents/filetools.ts): a chat API in
// place of the claude CLI and of Jev. The stub server below answers in the API's shape, so these tests check our side of
// the wire: the request we send, the turns we take, the tools' confinement, and what a refusal or a bad configuration
// records.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { askClaude, askJev } from "../src/classify/run.ts";
import { runModelStep } from "../src/agents/step.ts";
import { REFERENCE_HAIKU, textStep } from "../src/agents/steps.ts";
import { askCompatibleClassifier, checkBaseUrl, modelProvider, readKey } from "../src/agents/compatible.ts";
import { classifierProvider } from "../src/agents/classifier.ts";
import { askDecisionsClassifier, decisionsConfig, jevAnswers, wireQuestions } from "../src/agents/decisions.ts";
import { getJev, getProviders } from "../src/dash/api/agents.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { globFiles, globMatches, grepFiles, readText } from "../src/agents/filetools.ts";
import { jevAvailable, jevFailure } from "../src/agents/jev.ts";
import { connect } from "../src/db.ts";
import { SAMPLE_ITEMS, SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { SAMPLE_SCREENSHOT_COMPARE } from "../src/verify/types.ts";
import { SCRATCH } from "./scratch.ts";

type Wire = { model: string; messages: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[]; tools?: { function: { name: string } }[]; max_tokens?: number };

/** A stub API: each request takes the next reply, or repeats the last one. */
async function stubApi(replies: ((body: Wire) => { status?: number; json?: unknown })[]) {
  const seen: Wire[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b) as Wire;
      seen.push(body);
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)]!(body);
      res.statusCode = reply.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => server.close() };
}

/** One assistant answer with no tool calls. */
const answer = (content: string, usage = { prompt_tokens: 30, completion_tokens: 5 }) => ({ json: { model: "test-small", choices: [{ message: { role: "assistant", content } }], usage } });

/** Every AUTOCRAFT_* variable's value, and the way to put them all back. */
function saveEnv(): () => void {
  const saved = new Map(Object.entries(process.env));
  return () => {
    for (const k of Object.keys(process.env)) if (!saved.has(k)) delete process.env[k];
    for (const [k, v] of saved) process.env[k] = v!;
  };
}

/** The environment of a compatible model provider pointing at `url`, with a 0600 key file. */
function providerEnv(dir: string, url: string, extra: Record<string, string> = {}): () => void {
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, "sk-test-secret\n");
  if (process.platform !== "win32") chmodSync(keyFile, 0o600);
  const env: Record<string, string> = {
    AUTOCRAFT_MODEL_PROVIDER: "compatible",
    AUTOCRAFT_COMPATIBLE_BASE_URL: url,
    AUTOCRAFT_COMPATIBLE_KEY_FILE: keyFile,
    AUTOCRAFT_COMPATIBLE_MODELS: JSON.stringify({ top: "test-top", mid: "test-mid", small: "test-small" }),
    ...extra,
  };
  const restore = saveEnv();
  Object.assign(process.env, env);
  return restore;
}

test("a plain prompt: one request, the prompt's fixed text as the system message, and the run records the model that answered", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-"));
  const api = await stubApi([() => answer("a summary")]);
  const restore = providerEnv(dir, api.url);
  const db = connect(join(dir, "t.db"));
  try {
    const r = await askClaude("classify.haiku", "haiku", SAMPLE_ITEMS, db);
    assert.equal(r?.text, "a summary");
    const run = db.prepare("SELECT provider, model, account_id, state FROM agent_runs ORDER BY id DESC LIMIT 1").get() as { provider: string; model: string; account_id: string | null; state: string };
    assert.deepEqual({ ...run }, { provider: "compatible", model: "test-small", account_id: null, state: "done" });
    // The small tier's model, no tools on a call without a checkout, and the prompt's own system text.
    assert.equal(api.seen[0]!.model, "test-small");
    assert.equal(api.seen[0]!.tools, undefined);
    assert.equal(api.seen[0]!.messages.length, 2);
    assert.equal(api.seen[0]!.messages[0]!.role, "system");
    assert.match(api.seen[0]!.messages[1]!.content ?? "", /<items>/);
  } finally { restore(); api.close(); db.close(); }
});

test("a sandboxed prompt reads its checkout with the file tools and cannot read past it", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-tools-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const answer = 42;\n");
  if (process.platform !== "win32") symlinkSync("/etc/hostname", join(repo, "leak"));
  const api = await stubApi([
    () => ({ json: { model: "test-top", choices: [{ message: { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "Glob", arguments: JSON.stringify({ pattern: "**/*.ts" }) } },
      { id: "c2", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "/repo/leak" }) } },
      { id: "c3", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "/repo/../etc/hostname" }) } },
      { id: "c4", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "/repo/src/a.ts" }) } },
    ] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } } }),
    () => answer("reviewed", { prompt_tokens: 200, completion_tokens: 30 }),
  ]);
  const restore = providerEnv(dir, api.url);
  const db = connect(join(dir, "t.db"));
  try {
    const r = await askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, { checkout: repo });
    assert.equal(r?.text, "reviewed");
    assert.equal(r?.turns, 2);
    // The tool results the model read on its second turn: the file it asked for, and a refusal for each way out.
    const tools = api.seen[1]!.messages.filter((m) => m.role === "tool");
    assert.equal(tools.length, 4);
    // Glob listed the one file; the two ways out of the checkout came back as errors; the one inside it was read.
    assert.match(tools[0]!.content ?? "", /^1 file\(s\) matching .*\/repo\/src\/a\.ts/s);
    assert.match(tools[1]!.content ?? "", /^Error: .*outside \/repo/);
    assert.match(tools[2]!.content ?? "", /^Error: .*\. or \.\. segment/);
    assert.match(tools[3]!.content ?? "", /1→export const answer = 42;/);
    assert.equal(api.seen[0]!.tools?.length, 4);
    const run = db.prepare("SELECT provider, model, input_tokens, output_tokens, cost_usd, state FROM agent_runs ORDER BY id DESC LIMIT 1").get() as { provider: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number | null; state: string };
    assert.deepEqual({ ...run }, { provider: "compatible", model: "test-top", input_tokens: 300, output_tokens: 50, cost_usd: null, state: "done" });
  } finally { restore(); api.close(); db.close(); }
});

test("Grep's glob matches a file name at any depth, as Glob does", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-grep-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.rs"), "fn main() {}\n");
  writeFileSync(join(dir, "notes.txt"), "fn main is documented here\n");
  const out = await grepFiles([{ path: "/repo", dir }], { pattern: "fn main", glob: "*.rs" });
  assert.match(out, /\/repo\/src\/a\.rs:1:fn main/);
  assert.doesNotMatch(out, /notes\.txt/);
});

test("a prompt that reads images is refused instead of answered blind", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-images-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const api = await stubApi([() => answer("would have been a guess")]);
  const restore = providerEnv(dir, api.url);
  const db = connect(join(dir, "t.db"));
  try {
    const r = await askClaude("verify.compare", "opus", SAMPLE_SCREENSHOT_COMPARE, db, { checkout: repo });
    assert.equal(r, null);
    assert.equal(api.seen.length, 0, "no request is made for a prompt the provider cannot serve");
    const run = db.prepare("SELECT state, error FROM agent_runs ORDER BY id DESC LIMIT 1").get() as { state: string; error: string };
    assert.equal(run.state, "failed");
    assert.match(run.error, /images/);
  } finally { restore(); api.close(); db.close(); }
});

test("a configuration the provider cannot honour is refused, not silently replaced by another provider", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-bad-"));
  const restore = saveEnv();
  try {
    Object.assign(process.env, { AUTOCRAFT_MODEL_PROVIDER: "compatible", AUTOCRAFT_COMPATIBLE_BASE_URL: "http://models.example.com/v1", AUTOCRAFT_COMPATIBLE_KEY_FILE: join(dir, "key"), AUTOCRAFT_COMPATIBLE_MODELS: JSON.stringify({ top: "t", mid: "m", small: "s" }) });
    const p = modelProvider();
    assert.equal(p.provider, "invalid");
    assert.match((p as { reason: string }).reason, /https/);
    const db = connect(join(dir, "t.db"));
    await assert.rejects(askClaude("classify.haiku", "haiku", SAMPLE_ITEMS, db), /model provider is not configured/);
    db.close();
  } finally { restore(); }
});

test("a key file others may read is refused, and the probe rules are the ones the provider documents", () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(SCRATCH, "compat-key-"));
  const key = join(dir, "key");
  writeFileSync(key, "secret");
  chmodSync(key, 0o600);
  assert.equal(readKey(key), "secret");
  chmodSync(key, 0o644);
  assert.throws(() => readKey(key), /chmod 600/);
  assert.match((checkBaseUrl("https://host/v1/") as { url: string }).url, /^https:\/\/host\/v1$/);
  assert.ok("problem" in checkBaseUrl("https://user:pass@host/v1"));
});

test("the classifier's answers come from the API when it is the configured classifier, and a refused key is an account outage", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-clf-"));
  const api = await stubApi([
    () => ({ json: { model: "test-small", choices: [{ message: { role: "assistant", content: JSON.stringify({ answers: { type: { choice: "bugfix", confidence: 0.8, probabilities: { bugfix: 0.8, "missing feature": 0.2 } } } }) } }], usage: { prompt_tokens: 80, completion_tokens: 20 } } }),
    () => ({ status: 401, json: { error: { message: "invalid key" } } }),
    () => ({ status: 503, json: { error: { message: "overloaded" } } }),
  ]);
  const restore = providerEnv(dir, api.url, { AUTOCRAFT_CLASSIFIER_PROVIDER: "compatible" });
  const db = connect(join(dir, "t.db"));
  try {
    const c = classifierProvider();
    assert.equal(c.provider, "compatible");
    assert.equal(c.provider === "compatible" && c.model, "test-small");
    assert.equal(jevAvailable(db), true);
    const r = await askJev("classify.jev", SAMPLE_ITEMS[0]!, db);
    assert.equal(r.code, 0);
    assert.equal((JSON.parse(r.stdout) as { answers: { type: { choice: string } } }).answers.type.choice, "bugfix");
    // The request carries the typed questions and the state, and asks for JSON.
    assert.match(api.seen[0]!.messages[0]!.content ?? "", /"choice"/);
    const run = db.prepare("SELECT provider, model FROM agent_runs ORDER BY id DESC LIMIT 1").get() as { provider: string; model: string };
    assert.deepEqual({ ...run }, { provider: "compatible", model: "test-small" });
    const bad = await askCompatibleClassifier(c.provider === "compatible" ? c.config : (null as never), "test-small", "{\"state\":{},\"questions\":{}}", 5000, api.url);
    assert.equal(jevFailure(bad)?.kind, "account");
    const busy = await askCompatibleClassifier(c.provider === "compatible" ? c.config : (null as never), "test-small", "{\"state\":{},\"questions\":{}}", 5000, api.url);
    assert.equal(jevFailure(busy), null);
  } finally { restore(); api.close(); db.close(); }
});

test("a classifier environment that cannot run makes the typed decisions visibly unavailable instead of quietly choosing another model", () => {
  const restore = saveEnv();
  const dir = mkdtempSync(join(SCRATCH, "compat-clf-bad-"));
  try {
    Object.assign(process.env, { AUTOCRAFT_CLASSIFIER_PROVIDER: "compatible", AUTOCRAFT_COMPATIBLE_BASE_URL: "", AUTOCRAFT_COMPATIBLE_KEY_FILE: join(dir, "missing"), AUTOCRAFT_COMPATIBLE_CLASSIFIER_MODEL: "small-model" });
    assert.equal(classifierProvider().provider, "invalid");
    const db = connect(join(dir, "t.db"));
    assert.equal(jevAvailable(db), false);
    const outage = db.prepare("SELECT value FROM settings WHERE key = 'jev_unavailable'").get() as { value: string } | undefined;
    assert.match(outage?.value ?? "", /base URL/);
    db.close();
  } finally { restore(); }
});

test("the decisions endpoint answers Jev's questions in one request, without a token count", async () => {
  const dir = mkdtempSync(join(SCRATCH, "decisions-"));
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, "sk-test-secret\n");
  if (process.platform !== "win32") chmodSync(keyFile, 0o600);
  const seen: { url?: string; auth?: string; body: { model?: string; input?: unknown; questions?: { type?: string; name?: string; choices?: { value?: string }[] }[] } }[] = [];
  let status = 200;
  let raw: string | null = null;
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      res.statusCode = status;
      if (raw !== null) { res.end(raw); return; }
      res.end(JSON.stringify(status === 200
        ? { answers: [
          { type: "choice", name: "type", choice: "bugfix", confidence: 0.8, probabilities: [{ value: "bugfix", probability: 0.8 }, { value: "missing feature", probability: 0.2 }] },
          { type: "predicate", name: "security", probability: 0.7 },
          { type: "predicate", name: "needs_decision", probability: 0.1 },
        ] }
        : { error: { message: "invalid key" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const restore = saveEnv();
  Object.assign(process.env, { AUTOCRAFT_CLASSIFIER_PROVIDER: "decisions", AUTOCRAFT_DECISIONS_BASE_URL: base, AUTOCRAFT_DECISIONS_KEY_FILE: keyFile, AUTOCRAFT_DECISIONS_MODEL: "test-decisions" });
  const db = connect(join(dir, "t.db"));
  try {
    const r = await askJev("classify.jev", SAMPLE_ITEMS[0]!, db);
    assert.equal(r.code, 0);
    const answers = (JSON.parse(r.stdout) as { answers: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }> }).answers;
    assert.deepEqual(answers.type, { choice: "bugfix", confidence: 0.8, probabilities: { bugfix: 0.8, "missing feature": 0.2 } });
    assert.equal(answers.security?.noul, 0.7);
    // One request: the item as the input, the choice's criteria as its options, and a predicate for the yes-probability.
    assert.equal(seen[0]!.url, "/decisions");
    assert.equal(seen[0]!.auth, "Bearer sk-test-secret");
    assert.equal(seen[0]!.body.model, "test-decisions");
    const questions = seen[0]!.body.questions!;
    assert.deepEqual(questions.map((q) => q.name), ["type", "security", "needs_decision"]);
    assert.equal(questions[0]!.type, "choice");
    assert.ok(questions[0]!.choices!.some((c) => c.value === "bugfix"));
    assert.equal(questions[1]!.type, "predicate");
    const run = db.prepare("SELECT provider, model, state, input_tokens FROM agent_runs ORDER BY id DESC LIMIT 1").get() as { provider: string; model: string; state: string; input_tokens: number | null };
    assert.deepEqual({ ...run }, { provider: "decisions", model: "test-decisions", state: "done", input_tokens: null });
    // The API reports no tokens, so no usage row is invented for it.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM token_usage").get() as { n: number }).n, 0);

    status = 401;
    const bad = await askDecisionsClassifier({ baseUrl: base, keyFile, model: "test-decisions" }, "{\"state\":{},\"questions\":{}}", 5000);
    assert.equal(jevFailure(bad)?.kind, "account");
    status = 503;
    assert.equal(jevFailure(await askDecisionsClassifier({ baseUrl: base, keyFile, model: "test-decisions" }, "{\"state\":{},\"questions\":{}}", 5000)), null);
    // A 200 that is not an answers list is an unreadable answer, not a done run.
    status = 200;
    raw = "not json";
    const junk = await askDecisionsClassifier({ baseUrl: base, keyFile, model: "test-decisions" }, "{\"state\":{},\"questions\":{}}", 5000);
    assert.notEqual(junk.code, 0);
    assert.match(junk.stderr, /unreadable answer/);
    raw = JSON.stringify({ error: { message: "refused" } });
    assert.notEqual((await askDecisionsClassifier({ baseUrl: base, keyFile, model: "test-decisions" }, "{\"state\":{},\"questions\":{}}", 5000)).code, 0);
  } finally { restore(); db.close(); server.close(); }
});

test("the decisions endpoint defaults to its own root and model, and takes the compatible key file when it has none", () => {
  const d = decisionsConfig({ AUTOCRAFT_COMPATIBLE_KEY_FILE: "/k" });
  assert.ok("config" in d);
  assert.equal((d as { config: { baseUrl: string; model: string } }).config.baseUrl, "https://api.openai.com/v1");
  assert.equal((d as { config: { model: string } }).config.model, "gpt-6-luna");
  assert.ok("problem" in decisionsConfig({}));
});

test("a named decisions answer is matched by name only, never by another question's position", () => {
  const questions = wireQuestions({
    security: { type: "noul", instructions: "is it security?" },
    needs_decision: { type: "noul", instructions: "does a person need to decide?" },
  });
  // The endpoint leaves one out: the other's probability must not be handed to it.
  const partial = jevAnswers(questions, [{ type: "predicate", name: "needs_decision", probability: 0.1 }]);
  assert.equal((partial.needs_decision as { noul: number }).noul, 0.1);
  assert.equal(partial.security, undefined);
  // Positional matching only when the endpoint names no answer at all.
  const unnamed = jevAnswers(questions, [{ type: "predicate", probability: 0.7 }, { type: "predicate", probability: 0.1 }]);
  assert.equal((unnamed.security as { noul: number }).noul, 0.7);
  assert.equal((unnamed.needs_decision as { noul: number }).noul, 0.1);
  // A refusal leaves the question unanswered.
  assert.equal(jevAnswers(questions, [{ type: "refusal", name: "security" }, { type: "predicate", name: "needs_decision", probability: 0.4 }]).security, undefined);
});

test("Glob names a file under the directory searched, and a hostile pattern is matched without backtracking", () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-glob-"));
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "a\n");
  writeFileSync(join(dir, "src", "deep", "b.ts"), "b\n");
  const roots = [{ path: "/repo", dir }];
  const under = globFiles(roots, { pattern: "*.ts", path: "/repo/src" });
  assert.match(under, /\/repo\/src\/a\.ts/);
  assert.match(under, /\/repo\/src\/deep\/b\.ts/);
  // `**` crosses directories; a name-only pattern matches at any depth.
  assert.match(globFiles(roots, { pattern: "**/*.ts" }), /\/repo\/src\/deep\/b\.ts/);
  // The pattern that makes a regular expression backtrack exponentially: the matcher answers at once.
  assert.equal(globMatches("*a".repeat(30) + "b", "a".repeat(200)), false);
  assert.equal(globMatches("src/**/b.ts", "src/deep/b.ts"), true);
});

test("the usage row names the model that answered, not the alias the registry asked for", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-usage-model-"));
  const api = await stubApi([() => answer("a summary")]);
  const restore = providerEnv(dir, api.url);
  const db = connect(join(dir, "t.db"));
  try {
    // `verify.summary` is registered for "haiku"; the provider's small tier is "test-small".
    const r = await runModelStep(db, textStep("verify.summary"), [{ ref: "app#1" }] as never, { usage: { run: "r1", agent: "a", stage: "verify-collect" } });
    assert.equal(r.ok, true);
    const row = db.prepare("SELECT model, cost_usd FROM token_usage WHERE run_id = 'r1'").get() as { model: string; cost_usd: number | null };
    assert.equal(row.model, "test-small");
    assert.equal(row.cost_usd, null);
  } finally { restore(); api.close(); db.close(); }
});

test("a reply that fails to parse still names the model that answered in its usage row", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-usage-unparsed-"));
  const api = await stubApi([() => answer("this is not the JSON list the prompt asks for")]);
  const restore = providerEnv(dir, api.url);
  const db = connect(join(dir, "t.db"));
  try {
    const r = await runModelStep(db, REFERENCE_HAIKU, [{ ref: "app#1", text: "a public text" }] as never, { usage: { run: "r2", agent: "a", stage: "classify" } });
    assert.equal(r.ok, false);
    // The tokens were spent by test-small even though no answer parsed: the row must not be filed under "haiku".
    const row = db.prepare("SELECT model, input_tokens, cost_usd FROM token_usage WHERE run_id = 'r2'").get() as { model: string; input_tokens: number; cost_usd: number | null };
    assert.equal(row.model, "test-small");
    assert.ok(row.input_tokens > 0);
    assert.equal(row.cost_usd, null);
  } finally { restore(); api.close(); db.close(); }
});

test("a sandboxed call that fails after a turn keeps that turn's tokens on the failed run", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-usage-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  const api = await stubApi([
    () => ({ json: { model: "test-top", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Glob", arguments: "{}" } }] } }], usage: { prompt_tokens: 120, completion_tokens: 9 } } }),
    () => ({ status: 500, json: { error: { message: "overloaded" } } }),
  ]);
  const restore = providerEnv(dir, api.url);
  const db = connect(join(dir, "t.db"));
  try {
    const r = await askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, { checkout: repo });
    assert.equal(r, null);
    const run = db.prepare("SELECT state, input_tokens, output_tokens, error FROM agent_runs ORDER BY id DESC LIMIT 1").get() as { state: string; input_tokens: number | null; output_tokens: number | null; error: string };
    assert.equal(run.state, "failed");
    // The first turn's tokens are kept: the failed run does not claim it spent nothing.
    assert.equal(run.input_tokens, 120);
    assert.equal(run.output_tokens, 9);
    assert.match(run.error, /status=500/);
  } finally { restore(); api.close(); db.close(); }
});

test("the provider status keeps an invalid configuration and the inference mode, instead of naming a provider that is not running", () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-status-"));
  const db = connect(join(dir, "t.db"));
  const restore = saveEnv();
  try {
    Object.assign(process.env, { AUTOCRAFT_MODEL_PROVIDER: "compatible", AUTOCRAFT_COMPATIBLE_BASE_URL: "http://host/v1", AUTOCRAFT_CLASSIFIER_PROVIDER: "bogus" });
    const p = getProviders(db);
    assert.equal(p.mode, "server");
    assert.equal(p.model.provider, "invalid");
    const j = getJev(db);
    assert.equal(j.provider, "invalid");
    assert.match(j.problem ?? "", /must be jev/);
    // The model calls go to Task Runners in the user-local mode: the page says so instead of claiming the provider runs.
    setInferenceMode(db, "user-local", "test");
    assert.equal(getProviders(db).mode, "user-local");
  } finally { restore(); db.close(); }
});

test("a Grep pattern that backtracks catastrophically is stopped instead of holding the event loop", async () => {
  const dir = mkdtempSync(join(SCRATCH, "compat-redos-"));
  writeFileSync(join(dir, "a.txt"), `${"a".repeat(60)}!\n`);
  const roots = [{ path: "/repo", dir }];
  const began = Date.now();
  await assert.rejects(grepFiles(roots, { pattern: "^(a+)+$" }), /took longer .* was stopped/);
  assert.ok(Date.now() - began < 30_000);
  assert.match(readText(roots, { file_path: "/repo/a.txt", offset: 1, limit: 1 }), /1→a{60}!/);
});
