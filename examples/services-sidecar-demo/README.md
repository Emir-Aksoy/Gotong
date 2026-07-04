# services-sidecar-demo

Hub Services over WebSocket, driven by **external** sidecar agents. Two agents (writer + reviewer) connect to a Hub purely over wire-protocol v1.1, declare what services they need, and share a case-scoped memory.

## Run

```bash
pnpm --filter @gotong/example-services-sidecar-demo start
```

Zero env vars — uses `MockLlmProvider` so no API key is needed.

## Scenario

```
        ┌────────────────────── this process ─────────────────────┐
        │                                                          │
        │  Hub  +  HubServices  +  ws server (:0 random port)      │
        │      ▲                  │                                 │
        │      │ SERVICE_CALL/RESULT (WebSocket)                    │
        │      ▼                                                    │
        │  sdk-node connect():                                      │
        │    ┌──────────────┐    ┌──────────────┐                   │
        │    │ WriterAgent  │    │ ReviewerAgent│                   │
        │    │ + services   │    │ + services   │                   │
        │    └──────────────┘    └──────────────┘                   │
        │                                                           │
        └───────────────────────────────────────────────────────────┘
```

Both sidecar agents co-locate in this single process for demo brevity. In production they'd be separate OS processes (or even Python, via `pip install gotong`).

## What this proves

- **No host import** required — the sidecars talk only to the WebSocket. Adding a third agent to a running Hub takes zero `pnpm install` on the host side.
- **HELLO.services declaration** drives the per-connection ACL — the server only allows the methods each agent asked for.
- **Case-scoped memory**: writer remembers a draft into the case memory; reviewer reads it back. Memory owner is `{kind:'workflow-run', id: caseId}`, so the two agents share state for that case but not across cases.
- **TS surface parity** — agent code reads `this.services.memory.remember(...)` just like an in-process `LlmAgent`. The wire-protocol shape is hidden.

Source: [`src/index.ts`](src/index.ts). Background: [`docs/SIDECAR.md`](../../docs/SIDECAR.md), [`docs/services-over-ws-rfc.md`](../../docs/services-over-ws-rfc.md).
