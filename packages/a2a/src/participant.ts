/**
 * A2aRemoteParticipant — Phase 18 C-M4 outbound A2A edge (+ Stream H2 lifecycle).
 *
 * A local `Participant` that forwards a dispatched task to an EXTERNAL A2A
 * agent's `message/send`. The mirror of the inbound `A2aServer` (C-M3): there
 * an A2A caller reaches into our hub; here our hub reaches out to an A2A agent.
 *
 * It extends `AgentParticipant` so a thrown error becomes a `failed` task
 * result via the scheduler — no bespoke error plumbing. The remote's text
 * reply becomes the task's ok output as `{ text }`.
 *
 * Stream H2 — long-running tasks. A2A `message/send` may come back as a Task
 * (the remote SUSPENDED: long compute or its own HITL) instead of a Message.
 * Without `lifecycle`, a returned Task is a hard failure (legacy blocking
 * behavior — fine for agents that always answer in one round-trip). With
 * `lifecycle` opted in, THIS task parks and we poll `tasks/get` every
 * `pollIntervalMs` until the remote reaches a terminal state — so an external
 * long-running A2A agent can be a workflow step. The mechanism reuses the hub's
 * suspend/resume + sweep (Phase 11); the poll loop is the Stream D heartbeat
 * self-renewing-suspend pattern. The workflow-step integration is automatic:
 * the runner inherits the child's finite `resumeAt`, so the run is itself
 * sweep-resumable and re-polls the child until it settles (vs. Stream G's
 * NEVER_RESUME_AT approval children that need the inbox two-step).
 *
 * Registration is the host's job (the `A2aOutboundManager` reads persisted
 * rows); this class is transport-only and carries the per-agent url / token /
 * target skill.
 */

import { AgentParticipant, SuspendTaskError, type ParticipantId, type Task } from '@aipehub/core'

import { a2aGetTask, a2aSend, a2aSendRaw } from './client.js'
import { isA2ATask, isTerminalTaskState, messageText, type A2ATask } from './types.js'

/** Stream H2 — per-agent long-running task lifecycle options. */
export interface A2aLifecycleOptions {
  /** Delay before each `tasks/get` poll (ms). Default 3000; floored at 250. */
  pollIntervalMs?: number
  /**
   * Max polls before failing closed. A hung remote must not park forever — once
   * this many polls have all come back non-terminal, the task fails rather than
   * re-parking. Default 20; floored at 1.
   */
  maxAttempts?: number
}

export interface A2aRemoteParticipantOptions {
  /** Local participant id (what `result.by` shows). */
  id: ParticipantId
  /** Capabilities advertised on the LOCAL hub — dispatching these routes here. */
  capabilities: string[]
  /** The remote A2A agent's `message/send` endpoint. */
  url: string
  /** Bearer token presented to the remote. */
  token: string
  /**
   * AipeHub-to-AipeHub only: OUR peer id, sent as `X-Aipe-Peer-Id`. Omit for a
   * generic external A2A agent.
   */
  peerId?: string
  /**
   * `metadata.skill` to set on the outbound message — the capability the REMOTE
   * hub should dispatch to. Omit to let the remote use its own default.
   */
  targetSkill?: string
  /**
   * Stream H2 — opt into long-running task lifecycle. Omit → legacy blocking
   * behavior (a returned Task is a failure). Present → park + poll `tasks/get`.
   */
  lifecycle?: A2aLifecycleOptions
  /** Injectable clock for deterministic `resumeAt` in tests. Default Date.now. */
  now?: () => number
  /** Injectable fetch for deterministic tests. */
  fetchImpl?: typeof fetch
}

export class A2aRemoteParticipant extends AgentParticipant {
  private readonly url: string
  private readonly token: string
  private readonly peerId: string | undefined
  private readonly targetSkill: string | undefined
  private readonly lifecycle: { pollIntervalMs: number; maxAttempts: number } | undefined
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch | undefined

  constructor(opts: A2aRemoteParticipantOptions) {
    super({ id: opts.id, capabilities: opts.capabilities })
    this.url = opts.url
    this.token = opts.token
    this.peerId = opts.peerId
    this.targetSkill = opts.targetSkill
    this.lifecycle = opts.lifecycle
      ? {
          pollIntervalMs: Math.max(250, opts.lifecycle.pollIntervalMs ?? 3000),
          maxAttempts: Math.max(1, Math.floor(opts.lifecycle.maxAttempts ?? 20)),
        }
      : undefined
    this.now = opts.now ?? (() => Date.now())
    this.fetchImpl = opts.fetchImpl
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const text = payloadToText(task.payload)
    const send = this.sendOptions()
    // Legacy blocking path (no lifecycle opt-in): a2aSend throws on a returned
    // Task → AgentParticipant maps it to `failed`. Exact prior behavior.
    if (!this.lifecycle) {
      const reply = await a2aSend(this.url, this.token, text, send)
      return { text: reply }
    }
    // Lifecycle path: read the raw result and branch on Message vs Task.
    const result = await a2aSendRaw(this.url, this.token, text, send)
    if (!isA2ATask(result)) return { text: messageText(result) }
    return this.settleOrPark(result, 0)
  }

  protected async handleResume(_task: Task, state: unknown): Promise<unknown> {
    // A lifecycle resume = one `tasks/get` poll. Only the lifecycle path ever
    // parks, so a resume here always carries lifecycle state; a missing /
    // malformed handle is a loud failure (never a blind re-park — that would
    // defeat the AgentParticipant L11 guard's intent).
    const ls = readLifecycleState(state)
    if (!ls) {
      throw new Error(`a2a lifecycle resume for '${this.id}': missing or malformed carried state`)
    }
    const polled = await a2aGetTask(this.url, this.token, ls.peerTaskId, this.sendOptions())
    return this.settleOrPark(polled, ls.attempt)
  }

  /** Common send/poll options (peerId / fetchImpl / target skill). */
  private sendOptions(): {
    peerId?: string
    metadata?: Record<string, unknown>
    fetchImpl?: typeof fetch
  } {
    return {
      ...(this.peerId ? { peerId: this.peerId } : {}),
      ...(this.targetSkill ? { metadata: { skill: this.targetSkill } } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    }
  }

  /**
   * Map a returned / polled Task to either a terminal outcome (return ok text,
   * or throw → `failed`) or a re-park (throw SuspendTaskError to poll again).
   * `attempt` is how many polls have already happened (0 on the first park, so
   * the very first poll is attempt 1).
   */
  private settleOrPark(t: A2ATask, attempt: number): unknown {
    const state = t.status.state
    if (isTerminalTaskState(state)) {
      if (state === 'completed') {
        return { text: t.status.message ? messageText(t.status.message) : '' }
      }
      // failed / canceled → throw → AgentParticipant maps to `failed`.
      const why = t.status.message ? messageText(t.status.message) : state
      throw new Error(`a2a remote task ${state}: ${why}`)
    }
    // Non-terminal (working / submitted / input-required) → poll again, unless
    // we've exhausted the safety cap (a hung remote fails closed, never parks
    // forever). Guard instead of a `!` assertion: a parked task can be resumed
    // AFTER the operator toggled lifecycle OFF (H2-OUT re-registers the
    // participant without it) — fail with a clear message, not a TypeError
    // (audit P2).
    const lc = this.lifecycle
    if (!lc) {
      throw new Error(
        `a2a remote task '${t.id}' is still ${state} but lifecycle polling is now disabled on '${this.id}' — failing closed (re-enable lifecycle or re-dispatch)`,
      )
    }
    const next = attempt + 1
    if (next > lc.maxAttempts) {
      throw new Error(
        `a2a remote task '${t.id}' still ${state} after ${lc.maxAttempts} polls — failing closed`,
      )
    }
    throw new SuspendTaskError({
      resumeAt: this.now() + lc.pollIntervalMs,
      state: lifecycleState(t.id, next),
    })
  }
}

/** Pull the text to send out of a dispatched task payload. */
function payloadToText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    return (payload as { text: string }).text
  }
  return JSON.stringify(payload ?? '')
}

/** Carried-state version — bump if the shape changes (loud reject on mismatch). */
const A2A_LIFECYCLE_STATE_V = 1

interface A2aLifecycleState {
  __a2aLifecycle: typeof A2A_LIFECYCLE_STATE_V
  /** The remote's OPAQUE task handle to poll via `tasks/get`. */
  peerTaskId: string
  /** Polls already scheduled (1 on the first park). */
  attempt: number
}

function lifecycleState(peerTaskId: string, attempt: number): A2aLifecycleState {
  return { __a2aLifecycle: A2A_LIFECYCLE_STATE_V, peerTaskId, attempt }
}

function readLifecycleState(state: unknown): { peerTaskId: string; attempt: number } | null {
  if (
    state &&
    typeof state === 'object' &&
    (state as A2aLifecycleState).__a2aLifecycle === A2A_LIFECYCLE_STATE_V &&
    typeof (state as A2aLifecycleState).peerTaskId === 'string' &&
    typeof (state as A2aLifecycleState).attempt === 'number'
  ) {
    const s = state as A2aLifecycleState
    return { peerTaskId: s.peerTaskId, attempt: s.attempt }
  }
  return null
}
