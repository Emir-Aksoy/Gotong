import { normalizeNamespace } from '../tenant.js'
import type { TranscriptEntry } from '../types.js'
import type { Storage } from './index.js'

/**
 * Default storage for tests, demos, and ephemeral runs. Holds the transcript
 * in memory and forgets everything on process exit.
 */
export class InMemoryStorage implements Storage {
  private entries: TranscriptEntry[] = []

  /** Tenant this in-memory transcript belongs to (Route B P0-M1). */
  readonly namespace: string

  constructor(namespace?: string) {
    this.namespace = normalizeNamespace(namespace)
  }

  async loadTranscript(): Promise<TranscriptEntry[]> {
    return [...this.entries]
  }

  async appendTranscriptEntry(entry: TranscriptEntry): Promise<void> {
    this.entries.push(entry)
  }
}
