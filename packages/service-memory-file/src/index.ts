/**
 * `@gotong/service-memory-file`
 *
 * First-party `memory:file` ServicePlugin. Default export is a
 * factory matching the loader convention (see
 * `services-sdk/src/loader.ts pickPlugin()`) so each Hub load gets a
 * fresh instance.
 *
 * Named exports expose the class + helpers for tests and direct use:
 *
 *   import { MemoryFilePlugin } from '@gotong/service-memory-file'
 *   const plugin = new MemoryFilePlugin()
 */

import { MemoryFilePlugin } from './plugin.js'

export { MemoryFilePlugin } from './plugin.js'
export { MemoryFileHandle } from './handle.js'
export { validateMemoryFileConfig } from './config.js'
export type { MemoryFileConfig } from './config.js'
// Path layout is one source of truth (asserts owner-id safety) — exported so a
// derived consumer (e.g. the butler's recall index reading the whole jsonl store,
// past `list`'s 500 cap) reuses it instead of re-deriving `<rootDir>/user/<id>/…`.
export { kindFile, ownerDir } from './paths.js'

export default function createMemoryFilePlugin(): MemoryFilePlugin {
  return new MemoryFilePlugin()
}
