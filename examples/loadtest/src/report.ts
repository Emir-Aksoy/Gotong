#!/usr/bin/env tsx
/**
 * Convert one or more `runs/*.json` reports into a single markdown summary
 * suitable for pasting into `docs/PERFORMANCE.md` or attaching to a PR.
 *
 * Usage:
 *   pnpm --filter @aipehub/example-loadtest report -- runs/*.json
 *   pnpm --filter @aipehub/example-loadtest report -- runs/inproc-50w-60s.json runs/ws-50w-60s.json
 *
 * The output is always stdout — pipe it where you want.
 */

import { readFile } from 'node:fs/promises'

import type { RunReport } from './shared.js'

async function main(): Promise<void> {
  // Skip the literal `--` separator that `pnpm run <script> -- args` forwards.
  const files = process.argv.slice(2).filter((a) => a !== '--')
  if (files.length === 0) {
    console.error('usage: report <run-file.json> [run-file.json ...]')
    process.exit(2)
  }

  const reports: RunReport[] = []
  for (const f of files) {
    const text = await readFile(f, 'utf8')
    reports.push(JSON.parse(text))
  }

  // Title + per-run summary tables.
  console.log('## Load-test results\n')
  console.log('| runner | workers | duration | dispatched | throughput | p50 | p95 | p99 | rss peak | rss growth |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of reports) {
    const a = r.args
    const m = r.results.memory
    const lat = r.results.latencyMs
    console.log(
      `| \`${r.runner}\` | ${a.workers} | ${(a.durationMs / 1000).toFixed(0)}s | ${r.results.dispatched.toLocaleString()} | ${r.results.throughputPerSec.toFixed(0)} tasks/sec | ${lat.p50.toFixed(2)}ms | ${lat.p95.toFixed(2)}ms | ${lat.p99.toFixed(2)}ms | ${m.rssPeakMb.toFixed(0)}MB | ${m.rssGrowthMb >= 0 ? '+' : ''}${m.rssGrowthMb.toFixed(1)}MB |`,
    )
  }
  console.log()

  // Per-run detail blocks.
  for (const r of reports) {
    const a = r.args
    const lat = r.results.latencyMs
    const m = r.results.memory
    console.log(`### \`${r.runner}\` — ${a.workers} workers / ${(a.durationMs / 1000).toFixed(0)}s\n`)
    console.log(`- Started: \`${r.startedAt}\``)
    console.log(`- Dispatched: ${r.results.dispatched.toLocaleString()} (${r.results.successful} ok, ${r.results.failed} fail)`)
    console.log(`- Throughput: **${r.results.throughputPerSec.toFixed(1)} tasks/sec**`)
    console.log(`- Latency (ms): mean=${lat.mean.toFixed(2)} p50=${lat.p50.toFixed(2)} p90=${lat.p90.toFixed(2)} p95=${lat.p95.toFixed(2)} p99=${lat.p99.toFixed(2)} max=${lat.max.toFixed(2)}`)
    console.log(`- Memory: rss peak ${m.rssPeakMb.toFixed(1)}MB, heap peak ${m.heapPeakMb.toFixed(1)}MB, rss growth ${m.rssGrowthMb >= 0 ? '+' : ''}${m.rssGrowthMb.toFixed(1)}MB over the window`)
    console.log()
    if (m.samples.length >= 2) {
      console.log('Memory over time (RSS, MB):')
      console.log('```')
      console.log(asciiSparkline(m.samples.map((s) => s.rssMb), 60))
      console.log('```\n')
    }
  }
}

function asciiSparkline(values: readonly number[], width: number): string {
  if (values.length === 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(0.1, max - min)
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  // Downsample to `width` bins.
  const step = values.length / width
  let out = ''
  for (let i = 0; i < width; i++) {
    const lo = Math.floor(i * step)
    const hi = Math.min(values.length, Math.floor((i + 1) * step) + 1)
    const slice = values.slice(lo, hi)
    if (slice.length === 0) {
      out += ' '
      continue
    }
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length
    const idx = Math.min(blocks.length - 1, Math.max(0, Math.floor(((avg - min) / range) * blocks.length)))
    out += blocks[idx]!
  }
  return `min=${min.toFixed(1)}MB max=${max.toFixed(1)}MB\n${out}`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
