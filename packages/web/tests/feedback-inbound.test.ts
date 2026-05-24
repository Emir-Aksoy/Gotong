/**
 * GET /api/admin/feedback/inbound (M8) — admin reads the evaluations
 * other hubs have written about this hub.
 *
 * The endpoint is a thin read-only wrapper over `hub.inboundFeedback.query()`;
 * tests verify auth, filter passthrough, and sort order.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Hub,
  Space,
  type AdminRecord,
  type FeedbackEntryDraft,
} from '@aipehub/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  admin: AdminRecord
  token: string
}

async function boot(): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-feedback-inbound-'))
  const init = await Space.init(tmp, { name: 'm8-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { admin, token } = await space.createAdmin('TestAdmin')
  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0 })
  return { tmp, hub, space, server, baseUrl: server.url, admin, token }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

function draft(overrides: Partial<FeedbackEntryDraft> = {}): FeedbackEntryDraft {
  return {
    toHub: 'self',
    toParticipant: 'a-writer',
    taskRunId: 'run-1',
    scope: 'whole-task',
    rating: 4,
    evaluatorHub: 'hubB',
    evaluatorParticipant: 'b-admin',
    ...overrides,
  }
}

describe('GET /api/admin/feedback/inbound', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('without auth returns 401', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/feedback/inbound`)
    expect(res.status).toBe(401)
  })

  it('with no entries returns empty list', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/feedback/inbound`, {
      headers: { Authorization: `Bearer ${b.token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ entries: [] })
  })

  it('returns entries appended via hub.inboundFeedback', async () => {
    // Pin createdAt explicitly so the sort-desc assertion is deterministic
    // (two appendEntry calls in the same millisecond would otherwise tie).
    const e1 = b.hub.inboundFeedback.appendEntry(
      draft({ comment: 'first' }),
      { now: 1000 },
    )
    const e2 = b.hub.inboundFeedback.appendEntry(
      draft({ comment: 'second', evaluatorHub: 'hubC' }),
      { now: 2000 },
    )

    const res = await fetch(`${b.baseUrl}/api/admin/feedback/inbound`, {
      headers: { Authorization: `Bearer ${b.token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries.length).toBe(2)
    // Sorted by createdAt desc — e2 was appended later
    expect(body.entries[0].id).toBe(e2.id)
    expect(body.entries[1].id).toBe(e1.id)
  })

  it('filters by taskRunId', async () => {
    b.hub.inboundFeedback.appendEntry(draft({ taskRunId: 'run-A' }))
    b.hub.inboundFeedback.appendEntry(draft({ taskRunId: 'run-B' }))
    b.hub.inboundFeedback.appendEntry(draft({ taskRunId: 'run-A' }))

    const res = await fetch(
      `${b.baseUrl}/api/admin/feedback/inbound?taskRunId=run-A`,
      { headers: { Authorization: `Bearer ${b.token}` } },
    )
    const body = await res.json()
    expect(body.entries.length).toBe(2)
    expect(body.entries.every((e: { taskRunId: string }) => e.taskRunId === 'run-A')).toBe(true)
  })

  it('filters by fromHub (evaluator)', async () => {
    b.hub.inboundFeedback.appendEntry(draft({ evaluatorHub: 'hubB' }))
    b.hub.inboundFeedback.appendEntry(draft({ evaluatorHub: 'hubC' }))

    const res = await fetch(
      `${b.baseUrl}/api/admin/feedback/inbound?fromHub=hubC`,
      { headers: { Authorization: `Bearer ${b.token}` } },
    )
    const body = await res.json()
    expect(body.entries.length).toBe(1)
    expect(body.entries[0].evaluatorHub).toBe('hubC')
  })

  it('filters by status', async () => {
    const e1 = b.hub.inboundFeedback.appendEntry(draft({ comment: 'a' }))
    const e2 = b.hub.inboundFeedback.appendEntry(draft({ comment: 'b' }))
    b.hub.inboundFeedback.markRead(e1.id)

    const r1 = await fetch(
      `${b.baseUrl}/api/admin/feedback/inbound?status=read`,
      { headers: { Authorization: `Bearer ${b.token}` } },
    )
    expect((await r1.json()).entries.length).toBe(1)

    const r2 = await fetch(
      `${b.baseUrl}/api/admin/feedback/inbound?status=pending`,
      { headers: { Authorization: `Bearer ${b.token}` } },
    )
    const pending = await r2.json()
    expect(pending.entries.length).toBe(1)
    expect(pending.entries[0].id).toBe(e2.id)
  })

  it('unreadOnly=true is shorthand for status=delivered (the typical "needs attention" state)', async () => {
    // pending — never delivered (caller hasn't pulled it yet)
    b.hub.inboundFeedback.appendEntry(draft({ comment: 'pending-only' }))
    // delivered — pulled but not yet acted on (this is what UI typically shows)
    const e2 = b.hub.inboundFeedback.appendEntry(draft({ comment: 'delivered-only' }))
    b.hub.inboundFeedback.markDelivered(e2.id)
    // read — already handled
    const e3 = b.hub.inboundFeedback.appendEntry(draft({ comment: 'read' }))
    b.hub.inboundFeedback.markRead(e3.id)

    const res = await fetch(
      `${b.baseUrl}/api/admin/feedback/inbound?unreadOnly=true`,
      { headers: { Authorization: `Bearer ${b.token}` } },
    )
    const body = await res.json()
    expect(body.entries.length).toBe(1)
    expect(body.entries[0].id).toBe(e2.id)
  })
})
