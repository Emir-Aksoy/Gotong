import type { TranscriptEntry } from '../types.js'

/**
 * Storage is the persistence boundary. v0 only persists the transcript;
 * future versions may add pending-task journals and participant registrations.
 *
 * All methods are async so a real backend (file / sqlite / network) can plug
 * in without changing the call sites.
 */
export interface Storage {
  /**
   * Tenant/namespace this storage belongs to (Route B P0-M1). A storage
   * instance is already scoped to one tenant's transcript — the physical
   * isolation lives upstream in how the path/db is resolved (see
   * `tenantRoot`). This field only lets higher layers (Hub, web, routing)
   * read back *which* tenant they're looking at without re-deriving it.
   *
   * Optional on the interface so external implementers aren't forced to set
   * it; the built-in storages always populate it (defaulting to
   * `DEFAULT_TENANT`).
   */
  readonly namespace?: string

  /** Load all previously persisted transcript entries, in seq order. */
  loadTranscript(): Promise<TranscriptEntry[]>

  /** Append a single entry. The Hub calls this for every event. */
  appendTranscriptEntry(entry: TranscriptEntry): Promise<void>

  /** Optional graceful shutdown hook (flush, close handles). */
  close?(): Promise<void>
}

export { InMemoryStorage } from './memory.js'
export { FileStorage } from './file.js'
export { SqliteStorage, type SqliteStorageOptions } from './sqlite.js'
