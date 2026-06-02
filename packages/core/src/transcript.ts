import { createLogger } from './logger.js'
import type { Storage } from './storage/index.js'
import { DEFAULT_TENANT } from './tenant.js'
import type { TranscriptEntry } from './types.js'

const log = createLogger('transcript')

/**
 * Append-only event log. Every meaningful thing the Hub does becomes a
 * TranscriptEntry: a published message, a dispatched task, a result, a
 * participant joining or leaving. The seq number is monotonic and assigned
 * here.
 *
 * Persistence is delegated to a Storage. Persistence writes happen in the
 * background — the in-memory log is updated synchronously so callers always
 * see a consistent view.
 */
export class Transcript {
  private entries: TranscriptEntry[] = []
  private seq = 0
  private observers: Array<(entry: TranscriptEntry) => void> = []

  constructor(private readonly storage: Storage) {}

  /**
   * Tenant/namespace of the underlying storage (Route B P0-M1). Falls back
   * to {@link DEFAULT_TENANT} for any storage that predates the dimension
   * (an external `Storage` impl that doesn't set `namespace`).
   */
  namespace(): string {
    return this.storage.namespace ?? DEFAULT_TENANT
  }

  async load(): Promise<void> {
    const loaded = await this.storage.loadTranscript()
    this.entries = loaded
    if (loaded.length > 0) {
      const last = loaded[loaded.length - 1]!
      this.seq = last.seq
    }
  }

  append(entry: Omit<TranscriptEntry, 'seq'>): TranscriptEntry {
    this.seq += 1
    const full = { ...entry, seq: this.seq } as TranscriptEntry
    this.entries.push(full)
    this.storage.appendTranscriptEntry(full).catch((err) => {
      log.error('persist failed', { err })
    })
    for (const obs of this.observers) {
      try {
        obs(full)
      } catch (err) {
        log.error('observer threw', { err })
      }
    }
    return full
  }

  all(): TranscriptEntry[] {
    return [...this.entries]
  }

  tail(n: number): TranscriptEntry[] {
    return this.entries.slice(-n)
  }

  since(seq: number): TranscriptEntry[] {
    return this.entries.filter((e) => e.seq > seq)
  }

  size(): number {
    return this.entries.length
  }

  onAppend(handler: (entry: TranscriptEntry) => void): () => void {
    this.observers.push(handler)
    return () => {
      const i = this.observers.indexOf(handler)
      if (i >= 0) this.observers.splice(i, 1)
    }
  }
}
