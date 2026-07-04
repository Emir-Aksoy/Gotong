# RFC: Services over WebSocket (protocol v1.1)

> **Status**: DRAFT (awaiting sign-off on §3 ACL Model, §4 Frame schema, §6 Lifecycle)
> **Replaces**: nothing — additive on top of wire protocol v1.0
> **Affects**: `@gotong/protocol`, `@gotong/transport-ws`, `@gotong/sdk-node`, `@gotong/host` (server-side routing). No change to `@gotong/core`, plugin contracts (`@gotong/services-sdk`), or first-party plugins.

---

## 1. Why

### 1.1 The gap, in one paragraph

Gotong already supports two physical shapes of agent (in-process and
remote-over-WS) and design docs promise they're API-equivalent: "you
can move an agent between them without changing its logic"
(`docs/AGENT.md`). But that promise breaks the moment an agent wants
to use Hub Services (memory / artifact / datastore) — those handles
only exist inside the host process. A remote agent that wants to
`memory.recall(...)` today has three bad options:

1. Read the jsonl files directly (breaks the abstraction; bypasses ACL)
2. Call the host's admin REST API per service operation (heavy, requires admin token, not designed for that throughput)
3. Have the workflow YAML pre-stuff service results into `task.payload` (state management is now the workflow's job, agent loses control)

The result is that **all "active" agents** (the `industry-coach-pro`
multi-phase / case-aware family) are forced into the **in-process**
shape via `extends LlmAgent` + bespoke `handleTask` overrides + manual
`boot.services.attach(...)` in main() — which means installing them
requires `pnpm install` or a host code change. That's the "npm
environment operation" we want to avoid.

### 1.2 The fix, in one paragraph

Extend wire protocol v1.0 with two new frames (`SERVICE_CALL` /
`SERVICE_RESULT`) and one optional HELLO field (`services`). The host
exposes its existing `HubServices` facade across the WebSocket;
remote agents get an SDK-side `ServiceCtx` that's **the same interface
they'd see if running in-process**. ACL is enforced at the session
level by `(apiKey, declared services)`. Lifecycle (attach / detach)
is driven by HELLO / GOODBYE plus on-demand attach for dynamic
owners (case-scoped memory). No new service type, no new plugin
contract, no change to first-party plugins.

### 1.3 Non-goals

- **Not a generic RPC framework**. Only the methods on the existing
  `MemoryHandle` / `ArtifactHandle` / `DatastoreHandle` contracts are
  exposed. New service types ship the same way as before (write a
  plugin under `@gotong/services-sdk`); no protocol change needed.
- **Not a substitute for HELLO/admin-approval gating**. Existing
  `gating: 'admin-approval'` + `forbidden_agent` REJECT continue to
  guard who can join. Services ACL builds on top.
- **Not transactional**. Service operations are per-call; the host
  doesn't expose multi-call transactions over WS. Plugins that need
  internal batching (sqlite WAL etc.) handle it inside their `attach`.
- **Not a streaming RPC**. Calls are single-request / single-reply.
  `memory.recall` already returns a finite list; if that becomes a
  bottleneck we add pagination, not streaming.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **service use decl** | An entry in HELLO's optional `services` field. Declares which `(type, impl, ownerPattern)` triples this connection wants permission to call. |
| **owner pattern** | The ACL primitive: `{ kind: OwnerKind, id: string \| '*' }`. The `*` form authorises *any* concrete id of that kind (useful for `workflow-run/*` case-scoped owners). |
| **resolved owner** | A concrete `{ kind, id }` resolved per-call. The host checks it against the agent's declared patterns at SERVICE_CALL time. |
| **handle cache** | Per-session map keyed by `(type, impl, resolvedOwner)`. First call for a triple attaches lazily; subsequent calls reuse. |

---

## 3. ACL Model (decision point #1)

### 3.1 Three layers of admission

1. **apiKey** — already in v1.0. Hub's `authenticate(apiKey)` returns either `false` / `true` / `{ ok, allowedAgents }`.
2. **agent id allow-list** — already in v1.0 (`forbidden_agent` REJECT). The apiKey may be bound to a fixed set of `agent.id` values.
3. **service use declarations** — **new in v1.1**. The HELLO's `services` field is an allow-list of `(type, impl, ownerPattern)` triples. Every SERVICE_CALL must match at least one.

The first two layers exist; only the third is new. They compose: a
session is admitted (`apiKey` ok), agents register (`agent.id` ok),
service calls are routed (`service decl` ok).

### 3.2 Owner pattern semantics

```ts
interface ServiceUseDecl {
  type: 'memory' | 'artifact' | 'datastore' | string
  impl: string                    // 'file' / 'sqlite' / etc.
  owner: {
    kind: 'agent' | 'workflow-run' | 'shared'
    id: string | '*'              // '*' means any concrete id of that kind
  }
  config?: unknown                // passed to plugin.validateConfig at first attach
}
```

Rules:

- **`owner.id === '*'`** → any concrete id of that kind passes ACL. Used for case-scoped memory (`{kind:'workflow-run', id:'*'}`) where the case id is dynamic per task.
- **`owner.id === '<literal>'`** → only that exact id passes. Used for stable per-agent owners (`{kind:'agent', id:'industry-coach-pro'}`) and shared groups (`{kind:'shared', id:'consultation-team'}`).
- A connection MAY declare multiple use decls of the same `(type, impl)` differing only in owner pattern — they're OR'd.
- **`agent/self` shorthand** — `owner.id` may be the literal string `"self"` for `kind:'agent'`. The host substitutes the calling agent's id. This is the common case (private per-agent memory).

### 3.3 Why this shape

- **Owner patterns mirror `services-sdk`'s `Owner` type 1:1** — same `kind` enum, same `id` string. No new vocabulary.
- **`*` is the *only* wildcard** — keeps ACL trivially auditable. Per-prefix matching (`workflow-run/case-prefix-*`) is tempting but adds parsing surface; we punt to v1.2.
- **Config travels with the decl, not with each call** — first attach uses the decl's config; subsequent attaches for the same `(type, impl)` reuse it. Agents can't sneak a different config per call (security: a misbehaving agent can't enlarge its kindList in memory:file config mid-session).

### 3.4 Failure modes

| Situation | Result |
|---|---|
| SERVICE_CALL with `(type, impl)` not declared in HELLO.services | `SERVICE_RESULT { ok: false, error: { code: 'forbidden_service' } }` |
| SERVICE_CALL with declared `(type, impl)` but owner doesn't match any pattern | `SERVICE_RESULT { ok: false, error: { code: 'forbidden_owner' } }` |
| Plugin `attach` throws at lazy-attach time | `SERVICE_RESULT { ok: false, error: { code: 'attach_failed', message } }` |
| Plugin method throws (e.g. quota exceeded) | `SERVICE_RESULT { ok: false, error: { code: 'service_error', message } }` |
| Method name not on the plugin's contract | `SERVICE_RESULT { ok: false, error: { code: 'unknown_method' } }` |

### 3.5 Non-malicious abuse — the case for soft rate limits

A misbehaving (not malicious) agent that loops `memory.recall` could
hammer the host. v1.1 ships with **no built-in rate limit** — keeping
the protocol simple. Operators who need it wire `authenticate` to a
per-key counter. v1.2 may add a server-side `service_call_quota` field
in WELCOME. Marked as open question; not blocking.

---

## 4. Wire frames (decision point #2)

### 4.1 SERVICE_CALL — client → server

```ts
{
  type: "SERVICE_CALL",
  callId: string,                  // unique per connection; client picks; opaque to server
  from: ParticipantId,             // which of this connection's agents is calling
  service: {
    type: ServiceType,             // 'memory' | 'artifact' | 'datastore' | ...
    impl: string,                  // 'file' | 'sqlite' | ...
    owner: { kind: OwnerKind, id: string }
  },
  method: string,                  // e.g. 'recall' | 'remember' | 'write' | 'sql.exec'
  args: unknown[]                  // positional, plugin-method-shaped
}
```

**Notes on `method`**:
- For top-level handle methods, use the bare name: `recall`, `remember`, `write`, `read`.
- For nested namespaces on `DatastoreHandle`, use dotted path: `sql.exec`, `sql.query`. The server resolves `handle.sql.exec(...args)` after splitting on `.`.
- Server rejects deeply-nested paths beyond 2 segments to prevent prototype-chain walking. The set of legal `method` strings per service type is hardcoded in the server's `serviceMethodAllowlist` table (see §5.3).

### 4.2 SERVICE_RESULT — server → client

```ts
{
  type: "SERVICE_RESULT",
  callId: string,                  // echo of the SERVICE_CALL.callId
  ok: true,
  value: unknown                   // method's return value, JSON-serialised
}
// OR
{
  type: "SERVICE_RESULT",
  callId: string,
  ok: false,
  error: {
    code: 'forbidden_service' | 'forbidden_owner' | 'attach_failed'
        | 'service_error' | 'unknown_method' | 'bad_args' | 'unknown_agent'
        | 'session_not_ready' | 'internal_error',
    message: string,
    context?: unknown
  }
}
```

### 4.3 HELLO extension (additive, non-breaking)

```ts
interface HelloFrame {
  type: 'HELLO'
  protocolVersion: string          // bumped to '1.1' for clients using services
  client: { name: string; version: string }
  agents: AgentDecl[]
  apiKey?: string

  // NEW (optional — v1.0 clients omit it; v1.1 servers tolerate absence)
  services?: ServiceUseDecl[]
}
```

A v1.1 server **must** accept HELLO without `services` — that's a v1.0
client. Such a session simply has zero allowed service calls; any
SERVICE_CALL it sends gets `forbidden_service`.

A v1.0 server receiving a v1.1 HELLO with `services` will reject with
`protocol_mismatch` if minor mismatch is enforced, **or** ignore the
unknown field if not. The protocol's "unknown fields are ignored
(forward compatibility)" rule from v1.0 covers this — v1.0 servers
silently drop `services`, the agent's later SERVICE_CALL frames hit
`bad_frame` ERROR (server doesn't know the type). That's the
graceful-degradation story.

### 4.4 Updates to `ClientFrame` / `ServerFrame` unions

```ts
type ClientFrame =
  | HelloFrame | ResultFrame | PublishFrame | SubscribeFrame | UnsubscribeFrame
  | PingFrame | PongFrame | GoodbyeFrame
  | ServiceCallFrame                  // NEW

type ServerFrame =
  | WelcomeFrame | RejectFrame | TaskFrame | CancelFrame | MessageFrame | ErrorFrame
  | PingFrame | PongFrame | GoodbyeFrame
  | ServiceResultFrame                // NEW
```

---

## 5. Server-side routing (§5 is implementation, not a decision point)

### 5.1 New module: `packages/transport-ws/src/service-call-router.ts`

Stateless helper that holds:

- A reference to `HubServices`.
- A reference to the `Session`'s declared `services` (validated at HELLO).
- A `handleCache: Map<string, AttachedHandle>` keyed by `${type}:${impl}:${ownerKind}/${ownerId}`.

API:

```ts
class ServiceCallRouter {
  constructor(opts: {
    services: HubServices
    declarations: readonly ServiceUseDecl[]
    sessionAgentIds: readonly ParticipantId[]
  })

  async route(call: ServiceCallFrame): Promise<ServiceResultFrame>
  async dispose(): Promise<void>  // detach all cached handles
}
```

`route` flow:

1. Verify `call.from` is in `sessionAgentIds`. Else `unknown_agent`.
2. Resolve `owner.id === 'self'` to the calling agent's id.
3. Match `call.service` against the declarations using §3.2 rules. Else `forbidden_service` / `forbidden_owner`.
4. Cache check: lookup `handleCache`. Miss → call `services.attach({type, impl, owner, config})` with the **declaration's** config. Cache the handle.
5. Resolve `call.method` via §5.3 allowlist. Forbidden → `unknown_method`.
6. Call `handle[method](...call.args)`. Catch → `service_error`.
7. Return `{ ok: true, value }`.

### 5.2 Session integration

`Session.handleHello` (after admission approval, before WELCOME):

- If HELLO has `services`, validate each decl shape (type / impl strings, owner.kind enum, owner.id string).
- Construct `ServiceCallRouter`, store on the session.
- WELCOME unchanged (the agent already knows what it declared).

`Session.onMessage` (READY state) adds:

```ts
case 'SERVICE_CALL':
  this.handleServiceCall(frame).catch(/* fatal: terminate */)
  break
```

`Session.cleanup`:

- `await router.dispose()` to detach cached handles before disconnecting.

### 5.3 `serviceMethodAllowlist`

```ts
const serviceMethodAllowlist: Record<ServiceType, readonly string[]> = {
  memory:    ['recall', 'remember', 'list', 'forget', 'clear'],
  artifact:  ['write', 'read', 'list', 'exists', 'remove'],
  datastore: ['get', 'set', 'delete', 'sql.exec', 'sql.query'],
}
```

- Methods not in this table return `unknown_method`. This bounds the attack surface.
- Third-party service types: a plugin author may register their type via the existing `@gotong/services-sdk` `ServiceRegistry`; the protocol pkg ships a helper `extendServiceMethodAllowlist(type, methods)` so the host bootstrap can extend the table at startup. Out of scope for v1.1 first cut — first-party plugins only.

### 5.4 Owner = `agent/self` lifecycle

Special case: a service declared as `{ kind:'agent', id:'self' }` SHOULD be detached when the agent unregisters (matching the in-process `LocalAgentPool` `detachFor(owner)` behaviour). Other owner kinds (`workflow-run/*`, `shared`) are detached only on session close — workflow-runs and shared owners outlive any single agent's session.

---

## 6. Lifecycle (decision point #3)

### 6.1 Three lifecycle phases

| Phase | Server action | Client action |
|---|---|---|
| **Declare** (HELLO) | Validate `services` array shape. Construct router with decls. **No `attach` yet.** | Bundle `services: [...]` into HELLO frame |
| **First call** (SERVICE_CALL) | Match ACL → lookup cache → cache miss → `services.attach({...})` lazily → cache → invoke method | Calls feel synchronous; SDK awaits SERVICE_RESULT |
| **Tear down** (GOODBYE / disconnect / agent-self leave) | `router.dispose()` iterates cache, calls `services.detachFor(owner)` for owners that should clean up (agent/self only by default; configurable) | Nothing — SDK fails any pending calls with `session_closed` |

### 6.2 Why lazy attach

Two motivations:

1. **Case-scoped owners are dynamic.** A coach agent may serve 100 cases during one session — eager-attaching all of them at HELLO is impossible (case ids unknown). Lazy attach is the only correct model.
2. **Plugin attach has side effects.** `service-memory-file` makes a dir on attach; `service-datastore-sqlite` opens a sqlite connection. Doing this work only for services the agent actually uses keeps idle agents cheap.

### 6.3 Detach policy

The default `dispose()` detaches every cached handle. This is correct
for `kind:'agent'` and `kind:'workflow-run'` owners — neither has
state the host should preserve past the session end (a future
`workflow-run` is a new run with a new id; a future `agent` is a new
HELLO that will re-attach).

For `kind:'shared'` owners, detach may be too aggressive — multiple
sessions can hold handles for the same group. **The plugin's own
`attach` cache** handles this: `service-memory-file` already keeps
its own per-owner handle. Calling `detachFor` for an owner that has
other live handles is the plugin's responsibility (current plugins
handle it; new plugins must too).

### 6.4 What happens to in-flight calls on disconnect

A SERVICE_CALL whose SERVICE_RESULT hasn't arrived when the connection
drops: SDK rejects the awaited promise with `error.code === 'session_closed'`.
The host's `dispose()` does not retry — the agent will reconnect (auto-reconnect
default `true`) and re-issue the call from its own state. This matches
how in-flight TASK frames are handled today (host fails them with
`remote_disconnect`).

---

## 7. SDK shape (decision point #4)

### 7.1 Goal: source-compat with in-process `ServiceCtx`

In-process `LlmAgent` reads services via `this.services.memory?.recall(...)`.
A WS-backed agent should read **exactly the same way**, so moving an
agent between in-process and remote is a constructor-arg change, not
a code change.

### 7.2 `connect()` extension

```ts
await connect({
  url: 'wss://hub.example.com/ws',
  agents: [new CoachAgent()],
  services: [
    // Mirror the YAML `uses:` block.
    { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
    { type: 'artifact', impl: 'file', owner: { kind: 'agent', id: 'self' },
      config: { name: 'consultation-reports' } },
    // Case-scoped memory — dynamic owner id.
    { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
  ],
})
```

The SDK:

- Validates the array shape locally.
- Bundles it into HELLO.services.
- After WELCOME, exposes the resolved ctx on `AgentParticipant.services` (an instance field). For dynamic-owner declarations, the SDK exposes a **factory** instead of a single handle (see §7.4).

### 7.3 Static-owner usage (drop-in)

```ts
class WriterAgent extends AgentParticipant {
  protected async handleTask(task: Task): Promise<unknown> {
    // Identical to in-process LlmAgent code.
    const past = await this.services.memory!.recall({ k: 5 })
    /* ... */
  }
}
```

### 7.4 Dynamic-owner usage (case-scoped)

For declarations with `owner.id === '*'`, the SDK exposes a factory:

```ts
class CoachAgent extends AgentParticipant {
  protected async handleTask(task: Task): Promise<unknown> {
    const caseId = (task.payload as { caseId?: string }).caseId
    if (caseId) {
      // The factory is namespaced by `(type, impl, ownerKind)`.
      const caseMemory = this.services.memoryFor('file', {
        kind: 'workflow-run',
        id: caseId,
      })
      const past = await caseMemory.recall({ k: 5 })
      /* ... */
    }
  }
}
```

The factory `memoryFor` (and `artifactFor`, `datastoreFor`) returns a
typed handle whose methods all forward to SERVICE_CALL frames. The
SDK cache mirrors the server cache — repeat calls for the same
`(type, impl, owner)` reuse the same handle wrapper.

### 7.5 What about `caseMemoryFor` from the current deepseek example?

It maps 1:1: the example's `CaseMemoryFor = (caseId) => Promise<MemoryHandle>`
becomes `caseId => this.services.memoryFor('file', {kind:'workflow-run', id:caseId})`.
Code that uses `recordCaseConversation` / `recallCaseConversation` from
`@gotong/host/services` works unchanged — the helpers take a
`MemoryHandle` and don't care whether it's in-process or WS-backed.

---

## 8. Backward compatibility & versioning

| Scenario | Behaviour |
|---|---|
| v1.0 client → v1.1 server | Client doesn't send `services`. Server creates a router with empty decls. SERVICE_CALL won't be sent (client doesn't know how). v1.0 behaviour preserved. |
| v1.1 client without `services` → v1.1 server | Same as above. Router has empty decls. |
| v1.1 client with `services` → v1.0 server | v1.0 server ignores unknown `services` field. Client SDK *thinks* it has services; first SERVICE_CALL fails with `bad_frame` ERROR. SDK surfaces as `error.code === 'server_too_old'`. |
| v1.1 minor bump | `PROTOCOL_VERSION = "1.1"`. Major is still 1, so existing major-version-compat checks pass. |

The version bump is **minor**, not major. v1.0 and v1.1 are
interoperable in both client/server pairings; only the new feature
(services) requires both ends to be v1.1.

---

## 9. Migration plan — industry-consultation example

| Today (in-process) | After v1.1 (WS sidecar) |
|---|---|
| `examples/industry-consultation-deepseek/src/index.ts` — `extends LlmAgent`, manual `boot.services.attach(...)`, `hub.register(...)` | Same file becomes a **sidecar** process: `import { connect } from '@gotong/sdk-node'` + `services: [...]` declarations in HELLO |
| Host glue (`withCaseContext` / `recordCaseConversation`) | Identical code — the helpers take a `MemoryHandle`, doesn't care if it's WS-backed |
| `CoachAgent extends LlmAgent` | `CoachAgent extends AgentParticipant` (the SDK's class) |
| `this.services.memory` | `this.services.memory` (same) |
| `this.caseMemoryFor(caseId)` | `this.services.memoryFor('file', {kind:'workflow-run', id:caseId})` |
| Run: `pnpm --filter @gotong/example-industry-consultation-deepseek start` (in-process with host) | Run: `pnpm --filter @gotong/example-industry-consultation-deepseek start` (sidecar — connects to `pnpm host` over `ws://`) |
| Requires host to import the example as a dep | **Host doesn't know the example exists.** The agent process declares its identity at HELLO; admin approves; tasks flow. |

This is the "external agent standardized onboarding" goal restated:
the example file barely changes (mostly imports), but **the agent now
runs as an independent process**, host has no dependency on it, and
adding a new agent type to a deployment is "start a new process and
let admin approve it" — zero `pnpm install` on the host.

---

## 10. Open questions

- **Q1: Should `services` be in HELLO or in a follow-up frame?** Pros of HELLO: atomic admission decision (admin sees what services the agent will use). Pros of follow-up: cleaner separation. **Decision: HELLO.** Admin approval covers services in one shot.
- **Q2: Per-call timeout?** Default SDK timeout 30s; configurable. Host doesn't enforce (it just runs the method). **Decision: client-side only for v1.1.**
- **Q3: Streaming results (e.g. very large `memory.list`)?** Not in v1.1; add pagination on `MemoryHandle.list` if needed. Streaming is a v2 concern.
- **Q4: Cross-session shared handles (multiple agents accessing the same `workflow-run/case-X` memory at once)?** Both sessions go through the same `HubServices.attach` path; the underlying plugin de-dupes. No protocol change needed.
- **Q5: `agent/self` substitution — what if a session declares multiple agents?** The router substitutes `self` to the `from` field of the SERVICE_CALL (the calling agent). So agent A's `self` resolves to A; agent B's `self` resolves to B in the same connection. Documented in §3.2.

---

## 11. Implementation plan & rollout

### 11.1 Order of work (single PR, multiple commits)

1. **Protocol pkg** — `frames.ts` + `codec.ts` + `constants.ts` (bump to `"1.1"`) + types tests. ~80 lines, no behavior.
2. **Server** — `service-call-router.ts` + `session.ts` integration. ~250 lines + 30 lines integration.
3. **SDK** — `services-ctx.ts` (the WS-backed handle wrappers) + `session.ts` integration + `connect()` extension. ~300 lines.
4. **Tests** — protocol roundtrip, server router unit, server+SDK end-to-end via `examples/remote-agent` extension. ~500 lines.
5. **Migrate example** — `industry-consultation-deepseek` becomes a sidecar. Diff ~400 lines (mostly renaming `boot.services.attach` → HELLO decl).
6. **Docs** — update `PROTOCOL.md` to v1.1, update `AGENT.md` services section, CHANGELOG entry.

### 11.2 What stays in-process

- `LocalAgentPool` and YAML-managed agents that don't need anything beyond v2.2 services. No change.
- The host smoke tests. No change.

### 11.3 Rollback story

If a critical bug surfaces post-merge, the v1.1 frames are
**additive**. Reverting amounts to: server returns `bad_frame` for
SERVICE_CALL, version bump rolls back to `"1.0"`, SDK falls back to
no-services agents. No data migration, no broken state on disk.

---

## 12. Sign-off checklist

- [ ] **§3 ACL Model** — owner pattern (`*` only, no prefix matching for v1.1), `agent/self` shorthand, config-at-decl-time.
- [ ] **§4 Wire frames** — SERVICE_CALL / SERVICE_RESULT shape; HELLO.services optional field; minor version bump to 1.1.
- [ ] **§5 Method allowlist** — first-party-only; extension via `extendServiceMethodAllowlist` punted to v1.2.
- [ ] **§6 Lifecycle** — lazy attach on first call; detach `agent/self` on agent leave, others on session close.
- [ ] **§7 SDK shape** — `services: [...]` in `connect()`, `this.services.memory` for static, `this.services.memoryFor(impl, owner)` for dynamic.

Sign off all five and I'll implement in the order listed in §11.1.
