# AipeHub v1.x – v2.x changelog (archive)

> The pre-v3 release history. Split out in v3.2 to keep the main
> `CHANGELOG.md` focused on the current major. Nothing here has been
> edited from its original form — entries are reproduced verbatim from
> the original single-file changelog.

---

## 2.0.0 — 2026-05-12 — File-first

The hub is now a *directory* on disk. Drop the directory, drop the space. Copy it, copy the space. No process- or browser-resident state to lose.

### Breaking

- `new Hub()` with no arguments **throws**. Pass either `space: Space` (production) or `storage: Storage` (advanced). For tests, use the new `Hub.inMemory()` static helper.
- `serveWeb(hub, opts)` now requires `hub.space` to be set. The previous `adminToken` option is gone — admin identity is read from `<space>/admins.json` instead. Mint admins via `Space.init(...)` or `space.createAdmin(displayName)`.
- The browser SPA no longer reads or writes `localStorage` / `sessionStorage`. Worker identity is recovered every load from `GET /api/whoami` (which checks the HttpOnly cookie against `<space>/workers.json`). Language preference is non-persistent per-tab; the default comes from `<space>/config.json#defaultLang`.

### Added — Space

- New `Space` class in `@aipehub/core` — the on-disk truth of a workspace:
  - `space.json` — name, description, createdAt, version
  - `config.json` — host, ports, heartbeat, gating, defaultLang
  - `admins.json` — multi-admin list with `tokenHash` (SHA-256), `displayName`, `createdAt`
  - `agents.json` — known agent allowlist with optional `apiKeyHash` + `lastSeen`
  - `workers.json` — known worker accounts with `tokenHash` + `lastSeen`
  - `transcript.jsonl` — the Hub's append-only log (existing `FileStorage`)
  - `runtime/pending-apps.json` — current pending agent admissions, cleared on hub start
  - `runtime/admin-sessions.json`, `runtime/worker-sessions.json` — HttpOnly-cookie session table, survives hub restarts → no one gets logged out
- `Space.init(dir, opts)`, `Space.open(dir)`, `Space.openOrInit(dir, opts)`.
- `space.createAdmin / createWorker` mint a fresh token, hash it with SHA-256, return the plaintext once.
- `space.verifyAdminToken / verifyWorkerToken` perform constant-time hash comparison.
- Atomic writes (`tmp` file + rename) so a power-cut never leaves a torn config.

### Added — task model

- `hub.tasks()` returns a `TaskView[]` aggregated from the transcript — every task ever dispatched, with derived `status: 'pending' | 'done' | 'failed' | 'cancelled'`, attached `result`, and attached `evaluations`.
- `hub.retry(taskId, by?)` re-dispatches a finished task as a fresh one with `payload.retryOf` lineage. Throws if the task is still pending.

### Added — web

- `/admin` console grew a **task panel** with filters (all / in flight / done / failed) and a **Retry** button on failed / cancelled rows; click any short task id to populate the evaluation form.
- Multi-admin support throughout: `<space>/admins.json` can hold many entries; `transcript.task.from` / `agent_approved.by` etc. record the actual admin id.
- New **on-disk roster** card on the admin page that surfaces persisted admins + workers even when they aren't currently online.
- New API: `POST /api/admin/tasks/:id/retry`.

### Internal

- `Hub.inMemory(config?)` static helper for tests and in-process examples.
- `serveWeb` Web server cleanly mounts atop `hub.space` — admin / worker auth, sessions, dispatch, retry, evaluate all read & write through Space.

### Changed

- All existing examples now declare their persistence strategy. `web-demo` and `open-space` use `Space.openOrInit('.aipehub-…')`; in-process demos (hello-collab, broadcast-claim, llm-mock, llm-real, cli-human, remote-{agent,python}/host) use `Hub.inMemory()`.

### Stats

- **139 passed + 2 skipped** (was 130 + 2). Core grew from 57 → 76 via the new Space (13) and tasks (6) suites.

## 1.1.0 — 2026-05-12 — Open Space

Turns the embeddable hub into an actual collaborative space with three role-distinct entry points (admin / worker / agent), admin-gated agent admission, and a split web UI.

### Added — admission gating
- `@aipehub/core`: new `hub.requestAdmission(...)`, `hub.pendingApplications()`, `hub.approveApplication(...)`, `hub.rejectApplication(...)` API. A pending application can carry multiple agents and is decided atomically.
- `PendingApplication` / `AdmissionDecision` types exported.
- Four new `TranscriptEntry` kinds — `agent_pending`, `agent_approved`, `agent_rejected`, `evaluation` — all append-only.
- `@aipehub/transport-ws`: new `gating?: 'open' | 'admin-approval'` option. With `'admin-approval'` the HELLO causes the session to enter an `AWAIT_APPROVAL` state. WELCOME is sent only after `hub.approveApplication(...)` resolves; a `hub.rejectApplication(...)` triggers `REJECT auth_failed` with the supplied reason. Client disconnect during await rolls back the application as `agent_rejected · client_disconnected`. Default remains `'open'` — pre-v1.1 behaviour is unchanged.

### Added — evaluation
- `hub.evaluate({ taskId, by, rating?, comment? })` records a reviewer's verdict on a completed task as an append-only transcript entry. No state mutation; cross-reference is the caller's responsibility.

### Added — web admin / worker split
- `@aipehub/web`: served pages now split into `/` (worker view) and `/admin` (admin console). Admin auth is gated by an `adminToken` option (or `AIPE_ADMIN_TOKEN`); first visit with `?token=…` mints an HttpOnly cookie, later requests reuse it. `Authorization: Bearer …` also accepted.
- New admin API: `GET /api/admin/applications`, `POST /api/admin/applications/:id/(approve|reject)`, `POST /api/admin/dispatch`, `POST /api/admin/evaluate`, `POST /api/admin/logout`. All require admin auth.
- New public API: `GET /api/whoami`, `POST /api/workers` (join as a `HumanParticipant`), `DELETE /api/workers/:id` (leave).
- Worker UI: join form (nickname + capabilities), my-tasks inbox filtered to the joined identity, transcript browser. `localStorage` remembers the chosen language and `sessionStorage` remembers the joined identity across refreshes.
- Admin UI: pending-admissions banner with approve / reject buttons + reason field, dispatch panel covering all three strategies (explicit / capability / broadcast) with priority + JSON payload, evaluation panel with click-to-fill task IDs from the transcript.
- Both UIs share `app-core.js` (i18n + SSE + summary); the existing zh / en toggle is extended with the v1.1 vocabulary (admin/worker/admission/evaluation).

### Added — examples
- `examples/open-space`: end-to-end Open Space demo. `pnpm demo:open-space` spawns a host (Hub + WS gating + Web with admin token) + a remote writer agent that lands in pending state. Open `/admin?token=letmein` to approve, open `/` to join as a worker. Manually verified pending → approve → dispatch → evaluate.

### Added — script
- `pnpm test:python` runs `python-sdk` pytest; `pnpm test:all` chains `pnpm -r test` → `pnpm -r typecheck` → `pnpm test:python` for a single one-shot pre-commit check.

### Changed
- `examples/web-demo` no longer pre-registers a `HumanParticipant`. The loop now waits for a human with capability `approve` to join through the web UI before dispatching.
- All existing examples' `describe(TranscriptEntry)` helpers extended to exhaustively cover the four new transcript kinds.

### Notes
- Wire protocol stays at `1.0` — gating is server-side state, not new frames. Pre-v1.1 clients still connect to a non-gated hub with no change in behaviour.

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

[3.0.0]: https://github.com/Emir-Aksoy/AipeHub/releases/tag/v3.0.0
[2.0.0]: https://github.com/Emir-Aksoy/AipeHub/releases/tag/v2.0.0
[1.1.0]: https://github.com/Emir-Aksoy/AipeHub/releases/tag/v1.1.0
[1.0.0]: https://github.com/Emir-Aksoy/AipeHub/releases/tag/v1.0.0
