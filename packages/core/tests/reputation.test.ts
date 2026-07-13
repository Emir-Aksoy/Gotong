/**
 * Peer reputation — M5b of the hub-mesh implementation.
 *
 * Two layers of test:
 *
 *   1. ReputationStore in isolation — EWMA math, rebuild, persistence
 *   2. Integration: hub.feedback writes → hub.reputation updates →
 *      hub.dispatch capability routing prefers high-reputation peers
 *
 * The critical promise of M5b is the loop: a peer that gets bad
 * ratings drops in priority for future dispatches, automatically and
 * locally (no central authority involved).
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import {
  FeedbackLedger,
  MemoryFeedbackStorage,
  ReputationStore,
  type FeedbackEntryDraft,
} from '../src/feedback/index.js'
import { AgentParticipant } from '../src/participants/agent.js'
import { createInprocHubLinkPair } from '../src/hub-link.js'
import { installPeerLink } from '../src/peer-link-install.js'
import type { Task } from '../src/types.js'

function draft(o: Partial<FeedbackEntryDraft> = {}): FeedbackEntryDraft {
  return {
    toHub: 'hubB',
    toParticipant: 'b-writer',
    taskRunId: 'run-1',
    scope: 'whole-task',
    rating: 4,
    evaluatorHub: 'hubA',
    evaluatorParticipant: 'admin',
    ...o,
  }
}

class EchoAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { echoedFrom: this.id, payload: task.payload }
  }
}

describe('ReputationStore — math', () => {
  it('unknown peer scores 0 (neutral, no penalty)', () => {
    const r = new ReputationStore()
    expect(r.scoreOf('hubX')).toBe(0)
  })

  it('rating 3 (normalized 0) does NOT move the score', () => {
    const r = new ReputationStore({ alpha: 0.7 })
    r.recordEntry('hubB', 3)
    // alpha*0 + 0.3*0 = 0
    expect(r.scoreOf('hubB')).toBeCloseTo(0, 5)
  })

  it('rating 5 lifts score; rating 1 drops it', () => {
    const r = new ReputationStore({ alpha: 0.7 })
    r.recordEntry('hubB', 5)
    // alpha*0 + 0.3 * 1 = 0.3
    expect(r.scoreOf('hubB')).toBeCloseTo(0.3, 5)

    r.recordEntry('hubC', 1)
    // alpha*0 + 0.3 * (-1) = -0.3
    expect(r.scoreOf('hubC')).toBeCloseTo(-0.3, 5)
  })

  it('successive 5-star ratings converge toward 1 (asymptote)', () => {
    const r = new ReputationStore({ alpha: 0.7 })
    for (let i = 0; i < 50; i++) r.recordEntry('hubB', 5)
    const s = r.scoreOf('hubB')
    expect(s).toBeGreaterThan(0.95)
    expect(s).toBeLessThanOrEqual(1)
  })

  it('sampleCount increments per recordEntry', () => {
    const r = new ReputationStore()
    r.recordEntry('hubB', 5)
    r.recordEntry('hubB', 4)
    r.recordEntry('hubB', 3)
    expect(r.get('hubB')?.sampleCount).toBe(3)
  })

  it('rebuild replays an entry list (chronological order matters)', () => {
    const r = new ReputationStore({ alpha: 0.7 })
    r.rebuild([
      {
        id: 'e1',
        toHub: 'hubB',
        toParticipant: 'b',
        taskRunId: 'run-1',
        scope: 'whole-task',
        rating: 5,
        evaluatorHub: 'hubA',
        evaluatorParticipant: 'admin',
        createdAt: 100,
      },
      {
        id: 'e2',
        toHub: 'hubB',
        toParticipant: 'b',
        taskRunId: 'run-2',
        scope: 'whole-task',
        rating: 5,
        evaluatorHub: 'hubA',
        evaluatorParticipant: 'admin',
        createdAt: 200,
      },
    ])
    // 1 entry: 0.3; 2 entries: 0.7*0.3 + 0.3*1 = 0.21 + 0.3 = 0.51
    expect(r.scoreOf('hubB')).toBeCloseTo(0.51, 4)
  })

  it('rebuild SKIPS rejected entries (Q4 decision)', () => {
    const r = new ReputationStore({ alpha: 0.7 })
    r.rebuild([
      {
        id: 'e1',
        toHub: 'hubB',
        toParticipant: 'b',
        taskRunId: 'run-1',
        scope: 'whole-task',
        rating: 5,
        evaluatorHub: 'hubA',
        evaluatorParticipant: 'admin',
        createdAt: 100,
        rejectedAt: 150, // peer rejected this
      },
      {
        id: 'e2',
        toHub: 'hubB',
        toParticipant: 'b',
        taskRunId: 'run-2',
        scope: 'whole-task',
        rating: 5,
        evaluatorHub: 'hubA',
        evaluatorParticipant: 'admin',
        createdAt: 200,
      },
    ])
    // Only e2 counts: 0.3
    expect(r.scoreOf('hubB')).toBeCloseTo(0.3, 4)
    expect(r.get('hubB')?.sampleCount).toBe(1)
  })

  it('recordRejection re-derives from the supplied entries minus rejected ones', () => {
    const r = new ReputationStore({ alpha: 0.7 })
    const e1 = {
      id: 'e1',
      toHub: 'hubB',
      toParticipant: 'b',
      taskRunId: 'r1',
      scope: 'whole-task' as const,
      rating: 5,
      evaluatorHub: 'hubA',
      evaluatorParticipant: 'admin',
      createdAt: 100,
    }
    const e2 = {
      id: 'e2',
      toHub: 'hubB',
      toParticipant: 'b',
      taskRunId: 'r2',
      scope: 'whole-task' as const,
      rating: 5,
      evaluatorHub: 'hubA',
      evaluatorParticipant: 'admin',
      createdAt: 200,
    }

    r.rebuild([e1, e2])
    expect(r.scoreOf('hubB')).toBeCloseTo(0.51, 4) // both count

    // Now e1 gets rejected (e.g. peer pushed a reject receipt)
    const e1Rejected = { ...e1, rejectedAt: 250 }
    r.recordRejection('hubB', [e1Rejected, e2])
    // Only e2 counts now: 0.3
    expect(r.scoreOf('hubB')).toBeCloseTo(0.3, 4)
    expect(r.get('hubB')?.sampleCount).toBe(1)
  })
})

describe('ReputationStore — persistence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-reputation-test-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* swallow */
    }
  })

  it('writes one json per peer; re-opening sees the same scores', () => {
    const r1 = new ReputationStore({ dir })
    r1.recordEntry('hubB', 5)
    r1.recordEntry('hubC', 1)

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBe(2)

    const r2 = new ReputationStore({ dir })
    expect(r2.scoreOf('hubB')).toBeCloseTo(0.3, 4)
    expect(r2.scoreOf('hubC')).toBeCloseTo(-0.3, 4)
  })

  it('special chars in peer id are sanitised in file names', () => {
    const r = new ReputationStore({ dir })
    r.recordEntry('hub:weird/name', 5)
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBe(1)
    expect(files[0]).not.toMatch(/[/:]/)
  })
})

describe('Hub integration: ledger writes → reputation updates', () => {
  it('hub.feedback.appendEntry immediately updates hub.reputation', () => {
    const hub = Hub.inMemory()
    expect(hub.reputation.scoreOf('hubB')).toBe(0)

    hub.feedback.appendEntry(draft({ toHub: 'hubB', rating: 5 }))
    expect(hub.reputation.scoreOf('hubB')).toBeCloseTo(0.3, 4)

    hub.feedback.appendEntry(draft({ toHub: 'hubB', rating: 5 }))
    expect(hub.reputation.scoreOf('hubB')).toBeCloseTo(0.51, 4)
  })

  it('markRejected triggers full re-derive for that peer', () => {
    const hub = Hub.inMemory()
    const e1 = hub.feedback.appendEntry(draft({ toHub: 'hubB', rating: 5 }))
    const e2 = hub.feedback.appendEntry(draft({ toHub: 'hubB', rating: 5 }))
    expect(hub.reputation.scoreOf('hubB')).toBeCloseTo(0.51, 4)

    hub.feedback.markRejected(e1.id, 'evaluator id unknown')
    // Only e2 counts now
    expect(hub.reputation.scoreOf('hubB')).toBeCloseTo(0.3, 4)

    // Sanity: e2 unaffected
    expect(hub.feedback.get(e2.id)?.rejectedAt).toBeUndefined()
  })
})

describe('Hub integration: scheduler picks higher-reputation peer', () => {
  it('two peers both have cap X — capability dispatch picks the higher reputation one', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    const hubC = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start(), hubC.start()])

    // B and C both have agents with cap 'draft'
    hubB.register(new EchoAgent('b-writer', ['draft']))
    hubC.register(new EchoAgent('c-writer', ['draft']))

    // A is linked to both
    const ab = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    const ac = createInprocHubLinkPair({ aPeerId: 'hubC', bPeerId: 'hubA' })
    installPeerLink({ hub: hubA, link: ab.a, remoteCapabilities: ['draft'], outboundCaps: ['draft'] })
    installPeerLink({ hub: hubB, link: ab.b })
    installPeerLink({ hub: hubA, link: ac.a, remoteCapabilities: ['draft'], outboundCaps: ['draft'] })
    installPeerLink({ hub: hubC, link: ac.b })

    // Seed reputation: hubC scores high, hubB scores low.
    for (let i = 0; i < 5; i++) {
      hubA.feedback.appendEntry(draft({ toHub: 'hubC', rating: 5 }))
      hubA.feedback.appendEntry(draft({ toHub: 'hubB', rating: 1 }))
    }
    expect(hubA.reputation.scoreOf('hubC')).toBeGreaterThan(0.5)
    expect(hubA.reputation.scoreOf('hubB')).toBeLessThan(-0.5)

    // Dispatch capability 'draft' — should land on hubC (higher rep)
    const result = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: {},
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      // The wrapper id is the peer hub id
      expect(result.by).toBe('hubC')
      expect(result.output).toMatchObject({ echoedFrom: 'c-writer' })
    }

    await hubA.stop()
    await hubB.stop()
    await hubC.stop()
  })

  it('without reputation seeding (both at 0), falls back to least-loaded tie-break', async () => {
    // Sanity: M5b does not break the pre-existing least-load behaviour
    // when reputation is neutral.
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    const hubC = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start(), hubC.start()])

    hubB.register(new EchoAgent('b-writer', ['draft']))
    hubC.register(new EchoAgent('c-writer', ['draft']))

    const ab = createInprocHubLinkPair({ aPeerId: 'hubB', bPeerId: 'hubA' })
    const ac = createInprocHubLinkPair({ aPeerId: 'hubC', bPeerId: 'hubA' })
    installPeerLink({ hub: hubA, link: ab.a, remoteCapabilities: ['draft'], outboundCaps: ['draft'] })
    installPeerLink({ hub: hubB, link: ab.b })
    installPeerLink({ hub: hubA, link: ac.a, remoteCapabilities: ['draft'], outboundCaps: ['draft'] })
    installPeerLink({ hub: hubC, link: ac.b })

    expect(hubA.reputation.scoreOf('hubB')).toBe(0)
    expect(hubA.reputation.scoreOf('hubC')).toBe(0)

    const result = await hubA.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: {},
    })
    expect(result.kind).toBe('ok')
    // Either peer is acceptable; we just need it to succeed.

    await hubA.stop()
    await hubB.stop()
    await hubC.stop()
  })
})

describe('FeedbackLedger hooks fire even without Hub', () => {
  it('setHooks gets called on append + markRejected', () => {
    const ledger = new FeedbackLedger(new MemoryFeedbackStorage())
    const appended: string[] = []
    const rejected: string[] = []
    ledger.setHooks({
      onAppend: (e) => appended.push(e.id),
      onRejected: (e) => rejected.push(e.id),
    })
    const e = ledger.appendEntry(draft({ rating: 5 }))
    ledger.markRejected(e.id, 'nope')
    expect(appended).toEqual([e.id])
    expect(rejected).toEqual([e.id])

    // Sanity: persistence file present in memory mode (it's not, by
    // design — just make sure rejectedAt got written and is visible)
    expect(ledger.get(e.id)?.rejectedAt).toBeGreaterThan(0)
  })
})
