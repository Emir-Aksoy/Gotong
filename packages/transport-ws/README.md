# @aipehub/transport-ws

Hub-side WebSocket transport for [AipeHub](https://github.com/AipeHub/AipeHub). Lets remote agents — running in another Node process, on another machine, or written in another language (Python via `aipehub`, more SDKs coming) — register into the same Hub as local in-process agents.

## Install

```bash
pnpm add @aipehub/transport-ws
```

## Use

```ts
import { Hub } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'

const hub = new Hub()
await hub.start()

const ws = await serveWebSocket(hub, {
  port: 4000,
  authenticate: (apiKey) => apiKey === process.env.AIPE_API_KEY,
})
// hub.dispatch(...) just works — remote agents look identical to local ones
// await ws.close() to shut down gracefully
```

### Per-agent identity (v0.4+)

Bind an API key to a fixed set of agent ids — a leaked key can't impersonate any other agent:

```ts
await serveWebSocket(hub, {
  port: 4000,
  authenticate: (apiKey) => {
    if (apiKey === 'key-writer') return { ok: true, allowedAgents: ['writer'] }
    if (apiKey === 'key-admin')  return { ok: true, allowedAgents: '*' }
    return { ok: false, reason: 'unknown key' }
  },
})
```

### Admin-approval gating (v1.1+)

Hold every connecting agent in a pending queue until an admin approves it. Combine with `@aipehub/web`'s admin console for an interactive approval surface.

```ts
await serveWebSocket(hub, { port: 4000, gating: 'admin-approval' })
// elsewhere — driven from the admin UI or a script:
//   hub.pendingApplications() -> [{ id, agents, meta, pendingSince }, ...]
//   hub.approveApplication(applicationId, 'admin')
//   hub.rejectApplication(applicationId, 'no thanks', 'admin')
```

Session state machine grows one extra state: `AWAIT_HELLO → AWAIT_APPROVAL → READY → CLOSING → DEAD`. The wire protocol stays at `1.0` — gating is server-side; `REJECT auth_failed` carries the rejection reason from the admin verbatim. If the client disconnects mid-wait, the application is rolled back as `agent_rejected · client_disconnected` and the decision promise resolves with `{ approved: false }`.

Default is `gating: 'open'`, the pre-v1.1 behaviour.

## Wire protocol

Full spec: [docs/PROTOCOL.md](https://github.com/AipeHub/AipeHub/blob/main/docs/PROTOCOL.md).

## License

MIT
