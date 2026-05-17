/**
 * Static `import` of first-party service plugins so they get linked into
 * the binary at build time.
 *
 * Why this exists
 * ---------------
 * `bootstrap.ts` resolves plugin packages dynamically via
 * `import.meta.resolve(pkg)` + `import(...)`. That's exactly what we
 * want for `node` / `tsx` runs (it honours pnpm's isolated module graph
 * and lets operators install third-party plugins alongside the host).
 *
 * But under `bun build --compile`, the bundler can only see modules
 * reachable through *static* imports — a dynamic `import(<runtime-string>)`
 * resolves to "not found" because the resolver target doesn't exist
 * inside the embedded virtual filesystem at `/$bunfs/root/`.
 *
 * So: for the first-party plugins that should ship inside the binary,
 * we re-export them here as plain ESM imports. `hostAnchoredImport` in
 * `bootstrap.ts` checks this map *before* falling through to the
 * dynamic-import path, so binary builds get the bundled copy and
 * `node`/`tsx` runs continue to use the on-disk node_modules version
 * (they resolve identically — these imports just keep the bundler happy).
 *
 * What's NOT included
 * -------------------
 * `@aipehub/service-datastore-sqlite` is deliberately excluded. It
 * depends on `better-sqlite3`, which ships native `.node` bindings.
 * `bun build --compile` can embed plain JS, but native modules cannot
 * be loaded out of the embedded FS — bun would error at runtime when
 * `bindings('better_sqlite3.node')` walks the file system looking for
 * the prebuild. Operators who want SQLite-backed datastore should use
 * the npm or docker install paths instead. The binary still boots fine
 * without it; the warning line in `services: plugin failed to load` is
 * expected when the plugin appears in `plugins.json`.
 */

import * as memoryFile from '@aipehub/service-memory-file'
import * as artifactFile from '@aipehub/service-artifact-file'

/**
 * Map of fully-qualified package name → its loaded module namespace.
 * `hostAnchoredImport` short-circuits to a hit here before attempting
 * `import.meta.resolve(...)`.
 */
export const BUILTIN_PLUGINS: Readonly<Record<string, unknown>> = Object.freeze({
  '@aipehub/service-memory-file': memoryFile,
  '@aipehub/service-artifact-file': artifactFile,
})

/**
 * Package names suitable for seeding `plugins.json` when running inside
 * a `bun --compile` single-file binary. The same list as
 * `Object.keys(BUILTIN_PLUGINS)` — kept as a separate frozen array so
 * `main.ts` can pass it to `bootstrapServices.seedPlugins` without
 * iterating an object whose order isn't part of the contract.
 *
 * Used only when {@link isCompiledBinary} returns true. In `node` /
 * `tsx` mode we let `loadPlugins` fall back to its full default seed
 * (which includes `@aipehub/service-datastore-sqlite`) — those runtimes
 * can resolve `better-sqlite3` normally.
 */
export const BINARY_SAFE_PLUGINS: readonly string[] = Object.freeze([
  '@aipehub/service-memory-file',
  '@aipehub/service-artifact-file',
])

/**
 * True when the current process is the `bun --compile` single-file
 * binary (assets live under the embedded `/$bunfs/` virtual FS).
 *
 * Why detect at runtime rather than build time: the same compiled
 * `dist/main.js` ships to npm (where it runs under Node and can load
 * any plugin), and we bake it into the binary (where it can't). One
 * codebase, two seed lists, picked by inspecting where this module
 * actually got loaded from.
 */
export function isCompiledBinary(): boolean {
  return import.meta.url.startsWith('file:///$bunfs/') ||
    import.meta.url.startsWith('/$bunfs/') ||
    import.meta.url.startsWith('embedded://')
}
