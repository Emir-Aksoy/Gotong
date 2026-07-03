# @aipehub/im-adapter

Phase 12 M1 — the base SDK for AipeHub IM bridges.

This package ships **only types + one pure parser**. There's no
runtime side effect, no network code, no SQLite — those live in the
concrete bridges (`@aipehub/im-telegram`, `@aipehub/im-matrix`, …) and
in the host's wiring layer.

## What lives here

| Surface              | Purpose                                                  |
|----------------------|----------------------------------------------------------|
| `ImBridge`           | Lifecycle contract a concrete bridge implements          |
| `ImUser`             | One IM-side identity (platform + canonical user id)      |
| `ImMessage`          | One inbound message + attachments + chat metadata        |
| `ImAttachment`       | Image / audio / file (url-or-bytes; bridge picks)        |
| `ImCommand`          | Discriminated union returned by `parseImCommand`         |
| `ImBindingResolver`  | Host-supplied callback: IM identity → AipeHub user id    |
| `parseImCommand`     | Pure-function text → `ImCommand` parser                  |

## What does NOT live here

- Anything that touches `node-fetch`, websockets, the Telegram /
  Matrix / Slack SDKs — that's the concrete bridge's job.
- The `IdentityStore` itself — bridges depend on the
  `ImBindingResolver` interface; the host wires identity into it.
- Hub.dispatch routing — also a host-layer concern. The router lives
  alongside the host so it can hold the Hub handle, the agent / 
  workflow registry, and the audit logger.

This keeps the SDK platform-agnostic (a pluggable bridge can be tested
with a fake `ImBindingResolver` and a fake message source) and
testable in isolation.

## The binding flow at a glance

```
[admin UI]                                [IM bridge]
    │                                          │
    │ user clicks "Connect Telegram"           │
    ▼                                          │
issueImBindingCode(userId)                     │
    │                                          │
    │ "your code is 123456"                    │
    │                                          │
                                  user DM's    │
                                  bot:         │
                                  "/bind       │
                                   123456"     │
                                               ▼
                                  parseImCommand("/bind 123456")
                                  → { kind: 'bind', code: '123456' }
                                               │
                                               ▼
                                  resolver.claim({
                                    code, platform, platformUserId
                                  })
                                               │
                                               ▼
                                  bridge.sendMessage(user, "bound ✓")

[later — any free-text message]
    user: "what's on my list?"
        │
        ▼
  parseImCommand("what's on my list?")
  → { kind: 'free', text: "what's on my list?" }
        │
        ▼
  resolver.resolveUserId(platform, platformUserId)
  → userId
        │
        ▼
  hub.dispatch({ from: 'im:<platform>:<platformUserId>',
                 origin: { userId },
                 strategy: { ... },
                 payload: msg.text })
```

## Why a discriminated `ImCommand` and not an event emitter

A pure-function parser is testable in isolation (see
`tests/command-parser.test.ts`) and the union is exhaustive in
TypeScript — bridges that add a new built-in get compile-time nudges
to handle it. Event emitters lose both.

## Status

- Phase 12 M1 — released.
- Next: M2 — `@aipehub/im-telegram` first concrete bridge.

See `docs/zh/ledger/V4-PHASE7-13-PLAN.md` section 七 for the full Phase 12
roadmap.
