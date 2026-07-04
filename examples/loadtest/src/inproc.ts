#!/usr/bin/env tsx
/**
 * In-process load test.
 *
 * Wires an in-memory Hub, registers N echo agents (each with one rotating
 * capability), and runs a dispatch loop for the requested duration with a
 * sliding window of `concurrency` dispatches in flight at any moment.
 *
 * What this measures:
 *   - Hub.dispatch() + capability matching + AgentParticipant.handleTask()
 *     round-trip latency, with zero network in between.
 *   - Memory growth of the in-memory transcript + registry as task count
 *     scales up.
 *
 * What this DOESN'T measure:
 *   - WebSocket transport overhead (see `ws.ts` for that — followup).
 *   - On-disk persistence overhead (Hub.inMemory() skips Space).
 *   - LLM provider latency (handleTask just echoes).
 *
 * In other words: this gives you the *scheduling floor* of the Hub —
 * "the absolute fastest a task can move through the abstraction with
 * zero meaningful work attached." Real-world workloads with LLMs +
 * WebSocket + disk persistence will be one or two orders of magnitude
 * slower, and that's fine. The point is to spot regressions in the
 * scheduling layer itself.
 *
 * Usage:
 *   pnpm --filter @gotong/example-loadtest inproc -- --workers 50 --duration 30s
 *   pnpm --filter @gotong/example-loadtest inproc -- --workers 100 --duration 5m --output runs/baseline.json
 */

import { AgentParticipant, Hub, type Task } from '@gotong/core'

import {
  MemorySampler,
  nowMs,
  parseArgs,
  percentile,
  printSummary,
  type RunReport,
  writeReport,
} from './shared.js'

class EchoAgent extends AgentParticipant {
  constructor(id: string, cap: string) {
    super({ id, capabilities: [cap] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    // Synchronous return — nothing async to block on. This is the
    // floor-case: any non-trivial agent will be slower.
    return { echoed: task.payload }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()

  console.log(`# inproc load test`)
  console.log(`#   workers=${args.workers} duration=${args.durationMs}ms concurrency=${args.concurrency} rate=${args.rate || 'unthrottled'}`)

  const hub = Hub.inMemory()
  await hub.start()

  // Register N agents, rotating through the capability list. Distribution
  // matters: with caps=['draft','review','analyze','translate'] and N=50,
  // each cap has 12–13 candidate agents, which exercises the load-aware
  // capability matcher more than a single-cap fleet would.
  for (let i = 0; i < args.workers; i++) {
    const cap = args.caps[i % args.caps.length]!
    hub.register(new EchoAgent(`agent-${i.toString().padStart(4, '0')}`, cap))
  }

  // Start memory sampler — once per second, off-thread (unref'd).
  const mem = new MemorySampler()
  mem.start(1_000)

  // Dispatch loop with a fixed-size inflight window. A naive `for-await`
  // loop serialises dispatches; this lets us push concurrency until the
  // Hub becomes the bottleneck instead of our caller.
  const latencies: number[] = []
  let dispatched = 0
  let successful = 0
  let failed = 0
  const startWall = Date.now()
  const stopAt = startWall + args.durationMs

  const inflight = new Set<Promise<void>>()
  const sendOne = (): Promise<void> => {
    const i = dispatched++
    const cap = args.caps[i % args.caps.length]!
    const t0 = nowMs()
    const p = hub
      .dispatch({
        from: 'load',
        strategy: { kind: 'capability', capabilities: [cap] },
        payload: { i },
      })
      .then((r) => {
        latencies.push(nowMs() - t0)
        if (r.kind === 'ok') successful++
        else failed++
      })
      .catch(() => {
        latencies.push(nowMs() - t0)
        failed++
      })
      .finally(() => {
        inflight.delete(p)
      })
    inflight.add(p)
    return p
  }

  // Keep the inflight set topped up until time runs out. Throttle when
  // --rate is set by sleeping when we've sent more than the target.
  while (Date.now() < stopAt) {
    while (inflight.size < args.concurrency && Date.now() < stopAt) {
      if (args.rate > 0) {
        const elapsedSec = (Date.now() - startWall) / 1000
        const expectedSent = elapsedSec * args.rate
        if (dispatched >= expectedSent) break    // ahead of schedule — wait
      }
      sendOne()
    }
    // Yield briefly so dispatched promises can resolve.
    await Promise.race([
      Promise.any(Array.from(inflight)),
      new Promise<void>((r) => setTimeout(r, 5)),
    ]).catch(() => {})
  }

  // Drain inflight requests so latency numbers include the final batch.
  await Promise.allSettled(Array.from(inflight))

  const samples = mem.stop()
  await hub.stop()

  // Aggregate.
  const sorted = latencies.slice().sort((a, b) => a - b)
  const elapsedSec = (Date.now() - startWall) / 1000
  const rssPeak = Math.max(...samples.map((s) => s.rssMb), 0)
  const heapPeak = Math.max(...samples.map((s) => s.heapMb), 0)
  const rssGrowth =
    samples.length >= 2
      ? samples[samples.length - 1]!.rssMb - samples[0]!.rssMb
      : 0

  const report: RunReport = {
    runner: 'inproc',
    startedAt,
    args,
    results: {
      dispatched,
      successful,
      failed,
      throughputPerSec: dispatched / elapsedSec,
      latencyMs: {
        mean: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted[sorted.length - 1] ?? 0,
      },
      memory: {
        rssPeakMb: rssPeak,
        heapPeakMb: heapPeak,
        rssGrowthMb: Math.round(rssGrowth * 10) / 10,
        samples,
      },
    },
  }

  printSummary(report)
  await writeReport(args.output, report)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
