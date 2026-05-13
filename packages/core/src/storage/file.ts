import { existsSync, mkdirSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { createLogger } from '../logger.js'
import type { TranscriptEntry } from '../types.js'
import type { Storage } from './index.js'

const log = createLogger('storage/file')

/**
 * Append-only JSONL transcript file. One entry per line. Crash-safe enough
 * for v0: if the process dies mid-write, at most the last line is corrupt
 * and `loadTranscript()` skips it with a warning.
 *
 * For higher durability, swap in a SQLite-backed Storage later — the
 * interface is the same.
 */
export class FileStorage implements Storage {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {
    const dir = dirname(path)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  async loadTranscript(): Promise<TranscriptEntry[]> {
    if (!existsSync(this.path)) return []
    const raw = await readFile(this.path, 'utf8')
    const out: TranscriptEntry[] = []
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      try {
        out.push(JSON.parse(line) as TranscriptEntry)
      } catch {
        // tolerate a trailing partial line from a crash
        if (i !== lines.length - 1) {
          log.warn('skipping malformed line', { line: i + 1, path: this.path })
        }
      }
    }
    return out
  }

  appendTranscriptEntry(entry: TranscriptEntry): Promise<void> {
    // serialize writes so concurrent appends never interleave bytes
    const next = this.writeQueue.then(() =>
      appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8'),
    )
    this.writeQueue = next.catch(() => undefined)
    return next
  }

  async close(): Promise<void> {
    await this.writeQueue
  }
}
