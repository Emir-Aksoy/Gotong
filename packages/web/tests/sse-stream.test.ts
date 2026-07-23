/**
 * Perf audit A④ — /api/stream behavior tests.
 *
 *   1. `?kinds=a,b` narrows the firehose to those event kinds; a client
 *      without the param still gets everything (pre-A④ byte-identical).
 *   2. A stalled client (TCP reader paused) is destroyed once its socket
 *      queues >1MiB server-side — the firehose must never buffer without
 *      bound in host memory for one slow consumer.
 *
 * Boot mirrors auth.test.ts: real serveWeb over a temp-dir Space, admin
 * session cookie minted directly. Events are driven through the public
 * `hub.transcript.append` (hub.onEvent === transcript.onAppend).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminCookie: string
}

async function boot(): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-sse-'))
  const init = await Space.init(tmp, { name: 'sse-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { admin } = await space.createAdmin('SseAdmin')
  const adminSid = 'a-sse-sid-' + Math.random().toString(36).slice(2)
  await space.addAdminSession(adminSid, admin.id)
  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0 })
  return { tmp, hub, server, baseUrl: server.url, adminCookie: `gotong_admin=${adminSid}` }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

/** Read from an SSE body reader until `pred(buffer)` or the timeout; returns the buffer. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pred: (buf: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !pred(buf)) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now()))),
    ])
    if (!chunk || chunk.done) break
    buf += Buffer.from(chunk.value).toString('utf8')
  }
  return buf
}

function emit(hub: Hub, kind: 'participant_left', id: string): void {
  hub.transcript.append({ ts: Date.now(), kind, data: { id } })
}

describe('/api/stream (perf audit A④)', () => {
  let b: BootResult
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await teardown(b)
  })

  it('?kinds= narrows the stream; a paramless client still gets the firehose', async () => {
    const ctl = new AbortController()
    try {
      const filtered = await fetch(`${b.baseUrl}/api/stream?kinds=participant_left`, {
        headers: { cookie: b.adminCookie },
        signal: ctl.signal,
      })
      const full = await fetch(`${b.baseUrl}/api/stream`, {
        headers: { cookie: b.adminCookie },
        signal: ctl.signal,
      })
      expect(filtered.status).toBe(200)
      expect(full.status).toBe(200)
      const fr = filtered.body!.getReader()
      const ur = full.body!.getReader()
      // Wait for the preamble so both clients are registered before emitting.
      await readUntil(fr, (s) => s.includes('retry:'))
      await readUntil(ur, (s) => s.includes('retry:'))

      b.hub.transcript.append({
        ts: Date.now(),
        kind: 'task_resumed',
        data: { taskId: 't-sse-1', by: 'p-sse-1' },
      })
      emit(b.hub, 'participant_left', 'p-gone')

      // Writes per client are ordered: task_resumed was emitted first, so if
      // the filter leaked it, it would already be in the buffer by the time
      // participant_left shows up.
      const fbuf = await readUntil(fr, (s) => s.includes('participant_left'))
      expect(fbuf).toContain('event: participant_left')
      expect(fbuf).not.toContain('task_resumed')

      const ubuf = await readUntil(ur, (s) => s.includes('participant_left'))
      expect(ubuf).toContain('event: task_resumed')
      expect(ubuf).toContain('event: participant_left')
    } finally {
      ctl.abort()
    }
  }, 15000)

  it('destroys a stalled client instead of buffering the firehose without bound', async () => {
    const url = new URL(b.baseUrl)
    const sock: Socket = connect({ host: url.hostname, port: Number(url.port) })
    sock.on('error', () => {
      /* an RST from the server-side destroy is an expected outcome */
    })
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('error', reject)
    })
    let sawClose = false
    const closed = new Promise<void>((resolve) =>
      sock.once('close', () => {
        sawClose = true
        resolve()
      }),
    )
    let total = 0
    sock.write(
      `GET /api/stream HTTP/1.1\r\nhost: ${url.host}\r\ncookie: ${b.adminCookie}\r\n\r\n`,
    )
    await new Promise<void>((resolve) => {
      let buf = ''
      const onData = (d: Buffer): void => {
        total += d.length
        buf += d.toString('utf8')
        if (buf.includes('retry:')) {
          sock.off('data', onData)
          resolve()
        }
      }
      sock.on('data', onData)
    })

    // Stall the reader: the client kernel recv buffer fills, then the server
    // send buffer, then writes queue in the server's user-space Writable —
    // exactly the growth writableLength measures. Push ~19MB through the
    // fanout, far past the 1MiB cap.
    sock.pause()
    const big = 'x'.repeat(64 * 1024)
    const EMITS = 300
    for (let i = 0; i < EMITS; i++) {
      emit(b.hub, 'participant_left', big)
      // Yield so the event loop can flush socket writes between appends.
      await new Promise((r) => setImmediate(r))
    }

    // The observable of the server-side destroy: what the client can still
    // drain afterwards is only whatever the kernels had buffered when the
    // server cut the socket — nowhere near the full firehose. (Waiting for
    // the client 'close' while paused is not deterministic: a FIN is
    // data-ordered and a paused socket never reads up to it.)
    sock.on('data', (d) => {
      total += d.length
    })
    sock.resume()
    await Promise.race([closed, new Promise((r) => setTimeout(r, 8000))])
    expect(sawClose).toBe(true)
    expect(total).toBeLessThan(4 * 1024 * 1024)
  }, 30000)
})
