/**
 * HubLink (inproc) — M2 of the hub-mesh implementation.
 *
 * Pins the SYMMETRIC contract: either side can dispatch / publish to
 * the other; either side can close; closes propagate symmetrically.
 *
 * Two hubs are not wired in these tests — that's M4. Here we exercise
 * the link in isolation with hand-written task / message handlers, to
 * keep the contract clean of Hub coupling.
 */

import { describe, expect, it } from 'vitest'

import { createInprocHubLinkPair } from '../src/hub-link.js'
import type { Message, Task, TaskResult } from '../src/types.js'

function makeTask(id: string, payload: unknown = {}): Task {
  return {
    id,
    from: 'tester',
    strategy: { kind: 'capability', capabilities: ['x'] },
    payload,
    createdAt: Date.now(),
  }
}

function makeMessage(id: string, body: unknown = {}): Message {
  return {
    id,
    channel: 'announcements',
    from: 'tester',
    body,
    ts: Date.now(),
  }
}

describe('InprocHubLink', () => {
  it('dispatch from A reaches B handler and result flows back', async () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })

    b.on('task', async (task) => ({
      kind: 'ok',
      taskId: task.id,
      by: 'b-handler',
      output: { processed: task.id },
      ts: Date.now(),
    }))

    const result = await a.dispatch(makeTask('t1'))
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('b-handler')
      expect(result.output).toMatchObject({ processed: 't1' })
    }
  })

  it('dispatch from B reaches A handler (symmetry)', async () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })

    a.on('task', async (task) => ({
      kind: 'ok',
      taskId: task.id,
      by: 'a-handler',
      output: { reverse: true },
      ts: Date.now(),
    }))

    const result = await b.dispatch(makeTask('t2'))
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('a-handler')
      expect(result.output).toMatchObject({ reverse: true })
    }
  })

  it('publish from A is fanned out to all message handlers on B', () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })

    const received1: Message[] = []
    const received2: Message[] = []
    b.on('message', (m) => {
      received1.push(m)
    })
    b.on('message', (m) => {
      received2.push(m)
    })

    a.publish(makeMessage('m1', { hello: 'B' }))

    expect(received1.length).toBe(1)
    expect(received2.length).toBe(1)
    expect(received1[0].body).toMatchObject({ hello: 'B' })
  })

  it('peerId fields are set per-side', () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    expect(a.peerId).toBe('hubB')
    expect(b.peerId).toBe('hubA')
    expect(a.direction).toBe('inproc')
    expect(b.direction).toBe('inproc')
  })

  it('dispatch returns no_participant if peer has no task handler', async () => {
    const { a } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // No b.on('task', ...) registered.
    const result = await a.dispatch(makeTask('t3'))
    expect(result.kind).toBe('no_participant')
    if (result.kind === 'no_participant') {
      expect(result.taskId).toBe('t3')
      expect(result.reason).toMatch(/no task handler/)
    }
  })

  it('dispatch returns failed (link_closed) after close', async () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    b.on('task', async (task) => ({
      kind: 'ok',
      taskId: task.id,
      by: 'b',
      output: {},
      ts: Date.now(),
    }))

    await a.close()

    const result = await a.dispatch(makeTask('t4'))
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/link_closed/)
    }
  })

  it('close on A propagates symmetrically to B and fires both closed handlers', async () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })

    let aClosed = false
    let bClosed = false
    a.on('closed', () => {
      aClosed = true
    })
    b.on('closed', () => {
      bClosed = true
    })

    await a.close()

    expect(a.status).toBe('closed')
    expect(b.status).toBe('closed')
    expect(aClosed).toBe(true)
    expect(bClosed).toBe(true)
  })

  it('close is idempotent', async () => {
    const { a } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    let count = 0
    a.on('closed', () => {
      count++
    })
    await a.close()
    await a.close()
    await a.close()
    expect(count).toBe(1)
  })

  it("publish silently no-ops after close (doesn't throw, doesn't fan out)", async () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    const received: Message[] = []
    b.on('message', (m) => {
      received.push(m)
    })

    await a.close()
    a.publish(makeMessage('m-after-close'))

    expect(received.length).toBe(0)
  })

  it("registering 'task' handler twice throws (one handler per side)", () => {
    const { b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    b.on('task', async (t): Promise<TaskResult> => ({
      kind: 'ok',
      taskId: t.id,
      by: 'first',
      output: {},
      ts: Date.now(),
    }))
    expect(() =>
      b.on('task', async (t): Promise<TaskResult> => ({
        kind: 'ok',
        taskId: t.id,
        by: 'second',
        output: {},
        ts: Date.now(),
      })),
    ).toThrow(/already registered/)
  })

  it('a publish-handler that throws does not block the other handlers', () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    const seen: string[] = []
    b.on('message', () => {
      throw new Error('handler 1 boom')
    })
    b.on('message', (m) => {
      seen.push(m.id)
    })

    a.publish(makeMessage('m-mix'))
    expect(seen).toEqual(['m-mix'])
  })
})
