import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { CaretRightIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { Decision, DecisionChoices } from "../../api/types";
import { useUser } from "../../shell/UserContext";
import { Facts, KindTag } from "../decisions/parts";
import { Refs } from "../decisions/Refs";
import { AnswerNotice } from "../decisions/AnswerNotice";
import { ChoiceGroup } from "./ChoiceGroup";
import { canComment } from "../../registry/permissions";
import { useFolded, useLocal } from "../decisions/state";
import { canActOn } from "../decisions/access";
import { DecisionChips, DecisionDetails, DecisionSummary } from "../decisions/DecisionBlocks";
import { DuplicateGroup, RiskList } from "../decisions/Group";
import { QueuedPress } from "../../ui/molecules/QueuedPress";
import { DisclosurePanel } from "../../ui/molecules/DisclosurePanel";
import { ActionTag } from "../../ui/atoms/ActionTag";

/** Every decision about one item (its own, or a group that lists it), open first. The key is a live topic prefix. */
export function useItemDecisions(repo: string, number: number) {
  const q = useQuery(`item-decisions:${repo}#${number}`, async (api) => {
    const filter = { repo: [repo], number };
    const [open, snoozed, answered] = await Promise.all([api.decisions.list({ ...filter, status: "open" }), api.decisions.list({ ...filter, status: "snoozed" }), api.decisions.list({ ...filter, status: "answered" })]);
    // A disputed answer is in both the open and the answered list.
    const seen = new Set<string>();
    return [...open.decisions, ...snoozed.decisions, ...answered.decisions].filter((d) => !seen.has(d.id) && !!seen.add(d.id));
  });
  const data = useFolded(q.data);
  return { ...q, data };
}

/** The decision id a `#decision-<id>` link names, if any. A malformed escape returns it as written rather than throwing. */
function hashDecision(hash: string): string | null {
  const m = /^#decision-(.+)$/.exec(hash);
  if (!m) return null;
  const raw = m[1]!;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The item's open question under the status bar: the question, what Opus recommends and why, the two facts that decide it, and the
 * answer form itself, with everything else behind one Evidence fold. Further open questions are one line each and swap in when
 * pressed. A just-answered question shows its answer notice until the story has it. `evidence` is the item's own evidence node,
 * shown inside the same fold so the question and what it rests on stay one block.
 */
export function OpenQuestions({ ds, choices, updating, evidence }: { ds: Decision[]; choices?: DecisionChoices | null; updating?: string; evidence?: ReactNode }) {
  const loc = useLocal();
  const { hash, key: navKey } = useLocation();
  // The question in front is held by id, not by position: a question asked or answered meanwhile must not swap the form
  // under the reader's hands. Nothing selected, or the selected one answered, shows the first open question.
  //
  // A link asks for one question (`#decision-<id>`). That request is read in the very render it arrives in, never after the
  // mount: a card claims the decision it shows, so mounting the default card first and switching later would claim both. The
  // token is the navigation the link belongs to, so a later link is honored, a removal of the fragment clears the request,
  // and a question the reader picked by hand stays picked (the token no longer changes).
  const link = hashDecision(hash);
  const token = `${navKey}:${hash}`;
  const [sel, setSel] = useState<{ token: string; id: string | null }>(() => ({ token, id: link }));
  useEffect(() => {
    if (sel.token !== token) setSel({ token, id: link });
  }, [sel.token, token, link]);
  const open = ds.filter((d) => !d.answer);
  const notices = loc.justAnswered.filter((a) => ds.some((d) => d.id === a.id));
  if (!open.length && !notices.length) return null;
  const requested = sel.token === token ? sel.id : link;
  const shown = (requested ? open.find((d) => d.id === requested) : undefined) ?? open[0];
  const others = open.filter((d) => d !== shown);
  // A card is tall, so a swapped-in question is scrolled to its top rather than left half above the fold.
  const show = (id: string) => {
    setSel({ token, id });
    requestAnimationFrame(() => document.getElementById(`decision-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  return (
    <section className="space-y-2" aria-label="Needs you">
      {notices.map((a) => (
        <AnswerNotice key={a.id} entry={a} className="rounded-md border border-line px-3" />
      ))}
      {shown && <HoldCard key={shown.id} d={shown} choices={choices === undefined ? undefined : choices?.decisionId === shown.id ? choices : null} updating={updating === shown.id} evidence={evidence} />}
      {others.map((d) => (
        <button key={d.id} type="button" onClick={() => show(d.id)} className="flex w-full items-start gap-1.5 text-left text-xs text-ink/60 hover:text-ink max-md:min-h-11">
          <CaretRightIcon className="mt-0.5 shrink-0" />
          <span className="min-w-0"><Refs text={d.question} repo={d.repo} /></span>
        </button>
      ))}
    </section>
  );
}

type Rec = { label: string; effect: string | null; tags: DecisionChoices["cores"][number]["writes"] };

/** What Opus recommends as the label and the one line of what it does; null without a recommendation. */
function recommended(d: Decision, choices: DecisionChoices | null | undefined): Rec | null {
  if (choices) {
    const core = choices.cores.find((c) => c.key === choices.pick?.core);
    return core ? { label: core.label, effect: core.autocraft, tags: core.writes } : null;
  }
  const o = d.options.find((x) => x.key === d.recommended);
  return o ? { label: o.label, effect: o.hint ?? null, tags: [] } : null;
}

/** Opus's pick, what it does, its GitHub writes and the model's own reason, on the front of the question and never behind a fold. */
function Recommendation({ rec, reason }: { rec: Rec; reason: string | null }) {
  return (
    <div className="mt-2.5 rounded-md border border-accent/50 bg-accent/[0.06] px-3 py-2.5">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <span className="text-xs font-medium text-accent-ink">Opus recommends</span>
        <span className="min-w-0 break-words font-semibold">{rec.label}</span>
      </p>
      {rec.effect && <p className="mt-0.5 text-xs leading-5 text-ink/70">{rec.effect}</p>}
      {reason && <p className="mt-1.5 text-pretty text-sm leading-[21px] text-ink/85">{reason}</p>}
      {rec.tags.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{rec.tags.map((t) => <ActionTag key={t} tag={t} />)}</div>}
    </div>
  );
}

/**
 * Everything the question rests on, folded once, one click deep: the model's reason when the front does not carry it, the summary,
 * the risks, every fact, a duplicate group's members, the context, the comments an answer would post, the classifiers and related
 * items, then the item's own evidence. Readable by anyone who can see the question; opening it writes nothing, and a batch's
 * per-item answers are offered only when `editable`.
 */
function Evidence({ d, why, editable, extra }: { d: Decision; why: string | null; editable: boolean; extra?: ReactNode }) {
  const n = (count: number, one: string, many: string) => (count > 0 ? `${count} ${count === 1 ? one : many}` : null);
  const counts = [n(d.facts.length, "fact", "facts"), n(d.classifications.length, "classifier", "classifiers")].filter(Boolean).join(" · ");
  return (
    <DisclosurePanel id={`evidence-${d.id}`} title="Evidence" summary={counts || undefined} className="mt-3 bg-transparent">
      <div className="min-w-0 px-3 pb-3 pt-2.5">
        {why && <p className="text-pretty text-sm leading-[21px] text-ink/85">{why}</p>}
        <DecisionSummary d={d} />
        {d.risks.length > 0 && <RiskList risks={d.risks} />}
        {d.group.length > 0 && <DuplicateGroup d={d} />}
        <DecisionDetails d={d} flat canOverride={editable} />
        {extra}
      </div>
    </DisclosurePanel>
  );
}

function HoldCard({ d, choices, updating, evidence }: { d: Decision; choices?: DecisionChoices | null; updating: boolean; evidence?: ReactNode }) {
  const user = useUser();
  const api = useApi();
  const commenter = canComment(user);
  // Opening a decision marks it as being looked at by this person.
  useEffect(() => {
    if (!d.answer && commenter) void api.decisions.claim(d.id);
  }, [api, d.id, d.answer, commenter]);
  // A card from another person is applying an answer: nobody answers meanwhile.
  const queued = d.queued ?? null;
  const applying = !queued && d.settling && d.settling.toLowerCase() !== user.login.toLowerCase() ? d.settling : null;
  const preparing = (d.preparing || updating) && !d.answer;
  const loading = choices === undefined && d.number !== null && d.group.length === 0;
  // While the options are being prepared or fetched, a recommendation from the old set would be stale.
  const rec = preparing || loading ? null : recommended(d, choices);
  const why = choices?.pick?.reason ?? d.recommendedReason ?? null;
  // Two facts are enough to read the question; the whole list stays in Evidence.
  const deciding = d.facts.slice(0, 2);
  // The reason is read once: on the front while a recommendation is shown, in Evidence only when the front carries none.
  const evidenceWhy = rec ? null : why;
  // Who may answer: write access on every repo involved, and only where AutoCraft settles the decision for the reader.
  const answerable = canActOn(user, [d]);
  // A per-item answer can only be set where a press is possible now: nobody edits a batch while it is held, settling or being prepared.
  const editable = answerable && !queued && !applying && !preparing && !loading;
  return (
    <article id={`decision-${d.id}`} className="scroll-mt-3 rounded-lg border border-line-strong bg-raised px-4 py-4 md:px-5 md:py-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink/55">
        <span className="font-semibold text-ink/75">Needs you</span>
        <KindTag kind={d.kind} batch={d.number === null ? d.items.length : undefined} />
        {d.snoozed && <span>Snoozed until new activity</span>}
      </div>
      <h3 className="mt-1.5 text-pretty text-lg font-semibold leading-6"><Refs text={d.question} repo={d.repo} /></h3>
      {rec && <Recommendation rec={rec} reason={why} />}
      {deciding.length > 0 && (
        <div className="mt-2.5 rounded-md border border-line bg-ink/[0.025] px-2.5 py-2">
          <Facts facts={deciding} repo={d.repo} />
        </div>
      )}
      {queued ? (
        <QueuedPress by={queued.by} queued={queued} viewer={{ login: user.login, operator: user.role === "operator" }} canSettle={canActOn(user, [d])}
          onDismiss={() => api.conversations.dismissCard(queued.card)} onDispute={(reason) => api.conversations.disputeCard(queued.card, reason)} onKeep={() => api.conversations.keepCard(queued.card)} />
      ) : applying ? (
        <p className="mt-2 text-sm text-ink/70">{applying} is applying their answer</p>
      ) : preparing ? (
        <p className="mt-2 text-sm text-ink/55">{d.preparing ? "Opus is preparing the options" : "Opus is updating the options"}</p>
      ) : loading ? (
        <p role="status" className="mt-2 text-sm text-ink/55">Loading the answer options…</p>
      ) : answerable ? (
        <ChoiceGroup d={d} user={user} choices={choices} />
      ) : null}
      <Evidence d={d} why={evidenceWhy} editable={editable} extra={evidence} />
      {(d.priority || d.claim || (user.role === "operator" && d.number !== null)) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
          <DecisionChips d={d} />
        </div>
      )}
    </article>
  );
}