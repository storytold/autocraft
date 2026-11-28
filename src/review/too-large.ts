// Once at leader start: a too-large review hold made under a smaller diff size cap than the current one (MAX_DIFF_CHARS) reviews its head
// again. The hold row at the PR's current head is removed, as Review again does, so the Review stage plans that head anew; the question
// of a workflow stopped at the hold closes by its cause once the row is gone (src/workflow/ask.ts `too-large`). A hold that is too large
// for the current cap as well is made again, with that cap. Runs next to resumeRetiredStops (src/runner/index.ts); with no raise since,
// it finds nothing.
import type { Db } from "../db/index.ts";
import { dropHoldReviews, loadTooLargeHolds } from "../data/review/index.ts";
import { MAX_DIFF_CHARS } from "./diff.ts";

/** The cap of the holds stored before each hold recorded its own. */
const CAP_BEFORE_STAMPS = 120_000;

/** Removes the too-large holds made under a cap below `cap`; returns the `repo#number` of each. */
export async function reviewTooLargeAgain(db: Db, cap: number = MAX_DIFF_CHARS): Promise<string[]> {
  const holds = await loadTooLargeHolds(db, cap, CAP_BEFORE_STAMPS);
  if (!holds.length) return [];
  const gone = await dropHoldReviews(db, holds, "pipeline");
  return gone.map((g) => `${g.repo}#${g.number}`);
}
