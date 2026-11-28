// Where a Claude template's fixed text ends, and the locked blocks of its text form (src/prompts/locks.ts). Some blocks are
// placed by hand per prompt (output format, tool rules, safety rules, rules for public text); the rest follow from the text:
// each placeholder, each harness phrase, MCP tool name and sandbox path (harness.ts), and the whole data tail. No Node
// modules: the dashboard's mock imports the registry.
import { harnessSpans } from "./harness.ts";
import { locked, stripLocks } from "./locks.ts";

/**
 * Placeholders whose value is the same for every call of a prompt in one mode (repo_access) or on one kind of environment
 * (dependencies: with or without a crate mirror), so they go in the system prompt; every other one carries item data.
 */
export const FIXED_PLACEHOLDERS = new Set(["repo_access", "dependencies"]);

/**
 * Where a template's fixed text ends: the start of the line (or of the tag line just above it, such as
 * `<items>`) that holds the first data placeholder. Everything before it is the same for every call.
 */
export function dataStart(template: string): number {
  for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) {
    if (FIXED_PLACEHOLDERS.has(m[1]!)) continue;
    let at = template.lastIndexOf("\n", m.index) + 1;
    const above = template.lastIndexOf("\n", at - 2) + 1;
    if (/^<\w+>$/.test(template.slice(above, at - 1))) at = above;
    return at;
  }
  return template.length;
}

/** The blocks placed by hand: the output format the parser reads, tool rules, rules against following untrusted data, rules for text that is posted. */
export type LockName = "output" | "tools" | "safety" | "public";
/** The name of the block that holds a template's data tail, from dataStart to the end. */
export const DATA_LOCK = "data";
/** The name of the block around a harness phrase, MCP tool name or sandbox path. */
export const HARNESS_LOCK = "harness";

/**
 * A block placed by hand: `[name, from]` locks from the start of `from` to the end of its paragraph (the next blank line,
 * or the end of the fixed text); `[name, from, to]` locks from `from` through the end of the first `to` at or after it, so
 * `[name, s, s]` locks exactly `s`. `from` must occur once in the fixed text.
 */
export type LockSpec = readonly [LockName, string, string?];

type Range = { from: number; to: number; name: string };

/**
 * A template's text form: `text` with the hand-placed blocks, a lock around each placeholder and harness span outside them,
 * and the data tail as one block. Stripping the markers gives `text` back exactly. Throws on a spec that is not found once,
 * blocks that overlap, or a block that runs into the data tail: the registry fails to load rather than run a wrong lock.
 */
export function lockTemplate(text: string, specs: readonly LockSpec[] = []): string {
  if (stripLocks(text) !== text) throw new Error("a template's source holds lock markers");
  const head = dataStart(text);
  const fixed = text.slice(0, head);
  const hand: Range[] = specs.map(([name, from, to]) => {
    const at = fixed.indexOf(from);
    if (at < 0 || fixed.indexOf(from, at + 1) >= 0) throw new Error(`lock ${name}: "${from.slice(0, 40)}" is not in the fixed text exactly once`);
    let end: number;
    if (to === undefined) {
      const blank = fixed.indexOf("\n\n", at);
      end = blank < 0 ? fixed.trimEnd().length : blank;
    } else {
      const t = fixed.indexOf(to, at);
      if (t < 0) throw new Error(`lock ${name}: "${to.slice(0, 40)}" does not follow "${from.slice(0, 40)}"`);
      end = t + to.length;
    }
    return { from: at, to: end, name };
  }).sort((a, b) => a.from - b.from);
  hand.forEach((r, i) => { if (i > 0 && r.from < hand[i - 1]!.to) throw new Error(`locks ${hand[i - 1]!.name} and ${r.name} overlap`); });
  const inHand = (a: number, b: number): boolean | null => {
    for (const r of hand) {
      if (a >= r.from && b <= r.to) return true;
      if (a < r.to && b > r.from) return null;
    }
    return false;
  };
  const auto: Range[] = [
    ...[...fixed.matchAll(/\{\{(\w+)\}\}/g)].map((m) => ({ from: m.index, to: m.index + m[0].length, name: m[1]! })),
    ...harnessSpans(fixed).map(([from, to]) => ({ from, to, name: HARNESS_LOCK })),
  ].filter((r) => {
    const inside = inHand(r.from, r.to);
    if (inside === null) throw new Error(`lock ${r.name} at ${r.from} crosses a hand-placed block`);
    return !inside;
  }).sort((a, b) => a.from - b.from);
  auto.forEach((r, i) => { if (i > 0 && r.from < auto[i - 1]!.to) throw new Error(`locks ${auto[i - 1]!.name} and ${r.name} overlap`); });
  const ranges = [...hand, ...auto].sort((a, b) => a.from - b.from);
  let out = "", at = 0;
  for (const r of ranges) {
    out += fixed.slice(at, r.from) + locked(r.name, fixed.slice(r.from, r.to));
    at = r.to;
  }
  out += fixed.slice(at);
  if (head < text.length) out += locked(DATA_LOCK, text.slice(head));
  if (stripLocks(out) !== text) throw new Error("a locked template does not strip to its text");
  return out;
}
