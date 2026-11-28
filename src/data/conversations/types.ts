import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { RefKey } from "../mirror/types.ts";

export type { RefKey };

export type CardState = "proposed" | "queued" | "running" | "done" | "failed" | "dismissed" | "replaced";
/** `params` and `text` stay opaque JSON; feature code validates them. */
export type CardKind = "command" | "comment" | "label";
export type TurnKind = "operator" | "maintainer" | "opus" | "system";
export type HeldState = "held" | "filing" | "filed" | "failed" | "dropped" | "skipped";

export type ConversationRow = Selectable<DB["conversations"]>;
export type TurnRow = Omit<Selectable<DB["conversation_turns"]>, "kind"> & { kind: TurnKind };
export type CardRow = Omit<Selectable<DB["conversation_cards"]>, "kind" | "state" | "choice_id" | "dispute_by" | "dispute_reason" | "dispute_at"> & { kind: CardKind; state: CardState };
export type HeldRow = Omit<Selectable<DB["held_followups"]>, "choice_id" | "decision_id" | "answer_seq" | "preapproval_id" | "state"> & { workflow_id: number | null; approved_at: string | null; state: HeldState };
/** A turn as `loadThreads` returns it: `block` only when the load asked for blocks. */
export type ThreadTurn = Omit<TurnRow, "block"> & { block?: string };
export type Thread = { conversation: ConversationRow; turns: ThreadTurn[]; cards: CardRow[]; waiting: ThreadTurn | null; queue?: Queue };
/** `lastPersonBlock`: the block of the newest person turn that carries a `<steps>` line (display order), the one the prompt's seen steps come from. */
export type TurnTail = { maxSeq: number; waiting: TurnRow | null; heldIds: number[]; lastPersonBlock: string | null };
export type PendingTurn = { repo: string; number: number; turnId: number; kind: "operator" | "maintainer"; login: string };
export type GuidanceTurn = { kind: TurnKind; login: string; at: string; body: string };
export type TurnEvent = { id: number; repo: string; number: number; kind: TurnKind; login: string; at: string; len: number; status: string | null };
export type TurnDigest = { n: number; newest: number; states: string };

export type NewConversation = { repo: string; number: number; item_block: string; item_sig: string; created_by: string; created_at?: string };
export type NewCard = { kind: CardKind; params: string; text: string | null; description: string };
export type NewTurn = { ref: RefKey; kind: TurnKind; login: string; body: string; block: string; status?: string; notes?: string; cards?: NewCard[]; onlyIfThread?: boolean };
export type PostMessage = {
  ref: RefKey; by: { login: string; kind: "operator" | "maintainer" }; turn: NewTurn; ask: boolean; newConversation?: NewConversation;
  refresh?: { expectSig: string; sig: string; turn: NewTurn };
  /** Runs in the same transaction once the message's turn exists (a question links its message there), so no run sees the turn without it. */
  linked?: (turnId: number) => Promise<void>;
};
export type CardPatch = Partial<Pick<CardRow, "state" | "result" | "result_url" | "error" | "acted_by" | "acted_at" | "edited_by" | "edited_at" | "text" | "params" | "queued_at" | "queue_args">>;
export type QueuedCard = CardRow & { place: number };
export type Queue = { rows: QueuedCard[]; blocked: Set<string> };
/** The pure rule `used + reserve + need <= limit` is feature code: it derives the reserve from `running` with the card write counts. */
export type RunningCard = { id: number; kind: string; params: string; text: string | null; queue_args: string | null; written: number };
export type ActRoom = { limit: number | null; used: number; running: RunningCard[] };

export type NewHeld = { card_id: number; workflow_id: number | null; approved_at: string | null; repo: string; number: number; issue_repo: string; title: string; body: string; by: string; at: string };
export type HeldPatch = Partial<Pick<HeldRow, "state" | "issue_number" | "url" | "reason" | "attempts" | "updated_at">>;
export type PathEnd = "merged" | "closed" | "stopped" | null;
export type HeldInput = HeldRow & { item: { state: string; merged_at: string | null } | null; path: PathEnd; /** The create its filing recorded (null: none was begun); `issue` once that create is known to have opened one. */ filingAudit: { issue: { number: number; url: string } | null } | null };
export type DueHeld = { rows: HeldInput[]; byRepo: Map<string, HeldInput[]> };

export type Statement = { id: number; repo: string; number: number | null; text: string };
export type StatementWork = Statement & { source_kind: string; source_id: string; item_title: string; embedded: boolean };
export type StatementVec = Statement & { source_kind: string; item_title: string; at: string; model: string; vec: Uint8Array };
export type StatementView = Statement & { kind: string | null; state: string | null; title: string | null };
