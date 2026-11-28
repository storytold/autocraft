import type { Selectable } from "kysely";
import type { FindingState, ScanState } from "../../../web/src/api/types.ts";
import type { DB } from "../../db/types.ts";

export type { FindingState, ScanState };
import type { RefKey } from "../mirror/types.ts";
import type { ItemRun } from "../inference/types.ts";

export type Ref = RefKey;
export type HiddenRepos = string[] & { visible?: string[] };
/** `repo#number` of a finding; its number is the finding's own per-repo sequence, not a PR's. */
export type FindingKey = string;

export const ACTIVE_STATES: ScanState[] = ["modeling", "scanning", "verifying"];
export const INTERNAL_FINDING_STATES = ["unverified", "disproved", "duplicate"] as const;
/** Every state a finding row can hold: the listed ones and the scan's own. */
export type StoredFindingState = FindingState | (typeof INTERNAL_FINDING_STATES)[number];
export const UNCHECKED_RESULT = "Not verified: the scan ended before this finding was checked.";
export const TRANSITIONS: Record<"dismiss" | "backlog" | "reopen", { from: FindingState[]; to: FindingState }> = {
  dismiss: { from: ["new", "backlog", "ready", "awaiting-admin"], to: "dismissed" },
  backlog: { from: ["new", "dismissed"], to: "backlog" },
  reopen: { from: ["dismissed", "backlog"], to: "new" },
};
export const findingKey = (repo: string, n: number): FindingKey => `${repo}#${n}`;

export type ScanRow = Selectable<DB["security_scans"]>;
/** Listed findings only (not unverified, disproved or duplicate). */
export type ScanListRow = ScanRow & { finding_count: number };
export type AreaRow = Selectable<DB["security_areas"]>;
export type CallRow = Selectable<DB["security_calls"]>;
export type FindingRow = Selectable<DB["security_findings"]>;
export type FindingBriefRow = Omit<FindingRow, "fix_patch" | "fix_files" | "verification" | "refs" | "reach" | "impact" | "fix_summary">;
export type FindingBoardRow = FindingBriefRow & { building_round: number | null; last_attempt_rounds: number };
/** A finding the landing poll watches. */
export type WatchedFinding = { repo: string; number: number; fix_commit: string | null; fork: string | null; fix_pr: number | null };
export type LandingWatch = { quiet: (WatchedFinding & { fix_pr: number })[]; waiting: (WatchedFinding & { fix_commit: string })[] };
export type RoundRow = Selectable<DB["security_fix_rounds"]>;
export type LogRound = Selectable<DB["security_fix_log"]>;
export type ScanTestRow = Selectable<DB["security_scan_tests"]>;
/** A scan test without its patch, as the pages show it. */
export type ScanTestView = Pick<ScanTestRow, "state" | "detail" | "test_path" | "test_source">;
/** A live round without its patches and session, as the pages show it. */
export type LiveRound = Pick<RoundRow, "round" | "state" | "failure" | "created_at">;
/** The note a finding carries while its fix waits for a confidential build environment. */
export const ENV_WAIT_NOTE = "Waiting for a confidential build environment.";
export type BuildingTest = Pick<ScanTestRow, "repo" | "number" | "task_id" | "retried" | "created_at">;

export type FindingPatch = Partial<{
  note: string | null; last_failure: string | null; fix_pr: number | null; fork: string | null; ghsa_id: string | null; fix_commit: string | null;
  fix_patch: string | null; fix_title: string | null; fix_summary: string | null; fix_branch: string | null; fix_files: string | null; fix_ref: string | null;
  env_wait_at: string | null; reason: string | null; decided_by: string | null; verification: string | null; severity: string;
}> & { bumpFixAttempts?: true; restoreFixAttempts?: number };
export type FindingMove = { repo: string; number: number; from: StoredFindingState[]; to: StoredFindingState; set?: FindingPatch; by?: string };

export type NewArea = { idx: number; name: string; paths: string; entry_points: string; risk: number; why: string | null };
export type NewScanCall = { scanId: number; kind: string; areaIdx?: number | null; finding?: number | null; resumed?: boolean };
export type NewFinding = Omit<Selectable<DB["security_findings"]>, "created_at" | "updated_at"> & { created_at?: string; updated_at?: string };
/** A finding a scan job stores; its number is given when it is stored. `repeats`: the index in the stored list of the finding it repeats (with no `duplicate_of`). */
export type NewScanFinding = Omit<NewFinding, "number" | "repo"> & { repeats?: number };
/** The columns of a finding the scan's verify call needs. */
export type UnverifiedRow = Pick<FindingRow, "number" | "title" | "severity" | "urgent" | "category" | "refs" | "reach" | "impact">;
export type ScanRunData = {
  scan: ScanRow; areas: AreaRow[]; known: Pick<FindingRow, "repo" | "number" | "state" | "fingerprint" | "title" | "refs" | "category">[];
  callCosts: { kind: string; costUsd: number }[];
  /** Per area (by index) that has findings of this scan: whether it has any and its `unverified` ones, by number. */
  leftover: { areaIdx: number; findings: number; unverified: UnverifiedRow[] }[];
};
export type ScanDetailData = { scan: ScanListRow; areas: AreaRow[]; calls: (CallRow & { area_name: string | null })[]; findings: (FindingBriefRow & { scan_test_state: string | null })[]; runs: ItemRun[] };
export type FindingDetailData = {
  finding: FindingRow; calls: (CallRow & { area_name: string | null })[]; repeats: Pick<FindingRow, "repo" | "number" | "title" | "state" | "created_at">[];
  scanTest: ScanTestView | null; log: LogRound[]; rounds: LiveRound[];
};
/** `by` is who started the fix (`decided_by`); `tasks` is null for a finding waiting on a confidential environment. */
export type FixAdvanceRow = { repo: string; number: number; by: string | null; tasks: { head: number; base: number } | null; roundCreatedAt: string | null; envWaitAt: string | null; /** A waiting fix's security fix session workspace state, when it has one. */ workspaceState: string | null };
export type LinkRow = Pick<FindingRow, "repo" | "number" | "state" | "fingerprint" | "title" | "refs" | "category">;
/** `endedJobScans`: active scans whose job ended (`cancelled` when it was cancelled); `jobless`: active scans with no job; `findings`: stuck `fixing` or `landing` findings. */
export type StaleWork = { endedJobScans: { id: number; cancelled: boolean }[]; jobless: number[]; findings: { repo: string; number: number; state: "fixing" | "landing" }[] };
export type FindingAttention = {
  openHighCount: number; openHigh: { repo: string; number: number; title: string; created_at: string }[];
  gaveUp: { repo: string; number: number; fix_attempts: number; last_failure: string | null }[];
};
export type EndScanCall = {
  callId: number; scanId: number; ok: boolean; costUsd: number | null; runId: number | null; chargeUsd: number; billArea?: number;
  finding?: { repo: string; number: number; patch: FindingPatch; state: FindingState };
};
export type SessionRow = { kind: "security"; id: string; state: string; session: string | null };
