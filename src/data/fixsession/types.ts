// Fix sessions (`fix_sessions`) and their turns (`fix_session_turns`): the model sessions the fix steps keep per item (src/fixsession).

/**
 * pr: the session of a pull request (fix-up, CI fix, conflict); security: the private fix of a security finding; mainfix: the fix of
 * a red default branch, one per repo (number 0: the default branch, not a PR).
 */
export type FixSessionKind = "pr" | "security" | "mainfix";
/** The step a turn works for: its allowed files and its stored row come from it. */
export type FixStep = "fixup" | "cifix" | "conflict" | "security" | "main-fix";
export const FIX_STEPS: readonly FixStep[] = ["cifix", "fixup", "conflict", "security", "main-fix"];
/** The step a turn was sent for: a maintainer's `fix <instructions>` runs in the fix-up step with its own gate, so its turns are apart. */
export type FixTurnStep = FixStep | "maintainer";
export type FixTurnPurpose = "start" | "step" | "findings" | "lint" | "undo" | "report" | "fresh";
export type FixTurnOutcome = "queued" | "done" | "failed" | "unclaimed" | "withdrawn";
/** Why a session ended: closed (its PR was closed or merged), stopped (a person ended its workflow), idle, turns (the turn cap), or a caller's reason. */
export type FixSessionEnd = "closed" | "stopped" | "idle" | "turns" | (string & {});

export type FixSession = {
  id: number; kind: FixSessionKind; repo: string; number: number;
  workspaceId: number | null;
  /** The commit the workspace's base holds: the PR head, a merge commit or a pinned sha. */
  head: string | null;
  /** The call the next follow-up continues. */
  lastCallId: number | null;
  model: string | null;
  /** Turns sent on the session. */
  turns: number;
  costUsd: number;
  state: "live" | "ended";
  endReason: string | null;
  createdAt: string; updatedAt: string; endedAt: string | null;
};

export type NewFixSession = { kind: FixSessionKind; repo: string; number: number; model?: string | null; head?: string | null; workspaceId?: number | null };

/** A patch of a live or ended session; `addTurns` and `addCostUsd` are added to the stored counts. `updated_at` is always set. */
export type FixSessionPatch = {
  lastCallId?: number | null; head?: string | null; workspaceId?: number | null; model?: string | null;
  addTurns?: number; addCostUsd?: number;
};

export type FixTurn = {
  id: number; sessionId: number; step: FixTurnStep; purpose: FixTurnPurpose;
  head: string | null; callId: number | null; parentId: number | null;
  outcome: FixTurnOutcome;
  /** The session's report as stored (JSON parsed); null when none or unreadable. */
  report: unknown;
  error: string | null;
  /** The call's model turns. */
  turns: number | null; costUsd: number | null; toolCalls: number | null; shellMs: number | null;
  diffHash: string | null;
  /** The turn's task was a quiet one (a security fix not yet published). */
  quiet: boolean;
  createdAt: string; settledAt: string | null;
};

export type NewFixTurn = { sessionId: number; step: FixTurnStep; purpose: FixTurnPurpose; head?: string | null; callId?: number | null; parentId?: number | null; quiet?: boolean };

/** How a turn ended; fields left out stay as they are. */
export type FixTurnSettle = {
  outcome: Exclude<FixTurnOutcome, "queued">;
  report?: unknown; error?: string | null; turns?: number | null; costUsd?: number | null; toolCalls?: number | null; shellMs?: number | null; diffHash?: string | null;
};

/** A session the sweep ended: the caller ends its workspace. */
export type EndedFixSession = { id: number; kind: FixSessionKind; repo: string; number: number; workspaceId: number | null; reason: FixSessionEnd };
