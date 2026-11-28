// The text form of an editable Claude prompt: editable text with locked blocks `⟦locked:NAME⟧…⟦/locked⟧` between it.
// Locked blocks are the parts code relies on (output format, tool rules, harness phrases, placeholders); a stored edit keeps
// its editable text and always runs with the code's own locked blocks. No Node modules: the dashboard's mock imports it.

export type Segment = { locked: boolean; name: string | null; text: string };

const MARK = /⟦locked:([a-z0-9_-]+)⟧|⟦\/locked⟧/g;

export const locked = (name: string, text: string): string => `⟦locked:${name}⟧${text}⟦/locked⟧`;

/** The segments of a body in order, or null when its markers do not pair up (a block inside a block, an unclosed or a stray end). */
export function segments(body: string): Segment[] | null {
  const out: Segment[] = [];
  let at = 0, open: { name: string; from: number } | null = null;
  for (const m of body.matchAll(MARK)) {
    const i = m.index;
    if (m[1] !== undefined) {
      if (open) return null;
      if (i > at) out.push({ locked: false, name: null, text: body.slice(at, i) });
      open = { name: m[1], from: i + m[0].length };
    } else {
      if (!open) return null;
      out.push({ locked: true, name: open.name, text: body.slice(open.from, i) });
      open = null;
    }
    at = i + m[0].length;
  }
  if (open) return null;
  if (at < body.length) out.push({ locked: false, name: null, text: body.slice(at) });
  return out;
}

export const joinSegments = (segs: readonly Segment[]): string => segs.map((s) => (s.locked ? locked(s.name!, s.text) : s.text)).join("");

/** The text that runs: the body without its markers. */
export const stripLocks = (body: string): string => body.replace(MARK, "");

const placeholders = (text: string): string[] => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();

/**
 * A stored edit as it runs against the code's body: the edit's editable text with the code's locked blocks, matched by name
 * and order. Null when the two no longer have the same blocks or the result's placeholders differ from the code's (the
 * release changed the prompt's structure; the code's text runs then).
 */
export function mergeEdit(codeBody: string, storedBody: string): string | null {
  const code = segments(codeBody), stored = segments(storedBody);
  if (!code || !stored) return null;
  const codeLocks = code.filter((s) => s.locked), storedLocks = stored.filter((s) => s.locked);
  if (codeLocks.length !== storedLocks.length || codeLocks.some((s, i) => s.name !== storedLocks[i]!.name)) return null;
  let n = 0;
  const merged = joinSegments(stored.map((s) => (s.locked ? codeLocks[n++]! : s)));
  const a = placeholders(stripLocks(merged)), b = placeholders(stripLocks(codeBody));
  return a.length === b.length && a.every((p, i) => p === b[i]) ? merged : null;
}
