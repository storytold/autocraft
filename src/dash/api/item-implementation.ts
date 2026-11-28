// The item page's Implementation panel and its history lines: the issue's current (or newest ended) attempt from the
// implementations store, its rounds, and the agent runs of its model calls. Redaction: viewers get the state, the PR, the
// change size, the check outcomes and the cost; plans, questions, screenshots, summaries, findings and errors are staff only.
import type { ItemShown, HistoryCall, ImplementationCall, ImplementationCheckPart, ImplementationCheckRound, ImplementationQuestion, ItemImplementation, TimelineEntry } from "../../../web/src/api/types.ts";
import type { CheckPart, CheckRound } from "../../implement/checks.ts";
import type { TurnRound } from "../../implement/session.ts";
import type { AskFailedRound, AnswerRound, Implementation, ImplementationRound, PlanReply, QuestionRound, RetryRound } from "../../data/implement/types.ts";
import { loadItemImplementation, type ImplementationFacts } from "../../data/views/item-implementation.ts";
import type { CommentOut } from "../../data/mirror/types.ts";
import { clip, type Ctx } from "./trace.ts";
import { isOwnLogin } from "../../github/identity.ts";

type Run = { id: number; cost_usd: number | null; model: string; user_login: string | null; harness: string | null; reported_model: string | null };

/** What the panel and the history lines are built from, read once per page. */
export type ImplementationData = {
  impl: Implementation; attempts: number; rounds: ImplementationRound[];
  /** The agent run of each call id the rounds name. */
  runOf: Map<number, Run>;
  /** How each of the attempt's workspaces started its build dir (layout 2: warm copy or cold, src/build/workspace-layout.ts). */
  starts: { id: number; at: string; note: string; warm: boolean }[];
  /** The issue's comments (without bot logins), for the answers to a question asked on the issue. */
  comments: CommentOut[];
};

/** The screenshot route of a stored shot (`implementations/<id>/<file>` under the artifact directory). */
export const shotUrl = (id: number, file: string): string => `/api/implementations/${id}/shots/${encodeURIComponent(file.slice(file.lastIndexOf("/") + 1))}`;

/** The cause of a reason, without the detail after its first ": ", for viewers. */
const causeOf = (s: string | null): string | null => (s === null ? null : s.split(": ")[0]!);

/** The panel's data from the loaded facts. */
export function implementationFrom(f: ImplementationFacts | null): ImplementationData | null {
  if (!f) return null;
  const { impl, attempts, rounds } = f.view;
  const runOf = new Map<number, Run>();
  for (const [call, runId] of f.runIds) {
    const r = f.runs.get(runId);
    if (r) runOf.set(call, { id: r.id, cost_usd: r.costUsd, model: r.model, user_login: r.userLogin, harness: r.harness, reported_model: r.reportedModel });
  }
  const starts: ImplementationData["starts"] = [];
  for (const [id, w] of [...f.warm].sort((a, b) => a[0] - b[0])) {
    const x = parseWarm(w.warm);
    if (x?.note && x.at) starts.push({ id, at: x.at, note: x.note, warm: w.warmCommit !== null && x.note.startsWith("warm copy") });
  }
  return { impl, attempts, rounds, runOf, starts, comments: f.comments };
}

export async function implementationData(c: Ctx, comments?: CommentOut[]): Promise<ImplementationData | null> {
  return implementationFrom(await loadItemImplementation(c.db, { repo: c.repo, number: c.n }, comments));
}

const parseWarm = (s: string | null): { note?: string; at?: string } | null => {
  try {
    return s ? (JSON.parse(s) as { note?: string; at?: string }) : null;
  } catch {
    return null;
  }
};

const part = (p: CheckPart | undefined): ImplementationCheckPart => ({ ran: p?.ran ?? false, exit: p?.exit ?? null, findings: p?.findings ?? 0, noVerdict: p?.noVerdict ?? false, note: p?.note ?? null });

function callOf(c: Ctx, d: ImplementationData, r: ImplementationRound): ImplementationCall {
  const run = r.callId === null ? undefined : d.runOf.get(r.callId);
  const staffRun = c.staff && run ? { runId: run.id, ...(run.user_login && { via: { login: run.user_login, harness: run.harness ?? "", model: run.reported_model ?? "" } }) } : { runId: null };
  if (r.kind === "plan") {
    const p = r.result as Partial<PlanReply> | null;
    return { at: r.at, purpose: "plan", outcome: p ? "done" : "failed", status: null, summary: c.staff ? p?.summary ?? null : null, error: null, turns: null, toolCalls: 0, shellMs: 0, costUsd: run?.cost_usd ?? null, ...staffRun };
  }
  const t = (r.result ?? {}) as Partial<TurnRound>;
  return {
    at: r.at, purpose: t.purpose ?? "start", outcome: t.outcome ?? "queued", status: t.report?.status ?? null,
    summary: c.staff ? t.report?.summary ?? null : null,
    error: c.staff ? t.error ?? t.parseError ?? t.report?.blocked_reason ?? null : null,
    turns: t.turns ?? null, toolCalls: t.calls ?? 0, shellMs: t.shellMs ?? 0, costUsd: run?.cost_usd ?? t.costUsd ?? null, ...staffRun,
  };
}

function questionsOf(c: Ctx, d: ImplementationData): ImplementationQuestion[] {
  const qs = d.rounds.filter((r) => r.kind === "question").map((r) => ({ id: r.id, at: r.at, q: r.result as Partial<QuestionRound> | null })).filter((x) => x.q?.text);
  if (!qs.length) return [];
  const answers = d.rounds.filter((r) => r.kind === "answer").map((r) => ({ at: r.at, a: r.result as Partial<AnswerRound> | null }));
  const comments = d.comments.filter((m) => m.created_at !== null);
  return qs.map(({ id, at, q }): ImplementationQuestion => {
    const audience = q!.audience === "maintainer" ? "maintainer" : "author";
    const given = answers.filter((x) => x.a?.question === id).pop();
    let answer: ImplementationQuestion["answer"] = null;
    if (given?.a) {
      const label = q!.options?.find((o) => o.key === given.a!.option)?.label ?? given.a.option ?? "";
      const text = given.a.text ? (label ? `${label}: ${given.a.text}` : given.a.text) : label;
      answer = { by: given.a.by ?? "someone", at: given.a.at ?? given.at, text };
    } else if (audience === "author") {
      const reply = comments.find((m) => m.created_at! > at && !!m.author && !isOwnLogin(c.own, m.author) && !/\[bot\]$/.test(m.author));
      if (reply) answer = { by: reply.author!, at: reply.created_at!, text: clip(reply.body ?? "", 600) };
    }
    return { at, audience, text: q!.text!, answer };
  });
}

export function implementationView(c: Ctx, d: ImplementationData | null, pr: ItemShown | null): ItemImplementation | null {
  if (!d) return null;
  const { impl } = d;
  const calls = d.rounds.filter((r) => r.kind === "plan" || r.kind === "session" || r.kind === "follow-up").map((r) => callOf(c, d, r));
  const checks = d.rounds.filter((r) => r.kind === "checks" && r.result).map((r): ImplementationCheckRound => {
    const x = r.result as CheckRound;
    return {
      at: r.at, round: x.round, diffStat: x.diffStat, crates: x.crates ?? [], fmt: part(x.fmt), clippy: part(x.clippy), tests: part(x.tests), clean: x.clean,
      findings: c.staff ? (x.findings ?? []).map((f) => ({ check: f.check, file: f.file, line: f.line, message: f.message })) : [],
      notes: c.staff ? [...(x.notes ?? []), ...(x.noVerdict ?? []).map((n) => `No verdict: ${n}`)] : [],
    };
  });
  const shots = c.staff ? d.rounds.flatMap((r) => (r.kind === "session" || r.kind === "follow-up" ? ((r.result as Partial<TurnRound> | null)?.shots ?? []) : []))
    .map((s) => ({ n: s.n, what: s.what, url: shotUrl(impl.id, s.file), width: s.width, height: s.height })) : [];
  const plan = c.staff && impl.plan ? {
    ready: impl.plan.ready, kind: impl.plan.kind, size: impl.plan.size, summary: impl.plan.summary, markdown: impl.planMd ?? impl.plan.plan,
    acceptance: impl.plan.acceptance ?? [], tests: impl.plan.verification?.tests ?? [], app: impl.plan.verification?.app ?? null, risks: impl.plan.risks ?? [],
  } : null;
  const runCost = [...d.runOf.values()].reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  return {
    id: impl.id, attempt: impl.attempt, attempts: d.attempts, state: impl.state, queuedBy: c.staff ? impl.queuedBy : null, createdAt: impl.createdAt, updatedAt: impl.updatedAt,
    reason: c.staff ? impl.reason : causeOf(impl.reason), plan, questions: c.staff ? questionsOf(c, d) : [], calls, checks, diffStat: impl.diffStat,
    pr: impl.prNumber === null ? null : { repo: impl.repo, number: impl.prNumber, kind: "pr", state: pr?.state ?? null, title: pr?.title ?? null, url: impl.prUrl },
    shots,
    costUsd: runCost || calls.reduce((s, x) => s + (x.costUsd ?? 0), 0),
  };
}

// ---- history lines ---------------------------------------------------------------------------------------------------

const TURN: Record<string, string> = {
  start: "Implementation session", retry: "Implementation session, tried again", fresh: "Implementation session, started fresh", findings: "Follow-up turn on the checks' findings",
  report: "Follow-up turn for the report", lint: "Follow-up turn on the summary's wording",
};
const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

/** Every run id the implementation's rounds name: the history shows those calls on its own lines, not on the job's. */
export const implementationRunIds = (d: ImplementationData | null): Set<number> => new Set(d ? [...d.runOf.values()].map((r) => r.id) : []);

/** The history lines of the attempt: one per round, plus its start and, once stuck, the stuck line. */
export function implementationLines(c: Ctx, d: ImplementationData | null, line: (id: string, at: string, kind: TimelineEntry["kind"], actor: string, icon: TimelineEntry["icon"], text: string) => TimelineEntry): TimelineEntry[] {
  if (!d) return [];
  const { impl } = d;
  const out: TimelineEntry[] = [];
  const modelCalls = (r: ImplementationRound, label: string): HistoryCall[] => {
    const run = r.callId === null ? undefined : d.runOf.get(r.callId);
    if (!c.staff || !run) return [];
    return [{ label: `${label} (${run.model})`, kind: "model", costUsd: run.cost_usd, runId: run.id, ...(run.user_login && { via: { login: run.user_login, harness: run.harness ?? "", model: run.reported_model ?? "" } }) }];
  };
  const start = line(`impl:${impl.id}`, impl.createdAt, "harness", "AutoCraft", "fixup", `Implementation attempt ${impl.attempt} started${c.staff ? `, queued by ${impl.queuedBy}` : ""}`);
  start.major = true;
  out.push(start);
  let checkRound = 0;
  for (const r of d.rounds) {
    const id = `impl-round:${r.id}`;
    if (r.kind === "plan") {
      const p = r.result as Partial<PlanReply> | null;
      const t = line(id, r.at, "opus", "Opus", "review", !p ? "Plan: no usable reply" : p.ready ? `Planned the change (${p.kind ?? "change"}, size ${p.size ?? "?"})` : "Plan: questions come first");
      t.major = true; t.tone = !p ? "bad" : p.ready ? "ok" : "warn"; t.calls = modelCalls(r, "Plan"); t.costUsd = t.calls[0]?.costUsd ?? null;
      if (c.staff && p) { t.body = p.summary ?? null; t.lines = (p.acceptance ?? []).map((a) => `Acceptance: ${a}`); }
      out.push(t);
    } else if (r.kind === "question") {
      const q = r.result as Partial<QuestionRound> | null;
      const t = line(id, r.at, "harness", "AutoCraft", "chat", q?.audience === "maintainer" ? "Asked a maintainer" : "Asked the issue's author");
      t.major = true; t.tone = "warn";
      if (c.staff) t.body = q?.text ?? null;
      out.push(t);
    } else if (r.kind === "guidance") {
      const g = r.result as { by?: string; text?: string } | null;
      const t = line(id, r.at, "person", g?.by ?? "someone", "person", "gave guidance for the next attempt");
      t.major = true;
      if (c.staff) t.body = g?.text ?? null;
      out.push(t);
    } else if (r.kind === "session" || r.kind === "follow-up") {
      const x = (r.result ?? {}) as Partial<TurnRound>;
      const label = TURN[x.purpose ?? "start"] ?? "Session turn";
      const how = x.outcome === "queued" ? "waiting for the Task Runner" : x.outcome === "done" ? (x.report ? (x.report.status === "done" ? "done" : "blocked") : "no report") : x.outcome ?? "queued";
      const t = line(id, r.at, "opus", "Opus", "job", `${label}: ${how}${x.calls ? `, ${x.calls} tool calls` : ""}${x.shellMs ? `, ${minutes(x.shellMs)} in the shell` : ""}`);
      t.major = r.kind === "session"; t.tone = how === "done" ? "ok" : /blocked|failed|no report/.test(how) ? "bad" : "neutral";
      t.calls = [...modelCalls(r, label), ...(c.staff && x.calls ? [{ label: `${x.calls} workspace tool calls`, kind: "tool" as const, costUsd: null }] : [])];
      t.costUsd = t.calls[0]?.costUsd ?? x.costUsd ?? null;
      if (c.staff) {
        t.body = x.report?.summary ?? null;
        t.lines = [...(x.error ? [x.error] : []), ...(x.parseError ? [`Not the report: ${x.parseError}`] : []), ...(x.report?.blocked_reason ? [`Blocked: ${x.report.blocked_reason}`] : []),
          ...(x.report?.changes ?? []).map((ch) => `Change: ${ch}`), ...(x.shots?.length ? [`${x.shots.length} screenshots`] : []), ...(x.shotErrors ?? [])];
      }
      out.push(t);
    } else if (r.kind === "checks") {
      const x = r.result as CheckRound | null;
      if (!x) continue;
      checkRound++;
      const t = line(id, r.at, "harness", "AutoCraft", "check", `Checks, round ${x.round ?? checkRound}: ${x.clean ? "clean" : x.needsDependency ? "a dependency is missing" : x.findings.length ? `${x.findings.length} findings` : "no verdict"} (${x.diffStat})`);
      t.tone = x.clean ? "ok" : "warn"; t.major = x.clean;
      if (c.staff) t.lines = [...x.findings.slice(0, 10).map((f) => `${f.check}: ${f.file}:${f.line} ${f.message}`), ...(x.notes ?? [])];
      out.push(t);
    } else if (r.kind === "refusal") {
      const x = r.result as { kind?: string; reason?: string; problems?: string[] } | null;
      const t = line(id, r.at, "harness", "AutoCraft", "check", x?.kind === "push" ? "Opening the PR failed" : "The diff check refused the change");
      t.tone = "bad"; t.major = true;
      if (c.staff) t.lines = [...(x?.reason ? [x.reason] : []), ...(x?.problems ?? [])];
      out.push(t);
    } else if (r.kind === "workspace") {
      const x = r.result as { reason?: string } | null;
      const t = line(id, r.at, "harness", "AutoCraft", "job", "The workspace was made again");
      t.tone = "warn";
      if (c.staff && x?.reason) t.lines = [x.reason];
      out.push(t);
    } else if (r.kind === "retry") {
      const x = r.result as Partial<RetryRound> | null;
      if (x?.person) {
        out.push(line(id, r.at, "harness", "AutoCraft", "job", "Tried again on a person's answer; the revision starts over on the change last pushed"));
        continue;
      }
      const t = line(id, r.at, "harness", "AutoCraft", "job", "Stopped on a failure of AutoCraft's own; it goes on by itself after a wait");
      t.tone = "warn";
      if (c.staff && x?.detail) t.lines = [x.detail];
      out.push(t);
    } else if (r.kind === "ask-failed") {
      const x = r.result as Partial<AskFailedRound> | null;
      const t = line(id, r.at, "harness", "AutoCraft", "chat", "Asking the plan's questions failed");
      t.tone = "bad";
      if (c.staff && x?.error) t.lines = [x.error];
      out.push(t);
    }
  }
  for (const w of d.starts) {
    const t = line(`impl-ws:${w.id}:${w.at}`, w.at, "harness", "AutoCraft", "job", w.warm ? "The workspace started from the warm build" : "The workspace started without a warm build");
    if (c.staff) t.lines = [w.note];
    out.push(t);
  }
  if (impl.state === "stuck" || impl.state === "failed" || impl.state === "cancelled") {
    const t = line(`impl:${impl.id}:end`, impl.updatedAt, "harness", "AutoCraft", "fixup", `Implementation ${impl.state}${impl.reason ? `: ${clip(c.staff ? impl.reason : causeOf(impl.reason), 140)}` : ""}`);
    t.major = true; t.tone = impl.state === "cancelled" ? "warn" : "bad";
    out.push(t);
  }
  return out;
}
