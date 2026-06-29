/**
 * `capture.ts` — turn-end capture: record a completed butler turn into
 * **episodic** memory.
 *
 * # Why this exists (M2 / decision D5)
 *
 * OpenClaw / Hermes capture conversation automatically so the user never has
 * to maintain memory by hand. OpenClaw's safety net is a "save-before-compact"
 * silent round — but AipeHub's `LlmAgent` has **no context auto-compaction
 * event** (its truncate is just a log dump). So we capture at the two honest
 * hook points we *do* have: **turn end** (here) and **heartbeat review**
 * (`review.ts`). Turn-end capture is cleaner anyway — it's off the hot path,
 * so it never burns tokens mid-turn.
 *
 * # What gets captured
 *
 * The raw turn — the user's prompt and the butler's reply — written verbatim
 * (trimmed) to the `episodic` kind. That matches the memory contract exactly:
 * `episodic` is the **append-only log of "what happened"**; the curated
 * `semantic` profile is distilled from it later by `consolidate()` (M3). So
 * capture is intentionally **extractive, not LLM-summarized** — no model call,
 * fully deterministic, and it puts raw history where raw history belongs.
 *
 * These are pure helpers + a builder; the writing is done by the agent
 * (`MemoryAugmentedAgent.captureTurn`) best-effort after a turn completes.
 */

import type { Task } from '@aipehub/core'
import type { NewMemoryEntry } from '@aipehub/services-sdk'

/** Default soft cap on a single capture entry's text. */
export const DEFAULT_CAPTURE_MAX_CHARS = 2_000

export interface TurnCaptureInput {
  /** The user-facing prompt for this turn. */
  userText: string
  /** The butler's final reply text for this turn. */
  replyText: string
  /** Originating task id (stored in meta for traceability). */
  taskId?: string
  /** Who the task came from (stored in meta). */
  from?: string
  /** Extra meta merged into the entry (e.g. a per-user namespace key). */
  meta?: Record<string, unknown>
  /** Soft cap on the rendered text. Default {@link DEFAULT_CAPTURE_MAX_CHARS}. */
  maxChars?: number
}

/**
 * Build the episodic entry that records one completed turn. Pure: same input
 * → same entry (no clock, no id — `remember` assigns both). Returns `null`
 * when there's nothing worth recording (both sides empty), so the caller can
 * skip the write without an `if`.
 */
export function buildTurnCapture(input: TurnCaptureInput): NewMemoryEntry | null {
  const max = clampMax(input.maxChars)
  const text = renderTurn(collapse(input.userText), collapse(input.replyText), max)
  if (text.length === 0) return null
  const meta: Record<string, unknown> = { turn: true, ...(input.meta ?? {}) }
  if (input.taskId !== undefined) meta.taskId = input.taskId
  if (input.from !== undefined) meta.from = input.from
  return { kind: 'episodic', text, meta }
}

/**
 * Extract the user-facing prompt text from a task payload — mirrors
 * `LlmAgent.buildRequest`'s user-content selection so the captured text
 * matches what the model actually saw. Falls back to the task title, then ''.
 */
export function extractUserText(task: Task): string {
  const p = task.payload
  if (typeof p === 'string') return p
  if (p && typeof p === 'object') {
    const o = p as Record<string, unknown>
    if (typeof o.prompt === 'string') return o.prompt
    if (typeof o.topic === 'string') return o.topic
    if (Array.isArray(o.messages)) {
      const fromMessages = lastUserMessageText(o.messages)
      if (fromMessages.length > 0) return fromMessages
    }
  }
  return typeof task.title === 'string' ? task.title : ''
}

/**
 * Extract the reply text from whatever `handleTask` returned. Handles the two
 * real shapes: a bare string, or an `LlmTaskOutput`-style `{ text }` object.
 * Anything else → '' (nothing readable to record).
 */
export function extractReplyText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const t = (output as { text?: unknown }).text
    if (typeof t === 'string') return t
  }
  return ''
}

/**
 * True when a task is a heartbeat tick (Stream D), not a real conversation
 * turn. Capture skips these — episodic memory is the conversation log, not a
 * record of maintenance wake-ups.
 */
export function isHeartbeatPayload(task: Task): boolean {
  const p = task.payload
  return !!p && typeof p === 'object' && (p as { heartbeat?: unknown }).heartbeat === true
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Pull the text out of the last `user` message in an `LlmMessage[]`-ish list. */
function lastUserMessageText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || typeof m !== 'object') continue
    if ((m as { role?: unknown }).role !== 'user') continue
    const content = (m as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as { type?: unknown; text?: unknown }
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
        }
      }
      if (parts.length > 0) return parts.join('')
    }
  }
  return ''
}

function renderTurn(user: string, reply: string, max: number): string {
  // Split the budget so a giant prompt can't crowd out the reply (and vice
  // versa). Each side keeps roughly half; tiny entries stay whole.
  const half = Math.max(1, Math.floor(max / 2))
  const parts: string[] = []
  const u = truncate(user, half)
  const r = truncate(reply, half)
  if (u.length > 0) parts.push(`User: ${u}`)
  if (r.length > 0) parts.push(`Butler: ${r}`)
  return parts.join('\n')
}

function collapse(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '…'
}

function clampMax(maxChars: number | undefined): number {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars <= 0) {
    return DEFAULT_CAPTURE_MAX_CHARS
  }
  return Math.floor(maxChars)
}
