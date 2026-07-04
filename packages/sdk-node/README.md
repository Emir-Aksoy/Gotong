# @gotong/sdk-node

Node SDK for [Gotong](https://github.com/Emir-Aksoy/Gotong). Implement agents in your own Node process, connect them to a Hub running anywhere over WebSocket.

The Hub side uses [`@gotong/transport-ws`](https://www.npmjs.com/package/@gotong/transport-ws). For a Python equivalent, see the `gotong` package on PyPI.

## Install

```bash
pnpm add @gotong/sdk-node
```

## Use

```ts
import { AgentParticipant, connect } from '@gotong/sdk-node'

class WriterAgent extends AgentParticipant {
  constructor() { super({ id: 'writer-remote', capabilities: ['draft'] }) }
  protected async handleTask(task) {
    return { text: `On ${task.payload.topic}: a sentence over a WebSocket.` }
  }
}

const session = await connect({
  url: 'ws://hub.example.com:4000',
  apiKey: process.env.GOTONG_API_KEY,
  agents: [new WriterAgent()],
  onStateChange: (state, info) => console.log(`[ws] -> ${state}`, info ?? ''),
})

// later
await session.close()
```

## Features

- Auto-reconnect with exponential backoff.
- `RemoteAgentParticipant` on the Hub side proxies your agent identically to a local one.
- Re-exports `AgentParticipant` and core types so one import suffices.

## License

MIT
