/**
 * `HubServices` — host-side facade for the loaded Hub Services.
 *
 * The pure plugin contract lives in `@gotong/services-sdk`; this class
 * is the **glue** the host stitches on top: it owns the {@link ServiceRegistry},
 * keeps a bag of bookkeeping for which (plugin, owner) handles are
 * currently attached, and exposes the high-level methods the rest of
 * the host (LocalAgentPool, Web admin routes, lifecycle sweeps) calls.
 *
 * Why a separate class instead of folding it into `Hub`:
 *   - `@gotong/services-sdk` already depends on `@gotong/core` (for
 *     the `Logger` type). Putting this glue inside `core` would close
 *     the loop and turn the workspace into a cycle.
 *   - The host is the only natural place that knows where the space
 *     directory lives and which plugins to import. Keeping the wiring
 *     here keeps `core` honest as a transport-agnostic library.
 *
 * Lifecycle (called by the host binary):
 *
 *   1. `bootstrapServices({ space, hub })` returns an initialised
 *      `HubServices` instance — every plugin in `plugins.json` has had
 *      its `init` resolved, the registry is filled.
 *   2. The instance is passed to `LocalAgentPool` (PR-8) and the Web
 *      admin layer (PR-11).
 *   3. On host shutdown the host calls `services.shutdownAll()` and
 *      awaits it before the process exits.
 *
 * Concurrency: every method is async and re-entrant; the host runs
 * single-threaded JS, so we rely on the JS event loop (not locks). If
 * two callers race on `attach` for the same (plugin, owner), the
 * plugin's own attach cache de-duplicates — see e.g.
 * `MemoryFilePlugin.attach`.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  Logger,
  ServicePluginDescriptor,
  ServiceSnapshotView,
  ServiceTarget,
  ServiceTrashRef,
  ServicesAdminSurface,
} from '@gotong/core'
import type {
  HubSurfaceForPlugins,
  Owner,
  ServicePlugin,
  ServiceRegistry,
  ServiceSnapshot,
  ServiceType,
  TrashRef,
} from '@gotong/services-sdk'
import { PluginNotFoundError } from '@gotong/services-sdk'
import { unregisterServiceMethods } from '@gotong/protocol'

/**
 * Shape of a `uses:` entry on an agent yaml. PR-7 will validate this
 * out of yaml; PR-5 only needs the shape so handle attachment can be
 * tested end-to-end. Configs are plugin-defined opaque blobs that get
 * passed through `plugin.validateConfig` before reaching `attach`.
 */
export interface ServiceUseSpec {
  type: ServiceType
  impl: string
  /** Owner key as the caller wants the plugin to file data under. */
  owner: Owner
  /** Raw config from yaml — plugin validates before use. */
  config: unknown
}

/**
 * One row in the host-side bookkeeping of currently-attached handles.
 * The host needs to know who's attached to what so a `detach` call on
 * agent leave can hit every plugin without asking the agent. Plugin
 * implementations have their own internal cache (per-owner handle); the
 * host's view is the **union of those caches** for tear-down purposes.
 */
interface AttachRecord<THandle = unknown> {
  plugin: ServicePlugin
  owner: Owner
  handle: THandle
}

export class HubServices {
  private readonly registry: ServiceRegistry
  private readonly logger: Logger
  private readonly hubSurface: HubSurfaceForPlugins
  /**
   * Keyed by `${type}:${impl}:${ownerKey}`. One row per live handle.
   * Cleared on `detachFor` and on `shutdownAll`.
   */
  private readonly attached = new Map<string, AttachRecord>()
  private stopped = false

  constructor(opts: {
    registry: ServiceRegistry
    logger: Logger
    hubSurface: HubSurfaceForPlugins
  }) {
    this.registry = opts.registry
    this.logger = opts.logger
    this.hubSurface = opts.hubSurface
  }

  // --- introspection -------------------------------------------------

  /** All currently-registered plugins. Stable registration order. */
  listPlugins(): readonly ServicePlugin[] {
    return this.registry.all()
  }

  /** True iff a plugin is registered for `(type, impl)`. */
  hasPlugin(type: ServiceType, impl: string): boolean {
    return this.registry.has(type, impl)
  }

  /**
   * Look up a plugin by `(type, impl)`. Throws
   * {@link PluginNotFoundError} when missing — callers in the admin
   * route layer translate that to a 404.
   */
  findPlugin(type: ServiceType, impl: string): ServicePlugin {
    return this.registry.find(type, impl)
  }

  // --- attach / detach -----------------------------------------------

  /**
   * Resolve a `uses:` block to live handles, one per spec entry.
   *
   * Order of operations per spec:
   *   1. `registry.find(type, impl)` → plugin
   *   2. `plugin.validateConfig(rawConfig)` → typed config
   *   3. `plugin.attach(owner, config)` → handle
   *   4. record the (plugin, owner, handle) tuple
   *
   * Failures are not swallowed: any thrown error from validate or
   * attach bubbles up so the agent spawn fails loudly with a clear
   * message rather than silently spawning a broken agent. The caller
   * (PR-8 LocalAgentPool) decides whether to skip the agent or abort.
   */
  async attachAll(specs: readonly ServiceUseSpec[]): Promise<AttachedHandle[]> {
    if (this.stopped) {
      throw new Error('HubServices: cannot attach after shutdown')
    }
    const out: AttachedHandle[] = []
    for (const spec of specs) {
      const plugin = this.registry.find(spec.type, spec.impl)
      const config = await plugin.validateConfig(spec.config)
      const handle = await plugin.attach(spec.owner, config)
      const key = attachKey(spec.type, spec.impl, spec.owner)
      this.attached.set(key, { plugin, owner: spec.owner, handle })
      out.push({ type: spec.type, impl: spec.impl, owner: spec.owner, handle })
    }
    return out
  }

  /**
   * Convenience for a single spec — the common case in tests and in
   * PR-11 admin endpoints. Same semantics as `attachAll([spec])[0]`.
   */
  async attach(spec: ServiceUseSpec): Promise<AttachedHandle> {
    const [h] = await this.attachAll([spec])
    return h!
  }

  /**
   * Detach every handle filed against `owner`. Idempotent — owners
   * with no live handles return [] without side effects. The plugin's
   * own `detach` is called even if the host's bookkeeping is empty,
   * because plugins may have their own caches we want to clear.
   *
   * Does NOT delete data. Use {@link softDelete} for that.
   */
  async detachFor(owner: Owner): Promise<DetachedHandle[]> {
    const out: DetachedHandle[] = []
    for (const [key, rec] of [...this.attached]) {
      if (rec.owner.kind !== owner.kind || rec.owner.id !== owner.id) continue
      try {
        await rec.plugin.detach(owner)
        out.push({ type: rec.plugin.type, impl: rec.plugin.impl, owner })
      } catch (err) {
        this.logger.error('plugin.detach threw', {
          type: rec.plugin.type,
          impl: rec.plugin.impl,
          owner: `${owner.kind}/${owner.id}`,
          err,
        })
      } finally {
        this.attached.delete(key)
      }
    }
    return out
  }

  /**
   * Currently-live handles for an owner. Read-only — meant for the
   * agent ctx surface (PR-6) and admin introspection. The returned
   * array is a snapshot; later attach/detach calls don't update it.
   */
  liveHandlesFor(owner: Owner): readonly AttachedHandle[] {
    const out: AttachedHandle[] = []
    for (const rec of this.attached.values()) {
      if (rec.owner.kind === owner.kind && rec.owner.id === owner.id) {
        out.push({
          type: rec.plugin.type,
          impl: rec.plugin.impl,
          owner: rec.owner,
          handle: rec.handle,
        })
      }
    }
    return out
  }

  // --- describe / soft delete / restore / hard delete ----------------

  /** Plugin-supplied snapshot. Throws if `(type, impl)` is unknown. */
  async describe(spec: {
    type: ServiceType
    impl: string
    owner: Owner
  }): Promise<ServiceSnapshot> {
    const plugin = this.registry.find(spec.type, spec.impl)
    return plugin.describe(spec.owner)
  }

  /**
   * Move owner's data to trash. Returns the {@link TrashRef} the
   * plugin emitted — the host stores it on the in-memory registry and
   * forwards it to the admin UI via SSE (PR-10).
   *
   * If the owner is currently attached the host detaches first; the
   * plugin's `softDelete` would otherwise be moving files out from
   * under an open handle. Detach is best-effort; we still call
   * `softDelete` even if detach throws (most plugins are robust against
   * the case, but logging the error is the right hygiene).
   *
   * After the plugin resolves we publish a `service_trashed` event
   * on the hub surface — the admin SSE stream picks it up and the UI
   * shows a "moved to trash; auto-deletes in 30 days" toast. Plugins
   * do NOT need to publish themselves; doing so here means a misbehaved
   * plugin can't accidentally double-publish.
   */
  async softDelete(spec: {
    type: ServiceType
    impl: string
    owner: Owner
    reason?: string
  }): Promise<TrashRef> {
    const plugin = this.registry.find(spec.type, spec.impl)
    // best-effort detach first so the plugin moves files cleanly
    const key = attachKey(spec.type, spec.impl, spec.owner)
    if (this.attached.has(key)) {
      try {
        await plugin.detach(spec.owner)
      } catch (err) {
        this.logger.warn('detach-before-soft-delete failed', {
          type: spec.type,
          impl: spec.impl,
          owner: `${spec.owner.kind}/${spec.owner.id}`,
          err,
        })
      } finally {
        this.attached.delete(key)
      }
    }
    const ref = await plugin.softDelete(spec.owner)
    // Plugin's softDelete signature doesn't take `reason` (it's a
    // facade-level concept the admin layer carries). We layer it onto
    // the published event from the caller's spec, falling back to the
    // ref's own reason if the plugin chose to set one.
    const reason = spec.reason ?? ref.reason
    this.hubSurface.publishEvent('service_trashed', {
      type: spec.type,
      impl: spec.impl,
      ownerKind: spec.owner.kind,
      ownerId: spec.owner.id,
      ref: {
        id: ref.id,
        deletedAt: ref.deletedAt,
        expiresAt: ref.expiresAt,
        ...(reason !== undefined ? { reason } : {}),
      },
    })
    return ref
  }

  /**
   * Soft-delete EVERY plugin's data for this owner. Used by the
   * admin "delete agent" flow: removing an agent's record from
   * `agents.json` doesn't (and shouldn't) wipe the disk — instead
   * we move the data to per-plugin trash so an admin who deleted by
   * mistake can `restore` within the retention window.
   *
   * Plugin-level failures are reported in the result but don't abort
   * the rest: a corrupt or missing plugin shouldn't strand the agent's
   * other data in limbo.
   */
  async softDeleteAllForOwner(
    owner: Owner,
    opts: { reason?: string } = {},
  ): Promise<Array<{ type: ServiceType; impl: string; ref?: TrashRef; error?: string }>> {
    const out: Array<{ type: ServiceType; impl: string; ref?: TrashRef; error?: string }> = []
    for (const plugin of this.registry.all()) {
      try {
        const ref = await this.softDelete({
          type: plugin.type,
          impl: plugin.impl,
          owner,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        })
        out.push({ type: plugin.type, impl: plugin.impl, ref })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.warn('softDeleteAllForOwner: plugin failed', {
          type: plugin.type, impl: plugin.impl, err: msg,
        })
        out.push({ type: plugin.type, impl: plugin.impl, error: msg })
      }
    }
    return out
  }

  /**
   * Walk every plugin's `listTrash()` (when implemented) and hard-
   * delete entries whose `expiresAt` is past `now`. Plugins that
   * don't expose `listTrash` are skipped silently — the contract
   * requires the basic lifecycle methods but `listTrash` is an
   * extension. Each purge publishes a `service_purged` event so the
   * admin UI can refresh its trash list in real time.
   */
  async sweepExpiredTrash(now: number = Date.now()): Promise<{
    scanned: number
    purged: number
  }> {
    let scanned = 0
    let purged = 0
    for (const plugin of this.registry.all()) {
      const listFn = (plugin as { listTrash?: () => Promise<TrashRef[]> }).listTrash
      if (typeof listFn !== 'function') continue
      let entries: TrashRef[]
      try {
        entries = await listFn.call(plugin)
      } catch (err) {
        this.logger.warn('sweepExpiredTrash: listTrash failed', {
          type: plugin.type, impl: plugin.impl, err,
        })
        continue
      }
      for (const ref of entries) {
        scanned += 1
        if (ref.expiresAt <= now) {
          try {
            await plugin.hardDelete(ref)
            purged += 1
            this.hubSurface.publishEvent('service_purged', {
              type: plugin.type,
              impl: plugin.impl,
              trashId: ref.id,
            })
          } catch (err) {
            this.logger.warn('sweepExpiredTrash: hardDelete failed', {
              type: plugin.type, impl: plugin.impl, trashId: ref.id, err,
            })
          }
        }
      }
    }
    return { scanned, purged }
  }

  /**
   * Walk every plugin's `listTrash()` and gather the union, tagged
   * by `(type, impl)`. The admin UI uses this to render the trash
   * tab; PR-10 also calls it from `sweepExpiredTrash`. Plugins that
   * don't expose `listTrash` contribute nothing (silent skip).
   */
  async listTrashAll(): Promise<Array<TrashRef & { type: ServiceType; impl: string }>> {
    const out: Array<TrashRef & { type: ServiceType; impl: string }> = []
    for (const plugin of this.registry.all()) {
      const listFn = (plugin as { listTrash?: () => Promise<TrashRef[]> }).listTrash
      if (typeof listFn !== 'function') continue
      try {
        const entries = await listFn.call(plugin)
        for (const ref of entries) {
          out.push({ ...ref, type: plugin.type, impl: plugin.impl })
        }
      } catch (err) {
        this.logger.warn('listTrashAll: plugin listTrash failed', {
          type: plugin.type, impl: plugin.impl, err,
        })
      }
    }
    return out
  }

  /** Restore from trash. Throws TrashRestoreConflictError on conflict. */
  async restore(ref: TrashRef): Promise<void> {
    const plugin = this.registry.find(ref.type, ref.impl)
    await plugin.restore(ref)
  }

  /** Permanently delete a trash entry. */
  async hardDelete(ref: TrashRef): Promise<void> {
    const plugin = this.registry.find(ref.type, ref.impl)
    await plugin.hardDelete(ref)
  }

  // --- shutdown ------------------------------------------------------

  /**
   * Stop every plugin. Called by the host on SIGINT / SIGTERM.
   * Best-effort: one plugin's slow shutdown does not abort the others.
   * After this returns the registry is marked shutting-down and further
   * `attach*` calls reject.
   */
  async shutdownAll(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.attached.clear()
    this.registry.markAllShuttingDown()
    for (const plugin of this.registry.all()) {
      try {
        await plugin.shutdown()
      } catch (err) {
        this.logger.error('plugin.shutdown threw', {
          type: plugin.type,
          impl: plugin.impl,
          err,
        })
      }
      // v1.2.6: roll back any wire-method registration this plugin did
      // at bootstrap so a long-lived process (e.g. hot-reload, test
      // harness mounting/unmounting plugins) doesn't leak entries in
      // the process-wide runtime allowlist. Built-in methods are
      // protected by the allowlist itself; this only removes the
      // plugin's third-party additions.
      if (plugin.wireMethods && plugin.wireMethods.length > 0) {
        try {
          unregisterServiceMethods(plugin.type, plugin.wireMethods)
        } catch (err) {
          // Symmetric throw policy with register — log loudly but
          // never let it break the rest of the shutdown sweep.
          this.logger.warn('unregisterServiceMethods refused on shutdown', {
            type: plugin.type,
            impl: plugin.impl,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  }

  // --- escape hatch --------------------------------------------------

  /**
   * Direct registry access — exposed for the rare consumer (admin REST
   * route in PR-11) that needs to iterate plugins by type. Prefer the
   * typed methods above for everyday code.
   */
  get _registry(): ServiceRegistry {
    return this.registry
  }

  /** Access the hub surface — used by plugin init in `bootstrapServices`. */
  get _hubSurface(): HubSurfaceForPlugins {
    return this.hubSurface
  }

  /**
   * Adapter view that satisfies the core-defined `ServicesAdminSurface`.
   * Web layer takes this — it doesn't need the rest of HubServices's
   * richer (host-internal) methods. The adapter is cheap to construct;
   * call repeatedly is fine.
   */
  asAdminSurface(): ServicesAdminSurface {
    return {
      listPlugins: (): readonly ServicePluginDescriptor[] => {
        return this.registry.all().map((p) => {
          const out: ServicePluginDescriptor = {
            type: p.type,
            impl: p.impl,
            version: p.version,
          }
          if (p.description) (out as { description?: string }).description = p.description
          return out
        })
      },
      describe: async (target: ServiceTarget): Promise<ServiceSnapshotView | null> => {
        const snap = await this.describe({
          type: target.type,
          impl: target.impl,
          owner: { kind: target.owner.kind as Owner['kind'], id: target.owner.id },
        })
        // The web layer renders empty-owner rows as "no data";
        // returning null here lets the UI filter rather than walk
        // a list of zero-byte snapshots.
        if (snap.sizeBytes === 0 && (snap.itemCount ?? 0) === 0 && !snap.preview) {
          return null
        }
        return toSnapshotView(snap)
      },
      softDelete: async (
        target: ServiceTarget & { reason?: string },
      ): Promise<ServiceTrashRef> => {
        const ref = await this.softDelete({
          type: target.type,
          impl: target.impl,
          owner: { kind: target.owner.kind as Owner['kind'], id: target.owner.id },
          ...(target.reason ? { reason: target.reason } : {}),
        })
        return toTrashView(ref, target.type, target.impl, target.reason)
      },
      restore: async (ref: ServiceTrashRef): Promise<void> => {
        await this.restore(fromTrashView(ref))
      },
      hardDelete: async (ref: ServiceTrashRef): Promise<void> => {
        await this.hardDelete(fromTrashView(ref))
      },
      listTrash: async (): Promise<readonly ServiceTrashRef[]> => {
        const all = await this.listTrashAll()
        return all.map((r) => toTrashView(r, r.type, r.impl, r.reason))
      },
      sweepExpired: async (now?: number): Promise<{ scanned: number; purged: number }> => {
        return this.sweepExpiredTrash(now ?? Date.now())
      },
    }
  }
}

function toSnapshotView(snap: ServiceSnapshot): ServiceSnapshotView {
  const out: ServiceSnapshotView = { sizeBytes: snap.sizeBytes }
  if (snap.itemCount !== undefined) (out as { itemCount?: number }).itemCount = snap.itemCount
  if (snap.lastAccess !== undefined) (out as { lastAccess?: number }).lastAccess = snap.lastAccess
  if (snap.preview) (out as { preview?: ServiceSnapshotView['preview'] }).preview = snap.preview
  return out
}

function toTrashView(
  ref: TrashRef,
  type: string,
  impl: string,
  reasonOverride?: string,
): ServiceTrashRef {
  const reason = reasonOverride ?? ref.reason
  const out: ServiceTrashRef = {
    id: ref.id,
    type,
    impl,
    ownerKind: ref.ownerKind,
    ownerId: ref.ownerId,
    deletedAt: ref.deletedAt,
    expiresAt: ref.expiresAt,
  }
  if (reason !== undefined) (out as { reason?: string }).reason = reason
  return out
}

function fromTrashView(ref: ServiceTrashRef): TrashRef {
  const out: TrashRef = {
    id: ref.id,
    type: ref.type,
    impl: ref.impl,
    ownerKind: ref.ownerKind as Owner['kind'],
    ownerId: ref.ownerId,
    deletedAt: ref.deletedAt,
    expiresAt: ref.expiresAt,
  }
  if (ref.reason !== undefined) (out as { reason?: string }).reason = ref.reason
  return out
}

/** Live handle returned from {@link HubServices.attach}. */
export interface AttachedHandle {
  readonly type: ServiceType
  readonly impl: string
  readonly owner: Owner
  readonly handle: unknown
}

/** Tear-down record returned from {@link HubServices.detachFor}. */
export interface DetachedHandle {
  readonly type: ServiceType
  readonly impl: string
  readonly owner: Owner
}

/** Helper that callers use to compute the per-plugin data dir. */
export function pluginRootDir(servicesDir: string, type: ServiceType, impl: string): string {
  return join(servicesDir, type, impl)
}

/**
 * Ensure the per-plugin data dir exists. Called from
 * `bootstrapServices` before `plugin.init` — keeps every plugin's
 * `init` impl free of an mkdir dance.
 */
export async function ensurePluginRootDir(
  servicesDir: string,
  type: ServiceType,
  impl: string,
): Promise<string> {
  const dir = pluginRootDir(servicesDir, type, impl)
  await mkdir(dir, { recursive: true })
  return dir
}

function attachKey(type: ServiceType, impl: string, owner: Owner): string {
  return `${type}:${impl}:${owner.kind}/${owner.id}`
}
