import { PassThrough } from 'node:stream'
import { describe, it, expect } from 'vitest'

import { AcpConnection, type AcpTransport } from '../src/acp-connection.js'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * Crosswise PassThrough pair = an in-process stand-in for the agent's stdio.
 * The connection reads `input` (agent → hub) and writes `output` (hub → agent).
 * The test plays the agent: it reads lines off `output` and pushes lines on `input`.
 */
function wire(): {
  conn: AcpConnection
  transport: AcpTransport
  pushFromAgent: (msg: unknown) => void
  endAgent: () => void
  nextHubLine: () => Promise<any>
  pendingHubLines: () => number
} {
  const input = new PassThrough() // agent → hub
  const output = new PassThrough() // hub → agent
  const transport: AcpTransport = { input, output }
  const conn = new AcpConnection(transport)

  // Collect lines the hub wrote, with an await-next primitive.
  const lines: string[] = []
  const waiters: Array<() => void> = []
  let buf = ''
  output.on('data', (c: Buffer) => {
    buf += c.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      lines.push(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      const w = waiters.shift()
      if (w) w()
    }
  })

  return {
    conn,
    transport,
    pushFromAgent: (msg) => input.write(JSON.stringify(msg) + '\n'),
    endAgent: () => input.end(),
    async nextHubLine() {
      if (lines.length === 0) await new Promise<void>((r) => waiters.push(r))
      return JSON.parse(lines.shift() as string)
    },
    pendingHubLines: () => lines.length,
  }
}

describe('AcpConnection — outbound requests', () => {
  it('correlates concurrent requests to their own responses by id', async () => {
    const w = wire()
    const p1 = w.conn.request('alpha', { a: 1 })
    const p2 = w.conn.request('beta', { b: 2 })

    const r1 = await w.nextHubLine()
    const r2 = await w.nextHubLine()
    expect(r1).toEqual({ jsonrpc: '2.0', id: 1, method: 'alpha', params: { a: 1 } })
    expect(r2).toEqual({ jsonrpc: '2.0', id: 2, method: 'beta', params: { b: 2 } })

    // Respond out of order — each promise must still get its own result.
    w.pushFromAgent({ jsonrpc: '2.0', id: r2.id, result: { v: 'two' } })
    w.pushFromAgent({ jsonrpc: '2.0', id: r1.id, result: { v: 'one' } })
    expect(await p1).toEqual({ v: 'one' })
    expect(await p2).toEqual({ v: 'two' })
  })

  it('omits params when undefined', async () => {
    const w = wire()
    void w.conn.request('ping')
    expect(await w.nextHubLine()).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' })
  })

  it('rejects with a typed error carrying the JSON-RPC code', async () => {
    const w = wire()
    const p = w.conn.request('boom')
    const req = await w.nextHubLine()
    w.pushFromAgent({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'nope' } })
    await expect(p).rejects.toMatchObject({ name: 'AcpConnectionError', code: -32601 })
  })

  it('reassembles a response split across chunk boundaries (half-line buffer)', async () => {
    const w = wire()
    const p = w.conn.request('m')
    const req = await w.nextHubLine()
    const full = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }) + '\n'
    const mid = Math.floor(full.length / 2)

    let resolved = false
    void p.then(() => {
      resolved = true
    })
    w.transport.input.write(full.slice(0, mid))
    await tick()
    expect(resolved).toBe(false) // no newline yet → still buffered
    w.transport.input.write(full.slice(mid))
    expect(await p).toEqual({ ok: true })
  })

  it('aborts an in-flight request via its signal and drops a late response', async () => {
    const w = wire()
    const ac = new AbortController()
    const p = w.conn.request('slow', undefined, { signal: ac.signal })
    await w.nextHubLine()
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AcpConnectionError' })
    // A late response for the aborted id is simply ignored (no throw, no second settle).
    w.pushFromAgent({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    await tick()
  })
})

describe('AcpConnection — inbound notifications + reverse requests', () => {
  it('delivers notifications to onNotify', async () => {
    const w = wire()
    const seen: Array<{ method: string; params: unknown }> = []
    w.conn.onNotify((method, params) => seen.push({ method, params }))
    w.pushFromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { x: 1 } } })
    await tick()
    expect(seen).toEqual([{ method: 'session/update', params: { sessionId: 's', update: { x: 1 } } }])
  })

  it('routes a reverse request to onRequest and is DEFERRED — no auto-answer until respond()', async () => {
    const w = wire()
    let got: { method: string; params: unknown; id: unknown } | undefined
    w.conn.onRequest((method, params, id) => {
      got = { method, params, id }
    })
    w.pushFromAgent({
      jsonrpc: '2.0',
      id: 'perm-1',
      method: 'session/request_permission',
      params: { sessionId: 's' },
    })
    await tick()
    expect(got).toEqual({ method: 'session/request_permission', params: { sessionId: 's' }, id: 'perm-1' })
    // Deferred: handler chose not to answer yet → nothing written. (= subprocess stays blocked.)
    expect(w.pendingHubLines()).toBe(0)

    // Now answer it.
    w.conn.respond('perm-1', { outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(await w.nextHubLine()).toEqual({
      jsonrpc: '2.0',
      id: 'perm-1',
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    })
  })

  it('auto-rejects a reverse request when NO handler is registered (fail fast, do not hang)', async () => {
    const w = wire()
    w.pushFromAgent({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: {} })
    const line = await w.nextHubLine()
    expect(line).toMatchObject({ jsonrpc: '2.0', id: 9, error: { code: -32601 } })
  })
})

describe('AcpConnection — close', () => {
  it('rejects in-flight requests and fires onClose when input ends', async () => {
    const w = wire()
    let closed = false
    w.conn.onClose(() => {
      closed = true
    })
    const p = w.conn.request('m')
    await w.nextHubLine()
    w.endAgent()
    await expect(p).rejects.toMatchObject({ name: 'AcpConnectionError' })
    expect(closed).toBe(true)
  })

  it('rejects new requests after close', async () => {
    const w = wire()
    w.conn.close()
    await expect(w.conn.request('m')).rejects.toMatchObject({ name: 'AcpConnectionError' })
  })
})
