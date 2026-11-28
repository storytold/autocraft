// Facts of open items (issues and PRs) for the triage steps: classification, priority, embedding, duplicates, labels, implementation.
// Built for a whole pass or a slice of it from the module loads of core/pass-load.ts. Reads only: a text hash sync has not written
// yet is computed here.
import { config, withConfig } from "../data/control/index.ts";
import type { IssueAttempt } from "../data/implement/types.ts";
import { openItemKeys } from "../data/mirror/index.ts";
import type { KeySource, Ref } from "../data/keys.ts";
import { ENDED_STATES, LIVE_STATES } from "../implement/types.ts";
import { isBotLogin } from "../review/bots.ts";
import { plainLogin } from "../github/identity.ts";
import { PIPELINE_LOGIN_KEY, pipelineWrites, unsentAsk } from "./rules.ts";
import { assignmentIn, ownPrSet, queuerIn, refreshTimes, standingIn, workflowFactOf, type FactsOf } from "./facts.ts";
import { tripsOfRepo } from "./push-outcome.ts";
import { issueReviewDueAt } from "./backoff.ts";
import { needsDecisionOf, refereeClosed, securityOf, settle, topOf, SURE, type Referee } from "../classify/settled.ts";
import { JEV_FLAG_NO, JEV_NEEDS_DECISION_YES, JEV_SECURITY_YES } from "../classify/parse.ts";
import { embedderId, modelName } from "../embed/model.ts";
import { classifyHash, embedHash as hashOfText, SCHEME_ID } from "../itemhash.ts";
import { openPrsByRepo, textHash, type OpenPr } from "./open-prs.ts";
import { workScore } from "./work-score.ts";
import { inStep, loadItemPass, loadPassBase, type EndWave, type ItemPassData, type ItemPassNeeds, type PassBase, type SharedDupes } from "./pass-load.ts";
import type { ItemFacts } from "./plan.ts";
import { overBefore } from "../workflow/work.ts";
import type { Db } from "../db/index.ts";

export type { ItemFacts } from "./plan.ts";

export type ItemLoadOptions = {
  repo?: string;
  /** Only these items, as "repo#number". */
  refs?: Iterable<string>;
  /** Decision time in ms (default: the clock). */
  now?: number;
  /** The embedding model whose vectors count (default: the configured one). */
  model?: string;
  /** The classification run (default: latestRun, the current run else the newest verdict run). */
  run?: string | null;
  /** Our logins and the run, when the caller read them. */
  base?: PassBase;
};

const json = <T>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
const flagsOf = (s: string | null): string[] => { const f = json<unknown>(s, []); return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : []; };
const asRef = (key: string): Ref => { const i = key.lastIndexOf("#"); return { repo: key.slice(0, i), number: Number(key.slice(i + 1)) }; };

/** The run's verdicts of one item that count: a Haiku row without a Jev row only when Haiku classified alone (it carries the item's input hash). */
function verdictsOf(d: ItemPassData, ref: string) {
  const cls = d.triage.facts.get(ref)?.verdicts ?? [];
  const j = cls.find((c) => c.classifier === "jev");
  return { j, h: cls.find((c) => c.classifier === "haiku" && (j || c.input_hash !== null)), s: cls.find((c) => c.classifier === "sonnet") };
}

/** The stored classifier input hash, when it was made under the current scheme. */
const storedClassHash = (i: { class_hash: string | null; class_scheme: string | null }): string | null => (i.class_scheme === SCHEME_ID ? i.class_hash : null);

/** Who queued the issue for implementation: who started its live implement workflow. */
function queuedOf(d: ItemPassData, ref: string): { actors: string[]; at: string } | null {
  const w = d.workflow.live.get(ref);
  return w?.entry === "implement" ? { actors: d.workflow.actors.get(w.id) ?? [], at: w.since } : null;
}

/**
 * Answers count only when they came after the attempt's newest question (else after it last moved): a re-plan that asks again
 * writes a new question round, so the answers it already read do not plan it again.
 */
const askedSince = (a: IssueAttempt): string => a.question?.at ?? a.attempt.updatedAt;

/** The item's close to carry out. */
function closeOf(d: ItemPassData, ref: string): ItemFacts["close"] {
  const a = d.closes.get(ref);
  const auto = a?.kind === "ask-author" && d.workflow.live.get(ref)?.authorAsk === "auto";
  return a ? { id: a.id, by: a.by, weight: a.weight, at: a.created_at, ...(auto ? { auto: true as const } : {}) } : null;
}

/** The open tracked items of the load, in repo and number order. */
function rowsOf(d: ItemPassData, opts: { repo?: string; refs?: ReadonlySet<string> }) {
  return [...d.items].filter(([ref, i]) => i.state === "OPEN" && d.triage.facts.has(ref) && (!opts.repo || i.repo === opts.repo) && (!opts.refs || opts.refs.has(ref)))
    .sort(([, a], [, b]) => (a.repo === b.repo ? a.number - b.number : a.repo < b.repo ? -1 : 1));
}

/**
 * What the second wave reads: the text of items with an implementation attempt, a missing text hash or a classifier hash to recompute,
 * the attempts' PRs, the comments after open questions, and who the queued issues are implemented for.
 */
function needsOf(d: ItemPassData, opts: { repo?: string; refs?: ReadonlySet<string> }): ItemPassNeeds {
  const out: ItemPassNeeds = { texts: [], prs: [], asked: [], logins: [] };
  for (const [ref, i] of rowsOf(d, opts)) {
    const a = i.kind === "issue" ? d.implement.byIssue.get(ref) : undefined;
    const { j, h } = verdictsOf(d, ref);
    if (a || i.embed_hash === null || (storedClassHash(i) === null && (j || h))) out.texts.push({ repo: i.repo, number: i.number });
    if (a && a.attempt.prNumber !== null) out.prs.push({ repo: i.repo, number: a.attempt.prNumber });
    if (a?.attempt.state === "asked") out.asked.push({ ref: { repo: i.repo, number: i.number }, since: askedSince(a) });
    const w = workflowFactOf(d, ref);
    if (w) for (const login of d.workflow.actors.get(w.id) ?? []) out.logins.push({ login, repo: i.repo });
  }
  return out;
}

/** Facts of every open item (issue or PR) of the tracked repos, for the database, repo or refs given. */
export async function loadItemFacts(db: Db, opts: ItemLoadOptions = {}): Promise<ItemFacts[]> {
  return await (await db.read(async () => {
    const base = opts.base ?? await loadPassBase(db, opts.run);
    return (await inStep<[FactsOf<ItemFacts>]>(db, (endWave) => itemFacts(db, { ...opts, base }, endWave)))[0];
  }))();
}

/** loadItemFacts() as one load of a group that runs in step: loads the rows and returns what builds the facts from them. */
export async function itemFacts(db: Db, opts: ItemLoadOptions & { base: PassBase; dupes?: SharedDupes }, endWave: EndWave): Promise<FactsOf<ItemFacts>> {
  const now = opts.now ?? Date.now();
  const refs = opts.refs ? new Set(opts.refs) : undefined;
  if (refs && !refs.size) return async () => [];
  const model = opts.model ?? embedderId(modelName());
  const keys: KeySource = refs ? [...refs].map(asRef) : openItemKeys({ tracked: true, ...(opts.repo ? { repos: [opts.repo] } : {}) });
  const keep = { repo: opts.repo, refs };
  const d = await loadItemPass(db, keys, { now, base: opts.base, model, repo: opts.repo, dupes: opts.dupes, needs: (x) => needsOf(x, keep) }, endWave);
  return () => withConfig(db, async () => factsOf(db, d, rowsOf(d, keep)), { preload: d.control });
}

function factsOf(db: Db, d: ItemPassData, rows: ReturnType<typeof rowsOf>): ItemFacts[] {
  const { now, run } = d;
  const cfg = config(db);
  const pipelineOn = pipelineWrites(d.control.settings.get("pipeline_enabled") ?? undefined);
  const pipelineLogin = d.control.settings.get(PIPELINE_LOGIN_KEY) ?? null;
  const tripped = Object.fromEntries([...d.control.trips].filter(([, t]) => t.active).map(([k, t]) => [k, t.reason]));
  const ownPrs = ownPrSet(d.mainFixPrs, d.quiet, pipelineLogin);
  const isOwn = (author: string | null): boolean => !!author && d.ownLogins.has(author.toLowerCase());
  const own = new Set([...d.ownLogins].map(plainLogin));
  const openPrs = openPrsByRepo(d.openPrs);
  const openPrMaps = new Map<string, Map<number, OpenPr>>();
  const openPrOf = (repo: string, number: number): OpenPr | null => (openPrMaps.get(repo) ?? openPrMaps.set(repo, openPrs(repo)).get(repo)!).get(number) ?? null;
  // A duplicate set's answer changes with the clock alone (retries, pauses).
  const refresh = refreshTimes(now);
  for (const [ref, at] of d.triage.compareDueAt) refresh.soon(ref, at);

  return rows.map(([ref, r]): ItemFacts => {
    const t = d.triage.facts.get(ref)!;
    const text = d.texts.get(ref);
    const { j, h, s } = verdictsOf(d, ref);
    let referee: Referee | null = null;
    if (s && j && h && s.at >= j.at && s.at >= h.at) {
      const p = json<{ sure?: unknown; final?: unknown; opusFailures?: unknown; opusFailedAt?: unknown } | null>(s.probs, null);
      if (typeof p?.sure === "boolean" && s.type_label !== null) referee = { label: s.type_label, sure: p.sure, reason: "", ...(p.final === true && { final: true }), ...(typeof p.opusFailures === "number" && { failures: p.opusFailures }), ...(typeof p.opusFailedAt === "string" && { failedAt: p.opusFailedAt }) };
    }
    const settled = settle(
      j && j.type_label !== null ? { label: j.type_label, flags: flagsOf(j.flags), top: topOf(j.probs), nd: needsDecisionOf(j.probs), sec: securityOf(j.probs) } : null,
      h && h.type_label !== null ? { label: h.type_label, flags: flagsOf(h.flags) } : null,
      referee,
    );
    // The classifier's input hash: stored on the row, recomputed when it was made under another scheme.
    const classHash = storedClassHash(r) ?? ((j || h) && text ? classifyHash(text) : null);
    const unsureFlag = (key: string, yes: number): boolean => {
      const p = (json<Record<string, unknown> | null>(j?.probs ?? null, null) ?? {})[key];
      return typeof p === "number" && p >= JEV_FLAG_NO && p < yes;
    };
    const jev = j ? {
      at: j.at,
      changed: j.input_hash !== null ? j.input_hash !== classHash : (r.updated_at ?? "") > j.at,
      unsure: (topOf(j.probs) ?? 0) < SURE || unsureFlag("security", JEV_SECURITY_YES) || unsureFlag("needs_decision", JEV_NEEDS_DECISION_YES),
    } : null;
    const haiku = h ? { at: h.at, aloneCurrent: h.input_hash !== null && h.input_hash === classHash && (!j || h.at > j.at) } : null;
    const embedHash = r.embed_hash ?? hashOfText(text!.title, text!.body);
    const approvals = d.control.approvals.get(r.repo) ?? {};
    const wf = d.workflow.live.get(ref) ?? null;
    const work = workflowFactOf(d, ref);
    const outsideHold = d.outsideHolds.get(ref);
    const a = r.kind === "issue" ? d.implement.byIssue.get(ref) : undefined;
    const q = r.kind === "issue" ? queuedOf(d, ref) : null;
    const attemptPr = a && a.attempt.prNumber !== null ? d.prs.get(`${r.repo}#${a.attempt.prNumber}`) : undefined;
    const acts = { act: d.act, identity: cfg.githubIdentity, now, soon: (at: number | undefined) => refresh.soon(ref, at) };
    const queuer = queuerIn(q?.actors, r.repo, acts);
    const standing = standingIn(work, d.workflow.actors, r.repo, acts);
    const live = d.implement.liveByRepo.get(r.repo);
    if (a?.startRetry) refresh.soon(ref, a.startRetry.dueAt);
    const ir = r.kind === "issue" ? d.issueReviews.get(ref) : undefined;
    if ((ir?.state === "queued" || (ir?.state === "reporter" && ir.reporterAnswered)) && ir.tries > 0 && ir.triedAt) refresh.soon(ref, issueReviewDueAt(ir));
    const unsent = ir && (ir.state === "posting" || ir.state === "ask") ? unsentAsk(ir.postTries, now) : null;
    if (unsent !== null && unsent !== "final") refresh.soon(ref, unsent.until);
    const refreshAt = refresh.at(ref);
    return {
      repo: r.repo, number: r.number, kind: r.kind as ItemFacts["kind"], open: true, assignment: assignmentIn(pipelineLogin, d.assignments.get(ref), r.assignees), now, ...(refreshAt !== undefined ? { refreshAt } : {}),
      pipelineOn, tripped: tripsOfRepo(tripped, r.repo),
      inFlight: (r.kind === "issue" && LIVE_STATES.has(a?.attempt.state ?? "failed")) || (r.kind === "pr" && ownPrs.has(ref) && isOwn(r.author)), draft: !!r.is_draft,
      inScope: d.inScope.has(ref), ...(outsideHold ? { outsideHold } : {}), integration: d.batchPrs.has(ref) && isOwn(r.author),
      held: !work && d.workflow.ended.get(ref) === "backlog" ? "backlog" : null,
      score: workScore(work) ?? t.score,
      repoFacts: { labelsApproved: !!approvals.labels, commentApproved: !!approvals.comment },
      workflow: wf, standing, endedWorkflow: wf ? null : d.workflow.ended.get(ref) ?? null,
      run,
      classification: {
        status: settled.status, label: settled.label, flags: settled.flags, jevLabel: settled.jevLabel, haikuLabel: settled.haikuLabel,
        referee: settled.referee ? { sure: settled.referee.sure, final: refereeClosed(settled.referee), failedAt: settled.referee.failedAt ?? null } : null, jev, haiku,
        jevFailed: classHash !== null && t.jevFailedHash === classHash,
      },
      embedHash, embeddedHash: t.embeddedHash, priorityHash: t.priority?.hash ?? null, scannedHash: t.scannedHash,
      pairsToCheck: t.pairsToCheck, inCompareSet: t.compare ?? false,
      labels: { quietFix: d.quiet.has(ref), existing: json<unknown[]>(r.labels, []).map(String), labeledNote: d.stages.get(ref)?.labeledNote ?? null },
      close: closeOf(d, ref),
      issueReview: ir ?? null,
      openPr: r.kind === "issue" ? openPrOf(r.repo, r.number) : null,
      implement: {
        ...queuer, featureOn: cfg.repo(r.repo).buildFeature("implement"),
        row: a ? {
          state: a.attempt.state, attempt: a.attempt.attempt,
          textChanged: textHash(text?.title ?? "", text?.body ?? "") !== a.attempt.textHash,
          // A person's comment: not a bot's and not ours (the box account or the app's bot, which the mirror stores as a bare slug).
          newCommentAfterQuestion: a.attempt.state === "asked" && (d.comments.get(ref) ?? []).some((c) =>
            c.author !== null && (c.created_at ?? "") > askedSince(a) && !own.has(plainLogin(c.author)) && !isBotLogin(c.author)),
          decisionAnswered: (a.attempt.state === "stuck" || a.attempt.state === "asked") && a.answer !== null,
          asked: a.attempt.state === "asked" ? a.question?.audience ?? "author" : null,
          // An attempt whose PR was over before the queueing is recorded as ended after it.
          // A question that showed the end is as old as the end, or newer (comeWith).
          requeuedAfterEnd: ENDED_STATES.has(a.attempt.state) && q !== null && (q.at >= a.attempt.updatedAt || overBefore(attemptPr, q.at)),
          ...(ENDED_STATES.has(a.attempt.state) ? { endedAt: a.attempt.updatedAt } : {}),
          // The PR we just opened counts as open until a sync mirrors it.
          prOpen: a.attempt.prNumber !== null && (attemptPr?.state ?? "OPEN") === "OPEN",
          ...(a.startRetry ? { startRetry: a.startRetry } : {}),
        } : null,
        liveInRepo: (live?.size ?? 0) - (live?.has(ref) ? 1 : 0),
      },
    };
  });
}

/** Facts of one open item, or null. */
export async function loadItemFact(db: Db, repo: string, number: number, opts: Omit<ItemLoadOptions, "repo" | "refs"> = {}): Promise<ItemFacts | null> {
  return (await loadItemFacts(db, { ...opts, repo, refs: [`${repo}#${number}`] }))[0] ?? null;
}
