/**
 * Read receipt / rejected (M7) — closing the feedback loop.
 *
 * Scenarios:
 *
 *   1. autoMarkRead (default): pullNow → fresh inbound entries auto-acknowledged
 *      → peer's outbound advances to 'read'.
 *
 *   2. Explicit markRead: caller controls the moment a read receipt
 *      fires (e.g. UI button).
 *
 *   3. Reject (Q4): inbound entries the recipient refuses → peer's
 *      outbound marked rejected + REPUTATION rolls back the
 *      contribution from rejected entries.
 *
 *   4. Receipts after close are silently dropped.
 */

import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { createInprocHubLinkPair } from '../src/hub-link.js'
import { installPeerLink } from '../src/peer-link-install.js'
import { statusOf, type FeedbackEntryDraft } from '../src/feedback/index.js'

const flush = () => new Promise<void>((r) => setImmediate(r))
const drain = async () => {
  for (let i = 0; i < 5; i++) await flush()
}

function draft(o: Partial<FeedbackEntryDraft> = {}): FeedbackEntryDraft {
  return {
    toHub: 'hubA',
    toParticipant: 'a-something',
    taskRunId: 'run-1',
    scope: 'whole-task',
    rating: 4,
    evaluatorHub: 'hubB',
    evaluatorParticipant: 'b-admin',
    ...o,
  }
}

describe('pushReadReceipt — inproc plumbing', () => {
  it('peer receipt handler fires with the supplied params', async () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    const seen: Array<{ ids: readonly string[]; kind: string; reason?: string }> = []
    b.on('receipt', (params) => {
      seen.push({ ids: params.entryIds, kind: params.kind, reason: params.reason })
    })

    await a.pushReadReceipt({ entryIds: ['e1', 'e2'], kind: 'read' })
    await a.pushReadReceipt({
      entryIds: ['e3'],
      kind: 'rejected',
      reason: 'evaluator unknown',
    })

    expect(seen.length).toBe(2)
    expect(seen[0]).toEqual({ ids: ['e1', 'e2'], kind: 'read', reason: undefined })
    expect(seen[1]).toEqual({
      ids: ['e3'],
      kind: 'rejected',
      reason: 'evaluator unknown',
    })
  })

  it('receipt after close is silently dropped', async () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    const seen: unknown[] = []
    b.on('receipt', (p) => seen.push(p))
    await a.close()
    await a.pushReadReceipt({ entryIds: ['e1'], kind: 'read' })
    expect(seen.length).toBe(0)
  })

  it("registering 'receipt' handler twice throws", () => {
    const { b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    b.on('receipt', () => {})
    expect(() => b.on('receipt', () => {})).toThrow(/already registered/)
  })
})

describe('autoMarkRead — pullNow auto-acks fresh entries', () => {
  it('after pullNow, peer outbound entries advance to read', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const e = hubB.feedback.appendEntry(
      draft({ toHub: 'hubA', evaluatorHub: 'hubB', rating: 5 }),
    )

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubB, link: b })
    const aInstalled = installPeerLink({ hub: hubA, link: a })
    await drain()
    await aInstalled.pullNow()
    await drain()

    // B's outbound entry should now be read (auto-marked)
    expect(statusOf(hubB.feedback.get(e.id)!)).toBe('read')
    // A's inbound entry should also show read locally
    expect(statusOf(hubA.inboundFeedback.get(e.id)!)).toBe('read')

    await hubA.stop()
    await hubB.stop()
  })

  it('autoMarkRead: false leaves inbound delivered, not read', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const e = hubB.feedback.appendEntry(draft({ toHub: 'hubA', rating: 5 }))

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubB, link: b })
    const aInstalled = installPeerLink({
      hub: hubA,
      link: a,
      autoMarkRead: false,
    })
    await drain()
    await aInstalled.pullNow()
    await drain()

    // B's outbound shows delivered (because pull marked it delivered)
    // but NOT read.
    expect(statusOf(hubB.feedback.get(e.id)!)).toBe('delivered')
    // A's inbound also stays delivered (or pending if no other status)
    expect(hubA.inboundFeedback.get(e.id)?.readAt).toBeUndefined()

    // Caller can then explicitly markRead
    await aInstalled.markRead([e.id])
    await drain()
    expect(statusOf(hubB.feedback.get(e.id)!)).toBe('read')
    expect(statusOf(hubA.inboundFeedback.get(e.id)!)).toBe('read')

    await hubA.stop()
    await hubB.stop()
  })
})

describe('rejectFeedback — Q4 decision', () => {
  it('reject inbound entry: peer outbound flips rejected + reputation rolls back', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    // hubB has rated hubA 5 stars twice — these contribute to B's
    // reputation for hubA on B's side.
    const e1 = hubB.feedback.appendEntry(
      draft({ toHub: 'hubA', evaluatorHub: 'hubB', rating: 5 }),
    )
    const e2 = hubB.feedback.appendEntry(
      draft({ toHub: 'hubA', evaluatorHub: 'hubB', rating: 5 }),
    )
    // Sanity: B sees hubA at 0.51
    expect(hubB.reputation.scoreOf('hubA')).toBeCloseTo(0.51, 4)

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubB, link: b })
    const aInstalled = installPeerLink({
      hub: hubA,
      link: a,
      autoMarkRead: false, // we'll reject instead
    })
    await drain()
    await aInstalled.pullNow()
    await drain()

    // Both e1 and e2 are in A's inbound
    expect(hubA.inboundFeedback.query().length).toBe(2)

    // A rejects e1 (says "not fair")
    await aInstalled.rejectFeedback([e1.id], 'one-star unfair')
    await drain()

    // B's outbound: e1 is rejected, e2 still delivered
    expect(statusOf(hubB.feedback.get(e1.id)!)).toBe('rejected')
    expect(hubB.feedback.get(e1.id)?.rejectionReason).toBe('one-star unfair')
    expect(statusOf(hubB.feedback.get(e2.id)!)).toBe('delivered')

    // B's reputation for hubA recalculates — only e2 counts → 0.3
    expect(hubB.reputation.scoreOf('hubA')).toBeCloseTo(0.3, 4)

    // A's inbound for e1 is locally rejected
    expect(statusOf(hubA.inboundFeedback.get(e1.id)!)).toBe('rejected')

    await hubA.stop()
    await hubB.stop()
  })
})
