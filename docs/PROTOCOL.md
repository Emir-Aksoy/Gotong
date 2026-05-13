# AipeHub Wire Protocol v1.0

The protocol that lets remote agents connect to a Hub over the network. JSON frames over WebSocket (`ws://` or `wss://`).

This protocol is **not** what local agents use — local agents share a process with the Hub and call the `Participant` interface directly. This document is only relevant for cross-process / cross-network agents.

## Overview

- **Topology** — Hub is the server, agents are clients. Each TCP connection can host one or more agents from the same client process.
- **Versioning** — `protocolVersion` is SemVer-ish. Major must match. v0.1 of AipeHub ships protocol `1.0`.
- **Serialization** — JSON over WebSocket text frames. Each frame is a self-contained JSON object discriminated by a `type` field.
- **Concurrency** — frames can be interleaved freely on one connection. The order of TASK delivery to a single agent is preserved by the Hub; RESULT can come back in any order.

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
  protocolVersion: "1.0",
  client: { name: string, version: string },  // for logs / debugging
  agents: Array<{
    id: ParticipantId,                         // must be unique within the hub
    capabilities: string[],
  }>,
  apiKey?: string                              // optional in v0.1
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
| `bad_hello` | REJECT | HELLO is malformed or missing required fields |
| `internal_error` | REJECT / ERROR | Server-side bug |
| `unknown_recipient` | ERROR | RESULT / PUBLISH / SUBSCRIBE for an agent not owned by this connection |
| `forbidden_publish` | ERROR | `from` in PUBLISH is not one of this connection's agents |
| `unknown_task` | ERROR | RESULT for a task the Hub doesn't have outstanding |
