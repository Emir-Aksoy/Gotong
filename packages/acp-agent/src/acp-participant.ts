/**
 * AcpParticipant — the outbound ACP edge: a local hub `Participant` that drives a
 * coding agent (Claude Code / Codex / …) over a long-lived ACP session. This is
 * the OpenClaw-style "manage from startup → hold the session → dispatch" adapter.
 *
 * One instance owns ONE `AcpSession` (one child, one ACP session, lazily started
 * on the first task). Tasks dispatched to its capabilities become `session/prompt`
 * turns on that SAME session, so context carries across tasks — the difference
 * from the one-shot cli-agent.
 *
 * All five AGENT-ADAPTER-CONTRACT control seams:
 *   - OBSERVE    — `session/update` chunks stream to `onChunk` in real time.
 *   - INTERCEPT  — `session/request_permission` runs through `gate` (allow / deny
 *                  inline, or escalate). Tier 2: a per-action approval point.
 *   - HANDOFF    — an escalated permission throws `SuspendTaskError` carrying the
 *                  tool context; the host turns it into a `/me` inbox item.
 *   - RESUME     — `handleResume` answers the held permission and re-awaits the
 *                  SAME turn for its stopReason — no drift (subprocess never restarted).
 *   - TERMINATE  — `onTaskCancelled` sends ACP cancel + aborts; `onShutdown` kills.
 */

import { AgentParticipant, SuspendTaskError, type ParticipantId, type Task, type TaskId } from '@aipehub/core'

import {
  ACP_NEVER_RESUME_AT,
  acpParkState,
  dangerousToolGate,
  pickOptionId,
  readAcpCheckpointState,
  readPermissionDecision,
  toolContext,
  type AcpGateVerdict,
  type AcpReviewDecision,
  type AcpToolContext,
} from './acp-checkpoint.js'
import {
  selectedOutcome,
  cancelledOutcome,
  type AcpClientCapabilities,
  type AcpSessionUpdate,
  type AcpStopReason,
  type RequestPermissionParams,
  type RequestPermissionResult,
  updateText,
} from './acp-protocol.js'
import type { AcpTransport } from './acp-connection.js'
import {
  AcpSession,
  type AcpPendingPermission,
  type AcpPermissionVerdict,
  type AcpPromptOutcome,
} from './acp-session.js'

/** What `onChunk` receives — the OBSERVE stream, per task. */
export interface AcpChunk {
  /** Message/thought chunk text; undefined for tool_call / plan updates. */
  text: string | undefined
  /** The raw `session/update` for richer rendering (tool_call, plan, …). */
  update: AcpSessionUpdate
}

export interface AcpParticipantOptions {
  /** Local participant id (what `result.by` shows). */
  id: ParticipantId
  /** Capabilities advertised locally — dispatching these routes here. */
  capabilities: string[]
  /** The agent executable (e.g. 'npx' for `npx @zed-industries/claude-code-acp`). */
  command: string
  /** Static argv after the command. */
  args?: readonly string[]
  /** Working directory — the repo the agent operates on. */
  cwd?: string
  /** Extra env (e.g. the agent's own API key). `undefined` value deletes a key. */
  env?: Record<string, string | undefined>
  /** Inject a transport (PassThrough pair) to skip spawning — tests + the M6 gate. */
  transport?: AcpTransport
  /** ACP protocol version offered at `initialize` (default 1). */
  protocolVersion?: number
  /** Client capabilities advertised at `initialize`. */
  clientCapabilities?: AcpClientCapabilities
  /** Authenticate with this method id if the agent advertises auth methods. */
  authMethodId?: string
  /** Ceiling for the handshake. */
  initTimeoutMs?: number
  /** Per-turn ceiling — a wedged turn is aborted and the task fails. */
  promptTimeoutMs?: number
  /**
   * Real-time observe sink. The host wires this to a transcript chunk event so a
   * person watching sees the agent's output as it streams. `taskId` attributes it.
   */
  onChunk?: (taskId: TaskId, chunk: AcpChunk) => void
  /**
   * Permission gate (INTERCEPT, T2). Inspect the tool the agent wants to run;
   * allow / deny inline or escalate to a human. Default: `dangerousToolGate()`.
   */
  gate?: (ctx: AcpToolContext) => AcpGateVerdict
}

export class AcpParticipant extends AgentParticipant {
  protected readonly session: AcpSession
  protected readonly onChunkCb: ((taskId: TaskId, chunk: AcpChunk) => void) | undefined
  protected readonly gate: (ctx: AcpToolContext) => AcpGateVerdict
  protected readonly promptTimeoutMs: number | undefined

  /** Live abort handles per running task → the TERMINATE seam. */
  private readonly running = new Map<TaskId, AbortController>()
  /**
   * Escalated permissions awaiting a human, keyed by token. IN-MEMORY by design —
   * see the package README's durability boundary. A resume that can't find its
   * handle here fails loudly (the session was lost).
   */
  private readonly pendingPermissions = new Map<string, AcpPendingPermission>()
  /** Accumulated message text per in-flight task (the turn's reply). */
  private readonly taskText = new Map<TaskId, string>()
  /**
   * Single-slot reason from the last escalation. Safe because turns are serialized
   * (one escalation in flight at a time): set just before the gate returns escalate,
   * read when the prompt resolves escalated.
   */
  private pendingEscalationReason: string | undefined

  constructor(opts: AcpParticipantOptions) {
    super({ id: opts.id, capabilities: opts.capabilities })
    this.onChunkCb = opts.onChunk
    this.gate = opts.gate ?? dangerousToolGate()
    this.promptTimeoutMs = opts.promptTimeoutMs
    this.session = new AcpSession({
      command: opts.command,
      ...(opts.args ? { args: opts.args } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.transport ? { transport: opts.transport } : {}),
      ...(opts.protocolVersion !== undefined ? { protocolVersion: opts.protocolVersion } : {}),
      ...(opts.clientCapabilities ? { clientCapabilities: opts.clientCapabilities } : {}),
      ...(opts.authMethodId ? { authMethodId: opts.authMethodId } : {}),
      ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
    })
  }

  /** Expose the held session id (after the first task starts it). */
  get sessionId(): string | undefined {
    return this.session.sessionId
  }

  protected async handleTask(task: Task): Promise<unknown> {
    await this.session.ensureStarted()
    this.taskText.set(task.id, '')
    return await this.runTurn(task, payloadToText(task.payload))
  }

  /**
   * RESUME seam (MUST override — the base L11 guard fails a default re-suspend).
   * The host hands back the park state merged with the reviewer's decision. We
   * answer the still-open permission and re-await the SAME held turn.
   */
  protected async handleResume(task: Task, state: unknown): Promise<unknown> {
    const carried = readAcpCheckpointState(state)
    if (!carried) {
      // Not our park. Re-running handleTask would open a NEW turn on the held
      // session and orphan the pending permission — fail loudly instead.
      throw new Error(
        `acp participant '${this.id}' resumed without ACP checkpoint state — cannot continue a held permission`,
      )
    }
    const handle = this.pendingPermissions.get(carried.permissionToken)
    if (!handle) {
      // Q2 durability boundary: the in-memory handle is gone (hub restart / lost
      // subprocess). Fail LOUDLY, never hang — the user re-dispatches.
      throw new Error(
        `acp permission handle '${carried.permissionToken}' no longer live — the ACP session was lost ` +
          `(likely a hub restart). Re-dispatch the task.`,
      )
    }
    this.pendingPermissions.delete(carried.permissionToken)

    const decision = readPermissionDecision(state)
    const ac = new AbortController()
    this.running.set(task.id, ac)
    try {
      // Answer the held reverse request. Fail-closed: anything but an explicit
      // approval denies the tool (the agent then finishes the turn without it).
      const approved = decision?.approved === true
      const want = approved ? 'allow' : 'reject'
      const optionId = pickOptionId(handle.params.options, want)
      handle.respond(optionId ? selectedOutcome(optionId) : cancelledOutcome())

      // Re-await the SAME turn for its stopReason — no drift. The original turn's
      // OBSERVE handler (closed over this task id) keeps appending to taskText.
      const stopReason = await handle.awaitStopReason()
      return this.finish(task.id, stopReason, decision)
    } catch (err) {
      this.taskText.delete(task.id)
      throw err
    } finally {
      this.running.delete(task.id)
    }
  }

  /** Run one turn, parking on an escalated permission. */
  private async runTurn(task: Task, text: string): Promise<unknown> {
    const ac = new AbortController()
    this.running.set(task.id, ac)
    let timedOut = false
    const timer =
      this.promptTimeoutMs && this.promptTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            ac.abort()
          }, this.promptTimeoutMs)
        : undefined
    try {
      let outcome: AcpPromptOutcome
      try {
        outcome = await this.session.prompt(text, {
          signal: ac.signal,
          onUpdate: (u) => this.emitChunk(task.id, u),
          onPermission: (params) => this.decidePermission(task.id, params),
        })
      } catch (err) {
        if (timedOut) {
          this.taskText.delete(task.id)
          throw new Error(`acp prompt timed out after ${this.promptTimeoutMs}ms`)
        }
        if (ac.signal.aborted) return this.finish(task.id, 'cancelled') // TERMINATE → graceful
        this.taskText.delete(task.id)
        throw err
      }

      if (outcome.kind === 'escalated') {
        // HANDOFF: stash the live handle, park the hub task (taskText preserved for resume).
        this.pendingPermissions.set(outcome.permission.token, outcome.permission)
        throw new SuspendTaskError({
          resumeAt: ACP_NEVER_RESUME_AT,
          state: acpParkState({
            permissionToken: outcome.permission.token,
            reason: this.pendingEscalationReason ?? 'permission requires human approval',
            tool: {
              kind: outcome.permission.params.toolCall.kind,
              title: outcome.permission.params.toolCall.title,
            },
          }),
        })
      }
      return this.finish(task.id, outcome.stopReason)
    } finally {
      if (timer) clearTimeout(timer)
      this.running.delete(task.id)
    }
  }

  /** INTERCEPT: run the gate and translate its verdict into an ACP answer (or escalate). */
  private decidePermission(taskId: TaskId, params: RequestPermissionParams): AcpPermissionVerdict {
    const verdict = this.gate(toolContext(taskId, params.toolCall))
    if ('allow' in verdict) {
      return { respond: this.answer(params, 'allow') }
    }
    if ('deny' in verdict) {
      return { respond: this.answer(params, 'reject') }
    }
    // escalate → park
    this.pendingEscalationReason = verdict.reason
    return { escalate: true }
  }

  /** Build an allow/reject answer from the agent's offered options (fail-closed → cancel). */
  private answer(params: RequestPermissionParams, want: 'allow' | 'reject'): RequestPermissionResult {
    const optionId = pickOptionId(params.options, want)
    return optionId ? selectedOutcome(optionId) : cancelledOutcome()
  }

  /** OBSERVE: accumulate message text + forward the raw chunk. */
  private emitChunk(taskId: TaskId, update: AcpSessionUpdate): void {
    const text = updateText(update)
    if (text) this.taskText.set(taskId, (this.taskText.get(taskId) ?? '') + text)
    this.onChunkCb?.(taskId, { text, update })
  }

  /** Assemble the task result and release the accumulated text. */
  private finish(taskId: TaskId, stopReason: AcpStopReason, decision?: AcpReviewDecision | null): unknown {
    const text = this.taskText.get(taskId) ?? ''
    this.taskText.delete(taskId)
    return {
      text,
      stopReason,
      sessionId: this.session.sessionId,
      ...(decision ? { permissionApproved: decision.approved } : {}),
    }
  }

  /** TERMINATE seam — a person cancels the task → tell the agent + abort our wait. */
  onTaskCancelled(taskId: TaskId, _reason?: string): void {
    this.session.cancel()
    this.running.get(taskId)?.abort()
  }

  /** Shutdown → close the connection and kill the child (SIGTERM → SIGKILL). */
  async onShutdown(): Promise<void> {
    await this.session.terminate()
  }
}

/** Pull the prompt text out of a dispatched task payload (local copy — leaf purity). */
export function payloadToText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const o = payload as { prompt?: unknown; text?: unknown }
    if (typeof o.prompt === 'string') return o.prompt
    if (typeof o.text === 'string') return o.text
  }
  return JSON.stringify(payload ?? '')
}
