import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'

const flush = () => new Promise<void>((r) => setImmediate(r))

describe('Hub admission gating (v1.1)', () => {
  it('requestAdmission appends agent_pending and lists the application', async () => {
    const hub = new Hub()
    await hub.start()
    const { applicationId, decision } = hub.requestAdmission({
      agents: [{ id: 'writer', capabilities: ['draft'] }],
      meta: { remoteAddress: '127.0.0.1' },
    })

    expect(applicationId).toBeTruthy()
    const pending = hub.pendingApplications()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.agents[0]!.id).toBe('writer')
    expect(pending[0]!.meta).toEqual({ remoteAddress: '127.0.0.1' })

    const kinds = hub.transcript.all().map((e) => e.kind)
    expect(kinds).toContain('agent_pending')

    // resolve before stop so the promise doesn't dangle
    hub.approveApplication(applicationId, 'admin')
    await expect(decision).resolves.toMatchObject({ approved: true, by: 'admin' })
    await hub.stop()
  })

  it('approveApplication appends agent_approved, removes from pending, resolves promise', async () => {
    const hub = new Hub()
    await hub.start()
    const { applicationId, decision } = hub.requestAdmission({
      agents: [{ id: 'reviewer', capabilities: ['review'] }],
    })

    const ok = hub.approveApplication(applicationId, 'alice')
    expect(ok).toBe(true)
    expect(hub.pendingApplications()).toHaveLength(0)

    const last = hub.transcript.all().at(-1)
    expect(last?.kind).toBe('agent_approved')
    if (last?.kind === 'agent_approved') {
      expect(last.data.applicationId).toBe(applicationId)
      expect(last.data.agentIds).toEqual(['reviewer'])
      expect(last.data.by).toBe('alice')
    }

    await expect(decision).resolves.toEqual({ approved: true, by: 'alice' })
    await hub.stop()
  })

  it('rejectApplication appends agent_rejected with reason', async () => {
    const hub = new Hub()
    await hub.start()
    const { applicationId, decision } = hub.requestAdmission({
      agents: [{ id: 'spammer', capabilities: [] }],
    })

    const ok = hub.rejectApplication(applicationId, 'looks fishy', 'admin')
    expect(ok).toBe(true)
    expect(hub.pendingApplications()).toHaveLength(0)

    const last = hub.transcript.all().at(-1)
    expect(last?.kind).toBe('agent_rejected')
    if (last?.kind === 'agent_rejected') {
      expect(last.data.reason).toBe('looks fishy')
      expect(last.data.by).toBe('admin')
      expect(last.data.agentIds).toEqual(['spammer'])
    }

    await expect(decision).resolves.toMatchObject({
      approved: false,
      reason: 'looks fishy',
      by: 'admin',
    })
    await hub.stop()
  })

  it('approve/reject for an unknown id returns false (no transcript noise)', async () => {
    const hub = new Hub()
    await hub.start()
    const before = hub.transcript.size()
    expect(hub.approveApplication('does-not-exist')).toBe(false)
    expect(hub.rejectApplication('also-not-exist', 'whatever')).toBe(false)
    expect(hub.transcript.size()).toBe(before)
    await hub.stop()
  })

  it('multi-agent application — single decision covers all listed agents', async () => {
    const hub = new Hub()
    await hub.start()
    const { applicationId, decision } = hub.requestAdmission({
      agents: [
        { id: 'a1', capabilities: ['draft'] },
        { id: 'a2', capabilities: ['review'] },
      ],
    })
    hub.approveApplication(applicationId, 'admin')

    const ev = hub.transcript.all().at(-1)
    if (ev?.kind === 'agent_approved') {
      expect(ev.data.agentIds).toEqual(['a1', 'a2'])
    } else {
      throw new Error('expected agent_approved')
    }
    await expect(decision).resolves.toMatchObject({ approved: true })
    await hub.stop()
  })

  it('hub.stop() resolves outstanding applications with hub_stopped', async () => {
    const hub = new Hub()
    await hub.start()
    const { decision } = hub.requestAdmission({
      agents: [{ id: 'orphan', capabilities: [] }],
    })
    await hub.stop()
    await expect(decision).resolves.toMatchObject({
      approved: false,
      reason: 'hub_stopped',
    })
  })

  it('pendingApplications ordering: oldest first', async () => {
    let t = 1_000
    const hub = new Hub({ now: () => t })
    await hub.start()

    const a = hub.requestAdmission({ agents: [{ id: 'a', capabilities: [] }] })
    t = 2_000
    const b = hub.requestAdmission({ agents: [{ id: 'b', capabilities: [] }] })
    t = 3_000
    const c = hub.requestAdmission({ agents: [{ id: 'c', capabilities: [] }] })

    expect(hub.pendingApplications().map((p) => p.agents[0]!.id)).toEqual([
      'a',
      'b',
      'c',
    ])

    hub.rejectApplication(a.applicationId, 'shutdown')
    hub.rejectApplication(b.applicationId, 'shutdown')
    hub.rejectApplication(c.applicationId, 'shutdown')
    await Promise.all([a.decision, b.decision, c.decision])
    await hub.stop()
  })

  it('evaluate appends an evaluation entry with rating + comment', async () => {
    const hub = new Hub()
    await hub.start()
    const ev = hub.evaluate({
      taskId: 't-123',
      by: 'admin',
      rating: 4,
      comment: 'mostly good',
    })
    expect(ev.taskId).toBe('t-123')
    const last = hub.transcript.all().at(-1)
    expect(last?.kind).toBe('evaluation')
    if (last?.kind === 'evaluation') {
      expect(last.data.rating).toBe(4)
      expect(last.data.comment).toBe('mostly good')
      expect(last.data.by).toBe('admin')
    }
    await hub.stop()
  })

  it('onEvent observers see agent_pending → agent_approved in order', async () => {
    const hub = new Hub()
    await hub.start()
    const kinds: string[] = []
    hub.onEvent((e) => kinds.push(e.kind))

    const { applicationId, decision } = hub.requestAdmission({
      agents: [{ id: 'x', capabilities: [] }],
    })
    await flush()
    hub.approveApplication(applicationId)
    await decision

    expect(kinds).toEqual(['agent_pending', 'agent_approved'])
    await hub.stop()
  })
})
