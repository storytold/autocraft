import type { Api } from "../client";
import type { PromptCheckReply, PromptInfo, PromptProblem, PromptRevisionInfo, PromptSaveBody, PromptSegment, RepoGuidance, User } from "../types";
import { CLAUDE_PROMPTS, GUIDANCE_PROMPTS, codeBody, promptsReport, sameTemplateOf, type ClaudePromptId } from "../../../../src/prompts/index.ts";
import { joinSegments, mergeEdit, segments, stripLocks } from "../../../../src/prompts/locks.ts";
import { lineDiff } from "../../../../src/prompts/diff.ts";
import { sha256Hex } from "../../../../src/prompts/sha256.ts";
import { NOW } from "./fixtures";

type Rev = PromptRevisionInfo & { body: string; follows: boolean };

const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const versionOf = (text: string) => sha256Hex(text).slice(0, 10);
const isClaude = (id: string): id is ClaudePromptId => id in CLAUDE_PROMPTS;

/** The code default with one editable line taken out (an older release) or a sentence added (an edit). */
function variant(id: ClaudePromptId, how: "older" | "edit" | "relock"): string {
  const segs = segments(codeBody(id))!;
  const at = segs.findIndex((s) => !s.locked && s.text.split("\n").length > 3);
  return joinSegments(segs.map((s, i) => {
    if (how === "relock") return s.locked && s.name === "output" ? { ...s, name: "format" } : s;
    if (i !== at) return s;
    const lines = s.text.split("\n");
    return how === "older"
      ? { ...s, text: lines.filter((_, k) => k !== lines.findLastIndex((l) => l.trim())).join("\n") }
      : { ...s, text: `${lines[0]}\nPrefer the smallest fix that keeps the reference behaviour; name the reference page section you checked.\n${lines.slice(1).join("\n")}` };
  }));
}

function seedPrompts(): Map<string, Rev[]> {
  const rev = (rev: number, kind: Rev["kind"], body: string, author: string, min: number, note: string, follows = false, fromRev: number | null = null): Rev =>
    ({ rev, kind, body, follows, author, at: ago(min), note, fromRev, active: false, version: versionOf(stripLocks(body)) });
  const m = new Map<string, Rev[]>();
  const opus = codeBody("review.opus");
  m.set("review.opus", [
    rev(3, "edit", variant("review.opus", "edit"), "kiri-n", 95, "Ask for the reference section checked"),
    rev(2, "edit", variant("review.opus", "edit").replace("name the reference page section you checked.", "keep it short."), "ochre-fox", 2900, "Prefer small fixes"),
    rev(1, "release", opus, "release", 2900, "Release default", true),
  ]);
  m.set("premerge.opus", [
    rev(2, "edit", variant("premerge.opus", "edit"), "ochre-fox", 4300, "Prefer small fixes before merge"),
    rev(1, "release", variant("premerge.opus", "older"), "release", 4300, "Release default", true),
  ]);
  m.set("fixup.patch", [
    rev(2, "edit", variant("fixup.patch", "relock"), "kiri-n", 7200, "Keep diffs minimal"),
    rev(1, "release", codeBody("fixup.patch"), "release", 7200, "Release default", true),
  ]);
  for (const list of m.values()) list[0]!.active = true;
  return m;
}

function seedGuidance(): Map<string, Rev[]> {
  const g = (rev: number, kind: Rev["kind"], body: string, author: string, min: number, note: string): Rev =>
    ({ rev, kind, body, follows: false, author, at: ago(min), note, fromRev: null, active: false, version: versionOf(body) });
  const m = new Map<string, Rev[]>([
    ["photocraft", [
      g(2, "edit", "- Layer and mask changes need a test that opens a saved document from `tests/fixtures/`.\n- Keep colour maths in `crates/color`; app code only calls it.\n- A change to keyboard shortcuts must match the shortcut table in `docs/shortcuts.md`.", "kiri-n", 180, "Shortcut table rule"),
      g(1, "edit", "- Layer and mask changes need a test that opens a saved document from `tests/fixtures/`.\n- Keep colour maths in `crates/color`; app code only calls it.", "ochre-fox", 5200, "First guidance"),
    ]],
    ["designcraft", [g(1, "edit", "- Every new panel uses theme tokens for colours and sizes.\n- Text layout changes need a screenshot of the sample document before and after.", "ochre-fox", 1500, "Theme tokens and screenshots")]],
  ]);
  for (const list of m.values()) list[0]!.active = true;
  return m;
}

function conflict(): Error {
  return Object.assign(new Error("409 someone saved a newer revision"), { status: 409 });
}

export function createPromptsMock(me: User, changed: () => void, wait: <T>(v: T, ms?: number) => Promise<T>): Pick<Api, "prompts" | "prompt" | "guidance"> {
  const prompts = seedPrompts();
  const guidance = seedGuidance();
  const mayEditBase = me.role === "operator" || (me.role === "maintainer" && me.runRepos.length > 0);
  const mayEditRepo = (repo: string) => me.role === "operator" || (me.role === "maintainer" && me.runRepos.includes(repo));
  const active = (list: Rev[] | undefined) => list?.find((r) => r.active) ?? null;
  const info = (list: Rev[] | undefined): Rev[] => list ?? [];
  const pub = ({ body: _b, follows: _f, ...r }: Rev): PromptRevisionInfo => r;

  /** The text form that runs, and whether a stored edit no longer fits the release's locked blocks. */
  function running(id: ClaudePromptId) {
    const a = active(prompts.get(id));
    if (!a || a.follows) return { body: codeBody(id), structureChanged: false };
    const merged = mergeEdit(codeBody(id), a.body);
    return { body: merged ?? codeBody(id), structureChanged: merged === null };
  }

  function promptInfo(base: PromptInfo): PromptInfo {
    const id = base.id;
    const a = active(prompts.get(id));
    const claude = isClaude(id);
    const run = claude ? running(id) : null;
    const defaultRev = a && !a.follows ? info(prompts.get(id)).find((r) => r.rev < a.rev && r.follows) : undefined;
    const segs: PromptSegment[] = run ? segments(run.body)! : [];
    return {
      ...base,
      template: run ? stripLocks(run.body) : base.template,
      segments: segs,
      edit: {
        rev: a?.rev ?? null,
        author: a?.author ?? null,
        following: !a || a.follows,
        newerDefault: claude && !!a && !a.follows && !!defaultRev && defaultRev.body !== codeBody(id),
        structureChanged: run?.structureChanged ?? false,
        mayEdit: mayEditBase && !(claude && sameTemplateOf(id)),
        guidanceSlot: (GUIDANCE_PROMPTS as readonly string[]).includes(id),
      },
    };
  }

  const report = () => {
    const r = promptsReport(null);
    return { ...r, prompts: r.prompts.map(promptInfo) };
  };
  const one = (id: string) => {
    const p = report().prompts.find((x) => x.id === id);
    if (!p) throw new Error(`404 no prompt ${id}`);
    return p;
  };
  const bodyAt = (id: string, rev: number | "release") => {
    if (rev === "release") return isClaude(id) ? codeBody(id) : "";
    const r = info(prompts.get(id)).find((x) => x.rev === rev);
    if (!r) throw new Error(`404 no revision ${rev}`);
    return r.body;
  };
  const noteProblems = (note: string): PromptProblem[] =>
    !note.trim() ? [{ where: "note", message: "a note saying why is required" }] : note.trim().length > 300 ? [{ where: "note", message: "the note is longer than 300 characters" }] : [];

  function checkPrompt(id: string, b: PromptSaveBody): PromptCheckReply {
    if (!isClaude(id)) return { ok: false, problems: [{ where: "prompt", message: "Jev prompts are edited with the Jev form" }], diff: [], version: "" };
    const now = stripLocks(running(id).body);
    const segs = segments(b.body);
    const code = segments(codeBody(id))!.filter((s) => s.locked);
    const problems: PromptProblem[] = [];
    if (!segs) problems.push({ where: "body", message: "the lock markers do not pair up" });
    else {
      const mine = segs.filter((s) => s.locked);
      if (mine.length !== code.length || mine.some((s, i) => s.name !== code[i]!.name || s.text !== code[i]!.text)) problems.push({ where: "locked blocks", message: "a locked block cannot be changed" });
      segs.forEach((s, i) => { if (!s.locked && s.text.includes("{{")) problems.push({ where: `editable text ${i + 1}`, message: "editable text cannot hold {{: placeholders are filled by code and stay in their locked blocks" }); });
      if (stripLocks(b.body) === now) problems.push({ where: "body", message: "the text is the same as the active revision's" });
    }
    problems.push(...noteProblems(b.note));
    const text = stripLocks(b.body);
    return { ok: !problems.length, problems, diff: lineDiff(now, text), version: versionOf(text) };
  }

  function push(map: Map<string, Rev[]>, key: string, r: Omit<Rev, "rev" | "active" | "at" | "version">, version: (body: string) => string) {
    const list = map.get(key) ?? [];
    for (const x of list) x.active = false;
    const next: Rev = { ...r, rev: (list[0]?.rev ?? 0) + 1, active: true, at: new Date().toISOString(), version: version(r.body) };
    map.set(key, [next, ...list]);
    changed();
  }

  /** A first save stores the release default as revision 1 first. */
  function ensureRelease(id: ClaudePromptId) {
    if (prompts.get(id)?.length) return;
    prompts.set(id, [{ rev: 1, kind: "release", body: codeBody(id), follows: true, author: "release", at: new Date().toISOString(), note: "Release default", fromRev: null, active: true, version: versionOf(stripLocks(codeBody(id))) }]);
  }

  const guidanceOf = (repo: string): RepoGuidance => {
    const list = info(guidance.get(repo));
    const a = active(list);
    return {
      repo, text: a?.body ?? "", rev: a?.rev ?? null, author: a?.author ?? null, at: a?.at ?? null, note: a?.note ?? null,
      prompts: [...GUIDANCE_PROMPTS], mayEdit: mayEditRepo(repo), history: list.map(pub),
    };
  };
  function checkGuidance(repo: string, b: PromptSaveBody): PromptCheckReply {
    const now = active(guidance.get(repo))?.body ?? "";
    const problems: PromptProblem[] = [];
    if (b.body.length > 4000) problems.push({ where: "guidance", message: "guidance is at most 4000 characters" });
    if (b.body.includes("{{")) problems.push({ where: "guidance", message: "editable text cannot hold {{" });
    if (b.body.trim() === now.trim()) problems.push({ where: "guidance", message: "the guidance is the same as the active revision's" });
    problems.push(...noteProblems(b.note));
    return { ok: !problems.length, problems, diff: lineDiff(now, b.body), version: versionOf(b.body) };
  }
  const refuse = (r: PromptCheckReply) => {
    if (!r.ok) throw new Error(`400 ${r.problems.map((p) => p.message).join("; ")}`);
  };
  const needBase = () => { if (!mayEditBase) throw new Error("403 only operators and maintainers who write a tracked repo edit prompts"); };
  const needRepo = (repo: string) => { if (!mayEditRepo(repo)) throw new Error("403 no write access to this repo"); };

  return {
    prompts: () => wait(report(), 60),
    prompt: {
      get: (id) => wait(one(id)),
      history: (id) => wait(info(prompts.get(id)).map(pub)),
      diff: (id, from, to) => wait(lineDiff(stripLocks(bodyAt(id, from)), stripLocks(bodyAt(id, to)))),
      check: (id, b) => wait(checkPrompt(id, b), 120),
      async save(id, b) {
        needBase();
        if (!isClaude(id)) throw new Error("400 Jev prompts are edited with the Jev form");
        if ((active(prompts.get(id))?.rev ?? null) !== b.baseRev) throw conflict();
        refuse(checkPrompt(id, b));
        ensureRelease(id);
        push(prompts, id, { kind: "edit", body: b.body, follows: false, author: me.login, note: b.note.trim(), fromRev: null }, (body) => versionOf(stripLocks(body)));
        return wait(one(id));
      },
      async rollback(id, { rev, note }) {
        needBase();
        const from = info(prompts.get(id)).find((r) => r.rev === rev);
        if (!from) throw new Error(`404 no revision ${rev}`);
        if (!note.trim()) throw new Error("400 a note saying why is required");
        push(prompts, id, { kind: "rollback", body: from.body, follows: from.follows, author: me.login, note: note.trim(), fromRev: rev }, (body) => versionOf(stripLocks(body)));
        return wait(one(id));
      },
      async useRelease(id, { note }) {
        needBase();
        if (!isClaude(id)) throw new Error("400 not a Claude prompt");
        if (!note.trim()) throw new Error("400 a note saying why is required");
        push(prompts, id, { kind: "use-release", body: codeBody(id), follows: true, author: me.login, note: note.trim(), fromRev: null }, (body) => versionOf(stripLocks(body)));
        return wait(one(id));
      },
    },
    guidance: {
      list: () => wait([...guidance.keys()].map(guidanceOf).filter((g) => g.text.trim())),
      get: (repo) => wait(guidanceOf(repo)),
      check: (repo, b) => wait(checkGuidance(repo, b), 120),
      async save(repo, b) {
        needRepo(repo);
        if ((active(guidance.get(repo))?.rev ?? null) !== b.baseRev) throw conflict();
        refuse(checkGuidance(repo, b));
        push(guidance, repo, { kind: "edit", body: b.body.trim(), follows: false, author: me.login, note: b.note.trim(), fromRev: null }, versionOf);
        return wait(guidanceOf(repo));
      },
      async rollback(repo, { rev, note }) {
        needRepo(repo);
        const from = info(guidance.get(repo)).find((r) => r.rev === rev);
        if (!from) throw new Error(`404 no revision ${rev}`);
        if (!note.trim()) throw new Error("400 a note saying why is required");
        push(guidance, repo, { kind: "rollback", body: from.body, follows: false, author: me.login, note: note.trim(), fromRev: rev }, versionOf);
        return wait(guidanceOf(repo));
      },
    },
  };
}
