import type { TranscriptEntry } from '../types.js'

/**
 * Storage is the persistence boundary. v0 only persists the transcript;
 * future versions may add pending-task journals and participant registrations.
 *
 * All methods are async so a real backend (file / sqlite / network) can plug
 * in without changing the call sites.
 */
export interface Storage {
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
