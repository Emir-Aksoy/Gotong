import { PassThrough } from 'node:stream'
import { describe, it, expect } from 'vitest'

import { AcpSession } from '../src/acp-session.js'
import { selectedOutcome, updateText, type RequestPermissionParams } from '../src/acp-protocol.js'
import { createMockAcpAgent } from './mock-acp-agent.js'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function observe(session: AcpSession): string[] {
  const out: string[] = []
  session.onUpdate((u) => {
    const t = updateText(u)
    if (t) out.push(t)
  })
  return out
}

describe('AcpSession — handshake + prompt', () => {
  it('handshakes exactly once and caches the sessionId (hold the session)', async () => {
    const { transport, stats } = createMockAcpAgent()
    const session = new AcpSession({ command: 'unused', transport })
    const a = await session.ensureStarted()
    const b = await session.ensureStarted()
    expect(a.sessionId).toBe('mock-1')
    expect(b.sessionId).toBe('mock-1')
    expect(session.sessionId).toBe('mock-1')
    expect(stats.initCount).toBe(1) // spawn + initialize happened once, not per call
  })

  it('prompt streams OBSERVE chunks then resolves done/end_turn', async () => {
    const { transport } = createMockAcpAgent()
    const session = new AcpSession({ command: 'x', transport })
    const updates = observe(session)
    await session.ensureStarted()

    const out = await session.prompt('hello')
    expect(out).toEqual({ kind: 'done', stopReason: 'end_turn' })
    expect(updates.some((u) => u.includes('echo:hello'))).toBe(true)
  })

  it('dispatches two prompts to the SAME held session (context preserved)', async () => {
    const { transport, stats } = createMockAcpAgent()
    const session = new AcpSession({ command: 'x', transport })
    const updates = observe(session)
    await session.ensureStarted()

    await session.prompt('first')
    const out2 = await session.prompt('second')
    expect(out2).toEqual({ kind: 'done', stopReason: 'end_turn' })
    expect(stats.promptCount).toBe(2)
    // turn=2 only appears because the per-session counter advanced — same session.
    expect(updates.some((u) => u.includes('turn=2'))).toBe(true)
  })

  it('initialize timeout rejects ensureStarted', async () => {
    // A transport whose agent never answers anything.
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const session = new AcpSession({ command: 'x', transport: { input, output }, initTimeoutMs: 30 })
    await expect(session.ensureStarted()).rejects.toMatchObject({ name: 'AcpConnectionError' })
  })
})

describe('AcpSession — permission (INTERCEPT)', () => {
  it('routes a reverse permission request to onPermission; inline allow → end_turn', async () => {
    const { transport } = createMockAcpAgent()
    const session = new AcpSession({ command: 'x', transport })
    const seen: RequestPermissionParams[] = []
    session.onPermission((params) => {
      seen.push(params)
      return { respond: selectedOutcome('allow') }
    })
    await session.ensureStarted()

    const out = await session.prompt('please NEED_PERM now')
    expect(seen).toHaveLength(1)
    expect(seen[0].toolCall.title).toBe('rm -rf build')
    expect(out).toEqual({ kind: 'done', stopReason: 'end_turn' })
  })

  it('inline deny → refusal (fail-closed)', async () => {
    const { transport } = createMockAcpAgent()
    const session = new AcpSession({ command: 'x', transport })
    session.onPermission(() => ({ respond: selectedOutcome('reject') }))
    await session.ensureStarted()

    const out = await session.prompt('NEED_PERM')
    expect(out).toEqual({ kind: 'done', stopReason: 'refusal' })
  })

  it('escalate → prompt resolves escalated; respond+awaitStopReason re-awaits the SAME turn', async () => {
    const { transport } = createMockAcpAgent()
    const session = new AcpSession({ command: 'x', transport })
    session.onPermission(() => ({ escalate: true }))
    await session.ensureStarted()

    const out = await session.prompt('NEED_PERM')
    expect(out.kind).toBe('escalated')
    if (out.kind !== 'escalated') return
    expect(out.permission.params.toolCall.title).toBe('rm -rf build')
    expect(out.permission.token).toMatch(/^acp-perm-/)

    // Resume: answer the still-open reverse request, then await the held turn.
    out.permission.respond(selectedOutcome('allow'))
    const stop = await out.permission.awaitStopReason()
    expect(stop).toBe('end_turn')
  })
})

describe('AcpSession — cancel + terminate (TERMINATE)', () => {
  it('cancel ends the in-flight prompt with stopReason cancelled', async () => {
    const { transport } = createMockAcpAgent()
    const session = new AcpSession({ command: 'x', transport })
    await session.ensureStarted()

    const p = session.prompt('please HANG forever')
    await tick() // let the mock receive the prompt + park it
    session.cancel()
    const out = await p
    expect(out).toEqual({ kind: 'done', stopReason: 'cancelled' })
  })

  it('terminate flips alive to false', async () => {
    const { transport } = createMockAcpAgent()
    const session = new AcpSession({ command: 'x', transport })
    await session.ensureStarted()
    expect(session.alive).toBe(true)
    await session.terminate()
    expect(session.alive).toBe(false)
  })
})
