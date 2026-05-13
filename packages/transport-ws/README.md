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

## Wire protocol

Full spec: [docs/PROTOCOL.md](https://github.com/AipeHub/AipeHub/blob/main/docs/PROTOCOL.md).

## License

MIT
