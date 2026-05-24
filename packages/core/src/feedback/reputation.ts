/**
 * Peer reputation — M5b of the hub-mesh implementation.
 *
 * Reference: `docs/zh/HUB-MESH.md` §3.5.
 *
 * Each hub maintains a LOCAL view of how much it trusts each peer it
 * has connected to. The score is derived from the hub's OWN outbound
 * feedback (its own evaluations of the peer's work) — no global
 * reputation, no consensus, no broadcasting.
 *
 * Formula: EWMA on rating normalized to [-1, +1]:
 *
 *     score_new = α · score_old + (1 - α) · rating_normalized
 *     α         = 0.7    (older history weighted higher than any single new datapoint)
 *
 *     rating_normalized = (rating - 3) / 2   (1→-1, 3→0, 5→+1)
 *
 * Rejected entries (Q4) do NOT contribute. A late-arriving rejection
 * triggers a full re-derive for that peer (cheap — small number of
 * entries per peer in practice).
 *
 * Persisted as `<space>/feedback/reputation/<peerId>.json`. The file
 * is a cache; truth lives in `outbound.jsonl`. `rebuild()` regenerates
 * the cache from the ledger.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { FeedbackEntry } from './types.js'

export interface PeerReputation {
  peerHubId: string
  /** EWMA score in [-1, +1]. New peers start at 0 (neutral). */
  score: number
  /** Number of entries that contributed to the score (rejected excluded). */
  sampleCount: number
  lastUpdatedAt: number
}

export interface ReputationStoreOptions {
  /**
   * Directory to persist `<peerId>.json` files. When omitted, scores
   * live only in memory and are lost on hub disposal.
   */
  dir?: string
  /**
   * EWMA decay coefficient. Older score weighted by `alpha`, new
   * rating by `1 - alpha`. Default 0.7.
   */
  alpha?: number
}

export class ReputationStore {
  private readonly memo = new Map<string, PeerReputation>()
  private readonly dir?: string
  private readonly alpha: number

  constructor(opts: ReputationStoreOptions = {}) {
    this.dir = opts.dir
    this.alpha = opts.alpha ?? 0.7
    if (this.dir) this.loadFromDisk()
  }

  /**
   * Read the current EWMA score for a peer, or 0 if unknown (new peers
   * are not penalised — they tie with established peers that have
   * neutral scores).
   */
  scoreOf(peerHubId: string): number {
    return this.memo.get(peerHubId)?.score ?? 0
  }

  get(peerHubId: string): PeerReputation | undefined {
    const r = this.memo.get(peerHubId)
    return r ? { ...r } : undefined
  }

  /** Snapshot of all known peer reputations. */
  all(): PeerReputation[] {
    return [...this.memo.values()].map((r) => ({ ...r }))
  }

  /**
   * Incremental: a new feedback entry was just appended. Apply EWMA to
   * the peer's running score and flush.
   */
  recordEntry(peerHubId: string, rating: number): void {
    this.updateScore(peerHubId, normalizeRating(rating))
    this.flushOne(peerHubId)
  }

  /**
   * A previously-counted entry was just rejected. Re-derive that
   * peer's score from scratch using all non-rejected entries.
   */
  recordRejection(peerHubId: string, allEntries: readonly FeedbackEntry[]): void {
    this.rebuildPeer(peerHubId, allEntries)
    this.flushOne(peerHubId)
  }

  /**
   * Full re-derive across all peers from a fresh entry list. Use at
   * hub start-up if the on-disk cache may have drifted.
   */
  rebuild(allEntries: readonly FeedbackEntry[]): void {
    const byPeer = new Map<string, FeedbackEntry[]>()
    for (const e of allEntries) {
      const list = byPeer.get(e.toHub)
      if (list) list.push(e)
      else byPeer.set(e.toHub, [e])
    }
    this.memo.clear()
    for (const [peerHubId, entries] of byPeer) {
      this.rebuildPeer(peerHubId, entries)
    }
    if (this.dir) this.flushAll()
  }

  // ─── private ──────────────────────────────────────────────────────────

  private updateScore(peerHubId: string, normalizedRating: number): void {
    const old = this.memo.get(peerHubId)
    const oldScore = old?.score ?? 0
    const newScore = this.alpha * oldScore + (1 - this.alpha) * normalizedRating
    this.memo.set(peerHubId, {
      peerHubId,
      score: newScore,
      sampleCount: (old?.sampleCount ?? 0) + 1,
      lastUpdatedAt: Date.now(),
    })
  }

  private rebuildPeer(
    peerHubId: string,
    allEntriesForPeer: readonly FeedbackEntry[],
  ): void {
    const ordered = [...allEntriesForPeer]
      .filter((e) => e.toHub === peerHubId && !e.rejectedAt)
      .sort((a, b) => a.createdAt - b.createdAt)

    let score = 0
    for (const e of ordered) {
      score = this.alpha * score + (1 - this.alpha) * normalizeRating(e.rating)
    }
    this.memo.set(peerHubId, {
      peerHubId,
      score,
      sampleCount: ordered.length,
      lastUpdatedAt: Date.now(),
    })
  }

  private loadFromDisk(): void {
    if (!this.dir || !existsSync(this.dir)) return
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = readFileSync(join(this.dir, file), 'utf8')
        const obj = JSON.parse(raw) as PeerReputation
        if (
          obj &&
          typeof obj.peerHubId === 'string' &&
          typeof obj.score === 'number' &&
          typeof obj.sampleCount === 'number'
        ) {
          this.memo.set(obj.peerHubId, obj)
        }
      } catch {
        /* skip corrupt file */
      }
    }
  }

  private flushOne(peerHubId: string): void {
    if (!this.dir) return
    const r = this.memo.get(peerHubId)
    if (!r) return
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    writeFileSync(
      join(this.dir, `${safeFileSegment(peerHubId)}.json`),
      JSON.stringify(r, null, 2),
      'utf8',
    )
  }

  private flushAll(): void {
    for (const id of this.memo.keys()) this.flushOne(id)
  }
}

/** Map raw rating (0–5) to EWMA input (-1 to +1). */
function normalizeRating(rating: number): number {
  const clamped = Math.max(0, Math.min(5, rating))
  return (clamped - 3) / 2
}

/** Make a peer id safe to use as a filename segment. */
function safeFileSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}
