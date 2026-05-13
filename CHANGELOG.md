# Changelog

All notable changes to AipeHub are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) at the npm-package level.

The npm scope is `@aipehub/*`; the PyPI package is `aipehub`. The wire protocol has its own version (currently `1.0`) and is governed by `docs/PROTOCOL.md` — major changes to the wire protocol bump that version, independent of these package versions.

## 1.0.0 — 2026-05-12

First stable release. Public API surface frozen; SemVer applies from here on.

The 1.0 milestone covers the v0.0 → v0.7 work that already landed on `main`:

### Added — v0.0 (embeddable core)
- `@aipehub/core`: `Hub`, `MessageBus`, `Registry`, `DefaultScheduler` (explicit / capability / broadcast), append-only `Transcript`, `InMemoryStorage` + `FileStorage`, `AgentParticipant` + `HumanParticipant` base classes.
- Reference web UI in `@aipehub/web` (vanilla SPA + HTTP + SSE).

### Added — v0.1 (distributed agents)
- `@aipehub/protocol`: wire-frame types + codec (zero runtime).
- `@aipehub/transport-ws`: Hub-side WebSocket server with session state machine and heartbeat.
- `@aipehub/sdk-node`: Node SDK with auto-reconnect; `RemoteAgentParticipant` proxies remote agents.
- `examples/remote-agent`: host + worker two-process demo.
- `docs/PROTOCOL.md`: full wire spec.

### Added — v0.2 (LLM agents)
- `@aipehub/llm`: `LlmProvider` interface, `LlmAgent` base class with `buildRequest` / `parseResponse` override points, `MockLlmProvider`.
- `@aipehub/llm-anthropic`: `AnthropicProvider` (peer dep `@anthropic-ai/sdk`); default model `claude-opus-4-7`.
- `@aipehub/llm-openai`: `OpenAIProvider` (peer dep `openai`); uses `max_completion_tokens`.
- `examples/llm-mock`, `examples/llm-real`.

### Added — v0.3 (SQLite storage)
- `@aipehub/core/SqliteStorage`: durable transcript persistence via `better-sqlite3` (optional peer dep). WAL mode, indexed by `seq`. `FileStorage` remains the zero-dep default.
- `examples/persist-and-resume` gains a `--sqlite` flag.

### Added — v0.4 (per-agent identity)
- `authenticate` hook in `@aipehub/transport-ws` accepts a richer return type: `boolean | { ok: true, allowedAgents?: string[] | '*' } | { ok: false, reason?: string }`. Binds an API key to a fixed set of agent ids.
- New `forbidden_agent` REJECT code in the wire protocol (additive, minor revision).
- Back-compat: returning `true` / `false` from `authenticate` works exactly as in v0.1.

### Added — v0.5 (Python SDK)
- `python-sdk/` (PyPI name: `aipehub`) — second language client. `AgentParticipant` + `connect()` mirror the Node SDK; `handle_task` can be sync or async.
- `examples/remote-python`: Node host + Python worker connected over the same wire protocol.

### Added — v0.6 (CLI human adapter)
- `examples/cli-human`: terminal driving a `HumanParticipant` via `node:readline/promises`. Reference pattern for any UI / chat / IM adapter. `AIPE_AUTO=1` skips the prompt for CI / non-TTY.

### Added — v0.7 (advanced scheduling)
- `@aipehub/core/PriorityQueueScheduler`: wraps any inner scheduler with a global priority queue (`(priority desc, createdAt asc)`), bounded concurrency, and deadline enforcement.
- `Task.priority?: number` added to the wire type (default 0; ignored by `DefaultScheduler`).
- `Task.deadlineMs` actively enforced: tasks past deadline at submit OR while queued resolve as `failed` with `error: 'deadline_expired' | 'deadline_expired_while_queued'`.

### Tests
- TypeScript workspace: 96 passed, 2 skipped (live LLM API integration — skipped without env vars).
- Python SDK: 10 passed.
- Total: 106 + 2 skipped.

### Wire protocol — 1.0
Unchanged from v0.1 except for the additive `forbidden_agent` REJECT code in v0.4. Backward-compatible.

---

[1.0.0]: https://github.com/AipeHub/AipeHub/releases/tag/v1.0.0
