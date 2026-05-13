import type { TranscriptEntry } from '../types.js'
import type { Storage } from './index.js'

/**
 * Default storage for tests, demos, and ephemeral runs. Holds the transcript
 * in memory and forgets everything on process exit.
 */
export class InMemoryStorage implements Storage {
  private entries: TranscriptEntry[] = []

  async loadTranscript(): Promise<TranscriptEntry[]> {
    return [...this.entries]
  }

  async appendTranscriptEntry(entry: TranscriptEntry): Promise<void> {
    this.entries.push(entry)
  }
}
