import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CAPS, safePath } from "../sandbox/checkout.ts";
import type { ClaimLocationCheck } from "./opus-parse.ts";

/** The reviewed checkout contains only regular files from that head, without symlinks. */
export function checkoutClaimLocation(checkout: string): ClaimLocationCheck {
  const counts = new Map<string, number>();
  return ({ path, line }) => {
    if (!safePath(path) || !Number.isSafeInteger(line) || line < 1) return false;
    let lines = counts.get(path);
    if (lines === undefined) {
      lines = lineCount(join(checkout, path));
      counts.set(path, lines);
    }
    return line <= lines;
  };
}

function lineCount(path: string): number {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > DEFAULT_CAPS.maxFileBytes) return 0;
    const text = readFileSync(path, "utf8");
    if (!text || text.includes("\0")) return 0;
    return text.split("\n").length - Number(text.endsWith("\n"));
  } catch {
    return 0;
  }
}
