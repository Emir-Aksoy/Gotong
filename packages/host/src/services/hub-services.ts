/**
 * `HubServices` — host-side facade for the loaded Hub Services.
 *
 * The pure plugin contract lives in `@aipehub/services-sdk`; this class
 * is the **glue** the host stitches on top: it owns the {@link ServiceRegistry},
 * keeps a bag of bookkeeping for which (plugin, owner) handles are
 * currently attached, and exposes the high-level methods the rest of
 * the host (LocalAgentPool, Web admin routes, lifecycle sweeps) calls.
 *
 * Why a separate class instead of folding it into `Hub`:
 *   - `@aipehub/services-sdk` already depends on `@aipehub/core` (for
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

import type { Logger } from '@aipehub/core'
import type {
  HubSurfaceForPlugins,
  Owner,
  ServicePlugin,
  ServiceRegistry,
  ServiceSnapshot,
  ServiceType,
  TrashRef,
} from '@aipehub/services-sdk'
import { PluginNotFoundError } from '@aipehub/services-sdk'

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
    // Plugins also publish their own `service_trashed` events through
    // the hub surface; we keep that responsibility there rather than
    // double-publish from here.
    return ref
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
