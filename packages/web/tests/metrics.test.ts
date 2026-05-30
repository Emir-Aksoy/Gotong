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

import { renderMetrics } from '../src/metrics.js'

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

  it('clamps negative durationMs to zero (counters must not decrease)', () => {
    // Prometheus convention: counter `_sum` is monotonic. A negative
    // duration (e.g. clock skew) would let `_sum` go down across scrapes,
    // breaking rate() queries. We clamp at zero defensively.
    const append = (hub.transcript as unknown as {
      append: (e: { ts: number; kind: string; data: unknown }) => void
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
        // pathological: clock went backwards mid-call
        durationMs: -50,
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
        durationMs: 7,
      },
    })
    const text = renderMetrics(hub)
    // The negative is treated as 0, so sum = 0 + 7 = 7 (not -43).
    expect(text).toMatch(/aipehub_service_call_duration_ms_sum\{type="memory",impl="file"\} 7/)
    // count is still 2 (both calls happened, both audited).
    expect(text).toMatch(/aipehub_service_call_duration_ms_count\{type="memory",impl="file"\} 2/)
  })

  // PR #41 — service-call latency histogram for p50/p95/p99 dashboards.
  it('emits service-call duration histogram buckets', () => {
    // Two fast (≤ 5ms) calls + one slow (200ms) call. Expect cumulative
    // bucket counts: le=5 → 2, le=10 → 2, le=25 → 2, …, le=250 → 3,
    // le=+Inf → 3.
    const append = (hub.transcript as unknown as {
      append: (e: { ts: number; kind: string; data: unknown }) => void
    }).append.bind(hub.transcript)
    for (const dur of [3, 4, 200]) {
      append({
        ts: Date.now(),
        kind: 'service_call',
        data: {
          from: 'a',
          type: 'memory',
          impl: 'file',
          ownerKind: 'agent',
          ownerId: 'a',
          method: 'recall',
          outcome: 'ok',
          durationMs: dur,
        },
      })
    }
    const text = renderMetrics(hub)
    expect(text).toContain('# TYPE aipehub_service_call_duration_ms histogram')
    // Bucket le=5 captures the two 3ms / 4ms calls but not the 200ms one.
    expect(text).toMatch(/aipehub_service_call_duration_ms_bucket\{type="memory",impl="file",le="5"\} 2/)
    expect(text).toMatch(/aipehub_service_call_duration_ms_bucket\{type="memory",impl="file",le="100"\} 2/)
    // le=250 captures all three.
    expect(text).toMatch(/aipehub_service_call_duration_ms_bucket\{type="memory",impl="file",le="250"\} 3/)
    expect(text).toMatch(/aipehub_service_call_duration_ms_bucket\{type="memory",impl="file",le="\+Inf"\} 3/)
  })

  it('histogram emits a zero +Inf bucket when no service calls have run', () => {
    const text = renderMetrics(hub)
    expect(text).toContain('# TYPE aipehub_service_call_duration_ms histogram')
    // The placeholder zero series so scrapers see the metric exists.
    expect(text).toMatch(/aipehub_service_call_duration_ms_bucket\{le="\+Inf"\} 0/)
  })

  // PR #41 — HTTP response-class counter. Driven via HttpStats; the
  // metric is omitted when no httpStats is supplied (tests + scripts
  // that scrape metrics out-of-band).
  it('omits HTTP counters when httpStats is not supplied', () => {
    const text = renderMetrics(hub)
    expect(text).not.toContain('aipehub_http_responses_total')
  })

  it('emits HTTP counters with all canonical classes when httpStats is supplied', async () => {
    const { HttpStats } = await import('../src/metrics.js')
    const stats = new HttpStats()
    stats.record(200)
    stats.record(200)
    stats.record(201)
    stats.record(404)
    stats.record(503)
    const text = renderMetrics(hub, { httpStats: stats })
    expect(text).toContain('# TYPE aipehub_http_responses_total counter')
    expect(text).toMatch(/aipehub_http_responses_total\{class="2xx"\} 3/)
    expect(text).toMatch(/aipehub_http_responses_total\{class="3xx"\} 0/)
    expect(text).toMatch(/aipehub_http_responses_total\{class="4xx"\} 1/)
    expect(text).toMatch(/aipehub_http_responses_total\{class="5xx"\} 1/)
  })

  it('HTTP counters surface a zero row for every canonical class even before traffic', async () => {
    const { HttpStats } = await import('../src/metrics.js')
    const stats = new HttpStats()
    const text = renderMetrics(hub, { httpStats: stats })
    expect(text).toMatch(/aipehub_http_responses_total\{class="2xx"\} 0/)
    expect(text).toMatch(/aipehub_http_responses_total\{class="5xx"\} 0/)
  })

  it('HttpStats.record clamps out-of-range / non-finite codes into an "other" bucket', async () => {
    const { HttpStats } = await import('../src/metrics.js')
    const stats = new HttpStats()
    stats.record(0)            // socket-closed-early on some Node paths
    stats.record(99)           // sub-1xx, never legal HTTP
    stats.record(700)          // beyond 5xx
    stats.record(NaN)           // ignored — not finite
    stats.record(-1)           // ignored — negative
    stats.record(200)          // canonical
    const text = renderMetrics(hub, { httpStats: stats })
    expect(text).toMatch(/aipehub_http_responses_total\{class="2xx"\} 1/)
    expect(text).toMatch(/aipehub_http_responses_total\{class="other"\} 3/)
  })
})
