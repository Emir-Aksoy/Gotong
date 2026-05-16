# Federation services — RFC

Status: minimal scaffolding shipped in v1.2 (`TeamBridgeAgent.forwardUpstreamServices` +
`upstreamServices` field). Full federated routing — including upstream
calling INTO a sub-team's services — is open work tracked here.

---

## What ships in v1.2

`TeamBridgeAgent` already wraps a local Hub as one agent on a parent
Hub. The federation seam was previously **service-blind**: forwarded
tasks ran on local agents that could only see local services.

v1.2 adds a **one-way** federation service path:

```ts
const bridge = new TeamBridgeAgent({
  id: 'alice-team',
  capabilities: ['draft', 'review'],
  localHub,
  forwardUpstreamServices: [
    // The bridge wants to read/write to the upstream's shared cases
    // datastore as if it were one of the upstream's agents.
    { type: 'datastore', impl: 'sqlite',
      owner: { kind: 'shared', id: 'org-cases' } },
  ],
})

const session = await connect({
  url: 'wss://parent-hub.example.com/ws',
  agents: [bridge],
  services: bridge.forwardUpstreamServices,
})
bridge.upstreamServices = session.services
```

A local agent that holds a reference to `bridge.upstreamServices` can
now do:

```ts
const ds = bridge.upstreamServices!.datastoreFor('sqlite', {
  kind: 'shared', id: 'org-cases',
})
await ds.kv.set('cases.latest', summary)
```

**The federation boundary is explicit.** Local agents that don't see
the bridge instance can't touch upstream services. There's no
implicit promotion of upstream services into the local Hub's services
list — by design.

---

## What v1.2 does NOT do

### 1. Upstream agents calling INTO a sub-team's services

Today the bridge only forwards TASK frames downstream. The reverse —
an upstream agent issuing a SERVICE_CALL that should land on the
local team's plugins — is not wired. Implementing it requires:

- A protocol-level "namespace" on SERVICE_CALL: how does the upstream
  router know that `agent: alice-team, type: memory, impl: file,
  owner: …` should NOT hit the parent hub's memory plugin but be
  forwarded to alice-team's local hub?
- A frame on the bridge's WS for delivering forwarded SERVICE_CALL
  frames (downstream direction).
- Local Hub plugins that can run on behalf of an upstream caller —
  i.e. ACL checks against an `effectiveAgentId` rather than the
  bridge's local id.

This is the bulk of the work and is left out of v1.2 — until a real
use case shows up (probably "managed agent on parent hub wants to
read a sub-team's shared scratchpad without joining the local hub").

### 2. Service ACL composition across hubs

When the upstream approves `alice-team` to use
`datastore:org-cases`, that's an upstream-side ACL. The local agents
that read through `bridge.upstreamServices` are NOT subject to the
local hub's ACL — they're outside it by construction.

If a deployment wants the local team's admins to also gate the
upstream calls, they need to **wrap** `upstreamServices` themselves:

```ts
function gatedUpstreamServices(local: ServiceClient): ServiceClient {
  // wrap each handle method with a localHub.acl(check) call
}
```

This is application code, not protocol. RFC for a first-class
double-gating layer is a v1.4 candidate.

### 3. Streaming through the bridge

`service-call-streaming-rfc.md` (v1.3 draft) hasn't shipped yet.
When it does, the bridge will need a "tunnel" mode that pipes chunks
end-to-end without buffering — currently SERVICE_RESULT_CHUNK frames
have no path through `TeamBridgeAgent`.

---

## Why not just expose `localHub.services` to upstream?

Tempting, but wrong:

- **Wrong ACL boundary.** The upstream hub's admins shouldn't be able
  to soft-delete files owned by the local team. The split is the
  whole point of federation.
- **Identity confusion.** Service-call audit needs to know which
  side initiated the call. A flat exposure muddles `from` semantics.
- **Plugin contracts assume single-process attach.** `service-memory-file`
  caches file handles per-(plugin, owner). Two hubs reaching into the
  same plugin instance through different processes would need
  invalidation across both — significantly more work than the v1.2
  one-way path.

The two-hub federation stays explicit by design, with the bridge as
the only stable seam between them.

---

## Test plan (when full bidirectional ships)

1. **Upstream → local SERVICE_CALL forwarding**: parent hub agent
   calls `memoryFor({kind:'agent', id:'alice-team-coach'})` (a
   sub-team member); bridge proxies the call into the local hub.
2. **ACL boundary**: upstream tries `memoryFor({kind:'agent',
   id:'unauthorized-local'})` — bridge rejects with
   `forbidden_owner` even if local plugin would allow.
3. **Identity**: audit shows `from: 'upstream:parent-coach'`,
   `via: 'alice-team'`. Local admins see who really called.
4. **Streaming**: large `sql.queryStream` from upstream through
   bridge to local — no buffering, latency bounded.

None of these run in v1.2 — there's no implementation to test. This
file lives so the next contributor doesn't re-design from scratch.

---

## Status

- v1.2: type & convention scaffolding only (this file + bridge fields).
- v1.3: gated on streaming-rfc landing.
- v1.4 candidate: double-gating ACL composition + full bidirectional.
