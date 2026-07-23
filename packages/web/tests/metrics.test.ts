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

import { Hub, Space, HumanParticipant } from '@gotong/core'

import { renderMetrics } from '../src/metrics.js'

describe('renderMetrics', () => {
  let tmp: string
  let hub: Hub

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-metrics-'))
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
    expect(text).toMatch(/# TYPE gotong_protocol_version gauge/)
    expect(text).toMatch(/gotong_protocol_version\{version="[\d.]+"\} 1/)
  })

  it('emits process_resident_memory_bytes (the series GotongProcessRssCreep alerts on)', () => {
    const text = renderMetrics(hub)
    expect(text).toContain('# TYPE process_resident_memory_bytes gauge')
    const m = text.match(/^process_resident_memory_bytes (\d+)$/m)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(0)
  })

  it('emits gotong_participants gauge, even when no participants', () => {
    const text = renderMetrics(hub)
    expect(text).toContain('# TYPE gotong_participants gauge')
    // The renderer falls back to a single zero sample so the series exists.
    expect(text).toMatch(/gotong_participants(\{[^}]*\})? 0/)
  })

  it('counts live participants by kind', () => {
    hub.register(new HumanParticipant({ id: 'alice', capabilities: ['review'] }))
    hub.register(new HumanParticipant({ id: 'bob',   capabilities: [] }))
    const text = renderMetrics(hub)
    expect(text).toMatch(/gotong_participants\{kind="human"\} 2/)
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
    expect(text).toMatch(/gotong_tasks_total\{kind="ok"\} 1/)
    expect(text).toMatch(/gotong_tasks_total\{kind="failed"\} 0/)
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
    expect(text).toMatch(/gotong_service_calls_total\{type="memory",impl="file",outcome="ok"\} 2/)
    expect(text).toMatch(/gotong_service_calls_total\{type="memory",impl="file",outcome="forbidden_owner"\} 1/)
    expect(text).toMatch(/gotong_service_call_duration_ms_sum\{type="memory",impl="file"\} 42/)
    expect(text).toMatch(/gotong_service_call_duration_ms_count\{type="memory",impl="file"\} 3/)
  })

  it('reports pending applications gauge', () => {
    const req = hub.requestAdmission({
      agents: [{ id: 'pending-1', capabilities: ['noop'] }],
    })
    const text = renderMetrics(hub)
    expect(text).toMatch(/gotong_pending_applications 1/)
    hub.approveApplication(req.applicationId, 'sys')
    const text2 = renderMetrics(hub)
    expect(text2).toMatch(/gotong_pending_applications 0/)
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
    expect(text).toMatch(/gotong_service_call_duration_ms_sum\{type="memory",impl="file"\} 7/)
    // count is still 2 (both calls happened, both audited).
    expect(text).toMatch(/gotong_service_call_duration_ms_count\{type="memory",impl="file"\} 2/)
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
    expect(text).toContain('# TYPE gotong_service_call_duration_ms histogram')
    // Bucket le=5 captures the two 3ms / 4ms calls but not the 200ms one.
    expect(text).toMatch(/gotong_service_call_duration_ms_bucket\{type="memory",impl="file",le="5"\} 2/)
    expect(text).toMatch(/gotong_service_call_duration_ms_bucket\{type="memory",impl="file",le="100"\} 2/)
    // le=250 captures all three.
    expect(text).toMatch(/gotong_service_call_duration_ms_bucket\{type="memory",impl="file",le="250"\} 3/)
    expect(text).toMatch(/gotong_service_call_duration_ms_bucket\{type="memory",impl="file",le="\+Inf"\} 3/)
  })

  it('histogram emits a zero +Inf bucket when no service calls have run', () => {
    const text = renderMetrics(hub)
    expect(text).toContain('# TYPE gotong_service_call_duration_ms histogram')
    // The placeholder zero series so scrapers see the metric exists.
    expect(text).toMatch(/gotong_service_call_duration_ms_bucket\{le="\+Inf"\} 0/)
  })

  // PR #41 — HTTP response-class counter. Driven via HttpStats; the
  // metric is omitted when no httpStats is supplied (tests + scripts
  // that scrape metrics out-of-band).
  it('omits HTTP counters when httpStats is not supplied', () => {
    const text = renderMetrics(hub)
    expect(text).not.toContain('gotong_http_responses_total')
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
    expect(text).toContain('# TYPE gotong_http_responses_total counter')
    expect(text).toMatch(/gotong_http_responses_total\{class="2xx"\} 3/)
    expect(text).toMatch(/gotong_http_responses_total\{class="3xx"\} 0/)
    expect(text).toMatch(/gotong_http_responses_total\{class="4xx"\} 1/)
    expect(text).toMatch(/gotong_http_responses_total\{class="5xx"\} 1/)
  })

  it('HTTP counters surface a zero row for every canonical class even before traffic', async () => {
    const { HttpStats } = await import('../src/metrics.js')
    const stats = new HttpStats()
    const text = renderMetrics(hub, { httpStats: stats })
    expect(text).toMatch(/gotong_http_responses_total\{class="2xx"\} 0/)
    expect(text).toMatch(/gotong_http_responses_total\{class="5xx"\} 0/)
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
    expect(text).toMatch(/gotong_http_responses_total\{class="2xx"\} 1/)
    expect(text).toMatch(/gotong_http_responses_total\{class="other"\} 3/)
  })

  // --- business metrics rendering (Phase 19 P3-M1) -------------------------

  it('renders the workflow_runs / suspended / llm series from a business snapshot', () => {
    const text = renderMetrics(hub, {
      business: {
        workflowRuns: { running: 2, done: 5, failed: 1, cancelled: 0 },
        suspendedTasks: 3,
        llmByModel: [
          { model: 'deepseek-chat', calls: 10, tokens: 12345, costMicros: 6789 },
          { model: 'gpt-4o', calls: 2, tokens: 500, costMicros: 100 },
        ],
      },
    })
    expect(text).toContain('# TYPE gotong_workflow_runs gauge')
    expect(text).toMatch(/gotong_workflow_runs\{status="running"\} 2/)
    expect(text).toMatch(/gotong_workflow_runs\{status="done"\} 5/)
    // The old scan-capped sample gauge is retired (Route B P0-M3-M3) — the
    // run tally is now an exact count, so no such series should exist.
    expect(text).not.toContain('gotong_workflow_runs_scan_capped')
    expect(text).toMatch(/# TYPE gotong_suspended_tasks gauge/)
    expect(text).toMatch(/gotong_suspended_tasks 3/)
    expect(text).toMatch(/gotong_llm_calls_total\{model="deepseek-chat"\} 10/)
    expect(text).toMatch(/gotong_llm_tokens_total\{model="deepseek-chat"\} 12345/)
    expect(text).toMatch(/gotong_llm_cost_micros_total\{model="gpt-4o"\} 100/)
  })

  it('omits business series entirely when no snapshot is supplied', () => {
    const text = renderMetrics(hub)
    expect(text).not.toContain('gotong_workflow_runs')
    expect(text).not.toContain('gotong_suspended_tasks')
    expect(text).not.toContain('gotong_llm_calls_total')
  })

  it('renders an all-zero run tally and a zero llm series when both are empty', () => {
    const text = renderMetrics(hub, {
      business: { workflowRuns: { running: 0, done: 0, failed: 0, cancelled: 0 }, llmByModel: [] },
    })
    // All-zero is still a real exact count — the series renders (a dashboard
    // tells "0 because none" from a missing source by the series' presence).
    expect(text).toMatch(/gotong_workflow_runs\{status="done"\} 0/)
    expect(text).not.toContain('gotong_workflow_runs_scan_capped')
    expect(text).toMatch(/gotong_llm_calls_total 0/)
  })
})

describe('collectBusinessMetrics (Phase 19 P3-M1)', () => {
  it('tallies workflow runs by status, maps ledger rows, reads suspended count', async () => {
    const { collectBusinessMetrics } = await import('../src/business-metrics.js')
    const snap = await collectBusinessMetrics({
      workflows: {
        async countRuns() {
          return { total: 4, byStatus: { running: 1, done: 2, failed: 1 } }
        },
      },
      identity: {
        countSuspendedTasks: () => 4,
        aggregateLedger: () => [
          {
            key: 'deepseek-chat',
            calls: 3,
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 10,
            cacheReadTokens: 5,
            costMicros: 999,
          },
        ],
      },
    })
    // `cancelled: 0` is seeded by collect even though countRuns omitted it.
    expect(snap.workflowRuns).toEqual({ running: 1, done: 2, failed: 1, cancelled: 0 })
    expect(snap.suspendedTasks).toBe(4)
    expect(snap.llmByModel).toEqual([
      { model: 'deepseek-chat', calls: 3, tokens: 165, costMicros: 999 },
    ])
  })

  it('omits a family whose source throws — never rejects', async () => {
    const { collectBusinessMetrics } = await import('../src/business-metrics.js')
    const snap = await collectBusinessMetrics({
      workflows: {
        async countRuns() {
          throw new Error('disk gone')
        },
      },
      identity: {
        countSuspendedTasks: () => {
          throw new Error('db locked')
        },
        // aggregateLedger present + healthy → that family still appears
        aggregateLedger: () => [],
      },
    })
    expect(snap.workflowRuns).toBeUndefined()
    expect(snap.suspendedTasks).toBeUndefined()
    expect(snap.llmByModel).toEqual([])
  })

  it('returns {} when no sources are wired', async () => {
    const { collectBusinessMetrics } = await import('../src/business-metrics.js')
    expect(await collectBusinessMetrics({})).toEqual({})
  })
})

describe('collectBusinessMetrics workflow-runs cache (perf audit A⑥)', () => {
  async function load() {
    return await import('../src/business-metrics.js')
  }

  it('within TTL: second call serves the memo without re-scanning', async () => {
    const { collectBusinessMetrics, createBusinessMetricsCache } = await load()
    const cache = createBusinessMetricsCache()
    let scans = 0
    let t = 1_000
    const sources = {
      workflows: {
        async countRuns() {
          scans++
          return { total: 1, byStatus: { done: 1 } }
        },
      },
    }
    const opts = { cache, now: () => t }
    const first = await collectBusinessMetrics(sources, opts)
    t += 29_000 // still inside the 30s window
    const second = await collectBusinessMetrics(sources, opts)
    expect(scans).toBe(1)
    expect(second.workflowRuns).toEqual(first.workflowRuns)
    // The served snapshot is a copy — mutating it must not poison the cache.
    second.workflowRuns!.done = 999
    t += 500
    const third = await collectBusinessMetrics(sources, opts)
    expect(third.workflowRuns!.done).toBe(1)
    expect(scans).toBe(1)
  })

  it('past TTL: re-scans and refreshes the memo', async () => {
    const { collectBusinessMetrics, createBusinessMetricsCache } = await load()
    const cache = createBusinessMetricsCache()
    let scans = 0
    let t = 1_000
    const sources = {
      workflows: {
        async countRuns() {
          scans++
          return { total: scans, byStatus: { done: scans } }
        },
      },
    }
    const opts = { cache, now: () => t }
    await collectBusinessMetrics(sources, opts)
    t += 30_000 // exactly at the boundary — `<` means expired
    const second = await collectBusinessMetrics(sources, opts)
    expect(scans).toBe(2)
    expect(second.workflowRuns!.done).toBe(2)
  })

  it('scan error with an empty cache: family omitted, nothing cached', async () => {
    const { collectBusinessMetrics, createBusinessMetricsCache } = await load()
    const cache = createBusinessMetricsCache()
    const snap = await collectBusinessMetrics(
      {
        workflows: {
          async countRuns(): Promise<{ total: number; byStatus: Record<string, number> }> {
            throw new Error('disk gone')
          },
        },
      },
      { cache, now: () => 1_000 },
    )
    expect(snap.workflowRuns).toBeUndefined()
    expect(cache.workflowRuns).toBeUndefined()
  })

  it('no cache passed: pre-A⑥ behavior (scan every call)', async () => {
    const { collectBusinessMetrics } = await load()
    let scans = 0
    const sources = {
      workflows: {
        async countRuns() {
          scans++
          return { total: 1, byStatus: { done: 1 } }
        },
      },
    }
    await collectBusinessMetrics(sources)
    await collectBusinessMetrics(sources)
    expect(scans).toBe(2)
  })

  it('identity families stay fresh even on a workflow-runs cache hit', async () => {
    const { collectBusinessMetrics, createBusinessMetricsCache } = await load()
    const cache = createBusinessMetricsCache()
    let suspended = 1
    const sources = {
      workflows: {
        async countRuns() {
          return { total: 0, byStatus: {} }
        },
      },
      identity: { countSuspendedTasks: () => suspended },
    }
    const opts = { cache, now: () => 1_000 }
    await collectBusinessMetrics(sources, opts)
    suspended = 7
    const second = await collectBusinessMetrics(sources, opts)
    expect(second.suspendedTasks).toBe(7) // deliberately uncached
  })
})
