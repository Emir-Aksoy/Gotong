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
 * fingerprint binds owner, kinds, generation and each kind file's stats. Any write (remember, forget,
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
 * # Why use a strict snapshot instead of `handle.list`
 *
 * `MemoryHandle.list` caps at 500 and `recall` at 200 — neither can return "the
 * whole store", which is exactly the coverage the index exists to provide. So the
 * factory uses `MemoryFileHandle.snapshot()` for complete, guarded reads. I/O
 * is injected as {@link RecallIndexIo} so the index logic is unit-testable with a
 * fake, and the real-filesystem wiring lives in {@link openButlerRecallIndex}.
 */

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
import { MemoryFileMutationError, MemoryFileSnapshotError } from '@gotong/service-memory-file'
import type { MemoryEntry, MemoryKind } from '@gotong/services-sdk'

import { createRecallIndexIo } from './butler-recall-index-io.js'

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
  /** Authoritative owner/generation barrier, including for warm in-memory hits. */
  assertUsable?(): Promise<void>
  /** Read EVERY entry across the butler's kinds (whole store, no `list` 500 cap). */
  loadAll(): Promise<MemoryEntry[]>
  /** Cheap freshness fingerprint (e.g. `size:mtime` per kind file). Drift ⇒ rebuild. */
  watermark(): Promise<string>
  /** Warm-start: a previously persisted snapshot+watermark, or null if none/corrupt. */
  loadPersisted?(): Promise<PersistedRecallIndex | null>
  /** Best-effort cache write; authoritative guard failures must still propagate. */
  persist?(data: PersistedRecallIndex): Promise<void>
  /** Strict purge, required for retirement when either persistence method exists. */
  removePersisted?(): Promise<void>
}

export type RecallIndexErrorCode = 'RECALL_INDEX_RETIRED' | 'RECALL_INDEX_CLEANUP_FAILED'
  | 'RECALL_INDEX_RETIRE_UNSUPPORTED' | 'RECALL_INDEX_INVALID_SCOPE'

const messages: Record<RecallIndexErrorCode, string> = {
  RECALL_INDEX_RETIRED: 'Recall index is retired; open a fresh index.',
  RECALL_INDEX_CLEANUP_FAILED: 'Recall index cleanup failed; retirement may be retried.',
  RECALL_INDEX_RETIRE_UNSUPPORTED: 'Recall index persistence does not support strict cleanup.',
  RECALL_INDEX_INVALID_SCOPE: 'Recall index requires a valid scope and a non-empty userId.',
}

/** Never retains source contents, paths, or an underlying cause. */
export class RecallIndexError extends Error {
  constructor(readonly code: RecallIndexErrorCode) { super(messages[code]) }
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
  private retired = false
  private retirement: Promise<void> | null = null
  private epoch = 0
  private publishedEpoch = -1

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

  async assertUsable(): Promise<void> {
    this.assertNotRetired()
    try { await this.io.assertUsable?.() } finally { this.assertNotRetired() }
  }

  private assertNotRetired(): void {
    if (this.retired) throw new RecallIndexError('RECALL_INDEX_RETIRED')
  }

  /**
   * INSTANCE-only barrier: the coordinator must retire all instances and stop
   * new factories before correcting files. Independent instances share no lock.
   * The old object never reopens, even when cleanup fails and is retried.
   */
  retire(): Promise<void> {
    if (!this.retired) {
      this.retired = true
      this.clear()
    }
    if (this.retirement) return this.retirement
    const active = this.refreshing
    this.retirement = Promise.resolve().then(async () => {
      await active?.catch(() => undefined)
      if (!this.io.removePersisted && (this.io.persist || this.io.loadPersisted)) {
        throw new RecallIndexError('RECALL_INDEX_RETIRE_UNSUPPORTED')
      }
      try { await this.io.removePersisted?.() } catch {
        throw new RecallIndexError('RECALL_INDEX_CLEANUP_FAILED')
      }
    }).catch((error: unknown) => {
      this.retirement = null
      throw error
    })
    return this.retirement
  }

  /**
   * Rebuild the index if (and only if) the jsonl changed since it was last built.
   * Concurrent calls share one in-flight rebuild (a recall storm rebuilds once).
   */
  async ensureFresh(): Promise<void> {
    const requestedEpoch = this.epoch
    for (;;) {
      this.assertNotRetired()
      if (!this.refreshing) {
        this.refreshing = this.doRefresh(this.epoch).finally(() => {
          this.refreshing = null
        })
      }
      await this.refreshing
      await this.assertUsable()
      this.assertNotRetired()
      // A pre-clear refresh can finish without publishing. New callers must
      // refresh their epoch; callers interrupted by another clear may give up.
      if (requestedEpoch !== this.epoch || this.publishedEpoch === this.epoch) return
    }
  }

  private async doRefresh(epoch: number): Promise<void> {
    await this.assertUsable()
    if (epoch !== this.epoch) return
    let candidate = this.index
    let builtAt = this.builtAt
    if (!this.warmed) {
      this.warmed = true
      const persisted = await this.tryWarmStart()
      await this.assertUsable()
      if (epoch !== this.epoch) return
      if (persisted) {
        candidate = persisted.index
        builtAt = persisted.watermark
      }
    }
    const wm = await this.io.watermark()
    await this.assertUsable()
    if (epoch !== this.epoch) return
    if (builtAt === '' || wm !== builtAt) {
      const all = await this.io.loadAll()
      await this.assertUsable()
      if (epoch !== this.epoch) return
      candidate = buildInvertedIndex(all)
      await this.tryPersist({ snapshot: candidate.serialize(), watermark: wm })
      await this.assertUsable()
      if (epoch !== this.epoch) return
    }
    // Publish only after all async work has crossed the guard and local epoch.
    this.index = candidate
    this.builtAt = wm
    this.publishedEpoch = epoch
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
        await this.assertUsable()
        const epoch = this.epoch
        // Fusion when configured (MU-M2), else the keyword-only ranking. Both read
        // the freshly-rebuilt `this.index`, so the caller's retriever never goes stale.
        const backend = fusion
          ? fusedRetriever(this.index, { ...opts, embed: fusion.embed })
          : invertedIndexRetriever(this.index, opts)
        const hits = await backend.retrieve(query)
        await this.assertUsable()
        return epoch === this.epoch ? hits : []
      },
    }
  }

  /**
   * M2c — every entry, for building the cross-store 联想网.
   *
   * Rides THIS index's watermark freshness rather than opening a second read
   * path: the net is a derived view of the same jsonl the index already tracks,
   * and two enumeration paths would eventually disagree about what exists. The
   * index is already holding these objects, so this is a copy of the array, not
   * a re-read of the file.
   */
  async allEntries(): Promise<MemoryEntry[]> {
    await this.ensureFresh()
    await this.assertUsable()
    return this.index.entries()
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
    await this.assertUsable()
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
    this.epoch++
    this.index = new InvertedIndex()
    this.builtAt = ''
    this.warmed = true
  }

  private async tryWarmStart(): Promise<{ index: InvertedIndex; watermark: string } | null> {
    if (!this.io.loadPersisted) return null
    try {
      const persisted = await this.io.loadPersisted()
      await this.assertUsable()
      if (persisted) {
        return { index: InvertedIndex.load(persisted.snapshot), watermark: persisted.watermark }
      }
    } catch (err) {
      if (isRecallIndexAccessError(err)) throw err
      await this.assertUsable()
      // A corrupt cache is never fatal — fall through to a cold rebuild.
      this.logger?.warn('butler recall index: warm-start failed, will rebuild', {
        cacheFailure: true,
      })
    }
    return null
  }

  private async tryPersist(data: PersistedRecallIndex): Promise<void> {
    if (!this.io.persist) return
    try {
      await this.io.persist(data)
      await this.assertUsable()
    } catch (err) {
      if (isRecallIndexAccessError(err)) throw err
      await this.assertUsable()
      // Persistence is an optimization; a failure just means a cold rebuild next boot.
      this.logger?.warn('butler recall index: persist failed', { cacheFailure: true })
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
    throw new RecallIndexError('RECALL_INDEX_INVALID_SCOPE')
  }
  return new FileBackedInvertedIndex(createRecallIndexIo(opts), opts.logger, opts.fusion)
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Shared with derived views: a later healthy check cannot undo this failure. */
export function isRecallIndexAccessError(error: unknown): boolean {
  return error instanceof MemoryFileMutationError || error instanceof MemoryFileSnapshotError
    || error instanceof RecallIndexError
}
