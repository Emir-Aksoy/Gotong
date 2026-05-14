/**
 * `@aipehub/service-datastore-sqlite`
 *
 * First-party `datastore:sqlite` ServicePlugin. Default export is a
 * factory matching the loader convention (see
 * `services-sdk/src/loader.ts pickPlugin()`) so each Hub load gets a
 * fresh instance.
 */

import { DatastoreSqlitePlugin } from './plugin.js'

export { DatastoreSqlitePlugin } from './plugin.js'
export { DatastoreSqliteHandle } from './handle.js'
export { validateDatastoreSqliteConfig, DEFAULT_MAX_BYTES } from './config.js'
export type { DatastoreSqliteConfig } from './config.js'

export default function createDatastoreSqlitePlugin(): DatastoreSqlitePlugin {
  return new DatastoreSqlitePlugin()
}
