/**
 * REPL main loop — read a line, parse, act, repeat.
 *
 * The loop is structured around an `ReplIo` interface so tests can
 * drive scripted inputs/outputs without touching real stdin/stdout
 * (production wires it to `node:readline/promises`; see
 * `commands/repl.ts`).
 *
 * Flow per turn:
 *
 *   1. `io.read(prompt)` → user line (or `null` = EOF / Ctrl-D / abort).
 *   2. `parseReplCommand(line)` → discriminated `ReplCommand`.
 *   3. Switch over kind:
 *      - meta commands write inline output via `io.write`
 *      - free / dispatch commands call `hub.dispatch(…)`, render
 *        the result.
 *   4. Loop unless `:quit` or EOF.
 *
 * Errors during dispatch are caught and rendered — a single bad turn
 * must never take the loop down (that would be a worse REPL UX than
 * any IDE chat shell). Anything that escapes here is a bug.
 */

import type { DispatchStrategy, Hub, ParticipantId, TaskResult, TranscriptEntry } from '@gotong/core'

import { parseReplCommand, type ReplCommand } from './parse.js'

export interface ReplIo {
  /**
   * Read one line of input (without trailing newline). Returns
   * `null` on EOF / aborted / closed input — the loop treats that
   * as `:quit`.
   *
   * `prompt` is what the IO should display before reading (readline
   * passes it directly; fakes can ignore).
   */
  read(prompt: string): Promise<string | null>
  /**
   * Write a chunk of output. The loop is responsible for newlines
   * (so a single dispatch reply can be multi-line without the IO
   * second-guessing).
   */
  write(chunk: string): void
  /** Close any held resources (e.g. readline interface). Idempotent. */
  close(): Promise<void> | void
}

export interface RunReplLoopDeps {
  io: ReplIo
  hub: Hub
  /**
   * Capability list passed to `Hub.dispatch` for free-text turns.
   * Default is set by `createReplHub`; the loop just trusts it.
   */
  defaultCapability: readonly string[]
  /** Prompt string passed to each `io.read`. Default `'> '`. */
  prompt?: string
  /**
   * Participant id used as `Task.from`. Default `'repl-user'` —
   * shows up in transcript so admin-UI viewers can tell which side
   * of the dispatch is the human.
   */
  fromId?: ParticipantId
}

export interface ReplLoopResult {
  /** How many lines were processed (counts noop / unknown too). */
  turns: number
  /** Reason the loop ended: `'eof'`, `'quit'`, `'aborted'`. */
  reason: 'eof' | 'quit' | 'aborted'
}

const DEFAULT_PROMPT = '> '
const DEFAULT_FROM_ID = 'repl-user'

export async function runReplLoop(deps: RunReplLoopDeps): Promise<ReplLoopResult> {
  const prompt = deps.prompt ?? DEFAULT_PROMPT
  const fromId = deps.fromId ?? DEFAULT_FROM_ID
  let turns = 0
  let reason: ReplLoopResult['reason'] = 'eof'

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let line: string | null
    try {
      line = await deps.io.read(prompt)
    } catch (err) {
      // Aborted read (e.g. SIGINT closing readline) — exit gracefully.
      // We don't surface the error: the user just pressed Ctrl-C and
      // doesn't want a stack trace.
      reason = 'aborted'
      deps.io.write(`\n[repl] aborted: ${err instanceof Error ? err.message : String(err)}\n`)
      break
    }
    if (line === null) {
      reason = 'eof'
      // Match common REPL UX (python, node): print a newline before
      // exiting so the shell prompt lands on its own line.
      deps.io.write('\n')
      break
    }

    turns++
    const cmd = parseReplCommand(line)

    if (cmd.kind === 'quit') {
      reason = 'quit'
      deps.io.write('bye!\n')
      break
    }

    try {
      await handleOne(cmd, deps, fromId)
    } catch (err) {
      // Catastrophic — print + continue so the loop survives.
      deps.io.write(
        `[repl] error handling turn: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  await deps.io.close()
  return { turns, reason }
}

// ---------------------------------------------------------------------------
// Per-turn handler. Exported so tests can drive individual commands
// without running the whole loop.
// ---------------------------------------------------------------------------

export async function handleOne(
  cmd: ReplCommand,
  deps: RunReplLoopDeps,
  fromId: ParticipantId,
): Promise<void> {
  switch (cmd.kind) {
    case 'noop':
      return
    case 'help':
      deps.io.write(helpText() + '\n')
      return
    case 'agents': {
      const list = deps.hub.participants()
      if (list.length === 0) {
        deps.io.write('(no agents registered)\n')
        return
      }
      for (const p of list) {
        deps.io.write(
          `  ${p.id}${p.capabilities.length ? ' [' + p.capabilities.join(',') + ']' : ''}\n`,
        )
      }
      return
    }
    case 'transcript': {
      // `Hub.transcript.all()` is the documented snapshot API. Slice
      // off the tail; if fewer entries than asked, print what we have.
      const all = deps.hub.transcript.all()
      const tail = all.slice(-cmd.lastN)
      if (tail.length === 0) {
        deps.io.write('(transcript is empty)\n')
        return
      }
      deps.io.write(`(last ${tail.length} of ${all.length} entries)\n`)
      for (const e of tail) {
        deps.io.write(`  ${formatTranscriptEntry(e)}\n`)
      }
      return
    }
    case 'dispatch': {
      const result = await deps.hub.dispatch({
        from: fromId,
        strategy: { kind: 'explicit', to: cmd.agentId },
        payload: { text: cmd.text },
        title: `repl:dispatch:${cmd.agentId}`,
      })
      writeResult(deps.io, result)
      return
    }
    case 'free': {
      const result = await deps.hub.dispatch({
        from: fromId,
        strategy: { kind: 'capability', capabilities: [...deps.defaultCapability] },
        payload: { text: cmd.text },
        title: 'repl:free',
      })
      writeResult(deps.io, result)
      return
    }
    case 'unknown':
      deps.io.write(`(unknown command \`:${cmd.verb}\` — type :help for the list)\n`)
      return
    case 'quit':
      // Handled in the loop, but be exhaustive — fall through to a no-op.
      return
    default: {
      const _exhaustive: never = cmd
      void _exhaustive
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers — kept simple, no colour, no emoji unless the
// agent's own output contains them.
// ---------------------------------------------------------------------------

function helpText(): string {
  return [
    'REPL commands (start with `:`):',
    '  :help, :h, :?            this list',
    '  :agents, :who, :ls       list registered agents and capabilities',
    '  :transcript [n], :t [n]  show the last n transcript entries (default 5)',
    '  :dispatch <id> <text>    dispatch text to an explicit agent id',
    '  :quit, :q, :exit         exit the REPL',
    '',
    'Anything else is free text — dispatched to the default capability',
    '(see startup banner).',
  ].join('\n')
}

function writeResult(io: ReplIo, result: TaskResult): void {
  switch (result.kind) {
    case 'ok': {
      const out = result.output
      // Common shape: `{ text: '…' }`. Otherwise pretty-print.
      if (
        typeof out === 'object' &&
        out !== null &&
        'text' in out &&
        typeof (out as { text: unknown }).text === 'string'
      ) {
        io.write(`${(out as { text: string }).text}\n`)
        return
      }
      try {
        io.write(JSON.stringify(out, null, 2) + '\n')
      } catch {
        io.write(String(out) + '\n')
      }
      return
    }
    case 'failed':
      io.write(`(dispatch failed: ${result.error})\n`)
      return
    case 'cancelled':
      io.write(`(dispatch cancelled: ${result.reason})\n`)
      return
    case 'suspended':
      io.write(
        `(dispatch suspended; agent will resume around ${new Date(result.resumeAt).toISOString()})\n`,
      )
      return
    case 'no_participant':
      io.write(`(no agent matched: ${result.reason})\n`)
      return
  }
}

function formatTranscriptEntry(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'task':
      return `TASK     ${e.data.from} → ${describeStrategy(e.data.strategy)}  "${e.data.title ?? '(untitled)'}"`
    case 'task_result':
      switch (e.data.kind) {
        case 'ok':
          return `RESULT   ok by ${e.data.by}`
        case 'failed':
          return `RESULT   failed by ${e.data.by}: ${e.data.error}`
        case 'cancelled':
          return `RESULT   cancelled: ${e.data.reason}`
        case 'suspended':
          return `RESULT   suspended by ${e.data.by}`
        case 'no_participant':
          return `RESULT   no_participant: ${e.data.reason}`
      }
      // exhaustive
      return e.kind
    case 'participant_joined':
      return `JOIN     ${e.data.id} [${e.data.capabilities.join(',')}]`
    case 'participant_left':
      return `LEAVE    ${e.data.id}`
    default:
      return e.kind
  }
}

function describeStrategy(s: DispatchStrategy): string {
  switch (s.kind) {
    case 'explicit':
      return `explicit:${s.to}`
    case 'capability':
      return `caps:[${s.capabilities.join(',')}]`
    case 'broadcast':
      return `broadcast${s.capabilities ? `:caps:[${s.capabilities.join(',')}]` : ''}`
  }
}
