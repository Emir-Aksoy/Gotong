/**
 * Checkpoint primitives for the CLI shell-out adapter — the INTERCEPT / HANDOFF /
 * RESUME control seams from AGENT-ADAPTER-CONTRACT.
 *
 * Pure policy + state types + a cooperative takeover switch + a pre-spawn action
 * gate. No `@aipehub/core` dependency here; the participant (`cli-participant.ts`)
 * imports these and turns its single-shot run into a checkpoint loop.
 *
 * The model: `CliParticipant` runs the CLI in bounded TURNS. Before each turn it
 * evaluates two checkpoints —
 *   1. a cooperative TAKEOVER flag the host flips (a person watching the stream
 *      clicks "take over") → park so a human steers;
 *   2. a pre-spawn ACTION GATE (T2) — inspect the about-to-run command/args/prompt
 *      and park for approval when it looks destructive.
 * Parking = throw `SuspendTaskError(NEVER_RESUME_AT)` carrying `CliCheckpointState`
 * so ONLY an explicit human-driven resume wakes it (never the timer sweep). On
 * resume the participant reads a `CliReviewDecision` and either continues the loop
 * (optionally with a reviewer-edited prompt = handoff) or fails fail-closed.
 */

import type { TaskId } from '@aipehub/core'

/**
 * Sentinel `resumeAt` meaning "never auto-resume". Same value the inbox uses
 * (`@aipehub/inbox` NEVER_RESUME_AT) — duplicated as a local constant rather than
 * importing inbox, so this leaf package stays core-only. A checkpoint park is
 * woken by a human decision (the host calls `hub.resumeTask`), never by the 30s
 * resume sweep, so its `resumeAt` must sit beyond any real clock.
 */
export const CLI_NEVER_RESUME_AT = 9_999_999_999_000

/** Schema version for the carried checkpoint state (forward-safety). */
export const CLI_CHECKPOINT_STATE_V = 1

/** Why a task parked at a checkpoint. */
export type CliParkKind = 'takeover' | 'action_gate'

/** One completed CLI invocation, kept for observability + continuation. */
export interface CliTurnRecord {
  turn: number
  prompt: string
  exitCode: number | null
  output: string
}

/**
 * Persisted across a park — rides `SuspendTaskError.state`. The host writes an
 * approval inbox item from `reason`/`kind` and, on resume, hands this back
 * (merged with the reviewer's `decision`) so the loop continues where it parked.
 */
export interface CliCheckpointState {
  v: number
  /** The turn index the parked invocation would run (0-based). */
  turn: number
  /** The prompt that turn would run. A reviewer may override it on resume. */
  prompt: string
  /** Which checkpoint tripped. */
  kind: CliParkKind
  /** Human-readable reason (the gate's reason, or "takeover requested"). */
  reason: string
  /** Output of the turns that already completed. */
  transcript: CliTurnRecord[]
}

/** A reviewer's decision, delivered on resume. */
export interface CliReviewDecision {
  /** Proceed with the parked invocation? Action-gate parks are fail-closed. */
  approved: boolean
  /** Optional edited instruction — the reviewer steers the agent (handoff). */
  prompt?: string
  /** Optional free-text note (audit / transcript). */
  note?: string
}

/** Verdict from the pre-spawn action gate. */
export type CliGateVerdict = { allow: true } | { park: true; reason: string }

/** Context handed to the action-gate / continuation hooks for one turn. */
export interface CliTurnContext {
  taskId: TaskId
  /** 0-based turn index within this task. */
  turn: number
  command: string
  args: readonly string[]
  /** The prompt this turn will deliver to the CLI. */
  prompt: string
}

/**
 * A cooperative takeover switch the host flips between turns. A person watching
 * the stream (chunks carry the task id) asks to take over task X → the host calls
 * `requestTakeover('X')`; the participant sees it at the next checkpoint and parks
 * for human steering. Cooperative by design: it parks at a turn boundary, it does
 * not interrupt a running CLI mid-invocation (that's the terminate seam / abort).
 */
export class TakeoverController {
  private readonly pending = new Set<TaskId>()

  /** Ask the next checkpoint for this task to park for human takeover. */
  requestTakeover(taskId: TaskId): void {
    this.pending.add(taskId)
  }

  /** True if a takeover was requested and not yet consumed. */
  isRequested(taskId: TaskId): boolean {
    return this.pending.has(taskId)
  }

  /** Consume the request (called once the task actually parks / resumes). */
  clear(taskId: TaskId): void {
    this.pending.delete(taskId)
  }
}

/**
 * Default destructive-command patterns for `dangerousCommandGate`. Coarse by
 * intent: for a black-box agent CLI the contract says pin the side-effect surface
 * at the hub edge to T2 (approve the whole invocation), not parse the agent's
 * internal plan. Matched against `command + args + prompt` joined by newlines.
 */
export const DEFAULT_DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bnpm\s+publish\b/i,
  /\bsudo\b/i,
  /\bcurl\b[^\n]*\|\s*(?:ba)?sh\b/i,
  /\bdrop\s+(?:table|database)\b/i,
  /\bkubectl\s+delete\b/i,
]

/**
 * Build a pre-spawn action gate (T2) that parks when the about-to-run invocation
 * matches a destructive pattern. The participant calls it before each turn's
 * spawn; on `{ park }` it suspends for human approval.
 */
export function dangerousCommandGate(
  patterns: readonly RegExp[] = DEFAULT_DANGEROUS_PATTERNS,
): (ctx: CliTurnContext) => CliGateVerdict {
  return (ctx) => {
    const haystack = [ctx.command, ...ctx.args, ctx.prompt].join('\n')
    const hit = patterns.find((p) => p.test(haystack))
    return hit ? { park: true, reason: `matched destructive pattern ${String(hit)}` } : { allow: true }
  }
}

/**
 * Pull a `CliReviewDecision` out of whatever the resume path injected. Tolerates
 * both conventions: the timer sweep returns the persisted state verbatim (decision
 * under `decision`), while an inbox-style resolve injects `{ answer: <decision> }`.
 * Returns null when no decision is present.
 */
export function readReviewDecision(state: unknown): CliReviewDecision | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Record<string, unknown>
  const raw = (s.decision ?? s.answer) as unknown
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (typeof d.approved !== 'boolean') return null
  const out: CliReviewDecision = { approved: d.approved }
  if (typeof d.prompt === 'string') out.prompt = d.prompt
  if (typeof d.note === 'string') out.note = d.note
  return out
}

/** Read the carried checkpoint state out of a resume payload, if present. */
export function readCheckpointState(state: unknown): CliCheckpointState | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Record<string, unknown>
  // The host merges `{ ...persistedState, decision }`, so the checkpoint fields
  // sit at the top level. A nested `state` shape is also tolerated.
  const candidate = (typeof s.v === 'number' ? s : s.state) as Record<string, unknown> | undefined
  if (!candidate || typeof candidate.turn !== 'number') return null
  return candidate as unknown as CliCheckpointState
}
