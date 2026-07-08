/**
 * MemoryFileHandle — the per-owner handle agents call.
 *
 * Implements {@link MemoryHandle} backed by jsonl files. One handle
 * per (plugin, owner); the Hub guarantees this.
 *
 * Concurrency: all writes to one OWNER are serialized through a single
 * PROCESS-WIDE promise chain keyed by the owner dir — NOT a per-handle chain.
 * The same owner is often written through more than one handle at once (the
 * resident butler's live captures, the 6h maintenance sweep's distillation, the
 * on-demand consolidate tool), and a full-file `forget`/`patchMeta` rewrite from
 * one handle would otherwise clobber a concurrent `appendFile` from another —
 * silent memory loss (audit P1). Sharing the chain by owner makes every writer
 * to a given member serialize. `fs.appendFile` on POSIX is atomic up to PIPE_BUF
 * (~4096 bytes) but a `MemoryEntry` can exceed that, so the chain also makes
 * "two concurrent remembers" safe. Reads are unsynchronised; with tmp+rename
 * rewrites they never observe a half-written file (parsing still skips bad lines
 * from a legacy tail).
 */

import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Logger } from '@gotong/core'
import type {
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
  Owner,
} from '@gotong/services-sdk'

import type { MemoryFileConfig } from './config.js'
import { generateEntryId } from './id.js'
import { kindFile, ownerDir, ownerLabel } from './paths.js'

const RECALL_DEFAULT_K = 20
const RECALL_MAX_K = 200
const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500

/**
 * Process-wide write chains keyed by resolved owner dir. EVERY `MemoryFileHandle`
 * to the same owner serializes through the SAME chain (see the file header). A
 * settled promise is tiny, so the map growing by distinct-owner count is fine.
 */
const ownerWriteChains = new Map<string, Promise<unknown>>()

/** A per-process-unique tmp sibling so a rewrite's tmp never collides. */
let tmpSeq = 0
function uniqueTmp(path: string): string {
  tmpSeq = (tmpSeq + 1) % 1_000_000_000
  return `${path}.tmp.${process.pid}.${tmpSeq}`
}

/** Atomically replace `path`'s contents (tmp+rename): a crash never leaves half a file. */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = uniqueTmp(path)
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, path)
}

export interface MemoryFileHandleOpts {
  rootDir: string
  owner: Owner
  config: MemoryFileConfig
  logger: Logger
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number
}

export class MemoryFileHandle implements MemoryHandle {
  private readonly rootDir: string
  private readonly owner: Owner
  private readonly config: MemoryFileConfig
  private readonly logger: Logger
  private readonly now: () => number
  /** Stable key into {@link ownerWriteChains} — resolved so spellings agree. */
  private readonly chainKey: string

  constructor(opts: MemoryFileHandleOpts) {
    this.rootDir = opts.rootDir
    this.owner = opts.owner
    this.config = opts.config
    this.logger = opts.logger.child({ owner: ownerLabel(opts.owner) })
    this.now = opts.now ?? Date.now
    this.chainKey = resolve(ownerDir(this.rootDir, this.owner))
  }

  async recall(query: MemoryQuery): Promise<MemoryEntry[]> {
    const allowedKinds = query.kinds && query.kinds.length > 0
      ? query.kinds.filter((k) => this.config.kinds.includes(k))
      : this.config.kinds
    const k = clamp(query.k ?? RECALL_DEFAULT_K, 1, RECALL_MAX_K)
    const text = query.text ? query.text.toLowerCase() : undefined
    const since = query.since ?? 0

    const all: MemoryEntry[] = []
    for (const kind of allowedKinds) {
      all.push(...await this.readAll(kind))
    }
    return all
      .filter((e) => e.ts >= since)
      .filter((e) => !text || e.text.toLowerCase().includes(text))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, k)
  }

  async remember(entry: NewMemoryEntry): Promise<MemoryEntry> {
    if (!this.config.kinds.includes(entry.kind)) {
      throw new Error(
        `kind '${entry.kind}' not allowed for this owner ` +
        `(configured: ${this.config.kinds.join(', ')})`,
      )
    }
    if (typeof entry.text !== 'string' || entry.text.length === 0) {
      throw new Error('memory entry text must be a non-empty string')
    }
    return this.serializeWrite(async () => {
      const ts = this.now()
      const id = entry.id ?? generateEntryId(ts)
      const persisted: MemoryEntry = {
        id,
        kind: entry.kind,
        text: entry.text,
        ts,
        ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
      }
      await this.ensureOwnerDir()
      const path = kindFile(this.rootDir, this.owner, entry.kind)
      await appendFile(path, JSON.stringify(persisted) + '\n', 'utf8')
      // Truncate if oversized (caller-configured cap).
      await this.maybeTruncate(entry.kind)
      return persisted
    })
  }

  async list(opts: { kind?: MemoryKind; limit?: number } = {}): Promise<MemoryEntry[]> {
    const limit = clamp(opts.limit ?? LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT)
    const kinds = opts.kind ? [opts.kind] : this.config.kinds
    const all: MemoryEntry[] = []
    for (const kind of kinds) {
      if (!this.config.kinds.includes(kind)) continue
      all.push(...await this.readAll(kind))
    }
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit)
  }

  async forget(id: string): Promise<void> {
    return this.serializeWrite(async () => {
      for (const kind of this.config.kinds) {
        const path = kindFile(this.rootDir, this.owner, kind)
        if (!await fileExists(path)) continue
        const raw = await readFile(path, 'utf8')
        const remaining: string[] = []
        let removed = false
        for (const line of raw.split('\n')) {
          if (!line) continue
          let entry: MemoryEntry | undefined
          try { entry = JSON.parse(line) as MemoryEntry } catch { /* corrupt line — skip */ }
          if (entry?.id === id) {
            removed = true
            continue
          }
          remaining.push(line)
        }
        if (removed) {
          await writeFileAtomic(path, remaining.join('\n') + (remaining.length > 0 ? '\n' : ''))
          return
        }
      }
    })
  }

  /**
   * Patch one entry's `meta` IN PLACE — shallow-merge `patch` over the stored
   * entry's meta, preserving id/kind/text/ts. Returns true if an entry with
   * `id` was found and rewritten, false otherwise (an unknown id is a no-op).
   *
   * This is the file-backed seam the resident butler's injected meta writers
   * wire to — close a validity interval, reinforce a recalled fact, grow a link
   * set — none of which mint a new id/ts, so a renderer keyed on those never
   * moves. Mirrors `forget`'s read-filter-rewrite and runs through the same
   * write chain; only the matched line is re-serialized (untouched lines are
   * rewritten verbatim, including corrupt ones, so patching never drops data).
   */
  async patchMeta(id: string, patch: Record<string, unknown>): Promise<boolean> {
    return this.serializeWrite(async () => {
      for (const kind of this.config.kinds) {
        const path = kindFile(this.rootDir, this.owner, kind)
        if (!await fileExists(path)) continue
        const raw = await readFile(path, 'utf8')
        const lines: string[] = []
        let patched = false
        for (const line of raw.split('\n')) {
          if (!line) continue
          let entry: MemoryEntry | undefined
          try { entry = JSON.parse(line) as MemoryEntry } catch { /* corrupt — keep verbatim */ }
          if (entry && entry.id === id) {
            const next: MemoryEntry = { ...entry, meta: { ...(entry.meta ?? {}), ...patch } }
            lines.push(JSON.stringify(next))
            patched = true
            continue
          }
          lines.push(line)
        }
        if (patched) {
          await writeFileAtomic(path, lines.join('\n') + '\n')
          return true
        }
      }
      return false
    })
  }

  async clear(kind?: MemoryKind): Promise<void> {
    return this.serializeWrite(async () => {
      const kinds = kind ? [kind] : this.config.kinds
      for (const k of kinds) {
        if (!this.config.kinds.includes(k)) continue
        const path = kindFile(this.rootDir, this.owner, k)
        await rm(path, { force: true })
      }
    })
  }

  // --- internals ----------------------------------------------------

  /**
   * Wait for any in-flight write to THIS OWNER (from any handle) to finish, run
   * `fn`, then chain the next. Shared across handles so concurrent subsystems
   * never clobber each other's file rewrites.
   */
  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const prev = ownerWriteChains.get(this.chainKey) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    ownerWriteChains.set(this.chainKey, next.then(noop, noop))
    return next
  }

  private async ensureOwnerDir(): Promise<void> {
    await mkdir(ownerDir(this.rootDir, this.owner), { recursive: true })
  }

  private async readAll(kind: MemoryKind): Promise<MemoryEntry[]> {
    const path = kindFile(this.rootDir, this.owner, kind)
    if (!await fileExists(path)) return []
    const raw = await readFile(path, 'utf8')
    const out: MemoryEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as MemoryEntry
        if (typeof e.id === 'string' && typeof e.text === 'string') out.push(e)
      } catch {
        this.logger.warn('skipping corrupt memory line', { kind, len: line.length })
      }
    }
    return out
  }

  private async maybeTruncate(kind: MemoryKind): Promise<void> {
    const cap =
      kind === 'episodic' ? this.config.maxEpisodicBytes
      : kind === 'semantic' ? this.config.maxSemanticBytes
      : undefined
    if (!cap) return
    const path = kindFile(this.rootDir, this.owner, kind)
    let size: number
    try { size = (await stat(path)).size } catch { return }
    if (size <= cap) return

    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    const keep = Math.max(1, Math.floor(lines.length / 2))
    const kept = lines.slice(-keep)
    await writeFileAtomic(path, kept.join('\n') + '\n')
    this.logger.info('truncated oversized memory file', {
      kind, sizeBefore: size, kept: keep, dropped: lines.length - keep,
    })
  }
}

// --- shared helpers ----------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function noop(): void { /* swallow */ }
