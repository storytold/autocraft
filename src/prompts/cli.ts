// CLI: `autocraft-server prompts list|show|history|diff|edit|rollback`: the Prompts page's reads and writes from a shell,
// as "cli". `show` prints the text form with its lock markers on stdout, so `show ID > F`, an edit of F and `edit ID --file F`
// round-trip. A repository's guidance is repo.guidance with --repo R.
import { readFileSync } from "node:fs";
import { openDb } from "../db/open.ts";
import type { Db } from "../db/index.ts";
import {
  PromptViewError, editState, ensurePrompts, isClaudePrompt, isJevPrompt, listRevisions, loadActive, promptDiff, revisionInfo, rollback, saveEdit, textAt, useRelease,
  type SaveResult,
} from "../data/prompts/index.ts";
import { BASE_SCOPE, GUIDANCE_PROMPT_ID, PROMPTS } from "./index.ts";

const BY = "cli";
const USAGE = "prompts list | show <id> [--repo R] | history <id> [--repo R] | diff <id> <rev> [<rev>] [--repo R] | edit <id> [--repo R] --file F --note T [--base-rev N] | rollback <id> <rev>|release [--repo R] --note T";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The arguments without the flags and their values. */
function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) i++;
    else out.push(args[i]!);
  }
  return out;
}

const usage = (): never => { throw new Error(`usage: autocraft-server ${USAGE}`); };

/** The prompt and scope named on the command line: a model prompt, or repo.guidance with --repo. */
function scopeOf(id: string | undefined, repo: string | undefined): { id: string; scope: string } {
  if (!id) return usage();
  if (id === GUIDANCE_PROMPT_ID) {
    if (!repo) throw new Error(`${GUIDANCE_PROMPT_ID} belongs to one repository: add --repo R`);
    return { id, scope: repo };
  }
  if (repo) throw new Error(`a repository has one guidance text: ${GUIDANCE_PROMPT_ID} --repo ${repo}`);
  if (!isClaudePrompt(id) && !isJevPrompt(id)) throw new Error(`${id} is not a model prompt: \`autocraft-server prompts list\` names them`);
  return { id, scope: BASE_SCOPE };
}

function report(what: string, r: SaveResult): void {
  if (r.ok) { console.log(`saved ${what} as r${r.rev} (version ${r.version || "none"})`); return; }
  for (const p of r.problems) console.error(`${p.where}: ${p.message}`);
  throw new Error("refused; nothing was stored");
}

const pretty = (id: string, text: string): string => {
  if (!isJevPrompt(id)) return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
};

async function list(db: Db): Promise<void> {
  await ensurePrompts(db);
  for (const p of PROMPTS) {
    const e = editState(p.id, true);
    console.log(`${p.id.padEnd(32)} ${e.following ? "release" : "edited "} ${e.rev === null ? "-" : `r${e.rev}`}${e.newerDefault ? " newer-default" : ""}${e.structureChanged ? " structure-changed" : ""}${e.sameAs ? ` (runs ${e.sameAs})` : ""}${e.guidanceSlot ? " guidance" : ""}`);
  }
  const guided = (await loadActive(db)).filter((r) => r.promptId === GUIDANCE_PROMPT_ID && r.body);
  console.log(guided.length ? `guidance: ${guided.map((r) => `${r.scope} r${r.rev}`).join(", ")}` : "guidance: none");
}

export const commands = {
  prompts: {
    summary: USAGE,
    async run(args: string[]): Promise<void> {
      const [what, id, a, b] = positional(args);
      const repo = flag(args, "--repo"), note = flag(args, "--note") ?? "";
      const db = await openDb();
      try {
        switch (what) {
          case "list": return await list(db);
          case "show": {
            const s = scopeOf(id, repo);
            const active = (await listRevisions(db, s.id, s.scope)).find((r) => r.active);
            console.error(`${s.id}${s.scope === BASE_SCOPE ? "" : ` (${s.scope})`}: ${active ? `r${active.rev} ${active.follows ? "release default" : "edited"} by ${active.author}` : "release default, no revision stored"}`);
            process.stdout.write(`${pretty(s.id, await textAt(db, s.id, s.scope, "active"))}\n`);
            return;
          }
          case "history": {
            const s = scopeOf(id, repo);
            const revs = (await listRevisions(db, s.id, s.scope)).map(revisionInfo);
            if (!revs.length) console.log("no stored revision: the release default runs as r1");
            for (const r of revs) console.log(`r${r.rev}${r.active ? "*" : " "} ${r.kind.padEnd(11)} ${(r.version || "-").padEnd(18)} ${r.at.slice(0, 16)} ${r.author}${r.fromRev !== null ? ` from r${r.fromRev}` : ""}: ${r.note}`);
            return;
          }
          case "diff": {
            const s = scopeOf(id, repo);
            if (!a) return usage();
            const d = await promptDiff(db, s.id, s.scope, a, b ?? "active");
            if (!d.length) console.log("(no change)");
            for (const l of d) console.log(l.kind === "skip" ? `@@ ${l.count} unchanged @@` : `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);
            return;
          }
          case "edit": {
            const s = scopeOf(id, repo);
            const file = flag(args, "--file");
            if (!file) return usage();
            const base = flag(args, "--base-rev");
            const baseRev = base !== undefined ? Number(base) : (await listRevisions(db, s.id, s.scope)).find((r) => r.active)?.rev ?? null;
            return report(s.scope === BASE_SCOPE ? s.id : `${s.scope}'s guidance`, await saveEdit(db, { ...s, body: readFileSync(file, "utf8"), note, by: BY, baseRev }));
          }
          case "rollback": {
            const s = scopeOf(id, repo);
            if (!a) return usage();
            if (a === "release") {
              if (s.scope !== BASE_SCOPE) throw new Error("guidance has no release default: roll back to r1 to remove it");
              return report(s.id, await useRelease(db, { id: s.id, by: BY, note }));
            }
            const rev = Number(a);
            if (!Number.isInteger(rev) || rev < 1) return usage();
            return report(s.scope === BASE_SCOPE ? s.id : `${s.scope}'s guidance`, await rollback(db, { ...s, rev, by: BY, note }));
          }
          default: return usage();
        }
      } catch (e) {
        if (e instanceof PromptViewError) throw new Error(e.message);
        throw e;
      }
    },
  },
};
