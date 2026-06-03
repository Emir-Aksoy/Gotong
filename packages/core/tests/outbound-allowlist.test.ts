/**
 * outbound-allowlist.test.ts — Phase 19 P4-M1.
 *
 * The OUTBOUND capability allowlist is the sending-edge mirror of the inbound
 * `PeerLinkAcl.capabilities` gate. Phase 18 persisted `outboundCaps` per peer
 * but enforced nothing — a peer row could carry an allowlist and every
 * capability still left the hub. This closes that gap: `RemoteHubViaLink`
 * refuses any task whose required capabilities aren't all in the allowlist,
 * BEFORE the task touches the wire.
 *
 * Two layers:
 *   1. `checkOutboundCapabilities` — the pure verdict (shared with inbound
 *      `evaluateAcl` via `extractRequiredCapabilities`, so the two gates can't
 *      drift on what "the task's required capabilities" means).
 *   2. A real inproc mesh edge (`installPeerLink({ outboundCaps })`) proving a
 *      denied capability returns `failed` and the REMOTE agent is never run.
 */

import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { createInprocHubLinkPair } from '../src/hub-link.js'
import {
  checkOutboundCapabilities,
  checkOutboundDataClasses,
  disallowedDataClasses,
  type OutboundRedactor,
} from '../src/peer-acl.js'
import { installPeerLink } from '../src/peer-link-install.js'
import { AgentParticipant } from '../src/participants/agent.js'
import type { DispatchStrategy, Task } from '../src/types.js'

function makeTask(strategy: DispatchStrategy): Task {
  return {
    id: 't-1',
    from: 'system',
    strategy,
    payload: {},
    createdAt: 0,
  }
}

describe('checkOutboundCapabilities — pure verdict', () => {
  const cap = (caps: string[]): DispatchStrategy => ({ kind: 'capability', capabilities: caps })

  it('no allowlist (undefined / null) → accept anything (legacy)', () => {
    expect(checkOutboundCapabilities(makeTask(cap(['draft'])), undefined).ok).toBe(true)
    expect(checkOutboundCapabilities(makeTask(cap(['draft'])), null).ok).toBe(true)
  })

  it('required caps ⊆ allowlist → ok', () => {
    expect(checkOutboundCapabilities(makeTask(cap(['draft'])), ['draft', 'review']).ok).toBe(true)
    // multiple required, all present
    expect(checkOutboundCapabilities(makeTask(cap(['draft', 'review'])), ['draft', 'review']).ok).toBe(
      true,
    )
  })

  it('a required cap outside the allowlist → denied, reason names the cap', () => {
    const v = checkOutboundCapabilities(makeTask(cap(['review'])), ['draft'])
    expect(v).toEqual({ ok: false, reason: 'review' })
  })

  it('empty allowlist [] → deny everything (explicit lockdown)', () => {
    expect(checkOutboundCapabilities(makeTask(cap(['draft'])), [])).toEqual({
      ok: false,
      reason: 'draft',
    })
  })

  it('explicit strategy is un-allowlistable when an allowlist is set', () => {
    const v = checkOutboundCapabilities(makeTask({ kind: 'explicit', to: 'b-writer' }), ['draft'])
    expect(v).toEqual({ ok: false, reason: 'strategy_not_allowlisted' })
  })

  it('unfiltered broadcast is un-allowlistable; a filtered subset passes', () => {
    expect(checkOutboundCapabilities(makeTask({ kind: 'broadcast' }), ['draft'])).toEqual({
      ok: false,
      reason: 'strategy_not_allowlisted',
    })
    expect(
      checkOutboundCapabilities(makeTask({ kind: 'broadcast', capabilities: ['draft'] }), ['draft'])
        .ok,
    ).toBe(true)
  })
})

class CountingEcho extends AgentParticipant {
  invocations = 0
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.invocations++
    return { echoedFrom: this.id, payload: task.payload }
  }
}

/** Like `CountingEcho` but keeps the LAST task it saw, so a redaction test can
 *  assert exactly what crossed the wire (reduced payload + pruned classes). */
class RecordingEcho extends AgentParticipant {
  invocations = 0
  lastTask?: Task
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.invocations++
    this.lastTask = task
    return { echoedFrom: this.id, payload: task.payload }
  }
}

describe('installPeerLink — outbound allowlist enforcement (mesh edge)', () => {
  it('allowlisted cap reaches the peer; non-allowlisted is refused before the wire', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new CountingEcho('b-agent', ['draft', 'review'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // The wrapper ADVERTISES both caps (so the scheduler routes both to it),
    // but our outbound allowlist only permits 'draft'.
    installPeerLink({
      hub: hubA,
      link: linkAtoB,
      remoteCapabilities: ['draft', 'review'],
      outboundCaps: ['draft'],
    })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    // 'draft' is allowlisted → crosses the edge, runs on hubB.
    const okRes = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { topic: 'allowed' },
    })
    expect(okRes.kind).toBe('ok')
    if (okRes.kind === 'ok') expect(okRes.output).toMatchObject({ echoedFrom: 'b-agent' })
    expect(bAgent.invocations).toBe(1)

    // 'review' is NOT allowlisted → refused locally, remote never invoked.
    const denied = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['review'] },
      payload: { topic: 'blocked' },
    })
    expect(denied.kind).toBe('failed')
    if (denied.kind === 'failed') expect(denied.error).toContain('outbound_capability_denied:review')
    // The whole point: nothing crossed the wire.
    expect(bAgent.invocations).toBe(1)

    await hubA.stop()
    await hubB.stop()
  })

  it('no allowlist configured → legacy accept-all (the cap that was blocked above now passes)', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new CountingEcho('b-agent', ['review'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // outboundCaps omitted → no allowlist → send anything.
    installPeerLink({ hub: hubA, link: linkAtoB, remoteCapabilities: ['review'] })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const res = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['review'] },
      payload: { topic: 'legacy' },
    })
    expect(res.kind).toBe('ok')
    expect(bAgent.invocations).toBe(1)

    await hubA.stop()
    await hubB.stop()
  })
})

describe('checkOutboundDataClasses — pure verdict (Phase 19 P4-M4)', () => {
  const withClasses = (classes?: string[]): Task => ({
    ...makeTask({ kind: 'capability', capabilities: ['draft'] }),
    ...(classes ? { dataClasses: classes } : {}),
  })

  it('no contract (undefined / null) → send anything', () => {
    expect(checkOutboundDataClasses(withClasses(['pii']), undefined).ok).toBe(true)
    expect(checkOutboundDataClasses(withClasses(['pii']), null).ok).toBe(true)
  })

  it('task declares no classes → nothing to restrict → ok', () => {
    expect(checkOutboundDataClasses(withClasses(), ['public']).ok).toBe(true)
    expect(checkOutboundDataClasses(withClasses([]), ['public']).ok).toBe(true)
  })

  it('declared classes ⊆ allowlist → ok', () => {
    expect(checkOutboundDataClasses(withClasses(['public']), ['public', 'internal']).ok).toBe(true)
  })

  it('a declared class outside the allowlist → denied, reason names the class', () => {
    expect(checkOutboundDataClasses(withClasses(['pii']), ['public'])).toEqual({
      ok: false,
      reason: 'pii',
    })
  })
})

describe('disallowedDataClasses — pure helper (Phase 19 P1-M10)', () => {
  const withClasses = (classes?: string[]): Task => ({
    ...makeTask({ kind: 'capability', capabilities: ['draft'] }),
    ...(classes ? { dataClasses: classes } : {}),
  })

  it('no contract (undefined / null) → nothing to strip', () => {
    expect(disallowedDataClasses(withClasses(['pii']), undefined)).toEqual([])
    expect(disallowedDataClasses(withClasses(['pii']), null)).toEqual([])
  })

  it('task declares no classes → []', () => {
    expect(disallowedDataClasses(withClasses(), ['public'])).toEqual([])
    expect(disallowedDataClasses(withClasses([]), ['public'])).toEqual([])
  })

  it('all declared classes allowed → []', () => {
    expect(disallowedDataClasses(withClasses(['public']), ['public', 'internal'])).toEqual([])
  })

  it('returns the FULL disallowed subset, not just the first offender', () => {
    // `checkOutboundDataClasses` names only 'pii' (the first); a redactor needs
    // the whole set to know everything it must strip.
    expect(disallowedDataClasses(withClasses(['public', 'pii', 'secret']), ['public'])).toEqual([
      'pii',
      'secret',
    ])
  })
})

describe('installPeerLink — outbound data-class enforcement (mesh edge)', () => {
  it('a task carrying a disallowed data class never leaves to the peer', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new CountingEcho('b-agent', ['draft'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // The peer is cleared for 'public' data only.
    installPeerLink({
      hub: hubA,
      link: linkAtoB,
      remoteCapabilities: ['draft'],
      allowedDataClasses: ['public'],
    })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    // A 'public' task is fine.
    const okRes = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { topic: 'ok' },
      dataClasses: ['public'],
    })
    expect(okRes.kind).toBe('ok')
    expect(bAgent.invocations).toBe(1)

    // A 'pii' task is refused before the wire.
    const denied = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { ssn: '...' },
      dataClasses: ['pii'],
    })
    expect(denied.kind).toBe('failed')
    if (denied.kind === 'failed') expect(denied.error).toContain('outbound_data_class_denied:pii')
    expect(bAgent.invocations).toBe(1) // remote never saw the pii task

    await hubA.stop()
    await hubB.stop()
  })
})

describe('installPeerLink — outbound data-class redaction (Phase 19 P1-M10)', () => {
  it('a redactor strips the disallowed field; a compliant reduced task crosses', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new RecordingEcho('b-agent', ['draft'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // Peer cleared for 'public' only. The redactor drops the pii field and lets
    // the public part through; it omits `dataClasses`, so core prunes the
    // original declaration to the allowed subset (['public']).
    const redactor: OutboundRedactor = (task, ctx) => {
      // The hook is handed exactly what it needs to decide what to strip.
      expect(ctx.allowed).toEqual(['public'])
      expect(ctx.disallowed).toEqual(['pii'])
      const p = task.payload as { note?: string; ssn?: string }
      return { payload: { note: p.note } }
    }
    installPeerLink({
      hub: hubA,
      link: linkAtoB,
      remoteCapabilities: ['draft'],
      allowedDataClasses: ['public'],
      redactor,
    })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const res = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { note: 'hello', ssn: '123-45-6789' },
      dataClasses: ['public', 'pii'],
    })
    expect(res.kind).toBe('ok')
    // The REDUCED task is what reached the peer: ssn gone, classes pruned.
    expect(bAgent.invocations).toBe(1)
    expect(bAgent.lastTask?.payload).toEqual({ note: 'hello' })
    expect(bAgent.lastTask?.dataClasses).toEqual(['public'])

    await hubA.stop()
    await hubB.stop()
  })

  it('a redactor that declines (returns null) → refuse; remote untouched', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new RecordingEcho('b-agent', ['draft'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({
      hub: hubA,
      link: linkAtoB,
      remoteCapabilities: ['draft'],
      allowedDataClasses: ['public'],
      redactor: () => null,
    })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const denied = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { ssn: '...' },
      dataClasses: ['pii'],
    })
    expect(denied.kind).toBe('failed')
    if (denied.kind === 'failed') expect(denied.error).toContain('outbound_data_class_denied:pii')
    expect(bAgent.invocations).toBe(0)

    await hubA.stop()
    await hubB.stop()
  })

  it('fail-closed: a redactor whose result STILL carries a disallowed class never leaks', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new RecordingEcho('b-agent', ['draft'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // Buggy / malicious redactor: rewrites the payload but RE-DECLARES the pii
    // class. Core's mandatory re-check rejects it, so nothing crosses.
    installPeerLink({
      hub: hubA,
      link: linkAtoB,
      remoteCapabilities: ['draft'],
      allowedDataClasses: ['public'],
      redactor: () => ({ payload: { looks: 'clean' }, dataClasses: ['pii'] }),
    })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const denied = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { ssn: '...' },
      dataClasses: ['pii'],
    })
    expect(denied.kind).toBe('failed')
    if (denied.kind === 'failed') expect(denied.error).toContain('outbound_data_class_denied')
    expect(bAgent.invocations).toBe(0)

    await hubA.stop()
    await hubB.stop()
  })

  it('a redactor that throws is treated as a decline (refuse, never leak)', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new RecordingEcho('b-agent', ['draft'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({
      hub: hubA,
      link: linkAtoB,
      remoteCapabilities: ['draft'],
      allowedDataClasses: ['public'],
      redactor: () => {
        throw new Error('boom')
      },
    })
    installPeerLink({ hub: hubB, link: linkBtoA, remoteCapabilities: [] })

    const denied = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { ssn: '...' },
      dataClasses: ['pii'],
    })
    expect(denied.kind).toBe('failed')
    if (denied.kind === 'failed') expect(denied.error).toContain('outbound_data_class_denied')
    expect(bAgent.invocations).toBe(0)

    await hubA.stop()
    await hubB.stop()
  })
})

describe('installPeerLink — inbound policy gate (Phase 19 P4-M4)', () => {
  it('a rejecting inboundGate refuses the inbound task fail-closed; agent never runs', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const bAgent = new CountingEcho('b-agent', ['draft'])
    hubB.register(bAgent)

    const { a: linkAtoB, b: linkBtoA } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubA, link: linkAtoB, remoteCapabilities: ['draft'] })
    // hubB gates inbound: the first task passes, the rest are over-quota.
    let seen = 0
    installPeerLink({
      hub: hubB,
      link: linkBtoA,
      remoteCapabilities: [],
      inboundGate: () => (seen++ < 1 ? { ok: true } : { ok: false, reason: 'quota_exceeded' }),
    })

    const first = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: {},
    })
    expect(first.kind).toBe('ok')
    expect(bAgent.invocations).toBe(1)

    const second = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: {},
    })
    expect(second.kind).toBe('failed')
    if (second.kind === 'failed') {
      expect(second.error).toContain('cross_org_policy_denied (quota_exceeded)')
    }
    expect(bAgent.invocations).toBe(1) // the gated task never reached the agent

    await hubA.stop()
    await hubB.stop()
  })
})
