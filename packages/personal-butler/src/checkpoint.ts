/**
 * Checkpoint primitives for the butler's approval-gated tool-loop — the
 * HANDOFF / RESUME seams from AGENT-ADAPTER-CONTRACT, adapted to an `LlmAgent`.
 *
 * Pure types + readers. No runtime imports beyond the LLM message TYPE, so this
 * stays a thin leaf. `agent.ts` wires these into park (`SuspendTaskError`) and
 * resume (decision injection).
 *
 * The model mirrors `@aipehub/acp-agent`'s `acp-checkpoint.ts` but the carried
 * state is RE-RUNNABLE, not a live in-memory handle: a butler park rides the
 * tool-loop conversation (`messages`) + the round's `toolUses`, so a fresh
 * process can answer the deferred tool call after approval. That makes a butler
 * park durable across a hub restart (unlike an ACP permission park).
 */

import type { LlmMessage, LlmToolUseBlock } from '@aipehub/llm'

/**
 * Sentinel `resumeAt` meaning "never auto-resume" — same value the inbox and
 * the ACP adapter use, duplicated locally so this leaf stays dependency-light.
 * A governed-action park is woken ONLY by a human decision (`hub.resumeTask`
 * via the `/me` inbox), never the 30s sweep, so its `resumeAt` must sit beyond
 * any real wall-clock.
 */
export const BUTLER_NEVER_RESUME_AT = 9_999_999_999_000

/** Schema version for the carried checkpoint state (forward-safety). */
export const BUTLER_GATE_STATE_V = 1

/**
 * The human-readable approval context the host turns into a `/me` inbox item.
 * Carries NOTHING used to re-run the action (the action rides `pending.toolUses`
 * verbatim) — just what a person needs to decide yes/no.
 */
export interface ButlerApprovalContext {
  /** The governed tool that triggered the park. */
  toolName: string
  /** Short human title, e.g. `delete_agent(mailer)`. */
  title: string
  /** Why the classifier escalated (e.g. "destructive — deletes an agent"). */
  reason: string
}

/**
 * Persisted across a park — rides `SuspendTaskError.state`. The host writes an
 * approval inbox item from `pending.approval` and, on resume, hands this back
 * merged with the reviewer's decision (`{ ...state, answer }`).
 *
 * `pending` is absent for a non-governed park (e.g. a quota gate that threw
 * `SuspendTaskError` from a pre-call hook) — then resume just continues the
 * loop from `messages` with no tool-result to inject.
 */
export interface ButlerGateState {
  v: number
  /**
   * The tool-loop conversation up to AND INCLUDING the assistant turn that
   * requested the governed tool. On resume we append the `user` turn carrying
   * the decision's tool-result, then continue the loop — so every `tool_use`
   * gets its matching `tool_result` and the provider stays happy.
   */
  messages: LlmMessage[]
  /** Present iff parked on a governed action awaiting approval. */
  pending?: {
    /**
     * The FULL round's tool calls (not just the governed one). On resume we
     * answer every block: the governed one(s) get the decision, any benign
     * siblings get executed — so a mixed round stays coherent.
     */
    toolUses: LlmToolUseBlock[]
    approval: ButlerApprovalContext
  }
  /** Opaque user state preserved from a wrapped non-governed suspend. */
  user?: unknown
}

/** Build the park state carried by `SuspendTaskError`. */
export function butlerGateState(args: {
  messages: LlmMessage[]
  pending?: { toolUses: LlmToolUseBlock[]; approval: ButlerApprovalContext }
  user?: unknown
}): ButlerGateState {
  const state: ButlerGateState = { v: BUTLER_GATE_STATE_V, messages: args.messages }
  if (args.pending) state.pending = args.pending
  if (args.user !== undefined) state.user = args.user
  return state
}

/**
 * Read the carried gate state out of a resume payload, if present. Tolerates
 * both the top-level shape (`{ v, messages, ... }`) and a nested `{ state: {...} }`
 * shape, mirroring `readAcpCheckpointState`. Returns null when it isn't ours —
 * the caller then falls back to the base `LlmAgent` resume.
 */
export function readButlerGateState(state: unknown): ButlerGateState | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Record<string, unknown>
  const candidate = (typeof s.v === 'number' ? s : s.state) as Record<string, unknown> | undefined
  if (!candidate || candidate.v !== BUTLER_GATE_STATE_V) return null
  if (!Array.isArray(candidate.messages)) return null
  return candidate as unknown as ButlerGateState
}

/** A reviewer's decision, delivered on resume from the `/me` inbox. */
export interface ButlerDecision {
  /** Approve the parked action? Governed parks are FAIL-CLOSED (default deny). */
  approved: boolean
  /** Optional free-text note (audit / transcript). */
  note?: string
}

/**
 * Pull a `ButlerDecision` out of whatever the resume path injected. Tolerates
 * both conventions: the inbox-style resolve (`{ answer: <decision> }`, what
 * `HostInboxService.resumeChild` injects) and a verbatim `{ decision }`.
 * Returns null when no usable decision is present — the caller then FAILS
 * CLOSED (treats it as a denial), never as an implicit approval.
 */
export function readButlerDecision(state: unknown): ButlerDecision | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Record<string, unknown>
  const raw = (s.answer ?? s.decision) as unknown
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (typeof d.approved !== 'boolean') return null
  const out: ButlerDecision = { approved: d.approved }
  if (typeof d.note === 'string') out.note = d.note
  return out
}
