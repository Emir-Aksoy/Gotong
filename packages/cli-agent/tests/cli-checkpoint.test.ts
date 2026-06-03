/**
 * CliParticipant checkpoint loop — the INTERCEPT / HANDOFF / RESUME / T2-gate seams.
 *
 * No host: we drive `onTask` / `onResume` directly and inspect the thrown
 * `SuspendTaskError` (a park) and the returned `TaskResult`. The mock CLI is
 * `process.execPath` + `-e`.
 */

import { SuspendTaskError, isSuspendTaskError, type Task, type TaskId } from '@aipehub/core'
import { describe, expect, it } from 'vitest'

import {
  CliParticipant,
  TakeoverController,
  dangerousCommandGate,
  readReviewDecision,
  CLI_NEVER_RESUME_AT,
  type CliCheckpointState,
  type CliChunk,
} from '../src/index.js'

const NODE = process.execPath
const STDIN_ECHO =
  "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('echo:'+d))"

function makeTask(payload: unknown, id: TaskId = 't-1'): Task {
  return { id, from: 'caller', strategy: { kind: 'capability', capabilities: ['code'] }, payload }
}

/** Drive onTask and capture the SuspendTaskError it parks with. */
async function expectPark(p: CliParticipant, task: Task): Promise<SuspendTaskError> {
  try {
    await p.onTask(task)
  } catch (e) {
    if (isSuspendTaskError(e)) return e as SuspendTaskError
    throw e
  }
  throw new Error('expected the task to park, but it completed')
}

function outputOf(result: { output?: unknown }): {
  text: string
  turns: number
  transcript: Array<{ output: string }>
} {
  return result.output as { text: string; turns: number; transcript: Array<{ output: string }> }
}

describe('dangerousCommandGate', () => {
  const gate = dangerousCommandGate()
  it('parks on destructive command patterns', () => {
    expect(gate({ taskId: 't', turn: 0, command: 'bash', args: ['-c', 'rm -rf /'], prompt: '' })).toMatchObject({ park: true })
    expect(gate({ taskId: 't', turn: 0, command: 'git', args: ['push'], prompt: '' })).toMatchObject({ park: true })
    expect(gate({ taskId: 't', turn: 0, command: 'sh', args: [], prompt: 'please sudo apt remove' })).toMatchObject({ park: true })
  })
  it('allows benign invocations', () => {
    expect(gate({ taskId: 't', turn: 0, command: 'ls', args: ['-la'], prompt: 'list the files' })).toEqual({ allow: true })
  })
})

describe('readReviewDecision', () => {
  it('reads the timer-sweep `decision` shape', () => {
    expect(readReviewDecision({ decision: { approved: false, prompt: 'x' } })).toEqual({
      approved: false,
      prompt: 'x',
    })
  })
  it('reads the inbox `answer` shape', () => {
    expect(readReviewDecision({ answer: { approved: true } })).toEqual({ approved: true })
  })
  it('returns null when no decision is present', () => {
    expect(readReviewDecision({})).toBeNull()
    expect(readReviewDecision(null)).toBeNull()
  })
})

describe('CliParticipant — action gate (T2)', () => {
  it('parks before spawning when the gate trips, and never runs the CLI', async () => {
    const chunks: CliChunk[] = []
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', "process.stdout.write('RAN')"],
      gate: () => ({ park: true, reason: 'looks dangerous' }),
      onChunk: (_id, c) => chunks.push(c),
    })
    const err = await expectPark(p, makeTask({ prompt: 'rm everything' }))
    expect(err.resumeAt).toBe(CLI_NEVER_RESUME_AT)
    const st = err.state as CliCheckpointState
    expect(st.kind).toBe('action_gate')
    expect(st.reason).toBe('looks dangerous')
    expect(chunks).toHaveLength(0) // gate parks BEFORE any spawn
  })

  it('resume with approval runs the previously-gated invocation', async () => {
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', "process.stdout.write('RAN')"],
      gate: () => ({ park: true, reason: 'dangerous' }),
    })
    const err = await expectPark(p, makeTask({ prompt: 'x' }))
    const result = await p.onResume(makeTask({ prompt: 'x' }), {
      ...(err.state as object),
      decision: { approved: true },
    })
    expect(result.kind).toBe('ok')
    expect(outputOf(result as { output: unknown }).text).toBe('RAN')
  })

  it('resume with denial fails fail-closed and never runs the CLI', async () => {
    const chunks: CliChunk[] = []
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', "process.stdout.write('RAN')"],
      gate: () => ({ park: true, reason: 'dangerous' }),
      onChunk: (_id, c) => chunks.push(c),
    })
    const err = await expectPark(p, makeTask({ prompt: 'x' }))
    const result = await p.onResume(makeTask({ prompt: 'x' }), {
      ...(err.state as object),
      decision: { approved: false, note: 'too risky' },
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.error).toMatch(/denied/)
    expect(chunks).toHaveLength(0)
  })
})

describe('CliParticipant — takeover (intercept / handoff)', () => {
  it('parks at the next checkpoint when a takeover is requested', async () => {
    const takeover = new TakeoverController()
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', STDIN_ECHO],
      takeover,
    })
    takeover.requestTakeover('take-1')
    const err = await expectPark(p, makeTask({ prompt: 'hello' }, 'take-1'))
    expect((err.state as CliCheckpointState).kind).toBe('takeover')
  })

  it('resume continues the task and clears the takeover flag', async () => {
    const takeover = new TakeoverController()
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', STDIN_ECHO],
      takeover,
    })
    takeover.requestTakeover('take-2')
    const err = await expectPark(p, makeTask({ prompt: 'hello' }, 'take-2'))
    const result = await p.onResume(makeTask({ prompt: 'hello' }, 'take-2'), {
      ...(err.state as object),
      decision: { approved: true },
    })
    expect(result.kind).toBe('ok')
    expect(takeover.isRequested('take-2')).toBe(false)
    expect(outputOf(result as { output: unknown }).text).toBe('echo:hello')
  })

  it('a reviewer can steer by editing the prompt on resume (handoff)', async () => {
    const takeover = new TakeoverController()
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', "process.stdout.write('p:' + process.argv[1])", '{prompt}'],
      promptVia: 'arg',
      takeover,
    })
    takeover.requestTakeover('hand-1')
    const err = await expectPark(p, makeTask({ prompt: 'original' }, 'hand-1'))
    const result = await p.onResume(makeTask({ prompt: 'original' }, 'hand-1'), {
      ...(err.state as object),
      decision: { approved: true, prompt: 'edited-by-reviewer' },
    })
    expect(result.kind).toBe('ok')
    expect(outputOf(result as { output: unknown }).text).toBe('p:edited-by-reviewer')
  })
})

describe('CliParticipant — multi-turn loop', () => {
  it('runs bounded turns via the next() continuation', async () => {
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', STDIN_ECHO],
      promptVia: 'stdin',
      maxTurns: 2,
      next: (_result, ctx) => (ctx.turn === 0 ? 'second' : null),
    })
    const result = await p.onTask(makeTask('first'))
    expect(result.kind).toBe('ok')
    const out = outputOf(result as { output: unknown })
    expect(out.turns).toBe(2)
    expect(out.text).toBe('echo:second')
    expect(out.transcript[0]!.output).toBe('echo:first')
  })

  it('caps at maxTurns even if next keeps asking for more', async () => {
    let asked = 0
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', STDIN_ECHO],
      promptVia: 'stdin',
      maxTurns: 1,
      next: () => {
        asked += 1
        return 'again'
      },
    })
    const result = await p.onTask(makeTask('only'))
    expect(result.kind).toBe('ok')
    expect(outputOf(result as { output: unknown }).turns).toBe(1)
    expect(asked).toBe(1) // consulted once, but the loop is bounded
  })
})
