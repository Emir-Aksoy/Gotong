/**
 * Hub-mesh end-to-end (M9).
 *
 * Spins up THREE real Hub instances + THREE real WebSocket servers in
 * the same process and threads them together via `installPeerLink`.
 * Tests the design doc's §4 scenarios as one cohesive integration:
 *
 *   §4.1  Personal hub + team hub: A links to B; A dispatches a
 *         capability owned by B's worker → routed over ws, result
 *         flows back, A evaluates B → B's outbound shows the entry.
 *
 *   §4.2  Three-hub triangle (no parent/child): A links to BOTH B
 *         and C; only C has cap X. Dispatch lands on C (not B).
 *
 *   §4.3  Offline / online + read receipt + reputation:
 *         - B evaluates A while A is offline (ledger pending).
 *         - A comes online → pullNow grabs the entry into inbound.
 *         - autoMarkRead pushes 'read' receipt → B sees status=read.
 *         - B's reputation for A is shaped by these evaluations
 *           and routes A appropriately on the next dispatch.
 *
 * Wire layer is the REAL WebSocket transport (one ws server per hub),
 * not inproc — this verifies the full M3 frame flow under load.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import {
  AgentParticipant,
  Hub,
  installPeerLink,
  statusOf,
  type FeedbackEntryDraft,
  type HubLink,
  type Task,
} from '@aipehub/core'

import { acceptHubLinks, connectHubLink } from '../src/hub-link.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const drain = async () => {
  for (let i = 0; i < 10; i++) await delay(5)
}

// ─── helpers ────────────────────────────────────────────────────────────

class EchoAgent extends AgentParticipant {
  constructor(id: string, capabilities: readonly string[]) {
    super({ id, capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { handledBy: this.id, payload: task.payload }
  }
}

interface PeerNode {
  selfId: string
  hub: Hub
  wss: WebSocketServer
  url: string
  /** Links accepted on this hub's ws server. */
  inboundLinks: HubLink[]
  /** Links opened by this hub (we initiated). */
  outboundLinks: HubLink[]
  stop: () => Promise<void>
}

async function startNode(selfId: string): Promise<PeerNode> {
  const hub = Hub.inMemory()
  await hub.start()

  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const addr = wss.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `ws://127.0.0.1:${port}`

  const inboundLinks: HubLink[] = []
  acceptHubLinks({
    server: wss,
    selfId,
    onLink: (link) => inboundLinks.push(link),
  })

  return {
    selfId,
    hub,
    wss,
    url,
    inboundLinks,
    outboundLinks: [],
    stop: async () => {
      for (const link of inboundLinks) await link.close().catch(() => {})
      for (const c of wss.clients) {
        try {
          c.terminate()
        } catch {
          /* swallow */
        }
      }
      await new Promise<void>((r) => wss.close(() => r()))
      await hub.stop()
    },
  }
}

/**
 * Open a link from `from` → `to` (from is client, to is server).
 * Returns the LOCAL HubLink at `from`'s side. Caller is responsible
 * for installing it into `from.hub` via `installPeerLink`.
 */
async function dial(from: PeerNode, to: PeerNode): Promise<HubLink> {
  const link = await connectHubLink({
    url: to.url,
    selfId: from.selfId,
    expectedPeerId: to.selfId,
  })
  from.outboundLinks.push(link)
  // Wait for the peer side to accept + handshake; small loop because
  // onLink fires after Promise.resolve in acceptHubLinks.
  for (let i = 0; i < 20 && to.inboundLinks.length === 0; i++) await delay(10)
  return link
}

function draft(o: Partial<FeedbackEntryDraft> = {}): FeedbackEntryDraft {
  return {
    toHub: 'hubA',
    toParticipant: 'unknown',
    taskRunId: 'r-' + Math.random().toString(36).slice(2, 7),
    scope: 'whole-task',
    rating: 4,
    evaluatorHub: 'hubB',
    evaluatorParticipant: 'b-admin',
    ...o,
  }
}

// ─── §4.1 personal + team ─────────────────────────────────────────────

describe('Mesh E2E §4.1 — personal hub joins team hub', () => {
  let A: PeerNode
  let B: PeerNode
  beforeEach(async () => {
    A = await startNode('hubA')
    B = await startNode('hubB')
  })
  afterEach(async () => {
    await A.stop()
    await B.stop()
  })

  it('A dispatches a capability owned by B and gets the right result back', async () => {
    B.hub.register(new EchoAgent('b-writer', ['long-form-research']))

    const linkAtoB = await dial(A, B)
    const linkBtoA = B.inboundLinks[0]!

    installPeerLink({ hub: B.hub, link: linkBtoA })
    const aInstalled = installPeerLink({
      hub: A.hub,
      link: linkAtoB,
      remoteCapabilities: ['long-form-research'],
      autoMarkRead: false,
    })

    await drain()

    const result = await A.hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['long-form-research'] },
      payload: { question: 'mesh' },
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('hubB') // wrapper id from A's perspective
      expect(result.output).toMatchObject({ handledBy: 'b-writer' })
    }

    // A evaluates B for that work
    A.hub.feedback.appendEntry(
      draft({
        toHub: 'hubB',
        toParticipant: 'b-writer',
        evaluatorHub: 'hubA',
        evaluatorParticipant: 'a-admin',
        rating: 5,
        comment: 'fast and accurate',
      }),
    )

    // Now B should be able to pull that evaluation
    const pulled = await aInstalled.pullNow()
    // pullNow on A side pulls "entries B wrote about A" — that's 0 here.
    // But B pulling pulls "entries A wrote about B" → 1.
    expect(pulled).toBe(0)

    await B.inboundLinks[0]!.pullFeedbackFor() // doesn't go through installPeerLink; do it manually
    // Equivalent: B's own installed.pullNow if we had access. We use the
    // raw link.pullFeedbackFor + verify A's outbound is delivered.
    await drain()

    const aOutbound = A.hub.feedback.query({ toHub: 'hubB' })
    expect(aOutbound.length).toBe(1)
    expect(statusOf(aOutbound[0])).toBe('delivered')
  })
})

// ─── §4.2 three-hub triangle, only C owns capability ─────────────────

describe('Mesh E2E §4.2 — triangle, only C owns the capability', () => {
  let A: PeerNode
  let B: PeerNode
  let C: PeerNode
  beforeEach(async () => {
    A = await startNode('hubA')
    B = await startNode('hubB')
    C = await startNode('hubC')
  })
  afterEach(async () => {
    await A.stop()
    await B.stop()
    await C.stop()
  })

  it('A dispatches "deep-research"; routed to C (not B) over ws', async () => {
    C.hub.register(new EchoAgent('c-deep', ['deep-research']))

    const linkA_B = await dial(A, B)
    const linkB_A = B.inboundLinks[0]!
    installPeerLink({ hub: B.hub, link: linkB_A })
    installPeerLink({
      hub: A.hub,
      link: linkA_B,
      remoteCapabilities: [],
      autoMarkRead: false,
    })

    const linkA_C = await dial(A, C)
    const linkC_A = C.inboundLinks[0]!
    installPeerLink({ hub: C.hub, link: linkC_A })
    installPeerLink({
      hub: A.hub,
      link: linkA_C,
      remoteCapabilities: ['deep-research'],
      autoMarkRead: false,
    })

    await drain()

    const result = await A.hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['deep-research'] },
      payload: {},
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.by).toBe('hubC') // NOT 'hubB'
      expect(result.output).toMatchObject({ handledBy: 'c-deep' })
    }
  })
})

// ─── §4.3 offline → online → receipt → reputation routing ────────────

describe('Mesh E2E §4.3 — offline evaluation + read receipt + reputation routing', () => {
  let A: PeerNode
  let B: PeerNode
  let C: PeerNode
  beforeEach(async () => {
    A = await startNode('hubA')
    B = await startNode('hubB')
    C = await startNode('hubC')
  })
  afterEach(async () => {
    await A.stop()
    await B.stop()
    await C.stop()
  })

  it('B evaluates A offline; A connects; reputation drops; routing avoids A', async () => {
    // Setup: both B and C have an agent with cap 'draft'.
    // Initially A has no link to either; A's local hub also has no
    // 'draft' agent. We'll route from a future client through A — but
    // simpler: B itself dispatches 'draft' to whoever is best.
    //
    // Scenario:
    //   - B evaluates A (rating 1) five times BEFORE A links — these
    //     entries accrue in B's outbound (pending; A is offline).
    //   - B has an agent with cap 'draft' (b-writer) and so does C
    //     (c-writer). A has nothing relevant.
    //   - A comes online, links to B; pulls inbound feedback.
    //   - B's reputation for A is now ~-0.8 (5x rating 1).
    //   - B dispatches 'draft' — both b-writer (local, rep=0) and
    //     hubA (wrapper, rep=-0.8) are candidates. The scheduler
    //     should pick b-writer (higher rep).
    //   - Bonus: link C in. C also offers 'draft'. C has rep=0 (no
    //     evals). The pick is still NOT A (lowest rep loses).

    A.hub.register(new EchoAgent('a-writer', ['draft']))
    B.hub.register(new EchoAgent('b-writer', ['draft']))
    C.hub.register(new EchoAgent('c-writer', ['draft']))

    // Step 1: B evaluates A 5 times with rating 1, while A is offline.
    for (let i = 0; i < 5; i++) {
      B.hub.feedback.appendEntry(
        draft({
          toHub: 'hubA',
          toParticipant: 'a-writer',
          evaluatorHub: 'hubB',
          evaluatorParticipant: 'b-admin',
          rating: 1,
          comment: 'too slow round ' + i,
        }),
      )
    }
    // B's local reputation for A
    expect(B.hub.reputation.scoreOf('hubA')).toBeLessThan(-0.5)

    // Step 2: A comes online, dials B.
    const linkA_B = await dial(A, B)
    const linkB_A = B.inboundLinks[0]!
    installPeerLink({
      hub: B.hub,
      link: linkB_A,
      remoteCapabilities: ['draft'], // B sees A has 'draft'
    })
    const aInstalled = installPeerLink({
      hub: A.hub,
      link: linkA_B,
      remoteCapabilities: ['draft'], // A sees B has 'draft'
      autoMarkRead: true,
    })

    // Step 3: A pulls feedback B wrote about it. (The install fires an
    // auto-pull, so by the time we get here all 5 may already be in
    // inbound and explicit pullNow returns 0 new — we just want the
    // total to settle at 5.)
    await drain()
    await aInstalled.pullNow() // belt-and-suspenders; idempotent
    await drain()
    expect(A.hub.inboundFeedback.query().length).toBe(5)

    // After autoMarkRead, B's outbound for these entries shows 'read'.
    await drain()
    const bOut = B.hub.feedback.query({ toHub: 'hubA' })
    expect(bOut.length).toBe(5)
    expect(bOut.every((e) => statusOf(e) === 'read')).toBe(true)

    // Step 4: link C in as well (C has neutral rep on B).
    const linkB_C = await dial(B, C)
    const linkC_B = C.inboundLinks[0]!
    installPeerLink({ hub: C.hub, link: linkC_B, remoteCapabilities: [] })
    installPeerLink({
      hub: B.hub,
      link: linkB_C,
      remoteCapabilities: ['draft'],
    })
    await drain()

    // Step 5: B dispatches 'draft' three times. Candidates: b-writer
    // (local, rep 0), hubA wrapper (rep -0.8), hubC wrapper (rep 0).
    // Per M5b ranking: highest rep first, ties broken by least-load.
    // Local b-writer / hubC tie at 0; hubA at -0.8 must NEVER win.
    const winners: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await B.hub.dispatch({
        from: 'b-admin',
        strategy: { kind: 'capability', capabilities: ['draft'] },
        payload: { round: i },
      })
      expect(r.kind).toBe('ok')
      if (r.kind === 'ok') winners.push(r.by)
    }
    expect(winners.every((w) => w !== 'hubA')).toBe(true)
  })
})
