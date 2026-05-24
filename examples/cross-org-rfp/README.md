# @aipehub/example-cross-org-rfp

A **cross-organisation** RFP (request-for-quote) demo. Unlike the
existing examples — which all use one hub with multiple agents
serving a single user — this one models the smallest "real"
cross-org workflow: **two organisations, each running their own hub,
federated through an inproc HubLink, collaborating on a single
business artifact (a quote)**.

```
   Org A — Acme            inproc HubLink           Org B — Widgets Inc
   ┌──────────────┐         ◀──────────▶         ┌──────────────────┐
   │ procurement  │                              │ vendor-quote     │
   │    user      │                              │    agent         │
   │              │                              │  + reviewer      │
   │ orgAHub      │                              │  orgBHub         │
   └──────────────┘                              └──────────────────┘
        │                                                    ▲
        ├─ dispatch RFP ────────────────────────────────────┤
        │   { item, qty, budget, delivery }                 │
        │                                                    │
        │                                       drafts quote ┤
        │                                  HITL review (sim) ┤
        │                                                    │
        ◀── approved QuoteResponse ───────────────────────────
```

## Run it

```bash
pnpm --filter @aipehub/example-cross-org-rfp start
```

Single terminal. No web UI, no admin tokens, no WebSocket, no Space
on disk. Just one process running two in-memory hubs talking to each
other across the federation primitives that `@aipehub/core` already
exposes (`createInprocHubLinkPair` + `installPeerLink`).

## What's happening

1. `Hub.inMemory()` × 2 — one per "organisation"
2. `createInprocHubLinkPair` — symmetric bidirectional channel
3. `installPeerLink` on both sides — wires the link as a
   capability-routing edge of each hub
4. Org B registers `VendorQuoteAgent` with capability `vendor-quote`
5. Org A dispatches a task with `{ strategy: { kind: 'capability',
   capabilities: ['vendor-quote'] } }` — Org A's local registry has
   no such capability, but the inbound link wrapper does, so mesh
   routing forwards the task across the link
6. Org B's agent drafts a quote, simulates a HITL review (300ms
   pause + a real reviewer email stamped on the result), returns it
7. The result flows back through the link and resolves Org A's
   dispatch promise

## Why this matters for v4

The "single host = single organisation, cross-org via federation"
architectural choice in `docs/zh/V4-ARCH.md` lives or dies on
federation actually being usable for cross-org work. This demo is the
proof: **the wiring is already a few lines of code**. v4's identity
layer is what gets bolted on top — every org runs its own
`@aipehub/identity` store, federation links carry the identity-
authenticated principal across the boundary (Phase 3+ work).

## What's deliberately not in this demo

- **No real LLM.** `VendorQuoteAgent` returns a deterministic mock so
  the demo runs offline + reproducibly. Swap to `LlmAgent` for a
  realistic version once you've wired API keys.
- **No real HITL approval.** A 300ms `setTimeout` stands in for the
  reviewer. Real impl would block on `AgentDispatchSurface` until a
  human (from the vendor org) clicks approve in their admin UI.
- **No identity / role check on the federation edge.** Phase 3+ work
  in v4 will gate `installPeerLink` registrations behind cross-org
  trust statements. For now this demo assumes the inproc pair is
  trusted by construction.
- **No persistence.** Both hubs use `Hub.inMemory()` — the process
  exits cleanly after the result prints. Production usage would have
  `Space.openOrInit()` per org.

## Try it

The fastest way to feel the federation is to break the link: comment
out one of the `installPeerLink` calls and re-run. You'll see
`no_participant` come back — Org A's dispatch had nowhere to go.
That's the entire contract: install the link, get the capability;
don't install it, no routing.
