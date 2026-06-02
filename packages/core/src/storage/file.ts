import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

/** Retention policy for {@link FileStorage.archiveSegments}. */
export interface ArchiveOptions {
  /**
   * Keep this many of the most recent sealed segments in the active load path;
   * archive everything older. This is the primary lever for bounding boot
   * load. Undefined ⇒ 0 protected (eligible for archive, subject to `before`).
   */
  keepLast?: number
  /**
   * Only archive segments whose newest entry timestamp is strictly older than
   * this (epoch ms). Undefined ⇒ no age constraint. Combined with `keepLast`,
   * both conditions must hold.
   */
  before?: number
}

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
  /** Where archived (pruned-but-retained) segments live; excluded from load. */
  private readonly archiveDir: string
  /** `transcript` for an active path of `transcript.jsonl`. */
  private readonly base: string
  private readonly maxSegmentBytes: number
  /** Running byte size of the active file; seeded from disk on construction. */
  private activeBytes: number
  /** Number to assign the next sealed segment (one past the highest on disk). */
  private nextSegmentNo: number
  /** Path of the high-water-seq checkpoint (Route B P0-M2 M3). */
  private readonly hwmPath: string
  /** Highest seq ever persisted; survives archiving the loadable entries away. */
  private hwmSeq: number

  constructor(
    private readonly path: string,
    namespace?: string,
    maxSegmentBytes: number = DEFAULT_MAX_SEGMENT_BYTES,
  ) {
    this.namespace = normalizeNamespace(namespace)
    this.dir = dirname(path)
    this.archiveDir = join(this.dir, 'archive')
    this.base = basename(path).replace(/\.jsonl$/, '')
    // A non-positive cap disables rotation (single ever-growing file) — useful
    // for callers that want the legacy behaviour explicitly.
    this.maxSegmentBytes = maxSegmentBytes > 0 ? maxSegmentBytes : Infinity
    if (this.dir && !existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.activeBytes = existsSync(path) ? statSync(path).size : 0
    this.nextSegmentNo = this.scanMaxSegmentNo() + 1
    this.hwmPath = join(this.dir, `${this.base}.hwm`)
    this.hwmSeq = this.readHwmFile()
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

  // --- archive / prune (Route B P0-M2 M2b) ---------------------------------

  /**
   * Move old sealed segments into `archive/`, out of the active load path.
   * This is the "prune" of the plan: audit is never lost (the bytes just move
   * to a sibling directory that `loadTranscript()` does not scan), but the
   * boot load shrinks to the retained segments + active file — O(tail).
   *
   * A sealed segment is archived iff it is NOT among the `keepLast` highest-
   * numbered segments AND (when `before` is set) its newest entry is older than
   * `before`. The active file is never archived. Empty options are a no-op, so
   * a caller must state a policy explicitly. Returns the moved filenames.
   *
   * Moving is a single atomic `rename` per segment (same filesystem), so a
   * crash leaves each segment wholly in one directory or the other — never
   * lost, never duplicated.
   */
  async archiveSegments(opts: ArchiveOptions = {}): Promise<string[]> {
    const { keepLast, before } = opts
    if (keepLast === undefined && before === undefined) return []
    // Persist the high-water seq from the full history BEFORE moving anything.
    // Archiving removes entries from the boot load path; without a durable
    // record of the highest seq ever assigned, a later boot that finds every
    // entry archived away would reset seq to 0 and reissue numbers an archived
    // entry already owns. Recording it while all segments are still in place
    // means a crash mid-move can never lose it.
    await this.flushHighWaterSeq()
    const sealed = this.sealedSegmentEntries().sort((a, b) => a.n - b.n)
    const protectCount = keepLast ?? 0
    const protectedNs = new Set(
      sealed.slice(sealed.length - protectCount).map((e) => e.n),
    )
    const moved: string[] = []
    for (const seg of sealed) {
      if (protectedNs.has(seg.n)) continue
      if (before !== undefined) {
        const maxTs = await this.segmentMaxTs(join(this.dir, seg.name))
        // Keep a segment that has any entry at/after `before` (or no readable
        // ts at all — don't archive what we can't date).
        if (maxTs === undefined || maxTs >= before) continue
      }
      if (!existsSync(this.archiveDir)) mkdirSync(this.archiveDir, { recursive: true })
      await rename(join(this.dir, seg.name), join(this.archiveDir, seg.name))
      moved.push(seg.name)
    }
    return moved
  }

  /** Read archived segments (oldest→newest). For audit rebuild / export. */
  async loadArchivedSegments(): Promise<TranscriptEntry[]> {
    const out: TranscriptEntry[] = []
    for (const e of this.archivedSegmentEntries().sort((a, b) => a.n - b.n)) {
      this.parseInto(out, await readFile(join(this.archiveDir, e.name), 'utf8'), e.name)
    }
    return out
  }

  /**
   * The full transcript including archived segments, in seq order. Sorting by
   * the global monotonic `seq` (not by directory or filename) makes the rebuild
   * correct regardless of how segments were split between active and archive.
   */
  async loadAll(): Promise<TranscriptEntry[]> {
    const merged = [...(await this.loadArchivedSegments()), ...(await this.loadTranscript())]
    return merged.sort((a, b) => a.seq - b.seq)
  }

  /** Newest entry ts in a segment file, or undefined if none readable. */
  private async segmentMaxTs(path: string): Promise<number | undefined> {
    const raw = await readFile(path, 'utf8')
    let max: number | undefined
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as TranscriptEntry
        if (typeof e.ts === 'number' && (max === undefined || e.ts > max)) max = e.ts
      } catch {
        // skip unparseable line
      }
    }
    return max
  }

  // --- high-water seq checkpoint (Route B P0-M2 M3) ------------------------

  /**
   * Highest transcript seq ever persisted. Read from the checkpoint on
   * construction and refreshed whenever {@link archiveSegments} runs.
   * {@link Transcript.load} maxes the loadable entries against this so seq
   * stays monotonic even after archiving moved older segments out of the load
   * path — a reissued number can never collide with an archived entry.
   */
  highWaterSeq(): number {
    return this.hwmSeq
  }

  /** Recompute the high-water seq from the full history and persist it. */
  private async flushHighWaterSeq(): Promise<void> {
    const all = await this.loadAll()
    const maxSeq = all.length > 0 ? all[all.length - 1]!.seq : this.hwmSeq
    if (maxSeq > this.hwmSeq) this.hwmSeq = maxSeq
    this.writeHwmFile(this.hwmSeq)
  }

  /** Read the persisted high-water seq (0 if absent / unreadable / corrupt). */
  private readHwmFile(): number {
    try {
      if (!existsSync(this.hwmPath)) return 0
      const n = Number(readFileSync(this.hwmPath, 'utf8').trim())
      return Number.isInteger(n) && n >= 0 ? n : 0
    } catch {
      return 0
    }
  }

  /**
   * Persist the high-water seq via tmp-write + atomic rename, so a crash can't
   * leave a torn value. A lost / corrupt checkpoint simply reads back as 0; the
   * entries still on disk carry the true seq unless they were archived, and
   * archiving writes this first — so the number is never actually lost.
   */
  private writeHwmFile(seq: number): void {
    try {
      const tmp = `${this.hwmPath}.tmp`
      writeFileSync(tmp, String(seq), 'utf8')
      renameSync(tmp, this.hwmPath)
    } catch (err) {
      log.warn('failed to persist transcript high-water seq', { err })
    }
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
    // Scan BOTH the active dir and the archive dir so a new seal never reuses
    // a number that an archived segment already owns — segment numbers stay
    // globally monotonic even after every active segment has been archived.
    for (const { n } of this.sealedSegmentEntries()) if (n > max) max = n
    for (const { n } of this.archivedSegmentEntries()) if (n > max) max = n
    return max
  }

  /** Sealed `<base>-NNNNNN.jsonl` files in the active dir (loaded on boot). */
  private sealedSegmentEntries(): Array<{ name: string; n: number }> {
    return this.segmentEntriesIn(this.dir)
  }

  /** Archived segments (excluded from the active load path; audit only). */
  private archivedSegmentEntries(): Array<{ name: string; n: number }> {
    return this.segmentEntriesIn(this.archiveDir)
  }

  /** Match `<base>-NNNNNN.jsonl` files directly inside `dir` (non-recursive). */
  private segmentEntriesIn(dir: string): Array<{ name: string; n: number }> {
    if (!dir || !existsSync(dir)) return []
    const re = new RegExp(`^${escapeRegExp(this.base)}-(\\d+)\\.jsonl$`)
    const out: Array<{ name: string; n: number }> = []
    for (const name of readdirSync(dir)) {
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
