/**
 * Shared helpers for the load-test harness.
 *
 * Kept in one file so each run binary (inproc / ws / ...) is a single
 * focused file. No external deps beyond node built-ins.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

// =============================================================================
// CLI arg parsing — tiny purpose-built parser.
//
// We don't want yargs / commander as deps for a workspace-internal tool. The
// flags we accept are small and stable, so handle them by hand.
// =============================================================================

export interface CommonArgs {
  workers: number              // how many concurrent agent participants
  durationMs: number           // how long to run the dispatch loop
  rate: number                 // target tasks per second; 0 = unthrottled
  concurrency: number          // how many dispatches in-flight at once
  output: string               // file path to write the JSON report to
  caps: readonly string[]      // capability strings to rotate through
}

const DEFAULTS: CommonArgs = {
  workers: 50,
  durationMs: 30_000,
  rate: 0,
  concurrency: 16,
  output: '',
  caps: ['draft', 'review', 'analyze', 'translate'],
}

export function parseArgs(argv: readonly string[]): CommonArgs {
  const args = { ...DEFAULTS } as { -readonly [K in keyof CommonArgs]: CommonArgs[K] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    // pnpm forwards a literal `--` separator with `pnpm run <script> -- flags`.
    // Treat it as a no-op so both `pnpm inproc -- --workers 50` and direct
    // `tsx src/inproc.ts --workers 50` work.
    if (a === '--') continue
    const next = argv[i + 1]
    switch (a) {
      case '--workers':       args.workers     = parseInt(next ?? '', 10); i++; break
      case '--duration':      args.durationMs  = parseDurationMs(next ?? ''); i++; break
      case '--rate':          args.rate        = parseFloat(next ?? '0');   i++; break
      case '--concurrency':   args.concurrency = parseInt(next ?? '', 10);  i++; break
      case '--output':        args.output      = next ?? '';                i++; break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        if (a.startsWith('-')) {
          console.error(`unknown flag: ${a}`)
          printUsage()
          process.exit(2)
        }
    }
  }
  if (!Number.isFinite(args.workers) || args.workers < 1) {
    throw new Error(`--workers must be a positive integer, got: ${args.workers}`)
  }
  if (!Number.isFinite(args.durationMs) || args.durationMs < 1_000) {
    throw new Error(`--duration must resolve to ≥1s, got: ${args.durationMs}ms`)
  }
  return args
}

function parseDurationMs(s: string): number {
  // Accept "30s", "5m", "1h", or a bare number (interpreted as ms).
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim())
  if (!m) return NaN
  const n = parseFloat(m[1]!)
  const unit = m[2] ?? 'ms'
  switch (unit) {
    case 'ms': return n
    case 's':  return n * 1_000
    case 'm':  return n * 60_000
    case 'h':  return n * 3_600_000
  }
  return NaN
}

function printUsage(): void {
  console.error(`Usage: tsx src/<runner>.ts [flags]

Flags:
  --workers     N        Number of agent participants (default: 50)
  --duration    DURATION How long to run; 5s | 30s | 5m | 1h (default: 30s)
  --rate        N        Target tasks/sec; 0 = unthrottled (default: 0)
  --concurrency N        Max dispatches in-flight at once (default: 16)
  --output      PATH     Write JSON report here (default: stdout only)
  -h, --help             Show this message
`)
}

// =============================================================================
// Percentile + memory sampler.
//
// We collect *every* latency rather than streaming-quantile estimates
// because we cap dispatch counts at low millions, and the simplicity
// payoff is worth the ~16 MB per million samples.
// =============================================================================

export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return NaN
  // Nearest-rank percentile — clipped to [0, len-1].
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))
  return sortedAsc[idx]!
}

export interface MemSample {
  ts: number
  rssMb: number
  heapMb: number
}

export class MemorySampler {
  private samples: MemSample[] = []
  private timer: NodeJS.Timeout | null = null

  private sampleNow(): void {
    const m = process.memoryUsage()
    this.samples.push({
      ts: Date.now(),
      rssMb: round1(m.rss / 1024 / 1024),
      heapMb: round1(m.heapUsed / 1024 / 1024),
    })
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return
    // Sample once immediately so a short run still has data even if the
    // dispatch loop is too tight for setInterval to fire. Then schedule
    // the recurring sampler.
    this.sampleNow()
    this.timer = setInterval(() => this.sampleNow(), intervalMs)
    // Note: do NOT .unref() the timer. In a heavily promise-driven
    // dispatch loop the interval can be starved otherwise.
  }

  stop(): readonly MemSample[] {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // Final sample at stop time captures any growth that happened
    // between the last tick and the end of the run.
    this.sampleNow()
    return this.samples
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// =============================================================================
// Report I/O. We always print the report to stdout, and optionally also
// write it to a file so a CI runner can diff future runs.
// =============================================================================

export interface RunReport {
  runner: string                                // "inproc" / "ws" / ...
  startedAt: string                             // ISO timestamp
  args: CommonArgs
  results: {
    dispatched: number
    successful: number
    failed: number
    throughputPerSec: number
    latencyMs: {
      mean: number
      p50: number
      p90: number
      p95: number
      p99: number
      max: number
    }
    memory: {
      rssPeakMb: number
      heapPeakMb: number
      rssGrowthMb: number                       // first → last sample delta
      samples: readonly MemSample[]
    }
  }
}

export async function writeReport(path: string, report: RunReport): Promise<void> {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8')
}

/**
 * Compact stdout summary. Designed to fit in ~10 lines so CI logs stay
 * readable even if you run dozens of configurations.
 */
export function printSummary(report: RunReport): void {
  const r = report.results
  const lat = r.latencyMs
  const mem = r.memory
  console.log()
  console.log(`runner       : ${report.runner}`)
  console.log(`workers      : ${report.args.workers}`)
  console.log(`duration     : ${(report.args.durationMs / 1000).toFixed(1)}s`)
  console.log(`dispatched   : ${r.dispatched.toLocaleString()} (${r.successful} ok, ${r.failed} fail)`)
  console.log(`throughput   : ${r.throughputPerSec.toFixed(1)} tasks/sec`)
  console.log(`latency (ms) : p50=${lat.p50.toFixed(2)} p90=${lat.p90.toFixed(2)} p95=${lat.p95.toFixed(2)} p99=${lat.p99.toFixed(2)} max=${lat.max.toFixed(2)}`)
  console.log(`memory       : rss peak=${mem.rssPeakMb.toFixed(1)}MB (growth=${mem.rssGrowthMb.toFixed(1)}MB) heap peak=${mem.heapPeakMb.toFixed(1)}MB`)
  if (report.args.output) console.log(`report       : ${report.args.output}`)
}

// =============================================================================
// Simple async helpers.
// =============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Hi-resolution monotonic time in milliseconds (uses `performance.now()`).
 * Don't use `Date.now()` for latency — its 1ms granularity throws off p99.
 */
export function nowMs(): number {
  return performance.now()
}
