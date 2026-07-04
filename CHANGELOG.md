# Changelog

All notable changes to Gotong are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) at the npm-package level.

The npm scope is `@gotong/*`; the PyPI package is `gotong`. The wire protocol has its own version (currently `1.2`) and is governed by `docs/PROTOCOL.md` — major changes to the wire protocol bump that version, independent of these package versions.

## 3.2.0 — 2026-06-08 — Federation, identity, and the member workbench

The first tagged release since 3.1.0. It folds in months of work spanning three generations of internal planning — v4 Phases 1–19, v5 Streams 0–H2/H2-OUT, and the v6 "Route B" hardening pass. This entry captures the headline themes; the milestone-by-milestone record lives in [`CLAUDE.md`](CLAUDE.md) and the per-phase finals under [`docs/zh/`](docs/zh/) (`V4-PHASE*`, `V5-*-FINAL`, `FEDERATION-RUNBOOK`).

Distribution stays **Docker + source-only**; a JS registry (JSR), PyPI, and public binary downloads are gated on the repo going public (see [`.github/RELEASE-CHECKLIST.md`](.github/RELEASE-CHECKLIST.md)). **No backward-compatibility guarantees** across this release — the project is pre-1.0 internally and changed schemas freely; pin a commit if you need stability.

### Added

- **Cross-organization federation** — peer capability manifests (`peer.manifest`), per-link trust contracts (inbound ACL, outbound capability allowlist, per-link quotas, data-class gating, revocation), and cross-hub workflow orchestration through an outbound approval gate. A2A (Agent2Agent) interop: inbound `message/send` → dispatch, outbound `A2aRemoteParticipant`, and a task lifecycle for long-running steps.
- **Identity & SSO** — OIDC and SAML 2.0 single sign-on, TOTP MFA, resource-level RBAC (`resource_grants`: viewer/editor/owner over workflows, agents, credentials), and per-user bring-your-own API keys.
- **Member workbench (`/me`)** — the "my AI desktop": self-serve agent creation, run history, member uploads, and a human-in-the-loop inbox (approval / choice / edit steps) via `@gotong/inbox`.
- **Workflow lifecycle & governance** — a draft→review→published→deprecated→archived state machine with immutable revisions (runs pin their revision, eliminating drift), import/publish structural hard-gates, a `governance` metadata block, and an AI workflow-authoring assistant.
- **Usage & cost ledger** — per-call `usage_ledger`, a host pricing table, token/cost budgets with fail-closed quota peeks, and CSV/JSONL audit + ledger export.
- **Outbound coding-agent adapters** — drive Claude Code / Codex / Aider from the hub: `@gotong/cli-agent` (one-shot shell-out) and `@gotong/acp-agent` (long-lived ACP session, OpenClaw-style), both with a dangerous-action gate that escalates to the `/me` inbox.
- **Control plane** — opt-in, counts-only peer summaries with history trends, alert rules, and multi-channel alert delivery (webhook / IM / email); privacy-preserving by construction (no raw rows cross the wire).
- **Entry points** — Telegram / Matrix / Lark / Discord / Slack / QQ IM bridges, an `gotong repl` interactive shell, a PWA app-shell with a mobile-responsive admin UI, and end-to-end LLM streaming + multimodal content blocks (image / audio / file_ref).
- **Heartbeat / proactive autonomy** — agents can wake themselves on a fixed interval to run a checklist, reusing the suspend/resume engine with zero new tables or timers.
- **Hands-on hub templates** — eight ready-to-load `gotong.template/v1` examples (personal coding / research / growth hubs; café-ops, warband-club, tea-supply-link, tea-chain-HQ organizations) on a loadable template system that ships structure + references but never knowledge content.

### Security

This release also rolls in the **v3.4 audit-hardening batch** held back from 3.1.0 (`claude/audit-v3.3-batch*`) — self-contained groups of high-severity (`H<n>`) / critical (`C<n>`) findings, plus a later full audit pass (six parallel review lines + high-risk re-verification) folded into the codebase:

- **Batch 1.5** (H7 + H12 + H22) — defence-in-depth pairs for PR #23: workspace symlink + uid-ownership refusal at `Space.init` / `Space.open`; bearer-token leak through error responses; admission-flow logger redaction.
- **Batch 1.6** (H18 + H19 + H21) — web-server hygiene: stop leaking handler errors via `res.end()`, bound `RateLimiter.hits` Map under IP rotation, plug cookie-sid lookup back into the limiter.
- **Batch 2** (C2 + C3 + H10) — SDK TLS surface: forbid plaintext over `wss://`, require explicit opt-in for self-signed cert acceptance, surface TLS errors instead of swallowing them.
- **Batch 3** (H1 + H3 + H4) — workflow resolver prototype-pollution close + MCP admin Bearer token redaction in stderr + MCP tool-error redaction.
- **Batch 4** (H2 + H8 + H9) — SQLite per-agent quota + SDK call-id collision guard + SDK task-handle GC.
- **Batch 5** (H5 + H11 + H13) — retry-budget redaction in logs + reject-reason redaction + dev-knob (`GOTONG_DEBUG_*`) hygiene in production.
- **Batch 6** (H14 + H15) — protocol strict-mode max-depth + closed-mode rejection paths for unknown verbs.

### Fixed

- **Batch 7a** (H16) — core test `mkdtemp` race cleanup: the metrics test could fail on a slow file system because the temp-dir cleanup ran while `Hub.stop()` was still flushing the transcript.
- **Batch 7b** (H17) — web CSRF + cookie branch coverage: explicit tests for the missing-cookie / mismatched-token / origin-header paths so future refactors can't regress them silently.

### Notes

- Adds 20 new TypeScript test files + 3 Python SDK test files. Total suite is now 109 TS test files (was 89 at 3.1.0) and 57 python-sdk tests.
- No package version bump in this entry — these are tightenings of already-shipped surfaces, not new APIs.

## 3.1.0 — 2026-05-20 — Trial-ready: binary, observability, MCP tools, hardening

The first release after v3.0. Folds in three months of operability work, an MCP client toolkit, an LLM agent tool-use loop, and the v3.4 audit's launch-readiness batch — packaged so an operator can curl a binary or `docker compose up` and have a working hub in under a minute.

Headline themes:
- **Frictionless install** — single-file `bun --compile` binary (no Node required) and a top-level `docker-compose.yml` (no manual `docker run` flags).
- **Observability you can ship to ops** — Prometheus alert rules, Grafana dashboard, structured HTTP response-class counter, service-call latency histogram with p50/p95/p99 buckets.
- **Tools-using agents** — `LlmAgent` now drives `LlmAgentToolset` natively; `@gotong/mcp-client` plugs any MCP server (filesystem, GitHub, Postgres, …) straight into an agent via `tools:`; workflow templates declare `mcpServers:` so a YAML file is all the operator needs.
- **Audit-1 hardening** — WS upgrade input validation, workspace file permissions, admin link off stdout, supply-chain hardening (SHA-pinned actions + harden-runner audit), CVE fixes (vite/esbuild via vitest 3 bump).
- **Operations runbooks** — backup/restore/verify shell scripts with documented drill, load-test harness with pre-launch baseline report.

### Added

- **Single-file binary** (`bun build --compile`) per-platform: `gotong-host-{darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64.exe}`. Install becomes `curl + chmod +x + run`. ~60 MB per arch. (Earlier dev-cycle commit; first release with a tag.)
- **`docker-compose.yml`** at repo root — `docker compose up` boots the hub with the published image, a named volume for `/data`, sensible `GOTONG_*` defaults, and ports 3000/4000 exposed.
- **`@gotong/mcp-client`** (#37) — MCP client toolkit (`McpToolset`) that connects to one or many stdio MCP servers, exposes their tools as a single `LlmAgentToolset`, and surfaces tool-call results back as `LlmToolResultBlock`s. Includes structured `server-stderr` event (#39) so operators can ingest MCP-server logs through the host's logger.
- **`LlmAgent.tools` + `maxToolRounds`** (#38) — built-in multi-turn tool-use loop. Drop an `LlmAgentToolset` in `LlmAgentOptions` and the agent will tool-call → result → re-prompt until the model emits `end_turn` (capped by `maxToolRounds`, default 8). Anthropic + OpenAI providers translate the neutral `tool_use` / `tool_result` shape natively. Out-of-band toolsets work too — `McpToolset` is a drop-in but not a dependency of `@gotong/llm`.
- **`workflow.yaml mcpServers:`** (#40) — declarative MCP wiring for templated agents. Spawning resolves `${ENV_VAR}` references from the host environment so credentials never live in the manifest. `templates/agents/repo-reader.yaml` demoes the filesystem MCP server end-to-end.
- **Service-call latency histogram + HTTP response-class counter** (#41) — `gotong_service_call_duration_ms_bucket{type, impl, le}` (10 buckets, 5ms…5000ms) feeds the p50/p95/p99 panels in the Grafana dashboard. `gotong_http_responses_total{class}` (`2xx/3xx/4xx/5xx/other`) gives uptime monitors a single low-cardinality series to alert on.
- **Prometheus alerts + Grafana dashboard + monitoring runbook** (#36) — `monitoring/prometheus/gotong.alerts.yml`, `monitoring/grafana/gotong-overview.json`, and `docs/MONITORING.md`. Covers WS auth-failure rate, tail-latency spikes, hub stop/restart loops, and process-RSS growth.
- **Load-test harness** (`examples/loadtest/`, passed through #36 squash) — in-process and over-WS scenarios with shared scenario kit, plus a pre-launch baseline report under `examples/loadtest/runs/`.
- **Backup playbook** (`scripts/backup/`, passed through #36 squash) — `backup.sh`, `restore.sh`, `verify.sh`, `prune.sh` + a documented disaster-recovery drill in `docs/OPERATIONS.md`.

### Changed

- **`LlmMessage.content`** widened from `string` to `string | LlmContentBlock[]` to carry `tool_use` / `tool_result` blocks. Existing string-only callers are unaffected; the providers narrow back at the wire boundary.
- **`vitest` 2.x → 3.2.4** (#33) — and `vite` / `esbuild` overrides to clear two transitive CVEs flagged by `pnpm audit`.

### Security

- **Supply-chain hardening** — all third-party actions in `.github/workflows/*.yml` SHA-pinned (40-char hex + `# vX.Y.Z` for humans); `step-security/harden-runner` in audit mode records every job's egress so we can graduate to block once we know the legitimate endpoints. Dependabot's `github-actions` ecosystem keeps the pins moving.
- **WS upgrade hardening** (#23) — input validation on the upgrade path closes a malformed-header → process-crash trail.
- **Workspace file permissions** (#23) — newly written transcripts and `space/` files land with `0600` (owner-only), not `0644`.
- **Admin link off stdout** (#23) — first-run admin URL no longer leaks into operator logs; `docs/OPERATIONS.md` documents the new retrieval flow.

### Fixed

- **Dockerfile build stage** — added `packages/mcp-client/package.json` to the per-package COPY list so `pnpm install` picks up `@modelcontextprotocol/sdk` before `tsc` runs. (Without this, the production image build broke at the typecheck step.)
- **Counter monotonicity** — `gotong_service_call_duration_ms_sum` clamps negative `durationMs` (clock-skew artifacts) at zero so `rate()` queries don't decrease.
- **Test report annotations** — JUnit publication step gracefully tolerates Test report failures so CI's `CI passed` summary tracks the underlying jobs.

### Notes

- Binary excludes the SQLite-backed datastore (`better-sqlite3` native binding can't be embedded). Operators who need it stay on the npm or docker install paths — both keep full plugin support.
- `packages/web/package.json` adds `scripts/` to `files`, so the published npm tarball ships the asset generator alongside the source. `prepack` runs it before `tsc`.
- v3.1, v3.2 (post-v3.0 audit + cleanup sweep), and v3.3 (supply-chain hardening on CI/Release workflows) shipped on `main` without a release cut. Their changes are folded into this 3.1.0 entry rather than retro-tagged.

### Package versions

| Package | Old | New |
|---|---|---|
| `@gotong/core` | 3.0.0 | **3.1.0** |
| `@gotong/host` | 3.0.0 | **3.1.0** |
| `@gotong/llm` | 3.0.0 | **3.1.0** |
| `@gotong/llm-anthropic` | 3.0.0 | **3.1.0** |
| `@gotong/llm-openai` | 3.0.0 | **3.1.0** |
| `@gotong/protocol` | 3.0.0 | **3.1.0** |
| `@gotong/sdk-node` | 3.0.0 | **3.1.0** |
| `@gotong/transport-ws` | 3.0.0 | **3.1.0** |
| `@gotong/web` | 3.0.0 | **3.1.0** |
| `@gotong/workflow` | 1.0.0 | **1.1.0** |
| `@gotong/mcp-client` | 0.1.0 | **0.2.0** *(new package in this cycle)* |
| `@gotong/cli` | 1.0.0 | 1.0.0 *(unchanged)* |
| `@gotong/mcp-server` | 1.0.0 | 1.0.0 *(unchanged)* |
| `@gotong/services-sdk` | 1.0.0 | 1.0.0 *(unchanged)* |
| `@gotong/service-memory-file` | 1.0.0 | 1.0.0 *(unchanged)* |
| `@gotong/service-artifact-file` | 1.0.0 | 1.0.0 *(unchanged)* |
| `@gotong/service-datastore-sqlite` | 1.0.0 | 1.0.0 *(unchanged)* |

## 3.0.0 — 2026-05-17 — Services

The "agents as first-class infrastructure" release. v3.0 cuts the
fifteen-entry backlog accumulated since v2.0 (File-first, 2026-05-12)
into a single coherent cycle: agents now have per-agent state (Hub
Services with plugin-from-day-1 design), wire-level observability +
per-method ACL (protocol v1.2), a workflow engine, encrypted API-key
management, a public template library, contribution scoring, a clean
external-developer sidecar path with its own CLI, and public-internet
deployment hardening. Python SDK reaches feature parity with the
TypeScript host SDK over the same wire protocol.

The fifteen `## 3.0.0 dev journal — …` sections immediately below
this entry are the per-feature trail of how the release was assembled
— kept verbatim for audit. Read them when you want the exact tests,
file paths, and design reasoning; read this section when you want the
summary.

### Breaking

- **`peerDependencies` majors** — consumer projects must align before
  upgrading:
  - `@gotong/llm-openai`: `openai` `^4.104` → `^6.38` (two majors)
  - `@gotong/llm-anthropic`: `@anthropic-ai/sdk` `^0.32` → `^0.96`
    (large pre-1.0 jump; captures Managed Agents + webhooks + zod-v4
    typings)
  - `@gotong/mcp-server`: `zod` `^3.25` → `^4.4`
- **Wire protocol v1.2 narrowing is enforced.** A client declaring
  `ServiceUseDecl.methods: [...]` will see `forbidden_method`
  (new error code) for SERVICE_CALL frames outside that list, even
  if the type-level allowlist would permit them. Clients that don't
  declare `methods` are unaffected; v1.1 servers stay reachable.
- **TranscriptEntry gains a `'service_call'` discriminated variant.**
  Exhaustive `switch (entry.kind)` consumers need a new case.

### Added — wire protocol (v1.0 → v1.2)

- **v1.1 — services over WebSocket.** `SERVICE_CALL` /
  `SERVICE_RESULT` frames; `HELLO.services?: ServiceUseDecl[]`
  declaration; owner patterns (`'self'` / `'*'` / `'<literal>'`);
  hard-coded built-in method allowlist (`memory.*`, `artifact.*`,
  `datastore.*`); ten error codes; 30s default client timeout.
- **v1.2 — observability + DevX + per-method ACL.**
  `registerServiceMethods(type, methods)` lets third-party plugins
  extend the allowlist at host bootstrap. `ServiceUseDecl.methods`
  optional ACL narrowing per connection. `ServicePlugin.wireMethods`
  on the plugin contract. Plus `PROTOCOL_VERSION = '1.2'` advertised
  in WELCOME + the new `gotong_protocol_version` metric.

### Added — Hub Services (per-agent state, plugin-from-day-1)

- **`@gotong/services-sdk`** — `ServicePlugin` contract + registry
  + loader. The seam plugin authors implement.
- **First-party plugins**:
  - `@gotong/service-memory-file` — episodic / semantic / working
    memory as JSONL on disk
  - `@gotong/service-artifact-file` — per-owner directories with
    MIME + size guards
  - `@gotong/service-datastore-sqlite` — KV + raw SQL on one
    `.sqlite` per declared name
- **Yaml `uses:` schema** — agents declare `{type, impl, config}`
  triples; host resolves at spawn time, agent reads from
  `ctx.memory` / `ctx.artifact` / `ctx.datastore.<name>`.
- **Owner-based isolation** by default — two agents asking for
  `memory:file` get two different stores. Data layout under
  `<space>/services/`.
- **Soft delete** — admin "Services" tab; data moves to per-plugin
  `.trash/`, lives 30 days, then a background sweeper hard-deletes.
  Restore via single POST until then.

### Added — npm features (v2.1 → v2.3)

- **Workflow engine** (v2.1). New `@gotong/workflow` package: YAML
  workflows, file-first runtime state, Hub stays a dumb dispatcher.
- **Managed agents + encrypted API keys** (v2.1). UI form / paste /
  file-upload import paths; per-agent → workspace → env-var key
  cascade; AES at rest in `<space>/secrets.enc.json`.
- **Public template library** (v2.1). 12 project-original agent
  templates + 11 community-adapted (CC0 + MIT) + 7 team bundles.
  Source / license / adapted-date headers on each file; license-
  notices file aggregates upstream attribution.
- **Contribution scoreboard** (v2.1). Per-participant
  `weight × rating` score visible to everyone; per-publisher opt-out.
- **Case-conversation** (v2.3). Append-only case timeline + the
  `case-manager` agent; agents on the same `caseId` see human
  interjections without manual hand-off.
- **Public-deployment hardening**. CSRF defence (`GOTONG_ALLOWED_HOSTS`
  + Host / Origin check), SameSite-Strict + Secure cookies, admin-
  token rate limit, response-wide security headers (CSP,
  X-Content-Type-Options, X-Frame-Options, Referrer-Policy),
  `/healthz` endpoint.
- **Sidecar DevX**. `docs/SIDECAR.md` "Day 1" tutorial. New
  `@gotong/cli` package (`gotong new agent` / `new python-agent` /
  `ping`). Python SDK reaches parity: `gotong.services` module
  mirrors `@gotong/sdk-node`'s `ServiceClient`.
- **MCP bridge**. `@gotong/mcp-server` lets Claude Desktop / Cursor
  / Cline drive a Hub via five tools (list, dispatch, evaluate,
  leaderboard, tasks).

### Added — federation services scaffolding

- `TeamBridgeAgent.forwardUpstreamServices` lets a bridged sub-hub
  expose upstream services to its own local agents via
  `bridge.upstreamServices`. One-way federation shipped; full
  bidirectional service forwarding is scoped to v3.1 — see
  [`docs/federation-services-rfc.md`](docs/federation-services-rfc.md).

### Added — observability (host + web admin)

- `service_call` transcript entries (calling agent id, type, impl,
  ownerKind, method, outcome, durationMs; `args` not persisted).
- Admin UI "Services" tab gains a SERVICE_CALL audit panel + a
  per-plugin describe surface (size, item count, preview).
- `GET /api/admin/metrics` — Prometheus / OpenMetrics text. Series:
  `gotong_protocol_version` (info), `gotong_participants{kind}`,
  `gotong_tasks_total{kind}`, `gotong_pending_applications`,
  `gotong_service_calls_total{type,impl,outcome}`,
  `gotong_service_call_duration_ms_{sum,count}{type,impl}`.
- Aggregated lazily from the transcript per scrape — no in-memory
  bookkeeping.

### Fixed — wire protocol v1.2 stabilisation (v1.2.1 → v1.2.7)

Seven post-v1.2 patches landed in the same cycle. Highlights:

- **v1.2.1** — `PROTOCOL_VERSION` constant actually reaches `'1.2'`
  in both SDKs (was still `'1.1'`); admin UI shows per-method ACL
  before approve; `forwardUpstreamServices` wires up; Python-agent
  template runnable.
- **v1.2.2** — `unregisterServiceMethods` for plugin lifecycle;
  cross-version safety warning on v1.1 ↔ v1.2 mixed sessions;
  metrics negative-duration clamp.
- **v1.2.3** — nine code-review items including `parseVersion`
  pre-release tag handling, symmetric unregister error contract,
  federation brand check (peer-mismatch tolerant), `versionMismatchWarned`
  flag bookkeeping, eleven-example typecheck regression.
- **v1.2.4** — `forbidden_method` in error code tables; regression
  guard for the v1.2.3 sticky-flag fix.
- **v1.2.5** — `parseVersion` boundary fuzz; Python SDK docstring
  clarifies host-side scope.
- **v1.2.6** — `shutdownAll` rolls back `wireMethods` registrations.
- **v1.2.7** — deflake `artifact-file describe` preview test on
  Linux CI (mtime tie-break).

### Dependency upgrades (transitively user-visible)

- `@anthropic-ai/sdk` `0.32.1` → `0.96.0` (peer; Managed Agents +
  webhooks + zod-v4-only)
- `openai` `4.104.0` → `6.38.0` (peer; two majors at once)
- `zod` `3.25.76` → `4.4.3` (peer for mcp-server)
- `better-sqlite3` `11.10.0` → `12.10.0` (runtime via
  `@gotong/service-datastore-sqlite`)
- `ws` `8.20.0` → `8.20.1` (security: uninitialized memory
  disclosure in `websocket.close()`)
- `tsx` `4.21.0` → `4.22.0` (build dep)

### Infrastructure

- CI: production Docker image smoke build added — catches
  `pnpm-workspace.yaml` ↔ Dockerfile drift the moment it lands.
  Three jobs total (Node 20/22 · TS workspace, Python 3.10/11/12 ·
  SDK, Docker · production image).
- `Dockerfile` covers all 16 workspace packages in the pre-install
  COPY (was 9 of 16; `docker compose up` failed on a clean clone).
- `docs/DEPLOY.md` C.4 systemd default flipped to built-`dist/main.js`
  ExecStart — the previous `--experimental-strip-types` default
  failed on the Node 20 LTS the same doc recommends.
- All `Gotong/Gotong` aspirational org URLs swept to the actual
  `Emir-Aksoy/Gotong` fork path (`git clone` instructions, package
  `repository.url`, boot-log links, security.txt, mcp-server README).

### Notes

- The wire protocol version (`1.2`) is independent of the npm
  version; see [`docs/PROTOCOL.md`](docs/PROTOCOL.md).
- All core npm packages (core, host, llm, llm-anthropic, llm-openai,
  protocol, sdk-node, transport-ws, web) bumped `2.0.0` → `3.0.0` in
  this release. Services + workflow + CLI + mcp-server remain on
  their own pre-1.0 lines while their public surfaces stabilise.
- The Python SDK (PyPI name: `gotong`) tracks the wire-protocol
  version, not the npm version.

### Stats

- 793 TypeScript tests workspace-wide green (was 139 at 2.0.0).
  Major test-count growth: services-sdk + the three first-party
  plugin packages, transport-ws (+13 for `extend-allowlist`, +4 for
  per-method ACL), host (+3 for `services-audit`), web (+8 for
  `renderMetrics`), workflow.
- Python SDK: 15 pytest passing (was 10), +5 for the new services
  module.
- CLI: 15 new template + dispatch tests.

---


## Earlier history

The full per-PR / per-checkpoint dev journal for v3.0 — every interim
v1.2.x patch, the services-over-WS day-by-day, the workflow engine
build-out, the contribution-scoreboard PRs — has been moved to
[`CHANGELOG-v3-dev.md`](./CHANGELOG-v3-dev.md). It's verbatim from
the original entries; nothing was edited or dropped.

The pre-v3 changelog (v2.0.0 and v1.x) lives in
[`CHANGELOG-v1-v2.md`](./CHANGELOG-v1-v2.md).
