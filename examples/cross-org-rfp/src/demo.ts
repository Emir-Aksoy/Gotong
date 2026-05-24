/**
 * Cross-organisation RFP demo — two hubs in one process, federated
 * via an inproc HubLink.
 *
 * Run with: pnpm --filter @aipehub/example-cross-org-rfp start
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
  type Task,
} from '@aipehub/core'

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
    console.log(
      `[org-b/vendor-quote] received RFP from ${payload.buyerOrg}: ${payload.itemDescription} ×${payload.quantity}, budget $${payload.budgetUsd.toLocaleString()}`,
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
  })
  installPeerLink({
    hub: orgBHub,
    link: bLink,
    // Org A doesn't advertise capabilities upstream in this demo, but
    // the symmetric wiring is free.
    remoteCapabilities: [],
    localWrapperId: 'org-a-bridge',
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
