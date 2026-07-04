/**
 * Plugin contract — the shape every service plugin (first-party or
 * third-party) implements.
 *
 * Lifecycle in order of calls:
 *
 *   1. `init(ctx)`                              once per host process
 *   2. `validateConfig(rawYaml)`                once per agent-uses-entry
 *   3. `attach(owner, validatedConfig)`         once per (plugin, owner)
 *      → returned handle is reused across all of that agent's tasks
 *   4. agent calls handle methods (recall, write, query, …)
 *   5. `detach(owner)`                          on agent leave
 *   6. *optional* `softDelete(owner)`           on admin delete agent
 *   7. *optional* `restore(trashRef)` or `hardDelete(trashRef)`
 *   8. `describe(owner)`                        anytime, for admin UI
 *   9. `shutdown()`                             once on host shutdown
 *
 * Plugins MUST be re-entrant — the Hub may call `init` again after a
 * `shutdown` during hot-reload. Plugins MUST NOT hold references to
 * `ServiceInitCtx` across a `shutdown`.
 */

import type { Logger } from '@gotong/core'
import type { Owner } from './owner.js'
import type { ServiceSnapshot } from './snapshot.js'
import type { TrashRef } from './trash.js'

/**
 * Stable service category. The Hub uses this to pick the right plugin
 * when an agent's yaml says `uses: [{ type: 'memory', impl: 'file' }]`.
 *
 * The union lists the categories the Hub specifically understands
 * (typed agent ctx surfaces them). Plugins are free to register their
 * own type string — the Hub will route to it but the ctx lookup is
 * untyped (`ctx as Record<string, unknown>`).
 */
export type ServiceType = 'memory' | 'artifact' | 'datastore' | (string & {})

export interface ServiceInitCtx {
  /**
   * Absolute path where this plugin should put its data, e.g.
   * `<space>/services/memory/file`. Always exists by the time `init`
   * is called.
   */
  rootDir: string
  /**
   * Per-plugin scoped logger. Child of host logger with bindings
   * `{ comp: 'service:<type>:<impl>' }`. Plugins SHOULD use this
   * rather than `console.*`.
   */
  logger: Logger
  /**
   * Read-only hub surface. Plugins use this to emit events (e.g.
   * `service_trashed`) without taking a runtime dep on `@gotong/core`'s
   * Hub class.
   */
  hub: HubSurfaceForPlugins
}

export interface HubSurfaceForPlugins {
  /** Plugin-injectable clock for tests. */
  now(): number
  /**
   * Append a transcript event. Plugins use this for non-cancellable
   * notifications (trash_added, plugin_load_failed). Failure to
   * publish must not abort the plugin call — the hub may not have a
   * transcript yet at startup.
   */
  publishEvent(kind: string, data: unknown): void
}

export interface ServicePlugin<TConfig = unknown, THandle = unknown> {
  /** Service category. */
  readonly type: ServiceType
  /** Implementation discriminator within a type. */
  readonly impl: string
  /** Semver. Major must match the host SDK major. */
  readonly version: string
  /** Optional one-liner for admin UI. */
  readonly description?: string
  /**
   * Optional wire-callable method names a remote agent may invoke against
   * the handle this plugin's `attach` returns. Used **only** for plugins
   * whose `type` is not in `BUILTIN_SERVICE_METHODS`; the host calls
   * `registerServiceMethods(type, wireMethods)` once at bootstrap so the
   * `ServiceCallRouter` can dispatch SERVICE_CALL frames against them.
   *
   * Plugins implementing the built-in `'memory'` / `'artifact'` /
   * `'datastore'` types should leave this `undefined` — the protocol
   * package already lists the canonical method names. Setting `wireMethods`
   * on a built-in type is harmless (registration merges sets, never
   * overrides) but adds no value.
   *
   * Names follow the `'method'` or `'namespace.method'` shape (max one
   * dot). The router refuses to dispatch deeper paths regardless of what
   * appears here.
   *
   * In-process LlmAgents do not consult this field — they call the
   * handle's methods directly. It only gates the WebSocket SDK path.
   */
  readonly wireMethods?: readonly string[]

  /**
   * Parse + validate a raw config blob from yaml. Throws
   * {@link ServiceConfigError} (or any Error — caller wraps) on
   * invalid input.
   *
   * Async per RFC §18 question 1: a SQLite plugin may want to test
   * `CREATE TABLE` syntax at validate-time. Sync plugins return
   * `Promise.resolve(parsed)` — there's no overhead beyond the
   * microtask.
   */
  validateConfig(raw: unknown): Promise<TConfig>

  /** One-time setup. Called before any `attach`. */
  init(ctx: ServiceInitCtx): Promise<void>

  /** Create / open the per-owner handle. */
  attach(owner: Owner, config: TConfig): Promise<THandle>

  /**
   * Close handle. Data stays on disk — soft delete is a separate
   * call. Idempotent: detach of an unattached owner is a no-op.
   */
  detach(owner: Owner): Promise<void>

  /**
   * Move owner's data to trash. Idempotent (re-call on same day
   * yields the same TrashRef). Plugin physically moves files into
   * `<rootDir>/.trash/<trashRef.id>/` (or its plugin-specific
   * equivalent).
   */
  softDelete(owner: Owner): Promise<TrashRef>

  /**
   * Restore from trash back to original owner key. Throws
   * {@link TrashRestoreConflictError} if the original owner slot
   * is currently in use.
   */
  restore(trashRef: TrashRef): Promise<void>

  /** Permanently delete a trash entry. Irreversible. */
  hardDelete(trashRef: TrashRef): Promise<void>

  /**
   * Admin UI snapshot. Plugins MUST return promptly (<100ms) and
   * cap `preview` at {@link PREVIEW_MAX_BYTES}. Heavy stats (full
   * size walk) should be cached.
   */
  describe(owner: Owner): Promise<ServiceSnapshot>

  /** Flush + close. Host waits up to N seconds on exit. */
  shutdown(): Promise<void>
}

/**
 * What's stored in `plugins.json`. The loader reads this list and
 * dynamic-imports each `package` in order.
 *
 *   { "plugins": [
 *       "@gotong/service-memory-file",
 *       { "package": "my-org/gotong-notion-artifact", "enabled": false }
 *     ]
 *   }
 */
export type PluginEntry = string | { package: string; enabled?: boolean }

export interface PluginsManifest {
  plugins: PluginEntry[]
}
