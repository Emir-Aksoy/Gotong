/**
 * Feedback ledger types — M5 of the hub-mesh implementation.
 *
 * Reference: `docs/zh/HUB-MESH.md` §3.1 / §3.2 / §3.5.
 *
 * The ledger is intentionally minimal: a single append-only stream of
 * "lines" where each line is either a NEW entry or a STATUS bump on
 * an existing entry. Status (`deliveredAt`, `readAt`, `rejectedAt`)
 * is layered on top by replaying the stream — the original entry
 * never gets mutated in place. This is event-sourcing applied to
 * peer feedback.
 *
 * Why not sqlite (yet)? Per-hub feedback volume is small (10s–1000s of
 * entries over a project's life). Linear replay is fast enough until
 * we have evidence otherwise; sqlite indexing is reserved for M5+
 * if the jsonl scan ever shows up in a profile.
 */

import type { ParticipantId } from '../types.js'

/** Range of evaluation: whole task, one workflow step, or one specific contribution. */
export type FeedbackScope = 'whole-task' | 'step' | 'contribution'

/** Lifecycle status (derived; not stored as a single field). */
export type FeedbackStatus = 'pending' | 'delivered' | 'read' | 'rejected'

export interface FeedbackEntry {
  /** UUID; generated on append. */
  id: string

  // ─── target ────────────────────────────────────────────────────────────
  /** Peer hub id being evaluated. */
  toHub: string
  /** Specific participant inside the peer hub being evaluated. */
  toParticipant: ParticipantId
  /** Task / workflow run this evaluation is about. */
  taskRunId: string
  scope: FeedbackScope
  /** When scope = 'step' | 'contribution', the specific ref id. */
  scopeRef?: string

  // ─── verdict ───────────────────────────────────────────────────────────
  /** Rating in [0, 5]. */
  rating: number
  comment?: string
  tags?: readonly string[]

  // ─── evaluator (the "from" side) ───────────────────────────────────────
  /** Hub id of the evaluator (self when written locally). */
  evaluatorHub: string
  /** Specific participant inside the evaluator hub. */
  evaluatorParticipant: ParticipantId

  // ─── lifecycle (derived) ───────────────────────────────────────────────
  createdAt: number
  /** Filled when the peer hub has fetched this entry over the link. */
  deliveredAt?: number
  /** Filled when the peer has acknowledged having processed it. */
  readAt?: number
  /** Filled when the peer rejected this entry (Q4 decision). */
  rejectedAt?: number
  /** Optional reason carried with a rejection. */
  rejectionReason?: string
}

/**
 * Ledger lines — what gets appended to `outbound.jsonl`. The original
 * `FeedbackEntry` is stored as `{kind: 'entry', ...entry}`; status
 * bumps are separate single-purpose lines.
 */
export type LedgerLine =
  | { kind: 'entry'; entry: FeedbackEntry }
  | { kind: 'delivered'; entryId: string; at: number }
  | { kind: 'read'; entryId: string; at: number }
  | { kind: 'rejected'; entryId: string; at: number; reason?: string }

/** Input shape for `FeedbackLedger.appendEntry` — id + createdAt filled by the ledger. */
export type FeedbackEntryDraft = Omit<
  FeedbackEntry,
  'id' | 'createdAt' | 'deliveredAt' | 'readAt' | 'rejectedAt' | 'rejectionReason'
>

export function statusOf(e: FeedbackEntry): FeedbackStatus {
  if (e.rejectedAt) return 'rejected'
  if (e.readAt) return 'read'
  if (e.deliveredAt) return 'delivered'
  return 'pending'
}
