// A line diff of two prompt texts, for revision history and the release flag. No Node modules: the dashboard imports it.

/** One line of a diff: kept, added or removed; `skip` stands for `count` unchanged lines left out between the shown ones. */
export type DiffLine = { kind: "same" | "add" | "del"; text: string } | { kind: "skip"; count: number };

/** Lines this many away from a change are left out of the diff. */
const CONTEXT = 3;

/**
 * The lines that turn `a` into `b` (longest common subsequence over lines), with unchanged runs cut to CONTEXT lines on
 * each side of a change. Two equal texts give []. Bounded by the prompt size limit, so the n×m table stays small.
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  if (a === b) return [];
  const x = a.split("\n"), y = b.split("\n");
  // The common prefix and suffix need no table.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf), ys = y.slice(pre, y.length - suf);
  const n = xs.length, m = ys.length, w = m + 1;
  const len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    len[i * w + j] = xs[i] === ys[j] ? len[(i + 1) * w + j + 1]! + 1 : Math.max(len[(i + 1) * w + j]!, len[i * w + j + 1]!);
  }
  const full: { kind: "same" | "add" | "del"; text: string }[] = x.slice(0, pre).map((text) => ({ kind: "same", text }));
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) { full.push({ kind: "same", text: xs[i]! }); i++; j++; }
    else if (j < m && (i === n || len[i * w + j + 1]! >= len[(i + 1) * w + j]!)) full.push({ kind: "add", text: ys[j++]! });
    else full.push({ kind: "del", text: xs[i++]! });
  }
  for (const text of x.slice(x.length - suf)) full.push({ kind: "same", text });
  const near = full.map(() => false);
  full.forEach((l, k) => { if (l.kind !== "same") for (let d = Math.max(0, k - CONTEXT); d <= Math.min(full.length - 1, k + CONTEXT); d++) near[d] = true; });
  const out: DiffLine[] = [];
  for (let k = 0; k < full.length; k++) {
    if (near[k]) { out.push(full[k]!); continue; }
    let e = k;
    while (e < full.length && !near[e]) e++;
    out.push({ kind: "skip", count: e - k });
    k = e - 1;
  }
  return out;
}
