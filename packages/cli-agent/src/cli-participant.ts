/**
 * CliParticipant — outbound shell-out edge for a self-hosted coding-agent CLI.
 *
 * A local hub `Participant` that drives an external CLI (Claude Code, Codex,
 * OpenCode, Aider, …): the dispatched task's prompt goes in, the CLI's stdout
 * comes back as the task output. The mirror of `aipehub connect` (inbound: the
 * CLI calls the hub as an MCP client) — here the hub drives the CLI.
 *
 * This is the M1 single-shot core (one invocation per task) + the two cheapest
 * control seams from AGENT-ADAPTER-CONTRACT:
 *   - OBSERVE: stdout/stderr stream to `onChunk` in real time (host → transcript)
 *   - TERMINATE: `onTaskCancelled` aborts the child (SIGTERM→SIGKILL)
 * The checkpoint loop + on-demand park (intercept) + resume land in M2 on top of
 * this — `handleTask` becomes a loop, but the spawn/observe/terminate plumbing is
 * unchanged.
 */

import { AgentParticipant, type ParticipantId, type Task, type TaskId } from '@aipehub/core'

import { runCliCommand, type CliChunk } from './cli-runner.js'

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
}

export class CliParticipant extends AgentParticipant {
  protected readonly command: string
  protected readonly args: readonly string[]
  protected readonly promptVia: 'stdin' | 'arg'
  protected readonly cwd: string | undefined
  protected readonly env: Record<string, string | undefined> | undefined
  protected readonly timeoutMs: number | undefined
  protected readonly onChunk: ((taskId: TaskId, chunk: CliChunk) => void) | undefined

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
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const prompt = payloadToText(task.payload)
    const ac = new AbortController()
    this.running.set(task.id, ac)
    try {
      const result = await runCliCommand({
        command: this.command,
        args: this.buildArgs(prompt),
        signal: ac.signal,
        ...(this.cwd ? { cwd: this.cwd } : {}),
        ...(this.env ? { env: this.env } : {}),
        ...(this.promptVia === 'stdin' ? { input: prompt } : {}),
        ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
        ...(this.onChunk ? { onChunk: (c: CliChunk) => this.onChunk!(task.id, c) } : {}),
      })
      if (result.aborted) throw new Error('task cancelled')
      if (result.timedOut) throw new Error(`CLI '${this.command}' timed out after ${this.timeoutMs}ms`)
      if (result.exitCode !== 0) {
        throw new Error(
          `CLI '${this.command}' exited ${result.exitCode}: ${tail(result.stderr) || tail(result.stdout)}`,
        )
      }
      return { text: result.stdout.trim(), exitCode: result.exitCode }
    } finally {
      this.running.delete(task.id)
    }
  }

  /** Place the prompt into argv when in arg mode; static argv otherwise. */
  protected buildArgs(prompt: string): string[] {
    if (this.promptVia !== 'arg') return [...this.args]
    return this.args.map((a) => a.split(PROMPT_TOKEN).join(prompt))
  }

  /** TERMINATE seam — a person cancels the task → kill the child process. */
  onTaskCancelled(taskId: TaskId): void {
    this.running.get(taskId)?.abort()
  }
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
