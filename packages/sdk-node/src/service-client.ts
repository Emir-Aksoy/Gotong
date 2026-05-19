/**
 * SDK-side WebSocket-backed implementation of the Hub Services handle
 * contracts (`MemoryHandle` / `ArtifactHandle` / `DatastoreHandle` from
 * `@aipehub/services-sdk`). Each handle method serialises into a
 * SERVICE_CALL frame and awaits a matching SERVICE_RESULT.
 *
 * # Why this exists
 *
 * The promise in `docs/AGENT.md` is that you can move an agent from
 * in-process to remote "without changing its logic". For that to hold,
 * a remote agent's view of `this.services.memory.recall(...)` must be
 * **the same TypeScript surface** as an in-process LlmAgent's. This
 * module exports `MemoryHandleClient` (implements `MemoryHandle`) etc.,
 * so an agent author writes the same `.recall(query)` either way.
 *
 * # Lifecycle
 *
 *   - One `ServiceClientImpl` per `connect()` Session. Holds the
 *     pending-call table + a reference back to the SessionImpl's `send`
 *     so RPC frames go out on the right socket.
 *   - The Session calls `attachResultFrame(frame)` for every incoming
 *     SERVICE_RESULT; the client resolves the matching pending call.
 *   - On disconnect/close, the Session calls `failAllPending(reason)`;
 *     awaiters reject with `ServiceCallError('session_not_ready', reason)`.
 *
 * # Caching
 *
 * Per-handle wrappers are cached by `(type, impl, ownerKey)` so the
 * agent author calling `memoryFor('file', {kind:'workflow-run', id:'X'})`
 * twice for the same case gets the same object — handy if they later
 * compare references.
 */

import { randomBytes } from 'node:crypto'

import type {
  ServiceCallFrame,
  ServiceErrorCode,
  ServiceOwner,
  ServiceResultFrame,
  ServiceUseDecl,
} from '@aipehub/protocol'
import type {
  ArtifactHandle,
  ArtifactRef,
  DatastoreHandle,
  KvHandle,
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
  SqlHandle,
} from '@aipehub/services-sdk'

import { DEFAULT_SERVICE_CALL_TIMEOUT_MS } from '@aipehub/protocol'

/**
 * Public form of a service declaration callers pass to `connect()`. Same
 * shape as the wire `ServiceUseDecl`, re-exported here for SDK-only
 * imports (users don't need to depend on `@aipehub/protocol` directly).
 */
export interface ServiceUseRequest {
  type: 'memory' | 'artifact' | 'datastore' | (string & {})
  impl: string
  owner: ServiceOwner | { kind: 'agent'; id: 'self' }
  config?: unknown
  /**
   * Optional per-method ACL narrowing (v1.2). If set, restricts this
   * connection to a subset of the type's wire-callable methods. Names
   * follow the `'method'` or `'namespace.method'` shape — max one dot.
   *
   * Use this to declare a strictly-read-only scope ahead of time so
   * admins can spot if your agent later tries to write:
   *
   *   services: [{
   *     type: 'memory', impl: 'file',
   *     owner: { kind: 'agent', id: 'self' },
   *     methods: ['recall', 'list'],   // refuses `remember` / `forget` etc.
   *   }]
   */
  methods?: readonly string[]
}

/**
 * A handle to a third-party service type. The SDK has no typed wrappers
 * for unknown contracts, so callers issue method calls dynamically via
 * `.call(method, ...args)`. Returned by `customFor()`.
 *
 * The method name is sent as-is on the wire and dispatched against the
 * plugin's `attach()`-returned handle on the host. The plugin's
 * `wireMethods` (set at host bootstrap) determines which names are
 * allowed.
 */
export interface CustomServiceHandle {
  /** Wire method name (e.g. `'pages.create'`). Bounded to one dot. */
  call(method: string, ...args: unknown[]): Promise<unknown>
}

/**
 * Aggregate facade an agent author reads from. Mirrors the in-process
 * `ServiceCtx` from `@aipehub/services-sdk`:
 *
 *   - Static-owner handles (`memory`, `artifact`, `datastore`) are
 *     populated based on the declarations passed to `connect()`. They're
 *     `undefined` when no matching declaration exists.
 *   - `*For(impl, owner)` factories produce a wrapper for any concrete
 *     owner that matches a declared pattern (incl. `id: '*'` wildcards).
 *     Repeat calls return cached wrappers.
 *   - `customFor(type, impl, owner)` is the dynamic-dispatch escape
 *     hatch for third-party service types (anything not in
 *     `BUILTIN_SERVICE_METHODS`).
 */
export interface ServiceClient {
  readonly memory?: MemoryHandle
  readonly artifact?: ArtifactHandle
  readonly datastore?: Record<string, DatastoreHandle>

  memoryFor(impl: string, owner: ServiceOwner): MemoryHandle
  artifactFor(impl: string, owner: ServiceOwner): ArtifactHandle
  datastoreFor(impl: string, owner: ServiceOwner): DatastoreHandle
  /**
   * Generic factory for third-party service types. Use when there is no
   * typed `*For` for the service category. The plugin must register its
   * wire methods at host bootstrap (see `ServicePlugin.wireMethods`),
   * else SERVICE_CALL returns `unknown_method`.
   */
  customFor(type: string, impl: string, owner: ServiceOwner): CustomServiceHandle
}

/**
 * Error surfaced when SERVICE_RESULT.ok is false. Code is the wire enum.
 */
export class ServiceCallError extends Error {
  readonly code: ServiceErrorCode
  readonly context?: unknown

  constructor(code: ServiceErrorCode, message: string, context?: unknown) {
    super(`[${code}] ${message}`)
    this.name = 'ServiceCallError'
    this.code = code
    if (context !== undefined) this.context = context
  }
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer?: NodeJS.Timeout
}

interface ServiceClientImplOptions {
  declarations: readonly ServiceUseRequest[]
  /** Sends a SERVICE_CALL frame out on the underlying WebSocket. */
  sendCall: (frame: ServiceCallFrame) => void
  /** Returns the calling agent's id — used for `from` field of SERVICE_CALL. */
  defaultAgentId: () => string
  /**
   * Default per-call timeout. Per-method override is not exposed in v1.1.
   */
  callTimeoutMs?: number
}

export class ServiceClientImpl implements ServiceClient {
  private readonly options: Required<Pick<ServiceClientImplOptions, 'callTimeoutMs'>> &
    ServiceClientImplOptions
  private readonly pending = new Map<string, PendingCall>()
  /** `${type}:${impl}:${ownerKind}/${ownerId}` → handle wrapper. */
  private readonly handleCache = new Map<string, unknown>()
  private callCounter = 0
  private closed = false

  readonly memory?: MemoryHandle
  readonly artifact?: ArtifactHandle
  readonly datastore?: Record<string, DatastoreHandle>

  constructor(opts: ServiceClientImplOptions) {
    this.options = { callTimeoutMs: DEFAULT_SERVICE_CALL_TIMEOUT_MS, ...opts }

    // Pre-populate top-level static-owner handles for the **first** matching
    // declaration of each type — this matches the in-process `ServiceCtx`
    // convention (`memory: MemoryHandle`, `artifact: ArtifactHandle`,
    // `datastore: Record<string, DatastoreHandle>`).
    //
    // A declaration with owner.id === '*' or 'self' is *also* exposed at the
    // top level — the SDK resolves the owner at first call time (via the
    // SERVICE_CALL frame), so the agent author can write:
    //
    //   this.services.memory.recall(...)
    //
    // and it Just Works for the common per-agent case.
    const memDecl = this.findDecl('memory')
    if (memDecl) this.memory = this.buildMemoryHandle('memory', memDecl.impl, this.resolveStaticOwner(memDecl))
    const artDecl = this.findDecl('artifact')
    if (artDecl) this.artifact = this.buildArtifactHandle('artifact', artDecl.impl, this.resolveStaticOwner(artDecl))
    // Datastore decls may carry a `config.name` so multiple datastores
    // can be addressed by name (matches services-sdk's
    // `ctx.datastore?.<name>`). We expose every datastore decl as a
    // separate entry, keyed by `config.name` (falling back to impl).
    const datastoreEntries: Record<string, DatastoreHandle> = {}
    for (const d of this.options.declarations) {
      if (d.type !== 'datastore') continue
      const name = (d.config as { name?: string } | undefined)?.name ?? d.impl
      datastoreEntries[name] = this.buildDatastoreHandle('datastore', d.impl, this.resolveStaticOwner(d))
    }
    if (Object.keys(datastoreEntries).length > 0) {
      this.datastore = datastoreEntries
    }
  }

  // --- ServiceClient surface ----------------------------------------------

  memoryFor(impl: string, owner: ServiceOwner): MemoryHandle {
    return this.cachedHandle('memory', impl, owner, () =>
      this.buildMemoryHandle('memory', impl, owner),
    )
  }

  artifactFor(impl: string, owner: ServiceOwner): ArtifactHandle {
    return this.cachedHandle('artifact', impl, owner, () =>
      this.buildArtifactHandle('artifact', impl, owner),
    )
  }

  datastoreFor(impl: string, owner: ServiceOwner): DatastoreHandle {
    return this.cachedHandle('datastore', impl, owner, () =>
      this.buildDatastoreHandle('datastore', impl, owner),
    )
  }

  customFor(type: string, impl: string, owner: ServiceOwner): CustomServiceHandle {
    return this.cachedHandle(type, impl, owner, () => ({
      call: (method: string, ...args: unknown[]) =>
        this.call(type, impl, owner, method, args),
    }))
  }

  // --- session integration -------------------------------------------------

  /**
   * Called by the session for every incoming SERVICE_RESULT frame. Resolves
   * the matching pending call. No-op if the callId is unknown (late
   * results / duplicates).
   */
  attachResultFrame(frame: ServiceResultFrame): void {
    const pending = this.pending.get(frame.callId)
    if (!pending) return
    this.pending.delete(frame.callId)
    if (pending.timer) clearTimeout(pending.timer)
    if (frame.ok) {
      pending.resolve(frame.value)
    } else {
      pending.reject(new ServiceCallError(frame.error.code, frame.error.message, frame.error.context))
    }
  }

  /**
   * Reject every pending call. Called by the session on close / fatal
   * disconnect so awaiters don't hang forever.
   */
  failAllPending(reason: string): void {
    this.closed = true
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new ServiceCallError('session_not_ready', reason))
    }
    this.pending.clear()
  }

  // --- internals ----------------------------------------------------------

  private findDecl(type: string): ServiceUseRequest | undefined {
    return this.options.declarations.find((d) => d.type === type)
  }

  /**
   * Resolve a declaration's owner pattern into a concrete owner for the
   * **static** top-level handle (`this.services.memory`). `'self'` is
   * substituted to the calling agent's id. `'*'` is rejected here — it
   * doesn't make sense for a static handle (no per-call owner); callers
   * that want wildcards must use `memoryFor(impl, owner)`.
   */
  private resolveStaticOwner(decl: ServiceUseRequest): ServiceOwner {
    const ownerKind = decl.owner.kind
    let ownerId = decl.owner.id
    if (ownerId === 'self') {
      ownerId = this.options.defaultAgentId()
    }
    if (ownerId === '*') {
      // The static-handle case can't address a wildcard owner; the agent
      // must call the factory. We return a sentinel-looking owner that
      // will get `forbidden_owner` from the server — surfacing the
      // misuse instead of silently picking an id.
      ownerId = '__wildcard_misuse__'
    }
    return { kind: ownerKind, id: ownerId }
  }

  private cachedHandle<T>(type: string, impl: string, owner: ServiceOwner, build: () => T): T {
    const key = `${type}:${impl}:${owner.kind}/${owner.id}`
    const existing = this.handleCache.get(key)
    if (existing) return existing as T
    const fresh = build()
    this.handleCache.set(key, fresh)
    return fresh
  }

  /**
   * Send one SERVICE_CALL frame and await the matching SERVICE_RESULT.
   * Throws `ServiceCallError` on `ok:false`; rejects with the same on
   * connection close or per-call timeout.
   */
  private async call(
    type: string,
    impl: string,
    owner: ServiceOwner,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    if (this.closed) {
      throw new ServiceCallError('session_not_ready', 'service client closed')
    }
    this.callCounter += 1
    // H8 — callId entropy comes from a CSPRNG, not Math.random().
    //
    // The local pending-call table matches purely on `callId`, so today
    // collisions are at worst "wrong handler resolves a stale frame
    // from the same session". Tomorrow's mux (SERVICE_RESULT routed
    // across sessions) makes this a security boundary, and after a
    // `fork()` Math.random() PRNGs share seed across processes — same
    // 6 bytes pop out in lockstep. `randomBytes(6).toString('hex')`
    // gives 48 bits of high-quality entropy, costs nothing measurable,
    // and stays the same 12 characters wide as the old form. See
    // AUDIT-v3.3.md finding H8.
    const callId = `c${this.callCounter.toString(36)}_${randomBytes(6).toString('hex')}`
    const frame: ServiceCallFrame = {
      type: 'SERVICE_CALL',
      callId,
      from: this.options.defaultAgentId(),
      service: { type, impl, owner },
      method,
      args,
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(callId)) return
        this.pending.delete(callId)
        reject(
          new ServiceCallError(
            'session_not_ready',
            `service call '${method}' timed out after ${this.options.callTimeoutMs}ms`,
          ),
        )
      }, this.options.callTimeoutMs)
      this.pending.set(callId, { resolve, reject, timer })
      try {
        this.options.sendCall(frame)
      } catch (err) {
        // Cleanup on send error.
        this.pending.delete(callId)
        clearTimeout(timer)
        reject(
          new ServiceCallError(
            'session_not_ready',
            `failed to send SERVICE_CALL: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      }
    })
  }

  // --- per-contract handle wrappers ---------------------------------------

  private buildMemoryHandle(type: string, impl: string, owner: ServiceOwner): MemoryHandle {
    const call = (method: string, args: readonly unknown[]) =>
      this.call(type, impl, owner, method, args)
    return {
      recall: (query: MemoryQuery) => call('recall', [query]) as Promise<MemoryEntry[]>,
      remember: (entry: NewMemoryEntry) => call('remember', [entry]) as Promise<MemoryEntry>,
      list: (opts?: { kind?: MemoryKind; limit?: number }) =>
        call('list', opts === undefined ? [] : [opts]) as Promise<MemoryEntry[]>,
      forget: (id: string) => call('forget', [id]) as Promise<void>,
      clear: (kind?: MemoryKind) =>
        call('clear', kind === undefined ? [] : [kind]) as Promise<void>,
    }
  }

  private buildArtifactHandle(type: string, impl: string, owner: ServiceOwner): ArtifactHandle {
    const call = (method: string, args: readonly unknown[]) =>
      this.call(type, impl, owner, method, args)
    return {
      write: (path: string, content: string | Uint8Array, opts?: { mime?: string }) =>
        call('write', opts === undefined ? [path, content] : [path, content, opts]) as Promise<ArtifactRef>,
      read: (refOrPath: string) =>
        call('read', [refOrPath]) as Promise<{ content: string; mime: string }>,
      list: (opts?: { prefix?: string }) =>
        call('list', opts === undefined ? [] : [opts]) as Promise<ArtifactRef[]>,
      exists: (refOrPath: string) => call('exists', [refOrPath]) as Promise<boolean>,
      remove: (refOrPath: string) => call('remove', [refOrPath]) as Promise<void>,
    }
  }

  /**
   * Build a `DatastoreHandle` whose `kv` / `sql` sub-namespaces forward every
   * method through SERVICE_CALL. The synchronous `name` field is resolved
   * eagerly from the matching declaration's `config.name` (falling back to
   * `impl` if no name was set), so reading `ds.name` doesn't require a RPC.
   */
  private buildDatastoreHandle(type: string, impl: string, owner: ServiceOwner): DatastoreHandle {
    const call = (method: string, args: readonly unknown[]) =>
      this.call(type, impl, owner, method, args)
    // Resolve `name` from the matching declaration's config; this only
    // matters for the static-owner top-level handles (where the agent
    // wrote `uses: [{datastore, name:'cases', ...}]` and reads
    // `ctx.datastore.cases`). For factory-built handles (dynamic owner),
    // the user already addresses by name via the factory, and the
    // `name` field is a best-effort echo of the impl string.
    const matchingDecl = this.options.declarations.find(
      (d) => d.type === type && d.impl === impl,
    )
    const name = (matchingDecl?.config as { name?: string } | undefined)?.name ?? impl
    const kv: KvHandle = {
      get: <T = unknown>(key: string) => call('kv.get', [key]) as Promise<T | undefined>,
      set: (key: string, value: unknown) => call('kv.set', [key, value]) as Promise<void>,
      del: (key: string) => call('kv.del', [key]) as Promise<void>,
      keys: (prefix?: string) =>
        call('kv.keys', prefix === undefined ? [] : [prefix]) as Promise<string[]>,
    }
    const sql: SqlHandle = {
      exec: (sqlStr: string, params?: unknown[]) =>
        call('sql.exec', params === undefined ? [sqlStr] : [sqlStr, params]) as Promise<{
          changes: number
        }>,
      query: <T = Record<string, unknown>>(sqlStr: string, params?: unknown[]) =>
        call('sql.query', params === undefined ? [sqlStr] : [sqlStr, params]) as Promise<T[]>,
    }
    return { name, kv, sql }
  }
}

/**
 * Convert SDK-public `ServiceUseRequest` shape to the wire `ServiceUseDecl`.
 * Currently 1:1; helper exists so we can evolve one without the other.
 */
export function toWireDecls(reqs: readonly ServiceUseRequest[]): ServiceUseDecl[] {
  return reqs.map((r) => ({
    type: r.type,
    impl: r.impl,
    owner: { kind: r.owner.kind, id: r.owner.id },
    ...(r.config !== undefined ? { config: r.config } : {}),
    ...(r.methods !== undefined && r.methods.length > 0 ? { methods: [...r.methods] } : {}),
  }))
}

