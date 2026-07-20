import type { TranscriptEntry } from '@gotong/core'
import { describe as renderLine } from '../src/transcript-line.js'
import { describe, expect, it } from 'vitest'

/** Wrap a payload as the entry shape `describe()` receives. */
function entry(kind: string, data: unknown): TranscriptEntry {
  return { seq: 1, ts: 0, kind, data } as unknown as TranscriptEntry
}

/**
 * One sample per `kind`, as of core's TranscriptEntry union today.
 *
 * A *missing* kind is caught by the compiler, not by this list: `describe()`
 * declares `: string` and its switch has no default, so adding a kind to the
 * union fails `typecheck` (TS2366) until someone renders it. What this list
 * catches is the half the compiler can't see — that the line each kind
 * produces is actually usable.
 */
const SAMPLES: Record<string, unknown> = {
  participant_joined: { id: 'agent-a', participantKind: 'agent', capabilities: ['chat', 'plan'] },
  participant_left: { id: 'agent-a' },
  message: { from: 'alice', channel: 'general' },
  task: { from: 'alice', title: 'ship it', strategy: { kind: 'capability' } },
  task_result: { kind: 'ok', by: 'agent-a' },
  agent_pending: { id: 'app-1', agents: [{ id: 'a1' }, { id: 'a2' }] },
  agent_approved: { applicationId: 'app-1', agentIds: ['a1'], by: 'owner' },
  agent_rejected: { applicationId: 'app-1', by: 'owner', reason: 'no' },
  evaluation: { taskId: 't1', rating: 5, by: 'alice' },
  service_trashed: { type: 'memory', impl: 'file', ownerKind: 'user', ownerId: 'u1', ref: { id: 'r1' } },
  service_purged: { type: 'memory', impl: 'file', trashId: 'tr1' },
  service_call: { from: 'a1', type: 'memory', impl: 'file', method: 'get', outcome: 'ok', durationMs: 3 },
  llm_stream_chunk: { agentId: 'a1', taskId: 't1', chunk: { type: 'text' } },
  task_resumed: { taskId: 't1', by: 'a1' },
}

describe('describe() — one line per transcript kind', () => {
  it.each(Object.keys(SAMPLES))('renders a non-empty line for %s', (kind) => {
    const line = renderLine(entry(kind, SAMPLES[kind]))
    expect(line).toBeTruthy()
    expect(line.trim().length).toBeGreaterThan(0)
  })

  it('pads every verb to the same column so the log stays aligned', () => {
    // Alignment is the whole reason these verbs carry trailing spaces. Assert
    // the property that actually matters — the payload starts at one column —
    // rather than a max length, which a mis-padded verb would still satisfy.
    const columns = Object.keys(SAMPLES).map((k) => {
      const line = renderLine(entry(k, SAMPLES[k]))
      return { kind: k, at: line.length - line.replace(/^\S+\s+/, '').length }
    })
    for (const c of columns) expect(c).toEqual({ kind: c.kind, at: 9 })
  })

  it('covers every task_result variant, including the parked one', () => {
    expect(renderLine(entry('task_result', { kind: 'ok', by: 'a1' }))).toContain('ok by a1')
    expect(renderLine(entry('task_result', { kind: 'failed', by: 'a1', error: 'boom' }))).toContain('boom')
    expect(renderLine(entry('task_result', { kind: 'cancelled', reason: 'user' }))).toContain('cancelled')
    // Phase 11 M2 — a suspended task must show WHEN it wakes, or an operator
    // tailing stdout can't tell "parked" from "hung".
    const parked = renderLine(entry('task_result', { kind: 'suspended', by: 'a1', resumeAt: 0 }))
    expect(parked).toContain('suspended by a1')
    expect(parked).toContain('1970-01-01T00:00:00.000Z')
    expect(renderLine(entry('task_result', { kind: 'no_participant', reason: 'none' }))).toContain('no_participant')
  })

  it('reports the SHAPE of bulky payloads, never their content', () => {
    // stdout is not the transcript. A chunk's text and a service call's result
    // belong in `.gotong/` and the admin views — leaking them here would make
    // the host log an unreviewed copy of everything the agents said.
    const line = renderLine(
      entry('llm_stream_chunk', { agentId: 'a1', taskId: 't1', chunk: { type: 'text', text: 'SECRET-PAYLOAD' } }),
    )
    expect(line).toContain('text')
    expect(line).not.toContain('SECRET-PAYLOAD')
  })

  it('degrades on a missing optional instead of printing undefined', () => {
    expect(renderLine(entry('task', { from: 'alice', strategy: { kind: 'capability' } }))).toContain('(untitled)')
    expect(renderLine(entry('llm_stream_chunk', { agentId: 'a1', taskId: 't1', chunk: null }))).toContain('?')
  })
})
