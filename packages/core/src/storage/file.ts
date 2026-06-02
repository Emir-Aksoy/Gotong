import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { appendFile, readFile, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { createLogger } from '../logger.js'
import { normalizeNamespace } from '../tenant.js'
import type { TranscriptEntry } from '../types.js'
import type { Storage } from './index.js'

const log = createLogger('storage/file')

/**
 * Default segment size before the active transcript file is sealed and a fresh
 * one started (Route B P0-M2). 8 MiB is large enough that small/test
 * workspaces never roll (so behaviour is byte-identical to the pre-segment
 * single file), and small enough that a busy hub produces bounded segment
 * files an archive/prune policy (M2b) can move out of the active load path.
 */
export const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024

/**
 * Append-only JSONL transcript, segmented by size (Route B P0-M2).
 *
 * Writes always go to the active file `<base>.jsonl`. When it grows past
 * `maxSegmentBytes` the active file is sealed — atomically renamed to
 * `<base>-NNNNNN.jsonl` (a monotonic, zero-padded segment number) — and a
 * fresh active file is started. `loadTranscript()` reads every sealed segment
 * in ascending number order followed by the active file, so the concatenation
 * is the full transcript in seq order: segmentation is invisible to callers.
 *
 * Crash-safety: one entry per line; a process that dies mid-write leaves at
 * most a corrupt trailing line in the active file, which `loadTranscript()`
 * skips with a warning. Sealing is a single `rename` (atomic on POSIX): a
 * crash right after the rename leaves the sealed segment and no active file —
 * the next append recreates the active file, and the load path reads the
 * sealed segment regardless. The write queue serialises rotation with appends
 * so no entry ever interleaves with a seal.
 *
 * For higher durability, swap in a SQLite-backed Storage later — the interface
 * is the same (and SqliteStorage already has an indexed seq column, so it does
 * not need file segmentation).
 */
export class FileStorage implements Storage {
  private writeQueue: Promise<void> = Promise.resolve()

  /** Tenant this transcript file belongs to (Route B P0-M1). The path is
   *  already tenant-resolved by the caller; this is the self-describing
   *  label, not a second source of truth for *where* bytes land. */
  readonly namespace: string

  private readonly dir: string
  /** `transcript` for an active path of `transcript.jsonl`. */
  private readonly base: string
  private readonly maxSegmentBytes: number
  /** Running byte size of the active file; seeded from disk on construction. */
  private activeBytes: number
  /** Number to assign the next sealed segment (one past the highest on disk). */
  private nextSegmentNo: number

  constructor(
    private readonly path: string,
    namespace?: string,
    maxSegmentBytes: number = DEFAULT_MAX_SEGMENT_BYTES,
  ) {
    this.namespace = normalizeNamespace(namespace)
    this.dir = dirname(path)
    this.base = basename(path).replace(/\.jsonl$/, '')
    // A non-positive cap disables rotation (single ever-growing file) — useful
    // for callers that want the legacy behaviour explicitly.
    this.maxSegmentBytes = maxSegmentBytes > 0 ? maxSegmentBytes : Infinity
    if (this.dir && !existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.activeBytes = existsSync(path) ? statSync(path).size : 0
    this.nextSegmentNo = this.scanMaxSegmentNo() + 1
  }

  async loadTranscript(): Promise<TranscriptEntry[]> {
    const out: TranscriptEntry[] = []
    // Sealed segments first (oldest → newest by segment number)...
    for (const seg of this.listSealedSegments()) {
      this.parseInto(out, await readFile(seg, 'utf8'), seg)
    }
    // ...then the active file (the newest entries).
    if (existsSync(this.path)) {
      this.parseInto(out, await readFile(this.path, 'utf8'), this.path)
    }
    return out
  }

  appendTranscriptEntry(entry: TranscriptEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n'
    const bytes = Buffer.byteLength(line, 'utf8')
    // serialize writes so concurrent appends never interleave bytes, and so a
    // seal (rename) is ordered with respect to the appends around it
    const next = this.writeQueue.then(async () => {
      await this.maybeRotate()
      await appendFile(this.path, line, 'utf8')
      this.activeBytes += bytes
    })
    this.writeQueue = next.catch(() => undefined)
    return next
  }

  async close(): Promise<void> {
    await this.writeQueue
  }

  // --- segmentation internals ----------------------------------------------

  /**
   * Seal the active file into the next sealed segment if it has reached the
   * size cap. Called inside the serialised write step, so it cannot race an
   * append. The size is checked *before* writing the incoming entry, so each
   * sealed segment is at least `maxSegmentBytes` (plus the one entry that
   * crossed the line) — never an unbounded active file.
   */
  private async maybeRotate(): Promise<void> {
    if (this.activeBytes < this.maxSegmentBytes) return
    if (!existsSync(this.path)) {
      // nothing to seal (fresh start); just reset the counter
      this.activeBytes = 0
      return
    }
    const sealed = this.segmentPath(this.nextSegmentNo)
    await rename(this.path, sealed)
    this.nextSegmentNo += 1
    this.activeBytes = 0
  }

  private segmentPath(n: number): string {
    return join(this.dir, `${this.base}-${String(n).padStart(6, '0')}.jsonl`)
  }

  /** Sealed segment files in ascending segment-number order. */
  private listSealedSegments(): string[] {
    return this.sealedSegmentEntries()
      .sort((a, b) => a.n - b.n)
      .map((e) => join(this.dir, e.name))
  }

  private scanMaxSegmentNo(): number {
    let max = 0
    for (const { n } of this.sealedSegmentEntries()) if (n > max) max = n
    return max
  }

  /** Match `<base>-NNNNNN.jsonl` siblings of the active file. */
  private sealedSegmentEntries(): Array<{ name: string; n: number }> {
    if (!this.dir || !existsSync(this.dir)) return []
    const re = new RegExp(`^${escapeRegExp(this.base)}-(\\d+)\\.jsonl$`)
    const out: Array<{ name: string; n: number }> = []
    for (const name of readdirSync(this.dir)) {
      const m = re.exec(name)
      if (m) out.push({ name, n: Number(m[1]) })
    }
    return out
  }

  private parseInto(out: TranscriptEntry[], raw: string, fromPath: string): void {
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      try {
        out.push(JSON.parse(line) as TranscriptEntry)
      } catch {
        // tolerate a trailing partial line from a crash
        if (i !== lines.length - 1) {
          log.warn('skipping malformed line', { line: i + 1, path: fromPath })
        }
      }
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
