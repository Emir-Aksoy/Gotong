# AipeHub Hub Services — RFC

> Status: **DRAFT — PR-1 of 13**. This document defines the design.
> Implementation lands in PR-2 through PR-13. Sign-off required before PR-2.

## 1. Why this exists

The Hub today moves tasks between participants and records a transcript. That
covers "agent A finishes its work and hands a `TaskResult` to agent B," but it
does **not** cover any of the following — all of which a serious agent platform
needs:

| Capability | Today | After this RFC |
|---|---|---|
| Agent remembers what it did last time it was called | ❌ each `handleTask` is independent; history must be hand-passed via payload | ✅ via `memory` service |
| Workflow drops a markdown report mid-run, later steps cite it | ❌ outputs only live in `transcript.jsonl` (not human-readable) | ✅ via `artifact` service |
| Agent keeps a small SQLite table of "cases I've seen" | ❌ no SQL access primitive | ✅ via `datastore` service |
| Hierarchical, subscribable task state mid-run | ❌ `task.payload` is opaque | 🟡 deferred to MVP-2 (`task-state` service) |
| Third-party drops in their own backend (Notion as artifact, Postgres as datastore, Pinecone as vector index) | ❌ no extension point | ✅ plugin SDK is open from day 1 |

We unify all of this under **one concept: `Service`**. Not four loose features.

## 2. Mental model

```
                ┌─────────────────────────────────┐
                │             Hub                  │
                │  ┌──────────────────────────┐    │
                │  │   ServiceRegistry        │    │
                │  │  ┌───────┐ ┌──────────┐  │    │
                │  │  │memory │ │ artifact │  │    │
                │  │  └───────┘ └──────────┘  │    │
                │  │  ┌──────────────┐        │    │
                │  │  │ datastore    │ ...    │    │
                │  │  └──────────────┘        │    │
                │  └──────────────────────────┘    │
                │           ▲     ▲                 │
                └───────────│─────│─────────────────┘
                            │     │
                       attach     attach
                            │     │
                ┌───────────┴┐   ┌┴──────────────┐
                │  Agent A    │   │  Workflow X   │
                │  uses:      │   │  uses:        │
                │   memory    │   │   artifact    │
                │   artifact  │   │   task-state  │
                └─────────────┘   └───────────────┘
```

The Hub does not implement memory or sql or files. **Plugins** do. The Hub's job
is the same as always: routing. It routes a "I want a memory" request from
agent A to the `memory:file` plugin, gets back a handle, and gives that handle
to agent A.

**Three actors:**

1. **Hub** — owns the registry, lifecycle (load, init, shutdown), trash, quotas.
2. **Plugin** — implements one (type, impl) pair. Internal layout is its problem.
3. **Owner** — an agent id or workflow run id that gets a service handle attached.

## 3. The plugin contract

Every plugin — internal or third-party — implements the same shape. There is no
"internal interface" and "external interface." Concrete TypeScript:

```ts
// packages/services-sdk/src/plugin.ts

/** A service plugin: one (type, impl) pair. Registered with the Hub. */
export interface ServicePlugin<TConfig = unknown, THandle = unknown> {
  /** Service category. Stable string. e.g. 'memory', 'artifact', 'datastore'. */
  readonly type: ServiceType
  /** Implementation discriminator. e.g. 'file', 'sqlite', 'pinecone'. */
  readonly impl: string
  /** One-line description shown in admin UI. */
  readonly description?: string
  /** Semver. Mismatched majors refuse to load. */
  readonly version: string

  /** Parse + validate the `config:` block from agent/workflow yaml.
   *  Throws on invalid input (the Hub turns this into a 400 to the admin). */
  validateConfig(raw: unknown): TConfig

  /** Plugin-wide setup. Called once when the Hub loads the plugin.
   *  - rootDir: absolute path. Plugin allocates its files under here.
   *  - logger: per-plugin child logger.
   *  Plugins MUST be re-entrant: init may be called again after shutdown. */
  init(ctx: ServiceInitCtx): Promise<void>

  /** Attach this service to a specific owner (agent or run).
   *  Returns the handle agent code will call (recall/remember/read/write/...). */
  attach(owner: Owner, config: TConfig): Promise<THandle>

  /** Detach handle. Agent leaving the Hub. Data stays on disk. */
  detach(owner: Owner): Promise<void>

  /** Move owner's data to trash. Idempotent — already-trashed is a no-op. */
  softDelete(owner: Owner): Promise<TrashRef>

  /** Restore a trash entry to its original owner. Errors if owner taken. */
  restore(trashRef: TrashRef): Promise<void>

  /** Permanently delete a trash entry. Irreversible. */
  hardDelete(trashRef: TrashRef): Promise<void>

  /** Admin UI snapshot: size, last access, optional content preview. */
  describe(owner: Owner): Promise<ServiceSnapshot>

  /** Plugin shutdown. Flush, close handles. Hub waits for this on exit. */
  shutdown(): Promise<void>
}

export type ServiceType = 'memory' | 'artifact' | 'datastore' | (string & {})

export interface ServiceInitCtx {
  rootDir: string                                  // e.g. <space>/services/memory/file
  logger: Logger                                   // from @aipehub/core
  hub: {                                           // read-only hub surface
    now(): number
    publishEvent(kind: string, data: unknown): void   // for trash_added etc
  }
}

export interface Owner {
  kind: 'agent' | 'workflow-run' | 'shared'
  id: string                                      // agentId / runId / groupId
  /** Optional scope override. Default per Q1 = 'private'. */
  scope?: 'private' | 'workflow' | 'shared'
}

export interface TrashRef {
  id: string                  // uuid the Hub assigns
  type: ServiceType
  impl: string
  ownerKind: Owner['kind']
  ownerId: string
  deletedAt: number           // epoch ms
  expiresAt: number           // deletedAt + 30d (Q3 default; configurable per-space)
  reason?: string
}

export interface ServiceSnapshot {
  sizeBytes: number
  itemCount?: number
  lastAccess?: number
  preview?: { mime: string; text?: string; truncated?: boolean }
}
```

### 3.1 Per-type handle interfaces

Each `type` defines what `THandle` must look like. Plugin implementations
satisfy these:

```ts
// packages/services-sdk/src/types/memory.ts
export interface MemoryEntry {
  id: string                              // assigned by handle on remember
  kind: 'episodic' | 'semantic' | 'working'
  text: string                            // the recallable content
  meta?: Record<string, unknown>          // tags, taskId, agentId-of-origin etc
  ts: number
}

export interface MemoryHandle {
  recall(query: { text?: string; kinds?: MemoryEntry['kind'][]; k?: number; since?: number }): Promise<MemoryEntry[]>
  remember(entry: Omit<MemoryEntry, 'id' | 'ts'>): Promise<MemoryEntry>
  list(opts?: { kind?: MemoryEntry['kind']; limit?: number }): Promise<MemoryEntry[]>
  forget(id: string): Promise<void>
  clear(kind?: MemoryEntry['kind']): Promise<void>
}

// packages/services-sdk/src/types/artifact.ts
export interface ArtifactRef {
  /** Stable id usable in $stepId.artifact references. */
  ref: string
  path: string                             // relative path within artifact root
  size: number
  ts: number
  mime: string
}

export interface ArtifactHandle {
  write(path: string, content: string | Uint8Array, opts?: { mime?: string }): Promise<ArtifactRef>
  read(refOrPath: string): Promise<{ content: string; mime: string }>
  list(opts?: { prefix?: string }): Promise<ArtifactRef[]>
  exists(refOrPath: string): Promise<boolean>
  remove(refOrPath: string): Promise<void>
}

// packages/services-sdk/src/types/datastore.ts
export interface DatastoreHandle {
  kv: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    del(key: string): Promise<void>
    keys(prefix?: string): Promise<string[]>
  }
  sql: {
    /** Execute DDL/DML. Returns rows changed. */
    exec(sql: string, params?: unknown[]): Promise<{ changes: number }>
    /** SELECT with parameter binding. */
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  }
}
```

A plugin chooses **one** type and implements **one** of these handle interfaces.
A single plugin cannot serve two types.

### 3.2 Loading: same path for first-party and third-party

`.aipehub-demo/services/plugins.json` declares what the Hub loads at startup:

```json
{
  "plugins": [
    "@aipehub/service-memory-file",
    "@aipehub/service-artifact-file",
    "@aipehub/service-datastore-sqlite",
    "my-org/aipehub-notion-artifact"
  ]
}
```

If absent, the Hub seeds it with the three first-party plugins. Hub does
`dynamic import(name)` for each entry; the package's `default` export must be a
`ServicePlugin` instance (or a factory `() => ServicePlugin`).

**First-party = third-party at the loader level.** No `internal: true` flag, no
private API. The three first-party plugins are just packages whose maintainer
happens to be the AipeHub team.

### 3.3 Failure to load is non-fatal

If a plugin fails to import (missing package, throws at init), the Hub logs an
`error`-level message and continues without it. Agents that declared `uses: [{
type: 'memory', impl: 'file' }]` against the missing plugin will be **rejected
at spawn time** with a clear error (`provider 'memory:file' not registered`),
same shape as the existing `openai-compatible` key-missing rejection.

## 4. Owner, scope, isolation (Q1 = A)

Scope determines what owner key the plugin uses to file data:

| `scope` (yaml) | Owner.kind | Owner.id | Visibility |
|---|---|---|---|
| `private` (default) | `agent` | `<agentId>` | Only this agent |
| `workflow` | `workflow-run` | `<runId>` | All steps in this run; gone after the run completes |
| `shared:<group>` | `shared` | `<groupId>` | Any agent whose `uses.config.scope == 'shared:<group>'` |

Plugin implementers never see "scope" — they see an `Owner` and store data by
its `(kind, id)` pair. The Hub's `ServiceRegistry.attachFor()` translates the
yaml-level scope into the Owner before calling `plugin.attach()`.

**Default is private** — explicit per Q1. A leak that maps `agent` → `shared`
unintentionally must be impossible from the yaml side.

## 5. Trash + lifecycle (Q3 = A)

Default retention: **30 days**. Configurable per space via
`.aipehub-demo/space.json` → `services.trashRetentionDays`.

Lifecycle events:

| Trigger | Behavior |
|---|---|
| Admin deletes an agent | Hub calls `plugin.softDelete(owner)` for each service the agent used → `TrashRef[]` |
| Admin restores from trash | Hub calls `plugin.restore(trashRef)` → data back at original owner key, identical bytes |
| Trash entry past `expiresAt` | Hub calls `plugin.hardDelete(trashRef)` (on next sweep) |
| Hub shutdown | Plugins flush + `shutdown()` |
| Hub startup | Scans `.trash/`, schedules sweep, marks live registry |

### 5.1 Telling the user (Q3 "告知用户处理方式")

When `softDelete` succeeds the Hub publishes a transcript event:

```
{ kind: 'service_trashed',
  data: { trashRef, ownerLabel: 'agent:industry-coach', deletedBy: 'admin' } }
```

Admin UI displays a toast:

> 📁 **已移至废纸篓** — agent `industry-coach` 的 memory / artifact 数据
> 已保留在「服务 → 废纸篓」。**30 天后自动清理**，期间可恢复。

Toast also appears as a row in the Services tab's trash sub-view, with
**[恢复]** and **[立即清理]** buttons.

### 5.2 Sweep schedule

Hub schedules a sweep once on startup, then every 24h. Cheap (`readdir
.trash/` + filter by `expiresAt < now`). On dev hosts that restart often this
means stale entries linger a few extra hours — acceptable.

## 6. Agent yaml — `uses:`

Extends `ManagedAgentSpec` in `packages/core/src/space.ts`:

```yaml
agent:
  id: industry-coach
  capabilities: [intake]
  provider: openai-compatible
  baseURL: https://api.deepseek.com/v1
  model: deepseek-v4-flash
  uses:
    - type: memory
      impl: file
      config:
        scope: private             # default; can omit
        kinds: [episodic, semantic]
    - type: artifact
      impl: file
      config:
        name: diagnosis-reports    # plugin-specific
        format: md
    - type: datastore
      impl: sqlite
      config:
        name: industry-cases
        schema: |
          CREATE TABLE IF NOT EXISTS cases (
            id TEXT PRIMARY KEY,
            industry TEXT, role TEXT, summary TEXT, ts INTEGER
          );
  system: |
    You can call memory.recall, artifact.write, cases.kv.set, cases.sql.query…
```

`type` + `impl` is the plugin selector. `config` is opaque to the Hub —
forwarded verbatim to `plugin.validateConfig`.

The Hub validates only:
1. `type` + `impl` resolves to a loaded plugin
2. The plugin's `validateConfig` accepts the `config` block
3. Each `type` appears at most once per agent (rule, not enforced by plugin)

## 7. Agent ctx — what gets injected

`AgentParticipant.handleTask` gains a second arg:

```ts
// packages/core/src/participants/agent.ts
abstract class AgentParticipant {
  abstract handleTask(task: Task, ctx: ServiceCtx): Promise<unknown>
}

// Strongly typed when uses[] is statically known; loosely typed otherwise.
export interface ServiceCtx {
  memory?: MemoryHandle
  artifact?: ArtifactHandle
  datastore?: Record<string, DatastoreHandle>    // keyed by config.name
  // additional future services land here
}
```

Rules:

- Only services declared in `uses:` appear on ctx.
- A handle is **shared across all handleTask invocations** for an agent's
  lifetime (attach on join, detach on leave). Plugins must be thread-safe for
  concurrent task handling.
- `datastore` is plural because an agent can declare multiple datastores by
  different `name`s. `memory` and `artifact` are singular (one config per agent).

Back-compat: agents whose code is `handleTask(task)` keep working. The TypeScript
signature uses an optional second parameter. JS dynamic dispatch doesn't care
about arity.

## 8. Workflow `uses:` — deferred but reserved

Workflow steps can also declare `uses:` once we add `task-state` (MVP-2). For
this RFC we **reserve the field** in the yaml schema but the runner ignores it.
This lets us land yaml authors using it (forward-compat) without committing the
runner code.

## 9. Persistence layout

```
.aipehub-demo/
├─ services/
│  ├─ plugins.json                  # which plugins to load (above)
│  ├─ registry.json                 # live: { (type, impl, ownerKind, ownerId) → { size, lastAccess, configHash } }
│  ├─ memory/
│  │  └─ file/
│  │     └─ agent/<agentId>/
│  │        ├─ episodic.jsonl
│  │        ├─ semantic.md
│  │        └─ working/<taskId>.json
│  ├─ artifact/
│  │  └─ file/
│  │     ├─ agent/<agentId>/
│  │     │  └─ <userPath>.md
│  │     └─ workflow-run/<runId>/
│  │        └─ <userPath>.md
│  ├─ datastore/
│  │  └─ sqlite/
│  │     └─ agent/<agentId>/<name>.sqlite
│  └─ .trash/
│     └─ <trashRefId>/
│        ├─ meta.json               # TrashRef as written
│        └─ payload/                # original directory tree, moved (not copied)
└─ … (existing dirs)
```

Each plugin owns its sub-tree (`<type>/<impl>/<ownerKind>/<ownerId>/`). The Hub
owns `plugins.json`, `registry.json`, and `.trash/`. **Plugins must not touch
those.**

`registry.json` is rebuilt on startup by walking each plugin's sub-tree; it's a
cache, not the source of truth. Loss of `registry.json` is recoverable.

## 10. Admin REST surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/services` | All live (type, impl, owner) tuples + sizes |
| GET | `/api/admin/services/plugins` | Loaded plugin list (type/impl/version/desc/load error if any) |
| GET | `/api/admin/services/:type/:impl/:ownerKind/:ownerId` | Full snapshot incl. preview |
| GET | `/api/admin/services/:type/:impl/:ownerKind/:ownerId/preview` | Preview only (max 32 KB returned) |
| DELETE | `/api/admin/services/:type/:impl/:ownerKind/:ownerId` | Soft delete → returns TrashRef |
| GET | `/api/admin/services/trash` | All trash entries |
| POST | `/api/admin/services/trash/:id/restore` | Restore |
| DELETE | `/api/admin/services/trash/:id` | Hard delete |

All require admin auth (same `Authorization: Bearer` + cookie path as existing
admin endpoints). Preview is bounded (32 KB) and reads via the plugin's
`describe()` — plugin decides what's safe to show.

## 11. Agent ctx — wiring sequence

```
admin POST /api/admin/agents { id, uses: [...] }
   └─ server.ts validateAgentBody (incl. uses schema)
       └─ space.upsertAgent(record)
       └─ pool.start(record)
           └─ hub.services.attachFor(agentId, record.managed.uses)
               └─ for each use:
                    plugin = registry.find(type, impl)
                    config = plugin.validateConfig(use.config)
                    handle = await plugin.attach(owner, config)
                    handles[shorthand] = handle  // memory / artifact / etc
               └─ returns ServiceCtx
           └─ new LlmAgent(provider, defaults, ctx)
               └─ agent.bindCtx(ctx)   // stored, passed to handleTask
   └─ 200 OK
```

On agent leave (admin delete or process exit):

```
pool.stop(agentId)
   └─ hub.services.detachFor(agentId)
       └─ for each handle: plugin.detach(owner)
   └─ agent.shutdown()
```

On admin DELETE agent (Q3):

```
admin DELETE /api/admin/agents/:id
   └─ pool.stop(agentId)               // as above (data stays)
   └─ space.removeAgent(agentId)
   └─ hub.services.softDeleteFor(agentId)
       └─ for each plugin: plugin.softDelete(owner) → TrashRef
   └─ hub.publishEvent('service_trashed', { trashRefs, ownerLabel })
   └─ 200 OK
```

## 12. Concurrency, error policy, quotas

- **Concurrency:** Plugin handles are shared across concurrent `handleTask`
  calls. Plugins document their own concurrency model. The first-party `file`
  plugins serialize writes via in-process queue; reads are concurrent. The
  `sqlite` plugin uses `better-sqlite3`'s sync API (good enough; SQLite handles
  WAL internally).
- **Errors:** A plugin call that throws inside agent code propagates as a normal
  exception. The agent's `handleTask` catches → returns `{ kind: 'failed' }`
  TaskResult. Plugin errors do **not** crash the Hub.
- **Quotas:** Out of scope for MVP. Future: per-owner size cap, per-type rate
  limit. Add to `space.json` when needed.

## 13. Security

- **Path traversal:** Plugin-side concern. The `artifact-file` plugin must
  `normalize()` + check `startsWith(rootDir)` (same pattern as `serveStatic`).
- **Plugin trust:** Plugins run in the host process. A malicious plugin can do
  anything the host can. We document this — plugin trust = host trust.
  Sandboxing is not in scope for v1.
- **Secrets:** No secrets in plugin config. If a plugin needs a key (e.g.
  Pinecone) it reads from env vars / `secrets.enc.json` via a helper exposed
  on `ServiceInitCtx` (TBD; not needed by first-party plugins).
- **Cross-owner reads:** Plugins **must not** accept a different `Owner` in
  `attach` than the one given. Enforced by code review + a contract test that
  every plugin runs.

## 14. Testing strategy

| Layer | What | Where |
|---|---|---|
| Plugin SDK | Registry: register/lookup/version check/conflict | `services-sdk/tests/registry.test.ts` |
| Plugin SDK | Loader: missing package non-fatal, bad export rejected | `services-sdk/tests/loader.test.ts` |
| Each plugin | Standard contract test suite | `services-sdk/tests/contract.ts` (shared) — `it.each(plugins)` runs against every plugin |
| memory-file | jsonl append + concurrent write + recall + clear | `service-memory-file/tests/` |
| artifact-file | write/read/list + path traversal + binary | `service-artifact-file/tests/` |
| datastore-sqlite | kv CRUD + sql query + prepared stmt reuse | `service-datastore-sqlite/tests/` |
| Hub integration | attachFor + detachFor + softDelete + restore (in-memory plugins) | `core/tests/services.test.ts` |
| End-to-end | industry-coach agent → 2 task dispatches → recall verifies | `host/tests/e2e-services.test.ts` |

**Contract test suite** — defined in `services-sdk/tests/contract.ts`, runs the
same `describe()` block against every plugin: attach, write a sample, detach,
re-attach, verify persistence, softDelete, verify gone, restore, verify back.
Catches "my plugin behaves slightly different" bugs.

## 15. Not in scope (deferred)

- **task-state service** (MVP-2 — Q4 = A)
- **rag-index / vector retrieval** plugin (post-MVP)
- **Cross-Hub sync / federation** of services (different RFC)
- **Quotas** (per-owner size cap, rate limits)
- **Sandboxing** of third-party plugins (`vm.runInNewContext` etc)
- **Hot-reload** of plugin code without Hub restart

## 16. Migration path

Existing agents have no `uses:` field. They keep working unchanged — `uses`
defaults to `[]`, ctx is `{}`. Migration is purely opt-in:

1. Author edits agent yaml, adds `uses: [...]`
2. POST `/api/admin/agents/:id` updates the record (PUT endpoint)
3. Pool re-spawns the agent → new ctx
4. Old behavior on next dispatch: agent picks up service handles

No data migration. No transcript replay invalidation.

## 17. PRs that implement this

See `TodoWrite` list — PR-1 (this doc) through PR-13. Order is mostly
bottom-up: SDK → plugins → Hub → agent → REST → UI → e2e.

## 18. Open questions for sign-off

These will not change implementation of THIS document, but might shape PR-2:

1. **Should `validateConfig` be sync or async?** Currently sync. SQLite plugin
   wants async to test the schema at validate time. → Will go async in PR-2.
2. **TrashRef.id** — uuid or hash? Currently uuid. Hash makes it deterministic
   (re-soft-delete same owner → same id, idempotent). → Will use hash in PR-2.
3. **Per-plugin logger naming** — `service:memory:file` or
   `services.memory.file`? Mirrors the existing structured-logger key style. →
   Will use colons.
4. **Plugins.json discovery on first run** — auto-seed with first-party, or
   require explicit opt-in? Auto-seed for now; can disable with env var.

---

**End of RFC.** Sign off with "RFC ok" or comments on §3 / §4 / §5 / §11 to
adjust before PR-2 lands code.
