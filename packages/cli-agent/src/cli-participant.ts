/**
 * CliParticipant — outbound shell-out edge for a self-hosted coding-agent CLI.
 *
 * A local hub `Participant` that drives an external CLI (Claude Code, Codex,
 * OpenCode, Aider, …): the dispatched task's prompt goes in, the CLI's stdout
 * comes back as the task output. The mirror of `aipehub connect` (inbound: the
 * CLI calls the hub as an MCP client) — here the hub drives the CLI.
 *
 * All five AGENT-ADAPTER-CONTRACT control seams:
 *   - OBSERVE    — stdout/stderr stream to `onChunk` in real time (host → transcript)
 *   - INTERCEPT  — a cooperative `TakeoverController` flag parks the task between turns
 *   - HANDOFF    — a parked task carries its state to a human, who can edit the prompt
 *   - RESUME     — `onResume` reads the reviewer's decision and continues the loop
 *   - TERMINATE  — `onTaskCancelled` aborts the child (SIGTERM→SIGKILL)
 *
 * Execution is a bounded TURN loop. Default `maxTurns: 1` (no gate, no takeover) is
 * exactly the M1 single-shot run. Raise it + supply `next`/`gate`/`takeover` to get
 * a multi-turn conversation with checkpoints.
 */

import { AgentParticipant, SuspendTaskError, type ParticipantId, type Task, type TaskId } from '@aipehub/core'

import {
  CLI_CHECKPOINT_STATE_V,
  CLI_NEVER_RESUME_AT,
  readCheckpointState,
  readReviewDecision,
  type CliCheckpointState,
  type CliGateVerdict,
  type CliParkKind,
  type CliTurnContext,
  type CliTurnRecord,
  TakeoverController,
} from './cli-checkpoint.js'
import { runCliCommand, type CliChunk, type CliRunResult } from './cli-runner.js'

const PROMPT_TOKEN = '{prompt}'

export interface CliParticipantOptions {
  /** Local participant id (what `result.by` shows). */
  id: ParticipantId
  /** Capabilities advertised locally — dispatching these routes here. */
  capabilities: string[]
  /** The CLI executable (e.g. 'claude', 'codex', 'opencode', 'aider'). */
  command: string
  /** Static argv after the command (flags). `{prompt}` tokens are filled in arg mode. */
  args?: readonly string[]
  /**
   * How the task prompt reaches the CLI: piped to stdin (default) or substituted
   * for the `{prompt}` token in args. Pick per-CLI: `claude -p "{prompt}"` wants
   * arg mode; a CLI that reads the task from stdin wants stdin mode.
   */
  promptVia?: 'stdin' | 'arg'
  /** Working directory — the repo the agent operates on. */
  cwd?: string
  /** Extra env (e.g. the CLI's own API key). `undefined` value deletes a key. */
  env?: Record<string, string | undefined>
  /** Hard per-invocation timeout. A wedged CLI is killed and the task fails. */
  timeoutMs?: number
  /**
   * Real-time observe sink. The host wires this to a transcript chunk event so a
   * person watching `/me` or admin sees the CLI's output as it streams, not just
   * a blob at the end. `taskId` attributes the chunk to the right task.
   */
  onChunk?: (taskId: TaskId, chunk: CliChunk) => void
  /**
   * Max CLI invocations for one task. Default 1 = single-shot. Raise it (with
   * `next`) for a multi-turn conversation; it bounds the loop so a runaway
   * continuation can't spin forever.
   */
  maxTurns?: number
  /**
   * Pre-spawn action gate (T2). Inspect the about-to-run invocation; return
   * `{ park, reason }` to suspend for human approval before it runs, or
   * `{ allow: true }` to proceed. See `dangerousCommandGate`.
   */
  gate?: (ctx: CliTurnContext) => CliGateVerdict
  /**
   * Continuation decision after a turn finishes. Return the next prompt to run
   * another turn (up to `maxTurns`), or `null` to finish. Default: finish after
   * the first turn.
   */
  next?: (result: CliRunResult, ctx: CliTurnContext) => string | null
  /**
   * Cooperative takeover switch (intercept/handoff). Checked before each turn; a
   * requested takeover parks the task for a human to steer.
   */
  takeover?: TakeoverController
}

export class CliParticipant extends AgentParticipant {
  protected readonly command: string
  protected readonly args: readonly string[]
  protected readonly promptVia: 'stdin' | 'arg'
  protected readonly cwd: string | undefined
  protected readonly env: Record<string, string | undefined> | undefined
  protected readonly timeoutMs: number | undefined
  protected readonly onChunk: ((taskId: TaskId, chunk: CliChunk) => void) | undefined
  protected readonly maxTurns: number
  protected readonly gate: ((ctx: CliTurnContext) => CliGateVerdict) | undefined
  protected readonly next: ((result: CliRunResult, ctx: CliTurnContext) => string | null) | undefined
  protected readonly takeover: TakeoverController | undefined

  /** Live abort handles per running task → `onTaskCancelled` kills the child. */
  private readonly running = new Map<TaskId, AbortController>()

  constructor(opts: CliParticipantOptions) {
    super({ id: opts.id, capabilities: opts.capabilities })
    this.command = opts.command
    this.args = opts.args ?? []
    this.promptVia = opts.promptVia ?? 'stdin'
    this.cwd = opts.cwd
    this.env = opts.env
    this.timeoutMs = opts.timeoutMs
    this.onChunk = opts.onChunk
    this.maxTurns = opts.maxTurns && opts.maxTurns > 0 ? opts.maxTurns : 1
    this.gate = opts.gate
    this.next = opts.next
    this.takeover = opts.takeover
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const initial: CliCheckpointState = {
      v: CLI_CHECKPOINT_STATE_V,
      turn: 0,
      prompt: payloadToText(task.payload),
      kind: 'action_gate',
      reason: '',
      transcript: [],
    }
    return await this.runLoop(task, initial, false)
  }

  /**
   * RESUME seam. The host hands back `{ ...persistedCheckpointState, decision }`
   * (or an inbox-style `{ answer }`). Continue the loop from where it parked.
   */
  protected async handleResume(task: Task, state: unknown): Promise<unknown> {
    const carried = readCheckpointState(state)
    // No checkpoint state → a plain resume; re-run from the top (base default).
    if (!carried) return await this.handleTask(task)

    const decision = readReviewDecision(state)
    if (carried.kind === 'action_gate' && !decision?.approved) {
      // Fail-closed: a flagged invocation only proceeds on explicit approval.
      const note = decision?.note ? ` (${decision.note})` : ''
      throw new Error(`CLI action denied at turn ${carried.turn}: ${carried.reason}${note}`)
    }
    // Takeover handled → clear the flag so the same turn doesn't re-park.
    if (carried.kind === 'takeover') this.takeover?.clear(task.id)

    const resumed: CliCheckpointState = {
      ...carried,
      // A reviewer may steer by editing the prompt (handoff).
      prompt: decision?.prompt ?? carried.prompt,
    }
    // Approval is consumed for THIS turn — don't re-gate the invocation we just
    // approved; later turns gate normally.
    return await this.runLoop(task, resumed, true)
  }

  /** The bounded turn loop: checkpoint → spawn → record → continue. */
  private async runLoop(
    task: Task,
    state: CliCheckpointState,
    skipGateThisTurn: boolean,
  ): Promise<unknown> {
    const ac = new AbortController()
    this.running.set(task.id, ac)
    try {
      let turn = state.turn
      let prompt = state.prompt
      let skipGate = skipGateThisTurn
      const transcript: CliTurnRecord[] = [...state.transcript]

      while (turn < this.maxTurns) {
        const ctx: CliTurnContext = {
          taskId: task.id,
          turn,
          command: this.command,
          args: this.buildArgs(prompt),
          prompt,
        }

        // Checkpoint 1 — cooperative takeover (intercept / handoff).
        if (this.takeover?.isRequested(task.id)) {
          throw new SuspendTaskError({
            resumeAt: CLI_NEVER_RESUME_AT,
            state: parkState(turn, prompt, 'takeover', 'takeover requested', transcript),
          })
        }
        // Checkpoint 2 — pre-spawn action gate (T2).
        if (!skipGate && this.gate) {
          const verdict = this.gate(ctx)
          if ('park' in verdict) {
            throw new SuspendTaskError({
              resumeAt: CLI_NEVER_RESUME_AT,
              state: parkState(turn, prompt, 'action_gate', verdict.reason, transcript),
            })
          }
        }
        skipGate = false

        const result = await this.invoke(ctx, ac)
        transcript.push({ turn, prompt, exitCode: result.exitCode, output: result.stdout.trim() })

        const nextPrompt = this.next ? this.next(result, ctx) : null
        if (nextPrompt == null) break
        prompt = nextPrompt
        turn += 1
      }

      const last = transcript[transcript.length - 1]
      return {
        text: last?.output ?? '',
        exitCode: last?.exitCode ?? 0,
        turns: transcript.length,
        transcript,
      }
    } finally {
      this.running.delete(task.id)
    }
  }

  /** One bounded CLI invocation; throws on abort / timeout / non-zero exit. */
  private async invoke(ctx: CliTurnContext, ac: AbortController): Promise<CliRunResult> {
    const result = await runCliCommand({
      command: this.command,
      args: ctx.args,
      signal: ac.signal,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(this.env ? { env: this.env } : {}),
      ...(this.promptVia === 'stdin' ? { input: ctx.prompt } : {}),
      ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
      ...(this.onChunk ? { onChunk: (c: CliChunk) => this.onChunk!(ctx.taskId, c) } : {}),
    })
    if (result.aborted) throw new Error('task cancelled')
    if (result.timedOut) throw new Error(`CLI '${this.command}' timed out after ${this.timeoutMs}ms`)
    if (result.exitCode !== 0) {
      throw new Error(
        `CLI '${this.command}' exited ${result.exitCode}: ${tail(result.stderr) || tail(result.stdout)}`,
      )
    }
    return result
  }

  /** Place the prompt into argv when in arg mode; static argv otherwise. */
  protected buildArgs(prompt: string): string[] {
    if (this.promptVia !== 'arg') return [...this.args]
    return this.args.map((a) => a.split(PROMPT_TOKEN).join(prompt))
  }

  /** TERMINATE seam — a person cancels the task → kill the child process. */
  onTaskCancelled(taskId: TaskId, _reason?: string): void {
    this.running.get(taskId)?.abort()
  }
}

/** Assemble the state that rides a `SuspendTaskError` across a park. */
function parkState(
  turn: number,
  prompt: string,
  kind: CliParkKind,
  reason: string,
  transcript: CliTurnRecord[],
): CliCheckpointState {
  return { v: CLI_CHECKPOINT_STATE_V, turn, prompt, kind, reason, transcript }
}

/** Pull the prompt text out of a dispatched task payload. */
export function payloadToText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const o = payload as { prompt?: unknown; text?: unknown }
    if (typeof o.prompt === 'string') return o.prompt
    if (typeof o.text === 'string') return o.text
  }
  return JSON.stringify(payload ?? '')
}

/** Keep the tail of stderr/stdout for an error message, bounded. */
function tail(s: string, max = 400): string {
  const t = s.trim()
  return t.length <= max ? t : t.slice(-max)
}
