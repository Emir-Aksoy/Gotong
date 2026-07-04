/**
 * Cross-organisation RFP demo — two hubs in one process, federated
 * via an inproc HubLink.
 *
 * Run with: pnpm --filter @gotong/example-cross-org-rfp start
 *
 * See ../README.md for the architectural pitch. The code below is
 * deliberately ~200 lines so it fits on one screen: the federation
 * wiring is the interesting bit and everything else (RFP shape,
 * vendor agent, banner output) is plain glue.
 */

import {
  AgentParticipant,
  Hub,
  createInprocHubLinkPair,
  installPeerLink,
  type ParticipantId,
  type Task,
} from '@gotong/core'

// ---------------------------------------------------------------------------
// Domain types — the shape of the artifact crossing the org boundary.
// Both sides must agree; in production these would live in a shared
// `@<org>/rfp-protocol` package.
// ---------------------------------------------------------------------------

interface RfpPayload {
  buyerOrg: string
  itemDescription: string
  quantity: number
  budgetUsd: number
  deliveryWeeks: number
}

interface QuoteResponse {
  vendorOrg: string
  unitPriceUsd: number
  totalPriceUsd: number
  leadTimeWeeks: number
  notes: string
  reviewedBy: string
  reviewedAt: number
}

// ---------------------------------------------------------------------------
// Phase 4 — toy "identity" for Org A. In production this would be a
// real `@gotong/identity` IdentityStore (sqlite-backed); here we keep
// the example zero-dep by hardcoding a tiny user table. The shape of
// the `OriginResolver` is identical either way — the resolver function
// just needs to turn the LOCAL actor id (`task.from`) into the
// user-level fields of `TaskOrigin`.
// ---------------------------------------------------------------------------

interface ToyUser {
  userId: string
  userRole: 'owner' | 'admin' | 'member' | 'viewer'
  userEmail: string
}

const ORG_A_USERS: Record<ParticipantId, ToyUser> = {
  'acme-procurement': {
    userId: 'acme-procurement',
    userRole: 'admin',
    userEmail: 'procurement@acme.example',
  },
  'acme-intern': {
    userId: 'acme-intern',
    userRole: 'viewer', // intentionally below the ACL bar set on Org B
    userEmail: 'intern@acme.example',
  },
}

function resolveOrgAUser(from: ParticipantId) {
  const u = ORG_A_USERS[from]
  if (!u) return null
  return { userId: u.userId, userRole: u.userRole, userEmail: u.userEmail }
}

// ---------------------------------------------------------------------------
// Org B's vendor-quote agent. Drafts a quote then simulates a HITL
// reviewer signing off. In production the HITL step would block on
// `AgentDispatchSurface.requestHumanInput()` and a real human in the
// vendor org would approve via their admin UI (see HITL-GLOSSARY.md).
// ---------------------------------------------------------------------------

class VendorQuoteAgent extends AgentParticipant {
  private readonly orgName: string
  private readonly reviewerName: string

  constructor(opts: { id?: string; orgName: string; reviewerName: string }) {
    super({
      id: opts.id ?? 'vendor-quote-agent',
      capabilities: ['vendor-quote'],
    })
    this.orgName = opts.orgName
    this.reviewerName = opts.reviewerName
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const payload = task.payload as RfpPayload
    // FED-M2 demo — task.origin tells us WHO from Org A asked for this.
    // We could use it to log, to choose pricing tiers, or to require
    // additional approvals for high-stakes buyers.
    if (task.origin) {
      console.log(
        `[org-b/vendor-quote] received RFP from ${payload.buyerOrg} ` +
          `(actor: ${task.origin.userEmail ?? task.origin.userId} ` +
          `role=${task.origin.userRole ?? '?'} org=${task.origin.orgId})`,
      )
    } else {
      console.log(
        `[org-b/vendor-quote] received RFP from ${payload.buyerOrg} (UNAUTHENTICATED federated actor)`,
      )
    }
    console.log(
      `[org-b/vendor-quote] item: ${payload.itemDescription} ×${payload.quantity}, budget $${payload.budgetUsd.toLocaleString()}`,
    )

    // Step 1: draft a quote (deterministic mock — pretends to "win" the bid
    // by undercutting the budget by 15%).
    const unitPriceUsd = Math.floor((payload.budgetUsd / payload.quantity) * 0.85)
    const totalPriceUsd = unitPriceUsd * payload.quantity
    const leadTimeWeeks = Math.max(2, payload.deliveryWeeks - 1)
    console.log(
      `[org-b/vendor-quote] drafted quote: $${totalPriceUsd.toLocaleString()} (${leadTimeWeeks}w lead time). Submitting for HITL review…`,
    )

    // Step 2: simulate the HITL approval. Real implementation would
    // pause here until a human in Org B clicks "approve" in their UI.
    await sleep(300)

    const reviewedAt = Date.now()
    console.log(
      `[org-b/vendor-quote] reviewer ${this.reviewerName} approved the quote ✓`,
    )

    const out: QuoteResponse = {
      vendorOrg: this.orgName,
      unitPriceUsd,
      totalPriceUsd,
      leadTimeWeeks,
      notes: `Includes installation + 12-month warranty. Ships within ${leadTimeWeeks} weeks of order confirmation.`,
      reviewedBy: this.reviewerName,
      reviewedAt,
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  banner('Cross-organisation RFP demo')

  // 1. Stand up one in-memory hub per org. `Hub.inMemory()` is the
  //    canonical "no Space, no disk" boot — perfect for self-contained
  //    examples + tests.
  const orgAHub = Hub.inMemory()
  const orgBHub = Hub.inMemory()
  await orgAHub.start()
  await orgBHub.start()
  console.log('[org-a / Acme]      hub started (buyer)')
  console.log('[org-b / Widgets]   hub started (vendor)')

  // 2. Federate with an inproc HubLink. Each `installPeerLink` call
  //    registers a `RemoteHubViaLink` wrapper in the local hub so that
  //    local capability dispatch can route across the link. The wrapper
  //    on Org A's side is told it can serve `vendor-quote` — that's how
  //    Org A's scheduler knows to reach across when the local registry
  //    has no candidate.
  const { a: aLink, b: bLink } = createInprocHubLinkPair({
    aPeerId: 'widgets-hub',
    bPeerId: 'acme-hub',
  })
  installPeerLink({
    hub: orgAHub,
    link: aLink,
    remoteCapabilities: ['vendor-quote'],
    localWrapperId: 'org-b-bridge',
    // FED-M2 — stamp `origin` on outbound tasks so Org B knows who
    // from Org A is asking. In production `originResolver` would call
    // into a real IdentityStore (see @gotong/identity); here it's a
    // hardcoded lookup table for example simplicity.
    selfHubId: 'acme-hub',
    originResolver: resolveOrgAUser,
  })
  installPeerLink({
    hub: orgBHub,
    link: bLink,
    // Org A doesn't advertise capabilities upstream in this demo, but
    // the symmetric wiring is free.
    remoteCapabilities: [],
    localWrapperId: 'org-a-bridge',
    selfHubId: 'widgets-hub',
    // FED-M3 — Org B's policy on incoming federated tasks:
    //   * must carry an origin (no anonymous federated dispatches)
    //   * the actor's role must be admin or owner (no junior interns
    //     casually shopping H100 GPUs across the federation)
    //   * only the 'vendor-quote' capability is reachable from outside
    //     (any other call surface stays internal to Org B)
    acl: {
      requireOrigin: true,
      requireOriginRole: ['owner', 'admin'],
      capabilities: ['vendor-quote'],
    },
  })
  console.log('                    ↔ federation link established\n')

  // 3. Org B registers its agent.
  const vendor = new VendorQuoteAgent({
    orgName: 'Widgets Inc',
    reviewerName: 'bob@widgets.local',
  })
  orgBHub.register(vendor)
  console.log(
    '[org-b]             registered "vendor-quote-agent" (reviewer: bob@widgets.local)\n',
  )

  // 4. Org A dispatches the RFP. Capability-based dispatch + no local
  //    candidate ⇒ scheduler walks the registry, finds `org-b-bridge`
  //    advertising `vendor-quote`, sends through the link. Org B's
  //    side re-dispatches into its local hub which lands on the agent.
  const rfp: RfpPayload = {
    buyerOrg: 'Acme',
    itemDescription: 'NVIDIA H100 GPU servers (8× H100 per chassis)',
    quantity: 5,
    budgetUsd: 200_000,
    deliveryWeeks: 8,
  }
  console.log(
    `[org-a]             dispatching RFP: ${rfp.itemDescription} ×${rfp.quantity}`,
  )
  console.log(
    `                    budget: $${rfp.budgetUsd.toLocaleString()}, delivery: ${rfp.deliveryWeeks}w\n`,
  )

  const result = await orgAHub.dispatch({
    from: 'acme-procurement',
    strategy: { kind: 'capability', capabilities: ['vendor-quote'] },
    payload: rfp,
    title: 'RFP: GPU servers',
  })

  console.log('')
  banner('Result back at Org A')
  if (result.kind === 'ok') {
    const q = result.output as QuoteResponse
    const lines: Array<[string, string]> = [
      ['Vendor',      q.vendorOrg],
      ['Unit price',  `$${q.unitPriceUsd.toLocaleString()}`],
      ['Total',       `$${q.totalPriceUsd.toLocaleString()}`],
      ['Lead time',   `${q.leadTimeWeeks} weeks`],
      ['Reviewed by', q.reviewedBy],
      ['Reviewed at', new Date(q.reviewedAt).toISOString()],
      ['Notes',       q.notes],
      ['Routed via',  result.by],
    ]
    for (const [k, v] of lines) {
      console.log(`  ${k.padEnd(12)} ${v}`)
    }
  } else {
    console.error('  FAILED:', JSON.stringify(result, null, 2))
    await orgAHub.stop()
    await orgBHub.stop()
    process.exit(1)
  }

  // -------------------------------------------------------------------
  // FED-M3 demo — the same RFP dispatched by a VIEWER-role user gets
  // rejected by Org B's ACL before it ever reaches the vendor agent.
  // -------------------------------------------------------------------
  console.log('')
  banner('Counter-example: intern attempts the same RFP')
  console.log(
    '[org-a]             dispatching as acme-intern (role=viewer)\n',
  )
  const internResult = await orgAHub.dispatch({
    from: 'acme-intern',
    strategy: { kind: 'capability', capabilities: ['vendor-quote'] },
    payload: rfp,
    title: 'RFP: GPU servers (intern attempt)',
  })
  if (internResult.kind === 'failed') {
    console.log(`  ACL refused — error: ${internResult.error}`)
    console.log(`  refused by:   ${internResult.by}`)
    console.log(
      '  → vendor agent NEVER saw the task; no log line from org-b/vendor-quote above.',
    )
  } else {
    console.error('  EXPECTED FAILURE; got:', JSON.stringify(internResult))
    await orgAHub.stop()
    await orgBHub.stop()
    process.exit(2)
  }

  console.log('')
  banner('Demo complete')
  await orgAHub.stop()
  await orgBHub.stop()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function banner(text: string): void {
  const line = '═'.repeat(text.length + 4)
  console.log(line)
  console.log(`  ${text}  `)
  console.log(line)
}

main().catch((err) => {
  console.error('[demo] fatal:', err)
  process.exit(1)
})
