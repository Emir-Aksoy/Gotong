# remote-agent

Two-process demo: a Hub running in one Node process talks to an agent running in another, both on the same machine, over the v1.x wire protocol.

## Run

```bash
pnpm demo:remote
```

`src/index.ts` is a launcher that spawns both children. To drive each side from its own terminal, skip the launcher:

```bash
# Terminal 1 — start the Hub on ws://127.0.0.1:4001
pnpm --filter @aipehub/example-remote-agent host

# Terminal 2 — connect the worker
pnpm --filter @aipehub/example-remote-agent worker
```

## Scenario

The host (`src/host.ts`) boots a Hub + WebSocket transport on a fixed port. The worker (`src/worker.ts`) implements `AgentParticipant.handleTask` and calls `connect({ url, agents })`. After admission the host dispatches a few tasks by capability; results stream back over the same WebSocket. Both sides shut down cleanly on Ctrl-C.

## What this proves

- **Same `Participant` contract** for remote agents as for in-process ones — no code change beyond `connect()` and the constructor.
- **Hub-side**: `serveWebSocket(hub, { port })` is the only line that differs from an in-process setup.
- **Wire protocol** ([`docs/PROTOCOL.md`](../../docs/PROTOCOL.md)): HELLO/WELCOME handshake, TASK/TASK_RESULT frames, heartbeat.

For the cross-language equivalent (Node host + Python worker) see [`../remote-python`](../remote-python). For sidecars that use Hub Services see [`../services-sidecar-demo`](../services-sidecar-demo).

Source: [`src/index.ts`](src/index.ts), [`src/host.ts`](src/host.ts), [`src/worker.ts`](src/worker.ts).
