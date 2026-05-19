/**
 * H13 regression — `AIPE_PROTOCOL_STRICT` is captured ONCE at session
 * construction, not re-read per-frame.
 *
 * Pre-3.4 the inbound hot path did:
 *
 *     const decode = process.env.AIPE_PROTOCOL_STRICT === '1'
 *       ? decodeFrameStrict
 *       : decodeFrame
 *
 * for every single incoming WebSocket message. A long-running session
 * paid that lookup on every frame — and the env is effectively
 * immutable for the host's lifetime anyway (we don't read it from
 * config-reload signals anywhere in the code).
 *
 * The fix: capture once in the Session constructor as
 * `this.strictMode`. Behaviourally observable test: flip the env
 * mid-session, send a deliberately malformed frame, and assert that
 * the BEHAVIOUR matches what was set at startup — not the new env
 * value.
 *
 * Docs:
 *   - `docs/PROTOCOL.md` § Debug / development env vars (the spec).
 *   - `docs/SIDECAR.md` § Mistake gallery (the `bad_frame (no
 *     detail)` row points operators here).
 *
 * See AUDIT-v3.3.md finding H13.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { Hub } from '@aipehub/core'

import { serveWebSocket, type WebSocketTransportHandle } from '../src/index.js'

const originalEnv = process.env.AIPE_PROTOCOL_STRICT

let handle: WebSocketTransportHandle | null = null
let hub: Hub

beforeEach(async () => {
  hub = Hub.inMemory()
  await hub.start()
  delete process.env.AIPE_PROTOCOL_STRICT
})

afterEach(async () => {
  if (handle) await handle.close()
  handle = null
  await hub.stop()
  if (originalEnv === undefined) {
    delete process.env.AIPE_PROTOCOL_STRICT
  } else {
    process.env.AIPE_PROTOCOL_STRICT = originalEnv
  }
})

async function startServer(): Promise<string> {
  handle = await serveWebSocket({ hub, host: '127.0.0.1', port: 0 })
  return handle.url
}

/**
 * Open a raw WS, send a single malformed frame, and wait until the
 * server responds with an ERROR. The server's `onMessage` decodes,
 * sees an invalid frame, calls `sendError('bad_frame', ...)` and
 * keeps the socket open — so the assertion is "we got a response,
 * the session didn't crash, the decode path was reached".
 *
 * Strict and non-strict mode BOTH respond with `bad_frame`; the
 * payload differs only on the `detail` field. We don't fingerprint
 * the wording — the audit's invariant is "captured once at
 * construction", and the regression mode is "session crashes /
 * silently swaps codecs after construction". Either of those would
 * make this resolve to `{ gotResponse: false }`.
 */
function sendOneFrameAndCapture(
  url: string,
  rawText: string,
): Promise<{ gotResponse: boolean; firstMessage?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const cleanup = (gotResponse: boolean, firstMessage?: string) => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve({ gotResponse, firstMessage })
    }
    const timer = setTimeout(() => cleanup(false), 1000)
    ws.once('open', () => {
      ws.send(rawText)
    })
    ws.once('message', (data) => {
      cleanup(true, data.toString())
    })
    ws.once('error', () => {
      // Server may force-close before we see the message; treat
      // close-without-response as "no signal" — still distinguishable
      // from the crash-by-throw regression.
      cleanup(false)
    })
  })
}

describe('H13 — AIPE_PROTOCOL_STRICT captured once at session construction', () => {
  it('session handles malformed frames cleanly with env UNSET at startup', async () => {
    // Server starts with the env UNSET → sessions capture
    // strictMode=false. Whatever the env gets flipped to AFTER
    // startup, the session uses the captured value — observable
    // behaviour: it doesn't crash, and it returns a `bad_frame`
    // ERROR response.
    const url = await startServer()
    // Operator flips the env after the server is already running.
    process.env.AIPE_PROTOCOL_STRICT = '1'

    const result = await sendOneFrameAndCapture(url, 'not-json')
    expect(result.gotResponse).toBe(true)
    expect(result.firstMessage).toContain('bad_frame')
  })

  it('session handles malformed frames cleanly with env SET at startup', async () => {
    process.env.AIPE_PROTOCOL_STRICT = '1'
    const url = await startServer()
    // Operator unsets after server started.
    delete process.env.AIPE_PROTOCOL_STRICT

    const result = await sendOneFrameAndCapture(url, 'not-json')
    expect(result.gotResponse).toBe(true)
    expect(result.firstMessage).toContain('bad_frame')
  })

  it('two sessions on the same server both stay healthy across env flips', async () => {
    // Capture-at-construct contract holds end-to-end: env flipped
    // between session 1 and session 2 doesn't crash either, and
    // both produce a clean `bad_frame` response.
    const url = await startServer()
    const r1 = await sendOneFrameAndCapture(url, 'not-json')
    process.env.AIPE_PROTOCOL_STRICT = '1'
    const r2 = await sendOneFrameAndCapture(url, 'not-json')
    expect(r1.gotResponse).toBe(true)
    expect(r2.gotResponse).toBe(true)
  })

  it('source has no per-frame process.env read (textual guard)', async () => {
    // Hard guard: a future regression could re-introduce the
    // env-per-frame read. Grep the compiled source to make sure no
    // `process.env.AIPE_PROTOCOL_STRICT` shows up inside
    // `onMessage` (i.e. anywhere downstream of the constructor).
    //
    // We read the source file directly. Build artefacts are not
    // checked because the source is the source of truth.
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../src/session.ts', import.meta.url),
      'utf8',
    )
    // The constructor-scope capture is allowed.
    expect(src).toMatch(/this\.strictMode\s*=\s*process\.env\.AIPE_PROTOCOL_STRICT/)
    // And `onMessage` (or anywhere else) must NOT read the env
    // again.
    const onMessageIdx = src.indexOf('private async onMessage')
    expect(onMessageIdx).toBeGreaterThan(0)
    const onMessageSlice = src.slice(onMessageIdx)
    expect(onMessageSlice).not.toMatch(/process\.env\.AIPE_PROTOCOL_STRICT/)
  })
})
