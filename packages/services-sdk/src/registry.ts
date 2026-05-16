/**
 * ServiceRegistry — the Hub-side bookkeeping of loaded plugins.
 *
 * Keys are `(type, impl)` pairs; values are the loaded plugin object.
 * Used at two moments:
 *
 *   1. Host startup: loader fills the registry from `plugins.json`.
 *   2. Agent spawn: pool asks the registry for the plugin matching
 *      each `uses:` entry, then calls `plugin.attach(owner, config)`.
 *
 * The registry is intentionally a small class, not a global — tests
 * instantiate their own, hosts share one. Plugins themselves don't
 * see the registry; they only see `ServiceInitCtx`.
 *
 * Locking: in-memory map, single-threaded JS, no locks needed.
 * Concurrent attach calls per owner are the plugin's problem.
 */

import type { ServicePlugin, ServiceType } from './plugin.js'
import { PluginConflictError, PluginNotFoundError, PluginVersionMismatchError } from './errors.js'
import { majorMatches, SDK_MAJOR } from './version.js'

interface RegistryEntry {
  plugin: ServicePlugin
  /** True after `init()` has resolved. */
  initialized: boolean
  /** Set after `shutdown()` so re-init can happen. */
  shuttingDown: boolean
}

export class ServiceRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly hostMajor: number

  constructor(opts: { hostMajor?: number } = {}) {
    this.hostMajor = opts.hostMajor ?? SDK_MAJOR
  }

  /**
   * Register a plugin instance. Throws on `(type, impl)` collision
   * or major-version mismatch. Does NOT call `init` — caller must do
   * that separately so they can supply ServiceInitCtx (which requires
   * a rootDir the registry doesn't know).
   */
  register(plugin: ServicePlugin): void {
    if (!majorMatches(plugin.version, this.hostMajor)) {
      throw new PluginVersionMismatchError(
        `${plugin.type}:${plugin.impl}`,
        plugin.version,
        this.hostMajor,
      )
    }
    const key = registryKey(plugin.type, plugin.impl)
    if (this.entries.has(key)) {
      throw new PluginConflictError(plugin.type, plugin.impl)
    }
    this.entries.set(key, { plugin, initialized: false, shuttingDown: false })
  }

  /**
   * Unregister a plugin. Caller is responsible for calling
   * `plugin.shutdown()` first if needed. Safe to call on an
   * unregistered key (no-op).
   */
  unregister(type: ServiceType, impl: string): void {
    this.entries.delete(registryKey(type, impl))
  }

  /** Mark a plugin as initialized (called after `plugin.init` resolved). */
  markInitialized(type: ServiceType, impl: string): void {
    const e = this.entries.get(registryKey(type, impl))
    if (e) {
      e.initialized = true
      e.shuttingDown = false
    }
  }

  /** Look up a plugin by (type, impl). Throws if missing or unloaded. */
  find(type: ServiceType, impl: string): ServicePlugin {
    const e = this.entries.get(registryKey(type, impl))
    if (!e) throw new PluginNotFoundError(type, impl)
    return e.plugin
  }

  /** Same as {@link find} but returns undefined instead of throwing. */
  findOrUndefined(type: ServiceType, impl: string): ServicePlugin | undefined {
    return this.entries.get(registryKey(type, impl))?.plugin
  }

  /** Was the plugin's `init` ever run successfully? */
  isInitialized(type: ServiceType, impl: string): boolean {
    return this.entries.get(registryKey(type, impl))?.initialized === true
  }

  /** All currently registered plugins. Order: registration order. */
  all(): ReadonlyArray<ServicePlugin> {
    return [...this.entries.values()].map((e) => e.plugin)
  }

  /** Plugins grouped by type. Useful for admin UI listing. */
  byType(): ReadonlyMap<ServiceType, ServicePlugin[]> {
    const out = new Map<ServiceType, ServicePlugin[]>()
    for (const e of this.entries.values()) {
      const list = out.get(e.plugin.type) ?? []
      list.push(e.plugin)
      out.set(e.plugin.type, list)
    }
    return out
  }

  /** True iff anyone is registered for this (type, impl). */
  has(type: ServiceType, impl: string): boolean {
    return this.entries.has(registryKey(type, impl))
  }

  /**
   * Mark every plugin as shutting down. Used by the host on graceful
   * exit — combined with `forEachPlugin` to call `shutdown()` on each.
   */
  markAllShuttingDown(): void {
    for (const e of this.entries.values()) {
      e.shuttingDown = true
      e.initialized = false
    }
  }
}

function registryKey(type: ServiceType, impl: string): string {
  return `${type}:${impl}`
}
