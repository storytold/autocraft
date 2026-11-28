// Whether a Task Runner can take work a person started or approved on an item, and why none can: for the line a command's confirmation
// adds (src/workflow/apply.ts) and the notice a stalled call posts once in the item's chat (stallNotices; Discord threads that follow the
// item repeat it, src/discord/results.ts). Model calls run only on people's own Task Runners. The rules are the claim's and the taker
// rule's (src/remote/started.ts, src/remote/takers.ts): the person's own runner, and those of the people whose started work it already
// is, take it whatever their Manual only, My repos, tasks and items, under the role rules, write permission and the call's tier; another
// person's runner takes it under that person's settings.
import type { ItemRef } from "../../web/src/api/types.ts";
import { loadNotices, recordNotices, type NewChatMessage } from "../data/chat/index.ts";
import { loadEvents, loadPrWorkflows } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";
import { STATUS_FRESH_MS } from "../remote/helpers.ts";
import { TASK_CHOICES } from "../remote/my-tasks.ts";
import type { Tier } from "../remote/protocol.ts";
import { runnerTakes } from "../remote/rules.ts";
import { startedOf } from "../remote/started.ts";
import { runnerHoldOf, waitingOnIn, type RunnerHold } from "../remote/takers.ts";
import { canWriteOf, freshReady, loadView, runnerOf, settingsOf, takersIn, type RemoteView, type Runner } from "../remote/view.ts";
import { CHAT_AUTHOR } from "../workflow/chat.ts";
import { runnerLine } from "../workflow/status.ts";
import { RULE_STARTER } from "../workflow/types.ts";

/**
 * Why no Task Runner can take the work now, the first that holds of: `tier`, a ready runner would take it but serves no model of its
 * tier; `held`, the other runners that would take it are held by their usage limit; `own-*`, the person has a runner credential and their
 * runners are offline, held by their usage limit, cooling off, not ready, or ready but may not take it (`own-denied`: role rules, write
 * permission); `own-none`, work bound to the person (an implementation) and they have no runner credential; `repo`, other ready runners
 * exclude its repo (My repos, write permission, item choices); `none`, no runner that takes work by itself is ready.
 */
export type RunnerWhy = "own-off" | "own-held" | "own-cooling" | "own-not-ready" | "own-denied" | "own-none" | "held" | "tier" | "repo" | "none";

/** `own`: the person has a live Task Runner credential, connected or not. `until`: when a held runner is free again, when reported. */
export type RunnerRoom =
  | { can: true; own: boolean }
  | { can: false; own: boolean; why: RunnerWhy; until: string | null; tier?: Tier };

/**
 * What is asked: work on `repo` that `login` started or approved. `tier` and `step`: of the call, when known. `refs`: the items, so the
 * people of work already started on them count; `started`: that work is in the reading already, so other runners' item choices apply as
 * they stand. Before that the item counts as about to be started work: a runner whose user takes only their own items does not take it.
 */
export type RoomAsk = {
  repo: string; login: string; tier?: Tier; step?: string; promptId?: string; refs?: readonly ItemRef[]; started?: boolean;
  /** Work bound to `login` (an implementation, src/implement/session.ts): only their runners and those of people who took the item's work (started.ts boundTakers) count. */
  bound?: true;
};

const OWN: Record<RunnerHold, RunnerWhy> = { offline: "own-off", "usage-limit": "own-held", "cooling-off": "own-cooling", "not-ready": "own-not-ready" };

export function runnerRoomIn(v: RemoteView, a: RoomAsk): RunnerRoom {
  const self = a.login.toLowerCase(), s = startedOf(v), canWrite = canWriteOf(v.snapshot);
  const call = { prompt_id: a.promptId ?? "", repos: [a.repo], ...(a.step !== undefined && { step: a.step }), ...(a.refs && { refs: a.refs }) };
  const tiered = { ...call, ...(a.tier && { tier: a.tier }) };
  const own = v.snapshot.runners.some((r) => r.login.toLowerCase() === self);
  const no = (why: RunnerWhy, until: number | null = null): RunnerRoom => ({ can: false, own, why, until: until === null ? null : new Date(until).toISOString(), ...(why === "tier" && a.tier && { tier: a.tier }) });
  const ownWhy = (): RunnerRoom => {
    // A fresh, ready runner of theirs that still cannot take it is kept off by the role rules or write permission.
    if (v.snapshot.runners.some((r) => r.login.toLowerCase() === self && r.role !== null && freshReady(v.snapshot, r, v.now))) return no("own-denied");
    const w = runnerHoldOf(v, self);
    return no(OWN[w.hold], w.until);
  };
  if (a.bound) {
    const took = a.refs?.length ? s.boundTakers({ prompt_id: call.prompt_id, refs: a.refs, forLogin: self, ...(a.tier && { tier: a.tier }) }) : new Set<string>();
    const runs = [self, ...took];
    if (runs.some((l) => s.canTake(l, tiered))) return { can: true, own };
    if (runs.some((l) => s.canTake(l, call))) return no("tier");
    return own ? ownWhy() : no("own-none");
  }
  const people = new Set([self, ...(a.refs ? s.ownersFor(tiered) : [])]);
  if ([...people].some((l) => s.canTake(l, tiered))) return { can: true, own };
  const theirs = (r: Runner): boolean => !people.has(r.login.toLowerCase()) && !settingsOf(v.snapshot, r.login).manualOnly && !(a.step === undefined && r.skip.size >= TASK_CHOICES.length);
  const takes = (r: Runner): boolean => theirs(r) && (a.started ? runnerTakes(r, call, canWrite) : settingsOf(v.snapshot, r.login).taskItems !== "mine" && runnerTakes({ ...r, items: null }, call, canWrite));
  const serves = (r: Runner): boolean => a.tier === undefined || r.tiers.has(a.tier);
  const ready = takersIn(v).filter(theirs);
  const forRepo = ready.filter(takes);
  if (forRepo.some(serves)) return { can: true, own };
  if (forRepo.length || [...people].some((l) => s.canTake(l, call))) return no("tier");
  const held = v.snapshot.runners
    .filter((r) => r.role !== null && r.readiness === "quota-held" && r.reportedAt !== null && r.reportedAt >= v.now - STATUS_FRESH_MS)
    .map((r) => runnerOf(v, r)).filter((r) => takes(r) && serves(r));
  if (held.length) {
    const ends = held.flatMap((r) => (r.row.until !== null && Date.parse(r.row.until) > v.now ? [Date.parse(r.row.until)] : []));
    return no("held", ends.length ? Math.min(...ends) : null);
  }
  if (own) return ownWhy();
  return no(ready.length ? "repo" : "none");
}

/** RunnerRoom now, from one reading of the runners. */
export async function loadRunnerRoom(db: Db, a: RoomAsk, now: number = Date.now()): Promise<RunnerRoom> {
  return runnerRoomIn(await loadView(db, now), a);
}

/** The Connect page, where a person sets up a Task Runner, under the dashboard's public base URL. */
export const connectUrl = (): string => `${envVar("BASE_URL")?.replace(/\/+$/, "") ?? ""}/connect`;

/** What a notice is posted for, once per workflow: why no runner can take its work, with the tier for `tier`. */
const reasonOf = (room: Extract<RunnerRoom, { can: false }>): string => (room.why === "tier" ? `tier:${room.tier ?? ""}` : room.why);

/** A stalled call as stallNotices reads it (the sweep's queued call). */
export type StalledCall = { prompt_id: string; repos: readonly string[]; refs: readonly ItemRef[]; step: string; tier: Tier; /** The user a bound call (an implementation) runs for. */ forLogin: string | null };

/**
 * For calls no Task Runner can take (src/remote/takers.ts sweepTakers), the Task Runner line (runnerLine) in the chat of each live workflow
 * the calls work for, named by their role in the work (others read it too): the person a bound call runs for; else the first of the people
 * whose runners alone may take it, none of which can claim (src/remote/takers.ts waitingOnIn); else the person who approved the work, else
 * the one who started it. Once per workflow and reason, and not when the latest command on the item was answered with the same line. Work
 * only the automatic merge rule started tells nobody. Returns the number of notices written.
 */
export async function stallNotices(db: Db, v: RemoteView, calls: readonly StalledCall[]): Promise<number> {
  const refs = [...new Map(calls.flatMap((c) => c.refs).map((r) => [`${r.repo}#${r.number}`, r])).values()];
  if (!refs.length) return 0;
  const wfs = await loadPrWorkflows(db, refs);
  const work = new Map<number, { wf: NonNullable<ReturnType<typeof wfs.get>>; call: StalledCall }>();
  for (const c of calls) for (const r of c.refs) {
    const wf = wfs.get(`${r.repo}#${r.number}`);
    if (wf && !work.has(wf.id)) work.set(wf.id, { wf, call: c });
  }
  if (!work.size) return 0;
  const items = [...work.values()].map(({ wf }) => ({ repo: wf.repo, number: wf.number }));
  const [sent, events] = await db.together(() => Promise.all([loadNotices(db, [...work.keys()]), loadEvents(db, items, { lastPerRef: 1 })]));
  const connect = connectUrl();
  const out: (NewChatMessage & { kind: "notice"; workflowId: number })[] = [];
  for (const [id, { wf, call }] of work) {
    const approver = wf.approvedBy && wf.approvedBy !== RULE_STARTER ? wf.approvedBy : null;
    const starter = wf.startedBy !== RULE_STARTER ? wf.startedBy : null;
    if (!approver && !starter) continue;
    const person = call.forLogin ?? waitingOnIn(v, call)[0]?.login ?? approver ?? starter!;
    const whose = startedOf(v).roleOf(person, { refs: call.refs, repos: call.repos, step: call.step }) ?? "taker";
    const repo = call.repos[0] ?? wf.repo;
    const room = runnerRoomIn(v, { repo, login: person, tier: call.tier, step: call.step, promptId: call.prompt_id, refs: call.refs, started: true, ...(call.forLogin && { bound: true as const }) });
    if (room.can) continue;
    const reason = reasonOf(room);
    if (sent.get(id)?.some((n) => n.reason === reason)) continue;
    const line = runnerLine(room, repo, connect, undefined, whose);
    const told = runnerLine(room, repo, connect);
    if (!line || (told && events.get(`${wf.repo}#${wf.number}`)?.at(-1)?.line?.includes(told))) continue;
    out.push({ repo: wf.repo, number: wf.number, author: CHAT_AUTHOR, via: "autocraft", kind: "notice", body: line, payload: { workflowId: id, reason }, workflowId: id });
  }
  return await recordNotices(db, out);
}
