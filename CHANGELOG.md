# Changelog

All notable changes to AipeHub are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) at the npm-package level.

The npm scope is `@aipehub/*`; the PyPI package is `aipehub`. The wire protocol has its own version (currently `1.2`) and is governed by `docs/PROTOCOL.md` — major changes to the wire protocol bump that version, independent of these package versions.

## Unreleased — 2026-05-17 — Single-file binary distribution

A no-Node-required install path. Operators who don't want to provision Node + pnpm just to run a chat server can now grab a single ~60 MB executable from GitHub Releases. Same `AIPE_*` env-var contract as the npm / docker paths — every recipe in `docs/DEPLOY.md` works unmodified.

### Added

- **`bun build --compile` single-file binary** built per-platform: `aipehub-host-{darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64.exe}`. Cuts the install story from "install Node 20, install pnpm, install the workspace, build TS" to "curl + chmod +x + run."
- **`.github/workflows/release.yml`** — fires on `release: published`, matrix-builds all five targets (native runner per platform except linux-arm64 which cross-compiles from x64), `--version` smoke-tests on every native target, and uploads the binaries as Assets on the triggering release. Also runs on `workflow_dispatch` for manual verification without publishing.
- **`packages/web/scripts/build-static-assets.mjs`** — embeds `static/*` (admin/worker HTML/CSS/JS, 212 KB total) into `src/static-assets.ts` as base64 so the bundler can ship the UI inside the binary. `serveStatic` checks the embedded map first, falling back to disk reads in dev mode.
- **`packages/host/src/services/builtin-plugins.ts`** — static `import` of `@aipehub/service-memory-file` + `@aipehub/service-artifact-file` so `bun --compile` links them into the binary. `hostAnchoredImport` in `bootstrap.ts` short-circuits to the builtin map before falling through to `import.meta.resolve(...)`, leaving the npm / docker behaviour unchanged.
- **`isCompiledBinary()` + `BINARY_SAFE_PLUGINS`** — runtime detection of binary mode (asset URL starts with `/$bunfs/` or `embedded://`). In binary mode the host seeds `plugins.json` with the two plugins that work, omitting `@aipehub/service-datastore-sqlite` (its `better-sqlite3` native binding can't be embedded). Binary first-run is now warning-free.
- **`services-sdk/loader.ts: LoadPluginsOpts.seedPlugins`** — new optional override letting hosts customise the default-seed list. Defaults to `DEFAULT_FIRST_PARTY_PLUGINS` so existing callers are unaffected.
- **`docs/DEPLOY.md` §0.5 + `docs/zh/DEPLOY.md` §0.5** — "Single-file binary (no Node required)" section documents the install path, what's inside vs not, and size/startup characteristics.

### Notes

- Binary excludes SQLite-backed datastore. Operators who need it stay on the npm or docker install paths — both keep full plugin support.
- `packages/web/package.json` adds `scripts/` to `files`, so the published npm tarball ships the asset generator alongside the source. `prepack` runs it before `tsc`, so consumers who install from npm get the embedded asset map without having to think about it.

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
  - `@aipehub/llm-openai`: `openai` `^4.104` → `^6.38` (two majors)
  - `@aipehub/llm-anthropic`: `@anthropic-ai/sdk` `^0.32` → `^0.96`
    (large pre-1.0 jump; captures Managed Agents + webhooks + zod-v4
    typings)
  - `@aipehub/mcp-server`: `zod` `^3.25` → `^4.4`
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
  in WELCOME + the new `aipehub_protocol_version` metric.

### Added — Hub Services (per-agent state, plugin-from-day-1)

- **`@aipehub/services-sdk`** — `ServicePlugin` contract + registry
  + loader. The seam plugin authors implement.
- **First-party plugins**:
  - `@aipehub/service-memory-file` — episodic / semantic / working
    memory as JSONL on disk
  - `@aipehub/service-artifact-file` — per-owner directories with
    MIME + size guards
  - `@aipehub/service-datastore-sqlite` — KV + raw SQL on one
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

- **Workflow engine** (v2.1). New `@aipehub/workflow` package: YAML
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
- **Public-deployment hardening**. CSRF defence (`AIPE_ALLOWED_HOSTS`
  + Host / Origin check), SameSite-Strict + Secure cookies, admin-
  token rate limit, response-wide security headers (CSP,
  X-Content-Type-Options, X-Frame-Options, Referrer-Policy),
  `/healthz` endpoint.
- **Sidecar DevX**. `docs/SIDECAR.md` "Day 1" tutorial. New
  `@aipehub/cli` package (`aipehub new agent` / `new python-agent` /
  `ping`). Python SDK reaches parity: `aipehub.services` module
  mirrors `@aipehub/sdk-node`'s `ServiceClient`.
- **MCP bridge**. `@aipehub/mcp-server` lets Claude Desktop / Cursor
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
  `aipehub_protocol_version` (info), `aipehub_participants{kind}`,
  `aipehub_tasks_total{kind}`, `aipehub_pending_applications`,
  `aipehub_service_calls_total{type,impl,outcome}`,
  `aipehub_service_call_duration_ms_{sum,count}{type,impl}`.
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
  `@aipehub/service-datastore-sqlite`)
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
- All `AipeHub/AipeHub` aspirational org URLs swept to the actual
  `Emir-Aksoy/AipeHub` fork path (`git clone` instructions, package
  `repository.url`, boot-log links, security.txt, mcp-server README).

### Notes

- The wire protocol version (`1.2`) is independent of the npm
  version; see [`docs/PROTOCOL.md`](docs/PROTOCOL.md).
- All core npm packages (core, host, llm, llm-anthropic, llm-openai,
  protocol, sdk-node, transport-ws, web) bumped `2.0.0` → `3.0.0` in
  this release. Services + workflow + CLI + mcp-server remain on
  their own pre-1.0 lines while their public surfaces stabilise.
- The Python SDK (PyPI name: `aipehub`) tracks the wire-protocol
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
