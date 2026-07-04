import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { createLogger, type LogLevel } from '../src/logger.js'

/**
 * Helpers to capture log output. Each test gets a fresh sink so lines
 * never leak across tests. We always use `format: 'json'` for assertion
 * stability — pretty mode is verified separately with regex matchers.
 */
function makeSink() {
  const out: string[] = []
  const errOut: string[] = []
  return {
    out,
    errOut,
    write: (line: string) => out.push(line),
    writeErr: (line: string) => errOut.push(line),
  }
}

const FIXED_TS = '2026-05-13T05:00:00.000Z'
const fixedNow = () => Date.parse(FIXED_TS)

describe('createLogger — JSON format', () => {
  it('emits one JSON line per call with ts, level, comp, msg in order', () => {
    const sink = makeSink()
    const log = createLogger('host', {
      level: 'trace',
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.info('boot', { port: 3000 })
    expect(sink.out.length).toBe(1)
    const parsed = JSON.parse(sink.out[0]!)
    expect(parsed).toEqual({
      ts: FIXED_TS,
      level: 'info',
      comp: 'host',
      msg: 'boot',
      port: 3000,
    })
    // Key order matters for human grep — assert it explicitly.
    expect(Object.keys(parsed)).toEqual(['ts', 'level', 'comp', 'msg', 'port'])
  })

  it('routes warn/error/fatal to errOut, info/debug/trace to out', () => {
    const sink = makeSink()
    const log = createLogger('x', {
      level: 'trace',
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.trace('a')
    log.debug('b')
    log.info('c')
    log.warn('d')
    log.error('e')
    log.fatal('f')
    expect(sink.out.length).toBe(3)
    expect(sink.errOut.length).toBe(3)
    expect(sink.out.map((l) => JSON.parse(l).level)).toEqual(['trace', 'debug', 'info'])
    expect(sink.errOut.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error', 'fatal'])
  })

  it('serialises BigInt and Error context values safely', () => {
    const sink = makeSink()
    const log = createLogger('x', {
      level: 'info',
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.error('boom', { count: 9999999999999999n, err: new Error('nope') })
    const parsed = JSON.parse(sink.errOut[0]!)
    expect(parsed.count).toBe('9999999999999999')
    expect(parsed.err).toMatchObject({ name: 'Error', message: 'nope' })
  })
})

describe('createLogger — levels', () => {
  it('suppresses lines below the configured level', () => {
    const sink = makeSink()
    const log = createLogger('x', {
      level: 'warn',
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')
    expect(sink.out.length).toBe(0)
    expect(sink.errOut.length).toBe(2)
    expect(sink.errOut.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error'])
  })

  it("level 'silent' suppresses everything, including fatal", () => {
    const sink = makeSink()
    const log = createLogger('x', {
      level: 'silent',
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    for (const lvl of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as LogLevel[]) {
      log[lvl as 'info']('msg')
    }
    expect(sink.out.length).toBe(0)
    expect(sink.errOut.length).toBe(0)
  })

  it("disabled: true short-circuits regardless of level", () => {
    const sink = makeSink()
    const log = createLogger('x', {
      level: 'trace',
      disabled: true,
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.info('a')
    log.error('b')
    expect(sink.out.length).toBe(0)
    expect(sink.errOut.length).toBe(0)
  })
})

describe('createLogger — child', () => {
  it('child bindings are merged into every line', () => {
    const sink = makeSink()
    const log = createLogger('host', {
      level: 'info',
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    const sub = log.child({ subsys: 'local-agents', spaceId: 'abc' })
    sub.info('spawned', { id: 'writer-zh' })
    const parsed = JSON.parse(sink.out[0]!)
    expect(parsed.comp).toBe('host')
    expect(parsed.subsys).toBe('local-agents')
    expect(parsed.spaceId).toBe('abc')
    expect(parsed.id).toBe('writer-zh')
  })

  it('child can override parent bindings (later wins)', () => {
    const sink = makeSink()
    const log = createLogger('host', {
      level: 'info',
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    const sub = log.child({ comp: 'workflow-runner' })
    sub.info('hi')
    expect(JSON.parse(sink.out[0]!).comp).toBe('workflow-runner')
  })

  it('child inherits the parent options (level, format, sinks)', () => {
    const sink = makeSink()
    const log = createLogger('host', {
      level: 'warn',
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    const sub = log.child({ subsys: 'x' })
    sub.info('quiet')   // below threshold → dropped
    sub.error('loud')   // above threshold → kept
    expect(sink.out.length).toBe(0)
    expect(sink.errOut.length).toBe(1)
  })
})

describe('createLogger — pretty format', () => {
  it('renders a single human-readable line with ts, level, comp, msg, k=v extras', () => {
    const sink = makeSink()
    const log = createLogger('host', {
      level: 'info',
      format: 'pretty',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.info('boot complete', { port: 3000, mode: 'demo' })
    expect(sink.out.length).toBe(1)
    const line = sink.out[0]!
    // Strip ANSI for stable matching.
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '')
    expect(plain).toContain('2026-05-13 05:00:00.000')
    expect(plain).toContain('INFO ')
    expect(plain).toContain('[host]')
    expect(plain).toContain('boot complete')
    expect(plain).toContain('port=3000')
    expect(plain).toContain('mode=demo')
  })

  it('quotes string values that contain spaces', () => {
    const sink = makeSink()
    const log = createLogger('x', {
      level: 'info',
      format: 'pretty',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.info('hi', { name: 'two words' })
    const plain = sink.out[0]!.replace(/\x1b\[[0-9;]*m/g, '')
    expect(plain).toContain('name="two words"')
  })
})

describe('createLogger — env vars', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    delete process.env.GOTONG_LOG_LEVEL
    delete process.env.GOTONG_LOG_FORMAT
    delete process.env.GOTONG_LOG_DISABLED
  })
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('GOTONG_LOG_LEVEL=warn raises the threshold', () => {
    process.env.GOTONG_LOG_LEVEL = 'warn'
    const sink = makeSink()
    const log = createLogger('x', {
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.info('a')
    log.warn('b')
    expect(sink.out.length).toBe(0)
    expect(sink.errOut.length).toBe(1)
  })

  it('GOTONG_LOG_FORMAT=json overrides TTY-derived default', () => {
    process.env.GOTONG_LOG_FORMAT = 'json'
    const sink = makeSink()
    const log = createLogger('x', {
      level: 'info',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.info('hi')
    // If env was respected we get parseable JSON; pretty mode would
    // include ANSI escape sequences instead.
    expect(() => JSON.parse(sink.out[0]!)).not.toThrow()
  })

  it("GOTONG_LOG_DISABLED='1' silences output", () => {
    process.env.GOTONG_LOG_DISABLED = '1'
    const sink = makeSink()
    const log = createLogger('x', {
      level: 'trace',
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.info('a')
    log.error('b')
    expect(sink.out.length).toBe(0)
    expect(sink.errOut.length).toBe(0)
  })

  it('explicit opts beat env vars', () => {
    process.env.GOTONG_LOG_LEVEL = 'error'
    process.env.GOTONG_LOG_DISABLED = '1'
    const sink = makeSink()
    const log = createLogger('x', {
      level: 'info',     // opt > env
      disabled: false,   // opt > env
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.info('a')
    expect(sink.out.length).toBe(1)
  })

  it('unknown GOTONG_LOG_LEVEL value falls back to info', () => {
    process.env.GOTONG_LOG_LEVEL = 'verbose'
    const sink = makeSink()
    const log = createLogger('x', {
      format: 'json',
      out: sink.write,
      errOut: sink.writeErr,
      now: fixedNow,
    })
    log.debug('hidden')
    log.info('shown')
    expect(sink.out.length).toBe(1)
    expect(JSON.parse(sink.out[0]!).msg).toBe('shown')
  })
})
