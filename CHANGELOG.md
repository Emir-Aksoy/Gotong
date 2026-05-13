# Changelog

All notable changes to AipeHub are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) at the npm-package level.

The npm scope is `@aipehub/*`; the PyPI package is `aipehub`. The wire protocol has its own version (currently `1.0`) and is governed by `docs/PROTOCOL.md` — major changes to the wire protocol bump that version, independent of these package versions.

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
