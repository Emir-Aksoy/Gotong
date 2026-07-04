/**
 * CliParticipant — single-shot adapter tests.
 *
 * Driven through the public `onTask` (the scheduler's entry point) so we exercise
 * the real `AgentParticipant` envelope: a returned value → `kind: 'ok'`, a thrown
 * Error → `kind: 'failed'`. The mock CLI is `process.execPath` + `-e`. Covers both
 * prompt-delivery modes (stdin / arg `{prompt}`), the observe seam (onChunk gets
 * the task id), and the terminate seam (onTaskCancelled → failed).
 */

import type { Task, TaskId } from '@gotong/core'
import { describe, expect, it } from 'vitest'

import { CliParticipant, payloadToText } from '../src/cli-participant.js'
import type { CliChunk } from '../src/cli-runner.js'

const NODE = process.execPath

function makeTask(payload: unknown, id: TaskId = 't-1'): Task {
  return { id, from: 'caller', strategy: { kind: 'capability', capabilities: ['code'] }, payload }
}

describe('CliParticipant — outbound shell-out adapter', () => {
  it('pipes the prompt to stdin (default mode) and returns stdout as ok output', async () => {
    const script =
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('echo:'+d))"
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', script],
    })
    const result = await p.onTask(makeTask({ prompt: 'fix the bug' }))
    expect(result.kind).toBe('ok')
    expect(result).toMatchObject({
      by: 'coder',
      output: { text: 'echo:fix the bug', exitCode: 0 },
    })
  })

  it('substitutes {prompt} into argv in arg mode', async () => {
    // `node -e <script> <prompt>` → the prompt lands at process.argv[1].
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', "process.stdout.write('arg:' + process.argv[1])", '{prompt}'],
      promptVia: 'arg',
    })
    const result = await p.onTask(makeTask({ prompt: 'hello world' }))
    expect(result.kind).toBe('ok')
    expect(result).toMatchObject({ output: { text: 'arg:hello world' } })
  })

  it('streams output to onChunk with the task id (observe seam)', async () => {
    const seen: Array<{ taskId: TaskId; chunk: CliChunk }> = []
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', "process.stdout.write('streaming-out')"],
      onChunk: (taskId, chunk) => seen.push({ taskId, chunk }),
    })
    await p.onTask(makeTask('go', 'task-42'))
    expect(
      seen.some((s) => s.taskId === 'task-42' && s.chunk.text.includes('streaming-out')),
    ).toBe(true)
  })

  it('maps a non-zero CLI exit to a failed task result', async () => {
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', "process.stderr.write('boom');process.exit(2)"],
    })
    const result = await p.onTask(makeTask({ prompt: 'x' }))
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.error).toMatch(/exited 2/)
  })

  it('onTaskCancelled aborts the child → failed "task cancelled" (terminate seam)', async () => {
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
    })
    const resultP = p.onTask(makeTask({ prompt: 'long' }, 'cancel-me'))
    setTimeout(() => p.onTaskCancelled('cancel-me', 'user cancel'), 50)
    const result = await resultP
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.error).toMatch(/task cancelled/)
  })

  it('fails the task when the CLI executable is missing', async () => {
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: 'gotong-no-such-cmd-xyz',
    })
    const result = await p.onTask(makeTask({ prompt: 'x' }))
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.error).toMatch(/command not found/)
  })
})

describe('payloadToText', () => {
  it('returns a string payload verbatim', () => {
    expect(payloadToText('hi')).toBe('hi')
  })
  it('prefers prompt, then text', () => {
    expect(payloadToText({ prompt: 'p', text: 't' })).toBe('p')
    expect(payloadToText({ text: 't' })).toBe('t')
  })
  it('JSON-stringifies an object with neither field', () => {
    expect(payloadToText({ a: 1 })).toBe(JSON.stringify({ a: 1 }))
  })
})

describe('CliParticipant — takeover resume still gates (audit P1 regression)', () => {
  it('a turn resumed from a takeover park must still pass the action gate', async () => {
    // The takeover checkpoint fires BEFORE the gate (checkpoint 1 vs 2), so the
    // parked turn was never gated. Resuming it must not inherit the "approval
    // consumed" skip that an action_gate resume gets — otherwise an operator
    // takeover quietly bypasses the dangerous-command gate for that turn.
    const { dangerousCommandGate, TakeoverController } = await import('../src/cli-checkpoint.js')
    const takeover = new TakeoverController()
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', "process.stdout.write('ran')"],
      gate: dangerousCommandGate(),
      takeover,
    })

    // Park via takeover before the first turn (SuspendTaskError propagates out
    // of the participant envelope — the scheduler is who maps it to 'suspended').
    takeover.requestTakeover('tk-1')
    await expect(p.onTask(makeTask({ prompt: 'rm -rf /tmp/x' }, 'tk-1'))).rejects.toMatchObject({
      state: expect.objectContaining({ kind: 'takeover' }),
    })

    // Resume with a takeover decision; the dangerous prompt must hit the gate
    // and park again as action_gate — NOT spawn the CLI.
    const state = { v: 1, turn: 0, prompt: 'rm -rf /tmp/x', kind: 'takeover', reason: 'takeover requested', transcript: [] }
    await expect(
      p.onResume(makeTask({ prompt: 'rm -rf /tmp/x' }, 'tk-1'), {
        ...state,
        decision: { approved: true },
      }),
    ).rejects.toMatchObject({
      state: expect.objectContaining({ kind: 'action_gate' }),
    })
  })

  it('an action_gate resume with approval still skips re-gating that turn', async () => {
    const { dangerousCommandGate } = await import('../src/cli-checkpoint.js')
    const p = new CliParticipant({
      id: 'coder',
      capabilities: ['code'],
      command: NODE,
      args: ['-e', "process.stdout.write('ran')"],
      gate: dangerousCommandGate(),
    })
    const state = { v: 1, turn: 0, prompt: 'rm -rf /tmp/x', kind: 'action_gate', reason: 'flagged', transcript: [] }
    const resumed = await p.onResume(makeTask({ prompt: 'rm -rf /tmp/x' }, 'ag-1'), {
      ...state,
      decision: { approved: true },
    })
    expect(resumed.kind).toBe('ok')
  })
})
