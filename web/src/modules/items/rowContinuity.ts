import { useLayoutEffect, useRef, type MutableRefObject } from "react";
import type { RowFacts } from "./rows";

export interface RowContinuity {
  owner: string;
  previous: MutableRefObject<{ owner: string; rows: RowFacts[] } | null>;
}

/** One page-local presentation snapshot, surviving a list/phase switch but not a reader/repository change. */
export function useRowContinuity(owner: string): RowContinuity {
  const previous = useRef<{ owner: string; rows: RowFacts[] } | null>(null);
  if (previous.current?.owner !== owner) previous.current = null;
  return { owner, previous };
}

/** Current receipts remain the only authority; returned retained rows must be rendered inert without details. */
export function useDisplayRows(current: RowFacts[], available: boolean, loading: boolean, error: unknown, { owner, previous }: RowContinuity) {
  const failed = error !== undefined && error !== null;
  useLayoutEffect(() => {
    if (failed) previous.current = null;
    else if (available && !loading) previous.current = { owner, rows: current };
  }, [owner, previous, current, available, loading, failed]);
  const retained = !available && !failed && previous.current?.owner === owner && previous.current.rows.length > 0;
  return { rows: retained ? previous.current!.rows : current, retained };
}
