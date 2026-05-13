/**
 * `bootstrapServices` — wire `@aipehub/services-sdk` into a live host.
 *
 * Run once during host startup, after `Space.openOrInit` returns but
 * before any agent is spawned. The function:
 *
 *   1. Resolves the manifest path (`<space>/services/plugins.json`).
 *   2. Calls `loadPlugins` — auto-seeds the default first-party list on
 *      a fresh space, dynamic-imports each entry, registers everything
 *      that loads cleanly.
 *   3. For every successfully-registered plugin, mkdirs
 *      `<services>/<type>/<impl>/` and calls `plugin.init(ctx)` against
 *      that root dir.
 *   4. Returns the populated {@link HubServices} instance.
 *
 * **Plugin load failures do not crash the host.** A bad plugin shows
 * up as an entry in the returned `errors[]` and as a `warn` log line.
 * Agents whose yaml references a missing plugin will fail at spawn
 * time with a clear `PluginNotFoundError`.
 *
 * `plugin.init` failures DO remove the plugin from the registry — a
 * plugin that fails to set up its filesystem is worse than one that
 * never loaded (we'd keep handing out broken handles). The failure is
 * logged and added to `errors[]`.
 */

import { createLogger, type Hub, type Logger, type Space } from '@aipehub/core'
import {
  loadPlugins,
  PluginLoadError,
  ServiceRegistry,
  type HubSurfaceForPlugins,
  type ServiceInitCtx,
  type ServicePlugin,
} from '@aipehub/services-sdk'
import { join } from 'node:path'

import { ensurePluginRootDir, HubServices } from './hub-services.js'

export interface BootstrapServicesOpts {
  /** The space whose `<root>/services/` directory holds the manifest. */
  space: Space
  /**
   * Optional. When supplied, plugins can `publishEvent` into the hub's
   * transcript (typed `service_trashed` / `plugin_load_failed`). The
   * surface is read-only — plugins never see the full Hub.
   */
  hub?: Hub
  /**
   * Logger root. The bootstrap installs per-plugin child loggers with
   * bindings `{ comp: 'service:<type>:<impl>' }`. Default: a fresh
   * `createLogger('services')`.
   */
  logger?: Logger
  /**
   * Tests inject a fake importer that returns canned modules. Production
   * uses the platform's `import()`.
   */
  importPackage?: (pkg: string) => Promise<unknown>
  /**
   * Auto-seed `plugins.json` on first run. Default true. Disabled by
   * the env var `AIPE_SERVICES_NO_SEED=1`, which propagates into the
   * loader if this opt is unset.
   */
  seedDefaults?: boolean
}

export interface BootstrapServicesResult {
  services: HubServices
  /** Plugins that loaded **and** initialised cleanly. */
  ready: readonly ServicePlugin[]
  /** Plugins that failed to load, init, or were filtered out. */
  errors: readonly PluginLoadError[]
  /** True iff `plugins.json` was created during this call. */
  seeded: boolean
}

export async function bootstrapServices(
  opts: BootstrapServicesOpts,
): Promise<BootstrapServicesResult> {
  const logger = opts.logger ?? createLogger('services')
  const servicesDir = opts.space.paths.services
  const manifestPath = join(servicesDir, 'plugins.json')
  const registry = new ServiceRegistry()

  // Phase 1: load + register. Failures here are reported but do not
  // abort the host. The `loadPlugins` function is itself non-fatal.
  const load = await loadPlugins({
    manifestPath,
    registry,
    ...(opts.seedDefaults !== undefined ? { seedDefaults: opts.seedDefaults } : {}),
    ...(opts.importPackage ? { importPackage: opts.importPackage } : {}),
  })
  if (load.seeded) {
    logger.info('services: seeded default plugins.json', {
      path: manifestPath,
    })
  }
  for (const err of load.errors) {
    logger.warn('services: plugin failed to load', {
      pkg: err.packageName,
      cause: err.message,
    })
  }

  const hubSurface = makeHubSurface(opts.hub)

  // Phase 2: init each loaded plugin against its data dir. A plugin
  // that throws during init gets unregistered + recorded as an error;
  // the rest keep going. This is the same "one bad plugin doesn't
  // crash the host" contract as Phase 1.
  const ready: ServicePlugin[] = []
  const errors: PluginLoadError[] = [...load.errors]
  for (const plugin of load.loaded) {
    try {
      const rootDir = await ensurePluginRootDir(servicesDir, plugin.type, plugin.impl)
      const ctx: ServiceInitCtx = {
        rootDir,
        logger: logger.child({ comp: `service:${plugin.type}:${plugin.impl}` }),
        hub: hubSurface,
      }
      await plugin.init(ctx)
      registry.markInitialized(plugin.type, plugin.impl)
      ready.push(plugin)
      logger.info('services: plugin ready', {
        type: plugin.type,
        impl: plugin.impl,
        version: plugin.version,
      })
    } catch (err) {
      logger.error('services: plugin.init threw', {
        type: plugin.type,
        impl: plugin.impl,
        err,
      })
      // Drop the plugin from the registry so agents referencing it
      // fail loud at spawn time rather than crash on a half-init.
      registry.unregister(plugin.type, plugin.impl)
      errors.push(new PluginLoadError(`${plugin.type}:${plugin.impl}`, err))
    }
  }

  const services = new HubServices({ registry, logger, hubSurface })
  return { services, ready, errors, seeded: load.seeded }
}

/**
 * Adapt a {@link Hub} (or none) to the read-only surface plugins see.
 * Plugins emit transcript events through `publishEvent`; when no hub
 * is supplied (e.g. early-boot unit tests), publish is a no-op. The
 * `now` clock is also overridable in tests — we delegate to the hub's
 * `(this as any).now` private if present, otherwise `Date.now`.
 */
function makeHubSurface(hub: Hub | undefined): HubSurfaceForPlugins {
  if (!hub) {
    return {
      now: () => Date.now(),
      publishEvent: () => undefined,
    }
  }
  return {
    now: () => Date.now(),
    publishEvent: (kind, data) => {
      try {
        // Hub.transcript.append is the public path. Cast through
        // `unknown` to soften the `TranscriptEntry` discriminated-union
        // — plugin events are an open set, so we accept a string `kind`
        // the core's union doesn't enumerate. The transcript itself
        // doesn't validate `kind`; it just persists.
        ;(hub.transcript as unknown as {
          append: (e: { ts: number; kind: string; data: unknown }) => void
        }).append({
          ts: Date.now(),
          kind,
          data,
        })
      } catch {
        // Best-effort: a closed transcript at the tail of shutdown
        // must not propagate into the plugin call site.
      }
    },
  }
}
