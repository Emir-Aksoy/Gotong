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
import { registerServiceMethods } from '@aipehub/protocol'
import {
  loadPlugins,
  PluginLoadError,
  ServiceRegistry,
  type HubSurfaceForPlugins,
  type ServiceInitCtx,
  type ServicePlugin,
} from '@aipehub/services-sdk'
import { join } from 'node:path'

import { BUILTIN_PLUGINS } from './builtin-plugins.js'
import { ensurePluginRootDir, HubServices } from './hub-services.js'

/**
 * Host-anchored ESM importer. Anchors `import()` resolution to **this
 * file's** location rather than `services-sdk/dist/loader.js`'s — pnpm's
 * isolated module graph means `services-sdk/node_modules/@aipehub/` only
 * contains `core`, so a naive `import(pkg)` from inside services-sdk
 * cannot find first-party plugin packages even when they're declared as
 * host dependencies.
 *
 * `import.meta.resolve(specifier)` is the ESM-aware Node 20+ resolver
 * (sync since 20.6, returns a `file://` URL string). It honours the
 * package's `exports.import` condition, so ESM-only plugin packages
 * (no CJS `main`) work — unlike `createRequire(...).resolve()`, which
 * fails on `exports`-only packages with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * Because `bootstrap.ts` lives inside the host package, the resolution
 * walk reaches the host's own `node_modules/@aipehub/` tree where pnpm
 * has laid down symlinks for every declared service plugin.
 *
 * Plugins that live OUTSIDE the host's dep tree (e.g. third-party
 * `my-org/aipehub-redis-memory` installed by an operator into the
 * space directory) won't resolve via this path. RFC §8 covers a future
 * `manifestPath`-anchored resolution; for now those plugins should be
 * installed alongside the host.
 */
async function hostAnchoredImport(pkg: string): Promise<unknown> {
  // First-party plugin? Return the statically-imported namespace from
  // `builtin-plugins.ts`. Node / tsx would have resolved this to the
  // exact same module via `import.meta.resolve` below, so this is a
  // pure short-circuit — its real purpose is to make `bun build
  // --compile` link the plugin code into the single-file binary, where
  // dynamic-import resolution against `/$bunfs/root/` fails.
  if (pkg in BUILTIN_PLUGINS) {
    return BUILTIN_PLUGINS[pkg]
  }

  // Prefer `import.meta.resolve` (sync, Node 20.6+) — it returns the
  // resolved `file://` URL string anchored to *this module's* location,
  // which is what gives us access to the host's `node_modules/@aipehub/`
  // tree. Honours `exports.import` so pure-ESM plugin packages work.
  //
  // Test runners (vite-node / vitest) don't implement
  // `import.meta.resolve`. In that environment we fall back to a bare
  // `import(pkg)` and let the bundler's resolver handle it — vite-node
  // doesn't enforce the pnpm-isolated `node_modules` walk Node does at
  // runtime, so plugin packages anywhere in the workspace are visible.
  const meta = import.meta as { resolve?: (s: string) => string }
  if (typeof meta.resolve === 'function') {
    return import(meta.resolve(pkg))
  }
  return import(/* @vite-ignore */ pkg)
}

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
  /**
   * Override the package list written into a freshly-seeded
   * `plugins.json`. When omitted, `loadPlugins` uses
   * `DEFAULT_FIRST_PARTY_PLUGINS`. The binary-build host uses this to
   * exclude `@aipehub/service-datastore-sqlite` (its `better-sqlite3`
   * native binding cannot be embedded by `bun --compile`).
   */
  seedPlugins?: readonly string[]
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
  //
  // We always pass an `importPackage` — defaulting to a host-anchored
  // resolver — because the SDK's own `import(pkg)` resolves relative
  // to `services-sdk/dist/loader.js`, which (under pnpm) cannot see
  // plugin packages declared as host dependencies. See the
  // `hostAnchoredImport` jsdoc above.
  const load = await loadPlugins({
    manifestPath,
    registry,
    ...(opts.seedDefaults !== undefined ? { seedDefaults: opts.seedDefaults } : {}),
    ...(opts.seedPlugins !== undefined ? { seedPlugins: opts.seedPlugins } : {}),
    importPackage: opts.importPackage ?? hostAnchoredImport,
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
      // Third-party plugins extend the SERVICE_CALL allowlist with their own
      // wire-callable methods. Built-in types already have their methods in
      // `BUILTIN_SERVICE_METHODS`; registration is a set-merge so an explicit
      // declaration here is harmless. See protocol/constants.ts.
      if (plugin.wireMethods && plugin.wireMethods.length > 0) {
        try {
          registerServiceMethods(plugin.type, plugin.wireMethods)
          logger.info('services: registered wire methods', {
            type: plugin.type,
            impl: plugin.impl,
            count: plugin.wireMethods.length,
          })
        } catch (err) {
          // Bad wireMethods (e.g. `'a.b.c'` paths) — log loudly but don't
          // abort: the plugin still works for in-process LlmAgents.
          logger.warn('services: registerServiceMethods refused', {
            type: plugin.type,
            impl: plugin.impl,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
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
