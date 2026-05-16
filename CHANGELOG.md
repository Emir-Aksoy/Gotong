# Changelog

All notable changes to AipeHub are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) at the npm-package level.

The npm scope is `@aipehub/*`; the PyPI package is `aipehub`. The wire protocol has its own version (currently `1.2`) and is governed by `docs/PROTOCOL.md` — major changes to the wire protocol bump that version, independent of these package versions.

## Unreleased — v1.2.4 pre-merge docs + regression guard

Third audit pass before merging to main caught two narrow misses:
the v1.2 `forbidden_method` code never made it into the Error codes
summary tables, and the v1.2.3 "silent-return doesn't flip the
sticky flag" fix was not covered by a regression test. Both
addressed; no source-code changes beyond a test file.

### Fixed — `forbidden_method` listed in Error code tables

- `docs/PROTOCOL.md` "Error codes summary" table gained the row for
  `forbidden_method` (was listed only in the v1.2 What's-new paragraph
  at the top, missing from the canonical index at the bottom).
- `docs/SIDECAR.md` "Symptom / What happened" table gained a row
  with the same code and a one-sentence diagnosis distinguishing it
  from `unknown_method`.

### Added — regression guard for v1.2.3 sticky-flag fix

- `packages/sdk-node/tests/version-mismatch.test.ts` adds a white-box
  test that pins the invariant the v1.2.3 fix established: when
  `checkServerVersionForServiceNarrowing` returns silently (no
  narrowing → no warning), `versionMismatchWarned` remains `false`.
  No realistic scenario lets a single session's silent return turn
  into a future warn — `opts.services`, `url`, and `PROTOCOL_VERSION`
  are all immutable per `SessionImpl`. The guard exists to catch
  future refactors that might quietly re-introduce the bug. Test
  uses a private-field cast (`session as unknown as { … }`) with a
  comment explaining why.

### Notes

- 454 tests workspace-wide green (+1 over v1.2.3). No new public
  API. No wire shape changes.

---

## Unreleased — v1.2.3 code-review polish + examples typecheck fix

Code-review pass over v1.2 / v1.2.1 / v1.2.2 surfaced nine small
issues. All are now resolved, plus a typecheck regression in examples
that v1.2 had quietly introduced.

### Fixed — `parseVersion` recognises pre-release tags

- `@aipehub/sdk-node` was parsing protocol version strings via
  `Number('2-beta')` which is `NaN` → fallback `0`, so a server
  reporting `'1.2-beta'` looked like v1.0 to a v1.2 client and
  produced a spurious cross-version warning. New `parseDigits` helper
  strips the first non-digit suffix off each component, so
  `'1.2-beta'`, `'1.2-rc.1'`, and `'1.2.3'` all parse correctly.
- Two new tests in `packages/sdk-node/tests/version-mismatch.test.ts`
  cover the pre-release and dotted-patch shapes — both must NOT warn
  when the client is v1.2.

### Fixed — `unregisterServiceMethods` is symmetric with `register`

- The new (v1.2.2) `unregisterServiceMethods` silently returned on
  invalid `type` / non-array `methods`, while `registerServiceMethods`
  threw — asymmetric, hides plugin-lifecycle bugs at the worst time
  (shutdown path). Now throws on the same conditions; "unknown type"
  is still a silent no-op because deleting nothing is not an error.
- Test in `packages/transport-ws/tests/extend-allowlist.test.ts`
  split into two cases: silent no-op on unknown type vs throw on
  bad input.

### Fixed — federation glue uses brand check, not `instanceof`

- `connect()` recognised `TeamBridgeAgent` via `instanceof`, which
  fails across pnpm peer-mismatch or workspace-override edge cases
  where two copies of `@aipehub/sdk-node` resolve into the same
  graph. Added a `__isAipehubBridge = true as const` brand and an
  `isTeamBridge(a)` helper that checks `instanceof` first (fast path)
  then falls back to the brand. Existing federation tests pass
  unchanged — the new check is strictly more permissive.

### Fixed — `versionMismatchWarned` flag bookkeeping

- The flag was flipped to `true` even when `checkServerVersion…`
  returned silently (no narrowing → no warning needed). Effect: if
  the first WELCOME had no narrowing on a v1.1 server and the
  reconnect later added narrowing, the warning never fired. Moved the
  `flag = true` write to the path that actually warns; silent-return
  paths leave the flag at its existing value.

### Fixed — small code-quality items from the review

- `unregisterServiceMethods` set-equality reduced to a cardinality
  check; built-ins are never deletable so "same size" implies "same
  set" (comment added explaining the invariant).
- `version-mismatch.test.ts` mock server now tracks every connection
  in an array, not a single `let` — concurrent connections no longer
  leak sockets between tests.
- CHANGELOG v1.2 section's `PROTOCOL_VERSION bumped to '1.2'` line
  carries a footnote pointing at v1.2.1 where the constant actually
  changed; Python SDK entry got the same caveat.
- `packages/sdk-node/src/bridge.ts` comments now say `(v1.2.1+)`
  where they previously said `(v1.2)` for fields that didn't exist
  on the original v1.2 commit.

### Fixed — examples typecheck regressions

- v1.2's new `'service_call'` variant on `TranscriptEntry` was added
  to `packages/host/src/main.ts`'s `describe()` switch but missed in
  all eleven `examples/*` describe() switches. Eight of those had
  declared return type `string`, so adding the variant broke their
  builds. Each now handles `case 'service_call'` consistently with
  `host/main.ts` (`SVCCALL` line with from, type:impl#method,
  outcome, durationMs).

### Notes

- 453 tests across the workspace green on this patch (+3 over v1.2.2:
  pre-release parse, dotted parse, unregister throw-symmetric).
- No wire shape changes. No new API on the SDK surface beyond
  exporting `isTeamBridge` from `@aipehub/sdk-node`.

---

## Unreleased — v1.2.2 minor-debt cleanup

Second audit pass picked up three smaller issues that did not block
v1.2 from being self-consistent (v1.2.1 already handled those) but
would have made v1.3 startup awkward. None of them change wire shape;
all are additive on the SDK / runtime surface.

### Added — plugin lifecycle: `unregisterServiceMethods`

- `@aipehub/protocol` gains `unregisterServiceMethods(type, methods)`,
  symmetric with `registerServiceMethods`. Designed for plugin hot-
  reload and clean host shutdown — a long-lived process that mounts
  and unmounts service plugins can now drop their wire methods from
  the runtime allowlist instead of leaking entries for the rest of
  the process. Built-in methods (`memory:recall`, `artifact:list`, …)
  are explicitly NOT removable; they are the floor of the allowlist.
- 4 new tests in `packages/transport-ws/tests/extend-allowlist.test.ts`
  cover symmetric remove, the built-in floor invariant, the empty-
  set collapse to `undefined`, and the no-op-on-bad-input contract.

### Added — cross-version safety warning in `@aipehub/sdk-node`

- The SDK now reads `WELCOME.protocolVersion` and, if it's older than
  the SDK's own `PROTOCOL_VERSION` on the same major, **and** the
  client declared `services[i].methods`, emits one `console.warn`:
  the server is too old to enforce per-method ACL narrowing, so the
  connection is effectively unnarrowed. The warning is sticky for
  the session (no reconnect-loop spam) and silent when narrowing is
  not in play. v1.1 servers stay reachable; the user just knows.
- New test file `packages/sdk-node/tests/version-mismatch.test.ts`
  spawns a raw `ws` server that replies with a configurable
  `WELCOME.protocolVersion` and verifies four cases: warning fires
  on (v1.1, narrowing); silent on (v1.1, no narrowing); silent on
  (same version, narrowing); and the warning fires exactly once.

### Fixed — `renderMetrics` clamps negative `durationMs`

- `aipehub_service_call_duration_ms_sum` is a Prometheus counter and
  must be monotonic. The previous code summed `Number.isFinite(d)
  ? d : 0`, which let a negative duration (mid-call clock skew, or
  a buggy client) drag the counter down across scrapes — breaking
  `rate()` queries silently. Now clamped to `>= 0`.
- New test in `packages/web/tests/metrics.test.ts` injects a `-50ms`
  service-call entry alongside a `+7ms` one and asserts the rendered
  sum is `7` (not `-43`) while count is still `2`.

### Notes

- All three changes are pure additions on the SDK / runtime; nothing
  on the wire moved. v1.2.1 + v1.2.2 together compose a self-
  consistent v1.2 release.
- 450 tests across the workspace green on this patch (+9 over v1.2.1).

---

## Unreleased — v1.2.1 audit patch (rollup)

The post-v1.2 audit found four claims in the v1.2 section below that
the code did not actually deliver. This rollup makes them real so the
v1.2 release ships a self-consistent story.

### Fixed — protocol version constant actually reaches `'1.2'`

- `packages/protocol/src/constants.ts` and
  `python-sdk/src/aipehub/protocol.py` both **stayed on `'1.1'`** even
  after the v1.2 docs went live, so the server's WELCOME frame and the
  `aipehub_protocol_version` info-metric both reported the wrong
  number. Bumped to `'1.2'` in both SDKs. The wire payload changes
  zero shape; this just makes the self-advertised version match the
  feature set described in `docs/PROTOCOL.md`.

### Fixed — per-method ACL is visible to admins (closes the management loop)

- `ServiceUseDecl.methods` was already enforced by the transport-ws
  router and session, but the management-plane half was missing:
  `ApplicationServiceDecl` had no `methods` field,
  `Hub.requestAdmission` did not accept one, and the admin "pending
  applications" card silently dropped the narrowing. v1.2's promise
  that admins see ACL narrowing **before** approving was therefore
  unfulfilled.
- `ApplicationServiceDecl.methods?: readonly string[]` added.
  `Hub.requestAdmission(req)` accepts and stores it. The transport-ws
  session pipes `frame.services[i].methods` through. The admin UI
  renders the methods next to each `{type}:{impl}/{owner}` row, with a
  "(any method)" placeholder when the client did not narrow.
- New test in `packages/host/tests/services-audit.test.ts` covers
  the end-to-end path: HELLO → `Hub.pendingApplications()[].services[].methods`.

### Fixed — `TeamBridgeAgent.forwardUpstreamServices` actually wires up

- The bridge held two new fields (`forwardUpstreamServices`,
  `upstreamServices`) but no host code read them; users following the
  RFC saw the option silently swallowed. v1.2.1's `connect()`
  (`@aipehub/sdk-node`) now:
  1. Scans `agents` for `TeamBridgeAgent` instances and merges every
     bridge's `forwardUpstreamServices` into the connection's HELLO
     services list (de-duplicated by reference, never lossy).
  2. After the session opens, writes `bridge.upstreamServices =
     session.services` so local agents that hold the bridge reference
     can read upstream services without manual hand-off.
- Two new tests in `packages/sdk-node/tests/services-roundtrip.test.ts`
  cover the positive path (memory roundtrip via `bridge.upstreamServices`)
  and the negative path (bridges without `forwardUpstreamServices`
  leave `upstreamServices` undefined — no phantom client).

### Fixed — `aipehub new python-agent` produces a runnable layout

- The template's `pyproject.toml` had `packages = ["src/<modName>"]`
  but the scaffolder wrote source to `src/agent.py`, so `pip install
  -e .` failed every time with "package not found". `python -m
  <modName>` was also broken for a separate reason (no `__main__.py`).
- New layout: `src/<modName>/__init__.py` re-exports `main` from
  `agent.py`; `src/<modName>/__main__.py` is the one-liner Python
  opens when the user runs `python -m <modName>`;
  `src/<modName>/agent.py` is the AgentParticipant subclass. Matches
  hatchling's expected layout end-to-end.
- CLI tests assert the new file paths and verify `__init__.py` /
  `__main__.py` contents; template tests grew one case covering both
  init/main shims.

### Notes

- All four fixes are additive on v1.2 wire/API and back-compat with
  v1.1 — the existing v1.2 cross-version reasoning at the bottom of
  the v1.2 section below still holds.
- 441 tests across `@aipehub/{core,services-sdk,transport-ws,sdk-node,host,cli,web}`
  green on this patch. The Python SDK's `PROTOCOL_VERSION` bump is
  picked up automatically by tests that compare against the imported
  constant; no test-side changes were needed.

---

## Unreleased — observability + DevX + protocol v1.2 (post-v1.1)

Builds on the v1.1 services-over-WebSocket release. v1.2 is the
"close the loop" cycle: third-party plugins get a way to ship their
own wire methods, admins get observability over what remote agents
are doing, the Python SDK reaches feature parity, and a CLI lands
that lets sidecar authors skip the boilerplate.

### Added — protocol v1.2 (additive on v1.1, fully back-compat)

- **`registerServiceMethods(type, methods)`** in `@aipehub/protocol`
  — third-party service plugins extend the SERVICE_CALL allowlist at
  host bootstrap by declaring a `wireMethods` array on their
  `ServicePlugin`. Built-ins (`memory` / `artifact` / `datastore`)
  unchanged; merge-only, never destructive. `BUILTIN_SERVICE_METHODS`
  is the immutable base; `SERVICE_METHOD_ALLOWLIST` becomes a
  deprecated alias kept exported for back-compat.
- **`ServiceUseDecl.methods?: string[]`** — optional per-decl method
  ACL narrowing. A connection can declare "I only want `recall` and
  `list`" and SERVICE_CALL frames for `remember` come back as
  **`forbidden_method`** (new error code) even if the type-level
  allowlist would permit them.
- **`ServicePlugin.wireMethods?: readonly string[]`** — new optional
  field on the plugin contract for non-built-in types. Host bootstrap
  calls `registerServiceMethods` for each registered plugin that
  declares it.
- **`PROTOCOL_VERSION`** bumped to `'1.2'`. Minor bump on the same
  major, so v1.1 ↔ v1.2 round-trip cleanly: v1.1 server receiving a
  `methods` field treats it as unknown extra (the wire decoder
  preserves extra fields silently); v1.1 clients calling a v1.2
  server never see `forbidden_method` because they never narrow.
  > **NOTE — the constant bump only landed in the v1.2.1 audit patch.**
  > The features above all shipped in this v1.2 entry; the version
  > string itself was the last debt audit caught (see v1.2.1 section
  > above). If you're spelunking commit history: `b3c740e` is where the
  > `'1.2'` constant actually replaces `'1.1'`.

### Added — observability (host, web admin)

- **`service_call` transcript entries** — every resolved SERVICE_CALL
  appends an audit entry recording the calling agent id, service
  identity, method name, outcome (`'ok'` or the wire `ServiceErrorCode`),
  and round-trip duration in ms. `args` are NOT persisted (potential
  user data; potentially large).
- **Admin UI — Services tab** gains a "SERVICE_CALL 审计" panel
  listing recent calls with failed calls highlighted. Backed by the
  new `GET /api/admin/transcript/service-calls?limit=N[&type=X]`
  endpoint.
- **Admin UI — Pending applications card** now shows the requested
  `services: [...]` ACL inline, so the operator sees the full ACL
  before clicking Approve. Powered by adding `services?:
  ApplicationServiceDecl[]` to `PendingApplication`; the transport-ws
  session pipes HELLO.services through `hub.requestAdmission`.
- **`GET /api/admin/metrics`** — Prometheus / OpenMetrics text
  exposition. Series: `aipehub_protocol_version` (info),
  `aipehub_participants{kind}` (gauge), `aipehub_tasks_total{kind}`
  (counter), `aipehub_pending_applications` (gauge),
  `aipehub_service_calls_total{type,impl,outcome}` (counter),
  `aipehub_service_call_duration_ms_{sum,count}{type,impl}` (counter
  pair). Aggregated lazily from the transcript on each scrape — no
  extra in-memory bookkeeping.

### Added — Python SDK feature parity

- **`aipehub.services` module** mirroring `@aipehub/sdk-node`'s
  `ServiceClient`:
  - `ServiceClient.memory_for(impl, owner)` /
    `.artifact_for(...)` / `.datastore_for(...)` factories.
  - Async typed handles: `MemoryHandle.recall(...)`,
    `ArtifactHandle.write(...)`, `DatastoreHandle.kv.set(...)`,
    `DatastoreHandle.sql.query(...)`.
  - `CustomServiceHandle` for third-party types.
  - `ServiceCallError` exception with `.code` matching the wire enum.
- `connect(url, agents, services=[...])` — same shape as TS.
- `Session.services` populated when services declared; `None`
  otherwise. Pending calls reject with `session_not_ready` on close
  / disconnect.
- `PROTOCOL_VERSION` in `aipehub.protocol` bumped to `'1.2'`. (Same
  caveat as the TypeScript constant above — the bump itself landed in
  v1.2.1.)
- 5 new pytest tests cover HELLO.services on the wire, memory
  roundtrip, error code propagation, third-party `custom_for`, and
  pending-call rejection on close.

### Added — federation services scaffolding

- **`TeamBridgeAgent.forwardUpstreamServices`** — list of
  `ServiceUseRequest`s the bridge declares to the upstream hub. Local
  agents that hold a reference to the bridge read upstream services
  via `bridge.upstreamServices` (assigned by the federation host
  after `connect()` resolves). One-way federation is shipped; full
  bidirectional service forwarding is scoped to v1.3 — see
  `docs/federation-services-rfc.md`.

### Added — sidecar DevX

- **`docs/SIDECAR.md`** — practical "Day 1" tutorial for connecting an
  existing agent to a running Hub as a sidecar. Covers the 5-line
  happy path, services declaration, migration from in-process,
  cancellation / disconnect / reattach, and the mistake gallery.
- **`@aipehub/cli`** (`npx @aipehub/cli`, bin: `aipehub`) — new
  package. Subcommands:
  - `aipehub new agent <name> [--capabilities=…] [--id=…] [--no-services]`
    — scaffold a TypeScript sidecar project (`package.json`,
    `tsconfig.json`, `src/index.ts`, `README.md`). Self-contained;
    `npm install && npm start` and you're online.
  - `aipehub new python-agent <name> [...]` — same for Python
    (`pyproject.toml`, module-aware names).
  - `aipehub ping <ws-url> [--api-key=…] [--timeout=…]` — handshake-
    only probe of a Hub for diagnostics. Uses `ws` directly to keep
    the CLI's transitive dep graph small.
  - `aipehub help [cmd]`, `aipehub --version`.
- 15 unit tests cover template rendering + CLI dispatch.

### Added — design docs (for v1.3+)

- **`docs/service-call-streaming-rfc.md`** — RFC for streaming
  SERVICE_CALL responses (`SERVICE_RESULT_CHUNK` frames + terminal
  `SERVICE_RESULT { __stream_end__: true }`). Maps out the wire
  shape, SDK ergonomics (`async for`), back-pressure, cancellation,
  and back-compat with v1.2.
- **`docs/plugin-sandbox-rfc.md`** — two-phase plan for sandboxing
  third-party plugins. Phase 1 (v1.3 candidate): `worker_threads`
  with `fs` patching against honest mistakes. Phase 2 (v1.4
  candidate): child process + Node permission model for adversarial
  deployments.
- **`docs/federation-services-rfc.md`** — what's shipped in v1.2
  scaffolding, plus the design for full bidirectional federated
  SERVICE_CALL forwarding in v1.3+.
- **`docs/enablement-flow-case-conversation-plan.md`** — staged
  plan for bringing `industry-enablement-flow` onto case-conversation
  (yaml `caseId` schema → per-agent `uses:` block → opt-in
  `autoInjectCaseContext` on `LlmAgent`). One-PR scope.

### Changed — admin transcript shape

`TranscriptEntry` gains a new discriminated variant:

```ts
| { kind: 'service_call'; data: { from, type, impl, ownerKind, ownerId,
    method, outcome, durationMs } }
```

Existing consumers that exhaustively switch on `kind` need a case
(host's `describe` already updated; admin SSE handler ignores
non-task entries by design).

### Tests

- Transport-ws: +13 tests for `extend-allowlist`, +4 for
  `per-method-acl`. 64 total (was 47).
- Host: +3 tests for `services-audit` (HELLO services in
  PendingApplication, service_call transcript outcomes). 88 total
  (was 85).
- Web: +8 tests for `renderMetrics`. 66 total (was 58).
- Python SDK: +5 tests for `test_services`. 15 total (was 10).
- CLI: 15 brand-new tests (templates + cli dispatch).
- All other packages unchanged and green.

## Unreleased — services over WebSocket (wire protocol v1.1)

Remote agents can now drive Hub Services (memory / artifact / datastore)
over the same WebSocket they use for tasks. Closes the gap
`docs/AGENT.md` already promised — moving an agent between in-process
and remote shapes is now genuinely a constructor-arg change, not a
logic change. **The "external agent standardized onboarding" goal**:
deploying a new agent type to a running host no longer requires `pnpm
install` on the host (npm-environment-free); the agent just runs as a
process and connects over WS.

Design: `docs/services-over-ws-rfc.md` (RFC, signed off on 5 key
decisions).

### Added — protocol v1.1 (additive on v1.0)

- **`SERVICE_CALL` (client → server)** + **`SERVICE_RESULT` (server →
  client)** frames. Single-request / single-reply RPC; multiple
  concurrent calls per session interleave by `callId`.
- **`HELLO.services?: ServiceUseDecl[]`** — optional declaration of
  which `(type, impl, ownerPattern)` triples the connection is
  allowed to invoke. ACL is bound at HELLO time so admin-approval
  reviewers see the full picture before approving.
- **Owner patterns** — `id: '<literal>'` (exact match), `id: 'self'`
  (server-substituted to the calling agent's id; agents only), `id:
  '*'` (any concrete id of that kind). Per-prefix matching deferred
  to v1.2.
- **Method allowlist** hardcoded in `@aipehub/protocol`:
  - `memory`: recall / remember / list / forget / clear
  - `artifact`: write / read / list / exists / remove
  - `datastore`: kv.get / kv.set / kv.del / kv.keys / sql.exec / sql.query
- **`PROTOCOL_VERSION`** bumped to `'1.1'`. Minor bump — major still
  `1`, so v1.0 ↔ v1.1 are fully interoperable. v1.0 clients ignore
  `services` (forward-compat); v1.0 servers receiving SERVICE_CALL
  reply `bad_frame` ERROR (client SDK surfaces as `server_too_old`).
- **`DEFAULT_SERVICE_CALL_TIMEOUT_MS`** = 30000. Client-side guard;
  the server doesn't enforce per-call timeouts.
- **Error codes** (in SERVICE_RESULT): `forbidden_service` /
  `forbidden_owner` / `attach_failed` / `service_error` /
  `unknown_method` / `bad_args` / `unknown_agent` / `session_not_ready`
  / `unknown_service` / `internal_error`.

### Added — server (`@aipehub/transport-ws`)

- **`ServiceCallRouter`** (new module) — per-session router with a
  `(type, impl, ownerKey)` handle cache. Lazy attach on first call;
  `dispose()` detaches all on session close; `onAgentLeft(id)`
  detaches only that agent's `kind:'agent'` owners (other kinds —
  `workflow-run`, `shared` — survive per RFC §6).
- **`ServiceCallGateway`** interface in `server.ts` — narrow shape
  (`attach` + `detachFor`) so transport-ws stays free of
  `@aipehub/host` and `@aipehub/services-sdk` dependencies. Production
  hosts pass `HubServices` directly (structurally satisfies it).
- **`WebSocketTransportOptions.services?: ServiceCallGateway`** — when
  present, sessions get a router; when absent, every SERVICE_CALL
  replies `forbidden_service` (graceful degradation).
- **Session integration** — HELLO.services validated + router built
  in `handleHello`; SERVICE_CALL handled in `onMessage`; dispose on
  `cleanup`. Malformed decls return `REJECT bad_hello` before WELCOME.

### Added — SDK (`@aipehub/sdk-node`)

- **`ServiceClient`** (new type) — exposes `memory`, `artifact`,
  `datastore: Record<name, …>` static-owner handles + `memoryFor` /
  `artifactFor` / `datastoreFor` factories for dynamic owners. The
  handle wrappers faithfully implement
  `@aipehub/services-sdk`'s `MemoryHandle` / `ArtifactHandle` /
  `DatastoreHandle` contracts (incl. `DatastoreHandle.name` /
  `kv` / `sql` sub-namespaces), so agent code reads identically to
  in-process LlmAgent.
- **`ServiceCallError`** — surfaces `SERVICE_RESULT.ok: false` as a
  thrown `Error` subclass with `code` from the wire enum.
- **`ConnectOptions.services?: ServiceUseRequest[]`** + **`Session.services?: ServiceClient`** — agent author wires `coach.services = session.services` once after `await connect()` resolves.
- **`@aipehub/services-sdk`** added as runtime dep so SDK users don't have to install services-sdk separately for the handle types. Type-only imports — no runtime size impact.
- Disconnect fails all pending RPCs with `session_not_ready` —
  consistent with how in-flight TASK frames are handled.

### Added — host wire-up (`@aipehub/host`)

- `main.ts` passes the bootstrapped `HubServices` into `serveWebSocket`
  as the gateway. When `bootstrapServices` fails the services field
  is omitted and remote agents see `forbidden_service` — same
  degradation path as a stripped-down host.

### Added — example

- **`examples/services-sidecar-demo`** — zero-dep demo using
  `MockLlmProvider` that:
  1. Starts hub + bootstrapServices + ws server.
  2. Connects **two** sidecar agents (writer + reviewer) via `sdk-node`,
     each declaring `services: [{memory, file, workflow-run/*}]`.
  3. Drives one case end-to-end (writer remembers → reviewer recalls
     writer's entry → reviewer remembers → reader reads the jsonl
     file directly to prove disk persistence).
  4. Tears down cleanly. ~250 lines of TypeScript, ~10ms runtime.
- This is the canonical "external agent over WS with services"
  recipe — the industry-consultation in-process example stays as a
  baseline for comparison.

### Added — regression coverage

- **`packages/transport-ws/tests/service-call-router.test.ts`** — 19
  unit tests (ACL matrix, cache reuse, wildcard, dispose,
  onAgentLeft, post-dispose rejection).
- **`packages/transport-ws/tests/service-call-roundtrip.test.ts`** — 6
  end-to-end over a real WS server (roundtrip, gateway-less fallback,
  wildcard isolation, forbidden_owner, disconnect cleanup).
- **`packages/sdk-node/tests/services-roundtrip.test.ts`** — 7 SDK
  integration tests against a fake gateway (presence/absence,
  remember/recall roundtrip, factory cache, datastore kv+sql,
  ServiceCallError, pending-on-close).
- **`packages/host/tests/services-over-ws.test.ts`** — 3 full-stack
  integration tests with the **real** `service-memory-file` plugin
  on a tmp dir (two-session shared case-memory, forbidden_owner,
  disconnect detach).

Total: 35 new tests across 4 layers; 0 regressions in the existing
153-test suite.

### Notes

- v1.0 ↔ v1.1 compatibility tested both directions: a v1.0 client
  on a v1.1 server keeps working unchanged; a v1.1 client whose
  server lacks the `services` gateway sees every SERVICE_CALL
  rejected as `forbidden_service` (graceful — connection survives).
- The `services-sidecar-demo` is the migration recipe for the
  industry-consultation pipeline. The in-process version stays —
  some deployments may prefer it for lower latency / simpler ops.
- **Out of scope for v1.1**: streaming results, per-call timeouts
  server-side, per-prefix owner matching, third-party service-type
  method allowlist extension. All scheduled for v1.2 / future RFCs.

## Unreleased — case-conversation (v2.3)

A small but consequential layer on top of v2.2 Hub Services: cases get a
shared timeline so users can interject **anywhere** in the workflow and
downstream agents automatically see those interjections.

### Added — host helper

- **`packages/host/src/services/case-context.ts`** — append-only case
  timeline backed by an existing `memory:file` handle, **no new service
  type**. Helpers:
  - `recordCaseConversation` / `recallCaseConversation` — user / agent
    interjections, tagged by source (`user` / `manager` / `coach` /
    `analyst` / `reviewer` / `system`) and optional `stepId`.
  - `recordCaseStepOutput` / `recallCaseStepOutputs` — workflow step
    outputs cached on the case for cross-step recall.
  - `formatCaseContextBlock` — render the timeline as a Markdown-ish
    prompt prefix downstream LLM agents can `prepend` to their user
    message verbatim.
  - Storage convention: owner `{kind:'workflow-run', id: caseId}`, kind
    `episodic`, topic / source / stepId encoded in `meta`. Filtering
    happens helper-side (the file backend doesn't take meta queries).
- **Exported under `@aipehub/host/services`** alongside the existing
  `bootstrapServices` / `LifecycleSweeper` surface — examples and
  third-party hosts can `import { recordCaseConversation, ... }`
  directly without touching internals.

### Added — agent template

- **`templates/agents/case-manager.yaml`** — `case-manager` agent with
  `capability=case-conversation` / `case-status`. Acts as the "side
  channel" outside the workflow steps: receives user interjections,
  the host glue writes them into the case timeline, the agent answers
  in three sections (`## 回应` / `## 我的判断` / `## 路由建议`). The
  routing hint tells the host whether to dispatch to a specialist
  agent or stop after the manager's reply. Declares only `memory:file`
  (kind=`episodic`) — shares the case-memory owner with the other
  agents working on the same case.

### Added — workflow + agent updates

- **`templates/agents/industry-coach-pro.yaml`** — system prompt now
  explicitly reads `## 当前 case 的已有上下文` when present, draws on
  the interjected facts in `[模式: draft]` / `[模式: finalize]`.
- **`templates/agents/industry-research-analyst.yaml`** — same:
  surfaces case-timeline facts in the "关键洞察" + "3 个提醒" sections.
- **`templates/workflows/industry-consultation-flow.yaml`** — header
  documents the v2.3 case-conversation integration: each step's host
  glue calls `recallCaseConversation` + `recallCaseStepOutputs`
  pre-run and `recordCaseStepOutput` post-run; the case-manager is
  **not** a workflow step (it's a side channel).
- **`templates/workflows/industry-enablement-flow.yaml`** — header
  notes that the v1 flow's 6 zero-glue `LlmAgent`s do **not** yet
  read case context; upgrade path documented inline. Use
  `industry-consultation-flow.yaml` if you need interjection support.

### Added — regression coverage

- **`packages/host/tests/case-context.test.ts`** — 8 tests against a
  hand-rolled in-memory `MemoryHandle` covering: round-trip record →
  recall, case isolation (caseA ≠ caseB), conversation vs step-output
  separation, `formatCaseContextBlock` output shape, empty-input
  no-op, `includeStepOutputs` filter, long-text truncation, and meta
  round-trip into the underlying memory entry.

### Added — provider retry

- **`OpenAIProvider.maxRetries`** (default `0`, opt-in). On transient
  transport-layer failures (`Premature close`, `socket hang up`,
  `ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` / `EPIPE` / `EAI_AGAIN`,
  undici's `UND_ERR_*` codes, HTTP `429` and `5xx`), the provider
  retries up to `maxRetries` additional times with exponential
  backoff + jitter (default `500ms × 2^(n-1)`, capped at 5s, +200ms
  jitter). Permanent errors (4xx other than 429, auth, malformed
  body) never retry. The motivating case: real DeepSeek runs would
  occasionally fail with `Premature close` on the largest
  `finalize` step; with `maxRetries: 3` the example now self-heals.
- **`isTransientError`** exported from `@aipehub/llm-openai` for
  callers building their own retry layer on top.
- **`retryBackoffMs`** opt — injectable backoff function (tests use
  `() => 1` to keep the suite instant).
- 11 new tests in `packages/llm-openai/tests/provider.test.ts`
  (4 retry behavior + 7 classifier). Test count went 15 → 26.

### Added — real-API example coverage

- **`examples/industry-consultation-deepseek/`** upgraded:
  - Workflow YAML now propagates `caseId` through every step's payload
    (`caseId: $trigger.payload.caseId`).
  - `CoachAgent` / `ResearchAgent` now use a shared host glue
    (`withCaseContext`) that prepends the case timeline + records step
    output / agent reply afterwards.
  - New `CaseManagerAgent` capability=`case-conversation` demonstrates
    a user interjection between RUN 1 (餐饮) and RUN 2 (零售): the
    manager reads the full case-1 timeline (intake/research/draft/
    review/finalize step outputs + coach replies) and answers a new
    follow-up question that wasn't in the workflow trigger.
  - Post-run inspection dumps both the agent-level memory (cross-case
    `priorCount` log) **and** every case-memory's timeline grouped by
    `caseId` so the cross-case isolation is visible.

### Notes

- v2.3 is additive on top of v2.2 — no breaking changes to existing
  agent yaml, plugin contracts, or REST endpoints.
- The case-memory mechanism (per-`caseId` owner) and the agent-level
  memory mechanism (per-agent owner) are **orthogonal**. Authors can
  use either or both without coupling.
- Storage cost: each case's memory is a small jsonl file under
  `<space>/services/memory/file/workflow-run/<caseId>/episodic.jsonl`.
  No automatic cleanup yet — bound the case count or wire a sweeper
  on top of `LifecycleSweeper` if your deployment has long lifetimes.

## Unreleased — Hub Services (v2.2)

A pluggable per-agent state layer. Agents declare what they want
(`memory`, `artifact`, `datastore`) in their yaml; the host attaches
typed handles at spawn time and keeps the bookkeeping. The Hub itself
gains nothing — Hub stays a "dumb dispatcher". All wiring sits in
`@aipehub/services-sdk` + per-implementation plugin packages + the
host's integration layer.

### Added — services SDK + first-party plugins

- **`@aipehub/services-sdk`** — the plugin contract. `ServicePlugin`
  with lifecycle (`init` / `validateConfig` / `attach` / `detach` /
  `softDelete` / `restore` / `hardDelete` / `describe` / `shutdown`),
  `ServiceRegistry`, `loadPlugins` dynamic-import loader with auto-seed
  of the default first-party manifest, `runPluginContract` shared
  vitest factory, typed errors (`PluginNotFoundError`,
  `TrashRestoreConflictError`, `ServiceConfigError`, …), and the
  `ServiceCtx` type the LlmAgent constructor accepts.
- **`@aipehub/service-memory-file`** — JSONL files per
  `(owner, kind)`. `recall` is case-insensitive substring + kinds /
  since / k filters. Trash lives under the plugin's local `.trash/`.
- **`@aipehub/service-artifact-file`** — per-owner directories with
  path-traversal defense, MIME allow-list, byte caps. List, exists,
  remove, recursive walk for `list({ prefix })`.
- **`@aipehub/service-datastore-sqlite`** — one `.sqlite` per declared
  `config.name` per owner. KV mode (backed by a `_kv` table) + raw SQL
  with prepared-statement caching. WAL + foreign-keys ON by default.

### Added — host integration

- **`bootstrapServices`** boots the loader, mkdirs `<space>/services/`,
  initialises every plugin with its own `rootDir`, returns a
  `HubServices` facade. Plugin import + init failures are non-fatal:
  the bad plugin shows up in `errors[]` and a `warn` log line.
  Resolution is **host-anchored** via `import.meta.resolve` from
  `bootstrap.ts`, so plugins declared as host dependencies are visible
  even under pnpm's isolated module graph (where
  `services-sdk/node_modules/@aipehub/` only contains `core`). Test
  runners that don't implement `import.meta.resolve` (vite-node) fall
  back to a plain `import(pkg)`.
- **`LocalAgentPool`** spawn-time wiring: reads `record.managed.uses`,
  calls `services.attachAll`, sorts the resulting handles into a
  `ServiceCtx`, passes it to `new LlmAgent({ services: ctx })`. On
  `stop(id)` (and on respawn) the pool calls `detachFor(owner)`.
- **`onAgentRemoved(id)`** lifecycle hook the web layer fires after
  `space.removeAgent`. LocalAgentPool implements it via
  `services.softDeleteAllForOwner` so deleting an agent moves all its
  service data to per-plugin trash (RFC Q3=A: 30-day retention +
  toast notification).
- **`LifecycleSweeper`** — background janitor (default 1h tick) that
  hard-deletes trash entries past `expiresAt`. Stop() awaits the
  in-flight tick so SIGTERM doesn't race the sweep.

### Added — admin surface

- **REST**: `GET /api/admin/services/plugins`, `GET / DELETE
  /api/admin/services/owners/:t/:i/:k/:id`, `GET
  /api/admin/services/trash`, `POST
  /api/admin/services/trash/:t/:i/:id/restore`, `DELETE
  /api/admin/services/trash/:t/:i/:id`, `POST
  /api/admin/services/sweep`. Wired through a plain-data
  `ServicesAdminSurface` interface in `@aipehub/core` so
  `@aipehub/web` never has to import the SDK.
- **SSE events**: `service_trashed` (every soft-delete) and
  `service_purged` (every expired-trash auto-cleanup) flow through
  the hub transcript and the admin SSE stream.
- **Admin UI**: a sixth "服务 / Services" tab. Lists per-agent service
  data with size + last-access columns; opens a detail modal with the
  plugin's preview (text or base64); trash sub-view with restore +
  hard-delete; "purge expired now" button; soft-delete toast says
  "moved to trash, auto-deletes in 30 days". 27 new i18n keys × 2 langs
  (`tabServices` + 26 `services*`).

### Added — agent yaml schema

- **`ManagedAgentSpec.uses?: ServiceUseSpec[]`** in `@aipehub/core` and
  `parseManifest` validation in `@aipehub/web`. Yaml authors declare
  `{ type, impl, config }` per service. The same validator runs on the
  admin POST/PUT form path. `memory` and `artifact` are singular per
  agent; `datastore` (and third-party types) may repeat.
- **`renderAgentManifest`** echoes the `uses:` list (deep-cloned) so
  export → edit → re-import is lossless.
- **Templates** for the "传统行业 AI 咨询" product line:
  - `templates/agents/industry-coach-with-memory.yaml` — minimal
    single-agent example using all three first-party plugins (v2.2
    landmark commit).
  - `templates/agents/industry-coach-pro.yaml` — multi-phase coach
    (intake / draft / finalize) with full services triad.
  - `templates/agents/industry-research-analyst.yaml` — companion
    research agent backed by a `cases` datastore.
  - `templates/teams/industry-consultation-team.yaml` — one-click
    import of the two agents above.
  - `templates/workflows/industry-consultation-flow.yaml` — the
    5-step consultation pipeline with a **real human-in-the-loop**
    review step (`capability=consultant-review` dispatches to any
    Worker who advertised that capability). End-to-end coverage in
    `packages/host/tests/industry-consultation-flow.test.ts` (5
    integration tests; runs the full pipeline including a fake
    auto-reviewer that completes the review task synchronously).

### Notes

- core gets a single new file (`services-admin.ts`, type-only) plus a
  `paths.services` string on `Space`. The `services-sdk → core` type
  dependency that already existed isn't reversed; HubServices lives in
  `@aipehub/host`.
- All three first-party plugin packages
  (`service-memory-file`, `service-artifact-file`,
  `service-datastore-sqlite`) are declared as **runtime dependencies**
  of `@aipehub/host`, not devDependencies — without this the
  pnpm-isolated module graph hides them from the production resolver.
  Third-party plugins still resolve fine as long as they're installed
  somewhere reachable from the host package (`pnpm add` in the host
  workspace, or a deploy-time `npm i`).
- Existing agents with no `uses:` are unchanged. The optional field
  parses as `undefined`; LlmAgent without a `services` opt reads
  `EMPTY_SERVICE_CTX` (a frozen `{}`).
- Wire protocol (`docs/PROTOCOL.md`) is unchanged.

## Unreleased — workflow engine + CI (v2.1)

The pluggable workflow layer the Hub deliberately doesn't bundle. The
Hub stays "dumb dispatcher"; `@aipehub/workflow` is a separate package
the host loads at boot. Workflows are YAML files; their runtime state is
JSON on disk; nothing about the Hub had to change.

### Added — `@aipehub/workflow` (new package, file-first)

- **YAML schema `aipehub.workflow/v1`** with: `trigger.capability`,
  ordered `steps[]`, optional `output` expression, optional
  workflow-level `onFailure` (`halt` / `continue`). Steps are either
  simple (one `dispatch`) or `parallel: true` with fan-out branches.
- **Reference syntax** in payloads / output: `$trigger.payload[.path]`,
  `$stepId.output[.path]`, `$stepId.branchId.output`. Type-preserving on
  full substitution; JSON-stringified on inline templating.
- **`WorkflowRunner extends AgentParticipant`** — registers as
  `workflow:<id>` with one capability (the trigger). The Hub treats it
  as an ordinary agent; it just happens to make N inner dispatches.
- **File-first persistence**: every run writes
  `<space>/workflows/runs/<runId>.json` atomically (tmp + rename) after
  each step. Operators can `jq` the directory to inspect or recover.
- **`when:` predicate (v0.2)** on simple steps AND parallel steps —
  strict typed `==`/`!=`, `&&`/`||`/`!`, parentheses, `$ref` operands.
  No arithmetic, no `<`/`>`, no functions. Bad predicates are caught at
  `parseWorkflow` time, not at first dispatch. Missing refs resolve to
  `undefined` (same as "step not run yet"). Skipped steps record
  `status: 'skipped'`; downstream refs see `undefined`.
- **Resume from disk (v0.3)** — host boot scans `runs/` and continues
  any run still marked `'running'`. Already-`done` steps replay from
  their persisted output without re-dispatching; mid-flight or crashed
  steps are dropped and re-run fresh. Runs whose workflow has been
  removed since are closed out as `failed` so they stop pretending to
  still be running in the admin history.
- **Branch-level `when:` (v0.4)** — each parallel branch can be gated
  independently. Skipped branches don't dispatch, don't appear in
  `subTaskIds`, contribute `undefined` to the step's output map, and
  don't count as failures. Parent-step `when: false` short-circuits
  before inner branch predicates evaluate.
- **`RunStore`** — atomic write, JSON read, `listRunIds`, `listRuns`
  with optional `workflowId` filter + `limit`, all under a single
  `<space>/workflows/` tree.

### Added — host integration

- **`@aipehub/host`** scans `AIPE_WORKFLOWS_DIR` (default
  `<space>/workflows/definitions/`) at boot and registers a runner per
  file. Default participant id is `workflow:<id>`.
- **`WorkflowController`** is the duck-typed `WorkflowSurface` the Web
  layer talks to. Methods: `list`, `importFromText`, `remove`,
  `listRuns`, `readRun`, `resumeRunningRuns`. The Web package does NOT
  take a runtime dependency on `@aipehub/workflow` — the controller is
  passed in via `serveWeb({ workflows })`.
- **HTTP API**:
  - `GET    /api/admin/workflows`              — list loaded workflows
  - `POST   /api/admin/workflows/import`       — paste YAML / JSON
  - `DELETE /api/admin/workflows/:id`          — unregister + unlink
  - `GET    /api/admin/workflows/runs?workflowId=&limit=` — history list
  - `GET    /api/admin/workflows/runs/:id`     — full run detail
  - All endpoints respond 404 when the host wasn't built with
    workflows enabled — admin UI auto-hides the panel.

### Added — admin UI

- New "工作流" section on `/admin` with cards for each loaded workflow
  (trigger capability + step count + file path).
- **"导入工作流" modal** — file upload OR paste, surfaces schema errors
  verbatim.
- **"移除" button** on each card — unregisters + deletes the YAML.
- **"历史" button** opens a two-pane modal: list of recent runs (newest
  first, status / time / step count) + click-to-view detail showing
  trigger payload, per-step status + timing + sub-task ids + output,
  plus the final output / error.
- SSE-driven: `participant_joined` / `participant_left` for any id
  starting with `workflow:` triggers a refresh.

### Added — `templates/workflows/`

Four reference workflows, each callable as one trigger capability:

- `editorial-flow.yaml`            — writer → reviewer (2 steps)
- `admin-task-flow.yaml`           — parse → split → [parallel: draft +
  dispatch] → report → archive (5 steps)
- `admin-report-restyle-flow.yaml` — single-step restyle
- `industry-enablement-flow.yaml`  — 5-step traditional-industry AI
  enablement consult

### Added — CI

`.github/workflows/ci.yml` — Node 20/22 × `pnpm -r build/typecheck/test`,
plus Python 3.10/3.11/3.12 × `pytest` for `python-sdk`. Concurrency
cancels in-flight PR runs; `main` post-merge runs always finish.

### Tests

- `@aipehub/workflow`: 82 tests (schema, resolver, runner, predicate,
  run-store, template parse smoke-check).
- `@aipehub/host`: 19 tests (loader, controller — import / remove /
  history / resume orchestration).
- Workspace total: **316 passed / 2 skipped**.

### Distribution

- **No `npm publish` at this stage.** The earlier "queued for v2.1"
  plan to push `@aipehub/*` to npmjs.com has been **descoped**. Source
  (`pnpm install && pnpm build && pnpm host`) and Docker
  (`docker compose up`) are the two supported install paths — both
  documented in [README](README.md) Quick start.
- **Open decision** — which JS registry, if any: stay source-only, JSR
  (jsr.io — GitHub OAuth, no separate account, native TS), or GitHub
  Packages (`@aipehub` scope same as the GitHub org but users must
  configure `.npmrc`). Tracked in
  [RELEASE-CHECKLIST](.github/RELEASE-CHECKLIST.md).
- **Pre-built single-file binaries** for macOS (arm64 + x64) and
  Windows x64 are a planned but **non-blocking** item — Docker already
  covers the cross-platform "click and run" case. Bun `--compile` is
  the leading candidate; requires inlining `packages/web/static/*`
  before the binary is self-contained.
- **PyPI**: `aipehub` is similarly source-only at this stage
  (`pip install -e python-sdk/`). PyPI publish decision moves alongside
  the JS-registry call.

### Author / committer hygiene

- All commits in the repo history now use the GitHub `users.noreply`
  alias as author and committer — eliminates the `<user>@<hostname>.local`
  leak the local-default git config introduces when `user.email` is
  unset. One-time `git rebase --root --exec 'git commit --amend
  --reset-author --no-edit'` rewrote 23 commits before the repo was
  pushed anywhere; nobody had to force-push.

## Unreleased — managed agents + encrypted API keys + template library (v2.1)

The "普通人 60 秒上线一个 agent" milestone. Adds host-managed LLM
agents, three import paths (UI form / paste / file upload), encrypted
on-disk API-key management, and a public template library for
community-shared agent + team configs.

### Added — encrypted API keys (UI input + at-rest crypto)

- **`<space>/secrets.enc.json`** holds workspace-level provider keys
  (anthropic, openai, …) and optional per-agent overrides, all encrypted
  with AES-256-GCM.
- **`<space>/runtime/secret.key`** holds the AES master key (32 bytes,
  hex, `0600`). Operators can override with `AIPE_SECRET_KEY` env (64
  hex chars) for KMS-mounted setups.
- **Two-tier resolution at spawn** in priority order: (1) per-agent key
  → (2) workspace default → (3) `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  env. Mock provider needs no key.
- **API:**
  - `GET /api/admin/secrets` — status only (timestamps, env-detection),
    **never plaintext**
  - `PUT /api/admin/secrets/:provider { apiKey }` — set / rotate
  - `DELETE /api/admin/secrets/:provider` — remove
  - `POST /api/admin/agents { ..., apiKey? }` — optional inline
    per-agent override
  - `PUT /api/admin/agents/:id { ..., apiKey? }` — same, plus `apiKey: ""`
    clears the override
- **Admin UI**: "API Key 管理" button opens a modal listing each provider
  with badges (✓ workspace / ✓ env / ✗ missing) and Set/Update/Clear
  buttons. Agent create/edit form gains a "私有 API Key（可选）" password
  input + a "清空" button.
- **Auto-cleanup**: `Space.removeAgent(id)` drops the agent's encrypted
  override key in the same transaction so an orphaned key never lingers.
- **Tests**: 14 cases covering encrypt/decrypt round-trip, wrong-key
  rejection, tamper detection, fresh-IV property, master-key
  bootstrapping (env > file > generate), `Space.setProviderApiKey` /
  `getProviderApiKey` / `removeProviderApiKey` and the agent
  counterparts (including auto-cleanup on `removeAgent`).

### Added — host-managed agents

- **`AgentRecord.managed?: ManagedAgentSpec`** — optional spec stored in
  `agents.json`. `kind: 'llm'` agents carry `provider` (anthropic /
  openai / mock), `model`, `system` prompt, and `weightDefault`. API
  keys never go to disk — only the provider name; keys stay in `process.env`.
- **`AgentSupervisor`** in `@aipehub/host`: on boot, replays `agents.json`
  into live `LlmAgent` participants registered on the Hub. Same on
  every create / edit. `displayName` field added for human-friendly
  identifiers.
- **`ManagedAgentLifecycle`** interface exported from `@aipehub/core` so
  the Web layer talks to the supervisor without importing
  `@aipehub/llm-*` directly. `serveWeb({ lifecycle })` plugs the host's
  supervisor in.
- **Host package** now depends on `@aipehub/llm`, `@aipehub/llm-anthropic`,
  `@aipehub/llm-openai` so a single `pnpm host` brings everything online.

### Added — manifest format + parser

- **`aipehub.agent/v1`** (single agent) and **`aipehub.team/v1`**
  (multiple agents bundled) schemas, accepted as YAML or JSON.
- Parser in `@aipehub/web/manifest.ts` returns a typed `ParsedManifest`,
  fails loudly with `ManifestError`-class messages that the admin UI
  surfaces verbatim. New `yaml` dependency.

### Added — Web API (6 new endpoints)

- `GET /api/admin/agents` — list all (managed + externally-connected)
- `GET /api/admin/agents/providers` — which provider strings the host
  can actually spawn (i.e. has env keys for)
- `POST /api/admin/agents` — create one from form fields
- `POST /api/admin/agents/import` — bulk import a manifest (YAML or JSON
  in request body)
- `PUT /api/admin/agents/:id` — edit one (stop + restart the live agent)
- `DELETE /api/admin/agents/:id` — remove
- `GET /api/admin/agents/:id/export` — download as v1 JSON manifest

### Added — Admin UI

- New "智能体" section spanning the page top. Card grid with id /
  provider / online state / caps; three per-card actions (编辑 / 导出 /
  移除).
- "+ 创建" modal — id / displayName / capabilities / provider (greyed
  out for missing env keys) / model / system prompt / weightDefault.
  Edit form is the same component pre-filled, with a "建议先停止再修改"
  warning.
- "导入" modal — file upload OR textarea paste. Server-side parser is
  format-agnostic (sniffs YAML vs JSON).
- A standing hint links to the public template library on GitHub.

### Added — `templates/` directory (public library)

- `templates/agents/`: writer-zh, reviewer-zh, summarizer-zh,
  translator-zh-en, code-reviewer (5 standard agents)
- `templates/teams/`: editorial-zh, translator-team, code-review-team
  (3 standard teams)
- `templates/README.md` walks through "open raw URL → copy → paste into
  admin UI"; `templates/CONTRIBUTING.md` shows how to PR new templates.

### Added — `templates/community/` (third-party adapted set)

A second tree under `templates/community/` collects agents adapted
from major open-source prompt libraries with clean commercial licenses.
Designed to be uploaded to a CDN later so users can pull them with one
URL paste in the admin UI.

- **Sources & licenses** (full verbatim in
  [`templates/community/LICENSE-NOTICES.md`](templates/community/LICENSE-NOTICES.md)):
  - [`f/awesome-chatgpt-prompts`](https://github.com/f/awesome-chatgpt-prompts) — **CC0 1.0** (public domain) — 10 agents + 1 team
  - [`PlexPt/awesome-chatgpt-prompts-zh`](https://github.com/PlexPt/awesome-chatgpt-prompts-zh) — **MIT** — 1 agent
- **Rejected** upstream sources marked non-commercial, research-only,
  or unlicensed.
- **Adaptation rules** documented in `templates/community/README.md`:
  removed conversational openers ("my first request is …"), reshaped
  for AipeHub's single-turn task-payload → TaskResult model, added
  structured output sections, tuned capabilities + model + weight.
- **Files**: `linux-terminal`, `javascript-console`, `sql-terminal`,
  `english-improver`, `storyteller`, `math-tutor`, `tech-writer`,
  `career-counselor`, `statistician`, `prompt-engineer`,
  `interviewer-zh` + `tech-content-team` (3-agent pipeline).
- Each file's header carries `# Source` / `# Upstream` /
  `# License` / `# Adapted` lines so downstream forks can trace
  provenance.

### Added — tests

- `packages/web/tests/manifest.test.ts` — **37 cases** (was 25) covering
  YAML / JSON parsing, agent + team schemas, error surface, render
  round-trip, and a smoke check that **every committed template file
  parses cleanly** — now walks both `templates/{agents,teams}/` and
  `templates/community/{agents,teams}/` so any PR adding a new community
  template gets coverage automatically.

## Unreleased — contribution scoreboard (v2.1)

Everyone in a room — humans **and** agents — now sees how much each
participant has gotten done. The Hub gains the data, the Web UI gains
two new panels, and **every participant can opt their own dispatches
out of the score**.

### Added — per-publisher opt-out

- **`Task.countContribution?: boolean`** — when `false` the leaderboard
  pretends the task doesn't exist (not counted as rated, not counted as
  unrated). Defaults `true` / `undefined`. The flag is set at dispatch
  time and lives in the transcript.
- **`AdminRecord.contributionOptOut?: boolean`** +
  **`WorkerRecord.contributionOptOut?: boolean`** — persistent personal
  preference. Stored in `admins.json` / `workers.json`. Defaults to
  false (counted).
- **`Space.setAdminContributionOptOut(id, value)`** +
  **`Space.setWorkerContributionOptOut(id, value)`** — toggle methods.
- **`GET /api/whoami`** now returns `contributionOptOut: boolean`.
- **`POST /api/me/contribution-opt-out { value: boolean }`** — self-service
  toggle for the logged-in admin or worker.
- **`POST /api/admin/dispatch`** reads the admin's saved preference as
  the default for `Task.countContribution`. A `countContribution` field
  in the request body overrides per-call (for future ad-hoc UI).
- **`Hub.retry()`** preserves the original task's `countContribution`
  flag — retried tasks inherit the original opt-out posture.
- **UI** — a header toggle on both admin and worker pages: "我派发的任务
  计入贡献榜 / My dispatches feed the leaderboard". Switches the
  preference in one click; tooltip explains that **only outgoing tasks
  are affected — tasks you receive still count toward your own score**.

### Added — task weight + rating + per-task contribution

### Added — task weight + rating + per-task contribution

- **`Task.weight`** (`0.1`–`10.0`, one decimal, default `1.0`). Set by the
  admin at dispatch time; clamped + rounded by the Hub so the stored
  task is always well-formed. Carried through `retry()` so retried tasks
  inherit the original stakes.
- **`Evaluation.rating`** is now formalised as `0`–`5` with one decimal of
  precision. The Hub clamps and rounds incoming values in `evaluate(...)`;
  out-of-range inputs are coerced rather than rejected (web forms get
  the polite treatment). `undefined` keeps "comment-only" evaluations
  working — they leave the contribution score unchanged.
- **`TaskView`** gains `weight`, `effectiveRating` (latest numeric rating),
  and `contribution` (= `weight × effectiveRating`). Comment-only
  re-evaluations preserve the previous score; a rating re-evaluation
  overwrites it ("latest rated wins").
- **`Hub.leaderboard({ from?, to? })`** — new pure derivation over the
  transcript. Returns `Leaderboard { from, to, rows, unratedTaskCount,
  totalTaskCount }` where each row aggregates `taskCount`, `totalWeight`,
  `totalContribution`, `averageRating`, `lastActivityTs`, and a
  `byCapability` breakdown (capability → contribution). Sorted by
  contribution desc with tie-break on `lastActivityTs` desc.
- **`TaskView.completedAt`** now reflects the transcript-entry `ts`
  (driven by `hub.now()`) rather than the agent-reported `result.ts`.
  Matters for time-window filtering and tie-breaking under simulated
  clocks; legacy transcripts replay unchanged.

### Added — Web UI

- `POST /api/admin/dispatch` accepts a `weight` field.
- `GET /api/leaderboard?from=&to=` returns the leaderboard. Public to
  both admins and workers — visibility is the point ("everyone sees
  everyone's contributions").
- **Admin panel**: dispatch form has a new "权重" input; evaluation form
  upgraded to `step=0.1` with `[0, 5]` range. Task cards now show
  `权重 / 评分 / 贡献` metric badges. A "贡献榜" section spans the full
  page with a time-window selector (today / week / month / all).
- **Worker panel**: a compact leaderboard appears under "参与者". Same
  data, same window selector. Workers see the same totals admins see.
- New i18n keys for `dispatchWeight`, `weightLabel`, `ratingLabel`,
  `contributionLabel`, `unrated`, `leaderboardTitle`, `lbWindow*`,
  `lbCol*`, `lbSummary` in both zh and en.

### Added — tests

- `packages/core/tests/contributions.test.ts` — 14 cases covering weight
  defaulting / clamping / rounding, rating sanitisation, latest-rated-
  wins, time-window filtering, tie-breaking, byCapability breakdown,
  and retry weight preservation.

## Unreleased — public-deployment hardening

Targets the "open-source it + run a public体验版" milestone.

### Added — security
- **CSRF defence.** `serveWeb` now accepts `allowedHosts: string[]`. When set, every POST/DELETE is rejected unless the `Host:` header and (if present) the `Origin:` header match the allow-list. Returns 403 on mismatch. Production deployments **must** set this.
- **SameSite=Strict + Secure cookies** when `cookieSecure: true`. Previously was `SameSite=Lax` even in HTTPS mode.
- **Rate limiting** on admin token verification — both `/admin?token=…` and Bearer-authenticated admin API calls. Per-IP sliding window, in-memory, configurable via `adminLoginRateLimit: { max, windowSec }` (defaults 10 per 60s; `max: 0` disables).
- **Security headers** on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, plus a `Content-Security-Policy` that blocks third-party loads.

### Added — operability
- `GET /healthz` returns `200 ok` for load-balancer / uptime checks.
- Web server honours `X-Forwarded-For` for client-IP detection (first hop) so the rate limiter is meaningful behind a reverse proxy.
- Cookie helper uses `Strict` SameSite when secure, `Lax` otherwise.

### Added — admin lifecycle
- `POST /api/admin/admins { displayName }` mints a fresh admin and returns the plaintext token exactly once. Used for inviting more admins without redeploying.
- `DELETE /api/admin/admins/:id` revokes another admin. Refuses to remove the last admin or to remove yourself (use `logout` for the latter).

### Added — new package `@aipehub/host`
- Production binary that runs Hub + WebSocket + Web from environment variables. No demo agents, no test traffic.
- `aipehub-host` bin entry; runnable via `pnpm host`.
- Env vars: `AIPE_SPACE`, `AIPE_HOST`, `AIPE_WEB_PORT`, `AIPE_WS_PORT`, `AIPE_GATING`, `AIPE_COOKIE_SECURE`, `AIPE_ALLOWED_HOSTS`, `AIPE_ADMIN_RATE_MAX`, `AIPE_ADMIN_RATE_SEC`, `AIPE_DEFAULT_LANG`, `AIPE_HEARTBEAT_MS`, `AIPE_SPACE_NAME`, `AIPE_ADMIN_DISPLAY_NAME`.
- Graceful shutdown on SIGINT / SIGTERM: drains SSE clients, closes WS, calls `hub.stop()` before exit.

### Added — federation
- `TeamBridgeAgent` in `@aipehub/sdk-node`: wraps a local Hub as one agent on an upstream Hub. Forwards tasks downward, reframes results upward with provenance (`localBy`, `localTaskId` in `output`). Optional `mapTask` callback to rewrite dispatch strategy.
- New example `examples/federated-team` with `upstream-host`, `team-host`, `driver`, and a launcher. Demo target: `pnpm demo:federated-team`.
- New 4-test suite `packages/sdk-node/tests/bridge.test.ts` covers ok / failed / no_participant / mapTask paths in-process (no WS).

### Added — documentation
- `docs/DEPLOY.md` — three deployment shapes (Local / LAN / Public), full Caddyfile and systemd unit templates, env-var reference, production checklist.
- `docs/FEDERATION.md` — Hub-of-Hubs design, result wrapping semantics, recursive bridges.
- `docs/AGENT.md` — how to write & connect an agent in Node / Python, approval flow, capability conventions, troubleshooting.
- `docs/HUMAN.md` — admin + worker walkthroughs, multi-admin invite flow, server-side first-token recovery story.
- `CONTRIBUTING.md` and `SECURITY.md` added at repo root.
- Top-level `README.md` reorganised around "pick your door" (worker / agent / operator / federation / architecture).

### Added — launch scripts (macOS)
- `启动-OpenSpace.command` and `重置-OpenSpace.command` (already shipped).
- `启动-联邦协作.command` for the federation demo.

### Changed
- `examples/open-space/src/host.ts` now plumbs `config.host` and `config.cookieSecure` into the transport servers. Previously only `port` was wired, so `host` in `config.json` had no effect.
- `SpaceConfig` gains `cookieSecure: boolean` (default `false`). Backwards-compatible — existing `config.json` files are merged with defaults on read.

### Test stats
- **143 passed + 2 skipped** (was 139 + 2). sdk-node: 7 → 11 via bridge.test.ts.

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

[1.0.0]: https://github.com/AipeHub/AipeHub/releases/tag/v1.0.0
