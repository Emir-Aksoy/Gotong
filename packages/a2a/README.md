# @aipehub/a2a

Agent2Agent (A2A) interop primitives for AipeHub — the **blocking
`message/send`** subset of [A2A 0.2.5](https://a2a-protocol.org), shared by
both directions of a federation edge:

- **inbound** — the host's A2A server parses an `A2ARequest`, dispatches it into
  the local Hub by capability, and replies with an `A2AMessage`.
- **outbound** — `A2aRemoteParticipant` (added in C-M4) builds an `A2ARequest`,
  POSTs it with `a2aSend`, and reads the reply back as a task result.

## Scope (deliberately small)

Only blocking `message/send` + the `AgentSkill` subset the agent card
advertises. **Out of scope:** streaming (`message/stream`), task lifecycle
(`tasks/get`), push notifications. The host's agent card capability flags are
all `false` to stay honest about that.

## `a2aSend`

```ts
import { a2aSend } from '@aipehub/a2a'

const reply = await a2aSend('https://hub.example.com/a2a', token, 'hello', {
  peerId: 'my-hub',        // AipeHub→AipeHub: adds X-Aipe-Peer-Id
  fetchImpl: myFetch,      // inject for tests / non-global fetch
})
```

Throws `A2aClientError` (with a `.code` = JSON-RPC or HTTP status) on a
transport error, non-2xx, non-JSON body, or a JSON-RPC error result.

## Why a separate package

Same rationale as `@aipehub/inbox`: a tiny, focused contract that both the host
(server side) and the participant (client side) depend on, without either
reaching into the other.
