/**
 * butler-recall-index.ts — the host side of the default-recall index (MR1).
 *
 * The leaf (`@gotong/personal-memory` `InvertedIndex` / `invertedIndexRetriever`)
 * is the pure algorithm: it spans the WHOLE store so a relevant fact older than
 * `lexicalRetriever`'s recency window still becomes a candidate. But the leaf is
 * stateless about freshness — it just ranks whatever index you hand it. This
 * module is the host's job: keep that index in sync with the jsonl, persist it so
 * a restart doesn't pay a cold rebuild, and hand the butler a `MemoryRetriever`
 * that's always current.
 *
 * # jsonl is truth; the index is a rebuildable cache (北极星: file-first)
 *
 * Correctness rests on a cheap WATERMARK, not on bookkeeping every write: the
 * fingerprint is each kind file's `size:mtime`. Any write (remember, forget,
 * patchMeta from the F/E/D writers, a consolidation rewrite, forgetAll) changes a
 * file's stats → the watermark drifts → the next `ensureFresh` rebuilds from the
 * jsonl. So the index can never silently diverge from the source of truth — at
 * worst it's one `stat` behind, and a `stat`-per-recall is negligible at human
 * conversation pace. We deliberately DON'T track incremental adds/removes: it
 * would be a second source of truth that could drift from the file, for an
 * optimization the watermark already makes unnecessary (rebuild only fires when a
 * file actually changed, and the butler's store is kept bounded by the budget
 * reviewer).
 *
 * # Why read the jsonl directly instead of `handle.list`
 *
 * `MemoryHandle.list` caps at 500 and `recall` at 200 — neither can return "the
 * whole store", which is exactly the coverage the index exists to provide. So the
 * factory reads the jsonl files straight (reusing `service-memory-file`'s path
 * helpers — the one place that knows the layout and asserts owner-id safety). I/O
 * is injected as {@link RecallIndexIo} so the index logic is unit-testable with a
 * fake, and the real-filesystem wiring lives in {@link openButlerRecallIndex}.
 */

import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '@gotong/core'
import {
  InvertedIndex,
  buildInvertedIndex,
  fusedRetriever,
  invertedIndexRetriever,
  type Embedder,
  type InvertedIndexSnapshot,
  type MemoryRetriever,
  type RetrieverOptions,
} from '@gotong/personal-memory'
import { kindFile, ownerDir } from '@gotong/service-memory-file'
import type { MemoryEntry, MemoryKind, Owner } from '@gotong/services-sdk'

import { BUTLER_MEMORY_KINDS } from './personal-butler-memory.js'

/**
 * Enable multi-signal fusion recall (MU-M2). The PRESENCE of this config turns
 * fusion ON for this index's retriever; OMIT it and the retriever is the
 * keyword-only `invertedIndexRetriever` — byte-for-byte today's behavior (so a
 * direct caller / the existing tests are unaffected).
 *
 * `embed` is the SEMANTIC arm's text→vector function. Default (when the object is
 * present but `embed` is omitted) is the dependency-free local term-frequency
 * embedder — a focus-aware lexical signal that reranks the keyword arm's ties, no
 * network / key / data movement. Inject a real embedding provider here (MU-M4)
 * and the SAME retriever gains true synonym bridging.
 */
export interface ButlerRecallFusion {
  embed?: Embedder
}

/** A persisted index = the leaf snapshot plus the watermark it was built at. */
export interface PersistedRecallIndex {
  readonly snapshot: InvertedIndexSnapshot
  /** The file fingerprint this snapshot reflects — discard the snapshot if it drifts. */
  readonly watermark: string
}

/**
 * Injected I/O for {@link FileBackedInvertedIndex} — everything that touches the
 * filesystem, so the freshness logic can be unit-tested with an in-memory fake.
 */
export interface RecallIndexIo {
  /** Read EVERY entry across the butler's kinds (whole store, no `list` 500 cap). */
  loadAll(): Promise<MemoryEntry[]>
  /** Cheap freshness fingerprint (e.g. `size:mtime` per kind file). Drift ⇒ rebuild. */
  watermark(): Promise<string>
  /** Warm-start: a previously persisted snapshot+watermark, or null if none/corrupt. */
  loadPersisted?(): Promise<PersistedRecallIndex | null>
  /** Persist snapshot+watermark next to the jsonl (best-effort; a throw is swallowed). */
  persist?(data: PersistedRecallIndex): Promise<void>
}

/**
 * Keeps an {@link InvertedIndex} fresh against the jsonl behind a {@link RecallIndexIo}.
 *
 * `ensureFresh` is the heart: it warm-starts from a persisted snapshot once, then
 * on every call compares the live watermark to the one the current index was built
 * at — equal ⇒ reuse, drift ⇒ rebuild from `loadAll` and re-persist. `retriever`
 * wraps {@link invertedIndexRetriever} so freshness is guaranteed before any rank.
 */
export class FileBackedInvertedIndex {
  private index = new InvertedIndex()
  /** '' = never built (or just cleared) — forces a build on the next ensureFresh. */
  private builtAt = ''
  /** Warm-start from disk is attempted exactly once, lazily. */
  private warmed = false
  private refreshing: Promise<void> | null = null

  constructor(
    private readonly io: RecallIndexIo,
    private readonly logger?: Logger,
    /** Present ⇒ recall uses MU-M2 fusion; absent ⇒ keyword-only (byte-unchanged). */
    private readonly fusion?: ButlerRecallFusion,
  ) {}

  /** How many entries the index currently holds (post-`ensureFresh`). */
  get size(): number {
    return this.index.size
  }

  /**
   * Rebuild the index if (and only if) the jsonl changed since it was last built.
   * Concurrent calls share one in-flight rebuild (a recall storm rebuilds once).
   */
  async ensureFresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(): Promise<void> {
    if (!this.warmed) {
      this.warmed = true
      await this.tryWarmStart()
    }
    const wm = await this.io.watermark()
    if (this.builtAt !== '' && wm === this.builtAt) return // fresh — nothing changed
    const all = await this.io.loadAll()
    this.index = buildInvertedIndex(all)
    this.builtAt = wm
    await this.tryPersist(wm)
  }

  /**
   * A `MemoryRetriever` that always ranks a fresh index. The wrapper runs
   * `ensureFresh` before delegating, so the retriever a caller holds never goes
   * stale even though the index rebuilds underneath it.
   */
  retriever(opts?: RetrieverOptions): MemoryRetriever {
    const fusion = this.fusion
    return {
      retrieve: async (query) => {
        await this.ensureFresh()
        // Fusion when configured (MU-M2), else the keyword-only ranking. Both read
        // the freshly-rebuilt `this.index`, so the caller's retriever never goes stale.
        const backend = fusion
          ? fusedRetriever(this.index, { ...opts, embed: fusion.embed })
          : invertedIndexRetriever(this.index, opts)
        return backend.retrieve(query)
      },
    }
  }

  /**
   * M-GRAPH — resolve entries by id for one-hop recall link expansion. Ensures the
   * index is fresh, then returns the full entries the {@link InvertedIndex} already
   * holds by id — whole-store coverage with no extra jsonl read and no `list` 500
   * cap. Unknown ids are skipped. This is the {@link MemoryLinkLookup} the butler
   * wires when graph mode is on; with it off, recall never calls this (byte-unchanged).
   */
  async lookupByIds(ids: readonly string[]): Promise<MemoryEntry[]> {
    await this.ensureFresh()
    const out: MemoryEntry[] = []
    for (const id of ids) {
      const e = this.index.get(id)
      if (e) out.push(e)
    }
    return out
  }

  /**
   * Drop the in-memory index (for the `/me` forget-all path). The persisted cache
   * is left for the next `ensureFresh` to refresh from the now-empty jsonl — at
   * which point the watermark has drifted, so it rebuilds empty and re-persists.
   * `warmed` stays true so a stale snapshot is never reloaded after an explicit clear.
   */
  clear(): void {
    this.index = new InvertedIndex()
    this.builtAt = ''
    this.warmed = true
  }

  private async tryWarmStart(): Promise<void> {
    if (!this.io.loadPersisted) return
    try {
      const persisted = await this.io.loadPersisted()
      if (persisted) {
        this.index = InvertedIndex.load(persisted.snapshot)
        this.builtAt = persisted.watermark
      }
    } catch (err) {
      // A corrupt cache is never fatal — fall through to a cold rebuild.
      this.logger?.warn('butler recall index: warm-start failed, will rebuild', {
        err: errMsg(err),
      })
    }
  }

  private async tryPersist(watermark: string): Promise<void> {
    if (!this.io.persist) return
    try {
      await this.io.persist({ snapshot: this.index.serialize(), watermark })
    } catch (err) {
      // Persistence is an optimization; a failure just means a cold rebuild next boot.
      this.logger?.warn('butler recall index: persist failed', { err: errMsg(err) })
    }
  }
}

export interface OpenButlerRecallIndexOptions {
  /** Memory root dir (same as {@link openButlerMemory}). */
  rootDir: string
  /** The member whose butler memory this indexes — the namespace boundary. */
  userId: string
  /** Which kinds to index. Defaults to {@link BUTLER_MEMORY_KINDS} (episodic + semantic). */
  kinds?: readonly MemoryKind[]
  logger?: Logger
  /** Provide to enable MU-M2 fusion recall (omit = keyword-only, byte-unchanged). */
  fusion?: ButlerRecallFusion
}

/** Filename of the persisted index cache, written inside the user's memory dir. */
const RECALL_INDEX_FILE = 'recall-index.json'

/**
 * Open a recall index scoped to one user, wired to the real filesystem.
 *
 * Reads the same per-user jsonl tree {@link openButlerMemory} writes (via the
 * shared path helpers, so layout + owner-id safety stay one source of truth),
 * caches the derived index at `<userDir>/recall-index.json`, and rebuilds on
 * watermark drift. Swap its `retriever()` in for `lexicalRetriever` as the
 * butler's default `recall` backend.
 */
export function openButlerRecallIndex(
  opts: OpenButlerRecallIndexOptions,
): FileBackedInvertedIndex {
  if (typeof opts.userId !== 'string' || opts.userId.length === 0) {
    throw new Error('openButlerRecallIndex: a non-empty userId is required (per-user namespace)')
  }
  const owner: Owner = { kind: 'user', id: opts.userId }
  const kinds = opts.kinds ?? BUTLER_MEMORY_KINDS
  const files = kinds.map((k) => kindFile(opts.rootDir, owner, k))
  const indexPath = join(ownerDir(opts.rootDir, owner), RECALL_INDEX_FILE)

  const io: RecallIndexIo = {
    async loadAll() {
      const out: MemoryEntry[] = []
      for (const path of files) out.push(...await readJsonlEntries(path))
      return out
    },
    async watermark() {
      const parts: string[] = []
      for (const path of files) {
        try {
          const s = await stat(path)
          parts.push(`${path}:${s.size}:${s.mtimeMs}`)
        } catch {
          parts.push(`${path}:absent`) // missing file is a valid state, fingerprint it
        }
      }
      return parts.join('|')
    },
    async loadPersisted() {
      try {
        const raw = await readFile(indexPath, 'utf8')
        const parsed = JSON.parse(raw) as PersistedRecallIndex
        if (parsed && typeof parsed.watermark === 'string' && parsed.snapshot) return parsed
        return null
      } catch {
        return null // absent or corrupt — cold rebuild
      }
    },
    async persist(data) {
      const tmp = `${indexPath}.tmp`
      await writeFile(tmp, JSON.stringify(data), 'utf8')
      await rename(tmp, indexPath) // atomic swap so a reader never sees a half file
    },
  }

  return new FileBackedInvertedIndex(io, opts.logger, opts.fusion)
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Read one jsonl file into entries, tolerating a half-written tail / corrupt lines. */
async function readJsonlEntries(path: string): Promise<MemoryEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return [] // absent file = no entries of this kind yet
  }
  const out: MemoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const e = JSON.parse(line) as MemoryEntry
      if (typeof e.id === 'string' && typeof e.text === 'string') out.push(e)
    } catch {
      // skip a corrupt / half-written line (same tolerance as the file backend)
    }
  }
  return out
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
