/**
 * `@aipehub/service-memory-file`
 *
 * First-party `memory:file` ServicePlugin. Default export is a
 * factory matching the loader convention (see
 * `services-sdk/src/loader.ts pickPlugin()`) so each Hub load gets a
 * fresh instance.
 *
 * Named exports expose the class + helpers for tests and direct use:
 *
 *   import { MemoryFilePlugin } from '@aipehub/service-memory-file'
 *   const plugin = new MemoryFilePlugin()
 */

import { MemoryFilePlugin } from './plugin.js'

export { MemoryFilePlugin } from './plugin.js'
export { MemoryFileHandle } from './handle.js'
export { validateMemoryFileConfig } from './config.js'
export type { MemoryFileConfig } from './config.js'

export default function createMemoryFilePlugin(): MemoryFilePlugin {
  return new MemoryFilePlugin()
}
