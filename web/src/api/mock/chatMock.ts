// Item conversations on fake data: three items told as one stream each (what people said, what AutoCraft answered and did, and
// GitHub activity around it). The chat read folds the GitHub activity into one line per run; the trace read (Events) lists all of it.
import type { ChatEntry, ChatFinding, ChatShot, ChatVia, ItemChat, ItemChatState, ItemConversation } from "../types";
import type { Api } from "../client";
import type { AgentRunDetail, TraceEvent, TraceKind, User } from "../types";
import { NOW } from "./fixtures";

const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
const hhmm = () => new Date(NOW).toISOString().slice(11, 16);
const wait = <T,>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

type Work = { state?: "done" | "running" | "failed"; title: string; model?: string; seconds?: number; costUsd?: number; outcome?: string; detail?: [string, string][]; kind: TraceKind; run?: number; tokens?: [number, number]; tools?: number; shots?: ChatShot[] };
type Beat =
  | { b: "said"; min: number; login: string; via: ChatVia; body: string; pending?: boolean; refusal?: string; withdrawnBy?: string }
  | { b: "reply"; min: number; body: string; findings?: ChatFinding[]; ask?: { to: string[]; question: string } }
  | ({ b: "work"; min: number } & Work)
  | { b: "gh"; min: number; actor: string; summary: string; body?: string }
  | { b: "discord"; min: number; channel: string | null }
  | { b: "plan"; min: number; summary: string; fields: Record<string, unknown> };

/** Queued work about the item; `viewer`: the line a viewer reads, when it names a person's Task Runner. */
type Queued = { title: string; min: number; why: string | null; viewer?: string };
/** `quiet`: a quiet security pull request, which viewers see veiled (who and when only). */
/** `startedBy` and `takenBy`: who started the live work, and whose Task Runners were taken onto it (take / release). */
interface Story { title: string; status: string; state: ItemChatState; next: string | null; working: string | null; quiet?: boolean; queued?: Queued[]; startedBy?: string; takenBy?: string[]; beats: Beat[] }

const SAID_ON: Record<ChatVia, string> = { dashboard: "the dashboard", github: "GitHub", discord: "Discord", agent: "an agent", cli: "the command line" };

// ---- photocraft#812: started with "review", two problems found, "yes", fixed, CI fixed, merged ----
const PR_812: Story = {
  title: "Review",
  status: "Merged into main, approved by ochre-fox",
  state: "done",
  next: null,
  working: null,
  beats: [
    { b: "gh", min: 26 * 60, actor: "larkspur-dev", summary: "Opened the pull request" },
    { b: "gh", min: 26 * 60 - 9, actor: "github-actions", summary: "CI passed on 4e1a2b7 (5 checks)" },
    { b: "said", min: 300, login: "ochre-fox", via: "dashboard", body: "review" },
    { b: "reply", min: 300, body: "Reviewing photocraft#812, then I'll come back with the result. Reply **hold** to stop." },
    { b: "plan", min: 299, summary: "Plan started as reviewing", fields: { from: null, to: "reviewing", wait: null, reasons: ["started by ochre-fox"] } },
    { b: "work", min: 298, kind: "model-call", run: 7101, title: "Reviewed the diff and the crop module", model: "Opus", seconds: 130, costUsd: 0.21, outcome: "take with two fixes", tokens: [41_800, 2_600], tools: 9,
      detail: [["Commit", "4e1a2b7"], ["Read", "crates/crop/src/handles.rs, crates/crop/src/viewport.rs"]] },
    { b: "work", min: 295, kind: "write", title: "Posted the review on GitHub", outcome: "review comment", detail: [["As", "AutoCraft Bot"]] },
    { b: "reply", min: 295, body: "The fix is right for the canvas edge at 100 %, but I found two problems:",
      findings: [
        { n: 1, title: "Handles still snap past the edge when the canvas is zoomed below 100 %: the clamp uses screen pixels, not canvas units.", file: "crates/crop/src/handles.rs:142", major: false },
        { n: 2, title: "No test covers the clamped position.", file: "crates/crop/tests/handles.rs", major: false },
      ],
      ask: { to: ["ochre-fox"], question: "Fix both, then merge?" } },
    { b: "discord", min: 281, channel: "photocraft-dev" },
    { b: "discord", min: 274, channel: "photocraft-dev" },
    { b: "gh", min: 270, actor: "kiri-n", summary: "Commented", body: "Nice catch on the zoom case, I hit that last week." },
    { b: "gh", min: 262, actor: "larkspur-dev", summary: "Commented", body: "Thanks! Happy for the fixes to go in on my branch." },
    { b: "said", min: 241, login: "ochre-fox", via: "github", body: "@autocraft yes" },
    { b: "reply", min: 241, body: "Fixing both problems, then merging when CI is green (answered by ochre-fox). Reply **hold** to stop." },
    { b: "work", min: 239, kind: "model-call", run: 7102, title: "Fixed both problems", model: "Sonnet", seconds: 270, costUsd: 0.38, outcome: "pushed 1 commit (9c0d3e1)", tokens: [36_200, 4_100], tools: 14,
      detail: [["Changed", "crates/crop/src/handles.rs, crates/crop/tests/handles.rs"], ["Checks", "cargo test -p crop: 31 passed"]] },
    { b: "gh", min: 233, actor: "github-actions", summary: "CI failed on 9c0d3e1: clippy" },
    { b: "work", min: 231, kind: "model-call", run: 7103, title: "Fixed CI: a clippy warning", model: "Sonnet", seconds: 65, costUsd: 0.06, outcome: "pushed 1 commit (a7f2c10)", tokens: [9_400, 600], tools: 4,
      detail: [["Warning", "clippy::manual_clamp in handles.rs:148"]] },
    { b: "gh", min: 222, actor: "github-actions", summary: "CI passed on a7f2c10 (5 checks)" },
    { b: "work", min: 221, kind: "review", run: 7104, title: "Checked the final diff before merging", model: "Opus", seconds: 80, costUsd: 0.14, outcome: "clean", tokens: [22_000, 900], tools: 3 },
    { b: "work", min: 224, kind: "write", title: "Edited comment", outcome: "status comment", detail: [["As", "AutoCraft Bot"]] },
    { b: "work", min: 223, kind: "write", title: "Edited comment", outcome: "status comment", detail: [["As", "AutoCraft Bot"]] },
    { b: "work", min: 222, kind: "write", title: "Edited comment", outcome: "status comment", detail: [["As", "AutoCraft Bot"]] },
    { b: "work", min: 221, kind: "write", title: "Edited comment", outcome: "status comment", detail: [["As", "AutoCraft Bot"]] },
    { b: "work", min: 220, kind: "write", title: "Edited comment", outcome: "status comment", detail: [["As", "AutoCraft Bot"]] },
    { b: "work", min: 219, kind: "write", title: "Merged into main", outcome: "squash merge, a7f2c10", detail: [["As", "ochre-fox (approved the merge)"]] },
    { b: "work", min: 212, kind: "model-call", run: 7105, title: "Post-merge review of AutoCraft's changes", model: "Opus", seconds: 95, costUsd: 0.12, outcome: "no issues", tokens: [19_500, 700], tools: 2 },
    { b: "reply", min: 211, body: "Merged into main with both fixes. The post-merge review of my changes found nothing." },
  ],
};

// ---- designcraft#455: two maintainers, one on GitHub and one in the dashboard; a question is open ----
const PR_455: Story = {
  title: "Review",
  status: "Waiting for kiri-n or ochre-fox to answer",
  state: "waiting",
  next: "fix the hidden-group case, then merge",
  working: null,
  quiet: true,
  queued: [{ title: "Duplicates", min: 9, why: "Every Task Runner that may take it is busy" }, { title: "Classify", min: 4, why: "No Task Runner takes Classify tasks on designcraft" }],
  beats: [
    { b: "gh", min: 2 * 1440, actor: "sable-ui", summary: "Opened the pull request" },
    { b: "gh", min: 2 * 1440 - 11, actor: "github-actions", summary: "CI passed on 2c9e4f1 (6 checks)" },
    { b: "said", min: 185, login: "kiri-n", via: "github", body: "@autocraft review this, and check that locked layers still snap." },
    { b: "reply", min: 185, body: "Reviewing designcraft#455, and checking that locked layers still snap. I'll come back with the result." },
    { b: "plan", min: 184, summary: "Plan started as reviewing", fields: { from: null, to: "reviewing", wait: null, reasons: ["started by kiri-n"] } },
    { b: "work", min: 182, kind: "model-call", run: 7201, title: "Reviewed the diff", model: "Opus", seconds: 182, costUsd: 0.27, outcome: "take with one fix", tokens: [52_300, 3_100], tools: 12,
      detail: [["Commit", "2c9e4f1"], ["Read", "crates/snap/src/targets.rs, crates/snap/src/guides.rs and 12 renamed files"]] },
    { b: "work", min: 178, kind: "check", title: "Ran the snap tests in a workspace", seconds: 160, outcome: "41 passed", detail: [["Command", "cargo test -p snap"], ["Workspace", "designcraft at 2c9e4f1"]] },
    { b: "work", min: 176, kind: "write", title: "Posted the review on GitHub", outcome: "review comment" },
    { b: "reply", min: 176, body: "Locked layers still snap: `locked_layer_snaps` covers it and passes. One problem:",
      findings: [{ n: 1, title: "Hidden layers inside a hidden group are still offered as snap targets: the filter checks the layer, not its parents.", file: "crates/snap/src/targets.rs:57", major: true }],
      ask: { to: ["kiri-n"], question: "Fix the hidden-group case, then merge?" } },
    { b: "discord", min: 150, channel: "designcraft-reviews" },
    { b: "gh", min: 120, actor: "sable-ui", summary: "Commented", body: "The SnapSource → SnapTarget rename was asked for in #430, that's why it's in here." },
    { b: "said", min: 52, login: "ochre-fox", via: "dashboard", body: "ask does the rename touch the plugin API?", withdrawnBy: "ochre-fox" },
    { b: "said", min: 44, login: "ochre-fox", via: "dashboard", body: "ask is the rename needed for this fix, or can it go in a separate PR?" },
    { b: "work", min: 43, kind: "model-call", run: 7202, title: "Answered from the review", model: "Opus", seconds: 18, costUsd: 0.03, tokens: [14_100, 420], tools: 0 },
    { b: "reply", min: 43, body: "The fix doesn't need it: only `targets.rs` and its test change behaviour. The rename touches 14 files and was asked for in designcraft#430, so I'd keep it in this PR.", ask: { to: ["kiri-n", "ochre-fox"], question: "Fix the hidden-group case, then merge, rename included?" } },
    { b: "gh", min: 31, actor: "github-actions", summary: "CI passed on 2c9e4f1 (re-run)" },
    { b: "said", min: 26, login: "kiri-n", via: "github", body: "@autocraft merge after the 2.4 release" },
    { b: "reply", min: 26, body: "I understood **merge**, but not “after the 2.4 release”: I can't wait for a release. Nothing runs until the instruction is clear.", ask: { to: ["kiri-n", "ochre-fox"], question: "Fix the hidden-group case, then merge, rename included?" } },
  ],
};

// ---- deckcraft#77: an issue someone asked to implement; in progress ----
const ISSUE_77: Story = {
  title: "Implement",
  status: "Running the full test suite in a workspace",
  state: "running",
  next: "open a PR and review it, then ask ochre-fox before merging",
  working: "Running the full test suite in the workspace",
  startedBy: "ochre-fox",
  takenBy: [],
  queued: [
    { title: "Verify", min: 5, why: "Waiting for another job on this item" },
    { title: "Review", min: 3, why: "Waiting for ochre-fox's Task Runner (usage limit until 05:10 UTC)", viewer: "Waiting for a Task Runner" },
  ],
  beats: [
    { b: "gh", min: 3 * 1440, actor: "brushstroke42", summary: "Opened the issue" },
    { b: "gh", min: 2 * 1440, actor: "quietgrid", summary: "Commented", body: "Would love this for conference talks." },
    { b: "said", min: 96, login: "ochre-fox", via: "discord", body: "/autocraft implement, high" },
    { b: "reply", min: 96, body: "Implementing deckcraft#77 at high weight: I'll plan it, build it in a workspace, open a PR and review it, then come back to you before merging. Reply **hold** to stop." },
    { b: "plan", min: 95, summary: "Plan started as implementing", fields: { from: null, to: "implementing", wait: "a workspace", reasons: ["started by ochre-fox", "weight high"] } },
    { b: "work", min: 94, kind: "model-call", run: 7301, title: "Planned the change", model: "Opus", seconds: 160, costUsd: 0.31, outcome: "3 files", tokens: [38_900, 2_200], tools: 10,
      detail: [["Plan", "PDF export: a notes page after each slide, with an option in the export dialog; PPTX export keeps the notes"]] },
    { b: "reply", min: 91, body: "Plan: PDF export gets a notes page after each slide, switched on in the export dialog; PPTX export keeps the notes it drops today. It touches `export/pdf.rs`, `export/pptx.rs` and the export dialog." },
    { b: "work", min: 90, kind: "job", title: "Started a workspace", seconds: 110, outcome: "deckcraft at 81c2e0a", detail: [["Image", "toolchain, warm cache"]] },
    { b: "work", min: 87, kind: "model-call", run: 7302, title: "Wrote the export code", model: "Sonnet", seconds: 552, costUsd: 0.84, outcome: "4 files, 212 lines", tokens: [88_400, 9_700], tools: 37,
      detail: [["Changed", "crates/export/src/pdf.rs, crates/export/src/pptx.rs, crates/ui/src/export_dialog.rs, crates/export/tests/notes.rs"]] },
    { b: "work", min: 76, kind: "check", state: "failed", title: "Ran the export tests", seconds: 95, outcome: "58 passed, 1 failed", detail: [["Command", "cargo test -p export"], ["Failed", "notes_page_wraps_long_text"]] },
    { b: "gh", min: 74, actor: "brushstroke42", summary: "Commented", body: "Notes should use the slide's font if possible." },
    { b: "work", min: 72, kind: "model-call", run: 7303, title: "Fixed the failing notes-layout test", model: "Sonnet", seconds: 140, costUsd: 0.12, outcome: "1 file", tokens: [21_000, 1_300], tools: 8 },
    { b: "work", min: 70, kind: "check", title: "Took screenshots of the export dialog and a notes page", seconds: 48, outcome: "2 screens, as planned",
      detail: [["Commit", "c41d9e2"]],
      shots: [
        { label: "Export dialog, before", taskId: 9101, name: "export-dialog.png" }, { label: "Export dialog, after", taskId: 9102, name: "export-dialog.png" },
        { label: "Notes page, before", taskId: 9103, name: "notes-page.png" }, { label: "Notes page, after", taskId: 9104, name: "notes-page.png" },
      ] },
    { b: "work", min: 6, kind: "check", state: "running", title: "Running the full test suite in the workspace", detail: [["Command", "cargo test --workspace"], ["Workspace", "deckcraft at 81c2e0a + 2 commits"]] },
    { b: "said", min: 3, login: "kiri-n", via: "dashboard", body: "ask does the notes page keep the slide's font when the font is missing on the machine?", pending: true },
  ],
};

// ---- photocraft#8455: approved and merged; the post-merge review found a defect, which paused photocraft's merges ----
const PR_8455: Story = {
  title: "Merge queue",
  status: "Merged into main, approved by ochre-fox",
  state: "done",
  next: null,
  working: null,
  beats: [
    { b: "gh", min: 30 * 60, actor: "kiri-n", summary: "Opened the pull request" },
    { b: "said", min: 26 * 60, login: "ochre-fox", via: "github", body: "@autocraft merge" },
    { b: "reply", min: 26 * 60, body: "Queued photocraft#8455 to merge when CI is green (approved by ochre-fox). Reply **hold** to stop." },
    { b: "work", min: 25 * 60, kind: "write", title: "Updated the branch from main", outcome: "merge commit 5b2e7f0", detail: [["As", "AutoCraft Bot"]] },
    { b: "gh", min: 25 * 60 - 12, actor: "github-actions", summary: "CI passed on 5b2e7f0 (5 checks)" },
    { b: "work", min: 25 * 60 - 14, kind: "write", title: "Merged into main", outcome: "squash merge, 5b2e7f0", detail: [["As", "ochre-fox (approved the merge)"]] },
    { b: "work", min: 25 * 60 - 30, kind: "model-call", run: 7120, title: "Post-merge review of AutoCraft's changes", model: "Opus", seconds: 110, costUsd: 0.15, outcome: "1 defect", tokens: [24_300, 1_100], tools: 4 },
    { b: "reply", min: 25 * 60 - 31, body: "The post-merge review found a defect in the branch update:",
      findings: [{ n: 1, title: "The merge from main dropped the histogram cache reset in the document-close path, so a reopened document shows the old histogram.", file: "crates/histogram/src/cache.rs:88", major: true }] },
  ],
};

const STORIES: Record<string, Story> = { "photocraft#812": PR_812, "designcraft#455": PR_455, "deckcraft#77": ISSUE_77, "photocraft#8455": PR_8455 };

export const CHAT_ITEMS = new Set(Object.keys(STORIES));

const discordUrl = (i: number) => `https://discord.com/channels/1/2/${1000 + i}`;
const traceId = (ref: string, i: number, w?: Work) => (w?.run ? `run:${w.run}` : `${ref}:${i}`);

/** A viewer's copy of a quiet pull request's entry: who and when stay; words, findings, models and outcomes go. */
function veil(e: ChatEntry): ChatEntry {
  if (e.t === "said") return { ...e, body: "", ...(e.refusal ? { refusal: "" } : {}) };
  if (e.t === "reply") return { ...e, body: "", findings: [], ask: e.ask ? { ...e.ask, question: "" } : null };
  if (e.t === "work") return { t: "work", id: e.id, at: e.at, state: e.state, title: "AutoCraft work", model: null, seconds: e.seconds, costUsd: null, outcome: null, detail: [], eventId: e.eventId };
  return e;
}

/** The chat read of one story: GitHub activity between two chat entries folds into one line. */
function chatOf(ref: string, s: Story, me: User): ItemConversation {
  const entries: ChatEntry[] = [];
  s.beats.forEach((x, i) => {
    const id = `${ref}:${i}`;
    if (x.b === "plan") return;
    if (x.b === "discord") {
      const link = { url: discordUrl(i), at: at(x.min), channel: x.channel };
      const prev = entries[entries.length - 1];
      if (prev?.t === "discord") prev.links.push(link);
      else entries.push({ t: "discord", id, at: at(x.min), links: [link] });
      return;
    }
    if (x.b === "gh") {
      const last = entries[entries.length - 1];
      const line = `${x.actor}: ${x.summary.toLowerCase()}${x.body ? `: “${x.body}”` : ""}`;
      if (last?.t === "github") last.lines.push(line);
      else entries.push({ t: "github", id, at: at(x.min), lines: [line] });
      return;
    }
    if (x.b === "said") entries.push({ t: "said", id, at: at(x.min), login: x.login, via: x.via, body: x.body, url: x.via === "github" ? `https://github.com/storytold/${ref.replace("#", "/pull/")}` : null,
      ...(x.pending ? { pending: true, ...(me.role === "operator" || x.login === me.login ? { canWithdraw: true } : {}) } : {}), ...(x.refusal ? { refusal: x.refusal } : {}), ...(x.withdrawnBy ? { withdrawnBy: x.withdrawnBy } : {}) });
    else if (x.b === "reply") entries.push({ t: "reply", id, at: at(x.min), body: x.body, findings: x.findings ?? [], ask: x.ask ?? null });
    else entries.push({ t: "work", id, at: at(x.min), state: x.state ?? "done", title: x.title, model: x.model ?? null, seconds: x.seconds ?? null, costUsd: x.costUsd ?? null, outcome: x.outcome ?? null, detail: x.detail ?? [], eventId: traceId(ref, i, x), ...(x.shots ? { shots: x.shots } : {}) });
  });
  const lastReply = [...entries].reverse().find((e) => e.t === "reply" || e.t === "said");
  const open = lastReply?.t === "reply" && lastReply.ask ? lastReply.ask : null;
  const [repo, num] = ref.split("#");
  const veiled = s.quiet && me.role === "viewer";
  const queued = veiled ? [] : (s.queued ?? []).map((q, i) => ({ id: `${ref}:q${i}`, title: q.title, since: at(q.min), why: me.role === "viewer" && q.viewer ? q.viewer : q.why }));
  return { id: `${ref}:main`, title: s.title, item: { repo: repo!, number: Number(num) }, entries: veiled ? entries.map(veil) : entries, open: veiled && open ? { ...open, question: "" } : open, canReply: me.role !== "viewer", working: s.working, queued, runner: runnerOf(s, me, queued.length > 0) };
}

/** The reader's Task Runner on the story's live work, as the server's item chat gives it. */
function runnerOf(s: Story, me: User, queued: boolean): ItemConversation["runner"] {
  if (!s.startedBy || me.role === "viewer") return null;
  const taken = s.takenBy ?? [];
  const action = taken.includes(me.login) ? "release" : queued && me.login !== s.startedBy ? "take" : null;
  return action || taken.length ? { action, on: taken } : null;
}

/** Every beat of a story as trace events, for the Events tab. */
function traceOf(ref: string, s: Story): TraceEvent[] {
  return s.beats.map((x, i): TraceEvent => {
    const base = { at: at(x.min), head: null };
    if (x.b === "discord") return { ...base, id: traceId(ref, i), kind: "discord", actor: { type: "step", name: "Discord" }, summary: `Mentioned on Discord${x.channel ? ` in #${x.channel}` : ""}`, ref: { url: discordUrl(i) } };
    if (x.b === "gh") return { ...base, id: traceId(ref, i), kind: "github", actor: { type: x.actor === "github-actions" ? "step" : "person", name: x.actor }, summary: x.body ? `${x.summary}: ${x.body}` : x.summary, ref: {} };
    if (x.b === "said") return { ...base, id: traceId(ref, i), kind: "conversation", actor: { type: "person", name: x.login }, summary: `${x.body} (on ${SAID_ON[x.via]})`, ref: {} };
    if (x.b === "reply") return { ...base, id: traceId(ref, i), kind: x.ask ? "decision" : "conversation", actor: { type: "step", name: "AutoCraft" }, summary: x.body.split("\n")[0]!.replace(/\*\*/g, ""), ref: {} };
    if (x.b === "plan") return { ...base, id: traceId(ref, i), kind: "plan", actor: { type: "step", name: "Planner" }, summary: x.summary, ref: {} };
    const summary = x.outcome ? `${x.title}: ${x.outcome}` : x.title;
    const actor = { type: x.model ? "model" : "step", name: x.model?.toLowerCase() ?? "AutoCraft" } as const;
    if (x.kind === "model-call" && x.run)
      return { ...base, id: traceId(ref, i, x), kind: "model-call", actor, summary, ref: { runId: x.run, jobId: x.run - 6000 },
        call: { step: x.title, model: x.model!.toLowerCase(), provider: "claude", state: x.state === "running" ? "running" : "done", inputTokens: x.tokens?.[0] ?? null, outputTokens: x.tokens?.[1] ?? null, costUsd: x.costUsd ?? null, toolCalls: x.tools ?? 0, endedAt: x.seconds ? new Date(NOW - x.min * 60_000 + x.seconds * 1000).toISOString() : null } };
    if (x.kind === "review" && x.run) return { ...base, id: traceId(ref, i, x), kind: "review", actor, summary, ref: { reviewId: `opus:${x.run}`, runIds: [x.run] }, costUsd: x.costUsd ?? null };
    return { ...base, id: traceId(ref, i, x), kind: x.kind, actor, summary, ref: {} };
  });
}

function fieldsOf(ref: string, id: string): Record<string, unknown> | null {
  const s = STORIES[ref];
  if (!s) return null;
  const i = s.beats.findIndex((x, n) => traceId(ref, n, x.b === "work" ? x : undefined) === id);
  const x = s.beats[i];
  if (!x) return null;
  if (x.b === "plan") return x.fields;
  if (x.b === "said") return { text: x.body, via: SAID_ON[x.via] };
  if (x.b === "reply") return { text: x.body.replace(/\*\*/g, ""), findings: x.findings?.length ?? 0, question: x.ask?.question ?? null, asks: x.ask?.to.join(", ") ?? null };
  if (x.b === "work") {
    if (x.kind === "review") return { verdict: "take", sure: true, reason: "The final diff matches what was approved, plus the two fixes and the clippy fix." };
    return { outcome: x.outcome ?? null, state: x.state ?? "done", ...Object.fromEntries(x.detail ?? []) };
  }
  return null;
}

/** Trace reads for the chat items; null for other items. */
export function chatTrace(repo: string, number: number): TraceEvent[] | null {
  const ref = `${repo}#${number}`;
  const s = STORIES[ref];
  return s ? traceOf(ref, s).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) : null;
}

export function chatTraceFields(repo: string, number: number, id: string) {
  return fieldsOf(`${repo}#${number}`, id);
}

/** Run detail for the model calls of the chat items. */
export function chatRunDetail(id: number): AgentRunDetail | null {
  for (const [ref, s] of Object.entries(STORIES)) {
    const e = traceOf(ref, s).find((x) => x.ref.runId === id || x.ref.runIds?.includes(id));
    if (!e) continue;
    const x = s.beats.find((b) => b.b === "work" && b.run === id) as (Work & { min: number }) | undefined;
    const text = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1} of the model text for “${x?.title ?? e.summary}”.`).join("\n");
    return {
      id, jobId: id - 6000, step: x?.title ?? e.summary, stage: 5, promptId: "item.chat", promptVersion: "a1b2c3d", provider: "claude", model: (x?.model ?? "opus").toLowerCase(),
      items: [], itemCount: 1, state: x?.state === "running" ? "running" : "done", startedAt: e.at, endedAt: e.call?.endedAt ?? e.at,
      inputTokens: x?.tokens?.[0] ?? null, outputTokens: x?.tokens?.[1] ?? null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: x?.costUsd ?? null, summary: null,
      prompt: text(30), output: text(12), error: null, tools: [],
    };
  }
  return null;
}

export function createChatMock(me: User, changed: () => void): Pick<Api, "itemChat"> {
  const stories: Record<string, Story> = structuredClone(STORIES);
  const read = (repo: string, number: number): ItemChat => {
    const ref = `${repo}#${number}`;
    const s = stories[ref];
    return { repo, number, stamp: `mock:${s?.beats.length ?? 0}`, status: s?.status ?? "", state: s?.state ?? "idle", next: s?.next ?? null, conversations: s ? [chatOf(ref, s, me)] : [] };
  };
  return {
    itemChat: {
      get: (repo, number) => wait(read(repo, number)),
      async send(repo, number, _conversation, text) {
        let line: string;
        const ref = `${repo}#${number}`;
        const s = stories[ref];
        if (!s) throw new Error(`No conversation on ${ref}.`);
        if (me.role === "viewer") throw new Error(`${me.login} has no write access to ${repo}.`);
        const word = text.trim().toLowerCase();
        const open = chatOf(ref, s, me).open;
        s.beats.push({ b: "said", min: 0, login: me.login, via: "dashboard", body: text.trim() });
        if (/^ask\s+(?!(?:the\s+)?author\b)\S/.test(word)) {
          // A question waits for Opus; the server answers it with no line.
          const said = s.beats.at(-1);
          if (said?.b === "said") said.pending = true;
          changed();
          return wait({ chat: read(repo, number), lines: [] }, 400);
        } else if (/^(yes|y|approve|lgtm|go)$/.test(word) && open) {
          s.beats.push({ b: "reply", min: 0, body: `Fixing the hidden-group case, then merging when CI is green, rename included (answered by ${me.login}). Reply **hold** to stop.` });
          s.beats.push({ b: "work", min: 0, kind: "model-call", run: 7290, state: "running", title: "Fixing the hidden-group case", model: "Sonnet" });
          s.status = `Fixing the hidden-group case, approved by ${me.login}`;
          s.state = "running";
          s.next = "merge when CI is green";
          s.working = "Fixing the hidden-group case";
          line = `Fixing the hidden-group case, then merging (answered by ${me.login}).`;
        } else if (word === "merge" && open) {
          // A refusal no workflow event carries: only the lines answer it.
          changed();
          return wait({ chat: read(repo, number), lines: [`Not merging ${ref}: CI failed on the last commit (clippy). Fix it first?`] }, 400);
        } else if ((word === "take" || word === "release") && s.startedBy) {
          const taken = s.takenBy ?? [];
          s.takenBy = word === "take" ? [...taken.filter((l) => l !== me.login), me.login] : taken.filter((l) => l !== me.login);
          line = word === "take"
            ? `Runs on ${me.login}'s Task Runner too (set by ${me.login}, ${hhmm()} UTC) while the Task Runners of the people who started or approved it are busy, away or held. Reply release to stop.`
            : `No longer runs on ${me.login}'s Task Runner (set by ${me.login}, ${hhmm()} UTC).`;
          s.beats.push({ b: "reply", min: 0, body: line });
        } else if (/^(hold|stop|pause|wait)$/.test(word)) {
          s.beats.push({ b: "reply", min: 0, body: `On hold (held by ${me.login}). I keep off it until someone replies **resume**.` });
          s.status = `Held by ${me.login}`;
          s.state = "held";
          s.next = null;
          s.working = null;
          line = `On hold (held by ${me.login}).`;
        } else {
          line = `Nothing runs: “${text.trim()}” is not a clear instruction.`;
          s.beats.push({ b: "reply", min: 0, body: `I couldn't read “${text.trim()}” as an instruction. Nothing runs until it is clear.`, ask: open ?? undefined });
        }
        changed();
        return wait({ chat: read(repo, number), lines: [line] }, 400);
      },
      async withdraw(repo, number) {
        const s = stories[`${repo}#${number}`];
        const beat = s?.beats.find((x): x is Extract<Beat, { b: "said" }> => x.b === "said" && !!x.pending);
        if (!beat) throw new Error("No message waits for Opus.");
        if (me.role !== "operator" && beat.login !== me.login) throw new Error("Only an operator, or the person who wrote it, withdraws a message.");
        beat.pending = false;
        beat.withdrawnBy = me.login;
        changed();
        return wait(read(repo, number), 300);
      },
    },
  };
}
