/**
 * CliParticipant — single-shot adapter tests.
 *
 * Driven through the public `onTask` (the scheduler's entry point) so we exercise
 * the real `AgentParticipant` envelope: a returned value → `kind: 'ok'`, a thrown
 * Error → `kind: 'failed'`. The mock CLI is `process.execPath` + `-e`. Covers both
 * prompt-delivery modes (stdin / arg `{prompt}`), the observe seam (onChunk gets
 * the task id), and the terminate seam (onTaskCancelled → failed).
 */

import type { Task, TaskId } from '@aipehub/core'
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
      command: 'aipe-no-such-cmd-xyz',
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
