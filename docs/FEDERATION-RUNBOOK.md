# Cross-org federation — two-machine operator runbook

> Connect two Gotong hosts **on different machines** (org A and
> org B) over a real WebSocket so that one hub's workflows can
> orchestrate the other hub's capabilities — while **credentials /
> data / billing stay with their own org**. This is the go-live
> manual for the North Star's **layer 2, "cross-org collaboration"**:
> written for operators, step by step from minting the token to
> watching a cross-hub workflow complete.
>
> Want to see the mechanics in a single process first? Run
> `pnpm demo:cross-hub-federation` (`examples/cross-hub-federation/`)
> — two real hubs over real ws + bearer auth, deterministic, no keys.
> This document is that demo split across two real machines.
>
> 中文版见 [`docs/zh/FEDERATION-RUNBOOK.md`](zh/FEDERATION-RUNBOOK.md)。
>
> Last updated: 2026-06-12

---

## 0. Mental model (read these 4 first)

1. **Federation is symmetric; one token is registered once on each
   side.** There is no "client / server" — both sides are sovereign
   hubs. Org A mints one token, and both machines register **the same
   string** in their own peer record: org A uses it to dial out to
   org B; org B uses it to verify "the credential org A is expected
   to present."

2. **`endpointUrl` = the other side's ws address.** Each side's peer
   record points at the WebSocket endpoint where the **other** hub is
   reachable (`wss://partner.example.com:4000`, or behind a reverse
   proxy `wss://…/`). The federation port is shared with remote
   agents on the same `GOTONG_WS_PORT` (default 4000) — the HELLO frame
   demultiplexes itself.

3. **The framework does not make trust decisions for you.** The link
   is just a pipe. What capabilities may leave (`outboundCaps`),
   whether a human must approve (`requireApprovalOutbound`), which
   data classes may travel (`allowedDataClasses`), how much quota per
   window (`perLinkQuotaBudget`) — all of it is the per-link contract
   you configure **explicitly** on the peer record, fail-closed by
   default.

4. **A free graph, not a hierarchy.** Org A connecting to org B does
   **not** mean org A owns org B. Every link is a bilateral contract;
   revocation, quota, and data classes are per-link and never bleed
   across links.

> For the "why" of the security model (token encrypted into the vault
> on write, symmetric registration, revocation semantics) see
> [`zh/V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md`](./zh/ledger/V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md);
> for the design of per-link data-class / quota / revocation see
> [`zh/V4-PHASE19-P4-FINAL.md`](./zh/ledger/V4-PHASE19-P4-FINAL.md). This page
> does not repeat those — it is operations only.

---

## 1. Prerequisites

On each of the two machines:

- A production host running (`gotong-host`, the bin of
  `@gotong/host`; in the source repo use `pnpm host`), **with an
  identity store wired** (federation records live in identity's
  `peers` table + vault). How to start a local production host with
  identity: see [`zh/DEPLOY.md`](zh/DEPLOY.md).
- An **owner** account (peer CRUD and outbound approvals both require
  owner privileges).
- Network reachability: org B's machine can dial org A's exposed ws
  endpoint and vice versa (both directions — federation is symmetric).
- **TLS strongly recommended**: use `wss://` across the public
  internet (a reverse proxy — Caddy / nginx — terminates TLS and
  forwards to the local `GOTONG_WS_PORT`). Plaintext `ws://` only on a
  trusted LAN / same-machine demos.

Relevant environment variables (host side, read by `gotong-host`):

| Env | Default | Effect |
|---|---|---|
| `GOTONG_HOST` | `127.0.0.1` | Bind address for the HTTP and ws servers. For public exposure set `0.0.0.0` or a specific interface (better: let only the reverse proxy reach the box and keep the hub bound to `127.0.0.1`). |
| `GOTONG_WS_PORT` | `4000` | WebSocket port — **shared by remote agents and inbound peer HELLOs**. This is the port the other side's `endpointUrl` must point at. |
| `GOTONG_WEB_PORT` | `3000` | Admin UI + API (where the owner configures peers and approves outbound). Do **not** use this port as a peer endpoint. |
| `GOTONG_PEERS_DISABLED` | (unset) | Set `1` to turn federation off entirely (no outbound dialing, no inbound accepts). |
| `GOTONG_PEER_POLL_MS` | `5000` | Outbound dial/reconnect tick (ms). Peer-record changes take effect at the next tick at the latest. |
| `GOTONG_TRUST_PROXY` | (unset) | Set `1` to let inbound rate limiting read `X-Forwarded-For` — **only when the hub really sits behind a reverse proxy**. |
| `GOTONG_PEER_INBOUND_RATE_MAX` | `60` | Max HELLOs per IP per window (anti token brute-force). |
| `GOTONG_PEER_INBOUND_RATE_WINDOW_MS` | `60000` | The window (ms) for the limit above. |
| `GOTONG_PEER_LINK_QUOTA_WINDOW_MS` | `60000` | Counting window (ms) for the per-link inbound quota; the budget itself is the peer record's `perLinkQuotaBudget`. |

---

## 2. Steps

The walk-through below follows **org A initiating and orchestrating
one of org B's capabilities**. Federation is symmetric, so the
registration actions mirror each other — marked "machine A" /
"machine B" below.

### Step 1 — mint the token (on machine A, once)

```bash
gotong mint-peer-token --peer-id=org-b --endpoint=wss://hub-b.example.com:4000
```

- Output: **one line, a 256-bit base64url token** on **stdout**
  (pipe or `> token.txt` friendly); a pairing hint goes to **stderr**
  (does not pollute stdout).
- `--bytes=N` (16–64, default 32) tunes the entropy; `--peer-id` /
  `--endpoint` are only echoed into the stderr hint to help you keep
  track — they do not affect the token itself.
- **The token is a secret**: hand it to org B's admin over a secure
  channel (secret manager / encrypted message). Do **not** commit it
  to git or paste it in public channels.

> Who mints doesn't matter — federation is symmetric, A or B can
> mint. What matters is that **the same string is registered once on
> each side**.

### Step 2 — expose the ws endpoint (both machines)

Make sure the other side can dial your `GOTONG_WS_PORT`:

- Production: a reverse proxy terminates TLS for
  `wss://hub-a.example.com/` → forwards to local `127.0.0.1:4000`,
  with `GOTONG_TRUST_PROXY=1` set.
- Firewall: allow the other side's source IP to that port.
- Self-check: from the other machine,
  `curl -i http://<your-ws-host>:4000/` (or `wscat`) connecting at
  all is enough — the HELLO handshake is the hub's job; this step
  only verifies network reachability.

### Step 3 — register the peer on both sides (symmetric, once each)

Two equivalent entry points (the admin UI calls these APIs
underneath):

- **Admin UI**: log in as owner → "Federation" tab → peer onboarding
  panel (`#peer-admin-panel`) → "Add peer", filling peerId /
  endpointUrl / peerToken + the per-link contract.
- **API**: `POST /api/admin/identity/peers` (owner-authenticated).

**Machine A** (outbound to org B), request body:

```json
POST /api/admin/identity/peers
{
  "peerId":      "org-b",
  "endpointUrl": "wss://hub-b.example.com:4000",
  "label":       "Organization B (prod)",
  "peerToken":   "<the same token minted in Step 1>",
  "outboundCaps": ["legal.contract-review"],
  "requireApprovalOutbound": true
}
```

**Machine B** (inbound, accepting org A) mirrors the registration
with the same token:

```json
POST /api/admin/identity/peers
{
  "peerId":      "org-a",
  "endpointUrl": "wss://hub-a.example.com:4000",
  "label":       "Organization A (prod)",
  "peerToken":   "<the same token>",
  "acl": { "capabilities": ["legal.contract-review"] }
}
```

Key points:

- **`peerToken` is write-only**: encrypted into the vault on write
  and **never returned** by any GET. To rotate, just PATCH a new
  value.
- **`endpointUrl` points at the other side**: machine A fills in B's
  ws address, machine B fills in A's.
- **Enable** the peer in the "Federation" panel (lifecycle: enable /
  revoke / delete).

### Step 4 — configure the per-link trust contract

These fields live on POST / PATCH `/api/admin/identity/peers[/:id]`
and in the per-link contract editor in the "Federation" panel. **All
of them are per-link and never bleed across links.**

| Field | Type | Semantics / default |
|---|---|---|
| `acl` | `{capabilities?, requireOrigin?, requireOriginRole?}` \| `null` | **Inbound** ACL. `null` = accept all inbound capabilities; setting a `capabilities` allowlist admits only those. `requireOrigin` demands an originating user. |
| `outboundCaps` | `string[]` \| `null` | **Outbound** capability allowlist. `null` = **nothing leaves** (fail-closed); `[]` equally locked. Listed capabilities are both **advertised** to this side's workflows (routable to the peer) and **authorized** to leave — advertisement = authorization. |
| `requireApprovalOutbound` | `boolean` | On an outbound hit, the task **parks into the owner's `/me` inbox**; only an approval lets it actually cross the socket. Turn this on for anything sensitive. |
| `allowedDataClasses` | `string[]` \| `null` | Data classes an outbound task may carry. `null` = all allowed; `[]` = locked. Judged at the outbound gate against each node's `dataClasses`. |
| `perLinkQuotaBudget` | `number` \| `null` | **Inbound** task cap per `GOTONG_PEER_LINK_QUOTA_WINDOW_MS` window. `null` = unlimited. Over budget fails closed. |
| `allowedKnowledgeBases` | `string[]` \| `null` | Allowlist of shared KBs (MCP server names) the peer may call. `null` = anything shared is callable; `[]` = locked. |
| `revocationState` | `'active'` \| `'revoked'` | Revocation switch. Setting `revoked` → tears down the link + rejects inbound + refuses at the wire layer — all three gates drop. It is **never** silently cleared to null. |
| `shareSummary` | `boolean` | Opt-in to share a **privacy-safe counts summary** (assets/activity/health — never raw rows) with the peer's control plane via the `peer.summary` RPC. Off by default. |
| `shareTranscript` | `boolean` | Opt-in to share transcript slices of cross-hub steps via the `peer.transcript` RPC, letting the other side's run detail show what that step did on your hub. Off by default. |

**Start from least privilege**: list only the capabilities you really
need in `outboundCaps`; turn on `requireApprovalOutbound` for
sensitive egress; when unsure leave `null` (= locked / fail-closed)
and open up as needed.

### Step 5 — verify the link is up

- `GET /api/admin/identity/peers` → find the peer, check
  `connected: true` and `backoffAttempts: 0`.
- The "Federation" tab should show the peer online.
- Refresh capability discovery once:
  `POST /api/admin/peer-manifests/refresh` then
  `GET /api/admin/peer-manifests` → that peer shows `online: true`
  plus `capabilities` listing what org B advertises (as curated by
  `outboundCaps`), e.g. `legal.contract-review`.

If the link won't come up, see §4.

### Step 6 — run a cross-hub workflow (on machine A)

Import a workflow on org A where one step dispatches a capability
**only org B provides**. The YAML **never names the peer** — it is an
ordinary capability dispatch:

```yaml
schema: gotong.workflow/v1
workflow:
  id: cross-org-contract-review
  trigger: { capability: legal:start }
  steps:
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [legal.contract-review] }  # lives on org B
        payload: { doc: $trigger.payload.doc }
    - id: archive
      dispatch:
        strategy: { kind: capability, capabilities: [legal.archive] }           # local
        payload: { doc: $trigger.payload.doc, verdict: $review.output.verdict }
```

Import → publish → trigger ("Start" in the admin workflow panel, or
dispatch `legal:start`). Because Step 4 enabled
`requireApprovalOutbound`, the run **parks at the outbound approval
gate** — at this moment **no frame has crossed the socket** and org B
knows nothing. The admin run detail marks the step "⏸ awaiting your
approval — outbound to peer hub org-b" with a deep link to the inbox.

### Step 7 — approve from the `/me` inbox (owner)

The owner opens `/me` → inbox → sees an approval item "Approve
sending this outbound task to peer org-b?" → **approve**. Only now
does the task actually cross the socket to org B → org B runs its
`legal.contract-review` → the verdict flows back over ws as the
`review` step's output → the local `archive` step archives it → the
workflow completes.

**Reject** and it fails closed: org B is never contacted, zero frames
on the socket, the local archive step never executes.

### Step 8 — observe in the control plane

- **Capability discovery**: `GET /api/admin/peer-manifests` — what
  the peer advertises, online/stale.
- **Footprint control plane** (requires the peer's
  `shareSummary: true`): `GET /api/admin/peer-summaries` — local +
  per-peer privacy-safe counts (assets/activity/health, **never**
  raw rows).
- **Trends + alerts** (v5 Stream F):
  `GET /api/admin/peer-summaries/history?source=&metric=` draws the
  timeline; `GET /api/admin/peer-summary-alerts` shows breaches,
  `POST /api/admin/peer-summary-alerts/rules` configures thresholds.
  The "Control plane" UI has sparklines + alert badges.
- **Usage attribution**: cross-hub calls carry `peer_id` in the
  `usage_ledger`; the admin "Usage" dashboard can aggregate by the
  "federation peer" dimension.

---

## 3. Security checklist

- [ ] **Token travels over a secure channel**; it is encrypted into
      the vault on write and never echoed back; rotate by PATCHing a
      new value.
- [ ] **`wss://` only** across the public internet; behind a reverse
      proxy set `GOTONG_TRUST_PROXY=1` and scope the firewall by source
      IP.
- [ ] **Minimize `outboundCaps`** — list only what you actually use;
      `null`/`[]` = locked.
- [ ] **Enable `requireApprovalOutbound` for sensitive egress** —
      human in the loop, the owner's inbox decides.
- [ ] **Constrain `allowedDataClasses`** for sensitive data classes;
      judged per node.
- [ ] **`perLinkQuotaBudget`** caps inbound so a peer can't flood
      you.
- [ ] Don't raise the inbound rate limit
      `GOTONG_PEER_INBOUND_RATE_MAX` too far (the default 60/minute is
      enough against brute force).
- [ ] On incident or end of partnership: set the peer's
      `revocationState` to `revoked` (all three gates drop), or
      delete it outright.
- [ ] `shareSummary` / `shareTranscript` stay off by default — enable
      only if you want the peer's control plane to see your counts /
      step traces.

---

## 4. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `GET …/peers` keeps showing `connected: false`, `backoffAttempts` climbing | Endpoint unreachable: verify `endpointUrl` (the other side's ws host + `GOTONG_WS_PORT`), firewall, TLS certificate. From your machine `curl`/`wscat` the other endpoint to verify the network. |
| Handshake closed, logs say `closed during handshake` / `peer_disconnected` | **Token mismatch** (the two sides don't hold the same string) or `expectedPeerId` mismatch. Note: the rejecting side **does not return the failure reason** (anti-enumeration) — the dialing side only sees "link closed". Check the **accepting** side's logs for the precise reason. Re-align the token (Steps 1/3). |
| Workflow step reports `no_participant` / never routes to the peer | Org B isn't advertising the capability: check that B actually serves it, and that A's `outboundCaps` lists it (advertisement = authorization — if unlisted it is neither advertised nor authorized). Retry after `peer-manifests/refresh`. |
| Outbound fails with `outbound_capability_denied:<cap>` | The capability is missing from A's `outboundCaps` allowlist — add it (Step 4). |
| Inbound rejected, the peer reports quota | `perLinkQuotaBudget` hit: raise the budget or widen `GOTONG_PEER_LINK_QUOTA_WINDOW_MS`. |
| Run sits parked forever | Almost certainly the outbound approval gate waiting on a human: the owner should visit the `/me` inbox (Step 7). The amber "awaiting your approval" badge + deep link in the admin run detail jumps straight there. |
| Peer-record change has no effect | Outbound dialing ticks every `GOTONG_PEER_POLL_MS` (default 5 s); takes effect by the next tick at the latest. Revocation / contract changes propagate immediately through all three install points. |

---

## 5. Matching examples and acceptance gates

Every claim in this runbook is backed by runnable material / an
automated acceptance gate in the repo:

| To verify | Run / look at |
|---|---|
| The whole story (handshake + approval + cross-socket + wrong-token rejection) | `pnpm demo:cross-hub-federation` (`examples/cross-hub-federation/`, deterministic, self-asserting) |
| Cross-hub workflow + outbound approval gate over real ws | `packages/host/tests/cross-hub-workflow-ws-e2e.test.ts` (approve / reject / no-approval) |
| Transcript chain over real ws + opt-in gate | `packages/host/tests/cross-hub-transcript-chain-ws-e2e.test.ts` |
| Disconnect + redial resilience (park survives, approval completes after redial) | `packages/host/tests/cross-hub-redial-resilience-e2e.test.ts` |
| Multi-org isolation (clamping one link doesn't bleed) | `packages/host/tests/peer-isolation-ws-e2e.test.ts` |

---

## 6. Further reading

- [`zh/V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md`](./zh/ledger/V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md) — the security model behind peer onboarding + where the CLI/UI came from.
- [`zh/V4-PHASE18-FINAL.md`](./zh/ledger/V4-PHASE18-FINAL.md) — federation capability manifest + inbound ACL + outbound approval gate + A2A.
- [`zh/V4-PHASE19-P4-FINAL.md`](./zh/ledger/V4-PHASE19-P4-FINAL.md) — per-link data-class / quota / revocation contracts.
- [`zh/V5-G-FINAL.md`](./zh/ledger/V5-G-FINAL.md) — cross-hub workflow orchestration (North Star layer 2; advertisement = authorization + two-step resume + the three invariants).
- [`zh/V5-E5-FINAL.md`](./zh/ledger/V5-E5-FINAL.md) / [`zh/V5-F-FINAL.md`](./zh/ledger/V5-F-FINAL.md) — control-plane summaries + historical trends + alerts.
