/** Honest per-check wording: `none` is "no result recorded" for that named check, never a pass or a run. */
export function checkStateText(state: string): string {
  switch (state) {
    case "passing": return "Passing";
    case "failing": return "Failing";
    case "pending": return "Pending";
    case "none": return "No result recorded";
    default: return `Unrecognised state: ${String(state)}`;
  }
}
