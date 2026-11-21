// The parent of grep-worker.ts: one worker per Grep call, stopped after GREP_TIMEOUT_MS whatever it is doing.
import { Worker } from "node:worker_threads";
import { GREP_FILE_MAX_BYTES, GREP_TIMEOUT_MS, LINE_MAX } from "./tool-limits.ts";
import type { GrepMatch, GrepReply } from "./grep-worker.ts";

/** Runs a pattern over `files` in a worker; throws with a message the model can act on (an invalid pattern, or a stop). */
export function grepThread(o: { pattern: string; flags: string; files: string[]; max: number }): Promise<{ matches: GrepMatch[]; limitHit: boolean }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./grep-worker.ts", import.meta.url), {
      workerData: { pattern: o.pattern, flags: o.flags, files: o.files, max: o.max, fileMaxBytes: GREP_FILE_MAX_BYTES, lineMax: LINE_MAX },
    });
    let done = false;
    const finish = (f: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void w.terminate().then(f, f);
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`the pattern took longer than ${GREP_TIMEOUT_MS / 1000} s and was stopped; simplify it`))), GREP_TIMEOUT_MS);
    w.once("message", (r: GrepReply) => finish(() => ("error" in r ? reject(new Error(r.error)) : resolve({ matches: r.matches, limitHit: r.limitHit }))));
    w.once("error", (e: Error) => finish(() => reject(new Error(`the search failed: ${e.message.slice(0, 200)}`))));
    w.once("exit", (code) => finish(() => reject(new Error(`the search stopped (exit code ${code})`))));
  });
}
