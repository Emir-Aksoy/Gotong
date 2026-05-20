#!/usr/bin/env tsx
/**
 * WebSocket load test (single-process variant).
 *
 * Same scenario as `inproc.ts`, but the agents are attached to the Hub
 * via the actual WebSocket transport (the production path) instead of
 * direct in-process `hub.register(...)`. The Hub and SDK both live in
 * the same Node process, but they speak the wire protocol through a
 * real `ws://` socket on `127.0.0.1`.
 *
 * What this adds vs `inproc.ts`:
 *   - JSON encoding / decoding overhead per frame
 *   - WebSocket framing + heartbeat machinery
 *   - SDK session-state bookkeeping (pending tasks map, cancel routing)
 *   - The full agent-side `onTask` dispatch path used by `@aipehub/sdk-node`
 *
 * What this still DOESN'T add (vs production):
 *   - TCP loopback latency (negligible — same kernel) vs a real network
 *   - On-disk transcript persistence (Space-backed). Pure in-memory.
 *   - Multi-process scheduling overhead
 *
 * That said: this is a much closer proxy to the "deployed for small
 * teams" baseline than `inproc.ts`, so prefer this one for the headline
 * numbers in `docs/PERFORMANCE.md`.
 */

import { AgentParticipant, Hub, type Task } from '@aipehub/core'
import { connect, type Session } from '@aipehub/sdk-node'
import { serveWebSocket, type WebSocketTransportHandle } from '@aipehub/transport-ws'

import {
  MemorySampler,
  nowMs,
  parseArgs,
  percentile,
  printSummary,
  sleep,
  type RunReport,
  writeReport,
} from './shared.js'

class EchoAgent extends AgentParticipant {
  constructor(id: string, cap: string) {
    super({ id, capabilities: [cap] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { echoed: task.payload }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()

  console.log(`# ws load test (single-process, loopback WebSocket)`)
  console.log(`#   workers=${args.workers} duration=${args.durationMs}ms concurrency=${args.concurrency} rate=${args.rate || 'unthrottled'}`)

  const hub = Hub.inMemory()
  await hub.start()

  // Bind the WS transport on a random port so parallel runs don't clash.
  let ws: WebSocketTransportHandle | null = null
  let session: Session | null = null
  try {
    ws = await serveWebSocket(hub, { host: '127.0.0.1', port: 0 })

    // Build N agents and connect them through one SDK session. A single
    // HELLO carries all of them; the transport then multiplexes TASK/
    // RESULT frames per agent id. This is the same pattern that a real
    // Python or Node SDK worker uses.
    const agents: EchoAgent[] = []
    for (let i = 0; i < args.workers; i++) {
      const cap = args.caps[i % args.caps.length]!
      agents.push(new EchoAgent(`agent-${i.toString().padStart(4, '0')}`, cap))
    }
    session = await connect({ url: ws.url, agents })

    // Wait for the Hub to register every agent. `connect()` resolves on
    // WELCOME, but registration can race with the first dispatch — wait
    // until the registry has every id before measuring.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (hub.registry.byKind('agent').length >= args.workers) break
      await sleep(50)
    }
    if (hub.registry.byKind('agent').length < args.workers) {
      throw new Error(
        `only ${hub.registry.byKind('agent').length}/${args.workers} agents registered before timeout`,
      )
    }

    // From here on it's structurally identical to inproc.ts.
    const mem = new MemorySampler()
    mem.start(1_000)

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

    while (Date.now() < stopAt) {
      while (inflight.size < args.concurrency && Date.now() < stopAt) {
        if (args.rate > 0) {
          const elapsedSec = (Date.now() - startWall) / 1000
          const expectedSent = elapsedSec * args.rate
          if (dispatched >= expectedSent) break
        }
        sendOne()
      }
      await Promise.race([
        Promise.any(Array.from(inflight)),
        new Promise<void>((r) => setTimeout(r, 5)),
      ]).catch(() => {})
    }
    await Promise.allSettled(Array.from(inflight))

    const samples = mem.stop()
    const sorted = latencies.slice().sort((a, b) => a - b)
    const elapsedSec = (Date.now() - startWall) / 1000
    const rssPeak = Math.max(...samples.map((s) => s.rssMb), 0)
    const heapPeak = Math.max(...samples.map((s) => s.heapMb), 0)
    const rssGrowth =
      samples.length >= 2
        ? samples[samples.length - 1]!.rssMb - samples[0]!.rssMb
        : 0

    const report: RunReport = {
      runner: 'ws',
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
  } finally {
    if (session) {
      try { await session.close() } catch { /* ignore */ }
    }
    if (ws) {
      try { await ws.close() } catch { /* ignore */ }
    }
    await hub.stop()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
