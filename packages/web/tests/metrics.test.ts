/**
 * Unit tests for the Prometheus-style metrics renderer.
 *
 * Calls `renderMetrics(hub)` directly against a real Hub (with a
 * temp-dir Space, no plugins). Verifies:
 *   1. Output is valid OpenMetrics text — TYPE annotations match metric
 *      names, label values are quoted.
 *   2. Counters reflect events that landed in the transcript.
 *   3. Empty states (no participants / no calls yet) still emit a
 *      zero-valued sample so scrapers see the series exist.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space, HumanParticipant } from '@aipehub/core'

import { renderMetrics } from '../src/server.js'

describe('renderMetrics', () => {
  let tmp: string
  let hub: Hub

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'aipehub-metrics-'))
    const init = await Space.init(tmp, { name: 'test' })
    hub = new Hub({ space: init.space })
    await hub.start()
  })

  afterEach(async () => {
    await hub.stop()
    await rm(tmp, { recursive: true, force: true })
  })

  it('emits a protocol version info-metric', () => {
    const text = renderMetrics(hub)
    expect(text).toMatch(/# TYPE aipehub_protocol_version gauge/)
    expect(text).toMatch(/aipehub_protocol_version\{version="[\d.]+"\} 1/)
  })

  it('emits aipehub_participants gauge, even when no participants', () => {
    const text = renderMetrics(hub)
    expect(text).toContain('# TYPE aipehub_participants gauge')
    // The renderer falls back to a single zero sample so the series exists.
    expect(text).toMatch(/aipehub_participants(\{[^}]*\})? 0/)
  })

  it('counts live participants by kind', () => {
    hub.register(new HumanParticipant({ id: 'alice', capabilities: ['review'] }))
    hub.register(new HumanParticipant({ id: 'bob',   capabilities: [] }))
    const text = renderMetrics(hub)
    expect(text).toMatch(/aipehub_participants\{kind="human"\} 2/)
  })

  it('counts tasks_total by terminal kind', async () => {
    // Append a task_result manually — exercise the transcript path
    // without spinning up a worker pool. We use the same shape the hub
    // emits, just synthesised.
    ;(hub.transcript as unknown as {
      append: (e: { ts: number; kind: string; data: unknown; seq?: number }) => void
    }).append({
      ts: Date.now(),
      kind: 'task_result',
      data: { kind: 'ok', taskId: 't1', by: 'someone', output: {}, ts: Date.now() },
    })
    const text = renderMetrics(hub)
    expect(text).toMatch(/aipehub_tasks_total\{kind="ok"\} 1/)
    expect(text).toMatch(/aipehub_tasks_total\{kind="failed"\} 0/)
  })

  it('counts service_call audit entries and accumulates duration', () => {
    const append = (hub.transcript as unknown as {
      append: (e: { ts: number; kind: string; data: unknown; seq?: number }) => void
    }).append.bind(hub.transcript)
    append({
      ts: Date.now(),
      kind: 'service_call',
      data: {
        from: 'a-1',
        type: 'memory',
        impl: 'file',
        ownerKind: 'agent',
        ownerId: 'a-1',
        method: 'recall',
        outcome: 'ok',
        durationMs: 10,
      },
    })
    append({
      ts: Date.now(),
      kind: 'service_call',
      data: {
        from: 'a-1',
        type: 'memory',
        impl: 'file',
        ownerKind: 'agent',
        ownerId: 'a-1',
        method: 'recall',
        outcome: 'ok',
        durationMs: 30,
      },
    })
    append({
      ts: Date.now(),
      kind: 'service_call',
      data: {
        from: 'a-1',
        type: 'memory',
        impl: 'file',
        ownerKind: 'workflow-run',
        ownerId: 'c-1',
        method: 'remember',
        outcome: 'forbidden_owner',
        durationMs: 2,
      },
    })
    const text = renderMetrics(hub)
    expect(text).toMatch(/aipehub_service_calls_total\{type="memory",impl="file",outcome="ok"\} 2/)
    expect(text).toMatch(/aipehub_service_calls_total\{type="memory",impl="file",outcome="forbidden_owner"\} 1/)
    expect(text).toMatch(/aipehub_service_call_duration_ms_sum\{type="memory",impl="file"\} 42/)
    expect(text).toMatch(/aipehub_service_call_duration_ms_count\{type="memory",impl="file"\} 3/)
  })

  it('reports pending applications gauge', () => {
    const req = hub.requestAdmission({
      agents: [{ id: 'pending-1', capabilities: ['noop'] }],
    })
    const text = renderMetrics(hub)
    expect(text).toMatch(/aipehub_pending_applications 1/)
    hub.approveApplication(req.applicationId, 'sys')
    const text2 = renderMetrics(hub)
    expect(text2).toMatch(/aipehub_pending_applications 0/)
  })

  it('escapes quotes and backslashes in label values', () => {
    // Construct a synthetic service_call with funky type name (the
    // protocol allows opaque strings).
    ;(hub.transcript as unknown as {
      append: (e: { ts: number; kind: string; data: unknown }) => void
    }).append({
      ts: Date.now(),
      kind: 'service_call',
      data: {
        from: 'a',
        type: 'weird"type\\name',
        impl: 'x',
        ownerKind: 'agent',
        ownerId: 'a',
        method: 'recall',
        outcome: 'ok',
        durationMs: 1,
      },
    })
    const text = renderMetrics(hub)
    expect(text).toContain('type="weird\\"type\\\\name"')
  })

  it('ends with a trailing newline', () => {
    expect(renderMetrics(hub).endsWith('\n')).toBe(true)
  })
})
