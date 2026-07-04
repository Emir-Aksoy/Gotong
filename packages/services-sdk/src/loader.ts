/**
 * Plugin loader — reads `plugins.json`, dynamic-imports each package,
 * registers what it finds.
 *
 * Failure is non-fatal: if a plugin can't load, we log + record an
 * error and move on. Agents whose yaml references the missing plugin
 * will fail at spawn time with a clear `PluginNotFoundError`.
 *
 * The loader does NOT call `plugin.init()` — that needs a per-plugin
 * `rootDir` the loader doesn't compute. Caller does init after load.
 *
 * Auto-seeding (RFC §18 question 4 = "auto-seed first-party"): when
 * `plugins.json` is absent and `seedDefaults` is true, the loader
 * writes a fresh manifest containing the three first-party packages.
 * `GOTONG_SERVICES_NO_SEED=1` disables this.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ServicePlugin, PluginsManifest, PluginEntry } from './plugin.js'
import { PluginLoadError } from './errors.js'
import { ServiceRegistry } from './registry.js'

/** Packages auto-seeded into `plugins.json` on first run. */
export const DEFAULT_FIRST_PARTY_PLUGINS: readonly string[] = [
  '@gotong/service-memory-file',
  '@gotong/service-artifact-file',
  '@gotong/service-datastore-sqlite',
]

export interface LoadPluginsOpts {
  /** Absolute path to `plugins.json`. */
  manifestPath: string
  /** Registry to fill. Caller usually creates a fresh one per host. */
  registry: ServiceRegistry
  /**
   * Auto-seed manifest with first-party plugins when the file is
   * absent. Default true. Disabled by `GOTONG_SERVICES_NO_SEED=1`.
   */
  seedDefaults?: boolean
  /**
   * Override the package list written when seeding. Defaults to
   * `DEFAULT_FIRST_PARTY_PLUGINS`. Hosts use this to exclude packages
   * that won't load in their environment — e.g. the single-file binary
   * build cannot load `@gotong/service-datastore-sqlite` because
   * `better-sqlite3`'s native binding can't be embedded, so the host
   * passes a list without it, sparing operators a spurious warning on
   * every first run.
   */
  seedPlugins?: readonly string[]
  /**
   * Resolver used by `dynamic import`. Defaults to the platform
   * import. Tests inject a fake that returns canned modules.
   */
  importPackage?: (pkg: string) => Promise<unknown>
}

export interface LoadPluginsResult {
  /** Plugins that loaded and were registered, in manifest order. */
  loaded: ServicePlugin[]
  /** Plugins that failed to load. Hub logs each + records in registry. */
  errors: PluginLoadError[]
  /** True iff the manifest had to be created. */
  seeded: boolean
}

/**
 * Read `manifestPath`, load each entry, register what works.
 *
 * Idempotent for already-loaded plugins: re-running with the same
 * registry is a noop. (Tests rely on this.)
 */
export async function loadPlugins(opts: LoadPluginsOpts): Promise<LoadPluginsResult> {
  const seedDefaults = opts.seedDefaults ?? defaultSeedFromEnv()
  const importPackage = opts.importPackage ?? defaultImporter

  let manifest: PluginsManifest
  let seeded = false
  try {
    const raw = await readFile(opts.manifestPath, 'utf8')
    manifest = JSON.parse(raw) as PluginsManifest
    validateManifest(manifest)
  } catch (err) {
    if (isMissingFile(err) && seedDefaults) {
      const seedList = opts.seedPlugins ?? DEFAULT_FIRST_PARTY_PLUGINS
      manifest = { plugins: [...seedList] }
      await mkdir(dirname(opts.manifestPath), { recursive: true })
      await writeFile(opts.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
      seeded = true
    } else if (isMissingFile(err)) {
      // Seeding disabled; no plugins to load is a valid configuration.
      manifest = { plugins: [] }
    } else {
      throw err
    }
  }

  const loaded: ServicePlugin[] = []
  const errors: PluginLoadError[] = []

  for (const entry of manifest.plugins) {
    const pkgName = entryPackage(entry)
    if (pkgName == null) continue            // skip `{ enabled: false }`
    if (opts.registry.has('__placeholder', pkgName)) continue  // never happens; guard
    try {
      const mod = await importPackage(pkgName)
      const plugin = pickPlugin(mod, pkgName)
      // If (type, impl) is already filed, distinguish two cases:
      //   - Same npm package re-loaded → idempotent no-op (tests rely
      //     on this; a host that calls loadPlugins twice during boot
      //     must not error).
      //   - Different package claims the same slot → surface as a
      //     conflict error so the operator sees that one package is
      //     silently hijacking another's (type, impl). Pre-3.1 this
      //     was a silent `continue` and a hostile or buggy manifest
      //     could swap in a shim plugin without any log line.
      if (opts.registry.has(plugin.type, plugin.impl)) {
        const owner = opts.registry.packageNameFor(plugin.type, plugin.impl)
        if (owner === pkgName) {
          continue
        }
        errors.push(
          new PluginLoadError(
            pkgName,
            new Error(
              `(type=${plugin.type}, impl=${plugin.impl}) is already registered by ${
                owner ?? '<unknown>'
              }; refusing to swap to ${pkgName}`,
            ),
          ),
        )
        continue
      }
      opts.registry.register(plugin, pkgName)
      loaded.push(plugin)
    } catch (err) {
      const loadErr = err instanceof PluginLoadError
        ? err
        : new PluginLoadError(pkgName, err)
      errors.push(loadErr)
    }
  }

  return { loaded, errors, seeded }
}

// --- helpers --------------------------------------------------------

function validateManifest(m: unknown): asserts m is PluginsManifest {
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error('plugins.json must be an object (got ' + describeKind(m) + ')')
  }
  if (!Array.isArray((m as PluginsManifest).plugins)) {
    throw new Error('plugins.json: "plugins" must be an array')
  }
}

function describeKind(v: unknown): string {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

function entryPackage(entry: PluginEntry): string | null {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.package === 'string') {
    if (entry.enabled === false) return null
    return entry.package
  }
  return null
}

function pickPlugin(mod: unknown, pkgName: string): ServicePlugin {
  if (!mod || typeof mod !== 'object') {
    throw new Error(`'${pkgName}' did not export a default value`)
  }
  const m = mod as Record<string, unknown>
  // Convention: default export is either a ServicePlugin instance
  // or a zero-arg factory that returns one. Both are common in npm
  // ESM packages.
  const candidate = (m.default ?? m) as unknown
  let plugin: unknown = candidate
  if (typeof candidate === 'function') {
    try {
      plugin = (candidate as () => unknown)()
    } catch (err) {
      throw new Error(`'${pkgName}' default-export factory threw: ${stringify(err)}`)
    }
  }
  if (!isPlugin(plugin)) {
    throw new Error(`'${pkgName}' did not export a valid ServicePlugin`)
  }
  return plugin
}

function isPlugin(x: unknown): x is ServicePlugin {
  if (!x || typeof x !== 'object') return false
  const p = x as Partial<ServicePlugin>
  return typeof p.type === 'string' &&
    typeof p.impl === 'string' &&
    typeof p.version === 'string' &&
    typeof p.init === 'function' &&
    typeof p.validateConfig === 'function' &&
    typeof p.attach === 'function' &&
    typeof p.detach === 'function' &&
    typeof p.softDelete === 'function' &&
    typeof p.restore === 'function' &&
    typeof p.hardDelete === 'function' &&
    typeof p.describe === 'function' &&
    typeof p.shutdown === 'function'
}

function isMissingFile(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function stringify(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

async function defaultImporter(pkg: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return import(/* @vite-ignore */ pkg as any)
}

function defaultSeedFromEnv(): boolean {
  return process.env.GOTONG_SERVICES_NO_SEED !== '1'
}
