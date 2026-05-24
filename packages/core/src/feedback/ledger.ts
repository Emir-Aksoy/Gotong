/**
 * FeedbackLedger — append-only event-sourced store of outbound feedback.
 *
 * Two storage backends share one ledger API:
 *
 *   - `FileFeedbackStorage`   — newline-delimited JSON on disk
 *   - `MemoryFeedbackStorage` — in-memory string[], lost on restart
 *
 * The ledger:
 *
 *   1. Appends each event as one JSON line ({kind: 'entry'|'delivered'|...})
 *   2. Materialises current state by replaying the stream from line 0
 *      and applying each status bump to the matching entry id
 *
 * Replay is O(N) lines and runs lazily on each query; cached only
 * inside the function call. M5+ may add a sqlite index — until
 * there's evidence the linear scan matters, this stays simple.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  FeedbackEntry,
  FeedbackEntryDraft,
  FeedbackStatus,
  LedgerLine,
} from './types.js'
import { statusOf } from './types.js'

// ─── storage backends ────────────────────────────────────────────────────

export interface FeedbackStorage {
  append(line: LedgerLine): void
  readAll(): LedgerLine[]
}

export class FileFeedbackStorage implements FeedbackStorage {
  /** Path to the jsonl file. */
  readonly path: string

  constructor(opts: { dir: string; file?: string }) {
    if (!existsSync(opts.dir)) mkdirSync(opts.dir, { recursive: true })
    this.path = join(opts.dir, opts.file ?? 'outbound.jsonl')
    if (!existsSync(this.path)) writeFileSync(this.path, '')
  }

  append(line: LedgerLine): void {
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  readAll(): LedgerLine[] {
    const raw = readFileSync(this.path, 'utf8')
    const out: LedgerLine[] = []
    for (const text of raw.split('\n')) {
      if (!text) continue
      try {
        out.push(JSON.parse(text) as LedgerLine)
      } catch {
        /* skip corrupt line; jsonl tolerance */
      }
    }
    return out
  }
}

export class MemoryFeedbackStorage implements FeedbackStorage {
  private readonly lines: LedgerLine[] = []
  append(line: LedgerLine): void {
    this.lines.push(line)
  }
  readAll(): LedgerLine[] {
    return [...this.lines]
  }
}

// ─── ledger ──────────────────────────────────────────────────────────────

export interface FeedbackQuery {
  toHub?: string
  toParticipant?: string
  taskRunId?: string
  status?: FeedbackStatus
  /** When set, only entries from this evaluator hub. */
  evaluatorHub?: string
}

/**
 * Optional callbacks fired on ledger mutations. M5b uses these to
 * keep the per-peer reputation in lockstep with feedback writes
 * (no separate sync job needed).
 */
export interface FeedbackHooks {
  onAppend?(entry: FeedbackEntry): void
  /** Called AFTER the rejection line is appended; receives the now-rejected entry. */
  onRejected?(entry: FeedbackEntry): void
}

export class FeedbackLedger {
  constructor(
    private readonly storage: FeedbackStorage,
    private hooks: FeedbackHooks = {},
  ) {}

  /**
   * Replace the hooks. Used by `Hub` to wire reputation in after the
   * ledger has been constructed (avoids circular ctor dependencies).
   */
  setHooks(hooks: FeedbackHooks): void {
    this.hooks = hooks
  }

  /**
   * Append a new feedback entry. `id` and `createdAt` are filled by
   * the ledger; lifecycle fields (`deliveredAt` etc) start unset.
   */
  appendEntry(draft: FeedbackEntryDraft, opts: { now?: number; id?: string } = {}): FeedbackEntry {
    const entry: FeedbackEntry = {
      ...draft,
      id: opts.id ?? randomUUID(),
      createdAt: opts.now ?? Date.now(),
    }
    this.storage.append({ kind: 'entry', entry })
    try {
      this.hooks.onAppend?.(entry)
    } catch {
      /* hooks must not break the write */
    }
    return entry
  }

  markDelivered(entryId: string, at: number = Date.now()): void {
    this.storage.append({ kind: 'delivered', entryId, at })
  }

  markRead(entryId: string, at: number = Date.now()): void {
    this.storage.append({ kind: 'read', entryId, at })
  }

  markRejected(entryId: string, reason?: string, at: number = Date.now()): void {
    this.storage.append({ kind: 'rejected', entryId, at, reason })
    try {
      const entry = this.get(entryId)
      if (entry) this.hooks.onRejected?.(entry)
    } catch {
      /* hooks must not break the write */
    }
  }

  /**
   * Read entries (with status applied) matching the filter. Replays
   * the full stream each call — fine at MVP volumes.
   */
  query(filter: FeedbackQuery = {}): FeedbackEntry[] {
    const entries = this.materialise()
    let out = [...entries.values()]
    if (filter.toHub !== undefined) {
      out = out.filter((e) => e.toHub === filter.toHub)
    }
    if (filter.toParticipant !== undefined) {
      out = out.filter((e) => e.toParticipant === filter.toParticipant)
    }
    if (filter.taskRunId !== undefined) {
      out = out.filter((e) => e.taskRunId === filter.taskRunId)
    }
    if (filter.evaluatorHub !== undefined) {
      out = out.filter((e) => e.evaluatorHub === filter.evaluatorHub)
    }
    if (filter.status !== undefined) {
      out = out.filter((e) => statusOf(e) === filter.status)
    }
    return out
  }

  /** Get one entry by id, or undefined. */
  get(entryId: string): FeedbackEntry | undefined {
    const entries = this.materialise()
    return entries.get(entryId)
  }

  /** Count entries (post-filter), without materialising the full array twice. */
  count(filter: FeedbackQuery = {}): number {
    return this.query(filter).length
  }

  /**
   * Lower-level: emit a raw event stream. Used by the reputation
   * derivation (M5b) which needs to know the order in which entries
   * arrived AND the order in which status bumps came, so EWMA can be
   * computed correctly even when a rejection arrives late.
   */
  rawLines(): LedgerLine[] {
    return this.storage.readAll()
  }

  // ─── private ──────────────────────────────────────────────────────────

  private materialise(): Map<string, FeedbackEntry> {
    const out = new Map<string, FeedbackEntry>()
    for (const line of this.storage.readAll()) {
      switch (line.kind) {
        case 'entry':
          // Defensive copy so later status mutation doesn't escape the map.
          out.set(line.entry.id, { ...line.entry })
          break
        case 'delivered': {
          const e = out.get(line.entryId)
          if (e && e.deliveredAt === undefined) {
            e.deliveredAt = line.at
          }
          break
        }
        case 'read': {
          const e = out.get(line.entryId)
          if (e && e.readAt === undefined) {
            e.readAt = line.at
          }
          break
        }
        case 'rejected': {
          const e = out.get(line.entryId)
          if (e && e.rejectedAt === undefined) {
            e.rejectedAt = line.at
            e.rejectionReason = line.reason
          }
          break
        }
      }
    }
    return out
  }
}
