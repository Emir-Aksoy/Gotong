import { createLogger } from './logger.js'
import type { Storage } from './storage/index.js'
import { DEFAULT_TENANT } from './tenant.js'
import type { TranscriptEntry } from './types.js'

const log = createLogger('transcript')

/**
 * Chunk types that earn a place on disk. Everything else is display-only
 * and stays ephemeral (perf audit A③).
 *
 * A③'s argument for making stream chunks ephemeral was "the final
 * task_result already carries the full text, so persisting every token is
 * redundant". That is true of `text` — and false of `tool_use`: a
 * task_result carries `toolRounds`, a NUMBER, and nothing else. The tool's
 * name, its arguments, the fact it ran at all — none of it survives
 * anywhere. "What did this agent actually do" became a question the disk
 * cannot answer, which is a strictly worse failure than the redundancy A③
 * set out to remove.
 *
 * Keeping tool_use costs almost nothing: measured over two months of
 * production traffic, 20 of 6190 chunks were tool_use — 0.32% of rows and
 * 0.61% of bytes. A③ keeps the 99.4% it was actually after.
 *
 * The list is a WHITELIST so a provider inventing a new high-volume chunk
 * type cannot silently start filling the disk. The cost of a whitelist is
 * the mirror of A③'s own bug — a future action-bearing chunk type would
 * be silently dropped — so a gate in @gotong/host pins this list against
 * the `LlmStreamChunk` union and turns "someone added a chunk type" into a
 * red test rather than a silent loss.
 */
const DURABLE_CHUNK_TYPES: readonly string[] = ['tool_use']

/**
 * Does this stream chunk belong on disk? Shape-tolerant by construction:
 * `chunk` is typed `unknown` on the transcript entry (core does not depend
 * on @gotong/llm), so anything that is not an object with a known-durable
 * `type` is treated as display-only.
 */
export function chunkDeservesDisk(chunk: unknown): boolean {
  if (typeof chunk !== 'object' || chunk === null) return false
  const t = (chunk as { type?: unknown }).type
  return typeof t === 'string' && DURABLE_CHUNK_TYPES.includes(t)
}

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
    let maxSeq = loaded.length > 0 ? loaded[loaded.length - 1]!.seq : 0
    // A storage may persist a high-water seq that outlives the loadable entries
    // — e.g. after archiving moved older segments out of the boot path (Route B
    // P0-M2). Take the max so seq never regresses and reissues a number an
    // archived entry already owns.
    const hwm = this.storage.highWaterSeq?.() ?? 0
    if (hwm > maxSeq) maxSeq = hwm
    this.seq = maxSeq
  }

  append(entry: Omit<TranscriptEntry, 'seq'>): TranscriptEntry {
    this.seq += 1
    const full = { ...entry, seq: this.seq } as TranscriptEntry
    this.entries.push(full)
    this.storage.appendTranscriptEntry(full).catch((err) => {
      log.error('persist failed', { err })
    })
    this.fanout(full)
    return full
  }

  /**
   * Fan an entry out to live observers WITHOUT recording it — no in-memory
   * push, no storage write (perf audit A③). For high-volume transient kinds
   * (`llm_stream_chunk`) whose whole value is real-time display: the final
   * task_result / message entry already carries the full text, so persisting
   * every token chunk only grows RAM and disk with redundancy.
   *
   * The entry still consumes a seq from the shared counter so an observer's
   * stream stays strictly ordered against persisted entries. The persisted
   * log tolerates the resulting gaps by construction — `load()` takes the
   * max, `since()` compares, nothing assumes contiguity. After a crash the
   * skipped numbers may be reissued; that is safe because ephemeral seqs are
   * only ever handed to live observers (SSE wire, stdout line, chunk sinks),
   * never to anything durable.
   */
  emitEphemeral(entry: Omit<TranscriptEntry, 'seq'>): TranscriptEntry {
    this.seq += 1
    const full = { ...entry, seq: this.seq } as TranscriptEntry
    this.fanout(full)
    return full
  }

  /**
   * The single entry point for `llm_stream_chunk`: routes each chunk to
   * `append` or `emitEphemeral` per `chunkDeservesDisk`. Every emitter goes
   * through here so "which chunks earn a place on disk" has exactly one
   * enforcement point — a second copy of that policy is how the two halves
   * drift apart.
   */
  emitChunk(entry: Omit<TranscriptEntry, 'seq'>): TranscriptEntry {
    const chunk = (entry as { data?: { chunk?: unknown } }).data?.chunk
    return chunkDeservesDisk(chunk) ? this.append(entry) : this.emitEphemeral(entry)
  }

  private fanout(full: TranscriptEntry): void {
    for (const obs of this.observers) {
      try {
        obs(full)
      } catch (err) {
        log.error('observer threw', { err })
      }
    }
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
