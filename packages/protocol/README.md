# @aipehub/protocol

Wire-protocol types and JSON codec for [AipeHub](https://github.com/Emir-Aksoy/AipeHub). Zero runtime — everything here is `interface`s and tiny `encode` / `decode` helpers.

If you're building a Hub-side transport or a non-Node SDK in TypeScript, this is the package to depend on. The full spec lives in [docs/PROTOCOL.md](https://github.com/Emir-Aksoy/AipeHub/blob/main/docs/PROTOCOL.md).

## Install

```bash
pnpm add @aipehub/protocol
```

## Use

```ts
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type ServerFrame,
} from '@aipehub/protocol'

const hello: ClientFrame = {
  type: 'HELLO',
  protocolVersion: PROTOCOL_VERSION,
  client: { name: 'my-agent', version: '1.0.0' },
  agents: [{ id: 'a1', capabilities: ['draft'] }],
}

const wire = encodeFrame(hello)            // JSON string for the WebSocket
const r = decodeFrame(wire)                // discriminated DecodeResult
if (r.ok) handle(r.frame as ServerFrame)
```

## Frame types

`HelloFrame`, `WelcomeFrame`, `RejectFrame`, `TaskFrame`, `ResultFrame`, `CancelFrame`, `MessageFrame`, `PublishFrame`, `SubscribeFrame`, `UnsubscribeFrame`, `PingFrame`, `PongFrame`, `GoodbyeFrame`, `ErrorFrame` — all keyed by their `type` literal, with `ClientFrame` and `ServerFrame` discriminated unions.

## License

MIT
