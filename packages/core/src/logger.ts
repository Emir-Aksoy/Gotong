/**
 * AipeHub structured logger.
 *
 * One-line JSON output by default (suitable for `grep` / `jq` / Loki /
 * ELK / Datadog ingest); a "pretty" mode formats human-readably for
 * dev terminals. Component scoping via {@link Logger.child} builds a
 * small bindings object that prefixes every line, so a single grep
 * `comp=local-agents` filters cleanly.
 *
 * **Default behaviour**: ON. Default level is `'info'`; output goes to
 * stdout (warn/error/fatal go to stderr). All defaults can be flipped
 * with env vars at host start, or programmatically via {@link LoggerOptions}.
 *
 * Env vars:
 *
 *   AIPE_LOG_LEVEL     — silent | trace | debug | info | warn | error | fatal
 *                        (default: 'info')
 *   AIPE_LOG_FORMAT    — json | pretty
 *                        (default: 'pretty' if stdout is a TTY, else 'json')
 *   AIPE_LOG_DISABLED  — '1' to suppress all output (escape hatch; takes
 *                        precedence over LEVEL/FORMAT)
 *
 * Why not pino: pino is great, but the project ethos is "write a small
 * thing for a small thing". This file is ~180 lines and easy to grep.
 * If we later need transports / sampling / structured redaction, swap.
 */

export type LogLevel =
  | 'silent'
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal'

/**
 * Numeric ranks used to compare levels. Higher = louder. `silent` is a
 * sentinel ceiling — nothing crosses it, so setting `level: 'silent'`
 * suppresses output without needing a separate `disabled` flag.
 */
const LEVEL_RANKS: Record<LogLevel, number> = {
  silent: 100,
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
}

export interface Logger {
  trace(msg: string, ctx?: Record<string, unknown>): void
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
  fatal(msg: string, ctx?: Record<string, unknown>): void
  /**
   * Returns a new logger that includes these bindings in every line
   * (merged onto the parent's bindings; later keys win on conflict).
   */
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  /** Minimum level to emit. Default: env `AIPE_LOG_LEVEL` or `'info'`. */
  level?: LogLevel
  /**
   * Output format. Default: env `AIPE_LOG_FORMAT`; if unset, `'pretty'`
   * when stdout is a TTY, else `'json'`.
   */
  format?: 'json' | 'pretty'
  /**
   * Hard-off switch. Default: env `AIPE_LOG_DISABLED === '1'`. When
   * `true`, no line is emitted regardless of level.
   */
  disabled?: boolean
  /** Sink for info/debug/trace lines. Default: `process.stdout.write`. */
  out?: (line: string) => void
  /** Sink for warn/error/fatal lines. Default: `process.stderr.write`. */
  errOut?: (line: string) => void
  /**
   * Override the timestamp source. Tests inject a fixed clock so
   * snapshots stay deterministic. Default: `Date.now()`.
   */
  now?: () => number
}

/**
 * Create a logger bound to the given component name. The component is
 * stored under the `comp` key so the JSON output is grep-friendly:
 *
 *   {"ts":"…","level":"info","comp":"host","msg":"boot complete","port":3000}
 */
export function createLogger(component: string, opts: LoggerOptions = {}): Logger {
  return new LoggerImpl({ comp: component }, resolveOpts(opts))
}

// ── Internals ────────────────────────────────────────────────────────────

interface ResolvedOpts {
  level: LogLevel
  format: 'json' | 'pretty'
  disabled: boolean
  out: (line: string) => void
  errOut: (line: string) => void
  now: () => number
  threshold: number
}

function resolveOpts(opts: LoggerOptions): ResolvedOpts {
  const env = (k: string): string | undefined =>
    typeof process !== 'undefined' ? process.env[k] : undefined
  // TTY check is best-effort — guarded so this also works in browsers
  // and weird sandboxes that don't expose process.stdout.
  const isTTY = !!(typeof process !== 'undefined' && (process as { stdout?: { isTTY?: boolean } }).stdout?.isTTY)
  const envLevel = (env('AIPE_LOG_LEVEL') ?? '').toLowerCase()
  const envFormat = (env('AIPE_LOG_FORMAT') ?? '').toLowerCase()
  const level: LogLevel =
    opts.level ??
    (envLevel in LEVEL_RANKS ? (envLevel as LogLevel) : 'info')
  const format: 'json' | 'pretty' =
    opts.format ??
    (envFormat === 'json' ? 'json'
      : envFormat === 'pretty' ? 'pretty'
      : (isTTY ? 'pretty' : 'json'))
  const disabled = opts.disabled ?? (env('AIPE_LOG_DISABLED') === '1')
  return {
    level,
    format,
    disabled,
    out: opts.out ?? defaultOut,
    errOut: opts.errOut ?? defaultErrOut,
    now: opts.now ?? Date.now,
    threshold: LEVEL_RANKS[level],
  }
}

function defaultOut(line: string): void {
  if (typeof process !== 'undefined' && process.stdout) {
    process.stdout.write(line + '\n')
  } else {
    // eslint-disable-next-line no-console -- last-resort fallback
    console.log(line)
  }
}
function defaultErrOut(line: string): void {
  if (typeof process !== 'undefined' && process.stderr) {
    process.stderr.write(line + '\n')
  } else {
    // eslint-disable-next-line no-console -- last-resort fallback
    console.error(line)
  }
}

class LoggerImpl implements Logger {
  private readonly bindings: Record<string, unknown>
  private readonly opts: ResolvedOpts

  constructor(bindings: Record<string, unknown>, opts: ResolvedOpts) {
    this.bindings = bindings
    this.opts = opts
  }

  trace(msg: string, ctx?: Record<string, unknown>) { this.write('trace', msg, ctx) }
  debug(msg: string, ctx?: Record<string, unknown>) { this.write('debug', msg, ctx) }
  info(msg: string, ctx?: Record<string, unknown>)  { this.write('info', msg, ctx) }
  warn(msg: string, ctx?: Record<string, unknown>)  { this.write('warn', msg, ctx) }
  error(msg: string, ctx?: Record<string, unknown>) { this.write('error', msg, ctx) }
  fatal(msg: string, ctx?: Record<string, unknown>) { this.write('fatal', msg, ctx) }

  child(bindings: Record<string, unknown>): Logger {
    return new LoggerImpl({ ...this.bindings, ...bindings }, this.opts)
  }

  private write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (this.opts.disabled) return
    if (LEVEL_RANKS[level] < this.opts.threshold) return
    const ts = new Date(this.opts.now()).toISOString()
    const sink = LEVEL_RANKS[level] >= LEVEL_RANKS.warn ? this.opts.errOut : this.opts.out
    const line = this.opts.format === 'pretty'
      ? formatPretty(ts, level, this.bindings, msg, ctx)
      : formatJson(ts, level, this.bindings, msg, ctx)
    sink(line)
  }
}

// ── Formatters ───────────────────────────────────────────────────────────

function formatJson(
  ts: string,
  level: LogLevel,
  bindings: Record<string, unknown>,
  msg: string,
  ctx: Record<string, unknown> | undefined,
): string {
  // Deterministic key order: ts → level → bindings → msg → ctx. Helps
  // when humans scan lines and when downstream tools sort or dedup.
  const obj: Record<string, unknown> = { ts, level }
  for (const k of Object.keys(bindings)) obj[k] = bindings[k]
  obj.msg = msg
  if (ctx) for (const k of Object.keys(ctx)) obj[k] = ctx[k]
  return JSON.stringify(obj, jsonReplacer)
}

const COLOR: Record<LogLevel, string> = {
  silent: '',
  trace: '\x1b[90m', // grey
  debug: '\x1b[36m', // cyan
  info:  '\x1b[32m', // green
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  fatal: '\x1b[35m', // magenta
}
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

function formatPretty(
  ts: string,
  level: LogLevel,
  bindings: Record<string, unknown>,
  msg: string,
  ctx: Record<string, unknown> | undefined,
): string {
  // Trim ts to "2026-05-13 05:45:12.234" — easier to scan than full ISO.
  const tsShort = ts.slice(0, 23).replace('T', ' ')
  const levelPad = level.toUpperCase().padEnd(5)
  const comp = bindings.comp ? `[${String(bindings.comp)}]` : ''
  const compStr = comp ? ` ${comp}` : ''
  let extras = ''
  // Bindings without `comp` (which is already on the line as a prefix).
  for (const k of Object.keys(bindings)) {
    if (k === 'comp') continue
    extras += ` ${DIM}${k}${RESET}=${fmtVal(bindings[k])}`
  }
  if (ctx) for (const k of Object.keys(ctx)) {
    extras += ` ${DIM}${k}${RESET}=${fmtVal(ctx[k])}`
  }
  return `${DIM}${tsShort}${RESET} ${COLOR[level]}${levelPad}${RESET}${compStr} ${msg}${extras}`
}

function fmtVal(v: unknown): string {
  if (v == null) return String(v)
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Error) return `${v.name}:${v.message}`
  if (typeof v === 'object') {
    try { return JSON.stringify(v, jsonReplacer) } catch { return '[unserializable]' }
  }
  return String(v)
}

/**
 * Make non-JSON-native values safe in JSON output. BigInts → strings.
 * Errors → plain objects with name/message/stack (default JSON.stringify
 * would emit `{}` for Error instances).
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}
