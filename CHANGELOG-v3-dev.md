# Gotong v3.0 dev journal

> Archived development log for Gotong v3.0.0 — the per-PR / per-checkpoint
> notes that fed into the consolidated `## 3.0.0 — 2026-05-17 — Services`
> entry in [`CHANGELOG.md`](./CHANGELOG.md). Split out in v3.2 because
> the main file had grown past 1600 lines, which made the changelog
> useless as a release-notes companion (readers want to know what
> shipped, not what every interim point release was about).
>
> If you want to know **what changed in v3.0**, read `CHANGELOG.md`.
> If you want to know **how v3.0 was built, week by week**, read this file.

---

## 3.0.0 dev journal — v1.2.7 flaky CI: artifact-file describe preview tie-break

CI monitor flagged `Node 20 · TS workspace` on PR #7 (and intermittently
on PR #8) — the `service-artifact-file` plugin test
`reports size, itemCount, preview after writes` failed with
`expected '# one' to match /two/`. Root cause is a `mtimeMs` tie:
two `h.write(...)` calls happen inside the same millisecond on Linux
CI filesystems (ext4 / tmpfs ms-granularity), so both files report
the same mtime, the `>`-tie-break in `ArtifactFilePlugin.describe`
never overrides `previewSource`, and walk order (alphabetical) keeps
`one.md` ahead of `two.md`. Node 22 happened to not tie on the same
input — the test wasn't deterministic.

### Fixed — test inserts a one-tick delay between writes

- `packages/service-artifact-file/tests/plugin.test.ts` —
  `describe › reports size, itemCount, preview after writes` now
  sleeps 20 ms between `one.md` and `two.md` writes so mtimes are
  distinguishable on the slowest CI filesystem. The plugin itself
  (`src/plugin.ts`) is unchanged — picking the largest-mtime file is
  still the right behaviour; the fix is in the test's realism, not
  the implementation. A long-form comment in the test documents the
  failure mode for future maintainers so the delay isn't optimised
  away.

### Notes

- 793 tests workspace-wide green (no change in count — this fix is
  test-only flake remediation).
- No production code path touched. No wire shape changes. No new
  public API.
- This unblocks PR #7 / PR #8 CI determinism on `Node 20` runners.

---

## 3.0.0 dev journal — v1.2.6 plugin shutdown wireMethods rollback

Closes the last "defer-to-v1.2.x" item from the v1.2.4 audit:
`bootstrapServices` registered third-party wire methods, but
`shutdownAll` did not roll them back, so a long-lived process
mounting / unmounting plugins (test harness, future hot-reload)
leaked entries in the process-wide runtime allowlist.

### Added — `shutdownAll` rolls back `wireMethods`

- `packages/host/src/services/hub-services.ts`'s `shutdownAll` now
  calls `unregisterServiceMethods(plugin.type, plugin.wireMethods)`
  after `plugin.shutdown()` for every plugin that registered wire
  methods at bootstrap. Built-in types are protected by the
  allowlist's floor invariant; this only removes the third-party
  additions. Failures are logged with `warn` but never abort the
  shutdown sweep — symmetric with the existing `plugin.shutdown()`
  best-effort behaviour.
- `packages/host/tests/services-bootstrap.test.ts` gains a new
  describe block (`wireMethods runtime allowlist lifecycle`) with
  an end-to-end test: bootstrap a fake `notion` plugin with
  `wireMethods: ['pages.create', 'pages.read']`, assert
  `getServiceMethods('notion')` shows both methods, then call
  `shutdownAll()` and assert the entry collapses back to
  `undefined` (since `notion` has no built-ins).

### Notes

- 459 tests workspace-wide green (+1 over v1.2.5). No new public
  API. No wire shape changes.
- The only remaining v1.2.4-deferred item is the `__isGotongBridge`
  brand-vs-Symbol choice — left for v1.3 federation work where
  more brand fields will land at once.

---

## 3.0.0 dev journal — v1.2.5 boundary fuzz + Python SDK docstring

Two leftover items from the v1.2.4 audit's "can defer" list landed
together: parseVersion boundary fuzz tests and a one-paragraph
docstring clarifying that `register_service_methods` /
`unregister_service_methods` are TS-host-only (no Python equivalent).

### Added — `parseVersion` boundary fuzz tests

- `packages/sdk-node/tests/version-mismatch.test.ts` adds four
  boundary cases for protocolVersion: empty string, negative-prefixed
  (`'-1.2'`), whitespace-padded (`'  1.2  '`), and multi-component
  (`'1.2.3.4.5'`). All previously "accidentally safe" — the parser
  silently fell back to `[0, 0]` and the major-mismatch path returned
  without warning. Tests pin the behaviour: the SDK neither crashes
  nor emits a spurious warning on any of these shapes.

### Fixed — Python SDK docstring clarifies host-side scope

- `python-sdk/src/gotong/services.py` module docstring now says
  explicitly that the Python SDK is **client-side only**, and that
  the TypeScript host SDK's `registerServiceMethods` /
  `unregisterServiceMethods` have no Python counterpart by design
  (Python sidecars call into Hubs, they don't host one). Avoids
  future audits asking "where's the Python register/unregister?".
- Also bumped the docstring header from "(protocol v1.1)" to
  "(protocol v1.2)" — matches the actual constant in `protocol.py`.

### Notes

- 458 tests workspace-wide green (+4 over v1.2.4). No source-code
  changes beyond the docstring and four new tests.

---

## 3.0.0 dev journal — v1.2.4 pre-merge docs + regression guard

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

## 3.0.0 dev journal — v1.2.3 code-review polish + examples typecheck fix

Code-review pass over v1.2 / v1.2.1 / v1.2.2 surfaced nine small
issues. All are now resolved, plus a typecheck regression in examples
that v1.2 had quietly introduced.

### Fixed — `parseVersion` recognises pre-release tags

- `@gotong/sdk-node` was parsing protocol version strings via
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
  where two copies of `@gotong/sdk-node` resolve into the same
  graph. Added a `__isGotongBridge = true as const` brand and an
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
  exporting `isTeamBridge` from `@gotong/sdk-node`.

---

## 3.0.0 dev journal — v1.2.2 minor-debt cleanup

Second audit pass picked up three smaller issues that did not block
v1.2 from being self-consistent (v1.2.1 already handled those) but
would have made v1.3 startup awkward. None of them change wire shape;
all are additive on the SDK / runtime surface.

### Added — plugin lifecycle: `unregisterServiceMethods`

- `@gotong/protocol` gains `unregisterServiceMethods(type, methods)`,
  symmetric with `registerServiceMethods`. Designed for plugin hot-
  reload and clean host shutdown — a long-lived process that mounts
  and unmounts service plugins can now drop their wire methods from
  the runtime allowlist instead of leaking entries for the rest of
  the process. Built-in methods (`memory:recall`, `artifact:list`, …)
  are explicitly NOT removable; they are the floor of the allowlist.
- 4 new tests in `packages/transport-ws/tests/extend-allowlist.test.ts`
  cover symmetric remove, the built-in floor invariant, the empty-
  set collapse to `undefined`, and the no-op-on-bad-input contract.

### Added — cross-version safety warning in `@gotong/sdk-node`

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

- `gotong_service_call_duration_ms_sum` is a Prometheus counter and
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

## 3.0.0 dev journal — v1.2.1 audit patch (rollup)

The post-v1.2 audit found four claims in the v1.2 section below that
the code did not actually deliver. This rollup makes them real so the
v1.2 release ships a self-consistent story.

### Fixed — protocol version constant actually reaches `'1.2'`

- `packages/protocol/src/constants.ts` and
  `python-sdk/src/gotong/protocol.py` both **stayed on `'1.1'`** even
  after the v1.2 docs went live, so the server's WELCOME frame and the
  `gotong_protocol_version` info-metric both reported the wrong
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
  (`@gotong/sdk-node`) now:
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

### Fixed — `gotong new python-agent` produces a runnable layout

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
- 441 tests across `@gotong/{core,services-sdk,transport-ws,sdk-node,host,cli,web}`
  green on this patch. The Python SDK's `PROTOCOL_VERSION` bump is
  picked up automatically by tests that compare against the imported
  constant; no test-side changes were needed.

---

## 3.0.0 dev journal — observability + DevX + protocol v1.2 (post-v1.1)

Builds on the v1.1 services-over-WebSocket release. v1.2 is the
"close the loop" cycle: third-party plugins get a way to ship their
own wire methods, admins get observability over what remote agents
are doing, the Python SDK reaches feature parity, and a CLI lands
that lets sidecar authors skip the boilerplate.

### Added — protocol v1.2 (additive on v1.1, fully back-compat)

- **`registerServiceMethods(type, methods)`** in `@gotong/protocol`
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
  exposition. Series: `gotong_protocol_version` (info),
  `gotong_participants{kind}` (gauge), `gotong_tasks_total{kind}`
  (counter), `gotong_pending_applications` (gauge),
  `gotong_service_calls_total{type,impl,outcome}` (counter),
  `gotong_service_call_duration_ms_{sum,count}{type,impl}` (counter
  pair). Aggregated lazily from the transcript on each scrape — no
  extra in-memory bookkeeping.

### Added — Python SDK feature parity

- **`gotong.services` module** mirroring `@gotong/sdk-node`'s
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
- `PROTOCOL_VERSION` in `gotong.protocol` bumped to `'1.2'`. (Same
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
- **`@gotong/cli`** (`npx @gotong/cli`, bin: `gotong`) — new
  package. Subcommands:
  - `gotong new agent <name> [--capabilities=…] [--id=…] [--no-services]`
    — scaffold a TypeScript sidecar project (`package.json`,
    `tsconfig.json`, `src/index.ts`, `README.md`). Self-contained;
    `npm install && npm start` and you're online.
  - `gotong new python-agent <name> [...]` — same for Python
    (`pyproject.toml`, module-aware names).
  - `gotong ping <ws-url> [--api-key=…] [--timeout=…]` — handshake-
    only probe of a Hub for diagnostics. Uses `ws` directly to keep
    the CLI's transitive dep graph small.
  - `gotong help [cmd]`, `gotong --version`.
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

## 3.0.0 dev journal — services over WebSocket (wire protocol v1.1)

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
- **Method allowlist** hardcoded in `@gotong/protocol`:
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

### Added — server (`@gotong/transport-ws`)

- **`ServiceCallRouter`** (new module) — per-session router with a
  `(type, impl, ownerKey)` handle cache. Lazy attach on first call;
  `dispose()` detaches all on session close; `onAgentLeft(id)`
  detaches only that agent's `kind:'agent'` owners (other kinds —
  `workflow-run`, `shared` — survive per RFC §6).
- **`ServiceCallGateway`** interface in `server.ts` — narrow shape
  (`attach` + `detachFor`) so transport-ws stays free of
  `@gotong/host` and `@gotong/services-sdk` dependencies. Production
  hosts pass `HubServices` directly (structurally satisfies it).
- **`WebSocketTransportOptions.services?: ServiceCallGateway`** — when
  present, sessions get a router; when absent, every SERVICE_CALL
  replies `forbidden_service` (graceful degradation).
- **Session integration** — HELLO.services validated + router built
  in `handleHello`; SERVICE_CALL handled in `onMessage`; dispose on
  `cleanup`. Malformed decls return `REJECT bad_hello` before WELCOME.

### Added — SDK (`@gotong/sdk-node`)

- **`ServiceClient`** (new type) — exposes `memory`, `artifact`,
  `datastore: Record<name, …>` static-owner handles + `memoryFor` /
  `artifactFor` / `datastoreFor` factories for dynamic owners. The
  handle wrappers faithfully implement
  `@gotong/services-sdk`'s `MemoryHandle` / `ArtifactHandle` /
  `DatastoreHandle` contracts (incl. `DatastoreHandle.name` /
  `kv` / `sql` sub-namespaces), so agent code reads identically to
  in-process LlmAgent.
- **`ServiceCallError`** — surfaces `SERVICE_RESULT.ok: false` as a
  thrown `Error` subclass with `code` from the wire enum.
- **`ConnectOptions.services?: ServiceUseRequest[]`** + **`Session.services?: ServiceClient`** — agent author wires `coach.services = session.services` once after `await connect()` resolves.
- **`@gotong/services-sdk`** added as runtime dep so SDK users don't have to install services-sdk separately for the handle types. Type-only imports — no runtime size impact.
- Disconnect fails all pending RPCs with `session_not_ready` —
  consistent with how in-flight TASK frames are handled.

### Added — host wire-up (`@gotong/host`)

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

## 3.0.0 dev journal — case-conversation (v2.3)

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
- **Exported under `@gotong/host/services`** alongside the existing
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
- **`isTransientError`** exported from `@gotong/llm-openai` for
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

## 3.0.0 dev journal — Hub Services (v2.2)

A pluggable per-agent state layer. Agents declare what they want
(`memory`, `artifact`, `datastore`) in their yaml; the host attaches
typed handles at spawn time and keeps the bookkeeping. The Hub itself
gains nothing — Hub stays a "dumb dispatcher". All wiring sits in
`@gotong/services-sdk` + per-implementation plugin packages + the
host's integration layer.

### Added — services SDK + first-party plugins

- **`@gotong/services-sdk`** — the plugin contract. `ServicePlugin`
  with lifecycle (`init` / `validateConfig` / `attach` / `detach` /
  `softDelete` / `restore` / `hardDelete` / `describe` / `shutdown`),
  `ServiceRegistry`, `loadPlugins` dynamic-import loader with auto-seed
  of the default first-party manifest, `runPluginContract` shared
  vitest factory, typed errors (`PluginNotFoundError`,
  `TrashRestoreConflictError`, `ServiceConfigError`, …), and the
  `ServiceCtx` type the LlmAgent constructor accepts.
- **`@gotong/service-memory-file`** — JSONL files per
  `(owner, kind)`. `recall` is case-insensitive substring + kinds /
  since / k filters. Trash lives under the plugin's local `.trash/`.
- **`@gotong/service-artifact-file`** — per-owner directories with
  path-traversal defense, MIME allow-list, byte caps. List, exists,
  remove, recursive walk for `list({ prefix })`.
- **`@gotong/service-datastore-sqlite`** — one `.sqlite` per declared
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
  `services-sdk/node_modules/@gotong/` only contains `core`). Test
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
  `ServicesAdminSurface` interface in `@gotong/core` so
  `@gotong/web` never has to import the SDK.
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

- **`ManagedAgentSpec.uses?: ServiceUseSpec[]`** in `@gotong/core` and
  `parseManifest` validation in `@gotong/web`. Yaml authors declare
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
  `@gotong/host`.
- All three first-party plugin packages
  (`service-memory-file`, `service-artifact-file`,
  `service-datastore-sqlite`) are declared as **runtime dependencies**
  of `@gotong/host`, not devDependencies — without this the
  pnpm-isolated module graph hides them from the production resolver.
  Third-party plugins still resolve fine as long as they're installed
  somewhere reachable from the host package (`pnpm add` in the host
  workspace, or a deploy-time `npm i`).
- Existing agents with no `uses:` are unchanged. The optional field
  parses as `undefined`; LlmAgent without a `services` opt reads
  `EMPTY_SERVICE_CTX` (a frozen `{}`).
- Wire protocol (`docs/PROTOCOL.md`) is unchanged.

## 3.0.0 dev journal — workflow engine + CI (v2.1)

The pluggable workflow layer the Hub deliberately doesn't bundle. The
Hub stays "dumb dispatcher"; `@gotong/workflow` is a separate package
the host loads at boot. Workflows are YAML files; their runtime state is
JSON on disk; nothing about the Hub had to change.

### Added — `@gotong/workflow` (new package, file-first)

- **YAML schema `gotong.workflow/v1`** with: `trigger.capability`,
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

- **`@gotong/host`** scans `GOTONG_WORKFLOWS_DIR` (default
  `<space>/workflows/definitions/`) at boot and registers a runner per
  file. Default participant id is `workflow:<id>`.
- **`WorkflowController`** is the duck-typed `WorkflowSurface` the Web
  layer talks to. Methods: `list`, `importFromText`, `remove`,
  `listRuns`, `readRun`, `resumeRunningRuns`. The Web package does NOT
  take a runtime dependency on `@gotong/workflow` — the controller is
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

- `@gotong/workflow`: 82 tests (schema, resolver, runner, predicate,
  run-store, template parse smoke-check).
- `@gotong/host`: 19 tests (loader, controller — import / remove /
  history / resume orchestration).
- Workspace total: **316 passed / 2 skipped**.

### Distribution

- **No `npm publish` at this stage.** The earlier "queued for v2.1"
  plan to push `@gotong/*` to npmjs.com has been **descoped**. Source
  (`pnpm install && pnpm build && pnpm host`) and Docker
  (`docker compose up`) are the two supported install paths — both
  documented in [README](README.md) Quick start.
- **Open decision** — which JS registry, if any: stay source-only, JSR
  (jsr.io — GitHub OAuth, no separate account, native TS), or GitHub
  Packages (`@gotong` scope same as the GitHub org but users must
  configure `.npmrc`). Tracked in
  [RELEASE-CHECKLIST](.github/RELEASE-CHECKLIST.md).
- **Pre-built single-file binaries** for macOS (arm64 + x64) and
  Windows x64 are a planned but **non-blocking** item — Docker already
  covers the cross-platform "click and run" case. Bun `--compile` is
  the leading candidate; requires inlining `packages/web/static/*`
  before the binary is self-contained.
- **PyPI**: `gotong` is similarly source-only at this stage
  (`pip install -e python-sdk/`). PyPI publish decision moves alongside
  the JS-registry call.

### Author / committer hygiene

- All commits in the repo history now use the GitHub `users.noreply`
  alias as author and committer — eliminates the `<user>@<hostname>.local`
  leak the local-default git config introduces when `user.email` is
  unset. One-time `git rebase --root --exec 'git commit --amend
  --reset-author --no-edit'` rewrote 23 commits before the repo was
  pushed anywhere; nobody had to force-push.

## 3.0.0 dev journal — managed agents + encrypted API keys + template library (v2.1)

The "普通人 60 秒上线一个 agent" milestone. Adds host-managed LLM
agents, three import paths (UI form / paste / file upload), encrypted
on-disk API-key management, and a public template library for
community-shared agent + team configs.

### Added — encrypted API keys (UI input + at-rest crypto)

- **`<space>/secrets.enc.json`** holds workspace-level provider keys
  (anthropic, openai, …) and optional per-agent overrides, all encrypted
  with AES-256-GCM.
- **`<space>/runtime/secret.key`** holds the AES master key (32 bytes,
  hex, `0600`). Operators can override with `GOTONG_SECRET_KEY` env (64
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
- **`AgentSupervisor`** in `@gotong/host`: on boot, replays `agents.json`
  into live `LlmAgent` participants registered on the Hub. Same on
  every create / edit. `displayName` field added for human-friendly
  identifiers.
- **`ManagedAgentLifecycle`** interface exported from `@gotong/core` so
  the Web layer talks to the supervisor without importing
  `@gotong/llm-*` directly. `serveWeb({ lifecycle })` plugs the host's
  supervisor in.
- **Host package** now depends on `@gotong/llm`, `@gotong/llm-anthropic`,
  `@gotong/llm-openai` so a single `pnpm host` brings everything online.

### Added — manifest format + parser

- **`gotong.agent/v1`** (single agent) and **`gotong.team/v1`**
  (multiple agents bundled) schemas, accepted as YAML or JSON.
- Parser in `@gotong/web/manifest.ts` returns a typed `ParsedManifest`,
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
  for Gotong's single-turn task-payload → TaskResult model, added
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

## 3.0.0 dev journal — contribution scoreboard (v2.1)

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

## 3.0.0 dev journal — public-deployment hardening

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

### Added — new package `@gotong/host`
- Production binary that runs Hub + WebSocket + Web from environment variables. No demo agents, no test traffic.
- `gotong-host` bin entry; runnable via `pnpm host`.
- Env vars: `GOTONG_SPACE`, `GOTONG_HOST`, `GOTONG_WEB_PORT`, `GOTONG_WS_PORT`, `GOTONG_GATING`, `GOTONG_COOKIE_SECURE`, `GOTONG_ALLOWED_HOSTS`, `GOTONG_ADMIN_RATE_MAX`, `GOTONG_ADMIN_RATE_SEC`, `GOTONG_DEFAULT_LANG`, `GOTONG_HEARTBEAT_MS`, `GOTONG_SPACE_NAME`, `GOTONG_ADMIN_DISPLAY_NAME`.
- Graceful shutdown on SIGINT / SIGTERM: drains SSE clients, closes WS, calls `hub.stop()` before exit.

### Added — federation
- `TeamBridgeAgent` in `@gotong/sdk-node`: wraps a local Hub as one agent on an upstream Hub. Forwards tasks downward, reframes results upward with provenance (`localBy`, `localTaskId` in `output`). Optional `mapTask` callback to rewrite dispatch strategy.
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

