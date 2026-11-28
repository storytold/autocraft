// Maintainer text to workflow actions: the parser and the resolver decide what runs, and anything unclear runs nothing.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describe as describe_, parse, parseComment } from "../src/workflow/parse.ts";
import { resolve, type ItemState } from "../src/workflow/resolve.ts";
import { recommendationLine, replyLine } from "../src/workflow/status.ts";
import type { ItemWorkflow, PlanPart, Recommendation } from "../src/workflow/types.ts";

const SLUG = "autocraft-bot";

const started = (over: Partial<ItemWorkflow> = {}): ItemWorkflow => ({
  id: 1, repo: "storytold/photocraft", number: 812, kind: "pr", entry: "review", weight: 5, state: "running", step: null,
  startedBy: "mira", startedAt: "2026-11-24T09:02:00Z", startedVia: "github", baseHead: "abc", acceptedHead: null, version: 0,
  approvedBy: null, approvedAt: null, approvedVia: null, stoppedBy: null, stoppedAt: null, takenBy: null, closedWaits: null,
  blocker: null, blockerParams: null, rec: null, recAt: null, recHead: null, plan: [], prNumber: null, reviewAskedAt: null, legacyPreapprovalId: null,
  updatedAt: "2026-11-24T09:02:00Z", ...over,
});
const part = (n: number, title: string): PlanPart => ({ n, title, source: "review", state: "planned" });
const pr = (workflow: ItemWorkflow | null = null): ItemState => ({ kind: "pr", workflow });
const run = (text: string, state: ItemState) => resolve(parse(text), state);

describe("workflow commands", () => {
  test("an item named inside words that were not read is not quoted back as a target", () => {
    const p = parse("please close this, it's related to #12", { repo: "photocraft" });
    assert.ok(p.kind === "ambiguous");
    assert.ok(!p.understood.includes("12"));
    assert.ok(p.rest.includes("#12"));
  });

  test("text that is not fully a command runs nothing and says what was understood", () => {
    const p = parse("fix-up and frobnicate");
    assert.equal(p.kind, "ambiguous");
    assert.ok(p.kind === "ambiguous" && p.understood.includes("fix-up") && p.rest.includes("frobnicate"));
    assert.equal(resolve(p, pr()).kind, "ambiguous");
    assert.equal(run("please merge it soon", pr()).kind, "ambiguous");
    assert.equal(run("weight 12, merge", pr()).kind, "ambiguous");
    assert.equal(run("review and implement", { kind: "pr", workflow: null }).kind, "ambiguous");
  });

  test("ordinary phrasing around command words reads as the command; hedged replies stay unread", () => {
    const words = (text: string) => { const p = parse(text, { slug: SLUG }); return p.kind === "commands" ? p.parts.map((x) => ("part" in x ? `${x.word} ${x.part}` : x.word)).join(",") : p.kind; };
    for (const [text, want] of [
      ["merge it", "merge"], ["please merge this", "merge"], ["ok go ahead and merge", "merge"], ["merge it please", "merge"], ["yes merge it", "merge"],
      ["LGTM, merge", "merge"], ["sounds good, merge it now", "merge"], ["fix-up and merge it", "fix-up,merge"], ["drop 2 and merge the rest", "drop 2,merge"],
      ["thanks, merge", "merge"], ["@autocraft-bot merge the PR", "merge"], ["go ahead", "yes"],
    ] as const) assert.equal(words(text), want, text);
    for (const text of ["don't merge it", "merge it but not yet", "no", "merge it later", "merge if CI is green", "yes?", "go ahead?", "merge it please soon"]) assert.equal(words(text), "ambiguous", text);
    const reply = (text: string, mention?: string) => { const r = resolve(parse(text), pr()); return r.kind === "ambiguous" ? replyLine(r, undefined, mention) : ""; };
    assert.match(reply("merge it but soon", "autocraft-bot"), /couldn't read/);
    assert.match(reply("let's review sometime", "autocraft-bot"), /I read this as `review`\. Reply `@autocraft-bot review`/);
    assert.match(reply("don't merge it"), /couldn't read.*Commands: review/);
  });

  test("a message that only says to hold is a hold; one that asks for something else or sets a condition is not", () => {
    for (const text of ["no, stop", "hold for now", "let's wait", "wait wait", "hold the merge", "stop. I will look"]) assert.deepEqual(parse(text), { kind: "commands", items: [], parts: [{ word: "hold" }] }, text);
    for (const text of ["don't stop", "stop. merge", "hold if CI fails", "hold. until Friday", "wait?", "hold, merge"]) assert.notEqual(run(text, pr()).kind, "run", text);
  });

  test("a yes beside a start word on a held item runs nothing: one goes on with the plan, the other drops it", () => {
    const held = { kind: "pr" as const, workflow: null, held: started({ state: "stopped", approvedBy: "mira" }) };
    for (const text of ["yes, merge", "yes and review", "go ahead and merge"]) {
      const r = run(text, held);
      assert.ok(r.kind === "ambiguous" && r.ambiguity.why === "conflict", text);
    }
    const alone = ["yes", "merge"].map((text) => run(text, held));
    assert.deepEqual(alone.map((r) => r.kind === "run" && [r.run.resume, r.run.start]), [["steps", null], [null, "merge"]]);
  });

  test("a comment that goes on with a condition is ambiguous; thanks and reasons don't matter, and a hold stands", () => {
    const kind = (body: string) => parseComment(body.replace("@", `@${SLUG} `), SLUG)?.kind;
    for (const body of ["@yes\n\nbut wait for CI", "@merge\nafter #12 merges", "@merge\n\nThanks! Only when Dylan has looked.", "@merge\n\nPlease don't merge it before Friday", "@review\nafter CI"]) assert.equal(kind(body), "ambiguous", body);
    // A condition every merge meets reads on a later line as it does beside the command.
    for (const body of ["@merge\nafter CI is green", "@merge\nafter CI", "@merge\n\nThanks! Only when the tests pass."]) assert.equal(kind(body), "commands", body);
    for (const body of ["@merge\n\nThanks, great work!", "@yes\nIt crashed when a file was empty. This does not.", "@merge\n\nFine.\n\nBut that is another issue.", "@hold\n\nuntil the release is out"]) assert.equal(kind(body), body.startsWith("@yes") ? "yes" : "commands", body);
  });

  test("combined commands and a weight word anywhere", () => {
    const p = parse("@autocraft-bot fix-up and merge, urgent", { slug: SLUG });
    assert.deepEqual(p, { kind: "commands", items: [], parts: [{ word: "fix-up" }, { word: "merge" }, { word: "weight", weight: 10 }] });
    const r = resolve(p, pr());
    assert.ok(r.kind === "run" && r.run.start === "fixup" && r.run.approve && r.run.weight === 10);
  });

  test("quoted, fenced and commented commands run nothing", () => {
    assert.equal(parseComment(`> @${SLUG} merge`, SLUG), null);
    assert.equal(parseComment(["```", `@${SLUG} merge`, "```"].join("\n"), SLUG), null);
    assert.equal(parseComment(`<!-- @${SLUG} merge -->`, SLUG), null);
    assert.equal(parseComment(`    @${SLUG} merge`, SLUG), null);
    assert.equal(parseComment(`Thanks!\n@${SLUG} merge\nLooks good.`, SLUG)?.kind, "commands");
  });

  test("a list after a colon: a bare number takes the repo before it", () => {
    const p = parseComment(`@${SLUG} merge:\nphotocraft#123\n#456 storytold/designcraft#7 8\n\nunrelated text`, SLUG);
    assert.deepEqual(p?.kind === "commands" && p.items, [
      { repo: "photocraft", number: 123 }, { repo: "photocraft", number: 456 },
      { repo: "storytold/designcraft", number: 7 }, { repo: "storytold/designcraft", number: 8 },
    ]);
    assert.equal(parse("merge: #12").kind, "ambiguous");
    assert.deepEqual((parse("merge: #12", { repo: "photocraft" }) as { items: unknown }).items, [{ repo: "photocraft", number: 12 }]);
  });

  test("items written inline, for surfaces without an item context", () => {
    const pc12 = { repo: "photocraft", number: 12 };
    assert.deepEqual(parse("merge photocraft#12"), { kind: "commands", items: [pc12], parts: [{ word: "merge" }] });
    assert.deepEqual(parse("photocraft#12 yes"), { kind: "yes", items: [pc12] });
    assert.deepEqual(parse("yes photocraft#12"), { kind: "yes", items: [pc12] });
    assert.deepEqual(parse("review photocraft#12 urgent"), { kind: "commands", items: [pc12], parts: [{ word: "review" }, { word: "weight", weight: 10 }] });
    const two = parse("fix-up and merge photocraft#12 and #14");
    assert.deepEqual(two.kind === "commands" && two.items, [pc12, { repo: "photocraft", number: 14 }]);
    assert.equal(parse("merge photocraft#12 junk").kind, "ambiguous");
    assert.equal(parse("merge #12").kind, "ambiguous");
    assert.equal(parse("merge 12", { repo: "photocraft" }).kind, "ambiguous");
    assert.deepEqual(parse("merge #12", { repo: "photocraft" }), { kind: "commands", items: [pc12], parts: [{ word: "merge" }] });
    // In an item's context a number after fix or drop is still a part of the plan, and autorepin keeps its argument.
    assert.deepEqual(parse("fix 1 and #2, drop #3", { repo: "photocraft" }), { kind: "commands", items: [], parts: [{ word: "fix", part: 1 }, { word: "fix", part: 2 }, { word: "drop", part: 3 }] });
    assert.deepEqual(parse("autorepin storytold/foo#3"), { kind: "commands", items: [], parts: [{ word: "autorepin", args: "storytold/foo#3" }] });
    assert.equal(parseComment(`> @${SLUG} merge photocraft#12`, SLUG), null);
  });

  test("drop by words must name exactly one planned part", () => {
    const wf = started({ state: "recommending", plan: [part(1, "Export dialog loses focus"), part(2, "Export dialog title typo"), part(3, "Unused import")] });
    const several = run("drop export dialog", pr(wf));
    assert.ok(several.kind === "ambiguous" && several.ambiguity.why === "part-matches-several");
    assert.equal(run("drop crash on save", pr(wf)).kind, "ambiguous");
    const one = run("drop title typo", pr(wf));
    assert.ok(one.kind === "run" && one.run.drop.includes(2) && one.run.drop.length === 1);
    const fix = run("fix 1 and 3, drop 2, then merge", pr(wf));
    assert.ok(fix.kind === "run" && fix.run.fix.join() === "1,3" && fix.run.drop.join() === "2" && fix.run.approve);
  });

  test("fix with words that name no part is the fix-up's instruction; part words stay parts; a bare fix fixes the review's finding", () => {
    const rec: Recommendation = { text: "The review says to hold it.", parts: { fix: [], drop: [] }, merges: false, again: "review" };
    const held = started({ state: "blocked", blocker: "failed-twice", approvedBy: "mira", plan: [part(1, "Export dialog title typo")], rec });
    // What the person wrote after fix, up to where the next command starts, is the instruction; the merge and weight beside it stay commands.
    for (const [text, said] of [
      ["fix the UV seam normals, then merge", "the UV seam normals"],
      ["fix: use the importer's welded normals for exports and merge", "use the importer's welded normals for exports"],
      ["please fix the normals from `Mesh::compute_normals` and the tangents, urgent", "the normals from `Mesh::compute_normals` and the tangents"],
      ["fix the crash from #12", "the crash from #12"],
    ] as const) {
      const r = run(text, pr(held));
      assert.ok(r.kind === "run" && r.run.again === "fixup" && r.run.instruction?.text === said && !r.run.instruction.review, `${text}: ${JSON.stringify(r)}`);
      assert.ok(r.run.merges, "the approval carries on");
      assert.ok(r.run.fix.includes(1), "with the parts the plan still has");
    }
    assert.deepEqual((parse("fix the crash from #12", { repo: "photocraft" }) as { items: unknown[] }).items, [], "an item inside the words is no target");
    // Words that match a part, part numbers and bare fixes are what they were.
    const typo = run("fix the title typo", pr(held));
    assert.ok(typo.kind === "run" && typo.run.instruction === null && typo.run.fix.join() === "1");
    for (const text of ["fix 1 and 2, drop 3, then merge", "fix the second one and merge", "fix all but 2", "fix it and merge", "fix them"]) {
      const p = parse(text);
      assert.ok(p.kind === "commands" && p.parts.every((x) => !("text" in x) || !x.text), text);
    }
    // Hedges, conditions and questions inside the words leave the message unread; a negation in them says what the code should do.
    for (const text of ["maybe fix the normals", "fix the normals?", "fix the normals unless it is slow", "fix the normals, maybe", "don't fix the normals"]) assert.equal(parse(text).kind, "ambiguous", text);
    for (const [text, said] of [
      ["fix the normals so they don't split", "the normals so they don't split"],
      ["fix the export so it does not drop normals", "the export so it does not drop normals"],
      ["implement: add a setting; it should default to off", "add a setting; it should default to off"],
    ] as const) {
      const p = parse(text);
      assert.ok(p.kind === "commands" && p.parts.some((x) => "text" in x && x.text === said), `${text}: ${JSON.stringify(p)}`);
    }
    // A bare fix where the review lists no fix: its finding is the instruction, and without one nothing runs.
    const finding = started({ ...held, plan: [], rec: { ...rec, finding: "Exports recompute normals without welding vertices split at UV seams." } });
    const bare = run("fix it", pr(finding));
    assert.ok(bare.kind === "run" && bare.run.instruction?.review && /UV seams/.test(bare.run.instruction.text));
    const none = run("fix", pr(started({ ...held, plan: [] })));
    assert.ok(none.kind === "ambiguous" && none.ambiguity.why === "nothing-to-fix");
    assert.match(replyLine(none), /nothing to fix/);
  });

  test("words after an entry word's colon are instructions only when nothing else reads them", () => {
    // Conditions, holds, refusals, weights, parts or items in view and doubts stay unread, as they were before instructions.
    for (const text of [
      "merge: wait for dylan", "merge: after CI is green", "merge: if CI passes", "merge: once CI is green", "merge: hold on", "merge: no", "merge: not yet",
      "merge: later", "merge: maybe", "merge: the rest", "merge: both", "merge: all of them", "merge: weight 7", "review: urgent", "review: these two",
      "implement: store it per document?",
    ]) {
      const p = parse(text, { repo: "photocraft" });
      assert.ok(p.kind === "ambiguous" && !p.understood.includes("fix"), `${text}: ${JSON.stringify(p)}`);
    }
    // Any item makes it the list form, which reports what it cannot read.
    const list = parse("merge: #12 and #15", { repo: "photocraft" });
    assert.ok(list.kind === "commands" && list.items.map((i) => i.number).join() === "12,15" && list.parts.map((x) => x.word).join() === "merge");
    for (const text of ["merge: photocraft#12, photocraft#15 urgent", "merge: photocraft#12 low", "merge: photocraft #12", "implement: like in #12"]) {
      const p = parse(text, { repo: "photocraft" });
      assert.ok(p.kind === "ambiguous" && p.understood.includes("photocraft#12") && !p.understood.includes("fix"), `${text}: ${JSON.stringify(p)}`);
    }
    // A colon inside a fix's words is theirs.
    const inside = parse("fix the importer: conflict markers left in Cargo.toml");
    assert.ok(inside.kind === "commands" && inside.parts.length === 1 && "text" in inside.parts[0]! && inside.parts[0].text === "the importer: conflict markers left in Cargo.toml");
    const cond = parse("merge: once dylan approves");
    assert.ok(cond.kind === "ambiguous" && cond.rest === "once dylan approves", "a leading once is a condition, whatever follows");
    const said = parse("implement: store it per document");
    assert.ok(said.kind === "commands" && said.parts.some((x) => x.word === "implement") && said.parts.some((x) => "text" in x && x.text === "store it per document"));
  });

  test("don't merge beside instructions counts only as their last clause", () => {
    for (const [text, said] of [["fix the seams but don't merge", "the seams"], ["fix the seams and don't merge it yet please", "the seams"], ["implement: store it per document. Then hold", "store it per document"]] as const) {
      const p = parse(text);
      assert.ok(p.kind === "commands" && p.parts.some((x) => x.word === "no-merge") && p.parts.some((x) => "text" in x && x.text === said), `${text}: ${JSON.stringify(p)}`);
    }
    // Inside a clause the instructions open, or before more of them, it may be about the code or the merge.
    for (const text of ["fix the import: when two rows share an id, don't merge.", "fix the seams, don't merge, and add a test", "fix the seams and don't merge it until Friday", "don't merge, fix the seams"]) {
      const p = parse(text);
      assert.ok(p.kind === "ambiguous" && /merge/.test(p.rest), `${text}: ${JSON.stringify(p)}`);
    }
    // Inside a sentence it is part of the instructions, where a merge conflict is code.
    const code = parse("fix the merge conflict markers so the build does not break");
    assert.ok(code.kind === "commands" && !code.parts.some((x) => x.word === "no-merge"));
  });

  test("instructions that talk about the merge or doubt the work leave the end open: nothing runs, and the reply offers both ends", () => {
    for (const text of [
      "fix the typo. Do not merge this one", "fix the typo; don't ship it yet", "fix the typo but don't land it", "fix the typo, I'll merge it myself",
      "fix the typo and leave it for me to merge", "fix the typo, keep it open", "fix the typo, but let me look before it goes in",
      "fix the typo but I'm not convinced we want this", "fix the typo, no rush", "fix: make sure we don't merge duplicate rows",
    ]) {
      const p = parse(text);
      assert.ok(p.kind === "ambiguous" && p.ends, `${text}: ${JSON.stringify(p)}`);
      const r = resolve(p, pr());
      assert.equal(r.kind, "ambiguous", text);
      const line = replyLine(r as Exclude<typeof r, { kind: "run" }>);
      assert.ok(line.includes(", then merge`") && line.includes(", but don't merge`"), line);
    }
    // The offer reads back as the fix with each end.
    const p = parse("fix the typo, I'll merge it myself");
    assert.ok(p.kind === "ambiguous" && p.ends === "fix the typo");
    for (const [reply, merges] of [["fix the typo, then merge", true], ["fix the typo, but don't merge", false]] as const) {
      const r = run(reply, pr());
      assert.ok(r.kind === "run" && r.run.instruction?.text === "the typo" && r.run.merges === merges, `${reply}: ${JSON.stringify(r)}`);
    }
    // A negation that says what the code should do leaves the default end.
    const keep = run("fix the export so it does not drop normals", pr());
    assert.ok(keep.kind === "run" && keep.run.merges);
  });

  test("first fix before a start, and then merge after instructions on an issue, read as written", () => {
    const first = run("review and merge, but first fix the typo in the README", pr());
    assert.ok(first.kind === "run" && first.run.start === "review" && first.run.approve && first.run.instruction?.text === "the typo in the README", JSON.stringify(first));
    const issue = run("fix the export so normals are kept, then merge", { kind: "issue", workflow: null });
    assert.ok(issue.kind === "run" && issue.run.start === "implement" && issue.run.approve && issue.run.instruction?.text === "the export so normals are kept", JSON.stringify(issue));
  });

  test("instructions on an issue start its implementation only with implement or fix; don't merge never takes back an approved merge", () => {
    const issue: ItemState = { kind: "issue", workflow: null };
    for (const text of ["implement: store it per document", "fix the crash on empty files"]) {
      const r = run(text, issue);
      assert.ok(r.kind === "run" && r.run.start === "implement" && r.run.approve && r.run.instruction !== null, `${text}: ${JSON.stringify(r)}`);
    }
    const merge = run("merge: store it per document", issue);
    assert.ok(merge.kind === "refused" && merge.refusal.why === "issue-merge-queue", JSON.stringify(merge));
    // A part named beside don't merge on an approved item: the merge would still run, so nothing does.
    const approved = started({ approvedBy: "mira", plan: [part(1, "UV seams")] });
    const back = run("fix the seams, don't merge", pr(approved));
    assert.ok(back.kind === "refused" && back.refusal.why === "merge-approved", JSON.stringify(back));
  });

  test("merge is the merge queue on an unstarted pull request and approval on a started item", () => {
    const fresh = run("merge", pr());
    assert.ok(fresh.kind === "run" && fresh.run.start === "merge" && fresh.run.approve);
    const going = run("merge", pr(started()));
    assert.ok(going.kind === "run" && going.run.start === null && going.run.approve && going.run.merges);
    assert.equal(run("merge", { kind: "issue", workflow: null }).kind, "refused");
  });

  test("the word merge on a recommendation runs it as a yes would, then merges", () => {
    const rec: Recommendation = { text: "Review it again, then merge.", parts: { fix: [], drop: [] }, merges: true, again: "review" };
    const wf = started({ state: "blocked", blocker: "failed-twice", rec, recAt: "2026-11-24T10:00:00Z" });
    for (const text of ["merge", "yes", "proceed", "ship"]) {
      const r = run(text, pr(wf));
      assert.ok(r.kind === "run" && r.run.again === "review" && r.run.approve && r.run.merges && r.run.answers, text);
    }
    // A question of the implementation is answered as a yes answers it.
    const answer = { question: { implementation: 1, round: 1 }, option: "retry" };
    const asked = run("merge", { kind: "issue", workflow: started({ kind: "issue", entry: "implement", state: "recommending", rec: { text: "Try again.", parts: { fix: [], drop: [] }, merges: true, answer } }) });
    assert.ok(asked.kind === "run" && asked.run.pick?.option === "retry" && asked.run.approve);
  });

  test("merge on a recommendation that fixes first makes the fixes, then merges; drop still drops", () => {
    const wf = started({ state: "recommending", plan: [part(1, "a"), part(2, "b")], recAt: "2026-11-24T10:00:00Z", rec: { text: "Fix 1 and 2, then merge.", parts: { fix: [1, 2], drop: [] }, merges: true } });
    const merge = run("merge", pr(wf));
    assert.ok(merge.kind === "run" && merge.run.again === "fixup" && merge.run.fix.join() === "1,2" && merge.run.approve && merge.run.merges, JSON.stringify(merge));
    const one = run("drop 2, merge", pr(wf));
    assert.ok(one.kind === "run" && one.run.fix.join() === "1" && one.run.drop.includes(2) && one.run.again === "fixup" && one.run.merges);
  });

  test("yes needs an open recommendation, and a yes to one ending in a merge approves it", () => {
    assert.equal(run("yes", pr(started())).kind, "ambiguous");
    const rec: Recommendation = { text: "Fix both problems, then merge?", parts: { fix: [1, 2], drop: [] }, merges: true };
    const r = run("LGTM, thanks!", pr(started({ state: "recommending", rec, plan: [part(1, "a"), part(2, "b")] })));
    assert.ok(r.kind === "run" && r.run.approve && r.run.answers && r.run.fix.join() === "1,2");
  });

  test("a close names its reason; the item it duplicates is no item of the command", () => {
    const of = (text: string, repo?: string) => { const p = parse(text, { slug: SLUG, ...(repo && { repo }) }); return p.kind === "commands" ? [describe_(p.parts, p.items)] : p.kind; };
    for (const [text, want] of [
      ["close", "close"], ["close it as completed", "close as completed"], ["close not planned", "close as not planned"], ["@autocraft-bot close this as not planned.", "close as not planned"],
      ["close duplicate of #12", "close as duplicate of #12"], ["close as a duplicate of storytold/deckcraft#3", "close as duplicate of storytold/deckcraft#3"],
      ["close as duplicate of https://github.com/storytold/deckcraft/issues/3", "close as duplicate of storytold/deckcraft#3"],
      ["close photocraft#15 as duplicate of #12", "close as duplicate of #12: photocraft#15"], ["close as duplicate of #12: #15 #16", "close as duplicate of #12: photocraft#15 photocraft#16"],
    ] as const) {
      assert.deepEqual(of(text, "photocraft"), [want], text);
      assert.deepEqual(of(want, "photocraft"), [want], "the canonical text reads back as itself");
    }
    for (const text of ["close as duplicate", "close as duplicate of the other one", "close as wontfix", "don't close as completed", "close as completed and not planned", "close as duplicate of #0"]) assert.equal(of(text, "photocraft"), "ambiguous", text);
    const r = run("close as not planned, merge", pr());
    assert.equal(r.kind === "ambiguous" && r.ambiguity.why, "conflict");
    const dup = run("close as duplicate of #12", { kind: "issue", workflow: null });
    assert.deepEqual(dup.kind === "run" && [dup.run.end, dup.run.close], ["close", { as: "duplicate", of: { repo: null, number: 12 } }]);
  });

  test("hold works on any item that is not held yet; resume and yes only on a held one", () => {
    const held: ItemState = { ...pr(), held: started({ state: "stopped", stoppedBy: "mira", stoppedAt: "2026-11-24T09:30:00Z", blockerParams: { held: {} } }) };
    for (const s of [pr(), pr(started()), { ...held, closing: true }]) assert.equal(run("hold", s).kind, "run");
    assert.equal(run("hold", held).kind, "refused");
    for (const text of ["resume", "continue", "yes", "go", "resume, urgent"]) {
      const r = run(text, held);
      assert.ok(r.kind === "run" && r.run.resume === "steps", text);
    }
    assert.equal(run("resume", pr()).kind, "refused");
    assert.equal(run("resume, then merge", held).kind, "ambiguous");
    const start = run("merge", held);
    assert.ok(start.kind === "run" && start.run.start === "merge", "a start command starts it as ever");
  });

  test("a message that only says to wait is a hold; one that asks for something else runs nothing", () => {
    for (const text of ["hold", "stop", "pause", "wait", "Hold on.", "not yet", "ok, wait please", "please stop", "hold off"]) {
      assert.deepEqual(parse(text), { kind: "commands", items: [], parts: [{ word: "hold" }] }, text);
    }
    for (const text of ["merge after CI, wait", "wait for #12, then merge", "don't hold", "hold the merge until Friday", "stop merging, fix 1"]) {
      const p = parse(text, { repo: "app" });
      assert.notEqual(p.kind === "ambiguous" ? "nothing" : resolve(p, pr(started())).kind, "run", text);
    }
  });

  test("a weight word alone needs a started item", () => {
    assert.equal(run("urgent", pr()).kind, "ambiguous");
    const r = run("urgent", pr(started()));
    assert.ok(r.kind === "run" && r.run.weight === 10 && !r.run.approve && r.run.start === null);
  });

  test("the recommendation line names what a bare yes runs", () => {
    const rec = (over: Partial<Recommendation>): Recommendation => ({ text: "Looks fine.", parts: { fix: [], drop: [] }, merges: false, ...over });
    assert.match(recommendationLine(rec({ merges: true }))!, /go ahead and merge it/);
    assert.match(recommendationLine(rec({ merges: true, parts: { fix: [1, 2], drop: [] } }))!, /go ahead: fix 1 and 2, then merge/);
    const noMerge = recommendationLine(rec({ parts: { fix: [1], drop: [] } }))!;
    assert.match(noMerge, /go ahead: fix 1; it comes back to you/);
    assert.doesNotMatch(noMerge, /merge/);
    assert.match(recommendationLine(rec({ close: true }))!, /go ahead and close it/);
    assert.match(recommendationLine(rec({}))!, /Reply with what to do/);
    // The clause matches what the resolver runs for a bare yes.
    const r = run("yes", pr(started({ state: "recommending", rec: rec({ merges: true }) })));
    assert.ok(r.kind === "run" && r.run.merges);
  });
});
