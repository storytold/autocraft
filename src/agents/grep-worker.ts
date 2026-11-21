// The worker of the Grep tool: model-written regular expressions run here, with a deadline the parent enforces by
// terminating this thread (grep-thread.ts). A pattern that backtracks catastrophically would otherwise hold the
// service's event loop, and the repository content a model reads can suggest one.
import { readFileSync, statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

export type GrepRequest = { pattern: string; flags: string; files: string[]; max: number; fileMaxBytes: number; lineMax: number };
export type GrepMatch = { file: string; line: number; text: string };
export type GrepReply = { matches: GrepMatch[]; limitHit: boolean } | { error: string };

const req = workerData as GrepRequest;
const reply = (r: GrepReply): void => void parentPort!.postMessage(r);

let re: RegExp;
try {
  // No `g`: every line is tested once, so a retained lastIndex cannot skip a line.
  re = new RegExp(req.pattern, req.flags);
} catch (e) {
  reply({ error: `invalid pattern: ${(e as Error).message.slice(0, 200)}` });
  re = null as unknown as RegExp;
}

if (re) {
  const matches: GrepMatch[] = [];
  let limitHit = false;
  outer: for (const file of req.files) {
    let text: string;
    try {
      if (statSync(file).size > req.fileMaxBytes) continue;
      text = readFileSync(file, "utf8");
    } catch { continue; }
    // A binary file (an image, a lock archive) is not searched.
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > req.lineMax) continue;
      if (re.test(line)) {
        matches.push({ file, line: i + 1, text: line });
        if (matches.length >= req.max) { limitHit = true; break outer; }
      }
    }
  }
  reply({ matches, limitHit });
}
