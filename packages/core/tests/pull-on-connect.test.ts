/**
 * Pull-on-connect (M6) — feedback flows from evaluator to recipient
 * over a HubLink, lazily fetched when the recipient connects.
 *
 * Scenario flow:
 *
 *   1. hubA evaluates hubB's work        → A.outbound has 1 pending entry
 *   2. hubB connects to hubA via HubLink  → install fires a pullNow()
 *   3. hubB.inboundFeedback receives the entry; A.outbound marks delivered
 *   4. A subsequent pullNow() is idempotent (no duplicates)
 */

import { describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import { createInprocHubLinkPair } from '../src/hub-link.js'
import { installPeerLink } from '../src/peer-link-install.js'
import { statusOf, type FeedbackEntryDraft } from '../src/feedback/index.js'

const flush = () => new Promise<void>((r) => setImmediate(r))
// pullNow on install is async (fire-and-forget). Two `flush`es give it
// time to push through Promise microtasks before assertions look at
// state.
const drain = async () => {
  for (let i = 0; i < 5; i++) await flush()
}

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

describe('HubLink.selfId — symmetric peer identification', () => {
  it('inproc link pair exposes both peerId and selfId on each side', () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB', // A sees peer as B
      bPeerId: 'hubA', // B sees peer as A
    })
    expect(a.peerId).toBe('hubB')
    expect(a.selfId).toBe('hubA')
    expect(b.peerId).toBe('hubA')
    expect(b.selfId).toBe('hubB')
  })
})

describe('pullFeedbackFor — inproc', () => {
  it('returns empty when peer has no pull handler', async () => {
    const { a } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    const entries = await a.pullFeedbackFor()
    expect(entries).toEqual([])
  })

  it('returns entries the peer reports for selfId; peer marks them delivered', async () => {
    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })

    // B side has a ledger with one entry about A
    const hubB = Hub.inMemory()
    const entry = hubB.feedback.appendEntry(draft({ toHub: 'hubA' }))
    expect(statusOf(entry)).toBe('pending')

    // B installs its pull handler manually (mimics what installPeerLink does)
    b.on('pull', async (forPeerId) => {
      const list = hubB.feedback.query({ toHub: forPeerId, status: 'pending' })
      const now = Date.now()
      for (const e of list) hubB.feedback.markDelivered(e.id, now)
      return list
    })

    // A asks for entries about itself
    const pulled = await a.pullFeedbackFor()
    expect(pulled.length).toBe(1)
    expect(pulled[0].id).toBe(entry.id)

    // B's ledger now shows it as delivered
    expect(statusOf(hubB.feedback.get(entry.id)!)).toBe('delivered')
  })
})

describe('installPeerLink integrates pull-on-attach', () => {
  it('inbound entries land in hub.inboundFeedback on first pullNow', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    // B has 2 entries about A already in its outbound (e.g. evaluated A
    // last week while A was offline).
    const e1 = hubB.feedback.appendEntry(draft({ toHub: 'hubA', rating: 5, comment: 'great' }))
    const e2 = hubB.feedback.appendEntry(draft({ toHub: 'hubA', rating: 2, comment: 'slow' }))
    // And one for someone else — should NOT be pulled
    hubB.feedback.appendEntry(draft({ toHub: 'hubX', rating: 4 }))

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    // Install B FIRST so its pull handler is registered before A's
    // auto-pull fires. autoMarkRead: false because M6 test only cares
    // about pull → delivered; M7 covers read receipt behaviour.
    installPeerLink({ hub: hubB, link: b })
    const aInstalled = installPeerLink({
      hub: hubA,
      link: a,
      autoMarkRead: false,
    })

    // The install fired a pull automatically; wait for it to settle.
    await drain()
    // Belt-and-suspenders: also do an explicit pull in case install
    // ordering still raced.
    await aInstalled.pullNow()

    // A's inbound should now have e1 and e2 (not the 'hubX' one).
    const inbound = hubA.inboundFeedback.query()
    expect(inbound.length).toBe(2)
    const ids = inbound.map((e) => e.id).sort()
    expect(ids).toEqual([e1.id, e2.id].sort())

    // B's outbound entries for hubA are now marked delivered
    expect(statusOf(hubB.feedback.get(e1.id)!)).toBe('delivered')
    expect(statusOf(hubB.feedback.get(e2.id)!)).toBe('delivered')
    // hubX entry untouched
    const others = hubB.feedback.query({ toHub: 'hubX' })
    expect(statusOf(others[0])).toBe('pending')

    // A second pullNow should be idempotent (no new entries; B has no more pending)
    const newCount = await aInstalled.pullNow()
    expect(newCount).toBe(0)
    expect(hubA.inboundFeedback.query().length).toBe(2)

    await hubA.stop()
    await hubB.stop()
  })

  it('entries that arrive on B AFTER install are visible to A on next pullNow', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    const aInstalled = installPeerLink({ hub: hubA, link: a })
    installPeerLink({ hub: hubB, link: b })

    await drain()
    // Initial inbound is empty
    expect(hubA.inboundFeedback.query().length).toBe(0)

    // B evaluates A
    const newEntry = hubB.feedback.appendEntry(draft({ toHub: 'hubA', rating: 5 }))

    // A pulls again
    const got = await aInstalled.pullNow()
    expect(got).toBe(1)
    const inbound = hubA.inboundFeedback.query()
    expect(inbound.length).toBe(1)
    expect(inbound[0].id).toBe(newEntry.id)

    await hubA.stop()
    await hubB.stop()
  })

  it('preserves the original evaluator hub + participant in inbound copy', async () => {
    const hubA = Hub.inMemory()
    const hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    const e = hubB.feedback.appendEntry(
      draft({
        toHub: 'hubA',
        evaluatorHub: 'hubB',
        evaluatorParticipant: 'b-admin',
        rating: 5,
        comment: 'thanks!',
      }),
    )

    const { a, b } = createInprocHubLinkPair({
      aPeerId: 'hubB',
      bPeerId: 'hubA',
    })
    installPeerLink({ hub: hubB, link: b }) // B first → handler registered
    const aInstalled = installPeerLink({ hub: hubA, link: a })
    await drain()
    await aInstalled.pullNow()

    const fromAInbox = hubA.inboundFeedback.get(e.id)
    expect(fromAInbox).toBeDefined()
    expect(fromAInbox?.evaluatorHub).toBe('hubB')
    expect(fromAInbox?.evaluatorParticipant).toBe('b-admin')
    expect(fromAInbox?.rating).toBe(5)
    expect(fromAInbox?.comment).toBe('thanks!')

    await hubA.stop()
    await hubB.stop()
  })

  it('Hub.inboundFeedback persists across hub instances when bound to a Space', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Space } = await import('../src/space.js')

    const dir = mkdtempSync(join(tmpdir(), 'gotong-m6-test-'))
    try {
      const { space } = await Space.openOrInit(dir, { name: 'm6-test' })
      const hub = new Hub({ space })

      // Inject directly (simulating a pull that already happened)
      hub.inboundFeedback.appendEntry(
        draft({ toHub: 'self', evaluatorHub: 'hubB', comment: 'persisted' }),
      )

      const hub2 = new Hub({ space })
      const fetched = hub2.inboundFeedback.query()
      expect(fetched.length).toBe(1)
      expect(fetched[0].comment).toBe('persisted')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
