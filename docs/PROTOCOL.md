# AipeHub Wire Protocol v1.2

The protocol that lets remote agents connect to a Hub over the network. JSON frames over WebSocket (`ws://` or `wss://`).

This protocol is **not** what local agents use — local agents share a process with the Hub and call the `Participant` interface directly. This document is only relevant for cross-process / cross-network agents.

## Overview

- **Topology** — Hub is the server, agents are clients. Each TCP connection can host one or more agents from the same client process.
- **Versioning** — `protocolVersion` is SemVer-ish. Major must match. v0.1 of AipeHub ships protocol `1.0`; v0.4 bumps to `1.1` (services-over-ws, additive); v0.5 bumps to `1.2` (per-method ACL + third-party allowlist extension + audit transcript, all additive — v1.0 / v1.1 / v1.2 are mutually interoperable both directions).
- **Serialization** — JSON over WebSocket text frames. Each frame is a self-contained JSON object discriminated by a `type` field.
- **Concurrency** — frames can be interleaved freely on one connection. The order of TASK delivery to a single agent is preserved by the Hub; RESULT can come back in any order.

## What's new in v1.2

- `ServiceUseDecl.methods?: string[]` — optional per-decl method ACL narrowing. Declare "I only want `recall` and `list`" and SERVICE_CALL frames for `remember` come back as **`forbidden_method`** even if the type-level allowlist would let them through.
- **Third-party service-type allowlist extension** — plugins ship a `wireMethods` array; host bootstrap calls `registerServiceMethods(type, methods)` so the router can dispatch SERVICE_CALL frames for non-built-in service categories.
- New error code `forbidden_method` joins the SERVICE_RESULT error enum (the rest stays from v1.1).
- New transcript entry kind `service_call` — every resolved SERVICE_CALL appends an audit entry with `{from, type, impl, ownerKind, ownerId, method, outcome, durationMs}`. Args are deliberately omitted.

## What's new in v1.1

- `HELLO.services?: ServiceUseDecl[]` — optional field; remote agents declare which Hub Services (memory / artifact / datastore) they want to drive over this connection. Bound at HELLO time so admins reviewing applications see the full ACL picture; enforced server-side by `ServiceCallRouter`.
- `SERVICE_CALL` (client → server) + `SERVICE_RESULT` (server → client) — RPC over the same socket. The wire surface mirrors the in-process `ServiceCtx` API exactly, so an agent's `this.services.memory.recall(...)` call is identical whether the agent runs in-process or over WS.
- Wildcard owner pattern `id: '*'` and `id: 'self'` shorthand for declarations — the only ACL primitives v1.1 ships; per-prefix matching punted to v1.2.

Design rationale, ACL semantics, and migration plan: `docs/services-over-ws-rfc.md`.

## Frame envelope

Every frame is `{ "type": "<NAME>", ...fields }`. Unknown fields are ignored (forward compatibility).

## State machine

```
Client                                    Server
  CONNECTING ──── ws handshake ────►       AWAIT_HELLO
  CONNECTED ───── HELLO ──────────►        validating
  AUTH       ◄─── WELCOME ─────────        READY
                  or
             ◄─── REJECT, close ─────       DEAD
  READY                                    READY
  …normal traffic…
  CLOSING ─────── GOODBYE ────────►        CLOSING
        ◄──────── GOODBYE / close          DEAD
  CLOSED                                   DEAD
```

A connection that has not sent HELLO within 5 seconds is closed by the server.

## Frames

### `HELLO` — client → server (first frame)

Declares every agent this connection hosts.

```ts
{
  type: "HELLO",
  protocolVersion: "1.1",                      // "1.0" still accepted
  client: { name: string, version: string },  // for logs / debugging
  agents: Array<{
    id: ParticipantId,                         // must be unique within the hub
    capabilities: string[],
  }>,
  apiKey?: string,                             // optional in v0.1
  // v1.1+ — declares which Hub Services this connection may invoke via
  // SERVICE_CALL. Each entry is `{type, impl, owner: {kind, id}, config?}`.
  // `owner.id` accepts the literal `'self'` (agents only, substituted to
  // the calling agent's id server-side) and `'*'` (matches any concrete
  // id of that kind). Multiple entries with the same (type, impl) are
  // OR'd at ACL time. See docs/services-over-ws-rfc.md §3 + §4.
  services?: Array<{
    type: "memory" | "artifact" | "datastore" | string,
    impl: string,                              // e.g. "file" / "sqlite"
    owner: {
      kind: "agent" | "workflow-run" | "shared",
      id: string                               // concrete id | "self" | "*"
    },
    config?: unknown                           // plugin-defined; validated at first attach
  }>
}
```

### `WELCOME` — server → client

Sent if HELLO is accepted. Transitions both sides to `READY`.

```ts
{
  type: "WELCOME",
  sessionId: string,
  protocolVersion: "1.0",
  serverTime: number,                          // ms since epoch
  heartbeatIntervalMs: number                  // typically 30000
}
```

### `REJECT` — server → client, followed by close

```ts
{
  type: "REJECT",
  code: "auth_failed"        // apiKey rejected or returned { ok: false }
      | "forbidden_agent"    // apiKey valid but cannot register a declared id (v0.4+)
      | "duplicate_id"       // some declared id is already in the hub registry
      | "protocol_mismatch"  // major version of HELLO.protocolVersion differs
      | "bad_hello"          // HELLO malformed (e.g. empty agents array)
      | "internal_error",
  message: string
}
```

**`forbidden_agent`** (added in protocol 1.0 minor revision, v0.4 of AipeHub): the server's `authenticate` hook returned `{ ok: true, allowedAgents: [...] }` and at least one id in `HELLO.agents` was not in that allow-list. Use this to bind an API key to a fixed set of agent identities — a leaked key cannot then impersonate any other agent in the deployment. Clients should treat unknown codes as a generic auth/setup failure and surface `message` to the operator.

### `TASK` — server → client

```ts
{
  type: "TASK",
  recipient: ParticipantId,   // which of this connection's agents
  task: {                      // the core Task shape
    id, from, strategy, payload, title?, deadlineMs?, createdAt
  }
}
```

### `RESULT` — client → server

```ts
{
  type: "RESULT",
  result: {
    kind: "ok" | "failed" | "cancelled" | "no_participant",
    taskId, by, ts,
    ...kind-specific fields
  }
}
```

Late results (after CANCEL or disconnect) are silently dropped by the Hub.

### `SERVICE_CALL` — client → server (v1.1+)

Invokes one method on a Hub Service handle. The Hub matches the request against the connection's `HELLO.services` ACL, lazy-attaches the underlying service handle on first reference for a given `(type, impl, owner)` triple, and dispatches the call.

```ts
{
  type: "SERVICE_CALL",
  callId: string,                              // client-chosen; echoed in SERVICE_RESULT
  from: ParticipantId,                         // which of this connection's agents is calling
  service: {
    type: "memory" | "artifact" | "datastore" | string,
    impl: string,
    owner: { kind: "agent" | "workflow-run" | "shared", id: string }
  },
  method: string,                              // see allowlist below
  args: unknown[]                              // positional, plugin-method-shaped
}
```

**Method allowlist** (hardcoded server-side; methods outside this set return `unknown_method`):

| Service type | Allowed methods |
|---|---|
| `memory` | `recall`, `remember`, `list`, `forget`, `clear` |
| `artifact` | `write`, `read`, `list`, `exists`, `remove` |
| `datastore` | `kv.get`, `kv.set`, `kv.del`, `kv.keys`, `sql.exec`, `sql.query` |

Third-party service types are out of scope for v1.1; the table will be made extensible in v1.2 (RFC §5.3).

### `SERVICE_RESULT` — server → client (v1.1+)

Reply to one SERVICE_CALL. Discriminated on `ok`.

```ts
{
  type: "SERVICE_RESULT",
  callId: string,                              // echo of SERVICE_CALL.callId
  ok: true,
  value: unknown                               // method's return value, JSON-serialised
}
// — OR —
{
  type: "SERVICE_RESULT",
  callId: string,
  ok: false,
  error: {
    code:
      | "forbidden_service"   // (type, impl) not declared in HELLO.services
      | "forbidden_owner"     // owner doesn't match any declared pattern
      | "forbidden_method"    // method not in decl.methods narrowing (v1.2)
      | "attach_failed"       // plugin.attach threw at lazy-attach time
      | "service_error"       // method threw (validation, quota, IO)
      | "unknown_method"      // method not on the allowlist
      | "bad_args"            // call.args malformed
      | "unknown_agent"       // call.from not owned by this connection
      | "session_not_ready"   // call arrived before WELCOME / after teardown
      | "unknown_service"     // (type, impl) has no plugin host-side
      | "internal_error",
    message: string,
    context?: unknown                          // free-form (echo args / plugin hint)
  }
}
```

Pending SERVICE_CALLs on connection drop are failed by the SDK with `session_not_ready` (no in-flight RPC preservation in v1.1, same posture as TASK frames per the disconnect section).

### `CANCEL` — server → client

A previously sent TASK has been cancelled (typically because a broadcast race was lost). The agent should stop work if it's cheap. No reply is required.

```ts
{
  type: "CANCEL",
  recipient: ParticipantId,
  taskId: TaskId,
  reason: string
}
```

### `MESSAGE` — server → client

A channel message arriving for one of this connection's subscribed participants.

```ts
{
  type: "MESSAGE",
  recipient: ParticipantId,
  msg: { id, channel, from, body, ts }
}
```

### `PUBLISH` — client → server

```ts
{
  type: "PUBLISH",
  from: ParticipantId,        // must be an agent owned by this connection
  channel: ChannelId,
  body: unknown
}
```

### `SUBSCRIBE` / `UNSUBSCRIBE` — client → server

```ts
{ type: "SUBSCRIBE",   participantId: ParticipantId, channel: ChannelId }
{ type: "UNSUBSCRIBE", participantId: ParticipantId, channel: ChannelId }
```

### `PING` / `PONG` — either direction

```ts
{ type: "PING", ts: number }
{ type: "PONG", ts: number }   // echo of the PING's ts (for RTT)
```

### `GOODBYE` — either direction

Graceful close. The receiver acks with its own GOODBYE, then closes the underlying socket.

```ts
{ type: "GOODBYE", reason?: string }
```

### `ERROR` — server → client (non-fatal)

A frame the server couldn't act on, but the connection survives.

```ts
{
  type: "ERROR",
  code: string,             // e.g. "unknown_recipient", "forbidden_publish"
  message: string,
  context?: unknown
}
```

## Heartbeat

After `WELCOME`:

- The **server** sends `PING` every `heartbeatIntervalMs`.
- The **client** must reply `PONG` within `0.5 * heartbeatIntervalMs`.
- After **two** consecutive unanswered PINGs the server closes the connection.
- The client may also send PING at any time; the server replies PONG.

## Reconnect & disconnect semantics

When a connection drops, Hub-side cleanup is:

1. **Unregister** every participant the connection hosted → `participant_left` entries in the transcript.
2. **Fail in-flight tasks** routed to those participants as `TaskResult { kind: 'failed', error: 'remote_disconnect' }`.
3. **Forget the session id** — a reconnect starts a fresh session.

v0.1 does **not** preserve in-flight tasks across reconnect. The client-side SDK is expected to re-`HELLO` with the same `agents` array; the Hub re-registers them (so dispatching capability/explicit lookups keep working).

A future protocol revision may add a `RESUME` frame with the prior `sessionId` to recover in-flight state from a persisted journal. Out of scope for v0.1.

## Security (v0.1 minimum)

- TLS is the transport's job — use `wss://` in production.
- `apiKey` field in HELLO; the server is configured with a verifier callback (or a literal allow-list). If verification fails the server replies REJECT with `code: "auth_failed"`.
- No per-task authorization in v0.1. Any agent in the registry can be reached by any dispatch.
- v0.4 will replace `apiKey` with per-agent identity tokens and add per-participant ACLs.

## Error codes summary

| Code | Where | Meaning |
|---|---|---|
| `auth_failed` | REJECT | apiKey verification failed |
| `duplicate_id` | REJECT | An agent id from HELLO is already registered |
| `protocol_mismatch` | REJECT | Major version mismatch |
| `bad_hello` | REJECT | HELLO is malformed or missing required fields (incl. malformed `services` decls in v1.1) |
| `internal_error` | REJECT / ERROR / SERVICE_RESULT | Server-side bug |
| `unknown_recipient` | ERROR | RESULT / PUBLISH / SUBSCRIBE for an agent not owned by this connection |
| `forbidden_publish` | ERROR | `from` in PUBLISH is not one of this connection's agents |
| `unknown_task` | ERROR | RESULT for a task the Hub doesn't have outstanding |
| `forbidden_service` | SERVICE_RESULT (v1.1) | SERVICE_CALL `(type, impl)` not in HELLO.services |
| `forbidden_owner` | SERVICE_RESULT (v1.1) | SERVICE_CALL owner doesn't match any declared pattern |
| `unknown_method` | SERVICE_RESULT (v1.1) | Method outside the per-type allowlist |
| `attach_failed` | SERVICE_RESULT (v1.1) | Plugin's `attach` threw at lazy-attach time |
| `service_error` | SERVICE_RESULT (v1.1) | Handle method threw (validation / quota / IO) |
| `bad_args` | SERVICE_RESULT (v1.1) | SERVICE_CALL.args not an array |
| `unknown_agent` | SERVICE_RESULT (v1.1) | SERVICE_CALL.from not owned by this connection |
| `session_not_ready` | SERVICE_RESULT (v1.1) | Call before WELCOME or after teardown |
| `unknown_service` | SERVICE_RESULT (v1.1) | `(type, impl)` has no plugin registered host-side |
